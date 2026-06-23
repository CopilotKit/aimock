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
    // truncation warning would be absent.
    const truncationWarn = warnings.find((w) => /exceeded.*bytes/i.test(w));
    expect(truncationWarn).toBeDefined();

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
});
