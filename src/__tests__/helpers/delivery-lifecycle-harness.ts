/**
 * Shared real-socket harness for the delivery lifecycle (plan T5). Each
 * provider's test file calls {@link describeDeliveryLifecycle} with one row
 * describing its paths and bodies, and gets the same cases:
 *
 * - a client abort mid-stream is journaled (`interrupted`, `"client aborted"`,
 *   status 200) and nothing is written after it;
 * - a healthy stream is not marked;
 * - a fixture interruption keeps its own reason;
 * - `nonStreamingTimingAllProviders: true` delays a `stream: false` reply
 *   (regression row c);
 * - `nonStreamingTiming: true` on a shared fixture delays OpenAI chat only
 *   (regression rows a and b);
 * - the non-stream default (profile and recorded timings), bare latency and
 *   error fixtures stay instant;
 * - a client abort during the non-stream wait writes nothing and is journaled
 *   with status 0 (no status line was sent);
 * - optionally, a proxied stream the client abandons is journaled.
 *
 * WebSocket rows (`transport: "ws"`) get the three stream cases through
 * the per-transport handshake, plus a bare TCP drop during a delay, which must
 * stop the turn promptly. Real sockets only: one LLMock per file on port
 * 0, `expect.poll` on the journal, one-sided time bounds, never fake timers.
 */
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo, Socket } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { LLMock } from "../../llmock.js";
import { WebSocketConnection } from "../../ws-framing.js";
import type { Fixture, JournalEntry, RecordProviderKey } from "../../types.js";
import { connectWebSocket, type WSTestClient } from "../ws-test-client.js";

/** The user message every harness fixture matches. Rows put it in their bodies. */
export const HARNESS_MATCH = "delivery lifecycle probe";
const LONG_CONTENT =
  "The quick brown fox jumps over the lazy dog, again and again, for a long time. ".repeat(4);

export type WsTransport = "responses" | "realtime" | "gemini-live";

export interface DeliveryLifecycleRow {
  name: string;
  /** HTTP path, or the WebSocket upgrade path for `transport: "ws"`. */
  streamPath: string;
  nonStreamPath: string;
  /** JSON body, or the multipart form fields (a small audio file is added). */
  streamBody: Record<string, unknown>;
  nonStreamBody: Record<string, unknown>;
  bodyKind: "json" | "multipart";
  headers?: Record<string, string>;
  /** How the stream rows run: an HTTP request, or a WebSocket turn. */
  transport: "http" | "ws";
  surface: "openai-chat" | "other";
  /** A record-mode passthrough row: the provider key and wire framing of a slow upstream. */
  proxy?: { provider: RecordProviderKey; contentType: string; frames: Array<string | Buffer> };
  /** False for stream-only surfaces (no non-streaming rows). */
  nonStream?: false;
  /** The handshake for a WebSocket row. */
  wsTransport?: WsTransport;
  /** The fixture `match` (default: the harness user message). */
  match?: Fixture["match"];
  /** The fixture response for the stream rows (default: long text content). */
  streamResponse?: Fixture["response"];
}

interface Exchange {
  status: number;
  elapsedMs: number;
  body: Buffer;
  /** Resolves once the connection has closed. */
  closed: Promise<void>;
}

let writeCalls = 0;

/** Count every HTTP response write and every WebSocket send from here on. */
function countServerWrites(): void {
  const targets: Array<[object, string]> = [
    [http.ServerResponse.prototype, "writeHead"],
    [http.ServerResponse.prototype, "write"],
    [http.ServerResponse.prototype, "end"],
    [WebSocketConnection.prototype, "send"],
  ];
  for (const [proto, method] of targets) {
    const record = proto as Record<string, (...args: unknown[]) => unknown>;
    const original = record[method];
    vi.spyOn(record, method).mockImplementation(function (this: unknown, ...args: unknown[]) {
      writeCalls++;
      return original.apply(this, args);
    });
  }
}

const BOUNDARY = "----aimock-lifecycle-boundary";

