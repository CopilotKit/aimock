import { describe, it, expect, vi, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import type * as http from "node:http";
import { writeSSEStream, calculateDelay } from "../sse-writer.js";
import type { SSEChunk, StreamingProfile } from "../types.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFixtureFile } from "../fixture-loader.js";

function makeMockResponse(): {
  res: http.ServerResponse;
  output: () => string;
  ended: () => boolean;
} {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));

  let isEnded = false;

  const res = {
    setHeader() {},
    writeHead() {},
    write(data: string) {
      stream.write(data);
    },
    end(data?: string) {
      if (data !== undefined) stream.write(data);
      isEnded = true;
      stream.end();
    },
    get writableEnded() {
      return isEnded;
    },
  } as unknown as http.ServerResponse;

  return {
    res,
    output: () => Buffer.concat(chunks).toString("utf8"),
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

// ─── calculateDelay unit tests ───────────────────────────────────────────────

describe("calculateDelay", () => {
  it("returns fallback latency when no profile is provided", () => {
    expect(calculateDelay(0, undefined, 50)).toBe(50);
    expect(calculateDelay(1, undefined, 50)).toBe(50);
  });

  it("returns 0 when no profile and no fallback", () => {
    expect(calculateDelay(0, undefined, undefined)).toBe(0);
  });

  it("returns ttft for first chunk when ttft is set", () => {
    const profile: StreamingProfile = { ttft: 200, tps: 50 };
    expect(calculateDelay(0, profile)).toBe(200);
  });

  it("returns 1000/tps for subsequent chunks", () => {
    const profile: StreamingProfile = { ttft: 200, tps: 50 };
    expect(calculateDelay(1, profile)).toBe(20); // 1000/50
    expect(calculateDelay(5, profile)).toBe(20);
  });

  it("returns 1000/tps for first chunk when only tps is set (no ttft)", () => {
    const profile: StreamingProfile = { tps: 100 };
    expect(calculateDelay(0, profile)).toBe(10); // 1000/100
  });

  it("returns fallback when profile has neither ttft nor tps", () => {
    const profile: StreamingProfile = { jitter: 0.5 };
    expect(calculateDelay(0, profile, 30)).toBe(30);
  });

  it("returns fallback when tps is 0", () => {
    const profile: StreamingProfile = { tps: 0 };
    expect(calculateDelay(1, profile, 25)).toBe(25);
  });

  it("applies jitter to ttft on first chunk", () => {
    const profile: StreamingProfile = { ttft: 100, tps: 50, jitter: 0.5 };
    // With jitter, result should be in range [50, 150]
    const results = new Set<number>();
    for (let i = 0; i < 100; i++) {
      const d = calculateDelay(0, profile);
      expect(d).toBeGreaterThanOrEqual(50);
      expect(d).toBeLessThanOrEqual(150);
      results.add(Math.round(d));
    }
    // With 100 samples at jitter 0.5, we should see variation
    expect(results.size).toBeGreaterThan(1);
  });

  it("applies jitter to tps-based delay on subsequent chunks", () => {
    const profile: StreamingProfile = { tps: 50, jitter: 0.5 };
    // base delay = 20, range = [10, 30]
    const results = new Set<number>();
    for (let i = 0; i < 100; i++) {
      const d = calculateDelay(1, profile);
      expect(d).toBeGreaterThanOrEqual(10);
      expect(d).toBeLessThanOrEqual(30);
      results.add(Math.round(d));
    }
    expect(results.size).toBeGreaterThan(1);
  });

  it("clamps negative jitter results to 0", () => {
    // With jitter=1.0, the multiplier range is [0, 2], so delay can go to 0
    const profile: StreamingProfile = { ttft: 1, jitter: 1.0 };
    // Many runs should always be >= 0
    for (let i = 0; i < 100; i++) {
      expect(calculateDelay(0, profile)).toBeGreaterThanOrEqual(0);
    }
  });

  it("does not apply jitter when jitter is 0", () => {
    const profile: StreamingProfile = { ttft: 100, tps: 50, jitter: 0 };
    expect(calculateDelay(0, profile)).toBe(100);
    expect(calculateDelay(1, profile)).toBe(20);
  });
});

// ─── writeSSEStream with streamingProfile ────────────────────────────────────

describe("writeSSEStream with streamingProfile", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses ttft delay for first chunk and tps for subsequent chunks", async () => {
    vi.useFakeTimers();
    const { res, output } = makeMockResponse();
    const chunks = [makeChunk("1", "A"), makeChunk("2", "B"), makeChunk("3", "C")];

    const promise = writeSSEStream(res, chunks, {
      streamingProfile: { ttft: 500, tps: 10 }, // 500ms first, 100ms subsequent
    });

    // After 500ms, first chunk should be written (ttft)
    await vi.advanceTimersByTimeAsync(500);
    // After 100ms more, second chunk (1000/10 = 100ms)
    await vi.advanceTimersByTimeAsync(100);
    // After 100ms more, third chunk
    await vi.advanceTimersByTimeAsync(100);

    await promise;

    const body = output();
    expect(body).toContain(JSON.stringify(chunks[0]));
    expect(body).toContain(JSON.stringify(chunks[1]));
    expect(body).toContain(JSON.stringify(chunks[2]));
    expect(body).toContain("[DONE]");
  });

  it("streamingProfile overrides latency when both are set", async () => {
    vi.useFakeTimers();
    const { res, output } = makeMockResponse();
    const chunks = [makeChunk("1", "A"), makeChunk("2", "B")];

    const promise = writeSSEStream(res, chunks, {
      latency: 1000, // would take 2000ms total if used
      streamingProfile: { ttft: 10, tps: 100 }, // 10ms + 10ms = 20ms total
    });

    // With streaming profile, should complete much faster than latency
    await vi.advanceTimersByTimeAsync(10); // ttft
    await vi.advanceTimersByTimeAsync(10); // 1000/100 = 10ms

    await promise;

    const body = output();
    expect(body).toContain(JSON.stringify(chunks[0]));
    expect(body).toContain(JSON.stringify(chunks[1]));
  });

  it("falls back to latency when streamingProfile is not set", async () => {
    vi.useFakeTimers();
    const { res, output } = makeMockResponse();
    const chunks = [makeChunk("1", "A")];

    const promise = writeSSEStream(res, chunks, { latency: 50 });
    await vi.advanceTimersByTimeAsync(50);
    await promise;

    expect(output()).toContain(JSON.stringify(chunks[0]));
  });

  it("jitter causes variable delays (not all identical)", async () => {
    // Use real timers for this test since we're measuring variance
    const delays: number[] = [];
    const originalRandom = Math.random;
    let callCount = 0;
    // Alternate random between 0.0 and 1.0 to guarantee variance
    Math.random = () => {
      callCount++;
      return callCount % 2 === 0 ? 0.0 : 1.0;
    };

    try {
      const profile: StreamingProfile = { tps: 1000, jitter: 0.5 };
      for (let i = 0; i < 10; i++) {
        delays.push(calculateDelay(1, profile));
      }
      const uniqueDelays = new Set(delays.map((d) => d.toFixed(4)));
      expect(uniqueDelays.size).toBeGreaterThan(1);
    } finally {
      Math.random = originalRandom;
    }
  });
});

