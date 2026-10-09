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
import type { RealtimeResponseCreateParams } from "openai-current-sdk/resources/realtime/realtime";
import type { ResponseCreateParamsBase } from "openai/resources/responses/responses";
import { extractShape, type SSEEventShape } from "./schema.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProviderConfig {
  apiKey: string;
}

export interface WSResult {
  events: SSEEventShape[];
  rawMessages: unknown[];
}

interface TLSWSClient {
  send(data: string): void;
  /**
   * `step` names the protocol step being awaited (e.g. `"setupComplete"`), and
   * is carried into the failure text. Without it, every stage of a multi-step
   * handshake fails with the same sentence, so a probe that never got past
   * setup and one whose turn produced nothing are indistinguishable in CI.
   */
  waitUntil(
    predicate: (msg: unknown) => boolean,
    timeoutMs?: number,
    step?: string,
  ): Promise<unknown[]>;
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
// Self-healing WS classification (shared by the WS live-leg retrofits)
// ---------------------------------------------------------------------------
//
// Generalizes the HTTP self-healing patterns (providers.ts `resolveLiveModel` /
// `isInfraSkip` / `isModelNotFound`) to the WS surface, which has TWO distinct
// failure channels a plain HTTP probe doesn't:
//   1. Handshake-level: the upgrade request itself gets a non-101 HTTP
//      response (auth/rate-limit/5xx) — surfaced as {@link WSHandshakeError}
//      with the parsed status so callers can classify it with
//      `isInfraSkip(status)` exactly like an HTTP leg.
//   2. Message-level: the socket upgrades fine but a request-level problem
//      (e.g. a retired/invalid model id) is reported IN-BAND as a
//      `{"type":"error",...}` protocol frame, since the Responses WS protocol
//      validates the model per-message rather than via a connect-time query
//      param (unlike Realtime's `?model=`). {@link extractWSErrorBody} surfaces
//      that frame's body so callers can classify it with
//      `isModelNotFound(400, body)`.

/**
 * Raised by {@link connectTLSWebSocket} when the WS upgrade handshake itself
 * fails (a non-101 HTTP response). Carries the parsed numeric status (0 when
 * unparseable) so callers can classify an auth/rate-limit/5xx condition as an
 * honest skip via `isInfraSkip(status)` — the same classification an HTTP leg
 * gets from a non-2xx response, just surfaced through a different channel.
 */
export class WSHandshakeError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "WSHandshakeError";
    this.status = status;
  }
}

/**
 * Raised by a pending {@link TLSWSClient.waitUntil} when the server closed the
 * WebSocket before the awaited message arrived.
 *
 * This is the third failure channel, alongside the two above: the socket
 * upgrades fine and the provider then REFUSES the session out-of-band, by
 * sending an RFC 6455 CLOSE frame rather than an in-band error frame. The
 * frame's status code and reason are the whole diagnosis — without them a
 * refusal is byte-for-byte indistinguishable from a provider that accepted the
 * socket and said nothing, since both end as a bare `waitUntil` timeout that
 * collected zero messages.
 */
export class WSClosedError extends Error {
  readonly code: number;
  readonly reason: string;

  constructor(message: string, code: number, reason: string) {
    super(message);
    this.name = "WSClosedError";
    this.code = code;
    this.reason = reason;
  }
}

/**
 * Parse an RFC 6455 CLOSE frame payload into its status code and reason.
 *
 * Per §5.5.1 the payload is optional, and a code is 2 bytes — so an absent or
 * 1-byte payload carries no code, which §7.4.1 represents as 1005 ("no status
 * received"). The reason is the UTF-8 remainder, and is where a provider
 * usually names the cause (e.g. an unsupported model).
 */
export function parseCloseFrame(payload: Buffer): { code: number; reason: string } {
  const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
  const reason = payload.length > 2 ? payload.subarray(2).toString("utf-8") : "";
  return { code, reason };
}

