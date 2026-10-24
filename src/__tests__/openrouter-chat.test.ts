import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type ServerInstance } from "../server.js";
import { loadFixtureFile, validateFixtures } from "../fixture-loader.js";
import type { Fixture, SSEChunk, FixtureBlock } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function httpPost(
  url: string,
  body: object,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      { method: "POST", headers: { "Content-Type": "application/json", ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      { method: "GET", headers: { authorization: "Bearer sk-test" } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Split an SSE body into data-frame JSON objects (skips comments + [DONE]). */
function parseSSE(body: string): SSEChunk[] {
  return body
    .split("\n\n")
    .map((block) => block.split("\n").find((l) => l.startsWith("data: ")))
    .filter((l): l is string => !!l && !l.includes("[DONE]"))
    .map((l) => JSON.parse(l.slice(6)));
}

const OR = "/api/v1/chat/completions";
const OAI = "/v1/chat/completions";

let instance: ServerInstance | null = null;
afterEach(async () => {
  if (instance) {
    await new Promise<void>((resolve) => instance!.server.close(() => resolve()));
    instance = null;
  }
});

// ---------------------------------------------------------------------------
// Detection + non-streaming shaping
// ---------------------------------------------------------------------------

describe("OpenRouter chat: non-streaming shaping", () => {
  it("shapes gen- id, top-level provider, native_finish_reason, and cost-bearing usage", async () => {
    const fixtures: Fixture[] = [
      { match: { userMessage: "hi" }, response: { content: "hello", usage: { cost: 0.0042 } } },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}${OR}`, {
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    });
    const json = JSON.parse(res.body);
    expect(res.status).toBe(200);
    expect(json.id.startsWith("gen-")).toBe(true);
    expect(json.provider).toBe("openai");
    expect(json.choices[0].finish_reason).toBe("stop");
    expect(json.choices[0].native_finish_reason).toBe("stop");
    expect(json.usage.cost).toBe(0.0042);
    // cost_details, when emitted, carries all three upstream fields (a partial
    // object throws in the canonical @openrouter/sdk).
    expect(json.usage.cost_details).toEqual({
      upstream_inference_cost: 0,
      upstream_inference_prompt_cost: 0,
      upstream_inference_completions_cost: 0,
    });
    // Detail breakdowns / is_byok are NOT present unless overridden.
    expect(json.usage.prompt_tokens_details).toBeUndefined();
    expect(json.usage.completion_tokens_details).toBeUndefined();
    expect(json.usage.is_byok).toBeUndefined();
    // system_fingerprint + service_tier are always emitted (nullable) on the
    // non-streaming response — the canonical @openrouter/sdk requires them.
    expect(json).toHaveProperty("system_fingerprint");
    expect(json.system_fingerprint).toBeNull();
    expect(json.service_tier).toBeNull();
    // message carries refusal:null and reasoning:null (real-byte fidelity).
    expect(json.choices[0].message.refusal).toBeNull();
    expect(json.choices[0].message.reasoning).toBeNull();
  });

  it("omits cost/cost_details when the fixture supplies no cost (nullable, never defaulted to 0)", async () => {
    const fixtures: Fixture[] = [{ match: { userMessage: "hi" }, response: { content: "hello" } }];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}${OR}`, {
      model: "anthropic/claude-3.5-sonnet",
      messages: [{ role: "user", content: "hi" }],
    });
    const json = JSON.parse(res.body);
    expect(json.usage.cost).toBeUndefined();
    expect(json.usage.cost_details).toBeUndefined();
    expect(json.provider).toBe("anthropic");
    // system_fingerprint still emitted (null) on every non-streaming response.
    expect(json.system_fingerprint).toBeNull();
  });

  it("fixture id override wins verbatim (no gen- rewrite)", async () => {
    const fixtures: Fixture[] = [
      { match: { userMessage: "hi" }, response: { content: "hello", id: "gen-pinned-123" } },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}${OR}`, {
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(JSON.parse(res.body).id).toBe("gen-pinned-123");
  });

  it("provider + nativeFinishReason overrides win", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hi" },
        response: {
          content: "hello",
          provider: "azure",
          finishReason: "stop",
          nativeFinishReason: "end_turn",
        },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}${OR}`, {
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    });
    const json = JSON.parse(res.body);
    expect(json.provider).toBe("azure");
    expect(json.choices[0].finish_reason).toBe("stop");
    expect(json.choices[0].native_finish_reason).toBe("end_turn");
  });

  it("emits token detail breakdowns + is_byok only when overridden", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hi" },
        response: {
          content: "hello",
          usage: {
            cost: 0.1,
            prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 2, audio_tokens: 0 },
            completion_tokens_details: { reasoning_tokens: 7 },
            is_byok: true,
          },
        },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}${OR}`, {
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    });
    const json = JSON.parse(res.body);
    expect(json.usage.prompt_tokens_details).toEqual({
      cached_tokens: 3,
      cache_write_tokens: 2,
      audio_tokens: 0,
    });
    expect(json.usage.completion_tokens_details).toEqual({ reasoning_tokens: 7 });
    expect(json.usage.is_byok).toBe(true);
  });

  it("derives provider from the whole slug when there is no author segment", async () => {
    const fixtures: Fixture[] = [{ match: { userMessage: "hi" }, response: { content: "hello" } }];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}${OR}`, {
      model: "localmodel",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(JSON.parse(res.body).provider).toBe("localmodel");
  });
});

// ---------------------------------------------------------------------------
// OpenAI callers are byte-for-byte unchanged
// ---------------------------------------------------------------------------

