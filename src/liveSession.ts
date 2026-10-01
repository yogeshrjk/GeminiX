import WebSocket, { type RawData } from "ws";
import {
  createToolResponsePayload,
  LiveToolCalls,
  type LiveFunctionCall,
  type LiveFunctionResponse
} from "./liveProtocol.js";
import { createLiveSetupMessage } from "./liveConfig.js";
import type { Preferences } from "./types.js";

export type { LiveFunctionResponse } from "./liveProtocol.js";

const LIVE_API_ENDPOINT =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

// The Live API state machine only allows messages after the server has
// acknowledged the setup message. Anything sent earlier makes the server
// abort the connection with close code 1008 ("The operation was aborted.").
const MAX_PENDING_MESSAGES = 100;

export type LiveSessionEvent =
  | { readonly type: "connecting" }
  | { readonly type: "opened" }
  | { readonly type: "serverMessage"; readonly payload: unknown }
  | { readonly type: "debug"; readonly message: string }
  | { readonly type: "error"; readonly message: string }
  | {
    readonly type: "closed";
    readonly code: number;
    readonly reason: string;
    readonly intentional: boolean;
  };

export class LiveSession {
  private socket: WebSocket | undefined;
  private intentionalClose = false;
  private setupComplete = false;
  private goAwayReceived = false;
  private readonly pendingMessages: unknown[] = [];
  private readonly toolCalls = new LiveToolCalls();
  private setupTimer: ReturnType<typeof setTimeout> | undefined;

  public constructor(
    private readonly onEvent: (event: LiveSessionEvent) => void,
    private readonly options: { endpoint?: string; setupTimeoutMs?: number } = {}
  ) { }

