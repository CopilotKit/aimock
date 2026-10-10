/**
 * OpenAI Responses API drift tests.
 *
 * Three-way comparison: SDK types × real API × aimock output.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type {
  ResponseCreateParamsStreaming,
  ResponseStreamEvent,
} from "openai-current-sdk/resources/responses/responses";
import { LLMock } from "../../llmock.js";
import { createServer, type ServerInstance } from "../../server.js";
import type { Fixture } from "../../types.js";
import {
  extractShape,
  triangulate,
  compareSSESequences,
  formatDriftReport,
  type SSEEventShape,
  type ShapeDiff,
} from "./schema.js";
import {
  openaiResponsesNonStreamingShape,
  openaiResponsesTextEventShapes,
  openaiResponsesToolCallEventShapes,
  openaiResponsesNamespacedToolCallEventShapes,
  openaiResponsesCustomToolCallEventShapes,
  openaiResponsesNamespacedToolCallNonStreamingShape,
  openaiResponsesCustomToolCallNonStreamingShape,
  openaiResponsesReasoningEventShapes,
  openaiResponsesEncryptedReasoningEventShapes,
} from "./sdk-shapes.js";
import {
  resolveLiveModel,
  isInfraSkip,
  isModelNotFound,
  type LiveModelEntry,
  type ResolvedModel,
} from "./providers.js";
import {
  httpPost,
  httpPostRaw,
  parseTypedSSE,
  startDriftServer,
  stopDriftServer,
} from "./helpers.js";

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
// Live model discovery (self-healing)
// ---------------------------------------------------------------------------
//
// Replaces the hardcoded "gpt-4o-mini" pin with a live-listing lookup so a
// retired/renamed alias resolves to a currently-valid model (or honest-skips)
// instead of quarantining this leg's whole batch. Generalizes the cohere
// (#325) discovery + fal (#332) infra-skip patterns via providers.ts's shared
// resolveLiveModel/isInfraSkip/isModelNotFound.
//
// providers.ts's own `openaiResponsesNonStreaming`/`openaiResponsesStreaming`
// hardcode "gpt-4o-mini" and take no model parameter, so the live probe below
// is a local, model-parameterized fetch (mirrors cohere.drift.ts's pattern of
// a leg-local raw-fetch helper) rather than a providers.ts edit.

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";

// Credential presence enables two bounded paid exhaustion probes in daily
// drift. An explicit capture directory instead replays the hash-pinned real
// transcripts, with their exact requests/status metadata checked below.
const EXHAUSTION_CAPTURE_DIR = process.env.OPENAI_RESPONSES_EXHAUSTION_CAPTURE_DIR;
const exhaustionCases: {
  kind: "K5" | "K9";
  prefix: string;
  sha256: string;
  request: ResponseCreateParamsStreaming;
}[] = [
  {
    kind: "K5",
    prefix: "k5-20261008T170311Z",
    sha256: "8095336aeb8908dd4647bbecd49a5a06959f1e5dac06b7a9a17416a30c3e7152",
    request: {
      model: "gpt-4.1-mini",
      input:
        "Call record_text with a detailed 1000-word description of the water cycle in its text argument.",
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
      tool_choice: { type: "function", name: "record_text" },
      max_output_tokens: 32,
      stream: true,
      store: false,
    },
  },
  {
    kind: "K9",
    prefix: "k9-20261008T170312Z",
    sha256: "f96bf0db1dae1cab1956af15d589d26cace087a5893604bd6c727b6347c0d0ae",
    request: {
      model: "o4-mini",
      input:
        "Find all positive integers n below 100000 for which n squared plus n plus 41 is prime. Explain a rigorous strategy before computing.",
      reasoning: { effort: "high", summary: "auto" },
      max_output_tokens: 32,
      stream: true,
      store: false,
    },
  },
];

function inspectExhaustion(raw: string, kind: "K5" | "K9") {
  const blocks = raw.replace(/\r\n/g, "\n").split("\n\n");
  expect(blocks.pop(), "Responses terminal SSE event must be terminated").toBe("");
  const events: ResponseStreamEvent[] = blocks.filter(Boolean).map((block) => {
    const lines = block.split("\n").filter((line) => !line.startsWith(":"));
    const eventType = lines.filter((line) => line.startsWith("event: "));
    const data = lines.filter((line) => line.startsWith("data: "));
    expect(eventType).toHaveLength(1);
    expect(data).toHaveLength(1);
    const event: ResponseStreamEvent = JSON.parse(data[0].slice(6));
    expect(event.type).toBe(eventType[0].slice(7));
    return event;
  });
  const order = events
    .map((event) => event.type)
    .filter((type, index, types) => type !== types[index - 1]);
  expect(order).toEqual([
    "response.created",
    "response.in_progress",
    "response.output_item.added",
    ...(kind === "K5"
      ? ["response.function_call_arguments.delta", "response.function_call_arguments.done"]
      : [
          "response.reasoning_summary_part.added",
          "response.reasoning_summary_text.delta",
          "response.reasoning_summary_text.done",
          "response.reasoning_summary_part.done",
        ]),
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
  expect(added[0].item.id).toBe(item.id);
  expect(done[0].item.id).toBe(item.id);
  expect(added[0].item.type).toBe(item.type);
  expect(done[0].item.type).toBe(item.type);
  let text = "";
  if (kind === "K5") {
    if (item.type !== "function_call" || done[0].item.type !== "function_call")
      throw new Error("K5 requires only a function call");
    expect(item.name).toBe("record_text");
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
    const partDone = events.filter(
      (event) => event.type === "response.reasoning_summary_part.done",
    );
    expect(textDone).toHaveLength(1);
    expect(partDone).toHaveLength(1);
    for (const event of [...deltas, ...textDone, ...partDone]) {
      expect(event.item_id).toBe(item.id);
      expect(event.output_index).toBe(0);
      expect(event.summary_index).toBe(0);
    }
    text = deltas.map((event) => event.delta).join("");
    expect(text.length).toBeGreaterThan(0);
    // The retained real K9 capture has one item/part whose streamed draft
    // differs from text.done. Final-summary events agree with each other;
    // delta-to-final equality is not part of the exhaustion contract.
    text = textDone[0].text;
    expect(text.length).toBeGreaterThan(0);
    expect(partDone[0].part).toEqual({ type: "summary_text", text });
    expect(item.summary).toEqual([{ type: "summary_text", text }]);
    expect(done[0].item.summary).toEqual(item.summary);
  }
  return {
    order,
    text,
    status: terminal.response.status,
    reason: terminal.response.incomplete_details?.reason,
  };
}

function gradeExhaustion(raw: string, kind: "K5" | "K9", side: "provider" | "localhost") {
  try {
    return inspectExhaustion(raw, kind);
  } catch (error) {
    throw new Error(
      formatDriftReport(
        `Responses ${kind} ${side} exhaustion`,
        [
          {
            path: `${kind}:${side}:exhaustion-contract`,
            severity: "critical",
            issue: error instanceof Error ? error.message : String(error),
            expected: "captured incomplete/max_output_tokens event sequence and consistent payload",
            real: side === "provider" ? "invalid event stream" : "validated provider stream",
            mock: side === "localhost" ? "invalid event stream" : "not yet compared",
          },
        ],
        "openai-responses",
      ),
    );
  }
}

async function exhaustionProviderWire(scenario: (typeof exhaustionCases)[number]) {
  if (EXHAUSTION_CAPTURE_DIR) {
    const raw = await readFile(
      join(EXHAUSTION_CAPTURE_DIR, `${scenario.prefix}-response.sse`),
      "utf8",
    );
    expect(createHash("sha256").update(raw).digest("hex")).toBe(scenario.sha256);
    const request: { body: ResponseCreateParamsStreaming } = JSON.parse(
      await readFile(join(EXHAUSTION_CAPTURE_DIR, `${scenario.prefix}-request.json`), "utf8"),
    );
    const status: { status: string; content_type: string } = JSON.parse(
      await readFile(join(EXHAUSTION_CAPTURE_DIR, `${scenario.prefix}-status.json`), "utf8"),
    );
    expect(request.body).toEqual(scenario.request);
    expect(status.status).toBe("200");
    expect(status.content_type).toContain("text/event-stream");
    console.log(
      JSON.stringify({
        kind: scenario.kind,
        mode: "retained real capture",
        sha256: scenario.sha256,
        request: request.body,
      }),
    );
    return raw;
  }
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 45_000);
  let raw = "";
  let completed = false;
  try {
    const response = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify(scenario.request),
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    if (!response.body) throw new Error("Missing Responses body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > 1_048_576) throw new Error("Responses exhaustion exceeded 1 MiB");
      raw += decoder.decode(result.value, { stream: true });
    }
    raw += decoder.decode();
    completed = true;
    return raw;
  } finally {
    clearTimeout(deadline);
    controller.abort();
    console.log(
      JSON.stringify({
        kind: scenario.kind,
        mode: "live paid provider; no retries",
        request: scenario.request,
        completed,
        raw: OPENAI_API_KEY ? raw.replaceAll(OPENAI_API_KEY, "[REDACTED]") : raw,
      }),
    );
  }
}

describe.skipIf(!OPENAI_API_KEY && !EXHAUSTION_CAPTURE_DIR)(
  "Responses K5/K9 exhaustion drift",
  () => {
    it.each(exhaustionCases)(
      "$kind provider terminal agrees with actual localhost",
      async (scenario) => {
        const provider = await exhaustionProviderWire(scenario);
        const expected = gradeExhaustion(provider, scenario.kind, "provider");
        // Deliberate mutation of authentic provider bytes tests this reader's
        // sensitivity, not a new product regression or a fabricated SDK response.
        expect(() =>
          inspectExhaustion(
            provider.replaceAll("response.incomplete", "response.completed"),
            scenario.kind,
          ),
        ).toThrow();
        console.log(
          JSON.stringify({
            kind: scenario.kind,
            sensitivity: "real provider terminal changed to response.completed",
            rejected: true,
          }),
        );
        const mock = new LLMock({
          port: 0,
          logLevel: "silent",
          chunkSize: 17,
          enableMisbehavior: true,
        });
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
          const local = await httpPost(`${url}/v1/responses`, scenario.request);
          expect(local.status, local.body).toBe(200);
          expect(local.headers["content-type"]).toContain("text/event-stream");
          console.log(
            JSON.stringify({
              kind: scenario.kind,
              mode: "actual localhost",
              request: scenario.request,
              raw: local.body,
            }),
          );
          const actual = gradeExhaustion(local.body, scenario.kind, "localhost");
          expect(actual.order).toEqual(expected.order);
          expect(actual.status).toBe(expected.status);
          expect(actual.reason).toBe(expected.reason);
        } finally {
          await mock.stop();
        }
      },
    );
  },
);

/** Maps OpenAI's `/v1/models` listing shape onto {@link LiveModelEntry}. */
export async function fetchOpenAIModelsListing(): Promise<{
  status: number;
  models: LiveModelEntry[];
  /** The start of the body, set only when the listing failed or was not JSON. */
  bodyPreview?: string;
}> {
  const res = await fetch(OPENAI_MODELS_URL, {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
  });
  const raw = await res.text();
  if (res.status >= 400) return { status: res.status, models: [], bodyPreview: raw.slice(0, 300) };
  let json: { data?: { id: string }[] };
  try {
    json = JSON.parse(raw) as { data?: { id: string }[] };
  } catch {
    return { status: res.status, models: [], bodyPreview: `non-JSON body: ${raw.slice(0, 300)}` };
  }
  return { status: res.status, models: (json.data ?? []).map((m) => ({ id: m.id })) };
}