describe("OpenAI /v1 callers are unchanged", () => {
  it("keeps chatcmpl- id, no provider, no cost on /v1/chat/completions", async () => {
    const fixtures: Fixture[] = [
      { match: { userMessage: "hi" }, response: { content: "hello", usage: { cost: 9 } } },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}${OAI}`, {
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    });
    const json = JSON.parse(res.body);
    expect(json.id.startsWith("chatcmpl-")).toBe(true);
    expect(json.provider).toBeUndefined();
    expect(json.usage.cost).toBeUndefined();
    expect(json.choices[0].native_finish_reason).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Streaming shaping
// ---------------------------------------------------------------------------

describe("OpenRouter chat: streaming shaping", () => {
  it("stamps gen- id + provider + system_fingerprint on EVERY chunk, native_finish_reason on every delta, and a cost usage chunk", async () => {
    const fixtures: Fixture[] = [
      { match: { userMessage: "hi" }, response: { content: "hello", usage: { cost: 0.02 } } },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}${OR}`, {
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      stream: true, // NOTE: no stream_options.include_usage — OpenRouter includes it anyway
    });
    const chunks = parseSSE(res.body);
    // gen- id + provider + system_fingerprint (null) on every chunk.
    expect(chunks.every((c) => c.id.startsWith("gen-"))).toBe(true);
    expect(chunks.every((c) => c.provider === "openai")).toBe(true);
    expect(chunks.every((c) => c.system_fingerprint === null)).toBe(true);
    // native_finish_reason present on EVERY delta choice: null until finish.
    const contentChunk = chunks.find((c) => c.choices[0]?.delta?.content === "hello");
    expect(contentChunk?.choices[0]).toHaveProperty("native_finish_reason");
    expect(contentChunk?.choices[0].native_finish_reason).toBeNull();
    // role:"assistant" repeated on content deltas (real-byte fidelity).
    expect(contentChunk?.choices[0].delta.role).toBe("assistant");
    const finish = chunks.find((c) => c.choices[0]?.finish_reason != null);
    expect(finish?.choices[0].native_finish_reason).toBe("stop");
    const usageChunk = chunks.find((c) => c.usage);
    expect(usageChunk?.usage?.cost).toBe(0.02);
    expect(usageChunk?.usage?.cost_details).toEqual({
      upstream_inference_cost: 0,
      upstream_inference_prompt_cost: 0,
      upstream_inference_completions_cost: 0,
    });
    expect(usageChunk?.id.startsWith("gen-")).toBe(true);
    expect(usageChunk?.service_tier).toBeNull();
  });

  it("emits exactly ONE : OPENROUTER PROCESSING keepalive, first, only when opted in", async () => {
    const fixtures: Fixture[] = [
      { match: { userMessage: "off" }, response: { content: "a" } },
      { match: { userMessage: "on" }, response: { content: "a" }, openRouterProcessing: true },
    ];
    instance = await createServer(fixtures);
    const off = await httpPost(`${instance.url}${OR}`, {
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "off" }],
      stream: true,
    });
    expect(off.body.includes(": OPENROUTER PROCESSING")).toBe(false);
    const on = await httpPost(`${instance.url}${OR}`, {
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "on" }],
      stream: true,
    });
    // Exactly one keepalive line, emitted BEFORE the first data frame.
    const occurrences = on.body.split(": OPENROUTER PROCESSING").length - 1;
    expect(occurrences).toBe(1);
    expect(on.body.indexOf(": OPENROUTER PROCESSING")).toBeLessThan(on.body.indexOf("data:"));
    expect(on.body.startsWith(": OPENROUTER PROCESSING\n\n")).toBe(true);
    // Data frames still parse (comment lines are skipped).
    expect(parseSSE(on.body).length).toBeGreaterThan(0);
  });

  it("A4: a cost-only usage override still estimates non-zero prompt/completion tokens on the streaming path", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "count my tokens" },
        // Cost-only override: no token counts supplied. The streaming usage
        // chunk must still estimate the tokens from the real prompt/completion
        // text (not force 0), matching the non-streaming path.
        response: { content: "here is a reasonably long streamed answer", usage: { cost: 0.5 } },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}${OR}`, {
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "count my tokens" }],
      stream: true,
    });
    const chunks = parseSSE(res.body);
    const usageChunk = chunks.find((c) => c.usage);
    expect(usageChunk?.usage?.cost).toBe(0.5);
    expect(usageChunk!.usage!.prompt_tokens).toBeGreaterThan(0);
    expect(usageChunk!.usage!.completion_tokens).toBeGreaterThan(0);
    expect(usageChunk!.usage!.total_tokens).toBe(
      usageChunk!.usage!.prompt_tokens + usageChunk!.usage!.completion_tokens,
    );
  });
});

// ---------------------------------------------------------------------------
// models[] fallback simulation
// ---------------------------------------------------------------------------

describe("OpenRouter chat: models[] fallback", () => {
  // The primary's error fixture is a 429/503 RUNTIME provider failure — the
  // only condition real OpenRouter fails over on. (An unknown/invalid model is
  // rejected up front with a 400 by real OR and is intentionally NOT modeled
  // here: a mock is fixture-driven, so an unknown model is simply a strict miss.)
  const fallbackFixtures = (): Fixture[] => [
    {
      match: { model: "primary/bad", userMessage: "route" },
      response: { error: { message: "primary rate limited (runtime failure)" }, status: 429 },
    },
    {
      match: { model: "fallback/good", userMessage: "route" },
      response: { content: "served by fallback", usage: { cost: 0.5 } },
    },
  ];

  it("falls through an error candidate and serves the next, echoing the winning slug", async () => {
    instance = await createServer(fallbackFixtures());
    const res = await httpPost(`${instance.url}${OR}`, {
      model: "primary/bad",
      models: ["primary/bad", "fallback/good"],
      messages: [{ role: "user", content: "route" }],
    });
    const json = JSON.parse(res.body);
    expect(res.status).toBe(200);
    expect(json.model).toBe("fallback/good");
    expect(json.provider).toBe("fallback");
    expect(json.choices[0].message.content).toBe("served by fallback");
    expect(json.usage.cost).toBe(0.5);
  });

  it("serves the terminal error (OpenRouter envelope) when every candidate fails", async () => {
    const fixtures: Fixture[] = [
      {
        match: { model: "primary/bad", userMessage: "route" },
        response: { error: { message: "primary down" }, status: 429 },
      },
      {
        match: { model: "secondary/bad", userMessage: "route" },
        response: { error: { message: "secondary down" }, status: 503 },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}${OR}`, {
      model: "primary/bad",
      models: ["primary/bad", "secondary/bad"],
      messages: [{ role: "user", content: "route" }],
    });
    const json = JSON.parse(res.body);
    expect(res.status).toBe(503);
    expect(json.error.code).toBe(503);
    expect(json.error.message).toBe("secondary down");
  });

  it("a request without models[] behaves as a single-model match", async () => {
    instance = await createServer(fallbackFixtures());
    const res = await httpPost(`${instance.url}${OR}`, {
      model: "primary/bad",
      messages: [{ role: "user", content: "route" }],
    });
    // primary/bad maps to an error and there is no fallback array — no fall-through.
    expect(res.status).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// Error envelope
// ---------------------------------------------------------------------------

describe("OpenRouter chat: error envelope", () => {
  it("uses { error: { code, message, metadata } } with code == status and free-form metadata", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "block" },
        response: {
          // metadata is free-form (additionalProperties) — a fixture supplies
          // arbitrary keys; aimock does not impose a moderation schema.
          error: { message: "flagged", metadata: { patterns: ["p1"], anything: 42 } },
          status: 403,
        },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}${OR}`, {
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "block" }],
    });
    const json = JSON.parse(res.body);
    expect(res.status).toBe(403);
    expect(json.error.code).toBe(403);
    expect(json.error.message).toBe("flagged");
    expect(json.error.metadata).toEqual({ patterns: ["p1"], anything: 42 });
    // OpenRouter envelope does not carry the OpenAI type/param fields.
    expect(json.error.type).toBeUndefined();
  });

  it("no-fixture-match yields a 404 OpenRouter envelope", async () => {
    instance = await createServer([]);
    const res = await httpPost(`${instance.url}${OR}`, {
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "nope" }],
    });
    const json = JSON.parse(res.body);
    expect(res.status).toBe(404);
    expect(json.error.code).toBe(404);
  });

  it("keeps the OpenAI error shape on /v1", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "boom" },
        response: { error: { message: "kaboom", type: "rate_limit_error" }, status: 429 },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}${OAI}`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "boom" }],
    });
    const json = JSON.parse(res.body);
    expect(json.error.type).toBe("rate_limit_error");
    expect(json.error.code).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Discovery endpoints
