export const GEMINI_VOICES = [
  "Zephyr",
  "Puck",
  "Charon",
  "Kore",
  "Fenrir",
  "Leda",
  "Orus",
  "Aoede",
  "Callirrhoe",
  "Autonoe",
  "Enceladus",
  "Iapetus",
  "Umbriel",
  "Algieba",
  "Despina",
  "Erinome",
  "Algenib",
  "Rasalgethi",
  "Laomedeia",
  "Achernar",
  "Alnilam",
  "Schedar",
  "Gacrux",
  "Pulcherrima",
  "Achird",
  "Zubenelgenubi",
  "Vindemiatrix",
  "Sadachbia",
  "Sadaltager",
  "Sulafat"
] as const;

export const PREFERRED_LANGUAGES = [
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

export const BEHAVIORS = ["professional", "friendly", "expert"] as const;

export type GeminiVoice = (typeof GEMINI_VOICES)[number];
export type PreferredLanguage = (typeof PREFERRED_LANGUAGES)[number];
export type Behavior = (typeof BEHAVIORS)[number];

export interface Preferences {
  readonly voice: GeminiVoice;
  readonly preferredLanguage: PreferredLanguage;
  readonly autoInterrupt: boolean;
  readonly behavior: Behavior;
}

export interface EditorContext {
  readonly uri: string;
  readonly fileName: string;
  readonly relativePath: string;
  readonly languageId: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly startLineIndex: number;
  readonly endLineIndex: number;
  readonly startCharacter: number;
  readonly endCharacter: number;
  readonly text: string;
  readonly supportingStartLine: number;
  readonly supportingEndLine: number;
  readonly supportingText: string;
  readonly relatedImports: string;
}

export interface ContextSummary {
  readonly fileName: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly label: string;
}

export interface CurrentPageContext {
  readonly uri: string;
  readonly fileName: string;
  readonly relativePath: string;
  readonly languageId: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
  readonly truncated: boolean;
}

export interface CurrentPageSummary {
  readonly uri: string;
  readonly fileName: string;
  readonly relativePath: string;
  readonly label: string;
}

export type AttachmentKind = "currentFile" | "textFile" | "image" | "document";

export interface AttachmentSummary {
  readonly id: string;
  readonly kind: AttachmentKind;
  readonly label: string;
  readonly dataUri?: string;
}

export interface AttachmentDisplay {
  readonly id: string;
  readonly kind: AttachmentKind;
  readonly label: string;
  readonly dataUri?: string;
}

export interface ImageContext {
  readonly data: string;
  readonly label: string;
  readonly mimeType: string;
}

export type ChatRole = "user" | "model";

export interface MarkdownBlock {
  readonly id: string;
  readonly markdown: string;
  readonly functionCallId?: string;
}

export interface ChatMessage {
  readonly id: string;
  readonly role: ChatRole;
  readonly spokenText: string;
  readonly visualText?: string;
  readonly markdownBlocks?: readonly MarkdownBlock[];
  readonly createdAt: string;
  readonly contextLabel?: string;
  readonly currentPageLabel?: string;
}

export interface StoredChat {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messages: readonly ChatMessage[];
}

export interface ChatSummary {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly messageCount: number;
}

export interface WorkspaceSnippet {
  readonly filePath: string;
  readonly languageId: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
  readonly reason: string;
}

export interface WorkspaceContext {
  readonly snippets: readonly WorkspaceSnippet[];
  readonly indexedFileCount: number;
  readonly truncated: boolean;
}
