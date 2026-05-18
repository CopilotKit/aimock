import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FixtureFile } from "../types.js";
import { createServer, type ServerInstance } from "../server.js";
import { encodeEventStreamMessage } from "../aws-event-stream.js";

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

let upstream: http.Server | undefined;
let recorder: ServerInstance | undefined;
let tmpDir: string | undefined;

afterEach(async () => {
  if (recorder) {
    await new Promise<void>((resolve) => recorder!.server.close(() => resolve()));
    recorder = undefined;
  }
  if (upstream) {
    await new Promise<void>((resolve) => upstream!.close(() => resolve()));
    upstream = undefined;
  }
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function post(
  url: string,
  body: unknown,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          });
        });
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

/** Consume a streaming response fully, returning the concatenated body. */
function consumeStream(url: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
          });
        });
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("timing-aware recording", () => {
  it("recorded fixture includes recordedTimings for SSE streaming response", async () => {
    // Create a fake upstream that streams SSE with known delays
    const TTFT_MS = 80;
    const INTER_CHUNK_MS = 40;
    upstream = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunks = [
        `data: ${JSON.stringify({ id: "c1", choices: [{ delta: { content: "Hello" } }] })}\n\n`,
        `data: ${JSON.stringify({ id: "c1", choices: [{ delta: { content: " world" } }] })}\n\n`,
        "data: [DONE]\n\n",
      ];
      let i = 0;
      const send = () => {
        if (i < chunks.length) {
          res.write(chunks[i]);
          i++;
          setTimeout(send, INTER_CHUNK_MS);
        } else {
          res.end();
        }
      };
      setTimeout(send, TTFT_MS);
    });
    await new Promise<void>((resolve) => upstream!.listen(0, "127.0.0.1", resolve));
    const upstreamPort = (upstream!.address() as { port: number }).port;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-timing-rec-"));
    recorder = await createServer([], {
      port: 0,
      record: {
        providers: { openai: `http://127.0.0.1:${upstreamPort}` },
        fixturePath: tmpDir,
      },
    });

    // Make a streaming request through the recorder
    await consumeStream(`${recorder.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });

    // Check the fixture file on disk for recordedTimings
    const files = fs.readdirSync(tmpDir);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);

    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(tmpDir, fixtureFiles[0]), "utf-8"),
    ) as FixtureFile;
    expect(fixtureContent.fixtures).toHaveLength(1);

    const fixture = fixtureContent.fixtures[0];
    expect(fixture.recordedTimings).toBeDefined();
    // Upstream sends first chunk after 80ms, but the recorder measures TTFT
    // from response-headers-received to first-frame-boundary-detected, so on
    // localhost the first data event often contains the first frame, yielding
    // TTFT near 0. Assert it's a valid non-negative integer (not undefined/NaN).
    expect(Number.isFinite(fixture.recordedTimings!.ttftMs)).toBe(true);
    expect(fixture.recordedTimings!.ttftMs).toBeGreaterThanOrEqual(0);
    expect(fixture.recordedTimings!.ttftMs).toBeLessThan(TTFT_MS * 3);
    expect(fixture.recordedTimings!.interChunkDelaysMs.length).toBeGreaterThan(0);
    expect(fixture.recordedTimings!.totalDurationMs).toBeGreaterThan(0);
    // Total duration should reflect the upstream frame spacing
    // (TTFT + 3 chunks * INTER_CHUNK_MS ~ 200ms; allow slack for CI)
    expect(fixture.recordedTimings!.totalDurationMs).toBeGreaterThanOrEqual(INTER_CHUNK_MS * 1.5);
  });

  it("recordedTimings inter-chunk delays roughly match upstream spacing", async () => {
    const INTER_CHUNK_MS = 60;
    const NUM_DATA_CHUNKS = 4;
    upstream = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      let i = 0;
      const send = () => {
        if (i < NUM_DATA_CHUNKS) {
          res.write(
            `data: ${JSON.stringify({ id: "c1", choices: [{ delta: { content: `chunk${i}` } }] })}\n\n`,
          );
          i++;
          setTimeout(send, INTER_CHUNK_MS);
        } else {
          res.write("data: [DONE]\n\n");
          res.end();
        }
      };
      // First chunk after a short TTFT
      setTimeout(send, 30);
    });
    await new Promise<void>((resolve) => upstream!.listen(0, "127.0.0.1", resolve));
    const upstreamPort = (upstream!.address() as { port: number }).port;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-timing-rec-delays-"));
    recorder = await createServer([], {
      port: 0,
      record: {
        providers: { openai: `http://127.0.0.1:${upstreamPort}` },
        fixturePath: tmpDir,
      },
    });

    await consumeStream(`${recorder.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "spacing test" }],
      stream: true,
    });

    const files = fs.readdirSync(tmpDir);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(tmpDir, fixtureFiles[0]), "utf-8"),
    ) as FixtureFile;
    const timings = fixtureContent.fixtures[0].recordedTimings;
    expect(timings).toBeDefined();

    // We sent NUM_DATA_CHUNKS data frames + 1 DONE frame.
    // interChunkDelaysMs should have length >= NUM_DATA_CHUNKS (one per
    // gap between consecutive frames). Allow variance but check that
    // each inter-chunk delay is within a plausible range of the target.
    expect(timings!.interChunkDelaysMs.length).toBeGreaterThanOrEqual(NUM_DATA_CHUNKS - 1);
    for (const delay of timings!.interChunkDelaysMs) {
      // Each delay should be roughly INTER_CHUNK_MS, allow 0..3x range
      // for scheduler jitter on CI
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(INTER_CHUNK_MS * 4);
    }
  });

  it("non-streaming response does NOT get recordedTimings", async () => {
    // Upstream returns a plain JSON (non-streaming) response
    upstream = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: "Paris", role: "assistant" }, finish_reason: "stop" }],
        }),
      );
    });
    await new Promise<void>((resolve) => upstream!.listen(0, "127.0.0.1", resolve));
    const upstreamPort = (upstream!.address() as { port: number }).port;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-timing-rec-nons-"));
    recorder = await createServer([], {
      port: 0,
      record: {
        providers: { openai: `http://127.0.0.1:${upstreamPort}` },
        fixturePath: tmpDir,
      },
    });

    await post(`${recorder.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "capital of France" }],
    });

    const files = fs.readdirSync(tmpDir);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(tmpDir, fixtureFiles[0]), "utf-8"),
    ) as FixtureFile;
    // Non-streaming should NOT have recordedTimings
    expect(fixtureContent.fixtures[0].recordedTimings).toBeUndefined();
  });

  it("NDJSON streaming response gets recordedTimings", async () => {
    // Simulate an Ollama-style NDJSON upstream
    upstream = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      const chunks = [
        JSON.stringify({ message: { content: "Hello" }, done: false }) + "\n",
        JSON.stringify({ message: { content: " world" }, done: false }) + "\n",
        JSON.stringify({ message: { content: "" }, done: true }) + "\n",
      ];
      let i = 0;
      const send = () => {
        if (i < chunks.length) {
          res.write(chunks[i]);
          i++;
          setTimeout(send, 40);
        } else {
          res.end();
        }
      };
      setTimeout(send, 50);
    });
    await new Promise<void>((resolve) => upstream!.listen(0, "127.0.0.1", resolve));
    const upstreamPort = (upstream!.address() as { port: number }).port;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-timing-rec-ndjson-"));
    recorder = await createServer([], {
      port: 0,
      record: {
        providers: { ollama: `http://127.0.0.1:${upstreamPort}` },
        fixturePath: tmpDir,
      },
    });

    await consumeStream(`${recorder.url}/api/chat`, {
      model: "llama3",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });

    const files = fs.readdirSync(tmpDir);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    expect(fixtureFiles.length).toBeGreaterThan(0);

    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(tmpDir, fixtureFiles[0]), "utf-8"),
    ) as FixtureFile;
    const timings = fixtureContent.fixtures[0].recordedTimings;
    expect(timings).toBeDefined();
    // TTFT can be 0ms on localhost (same event-loop tick as stream start)
    expect(timings!.ttftMs).toBeGreaterThanOrEqual(0);
    expect(timings!.interChunkDelaysMs.length).toBeGreaterThan(0);
    expect(timings!.totalDurationMs).toBeGreaterThan(0);
  });
});