// ---------------------------------------------------------------------------

describe("OpenRouter discovery endpoints", () => {
  it("GET /api/v1/models synthesizes ids from chat fixtures", async () => {
    const fixtures: Fixture[] = [
      { match: { model: "openai/gpt-4o" }, response: { content: "a" } },
      { match: { model: "anthropic/claude-3.5-sonnet" }, response: { content: "b" } },
    ];
    instance = await createServer(fixtures);
    const res = await httpGet(`${instance.url}/api/v1/models`);
    const json = JSON.parse(res.body);
    expect(res.status).toBe(200);
    const ids = json.data.map((m: { id: string }) => m.id);
    expect(ids).toEqual(["openai/gpt-4o", "anthropic/claude-3.5-sonnet"]);
    const first = json.data[0];
    expect(first.canonical_slug).toBe("openai/gpt-4o");
    expect(typeof first.pricing.prompt).toBe("string");
    expect(Array.isArray(first.supported_parameters)).toBe(true);
  });

  it("GET /api/v1/models falls back to a default set when no fixtures name a model", async () => {
    instance = await createServer([]);
    const res = await httpGet(`${instance.url}/api/v1/models`);
    const json = JSON.parse(res.body);
    expect(json.data.length).toBeGreaterThan(0);
  });

  it("GET /api/v1/key returns key metadata matching the captured shape (null limit = unlimited)", async () => {
    instance = await createServer([]);
    const res = await httpGet(`${instance.url}/api/v1/key`);
    const json = JSON.parse(res.body);
    expect(res.status).toBe(200);
    expect(json.data.limit).toBeNull();
    expect(json.data.limit_remaining).toBeNull();
    expect(json.data.is_free_tier).toBe(false);
    expect(json.data.is_management_key).toBe(false);
    expect(json.data.is_provisioning_key).toBe(false);
    expect(json.data.expires_at).toBeNull();
    expect(json.data).toHaveProperty("creator_user_id");
    expect(json.data.rate_limit).toMatchObject({ requests: -1, interval: "10s" });
  });

  it("GET /api/v1/credits returns credit totals", async () => {
    instance = await createServer([]);
    const res = await httpGet(`${instance.url}/api/v1/credits`);
    const json = JSON.parse(res.body);
    expect(res.status).toBe(200);
    expect(json.data).toHaveProperty("total_credits");
    expect(json.data).toHaveProperty("total_usage");
  });
});

// ---------------------------------------------------------------------------
// Request extensions + attribution headers are accepted and journaled
// ---------------------------------------------------------------------------

