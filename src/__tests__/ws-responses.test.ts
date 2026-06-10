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

const reasoningFixture: Fixture = {
  match: { userMessage: "think" },
  response: { content: "The answer.", reasoning: "Let me reason about this." },
};

// Reasoning fixture used by the capability-gating tests. Distinct match key so it
// can be exercised against different requested models without colliding with the
// `gpt-4`-defaulting "think" fixture above.
const capabilityReasoningFixture: Fixture = {
  match: { userMessage: "reason-please" },
  response: { content: "The answer.", reasoning: "Let me reason about this." },
};

// Tool-only fixture that also carries reasoning. Distinct match key so it can
// be exercised against reasoning-capable / non-reasoning models without
// colliding with the plain `weather` tool fixture above.
const toolReasoningFixture: Fixture = {
  match: { userMessage: "tool-reason" },
  response: {
    toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
    reasoning: "Let me reason about the tool call.",
  },
};

const allFixtures: Fixture[] = [
  textFixture,
  toolFixture,
  errorFixture,
  reasoningFixture,
  capabilityReasoningFixture,
  toolReasoningFixture,
];

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

function responseCreateMsg(userContent: string, model = "gpt-4"): string {
  return JSON.stringify({
    type: "response.create",
    model,
    input: [{ role: "user", content: userContent }],
  });
}

interface WSEvent {
  type: string;
  [key: string]: unknown;
}

function parseEvents(raw: string[]): WSEvent[] {
  return raw.map((m) => JSON.parse(m) as WSEvent);
}

// ─── Integration tests: WebSocket /v1/responses ──────────────────────────────

