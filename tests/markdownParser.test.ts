import assert from "node:assert/strict";
import test from "node:test";
import {
  parseRichContent,
  stripMarkdownForSpeech,
  type TableSegment
} from "../webview/markdownParser.ts";

function readOnlyTable(markdown: string): TableSegment {
  const segments = parseRichContent(markdown);
  assert.equal(segments.length, 1);
  const table = segments[0];
  assert.equal(table?.type, "table");
  return table;
}

void test("parses tables with outer pipes", () => {
  const table = readOnlyTable(
    "| Step | Description |\n| --- | --- |\n| Validation | Prevents empty input |"
  );
  assert.deepEqual(table.header, ["Step", "Description"]);
  assert.deepEqual(table.rows, [["Validation", "Prevents empty input"]]);
});

void test("parses tables without outer pipes", () => {
  const table = readOnlyTable(
    "Step | Description\n--- | ---\nValidation | Prevents empty input"
  );
  assert.deepEqual(table.header, ["Step", "Description"]);
  assert.deepEqual(table.rows, [["Validation", "Prevents empty input"]]);
});

void test("preserves escaped pipes and pipes inside inline code", () => {
  const table = readOnlyTable(
    "| Left | Right |\n| --- | --- |\n| left \\| right | `left | right` |"
  );
  assert.deepEqual(table.rows, [["left \\| right", "`left | right`"]]);
});

void test("supports table alignment markers", () => {
  const table = readOnlyTable(
    "| Left | Right | Center |\n| :--- | ---: | :---: |\n| a | b | c |"
  );
  assert.deepEqual(table.alignments, ["left", "right", "center"]);
});

void test("stops a table before trailing prose", () => {
  const segments = parseRichContent(
    "| Step | Description |\n| --- | --- |\n| Validation | Prevents empty input |\nThis sentence follows the table."
  );
  assert.equal(segments[0]?.type, "table");
  assert.equal(segments[1]?.type, "text");
  assert.match(segments[1].text, /follows the table/u);
});

void test("keeps a malformed extra-cell row out of a two-column table", () => {
  const segments = parseRichContent(
    "| Step | Description |\n| --- | --- |\n| Validation | Prevents empty input |\n| Extra | row | prose"
  );
  const table = segments[0];
  assert.equal(table?.type, "table");
  assert.deepEqual(table.rows, [["Validation", "Prevents empty input"]]);
  assert.equal(segments[1]?.type, "text");
});

void test("parses complete and incomplete streamed code fences", () => {
  const complete = parseRichContent(
    "Before\n```python\nfrom django.db.models import F, Q\n```\nAfter"
  );
  assert.equal(complete[1]?.type, "code");
  assert.equal(complete[1].closed, true);
  assert.equal(complete[1].code, "from django.db.models import F, Q");

  const incomplete = parseRichContent("```ts\nconst value = 1;");
  assert.equal(incomplete[0]?.type, "code");
  assert.equal(incomplete[0].closed, false);
});

void test("accepts CRLF fences and preserves code indentation and empty lines", () => {
  const segments = parseRichContent(
    "```python\r\nif ready:\r\n    run()\r\n\r\n    stop()\r\n```"
  );
  assert.equal(segments[0]?.type, "code");
  assert.equal(segments[0].code, "if ready:\n    run()\n\n    stop()");
});

void test("parses the Django F and Q answer as prose, Python, then prose", () => {
  const source = [
    "Django mein, `F` expressions database fields ko refer karte hain, query ke andar hi. Yeh database-level par operations karne mein madad karte hain, jaise kisi field ki value badhana, Python mein data load kiye bina. Aur `Q` objects complex queries banane ke liye use hote hain, jahan `OR`, `AND`, ya `NOT` logic ki zaroorat ho. Aap conditions ko combine kar sakte hain. Yeh rahe generic examples:",
    "",
    "```python",
    "from django.db.models import F, Q",
    "from .models import Product, User",
    "",
    "# F expression example: Increment all product prices by 10",
    "Product.objects.update(price=F('price') + 10)",
    "",
    "# Q object example: Find users named 'Alice' OR 'Bob'",
    "users = User.objects.filter(Q(name='Alice') | Q(name='Bob'))",
    "```",
    "",
    "Kya aap inka koi specific use case dekhna chahte hain apne project mein?"
  ].join("\n");

  const segments = parseRichContent(source);
  assert.equal(segments.length, 3);
  assert.equal(segments[0]?.type, "text");
  assert.equal(segments[1]?.type, "code");
  assert.equal(segments[1].language, "python");
  assert.equal(
    segments[1].code,
    [
      "from django.db.models import F, Q",
      "from .models import Product, User",
      "",
      "# F expression example: Increment all product prices by 10",
      "Product.objects.update(price=F('price') + 10)",
      "",
      "# Q object example: Find users named 'Alice' OR 'Bob'",
      "users = User.objects.filter(Q(name='Alice') | Q(name='Bob'))"
    ].join("\n")
  );
  assert.equal(segments[1].closed, true);
  assert.equal(segments[2]?.type, "text");
});