describe("OpenRouter chat: fail-closed + fallback correctness (round-1 fixes)", () => {
  // Two-provider chain: primary is a 429 runtime failure, fallback succeeds.
  const chain = (): Fixture[] => [
    {
      match: { model: "primary/bad", userMessage: "route" },
      response: { error: { message: "primary rate limited (runtime failure)" }, status: 429 },
    },
    {
      match: { model: "fallback/good", userMessage: "route" },
      response: { content: "served by fallback", usage: { cost: 0.5 } },
    },
  ];

  it("A1: a request with NO model that matches a model-less fixture does not 500", async () => {
    const fixtures: Fixture[] = [{ match: { userMessage: "hi" }, response: { content: "hello" } }];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}${OR}`, {
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(200);
    const json = JSON.parse(res.body);
    expect(json.choices[0].message.content).toBe("hello");
    // Provider derives to "" for an absent/empty slug — never a TypeError/500.
    expect(json.provider).toBe("");
  });

  it("A2: journal retains the client's primary model; response echoes the winner", async () => {
    instance = await createServer(chain());
    const res = await httpPost(`${instance.url}${OR}`, {
      model: "primary/bad",
      models: ["primary/bad", "fallback/good"],
      messages: [{ role: "user", content: "route" }],
    });
    const json = JSON.parse(res.body);
    // Response echoes the winning (fallback) slug + winner-consistent provider.
    expect(json.model).toBe("fallback/good");
    expect(json.provider).toBe("fallback");
    // The JOURNALED request must retain what the client originally sent.
    const entry = instance.journal.getAll().find((e) => e.path === OR && e.response.status === 200);
    expect(entry).toBeTruthy();
    expect((entry!.body as { model?: string }).model).toBe("primary/bad");
  });

  it("A5: a sequenced error primary advances across requests (no replayed failover)", async () => {
    const fixtures: Fixture[] = [
      {
        match: { model: "primary/bad", userMessage: "route", sequenceIndex: 0 },
        response: { error: { message: "primary rate limited" }, status: 429 },
      },
      {
        match: { model: "primary/bad", userMessage: "route", sequenceIndex: 1 },
        response: { content: "primary recovered" },
      },
      {
        match: { model: "fallback/good", userMessage: "route" },
        response: { content: "served by fallback" },
      },
    ];
    instance = await createServer(fixtures);
    const body = {
      model: "primary/bad",
      models: ["primary/bad", "fallback/good"],
      messages: [{ role: "user", content: "route" }],
    };
    const first = await httpPost(`${instance.url}${OR}`, body);
    expect(JSON.parse(first.body).choices[0].message.content).toBe("served by fallback");
    // The primary's sequenced error must have advanced to seq 1, so on the next
    // request the primary now wins instead of replaying the same failover.
    const second = await httpPost(`${instance.url}${OR}`, body);
    const secondJson = JSON.parse(second.body);
    expect(secondJson.model).toBe("primary/bad");
    expect(secondJson.choices[0].message.content).toBe("primary recovered");
  });

  it("A7: provider.allow_fallbacks:false serves the primary error as terminal (no fallthrough)", async () => {
    instance = await createServer(chain());
    const res = await httpPost(`${instance.url}${OR}`, {
      model: "primary/bad",
      models: ["primary/bad", "fallback/good"],
      provider: { allow_fallbacks: false },
      messages: [{ role: "user", content: "route" }],
    });
    expect(res.status).toBe(429);
    expect(JSON.parse(res.body).error.message).toBe("primary rate limited (runtime failure)");
  });

  it("A7: allow_fallbacks:true (default) still falls through to the good fallback", async () => {
    instance = await createServer(chain());
    const res = await httpPost(`${instance.url}${OR}`, {
      model: "primary/bad",
      models: ["primary/bad", "fallback/good"],
      provider: { allow_fallbacks: true },
      messages: [{ role: "user", content: "route" }],
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).model).toBe("fallback/good");
  });
});

// ---------------------------------------------------------------------------
// v1.1 — error-class-bound fallthrough (`fallthrough: false` = terminal error)
// ---------------------------------------------------------------------------

describe("OpenRouter chat: error-class-bound fallthrough (v1.1)", () => {
  let tmpDir: string | null = null;
  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  // A 403 whose error CLASS does not fail over on real OpenRouter (the
  // openclaw #60191 pattern): the primary error is marked `fallthrough: false`,
  // so it must be served as terminal even though a good fallback follows.
  const terminalChain = (fallthrough?: boolean): Fixture[] => [
    {
      match: { model: "primary/bad", userMessage: "route" },
      response: {
        error: { message: "budget exceeded (non-failover class)" },
        status: 403,
        ...(fallthrough !== undefined && { fallthrough }),
      },
    },
    {
      match: { model: "fallback/good", userMessage: "route" },
      response: { content: "served by fallback", usage: { cost: 0.5 } },
    },
  ];

  it("fallthrough:false serves the primary error as terminal — NO failover", async () => {
    instance = await createServer(terminalChain(false));
    const res = await httpPost(`${instance.url}${OR}`, {
      model: "primary/bad",
      models: ["primary/bad", "fallback/good"],
      messages: [{ role: "user", content: "route" }],
    });
    const json = JSON.parse(res.body);
    // Terminal: the primary's 403 is served, the good fallback is never reached.
    expect(res.status).toBe(403);
    expect(json.error.code).toBe(403);
    expect(json.error.message).toBe("budget exceeded (non-failover class)");
  });

  it("fallthrough absent (default) still falls through to the good fallback", async () => {
    instance = await createServer(terminalChain(undefined));
    const res = await httpPost(`${instance.url}${OR}`, {
      model: "primary/bad",
      models: ["primary/bad", "fallback/good"],
      messages: [{ role: "user", content: "route" }],
    });
    const json = JSON.parse(res.body);
    expect(res.status).toBe(200);
    expect(json.model).toBe("fallback/good");
    expect(json.choices[0].message.content).toBe("served by fallback");
  });

  it("fallthrough:true (explicit) still falls through to the good fallback", async () => {
    instance = await createServer(terminalChain(true));
    const res = await httpPost(`${instance.url}${OR}`, {
      model: "primary/bad",
      models: ["primary/bad", "fallback/good"],
      messages: [{ role: "user", content: "route" }],
    });
    const json = JSON.parse(res.body);
    expect(res.status).toBe(200);
    expect(json.model).toBe("fallback/good");
  });

  it("fallthrough:false composes with allow_fallbacks:true — still terminal", async () => {
    // The per-error gate is independent of the request-level gate: if EITHER
    // says don't fall through, don't. allow_fallbacks:true does not override
    // fallthrough:false.
    instance = await createServer(terminalChain(false));
    const res = await httpPost(`${instance.url}${OR}`, {
      model: "primary/bad",
      models: ["primary/bad", "fallback/good"],
      provider: { allow_fallbacks: true },
      messages: [{ role: "user", content: "route" }],
    });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).error.message).toBe("budget exceeded (non-failover class)");
  });

  it("fallthrough:false on an error does not affect a normal (non-error) fallback chain", async () => {
    // Shipped behavior intact: a SUCCESS primary is served regardless of any
    // fallthrough flag on a sibling error fixture; the terminal-error flag only
    // gates the error candidate it lives on.
    const fixtures: Fixture[] = [
      {
        match: { model: "primary/good", userMessage: "route" },
        response: { content: "served by primary" },
      },
      {
        match: { model: "other/bad", userMessage: "route" },
        response: { error: { message: "non-failover" }, status: 403, fallthrough: false },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}${OR}`, {
      model: "primary/good",
      models: ["primary/good", "other/bad"],
      messages: [{ role: "user", content: "route" }],
    });
    const json = JSON.parse(res.body);
    expect(res.status).toBe(200);
    expect(json.model).toBe("primary/good");
    expect(json.choices[0].message.content).toBe("served by primary");
  });

  it("threads fallthrough:false through the real JSON fixture-loader path", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "or-fallthrough-fixture-"));
    const fixtureFile = join(tmpDir, "fallthrough.json");
    writeFileSync(
      fixtureFile,
      JSON.stringify({
        fixtures: [
          {
            match: { model: "primary/bad", userMessage: "route" },
            response: {
              error: { message: "budget exceeded (non-failover class)" },
              status: 403,
              fallthrough: false,
            },
          },
          {
            match: { model: "fallback/good", userMessage: "route" },
            response: { content: "served by fallback" },
          },
        ],
      }),
      "utf-8",
    );
    const loaded = loadFixtureFile(fixtureFile);
    const errors = validateFixtures(loaded).filter((r) => r.severity === "error");
    expect(errors).toEqual([]);

    instance = await createServer(loaded);
    const res = await httpPost(`${instance.url}${OR}`, {
      model: "primary/bad",
      models: ["primary/bad", "fallback/good"],
      messages: [{ role: "user", content: "route" }],
    });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).error.message).toBe("budget exceeded (non-failover class)");
  });

  it("rejects a non-boolean fallthrough at load (fail-closed cannot fail open)", async () => {
    // A JSON/YAML author writing "false" (string), 0, or null would otherwise
    // be silently treated as fall-through (`!== false` is true), the OPPOSITE
    // of the intended terminal behavior. The loader must reject it up front.
    const bad: Fixture[] = [
      {
        match: { model: "primary/bad", userMessage: "route" },
        // Intentionally wrong type — mimics a JSON author's "false" string.
        response: {
          error: { message: "x" },
          status: 403,
          fallthrough: "false",
        } as unknown as Fixture["response"],
      },
    ];
    const errors = validateFixtures(bad).filter((r) => r.severity === "error");
    expect(errors.some((e) => /fallthrough must be a boolean/.test(e.message))).toBe(true);

    // A proper boolean is accepted (no error).
    const good: Fixture[] = [
      {
        match: { model: "primary/bad", userMessage: "route" },
        response: { error: { message: "x" }, status: 403, fallthrough: false },
      },
    ];
    expect(validateFixtures(good).filter((r) => r.severity === "error")).toEqual([]);
  });
});

