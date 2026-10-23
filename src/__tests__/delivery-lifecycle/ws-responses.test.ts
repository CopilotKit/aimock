import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { LLMock } from "../../llmock.js";
import type { JournalEntry } from "../../types.js";
import { describeDeliveryLifecycle, HARNESS_MATCH } from "../helpers/delivery-lifecycle-harness.js";
import { BAD_FRAME, textFrame } from "../helpers/ws-close-parity.js";
import { connectWebSocket } from "../ws-test-client.js";

describeDeliveryLifecycle({
  name: "WebSocket Responses",
  streamPath: "/v1/responses",
  nonStreamPath: "/v1/responses",
  streamBody: {},
  nonStreamBody: {},
  bodyKind: "json",
  transport: "ws",
  wsTransport: "responses",
  surface: "other",
  nonStream: false,
});

/**
 * aimock's own close (a bad client frame here) marks the socket closed at
 * once and emits `close` about 100ms later. A turn that sees the closed socket
 * in that window is journaled with "disconnect", the reason for an
 * aimock-caused teardown, as WS Realtime does.
 */
describe("delivery lifecycle: WS Responses aimock-side close", () => {
  let mock: LLMock;

  beforeAll(async () => {
    mock = new LLMock({ port: 0, host: "127.0.0.1" });
    await mock.start();
  });
  afterAll(async () => {
    await mock.stop();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    mock.clearFixtures();
    mock.clearRequests();
    mock.resetMatchCounts();
  });

  const lastFixtureEntry = (): JournalEntry | undefined =>
    mock
      .getRequests()
      .filter((e) => e.response.fixture !== null)
      .at(-1);

  const createMsg = JSON.stringify({
    type: "response.create",
    model: "gpt-4",
    input: [{ role: "user", content: HARNESS_MATCH }],
  });

  it("journals a bad frame mid-turn as disconnect", async () => {
    mock.addFixture({
      match: { userMessage: HARNESS_MATCH },
      response: { content: "x".repeat(400) },
      chunkSize: 8,
      latency: 30,
    });
    const client = await connectWebSocket(mock.url, "/v1/responses");
    client.send(createMsg);
    await expect
      .poll(() => client.getMessages().some((m) => m.includes("response.output_text.delta")), {
        timeout: 3000,
      })
      .toBe(true);
    client.sendRawFrame(BAD_FRAME);
    await expect.poll(() => lastFixtureEntry()?.response.interrupted, { timeout: 3000 }).toBe(true);
    const entry = lastFixtureEntry()!;
    expect(entry.response.interruptReason).toBe("disconnect");
    expect(entry.response.status).toBe(200);
  });

  it("journals a bad frame that lands before the turn starts as disconnect", async () => {
    mock.addFixture({
      match: { userMessage: HARNESS_MATCH },
      response: { content: "x".repeat(400) },
      chunkSize: 8,
      latency: 30,
    });
    const client = await connectWebSocket(mock.url, "/v1/responses");
    client.sendRawFrame(Buffer.concat([textFrame(createMsg), BAD_FRAME]));
    await expect.poll(() => lastFixtureEntry()?.response.interrupted, { timeout: 3000 }).toBe(true);
    expect(lastFixtureEntry()!.response.interruptReason).toBe("disconnect");
  });
});
