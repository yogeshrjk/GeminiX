import { basename, extname } from "node:path";
import * as vscode from "vscode";
import type {
  EditorContext,
  WorkspaceContext,
  WorkspaceSnippet
} from "./types.js";

const SOURCE_GLOB =
  "**/*.{c,cc,cpp,cs,css,dart,go,h,hpp,html,java,js,jsx,json,jsonc,kt,kts,md,php,py,rb,rs,scss,sh,sql,svelte,swift,ts,tsx,vue,yaml,yml}";
const EXCLUDE_GLOB =
  "**/{.git,.next,.nuxt,.output,.venv,build,coverage,dist,node_modules,out,target,vendor}/**";
const SOURCE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".dart",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".jsx",
  ".json",
  ".jsonc",
  ".kt",
  ".kts",
  ".md",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".svelte",
  ".swift",
  ".ts",
  ".tsx",
  ".vue",
  ".yaml",
  ".yml"
]);
const EXCLUDED_SEGMENTS = new Set([
  ".git",
  ".next",
  ".nuxt",
  ".output",
  ".venv",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "vendor"
]);
const LANGUAGE_KEYWORDS = new Set([
  "abstract",
  "async",
  "await",
  "boolean",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "default",
  "delete",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "float",
  "for",
  "from",
  "function",
  "if",
  "implements",
  "import",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "number",
  "package",
  "private",
  "protected",
  "public",
  "readonly",
  "return",
  "static",
  "string",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "type",
  "typeof",
  "undefined",
  "var",
  "void",
  "while",
  "with",
  "yield"
]);

const MAX_INDEXED_FILES = 1_500;
const MAX_FILE_BYTES = 384 * 1_024;
const MAX_TOKENS_PER_FILE = 2_000;
const MAX_SEARCH_TERMS = 10;
const MAX_WORKSPACE_SYMBOL_QUERIES = 4;
const MAX_SNIPPETS = 7;
const MAX_SNIPPET_LINES = 70;
const SNIPPET_PADDING_LINES = 12;
const MAX_CONTEXT_CHARACTERS = 24_000;
const MAX_DIRECT_FILE_CHARACTERS = 20_000;
const MAX_DIRECT_FILE_LINES = 300;
const MAX_TOOL_FILE_CHARACTERS = 30_000;
const MAX_TOOL_FILE_LINES = 300;
const INITIAL_INDEX_WAIT_MS = 2_000;

interface IndexedFile {
  readonly uri: vscode.Uri;
  readonly relativePath: string;
  readonly tokens: ReadonlySet<string>;
}

interface Candidate {
  readonly uri: vscode.Uri;
  score: number;
  anchorLine?: number;
  directFile?: boolean;
  reason: string;
}

interface SymbolRange {
  readonly name: string;
  readonly range: vscode.Range;
}

export interface WorkspaceFileRead {
  readonly uri: vscode.Uri;
  readonly filePath: string;
  readonly languageId: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
  readonly totalLines: number;
  readonly truncated: boolean;
}

export class WorkspaceContextRetriever implements vscode.Disposable {
  private readonly files = new Map<string, IndexedFile>();
  private readonly tokenFiles = new Map<string, Set<string>>();
  private readonly updateTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly watcher: vscode.FileSystemWatcher;
  private indexPromise: Promise<void> | undefined;

  public constructor() {
    this.watcher = vscode.workspace.createFileSystemWatcher(SOURCE_GLOB);
    this.watcher.onDidCreate((uri) => {
      this.scheduleIndexUpdate(uri);
    });
    this.watcher.onDidChange((uri) => {
      this.scheduleIndexUpdate(uri);
    });
    this.watcher.onDidDelete((uri) => {
      this.removeIndexedFile(uri.toString());
    });

    if (vscode.workspace.workspaceFolders?.length) {
      void this.ensureIndex();
    }
  }