describe("OpenRouter request extensions", () => {
  it("accepts and journals extension fields + attribution headers without rejecting", async () => {
    const fixtures: Fixture[] = [{ match: { userMessage: "hi" }, response: { content: "ok" } }];
    instance = await createServer(fixtures);
    const res = await httpPost(
      `${instance.url}${OR}`,
      {
        model: "openai/gpt-4o",
        messages: [{ role: "user", content: "hi" }],
        provider: { order: ["openai", "azure"] },
        models: [],
        transforms: ["middle-out"],
        route: "fallback",
        reasoning: { effort: "high" },
        plugins: [{ id: "web" }],
        prediction: { type: "content", content: "x" },
        usage: { include: true },
      },
      {
        "HTTP-Referer": "https://example.com",
        // Canonical attribution header is X-OpenRouter-Title; X-Title is
        // tolerated legacy. Both are journaled generically, never required.
        "X-OpenRouter-Title": "My App",
        "X-Title": "Legacy App",
      },
    );
    expect(res.status).toBe(200);
    const entries = instance.journal.getAll();
    const entry = entries.find((e) => e.path === OR);
    expect(entry).toBeTruthy();
    const journaledBody = entry!.body as Record<string, unknown>;
    // Unknown body keys (incl. the non-standard `transforms`) pass through.
    expect(journaledBody.transforms).toEqual(["middle-out"]);
    expect(journaledBody.route).toBe("fallback");
    expect(journaledBody.reasoning).toEqual({ effort: "high" });
    expect(entry!.headers["http-referer"]).toBe("https://example.com");
    expect(entry!.headers["x-openrouter-title"]).toBe("My App");
    expect(entry!.headers["x-title"]).toBe("Legacy App");
  });
});

// ---------------------------------------------------------------------------
// A3 — usage validator accepts OpenRouter cost sub-fields
// ---------------------------------------------------------------------------

describe("OpenRouter usage validator accepts documented cost sub-fields", () => {
  let tmpDir: string | null = null;
  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it("does not reject a fixture whose usage sets cost_details / *_tokens_details / is_byok", () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hi" },
        response: {
          content: "hello",
          usage: {
            cost: 0.1,
            cost_details: { upstream_inference_cost: 0.05 },
            prompt_tokens_details: { cached_tokens: 3 },
            completion_tokens_details: { reasoning_tokens: 7 },
            is_byok: true,
          },
        },
      },
    ];
    const errors = validateFixtures(fixtures).filter((r) => r.severity === "error");
    expect(errors).toEqual([]);
  });

  it("still rejects a genuinely wrong-typed numeric usage field", () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hi" },
        // prompt_tokens must be a number — a string is still an error.
        response: { content: "hello", usage: { prompt_tokens: "42" } as never },
      },
    ];
    const errors = validateFixtures(fixtures).filter((r) => r.severity === "error");
    expect(errors.some((e) => /usage\.prompt_tokens.*must be a number/.test(e.message))).toBe(true);
  });

  it("rejects is_byok / cost_details supplied with the wrong type", () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hi" },
        response: {
          content: "hello",
          usage: { is_byok: "yes", cost_details: 5 } as never,
        },
      },
    ];
    const errors = validateFixtures(fixtures).filter((r) => r.severity === "error");
    expect(errors.some((e) => /usage\.is_byok.*must be a boolean/.test(e.message))).toBe(true);
    expect(errors.some((e) => /usage\.cost_details.*must be an object/.test(e.message))).toBe(true);
  });

  it("rejects a malformed inner scalar in cost_details / *_tokens_details", () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hi" },
        response: {
          content: "hello",
          usage: {
            // Objects are the right shape, but the inner scalars are the wrong
            // type — this must be caught at load time, not left to blow up in
            // the canonical OpenRouter SDK at replay.
            cost_details: { upstream_inference_cost: "abc" },
            prompt_tokens_details: { cached_tokens: "3" },
            completion_tokens_details: { reasoning_tokens: true },
          } as never,
        },
      },
    ];
    const errors = validateFixtures(fixtures).filter((r) => r.severity === "error");
    expect(
      errors.some((e) =>
        /usage\.cost_details\.upstream_inference_cost.*must be a number/.test(e.message),
      ),
    ).toBe(true);
    expect(
      errors.some((e) =>
        /usage\.prompt_tokens_details\.cached_tokens.*must be a number/.test(e.message),
      ),
    ).toBe(true);
    expect(
      errors.some((e) =>
        /usage\.completion_tokens_details\.reasoning_tokens.*must be a number/.test(e.message),
      ),
    ).toBe(true);
  });

  it("accepts numeric inner scalars in cost_details / *_tokens_details + boolean is_byok", () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hi" },
        response: {
          content: "hello",
          usage: {
            cost: 0.1,
            cost_details: {
              upstream_inference_cost: 0.05,
              upstream_inference_prompt_cost: 0.03,
              upstream_inference_completions_cost: 0.02,
            },
            prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 2, audio_tokens: 0 },
            completion_tokens_details: { reasoning_tokens: 7 },
            is_byok: true,
          },
        },
      },
    ];
    const errors = validateFixtures(fixtures).filter((r) => r.severity === "error");
    expect(errors).toEqual([]);
  });

  it("loads + serves a real fixture file with cost_details / is_byok intact", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "or-usage-fixture-"));
    const fixtureFile = join(tmpDir, "cost.json");
    writeFileSync(
      fixtureFile,
      JSON.stringify({
        fixtures: [
          {
            match: { userMessage: "hi" },
            response: {
              content: "hello",
              usage: {
                cost: 0.25,
                cost_details: {
                  upstream_inference_cost: 0.2,
                  upstream_inference_prompt_cost: 0.1,
                  upstream_inference_completions_cost: 0.1,
                },
                is_byok: true,
              },
            },
          },
        ],
      }),
      "utf-8",
    );

    // Real file-loader path — this is the surface the validator guards.
    const loaded = loadFixtureFile(fixtureFile);
    const errors = validateFixtures(loaded).filter((r) => r.severity === "error");
    expect(errors).toEqual([]);

    instance = await createServer(loaded);
    const res = await httpPost(`${instance.url}${OR}`, {
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    });
    const json = JSON.parse(res.body);
    expect(res.status).toBe(200);
    expect(json.usage.cost).toBe(0.25);
    expect(json.usage.cost_details).toEqual({
      upstream_inference_cost: 0.2,
      upstream_inference_prompt_cost: 0.1,
      upstream_inference_completions_cost: 0.1,
    });
    expect(json.usage.is_byok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A4 — a cost-only usage override still estimates token counts
// ---------------------------------------------------------------------------

describe("OpenRouter cost-only usage override still estimates token counts", () => {
  it("returns cost with non-zero estimated prompt/completion tokens (non-streaming)", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hi" },
        response: { content: "hello there", usage: { cost: 0.5 } },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}${OR}`, {
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    });
    const json = JSON.parse(res.body);
    expect(json.usage.cost).toBe(0.5);
    // Token counts must be estimated (real OpenRouter always carries them),
    // NOT forced to 0 by the mere presence of a cost override.
    expect(json.usage.prompt_tokens).toBeGreaterThan(0);
    expect(json.usage.completion_tokens).toBeGreaterThan(0);
    expect(json.usage.total_tokens).toBe(json.usage.prompt_tokens + json.usage.completion_tokens);
  });

  it("still honors explicit token counts in a usage override", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hi" },
        response: {
          content: "hello there",
          usage: { cost: 0.5, prompt_tokens: 11, completion_tokens: 22 },
        },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}${OR}`, {
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    });
    const json = JSON.parse(res.body);
    expect(json.usage.prompt_tokens).toBe(11);
    expect(json.usage.completion_tokens).toBe(22);
    expect(json.usage.total_tokens).toBe(33);
  });
});

