/**
 * Minimal RFC 6455 WebSocket server implementation.
 *
 * Zero dependencies — uses only Node.js builtins (node:crypto, node:events).
 * Supports text frames, ping/pong, close handshake, and client frame unmasking.
 * Designed for a mock server — no extensions, no binary frames, no compression.
 */

import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type * as net from "node:net";
import type * as http from "node:http";

const WS_GUID = "258EAFA5-E914-47DA-95CA-5AB5DC799C07";

// Opcodes
const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

export class WebSocketConnection extends EventEmitter {
  private socket: net.Socket;
  private buffer: Buffer = Buffer.alloc(0);
  private closed = false;

  // For fragmented messages (continuation frames)
  private fragments: Buffer[] = [];

  constructor(socket: net.Socket) {
    super();
    this.socket = socket;

    socket.on("data", (data: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, data]);
      this.parseFrames();
    });

    socket.on("close", () => {
      if (!this.closed) {
        this.closed = true;
        this.emit("close", 1006, "Connection lost");
      }
    });

    socket.on("error", (err: Error) => {
      this.emit("error", err);
    });
  }

  send(data: string): void {
    if (this.closed) return;
    const payload = Buffer.from(data, "utf-8");
    this.writeFrame(OP_TEXT, payload);
  }

  close(code = 1000, reason = ""): void {
    if (this.closed) return;
    this.closed = true;

    const reasonBuf = Buffer.from(reason, "utf-8");
    const payload = Buffer.alloc(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    this.writeFrame(OP_CLOSE, payload);

    // Give the client a moment to receive the close frame before destroying.
    // If writeFrame failed (socket already destroyed), this is a no-op.
    setTimeout(() => {
      if (!this.socket.destroyed) {
        this.socket.destroy();
      }
      // Emit close event for server-initiated closes so listeners
      // (e.g. activeConnections.delete) always fire.
      this.emit("close", code, reason);
    }, 100);
  }

  destroy(): void {
    if (this.closed) return;
    this.closed = true;
    if (!this.socket.destroyed) {
      this.socket.destroy();
    }
    this.emit("close", 1006, "Connection destroyed");
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private writeFrame(opcode: number, payload: Buffer): void {
    if (this.socket.destroyed) return;

    // Server-to-client frames are NOT masked (per RFC 6455 §5.1)
    const length = payload.length;
    let header: Buffer;

    if (length < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode; // FIN + opcode
      header[1] = length;
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(length, 6);
    }

    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch (err: unknown) {
      // Expected when socket is destroyed between our check and write.
      // Log unexpected errors so they don't vanish silently.
      if (!this.socket.destroyed) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[LLMock] Unexpected writeFrame error: ${msg}`);
      }
    }
  }

  private parseFrames(): void {
    while (this.buffer.length >= 2 && !this.closed) {
      const byte0 = this.buffer[0];
      const byte1 = this.buffer[1];

      const fin = (byte0 & 0x80) !== 0;
      const opcode = byte0 & 0x0f;
      const masked = (byte1 & 0x80) !== 0;
      let payloadLength = byte1 & 0x7f;
      let offset = 2;

      if (payloadLength === 126) {
        if (this.buffer.length < 4) return; // need more data
        payloadLength = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLength === 127) {
        if (this.buffer.length < 10) return;
        // Read lower 32 bits (upper 32 should be 0 for reasonable payloads)
        payloadLength = this.buffer.readUInt32BE(6) + this.buffer.readUInt32BE(2) * 0x100000000;
        offset = 10;
      }

      const maskSize = masked ? 4 : 0;
      const totalFrameSize = offset + maskSize + payloadLength;

      if (this.buffer.length < totalFrameSize) return; // need more data

      let maskKey: Buffer | null = null;
      if (masked) {
        maskKey = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }

      let payload = this.buffer.subarray(offset, offset + payloadLength);

      // Unmask client payload
      if (maskKey) {
        payload = Buffer.from(payload); // copy before mutating
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= maskKey[i % 4];
        }
      }

      // Consume the frame from the buffer
      this.buffer = this.buffer.subarray(totalFrameSize);

      this.handleFrame(fin, opcode, payload);
    }
  }

  private handleFrame(fin: boolean, opcode: number, payload: Buffer): void {
    // Control frames (opcode >= 0x8) must not be fragmented
    if (opcode === OP_PING) {
      this.writeFrame(OP_PONG, payload);
      return;
    }

    if (opcode === OP_PONG) {
      // Ignore unsolicited pongs
      return;
    }

    if (opcode === OP_CLOSE) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      const reason = payload.length > 2 ? payload.subarray(2).toString("utf-8") : "";

      if (!this.closed) {
        this.closed = true;
        // Echo close frame back
        this.writeFrame(OP_CLOSE, payload);
        this.socket.end();
        this.emit("close", code, reason);
      }
      // If already closed (server-initiated or duplicate), ignore — the
      // close event was already emitted by close() or the first OP_CLOSE.
      return;
    }

    // Text or continuation frames
    if (opcode === OP_TEXT || opcode === OP_CONTINUATION) {
      this.fragments.push(payload);

      if (fin) {
        const message = Buffer.concat(this.fragments).toString("utf-8");
        this.fragments = [];
        this.emit("message", message);
      }
      // If !fin, wait for more continuation frames
      return;
    }

    // Binary or unknown — just ignore for a mock server
  }
}

export function computeAcceptKey(wsKey: string): string {
  return createHash("sha1")
    .update(wsKey + WS_GUID)
    .digest("base64");
}

export function upgradeToWebSocket(
  req: http.IncomingMessage,
  socket: net.Socket,
): WebSocketConnection {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    throw new Error("Missing Sec-WebSocket-Key header");
  }

  const acceptKey = computeAcceptKey(key);

  let responseHeaders =
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${acceptKey}\r\n`;

  // Echo back requested subprotocol if present
  const protocol = req.headers["sec-websocket-protocol"];
  if (protocol) {
    // Take the first offered protocol
    const first = protocol.split(",")[0].trim();
    responseHeaders += `Sec-WebSocket-Protocol: ${first}\r\n`;
  }

  responseHeaders += "\r\n";

  socket.write(responseHeaders);

  return new WebSocketConnection(socket);
}
