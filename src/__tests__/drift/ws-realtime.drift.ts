/**
 * OpenAI Realtime API WebSocket drift tests.
 *
 * Three-way comparison: SDK types x real API (WS) x aimock output (WS).
 * Updated for GA protocol — uses gpt-realtime-mini and GA event names.
 */

import { connect as connectSocket } from "node:net";
import { OpenAIRealtimeWS } from "openai-current-sdk/realtime/ws";
import type { RealtimeServerEvent } from "openai-current-sdk/resources/realtime/realtime";
import { createServer } from "../../server.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ServerInstance } from "../../server.js";
import { extractShape, compareSSESequences, formatDriftReport } from "./schema.js";
import { openaiRealtimeTextEventShapes, openaiRealtimeToolCallEventShapes } from "./sdk-shapes.js";
import { openaiRealtimeWS } from "./ws-providers.js";
import { listOpenAIModels } from "./providers.js";
import { detectVoiceModelDrift } from "./voice-models.js";
import { startDriftServer, stopDriftServer, collectMockWSMessages } from "./helpers.js";
import { connectWebSocket } from "../ws-test-client.js";

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let instance: ServerInstance;
// The known-models canary — the entire reason this suite exists — fetches the
// model list via GET /v1/models, which returns ALL models for ANY valid OpenAI
// key regardless of realtime access. So it uses OPENAI_API_KEY (the credential
// CI actually provides to the drift job) and is gated ONLY on OPENAI_API_KEY,
// guaranteeing it runs in CI and cannot silently skip.
//
// The real realtime WS *session* tests connect a live socket that requires
// realtime model access. OpenAI Realtime authenticates with the STANDARD
// project key (scope is project-level; there is no separate "realtime key"
// type), so these probes resolve their credential as OPENAI_REALTIME_KEY (an
// optional explicit override, kept for the rare case where realtime access
// lives on a different project) ELSE the standard OPENAI_API_KEY that CI
// already provides. Preferring the explicit override but falling back to the
// standard key lets the protocol probes run LIVE in daily CI without adding a
// new secret. (If CI ever shows these probes failing with an auth/scope error,
// it means this project's OPENAI_API_KEY lacks Realtime access and a separate
// OPENAI_REALTIME_KEY genuinely is required.)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_REALTIME_KEY = process.env.OPENAI_REALTIME_KEY;
// Resolved realtime credential: explicit override preferred, standard key as
// fallback. Non-empty whenever the describe below runs (it gates on
// OPENAI_API_KEY), so the protocol probes RUN in CI instead of skipping.
const OPENAI_REALTIME_CREDENTIAL = OPENAI_REALTIME_KEY ?? OPENAI_API_KEY;

beforeAll(async () => {
  instance = await startDriftServer();
});

