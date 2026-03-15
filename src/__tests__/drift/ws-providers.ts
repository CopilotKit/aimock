/**
 * TLS WebSocket client for connecting to real provider WebSocket APIs (wss://).
 *
 * Uses node:tls + manual RFC 6455 framing (similar to ws-test-client.ts but
 * over TLS, with added support for 64-bit payload lengths and ping/pong).
 * Provides protocol-specific functions for OpenAI Responses WS, OpenAI
 * Realtime, and Gemini Live.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import * as tls from "node:tls";
import { randomBytes } from "node:crypto";
import { extractShape, type SSEEventShape } from "./schema.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProviderConfig {
  apiKey: string;
}

interface WSResult {
  events: SSEEventShape[];
  rawMessages: unknown[];
}

interface TLSWSClient {
  send(data: string): void;
  waitUntil(predicate: (msg: unknown) => boolean, timeoutMs?: number): Promise<unknown[]>;
  close(): void;
}

// ---------------------------------------------------------------------------
// Gemini message classifier (re-exported via helpers.ts for drift tests)
// ---------------------------------------------------------------------------

export function classifyGeminiMessage(msg: Record<string, unknown>): string {
  if ("setupComplete" in msg) return "setupComplete";
  if ("serverContent" in msg) return "serverContent";
  if ("toolCall" in msg) return "toolCall";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Masked frame helpers
// ---------------------------------------------------------------------------

function applyMask(payload: Buffer): { maskKey: Buffer; masked: Buffer } {
  const maskKey = randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) {
    masked[i] ^= maskKey[i % 4];
  }
  return { maskKey, masked };
}

function buildMaskedTextFrame(payload: Buffer): Buffer {
  const { maskKey, masked } = applyMask(payload);

  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN + TEXT
    header[1] = 0x80 | payload.length;
  } else if (payload.length <= 65535) {
    header = Buffer.alloc(4);
    header[0] = 0x81; // FIN + TEXT
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; // FIN + TEXT
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, maskKey, masked]);
}

function buildMaskedCloseFrame(): Buffer {
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(1000, 0);
  const { maskKey, masked } = applyMask(payload);
  const header = Buffer.alloc(2);
  header[0] = 0x88; // FIN + CLOSE
  header[1] = 0x82; // MASK + 2 bytes
  return Buffer.concat([header, maskKey, masked]);
}

function buildMaskedPongFrame(pingPayload: Buffer): Buffer {
  const { maskKey, masked } = applyMask(pingPayload);

  let header: Buffer;
  if (pingPayload.length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x8a; // FIN + PONG
    header[1] = 0x80 | pingPayload.length;
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x8a; // FIN + PONG
    header[1] = 0x80 | 126;
    header.writeUInt16BE(pingPayload.length, 2);
  }
  return Buffer.concat([header, maskKey, masked]);
}

// ---------------------------------------------------------------------------
// TLS WebSocket client (RFC 6455 over TLS)
// ---------------------------------------------------------------------------

export function connectTLSWebSocket(
  host: string,
  path: string,
  headers?: Record<string, string>,
): Promise<TLSWSClient> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port: 443, servername: host }, () => {
      const key = randomBytes(16).toString("base64");
      const extraHeaders = headers
        ? Object.entries(headers)
            .map(([k, v]) => `${k}: ${v}\r\n`)
            .join("")
        : "";

      socket.write(
        `GET ${path} HTTP/1.1\r\n` +
          `Host: ${host}\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\n` +
          `Sec-WebSocket-Version: 13\r\n` +
          extraHeaders +
          `\r\n`,
      );

      let handshakeDone = false;
      let buffer = Buffer.alloc(0);
      const messages: unknown[] = [];
      const messageResolvers: Array<() => void> = [];
      let socketError: Error | null = null;
      // Connection-scoped cursor so successive waitUntil calls resume where the last left off
      let checkedUpTo = 0;

      socket.on("data", (data: Buffer) => {
        buffer = Buffer.concat([buffer, data]);

        if (!handshakeDone) {
          const headerEnd = buffer.indexOf("\r\n\r\n");
          if (headerEnd === -1) return;
          const headerStr = buffer.subarray(0, headerEnd).toString();
          if (!headerStr.includes("101")) {
            reject(new Error(`WebSocket upgrade failed: ${headerStr.split("\r\n")[0]}`));
            return;
          }
          handshakeDone = true;
          buffer = buffer.subarray(headerEnd + 4);

          // Replace handshake error handler with post-handshake handler
          socket.removeListener("error", reject);
          socket.on("error", (err: Error) => {
            socketError = err;
            // Wake up any pending waitUntil resolvers so they can check the error
            for (const r of messageResolvers) r();
          });

          resolve({
            send(data: string) {
              socket.write(buildMaskedTextFrame(Buffer.from(data, "utf-8")));
            },

            waitUntil(predicate: (msg: unknown) => boolean, timeoutMs = 30000): Promise<unknown[]> {
              return new Promise((resolve, reject) => {
                const collected: unknown[] = [];
                let settled = false;

                const scanFromCursor = () => {
                  while (checkedUpTo < messages.length) {
                    const msg = messages[checkedUpTo];
                    checkedUpTo++;
                    collected.push(msg);
                    if (predicate(msg)) return true;
                  }
                  return false;
                };

                // Check messages that arrived before waitUntil was called
                if (scanFromCursor()) {
                  resolve(collected);
                  return;
                }

                const removeResolver = () => {
                  const idx = messageResolvers.indexOf(check);
                  if (idx !== -1) messageResolvers.splice(idx, 1);
                };

                const timer = setTimeout(() => {
                  if (!settled) {
                    settled = true;
                    removeResolver();
                    const types = collected.map((m: any) => m?.type ?? "unknown").join(", ");
                    reject(
                      new Error(
                        `waitUntil timeout after ${timeoutMs}ms. ` +
                          `Collected ${collected.length} messages: [${types}]`,
                      ),
                    );
                  }
                }, timeoutMs);

                const check = () => {
                  if (settled) return;
                  // Check for socket error
                  if (socketError) {
                    settled = true;
                    clearTimeout(timer);
                    removeResolver();
                    reject(
                      new Error(
                        `WebSocket error during waitUntil: ${socketError.message}. ` +
                          `Collected ${collected.length} messages.`,
                      ),
                    );
                    return;
                  }
                  // Scan all new messages since last check
                  if (scanFromCursor()) {
                    settled = true;
                    clearTimeout(timer);
                    removeResolver();
                    resolve(collected);
                  }
                };

                messageResolvers.push(check);
              });
            },

            close() {
              socket.write(buildMaskedCloseFrame());
              // Ensure socket is destroyed even if server doesn't respond
              setTimeout(() => {
                if (!socket.destroyed) socket.destroy();
              }, 3000);
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
          } else if (payloadLength === 127) {
            if (buffer.length < 10) return;
            payloadLength = Number(buffer.readBigUInt64BE(2));
            offset = 10;
          }

          // Server frames are NOT masked
          if (buffer.length < offset + payloadLength) return;

          const framePayload = buffer.subarray(offset, offset + payloadLength);
          buffer = buffer.subarray(offset + payloadLength);

          if (opcode === 0x1) {
            // text frame
            const text = framePayload.toString("utf-8");
            try {
              const parsed = JSON.parse(text);
              messages.push(parsed);
            } catch {
              messages.push(text);
            }
            for (const r of messageResolvers) r();
          } else if (opcode === 0x8) {
            // close frame
            socket.end();
          } else if (opcode === 0x9) {
            // ping — respond with pong per RFC 6455
            socket.write(buildMaskedPongFrame(framePayload));
          }
        }
      });

      socket.on("error", reject);
    });
  });
}

// ---------------------------------------------------------------------------
// OpenAI Responses WebSocket
// ---------------------------------------------------------------------------

export async function openaiResponsesWS(
  config: ProviderConfig,
  input: object[],
  tools?: object[],
): Promise<WSResult> {
  const ws = await connectTLSWebSocket("api.openai.com", "/v1/responses", {
    Authorization: `Bearer ${config.apiKey}`,
  });

  // Real Responses WS API uses flat format: model/input/tools at the top level
  // of the response.create message (not nested inside a "response" object)
  const msg: Record<string, unknown> = {
    type: "response.create",
    model: "gpt-4o-mini",
    input,
    max_output_tokens: 50,
  };
  if (tools) msg.tools = tools;

  ws.send(JSON.stringify(msg));

  // Terminal event: "response.completed" or "response.done" (both observed in the wild)
  const rawMessages = await ws.waitUntil(
    (msg: any) => msg?.type === "response.completed" || msg?.type === "response.done",
  );

  ws.close();

  const events: SSEEventShape[] = rawMessages.map((msg: any) => ({
    type: msg.type ?? "unknown",
    dataShape: extractShape(msg),
  }));

  return { events, rawMessages };
}

// ---------------------------------------------------------------------------
// OpenAI Realtime WebSocket
// ---------------------------------------------------------------------------

export async function openaiRealtimeWS(
  config: ProviderConfig,
  text: string,
  tools?: object[],
): Promise<WSResult> {
  // Realtime API requires a realtime-specific model (gpt-4o-mini doesn't work)
  const ws = await connectTLSWebSocket(
    "api.openai.com",
    "/v1/realtime?model=gpt-4o-mini-realtime-preview",
    {
      Authorization: `Bearer ${config.apiKey}`,
      "OpenAI-Beta": "realtime=v1",
    },
  );

  // Step 1: Wait for session.created
  const sessionCreated = await ws.waitUntil((msg: any) => msg?.type === "session.created");

  // Step 2: Send session.update
  const session: Record<string, unknown> = {
    model: "gpt-4o-mini-realtime-preview",
    modalities: ["text"],
  };
  if (tools) session.tools = tools;
  ws.send(JSON.stringify({ type: "session.update", session }));

  // Step 3: Wait for session.updated
  const sessionUpdated = await ws.waitUntil((msg: any) => msg?.type === "session.updated");

  // Step 4: Send conversation.item.create
  ws.send(
    JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    }),
  );

  // Step 5: Wait for conversation.item.created
  const itemCreated = await ws.waitUntil((msg: any) => msg?.type === "conversation.item.created");

  // Step 6: Send response.create
  ws.send(JSON.stringify({ type: "response.create" }));

  // Step 7: Collect until response.done
  const responseMessages = await ws.waitUntil((msg: any) => msg?.type === "response.done");

  ws.close();

  // Combine all step results (each waitUntil returns only new messages since prior call)
  const allMessages = [...sessionCreated, ...sessionUpdated, ...itemCreated, ...responseMessages];

  const events: SSEEventShape[] = allMessages.map((msg: any) => ({
    type: msg.type ?? "unknown",
    dataShape: extractShape(msg),
  }));

  return { events, rawMessages: allMessages };
}

// ---------------------------------------------------------------------------
// Gemini Live WebSocket
// ---------------------------------------------------------------------------

export async function geminiLiveWS(
  config: ProviderConfig,
  text: string,
  tools?: object[],
): Promise<WSResult> {
  const path = `/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${config.apiKey}`;

  const ws = await connectTLSWebSocket("generativelanguage.googleapis.com", path);

  // Step 1: Send setup
  const setup: Record<string, unknown> = {
    model: "models/gemini-2.5-flash",
    generationConfig: { responseModalities: ["TEXT"] },
  };
  if (tools) setup.tools = tools;
  ws.send(JSON.stringify({ setup }));

  // Step 2: Wait for setupComplete
  const setupComplete = await ws.waitUntil(
    (msg: any) => msg && typeof msg === "object" && "setupComplete" in msg,
  );

  // Step 3: Send client content
  ws.send(
    JSON.stringify({
      clientContent: {
        turns: [{ role: "user", parts: [{ text }] }],
        turnComplete: true,
      },
    }),
  );

  // Step 4: Collect until turnComplete or toolCall
  const responseMessages = await ws.waitUntil((msg: any) => {
    if (!msg || typeof msg !== "object") return false;
    if ("toolCall" in msg) return true;
    if ("serverContent" in msg) {
      return (msg as any).serverContent?.turnComplete === true;
    }
    return false;
  });

  ws.close();

  const allMessages = [...setupComplete, ...responseMessages];

  const events: SSEEventShape[] = allMessages.map((msg: any) => ({
    type: classifyGeminiMessage(msg as Record<string, unknown>),
    dataShape: extractShape(msg),
  }));

  return { events, rawMessages: allMessages };
}
