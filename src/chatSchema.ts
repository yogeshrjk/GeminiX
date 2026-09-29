import type { ChatMessage, MarkdownBlock } from "./types.js";

const MAX_MARKDOWN_BLOCKS = 100;

export function parseChatMessage(
  value: unknown,
  maxCharacters: number
): ChatMessage {
  if (!isRecord(value)) {
    throw new Error("A stored chat message is invalid.");
  }

  const role = value["role"];
  if (role !== "user" && role !== "model") {
    throw new Error("A stored chat message has an invalid role.");
  }

  const legacyText = readOptionalContent(value, "text", maxCharacters);
  const spokenText =
    readOptionalContent(value, "spokenText", maxCharacters) ??
    legacyText ??
    "";
  const visualText = readOptionalContent(
    value,
    "visualText",
    maxCharacters
  );
  const markdownBlocks = readMarkdownBlocks(value["markdownBlocks"], maxCharacters);

  return {
    id: readRequiredString(value, "id").slice(0, 80),
    role,
    spokenText,
    visualText,
    markdownBlocks: markdownBlocks.length ? markdownBlocks : undefined,
    createdAt: readDate(value, "createdAt"),
    contextLabel: readOptionalLabel(value, "contextLabel"),
    currentPageLabel: readOptionalLabel(value, "currentPageLabel")
  };
}

export function chatMessageToText(message: ChatMessage): string {
  const sections = [
    message.spokenText,
    message.visualText,
    ...(message.markdownBlocks ?? []).map((block) => block.markdown)
  ].filter((section): section is string => Boolean(section?.trim()));

  return [...new Set(sections)].join("\n\n");
}

function readMarkdownBlocks(
  value: unknown,
  maxCharacters: number
): readonly MarkdownBlock[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("A stored Markdown block list is invalid.");
  }

  return value.slice(-MAX_MARKDOWN_BLOCKS).map((block) => {
    if (!isRecord(block)) {
      throw new Error("A stored Markdown block is invalid.");
    }

    const markdown = readOptionalContent(block, "markdown", maxCharacters);
    if (!markdown?.trim()) {
      throw new Error("A stored Markdown block has no content.");
    }

    return {
      id: readRequiredString(block, "id").slice(0, 80),
      markdown,
      functionCallId: readOptionalLabel(block, "functionCallId")
    };
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function readRequiredString(
  value: Readonly<Record<string, unknown>>,
  key: string
): string {
  const field = value[key];
  if (typeof field !== "string" || !field.trim()) {
    throw new Error(`The chat field '${key}' is invalid.`);
  }
  return field.trim();
}

function readOptionalContent(
  value: Readonly<Record<string, unknown>>,
  key: string,
  maxCharacters: number
): string | undefined {
  const field = value[key];
  return typeof field === "string"
    ? field.slice(0, maxCharacters)
    : undefined;
}

function readOptionalLabel(
  value: Readonly<Record<string, unknown>>,
  key: string
): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.trim()
    ? field.trim().slice(0, 240)
    : undefined;
}

function readDate(
  value: Readonly<Record<string, unknown>>,
  key: string
): string {
  const field = readRequiredString(value, key);
  if (Number.isNaN(Date.parse(field))) {
    throw new Error(`The chat date '${key}' is invalid.`);
  }
  return field;
}
