import { describe, it, expect, afterEach } from "vitest";
import { getEventListeners } from "node:events";
import { PassThrough } from "node:stream";
import type * as http from "node:http";
import { delay, writeSSEStream } from "../sse-writer.js";
import { createServer, type ServerInstance } from "../server.js";
import type { SSEChunk } from "../types.js";

function abortListenerCount(signal: AbortSignal): number {
  return getEventListeners(signal, "abort").length;
}

function makeChunk(i: number): SSEChunk {
  return {
    id: `chunk-${i}`,
    object: "chat.completion.chunk",
    created: 1700000000,
    model: "gpt-4",
    choices: [{ index: 0, delta: { content: `t${i}` }, logprobs: null, finish_reason: null }],
  };
}

function makeSink(): http.ServerResponse {
  const stream = new PassThrough();
  stream.resume();
  let ended = false;
  const res = {
    setHeader() {},
    writeHead() {},
    write(data: string) {
      stream.write(data);
    },
    end(data?: string) {
      if (data !== undefined) stream.write(data);
      ended = true;
      stream.end();
    },
    get writableEnded() {
      return ended;
    },
  };
  return res as unknown as http.ServerResponse;
}

describe("delay() abort listener cleanup", () => {
  it("removes its abort listener when the timer fires normally", async () => {
    const controller = new AbortController();
    for (let i = 0; i < 25; i++) {
      await delay(1, controller.signal);
    }
    expect(abortListenerCount(controller.signal)).toBe(0);
  });

  it("still resolves early on abort and leaves no listener behind", async () => {
    const controller = new AbortController();
    const start = Date.now();
    const p = delay(10_000, controller.signal);
    expect(abortListenerCount(controller.signal)).toBe(1);
    controller.abort();
    await p;
    expect(Date.now() - start).toBeLessThan(1000);
    expect(abortListenerCount(controller.signal)).toBe(0);
  });

  it("a 60-frame profiled stream does not accumulate abort listeners", async () => {
    const controller = new AbortController();
    const chunks = Array.from({ length: 60 }, (_, i) => makeChunk(i));
    const counts: number[] = [];
    const result = await writeSSEStream(makeSink(), chunks, {
      // tps 1000 → ~1ms per frame, so every frame goes through delay(signal).
      streamingProfile: { ttft: 1, tps: 1000 },
      signal: controller.signal,
      onChunkSent: () => counts.push(abortListenerCount(controller.signal)),
    });
    expect(result).toBe(true);
    expect(counts).toHaveLength(60);
    expect(Math.max(...counts)).toBe(0);
    expect(abortListenerCount(controller.signal)).toBe(0);
  });
});

describe("profiled HTTP stream: no MaxListenersExceededWarning", () => {
  let instance: ServerInstance | null = null;
  const warnings: Error[] = [];
  const onWarning = (w: Error) => warnings.push(w);

  // Peak abort-listener count seen on any single AbortSignal during the request.
  let peak = 0;
  const originalAdd = EventTarget.prototype.addEventListener;
  const trackAbortListeners = (): void => {
    peak = 0;
    Object.defineProperty(AbortSignal.prototype, "addEventListener", {
      configurable: true,
      writable: true,
      value: function (this: AbortSignal, ...args: Parameters<EventTarget["addEventListener"]>) {
        originalAdd.apply(this, args);
        if (args[0] === "abort") peak = Math.max(peak, abortListenerCount(this));
      },
    });
  };

  afterEach(async () => {
    Reflect.deleteProperty(AbortSignal.prototype, "addEventListener");
    process.off("warning", onWarning);
    warnings.length = 0;
    if (instance) {
      await new Promise<void>((resolve) => instance!.server.close(() => resolve()));
      instance = null;
    }
  });

  it("streams 60+ delayed frames over the real server without a listener-leak warning", async () => {
    process.on("warning", onWarning);
    trackAbortListeners();
    instance = await createServer([
      {
        match: { userMessage: "leak" },
        response: { content: "x".repeat(64) },
        chunkSize: 1,
        streamingProfile: { ttft: 1, tps: 1000 },
      },
    ]);
    const res = await fetch(`${instance.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        stream: true,
        messages: [{ role: "user", content: "leak" }],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    const frames = body.split("\n\n").filter((f) => f.startsWith("data: {"));
    expect(frames.length).toBeGreaterThanOrEqual(60);
    expect(body).toContain("data: [DONE]");
    // Let any deferred process 'warning' emission land.
    await new Promise((r) => setImmediate(r));
    const leak = warnings.filter((w) => w.name === "MaxListenersExceededWarning");
    expect(leak.map((w) => w.message)).toEqual([]);
    // Node 26 never emits the warning, so also bound the per-signal peak directly.
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(3);
  });
});
