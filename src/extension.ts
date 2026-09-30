import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { AttachmentStore } from "./attachments.js";
import { ChatHistoryStore } from "./chatHistory.js";
import {
  captureEditorContext,
  captureCurrentPageContext,
  summarizeCurrentPage,
  summarizeEditorContext,
} from "./editorContext.js";
import {
  LiveSession,
  type LiveFunctionResponse,
  type LiveSessionEvent,
} from "./liveSession.js";
import { isLiveFunctionResponse } from "./liveProtocol.js";
import { MicrophoneCapture } from "./microphoneCapture.js";
import {
  buildConversationHistoryPrompt,
  buildEditorContextPrompt,
  buildTextPrompt,
  buildWorkspaceContextPrompt,
} from "./prompts.js";
import { readPreferences, savePreferences } from "./preferences.js";
import { isDirectSelectedCodeRequest } from "./requestIntent.js";
import { TranscribeLiveSession } from "./transcribeSession.js";
import { reconcileSpokenTranscript } from "./transcriptReconciler.js";
import type { EditorContext, Preferences, StoredChat } from "./types.js";
import { WorkspaceContextRetriever } from "./workspaceContext.js";

const API_KEY_SECRET = "liveline.geminiApiKey";
const VIEW_ID = "liveline.chatView";

interface WebviewMessage {
  readonly type: string;
  readonly value?: string;
  readonly text?: string;
  readonly url?: string;
  readonly muted?: boolean;
  readonly requestId?: string;
  readonly actionId?: string;
  readonly code?: string;
  readonly targetId?: string;
  readonly chatId?: string;
  readonly chatIds?: readonly string[];
  readonly chat?: StoredChat;
  readonly includeCurrentPage?: boolean;
  readonly currentPageUri?: string;
  readonly attachmentIds?: readonly string[];
  readonly preferences?: Preferences;
  readonly functionResponse?: unknown;
  readonly enabled?: boolean;
  readonly data?: string;
  readonly startLine?: number;
  readonly fromEdit?: boolean;
  readonly messageId?: string;
  readonly rawTranscript?: string;
  readonly modelResponse?: string;
}

interface ApplyTarget {
  readonly uri: vscode.Uri;
  readonly range: vscode.Range;
  readonly originalText: string;
}

interface LiveToolFunctionCall {
  readonly id?: string;
  readonly name?: string;
  readonly args?: Readonly<Record<string, unknown>>;
}

interface ScreenFrame {
  readonly text: string;
  readonly languageId: string;
  readonly fileName: string;
  readonly relativePath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly selectionStart?: number;
  readonly selectionEnd?: number;
}

const MAX_APPLY_TARGETS = 20;
const MAX_PATCH_CHARACTERS = 1_000_000;
const MAX_WORKSPACE_TOOL_CALLS_PER_TURN = 8;
const MAX_URL_TEXT_CHARS = 60_000;

