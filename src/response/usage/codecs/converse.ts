import type { ResponseOverrides } from "../../../types.js";

/** Converse always computes its total; applied estimates remain caller-owned. */
export function render(
  overrides?: ResponseOverrides,
  estimates?: { input: number; output: number },
): { inputTokens: number; outputTokens: number; totalTokens: number } {
  const inputTokens =
    estimates?.input ?? overrides?.usage?.input_tokens ?? overrides?.usage?.prompt_tokens ?? 0;
  const outputTokens =
    estimates?.output ??
    overrides?.usage?.output_tokens ??
    overrides?.usage?.completion_tokens ??
    0;
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}
