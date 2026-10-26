/**
 * OpenAI Responses API WebSocket drift tests.
 *
 * Three-way comparison: SDK types × real API (WS) × aimock output (WS).
 * The Responses WS protocol uses the same event shapes as HTTP SSE.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFile } from "node:fs/promises";
import type { ResponseStreamEvent } from "openai/resources/responses/responses";
import { LLMock } from "../../llmock.js";
import type { ServerInstance } from "../../server.js";
import { compareSSESequences, formatDriftReport, extractShape } from "./schema.js";
import {
  openaiResponsesTextEventShapes,
  openaiResponsesToolCallEventShapes,
  openaiResponsesReasoningEventShapes,
} from "./sdk-shapes.js";
import {
  openaiResponsesWS,
  WSHandshakeError,
  extractWSErrorBody,
  buildResponsesCreateMessage,
  isResponsesWSTerminal,
  type ResponsesWSRequestOptions,
} from "./ws-providers.js";
import { resolveLiveModel, isInfraSkip, isModelNotFound, listOpenAIModels } from "./providers.js";
import {
  startDriftServer,
  stopDriftServer,
  collectMockWSMessages,
  OPENAI_K9_SUMMARY_SHAPES,
  OPENAI_K9_PROBE_MODEL,
  OPENAI_K9_REPLAY_MODEL,
  matchOpenAIK9SummaryShape,
  isOpenAIModelSnapshot,
} from "./helpers.js";
import { connectWebSocket } from "../ws-test-client.js";

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let instance: ServerInstance;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

beforeAll(async () => {
  instance = await startDriftServer();
});

afterAll(async () => {
  await stopDriftServer(instance);
});

// ---------------------------------------------------------------------------
// Live model discovery
// ---------------------------------------------------------------------------

/**
 * Resolve a live, non-deprecated chat model for the Responses WS probe via
 * `GET /v1/models` (the same discovery `resolveLiveModel` generalizes from the
 * Cohere #325 pattern), preferring `gpt-4o-mini` but falling back to whatever
 * the account's listing exposes. Memoized per-key so both tests below make a
 * single listing call.
 */
