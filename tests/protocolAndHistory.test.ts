import assert from "node:assert/strict";
import test from "node:test";
import {
  chatMessageToText,
  parseChatMessage
} from "../src/chatSchema.ts";
import {
  createToolResponsePayload,
  isLiveFunctionResponse
} from "../src/liveProtocol.ts";
import {
  buildConversationHistoryPrompt,
  buildSystemInstruction
} from "../src/prompts.ts";
import { isDirectSelectedCodeRequest } from "../src/requestIntent.ts";
import { shouldInterruptPlayback } from "../webview/playbackPolicy.ts";

void test("asks for clarification instead of inventing intent from a fragment", () => {
  const instruction = buildSystemInstruction({
    voice: "Kore",
    preferredLanguage: "English",
    autoInterrupt: true,
    behavior: "professional"
  });

  assert.match(instruction, /current user message is the request to answer/u);
  assert.match(instruction, /isolated letter, short fragment/u);
  assert.match(instruction, /do not search the web/u);
  assert.match(instruction, /prior assistant claim/u);
});

void test("requires complete requested JSON to be rendered instead of described", () => {
  const instruction = buildSystemInstruction({
    voice: "Kore",
    preferredLanguage: "English",
    autoInterrupt: true,
    behavior: "professional"
  });

  assert.match(instruction, /MUST call `render_markdown` with the full artifact/u);
  assert.match(instruction, /statement that the artifact is 'below' is not a substitute/u);
  assert.match(instruction, /complete JSON in a fenced `json` code block/u);
  assert.match(instruction, /do not invent data or pretend it was rendered/u);
});

void test("mandates calling render_markdown for coding and implementation questions", () => {
  const instruction = buildSystemInstruction({
    voice: "Kore",
    preferredLanguage: "English",
    autoInterrupt: true,
    behavior: "professional"
  });

  assert.match(instruction, /MANDATORY FOR ALL CODE AND STRUCTURED CONTENT/u);
  assert.match(instruction, /how to write a program/u);
  assert.match(instruction, /MUST call `render_markdown` with the full working code in a fenced code block/u);
  assert.match(instruction, /NO GHOST VISUAL REFERENCES/u);
});

void test("recognizes direct selected-code requests without intercepting explanations", () => {
  assert.equal(
    isDirectSelectedCodeRequest("extension.ts 289-314 give me the code"),
    true
  );
  assert.equal(isDirectSelectedCodeRequest("show me the selected snippet"), true);
  assert.equal(isDirectSelectedCodeRequest("explain the selected code"), false);
  assert.equal(isDirectSelectedCodeRequest("give me the data as JSON"), false);
});

void test("marks restored history as context and distinguishes assistant replies", () => {
  const history = buildConversationHistoryPrompt([
    {
      id: "user-1",
      role: "user",
      spokenText: "G",
      createdAt: "2026-09-29T00:00:00.000Z"
    },
    {
      id: "model-1",
      role: "model",
      spokenText: "Node.js is currently version ...",
      createdAt: "2026-09-29T00:00:01.000Z"
    }
  ]);

  assert.match(history, /history is context, not a new request/u);
  assert.match(history, /never attribute an assistant claim to the user/u);
  assert.match(history, /User: G/u);
  assert.match(history, /GeminiX: Node\.js/u);
});

void test("formats the Gemini Live tool-response payload with matching IDs", () => {
  const response = {
    id: "call-123",
    name: "render_markdown",
    response: { success: true }
  } as const;
  assert.deepEqual(createToolResponsePayload([response]), {
    toolResponse: {
      functionResponses: [response]
    }
  });
  assert.equal(isLiveFunctionResponse(response), true);
  assert.equal(
    isLiveFunctionResponse({
      name: "render_markdown",
      response: { success: true }
    }),
    false
  );
});

void test("migrates legacy text-only chat messages", () => {
  const message = parseChatMessage(
    {
      id: "legacy-message",
      role: "model",
      text: "Legacy spoken answer",
      createdAt: "2026-07-30T00:00:00.000Z"
    },
    10_000
  );
  assert.equal(message.spokenText, "Legacy spoken answer");
  assert.equal(message.visualText, undefined);
});

void test("preserves spoken, visual, and Markdown content during save and restore", () => {
  const message = parseChatMessage(
    {
      id: "rich-message",
      role: "model",
      spokenText: "Here is the example.",
      visualText: "## Details",
      markdownBlocks: [
        {
          id: "block-1",
          functionCallId: "call-1",
          markdown: "```python\nprint('visible')\n```"
        }
      ],
      createdAt: "2026-07-30T00:00:00.000Z"
    },
    10_000
  );
  assert.match(chatMessageToText(message), /Here is the example/u);
  assert.match(chatMessageToText(message), /## Details/u);
  assert.match(chatMessageToText(message), /print\('visible'\)/u);
  assert.equal(message.markdownBlocks?.[0]?.functionCallId, "call-1");
});

void test("only a Gemini interrupted event clears playback", () => {
  assert.equal(shouldInterruptPlayback({ interrupted: true }), true);
  assert.equal(shouldInterruptPlayback({ interrupted: false }), false);
  assert.equal(shouldInterruptPlayback({}), false);
});
