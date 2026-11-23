import { describeDeliveryLifecycle, HARNESS_MATCH } from "../helpers/delivery-lifecycle-harness.js";

const body = { contents: [{ role: "user", parts: [{ text: HARNESS_MATCH }] }] };
const frame = (text: string, finishReason?: string) =>
  `data: ${JSON.stringify({
    candidates: [
      {
        content: { role: "model", parts: [{ text }] },
        ...(finishReason && { finishReason }),
        index: 0,
      },
    ],
  })}\r\n\r\n`;
const upstreamFrames = [frame("alpha "), frame("beta "), frame("gamma "), frame("", "STOP")];

describeDeliveryLifecycle({
  name: "Gemini generateContent",
  streamPath: "/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse",
  nonStreamPath: "/v1beta/models/gemini-2.0-flash:generateContent",
  streamBody: body,
  nonStreamBody: body,
  bodyKind: "json",
  transport: "http",
  surface: "other",
  proxy: { provider: "gemini", contentType: "text/event-stream", frames: upstreamFrames },
});

const vertexModel =
  "/v1/projects/p/locations/us-central1/publishers/google/models/gemini-2.0-flash";

describeDeliveryLifecycle({
  name: "Vertex AI generateContent",
  streamPath: `${vertexModel}:streamGenerateContent?alt=sse`,
  nonStreamPath: `${vertexModel}:generateContent`,
  streamBody: body,
  nonStreamBody: body,
  bodyKind: "json",
  transport: "http",
  surface: "other",
  proxy: { provider: "vertexai", contentType: "text/event-stream", frames: upstreamFrames },
});
