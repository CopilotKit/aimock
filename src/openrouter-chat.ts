import type * as http from "node:http";
import type {
  ChatCompletion,
  ChatCompletionRequest,
  Fixture,
  HandlerDefaults,
  OpenRouterUsageExtras,
  ResponseOverrides,
  SSEChunk,
} from "./types.js";
import type { Journal } from "./journal.js";
import { flattenHeaders } from "./helpers.js";
import { collect } from "./response/catalog/collect.js";
import { renderOpenRouterChatModels } from "./response/catalog/render.js";

/**
 * OpenRouter chat/LLM router shaping. aimock detects an OpenRouter request by
 * the ORIGINAL request path (before `normalizeCompatPath` erases it) starting
 * with the OpenRouter canonical base `/api/v1/` — mirroring a real client that
 * points an OpenAI SDK at `baseURL: https://openrouter.ai/api/v1`. When a
 * request is OpenRouter, the same OpenAI-compatible chat response is shaped
 * with OpenRouter's distinguishing fields (a `gen-` id prefix, a top-level
 * `provider`, `native_finish_reason`, and a rich cost-bearing `usage`) and the
 * `models[]` fallback array is simulated deterministically against fixtures.
 * OpenAI (`/v1/...`) callers are left byte-for-byte unchanged.
 *
 * The shaping is applied as a post-pass over the objects the existing OpenAI
 * builders produce (never a fork of those builders), so every OpenAI code path
 * is untouched.
 */

/** OpenRouter's canonical API base — the detection prefix. */
export const OPENROUTER_BASE_PREFIX = "/api/v1/";

const OPENAI_ID_PREFIX = "chatcmpl-";
const OPENROUTER_ID_PREFIX = "gen-";

/**
 * Return true when the ORIGINAL request path marks an OpenRouter request. Must
 * be evaluated on the pre-normalization pathname: `normalizeCompatPath`
 * rewrites `/api/v1/chat/completions` → `/v1/chat/completions`, erasing the
 * `/api/v1/` signal.
 */
export function isOpenRouterPath(originalPathname: string): boolean {
  return originalPathname.startsWith(OPENROUTER_BASE_PREFIX);
}

/**
 * Derive the default OpenRouter `provider` from a model slug: the author
 * segment before the first `/` (`openai/gpt-4o` → `"openai"`). A slug without
 * a `/` yields the whole slug. An absent/empty slug — a request that never set
 * `model` yet matched a model-less fixture — yields `""` rather than throwing
 * (guards against a `TypeError` becoming a generic 500).
 */
export function deriveOpenRouterProvider(model: string | undefined): string {
  if (!model) return "";
  const slash = model.indexOf("/");
  return slash === -1 ? model : model.slice(0, slash);
}

/**
 * Build the OpenRouter fallback candidate list `[body.model, ...body.models]`,
 * de-duplicated with insertion order preserved. A request without `models`
 * yields just `[body.model]` — identical to today's single-model behavior.
 */
export function buildOpenRouterCandidates(body: ChatCompletionRequest): string[] {
  const raw = [body.model, ...(Array.isArray(body.models) ? body.models : [])];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of raw) {
    if (typeof m !== "string" || m.length === 0) continue;
    if (seen.has(m)) continue;
    seen.add(m);
    out.push(m);
  }
  return out;
}

/** Rewrite an auto-generated `chatcmpl-` id to OpenRouter's `gen-` prefix. */
function toGenId(id: string): string {
  return id.startsWith(OPENAI_ID_PREFIX)
    ? OPENROUTER_ID_PREFIX + id.slice(OPENAI_ID_PREFIX.length)
    : id;
}

/**
 * The resolved OpenRouter shaping context for one response. `provider` and the
 * always-present `cost`/`cost_details` are computed here; the detail
 * breakdowns and `is_byok` are carried only when a fixture overrode them.
 */
export interface OpenRouterShaping {
  provider: string;
  nativeFinishReason?: string;
  usageExtras: OpenRouterUsageExtras;
}

/**
 * `usage` keys that are already accounted for elsewhere and must therefore NOT
 * be re-emitted through the forward-compat passthrough below: the canonical
 * token counts (and their per-provider aliases), which `resolveUsage` folds into
 * `prompt_tokens` / `completion_tokens` / `total_tokens` on the base usage
 * object, plus every field this function shapes explicitly.
 */
const SHAPED_OR_CANONICAL_USAGE_KEYS = new Set([
  "prompt_tokens",
  "completion_tokens",
  "total_tokens",
  "input_tokens",
  "output_tokens",
  "promptTokenCount",
  "candidatesTokenCount",
  "totalTokenCount",
  "cost",
  "cost_details",
  "prompt_tokens_details",
  "completion_tokens_details",
  "is_byok",
]);