afterAll(async () => {
  await stopDriftServer(instance);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!OPENAI_API_KEY)("OpenAI Realtime API drift", () => {
  // Session config for the real WS realtime tests: explicit OPENAI_REALTIME_KEY
  // override if set, else the standard OPENAI_API_KEY (which CI provides and
  // which authenticates Realtime at project scope). The canary below reads
  // OPENAI_API_KEY directly and does NOT use this.
  const config = { apiKey: OPENAI_REALTIME_CREDENTIAL! };

  it("canary: GA realtime models available", async () => {
    // Fetch via GET /v1/models, which lists ALL models for ANY valid key. Use
    // OPENAI_API_KEY (guaranteed present by the describe.skipIf above and the
    // credential CI provides) so the canary ALWAYS runs in CI and never skips —
    // gating this on OPENAI_REALTIME_KEY (which CI does NOT provide) would have
    // silently skipped the one check this whole suite exists to run.
    const models = await listOpenAIModels(OPENAI_API_KEY!);

    // Run the SHARED detection code path (also driven directly by the unit test
    // in ws-realtime-canary.test.ts). The voice/audio family matcher is broader
    // than the old `includes("realtime")` filter so a NEW voice family whose id
    // lacks the "realtime" substring (e.g. gpt-live-1) is still flagged.
    const { candidateModels: realtimeModels, unknown, hasGA } = detectVoiceModelDrift(models);

    // Compute the unknown-model list BEFORE the hasGA assertion. A run can be
    // BOTH GA-family-gone AND carry new unknown models; because the hasGA
    // assertion below throws first, the later unknown-models assertion would
    // never run and its list would be lost from the NO_GA failure message (and
    // therefore from the auto-fix prompt). So we carry the unknown list into the
    // NO_GA marker too — no information is lost in the combined case.
    if (unknown.length > 0) {
      console.warn(`[DRIFT] Unknown voice/audio models detected: ${unknown.join(", ")}`);
    }

    // At least one GA model should exist. Carry the OBSERVED realtime models in
    // a stable custom assertion message (symmetric to UNKNOWN_REALTIME_MODELS=
    // below) so that when the GA family is renamed/removed — or the credential
    // cannot see any realtime models — the drift collector recognizes the
    // NO_GA_REALTIME_MODELS= marker and emits a CRITICAL OpenAI-Realtime entry
    // (exit 2, auto-remediated) instead of crashing to exit 1. Without the
    // marker, "expected false to be true" is an unrecognized shape that the
    // collector would treat as unparseable and throw on.
    //
    // The message ALSO carries the unknown list after a ` | UNKNOWN_REALTIME_MODELS=`
    // segment so the combined (no-GA AND unknown-models-present) case does not
    // lose the unknown list when this assertion short-circuits the one below.
    // The collector splits the two markers apart; each list stays clean.
    expect(
      hasGA,
      `NO_GA_REALTIME_MODELS=${realtimeModels.join(",")} | UNKNOWN_REALTIME_MODELS=${unknown.join(",")}`,
    ).toBe(true);

    // Carry the FULL unknown-model list in a stable custom assertion message.
    // vitest truncates the printed array in failureMessages (`…(N)`), so the
    // drift collector cannot recover ids beyond the first from the array. The
    // custom message is emitted verbatim and is NOT truncated, so the collector
    // parses the UNKNOWN_REALTIME_MODELS= marker as its source of truth.
    expect(unknown, `UNKNOWN_REALTIME_MODELS=${unknown.join(",")}`).toEqual([]);
  });

  it.skipIf(!OPENAI_REALTIME_CREDENTIAL)(
    "WS text event sequence and shapes match (GA)",
    async () => {
      const sdkEvents = openaiRealtimeTextEventShapes();

      // Real API — GA mode (no Beta header)
      const realResult = await openaiRealtimeWS(config, "Say hello", undefined);

      // Mock — replicate the Realtime protocol sequence (GA mode)
      const mockWs = await connectWebSocket(instance.url, "/v1/realtime");

      // session.created is sent automatically on connect
      const sessionCreatedMsgs = await mockWs.waitForMessages(1);
      const allMockRaw: unknown[] = [JSON.parse(sessionCreatedMsgs[0])];

      // session.update
      mockWs.send(
        JSON.stringify({
          type: "session.update",
          session: { model: "gpt-4o-mini", modalities: ["text"] },
        }),
      );
      const sessionUpdatedMsgs = await mockWs.waitForMessages(2);
      allMockRaw.push(JSON.parse(sessionUpdatedMsgs[1]));

      // conversation.item.create
      mockWs.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Say hello" }],
          },
        }),
      );
      const itemCreatedMsgs = await mockWs.waitForMessages(3);
      allMockRaw.push(JSON.parse(itemCreatedMsgs[2]));

      // response.create — triggers the response
      mockWs.send(JSON.stringify({ type: "response.create" }));

      // Collect remaining messages until response.done
      const responseMsgs = await collectMockWSMessages(
        mockWs,
        (msg) => (msg as Record<string, unknown>).type === "response.done",
        15000,
        3, // skip the 3 messages already consumed
      );
      allMockRaw.push(...responseMsgs.rawMessages);
      mockWs.close();

      // Build mock events from all collected messages
      const mockEvents = allMockRaw.map((msg) => {
        const m = msg as Record<string, unknown>;
        return {
          type: m.type as string,
          dataShape: extractShape(msg),
        };
      });

      expect(realResult.rawMessages.length, "Real API returned no WS messages").toBeGreaterThan(0);
      expect(mockEvents.length, "Mock returned no WS messages").toBeGreaterThan(0);

      const diffs = compareSSESequences(sdkEvents, realResult.events, mockEvents);
      const report = formatDriftReport(
        "OpenAI Realtime WS (GA text events)",
        diffs,
        "openai-realtime",
      );

      expect(
        diffs.filter((d) => d.severity === "critical"),
        report,
      ).toEqual([]);
    },
  );

  it.skipIf(!OPENAI_REALTIME_CREDENTIAL)("WS tool call event sequence matches (GA)", async () => {
    const sdkEvents = [
      ...openaiRealtimeTextEventShapes().filter(
        (e) =>
          e.type === "session.created" ||
          e.type === "session.updated" ||
          e.type === "conversation.item.added" ||
          e.type === "response.created" ||
          e.type === "response.done",
      ),
      ...openaiRealtimeToolCallEventShapes(),
    ];

    const tools = [
      {
        type: "function",
        name: "get_weather",
        description: "Get weather",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ];

    // Real API — GA mode
    const realResult = await openaiRealtimeWS(config, "Weather in Paris", tools);

    // Mock — replicate the Realtime protocol sequence
    const mockWs = await connectWebSocket(instance.url, "/v1/realtime");

    // session.created
    const sessionCreatedMsgs = await mockWs.waitForMessages(1);
    const allMockRaw: unknown[] = [JSON.parse(sessionCreatedMsgs[0])];

    // session.update with tools
    mockWs.send(
      JSON.stringify({
        type: "session.update",
        session: { model: "gpt-4o-mini", modalities: ["text"], tools },
      }),
    );
    const sessionUpdatedMsgs = await mockWs.waitForMessages(2);
    allMockRaw.push(JSON.parse(sessionUpdatedMsgs[1]));

    // conversation.item.create
    mockWs.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Weather in Paris" }],
        },
      }),
    );
    const itemCreatedMsgs = await mockWs.waitForMessages(3);
    allMockRaw.push(JSON.parse(itemCreatedMsgs[2]));

    // response.create
    mockWs.send(JSON.stringify({ type: "response.create" }));

    // Collect remaining messages until response.done
    const responseMsgs = await collectMockWSMessages(
      mockWs,
      (msg) => (msg as Record<string, unknown>).type === "response.done",
      15000,
      3,
    );
    allMockRaw.push(...responseMsgs.rawMessages);
    mockWs.close();

    // Build mock events
    const mockEvents = allMockRaw.map((msg) => {
      const m = msg as Record<string, unknown>;
      return {
        type: m.type as string,
        dataShape: extractShape(msg),
      };
    });

    expect(realResult.rawMessages.length, "Real API returned no WS messages").toBeGreaterThan(0);
    expect(mockEvents.length, "Mock returned no WS messages").toBeGreaterThan(0);

    const diffs = compareSSESequences(sdkEvents, realResult.events, mockEvents);
    const report = formatDriftReport(
      "OpenAI Realtime WS (GA tool call events)",
      diffs,
      "openai-realtime",
    );

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  // NOTE: A GA<->Beta event-sequence consistency probe used to live here. It was
  // removed because OpenAI RETIRED the Realtime Beta API — a live Beta handshake
  // now returns {"code":"beta_api_shape_disabled","message":"The Realtime Beta
  // API is no longer supported. Please use /v1/realtime for the GA API."}, which
  // quarantined the whole leg (exit 5). GA is the only live surface and the only
  // surface aimock mocks, so the drift suite probes GA exclusively.
});

