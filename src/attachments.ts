import { randomUUID } from "node:crypto";
import { basename, extname } from "node:path";
import * as vscode from "vscode";
import {
  captureCurrentPageContext,
  summarizeCurrentPage
} from "./editorContext.js";
import type {
  AttachmentDisplay,
  AttachmentKind,
  AttachmentSummary,
  CurrentPageContext,
  ImageContext
} from "./types.js";

const MAX_ATTACHMENTS = 8;
const MAX_IMAGE_ATTACHMENTS = 5;
const MAX_DOCUMENT_ATTACHMENTS = 5;
const MAX_TEXT_FILE_BYTES = 2 * 1_024 * 1_024;
const MAX_DOCUMENT_FILE_BYTES = 25 * 1_024 * 1_024;
const MAX_IMAGE_FILE_BYTES = 25 * 1_024 * 1_024;
const MAX_ATTACHMENT_TEXT_CHARACTERS = 100_000;

const IMAGE_MIME_TYPES = new Map<string, string>([
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".bmp", "image/bmp"],
  [".svg", "image/svg+xml"],
  [".tiff", "image/tiff"],
  [".tif", "image/tiff"],
  [".heic", "image/heic"],
  [".heif", "image/heif"]
]);

const DOCUMENT_MIME_TYPES = new Map<string, string>([
  [".pdf", "application/pdf"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".doc", "application/msword"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [".xls", "application/vnd.ms-excel"],
  [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  [".ppt", "application/vnd.ms-powerpoint"],
  [".rtf", "application/rtf"],
  [".csv", "text/csv"],
  [".tsv", "text/tab-separated-values"]
]);

function sniffImageMimeType(bytes: Uint8Array): string | undefined {
  const startsWith = (offset: number, expected: readonly number[]): boolean =>
    expected.every((byte, index) => bytes[offset + index] === byte);

  // JPEG: FF D8 FF
  if (startsWith(0, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (startsWith(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  // WebP: RIFF....WEBP
  if (
    bytes.length >= 12 &&
    startsWith(0, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(8, [0x57, 0x45, 0x42, 0x50])
  ) {
    return "image/webp";
  }
  // GIF: GIF8
  if (startsWith(0, [0x47, 0x49, 0x46, 0x38])) {
    return "image/gif";
  }
  // BMP: BM (0x42, 0x4D)
  if (startsWith(0, [0x42, 0x4d])) {
    return "image/bmp";
  }
  // TIFF: II*. or MM.*
  if (
    startsWith(0, [0x49, 0x49, 0x2a, 0x00]) ||
    startsWith(0, [0x4d, 0x4d, 0x00, 0x2a])
  ) {
    return "image/tiff";
  }
  return undefined;
}

function sniffDocumentMimeType(bytes: Uint8Array): string | undefined {
  const startsWith = (offset: number, expected: readonly number[]): boolean =>
    expected.every((byte, index) => bytes[offset + index] === byte);

  // PDF: %PDF- (0x25, 0x50, 0x44, 0x46, 0x2D)
  if (startsWith(0, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return "application/pdf";
  }
  // RTF: {\rtf (0x7B, 0x5C, 0x72, 0x74, 0x66)
  if (startsWith(0, [0x7b, 0x5c, 0x72, 0x74, 0x66])) {
    return "application/rtf";
  }
  return undefined;
}

const VISION_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite"
] as const;

async function extractWithGoogleVision(
  bytes: Uint8Array,
  mimeType: string,
  fileName: string,
  kind: "image" | "document",
  apiKey: string
): Promise<string> {
  const base64Data = Buffer.from(bytes).toString("base64");
  const prompt =
    kind === "document"
      ? `Extract and transcribe the full content of this document "${fileName}" thoroughly into clean Markdown. Include all text, code snippets, headers, sections, tables, formulas, lists, diagram descriptions, and structural elements accurately.`
      : `Perform thorough Google Vision analysis and OCR on this image "${fileName}". Transcribe all visible text and code verbatim, describe diagrams, UI components, architecture flowcharts, error logs, charts, and visual elements in clean Markdown.`;

  for (const model of VISION_MODELS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, 500 * Math.pow(2, attempt - 1))
        );
      }
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            contents: [
              {
                role: "user",
                parts: [
                  {
                    inlineData: {
                      mimeType,
                      data: base64Data
                    }
                  },
                  {
                    text: prompt
                  }
                ]
              }
            ]
          })
        });

        if (
          response.status === 429 ||
          response.status === 500 ||
          response.status === 503 ||
          response.status === 504
        ) {
          continue;
        }

        if (!response.ok) {
          break;
        }

        const data: unknown = await response.json();
        if (typeof data !== "object" || data === null) {
          break;
        }
        const candidates = (data as { readonly candidates?: readonly unknown[] })
          .candidates;
        const candidate = candidates?.[0] as
          | { readonly content?: { readonly parts?: readonly { readonly text?: string }[] } }
          | undefined;
        const textParts = candidate?.content?.parts
          ?.map((part) => part.text || "")
          .filter(Boolean)
          .join("\n\n");

        if (textParts && textParts.trim()) {
          return textParts.trim();
        }
        break;
      } catch {
        // Retry or fallback to next model
      }
    }
  }
  return "";
}

