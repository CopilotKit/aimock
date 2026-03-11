import { describe, it, expect, vi, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import type * as http from "node:http";
import { writeSSEStream, writeErrorResponse, delay } from "../sse-writer.js";
import type { SSEChunk } from "../types.js";

function makeMockResponse(): {
  res: http.ServerResponse;
  output: () => string;
  headers: () => Record<string, string | string[] | number | undefined>;
  status: () => number | undefined;
  ended: () => boolean;
} {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));

  const writtenHeaders: Record<string, string | string[] | number | undefined> = {};
  let writtenStatus: number | undefined;
  let isEnded = false;

  const res = {
    setHeader(name: string, value: string) {
      writtenHeaders[name] = value;
    },
    writeHead(statusCode: number, headers?: Record<string, string>) {
      writtenStatus = statusCode;
      if (headers) {
        for (const [k, v] of Object.entries(headers)) {
          writtenHeaders[k] = v;
        }
      }
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
  } as unknown as http.ServerResponse;

  return {
    res,
    output: () => Buffer.concat(chunks).toString("utf8"),
    headers: () => writtenHeaders,
    status: () => writtenStatus,
    ended: () => isEnded,
  };
}

function makeChunk(id: string, content: string): SSEChunk {
  return {
    id,
    object: "chat.completion.chunk",
    created: 1700000000,
    model: "gpt-4",
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  };
}

describe("writeSSEStream", () => {
  it("sets correct SSE headers", async () => {
    const { res, headers } = makeMockResponse();
    await writeSSEStream(res, []);
    expect(headers()["Content-Type"]).toBe("text/event-stream");
    expect(headers()["Cache-Control"]).toBe("no-cache");
    expect(headers()["Connection"]).toBe("keep-alive");
  });

  it("writes each chunk as a data: SSE event", async () => {
    const { res, output } = makeMockResponse();
    const chunks = [makeChunk("id1", "hello"), makeChunk("id2", " world")];
    await writeSSEStream(res, chunks);

    const body = output();
    expect(body).toContain(`data: ${JSON.stringify(chunks[0])}\n\n`);
    expect(body).toContain(`data: ${JSON.stringify(chunks[1])}\n\n`);
  });

  it("writes chunks in order", async () => {
    const { res, output } = makeMockResponse();
    const chunks = [makeChunk("id1", "A"), makeChunk("id2", "B"), makeChunk("id3", "C")];
    await writeSSEStream(res, chunks);

    const body = output();
    const posA = body.indexOf(JSON.stringify(chunks[0]));
    const posB = body.indexOf(JSON.stringify(chunks[1]));
    const posC = body.indexOf(JSON.stringify(chunks[2]));
    expect(posA).toBeLessThan(posB);
    expect(posB).toBeLessThan(posC);
  });

  it("ends stream with data: [DONE]", async () => {
    const { res, output } = makeMockResponse();
    await writeSSEStream(res, [makeChunk("id1", "hi")]);
    expect(output()).toMatch(/data: \[DONE\]\n\n$/);
  });

  it("calls res.end() when done", async () => {
    const { res, ended } = makeMockResponse();
    await writeSSEStream(res, []);
    expect(ended()).toBe(true);
  });

  it("writes [DONE] even with zero chunks", async () => {
    const { res, output } = makeMockResponse();
    await writeSSEStream(res, []);
    expect(output()).toBe("data: [DONE]\n\n");
  });

  it("applies latency delay between chunks", async () => {
    vi.useFakeTimers();

    const { res } = makeMockResponse();
    const chunks = [makeChunk("id1", "A"), makeChunk("id2", "B")];

    const promise = writeSSEStream(res, chunks, 50);
    await vi.runAllTimersAsync();
    await promise;

    vi.useRealTimers();
  });

  it("returns immediately without writing when res.writableEnded is true", async () => {
    const { res, output, headers } = makeMockResponse();
    Object.defineProperty(res, "writableEnded", { get: () => true });
    await writeSSEStream(res, [makeChunk("id1", "hi")]);
    expect(headers()["Content-Type"]).toBeUndefined();
    expect(output()).toBe("");
  });

  it("does not delay when latency is 0", async () => {
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");
    const { res } = makeMockResponse();
    await writeSSEStream(res, [makeChunk("id1", "x")], 0);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  });

  it("propagates error when res.write() throws mid-stream", async () => {
    const { res, output } = makeMockResponse();
    let writeCount = 0;
    const originalWrite = res.write.bind(res);
    res.write = ((data: string) => {
      writeCount++;
      if (writeCount > 2) {
        throw new Error("write failed");
      }
      return originalWrite(data);
    }) as typeof res.write;

    const chunks = [makeChunk("id1", "A"), makeChunk("id2", "B"), makeChunk("id3", "C")];
    await expect(writeSSEStream(res, chunks)).rejects.toThrow("write failed");

    // First two chunks should have been written successfully
    const body = output();
    expect(body).toContain(JSON.stringify(chunks[0]));
    expect(body).toContain(JSON.stringify(chunks[1]));
    // Third chunk should not appear
    expect(body).not.toContain(JSON.stringify(chunks[2]));
  });
});

