import type * as http from "node:http";
import type { RecordedTimings, StreamingProfile } from "../types.js";
import type { WebSocketConnection } from "../ws-framing.js";
import { calculateDelay, delay } from "../sse-writer.js";
import type { DeliveryLifecycle } from "./lifecycle.js";

/**
 * How one wire frames a stream. The frame loop is the same for every wire;
 * only these parts differ.
 */
export interface FrameCodec<F> {
  /** Response headers, set before the first write (skipped if the response already ended). */
  headers: Record<string, string>;
  /** Written once before the first frame, when it returns a value (the OpenRouter keepalive in `sseCodec`). */
  prelude?: () => string | Buffer | undefined;
  /** The bytes for one frame. */
  encode(frame: F): string | Buffer;
  /**
   * Whether a frame advances the chunk index and the fixture tick (default
   * true). A frame that does not count still pays the delay at the current
   * index.
   */
  counts?(frame: F): boolean;
  /**
   * Written after the last frame, before `end()`, when the response has not
   * ended. Only a completed delivery reaches it: an aborted one returns `false`
   * with no trailer and no `end()`, so `aborted` is always `false` here.
   */
  trailer?(aborted: boolean): Array<string | Buffer>;
  /** Send the head with `writeHead` up front instead of `setHeader`. */
  writeHeadImmediately?: boolean;
  /**
   * Check `sink.gone()` before each delay as well as after it, with or
   * without a lifecycle, and return `false` when gone.
   */
  checkGoneBeforeDelay?: boolean;
}

/**
 * Where frames go: an HTTP response or a WebSocket connection. A sink with no
 * HTTP head (WebSocket) omits `setHeader` and `writeHead`; asking such a sink
 * for a status (`status` or `writeHeadImmediately`) is a programming error.
 */
export interface FrameSink {
  gone(): boolean;
  writableEnded(): boolean;
  write(chunk: string | Buffer): void;
  end(): void;
  /** Whether the head was already committed (HTTP only). */
  headersSent?(): boolean;
  setHeader?(name: string, value: string): void;
  writeHead?(status: number, headers: Record<string, string>): void;
}

/** Per-frame delay inputs, passed straight to `calculateDelay`. */
export interface FrameTiming {
  latency?: number;
  streamingProfile?: StreamingProfile;
  recordedTimings?: RecordedTimings;
  replaySpeed?: number;
}

interface FrameLoopCommonOptions {
  onChunkSent?: () => void;
  /** When given, `writeHead(status, headers)` is sent before the first frame. */
  status?: number;
  /** Extra headers, merged over the codec's headers. */
  headers?: Record<string, string>;
}

/**
 * The stop source is a `lifecycle` or a bare `signal`, never both: passing both
 * is a programming error and rejects with a `TypeError`.
 */
export type FrameLoopOptions = FrameLoopCommonOptions &
  (
    | {
        /**
         * Its signal stops the loop and `sink.gone()` is checked next to every
         * abort check.
         */
        lifecycle: DeliveryLifecycle;
        signal?: never;
      }
    | {
        lifecycle?: never;
        /**
         * Without a lifecycle, `signal` stops the loop, and a gone sink stops it
         * only when the codec sets `checkGoneBeforeDelay`.
         */
        signal?: AbortSignal;
      }
  );

/** An HTTP response as a frame sink. Gone means destroyed. */
export function httpSink(res: http.ServerResponse): FrameSink {
  return {
    gone: () => res.destroyed,
    writableEnded: () => res.writableEnded,
    headersSent: () => res.headersSent,
    write: (chunk) => {
      res.write(chunk);
    },
    end: () => {
      res.end();
    },
    setHeader: (name, value) => {
      res.setHeader(name, value);
    },
    writeHead: (status, headers) => {
      res.writeHead(status, headers);
    },
  };
}

