import type * as http from "node:http";
import type { SSEChunk, StreamingProfile, RecordedTimings } from "./types.js";
import { httpSink, runFrameLoop, type FrameCodec } from "./response/frame-loop.js";

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    // Remove the abort listener when the timer fires, so a long stream sharing
    // one lifecycle signal does not keep one listener per delayed frame.
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface StreamOptions {
  latency?: number;
  streamingProfile?: StreamingProfile;
  recordedTimings?: RecordedTimings;
  replaySpeed?: number;
  signal?: AbortSignal;
  onChunkSent?: () => void;
  /** When set, emitted as the final chunk before [DONE] (OpenAI stream_options.include_usage). */
  usageChunk?: SSEChunk;
  /**
   * When true, a single OpenRouter `: OPENROUTER PROCESSING` SSE comment
   * (keepalive) line is emitted FIRST — before the first data chunk — matching
   * real OpenRouter bytes (or-capture/chat-stream.sse). A faithful client skips
   * `:`-prefixed lines; opt-in, default off (so strict OpenAI parsers aren't
   * surprised). Used only by the OpenRouter chat surface.
   */
  openRouterProcessing?: boolean;
}

/** OpenRouter's SSE keepalive comment line (colon-prefixed, per SSE syntax). */
const OPENROUTER_PROCESSING_COMMENT = ": OPENROUTER PROCESSING\n\n";

export function calculateDelay(
  chunkIndex: number,
  profile?: StreamingProfile,
  fallbackLatency?: number,
  recordedTimings?: RecordedTimings,
  replaySpeed?: number,
): number {
  const speed = replaySpeed ?? 1.0;
  let delayMs: number;

  if (profile) {
    // StreamingProfile has highest precedence
    let fromProfile = true;
    if (chunkIndex === 0 && profile.ttft !== undefined) {
      delayMs = profile.ttft;
    } else if (profile.tps !== undefined && profile.tps > 0) {
      delayMs = 1000 / profile.tps;
    } else {
      delayMs = fallbackLatency ?? 0;
      fromProfile = false;
    }
    // Jitter only applies when the delay came from ttft/tps, not fallback
    if (fromProfile && profile.jitter && profile.jitter > 0) {
      delayMs *= 1 + (Math.random() * 2 - 1) * profile.jitter;
      if (delayMs < 0) delayMs = 0;
    }
  } else if (recordedTimings) {
    // Recorded timings (second precedence)
    if (chunkIndex === 0) {
      delayMs = recordedTimings.ttftMs;
    } else {
      const idx = chunkIndex - 1;
      if (idx < recordedTimings.interChunkDelaysMs.length) {
        delayMs = recordedTimings.interChunkDelaysMs[idx];
      } else {
        // Excess chunks: derive average from recorded inter-chunk delays
        const totalInterChunk = recordedTimings.interChunkDelaysMs.reduce((a, b) => a + b, 0);
        delayMs =
          recordedTimings.interChunkDelaysMs.length > 0
            ? totalInterChunk / recordedTimings.interChunkDelaysMs.length
            : 0;
      }
    }
  } else {
    delayMs = fallbackLatency ?? 0;
  }

  delayMs = Math.max(0, delayMs);
  return speed > 0 ? delayMs / speed : delayMs;
}

// Internal (not part of the public API): the total wait before a non-streaming
// (`stream: false`) JSON response is written. Sums calculateDelay over the
// content chunk count that `contentLength` at `chunkSize` would produce, so a
// fixture with an explicit `streamingProfile` or `recordedTimings` pays roughly
// the same ttft/tps cost as its streamed content chunks. It is an
// approximation, not an exact match: a streamed reply also pays delays for its
// role and finish chunks. There is deliberately no fallback-latency parameter:
// bare `latency` / `--latency` is an inter-SSE-chunk gap and never delays a
// non-streaming response. With neither a profile nor recorded timings, this
// returns 0.
// Kept as a line comment, not JSDoc: the bundled .d.ts drops this non-public
// declaration but keeps a JSDoc block, which would then attach to writeSSEStream.
export function calculateTotalDelay(
  contentLength: number,
  chunkSize: number,
  profile?: StreamingProfile,
  recordedTimings?: RecordedTimings,
  replaySpeed?: number,
): number {
  const chunkCount = Math.max(1, Math.ceil(contentLength / chunkSize));
  let total = 0;
  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
    total += calculateDelay(chunkIndex, profile, undefined, recordedTimings, replaySpeed);
  }
  return total;
}

