/**
 * OpenAI Responses API drift tests.
 *
 * Three-way comparison: SDK types × real API × aimock output.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