// K5 is an approved modeled contract. Native absence is NOT_TRIGGERED, never
// native agreement. Errors, malformed streams and contradictory target output
// fail; only a complete valid response may be classified NOT_TRIGGERED.
function readRealtimeK5(raw: unknown[]) {
  function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Malformed Realtime object");
    }
    return value as Record<string, unknown>;
  }
  function string(value: unknown) {
    if (typeof value !== "string") throw new Error("Malformed Realtime string");
    return value;
  }
  const events = raw.map(object);
  for (const event of events) {
    string(event.type);
    if (event.type === "error") throw new Error(`Realtime error: ${JSON.stringify(event)}`);
  }
  const terminals = events.filter((event) => event.type === "response.done");
  expect(terminals).toHaveLength(1);
  expect(events.at(-1)).toBe(terminals[0]);
  const response = object(terminals[0].response);
  string(response.id);
  const created = events.filter((event) => event.type === "response.created");
  expect(created).toHaveLength(1);
  expect(object(created[0].response).id).toBe(response.id);
  expect(events.indexOf(created[0])).toBeLessThan(events.indexOf(terminals[0]));
  expect(["completed", "incomplete"]).toContain(response.status);
  expect(Array.isArray(response.output)).toBe(true);
  if (!Array.isArray(response.output)) throw new Error("Missing Realtime output");
  const usage = object(response.usage);
  for (const name of ["input_tokens", "output_tokens", "total_tokens"]) {
    expect(typeof usage[name]).toBe("number");
    expect(Number.isFinite(usage[name])).toBe(true);
    expect(usage[name]).toBeGreaterThanOrEqual(0);
  }
  let limited = false;
  if (response.status === "incomplete") {
    const details = object(response.status_details);
    expect(details.type).toBe("incomplete");
    expect(["max_output_tokens", "content_filter"]).toContain(details.reason);
    limited = details.reason === "max_output_tokens";
  }
  const calls: Record<string, unknown>[] = [];
  for (const rawItem of response.output) {
    const item = object(rawItem);
    expect(["function_call", "message"]).toContain(item.type);
    string(item.id);
    expect(["completed", "incomplete"]).toContain(item.status);
    const added = events.filter(
      (event) => event.type === "response.output_item.added" && object(event.item).id === item.id,
    );
    const closed = events.filter(
      (event) => event.type === "response.output_item.done" && object(event.item).id === item.id,
    );
    expect(added).toHaveLength(1);
    expect(closed).toHaveLength(1);
    // Item events may add SDK metadata (for example phase) omitted from final output.
    // Every terminal output field must still agree with the closed item.
    expect(closed[0].item).toMatchObject(item);
    expect(events.indexOf(added[0])).toBeGreaterThan(events.indexOf(created[0]));
    expect(events.indexOf(closed[0])).toBeGreaterThan(events.indexOf(added[0]));
    expect(events.indexOf(closed[0])).toBeLessThan(events.indexOf(terminals[0]));
    if (item.type === "function_call") {
      string(item.name);
      string(item.call_id);
      string(item.arguments);
      calls.push(item);
    } else {
      expect(Array.isArray(item.content)).toBe(true);
      if (!Array.isArray(item.content)) throw new Error("Missing message content");
      for (const part of item.content) {
        const content = object(part);
        expect(content.type).toBe("output_text");
        string(content.text);
      }
    }
  }
  const output = response.output.map(object);
  expect(new Set(output.map((item) => item.id)).size).toBe(output.length);
  for (const event of events) {
    const itemEvent =
      event.type === "response.output_item.added" || event.type === "response.output_item.done";
    const argumentEvent =
      event.type === "response.function_call_arguments.delta" ||
      event.type === "response.function_call_arguments.done";
    if (!itemEvent && !argumentEvent) continue;
    const eventItem = itemEvent ? object(event.item) : undefined;
    const id = eventItem ? eventItem.id : event.item_id;
    const index = output.findIndex((item) => item.id === id);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(event.response_id).toBe(response.id);
    expect(event.output_index).toBe(index);
    const item = output[index];
    if (eventItem) {
      expect(eventItem.type).toBe(item.type);
      if (item.type === "function_call") {
        expect(eventItem.name).toBe(item.name);
        expect(eventItem.call_id).toBe(item.call_id);
      }
    } else {
      expect(item.type).toBe("function_call");
      expect(event.call_id).toBe(item.call_id);
    }
  }
  const cut = calls.filter((call) => {
    try {
      JSON.parse(string(call.arguments));
      return false;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return true;
    }
  });
  // An invalid call without token exhaustion is a contradiction, not absence.
  if (cut.length > 0) expect(limited).toBe(true);
  for (const call of calls) {
    const deltas = events.filter(
      (event) =>
        event.type === "response.function_call_arguments.delta" && event.item_id === call.id,
    );
    const args = deltas.map((event) => string(event.delta)).join("");
    expect(args).toBe(call.arguments);
    const done = events.filter(
      (event) =>
        event.type === "response.function_call_arguments.done" && event.item_id === call.id,
    );
    expect(done).toHaveLength(1);
    expect(done[0].arguments).toBe(args);
    const added = events.find(
      (event) => event.type === "response.output_item.added" && object(event.item).id === call.id,
    )!;
    for (const delta of deltas) {
      expect(events.indexOf(delta)).toBeGreaterThan(events.indexOf(added));
      expect(events.indexOf(delta)).toBeLessThan(events.indexOf(done[0]));
    }

    expect(events.indexOf(done[0])).toBeGreaterThan(
      events.indexOf(
        deltas.at(-1) ??
          events.find(
            (event) =>
              event.type === "response.output_item.added" && object(event.item).id === call.id,
          )!,
      ),
    );
    const closed = events.find(
      (event) => event.type === "response.output_item.done" && object(event.item).id === call.id,
    );
    expect(closed).toBeDefined();
    expect(events.indexOf(done[0])).toBeLessThan(events.indexOf(closed!));
  }
  return limited && cut.length > 0 ? ("MATCH" as const) : ("NOT_TRIGGERED" as const);
}

