import { randomBytes } from "node:crypto";
import { vi } from "vitest";
import { WebSocketConnection } from "../../ws-framing.js";

/**
 * An unmasked client text frame. aimock rejects it with its own
 * `close(1002, "Invalid WebSocket frame")`, which marks the socket closed at
 * once and emits `close` about 100ms later: the window these tests probe.
 */
export const BAD_FRAME = Buffer.from([0x81, 0x00]);

/** A masked client frame, so several frames can go out in one TCP write. */
export function maskedFrame(opcode: number, payload: Buffer): Buffer {
  const maskKey = randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= maskKey[i % 4];
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  }
  return Buffer.concat([header, maskKey, masked]);
}

/** A masked text frame. */
export function textFrame(data: string): Buffer {
  return maskedFrame(0x1, Buffer.from(data, "utf-8"));
}

/** A masked close frame with code 1000. */
export function closeFrame(): Buffer {
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(1000, 0);
  return maskedFrame(0x8, payload);
}

/**
 * Make the first server send whose payload matches `matches` behave as a send
 * over aimock's write limit does: aimock closes the socket with
 * `close(1009, …)` and the frame is not written. Every other send is real.
 * Returns the payloads that were really sent. Undo with `vi.restoreAllMocks()`.
 */
export function closeOnSend(matches: (data: string) => boolean): string[] {
  const sent: string[] = [];
  const realSend = WebSocketConnection.prototype.send;
  let fired = false;
  vi.spyOn(WebSocketConnection.prototype, "send").mockImplementation(function (
    this: WebSocketConnection,
    data: string,
  ) {
    if (!fired && !this.isClosed && matches(data)) {
      fired = true;
      this.close(1009, "WebSocket write limit exceeded");
      return;
    }
    if (!this.isClosed) sent.push(data);
    realSend.call(this, data);
  });
  return sent;
}