// ---------------------------------------------------------------------------
// Round-2 fixes: systematic error envelope, sequenced-fallback counts,
// blocks-aware streaming token estimate
// ---------------------------------------------------------------------------

describe("OpenRouter chat: error envelope completeness (round-2)", () => {
  // A fixture whose response matches NO known chat response type (empty blocks
  // array is neither text, tool-call, blocks-only, error, nor audio) drives the
  // terminal "did not match any known type" 500. It must still speak the
  // OpenRouter envelope (`error.code` numeric == status), not the OpenAI shape.
  it("terminal no-matching-type 500 uses the OpenRouter envelope (error.code == 500)", async () => {
    const fixtures: Fixture[] = [{ match: { userMessage: "weird" }, response: { blocks: [] } }];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}${OR}`, {
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "weird" }],
    });
    expect(res.status).toBe(500);
    const json = JSON.parse(res.body);
    expect(json.error.code).toBe(500);
    expect(typeof json.error.code).toBe("number");
    expect(json.error.message).toBe("Fixture response did not match any known type");
    // OpenAI-only fields must be absent on the OpenRouter envelope.
    expect(json.error.type).toBeUndefined();
  });

  it("malformed-JSON 400 uses the OpenRouter envelope (error.code == 400)", async () => {
    instance = await createServer([]);
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        `${instance!.url}${OR}`,
        { method: "POST", headers: { "Content-Type": "application/json" } },
        (r) => {
          const cs: Buffer[] = [];
          r.on("data", (c) => cs.push(c));
          r.on("end", () => resolve({ status: r.statusCode!, body: Buffer.concat(cs).toString() }));
        },
      );
      req.on("error", reject);
      req.write("{ this is not valid json ");
      req.end();
    });
    expect(res.status).toBe(400);
    const json = JSON.parse(res.body);
    expect(json.error.code).toBe(400);
    expect(typeof json.error.code).toBe("number");
    // OpenAI-only fields must be absent on the OpenRouter envelope.
    expect(json.error.type).toBeUndefined();
  });

  it("OpenAI /v1 terminal no-matching-type 500 keeps the OpenAI shape", async () => {
    const fixtures: Fixture[] = [{ match: { userMessage: "weird" }, response: { blocks: [] } }];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}${OAI}`, {
      model: "gpt-4o",
      messages: [{ role: "user", content: "weird" }],
    });
    expect(res.status).toBe(500);
    const json = JSON.parse(res.body);
    // OpenAI shape: string `type`, no numeric `code`.
    expect(json.error.type).toBe("server_error");
    expect(json.error.message).toBe("Fixture response did not match any known type");
    expect(json.error.code).toBeUndefined();
  });
});