describe("WebSocket /v1/responses", () => {
  it("streams text response with correct event types", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/responses");

    ws.send(responseCreateMsg("hello"));

    // response.created + in_progress + output_item.added + content_part.added
    // + delta(s) + output_text.done + content_part.done + output_item.done + response.completed
    // At minimum 9 events (1 delta for small text with default chunk size)
    const raw = await ws.waitForMessages(9);
    const events = parseEvents(raw);

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("response.created");
    expect(types[1]).toBe("response.in_progress");
    expect(types).toContain("response.output_item.added");
    expect(types).toContain("response.content_part.added");
    expect(types).toContain("response.output_text.delta");
    expect(types).toContain("response.output_text.done");
    expect(types).toContain("response.content_part.done");
    expect(types).toContain("response.output_item.done");
    expect(types[types.length - 1]).toBe("response.completed");

    // Verify text deltas reconstruct to "Hi there!"
    const deltas = events.filter((e) => e.type === "response.output_text.delta");
    const fullText = deltas.map((d) => d.delta).join("");
    expect(fullText).toBe("Hi there!");

    ws.close();
  });

  it("streams tool call response with correct event types", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/responses");

    ws.send(responseCreateMsg("weather"));

    // response.created + in_progress + output_item.added + delta(s)
    // + function_call_arguments.done + output_item.done + response.completed
    // At minimum 7 events
    const raw = await ws.waitForMessages(7);
    const events = parseEvents(raw);

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("response.created");
    expect(types).toContain("response.output_item.added");
    expect(types).toContain("response.function_call_arguments.delta");
    expect(types).toContain("response.function_call_arguments.done");
    expect(types).toContain("response.output_item.done");
    expect(types[types.length - 1]).toBe("response.completed");

    // Verify argument deltas reconstruct to '{"city":"NYC"}'
    const argDeltas = events.filter((e) => e.type === "response.function_call_arguments.delta");
    const fullArgs = argDeltas.map((d) => d.delta).join("");
    expect(fullArgs).toBe('{"city":"NYC"}');

    ws.close();
  });

  it("returns error event when no fixture matches", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/responses");

    ws.send(responseCreateMsg("unknown-message-that-matches-nothing"));

    const raw = await ws.waitForMessages(1);
    const event = JSON.parse(raw[0]) as WSEvent;
    expect(event.type).toBe("error");
    expect((event.error as { message: string }).message).toBe("No fixture matched");

    ws.close();
  });

  it("returns error event for error fixture", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/responses");

    ws.send(responseCreateMsg("fail"));

    const raw = await ws.waitForMessages(1);
    const event = JSON.parse(raw[0]) as WSEvent;
    expect(event.type).toBe("error");
    expect((event.error as { message: string }).message).toBe("Rate limited");

    ws.close();
  });

  it("returns error event for malformed JSON", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/responses");

    ws.send("{not valid json");

    const raw = await ws.waitForMessages(1);
    const event = JSON.parse(raw[0]) as WSEvent;
    expect(event.type).toBe("error");
    expect((event.error as { message: string }).message).toMatch(/^Malformed JSON:/);

    ws.close();
  });

  it("returns error event for wrong message type", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/responses");

    ws.send(JSON.stringify({ type: "unknown" }));

    const raw = await ws.waitForMessages(1);
    const event = JSON.parse(raw[0]) as WSEvent;
    expect(event.type).toBe("error");
    expect((event.error as { message: string }).message).toContain(
      'Expected message type "response.create"',
    );

    ws.close();
  });

  it("records journal entries with method WS", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/responses");

    ws.send(responseCreateMsg("hello"));

    // Wait for all events to be delivered
    await ws.waitForMessages(9);
    // Small pause to ensure the journal write has completed
    await new Promise((r) => setTimeout(r, 50));

    expect(instance.journal.size).toBe(1);
    const entry = instance.journal.getLast();
    expect(entry!.method).toBe("WS");
    expect(entry!.path).toBe("/v1/responses");
    expect(entry!.response.status).toBe(200);
    expect(entry!.response.fixture).toBe(textFixture);

    ws.close();
  });

  it("handles multiple requests on same connection", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/responses");

    // Send first request
    ws.send(responseCreateMsg("hello"));

    // Wait for the full text response sequence (at least 9 events)
    const firstBatch = await ws.waitForMessages(9);
    const firstEvents = parseEvents(firstBatch);
    expect(firstEvents[firstEvents.length - 1].type).toBe("response.completed");

    // Send second request on same connection
    ws.send(responseCreateMsg("weather"));

    // Wait for both batches of events total
    // The first 9 are text response, then 7+ for tool call
    const allRaw = await ws.waitForMessages(9 + 7);
    const secondBatch = allRaw.slice(9);
    const secondEvents = parseEvents(secondBatch);

    const secondTypes = secondEvents.map((e) => e.type);
    expect(secondTypes[0]).toBe("response.created");
    expect(secondTypes).toContain("response.function_call_arguments.delta");
    expect(secondTypes[secondTypes.length - 1]).toBe("response.completed");

    ws.close();
  });

  it("concurrent requests don't interleave events", async () => {
    const fixture1: Fixture = {
      match: { userMessage: "concurrent-a" },
      response: { content: "Response A content here" },
      chunkSize: 5,
    };
    const fixture2: Fixture = {
      match: { userMessage: "concurrent-b" },
      response: { content: "Response B content here" },
      chunkSize: 5,
    };
    instance = await createServer([fixture1, fixture2]);
    const ws = await connectWebSocket(instance.url, "/v1/responses");

    // Send two requests rapidly without waiting for the first to complete
    ws.send(responseCreateMsg("concurrent-a"));
    ws.send(responseCreateMsg("concurrent-b"));

    // "Response A content here" = 23 chars / chunkSize 5 = 5 deltas
    // Per response: created + in_progress + output_item.added + content_part.added
    //   + 5 deltas + output_text.done + content_part.done + output_item.done + completed = 13
    // Two responses = 26
    const allRaw = await ws.waitForMessages(26);
    const events = parseEvents(allRaw);

    // Find the boundary: both response sequences end with response.completed
    const completedIndices = events
      .map((e, i) => (e.type === "response.completed" ? i : -1))
      .filter((i) => i >= 0);
    expect(completedIndices.length).toBe(2);

    // All events for the first response must come before all events for the second.
    // Verify no interleaving: events 0..completedIndices[0] belong to one response,
    // and events completedIndices[0]+1..completedIndices[1] belong to the other.
    const firstBatch = events.slice(0, completedIndices[0] + 1);
    const secondBatch = events.slice(completedIndices[0] + 1, completedIndices[1] + 1);

    // Each batch should start with response.created and end with response.completed
    expect(firstBatch[0].type).toBe("response.created");
    expect(firstBatch[firstBatch.length - 1].type).toBe("response.completed");
    expect(secondBatch[0].type).toBe("response.created");
    expect(secondBatch[secondBatch.length - 1].type).toBe("response.completed");

    // The deltas in each batch should reconstruct to the correct content (no mixing)
    const firstDeltas = firstBatch
      .filter((e) => e.type === "response.output_text.delta")
      .map((e) => e.delta)
      .join("");
    const secondDeltas = secondBatch
      .filter((e) => e.type === "response.output_text.delta")
      .map((e) => e.delta)
      .join("");

    // One should be "Response A content here" and the other "Response B content here"
    const contents = [firstDeltas, secondDeltas].sort();
    expect(contents).toEqual(["Response A content here", "Response B content here"]);

    ws.close();
  });

  it("multiple tool calls with distinct output_index", async () => {
    const multiToolFixture: Fixture = {
      match: { userMessage: "multi-tool" },
      response: {
        toolCalls: [
          { name: "get_weather", arguments: '{"city":"NYC"}' },
          { name: "get_time", arguments: '{"tz":"EST"}' },
        ],
      },
    };
    instance = await createServer([multiToolFixture]);
    const ws = await connectWebSocket(instance.url, "/v1/responses");

    ws.send(responseCreateMsg("multi-tool"));

    // 2 tool calls: response.created + in_progress
    // + (output_item.added + 1 delta + arguments.done + output_item.done) * 2
    // + response.completed = 2 + 8 + 1 = 11 events
    const raw = await ws.waitForMessages(11);
    const events = parseEvents(raw);

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("response.created");
    expect(types[types.length - 1]).toBe("response.completed");

    // Verify both tool calls appear
    const addedItems = events.filter((e) => e.type === "response.output_item.added");
    expect(addedItems.length).toBe(2);
    expect((addedItems[0].item as Record<string, unknown>).name).toBe("get_weather");
    expect((addedItems[1].item as Record<string, unknown>).name).toBe("get_time");

    // Verify output_index values are distinct
    const outputIndices = addedItems.map((e) => e.output_index);
    expect(outputIndices[0]).toBe(0);
    expect(outputIndices[1]).toBe(1);

    // Verify argument deltas for each tool call reconstruct correctly
    const argDoneEvents = events.filter((e) => e.type === "response.function_call_arguments.done");
    expect(argDoneEvents.length).toBe(2);
    expect(argDoneEvents[0].arguments).toBe('{"city":"NYC"}');
    expect(argDoneEvents[1].arguments).toBe('{"tz":"EST"}');

    // Verify output_index on arguments.done events are distinct
    expect(argDoneEvents[0].output_index).toBe(0);
    expect(argDoneEvents[1].output_index).toBe(1);

    ws.close();
  });

  it("rejects WebSocket upgrade on non-responses path", async () => {
    instance = await createServer(allFixtures);

    await expect(connectWebSocket(instance.url, "/v1/chat/completions")).rejects.toThrow(
      "Upgrade failed",
    );
  });

  it("truncateAfterChunks stops stream early, no response.completed event", async () => {
    const truncFixture: Fixture = {
      match: { userMessage: "truncate-ws" },
      response: { content: "ABCDEFGHIJKLMNO" }, // 15 chars, chunkSize 3 => 5 content chunks
      chunkSize: 3,
      latency: 5,
      truncateAfterChunks: 2,
    };
    instance = await createServer([truncFixture]);
    const ws = await connectWebSocket(instance.url, "/v1/responses");

    ws.send(responseCreateMsg("truncate-ws"));

    // Wait for the connection to be destroyed
    await ws.waitForClose();

    // Small pause to ensure server-side processing completed
    await new Promise((r) => setTimeout(r, 50));

    // Collect whatever messages were received
    // We should have some events but NOT the response.completed event
    const raw = await ws.waitForMessages(1).catch(() => [] as string[]);
    // If we got messages, verify no response.completed
    if (raw.length > 0) {
      const events = parseEvents(raw);
      const types = events.map((e) => e.type);
      expect(types).not.toContain("response.completed");
    }
  });

  it("truncateAfterChunks records interrupted: true in journal", async () => {
    const truncFixture: Fixture = {
      match: { userMessage: "truncate-journal-ws" },
      response: { content: "ABCDEFGHIJKLMNO" },
      chunkSize: 3,
      latency: 5,
      truncateAfterChunks: 2,
    };
    instance = await createServer([truncFixture]);
    const ws = await connectWebSocket(instance.url, "/v1/responses");

    ws.send(responseCreateMsg("truncate-journal-ws"));

    // Wait for the connection to be destroyed
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
      match: { userMessage: "truncate-tool-ws" },
      response: {
        toolCalls: [{ name: "search", arguments: '{"query":"hello world test string"}' }],
      },
      chunkSize: 3,
      latency: 5,
      truncateAfterChunks: 2,
    };
    instance = await createServer([truncFixture]);
    const ws = await connectWebSocket(instance.url, "/v1/responses");

    ws.send(responseCreateMsg("truncate-tool-ws"));

    // Wait for the connection to be destroyed
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
      match: { userMessage: "disconnect-ws" },
      response: { content: "ABCDEFGHIJKLMNOPQRSTUVWXYZ" },
      chunkSize: 1,
      latency: 20,
      disconnectAfterMs: 30,
    };
    instance = await createServer([fixture]);
    const ws = await connectWebSocket(instance.url, "/v1/responses");

    ws.send(responseCreateMsg("disconnect-ws"));

    await ws.waitForClose();
    await new Promise((r) => setTimeout(r, 50));

    const entry = instance.journal.getLast();
    expect(entry).not.toBeNull();
    expect(entry!.response.interrupted).toBe(true);
    expect(entry!.response.interruptReason).toBe("disconnectAfterMs");
  });

  // ── Strict no-match surfaces as an RFC 6455 close(1008, …) frame. The three
  //    WS handlers (ws-responses, ws-gemini-live, ws-realtime) share this path;
  //    ws-responses is the cleanest to assert against. ──
  it("closes with 1008 and a skipped-by-state reason when a sequence-exhausted fixture is replayed (strict)", async () => {
    const seqFixture: Fixture = {
      match: { userMessage: "hello", sequenceIndex: 0 },
      response: { content: "Hi there!" },
    };
    instance = await createServer([seqFixture], { strict: true });

    // First connection consumes the sequenceIndex:0 fixture (count → 1).
    // Collect events until response.completed arrives — the number of
    // output_text.delta events depends on chunking, so no fixed message count.
    const ws1 = await connectWebSocket(instance.url, "/v1/responses");
    ws1.send(responseCreateMsg("hello"));
    // Bounded so a missing terminal event fails with a clear message instead
    // of burning the waitForMessages timeout on an ever-growing count.
    const maxEvents = 50;
    let firstEvents: WSEvent[] = [];
    for (let count = 1; ; count++) {
      if (count > maxEvents) {
        throw new Error(
          `response.completed never arrived within ${maxEvents} events ` +
            `(last event type: ${firstEvents[firstEvents.length - 1]?.type})`,
        );
      }
      firstEvents = parseEvents(await ws1.waitForMessages(count));
      if (firstEvents[firstEvents.length - 1].type === "response.completed") break;
    }
    expect(firstEvents.map((e) => e.type)).toContain("response.output_text.delta");
    ws1.close();

    // Replay: shape still matches but the fixture is skipped by sequence state,
    // so strict mode closes the socket with 1008 + the skipped-by-state reason.
    const ws2 = await connectWebSocket(instance.url, "/v1/responses");
    ws2.send(responseCreateMsg("hello"));
    const close = await ws2.waitForCloseFrame();
    expect(close.code).toBe(1008);
    expect(close.reason).toMatch(/candidate fixture\(s\) skipped by sequence\/turn state/);
  });

  it("streams reasoning events before text via WebSocket", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/responses");

    ws.send(responseCreateMsg("think"));

    const raw = await ws.waitForMessages(15);
    const events = parseEvents(raw);
    const types = events.map((e) => e.type);

    expect(types).toContain("response.reasoning_summary_text.delta");
    expect(types).toContain("response.output_text.delta");

    const reasoningIdx = types.indexOf("response.reasoning_summary_text.delta");
    const textIdx = types.indexOf("response.output_text.delta");
    expect(reasoningIdx).toBeLessThan(textIdx);
  });
});

