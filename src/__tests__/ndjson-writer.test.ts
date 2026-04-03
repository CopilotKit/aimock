import { describe, it, expect, vi, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import type * as http from "node:http";
import { writeNDJSONStream } from "../ndjson-writer.js";

// ---------------------------------------------------------------------------
// Mock response helper (mirrors sse-writer.test.ts pattern)
// ---------------------------------------------------------------------------

function makeMockResponse(): {
  res: http.ServerResponse;
  output: () => string;
  headers: () => Record<string, string | string[] | number | undefined>;
  ended: () => boolean;
} {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));

  const writtenHeaders: Record<string, string | string[] | number | undefined> = {};
  let isEnded = false;

  const res = {
    setHeader(name: string, value: string) {
      writtenHeaders[name] = value;
    },
    write(data: string) {
      stream.write(data);
    },
    end(data?: string) {
      if (data !== undefined) {
        stream.write(data);
      }
      isEnded = true;
      stream.end();
    },
    writableEnded: false,
  } as unknown as http.ServerResponse;

  return {
    res,
    output: () => Buffer.concat(chunks).toString("utf8"),
    headers: () => writtenHeaders,
    ended: () => isEnded,
  };
}

// ---------------------------------------------------------------------------
// writeNDJSONStream
// ---------------------------------------------------------------------------

describe("writeNDJSONStream", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sets correct NDJSON headers", async () => {
    const { res, headers } = makeMockResponse();
    await writeNDJSONStream(res, []);
    expect(headers()["Content-Type"]).toBe("application/x-ndjson");
    expect(headers()["Cache-Control"]).toBe("no-cache");
    expect(headers()["Connection"]).toBe("keep-alive");
  });

  it("writes each chunk as a JSON line", async () => {
    const { res, output } = makeMockResponse();
    const chunks = [{ text: "hello" }, { text: "world" }];
    await writeNDJSONStream(res, chunks);

    const lines = output().trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ text: "hello" });
    expect(JSON.parse(lines[1])).toEqual({ text: "world" });
  });

  it("calls res.end() when done", async () => {
    const { res, ended } = makeMockResponse();
    await writeNDJSONStream(res, [{ done: true }]);
    expect(ended()).toBe(true);
  });

  it("returns true on normal completion", async () => {
    const { res } = makeMockResponse();
    const result = await writeNDJSONStream(res, [{ ok: true }]);
    expect(result).toBe(true);
  });

  it("returns true immediately when res.writableEnded is already true", async () => {
    const { res, headers } = makeMockResponse();
    Object.defineProperty(res, "writableEnded", { get: () => true });
    const result = await writeNDJSONStream(res, [{ text: "should not write" }]);
    expect(result).toBe(true);
    // Should not have set any headers (returned before writing)
    expect(headers()["Content-Type"]).toBeUndefined();
  });

  it("returns false when signal is aborted after delay", async () => {
    vi.useFakeTimers();
    const { res } = makeMockResponse();
    const controller = new AbortController();

    const chunks = [{ text: "A" }, { text: "B" }];
    const promise = writeNDJSONStream(res, chunks, {
      latency: 100,
      signal: controller.signal,
    });

    // Abort during the delay before the second chunk
    controller.abort();
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe(false);
    vi.useRealTimers();
  });

  it("returns false when signal is aborted after a chunk is sent", async () => {
    const { res, output } = makeMockResponse();
    const controller = new AbortController();

    const chunks = [{ text: "A" }, { text: "B" }, { text: "C" }];
    let chunksSent = 0;
    const result = await writeNDJSONStream(res, chunks, {
      signal: controller.signal,
      onChunkSent: () => {
        chunksSent++;
        if (chunksSent === 1) controller.abort();
      },
    });

    expect(result).toBe(false);
    const body = output();
    expect(body).toContain(JSON.stringify({ text: "A" }));
  });

  it("returns true when res.writableEnded becomes true mid-loop", async () => {
    const { res, output } = makeMockResponse();
    let writeCount = 0;
    const originalWrite = res.write.bind(res);
    res.write = ((data: string) => {
      writeCount++;
      originalWrite(data);
      if (writeCount === 1) {
        // Simulate the response ending externally after first chunk
        Object.defineProperty(res, "writableEnded", { get: () => true });
      }
      return true;
    }) as typeof res.write;

    const chunks = [{ text: "A" }, { text: "B" }];
    const result = await writeNDJSONStream(res, chunks);

    expect(result).toBe(true);
    // Only first chunk should have been written
    const body = output();
    expect(body).toContain(JSON.stringify({ text: "A" }));
    expect(body).not.toContain(JSON.stringify({ text: "B" }));
  });

  it("onChunkSent fires per chunk", async () => {
    const { res } = makeMockResponse();
    const chunks = [{ a: 1 }, { b: 2 }, { c: 3 }];
    let count = 0;
    await writeNDJSONStream(res, chunks, {
      onChunkSent: () => {
        count++;
      },
    });
    expect(count).toBe(3);
  });

  it("applies latency delay between chunks", async () => {
    vi.useFakeTimers();
    const { res } = makeMockResponse();
    const chunks = [{ text: "A" }, { text: "B" }];
    const promise = writeNDJSONStream(res, chunks, { latency: 50 });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toBe(true);
    vi.useRealTimers();
  });

  it("handles undefined options (defaults)", async () => {
    const { res, output } = makeMockResponse();
    const result = await writeNDJSONStream(res, [{ test: true }]);
    expect(result).toBe(true);
    expect(output()).toContain('{"test":true}');
  });

  it("does not end stream if already ended by external code", async () => {
    const { res } = makeMockResponse();
    // Process no chunks, but simulate writableEnded becoming true externally
    const originalEnd = res.end.bind(res);
    let endCallCount = 0;
    res.end = ((...args: unknown[]) => {
      endCallCount++;
      return (originalEnd as (...a: unknown[]) => void)(...args);
    }) as typeof res.end;

    // Set writableEnded after headers are set but before end is called
    const chunks = [{ x: 1 }];
    const originalWrite = res.write.bind(res);
    res.write = ((data: string) => {
      originalWrite(data);
      Object.defineProperty(res, "writableEnded", {
        get: () => true,
        configurable: true,
      });
      return true;
    }) as typeof res.write;

    await writeNDJSONStream(res, chunks);
    // res.end should not be called because writableEnded was true
    expect(endCallCount).toBe(0);
  });
});