const k5Tool = {
  type: "function" as const,
  name: "write_report",
  description: "Write a detailed weather report.",
  parameters: {
    type: "object",
    properties: { report: { type: "string", minLength: 2500 } },
    required: ["report"],
    additionalProperties: false,
  },
};
const k5Arguments = JSON.stringify({
  report: "Paris weather report with a long explanation.",
});

async function localRealtimeK5(at: number) {
  const server = await createServer(
    [
      {
        match: {},
        response: {
          toolCalls: [{ name: k5Tool.name, arguments: k5Arguments }],
        },
        misbehavior: { faults: [{ fault: "stop-length-mid-tool", at }] },
      },
    ],
    { logLevel: "silent" },
  );
  const address = new URL(server.url);
  const sdk = new OpenAIRealtimeWS(
    {
      model: "gpt-realtime-mini",
      options: {
        createConnection: () => connectSocket(Number(address.port), address.hostname),
      },
    },
    { apiKey: "local-drift", baseURL: `${server.url}/v1` },
  );
  sdk.on("error", () => {
    /* Errors remain in the asserted event transcript. */
  });
  try {
    await new Promise<void>((resolve, reject) => {
      sdk.socket.once("open", resolve);
      sdk.socket.once("error", reject);
    });
    const result = new Promise<RealtimeServerEvent[]>((resolve, reject) => {
      const events: RealtimeServerEvent[] = [];
      const timer = setTimeout(() => {
        sdk.off("event", listener);
        reject(new Error("Missing K5 terminal"));
      }, 5000);
      const listener = (event: RealtimeServerEvent) => {
        events.push(event);
        if (event.type === "response.done" || event.type === "error") {
          clearTimeout(timer);
          sdk.off("event", listener);
          resolve(events);
        }
      };
      sdk.on("event", listener);
    });
    sdk.send({
      type: "session.update",
      session: {
        type: "realtime",
        output_modalities: ["text"],
        tools: [k5Tool],
      },
    });
    sdk.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Write the Paris weather report." }],
      },
    });
    sdk.send({
      type: "response.create",
      response: {
        max_output_tokens: 32,
        tool_choice: { type: "function", name: k5Tool.name },
      },
    });
    return await result;
  } finally {
    sdk.close();
    await stopDriftServer(server);
  }
}