/**
 * Keys that must never flow through the passthrough assignment below: a
 * JSON-parsed usage frame (fixtures are attacker-adjacent — they mirror upstream
 * provider responses) can carry a real own `__proto__`/`constructor`/`prototype`
 * key, and a plain `usageExtras[key] = value` for one of those hits the
 * prototype setter, corrupting the emitted object's prototype chain instead of
 * emitting a data field. Real providers never send these, so skipping is safe.
 */
const UNSAFE_PROTO_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Resolve the shaping context from a fixture's response overrides and the
 * winning model slug. `provider` defaults to the winning slug's author;
 * `native_finish_reason` mirrors `finish_reason` unless overridden. `cost` and
 * `cost_details` are NULLABLE — emitted only when the fixture supplies a `cost`
 * (never defaulted to 0); when emitted, `cost_details` carries all three
 * upstream fields (a partial object breaks the canonical SDK). The token-detail
 * breakdowns and `is_byok` are included only when the fixture set them, and an
 * emitted breakdown always carries its required member (`cached_tokens` /
 * `reasoning_tokens`).
 */
export function resolveOpenRouterShaping(
  overrides: ResponseOverrides | undefined,
  winningModel: string | undefined,
): OpenRouterShaping {
  const u = overrides?.usage;
  const usageExtras: OpenRouterUsageExtras = {};
  if (u?.cost !== undefined) {
    usageExtras.cost = u.cost;
    const cd = u.cost_details;
    usageExtras.cost_details = {
      ...(cd ?? {}),
      upstream_inference_cost: cd?.upstream_inference_cost ?? 0,
      upstream_inference_prompt_cost: cd?.upstream_inference_prompt_cost ?? 0,
      upstream_inference_completions_cost: cd?.upstream_inference_completions_cost ?? 0,
    };
  }
  if (u?.prompt_tokens_details !== undefined) {
    usageExtras.prompt_tokens_details = {
      ...u.prompt_tokens_details,
      cached_tokens: u.prompt_tokens_details.cached_tokens ?? 0,
    };
  }
  if (u?.completion_tokens_details !== undefined) {
    usageExtras.completion_tokens_details = {
      ...u.completion_tokens_details,
      reasoning_tokens: u.completion_tokens_details.reasoning_tokens ?? 0,
    };
  }
  if (u?.is_byok !== undefined) {
    usageExtras.is_byok = u.is_byok;
  }
  // Forward-compat passthrough (#368): a fixture's `usage` may carry provider
  // fields aimock does not model — typically written by the recorder straight
  // from a real upstream usage frame (OpenRouter `native_tokens_prompt`,
  // `native_tokens_completion`, …). Emit them verbatim rather than silently
  // dropping them, so a recorded usage object round-trips on replay. The
  // canonical token counts and every field shaped above are excluded: those are
  // already resolved onto the base usage object (see helpers.ts `resolveUsage`)
  // or handled with their own required-member defaults.
  for (const [key, value] of Object.entries(u ?? {})) {
    if (value === undefined) continue;
    if (SHAPED_OR_CANONICAL_USAGE_KEYS.has(key)) continue;
    if (UNSAFE_PROTO_KEYS.has(key)) continue;
    usageExtras[key] = value;
  }
  return {
    provider: overrides?.provider ?? deriveOpenRouterProvider(winningModel),
    ...(overrides?.nativeFinishReason !== undefined && {
      nativeFinishReason: overrides.nativeFinishReason,
    }),
    usageExtras,
  };
}

/** Merge the OpenRouter usage extras onto an existing (OpenAI-shape) usage object. */
function augmentUsage<T extends object>(
  usage: T,
  shaping: OpenRouterShaping,
): T & OpenRouterUsageExtras {
  return { ...usage, ...shaping.usageExtras };
}

/** Resolve a choice's native_finish_reason (mirrors finish_reason unless overridden). */
function nativeFinish(finishReason: string | null, shaping: OpenRouterShaping): string | null {
  if (finishReason == null) return null;
  return shaping.nativeFinishReason ?? finishReason;
}

/**
 * Shape a non-streaming OpenAI completion into OpenRouter form, in place, to
 * match real OpenRouter bytes (or-capture/chat-nonstream.json): `gen-` id
 * (unless the fixture pinned `id`), top-level `provider`, `service_tier: null`,
 * an always-present `system_fingerprint` (null when unset — the canonical
 * `@openrouter/sdk` requires it), per-choice `native_finish_reason`, a
 * `message.reasoning` field (mirrors `reasoning_content`, else null), and
 * cost-bearing `usage`.
 */
export function shapeOpenRouterCompletion(
  completion: ChatCompletion,
  shaping: OpenRouterShaping,
  idOverridden: boolean,
): ChatCompletion {
  if (!idOverridden) completion.id = toGenId(completion.id);
  completion.provider = shaping.provider;
  if (completion.system_fingerprint === undefined) completion.system_fingerprint = null;
  if (completion.service_tier === undefined) completion.service_tier = null;
  for (const choice of completion.choices) {
    // Non-streaming finish_reason is always a string, so native mirrors it.
    choice.native_finish_reason = shaping.nativeFinishReason ?? choice.finish_reason;
    if (choice.message.reasoning === undefined) {
      choice.message.reasoning = choice.message.reasoning_content ?? null;
    }
  }
  completion.usage = augmentUsage(completion.usage, shaping);
  return completion;
}

