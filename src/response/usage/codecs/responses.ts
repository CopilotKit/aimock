import type { ResponseOverrides } from "../../../types.js";

/** Responses keeps native aliases first and emits all three counts, including absent zeros. */
export function render(overrides?: ResponseOverrides): {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
} {
  if (!overrides?.usage) return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  const input = overrides.usage.input_tokens ?? overrides.usage.prompt_tokens ?? 0;
  const output = overrides.usage.output_tokens ?? overrides.usage.completion_tokens ?? 0;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: overrides.usage.total_tokens ?? input + output,
  };
}
