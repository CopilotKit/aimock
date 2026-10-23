/**
 * Proxy hang-up detection on real sockets: a real front server runs the
 * record-mode relay (`proxyAndRecord`) inside `withHangUpDetection` against a
 * slow local upstream, and journals with `proxyInterruption`.
 *
 * - A client that sends its body, half-closes its write side and keeps reading
 *   is NOT a hang-up: the stream completes and nothing is marked, and if the
 *   upstream later dies mid-stream the tear-down is the proxy's, not the client's.
 * - A client whose socket is already gone when the helper is entered IS a
 *   hang-up, and is journaled as a client abort.
 */
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Logger } from "../logger.js";
import { proxyAndRecord } from "../recorder.js";
import { CLIENT_ABORTED } from "../response/lifecycle.js";
import { proxyInterruption, withHangUpDetection } from "../response/proxy.js";
import type { ChatCompletionRequest } from "../types.js";

const sse = (content: string): string =>
  `data: ${JSON.stringify({
    id: "chatcmpl-up",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-4o",
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  })}\n\n`;
const FRAMES = [sse("alpha"), sse(" beta"), sse(" gamma"), "data: [DONE]\n\n"];

const chatBody = JSON.stringify({
  model: "gpt-4o",
  messages: [{ role: "user", content: "proxy hang-up probe" }],
  stream: true,
});
const rawRequest =
  `POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\n` +
  `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(chatBody)}\r\n` +
  `Connection: close\r\n\r\n${chatBody}`;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return (server.address() as AddressInfo).port;
}

/**
 * An upstream that writes one SSE frame every `gapMs`. With `dieAfter`, it
 * destroys its socket after that many frames instead of finishing.
 */
async function slowUpstream(gapMs: number, dieAfter?: number): Promise<string> {
  const upstream = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    let i = 0;
    const next = (): void => {
      if (res.destroyed) return;
      if (dieAfter !== undefined && i >= dieAfter) {
        res.socket?.destroy();
        return;
      }
      if (i >= FRAMES.length) {
        res.end();
        return;
      }
      res.write(FRAMES[i++]);
      setTimeout(next, gapMs);
    };
    next();
  });
  return `http://127.0.0.1:${await listen(upstream)}`;
}

interface Journaled {
  clientHungUp: boolean;
  fields: ReturnType<typeof proxyInterruption>;
}

/**
 * A front server that relays every request to `upstreamUrl` the way the record
 * arm does. `enterAfterClose` enters the helper only once the client is gone.
 */
async function frontServer(
  upstreamUrl: string,
  opts: { allowHalfOpen: boolean; enterAfterClose?: boolean },
): Promise<{ port: number; journaled: Promise<Journaled> }> {
  const fixturePath = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-proxy-hangup-"));
  cleanups.push(() => fs.rmSync(fixturePath, { recursive: true, force: true }));
  let settle!: (j: Journaled) => void;
  let fail!: (err: unknown) => void;
  const journaled = new Promise<Journaled>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  const server = http.createServer((req, res) => {
    const relay = (): void => {
      withHangUpDetection(req, res, () =>
        proxyAndRecord(
          req,
          res,
          JSON.parse(chatBody) as ChatCompletionRequest,
          "openai",
          "/v1/chat/completions",
          [],
          { record: { providers: { openai: upstreamUrl }, fixturePath }, logger: new Logger() },
          chatBody,
        ),
      ).then(
        ({ clientHungUp }) =>
          settle({ clientHungUp, fields: proxyInterruption(res, clientHungUp) }),
        fail,
      );
    };
    req.resume();
    req.on("end", () => {
      if (opts.enterAfterClose) res.once("close", relay);
      else relay();
    });
  });
  // Node reads this undeclared flag on a peer FIN: true keeps the write side
  // open for a half-closed client, false (the default) ends the response.
  Object.assign(server, { httpAllowHalfOpen: opts.allowHalfOpen });
  return { port: await listen(server), journaled };
}

/** Send the request; on the first response bytes run `onFirstData`. Resolves with all bytes read. */
function rawClient(port: number, onFirstData: (socket: net.Socket) => void): Promise<string> {
  return new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    const socket = net.connect(port, "127.0.0.1", () => socket.write(rawRequest));
    socket.on("data", (d: Buffer) => {
      chunks.push(d);
      if (chunks.length === 1) onFirstData(socket);
    });
    socket.on("error", () => undefined);
    socket.on("close", () => resolve(Buffer.concat(chunks).toString()));
  });
}

describe("proxy hang-up detection", () => {
  it("a client that half-closes and keeps reading gets the whole stream and is not a hang-up", async () => {
    const { port, journaled } = await frontServer(await slowUpstream(100), {
      allowHalfOpen: true,
    });
    // Half-close: the request is complete, the read side stays open.
    const received = await rawClient(port, (socket) => socket.end());
    expect(received).toContain(" gamma");
    expect(received).toContain("data: [DONE]");
    const { clientHungUp, fields } = await journaled;
    expect(clientHungUp).toBe(false);
    expect(fields).toEqual({});
  }, 10000);

  it("a half-closed client is not blamed when the upstream dies mid-stream", async () => {
    const { port, journaled } = await frontServer(await slowUpstream(100, 2), {
      allowHalfOpen: true,
    });
    const received = await rawClient(port, (socket) => socket.end());
    expect(received).toContain("alpha");
    expect(received).not.toContain("data: [DONE]");
    const { clientHungUp, fields } = await journaled;
    expect(clientHungUp).toBe(false);
    expect(fields).toEqual({ interrupted: true, interruptReason: "proxy stream destroyed" });
  }, 10000);

  it("a client that hangs up mid-stream is journaled as a client abort", async () => {
    const { port, journaled } = await frontServer(await slowUpstream(200), {
      allowHalfOpen: true,
    });
    await rawClient(port, (socket) => socket.destroy());
    const { clientHungUp, fields } = await journaled;
    expect(clientHungUp).toBe(true);
    expect(fields).toEqual({ interrupted: true, interruptReason: CLIENT_ABORTED });
  }, 10000);

  it("a client already gone when the proxy helper is entered is journaled as a client abort", async () => {
    const { port, journaled } = await frontServer(await slowUpstream(100), {
      allowHalfOpen: false,
      enterAfterClose: true,
    });
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(rawRequest);
      setTimeout(() => socket.destroy(), 50);
    });
    socket.on("error", () => undefined);
    const { clientHungUp, fields } = await journaled;
    expect(clientHungUp).toBe(true);
    // Nothing of the response reached the socket: no status line, status 0.
    expect(fields).toEqual({ status: 0, interrupted: true, interruptReason: CLIENT_ABORTED });
  }, 10000);
});
