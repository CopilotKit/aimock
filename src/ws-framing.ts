/**
 * Minimal RFC 6455 WebSocket server implementation.
 *
 * Zero dependencies — uses only Node.js builtins (node:crypto, node:events).
 * Supports text frames, ping/pong, close handshake, and client frame unmasking.
 * Designed for a mock server — no extensions, no binary frames, no compression.
 */

import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type * as net from "node:net";
import type * as http from "node:http";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// Opcodes
const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

export interface WebSocketLimits {
  maxMessageBytes?: number;
  maxBufferedBytes?: number;
  maxWriteBytes?: number;
  /** Client role: mask outgoing frames and require unmasked incoming frames. */
  maskOutgoing?: boolean;
}

export class WebSocketConnection extends EventEmitter {
  private socket: net.Socket;
  private buffer: Buffer = Buffer.alloc(0);
  private closed = false;

  // For fragmented messages (continuation frames)
  private fragments: Buffer[] = [];

  private fragmentBytes = 0;
  private fragmented = false;
  private pendingWriteBytes = 0;
  private pendingWrites = new Set<(error: Error) => void>();
  private limits: WebSocketLimits;

  constructor(socket: net.Socket, limits: WebSocketLimits = {}) {
    super();
    for (const value of [limits.maxMessageBytes, limits.maxBufferedBytes, limits.maxWriteBytes]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
        throw new RangeError("WebSocket limits must be positive safe integers");
      }
    }
    this.limits = { ...limits };
    this.socket = socket;

    socket.on("data", (data: Buffer) => {
      // Byte-idle consumers must see partial frames and control traffic too.
      // Emit no payload, and notify before parsing can dispatch a message.
      if (data.length > 0 && !this.closed) this.emit("activity");
      let offset = 0;
      while (offset < data.length && !this.closed) {
        const room =
          (this.limits.maxBufferedBytes ?? Infinity) - this.fragmentBytes - this.buffer.length;
        if (room <= 0) {
          this.close(1009, "WebSocket buffer limit exceeded");
          return;
        }
        const end = offset + Math.min(room, data.length - offset);
        this.buffer = Buffer.concat([this.buffer, data.subarray(offset, end)]);
        offset = end;
        this.parseFrames();
      }
    });

    socket.on("close", () => this.lost());

    // A peer FIN without a close frame is a disconnect. HTTP upgrade sockets
    // allow half-open, so without this the loss surfaces only on a later
    // failed write. Data events precede "end", so frames that arrive just
    // before the FIN still parse, but any turn they start is cancelled at once
    // because the connection is then lost.
    socket.on("end", () => {
      if (this.closed) return;
      this.socket.destroy();
      this.lost();
    });

