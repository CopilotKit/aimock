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

const contentWithToolCallsFixture: Fixture = {
  match: { userMessage: "commentary-phase" },
  response: {
    content: "Let me check the weather for you.",
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

const allFixtures: Fixture[] = [
  textFixture,
  toolFixture,
  contentWithToolCallsFixture,
  errorFixture,
];

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
    expect((event.event_id as string).startsWith("event_")).toBe(true);

    const session = event.session as Record<string, unknown>;
    expect(session.id).toBeDefined();
    expect((session.id as string).startsWith("sess_")).toBe(true);
    expect(session.object).toBe("realtime.session");
    expect(session.modalities).toEqual(["text"]);
    expect(session.instructions).toBe("");
    expect(session.tools).toEqual([]);
    expect(session.temperature).toBe(0.8);
    expect(typeof session.expires_at).toBe("number");
    expect(session.max_response_output_tokens).toBe("inf");
    expect(session.tool_choice).toBe("auto");
    expect(session.type).toBe("conversation");
    expect(session.reasoning).toBeNull();
    // GA nested audio config
    const audio = session.audio as Record<string, unknown>;
    expect(audio).toBeDefined();
    expect(audio.voice).toBeNull();
    expect(audio.input_audio_format).toBeNull();
    expect(audio.output_audio_format).toBeNull();
    expect(audio.input_audio_noise_reduction).toBeNull();
    expect(audio.input_audio_transcription).toBeNull();

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
    expect(session.object).toBe("realtime.session");
    expect(typeof session.expires_at).toBe("number");
    expect(session.max_response_output_tokens).toBe("inf");
    expect(session.tool_choice).toBe("auto");
    expect(session.type).toBe("conversation");
    // GA nested audio config
    const audio = session.audio as Record<string, unknown>;
    expect(audio).toBeDefined();
    expect(audio.voice).toBeNull();

    ws.close();
  });

  it("streams text response events for conversation + response.create", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/realtime");

    // Skip session.created
    await ws.waitForMessages(1);

    ws.send(conversationItemCreate("user", "hello"));

    // Wait for conversation.item.added ack (GA name)
    const ackRaw = await ws.waitForMessages(2);
    const ackEvent = JSON.parse(ackRaw[1]) as WSEvent;
    expect(ackEvent.type).toBe("conversation.item.added");

    ws.send(responseCreate());

    // Text stream: response.created + output_item.added + content_part.added
    // + output_text.delta(s) + output_text.done + content_part.done + output_item.done
    // + conversation.item.done + response.done
    // = 9 minimum events (1 delta for small text with default chunkSize=20)
    // Total messages: 2 (session.created + item.added) + 9 = 11
    const allRaw = await ws.waitForMessages(11);
    const responseEvents = parseEvents(allRaw.slice(2));

    const types = responseEvents.map((e) => e.type);
    expect(types[0]).toBe("response.created");
    expect(types).toContain("response.output_item.added");
    expect(types).toContain("response.content_part.added");
    expect(types).toContain("response.output_text.delta");
    expect(types).toContain("response.output_text.done");
    expect(types).toContain("response.content_part.done");
    expect(types).toContain("response.output_item.done");
    expect(types[types.length - 1]).toBe("response.done");

    // Verify text deltas reconstruct to "Hi there!"
    const deltas = responseEvents.filter((e) => e.type === "response.output_text.delta");
    const fullText = deltas.map((d) => d.delta).join("");
    expect(fullText).toBe("Hi there!");

    // Verify response.created has correct response resource fields
    const createdEvent = responseEvents[0];
    const createdResp = createdEvent.response as Record<string, unknown>;
    expect(createdResp.object).toBe("realtime.response");
    expect(createdResp.status).toBe("in_progress");
    expect(createdResp.status_details).toBeNull();
    expect(createdResp.usage).toBeNull();
    expect((createdResp.id as string).startsWith("resp_")).toBe(true);

    // Verify output_item.added has status "in_progress"
    const addedEvent = responseEvents.find((e) => e.type === "response.output_item.added");
    const addedItem = addedEvent!.item as Record<string, unknown>;
    expect(addedItem.status).toBe("in_progress");

    // Verify output_item.done has status "completed"
    const doneItemEvent = responseEvents.find((e) => e.type === "response.output_item.done");
    const doneItem = doneItemEvent!.item as Record<string, unknown>;
    expect(doneItem.status).toBe("completed");

    // Verify response.done contains completed response with new fields
    const doneEvent = responseEvents[responseEvents.length - 1];
    const resp = doneEvent.response as Record<string, unknown>;
    expect(resp.status).toBe("completed");
    expect(resp.object).toBe("realtime.response");
    expect(resp.usage).toEqual({ total_tokens: 0, input_tokens: 0, output_tokens: 0 });
    expect(Array.isArray(resp.output)).toBe(true);

    // Verify conversation.item.added has previous_item_id (null for first item)
    const itemAddedEvent = parseEvents(allRaw.slice(1, 2))[0];
    expect(itemAddedEvent.type).toBe("conversation.item.added");
    expect(itemAddedEvent.previous_item_id).toBeNull();

    // Send a second item and verify previous_item_id points to the last conversation item
    // (the assistant response item pushed during handleResponseCreate)
    const assistantItemId = (doneItem as Record<string, unknown>).id as string;
    ws.send(conversationItemCreate("user", "how are you?"));
    const secondAckRaw = await ws.waitForMessages(allRaw.length + 1);
    const secondAckEvent = JSON.parse(secondAckRaw[secondAckRaw.length - 1]) as WSEvent;
    expect(secondAckEvent.type).toBe("conversation.item.added");
    expect(secondAckEvent.previous_item_id).toBe(assistantItemId);

    ws.close();
  });

  it("streams tool call events with function_call_arguments deltas", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/realtime");

    await ws.waitForMessages(1); // session.created

    ws.send(conversationItemCreate("user", "weather"));
    await ws.waitForMessages(2); // + conversation.item.added

    ws.send(responseCreate());

    // Tool call stream: response.created + output_item.added
    // + function_call_arguments.delta(s) + function_call_arguments.done
    // + output_item.done + conversation.item.done + response.done = 7 min events
    // Total: 2 + 7 = 9
    const allRaw = await ws.waitForMessages(9);
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

    // Verify output_item.added has function_call type and status
    const addedItem = responseEvents.find((e) => e.type === "response.output_item.added");
    const item = addedItem!.item as Record<string, unknown>;
    expect(item.type).toBe("function_call");
    expect(item.name).toBe("get_weather");
    expect(item.status).toBe("in_progress");

    // Verify output_item.done has status "completed"
    const doneItemEvent = responseEvents.find((e) => e.type === "response.output_item.done");
    const doneItem = doneItemEvent!.item as Record<string, unknown>;
    expect(doneItem.status).toBe("completed");

    // Verify response.created has object and usage fields
    const createdResp = responseEvents[0].response as Record<string, unknown>;
    expect(createdResp.object).toBe("realtime.response");
    expect(createdResp.status_details).toBeNull();
    expect(createdResp.usage).toBeNull();

    // Verify response.done has object and usage fields
    const doneResp = responseEvents[responseEvents.length - 1].response as Record<string, unknown>;
    expect(doneResp.object).toBe("realtime.response");
    expect(doneResp.usage).toEqual({ total_tokens: 0, input_tokens: 0, output_tokens: 0 });

    ws.close();
  });

  it("sends error in response.done when no fixture matches", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/realtime");

    await ws.waitForMessages(1); // session.created

    ws.send(conversationItemCreate("user", "unknown-message-that-matches-nothing"));
    await ws.waitForMessages(2); // + conversation.item.added

    ws.send(responseCreate());

    // response.created + response.done (failed) = 2 events
    // Total: 2 + 2 = 4
    const allRaw = await ws.waitForMessages(4);
    const responseEvents = parseEvents(allRaw.slice(2));

    expect(responseEvents[0].type).toBe("response.created");
    const resp = responseEvents[0].response as Record<string, unknown>;
    expect(resp.status).toBe("failed");
    expect(resp.object).toBe("realtime.response");
    expect(resp.status_details).toBeNull();
    expect(resp.usage).toBeNull();

    expect(responseEvents[1].type).toBe("response.done");
    const doneResp = responseEvents[1].response as Record<string, unknown>;
    expect(doneResp.status).toBe("failed");
    expect(doneResp.object).toBe("realtime.response");
    expect(doneResp.usage).toEqual({ total_tokens: 0, input_tokens: 0, output_tokens: 0 });
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
    await ws.waitForMessages(2); // + conversation.item.added

    ws.send(responseCreate());

    // response.created + response.done (failed) = 2 events
    // Total: 2 + 2 = 4
    const allRaw = await ws.waitForMessages(4);
    const responseEvents = parseEvents(allRaw.slice(2));

    expect(responseEvents[0].type).toBe("response.created");
    const createdResp = responseEvents[0].response as Record<string, unknown>;
    expect(createdResp.object).toBe("realtime.response");
    expect(createdResp.status_details).toBeNull();
    expect(createdResp.usage).toBeNull();

    expect(responseEvents[1].type).toBe("response.done");
    const doneResp = responseEvents[1].response as Record<string, unknown>;
    expect(doneResp.status).toBe("failed");
    expect(doneResp.object).toBe("realtime.response");
    expect(doneResp.usage).toEqual({ total_tokens: 0, input_tokens: 0, output_tokens: 0 });
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
    await ws.waitForMessages(2); // + conversation.item.added

    ws.send(responseCreate());

    // Wait for full text response sequence (9 response events + 2 initial = 11)
    await ws.waitForMessages(11);
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
    await ws.waitForMessages(2); // + conversation.item.added

    // Now send two response.create messages rapidly without waiting
    // The realtime handler adds "ser-a" to conversation, so the second one
    // also sees it. To make the second match "ser-b", add it to conversation first.
    ws.send(conversationItemCreate("user", "ser-b"));
    await ws.waitForMessages(3); // + second conversation.item.added

    // Fire two response.create messages back-to-back
    ws.send(responseCreate());
    ws.send(responseCreate());

    // Each text response: response.created + output_item.added + content_part.added
    // + delta(s) + text.done + content_part.done + output_item.done + conversation.item.done + response.done
    // "Alpha response" / 5 = 3 deltas, "Bravo response" / 5 = 3 deltas
    // So 11 events per response = 22 total, plus the 3 initial messages = 25
    const allRaw = await ws.waitForMessages(25);
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
      .filter((e) => e.type === "response.output_text.delta")
      .map((e) => e.delta)
      .join("");
    const secondDeltas = secondBatch
      .filter((e) => e.type === "response.output_text.delta")
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
    await ws.waitForMessages(2); // + conversation.item.added

    ws.send(responseCreate());

    // 2 tool calls: response.created
    // + (output_item.added + 1 delta + arguments.done + output_item.done + conversation.item.done) * 2
    // + response.done = 1 + 10 + 1 = 12 events
    // Total: 2 (session.created + item.created) + 12 = 14
    const allRaw = await ws.waitForMessages(14);
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
    await ws.waitForMessages(2); // + conversation.item.added

    ws.send(responseCreate());

    // Wait for connection to be destroyed
    await ws.waitForClose();

    // Small pause for server-side processing
    await new Promise((r) => setTimeout(r, 50));

    // The connection was destroyed, so whatever messages arrived should NOT include response.done
    // We got at least session.created + conversation.item.added = 2 before the response
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
    await ws.waitForMessages(2); // + conversation.item.added

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
    await ws.waitForMessages(2); // + conversation.item.added

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
    await ws.waitForMessages(2); // + conversation.item.added

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
    expect((event.error as Record<string, unknown>).message).toMatch(/^Malformed JSON:/);

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
    expect(event.type).toBe("conversation.item.added");
    const item = event.item as Record<string, unknown>;
    expect(item.id).toBeDefined();
    expect((item.id as string).startsWith("item_")).toBe(true);

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
    expect(session.object).toBe("realtime.session");
    expect(typeof session.expires_at).toBe("number");
    expect(session.max_response_output_tokens).toBe("inf");
    expect(session.tool_choice).toBe("auto");
    expect(session.type).toBe("conversation");
    // GA nested audio config
    const audio = session.audio as Record<string, unknown>;
    expect(audio).toBeDefined();

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
    expect(event.type).toBe("conversation.item.added");

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
    await ws.waitForMessages(2); // + conversation.item.added

    // Add function_call_output item
    ws.send(functionCallOutputItem("call_123", "Sunny, 72F"));
    await ws.waitForMessages(3); // + conversation.item.added

    ws.send(responseCreate());

    // Text response: response.created + output_item.added + content_part.added
    // + text.delta(s) + text.done + content_part.done + output_item.done + conversation.item.done + response.done
    // "Tool result processed" = 21 chars / chunkSize 20 = 2 deltas = 10 events
    // Total: 3 + 10 = 13
    const allRaw = await ws.waitForMessages(13);
    const responseEvents = parseEvents(allRaw.slice(3));
    const types = responseEvents.map((e) => e.type);
    expect(types[0]).toBe("response.created");
    expect(types[types.length - 1]).toBe("response.done");

    // Verify text deltas reconstruct correctly
    const deltas = responseEvents.filter((e) => e.type === "response.output_text.delta");
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
    await ws.waitForMessages(2); // + conversation.item.added

    // Add user message
    ws.send(conversationItemCreate("user", "hello"));
    await ws.waitForMessages(3); // + conversation.item.added

    ws.send(responseCreate());

    // Wait for text response (9 response events + 3 initial = 12)
    const allRaw = await ws.waitForMessages(12);
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
    await ws.waitForMessages(2); // + conversation.item.added

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
    await ws.waitForMessages(3); // + conversation.item.added

    ws.send(responseCreate());

    // Wait for text response (9 response events + 3 initial = 12)
    const allRaw = await ws.waitForMessages(12);
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
    await ws.waitForMessages(2); // + conversation.item.added

    ws.send(responseCreate());

    // Wait for full text response (9 events) => total 11
    await ws.waitForMessages(11);

    // Second conversation turn — add another user message
    ws.send(conversationItemCreate("user", "weather"));

    // + conversation.item.added => total 12
    await ws.waitForMessages(12);

    ws.send(responseCreate());

    // Tool call response (7 events) => total 19
    const allRaw = await ws.waitForMessages(19);
    const secondResponseEvents = parseEvents(allRaw.slice(12));

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
    await ws.waitForMessages(2); // + conversation.item.added

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
    await ws.waitForMessages(2); // + conversation.item.added

    ws.send(responseCreate());

    const allRaw = await ws.waitForMessages(3);
    const event = JSON.parse(allRaw[2]) as WSEvent;
    expect(event.type).toBe("error");
    expect((event.error as Record<string, unknown>).message).toBe(
      "Fixture response did not match any known type",
    );

    ws.close();
  });

  // ── GA session config tests ───────────────────────────────────────────
  it("session.update accepts reasoning.effort", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/realtime");

    // Skip session.created
    await ws.waitForMessages(1);

    ws.send(
      JSON.stringify({
        type: "session.update",
        session: { reasoning: { effort: "high" } },
      }),
    );

    const raw = await ws.waitForMessages(2);
    const event = JSON.parse(raw[1]) as WSEvent;
    expect(event.type).toBe("session.updated");
    const session = event.session as Record<string, unknown>;
    expect(session.reasoning).toEqual({ effort: "high" });

    ws.close();
  });

  it("session.update accepts input_audio_noise_reduction via nested audio config", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/realtime");

    // Skip session.created
    await ws.waitForMessages(1);

    ws.send(
      JSON.stringify({
        type: "session.update",
        session: {
          audio: { input_audio_noise_reduction: { type: "near_field" } },
        },
      }),
    );

    const raw = await ws.waitForMessages(2);
    const event = JSON.parse(raw[1]) as WSEvent;
    expect(event.type).toBe("session.updated");
    const session = event.session as Record<string, unknown>;
    const audio = session.audio as Record<string, unknown>;
    expect(audio.input_audio_noise_reduction).toEqual({ type: "near_field" });

    ws.close();
  });

  it("session.update accepts input_audio_transcription via nested audio config", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/realtime");

    // Skip session.created
    await ws.waitForMessages(1);

    ws.send(
      JSON.stringify({
        type: "session.update",
        session: {
          audio: { input_audio_transcription: { model: "whisper-1" } },
        },
      }),
    );

    const raw = await ws.waitForMessages(2);
    const event = JSON.parse(raw[1]) as WSEvent;
    expect(event.type).toBe("session.updated");
    const session = event.session as Record<string, unknown>;
    const audio = session.audio as Record<string, unknown>;
    expect(audio.input_audio_transcription).toEqual({ model: "whisper-1" });

    ws.close();
  });

  it("session.update accepts GA nested audio config (voice, formats)", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/realtime");

    // Skip session.created
    await ws.waitForMessages(1);

    ws.send(
      JSON.stringify({
        type: "session.update",
        session: {
          audio: {
            voice: "alloy",
            input_audio_format: "pcm16",
            output_audio_format: "pcm16",
          },
          modalities: ["text", "audio"],
        },
      }),
    );

    const raw = await ws.waitForMessages(2);
    const event = JSON.parse(raw[1]) as WSEvent;
    expect(event.type).toBe("session.updated");
    const session = event.session as Record<string, unknown>;
    const audio = session.audio as Record<string, unknown>;
    expect(audio.voice).toBe("alloy");
    expect(audio.input_audio_format).toBe("pcm16");
    expect(audio.output_audio_format).toBe("pcm16");
    expect(session.modalities).toEqual(["text", "audio"]);

    ws.close();
  });

  it("reasoning persists across session.update calls", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/realtime");

    // Skip session.created
    await ws.waitForMessages(1);

    // First update: set reasoning
    ws.send(
      JSON.stringify({
        type: "session.update",
        session: { reasoning: { effort: "high" } },
      }),
    );

    const raw1 = await ws.waitForMessages(2);
    const event1 = JSON.parse(raw1[1]) as WSEvent;
    expect((event1.session as Record<string, unknown>).reasoning).toEqual({ effort: "high" });

    // Second update: change something else, reasoning should persist
    ws.send(sessionUpdate({ instructions: "Be helpful" }));

    const raw2 = await ws.waitForMessages(3);
    const event2 = JSON.parse(raw2[2]) as WSEvent;
    expect(event2.type).toBe("session.updated");
    const session2 = event2.session as Record<string, unknown>;
    expect(session2.reasoning).toEqual({ effort: "high" });
    expect(session2.instructions).toBe("Be helpful");

    // Third update: clear reasoning
    ws.send(
      JSON.stringify({
        type: "session.update",
        session: { reasoning: null },
      }),
    );

    const raw3 = await ws.waitForMessages(4);
    const event3 = JSON.parse(raw3[3]) as WSEvent;
    expect((event3.session as Record<string, unknown>).reasoning).toBeNull();

    ws.close();
  });

  // ── Image input tests ────────────────────────────────────────────────
  it("accepts input_image content in conversation.item.create", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/realtime");

    await ws.waitForMessages(1); // session.created

    ws.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "What is in this image?" },
            { type: "input_image", url: "https://example.com/photo.jpg" },
          ],
        },
      }),
    );

    const raw = await ws.waitForMessages(2);
    const event = parseEvents(raw.slice(1))[0];
    expect(event.type).toBe("conversation.item.added");
    const item = event.item as Record<string, unknown>;
    const content = item.content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(2);
    expect(content[0].type).toBe("input_text");
    expect(content[0].text).toBe("What is in this image?");
    expect(content[1].type).toBe("input_image");
    expect(content[1].url).toBe("https://example.com/photo.jpg");

    ws.close();
  });

  it("maps input_image to ChatMessage image_url format for fixture matching", async () => {
    // Use a predicate to verify the ChatMessage structure produced by realtimeItemsToMessages
    let capturedMessages: unknown[] | null = null;
    const imageFixture: Fixture = {
      match: {
        predicate: (req) => {
          capturedMessages = req.messages;
          // Match any request so we get a response
          const lastUser = req.messages.filter((m) => m.role === "user").pop();
          return !!lastUser;
        },
      },
      response: { content: "I see a cat." },
    };
    instance = await createServer([imageFixture]);
    const ws = await connectWebSocket(instance.url, "/v1/realtime");

    await ws.waitForMessages(1); // session.created

    ws.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "What is in this image?" },
            { type: "input_image", url: "https://example.com/photo.jpg" },
          ],
        },
      }),
    );
    await ws.waitForMessages(2); // + conversation.item.added

    ws.send(responseCreate());

    // Text response: response.created + output_item.added + content_part.added
    // + output_text.delta + output_text.done + content_part.done + output_item.done + response.done
    const allRaw = await ws.waitForMessages(10);
    const responseEvents = parseEvents(allRaw.slice(2));
    const textDelta = responseEvents.find((e) => e.type === "response.output_text.delta");
    expect(textDelta).toBeDefined();
    expect(textDelta!.delta).toContain("I see a cat.");

    // Verify the ChatMessage structure passed to fixture matching
    expect(capturedMessages).not.toBeNull();
    const userMsg = (capturedMessages as Record<string, unknown>[]).find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    // After mapping, content should be an array with text + image_url parts
    const content = userMsg!.content as Array<Record<string, unknown>>;
    expect(Array.isArray(content)).toBe(true);
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: "text", text: "What is in this image?" });
    expect(content[1]).toEqual({
      type: "image_url",
      image_url: { url: "https://example.com/photo.jpg" },
    });

    ws.close();
  });

  // ── Beta shim tests ──────────────────────────────────────────────────
  it("emits Beta event names when OpenAI-Beta header is present", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/realtime?model=gpt-realtime-2", {
      "OpenAI-Beta": "realtime=v1",
    });

    // First message: session.created
    const raw = await ws.waitForMessages(1);
    const session = parseEvents(raw)[0];
    expect(session.type).toBe("session.created");

    // Beta: flat session config (no nested audio)
    const sess = session.session as Record<string, unknown>;
    expect(sess.voice).toBeDefined();
    expect(sess.audio).toBeUndefined();
    expect(sess.type).toBeUndefined();
    expect(sess.reasoning).toBeUndefined();

    // Send conversation item and response
    ws.send(conversationItemCreate("user", "hello"));

    const ackRaw = await ws.waitForMessages(2);
    const ackEvent = parseEvents(ackRaw.slice(1))[0];
    // Beta: conversation.item.created (not .added)
    expect(ackEvent.type).toBe("conversation.item.created");

    ws.send(responseCreate());

    // Wait for full text response
    const allRaw = await ws.waitForMessages(10);
    const responseEvents = parseEvents(allRaw.slice(2));
    const types = responseEvents.map((e) => e.type);

    // Beta event names
    expect(types).toContain("response.text.delta"); // not output_text
    expect(types).toContain("response.text.done"); // not output_text
    expect(types).not.toContain("response.output_text.delta");
    expect(types).not.toContain("response.output_text.done");

    // Beta content type: "text" not "output_text"
    const contentPartAdded = responseEvents.find((e) => e.type === "response.content_part.added");
    expect((contentPartAdded!.part as Record<string, unknown>).type).toBe("text");

    ws.close();
  });

  // ── Translate/Whisper session types + audio buffer ─────────────────────
  it("accepts transcription session type and acknowledges audio buffer commit", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/realtime");

    // Skip session.created
    await ws.waitForMessages(1);

    // Update session to transcription mode with transcribe model
    ws.send(sessionUpdate({ type: "transcription", model: "gpt-4o-transcribe" }));

    const updateRaw = await ws.waitForMessages(2);
    const updateEvent = parseEvents(updateRaw.slice(1))[0];
    expect(updateEvent.type).toBe("session.updated");
    expect((updateEvent.session as Record<string, unknown>).type).toBe("transcription");
    expect((updateEvent.session as Record<string, unknown>).model).toBe("gpt-4o-transcribe");

    // Send audio buffer messages
    ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: "base64data" }));
    ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));

    // Should get input_audio_buffer.committed + conversation.item.added (placeholder)
    const audioRaw = await ws.waitForMessages(4);
    const audioEvents = parseEvents(audioRaw.slice(2));
    const types = audioEvents.map((e) => e.type);
    expect(types).toContain("input_audio_buffer.committed");
    expect(types).toContain("conversation.item.added");

    // The placeholder item should have input_audio content
    const itemAdded = audioEvents.find((e) => e.type === "conversation.item.added");
    const item = itemAdded!.item as Record<string, unknown>;
    expect(item.role).toBe("user");
    const content = item.content as Array<Record<string, unknown>>;
    expect(content[0].type).toBe("input_audio");
    expect(content[0].transcript).toBeNull();

    ws.close();
  });

  it("input_audio_buffer.append is silently accepted", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/realtime");

    await ws.waitForMessages(1); // session.created

    // Send append — should be silently accepted (no event emitted)
    ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: "base64data" }));

    // Send a known message to verify processing continues
    ws.send(conversationItemCreate("user", "hello"));

    const raw = await ws.waitForMessages(2);
    const event = parseEvents(raw.slice(1))[0];
    // The append was silent, so next event is from the conversation.item.create
    expect(event.type).toBe("conversation.item.added");

    ws.close();
  });

  it("input_audio_buffer.clear emits cleared event", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/realtime");

    await ws.waitForMessages(1); // session.created

    ws.send(JSON.stringify({ type: "input_audio_buffer.clear" }));

    const raw = await ws.waitForMessages(2);
    const event = parseEvents(raw.slice(1))[0];
    expect(event.type).toBe("input_audio_buffer.cleared");

    ws.close();
  });

  it("input_audio_buffer.commit in conversation mode does not add placeholder item", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/realtime");

    await ws.waitForMessages(1); // session.created

    // In default conversation mode, commit should only emit committed, no item
    ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));

    const raw = await ws.waitForMessages(2);
    const event = parseEvents(raw.slice(1))[0];
    expect(event.type).toBe("input_audio_buffer.committed");

    // Send another message to verify no extra events were emitted
    ws.send(conversationItemCreate("user", "hello"));
    const raw2 = await ws.waitForMessages(3);
    const event2 = parseEvents(raw2.slice(2))[0];
    expect(event2.type).toBe("conversation.item.added");

    ws.close();
  });

  it("accepts translation session type", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/realtime");

    await ws.waitForMessages(1); // session.created

    ws.send(sessionUpdate({ type: "translation", model: "gpt-4o-transcribe" }));

    const raw = await ws.waitForMessages(2);
    const event = parseEvents(raw.slice(1))[0];
    expect(event.type).toBe("session.updated");
    expect((event.session as Record<string, unknown>).type).toBe("translation");
    expect((event.session as Record<string, unknown>).model).toBe("gpt-4o-transcribe");

    ws.close();
  });

  it("rejects invalid session type + model combination (transcription with wrong model)", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/realtime");

    await ws.waitForMessages(1); // session.created

    ws.send(sessionUpdate({ type: "transcription", model: "gpt-realtime-2" }));

    const raw = await ws.waitForMessages(2);
    const event = parseEvents(raw.slice(1))[0];
    expect(event.type).toBe("error");
    const error = event.error as Record<string, unknown>;
    expect(error.type).toBe("invalid_request_error");
    expect(error.code).toBe("invalid_session_config");
    expect(error.message).toContain("transcription");

    ws.close();
  });

  it("rejects invalid session type + model combination (translation with wrong model)", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/realtime");

    await ws.waitForMessages(1); // session.created

    ws.send(sessionUpdate({ type: "translation", model: "gpt-realtime-mini" }));

    const raw = await ws.waitForMessages(2);
    const event = parseEvents(raw.slice(1))[0];
    expect(event.type).toBe("error");
    const error = event.error as Record<string, unknown>;
    expect(error.type).toBe("invalid_request_error");
    expect(error.code).toBe("invalid_session_config");
    expect(error.message).toContain("translation");

    ws.close();
  });

  it("audio buffer commit in translation mode adds placeholder conversation item", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/realtime");

    await ws.waitForMessages(1); // session.created

    ws.send(sessionUpdate({ type: "translation", model: "gpt-4o-transcribe" }));
    await ws.waitForMessages(2); // session.updated

    ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));

    // Should get committed + conversation.item.added (placeholder)
    const raw = await ws.waitForMessages(4);
    const events = parseEvents(raw.slice(2));
    const types = events.map((e) => e.type);
    expect(types).toContain("input_audio_buffer.committed");
    expect(types).toContain("conversation.item.added");

    ws.close();
  });

  // ── conversation.item.done tests ────────────────────────────────────
  it("emits conversation.item.done after response completes", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/realtime");

    await ws.waitForMessages(1); // session.created

    ws.send(conversationItemCreate("user", "hello"));
    await ws.waitForMessages(2); // + conversation.item.added

    ws.send(responseCreate());

    // Text response events + conversation.item.done = 9 events after item.added
    // response.created + output_item.added + content_part.added + delta(s) + output_text.done
    // + content_part.done + output_item.done + conversation.item.done + response.done
    const allRaw = await ws.waitForMessages(11);
    const responseEvents = parseEvents(allRaw.slice(2));
    const types = responseEvents.map((e) => e.type);

    // conversation.item.done should appear after response.output_item.done
    const outputItemDoneIdx = types.lastIndexOf("response.output_item.done");
    const itemDoneIdx = types.indexOf("conversation.item.done");
    expect(itemDoneIdx).toBeGreaterThan(-1);
    expect(itemDoneIdx).toBeGreaterThan(outputItemDoneIdx);

    const itemDone = responseEvents[itemDoneIdx];
    const item = itemDone.item as Record<string, unknown>;
    expect(item.id).toBeDefined();
    expect((item.id as string).startsWith("item_")).toBe(true);
    expect(item.type).toBe("message");
    expect(item.role).toBe("assistant");
    expect(item.status).toBe("completed");
    expect(Array.isArray(item.content)).toBe(true);

    ws.close();
  });

  // ── response.cancel tests ───────────────────────────────────────────
  it("handles response.cancel by emitting response.cancelled", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/realtime");

    await ws.waitForMessages(1); // session.created

    // Send response.cancel (no active response needed — aimock just acknowledges)
    ws.send(JSON.stringify({ type: "response.cancel" }));

    const raw = await ws.waitForMessages(2);
    const event = parseEvents(raw.slice(1))[0];
    expect(event.type).toBe("response.cancelled");

    ws.close();
  });

  // ── Beta suppression of conversation.item.done ──────────────────────
  it("suppresses conversation.item.done in Beta mode", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/realtime?model=gpt-realtime-2", {
      "OpenAI-Beta": "realtime=v1",
    });

    await ws.waitForMessages(1); // session.created

    ws.send(conversationItemCreate("user", "hello"));
    await ws.waitForMessages(2); // + conversation.item.created (Beta name)

    ws.send(responseCreate());

    // Wait for response events — Beta does not include conversation.item.done
    const allRaw = await ws.waitForMessages(10);
    const responseEvents = parseEvents(allRaw.slice(2));
    const types = responseEvents.map((e) => e.type);

    expect(types).not.toContain("conversation.item.done");

    ws.close();
  });

  // ── GA model acceptance tests ───────────────────────────────────────────
  it.each([
    "gpt-realtime",
    "gpt-realtime-2",
    "gpt-realtime-2025-08-28",
    "gpt-realtime-1.5",
    "gpt-realtime-mini",
    "gpt-realtime-mini-2025-10-06",
    "gpt-realtime-mini-2025-12-15",
  ])("accepts GA model %s via query parameter", async (model) => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, `/v1/realtime?model=${model}`);

    const raw = await ws.waitForMessages(1);
    const event = parseEvents(raw)[0];
    expect(event.type).toBe("session.created");
    const session = event.session as Record<string, unknown>;
    expect(session.model).toBe(model);

    ws.close();
  });

  it.each(["gpt-4o-realtime-preview", "gpt-4o-mini-realtime-preview"])(
    "accepts legacy model %s via query parameter",
    async (model) => {
      instance = await createServer(allFixtures);
      const ws = await connectWebSocket(instance.url, `/v1/realtime?model=${model}`);

      const raw = await ws.waitForMessages(1);
      const event = parseEvents(raw)[0];
      expect(event.type).toBe("session.created");
      const session = event.session as Record<string, unknown>;
      expect(session.model).toBe(model);

      ws.close();
    },
  );

  // ── endpointType routing tests ──────────────────────────────────────────
  it("sets _endpointType to realtime for default conversation sessions", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/realtime");

    await ws.waitForMessages(1); // session.created

    ws.send(conversationItemCreate("user", "hello"));
    await ws.waitForMessages(2); // + conversation.item.added

    ws.send(responseCreate());

    // Wait for full text response
    await ws.waitForMessages(10);
    await new Promise((r) => setTimeout(r, 50));

    const entry = instance.journal.getLast();
    expect(entry).not.toBeNull();
    expect(entry!.body._endpointType).toBe("realtime");

    ws.close();
  });

  it("sets _endpointType to realtime-transcription for transcription sessions", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/realtime?model=gpt-4o-transcribe");

    await ws.waitForMessages(1); // session.created

    // Update session to transcription type
    ws.send(sessionUpdate({ type: "transcription" }));
    await ws.waitForMessages(2); // + session.updated

    ws.send(conversationItemCreate("user", "hello"));
    await ws.waitForMessages(3); // + conversation.item.added

    ws.send(responseCreate());

    // Response events (no match in non-strict = 2 events: response.created + response.done)
    await ws.waitForMessages(5);
    await new Promise((r) => setTimeout(r, 50));

    const entry = instance.journal.getLast();
    expect(entry).not.toBeNull();
    expect(entry!.body._endpointType).toBe("realtime-transcription");

    ws.close();
  });

  it("sets _endpointType to realtime-translation for translation sessions", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/realtime?model=gpt-4o-transcribe");

    await ws.waitForMessages(1); // session.created

    // Update session to translation type
    ws.send(sessionUpdate({ type: "translation" }));
    await ws.waitForMessages(2); // + session.updated

    ws.send(conversationItemCreate("user", "hello"));
    await ws.waitForMessages(3); // + conversation.item.added

    ws.send(responseCreate());

    // Response events
    await ws.waitForMessages(5);
    await new Promise((r) => setTimeout(r, 50));

    const entry = instance.journal.getLast();
    expect(entry).not.toBeNull();
    expect(entry!.body._endpointType).toBe("realtime-translation");

    ws.close();
  });

  // ── Commentary phase tests ──────────────────────────────────────────────
  it("emits phase: final_answer on output_item.added and output_item.done for text response", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/realtime");

    await ws.waitForMessages(1); // session.created

    ws.send(conversationItemCreate("user", "hello"));
    await ws.waitForMessages(2); // + conversation.item.added

    ws.send(responseCreate());

    // Text response: 9 events after item.added
    const allRaw = await ws.waitForMessages(11);
    const responseEvents = parseEvents(allRaw.slice(2));

    const outputItemAdded = responseEvents.find(
      (e) =>
        e.type === "response.output_item.added" &&
        (e.item as Record<string, unknown>).type === "message",
    );
    expect(outputItemAdded).toBeDefined();
    expect((outputItemAdded!.item as Record<string, unknown>).phase).toBe("final_answer");

    const outputItemDone = responseEvents.find(
      (e) =>
        e.type === "response.output_item.done" &&
        (e.item as Record<string, unknown>).type === "message",
    );
    expect(outputItemDone).toBeDefined();
    expect((outputItemDone!.item as Record<string, unknown>).phase).toBe("final_answer");

    ws.close();
  });

  it("emits phase: final_answer on output_item.added and output_item.done for tool call response", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/realtime");

    await ws.waitForMessages(1); // session.created

    ws.send(conversationItemCreate("user", "weather"));
    await ws.waitForMessages(2); // + conversation.item.added

    ws.send(responseCreate());

    // Tool call response: 7 events after item.added
    const allRaw = await ws.waitForMessages(9);
    const responseEvents = parseEvents(allRaw.slice(2));

    const outputItemAdded = responseEvents.find(
      (e) =>
        e.type === "response.output_item.added" &&
        (e.item as Record<string, unknown>).type === "function_call",
    );
    expect(outputItemAdded).toBeDefined();
    expect((outputItemAdded!.item as Record<string, unknown>).phase).toBe("final_answer");

    const outputItemDone = responseEvents.find(
      (e) =>
        e.type === "response.output_item.done" &&
        (e.item as Record<string, unknown>).type === "function_call",
    );
    expect(outputItemDone).toBeDefined();
    expect((outputItemDone!.item as Record<string, unknown>).phase).toBe("final_answer");

    ws.close();
  });

  it("emits phase: commentary on text output_item and phase: final_answer on tool call when both present", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/realtime");

    await ws.waitForMessages(1); // session.created

    ws.send(conversationItemCreate("user", "commentary-phase"));
    await ws.waitForMessages(2); // + conversation.item.added

    ws.send(responseCreate());

    // ContentWithToolCalls: text part + tool call part + all their events
    // response.created + output_item.added(text) + content_part.added + delta(s) + output_text.done
    // + content_part.done + output_item.done(text) + conversation.item.done(text)
    // + output_item.added(tool) + delta(s) + arguments.done + output_item.done(tool)
    // + conversation.item.done(tool) + response.done
    // Text "Let me check the weather for you." = 34 chars / chunkSize 20 = 2 deltas
    // Tool args '{"city":"NYC"}' = 14 chars / chunkSize 20 = 1 delta
    // Total response events = 1 + 1 + 1 + 2 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 = 15
    // Total messages = 2 (session.created + item.added) + 15 = 17
    const allRaw = await ws.waitForMessages(17);
    const responseEvents = parseEvents(allRaw.slice(2));

    // Find text output_item.added
    const textItemAdded = responseEvents.find(
      (e) =>
        e.type === "response.output_item.added" &&
        (e.item as Record<string, unknown>).type === "message",
    );
    expect(textItemAdded).toBeDefined();
    expect((textItemAdded!.item as Record<string, unknown>).phase).toBe("commentary");

    // Find text output_item.done
    const textItemDone = responseEvents.find(
      (e) =>
        e.type === "response.output_item.done" &&
        (e.item as Record<string, unknown>).type === "message",
    );
    expect(textItemDone).toBeDefined();
    expect((textItemDone!.item as Record<string, unknown>).phase).toBe("commentary");

    // Find tool call output_item.added
    const toolItemAdded = responseEvents.find(
      (e) =>
        e.type === "response.output_item.added" &&
        (e.item as Record<string, unknown>).type === "function_call",
    );
    expect(toolItemAdded).toBeDefined();
    expect((toolItemAdded!.item as Record<string, unknown>).phase).toBe("final_answer");

    // Find tool call output_item.done
    const toolItemDone = responseEvents.find(
      (e) =>
        e.type === "response.output_item.done" &&
        (e.item as Record<string, unknown>).type === "function_call",
    );
    expect(toolItemDone).toBeDefined();
    expect((toolItemDone!.item as Record<string, unknown>).phase).toBe("final_answer");

    ws.close();
  });

  // ── Beta content type translation conformance ──────────────────────────
  it("Beta mode: response.output_item.done translates item.content[].type output_text -> text", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/realtime?model=gpt-realtime-2", {
      "OpenAI-Beta": "realtime=v1",
    });

    await ws.waitForMessages(1); // session.created

    ws.send(conversationItemCreate("user", "hello"));
    await ws.waitForMessages(2); // + conversation.item.created (Beta name)

    ws.send(responseCreate());

    // Beta text response: session.created + item.created + response.created + output_item.added
    // + content_part.added + text.delta + text.done + content_part.done + output_item.done + response.done
    const allRaw = await ws.waitForMessages(10);
    const responseEvents = parseEvents(allRaw.slice(2));

    // Find response.output_item.done
    const outputItemDone = responseEvents.find((e) => e.type === "response.output_item.done");
    expect(outputItemDone).toBeDefined();
    const item = outputItemDone!.item as Record<string, unknown>;
    const content = item.content as Array<Record<string, unknown>>;
    expect(content).toBeDefined();
    expect(content[0].type).toBe("text"); // not "output_text"

    ws.close();
  });

  it("Beta mode: response.done translates response.output[].content[].type output_text -> text", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/realtime?model=gpt-realtime-2", {
      "OpenAI-Beta": "realtime=v1",
    });

    await ws.waitForMessages(1); // session.created

    ws.send(conversationItemCreate("user", "hello"));
    await ws.waitForMessages(2); // + conversation.item.created

    ws.send(responseCreate());

    const allRaw = await ws.waitForMessages(10);
    const responseEvents = parseEvents(allRaw.slice(2));

    // Find response.done
    const responseDone = responseEvents.find((e) => e.type === "response.done");
    expect(responseDone).toBeDefined();
    const resp = responseDone!.response as Record<string, unknown>;
    const output = resp.output as Array<Record<string, unknown>>;
    expect(output).toBeDefined();
    expect(output.length).toBeGreaterThan(0);
    const outputContent = output[0].content as Array<Record<string, unknown>>;
    expect(outputContent).toBeDefined();
    expect(outputContent[0].type).toBe("text"); // not "output_text"

    ws.close();
  });

  it("Beta mode: output_item events do NOT have phase field", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/realtime?model=gpt-realtime-2", {
      "OpenAI-Beta": "realtime=v1",
    });

    await ws.waitForMessages(1); // session.created

    ws.send(conversationItemCreate("user", "hello"));
    await ws.waitForMessages(2); // + conversation.item.created

    ws.send(responseCreate());

    const allRaw = await ws.waitForMessages(10);
    const responseEvents = parseEvents(allRaw.slice(2));

    // Check output_item.added
    const outputItemAdded = responseEvents.find((e) => e.type === "response.output_item.added");
    expect(outputItemAdded).toBeDefined();
    const addedItem = outputItemAdded!.item as Record<string, unknown>;
    expect(addedItem.phase).toBeUndefined();

    // Check output_item.done
    const outputItemDone = responseEvents.find((e) => e.type === "response.output_item.done");
    expect(outputItemDone).toBeDefined();
    const doneItem = outputItemDone!.item as Record<string, unknown>;
    expect(doneItem.phase).toBeUndefined();

    ws.close();
  });

  // ── Session type validation tests ──────────────────────────────────────
  it("rejects invalid session.type value", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/realtime");

    await ws.waitForMessages(1); // session.created

    ws.send(sessionUpdate({ type: "invalid_type" }));

    const raw = await ws.waitForMessages(2);
    const event = parseEvents(raw.slice(1))[0];
    expect(event.type).toBe("error");
    const error = event.error as Record<string, unknown>;
    expect(error.type).toBe("invalid_request_error");
    expect(error.code).toBe("invalid_session_config");
    expect(error.message).toContain("Invalid session type");
    expect(error.message).toContain("invalid_type");

    ws.close();
  });

  it("rejected session.update does not corrupt session state", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/realtime");

    await ws.waitForMessages(1); // session.created

    // First, set a known valid state
    ws.send(sessionUpdate({ instructions: "Be helpful", model: "gpt-realtime-2" }));
    const raw1 = await ws.waitForMessages(2);
    const event1 = parseEvents(raw1.slice(1))[0];
    expect(event1.type).toBe("session.updated");
    expect((event1.session as Record<string, unknown>).model).toBe("gpt-realtime-2");

    // Now send an invalid model+type combination that should be rejected
    ws.send(sessionUpdate({ type: "transcription", model: "gpt-realtime-2" }));
    const raw2 = await ws.waitForMessages(3);
    const event2 = parseEvents(raw2.slice(2))[0];
    expect(event2.type).toBe("error");

    // Verify state was rolled back by sending another valid update and checking the echoed state
    ws.send(sessionUpdate({ instructions: "Updated instructions" }));
    const raw3 = await ws.waitForMessages(4);
    const event3 = parseEvents(raw3.slice(3))[0];
    expect(event3.type).toBe("session.updated");
    const session = event3.session as Record<string, unknown>;
    // Model and type should still be the pre-rejection values
    expect(session.model).toBe("gpt-realtime-2");
    expect(session.type).toBe("conversation");
    expect(session.instructions).toBe("Updated instructions");

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

  it("maps input_text content parts to text format", () => {
    const items = [
      {
        type: "message" as const,
        role: "user" as const,
        content: [{ type: "input_text", text: "hello world" }],
      },
    ];
    const messages = realtimeItemsToMessages(items);
    expect(messages).toEqual([{ role: "user", content: [{ type: "text", text: "hello world" }] }]);
  });

  it("maps input_image content parts to image_url format", () => {
    const items = [
      {
        type: "message" as const,
        role: "user" as const,
        content: [
          { type: "input_text", text: "What is in this image?" },
          { type: "input_image", url: "https://example.com/photo.jpg" },
        ],
      },
    ];
    const messages = realtimeItemsToMessages(items);
    expect(messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          { type: "image_url", image_url: { url: "https://example.com/photo.jpg" } },
        ],
      },
    ]);
  });

  it("maps input_audio content parts to placeholder text", () => {
    const items = [
      {
        type: "message" as const,
        role: "user" as const,
        content: [{ type: "input_audio", transcript: null }],
      },
    ];
    const messages = realtimeItemsToMessages(items);
    expect(messages).toEqual([
      { role: "user", content: [{ type: "text", text: "[audio input]" }] },
    ]);
  });

  it("maps mixed multimodal content (input_text + input_image + input_audio)", () => {
    const items = [
      {
        type: "message" as const,
        role: "user" as const,
        content: [
          { type: "input_text", text: "Describe this" },
          { type: "input_image", url: "https://example.com/img.png" },
          { type: "input_audio", transcript: null },
        ],
      },
    ];
    const messages = realtimeItemsToMessages(items);
    expect(messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this" },
          { type: "image_url", image_url: { url: "https://example.com/img.png" } },
          { type: "text", text: "[audio input]" },
        ],
      },
    ]);
  });

  it("preserves existing text content format (backward compat)", () => {
    const items = [
      {
        type: "message" as const,
        role: "user" as const,
        content: [{ type: "text", text: "hello" }],
      },
    ];
    const messages = realtimeItemsToMessages(items);
    // Existing format should still extract simple text
    expect(messages).toEqual([{ role: "user", content: "hello" }]);
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
