import type * as http from "node:http";
import { CLIENT_ABORTED, noteDeliveryStart, statusLineSent, teardownCause } from "./lifecycle.js";

/**
 * Responses torn down before they finished, judged at entry, on `close`, and
 * when the relay returns. Reading `res.writableFinished` only when journaling
 * is too late: on Node 20 and 22 a relay that calls `end()` on a destroyed
 * response makes it read `true` (Node 24+ keeps it `false`).
 */
const tornDownBeforeFinish = new WeakSet<http.ServerResponse>();

/**
 * Run a proxy relay while watching for a client hang-up.
 *
 * WHO killed a mid-flight stream decides what the journal says, and after the
 * fact the two look identical: `req.aborted`, `req.destroyed` and
 * `res.destroyed` all read the same whether the peer hung up or the recorder
 * tore the response down. So the hang-up is decided when the request socket
 * actually closes before the response ended, by the same rule the delivery
 * lifecycle uses ({@link teardownCause}): the client's socket closed or reset.
 * A FIN alone is not a hang-up. A response already gone when this is entered
 * is judged by that rule too, so a response aimock destroyed is not blamed on
 * the client. The listener is attached before `run` and removed after it: a
 * keep-alive socket outlives this request.
 */
export async function withHangUpDetection<T>(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  run: () => Promise<T>,
): Promise<{ outcome: T; clientHungUp: boolean }> {
  const socket = req.socket;
  noteDeliveryStart(res);
  const clientCaused = (): boolean => !res.writableEnded && teardownCause(res, socket) === "client";
  let clientHungUp = (res.destroyed || socket?.destroyed === true) && clientCaused();
  const noteSocketClose = (): void => {
    if (clientCaused()) clientHungUp = true;
  };
  const noteTearDown = (): void => {
    if (res.destroyed && !res.writableFinished) tornDownBeforeFinish.add(res);
  };
  noteTearDown();
  socket?.on("close", noteSocketClose);
  res.on("close", noteTearDown);
  try {
    const outcome = await run();
    return { outcome, clientHungUp };
  } finally {
    // The relay may have destroyed the response in its last tick, before
    // `close` is emitted.
    noteTearDown();
    socket?.off("close", noteSocketClose);
    res.off("close", noteTearDown);
  }
}

/**
 * The journal fields for a proxied response. A stream torn down before it
 * finished (destroyed, even when the relay called `end()` on it afterwards)
 * is marked interrupted and names the side that killed it: a client hang-up
 * is normal caller behaviour, an upstream/recorder tear-down is a fault worth
 * chasing. When no byte of the response reached the socket
 * ({@link statusLineSent}) the status is 0: the client never got a status
 * line. A response that finished, or was never torn down, gets no fields.
 */
export function proxyInterruption(
  res: http.ServerResponse,
  clientHungUp: boolean,
): { status?: 0; interrupted?: true; interruptReason?: string } {
  const tornDown = res.destroyed && (tornDownBeforeFinish.has(res) || !res.writableFinished);
  if (!tornDown) return {};
  return {
    ...(statusLineSent(res) ? {} : { status: 0 as const }),
    interrupted: true,
    interruptReason: clientHungUp ? CLIENT_ABORTED : "proxy stream destroyed",
  };
}