class GeminiXViewProvider
  implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private session: LiveSession | undefined;
  private transcribeSession: TranscribeLiveSession | undefined;
  private microphone: MicrophoneCapture | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly workspaceContextRetriever = new WorkspaceContextRetriever();
  private readonly applyTargets = new Map<string, ApplyTarget>();
  private readonly attachmentStore = new AttachmentStore();
  private readonly chatHistory: ChatHistoryStore;
  private turnPrimaryContext: EditorContext | undefined;
  private workspaceToolCallsThisTurn = 0;
  private micMuted = false;
  private screenShareTimer: NodeJS.Timeout | undefined;
  private lastScreenFrameKey = "";
  private sessionHistorySeeded = false;

  private async openFile(
    filePath: string | undefined,
    startLine?: number,
  ): Promise<void> {
    if (!filePath) {
      return;
    }
    try {
      const file = await this.workspaceContextRetriever.readFile(filePath);
      const doc = await vscode.workspace.openTextDocument(file.uri);
      const targetLine = Math.min(
        Math.max(1, Math.floor(startLine ?? 1)),
        doc.lineCount,
      );
      await vscode.window.showTextDocument(doc, {
        preview: true,
        selection: new vscode.Range(
          targetLine - 1,
          0,
          targetLine - 1,
          0,
        ),
      });
    } catch {
      vscode.window.showErrorMessage(`Could not open file: ${filePath}`);
    }
  }

  private openExternal(url: string | undefined): void {
    if (!url) {
      return;
    }
    try {
      void vscode.env.openExternal(vscode.Uri.parse(url));
    } catch {
      vscode.window.showErrorMessage(`Could not open URL: ${url}`);
    }
  }

  private async shareResponse(text: string | undefined): Promise<void> {
    if (!text?.trim()) {
      return;
    }
    const content = text.trim();
    const preview = content.slice(0, 50).replace(/\s+/g, " ");

    const options: (vscode.QuickPickItem & { id: string })[] = [
      {
        id: "mail",
        label: "$(mail) Send via Email / Default Mail Client",
        description: "Open your system's default email client with this response"
      },
      {
        id: "newTab",
        label: "$(file-text) Open in New Editor Tab",
        description: "Open in a new Markdown document in VS Code"
      },
      {
        id: "saveFile",
        label: "$(save) Save as Markdown File...",
        description: "Save response as a .md file to your computer"
      },
      {
        id: "copy",
        label: "$(clippy) Copy to Clipboard",
        description: "Copy full response text to clipboard"
      }
    ];

    const selected = await vscode.window.showQuickPick(options, {
      placeHolder: `Share response: "${preview}…"`,
      title: "Share GeminiX Response"
    });

    if (!selected) {
      return;
    }

    switch (selected.id) {
      case "mail": {
        const subject = encodeURIComponent("GeminiX Response");
        const body = encodeURIComponent(content);
        const mailtoUri = vscode.Uri.parse(`mailto:?subject=${subject}&body=${body}`);
        try {
          await vscode.env.openExternal(mailtoUri);
        } catch {
          vscode.window.showErrorMessage("Could not open default mail client.");
        }
        break;
      }
      case "newTab": {
        const doc = await vscode.workspace.openTextDocument({
          content,
          language: "markdown"
        });
        await vscode.window.showTextDocument(doc, { preview: false });
        break;
      }
      case "saveFile": {
        const uri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file("gemini-response.md"),
          filters: { Markdown: ["md"], "All Files": ["*"] },
          title: "Save Response as Markdown"
        });
        if (uri) {
          await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
          void vscode.window.showInformationMessage(`Saved response to ${uri.fsPath}`);
        }
        break;
      }
      case "copy": {
        await vscode.env.clipboard.writeText(content);
        void vscode.window.showInformationMessage("Response copied to clipboard.");
        break;
      }
    }
  }

  private handleRespeakMessage(text: string | undefined): void {
    const speechText = text?.trim();
    if (!speechText || !this.session?.isConnected) {
      return;
    }

    const prompt = [
      "Please speak the following text aloud verbatim, loud and clear.",
      "Provide spoken audio only. Do not add any introductory phrases, extra commentary, markdown blocks, or code blocks. Speak the text directly:",
      "",
      speechText,
    ].join("\n");

    this.session.sendUserTurn(prompt);
  }

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly secrets: vscode.SecretStorage,
    globalStorageUri: vscode.Uri,
  ) {
    this.chatHistory = new ChatHistoryStore(globalStorageUri);
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection(() => {
        this.postEditorContextState();
      }),
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.postEditorContextState();
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (
          event.document.uri.toString() ===
          vscode.window.activeTextEditor?.document.uri.toString()
        ) {
          this.postEditorContextState();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("liveline")) {
          this.post({
            type: "preferences",
            preferences: readPreferences(),
          });
        }
      }),
    );
  }

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const distributionUri = vscode.Uri.joinPath(this.extensionUri, "dist");
    const mediaUri = vscode.Uri.joinPath(this.extensionUri, "media");

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [distributionUri, mediaUri],
    };
    view.webview.html = this.getHtml(view.webview);

    this.disposables.push(
      view.webview.onDidReceiveMessage((message: WebviewMessage) =>
        this.handleMessage(message),
      ),
      view.onDidDispose(() => {
        this.disposeLiveResources();
        this.view = undefined;
      }),
    );
  }

  public async configureApiKey(): Promise<void> {
    const apiKey = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      password: true,
      placeHolder: "AIza...",
      prompt: "Enter your Google AI Studio Gemini API key",
      title: "Configure GeminiX",
    });

    if (apiKey === undefined) {
      return;
    }

    if (!apiKey.trim()) {
      void vscode.window.showErrorMessage(
        "The Gemini API key cannot be empty.",
      );
      return;
    }

    await this.secrets.store(API_KEY_SECRET, apiKey.trim());
    await this.postApiStatus();
    void vscode.window.showInformationMessage(
      "GeminiX API key saved securely.",
    );
  }

  public dispose(): void {
    this.disposeLiveResources();
    this.disposables.forEach((disposable) => {
      disposable.dispose();
    });
    this.workspaceContextRetriever.dispose();
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    try {
      switch (message.type) {
        case "ready":
          await this.sendInitialState();
          break;
        case "saveApiKey":
          await this.saveApiKey(message.value);
          break;
        case "removeApiKey":
          await this.removeApiKey();
          break;
        case "savePreferences":
          await this.updatePreferences(message.preferences);
          break;
        case "startSession":
          await this.startSession();
          break;
        case "stopSession":
          this.stopSession();
          break;
        case "sendText":
          await this.sendText(
            message.value,
            message.requestId,
            message.chatId,
            message.includeCurrentPage,
            message.currentPageUri,
            message.attachmentIds,
            message.fromEdit
          );
          break;
        case "pickFileAttachments":
          await this.pickFileAttachments();
          break;
        case "pickImageAttachments":
          await this.pickImageAttachments();
          break;
        case "removeAttachment":
          this.removeAttachment(message.value);
          break;
        case "saveChat":
          await this.saveChat(message.chat);
          break;
        case "loadChat":
          await this.loadChat(message.chatId);
          break;
        case "deleteChat":
          await this.deleteChat(message.chatId);
          break;
        case "deleteChats":
          await this.deleteChats(message.chatIds);
          break;
        case "copyCode":
          await this.copyCode(message.code, message.actionId);
          break;
        case "applyPatch":
          await this.applyPatch(
            message.code,
            message.targetId,
            message.actionId,
          );
          break;
        case "muteMic":
          this.micMuted = Boolean(message.muted);
          this.post({
            type: "micMuted",
            muted: this.micMuted,
            level: this.micMuted ? 0 : undefined,
          });
          break;
        case "interruptTurn":
          this.session?.sendInterrupt();
          break;
        case "sendToolResponse":
          this.sendToolResponse(message.functionResponse);
          break;
        case "setScreenSharing":
          this.setScreenSharing(Boolean(message.enabled));
          break;
        case "sendScreenFrame":
          this.sendScreenFrame(message.data);
          break;
        case "refreshExtension":
          this.refreshExtension();
          break;
        case "openFile":
          await this.openFile(message.data, message.startLine);
          break;
        case "openExternal":
          this.openExternal(message.url);
          break;
        case "shareResponse":
          await this.shareResponse(message.value);
          break;
        case "respeakMessage":
          this.handleRespeakMessage(message.text);
          break;
        case "reconcileVoiceTranscript":
          await this.reconcileVoiceTranscript(
            message.messageId,
            message.rawTranscript,
            message.modelResponse
          );
          break;
      }
    } catch (error) {
      this.post({
        type: "hostError",
        message:
          error instanceof Error
            ? error.message
            : "GeminiX could not continue.",
      });
    }
  }

  private async sendInitialState(): Promise<void> {
    await this.chatHistory.initialize();
    this.post({
      type: "initialState",
      apiConfigured: Boolean(await this.secrets.get(API_KEY_SECRET)),
      preferences: readPreferences(),
      selection: summarizeEditorContext(captureEditorContext()),
      currentPage: summarizeCurrentPage(captureCurrentPageContext()),
      attachments: this.attachmentStore.list(),
      chats: await this.chatHistory.list(),
    });
  }

  private async saveApiKey(value: string | undefined): Promise<void> {
    const apiKey = value?.trim();
    if (!apiKey) {
      throw new Error("Enter a Gemini API key before saving.");
    }

    await this.secrets.store(API_KEY_SECRET, apiKey);
    await this.postApiStatus();
  }

  private async removeApiKey(): Promise<void> {
    this.stopSession();
    await this.secrets.delete(API_KEY_SECRET);
    await this.postApiStatus();
  }

  private async updatePreferences(
    preferences: Preferences | undefined,
  ): Promise<void> {
    if (!preferences) {
      throw new Error("GeminiX settings were not provided.");
    }

    const savedPreferences = await savePreferences(preferences);
    this.post({
      type: "preferencesSaved",
      preferences: savedPreferences,
    });

    if (this.session?.isConnected) {
      await this.startSession();
    }
  }

  private async startSession(): Promise<void> {
    const apiKey = await this.secrets.get(API_KEY_SECRET);
    if (!apiKey) {
      this.post({ type: "apiRequired" });
      return;
    }

    this.disposeLiveResources();
    this.sessionHistorySeeded = false;
    this.session = new LiveSession((event) => {
      this.handleSessionEvent(event);
    });

    this.transcribeSession = new TranscribeLiveSession({
      onTranscriptChunk: (text) => {
        this.post({ type: "userTranscriptChunk", text });
      },
      onTurnComplete: () => {
        this.post({ type: "userTranscriptTurnComplete" });
      },
      onError: (message) => {
        this.post({
          type: "debugLog",
          message: `Live transcribe note: ${message}`,
        });
      },
    });

    try {
      this.microphone = new MicrophoneCapture({
        onFrame: (frame) => {
          if (!this.micMuted) {
            this.session?.sendPcm16(frame);
            this.transcribeSession?.sendPcm16(frame);
          }
        },
        onLevel: (level) => {
          this.post({ type: "microphoneLevel", level });
        },
        onSpeechStart: () => {
          void this.sendVoiceContext();
        },
        onError: (message) => {
          this.post({ type: "sessionError", message });
          this.stopSession();
        },
      });
      this.microphone.start();
      this.session.connect(apiKey, readPreferences());
      this.transcribeSession.connect(apiKey);
    } catch (error) {
      this.disposeLiveResources();
      // Report through the normal session-error path instead of throwing:
      // a hostError would leave the webview stuck on "Requesting
      // microphone" with a disabled Start button (isConnecting stays true)
      // until the extension or window is reloaded.
      this.post({
        type: "sessionError",
        message:
          error instanceof Error
            ? `Could not open the default microphone: ${error.message}`
            : "Could not open the default microphone.",
      });
    }
  }

  private stopSession(): void {
    this.disposeLiveResources();
    this.post({ type: "sessionStopped" });
  }

  private setScreenSharing(enabled: boolean): void {
    if (enabled) {
      if (this.screenShareTimer) {
        return;
      }
      // Send the first frame immediately, then keep the visible editor in
      // sync at roughly the Live API video rate (images at <= 1 FPS).
      this.captureScreenFrame();
      this.screenShareTimer = setInterval(() => {
        this.captureScreenFrame();
      }, 1_000);
    } else {
      this.stopScreenSharing();
    }
  }

  private sendScreenFrame(data: string | undefined): void {
    const session = this.session;
    if (!data || !session?.isConnected) {
      return;
    }
    session.sendVideo(data);
  }

  private captureScreenFrame(): void {
    const editor = vscode.window.activeTextEditor;
    const document = editor?.document;
    if (!editor || !document) {
      this.postScreenFrame({
        text: "",
        languageId: "text",
        fileName: "",
        relativePath: "No editor is open",
        startLine: 0,
        endLine: 0,
      });
      return;
    }

    const range = editor.visibleRanges[0] ?? new vscode.Range(0, 0, 0, 0);
    const selection = editor.selection;
    const startLine = range.start.line + 1;
    const endLine = range.end.line + 1;
    const frame: ScreenFrame = {
      text: document.getText(range),
      languageId: document.languageId,
      fileName: displayFileName(document.fileName),
      relativePath: vscode.workspace.asRelativePath(document.uri, false),
      startLine,
      endLine,
      selectionStart: Math.max(selection.start.line + 1, startLine),
      selectionEnd: Math.min(selection.end.line + 1, endLine),
    };

    // Only publish frames whose visible content actually changed, so we do
    // not re-encode and re-upload identical screenshots every second.
    const key = [
      document.uri.toString(),
      startLine,
      endLine,
      frame.text.length,
      frame.selectionStart ?? -1,
      frame.selectionEnd ?? -1,
    ].join(":");
    if (key === this.lastScreenFrameKey) {
      return;
    }
    this.lastScreenFrameKey = key;
    this.postScreenFrame(frame);
  }

  private postScreenFrame(frame: ScreenFrame): void {
    this.post({ type: "screenFrame", frame });
  }

  private stopScreenSharing(): void {
    if (this.screenShareTimer) {
      clearInterval(this.screenShareTimer);
      this.screenShareTimer = undefined;
    }
    this.lastScreenFrameKey = "";
  }

  private async sendText(
    text: string | undefined,
    requestId: string | undefined,
    chatId: string | undefined,
    includeCurrentPage: boolean | undefined,
    currentPageUri: string | undefined,
    attachmentIds: readonly string[] | undefined,
    fromEdit: boolean | undefined,
  ): Promise<void> {
    const userText = text?.trim() ?? "";
    const requestedAttachmentIds = attachmentIds ?? [];
    const hasAttachments =
      requestedAttachmentIds.length > 0 || Boolean(includeCurrentPage);

    if ((!userText && !hasAttachments) || !this.session?.isConnected) {
      this.post({
        type: "textRejected",
        requestId,
        message: "Start a live session before sending a message.",
      });
      return;
    }

    const context = captureEditorContext();
    if (
      context &&
      !hasAttachments &&
      !fromEdit &&
      isDirectSelectedCodeRequest(userText)
    ) {
      this.post({
        type: "selectedCodeResponse",
        codeText: context.text,
        languageId: context.languageId
      });
      return;
    }

    const currentPageContext = includeCurrentPage
      ? captureCurrentPageContext(currentPageUri)
      : undefined;
    const applyTargetId = this.registerApplyTarget(context);
    this.turnPrimaryContext = context;
    this.workspaceToolCallsThisTurn = 0;
    const apiKey = await this.secrets.get(API_KEY_SECRET);
    const preparedAttachments = await this.attachmentStore.prepare(
      requestedAttachmentIds,
      apiKey,
    );

    const displayAttachments = await this.attachmentStore.displayInfo(
      requestedAttachmentIds,
    );
    this.post({
      type: "textAccepted",
      requestId,
      text: userText,
      context: summarizeEditorContext(context),
      currentPage: summarizeCurrentPage(currentPageContext),
      applyTargetId,
      attachments: requestedAttachmentIds,
      attachmentDisplays: displayAttachments,
      hasImages: preparedAttachments.images.length > 0,
      fromEdit
    });

    const announceSearch = shouldAnnounceWorkspaceSearch(userText);
    if (announceSearch) {
      this.post({
        type: "workspaceSearchStarted",
        requestId,
        kind: "workspace",
        message: "Let me search the workspace and read the relevant code.",
      });
    }

    const workspaceContext = await this.workspaceContextRetriever.retrieve(
      userText,
      context,
    );
    if (announceSearch) {
      this.postWorkspaceSearchCompleted(requestId, workspaceContext);
    }

    // The Live session is stateful: Gemini already remembers everything said
    // in the current session. Resending the full history on every typed
    // question bloats the context (which makes the model repeat itself) and
    // burns API quota. Seed the history only once, on the first user turn of
    // a session, and only when the chat is a restored one with prior messages.
    const isFirstSessionTurn = !this.sessionHistorySeeded;
    this.sessionHistorySeeded = true;
    const conversation = await this.chatHistory.conversationContext(chatId);
    const conversationPrompt =
      isFirstSessionTurn && conversation.length > 0
        ? buildConversationHistoryPrompt(conversation)
        : "";
    const prompt = buildTextPrompt(
      userText,
      context,
      currentPageContext,
      workspaceContext,
      preparedAttachments.prompt,
      conversationPrompt,
    );
    const session = this.session;
    if (
      !session.sendUserTurn(prompt, preparedAttachments.images) ||
      session !== this.session
    ) {
      this.post({
        type: "textRejected",
        requestId,
        message: "The message could not be sent.",
      });
      return;
    }

    this.attachmentStore.release(requestedAttachmentIds);
    this.postAttachmentState();
  }

  private sendToolResponse(functionResponse: unknown): void {
    if (!isLiveFunctionResponse(functionResponse)) {
      this.post({
        type: "toolResponseStatus",
        success: false,
        message: "Rejected an invalid Gemini tool-response payload.",
      });
      return;
    }

    const session = this.session;
    const sent = Boolean(session?.sendToolResponses([functionResponse]));
    this.post({
      type: "toolResponseStatus",
      functionCallId: functionResponse.id,
      functionName: functionResponse.name,
      success: sent,
      message: sent
        ? `Sent ${functionResponse.name} response (${functionResponse.id}).`
        : `Could not send ${functionResponse.name} response because the Gemini session is not connected.`,
    });
  }

  private async pickFileAttachments(): Promise<void> {
    try {
      await this.attachmentStore.pickTextFiles();
    } finally {
      this.postAttachmentState();
    }
  }

  private async pickImageAttachments(): Promise<void> {
    try {
      await this.attachmentStore.pickImages();
    } finally {
      this.postAttachmentState();
    }
  }

  private removeAttachment(id: string | undefined): void {
    if (id) {
      this.attachmentStore.remove(id);
      this.postAttachmentState();
    }
  }

  private async saveChat(chat: StoredChat | undefined): Promise<void> {
    if (!chat) {
      throw new Error("The chat content was not provided.");
    }

    const saved = await this.chatHistory.save(chat);
    this.post({
      type: "chatSaved",
      chatId: saved.id,
      chats: await this.chatHistory.list(),
    });
  }

  private async loadChat(chatId: string | undefined): Promise<void> {
    if (!chatId) {
      throw new Error("Choose a saved chat to reuse.");
    }

    this.post({
      type: "chatLoaded",
      chat: await this.chatHistory.read(chatId),
    });
  }

  private async deleteChat(chatId: string | undefined): Promise<void> {
    if (!chatId) {
      throw new Error("Choose a saved chat to delete.");
    }

    const confirmation = await vscode.window.showWarningMessage(
      "Delete this saved GeminiX chat? This cannot be undone.",
      { modal: true },
      "Delete",
    );
    if (confirmation !== "Delete") {
      return;
    }

    await this.chatHistory.delete(chatId);
    this.post({
      type: "chatDeleted",
      chatId,
      chats: await this.chatHistory.list(),
    });
  }

  private async deleteChats(
    chatIds: readonly string[] | undefined,
  ): Promise<void> {
    if (!chatIds || chatIds.length === 0) {
      throw new Error("Choose at least one saved chat to delete.");
    }

    const confirmation = await vscode.window.showWarningMessage(
      `Delete ${chatIds.length} saved GeminiX chat${chatIds.length === 1 ? "" : "s"}? This cannot be undone.`,
      { modal: true },
      "Delete",
    );
    if (confirmation !== "Delete") {
      return;
    }

    for (const chatId of chatIds) {
      await this.chatHistory.delete(chatId);
    }
    this.post({
      type: "chatDeleted",
      chatId: chatIds[0],
      chatIds,
      chats: await this.chatHistory.list(),
    });
  }

  private async sendVoiceContext(): Promise<void> {
    const context = captureEditorContext();
    const session = this.session;
    this.turnPrimaryContext = context;
    this.workspaceToolCallsThisTurn = 0;
    if (context && session?.isConnected) {
      const workspaceContext = await this.workspaceContextRetriever.retrieve(
        "",
        context,
      );
      if (session !== this.session || !this.session.isConnected) {
        return;
      }

      const workspacePrompt = buildWorkspaceContextPrompt(workspaceContext);
      session.sendText(
        [
          buildEditorContextPrompt(context),
          workspacePrompt,
          "The user is now asking a voice question about this context.",
        ]
          .filter(Boolean)
          .join("\n\n"),
      );
    }

    this.post({
      type: "voiceContext",
      context: summarizeEditorContext(context),
      applyTargetId: this.registerApplyTarget(context),
    });
  }

  private handleSessionEvent(event: LiveSessionEvent): void {
    switch (event.type) {
      case "connecting":
        this.post({ type: "sessionConnecting" });
        break;
      case "opened":
        this.post({ type: "sessionOpened" });
        break;
      case "serverMessage":
        void this.handleWorkspaceToolCalls(event.payload);
        this.post({ type: "serverMessage", payload: event.payload });
        break;
      case "debug":
        this.post({ type: "debugLog", message: event.message });
        break;
      case "error":
        this.post({ type: "sessionError", message: event.message });
        break;
      case "closed":
        this.stopScreenSharing();
        this.microphone?.dispose();
        this.microphone = undefined;
        this.session = undefined;
        this.post({
          type: "sessionClosed",
          code: event.code,
          reason: event.reason,
          intentional: event.intentional,
        });
        break;
    }
  }

  private disposeLiveResources(): void {
    this.stopScreenSharing();
    this.microphone?.dispose();
    this.microphone = undefined;
    this.transcribeSession?.dispose();
    this.transcribeSession = undefined;
    this.session?.dispose();
    this.session = undefined;
  }

  private async reconcileVoiceTranscript(
    messageId: string | undefined,
    rawTranscript: string | undefined,
    modelResponse: string | undefined
  ): Promise<void> {
    if (!messageId || !rawTranscript || !modelResponse) {
      return;
    }
    const apiKey = await this.secrets.get(API_KEY_SECRET);
    if (!apiKey) {
      return;
    }
    const preferences = readPreferences();
    const correctedText = await reconcileSpokenTranscript({
      rawTranscript,
      assistantResponse: modelResponse,
      preferredLanguage: preferences.preferredLanguage,
      apiKey,
    });
    if (correctedText) {
      this.post({
        type: "transcriptCorrected",
        messageId,
        correctedText,
      });
    }
  }

  private async postApiStatus(): Promise<void> {
    this.post({
      type: "apiStatus",
      configured: Boolean(await this.secrets.get(API_KEY_SECRET)),
    });
  }

  public refreshExtension(): void {
    vscode.commands.executeCommand("workbench.action.reloadWindow");
  }

  public openPanel(panel: "history" | "settings"): void {
    this.post({ type: "openPanel", panel });
  }

  public startNewChat(): void {
    this.post({ type: "newChat" });
  }

  private postEditorContextState(): void {
    this.post({
      type: "selectionChanged",
      selection: summarizeEditorContext(captureEditorContext()),
      currentPage: summarizeCurrentPage(captureCurrentPageContext()),
    });
  }

  private registerApplyTarget(
    context: EditorContext | undefined,
  ): string | undefined {
    if (!context) {
      return undefined;
    }

    const targetId = randomBytes(16).toString("hex");
    this.applyTargets.set(targetId, {
      uri: vscode.Uri.parse(context.uri),
      range: new vscode.Range(
        context.startLineIndex,
        context.startCharacter,
        context.endLineIndex,
        context.endCharacter,
      ),
      originalText: context.text,
    });

    while (this.applyTargets.size > MAX_APPLY_TARGETS) {
      const oldestTargetId = this.applyTargets.keys().next().value;
      if (!oldestTargetId) {
        break;
      }
      this.applyTargets.delete(oldestTargetId);
    }
    return targetId;
  }

  private async copyCode(
    code: string | undefined,
    actionId: string | undefined,
  ): Promise<void> {
    if (code === undefined) {
      throw new Error("No code was provided to copy.");
    }

    await vscode.env.clipboard.writeText(code);
    this.post({ type: "codeCopied", actionId });
  }

  private async applyPatch(
    code: string | undefined,
    targetId: string | undefined,
    actionId: string | undefined,
  ): Promise<void> {
    if (code === undefined || code.length > MAX_PATCH_CHARACTERS) {
      throw new Error("The returned code is empty or too large to apply.");
    }

    const activeEditor = vscode.window.activeTextEditor;
    const activeSelection =
      activeEditor && !activeEditor.selection.isEmpty
        ? {
          uri: activeEditor.document.uri,
          range: activeEditor.selection,
          originalText: activeEditor.document.getText(activeEditor.selection),
        }
        : undefined;
    const capturedTarget = targetId
      ? this.applyTargets.get(targetId)
      : undefined;
    const target = activeSelection ?? capturedTarget;
    if (!target) {
      throw new Error(
        "Select the code you want to replace in the active editor, then click Apply again.",
      );
    }

    const document = await vscode.workspace.openTextDocument(target.uri);
    if (
      !activeSelection &&
      document.getText(target.range) !== target.originalText
    ) {
      throw new Error(
        "The selected code changed after the answer was generated. Select it again before applying.",
      );
    }

    const replacement =
      !target.originalText.endsWith("\n") && code.endsWith("\n")
        ? code.slice(0, -1)
        : code;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(target.uri, target.range, replacement);
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      throw new Error("VS Code could not apply the returned code.");
    }

    if (targetId) {
      this.applyTargets.delete(targetId);
    }
    this.post({ type: "patchApplied", actionId, targetId });
    void vscode.window.showInformationMessage(
      `GeminiX applied the code to ${vscode.workspace.asRelativePath(target.uri, false)}.`,
    );
  }

  private async handleWorkspaceToolCalls(payload: unknown): Promise<void> {
    const functionCalls = getToolFunctionCalls(payload);
    const session = this.session;
    if (!functionCalls.length || !session?.isConnected) {
      return;
    }

    const responses: LiveFunctionResponse[] = [];
    for (const functionCall of functionCalls) {
      const id = functionCall.id;
      const name = functionCall.name;
      if (!id || !name) {
        continue;
      }

      // render_markdown is handled by the webview, not the extension host.
      if (name === "render_markdown") {
        continue;
      }

      if (
        this.workspaceToolCallsThisTurn >= MAX_WORKSPACE_TOOL_CALLS_PER_TURN
      ) {
        responses.push({
          id,
          name,
          response: {
            error:
              "Workspace tool limit reached for this turn. Answer from the evidence already returned.",
          },
        });
        continue;
      }
      this.workspaceToolCallsThisTurn += 1;

      if (name === "search_workspace") {
        const query = getStringArgument(functionCall.args, "query");
        if (!query) {
          responses.push({
            id,
            name,
            response: { error: "A non-empty search query is required." },
          });
          continue;
        }

        this.post({
          type: "workspaceSearchStarted",
          requestId: id,
          kind: "workspace",
          message: `Let me search the workspace for ${query}.`,
        });
        try {
          const workspaceContext =
            await this.workspaceContextRetriever.retrieve(
              query,
              this.turnPrimaryContext,
            );
          this.postWorkspaceSearchCompleted(id, workspaceContext);
          responses.push({
            id,
            name,
            response: {
              query,
              indexedFileCount: workspaceContext.indexedFileCount,
              snippets: workspaceContext.snippets,
              truncated: workspaceContext.truncated,
              message: workspaceContext.snippets.length
                ? "Workspace code was found and read."
                : "No matching workspace code was found.",
            },
          });
        } catch (error) {
          responses.push({
            id,
            name,
            response: {
              error:
                error instanceof Error
                  ? error.message
                  : "The workspace search failed.",
            },
          });
        }
        continue;
      }

      if (name === "read_workspace_file") {
        const filePath = getStringArgument(functionCall.args, "file_path");
        if (!filePath) {
          responses.push({
            id,
            name,
            response: {
              error: "A workspace-relative file_path is required.",
            },
          });
          continue;
        }

        this.post({
          type: "workspaceSearchStarted",
          requestId: id,
          kind: "reading",
          message: `Let me read ${displayFileName(filePath)}.`,
        });
        try {
          const file = await this.workspaceContextRetriever.readFile(
            filePath,
            getNumberArgument(functionCall.args, "start_line"),
            getNumberArgument(functionCall.args, "end_line"),
          );
          this.post({
            type: "workspaceSearchCompleted",
            requestId: id,
            files: [file.filePath],
            message: `Read lines ${file.startLine}-${file.endLine}.`,
          });
          responses.push({
            id,
            name,
            response: { file },
          });
        } catch (error) {
          responses.push({
            id,
            name,
            response: {
              error:
                error instanceof Error
                  ? error.message
                  : "The workspace file could not be read.",
            },
          });
        }
        continue;
      }

      if (name === "fetch_url") {
        const url = getStringArgument(functionCall.args, "url");
        if (!url || !/^https?:\/\//i.test(url)) {
          responses.push({
            id,
            name,
            response: { error: "A valid http(s) URL is required." },
          });
          continue;
        }

        this.post({
          type: "workspaceSearchStarted",
          requestId: id,
          kind: "reading",
          message: `Let me open ${url}.`,
        });
        try {
          const page = await fetchUrlAsText(url);
          this.post({
            type: "workspaceSearchCompleted",
            requestId: id,
            message: `Fetched ${url}.`,
          });
          responses.push({
            id,
            name,
            response: {
              url,
              title: page.title,
              text: page.text,
              truncated: page.truncated,
            },
          });
        } catch (error) {
          responses.push({
            id,
            name,
            response: {
              error:
                error instanceof Error
                  ? error.message
                  : "The URL could not be fetched.",
            },
          });
        }
        continue;
      }

      if (name === "search_web") {
        const query = getStringArgument(functionCall.args, "query");
        if (!query) {
          responses.push({
            id,
            name,
            response: { error: "A non-empty search query is required." },
          });
          continue;
        }
        const source =
          getStringArgument(functionCall.args, "source") ?? "wikipedia";

        this.post({
          type: "workspaceSearchStarted",
          requestId: id,
          kind: "web",
          message: `Let me search ${source} for ${query}.`,
        });
        try {
          const results = await searchWebSource(query, source);
          this.post({
            type: "workspaceSearchCompleted",
            requestId: id,
            message: results.length
              ? `Found ${results.length} result${results.length === 1 ? "" : "s"} on ${source}.`
              : `No results on ${source} for ${query}.`,
          });
          responses.push({
            id,
            name,
            response: {
              query,
              source,
              results,
              message: results.length
                ? `Results from ${source} were found. Fetch the most relevant one with fetch_url.`
                : `No matching results were found on ${source}. Try another source or a simpler query.`,
            },
          });
        } catch (error) {
          responses.push({
            id,
            name,
            response: {
              error:
                error instanceof Error
                  ? error.message
                  : "The web search failed.",
            },
          });
        }
        continue;
      }

      responses.push({
        id,
        name,
        response: { error: `Unknown tool: ${name}` },
      });
    }

    if (responses.length && session === this.session) {
      if (!session.sendToolResponses(responses)) {
        this.post({
          type: "sessionError",
          message: "The workspace tool results could not be sent to Gemini.",
        });
      }
    }
  }

  private postWorkspaceSearchCompleted(
    requestId: string | undefined,
    workspaceContext: Awaited<
      ReturnType<WorkspaceContextRetriever["retrieve"]>
    >,
  ): void {
    const files = [
      ...new Set(workspaceContext.snippets.map((snippet) => snippet.filePath)),
    ];
    this.post({
      type: "workspaceSearchCompleted",
      requestId,
      files,
      message: files.length
        ? `Reviewed ${files.length} relevant code ${files.length === 1 ? "file" : "files"}.`
        : vscode.workspace.workspaceFolders?.length
          ? `Searched ${workspaceContext.indexedFileCount} source files; no strong code match was found.`
          : "No VS Code workspace folder is open. Open the project folder to enable codebase search.",
    });
  }

  private postAttachmentState(): void {
    this.post({
      type: "attachmentsChanged",
      attachments: this.attachmentStore.list(),
    });
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString("base64");
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "styles.css"),
    );
    const logoUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "gemini-x.png"),
    );

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri.toString()}">
  <title>GeminiX</title>
