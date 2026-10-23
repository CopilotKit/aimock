import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LLMock } from "../../llmock.js";
import type { Fixture, JournalEntry } from "../../types.js";
import { WebSocketConnection } from "../../ws-framing.js";
import { describeDeliveryLifecycle, HARNESS_MATCH } from "../helpers/delivery-lifecycle-harness.js";
import { BAD_FRAME, closeFrame, closeOnSend, textFrame } from "../helpers/ws-close-parity.js";
import { connectWebSocket, type WSTestClient } from "../ws-test-client.js";

const LIVE_PATH = "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const LONG_CONTENT =
  "The quick brown fox jumps over the lazy dog, again and again, for a long time. ".repeat(4);

const wsRow = {
  streamPath: LIVE_PATH,
  nonStreamPath: LIVE_PATH,
  streamBody: {},
  nonStreamBody: {},
  bodyKind: "json",
  transport: "ws",
  wsTransport: "gemini-live",
  surface: "other",
  nonStream: false,
} as const;

// Text streaming (the default long-text response).
describeDeliveryLifecycle({ name: "Gemini Live", ...wsRow });

// Content + tool calls: the text loop, then the tool-call delay.
describeDeliveryLifecycle({
  name: "Gemini Live (content + toolCalls)",
  ...wsRow,
  streamResponse: {
    content: LONG_CONTENT,
    toolCalls: [{ name: "lookup", arguments: '{"q":1}' }],
  },
});

// Ordered blocks: text, tool call, text.
describeDeliveryLifecycle({
  name: "Gemini Live (blocks)",
  ...wsRow,
  streamResponse: {
    blocks: [
      { type: "text", text: LONG_CONTENT },
      { type: "toolCall", name: "lookup", arguments: '{"q":1}' },
      { type: "text", text: LONG_CONTENT },
    ],
  },
});