  public async retrieve(
    userText: string,
    primaryContext: EditorContext | undefined
  ): Promise<WorkspaceContext> {
    if (!vscode.workspace.workspaceFolders?.length) {
      return { snippets: [], indexedFileCount: 0, truncated: false };
    }

    const fileHints = extractFileHints(userText);
    const indexPromise = this.ensureIndex();
    if (fileHints.length) {
      await indexPromise;
    } else {
      await Promise.race([
        indexPromise,
        new Promise<void>((resolve) => {
          setTimeout(resolve, INITIAL_INDEX_WAIT_MS);
        })
      ]);
    }

    const rankedTerms = rankSearchTerms(
      userText,
      primaryContext?.text ?? ""
    );
    const terms = rankedTerms.length
      ? rankedTerms
      : fileHints
          .map((hint) => basename(hint, extname(hint)))
          .filter(Boolean)
          .slice(0, MAX_SEARCH_TERMS);
    if (!terms.length) {
      return {
        snippets: [],
        indexedFileCount: this.files.size,
        truncated: false
      };
    }

    const candidates = this.rankLexicalCandidates(
      terms,
      primaryContext?.uri
    );
    await this.addDirectFileCandidates(
      fileHints,
      candidates,
      primaryContext?.uri
    );
    await this.addWorkspaceSymbolCandidates(terms, candidates);

    const snippets: WorkspaceSnippet[] = [];
    if (primaryContext) {
      const enclosingSnippet = await this.createEnclosingSymbolSnippet(
        primaryContext
      );
      if (enclosingSnippet) {
        snippets.push(enclosingSnippet);
      }
    }

    const rankedCandidates = [...candidates.values()]
      .sort((left, right) => right.score - left.score)
      .slice(0, MAX_SNIPPETS * 2);

    for (const candidate of rankedCandidates) {
      if (snippets.length >= MAX_SNIPPETS) {
        break;
      }

      const snippet = await this.createCandidateSnippet(candidate, terms);
      if (
        snippet &&
        !snippets.some(
          (existing) =>
            existing.filePath === snippet.filePath &&
            existing.startLine === snippet.startLine &&
            existing.endLine === snippet.endLine
        )
      ) {
        snippets.push(snippet);
      }
    }

    return limitContextCharacters(snippets, this.files.size);
  }

  public async readFile(
    requestedPath: string,
    requestedStartLine?: number,
    requestedEndLine?: number
  ): Promise<WorkspaceFileRead> {
    if (!vscode.workspace.workspaceFolders?.length) {
      throw new Error("No VS Code workspace is open.");
    }

    const normalizedPath = normalizeRelativePath(requestedPath);
    if (!normalizedPath) {
      throw new Error("A workspace-relative file path is required.");
    }

    await this.ensureIndex();
    let matchingFiles = [...this.files.values()].filter((file) => {
      const candidatePath = normalizeRelativePath(file.relativePath);
      return (
        candidatePath === normalizedPath ||
        candidatePath.endsWith(`/${normalizedPath}`)
      );
    });
    if (!matchingFiles.length) {
      const requestedName = basename(normalizedPath);
      matchingFiles = [...this.files.values()].filter(
        (file) =>
          basename(normalizeRelativePath(file.relativePath)) === requestedName
      );
    }
    if (!matchingFiles.length && isSafeFileName(basename(normalizedPath))) {
      const discoveredUris = await vscode.workspace.findFiles(
        `**/${basename(normalizedPath)}`,
        EXCLUDE_GLOB,
        20
      );
      matchingFiles = discoveredUris
        .filter(isSourceFile)
        .map((uri) => ({
          uri,
          relativePath: vscode.workspace.asRelativePath(uri, false),
          tokens: new Set<string>()
        }));
    }
    if (!matchingFiles.length) {
      throw new Error(`Workspace file not found: ${requestedPath}`);
    }

    matchingFiles.sort(
      (left, right) => left.relativePath.length - right.relativePath.length
    );
    const selectedFile = matchingFiles[0];
    if (!selectedFile) {
      throw new Error(`Workspace file not found: ${requestedPath}`);
    }

    const document = await vscode.workspace.openTextDocument(selectedFile.uri);
    const startLine = clampLineNumber(
      requestedStartLine,
      1,
      document.lineCount
    );
    const defaultEndLine = Math.min(
      document.lineCount,
      startLine + MAX_TOOL_FILE_LINES - 1
    );
    const requestedEnd = clampLineNumber(
      requestedEndLine,
      defaultEndLine,
      document.lineCount
    );
    const endLine = Math.min(
      document.lineCount,
      Math.max(startLine, requestedEnd),
      startLine + MAX_TOOL_FILE_LINES - 1
    );
    const range = new vscode.Range(
      startLine - 1,
      0,
      endLine - 1,
      Number.MAX_SAFE_INTEGER
    );
    const completeRangeText = document.getText(range);
    const text = completeRangeText.slice(0, MAX_TOOL_FILE_CHARACTERS);

    return {
      uri: selectedFile.uri,
      filePath: selectedFile.relativePath,
      languageId: document.languageId,
      startLine,
      endLine,
      text,
      totalLines: document.lineCount,
      truncated:
        endLine < document.lineCount ||
        text.length < completeRangeText.length
    };
  }

