/** Caller defaults stay with the wire; unknown native reasons pass through unchanged. */
export function mapAnthropicFinish(finishReason: string): string {
  if (finishReason === "stop") return "end_turn";
  if (finishReason === "tool_calls") return "tool_use";
  if (finishReason === "length") return "max_tokens";
  return finishReason;
}

/** Responses status has its own table; caller defaults remain outside the mapper. */
export function mapResponsesFinish(finishReason: string): string {
  if (finishReason === "stop") return "completed";
  if (finishReason === "tool_calls") return "completed";
  if (finishReason === "length") return "incomplete";
  if (finishReason === "content_filter") return "failed";
  return finishReason;
}

/** Gemini and Vertex keep their distinct native finish reasons and caller defaults. */
export function mapGeminiFinish(finishReason: string): string {
  if (finishReason === "stop") return "STOP";
  if (finishReason === "tool_calls") return "FUNCTION_CALL";
  if (finishReason === "length") return "MAX_TOKENS";
  if (finishReason === "content_filter") return "SAFETY";
  return finishReason;
}

/** Cohere has its own native finish table; callers retain their falsy defaults. */
export function mapCohereFinish(finishReason: string): string {
  if (finishReason === "stop") return "COMPLETE";
  if (finishReason === "tool_calls") return "TOOL_CALL";
  if (finishReason === "length") return "MAX_TOKENS";
  return finishReason;
}
