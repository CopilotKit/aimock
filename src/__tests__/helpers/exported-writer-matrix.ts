import type * as http from "node:http";
import type { writeSSEStream } from "../../sse-writer.js";
import type { writeNDJSONStream } from "../../ndjson-writer.js";
import type { writeEventStream } from "../../aws-event-stream.js";
import type { SSEChunk } from "../../types.js";

/**
 * Edge-case matrix for the PUBLIC exported stream writers. Each case drives a
 * writer against a recording response and captures everything a caller can
 * observe: the bytes written, the headers set, the return value,
 * `writableEnded`, and how often `end()` was called. The base-contract test
 * pins the result of every case to the pre-foundation (508dd9b9) behavior.
 */

export interface ExportedWriters {
  writeSSEStream: typeof writeSSEStream;
  writeNDJSONStream: typeof writeNDJSONStream;
  writeEventStream: typeof writeEventStream;
}

export interface WriterObservation {
  returned: boolean;
  /** Written bytes as hex (the event stream is binary). */
  bytes: string;
  headers: Record<string, string>;
  writableEnded: boolean;
  endCalls: number;
  writeHeadCalls: number;
}

interface RecordingResponse {
  res: http.ServerResponse;
  /** Mark the response ended from outside the writer (no `end()` call). */
  endExternally(): void;
  observe(returned: boolean): WriterObservation;
}

interface ResponseSetup {
  endedBefore?: boolean;
  destroyed?: boolean;
  /** Omit `writeHead` from the response, as a bare stand-in might. */
  noWriteHead?: boolean;
}

function recordingResponse(setup: ResponseSetup = {}): RecordingResponse {
  const parts: Buffer[] = [];
  const headers: Record<string, string> = {};
  let ended = setup.endedBefore === true;
  let endCalls = 0;
  let writeHeadCalls = 0;
  const target: Record<string, unknown> = {
    destroyed: setup.destroyed === true,
    setHeader(name: string, value: string) {
      headers[name] = String(value);
    },
    write(chunk: string | Buffer) {
      parts.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk));
      return true;
    },
    end(chunk?: string | Buffer) {
      endCalls++;
      if (chunk !== undefined) {
        parts.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk));
      }
      ended = true;
    },
  };
  if (!setup.noWriteHead) {
    target.writeHead = (_status: number, hs?: Record<string, string>) => {
      writeHeadCalls++;
      if (hs) for (const [k, v] of Object.entries(hs)) headers[k] = String(v);
    };
  }
  Object.defineProperty(target, "writableEnded", { get: () => ended });
  const res = target as unknown as http.ServerResponse;
  return {
    res,
    endExternally: () => {
      ended = true;
    },
    observe: (returned) => ({
      returned,
      bytes: Buffer.concat(parts).toString("hex"),
      headers: { ...headers },
      writableEnded: ended,
      endCalls,
      writeHeadCalls,
    }),
  };
}

type WriterName = "sse" | "ndjson" | "eventStream";

interface CaseContext {
  signal: AbortSignal;
  abort(): void;
  endExternally(): void;
}

interface MatrixCase {
  name: string;
  writer: WriterName;
  frames: number;
  setup?: ResponseSetup;
  abortBefore?: boolean;
  /** Options built per run; may hook `onChunkSent` to act mid-stream. */
  options?: (ctx: CaseContext) => {
    latency?: number;
    signal?: AbortSignal;
    onChunkSent?: () => void;
    usageChunk?: SSEChunk;
    openRouterProcessing?: boolean;
  };
  /** Act asynchronously while the writer is waiting (ms after start). */
  during?: { afterMs: number; act: (ctx: CaseContext) => void };
  /** Pass the legacy numeric latency argument (SSE only). */
  numericLatency?: number;
}

function sseChunk(i: number): SSEChunk {
  return {
    id: "c",
    object: "chat.completion.chunk",
    created: 1,
    model: "m",
    choices: [{ index: 0, delta: { content: `t${i}` }, logprobs: null, finish_reason: null }],
  };
}

const USAGE: SSEChunk = {
  id: "c",
  object: "chat.completion.chunk",
  created: 1,
  model: "m",
  choices: [],
  usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
};

function onNth(n: number, act: () => void): () => void {
  let sent = 0;
  return () => {
    sent++;
    if (sent === n) act();
  };
}

