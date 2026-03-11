import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import { randomBytes } from "node:crypto";
import { computeAcceptKey, upgradeToWebSocket, WebSocketConnection } from "../ws-framing.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMaskedFrame(opcode: number, payload: Buffer): Buffer {
  const maskKey = randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) {
    masked[i] ^= maskKey[i % 4];
  }

  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | payload.length;
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  }

  return Buffer.concat([header, maskKey, masked]);
}

const OP_TEXT = 0x1;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

const WS_KEY = "dGhlIHNhbXBsZSBub25jZQ==";
// SHA-1(WS_KEY + "258EAFA5-E914-47DA-95CA-5AB5DC799C07") base64-encoded
const EXPECTED_ACCEPT = "k3rW47NEHk9UnXjYhTD7VfXrYRQ=";

/**
 * Spin up an HTTP server that upgrades to WebSocket via upgradeToWebSocket().
 * Returns the server, its port, and a promise that resolves to the
 * server-side WebSocketConnection once a client connects.
 */
function createTestServer(): {
  server: http.Server;
  port: () => number;
  wsPromise: Promise<WebSocketConnection>;
} {
  let resolveWs: (ws: WebSocketConnection) => void;
  const wsPromise = new Promise<WebSocketConnection>((resolve) => {
    resolveWs = resolve;
  });

  const server = http.createServer();
  // Suppress ECONNRESET on any server connection during teardown
  server.on("connection", (socket) => {
    socket.on("error", () => {});
  });
  server.on("upgrade", (req, socket) => {
    socket.on("error", () => {});
    const ws = upgradeToWebSocket(req, socket as net.Socket);
    resolveWs(ws);
  });

  server.listen(0); // random available port

  return {
    server,
    port: () => (server.address() as net.AddressInfo).port,
    wsPromise,
  };
}

/**
 * Open a raw TCP connection to the test server and send an HTTP upgrade
 * request.  Returns the socket and a promise that resolves with the full
 * HTTP 101 response line + headers once the blank line is received.
 */
function rawConnect(
  port: number,
  headers?: Record<string, string>,
): { socket: net.Socket; response: Promise<string> } {
  const socket = net.connect({ port, host: "127.0.0.1" });
  // Suppress ECONNRESET during teardown — the server may destroy the socket
  socket.on("error", () => {});

  const mergedHeaders: Record<string, string> = {
    Host: "localhost",
    Upgrade: "websocket",
    Connection: "Upgrade",
    "Sec-WebSocket-Version": "13",
    "Sec-WebSocket-Key": WS_KEY,
    ...headers,
  };

  const lines = [`GET / HTTP/1.1`];
  for (const [k, v] of Object.entries(mergedHeaders)) {
    lines.push(`${k}: ${v}`);
  }
  lines.push("", ""); // blank line terminates request

  socket.write(lines.join("\r\n"));

  const response = new Promise<string>((resolve) => {
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      if (buf.includes("\r\n\r\n")) {
        socket.removeListener("data", onData);
        resolve(buf.slice(0, buf.indexOf("\r\n\r\n") + 4));
      }
    };
    socket.on("data", onData);
  });

  return { socket, response };
}

/**
 * Read a complete unmasked server frame from the socket.
 * Returns { opcode, payload }.
 */
function readServerFrame(socket: net.Socket): Promise<{ opcode: number; payload: Buffer }> {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);

    const tryParse = () => {
      if (buf.length < 2) return false;

      const opcode = buf[0] & 0x0f;
      let payloadLength = buf[1] & 0x7f;
      let offset = 2;

      if (payloadLength === 126) {
        if (buf.length < 4) return false;
        payloadLength = buf.readUInt16BE(2);
        offset = 4;
      } else if (payloadLength === 127) {
        if (buf.length < 10) return false;
        payloadLength = buf.readUInt32BE(6);
        offset = 10;
      }

      if (buf.length < offset + payloadLength) return false;

      const payload = buf.subarray(offset, offset + payloadLength);
      resolve({ opcode, payload: Buffer.from(payload) });
      return true;
    };

    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (tryParse()) {
        socket.removeListener("data", onData);
      }
    };
    socket.on("data", onData);

    // In case data is already buffered
    tryParse();
  });
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

