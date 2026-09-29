export type TableAlignment = "left" | "center" | "right" | undefined;

export interface TextSegment {
  readonly type: "text";
  readonly text: string;
}

export interface CodeSegment {
  readonly type: "code";
  readonly language: string;
  readonly code: string;
  readonly closed: boolean;
}

export interface TableSegment {
  readonly type: "table";
  readonly header: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly alignments: readonly TableAlignment[];
}

export type RichContentSegment = TextSegment | CodeSegment | TableSegment;

interface ParsedRow {
  readonly cells: readonly string[];
  readonly delimiterCount: number;
}

const OPENING_FENCE_PATTERN = /^```([A-Za-z0-9_+#.-]*)[ \t]*$/u;
const CLOSING_FENCE_PATTERN = /^```[ \t]*$/u;
const SEPARATOR_CELL_PATTERN = /^:?-+:?$/u;
const RAW_SVG_OPEN_PATTERN = /^\s*<svg(?:\s|>|\/|$)/iu;
const RAW_SVG_CLOSE_PATTERN = /<\/svg>/iu;

export function parseRichContent(source: string): readonly RichContentSegment[] {
  if (!source) {
    return [];
  }

  const lines = source.split(/\r\n|\n|\r/u);
  const segments: RichContentSegment[] = [];
  const textLines: string[] = [];

  const flushText = (): void => {
    if (!textLines.length) {
      return;
    }

    const text = textLines.join("\n");
    if (text) {
      segments.push({ type: "text", text });
    }
    textLines.length = 0;
  };

  let lineIndex = 0;
  while (lineIndex < lines.length) {
    const line = lines[lineIndex] ?? "";
    const openingFence = OPENING_FENCE_PATTERN.exec(line);
    if (openingFence) {
      flushText();
      const codeLines: string[] = [];
      const language = openingFence[1] ?? "";
      let closed = false;
      lineIndex += 1;

      while (lineIndex < lines.length) {
        const codeLine = lines[lineIndex] ?? "";
        if (CLOSING_FENCE_PATTERN.test(codeLine)) {
          closed = true;
          lineIndex += 1;
          break;
        }
        codeLines.push(codeLine);
        lineIndex += 1;
      }

      segments.push({
        type: "code",
        language,
        code: codeLines.join("\n"),
        closed
      });
      continue;
    }

    if (RAW_SVG_OPEN_PATTERN.test(line)) {
      flushText();
      const codeLines: string[] = [line];
      let closed = false;

      if (RAW_SVG_CLOSE_PATTERN.test(line)) {
        closed = true;
        lineIndex += 1;
      } else {
        lineIndex += 1;
        while (lineIndex < lines.length) {
          const codeLine = lines[lineIndex] ?? "";
          codeLines.push(codeLine);
          if (RAW_SVG_CLOSE_PATTERN.test(codeLine)) {
            closed = true;
            lineIndex += 1;
            break;
          }
          lineIndex += 1;
        }
      }

      const svgCode = codeLines.join("\n");
      const svgSegment: CodeSegment = {
        type: "code",
        language: "svg",
        code: svgCode,
        closed
      };
      segments.push(svgSegment);
      continue;
    }

    const table = parseTableAt(lines, lineIndex);
    if (table) {
      flushText();
      segments.push(table.segment);
      lineIndex = table.nextLineIndex;
      continue;
    }

    textLines.push(line);
    lineIndex += 1;
  }

  flushText();
  return segments;
}

export function parseMarkdownRow(line: string): ParsedRow | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }

  const cells: string[] = [""];
  const delimiterIndexes: number[] = [];
  let inCodeSpan = false;

  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index] ?? "";
    const nextCharacter = trimmed[index + 1];
    const currentCellIndex = cells.length - 1;

    if (character === "\\" && nextCharacter !== undefined) {
      cells[currentCellIndex] =
        (cells[currentCellIndex] ?? "") + character + nextCharacter;
      index += 1;
      continue;
    }

    if (character === "`") {
      inCodeSpan = !inCodeSpan;
      cells[currentCellIndex] =
        (cells[currentCellIndex] ?? "") + character;
      continue;
    }

    if (character === "|" && !inCodeSpan) {
      delimiterIndexes.push(index);
      cells.push("");
      continue;
    }

    cells[currentCellIndex] =
      (cells[currentCellIndex] ?? "") + character;
  }

  if (!delimiterIndexes.length) {
    return undefined;
  }

  if (delimiterIndexes[0] === 0) {
    cells.shift();
  }
  if (delimiterIndexes.at(-1) === trimmed.length - 1) {
    cells.pop();
  }

  return {
    cells: cells.map((cell) => cell.trim()),
    delimiterCount: delimiterIndexes.length
  };
}