// ─── Fixture loader passthrough ──────────────────────────────────────────────

describe("fixture loader streamingProfile passthrough", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads streamingProfile from JSON fixture file", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "sp-test-"));
    const filePath = join(tmpDir, "physics.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        fixtures: [
          {
            match: { userMessage: "hello" },
            response: { content: "Hi!" },
            streamingProfile: { ttft: 200, tps: 50, jitter: 0.1 },
          },
        ],
      }),
      "utf-8",
    );

    const fixtures = loadFixtureFile(filePath);
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0].streamingProfile).toEqual({ ttft: 200, tps: 50, jitter: 0.1 });
  });

  it("omits streamingProfile when not present in JSON", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "sp-test-"));
    const filePath = join(tmpDir, "no-profile.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        fixtures: [
          {
            match: { userMessage: "hello" },
            response: { content: "Hi!" },
          },
        ],
      }),
      "utf-8",
    );

    const fixtures = loadFixtureFile(filePath);
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0].streamingProfile).toBeUndefined();
  });

  it("loads partial streamingProfile (only ttft)", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "sp-test-"));
    const filePath = join(tmpDir, "partial.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        fixtures: [
          {
            match: { userMessage: "hello" },
            response: { content: "Hi!" },
            streamingProfile: { ttft: 300 },
          },
        ],
      }),
      "utf-8",
    );

    const fixtures = loadFixtureFile(filePath);
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0].streamingProfile).toEqual({ ttft: 300 });
  });
});
