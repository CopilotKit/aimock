import type * as http from "node:http";
import type { Fixture, JournalEntry } from "../types.js";
import type { WebSocketConnection } from "../ws-framing.js";
import { createInterruptionSignal, type InterruptionControl } from "../interruption.js";
import { responseGoneReason } from "../chaos.js";

/** The journal `interruptReason` for a client that left before the reply finished. */
export const CLIENT_ABORTED = "client aborted";

/**
 * The journal `interruptReason` for a response aimock tore down itself: the
 * chaos `disconnect` action or a server-side `destroy`. It is the name the
 * chaos journal entry records (`chaosAction: "disconnect"`), so a teardown
 * aimock caused is never blamed on the client.
 */
export const AIMOCK_DISCONNECTED = "disconnect";

/**
 * Which side stopped a delivery first: the client, the fixture's own
 * interruption, or aimock tearing the response down (`"server"`).
 */
export type InterruptCause = "client" | "fixture" | "server";

/**
 * One delivery's stop signal. It merges the fixture interruption
 * (`truncateAfterChunks` / `disconnectAfterMs`) with the client going away
 * and with aimock tearing the response down (`"server"`).
 * The first cause wins: a later cause never reclassifies it.
 */
export interface DeliveryLifecycle {
  /** Aborts on the first cause: fixture, client, or server. */
  readonly signal: AbortSignal;
  /** The cause that aborted `signal`, or `undefined` while it has not aborted. */
  cause(): InterruptCause | undefined;
  /**
   * The fixture's reason, {@link CLIENT_ABORTED}, {@link AIMOCK_DISCONNECTED},
   * or `undefined` while running.
   */
  reason(): string | undefined;
  /** Forwards a sent chunk to the fixture interruption (counts toward `truncateAfterChunks`). */
  tick(): void;
  /** Removes the close and fixture-abort listeners and clears the fixture's `disconnectAfterMs` timer. */
  dispose(): void;
}

/** The part of an EventEmitter a close source may expose. Test doubles may carry less. */
interface CloseSource {
  once?: (event: "close", listener: () => void) => unknown;
  off?: (event: "close", listener: () => void) => unknown;
  removeListener?: (event: "close", listener: () => void) => unknown;
}

/**
 * Subscribe to `close`, guarded the same way as `awaitChaosLatency`: a partial
 * test double without `once` is not subscribed, and only a listener that was
 * added is ever removed, through a remover that exists.
 */
function subscribeClose(source: CloseSource, onClose: () => void): (() => void) | undefined {
  if (typeof source.once !== "function") return undefined;
  source.once("close", onClose);
  if (typeof source.off === "function") return () => source.off?.("close", onClose);
  if (typeof source.removeListener === "function")
    return () => source.removeListener?.("close", onClose);
  return undefined;
}

function createLifecycle(
  interruption: InterruptionControl | null,
  goneAtStart: InterruptCause | undefined,
  subscribe: (onGone: (cause: InterruptCause) => void) => (() => void) | undefined,
): DeliveryLifecycle {
  const controller = new AbortController();
  let firstCause: InterruptCause | undefined;
  const abortWith = (cause: InterruptCause): void => {
    if (controller.signal.aborted) return;
    firstCause = cause;
    controller.abort();
  };
  const onFixtureAbort = (): void => abortWith("fixture");
  interruption?.signal.addEventListener("abort", onFixtureAbort, { once: true });
  let unsubscribe: (() => void) | undefined;
  if (goneAtStart !== undefined) abortWith(goneAtStart);
  else unsubscribe = subscribe(abortWith);
  return {
    signal: controller.signal,
    cause: () => firstCause,
    reason: () => {
      if (firstCause === "fixture") return interruption?.reason();
      if (firstCause === "client") return CLIENT_ABORTED;
      if (firstCause === "server") return AIMOCK_DISCONNECTED;
      return undefined;
    },
    tick: () => {
      interruption?.tick();
    },
    dispose: () => {
      unsubscribe?.();
      unsubscribe = undefined;
      interruption?.signal.removeEventListener("abort", onFixtureAbort);
      interruption?.cleanup();
    },
  };
}

