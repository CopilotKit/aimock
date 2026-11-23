/**
 * One teardown-attribution rule for the shared delivery code, on real sockets
 * and aimock's real server settings (`http.createServer` defaults:
 * `httpAllowHalfOpen` is false, so Node ends the response on a client FIN).
 *
 * - A client hang-up is the client's socket closing (Node ended our write side
 *   in answer to its FIN) or resetting (`errored`). A FIN alone is not one.
 * - A teardown aimock caused is `"disconnect"` (`"proxy stream destroyed"` on
 *   the proxy relay).
 * - "No status line sent" means nothing of this response reached the socket.
 */
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Logger } from "../logger.js";
import { proxyAndRecord } from "../recorder.js";
import { deliverJson, deliverStream } from "../response/deliver.js";
import type { FrameCodec } from "../response/frame-loop.js";
import { AIMOCK_DISCONNECTED, CLIENT_ABORTED, httpLifecycle } from "../response/lifecycle.js";
import { proxyInterruption, withHangUpDetection } from "../response/proxy.js";
import type { ChatCompletionRequest, Fixture, JournalEntry } from "../types.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** Listen on a server built with aimock's own settings (no `httpAllowHalfOpen`). */
async function listen(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return (server.address() as AddressInfo).port;
}

const chatBody = JSON.stringify({
  model: "gpt-4o",
  messages: [{ role: "user", content: "teardown probe" }],
  stream: true,
});
const rawRequest =
  `POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\n` +
  `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(chatBody)}\r\n\r\n${chatBody}`;

/**
 * A raw client: sends the request, runs `act` after `afterMs`, and resolves
 * with the bytes it read once its socket closes.
 */
function rawClient(port: number, afterMs: number, act: (s: net.Socket) => void): Promise<string> {
  return new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(rawRequest);
      setTimeout(() => act(socket), afterMs);
    });
    socket.on("data", (d: Buffer) => chunks.push(d));
    socket.on("error", () => undefined);
    socket.on("close", () => resolve(Buffer.concat(chunks).toString()));
  });
}

function entry(): JournalEntry {
  return {
    id: "e1",
    timestamp: 0,
    method: "POST",
    path: "/x",
    headers: {},
    body: null,
    response: { status: 200, fixture: null },
  };
}

const plain: Fixture = { match: {}, response: { content: "hello" } };
const timed: Fixture = {
  ...plain,
  nonStreamingTimingAllProviders: true,
  streamingProfile: { ttft: 400, tps: 10 },
};
const codec: FrameCodec<string> = {
  headers: { "Content-Type": "text/event-stream" },
  encode: (frame) => `data: ${frame}\n\n`,
};
const jsonOpts = { surface: "other" as const, payloadLength: 10, chunkSize: 5 };

describe("(1) a FIN alone is not a client hang-up", () => {
  it("a socket showing only the client FIN when aimock tears down is aimock's teardown, in the lifecycle and the proxy alike", async () => {
    let seen!: { readableEnded: boolean; writableEnded: boolean; lifecycle: string | undefined };
    let proxied!: Promise<{ clientHungUp: boolean }>;
    const port = await listen((req, res) => {
      req.resume();
      // aimock destroys the response in the tick the FIN is read, before Node
      // ends the write side for it: at that instant the socket shows the FIN
      // and nothing else, and both helpers judge it then.
      req.socket.prependListener("end", () => {
        res.destroy();
        const lifecycle = httpLifecycle(res, plain, { streaming: true });
        seen = {
          readableEnded: req.socket.readableEnded,
          writableEnded: req.socket.writableEnded,
          lifecycle: lifecycle.reason(),
        };
        lifecycle.dispose();
        proxied = withHangUpDetection(req, res, async () => undefined);
      });
    });
    await rawClient(port, 50, (s) => s.end());
    expect(seen).toEqual({
      readableEnded: true,
      writableEnded: false,
      lifecycle: AIMOCK_DISCONNECTED,
    });
    expect((await proxied).clientHungUp).toBe(false);
  });

  it("a client FIN that makes Node end the response is still the client's", async () => {
    const e = entry();
    let delivered!: Promise<{ clientHungUp: boolean }>;
    const port = await listen((req, res) => {
      req.resume();
      delivered = withHangUpDetection(req, res, () =>
        deliverStream(res, e, plain, codec, ["a", "b"], { latency: 300 }),
      );
    });
    await rawClient(port, 50, (s) => s.end());
    const { clientHungUp } = await delivered;
    expect(clientHungUp).toBe(true);
    expect(e.response).toMatchObject({
      status: 0,
      interrupted: true,
      interruptReason: CLIENT_ABORTED,
    });
  });
});

