import WebSocket, { type RawData } from "ws";

const TRANSCRIBE_MODEL = "gemini-3.5-transcribe-live";
const LIVE_TRANSCRIBE_API_ENDPOINT =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent";

const MAX_PENDING_MESSAGES = 100;

export interface TranscribeSessionCallbacks {
  readonly onTranscriptChunk: (text: string) => void;
  readonly onTurnComplete?: () => void;
  readonly onInterrupted?: () => void;
  readonly onError?: (message: string) => void;
  readonly onStateChange?: (connected: boolean) => void;
}

export class TranscribeLiveSession {
  private socket: WebSocket | undefined;
  private setupComplete = false;
  private readonly pendingMessages: unknown[] = [];

  public constructor(
    private readonly callbacks: TranscribeSessionCallbacks
  ) {}

  public get isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN && this.setupComplete;
  }

  public connect(apiKey: string): void {
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.CONNECTING ||
        this.socket.readyState === WebSocket.OPEN)
    ) {
      return;
    }

    this.setupComplete = false;
    this.pendingMessages.length = 0;

    const endpoint = `${LIVE_TRANSCRIBE_API_ENDPOINT}?key=${encodeURIComponent(apiKey)}`;
    const socket = new WebSocket(endpoint);
    this.socket = socket;

    socket.on("open", () => {
      if (this.socket !== socket) {
        return;
      }

      socket.send(JSON.stringify(this.createSetupMessage()));
      this.callbacks.onStateChange?.(true);
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
        const payload: unknown = JSON.parse(jsonText);
        this.handleServerPayload(payload);
      } catch {
        // Ignore malformed server packets
      }
    });

    socket.on("error", (error: Error) => {
      if (this.socket === socket) {
        this.callbacks.onError?.(error.message);
      }
    });

    socket.on("close", () => {
      if (this.socket !== socket) {
        return;
      }

      this.socket = undefined;
      this.setupComplete = false;
      this.pendingMessages.length = 0;
      this.callbacks.onStateChange?.(false);
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

  public sendAudio(base64Audio: string): boolean {
    return this.send({
      realtimeInput: {
        mediaChunks: [
          {
            mimeType: "audio/pcm;rate=16000",
            data: base64Audio
          }
        ]
      }
    });
  }

  public disconnect(): void {
    const socket = this.socket;
    this.socket = undefined;
    this.pendingMessages.length = 0;

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

    if (!this.setupComplete) {
      if (this.pendingMessages.length < MAX_PENDING_MESSAGES) {
        this.pendingMessages.push(payload);
      }
      return true;
    }

    return this.sendNow(payload);
  }

  private sendNow(payload: unknown): boolean {
    try {
      this.socket?.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  private flushPendingMessages(): void {
    const pending = this.pendingMessages.splice(0);
    for (const payload of pending) {
      this.sendNow(payload);
    }
  }

  private handleServerPayload(payload: unknown): void {
    if (typeof payload !== "object" || payload === null) {
      return;
    }

    const message = payload as Readonly<Record<string, unknown>>;
    if (message.setupComplete !== undefined) {
      this.setupComplete = true;
      this.flushPendingMessages();
      return;
    }

    const serverContent = message.serverContent as
      | {
          readonly modelTurn?: {
            readonly parts?: readonly { readonly text?: string }[];
          };
          readonly turnComplete?: boolean;
          readonly interrupted?: boolean;
        }
      | undefined;

    if (serverContent) {
      if (serverContent.interrupted) {
        this.callbacks.onInterrupted?.();
      }

      if (serverContent.modelTurn?.parts) {
        for (const part of serverContent.modelTurn.parts) {
          if (typeof part.text === "string" && part.text.length > 0) {
            this.callbacks.onTranscriptChunk(part.text);
          }
        }
      }

      if (serverContent.turnComplete) {
        this.callbacks.onTurnComplete?.();
      }
    }
  }

  private createSetupMessage(): unknown {
    return {
      setup: {
        model: `models/${TRANSCRIBE_MODEL}`,
        generationConfig: {
          responseModalities: ["TEXT"]
        },
        systemInstruction: {
          parts: [
            {
              text: "You are a verbatim real-time speech-to-text transcriber. Output only the exact words spoken by the user verbatim. Do not alter, paraphrase, summarize, answer, translate, or complete the sentence."
            }
          ]
        }
      }
    };
  }
}
