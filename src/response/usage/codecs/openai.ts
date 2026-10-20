import type { ResponseOverrides } from "../../../types.js";
import { estimateTokens } from "../estimate.js";

/** Token aliases shared with the OpenRouter passthrough exclusion. Order is observable. */
export const OPENAI_TOKEN_KEYS = [
  "prompt_tokens",
  "completion_tokens",
  "total_tokens",
  "input_tokens",
  "output_tokens",
  "promptTokenCount",
  "candidatesTokenCount",
  "totalTokenCount",
] as const;

interface ResolvedOpenAIUsage {
  prompt: number;
  completion: number;
  total: number;
}

/** Preserve definedness, alias precedence and caller text estimation without sanitizing. */
export function resolve(
  overrides: ResponseOverrides | undefined,
  context: { promptText: string; completionText: string },
): ResolvedOpenAIUsage {
  const { promptText, completionText } = context;
  if (overrides?.usage) {
    const u = overrides.usage;
    // A usage override that scripts only cost fields (e.g. `{ cost: 0.5 }`)
    // carries NO token counts. Real providers always report real token usage,
    // so estimate the counts rather than forcing them to 0 — otherwise a
    // cost-scripting fixture is unfaithful (cost present, tokens 0). When the
    // override DOES set any token count we preserve the explicit-or-zero merge
    // behavior, and any explicit token value always wins.
    const hasExplicitTokens = OPENAI_TOKEN_KEYS.some((key) => u[key] !== undefined);
    const fallbackPrompt = hasExplicitTokens ? 0 : estimateTokens(promptText || "x");
    const fallbackCompletion = hasExplicitTokens ? 0 : estimateTokens(completionText || "x");
    const prompt = u.prompt_tokens ?? u.input_tokens ?? u.promptTokenCount ?? fallbackPrompt;
    const completion =
      u.completion_tokens ?? u.output_tokens ?? u.candidatesTokenCount ?? fallbackCompletion;
    return {
      prompt,
      completion,
      total: u.total_tokens ?? u.totalTokenCount ?? prompt + completion,
    };
  }
  const prompt = estimateTokens(promptText || "x");
  const completion = estimateTokens(completionText || "x");
  return {
    prompt,
    completion,
    total: prompt + completion,
  };
}

/** Native field order is identical for final responses and terminal usage chunks. */
export function render(usage: ResolvedOpenAIUsage): {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
} {
  return {
    prompt_tokens: usage.prompt,
    completion_tokens: usage.completion,
    total_tokens: usage.total,
  };
}