describe("OpenRouter chat: sequenced fallback match-count correctness (round-2)", () => {
  // A single model-less sequenced fixture pair is matched by BOTH fallback
  // candidates in one request. Candidate 1 consumes seq 0 (a runtime-error
  // failover); candidate 2 must then see seq 0 as exhausted and match seq 1.
  // With a stale match-count snapshot, candidate 2 re-reads count 0 and matches
  // seq 0 AGAIN — replaying the failover and serving a terminal error instead
  // of the recovered success.
  it("advances the sequence within one request when multiple candidates match the same fixture", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "route", sequenceIndex: 0 },
        response: { error: { message: "cold-start failure" }, status: 503 },
      },
      {
        match: { userMessage: "route", sequenceIndex: 1 },
        response: { content: "recovered" },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}${OR}`, {
      model: "a/x",
      models: ["a/x", "b/y"],
      messages: [{ role: "user", content: "route" }],
    });
    expect(res.status).toBe(200);
    const json = JSON.parse(res.body);
    expect(json.choices[0].message.content).toBe("recovered");
    // The winner is the SECOND candidate (seq 1 matched under b/y).
    expect(json.model).toBe("b/y");
  });
});

describe("OpenRouter chat: blocks-only streaming token estimate (round-2)", () => {
  // A blocks-only streaming fixture streams real block text but the usage
  // chunk's completion-token estimate was built from `content` only (empty for
  // a blocks-only fixture) — reporting ~1 completion token. The estimate must
  // include the streamed block text.
  it("estimates completion_tokens from block text on a blocks-only streaming fixture", async () => {
    const blockText = "this is a fairly long streamed block of assistant text";
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "stream blocks" },
        response: { blocks: [{ type: "text", text: blockText }], usage: { cost: 0.01 } },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}${OR}`, {
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "stream blocks" }],
      stream: true,
    });
    const chunks = parseSSE(res.body);
    // The block text really did stream.
    const streamed = chunks.map((c) => c.choices[0]?.delta?.content ?? "").join("");
    expect(streamed).toBe(blockText);
    const usageChunk = chunks.find((c) => c.usage);
    expect(usageChunk?.usage?.cost).toBe(0.01);
    // Non-trivial: ceil(54/4) ≈ 14 tokens, not the ~1 an empty estimate yields.
    expect(usageChunk!.usage!.completion_tokens).toBeGreaterThan(5);
  });

  // Behavior-preservation pin for the round-3 single-resolution refactor: the
  // blocks-only streaming completion_tokens value must stay EXACTLY the same
  // after the usage estimate stopped re-resolving the blocks a second time.
  it("blocks-only streaming completion_tokens is exactly 14 (value pinned across the refactor)", async () => {
    const blockText = "this is a fairly long streamed block of assistant text";
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "stream blocks" },
        response: { blocks: [{ type: "text", text: blockText }], usage: { cost: 0.01 } },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}${OR}`, {
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "stream blocks" }],
      stream: true,
    });
    const usageChunk = parseSSE(res.body).find((c) => c.usage);
    expect(usageChunk!.usage!.completion_tokens).toBe(14);
  });
});

// ---------------------------------------------------------------------------
// Round-3 CR additions
// ---------------------------------------------------------------------------

describe("OpenAI /v1 streaming is byte-shape isolated from OpenRouter shaping (round-3)", () => {
  it("a /v1 streaming request carries NO gen- id, provider, native_finish_reason, or usage chunk", async () => {
    const fixtures: Fixture[] = [
      { match: { userMessage: "hi" }, response: { content: "hello there", usage: { cost: 7 } } },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}${OAI}`, {
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      stream: true, // no stream_options.include_usage
    });
    const chunks = parseSSE(res.body);
    expect(chunks.length).toBeGreaterThan(0);
    // The gen- id rewrite must never leak onto /v1: ids keep the chatcmpl- prefix.
    expect(chunks.every((c) => c.id.startsWith("chatcmpl-"))).toBe(true);
    expect(chunks.some((c) => c.id.startsWith("gen-"))).toBe(false);
    // No top-level provider on any chunk.
    expect(chunks.every((c) => c.provider === undefined)).toBe(true);
    // No native_finish_reason stamped on any delta choice.
    expect(chunks.every((c) => c.choices.every((ch) => !("native_finish_reason" in ch)))).toBe(
      true,
    );
    // No OpenRouter usage chunk (include_usage not requested + not OpenRouter).
    expect(chunks.some((c) => c.usage)).toBe(false);
    // service_tier never appears on a /v1 chunk.
    expect(chunks.every((c) => !("service_tier" in c))).toBe(true);
  });
});

describe("OpenRouter chat: tool-call response shaping (round-3)", () => {
  const toolFixture = (): Fixture[] => [
    {
      match: { userMessage: "weather" },
      response: {
        content: "",
        toolCalls: [{ name: "get_weather", arguments: '{"city":"SF"}' }],
        usage: { cost: 0.03 },
      },
    },
  ];

  it("non-streaming: gen- id, provider, native_finish_reason=tool_calls, tool_calls payload intact", async () => {
    instance = await createServer(toolFixture());
    const res = await httpPost(`${instance.url}${OR}`, {
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "weather" }],
    });
    const json = JSON.parse(res.body);
    expect(res.status).toBe(200);
    expect(json.id.startsWith("gen-")).toBe(true);
    expect(json.provider).toBe("openai");
    expect(json.choices[0].finish_reason).toBe("tool_calls");
    expect(json.choices[0].native_finish_reason).toBe("tool_calls");
    const tc = json.choices[0].message.tool_calls;
    expect(tc).toHaveLength(1);
    expect(tc[0].type).toBe("function");
    expect(tc[0].function.name).toBe("get_weather");
    expect(tc[0].function.arguments).toBe('{"city":"SF"}');
    // Cost-bearing usage shaped as OpenRouter.
    expect(json.usage.cost).toBe(0.03);
  });

  it("streaming: gen- id + provider on every chunk, native_finish_reason=tool_calls at finish, tool_calls stream intact", async () => {
    instance = await createServer(toolFixture());
    const res = await httpPost(`${instance.url}${OR}`, {
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "weather" }],
      stream: true,
    });
    const chunks = parseSSE(res.body);
    expect(chunks.every((c) => c.id.startsWith("gen-"))).toBe(true);
    expect(chunks.every((c) => c.provider === "openai")).toBe(true);
    const finish = chunks.find((c) => c.choices[0]?.finish_reason != null);
    expect(finish?.choices[0].finish_reason).toBe("tool_calls");
    expect(finish?.choices[0].native_finish_reason).toBe("tool_calls");
    // Reassemble the tool call from the streamed deltas (name + arguments intact).
    const deltas = chunks.flatMap((c) => c.choices[0]?.delta?.tool_calls ?? []);
    const name = deltas.map((t) => t.function?.name ?? "").join("");
    const args = deltas.map((t) => t.function?.arguments ?? "").join("");
    expect(name).toBe("get_weather");
    expect(args).toBe('{"city":"SF"}');
  });
});

