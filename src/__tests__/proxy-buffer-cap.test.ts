import { describe, it, expect, afterEach, vi } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createServer, type ServerInstance } from "../server.js";
import { Logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Proxy-path upstream buffer cap.
//
// aimock proxies un-matched requests to a real upstream and (on that path)
// accumulates the entire streaming response in memory to collapse/journal it.
// With no size cap, a single very large proxied response builds a string that
// can exceed V8's max string length (~512MB), throwing
// `RangeError: Invalid string length`, and spikes the heap.
//
// These tests exercise the REAL proxyAndRecord/makeUpstreamRequest path via a
// real local fake-upstream HTTP server streaming a large SSE body, with a
// low test-only cap so the run stays fast.
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
  vi.restoreAllMocks();
});

/**
 * A raw upstream HTTP server that streams `frameCount` tiny complete SSE frames.
 * Total bytes stay small (each frame is ~tens of bytes) so the BYTE cap is never
 * the trigger — only the FRAME-COUNT cap can trip. This isolates the per-frame
 * state leak (`frameTimestamps` grows once per frame regardless of byte size).
 */
function createManyFrameSseUpstream(frameCount: number): Promise<string> {
  return new Promise((resolve) => {
    upstream = http.createServer((_req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      let sent = 0;
      const writeNext = () => {
        if (res.writableEnded || res.destroyed) return;
        if (sent >= frameCount) {
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        // A small batch per tick keeps the run fast while still flowing as
        // distinct frames through the recorder's delimiter splitter.
        let ok = true;
        for (let k = 0; k < 500 && sent < frameCount && ok; k++) {
          ok = res.write('data: {"delta":"a"}\n\n');
          sent++;
        }
        if (ok) setImmediate(writeNext);
        else res.once("drain", writeNext);
      };
      writeNext();
    });
    upstream.listen(0, "127.0.0.1", () => {
      const { port } = upstream!.address() as { port: number };
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

/**
 * A raw upstream HTTP server that streams an SSE body whose total size is
 * `totalBytes`, in fixed-size chunks. Each chunk is a valid SSE data frame so
 * the recorder's frame-splitting logic exercises normally.
 */
function createLargeSseUpstream(totalBytes: number, chunkBytes: number): Promise<string> {
  return new Promise((resolve) => {
    upstream = http.createServer((_req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      let sent = 0;
      // Each frame: `data: <payload>\n\n`. Payload is a run of 'x'.
      const overhead = "data: \n\n".length;
      const payloadLen = Math.max(1, chunkBytes - overhead);
      const writeNext = () => {
        if (sent >= totalBytes) {
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        const frame = `data: ${"x".repeat(payloadLen)}\n\n`;
        sent += Buffer.byteLength(frame);
        // Use setImmediate to let the client drain — avoids a single huge sync
        // write and mimics a real progressive stream.
        if (res.write(frame)) {
          setImmediate(writeNext);
        } else {
          res.once("drain", writeNext);
        }
      };
      writeNext();
    });
    upstream.listen(0, "127.0.0.1", () => {
      const { port } = upstream!.address() as { port: number };
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

/** Stream a POST and accumulate the relayed body length without buffering huge strings poorly. */
function postStreaming(
  url: string,
  body: unknown,
): Promise<{ status: number; bytesReceived: number }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let bytesReceived = 0;
        res.on("data", (c: Buffer) => {
          bytesReceived += c.length;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, bytesReceived }));
        // A mid-stream relay error must fail fast — without a res-side error
        // handler the unhandled 'error' would hang the request to timeout.
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

const CHAT_REQUEST = {
  model: "gpt-4",
  stream: true,
  messages: [{ role: "user", content: "stream me a lot" }],
};

describe("proxy-path upstream buffer cap", () => {
  it("relays the full streamed body to the client, does not throw, and bounds the in-memory buffer when the response exceeds the cap", async () => {
    // 4 MB total stream, 64 KB chunks, with a low 256 KB cap so the buffer is
    // forced to truncate well before the full body is accumulated. The client
    // must still receive every relayed byte.
    const TOTAL = 4 * 1024 * 1024;
    const CHUNK = 64 * 1024;
    const CAP = 256 * 1024;

    const upstreamUrl = await createLargeSseUpstream(TOTAL, CHUNK);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-bufcap-"));

    // Capture warnings so we can assert the truncation was logged.
    const warnings: string[] = [];
    vi.spyOn(Logger.prototype, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });

    recorder = await createServer([], {
      port: 0,
      logLevel: "warn",
      record: {
        providers: { openai: upstreamUrl },
        fixturePath: tmpDir,
        proxyOnly: true,
        maxProxyBufferBytes: CAP,
      },
    });

    const resp = await postStreaming(recorder.url, CHAT_REQUEST);

    // Client correctness: full relay regardless of cap.
    expect(resp.status).toBe(200);
    expect(resp.bytesReceived).toBeGreaterThanOrEqual(TOTAL);

    // The server must NOT have crashed with Invalid string length — if it had,
    // the relay would have been interrupted (already asserted above) and the
    // truncation warning would be absent. Assert the BYTE cap specifically:
    // the warning must name the byte cap, not the frame cap (the two are no
    // longer conflated).
    const truncationWarn = warnings.find((w) => /byte cap/i.test(w));
    expect(truncationWarn).toBeDefined();
    // And the frame cap must NOT be the one reported here.
    expect(warnings.some((w) => /frame cap/i.test(w))).toBe(false);

    // Recording skipped under proxy-only + truncation: no fixture written.
    if (fs.existsSync(tmpDir)) {
      const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".json"));
      expect(files).toHaveLength(0);
    }
  });

  it("records normally when the response stays under the cap", async () => {
    const TOTAL = 64 * 1024;
    const CHUNK = 8 * 1024;
    const CAP = 4 * 1024 * 1024;

    const upstreamUrl = await createLargeSseUpstream(TOTAL, CHUNK);

    recorder = await createServer([], {
      port: 0,
      record: {
        providers: { openai: upstreamUrl },
        proxyOnly: true,
        maxProxyBufferBytes: CAP,
      },
    });

    const resp = await postStreaming(recorder.url, CHAT_REQUEST);
    expect(resp.status).toBe(200);
    expect(resp.bytesReceived).toBeGreaterThanOrEqual(TOTAL);
  });

  // -------------------------------------------------------------------------
  // Per-frame state cap.
  //
  // `frameTimestamps` (and the SSE/EventStream parse buffers) accumulate once
  // PER FRAME for the lifetime of a proxied stream. The byte cap is
  // count-blind, so a long-lived / never-ending stream of small frames grows
  // this state UNBOUNDED even when the byte cap is generous. The frame-count
  // cap bounds it: truncation must trip on frame count even though total bytes
  // stay far below the byte cap, freeing the accumulated frame state and
  // skipping recording — while the client still receives every byte.
  // -------------------------------------------------------------------------
  it("trips truncation on frame COUNT (not bytes) for a many-frame stream, freeing per-frame state, while still relaying the full body", async () => {
    // 200k tiny frames (~4 MB total) with a generous 64 MiB byte cap so ONLY
    // the frame cap can trip, and a low 5k frame cap so it trips early.
    const FRAMES = 200_000;
    const BYTE_CAP = 64 * 1024 * 1024;
    const FRAME_CAP = 5_000;

    const upstreamUrl = await createManyFrameSseUpstream(FRAMES);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-framecap-"));

    const warnings: string[] = [];
    vi.spyOn(Logger.prototype, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });

    recorder = await createServer([], {
      port: 0,
      logLevel: "warn",
      record: {
        providers: { openai: upstreamUrl },
        fixturePath: tmpDir,
        proxyOnly: true,
        maxProxyBufferBytes: BYTE_CAP,
        maxProxyBufferFrames: FRAME_CAP,
      },
    });

    const resp = await postStreaming(recorder.url, CHAT_REQUEST);

    // Client correctness: full relay regardless of the frame cap. The total
    // body is well under the byte cap, so every byte must arrive.
    expect(resp.status).toBe(200);
    expect(resp.bytesReceived).toBeGreaterThan(FRAMES * 10); // ~20 bytes/frame

    // The FRAME cap (not the byte cap) tripped. The previous assertion
    // (/exceeded.*frames/i) was a tautology — the old conflated warning ALWAYS
    // contained the word "frames" regardless of which cap fired, so it passed
    // even if the frame-cap branch were deleted. Assert the specific
    // cap-tripped indicator instead: the warning must name the FRAME cap, and
    // the byte cap must NOT be the one reported (total bytes are far under it).
    const truncationWarn = warnings.find((w) => /frame cap/i.test(w));
    expect(truncationWarn).toBeDefined();
    expect(warnings.some((w) => /byte cap/i.test(w))).toBe(false);

    // Recording skipped under proxy-only + truncation: no fixture written
    // (proves the accumulated frame state was dropped, not journaled).
    if (fs.existsSync(tmpDir)) {
      const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".json"));
      expect(files).toHaveLength(0);
    }
  });

  it("records normally when the frame count stays under the frame cap", async () => {
    // A few hundred frames under a generous frame cap records as usual — the
    // frame cap must NOT break the normal multi-frame streaming/recording path.
    const FRAMES = 300;
    const FRAME_CAP = 5_000_000;

    const upstreamUrl = await createManyFrameSseUpstream(FRAMES);

    recorder = await createServer([], {
      port: 0,
      record: {
        providers: { openai: upstreamUrl },
        proxyOnly: true,
        maxProxyBufferFrames: FRAME_CAP,
      },
    });

    const resp = await postStreaming(recorder.url, CHAT_REQUEST);
    expect(resp.status).toBe(200);
    expect(resp.bytesReceived).toBeGreaterThan(FRAMES * 10);
  });
});