  public dispose(): void {
    this.watcher.dispose();
    for (const timer of this.updateTimers.values()) {
      clearTimeout(timer);
    }
    this.updateTimers.clear();
    this.files.clear();
    this.tokenFiles.clear();
  }

  private ensureIndex(): Promise<void> {
    this.indexPromise ??= this.buildIndex();
    return this.indexPromise;
  }

  private async buildIndex(): Promise<void> {
    const uris = await vscode.workspace.findFiles(
      SOURCE_GLOB,
      EXCLUDE_GLOB,
      MAX_INDEXED_FILES
    );

    const workerCount = Math.min(8, uris.length);
    let cursor = 0;
    const workers = Array.from({ length: workerCount }, async () => {
      while (cursor < uris.length) {
        const uri = uris[cursor];
        cursor += 1;
        if (uri) {
          await this.indexFile(uri);
        }
      }
    });
    await Promise.all(workers);
  }

  private scheduleIndexUpdate(uri: vscode.Uri): void {
    if (!isSourceFile(uri)) {
      return;
    }

    const key = uri.toString();
    const existingTimer = this.updateTimers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.updateTimers.delete(key);
      void this.indexFile(uri);
    }, 250);
    this.updateTimers.set(key, timer);
  }

  private async indexFile(uri: vscode.Uri): Promise<void> {
    if (!isSourceFile(uri)) {
      return;
    }

    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > MAX_FILE_BYTES) {
        this.removeIndexedFile(uri.toString());
        return;
      }

      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      if (text.includes("\u0000")) {
        return;
      }

      const relativePath = vscode.workspace.asRelativePath(uri, false);
      const tokens = collectIndexTokens(`${relativePath}\n${text}`);
      const key = uri.toString();
      this.removeIndexedFile(key);

      const indexedFile: IndexedFile = {
        uri,
        relativePath,
        tokens
      };
      this.files.set(key, indexedFile);

      for (const token of tokens) {
        let matchingFiles = this.tokenFiles.get(token);
        if (!matchingFiles) {
          matchingFiles = new Set<string>();
          this.tokenFiles.set(token, matchingFiles);
        }
        matchingFiles.add(key);
      }
    } catch {
      this.removeIndexedFile(uri.toString());
    }
  }

  private removeIndexedFile(key: string): void {
    const previous = this.files.get(key);
    if (!previous) {
      return;
    }

    this.files.delete(key);
    for (const token of previous.tokens) {
      const matchingFiles = this.tokenFiles.get(token);
      matchingFiles?.delete(key);
      if (matchingFiles?.size === 0) {
        this.tokenFiles.delete(token);
      }
    }
  }

  private rankLexicalCandidates(
    terms: readonly string[],
    primaryUri: string | undefined
  ): Map<string, Candidate> {
    const candidates = new Map<string, Candidate>();

    for (const [termIndex, term] of terms.entries()) {
      const matchingFiles = this.tokenFiles.get(term.toLowerCase());
      if (!matchingFiles?.size || matchingFiles.size > 120) {
        continue;
      }

      const rarityScore = Math.max(1, 8 - Math.log2(matchingFiles.size + 1));
      const termScore = rarityScore + (MAX_SEARCH_TERMS - termIndex) * 0.35;
      for (const key of matchingFiles) {
        if (key === primaryUri) {
          continue;
        }

        const indexedFile = this.files.get(key);
        if (!indexedFile) {
          continue;
        }

        const candidate = candidates.get(key) ?? {
          uri: indexedFile.uri,
          score: 0,
          reason: `Matches ${term}`
        };
        candidate.score += termScore;
        if (
          indexedFile.relativePath.toLowerCase().includes(term.toLowerCase())
        ) {
          candidate.score += 4;
        }
        candidates.set(key, candidate);
      }
    }

    return candidates;
  }

  private async addDirectFileCandidates(
    fileHints: readonly string[],
    candidates: Map<string, Candidate>,
    primaryUri: string | undefined
  ): Promise<void> {
    if (!fileHints.length) {
      return;
    }

    for (const [key, indexedFile] of this.files) {
      if (key === primaryUri) {
        continue;
      }

      const normalizedPath = indexedFile.relativePath
        .replaceAll("\\", "/")
        .toLowerCase();
      const fileName = basename(normalizedPath);
      const matchingHint = fileHints.find((hint) => {
        const normalizedHint = hint
          .replaceAll("\\", "/")
          .replace(/^(\.\.\/|\.\/)+/, "")
          .toLowerCase();
        return (
          fileName === basename(normalizedHint) ||
          normalizedPath.endsWith(normalizedHint) ||
          normalizedPath.includes(normalizedHint)
        );
      });
      if (!matchingHint) {
        continue;
      }

      const existing = candidates.get(key) ?? {
        uri: indexedFile.uri,
        score: 0,
        reason: `Requested file ${matchingHint}`
      };
      existing.score += 100;
      existing.directFile = true;
      existing.reason = `Requested file ${matchingHint}`;
      candidates.set(key, existing);
    }

    const discoveredFiles = await Promise.all(
      fileHints.map(async (hint) => {
        const fileName = basename(normalizeRelativePath(hint));
        if (!isSafeFileName(fileName)) {
          return [];
        }
        return vscode.workspace.findFiles(
          `**/${fileName}`,
          EXCLUDE_GLOB,
          20
        );
      })
    );
    for (const [hintIndex, uris] of discoveredFiles.entries()) {
      const hint = fileHints[hintIndex] ?? "requested file";
      for (const uri of uris) {
        const key = uri.toString();
        if (key === primaryUri || !isSourceFile(uri)) {
          continue;
        }
        const existing = candidates.get(key) ?? {
          uri,
          score: 0,
          reason: `Requested file ${hint}`
        };
        existing.score += 100;
        existing.directFile = true;
        existing.reason = `Requested file ${hint}`;
        candidates.set(key, existing);
      }
    }
  }

  private async addWorkspaceSymbolCandidates(
    terms: readonly string[],
    candidates: Map<string, Candidate>
  ): Promise<void> {
    const symbolResults = await Promise.all(
      terms.slice(0, MAX_WORKSPACE_SYMBOL_QUERIES).map(async (term) => {
        try {
          return await vscode.commands.executeCommand<
            vscode.SymbolInformation[]
          >(
            "vscode.executeWorkspaceSymbolProvider",
            term
          );
        } catch {
          return [];
        }
      })
    );

    for (const symbols of symbolResults) {
      for (const symbol of symbols.slice(0, 8)) {
        const key = symbol.location.uri.toString();
        const existing = candidates.get(key) ?? {
          uri: symbol.location.uri,
          score: 0,
          reason: `Defines symbol ${symbol.name}`
        };
        existing.score += 12;
        existing.anchorLine = symbol.location.range.start.line;
        existing.reason = `Defines symbol ${symbol.name}`;
        candidates.set(key, existing);
      }
    }
  }

  private async createEnclosingSymbolSnippet(
    context: EditorContext
  ): Promise<WorkspaceSnippet | undefined> {
    const uri = vscode.Uri.parse(context.uri);
    const symbols = await getDocumentSymbols(uri);
    const selectionRange = new vscode.Range(
      Math.max(0, context.startLine - 1),
      0,
      Math.max(0, context.endLine - 1),
      Number.MAX_SAFE_INTEGER
    );
    const enclosing = symbols
      .filter((symbol) => symbol.range.contains(selectionRange))
      .sort(
        (left, right) =>
          lineCount(left.range) - lineCount(right.range)
      )[0];

    if (!enclosing || lineCount(enclosing.range) <= context.endLine - context.startLine + 3) {
      return undefined;
    }

    const document = await vscode.workspace.openTextDocument(uri);
    const range = clampRange(enclosing.range, document.lineCount);
    return {
      filePath: vscode.workspace.asRelativePath(uri, false),
      languageId: document.languageId,
      startLine: range.start.line + 1,
      endLine: range.end.line + 1,
      text: document.getText(range),
      reason: `Enclosing symbol ${enclosing.name}`
    };
  }

  private async createCandidateSnippet(
    candidate: Candidate,
    terms: readonly string[]
  ): Promise<WorkspaceSnippet | undefined> {
    try {
      const document = await vscode.workspace.openTextDocument(candidate.uri);
      const completeText = document.getText();
      if (completeText.length > MAX_FILE_BYTES) {
        return undefined;
      }

      if (
        candidate.directFile &&
        completeText.length <= MAX_DIRECT_FILE_CHARACTERS &&
        document.lineCount <= MAX_DIRECT_FILE_LINES
      ) {
        return {
          filePath: vscode.workspace.asRelativePath(candidate.uri, false),
          languageId: document.languageId,
          startLine: 1,
          endLine: document.lineCount,
          text: completeText,
          reason: candidate.reason
        };
      }

      const symbols = await getDocumentSymbols(candidate.uri);
      const matchingSymbol = symbols
        .filter((symbol) =>
          terms.some((term) =>
            symbol.name.toLowerCase().includes(term.toLowerCase())
          )
        )
        .sort(
          (left, right) =>
            lineCount(left.range) - lineCount(right.range)
        )[0];

      let range: vscode.Range;
      let reason = candidate.reason;
      if (matchingSymbol && lineCount(matchingSymbol.range) <= MAX_SNIPPET_LINES) {
        range = matchingSymbol.range;
        reason = `Relevant symbol ${matchingSymbol.name}`;
      } else {
        const anchorLine =
          candidate.anchorLine ?? findBestMatchingLine(document, terms);
        range = new vscode.Range(
          Math.max(0, anchorLine - SNIPPET_PADDING_LINES),
          0,
          Math.min(
            document.lineCount - 1,
            anchorLine + SNIPPET_PADDING_LINES
          ),
          Number.MAX_SAFE_INTEGER
        );
      }

      const safeRange = clampRange(range, document.lineCount);
      return {
        filePath: vscode.workspace.asRelativePath(candidate.uri, false),
        languageId: document.languageId,
        startLine: safeRange.start.line + 1,
        endLine: safeRange.end.line + 1,
        text: document.getText(safeRange),
        reason
      };
    } catch {
      return undefined;
    }
  }
}

