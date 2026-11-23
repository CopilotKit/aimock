import type { ResponseOverrides } from "../../../types.js";
import { sanitizeUsage } from "../fields.js";

type CacheUsage = {
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  cache_creation?: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number };
};
type AnthropicUsage = { input_tokens: number; output_tokens: number } & CacheUsage;
type AnthropicDeltaUsage = { output_tokens: number } & CacheUsage;
type FinalPosition = "messages-final" | "messages-start" | "bedrock-final" | "bedrock-start";
type DeltaPosition = "messages-delta" | "bedrock-delta";
type Variant = "ordinary" | "applied-misbehavior";

/** Retain native supplied values and insertion order alongside the serving counts. */
export function resolve(
  overrides?: ResponseOverrides,
  estimates?: { inputTokens: number; outputTokens: number },
) {
  const native = overrides?.usage;
  return {
    native,
    supplied: native !== undefined,
    inputTokens: estimates?.inputTokens ?? native?.input_tokens ?? native?.prompt_tokens ?? 0,
    outputTokens:
      estimates?.outputTokens ?? native?.output_tokens ?? native?.completion_tokens ?? 0,
  };
}

export function render(
  resolved: ReturnType<typeof resolve>,
  position: FinalPosition,
  variant?: Variant,
): AnthropicUsage;
export function render(
  resolved: ReturnType<typeof resolve>,
  position: DeltaPosition,
  variant?: Variant,
): AnthropicDeltaUsage;
export function render(
  resolved: ReturnType<typeof resolve>,
  position: FinalPosition | DeltaPosition,
  variant: Variant = "ordinary",
): AnthropicUsage | AnthropicDeltaUsage {
  const cache: CacheUsage = {};
  if (variant === "ordinary") {
    const native = resolved.native;
    if (native?.cache_read_input_tokens !== undefined)
      cache.cache_read_input_tokens = native.cache_read_input_tokens;
    if (native?.cache_creation_input_tokens !== undefined)
      cache.cache_creation_input_tokens = native.cache_creation_input_tokens;
    const creation = native?.cache_creation;
    if (
      position !== "messages-delta" &&
      position !== "bedrock-delta" &&
      typeof creation === "object" &&
      creation !== null &&
      !Array.isArray(creation)
    ) {
      const members = creation as Record<string, unknown>;
      cache.cache_creation = {
        ephemeral_5m_input_tokens:
          typeof members.ephemeral_5m_input_tokens === "number"
            ? members.ephemeral_5m_input_tokens
            : 0,
        ephemeral_1h_input_tokens:
          typeof members.ephemeral_1h_input_tokens === "number"
            ? members.ephemeral_1h_input_tokens
            : 0,
      };
    }
  }
  if (position === "messages-delta" || position === "bedrock-delta") {
    return {
      output_tokens:
        position === "bedrock-delta" && variant === "ordinary" ? 0 : resolved.outputTokens,
      ...cache,
    };
  }
  return { input_tokens: resolved.inputTokens, output_tokens: resolved.outputTokens, ...cache };
}

/** Numeric observations replace earlier counts; null never erases a start value. */
export function capture(
  previous: ResponseOverrides["usage"],
  observation: unknown,
  position: "start" | "delta" | "final" = "final",
): ResponseOverrides["usage"] | undefined {
  if (typeof observation !== "object" || observation === null || Array.isArray(observation))
    return previous;
  const merged: Record<string, unknown> = { ...previous };
  for (const [key, value] of Object.entries(observation)) {
    if (typeof value === "number") merged[key] = value;
    else if (
      key === "cache_creation" &&
      position !== "delta" &&
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    )
      merged[key] = value;
  }
  return sanitizeUsage(merged);
}
