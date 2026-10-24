import type * as http from "node:http";
import type { Fixture, JournalEntry, RecordedTimings } from "../types.js";
import { delay } from "../sse-writer.js";
import { httpSink, runFrameLoop, type FrameCodec, type FrameTiming } from "./frame-loop.js";
import { responseGoneReason } from "../chaos.js";
import {
  AIMOCK_DISCONNECTED,
  closedByClient,
  httpLifecycle,
  markInterrupted,
  noteDeliveryStart,
  statusLineSent,
  teardownReason,
  requestSocket,
  type DeliveryLifecycle,
} from "./lifecycle.js";
import {
  extendRecordedTimings,
  nonStreamingDelayMs,
  nonStreamingRecordedTimings,
  nonStreamingTimingEnabled,
  type NonStreamingSurface,
} from "./timing.js";

/** The lifecycle fields the teardown journal reads. */
type TeardownSource = Pick<DeliveryLifecycle, "cause" | "reason">;

/**
 * Journal a delivery that ended early. The reason is always set: the
 * lifecycle's first cause when it fired, else {@link teardownReason} for the
 * response that is gone. When no byte of the response reached the socket
 * ({@link statusLineSent}), the status is 0, the rule the server and the
 * chaos `disconnect` apply to a torn socket. A fixture interruption
 * (`disconnectAfterMs`, `truncateAfterChunks`) keeps the status it was
 * journaled with, as base recorded it.
 */
function journalTeardown(
  entry: JournalEntry,
  res: http.ServerResponse,
  lifecycle: TeardownSource | undefined,
): void {
  markInterrupted(entry, lifecycle?.reason() ?? teardownReason(res));
  if (lifecycle?.cause() !== "fixture" && !statusLineSent(res)) entry.response.status = 0;
}

/**
 * Whether the response was torn down: the lifecycle fired, the response is
 * destroyed or chaos disconnected it, or the client closed the socket.
 */
function tornDown(res: http.ServerResponse, lifecycle: TeardownSource | undefined): boolean {
  const socket = requestSocket(res);
  const gone = responseGoneReason(res);
  return (
    lifecycle?.reason() !== undefined ||
    gone === "client-gone" ||
    gone === "chaos-disconnected" ||
    (!res.writableEnded && !!socket && closedByClient(socket))
  );
}

/**
 * Journal a response that something else on aimock's side already answered
 * (head committed or body ended) as aimock's teardown, with the status the
 * client actually got.
 */
function journalAnsweredElsewhere(entry: JournalEntry, res: http.ServerResponse): void {
  markInterrupted(entry, AIMOCK_DISCONNECTED);
  entry.response.status = statusLineSent(res) ? res.statusCode : 0;
}

/**
 * Whether `deliverJson` can no longer write its reply, journaling why when it
 * cannot. Torn down ({@link tornDown}): {@link journalTeardown}. Already
 * answered by something else on aimock's side (head committed or body
 * ended): writing again would throw `ERR_HTTP_HEADERS_SENT`, so it is
 * journaled by {@link journalAnsweredElsewhere}, and a body that never ended
 * is destroyed so the client does not hang.
 */
function journalUnwritable(
  entry: JournalEntry,
  res: http.ServerResponse,
  lifecycle: TeardownSource | undefined,
): boolean {
  if (tornDown(res, lifecycle)) {
    journalTeardown(entry, res, lifecycle);
    return true;
  }
  if (res.headersSent || res.writableEnded) {
    journalAnsweredElsewhere(entry, res);
    if (!res.writableEnded) res.destroy();
    return true;
  }
  return false;
}

/**
 * Deliver one streamed reply and journal how it ended. Builds the HTTP
 * lifecycle (client close + fixture interruption) and runs the frame loop on
 * it. When the loop stops early it destroys `res` (if it has not ended) and
 * marks the entry with the first cause's reason (or, when no cause fired, who
 * tore the response down). A response other code already answered (head
 * committed before the stream, or body ended) is journaled as
 * {@link deliverJson} journals it. It disposes the lifecycle on every path.
 */
