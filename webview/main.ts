import { createLocalImageContext } from "./imageContext.js";
import { interactionStatus, isInteractionComplete } from "../src/liveInteraction.js";
import bash from "@shikijs/langs/bash";
import c from "@shikijs/langs/c";
import cpp from "@shikijs/langs/cpp";
import csharp from "@shikijs/langs/csharp";
import css from "@shikijs/langs/css";
import go from "@shikijs/langs/go";
import html from "@shikijs/langs/html";
import java from "@shikijs/langs/java";
import javascript from "@shikijs/langs/javascript";
import json from "@shikijs/langs/json";
import jsonc from "@shikijs/langs/jsonc";
import jsx from "@shikijs/langs/jsx";
import markdown from "@shikijs/langs/markdown";
import php from "@shikijs/langs/php";
import python from "@shikijs/langs/python";
import ruby from "@shikijs/langs/ruby";
import rust from "@shikijs/langs/rust";
import scss from "@shikijs/langs/scss";
import sql from "@shikijs/langs/sql";
import svelte from "@shikijs/langs/svelte";
import tsx from "@shikijs/langs/tsx";
import typescript from "@shikijs/langs/typescript";
import vue from "@shikijs/langs/vue";
import yaml from "@shikijs/langs/yaml";
import darkPlus from "@shikijs/themes/dark-plus";
import lightPlus from "@shikijs/themes/light-plus";
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import {
  parseRichContent,
  stripMarkdownForSpeech,
  unescapeMarkdownPipes,
  type TableAlignment,
  type TableSegment
} from "./markdownParser.js";
import { shouldInterruptPlayback } from "./playbackPolicy.js";
import { scheduleLatestRender } from "./renderCoordinator.js";
import {
  hashMarkdown,
  mergeSpokenText,
  mergeVisualText,
  normalizeMarkdown
} from "./streaming.js";
import { lucideIconSvg, type LucideIconName } from "./lucideIcons.js";

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

type Behavior = "professional" | "friendly" | "expert";
type LiveModel =
  | "gemini-3.1-flash-live-preview"
  | "gemini-3.8-live"
  | "gemini-3.8-live-extended-thinking";
type ThinkingLevel = "minimal" | "low" | "medium" | "high";

interface Preferences {
  readonly voice: string;
  readonly preferredLanguage: string;
  readonly autoInterrupt: boolean;
  readonly behavior: Behavior;
  readonly liveModel?: LiveModel;
  readonly thinkingLevel?: ThinkingLevel;
}

interface ContextSummary {
  readonly fileName: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly label: string;
}

interface CurrentPageSummary {
  readonly uri: string;
  readonly fileName: string;
  readonly relativePath: string;
  readonly label: string;
}

type AttachmentKind = "currentFile" | "textFile" | "image" | "document";

interface AttachmentSummary {
  readonly id: string;
  readonly kind: AttachmentKind;
  readonly label: string;
  readonly dataUri?: string;
}

interface AttachmentDisplay {
  readonly id: string;
  readonly kind: AttachmentKind;
  readonly label: string;
  readonly dataUri?: string;
}

type ChatRole = "user" | "model";

interface ChatMessage {
  readonly id: string;
  readonly role: ChatRole;
  spokenText: string;
  visualText?: string;
  markdownBlocks?: readonly MarkdownBlock[];
  readonly createdAt: string;
  readonly contextLabel?: string;
  readonly currentPageLabel?: string;
}

interface StoredChat {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messages: readonly ChatMessage[];
}

interface ChatSummary {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly messageCount: number;
}

interface PendingTextSubmission {
  readonly requestId: string;
  readonly text: string;
  readonly chatId: string;
  readonly includeCurrentPage: boolean;
  readonly currentPageUri?: string;
  readonly attachmentIds: readonly string[];
  readonly fromEdit?: boolean;
  readonly attachmentDisplays?: readonly AttachmentSummary[];
}

interface ServerContent {
  readonly interactionStatus?: string;
  readonly interaction_status?: string;
  readonly inputTranscription?: { readonly text?: string };
  readonly outputTranscription?: { readonly text?: string };
  readonly modelTurn?: {
    readonly parts?: readonly {
      readonly inlineData?: {
        readonly data?: string;
        readonly mimeType?: string;
      };
      readonly text?: string;
      readonly thought?: boolean;
    }[];
  };
  readonly interrupted?: boolean;
  readonly turnComplete?: boolean;
}

interface MarkdownBlock {
  readonly id: string;
  readonly markdown: string;
  readonly functionCallId?: string;
}

interface GeminiFunctionCall {
  readonly id?: string;
  readonly name?: string;
  readonly args?: Readonly<Record<string, unknown>>;
}

interface GeminiToolCall {
  readonly functionCalls?: readonly GeminiFunctionCall[];
}

