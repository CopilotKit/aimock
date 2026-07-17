import { describe, it, expect, afterEach, vi } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AGUIMock } from "../agui-mock.js";
import { setAGUIRecordBufferCeilingForTests } from "../agui-recorder.js";
import { Logger } from "../logger.js";

// ---------------------------------------------------------------------------
// AG-UI record-buffer cap.
//
// The AG-UI recorder tees every upstream SSE chunk to the client AND buffers a
// copy so it can `Buffer.concat(chunks).toString()` + parse the events into a
// fixture once the stream ends. With no cap, a large upstream response builds a
// string past V8's ~512 MiB max string length and throws
// `RangeError: Invalid string length` (the ~1/sec prod crash). These tests
// exercise the REAL proxyAndRecordAGUI/teeUpstreamStream path via a raw local
// upstream streaming a large SSE body, with a low test-only cap so the run
// stays fast: the client must still receive every relayed byte, the server must
// not crash, and recording must be skipped (no fixture written).
// ---------------------------------------------------------------------------

let upstream: http.Server | undefined;
let agui: AGUIMock | undefined;
let tmpDir: string | undefined;

afterEach(async () => {
  if (agui) {
    try {
      await agui.stop();
    } catch {
      /* already stopped */
    }
    agui = undefined;
  }
  if (upstream) {
    await new Promise<void>((resolve) => upstream!.close(() => resolve()));
    upstream = undefined;
  }
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
  setAGUIRecordBufferCeilingForTests(undefined);
  vi.restoreAllMocks();
});

/**
 * A raw upstream that streams `totalBytes` of valid AG-UI SSE frames in
 * `chunkBytes`-sized frames, then closes. Each frame is a TEXT_MESSAGE_CONTENT
 * event so the recorder's SSE parser exercises normally under the cap.
 */
function createLargeAguiUpstream(totalBytes: number, chunkBytes: number): Promise<string> {
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
        if (sent >= totalBytes) {
          res.end();
          return;
        }
        const payload = JSON.stringify({
          type: "TEXT_MESSAGE_CONTENT",
          messageId: "m1",
          delta: "x".repeat(Math.max(1, chunkBytes)),
        });
        const frame = `data: ${payload}\n\n`;
        sent += Buffer.byteLength(frame);
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

/** Stream a POST and count relayed bytes without buffering a huge string. */
function postStreaming(url: string): Promise<{ status: number; bytesReceived: number }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      threadId: "t1",
      runId: "r1",
      messages: [{ id: "u1", role: "user", content: "stream me a lot" }],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    });
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
        let bytesReceived = 0;
        res.on("data", (c: Buffer) => {
          bytesReceived += c.length;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, bytesReceived }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

describe("AG-UI record-buffer cap", () => {
  it("relays the full streamed body, does not throw, and skips recording when over the cap", async () => {
    // 4 MB total, ~4 KB frames, with a low 256 KB test-only ceiling so the
    // buffer must truncate well before the full body accumulates. The client
    // must still receive every relayed byte.
    const TOTAL = 4 * 1024 * 1024;
    const CHUNK = 4 * 1024;
    setAGUIRecordBufferCeilingForTests(256 * 1024);

    const upstreamUrl = await createLargeAguiUpstream(TOTAL, CHUNK);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agui-bufcap-"));

    const warnings: string[] = [];
    vi.spyOn(Logger.prototype, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });

    agui = new AGUIMock({ port: 0, logLevel: "warn" });
    agui.enableRecording({ upstream: upstreamUrl, proxyOnly: false, fixturePath: tmpDir });
    await agui.start();

    const resp = await postStreaming(agui.url);

    // Client correctness: full relay regardless of the cap. If the server had
    // crashed with Invalid string length the relay would have been cut short.
    expect(resp.status).toBe(200);
    expect(resp.bytesReceived).toBeGreaterThanOrEqual(TOTAL);

    // The record-buffer cap tripped and recording was skipped.
    expect(warnings.some((w) => /record buffer cap/i.test(w))).toBe(true);

    // No fixture written (the partial buffer was dropped, not journaled).
    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(0);
  });

  it("records normally when the response stays under the cap", async () => {
    const TOTAL = 32 * 1024;
    const CHUNK = 4 * 1024;
    setAGUIRecordBufferCeilingForTests(4 * 1024 * 1024);

    const upstreamUrl = await createLargeAguiUpstream(TOTAL, CHUNK);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agui-bufcap-ok-"));

    agui = new AGUIMock({ port: 0 });
    agui.enableRecording({ upstream: upstreamUrl, proxyOnly: false, fixturePath: tmpDir });
    await agui.start();

    const resp = await postStreaming(agui.url);
    expect(resp.status).toBe(200);
    expect(resp.bytesReceived).toBeGreaterThanOrEqual(TOTAL);

    // Under the cap → a fixture IS written.
    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
  });
});
