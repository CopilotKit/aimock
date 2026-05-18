import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { createServer, type ServerInstance } from "../server.js";
import type { Fixture, SSEChunk, ChatCompletionRequest, RecordedTimings } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseSSEResponse(body: string): SSEChunk[] {
  return body
    .split("\n\n")
    .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
    .map((line) => JSON.parse(line.slice(6)));
}

async function httpPost(url: string, body: object): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

function chatRequest(
  userContent: string,
  extra: Partial<ChatCompletionRequest> = {},
): ChatCompletionRequest {
  return {
    model: "gpt-4",
    stream: true,
    messages: [{ role: "user", content: userContent }],
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let instance: ServerInstance | null = null;

afterEach(async () => {
  if (instance) {
    await new Promise<void>((resolve) => instance!.server.close(() => resolve()));
    instance = null;
  }
});

describe("timing-aware replay through handleCompletions", () => {
  it("fixture with recordedTimings replays with delays (total duration is roughly proportional)", async () => {
    // 50ms TTFT + 4 inter-chunk delays of 30ms each = ~170ms total
    const timings: RecordedTimings = {
      ttftMs: 50,
      interChunkDelaysMs: [30, 30, 30, 30],
      totalDurationMs: 170,
    };

    const fixtures: Fixture[] = [
      {
        match: { userMessage: "timing-test" },
        response: { content: "Hello world from timing test" },
        recordedTimings: timings,
      },
    ];

    instance = await createServer(fixtures, {
      port: 0,
      chunkSize: 5, // small chunks to generate multiple SSE frames
    });

    const start = Date.now();
    const res = await httpPost(`${instance.url}/v1/chat/completions`, chatRequest("timing-test"));
    const elapsed = Date.now() - start;

    expect(res.status).toBe(200);
    const chunks = parseSSEResponse(res.body);
    expect(chunks.length).toBeGreaterThan(1);

    // With recordedTimings, the total elapsed time should be at least the TTFT
    // plus some inter-chunk delays. Allow generous tolerance for CI jitter,
    // but it should be meaningfully > 0 (i.e. delays are being applied).
    expect(elapsed).toBeGreaterThanOrEqual(40); // at least ~TTFT minus jitter
  });

  it("replaySpeed 2.0 halves the replay duration", async () => {
    // 80ms TTFT + 4 x 40ms inter-chunk = ~240ms at 1x speed
    const timings: RecordedTimings = {
      ttftMs: 80,
      interChunkDelaysMs: [40, 40, 40, 40],
      totalDurationMs: 240,
    };

    const fixtures: Fixture[] = [
      {
        match: { userMessage: "speed-test" },
        response: { content: "Hello world from speed test" },
        recordedTimings: timings,
        replaySpeed: 2.0,
      },
    ];

    instance = await createServer(fixtures, {
      port: 0,
      chunkSize: 5,
    });

    const start = Date.now();
    const res = await httpPost(`${instance.url}/v1/chat/completions`, chatRequest("speed-test"));
    const elapsed = Date.now() - start;

    expect(res.status).toBe(200);
    const chunks = parseSSEResponse(res.body);
    expect(chunks.length).toBeGreaterThan(1);

    // At 2x speed, effective delays are halved. The full 1x duration would be
    // ~240ms, so at 2x it should be ~120ms. We verify it's well below 1x
    // but still non-trivial (delays are being applied, just faster).
    expect(elapsed).toBeGreaterThanOrEqual(50); // still has meaningful delay
    expect(elapsed).toBeLessThan(200); // well below 1x baseline of ~240ms
  });

  it("recordedTimings alone impose real delays (positive control)", async () => {
    // 200ms TTFT + 3 inter-chunk delays of 100ms = ~500ms total.
    // Without any streamingProfile override, elapsed should be >= 300ms.
    const timings: RecordedTimings = {
      ttftMs: 200,
      interChunkDelaysMs: [100, 100, 100],
      totalDurationMs: 500,
    };

    const fixtures: Fixture[] = [
      {
        match: { userMessage: "positive-control" },
        response: { content: "Hello world" },
        recordedTimings: timings,
      },
    ];

    instance = await createServer(fixtures, {
      port: 0,
      chunkSize: 5,
    });

    const start = Date.now();
    const res = await httpPost(
      `${instance.url}/v1/chat/completions`,
      chatRequest("positive-control"),
    );
    const elapsed = Date.now() - start;

    expect(res.status).toBe(200);
    const chunks = parseSSEResponse(res.body);
    expect(chunks.length).toBeGreaterThan(1);

    // recordedTimings should impose real delays: TTFT(200) + delays(3*100) = ~500ms.
    // Even with CI jitter, elapsed must be >= 300ms to prove timing is applied.
    expect(elapsed).toBeGreaterThanOrEqual(300);
  });

  it("streamingProfile overrides recordedTimings (precedence)", async () => {
    // Same recordedTimings as positive control above (~500ms total),
    // but streamingProfile at very high TPS should override and be near-instant.
    const timings: RecordedTimings = {
      ttftMs: 200,
      interChunkDelaysMs: [100, 100, 100],
      totalDurationMs: 500,
    };

    const fixtures: Fixture[] = [
      {
        match: { userMessage: "precedence-test" },
        response: { content: "Hello world" },
        recordedTimings: timings,
        streamingProfile: { ttft: 0, tps: 10000 }, // near-instant
      },
    ];

    instance = await createServer(fixtures, {
      port: 0,
      chunkSize: 5,
    });

    const start = Date.now();
    const res = await httpPost(
      `${instance.url}/v1/chat/completions`,
      chatRequest("precedence-test"),
    );
    const elapsed = Date.now() - start;

    expect(res.status).toBe(200);
    const chunks = parseSSEResponse(res.body);
    expect(chunks.length).toBeGreaterThan(0);

    // With streamingProfile overriding, total time should be well under
    // what recordedTimings would have imposed (~500ms). Near-instant.
    expect(elapsed).toBeLessThan(200);
  });

  it("fixture without recordedTimings uses existing latency model (backward compat)", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "compat-test" },
        response: { content: "Hello backward compat" },
        // No recordedTimings, no streamingProfile — uses global latency
      },
    ];

    instance = await createServer(fixtures, {
      port: 0,
      chunkSize: 10,
      latency: 0, // zero latency for fast test
    });

    const start = Date.now();
    const res = await httpPost(`${instance.url}/v1/chat/completions`, chatRequest("compat-test"));
    const elapsed = Date.now() - start;

    expect(res.status).toBe(200);
    const chunks = parseSSEResponse(res.body);
    expect(chunks.length).toBeGreaterThan(0);

    // With zero latency and no timing features, should complete near-instantly
    expect(elapsed).toBeLessThan(100);

    // Verify content is correct
    const content = chunks.map((c) => c.choices?.[0]?.delta?.content ?? "").join("");
    expect(content).toContain("Hello backward compat");
  });
});
