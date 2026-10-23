import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { LLMock } from "../../llmock.js";
import type { Fixture, JournalEntry } from "../../types.js";
import { WebSocketConnection } from "../../ws-framing.js";
import { describeDeliveryLifecycle, HARNESS_MATCH } from "../helpers/delivery-lifecycle-harness.js";
import { BAD_FRAME, closeOnSend, textFrame } from "../helpers/ws-close-parity.js";
import { connectWebSocket, type WSTestClient } from "../ws-test-client.js";

const REALTIME_PATH = "/v1/realtime?model=gpt-4o-realtime-preview";
/** The per-chunk delay the client drops the socket in. */
const DELAY_MS = 1500;

describeDeliveryLifecycle({
  name: "WS Realtime",
  streamPath: REALTIME_PATH,
  nonStreamPath: REALTIME_PATH,
  streamBody: {},
  nonStreamBody: {},
  bodyKind: "json",
  transport: "ws",
  wsTransport: "realtime",
  surface: "other",
  nonStream: false,
});

/**
 * Realtime has five per-turn delivery loops (live transcription, text,
 * tool calls, content + tool calls, blocks). The harness above drives the text
 * loop. These cases drive the others: a client that drops the socket mid-turn
 * is journaled as interrupted, and the turn sends nothing after that.
 *
 * The drop is a bare TCP FIN with no close frame, made during a long delay.
 * `WebSocketConnection` treats the FIN as a disconnect at once, so the turn
 * must stop well before the delay ends. The interruption reason is not
 * asserted here.
 */
describe("delivery lifecycle: WS Realtime turn kinds", () => {
  let mock: LLMock;

  beforeAll(async () => {
    mock = new LLMock({ port: 0, host: "127.0.0.1", chunkSize: 8 });
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

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  const lastFixtureEntry = (): JournalEntry | undefined =>
    mock
      .getRequests()
      .filter((e) => e.response.fixture !== null)
      .at(-1);

  const typeOf = (m: string): string => (JSON.parse(m) as { type: string }).type;

  async function waitFor(client: WSTestClient, type: string): Promise<void> {
    await expect
      .poll(() => client.getMessages().some((m) => typeOf(m) === type), {
        timeout: 8000,
        interval: 20,
      })
      .toBe(true);
  }

  async function startConversationTurn(client: WSTestClient): Promise<void> {
    await client.waitForMessages(1); // session.created
    client.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: HARNESS_MATCH }],
        },
      }),
    );
    client.send(JSON.stringify({ type: "response.create" }));
  }

  /** Drop the socket, then expect a prompt interruption and no send after it. */
  async function expectClientAbort(client: WSTestClient): Promise<void> {
    let sends = 0;
    const send = WebSocketConnection.prototype.send;
    vi.spyOn(WebSocketConnection.prototype, "send").mockImplementation(function (
      this: WebSocketConnection,
      data: string,
    ) {
      sends++;
      send.call(this, data);
    });
    client.destroy();
    // Well inside the delay (DELAY_MS), so the FIN is seen at once.
    await expect
      .poll(() => lastFixtureEntry()?.response.interrupted, { timeout: 750, interval: 10 })
      .toBe(true);
    const before = sends;
    // Past the end of the delay: the stopped turn sends nothing.
    await sleep(DELAY_MS + 200);
    expect(sends - before).toBe(0);
  }

  const turnKinds: Array<{ name: string; response: Fixture["response"]; firstEvent: string }> = [
    {
      name: "tool-call turn",
      response: {
        toolCalls: [{ name: "get_weather", arguments: JSON.stringify({ city: "x".repeat(80) }) }],
      },
      firstEvent: "response.output_item.added",
    },
    {
      name: "content + tool-call turn",
      response: {
        content: "Let me check that for you, it will take a moment or two.",
        toolCalls: [{ name: "get_weather", arguments: JSON.stringify({ city: "x".repeat(80) }) }],
      },
      firstEvent: "response.content_part.added",
    },
    {
      name: "blocks turn",
      response: {
        blocks: [
          { type: "text", text: "Here is the weather, read out slowly, one chunk at a time." },
          { type: "toolCall", name: "get_weather", arguments: '{"city":"NYC"}', id: "call_1" },
        ],
      },
      firstEvent: "response.created",
    },
  ];

  for (const kind of turnKinds) {
    it(`journals a client close mid-turn on a ${kind.name}`, async () => {
      mock.addFixture({
        match: { userMessage: HARNESS_MATCH },
        response: kind.response,
        chunkSize: 8,
        latency: DELAY_MS,
      });
      const client = await connectWebSocket(mock.url, REALTIME_PATH);
      await startConversationTurn(client);
      await waitFor(client, kind.firstEvent);
      await expectClientAbort(client);
    }, 15000);
  }

  it("journals a client close mid-transcription with a streaming profile", async () => {
    mock.addFixture({
      match: { endpoint: "realtime-transcription" },
      response: { transcription: { text: "A long live caption that streams out slowly." } },
      chunkSize: 4,
      streamingProfile: { ttft: 0, tps: 1000 / DELAY_MS },
    });
    const client = await connectWebSocket(
      mock.url,
      "/v1/realtime?model=gpt-realtime&intent=transcription",
    );
    await client.waitForMessages(1); // session.created
    client.send(
      JSON.stringify({
        type: "transcription_session.update",
        session: { input_audio_transcription: { model: "gpt-live-transcribe" } },
      }),
    );
    await client.waitForMessages(2); // transcription_session.updated
    client.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    await waitFor(client, "conversation.item.input_audio_transcription.delta");
    await expectClientAbort(client);
  }, 15000);
});

