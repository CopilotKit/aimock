import type * as http from "node:http";
import type { SSEChunk, StreamingProfile, RecordedTimings } from "./types.js";

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
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
}

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

export async function writeSSEStream(
  res: http.ServerResponse,
  chunks: SSEChunk[],
  optionsOrLatency?: number | StreamOptions,
): Promise<boolean> {
  const opts: StreamOptions =
    typeof optionsOrLatency === "number" ? { latency: optionsOrLatency } : (optionsOrLatency ?? {});
  const latency = opts.latency ?? 0;
  const profile = opts.streamingProfile;
  const { recordedTimings, replaySpeed } = opts;
  const signal = opts.signal;
  const onChunkSent = opts.onChunkSent;

  if (res.writableEnded) return true;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  let chunkIndex = 0;
  for (const chunk of chunks) {
    const chunkDelay = calculateDelay(chunkIndex, profile, latency, recordedTimings, replaySpeed);
    if (chunkDelay > 0) {
      await delay(chunkDelay, signal);
    }
    if (signal?.aborted) return false;
    if (res.writableEnded) return true;
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    onChunkSent?.();
    if (signal?.aborted) return false;
    chunkIndex++;
  }

  if (!res.writableEnded) {
    if (opts.usageChunk) {
      res.write(`data: ${JSON.stringify(opts.usageChunk)}\n\n`);
    }
    res.write("data: [DONE]\n\n");
    res.end();
  }
  return true;
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
