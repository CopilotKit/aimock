import { describe, it, expect, afterEach } from "vitest";
import { createServer, type ServerInstance } from "../server.js";
import type { Fixture } from "../types.js";
import { connectWebSocket } from "./ws-test-client.js";

// --- fixtures ---

// Blocks-only fixture (#274): tool-call BEFORE text, no top-level content/toolCalls.
// Post-F0 this matches `isContentWithToolCallsResponse`. Before the WS fix, the
// content+toolCalls branch read only `content ?? ""` / `toolCalls ?? []` and
// IGNORED `response.blocks`, so this streamed an EMPTY payload (silent drop).
const blocksOnlyFixture: Fixture = {
  match: { userMessage: "blocks-only" },
  response: {
    blocks: [
      { type: "toolCall", name: "get_weather", arguments: '{"city":"NYC"}' },
      { type: "text", text: "Checking weather." },
    ],
  },
};

// Back-compat control: legacy combined { content, toolCalls } (no blocks).
const legacyCombinedFixture: Fixture = {
  match: { userMessage: "legacy-combined" },
  response: {
    content: "Working on it.",
    toolCalls: [{ name: "do_thing", arguments: '{"x":1}' }],
  },
};

const allFixtures: Fixture[] = [blocksOnlyFixture, legacyCombinedFixture];

// --- helpers ---

const GEMINI_WS_PATH =
  "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

function setupMsg(model = "gemini-2.0-flash-exp"): string {
  return JSON.stringify({ setup: { model } });
}

function clientContentMsg(text: string): string {
  return JSON.stringify({
    clientContent: {
      turns: [{ role: "user", parts: [{ text }] }],
      turnComplete: true,
    },
  });
}

// --- tests ---

let instance: ServerInstance | null = null;

afterEach(async () => {
  if (instance) {
    await new Promise<void>((resolve) => {
      instance!.server.close(() => resolve());
    });
    instance = null;
  }
});

describe("WebSocket Gemini Live — blocks-only fixtures (#274)", () => {
  it("streams a NON-empty payload for a blocks-only fixture, tool-first then text", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, GEMINI_WS_PATH);

    ws.send(setupMsg());
    await ws.waitForMessages(1); // setupComplete

    ws.send(clientContentMsg("blocks-only"));

    // setupComplete + toolCall + text serverContent + turnComplete
    const raw = await ws.waitForMessages(4);
    const msgs = raw.slice(1).map((r) => JSON.parse(r));

    // RED before fix: no toolCall and no text content (empty payload / silent drop).
    const toolCallMsgs = msgs.filter((m) => m.toolCall);
    const textMsgs = msgs.filter((m) => m.serverContent?.modelTurn?.parts?.[0]?.text);

    // Tool call must be present and carry the block's name + args.
    expect(toolCallMsgs).toHaveLength(1);
    expect(toolCallMsgs[0].toolCall.functionCalls).toHaveLength(1);
    expect(toolCallMsgs[0].toolCall.functionCalls[0].name).toBe("get_weather");
    expect(toolCallMsgs[0].toolCall.functionCalls[0].args).toEqual({ city: "NYC" });

    // Text must be present and reconstruct the block's text.
    const fullText = textMsgs.map((m) => m.serverContent.modelTurn.parts[0].text).join("");
    expect(fullText).toBe("Checking weather.");

    // Ordering: Gemini Live WS expresses order via sequential messages — the
    // toolCall message must arrive BEFORE the first text content message.
    const toolIdx = msgs.findIndex((m) => m.toolCall);
    const textIdx = msgs.findIndex((m) => m.serverContent?.modelTurn?.parts?.[0]?.text);
    expect(toolIdx).toBeGreaterThanOrEqual(0);
    expect(textIdx).toBeGreaterThanOrEqual(0);
    expect(toolIdx).toBeLessThan(textIdx);

    // Terminal turnComplete.
    const last = msgs[msgs.length - 1];
    expect(last.serverContent.turnComplete).toBe(true);

    ws.close();
  });

  it("back-compat: legacy { content, toolCalls } (no blocks) streams text-then-tool unchanged", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, GEMINI_WS_PATH);

    ws.send(setupMsg());
    await ws.waitForMessages(1);

    ws.send(clientContentMsg("legacy-combined"));

    // setupComplete + text content + toolCall + turnComplete
    const raw = await ws.waitForMessages(4);
    const msgs = raw.slice(1).map((r) => JSON.parse(r));

    const textMsgs = msgs.filter((m) => m.serverContent?.modelTurn?.parts?.[0]?.text);
    const fullText = textMsgs.map((m) => m.serverContent.modelTurn.parts[0].text).join("");
    expect(fullText).toBe("Working on it.");

    const toolCallMsgs = msgs.filter((m) => m.toolCall);
    expect(toolCallMsgs).toHaveLength(1);
    expect(toolCallMsgs[0].toolCall.functionCalls[0].name).toBe("do_thing");

    // Legacy order: text content arrives before the tool call.
    const textIdx = msgs.findIndex((m) => m.serverContent?.modelTurn?.parts?.[0]?.text);
    const toolIdx = msgs.findIndex((m) => m.toolCall);
    expect(textIdx).toBeLessThan(toolIdx);

    const last = msgs[msgs.length - 1];
    expect(last.serverContent.turnComplete).toBe(true);

    ws.close();
  });
});
