import { encodeEventStreamMessage } from "../../aws-event-stream.js";
import { describeDeliveryLifecycle, HARNESS_MATCH } from "../helpers/delivery-lifecycle-harness.js";

const MODEL = "anthropic.claude-3-5-sonnet-20241022-v2:0";
const body = { messages: [{ role: "user", content: [{ text: HARNESS_MATCH }] }] };

describeDeliveryLifecycle({
  name: "Bedrock Converse",
  streamPath: `/model/${MODEL}/converse-stream`,
  nonStreamPath: `/model/${MODEL}/converse`,
  streamBody: body,
  nonStreamBody: body,
  bodyKind: "json",
  transport: "http",
  surface: "other",
  proxy: {
    provider: "bedrock",
    contentType: "application/vnd.amazon.eventstream",
    frames: [
      encodeEventStreamMessage("messageStart", { role: "assistant" }),
      encodeEventStreamMessage("contentBlockDelta", {
        contentBlockIndex: 0,
        delta: { text: "alpha " },
      }),
      encodeEventStreamMessage("contentBlockDelta", {
        contentBlockIndex: 0,
        delta: { text: "beta" },
      }),
      encodeEventStreamMessage("contentBlockStop", { contentBlockIndex: 0 }),
      encodeEventStreamMessage("messageStop", { stopReason: "end_turn" }),
      encodeEventStreamMessage("metadata", {
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        metrics: { latencyMs: 0 },
      }),
    ],
  },
});
