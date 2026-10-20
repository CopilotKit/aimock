import type { ChatCompletionRequest } from "../../types.js";

/**
 * Rough token count estimation based on character length.
 * Uses the ~4 characters per token heuristic common for English text.
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Estimate prompt tokens from a request's messages array. */
export function estimatePromptTokens(messages: ChatCompletionRequest["messages"]): number {
  let totalChars = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      totalChars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.text) totalChars += part.text.length;
      }
    }
  }
  return Math.max(1, Math.ceil(totalChars / 4));
}
