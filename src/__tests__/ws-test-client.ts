/**
 * Shared WebSocket test client for integration tests.
 *
 * Uses raw net.Socket + manual RFC 6455 framing (no ws library dependency).
 * Performs HTTP upgrade handshake and provides send/receive/close helpers.
 */

import * as net from "node:net";
import { randomBytes } from "node:crypto";

export interface WSTestClient {
  send(data: string): void;
  close(): void;
  waitForMessages(count: number, timeoutMs?: number): Promise<string[]>;
  waitForClose(): Promise<void>;
}

export function connectWebSocket(url: string, path: string): Promise<WSTestClient> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const socket = net.connect(parseInt(parsed.port), parsed.hostname, () => {
      const key = randomBytes(16).toString("base64");
      socket.write(
        `GET ${path} HTTP/1.1\r\n` +
          `Host: ${parsed.host}\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\n` +
          `Sec-WebSocket-Version: 13\r\n` +
          `\r\n`,
      );

      let handshakeDone = false;
      let buffer = Buffer.alloc(0);
      const messages: string[] = [];
      const messageResolvers: Array<() => void> = [];
      const closeResolvers: Array<() => void> = [];

      socket.on("data", (data: Buffer) => {
        buffer = Buffer.concat([buffer, data]);

        if (!handshakeDone) {
          const headerEnd = buffer.indexOf("\r\n\r\n");
          if (headerEnd === -1) return;
          const headerStr = buffer.subarray(0, headerEnd).toString();
          if (!headerStr.includes("101")) {
            reject(new Error(`Upgrade failed: ${headerStr.split("\r\n")[0]}`));
            return;
          }
          handshakeDone = true;
          buffer = buffer.subarray(headerEnd + 4);

          resolve({
            send(data: string) {
              // Send a masked text frame
              const payload = Buffer.from(data, "utf-8");
              const maskKey = randomBytes(4);
              const masked = Buffer.from(payload);
              for (let i = 0; i < masked.length; i++) {
                masked[i] ^= maskKey[i % 4];
              }
              let header: Buffer;
              if (payload.length < 126) {
                header = Buffer.alloc(2);
                header[0] = 0x81; // FIN + TEXT
                header[1] = 0x80 | payload.length;
              } else {
                header = Buffer.alloc(4);
                header[0] = 0x81;
                header[1] = 0x80 | 126;
                header.writeUInt16BE(payload.length, 2);
              }
              socket.write(Buffer.concat([header, maskKey, masked]));
            },
            close() {
              // Send close frame
              const maskKey = randomBytes(4);
              const payload = Buffer.alloc(2);
              payload.writeUInt16BE(1000, 0);
              const masked = Buffer.from(payload);
              for (let i = 0; i < masked.length; i++) {
                masked[i] ^= maskKey[i % 4];
              }
              const header = Buffer.alloc(2);
              header[0] = 0x88; // FIN + CLOSE
              header[1] = 0x82; // MASK + 2 bytes
              socket.write(Buffer.concat([header, maskKey, masked]));
            },
            waitForMessages(count: number, timeoutMs = 5000): Promise<string[]> {
              return new Promise((resolve, reject) => {
                const check = () => {
                  if (messages.length >= count) {
                    resolve(messages.slice(0, count));
                  }
                };
                check();
                messageResolvers.push(check);
                setTimeout(
                  () =>
                    reject(
                      new Error(`Timeout waiting for ${count} messages, got ${messages.length}`),
                    ),
                  timeoutMs,
                );
              });
            },
            waitForClose(): Promise<void> {
              return new Promise((resolve) => {
                if (socket.destroyed) {
                  resolve();
                  return;
                }
                closeResolvers.push(resolve);
              });
            },
          });
        }

        // Parse WebSocket frames from buffer
        while (buffer.length >= 2) {
          const byte0 = buffer[0];
          const byte1 = buffer[1];
          const opcode = byte0 & 0x0f;
          let payloadLength = byte1 & 0x7f;
          let offset = 2;

          if (payloadLength === 126) {
            if (buffer.length < 4) return;
            payloadLength = buffer.readUInt16BE(2);
            offset = 4;
          }

          // Server frames are NOT masked
          if (buffer.length < offset + payloadLength) return;

          const payload = buffer.subarray(offset, offset + payloadLength);
          buffer = buffer.subarray(offset + payloadLength);

          if (opcode === 0x1) {
            // text
            messages.push(payload.toString("utf-8"));
            for (const r of messageResolvers) r();
          } else if (opcode === 0x8) {
            // close
            socket.end();
            for (const r of closeResolvers) r();
          }
        }
      });

      socket.on("close", () => {
        for (const r of closeResolvers) r();
      });

      socket.on("error", reject);
    });
  });
}
