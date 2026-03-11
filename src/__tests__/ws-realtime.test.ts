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

const allFixtures: Fixture[] = [textFixture, toolFixture, errorFixture];

// --- helpers ---

interface WSEvent {
  type: string;
  event_id?: string;
  [key: string]: unknown;
}

function parseEvents(raw: string[]): WSEvent[] {
  return raw.map((m) => JSON.parse(m) as WSEvent);
}

function conversationItemCreate(role: string, text: string): string {
  return JSON.stringify({
    type: "conversation.item.create",
    item: {
      type: "message",
      role,
      content: [{ type: "input_text", text }],
    },
  });
}

function responseCreate(): string {
  return JSON.stringify({ type: "response.create" });
}

function sessionUpdate(config: Record<string, unknown>): string {
  return JSON.stringify({ type: "session.update", session: config });
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

// ─── Integration tests: WebSocket /v1/realtime ──────────────────────────────

describe("WebSocket /v1/realtime", () => {
  it("sends session.created on connect with correct structure", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/realtime");

    // The first message should be session.created, sent immediately on connect
    const raw = await ws.waitForMessages(1);
    const event = JSON.parse(raw[0]) as WSEvent;

    expect(event.type).toBe("session.created");
    expect(event.event_id).toBeDefined();
    expect(typeof event.event_id).toBe("string");
    expect((event.event_id as string).startsWith("evt-")).toBe(true);

    const session = event.session as Record<string, unknown>;
    expect(session.id).toBeDefined();
    expect((session.id as string).startsWith("sess-")).toBe(true);
    expect(session.modalities).toEqual(["text"]);
    expect(session.instructions).toBe("");
    expect(session.tools).toEqual([]);
    expect(session.voice).toBeNull();
    expect(session.temperature).toBe(0.8);

    ws.close();
  });

  it("acknowledges session.update with session.updated", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/realtime");

    // Skip session.created
    await ws.waitForMessages(1);

    ws.send(
      sessionUpdate({
        tools: [{ type: "function", name: "get_weather" }],
        instructions: "You are helpful.",
      }),
    );

    const raw = await ws.waitForMessages(2);
    const event = JSON.parse(raw[1]) as WSEvent;

    expect(event.type).toBe("session.updated");
    const session = event.session as Record<string, unknown>;
    expect(session.instructions).toBe("You are helpful.");
    expect(session.tools).toEqual([{ type: "function", name: "get_weather" }]);

    ws.close();
  });

  it("streams text response events for conversation + response.create", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/realtime");

    // Skip session.created
    await ws.waitForMessages(1);

    ws.send(conversationItemCreate("user", "hello"));

    // Wait for conversation.item.created ack
    const ackRaw = await ws.waitForMessages(2);
    const ackEvent = JSON.parse(ackRaw[1]) as WSEvent;
    expect(ackEvent.type).toBe("conversation.item.created");

    ws.send(responseCreate());

    // Text stream: response.created + output_item.added + content_part.added
    // + text.delta(s) + text.done + content_part.done + output_item.done + response.done
    // = 8 minimum events (1 delta for small text with default chunkSize=20)
    // Total messages: 2 (session.created + item.created) + 8 = 10
    const allRaw = await ws.waitForMessages(10);
    const responseEvents = parseEvents(allRaw.slice(2));

    const types = responseEvents.map((e) => e.type);
    expect(types[0]).toBe("response.created");
    expect(types).toContain("response.output_item.added");
    expect(types).toContain("response.content_part.added");
    expect(types).toContain("response.text.delta");
    expect(types).toContain("response.text.done");
    expect(types).toContain("response.content_part.done");
    expect(types).toContain("response.output_item.done");
    expect(types[types.length - 1]).toBe("response.done");

    // Verify text deltas reconstruct to "Hi there!"
    const deltas = responseEvents.filter((e) => e.type === "response.text.delta");
    const fullText = deltas.map((d) => d.delta).join("");
    expect(fullText).toBe("Hi there!");

    // Verify response.done contains completed response
    const doneEvent = responseEvents[responseEvents.length - 1];
    const resp = doneEvent.response as Record<string, unknown>;
    expect(resp.status).toBe("completed");
    expect(Array.isArray(resp.output)).toBe(true);

    ws.close();
  });

  it("streams tool call events with function_call_arguments deltas", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/realtime");

    await ws.waitForMessages(1); // session.created

    ws.send(conversationItemCreate("user", "weather"));
    await ws.waitForMessages(2); // + conversation.item.created

    ws.send(responseCreate());

    // Tool call stream: response.created + output_item.added
    // + function_call_arguments.delta(s) + function_call_arguments.done
    // + output_item.done + response.done = 6 min events
    // Total: 2 + 6 = 8
    const allRaw = await ws.waitForMessages(8);
    const responseEvents = parseEvents(allRaw.slice(2));

    const types = responseEvents.map((e) => e.type);
    expect(types[0]).toBe("response.created");
    expect(types).toContain("response.output_item.added");
    expect(types).toContain("response.function_call_arguments.delta");
    expect(types).toContain("response.function_call_arguments.done");
    expect(types).toContain("response.output_item.done");
    expect(types[types.length - 1]).toBe("response.done");

    // Verify argument deltas reconstruct correctly
    const argDeltas = responseEvents.filter(
      (e) => e.type === "response.function_call_arguments.delta",
    );
    const fullArgs = argDeltas.map((d) => d.delta).join("");
    expect(fullArgs).toBe('{"city":"NYC"}');

    // Verify output_item.added has function_call type
    const addedItem = responseEvents.find((e) => e.type === "response.output_item.added");
    const item = addedItem!.item as Record<string, unknown>;
    expect(item.type).toBe("function_call");
    expect(item.name).toBe("get_weather");

    ws.close();
  });

  it("sends error in response.done when no fixture matches", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/realtime");

    await ws.waitForMessages(1); // session.created

    ws.send(conversationItemCreate("user", "unknown-message-that-matches-nothing"));
    await ws.waitForMessages(2); // + conversation.item.created

    ws.send(responseCreate());

    // response.created + response.done (failed) = 2 events
    // Total: 2 + 2 = 4
    const allRaw = await ws.waitForMessages(4);
    const responseEvents = parseEvents(allRaw.slice(2));

    expect(responseEvents[0].type).toBe("response.created");
    const resp = responseEvents[0].response as Record<string, unknown>;
    expect(resp.status).toBe("failed");

    expect(responseEvents[1].type).toBe("response.done");
    const doneResp = responseEvents[1].response as Record<string, unknown>;
    expect(doneResp.status).toBe("failed");
    const details = doneResp.status_details as Record<string, unknown>;
    expect(details.type).toBe("error");
    const error = details.error as Record<string, unknown>;
    expect(error.message).toBe("No fixture matched");

    ws.close();
  });

  it("sends error in response.done for error fixture", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/realtime");

    await ws.waitForMessages(1); // session.created

    ws.send(conversationItemCreate("user", "fail"));
    await ws.waitForMessages(2); // + conversation.item.created

    ws.send(responseCreate());

    // response.created + response.done (failed) = 2 events
    // Total: 2 + 2 = 4
    const allRaw = await ws.waitForMessages(4);
    const responseEvents = parseEvents(allRaw.slice(2));

    expect(responseEvents[0].type).toBe("response.created");
    expect(responseEvents[1].type).toBe("response.done");

    const doneResp = responseEvents[1].response as Record<string, unknown>;
    expect(doneResp.status).toBe("failed");
    const details = doneResp.status_details as Record<string, unknown>;
    const error = details.error as Record<string, unknown>;
    expect(error.message).toBe("Rate limited");
    expect(error.type).toBe("rate_limit_error");

    ws.close();
  });

  it("records journal entries with method WS and path /v1/realtime", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/realtime");

    await ws.waitForMessages(1); // session.created

    ws.send(conversationItemCreate("user", "hello"));
    await ws.waitForMessages(2); // + conversation.item.created

    ws.send(responseCreate());

    // Wait for full text response sequence
    await ws.waitForMessages(10);
    // Small pause to ensure the journal write has completed
    await new Promise((r) => setTimeout(r, 50));

    expect(instance.journal.size).toBe(1);
    const entry = instance.journal.getLast();
    expect(entry!.method).toBe("WS");
    expect(entry!.path).toBe("/v1/realtime");
    expect(entry!.response.status).toBe(200);
    expect(entry!.response.fixture).toBe(textFixture);

    ws.close();
  });

  it("truncateAfterChunks stops text stream early, no response.done event", async () => {
    const truncFixture: Fixture = {
      match: { userMessage: "truncate-rt" },
      response: { content: "ABCDEFGHIJKLMNO" }, // 15 chars, chunkSize 3 => 5 delta chunks
      chunkSize: 3,
      latency: 5,
      truncateAfterChunks: 2,
    };
    instance = await createServer([truncFixture]);
    const ws = await connectWebSocket(instance.url, "/v1/realtime");

    await ws.waitForMessages(1); // session.created

    ws.send(conversationItemCreate("user", "truncate-rt"));
    await ws.waitForMessages(2); // + conversation.item.created

    ws.send(responseCreate());

    // Wait for connection to be destroyed
    await ws.waitForClose();

    // Small pause for server-side processing
    await new Promise((r) => setTimeout(r, 50));

    // The connection was destroyed, so whatever messages arrived should NOT include response.done
    // We got at least session.created + conversation.item.created = 2 before the response
    const raw = await ws.waitForMessages(2).catch(() => [] as string[]);
    if (raw.length > 2) {
      const responseEvents = parseEvents(raw.slice(2));
      const types = responseEvents.map((e) => e.type);
      expect(types).not.toContain("response.done");
    }
  });

  it("truncateAfterChunks records interrupted: true in journal", async () => {
    const truncFixture: Fixture = {
      match: { userMessage: "truncate-journal-rt" },
      response: { content: "ABCDEFGHIJKLMNO" },
      chunkSize: 3,
      latency: 5,
      truncateAfterChunks: 2,
    };
    instance = await createServer([truncFixture]);
    const ws = await connectWebSocket(instance.url, "/v1/realtime");

    await ws.waitForMessages(1); // session.created

    ws.send(conversationItemCreate("user", "truncate-journal-rt"));
    await ws.waitForMessages(2); // + conversation.item.created

    ws.send(responseCreate());

    // Wait for connection to be destroyed
    await ws.waitForClose();

    // Give server time to finalize journal
    await new Promise((r) => setTimeout(r, 50));

    const entry = instance.journal.getLast();
    expect(entry).not.toBeNull();
    expect(entry!.response.interrupted).toBe(true);
    expect(entry!.response.interruptReason).toBe("truncateAfterChunks");
  });

  it("truncateAfterChunks with toolCalls records interrupted: true in journal", async () => {
    const truncFixture: Fixture = {
      match: { userMessage: "truncate-tool-rt" },
      response: {
        toolCalls: [{ name: "search", arguments: '{"query":"hello world test string"}' }],
      },
      chunkSize: 3,
      latency: 5,
      truncateAfterChunks: 2,
    };
    instance = await createServer([truncFixture]);
    const ws = await connectWebSocket(instance.url, "/v1/realtime");

    await ws.waitForMessages(1); // session.created

    ws.send(conversationItemCreate("user", "truncate-tool-rt"));
    await ws.waitForMessages(2); // + conversation.item.created

    ws.send(responseCreate());

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
      match: { userMessage: "disconnect-rt" },
      response: { content: "ABCDEFGHIJKLMNOPQRSTUVWXYZ" },
      chunkSize: 1,
      latency: 20,
      disconnectAfterMs: 30,
    };
    instance = await createServer([fixture]);
    const ws = await connectWebSocket(instance.url, "/v1/realtime");

    await ws.waitForMessages(1); // session.created

    ws.send(conversationItemCreate("user", "disconnect-rt"));
    await ws.waitForMessages(2); // + conversation.item.created

    ws.send(responseCreate());

    await ws.waitForClose();
    await new Promise((r) => setTimeout(r, 50));

    const entry = instance.journal.getLast();
    expect(entry).not.toBeNull();
    expect(entry!.response.interrupted).toBe(true);
    expect(entry!.response.interruptReason).toBe("disconnectAfterMs");
  });

  it("accumulates conversation state across multiple response.create calls", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/realtime");

    await ws.waitForMessages(1); // session.created

    // First conversation turn
    ws.send(conversationItemCreate("user", "hello"));
    await ws.waitForMessages(2); // + conversation.item.created

    ws.send(responseCreate());

    // Wait for full text response (8 events) => total 10
    await ws.waitForMessages(10);

    // Second conversation turn — add another user message
    ws.send(conversationItemCreate("user", "weather"));

    // + conversation.item.created => total 11
    await ws.waitForMessages(11);

    ws.send(responseCreate());

    // Tool call response (6 events) => total 17
    const allRaw = await ws.waitForMessages(17);
    const secondResponseEvents = parseEvents(allRaw.slice(11));

    const types = secondResponseEvents.map((e) => e.type);
    expect(types[0]).toBe("response.created");
    expect(types).toContain("response.function_call_arguments.delta");
    expect(types[types.length - 1]).toBe("response.done");

    // Should have 2 journal entries total
    await new Promise((r) => setTimeout(r, 50));
    expect(instance.journal.size).toBe(2);

    ws.close();
  });
});
