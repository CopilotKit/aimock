import type * as http from "node:http";
import type { SSEChunk } from "./types.js";

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
  signal?: AbortSignal;
  onChunkSent?: () => void;
}

export async function writeSSEStream(
  res: http.ServerResponse,
  chunks: SSEChunk[],
  optionsOrLatency?: number | StreamOptions,
): Promise<boolean> {
  const opts: StreamOptions =
    typeof optionsOrLatency === "number" ? { latency: optionsOrLatency } : (optionsOrLatency ?? {});
  const latency = opts.latency ?? 0;
  const signal = opts.signal;
  const onChunkSent = opts.onChunkSent;

  if (res.writableEnded) return true;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  for (const chunk of chunks) {
    if (latency > 0) {
      await delay(latency, signal);
    }
    if (signal?.aborted) return false;
    if (res.writableEnded) return true;
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    onChunkSent?.();
    if (signal?.aborted) return false;
  }

  if (!res.writableEnded) {
    res.write("data: [DONE]\n\n");
    res.end();
  }
  return true;
}

export function writeErrorResponse(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}