const cleanupFns: (() => void)[] = [];

function trackCleanup(server: http.Server, ...sockets: net.Socket[]) {
  cleanupFns.push(() => {
    for (const s of sockets) {
      if (!s.destroyed) s.destroy();
    }
    server.close();
  });
}

afterEach(() => {
  for (const fn of cleanupFns) fn();
  cleanupFns.length = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("computeAcceptKey", () => {
  it("produces the RFC 6455 test vector", () => {
    expect(computeAcceptKey(WS_KEY)).toBe(EXPECTED_ACCEPT);
  });
});

describe("WebSocket handshake", () => {
  it("responds with HTTP 101 Switching Protocols", async () => {
    const { server, port, wsPromise } = createTestServer();
    const { socket, response } = rawConnect(port());
    trackCleanup(server, socket);

    const resp = await response;
    await wsPromise;

    expect(resp).toContain("HTTP/1.1 101 Switching Protocols");
  });

  it("includes correct Sec-WebSocket-Accept header", async () => {
    const { server, port, wsPromise } = createTestServer();
    const { socket, response } = rawConnect(port());
    trackCleanup(server, socket);

    const resp = await response;
    await wsPromise;

    expect(resp).toContain(`Sec-WebSocket-Accept: ${EXPECTED_ACCEPT}`);
  });

  it("echoes back Sec-WebSocket-Protocol when offered", async () => {
    const { server, port, wsPromise } = createTestServer();
    const { socket, response } = rawConnect(port(), {
      "Sec-WebSocket-Protocol": "graphql-ws, graphql-transport-ws",
    });
    trackCleanup(server, socket);

    const resp = await response;
    await wsPromise;

    expect(resp).toContain("Sec-WebSocket-Protocol: graphql-ws");
  });

  it("does not include Sec-WebSocket-Protocol when not offered", async () => {
    const { server, port, wsPromise } = createTestServer();
    const { socket, response } = rawConnect(port());
    trackCleanup(server, socket);

    const resp = await response;
    await wsPromise;

    expect(resp).not.toContain("Sec-WebSocket-Protocol:");
  });
});

describe("frame parsing", () => {
  it("parses a small text frame (<126 bytes)", async () => {
    const { server, port, wsPromise } = createTestServer();
    const { socket, response } = rawConnect(port());
    trackCleanup(server, socket);

    await response;
    const ws = await wsPromise;

    const received = new Promise<string>((resolve) => {
      ws.on("message", resolve);
    });

    const payload = Buffer.from("hello");
    socket.write(createMaskedFrame(OP_TEXT, payload));

    const msg = await received;
    expect(msg).toBe("hello");
  });

  it("parses a medium text frame (126-65535 bytes, extended 16-bit length)", async () => {
    const { server, port, wsPromise } = createTestServer();
    const { socket, response } = rawConnect(port());
    trackCleanup(server, socket);

    await response;
    const ws = await wsPromise;

    const received = new Promise<string>((resolve) => {
      ws.on("message", resolve);
    });

    // Create a payload of exactly 300 bytes
    const text = "A".repeat(300);
    const payload = Buffer.from(text);
    socket.write(createMaskedFrame(OP_TEXT, payload));

    const msg = await received;
    expect(msg).toBe(text);
    expect(msg.length).toBe(300);
  });

  it("responds to ping with pong", async () => {
    const { server, port, wsPromise } = createTestServer();
    const { socket, response } = rawConnect(port());
    trackCleanup(server, socket);

    await response;
    await wsPromise;

    const frameProm = readServerFrame(socket);

    const pingPayload = Buffer.from("ping-data");
    socket.write(createMaskedFrame(OP_PING, pingPayload));

    const frame = await frameProm;
    expect(frame.opcode).toBe(OP_PONG);
    expect(frame.payload.toString()).toBe("ping-data");
  });

  it("echoes close frame back to client", async () => {
    const { server, port, wsPromise } = createTestServer();
    const { socket, response } = rawConnect(port());
    trackCleanup(server, socket);

    await response;
    const ws = await wsPromise;
    ws.on("error", () => {});

    const frameProm = readServerFrame(socket);

    // Build a close frame with code 1000 and reason "bye"
    const reason = Buffer.from("bye");
    const closePayload = Buffer.alloc(2 + reason.length);
    closePayload.writeUInt16BE(1000, 0);
    reason.copy(closePayload, 2);

    socket.write(createMaskedFrame(OP_CLOSE, closePayload));

    const frame = await frameProm;
    expect(frame.opcode).toBe(OP_CLOSE);
    // Close frame should contain code 1000
    expect(frame.payload.readUInt16BE(0)).toBe(1000);
    expect(frame.payload.subarray(2).toString()).toBe("bye");
  });
});

describe("server-side frame sending", () => {
  it("sends an unmasked text frame that the client can read", async () => {
    const { server, port, wsPromise } = createTestServer();
    const { socket, response } = rawConnect(port());
    trackCleanup(server, socket);

    await response;
    const ws = await wsPromise;

    const frameProm = readServerFrame(socket);

    ws.send("hello from server");

    const frame = await frameProm;
    expect(frame.opcode).toBe(OP_TEXT);
    expect(frame.payload.toString()).toBe("hello from server");
  });

  it("sends frames with extended 16-bit length for payloads >= 126 bytes", async () => {
    const { server, port, wsPromise } = createTestServer();
    const { socket, response } = rawConnect(port());
    trackCleanup(server, socket);

    await response;
    const ws = await wsPromise;

    const frameProm = readServerFrame(socket);

    const text = "B".repeat(200);
    ws.send(text);

    const frame = await frameProm;
    expect(frame.opcode).toBe(OP_TEXT);
    expect(frame.payload.toString()).toBe(text);
  });
});

describe("connection lifecycle", () => {
  it("emits close event when client sends close frame", async () => {
    const { server, port, wsPromise } = createTestServer();
    const { socket, response } = rawConnect(port());
    trackCleanup(server, socket);

    await response;
    const ws = await wsPromise;
    ws.on("error", () => {});

    const closeEvent = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.on("close", (code: number, reason: string) => {
        resolve({ code, reason });
      });
    });

    const closePayload = Buffer.alloc(2);
    closePayload.writeUInt16BE(1000, 0);
    socket.write(createMaskedFrame(OP_CLOSE, closePayload));

    const { code, reason } = await closeEvent;
    expect(code).toBe(1000);
    expect(reason).toBe("");
    expect(ws.isClosed).toBe(true);
  });

  it("server close sends close frame and marks connection closed", async () => {
    const { server, port, wsPromise } = createTestServer();
    const { socket, response } = rawConnect(port());
    trackCleanup(server, socket);

    await response;
    const ws = await wsPromise;
    // Suppress errors from the WS connection during socket teardown
    ws.on("error", () => {});

    const frameProm = readServerFrame(socket);

    ws.close(1001, "going away");

    const frame = await frameProm;
    expect(frame.opcode).toBe(OP_CLOSE);
    expect(frame.payload.readUInt16BE(0)).toBe(1001);
    expect(frame.payload.subarray(2).toString()).toBe("going away");
    expect(ws.isClosed).toBe(true);

    // Destroy the client socket before the server's 100ms destroy timeout
    // fires, avoiding ECONNRESET on the server side.
    socket.destroy();
    await new Promise((r) => setTimeout(r, 150));
  });

  it("send() is a no-op after close", async () => {
    const { server, port, wsPromise } = createTestServer();
    const { socket, response } = rawConnect(port());
    trackCleanup(server, socket);

    await response;
    const ws = await wsPromise;
    ws.on("error", () => {});

    ws.close();
    // Should not throw
    ws.send("this should be ignored");
    expect(ws.isClosed).toBe(true);

    socket.destroy();
    await new Promise((r) => setTimeout(r, 150));
  });
});