function normalizeRelativePath(value: string): string {
  return value
    .trim()
    .replaceAll("\\", "/")
    .replace(/^(\.\.\/|\.\/|\/)+/, "")
    .toLowerCase();
}

function clampLineNumber(
  value: number | undefined,
  fallback: number,
  maximum: number
): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(1, Math.floor(value)));
}

function isSafeFileName(value: string): boolean {
  return /^[.@\w-]+\.[A-Za-z0-9]+$/u.test(value);
}

function isSourceFile(uri: vscode.Uri): boolean {
  if (!SOURCE_EXTENSIONS.has(extname(uri.path).toLowerCase())) {
    return false;
  }

  return !uri.path
    .split("/")
    .some((segment) => EXCLUDED_SEGMENTS.has(segment.toLowerCase()));
}

function collectIndexTokens(text: string): ReadonlySet<string> {
  const tokens = new Set<string>();
  const identifierPattern = /[$A-Z_a-z][$\w]{2,}/g;
  for (const match of text.matchAll(identifierPattern)) {
    const token = match[0].toLowerCase();
    if (!LANGUAGE_KEYWORDS.has(token)) {
      tokens.add(token);
      if (tokens.size >= MAX_TOKENS_PER_FILE) {
        break;
      }
    }
  }
  return tokens;
}

