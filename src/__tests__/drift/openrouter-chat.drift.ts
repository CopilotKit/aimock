/**
 * OpenRouter chat/LLM-router drift tests (surface: `openrouter-chat`).
 *
 * The OpenRouter chat shaping (`src/openrouter-chat.ts`) — which re-shapes the
 * OpenAI-compatible chat response emitted on the OpenRouter `/api/v1/` base with
 * OpenRouter's distinguishing fields (a `gen-` id, a top-level `provider`,
 * per-choice `native_finish_reason`, cost-bearing `usage` with `cost_details`,
 * and an always-present `system_fingerprint`/`service_tier`) — is SHIPPED on
 * master but had ZERO drift coverage. This leg closes that gap COST-SAFELY —
 * a real chat completion costs money per token, so NOTHING here submits a paid
 * completion:
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
 * The static envelope/catalog shapes assert the shape the mock is CONTRACTED to
 * emit (mock-vs-exemplar, mirroring openrouter-video.drift.ts) — the live canary
 * above is what catches provider-side catalog/family drift.
 */

import http from "node:http";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type ServerInstance } from "../../server.js";
import type { Fixture } from "../../types.js";
import { extractShape, triangulate, formatDriftReport } from "./schema.js";
import { httpPost, parseDataOnlySSE } from "./helpers.js";
import { listOpenRouterModels } from "./providers.js";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// A provider-prefixed slug drives the mock's `deriveOpenRouterProvider`
// (author segment before `/`) so the top-level `provider` is deterministic.
const OPENROUTER_CHAT_MODEL = "openai/gpt-4o";

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
