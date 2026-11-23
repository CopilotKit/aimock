import { describeDeliveryLifecycle, HARNESS_MATCH } from "../helpers/delivery-lifecycle-harness.js";

const input = [{ role: "user", content: HARNESS_MATCH }];
const event = (type: string, data: Record<string, unknown>) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const upstreamResponse = {
  id: "resp_up",
  object: "response",
  created_at: 1,
  model: "gpt-4o",
  status: "in_progress",
  output: [],
};
const delta = (text: string) =>
  event("response.output_text.delta", {
    item_id: "msg_up",
    output_index: 0,
    content_index: 0,
    delta: text,
  });

describeDeliveryLifecycle({
  name: "OpenAI Responses",
  streamPath: "/v1/responses",
  nonStreamPath: "/v1/responses",
  streamBody: { model: "gpt-4o", input, stream: true },
  nonStreamBody: { model: "gpt-4o", input, stream: false },
  bodyKind: "json",
  transport: "http",
  surface: "other",
  proxy: {
    provider: "openai",
    contentType: "text/event-stream",
    frames: [
      event("response.created", { response: upstreamResponse }),
      delta("alpha "),
      delta("beta "),
      delta("gamma"),
      event("response.completed", { response: { ...upstreamResponse, status: "completed" } }),
    ],
  },
});