function casesFor(writer: WriterName): MatrixCase[] {
  const cases: MatrixCase[] = [
    { name: "empty frames", writer, frames: 0 },
    { name: "two frames", writer, frames: 2 },
    { name: "two frames, latency", writer, frames: 2, options: () => ({ latency: 1 }) },
    {
      name: "empty frames, signal aborted before",
      writer,
      frames: 0,
      abortBefore: true,
      options: (c) => ({ signal: c.signal }),
    },
    {
      name: "two frames, signal aborted before",
      writer,
      frames: 2,
      abortBefore: true,
      options: (c) => ({ signal: c.signal }),
    },
    {
      name: "two frames, signal aborted before, latency",
      writer,
      frames: 2,
      abortBefore: true,
      options: (c) => ({ signal: c.signal, latency: 5 }),
    },
    {
      name: "two frames, abort after first frame",
      writer,
      frames: 2,
      options: (c) => ({ signal: c.signal, onChunkSent: onNth(1, c.abort) }),
    },
    {
      name: "two frames, abort after last frame",
      writer,
      frames: 2,
      options: (c) => ({ signal: c.signal, onChunkSent: onNth(2, c.abort) }),
    },
    {
      name: "two frames, abort during delay",
      writer,
      frames: 2,
      options: (c) => ({ signal: c.signal, latency: 40 }),
      during: { afterMs: 10, act: (c) => c.abort() },
    },
    { name: "empty frames, ended before", writer, frames: 0, setup: { endedBefore: true } },
    { name: "two frames, ended before", writer, frames: 2, setup: { endedBefore: true } },
    {
      name: "empty frames, ended before, signal aborted",
      writer,
      frames: 0,
      setup: { endedBefore: true },
      abortBefore: true,
      options: (c) => ({ signal: c.signal }),
    },
    {
      name: "two frames, ended after first frame",
      writer,
      frames: 2,
      options: (c) => ({ onChunkSent: onNth(1, c.endExternally) }),
    },
    {
      name: "two frames, ended after last frame",
      writer,
      frames: 2,
      options: (c) => ({ onChunkSent: onNth(2, c.endExternally) }),
    },
    {
      name: "two frames, ended during delay",
      writer,
      frames: 2,
      options: () => ({ latency: 40 }),
      during: { afterMs: 10, act: (c) => c.endExternally() },
    },
    { name: "empty frames, destroyed", writer, frames: 0, setup: { destroyed: true } },
    { name: "two frames, destroyed", writer, frames: 2, setup: { destroyed: true } },
    { name: "two frames, no writeHead", writer, frames: 2, setup: { noWriteHead: true } },
    {
      name: "empty frames, no writeHead, signal aborted",
      writer,
      frames: 0,
      setup: { noWriteHead: true },
      abortBefore: true,
      options: (c) => ({ signal: c.signal }),
    },
  ];
  if (writer === "sse") {
    cases.push(
      { name: "numeric latency", writer, frames: 2, numericLatency: 1 },
      {
        name: "usage + openRouterProcessing",
        writer,
        frames: 1,
        options: () => ({ usageChunk: USAGE, openRouterProcessing: true }),
      },
      {
        name: "empty frames, usage + openRouterProcessing, signal aborted before",
        writer,
        frames: 0,
        abortBefore: true,
        options: (c) => ({ signal: c.signal, usageChunk: USAGE, openRouterProcessing: true }),
      },
      {
        name: "openRouterProcessing, ended before",
        writer,
        frames: 1,
        setup: { endedBefore: true },
        options: () => ({ openRouterProcessing: true }),
      },
      {
        name: "usage, abort after last frame",
        writer,
        frames: 1,
        options: (c) => ({ signal: c.signal, usageChunk: USAGE, onChunkSent: onNth(1, c.abort) }),
      },
    );
  }
  return cases;
}

export const MATRIX_CASES: readonly MatrixCase[] = [
  ...casesFor("sse"),
  ...casesFor("ndjson"),
  ...casesFor("eventStream"),
];

export function caseId(c: MatrixCase): string {
  return `${c.writer}: ${c.name}`;
}

export async function runCase(writers: ExportedWriters, c: MatrixCase): Promise<WriterObservation> {
  const rec = recordingResponse(c.setup);
  const controller = new AbortController();
  const ctx: CaseContext = {
    signal: controller.signal,
    abort: () => controller.abort(),
    endExternally: rec.endExternally,
  };
  if (c.abortBefore) controller.abort();
  const opts = c.options?.(ctx) ?? {};
  const timer = c.during ? setTimeout(() => c.during?.act(ctx), c.during.afterMs) : undefined;
  let returned: boolean;
  try {
    if (c.writer === "sse") {
      const chunks = Array.from({ length: c.frames }, (_, i) => sseChunk(i));
      returned =
        c.numericLatency !== undefined
          ? await writers.writeSSEStream(rec.res, chunks, c.numericLatency)
          : await writers.writeSSEStream(rec.res, chunks, opts);
    } else if (c.writer === "ndjson") {
      const chunks = Array.from({ length: c.frames }, (_, i) => ({ i, done: false }));
      returned = await writers.writeNDJSONStream(rec.res, chunks, opts);
    } else {
      const events = Array.from({ length: c.frames }, (_, i) => ({
        eventType: "contentBlockDelta",
        payload: { i },
      }));
      returned = await writers.writeEventStream(rec.res, events, opts);
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
  return rec.observe(returned);
}