/** A WebSocket connection as a frame sink. Gone means closed; it never ends. */
export function wsSink(ws: WebSocketConnection): FrameSink {
  return {
    gone: () => ws.isClosed,
    writableEnded: () => false,
    write: (chunk) => {
      ws.send(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    },
    end: () => {},
  };
}

/**
 * The shared streaming loop. Per frame, in order: gone check (with
 * `checkGoneBeforeDelay`) → `calculateDelay` → `delay(d, signal)` → abort
 * check → gone check (with `checkGoneBeforeDelay`) → `writableEnded` (return
 * `true`) → write → advance the index and tick (counting frames only) → abort
 * re-check. After the last frame the trailer and `end()` run if the response
 * has not ended. Returns `false` when stopped by an abort, or by a gone sink
 * (with a lifecycle or `checkGoneBeforeDelay`), including an abort before the
 * first frame or with no frames, and `true` otherwise. Rejects with a
 * `TypeError` when given both a lifecycle and a signal, or a status for a sink
 * without `writeHead`.
 *
 * With a lifecycle, a response that other code already answered is not a
 * completed delivery: an ended response (at entry or at the `writableEnded`
 * check) returns `false`, and so does a head already committed at entry,
 * which `setHeader`/`writeHead` would reject with `ERR_HTTP_HEADERS_SENT`.
 * Without a lifecycle (the exported writers) an ended response still returns
 * `true`, as base did.
 */
export async function runFrameLoop<F>(
  sink: FrameSink,
  frames: readonly F[],
  codec: FrameCodec<F>,
  timing: FrameTiming,
  opts: FrameLoopOptions = {},
): Promise<boolean> {
  const { lifecycle } = opts;
  if (lifecycle !== undefined && opts.signal !== undefined) {
    throw new TypeError("runFrameLoop: pass a lifecycle or a signal, not both");
  }
  const signal = lifecycle?.signal ?? opts.signal;
  const stopped = (): boolean =>
    signal?.aborted === true || (lifecycle !== undefined && sink.gone());

  // With a lifecycle, a response that other code answered is not a completed delivery.
  const endedIsCompleted = lifecycle === undefined;
  if (sink.writableEnded()) return endedIsCompleted;
  if (lifecycle && sink.gone()) return false;
  if (lifecycle && sink.headersSent?.() === true) return false;

  const headers =
    opts.headers === undefined ? codec.headers : { ...codec.headers, ...opts.headers };
  if (opts.status !== undefined || codec.writeHeadImmediately) {
    if (!sink.writeHead) {
      throw new TypeError("runFrameLoop: a status was requested but the sink has no writeHead");
    }
    sink.writeHead(opts.status ?? 200, headers);
  } else if (sink.setHeader) {
    for (const [name, value] of Object.entries(headers)) sink.setHeader(name, value);
  }

  if (codec.prelude && !sink.writableEnded()) {
    const prelude = codec.prelude();
    if (prelude !== undefined) sink.write(prelude);
  }

  let chunkIndex = 0;
  for (const frame of frames) {
    if (codec.checkGoneBeforeDelay && sink.gone()) return false;
    const chunkDelay = calculateDelay(
      chunkIndex,
      timing.streamingProfile,
      timing.latency ?? 0,
      timing.recordedTimings,
      timing.replaySpeed,
    );
    if (chunkDelay > 0) await delay(chunkDelay, signal);
    if (stopped()) return false;
    if (codec.checkGoneBeforeDelay && sink.gone()) return false;
    if (sink.writableEnded()) return endedIsCompleted;
    sink.write(codec.encode(frame));
    if (codec.counts?.(frame) !== false) {
      chunkIndex++;
      opts.onChunkSent?.();
    }
    if (stopped()) return false;
  }

  // An abort the loop never observed (no frames) still stops the delivery.
  if (stopped()) return false;
  if (!sink.writableEnded()) {
    for (const part of codec.trailer?.(false) ?? []) sink.write(part);
    sink.end();
  }
  return true;
}
