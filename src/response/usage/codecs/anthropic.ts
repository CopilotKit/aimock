import type { ResponseOverrides } from "../../../types.js";

type AnthropicUsage = { input_tokens: number; output_tokens: number };
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
): { output_tokens: number };
export function render(
  resolved: ReturnType<typeof resolve>,
  position: FinalPosition | DeltaPosition,
  variant: Variant = "ordinary",
): AnthropicUsage | { output_tokens: number } {
  if (position === "messages-delta" || position === "bedrock-delta") {
    return {
      output_tokens:
        position === "bedrock-delta" && variant === "ordinary" ? 0 : resolved.outputTokens,
    };
  }
  // Cache and arbitrary extra fields remain omitted in the equivalence phase.
  return { input_tokens: resolved.inputTokens, output_tokens: resolved.outputTokens };
}

/** Anthropic recording currently omits usage; feature adoption enables capture later. */
export function capture(previous: ResponseOverrides["usage"], observation: unknown): undefined {
  void previous;
  void observation;
  return undefined;
}
