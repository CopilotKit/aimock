/**
 * OpenRouter chat/LLM-router drift tests (surface: `openrouter-chat`).
 *
 * The OpenRouter chat shaping (`src/openrouter-chat.ts`) — which re-shapes the
 * OpenAI-compatible chat response emitted on the OpenRouter `/api/v1/` base with
 * OpenRouter's distinguishing fields (a `gen-` id, a top-level `provider`,
 * per-choice `native_finish_reason`, cost-bearing `usage` with `cost_details`,
 * and an always-present `system_fingerprint`/`service_tier`) — is SHIPPED on
 * master but had ZERO drift coverage. This file covers:
 *
 *   1. LIVE canary (FREE) — authenticate with `OPENROUTER_API_KEY` and hit the
 *      public model CATALOG (`GET /api/v1/models`), asserting the author
 *      FAMILIES aimock's chat shaping mirrors are still present and that the
 *      per-model object schema has not drifted. Metadata-only; NO completion.
 *      Gated on the key (skips locally; runs in CI where the secret exists).
 *
 *   2. Envelope shapes (STATIC, no key, no completion) — drive the aimock
 *      server over HTTP on the OpenRouter base (`POST /api/v1/chat/completions`)
 *      and triangulate the OpenRouter chat response envelopes the mock emits
 *      (non-streaming, a streaming chunk, the final usage-bearing chunk, the
 *      OpenRouter error envelope `{error:{code,message}}`, and the model
 *      catalog) against hand-authored conformant exemplars via the documented
 *      static `triangulate(sdkShape, sdkShape, mockShape)` form. This exercises
 *      the REAL handler + shaping + collector routing path, not a unit fake.
 *
 *   3. K9 reasoning exhaustion — OPENROUTER_API_KEY enables ONE PAID streaming
 *      completion: pinned DeepSeek R1/Novita, 16 output tokens requested,
 *      retries disabled, 45 seconds and 256 KiB maximum. Provider parameter
 *      support does not guarantee budget enforcement. An explicit
 *      OPENROUTER_K9_CAPTURE plus OPENROUTER_K9_CAPTURE_SHA256 instead replays
 *      an authenticated complete capture; that run is labeled capture replay.
 *
 * The static envelope/catalog shapes assert the shape the mock is CONTRACTED to
 * emit (mock-vs-exemplar, mirroring openrouter-video.drift.ts) — the live canary
 * above is what catches provider-side catalog/family drift.
 */

import http from "node:http";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type ServerInstance } from "../../server.js";
import { LLMock } from "../../llmock.js";
import type { Fixture, SSEChunk } from "../../types.js";
import { extractShape, triangulate, formatDriftReport } from "./schema.js";
import { httpPost, parseDataOnlySSE } from "./helpers.js";
import { listOpenRouterModels } from "./providers.js";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// A provider-prefixed slug drives the mock's `deriveOpenRouterProvider`
// (author segment before `/`) so the top-level `provider` is deterministic.
const OPENROUTER_CHAT_MODEL = "openai/gpt-4o";

const K9_CAPTURE = process.env.OPENROUTER_K9_CAPTURE;
const K9_REQUEST = {
  model: "deepseek/deepseek-r1",
  messages: [
    {
      role: "user",
      content:
        "Find the smallest positive integer n such that n mod 17 = 8, n mod 19 = 11, and n mod 23 = 15. Work through the calculation carefully.",
    },
  ],
  max_tokens: 16,
  reasoning: { enabled: true },
  stream: true,
  stream_options: { include_usage: true },
  provider: { order: ["novita/fp8"], allow_fallbacks: false, require_parameters: true },
};

