import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { createHash } from "node:crypto";
import { once, getEventListeners } from "node:events";
import type { Socket } from "node:net";
import { UpstreamWebSocketRefusedError, connectUpstreamWebSocket } from "../ws-upstream.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
function frame(op: number, text: string, fin = true) {
  const payload = Buffer.from(text);
  return Buffer.concat([Buffer.from([(fin ? 128 : 0) | op, payload.length]), payload]);
}
async function createTransportPeer(
  options: {
    status?: number;
    badAccept?: boolean;
    extra?: string;
    head?: Buffer;
    hang?: boolean;
    badUpgrade?: boolean;
    body?: string;
    tls?: boolean;
    delayMs?: number;
  } = {},
) {
  const server = options.tls ? createTlsServer({ key: TEST_KEY, cert: TEST_CERT }) : createServer();
  const sockets = new Set<Socket>();
  const requests: IncomingMessage[] = [];
  const frames: Array<{ masked: boolean; opcode: number; text: string }> = [];
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("end", () => socket.end());
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (req, socket) => {
    requests.push(req);
    if (options.hang) return;
    if (options.status) {
      socket.end(
        `HTTP/1.1 ${options.status} Refused\r\nContent-Length: ${Buffer.byteLength(options.body ?? "secret-token")}\r\n\r\n${options.body ?? "secret-token"}`,
      );
      return;
    }
    const reply = () => {
      const accept = createHash("sha1")
        .update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");
      socket.write(
        Buffer.concat([
          Buffer.from(
            `HTTP/1.1 101 Switching Protocols\r\nUpgrade: ${options.badUpgrade ? "other" : "websocket"}\r\nConnection: keep-alive, Upgrade\r\nSec-WebSocket-Accept: ${options.badAccept ? "wrong" : accept}\r\n${options.extra ?? ""}\r\n`,
          ),
          options.head ?? Buffer.alloc(0),
        ]),
      );
      let buffered = Buffer.alloc(0);
      socket.on("data", (data: Buffer) => {
        buffered = Buffer.concat([buffered, data]);
        while (buffered.length >= 2) {
          const masked = Boolean(buffered[1] & 128);
          const length = buffered[1] & 127;
          const offset = masked ? 6 : 2;
          if (buffered.length < offset + length) return;
          const payload = Buffer.from(buffered.subarray(offset, offset + length));
          if (masked) for (let i = 0; i < length; i++) payload[i] ^= buffered[2 + (i % 4)];
          const opcode = buffered[0] & 15;
          frames.push({ masked, opcode, text: payload.toString() });
          buffered = buffered.subarray(offset + length);
          if (opcode === 1) socket.write(frame(1, "transport-probe"));
          if (opcode === 8) socket.end();
        }
      });
    };
    const timer = setTimeout(reply, options.delayMs ?? 0);
    socket.once("close", () => clearTimeout(timer));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing peer address");
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  cleanups.push(close);
  return {
    url: new URL(`${options.tls ? "https" : "http"}://127.0.0.1:${address.port}/v1/live/sessions`),
    requests,
    frames,
    sockets,
    close,
  };
}
async function open(options: Parameters<typeof createTransportPeer>[0] = {}) {
  const peer = await createTransportPeer(options);
  const controller = new AbortController();
  cleanups.push(async () => controller.abort());
  return {
    peer,
    controller,
    connect: () =>
      connectUpstreamWebSocket(
        peer.url,
        {
          Authorization: "Bearer transport-secret",
          "X-Test-Id": "private",
          "OpenAI-Beta": "unreviewed",
          "OpenAI-Project": "caller-project",
          Cookie: "private",
          "Sec-WebSocket-Protocol": "private",
        },
        {},
        controller.signal,
      ),
  };
}

describe("upstream WebSocket transport", () => {
  it("upgrades with allowlisted headers, masks writes and answers ping", async () => {
    const { peer, controller, connect } = await open({ head: frame(9, "ping") });
    const ws = await connect();
    const message = once(ws, "message");
    await ws.sendAsync("probe");
    expect((await message)[0]).toBe("transport-probe");
    await expect.poll(() => peer.frames.length).toBe(2);
    expect(peer.requests[0].method).toBe("GET");
    expect(peer.requests[0].url).toBe("/v1/live/sessions");
    expect(peer.requests[0].headers.authorization).toBe("Bearer transport-secret");
    expect(peer.requests[0].headers["x-test-id"]).toBeUndefined();
    expect(peer.requests[0].headers.cookie).toBeUndefined();
    expect(peer.requests[0].headers["openai-beta"]).toBeUndefined();
    expect(peer.requests[0].headers["openai-project"]).toBeUndefined();
    expect(peer.requests[0].headers["sec-websocket-protocol"]).toBeUndefined();
    expect(peer.frames.every((f) => f.masked)).toBe(true);
    expect(peer.frames.find((f) => f.opcode === 10)?.text).toBe("ping");
    controller.abort();
    await expect.poll(() => peer.sockets.size).toBe(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
  it("delivers upgrade head once after callers attach listeners, including fragments", async () => {
    const { connect } = await open({
      head: Buffer.concat([frame(1, "transport-", false), frame(0, "probe")]),
    });
    const ws = await connect();
    const messages: string[] = [];
    ws.on("message", (text) => messages.push(text));
    await expect.poll(() => messages).toEqual(["transport-probe"]);
    ws.destroy();
  });
  it.each([
    { badAccept: true },
    { badUpgrade: true },
    { extra: "Sec-WebSocket-Extensions: permessage-deflate\r\n" },
    { extra: "Sec-WebSocket-Protocol: surprise\r\n" },
  ])("rejects invalid upgrade %j", async (options) => {
    const { peer, connect, controller } = await open(options);
    await expect(connect()).rejects.toThrow("Invalid upstream WebSocket upgrade");
    await expect.poll(() => peer.sockets.size).toBe(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
  it.each([302, 401, 403, 500])(
    "rejects %s without exposing body or following redirects",
    async (status) => {
      const { peer, connect } = await open({ status });
      await expect(connect()).rejects.toThrow(`Upstream WebSocket refused (HTTP ${status})`);
      expect(peer.requests).toHaveLength(1);
      await expect.poll(() => peer.sockets.size).toBe(0);
    },
  );
  it("names a refusal's JSON error code and type, without exposing the body text", async () => {
    const body = JSON.stringify({
      error: {
        message: "secret-token detail",
        type: "insufficient_quota",
        code: "insufficient_quota",
      },
    });
    const { connect } = await open({ status: 429, body });
    const error = await connect().then(
      () => new Error("expected a refusal"),
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(UpstreamWebSocketRefusedError);
    const refused = error as UpstreamWebSocketRefusedError;
    expect(refused.message).toBe("Upstream WebSocket refused (HTTP 429)");
    expect(refused.name).toBe("Error");
    expect(refused.status).toBe(429);
    expect(refused.errorCode).toBe("insufficient_quota");
    expect(refused.errorType).toBe("insufficient_quota");
    expect(JSON.stringify({ ...refused })).not.toContain("secret-token");
    // A non-JSON body names nothing.
    const plain = await (await open({ status: 429 })).connect().catch((err: unknown) => err);
    expect((plain as UpstreamWebSocketRefusedError).errorCode).toBeUndefined();
  });
  it("bounds refusal body", async () => {
    const { peer, connect } = await open({ status: 401, body: "secret".repeat(20000) });
    await expect(connect()).rejects.toThrow("Upstream WebSocket refusal body limit exceeded");
    await expect.poll(() => peer.sockets.size).toBe(0);
  });
  it("aborts pending upgrades and honors pre-abort", async () => {
    const { peer, connect, controller } = await open({ hang: true });
    const pending = connect();
    const rejected = expect(pending).rejects.toThrow("Upstream WebSocket aborted");
    await expect.poll(() => peer.requests.length).toBe(1);
    controller.abort();
    await rejected;
    await expect(connect()).rejects.toThrow("Upstream WebSocket aborted");
    await expect.poll(() => peer.sockets.size).toBe(0);
  });
  it("honors caller upgrade timeout", async () => {
    const peer = await createTransportPeer({ hang: true });
    await expect(
      connectUpstreamWebSocket(peer.url, {}, {}, AbortSignal.timeout(30)),
    ).rejects.toThrow("Upstream WebSocket aborted");
    await expect.poll(() => peer.sockets.size).toBe(0);
  });
  it("honors an explicit short upgrade budget and removes abort listeners", async () => {
    const peer = await createTransportPeer({ hang: true });
    const controller = new AbortController();
    const cutoff = setTimeout(() => controller.abort(), 2000);
    try {
      await expect(
        connectUpstreamWebSocket(peer.url, {}, {}, controller.signal, 30),
      ).rejects.toThrow("Upstream WebSocket upgrade timed out");
      expect(peer.requests).toHaveLength(1);
      await expect.poll(() => peer.sockets.size).toBe(0);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    } finally {
      clearTimeout(cutoff);
      controller.abort();
    }
  });
  it("preserves the default thirty second upgrade deadline", async () => {
    const peer = await createTransportPeer({ hang: true });
    const started = performance.now();
    await expect(
      connectUpstreamWebSocket(peer.url, {}, {}, AbortSignal.timeout(34_000)),
    ).rejects.toThrow("Upstream WebSocket upgrade timed out");
    expect(performance.now() - started).toBeGreaterThanOrEqual(29_000);
    await expect.poll(() => peer.sockets.size).toBe(0);
  }, 35_000);
  it("allows a configured upgrade deadline beyond thirty seconds", async () => {
    const peer = await createTransportPeer({ delayMs: 31_000 });
    const ws = await connectUpstreamWebSocket(
      peer.url,
      {},
      {},
      AbortSignal.timeout(60_000),
      60_000,
    );
    ws.destroy();
    await expect.poll(() => peer.sockets.size).toBe(0);
  }, 35_000);
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid upgrade deadline %s before opening transport",
    async (timeout) => {
      const peer = await createTransportPeer();
      await expect(
        connectUpstreamWebSocket(peer.url, {}, {}, AbortSignal.timeout(2000), timeout),
      ).rejects.toThrow("Upstream WebSocket timeout must be a positive safe integer");
      expect(peer.requests).toHaveLength(0);
    },
  );
  it("does not overflow a large safe integer timeout into an immediate timeout", async () => {
    const peer = await createTransportPeer({ delayMs: 30 });
    const ws = await connectUpstreamWebSocket(
      peer.url,
      {},
      {},
      AbortSignal.timeout(2000),
      Number.MAX_SAFE_INTEGER,
    );
    ws.destroy();
    await expect.poll(() => peer.sockets.size).toBe(0);
  });
  it.each([
    "http://example.com/",
    "ws://example.com/",
    "ftp://127.0.0.1/",
    "https://user:secret@example.com/",
    "https://example.com/#fragment",
  ])("rejects unsafe URL %s", async (url) => {
    await expect(
      connectUpstreamWebSocket(new URL(url), {}, {}, new AbortController().signal),
    ).rejects.toThrow("Invalid upstream WebSocket URL");
  });
  it("rejects an untrusted TLS peer without disabling certificate checks", async () => {
    const { peer, connect } = await open({ tls: true });
    await expect(connect()).rejects.toThrow("Upstream WebSocket connection failed");
    expect(peer.requests).toHaveLength(0);
    await expect.poll(() => peer.sockets.size).toBe(0);
  });
  it("receives a close in upgrade head and releases abort listener", async () => {
    const { peer, connect, controller } = await open({ head: Buffer.from([0x88, 2, 3, 232]) });
    const ws = await connect();
    expect((await once(ws, "close"))[0]).toBe(1000);
    await expect.poll(() => peer.sockets.size).toBe(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
  it("sanitizes invalid outbound header errors", async () => {
    const peer = await createTransportPeer();
    const error = await connectUpstreamWebSocket(
      peer.url,
      { Authorization: "secret-token\ninvalid" },
      {},
      new AbortController().signal,
    ).catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("secret-token");
    expect(peer.requests).toHaveLength(0);
  });
  it("keeps finite defaults when optional limits are explicitly undefined", async () => {
    const head = Buffer.alloc(10);
    head[0] = 0x81;
    head[1] = 127;
    head.writeBigUInt64BE(1048577n, 2);
    const peer = await createTransportPeer({ head });
    const ws = await connectUpstreamWebSocket(
      peer.url,
      {},
      { maxMessageBytes: undefined },
      new AbortController().signal,
    );
    const closed = once(ws, "close");
    await expect.poll(() => ws.isClosed).toBe(true);
    expect((await closed)[0]).toBe(1009);
  });
  it("validates limits before connecting", async () => {
    const peer = await createTransportPeer();
    await expect(
      connectUpstreamWebSocket(peer.url, {}, { maxMessageBytes: 0 }, new AbortController().signal),
    ).rejects.toThrow("WebSocket limits");
    expect(peer.requests).toHaveLength(0);
  });
});

// Self-signed loopback transport certificate; deliberately untrusted. No provider credentials.
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDUzXUisOEZKcqM
TlaMK+QZkC+IJpqIcVSAA4k6blgubPgI0C2OnbA0Ctv/rEKfMrJasLoR0XBY4iXh
Vm1PDDiXjvN2JVePWjzs/qlRmFdsvhQwCU9lVyCRv/r1HCfc2mF8pdRjVn25gpsa
PfCIi2E27ESKqY6U4YLoXAvEDR3XjO+gDSpX/JzMzAg99brutMMtdLTNk8tTBpAZ
QcECCpkTSQ8uu2HHRv3CqJx0qQdM3nng1XdEMt9lVg/6h+6NaWXtKQiC3fe3njBd
ZxpP50wDkDoRE6AZ1mQQssi1ik1gDLlfsWfSu3qSc8sk25Rk7N31fdqsCVznE3bz
nSyk+Ww7AgMBAAECggEAZyBqc7VkYN1v2y7bonJiyECnyENtAFJrsN4F0ttGwLju
OtcoPMUObyoUE4NXhe77oBelFJ165Jgz41APCQ/THR+ZvNe75yzD+dYwF+rL81bq
UZ0xbNscXYW8CKzsZIswU0fJ9Zoks5InuD/sIT/qjMNTNB+XiW8AEbsJuKjinWI9
MAfo/6hJTwpy4xXM3xeWyCjf4+4aNabmMawRKMAKh62kZss/abE54UkD/WD7m8tU
Tr/OztkfdPNQQupYsDmYCkMXDz0hOPNqjXeRE39teVT4SPH6JrH6sRvSB1kKUenR
KnXcFCOGbxZLtk2rzm4tVUGYp0ot4eQb38R/HYidAQKBgQDvwFw7JmGVDMC5SXib
NtgzXCJmRPxvhhkqBOqLicGpxR8+E/80lUXASlNzeJDIlNZMSYc3EhzdcuhkCamC
sfqe6F5boz1UX6XlK4GIUPALSQk539ZRpuPDEDCabIYbQUjznUC0KeIdwpoyWPty
stWNhgCicsCs0v7tzWEMucwI6QKBgQDjOYpM5FgGJLzAd1IMl3RwF/+S6XY6oCqx
Eb47Gwgqsm8alHuklEXSaDA7oioZWCdCJQHr/alNR4ZDK1WfW92fZQpf3H+eZNRI
m8ME0QynUOIq5bX+rWawMfq9adBWZpDvQKR+cciC9xUXukKlRhCkXZJCFSZ4RG1I
gWlmtI/VgwKBgFbptwXCXjG4U81Xsx8hfLLxvY6xh4muZUT0T0qSf+BZk3/fo+6e
BpE04JfFp0bvndg994ShTlGBLHnHfungN2iP+FTkEoGZwvwXD3gpTzvoGC4g1QL4
qyy1m8j/eoY63oViBmjJni0HtPp3g4ALEJujbmt1ih+cxcnTYFFKsYqxAoGAFSHR
0ereoNujzkaKk+81/gLNWw1pWHRy4/rhdT/DV602lgM/KIQ9ph7YdYNUZP0E0ar9
bcQujahcPTz3fpWdm+hauaWZHNMFxybtUTJb+eeU0SaB8YiQ50wOpLUFkjOBwS6C
3duZKUzvYkCJWDOW8qJdKtYquL6sZzTZ55pdUh8CgYBkMruo6tP4NxULU3MmLYPO
9Hybo9lUFynZkfo+aRtp4sVNYIjuAB5DtEXQbE1+IKU5PYEiv4W/mRaBIA2kqdb/
laS64VRqyUCtGweAiIbT/UBvXI0tcVz/YF9qjY5o4xpMVKUXo+xjAF9o5pIUN7Xn
BKyk8nLl/oYARJjpAN2g9A==
-----END PRIVATE KEY-----
`;
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIICyTCCAbGgAwIBAgIJALHHRUCjGpV/MA0GCSqGSIb3DQEBCwUAMBQxEjAQBgNV
BAMMCWxvY2FsaG9zdDAeFw0yNjA5MTcyMDI0NDdaFw0yNjA5MTkyMDI0NDdaMBQx
EjAQBgNVBAMMCWxvY2FsaG9zdDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoC
ggEBANTNdSKw4RkpyoxOVowr5BmQL4gmmohxVIADiTpuWC5s+AjQLY6dsDQK2/+s
Qp8yslqwuhHRcFjiJeFWbU8MOJeO83YlV49aPOz+qVGYV2y+FDAJT2VXIJG/+vUc
J9zaYXyl1GNWfbmCmxo98IiLYTbsRIqpjpThguhcC8QNHdeM76ANKlf8nMzMCD31
uu60wy10tM2Ty1MGkBlBwQIKmRNJDy67YcdG/cKonHSpB0zeeeDVd0Qy32VWD/qH
7o1pZe0pCILd97eeMF1nGk/nTAOQOhEToBnWZBCyyLWKTWAMuV+xZ9K7epJzyyTb
lGTs3fV92qwJXOcTdvOdLKT5bDsCAwEAAaMeMBwwGgYDVR0RBBMwEYIJbG9jYWxo
b3N0hwR/AAABMA0GCSqGSIb3DQEBCwUAA4IBAQBzyBKgutQ4Gu7YrgE1ddN4rJfV
REMVOVDSrHzCbCVQdYbBgdiehRe0qcm9rUT6q1gxXWAkiaGIH+7abL7UTNrmMehs
9HZTitlYNhcpMSrL/4SWtP2Yt1LOzgcEwr1aJcuVnOQCIjPxpxguQg1LNY4zizlR
7Wwo8rONZkDUBSqyr+i2uFmhHocm7p4IXNqWpobp0cMcktjdv08Fq5UVnoS2jIMd
s3sqoMGSK8y+WA0IYqTIl2jLqwdj1/QkQQIsGz/94PcbQusutiIDWVF8xuIuu87B
0GvmIAkn7CKMjyZbU4ez9CW2tZXixs7ydHodWZ2FAgRywwlHZWqP8j0P8hTA
-----END CERTIFICATE-----
`;
