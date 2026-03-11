import { describe, it, expect, afterEach } from "vitest";
import { createServer, type ServerInstance } from "../server.js";
import type { Fixture } from "../types.js";
import { connectWebSocket } from "./ws-test-client.js";

// --- fixtures ---

const textFixture: Fixture = {
  match: { userMessage: "hello" },
  response: { content: "Hi there!" },
};

const toolFixture: Fixture = {
  match: { userMessage: "weather" },
  response: {
    toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
  },
};

const errorFixture: Fixture = {
  match: { userMessage: "fail" },
  response: {
    error: { message: "Rate limited", type: "rate_limit_error", code: "rate_limit" },
    status: 429,
  },
};

const toolResultFixture: Fixture = {
  match: { toolCallId: "call_gemini_get_weather_0" },
  response: { content: "Weather in NYC is sunny, 72F" },
};

const allFixtures: Fixture[] = [textFixture, toolResultFixture, toolFixture, errorFixture];

// --- helpers ---

const GEMINI_WS_PATH =
  "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

function setupMsg(model = "gemini-2.0-flash-exp"): string {
  return JSON.stringify({
    setup: { model },
  });
}

function clientContentMsg(text: string): string {
  return JSON.stringify({
    clientContent: {
      turns: [{ role: "user", parts: [{ text }] }],
      turnComplete: true,
    },
  });
}

