import { describeDeliveryLifecycle, HARNESS_MATCH } from "../helpers/delivery-lifecycle-harness.js";

const messages = [{ role: "user", content: HARNESS_MATCH }];
const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
  `data: ${JSON.stringify({
    id: "chatcmpl-up",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-4o",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;

describeDeliveryLifecycle({
  name: "OpenAI Chat Completions",
  streamPath: "/v1/chat/completions",
  nonStreamPath: "/v1/chat/completions",
  streamBody: { model: "gpt-4o", messages, stream: true },
  nonStreamBody: { model: "gpt-4o", messages, stream: false },
  bodyKind: "json",
  transport: "http",
  surface: "openai-chat",
  proxy: {
    provider: "openai",
    contentType: "text/event-stream",
    frames: [
      chunk({ role: "assistant", content: "alpha" }),
      chunk({ content: " beta" }),
      chunk({ content: " gamma" }),
      chunk({}, "stop"),
      "data: [DONE]\n\n",
    ],
  },
});
