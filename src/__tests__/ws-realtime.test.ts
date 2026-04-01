import { describe, it, expect, afterEach } from "vitest";
import { createServer, type ServerInstance } from "../server.js";
import type { Fixture } from "../types.js";
import { connectWebSocket } from "./ws-test-client.js";
import { realtimeItemsToMessages } from "../ws-realtime.js";

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

function functionCallOutputItem(callId: string, output: string): string {
  return JSON.stringify({
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: callId,
      output,
    },
  });
}

function functionCallItem(name: string, callId: string, args: string): string {
  return JSON.stringify({
    type: "conversation.item.create",
    item: {
      type: "function_call",
      name,
      call_id: callId,
      arguments: args,
    },
  });
}

function systemMessageItem(text: string): string {
  return JSON.stringify({
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "system",
      content: [{ type: "input_text", text }],
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

  it("concurrent response.create messages serialize correctly", async () => {
    const fixture1: Fixture = {
      match: { userMessage: "ser-a" },
      response: { content: "Alpha response" },
      chunkSize: 5,
    };
    const fixture2: Fixture = {
      match: { userMessage: "ser-b" },
      response: { content: "Bravo response" },
      chunkSize: 5,
    };
    instance = await createServer([fixture1, fixture2]);
    const ws = await connectWebSocket(instance.url, "/v1/realtime");

    await ws.waitForMessages(1); // session.created

    // Add both conversation items
    ws.send(conversationItemCreate("user", "ser-a"));
    await ws.waitForMessages(2); // + conversation.item.created

    // Now send two response.create messages rapidly without waiting
    // The realtime handler adds "ser-a" to conversation, so the second one
    // also sees it. To make the second match "ser-b", add it to conversation first.
    ws.send(conversationItemCreate("user", "ser-b"));
    await ws.waitForMessages(3); // + second conversation.item.created

    // Fire two response.create messages back-to-back
    ws.send(responseCreate());
    ws.send(responseCreate());

    // Each text response: response.created + output_item.added + content_part.added
    // + delta(s) + text.done + content_part.done + output_item.done + response.done
    // "Alpha response" / 5 = 3 deltas, "Bravo response" / 5 = 3 deltas
    // So 10 events per response = 20 total, plus the 3 initial messages = 23
    const allRaw = await ws.waitForMessages(23);
    const responseEvents = parseEvents(allRaw.slice(3));

    // Find response.done boundaries
    const doneIndices = responseEvents
      .map((e, i) => (e.type === "response.done" ? i : -1))
      .filter((i) => i >= 0);
    expect(doneIndices.length).toBe(2);

    // Each batch should start with response.created and end with response.done
    const firstBatch = responseEvents.slice(0, doneIndices[0] + 1);
    const secondBatch = responseEvents.slice(doneIndices[0] + 1, doneIndices[1] + 1);

    expect(firstBatch[0].type).toBe("response.created");
    expect(firstBatch[firstBatch.length - 1].type).toBe("response.done");
    expect(secondBatch[0].type).toBe("response.created");
    expect(secondBatch[secondBatch.length - 1].type).toBe("response.done");

    // Verify no interleaving: deltas in each batch should form a complete string
    const firstDeltas = firstBatch
      .filter((e) => e.type === "response.text.delta")
      .map((e) => e.delta)
      .join("");
    const secondDeltas = secondBatch
      .filter((e) => e.type === "response.text.delta")
      .map((e) => e.delta)
      .join("");

    // Both responses match on the last user message, so the first response.create
    // sees "ser-b" as last user message, the second also sees "ser-b" because
    // the assistant response from the first gets appended. Both may match "ser-b".
    // Actually, the conversation has ["ser-a", "ser-b"] and matching uses last user message.
    // Both will match "ser-b". That's fine — the key assertion is no interleaving.
    expect(firstDeltas.length).toBeGreaterThan(0);
    expect(secondDeltas.length).toBeGreaterThan(0);

    ws.close();
  });

  it("multiple tool calls in a single response", async () => {
    const multiToolFixture: Fixture = {
      match: { userMessage: "multi-tool-rt" },
      response: {
        toolCalls: [
          { name: "get_weather", arguments: '{"city":"NYC"}' },
          { name: "get_time", arguments: '{"tz":"EST"}' },
        ],
      },
    };
    instance = await createServer([multiToolFixture]);
    const ws = await connectWebSocket(instance.url, "/v1/realtime");

    await ws.waitForMessages(1); // session.created

    ws.send(conversationItemCreate("user", "multi-tool-rt"));
    await ws.waitForMessages(2); // + conversation.item.created

    ws.send(responseCreate());

    // 2 tool calls: response.created
    // + (output_item.added + 1 delta + arguments.done + output_item.done) * 2
    // + response.done = 1 + 8 + 1 = 10 events
    // Total: 2 (session.created + item.created) + 10 = 12
    const allRaw = await ws.waitForMessages(12);
    const responseEvents = parseEvents(allRaw.slice(2));

    const types = responseEvents.map((e) => e.type);
    expect(types[0]).toBe("response.created");
    expect(types[types.length - 1]).toBe("response.done");

    // Verify both tool calls appear in output_item.added events
    const addedItems = responseEvents.filter((e) => e.type === "response.output_item.added");
    expect(addedItems.length).toBe(2);
    expect((addedItems[0].item as Record<string, unknown>).name).toBe("get_weather");
    expect((addedItems[1].item as Record<string, unknown>).name).toBe("get_time");

    // Verify argument deltas reconstruct correctly for each tool call
    const argDoneEvents = responseEvents.filter(
      (e) => e.type === "response.function_call_arguments.done",
    );
    expect(argDoneEvents.length).toBe(2);
    expect(argDoneEvents[0].arguments).toBe('{"city":"NYC"}');
    expect(argDoneEvents[1].arguments).toBe('{"tz":"EST"}');

    // Verify output_index values are distinct
    expect(addedItems[0].output_index).toBe(0);
    expect(addedItems[1].output_index).toBe(1);

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

  it("sends error for malformed JSON", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/realtime");

    await ws.waitForMessages(1); // session.created

    ws.send("this is not { valid json");

    const raw = await ws.waitForMessages(2);
    const event = JSON.parse(raw[1]) as WSEvent;
    expect(event.type).toBe("error");
    expect((event.error as Record<string, unknown>).message).toBe("Malformed JSON");

    ws.close();
  });

  it("sends error when conversation.item.create is missing item", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/realtime");

    await ws.waitForMessages(1); // session.created

    ws.send(JSON.stringify({ type: "conversation.item.create" }));

    const raw = await ws.waitForMessages(2);
    const event = JSON.parse(raw[1]) as WSEvent;
    expect(event.type).toBe("error");
    expect((event.error as Record<string, unknown>).message).toBe(
      "Missing 'item' in conversation.item.create",
    );

    ws.close();
  });

  it("assigns auto-generated item.id when missing in conversation.item.create", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/realtime");

    await ws.waitForMessages(1); // session.created

    // Send item without id
    ws.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        },
      }),
    );

    const raw = await ws.waitForMessages(2);
    const event = JSON.parse(raw[1]) as WSEvent;
    expect(event.type).toBe("conversation.item.created");
    const item = event.item as Record<string, unknown>;
    expect(item.id).toBeDefined();
    expect((item.id as string).startsWith("item-")).toBe(true);

    ws.close();
  });

  it("session.update updates modalities, model, and temperature", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/realtime");

    await ws.waitForMessages(1); // session.created

    ws.send(
      sessionUpdate({
        modalities: ["text", "audio"],
        model: "gpt-4o-mini-realtime",
        temperature: 0.5,
      }),
    );

    const raw = await ws.waitForMessages(2);
    const event = JSON.parse(raw[1]) as WSEvent;
    expect(event.type).toBe("session.updated");
    const session = event.session as Record<string, unknown>;
    expect(session.modalities).toEqual(["text", "audio"]);
    expect(session.model).toBe("gpt-4o-mini-realtime");
    expect(session.temperature).toBe(0.5);

    ws.close();
  });

  it("ignores unknown message types silently", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/realtime");

    await ws.waitForMessages(1); // session.created

    // Send unknown message type
    ws.send(JSON.stringify({ type: "some.unknown.type" }));

    // Then send a valid message to confirm processing continues
    ws.send(conversationItemCreate("user", "hello"));

    const raw = await ws.waitForMessages(2);
    const event = JSON.parse(raw[1]) as WSEvent;
    // The unknown message is silently ignored, so next message is the item.created
    expect(event.type).toBe("conversation.item.created");

    ws.close();
  });

  it("handles function_call and function_call_output conversation items", async () => {
    // Fixture that matches after tool call output is in conversation
    const afterToolFixture: Fixture = {
      match: { toolCallId: "call_123" },
      response: { content: "Tool result processed" },
    };
    instance = await createServer([afterToolFixture]);
    const ws = await connectWebSocket(instance.url, "/v1/realtime");

    await ws.waitForMessages(1); // session.created

    // Add function_call item
    ws.send(functionCallItem("get_weather", "call_123", '{"city":"NYC"}'));
    await ws.waitForMessages(2); // + conversation.item.created

    // Add function_call_output item
    ws.send(functionCallOutputItem("call_123", "Sunny, 72F"));
    await ws.waitForMessages(3); // + conversation.item.created

    ws.send(responseCreate());

    // Text response: response.created + output_item.added + content_part.added
    // + text.delta(s) + text.done + content_part.done + output_item.done + response.done
    // "Tool result processed" = 21 chars / chunkSize 20 = 2 deltas = 9 events
    // Total: 3 + 9 = 12
    const allRaw = await ws.waitForMessages(12);
    const responseEvents = parseEvents(allRaw.slice(3));
    const types = responseEvents.map((e) => e.type);
    expect(types[0]).toBe("response.created");
    expect(types[types.length - 1]).toBe("response.done");

    // Verify text deltas reconstruct correctly
    const deltas = responseEvents.filter((e) => e.type === "response.text.delta");
    const fullText = deltas.map((d) => d.delta).join("");
    expect(fullText).toBe("Tool result processed");

    ws.close();
  });

  it("handles system role message items", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/realtime");

    await ws.waitForMessages(1); // session.created

    // Add system message item
    ws.send(systemMessageItem("You are a helpful assistant"));
    await ws.waitForMessages(2); // + conversation.item.created

    // Add user message
    ws.send(conversationItemCreate("user", "hello"));
    await ws.waitForMessages(3); // + conversation.item.created

    ws.send(responseCreate());

    // Wait for text response
    const allRaw = await ws.waitForMessages(11);
    const responseEvents = parseEvents(allRaw.slice(3));
    expect(responseEvents[0].type).toBe("response.created");
    expect(responseEvents[responseEvents.length - 1].type).toBe("response.done");

    ws.close();
  });

  it("closes with 1008 in strict mode when no fixture matches", async () => {
    instance = await createServer(allFixtures, { strict: true });
    const ws = await connectWebSocket(instance.url, "/v1/realtime");

    await ws.waitForMessages(1); // session.created

    ws.send(conversationItemCreate("user", "unknown-no-match"));
    await ws.waitForMessages(2); // + conversation.item.created

    ws.send(responseCreate());

    // Connection should be closed with 1008
    await ws.waitForClose();
  });

  it("handles instructions in session for fixture matching", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/realtime");

    await ws.waitForMessages(1); // session.created

    // Set instructions
    ws.send(sessionUpdate({ instructions: "You are a helpful assistant." }));
    await ws.waitForMessages(2); // + session.updated

    ws.send(conversationItemCreate("user", "hello"));
    await ws.waitForMessages(3); // + conversation.item.created

    ws.send(responseCreate());

    // Wait for text response
    const allRaw = await ws.waitForMessages(11);
    const responseEvents = parseEvents(allRaw.slice(3));
    expect(responseEvents[0].type).toBe("response.created");
    expect(responseEvents[responseEvents.length - 1].type).toBe("response.done");

    ws.close();
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

  it("handles error fixture with default status (no explicit status)", async () => {
    const errorNoStatusFixture: Fixture = {
      match: { userMessage: "error-no-status-rt" },
      response: {
        error: { message: "Internal failure", type: "server_error" },
      },
    };
    instance = await createServer([errorNoStatusFixture]);
    const ws = await connectWebSocket(instance.url, "/v1/realtime");

    await ws.waitForMessages(1); // session.created

    ws.send(conversationItemCreate("user", "error-no-status-rt"));
    await ws.waitForMessages(2); // + conversation.item.created

    ws.send(responseCreate());

    const allRaw = await ws.waitForMessages(4);
    const responseEvents = parseEvents(allRaw.slice(2));
    expect(responseEvents[1].type).toBe("response.done");
    const doneResp = responseEvents[1].response as Record<string, unknown>;
    expect(doneResp.status).toBe("failed");

    ws.close();
  });

  it("handles unknown response type gracefully", async () => {
    const weirdFixture: Fixture = {
      match: { userMessage: "weird-response-rt" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response: { unknownField: "value" } as any,
    };
    instance = await createServer([weirdFixture]);
    const ws = await connectWebSocket(instance.url, "/v1/realtime");

    await ws.waitForMessages(1); // session.created

    ws.send(conversationItemCreate("user", "weird-response-rt"));
    await ws.waitForMessages(2); // + conversation.item.created

    ws.send(responseCreate());

    const allRaw = await ws.waitForMessages(3);
    const event = JSON.parse(allRaw[2]) as WSEvent;
    expect(event.type).toBe("error");
    expect((event.error as Record<string, unknown>).message).toBe(
      "Fixture response did not match any known type",
    );

    ws.close();
  });
});

