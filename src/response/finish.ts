/** Caller defaults stay with the wire; unknown native reasons pass through unchanged. */
export function mapAnthropicFinish(finishReason: string): string {
  if (finishReason === "stop") return "end_turn";
  if (finishReason === "tool_calls") return "tool_use";
  if (finishReason === "length") return "max_tokens";
  return finishReason;
}