</head>
<body>
  <div class="app-shell">
    <main class="app-main">
      <section id="chatPanel" class="panel is-active api-key-required" aria-label="Chat">
        <section id="apiRequiredCard" class="api-setup-screen" aria-labelledby="apiSetupTitle">
          <div class="api-setup-content">
            <img class="api-setup-logo" src="${logoUri.toString()}" alt="GeminiX">
            <p class="api-setup-eyebrow">One-time setup</p>
            <h1 id="apiSetupTitle">Connect Gemini</h1>
            <p class="api-setup-intro">Add a Gemini API key to start asking questions about your code.</p>
            <label class="field api-setup-field" for="setupApiKeyInput">
              <span>Gemini API key</span>
              <input id="setupApiKeyInput" type="password" spellcheck="false" autocomplete="off" placeholder="Paste your API key">
            </label>
            <button id="setupSaveApiButton" class="primary-button api-setup-submit" type="button">Save key and continue</button>
            <p id="setupApiFeedback" class="api-setup-feedback hidden" role="alert"></p>
            <p class="api-setup-security">Your key is stored securely in the operating system keychain.</p>
            <div class="api-setup-divider" aria-hidden="true"></div>
            <p class="api-setup-free"><strong>Completely free</strong><br>GeminiX is free to use. Google AI Studio API access is subject to Google's quotas and terms.</p>
            <a class="api-setup-link external-link" href="https://aistudio.google.com/app/apikey">Get a free API key from Google AI Studio <span aria-hidden="true">↗</span></a>
          </div>
        </section>
        <div class="chat-scroll-region">
          <section id="voiceStage" class="voice-stage">
            <div class="status-line">
              <span class="status-left">
                <span id="statusDot" class="status-dot"></span>
                <span id="statusLabel">Ready</span>
              </span>
              <span id="sessionTimer" class="session-timer hidden">00:00</span>
            </div>
            <canvas id="orbCanvas" aria-label="Live session animation"></canvas>
            <span id="orbMode" class="orb-mode">standby</span>
            <div class="live-controls">
              <button
                id="muteMicButton"
                class="control-button"
                type="button"
                title="Mute microphone"
                aria-label="Mute microphone"
                hidden
              ></button>
              <button
                id="speakerMuteButton"
                class="control-button"
                type="button"
                title="Mute Gemini's voice"
                aria-label="Mute Gemini's voice"
                hidden
              ></button>
              <button
                id="shareScreenButton"
                class="control-button"
                type="button"
                title="Share screen with Gemini"
                aria-label="Share screen with Gemini"
                hidden
              ></button>
              <button
                id="stopPlaybackButton"
                class="control-button"
                type="button"
                title="Stop response"
                aria-label="Stop response"
                hidden
              ></button>
            </div>
            <div class="mic-track" aria-hidden="true">
              <span id="micMeter" class="mic-meter"></span>
            </div>
            <div class="session-actions">
              <button id="sessionButton" class="primary-button" type="button">
                Start live session
              </button>
            </div>
          </section>

          <div id="errorBox" class="error-box hidden" role="alert"></div>

          <section class="transcript-section">
            <div id="transcript" class="transcript" aria-live="polite">
              <div id="emptyState" class="empty-state">
                <strong>Ask about the code you are working on</strong>
                <span>Select lines in the editor to add them as private context.</span>
              </div>
            </div>
          </section>
        </div>

        <form id="textForm" class="composer">
          <div id="mentionMenu" class="mention-menu hidden" role="listbox" aria-label="Context suggestions">
            <button id="currentPageMention" class="mention-option" type="button" role="option">
              <span class="mention-symbol" aria-hidden="true">@</span>
              <span class="mention-copy">
                <strong>Current file</strong>
                <small id="currentPageMentionLabel"></small>
              </span>
            </button>
          </div>
          <div id="selectionBar" class="selection-bar hidden">
            <span class="selection-icon" aria-hidden="true">&lt;/&gt;</span>
            <span class="selection-copy">
              <small>Selected context</small>
              <strong id="selectionLabel"></strong>
            </span>
          </div>
          <div id="currentPageBar" class="selection-bar current-page-bar hidden">
            <span class="selection-icon" aria-hidden="true">@</span>
            <span class="selection-copy">
              <small>Current file context</small>
              <strong id="currentPageLabel"></strong>
            </span>
            <button id="removeCurrentPageButton" class="context-remove-button" type="button" aria-label="Remove current file context" title="Remove context">
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="m4.3 3.4 3.7 3.7 3.7-3.7.9.9L8.9 8l3.7 3.7-.9.9L8 8.9l-3.7 3.7-.9-.9L7.1 8 3.4 4.3l.9-.9z"/>
              </svg>
            </button>
          </div>
          <div id="attachmentList" class="attachment-list hidden" aria-label="Attached files"></div>
          <div class="composer-row">
            <div class="attachment-menu-wrap">
              <button id="attachmentButton" class="composer-tool-button" type="button" aria-label="Add a file or image" aria-expanded="false" title="Add context">
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M7.4 2h1.2v5.4H14v1.2H8.6V14H7.4V8.6H2V7.4h5.4V2z"/>
                </svg>
              </button>
              <div id="attachmentMenu" class="attachment-menu hidden" role="menu">
                <button id="attachFileButton" class="attachment-option" type="button" role="menuitem">
                  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 1.5h6.2L13 5.3v9.2H3v-13zm1.2 1.2v10.6h7.6V6H8.5V2.7H4.2zm5.5.7v1.4h1.4L9.7 3.4z"/></svg>
                  <span>Add file</span>
                </button>
                <button id="attachImageButton" class="attachment-option" type="button" role="menuitem">
                  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 2h12v12H2V2zm1.2 1.2v9.6h9.6V3.2H3.2zm1.1 8.2 2.6-3 1.8 2 1.2-1.3 1.8 2.3H4.3zm6.4-6.9a1.4 1.4 0 1 1 0 2.8 1.4 1.4 0 0 1 0-2.8z"/></svg>
                  <span>Add image</span>
                </button>
              </div>
            </div>
            <textarea
              id="textInput"
              rows="1"
              autocomplete="off"
              placeholder="Ask GeminiX about your code…"
              aria-label="Chat message"
            ></textarea>
            <button id="sendButton" class="send-button" type="submit" disabled aria-label="Send message" title="Send">
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M2.2 2.4a.65.65 0 0 1 .72-.12l10.2 5.1a.7.7 0 0 1 0 1.24l-10.2 5.1A.65.65 0 0 1 2 13.08L3.1 9 8.3 8 3.1 7 2 2.92a.65.65 0 0 1 .2-.52z"/>
              </svg>
            </button>
          </div>
          <small class="composer-hint">Type @ for current file · + for attachments · Enter to send</small>
        </form>
      </section>

      <section id="historyPanel" class="panel" aria-label="Chat history">
        <div class="settings-header">
          <button id="backFromHistoryButton" class="icon-button" type="button" aria-label="Back to chat" title="Back to chat">
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M7.35 2.15 1.5 8l5.85 5.85.9-.9L3.94 8.63H14v-1.26H3.94l4.31-4.32-.9-.9z"/>
            </svg>
          </button>
          <span class="panel-heading-copy">
            <strong>Chat history</strong>
            <small>Stored locally by GeminiX</small>
          </span>
          <button id="deleteChatsButton" class="secondary-button compact danger-action" type="button">Delete</button>
          <button id="newChatFromHistoryButton" class="secondary-button compact" type="button">New chat</button>
        </div>
        <div id="bulkDeleteBar" class="bulk-delete-bar hidden">
          <label class="select-all-row">
            <input id="selectAllChatsInput" type="checkbox" aria-label="Select all chats">
            <span>Select all</span>
          </label>
          <span id="bulkDeleteCount" class="bulk-delete-count">0 selected</span>
          <span class="bulk-delete-actions">
            <button id="confirmBulkDeleteButton" class="primary-button compact" type="button" disabled>Delete</button>
            <button id="cancelBulkDeleteButton" class="secondary-button compact" type="button">Cancel</button>
          </span>
        </div>
        <div id="chatHistoryList" class="chat-history-list">
          <div id="emptyHistory" class="empty-history">No saved chats yet.</div>
        </div>
      </section>

      <section id="settingsPanel" class="panel" aria-label="Settings">
        <div class="settings-header">
          <button id="backToChatButton" class="icon-button" type="button" aria-label="Back to chat" title="Back to chat">
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M7.35 2.15 1.5 8l5.85 5.85.9-.9L3.94 8.63H14v-1.26H3.94l4.31-4.32-.9-.9z"/>
            </svg>
          </button>
          <span>
            <strong>Settings</strong>
            <small>Configure GeminiX</small>
          </span>
        </div>

        <div class="settings-group">
          <div class="settings-title">
            <span>
              <strong>Gemini API</strong>
              <small id="apiStatusText">Not configured</small>
            </span>
            <span id="apiStatusDot" class="api-status-dot"></span>
          </div>
          <label id="apiKeyField" class="field">
            <span>API key</span>
            <input id="apiKeyInput" type="password" spellcheck="false" autocomplete="off" placeholder="AIza…">
          </label>
          <div class="button-row">
            <button id="saveApiButton" class="primary-button compact" type="button">Save API key</button>
            <button id="removeApiButton" class="secondary-button compact hidden" type="button">Remove key</button>
          </div>
          <p class="field-help">Stored with VS Code SecretStorage in your operating system keychain.</p>
        </div>

        <div class="settings-group">
          <label class="field">
            <span>Live model</span>
            <select id="modelSelect">
              <option value="gemini-3.8-live">Gemini 3.8 Live (Default)</option>
              <option value="gemini-3.1-flash-live-preview">Gemini 3.1 Flash Live</option>
              <option value="gemini-3.8-live-extended-thinking">Gemini 3.8 Live Extended Thinking (Not working properly, recommended using 3.8 Live)</option>
            </select>
          </label>
          <label id="thinkingLevelField" class="field hidden">
            <span>Thinking level</span>
            <select id="thinkingLevelSelect">
              <option value="minimal">Minimal</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High (Extended)</option>
            </select>
          </label>
          <label class="field">
            <span>Gemini voice</span>
            <select id="voiceSelect"></select>
          </label>
          <label class="field">
            <span>Preferred language</span>
            <select id="languageSelect"></select>
          </label>
          <label class="field">
            <span>Behaviour</span>
            <select id="behaviorSelect">
              <option value="professional">Professional</option>
              <option value="friendly">Friendly</option>
              <option value="expert">Expert</option>
            </select>
          </label>
          <label class="toggle-row">
            <span>
              <strong>Auto-interrupt</strong>
              <small>Interrupt Gemini when you start speaking.</small>
            </span>
            <input id="autoInterruptInput" type="checkbox">
          </label>
          <p id="reconnectHint" class="field-help warning hidden">Reconnect the live session to apply changed voice settings.</p>
          <button id="savePreferencesButton" class="primary-button" type="button">Save preferences</button>
          <p id="settingsFeedback" class="field-help hidden" role="status"></p>
        </div>

        <div class="settings-group">
          <button id="debugToggle" class="debug-toggle" type="button" aria-expanded="false">
            <svg viewBox="0 0 16 16" aria-hidden="true" class="debug-toggle-icon"><path d="M5.65 2.15 3.5 4.29 7.21 8 3.5 11.71l2.15 2.14L11.5 8 5.65 2.15z"/></svg>
            <span>Debug log</span>
            <small id="debugBadge" class="debug-badge hidden">0</small>
          </button>
          <div id="debugPanel" class="debug-panel hidden">
            <div id="debugEntries" class="debug-entries" role="log" aria-live="polite"></div>
            <button id="debugClearButton" class="code-action-button debug-clear" type="button">Clear log</button>
          </div>
        </div>
      </section>
    </main>
  </div>
  <script nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`;
  }
}

function getToolFunctionCalls(
  payload: unknown,
): readonly LiveToolFunctionCall[] {
  if (typeof payload !== "object" || payload === null) {
    return [];
  }

  const toolCall = (payload as { readonly toolCall?: unknown }).toolCall;
  if (typeof toolCall !== "object" || toolCall === null) {
    return [];
  }

  const functionCalls = (toolCall as { readonly functionCalls?: unknown })
    .functionCalls;
  return Array.isArray(functionCalls)
    ? (functionCalls as readonly LiveToolFunctionCall[])
    : [];
}

function getStringArgument(
  args: Readonly<Record<string, unknown>> | undefined,
  name: string,
): string | undefined {
  const value = args?.[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getNumberArgument(
  args: Readonly<Record<string, unknown>> | undefined,
  name: string,
): number | undefined {
  const value = args?.[name];
  return typeof value === "number" && Number.isFinite(value)
    ? Math.floor(value)
    : undefined;
}

function shouldAnnounceWorkspaceSearch(userText: string): boolean {
  return (
    /\b(find|search|locate|look\s+for|where|defined|definition|references?|usages?|implementation|codebase|workspace|project|file|component|route)\b/iu.test(
      userText,
    ) ||
    /(?:^|[\s"'`(])(?:[.@\w-]+[\\/])*[.@\w-]+\.[A-Za-z0-9]+(?=$|[\s"'`),:;?])/u.test(
      userText,
    )
  );
}