export function unescapeMarkdownPipes(value: string): string {
  return value.replace(/\\\|/gu, "|");
}

function parseTableAt(
  lines: readonly string[],
  headerIndex: number
):
  | {
      readonly segment: TableSegment;
      readonly nextLineIndex: number;
    }
  | undefined {
  const separatorLine = lines[headerIndex + 1];
  if (separatorLine === undefined) {
    return undefined;
  }

  const header = parseMarkdownRow(lines[headerIndex] ?? "");
  const separator = parseMarkdownRow(separatorLine);
  if (
    !header ||
    !separator ||
    header.cells.length < 2 ||
    separator.cells.length !== header.cells.length ||
    !separator.cells.every((cell) => SEPARATOR_CELL_PATTERN.test(cell))
  ) {
    return undefined;
  }

  const rows: string[][] = [];
  let nextLineIndex = headerIndex + 2;
  while (nextLineIndex < lines.length) {
    const candidateLine = lines[nextLineIndex] ?? "";
    if (!candidateLine.trim()) {
      break;
    }

    const candidate = parseMarkdownRow(candidateLine);
    if (!candidate || candidate.cells.length !== header.cells.length) {
      break;
    }

    rows.push([...candidate.cells]);
    nextLineIndex += 1;
  }

  return {
    segment: {
      type: "table",
      header: header.cells,
      rows,
      alignments: separator.cells.map(readAlignment)
    },
    nextLineIndex
  };
}

function readAlignment(separatorCell: string): TableAlignment {
  const left = separatorCell.startsWith(":");
  const right = separatorCell.endsWith(":");
  if (left && right) {
    return "center";
  }
  if (right) {
    return "right";
  }
  return "left";
}

export function stripMarkdownForSpeech(text: string): string {
  if (!text) {
    return "";
  }

  return (
    text
      // Remove fenced code blocks
      .replace(/```[\s\S]*?```/gu, "")
      // Remove raw SVG blocks
      .replace(/<svg[\s\S]*?<\/svg>/giu, "")
      // Remove inline code backticks while preserving the code text
      .replace(/`([^`]+)`/gu, "$1")
      // Remove any remaining stray backticks
      .replace(/`/gu, "")
      // Remove markdown images: ![alt](url) -> ""
      .replace(/!\[[^\]]*\]\([^)]*\)/gu, "")
      // Convert markdown links: [text](url) -> text
      .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
      // Remove header markers: #, ##, etc. at start of line
      .replace(/^#{1,6}\s+/gmu, "")
      // Remove bold/italic formatting
      .replace(/(\*\*|__)(.*?)\1/gu, "$2")
      .replace(/(\*|_)(.*?)\1/gu, "$2")
      .replace(/~~(.*?)~~/gu, "$1")
      // Remove blockquotes: > quote
      .replace(/^[ \t]*>[ \t]*/gmu, "")
      // Remove bullet lists: - item, * item, + item
      .replace(/^[ \t]*[-*+][ \t]+/gmu, "")
      // Remove numbered lists: 1. item, 2. item
      .replace(/^[ \t]*\d+\.[ \t]+/gmu, "")
      // Remove horizontal rules
      .replace(/^[ \t]*[-*_]{3,}[ \t]*$/gmu, "")
      // Remove HTML tags
      .replace(/<[^>]+>/gu, "")
      // Collapse multiple newlines into max two
      .replace(/\n{3,}/gu, "\n\n")
      // Collapse extra spaces
      .replace(/[ \t]+/gu, " ")
      .trim()
  );
}