function getResponsesWSModel() {
  return resolveLiveModel(
    "openai-responses-ws",
    async () => {
      const ids = await listOpenAIModels(OPENAI_API_KEY!);
      return { status: 200, models: ids.map((id) => ({ id })) };
    },
    ["gpt-4o-mini"],
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!OPENAI_API_KEY)("OpenAI Responses WS drift", () => {
  const config = { apiKey: OPENAI_API_KEY! };

  it("WS text event sequence and shapes match", async (ctx) => {
    const resolved = await getResponsesWSModel();
    if ("infra" in resolved) {
      // Provider-side auth/credit/rate-limit/5xx on the listing — honest skip.
      ctx.skip();
      return;
    }
    if ("unavailable" in resolved) {
      throw new Error("OpenAI /v1/models exposed no usable chat model for the Responses WS probe");
    }
    const model = resolved.model;

    const sdkEvents = openaiResponsesTextEventShapes();

    // Real API via WS — a retired endpoint (handshake auth/rate/5xx) or a
    // stale/retired model id (in-band error frame) is an HONEST SKIP, never a
    // hard-fail that would quarantine the shared drift baseline.
    let realResult;
    try {
      realResult = await openaiResponsesWS(
        config,
        [{ role: "user", content: "Say hello" }],
        undefined,
        model,
      );
    } catch (err) {
      if (err instanceof WSHandshakeError && isInfraSkip(err.status)) {
        console.warn(`[ws-responses drift] WS handshake infra status ${err.status} — skipping`);
        ctx.skip();
        return;
      }
      throw err;
    }
    const errBody = extractWSErrorBody(realResult.rawMessages);
    if (errBody && isModelNotFound(400, errBody)) {
      console.warn(`[ws-responses drift] model-not-found: ${errBody} — skipping`);
      ctx.skip();
      return;
    }

    // Mock via WS — uses flat format matching real API
    const mockWs = await connectWebSocket(instance.url, "/v1/responses");
    mockWs.send(
      JSON.stringify({
        type: "response.create",
        model,
        input: [{ role: "user", content: "Say hello" }],
      }),
    );
    const mockResult = await collectMockWSMessages(mockWs, (msg) => {
      const m = msg as Record<string, unknown>;
      return m.type === "response.completed" || m.type === "response.done";
    });
    mockWs.close();

    expect(realResult.rawMessages.length, "Real API returned no WS messages").toBeGreaterThan(0);
    expect(mockResult.events.length, "Mock returned no WS messages").toBeGreaterThan(0);

    // Grade envelope SHAPE, never status/connection codes — the honest-skip
    // branches above already handled the non-shape failure modes.
    const diffs = compareSSESequences(sdkEvents, realResult.events, mockResult.events);
    const report = formatDriftReport(
      "OpenAI Responses WS (text events)",
      diffs,
      "openai-responses-ws",
    );

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("WS tool call event sequence matches", async (ctx) => {
    const resolved = await getResponsesWSModel();
    if ("infra" in resolved) {
      ctx.skip();
      return;
    }
    if ("unavailable" in resolved) {
      throw new Error("OpenAI /v1/models exposed no usable chat model for the Responses WS probe");
    }
    const model = resolved.model;

    const sdkEvents = [
      ...openaiResponsesTextEventShapes().filter(
        (e) => e.type === "response.created" || e.type === "response.completed",
      ),
      ...openaiResponsesToolCallEventShapes(),
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

    // Real API via WS
    let realResult;
    try {
      realResult = await openaiResponsesWS(
        config,
        [{ role: "user", content: "Weather in Paris" }],
        tools,
        model,
      );
    } catch (err) {
      if (err instanceof WSHandshakeError && isInfraSkip(err.status)) {
        console.warn(`[ws-responses drift] WS handshake infra status ${err.status} — skipping`);
        ctx.skip();
        return;
      }
      throw err;
    }
    const errBody = extractWSErrorBody(realResult.rawMessages);
    if (errBody && isModelNotFound(400, errBody)) {
      console.warn(`[ws-responses drift] model-not-found: ${errBody} — skipping`);
      ctx.skip();
      return;
    }

    // Mock via WS — uses flat format matching real API
    const mockWs = await connectWebSocket(instance.url, "/v1/responses");
    mockWs.send(
      JSON.stringify({
        type: "response.create",
        model,
        input: [{ role: "user", content: "Weather in Paris" }],
        tools,
      }),
    );
    const mockResult = await collectMockWSMessages(mockWs, (msg) => {
      const m = msg as Record<string, unknown>;
      return m.type === "response.completed" || m.type === "response.done";
    });
    mockWs.close();

    expect(realResult.rawMessages.length, "Real API returned no WS messages").toBeGreaterThan(0);
    expect(mockResult.events.length, "Mock returned no WS messages").toBeGreaterThan(0);

    const diffs = compareSSESequences(sdkEvents, realResult.events, mockResult.events);
    const report = formatDriftReport(
      "OpenAI Responses WS (tool call events)",
      diffs,
      "openai-responses-ws",
    );

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });
});

// Shared native C evidence: S2-HTTP k5-20261008T170311Z and k9-20261008T170312Z.
// Local checks below are actual aimock WS; only the credential-gated cases are
// recurring live WS comparisons. Neither is labeled as a new raw C capture.
const exhaustionCases: {
  kind: "K5" | "K9";
  model: string;
  input: object[];
  tools?: object[];
  options: ResponsesWSRequestOptions;
}[] = [
  {
    kind: "K5",
    model: "gpt-4.1-mini",
    input: [
      {
        role: "user",
        content:
          "Call record_text with a detailed 1000-word description of the water cycle in its text argument.",
      },
    ],
    tools: [
      {
        type: "function",
        name: "record_text",
        parameters: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
        strict: false,
      },
    ],
    options: { max_output_tokens: 32, tool_choice: { type: "function", name: "record_text" } },
  },
  {
    kind: "K9",
    model: OPENAI_K9_PROBE_MODEL,
    input: [
      {
        role: "user",
        content:
          "Find all positive integers n below 100000 for which n squared plus n plus 41 is prime. Explain a rigorous strategy before computing.",
      },
    ],
    options: { max_output_tokens: 32, reasoning: { effort: "high", summary: "auto" } },
  },
];

type ExhaustionCase = (typeof exhaustionCases)[number];

async function localWSExhaustion(scenario: ExhaustionCase): Promise<ResponseStreamEvent[]> {
  const mock = new LLMock({ port: 0, logLevel: "silent", chunkSize: 17, enableMisbehavior: true });
  mock.addFixture({
    match: {},
    response:
      scenario.kind === "K5"
        ? {
            toolCalls: [
              {
                name: "record_text",
                arguments: JSON.stringify({
                  text: "The water cycle moves water between the atmosphere and the ground.",
                }),
              },
            ],
          }
        : {
            content: "This answer must be suppressed",
            reasoning: "Consider each integer and test divisibility rigorously.",
          },
    misbehavior: scenario.kind === "K5" ? "stop-length-mid-tool" : "reasoning-only",
  });
  const url = await mock.start();
  try {
    const ws = await connectWebSocket(url, "/v1/responses");
    try {
      ws.send(
        JSON.stringify(
          buildResponsesCreateMessage(
            scenario.model,
            scenario.input,
            scenario.tools,
            scenario.options,
          ),
        ),
      );
      const events: ResponseStreamEvent[] = [];
      const deadline = Date.now() + 5000;
      for (;;) {
        const messages = await ws.waitForMessages(
          events.length + 1,
          Math.max(1, deadline - Date.now()),
        );
        const event: ResponseStreamEvent = JSON.parse(messages[events.length]);
        events.push(event);
        if (isResponsesWSTerminal(event)) return events;
      }
    } finally {
      ws.destroy();
    }
  } finally {
    await mock.stop();
  }
}

function inspectWSExhaustion(
  events: ResponseStreamEvent[],
  kind: "K5" | "K9",
  side: "native" | "localhost",
  requested: string,
) {
  const order = events
    .map((event) => event.type)
    .filter((type, index, types) => !type.endsWith(".delta") || type !== types[index - 1]);
  // Live K9 streams one of three named summary shapes at random (see
  // OPENAI_K9_SUMMARY_SHAPES for the measured frequencies). Only the native
  // side may vary; localhost must still emit the full summary.
  const summaryShape =
    kind === "K9" && side === "native"
      ? matchOpenAIK9SummaryShape(order.slice(3, -2))
      : ("full-summary" as const);
  if (summaryShape === undefined) {
    throw new Error(
      `live K9 event order matches none of the accepted summary shapes ` +
        `(${Object.keys(OPENAI_K9_SUMMARY_SHAPES).join(", ")}): ${order.join(", ")}`,
    );
  }
  expect(order).toEqual([
    "response.created",
    "response.in_progress",
    "response.output_item.added",
    ...(kind === "K5"
      ? ["response.function_call_arguments.delta", "response.function_call_arguments.done"]
      : OPENAI_K9_SUMMARY_SHAPES[summaryShape]),
    "response.output_item.done",
    "response.incomplete",
  ]);
  const terminal = events.at(-1);
  if (terminal?.type !== "response.incomplete") throw new Error("Missing incomplete terminal");
  expect(events.filter((event) => event.type === "response.incomplete")).toHaveLength(1);
  expect(terminal.response.status).toBe("incomplete");
  expect(terminal.response.incomplete_details).toEqual({ reason: "max_output_tokens" });
  expect(terminal.response.output).toHaveLength(1);
  const item = terminal.response.output[0];
  const added = events.filter((event) => event.type === "response.output_item.added");
  const done = events.filter((event) => event.type === "response.output_item.done");
  expect(added).toHaveLength(1);
  expect(done).toHaveLength(1);
  if (typeof item.id !== "string") throw new Error("Missing output item ID");
  expect(item.id.length).toBeGreaterThan(0);
  expect(added[0].output_index).toBe(0);
  expect(done[0].output_index).toBe(0);
  for (const event of events) {
    if (event.type === "response.created" || event.type === "response.in_progress") {
      expect(event.response.id).toBe(terminal.response.id);
    }
  }
  expect(added[0].item.id).toBe(item.id);
  expect(done[0].item.id).toBe(item.id);
  expect(added[0].item.type).toBe(item.type);
  expect(done[0].item.type).toBe(item.type);
  let text = "";
  if (kind === "K5") {
    if (item.type !== "function_call" || done[0].item.type !== "function_call")
      throw new Error("K5 requires only a function call");
    expect(item.name).toBe("record_text");
    expect(added[0].item).toMatchObject({ name: item.name, call_id: item.call_id });
    expect(item.status).toBe("incomplete");
    expect(item.arguments.length).toBeGreaterThan(0);
    expect(() => JSON.parse(item.arguments)).toThrow();
    const deltas = events.filter(
      (event) => event.type === "response.function_call_arguments.delta",
    );
    const argumentDone = events.filter(
      (event) => event.type === "response.function_call_arguments.done",
    );
    expect(argumentDone).toHaveLength(1);
    for (const event of [...deltas, ...argumentDone]) {
      expect(event.item_id).toBe(item.id);
      expect(event.output_index).toBe(0);
    }
    text = deltas.map((event) => event.delta).join("");
    expect(text).toBe(item.arguments);
    expect(argumentDone[0].arguments).toBe(text);
    expect(done[0].item).toMatchObject({
      arguments: text,
      status: "incomplete",
      call_id: item.call_id,
    });
  } else {
    if (item.type !== "reasoning" || done[0].item.type !== "reasoning")
      throw new Error("K9 requires only a reasoning item");
    const deltas = events.filter((event) => event.type === "response.reasoning_summary_text.delta");
    const textDone = events.filter(
      (event) => event.type === "response.reasoning_summary_text.done",
    );
    const partAdded = events.filter(
      (event) => event.type === "response.reasoning_summary_part.added",
    );
    const partDone = events.filter(
      (event) => event.type === "response.reasoning_summary_part.done",
    );
    const closed = summaryShape === "full-summary";
    expect(partAdded).toHaveLength(summaryShape === "no-summary" ? 0 : 1);
    expect(textDone).toHaveLength(closed ? 1 : 0);
    expect(partDone).toHaveLength(closed ? 1 : 0);
    for (const event of [...partAdded, ...deltas, ...textDone, ...partDone]) {
      expect(event.item_id).toBe(item.id);
      expect(event.output_index).toBe(0);
      expect(event.summary_index).toBe(0);
    }
    text = deltas.map((event) => event.delta).join("");
    expect(text.length > 0).toBe(summaryShape !== "no-summary");
    if (closed) {
      // The retained real K9 capture has one item/part whose streamed draft
      // differs from text.done. Final-summary events agree with each other;
      // delta-to-final equality is not part of the exhaustion contract.
      text = textDone[0].text;
      expect(text.length).toBeGreaterThan(0);
      expect(partDone[0].part).toEqual({ type: "summary_text", text });
      expect(item.summary).toEqual([{ type: "summary_text", text }]);
    } else {
      // The cap landed before the summary closed: the final item carries none.
      expect(item.summary).toEqual([]);
    }
    expect(done[0].item.summary).toEqual(item.summary);
    if (side === "native") {
      // The cap went to reasoning alone: no visible output item, and every
      // output token is a reasoning token (0 on o4-mini, the full cap on
      // gpt-5.4-mini).
      expect(terminal.response.output.every((output) => output.type === "reasoning")).toBe(true);
      const usage = terminal.response.usage;
      if (!usage) throw new Error("Missing terminal usage");
      expect(usage.output_tokens).toBe(usage.output_tokens_details.reasoning_tokens);
      expect(isOpenAIModelSnapshot(terminal.response.model, requested)).toBe(true);
      for (const event of events) {
        if (event.type === "response.created" || event.type === "response.in_progress") {
          expect(event.response.model).toBe(terminal.response.model);
        }
      }
    }
  }
  return {
    // The event order outside the reasoning-summary run, which every accepted
    // native shape shares with localhost.
    frame: order.filter((type) => !type.startsWith("response.reasoning_summary_")),
    status: terminal.response.status,
    reason: terminal.response.incomplete_details?.reason,
  };
}

function gradeWSExhaustion(
  events: ResponseStreamEvent[],
  kind: "K5" | "K9",
  side: "native" | "localhost",
  requested: string,
) {
  try {
    return inspectWSExhaustion(events, kind, side, requested);
  } catch (error) {
    throw new Error(
      formatDriftReport(
        `Responses WS ${kind} ${side}`,
        [
          {
            path: `${kind}:${side}:exhaustion-contract`,
            severity: "critical",
            issue: error instanceof Error ? error.message : String(error),
            expected: "captured incomplete/max_output_tokens sequence",
            real:
              side === "native" ? "contract mismatch or NOT_TRIGGERED" : "shared native C evidence",
            mock: side === "localhost" ? "contract mismatch" : "not yet compared",
          },
        ],
        "openai-responses-ws",
      ),
    );
  }
}

describe("Responses WS exhaustion local contract", () => {
  for (const scenario of exhaustionCases) {
    it(`WS ${scenario.kind} actual localhost preserves incomplete contract`, async () => {
      const events = await localWSExhaustion(scenario);
      console.log(JSON.stringify({ kind: scenario.kind, mode: "actual localhost WS", events }));
      gradeWSExhaustion(events, scenario.kind, "localhost", scenario.model);
    });
  }
});

async function compareWSExhaustion(
  scenario: ExhaustionCase,
  nativeEvents: ResponseStreamEvent[],
  requested: string,
) {
  const native = gradeWSExhaustion(nativeEvents, scenario.kind, "native", requested);
  const localEvents = await localWSExhaustion(scenario);
  expect(gradeWSExhaustion(localEvents, scenario.kind, "localhost", requested)).toEqual(native);
  const sdk = [
    ...openaiResponsesTextEventShapes().filter(
      (event) => event.type === "response.created" || event.type === "response.in_progress",
    ),
    ...(scenario.kind === "K5"
      ? openaiResponsesToolCallEventShapes()
      : openaiResponsesReasoningEventShapes()),
  ];
  const diffs = compareSSESequences(
    sdk,
    nativeEvents.map((event) => ({
      type: event.type ?? "unknown",
      dataShape: extractShape(event),
    })),
    localEvents.map((event) => ({ type: event.type, dataShape: extractShape(event) })),
  );
  expect(
    diffs.filter((diff) => diff.severity === "critical"),
    formatDriftReport(`Responses WS ${scenario.kind}`, diffs, "openai-responses-ws"),
  ).toEqual([]);
}

// Retained live o4-mini K9 WS native events captured 2026-10-10 from the K9
// request above (then on OPENAI_K9_REPLAY_MODEL), one per accepted native summary shape. They replay without
// a credential so the variant grading and its rejections stay checked.
const K9_NATIVE_REPLAYS = ["full-summary", "no-summary", "unclosed-summary"] as const;
const k9Case = exhaustionCases.find((scenario) => scenario.kind === "K9")!;

async function readK9NativeReplay(
  shape: (typeof K9_NATIVE_REPLAYS)[number],
): Promise<ResponseStreamEvent[]> {
  return JSON.parse(
    await readFile(new URL(`./fixtures/ws-responses-k9-${shape}.json`, import.meta.url), "utf8"),
  );
}

describe("Responses WS K9 native variant replay", () => {
  it.each(K9_NATIVE_REPLAYS)(
    "retained %s native events agree with actual localhost",
    async (shape) => {
      await compareWSExhaustion(k9Case, await readK9NativeReplay(shape), OPENAI_K9_REPLAY_MODEL);
    },
  );

  it.each(K9_NATIVE_REPLAYS)(
    "retained %s native events reject a wrong terminal status, non-reasoning output tokens or another model",
    async (shape) => {
      const events = await readK9NativeReplay(shape);
      const terminal = events.at(-1);
      if (terminal?.type !== "response.incomplete") throw new Error("Missing incomplete terminal");
      expect(terminal.response.status).toBe("incomplete");
      expect(terminal.response.usage?.output_tokens).toBe(0);
      const wrongStatus = structuredClone(events);
      const statusTerminal = wrongStatus.at(-1);
      if (statusTerminal?.type !== "response.incomplete") throw new Error("Missing terminal");
      statusTerminal.response.status = "completed";
      expect(() =>
        inspectWSExhaustion(wrongStatus, "K9", "native", OPENAI_K9_REPLAY_MODEL),
      ).toThrow();
      const spentTokens = structuredClone(events);
      const tokenTerminal = spentTokens.at(-1);
      if (tokenTerminal?.type !== "response.incomplete" || !tokenTerminal.response.usage)
        throw new Error("Missing terminal usage");
      tokenTerminal.response.usage.output_tokens = 7;
      expect(() =>
        inspectWSExhaustion(spentTokens, "K9", "native", OPENAI_K9_REPLAY_MODEL),
      ).toThrow();
      expect(terminal.response.model).toBe("o4-mini-2025-04-16");
      const otherModel = structuredClone(events);
      for (const event of otherModel) {
        if (
          event.type === "response.created" ||
          event.type === "response.in_progress" ||
          event.type === "response.incomplete"
        )
          event.response.model = "gpt-4.1-mini-2025-04-14";
      }
      expect(() =>
        inspectWSExhaustion(otherModel, "K9", "native", OPENAI_K9_REPLAY_MODEL),
      ).toThrow();
      // A valid-looking snapshot on the terminal alone must still disagree
      // with created/in_progress.
      const terminalModel = structuredClone(events);
      const modelTerminal = terminalModel.at(-1);
      if (modelTerminal?.type !== "response.incomplete") throw new Error("Missing terminal");
      modelTerminal.response.model = "o4-mini-2099-01-01";
      expect(() =>
        inspectWSExhaustion(terminalModel, "K9", "native", OPENAI_K9_REPLAY_MODEL),
      ).toThrow();
    },
  );

  it("rejects an 8-event out-of-order native summary sequence", async () => {
    const events = await readK9NativeReplay("full-summary");
    const textDone = events.filter(
      (event) => event.type === "response.reasoning_summary_text.done",
    );
    const reordered = events
      .filter(
        (event) =>
          event.type !== "response.reasoning_summary_part.added" &&
          event.type !== "response.reasoning_summary_text.done",
      )
      .flatMap((event): ResponseStreamEvent[] =>
        event.type === "response.reasoning_summary_part.done" ? [event, ...textDone] : [event],
      );
    expect(textDone).toHaveLength(1);
    expect(events.length - reordered.length).toBe(1);
    expect(() => inspectWSExhaustion(reordered, "K9", "native", OPENAI_K9_REPLAY_MODEL)).toThrow(
      /matches none of the accepted summary shapes/,
    );
  });

  it.each(["no-summary", "unclosed-summary"] as const)(
    "localhost grading still rejects the %s native shape",
    async (shape) => {
      const events = await readK9NativeReplay(shape);
      expect(() => inspectWSExhaustion(events, "K9", "localhost", OPENAI_K9_REPLAY_MODEL)).toThrow(
        /deeply equal/,
      );
    },
  );
});

// Two generation sends maximum in this block; no retries, discovery or fallback.
// A failure stops the remaining scenario rather than spending another request.
let exhaustionStopped = false;
describe.skipIf(!OPENAI_API_KEY)("OpenAI Responses WS exhaustion live drift", () => {
  for (const scenario of exhaustionCases) {
    it(`WS ${scenario.kind} native comparison`, async (ctx) => {
      if (exhaustionStopped) {
        console.warn(`[ws-responses drift] ${scenario.kind} unattempted after prior failure`);
        ctx.skip();
        return;
      }
      try {
        const result = await openaiResponsesWS(
          { apiKey: OPENAI_API_KEY! },
          scenario.input,
          scenario.tools,
          scenario.model,
          scenario.options,
        );
        console.log(
          JSON.stringify({
            kind: scenario.kind,
            mode: "live WS decoded native events; not raw frames",
            request: buildResponsesCreateMessage(
              scenario.model,
              scenario.input,
              scenario.tools,
              scenario.options,
            ),
            events: result.rawMessages,
          }).replaceAll(OPENAI_API_KEY!, "[REDACTED]"),
        );
        // The SDK union supplies event discriminators; semantic validation below
        // still grades the untrusted native response, including error terminals.
        await compareWSExhaustion(
          scenario,
          result.rawMessages as ResponseStreamEvent[],
          scenario.model,
        );
      } catch (error) {
        exhaustionStopped = true;
        if (error instanceof WSHandshakeError && isInfraSkip(error.status)) {
          console.warn(
            `[ws-responses drift] ${scenario.kind} infra status ${error.status}; live acceptance pending`,
          );
          ctx.skip();
          return;
        }
        // NOT_TRIGGERED and malformed/native errors are failures, never success.
        throw error;
      }
    });
  }
});
