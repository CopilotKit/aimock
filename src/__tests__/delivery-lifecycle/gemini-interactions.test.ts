import { describeDeliveryLifecycle, HARNESS_MATCH } from "../helpers/delivery-lifecycle-harness.js";

const event = (data: Record<string, unknown>) => `data: ${JSON.stringify(data)}\n\n`;

describeDeliveryLifecycle({
  name: "Gemini Interactions",
  streamPath: "/v1beta/interactions",
  nonStreamPath: "/v1beta/interactions",
  streamBody: { model: "gemini-2.5-flash", input: HARNESS_MATCH, stream: true },
  nonStreamBody: { model: "gemini-2.5-flash", input: HARNESS_MATCH, stream: false },
  bodyKind: "json",
  transport: "http",
  surface: "other",
  proxy: {
    // Gemini Interactions proxies to the configured Gemini upstream.
    provider: "gemini",
    contentType: "text/event-stream",
    frames: [
      event({
        event_type: "interaction.created",
        interaction: { id: "int_up", status: "in_progress" },
      }),
      event({ event_type: "step.start", index: 0, step: { type: "model_output" } }),
      event({ event_type: "step.delta", index: 0, delta: { type: "text", text: "alpha " } }),
      event({ event_type: "step.delta", index: 0, delta: { type: "text", text: "beta" } }),
      event({ event_type: "step.stop", index: 0 }),
      event({
        event_type: "interaction.completed",
        interaction: { id: "int_up", status: "completed" },
      }),
    ],
  },
});