/** The request socket fields the teardown rule and the status-line rule read. */
export interface PeerSocket {
  readonly errored?: Error | null;
  readonly writableEnded?: boolean;
  readonly bytesWritten?: number;
}

/** Where a response's request socket can be read from. Test doubles may carry neither. */
interface SocketOwner {
  readonly req?: { readonly socket?: PeerSocket | null };
  readonly socket?: PeerSocket | null;
}

/** The request socket of `res`, or `undefined` when it carries none. */
export function requestSocket(res: http.ServerResponse): PeerSocket | undefined {
  const owner: SocketOwner = res;
  return owner.req?.socket ?? owner.socket ?? undefined;
}

/**
 * THE client hang-up rule, shared by the delivery lifecycle and the proxy
 * relay: the client's socket closed or reset.
 *
 * - A reset, or a write into a socket the peer closed, leaves `errored` set
 *   (ECONNRESET / EPIPE).
 * - aimock's server keeps Node's default `httpAllowHalfOpen: false`, so a
 *   client FIN makes Node end our write side: the socket is `writableEnded`
 *   while the response is not. That is the evidence the client closed.
 *
 * A FIN alone (`readableEnded` with neither of those) is not a hang-up: it is
 * what the socket shows when aimock tore the response down before Node
 * answered the FIN. A real client FIN that Node has not answered yet looks the
 * same, so this rule also classifies it as not a hang-up. aimock's own
 * `destroy()` leaves neither signal.
 */
export function closedByClient(socket: PeerSocket): boolean {
  return (socket.errored ?? null) !== null || socket.writableEnded === true;
}

/**
 * Who tore down a response that is gone without having ended. After the fact
 * `res.destroyed` reads the same either way, so this reads the evidence:
 *
 * - a chaos `disconnect` marked the response before destroying it: aimock;
 * - the request socket meets {@link closedByClient}: the client;
 * - neither: aimock destroyed it server-side.
 *
 * `socket` defaults to the response's request socket. With no socket to read
 * (a partial test double) the client attribution is kept.
 */
export function teardownCause(
  res: http.ServerResponse,
  socket: PeerSocket | null | undefined = requestSocket(res),
): "client" | "server" {
  if (responseGoneReason(res) === "chaos-disconnected") return "server";
  if (!socket) return "client";
  return closedByClient(socket) ? "client" : "server";
}

/**
 * The request socket's `bytesWritten` when each delivery started, so the
 * status-line rule counts only this response's bytes on a keep-alive socket.
 */
const deliveryStartBytes = new WeakMap<http.ServerResponse, number>();

/**
 * Record where this response's bytes start on its socket. A response whose
 * head was already committed when the delivery started is not recorded:
 * {@link statusLineSent} keeps the `headersSent` rule for it.
 */
export function noteDeliveryStart(res: http.ServerResponse): void {
  if (deliveryStartBytes.has(res) || res.headersSent) return;
  const bytes = requestSocket(res)?.bytesWritten;
  if (typeof bytes === "number") deliveryStartBytes.set(res, bytes);
}

/**
 * Whether this response's status line reached the client's socket: a byte of
 * it was handed to the socket after {@link noteDeliveryStart}. `headersSent`
 * is not that test: `writeHead` sets it before any byte is written. With no
 * recorded start, or no socket to read, `headersSent` is the fallback.
 */
export function statusLineSent(res: http.ServerResponse): boolean {
  const start = deliveryStartBytes.get(res);
  const bytes = requestSocket(res)?.bytesWritten;
  if (start === undefined || typeof bytes !== "number") return res.headersSent;
  return bytes > start;
}

/** The journal `interruptReason` for {@link teardownCause}. */
export function teardownReason(res: http.ServerResponse): string {
  return teardownCause(res) === "client" ? CLIENT_ABORTED : AIMOCK_DISCONNECTED;
}

/**
 * HTTP delivery lifecycle. A `close` before `res.writableFinished` aborts it,
 * and {@link teardownCause} decides whose teardown it was: the client
 * (`"client"`) or aimock itself (`"server"`). A response that is already gone
 * at construction aborts at once with the same attribution. A chaos
 * `disconnect` destroys without ending, so no `writableEnded` check stops a
 * writer for it. Only an already-ended response does not abort: the frame
 * loop exits on its `writableEnded` check. The fixture interruption is
 * created only when `streaming` is true (it is streaming-only).
 */
