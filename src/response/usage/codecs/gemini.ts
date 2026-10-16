import type { ResponseOverrides } from "../../../types.js";
import { estimateTokens } from "../estimate.js";

type GeminiUsage = {
  promptTokenCount: number;
  candidatesTokenCount: number;
  totalTokenCount: number;
};
type Variant =
  | { kind: "ordinary" }
  | { kind: "applied-misbehavior"; promptText: string; completionText: string };

/** Gemini and Vertex share native precedence; only the native total overrides the sum. */
export function render(
  overrides?: ResponseOverrides,
  variant: Variant = { kind: "ordinary" },
): GeminiUsage {
  if (variant.kind === "applied-misbehavior") {
    const prompt = estimateTokens(variant.promptText || "x");
    const candidates = estimateTokens(variant.completionText || "x");
    return {
      promptTokenCount: prompt,
      candidatesTokenCount: candidates,
      totalTokenCount: prompt + candidates,
    };
  }
  if (!overrides?.usage)
    return { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 };
  const prompt =
    overrides.usage.promptTokenCount ??
    overrides.usage.prompt_tokens ??
    overrides.usage.input_tokens ??
    0;
  const candidates =
    overrides.usage.candidatesTokenCount ??
    overrides.usage.completion_tokens ??
    overrides.usage.output_tokens ??
    0;
  return {
    promptTokenCount: prompt,
    candidatesTokenCount: candidates,
    totalTokenCount: overrides.usage.totalTokenCount ?? prompt + candidates,
  };
}