interface GeminiServerMessage {
  readonly interactionStatus?: string;
  readonly interaction_status?: string;
  readonly toolCallCancellation?: { readonly ids?: readonly string[] };
  readonly error?: {
    readonly message?: string;
    readonly status?: string;
  };
  readonly setupComplete?: unknown;
  readonly serverContent?: ServerContent;
  readonly toolCall?: GeminiToolCall;
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

interface HostMessage {
  readonly liveModel?: LiveModel;
  readonly type?: string;
  readonly apiConfigured?: boolean;
  readonly configured?: boolean;
  readonly preferences?: Preferences;
  readonly selection?: ContextSummary;
  readonly context?: ContextSummary;
  readonly currentPage?: CurrentPageSummary;
  readonly payload?: unknown;
  readonly message?: string;
  readonly codeText?: string;
  readonly languageId?: string;
  readonly kind?: string;
  readonly hasImages?: boolean;
  readonly code?: number;
  readonly reason?: string;
  readonly intentional?: boolean;
  readonly requestId?: string;
  readonly actionId?: string;
  readonly applyTargetId?: string;
  readonly targetId?: string;
  readonly files?: readonly string[];
  readonly attachments?: readonly AttachmentSummary[];
  readonly attachmentDisplays?: readonly AttachmentDisplay[];
  readonly chat?: StoredChat;
  readonly chatId?: string;
  readonly chatIds?: readonly string[];
  readonly chats?: readonly ChatSummary[];
  readonly text?: string;
  readonly level?: number;
  readonly muted?: boolean;
  readonly success?: boolean;
  readonly functionCallId?: string;
  readonly functionName?: string;
  readonly frame?: ScreenFrame;
  readonly fromEdit?: boolean;
  readonly panel?: string;
  readonly messageId?: string;
  readonly correctedText?: string;
}

interface TranscriptMessage {
  readonly id: string;
  readonly role: ChatRole;
  readonly wrapper: HTMLElement;
  readonly content: HTMLElement;
  spokenText: string;
  visualText: string;
  markdownBlocks: MarkdownBlock[];
  closed: boolean;
  renderVersion: number;
  renderBusy: boolean;
  renderQueued: boolean;
  readonly applyTargetId?: string;
  readonly contextLabel?: string;
  readonly currentPageLabel?: string;
}

const OUTPUT_SAMPLE_RATE = 24_000;
const MAX_DEBUG_ENTRIES = 250;
const highlighterPromise = createHighlighterCore({
  themes: [lightPlus, darkPlus],
  langs: [
    bash,
    c,
    cpp,
    csharp,
    css,
    go,
    html,
    java,
    javascript,
    json,
    jsonc,
    jsx,
    markdown,
    php,
    python,
    ruby,
    rust,
    scss,
    sql,
    svelte,
    tsx,
    typescript,
    vue,
    yaml
  ],
  engine: createJavaScriptRegexEngine()
});

const VOICES = [
  ["Zephyr", "Bright"],
  ["Puck", "Upbeat"],
  ["Charon", "Informative"],
  ["Kore", "Firm"],
  ["Fenrir", "Excitable"],
  ["Leda", "Youthful"],
  ["Orus", "Firm"],
  ["Aoede", "Breezy"],
  ["Callirrhoe", "Easy-going"],
  ["Autonoe", "Bright"],
  ["Enceladus", "Breathy"],
  ["Iapetus", "Clear"],
  ["Umbriel", "Easy-going"],
  ["Algieba", "Smooth"],
  ["Despina", "Smooth"],
  ["Erinome", "Clear"],
  ["Algenib", "Gravelly"],
  ["Rasalgethi", "Informative"],
  ["Laomedeia", "Upbeat"],
  ["Achernar", "Soft"],
  ["Alnilam", "Firm"],
  ["Schedar", "Even"],
  ["Gacrux", "Mature"],
  ["Pulcherrima", "Forward"],
  ["Achird", "Friendly"],
  ["Zubenelgenubi", "Casual"],
  ["Vindemiatrix", "Gentle"],
  ["Sadachbia", "Lively"],
  ["Sadaltager", "Knowledgeable"],
  ["Sulafat", "Warm"]
] as const;

const LANGUAGES = [
  "English",
  "Hindi",
  "Spanish",
  "French",
  "German",
  "Portuguese",
  "Japanese",
  "Korean",
  "Mandarin Chinese",
  "Arabic",
  "Russian",
  "Italian",
  "Bengali",
  "Marathi",
  "Tamil",
  "Telugu",
  "Turkish",
  "Indonesian"
] as const;

const vscode = acquireVsCodeApi();

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing required element: ${id}`);
  }
  return element as T;
}

const elements = {
  apiCheckingCard: requiredElement<HTMLElement>("apiCheckingCard"),
  apiKeyField: requiredElement<HTMLElement>("apiKeyField"),
  apiKeyInput: requiredElement<HTMLInputElement>("apiKeyInput"),
  apiRequiredCard: requiredElement<HTMLElement>("apiRequiredCard"),
  apiStatusDot: requiredElement<HTMLElement>("apiStatusDot"),
  apiStatusText: requiredElement<HTMLElement>("apiStatusText"),
  attachFileButton:
    requiredElement<HTMLButtonElement>("attachFileButton"),
  attachImageButton:
    requiredElement<HTMLButtonElement>("attachImageButton"),
  attachmentButton:
    requiredElement<HTMLButtonElement>("attachmentButton"),
  attachmentMenu: requiredElement<HTMLElement>("attachmentMenu"),
  attachmentList: requiredElement<HTMLElement>("attachmentList"),
  autoInterruptInput:
    requiredElement<HTMLInputElement>("autoInterruptInput"),
  backToChatButton: requiredElement<HTMLButtonElement>("backToChatButton"),
  backFromHistoryButton:
    requiredElement<HTMLButtonElement>("backFromHistoryButton"),
  behaviorSelect: requiredElement<HTMLSelectElement>("behaviorSelect"),
  bulkDeleteBar: requiredElement<HTMLElement>("bulkDeleteBar"),
  bulkDeleteCount: requiredElement<HTMLElement>("bulkDeleteCount"),
  cancelBulkDeleteButton:
    requiredElement<HTMLButtonElement>("cancelBulkDeleteButton"),
  chatPanel: requiredElement<HTMLElement>("chatPanel"),
  chatHistoryList: requiredElement<HTMLElement>("chatHistoryList"),
  confirmBulkDeleteButton:
    requiredElement<HTMLButtonElement>("confirmBulkDeleteButton"),
  currentPageBar: requiredElement<HTMLElement>("currentPageBar"),
  currentPageLabel: requiredElement<HTMLElement>("currentPageLabel"),
  currentPageMention:
    requiredElement<HTMLButtonElement>("currentPageMention"),
  currentPageMentionLabel:
    requiredElement<HTMLElement>("currentPageMentionLabel"),
  deleteChatsButton: requiredElement<HTMLButtonElement>("deleteChatsButton"),
  emptyState: requiredElement<HTMLElement>("emptyState"),
  emptyHistory: requiredElement<HTMLElement>("emptyHistory"),
  errorBox: requiredElement<HTMLElement>("errorBox"),
  languageSelect: requiredElement<HTMLSelectElement>("languageSelect"),
  historyPanel: requiredElement<HTMLElement>("historyPanel"),
  micMeter: requiredElement<HTMLElement>("micMeter"),
  mentionMenu: requiredElement<HTMLElement>("mentionMenu"),
  modelSelect: requiredElement<HTMLSelectElement>("modelSelect"),
  muteMicButton: requiredElement<HTMLButtonElement>("muteMicButton"),
  orbCanvas: requiredElement<HTMLCanvasElement>("orbCanvas"),
  orbMode: requiredElement<HTMLElement>("orbMode"),
  reconnectHint: requiredElement<HTMLElement>("reconnectHint"),
  newChatFromHistoryButton:
    requiredElement<HTMLButtonElement>("newChatFromHistoryButton"),
  removeApiButton: requiredElement<HTMLButtonElement>("removeApiButton"),
  setupApiKeyInput:
    requiredElement<HTMLInputElement>("setupApiKeyInput"),
  setupApiFeedback: requiredElement<HTMLElement>("setupApiFeedback"),
  setupSaveApiButton:
    requiredElement<HTMLButtonElement>("setupSaveApiButton"),
  removeCurrentPageButton:
    requiredElement<HTMLButtonElement>("removeCurrentPageButton"),
  saveApiButton: requiredElement<HTMLButtonElement>("saveApiButton"),
  savePreferencesButton:
    requiredElement<HTMLButtonElement>("savePreferencesButton"),
  selectAllChatsInput:
    requiredElement<HTMLInputElement>("selectAllChatsInput"),
  selectionBar: requiredElement<HTMLElement>("selectionBar"),
  selectionLabel: requiredElement<HTMLElement>("selectionLabel"),
  sendButton: requiredElement<HTMLButtonElement>("sendButton"),
  sessionButton: requiredElement<HTMLButtonElement>("sessionButton"),
  sessionTimer: requiredElement<HTMLElement>("sessionTimer"),
  shareScreenButton:
    requiredElement<HTMLButtonElement>("shareScreenButton"),
  speakerMuteButton:
    requiredElement<HTMLButtonElement>("speakerMuteButton"),
  settingsFeedback: requiredElement<HTMLElement>("settingsFeedback"),
  settingsPanel: requiredElement<HTMLElement>("settingsPanel"),
  statusDot: requiredElement<HTMLElement>("statusDot"),
  statusLabel: requiredElement<HTMLElement>("statusLabel"),
  stopPlaybackButton:
    requiredElement<HTMLButtonElement>("stopPlaybackButton"),
  textForm: requiredElement<HTMLFormElement>("textForm"),
  textInput: requiredElement<HTMLTextAreaElement>("textInput"),
  thinkingLevelField: requiredElement<HTMLElement>("thinkingLevelField"),
  thinkingLevelSelect:
    requiredElement<HTMLSelectElement>("thinkingLevelSelect"),
  transcript: requiredElement<HTMLElement>("transcript"),
  voiceSelect: requiredElement<HTMLSelectElement>("voiceSelect"),
  voiceStage: requiredElement<HTMLElement>("voiceStage"),
  debugToggle: requiredElement<HTMLButtonElement>("debugToggle"),
  debugPanel: requiredElement<HTMLElement>("debugPanel"),
  debugEntries: requiredElement<HTMLElement>("debugEntries"),
  debugBadge: requiredElement<HTMLElement>("debugBadge"),
  debugClearButton: requiredElement<HTMLButtonElement>("debugClearButton"),
};

const state = {
  activeChatCreatedAt: undefined as string | undefined,
  activeChatId: undefined as string | undefined,
  activeChatTitle: undefined as string | undefined,
  analyser: undefined as AnalyserNode | undefined,
  analyserData: undefined as Uint8Array<ArrayBuffer> | undefined,
  apiConfigured: false,
  attachedCurrentPage: false,
  attachments: [] as readonly AttachmentSummary[],
  audioContext: undefined as AudioContext | undefined,
  bulkDeleteMode: false,
  bulkDeleteSelected: new Set<string>(),
  chatMessages: [] as ChatMessage[],
  chats: [] as readonly ChatSummary[],
  currentModelMessage: undefined as TranscriptMessage | undefined,
  currentUserMessage: undefined as TranscriptMessage | undefined,
  editingUserMessageId: undefined as string | undefined,
  handledFunctionCallIds: new Set<string>(),
  isConnecting: false,
  masterGain: undefined as GainNode | undefined,
  micLevel: 0,
  micMuted: false,
  mentionRange: undefined as { start: number; end: number } | undefined,
  nextPlaybackTime: 0,
  pendingModelApplyTargetId: undefined as string | undefined,
  pendingTextSubmission: undefined as PendingTextSubmission | undefined,
  pendingVoiceContext: undefined as ContextSummary | undefined,
  playbackSources: new Set<AudioBufferSourceNode>(),
  preferences: {
    voice: "Kore",
    preferredLanguage: "English",
    autoInterrupt: true,
    behavior: "professional",
    liveModel: "gemini-3.8-live",
    thinkingLevel: "high"
  } as Preferences,
  selection: undefined as ContextSummary | undefined,
  currentPage: undefined as CurrentPageSummary | undefined,
  activeSearches: 0,
  analyzingImage: false,
  answering: false,
  reasoning: false,
  activityIndicator: null as HTMLElement | null,
  saveChatTimer: undefined as number | undefined,
  sessionReady: false,
  sessionModel: "gemini-3.8-live" as LiveModel,
  sessionStartedAt: 0,
  screenSharing: false,
  audioMuted: false,
  lastRenderedScreenKey: "",
  suppressNextResponse: false,
  isProcessing: false,
  followTranscript: true,
  activeTextRequestId: undefined as string | undefined,
  submittedText: undefined as PendingTextSubmission | undefined,
  micAutoMuted: false,
  userMicMutedState: false,
  timer: undefined as number | undefined,
  turns: 0,
  restoringChat: false,
  isRespeaking: false,
  respeakCancelled: false,
  respeakTurnComplete: false,
  activeRespeakText: "",
  suppressRespeakTranscript: false,
  activeRespeakButton: null as HTMLButtonElement | null,
  pendingRespeak: undefined as string | undefined,
  hasLiveTranscribeText: false,
  debugEntries: [] as { time: string; message: string }[],
};

const orb = {
  bars: new Float32Array(72),
  context: elements.orbCanvas.getContext("2d"),
  devicePixelRatio: Math.max(1, window.devicePixelRatio || 1)
};

function initializeSelects(): void {
  for (const [voice, description] of VOICES) {
    const option = document.createElement("option");
    option.value = voice;
    option.textContent = `${voice} — ${description}`;
    elements.voiceSelect.append(option);
  }

  for (const language of LANGUAGES) {
    const option = document.createElement("option");
    option.value = language;
    option.textContent = language;
    elements.languageSelect.append(option);
  }
}

function setActiveTab(tabName: "chat" | "history" | "settings"): void {
  if (!state.apiConfigured && tabName !== "chat") {
    tabName = "chat";
  }
  if (tabName !== "history" && state.bulkDeleteMode) {
    setBulkDeleteMode(false);
  }
  elements.chatPanel.classList.toggle("is-active", tabName === "chat");
  elements.historyPanel.classList.toggle("is-active", tabName === "history");
  elements.settingsPanel.classList.toggle("is-active", tabName === "settings");

  if (tabName === "chat") {
    scrollTranscriptToBottom("auto");
  }
}

function setStatus(
  label: string,
  tone: "idle" | "live" | "busy" | "error" = "idle"
): void {
  elements.statusLabel.textContent = label;
  elements.statusDot.dataset["tone"] = tone;
}

function pushDebugLog(message: string): void {
  const time = new Date().toLocaleTimeString();
  state.debugEntries.push({ time, message });
  if (state.debugEntries.length > MAX_DEBUG_ENTRIES) {
    state.debugEntries.shift();
    elements.debugEntries.firstElementChild?.remove();
  }

  const entry = document.createElement("div");
  entry.className = "debug-entry";
  const timeSpan = document.createElement("span");
  timeSpan.className = "debug-entry-time";
  timeSpan.textContent = time;
  const msgSpan = document.createElement("span");
  msgSpan.className = "debug-entry-msg";
  msgSpan.textContent = message;
  entry.append(timeSpan, msgSpan);
  elements.debugEntries.append(entry);
  elements.debugEntries.scrollTop = elements.debugEntries.scrollHeight;

  elements.debugBadge.textContent = String(state.debugEntries.length);
  elements.debugBadge.classList.remove("hidden");
}

function showError(message: string): void {
  elements.errorBox.textContent = message;
  elements.errorBox.classList.remove("hidden");
  pushDebugLog(message);
}

function clearError(): void {
  elements.errorBox.textContent = "";
  elements.errorBox.classList.add("hidden");
}

function updateApiStatus(configured: boolean): void {
  state.apiConfigured = configured;
  elements.chatPanel.classList.remove("api-key-checking");
  elements.apiCheckingCard.classList.add("hidden");
  elements.chatPanel.classList.toggle("api-key-required", !configured);
  elements.apiRequiredCard.classList.toggle("hidden", configured);
  elements.apiStatusDot.classList.toggle("is-configured", configured);
  elements.apiStatusText.textContent = configured
    ? "Configured securely"
    : "Not configured";
  elements.apiKeyField.classList.toggle("hidden", configured);
  elements.saveApiButton.classList.toggle("hidden", configured);
  elements.removeApiButton.classList.toggle("hidden", !configured);
  if (!configured) {
    setActiveTab("chat");
  }
}

function submitApiKey(
  input: HTMLInputElement,
  feedback: HTMLElement
): void {
  const apiKey = input.value.trim();
  if (!apiKey) {
    feedback.textContent = "Enter a Gemini API key before saving.";
    feedback.classList.remove("hidden");
    input.focus();
    return;
  }

  feedback.classList.add("hidden");
  vscode.postMessage({ type: "saveApiKey", value: apiKey });
}

function updateThinkingLevelVisibility(): void {
  const isExtended =
    elements.modelSelect.value === "gemini-3.8-live-extended-thinking";
  elements.thinkingLevelField.classList.toggle("hidden", !isExtended);
  const minimal = elements.thinkingLevelSelect.querySelector<HTMLOptionElement>('option[value="minimal"]');
  if (minimal) minimal.disabled = isExtended;
  if (isExtended && elements.thinkingLevelSelect.value === "minimal") elements.thinkingLevelSelect.value = "low";
}

function applyPreferences(preferences: Preferences): void {
  state.preferences = preferences;
  if (!state.sessionReady && !state.isConnecting && preferences.liveModel) state.sessionModel = preferences.liveModel;
  elements.voiceSelect.value = preferences.voice;
  elements.languageSelect.value = preferences.preferredLanguage;
  if (preferences.liveModel) {
    elements.modelSelect.value = preferences.liveModel;
  }
  if (preferences.thinkingLevel) {
    elements.thinkingLevelSelect.value = preferences.thinkingLevel;
  }
  updateThinkingLevelVisibility();
  elements.behaviorSelect.value = preferences.behavior;
  elements.autoInterruptInput.checked = preferences.autoInterrupt;
}

function updateSelection(selection: ContextSummary | undefined): void {
  state.selection = selection;
  elements.selectionBar.classList.toggle("hidden", !selection);
  elements.selectionLabel.textContent = selection?.label ?? "";
}

function updateCurrentPage(currentPage: CurrentPageSummary | undefined): void {
  const pageChanged = state.currentPage?.uri !== currentPage?.uri;
  state.currentPage = currentPage;
  elements.currentPageMention.disabled = !currentPage;
  elements.currentPageMentionLabel.textContent =
    currentPage?.relativePath ?? "No editor file is open";
  if (pageChanged && state.attachedCurrentPage) {
    state.attachedCurrentPage = false;
  }
  renderCurrentPageAttachment();
  updateMentionMenu();
}

function renderCurrentPageAttachment(): void {
  const visible = state.attachedCurrentPage && Boolean(state.currentPage);
  elements.currentPageBar.classList.toggle("hidden", !visible);
  elements.currentPageLabel.textContent = visible
    ? (state.currentPage?.relativePath ?? "")
    : "";
  updateControls();
}

function updateAttachments(
  attachments: readonly AttachmentSummary[] | undefined
): void {
  state.attachments = attachments ?? [];
  const chips = state.attachments.map((attachment) => {
    const chip = document.createElement("span");
    chip.className = "attachment-chip";

    let prefix: HTMLElement;
    if (attachment.kind === "image" && attachment.dataUri) {
      const thumb = document.createElement("img");
      thumb.className = "attachment-thumb";
      thumb.src = attachment.dataUri;
      thumb.alt = "";
      prefix = thumb;
    } else {
      const kind = document.createElement("span");
      kind.className = "attachment-kind";
      kind.textContent =
        attachment.kind === "image"
          ? "▧"
          : attachment.kind === "document"
            ? "📄"
            : "</>";
      kind.setAttribute("aria-hidden", "true");
      prefix = kind;
    }

    const label = document.createElement("span");
    label.className = "attachment-label";
    label.textContent = attachment.label;
    label.title = attachment.label;

    const remove = document.createElement("button");
    remove.className = "attachment-remove";
    remove.type = "button";
    remove.title = `Remove ${attachment.label}`;
    remove.setAttribute("aria-label", remove.title);
    remove.innerHTML =
      '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.3 3.4 3.7 3.7 3.7-3.7.9.9L8.9 8l3.7 3.7-.9.9L8 8.9l-3.7 3.7-.9-.9L7.1 8 3.4 4.3l.9-.9z"/></svg>';
    remove.addEventListener("click", () => {
      vscode.postMessage({
        type: "removeAttachment",
        value: attachment.id
      });
    });

    chip.append(prefix, label, remove);
    return chip;
  });

  elements.attachmentList.replaceChildren(...chips);
  elements.attachmentList.classList.toggle("hidden", chips.length === 0);
  updateControls();
}

function setAttachmentMenu(open: boolean): void {
  elements.attachmentMenu.classList.toggle("hidden", !open);
  elements.attachmentButton.classList.toggle("is-active", open);
  elements.attachmentButton.setAttribute("aria-expanded", String(open));
}

function updateChatHistory(chats: readonly ChatSummary[] | undefined): void {
  state.chats = chats ?? [];
  const rows = state.chats.map((chat) => {
    const row = document.createElement("article");
    row.className = "chat-history-row";
    row.dataset["chatId"] = chat.id;

    let checkbox: HTMLInputElement | undefined;
    if (state.bulkDeleteMode) {
      row.classList.add("is-selecting");
      checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "chat-history-check";
      checkbox.checked = state.bulkDeleteSelected.has(chat.id);
      checkbox.setAttribute("aria-label", `Select ${chat.title}`);
      checkbox.addEventListener("change", () => {
        if (checkbox) {
          if (checkbox.checked) {
            state.bulkDeleteSelected.add(chat.id);
          } else {
            state.bulkDeleteSelected.delete(chat.id);
          }
          updateBulkDeleteState();
        }
      });
      row.addEventListener("click", (event) => {
        if (checkbox && !(event.target instanceof HTMLButtonElement)) {
          checkbox.checked = !checkbox.checked;
          checkbox.dispatchEvent(new Event("change"));
        }
      });
    }

    const copy = document.createElement("span");
    copy.className = "chat-history-copy";
    const title = document.createElement("strong");
    title.textContent = chat.title;
    title.title = chat.title;
    const metadata = document.createElement("small");
    const updated = new Date(chat.updatedAt);
    metadata.textContent = `${chat.messageCount} messages · ${updated.toLocaleString()}`;
    copy.append(title, metadata);

    const actions = document.createElement("span");
    actions.className = "chat-history-actions";
    const reuse = document.createElement("button");
    reuse.className = "code-action-button";
    reuse.type = "button";
    reuse.title = "Reuse chat";
    reuse.setAttribute("aria-label", `Reuse ${chat.title}`);
    reuse.innerHTML =
      '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2a6 6 0 1 1-5.64 3.95l1.13.41A4.8 4.8 0 1 0 8 3.2c-1.3 0-2.48.51-3.34 1.35L6.2 6.1H2V1.9l1.8 1.8A5.98 5.98 0 0 1 8 2z"/></svg>';
    reuse.addEventListener("click", () => {
      vscode.postMessage({ type: "loadChat", chatId: chat.id });
    });

    const remove = document.createElement("button");
    remove.className = "code-action-button danger-action";
    remove.type = "button";
    remove.title = "Delete chat";
    remove.setAttribute("aria-label", `Delete ${chat.title}`);
    remove.innerHTML =
      '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 2V1h5v1H14v1.2h-1.1L12.2 14H3.8L3.1 3.2H2V2h3.5zm-1.2 1.2.62 9.6h6.16l.62-9.6H4.3zM6 5h1.2v6H6V5zm2.8 0H10v6H8.8V5z"/></svg>';
    remove.addEventListener("click", () => {
      vscode.postMessage({ type: "deleteChat", chatId: chat.id });
    });

    actions.append(reuse, remove);
    if (checkbox) {
      row.append(checkbox);
    }
    row.append(copy, actions);
    return row;
  });

  elements.chatHistoryList.replaceChildren(...rows);
  elements.emptyHistory.classList.toggle("hidden", rows.length > 0);
  if (!rows.length) {
    elements.chatHistoryList.append(elements.emptyHistory);
  }
  updateBulkDeleteState();
}

function updateBulkDeleteState(): void {
  const selected = state.bulkDeleteSelected.size;
  elements.bulkDeleteCount.textContent = `${selected} selected`;
  elements.confirmBulkDeleteButton.disabled = selected === 0;
  const allSelected =
    state.chats.length > 0 &&
    state.chats.every((chat) => state.bulkDeleteSelected.has(chat.id));
  elements.selectAllChatsInput.checked = allSelected;
  elements.selectAllChatsInput.indeterminate =
    selected > 0 && !allSelected;
}

function setBulkDeleteMode(enabled: boolean): void {
  state.bulkDeleteMode = enabled;
  state.bulkDeleteSelected.clear();
  elements.bulkDeleteBar.classList.toggle("hidden", !enabled);
  elements.deleteChatsButton.classList.toggle("is-active", enabled);
  updateChatHistory(state.chats);
}

function updateMentionMenu(): void {
  const cursor = elements.textInput.selectionStart;
  const prefix = elements.textInput.value.slice(0, cursor);
  const match = /(^|\s)@([^\s@]*)$/u.exec(prefix);
  const query = match?.[2]?.toLowerCase() ?? "";
  const pageMatches = Boolean(
    state.currentPage &&
    match &&
    ("current".startsWith(query) ||
      state.currentPage.fileName.toLowerCase().includes(query))
  );

  if (!match || !pageMatches) {
    state.mentionRange = undefined;
    elements.mentionMenu.classList.add("hidden");
    return;
  }

  const leadingWhitespaceLength = match[1]?.length ?? 0;
  state.mentionRange = {
    start: cursor - match[0].length + leadingWhitespaceLength,
    end: cursor
  };
  elements.mentionMenu.classList.remove("hidden");
}

function attachCurrentPage(): void {
  const currentPage = state.currentPage;
  const mentionRange = state.mentionRange;
  if (!currentPage || !mentionRange) {
    return;
  }

  const value = elements.textInput.value;
  const nextValue =
    value.slice(0, mentionRange.start) + value.slice(mentionRange.end);
  elements.textInput.value = nextValue;
  elements.textInput.setSelectionRange(
    mentionRange.start,
    mentionRange.start
  );
  state.attachedCurrentPage = true;
  state.mentionRange = undefined;
  elements.mentionMenu.classList.add("hidden");
  renderCurrentPageAttachment();
  resizeComposer();
  elements.textInput.focus();
}

function scrollTranscriptToBottom(
  behavior: ScrollBehavior = "smooth"
): void {
  window.requestAnimationFrame(() => {
    if (!state.followTranscript) return;
    elements.transcript.scrollTo({
      behavior,
      top: elements.transcript.scrollHeight
    });
  });
}

function resizeComposer(): void {
  elements.textInput.style.height = "auto";
  elements.textInput.style.height = `${Math.min(
    elements.textInput.scrollHeight,
    120
  )}px`;
}

function updateControls(): void {
  elements.sessionButton.disabled = state.isConnecting;
  elements.sessionButton.textContent = state.isConnecting
    ? "Connecting…"
    : state.sessionReady
      ? "End live session"
      : "Start live session";
  elements.textInput.disabled = false;

  if (state.isProcessing) {
    elements.sendButton.disabled = false;
    elements.sendButton.className = "send-button is-stopping";
    elements.sendButton.title = "Stop response";
    elements.sendButton.setAttribute("aria-label", "Stop response");
    elements.sendButton.innerHTML = lucideIconSvg("square", 14);
  } else {
    elements.sendButton.className = "send-button";
    elements.sendButton.title = "Send";
    elements.sendButton.setAttribute("aria-label", "Send message");
    elements.sendButton.innerHTML =
      '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.2 2.4a.65.65 0 0 1 .72-.12l10.2 5.1a.7.7 0 0 1 0 1.24l-10.2 5.1A.65.65 0 0 1 2 13.08L3.1 9 8.3 8 3.1 7 2 2.92a.65.65 0 0 1 .2-.52z"/></svg>';
    const hasContent =
      Boolean(elements.textInput.value.trim()) ||
      state.attachments.length > 0 ||
      Boolean(state.attachedCurrentPage && state.currentPage);
    elements.sendButton.disabled =
      Boolean(state.pendingTextSubmission) || !hasContent;
  }

  // Show live-session controls only when the session is actively connected.
  elements.muteMicButton.hidden = !state.sessionReady;
  elements.speakerMuteButton.hidden = !state.sessionReady;
  elements.stopPlaybackButton.hidden = !state.sessionReady;
  elements.shareScreenButton.hidden = !state.sessionReady;
  updateShareScreenButton();
}

function updateControlIcons(): void {
  elements.muteMicButton.innerHTML = lucideIconSvg(
    state.micMuted ? "mic-off" : "mic"
  );
  elements.speakerMuteButton.innerHTML = lucideIconSvg(
    state.audioMuted ? "volume-x" : "volume-2"
  );
  elements.shareScreenButton.innerHTML = lucideIconSvg("cast");
  elements.stopPlaybackButton.innerHTML = lucideIconSvg("square");
}

function startTimer(): void {
  stopTimer();
  state.sessionStartedAt = Date.now();
  elements.sessionTimer.classList.remove("hidden");
  state.timer = window.setInterval(() => {
    const seconds = Math.floor((Date.now() - state.sessionStartedAt) / 1000);
    const minutesText = String(Math.floor(seconds / 60)).padStart(2, "0");
    const secondsText = String(seconds % 60).padStart(2, "0");
    elements.sessionTimer.textContent = `${minutesText}:${secondsText}`;
  }, 1000);
}

function stopTimer(): void {
  if (state.timer !== undefined) {
    window.clearInterval(state.timer);
  }
  state.timer = undefined;
  elements.sessionTimer.classList.add("hidden");
  elements.sessionTimer.textContent = "00:00";
}

function createContextBadge(
  label: string,
  title: string,
  marker = "</>",
  filePath?: string,
  iconName: LucideIconName = "file-text"
): HTMLElement {
  const badge = document.createElement("div");
  badge.className = "message-context";
  badge.dataset["marker"] = marker;
  badge.title = title;

  const icon = document.createElement("span");
  icon.className = "context-icon";
  icon.innerHTML = lucideIconSvg(iconName, 12);
  badge.append(icon);

  if (filePath) {
    const link = document.createElement("a");
    link.href = "#";
    link.textContent = label;
    link.style.color = "inherit";
    link.style.textDecoration = "none";
    link.addEventListener("click", (e) => {
      e.preventDefault();
      vscode.postMessage({ type: "openFile", data: filePath });
    });
    badge.append(link);
  } else {
    const text = document.createElement("span");
    text.textContent = label;
    badge.append(text);
  }

  return badge;
}

function createMessage(
  role: ChatRole,
  context?: ContextSummary,
  currentPage?: CurrentPageSummary,
  applyTargetId?: string,
  storedMessage?: ChatMessage
): TranscriptMessage {
  const wrapper = document.createElement("article");
  wrapper.className = `message ${role}`;

  const body = document.createElement("div");
  body.className = "message-body";
  const contextLabel = storedMessage?.contextLabel ?? context?.label;
  const currentPageLabel =
    storedMessage?.currentPageLabel ?? currentPage?.relativePath;
  if (contextLabel) {
    body.append(
      createContextBadge(contextLabel, "Selected editor context", "</>", context?.fileName)
    );
  }
  if (currentPageLabel) {
    body.append(
      createContextBadge(
        currentPageLabel,
        "Attached current file",
        "@",
        currentPage?.relativePath,
        "file-text"
      )
    );
  }

  const content = document.createElement("div");
  content.className = "message-content";
  body.append(content);
  wrapper.append(body);
  elements.transcript.append(wrapper);

  state.turns += 1;
  elements.emptyState.classList.add("hidden");
  elements.chatPanel.classList.add("has-transcript");
  scrollTranscriptToBottom();

  const message: TranscriptMessage = {
    id: storedMessage?.id ?? crypto.randomUUID(),
    role,
    wrapper,
    content,
    spokenText: storedMessage?.spokenText ?? "",
    visualText: storedMessage?.visualText ?? "",
    markdownBlocks: [...(storedMessage?.markdownBlocks ?? [])],
    closed: false,
    renderVersion: 0,
    renderBusy: false,
    renderQueued: false,
    applyTargetId,
    contextLabel,
    currentPageLabel
  };
  wrapper.setAttribute("data-message-id", message.id);
  state.chatMessages.push({
    id: message.id,
    role,
    spokenText: message.spokenText,
    visualText: message.visualText,
    markdownBlocks: [...message.markdownBlocks],
    createdAt: storedMessage?.createdAt ?? new Date().toISOString(),
    contextLabel,
    currentPageLabel
  });

  const footer = document.createElement("div");
  footer.className = "message-footer";

  const timeSpan = document.createElement("span");
  timeSpan.className = "message-time";
  const date = new Date(storedMessage?.createdAt ?? Date.now());
  timeSpan.textContent = date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit"
  });

  const actions = document.createElement("div");
  actions.className = "message-actions";

  if (role === "user") {
    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "message-action-button";
    copyButton.title = "Copy question";
    copyButton.setAttribute("aria-label", "Copy question");
    copyButton.innerHTML = lucideIconSvg("copy", 12);
    copyButton.addEventListener("click", () => {
      copyUserMessage(message, copyButton);
    });

    const regenerateButton = document.createElement("button");
    regenerateButton.type = "button";
    regenerateButton.className = "message-action-button";
    regenerateButton.title = "Regenerate a more detailed answer";
    regenerateButton.setAttribute(
      "aria-label",
      "Regenerate a more detailed answer"
    );
    regenerateButton.innerHTML = lucideIconSvg("refresh-cw", 12);
    regenerateButton.addEventListener("click", () => {
      regenerateUserMessage(message);
    });

    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = "message-action-button";
    editButton.title = "Edit question (fix speech transcription)";
    editButton.setAttribute(
      "aria-label",
      "Edit question (fix speech transcription)"
    );
    editButton.innerHTML = lucideIconSvg("pencil", 12);
    editButton.addEventListener("click", () => {
      beginEditUserMessage(message);
    });

    actions.append(copyButton, regenerateButton, editButton);
    footer.append(timeSpan, actions);
    wrapper.append(footer);
  } else {
    const respeakButton = document.createElement("button");
    respeakButton.type = "button";
    respeakButton.className = "message-action-button";
    respeakButton.title = "Read response aloud";
    respeakButton.setAttribute("aria-label", "Read response aloud");
    respeakButton.innerHTML = lucideIconSvg("volume-2", 12);
    respeakButton.addEventListener("click", () => {
      respeakModelMessage(message, respeakButton);
    });

    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "message-action-button";
    copyButton.title = "Copy response";
    copyButton.setAttribute("aria-label", "Copy response");
    copyButton.innerHTML = lucideIconSvg("copy", 12);
    copyButton.addEventListener("click", () => {
      copyModelMessage(message, copyButton);
    });

    const shareButton = document.createElement("button");
    shareButton.type = "button";
    shareButton.className = "message-action-button";
    shareButton.title = "Share response";
    shareButton.setAttribute("aria-label", "Share response");
    shareButton.innerHTML = lucideIconSvg("share-2", 12);
    shareButton.addEventListener("click", () => {
      shareModelMessage(message, shareButton);
    });

    actions.append(respeakButton, copyButton, shareButton);
    footer.append(timeSpan, actions);
    body.append(footer);
  }

  return message;
}

function copyUserMessage(
  message: TranscriptMessage,
  button: HTMLButtonElement
): void {
  const text = message.spokenText.trim();
  if (!text) {
    return;
  }
  // Reuse the host clipboard path used by code-action buttons.
  vscode.postMessage({ type: "copyCode", code: text });
  button.innerHTML = lucideIconSvg("check", 12);
  button.title = "Copied";
  button.setAttribute("aria-label", "Copied");
  window.setTimeout(() => {
    button.innerHTML = lucideIconSvg("copy", 12);
    button.title = "Copy question";
    button.setAttribute("aria-label", "Copy question");
  }, 1_200);
}

function getModelMessageFullText(message: TranscriptMessage): string {
  const parts: string[] = [];
  if (message.visualText.trim()) {
    parts.push(message.visualText.trim());
  }
  for (const block of message.markdownBlocks) {
    if (block.markdown.trim()) {
      parts.push(block.markdown.trim());
    }
  }
  if (!parts.length && message.spokenText.trim()) {
    parts.push(message.spokenText.trim());
  }
  return parts.join("\n\n");
}

function copyModelMessage(
  message: TranscriptMessage,
  button: HTMLButtonElement
): void {
  const text = getModelMessageFullText(message);
  if (!text) {
    return;
  }
  vscode.postMessage({ type: "copyCode", code: text });
  button.innerHTML = lucideIconSvg("check", 12);
  button.title = "Copied";
  button.setAttribute("aria-label", "Copied");
  window.setTimeout(() => {
    button.innerHTML = lucideIconSvg("copy", 12);
    button.title = "Copy response";
    button.setAttribute("aria-label", "Copy response");
  }, 1_200);
}

function shareModelMessage(
  message: TranscriptMessage,
  button: HTMLButtonElement
): void {
  const text = getModelMessageFullText(message);
  if (!text) {
    return;
  }

  // Forward to host extension to present system sharing options (Mail client, New Tab, Save File, Copy)
  vscode.postMessage({ type: "shareResponse", value: text });

  button.innerHTML = lucideIconSvg("check", 12);
  button.title = "Share options opened";
  button.setAttribute("aria-label", "Share options opened");
  window.setTimeout(() => {
    button.innerHTML = lucideIconSvg("share-2", 12);
    button.title = "Share response";
    button.setAttribute("aria-label", "Share response");
  }, 1_200);
}

function resetRespeakButton(): void {
  if (state.activeRespeakButton) {
    state.activeRespeakButton.classList.remove("is-speaking");
    state.activeRespeakButton.innerHTML = lucideIconSvg("volume-2", 12);
    state.activeRespeakButton.title = "Read response aloud";
    state.activeRespeakButton.setAttribute("aria-label", "Read response aloud");
    state.activeRespeakButton = null;
  }
}

function respeakModelMessage(
  message: TranscriptMessage,
  button: HTMLButtonElement
): void {
  if (state.isRespeaking && state.activeRespeakButton === button) {
    state.respeakCancelled = true;
    state.pendingRespeak = undefined;
    stopPlayback();
    state.suppressNextResponse = true;
    state.isRespeaking = false;
    resetRespeakButton();
    hideActivityIndicator();
    vscode.postMessage({ type: "interruptTurn" });
    setStatus(
      state.audioMuted ? "Voice muted" : "Listening",
      state.audioMuted ? "idle" : "live"
    );
    return;
  }

  if (
    state.isProcessing ||
    state.playbackSources.size > 0 ||
    state.isRespeaking
  ) {
    stopPlayback();
    vscode.postMessage({ type: "interruptTurn" });
  }

  resetRespeakButton();

  const text =
    message.spokenText.trim() ||
    stripMarkdownForSpeech(getModelMessageFullText(message));
  if (!text) {
    return;
  }

  if (!state.apiConfigured) {
    setActiveTab("chat");
    elements.setupApiKeyInput.focus();
    return;
  }

  state.isRespeaking = true;
  state.respeakCancelled = false;
  state.respeakTurnComplete = false;
  state.activeRespeakText = text;
  state.suppressRespeakTranscript = true;
  state.activeRespeakButton = button;
  state.suppressNextResponse = false;
  button.classList.add("is-speaking");
  button.innerHTML = lucideIconSvg("volume-x", 12);
  button.title = "Stop reading aloud";
  button.setAttribute("aria-label", "Stop reading aloud");

  if (!state.sessionReady) {
    state.pendingRespeak = text;
    void beginSession();
    return;
  }

  vscode.postMessage({
    type: "respeakMessage",
    text
  });
}

function regenerateUserMessage(message: TranscriptMessage): void {
  const question = message.spokenText.trim();
  if (!question) {
    return;
  }

  if (state.isProcessing) stopActiveTurn();
  finalizeModelMessage();
  state.suppressNextResponse = false;
  state.respeakCancelled = false;
  state.activeRespeakText = "";
  state.suppressRespeakTranscript = false;
  clearError();
  const requestId = crypto.randomUUID();
  const chatId = ensureActiveChat(question);
  const value =
    "The user wants a more detailed and better answer to their previous question. " +
    `Previous question: ${question}`;

  startProcessing(false, false);

  if (state.sessionReady) {
    void dispatchTextSubmission({
      requestId,
      chatId,
      text: value,
      includeCurrentPage: false,
      currentPageUri: undefined,
      attachmentIds: [],
      fromEdit: true
    });
    return;
  }

  state.pendingTextSubmission = {
    requestId,
    text: value,
    chatId,
    includeCurrentPage: false,
    currentPageUri: undefined,
    attachmentIds: [],
    fromEdit: true
  };
  updateControls();
  void beginSession();
}

function appendTranscript(
  role: ChatRole,
  text: string,
  context?: ContextSummary,
  currentPage?: CurrentPageSummary
): void {
  if (role === "user") {
    let message = state.currentUserMessage;

    if (!message || message.closed) {
      message = createMessage(role, context, currentPage);
      state.currentUserMessage = message;
    }

    if (text) {
      message.spokenText = mergeSpokenText(message.spokenText, text);
      const storedIndex = state.chatMessages.findIndex(
        (candidate) => candidate.id === message.id
      );
      if (storedIndex >= 0) {
        const existing = state.chatMessages[storedIndex];
        if (existing) {
          state.chatMessages[storedIndex] = {
            ...existing,
            spokenText: message.spokenText
          };
        }
      }
      message.content.textContent = message.spokenText;
    }
    scheduleChatSave();
    scrollTranscriptToBottom("auto");
  }
}

function beginEditUserMessage(message: TranscriptMessage): void {
  if (message.role !== "user" || state.editingUserMessageId === message.id) {
    return;
  }

  const content = message.content;
  const originalText = message.spokenText;

  const editor = document.createElement("div");
  editor.className = "message-editor";

  const row = document.createElement("div");
  row.className = "message-edit-row";

  const textarea = document.createElement("textarea");
  textarea.className = "message-edit-input";
  textarea.value = originalText;
  textarea.spellcheck = false;
  textarea.rows = 2;
  textarea.setAttribute("aria-label", "Edit your question");

  const sendButton = document.createElement("button");
  sendButton.type = "button";
  sendButton.className = "message-edit-send";
  sendButton.title = "Send corrected question";
  sendButton.setAttribute("aria-label", "Send corrected question");
  sendButton.innerHTML = lucideIconSvg("send", 14);

  const cancelEdit = (): void => {
    content.replaceChildren(document.createTextNode(originalText));
    message.wrapper.classList.remove("is-editing");
    state.editingUserMessageId = undefined;
  };

  const sendEdit = (): void => {
    const corrected = textarea.value.trim();
    if (!corrected) {
      return;
    }
    message.spokenText = corrected;
    content.replaceChildren(document.createTextNode(corrected));
    message.wrapper.classList.remove("is-editing");
    state.editingUserMessageId = undefined;

    const storedIndex = state.chatMessages.findIndex(
      (candidate) => candidate.id === message.id
    );
    if (storedIndex >= 0) {
      const existing = state.chatMessages[storedIndex];
      if (existing) {
        state.chatMessages[storedIndex] = {
          ...existing,
          spokenText: corrected
        };
      }
    }
    scheduleChatSave();
    sendCorrectedQuestion(corrected);
  };

  sendButton.addEventListener("click", sendEdit);
  textarea.addEventListener("keydown", (event) => {
    if (event.isComposing) {
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendEdit();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancelEdit();
    }
  });
  textarea.addEventListener("blur", () => {
    // Esc handled inside the keydown handler; a click on the send button
    // first blurs the textarea — defer so the click can fire first.
    window.setTimeout(() => {
      if (state.editingUserMessageId === message.id && document.activeElement !== sendButton) {
        cancelEdit();
      }
    }, 120);
  });

  row.append(textarea, sendButton);
  editor.append(row);

  state.editingUserMessageId = message.id;
  content.replaceChildren(editor);
  message.wrapper.classList.add("is-editing");
  textarea.focus();
  // Place cursor at the end so the user can append corrections.
  textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
}

function sendCorrectedQuestion(text: string): void {
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }

  if (state.isProcessing) stopActiveTurn();
  finalizeModelMessage();
  state.suppressNextResponse = false;
  state.respeakCancelled = false;
  state.activeRespeakText = "";
  state.suppressRespeakTranscript = false;
  clearError();
  const requestId = crypto.randomUUID();
  const chatId = ensureActiveChat(trimmed);

  startProcessing(false, false);

  if (state.sessionReady) {
    void dispatchTextSubmission({
      requestId,
      chatId,
      text: trimmed,
      includeCurrentPage: false,
      currentPageUri: undefined,
      attachmentIds: [],
      fromEdit: true
    });
    return;
  }

  state.pendingTextSubmission = {
    requestId,
    text: trimmed,
    chatId,
    includeCurrentPage: false,
    currentPageUri: undefined,
    attachmentIds: [],
    fromEdit: true
  };
  updateControls();
  void beginSession();
}

function appendSpokenTranscript(text: string): void {
  if (!text) {
    return;
  }

  let message = state.currentModelMessage;

  if (!message || message.closed) {
    message = createMessage(
      "model",
      undefined,
      undefined,
      state.pendingModelApplyTargetId
    );
    state.currentModelMessage = message;
    state.pendingModelApplyTargetId = undefined;
  }

  message.spokenText = mergeSpokenText(
    message.spokenText,
    text
  );

  // Update the stored chat message text.
  const storedIndex = state.chatMessages.findIndex(
    (candidate) => candidate.id === message.id
  );
  if (storedIndex >= 0) {
    const existing = state.chatMessages[storedIndex];
    if (existing) {
      state.chatMessages[storedIndex] = {
        ...existing,
        spokenText: message.spokenText
      };
    }
  }

  void renderModelMessage(message);
  scheduleChatSave();
  scrollTranscriptToBottom("auto");
}

function appendVisualText(text: string): void {
  if (!text) {
    return;
  }

  let message = state.currentModelMessage;

  if (!message || message.closed) {
    message = createMessage(
      "model",
      undefined,
      undefined,
      state.pendingModelApplyTargetId
    );
    state.currentModelMessage = message;
    state.pendingModelApplyTargetId = undefined;
  }

  message.visualText = mergeVisualText(
    message.visualText,
    text
  );

  const storedIndex = state.chatMessages.findIndex(
    (candidate) => candidate.id === message.id
  );
  if (storedIndex >= 0) {
    const existing = state.chatMessages[storedIndex];
    if (existing) {
      state.chatMessages[storedIndex] = {
        ...existing,
        visualText: message.visualText
      };
    }
  }

  void renderModelMessage(message);
  scheduleChatSave();
  scrollTranscriptToBottom("auto");
}

function appendMarkdownBlock(
  markdown: string,
  functionCallId?: string
): "added" | "duplicate" | "invalid" {
  const normalizedMarkdown = normalizeMarkdown(markdown);

  if (!normalizedMarkdown) {
    return "invalid";
  }

  let message = state.currentModelMessage;

  if (!message || message.closed) {
    message = createMessage(
      "model",
      undefined,
      undefined,
      state.pendingModelApplyTargetId
    );
    state.currentModelMessage = message;
    state.pendingModelApplyTargetId = undefined;
  }

  const alreadyExists = message.markdownBlocks.some(
    (block) =>
      (functionCallId && block.functionCallId === functionCallId) ||
      (
        hashMarkdown(block.markdown) ===
        hashMarkdown(normalizedMarkdown) &&
        normalizeMarkdown(block.markdown) === normalizedMarkdown
      )
  );

  const duplicatesVisualText =
    normalizeMarkdown(message.visualText) === normalizedMarkdown;

  if (alreadyExists || duplicatesVisualText) {
    return "duplicate";
  }

  message.markdownBlocks.push({
    id: crypto.randomUUID(),
    markdown: normalizedMarkdown,
    functionCallId
  });

  const storedIndex = state.chatMessages.findIndex(
    (candidate) => candidate.id === message.id
  );
  if (storedIndex >= 0) {
    const existing = state.chatMessages[storedIndex];
    if (existing) {
      state.chatMessages[storedIndex] = {
        ...existing,
        markdownBlocks: [...message.markdownBlocks]
      };
    }
  }

  void renderModelMessage(message);
  scheduleChatSave();
  scrollTranscriptToBottom("auto");
  return "added";
}

function fixHeadingFormatting(text: string): string {
  // Ensure a space after hash symbols for headings.
  // Converts ###text, ##text, #text to ### text, ## text, # text (and all other levels).
  return text.replace(/^(#{1,6})([^\s#])/gm, "$1 $2");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// File extensions the model commonly cites in answers. A token ending with one
// of these (e.g. `src/main.ts`) is treated as a clickable file reference.
const FILE_EXTENSIONS_SOURCE =
  "ts|tsx|mts|cts|js|jsx|mjs|cjs|py|pyw|json|jsonc|jsonl|md|markdown|" +
  "css|scss|sass|less|html|htm|vue|svelte|astro|go|rs|java|kt|kts|" +
  "cpp|c|cc|cxx|h|hpp|hh|cs|php|swift|sh|bash|zsh|fish|yml|yaml|toml|ini|" +
  "cfg|conf|sql|graphql|gql|ipynb|txt|xml|svg|dart|lua|jl|hs|fs|fsx|nim|" +
  "nix|proto|prisma|tf|env|lock|gradle|pl|r|ex|exs|mdx|qmd|bat";

const FILE_EXTENSION_PATTERN = new RegExp(
  `\\.(${FILE_EXTENSIONS_SOURCE})$`,
  "iu"
);

// Well-known files without a "regular" extension that the model may cite.
const SPECIAL_FILE_NAMES = new Set([
  "dockerfile",
  "makefile",
  "readme",
  "changelog",
  ".gitignore",
  ".env",
  ".npmrc",
  ".babelrc",
  ".eslintrc"
]);

// Well-known library / framework / technology names that end in extensions like .js
// but must NOT be treated as workspace file links.
const NON_FILE_NAMES = new Set([
  "node.js",
  "vue.js",
  "react.js",
  "next.js",
  "nuxt.js",
  "express.js",
  "three.js",
  "d3.js",
  "chart.js",
  "ember.js",
  "moment.js",
  "day.js",
  "anime.js",
  "redux.js",
  "backbone.js",
  "socket.io",
  "electron.js"
]);

const INLINE_CODE_PATTERN = /`([^`\n]+)`/gu;
const MARKDOWN_LINK_PATTERN = /\[([^[\]]+)\]\(([^()\s]+)\)/gu;
const BARE_URL_PATTERN = /(^|[\s([{'"<>;*_~])https?:\/\/[^\s<)"'`]+/giu;

// A workspace-relative path token (optional `:line` / `:line:col` suffix).
const FILE_TOKEN_PATTERN = new RegExp(
  String.raw`^([A-Za-z0-9_.@~-]+(?:/[A-Za-z0-9_.@~-]+)*)(?::(\d+)(?::(\d+))?)?$`,
  "iu"
);

// Detects a file reference inside a block of prose. Leading/trailing
// boundaries keep us from splitting longer tokens (URLs, code, semver...).
const FILE_REFERENCE_PATTERN = new RegExp(
  String.raw`(^|[^A-Za-z0-9_@~/. -])` +
  String.raw`((?:[A-Za-z0-9_.@~-]+/)*[A-Za-z0-9_.@~-]+)` +
  String.raw`(?::(\d+)(?::(\d+))?)?` +
  String.raw`(?=$|[^A-Za-z0-9_@~/-])`,
  "giu"
);

interface FileReference {
  readonly path: string;
  readonly display: string;
  readonly line?: number;
}

function matchFileReference(value: string): FileReference | undefined {
  const match = FILE_TOKEN_PATTERN.exec(value.trim());
  if (!match) {
    return undefined;
  }
  const rawPath = match[1] ?? "";
  const path = rawPath.replace(/\.+$/u, "");
  if (!path) {
    return undefined;
  }
  const line = match[2] ? Number(match[2]) : undefined;
  const basename = path.slice(path.lastIndexOf("/") + 1);
  if (NON_FILE_NAMES.has(basename.toLowerCase())) {
    return undefined;
  }
  if (
    !SPECIAL_FILE_NAMES.has(basename.toLowerCase()) &&
    !FILE_EXTENSION_PATTERN.test(basename)
  ) {
    return undefined;
  }
  return {
    path,
    display: line === undefined ? path : `${path}:${line}`,
    line
  };
}

const WEB_DOMAIN_TLDS =
  "org|com|net|io|dev|edu|gov|co|app|ai|me|info|tech|so|site|xyz|cloud|page";

const BARE_DOMAIN_PATTERN = new RegExp(
  "(^|[\\s([{'\"<>;*_~])((?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\\.)+(?:" +
  WEB_DOMAIN_TLDS +
  ")(?:/[^\\s<)\"'`]*))",
  "giu"
);

function normalizeSpokenUrls(text: string): string {
  return text
    .replace(/\bhttps?[\s:]+([a-zA-Z0-9-]+)[\s.]+([a-zA-Z0-9-]+)[\s.]+(org|com|net|io|dev|edu|gov)\b/giu, "https://$1.$2.$3")
    .replace(/\bhttps?[\s:]+([a-zA-Z0-9-]+)[\s.]+(org|com|net|io|dev|edu|gov)\b/giu, "https://$1.$2")
    .replace(/\b([a-zA-Z0-9-]+)\s+(?:dot|\.)\s+([a-zA-Z0-9-]+)\s+(?:dot|\.)\s+(org|com|net|io|dev|edu|gov)\b/giu, "$1.$2.$3")
    .replace(/\b([a-zA-Z0-9-]+)\s+(?:dot|\.)\s+(org|com|net|io|dev|edu|gov)\b/giu, "$1.$2");
}

const SPURIOUS_VOICE_UTTERANCES = new Set([
  "sí",
  "sí.",
  "si",
  "yes",
  "yeah",
  "yep",
  "ok",
  "okay",
  "um",
  "uh",
  "ah",
  "mm",
  "hmm",
  "hm",
  "huh",
  "ha",
  "oh"
]);

function isSpuriousVoiceInput(text: string): boolean {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[.,/#!$%^&*;:{}=\-_`~()?"'।]/gu, "")
    .trim();
  return SPURIOUS_VOICE_UTTERANCES.has(normalized);
}

function isActiveRespeakEcho(text: string): boolean {
  const normalize = (value: string): string =>
    value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const input = normalize(text);
  const respeak = normalize(state.activeRespeakText);
  return (
    input.length >= 12 &&
    respeak.length >= 12 &&
    (input.includes(respeak) || respeak.includes(input))
  );
}

function buildFileLinkHtml(
  path: string,
  label: string,
  line?: number
): string {
  const lineAttribute = line === undefined ? "" : ` data-line="${line}"`;
  return `<a href="#" class="file-link" data-path="${escapeHtml(path)}"${lineAttribute} title="${escapeHtml(path)}">${escapeHtml(label)}</a>`;
}

function buildExternalLinkHtml(url: string, label: string): string {
  const cleanUrl = url.trim();
  const href = /^https?:\/\//i.test(cleanUrl) ? cleanUrl : `https://${cleanUrl}`;
  return `<a href="${escapeHtml(href)}" class="external-link" target="_blank" rel="noreferrer" title="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
}

function buildMarkdownLinkHtml(label: string, url: string): string {
  const cleanLabel = label.replace(/^`+|`+$/gu, "").trim();
  if (/^(?:https?:|mailto:|tel:)/iu.test(url)) {
    // Always show the full URL as the visible text so links are transparent.
    return buildExternalLinkHtml(url, url);
  }
  if (/^vscode-file:/iu.test(url)) {
    return buildFileLinkHtml(
      url.replace(/^vscode-file:(?:\/\/)?[^/]*\/?/iu, ""),
      cleanLabel
    );
  }
  return buildFileLinkHtml(url.replace(/^\.\//u, ""), cleanLabel);
}

function renderInlineMarkdown(text: string): string {
  const replacements: string[] = [];

  const protect = (html: string): string => {
    const token = `\uE000${replacements.length}\uE001`;
    replacements.push(html);
    return token;
  };

  const restore = (html: string): string =>
    html.replace(
      /\uE000(\d+)\uE001/gu,
      (_, index: string) => replacements[Number(index)] ?? ""
    );

  let processed = normalizeSpokenUrls(text);

  // 1) Markdown links, [label](https://…), [label](src/main.ts), ...
  processed = processed.replace(
    MARKDOWN_LINK_PATTERN,
    (_, label: string, url: string) =>
      protect(buildMarkdownLinkHtml(label.trim(), url.trim()))
  );

  // 2) Bare http(s) URLs – render as clickable links.
  processed = processed.replace(
    BARE_URL_PATTERN,
    (match: string, prefix: string) => {
      const url = match.slice(prefix.length).replace(/[.,;:!?<>]+$/u, "");
      if (!url) {
        return match;
      }
      return prefix + protect(buildExternalLinkHtml(url, url));
    }
  );

  // 3) Bare domain URLs (e.g. docs.python.org, www.python.org, pypi.org/project/...)
  processed = processed.replace(
    BARE_DOMAIN_PATTERN,
    (match: string, prefix: string, domainUrl: string) => {
      const url = domainUrl.replace(/[.,;:!?<>]+$/u, "");
      if (!url || NON_FILE_NAMES.has(url.toLowerCase())) {
        return match;
      }
      return prefix + protect(buildExternalLinkHtml(url, url));
    }
  );

  // 4) Inline code spans – file references become links, everything else
  //    stays inline code.
  processed = processed.replace(INLINE_CODE_PATTERN, (_, code: string) => {
    const codeText = unescapeMarkdownPipes(code);
    const reference = matchFileReference(codeText);
    if (reference) {
      return protect(
        buildFileLinkHtml(reference.path, reference.display, reference.line)
      );
    }
    // If code span contains a web URL like `https://docs.python.org` or `docs.python.org`
    if (
      /^(?:https?:\/\/|(?:[a-zA-Z0-9-]+\.)+(?:org|com|net|io|dev|edu|gov))/i.test(
        codeText
      ) &&
      !NON_FILE_NAMES.has(codeText.toLowerCase())
    ) {
      return protect(buildExternalLinkHtml(codeText, codeText));
    }
    return protect(`<code>${escapeHtml(codeText)}</code>`);
  });

  // 5) File references in plain prose (main.ts, src/util/format.ts:12, ...).
  processed = processed.replace(
    FILE_REFERENCE_PATTERN,
    (match: string, prefix: string, token: string, line?: string) => {
      const reference = matchFileReference(token);
      if (!reference) {
        return match;
      }
      const lineNumber = line === undefined ? undefined : Number(line);
      return `${prefix}${protect(
        buildFileLinkHtml(
          reference.path,
          lineNumber === undefined ? reference.path : `${reference.path}:${lineNumber}`,
          lineNumber
        )
      )}`;
    }
  );

  let html = escapeHtml(unescapeMarkdownPipes(processed));
  html = html.replace(/\*\*([^*]+)\*\*/gu, "<strong>$1</strong>");
  return restore(html);
}

function renderMarkdownBlock(container: HTMLElement, text: string): void {
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }

  const fixed = fixHeadingFormatting(trimmed);
  const lines = fixed.split("\n");

  let inList = false;
  let listType: "ul" | "ol" | null = null;
  let listEl: HTMLElement | null = null;

  function closeList(): void {
    inList = false;
    listType = null;
    listEl = null;
  }

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx] as string;
    const trimmedLine = line.trim();

    // Empty line — close any open list.
    if (!trimmedLine) {
      if (inList) closeList();
      continue;
    }

    // Heading
    const headingMatch = trimmedLine.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      if (inList) closeList();
      const headingMarker = headingMatch[1] ?? "#";
      const headingText = headingMatch[2] ?? "";
      const h = document.createElement(`h${headingMarker.length}`);
      h.innerHTML = renderInlineMarkdown(headingText.trim());
      container.append(h);
      continue;
    }