// JSON is deliberately inspected independently of SDK stream decoding: [DONE],
// every choice, and the usage event must all survive on the actual wire.
function inspectK9Stream(raw: string) {
  const blocks = raw.replace(/\r\n/g, "\n").split("\n\n");
  // EOF does not dispatch pending SSE data. Only comments may remain after
  // the last blank-line separator, including after the DONE event.
  const pending = blocks.pop() ?? "";
  expect(
    pending.split("\n").every((line) => !line || line.startsWith(":")),
    "Unterminated SSE data event",
  ).toBe(true);
  const frames = blocks.flatMap((block) => {
    const lines = block.split("\n").filter((line) => line && !line.startsWith(":"));
    if (lines.length === 0) return [];
    expect(
      lines.every((line) => line.startsWith("data:")),
      "Malformed SSE frame",
    ).toBe(true);
    return [lines.map((line) => line.slice(5).replace(/^ /, "")).join("\n")];
  });
  expect(frames.at(-1), "K9 must end with [DONE]").toBe("[DONE]");
  expect(frames.filter((frame) => frame === "[DONE]")).toHaveLength(1);
  let reasoning = "";
  let terminated = false;
  let hasUsage = false;
  for (const frame of frames.slice(0, -1)) {
    const chunk: SSEChunk = JSON.parse(frame);
    expect(chunk.object).toBe("chat.completion.chunk");
    expect(chunk.model).toBe(K9_REQUEST.model);
    expect(Array.isArray(chunk.choices)).toBe(true);
    for (const choice of chunk.choices) {
      expect(choice.index).toBe(0);
      const delta = choice.delta;
      expect([undefined, null, ""]).toContain(delta.content);
      expect(delta).not.toHaveProperty("tool_calls");
      expect(delta).not.toHaveProperty("reasoning_content");
      if (typeof delta.reasoning === "string" && delta.reasoning.length > 0) {
        expect(terminated, "Reasoning after length termination").toBe(false);
        expect(delta.role).toBe("assistant");
        expect(delta.content).toBe("");
        expect(delta.reasoning_details).toEqual([
          { type: "reasoning.text", text: delta.reasoning, format: "unknown", index: 0 },
        ]);
        reasoning += delta.reasoning;
      } else {
        // Real OpenRouter sends reasoning:null in its length terminal. An
        // optional role opener and an empty terminal delta are also valid.
        expect([undefined, null, ""]).toContain(delta.reasoning);
        expect(delta.reasoning_details ?? []).toEqual([]);
      }
      if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
        expect(choice.finish_reason).toBe("length");
        terminated = true;
      }
      if (choice.native_finish_reason !== null && choice.native_finish_reason !== undefined)
        expect(choice.native_finish_reason).toBe("length");
    }
    if (chunk.usage !== undefined) {
      expect(terminated, "Usage must follow or accompany length").toBe(true);
      expect(hasUsage, "Duplicate usage").toBe(false);
      for (const count of [
        chunk.usage.prompt_tokens,
        chunk.usage.completion_tokens,
        chunk.usage.total_tokens,
      ]) {
        expect(Number.isInteger(count)).toBe(true);
        expect(count).toBeGreaterThanOrEqual(0);
      }
      hasUsage = true;
    }
  }
  expect(reasoning.length, "K9 requires exposed reasoning").toBeGreaterThan(0);
  expect(terminated, "Missing length terminal").toBe(true);
  expect(hasUsage, "Missing requested usage").toBe(true);
  return reasoning;
}

async function localK9Stream(reasoning: string) {
  const mock = new LLMock({ port: 0, chunkSize: 11, logLevel: "silent" });
  mock.addFixture({
    match: { userMessage: K9_REQUEST.messages[0].content, model: K9_REQUEST.model },
    response: { content: "This answer must be suppressed." },
    misbehavior: { faults: [{ fault: "reasoning-only", reasoning }] },
  });
  const url = await mock.start();
  try {
    const response = await httpPost(`${url}/api/v1/chat/completions`, K9_REQUEST);
    expect(response.status, response.body).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    return response.body;
  } finally {
    await mock.stop();
  }
}