/**
 * Shape streaming OpenAI chunks into OpenRouter form, in place, to match real
 * OpenRouter bytes (or-capture/chat-stream.sse): EVERY chunk carries the
 * `gen-` id (unless pinned), top-level `provider`, and `system_fingerprint`
 * (null when unset); EVERY delta choice carries `native_finish_reason` (null
 * until the finish chunk, where it mirrors finish_reason); real OR repeats
 * `role: "assistant"` on every content delta (mirrored here); and the final
 * usage-bearing chunk gets cost-bearing usage plus `service_tier: null`.
 */
export function shapeOpenRouterChunks(
  chunks: SSEChunk[],
  shaping: OpenRouterShaping,
  idOverridden: boolean,
): SSEChunk[] {
  for (const chunk of chunks) {
    if (!idOverridden) chunk.id = toGenId(chunk.id);
    chunk.provider = shaping.provider;
    if (chunk.system_fingerprint === undefined) chunk.system_fingerprint = null;
    for (const choice of chunk.choices) {
      choice.native_finish_reason = nativeFinish(choice.finish_reason, shaping);
      // Real OR stamps role:"assistant" on every content-bearing delta. A
      // `content: null` delta is NOT content-bearing, so require string content.
      if (typeof choice.delta.content === "string" && choice.delta.role === undefined) {
        choice.delta.role = "assistant";
      }
    }
    if (chunk.usage) {
      chunk.usage = augmentUsage(chunk.usage, shaping);
      chunk.service_tier = null;
    }
  }
  return chunks;
}

/**
 * Serialize an OpenRouter error envelope: `{ error: { code, message,
 * metadata? } }` where `code` equals the HTTP status (contrast the OpenAI
 * shape `{ error: { message, type, param, code } }`). Used for every error
 * emitted on an OpenRouter request — fixture errors, no-match, strict, and
 * routing failures.
 */
export function serializeOpenRouterError(
  status: number,
  message: string,
  metadata?: Record<string, unknown>,
): string {
  return JSON.stringify({
    error: {
      code: status,
      message,
      ...(metadata !== undefined && { metadata }),
    },
  });
}

// ─── Discovery endpoints ─────────────────────────────────────────────────────

function journalGet(
  req: http.IncomingMessage,
  journal: Journal,
  path: string,
  status: number,
): void {
  journal.add({
    method: req.method ?? "GET",
    path,
    headers: flattenHeaders(req.headers),
    body: null,
    response: { status, fixture: null },
  });
}

/** GET /api/v1/models — the OpenRouter model catalog synthesized from fixtures. */
export function handleOpenRouterModels(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  fixtures: Fixture[],
  journal: Journal,
  _defaults: HandlerDefaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
): void {
  setCorsHeaders(res);
  const path = req.url ?? "/api/v1/models";
  const body = renderOpenRouterChatModels(collect(fixtures, "chat").ids);
  journalGet(req, journal, path, 200);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** GET /api/v1/key — the caller's key metadata/limits/usage (static defaults). */
export function handleOpenRouterKey(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  journal: Journal,
  setCorsHeaders: (res: http.ServerResponse) => void,
): void {
  setCorsHeaders(res);
  const path = req.url ?? "/api/v1/key";
  journalGet(req, journal, path, 200);
  res.writeHead(200, { "Content-Type": "application/json" });
  // Field set + order mirror real OpenRouter bytes (or-capture/key.json).
  // null limit / limit_remaining = unlimited. `creator_user_id` is an account
  // echo — null for the mock (no account). rate_limit is deprecated upstream.
  res.end(
    JSON.stringify({
      data: {
        label: "sk-or-v1-aimock",
        is_management_key: false,
        is_provisioning_key: false,
        limit: null,
        limit_reset: null,
        limit_remaining: null,
        include_byok_in_limit: false,
        usage: 0,
        usage_daily: 0,
        usage_weekly: 0,
        usage_monthly: 0,
        byok_usage: 0,
        byok_usage_daily: 0,
        byok_usage_weekly: 0,
        byok_usage_monthly: 0,
        is_free_tier: false,
        expires_at: null,
        creator_user_id: null,
        rate_limit: {
          requests: -1,
          interval: "10s",
          note: "This field is deprecated and safe to ignore.",
        },
      },
    }),
  );
}

/** GET /api/v1/credits — account credit totals (static defaults). */
export function handleOpenRouterCredits(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  journal: Journal,
  setCorsHeaders: (res: http.ServerResponse) => void,
): void {
  setCorsHeaders(res);
  const path = req.url ?? "/api/v1/credits";
  journalGet(req, journal, path, 200);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ data: { total_credits: 0, total_usage: 0 } }));
}