  public get isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN && this.setupComplete && !this.goAwayReceived;
  }

  public isToolCallPending(id: string): boolean { return this.toolCalls.has(id); }

  public connect(apiKey: string, preferences: Preferences): void {
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.CONNECTING ||
        this.socket.readyState === WebSocket.OPEN)
    ) {
      return;
    }

    this.intentionalClose = false;
    this.setupComplete = false;
    this.goAwayReceived = false;
    this.pendingMessages.length = 0;
    this.toolCalls.reset();
    this.onEvent({ type: "connecting" });

    const endpoint = `${this.options.endpoint ?? LIVE_API_ENDPOINT}?key=${encodeURIComponent(apiKey)}`;
    const socket = new WebSocket(endpoint);
    this.socket = socket;
    this.setupTimer = setTimeout(() => {
      if (this.socket !== socket || this.setupComplete) return;
      this.onEvent({ type: "error", message: "Gemini did not finish connecting. Check your network, API key, and selected model, then retry." });
      socket.terminate();
    }, this.options.setupTimeoutMs ?? 20_000);

    socket.on("open", () => {
      if (this.socket !== socket) {
        return;
      }

      socket.send(JSON.stringify(createLiveSetupMessage(preferences)));
      this.onEvent({ type: "opened" });
    });

    socket.on("message", (data: RawData) => {
      if (this.socket !== socket) {
        return;
      }

      try {
        let jsonText: string;
        if (Array.isArray(data)) {
          jsonText = Buffer.concat(data).toString("utf8");
        } else if (data instanceof ArrayBuffer) {
          jsonText = Buffer.from(new Uint8Array(data)).toString("utf8");
        } else {
          jsonText = data.toString("utf8");
        }
        const payload = this.handleServerPayload(JSON.parse(jsonText) as unknown);
        this.onEvent({ type: "serverMessage", payload });
      } catch {
        this.onEvent({
          type: "error",
          message: "Gemini returned an unreadable WebSocket message."
        });
      }
    });

    socket.on("error", (error: Error) => {
      if (this.socket === socket) {
        this.onEvent({ type: "error", message: error.message });
      }
    });

    socket.on("close", (code: number, reason: Buffer) => {
      if (this.socket !== socket) {
        return;
      }

      this.socket = undefined;
      clearTimeout(this.setupTimer);
      this.toolCalls.reset();
      this.setupComplete = false;
      this.goAwayReceived = false;
      this.pendingMessages.length = 0;
      this.onEvent({
        type: "closed",
        code,
        reason: reason.toString(),
        intentional: this.intentionalClose
      });
    });
  }

  public sendAudio(base64Audio: string): boolean {
    return this.send({
      realtimeInput: {
        audio: {
          data: base64Audio,
          mimeType: "audio/pcm;rate=16000"
        }
      }
    });
  }

  public sendPcm16(frame: Int16Array): boolean {
    const audio = Buffer.from(
      frame.buffer,
      frame.byteOffset,
      frame.byteLength
    ).toString("base64");
    return this.sendAudio(audio);
  }

  /** Stream a JPEG screen frame to Gemini as realtime video input. */
  public sendVideo(base64Image: string): boolean {
    return this.send({
      realtimeInput: {
        video: {
          data: base64Image,
          mimeType: "image/jpeg"
        }
      }
    });
  }

  public sendText(text: string): boolean {
    return this.send({ realtimeInput: { text } });
  }

  public sendAudioStreamEnd(): boolean {
    return this.send({ realtimeInput: { audioStreamEnd: true } });
  }

  /** A completed client turn interrupts generation; empty realtimeInput does not. */
  public sendInterrupt(): boolean {
    this.toolCalls.cancel();
    this.pendingMessages.length = 0;
    return this.send({ clientContent: { turns: [], turnComplete: true } });
  }

  public sendUserTurn(text: string): boolean {
    return this.send({ realtimeInput: { text } });
  }

  public sendToolResponses(
    functionResponses: readonly LiveFunctionResponse[]
  ): boolean {
    const pending = this.toolCalls.complete(functionResponses);
    // Late responses to cancelled calls are deliberately ignored.
    return pending.length === 0 || this.send(createToolResponsePayload(pending));
  }

  public disconnect(): void {
    const socket = this.socket;
    this.intentionalClose = true;
    this.socket = undefined;
    this.pendingMessages.length = 0;
    this.setupComplete = false;
    clearTimeout(this.setupTimer);
    this.toolCalls.reset();

    if (
      socket &&
      (socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING)
    ) {
      socket.close(1000, "Client disconnected");
    }
  }

  public dispose(): void {
    this.disconnect();
  }

  private send(payload: unknown): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return false;
    }

    if (this.goAwayReceived) {
      // The server asked the client to stop sending before it closes the
      // connection. Sending more would make it terminate as ABORTED.
      return false;
    }

    if (!this.setupComplete) {
      if (this.isTransientRealtimeInput(payload)) {
        // Real-time mic audio captured before the session is ready is
        // transient. Drop only mic audio frames, not text turns.
        return true;
      }
      // Defer discrete messages (user turns, tool responses) until
      // the server acknowledges setup, then flush them in order.
      if (this.pendingMessages.length < MAX_PENDING_MESSAGES) {
        this.pendingMessages.push(payload);
        return true;
      }
      return false;
    }

    return this.sendNow(payload);
  }

  private sendNow(payload: unknown): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    try {
      this.socket.send(JSON.stringify(payload), (error) => {
        if (error) {
          this.onEvent({
            type: "error",
            message: `Gemini WebSocket send failed: ${error.message}`
          });
        }
      });
      return true;
    } catch (error) {
      this.onEvent({
        type: "error",
        message:
          error instanceof Error
            ? `Gemini WebSocket send failed: ${error.message}`
            : "Gemini WebSocket send failed."
      });
      return false;
    }
  }

  private handleServerPayload(payload: unknown): unknown {
    if (typeof payload !== "object" || payload === null) {
      return payload;
    }

    const message = payload as Readonly<Record<string, unknown>>;
    if (message.setupComplete !== undefined) {
      // The Live API requires clients to wait for setupComplete before
      // sending anything other than the initial setup message. Sending
      // earlier makes the server abort the connection with code 1008
      // ("The operation was aborted.").
      this.setupComplete = true;
      clearTimeout(this.setupTimer);
      this.flushPendingMessages();
      return payload;
    }

    if (message.goAway !== undefined) {
      this.handleGoAway();
    }
    const cancellation = message.toolCallCancellation as { ids?: readonly string[] } | undefined;
    if (cancellation?.ids) this.toolCalls.cancel(cancellation.ids);
    const content = message.serverContent as { interrupted?: boolean } | undefined;
    if (content?.interrupted) this.toolCalls.cancel();
    const calls = (message.toolCall as { functionCalls?: readonly LiveFunctionCall[] } | undefined)?.functionCalls;
    if (Array.isArray(calls)) {
      return { ...message, toolCall: { functionCalls: this.toolCalls.accept(calls) } };
    }
    return payload;
  }

  private handleGoAway(): void {
    // The server notifies the client before ending the connection. If the
    // client keeps sending instead of closing, the server terminates the
    // connection as ABORTED (WebSocket close code 1008, "The operation was
    // aborted."). Stop sending and close gracefully so the session ends
    // with a clean close instead of a policy violation.
    this.goAwayReceived = true;
    this.pendingMessages.length = 0;
    const socket = this.socket;
    if (
      socket &&
      (socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING)
    ) {
      socket.close(1000, "Gemini closed the session (GoAway)");
    }
  }

  private flushPendingMessages(): void {
    const pending = this.pendingMessages.splice(0);
    for (const payload of pending) {
      this.sendNow(payload);
    }
  }

  private isTransientRealtimeInput(payload: unknown): boolean {
    if (typeof payload !== "object" || payload === null) {
      return false;
    }
    const realtime = (payload as { realtimeInput?: { audio?: unknown } })
      .realtimeInput;
    return Boolean(realtime?.audio);
  }

}
