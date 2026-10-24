import { describeDeliveryLifecycle, HARNESS_MATCH } from "../helpers/delivery-lifecycle-harness.js";

const messages = [{ role: "user", content: HARNESS_MATCH }];
const event = (type: string, data: Record<string, unknown>) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

describeDeliveryLifecycle({
  name: "Anthropic Messages",
  streamPath: "/v1/messages",
  nonStreamPath: "/v1/messages",
  streamBody: { model: "claude-3-5-sonnet-20241022", max_tokens: 256, messages, stream: true },
  nonStreamBody: { model: "claude-3-5-sonnet-20241022", max_tokens: 256, messages, stream: false },
  bodyKind: "json",
  transport: "http",
  surface: "other",
  proxy: {
    provider: "anthropic",
    contentType: "text/event-stream",
    frames: [
      event("message_start", {
        message: {
          id: "msg_up",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-3-5-sonnet-20241022",
          stop_reason: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      }),
      event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
      event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "alpha " } }),
      event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "beta" } }),
      event("content_block_stop", { index: 0 }),
      event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }),
      event("message_stop", {}),
    ],
  },
});