// ─── Capability-aware reasoning gating: WebSocket /v1/responses ───────────────

describe("WebSocket /v1/responses reasoning capability gating", () => {
  it("emits reasoning for a reasoning-capable model", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/responses");

    ws.send(responseCreateMsg("reason-please", "o3-mini"));

    const raw = await ws.waitForMessages(15);
    const events = parseEvents(raw);
    const types = events.map((e) => e.type);

    expect(types).toContain("response.reasoning_summary_text.delta");
    expect(types).toContain("response.output_text.delta");

    ws.close();
  });

  it("emits reasoning (warn-by-default) for a non-reasoning model when strict is off", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/responses");

    // gpt-4.1 is a known non-reasoning model; strict is off by default, so the
    // reasoning channel is still emitted (a warning is logged at non-silent levels).
    ws.send(responseCreateMsg("reason-please", "gpt-4.1"));

    const raw = await ws.waitForMessages(15);
    const events = parseEvents(raw);
    const types = events.map((e) => e.type);

    expect(types).toContain("response.reasoning_summary_text.delta");
    expect(types).toContain("response.output_text.delta");

    ws.close();
  });

  it("suppresses reasoning for a non-reasoning model when strict is on (upgrade header)", async () => {
    instance = await createServer(allFixtures);
    // Strict resolves from the connection upgrade headers on the WS path; pass
    // X-AIMock-Strict via the upgrade handshake.
    const ws = await connectWebSocket(instance.url, "/v1/responses", {
      "X-AIMock-Strict": "true",
    });

    ws.send(responseCreateMsg("reason-please", "gpt-4.1"));

    // Without reasoning the text response is a shorter sequence; wait for the
    // terminal response.completed rather than a reasoning-inflated count.
    const raw = await ws.waitForMessages(9);
    const events = parseEvents(raw);
    const types = events.map((e) => e.type);

    expect(types).not.toContain("response.reasoning_summary_text.delta");
    expect(types).not.toContain("response.reasoning_summary_text.done");
    // Text emission is unaffected.
    expect(types).toContain("response.output_text.delta");
    expect(types[types.length - 1]).toBe("response.completed");

    ws.close();
  });

  it("still emits reasoning for a reasoning-capable model under strict mode", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/responses", {
      "X-AIMock-Strict": "true",
    });

    ws.send(responseCreateMsg("reason-please", "o3-mini"));

    const raw = await ws.waitForMessages(15);
    const events = parseEvents(raw);
    const types = events.map((e) => e.type);

    expect(types).toContain("response.reasoning_summary_text.delta");
    expect(types).toContain("response.output_text.delta");

    ws.close();
  });

  it("no-op when the fixture carries no reasoning (non-reasoning model, strict on)", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/responses", {
      "X-AIMock-Strict": "true",
    });

    // textFixture has no reasoning; gating short-circuits before any model check.
    ws.send(responseCreateMsg("hello", "gpt-4.1"));

    const raw = await ws.waitForMessages(9);
    const events = parseEvents(raw);
    const types = events.map((e) => e.type);

    expect(types).not.toContain("response.reasoning_summary_text.delta");
    expect(types).toContain("response.output_text.delta");
    const deltas = events.filter((e) => e.type === "response.output_text.delta");
    expect(deltas.map((d) => d.delta).join("")).toBe("Hi there!");

    ws.close();
  });

  // ── Tool-only path: reasoning must gate the same as text / content+tool, so
  //    emission is transport-independent (HTTP tool-only already gates+emits). ──

  it("emits reasoning on a tool-only response for a reasoning-capable model", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/responses");

    ws.send(responseCreateMsg("tool-reason", "o3-mini"));

    const raw = await ws.waitForMessages(12);
    const events = parseEvents(raw);
    const types = events.map((e) => e.type);

    // Reasoning channel is emitted, and the function call is intact.
    expect(types).toContain("response.reasoning_summary_text.delta");
    expect(types).toContain("response.function_call_arguments.delta");
    expect(types).toContain("response.function_call_arguments.done");

    const argDeltas = events.filter((e) => e.type === "response.function_call_arguments.delta");
    expect(argDeltas.map((d) => d.delta).join("")).toBe('{"city":"NYC"}');

    ws.close();
  });

  it("suppresses tool-only reasoning for a non-reasoning model under strict (function call intact)", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/responses", {
      "X-AIMock-Strict": "true",
    });

    ws.send(responseCreateMsg("tool-reason", "gpt-4.1"));

    const raw = await ws.waitForMessages(7);
    const events = parseEvents(raw);
    const types = events.map((e) => e.type);

    // Reasoning suppressed, but the function call still streams.
    expect(types).not.toContain("response.reasoning_summary_text.delta");
    expect(types).not.toContain("response.reasoning_summary_text.done");
    expect(types).toContain("response.function_call_arguments.delta");
    expect(types).toContain("response.function_call_arguments.done");
    expect(types[types.length - 1]).toBe("response.completed");

    const argDeltas = events.filter((e) => e.type === "response.function_call_arguments.delta");
    expect(argDeltas.map((d) => d.delta).join("")).toBe('{"city":"NYC"}');

    ws.close();
  });

  it("emits tool-only reasoning for a non-reasoning model when strict is off", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/responses");

    ws.send(responseCreateMsg("tool-reason", "gpt-4.1"));

    const raw = await ws.waitForMessages(12);
    const events = parseEvents(raw);
    const types = events.map((e) => e.type);

    expect(types).toContain("response.reasoning_summary_text.delta");
    expect(types).toContain("response.function_call_arguments.delta");
    expect(types).toContain("response.function_call_arguments.done");

    ws.close();
  });
});
