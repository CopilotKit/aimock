import { describeDeliveryLifecycle, HARNESS_MATCH } from "../helpers/delivery-lifecycle-harness.js";
import { encodeEventStreamMessage } from "../../aws-event-stream.js";

const MODEL = "anthropic.claude-3-5-sonnet-20241022-v2:0";
const body = {
  anthropic_version: "bedrock-2023-05-31",
  max_tokens: 256,
  messages: [{ role: "user", content: HARNESS_MATCH }],
};
// One InvokeModel stream frame: a `chunk` event whose payload is a base64
// PayloadPart wrapping a Claude stream event, as the real service sends it.
const chunk = (event: Record<string, unknown>): Buffer =>
  encodeEventStreamMessage("chunk", {
    bytes: Buffer.from(JSON.stringify(event), "utf8").toString("base64"),
  });

describeDeliveryLifecycle({
  name: "Bedrock InvokeModel",
  streamPath: `/model/${MODEL}/invoke-with-response-stream`,
  nonStreamPath: `/model/${MODEL}/invoke`,
  streamBody: body,
  nonStreamBody: body,
  bodyKind: "json",
  transport: "http",
  surface: "other",
  proxy: {
    provider: "bedrock",
    contentType: "application/vnd.amazon.eventstream",
    frames: [
      chunk({
        type: "message_start",
        message: {
          id: "msg_up",
          type: "message",
          role: "assistant",
          content: [],
          model: MODEL,
          stop_reason: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      }),
      chunk({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      chunk({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "alpha " },
      }),
      chunk({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "beta" } }),
      chunk({ type: "content_block_stop", index: 0 }),
      chunk({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 2 },
      }),
      chunk({ type: "message_stop" }),
    ],
  },
});