    // Unordered list
    const ulMatch = trimmedLine.match(/^[-*]\s+(.+)$/);
    if (ulMatch) {
      if (!inList || listType !== "ul") {
        closeList();
        inList = true;
        listType = "ul";
        listEl = document.createElement("ul");
        container.append(listEl);
      }
      const li = document.createElement("li");
      li.innerHTML = renderInlineMarkdown((ulMatch[1] ?? "").trim());
      listEl?.append(li);
      continue;
    }

    // Ordered list
    const olMatch = trimmedLine.match(/^\d+\.\s+(.+)$/);
    if (olMatch) {
      if (!inList || listType !== "ol") {
        closeList();
        inList = true;
        listType = "ol";
        listEl = document.createElement("ol");
        container.append(listEl);
      }
      const li = document.createElement("li");
      li.innerHTML = renderInlineMarkdown((olMatch[1] ?? "").trim());
      listEl?.append(li);
      continue;
    }

    // Non-list / non-heading line — close any open list and emit a paragraph.
    if (inList) closeList();
    const p = document.createElement("p");
    p.innerHTML = renderInlineMarkdown(trimmedLine);
    container.append(p);
  }
}

function renderTableSegment(
  container: HTMLElement,
  segment: TableSegment
): void {
  const scrollWrapper = document.createElement("div");
  scrollWrapper.className = "response-table-scroll";

  const table = document.createElement("table");
  table.className = "response-table";

  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  for (const [columnIndex, cell] of segment.header.entries()) {
    const th = document.createElement("th");
    th.innerHTML = renderInlineMarkdown(cell);
    applyTableAlignment(th, segment.alignments[columnIndex]);
    headerRow.append(th);
  }
  thead.append(headerRow);
  table.append(thead);

  if (segment.rows.length > 0) {
    const tbody = document.createElement("tbody");
    for (const row of segment.rows) {
      const tr = document.createElement("tr");
      for (const [columnIndex, cell] of row.entries()) {
        const td = document.createElement("td");
        td.innerHTML = renderInlineMarkdown(cell);
        applyTableAlignment(td, segment.alignments[columnIndex]);
        tr.append(td);
      }
      tbody.append(tr);
    }
    table.append(tbody);
  }

  scrollWrapper.append(table);
  container.append(scrollWrapper);
}