export async function writeSSEStream(
  res: http.ServerResponse,
  chunks: SSEChunk[],
  optionsOrLatency?: number | StreamOptions,
): Promise<boolean> {
  const opts: StreamOptions =
    typeof optionsOrLatency === "number" ? { latency: optionsOrLatency } : (optionsOrLatency ?? {});
  // No lifecycle: an external caller gets close-awareness only through its own
  // `signal` (a gone client still returns true).
  // Base contract (public API): with no frames, an aborted signal does not
  // stop the writer; it still finishes the stream (any trailer, then end())
  // and returns true. The frame loop returns false there, so pass it no
  // signal when there are no frames (it reads the signal only per frame and
  // after the loop).
  return runFrameLoop(
    httpSink(res),
    chunks,
    sseCodec({
      done: true,
      usageChunk: opts.usageChunk,
      openRouterProcessing: opts.openRouterProcessing,
    }),
    {
      latency: opts.latency,
      streamingProfile: opts.streamingProfile,
      recordedTimings: opts.recordedTimings,
      replaySpeed: opts.replaySpeed,
    },
    { signal: chunks.length > 0 ? opts.signal : undefined, onChunkSent: opts.onChunkSent },
  );
}

const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
};

// Internal (not part of the public API): data-only SSE (`data: <json>\n\n`).
// `done: true` writes the optional usage chunk then `data: [DONE]` after the
// last frame (OpenAI chat); `done: false` writes no trailer.
// `openRouterProcessing` writes the OpenRouter keepalive comment first. Line
// comments, not JSDoc: see calculateTotalDelay.
export function sseCodec<F = SSEChunk>(opts: {
  done: boolean;
  usageChunk?: SSEChunk;
  openRouterProcessing?: boolean;
}): FrameCodec<F> {
  return {
    headers: SSE_HEADERS,
    ...(opts.openRouterProcessing ? { prelude: () => OPENROUTER_PROCESSING_COMMENT } : {}),
    encode: (frame) => `data: ${JSON.stringify(frame)}\n\n`,
    trailer: () => {
      if (!opts.done) return [];
      const parts: string[] = [];
      if (opts.usageChunk) parts.push(`data: ${JSON.stringify(opts.usageChunk)}\n\n`);
      parts.push("data: [DONE]\n\n");
      return parts;
    },
  };
}

// Internal: typed SSE (`event: <type>\ndata: <json>\n\n`), used by Anthropic.
// `terminalSentinel` writes `data: [DONE]` after the last frame, only when the
// stream was not aborted.
export function typedSseCodec<F extends { type: string }>(opts?: {
  terminalSentinel?: boolean;
}): FrameCodec<F> {
  return {
    headers: SSE_HEADERS,
    encode: (frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`,
    trailer: () => (opts?.terminalSentinel ? ["data: [DONE]\n\n"] : []),
  };
}

/**
 * Default rate-limit response headers matching OpenAI's format.
 * Values are static — aimock doesn't track actual request counts.
 */
const RATE_LIMIT_HEADERS: Record<string, string> = {
  "x-ratelimit-limit-requests": "60",
  "x-ratelimit-limit-tokens": "150000",
  "x-ratelimit-remaining-requests": "0",
  "x-ratelimit-remaining-tokens": "0",
  "x-ratelimit-reset-requests": "1s",
  "x-ratelimit-reset-tokens": "6m0s",
};

export interface ErrorResponseOptions {
  /** Override the Retry-After header value (seconds). Default: 1. Only applied on 429. */
  retryAfter?: number;
}

export function writeErrorResponse(
  res: http.ServerResponse,
  status: number,
  body: string,
  options?: ErrorResponseOptions,
): void {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (status === 429) {
    headers["Retry-After"] = String(options?.retryAfter ?? 1);
    Object.assign(headers, RATE_LIMIT_HEADERS);
  }
  res.writeHead(status, headers);
  res.end(body);
}