/** Memoized (per providers.ts `resolveLiveModel`) so each resolver key makes one listing call. */
export function getOpenAIResponsesModel(): Promise<ResolvedModel> {
  return resolveLiveModel("openai-responses", fetchOpenAIModelsListing, ["gpt-4o-mini", "gpt-4o"]);
}

/**
 * Raw Responses API fetch parameterized by a discovered model id, returning
 * the raw status/body so the caller can classify a retired-model or
 * provider-side condition via {@link isModelNotFound}/{@link isInfraSkip}
 * BEFORE asserting success (unlike providers.ts's variants, which throw an
 * opaque InfraError on any non-2xx).
 */
export async function fetchOpenAIResponses(
  model: string,
  input: object[],
  tools: object[] | undefined,
  stream: boolean,
): Promise<{ status: number; raw: string }> {
  const body: Record<string, unknown> = { model, input, stream, max_output_tokens: 50 };
  if (tools) body.tools = tools;

  const res = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  return { status: res.status, raw: await res.text() };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!OPENAI_API_KEY)("OpenAI Responses API drift", () => {
  it("non-streaming text shape matches", async (ctx) => {
    const resolved = await getOpenAIResponsesModel();
    if ("infra" in resolved) {
      // Provider-side auth/credit/rate-limit/5xx — honest skip, not drift.
      ctx.skip();
      return;
    }
    if ("unavailable" in resolved) {
      throw new Error("OpenAI /v1/models exposed no usable model for the Responses API");
    }
    const model = resolved.model;

    const sdkShape = openaiResponsesNonStreamingShape();
    const input = [{ role: "user", content: "Say hello" }];

    const [realRes, mockRes] = await Promise.all([
      fetchOpenAIResponses(model, input, undefined, false),
      httpPost(`${instance.url}/v1/responses`, {
        model,
        input,
        stream: false,
      }),
    ]);

    if (isInfraSkip(realRes.status) || isModelNotFound(realRes.status, realRes.raw)) {
      // Retired/renamed model or a transient provider condition — honest skip.
      ctx.skip();
      return;
    }
    expect(realRes.status, `Real API error: ${realRes.raw.slice(0, 300)}`).toBe(200);

    const realShape = extractShape(JSON.parse(realRes.raw));
    const mockShape = extractShape(JSON.parse(mockRes.body));

    const diffs = triangulate(sdkShape, realShape, mockShape);
    const report = formatDriftReport(
      "OpenAI Responses (non-streaming text)",
      diffs,
      "openai-responses",
    );

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("streaming text event sequence and shapes match", async (ctx) => {
    const resolved = await getOpenAIResponsesModel();
    if ("infra" in resolved) {
      ctx.skip();
      return;
    }
    if ("unavailable" in resolved) {
      throw new Error("OpenAI /v1/models exposed no usable model for the Responses API");
    }
    const model = resolved.model;

    const sdkEvents = openaiResponsesTextEventShapes();
    const input = [{ role: "user", content: "Say hello" }];

    const [realRes, mockStreamRes] = await Promise.all([
      fetchOpenAIResponses(model, input, undefined, true),
      httpPost(`${instance.url}/v1/responses`, {
        model,
        input,
        stream: true,
      }),
    ]);

    if (isInfraSkip(realRes.status) || isModelNotFound(realRes.status, realRes.raw)) {
      ctx.skip();
      return;
    }
    expect(realRes.status, `Real API error: ${realRes.raw.slice(0, 300)}`).toBe(200);

    const realEvents = parseTypedSSE(realRes.raw);
    expect(realEvents.length, "Real API returned no SSE events").toBeGreaterThan(0);
    const realSSEShapes = realEvents.map((e) => ({
      type: e.type,
      dataShape: extractShape(e.data),
    }));

    const mockEvents = parseTypedSSE(mockStreamRes.body);
    expect(mockEvents.length, "Mock returned no SSE events").toBeGreaterThan(0);

    const mockSSEShapes = mockEvents.map((e) => ({
      type: e.type,
      dataShape: extractShape(e.data),
    }));

    const diffs = compareSSESequences(sdkEvents, realSSEShapes, mockSSEShapes);
    const report = formatDriftReport(
      "OpenAI Responses (streaming text events)",
      diffs,
      "openai-responses",
    );

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("non-streaming tool call shape matches", async (ctx) => {
    const resolved = await getOpenAIResponsesModel();
    if ("infra" in resolved) {
      ctx.skip();
      return;
    }
    if ("unavailable" in resolved) {
      throw new Error("OpenAI /v1/models exposed no usable model for the Responses API");
    }
    const model = resolved.model;

    const sdkShape = openaiResponsesNonStreamingShape();

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
    const input = [{ role: "user", content: "Weather in Paris" }];

    const [realRes, mockRes] = await Promise.all([
      fetchOpenAIResponses(model, input, tools, false),
      httpPost(`${instance.url}/v1/responses`, {
        model,
        input,
        stream: false,
        tools,
      }),
    ]);

    if (isInfraSkip(realRes.status) || isModelNotFound(realRes.status, realRes.raw)) {
      ctx.skip();
      return;
    }
    expect(realRes.status, `Real API error: ${realRes.raw.slice(0, 300)}`).toBe(200);

    const realShape = extractShape(JSON.parse(realRes.raw));
    const mockShape = extractShape(JSON.parse(mockRes.body));

    const diffs = triangulate(sdkShape, realShape, mockShape);
    const report = formatDriftReport(
      "OpenAI Responses (non-streaming tool call)",
      diffs,
      "openai-responses",
    );

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("streaming tool call event sequence matches", async (ctx) => {
    const resolved = await getOpenAIResponsesModel();
    if ("infra" in resolved) {
      ctx.skip();
      return;
    }
    if ("unavailable" in resolved) {
      throw new Error("OpenAI /v1/models exposed no usable model for the Responses API");
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
    const input = [{ role: "user", content: "Weather in Paris" }];

    const [realRes, mockStreamRes] = await Promise.all([
      fetchOpenAIResponses(model, input, tools, true),
      httpPost(`${instance.url}/v1/responses`, {
        model,
        input,
        stream: true,
        tools,
      }),
    ]);

    if (isInfraSkip(realRes.status) || isModelNotFound(realRes.status, realRes.raw)) {
      ctx.skip();
      return;
    }
    expect(realRes.status, `Real API error: ${realRes.raw.slice(0, 300)}`).toBe(200);

    const realEvents = parseTypedSSE(realRes.raw);
    expect(realEvents.length, "Real API returned no SSE events").toBeGreaterThan(0);
    const realSSEShapes = realEvents.map((e) => ({
      type: e.type,
      dataShape: extractShape(e.data),
    }));

    const mockEvents = parseTypedSSE(mockStreamRes.body);
    expect(mockEvents.length, "Mock returned no SSE events").toBeGreaterThan(0);

    const mockSSEShapes = mockEvents.map((e) => ({
      type: e.type,
      dataShape: extractShape(e.data),
    }));

    const diffs = compareSSESequences(sdkEvents, realSSEShapes, mockSSEShapes);
    const report = formatDriftReport(
      "OpenAI Responses (streaming tool call events)",
      diffs,
      "openai-responses",
    );

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Namespaced and custom tool calls (#505)
// ---------------------------------------------------------------------------
//
// `namespace` tools and `custom` (freeform) tools are GPT-5-family features, so
// these legs resolve their own model, choosing ONLY from GPT5_TOOL_MODELS (never
// the listing's first id). They report SKIPPED via `ctx.skip(reason)` only for
// a genuinely unavailable probe: an infra status on the listing or the real
// call, the real call reporting the model not found (`isModelNotFound`), or an
// inconclusive real run (`response.incomplete`). A bare `return` would report
// PASS with nothing compared. Everything else FAILS, like the other legs in
// this file: a non-infra listing error, a listing with no usable models, a
// listing that names none of GPT5_TOOL_MODELS (retired or renamed ids must turn
// the run red, not skip forever), a mock error status, and a real run that
// ends `response.failed` or with an `error` event. `tool_choice: "required"`
// with a single offered tool forces the call without depending on a
// namespace-aware `tool_choice` shape.

const NAMESPACE_TOOLS = [
  {
    type: "namespace",
    name: "weather_tools",
    description: "Weather lookups",
    tools: [
      {
        type: "function",
        name: "get_weather",
        description: "Get weather",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
          additionalProperties: false,
        },
      },
    ],
  },
];

const CUSTOM_TOOLS = [
  {
    type: "custom",
    name: "apply_patch",
    description: "Apply a patch in the *** Begin Patch / *** End Patch format.",
  },
];

/** The only models the namespaced/custom tool legs may drive, in preference order. */
const GPT5_TOOL_MODELS = ["gpt-5-mini", "gpt-5"];

/** What the (single, memoized) listing call for the tool legs returned. */
let toolsListing: { status: number; listed: number; bodyPreview?: string } | undefined;

/**
 * Memoized model for the namespaced/custom tool legs. The listing is narrowed
 * to {@link GPT5_TOOL_MODELS} before selection, so `selectLiveModel`'s
 * first-listed-id fallback can never pick an unrelated (or tool-less gpt-5
 * variant) model; with none of them listed the result is `{ unavailable }`.
 * The unfiltered status and count are kept in {@link toolsListing} so the
 * failure message names the actual cause.
 */
function getOpenAIResponsesToolsModel(): Promise<ResolvedModel> {
  return resolveLiveModel(
    "openai-responses-gpt5-tools",
    async () => {
      const listing = await fetchOpenAIModelsListing();
      toolsListing = {
        status: listing.status,
        listed: listing.models.length,
        bodyPreview: listing.bodyPreview,
      };
      return {
        status: listing.status,
        models: listing.models.filter((m) => GPT5_TOOL_MODELS.includes(m.id)),
      };
    },
    GPT5_TOOL_MODELS,
  );
}

/**
 * The model for a tool leg, or the reason to skip. `{ unavailable }` THROWS,
 * as in every other leg here (see `ResolvedModel` in providers.ts: "a
 * genuinely broken state to fail loud on"). A skip would hide a broken listing
 * and, once both GPT5_TOOL_MODELS ids are retired, would drop the #505 drift
 * coverage with no red signal anywhere.
 */
async function resolveToolsModel(): Promise<{ model: string } | { skip: string }> {
  const resolved = await getOpenAIResponsesToolsModel();
  if ("infra" in resolved) return { skip: `OpenAI /v1/models infra status ${resolved.infra}` };
  if ("model" in resolved) return { model: resolved.model };
  const l = toolsListing;
  if (!l) throw new Error("OpenAI /v1/models: no listing recorded for the namespaced/custom legs");
  if (l.status >= 400) {
    throw new Error(`OpenAI /v1/models listing failed: status ${l.status}: ${l.bodyPreview ?? ""}`);
  }
  if (l.listed === 0) {
    throw new Error(
      `OpenAI /v1/models (status ${l.status}) returned no usable models: ${l.bodyPreview ?? "empty data[]"}`,
    );
  }
  throw new Error(
    `OpenAI /v1/models lists ${l.listed} models but none of ${GPT5_TOOL_MODELS.join(", ")}: ` +
      `the ids were retired or renamed (update GPT5_TOOL_MODELS) or the key lost gpt-5 access. ` +
      `Namespaced and custom tool drift is NOT being checked until this is fixed.`,
  );
}

type TypedSSEEvent = ReturnType<typeof parseTypedSSE>[number];

function isReasoningItem(item: unknown): boolean {
  return (
    typeof item === "object" && item !== null && (item as { type?: unknown }).type === "reasoning"
  );
}

/**
 * Drops everything a real stream carries for its `reasoning` output items:
 * their `output_item.added`/`.done` events, every `response.reasoning_*` event
 * (summary parts, summary text, reasoning text), any other event whose
 * `item_id` is a reasoning item's id, and their entries in
 * `response.completed.output`. Every other event, and every other output item,
 * is kept as-is.
 */
function withoutReasoningItems(events: TypedSSEEvent[]): TypedSSEEvent[] {
  const isItemEvent = (e: TypedSSEEvent) =>
    e.type === "response.output_item.added" || e.type === "response.output_item.done";
  const reasoningIds = new Set<unknown>(
    events.filter((e) => isItemEvent(e) && isReasoningItem(e.data.item)).map((e) => e.data.item.id),
  );
  return events
    .filter(
      (e) =>
        !(isItemEvent(e) && isReasoningItem(e.data.item)) &&
        !e.type.startsWith("response.reasoning_") &&
        !(e.data.item_id !== undefined && reasoningIds.has(e.data.item_id)),
    )
    .map((e) => {
      const output: unknown = e.data.response?.output;
      if (e.type !== "response.completed" || !Array.isArray(output)) return e;
      return {
        ...e,
        data: {
          ...e.data,
          response: { ...e.data.response, output: output.filter((i) => !isReasoningItem(i)) },
        },
      };
    });
}

/**
 * The provider's own error text when a real stream ended `response.failed` or
 * with a top-level `error` event (both arrive on an HTTP 200), else undefined.
 */
function realStreamFailure(events: TypedSSEEvent[]): string | undefined {
  const failure = events.find((e) => e.type === "response.failed" || e.type === "error");
  if (!failure) return undefined;
  const error: unknown =
    failure.type === "error" ? failure.data : (failure.data.response?.error ?? failure.data);
  return `real stream ended ${failure.type}: ${JSON.stringify(error)}`;
}

async function fetchOpenAIResponsesForcedTool(
  model: string,
  input: object[],
  tools: object[],
  stream: boolean,
): Promise<{ status: number; raw: string }> {
  const res = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      input,
      tools,
      tool_choice: "required",
      stream,
      // gpt-5-family models spend output tokens on hidden reasoning first. Low
      // effort plus a roomy cap keeps a forced single call from ending
      // `incomplete` (max_output_tokens); the leg still skips if it does.
      reasoning: { effort: "low" },
      max_output_tokens: 4096,
    }),
  });
  return { status: res.status, raw: await res.text() };
}

describe.skipIf(!OPENAI_API_KEY)("OpenAI Responses API drift — namespaced and custom tools", () => {
  let toolsInstance: ServerInstance;

  beforeAll(async () => {
    toolsInstance = await createServer(
      [
        {
          match: { toolName: "get_weather", toolNamespace: "weather_tools" },
          response: {
            toolCalls: [
              { name: "get_weather", namespace: "weather_tools", arguments: '{"city":"Paris"}' },
            ],
          },
        },
        {
          match: { toolName: "apply_patch" },
          response: {
            toolCalls: [],
            customToolCalls: [
              {
                type: "custom",
                name: "apply_patch",
                input: "*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch\n",
              },
            ],
          },
        },
      ] satisfies Fixture[],
      // Namespace emission on toolCalls and custom-tool matching are opt-in.
      { port: 0, chunkSize: 100, responsesTools: "extended" },
    );
  });

  afterAll(async () => {
    await stopDriftServer(toolsInstance);
  });

  const legs = [
    {
      name: "namespaced function_call",
      tools: NAMESPACE_TOOLS,
      input: [{ role: "user", content: "Weather in Paris" }],
      itemType: "function_call",
      sdk: openaiResponsesNamespacedToolCallEventShapes,
      sdkNonStreaming: openaiResponsesNamespacedToolCallNonStreamingShape,
    },
    {
      name: "custom_tool_call",
      tools: CUSTOM_TOOLS,
      input: [{ role: "user", content: "Create hello.txt containing hello, using apply_patch." }],
      itemType: "custom_tool_call",
      sdk: openaiResponsesCustomToolCallEventShapes,
      sdkNonStreaming: openaiResponsesCustomToolCallNonStreamingShape,
    },
  ];

  it.for(legs)(
    "streaming $name event sequence matches",
    async ({ name, tools, input, itemType, sdk }, ctx) => {
      const resolved = await resolveToolsModel();
      if ("skip" in resolved) {
        ctx.skip(resolved.skip);
        return;
      }
      const model = resolved.model;

      // The leg's own shapes carry `response.completed` with the tool item; the
      // text leg contributes only `response.created`.
      const sdkEvents = [
        ...openaiResponsesTextEventShapes().filter((e) => e.type === "response.created"),
        ...sdk(),
      ];

      const [realRes, mockStreamRes] = await Promise.all([
        fetchOpenAIResponsesForcedTool(model, input, tools, true),
        httpPost(`${toolsInstance.url}/v1/responses`, { model, input, stream: true, tools }),
      ]);

      if (isInfraSkip(realRes.status) || isModelNotFound(realRes.status, realRes.raw)) {
        ctx.skip(`real Responses API status ${realRes.status} for ${model}`);
        return;
      }
      expect(realRes.status, `Real API error: ${realRes.raw.slice(0, 300)}`).toBe(200);
      expect(
        mockStreamRes.status,
        `Mock error ${mockStreamRes.status}: ${mockStreamRes.body.slice(0, 300)}`,
      ).toBe(200);

      const parsedReal = parseTypedSSE(realRes.raw);
      expect(parsedReal.length, "Real API returned no SSE events").toBeGreaterThan(0);
      const incomplete = parsedReal.find((e) => e.type === "response.incomplete");
      if (incomplete) {
        // The model ran out of budget before finishing: an inconclusive probe,
        // not drift. Skip with the reason rather than grade a partial stream.
        ctx.skip(
          `real run ended response.incomplete (${JSON.stringify(incomplete.data.response?.incomplete_details ?? null)})`,
        );
        return;
      }
      const failure = realStreamFailure(parsedReal);
      if (failure) throw new Error(failure);
      // The real gpt-5 stream leads with a `reasoning` item; the mock fixture
      // defines none, so it is dropped here to keep this leg about the tool
      // item. The reasoning legs below are mock-only, so real reasoning-item
      // shapes are not graded anywhere in this suite.
      const realEvents = withoutReasoningItems(parsedReal);
      expect(
        realEvents.some(
          (e) => e.type === "response.output_item.done" && e.data.item?.type === itemType,
        ),
        `Real API stream has no ${itemType} item despite tool_choice "required"; ` +
          `events: ${parsedReal.map((e) => e.type).join(", ")}`,
      ).toBe(true);
      const mockEvents = parseTypedSSE(mockStreamRes.body);
      expect(mockEvents.length, "Mock returned no SSE events").toBeGreaterThan(0);

      const toShapes = (events: typeof realEvents) =>
        events.map((e) => ({ type: e.type, dataShape: extractShape(e.data) }));
      const diffs = compareSSESequences(sdkEvents, toShapes(realEvents), toShapes(mockEvents));
      const report = formatDriftReport(
        `OpenAI Responses (streaming ${name} events)`,
        diffs,
        "openai-responses",
      );

      expect(
        diffs.filter((d) => d.severity === "critical"),
        report,
      ).toEqual([]);
    },
  );

  it.for(legs)(
    "non-streaming $name output item shape matches",
    async ({ name, tools, input, itemType, sdkNonStreaming }, ctx) => {
      const resolved = await resolveToolsModel();
      if ("skip" in resolved) {
        ctx.skip(resolved.skip);
        return;
      }
      const model = resolved.model;

      const [realRes, mockRes] = await Promise.all([
        fetchOpenAIResponsesForcedTool(model, input, tools, false),
        httpPost(`${toolsInstance.url}/v1/responses`, { model, input, stream: false, tools }),
      ]);

      if (isInfraSkip(realRes.status) || isModelNotFound(realRes.status, realRes.raw)) {
        ctx.skip(`real Responses API status ${realRes.status} for ${model}`);
        return;
      }
      expect(realRes.status, `Real API error: ${realRes.raw.slice(0, 300)}`).toBe(200);
      expect(mockRes.status, `Mock error ${mockRes.status}: ${mockRes.body.slice(0, 300)}`).toBe(
        200,
      );

      const real = JSON.parse(realRes.raw) as Record<string, unknown>;
      if (real.status === "incomplete") {
        // Same inconclusive-probe rule as the streaming leg.
        ctx.skip(`real run ended incomplete (${JSON.stringify(real.incomplete_details ?? null)})`);
        return;
      }
      if (real.status === "failed" || (real.error !== undefined && real.error !== null)) {
        throw new Error(`real response ${String(real.status)}: ${JSON.stringify(real.error)}`);
      }
      // As in the streaming leg: drop the real `reasoning` item, which the mock
      // fixture does not define, so the report is about the tool item.
      const output = Array.isArray(real.output) ? real.output : [];
      const realToolOnly = { ...real, output: output.filter((i) => !isReasoningItem(i)) };
      expect(
        realToolOnly.output.some(
          (i) => typeof i === "object" && i !== null && (i as { type?: unknown }).type === itemType,
        ),
        `Real API output has no ${itemType} item despite tool_choice "required"; ` +
          `output types: ${JSON.stringify(output.map((i) => (i as { type?: unknown }).type))}`,
      ).toBe(true);

      const diffs = triangulate(
        sdkNonStreaming(),
        extractShape(realToolOnly),
        extractShape(JSON.parse(mockRes.body)),
      );
      const report = formatDriftReport(
        `OpenAI Responses (non-streaming ${name})`,
        diffs,
        "openai-responses",
      );

      expect(
        diffs.filter((d) => d.severity === "critical"),
        report,
      ).toEqual([]);
    },
  );
});

// ---------------------------------------------------------------------------
// Error shape validation (mock-only — no real API key needed)
// ---------------------------------------------------------------------------

/**
 * Expected error shape per OpenAI Responses API spec.
 * Ref: https://platform.openai.com/docs/api-reference/responses
 *
 * Real OpenAI errors include { error: { message, type, param, code } }.
 * aimock omits `param` (nullable in the spec) but must emit message, type, code.
 */
function openaiResponsesErrorShape() {
  return extractShape({
    error: {
      message: "Some error",
      type: "invalid_request_error",
      code: "some_code",
    },
  });
}

describe("OpenAI Responses API error shapes", () => {
  it("error fixture response has correct error shape", async () => {
    const errorFixture: Fixture = {
      match: { userMessage: "trigger error" },
      response: {
        error: {
          message: "Rate limited",
          type: "rate_limit_error",
          code: "rate_limit",
        },
        status: 429,
      },
    };

    const errorInstance = await createServer([errorFixture], {
      port: 0,
      chunkSize: 100,
    });

    try {
      const res = await httpPost(`${errorInstance.url}/v1/responses`, {
        model: "gpt-4o-mini",
        input: [{ role: "user", content: "trigger error" }],
        stream: false,
      });

      expect(res.status).toBe(429);

      const body = JSON.parse(res.body);
      const sdkShape = openaiResponsesErrorShape();
      const mockShape = extractShape(body);

      const diffs = triangulate(sdkShape, sdkShape, mockShape);
      const report = formatDriftReport(
        "OpenAI Responses (error fixture shape)",
        diffs,
        "openai-responses",
      );

      expect(
        diffs.filter((d) => d.severity === "critical"),
        report,
      ).toEqual([]);

      // Verify concrete values
      expect(body.error.message).toBe("Rate limited");
      expect(body.error.type).toBe("rate_limit_error");
      expect(body.error.code).toBe("rate_limit");
    } finally {
      await new Promise<void>((r) => errorInstance.server.close(() => r()));
    }
  });

  it("no-fixture-match error has correct error shape", async () => {
    const res = await httpPost(`${instance.url}/v1/responses`, {
      model: "gpt-4o-mini",
      input: [{ role: "user", content: "this will not match any fixture" }],
      stream: false,
    });

    expect(res.status).toBe(404);

    const body = JSON.parse(res.body);
    const sdkShape = openaiResponsesErrorShape();
    const mockShape = extractShape(body);

    const diffs = triangulate(sdkShape, sdkShape, mockShape);
    const report = formatDriftReport(
      "OpenAI Responses (no-fixture-match error shape)",
      diffs,
      "openai-responses",
    );

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);

    // Verify concrete values
    expect(body.error.message).toBe("No fixture matched");
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.code).toBe("no_fixture_match");
  });

  it("malformed request error has correct error shape", async () => {
    const res = await httpPostRaw(`${instance.url}/v1/responses`, "{not valid json");

    expect(res.status).toBe(400);

    const body = JSON.parse(res.body);
    const sdkShape = openaiResponsesErrorShape();
    const mockShape = extractShape(body);

    const diffs = triangulate(sdkShape, sdkShape, mockShape);
    const report = formatDriftReport(
      "OpenAI Responses (malformed request error shape)",
      diffs,
      "openai-responses",
    );

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);

    // Verify concrete values
    expect(body.error.message).toMatch(/^Malformed JSON/);
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.code).toBe("invalid_json");
  });
});

// ---------------------------------------------------------------------------
// Reasoning events (mock-only — no real API key needed)
// ---------------------------------------------------------------------------

describe("OpenAI Responses API reasoning drift", () => {
  const REASONING_TEXT = "Step by step, I will solve this problem.";
  const REASONING_FIXTURE: Fixture = {
    match: { userMessage: "Think carefully" },
    response: {
      content: "The answer is 42.",
      reasoning: REASONING_TEXT,
    },
  };

  let reasoningInstance: ServerInstance;

  beforeAll(async () => {
    reasoningInstance = await createServer([REASONING_FIXTURE], {
      port: 0,
      chunkSize: 100,
    });
  });

  afterAll(async () => {
    await new Promise<void>((r) => reasoningInstance.server.close(() => r()));
  });

  it("streaming reasoning events include delta and done", async () => {
    const res = await httpPost(`${reasoningInstance.url}/v1/responses`, {
      model: "gpt-4o-mini",
      input: [{ role: "user", content: "Think carefully" }],
      stream: true,
    });

    expect(res.status).toBe(200);

    const events = parseTypedSSE(res.body);
    expect(events.length, "Mock returned no SSE events").toBeGreaterThan(0);

    const eventTypes = events.map((e) => e.type);

    // reasoning_summary_text.delta and .done must be present
    expect(eventTypes, "missing reasoning_summary_text.delta").toContain(
      "response.reasoning_summary_text.delta",
    );
    expect(eventTypes, "missing reasoning_summary_text.done").toContain(
      "response.reasoning_summary_text.done",
    );

    // reasoning_summary_part.added and .done must be present
    expect(eventTypes, "missing reasoning_summary_part.added").toContain(
      "response.reasoning_summary_part.added",
    );
    expect(eventTypes, "missing reasoning_summary_part.done").toContain(
      "response.reasoning_summary_part.done",
    );

    // Reasoning output_item.added must have type: "reasoning"
    const reasoningAdded = events.find(
      (e) =>
        e.type === "response.output_item.added" &&
        (e.data as { item?: { type?: string } }).item?.type === "reasoning",
    );
    expect(reasoningAdded, "no output_item.added with type=reasoning").toBeDefined();
  });

  // NOTE: encrypted_content emission is ALSO enforced by the unit + WS suites
  // (responses.test.ts / ws-responses.test.ts), which hard-fail on a dropped,
  // null or empty blob and run in the ALWAYS-ON `pnpm test` lane (test-unit.yml
  // has no `paths:` filter). That lane — not this file — is what gates a PR that
  // touches src/responses.ts; `test-drift.yml`'s PR `paths:` filter deliberately
  // scopes the live PR leg to drift-grading code (see the comment on that
  // filter).
  //
  // The drift-side anchor is the shape pin in sdk-shapes.ts, split by opt-in:
  // `openaiResponsesReasoningEventShapes` (no blob) grades the opted-OUT legs,
  // `openaiResponsesEncryptedReasoningEventShapes` (blob) grades the opted-IN
  // leg below. Pinning the blob unconditionally made every opted-out leg report
  // `item.encrypted_content` critical forever — a finding that no code change
  // could clear, so it gated nothing.
  //
  // A SHAPE pin alone is not enough in either direction, so `gradeEncryptedBlob`
  // below adds the value-level grading. See its docstring for what shape
  // comparison structurally cannot see.

  it("reasoning event shapes include item_id, output_index, summary_index", async () => {
    const res = await httpPost(`${reasoningInstance.url}/v1/responses`, {
      model: "gpt-4o-mini",
      input: [{ role: "user", content: "Think carefully" }],
      stream: true,
    });

    expect(res.status).toBe(200);

    const events = parseTypedSSE(res.body);

    // Check delta event shape
    const deltaEvent = events.find((e) => e.type === "response.reasoning_summary_text.delta");
    expect(deltaEvent).toBeDefined();
    const deltaData = deltaEvent!.data as Record<string, unknown>;
    expect(deltaData).toHaveProperty("item_id");
    expect(deltaData).toHaveProperty("output_index", 0);
    expect(deltaData).toHaveProperty("summary_index", 0);
    expect(deltaData).toHaveProperty("delta");
    expect(typeof deltaData.item_id).toBe("string");
    expect(typeof deltaData.delta).toBe("string");

    // Check done event shape
    const doneEvent = events.find((e) => e.type === "response.reasoning_summary_text.done");
    expect(doneEvent).toBeDefined();
    const doneData = doneEvent!.data as Record<string, unknown>;
    expect(doneData).toHaveProperty("item_id");
    expect(doneData).toHaveProperty("output_index", 0);
    expect(doneData).toHaveProperty("summary_index", 0);
    expect(doneData).toHaveProperty("text", REASONING_TEXT);
    expect(typeof doneData.item_id).toBe("string");

    // item_id is consistent across reasoning events
    expect(deltaData.item_id).toBe(doneData.item_id);

    // Check part.added shape
    const partAdded = events.find((e) => e.type === "response.reasoning_summary_part.added");
    expect(partAdded).toBeDefined();
    const partAddedData = partAdded!.data as Record<string, unknown>;
    expect(partAddedData).toHaveProperty("item_id", deltaData.item_id);
    expect(partAddedData).toHaveProperty("output_index", 0);
    expect(partAddedData).toHaveProperty("summary_index", 0);
    expect(partAddedData).toHaveProperty("part");
    expect((partAddedData.part as { type: string }).type).toBe("summary_text");

    // Check part.done shape
    const partDone = events.find((e) => e.type === "response.reasoning_summary_part.done");
    expect(partDone).toBeDefined();
    const partDoneData = partDone!.data as Record<string, unknown>;
    expect(partDoneData).toHaveProperty("item_id", deltaData.item_id);
    expect(partDoneData).toHaveProperty("output_index", 0);
    expect(partDoneData).toHaveProperty("summary_index", 0);
    expect((partDoneData.part as { type: string; text: string }).text).toBe(REASONING_TEXT);
  });

  // DELTA-KEY ISOLATION. The collector derives each diff's delta `id` from its
  // `path` (`parseDriftBlock`: `id: path`) and `computeDelta` keys findings by
  // `provider::id` ONLY — `DriftEntry.scenario` rides along in the report but
  // NEVER enters the key. So two findings that differ only by scenario collapse
  // last-write-wins: verified against the real `computeDelta`, an opted-OUT
  // finding at `item.encrypted_content` sitting on the base report demotes a
  // NEW-in-head opted-IN finding at the same path from `block[]` to `advisory[]`
  // — i.e. it stops failing the required check. Prefixing every path this file
  // reports with its scenario + event type keeps the two legs' delta keys
  // disjoint without touching the shared delta machinery that every other drift
  // surface depends on.
  const scopePaths = (diffs: ShapeDiff[], prefix: string): ShapeDiff[] =>
    diffs.map((d) => ({ ...d, path: `${prefix}:${d.path}` }));

  // Grade a reasoning SSE body against the SDK shape variant for the request
  // that produced it. `scenario` keeps the opted-out and opted-in legs' drift
  // keys distinct so the delta gate attributes a finding to the right variant.
  //
  // Since reasoning is not available on gpt-4o-mini via real API, the SDK shape
  // is used as both "expected" and "real" for shape validation.
  const triangulateReasoningEvents = (
    sdkEvents: SSEEventShape[],
    body: string,
    scenario: string,
  ) => {
    const mockSSEShapes = parseTypedSSE(body).map((e) => ({
      type: e.type,
      dataShape: extractShape(e.data),
    }));

    for (const sdkEvent of sdkEvents) {
      const mockEvent = mockSSEShapes.find((m) => m.type === sdkEvent.type);
      if (!mockEvent) {
        expect.fail(`Mock missing reasoning event type: ${sdkEvent.type}`);
        continue;
      }

      const context = `${scenario}:${sdkEvent.type}`;
      const diffs = scopePaths(
        triangulate(sdkEvent.dataShape, sdkEvent.dataShape, mockEvent.dataShape),
        context,
      );
      const report = formatDriftReport(context, diffs, "openai-responses");

      expect(
        diffs.filter((d) => d.severity === "critical"),
        report,
      ).toEqual([]);
    }
  };

  /**
   * VALUE-level grading of the terminal reasoning item's `encrypted_content`.
   *
   * A shape pin structurally CANNOT see a degenerate value, in either direction
   * (all four cases below were reproduced locally against this suite):
   *
   *   - opted IN, `encrypted_content: null` → kind "null" vs the pin's "string",
   *     and schema.ts's real-vs-mock check deliberately exempts null-vs-other
   *     ("Allow null vs other type (optional fields)") → no diff, leg GREEN.
   *   - opted IN, `encrypted_content: ""`   → still kind "string" → no diff,
   *     leg GREEN.
   *   - opted OUT, blob present             → a field in mock but not in the pin
   *     grades `info` ("MOCK EXTRA FIELD"), and these legs fail only on
   *     `critical` → leg GREEN.
   *   - opted IN, blob absent               → the ONE case the shape pin does
   *     catch (critical).
   *
   * The blob is the payload agent-framework-openai >= 1.11.0 replays verbatim on
   * its stateless path (microsoft/agent-framework#7233), so a null or empty blob
   * is exactly as broken as an absent one, and a blob handed to a request that
   * never opted in is drift too.
   *
   * Emitted through `formatDriftReport` with the `openai-responses` surface
   * marker so a violation lands as a ROUTED drift finding (collector → exit 2 →
   * delta gate) instead of a bare `expect` failure the collector could only
   * quarantine (exit 5).
   */
  const gradeEncryptedBlob = (body: string, expectBlob: boolean, scenario: string) => {
    const label = expectBlob ? "opted-in" : "opted-out";
    const path = `${scenario}:response.output_item.done:item.encrypted_content(value)`;
    const diffs: ShapeDiff[] = [];

    const terminal = parseTypedSSE(body)
      .filter(
        (e) =>
          e.type === "response.output_item.done" &&
          (e.data as { item?: { type?: string } }).item?.type === "reasoning",
      )
      .at(-1);
    const item = terminal
      ? (terminal.data as { item: { encrypted_content?: unknown } }).item
      : undefined;

    if (item === undefined) {
      // Folded into the diff list (not a bare `expect`) so a missing terminal
      // item is a routed critical finding rather than a quarantined failure.
      diffs.push({
        path,
        severity: "critical",
        issue: "LLMOCK DRIFT — no terminal response.output_item.done with type=reasoning",
        expected: "reasoning item",
        real: "reasoning item",
        mock: "<absent>",
      });
    } else {
      const blob = item.encrypted_content;
      const observed = blob === undefined ? "<absent>" : JSON.stringify(blob);
      if (expectBlob && (typeof blob !== "string" || blob.length === 0)) {
        diffs.push({
          path,
          severity: "critical",
          issue:
            "LLMOCK DRIFT — opted-in request must carry a NON-EMPTY encrypted_content string " +
            "(agent-framework replays it verbatim; null/empty is as broken as absent)",
          expected: "non-empty string",
          real: "non-empty string",
          mock: observed,
        });
      } else if (!expectBlob && blob !== undefined) {
        diffs.push({
          path,
          severity: "critical",
          issue:
            "LLMOCK DRIFT — opted-out request must carry NO encrypted_content " +
            "(over-emission hands the blob to a consumer that never asked for it)",
          expected: "<absent>",
          real: "<absent>",
          mock: observed,
        });
      }
    }

    const report = formatDriftReport(
      `${scenario} (${label} encrypted_content value)`,
      diffs,
      "openai-responses",
    );

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  };

  it("reasoning event shapes triangulate against SDK expectations", async () => {
    // Opted OUT: no `include`, no `store: false` — the terminal item must carry
    // NO encrypted_content, so this leg is graded against the no-blob variant.
    const res = await httpPost(`${reasoningInstance.url}/v1/responses`, {
      model: "gpt-4o-mini",
      input: [{ role: "user", content: "Think carefully" }],
      stream: true,
    });

    expect(res.status).toBe(200);

    triangulateReasoningEvents(
      openaiResponsesReasoningEventShapes(),
      res.body,
      "OpenAI Responses Reasoning",
    );
    // Over-emission check: a blob here means the gate leaked it to a request
    // that never opted in. Invisible to the shape pin (grades `info`).
    gradeEncryptedBlob(res.body, false, "OpenAI Responses Reasoning");
  });

  it("opted-in reasoning event shapes carry a non-empty encrypted_content", async () => {
    // Opted IN via `include` — the exact request agent-framework-openai
    // >= 1.11.0 sends on its stateless-replay path. This is the leg that GATES
    // the emission: drop `encrypted_content` in responses.ts and the terminal
    // item reports `item.encrypted_content` critical here. The shape pin catches
    // ABSENCE; `gradeEncryptedBlob` catches null/empty, which the pin cannot.
    const res = await httpPost(`${reasoningInstance.url}/v1/responses`, {
      model: "gpt-4o-mini",
      input: [{ role: "user", content: "Think carefully" }],
      stream: true,
      include: ["reasoning.encrypted_content"],
    });

    expect(res.status).toBe(200);

    triangulateReasoningEvents(
      openaiResponsesEncryptedReasoningEventShapes(),
      res.body,
      "OpenAI Responses Encrypted Reasoning",
    );
    gradeEncryptedBlob(res.body, true, "OpenAI Responses Encrypted Reasoning");
  });
});
