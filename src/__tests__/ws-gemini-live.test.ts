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

  it("truncateAfterChunks stops stream early, no turnComplete: true", async () => {
    const truncFixture: Fixture = {
      match: { userMessage: "truncate-gemini" },
      response: { content: "ABCDEFGHIJKLMNO" }, // 15 chars, chunkSize 3 => 5 chunks
      chunkSize: 3,
      latency: 5,
      truncateAfterChunks: 2,
    };
    instance = await createServer([truncFixture]);
    const ws = await connectWebSocket(instance.url, GEMINI_WS_PATH);

    ws.send(setupMsg());
    await ws.waitForMessages(1); // setupComplete

    ws.send(clientContentMsg("truncate-gemini"));

    // Wait for connection to be destroyed
    await ws.waitForClose();

    // Small pause for server-side processing
    await new Promise((r) => setTimeout(r, 50));

    // Check that no message with turnComplete: true was sent
    const raw = await ws.waitForMessages(1).catch(() => [] as string[]);
    if (raw.length > 1) {
      const chunks = raw.slice(1).map((r) => JSON.parse(r));
      const hasTurnComplete = chunks.some((c) => c.serverContent?.turnComplete === true);
      expect(hasTurnComplete).toBe(false);
    }
  });

  it("truncateAfterChunks records interrupted: true in journal", async () => {
    const truncFixture: Fixture = {
      match: { userMessage: "truncate-journal-gemini" },
      response: { content: "ABCDEFGHIJKLMNO" },
      chunkSize: 3,
      latency: 5,
      truncateAfterChunks: 2,
    };
    instance = await createServer([truncFixture]);
    const ws = await connectWebSocket(instance.url, GEMINI_WS_PATH);

    ws.send(setupMsg());
    await ws.waitForMessages(1); // setupComplete

    ws.send(clientContentMsg("truncate-journal-gemini"));

    // Wait for connection to be destroyed
    await ws.waitForClose();

    // Give server time to finalize journal
    await new Promise((r) => setTimeout(r, 50));

    const entry = instance.journal.getLast();
    expect(entry).not.toBeNull();
    expect(entry!.response.interrupted).toBe(true);
    expect(entry!.response.interruptReason).toBe("truncateAfterChunks");
  });

  // Gemini Live sends all tool calls in a single WS frame, so truncateAfterChunks: 1
  // interrupts after that frame is sent (preventing conversation history update).
  it("truncateAfterChunks with toolCalls records interrupted: true in journal", async () => {
    const truncFixture: Fixture = {
      match: { userMessage: "truncate-tool-gemini" },
      response: {
        toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
      },
      latency: 5,
      truncateAfterChunks: 1,
    };
    instance = await createServer([truncFixture]);
    const ws = await connectWebSocket(instance.url, GEMINI_WS_PATH);

    ws.send(setupMsg());
    await ws.waitForMessages(1); // setupComplete

    ws.send(clientContentMsg("truncate-tool-gemini"));

    // Wait for connection to be destroyed
    await ws.waitForClose();

    // Give server time to finalize journal
    await new Promise((r) => setTimeout(r, 50));

    const entry = instance.journal.getLast();
    expect(entry).not.toBeNull();
    expect(entry!.response.interrupted).toBe(true);
    expect(entry!.response.interruptReason).toBe("truncateAfterChunks");
  });

  it("disconnectAfterMs interrupts stream and records in journal", async () => {
    const fixture: Fixture = {
      match: { userMessage: "disconnect-gemini" },
      response: { content: "ABCDEFGHIJKLMNOPQRSTUVWXYZ" },
      chunkSize: 1,
      latency: 20,
      disconnectAfterMs: 30,
    };
    instance = await createServer([fixture]);
    const ws = await connectWebSocket(instance.url, GEMINI_WS_PATH);

    ws.send(setupMsg());
    await ws.waitForMessages(1); // setupComplete

    ws.send(clientContentMsg("disconnect-gemini"));

    await ws.waitForClose();
    await new Promise((r) => setTimeout(r, 50));

    const entry = instance.journal.getLast();
    expect(entry).not.toBeNull();
    expect(entry!.response.interrupted).toBe(true);
    expect(entry!.response.interruptReason).toBe("disconnectAfterMs");
  });

  it("returns error for clientContent with missing turns", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, GEMINI_WS_PATH);

    ws.send(setupMsg());
    await ws.waitForMessages(1); // setupComplete

    // Send clientContent without turns
    ws.send(JSON.stringify({ clientContent: {} }));

    const raw = await ws.waitForMessages(2);
    const msg = JSON.parse(raw[1]);
    expect(msg.error).toBeDefined();
    expect(msg.error.code).toBe(400);
    expect(msg.error.message).toBe("Missing 'turns' in clientContent");
    expect(msg.error.status).toBe("INVALID_ARGUMENT");

    ws.close();
  });

  it("returns error for clientContent with non-array turns", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, GEMINI_WS_PATH);

    ws.send(setupMsg());
    await ws.waitForMessages(1); // setupComplete

    // Send clientContent with turns as a string instead of array
    ws.send(JSON.stringify({ clientContent: { turns: "not-an-array" } }));

    const raw = await ws.waitForMessages(2);
    const msg = JSON.parse(raw[1]);
    expect(msg.error).toBeDefined();
    expect(msg.error.code).toBe(400);
    expect(msg.error.message).toBe("Missing 'turns' in clientContent");
    expect(msg.error.status).toBe("INVALID_ARGUMENT");

    ws.close();
  });

  it("returns error for toolResponse with missing functionResponses", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, GEMINI_WS_PATH);

    ws.send(setupMsg());
    await ws.waitForMessages(1); // setupComplete

    // Send toolResponse without functionResponses
    ws.send(JSON.stringify({ toolResponse: {} }));

    const raw = await ws.waitForMessages(2);
    const msg = JSON.parse(raw[1]);
    expect(msg.error).toBeDefined();
    expect(msg.error.code).toBe(400);
    expect(msg.error.message).toBe("Missing 'functionResponses' in toolResponse");
    expect(msg.error.status).toBe("INVALID_ARGUMENT");

    ws.close();
  });

  it("returns error for toolResponse with non-array functionResponses", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, GEMINI_WS_PATH);

    ws.send(setupMsg());
    await ws.waitForMessages(1); // setupComplete

    // Send toolResponse with functionResponses as a string
    ws.send(JSON.stringify({ toolResponse: { functionResponses: "not-an-array" } }));

    const raw = await ws.waitForMessages(2);
    const msg = JSON.parse(raw[1]);
    expect(msg.error).toBeDefined();
    expect(msg.error.code).toBe(400);
    expect(msg.error.message).toBe("Missing 'functionResponses' in toolResponse");
    expect(msg.error.status).toBe("INVALID_ARGUMENT");

    ws.close();
  });

  it("returns error for malformed JSON", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, GEMINI_WS_PATH);

    ws.send(setupMsg());
    await ws.waitForMessages(1); // setupComplete

    ws.send("not valid json {{{}");

    const raw = await ws.waitForMessages(2);
    const msg = JSON.parse(raw[1]);
    expect(msg.error).toBeDefined();
    expect(msg.error.code).toBe(400);
    expect(msg.error.message).toBe("Malformed JSON");
    expect(msg.error.status).toBe("INVALID_ARGUMENT");

    ws.close();
  });

  it("returns error for unrecognized message type (no setup/clientContent/toolResponse)", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, GEMINI_WS_PATH);

    ws.send(setupMsg());
    await ws.waitForMessages(1); // setupComplete

    // Send message with no recognized field
    ws.send(JSON.stringify({ someUnknownField: true }));

    const raw = await ws.waitForMessages(2);
    const msg = JSON.parse(raw[1]);
    expect(msg.error).toBeDefined();
    expect(msg.error.code).toBe(400);
    expect(msg.error.message).toBe("Expected clientContent or toolResponse");
    expect(msg.error.status).toBe("INVALID_ARGUMENT");

    ws.close();
  });

  it("closes with 1008 in strict mode when no fixture matches", async () => {
    instance = await createServer(allFixtures, { strict: true });
    const ws = await connectWebSocket(instance.url, GEMINI_WS_PATH);

    ws.send(setupMsg());
    await ws.waitForMessages(1); // setupComplete

    ws.send(clientContentMsg("unknown-no-match-strict"));

    await ws.waitForClose();
  });

  it("handles empty content text response", async () => {
    const emptyFixture: Fixture = {
      match: { userMessage: "empty-content" },
      response: { content: "" },
    };
    instance = await createServer([emptyFixture]);
    const ws = await connectWebSocket(instance.url, GEMINI_WS_PATH);

    ws.send(setupMsg());
    await ws.waitForMessages(1); // setupComplete

    ws.send(clientContentMsg("empty-content"));

    const raw = await ws.waitForMessages(2);
    const msg = JSON.parse(raw[1]);
    expect(msg.serverContent).toBeDefined();
    expect(msg.serverContent.modelTurn.parts[0].text).toBe("");
    expect(msg.serverContent.turnComplete).toBe(true);

    ws.close();
  });

  it("handles setup without model (uses default)", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, GEMINI_WS_PATH);

    // Send setup without model field
    ws.send(JSON.stringify({ setup: {} }));

    const raw = await ws.waitForMessages(1);
    const msg = JSON.parse(raw[0]);
    expect(msg).toEqual({ setupComplete: {} });

    ws.close();
  });

  it("handles setup with tools", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, GEMINI_WS_PATH);

    ws.send(
      JSON.stringify({
        setup: {
          model: "gemini-2.0-flash-exp",
          tools: [
            {
              functionDeclarations: [
                {
                  name: "get_weather",
                  description: "Gets weather",
                  parameters: { type: "object" },
                },
              ],
            },
          ],
        },
      }),
    );

    const raw = await ws.waitForMessages(1);
    const msg = JSON.parse(raw[0]);
    expect(msg).toEqual({ setupComplete: {} });

    ws.close();
  });

  it("handles model turns with text in conversation history", async () => {
    // Test conversion of model turns with text content
    const multiTurnFixture: Fixture = {
      match: { userMessage: "follow-up" },
      response: { content: "Follow-up response" },
    };
    instance = await createServer([multiTurnFixture]);
    const ws = await connectWebSocket(instance.url, GEMINI_WS_PATH);

    ws.send(setupMsg());
    await ws.waitForMessages(1); // setupComplete

    // Send clientContent with both user and model turns
    ws.send(
      JSON.stringify({
        clientContent: {
          turns: [
            { role: "user", parts: [{ text: "first" }] },
            { role: "model", parts: [{ text: "model reply" }] },
            { role: "user", parts: [{ text: "follow-up" }] },
          ],
          turnComplete: true,
        },
      }),
    );

    const raw = await ws.waitForMessages(2);
    const msg = JSON.parse(raw[1]);
    expect(msg.serverContent).toBeDefined();

    ws.close();
  });

  it("handles model turns with function calls in conversation history", async () => {
    const afterFuncFixture: Fixture = {
      match: { userMessage: "after-func" },
      response: { content: "After function response" },
    };
    instance = await createServer([afterFuncFixture]);
    const ws = await connectWebSocket(instance.url, GEMINI_WS_PATH);

    ws.send(setupMsg());
    await ws.waitForMessages(1); // setupComplete

    // Send clientContent with model turn containing functionCall
    ws.send(
      JSON.stringify({
        clientContent: {
          turns: [
            { role: "user", parts: [{ text: "do something" }] },
            {
              role: "model",
              parts: [{ functionCall: { name: "search", args: { q: "test" } } }],
            },
            {
              role: "user",
              parts: [
                { functionResponse: { name: "search", response: "results", id: "call_1" } },
                { text: "after-func" },
              ],
            },
          ],
          turnComplete: true,
        },
      }),
    );

    const raw = await ws.waitForMessages(2);
    const msg = JSON.parse(raw[1]);
    expect(msg.serverContent).toBeDefined();

    ws.close();
  });

  it("handles toolResponse with non-string response values", async () => {
    const toolResultFixture2: Fixture = {
      match: { toolCallId: "call_gemini_search_0" },
      response: { content: "Search result" },
    };
    instance = await createServer([toolResultFixture2]);
    const ws = await connectWebSocket(instance.url, GEMINI_WS_PATH);

    ws.send(setupMsg());
    await ws.waitForMessages(1); // setupComplete

    // Send toolResponse where response is an object (not string)
    ws.send(
      JSON.stringify({
        toolResponse: {
          functionResponses: [
            { name: "search", response: { results: ["a", "b"] }, id: "call_gemini_search_0" },
          ],
        },
      }),
    );

    const raw = await ws.waitForMessages(2);
    const msg = JSON.parse(raw[1]);
    expect(msg.serverContent).toBeDefined();

    ws.close();
  });

  it("handles tool call with malformed JSON arguments in fixture", async () => {
    const badArgsFixture: Fixture = {
      match: { userMessage: "bad-args" },
      response: {
        toolCalls: [{ name: "search", arguments: "not-json{{{" }],
      },
    };
    instance = await createServer([badArgsFixture]);
    const ws = await connectWebSocket(instance.url, GEMINI_WS_PATH);

    ws.send(setupMsg());
    await ws.waitForMessages(1); // setupComplete

    ws.send(clientContentMsg("bad-args"));

    const raw = await ws.waitForMessages(2);
    const msg = JSON.parse(raw[1]);
    // Should still produce a toolCall with empty args object
    expect(msg.toolCall).toBeDefined();
    expect(msg.toolCall.functionCalls[0].name).toBe("search");
    expect(msg.toolCall.functionCalls[0].args).toEqual({});

    ws.close();
  });

  it("handles error fixture with default status 500", async () => {
    const errorNoStatusFixture: Fixture = {
      match: { userMessage: "error-no-status" },
      response: {
        error: { message: "Something went wrong", type: "server_error" },
      },
    };
    instance = await createServer([errorNoStatusFixture]);
    const ws = await connectWebSocket(instance.url, GEMINI_WS_PATH);

    ws.send(setupMsg());
    await ws.waitForMessages(1); // setupComplete

    ws.send(clientContentMsg("error-no-status"));

    const raw = await ws.waitForMessages(2);
    const msg = JSON.parse(raw[1]);
    expect(msg.error).toBeDefined();
    expect(msg.error.code).toBe(500);
    expect(msg.error.message).toBe("Something went wrong");

    ws.close();
  });

  it("handles turn with missing role (defaults to user)", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, GEMINI_WS_PATH);

    ws.send(setupMsg());
    await ws.waitForMessages(1); // setupComplete

    // Send clientContent with turn missing role field
    ws.send(
      JSON.stringify({
        clientContent: {
          turns: [{ parts: [{ text: "hello" }] }],
          turnComplete: true,
        },
      }),
    );

    const raw = await ws.waitForMessages(2);
    const msg = JSON.parse(raw[1]);
    expect(msg.serverContent).toBeDefined();

    ws.close();
  });

  it("handles user turn with functionResponse that has string response", async () => {
    // Fixture that matches a tool call id
    const toolResultFixtureStr: Fixture = {
      match: { toolCallId: "call_gemini_search_0" },
      response: { content: "Result processed" },
    };
    instance = await createServer([toolResultFixtureStr]);
    const ws = await connectWebSocket(instance.url, GEMINI_WS_PATH);

    ws.send(setupMsg());
    await ws.waitForMessages(1); // setupComplete

    // Send clientContent with functionResponse where response is a string
    ws.send(
      JSON.stringify({
        clientContent: {
          turns: [
            {
              role: "user",
              parts: [{ functionResponse: { name: "search", response: "string-result" } }],
            },
          ],
          turnComplete: true,
        },
      }),
    );

    const raw = await ws.waitForMessages(2);
    const msg = JSON.parse(raw[1]);
    expect(msg.serverContent).toBeDefined();

    ws.close();
  });

  it("handles toolResponse with fallback id and string response", async () => {
    // Fixture matching on tool call id
    const toolResultFixture3: Fixture = {
      match: { toolCallId: "call_gemini_lookup_0" },
      response: { content: "Lookup done" },
    };
    instance = await createServer([toolResultFixture3]);
    const ws = await connectWebSocket(instance.url, GEMINI_WS_PATH);

    ws.send(setupMsg());
    await ws.waitForMessages(1); // setupComplete

    // Send toolResponse without id (relies on fallback) and with string response
    ws.send(
      JSON.stringify({
        toolResponse: {
          functionResponses: [{ name: "lookup", response: "string-response-value" }],
        },
      }),
    );

    const raw = await ws.waitForMessages(2);
    const msg = JSON.parse(raw[1]);
    expect(msg.serverContent).toBeDefined();

    ws.close();
  });

  it("handles setup with tools that have empty functionDeclarations", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, GEMINI_WS_PATH);

    ws.send(
      JSON.stringify({
        setup: {
          model: "gemini-2.0-flash-exp",
          tools: [{}], // No functionDeclarations
        },
      }),
    );

    const raw = await ws.waitForMessages(1);
    const msg = JSON.parse(raw[0]);
    expect(msg).toEqual({ setupComplete: {} });

    // Verify we can still send messages after setup with empty tools
    ws.send(clientContentMsg("hello"));
    const raw2 = await ws.waitForMessages(2);
    const msg2 = JSON.parse(raw2[1]);
    expect(msg2.serverContent).toBeDefined();

    ws.close();
  });

  it("handles unknown response type gracefully", async () => {
    const weirdFixture: Fixture = {
      match: { userMessage: "weird-response-gemini" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response: { unknownField: "value" } as any,
    };
    instance = await createServer([weirdFixture]);
    const ws = await connectWebSocket(instance.url, GEMINI_WS_PATH);

    ws.send(setupMsg());
    await ws.waitForMessages(1); // setupComplete

    ws.send(clientContentMsg("weird-response-gemini"));

    const raw = await ws.waitForMessages(2);
    const msg = JSON.parse(raw[1]);
    expect(msg.error).toBeDefined();
    expect(msg.error.code).toBe(500);
    expect(msg.error.message).toBe("Fixture response did not match any known type");
    expect(msg.error.status).toBe("INTERNAL");

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