/**
 * Per-opcode count of the RFC 6455 frames a connection has received.
 *
 * The point is that NOTHING the transport is handed can be invisible. A
 * zero-message failure used to be a single, ambiguous sentence — "Collected 0
 * messages" — that a mute provider and a provider whose frames this client
 * could not decode produced identically. With the tally attached, `text=0
 * binary=0 unhandled=0` says the surface really sent nothing, while any nonzero
 * count says bytes arrived and the fault is on this side of the wire.
 */
export interface WSFrameTally {
  /** Data frames with opcode 0x1. */
  text: number;
  /** Data frames with opcode 0x2 — read exactly like text (both carry JSON). */
  binary: number;
  /** Continuation frames (opcode 0x0) folded into a fragmented message. */
  continuation: number;
  /** Control frames: ping (0x9), pong (0xA), close (0x8). */
  ping: number;
  pong: number;
  close: number;
  /**
   * Frames whose opcode this client does not implement. Counted rather than
   * dropped: an unhandled frame is the one thing that must never be silent,
   * because silence is what it would otherwise be mistaken for.
   */
  unhandled: number;
}

function emptyFrameTally(): WSFrameTally {
  return { text: 0, binary: 0, continuation: 0, ping: 0, pong: 0, close: 0, unhandled: 0 };
}

/**
 * Render a connection's frame tally, plus the protocol step that was waiting,
 * for a failure message. Appended AFTER {@link describeCollected} so the
 * collector's `waitUntil timeout after <n>ms. Collected <n> messages:`
 * recognizer keeps matching an uninterrupted prefix.
 */
export function describeTransport(tally: WSFrameTally, step?: string): string {
  return (
    `Transport: ${step ? `step=${step} ` : ""}frames text=${tally.text} ` +
    `binary=${tally.binary} continuation=${tally.continuation} ping=${tally.ping} ` +
    `pong=${tally.pong} close=${tally.close} unhandled=${tally.unhandled}.`
  );
}

/**
 * Render the messages a `waitUntil` had collected, for a failure message.
 * Shared by the timeout and server-close paths so both report the same
 * evidence: the bare type list plus (truncated) bodies, since an early `error`
 * event's code/message is otherwise swallowed behind the type list.
 */
function describeCollected(collected: unknown[]): string {
  const types = collected.map((m) => (m as { type?: string } | null)?.type ?? "unknown").join(", ");
  let bodies = "";
  try {
    bodies = ` bodies=${JSON.stringify(collected).slice(0, 800)}`;
  } catch {
    /* non-serializable payload; type list is enough */
  }
  return `Collected ${collected.length} messages: [${types}]${bodies}`;
}

/**
 * Extract the numeric HTTP status code from a WS handshake's status line
 * (e.g. `"HTTP/1.1 401 Unauthorized"` -> `401`). Returns `null` when no
 * 3-digit code is present (a malformed/unexpected response).
 */
export function parseHandshakeStatus(statusLine: string): number | null {
  const match = statusLine.match(/^HTTP\/\d\.\d\s+(\d{3})/);
  return match ? Number(match[1]) : null;
}

/**
 * True when a raw WS protocol message is a request-level error frame
 * (`{"type":"error",...}`) rather than a successful completion event.
 */
export function isResponsesWSError(msg: unknown): boolean {
  return !!msg && typeof msg === "object" && (msg as Record<string, unknown>).type === "error";
}

/**
 * Terminal predicate for the OpenAI Responses WS protocol: a successful
 * completion (`response.completed` / `response.done`, both observed in the
 * wild), an incomplete response, OR a request-level error frame. Including the error frame as terminal
 * means a retired/invalid model id surfaces here promptly instead of the
 * `waitUntil` call timing out after 30s waiting for a completion event that
 * will never arrive.
 */