const TEXT_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".conf",
  ".cpp",
  ".cs",
  ".css",
  ".csv",
  ".dart",
  ".env",
  ".go",
  ".graphql",
  ".h",
  ".hpp",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".kt",
  ".kts",
  ".log",
  ".md",
  ".php",
  ".properties",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".svelte",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".tsv",
  ".txt",
  ".vue",
  ".xml",
  ".yaml",
  ".yml"
]);

interface StoredAttachment {
  readonly summary: AttachmentSummary;
  readonly uri?: vscode.Uri;
  readonly currentPage?: CurrentPageContext;
  readonly mimeType?: string;
}

export interface PreparedAttachments {
  readonly prompt: string;
  readonly images: readonly ImageContext[];
}

export class AttachmentStore {
  private readonly attachments = new Map<string, StoredAttachment>();

  public list(): readonly AttachmentSummary[] {
    return [...this.attachments.values()].map(({ summary }) => summary);
  }

  public addCurrentFile(): AttachmentSummary {
    const currentPage = captureCurrentPageContext();
    const currentPageSummary = summarizeCurrentPage(currentPage);
    if (!currentPage || !currentPageSummary) {
      throw new Error("Open a text editor before adding the current file.");
    }

    const duplicate = [...this.attachments.values()].find(
      (attachment) =>
        attachment.summary.kind === "currentFile" &&
        attachment.currentPage?.uri === currentPage.uri
    );
    if (duplicate) {
      return duplicate.summary;
    }

    this.assertCapacity(1);
    const summary: AttachmentSummary = {
      id: randomUUID(),
      kind: "currentFile",
      label: currentPageSummary.label
    };
    this.attachments.set(summary.id, { currentPage, summary });
    return summary;
  }

  public async pickTextFiles(): Promise<readonly AttachmentSummary[]> {
    return this.pickFiles("text");
  }

  public async pickImages(): Promise<readonly AttachmentSummary[]> {
    return this.pickFiles("image");
  }