async function realK9Stream() {
  if (K9_CAPTURE) {
    const bytes = await readFile(K9_CAPTURE);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      process.env.OPENROUTER_K9_CAPTURE_SHA256,
    );
    const capture: {
      request: typeof K9_REQUEST;
      response_status: number;
      response_content_type: string;
      transport_completed: boolean;
      capture_error?: string;
      raw_response: string;
    } = JSON.parse(bytes.toString());
    expect(capture.request).toEqual(K9_REQUEST);
    expect(capture.response_status).toBe(200);
    expect(capture.response_content_type).toContain("text/event-stream");
    expect(capture.transport_completed).toBe(true);
    expect(capture.capture_error).toBeUndefined();
    console.log(
      JSON.stringify({
        k9: "provider capture replay",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        request: capture.request,
        raw: capture.raw_response,
      }),
    );
    return capture.raw_response;
  }
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 45_000);
  let raw = "";
  let status: number | undefined;
  let completed = false;
  try {
    // Native fetch has no automatic retry. Credential presence explicitly
    // enables this paid daily drift leg; no static fallback on provider errors.
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(K9_REQUEST),
      signal: controller.signal,
    });
    status = response.status;
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    if (!response.body) throw new Error("OpenRouter returned no response body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > 262_144) throw new Error("OpenRouter K9 exceeded 256 KiB");
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
        k9: "live paid provider",
        request: K9_REQUEST,
        status,
        completed,
        raw: OPENROUTER_API_KEY ? raw.replaceAll(OPENROUTER_API_KEY, "[REDACTED]") : raw,
      }),
    );
  }
}

describe("OpenRouter K9 reasoning exhaustion", () => {
  it("local wire preserves reasoning/details and clean length/usage/DONE semantics", async () => {
    const reasoning = "Work through the arithmetic before giving an answer.";
    const raw = await localK9Stream(reasoning);
    console.log(JSON.stringify({ k9: "local", request: K9_REQUEST, raw }));
    expect(inspectK9Stream(raw)).toBe(reasoning);
    // Sensitivity checks mutate actual localhost bytes, not product code.
    expect(() => inspectK9Stream(raw.replace(/\n\n$/, ""))).toThrow();
    expect(inspectK9Stream(raw.replaceAll("\n", "\r\n") + ": final comment")).toBe(reasoning);
    expect(() => inspectK9Stream(raw.replace("data: [DONE]", ""))).toThrow();
    expect(() =>
      inspectK9Stream(raw.replaceAll('"finish_reason":"length"', '"finish_reason":"stop"')),
    ).toThrow();
    expect(() =>
      inspectK9Stream(raw.replaceAll('"reasoning_details":', '"reasoning_content":')),
    ).toThrow();
    const withoutUsage = raw
      .split("\n\n")
      .filter((block) => !block.includes('"usage":'))
      .join("\n\n");
    expect(() => inspectK9Stream(withoutUsage)).toThrow();
    const payload = raw.split("\n\n").find((block) => block.includes('"reasoning_details":'));
    expect(payload).toBeDefined();
    expect(() =>
      inspectK9Stream(raw.replace("data: [DONE]", `${payload}\n\ndata: [DONE]`)),
    ).toThrow();
    expect(() =>
      inspectK9Stream(raw.replaceAll('"format":"unknown"', '"format":"broken"')),
    ).toThrow();
  });

  it.skipIf(!OPENROUTER_API_KEY && !K9_CAPTURE)(
    K9_CAPTURE
      ? "complete provider capture agrees with actual localhost K9"
      : "paid live provider agrees with actual localhost K9",
    async () => {
      const raw = await realK9Stream();
      const reasoning = inspectK9Stream(raw);
      const local = await localK9Stream(reasoning);
      console.log(JSON.stringify({ k9: "local compared with provider", raw: local }));
      expect(inspectK9Stream(local)).toBe(reasoning);
    },
  );
});

// ---------------------------------------------------------------------------
// HTTP GET helper (drift helpers.ts only exports httpPost — mirror video.drift.ts)
// ---------------------------------------------------------------------------