function encodeBody(
  row: DeliveryLifecycleRow,
  body: Record<string, unknown>,
): { payload: Buffer; contentType: string } {
  if (row.bodyKind === "json") {
    return { payload: Buffer.from(JSON.stringify(body)), contentType: "application/json" };
  }
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(body)) {
    parts.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${String(value)}\r\n`,
      ),
    );
  }
  parts.push(
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\n` +
        `Content-Type: audio/wav\r\n\r\nRIFF\r\n--${BOUNDARY}--\r\n`,
    ),
  );
  return {
    payload: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${BOUNDARY}`,
  };
}

function send(
  baseUrl: string,
  row: DeliveryLifecycleRow,
  pathName: string,
  body: Record<string, unknown>,
): http.ClientRequest {
  const { payload, contentType } = encodeBody(row, body);
  const req = http.request(new URL(pathName, baseUrl), {
    method: "POST",
    agent: false,
    headers: { "content-type": contentType, ...row.headers },
  });
  req.on("error", () => undefined);
  req.end(payload);
  return req;
}

function exchange(
  baseUrl: string,
  row: DeliveryLifecycleRow,
  pathName: string,
  body: Record<string, unknown>,
): Promise<Exchange> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const req = send(baseUrl, row, pathName, body);
    const closed = connectionClosed(req);
    req.on("response", (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          elapsedMs: Date.now() - start,
          body: Buffer.concat(chunks),
          closed,
        }),
      );
      res.on("error", reject);
    });
    req.on("error", reject);
  });
}

/** Send a stream request, wait for the first body bytes, then hang up. */
function abortAfterFirstChunk(
  baseUrl: string,
  row: DeliveryLifecycleRow,
  pathName: string,
  body: Record<string, unknown>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = send(baseUrl, row, pathName, body);
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error("no first chunk within 5s"));
    }, 5000);
    req.on("response", (res) => {
      res.once("data", () => {
        clearTimeout(timer);
        req.destroy();
        resolve();
      });
      res.on("error", () => undefined);
    });
  });
}

/** Send a request and hang up after `ms`. Resolves with the bytes received. */
function abortAfter(
  baseUrl: string,
  row: DeliveryLifecycleRow,
  pathName: string,
  body: Record<string, unknown>,
  ms: number,
): Promise<{ gotBytes: number }> {
  return new Promise((resolve) => {
    let gotBytes = 0;
    const req = send(baseUrl, row, pathName, body);
    req.on("response", (res) => {
      res.on("data", (c: Buffer) => {
        gotBytes += c.length;
      });
      res.on("error", () => undefined);
    });
    setTimeout(() => {
      req.destroy();
      resolve({ gotBytes });
    }, ms);
  });
}

/** Resolve once the client side of `req`'s connection has closed. */
function connectionClosed(req: http.ClientRequest): Promise<void> {
  return new Promise((resolve) => {
    const onSocket = (socket: Socket): void => {
      if (socket.destroyed) resolve();
      else socket.once("close", () => resolve());
    };
    if (req.socket) onSocket(req.socket);
    else req.once("socket", onSocket);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lastEntry(mock: LLMock): JournalEntry | undefined {
  return mock.getRequests().at(-1);
}

function lastFixtureEntry(mock: LLMock): JournalEntry | undefined {
  return mock
    .getRequests()
    .filter((e) => e.response.fixture !== null)
    .at(-1);
}

// ─── WebSocket handshakes ──────────────────────────────────────────────────

function typeOf(message: string): string {
  const parsed = JSON.parse(message) as Record<string, unknown>;
  return typeof parsed.type === "string" ? parsed.type : (Object.keys(parsed)[0] ?? "");
}

const WS_CONTENT: Record<WsTransport, (m: string) => boolean> = {
  responses: (m) => typeOf(m) === "response.output_text.delta",
  realtime: (m) => ["response.output_text.delta", "response.text.delta"].includes(typeOf(m)),
  "gemini-live": (m) => typeOf(m) === "serverContent",
};

const WS_DONE: Record<WsTransport, (m: string) => boolean> = {
  responses: (m) => typeOf(m) === "response.completed",
  realtime: (m) => typeOf(m) === "response.done",
  "gemini-live": (m) => {
    const parsed = JSON.parse(m) as { serverContent?: { turnComplete?: boolean } };
    return parsed.serverContent?.turnComplete === true;
  },
};

/** Run the transport's handshake up to the request that starts the turn. */
async function startWsTurn(client: WSTestClient, transport: WsTransport): Promise<void> {
  switch (transport) {
    case "responses":
      client.send(
        JSON.stringify({
          type: "response.create",
          model: "gpt-4o",
          input: [{ role: "user", content: HARNESS_MATCH }],
        }),
      );
      return;
    case "realtime":
      await client.waitForMessages(1); // session.created
      client.send(JSON.stringify({ type: "session.update", session: { modalities: ["text"] } }));
      await client.waitForMessages(2); // session.updated
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
      return;
    case "gemini-live":
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
      return;
  }
}

async function waitForWsMessage(
  client: WSTestClient,
  predicate: (m: string) => boolean,
  timeoutMs = 8000,
): Promise<void> {
  await expect
    .poll(() => client.getMessages().some(predicate), { timeout: timeoutMs, interval: 20 })
    .toBe(true);
}

// ─── The cases ─────────────────────────────────────────────────────────────

export function describeDeliveryLifecycle(row: DeliveryLifecycleRow): void {
  describe(`delivery lifecycle: ${row.name}`, () => {
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
      mock.disableRecording();
      writeCalls = 0;
    });

    const use = (extra: Partial<Fixture>, response?: Fixture["response"]): void => {
      mock.addFixture({
        match: row.match ?? { userMessage: HARNESS_MATCH },
        response: response ?? row.streamResponse ?? { content: LONG_CONTENT },
        chunkSize: 8,
        ...extra,
      });
    };

    if (row.transport === "ws") {
      const transport = row.wsTransport;
      if (!transport) throw new Error(`WS row ${row.name} needs a wsTransport`);

      it("journals a client close mid-turn and sends nothing after it", async () => {
        use({ latency: 300 });
        const client = await connectWebSocket(mock.url, row.streamPath, row.headers);
        await startWsTurn(client, transport);
        await waitForWsMessage(client, WS_CONTENT[transport]);
        client.destroy();
        countServerWrites();
        await expect
          .poll(() => lastFixtureEntry(mock)?.response.interrupted, { timeout: 2000 })
          .toBe(true);
        const entry = lastFixtureEntry(mock)!;
        expect(entry.response.interruptReason).toBe("client aborted");
        expect(entry.response.status).toBe(200);
        const before = writeCalls;
        await sleep(900);
        expect(writeCalls - before).toBe(0);
      }, 15000);

      it("stops the turn promptly when the client drops TCP during a delay", async () => {
        // A bare FIN with no close frame, while the turn waits out a long delay.
        // The turn stops long before the delay ends, so the drop is seen at once,
        // not at the next failed write. The reason is not asserted here.
        use({ latency: 1500 });
        const client = await connectWebSocket(mock.url, row.streamPath, row.headers);
        await startWsTurn(client, transport);
        await waitForWsMessage(client, WS_CONTENT[transport]);
        countServerWrites();
        client.destroy();
        await expect
          .poll(() => lastFixtureEntry(mock)?.response.interrupted, { timeout: 750, interval: 10 })
          .toBe(true);
        const before = writeCalls;
        await sleep(1700);
        expect(writeCalls - before).toBe(0);
      }, 15000);

      it("does not mark a healthy turn", async () => {
        use({ latency: 0 });
        const client = await connectWebSocket(mock.url, row.streamPath, row.headers);
        await startWsTurn(client, transport);
        await waitForWsMessage(client, WS_DONE[transport]);
        const entry = lastFixtureEntry(mock)!;
        expect(entry.response.interrupted).toBeUndefined();
        expect(entry.response.interruptReason).toBeUndefined();
        // A close after a complete turn is not an interruption either.
        client.close();
        await sleep(300);
        expect(entry.response.interrupted).toBeUndefined();
        expect(entry.response.interruptReason).toBeUndefined();
      }, 10000);

      it("keeps the fixture's own interruption reason", async () => {
        use({ latency: 0, truncateAfterChunks: 2 });
        const client = await connectWebSocket(mock.url, row.streamPath, row.headers);
        await startWsTurn(client, transport);
        await expect
          .poll(() => lastFixtureEntry(mock)?.response.interrupted, { timeout: 2000 })
          .toBe(true);
        expect(lastFixtureEntry(mock)!.response.interruptReason).toBe("truncateAfterChunks");
        expect(lastFixtureEntry(mock)!.response.status).toBe(200);
        client.destroy();
      }, 10000);
      return;
    }

    it("journals a client abort mid-stream and writes nothing after it", async () => {
      use({ streamingProfile: { ttft: 0, tps: 5 } });
      await abortAfterFirstChunk(mock.url, row, row.streamPath, row.streamBody);
      countServerWrites();
      await expect.poll(() => lastEntry(mock)?.response.interrupted, { timeout: 2000 }).toBe(true);
      const entry = lastEntry(mock)!;
      expect(entry.response.interruptReason).toBe("client aborted");
      expect(entry.response.status).toBe(200);
      const before = writeCalls;
      await sleep(600);
      expect(writeCalls - before).toBe(0);
    }, 10000);

    it("does not mark a healthy stream", async () => {
      use({ latency: 0 });
      const res = await exchange(mock.url, row, row.streamPath, row.streamBody);
      expect(res.status).toBe(200);
      const entry = lastEntry(mock)!;
      expect(entry.response.interrupted).toBeUndefined();
      expect(entry.response.interruptReason).toBeUndefined();
      // A close after a complete stream is not an interruption either.
      await res.closed;
      await sleep(100);
      expect(entry.response.interrupted).toBeUndefined();
      expect(entry.response.interruptReason).toBeUndefined();
    }, 10000);

    it("keeps the fixture's own interruption reason", async () => {
      use({ latency: 0, truncateAfterChunks: 2 });
      await exchange(mock.url, row, row.streamPath, row.streamBody).catch(() => undefined);
      await expect.poll(() => lastEntry(mock)?.response.interrupted, { timeout: 2000 }).toBe(true);
      expect(lastEntry(mock)!.response.interruptReason).toBe("truncateAfterChunks");
      expect(lastEntry(mock)!.response.status).toBe(200);
    }, 10000);

    if (row.proxy) {
      const proxy = row.proxy;
      it("journals a client abort on a proxied stream and stops relaying", async () => {
        // The upstream writes through the unspied methods, so the write count
        // below sees only what aimock writes to its client.
        const upstreamWrite = http.ServerResponse.prototype.write;
        const upstreamEnd = http.ServerResponse.prototype.end;
        const upstream = http.createServer((_req, res) => {
          res.writeHead(200, { "Content-Type": proxy.contentType });
          let i = 0;
          const next = (): void => {
            if (res.destroyed) return;
            if (i >= proxy.frames.length) {
              Reflect.apply(upstreamEnd, res, []);
              return;
            }
            Reflect.apply(upstreamWrite, res, [proxy.frames[i++]]);
            setTimeout(next, 500);
          };
          next();
        });
        await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
        const fixturePath = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-lifecycle-proxy-"));
        try {
          const port = (upstream.address() as AddressInfo).port;
          mock.enableRecording({
            providers: { [proxy.provider]: `http://127.0.0.1:${port}` },
            fixturePath,
          });
          await abortAfterFirstChunk(mock.url, row, row.streamPath, row.streamBody);
          countServerWrites();
          await expect
            .poll(() => lastEntry(mock)?.response.source, { timeout: 3000 })
            .toBe("proxy");
          const entry = lastEntry(mock)!;
          expect(entry.response.interrupted).toBe(true);
          expect(entry.response.interruptReason).toBe("client aborted");
          // The upstream keeps sending a frame every 500ms for over 2s: none
          // of it reaches the client that left.
          await sleep(1200);
          expect(writeCalls).toBe(0);
        } finally {
          upstream.closeAllConnections();
          await new Promise<void>((resolve) => upstream.close(() => resolve()));
          fs.rmSync(fixturePath, { recursive: true, force: true });
        }
      }, 10000);
    }

    if (row.nonStream === false) return;

    it("nonStreamingTimingAllProviders: true delays the non-streaming reply (row c)", async () => {
      use(
        { nonStreamingTimingAllProviders: true, streamingProfile: { ttft: 300, tps: 10000 } },
        { content: "short" },
      );
      const res = await exchange(mock.url, row, row.nonStreamPath, row.nonStreamBody);
      expect(res.status).toBe(200);
      expect(res.elapsedMs).toBeGreaterThanOrEqual(250);
    }, 10000);

    it("nonStreamingTiming: true on a shared fixture delays OpenAI chat only (rows a and b)", async () => {
      use({ nonStreamingTiming: true, streamingProfile: { ttft: 2000 } }, { content: "short" });
      const shared = await exchange(mock.url, row, row.nonStreamPath, row.nonStreamBody);
      expect(shared.status).toBe(200);
      if (row.surface === "openai-chat") {
        // Row b: the shipped delay (ttft 2000, no tps: exactly 2000ms in total).
        expect(shared.elapsedMs).toBeGreaterThanOrEqual(1995);
        mock.clearFixtures();
        mock.clearRequests();
        use(
          { nonStreamingTimingAllProviders: true, streamingProfile: { ttft: 2000 } },
          { content: "short" },
        );
        const all = await exchange(mock.url, row, row.nonStreamPath, row.nonStreamBody);
        // Row c on OpenAI pays the same computed total.
        expect(all.elapsedMs).toBeGreaterThanOrEqual(1995);
      } else {
        // Row a: other providers ignore nonStreamingTiming: true.
        expect(shared.elapsedMs).toBeLessThan(1000);
      }
    }, 15000);

    it("stays instant by default with a profile or recorded timings", async () => {
      use({ streamingProfile: { ttft: 2000 } }, { content: "short" });
      const a = await exchange(mock.url, row, row.nonStreamPath, row.nonStreamBody);
      mock.clearFixtures();
      use(
        {
          recordedTimings: { ttftMs: 2000, interChunkDelaysMs: [500, 500], totalDurationMs: 3000 },
        },
        { content: "short" },
      );
      const b = await exchange(mock.url, row, row.nonStreamPath, row.nonStreamBody);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(a.elapsedMs).toBeLessThan(1000);
      expect(b.elapsedMs).toBeLessThan(1000);
    }, 10000);

    it("never delays on bare latency, even when opted in", async () => {
      use({ latency: 2000, nonStreamingTimingAllProviders: true }, { content: "short" });
      const res = await exchange(mock.url, row, row.nonStreamPath, row.nonStreamBody);
      expect(res.status).toBe(200);
      expect(res.elapsedMs).toBeLessThan(1000);
    }, 10000);

    it("never delays an error fixture, and keeps its status", async () => {
      use(
        { nonStreamingTimingAllProviders: true, streamingProfile: { ttft: 2000 } },
        { error: { message: "rate limited", type: "rate_limit_error" }, status: 429 },
      );
      const res = await exchange(mock.url, row, row.nonStreamPath, row.nonStreamBody);
      expect(res.status).toBe(429);
      expect(res.elapsedMs).toBeLessThan(1000);
    }, 10000);

    const nonStreamAbortCases: Array<[string, Partial<Fixture>]> = [
      ["nonStreamingTimingAllProviders", { nonStreamingTimingAllProviders: true }],
    ];
    if (row.surface === "openai-chat") {
      nonStreamAbortCases.push(["nonStreamingTiming", { nonStreamingTiming: true }]);
    }
    for (const [label, optIn] of nonStreamAbortCases) {
      it(`a client abort during the ${label} wait writes nothing and is journaled`, async () => {
        use({ ...optIn, streamingProfile: { ttft: 2000 } }, { content: "short" });
        countServerWrites();
        const { gotBytes } = await abortAfter(
          mock.url,
          row,
          row.nonStreamPath,
          row.nonStreamBody,
          100,
        );
        expect(gotBytes).toBe(0);
        await expect
          .poll(() => lastEntry(mock)?.response.interrupted, { timeout: 1000 })
          .toBe(true);
        const entry = lastEntry(mock)!;
        expect(entry.response.interruptReason).toBe("client aborted");
        // No status line was ever sent, so the journal says 0, not 200.
        expect(entry.response.status).toBe(0);
        // Past the full 2000ms wait: nothing was ever written.
        await sleep(2200);
        expect(writeCalls).toBe(0);
      }, 10000);
    }
  });
}