function toolResponseMsg(name: string, response: unknown, id?: string): string {
  return JSON.stringify({
    toolResponse: {
      functionResponses: [{ id, name, response }],
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

describe("WebSocket Gemini Live BidiGenerateContent", () => {
  it("responds with setupComplete after setup message", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, GEMINI_WS_PATH);

    ws.send(setupMsg());

    const raw = await ws.waitForMessages(1);
    const msg = JSON.parse(raw[0]);
    expect(msg).toEqual({ setupComplete: {} });

    ws.close();
  });

  it("streams text response with serverContent and turnComplete", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, GEMINI_WS_PATH);

    ws.send(setupMsg());
    await ws.waitForMessages(1); // setupComplete

    ws.send(clientContentMsg("hello"));

    // "Hi there!" is 9 chars, default chunkSize=20 → 1 chunk
    const raw = await ws.waitForMessages(2); // setupComplete + 1 serverContent
    const msg = JSON.parse(raw[1]);
    expect(msg.serverContent).toBeDefined();
    expect(msg.serverContent.modelTurn.parts[0].text).toBe("Hi there!");
    expect(msg.serverContent.turnComplete).toBe(true);

    ws.close();
  });

  it("streams text in multiple chunks when content exceeds chunkSize", async () => {
    const longFixture: Fixture = {
      match: { userMessage: "long" },
      response: { content: "ABCDEFGHIJ" },
      chunkSize: 3,
    };
    instance = await createServer([longFixture]);
    const ws = await connectWebSocket(instance.url, GEMINI_WS_PATH);

    ws.send(setupMsg());
    await ws.waitForMessages(1); // setupComplete

    ws.send(clientContentMsg("long"));

    // "ABCDEFGHIJ" (10 chars) / chunkSize 3 → 4 chunks: ABC, DEF, GHI, J
    const raw = await ws.waitForMessages(5); // 1 setupComplete + 4 chunks
    const chunks = raw.slice(1).map((r) => JSON.parse(r));

    // All but last should have turnComplete: false
    for (let i = 0; i < chunks.length - 1; i++) {
      expect(chunks[i].serverContent.turnComplete).toBe(false);
    }
    // Last chunk should have turnComplete: true
    expect(chunks[chunks.length - 1].serverContent.turnComplete).toBe(true);

    // Reconstruct full text
    const fullText = chunks.map((c) => c.serverContent.modelTurn.parts[0].text).join("");
    expect(fullText).toBe("ABCDEFGHIJ");

    ws.close();
  });

  it("returns toolCall for tool call fixture", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, GEMINI_WS_PATH);

    ws.send(setupMsg());
    await ws.waitForMessages(1);

    ws.send(clientContentMsg("weather"));

    const raw = await ws.waitForMessages(2); // setupComplete + toolCall
    const msg = JSON.parse(raw[1]);
    expect(msg.toolCall).toBeDefined();
    expect(msg.toolCall.functionCalls).toHaveLength(1);
    expect(msg.toolCall.functionCalls[0].name).toBe("get_weather");
    expect(msg.toolCall.functionCalls[0].args).toEqual({ city: "NYC" });
    expect(msg.toolCall.functionCalls[0].id).toBe("call_gemini_get_weather_0");

    ws.close();
  });

  it("processes toolResponse and returns serverContent", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, GEMINI_WS_PATH);

    ws.send(setupMsg());
    await ws.waitForMessages(1);

    // First get a tool call
    ws.send(clientContentMsg("weather"));
    await ws.waitForMessages(2); // setupComplete + toolCall

    // Send tool response
    ws.send(toolResponseMsg("get_weather", { temp: "72F" }, "call_gemini_get_weather_0"));

    // "Weather in NYC is sunny, 72F" is 28 chars, default chunkSize=20 → 2 chunks
    const raw = await ws.waitForMessages(4); // setupComplete + toolCall + 2 serverContent
    const chunks = raw.slice(2).map((r) => JSON.parse(r));

    // First chunk: turnComplete false
    expect(chunks[0].serverContent).toBeDefined();
    expect(chunks[0].serverContent.turnComplete).toBe(false);

    // Last chunk: turnComplete true
    expect(chunks[1].serverContent).toBeDefined();
    expect(chunks[1].serverContent.turnComplete).toBe(true);

    // Reconstruct full text
    const fullText = chunks.map((c) => c.serverContent.modelTurn.parts[0].text).join("");
    expect(fullText).toBe("Weather in NYC is sunny, 72F");

    ws.close();
  });

  it("returns error when no fixture matches", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, GEMINI_WS_PATH);

    ws.send(setupMsg());
    await ws.waitForMessages(1);

    ws.send(clientContentMsg("unknown-message-that-matches-nothing"));

    const raw = await ws.waitForMessages(2);
    const msg = JSON.parse(raw[1]);
    expect(msg.error).toBeDefined();
    expect(msg.error.code).toBe(404);
    expect(msg.error.message).toBe("No fixture matched");
    expect(msg.error.status).toBe("NOT_FOUND");

    ws.close();
  });

  it("returns error for error fixture", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, GEMINI_WS_PATH);

    ws.send(setupMsg());
    await ws.waitForMessages(1);

    ws.send(clientContentMsg("fail"));

    const raw = await ws.waitForMessages(2);
    const msg = JSON.parse(raw[1]);
    expect(msg.error).toBeDefined();
    expect(msg.error.code).toBe(429);
    expect(msg.error.message).toBe("Rate limited");
    expect(msg.error.status).toBe("ERROR");

    ws.close();
  });

  it("records journal entries with method WS", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, GEMINI_WS_PATH);

    ws.send(setupMsg());
    await ws.waitForMessages(1);

    ws.send(clientContentMsg("hello"));
    await ws.waitForMessages(2);

    // Small pause to ensure journal write completed
    await new Promise((r) => setTimeout(r, 50));

    expect(instance.journal.size).toBe(1);
    const entry = instance.journal.getLast();
    expect(entry!.method).toBe("WS");
    expect(entry!.path).toBe(GEMINI_WS_PATH);
    expect(entry!.response.status).toBe(200);
    expect(entry!.response.fixture).toBe(textFixture);

    ws.close();
  });

  it("returns error when message sent before setup", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, GEMINI_WS_PATH);

    // Send clientContent without setup first
    ws.send(clientContentMsg("hello"));

    const raw = await ws.waitForMessages(1);
    const msg = JSON.parse(raw[0]);
    expect(msg.error).toBeDefined();
    expect(msg.error.code).toBe(400);
    expect(msg.error.message).toBe("Setup required");
    expect(msg.error.status).toBe("FAILED_PRECONDITION");

    ws.close();
  });
});