async function httpGet(
  url: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode!,
          headers: res.headers,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Fixtures — a chat turn that supplies a `cost` so the shaping emits the
// cost-bearing `usage` (`cost` + `cost_details`) and a pinned
// `systemFingerprint`. Matched on the OpenRouter base by `POST
// /api/v1/chat/completions`; the `/api/v1/` prefix is what marks the request
// OpenRouter (isOpenRouterPath), triggering shapeOpenRouterCompletion.
// ---------------------------------------------------------------------------

const CHAT_FIXTURE: Fixture = {
  match: { userMessage: "Say hello", model: OPENROUTER_CHAT_MODEL },
  response: {
    content: "Hello!",
    systemFingerprint: "fp_openrouter_mock",
    usage: { cost: 0.0012, prompt_tokens: 10, completion_tokens: 5 },
  },
};

// ---------------------------------------------------------------------------
// Expected envelope shapes (hand-authored conformant exemplars — mirrors the
// sdk-shapes.ts "minimal conformant instance" philosophy). These describe the
// OpenRouter chat bytes openrouter-chat.ts is CONTRACTED to emit.
// ---------------------------------------------------------------------------

/**
 * Non-streaming OpenRouter completion: OpenAI chat.completion envelope PLUS the
 * OpenRouter distinguishing fields — top-level `provider`, per-choice
 * `native_finish_reason`, `message.reasoning`, cost-bearing `usage`
 * (`cost` + `cost_details`), and always-present `system_fingerprint` /
 * `service_tier`.
 */
function nonStreamEnvelopeShape() {
  return extractShape({
    id: "gen-abc123",
    object: "chat.completion",
    created: 1700000000,
    model: OPENROUTER_CHAT_MODEL,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "Hello!",
          refusal: null,
          reasoning: null,
        },
        logprobs: null,
        finish_reason: "stop",
        native_finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      cost: 0.0012,
      cost_details: {
        upstream_inference_cost: 0,
        upstream_inference_prompt_cost: 0,
        upstream_inference_completions_cost: 0,
      },
    },
    system_fingerprint: "fp_openrouter_mock",
    provider: "openai",
    service_tier: null,
  });
}

/**
 * A content-bearing streaming chunk: every chunk carries the `gen-` id,
 * top-level `provider`, `system_fingerprint`, and a per-choice
 * `native_finish_reason` (null until finish); the delta repeats
 * `role: "assistant"` on content deltas.
 */
function streamChunkShape() {
  return extractShape({
    id: "gen-abc123",
    object: "chat.completion.chunk",
    created: 1700000000,
    model: OPENROUTER_CHAT_MODEL,
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: "" },
        logprobs: null,
        finish_reason: null,
        native_finish_reason: null,
      },
    ],
    system_fingerprint: "fp_openrouter_mock",
    provider: "openai",
  });
}

/**
 * The final usage-bearing streaming chunk: an empty `choices` array plus the
 * cost-bearing `usage`, `provider`, `system_fingerprint`, and
 * `service_tier: null`.
 */
function streamUsageChunkShape() {
  return extractShape({
    id: "gen-abc123",
    object: "chat.completion.chunk",
    created: 1700000000,
    model: OPENROUTER_CHAT_MODEL,
    choices: [],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      cost: 0.0012,
      cost_details: {
        upstream_inference_cost: 0,
        upstream_inference_prompt_cost: 0,
        upstream_inference_completions_cost: 0,
      },
    },
    system_fingerprint: "fp_openrouter_mock",
    provider: "openai",
    service_tier: null,
  });
}

/**
 * OpenRouter error envelope: `{ error: { code, message } }` where `code` is the
 * HTTP status NUMBER (contrast OpenAI's `{ error: { message, type, param, code
 * } }`).
 */
function errorEnvelopeShape() {
  return extractShape({
    error: { code: 404, message: "No fixture matched" },
  });
}

/**
 * A per-model catalog entry (`GET /api/v1/models` → `{ data: [...] }`). Mirrors
 * openRouterModelObject in src/openrouter-chat.ts.
 */
