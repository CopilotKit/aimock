/**
 * Raw fetch() clients for real provider APIs.
 *
 * Uses fetch directly (no SDKs) to avoid SDK normalization masking real API
 * quirks. SSE parsing, retry logic, and model listing endpoints.
 */

import { extractShape, type SSEEventShape } from "./schema.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProviderConfig {
  apiKey: string;
}

interface FetchResult {
  status: number;
  body: unknown;
  raw: string;
}

interface StreamResult {
  status: number;
  events: SSEEventShape[];
  rawEvents: { type: string; data: unknown }[];
}

/**
 * Structured error carrying the HTTP status code as a first-class numeric field.
 *
 * Downstream classifiers (Slack alerts, preflight checks) MUST key off
 * `error.status` — never parse the prose message string.
 *
 *   401 | 403 → stale-key      (replace the API key)
 *   429       → rate-limited   (back off)
 *   5xx       → infra-transient (retry / alert ops)
 *   network   → no status field (instanceof check first)
 */
export class InfraError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "InfraError";
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Shared self-healing helpers (live-model discovery + infra-skip)
// ---------------------------------------------------------------------------
//
// Generalizes the two already-merged self-healing patterns so the live-leg
// retrofits reuse ONE util instead of each inlining a divergent copy:
//   - Cohere dynamic model discovery (#325 / cohere-model.ts): resolve a live,
//     non-deprecated model id from the provider's own `/models` listing rather
//     than hardcoding one the provider later retires (the `command-r-plus` 404
//     that quarantined the leg as exit 5).
//   - fal infra-skip (#332): classify a provider-side auth/credit/rate-limit/5xx
//     condition as an HONEST SKIP so a transient outage never quarantines the
//     shared drift baseline.

/**
 * Environmental HTTP statuses that indicate a provider-side condition
 * (auth / out-of-credit / rate-limit / upstream outage) rather than a real
 * API-envelope drift. Mirrors the {@link InfraError} classification:
 *   401 | 403 → stale-key      402 → out-of-credit
 *   429       → rate-limited    5xx → infra-transient
 *
 * A live leg converts these to an HONEST SKIP so a transient provider-side
 * condition never quarantines the drift collector and reds the PR. A real
 * shape drift (a 2xx response with an unexpected envelope) is NEVER an infra
 * status, so genuine drift still fails. Status-only by design — a 404 on a
 * listing endpoint is a broken listing (unavailable), not a skip; the
 * retired-MODEL case is {@link isModelNotFound}.
 */
export function isInfraSkip(status: number): boolean {
  return status === 401 || status === 402 || status === 403 || status === 429 || status >= 500;
}

/**
 * True when a PROBE response indicates the requested MODEL does not exist (the
 * pinned model id was retired) rather than a live-envelope drift. Providers
 * signal this as a 404, or a 400 whose error body names a model-not-found
 * condition (OpenAI `model_not_found`, "does not exist", "unknown model",
 * etc.). The retrofit legs convert this to an honest skip — a stale pin is an
 * operational nudge to re-discover, not a drift finding that should red the PR.
 *
 * Distinct from {@link isInfraSkip} because it is PROBE-scoped and body-aware:
 * the model-listing/discovery path treats a 404 as `unavailable` (fail-loud),
 * whereas a driven-probe 404 means the model id went stale.
 */
export function isModelNotFound(status: number, body?: string): boolean {
  if (status === 404) return true;
  if (status === 400 && body) {
    return /model[_\s-]?not[_\s-]?found|does\s+not\s+exist|not\s+a\s+valid\s+model|unknown\s+model/i.test(
      body,
    );
  }
  return false;
}

/** Minimal shape of a `/models` listing entry we depend on for selection. */
export interface LiveModelEntry {
  /** The model identifier (OpenAI `id`, Cohere/Gemini `name`, …). */
  id: string;
  /** True when the provider marks this model deprecated/retired. */
  deprecated?: boolean;
}

/**
 * Select a currently-valid, NON-deprecated model id from a `/models` listing,
 * generalizing `selectCohereChatModel`. Prefers an id from `preferred` (in
 * order) when it is present AND live, else falls back to the first live model.
 * Returns null when the listing exposes no usable (non-deprecated, non-empty)
 * model.
 */
export function selectLiveModel(models: LiveModelEntry[], preferred: string[] = []): string | null {
  const liveIds = liveModelIds(models);
  return preferred.find((p) => liveIds.includes(p)) ?? liveIds[0] ?? null;
}

/**
 * The usable (non-deprecated, non-empty) ids from a `/models` listing, in the
 * provider's own order.
 *
 * Shared by {@link selectLiveModel} — which takes the first — and by
 * {@link resolveLiveModelCandidates}, which keeps the whole ordered list for a
 * leg that must try more than one because the LISTING alone cannot settle the
 * capability it needs (see that function's note).
 */
function liveModelIds(models: LiveModelEntry[]): string[] {
  return models
    .filter((m) => typeof m.id === "string" && m.id.length > 0 && m.deprecated !== true)
    .map((m) => m.id);
}

