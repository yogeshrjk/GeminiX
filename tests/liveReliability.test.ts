import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { createLiveSetupMessage } from "../src/liveConfig.ts";
import { interactionStatus, isInteractionComplete } from "../src/liveInteraction.ts";
import { LiveToolCalls } from "../src/liveProtocol.ts";
import { LiveSession, type LiveSessionEvent } from "../src/liveSession.ts";
import type { Preferences } from "../src/types.ts";

const preferences: Preferences = { voice: "Kore", preferredLanguage: "English", autoInterrupt: true, behavior: "professional" };

void test("model configurations match their tool and thinking capabilities", () => {
  for (const level of ["minimal", "low", "medium", "high"] as const) {
    const setup = createLiveSetupMessage({ ...preferences, liveModel: "gemini-3.8-live-extended-thinking", thinkingLevel: level }).setup;
    assert.deepEqual(setup.generationConfig.thinkingConfig, { thinkingLevel: level === "minimal" ? "LOW" : level.toUpperCase() });
    assert.ok(setup.tools[0]?.functionDeclarations.every((tool) => tool.behavior === "NON_BLOCKING"));
    assert.deepEqual(setup.outputAudioTranscription, {});
  }
  const ordinary = createLiveSetupMessage(preferences).setup;
  assert.equal(ordinary.generationConfig.thinkingConfig, undefined);
  assert.ok(ordinary.tools[0]?.functionDeclarations.every((tool) => tool.behavior === "BLOCKING"));
  const legacy = createLiveSetupMessage({ ...preferences, liveModel: "gemini-3.1-flash-live-preview", autoInterrupt: false }).setup;
  assert.ok(legacy.tools[0]?.functionDeclarations.every((tool) => tool.behavior === undefined));
  assert.equal(legacy.realtimeInputConfig.activityHandling, "NO_INTERRUPTION");
});

void test("Thinking finishes only on IDLE, including separate and nested status events", () => {
  const model = "gemini-3.8-live-extended-thinking";
  assert.equal(isInteractionComplete({ serverContent: { turnComplete: true } }, model), false);
  assert.equal(isInteractionComplete({ serverContent: { turnComplete: true, interactionStatus: "IN_PROGRESS" } }, model), false);
  assert.equal(isInteractionComplete({ interactionStatus: "IDLE" }, model), true);
  assert.equal(isInteractionComplete({ serverContent: { interaction_status: "IDLE" } }, model), true);
  assert.equal(interactionStatus({ interaction_status: "IN_PROGRESS" }), "IN_PROGRESS");
  assert.equal(isInteractionComplete({ serverContent: { turnComplete: true } }, "gemini-3.8-live"), true);
  assert.equal(isInteractionComplete({ serverContent: { turnComplete: true }, toolCall: { functionCalls: [{}] } }, "gemini-3.8-live"), false);
});

void test("tool responses match pending names and IDs and cannot outlive cancellation", () => {
  const calls = new LiveToolCalls();
  const call = { id: "search-1", name: "search_web" };
  assert.deepEqual(calls.accept([call, call]), [call]);
  assert.deepEqual(calls.complete([{ ...call, name: "render_markdown", response: {} }]), []);
  assert.equal(calls.has(call.id), true);
  calls.cancel([call.id]);
  assert.deepEqual(calls.complete([{ ...call, response: {} }]), []);
  assert.deepEqual(calls.accept([call]), []);
  calls.reset();
  assert.deepEqual(calls.accept([call]), [call]);
  assert.equal(calls.complete([{ ...call, response: {} }]).length, 1);
  assert.deepEqual(calls.complete([{ ...call, response: {} }]), []);
});

void test("socket waits for setup, sends one text turn, and filters duplicate/cancelled tools", { timeout: 5_000 }, async (t) => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const events: LiveSessionEvent[] = [];
  const session = new LiveSession((event) => events.push(event), { endpoint: `ws://127.0.0.1:${address.port}` });
  t.after(() => { session.dispose(); for (const client of server.clients) client.terminate(); server.close(); });
  const connection = once(server, "connection");
  session.connect("test-key", preferences);
  const [socket] = await connection as [WebSocket];
  const received: unknown[] = [];
  socket.on("message", (data: Buffer) => received.push(JSON.parse(data.toString()) as unknown));
  await until(() => received.length === 1);
  assert.equal(session.isConnected, false);
  assert.equal(session.sendUserTurn("question"), true);
  session.sendAudio("AAAA");
  assert.equal(received.length, 1);
  socket.send(JSON.stringify({ setupComplete: {} }));
  await until(() => received.length === 2);
  assert.equal(session.isConnected, true);
  assert.deepEqual(received[1], { realtimeInput: { text: "question" } });
  const call = { id: "c1", name: "search_web", args: { query: "Django" } };
  socket.send(JSON.stringify({ toolCall: { functionCalls: [call, call] } }));
  await until(() => session.isToolCallPending("c1"));
  const toolEvent = events.filter((event) => event.type === "serverMessage").at(-1);
  assert.ok(toolEvent?.type === "serverMessage");
  assert.deepEqual(toolEvent.payload, { toolCall: { functionCalls: [call] } });
  socket.send(JSON.stringify({ toolCallCancellation: { ids: ["c1"] } }));
  await until(() => !session.isToolCallPending("c1"));
  session.sendToolResponses([{ id: "c1", name: "search_web", response: { results: [] } }]);
  session.sendInterrupt();
  await until(() => received.length === 3);
  assert.deepEqual(received[2], { clientContent: { turns: [], turnComplete: true } });
});

void test("a server that never acknowledges setup is timed out", { timeout: 5_000 }, async (t) => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const events: LiveSessionEvent[] = [];
  const session = new LiveSession((event) => events.push(event), { endpoint: `ws://127.0.0.1:${address.port}`, setupTimeoutMs: 50 });
  t.after(() => { session.dispose(); for (const client of server.clients) client.terminate(); server.close(); });
  session.connect("test-key", preferences);
  await until(() => events.some((event) => event.type === "closed"));
  assert.ok(events.some((event) => event.type === "error" && event.message.includes("did not finish")));
  assert.equal(session.isConnected, false);
});

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Timed out waiting for the socket fixture");
}