/** An upstream that answers only after `headDelayMs`, so no status line goes out before then. */
async function lateUpstream(headDelayMs: number): Promise<string> {
  const port = await listen((req, res) => {
    req.resume();
    const timer = setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "x", object: "chat.completion", choices: [] }));
    }, headDelayMs);
    res.on("close", () => clearTimeout(timer));
  });
  return `http://127.0.0.1:${port}`;
}

/** A front server running the record-mode relay inside the hang-up helper. */
async function proxyFront(
  upstreamUrl: string,
  before?: (res: http.ServerResponse, relay: () => void) => void,
): Promise<{
  port: number;
  journaled: Promise<ReturnType<typeof proxyInterruption> & { clientHungUp: boolean }>;
}> {
  const fixturePath = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-teardown-"));
  cleanups.push(() => fs.rmSync(fixturePath, { recursive: true, force: true }));
  let settle!: (v: ReturnType<typeof proxyInterruption> & { clientHungUp: boolean }) => void;
  const journaled = new Promise<ReturnType<typeof proxyInterruption> & { clientHungUp: boolean }>(
    (resolve) => (settle = resolve),
  );
  const port = await listen((req, res) => {
    const relay = (): void => {
      void withHangUpDetection(req, res, () =>
        proxyAndRecord(
          req,
          res,
          JSON.parse(chatBody) as ChatCompletionRequest,
          "openai",
          "/v1/chat/completions",
          [],
          {
            record: { providers: { openai: upstreamUrl }, fixturePath },
            logger: new Logger("silent"),
          },
          chatBody,
        ),
      ).then(({ clientHungUp }) =>
        settle({ clientHungUp, ...proxyInterruption(res, clientHungUp) }),
      );
    };
    req.resume();
    req.on("end", () => (before ? before(res, relay) : relay()));
  });
  return { port, journaled };
}

describe("(2) proxy: no status line sent journals status 0", () => {
  it("a client that hangs up before the upstream answers is journaled with status 0", async () => {
    const { port, journaled } = await proxyFront(await lateUpstream(400));
    const received = await rawClient(port, 100, (s) => s.destroy());
    expect(received).toBe("");
    expect(await journaled).toEqual({
      clientHungUp: true,
      status: 0,
      interrupted: true,
      interruptReason: CLIENT_ABORTED,
    });
  });
});

describe("(3) proxy: a response already gone at entry is blamed by evidence", () => {
  it("a response aimock destroyed before the relay is not a client hang-up", async () => {
    const { port, journaled } = await proxyFront(await lateUpstream(50), (res, relay) => {
      res.destroy();
      res.once("close", relay);
    });
    await rawClient(port, 1000, (s) => s.destroy());
    const fields = await journaled;
    expect(fields.clientHungUp).toBe(false);
    expect(fields.interruptReason).toBe("proxy stream destroyed");
  });

  it("a client gone before the relay is still the client's", async () => {
    const { port, journaled } = await proxyFront(await lateUpstream(50), (res, relay) => {
      res.once("close", relay);
    });
    await rawClient(port, 50, (s) => s.destroy());
    const fields = await journaled;
    expect(fields.clientHungUp).toBe(true);
    expect(fields.interruptReason).toBe(CLIENT_ABORTED);
  });
});