void test("parses unfenced single-line raw SVG as a code segment", () => {
  const source = '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="red" /></svg>';
  const segments = parseRichContent(source);
  assert.equal(segments.length, 1);
  assert.equal(segments[0]?.type, "code");
  assert.equal(segments[0].language, "svg");
  assert.equal(segments[0].code, source);
  assert.equal(segments[0].closed, true);
});

void test("parses unfenced multiline raw SVG surrounded by prose", () => {
  const source = [
    "Here is the system architecture diagram:",
    "",
    '<svg width="400" height="200" viewBox="0 0 400 200" xmlns="http://www.w3.org/2000/svg">',
    '  <rect width="100" height="50" fill="#3b82f6" />',
    '  <text x="50" y="25">Client</text>',
    "</svg>",
    "",
    "Next steps are as follows."
  ].join("\n");

  const segments = parseRichContent(source);
  assert.equal(segments.length, 3);
  assert.equal(segments[0]?.type, "text");
  assert.match(segments[0].text, /Here is the system architecture diagram:/u);

  assert.equal(segments[1]?.type, "code");
  assert.equal(segments[1].language, "svg");
  assert.equal(
    segments[1].code,
    [
      '<svg width="400" height="200" viewBox="0 0 400 200" xmlns="http://www.w3.org/2000/svg">',
      '  <rect width="100" height="50" fill="#3b82f6" />',
      '  <text x="50" y="25">Client</text>',
      "</svg>"
    ].join("\n")
  );
  assert.equal(segments[1].closed, true);

  assert.equal(segments[2]?.type, "text");
  assert.match(segments[2].text, /Next steps are as follows\./u);
});

void test("parses incomplete unfenced raw SVG during streaming", () => {
  const source = '<svg viewBox="0 0 100 100">\n  <circle cx="50" cy="50" r="40" />';
  const segments = parseRichContent(source);
  assert.equal(segments.length, 1);
  assert.equal(segments[0]?.type, "code");
  assert.equal(segments[0].language, "svg");
  assert.equal(segments[0].closed, false);
  assert.equal(segments[0].code, source);
});

void test("parses fenced SVG diagrams", () => {
  const source = "```svg\n<svg viewBox=\"0 0 100 100\"><rect width=\"100\" height=\"100\"/></svg>\n```";
  const segments = parseRichContent(source);
  assert.equal(segments.length, 1);
  assert.equal(segments[0]?.type, "code");
  assert.equal(segments[0].language, "svg");
  assert.equal(segments[0].code, '<svg viewBox="0 0 100 100"><rect width="100" height="100"/></svg>');
  assert.equal(segments[0].closed, true);
});

void test("stripMarkdownForSpeech removes code blocks, formatting, links, headers and lists", () => {
  const input = [
    "# Overview of the fix",
    "",
    "Here is **important** information with `someInlineCode` and a [helpful link](https://example.com).",
    "",
    "```typescript",
    "const hidden = 42;",
    "```",
    "",
    '<svg viewBox="0 0 100 100"><text>Hidden SVG Text</text></svg>',
    "",
    "## Key points:",
    "- First item",
    "- Second *emphasized* item",
    "1. Ordered point",
    "> Blockquote text",
    "---"
  ].join("\n");

  const result = stripMarkdownForSpeech(input);
  assert.ok(!result.includes("```"));
  assert.ok(!result.includes("hidden = 42"));
  assert.ok(!result.includes("Hidden SVG Text"));
  assert.ok(!result.includes("<svg"));
  assert.ok(!result.includes("`"));
  assert.ok(!result.includes("#"));
  assert.ok(!result.includes("**"));
  assert.ok(!result.includes("[helpful link]"));
  assert.ok(!result.includes("https://example.com"));
  assert.ok(result.includes("helpful link"));
  assert.ok(result.includes("important information with someInlineCode"));
  assert.ok(result.includes("First item"));
  assert.ok(result.includes("Second emphasized item"));
  assert.ok(result.includes("Ordered point"));
  assert.ok(result.includes("Blockquote text"));
});