function applyTableAlignment(
  cell: HTMLTableCellElement,
  alignment: TableAlignment
): void {
  if (alignment) {
    cell.style.textAlign = alignment;
  }
}

function sanitizeSourceLocationText(text: string): string {
  return text
    .replace(
      /\b(Looking at lines? \d+(?:\s*[-–]\s*\d+)?)\s+(?:of|in)\s+`[^`]+`/giu,
      "$1"
    )
    .replace(
      /\b(Looking at lines? \d+(?:\s*[-–]\s*\d+)?)\s+(?:of|in)\s+(?:the\s+file\s+)?(?:[A-Za-z]:)?[^\s,.;]*[\\/][^\s,.;]+/giu,
      "$1"
    )
    .replace(
      /\b(?:In|Within)\s+`[^`]+`,?\s+(looking at lines? \d+(?:\s*[-–]\s*\d+)?)/giu,
      (_, location: string) =>
        `${location.charAt(0).toUpperCase()}${location.slice(1)}`
    );
}

function normalizedLanguage(language: string): string {
  const aliases: Readonly<Record<string, string>> = {
    csharp: "csharp",
    cs: "csharp",
    html: "html",
    js: "javascript",
    jsx: "jsx",
    md: "markdown",
    py: "python",
    sh: "bash",
    shell: "bash",
    shellscript: "bash",
    ts: "typescript",
    tsx: "tsx",
    yml: "yaml"
  };
  return aliases[language.toLowerCase()] ?? language.toLowerCase();
}