describe("(4) deliverJson untimed: a response already gone is not written", () => {
  it("aimock's own teardown: nothing written, the thunk never runs, journaled as a disconnect with status 0", async () => {
    const e = entry();
    const body = vi.fn(() => ({ ok: true }));
    let delivered!: Promise<void>;
    const errors: unknown[] = [];
    const port = await listen((req, res) => {
      req.resume();
      res.on("error", (err) => errors.push(err));
      req.on("end", () => {
        res.destroy();
        res.once("close", () => {
          delivered = deliverJson(res, e, plain, body, jsonOpts);
        });
      });
    });
    const received = await rawClient(port, 1000, (s) => s.destroy());
    await vi.waitFor(() => expect(delivered).toBeDefined());
    await delivered;
    expect(received).toBe("");
    expect(errors).toEqual([]);
    expect(body).not.toHaveBeenCalled();
    expect(e.response).toMatchObject({
      status: 0,
      interrupted: true,
      interruptReason: AIMOCK_DISCONNECTED,
    });
  });

  it("a client gone first: journaled as a client abort with status 0", async () => {
    const e = entry();
    const body = vi.fn(() => ({ ok: true }));
    let delivered!: Promise<void>;
    const port = await listen((req, res) => {
      req.resume();
      res.on("error", () => undefined);
      res.once("close", () => {
        delivered = deliverJson(res, e, plain, body, jsonOpts);
      });
    });
    await rawClient(port, 50, (s) => s.destroy());
    await vi.waitFor(() => expect(delivered).toBeDefined());
    await delivered;
    expect(body).not.toHaveBeenCalled();
    expect(e.response).toMatchObject({
      status: 0,
      interrupted: true,
      interruptReason: CLIENT_ABORTED,
    });
  });
});

describe("(5) deliverJson timed: a response ended during the wait", () => {
  it("is not written again and does not throw ERR_HTTP_HEADERS_SENT", async () => {
    const e = entry();
    const body = vi.fn(() => ({ ok: true }));
    let delivered!: Promise<void>;
    const port = await listen((req, res) => {
      req.resume();
      delivered = deliverJson(res, e, timed, body, jsonOpts);
      setTimeout(() => {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end("{}");
      }, 50);
    });
    const received = await rawClient(port, 1200, (s) => s.destroy());
    await expect(delivered).resolves.toBeUndefined();
    expect(received).toContain("503");
    expect(body).not.toHaveBeenCalled();
    expect(e.response).toMatchObject({
      status: 503,
      interrupted: true,
      interruptReason: AIMOCK_DISCONNECTED,
    });
  });
});

describe("(6) status 0 is judged by bytes reaching the socket, not headersSent", () => {
  /** A response whose `writeHead` commits the head without any byte reaching the socket. */
  class HeadOnlyRes extends EventEmitter {
    destroyed = false;
    writableEnded = false;
    writableFinished = false;
    headersSent = false;
    statusCode = 200;
    socket = { bytesWritten: 0, errored: null as Error | null, writableEnded: false };
    writeHead(status: number): this {
      this.statusCode = status;
      this.headersSent = true;
      return this;
    }
    setHeader(): void {}
    write(): boolean {
      this.socket.bytesWritten += 10;
      return true;
    }
    end(): this {
      this.writableEnded = true;
      this.writableFinished = true;
      return this;
    }
    destroy(): this {
      this.destroyed = true;
      return this;
    }
  }

  it("a client that leaves after writeHead but before any byte reached the socket journals status 0", async () => {
    vi.useFakeTimers();
    try {
      const res = new HeadOnlyRes();
      const e = entry();
      const headFirst: FrameCodec<string> = { ...codec, writeHeadImmediately: true };
      const promise = deliverStream(
        res as unknown as http.ServerResponse,
        e,
        plain,
        headFirst,
        ["a", "b"],
        { latency: 50 },
      );
      await vi.advanceTimersByTimeAsync(20);
      expect(res.headersSent).toBe(true);
      res.socket.errored = new Error("read ECONNRESET");
      res.destroyed = true;
      res.emit("close");
      await promise;
      expect(e.response).toMatchObject({
        status: 0,
        interrupted: true,
        interruptReason: CLIENT_ABORTED,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