export async function deliverStream<F>(
  res: http.ServerResponse,
  entry: JournalEntry,
  fixture: Fixture,
  codec: FrameCodec<F>,
  frames: readonly F[],
  timing: FrameTiming,
  opts?: {
    status?: number; // When set, sent with `writeHead` before the first frame (issue #549).
    headers?: Record<string, string>; // Merged over the codec's headers (issue #549).
  },
): Promise<void> {
  noteDeliveryStart(res);
  const headSentBefore = res.headersSent;
  const lifecycle = httpLifecycle(res, fixture, { streaming: true });
  try {
    const completed = await runFrameLoop(httpSink(res), frames, codec, timing, {
      lifecycle,
      onChunkSent: lifecycle.tick,
      status: opts?.status,
      headers: opts?.headers,
    });
    if (!completed) {
      // Read before the destroy below, which makes any response look torn down.
      const answeredElsewhere = (headSentBefore || res.writableEnded) && !tornDown(res, lifecycle);
      if (!res.writableEnded) res.destroy();
      if (answeredElsewhere) journalAnsweredElsewhere(entry, res);
      else journalTeardown(entry, res, lifecycle);
    }
  } finally {
    lifecycle.dispose();
  }
}

export interface DeliverJsonOptions {
  /**
   * Passed to `nonStreamingTimingEnabled` and `nonStreamingRecordedTimings`:
   * OpenAI chat, or any other provider.
   */
  surface: NonStreamingSurface;
  status?: number; // The response status, 200 when unset (issue #549).
  headers?: Record<string, string>; // Merged over the JSON `Content-Type` header (issue #549).
  /** The served payload length the wait is sized from. */
  payloadLength: number;
  /**
   * The wait is sized in chunks of this many characters. Callers pass
   * `Math.max(1, <fixture or server chunkSize>)`: 1 or more, or `NaN` for a
   * non-numeric value. `NaN` gives a zero wait.
   */
  chunkSize: number;
  recordedTimings?: RecordedTimings;
  /** A K4 duplicate-id plan: extend the recorded gaps before sizing the wait. */
  duplicateId?: boolean;
  replaySpeed?: number;
}

/**
 * Deliver one non-streaming JSON reply. The body is a thunk.
 *
 * On both paths it first checks {@link journalUnwritable}, before any wait. A
 * response that can no longer take the reply (torn down, or already answered)
 * is not written, the thunk is never called, and the entry is marked
 * interrupted. An already-answered response whose body never ended is
 * destroyed, so the client does not hang.
 *
 * With non-streaming timing off (the default) it then runs
 * `JSON.stringify(body())`, then `writeHead`, then `end`: the body is built
 * before anything is written, so a builder that throws leaves the response
 * unwritten.
 *
 * With timing on, it waits the non-streaming delay on the client's close
 * signal, checks {@link journalUnwritable} again (the response can be torn
 * down or answered during the wait), then runs the thunk, so a `created`
 * timestamp reflects the write time.
 *
 * Rejects with a `RangeError` when `chunkSize` is a number below 1: that is
 * a programming error, and the delay math divides by it. No user input reaches
 * it, because every caller clamps with `Math.max(1, ...)`. A user value that
 * is not a number clamps to `NaN`: the reply is still served, with a zero
 * wait when timing is on.
 */
export async function deliverJson(
  res: http.ServerResponse,
  entry: JournalEntry,
  fixture: Fixture,
  body: () => unknown,
  opts: DeliverJsonOptions,
): Promise<void> {
  if (opts.chunkSize < 1) {
    throw new RangeError(`deliverJson: chunkSize must be >= 1, got ${opts.chunkSize}`);
  }
  const write = (): void => {
    const text = JSON.stringify(body());
    res.writeHead(opts.status ?? 200, { "Content-Type": "application/json", ...opts.headers });
    res.end(text);
  };
  noteDeliveryStart(res);
  // Checked before the lifecycle and the wait on both paths: a response that
  // cannot take the reply is journaled at once, with no wait.
  if (journalUnwritable(entry, res, undefined)) return;
  if (!nonStreamingTimingEnabled(fixture, opts.surface)) {
    write();
    return;
  }
  const lifecycle = httpLifecycle(res, fixture, { streaming: false });
  try {
    const fixtureTimings = nonStreamingRecordedTimings(fixture, opts.surface, opts.recordedTimings);
    const recordedTimings = opts.duplicateId
      ? extendRecordedTimings(
          fixtureTimings,
          Math.max(1, Math.ceil(opts.payloadLength / opts.chunkSize)),
          true,
        )
      : fixtureTimings;
    await delay(
      nonStreamingDelayMs(
        fixture,
        opts.payloadLength,
        opts.chunkSize,
        recordedTimings,
        opts.replaySpeed,
      ),
      lifecycle.signal,
    );
    if (journalUnwritable(entry, res, lifecycle)) return;
    write();
  } finally {
    lifecycle.dispose();
  }
}