/**
 * Outcome of resolving a live model for a leg:
 *   - `{ model }`       → a valid, non-deprecated id to drive the leg
 *   - `{ infra }`       → the listing hit an auth/credit/rate-limit/5xx
 *                         condition; the caller SKIPS honestly (not drift)
 *   - `{ unavailable }` → the listing succeeded (or hit a non-infra error) but
 *                         exposed no usable model — a genuinely broken state to
 *                         fail loud on
 */
export type ResolvedModel = { model: string } | { infra: number } | { unavailable: true };

/** Per-key memo so the whole leg makes exactly one listing call. */
const resolvedModelCache = new Map<string, Promise<ResolvedModel>>();

/**
 * Resolve a live model from a provider's own listing endpoint, MEMOIZED per
 * `key` so repeated calls within one leg make a single listing call.
 * Generalizes cohere's `resolveCohereChatModel` + `getCohereChatModel`.
 *
 * `fetchListing` is provider-specific: it performs the raw listing call and
 * normalizes it to `{ status, models }` (mapping the provider's field names
 * onto {@link LiveModelEntry}). An {@link InfraError} thrown from it (e.g. a
 * network failure surfaced through {@link withInfraErrorTag}) is mapped to an
 * honest `{ infra }` skip rather than propagating.
 */
export function resolveLiveModel(
  key: string,
  fetchListing: () => Promise<{ status: number; models: LiveModelEntry[] }>,
  preferred: string[] = [],
): Promise<ResolvedModel> {
  const cached = resolvedModelCache.get(key);
  if (cached) return cached;
  const promise = (async (): Promise<ResolvedModel> => {
    try {
      const { status, models } = await fetchListing();
      if (isInfraSkip(status)) return { infra: status };
      if (status >= 400) return { unavailable: true };
      const model = selectLiveModel(models, preferred);
      return model ? { model } : { unavailable: true };
    } catch (err) {
      if (err instanceof InfraError) return { infra: err.status };
      throw err;
    }
  })();
  resolvedModelCache.set(key, promise);
  return promise;
}

/**
 * Outcome of resolving the FULL ordered candidate list for a leg — the same
 * three-way classification as {@link ResolvedModel}, carrying every usable id
 * instead of just the first.
 */
export type ResolvedCandidates = { models: string[] } | { infra: number } | { unavailable: true };

/** Per-key memo for {@link resolveLiveModelCandidates}. */
const resolvedCandidatesCache = new Map<string, Promise<ResolvedCandidates>>();

/**
 * Resolve EVERY usable model from a provider's listing, MEMOIZED per `key`,
 * with the same infra/unavailable classification as {@link resolveLiveModel}.
 *
 * WHY A LIST. `resolveLiveModel` takes the first usable id, which is right
 * whenever the listing filter already settles the capability the leg needs. It
 * is NOT right when the listing cannot express that capability. Gemini Live is
 * that case: `/models` declares `bidiGenerateContent` but says nothing about
 * which RESPONSE MODALITY a model serves, and the two are genuinely
 * independent — `gemini-3.5-transcribe-live` declares `bidiGenerateContent` and
 * yet emits only TEXT, so a leg driving AUDIO must be able to move past it to
 * the next candidate. The provider's own refusal is the only authority on that
 * capability, so the leg learns it by asking (see `driveGeminiLiveAudio` in
 * ws-providers.ts) — never by pattern-matching the model NAME.
 */
export function resolveLiveModelCandidates(
  key: string,
  fetchListing: () => Promise<{ status: number; models: LiveModelEntry[] }>,
): Promise<ResolvedCandidates> {
  const cached = resolvedCandidatesCache.get(key);
  if (cached) return cached;
  const promise = (async (): Promise<ResolvedCandidates> => {
    try {
      const { status, models } = await fetchListing();
      if (isInfraSkip(status)) return { infra: status };
      if (status >= 400) return { unavailable: true };
      const ids = liveModelIds(models);
      return ids.length > 0 ? { models: ids } : { unavailable: true };
    } catch (err) {
      if (err instanceof InfraError) return { infra: err.status };
      throw err;
    }
  })();
  resolvedCandidatesCache.set(key, promise);
  return promise;
}

/**
 * Test-only: clear the {@link resolveLiveModel} and
 * {@link resolveLiveModelCandidates} memo caches between cases.
 */
export function __resetResolveLiveModelCache(): void {
  resolvedModelCache.clear();
  resolvedCandidatesCache.clear();
}

// ---------------------------------------------------------------------------
// Retry helper
// ---------------------------------------------------------------------------

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503]);