describe("delay", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves after the specified time", async () => {
    vi.useFakeTimers();
    let resolved = false;
    const p = delay(100).then(() => {
      resolved = true;
    });
    expect(resolved).toBe(false);
    vi.advanceTimersByTime(100);
    await p;
    expect(resolved).toBe(true);
  });

  it("resolves immediately when ms is 0", async () => {
    const start = Date.now();
    await delay(0);
    // Should return synchronously (Promise.resolve())
    expect(Date.now() - start).toBeLessThan(50);
  });

  it("resolves early when signal is aborted", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let resolved = false;
    const p = delay(10000, controller.signal).then(() => {
      resolved = true;
    });

    vi.advanceTimersByTime(50);
    expect(resolved).toBe(false);

    controller.abort();
    await p;
    expect(resolved).toBe(true);
  });

  it("resolves immediately for negative ms", async () => {
    await delay(-5);
    // no error
  });

  it("resolves immediately when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    let resolved = false;
    const raceResult = await Promise.race([
      delay(5000, controller.signal).then(() => {
        resolved = true;
        return "delay";
      }),
      new Promise<string>((r) => setTimeout(() => r("timeout"), 100)),
    ]);

    expect(raceResult).toBe("delay");
    expect(resolved).toBe(true);
  });
});

describe("writeSSEStream with StreamOptions", () => {
  it("accepts options object (backward compatible)", async () => {
    const { res, output } = makeMockResponse();
    const chunks = [makeChunk("id1", "hello")];
    const result = await writeSSEStream(res, chunks, { latency: 0 });
    expect(result).toBe(true);
    expect(output()).toContain("data: [DONE]");
  });

  it("returns true when stream completes normally", async () => {
    const { res } = makeMockResponse();
    const result = await writeSSEStream(res, [makeChunk("id1", "A")]);
    expect(result).toBe(true);
  });

  it("stops mid-stream on abort signal and returns false", async () => {
    const { res, output } = makeMockResponse();
    const controller = new AbortController();

    const chunks = [makeChunk("id1", "A"), makeChunk("id2", "B"), makeChunk("id3", "C")];

    // Abort after first chunk is sent
    let chunksSent = 0;
    const result = await writeSSEStream(res, chunks, {
      signal: controller.signal,
      onChunkSent: () => {
        chunksSent++;
        if (chunksSent === 1) controller.abort();
      },
    });

    expect(result).toBe(false);
    const body = output();
    expect(body).toContain(JSON.stringify(chunks[0]));
    // Should not contain [DONE]
    expect(body).not.toContain("[DONE]");
  });

  it("skips [DONE] when interrupted", async () => {
    const { res, output } = makeMockResponse();
    const controller = new AbortController();

    const chunks = [makeChunk("id1", "A"), makeChunk("id2", "B")];
    const result = await writeSSEStream(res, chunks, {
      signal: controller.signal,
      onChunkSent: () => {
        controller.abort();
      },
    });

    expect(result).toBe(false);
    expect(output()).not.toContain("[DONE]");
  });

  it("onChunkSent fires per chunk", async () => {
    const { res } = makeMockResponse();
    const chunks = [makeChunk("id1", "A"), makeChunk("id2", "B"), makeChunk("id3", "C")];
    let count = 0;
    const result = await writeSSEStream(res, chunks, {
      onChunkSent: () => {
        count++;
      },
    });

    expect(result).toBe(true);
    expect(count).toBe(3);
  });

  it("returns true for numeric latency arg (backward compat)", async () => {
    vi.useFakeTimers();
    const { res } = makeMockResponse();
    const promise = writeSSEStream(res, [makeChunk("id1", "A")], 10);
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toBe(true);
    vi.useRealTimers();
  });
});

describe("writeErrorResponse", () => {
  it("writes the given status code", () => {
    const { res, status } = makeMockResponse();
    writeErrorResponse(res, 404, JSON.stringify({ error: { message: "not found" } }));
    expect(status()).toBe(404);
  });

  it("sets Content-Type to application/json", () => {
    const { res, headers } = makeMockResponse();
    writeErrorResponse(res, 400, "{}");
    expect(headers()["Content-Type"]).toBe("application/json");
  });

  it("writes the body as-is", () => {
    const { res, output } = makeMockResponse();
    const body = JSON.stringify({ error: { message: "bad request", type: "invalid_request" } });
    writeErrorResponse(res, 400, body);
    expect(output()).toBe(body);
  });

  it("calls res.end()", () => {
    const { res, ended } = makeMockResponse();
    writeErrorResponse(res, 500, "{}");
    expect(ended()).toBe(true);
  });
});