function renderSvgDiagram(svgText: string): HTMLElement | null {
  try {
    const start = svgText.search(/<svg[\s>]/i);
    const end = svgText.toLowerCase().lastIndexOf("</svg>");
    if (start === -1 || end === -1 || end < start) {
      return null;
    }
    const rawSvg = svgText.slice(start, end + 6);

    const parser = new DOMParser();
    let svgEl: Element | null = null;

    try {
      const xmlDoc = parser.parseFromString(rawSvg, "image/svg+xml");
      if (!xmlDoc.querySelector("parsererror")) {
        svgEl = xmlDoc.querySelector("svg");
      }
    } catch {
      // Ignore XML parsing error and fall back to HTML5 parsing
    }

    if (!svgEl) {
      const cleanSvg = rawSvg
        .replace(/<br\s*\/?>/gi, "<br/>")
        .replace(/&(?!(?:[a-zA-Z0-9]+|#\d+|#x[0-9a-fA-F]+);)/g, "&amp;");
      try {
        const htmlDoc = parser.parseFromString(cleanSvg, "text/html");
        svgEl = htmlDoc.querySelector("svg");
      } catch {
        // Ignore HTML5 parsing error
      }
    }

    if (!svgEl) {
      return null;
    }

    if (!svgEl.getAttribute("xmlns")) {
      svgEl.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    }

    if (!svgEl.getAttribute("viewBox")) {
      const widthAttr = svgEl.getAttribute("width");
      const heightAttr = svgEl.getAttribute("height");
      const widthNum = widthAttr ? parseFloat(widthAttr) : NaN;
      const heightNum = heightAttr ? parseFloat(heightAttr) : NaN;
      if (
        !Number.isNaN(widthNum) &&
        !Number.isNaN(heightNum) &&
        widthNum > 0 &&
        heightNum > 0
      ) {
        svgEl.setAttribute("viewBox", `0 0 ${widthNum} ${heightNum}`);
      } else {
        svgEl.setAttribute("viewBox", "0 0 800 500");
      }
    }

    svgEl.setAttribute("width", "100%");
    svgEl.setAttribute("height", "auto");
    svgEl.classList.add("rendered-svg-diagram");

    svgEl.querySelectorAll("script").forEach((el) => el.remove());

    const container = document.createElement("div");
    container.className = "svg-diagram-preview";
    container.append(document.importNode(svgEl, true));
    return container;
  } catch {
    return null;
  }
}

async function renderStandardCodeBlock(
  container: HTMLElement,
  languageLabel: string,
  codeText: string,
  applyTargetId: string | undefined,
  closed = true
): Promise<void> {
  const block = document.createElement("section");
  block.className = "code-block";
  block.dataset["complete"] = String(closed);

  const header = document.createElement("div");
  header.className = "code-header";
  const language = document.createElement("span");
  language.textContent = languageLabel || "code";
  const actions = document.createElement("span");
  actions.className = "code-actions";
  actions.append(createCodeActionButton("copy", codeText));
  actions.append(
    createCodeActionButton("apply", codeText, applyTargetId)
  );
  header.append(language, actions);

  try {
    const highlighter = await highlighterPromise;
    const requestedLanguage = normalizedLanguage(languageLabel);
    const language = highlighter
      .getLoadedLanguages()
      .includes(requestedLanguage)
      ? requestedLanguage
      : "text";
    const highlightedHtml = highlighter.codeToHtml(codeText, {
      lang: language,
      themes: {
        light: "light-plus",
        dark: "dark-plus"
      },
      defaultColor: false
    });
    const template = document.createElement("template");
    template.innerHTML = highlightedHtml;
    const pre = template.content.querySelector("pre");
    if (pre) {
      pre.classList.add("gemini-x-shiki");
      block.append(header, pre);
      container.append(block);
      return;
    }
  } catch (error) {
    pushDebugLog(
      `Shiki failed for '${languageLabel || "plain text"}'; using the visible fallback renderer (${error instanceof Error ? error.message : "unknown error"}).`
    );
  }

  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.textContent = codeText;
  block.dataset["renderer"] = "fallback";
  pre.append(code);
  block.append(header, pre);
  container.append(block);
}

async function appendCodeBlock(
  container: HTMLElement,
  languageLabel: string,
  codeText: string,
  applyTargetId: string | undefined,
  closed = true
): Promise<void> {
  const lang = languageLabel.trim().toLowerCase();
  const trimmedCode = codeText.trim();
  const isSvg =
    lang === "svg" ||
    lang === "diagram" ||
    lang === "flowchart" ||
    lang === "xml" ||
    lang === "html" ||
    (/<svg[\s>]/i.test(trimmedCode) && /<\/svg>/i.test(trimmedCode));

  if (isSvg) {
    const svgPreview = renderSvgDiagram(trimmedCode);
    if (svgPreview) {
      const card = document.createElement("section");
      card.className = "svg-diagram-card";

      const header = document.createElement("div");
      header.className = "svg-diagram-header";

      const title = document.createElement("span");
      title.className = "svg-diagram-title";
      title.textContent = "Diagram";

      const actions = document.createElement("span");
      actions.className = "code-actions";

      const toggleButton = document.createElement("button");
      toggleButton.className = "code-action-button";
      toggleButton.type = "button";
      toggleButton.title = "View raw SVG code";
      toggleButton.setAttribute("aria-label", "View raw SVG code");
      toggleButton.innerHTML = lucideIconSvg("pencil", 12);

      actions.append(toggleButton);
      actions.append(createCodeActionButton("copy", codeText));
      header.append(title, actions);

      card.append(header);
      card.append(svgPreview);

      const codeContainer = document.createElement("div");
      codeContainer.className = "svg-code-container hidden";
      card.append(codeContainer);

      let codeRendered = false;
      toggleButton.addEventListener("click", () => {
        const isHidden = codeContainer.classList.contains("hidden");
        if (isHidden && !codeRendered) {
          codeRendered = true;
          void renderStandardCodeBlock(
            codeContainer,
            "xml",
            codeText,
            applyTargetId,
            closed
          );
        }
        codeContainer.classList.toggle("hidden", !isHidden);
        svgPreview.classList.toggle("hidden", isHidden);
        toggleButton.title = isHidden
          ? "View Diagram Preview"
          : "View raw SVG code";
      });

      container.append(card);
      return;
    }
  }

  await renderStandardCodeBlock(
    container,
    languageLabel,
    codeText,
    applyTargetId,
    closed
  );
}

function createCodeActionButton(
  action: "copy" | "apply",
  codeText: string,
  targetId?: string
): HTMLButtonElement {
  const button = document.createElement("button");
  const actionId = crypto.randomUUID();
  button.className = "code-action-button";
  button.type = "button";
  button.dataset["action"] = action;
  button.dataset["available"] = String(
    true
  );
  button.dataset["actionId"] = actionId;
  button.title =
    action === "copy"
      ? "Copy code"
      : "Apply to the selected editor area";
  button.setAttribute("aria-label", button.title);
  button.innerHTML =
    action === "copy"
      ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 1.5h7.5A1.5 1.5 0 0 1 14 3v7.5a1.5 1.5 0 0 1-1.5 1.5H12V5.5A1.5 1.5 0 0 0 10.5 4H4v-1A1.5 1.5 0 0 1 5 1.5zM3.5 5h7A1.5 1.5 0 0 1 12 6.5v7A1.5 1.5 0 0 1 10.5 15h-7A1.5 1.5 0 0 1 2 13.5v-7A1.5 1.5 0 0 1 3.5 5zm0 1.25a.25.25 0 0 0-.25.25v7c0 .14.11.25.25.25h7c.14 0 .25-.11.25-.25v-7a.25.25 0 0 0-.25-.25h-7z"/></svg>'
      : '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 2h4v1.2H3.2v9.6H6V14H2V2zm12 0h-4v1.2h2.8v9.6H10V14h4V2zM7.4 4h1.2v4.1l1.5-1.5.85.85L8 10.4 5.05 7.45l.85-.85 1.5 1.5V4z"/></svg>';
  button.addEventListener("click", () => {
    button.disabled = true;
    vscode.postMessage({
      type: action === "copy" ? "copyCode" : "applyPatch",
      actionId,
      code: codeText,
      targetId
    });
  });
  return button;
}

async function appendMixedRichContent(
  container: HTMLElement,
  source: string,
  applyTargetId: string | undefined
): Promise<void> {
  const segments = parseRichContent(source);

  for (const segment of segments) {
    if (segment.type === "code") {
      await appendCodeBlock(
        container,
        segment.language,
        segment.code,
        applyTargetId,
        segment.closed
      );
      continue;
    }

    if (segment.type === "table") {
      renderTableSegment(container, segment);
      continue;
    }

    const text = sanitizeSourceLocationText(segment.text);
    if (!text.trim()) {
      continue;
    }
    const wrapper = document.createElement("div");
    wrapper.className = "rendered-text";
    renderMarkdownBlock(wrapper, text);
    if (wrapper.childNodes.length) {
      container.append(wrapper);
    }
  }
}

async function renderModelMessage(
  message: TranscriptMessage
): Promise<void> {
  await scheduleLatestRender(
    message,
    async () => {
      const rendered = document.createDocumentFragment();

      if (message.spokenText.trim()) {
        const spokenContainer = document.createElement("div");
        spokenContainer.className = "spoken-transcript";
        await appendMixedRichContent(
          spokenContainer,
          message.spokenText,
          message.applyTargetId
        );
        rendered.append(spokenContainer);
      }

      const seenMarkdown = new Set<string>();
      const normalizedSpokenText = normalizeMarkdown(message.spokenText);
      const richSources: {
        readonly source: string;
        readonly blockId?: string;
      }[] = [];
      const addRichSource = (source: string, blockId?: string): void => {
        const normalized = normalizeMarkdown(source);
        if (!normalized || normalized === normalizedSpokenText) {
          return;
        }
        const key = `${hashMarkdown(normalized)}:${normalized}`;
        if (seenMarkdown.has(key)) {
          return;
        }
        seenMarkdown.add(key);
        richSources.push({ source, blockId });
      };

      addRichSource(message.visualText);
      for (const block of message.markdownBlocks) {
        addRichSource(block.markdown, block.id);
      }

      for (const richSource of richSources) {
        const richContent = document.createElement("div");
        richContent.className = "message-rich-content";
        if (richSource.blockId) {
          richContent.dataset["blockId"] = richSource.blockId;
        }
        await appendMixedRichContent(
          richContent,
          richSource.source,
          message.applyTargetId
        );
        rendered.append(richContent);
      }

      return rendered;
    },
    (rendered, renderVersion) => {
      if (message.renderVersion !== renderVersion) {
        return;
      }
      message.content.replaceChildren(rendered);
      scrollTranscriptToBottom("auto");
    }
  );
}

function finishTranscriptTurn(): void {
  const userMessage = state.currentUserMessage;
  const modelMessage = state.currentModelMessage;

  if (userMessage) {
    userMessage.closed = true;
  }
  if (modelMessage) {
    modelMessage.closed = true;
    void renderModelMessage(modelMessage);
  }
  state.hasLiveTranscribeText = false;
  scheduleChatSave();
  scrollTranscriptToBottom();
}

function handleUserTranscriptChunk(text: string): void {
  if (!state.sessionReady || state.micMuted || state.isProcessing || !text.trim() || state.isRespeaking) {
    return;
  }
  state.hasLiveTranscribeText = true;
  state.respeakCancelled = false;
  state.suppressRespeakTranscript = false;
  state.suppressNextResponse = false;
  ensureActiveChat(text);
  finalizeModelMessage();
  appendTranscript("user", text, state.pendingVoiceContext);
  state.pendingVoiceContext = undefined;
}

function handleTranscriptCorrected(messageId: string, correctedText: string): void {
  const cleanText = correctedText.trim();
  if (!cleanText || state.editingUserMessageId === messageId) {
    return;
  }
  const current = state.currentUserMessage;
  if (current && current.id === messageId) {
    current.spokenText = cleanText;
    current.content.textContent = cleanText;
  }
  const storedIndex = state.chatMessages.findIndex(
    (candidate) => candidate.id === messageId
  );
  if (storedIndex >= 0) {
    const existing = state.chatMessages[storedIndex];
    if (existing) {
      state.chatMessages[storedIndex] = {
        ...existing,
        spokenText: cleanText
      };
    }
  }
  const el = elements.transcript.querySelector<HTMLElement>(
    `[data-message-id="${messageId}"] .message-content`
  );
  if (el) {
    el.textContent = cleanText;
  }
  scheduleChatSave();
}

function finalizeUserMessage(): void {
  if (state.currentUserMessage && !state.currentUserMessage.closed) {
    state.currentUserMessage.closed = true;
  }
}

function finalizeModelMessage(): void {
  if (state.currentModelMessage && !state.currentModelMessage.closed) {
    state.currentModelMessage.closed = true;
    void renderModelMessage(state.currentModelMessage);
  }
}

function resetTranscriptView(): void {
  state.followTranscript = true;
  if (state.isRespeaking) {
    state.isRespeaking = false;
    resetRespeakButton();
  }
  state.pendingRespeak = undefined;
  elements.transcript
    .querySelectorAll<HTMLElement>(".message, .activity-indicator")
    .forEach((message) => {
      message.remove();
    });
  state.currentModelMessage = undefined;
  state.currentUserMessage = undefined;
  state.pendingVoiceContext = undefined;
  state.hasLiveTranscribeText = false;
  state.suppressRespeakTranscript = false;
  state.pendingModelApplyTargetId = undefined;
  state.activeSearches = 0;
  state.analyzingImage = false;
  state.answering = false;
  state.reasoning = false;
  state.activityIndicator = null;
  state.chatMessages = [];
  state.turns = 0;
  state.suppressNextResponse = false;
  elements.emptyState.classList.remove("hidden");
  elements.chatPanel.classList.remove("has-transcript");
  scrollTranscriptToBottom("auto");
}

function deriveChatTitle(text: string): string {
  const compact = text.replace(/\s+/gu, " ").trim();
  return compact.length > 56 ? `${compact.slice(0, 53)}…` : compact;
}

function ensureActiveChat(firstMessage: string): string {
  if (state.activeChatId) {
    return state.activeChatId;
  }

  const now = new Date().toISOString();
  state.activeChatId = crypto.randomUUID();
  state.activeChatCreatedAt = now;
  state.activeChatTitle = deriveChatTitle(firstMessage) || "New chat";
  return state.activeChatId;
}

function scheduleChatSave(): void {
  if (
    state.restoringChat ||
    !state.activeChatId ||
    !state.activeChatCreatedAt ||
    !state.activeChatTitle ||
    !state.chatMessages.length
  ) {
    return;
  }

  if (state.saveChatTimer !== undefined) {
    window.clearTimeout(state.saveChatTimer);
  }
  state.saveChatTimer = window.setTimeout(() => {
    state.saveChatTimer = undefined;
    postActiveChat();
  }, 350);
}

function postActiveChat(): void {
  if (
    !state.activeChatId ||
    !state.activeChatCreatedAt ||
    !state.activeChatTitle ||
    !state.chatMessages.length
  ) {
    return;
  }

  vscode.postMessage({
    type: "saveChat",
    chat: {
      id: state.activeChatId,
      title: state.activeChatTitle,
      createdAt: state.activeChatCreatedAt,
      updatedAt: new Date().toISOString(),
      messages: state.chatMessages
    } satisfies StoredChat
  });
}

function startNewChat(): void {
  endSession();
  if (state.saveChatTimer !== undefined) {
    window.clearTimeout(state.saveChatTimer);
    state.saveChatTimer = undefined;
  }
  postActiveChat();
  resetTranscriptView();
  state.activeChatId = undefined;
  state.activeChatCreatedAt = undefined;
  state.activeChatTitle = undefined;
  state.pendingTextSubmission = undefined;
  updateControls();
  setActiveTab("chat");
  elements.textInput.focus();
}

function restoreChat(chat: StoredChat): void {
  if (state.saveChatTimer !== undefined) window.clearTimeout(state.saveChatTimer);
  state.saveChatTimer = undefined;
  postActiveChat();
  endSession();
  state.restoringChat = true;
  resetTranscriptView();
  state.activeChatId = chat.id;
  state.activeChatCreatedAt = chat.createdAt;
  state.activeChatTitle = chat.title;

  for (const storedMessage of chat.messages) {
    const message = createMessage(
      storedMessage.role,
      undefined,
      undefined,
      undefined,
      storedMessage
    );
    message.closed = true;
    if (storedMessage.role === "model") {
      void renderModelMessage(message);
    } else {
      message.content.textContent = storedMessage.spokenText;
    }
  }
  state.currentModelMessage = undefined;
  state.currentUserMessage = undefined;
  state.restoringChat = false;
  setActiveTab("chat");
  scrollTranscriptToBottom("auto");
  elements.textInput.focus();
}

function setActivityIndicator(icon: LucideIconName, label: string): void {
  let indicator = state.activityIndicator;
  if (!indicator) {
    indicator = document.createElement("div");
    indicator.className = "activity-indicator";
    indicator.setAttribute("role", "status");
    state.activityIndicator = indicator;
  }
  indicator.innerHTML = `${lucideIconSvg(icon)}<span class="activity-label"></span>`;
  const labelElement = indicator.querySelector<HTMLElement>(".activity-label");
  if (labelElement) {
    labelElement.textContent = label;
  }
  // Always move the indicator to the end of the transcript so it sits
  // directly below the most recent user message.
  elements.transcript.append(indicator);
  indicator.classList.add("visible");
  elements.emptyState.classList.add("hidden");
  elements.chatPanel.classList.add("has-transcript");
  scrollTranscriptToBottom();
}

function showActivitySearch(kind: "workspace" | "web" | "reading"): void {
  state.activeSearches += 1;
  if (kind === "reading") {
    setActivityIndicator("book-open", "Reading…");
  } else {
    setActivityIndicator(
      "search",
      kind === "web"
        ? "Searching the web…"
        : "Searching in the workspace…"
    );
  }
}

function completeActivitySearch(): void {
  state.activeSearches = Math.max(0, state.activeSearches - 1);
  if (state.activeSearches === 0) {
    if (state.analyzingImage) {
      setActivityIndicator("image", "Analyzing image source…");
    } else if (state.reasoning) {
      setActivityIndicator("brain", "Reasoning…");
    } else if (state.answering) {
      setActivityIndicator("volume-2", "Answering…");
    } else {
      setActivityIndicator("lightbulb", "Thinking…");
    }
  }
}

function hideActivityIndicator(): void {
  state.activeSearches = 0;
  state.analyzingImage = false;
  state.answering = false;
  state.reasoning = false;
  if (state.activityIndicator) {
    state.activityIndicator.classList.remove("visible");
  }
}

function unmuteMicIfAutoMuted(): void {
  if (state.micAutoMuted) {
    state.micAutoMuted = false;
    vscode.postMessage({ type: "muteMic", muted: state.userMicMutedState });
  }
}

function markAnswering(): void {
  if (state.analyzingImage) {
    state.analyzingImage = false;
    unmuteMicIfAutoMuted();
  }
  if (state.answering) {
    return;
  }
  state.answering = true;
  if (state.activeSearches === 0 && !state.reasoning) {
    setActivityIndicator("volume-2", "Answering…");
  }
}

function markReasoning(): void {
  if (state.analyzingImage) {
    state.analyzingImage = false;
    unmuteMicIfAutoMuted();
  }
  if (state.reasoning) {
    return;
  }
  state.reasoning = true;
  setActivityIndicator("brain", "Reasoning…");
}

function renderMessageAttachments(
  message: TranscriptMessage,
  displays: readonly AttachmentDisplay[]
): void {
  if (!displays.length) {
    return;
  }
  const container = document.createElement("div");
  container.className = "message-attachments";
  for (const display of displays) {
    if (display.kind === "image") {
      if (display.dataUri) {
        const image = document.createElement("img");
        image.className = "message-attachment-image";
        image.src = display.dataUri;
        image.alt = "Attached image preview";
        container.append(image);
      }
      continue;
    }

    const chip = document.createElement("span");
    chip.className = "message-attachment-chip";
    chip.title = display.label;
    const icon = document.createElement("span");
    icon.className = "message-attachment-chip-icon";
    icon.innerHTML =
      display.kind === "document"
        ? "📄"
        : lucideIconSvg("file-text", 12);
    const label = document.createElement("span");
    label.className = "message-attachment-chip-label";
    label.textContent = display.label;
    chip.append(icon, label);
    container.append(chip);
  }
  // Attachments appear above the typed text.
  message.content.prepend(container);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function stopPlayback(): void {
  if (state.isRespeaking) {
    state.isRespeaking = false;
    resetRespeakButton();
  }
  state.playbackSources.forEach((source) => {
    try {
      source.stop();
      source.disconnect();
    } catch {
      // The source may already have ended.
    }
  });
  state.playbackSources.clear();
  state.nextPlaybackTime = 0;
}

function queueOutputAudio(base64: string): void {
  const audioContext = state.audioContext;
  if (!audioContext || audioContext.state === "closed") {
    return;
  }

  const bytes = base64ToBytes(base64);
  const sampleCount = Math.floor(bytes.byteLength / 2);
  if (!sampleCount) {
    return;
  }

  const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, sampleCount);
  const audioBuffer = audioContext.createBuffer(
    1,
    sampleCount,
    OUTPUT_SAMPLE_RATE
  );
  const channel = audioBuffer.getChannelData(0);
  for (let index = 0; index < sampleCount; index += 1) {
    channel[index] = (pcm[index] ?? 0) / 32_768;
  }

  const source = audioContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(state.masterGain ?? audioContext.destination);

  const startAt = Math.max(
    state.nextPlaybackTime,
    audioContext.currentTime + 0.02
  );
  source.start(startAt);
  state.nextPlaybackTime = startAt + audioBuffer.duration;
  state.playbackSources.add(source);
  setStatus("Gemini is speaking", "busy");

  source.onended = () => {
    state.playbackSources.delete(source);
    source.disconnect();
    if (
      !state.playbackSources.size &&
      state.sessionReady &&
      !state.audioMuted
    ) {
      if (state.isRespeaking && state.respeakTurnComplete) {
        state.isRespeaking = false;
        resetRespeakButton();
        hideActivityIndicator();
      }
      setStatus("Listening", "live");
    }
  };
}

function createPlaybackPipeline(): void {
  const audioContext = state.audioContext;
  if (!audioContext) {
    return;
  }

  state.masterGain = audioContext.createGain();
  state.masterGain.gain.value = state.audioMuted ? 0 : 1;
  state.masterGain.connect(audioContext.destination);
  state.analyser = audioContext.createAnalyser();
  state.analyser.fftSize = 256;
  state.analyserData = new Uint8Array(state.analyser.fftSize);
  state.masterGain.connect(state.analyser);
}

function cleanupAudio(): void {
  stopPlayback();
  state.micLevel = 0;
  elements.micMeter.style.width = "0%";

  state.masterGain?.disconnect();
  if (state.audioContext?.state !== "closed") {
    void state.audioContext?.close();
  }

  state.analyser = undefined;
  state.analyserData = undefined;
  state.audioContext = undefined;
  state.masterGain = undefined;
}

async function beginSession(): Promise<void> {
  if (state.sessionReady || state.isConnecting) {
    return;
  }
  if (!state.apiConfigured) {
    setActiveTab("chat");
    elements.setupApiKeyInput.focus();
    return;
  }
  clearError();
  state.isConnecting = true;
  updateControls();
  setStatus("Requesting microphone", "busy");

  try {
    state.audioContext = new AudioContext();
    await state.audioContext.resume();
    createPlaybackPipeline();
    vscode.postMessage({ type: "startSession", voiceEnabled: !state.pendingTextSubmission && !state.pendingRespeak });
  } catch (error) {
    state.isConnecting = false;
    state.pendingTextSubmission = undefined;
    endProcessing();
    hideActivityIndicator();
    cleanupAudio();
    updateControls();
    setStatus("Could not start", "error");
    showError(
      error instanceof Error
        ? error.message
        : "Could not start the live session."
    );
  }
}

function startProcessing(hasImages: boolean, hasDocs: boolean): void {
  state.isProcessing = true;
  state.activeSearches = 0;
  state.answering = false;
  state.reasoning = false;
  state.analyzingImage = hasImages;

  // Keep background speech from interrupting during image analysis or submission.
  if (!state.micAutoMuted) {
    state.micAutoMuted = true;
    state.userMicMutedState = state.sessionReady ? state.micMuted : false;
  }
  if (!state.micMuted) vscode.postMessage({ type: "muteMic", muted: true });

  if (hasImages) {
    setActivityIndicator("image", "Analyzing image source…");
    setStatus("Analyzing image", "busy");
  } else if (hasDocs) {
    setActivityIndicator("book-open", "Analyzing attached files…");
    setStatus("Reading file", "busy");
  } else {
    setActivityIndicator("lightbulb", "Thinking…");
    setStatus("Thinking", "busy");
  }

  updateControls();
}

function endProcessing(): void {
  if (!state.isProcessing) {
    return;
  }
  state.isProcessing = false;
  state.analyzingImage = false;

  unmuteMicIfAutoMuted();
  updateControls();
}

function stopActiveTurn(): void {
  state.suppressNextResponse = true;
  state.pendingTextSubmission = undefined;
  state.activeTextRequestId = undefined;
  stopPlayback();
  finishTranscriptTurn();
  hideActivityIndicator();
  vscode.postMessage({ type: "interruptTurn" });
  endProcessing();
  if (state.isConnecting) endSession();
  else setStatus(state.sessionReady ? "Listening" : "Disconnected", state.sessionReady ? "live" : "idle");
}

async function dispatchTextSubmission(
  submission: PendingTextSubmission
): Promise<void> {
  state.activeTextRequestId = submission.requestId;
  state.submittedText = submission;
  state.pendingTextSubmission = undefined;
  const imageContexts: Record<string, string> = {};
  try {
    for (const attachment of submission.attachmentDisplays ?? []) {
      if (attachment.kind !== "image") continue;
      if (!attachment.dataUri) throw new Error(`The preview for ${attachment.label} is unavailable. Reattach the image.`);
      imageContexts[attachment.id] = await createLocalImageContext(attachment.dataUri);
    }
  } catch (error) {
    if (state.activeTextRequestId !== submission.requestId) return;
    handleHostMessage({ type: "textRejected", requestId: submission.requestId, message: error instanceof Error ? error.message : "Image could not be read." });
    return;
  }
  if (state.activeTextRequestId !== submission.requestId) return;
  vscode.postMessage({
    type: "sendText",
    imageContexts,
    requestId: submission.requestId,
    chatId: submission.chatId,
    value: submission.text,
    includeCurrentPage: submission.includeCurrentPage,
    currentPageUri: submission.currentPageUri,
    attachmentIds: submission.attachmentIds,
    fromEdit: submission.fromEdit
  });
  state.pendingTextSubmission = undefined;
  updateControls();
}

function submitTextMessage(): void {
  // If we are currently processing, clicking the send/stop button stops processing!
  if (state.isProcessing) {
    stopActiveTurn();
    return;
  }

  const text = elements.textInput.value.trim();
  const hasContent =
    Boolean(text) ||
    state.attachments.length > 0 ||
    Boolean(state.attachedCurrentPage && state.currentPage);

  if (!hasContent || state.pendingTextSubmission) {
    return;
  }
  state.respeakCancelled = false;
  state.activeRespeakText = "";
  state.suppressRespeakTranscript = false;
  if (!state.apiConfigured) {
    setActiveTab("chat");
    elements.setupApiKeyInput.focus();
    return;
  }

  const initialTitle =
    text || (state.attachments[0]?.label ?? "Attachment Query");

  const currentAttachments = [...state.attachments];
  const attachedCurrentPage = state.attachedCurrentPage;
  const currentPage = state.currentPage;
  const hasImages = currentAttachments.some((a) => a.kind === "image");
  const hasDocs = currentAttachments.some(
    (a) => a.kind === "document" || a.kind === "textFile"
  );

  const submission: PendingTextSubmission = {
    requestId: crypto.randomUUID(),
    text,
    chatId: ensureActiveChat(initialTitle),
    includeCurrentPage:
      attachedCurrentPage && Boolean(currentPage),
    currentPageUri: attachedCurrentPage
      ? currentPage?.uri
      : undefined,
    attachmentIds: currentAttachments.map((attachment) => attachment.id),
    attachmentDisplays: currentAttachments
  };

  state.followTranscript = true;
  // Append user message to transcript panel immediately
  appendTranscript(
    "user",
    text,
    state.selection,
    attachedCurrentPage && currentPage ? currentPage : undefined
  );

  // Render attachment chips / thumbnails immediately in the user bubble
  if (state.currentUserMessage) {
    const displayList: AttachmentDisplay[] = currentAttachments.map((att) => ({
      id: att.id,
      kind: att.kind,
      label: att.label,
      dataUri: att.dataUri
    }));
    renderMessageAttachments(state.currentUserMessage, displayList);
    state.currentUserMessage.closed = true;
  }

  if (state.currentModelMessage) {
    state.currentModelMessage.closed = true;
  }
  state.currentUserMessage = undefined;
  state.currentModelMessage = undefined;

  // Immediately clear the composer input & attachment UI
  elements.textInput.value = "";
  resizeComposer();
  state.attachments = [];
  state.attachedCurrentPage = false;
  elements.attachmentList.replaceChildren();
  elements.attachmentList.classList.add("hidden");
  renderCurrentPageAttachment();

  // Start processing state: change send button to stop button & auto-mute mic
  startProcessing(hasImages, hasDocs);

  // User submitted a text query — clear any suppression from a prior stop.
  state.suppressNextResponse = false;

  clearError();
  if (state.sessionReady) {
    void dispatchTextSubmission(submission);
    return;
  }

  state.pendingTextSubmission = submission;
  updateControls();
  void beginSession();
}

function endSession(): void {
  state.pendingTextSubmission = undefined;
  state.activeTextRequestId = undefined;
  finishTranscriptTurn();
  endProcessing();
  hideActivityIndicator();
  vscode.postMessage({ type: "stopSession" });
  state.isConnecting = false;
  state.sessionReady = false;
  state.suppressNextResponse = false;
  state.micMuted = false;
  if (state.isRespeaking) {
    state.isRespeaking = false;
    resetRespeakButton();
  }
  state.pendingRespeak = undefined;
  resetScreenSharing();
  elements.muteMicButton.classList.remove("is-muted");
  elements.muteMicButton.title = "Mute microphone";
  elements.muteMicButton.setAttribute("aria-label", "Mute microphone");
  stopTimer();
  cleanupAudio();
  updateControls();
  setStatus("Disconnected");
}

function isGeminiMessage(value: unknown): value is GeminiServerMessage {
  return typeof value === "object" && value !== null;
}

function handleServerMessage(payload: unknown): void {
  if (!state.sessionReady && !state.isConnecting) return;
  if (!isGeminiMessage(payload)) {
    showError("Gemini returned an unreadable message.");
    return;
  }

  if (payload.error) {
    endSession();
    showError(
      payload.error.message ??
      payload.error.status ??
      "Gemini returned an API error."
    );
    setStatus("API error", "error");
    return;
  }

  if (payload.setupComplete) {
    state.isConnecting = false;
    state.sessionReady = true;
    state.suppressNextResponse = false;
    state.handledFunctionCallIds.clear();
    startTimer();
    updateControls();
    setStatus("Listening", "live");
    if (state.pendingRespeak) {
      vscode.postMessage({
        type: "respeakMessage",
        text: state.pendingRespeak
      });
      state.pendingRespeak = undefined;
    }
    if (state.pendingTextSubmission) {
      void dispatchTextSubmission(state.pendingTextSubmission);
    }
    return;
  }

  const content = payload.serverContent;

  if (content) {
    // The server interrupted the previous turn (for example the user spoke
    // over Gemini or pressed Stop). Commit the partial turn so the next
    // question starts a fresh transcript bubble instead of merging into the
    // previous one.
    if (content.interrupted) {
      if (state.isRespeaking) {
        state.isRespeaking = false;
        resetRespeakButton();
      }
      finishTranscriptTurn();
      endProcessing();
    }

    // When the user speaks (voice input) after a stop, clear suppression.
    const userText = content.inputTranscription?.text;
    if (userText && isSpuriousVoiceInput(userText)) {
      state.suppressNextResponse = true;
      stopPlayback();
      vscode.postMessage({ type: "interruptTurn" });
    } else if (userText && isActiveRespeakEcho(userText)) {
      state.pendingVoiceContext = undefined;
    } else if (userText) {
      state.respeakCancelled = false;
      if (state.isRespeaking) {
        state.isRespeaking = false;
        resetRespeakButton();
      }
      state.activeRespeakText = "";
      state.suppressRespeakTranscript = false;
      state.suppressNextResponse = false;
      ensureActiveChat(userText);
      // A new spoken turn begins here — finalize any partial model answer
      // from the previous turn so its text does not bleed into this one.
      finalizeModelMessage();
      if (!state.hasLiveTranscribeText) {
        appendTranscript("user", userText, state.pendingVoiceContext);
      }
      state.pendingVoiceContext = undefined;
    }

    // Once the model starts replying, the user's utterance is complete:
    // freeze it so a later question cannot merge into it.
    if (
      content.outputTranscription ||
      (content.modelTurn?.parts?.length ?? 0) > 0
    ) {
      finalizeUserMessage();
    }

    // Spoken transcription — the authoritative live caption.
    const spokenText = content.outputTranscription?.text;
    if (spokenText) {
      // When in suppressed mode, skip this response entirely.
      if (!state.suppressNextResponse) {
        markAnswering();
        if (!state.suppressRespeakTranscript) {
          appendSpokenTranscript(spokenText);
        }
      }
    }

    for (const part of content.modelTurn?.parts ?? []) {
      // Internal reasoning/thought parts mean the model is working through
      // complex logic. Show a reasoning indicator and do not render the
      // thought text as visible content.
      if (part.thought === true) {
        markReasoning();
        continue;
      }
      if (
        part.inlineData?.data &&
        (part.inlineData.mimeType ?? "audio/pcm").startsWith("audio/pcm")
      ) {
        // Only queue audio if we are not suppressing this response.
        if (!state.suppressNextResponse && !state.respeakCancelled) {
          markAnswering();
          queueOutputAudio(part.inlineData.data);
        }
      }
      // Keep visual model text separate from audio transcription. Mixing
      // these streams breaks Markdown fences when their chunks interleave.
      if (part.text && !state.suppressNextResponse) {
        markAnswering();
        if (!state.suppressRespeakTranscript) {
          appendVisualText(part.text);
        }
      }
    }

    if (shouldInterruptPlayback(content)) {
      stopPlayback();
      endProcessing();
      setStatus("Listening", "live");
    }

  }

  if (payload.toolCall) handleToolCall(payload.toolCall);
  for (const id of payload.toolCallCancellation?.ids ?? []) state.handledFunctionCallIds.add(id);
  if (interactionStatus(payload) === "IN_PROGRESS" && !state.suppressNextResponse) {
    if (!state.isProcessing) startProcessing(false, false);
    markReasoning();
  }
  if (isInteractionComplete(payload, state.sessionModel) && !state.suppressNextResponse) {
      hideActivityIndicator();
      if (state.isRespeaking) {
        state.respeakTurnComplete = true;
        if (!state.playbackSources.size) {
          state.isRespeaking = false;
          resetRespeakButton();
        }
      } else {
        finishTranscriptTurn();
      }
      endProcessing();
      if (!state.playbackSources.size) {
        setStatus("Listening", "live");
      }
    }
}

function handleToolCall(toolCall: GeminiToolCall): void {
  for (const functionCall of toolCall.functionCalls ?? []) {
    const functionCallId = functionCall.id?.trim();
    const functionName = functionCall.name?.trim();

    if (functionName !== "render_markdown") {
      continue;
    }

    if (!functionCallId) {
      continue;
    }

    if (state.handledFunctionCallIds.has(functionCallId)) {
      continue;
    }
    state.handledFunctionCallIds.add(functionCallId);

    const markdown = functionCall.args?.["markdown"];
    const renderResult =
      !state.suppressNextResponse && typeof markdown === "string"
        ? appendMarkdownBlock(markdown, functionCallId)
        : "invalid";

    vscode.postMessage({
      type: "sendToolResponse",
      functionResponse: {
        id: functionCallId,
        name: functionName,
        response:
          renderResult === "invalid"
            ? {
              success: false,
              error: "The markdown argument must be a non-empty string."
            }
            : {
              success: true,
              duplicate: renderResult === "duplicate"
            }
      }
    });
  }
}

const SCREEN_SHARE_FONT =
  '13px "SF Mono", ui-monospace, Menlo, Consolas, "Courier New", monospace';

function updateShareScreenButton(): void {
  elements.shareScreenButton.classList.toggle(
    "is-active",
    state.screenSharing
  );
  elements.shareScreenButton.title = state.screenSharing
    ? "Stop sharing screen"
    : "Share screen with Gemini";
  elements.shareScreenButton.setAttribute(
    "aria-label",
    elements.shareScreenButton.title
  );
}

function resetScreenSharing(): void {
  state.screenSharing = false;
  state.lastRenderedScreenKey = "";
  updateShareScreenButton();
}

function truncateScreenText(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string {
  if (context.measureText(text).width <= maxWidth) {
    return text;
  }
  let result = text;
  while (
    result.length > 1 &&
    context.measureText(`${result}…`).width > maxWidth
  ) {
    result = result.slice(0, -1);
  }
  return `${result}…`;
}

async function renderScreenFrame(frame: ScreenFrame): Promise<void> {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }

  const frameKey = [
    frame.startLine,
    frame.endLine,
    frame.selectionStart ?? -1,
    frame.selectionEnd ?? -1,
    frame.fileName,
    frame.text.length
  ].join(":");
  if (frameKey === state.lastRenderedScreenKey) {
    return;
  }
  state.lastRenderedScreenKey = frameKey;

  context.font = SCREEN_SHARE_FONT;
  const charWidth = Math.max(6, context.measureText("M").width);
  const lineHeight = Math.round(charWidth * 1.85);
  const headerHeight = 30;
  const maxChars = 120;
  const maxLines = 120;
  const gutterWidth =
    8 + String(Math.max(frame.endLine, 1)).length * charWidth + 16;
  const rawLines = frame.text.replace(/\t/gu, "  ").split("\n");
  const shownLines = rawLines.slice(0, maxLines);
  const canvasWidth = Math.ceil(gutterWidth + maxChars * charWidth + 16);
  const canvasHeight = headerHeight + shownLines.length * lineHeight + 14;

  canvas.width = canvasWidth;
  canvas.height = canvasHeight;

  // Editor background.
  context.fillStyle = "#1e1e1e";
  context.fillRect(0, 0, canvasWidth, canvasHeight);

  // Header bar with the shared file and a live indicator.
  context.fillStyle = "#2b2b2b";
  context.fillRect(0, 0, canvasWidth, headerHeight);
  context.font =
    '12px "SF Mono", ui-monospace, Menlo, Consolas, "Courier New", monospace';
  context.textAlign = "left";
  const title = frame.fileName
    ? `${frame.fileName} — ${frame.relativePath}`
    : "No editor is open — GeminiX screen share";
  context.fillStyle = "#cccccc";
  context.fillText(
    truncateScreenText(context, title, canvasWidth - 96),
    12,
    20
  );
  context.fillStyle = "#4ec9b0";
  context.fillText("●", canvasWidth - 72, 20);
  context.fillStyle = "#9cdcfe";
  context.fillText("LIVE", canvasWidth - 60, 20);

  // Syntax-highlight the visible code with the Shiki highlighter that is
  // already loaded for the chat renderer.
  let tokenLines: ReadonlyArray<
    ReadonlyArray<{ readonly content: string; readonly color?: string }>
  > = [];
  let foreground = "#d4d4d4";
  try {
    const highlighter = await highlighterPromise;
    const requestedLanguage = normalizedLanguage(frame.languageId);
    const language = highlighter
      .getLoadedLanguages()
      .includes(requestedLanguage)
      ? requestedLanguage
      : "text";
    const result = highlighter.codeToTokens(frame.text, {
      lang: language,
      theme: "dark-plus"
    });
    tokenLines = result.tokens;
    foreground = result.fg ?? foreground;
  } catch {
    tokenLines = [];
  }

  context.font = SCREEN_SHARE_FONT;
  const codeTop = headerHeight + 8;
  for (let index = 0; index < shownLines.length; index += 1) {
    const lineNumber = frame.startLine + index;
    const y = codeTop + index * lineHeight + lineHeight;

    // Highlight the selected lines, like the editor's selection background.
    if (
      frame.selectionStart !== undefined &&
      frame.selectionEnd !== undefined &&
      lineNumber >= frame.selectionStart &&
      lineNumber <= frame.selectionEnd
    ) {
      context.fillStyle = "rgba(38, 79, 120, 0.55)";
      context.fillRect(
        gutterWidth,
        y - lineHeight + 2,
        canvasWidth - gutterWidth,
        lineHeight
      );
    }

    // Line number gutter.
    context.fillStyle = "#6e7681";
    context.textAlign = "right";
    context.fillText(String(lineNumber), gutterWidth - 8, y);

    // Tokenized code, truncated to the canvas width.
    context.textAlign = "left";
    const tokens = tokenLines[index];
    if (tokens && tokens.length) {
      let x = gutterWidth + 8;
      for (const token of tokens) {
        const maxTokenChars = Math.max(
          0,
          Math.floor((canvasWidth - 8 - x) / charWidth)
        );
        if (maxTokenChars <= 0) {
          break;
        }
        let content = token.content;
        if (content.length > maxTokenChars) {
          content = `${content.slice(0, maxTokenChars - 1)}…`;
        }
        context.fillStyle = token.color ?? foreground;
        context.fillText(content, x, y);
        x += content.length * charWidth;
      }
    }
  }

  let dataUrl: string;
  try {
    dataUrl = canvas.toDataURL("image/jpeg", 0.82);
  } catch {
    return;
  }
  const data = dataUrl.slice("data:image/jpeg;base64,".length);
  vscode.postMessage({ type: "sendScreenFrame", data });
}

function handleHostMessage(message: HostMessage): void {
  switch (message.type) {
    case "initialState":
      updateApiStatus(Boolean(message.apiConfigured));
      if (!message.apiConfigured) {
        elements.setupApiKeyInput.focus();
      }
      if (message.preferences) {
        applyPreferences(message.preferences);
      }
      updateSelection(message.selection);
      updateCurrentPage(message.currentPage);
      updateAttachments(message.attachments);
      updateChatHistory(message.chats);
      updateControls();
      break;
    case "apiStatus":
      updateApiStatus(Boolean(message.configured));
      elements.apiKeyInput.value = "";
      elements.setupApiKeyInput.value = "";
      elements.setupApiFeedback.classList.add("hidden");
      elements.settingsFeedback.textContent = message.configured
        ? "API key saved securely."
        : "API key removed.";
      elements.settingsFeedback.classList.remove("hidden");
      break;
    case "apiRequired":
      state.pendingTextSubmission = undefined;
      endProcessing();
      hideActivityIndicator();
      updateApiStatus(false);
      state.isConnecting = false;
      resetScreenSharing();
      cleanupAudio();
      updateControls();
      setActiveTab("chat");
      elements.setupApiKeyInput.focus();
      break;
    case "openPanel":
      if (message.panel === "history" || message.panel === "settings") {
        setActiveTab(message.panel);
      }
      break;
    case "newChat":
      startNewChat();
      break;
    case "preferences":
      if (message.preferences) {
        applyPreferences(message.preferences);
      }
      break;
    case "preferencesSaved":
      finishTranscriptTurn();
      endProcessing();
      hideActivityIndicator();
      if (message.preferences) {
        applyPreferences(message.preferences);
      }
      elements.settingsFeedback.textContent = "Preferences saved.";
      elements.settingsFeedback.classList.remove("hidden");
      elements.reconnectHint.classList.toggle(
        "hidden",
        !state.sessionReady && !state.isConnecting
      );
      break;
    case "selectionChanged":
      updateSelection(message.selection);
      updateCurrentPage(message.currentPage);
      break;
    case "attachmentsChanged":
      updateAttachments(message.attachments);
      break;
    case "microphoneLevel": {
      const level = Math.max(0, message.level ?? 0);
      state.micLevel += (level - state.micLevel) * 0.35;
      elements.micMeter.style.width = `${Math.min(
        100,
        state.micLevel * 700
      )}%`;
      break;
    }
    case "microphoneUnavailable":
      state.micMuted = true;
      state.userMicMutedState = true;
      if (message.message) showError(message.message);
      updateControlIcons();
      break;
    case "micMuted":
      state.micMuted = Boolean(message.muted);
      elements.muteMicButton.classList.toggle("is-muted", state.micMuted);
      elements.muteMicButton.title = state.micMuted
        ? "Unmute microphone"
        : "Mute microphone";
      elements.muteMicButton.setAttribute(
        "aria-label",
        elements.muteMicButton.title
      );
      if (state.micMuted) {
        state.micLevel = 0;
        elements.micMeter.style.width = "0%";
      }
      break;
    case "sessionConnecting":
      state.isConnecting = true;
      state.sessionReady = false;
      setStatus("Connecting", "busy");
      break;
    case "sessionModel":
      if (message.liveModel) state.sessionModel = message.liveModel;
      break;
    case "sessionOpened":
      setStatus("Configuring Gemini", "busy");
      break;
    case "userTranscriptChunk":
      if (message.text) {
        handleUserTranscriptChunk(message.text);
      }
      break;
    case "userTranscriptTurnComplete":
      break;
    case "transcriptCorrected":
      if (message.messageId && message.correctedText) {
        handleTranscriptCorrected(message.messageId, message.correctedText);
      }
      break;
    case "serverMessage":
      handleServerMessage(message.payload);
      break;
    case "selectedCodeResponse":
      if (message.codeText) {
        const language = message.languageId ?? "text";
        let fence = "```";
        while (message.codeText.includes(fence)) {
          fence += "`";
        }
        appendVisualText(
          `${fence}${language}\n${message.codeText}\n${fence}`
        );
        finishTranscriptTurn();
      }
      hideActivityIndicator();
      endProcessing();
      if (state.sessionReady) {
        setStatus("Listening", "live");
      }
      break;
    case "debugLog":
      if (message.message) {
        pushDebugLog(message.message);
      }
      break;
    case "toolResponseStatus":
      if (!message.success) {
        pushDebugLog(
          message.message ??
          `${message.functionName ?? "Tool"} response failed (${message.functionCallId ?? "unknown id"}).`
        );
        if (message.functionCallId) {
          state.handledFunctionCallIds.delete(message.functionCallId);
        }
        showError(
          message.message ?? "The Gemini tool response could not be sent."
        );
      }
      break;
    case "sessionError":
      finishTranscriptTurn();
      endProcessing();
      state.activeTextRequestId = undefined;
      state.pendingTextSubmission = undefined;
      state.pendingRespeak = undefined;
      state.isConnecting = false;
      state.sessionReady = false;
      state.micMuted = false;
      resetScreenSharing();
      elements.muteMicButton.classList.remove("is-muted");
      elements.muteMicButton.title = "Mute microphone";
      elements.muteMicButton.setAttribute("aria-label", "Mute microphone");
      stopTimer();
      cleanupAudio();
      hideActivityIndicator();
      updateControls();
      showError(message.message ?? "Gemini connection error.");
      setStatus("Connection error", "error");
      break;
    case "screenFrame":
      if (message.frame) {
        void renderScreenFrame(message.frame);
      }
      break;
    case "sessionClosed":
      finishTranscriptTurn();
      endProcessing();
      state.activeTextRequestId = undefined;
      state.pendingTextSubmission = undefined;
      state.pendingRespeak = undefined;
      state.isConnecting = false;
      state.sessionReady = false;
      state.micMuted = false;
      resetScreenSharing();
      elements.muteMicButton.classList.remove("is-muted");
      elements.muteMicButton.title = "Mute microphone";
      elements.muteMicButton.setAttribute("aria-label", "Mute microphone");
      stopTimer();
      cleanupAudio();
      hideActivityIndicator();
      updateControls();
      if (message.intentional) {
        setStatus("Disconnected");
      } else {
        // A live connection was lost (e.g. "Gemini Live connection closed
        // (code 1006)" or a policy violation with code 1008). Stop the
        // session here and hand control back to the user: never auto-retry,
        // because a failing connection would otherwise loop forever,
        // re-requesting the microphone every 1.5s and leaving the UI stuck
        // on "Requesting microphone". The user clicks "Start live session"
        // again once the underlying problem is resolved.
        pushDebugLog(
          `Session closed: code=${message.code ?? "unknown"}, reason=${message.reason ?? "none"}, intentional=${Boolean(message.intentional)}`
        );
        const isGoAway =
          /goaway|failed to close the connection/i.test(
            message.reason ?? ""
          );
        const detail = isGoAway
          ? "Gemini closed the live session after its connection time limit. Click “Start live session” to reconnect."
          : message.reason ||
          (message.code === 1008
            ? `Gemini Live rejected the connection (code ${message.code}). Verify the API key, selected model, Live API support, and session configuration. Please restart the live session.`
            : `Gemini Live connection closed (code ${message.code ?? "unknown"}). Please restart the live session.`);
        showError(detail);
        setStatus("Disconnected", isGoAway ? "idle" : "error");
      }
      break;
    case "sessionStopped":
      finishTranscriptTurn();
      endProcessing();
      state.activeTextRequestId = undefined;
      state.pendingTextSubmission = undefined;
      state.pendingRespeak = undefined;
      state.isConnecting = false;
      state.sessionReady = false;
      state.micMuted = false;
      resetScreenSharing();
      elements.muteMicButton.classList.remove("is-muted");
      elements.muteMicButton.title = "Mute microphone";
      elements.muteMicButton.setAttribute("aria-label", "Mute microphone");
      stopTimer();
      cleanupAudio();
      hideActivityIndicator();
      updateControls();
      setStatus("Disconnected");
      break;
    case "textAccepted": {
      if (message.requestId && message.requestId !== state.activeTextRequestId) break;
      state.submittedText = undefined;
      state.pendingModelApplyTargetId = message.applyTargetId;
      state.analyzingImage = false;
      unmuteMicIfAutoMuted();
      if (state.activeSearches === 0 && !state.answering && !state.reasoning) {
        setActivityIndicator("lightbulb", "Thinking…");
        setStatus("Thinking", "busy");
      }
      if (message.attachmentDisplays?.length) {
        const userMessages =
          elements.transcript.querySelectorAll<HTMLElement>(".message.user");
        const lastUserMsg = userMessages[userMessages.length - 1];
        if (lastUserMsg) {
          const imgDisplays = message.attachmentDisplays.filter(
            (d) => d.kind === "image" && d.dataUri
          );
          if (imgDisplays.length > 0) {
            let container = lastUserMsg.querySelector<HTMLElement>(
              ".message-attachments"
            );
            if (!container) {
              container = document.createElement("div");
              container.className = "message-attachments";
              lastUserMsg.prepend(container);
            }
            container
              .querySelectorAll(".message-attachment-image")
              .forEach((el) => el.remove());
            for (const display of imgDisplays) {
              if (!display.dataUri) {
                continue;
              }
              const image = document.createElement("img");
              image.className = "message-attachment-image";
              image.src = display.dataUri;
              image.alt = display.label;
              image.title = display.label;
              container.append(image);
            }
          }
        }
      }
      break;
    }
    case "textRejected":
      if (message.requestId && message.requestId !== state.activeTextRequestId) break;
      if (!elements.textInput.value && state.submittedText) {
        elements.textInput.value = state.submittedText.text;
        resizeComposer();
      }
      state.submittedText = undefined;
      state.activeTextRequestId = undefined;
      state.pendingTextSubmission = undefined;
      endProcessing();
      hideActivityIndicator();
      showError(message.message ?? "The message could not be sent.");
      setStatus("Listening", "live");
      break;
    case "voiceContext":
      state.pendingVoiceContext = message.context;
      state.pendingModelApplyTargetId = message.applyTargetId;
      // User is starting to speak — clear any suppression from a prior stop.
      state.suppressNextResponse = false;
      break;
    case "workspaceSearchStarted":
      if (state.suppressNextResponse || !state.sessionReady) break;
      showActivitySearch(
        message.kind === "reading"
          ? "reading"
          : message.kind === "web"
            ? "web"
            : "workspace"
      );
      setStatus(
        message.kind === "reading"
          ? "Reading file"
          : message.kind === "web"
            ? "Searching web"
            : "Searching workspace",
        "busy"
      );
      break;
    case "workspaceSearchCompleted":
      if (state.suppressNextResponse || !state.sessionReady) break;
      completeActivitySearch();
      setStatus("Thinking", "busy");
      break;
    case "codeCopied":
      completeCodeAction(message.actionId, "Code copied");
      break;
    case "patchApplied":
      completeCodeAction(message.actionId, "Applied to selection");
      break;
    case "chatSaved":
      updateChatHistory(message.chats);
      break;
    case "chatLoaded":
      if (message.chat) {
        restoreChat(message.chat);
      }
      break;
    case "chatDeleted":
      updateChatHistory(message.chats);
      if (
        message.chatId === state.activeChatId ||
        (message.chatIds &&
          state.activeChatId &&
          message.chatIds.includes(state.activeChatId))
      ) {
        state.activeChatId = undefined;
        startNewChat();
      }
      break;
    case "hostError":
      enableCodeActions();
      showError(message.message ?? "GeminiX could not continue.");
      break;
  }
}

function completeCodeAction(
  actionId: string | undefined,
  title: string
): void {
  if (!actionId) {
    return;
  }

  const button = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".code-action-button")
  ).find((candidate) => candidate.dataset["actionId"] === actionId);
  if (button) {
    button.disabled = false;
    button.classList.add("is-success");
    button.title = title;
    button.setAttribute("aria-label", title);
    window.setTimeout(() => {
      button.classList.remove("is-success");
    }, 1_400);
  }
}

function enableCodeActions(): void {
  document
    .querySelectorAll<HTMLButtonElement>(
      '.code-action-button:disabled[data-available="true"]'
    )
    .forEach((button) => {
      button.disabled = false;
    });
}

const MODE_COLORS = {
  idle: [132, 145, 160],
  connecting: [166, 173, 186],
  listening: [76, 194, 255],
  speaking: [255, 198, 92]
} as const;

function visualMode(): keyof typeof MODE_COLORS {
  if (state.isConnecting) {
    return "connecting";
  }
  if (!state.sessionReady) {
    return "idle";
  }
  return state.playbackSources.size ? "speaking" : "listening";
}

function rgba(
  color: readonly [number, number, number],
  alpha: number
): string {
  return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha})`;
}

function sizeOrb(): void {
  const rectangle = elements.orbCanvas.getBoundingClientRect();
  elements.orbCanvas.width = Math.max(
    1,
    Math.round(rectangle.width * orb.devicePixelRatio)
  );
  elements.orbCanvas.height = Math.max(
    1,
    Math.round(rectangle.height * orb.devicePixelRatio)
  );
}

function drawOrb(now: number): void {
  window.requestAnimationFrame(drawOrb);
  const context = orb.context;
  const canvas = elements.orbCanvas;
  if (!context || !canvas.width || !canvas.height) {
    return;
  }

  const mode = visualMode();
  const color = MODE_COLORS[mode];
  const time = now / 1000;
  const centerX = canvas.width / 2;
  const centerY = canvas.height / 2;
  const radius = canvas.width * 0.27;
  context.clearRect(0, 0, canvas.width, canvas.height);
  elements.orbMode.textContent =
    mode === "idle" ? "standby" : mode === "connecting" ? "connecting" : mode;

  const glow = context.createRadialGradient(
    centerX,
    centerY,
    radius * 0.1,
    centerX,
    centerY,
    radius * 1.9
  );
  glow.addColorStop(0, rgba(color, mode === "idle" ? 0.13 : 0.24));
  glow.addColorStop(1, "rgba(0,0,0,0)");
  context.fillStyle = glow;
  context.fillRect(0, 0, canvas.width, canvas.height);

  context.beginPath();
  context.arc(centerX, centerY, radius, 0, Math.PI * 2);
  context.strokeStyle = rgba(color, 0.48);
  context.lineWidth = 1.2 * orb.devicePixelRatio;
  context.stroke();

  const barCount = orb.bars.length;
  for (let index = 0; index < barCount; index += 1) {
    let target = 0.03;
    if (mode === "speaking" && state.analyser && state.analyserData) {
      state.analyser.getByteTimeDomainData(state.analyserData);
      const sampleIndex = Math.floor(
        (index / barCount) * state.analyserData.length
      );
      target =
        (Math.abs((state.analyserData[sampleIndex] ?? 128) - 128) / 128) * 2.1;
    } else if (mode === "listening") {
      target =
        Math.min(1, state.micLevel * 9) *
        (0.3 + 0.7 * Math.abs(Math.sin(index * 0.55 + time * 5.2)));
    } else if (mode === "connecting") {
      target = 0.08 + 0.08 * Math.abs(Math.sin(index * 0.36 - time * 6));
    }

    const currentBar = orb.bars[index] ?? 0;
    const nextBar = currentBar + (target - currentBar) * 0.28;
    orb.bars[index] = nextBar;
    const angle = (index / barCount) * Math.PI * 2 - Math.PI / 2;
    const amplitude =
      nextBar * canvas.width * 0.16 + canvas.width * 0.008;
    const startRadius = radius + 3 * orb.devicePixelRatio;
    context.beginPath();
    context.moveTo(
      centerX + Math.cos(angle) * startRadius,
      centerY + Math.sin(angle) * startRadius
    );
    context.lineTo(
      centerX + Math.cos(angle) * (startRadius + amplitude),
      centerY + Math.sin(angle) * (startRadius + amplitude)
    );
    context.strokeStyle = rgba(
      color,
      0.25 + 0.65 * Math.min(1, nextBar * 1.6)
    );
    context.lineWidth = 1.6 * orb.devicePixelRatio;
    context.lineCap = "round";
    context.stroke();
  }
}

elements.backToChatButton.addEventListener("click", () => {
  setActiveTab("chat");
  elements.textInput.focus();
});

elements.backFromHistoryButton.addEventListener("click", () => {
  setActiveTab("chat");
  elements.textInput.focus();
});

elements.newChatFromHistoryButton.addEventListener("click", startNewChat);

elements.deleteChatsButton.addEventListener("click", () => {
  if (state.chats.length === 0) {
    return;
  }
  setBulkDeleteMode(!state.bulkDeleteMode);
});

elements.selectAllChatsInput.addEventListener("change", () => {
  if (elements.selectAllChatsInput.checked) {
    state.chats.forEach((chat) => state.bulkDeleteSelected.add(chat.id));
  } else {
    state.bulkDeleteSelected.clear();
  }
  updateChatHistory(state.chats);
});

elements.confirmBulkDeleteButton.addEventListener("click", () => {
  const chatIds = [...state.bulkDeleteSelected];
  if (chatIds.length === 0) {
    return;
  }
  setBulkDeleteMode(false);
  vscode.postMessage({ type: "deleteChats", chatIds });
});

elements.cancelBulkDeleteButton.addEventListener("click", () => {
  setBulkDeleteMode(false);
});

elements.sessionButton.addEventListener("click", () => {
  if (state.sessionReady || state.isConnecting) {
    endSession();
  } else {
    void beginSession();
  }
});

elements.muteMicButton.addEventListener("click", () => {
  state.micMuted = !state.micMuted;
  elements.muteMicButton.classList.toggle("is-muted", state.micMuted);
  elements.muteMicButton.title = state.micMuted
    ? "Unmute microphone"
    : "Mute microphone";
  elements.muteMicButton.setAttribute(
    "aria-label",
    elements.muteMicButton.title
  );
  updateControlIcons();
  vscode.postMessage({
    type: "muteMic",
    muted: state.micMuted,
    voiceEnabled: true
  });
  if (state.micMuted) {
    state.micLevel = 0;
    elements.micMeter.style.width = "0%";
  }
});

elements.speakerMuteButton.addEventListener("click", () => {
  state.audioMuted = !state.audioMuted;
  elements.speakerMuteButton.classList.toggle("is-muted", state.audioMuted);
  elements.speakerMuteButton.title = state.audioMuted
    ? "Unmute Gemini's voice"
    : "Mute Gemini's voice";
  elements.speakerMuteButton.setAttribute(
    "aria-label",
    elements.speakerMuteButton.title
  );
  updateControlIcons();
  if (state.audioMuted) {
    stopPlayback();
  }
  if (state.masterGain) {
    state.masterGain.gain.value = state.audioMuted ? 0 : 1;
  }
  setStatus(
    state.audioMuted ? "Voice muted" : "Listening",
    state.audioMuted ? "idle" : "live"
  );
});

elements.shareScreenButton.addEventListener("click", () => {
  if (!state.sessionReady) {
    return;
  }
  state.screenSharing = !state.screenSharing;
  updateShareScreenButton();
  vscode.postMessage({
    type: "setScreenSharing",
    enabled: state.screenSharing
  });
  setStatus(
    state.screenSharing ? "Sharing screen" : "Listening",
    state.screenSharing ? "busy" : "live"
  );
});

elements.stopPlaybackButton.addEventListener("click", stopActiveTurn);

elements.saveApiButton.addEventListener("click", () => {
  submitApiKey(elements.apiKeyInput, elements.settingsFeedback);
});

elements.setupSaveApiButton.addEventListener("click", () => {
  submitApiKey(elements.setupApiKeyInput, elements.setupApiFeedback);
});

elements.setupApiKeyInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    submitApiKey(elements.setupApiKeyInput, elements.setupApiFeedback);
  }
});

elements.removeApiButton.addEventListener("click", () => {
  vscode.postMessage({ type: "removeApiKey" });
});

elements.currentPageMention.addEventListener("mousedown", (event) => {
  event.preventDefault();
});

elements.currentPageMention.addEventListener("click", attachCurrentPage);

elements.removeCurrentPageButton.addEventListener("click", () => {
  state.attachedCurrentPage = false;
  renderCurrentPageAttachment();
  elements.textInput.focus();
});

elements.attachFileButton.addEventListener("click", () => {
  clearError();
  setAttachmentMenu(false);
  vscode.postMessage({ type: "pickFileAttachments" });
});

elements.attachImageButton.addEventListener("click", () => {
  clearError();
  setAttachmentMenu(false);
  vscode.postMessage({ type: "pickImageAttachments" });
});

elements.attachmentButton.addEventListener("click", () => {
  setAttachmentMenu(elements.attachmentMenu.classList.contains("hidden"));
});

elements.debugToggle.addEventListener("click", () => {
  const expanded = elements.debugToggle.getAttribute("aria-expanded") === "true";
  elements.debugToggle.setAttribute("aria-expanded", String(!expanded));
  elements.debugPanel.classList.toggle("hidden", expanded);
});

elements.debugClearButton.addEventListener("click", () => {
  elements.debugEntries.replaceChildren();
  state.debugEntries = [];
  elements.debugBadge.textContent = "0";
  elements.debugBadge.classList.add("hidden");
});

function collectCurrentPreferences(): Preferences {
  const behaviorValue = elements.behaviorSelect.value;
  const behavior: Behavior =
    behaviorValue === "friendly" || behaviorValue === "expert"
      ? behaviorValue
      : "professional";

  const modelValue = elements.modelSelect.value;
  const liveModel: LiveModel =
    modelValue === "gemini-3.1-flash-live-preview" ||
    modelValue === "gemini-3.8-live-extended-thinking"
      ? modelValue
      : "gemini-3.8-live";

  const thinkingLevelValue = elements.thinkingLevelSelect.value;
  const thinkingLevel: ThinkingLevel =
    thinkingLevelValue === "minimal" ||
    thinkingLevelValue === "low" ||
    thinkingLevelValue === "medium" ||
    thinkingLevelValue === "high"
      ? thinkingLevelValue
      : "high";

  return {
    voice: elements.voiceSelect.value,
    preferredLanguage: elements.languageSelect.value,
    autoInterrupt: elements.autoInterruptInput.checked,
    behavior,
    liveModel,
    thinkingLevel
  };
}

function persistPreferences(showFeedback = false): void {
  const preferences = collectCurrentPreferences();
  state.preferences = preferences;
  if (showFeedback) {
    elements.settingsFeedback.classList.add("hidden");
  }
  vscode.postMessage({ type: "savePreferences", preferences });
}

elements.voiceSelect.addEventListener("change", () => {
  persistPreferences(false);
});

elements.languageSelect.addEventListener("change", () => {
  persistPreferences(false);
});

elements.behaviorSelect.addEventListener("change", () => {
  persistPreferences(false);
});

elements.modelSelect.addEventListener("change", () => {
  updateThinkingLevelVisibility();
  persistPreferences(false);
});

elements.thinkingLevelSelect.addEventListener("change", () => {
  persistPreferences(false);
});

elements.autoInterruptInput.addEventListener("change", () => {
  persistPreferences(false);
});

elements.savePreferencesButton.addEventListener("click", () => {
  persistPreferences(true);
});

elements.transcript.addEventListener("scroll", () => {
  state.followTranscript = elements.transcript.scrollHeight - elements.transcript.scrollTop - elements.transcript.clientHeight < 80;
}, { passive: true });

elements.textForm.addEventListener("submit", (event) => {
  event.preventDefault();
  submitTextMessage();
});

elements.textInput.addEventListener("input", () => {
  resizeComposer();
  updateMentionMenu();
  updateControls();
});

elements.textInput.addEventListener("click", updateMentionMenu);

elements.textInput.addEventListener("blur", () => {
  window.setTimeout(() => {
    elements.mentionMenu.classList.add("hidden");
  }, 100);
});

elements.textInput.addEventListener("keydown", (event) => {
  if (event.isComposing) return;
  if (!elements.mentionMenu.classList.contains("hidden")) {
    if (event.key === "Escape") {
      event.preventDefault();
      state.mentionRange = undefined;
      elements.mentionMenu.classList.add("hidden");
      return;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      attachCurrentPage();
      return;
    }
  }

  if (
    event.key !== "Enter" ||
    event.shiftKey
  ) {
    return;
  }

  if (state.isProcessing) return;
  event.preventDefault();
  elements.textForm.requestSubmit();
});

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    if (
      target instanceof Node &&
      !elements.attachmentMenu.contains(target) &&
      !elements.attachmentButton.contains(target)
    ) {
      setAttachmentMenu(false);
    }
    return;
  }

  const externalLink = target.closest<HTMLElement>("a.external-link");
  if (externalLink) {
    event.preventDefault();
    const url = externalLink.getAttribute("href");
    if (url) {
      vscode.postMessage({ type: "openExternal", url });
    }
    return;
  }

  const fileLink = target.closest<HTMLElement>("a.file-link");
  if (fileLink) {
    event.preventDefault();
    const path = fileLink.dataset.path;
    const startLine = fileLink.dataset.line;
    if (path) {
      vscode.postMessage({
        type: "openFile",
        data: path,
        startLine: startLine ? Number(startLine) : undefined
      });
    }
    return;
  }

  if (
    target instanceof Node &&
    !elements.attachmentMenu.contains(target) &&
    !elements.attachmentButton.contains(target)
  ) {
    setAttachmentMenu(false);
  }
});

window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
  handleHostMessage(event.data);
});

window.addEventListener("resize", sizeOrb);
window.addEventListener("beforeunload", () => {
  postActiveChat();
  if (state.sessionReady || state.isConnecting) {
    vscode.postMessage({ type: "stopSession" });
  }
  cleanupAudio();
});

initializeSelects();
updateControls();
updateControlIcons();
sizeOrb();
window.requestAnimationFrame(drawOrb);
vscode.postMessage({ type: "ready" });