async function fetchWithRetry(url: string, init: RequestInit, maxRetries = 3): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetch(url, init);
      if (RETRYABLE_STATUSES.has(res.status) && attempt < maxRetries - 1) {
        console.warn(
          `Retry ${attempt + 1}/${maxRetries} after ${res.status} for ${url.slice(0, 80)}`,
        );
        await res.text(); // consume body to free socket
        const backoff = Math.pow(2, attempt) * 1000;
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      return res;
    } catch (err) {
      lastError = err as Error;
      if (attempt < maxRetries - 1) {
        const backoff = Math.pow(2, attempt) * 1000;
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }
  throw lastError ?? new Error("fetch failed after retries");
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/** Redact API keys from query parameters in URLs for safe error messages */
function redactUrl(url: string): string {
  return url.replace(/([?&])(api[-_]?key|key|token|access_token)=[^&]+/gi, "$1$2=REDACTED");
}

function assertOk(raw: string, status: number, context: string, url?: string): void {
  if (status >= 400) {
    const urlSuffix = url ? ` (${redactUrl(url)})` : "";
    throw new InfraError(
      `${context}: API returned ${status}${urlSuffix}: ${raw.slice(0, 300)}`,
      status,
    );
  }
}

function parseJsonResponse(raw: string, status: number, context: string, url?: string): unknown {
  if (!raw) throw new Error(`${context}: empty response (status ${status})`);
  assertOk(raw, status, context, url);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${context}: failed to parse JSON (status ${status}): ${raw.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------

/** Normalize \r\n to \n for SSE parsing (some providers use \r\n) */
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/** Parse data-only SSE (OpenAI Chat Completions, Gemini) */
function parseDataOnlySSE(text: string): { data: unknown }[] {
  return normalizeLineEndings(text)
    .split("\n\n")
    .filter((block) => block.startsWith("data: ") && block.trim() !== "data: [DONE]")
    .map((block) => {
      // Rejoin continuation lines (data split across lines)
      const json = block
        .split("\n")
        .map((line) => (line.startsWith("data: ") ? line.slice(6) : line))
        .join("");
      try {
        return { data: JSON.parse(json) };
      } catch (err) {
        throw new Error(
          `Malformed SSE JSON in frame: ${json.slice(0, 100)} — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
}

/** Parse typed SSE (event: + data: format — Responses API, Claude) */
function parseTypedSSE(text: string): { type: string; data: unknown }[] {
  return normalizeLineEndings(text)
    .split("\n\n")
    .filter((block) => block.includes("event: ") && block.includes("data: "))
    .map((block) => {
      const eventMatch = block.match(/^event: (.*)$/m);
      if (!eventMatch) {
        throw new Error("Malformed SSE block: " + block.slice(0, 100));
      }
      // Handle multi-line data: collect all data lines and join them
      const json = block
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .join("");
      if (!json) {
        throw new Error("Malformed SSE block (no data): " + block.slice(0, 100));
      }
      try {
        return {
          type: eventMatch[1],
          data: JSON.parse(json),
        };
      } catch (err) {
        throw new Error(
          `Malformed SSE JSON in frame: ${json.slice(0, 100)} — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
}

function toSSEEventShapes(events: { type: string; data: unknown }[]): SSEEventShape[] {
  return events.map((e) => ({
    type: e.type,
    dataShape: extractShape(e.data),
  }));
}

// ---------------------------------------------------------------------------
// Infra-error tagging
// ---------------------------------------------------------------------------

function withInfraErrorTag<T>(provider: string, fn: () => Promise<T>): Promise<T> {
  return fn().catch((err: unknown) => {
    // A canary skip is an HONEST "provider unavailable" signal, not a drift
    // finding — never re-tag it as an InfraError (that would poison the drift
    // baseline via exit-5 quarantine). Let it propagate for the leg to catch.
    if (err instanceof FalCanarySkip) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    const status = err instanceof InfraError ? err.status : 0;
    throw new InfraError(`INFRA_ERROR: ${provider} — ${msg}`, status);
  });
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

export async function openaiChatNonStreaming(
  config: ProviderConfig,
  messages: { role: string; content: string }[],
  tools?: object[],
): Promise<FetchResult> {
  return withInfraErrorTag("OpenAI Chat", async () => {
    const body: Record<string, unknown> = {
      model: "gpt-4o-mini",
      messages,
      stream: false,
      max_tokens: 10,
    };
    if (tools) body.tools = tools;

    const res = await fetchWithRetry("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const raw = await res.text();
    return { status: res.status, body: parseJsonResponse(raw, res.status, "OpenAI Chat"), raw };
  });
}

export async function openaiChatStreaming(
  config: ProviderConfig,
  messages: { role: string; content: string }[],
  tools?: object[],
): Promise<StreamResult> {
  return withInfraErrorTag("OpenAI Chat", async () => {
    const body: Record<string, unknown> = {
      model: "gpt-4o-mini",
      messages,
      stream: true,
      max_tokens: 10,
    };
    if (tools) body.tools = tools;

    const res = await fetchWithRetry("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const raw = await res.text();
    assertOk(raw, res.status, "OpenAI Chat streaming");
    const parsed = parseDataOnlySSE(raw);
    const rawEvents = parsed.map((p) => ({
      type: "chat.completion.chunk",
      data: p.data,
    }));
    return {
      status: res.status,
      events: toSSEEventShapes(rawEvents),
      rawEvents,
    };
  });
}

export async function openaiResponsesNonStreaming(
  config: ProviderConfig,
  input: object[],
  tools?: object[],
): Promise<FetchResult> {
  return withInfraErrorTag("OpenAI Responses", async () => {
    const body: Record<string, unknown> = {
      model: "gpt-4o-mini",
      input,
      stream: false,
      max_output_tokens: 50,
    };
    if (tools) body.tools = tools;

    const res = await fetchWithRetry("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const raw = await res.text();
    return {
      status: res.status,
      body: parseJsonResponse(raw, res.status, "OpenAI Responses"),
      raw,
    };
  });
}

export async function openaiResponsesStreaming(
  config: ProviderConfig,
  input: object[],
  tools?: object[],
): Promise<StreamResult> {
  return withInfraErrorTag("OpenAI Responses", async () => {
    const body: Record<string, unknown> = {
      model: "gpt-4o-mini",
      input,
      stream: true,
      max_output_tokens: 50,
    };
    if (tools) body.tools = tools;

    const res = await fetchWithRetry("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const raw = await res.text();
    assertOk(raw, res.status, "OpenAI Responses streaming");
    const rawEvents = parseTypedSSE(raw);
    return {
      status: res.status,
      events: toSSEEventShapes(rawEvents),
      rawEvents,
    };
  });
}

// ---------------------------------------------------------------------------
// Anthropic Claude
// ---------------------------------------------------------------------------

export async function anthropicNonStreaming(
  config: ProviderConfig,
  messages: { role: string; content: string }[],
  tools?: object[],
): Promise<FetchResult> {
  return withInfraErrorTag("Anthropic", async () => {
    const body: Record<string, unknown> = {
      model: "claude-haiku-4-5-20251001",
      messages,
      max_tokens: 10,
      stream: false,
    };
    if (tools) body.tools = tools;

    const res = await fetchWithRetry("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    const raw = await res.text();
    return { status: res.status, body: parseJsonResponse(raw, res.status, "Anthropic"), raw };
  });
}

export async function anthropicStreaming(
  config: ProviderConfig,
  messages: { role: string; content: string }[],
  tools?: object[],
): Promise<StreamResult> {
  return withInfraErrorTag("Anthropic", async () => {
    const body: Record<string, unknown> = {
      model: "claude-haiku-4-5-20251001",
      messages,
      max_tokens: 10,
      stream: true,
    };
    if (tools) body.tools = tools;

    const res = await fetchWithRetry("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    const raw = await res.text();
    assertOk(raw, res.status, "Anthropic streaming");
    const rawEvents = parseTypedSSE(raw);
    return {
      status: res.status,
      events: toSSEEventShapes(rawEvents),
      rawEvents,
    };
  });
}

// ---------------------------------------------------------------------------
// Google Gemini
// ---------------------------------------------------------------------------

export async function geminiNonStreaming(
  config: ProviderConfig,
  contents: object[],
  tools?: object[],
): Promise<FetchResult> {
  return withInfraErrorTag("Gemini", async () => {
    // Gemini 2.5+ uses thinking tokens from the output budget, so we need
    // more headroom than other providers to get actual content back
    const body: Record<string, unknown> = {
      contents,
      generationConfig: { maxOutputTokens: 100 },
    };
    if (tools) body.tools = tools;

    // Gemini requires API key as query parameter per Google's REST API design
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${config.apiKey}`;
    const res = await fetchWithRetry(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const raw = await res.text();
    return { status: res.status, body: parseJsonResponse(raw, res.status, "Gemini", url), raw };
  });
}

export async function geminiStreaming(
  config: ProviderConfig,
  contents: object[],
  tools?: object[],
): Promise<StreamResult> {
  return withInfraErrorTag("Gemini", async () => {
    const body: Record<string, unknown> = {
      contents,
      generationConfig: { maxOutputTokens: 100 },
    };
    if (tools) body.tools = tools;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=${config.apiKey}`;
    const res = await fetchWithRetry(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const raw = await res.text();
    assertOk(raw, res.status, "Gemini streaming", url);
    const parsed = parseDataOnlySSE(raw);
    const rawEvents = parsed.map((p) => ({
      type: "gemini.chunk",
      data: p.data,
    }));
    return {
      status: res.status,
      events: toSSEEventShapes(rawEvents),
      rawEvents,
    };
  });
}

// ---------------------------------------------------------------------------
// Google Gemini Interactions API (Beta)
// ---------------------------------------------------------------------------

export async function geminiInteractionsNonStreaming(
  config: ProviderConfig,
  input: string,
  tools?: object[],
): Promise<FetchResult> {
  return withInfraErrorTag("Gemini Interactions", async () => {
    const body: Record<string, unknown> = {
      model: "gemini-2.5-flash",
      input,
      stream: false,
    };
    if (tools) body.tools = tools;

    const res = await fetchWithRetry(
      `https://generativelanguage.googleapis.com/v1beta/interactions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": config.apiKey,
        },
        body: JSON.stringify(body),
      },
    );

    const raw = await res.text();
    return {
      status: res.status,
      body: parseJsonResponse(raw, res.status, "Gemini Interactions"),
      raw,
    };
  });
}

export async function geminiInteractionsStreaming(
  config: ProviderConfig,
  input: string,
  tools?: object[],
): Promise<StreamResult> {
  return withInfraErrorTag("Gemini Interactions", async () => {
    const body: Record<string, unknown> = {
      model: "gemini-2.5-flash",
      input,
      stream: true,
    };
    if (tools) body.tools = tools;

    const res = await fetchWithRetry(
      `https://generativelanguage.googleapis.com/v1beta/interactions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": config.apiKey,
        },
        body: JSON.stringify(body),
      },
    );

    const raw = await res.text();
    assertOk(raw, res.status, "Gemini Interactions streaming");
    // Interactions uses data-only SSE (data: {...}\n\n) with event_type inside the JSON
    const parsed = parseDataOnlySSE(raw);
    const rawEvents = parsed.map((p) => {
      const data = p.data as Record<string, unknown>;
      return {
        type: (data.event_type as string) ?? "unknown",
        data: data,
      };
    });
    return {
      status: res.status,
      events: toSSEEventShapes(rawEvents),
      rawEvents,
    };
  });
}

export async function geminiInteractionsNonStreamingSteps(
  config: ProviderConfig,
  input: string,
  tools?: object[],
): Promise<FetchResult> {
  return withInfraErrorTag("Gemini Interactions", async () => {
    const body: Record<string, unknown> = {
      model: "gemini-2.5-flash",
      input: [{ type: "user_input", content: [{ type: "text", text: input }] }],
      stream: false,
    };
    if (tools) body.tools = tools;

    const res = await fetchWithRetry(
      `https://generativelanguage.googleapis.com/v1beta/interactions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": config.apiKey,
        },
        body: JSON.stringify(body),
      },
    );

    const raw = await res.text();
    return {
      status: res.status,
      body: parseJsonResponse(raw, res.status, "Gemini Interactions"),
      raw,
    };
  });
}

export async function geminiInteractionsStreamingSteps(
  config: ProviderConfig,
  input: string,
  tools?: object[],
): Promise<StreamResult> {
  return withInfraErrorTag("Gemini Interactions", async () => {
    const body: Record<string, unknown> = {
      model: "gemini-2.5-flash",
      input: [{ type: "user_input", content: [{ type: "text", text: input }] }],
      stream: true,
    };
    if (tools) body.tools = tools;

    const res = await fetchWithRetry(
      `https://generativelanguage.googleapis.com/v1beta/interactions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": config.apiKey,
        },
        body: JSON.stringify(body),
      },
    );

    const raw = await res.text();
    assertOk(raw, res.status, "Gemini Interactions streaming");
    // Interactions uses data-only SSE (data: {...}\n\n) with event_type inside the JSON
    const parsed = parseDataOnlySSE(raw);
    const rawEvents = parsed.map((p) => {
      const data = p.data as Record<string, unknown>;
      return {
        type: (data.event_type as string) ?? "unknown",
        data: data,
      };
    });
    return {
      status: res.status,
      events: toSSEEventShapes(rawEvents),
      rawEvents,
    };
  });
}

// ---------------------------------------------------------------------------
// OpenAI Embeddings
// ---------------------------------------------------------------------------

export async function openaiEmbeddings(
  config: ProviderConfig,
  input: string | string[],
): Promise<FetchResult> {
  return withInfraErrorTag("OpenAI Embeddings", async () => {
    const body = {
      model: "text-embedding-3-small",
      input,
    };

    const res = await fetchWithRetry("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const raw = await res.text();
    return {
      status: res.status,
      body: parseJsonResponse(raw, res.status, "OpenAI Embeddings"),
      raw,
    };
  });
}

// ---------------------------------------------------------------------------
// Model listing
// ---------------------------------------------------------------------------

export async function listOpenAIModels(apiKey: string): Promise<string[]> {
  return withInfraErrorTag("OpenAI Models", async () => {
    const res = await fetchWithRetry("https://api.openai.com/v1/models", {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    const raw = await res.text();
    const json = parseJsonResponse(raw, res.status, "OpenAI model list") as {
      data: { id: string }[];
    };
    return json.data.map((m) => m.id);
  });
}

export async function listAnthropicModels(apiKey: string): Promise<string[]> {
  return withInfraErrorTag("Anthropic Models", async () => {
    const res = await fetchWithRetry("https://api.anthropic.com/v1/models", {
      method: "GET",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
    });

    const raw = await res.text();
    const json = parseJsonResponse(raw, res.status, "Anthropic model list") as {
      data: { id: string }[];
    };
    return json.data.map((m) => m.id);
  });
}

export async function listGeminiModels(apiKey: string): Promise<string[]> {
  return withInfraErrorTag("Gemini Models", async () => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
    const res = await fetchWithRetry(url, { method: "GET" });

    const raw = await res.text();
    const json = parseJsonResponse(raw, res.status, "Gemini model list", url) as {
      models: { name: string }[];
    };
    // Gemini returns "models/gemini-2.5-flash" — strip prefix
    return json.models.map((m) => m.name.replace(/^models\//, ""));
  });
}

/**
 * BytePlus Ark REST base URL. Ark is region-partitioned and a key minted in one
 * region does not authenticate in another, so the region is overridable via
 * `ARK_BASE_URL` — a regional mismatch is a CONFIGURATION problem and must not
 * be reported as vendor drift.
 *
 * The unauthenticated error envelope was verified identical on
 * `ark.ap-southeast.bytepluses.com` and `ark.cn-beijing.volces.com` (2026-09-10).
 */
export const BYTEPLUS_ARK_DEFAULT_BASE_URL = "https://ark.ap-southeast.bytepluses.com";

/** Resolve the Ark base URL for a probe (env override wins, no trailing slash). */
export function bytePlusArkBaseUrl(override?: string): string {
  const raw = override ?? process.env.ARK_BASE_URL ?? BYTEPLUS_ARK_DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, "");
}

/** What an Ark probe hands back to the drift leg: status, error header, body. */
export interface BytePlusArkProbeResult {
  status: number;
  /** Ark's `x-error-code` response header, or null when absent. */
  errorCodeHeader: string | null;
  /** Parsed JSON body, or the raw text when the body is not JSON. */
  body: unknown;
}

/** Injectable transport, so a drift leg can mutate the wire response it sees. */
export type ArkFetch = (url: string, init: RequestInit) => Promise<Response>;

async function readArkResponse(res: Response): Promise<BytePlusArkProbeResult> {
  const raw = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    body = raw;
  }
  return { status: res.status, errorCodeHeader: res.headers.get("x-error-code"), body };
}

/**
 * BytePlus Ark's FREE, KEYLESS reality probe: GET a task id on the real video
 * endpoint with NO (or a deliberately malformed) `Authorization` header. Ark
 * answers from its auth layer, before any billing or resource lookup, so this
 * costs nothing, needs no account, and can run on every drift run.
 *
 * It is the ONLY check on this surface with a real vendor-side failure mode.
 * What it watches is the ERROR ENVELOPE aimock's byteplus surface emits: the
 * `{ error: { code, message, param, type } }` object and the `x-error-code`
 * header. If Ark restructures that envelope, this goes red.
 *
 * `auth: "missing"` sends no header; `auth: "malformed"` sends a bearer that
 * cannot be a key. Both were observed live (2026-09-10) — see the drift leg for
 * the exact observed values; NOTHING here authors a wire value.
 *
 * Returns rather than asserts, so the drift leg owns the expectation. Network
 * failure propagates as an {@link InfraError} (status 0) for the leg to convert
 * into an HONEST SKIP — an unreachable vendor is not drift.
 */
export async function probeBytePlusArkAuthEnvelope(
  options: { auth?: "missing" | "malformed"; baseUrl?: string; fetchImpl?: ArkFetch } = {},
): Promise<BytePlusArkProbeResult> {
  const { auth = "missing", baseUrl, fetchImpl } = options;
  return withInfraErrorTag("BytePlus Ark Auth Envelope Probe", async () => {
    const url =
      `${bytePlusArkBaseUrl(baseUrl)}/api/v3/contents/generations/tasks/` +
      "cgt-aimock-drift-probe-does-not-exist";
    const headers: Record<string, string> =
      auth === "malformed" ? { Authorization: "Bearer aimock-drift-probe-not-a-key" } : {};
    const init: RequestInit = { method: "GET", headers };
    const res = fetchImpl ? await fetchImpl(url, init) : await fetchWithRetry(url, init);
    return readArkResponse(res);
  });
}

/**
 * BytePlus Ark's cheapest AUTHENTICATED video-surface probe: GET a task id that
 * cannot exist. Ark has NO free video-model listing endpoint (which is what
 * makes the OpenRouter canary free), and a real generation costs money, so this
 * probes the error envelope instead of the success shape.
 *
 * Returns the status and parsed body rather than asserting, so the drift leg
 * owns the expectation. NOTE: the 404 assumption is UNVERIFIED against live Ark
 * — if Ark answers a bad task id with 400, or 200-with-an-error-body, this
 * canary must be rewritten or dropped rather than "fixed" by loosening it. The
 * KEYLESS probe above is the one that carries this surface today.
 *
 * READ A 401/403 HERE AS A REGION MISMATCH FIRST, not as drift. An ARK_API_KEY
 * minted outside {@link BYTEPLUS_ARK_DEFAULT_BASE_URL}'s region does not
 * authenticate against that host; point `ARK_BASE_URL` at the region the key
 * was minted in rather than loosening this canary.
 */
export async function probeBytePlusArkUnknownTask(
  apiKey: string,
  options: { baseUrl?: string; fetchImpl?: ArkFetch } = {},
): Promise<BytePlusArkProbeResult> {
  return withInfraErrorTag("BytePlus Ark Task Probe", async () => {
    const url =
      `${bytePlusArkBaseUrl(options.baseUrl)}/api/v3/contents/generations/tasks/` +
      "cgt-aimock-drift-probe-does-not-exist";
    const init: RequestInit = { method: "GET", headers: { Authorization: `Bearer ${apiKey}` } };
    const res = options.fetchImpl
      ? await options.fetchImpl(url, init)
      : await fetchWithRetry(url, init);
    return readArkResponse(res);
  });
}

/**
 * List OpenRouter's video-capable models via the dedicated (FREE, no
 * generation) listing endpoint `GET /api/v1/videos/models`. Video models do
 * NOT appear in the plain `/api/v1/models` listing, hence the dedicated route
 * (see src/openrouter-video.ts handleOpenRouterVideoModels). Returns the raw
 * provider-prefixed slugs (e.g. "kwaivgi/kling-v3.0-pro", "bytedance/seedance-2.0",
 * "google/veo-3.1"). This is the cost-safe daily live-reality canary for the
 * OpenRouter video proxy surface — it authenticates and reads metadata only,
 * never submitting a paid generation job.
 */
export async function listOpenRouterVideoModels(apiKey: string): Promise<string[]> {
  return withInfraErrorTag("OpenRouter Video Models", async () => {
    const url = "https://openrouter.ai/api/v1/videos/models";
    const res = await fetchWithRetry(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    const raw = await res.text();
    const json = parseJsonResponse(raw, res.status, "OpenRouter video model list", url) as {
      data: { id: string }[];
    };
    return json.data.map((m) => m.id);
  });
}

/** One OpenRouter model-catalog entry (only `id` is relied upon; extras kept). */
export interface OpenRouterModelObject {
  id: string;
  [key: string]: unknown;
}

/**
 * List OpenRouter's chat/LLM models via the public catalog `GET
 * /api/v1/models`. This is the cost-safe daily live-reality canary for the
 * OpenRouter CHAT surface (`src/openrouter-chat.ts` handleOpenRouterModels /
 * shapeOpenRouterCompletion) — it authenticates and reads model METADATA only,
 * NEVER submitting a paid chat completion. Returns the raw catalog objects
 * (provider-prefixed slugs like "openai/gpt-4o", "anthropic/claude-3.5-sonnet",
 * "google/gemini-2.0-flash-001") so the leg can assert both the author families
 * aimock mirrors AND that the per-model object schema has not drifted.
 */
export async function listOpenRouterModels(apiKey: string): Promise<OpenRouterModelObject[]> {
  return withInfraErrorTag("OpenRouter Models", async () => {
    const url = "https://openrouter.ai/api/v1/models";
    const res = await fetchWithRetry(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    const raw = await res.text();
    const json = parseJsonResponse(raw, res.status, "OpenRouter model list", url) as {
      data: OpenRouterModelObject[];
    };
    // Guard the top-level catalog shape: a null/primitive body or a
    // missing/non-array `data` is itself a drift the canary must surface as a
    // NAMED error, not an opaque downstream TypeError. Check the container
    // FIRST so `JSON.parse("null")` (which clears assertOk) can't throw before
    // our named error fires.
    if (
      json === null ||
      typeof json !== "object" ||
      !Array.isArray((json as { data?: unknown }).data)
    ) {
      throw new Error(
        `OpenRouter /models returned no data array (got ${typeof (json as { data?: unknown })?.data}) — catalog shape drift`,
      );
    }
    return json.data;
  });
}

// ---------------------------------------------------------------------------
// fal.ai queue lifecycle
// ---------------------------------------------------------------------------

/**
 * Raised by the live fal canary when fal ITSELF is unavailable for an
 * infra/auth/balance/rate reason (401 | 402 | 403 incl. "user locked" /
 * "exhausted balance" | 429 | 5xx). This is NOT drift — the live leg catches it
 * and SKIPS (exactly like the no-key skip), so a locked fal account never
 * poisons the drift baseline.
 *
 * Deliberately NOT an `InfraError`: `withInfraErrorTag` re-throws it untouched,
 * so the drift collector never sees an unparseable INFRA_ERROR to quarantine
 * (exit 5). A genuine SHAPE drift (a 2xx whose envelope diverges from the mock)
 * is never an infra status, so it still fails and reports drift as before.
 */
export class FalCanarySkip extends Error {
  readonly status: number;

  constructor(reason: string, status: number) {
    super(reason);
    this.name = "FalCanarySkip";
    this.status = status;
  }
}

/**
 * True when a fal HTTP status means fal is UNAVAILABLE (auth/balance/rate/5xx),
 * not that the response envelope drifted. Only these convert to a skip — every
 * other status (incl. the expected 400 `ALREADY_COMPLETED` cancel race, or a
 * 2xx with a wrong shape) flows through normally so real drift still fails.
 */
function isFalInfraStatus(status: number): boolean {
  return status === 401 || status === 402 || status === 403 || status === 429 || status >= 500;
}

/**
 * Throw a {@link FalCanarySkip} if `status` is an infra-class status. Called at
 * each live lifecycle step (submit, status) BEFORE the hard `parseJsonResponse`
 * → `InfraError` path, so an unavailable fal account skips instead of poisoning
 * the baseline.
 */
function skipIfFalUnavailable(step: string, status: number, raw: string): void {
  if (!isFalInfraStatus(status)) return;
  const locked = /user is locked|exhausted balance/i.test(raw) ? " user-locked" : "";
  throw new FalCanarySkip(
    `fal infra/auth unavailable (${status}${locked}) at ${step} — skipping live canary`,
    status,
  );
}

/** One lifecycle step's HTTP status + parsed JSON envelope. */
interface FalQueueStep {
  status: number;
  body: Record<string, unknown> | null;
}

/** The three cost-safe queue envelopes the canary observes. */
export interface FalQueueCanaryResult {
  submit: FalQueueStep;
  statusPoll: FalQueueStep;
  cancel: FalQueueStep;
}

/**
 * Cost-safe live queue-lifecycle canary for the fal.ai queue surface
 * (`src/fal.ts` handleFal / walkFalQueue). Drives the REAL fal queue API and
 * returns the SUBMIT, STATUS, and CANCEL envelope bodies for drift comparison.
 *
 * LIFECYCLE: a funded fal job does NOT reliably sit in `IN_QUEUE` — a fast
 * model (e.g. `flux/schnell`) returns `status:"IN_PROGRESS"` on the submit
 * envelope IMMEDIATELY. This canary is state-agnostic: it drives submit →
 * status → CANCEL regardless of the reported state, and the caller's
 * assertions accept any valid queued/running/completed status. The cancel is
 * issued even if the status poll throws (see the finally-style flow below) so a
 * job is never left to run.
 *
 * COST SAFETY: fal bills COMPUTE only when a queued job actually RUNS. The
 * cheapest reliably-available model is used and the job is cancelled ASAP. The
 * `response_url` (completed result) endpoint is NEVER fetched — that is the
 * only paid retrieval, and its envelope stays STATIC-only. Residual: if the
 * model races to completion before the immediate cancel lands, at most one
 * sub-cent generation is billed.
 *
 * INFRA RESILIENCE: an unavailable fal account (401/402/403 locked-or-exhausted
 * / 429 / 5xx) raises a {@link FalCanarySkip} at the submit or status step —
 * an honest SKIP the live leg catches, NOT an InfraError that would quarantine
 * the drift baseline. A 2xx-with-wrong-shape is never an infra status, so
 * genuine envelope drift still reports critical.
 */
export async function falQueueLifecycleCanary(
  apiKey: string,
  modelId: string,
  input: object,
): Promise<FalQueueCanaryResult> {
  return withInfraErrorTag("fal Queue Lifecycle", async () => {
    const authHeaders = { Authorization: `Key ${apiKey}` };

    // 1. Submit — enqueues the job. Free; compute is billed only when it RUNS.
    const submitUrl = `https://queue.fal.run/${modelId}`;
    const submitRes = await fetchWithRetry(submitUrl, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const submitRaw = await submitRes.text();
    // fal unavailable (locked/exhausted-balance/rate/5xx) → honest skip, NOT a
    // hard InfraError. Fires before the job is enqueued, so there is no cost and
    // nothing to cancel.
    skipIfFalUnavailable("submit", submitRes.status, submitRaw);
    const submitBody = parseJsonResponse(
      submitRaw,
      submitRes.status,
      "fal queue submit",
      submitUrl,
    ) as Record<string, unknown>;

    // fal returns absolute lifecycle URLs; fall back to the documented layout.
    const requestId = String(submitBody.request_id ?? "");
    const statusUrl =
      typeof submitBody.status_url === "string"
        ? submitBody.status_url
        : `${submitUrl}/requests/${requestId}/status`;
    const cancelUrl =
      typeof submitBody.cancel_url === "string"
        ? submitBody.cancel_url
        : `${submitUrl}/requests/${requestId}/cancel`;

    // 2. Status — metadata only (never the result payload). Capture any error so
    // the cancel below still fires: leaving a job to RUN is the only cost risk.
    let statusPoll: FalQueueStep | null = null;
    let statusError: unknown = null;
    try {
      const statusRes = await fetchWithRetry(statusUrl, { method: "GET", headers: authHeaders });
      const statusRaw = await statusRes.text();
      // fal unavailable mid-lifecycle → skip (rethrown after cancel fires, so a
      // job is never left to run). A FalCanarySkip is preserved end-to-end.
      skipIfFalUnavailable("status", statusRes.status, statusRaw);
      statusPoll = {
        status: statusRes.status,
        body: parseJsonResponse(
          statusRaw,
          statusRes.status,
          "fal queue status",
          statusUrl,
        ) as Record<string, unknown>,
      };
    } catch (err) {
      statusError = err;
    }

    // 3. Cancel IMMEDIATELY — while IN_QUEUE, no compute is charged. Real fal
    // returns 200 `{status:"CANCELLATION_REQUESTED"}` (or 400
    // `{status:"ALREADY_COMPLETED"}` on a race); both are valid envelopes.
    const cancelRes = await fetchWithRetry(cancelUrl, { method: "PUT", headers: authHeaders });
    const cancelRaw = await cancelRes.text();
    let cancelBody: Record<string, unknown> | null = null;
    try {
      cancelBody = cancelRaw ? (JSON.parse(cancelRaw) as Record<string, unknown>) : null;
    } catch {
      cancelBody = null;
    }

    // Surface a status-poll failure only after cancellation is guaranteed.
    if (statusError) throw statusError;

    return {
      submit: { status: submitRes.status, body: submitBody },
      statusPoll: statusPoll!,
      cancel: { status: cancelRes.status, body: cancelBody },
    };
  });
}