function displayFileName(filePath: string): string {
  return filePath.split(/[\\/]/u).pop() ?? filePath;
}

const GITHUB_REPO_URL = /^https?:\/\/github\.com\/([^/?#]+)\/([^/?#]+)/i;

function extractHtmlTextAndMeta(html: string): { title: string; text: string } {
  const title =
    /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ||
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i
      .exec(html)?.[1]
      ?.trim() ||
    /<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']*)["']/i
      .exec(html)?.[1]
      ?.trim() ||
    "";

  const metaDescriptions: string[] = [];
  const ogDesc =
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i
      .exec(html)?.[1]
      ?.trim();
  const metaDesc =
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i
      .exec(html)?.[1]
      ?.trim();
  const twitterDesc =
    /<meta[^>]+name=["']twitter:description["'][^>]+content=["']([^"']*)["']/i
      .exec(html)?.[1]
      ?.trim();
  const siteName =
    /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']*)["']/i
      .exec(html)?.[1]
      ?.trim();

  if (siteName) {
    metaDescriptions.push(`Website: ${siteName}`);
  }
  if (metaDesc) {
    metaDescriptions.push(`Description: ${metaDesc}`);
  } else if (ogDesc) {
    metaDescriptions.push(`Description: ${ogDesc}`);
  }
  if (twitterDesc && twitterDesc !== metaDesc && twitterDesc !== ogDesc) {
    metaDescriptions.push(`Summary: ${twitterDesc}`);
  }

  const bodyText = stripHtml(html);
  const metaHeader =
    metaDescriptions.length > 0 ? `${metaDescriptions.join("\n")}\n\n` : "";
  const combinedText = `${metaHeader}${bodyText}`.trim();

  return { title, text: combinedText };
}

async function fetchUrlAsText(url: string): Promise<{
  title: string;
  text: string;
  truncated: boolean;
}> {
  const { body, contentType } = await fetchWithTimeout(url);
  let title = url;
  let text = body;

  if (contentType.includes("text/html") || body.includes("<html") || body.includes("<title")) {
    const extracted = extractHtmlTextAndMeta(body);
    title = extracted.title || url;
    text = extracted.text;
  }

  const repoMatch = GITHUB_REPO_URL.exec(url);
  if (repoMatch?.[1] && repoMatch[2]) {
    const readme = await fetchRawReadme(
      repoMatch[1],
      repoMatch[2].replace(/\.git$/i, ""),
    );
    if (readme) {
      text = `${text}\n\n--- RAW README ---\n${readme}`;
    }
  }

  const truncated = text.length > MAX_URL_TEXT_CHARS;
  if (truncated) {
    text = `${text.slice(0, MAX_URL_TEXT_CHARS)}\n…[content truncated for length]`;
  }
  return { title, text, truncated };
}

async function fetchWithTimeout(url: string): Promise<{
  body: string;
  contentType: string;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, 15_000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,application/json,text/plain,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return {
      body: await response.text(),
      contentType: response.headers.get("content-type") ?? "",
    };
  } finally {
    clearTimeout(timeout);
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchRawReadme(
  owner: string,
  repo: string,
): Promise<string | undefined> {
  for (const candidate of [
    `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/README.md`,
    `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/README.rst`,
    `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/readme.md`,
  ]) {
    try {
      const { body } = await fetchWithTimeout(candidate);
      if (!body.startsWith("404:")) {
        return body;
      }
    } catch {
      // Try the next README candidate.
    }
  }
  return undefined;
}

const WIKIPEDIA_SEARCH_URL =
  "https://en.wikipedia.org/w/api.php?action=query&list=search&srlimit=5&format=json&formatversion=2";

interface WebSearchResult {
  readonly title: string;
  readonly url: string;
  readonly description: string;
}

async function searchWikipedia(
  query: string,
): Promise<readonly WebSearchResult[]> {
  const { body } = await fetchWithTimeout(
    `${WIKIPEDIA_SEARCH_URL}&srsearch=${encodeURIComponent(query)}`,
  );
  const data: unknown = JSON.parse(body);
  if (typeof data !== "object" || data === null) {
    return [];
  }
  const search = (data as { query?: { search?: unknown } }).query?.search;
  if (!Array.isArray(search)) {
    return [];
  }
  return search
    .map((item): WebSearchResult | undefined => {
      const record = item as { title?: unknown; snippet?: unknown };
      const title = typeof record.title === "string" ? record.title : "";
      if (!title) {
        return undefined;
      }
      return {
        title,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(
          title.replace(/ /g, "_"),
        )}`,
        description: stripHtml(
          typeof record.snippet === "string" ? record.snippet : "",
        ),
      };
    })
    .filter((result): result is WebSearchResult => result !== undefined);
}

async function searchDuckDuckGo(
  query: string,
): Promise<readonly WebSearchResult[]> {
  const results: WebSearchResult[] = [];
  const seenUrls = new Set<string>();

  try {
    const { body } = await fetchWithTimeout(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
    );
    const data: unknown = JSON.parse(body);
    if (typeof data === "object" && data !== null) {
      const rec = data as {
        Heading?: unknown;
        AbstractText?: unknown;
        AbstractURL?: unknown;
        RelatedTopics?: unknown;
      };
      const heading = typeof rec.Heading === "string" ? rec.Heading : "";
      const abstractText =
        typeof rec.AbstractText === "string" ? rec.AbstractText : "";
      const abstractUrl =
        typeof rec.AbstractURL === "string" ? rec.AbstractURL : "";
      if (abstractText && abstractUrl && !seenUrls.has(abstractUrl)) {
        seenUrls.add(abstractUrl);
        results.push({
          title: heading || query,
          url: abstractUrl,
          description: abstractText,
        });
      }

      if (Array.isArray(rec.RelatedTopics)) {
        for (const topic of rec.RelatedTopics) {
          const t = topic as { Text?: unknown; FirstURL?: unknown };
          const text = typeof t.Text === "string" ? t.Text : "";
          const firstUrl = typeof t.FirstURL === "string" ? t.FirstURL : "";
          if (text && firstUrl && !seenUrls.has(firstUrl)) {
            seenUrls.add(firstUrl);
            results.push({
              title: text.split(" - ")[0] || text.slice(0, 60),
              url: firstUrl,
              description: text,
            });
          }
        }
      }
    }
  } catch {
    // Continue to HTML search
  }

  try {
    const { body } = await fetchWithTimeout(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    );

    const generalResultRegex =
      /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

    let match: RegExpExecArray | null;
    while ((match = generalResultRegex.exec(body)) !== null) {
      let rawHref = match[1] || "";
      const rawTitle = stripHtml(match[2] || "");
      const rawSnippet = stripHtml(match[3] || "");

      if (rawHref.includes("uddg=")) {
        const uddgMatch = /uddg=([^&]+)/.exec(rawHref);
        if (uddgMatch?.[1]) {
          rawHref = decodeURIComponent(uddgMatch[1]);
        }
      }
      if (rawHref.startsWith("//")) {
        rawHref = `https:${rawHref}`;
      }

      if (rawHref && /^https?:\/\//i.test(rawHref) && !seenUrls.has(rawHref)) {
        seenUrls.add(rawHref);
        results.push({
          title: rawTitle || query,
          url: rawHref,
          description: rawSnippet,
        });
      }
      if (results.length >= 8) {
        break;
      }
    }
  } catch {
    // Continue with existing results
  }

  return results;
}

async function searchWebSource(
  query: string,
  source: string,
): Promise<readonly WebSearchResult[]> {
  const normSource = source.toLowerCase().trim();
  switch (normSource) {
    case "stackoverflow":
      return searchStackOverflow(query);
    case "mdn":
      return searchMdn(query);
    case "hackernews":
      return searchHackerNews(query);
    case "github":
      return searchGitHubRepos(query);
    case "crates":
      return lookupCrate(query);
    case "rubygems":
      return lookupRubyGem(query);
    case "go":
      return lookupGoModule(query);
    case "registry":
      return lookupPackage(query);
    case "wikipedia": {
      const wikiResults = await searchWikipedia(query);
      if (wikiResults.length > 0) {
        return wikiResults;
      }
      return searchDuckDuckGo(query);
    }
    case "google":
    case "web":
    case "duckduckgo":
    default: {
      const webResults = await searchDuckDuckGo(query);
      if (webResults.length > 0) {
        return webResults;
      }
      return searchWikipedia(query);
    }
  }
}

async function searchStackOverflow(
  query: string,
): Promise<readonly WebSearchResult[]> {
  const { body } = await fetchWithTimeout(
    "https://api.stackexchange.com/2.3/search/advanced" +
    `?order=desc&sort=relevance&pagesize=5&site=stackoverflow&q=${encodeURIComponent(query)}`,
  );
  const data: unknown = JSON.parse(body);
  const items = (data as { items?: unknown }).items;
  if (!Array.isArray(items)) {
    return [];
  }
  return items
    .map((item): WebSearchResult | undefined => {
      const record = item as {
        title?: unknown;
        link?: unknown;
        score?: unknown;
        answer_count?: unknown;
      };
      const title = typeof record.title === "string" ? record.title : "";
      const link = typeof record.link === "string" ? record.link : "";
      if (!title || !link) {
        return undefined;
      }
      return {
        title,
        url: link,
        description: `Score ${typeof record.score === "number" ? record.score : 0}, ${typeof record.answer_count === "number" ? record.answer_count : 0} answers. Stack Overflow question.`,
      };
    })
    .filter((result): result is WebSearchResult => result !== undefined);
}

async function searchMdn(query: string): Promise<readonly WebSearchResult[]> {
  const { body } = await fetchWithTimeout(
    `https://developer.mozilla.org/api/v1/search?q=${encodeURIComponent(query)}&locale=en-US`,
  );
  const data: unknown = JSON.parse(body);
  const documents = (data as { documents?: unknown }).documents;
  if (!Array.isArray(documents)) {
    return [];
  }
  return documents
    .map((document): WebSearchResult | undefined => {
      const record = document as {
        title?: unknown;
        summary?: unknown;
        mdn_url?: unknown;
      };
      const title = typeof record.title === "string" ? record.title : "";
      const mdnUrl = typeof record.mdn_url === "string" ? record.mdn_url : "";
      if (!title || !mdnUrl) {
        return undefined;
      }
      return {
        title,
        url: `https://developer.mozilla.org${mdnUrl}`,
        description: typeof record.summary === "string" ? record.summary : "",
      };
    })
    .filter((result): result is WebSearchResult => result !== undefined);
}

async function searchHackerNews(
  query: string,
): Promise<readonly WebSearchResult[]> {
  const { body } = await fetchWithTimeout(
    `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=5`,
  );
  const data: unknown = JSON.parse(body);
  const hits = (data as { hits?: unknown }).hits;
  if (!Array.isArray(hits)) {
    return [];
  }
  return hits
    .map((hit): WebSearchResult | undefined => {
      const record = hit as {
        title?: unknown;
        url?: unknown;
        objectID?: unknown;
        points?: unknown;
        num_comments?: unknown;
      };
      const title = typeof record.title === "string" ? record.title : "";
      const objectID =
        typeof record.objectID === "string" ? record.objectID : "";
      if (!title || !objectID) {
        return undefined;
      }
      return {
        title,
        url:
          typeof record.url === "string" && record.url
            ? record.url
            : `https://news.ycombinator.com/item?id=${objectID}`,
        description: `${typeof record.points === "number" ? record.points : 0} points, ${typeof record.num_comments === "number" ? record.num_comments : 0} comments. Hacker News discussion.`,
      };
    })
    .filter((result): result is WebSearchResult => result !== undefined);
}

async function searchGitHubRepos(
  query: string,
): Promise<readonly WebSearchResult[]> {
  const trimmed = query.trim();
  const variations = new Set<string>([trimmed]);
  if (trimmed.includes(" ")) {
    variations.add(trimmed.replace(/\s+/g, ""));
    variations.add(trimmed.replace(/\s+/g, "-"));
    variations.add(trimmed.replace(/\s+/g, "_"));
  }

  const results: WebSearchResult[] = [];
  const seenUrls = new Set<string>();

  for (const variant of variations) {
    try {
      const [usersRes, reposRes] = await Promise.allSettled([
        fetchWithTimeout(
          `https://api.github.com/search/users?q=${encodeURIComponent(variant)}&per_page=5`,
        ),
        fetchWithTimeout(
          `https://api.github.com/search/repositories?q=${encodeURIComponent(variant)}&per_page=5`,
        ),
      ]);

      if (usersRes.status === "fulfilled") {
        try {
          const data: unknown = JSON.parse(usersRes.value.body);
          const users = (data as { items?: unknown }).items;
          if (Array.isArray(users)) {
            for (const item of users) {
              const u = item as {
                login?: unknown;
                html_url?: unknown;
                type?: unknown;
              };
              const login = typeof u.login === "string" ? u.login : "";
              const htmlUrl = typeof u.html_url === "string" ? u.html_url : "";
              if (htmlUrl && !seenUrls.has(htmlUrl)) {
                seenUrls.add(htmlUrl);
                results.push({
                  title: `GitHub User: @${login}`,
                  url: htmlUrl,
                  description: `GitHub ${typeof u.type === "string" ? u.type : "User"} profile for @${login}. Profile URL: ${htmlUrl}`,
                });
              }
            }
          }
        } catch {
          // ignore parse error
        }
      }

      if (reposRes.status === "fulfilled") {
        try {
          const data: unknown = JSON.parse(reposRes.value.body);
          const items = (data as { items?: unknown }).items;
          if (Array.isArray(items)) {
            for (const item of items) {
              const record = item as {
                full_name?: unknown;
                html_url?: unknown;
                description?: unknown;
                stargazers_count?: unknown;
                language?: unknown;
                license?: { spdx_id?: unknown } | null;
              };
              const fullName =
                typeof record.full_name === "string" ? record.full_name : "";
              const htmlUrl =
                typeof record.html_url === "string" ? record.html_url : "";
              if (fullName && htmlUrl && !seenUrls.has(htmlUrl)) {
                seenUrls.add(htmlUrl);
                const license =
                  record.license && typeof record.license.spdx_id === "string"
                    ? record.license.spdx_id
                    : "no license";
                const description =
                  typeof record.description === "string"
                    ? record.description
                    : "";
                results.push({
                  title: fullName,
                  url: htmlUrl,
                  description:
                    `${typeof record.stargazers_count === "number" ? record.stargazers_count : 0} stars, ${typeof record.language === "string" ? record.language : "unknown"} language, ${license}. ${description}`.trim(),
                });
              }
            }
          }
        } catch {
          // ignore parse error
        }
      }

      if (results.length >= 5) {
        break;
      }
    } catch {
      // Continue to next variation
    }
  }

  return results.slice(0, 10);
}

const NODE_RELEASES_URL = "https://nodejs.org/dist/index.json";

async function lookupPackage(
  name: string,
): Promise<readonly WebSearchResult[]> {
  const normalized = name.trim().toLowerCase();
  if (
    normalized === "node" ||
    normalized === "node.js" ||
    normalized === "nodejs"
  ) {
    try {
      const { body } = await fetchWithTimeout(NODE_RELEASES_URL);
      const releases: unknown = JSON.parse(body);
      if (!Array.isArray(releases) || releases.length === 0) {
        return [];
      }
      const latest = releases[0] as { version?: unknown } | undefined;
      const lts = releases.find(
        (release) => (release as { lts?: boolean | string }).lts !== false,
      ) as { version?: unknown } | undefined;
      const versionOf = (release: { version?: unknown } | undefined): string =>
        typeof release?.version === "string" ? release.version : "";
      return [
        {
          title: `Node.js latest version: ${versionOf(latest)}`,
          url: "https://nodejs.org/en",
          description: `Current (latest): ${versionOf(latest)}; latest LTS: ${versionOf(lts)}. Official Node.js releases.`,
        },
      ];
    } catch {
      return [];
    }
  }

  try {
    const { body } = await fetchWithTimeout(
      `https://registry.npmjs.org/${encodeURIComponent(normalized)}`,
    );
    const data: unknown = JSON.parse(body);
    const latest = (data as { "dist-tags"?: { latest?: unknown } })[
      "dist-tags"
    ]?.latest;
    if (typeof latest === "string") {
      return [
        {
          title: `npm: ${normalized}@${latest}`,
          url: `https://www.npmjs.com/package/${encodeURIComponent(normalized)}`,
          description: `Latest version of the npm package '${normalized}' is ${latest}.`,
        },
      ];
    }
  } catch {
    // Try PyPI below.
  }

  try {
    const { body } = await fetchWithTimeout(
      `https://pypi.org/pypi/${encodeURIComponent(normalized)}/json`,
    );
    const data: unknown = JSON.parse(body);
    const version = (data as { info?: { version?: unknown } }).info?.version;
    if (typeof version === "string") {
      return [
        {
          title: `PyPI: ${normalized} ${version}`,
          url: `https://pypi.org/project/${encodeURIComponent(normalized)}/`,
          description: `Latest version of the Python package '${normalized}' is ${version}.`,
        },
      ];
    }
  } catch {
    return [];
  }

  return [];
}

async function lookupCrate(name: string): Promise<readonly WebSearchResult[]> {
  try {
    const { body } = await fetchWithTimeout(
      `https://crates.io/api/v1/crates/${encodeURIComponent(name.toLowerCase())}`,
    );
    const data: unknown = JSON.parse(body);
    const crate = (
      data as {
        crate?: {
          max_stable_version?: unknown;
          newest_version?: unknown;
          description?: unknown;
        };
      }
    ).crate;
    const version =
      typeof crate?.max_stable_version === "string" &&
        crate.max_stable_version.length > 0
        ? crate.max_stable_version
        : typeof crate?.newest_version === "string"
          ? crate.newest_version
          : "";
    if (!version) {
      return [];
    }
    return [
      {
        title: `crates.io: ${name.toLowerCase()} ${version}`,
        url: `https://crates.io/crates/${encodeURIComponent(name.toLowerCase())}`,
        description:
          typeof crate?.description === "string"
            ? crate.description
            : `Latest version of the Rust crate '${name.toLowerCase()}' is ${version}.`,
      },
    ];
  } catch {
    return [];
  }
}

async function lookupRubyGem(
  name: string,
): Promise<readonly WebSearchResult[]> {
  try {
    const { body } = await fetchWithTimeout(
      `https://rubygems.org/api/v1/gems/${encodeURIComponent(name)}.json`,
    );
    const data: unknown = JSON.parse(body);
    const record = data as {
      name?: unknown;
      version?: unknown;
      info?: unknown;
    };
    const gemName = typeof record.name === "string" ? record.name : name;
    const version = typeof record.version === "string" ? record.version : "";
    if (!version) {
      return [];
    }
    return [
      {
        title: `RubyGems: ${gemName} ${version}`,
        url: `https://rubygems.org/gems/${encodeURIComponent(gemName)}`,
        description:
          typeof record.info === "string"
            ? record.info
            : `Latest version of the Ruby gem '${gemName}' is ${version}.`,
      },
    ];
  } catch {
    return [];
  }
}

function escapeGoModule(modulePath: string): string {
  return modulePath
    .split("/")
    .map((segment) =>
      segment.replace(/[A-Z!]/g, (character) =>
        character === "!" ? "!!" : `!${character.toLowerCase()}`,
      ),
    )
    .join("/");
}

async function lookupGoModule(
  modulePath: string,
): Promise<readonly WebSearchResult[]> {
  try {
    const escaped = escapeGoModule(modulePath.trim());
    const { body } = await fetchWithTimeout(
      `https://proxy.golang.org/${escaped}/@latest`,
    );
    const data: unknown = JSON.parse(body);
    const version = (data as { Version?: unknown }).Version;
    if (typeof version !== "string") {
      return [];
    }
    return [
      {
        title: `Go module: ${modulePath.trim()} ${version}`,
        url: `https://pkg.go.dev/${modulePath.trim()}`,
        description: `Latest version of the Go module '${modulePath.trim()}' is ${version}.`,
      },
    ];
  } catch {
    return [];
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new GeminiXViewProvider(
    context.extensionUri,
    context.secrets,
    context.globalStorageUri,
  );

  context.subscriptions.push(
    provider,
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    }),
    vscode.commands.registerCommand("liveline.configureApiKey", () =>
      provider.configureApiKey(),
    ),
    vscode.commands.registerCommand("liveline.newChat", () =>
      provider.startNewChat(),
    ),
    vscode.commands.registerCommand("liveline.history", () =>
      provider.openPanel("history"),
    ),
    vscode.commands.registerCommand("liveline.settings", () =>
      provider.openPanel("settings"),
    ),
    vscode.commands.registerCommand("liveline.refresh", () =>
      provider.refreshExtension(),
    ),
  );
}

export function deactivate(): void { }
