import * as http from "node:http";
import * as https from "node:https";
import { randomBytes } from "node:crypto";
import { WebSocketConnection, computeAcceptKey, type WebSocketLimits } from "./ws-framing.js";

const REFUSAL_BODY_LIMIT = 64 * 1024;
const UPGRADE_TIMEOUT_MS = 30_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
// Reviewed Live startup uses Authorization plus connector-owned RFC 6455 headers.
const PROVIDER_HEADERS = new Set(["authorization"]);
const PROVIDER_ERROR_ID = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * The provider refused the upgrade with a plain HTTP response. Carries the
 * status and, when the refusal body is a JSON error envelope, its `error.code`
 * and `error.type` identifiers (for example `insufficient_quota`). The body
 * text itself is never exposed.
 */
export class UpstreamWebSocketRefusedError extends Error {
  readonly status: number;
  readonly errorCode: string | undefined;
  readonly errorType: string | undefined;

  constructor(status: number, body: Buffer) {
    // `name` stays "Error": the failure header readers already match is unchanged.
    super(`Upstream WebSocket refused (HTTP ${status})`);
    this.status = status;
    const error = refusalErrorEnvelope(body);
    this.errorCode = providerErrorId(error?.code);
    this.errorType = providerErrorId(error?.type);
  }
}

function refusalErrorEnvelope(body: Buffer): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const error = (parsed as Record<string, unknown>).error;
    return typeof error === "object" && error !== null
      ? (error as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function providerErrorId(value: unknown): string | undefined {
  return typeof value === "string" && PROVIDER_ERROR_ID.test(value) ? value : undefined;
}

/** Connect to a provider using verified TLS, or an explicitly configured loopback test peer.
 * The caller's signal owns the session lifetime; the upgrade budget defaults to thirty seconds.
 */
export async function connectUpstreamWebSocket(
  url: URL,
  headers: Record<string, string>,
  limits: WebSocketLimits,
  signal: AbortSignal,
  upstreamTimeoutMs = UPGRADE_TIMEOUT_MS,
): Promise<WebSocketConnection> {
  if (!Number.isSafeInteger(upstreamTimeoutMs) || upstreamTimeoutMs <= 0) {
    throw new RangeError("Upstream WebSocket timeout must be a positive safe integer");
  }
  const target = new URL(url.href);
  const secure = target.protocol === "https:" || target.protocol === "wss:";
  const loopback =
    target.hostname === "localhost" ||
    target.hostname === "[::1]" ||
    /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(target.hostname);
  if (
    target.username ||
    target.password ||
    target.hash ||
    (!secure && (!(target.protocol === "http:" || target.protocol === "ws:") || !loopback))
  ) {
    throw new Error("Invalid upstream WebSocket URL");
  }
  for (const value of [limits.maxMessageBytes, limits.maxBufferedBytes, limits.maxWriteBytes]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0))
      throw new RangeError("WebSocket limits must be positive safe integers");
  }
  if (signal.aborted) throw new Error("Upstream WebSocket aborted");
  target.protocol = secure ? "https:" : "http:";
  const key = randomBytes(16).toString("base64");
  const outgoing: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (PROVIDER_HEADERS.has(name.toLowerCase())) outgoing[name.toLowerCase()] = value;
  }
  Object.assign(outgoing, {
    Upgrade: "websocket",
    Connection: "Upgrade",
    "Sec-WebSocket-Key": key,
    "Sec-WebSocket-Version": "13",
  });
  return new Promise<WebSocketConnection>((resolve, reject) => {
    let settled = false;
    let connection: WebSocketConnection | undefined;
    const request = (secure ? https : http).request(target, {
      method: "GET",
      headers: outgoing,
      agent: false,
      ...(secure ? { rejectUnauthorized: true } : {}),
    });
    const started = performance.now();
    const onTimeout = () => {
      const remaining = upstreamTimeoutMs - (performance.now() - started);
      if (remaining > 0) timer = setTimeout(onTimeout, Math.min(remaining, MAX_TIMER_DELAY_MS));
      else fail("Upstream WebSocket upgrade timed out");
    };
    // Node clamps overflowing setTimeout delays to one millisecond. Keep the
    // full validated budget by scheduling bounded segments against elapsed time.
    let timer = setTimeout(onTimeout, Math.min(upstreamTimeoutMs, MAX_TIMER_DELAY_MS));
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    const fail = (message: string | Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      request.destroy();
      reject(typeof message === "string" ? new Error(message) : message);
    };
    const abort = () => {
      if (connection) connection.destroy();
      else fail("Upstream WebSocket aborted");
    };
    signal.addEventListener("abort", abort, { once: true });
    request.on("error", () => fail("Upstream WebSocket connection failed"));
    request.once("response", (response) => {
      let bytes = 0;
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > REFUSAL_BODY_LIMIT) {
          fail("Upstream WebSocket refusal body limit exceeded");
          response.destroy();
          return;
        }
        chunks.push(chunk);
      });
      response.once("end", () =>
        fail(new UpstreamWebSocketRefusedError(response.statusCode ?? 0, Buffer.concat(chunks))),
      );
      response.once("error", () => fail("Upstream WebSocket response failed"));
      response.once("aborted", () => fail("Upstream WebSocket response failed"));
    });
    request.once("upgrade", (response, socket, head) => {
      if (settled) {
        socket.destroy();
        return;
      }
      const tokens = (value: string | undefined) =>
        value?.split(",").map((token) => token.trim().toLowerCase()) ?? [];
      if (
        response.statusCode !== 101 ||
        !tokens(response.headers.upgrade).includes("websocket") ||
        !tokens(response.headers.connection).includes("upgrade") ||
        response.headers["sec-websocket-accept"] !== computeAcceptKey(key) ||
        response.headers["sec-websocket-extensions"] !== undefined ||
        response.headers["sec-websocket-protocol"] !== undefined
      ) {
        socket.destroy();
        fail("Invalid upstream WebSocket upgrade");
        return;
      }
      socket.pause();
      connection = new WebSocketConnection(socket, {
        maxMessageBytes: limits.maxMessageBytes ?? 1024 * 1024,
        maxBufferedBytes: limits.maxBufferedBytes ?? 2 * 1024 * 1024,
        maxWriteBytes: limits.maxWriteBytes ?? 1024 * 1024,
        maskOutgoing: true,
      });
      connection.once("close", cleanup);
      settled = true;
      clearTimeout(timer);
      // Pause until the promise consumer can register its message/error listeners.
      // unshift preserves ordering between upgrade head and subsequent socket bytes.
      if (head.length) socket.unshift(head);
      resolve(connection);
      setImmediate(() => {
        if (!socket.destroyed) socket.resume();
      });
    });
    request.end();
  });
}
