import { EventEmitter } from "node:events";
import type * as http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  httpSink,
  runFrameLoop,
  wsSink,
  type FrameCodec,
  type FrameSink,
} from "../response/frame-loop.js";
import { httpLifecycle } from "../response/lifecycle.js";
import { sseCodec, typedSseCodec } from "../sse-writer.js";
import { ndjsonCodec } from "../ndjson-writer.js";
import { eventStreamCodec, encodeEventStreamMessage } from "../aws-event-stream.js";
import type { WebSocketConnection } from "../ws-framing.js";
import type { Fixture } from "../types.js";

type Op = Record<string, unknown>;

class FakeSink implements FrameSink {
  ops: Op[] = [];
  ended = false;
  isGone = false;
  gone(): boolean {
    return this.isGone;
  }
  writableEnded(): boolean {
    return this.ended;
  }
  write(chunk: string | Buffer): void {
    this.ops.push({ op: "write", chunk: Buffer.isBuffer(chunk) ? chunk.toString("hex") : chunk });
  }
  end(): void {
    this.ops.push({ op: "end" });
    this.ended = true;
  }
  setHeader(name: string, value: string): void {
    this.ops.push({ op: "setHeader", name, value });
  }
  writeHead(status: number, headers: Record<string, string>): void {
    this.ops.push({ op: "writeHead", status, headers });
  }
}

const textCodec: FrameCodec<string> = {
  headers: { "Content-Type": "text/plain" },
  encode: (frame) => `${frame}|`,
};

let timers: number[];
beforeEach(() => {
  vi.useFakeTimers();
  timers = [];
  const fake = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    fn: () => void,
    ms?: number,
    ...args: unknown[]
  ) => {
    timers.push(ms ?? 0);
    return fake(fn, ms, ...args);
  }) as unknown as typeof setTimeout);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/**
 * An array whose iteration is observable: `pulled` lists the frames the loop
 * took, and `exhausted()` tells whether it asked for one past the last.
 */
function trackedFrames(items: string[]): {
  frames: string[];
  pulled: string[];
  exhausted: () => boolean;
} {
  const pulled: string[] = [];
  let done = false;
  const frames = [...items];
  Object.defineProperty(frames, Symbol.iterator, {
    value: function* () {
      for (const item of items) {
        pulled.push(item);
        yield item;
      }
      done = true;
    },
  });
  return { frames, pulled, exhausted: () => done };
}

async function run<T>(promise: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return promise;
}