    socket.on("error", (err: Error) => {
      this.emit("error", err);
    });
  }

  send(data: string): void {
    if (this.closed) return;
    void this.sendAsync(data).catch(() => {
      /* Legacy fire-and-forget API. */
    });
  }

  sendAsync(data: string, signal?: AbortSignal): Promise<void> {
    if (this.closed || this.socket.destroyed) return Promise.reject(new Error("WebSocket closed"));
    if (signal?.aborted) return Promise.reject(new Error("WebSocket send aborted"));
    const length = Buffer.byteLength(data);
    const frameBytes =
      length + (length < 126 ? 2 : length < 65536 ? 4 : 10) + (this.limits.maskOutgoing ? 4 : 0);
    if (
      frameBytes >
      (this.limits.maxWriteBytes ?? Infinity) -
        Math.max(this.pendingWriteBytes, this.socket.writableLength)
    ) {
      this.close(1009, "WebSocket write limit exceeded");
      return Promise.reject(new Error("WebSocket write limit exceeded"));
    }
    this.pendingWriteBytes += frameBytes;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        this.pendingWriteBytes -= frameBytes;
        this.pendingWrites.delete(fail);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
      };
      const fail = (error: Error) => finish(error);
      const abort = () => {
        finish(new Error("WebSocket send aborted"));
        this.destroy();
      };
      this.pendingWrites.add(fail);
      signal?.addEventListener("abort", abort, { once: true });
      try {
        this.socket.write(this.encodeFrame(OP_TEXT, Buffer.from(data)), (error?: Error | null) => {
          if (error) finish(new Error("WebSocket write failed"));
          else finish();
        });
      } catch {
        finish(new Error("WebSocket write failed"));
      }
    });
  }

  /** Mark an unannounced connection loss and emit close once. */
  private lost(): void {
    if (this.closed) return;
    this.closed = true;
    this.release(new Error("WebSocket closed"));
    this.emit("close", 1006, "Connection lost");
  }

  private release(error: Error): void {
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentBytes = 0;
    for (const fail of this.pendingWrites) fail(error);
  }

  close(code = 1000, reason = ""): void {
    if (this.closed) return;
    this.closed = true;
    this.release(new Error("WebSocket closed"));

    const encodedReason = Buffer.from(reason, "utf-8");
    let reasonEnd = Math.min(encodedReason.length, 123);
    // A continuation byte at the cut means its code point straddles the limit.
    while (reasonEnd < encodedReason.length && (encodedReason[reasonEnd] & 0xc0) === 0x80) {
      reasonEnd--;
    }
    const reasonBuf = encodedReason.subarray(0, reasonEnd);
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
    this.release(new Error("WebSocket destroyed"));
    if (!this.socket.destroyed) {
      this.socket.destroy();
    }
    this.emit("close", 1006, "Connection destroyed");
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private encodeFrame(opcode: number, payload: Buffer): Buffer {
    const length = payload.length;
    const headerSize = length < 126 ? 2 : length < 65536 ? 4 : 10;
    const maskSize = this.limits.maskOutgoing ? 4 : 0;
    const frame = Buffer.allocUnsafe(headerSize + maskSize + length);
    frame[0] = 0x80 | opcode;
    frame[1] = (maskSize ? 0x80 : 0) | (length < 126 ? length : length < 65536 ? 126 : 127);
    if (headerSize === 4) frame.writeUInt16BE(length, 2);
    if (headerSize === 10) frame.writeBigUInt64BE(BigInt(length), 2);
    if (maskSize) {
      const mask = randomBytes(4);
      mask.copy(frame, headerSize);
      for (let i = 0; i < length; i++) frame[headerSize + 4 + i] = payload[i] ^ mask[i % 4];
    } else payload.copy(frame, headerSize);
    return frame;
  }

  private writeFrame(opcode: number, payload: Buffer): void {
    if (this.socket.destroyed) return;
    const available =
      (this.limits.maxWriteBytes ?? Infinity) -
      Math.max(this.pendingWriteBytes, this.socket.writableLength);
    const headerBytes = 2 + (this.limits.maskOutgoing ? 4 : 0);
    if (opcode === OP_CLOSE && payload.length + headerBytes > available) {
      // Keep even the final control frame inside the configured socket budget.
      if (available < headerBytes + 2) {
        this.socket.destroy();
        return;
      }
      payload = payload.subarray(0, 2);
    } else if (payload.length + headerBytes > available) {
      this.close(1009, "WebSocket write limit exceeded");
      return;
    }
    const frame = this.encodeFrame(opcode, payload);
    this.socket.write(frame);
  }

  private parseFrames(): void {
    while (this.buffer.length >= 2 && !this.closed) {
      const byte0 = this.buffer[0];
      const byte1 = this.buffer[1];

      const fin = (byte0 & 0x80) !== 0;
      const opcode = byte0 & 0x0f;
      const masked = (byte1 & 0x80) !== 0;
      if (
        byte0 & 0x70 ||
        masked === Boolean(this.limits.maskOutgoing) ||
        ![OP_CONTINUATION, OP_TEXT, 2, OP_CLOSE, OP_PING, OP_PONG].includes(opcode) ||
        (opcode >= 8 && (!fin || (byte1 & 0x7f) > 125)) ||
        (opcode === OP_CONTINUATION && !this.fragmented) ||
        (opcode === OP_TEXT && this.fragmented)
      ) {
        this.close(1002, "Invalid WebSocket frame");
        return;
      }
      let payloadLength = byte1 & 0x7f;
      let offset = 2;

      if (payloadLength === 126) {
        if (this.buffer.length < 4) return; // need more data
        payloadLength = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLength === 127) {
        if (this.buffer.length < 10) return;
        const advertised = this.buffer.readBigUInt64BE(2);
        if (advertised & (1n << 63n)) {
          this.close(1002, "Invalid WebSocket length");
          return;
        }
        if (advertised > BigInt(Number.MAX_SAFE_INTEGER)) {
          this.close(1009, "WebSocket message limit exceeded");
          return;
        }
        payloadLength = Number(advertised);
        offset = 10;
      }

      if (
        ((byte1 & 0x7f) === 126 && payloadLength < 126) ||
        ((byte1 & 0x7f) === 127 && payloadLength < 65536)
      ) {
        this.close(1002, "Invalid WebSocket length");
        return;
      }
      if (
        opcode < 8 &&
        payloadLength > (this.limits.maxMessageBytes ?? Infinity) - this.fragmentBytes
      ) {
        this.close(1009, "WebSocket message limit exceeded");
        return;
      }
      if (
        payloadLength + offset + (masked ? 4 : 0) >
        (this.limits.maxBufferedBytes ?? Infinity) - this.fragmentBytes
      ) {
        this.close(1009, "WebSocket buffer limit exceeded");
        return;
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
      if (payload.length === 1) {
        this.close(1002, "Invalid WebSocket close");
        return;
      }
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      const reason = payload.length > 2 ? payload.subarray(2).toString("utf-8") : "";

      if (!this.closed) {
        this.closed = true;
        this.release(new Error("WebSocket closed"));
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
      this.fragmented = !fin;
      this.fragmentBytes += payload.length;
      if (payload.length) this.fragments.push(payload);

      if (fin) {
        const message = Buffer.concat(this.fragments).toString("utf-8");
        this.fragments = [];
        this.fragmentBytes = 0;
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
  limits?: WebSocketLimits,
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

  return new WebSocketConnection(socket, limits);
}