export function isResponsesWSTerminal(msg: unknown): boolean {
  const m = msg as Record<string, unknown> | null;
  return (
    m?.type === "response.completed" ||
    m?.type === "response.done" ||
    m?.type === "response.incomplete" ||
    isResponsesWSError(msg)
  );
}

/**
 * Extract the JSON body of a terminal error frame for {@link isModelNotFound}
 * classification, or `null` when the messages ended in a normal completion.
 */
export function extractWSErrorBody(messages: unknown[]): string | null {
  const last = messages[messages.length - 1];
  return isResponsesWSError(last) ? JSON.stringify(last) : null;
}

/** Native request controls for bounded Responses fault probes. */
export type ResponsesWSRequestOptions = Pick<
  ResponseCreateParamsBase,
  "max_output_tokens" | "reasoning" | "tool_choice"
>;

/**
 * Build the `response.create` WS message body. The model is a PARAMETER, never
 * hardcoded here, so callers thread a live-discovered id (via
 * `resolveLiveModel` in providers.ts) instead of baking a value into this file
 * that the provider can later retire out from under the drift suite.
 */
export function buildResponsesCreateMessage(
  model: string,
  input: object[],
  tools?: object[],
  options?: ResponsesWSRequestOptions,
): Record<string, unknown> {
  const msg: Record<string, unknown> = {
    type: "response.create",
    model,
    input,
    max_output_tokens: 50,
  };
  if (tools) msg.tools = tools;
  if (options?.max_output_tokens !== undefined) msg.max_output_tokens = options.max_output_tokens;
  if (options?.reasoning !== undefined) msg.reasoning = options.reasoning;
  if (options?.tool_choice !== undefined) msg.tool_choice = options.tool_choice;
  return msg;
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

/**
 * Transport-level overrides for {@link connectTLSWebSocket}.
 *
 * Exists purely so a test can point this REAL client path at a local
 * self-signed TLS server instead of a live provider. The live drift legs pass
 * nothing and therefore keep the previous behaviour exactly: port 443 and the
 * default system trust store.
 */
export interface TLSWSConnectOptions {
  /** TLS port. Defaults to 443 — the only value the live legs use. */
  port?: number;
  /** Extra trust anchors, so a local self-signed server can be verified. */
  ca?: string | Buffer | Array<string | Buffer>;
}

export function connectTLSWebSocket(
  host: string,
  path: string,
  headers?: Record<string, string>,
  options?: TLSWSConnectOptions,
): Promise<TLSWSClient> {
  return new Promise((resolve, reject) => {
    const connectOptions: tls.ConnectionOptions = {
      host,
      port: options?.port ?? 443,
      servername: host,
    };
    if (options?.ca) connectOptions.ca = options.ca;

    const socket = tls.connect(connectOptions, () => {
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
      // The CLOSE frame the server sent, if any. Recorded rather than discarded
      // along with the socket, so a pending (or subsequent) waitUntil can
      // report WHY the provider ended the session instead of timing out.
      let closeInfo: { code: number; reason: string } | null = null;
      // Connection-scoped cursor so successive waitUntil calls resume where the last left off
      let checkedUpTo = 0;
      // Every frame this connection has received, by opcode. Read by the
      // failure paths so a zero-message outcome states what DID arrive.
      const tally = emptyFrameTally();
      // Fragment reassembly buffer (RFC 6455 §5.4). A data frame with FIN=0
      // starts a message that continuation frames extend; only the final
      // fragment emits. Non-empty means a message is mid-flight.
      let fragments: Buffer[] = [];

      /** Decode a completed message payload and wake every pending waiter. */
      const emitMessage = (payload: Buffer) => {
        const text = payload.toString("utf-8");
        try {
          messages.push(JSON.parse(text));
        } catch {
          messages.push(text);
        }
        for (const r of messageResolvers) r();
      };

      socket.on("data", (data: Buffer) => {
        buffer = Buffer.concat([buffer, data]);

        if (!handshakeDone) {
          const headerEnd = buffer.indexOf("\r\n\r\n");
          if (headerEnd === -1) return;
          const headerStr = buffer.subarray(0, headerEnd).toString();
          if (!headerStr.includes("101")) {
            const statusLine = headerStr.split("\r\n")[0];
            // Structured, not a bare Error: callers classify an auth/rate-limit/
            // 5xx handshake failure as an honest skip via `isInfraSkip(status)`
            // (see WSHandshakeError above) instead of the whole leg hard-failing.
            reject(
              new WSHandshakeError(
                `WebSocket upgrade failed: ${statusLine}`,
                parseHandshakeStatus(statusLine) ?? 0,
              ),
            );
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

            waitUntil(
              predicate: (msg: unknown) => boolean,
              timeoutMs = 30000,
              step?: string,
            ): Promise<unknown[]> {
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

                const rejectClosed = (info: { code: number; reason: string }) => {
                  reject(
                    new WSClosedError(
                      `WebSocket closed by server during waitUntil: code=${info.code} ` +
                        `reason=${JSON.stringify(info.reason)}. ${describeCollected(collected)} ` +
                        `${describeTransport(tally, step)}`,
                      info.code,
                      info.reason,
                    ),
                  );
                };

                // Check messages that arrived before waitUntil was called
                if (scanFromCursor()) {
                  resolve(collected);
                  return;
                }

                // The server may already have closed before this waitUntil was
                // called (e.g. a refusal that landed during the previous step).
                // No further message can arrive, so report the stated reason
                // now instead of waiting out the full timeout.
                if (closeInfo) {
                  settled = true;
                  rejectClosed(closeInfo);
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
                    reject(
                      new Error(
                        `waitUntil timeout after ${timeoutMs}ms. ${describeCollected(collected)} ` +
                          `${describeTransport(tally, step)}`,
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
                          `Collected ${collected.length} messages. ` +
                          `${describeTransport(tally, step)}`,
                      ),
                    );
                    return;
                  }
                  // Scan all new messages since last check.
                  //
                  // The ORDER of this block relative to the close check below is
                  // inert here, not protective: the resolver wake sits inside the
                  // per-frame parse loop and fires on each TEXT frame, so an
                  // answer arriving in the same segment as a CLOSE has already
                  // settled this promise before the CLOSE frame is parsed. No
                  // reachable state in this function has BOTH an unscanned
                  // satisfying message and `closeInfo` set, so swapping the two
                  // blocks changes nothing observable — do not read this ordering
                  // as a guard. It is kept only to match the pre-check above,
                  // which is where the ordering IS load-bearing (a buffered
                  // answer plus an already-recorded close) and is covered by the
                  // "prefers a buffered satisfying message over an
                  // already-recorded close" test.
                  //
                  // The close check itself is NOT dead: a server that sends only
                  // a CLOSE frame leaves this scan empty, and deleting that
                  // branch reds the refusal regression test.
                  if (scanFromCursor()) {
                    settled = true;
                    clearTimeout(timer);
                    removeResolver();
                    resolve(collected);
                    return;
                  }
                  // A server-sent CLOSE ends the session, so the awaited message
                  // can never arrive. Report the code/reason rather than spin
                  // out the timeout and lose the diagnosis.
                  if (closeInfo) {
                    settled = true;
                    clearTimeout(timer);
                    removeResolver();
                    rejectClosed(closeInfo);
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
          const fin = (byte0 & 0x80) !== 0;
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

          if (opcode === 0x1 || opcode === 0x2) {
            // A data frame. TEXT and BINARY are decoded IDENTICALLY: this
            // protocol's payload is UTF-8 JSON either way, and which opcode a
            // provider picks is its own choice — `@google/genai` decodes an
            // inbound Blob/ArrayBuffer for exactly that reason. Treating 0x2 as
            // unreadable is what made a talking provider look mute.
            if (opcode === 0x1) tally.text++;
            else tally.binary++;
            if (fin) {
              emitMessage(framePayload);
            } else {
              // Copy: `framePayload` is a view onto the receive buffer, which
              // is replaced on the next socket "data" event.
              fragments = [Buffer.from(framePayload)];
            }
          } else if (opcode === 0x0) {
            // Continuation of a fragmented message. Emit only on FIN — a
            // partial message must NOT be surfaced as if it were complete.
            tally.continuation++;
            if (fragments.length > 0) {
              fragments.push(Buffer.from(framePayload));
              if (fin) {
                const complete = Buffer.concat(fragments);
                fragments = [];
                emitMessage(complete);
              }
            }
          } else if (opcode === 0x8) {
            // close frame — keep the code/reason before ending the socket, then
            // wake any pending waitUntil so it can report the stated reason.
            // Socket lifecycle is deliberately unchanged: still a plain end().
            tally.close++;
            closeInfo = parseCloseFrame(framePayload);
            socket.end();
            for (const r of messageResolvers) r();
          } else if (opcode === 0x9) {
            // ping — respond with pong per RFC 6455. Control frames may be
            // interleaved between fragments, so this must not touch `fragments`.
            tally.ping++;
            socket.write(buildMaskedPongFrame(framePayload));
          } else if (opcode === 0xa) {
            tally.pong++;
          } else {
            // An opcode this client does not implement. Counted, never dropped
            // silently — see WSFrameTally.
            tally.unhandled++;
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
  model = "gpt-4o-mini",
  options?: ResponsesWSRequestOptions,
): Promise<WSResult> {
  const ws = await connectTLSWebSocket("api.openai.com", "/v1/responses", {
    Authorization: `Bearer ${config.apiKey}`,
  });

  try {
    // Real Responses WS API uses flat format: model/input/tools at the top level
    // of the response.create message (not nested inside a "response" object).
    // `model` is a caller-supplied parameter (default retained for back-compat)
    // so the drift leg can thread a live-discovered id via `resolveLiveModel`
    // instead of this file hardcoding one the provider can later retire.
    ws.send(JSON.stringify(buildResponsesCreateMessage(model, input, tools, options)));

    // Terminal: a completion event ("response.completed"/"response.done", both
    // observed in the wild) OR a request-level error frame — see
    // isResponsesWSTerminal for why the error frame must be terminal too.
    const rawMessages = await ws.waitUntil(isResponsesWSTerminal, undefined, "response");

    const events: SSEEventShape[] = rawMessages.map((msg: any) => ({
      type: msg.type ?? "unknown",
      dataShape: extractShape(msg),
    }));

    return { events, rawMessages };
  } finally {
    ws.close();
  }
}

// ---------------------------------------------------------------------------
// OpenAI Realtime WebSocket
// ---------------------------------------------------------------------------

export async function openaiRealtimeWS(
  config: ProviderConfig,
  text: string,
  tools?: object[],
  options?: Pick<RealtimeResponseCreateParams, "max_output_tokens" | "tool_choice">,
): Promise<WSResult> {
  // GA-only probe. The Realtime Beta API is retired — a live Beta handshake
  // ("OpenAI-Beta: realtime=v1") is now rejected with
  // {"code":"beta_api_shape_disabled","message":"The Realtime Beta API is no
  // longer supported. Please use /v1/realtime for the GA API."}. So this probe
  // exercises ONLY the GA surface, which is the surface aimock mocks.
  //
  // Realtime API requires a realtime-specific model (gpt-4o-mini doesn't work).
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
  };
  const ws = await connectTLSWebSocket(
    "api.openai.com",
    "/v1/realtime?model=gpt-realtime-mini",
    headers,
  );

  try {
    // Step 1: Wait for session.created
    const sessionCreated = await ws.waitUntil(
      (msg: any) => msg?.type === "session.created",
      undefined,
      "session.created",
    );

    // Step 2: Send session.update.
    // GA requires session.type:"realtime" and renames the legacy `modalities`
    // field to `output_modalities`. Confirmed live: a GA session.update without
    // session.type is rejected with "Missing required parameter: 'session.type'".
    const session: Record<string, unknown> = {
      type: "realtime",
      model: "gpt-realtime-mini",
      output_modalities: ["text"],
    };
    if (tools) session.tools = tools;
    ws.send(JSON.stringify({ type: "session.update", session }));

    // Step 3: Wait for session.updated
    const sessionUpdated = await ws.waitUntil(
      (msg: any) => msg?.type === "session.updated",
      undefined,
      "session.updated",
    );

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

    // Step 5: Wait for conversation.item.added (GA)
    const itemCreated = await ws.waitUntil(
      (msg: any) => msg?.type === "conversation.item.added",
      undefined,
      "conversation.item.added",
    );

    // Step 6: Send response.create
    const response: Pick<RealtimeResponseCreateParams, "max_output_tokens" | "tool_choice"> = {};
    if (options?.max_output_tokens !== undefined)
      response.max_output_tokens = options.max_output_tokens;
    if (options?.tool_choice !== undefined) response.tool_choice = options.tool_choice;
    ws.send(
      JSON.stringify({
        type: "response.create",
        ...(Object.keys(response).length > 0 ? { response } : {}),
      }),
    );

    // Step 7: Collect until response.done
    const responseMessages = await ws.waitUntil(
      (msg: any) => msg?.type === "response.done",
      undefined,
      "response.done",
    );

    // Combine all step results (each waitUntil returns only new messages since prior call)
    const allMessages = [...sessionCreated, ...sessionUpdated, ...itemCreated, ...responseMessages];

    const events: SSEEventShape[] = allMessages.map((msg: any) => ({
      type: msg.type ?? "unknown",
      dataShape: extractShape(msg),
    }));

    return { events, rawMessages: allMessages };
  } finally {
    ws.close();
  }
}

// ---------------------------------------------------------------------------
// Gemini Live WebSocket
// ---------------------------------------------------------------------------

/**
 * The response modality this leg drives: the one a native-audio Live model
 * actually emits.
 *
 * Google's Live API permits exactly ONE modality per session, and a
 * native-audio model accepts only `AUDIO`. Requesting `TEXT` on one is refused
 * out-of-band with an RFC 6455 CLOSE frame — observed verbatim from the live
 * endpoint as
 *
 *   code=1007 reason="The requested combination of response modalities (TEXT)
 *   is not supported by the model. models/gemini-3.1-flash-live-preview"
 *
 * so this leg drives the AUDIO shape, which is the shape those models emit.
 *
 * `bidiGenerateContent` does NOT imply AUDIO, though, and the original form of
 * this comment claimed it did. Google shipped `gemini-3.5-transcribe-live` on
 * 2026-08-26: a streaming SPEECH-TO-TEXT model that declares
 * `bidiGenerateContent` and emits only TEXT. It refused the mirror-image
 * session with the mirror-image frame
 *
 *   code=1007 reason="The requested combination of response modalities (AUDIO)
 *   is not supported by the model. models/gemini-3.5-transcribe-live"
 *
 * (drift run 33296393200). Modality is therefore a PER-MODEL capability the
 * listing does not express, which is what {@link driveGeminiLiveAudio} exists
 * to resolve. See ws-gemini-live-modality.test.ts for the local reproduction of
 * both refusals and the red/green pairs over this function.
 */
export const GEMINI_LIVE_RESPONSE_MODALITIES = ["AUDIO"];

/** The live Gemini endpoint host — the only host the drift leg itself uses. */
export const GEMINI_LIVE_HOST = "generativelanguage.googleapis.com";

/**
 * Transport overrides for {@link geminiLiveWS}.
 *
 * Exists purely so a test can point this REAL probe path at a local
 * fake-provider TLS server instead of Google. The live drift leg passes nothing
 * and therefore keeps the previous behaviour exactly: the live host, port 443,
 * and the default system trust store.
 */
export interface GeminiLiveTransportOptions extends TLSWSConnectOptions {
  /** Host override. Defaults to {@link GEMINI_LIVE_HOST}. */
  host?: string;
  /**
   * Per-step wait budget in ms. Defaults to the client's 30s, which is what the
   * live leg uses. Exists so a test can drive the REAL probe against a provider
   * that goes mute — the live failure mode — without waiting out 30 seconds.
   */
  waitMs?: number;
}

/**
 * Classify an observed Live WS message sequence into the counts the AUDIO-turn
 * assertions grade on.
 *
 * Separated from the drift leg so the observation logic is unit-testable
 * WITHOUT live credentials (the live `describe` is gated on `GOOGLE_API_KEY`):
 * a probe whose only check is "did any bytes arrive" cannot tell an audio turn
 * from a refusal, and that is precisely how the TEXT refusal stayed
 * undiagnosed. Counts — not booleans — so an assertion can require that audio
 * actually streamed rather than merely that a key existed once.
 */
export function summarizeGeminiLiveTurn(messages: unknown[]): {
  setupCompleteCount: number;
  audioPartCount: number;
  textPartCount: number;
  turnCompleteCount: number;
  toolCallCount: number;
} {
  let setupCompleteCount = 0;
  let audioPartCount = 0;
  let textPartCount = 0;
  let turnCompleteCount = 0;
  let toolCallCount = 0;

  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const msg = raw as Record<string, any>;
    if ("setupComplete" in msg) setupCompleteCount++;
    if ("toolCall" in msg) toolCallCount++;
    const sc = msg.serverContent;
    if (sc && typeof sc === "object") {
      if (sc.turnComplete === true) turnCompleteCount++;
      const parts = sc.modelTurn?.parts;
      if (Array.isArray(parts)) {
        for (const part of parts) {
          if (!part || typeof part !== "object") continue;
          if (part.inlineData?.data !== undefined) audioPartCount++;
          else if (typeof part.text === "string") textPartCount++;
        }
      }
    }
  }

  return { setupCompleteCount, audioPartCount, textPartCount, turnCompleteCount, toolCallCount };
}

/**
 * True when a WS failure is the provider REFUSING the requested response
 * modality for that model — RFC 6455 code 1007 with Google's verbatim reason.
 *
 * This is a CAPABILITY answer, not an error: the provider is stating that this
 * model does not serve the modality asked for, which is exactly the fact the
 * `/models` listing omits. {@link driveGeminiLiveAudio} treats it as
 * "disqualify this candidate and try the next", never as drift.
 *
 * Matched on the reason PREFIX Google emits, which is modality-agnostic — the
 * TEXT refusal (2026-08, native-audio models) and the AUDIO refusal (2026-08-30,
 * `gemini-3.5-transcribe-live`) are the same sentence with the modality
 * substituted. Deliberately NOT matched on the model name in the reason: the
 * name is the one part of that string that carries no capability signal.
 */
export function isModalityRefusal(err: unknown): err is WSClosedError {
  return (
    err instanceof WSClosedError &&
    err.code === 1007 &&
    /requested combination of response modalities/i.test(err.reason)
  );
}

/** A candidate the provider disqualified, with the reason it gave. */
export interface RefusedGeminiLiveCandidate {
  model: string;
  reason: string;
}

/** Outcome of {@link driveGeminiLiveAudio}. */
export interface GeminiLiveAudioDrive {
  /** The model that actually served the AUDIO turn (fully qualified). */
  model: string;
  result: WSResult;
  /** Candidates the provider refused AUDIO on, in the order it refused them. */
  refused: RefusedGeminiLiveCandidate[];
}

/**
 * Drive an AUDIO Live turn against the first candidate that ACTUALLY SERVES
 * AUDIO, learning that capability from the provider rather than from the id.
 *
 * `candidates` is the ordered list of `bidiGenerateContent` models the live
 * listing exposed (see `resolveLiveModelCandidates`). Declaring that method is
 * necessary but not sufficient: a streaming transcriber declares it and emits
 * only TEXT. So each candidate is tried in listing order and a
 * {@link isModalityRefusal} close advances to the next — the provider's own
 * refusal is the authority, and no capability is ever re-derived from the model
 * NAME (the mis-classification this leg has already been bitten by twice).
 *
 * Returns `null` when EVERY candidate refused AUDIO. That is an honest
 * unavailability — the listing exposes no model this leg can grade — and the
 * caller skips on it rather than reporting drift, matching how it treats an
 * empty listing. Every other failure (handshake infra status, a mute provider,
 * a timeout) propagates UNCHANGED so this helper can never mask one.
 */
export async function driveGeminiLiveAudio(
  config: ProviderConfig,
  text: string,
  tools: object[] | undefined,
  candidates: string[],
  transport?: GeminiLiveTransportOptions,
): Promise<GeminiLiveAudioDrive | null> {
  const refused: RefusedGeminiLiveCandidate[] = [];
  for (const candidate of candidates) {
    const model = candidate.startsWith("models/") ? candidate : `models/${candidate}`;
    try {
      const result = await geminiLiveWS(config, text, tools, model, transport);
      return { model, result, refused };
    } catch (err) {
      if (!isModalityRefusal(err)) throw err;
      refused.push({ model, reason: err.reason });
    }
  }
  return null;
}

export async function geminiLiveWS(
  config: ProviderConfig,
  text: string,
  tools?: object[],
  model = "models/gemini-2.5-flash",
  transport?: GeminiLiveTransportOptions,
): Promise<WSResult> {
  const path = `/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${config.apiKey}`;

  const ws = await connectTLSWebSocket(transport?.host ?? GEMINI_LIVE_HOST, path, undefined, {
    port: transport?.port,
    ca: transport?.ca,
  });

  // Step 1: Send setup. `model` is a caller-supplied parameter (default
  // retained for back-compat) so the drift leg can thread a live-discovered
  // id via `resolveLiveModel` instead of this file hardcoding one that the
  // provider can later retire out from under the drift suite (mirrors the
  // `buildResponsesCreateMessage` model-as-parameter pattern above).
  const setup: Record<string, unknown> = {
    model,
    generationConfig: { responseModalities: GEMINI_LIVE_RESPONSE_MODALITIES },
  };
  if (tools) setup.tools = tools;
  ws.send(JSON.stringify({ setup }));

  // Step 2: Wait for setupComplete. The step LABEL is what makes a silent run
  // diagnosable: `step=setupComplete` means the session was never established,
  // `step=turn` below means it was and the turn produced nothing — two very
  // different causes that previously failed with identical text. The MODEL rides
  // along because it is resolved dynamically from the live listing, so a failure
  // that does not name it cannot be attributed to a model at all.
  const setupComplete = await ws.waitUntil(
    (msg: any) => msg && typeof msg === "object" && "setupComplete" in msg,
    transport?.waitMs,
    `setupComplete model=${model}`,
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
  const responseMessages = await ws.waitUntil(
    (msg: any) => {
      if (!msg || typeof msg !== "object") return false;
      if ("toolCall" in msg) return true;
      if ("serverContent" in msg) {
        return (msg as any).serverContent?.turnComplete === true;
      }
      return false;
    },
    transport?.waitMs,
    `turn model=${model}`,
  );

  ws.close();

  const allMessages = [...setupComplete, ...responseMessages];

  const events: SSEEventShape[] = allMessages.map((msg: any) => ({
    type: classifyGeminiMessage(msg as Record<string, unknown>),
    dataShape: extractShape(msg),
  }));

  return { events, rawMessages: allMessages };
}
