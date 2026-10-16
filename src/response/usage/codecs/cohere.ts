import type { ResponseOverrides } from "../../../types.js";

const ZERO_USAGE = {
  billed_units: { input_tokens: 0, output_tokens: 0, search_units: 0, classifications: 0 },
  tokens: { input_tokens: 0, output_tokens: 0 },
};

/** Cohere repeats its selected counts and keeps the other billed dimensions zero. */
export function render(overrides?: ResponseOverrides): typeof ZERO_USAGE {
  if (!overrides?.usage) return ZERO_USAGE;
  const inputTokens = overrides.usage.input_tokens ?? overrides.usage.prompt_tokens ?? 0;
  const outputTokens = overrides.usage.output_tokens ?? overrides.usage.completion_tokens ?? 0;
  return {
    billed_units: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      search_units: 0,
      classifications: 0,
    },
    tokens: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}