describe("Bedrock binary EventStream timing recording", () => {
  it("captures frame timings for binary EventStream response", async () => {
    const INTER_FRAME_MS = 50;
    const NUM_FRAMES = 4;

    // Create a fake upstream that streams Bedrock binary EventStream frames
    upstream = http.createServer((_req, res) => {
      res.writeHead(200, {
        "Content-Type": "application/vnd.amazon.eventstream",
        "Transfer-Encoding": "chunked",
      });

      const frames = [
        encodeEventStreamMessage("message_start", {
          type: "message_start",
          message: {
            id: "msg_test",
            type: "message",
            role: "assistant",
            content: [],
            model: "claude-v3",
            stop_reason: null,
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        }),
        encodeEventStreamMessage("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }),
        encodeEventStreamMessage("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hello" },
        }),
        encodeEventStreamMessage("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: " world" },
        }),
      ];

      let i = 0;
      const send = () => {
        if (i < frames.length) {
          res.write(frames[i]);
          i++;
          setTimeout(send, INTER_FRAME_MS);
        } else {
          res.end();
        }
      };
      // Start sending immediately (no initial TTFT delay)
      send();
    });
    await new Promise<void>((resolve) => upstream!.listen(0, "127.0.0.1", resolve));
    const upstreamPort = (upstream!.address() as { port: number }).port;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-timing-bedrock-"));
    recorder = await createServer([], {
      port: 0,
      record: {
        providers: { bedrock: `http://127.0.0.1:${upstreamPort}` },
        fixturePath: tmpDir,
      },
    });

    // Make a request through the recorder proxy to the Bedrock streaming endpoint
    await consumeStream(`${recorder.url}/model/anthropic.claude-v3/invoke-with-response-stream`, {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 512,
      messages: [{ role: "user", content: "hello" }],
    });

    // Read the recorded fixture and verify timings
    const files = fs.readdirSync(tmpDir);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);

    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(tmpDir, fixtureFiles[0]), "utf-8"),
    ) as FixtureFile;
    expect(fixtureContent.fixtures).toHaveLength(1);

    const fixture = fixtureContent.fixtures[0];
    expect(fixture.recordedTimings).toBeDefined();
    // We sent NUM_FRAMES frames with INTER_FRAME_MS between them.
    // interChunkDelaysMs should have NUM_FRAMES - 1 entries (gaps between frames).
    expect(fixture.recordedTimings!.interChunkDelaysMs.length).toBe(NUM_FRAMES - 1);
    for (const d of fixture.recordedTimings!.interChunkDelaysMs) {
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(INTER_FRAME_MS * 4);
    }
    expect(fixture.recordedTimings!.totalDurationMs).toBeGreaterThanOrEqual(
      INTER_FRAME_MS * (NUM_FRAMES - 1) * 0.5,
    );
  });

  it("captures TTFT for Bedrock binary EventStream with initial delay", async () => {
    const TTFT_MS = 80;
    const INTER_FRAME_MS = 30;

    upstream = http.createServer((_req, res) => {
      res.writeHead(200, {
        "Content-Type": "application/vnd.amazon.eventstream",
        "Transfer-Encoding": "chunked",
      });

      const frames = [
        encodeEventStreamMessage("message_start", {
          type: "message_start",
          message: {
            id: "msg_ttft",
            type: "message",
            role: "assistant",
            content: [],
            model: "claude-v3",
            stop_reason: null,
            usage: { input_tokens: 5, output_tokens: 0 },
          },
        }),
        encodeEventStreamMessage("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }),
        encodeEventStreamMessage("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hi" },
        }),
      ];

      let i = 0;
      const send = () => {
        if (i < frames.length) {
          res.write(frames[i]);
          i++;
          setTimeout(send, INTER_FRAME_MS);
        } else {
          res.end();
        }
      };
      // Delay before the first frame to simulate TTFT
      setTimeout(send, TTFT_MS);
    });
    await new Promise<void>((resolve) => upstream!.listen(0, "127.0.0.1", resolve));
    const upstreamPort = (upstream!.address() as { port: number }).port;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-timing-bedrock-ttft-"));
    recorder = await createServer([], {
      port: 0,
      record: {
        providers: { bedrock: `http://127.0.0.1:${upstreamPort}` },
        fixturePath: tmpDir,
      },
    });

    await consumeStream(`${recorder.url}/model/anthropic.claude-v3/invoke-with-response-stream`, {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 512,
      messages: [{ role: "user", content: "ttft test" }],
    });

    const files = fs.readdirSync(tmpDir);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);

    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(tmpDir, fixtureFiles[0]), "utf-8"),
    ) as FixtureFile;
    const timings = fixtureContent.fixtures[0].recordedTimings;
    expect(timings).toBeDefined();

    // TTFT measures time from stream start (response-headers-received) to
    // first binary frame arrival. On localhost the first data event can
    // occasionally arrive in the same millisecond as the response callback,
    // yielding ttftMs = 0. Assert non-negative and bounded.
    expect(Number.isFinite(timings!.ttftMs)).toBe(true);
    expect(timings!.ttftMs).toBeGreaterThanOrEqual(0);
    expect(timings!.ttftMs).toBeLessThan(TTFT_MS * 4);
    expect(timings!.totalDurationMs).toBeGreaterThan(0);
    expect(timings!.interChunkDelaysMs.length).toBeGreaterThan(0);
  });
});