describe("OpenRouter chat: allow_fallbacks:false strict miss (round-3)", () => {
  // Only the FALLBACK has a fixture; the primary candidate matches nothing.
  const onlyFallback = (): Fixture[] => [
    {
      match: { model: "fallback/good", userMessage: "route" },
      response: { content: "served by fallback" },
    },
  ];

  it("allow_fallbacks:false + primary miss does NOT fall through — 404 OpenRouter envelope", async () => {
    instance = await createServer(onlyFallback());
    const res = await httpPost(`${instance.url}${OR}`, {
      model: "primary/nomatch",
      models: ["primary/nomatch", "fallback/good"],
      provider: { allow_fallbacks: false },
      messages: [{ role: "user", content: "route" }],
    });
    expect(res.status).toBe(404);
    const json = JSON.parse(res.body);
    expect(json.error.code).toBe(404);
    // The matchable fallback fixture was NOT served (fall-through suppressed).
    expect(res.body.includes("served by fallback")).toBe(false);
  });

  it("allow_fallbacks:true (default) + primary miss DOES fall through to the fallback", async () => {
    instance = await createServer(onlyFallback());
    const res = await httpPost(`${instance.url}${OR}`, {
      model: "primary/nomatch",
      models: ["primary/nomatch", "fallback/good"],
      provider: { allow_fallbacks: true },
      messages: [{ role: "user", content: "route" }],
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).choices[0].message.content).toBe("served by fallback");
  });
});

describe("OpenRouter chat: service_tier only on the usage chunk (round-3)", () => {
  it("non-usage streaming chunks omit service_tier; only the usage chunk carries it (null)", async () => {
    const fixtures: Fixture[] = [
      { match: { userMessage: "hi" }, response: { content: "hello world", usage: { cost: 0.01 } } },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}${OR}`, {
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    const chunks = parseSSE(res.body);
    const usageChunks = chunks.filter((c) => c.usage);
    const nonUsageChunks = chunks.filter((c) => !c.usage);
    expect(usageChunks).toHaveLength(1);
    // The one usage-bearing chunk carries service_tier: null.
    expect(usageChunks[0].service_tier).toBeNull();
    // Every other chunk (role, content, finish) omits service_tier entirely.
    expect(nonUsageChunks.length).toBeGreaterThan(0);
    expect(nonUsageChunks.every((c) => !("service_tier" in c))).toBe(true);
  });
});

describe("OpenRouter chat: malformed blocks never leave a spurious 200 (round-3 source nit)", () => {
  // A programmatic content+toolCalls STREAMING fixture whose `blocks` array is
  // malformed: resolveFixtureBlocks throws. Pre-fix that throw happened AFTER
  // journal.add had recorded status 200 (and the usage estimate re-resolved the
  // blocks a second time); the fix resolves the blocks ONCE, before journal.add,
  // so a malformed fixture leaves NO status-200 journal entry.
  it("streaming content+toolCalls with a malformed blocks array does not record a 200", async () => {
    // `text` block missing its required `text` field — rejected by resolveFixtureBlocks.
    const malformedBlocks = [{ type: "text" }] as unknown as FixtureBlock[];
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "malformed" },
        response: {
          content: "hi",
          toolCalls: [{ name: "f", arguments: "{}" }],
          blocks: malformedBlocks,
        },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}${OR}`, {
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "malformed" }],
      stream: true,
    });
    // The malformed fixture is a server error either way ...
    expect(res.status).toBe(500);
    // ... but the journal must NOT contain a spurious success entry.
    const twoHundreds = instance.journal.getAll().filter((e) => e.response.status === 200);
    expect(twoHundreds).toHaveLength(0);
  });
});

describe("OpenRouter chat: raw error fixtures fail over like typed errors (#549)", () => {
  const typedFallback: Fixture = {
    match: { model: "b", userMessage: "route" },
    response: { content: "served by b" },
  };
  const rawPrimary = (status: number): Fixture => ({
    match: { model: "a", userMessage: "route" },
    response: {
      raw: { wire: "openai-chat", status, json: { error: { message: `raw ${status}` } } },
    },
  });
  const typedPrimary = (status: number): Fixture => ({
    match: { model: "a", userMessage: "route" },
    response: { error: { message: `typed ${status}` }, status },
  });
  const chainBody = {
    model: "a",
    models: ["a", "b"],
    messages: [{ role: "user", content: "route" }],
  };

  for (const status of [429, 503]) {
    it(`control: a typed ${status} on "a" fails over to "b"`, async () => {
      instance = await createServer([typedPrimary(status), typedFallback]);
      const res = await httpPost(`${instance.url}${OR}`, chainBody);
      expect(res.status).toBe(200);
      const json = JSON.parse(res.body);
      expect(json.model).toBe("b");
      expect(json.choices[0].message.content).toBe("served by b");
    });

    it(`a raw ${status} on "a" fails over to "b"`, async () => {
      instance = await createServer([rawPrimary(status), typedFallback]);
      const res = await httpPost(`${instance.url}${OR}`, chainBody);
      expect(res.status).toBe(200);
      const json = JSON.parse(res.body);
      expect(json.model).toBe("b");
      expect(json.choices[0].message.content).toBe("served by b");
    });
  }

  it("a raw 429 on every candidate serves the last raw error", async () => {
    const rawB: Fixture = {
      match: { model: "b", userMessage: "route" },
      response: {
        raw: { wire: "openai-chat", status: 503, json: { error: { message: "b down" } } },
      },
    };
    instance = await createServer([rawPrimary(429), rawB]);
    const res = await httpPost(`${instance.url}${OR}`, chainBody);
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ error: { message: "b down" } });
  });

  it("allow_fallbacks:false serves a raw 429 primary as terminal", async () => {
    instance = await createServer([rawPrimary(429), typedFallback]);
    const res = await httpPost(`${instance.url}${OR}`, {
      ...chainBody,
      provider: { allow_fallbacks: false },
    });
    expect(res.status).toBe(429);
    expect(JSON.parse(res.body)).toEqual({ error: { message: "raw 429" } });
  });

  it("a raw 200 on 'a' is still served as success", async () => {
    const rawOk: Fixture = {
      match: { model: "a", userMessage: "route" },
      response: {
        raw: {
          wire: "openai-chat",
          json: { id: "x", object: "chat.completion", model: "a", choices: [] },
        },
      },
    };
    instance = await createServer([rawOk, typedFallback]);
    const res = await httpPost(`${instance.url}${OR}`, chainBody);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).id).toBe("x");
  });
});