  private async pickFiles(
    selectionKind: "text" | "image"
  ): Promise<readonly AttachmentSummary[]> {
    const isImageSelection = selectionKind === "image";
    const docAndTextExts = [
      ...DOCUMENT_MIME_TYPES.keys(),
      ...TEXT_EXTENSIONS
    ].map((ext) => (ext.startsWith(".") ? ext.slice(1) : ext));

    const imageExts = [...IMAGE_MIME_TYPES.keys()].map((ext) =>
      ext.startsWith(".") ? ext.slice(1) : ext
    );

    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      openLabel: isImageSelection ? "Add images" : "Add files",
      title: isImageSelection
        ? "Add image context to GeminiX (Google Vision)"
        : "Add file context to GeminiX (Google Vision & Files)",
      filters: isImageSelection
        ? { Images: imageExts }
        : {
            "All Supported Files": docAndTextExts,
            Documents: [
              "pdf",
              "docx",
              "doc",
              "xlsx",
              "xls",
              "pptx",
              "ppt",
              "rtf",
              "csv",
              "tsv"
            ],
            "Code and Text": [...TEXT_EXTENSIONS].map((extension) =>
              extension.slice(1)
            )
          }
    });
    if (!uris?.length) {
      return [];
    }

    this.assertCapacity(uris.length);
    const added: AttachmentSummary[] = [];
    for (const uri of uris) {
      const duplicate = [...this.attachments.values()].find(
        (attachment) => attachment.uri?.toString() === uri.toString()
      );
      if (duplicate) {
        added.push(duplicate.summary);
        continue;
      }

      const extension = extname(uri.path).toLowerCase();
      const imageMimeType = IMAGE_MIME_TYPES.get(extension);
      const documentMimeType = DOCUMENT_MIME_TYPES.get(extension);

      let kind: AttachmentKind;
      let mimeType: string | undefined;

      if (imageMimeType) {
        kind = "image";
        mimeType = imageMimeType;
      } else if (documentMimeType) {
        kind = "document";
        mimeType = documentMimeType;
      } else if (TEXT_EXTENSIONS.has(extension)) {
        kind = "textFile";
      } else {
        const sample = await vscode.workspace.fs.readFile(uri);
        const sniffedImg = sniffImageMimeType(sample);
        const sniffedDoc = sniffDocumentMimeType(sample);
        if (sniffedImg) {
          kind = "image";
          mimeType = sniffedImg;
        } else if (sniffedDoc) {
          kind = "document";
          mimeType = sniffedDoc;
        } else if (!sample.slice(0, 1024).includes(0)) {
          kind = "textFile";
        } else {
          kind = "document";
          mimeType = "application/octet-stream";
        }
      }

      const imageCount = [...this.attachments.values()].filter(
        (attachment) => attachment.summary.kind === "image"
      ).length;
      if (kind === "image" && imageCount >= MAX_IMAGE_ATTACHMENTS) {
        throw new Error(
          `GeminiX accepts up to ${MAX_IMAGE_ATTACHMENTS} images per message.`
        );
      }

      const documentCount = [...this.attachments.values()].filter(
        (attachment) => attachment.summary.kind === "document"
      ).length;
      if (kind === "document" && documentCount >= MAX_DOCUMENT_ATTACHMENTS) {
        throw new Error(
          `GeminiX accepts up to ${MAX_DOCUMENT_ATTACHMENTS} documents per message.`
        );
      }

      const stat = await vscode.workspace.fs.stat(uri);
      const maximumBytes =
        kind === "image"
          ? MAX_IMAGE_FILE_BYTES
          : kind === "document"
            ? MAX_DOCUMENT_FILE_BYTES
            : MAX_TEXT_FILE_BYTES;
      if (stat.size > maximumBytes) {
        const maximumMegabytes = Math.floor(maximumBytes / 1_024 / 1_024);
        throw new Error(
          `${basename(uri.fsPath)} is larger than the ${maximumMegabytes} MB attachment limit.`
        );
      }

      let dataUri: string | undefined;
      if (kind === "image") {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const actualMime =
          sniffImageMimeType(bytes) ?? mimeType ?? "image/png";
        dataUri = `data:${actualMime};base64,${Buffer.from(bytes).toString("base64")}`;
      }

      const summary: AttachmentSummary = {
        id: randomUUID(),
        kind,
        label: basename(uri.fsPath),
        dataUri
      };
      this.attachments.set(summary.id, {
        summary,
        uri,
        mimeType
      });
      added.push(summary);
    }
    return added;
  }

  public remove(id: string): void {
    this.attachments.delete(id);
  }

  public clear(): void {
    this.attachments.clear();
  }

  public async prepare(
    requestedIds: readonly string[],
    apiKey?: string
  ): Promise<PreparedAttachments> {
    const requested = requestedIds
      .map((id) => this.attachments.get(id))
      .filter(
        (attachment): attachment is StoredAttachment => attachment !== undefined
      );
    const promptSections: string[] = [];
    const images: ImageContext[] = [];
    let remainingTextCharacters = MAX_ATTACHMENT_TEXT_CHARACTERS;

    for (const attachment of requested) {
      if (attachment.summary.kind === "image") {
        if (!attachment.uri) {
          continue;
        }
        const bytes = await vscode.workspace.fs.readFile(attachment.uri);
        const mimeType =
          sniffImageMimeType(bytes) ?? attachment.mimeType ?? "image/png";

        images.push({
          data: Buffer.from(bytes).toString("base64"),
          label: attachment.summary.label,
          mimeType
        });

        let visionOcrText = "";
        if (apiKey) {
          visionOcrText = await extractWithGoogleVision(
            bytes,
            mimeType,
            attachment.summary.label,
            "image",
            apiKey
          );
        }

        if (visionOcrText) {
          promptSections.push(
            [
              `Attached image: ${attachment.summary.label}`,
              "Google Vision OCR & Visual Analysis:",
              visionOcrText
            ].join("\n\n")
          );
        } else {
          promptSections.push(
            [
              `Attached image: ${attachment.summary.label}`,
              "The image is sent as a visual frame. Inspect its visible content and use it as supporting context."
            ].join("\n")
          );
        }
        continue;
      }

      if (attachment.summary.kind === "document") {
        if (!attachment.uri) {
          continue;
        }
        const bytes = await vscode.workspace.fs.readFile(attachment.uri);
        const mimeType =
          sniffDocumentMimeType(bytes) ??
          attachment.mimeType ??
          DOCUMENT_MIME_TYPES.get(extname(attachment.uri.path).toLowerCase()) ??
          "application/pdf";

        let documentText = "";
        if (apiKey) {
          documentText = await extractWithGoogleVision(
            bytes,
            mimeType,
            attachment.summary.label,
            "document",
            apiKey
          );
        }

        if (documentText) {
          const acceptedText = documentText.slice(0, remainingTextCharacters);
          remainingTextCharacters -= acceptedText.length;
          promptSections.push(
            [
              `Attached document (Google Vision extraction): ${attachment.summary.label}`,
              acceptedText.length < documentText.length
                ? "Note: The document content was truncated at the safe context limit."
                : "",
              acceptedText
            ]
              .filter(Boolean)
              .join("\n\n")
          );
        } else {
          try {
            const doc = await vscode.workspace.openTextDocument(attachment.uri);
            const text = doc.getText();
            if (!text.includes("\u0000")) {
              const accepted = text.slice(0, remainingTextCharacters);
              remainingTextCharacters -= accepted.length;
              promptSections.push(
                [
                  `Attached document: ${attachment.summary.label}`,
                  accepted
                ].join("\n\n")
              );
            }
          } catch {
            promptSections.push(
              `Attached document: ${attachment.summary.label} (Google Vision extraction pending or unavailable)`
            );
          }
        }
        continue;
      }

      const textAttachment = await this.readTextAttachment(attachment, apiKey);
      if (!textAttachment || remainingTextCharacters <= 0) {
        continue;
      }

      const acceptedText = textAttachment.text.slice(
        0,
        remainingTextCharacters
      );
      remainingTextCharacters -= acceptedText.length;
      promptSections.push(
        [
          `Attached file: ${textAttachment.relativePath}`,
          textAttachment.truncated ||
          acceptedText.length < textAttachment.text.length
            ? "Note: The file was truncated at the safe context limit."
            : "",
          `\`\`\`${textAttachment.languageId}`,
          acceptedText,
          "```"
        ]
          .filter(Boolean)
          .join("\n")
      );
    }

    return {
      prompt: promptSections.length
        ? [
            "Use these explicitly attached files, images, and documents as private supporting context.",
            "If selected editor code is also supplied, the selected code remains primary.",
            ...promptSections
          ].join("\n\n")
        : "",
      images
    };
  }

  public release(requestedIds: readonly string[]): void {
    requestedIds.forEach((id) => {
      this.attachments.delete(id);
    });
  }

  public async displayInfo(
    requestedIds: readonly string[]
  ): Promise<readonly AttachmentDisplay[]> {
    const result: AttachmentDisplay[] = [];
    for (const id of requestedIds) {
      const attachment = this.attachments.get(id);
      if (!attachment) {
        continue;
      }
      if (attachment.summary.kind === "image") {
        let dataUri = attachment.summary.dataUri;
        if (!dataUri && attachment.uri) {
          const bytes = await vscode.workspace.fs.readFile(attachment.uri);
          const mimeType =
            sniffImageMimeType(bytes) ?? attachment.mimeType ?? "image/png";
          dataUri = `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
        }
        result.push({
          id,
          kind: "image",
          label: attachment.summary.label,
          dataUri
        });
        continue;
      }
      result.push({
        id,
        kind: attachment.summary.kind,
        label: attachment.summary.label
      });
    }
    return result;
  }

  private assertCapacity(additionalCount: number): void {
    if (this.attachments.size + additionalCount > MAX_ATTACHMENTS) {
      throw new Error(
        `GeminiX accepts up to ${MAX_ATTACHMENTS} context attachments per message.`
      );
    }
  }

  private async readTextAttachment(
    attachment: StoredAttachment,
    apiKey?: string
  ): Promise<
    | {
        readonly languageId: string;
        readonly relativePath: string;
        readonly text: string;
        readonly truncated: boolean;
      }
    | undefined
  > {
    if (attachment.currentPage) {
      return {
        languageId: attachment.currentPage.languageId,
        relativePath: attachment.currentPage.relativePath,
        text: attachment.currentPage.text,
        truncated: attachment.currentPage.truncated
      };
    }
    if (!attachment.uri) {
      return undefined;
    }

    try {
      const document = await vscode.workspace.openTextDocument(attachment.uri);
      const completeText = document.getText();
      if (!completeText.includes("\u0000")) {
        return {
          languageId: document.languageId || "text",
          relativePath: vscode.workspace.asRelativePath(attachment.uri, false),
          text: completeText,
          truncated: false
        };
      }
    } catch {
      // Fall through to binary extraction
    }

    // Binary file fallback through Google Vision extraction
    if (apiKey) {
      const bytes = await vscode.workspace.fs.readFile(attachment.uri);
      const ext = extname(attachment.uri.path).toLowerCase();
      const mimeType =
        DOCUMENT_MIME_TYPES.get(ext) ??
        IMAGE_MIME_TYPES.get(ext) ??
        "application/octet-stream";
      const extracted = await extractWithGoogleVision(
        bytes,
        mimeType,
        attachment.summary.label,
        "document",
        apiKey
      );
      if (extracted) {
        return {
          languageId: "markdown",
          relativePath: vscode.workspace.asRelativePath(attachment.uri, false),
          text: extracted,
          truncated: false
        };
      }
    }

    throw new Error(
      `${attachment.summary.label} is a binary file that could not be read.`
    );
  }
}
