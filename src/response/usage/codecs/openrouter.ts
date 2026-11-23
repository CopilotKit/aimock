import type { OpenRouterUsageExtras, ResponseOverrides } from "../../../types.js";
import { OPENAI_TOKEN_KEYS } from "./openai.js";

/** Explicit extras follow canonical tokens; own prototype keys never pass through. */
const SHAPED_OR_CANONICAL_USAGE_KEYS = new Set([
  ...OPENAI_TOKEN_KEYS,
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

/** Keep suppliedness, required nested defaults and original unknown-key insertion order. */
export function resolve(overrides: ResponseOverrides | undefined): OpenRouterUsageExtras {
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
  return usageExtras;
}

/** Wrap the rendered OpenAI usage without dropping fields on compatibility callers. */
export function render<T extends object>(
  usage: T,
  extras: OpenRouterUsageExtras,
): T & OpenRouterUsageExtras {
  return { ...usage, ...extras };
}
