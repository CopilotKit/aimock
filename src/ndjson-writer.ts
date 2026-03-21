/**
 * NDJSON streaming writer for Ollama endpoints.
 *
 * Mirrors writeSSEStream from sse-writer.ts but writes newline-delimited JSON
 * (one JSON object per line) instead of SSE events.
 */

import type * as http from "node:http";
import type { StreamingProfile } from "./types.js";
import { delay, calculateDelay } from "./sse-writer.js";

export interface NDJSONStreamOptions {
  latency?: number;
  streamingProfile?: StreamingProfile;
  signal?: AbortSignal;
  onChunkSent?: () => void;
}

export async function writeNDJSONStream(
  res: http.ServerResponse,
  chunks: object[],
  options?: NDJSONStreamOptions,
): Promise<boolean> {
  const opts = options ?? {};
  const latency = opts.latency ?? 0;
  const profile = opts.streamingProfile;
  const signal = opts.signal;
  const onChunkSent = opts.onChunkSent;

  if (res.writableEnded) return true;
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  let chunkIndex = 0;
  for (const chunk of chunks) {
    const chunkDelay = calculateDelay(chunkIndex, profile, latency);
    if (chunkDelay > 0) {
      await delay(chunkDelay, signal);
    }
    if (signal?.aborted) return false;
    if (res.writableEnded) return true;
    res.write(JSON.stringify(chunk) + "\n");
    onChunkSent?.();
    if (signal?.aborted) return false;
    chunkIndex++;
  }

  if (!res.writableEnded) {
    res.end();
  }
  return true;
}
