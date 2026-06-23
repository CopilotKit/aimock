import { describe, it, expect, afterEach, vi } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createServer, type ServerInstance } from "../server.js";
import { Logger } from "../logger.js";
import { setProxyBufferHardCeilingForTests } from "../recorder.js";

// ---------------------------------------------------------------------------
// Proxy-path buffer cap ENFORCEMENT (per-frame + binary + non-streamed relay).
//
// These tests exercise the REAL proxyAndRecord/makeUpstreamRequest path via a
// local fake upstream and assert the cap is enforced MID-CHUNK (not just at the
// top of the data callback) and that the non-streamed over-cap path RELAYS the
// real body rather than synthesizing a 502.
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
  // Restore the real hard ceiling after any test that lowered it.
  setProxyBufferHardCeilingForTests(undefined);
  vi.restoreAllMocks();
});

/**
 * Upstream that delivers ALL `frameCount` complete SSE frames in a SINGLE
 * socket write (one coalesced `data` event from the recorder's perspective).
 * A2-style coalescing is the crux of the per-frame-cap bug: the top-of-callback
 * frame guard runs ONCE before the splitter pushes every frame, so a single
 * chunk overshoots `frameTimestamps` unboundedly unless the cap is checked
 * per-frame inside the splitter loop.
 */
