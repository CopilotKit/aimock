/**
 * OpenAI Responses API drift tests.
 *
 * Three-way comparison: SDK types × real API × aimock output.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type ServerInstance } from "../../server.js";
import type { Fixture } from "../../types.js";
import { extractShape, triangulate, compareSSESequences, formatDriftReport } from "./schema.js";
import {
  openaiResponsesNonStreamingShape,
  openaiResponsesTextEventShapes,
  openaiResponsesToolCallEventShapes,
  openaiResponsesReasoningEventShapes,
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

/** Maps OpenAI's `/v1/models` listing shape onto {@link LiveModelEntry}. */
export async function fetchOpenAIModelsListing(): Promise<{
  status: number;
  models: LiveModelEntry[];
}> {
  const res = await fetch(OPENAI_MODELS_URL, {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
  });
  const raw = await res.text();
  if (res.status >= 400) return { status: res.status, models: [] };
  let json: { data?: { id: string }[] };
  try {
    json = JSON.parse(raw) as { data?: { id: string }[] };
  } catch {
    return { status: res.status, models: [] };
  }
  return { status: res.status, models: (json.data ?? []).map((m) => ({ id: m.id })) };
}

/** Memoized (per providers.ts `resolveLiveModel`) so this file makes one listing call. */
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

  // NOTE: encrypted_content emission is enforced by the unit + WS suites
  // (responses.test.ts / ws-responses.test.ts), which run in CI and fail on a
  // dropped blob. A local-server assertion here would not add coverage (this
  // block posts to a local aimock, not api.openai.com, and drift `expect`
  // failures are report-collected rather than hard-failing). The live spec
  // anchor lives in sdk-shapes.ts (`openaiResponsesReasoningEventShapes` pins
  // encrypted_content on the terminal item) for the triangulated legs above.

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

  it("reasoning event shapes triangulate against SDK expectations", async () => {
    const sdkEvents = openaiResponsesReasoningEventShapes();

    const res = await httpPost(`${reasoningInstance.url}/v1/responses`, {
      model: "gpt-4o-mini",
      input: [{ role: "user", content: "Think carefully" }],
      stream: true,
    });

    expect(res.status).toBe(200);

    const mockEvents = parseTypedSSE(res.body);
    const mockSSEShapes = mockEvents.map((e) => ({
      type: e.type,
      dataShape: extractShape(e.data),
    }));

    // Triangulate reasoning-specific events against SDK shapes.
    // Since reasoning is not available on gpt-4o-mini via real API, we
    // use SDK shapes as both "expected" and "real" for shape validation.
    for (const sdkEvent of sdkEvents) {
      const mockEvent = mockSSEShapes.find((m) => m.type === sdkEvent.type);
      if (!mockEvent) {
        expect.fail(`Mock missing reasoning event type: ${sdkEvent.type}`);
        continue;
      }

      const diffs = triangulate(sdkEvent.dataShape, sdkEvent.dataShape, mockEvent.dataShape);
      const report = formatDriftReport(
        `OpenAI Responses Reasoning:${sdkEvent.type}`,
        diffs,
        "openai-responses",
      );

      expect(
        diffs.filter((d) => d.severity === "critical"),
        report,
      ).toEqual([]);
    }
  });
});