function modelObjectShape() {
  return extractShape({
    id: OPENROUTER_CHAT_MODEL,
    canonical_slug: OPENROUTER_CHAT_MODEL,
    hugging_face_id: null,
    name: OPENROUTER_CHAT_MODEL,
    created: 0,
    description: "Mock OpenRouter model served by aimock.",
    context_length: 128000,
    architecture: {
      modality: "text->text",
      input_modalities: ["text"],
      output_modalities: ["text"],
      tokenizer: "Other",
      instruct_type: null,
    },
    pricing: {
      prompt: "0",
      completion: "0",
      request: "0",
      image: "0",
      web_search: "0",
      internal_reasoning: "0",
      input_cache_read: "0",
      input_cache_write: "0",
    },
    top_provider: {
      context_length: 128000,
      max_completion_tokens: 16384,
      is_moderated: false,
    },
    per_request_limits: null,
    supported_parameters: ["tools", "tool_choice", "max_tokens"],
    default_parameters: null,
    supported_voices: null,
    knowledge_cutoff: null,
    expiration_date: null,
    links: { details: "/api/v1/models/x/endpoints" },
    reasoning: { mandatory: false, default_enabled: false },
  });
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let instance: ServerInstance;

beforeAll(async () => {
  instance = await createServer([CHAT_FIXTURE], { port: 0, chunkSize: 100 });
});

afterAll(async () => {
  await new Promise<void>((r) => instance.server.close(() => r()));
});

// ---------------------------------------------------------------------------
// Envelope-shape drift (STATIC — no key, runs in CI)
// ---------------------------------------------------------------------------

describe("OpenRouter chat envelope shapes", () => {
  it("non-streaming returns the OpenRouter-shaped chat.completion envelope", async () => {
    const res = await httpPost(`${instance.url}/api/v1/chat/completions`, {
      model: OPENROUTER_CHAT_MODEL,
      messages: [{ role: "user", content: "Say hello" }],
      stream: false,
    });

    expect(res.status, res.body).toBe(200);
    const body = JSON.parse(res.body);

    // ── Structural assertions on the OpenRouter distinguishing fields ──────
    expect(body.id, "OpenRouter id must carry the gen- prefix").toMatch(/^gen-/);
    expect(body.object).toBe("chat.completion");
    expect(body.provider).toBe("openai");
    expect(body.service_tier).toBeNull();
    // VALUE assertion (not existence-only): system_fingerprint is allowlisted in
    // triangulate, so verify the fixture-pinned value actually propagates.
    expect(body.system_fingerprint).toBe("fp_openrouter_mock");
    expect(body.choices[0].native_finish_reason).toBe("stop");
    expect(body.choices[0].message.content).toBe("Hello!");
    expect(body.choices[0].message).toHaveProperty("reasoning");
    expect(body.usage.cost).toBe(0.0012);
    expect(body.usage.cost_details).toMatchObject({
      upstream_inference_cost: 0,
      upstream_inference_prompt_cost: 0,
      upstream_inference_completions_cost: 0,
    });

    const sdkShape = nonStreamEnvelopeShape();
    const mockShape = extractShape(body);
    const diffs = triangulate(sdkShape, sdkShape, mockShape);
    const report = formatDriftReport("OpenRouter chat (non-streaming)", diffs, "openrouter-chat");

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("streaming content chunk carries provider, gen- id, and native_finish_reason", async () => {
    const res = await httpPost(`${instance.url}/api/v1/chat/completions`, {
      model: OPENROUTER_CHAT_MODEL,
      messages: [{ role: "user", content: "Say hello" }],
      stream: true,
    });

    expect(res.status, res.body).toBe(200);
    const chunks = parseDataOnlySSE(res.body) as Array<Record<string, unknown>>;
    expect(chunks.length, "Mock returned no SSE chunks").toBeGreaterThan(0);

    const firstChunk = chunks[0];
    expect(firstChunk.object).toBe("chat.completion.chunk");
    expect(String(firstChunk.id)).toMatch(/^gen-/);
    expect(firstChunk.provider).toBe("openai");
    // VALUE assertion (system_fingerprint is allowlisted in triangulate).
    expect(firstChunk.system_fingerprint).toBe("fp_openrouter_mock");
    const firstChoice = (firstChunk.choices as Array<Record<string, unknown>>)[0];
    // VALUE assertion: content chunks pin native_finish_reason null (mirrors the
    // non-streaming leg's toBe("stop") rigor).
    expect(firstChoice.native_finish_reason).toBeNull();

    const sdkShape = streamChunkShape();
    const mockShape = extractShape(firstChunk);
    const diffs = triangulate(sdkShape, sdkShape, mockShape);
    const report = formatDriftReport(
      "OpenRouter chat (streaming content chunk)",
      diffs,
      "openrouter-chat",
    );

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("final streaming chunk carries cost-bearing usage and service_tier", async () => {
    const res = await httpPost(`${instance.url}/api/v1/chat/completions`, {
      model: OPENROUTER_CHAT_MODEL,
      messages: [{ role: "user", content: "Say hello" }],
      stream: true,
      stream_options: { include_usage: true },
    });

    expect(res.status, res.body).toBe(200);
    const chunks = parseDataOnlySSE(res.body) as Array<Record<string, unknown>>;
    const usageChunk = chunks.find((c) => c.usage !== undefined);
    expect(usageChunk, "No usage-bearing chunk emitted").toBeDefined();

    const usage = usageChunk!.usage as Record<string, unknown>;
    expect(usage.cost).toBe(0.0012);
    expect(usage.cost_details).toMatchObject({
      upstream_inference_cost: 0,
      upstream_inference_prompt_cost: 0,
      upstream_inference_completions_cost: 0,
    });
    expect(usageChunk!.service_tier).toBeNull();
    expect(usageChunk!.provider).toBe("openai");
    // VALUE assertion (system_fingerprint is allowlisted in triangulate).
    expect(usageChunk!.system_fingerprint).toBe("fp_openrouter_mock");

    const sdkShape = streamUsageChunkShape();
    const mockShape = extractShape(usageChunk);
    const diffs = triangulate(sdkShape, sdkShape, mockShape);
    const report = formatDriftReport(
      "OpenRouter chat (final usage chunk)",
      diffs,
      "openrouter-chat",
    );

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("error envelope is { error: { code: number, message } }", async () => {
    // Empty fixtures — any request 404s with the OpenRouter error envelope.
    const emptyInstance = await createServer([], { port: 0, chunkSize: 100 });

    try {
      const res = await httpPost(`${emptyInstance.url}/api/v1/chat/completions`, {
        model: OPENROUTER_CHAT_MODEL,
        messages: [{ role: "user", content: "no fixture will match this" }],
        stream: false,
      });

      expect(res.status).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error).toBeDefined();
      expect(typeof body.error.code, "OpenRouter error code is the HTTP status NUMBER").toBe(
        "number",
      );
      expect(body.error.code).toBe(404);
      expect(typeof body.error.message).toBe("string");

      const sdkShape = errorEnvelopeShape();
      const mockShape = extractShape(body);
      const diffs = triangulate(sdkShape, sdkShape, mockShape);
      const report = formatDriftReport(
        "OpenRouter chat (error envelope)",
        diffs,
        "openrouter-chat",
      );

      expect(
        diffs.filter((d) => d.severity === "critical"),
        report,
      ).toEqual([]);
    } finally {
      await new Promise<void>((r) => emptyInstance.server.close(() => r()));
    }
  });

  it("model catalog returns { data: [ { id, pricing, architecture, ... } ] }", async () => {
    const res = await httpGet(`${instance.url}/api/v1/models`);

    expect(res.status, res.body).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);

    const sdkShape = modelObjectShape();
    const mockShape = extractShape(body.data[0]);
    const diffs = triangulate(sdkShape, sdkShape, mockShape);
    const report = formatDriftReport("OpenRouter chat (model catalog)", diffs, "openrouter-chat");

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// LIVE model-catalog canary (FREE — metadata only, NO completion).
// Gated on OPENROUTER_API_KEY: skips locally; runs in CI where the secret exists.
// ---------------------------------------------------------------------------

/**
 * Reduce an OpenRouter chat-model slug to its AUTHOR family: the segment before
 * the first `/` (`openai/gpt-4o` → `openai`, `anthropic/claude-3.5-sonnet` →
 * `anthropic`). This is exactly the segment aimock's `deriveOpenRouterProvider`
 * uses for the top-level `provider`, so a missing author family means aimock is
 * mirroring an author/provider the catalog no longer advertises.
 */
export function openRouterChatFamily(id: string): string {
  const slash = id.indexOf("/");
  return (slash === -1 ? id : id.slice(0, slash)).toLowerCase();
}

// The author families aimock's OpenRouter chat shaping defaults to (see
// DEFAULT_OPENROUTER_MODELS in src/openrouter-chat.ts: openai/gpt-4o,
// anthropic/claude-3.5-sonnet, google/gemini-2.0-flash-001) and derives the
// top-level `provider` from. A missing family means the catalog contract moved.
const REQUIRED_CHAT_FAMILIES = ["openai", "anthropic", "google"] as const;

/**
 * Core per-model fields the mock's openRouterModelObject synthesizes and real
 * clients depend on. Used to triangulate the LIVE catalog object schema —
 * extras on either side are info-level; a removed core field or a type change
 * (e.g. pricing strings → numbers) is CRITICAL.
 */
function liveModelCoreShape() {
  return extractShape({
    id: "openai/gpt-4o",
    name: "openai/gpt-4o",
    context_length: 128000,
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    pricing: { prompt: "0", completion: "0" },
    top_provider: { context_length: 128000 },
    supported_parameters: ["tools"],
  });
}

describe.skipIf(!OPENROUTER_API_KEY)("OpenRouter chat catalog availability (live)", () => {
  it("live /api/v1/models contains the author families aimock mirrors", async () => {
    const models = await listOpenRouterModels(OPENROUTER_API_KEY!);
    expect(models.length, "OpenRouter returned an empty model catalog").toBeGreaterThan(0);

    const families = new Set(models.map((m) => openRouterChatFamily(m.id)));
    const missing = REQUIRED_CHAT_FAMILIES.filter((f) => !families.has(f));

    const report =
      missing.length > 0
        ? formatDriftReport(
            "OpenRouter chat (live /api/v1/models family canary)",
            missing.map((family) => ({
              path: `models/${family}`,
              severity: "critical" as const,
              issue:
                `aimock's OpenRouter chat shaping mirrors the "${family}" author family, but the ` +
                `live /api/v1/models catalog no longer contains it — update ` +
                `DEFAULT_OPENROUTER_MODELS in src/openrouter-chat.ts`,
              expected: `(family "${family}" present in live catalog)`,
              real: [...families].sort().join(", "),
              mock: family,
            })),
            "openrouter-chat",
          )
        : "No drift detected: OpenRouter chat family canary";

    expect(missing, report).toEqual([]);
  });

  it("live model-object schema still carries the core fields aimock synthesizes", async () => {
    const models = await listOpenRouterModels(OPENROUTER_API_KEY!);
    expect(models.length, "OpenRouter returned an empty model catalog").toBeGreaterThan(0);
    // Prefer a model whose author is one aimock mirrors, for a representative
    // object; fall back to the first entry.
    const sample =
      models.find((m) =>
        (REQUIRED_CHAT_FAMILIES as readonly string[]).includes(openRouterChatFamily(m.id)),
      ) ?? models[0];

    const coreShape = liveModelCoreShape();
    const liveShape = extractShape(sample);
    const diffs = triangulate(coreShape, coreShape, liveShape);
    const report = formatDriftReport(
      `OpenRouter chat (live model-object schema: ${sample.id})`,
      diffs,
      "openrouter-chat",
    );

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });
});
