import assert from "node:assert/strict";
import test from "node:test";
import { createWebTools, parseSearchHtml } from "../src/webTools.ts";
import { describeImagePixels } from "../webview/imageContext.ts";

const html = `<a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.example.com%2Fguide&amp;rut=x" class="result__a">Official &amp; current</a>
<a class='result__snippet' href='https://docs.example.com/guide'>Read &quot;API&quot; documentation</a>
<a class="result__a" href="https://example.com/no-snippet">Without snippet</a>
<a class="result__a" href="https://example.com/no-snippet">Duplicate</a>
<a class="result__a" href="javascript:alert(1)">Bad link</a>`;

void test("search parses reordered attributes, redirects, entities, missing snippets, and duplicates", () => {
  assert.deepEqual(parseSearchHtml(html), [
    { title: "Official & current", url: "https://docs.example.com/guide", description: 'Read "API" documentation' },
    { title: "Without snippet", url: "https://example.com/no-snippet", description: "" }
  ]);
});

void test("omitting the source searches the general web", async () => {
  const urls: string[] = [];
  const web = createWebTools({ fetch: (input) => {
    urls.push(requestUrl(input));
    return Promise.resolve(new Response(html, { headers: { "content-type": "text/html" } }));
  } });
  assert.equal((await web.searchWebSource("VS Code extensions")).length, 2);
  assert.equal(urls.length, 1);
  assert.match(urls[0] ?? "", /html\.duckduckgo\.com/);
});

void test("provider outage and bot challenge are not reported as zero matches", async () => {
  const unavailable = createWebTools({ fetch: () => Promise.resolve(new Response("", { status: 429 })) });
  await assert.rejects(unavailable.searchWebSource("test"), /rate limited/);
  const challenged = createWebTools({ fetch: (input) => Promise.resolve(new Response(requestUrl(input).includes("duckduckgo")
    ? '<form class="anomaly-modal">challenge</form>' : '{"query":{"search":[]}}', { headers: { "content-type": "text/plain" } })) });
  await assert.rejects(challenged.searchWebSource("test"), /browser challenge/);
  await assert.rejects(unavailable.searchWebSource("test", "github"), /GitHub search unavailable/);
  await assert.rejects(unavailable.searchWebSource("node", "registry"), /rate limited/);
});

void test("a successful empty search is distinct from an unavailable provider", async () => {
  const web = createWebTools({ fetch: (input) => Promise.resolve(new Response(requestUrl(input).includes("duckduckgo")
    ? '<html>No results</html>' : '{"query":{"search":[]}}')) });
  assert.deepEqual(await web.searchWebSource("gibberish"), []);
});

void test("Stop cancels an in-flight search and prevents fallback requests", async () => {
  const controller = new AbortController();
  let requests = 0;
  const web = createWebTools({ signal: controller.signal, fetch: (_input, init) => {
    requests += 1;
    return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  } });
  const result = web.searchWebSource("test");
  controller.abort();
  await assert.rejects(result, /abort/i);
  assert.equal(requests, 1);
});

void test("web reader rejects huge bodies, binary files, and unsafe protocols", async () => {
  const huge = createWebTools({ maxBytes: 8, fetch: () => Promise.resolve(new Response("123456789")) });
  await assert.rejects(huge.fetchUrlAsText("https://example.com"), /limit/);
  const binary = createWebTools({ fetch: () => Promise.resolve(new Response("binary", { headers: { "content-type": "application/pdf" } })) });
  await assert.rejects(binary.fetchUrlAsText("https://example.com/a.pdf"), /Unsupported/);
  await assert.rejects(binary.fetchUrlAsText("file:///etc/passwd"), /HTTP/);
  await assert.rejects(binary.fetchUrlAsText("https://user:pass@example.com"), /credentials/);
});

void test("web reader reports bounded timeout instead of hanging", async () => {
  const web = createWebTools({ timeoutMs: 5, fetch: (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("abort")), { once: true });
  }) });
  await assert.rejects(web.fetchUrlAsText("https://example.com"), /timed out/);
});

void test("image context is a bounded local text representation with explicit limitations", () => {
  const description = describeImagePixels(2, 1, new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]));
  assert.match(description, /not OCR or object detection/);
  assert.match(description, /Luminance grid/);
  assert.match(description, /RGB matrix/);
  assert.match(description, /<svg/);
  assert.doesNotMatch(description, /base64|inlineData/);
  assert.throws(() => describeImagePixels(64, 64, new Uint8ClampedArray()), /Invalid/);
});

function requestUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}
