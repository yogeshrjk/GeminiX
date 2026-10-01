export interface WebSearchResult {
  readonly title: string;
  readonly url: string;
  readonly description: string;
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity: string, code: string) => {
    if (code.startsWith("#")) {
      const hex = code[1]?.toLowerCase() === "x";
      const point = parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
    }
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " } as Record<string, string>)[code.toLowerCase()] ?? entity;
  });
}

/** Attribute order and missing snippets vary between search result pages. */
export function parseSearchHtml(html: string): readonly WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const seen = new Set<string>();
  const anchors = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)];
  const attribute = (attrs: string, name: string): string =>
    new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i").exec(attrs)?.[2] ?? "";
  const clean = (text: string): string => decodeEntities(text.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
  for (let index = 0; index < anchors.length && results.length < 8; index += 1) {
    const anchor = anchors[index];
    if (!anchor || !attribute(anchor[1] ?? "", "class").split(/\s+/).includes("result__a")) continue;
    try {
      const href = decodeEntities(attribute(anchor[1] ?? "", "href"));
      if (!href) continue;
      const target = new URL(href, "https://duckduckgo.com");
      const url = new URL(target.searchParams.get("uddg") ?? target.href);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password || seen.has(url.href)) continue;
      seen.add(url.href);
      let description = "";
      for (let next = index + 1; next < anchors.length; next += 1) {
        const candidate = anchors[next];
        const classes = attribute(candidate?.[1] ?? "", "class");
        if (/\bresult__a\b/.test(classes)) break;
        if (/\bresult__snippet\b/.test(classes)) { description = clean(candidate?.[2] ?? ""); break; }
      }
      results.push({ title: clean(anchor[2] ?? "") || url.hostname, url: url.href, description });
    } catch { /* Skip malformed URLs without discarding the other results. */ }
  }
  return results;
}

export interface WebToolsOptions {
  readonly signal?: AbortSignal;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

/** One instance per tool call allows Stop/session changes to cancel all requests. */
export function createWebTools(options: WebToolsOptions = {}) {
const MAX_URL_TEXT_CHARS = 60_000;

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
  const parsedUrl = new URL(url);
  if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
    throw new Error("Only HTTP(S) URLs without embedded credentials are supported.");
  }
  options.signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => {
    controller.abort();
  }, options.timeoutMs ?? 15_000);
  try {
    const response = await (options.fetch ?? fetch)(url, {
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
      await response.body?.cancel();
      throw new Error(response.status === 429
        ? "The source is rate limited (HTTP 429). Please retry later."
        : `HTTP ${response.status} ${response.statusText}`);
    }
    const maxBytes = options.maxBytes ?? 2_000_000;
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType && !/text\/|json|xml|javascript/i.test(contentType)) {
      await response.body?.cancel();
      throw new Error(`Unsupported web content type: ${contentType}. Open a readable HTML or text page.`);
    }
    if (Number(response.headers.get("content-length")) > maxBytes) {
      await response.body?.cancel();
      throw new Error("The page exceeds the 2 MB web-reading limit.");
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    if (reader) {
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > maxBytes) throw new Error("The page exceeds the web-reading limit.");
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
    }
    return { body: Buffer.concat(chunks).toString("utf8"), contentType };
  } catch (error) {
    options.signal?.throwIfAborted();
    if (controller.signal.aborted) throw new Error("The web request timed out. Try a narrower query or another source.");
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}

function stripHtml(html: string): string {
  return decodeEntities(html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim());
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
      options.signal?.throwIfAborted();
      // Try the next README candidate.
    }
  }
  return undefined;
}

const WIKIPEDIA_SEARCH_URL =
  "https://en.wikipedia.org/w/api.php?action=query&list=search&srlimit=5&format=json&formatversion=2";

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

async function searchDuckDuckGo(query: string): Promise<readonly WebSearchResult[]> {
  const { body } = await fetchWithTimeout(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
  );
  if (/anomaly\.js|anomaly-modal|Unfortunately, bots use DuckDuckGo/i.test(body)) {
    throw new Error("The search provider requested a browser challenge. Try a specific source such as mdn, github, or registry.");
  }
  return parseSearchHtml(body);
}

async function searchWebSource(
  query: string,
  source = "web",
): Promise<readonly WebSearchResult[]> {
  query = query.trim();
  if (!query) throw new Error("A non-empty search query is required.");
  if (query.length > 1_000) throw new Error("Search query is too long; use a focused phrase.");
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
      const failures: string[] = [];
      for (const search of [searchDuckDuckGo, searchWikipedia]) {
        try {
          const results = await search(query);
          if (results.length) return results;
        } catch (error) {
          options.signal?.throwIfAborted();
          failures.push(error instanceof Error ? error.message : "Search unavailable");
        }
      }
      if (failures.length) throw new Error(`Search incomplete: ${failures.join("; ")}`);
      return [];
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

  const failures: string[] = [];
  for (const variant of [...variations].slice(0, 2)) {
    try {
      const [usersRes, reposRes] = await Promise.allSettled([
        fetchWithTimeout(
          `https://api.github.com/search/users?q=${encodeURIComponent(variant)}&per_page=5`,
        ),
        fetchWithTimeout(
          `https://api.github.com/search/repositories?q=${encodeURIComponent(variant)}&per_page=5`,
        ),
      ]);
      for (const result of [usersRes, reposRes]) {
        if (result.status === "rejected") {
          options.signal?.throwIfAborted();
          failures.push(result.reason instanceof Error ? result.reason.message : "GitHub search failed");
        }
      }

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
    } catch (error) {
      options.signal?.throwIfAborted();
      failures.push(error instanceof Error ? error.message : "GitHub search failed");
    }
  }

  if (!results.length && failures.length) throw new Error(`GitHub search unavailable: ${failures[0] ?? "request failed"}`);
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
    } catch (error) {
      options.signal?.throwIfAborted();
      throw error;
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
  } catch (error) {
    options.signal?.throwIfAborted();
    if (!(error instanceof Error) || !/HTTP 404\b/.test(error.message)) throw error;
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
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof Error && /HTTP 404\b/.test(error.message)) return [];
    throw error;
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
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof Error && /HTTP 404\b/.test(error.message)) return [];
    throw error;
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
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof Error && /HTTP 404\b/.test(error.message)) return [];
    throw error;
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
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof Error && /HTTP 404\b/.test(error.message)) return [];
    throw error;
  }
}


return { fetchUrlAsText, searchWebSource };
}

export const { fetchUrlAsText, searchWebSource } = createWebTools();
