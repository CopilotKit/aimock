type RealtimeChatUsage =
  | { kind: "ordinary-zero" }
  | {
      kind: "applied-misbehavior";
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };

/** Render chat usage only; transcription retains its model-dependent discriminator. */
export function render(state: RealtimeChatUsage) {
  if (state.kind === "applied-misbehavior") {
    return {
      input_tokens: state.usage.prompt_tokens,
      output_tokens: state.usage.completion_tokens,
      total_tokens: state.usage.total_tokens,
    };
  }
  return { total_tokens: 0, input_tokens: 0, output_tokens: 0 };
}
