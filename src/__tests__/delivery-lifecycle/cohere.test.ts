import { expect, test } from "vitest";
import { LLMock } from "../helpers/misbehavior-enabled.js";
import { describeDeliveryLifecycle, HARNESS_MATCH } from "../helpers/delivery-lifecycle-harness.js";

const messages = [{ role: "user", content: HARNESS_MATCH }];
const event = (type: string, data: Record<string, unknown>) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

describeDeliveryLifecycle({
  name: "Cohere v2 Chat",
  streamPath: "/v2/chat",
  nonStreamPath: "/v2/chat",
  streamBody: { model: "command-r-plus", messages, stream: true },
  nonStreamBody: { model: "command-r-plus", messages, stream: false },
  bodyKind: "json",
  transport: "http",
  surface: "other",
  proxy: {
    provider: "cohere",
    contentType: "text/event-stream",
    frames: [
      event("message-start", {
        id: "msg_up",
        delta: {
          message: { role: "assistant", content: [], tool_plan: "", tool_calls: [], citations: [] },
        },
      }),
      event("content-start", {
        index: 0,
        delta: { message: { content: { type: "text", text: "" } } },
      }),
      event("content-delta", { index: 0, delta: { message: { content: { text: "alpha " } } } }),
      event("content-delta", { index: 0, delta: { message: { content: { text: "beta" } } } }),
      event("content-end", { index: 0 }),
      event("message-end", {
        delta: {
          finish_reason: "COMPLETE",
          usage: { tokens: { input_tokens: 1, output_tokens: 2 } },
        },
      }),
    ],
  },
});

test("a K4 duplicate-id reply extends the recorded gaps before sizing the non-streaming wait", async () => {
  // The same hand-computed total as the OpenAI chat K4 test: two `weather`
  // calls with `{"city":"Paris"}` (7 + 16 chars each) are 46 chars, 5 chunks at
  // chunkSize 10. The recorded gaps [0, 60] extend to 4 gaps by repeating the
  // last one: 0 + 0 + 3 * 60 = 180ms. Without the extension the 2 extra
  // chunks would average the recorded gaps (30ms): 120ms.
  const timings = { ttftMs: 0, interChunkDelaysMs: [0, 60], totalDurationMs: 60 };
  const mock = new LLMock({ port: 0, logLevel: "silent" });
  mock.addFixture({
    match: { userMessage: "weather" },
    misbehavior: "tool-call-id-duplicate",
    response: { toolCalls: [{ name: "weather", arguments: '{"city":"Paris"}' }] },
    recordedTimings: timings,
    nonStreamingTimingAllProviders: true,
    chunkSize: 10,
  });
  const url = await mock.start();
  try {
    const started = performance.now();
    const res = await fetch(`${url}/v2/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "command-r-plus",
        messages: [{ role: "user", content: "weather" }],
        stream: false,
      }),
    });
    const body = (await res.json()) as { message: { tool_calls: Array<{ id: string }> } };
    const elapsed = performance.now() - started;
    expect(res.status).toBe(200);
    const calls = body.message.tool_calls;
    expect(calls).toHaveLength(2);
    expect(calls[0].id).toBe(calls[1].id);
    expect(elapsed).toBeGreaterThanOrEqual(175);
  } finally {
    await mock.stop();
  }
}, 10000);