// The tool-call-only and empty-response misbehavior branches send nothing
// before their first delay, so the client leaves before the first message.
// It leaves with a bare TCP drop (FIN, no close frame). `WebSocketConnection`
// treats the FIN as a disconnect at once, so the turn stops during the delay,
// well before the delay ends, and not at a later failed write.
describe("delivery lifecycle: Gemini Live close before the first message", () => {
  let mock: LLMock;
  let sends = 0;

  beforeAll(async () => {
    mock = new LLMock({ port: 0, host: "127.0.0.1", enableMisbehavior: true });
    await mock.start();
  });
  afterAll(async () => {
    await mock.stop();
  });
  beforeEach(() => {
    const realSend = WebSocketConnection.prototype.send;
    vi.spyOn(WebSocketConnection.prototype, "send").mockImplementation(function (
      this: WebSocketConnection,
      data: string,
    ) {
      sends++;
      realSend.call(this, data);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    mock.clearFixtures();
    mock.clearRequests();
    mock.resetMatchCounts();
  });

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const lastFixtureEntry = (): JournalEntry | undefined =>
    mock
      .getRequests()
      .filter((e) => e.response.fixture)
      .at(-1);

  async function startTurn(): Promise<WSTestClient> {
    const client = await connectWebSocket(mock.url, LIVE_PATH);
    client.send(JSON.stringify({ setup: { model: "models/gemini-2.0-flash-live-001" } }));
    await client.waitForMessages(1); // setupComplete
    client.send(
      JSON.stringify({
        clientContent: {
          turns: [{ role: "user", parts: [{ text: HARNESS_MATCH }] }],
          turnComplete: true,
        },
      }),
    );
    return client;
  }

  const cases: Array<[string, Partial<Fixture>]> = [
    ["tool call", { response: { toolCalls: [{ name: "lookup", arguments: '{"q":1}' }] } }],
    [
      "empty-response misbehavior",
      { response: { content: LONG_CONTENT }, misbehavior: "empty-response" },
    ],
  ];

  for (const [label, extra] of cases) {
    it(`stops the turn promptly on a TCP drop during the ${label} delay`, async () => {
      mock.addFixture({
        match: { userMessage: HARNESS_MATCH },
        response: { content: LONG_CONTENT },
        latency: 1500,
        ...extra,
      });
      const client = await startTurn();
      await expect.poll(() => lastFixtureEntry() !== undefined, { timeout: 2000 }).toBe(true);
      const before = sends;
      client.destroy();
      // Well inside the 1500 ms delay, so the drop is seen at once. The
      // interruption reason is not asserted here.
      await expect
        .poll(() => lastFixtureEntry()?.response.interrupted, { timeout: 750, interval: 10 })
        .toBe(true);
      // Past the end of the delay: the stopped turn sends nothing.
      await sleep(1700);
      expect(sends - before).toBe(0);
    }, 10000);
  }
});

/**
 * Closed-socket parity with WS Realtime. aimock's own close (a bad client
 * frame, or a send over the write limit) marks the socket closed at once and
 * emits `close` about 100ms later; a turn that sees it is journaled with
 * "disconnect". A client that left before the reply is "client aborted". In
 * both cases nothing more is sent.
 */
describe("delivery lifecycle: Gemini Live closed-socket parity", () => {
  let mock: LLMock;

  beforeAll(async () => {
    mock = new LLMock({ port: 0, host: "127.0.0.1", enableMisbehavior: true });
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
      .filter((e) => e.response.fixture)
      .at(-1);

  const contentMsg = JSON.stringify({
    clientContent: {
      turns: [{ role: "user", parts: [{ text: HARNESS_MATCH }] }],
      turnComplete: true,
    },
  });

  async function setup(): Promise<WSTestClient> {
    const client = await connectWebSocket(mock.url, LIVE_PATH);
    client.send(JSON.stringify({ setup: { model: "models/gemini-2.0-flash-live-001" } }));
    await client.waitForMessages(1); // setupComplete
    return client;
  }

  async function expectInterrupted(reason: string): Promise<JournalEntry> {
    await expect.poll(() => lastFixtureEntry()?.response.interrupted, { timeout: 3000 }).toBe(true);
    const entry = lastFixtureEntry()!;
    expect(entry.response.interruptReason).toBe(reason);
    expect(entry.response.status).toBe(200);
    return entry;
  }

  it("journals a bad frame mid text turn as disconnect", async () => {
    mock.addFixture({
      match: { userMessage: HARNESS_MATCH },
      response: { content: LONG_CONTENT },
      chunkSize: 8,
      latency: 30,
    });
    const client = await setup();
    client.send(contentMsg);
    await client.waitForMessages(2); // first chunk
    client.sendRawFrame(BAD_FRAME);
    await expectInterrupted("disconnect");
  });

  it("journals an audio turn whose client left before the reply as client aborted", async () => {
    mock.addFixture({
      match: { userMessage: HARNESS_MATCH },
      response: { audio: "SGVsbG8=", format: "mp3" },
    });
    const client = await setup();
    const sent = closeOnSend(() => false);
    client.sendRawFrame(Buffer.concat([textFrame(contentMsg), closeFrame()]));
    await expectInterrupted("client aborted");
    expect(sent).toEqual([]);
  });

  it("journals an audio reply send that closes the socket as disconnect", async () => {
    mock.addFixture({
      match: { userMessage: HARNESS_MATCH },
      response: { audio: "SGVsbG8=", format: "mp3" },
    });
    const client = await setup();
    closeOnSend((data) => data.includes("inlineData"));
    client.send(contentMsg);
    await expectInterrupted("disconnect");
  });

  it("journals a text turn whose turnComplete send closes the socket as disconnect", async () => {
    mock.addFixture({
      match: { userMessage: HARNESS_MATCH },
      response: { content: "ABCDEFGH" },
      chunkSize: 4,
    });
    const client = await setup();
    closeOnSend((data) => data.includes('"turnComplete":true'));
    client.send(contentMsg);
    await expectInterrupted("disconnect");
  });

  const toolCases: Array<[string, Fixture["response"]]> = [
    ["tool-call", { toolCalls: [{ name: "lookup", arguments: '{"q":1}' }] }],
    ["content + tool-call", { content: "ABCD", toolCalls: [{ name: "lookup", arguments: "{}" }] }],
    [
      "blocks",
      {
        blocks: [
          { type: "text", text: "ABCD" },
          { type: "toolCall", name: "lookup", arguments: "{}" },
        ],
      },
    ],
  ];
  for (const [label, response] of toolCases) {
    it(`journals a ${label} turn whose toolCall send closes the socket as disconnect`, async () => {
      mock.addFixture({ match: { userMessage: HARNESS_MATCH }, response, chunkSize: 4 });
      const client = await setup();
      const sent = closeOnSend((data) => data.includes('"toolCall"'));
      client.send(contentMsg);
      await expectInterrupted("disconnect");
      expect(sent.some((m) => m.includes("turnComplete"))).toBe(false);
    });
  }

  it("journals an empty-response turn whose turnComplete send closes the socket as disconnect", async () => {
    mock.addFixture({
      match: { userMessage: HARNESS_MATCH },
      response: { content: LONG_CONTENT },
      misbehavior: "empty-response",
    });
    const client = await setup();
    closeOnSend((data) => data.includes('"turnComplete":true'));
    client.send(contentMsg);
    await expectInterrupted("disconnect");
  });
});