function createCoalescedFrameSseUpstream(frameCount: number): Promise<string> {
  return new Promise((resolve) => {
    upstream = http.createServer((_req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      // One giant string: frameCount tiny frames, all in a single write.
      const frame = 'data: {"d":"a"}\n\n';
      res.write(frame.repeat(frameCount));
      res.write("data: [DONE]\n\n");
      res.end();
    });
    upstream.listen(0, "127.0.0.1", () => {
      const { port } = upstream!.address() as { port: number };
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

/**
 * Binary EventStream upstream that streams bytes which NEVER complete a frame:
 * each chunk starts with a 4-byte big-endian totalLen prefix that is larger
 * than anything that will ever arrive (so `binaryFrameBuffer.length < totalLen`
 * stays true forever) — modeling a never-completing / malformed binary frame.
 */
function createNeverCompletingBinaryUpstream(
  totalBytes: number,
  chunkBytes: number,
): Promise<string> {
  return new Promise((resolve) => {
    upstream = http.createServer((_req, res) => {
      res.writeHead(200, {
        "Content-Type": "application/vnd.amazon.eventstream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      // First 4 bytes: an enormous totalLen so the frame never completes.
      const header = Buffer.alloc(4);
      header.writeUInt32BE(0xfffffff0, 0);
      res.write(header);
      let sent = 4;
      const chunk = Buffer.alloc(chunkBytes, 0x41);
      const writeNext = () => {
        if (res.writableEnded || res.destroyed) return;
        if (sent >= totalBytes) {
          res.end();
          return;
        }
        sent += chunk.length;
        if (res.write(chunk)) setImmediate(writeNext);
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
 * Non-streamed (plain JSON, no SSE/NDJSON) upstream returning a body of
 * `totalBytes`. The whole body is fully received before the recorder decides
 * what to do — the over-cap path must RELAY it, not synthesize a 502.
 */
function createLargeJsonUpstream(totalBytes: number): Promise<string> {
  return new Promise((resolve) => {
    upstream = http.createServer((_req, res) => {
      const filler = "x".repeat(Math.max(0, totalBytes - 32));
      const body = JSON.stringify({ id: "resp_1", big: filler });
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      });
      res.end(body);
    });
    upstream.listen(0, "127.0.0.1", () => {
      const { port } = upstream!.address() as { port: number };
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

/**
 * Binary EventStream upstream that emits `frameCount` COMPLETE, well-formed
 * frames (4-byte big-endian totalLen prefix >= 12) packed into a SINGLE socket
 * write of exactly `frameCount * frameLen` bytes. Delivering the whole body in
 * one write means the recorder's `binaryFrameBuffer` concats it once and the
 * splitter drains every complete frame, leaving binaryFrameBuffer back at 0 —
 * isolating the byte-cap accounting (`bufferedBytes`) so the redundant
 * `+ chunk.length` double-count is the ONLY thing that can trip the cap early.
 */
function createCompleteBinaryFrameUpstream(frameCount: number, frameLen: number): Promise<string> {
  return new Promise((resolve) => {
    upstream = http.createServer((_req, res) => {
      res.writeHead(200, {
        "Content-Type": "application/vnd.amazon.eventstream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const frame = Buffer.alloc(frameLen, 0x41);
      frame.writeUInt32BE(frameLen, 0); // totalLen prefix == whole frame length
      // One write of the entire body so the recorder sees a single coalesced
      // chunk whose binary frames all complete (binaryFrameBuffer drains to 0).
      res.end(Buffer.concat(Array.from({ length: frameCount }, () => frame)));
    });
    upstream.listen(0, "127.0.0.1", () => {
      const { port } = upstream!.address() as { port: number };
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

/**
 * Non-streamed (plain JSON) upstream returning a body of `totalBytes` with a
 * caller-chosen status code. Used to prove the over-cap relay normalizes the
 * upstream status (success→200 / error→502) like every other relay path.
 */
function createLargeJsonUpstreamWithStatus(totalBytes: number, status: number): Promise<string> {
  return new Promise((resolve) => {
    upstream = http.createServer((_req, res) => {
      const filler = "x".repeat(Math.max(0, totalBytes - 32));
      const body = JSON.stringify({ id: "resp_1", big: filler });
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      });
      res.end(body);
    });
    upstream.listen(0, "127.0.0.1", () => {
      const { port } = upstream!.address() as { port: number };
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

/** Stream a POST and accumulate the relayed body length. */
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
        // Without a res-side error handler a mid-stream relay error hangs to
        // timeout — fail fast instead.
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

const NONSTREAM_REQUEST = {
  model: "gpt-4",
  messages: [{ role: "user", content: "give me a big json" }],
};

describe("proxy buffer cap enforcement", () => {
  // A1 — per-frame cap. A single coalesced chunk carrying many complete frames
  // must NOT overshoot the frame cap. The SSE/NDJSON splitter calls Date.now()
  // exactly once per complete frame it timestamps, so counting Date.now()
  // invocations during the request is a deterministic, GC-immune measure of how
  // many frames were pushed before truncation stopped the loop.
  it("A1: bounds per-frame timestamping on a single coalesced chunk of many frames", async () => {
    const FRAMES = 600_000; // all delivered in ONE coalesced socket write
    const BYTE_CAP = 256 * 1024 * 1024; // generous: only the frame cap can trip
    // Tiny frame cap: a single ~64 KB TCP segment holds ~3800 tiny frames, so
    // ONE coalesced data event already carries far more than the cap. Buggy
    // (top-of-callback-only) code timestamps every frame in that segment before
    // re-checking, massively overshooting; per-frame enforcement stops at ~cap.
    const FRAME_CAP = 100;

    const upstreamUrl = await createCoalescedFrameSseUpstream(FRAMES);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-a1-"));

    const warnings: string[] = [];
    vi.spyOn(Logger.prototype, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });

    // Count Date.now() calls — one per per-frame timestamp push.
    const realNow = Date.now.bind(Date);
    let nowCalls = 0;
    vi.spyOn(Date, "now").mockImplementation(() => {
      nowCalls++;
      return realNow();
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

    // Client still gets every byte.
    expect(resp.status).toBe(200);

    // The frame cap tripped and recording was skipped.
    const truncationWarn = warnings.find((w) => /frame cap/i.test(w));
    expect(truncationWarn).toBeDefined();
    expect(noFixtureWritten(tmpDir)).toBe(true);

    // RED on the buggy code: the cap is only checked at the TOP of the data
    // callback, so the single coalesced chunk's splitter loop pushes a
    // timestamp for ALL 600k frames before the next callback ever runs —
    // Date.now() is called ~600k times. GREEN: per-frame enforcement stops the
    // loop at the cap, so Date.now() is called only a few thousand times. Allow
    // generous slack (startTime + flush + a chunk-boundary's worth).

    console.log(`[A1] Date.now() calls (≈ frames timestamped): ${nowCalls}`);
    // Bound: cap + one segment's leftover slack + startTime/flush. A single TCP
    // segment is ~64 KB ≈ 3800 frames; per-frame enforcement caps the timestamp
    // count near FRAME_CAP, so well under 1000 total.
    expect(nowCalls).toBeLessThan(FRAME_CAP + 900);
  });

  // A2 — binary parse buffer must be counted toward the byte cap. On a
  // never-completing binary frame, `binaryFrameBuffer` is a SECOND, parallel
  // copy of every byte (Buffer.concat) that the buggy code does NOT count
  // toward `bufferedBytes`. The raw `chunks` array trips the byte cap, but only
  // AFTER `binaryFrameBuffer` has independently grown to ~the full cap's worth
  // of bytes — so peak memory is ~2× the cap. We spy on Buffer.concat to
  // capture the PEAK `binaryFrameBuffer` length: counting it toward the byte
  // cap makes truncation trip far sooner, bounding the parallel copy well below
  // the byte cap.
  it("A2: counts binaryFrameBuffer toward the byte cap so it cannot grow a full second copy", async () => {
    const TOTAL = 16 * 1024 * 1024; // 16 MB of bytes, never completing a frame
    const CHUNK = 64 * 1024;
    const BYTE_CAP = 512 * 1024; // low byte cap
    const FRAME_CAP = 5_000_000; // generous: frame cap cannot trip (no frames complete)

    const upstreamUrl = await createNeverCompletingBinaryUpstream(TOTAL, CHUNK);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-a2-"));

    const warnings: string[] = [];
    vi.spyOn(Logger.prototype, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });

    // Capture the peak size of any Buffer.concat result — the binary parse
    // buffer is rebuilt via Buffer.concat([binaryFrameBuffer, chunk]) each tick.
    const realConcat = Buffer.concat.bind(Buffer);
    let peakConcat = 0;
    vi.spyOn(Buffer, "concat").mockImplementation((list: readonly Uint8Array[], len?: number) => {
      const out = len === undefined ? realConcat(list) : realConcat(list, len);
      if (out.length > peakConcat) peakConcat = out.length;
      return out;
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

    expect(resp.status).toBe(200);

    // RED: binaryFrameBuffer grows uncounted to ~BYTE_CAP (512 KB) before the
    // chunks byte cap trips — a full parallel copy. GREEN: binaryFrameBuffer is
    // counted toward the byte cap, so truncation trips before it can grow a
    // full second copy; peak stays well under the byte cap.
    // RED: binaryFrameBuffer grows uncounted to ~BYTE_CAP (≈488 KB observed)
    // before the chunks byte cap trips — a near-full parallel copy, so total
    // peak ≈ 2× cap. GREEN: counting binaryFrameBuffer toward the byte cap
    // doubles the effective per-chunk accounting, tripping truncation at ~half
    // the data, so the parallel copy peaks well under half the byte cap.

    console.log(
      `[A2] peak binaryFrameBuffer (Buffer.concat): ${peakConcat} bytes (cap=${BYTE_CAP})`,
    );
    expect(peakConcat).toBeLessThan(BYTE_CAP * 0.6);

    const truncationWarn = warnings.find((w) => /byte cap/i.test(w));
    expect(truncationWarn).toBeDefined();

    // Recording skipped under truncation: no fixture written.
    expect(noFixtureWritten(tmpDir)).toBe(true);
  });

  // A3 — non-streamed over-cap must RELAY the received body, not 502.
  it("A3: relays the real non-streamed body when it exceeds the cap (no synthetic 502)", async () => {
    const TOTAL = 2 * 1024 * 1024; // 2 MB JSON
    const BYTE_CAP = 256 * 1024; // below the body size

    const upstreamUrl = await createLargeJsonUpstream(TOTAL);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-a3-"));

    recorder = await createServer([], {
      port: 0,
      logLevel: "warn",
      record: {
        providers: { openai: upstreamUrl },
        fixturePath: tmpDir,
        proxyOnly: true,
        maxProxyBufferBytes: BYTE_CAP,
      },
    });

    const resp = await postStreaming(recorder.url, NONSTREAM_REQUEST);

    // RED: buggy code returns 502 with a tiny synthetic error body. GREEN:
    // client gets 200 + the full real body relayed.

    console.log(`[A3] status=${resp.status} bytesReceived=${resp.bytesReceived}`);
    expect(resp.status).toBe(200);
    // The full real body is relayed (~TOTAL bytes), NOT a tiny ~129-byte
    // synthetic 502 JSON. Allow small slack for the JSON envelope overhead.
    expect(resp.bytesReceived).toBeGreaterThan(TOTAL - 1024);

    // Recording skipped (truncated), so no fixture written.
    expect(noFixtureWritten(tmpDir)).toBe(true);
  });

  // R2-B — the binary byte-cap must NOT double-count the current chunk.
  // `bufferedBytes` already includes `chunk.length` by the time the binary
  // guard runs, so the original `bufferedBytes + binaryFrameBuffer.length +
  // chunk.length > maxBufferBytes` trips ONE CHUNK EARLY. With complete frames
  // (binaryFrameBuffer drains to ~0 each tick) and a total exactly equal to the
  // cap, the corrected accounting must NOT trip, but the double-count does.
  //   RED: byte cap trips though total bytes == cap (off by one chunk);
  //        recording is skipped.
  //   GREEN: does NOT trip; the stream records normally (no byte-cap warning).
  it("R2-B: does not trip the binary byte cap one chunk early (no chunk double-count)", async () => {
    const FRAME_LEN = 64 * 1024; // 64 KiB complete frames
    const FRAMES = 7; // total == 448 KiB
    const BYTE_CAP = 512 * 1024; // 512 KiB — total (448 KiB) sits one full frame under the cap
    const FRAME_CAP = 5_000_000; // generous: frame cap cannot trip

    const upstreamUrl = await createCompleteBinaryFrameUpstream(FRAMES, FRAME_LEN);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-r2b-"));

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

    console.log(
      `[R2-B] status=${resp.status} bytesReceived=${resp.bytesReceived} cap=${BYTE_CAP} byteCapTripped=${warnings.some((w) => /byte cap/i.test(w))}`,
    );
    expect(resp.status).toBe(200);
    // RED: double-count trips the byte cap at the last chunk even though total
    // == cap. GREEN: the configured cap is reached exactly, not exceeded, so no
    // byte-cap truncation fires.
    expect(warnings.some((w) => /byte cap/i.test(w))).toBe(false);

    // Frame cap is generous and never trips either.
    expect(warnings.some((w) => /frame cap/i.test(w))).toBe(false);
  });

  // R2-A — a non-progressive body LARGER than the hard ceiling must NOT be
  // relayed as a truncated-but-2xx response. Lower the hard ceiling to a tiny
  // value so a small JSON body exceeds it (keeping the test fast). The
  // non-progressive buffer stops growing at the hard ceiling, so the buffered
  // copy is PARTIAL.
  //   RED: client receives a 2xx whose body is SHORTER than what upstream sent
  //        (truncated, presented as success) — the silent-truncation bug.
  //   GREEN: client receives a loud 502 ("exceeds proxy ceiling"), never a
  //        truncated 2xx. (A full pass-through relay would be the other
  //        acceptable outcome, but this fix chose fail-loud.)
  it("R2-A: never relays a truncated body as 2xx when upstream exceeds the hard ceiling", async () => {
    const HARD_CEILING = 64 * 1024; // tiny test-only ceiling
    const TOTAL = 1 * 1024 * 1024; // 1 MB body — far over the ceiling
    const BYTE_CAP = 16 * 1024; // soft cap below the ceiling too

    setProxyBufferHardCeilingForTests(HARD_CEILING);
    const upstreamUrl = await createLargeJsonUpstream(TOTAL);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-r2a-"));

    recorder = await createServer([], {
      port: 0,
      logLevel: "warn",
      record: {
        providers: { openai: upstreamUrl },
        fixturePath: tmpDir,
        proxyOnly: true,
        maxProxyBufferBytes: BYTE_CAP,
      },
    });

    const resp = await postStreaming(recorder.url, NONSTREAM_REQUEST);

    console.log(`[R2-A] status=${resp.status} bytesReceived=${resp.bytesReceived} (sent=${TOTAL})`);
    // GREEN invariant: never a truncated body presented as success. Either the
    // full body (>= TOTAL) or a loud error status. A 2xx with a body shorter
    // than upstream sent is the forbidden state.
    const truncatedAsSuccess =
      resp.status >= 200 && resp.status < 300 && resp.bytesReceived < TOTAL - 1024;
    expect(truncatedAsSuccess).toBe(false);
    // This fix chose fail-loud: a body over the ceiling returns 502.
    expect(resp.status).toBe(502);

    expect(noFixtureWritten(tmpDir)).toBe(true);
  });

  // R2-C — over-cap (under-ceiling) relay must NORMALIZE the upstream status
  // (success→200 / error→502) like every other relay path, not leak the raw
  // upstream code. Upstream returns a 503 body large enough to trip the soft
  // cap but small enough to stay under the hard ceiling.
  //   RED: client receives 503 verbatim.
  //   GREEN: client receives a normalized 502.
  it("R2-C: normalizes upstream status on the over-cap relay (503 -> 502)", async () => {
    const TOTAL = 2 * 1024 * 1024; // 2 MB — over the soft cap, under the ceiling
    const BYTE_CAP = 256 * 1024;

    const upstreamUrl = await createLargeJsonUpstreamWithStatus(TOTAL, 503);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-r2c-"));

    recorder = await createServer([], {
      port: 0,
      logLevel: "warn",
      record: {
        providers: { openai: upstreamUrl },
        fixturePath: tmpDir,
        proxyOnly: true,
        maxProxyBufferBytes: BYTE_CAP,
      },
    });

    const resp = await postStreaming(recorder.url, NONSTREAM_REQUEST);

    console.log(
      `[R2-C] upstream=503 relayedStatus=${resp.status} bytesReceived=${resp.bytesReceived}`,
    );
    // RED: 503 leaked verbatim. GREEN: normalized to 502.
    expect(resp.status).toBe(502);
    // Body is still relayed (full real upstream body, under the ceiling).
    expect(resp.bytesReceived).toBeGreaterThan(TOTAL - 1024);

    expect(noFixtureWritten(tmpDir)).toBe(true);
  });
});

/**
 * Walk `dir` recursively and return true when NO `.json` fixture exists
 * anywhere beneath it. persistFixture can write into `slug/` or `context/`
 * subdirectories, so a non-recursive readdir would go vacuously true even if a
 * fixture WERE written into a subdir.
 */
function noFixtureWritten(dir: string): boolean {
  if (!fs.existsSync(dir)) return true;
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.name.endsWith(".json")) {
        return false;
      }
    }
  }
  return true;
}
