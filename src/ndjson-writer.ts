/**
 * NDJSON streaming writer for Ollama endpoints.
 *
 * Mirrors writeSSEStream from sse-writer.ts but writes newline-delimited JSON
 * (one JSON object per line) instead of SSE events.
 */

import type * as http from "node:http";
import type { StreamingProfile, RecordedTimings } from "./types.js";
import { httpSink, runFrameLoop, type FrameCodec } from "./response/frame-loop.js";

export interface NDJSONStreamOptions {
  latency?: number;
  streamingProfile?: StreamingProfile;
  recordedTimings?: RecordedTimings;
  replaySpeed?: number;
  signal?: AbortSignal;
  onChunkSent?: () => void;
}

export async function writeNDJSONStream(
  res: http.ServerResponse,
  chunks: object[],
  options?: NDJSONStreamOptions,
): Promise<boolean> {
  const opts = options ?? {};
  // Base contract (public API): with no frames, an aborted signal does not
  // stop the writer; it still finishes the stream (any trailer, then end())
  // and returns true. The frame loop returns false there, so pass it no
  // signal when there are no frames (it reads the signal only per frame and
  // after the loop).
  return runFrameLoop(
    httpSink(res),
    chunks,
    ndjsonCodec(),
    {
      latency: opts.latency,
      streamingProfile: opts.streamingProfile,
      recordedTimings: opts.recordedTimings,
      replaySpeed: opts.replaySpeed,
    },
    { signal: chunks.length > 0 ? opts.signal : undefined, onChunkSent: opts.onChunkSent },
  );
}

// Internal (not part of the public API): newline-delimited JSON, one object
// per line, no trailer (Ollama). Line comments, not JSDoc, so the bundled
// .d.ts does not attach this comment to a public declaration.
export function ndjsonCodec<F = object>(): FrameCodec<F> {
  return {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
    encode: (frame) => JSON.stringify(frame) + "\n",
  };
}