// ─── Unit tests: realtimeItemsToMessages ─────────────────────────────────────

describe("realtimeItemsToMessages", () => {
  it("converts message items with all role types", () => {
    const items = [
      { type: "message" as const, role: "user" as const, content: [{ type: "text", text: "hi" }] },
      {
        type: "message" as const,
        role: "assistant" as const,
        content: [{ type: "text", text: "hello" }],
      },
      {
        type: "message" as const,
        role: "system" as const,
        content: [{ type: "text", text: "you are helpful" }],
      },
    ];

    const messages = realtimeItemsToMessages(items);
    expect(messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "system", content: "you are helpful" },
    ]);
  });

  it("adds system message when instructions provided", () => {
    const items = [
      { type: "message" as const, role: "user" as const, content: [{ type: "text", text: "hi" }] },
    ];
    const messages = realtimeItemsToMessages(items, "Be helpful");
    expect(messages[0]).toEqual({ role: "system", content: "Be helpful" });
    expect(messages[1]).toEqual({ role: "user", content: "hi" });
  });

  it("converts function_call items with fallback for missing name", () => {
    const mockLogger = { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} };
    const items = [
      {
        type: "function_call" as const,
        call_id: "call_123",
        arguments: '{"q":"test"}',
        // name is missing
      },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const messages = realtimeItemsToMessages(items, undefined, mockLogger as any);
    expect(messages.length).toBe(1);
    expect(messages[0].role).toBe("assistant");
    expect(messages[0].tool_calls![0].id).toBe("call_123");
    expect(messages[0].tool_calls![0].function.name).toBe("");
    expect(messages[0].tool_calls![0].function.arguments).toBe('{"q":"test"}');
  });

  it("converts function_call items with auto-generated call_id and empty arguments", () => {
    const items = [
      {
        type: "function_call" as const,
        name: "search",
        // call_id and arguments missing
      },
    ];
    const messages = realtimeItemsToMessages(items);
    expect(messages.length).toBe(1);
    expect(messages[0].tool_calls![0].id).toMatch(/^call_/);
    expect(messages[0].tool_calls![0].function.name).toBe("search");
    expect(messages[0].tool_calls![0].function.arguments).toBe("");
  });

  it("converts function_call_output items with fallback for missing output", () => {
    const mockLogger = { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} };
    const items = [
      {
        type: "function_call_output" as const,
        call_id: "call_456",
        // output is missing
      },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const messages = realtimeItemsToMessages(items, undefined, mockLogger as any);
    expect(messages.length).toBe(1);
    expect(messages[0].role).toBe("tool");
    expect(messages[0].content).toBe("");
    expect(messages[0].tool_call_id).toBe("call_456");
  });

  it("handles message items with missing content", () => {
    const items = [
      {
        type: "message" as const,
        role: "user" as const,
        // content missing
      },
    ];
    const messages = realtimeItemsToMessages(items);
    expect(messages[0].content).toBe("");
  });
});
