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
import { createLiveSetupMessage } from "../src/liveConfig.ts";
import {
  buildConversationHistoryPrompt,
  buildSystemInstruction
} from "../src/prompts.ts";
import { isDirectSelectedCodeRequest } from "../src/requestIntent.ts";
import { shouldInterruptPlayback } from "../webview/playbackPolicy.ts";
import { TranscribeLiveSession } from "../src/transcribeSession.ts";
import { reconcileSpokenTranscript } from "../src/transcriptReconciler.ts";

void test("asks for clarification instead of inventing intent from a fragment", () => {
  const instruction = buildSystemInstruction({
    voice: "Kore",
    preferredLanguage: "English",
    autoInterrupt: true,
    behavior: "professional"
  });

  assert.match(instruction, /current user message as the task to solve/u);
  assert.match(instruction, /ask one short clarification question instead of inventing missing context/u);
  assert.match(instruction, /Do not search the web merely to explain stable programming concepts/u);
  assert.match(instruction, /Never attribute an earlier GeminiX statement to the user/u);
});

void test("requires complete requested JSON to be rendered instead of described", () => {
  const instruction = buildSystemInstruction({
    voice: "Kore",
    preferredLanguage: "English",
    autoInterrupt: true,
    behavior: "professional"
  });

  assert.match(instruction, /Use render_markdown whenever/u);
  assert.match(instruction, /Put the complete requested artifact in the render_markdown call/u);
  assert.match(instruction, /For JSON or structured data requests, provide the actual requested data/u);
  assert.match(instruction, /unless you call render_markdown in the same turn/u);
});

void test("mandates calling render_markdown for coding and implementation questions", () => {
  const instruction = buildSystemInstruction({
    voice: "Kore",
    preferredLanguage: "English",
    autoInterrupt: true,
    behavior: "professional"
  });

  assert.match(instruction, /Visual tool: render_markdown/u);
  assert.match(instruction, /Use render_markdown whenever the user needs code/u);
  assert.match(instruction, /Use fenced code blocks with the correct language identifier/u);
  assert.match(instruction, /Never say that code, a table, JSON, a diagram, or another artifact is visible in the panel unless you call render_markdown/u);
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

  assert.match(history, /prior conversation context, not a new request/u);
  assert.match(history, /Never treat a previous GeminiX response as something the user said or confirmed/u);
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

void test("reconcileSpokenTranscript gracefully handles missing or empty inputs", async () => {
  const result1 = await reconcileSpokenTranscript({
    rawTranscript: "",
    assistantResponse: "Response text",
    preferredLanguage: "Hindi",
    apiKey: "test-key"
  });
  assert.equal(result1, undefined);

  const result2 = await reconcileSpokenTranscript({
    rawTranscript: "Sí, hombre",
    assistantResponse: "",
    preferredLanguage: "Hindi",
    apiKey: "test-key"
  });
  assert.equal(result2, undefined);

  const result3 = await reconcileSpokenTranscript({
    rawTranscript: "Hello",
    assistantResponse: "Hi there",
    preferredLanguage: "English",
    apiKey: ""
  });
  assert.equal(result3, undefined);
});

void test("TranscribeLiveSession can be instantiated and managed", () => {
  const chunks: string[] = [];
  const session = new TranscribeLiveSession({
    onTranscriptChunk: (text) => chunks.push(text)
  });
  assert.equal(session.isConnected, false);
  session.disconnect();
  session.dispose();
  assert.equal(chunks.length, 0);
});

void test("LiveSession preferences support model switching and thinking level", () => {
  const defaultPrefs = {
    voice: "Kore" as const,
    preferredLanguage: "English" as const,
    autoInterrupt: true,
    behavior: "professional" as const
  };
  const extendedPrefs = {
    ...defaultPrefs,
    liveModel: "gemini-3.8-live-extended-thinking" as const,
    thinkingLevel: "high" as const
  };
  assert.equal(extendedPrefs.liveModel, "gemini-3.8-live-extended-thinking");
  assert.equal(extendedPrefs.thinkingLevel, "high");
});

void test("instructs model to use Google Vision analysis and OCR for image attachments", () => {
  const instruction = buildSystemInstruction({
    voice: "Kore",
    preferredLanguage: "English",
    autoInterrupt: true,
    behavior: "professional"
  });

  assert.match(instruction, /Google Vision analysis and OCR/u);
  assert.doesNotMatch(instruction, /Do not claim OCR/u);
});

void test("createLiveSetupMessage preserves the configured voice preference for all tasks", () => {
  for (const voice of ["Puck", "Fenrir", "Aoede", "Zephyr", "Charon"] as const) {
    const setup = createLiveSetupMessage({
      voice,
      preferredLanguage: "English",
      autoInterrupt: true,
      behavior: "professional"
    }).setup;

    const generationConfig = setup.generationConfig as {
      speechConfig?: {
        voiceConfig?: {
          prebuiltVoiceConfig?: {
            voiceName?: string;
          };
        };
      };
    };

    assert.equal(
      generationConfig.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName,
      voice
    );
  }
});