function rankSearchTerms(
  userText: string,
  selectedText: string
): readonly string[] {
  const scores = new Map<string, { original: string; score: number }>();
  scoreTerms(userText, 8, scores);
  scoreTerms(selectedText, 3, scores);

  return [...scores.values()]
    .sort((left, right) => right.score - left.score)
    .slice(0, MAX_SEARCH_TERMS)
    .map((entry) => entry.original);
}

function extractFileHints(text: string): readonly string[] {
  const extensionPattern =
    "(?:c|cc|cpp|cs|css|dart|go|h|hpp|html|java|js|jsx|json|jsonc|kt|kts|md|php|py|rb|rs|scss|sh|sql|svelte|swift|ts|tsx|vue|yaml|yml)";
  const filePattern = new RegExp(
    `(?:^|[\\s"'\\x60(])((?:[.@\\w-]+[\\\\/])*[.@\\w-]+\\.${extensionPattern})(?=$|[\\s"'\\x60),:;?])`,
    "giu"
  );
  const hints = new Set<string>();
  for (const match of text.matchAll(filePattern)) {
    const hint = match[1]?.trim();
    if (hint) {
      hints.add(hint);
    }
  }
  return [...hints];
}

function scoreTerms(
  text: string,
  baseScore: number,
  scores: Map<string, { original: string; score: number }>
): void {
  const identifierPattern = /[$A-Z_a-z][$\w]{2,}/g;
  for (const match of text.matchAll(identifierPattern)) {
    const original = match[0];
    if (!original) {
      continue;
    }

    const normalized = original.toLowerCase();
    if (LANGUAGE_KEYWORDS.has(normalized)) {
      continue;
    }

    const nextCharacter = text[match.index + original.length];
    const symbolBonus =
      nextCharacter === "(" ||
      /[A-Z]/.test(original.slice(1)) ||
      original.includes("_")
        ? 4
        : 0;
    const previous = scores.get(normalized);
    scores.set(normalized, {
      original,
      score: (previous?.score ?? 0) + baseScore + symbolBonus
    });
  }
}