describe("Realtime K5 modeled contract", () => {
  it.each([0.001, 0.25, 0.5, 0.75])("official GA SDK retains cut arguments at %s", async (at) => {
    const events = await localRealtimeK5(at);
    console.log("Realtime K5 local", JSON.stringify(events));
    expect(readRealtimeK5(events)).toBe("MATCH");
    const terminal = events.find((event) => event.type === "response.done");
    const call = terminal?.response.output?.find((item) => item.type === "function_call");
    expect(call?.arguments).toBe(
      k5Arguments.slice(0, Math.max(1, Math.floor(k5Arguments.length * at))),
    );
  });

  it("rejects derived missing closing event and malformed terminal", async () => {
    const events = await localRealtimeK5(0.5);
    expect(() =>
      readRealtimeK5(
        events.filter((event) => event.type !== "response.function_call_arguments.done"),
      ),
    ).toThrow();
    expect(() => readRealtimeK5(events.slice(0, -1))).toThrow();
    expect(() =>
      readRealtimeK5(
        events.map((event) =>
          event.type === "response.done"
            ? {
                ...event,
                response: { ...event.response, status: ["incomplete"] },
              }
            : event,
        ),
      ),
    ).toThrow();
  });

  it("validates empty argument prefixes and rejects contradictory item fields", async () => {
    const events = await localRealtimeK5(0.5);
    const empty = events
      .filter((event) => event.type !== "response.function_call_arguments.delta")
      .map((event) => {
        if (event.type === "response.function_call_arguments.done")
          return { ...event, arguments: "" };
        if (event.type === "response.output_item.done")
          return { ...event, item: { ...event.item, arguments: "" } };
        if (event.type === "response.done")
          return {
            ...event,
            response: {
              ...event.response,
              output: event.response.output?.map((item) => ({ ...item, arguments: "" })),
            },
          };
        return event;
      });
    const mismatchedValidCall = events.map((event) => {
      if (event.type === "response.output_item.done")
        return { ...event, item: { ...event.item, arguments: "{}" } };
      if (event.type === "response.done")
        return {
          ...event,
          response: {
            ...event.response,
            output: event.response.output?.map((item) => ({ ...item, arguments: "{}" })),
          },
        };
      return event;
    });
    expect(() => readRealtimeK5(mismatchedValidCall)).toThrow();
    // Derived reader case: the renderer intentionally clamps local cuts to one byte.
    expect(readRealtimeK5(empty)).toBe("MATCH");
    expect(() =>
      readRealtimeK5(
        events.map((event) =>
          event.type === "response.output_item.done"
            ? { ...event, item: { ...event.item, arguments: "contradiction" } }
            : event,
        ),
      ),
    ).toThrow();
  });

  it.each(["orphan", "early delta", "response id", "item id", "call id", "output index"])(
    "rejects derived lifecycle contradiction: %s",
    async (mutation) => {
      const events = await localRealtimeK5(0.5);
      expect(readRealtimeK5(events)).toBe("MATCH");
      let malformed: unknown[];
      if (mutation === "early delta") {
        const firstDelta = events.find(
          (event) => event.type === "response.function_call_arguments.delta",
        )!;
        malformed = events.filter((event) => event !== firstDelta);
        const added = events.findIndex((event) => event.type === "response.output_item.added");
        malformed.splice(added, 0, firstDelta);
      } else {
        malformed = events.map((event) => {
          if (mutation === "orphan" && event.type === "response.done")
            return { ...event, response: { ...event.response, output: [] } };
          if (event.type !== "response.function_call_arguments.delta") return event;
          if (mutation === "response id") return { ...event, response_id: "wrong" };
          if (mutation === "item id") return { ...event, item_id: "wrong" };
          if (mutation === "call id") return { ...event, call_id: "wrong" };
          if (mutation === "output index") return { ...event, output_index: 42 };
          return event;
        });
      }
      // These are derived malformed reader inputs from actual SDK output, not native captures.
      expect(() => readRealtimeK5(malformed)).toThrow();
    },
  );

  it.skipIf(!OPENAI_REALTIME_CREDENTIAL)("native K5 bounded modeled comparison", async () => {
    const result = await openaiRealtimeWS(
      { apiKey: OPENAI_REALTIME_CREDENTIAL! },
      "Call write_report with at least 500 words describing Paris weather. Do not abbreviate.",
      [k5Tool],
      {
        max_output_tokens: 32,
        tool_choice: { type: "function", name: k5Tool.name },
      },
    );
    const disposition = readRealtimeK5(result.rawMessages);
    console.log(
      "Realtime K5 native",
      JSON.stringify({
        model: "gpt-realtime-mini",
        max_output_tokens: 32,
        disposition,
        events: result.rawMessages,
      }),
    );
  });
});