export function httpLifecycle(
  res: http.ServerResponse,
  fixture: Fixture | null,
  opts: { streaming: boolean },
): DeliveryLifecycle {
  const interruption = opts.streaming && fixture ? createInterruptionSignal(fixture) : null;
  const gone = responseGoneReason(res);
  const goneAtStart = gone === null || gone === "already-ended" ? undefined : teardownCause(res);
  return createLifecycle(interruption, goneAtStart, (onGone) =>
    subscribeClose(res, () => {
      if (!res.writableFinished) onGone(teardownCause(res));
    }),
  );
}

/**
 * Per watched connection: whether its `close` event has fired. Only sockets
 * watched while open are recorded, so an entry is evidence, not a guess.
 */
const wsCloseEmitted = new WeakMap<WebSocketConnection, boolean>();

/**
 * Start recording when `ws` emits `close`, so {@link wsClosedCause} can tell
 * aimock's own close from the client's. Each WS transport calls it when the
 * connection opens. Idempotent, and a no-op once closed.
 */
export function watchWsClose(ws: WebSocketConnection): void {
  if (ws.isClosed || wsCloseEmitted.has(ws)) return;
  const source: CloseSource = ws;
  if (typeof source.once !== "function") return;
  wsCloseEmitted.set(ws, false);
  source.once("close", () => wsCloseEmitted.set(ws, true));
}

/**
 * Who closed a socket that reads `isClosed`, or `undefined` while it is open.
 *
 * `WebSocketConnection` marks itself closed and emits `close` in the same step
 * for a client close frame, a lost connection, and `destroy()`. Only aimock's
 * own `close()` (a write or buffer limit, a bad frame, a strict miss, shutdown)
 * marks it closed at once and emits `close` about 100ms later. So a socket
 * watched while open ({@link watchWsClose}) that is closed with no `close` yet
 * was closed by aimock (`"server"`). Any other closed socket reads as the
 * client leaving, as before.
 */
export function wsClosedCause(ws: WebSocketConnection): "client" | "server" | undefined {
  if (!ws.isClosed) return undefined;
  return wsCloseEmitted.get(ws) === false ? "server" : "client";
}

/**
 * WebSocket turn lifecycle. A WS turn is always a stream, so it always owns
 * the fixture interruption. A `close` means the client left. A socket already
 * closed at construction aborts at once with {@link wsClosedCause}. Callers
 * never create their own interruption object.
 */
export function wsLifecycle(ws: WebSocketConnection, fixture: Fixture | null): DeliveryLifecycle {
  const interruption = fixture ? createInterruptionSignal(fixture) : null;
  return createLifecycle(interruption, wsClosedCause(ws), (onGone) =>
    subscribeClose(ws, () => onGone("client")),
  );
}

/**
 * Journal a WS turn that stopped because its lifecycle aborted or its socket
 * closed. This is the closed-socket rule every WS transport uses: the
 * lifecycle's reason when it has one, else the closed socket's cause
 * ({@link wsClosedCause}): {@link AIMOCK_DISCONNECTED} for aimock's own close,
 * {@link CLIENT_ABORTED} for the client. A turn with no lifecycle (it never
 * waits) passes none.
 */
export function markWsTurnStopped(
  entry: JournalEntry,
  ws: WebSocketConnection,
  lifecycle?: DeliveryLifecycle,
): void {
  const cause = wsClosedCause(ws);
  const socketReason =
    cause === "server" ? AIMOCK_DISCONNECTED : cause === "client" ? CLIENT_ABORTED : undefined;
  markInterrupted(entry, lifecycle?.reason() ?? socketReason);
}

/**
 * Mark a journal entry interrupted. The reason is set only when the entry has
 * none, so a later `undefined` never erases an earlier reason. The status is
 * never changed: the entry keeps the status it was journaled with.
 */
export function markInterrupted(entry: JournalEntry, reason: string | undefined): void {
  entry.response.interrupted = true;
  if (entry.response.interruptReason === undefined && reason !== undefined) {
    entry.response.interruptReason = reason;
  }
}