async function getDocumentSymbols(
  uri: vscode.Uri
): Promise<readonly SymbolRange[]> {
  try {
    const symbols = await vscode.commands.executeCommand<
      (vscode.DocumentSymbol | vscode.SymbolInformation)[]
    >("vscode.executeDocumentSymbolProvider", uri);
    return flattenSymbols(symbols);
  } catch {
    return [];
  }
}

function flattenSymbols(
  symbols: readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[]
): readonly SymbolRange[] {
  const flattened: SymbolRange[] = [];

  for (const symbol of symbols) {
    if (symbol instanceof vscode.DocumentSymbol) {
      flattened.push({ name: symbol.name, range: symbol.range });
      flattened.push(...flattenSymbols(symbol.children));
    } else {
      flattened.push({
        name: symbol.name,
        range: symbol.location.range
      });
    }
  }

  return flattened;
}

function findBestMatchingLine(
  document: vscode.TextDocument,
  terms: readonly string[]
): number {
  let bestLine = 0;
  let bestScore = -1;
  const normalizedTerms = terms.map((term) => term.toLowerCase());

  for (let lineIndex = 0; lineIndex < document.lineCount; lineIndex += 1) {
    const lineText = document.lineAt(lineIndex).text.toLowerCase();
    const score = normalizedTerms.reduce(
      (total, term, termIndex) =>
        total + (lineText.includes(term) ? terms.length - termIndex : 0),
      0
    );
    if (score > bestScore) {
      bestLine = lineIndex;
      bestScore = score;
    }
  }

  return bestLine;
}

function clampRange(
  range: vscode.Range,
  documentLineCount: number
): vscode.Range {
  const lastLine = Math.max(0, documentLineCount - 1);
  const startLine = Math.min(range.start.line, lastLine);
  const endLine = Math.min(
    Math.max(startLine, range.end.line),
    Math.min(lastLine, startLine + MAX_SNIPPET_LINES - 1)
  );
  return new vscode.Range(
    startLine,
    0,
    endLine,
    Number.MAX_SAFE_INTEGER
  );
}

function lineCount(range: vscode.Range): number {
  return range.end.line - range.start.line + 1;
}

function limitContextCharacters(
  snippets: readonly WorkspaceSnippet[],
  indexedFileCount: number
): WorkspaceContext {
  const accepted: WorkspaceSnippet[] = [];
  let characterCount = 0;

  for (const snippet of snippets) {
    const nextCount = characterCount + snippet.text.length;
    if (nextCount > MAX_CONTEXT_CHARACTERS) {
      return {
        snippets: accepted,
        indexedFileCount,
        truncated: true
      };
    }
    accepted.push(snippet);
    characterCount = nextCount;
  }

  return {
    snippets: accepted,
    indexedFileCount,
    truncated: false
  };
}
