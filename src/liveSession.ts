import WebSocket, { type RawData } from "ws";
import {
  createToolResponsePayload,
  type LiveFunctionResponse
} from "./liveProtocol.js";
import { buildSystemInstruction } from "./prompts.js";
import type { ImageContext, Preferences } from "./types.js";

export type { LiveFunctionResponse } from "./liveProtocol.js";

const MODEL = "gemini-3.1-flash-live-preview";
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

  public constructor(
    private readonly onEvent: (event: LiveSessionEvent) => void
  ) {}

  public get isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

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
    this.onEvent({ type: "connecting" });

    const endpoint = `${LIVE_API_ENDPOINT}?key=${encodeURIComponent(apiKey)}`;
    const socket = new WebSocket(endpoint);
    this.socket = socket;

    socket.on("open", () => {
      if (this.socket !== socket) {
        return;
      }

      socket.send(JSON.stringify(this.createSetupMessage(preferences)));
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
        const payload: unknown = JSON.parse(jsonText);
        this.handleServerPayload(payload);
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

  /** Interrupt the current model turn by sending an empty realtime input. */
  public sendInterrupt(): boolean {
    return this.send({ realtimeInput: {} });
  }

  public sendUserTurn(
    text: string,
    images: readonly ImageContext[] = []
  ): boolean {
    if (!images.length) {
      return this.send({ realtimeInput: { text } });
    }

    // Attached images are sent together with the text as a single
    // clientContent turn. Unlike realtimeInput, whose audio/video/text
    // streams are processed concurrently without ordering guarantees, the
    // parts of a clientContent turn are committed atomically. Gemini only
    // starts responding after the whole turn (image + text) has been
    // ingested, so it cannot answer the text before the image is analyzed.
    const parts: unknown[] = images.map((image) => ({
      inlineData: {
        data: image.data,
        mimeType: image.mimeType
      }
    }));
    parts.push({ text });
    return this.send({
      clientContent: {
        turns: [
          {
            role: "user",
            parts
          }
        ],
        turnComplete: true
      }
    });
  }

  public sendToolResponses(
    functionResponses: readonly LiveFunctionResponse[]
  ): boolean {
    return this.send(createToolResponsePayload(functionResponses));
  }

  public disconnect(): void {
    const socket = this.socket;
    this.intentionalClose = true;
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

    if (this.goAwayReceived) {
      // The server asked the client to stop sending before it closes the
      // connection. Sending more would make it terminate as ABORTED.
      return false;
    }

    if (!this.setupComplete) {
      if (this.isRealtimeInput(payload)) {
        // Real-time audio/text captured before the session is ready is
        // transient. Replaying it after setup would feed the model stale
        // input, so drop it instead of queueing it.
        return true;
      }
      // Defer discrete messages (clientContent turns, tool responses) until
      // the server acknowledges setup, then flush them in order.
      if (this.pendingMessages.length < MAX_PENDING_MESSAGES) {
        this.pendingMessages.push(payload);
      }
      return true;
    }

    return this.sendNow(payload);
  }

  private sendNow(payload: unknown): boolean {
    try {
      this.socket?.send(JSON.stringify(payload), (error) => {
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

  private handleServerPayload(payload: unknown): void {
    if (typeof payload !== "object" || payload === null) {
      return;
    }

    const message = payload as Readonly<Record<string, unknown>>;
    if (message.setupComplete !== undefined) {
      // The Live API requires clients to wait for setupComplete before
      // sending anything other than the initial setup message. Sending
      // earlier makes the server abort the connection with code 1008
      // ("The operation was aborted.").
      this.setupComplete = true;
      this.flushPendingMessages();
      return;
    }

    if (message.goAway !== undefined) {
      this.handleGoAway();
    }
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

  private isRealtimeInput(payload: unknown): boolean {
    return (
      typeof payload === "object" &&
      payload !== null &&
      "realtimeInput" in (payload as Readonly<Record<string, unknown>>)
    );
  }

  private createSetupMessage(preferences: Preferences): unknown {
    return {
      setup: {
        model: `models/${MODEL}`,
        generationConfig: {
          responseModalities: ["AUDIO"],
          temperature: 0.3,
          thinkingConfig: {
            thinkingLevel: "MEDIUM"
          },
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: preferences.voice
              }
            }
          }
        },
        systemInstruction: {
          parts: [{ text: buildSystemInstruction(preferences) }]
        },
        tools: [
          {
            functionDeclarations: [
              {
                name: "search_workspace",
                description:
                  "Search the currently open VS Code workspace for files, symbols, definitions, imports, routes, components, and usages. Use this whenever the supplied context does not contain enough code to answer. The result contains real code snippets and paths.",
                parameters: {
                  type: "OBJECT",
                  properties: {
                    query: {
                      type: "STRING",
                      description:
                        "A precise filename, symbol, import path, or code-search query."
                    }
                  },
                  required: ["query"]
                }
              },
              {
                name: "read_workspace_file",
                description:
                  "Read a specific workspace file returned by search_workspace. Call this after finding a path when you need more code. Large files can be read in line ranges.",
                parameters: {
                  type: "OBJECT",
                  properties: {
                    file_path: {
                      type: "STRING",
                      description:
                        "Workspace-relative file path, such as src/components/TemplateBuilder.jsx."
                    },
                    start_line: {
                      type: "INTEGER",
                      description:
                        "Optional 1-based first line. Defaults to line 1."
                    },
                    end_line: {
                      type: "INTEGER",
                      description:
                        "Optional 1-based last line. Defaults to a bounded section."
                    }
                  },
                  required: ["file_path"]
                }
              },
              {
                name: "fetch_url",
                description:
                  "Fetch a web page (GitHub repository, README, article, documentation page, blog post, etc.) shared by the user and return its readable text content. Use this whenever the user shares a link or asks for details about a specific URL. The result contains the page title and extracted text.",
                parameters: {
                  type: "OBJECT",
                  properties: {
                    url: {
                      type: "STRING",
                      description:
                        "The absolute http(s) URL to fetch."
                    }
                  },
                  required: ["url"]
                }
              },
              {
                name: "search_web",
                description:
                  "Search a specific web source for a topic and return a small list of matching titles and URLs. Choose the source that best fits the question: wikipedia for general topics, people, and movies; stackoverflow for programming questions and errors; mdn for web platform documentation; hackernews for tech news and discussions; github for repositories and projects; registry for the latest version of Node.js, npm packages, or Python packages; crates for Rust crates; rubygems for Ruby gems; and go for Go modules. After results return, call fetch_url on the most relevant URL to read the full content.",
                parameters: {
                  type: "OBJECT",
                  properties: {
                    query: {
                      type: "STRING",
                      description:
                        "A concise search phrase, package name, or repository name."
                    },
                    source: {
                      type: "STRING",
                      description:
                        "The source to search: wikipedia, stackoverflow, mdn, hackernews, github, registry, crates, rubygems, or go. Defaults to wikipedia."
                    }
                  },
                  required: ["query"]
                }
              },
              {
                name: "render_markdown",
                description:
                  "Render code, Markdown tables, lists, headings, and detailed visual technical content in the chat panel.",
                parameters: {
                  type: "OBJECT",
                  properties: {
                    markdown: {
                      type: "STRING",
                      description:
                        "Complete Markdown content. Code must use fenced code blocks."
                    }
                  },
                  required: ["markdown"]
                }
              }
            ]
          }
        ],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        realtimeInputConfig: {
          automaticActivityDetection: {
            disabled: false,
            startOfSpeechSensitivity: "START_SENSITIVITY_LOW",
            endOfSpeechSensitivity: "END_SENSITIVITY_LOW",
            prefixPaddingMs: 500,
            silenceDurationMs: 900
          },
          activityHandling: preferences.autoInterrupt
            ? "START_OF_ACTIVITY_INTERRUPTS"
            : "NO_INTERRUPTION",
          // Attached images are committed as atomic clientContent turns, so
          // turnCoverage is a safety net for any realtime video frames (for
          // example future webcam input) arriving just before the text that
          // starts activity.
          turnCoverage: "TURN_INCLUDES_AUDIO_ACTIVITY_AND_ALL_VIDEO"
        }
      }
    };
  }
}