describe("runFrameLoop ordering", () => {
  it("sets headers, writes the prelude, then delays → writes each frame, then the trailer and end", async () => {
    const sink = new FakeSink();
    const codec: FrameCodec<string> = {
      ...textCodec,
      prelude: () => "P|",
      trailer: (aborted) => [`T${aborted ? "!" : ""}|`],
    };
    const ticks: number[] = [];
    const done = await run(
      runFrameLoop(sink, ["a", "b"], codec, { latency: 5 }, { onChunkSent: () => ticks.push(1) }),
    );
    expect(done).toBe(true);
    expect(sink.ops).toEqual([
      { op: "setHeader", name: "Content-Type", value: "text/plain" },
      { op: "write", chunk: "P|" },
      { op: "write", chunk: "a|" },
      { op: "write", chunk: "b|" },
      { op: "write", chunk: "T|" },
      { op: "end" },
    ]);
    expect(timers).toEqual([5, 5]);
    expect(ticks).toHaveLength(2);
  });

  it("returns true without writing when the sink already ended", async () => {
    const sink = new FakeSink();
    sink.ended = true;
    expect(await run(runFrameLoop(sink, ["a"], textCodec, {}))).toBe(true);
    expect(sink.ops).toEqual([]);
  });

  it("returns true at the writableEnded check after a delay, without the trailer", async () => {
    const sink = new FakeSink();
    const codec: FrameCodec<string> = { ...textCodec, trailer: () => ["T|"] };
    const promise = runFrameLoop(sink, ["a", "b"], codec, { latency: 5 });
    await vi.advanceTimersByTimeAsync(5);
    sink.ended = true;
    expect(await run(promise)).toBe(true);
    expect(sink.ops.filter((o) => o.op === "write")).toEqual([{ op: "write", chunk: "a|" }]);
  });

  it("does not advance the index or tick for frames that do not count", async () => {
    const sink = new FakeSink();
    const codec: FrameCodec<string> = { ...textCodec, counts: (f) => f.startsWith("d") };
    const ticks: string[] = [];
    await run(
      runFrameLoop(
        sink,
        ["start", "d1", "mid", "d2", "end"],
        codec,
        { recordedTimings: { ttftMs: 3, interChunkDelaysMs: [7, 11], totalDurationMs: 0 } },
        { onChunkSent: () => ticks.push("t") },
      ),
    );
    // start@0, d1@0, mid@1, d2@1, end@2: framing frames pay the current index.
    expect(timers).toEqual([3, 3, 7, 7, 11]);
    expect(ticks).toHaveLength(2);
  });

  it("stops on a signal abort with no write after it, returning false", async () => {
    const sink = new FakeSink();
    const controller = new AbortController();
    const codec: FrameCodec<string> = { ...textCodec, trailer: () => ["T|"] };
    const promise = runFrameLoop(
      sink,
      ["a", "b", "c"],
      codec,
      { latency: 10 },
      {
        signal: controller.signal,
      },
    );
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    expect(await run(promise)).toBe(false);
    expect(sink.ops.filter((o) => o.op === "write")).toEqual([{ op: "write", chunk: "a|" }]);
    expect(sink.ops.some((o) => o.op === "end")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("re-checks the abort after the tick, so a truncating tick stops before the next frame", async () => {
    const sink = new FakeSink();
    const controller = new AbortController();
    const frames = trackedFrames(["a", "b"]);
    const done = await run(
      runFrameLoop(
        sink,
        frames.frames,
        textCodec,
        {},
        {
          signal: controller.signal,
          onChunkSent: () => controller.abort(),
        },
      ),
    );
    expect(done).toBe(false);
    expect(sink.ops.filter((o) => o.op === "write")).toHaveLength(1);
    // The loop stopped right after the tick: it never took the next frame.
    expect(frames.pulled).toEqual(["a"]);
  });

  it("re-checks the abort after the last frame's tick, so the stream is not ended", async () => {
    // On the last frame there is no next iteration: only the check after the
    // tick stops the loop before the end-of-stream path.
    const sink = new FakeSink();
    const controller = new AbortController();
    const frames = trackedFrames(["a", "b"]);
    const done = await run(
      runFrameLoop(
        sink,
        frames.frames,
        textCodec,
        {},
        {
          signal: controller.signal,
          onChunkSent: () => {
            if (sink.ops.filter((o) => o.op === "write").length === 2) controller.abort();
          },
        },
      ),
    );
    expect(done).toBe(false);
    expect(sink.ops.filter((o) => o.op === "write")).toHaveLength(2);
    expect(sink.ops.some((o) => o.op === "end")).toBe(false);
    // The loop returned from inside the iteration: it never asked for more.
    expect(frames.exhausted()).toBe(false);
  });

  it("without a lifecycle, a gone sink does not stop the loop (exported-writer contract)", async () => {
    const sink = new FakeSink();
    sink.isGone = true;
    expect(await run(runFrameLoop(sink, ["a", "b"], textCodec, {}))).toBe(true);
    expect(sink.ops.filter((o) => o.op === "write")).toHaveLength(2);
  });
});

describe("runFrameLoop with a lifecycle", () => {
  class FakeRes extends EventEmitter {
    destroyed = false;
    writableEnded = false;
    writableFinished = false;
    headersSent = false;
    writes: string[] = [];
    setHeader(): void {}
    write(chunk: string): boolean {
      this.writes.push(chunk);
      return true;
    }
    end(): void {
      this.writableEnded = true;
      this.writableFinished = true;
    }
  }
  const fixture: Fixture = { match: {}, response: { content: "x" } };

  it("returns false at entry when the response is already destroyed", async () => {
    const res = new FakeRes();
    const lifecycle = httpLifecycle(res as unknown as http.ServerResponse, fixture, {
      streaming: true,
    });
    res.destroyed = true;
    const done = await run(
      runFrameLoop(
        httpSink(res as unknown as http.ServerResponse),
        ["a"],
        textCodec,
        {},
        {
          lifecycle,
        },
      ),
    );
    expect(done).toBe(false);
    expect(res.writes).toEqual([]);
    lifecycle.dispose();
  });

  it("stops at entry for a destroyed response, before the headers or the prelude", async () => {
    const res = new FakeRes();
    const setHeader = vi.spyOn(res, "setHeader");
    const lifecycle = httpLifecycle(res as unknown as http.ServerResponse, fixture, {
      streaming: true,
    });
    res.destroyed = true;
    await run(
      runFrameLoop(
        httpSink(res as unknown as http.ServerResponse),
        ["a"],
        { ...textCodec, prelude: () => "P|" },
        {},
        { lifecycle },
      ),
    );
    expect(setHeader).not.toHaveBeenCalled();
    expect(res.writes).toEqual([]);
    lifecycle.dispose();
  });

  it("a close during a delay clears the timer and stops before the next write", async () => {
    const res = new FakeRes();
    const lifecycle = httpLifecycle(res as unknown as http.ServerResponse, fixture, {
      streaming: true,
    });
    const promise = runFrameLoop(
      httpSink(res as unknown as http.ServerResponse),
      ["a", "b", "c"],
      textCodec,
      { latency: 1000 },
      { lifecycle },
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(res.writes).toEqual(["a|"]);
    res.destroyed = true;
    res.emit("close");
    expect(vi.getTimerCount()).toBe(0);
    expect(await run(promise)).toBe(false);
    expect(res.writes).toEqual(["a|"]);
    lifecycle.dispose();
  });

  it("returns false (not completed) for a response already ended at entry", async () => {
    const res = new FakeRes();
    res.writableEnded = true;
    const lifecycle = httpLifecycle(res as unknown as http.ServerResponse, fixture, {
      streaming: true,
    });
    const done = await run(
      runFrameLoop(
        httpSink(res as unknown as http.ServerResponse),
        ["a"],
        textCodec,
        {},
        { lifecycle },
      ),
    );
    expect(done).toBe(false);
    expect(res.writes).toEqual([]);
    lifecycle.dispose();
  });

  it("returns false (not completed) for a response ended by other code during the stream", async () => {
    const res = new FakeRes();
    const lifecycle = httpLifecycle(res as unknown as http.ServerResponse, fixture, {
      streaming: true,
    });
    const promise = runFrameLoop(
      httpSink(res as unknown as http.ServerResponse),
      ["a", "b"],
      textCodec,
      { latency: 10 },
      { lifecycle },
    );
    await vi.advanceTimersByTimeAsync(10);
    res.end();
    expect(await run(promise)).toBe(false);
    expect(res.writes).toEqual(["a|"]);
    lifecycle.dispose();
  });

  it("returns false without touching the head when the head was already sent", async () => {
    const res = new FakeRes();
    res.headersSent = true;
    const setHeader = vi.spyOn(res, "setHeader");
    const lifecycle = httpLifecycle(res as unknown as http.ServerResponse, fixture, {
      streaming: true,
    });
    const done = await run(
      runFrameLoop(
        httpSink(res as unknown as http.ServerResponse),
        ["a"],
        textCodec,
        {},
        { lifecycle },
      ),
    );
    expect(done).toBe(false);
    expect(setHeader).not.toHaveBeenCalled();
    expect(res.writes).toEqual([]);
    lifecycle.dispose();
  });

  it("checks sink.gone() next to the abort checks", async () => {
    const res = new FakeRes();
    const lifecycle = httpLifecycle(res as unknown as http.ServerResponse, fixture, {
      streaming: true,
    });
    const sink = httpSink(res as unknown as http.ServerResponse);
    const done = await run(
      runFrameLoop(
        sink,
        ["a", "b"],
        textCodec,
        {},
        {
          lifecycle,
          onChunkSent: () => {
            // Destroyed without a close event (yet): still gone.
            res.destroyed = true;
          },
        },
      ),
    );
    expect(done).toBe(false);
    expect(res.writes).toEqual(["a|"]);
    lifecycle.dispose();
  });
});

describe("runFrameLoop status/headers (#549 contract)", () => {
  it("status given: writeHead(status, merged headers) before the first frame", async () => {
    const sink = new FakeSink();
    await run(runFrameLoop(sink, ["a"], textCodec, {}, { status: 207, headers: { "x-a": "1" } }));
    expect(sink.ops[0]).toEqual({
      op: "writeHead",
      status: 207,
      headers: { "Content-Type": "text/plain", "x-a": "1" },
    });
  });

  it("headers alone are merged over the codec defaults through setHeader", async () => {
    const sink = new FakeSink();
    await run(
      runFrameLoop(sink, ["a"], textCodec, {}, { headers: { "Content-Type": "x/y", "x-b": "2" } }),
    );
    expect(sink.ops.slice(0, 2)).toEqual([
      { op: "setHeader", name: "Content-Type", value: "x/y" },
      { op: "setHeader", name: "x-b", value: "2" },
    ]);
  });

  it("writeHeadImmediately writes the head with an implicit 200", async () => {
    const sink = new FakeSink();
    await run(runFrameLoop(sink, ["a"], { ...textCodec, writeHeadImmediately: true }, {}));
    expect(sink.ops[0]).toEqual({
      op: "writeHead",
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  });
});

describe("runFrameLoop on a WS sink", () => {
  class FakeWs extends EventEmitter {
    isClosed = false;
    sent: string[] = [];
    send(data: string): void {
      this.sent.push(data);
    }
  }

  it("checks gone before the delay, writes no headers, and never ends", async () => {
    const ws = new FakeWs();
    const sink = wsSink(ws as unknown as WebSocketConnection);
    const codec: FrameCodec<string> = { headers: {}, encode: (f) => f, checkGoneBeforeDelay: true };
    const promise = runFrameLoop(sink, ["a", "b"], codec, { latency: 10 });
    await vi.advanceTimersByTimeAsync(10);
    expect(ws.sent).toEqual(["a"]);
    ws.isClosed = true;
    expect(await run(promise)).toBe(false);
    expect(ws.sent).toEqual(["a"]);
    // Frame 1's delay started before the close; the gone re-check after it
    // stops the loop before the write.
    expect(timers).toEqual([10, 10]);
  });

  it("checks gone before the delay: a close between frames starts no further delay", async () => {
    const ws = new FakeWs();
    const sink = wsSink(ws as unknown as WebSocketConnection);
    const codec: FrameCodec<string> = { headers: {}, encode: (f) => f, checkGoneBeforeDelay: true };
    await run(
      runFrameLoop(
        sink,
        ["a", "b"],
        codec,
        { latency: 10 },
        {
          onChunkSent: () => {
            ws.isClosed = true;
          },
        },
      ),
    );
    expect(ws.sent).toEqual(["a"]);
    // Only frame 0's delay ran: the check before frame 1's delay stopped it.
    expect(timers).toEqual([10]);
  });

  it("returns false when the socket closes during the delay", async () => {
    const ws = new FakeWs();
    const sink = wsSink(ws as unknown as WebSocketConnection);
    const codec: FrameCodec<string> = { headers: {}, encode: (f) => f, checkGoneBeforeDelay: true };
    const promise = runFrameLoop(sink, ["a"], codec, { latency: 10 });
    ws.isClosed = true;
    expect(await run(promise)).toBe(false);
    expect(ws.sent).toEqual([]);
  });
});

describe("codecs match the writer goldens' bytes", () => {
  const chunk = { id: "c", choices: [{ delta: { content: "hi" } }] };

  it("sseCodec writes data-only frames, and [DONE] only when done is true", () => {
    const withDone = sseCodec({ done: true, usageChunk: { ...chunk, id: "u" } as never });
    expect(withDone.encode(chunk as never)).toBe(`data: ${JSON.stringify(chunk)}\n\n`);
    expect(withDone.trailer?.(false)).toEqual([
      `data: ${JSON.stringify({ ...chunk, id: "u" })}\n\n`,
      "data: [DONE]\n\n",
    ]);
    expect(sseCodec({ done: false }).trailer?.(false) ?? []).toEqual([]);
    expect(sseCodec({ done: true, openRouterProcessing: true }).prelude?.()).toBe(
      ": OPENROUTER PROCESSING\n\n",
    );
    expect(sseCodec({ done: true }).prelude?.()).toBeUndefined();
    expect(sseCodec({ done: true }).headers).toEqual({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
  });

  it("typedSseCodec writes typed frames and the sentinel only with terminalSentinel", () => {
    const event = { type: "content-delta", x: 1 };
    expect(typedSseCodec().encode(event)).toBe(
      `event: content-delta\ndata: ${JSON.stringify(event)}\n\n`,
    );
    expect(typedSseCodec().trailer?.(false) ?? []).toEqual([]);
    expect(typedSseCodec({ terminalSentinel: true }).trailer?.(false)).toEqual([
      "data: [DONE]\n\n",
    ]);
  });

  it("ndjsonCodec writes one JSON line per frame", () => {
    expect(ndjsonCodec().encode({ a: 1 })).toBe('{"a":1}\n');
    expect(ndjsonCodec().headers).toEqual({
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
  });

  it("eventStreamCodec encodes with encodeEventStreamMessage, or with the given encoder", () => {
    const event = { eventType: "chunk", payload: { a: 1 } };
    expect(eventStreamCodec().encode(event)).toEqual(encodeEventStreamMessage("chunk", { a: 1 }));
    const custom = eventStreamCodec((e) => encodeEventStreamMessage(`x-${e.eventType}`, e.payload));
    expect(custom.encode(event)).toEqual(encodeEventStreamMessage("x-chunk", { a: 1 }));
    expect(eventStreamCodec().headers).toEqual({
      "Content-Type": "application/vnd.amazon.eventstream",
      "Transfer-Encoding": "chunked",
    });
  });
});

describe("runFrameLoop contract (truthful completion)", () => {
  it("an abort before start with no frames returns false and writes no trailer or end", async () => {
    const sink = new FakeSink();
    const controller = new AbortController();
    controller.abort();
    const trailerCalls: boolean[] = [];
    const codec: FrameCodec<string> = {
      ...textCodec,
      trailer: (aborted) => {
        trailerCalls.push(aborted);
        return ["T|"];
      },
    };
    const done = await run(runFrameLoop(sink, [], codec, {}, { signal: controller.signal }));
    expect(done).toBe(false);
    expect(trailerCalls).toEqual([]);
    expect(sink.ops.some((o) => o.op === "write" || o.op === "end")).toBe(false);
  });

  it("a completed delivery calls the trailer with aborted=false", async () => {
    const sink = new FakeSink();
    const trailerCalls: boolean[] = [];
    const codec: FrameCodec<string> = {
      ...textCodec,
      trailer: (aborted) => {
        trailerCalls.push(aborted);
        return [];
      },
    };
    expect(await run(runFrameLoop(sink, [], codec, {}))).toBe(true);
    expect(trailerCalls).toEqual([false]);
  });

  it("rejects a lifecycle and a signal passed together as a programming error", async () => {
    const res = new EventEmitter();
    const lifecycle = httpLifecycle(
      res as unknown as http.ServerResponse,
      { match: {}, response: { content: "x" } },
      { streaming: true },
    );
    const controller = new AbortController();
    const sink = new FakeSink();
    await expect(
      runFrameLoop(
        sink,
        ["a"],
        textCodec,
        {},
        // @ts-expect-error -- a lifecycle and a signal are mutually exclusive
        { lifecycle, signal: controller.signal },
      ),
    ).rejects.toThrow(TypeError);
    expect(sink.ops).toEqual([]);
    lifecycle.dispose();
  });

  it("rejects a status on a sink without writeHead instead of dropping it", async () => {
    const ws = Object.assign(new EventEmitter(), { isClosed: false, send: () => {} });
    const sink = wsSink(ws as unknown as WebSocketConnection);
    await expect(runFrameLoop(sink, ["a"], textCodec, {}, { status: 201 })).rejects.toThrow(
      TypeError,
    );
    await expect(
      runFrameLoop(sink, ["a"], { ...textCodec, writeHeadImmediately: true }, {}),
    ).rejects.toThrow(TypeError);
  });
});
