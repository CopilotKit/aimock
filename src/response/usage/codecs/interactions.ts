import type { ResponseOverrides } from "../../../types.js";

type InteractionsUsage = {
  total_input_tokens: number;
  total_output_tokens: number;
  total_tokens: number;
};
type InteractionsThoughtUsage = InteractionsUsage & { total_thought_tokens: number };

export function render(overrides?: ResponseOverrides, variant?: "ordinary"): InteractionsUsage;
export function render(
  overrides: ResponseOverrides | undefined,
  variant: "applied-reasoning-only",
): InteractionsThoughtUsage;
/** Interactions prefers input/output aliases and its snake-case total before Gemini aliases. */
export function render(
  overrides?: ResponseOverrides,
  variant: "ordinary" | "applied-reasoning-only" = "ordinary",
): InteractionsUsage | InteractionsThoughtUsage {
  const input =
    overrides?.usage?.input_tokens ??
    overrides?.usage?.prompt_tokens ??
    overrides?.usage?.promptTokenCount ??
    0;
  const output =
    overrides?.usage?.output_tokens ??
    overrides?.usage?.completion_tokens ??
    overrides?.usage?.candidatesTokenCount ??
    0;
  const usage = {
    total_input_tokens: input,
    total_output_tokens: output,
    total_tokens:
      overrides?.usage?.total_tokens ?? overrides?.usage?.totalTokenCount ?? input + output,
  };
  if (variant === "applied-reasoning-only")
    return {
      ...usage,
      total_output_tokens: 0,
      total_thought_tokens: overrides?.usage?.completion_tokens ?? 0,
    };
  return usage;
}