/**
 * aimock's own close (a bad client frame, or a send over the write limit)
 * marks the socket closed at once and emits `close` about 100ms later. A turn
 * that sees it is journaled with "disconnect", the reason for an aimock-caused
 * teardown, never "client aborted".
 */
describe("delivery lifecycle: WS Realtime aimock-side close", () => {
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

  const itemCreate = JSON.stringify({
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: HARNESS_MATCH }],
    },
  });
  const responseCreate = JSON.stringify({ type: "response.create" });

  async function expectDisconnect(): Promise<void> {
    await expect.poll(() => lastFixtureEntry()?.response.interrupted, { timeout: 3000 }).toBe(true);
    const entry = lastFixtureEntry()!;
    expect(entry.response.interruptReason).toBe("disconnect");
    expect(entry.response.status).toBe(200);
  }

  it("journals a bad frame mid text turn as disconnect", async () => {
    mock.addFixture({
      match: { userMessage: HARNESS_MATCH },
      response: { content: "x".repeat(400) },
      chunkSize: 8,
      latency: 30,
    });
    const client = await connectWebSocket(mock.url, REALTIME_PATH);
    await client.waitForMessages(1); // session.created
    client.send(itemCreate);
    client.send(responseCreate);
    await expect
      .poll(() => client.getMessages().some((m) => m.includes("response.output_text.delta")), {
        timeout: 3000,
      })
      .toBe(true);
    client.sendRawFrame(BAD_FRAME);
    await expectDisconnect();
  });

  it("journals a bad frame that lands before the turn starts as disconnect", async () => {
    mock.addFixture({
      match: { userMessage: HARNESS_MATCH },
      response: { content: "x".repeat(400) },
      chunkSize: 8,
      latency: 30,
    });
    const client = await connectWebSocket(mock.url, REALTIME_PATH);
    await client.waitForMessages(1); // session.created
    client.send(itemCreate);
    await client.waitForMessages(2); // conversation.item.created
    client.sendRawFrame(Buffer.concat([textFrame(responseCreate), BAD_FRAME]));
    await expectDisconnect();
  });

  it("journals a transcription whose last delta send closes the socket as disconnect", async () => {
    mock.addFixture({
      match: { endpoint: "realtime-transcription" },
      response: { transcription: { text: "ABCDEFGH" } },
      chunkSize: 4,
    });
    const sent = closeOnSend((data) => data.includes('"delta":"EFGH"'));
    const client = await connectWebSocket(
      mock.url,
      "/v1/realtime?model=gpt-realtime&intent=transcription",
    );
    await client.waitForMessages(1); // session.created
    client.send(
      JSON.stringify({
        type: "transcription_session.update",
        session: { input_audio_transcription: { model: "gpt-live-transcribe" } },
      }),
    );
    await client.waitForMessages(2); // transcription_session.updated
    client.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    await expectDisconnect();
    expect(sent.some((m) => m.includes("input_audio_transcription.completed"))).toBe(false);
  });
});
