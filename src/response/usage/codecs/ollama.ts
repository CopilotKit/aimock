import type { ChatCompletionRequest } from "../../../types.js";
import { estimatePromptTokens, estimateTokens } from "../estimate.js";

type CountVariant =
  | { kind: "ordinary-zero" }
  | {
      kind: "applied-chat-estimate";
      messages: ChatCompletionRequest["messages"];
      completion: string;
    };

/** Render counts only; callers retain duration fields and their insertion order. */
export function render(
  variant: CountVariant,
  position?: "both",
): {
  prompt_eval_count: number;
  eval_count: number;
};
export function render(variant: CountVariant, position: "prompt"): { prompt_eval_count: number };
export function render(variant: CountVariant, position: "completion"): { eval_count: number };
export function render(variant: CountVariant, position: "prompt" | "completion" | "both" = "both") {
  const promptCount = variant.kind === "ordinary-zero" ? 0 : estimatePromptTokens(variant.messages);
  const completionCount = variant.kind === "ordinary-zero" ? 0 : estimateTokens(variant.completion);
  if (position === "prompt") return { prompt_eval_count: promptCount };
  if (position === "completion") return { eval_count: completionCount };
  return { prompt_eval_count: promptCount, eval_count: completionCount };
}
