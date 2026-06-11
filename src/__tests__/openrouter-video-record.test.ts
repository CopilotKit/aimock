import { describe, test, expect, afterAll, afterEach, vi } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LLMock } from "../llmock.js";
import type { RecordConfig } from "../types.js";
import { startRefusingUpstream } from "./helpers/refusing-upstream.js";

interface OpenRouterVideoUpstreamOptions {
  /** Terminal status the poll endpoint converges on. Default: "completed". */
  finalStatus?: "completed" | "failed" | "cancelled" | "expired";
  /** Non-terminal polls served before the terminal status. Default: 0. */
  pollsBeforeCompleted?: number;
  /** Bytes served by the content endpoint. Default: "stub video bytes". */
  videoBytes?: Buffer;
  /** usage.cost reported on completion. Default: 0.25. */
  cost?: number;
  /** error reported on failure. Default: "upstream generation failed". */
  error?: string;
  /** Origin used in unsigned_urls (off-origin capture tests). Default: self. */
  unsignedUrlOrigin?: string;
  /** Force the content endpoint to reply with this status (after auth). */
  contentStatus?: number;
  /** With a non-200 contentStatus: write the head + a partial body, never end. */
  stallContentBody?: boolean;
  /** Force the STATUS endpoint to reply with this HTTP status (JSON error body). */
  statusHttpStatus?: number;
  /** Force the SUBMIT endpoint to reply with this HTTP status (JSON error body). */
  submitHttpStatus?: number;
  /** Delay (ms) before the submit endpoint responds (mid-submit reset tests). */
  submitDelayMs?: number;
  /** Accept the submit request and never respond (socket hang). */
  hangOnSubmit?: boolean;
  /** Accept the status poll and never respond (socket hang). */
  hangOnStatus?: boolean;
  /** Accept the content request and never respond (socket hang). */
  hangOnContent?: boolean;
  /** Accept the models request and never respond (socket hang). */
  hangOnModels?: boolean;
  /** Serve content chunked, without a Content-Length header. */
  omitContentLength?: boolean;
  /** Delay (ms) before the content endpoint responds (capture-window tests). */
  contentDelayMs?: number;
  /** Delay (ms) before the status endpoint responds (client-abort tests). */
  statusDelayMs?: number;
  /** Full override of the TERMINAL status poll body. */
  statusBody?: (selfUrl: string, jobId: string) => Record<string, unknown>;
}

interface OpenRouterVideoUpstream {
  url: string;
  close: () => Promise<void>;
  /** `contentServed` counts content responses fully WRITTEN (vs. `content`,
   *  which counts arrivals) — capture-window tests use the gap between the
   *  two to prove a content fetch is still in flight. */
  counts: {
    submit: number;
    status: number;
    content: number;
    models: number;
    contentServed: number;
  };
  lastHeaders: {
    submit?: http.IncomingHttpHeaders;
    status?: http.IncomingHttpHeaders;
    content?: http.IncomingHttpHeaders;
    models?: http.IncomingHttpHeaders;
  };
}

const UPSTREAM_JOB_ID = "or-upstream-job-1";

function startOpenRouterVideoUpstream(
  opts: OpenRouterVideoUpstreamOptions,
): Promise<OpenRouterVideoUpstream> {
  const finalStatus = opts.finalStatus ?? "completed";
  const pollsBeforeCompleted = opts.pollsBeforeCompleted ?? 0;
  const videoBytes = opts.videoBytes ?? Buffer.from("stub video bytes");
  const cost = opts.cost ?? 0.25;
  const error = opts.error ?? "upstream generation failed";
  const counts = { submit: 0, status: 0, content: 0, models: 0, contentServed: 0 };
  const lastHeaders: OpenRouterVideoUpstream["lastHeaders"] = {};
  const statusPolls = new Map<string, number>();
  const contentRe = /^\/api\/v1\/videos\/([^/]+)\/content$/;
  const statusRe = /^\/api\/v1\/videos\/([^/]+)$/;

  return new Promise((resolve, reject) => {
    let selfUrl = "http://stub";
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const url = new URL(req.url ?? "/", selfUrl);
        const sendJson = (status: number, body: unknown) => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(body));
        };

        if (req.method === "POST" && url.pathname === "/api/v1/videos") {
          counts.submit++;
          lastHeaders.submit = req.headers;
          if (opts.hangOnSubmit) return; // accept, never respond
          const serveSubmit = (): void => {
            if (opts.submitHttpStatus !== undefined && opts.submitHttpStatus !== 200) {
              sendJson(opts.submitHttpStatus, {
                error: { message: "stub submit rejected", code: opts.submitHttpStatus },
              });
              return;
            }
            sendJson(200, {
              id: UPSTREAM_JOB_ID,
              polling_url: `${selfUrl}/api/v1/videos/${UPSTREAM_JOB_ID}`,
              status: "pending",
            });
          };
          if (opts.submitDelayMs) {
            setTimeout(serveSubmit, opts.submitDelayMs);
          } else {
            serveSubmit();
          }
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/v1/videos/models") {
          counts.models++;
          lastHeaders.models = req.headers;
          if (opts.hangOnModels) return; // accept, never respond
          // "upstream/model-1" can never come out of aimock's fixture-driven
          // synthesis — a verbatim relay is unambiguous.
          sendJson(200, { data: [{ id: "upstream/model-1", name: "upstream/model-1" }] });
          return;
        }

        const contentMatch = url.pathname.match(contentRe);
        if (req.method === "GET" && contentMatch) {
          counts.content++;
          lastHeaders.content = req.headers;
          if (opts.hangOnContent) return; // accept, never respond
          // Returns true when the response was fully WRITTEN (res.end) — the
          // stallContentBody branch never ends, so it must not count as
          // served (contentServed's invariant).
          const serveContent = (): boolean => {
            const auth = req.headers.authorization;
            if (!auth || !/^bearer\s+\S/i.test(auth)) {
              sendJson(401, { error: { message: "No auth credentials found", code: 401 } });
              return true;
            }
            if (opts.contentStatus !== undefined && opts.contentStatus !== 200) {
              res.writeHead(opts.contentStatus, { "Content-Type": "text/plain" });
              if (opts.stallContentBody) {
                res.write("partial error body"); // never end — mid-body stall
                return false;
              }
              res.end("stub content error");
              return true;
            }
            if (opts.omitContentLength) {
              // Explicit chunked transfer keeps Node from auto-computing a
              // Content-Length for the single-buffer body.
              res.writeHead(200, { "Content-Type": "video/mp4", "Transfer-Encoding": "chunked" });
              res.end(videoBytes);
              return true;
            }
            res.writeHead(200, {
              "Content-Type": "video/mp4",
              "Content-Length": videoBytes.length,
            });
            res.end(videoBytes);
            return true;
          };
          const runContent = (): void => {
            if (serveContent()) counts.contentServed++;
          };
          if (opts.contentDelayMs) {
            setTimeout(runContent, opts.contentDelayMs);
          } else {
            runContent();
          }
          return;
        }

        const statusMatch = url.pathname.match(statusRe);
        if (req.method === "GET" && statusMatch) {
          counts.status++;
          lastHeaders.status = req.headers;
          if (opts.hangOnStatus) return; // accept, never respond
          const serveStatus = (): void => {
            if (opts.statusHttpStatus !== undefined && opts.statusHttpStatus !== 200) {
              sendJson(opts.statusHttpStatus, {
                error: { message: "stub poll rejected", code: opts.statusHttpStatus },
              });
              return;
            }
            const jobId = statusMatch[1];
            const n = (statusPolls.get(jobId) ?? 0) + 1;
            statusPolls.set(jobId, n);
            if (n <= pollsBeforeCompleted) {
              sendJson(200, { id: jobId, status: n === 1 ? "pending" : "in_progress" });
              return;
            }
            if (opts.statusBody) {
              sendJson(200, opts.statusBody(selfUrl, jobId));
              return;
            }
            if (finalStatus === "completed") {
              const origin = opts.unsignedUrlOrigin ?? selfUrl;
              sendJson(200, {
                id: jobId,
                status: "completed",
                unsigned_urls: [`${origin}/api/v1/videos/${jobId}/content?index=0`],
                usage: { cost },
              });
              return;
            }
            if (finalStatus === "failed") {
              sendJson(200, { id: jobId, status: "failed", error });
              return;
            }
            sendJson(200, { id: jobId, status: finalStatus });
          };
          if (opts.statusDelayMs) {
            setTimeout(serveStatus, opts.statusDelayMs);
          } else {
            serveStatus();
          }
          return;
        }

        sendJson(404, { error: { message: "stub: unhandled", path: url.pathname } });
      });
    });
    // A listen failure (port exhaustion, EPERM sandboxes) must reject instead
    // of leaving the returned promise pending forever (mirrors the
    // refusing-upstream helper).
    server.once("error", reject);
    // Track sockets so close() can tear down hung (never-responded) requests
    // instead of waiting on them forever.
    const sockets = new Set<net.Socket>();
    server.on("connection", (s) => {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      selfUrl = `http://127.0.0.1:${port}`;
      resolve({
        url: selfUrl,
        counts,
        lastHeaders,
        close: () =>
          new Promise<void>((r) => {
            for (const s of sockets) s.destroy();
            server.close(() => r());
          }),
      });
    });
  });
}

// ─── Task 2: protocol-aware stub upstream ───────────────────────────────────
// Mirrors startFalQueueUpstream (fal.test.ts): a real http.createServer on
// 127.0.0.1:0 implementing the four OpenRouter video endpoints — submit,
// status poll (with configurable progression), content download (Bearer-
// gated), and the models listing. Tracks per-endpoint call counts and the
// last-received headers so tests can assert what hit the wire (and with
// which auth) vs. what was served from aimock's own state.

describe("startOpenRouterVideoUpstream (stub self-test)", () => {
  let upstream: Awaited<ReturnType<typeof startOpenRouterVideoUpstream>> | undefined;

  afterEach(async () => {
    await upstream?.close();
    upstream = undefined;
  });

  test("submit returns a pending envelope, counts the call, captures headers", async () => {
    upstream = await startOpenRouterVideoUpstream({});
    const res = await fetch(`${upstream.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sk-upstream" },
      body: JSON.stringify({ model: "bytedance/seedance-2.0", prompt: "a sunset" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe("or-upstream-job-1");
    expect(data.status).toBe("pending");
    expect(data.polling_url).toBe(`${upstream.url}/api/v1/videos/or-upstream-job-1`);
    expect(upstream.counts.submit).toBe(1);
    expect(upstream.lastHeaders.submit?.authorization).toBe("Bearer sk-upstream");
  });

  test("status polls advance pending → in_progress → completed with urls and cost", async () => {
    upstream = await startOpenRouterVideoUpstream({ pollsBeforeCompleted: 2, cost: 0.42 });
    const url = `${upstream.url}/api/v1/videos/or-upstream-job-1`;
    expect((await (await fetch(url)).json()).status).toBe("pending");
    expect((await (await fetch(url)).json()).status).toBe("in_progress");
    const done = await (await fetch(url)).json();
    expect(done.status).toBe("completed");
    expect(done.unsigned_urls).toEqual([
      `${upstream.url}/api/v1/videos/or-upstream-job-1/content?index=0`,
    ]);
    expect(done.usage).toEqual({ cost: 0.42 });
    expect(upstream.counts.status).toBe(3);
  });

  test("failed final status carries the error", async () => {
    upstream = await startOpenRouterVideoUpstream({ finalStatus: "failed", error: "nsfw" });
    const data = await (await fetch(`${upstream.url}/api/v1/videos/j1`)).json();
    expect(data.status).toBe("failed");
    expect(data.error).toBe("nsfw");
    expect(data.unsigned_urls).toBeUndefined();
  });

  test("content 401s without Bearer, serves bytes with it, captures headers", async () => {
    const bytes = Buffer.from("upstream stub video");
    upstream = await startOpenRouterVideoUpstream({ videoBytes: bytes });
    const noAuth = await fetch(`${upstream.url}/api/v1/videos/j1/content?index=0`);
    expect(noAuth.status).toBe(401);
    await noAuth.arrayBuffer(); // consume — avoid leaking the undici body stream
    const ok = await fetch(`${upstream.url}/api/v1/videos/j1/content?index=0`, {
      headers: { Authorization: "Bearer sk-x" },
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("video/mp4");
    expect(Buffer.from(await ok.arrayBuffer()).equals(bytes)).toBe(true);
    expect(upstream.counts.content).toBe(2);
    expect(upstream.lastHeaders.content?.authorization).toBe("Bearer sk-x");
  });

  test("contentStatus forces a content-endpoint failure", async () => {
    upstream = await startOpenRouterVideoUpstream({ contentStatus: 500 });
    const res = await fetch(`${upstream.url}/api/v1/videos/j1/content?index=0`, {
      headers: { Authorization: "Bearer sk-x" },
    });
    expect(res.status).toBe(500);
    await res.arrayBuffer(); // consume — avoid leaking the undici body stream
  });

  test("models endpoint serves a distinguishable listing and counts calls", async () => {
    upstream = await startOpenRouterVideoUpstream({});
    const res = await fetch(`${upstream.url}/api/v1/videos/models`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.data.map((m: { id: string }) => m.id)).toEqual(["upstream/model-1"]);
    expect(upstream.counts.models).toBe(1);
  });

  test("unsignedUrlOrigin overrides the origin of unsigned_urls", async () => {
    upstream = await startOpenRouterVideoUpstream({ unsignedUrlOrigin: "http://cdn.example" });
    const done = await (await fetch(`${upstream.url}/api/v1/videos/j1`)).json();
    expect(done.status).toBe("completed");
    expect(done.unsigned_urls[0].startsWith("http://cdn.example/api/v1/videos/j1/content")).toBe(
      true,
    );
  });
});

// ─── Task 1: record config surface ──────────────────────────────────────────

describe("OpenRouter video record — config acceptance", () => {
  let mock: LLMock | undefined;

  afterEach(async () => {
    await mock?.stop();
    mock = undefined;
  });

  test("LLMock accepts record.providers.openrouter and record.openRouterVideo", async () => {
    mock = new LLMock({
      port: 0,
      record: {
        providers: { openrouter: "https://openrouter.ai" },
        openRouterVideo: { maxContentBytes: 1024 },
      },
    });
    await mock.start();
    expect(mock.url).toMatch(/^http:/);
  });

  test("record.openRouterVideo is optional alongside the provider", async () => {
    mock = new LLMock({
      port: 0,
      record: { providers: { openrouter: "https://openrouter.ai" } },
    });
    await mock.start();
    expect(mock.url).toMatch(/^http:/);
  });
});

// ─── Task 3: submit record path (live interactive proxy) ────────────────────

// Deterministically-failing upstream: the port is held by a live
// connection-destroying server for the whole suite (no TOCTOU re-bind window).
const refusingUpstream = await startRefusingUpstream();
const UPSTREAM_DOWN_URL = refusingUpstream.url;
afterAll(() => refusingUpstream.close());

describe("OpenRouter video record — submit proxy", () => {
  let mock: LLMock | undefined;
  let upstream: Awaited<ReturnType<typeof startOpenRouterVideoUpstream>> | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await mock?.stop();
    mock = undefined;
    await upstream?.close();
    upstream = undefined;
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  function makeTmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "aimock-or-video-record-"));
  }

  test("proxies an unmatched submit and returns a mock-rewritten envelope", async () => {
    upstream = await startOpenRouterVideoUpstream({});
    tmpDir = makeTmpDir();
    mock = new LLMock({
      port: 0,
      record: { providers: { openrouter: upstream.url }, fixturePath: tmpDir },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer sk-test",
        "X-Test-Id": "rec-a",
      },
      body: JSON.stringify({ model: "bytedance/seedance-2.0", prompt: "record me" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    // Mock-rewritten: a fresh aimock jobId, never the upstream one.
    expect(typeof data.id).toBe("string");
    expect(data.id.length).toBeGreaterThan(0);
    expect(data.id).not.toBe("or-upstream-job-1");
    // polling_url points at the mock and carries the testId for header-less polls.
    expect(data.polling_url).toBe(`${mock.url}/api/v1/videos/${data.id}?testId=rec-a`);
    expect(data.status).toBe("pending");
    // Exactly one upstream submit; auth was forwarded.
    expect(upstream.counts.submit).toBe(1);
    expect(upstream.lastHeaders.submit?.authorization).toBe("Bearer sk-test");

    const entry = mock.journal
      .getAll()
      .find((e) => e.method === "POST" && e.path === "/api/v1/videos");
    expect(entry).toBeDefined();
    expect(entry!.response.status).toBe(200);
    expect(entry!.response.fixture).toBeNull();
    expect(entry!.response.source).toBe("proxy");
  });

  test("strict mode wins over record: 503, nothing proxied upstream", async () => {
    upstream = await startOpenRouterVideoUpstream({});
    tmpDir = makeTmpDir();
    mock = new LLMock({
      port: 0,
      strict: true,
      record: { providers: { openrouter: upstream.url }, fixturePath: tmpDir },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m/v", prompt: "no fixture" }),
    });
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("no_fixture_match");
    expect(upstream.counts.submit).toBe(0);
  });

  test("record without an openrouter provider warns and falls through to 404", async () => {
    tmpDir = makeTmpDir();
    mock = new LLMock({
      port: 0,
      logLevel: "warn",
      record: { providers: { openai: UPSTREAM_DOWN_URL }, fixturePath: tmpDir },
    });
    await mock.start();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m/v", prompt: "unrecorded prompt" }),
    });
    expect(res.status).toBe(404);
    expect(
      warnSpy.mock.calls.some((c) =>
        c.join(" ").includes('No upstream URL configured for provider "openrouter"'),
      ),
    ).toBe(true);
  });

  test("upstream connection failure returns 502 proxy_error and journals source proxy", async () => {
    tmpDir = makeTmpDir();
    mock = new LLMock({
      port: 0,
      logLevel: "silent",
      record: { providers: { openrouter: UPSTREAM_DOWN_URL }, fixturePath: tmpDir },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m/v", prompt: "dead upstream" }),
    });
    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data.error.type).toBe("proxy_error");

    const entry = mock.journal
      .getAll()
      .find((e) => e.method === "POST" && e.path === "/api/v1/videos");
    expect(entry).toBeDefined();
    expect(entry!.response.status).toBe(502);
    expect(entry!.response.source).toBe("proxy");
  });

  test("a matching fixture still replays without touching the upstream", async () => {
    upstream = await startOpenRouterVideoUpstream({});
    tmpDir = makeTmpDir();
    mock = new LLMock({
      port: 0,
      record: { providers: { openrouter: upstream.url }, fixturePath: tmpDir },
    });
    mock.addFixture({
      match: { userMessage: "already recorded", endpoint: "video" },
      response: { video: { id: "vid_r", status: "completed", b64: "AAAA" } },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m/v", prompt: "already recorded" }),
    });
    expect(res.status).toBe(200);
    expect(upstream.counts.submit).toBe(0);
  });
});

// ─── Task 4: poll record path + eager capture ───────────────────────────────

interface PlainContentHostOptions {
  /** Drip the body in chunks of this size (forces chunked transfer, no Content-Length). */
  chunkSize?: number;
  /** Delay (ms) between dripped chunks. Default: 0 (immediate). */
  chunkDelayMs?: number;
  /** Stop writing after this many bytes and go silent (mid-body stall). */
  stallAfterBytes?: number;
}

/** Plain off-origin content host: serves bytes WITHOUT requiring auth and
 *  records the headers it received, so tests can assert the capture fetch
 *  dropped the client's Authorization for a foreign origin. With `chunkSize`
 *  set it drips the body progressively (chunked, no Content-Length) and can
 *  stall mid-body — the timeout-semantics tests drive both shapes. Tracks
 *  sockets so close() tears down stalled (never-ended) responses instead of
 *  waiting on them forever. */
function startPlainContentHost(
  bytes: Buffer,
  opts: PlainContentHostOptions = {},
): Promise<{
  url: string;
  close: () => Promise<void>;
  lastHeaders: () => http.IncomingHttpHeaders | undefined;
  /** Timestamp of the moment the LAST response finished writing (res.end),
   *  or undefined while one is still dripping — streaming-relay tests use it
   *  to prove the client saw headers before the upstream finished. */
  finishedAt: () => number | undefined;
  /** Live connection count — relay-release tests assert it drops to zero. */
  openSockets: () => number;
}> {
  let last: http.IncomingHttpHeaders | undefined;
  let finished: number | undefined;
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      last = req.headers;
      finished = undefined;
      if (opts.chunkSize === undefined) {
        res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": bytes.length });
        res.end(bytes);
        finished = Date.now();
        return;
      }
      // Drip mode: progressive chunked writes, optionally stalling mid-body.
      res.writeHead(200, { "Content-Type": "video/mp4", "Transfer-Encoding": "chunked" });
      let offset = 0;
      const writeNext = (): void => {
        if (res.destroyed) return;
        if (opts.stallAfterBytes !== undefined && offset >= opts.stallAfterBytes) {
          return; // go silent — never end the response
        }
        if (offset >= bytes.length) {
          res.end();
          finished = Date.now();
          return;
        }
        const end = Math.min(offset + opts.chunkSize!, bytes.length);
        res.write(bytes.subarray(offset, end));
        offset = end;
        setTimeout(writeNext, opts.chunkDelayMs ?? 0);
      };
      writeNext();
    });
    // A listen failure must reject instead of leaving the returned promise
    // pending forever (mirrors startOpenRouterVideoUpstream).
    server.once("error", reject);
    const sockets = new Set<net.Socket>();
    server.on("connection", (s) => {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${port}`,
        lastHeaders: () => last,
        finishedAt: () => finished,
        openSockets: () => sockets.size,
        close: () =>
          new Promise<void>((r) => {
            for (const s of sockets) s.destroy();
            server.close(() => r());
          }),
      });
    });
  });
}

function readRecordedFixtureFiles(dir: string): { file: string; content: unknown }[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({
      file: f,
      content: JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")),
    }));
}

/**
 * Bounded retry until `cond` is truthy. The eager capture runs DETACHED from
 * the completed poll (round-3 A5), so tests await fixture persistence — and
 * any other capture side effect — through this deterministic signal instead
 * of assuming it completed synchronously with the relay.
 */
async function waitUntil(cond: () => boolean, timeoutMs = 5000, intervalMs = 20): Promise<void> {
  // Deadline computed via performance.now, NOT Date.now: several suites fake
  // Date (vi.useFakeTimers({ toFake: ["Date"] })) and jump the clock by tens
  // of minutes — a Date-based deadline would expire instantly (or never).
  // Those suites leave timers real, so the setTimeout interval below is safe.
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    if (cond()) return;
    if (performance.now() > deadline) {
      throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
    }
    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
}

describe("OpenRouter video record — poll proxy and eager capture", () => {
  let mock: LLMock | undefined;
  let upstream: Awaited<ReturnType<typeof startOpenRouterVideoUpstream>> | undefined;
  let contentHost: Awaited<ReturnType<typeof startPlainContentHost>> | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await mock?.stop();
    mock = undefined;
    await upstream?.close();
    upstream = undefined;
    await contentHost?.close();
    contentHost = undefined;
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  function makeTmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "aimock-or-video-poll-"));
  }

  async function startRecordingMock(upstreamUrl: string): Promise<LLMock> {
    tmpDir = makeTmpDir();
    const m = new LLMock({
      port: 0,
      logLevel: "silent",
      record: { providers: { openrouter: upstreamUrl }, fixturePath: tmpDir },
    });
    await m.start();
    return m;
  }

  async function submitRecordJob(
    m: LLMock,
    prompt: string,
  ): Promise<{ id: string; polling_url: string }> {
    const res = await fetch(`${m.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sk-test" },
      body: JSON.stringify({ model: "bytedance/seedance-2.0", prompt }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string; polling_url: string };
  }

  test("non-terminal polls are proxied 1:1 and relayed with the mock jobId", async () => {
    upstream = await startOpenRouterVideoUpstream({ pollsBeforeCompleted: 2 });
    mock = await startRecordingMock(upstream.url);
    const envelope = await submitRecordJob(mock, "slow record");

    const poll1 = await (await fetch(envelope.polling_url)).json();
    expect(poll1).toMatchObject({ id: envelope.id, status: "pending" });
    expect(upstream.counts.status).toBe(1);

    const poll2 = await (await fetch(envelope.polling_url)).json();
    expect(poll2).toMatchObject({ id: envelope.id, status: "in_progress" });
    expect(upstream.counts.status).toBe(2);

    // Proxied polls journal source "proxy".
    const pollEntries = mock.journal
      .getAll()
      .filter((e) => e.method === "GET" && e.path.startsWith(`/api/v1/videos/${envelope.id}`));
    expect(pollEntries).toHaveLength(2);
    for (const e of pollEntries) {
      expect(e.response.status).toBe(200);
      expect(e.response.source).toBe("proxy");
    }
  });

  test("completed poll captures the fixture eagerly and rewrites unsigned_urls", async () => {
    const bytes = Buffer.from("recorded video payload");
    upstream = await startOpenRouterVideoUpstream({ videoBytes: bytes, cost: 0.42 });
    mock = await startRecordingMock(upstream.url);
    const envelope = await submitRecordJob(mock, "capture me");

    const pollRes = await fetch(envelope.polling_url, {
      headers: { Authorization: "Bearer poll-key" },
    });
    expect(pollRes.status).toBe(200);
    const poll = await pollRes.json();
    expect(poll.id).toBe(envelope.id);
    expect(poll.status).toBe("completed");
    // unsigned_urls rewritten to the mock; usage.cost passed through.
    expect(poll.unsigned_urls).toEqual([
      `${mock.url}/api/v1/videos/${envelope.id}/content?index=0`,
    ]);
    expect(poll.usage).toEqual({ cost: 0.42 });

    // The capture runs detached from the relayed poll — await its
    // deterministic completion signal (the persisted fixture file).
    await waitUntil(() => readRecordedFixtureFiles(tmpDir!).length === 1);

    // Eager capture fetched the content server-side with the poller's Bearer
    // (same-origin), without waiting for the client to download.
    expect(upstream.counts.content).toBe(1);
    expect(upstream.lastHeaders.content?.authorization).toBe("Bearer poll-key");

    // Fixture file on disk with the EXACT documented shape.
    const files = readRecordedFixtureFiles(tmpDir!);
    expect(files).toHaveLength(1);
    const saved = files[0].content as { fixtures: unknown[] };
    expect(saved.fixtures).toHaveLength(1);
    expect(saved.fixtures[0]).toEqual({
      match: {
        endpoint: "video",
        userMessage: "capture me",
        model: "bytedance/seedance-2.0",
      },
      response: {
        video: {
          id: "or-upstream-job-1",
          status: "completed",
          b64: bytes.toString("base64"),
          cost: 0.42,
        },
      },
    });

    // The mutated in-memory job serves the real bytes via the mock content URL.
    const download = await fetch(poll.unsigned_urls[0], {
      headers: { Authorization: "Bearer poll-key" },
    });
    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer()).equals(bytes)).toBe(true);

    // In-memory fixtures updated: a second identical submit replays without
    // touching the upstream again.
    const second = await submitRecordJob(mock!, "capture me");
    expect(upstream.counts.submit).toBe(1);
    const secondPoll = await (await fetch(second.polling_url)).json();
    expect(secondPoll.status).toBe("completed");
    expect(upstream.counts.status).toBe(1);
  });

  test("post-capture polls of the captured terminal job no longer hit the upstream", async () => {
    const bytes = Buffer.from("poll after done bytes");
    upstream = await startOpenRouterVideoUpstream({ videoBytes: bytes });
    mock = await startRecordingMock(upstream.url);
    const envelope = await submitRecordJob(mock, "poll after done");

    // Authed poll: the eager capture forwards the Bearer and succeeds.
    await (
      await fetch(envelope.polling_url, { headers: { Authorization: "Bearer poll-key" } })
    ).arrayBuffer();
    await waitUntil(() => readRecordedFixtureFiles(tmpDir!).length === 1);
    expect(upstream.counts.status).toBe(1);
    expect(upstream.counts.content).toBe(1);
    const files = readRecordedFixtureFiles(tmpDir!);
    const saved = files[0].content as {
      fixtures: { response: { video: { b64?: string } } }[];
    };
    expect(saved.fixtures[0].response.video.b64).toBe(bytes.toString("base64"));

    const again = await (await fetch(envelope.polling_url)).json();
    expect(again.status).toBe("completed");
    expect(upstream.counts.status).toBe(1); // served from the mutated replay job
  });

  test("an auth-less completed poll fails the capture (upstream 401) without persisting — an authed retry captures", async () => {
    // Round-4 B3 pin update: a capture-fetch failure used to persist a
    // b64-less fixture and terminalize (placeholder forever). It now persists
    // NOTHING and leaves the job a live proxy so the next completed poll
    // retries the capture.
    const bytes = Buffer.from("retry after auth bytes");
    upstream = await startOpenRouterVideoUpstream({ videoBytes: bytes });
    tmpDir = makeTmpDir();
    mock = new LLMock({
      port: 0,
      logLevel: "warn",
      record: { providers: { openrouter: upstream.url }, fixturePath: tmpDir },
    });
    await mock.start();
    const envelope = await submitRecordJob(mock, "auth-less poll");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // No Authorization on the poll → the capture fetch carries no Bearer and
    // the upstream content endpoint 401s — the capture-failure path.
    const poll = await (await fetch(envelope.polling_url)).json();
    expect(poll.status).toBe("completed");
    await waitUntil(() => warnSpy.mock.calls.some((c) => c.join(" ").includes("capture failed")));
    // The failure warn names the upstream status AND carries a bounded body
    // sample (round-6 pin) — a bare "Content 401" is not diagnosable.
    const failLine = warnSpy.mock.calls
      .map((c) => c.join(" "))
      .find((l) => l.includes("capture failed"));
    expect(failLine).toContain("Content 401");
    expect(failLine).toContain("No auth credentials found");

    // NOTHING persisted; the job stayed a live proxy (not terminalized).
    expect(readRecordedFixtureFiles(tmpDir!)).toHaveLength(0);

    // The next completed poll — this time with auth — retries the capture
    // and succeeds with the real bytes.
    const again = await (
      await fetch(envelope.polling_url, { headers: { Authorization: "Bearer sk-retry" } })
    ).json();
    expect(again.status).toBe("completed");
    expect(upstream.counts.status).toBe(2); // still proxying — job was never terminalized
    await waitUntil(() => readRecordedFixtureFiles(tmpDir!).length === 1);
    const saved = readRecordedFixtureFiles(tmpDir!)[0].content as {
      fixtures: { response: { video: { b64?: string } } }[];
    };
    expect(saved.fixtures[0].response.video.b64).toBe(bytes.toString("base64"));
  });

  test("failed upstream job persists a failed fixture and relays the error", async () => {
    upstream = await startOpenRouterVideoUpstream({
      finalStatus: "failed",
      error: "content policy violation",
    });
    mock = await startRecordingMock(upstream.url);
    const envelope = await submitRecordJob(mock, "doomed record");

    const poll = await (await fetch(envelope.polling_url)).json();
    expect(poll.id).toBe(envelope.id);
    expect(poll.status).toBe("failed");
    expect(poll.error).toBe("content policy violation");

    const files = readRecordedFixtureFiles(tmpDir!);
    expect(files).toHaveLength(1);
    const saved = files[0].content as {
      fixtures: { response: { video: Record<string, unknown> } }[];
    };
    expect(saved.fixtures[0].response).toEqual({
      video: { id: "or-upstream-job-1", status: "failed", error: "content policy violation" },
    });

    // Terminal conversion: the next poll is served from memory.
    const again = await (await fetch(envelope.polling_url)).json();
    expect(again.status).toBe("failed");
    expect(again.error).toBe("content policy violation");
    expect(upstream.counts.status).toBe(1);
  });

  test("off-origin unsigned_urls are fetched WITHOUT the client's auth, with a warn", async () => {
    const bytes = Buffer.from("cdn-hosted video");
    contentHost = await startPlainContentHost(bytes);
    upstream = await startOpenRouterVideoUpstream({ unsignedUrlOrigin: contentHost.url });
    tmpDir = makeTmpDir();
    mock = new LLMock({
      port: 0,
      logLevel: "warn",
      record: { providers: { openrouter: upstream.url }, fixturePath: tmpDir },
    });
    await mock.start();
    const envelope = await submitRecordJob(mock, "cdn capture");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const poll = await (
      await fetch(envelope.polling_url, { headers: { Authorization: "Bearer poll-key" } })
    ).json();
    expect(poll.status).toBe("completed");
    await waitUntil(() => readRecordedFixtureFiles(tmpDir!).length === 1);

    // The capture fetch went to the off-origin host WITHOUT Authorization.
    expect(contentHost.lastHeaders()).toBeDefined();
    expect(contentHost.lastHeaders()!.authorization).toBeUndefined();
    expect(
      warnSpy.mock.calls.some((c) => {
        const line = c.join(" ");
        return line.includes("differs from the provider origin") && line.includes("Authorization");
      }),
    ).toBe(true);

    // The bytes were still captured into the fixture.
    const files = readRecordedFixtureFiles(tmpDir!);
    const saved = files[0].content as {
      fixtures: { response: { video: { b64?: string } } }[];
    };
    expect(saved.fixtures[0].response.video.b64).toBe(bytes.toString("base64"));
  });

  test("a content-fetch 500 fails the capture without persisting; the next poll retries and captures", async () => {
    // Round-4 B3 (red-green): a transient content-fetch failure must not
    // poison the fixture set with a permanent b64-less placeholder. The job
    // stays a live proxy; once the upstream serves bytes, the next completed
    // poll captures the real fixture.
    const bytes = Buffer.from("eventually served bytes");
    const stubOpts: Parameters<typeof startOpenRouterVideoUpstream>[0] = {
      contentStatus: 500,
      videoBytes: bytes,
    };
    upstream = await startOpenRouterVideoUpstream(stubOpts);
    tmpDir = makeTmpDir();
    mock = new LLMock({
      port: 0,
      logLevel: "warn",
      record: { providers: { openrouter: upstream.url }, fixturePath: tmpDir },
    });
    await mock.start();
    const envelope = await submitRecordJob(mock, "capture fails");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const poll = await (
      await fetch(envelope.polling_url, { headers: { Authorization: "Bearer poll-key" } })
    ).json();
    expect(poll.status).toBe("completed");
    expect(poll.unsigned_urls).toEqual([
      `${mock.url}/api/v1/videos/${envelope.id}/content?index=0`,
    ]);
    await waitUntil(() =>
      warnSpy.mock.calls.some((c) => c.join(" ").includes("content capture failed")),
    );

    // NO fixture persisted (was: b64-less fixture + terminalized job).
    expect(readRecordedFixtureFiles(tmpDir!)).toHaveLength(0);

    // The upstream recovers; the next completed poll retries the capture.
    stubOpts.contentStatus = 200;
    const again = await (
      await fetch(envelope.polling_url, { headers: { Authorization: "Bearer poll-key" } })
    ).json();
    expect(again.status).toBe("completed");
    await waitUntil(() => readRecordedFixtureFiles(tmpDir!).length === 1);
    const saved = readRecordedFixtureFiles(tmpDir!)[0].content as {
      fixtures: { response: { video: { b64?: string; status: string } } }[];
    };
    expect(saved.fixtures[0].response.video.status).toBe("completed");
    expect(saved.fixtures[0].response.video.b64).toBe(bytes.toString("base64"));

    // The captured job now serves the REAL bytes (not a placeholder).
    const download = await fetch(poll.unsigned_urls[0], {
      headers: { Authorization: "Bearer poll-key" },
    });
    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer()).equals(bytes)).toBe(true);
  });

  test("cancelled upstream status passes through, warns, and records no fixture", async () => {
    upstream = await startOpenRouterVideoUpstream({ finalStatus: "cancelled" });
    tmpDir = makeTmpDir();
    mock = new LLMock({
      port: 0,
      logLevel: "warn",
      record: { providers: { openrouter: upstream.url }, fixturePath: tmpDir },
    });
    await mock.start();
    const envelope = await submitRecordJob(mock, "cancelled record");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const poll = await (await fetch(envelope.polling_url)).json();
    expect(poll.id).toBe(envelope.id);
    expect(poll.status).toBe("cancelled");
    expect(warnSpy.mock.calls.some((c) => c.join(" ").includes("not representable"))).toBe(true);

    // No fixture written; subsequent polls keep proxying live (1:1).
    expect(readRecordedFixtureFiles(tmpDir!)).toHaveLength(0);
    const again = await (await fetch(envelope.polling_url)).json();
    expect(again.status).toBe("cancelled");
    expect(upstream.counts.status).toBe(2);
  });

  test("upstream poll failure returns 502 proxy_error journaled as proxy", async () => {
    upstream = await startOpenRouterVideoUpstream({});
    mock = await startRecordingMock(upstream.url);
    const envelope = await submitRecordJob(mock, "upstream dies");
    await upstream.close();
    upstream = undefined;

    const poll = await fetch(envelope.polling_url);
    expect(poll.status).toBe(502);
    expect((await poll.json()).error.type).toBe("proxy_error");
    const entry = mock.journal
      .getAll()
      .find((e) => e.method === "GET" && e.path.startsWith(`/api/v1/videos/${envelope.id}`));
    expect(entry).toBeDefined();
    expect(entry!.response.status).toBe(502);
    expect(entry!.response.source).toBe("proxy");
  });
});

// ─── Task 5: full record → replay round trip ────────────────────────────────

describe("OpenRouter video record — round trip (record session then replay session)", () => {
  let recordMock: LLMock | undefined;
  let replayMock: LLMock | undefined;
  let upstream: Awaited<ReturnType<typeof startOpenRouterVideoUpstream>> | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    await recordMock?.stop();
    recordMock = undefined;
    await replayMock?.stop();
    replayMock = undefined;
    await upstream?.close();
    upstream = undefined;
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  async function recordLifecycle(prompt: string): Promise<void> {
    if (!recordMock) throw new Error("record mock not started");
    const submit = await fetch(`${recordMock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sk-rec" },
      body: JSON.stringify({ model: "bytedance/seedance-2.0", prompt }),
    });
    expect(submit.status).toBe(200);
    const envelope = (await submit.json()) as { polling_url: string };
    // Poll (with auth, like a real client) until the proxied job terminates.
    for (let i = 0; i < 10; i++) {
      const poll = await (
        await fetch(envelope.polling_url, { headers: { Authorization: "Bearer sk-rec" } })
      ).json();
      if (poll.status === "completed" || poll.status === "failed") return;
    }
    throw new Error("record lifecycle did not terminate");
  }

  test("completed lifecycle round-trips: byte-equal content, equal cost, Bearer still enforced", async () => {
    const bytes = Buffer.from([0x00, 0x01, 0x02, 0xfe, 0xff, 0x41, 0x42, 0x43, 0x00]);
    upstream = await startOpenRouterVideoUpstream({
      videoBytes: bytes,
      cost: 1.23,
      pollsBeforeCompleted: 1,
    });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-or-video-roundtrip-"));

    // ── Session 1: record ──
    recordMock = new LLMock({
      port: 0,
      logLevel: "silent",
      record: { providers: { openrouter: upstream.url }, fixturePath: tmpDir },
    });
    await recordMock.start();
    await recordLifecycle("round trip render");
    // The capture is detached from the completed poll — wait for the fixture
    // to land on disk before tearing the recording session down.
    await waitUntil(() => readRecordedFixtureFiles(tmpDir!).length === 1);
    await recordMock.stop();
    recordMock = undefined;
    await upstream.close();
    upstream = undefined;

    // ── Session 2: replay from the recorded fixture file only ──
    replayMock = new LLMock({ port: 0 });
    replayMock.loadFixtureDir(tmpDir);
    await replayMock.start();

    const submit = await fetch(`${replayMock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "bytedance/seedance-2.0", prompt: "round trip render" }),
    });
    expect(submit.status).toBe(200);
    const envelope = (await submit.json()) as { id: string; polling_url: string };

    const poll = await (await fetch(envelope.polling_url)).json();
    expect(poll.status).toBe("completed");
    expect(poll.usage).toEqual({ cost: 1.23 });
    expect(poll.unsigned_urls).toHaveLength(1);

    // Replayed content still requires Bearer auth.
    const unauthorized = await fetch(poll.unsigned_urls[0]);
    expect(unauthorized.status).toBe(401);

    const download = await fetch(poll.unsigned_urls[0], {
      headers: { Authorization: "Bearer sk-replay" },
    });
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("video/mp4");
    const replayed = Buffer.from(await download.arrayBuffer());
    expect(replayed.equals(bytes)).toBe(true);
  });

  test("failed lifecycle round-trips with the same error", async () => {
    upstream = await startOpenRouterVideoUpstream({
      finalStatus: "failed",
      error: "model exploded",
    });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-or-video-roundtrip-"));

    recordMock = new LLMock({
      port: 0,
      logLevel: "silent",
      record: { providers: { openrouter: upstream.url }, fixturePath: tmpDir },
    });
    await recordMock.start();
    await recordLifecycle("round trip failure");
    await recordMock.stop();
    recordMock = undefined;
    await upstream.close();
    upstream = undefined;

    replayMock = new LLMock({ port: 0 });
    replayMock.loadFixtureDir(tmpDir);
    await replayMock.start();

    const submit = await fetch(`${replayMock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "bytedance/seedance-2.0", prompt: "round trip failure" }),
    });
    expect(submit.status).toBe(200);
    const envelope = (await submit.json()) as { polling_url: string };

    const poll = await (await fetch(envelope.polling_url)).json();
    expect(poll.status).toBe("failed");
    expect(poll.error).toBe("model exploded");
    expect(poll.unsigned_urls).toBeUndefined();
  });
});

// ─── Task 6: b64 capture cap ────────────────────────────────────────────────

describe("OpenRouter video record — maxContentBytes cap", () => {
  let mock: LLMock | undefined;
  let upstream: Awaited<ReturnType<typeof startOpenRouterVideoUpstream>> | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await mock?.stop();
    mock = undefined;
    await upstream?.close();
    upstream = undefined;
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  test("default cap is 32 MB decoded and exported from the package root", async () => {
    // The CHANGELOG promises this constant on the public surface — import it
    // from the package root, not the internal module.
    const { OPENROUTER_VIDEO_DEFAULT_MAX_CONTENT_BYTES } = await import("../index.js");
    expect(OPENROUTER_VIDEO_DEFAULT_MAX_CONTENT_BYTES).toBe(32 * 1024 * 1024);
  });

  test("undeclared-length over-cap capture aborts the streamed read at the cap — placeholder even same-session", async () => {
    const bytes = Buffer.alloc(24, 0x61); // 24 bytes > 16-byte cap
    // No Content-Length declared: the capture streams the body and counts
    // bytes as they arrive, aborting at the cap. DELIBERATE behavior change
    // (round-2 CR B10): the over-cap bytes are no longer retained in memory
    // for the recording session — the cap is a memory guard as well as a disk
    // guard, so the same-session job serves the placeholder like the
    // declared-length skip path.
    upstream = await startOpenRouterVideoUpstream({ videoBytes: bytes, omitContentLength: true });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-or-video-cap-"));
    mock = new LLMock({
      port: 0,
      logLevel: "warn",
      record: {
        providers: { openrouter: upstream.url },
        fixturePath: tmpDir,
        openRouterVideo: { maxContentBytes: 16 },
      },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sk-cap" },
      body: JSON.stringify({ model: "bytedance/seedance-2.0", prompt: "oversized render" }),
    });
    const envelope = (await submit.json()) as { id: string; polling_url: string };

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const poll = await (
      await fetch(envelope.polling_url, { headers: { Authorization: "Bearer sk-cap" } })
    ).json();
    expect(poll.status).toBe("completed");
    await waitUntil(() => readRecordedFixtureFiles(tmpDir!).length === 1);
    expect(warnSpy.mock.calls.some((c) => c.join(" ").includes("maxContentBytes"))).toBe(true);

    // Fixture persisted WITHOUT b64, with a _warning in the file.
    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    const saved = JSON.parse(fs.readFileSync(path.join(tmpDir, files[0]), "utf-8")) as {
      fixtures: { response: { video: { b64?: string } } }[];
      _warning?: string;
    };
    expect(saved.fixtures[0].response.video.b64).toBeUndefined();
    expect(saved._warning).toContain("maxContentBytes");

    // SAME-SESSION content serves the placeholder: the streamed read aborted
    // at the cap, so nothing oversized was retained in memory.
    const download = await fetch(poll.unsigned_urls[0], {
      headers: { Authorization: "Bearer sk-cap" },
    });
    expect(download.status).toBe(200);
    const sameSession = Buffer.from(await download.arrayBuffer());
    expect(sameSession.equals(bytes)).toBe(false);
    expect(sameSession.subarray(4, 8).toString("ascii")).toBe("ftyp"); // placeholder MP4

    // Replay-from-fixture (second identical submit) serves the placeholder.
    const second = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "bytedance/seedance-2.0", prompt: "oversized render" }),
    });
    const secondEnvelope = (await second.json()) as { id: string };
    expect(upstream.counts.submit).toBe(1); // replayed, not proxied
    const secondDownload = await fetch(
      `${mock.url}/api/v1/videos/${secondEnvelope.id}/content?index=0`,
      { headers: { Authorization: "Bearer sk-cap" } },
    );
    expect(secondDownload.status).toBe(200);
    const body = Buffer.from(await secondDownload.arrayBuffer());
    expect(body.equals(bytes)).toBe(false);
    expect(body.subarray(4, 8).toString("ascii")).toBe("ftyp"); // placeholder MP4
  });

  test("maxContentBytes: 0 disables the cap entirely", async () => {
    const bytes = Buffer.alloc(64, 0x62);
    upstream = await startOpenRouterVideoUpstream({ videoBytes: bytes });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-or-video-cap-"));
    mock = new LLMock({
      port: 0,
      logLevel: "silent",
      record: {
        providers: { openrouter: upstream.url },
        fixturePath: tmpDir,
        openRouterVideo: { maxContentBytes: 0 },
      },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sk-cap" },
      body: JSON.stringify({ model: "bytedance/seedance-2.0", prompt: "unlimited render" }),
    });
    const envelope = (await submit.json()) as { polling_url: string };
    await (
      await fetch(envelope.polling_url, { headers: { Authorization: "Bearer sk-cap" } })
    ).arrayBuffer();
    await waitUntil(() => readRecordedFixtureFiles(tmpDir!).length === 1);

    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".json"));
    const saved = JSON.parse(fs.readFileSync(path.join(tmpDir, files[0]), "utf-8")) as {
      fixtures: { response: { video: { b64?: string } } }[];
    };
    expect(saved.fixtures[0].response.video.b64).toBe(bytes.toString("base64"));
  });

  test("a declared over-cap Content-Length skips the download entirely — placeholder even same-session", async () => {
    const bytes = Buffer.alloc(24, 0x63); // 24 bytes > 16-byte cap, Content-Length declared
    upstream = await startOpenRouterVideoUpstream({ videoBytes: bytes });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-or-video-cap-"));
    mock = new LLMock({
      port: 0,
      logLevel: "warn",
      record: {
        providers: { openrouter: upstream.url },
        fixturePath: tmpDir,
        openRouterVideo: { maxContentBytes: 16 },
      },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sk-cl" },
      body: JSON.stringify({ model: "bytedance/seedance-2.0", prompt: "declared oversize" }),
    });
    const envelope = (await submit.json()) as { id: string; polling_url: string };

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const poll = await (
      await fetch(envelope.polling_url, { headers: { Authorization: "Bearer sk-cl" } })
    ).json();
    expect(poll.status).toBe("completed");
    await waitUntil(() => readRecordedFixtureFiles(tmpDir!).length === 1);
    expect(warnSpy.mock.calls.some((c) => c.join(" ").includes("maxContentBytes"))).toBe(true);

    // Fixture persisted WITHOUT b64, with a _warning.
    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    const saved = JSON.parse(fs.readFileSync(path.join(tmpDir, files[0]), "utf-8")) as {
      fixtures: { response: { video: { b64?: string } } }[];
      _warning?: string;
    };
    expect(saved.fixtures[0].response.video.b64).toBeUndefined();
    expect(saved._warning).toContain("maxContentBytes");

    // The download was never buffered: even the same-session job serves the
    // placeholder, not the oversized bytes.
    const download = await fetch(poll.unsigned_urls[0], {
      headers: { Authorization: "Bearer sk-cl" },
    });
    expect(download.status).toBe(200);
    const body = Buffer.from(await download.arrayBuffer());
    expect(body.equals(bytes)).toBe(false);
    expect(body.subarray(4, 8).toString("ascii")).toBe("ftyp"); // placeholder MP4
  });

  test("a negative maxContentBytes warns at createServer and falls back to the default cap", async () => {
    const bytes = Buffer.from("small render bytes");
    upstream = await startOpenRouterVideoUpstream({ videoBytes: bytes });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-or-video-cap-"));
    mock = new LLMock({
      port: 0,
      logLevel: "warn",
      record: {
        providers: { openrouter: upstream.url },
        fixturePath: tmpDir,
        openRouterVideo: { maxContentBytes: -5 },
      },
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await mock.start();
    expect(warnSpy.mock.calls.some((c) => c.join(" ").includes("maxContentBytes"))).toBe(true);

    // The invalid cap is treated as the default — a small capture records b64.
    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sk-neg" },
      body: JSON.stringify({ model: "bytedance/seedance-2.0", prompt: "negative cap" }),
    });
    const envelope = (await submit.json()) as { polling_url: string };
    await (
      await fetch(envelope.polling_url, { headers: { Authorization: "Bearer sk-neg" } })
    ).arrayBuffer();
    await waitUntil(() => readRecordedFixtureFiles(tmpDir!).length === 1);

    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    const saved = JSON.parse(fs.readFileSync(path.join(tmpDir, files[0]), "utf-8")) as {
      fixtures: { response: { video: { b64?: string } } }[];
    };
    expect(saved.fixtures[0].response.video.b64).toBe(bytes.toString("base64"));
  });
});

// ─── Task 7: models listing record passthrough ──────────────────────────────

describe("OpenRouter video record — models listing passthrough", () => {
  let mock: LLMock | undefined;
  let upstream: Awaited<ReturnType<typeof startOpenRouterVideoUpstream>> | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await mock?.stop();
    mock = undefined;
    await upstream?.close();
    upstream = undefined;
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  test("record + provider relays the upstream listing verbatim, journals proxy, writes no fixture", async () => {
    upstream = await startOpenRouterVideoUpstream({});
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-or-video-models-"));
    mock = new LLMock({
      port: 0,
      logLevel: "silent",
      record: { providers: { openrouter: upstream.url }, fixturePath: tmpDir },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/api/v1/videos/models`);
    expect(res.status).toBe(200);
    const data = await res.json();
    // Verbatim upstream body — "upstream/model-1" can never be synthesized.
    expect(data).toEqual({ data: [{ id: "upstream/model-1", name: "upstream/model-1" }] });
    expect(upstream.counts.models).toBe(1);

    const entry = mock.journal
      .getAll()
      .find((e) => e.method === "GET" && e.path === "/api/v1/videos/models");
    expect(entry).toBeDefined();
    expect(entry!.response.status).toBe(200);
    expect(entry!.response.source).toBe("proxy");

    // Listings are never recorded as fixtures.
    expect(fs.readdirSync(tmpDir).filter((f) => f.endsWith(".json"))).toHaveLength(0);
  });

  test("upstream failure warns and falls back to the synthesized listing", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-or-video-models-"));
    mock = new LLMock({
      port: 0,
      logLevel: "warn",
      record: { providers: { openrouter: UPSTREAM_DOWN_URL }, fixturePath: tmpDir },
    });
    mock.addFixture({
      match: { model: "acme/video-z", endpoint: "video" },
      response: { video: { id: "v1", status: "completed" } },
    });
    await mock.start();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await fetch(`${mock.url}/api/v1/videos/models`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.data.map((m: { id: string }) => m.id)).toEqual(["acme/video-z"]);
    expect(
      warnSpy.mock.calls.some((c) => c.join(" ").includes("falling back to the synthesized")),
    ).toBe(true);
  });

  test("without record the listing is synthesized and the upstream is never contacted", async () => {
    upstream = await startOpenRouterVideoUpstream({});
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { model: "acme/video-y", endpoint: "video" },
      response: { video: { id: "v1", status: "completed" } },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/api/v1/videos/models`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.data.map((m: { id: string }) => m.id)).toEqual(["acme/video-y"]);
    expect(upstream.counts.models).toBe(0);
  });

  test("strict mode gates the models proxy: synthesized listing, upstream untouched", async () => {
    upstream = await startOpenRouterVideoUpstream({});
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-or-video-models-"));
    mock = new LLMock({
      port: 0,
      logLevel: "silent",
      strict: true,
      record: { providers: { openrouter: upstream.url }, fixturePath: tmpDir },
    });
    mock.addFixture({
      match: { model: "acme/video-s", endpoint: "video" },
      response: { video: { id: "v1", status: "completed" } },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/api/v1/videos/models`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.data.map((m: { id: string }) => m.id)).toEqual(["acme/video-s"]);
    expect(upstream.counts.models).toBe(0);
  });
});

// ─── Task 8: chaos labeling and metrics templating on the record path ───────

describe("OpenRouter video record — chaos source labels and metrics", () => {
  let mock: LLMock | undefined;
  let upstream: Awaited<ReturnType<typeof startOpenRouterVideoUpstream>> | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    await mock?.stop();
    mock = undefined;
    await upstream?.close();
    upstream = undefined;
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  function makeRecordOptions(upstreamUrl: string) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-or-video-chaos-"));
    return { providers: { openrouter: upstreamUrl }, fixturePath: tmpDir };
  }

  test("chaos drop on a record-mode submit journals source proxy and skips the upstream", async () => {
    upstream = await startOpenRouterVideoUpstream({});
    mock = new LLMock({ port: 0, logLevel: "silent", record: makeRecordOptions(upstream.url) });
    await mock.start();

    const dropped = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-aimock-chaos-drop": "1" },
      body: JSON.stringify({ model: "m/v", prompt: "chaos record" }),
    });
    expect(dropped.status).toBe(500);
    expect((await dropped.json()).error.code).toBe("chaos_drop");
    expect(upstream.counts.submit).toBe(0);

    const entry = mock.journal
      .getAll()
      .find((e) => e.path === "/api/v1/videos" && e.response.chaosAction === "drop");
    expect(entry).toBeDefined();
    expect(entry!.response.source).toBe("proxy");
  });

  test("chaos drop on a strict no-fixture submit journals source internal (strict wins over record)", async () => {
    upstream = await startOpenRouterVideoUpstream({});
    mock = new LLMock({
      port: 0,
      logLevel: "silent",
      strict: true,
      record: makeRecordOptions(upstream.url),
    });
    await mock.start();

    const dropped = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-aimock-chaos-drop": "1" },
      body: JSON.stringify({ model: "m/v", prompt: "strict chaos record" }),
    });
    expect(dropped.status).toBe(500);
    expect((await dropped.json()).error.code).toBe("chaos_drop");
    expect(upstream.counts.submit).toBe(0);

    // Strict would 503 before any proxy attempt, so the chaos-dropped request
    // would never have been proxied — the label must be "internal".
    const entry = mock.journal
      .getAll()
      .find((e) => e.path === "/api/v1/videos" && e.response.chaosAction === "drop");
    expect(entry).toBeDefined();
    expect(entry!.response.source).toBe("internal");
  });

  test("chaos drop on a record-job poll journals source internal (rolls before job lookup)", async () => {
    upstream = await startOpenRouterVideoUpstream({ pollsBeforeCompleted: 5 });
    mock = new LLMock({ port: 0, logLevel: "silent", record: makeRecordOptions(upstream.url) });
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m/v", prompt: "chaos poll" }),
    });
    const envelope = (await submit.json()) as { id: string; polling_url: string };

    const dropped = await fetch(envelope.polling_url, {
      headers: { "x-aimock-chaos-drop": "1" },
    });
    expect(dropped.status).toBe(500);
    expect((await dropped.json()).error.code).toBe("chaos_drop");
    // Chaos rolls before the job lookup — the upstream is never polled.
    expect(upstream.counts.status).toBe(0);

    const entry = mock.journal
      .getAll()
      .find(
        (e) =>
          e.path.startsWith(`/api/v1/videos/${envelope.id}`) && e.response.chaosAction === "drop",
      );
    expect(entry).toBeDefined();
    expect(entry!.response.source).toBe("internal");
  });

  test("record-mode lifecycle paths stay templated in metrics ({jobId}, no raw uuid)", async () => {
    upstream = await startOpenRouterVideoUpstream({});
    mock = new LLMock({
      port: 0,
      logLevel: "silent",
      metrics: true,
      record: makeRecordOptions(upstream.url),
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sk-m" },
      body: JSON.stringify({ model: "m/v", prompt: "metrics record" }),
    });
    const envelope = (await submit.json()) as { id: string; polling_url: string };
    const poll = await (
      await fetch(envelope.polling_url, { headers: { Authorization: "Bearer sk-m" } })
    ).json();
    expect(poll.status).toBe("completed");
    await (
      await fetch(poll.unsigned_urls[0], { headers: { Authorization: "Bearer sk-m" } })
    ).arrayBuffer();

    const metricsBody = await (await fetch(`${mock.url}/metrics`)).text();
    expect(metricsBody).toMatch(/path="\/api\/v1\/videos"[,}]/);
    expect(metricsBody).toContain('path="/api/v1/videos/{jobId}"');
    expect(metricsBody).toContain('path="/api/v1/videos/{jobId}/content"');
    expect(metricsBody).not.toContain(envelope.id);
  });
});

// ─── Round 1 CR: upstream timeouts (A1) ─────────────────────────────────────

describe("OpenRouter video record — upstream timeouts (record.upstreamTimeoutMs)", () => {
  let mock: LLMock | undefined;
  let upstream: Awaited<ReturnType<typeof startOpenRouterVideoUpstream>> | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await mock?.stop();
    mock = undefined;
    await upstream?.close();
    upstream = undefined;
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  function makeTmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "aimock-or-video-timeout-"));
  }

  async function startMock(
    upstreamUrl: string,
    extra?: { logLevel?: "silent" | "warn" },
  ): Promise<LLMock> {
    tmpDir = makeTmpDir();
    const m = new LLMock({
      port: 0,
      logLevel: extra?.logLevel ?? "silent",
      record: {
        providers: { openrouter: upstreamUrl },
        fixturePath: tmpDir,
        upstreamTimeoutMs: 200,
      },
    });
    await m.start();
    return m;
  }

  test("submit proxy 502s when the upstream accepts but never responds", async () => {
    upstream = await startOpenRouterVideoUpstream({ hangOnSubmit: true });
    mock = await startMock(upstream.url);

    const t0 = Date.now();
    const res = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sk-t" },
      body: JSON.stringify({ model: "m/v", prompt: "hung submit" }),
    });
    expect(res.status).toBe(502);
    expect((await res.json()).error.type).toBe("proxy_error");
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(upstream.counts.submit).toBe(1);
  });

  test("poll proxy 502s when the upstream status endpoint hangs", async () => {
    upstream = await startOpenRouterVideoUpstream({ hangOnStatus: true });
    mock = await startMock(upstream.url);

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sk-t" },
      body: JSON.stringify({ model: "m/v", prompt: "hung poll" }),
    });
    expect(submit.status).toBe(200);
    const envelope = (await submit.json()) as { polling_url: string };

    const t0 = Date.now();
    const poll = await fetch(envelope.polling_url);
    expect(poll.status).toBe(502);
    expect((await poll.json()).error.type).toBe("proxy_error");
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  test("capture-fetch hang still relays completed, warns, and persists nothing (job stays live)", async () => {
    // Round-4 B3 pin update: a hung capture fetch used to persist a b64-less
    // fixture and terminalize; it now persists nothing so a later completed
    // poll can retry the capture.
    upstream = await startOpenRouterVideoUpstream({ hangOnContent: true });
    mock = await startMock(upstream.url, { logLevel: "warn" });

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sk-t" },
      body: JSON.stringify({ model: "m/v", prompt: "hung capture" }),
    });
    const envelope = (await submit.json()) as { id: string; polling_url: string };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const poll = await (
      await fetch(envelope.polling_url, { headers: { Authorization: "Bearer sk-t" } })
    ).json();
    expect(poll.status).toBe("completed");
    await waitUntil(() => warnSpy.mock.calls.some((c) => c.join(" ").includes("capture failed")));

    // Nothing persisted; the next poll still proxies upstream (job is live).
    expect(readRecordedFixtureFiles(tmpDir!)).toHaveLength(0);
    const again = await (
      await fetch(envelope.polling_url, { headers: { Authorization: "Bearer sk-t" } })
    ).json();
    expect((again as { status: string }).status).toBe("completed");
    expect(upstream.counts.status).toBe(2);
  });

  test("models relay falls back to synthesis when the upstream hangs", async () => {
    upstream = await startOpenRouterVideoUpstream({ hangOnModels: true });
    mock = await startMock(upstream.url, { logLevel: "warn" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const t0 = Date.now();
    const res = await fetch(`${mock.url}/api/v1/videos/models`);
    expect(res.status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(2000);
    const data = await res.json();
    // Synthesized default set — never the stub's listing.
    expect(data.data.map((m: { id: string }) => m.id)).toContain("bytedance/seedance-2.0");
    expect(
      warnSpy.mock.calls.some((c) => c.join(" ").includes("falling back to the synthesized")),
    ).toBe(true);
  });
});

// ─── Round 1 CR: relay hygiene on proxied polls (A2, A5) ────────────────────

describe("OpenRouter video record — relay hygiene on proxied polls", () => {
  let mock: LLMock | undefined;
  let upstream: Awaited<ReturnType<typeof startOpenRouterVideoUpstream>> | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await mock?.stop();
    mock = undefined;
    await upstream?.close();
    upstream = undefined;
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  async function startMock(upstreamUrl: string): Promise<LLMock> {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-or-video-relay-"));
    const m = new LLMock({
      port: 0,
      logLevel: "warn",
      record: { providers: { openrouter: upstreamUrl }, fixturePath: tmpDir },
    });
    await m.start();
    return m;
  }

  async function submitJob(
    m: LLMock,
    prompt: string,
  ): Promise<{ id: string; polling_url: string }> {
    const res = await fetch(`${m.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sk-relay" },
      body: JSON.stringify({ model: "bytedance/seedance-2.0", prompt }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string; polling_url: string };
  }

  test("non-terminal relay rewrites polling_url and preserves extra fields", async () => {
    upstream = await startOpenRouterVideoUpstream({
      statusBody: (selfUrl, jobId) => ({
        id: jobId,
        status: "in_progress",
        polling_url: `${selfUrl}/api/v1/videos/${jobId}`,
        foo: "bar",
      }),
    });
    mock = await startMock(upstream.url);
    const envelope = await submitJob(mock, "leaky pending");

    const poll = await (await fetch(envelope.polling_url)).json();
    expect(poll.id).toBe(envelope.id);
    expect(poll.status).toBe("in_progress");
    expect(poll.foo).toBe("bar");
    // The upstream polling_url must NOT escape the mock.
    expect(poll.polling_url).toBe(`${mock.url}/api/v1/videos/${envelope.id}`);
  });

  test("completed relay preserves extras, rewrites both unsigned_urls, passes non-number cost through with a warn", async () => {
    const bytes = Buffer.from("hygiene bytes");
    upstream = await startOpenRouterVideoUpstream({
      videoBytes: bytes,
      statusBody: (selfUrl, jobId) => ({
        id: jobId,
        status: "completed",
        polling_url: `${selfUrl}/api/v1/videos/${jobId}`,
        unsigned_urls: [
          `${selfUrl}/api/v1/videos/${jobId}/content?index=0`,
          `${selfUrl}/api/v1/videos/${jobId}/content?index=1`,
        ],
        usage: { cost: "0.12" },
        model: "x",
        foo: 1,
      }),
    });
    mock = await startMock(upstream.url);
    const envelope = await submitJob(mock, "hygiene render");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const poll = await (
      await fetch(envelope.polling_url, { headers: { Authorization: "Bearer sk-relay" } })
    ).json();
    expect(poll.id).toBe(envelope.id);
    expect(poll.status).toBe("completed");
    // Extras relayed verbatim.
    expect(poll.model).toBe("x");
    expect(poll.foo).toBe(1);
    // polling_url rewritten to the mock.
    expect(poll.polling_url).toBe(`${mock.url}/api/v1/videos/${envelope.id}`);
    // unsigned_urls rewritten to the mock origin, SAME length.
    expect(poll.unsigned_urls).toEqual([
      `${mock.url}/api/v1/videos/${envelope.id}/content?index=0`,
      `${mock.url}/api/v1/videos/${envelope.id}/content?index=1`,
    ]);
    // usage passed through untouched — not coerced to a number, not invented.
    expect(poll.usage).toEqual({ cost: "0.12" });
    expect(warnSpy.mock.calls.some((c) => c.join(" ").includes("usage.cost"))).toBe(true);
    // >1 unsigned_urls: only index 0 is captured — warned.
    expect(warnSpy.mock.calls.some((c) => c.join(" ").includes("index 0"))).toBe(true);

    // Capture still used unsigned_urls[0]; fixture has the bytes but no
    // cost (non-number cost is never coerced into the fixture).
    await waitUntil(() => readRecordedFixtureFiles(tmpDir!).length === 1);
    const files = readRecordedFixtureFiles(tmpDir!);
    expect(files).toHaveLength(1);
    const saved = files[0].content as {
      fixtures: { response: { video: { b64?: string; cost?: number } } }[];
    };
    expect(saved.fixtures[0].response.video.b64).toBe(bytes.toString("base64"));
    expect(saved.fixtures[0].response.video.cost).toBeUndefined();
  });

  test("completed without unsigned_urls relays faithfully (no invented URLs or usage), warns, persists nothing", async () => {
    // Round-4 B3 pin update: persist-without-b64 is now reserved for the
    // over-cap path. A completed body with no usable content URL fails the
    // capture without persisting; the job stays a live proxy so a later poll
    // (whose upstream body may carry URLs) can retry.
    upstream = await startOpenRouterVideoUpstream({
      statusBody: (_selfUrl, jobId) => ({ id: jobId, status: "completed" }),
    });
    mock = await startMock(upstream.url);
    const envelope = await submitJob(mock, "urlless completion");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const poll = await (
      await fetch(envelope.polling_url, { headers: { Authorization: "Bearer sk-relay" } })
    ).json();
    expect(poll.status).toBe("completed");
    expect(poll.unsigned_urls).toBeUndefined();
    expect(poll.usage).toBeUndefined();
    await waitUntil(() =>
      warnSpy.mock.calls.some((c) => c.join(" ").includes("without unsigned_urls")),
    );

    // Nothing persisted; the next poll still proxies upstream.
    expect(readRecordedFixtureFiles(tmpDir!)).toHaveLength(0);
    const again = await (
      await fetch(envelope.polling_url, { headers: { Authorization: "Bearer sk-relay" } })
    ).json();
    expect((again as { status: string }).status).toBe("completed");
    expect(upstream.counts.status).toBe(2);
  });

  test("failed with an object-shaped error records the extracted message and relays the body through", async () => {
    upstream = await startOpenRouterVideoUpstream({
      statusBody: (_selfUrl, jobId) => ({
        id: jobId,
        status: "failed",
        error: { message: "boom", code: 400 },
      }),
    });
    mock = await startMock(upstream.url);
    const envelope = await submitJob(mock, "object error");

    const poll = await (await fetch(envelope.polling_url)).json();
    expect(poll.status).toBe("failed");
    // A2 passthrough: the upstream error object is relayed verbatim.
    expect(poll.error).toEqual({ message: "boom", code: 400 });

    const files = readRecordedFixtureFiles(tmpDir!);
    expect(files).toHaveLength(1);
    const saved = files[0].content as {
      fixtures: { response: { video: { error?: string } } }[];
    };
    expect(saved.fixtures[0].response.video.error).toBe("boom");
  });

  test("failed with an unusable error value warns and persists the fixture without error", async () => {
    upstream = await startOpenRouterVideoUpstream({
      statusBody: (_selfUrl, jobId) => ({ id: jobId, status: "failed", error: 42 }),
    });
    mock = await startMock(upstream.url);
    const envelope = await submitJob(mock, "numeric error");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const poll = await (await fetch(envelope.polling_url)).json();
    expect(poll.status).toBe("failed");
    expect(poll.error).toBe(42); // relayed verbatim per A2
    expect(warnSpy.mock.calls.some((c) => c.join(" ").includes("unusable error"))).toBe(true);

    const files = readRecordedFixtureFiles(tmpDir!);
    const saved = files[0].content as {
      fixtures: { response: { video: { error?: string } } }[];
    };
    expect(saved.fixtures[0].response.video.error).toBeUndefined();

    // Replay default applies once the job is terminal in memory.
    const again = await (await fetch(envelope.polling_url)).json();
    expect(again.error).toBe("Video generation failed");
  });
});

// ─── Round 1 CR: proxy-only mode (A3) ───────────────────────────────────────

describe("OpenRouter video record — proxy-only mode", () => {
  let mock: LLMock | undefined;
  let upstream: Awaited<ReturnType<typeof startOpenRouterVideoUpstream>> | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await mock?.stop();
    mock = undefined;
    await upstream?.close();
    upstream = undefined;
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  test("full lifecycle: no fixtures, no caching, content live-proxied on every fetch", async () => {
    const bytes = Buffer.from("proxy only payload");
    upstream = await startOpenRouterVideoUpstream({ videoBytes: bytes });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-or-video-proxyonly-"));
    mock = new LLMock({
      port: 0,
      logLevel: "silent",
      record: {
        providers: { openrouter: upstream.url },
        fixturePath: tmpDir,
        proxyOnly: true,
      },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sk-po" },
      body: JSON.stringify({ model: "bytedance/seedance-2.0", prompt: "proxy only render" }),
    });
    expect(submit.status).toBe(200);
    const envelope = (await submit.json()) as { id: string; polling_url: string };

    const poll = await (
      await fetch(envelope.polling_url, { headers: { Authorization: "Bearer sk-po" } })
    ).json();
    expect(poll.status).toBe("completed");
    expect(poll.unsigned_urls).toEqual([
      `${mock.url}/api/v1/videos/${envelope.id}/content?index=0`,
    ]);
    // No eager capture under proxy-only — the bytes were never fetched.
    expect(upstream.counts.content).toBe(0);

    // Content is live-proxied: bytes equal the stub's, every fetch hits upstream.
    const download1 = await fetch(poll.unsigned_urls[0], {
      headers: { Authorization: "Bearer sk-po" },
    });
    expect(download1.status).toBe(200);
    expect(download1.headers.get("content-type")).toBe("video/mp4");
    expect(Buffer.from(await download1.arrayBuffer()).equals(bytes)).toBe(true);
    expect(upstream.counts.content).toBe(1);

    const download2 = await fetch(poll.unsigned_urls[0], {
      headers: { Authorization: "Bearer sk-po" },
    });
    expect(Buffer.from(await download2.arrayBuffer()).equals(bytes)).toBe(true);
    expect(upstream.counts.content).toBe(2);

    // A poll after completed still proxies upstream (no replay mutation).
    const statusBefore = upstream.counts.status;
    const again = await (
      await fetch(envelope.polling_url, { headers: { Authorization: "Bearer sk-po" } })
    ).json();
    expect(again.status).toBe("completed");
    expect(upstream.counts.status).toBe(statusBefore + 1);

    // No fixture file on disk, no in-memory fixture (a second identical
    // submit is proxied again).
    expect(readRecordedFixtureFiles(tmpDir!)).toHaveLength(0);
    const second = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sk-po" },
      body: JSON.stringify({ model: "bytedance/seedance-2.0", prompt: "proxy only render" }),
    });
    expect(second.status).toBe(200);
    expect(upstream.counts.submit).toBe(2);

    // Live-proxied content downloads journal source "proxy".
    const contentEntry = mock.journal
      .getAll()
      .find((e) => e.method === "GET" && e.path.includes("/content"));
    expect(contentEntry).toBeDefined();
    expect(contentEntry!.response.status).toBe(200);
    expect(contentEntry!.response.source).toBe("proxy");
  });
});

// ─── Round 1 CR: capture concurrency + persistence surfacing (B1, B3) ───────

describe("OpenRouter video record — capture concurrency and persistence failures", () => {
  let mock: LLMock | undefined;
  let upstream: Awaited<ReturnType<typeof startOpenRouterVideoUpstream>> | undefined;
  let tmpDir: string | undefined;
  let blockerDir: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await mock?.stop();
    mock = undefined;
    await upstream?.close();
    upstream = undefined;
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
    if (blockerDir) {
      fs.rmSync(blockerDir, { recursive: true, force: true });
      blockerDir = undefined;
    }
  });

  test("two parallel polls at completed capture exactly once", async () => {
    const bytes = Buffer.from("captured once");
    upstream = await startOpenRouterVideoUpstream({ videoBytes: bytes });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-or-video-race-"));
    mock = new LLMock({
      port: 0,
      logLevel: "silent",
      record: { providers: { openrouter: upstream.url }, fixturePath: tmpDir },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sk-race" },
      body: JSON.stringify({ model: "bytedance/seedance-2.0", prompt: "race render" }),
    });
    const envelope = (await submit.json()) as { id: string; polling_url: string };

    const [a, b] = await Promise.all([
      fetch(envelope.polling_url, { headers: { Authorization: "Bearer sk-race" } }),
      fetch(envelope.polling_url, { headers: { Authorization: "Bearer sk-race" } }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(((await a.json()) as { status: string }).status).toBe("completed");
    expect(((await b.json()) as { status: string }).status).toBe("completed");

    // Exactly one capture fetch, one persisted fixture entry (the capture is
    // detached — await its completion signal).
    await waitUntil(() => readRecordedFixtureFiles(tmpDir!).length === 1);
    expect(upstream.counts.content).toBe(1);
    const files = readRecordedFixtureFiles(tmpDir!);
    expect(files).toHaveLength(1);
    expect((files[0].content as { fixtures: unknown[] }).fixtures).toHaveLength(1);
  });

  test("a persist failure on the completed branch is logged (the relay left before the detached capture)", async () => {
    // Round-3 A5: the completed relay leaves BEFORE the capture persists, so
    // a persist failure can no longer ride an X-AIMock-Record-Error header on
    // the completed branch (the failed branch, which persists synchronously,
    // still sets it — pinned separately). It surfaces through the error log,
    // and the in-memory job still terminalizes so the session keeps working.
    upstream = await startOpenRouterVideoUpstream({});
    blockerDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-or-video-persistfail-"));
    const blockerFile = path.join(blockerDir, "not-a-dir");
    fs.writeFileSync(blockerFile, "in the way");
    mock = new LLMock({
      port: 0,
      logLevel: "warn",
      record: { providers: { openrouter: upstream.url }, fixturePath: blockerFile },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sk-pf" },
      body: JSON.stringify({ model: "m/v", prompt: "unsaveable render" }),
    });
    const envelope = (await submit.json()) as { polling_url: string };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const poll = await fetch(envelope.polling_url, {
      headers: { Authorization: "Bearer sk-pf" },
    });
    expect(poll.status).toBe(200);
    expect(((await poll.json()) as { status: string }).status).toBe("completed");

    // The detached capture hits the persist failure and logs it.
    await waitUntil(() =>
      errorSpy.mock.calls.some((c) => c.join(" ").includes("Failed to save fixture")),
    );

    // The in-memory job still mutated into a terminal replay job.
    const again = await fetch(envelope.polling_url, {
      headers: { Authorization: "Bearer sk-pf" },
    });
    expect(((await again.json()) as { status: string }).status).toBe("completed");
    expect(upstream.counts.status).toBe(1);
  });
});

// ─── Round 1 CR: forwarded-header hygiene (B7) ──────────────────────────────

describe("OpenRouter video record — mock-internal headers never reach the upstream", () => {
  let mock: LLMock | undefined;
  let upstream: Awaited<ReturnType<typeof startOpenRouterVideoUpstream>> | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    await mock?.stop();
    mock = undefined;
    await upstream?.close();
    upstream = undefined;
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  test("x-test-id / x-aimock-strict / x-aimock-context / x-aimock-chaos-* are stripped on submit, poll, and capture", async () => {
    upstream = await startOpenRouterVideoUpstream({});
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-or-video-hdrs-"));
    mock = new LLMock({
      port: 0,
      logLevel: "silent",
      record: { providers: { openrouter: upstream.url }, fixturePath: tmpDir },
    });
    await mock.start();

    const internalHeaders = {
      "X-Test-Id": "hdr-strip",
      "X-AIMock-Strict": "false",
      "X-AIMock-Context": "ctx-strip",
      "X-AIMock-Chaos-Drop": "0",
    };
    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer sk-hdr",
        ...internalHeaders,
      },
      body: JSON.stringify({ model: "m/v", prompt: "header hygiene" }),
    });
    expect(submit.status).toBe(200);
    const envelope = (await submit.json()) as { polling_url: string };

    const poll = await fetch(envelope.polling_url, {
      headers: { Authorization: "Bearer sk-hdr", ...internalHeaders },
    });
    expect(poll.status).toBe(200);
    // The capture fetch is detached from the relayed poll — wait for it to
    // reach the upstream before asserting on its headers.
    await waitUntil(() => upstream!.lastHeaders.content !== undefined);

    for (const [name, captured] of Object.entries({
      submit: upstream.lastHeaders.submit,
      status: upstream.lastHeaders.status,
      content: upstream.lastHeaders.content,
    })) {
      expect(captured, `${name} headers captured`).toBeDefined();
      expect(captured!["x-test-id"], `x-test-id on ${name}`).toBeUndefined();
      expect(captured!["x-aimock-strict"], `x-aimock-strict on ${name}`).toBeUndefined();
      expect(captured!["x-aimock-context"], `x-aimock-context on ${name}`).toBeUndefined();
      expect(captured!["x-aimock-chaos-drop"], `x-aimock-chaos-drop on ${name}`).toBeUndefined();
    }
    // Auth still forwarded.
    expect(upstream.lastHeaders.submit!.authorization).toBe("Bearer sk-hdr");
  });
});

// ─── Round 1 CR: record-job TTL refresh (B17) ───────────────────────────────

describe("OpenRouter video record — record-job TTL refresh", () => {
  let mock: LLMock | undefined;
  let upstream: Awaited<ReturnType<typeof startOpenRouterVideoUpstream>> | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    await mock?.stop();
    mock = undefined;
    await upstream?.close();
    upstream = undefined;
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  test("each successful proxied poll refreshes createdAt — long generations survive the TTL", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    upstream = await startOpenRouterVideoUpstream({ pollsBeforeCompleted: 10 });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-or-video-ttl-"));
    mock = new LLMock({
      port: 0,
      logLevel: "silent",
      record: { providers: { openrouter: upstream.url }, fixturePath: tmpDir },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sk-ttl" },
      body: JSON.stringify({ model: "m/v", prompt: "slow generation" }),
    });
    const envelope = (await submit.json()) as { polling_url: string };

    // 55 minutes later (inside the 1h TTL): poll succeeds and refreshes.
    vi.setSystemTime(Date.now() + 55 * 60_000);
    const refresh = await fetch(envelope.polling_url);
    expect(refresh.status).toBe(200);
    await refresh.arrayBuffer(); // consume the body so the socket is released

    // Another 55 minutes: 110min since submit, but only 55min since the last
    // successful proxied poll — the job must still be alive.
    vi.setSystemTime(Date.now() + 55 * 60_000);
    const res = await fetch(envelope.polling_url);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("in_progress");
  });
});

// ─── Round 1 CR: recorded fixture model normalization (A7) ──────────────────

describe("OpenRouter video record — fixture model normalization", () => {
  let mock: LLMock | undefined;
  let upstream: Awaited<ReturnType<typeof startOpenRouterVideoUpstream>> | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    await mock?.stop();
    mock = undefined;
    await upstream?.close();
    upstream = undefined;
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  async function recordWithModel(
    model: string,
    recordFullModelVersion?: boolean,
  ): Promise<string | undefined> {
    upstream = await startOpenRouterVideoUpstream({});
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-or-video-model-"));
    mock = new LLMock({
      port: 0,
      logLevel: "silent",
      record: {
        providers: { openrouter: upstream.url },
        fixturePath: tmpDir,
        ...(recordFullModelVersion !== undefined ? { recordFullModelVersion } : {}),
      },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sk-m" },
      body: JSON.stringify({ model, prompt: "normalized model render" }),
    });
    const envelope = (await submit.json()) as { polling_url: string };
    await (
      await fetch(envelope.polling_url, { headers: { Authorization: "Bearer sk-m" } })
    ).arrayBuffer();
    await waitUntil(() => readRecordedFixtureFiles(tmpDir!).length === 1);

    const files = readRecordedFixtureFiles(tmpDir);
    expect(files).toHaveLength(1);
    const saved = files[0].content as { fixtures: { match: { model?: string } }[] };
    return saved.fixtures[0].match.model;
  }

  test("a date-suffixed model records under the normalized name (suffix stripped)", async () => {
    expect(await recordWithModel("vendor/video-20260101")).toBe("vendor/video");
  });

  test("recordFullModelVersion: true records the verbatim submitted model", async () => {
    expect(await recordWithModel("vendor/video-20260101", true)).toBe("vendor/video-20260101");
  });
});

// ─── Round 2 CR: idle-based timeouts on byte-bearing fetches (A1, B10) ──────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("OpenRouter video record — idle-based content timeout semantics", () => {
  let mock: LLMock | undefined;
  let upstream: Awaited<ReturnType<typeof startOpenRouterVideoUpstream>> | undefined;
  let contentHost: Awaited<ReturnType<typeof startPlainContentHost>> | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await mock?.stop();
    mock = undefined;
    await upstream?.close();
    upstream = undefined;
    await contentHost?.close();
    contentHost = undefined;
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  async function startMock(upstreamUrl: string, record: Partial<RecordConfig>): Promise<LLMock> {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-or-video-idle-"));
    const m = new LLMock({
      port: 0,
      logLevel: "silent",
      record: {
        providers: { openrouter: upstreamUrl },
        fixturePath: tmpDir,
        ...record,
      },
    });
    await m.start();
    return m;
  }

  async function submitAndGetEnvelope(
    m: LLMock,
    prompt: string,
  ): Promise<{ id: string; polling_url: string }> {
    const res = await fetch(`${m.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sk-idle" },
      body: JSON.stringify({ model: "bytedance/seedance-2.0", prompt }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string; polling_url: string };
  }

  test("a steadily-dripping capture download outlives upstreamTimeoutMs (idle, not total deadline)", async () => {
    const bytes = Buffer.alloc(64, 0x64);
    // 16 chunks × 50ms ≈ 800ms total — more than 2× upstreamTimeoutMs. With
    // the old AbortSignal.timeout total-deadline semantics this capture
    // aborts (silent no-b64 degrade); with idle semantics it succeeds.
    contentHost = await startPlainContentHost(bytes, { chunkSize: 4, chunkDelayMs: 50 });
    upstream = await startOpenRouterVideoUpstream({ unsignedUrlOrigin: contentHost.url });
    mock = await startMock(upstream.url, { upstreamTimeoutMs: 300, bodyTimeoutMs: 1000 });
    const envelope = await submitAndGetEnvelope(mock, "dripping render");

    const poll = await (
      await fetch(envelope.polling_url, { headers: { Authorization: "Bearer sk-idle" } })
    ).json();
    expect(poll.status).toBe("completed");
    await waitUntil(() => readRecordedFixtureFiles(tmpDir!).length === 1);

    const files = readRecordedFixtureFiles(tmpDir!);
    expect(files).toHaveLength(1);
    const saved = files[0].content as {
      fixtures: { response: { video: { b64?: string } } }[];
    };
    expect(saved.fixtures[0].response.video.b64).toBe(bytes.toString("base64"));
  });

  test("a mid-body stall beyond bodyTimeoutMs aborts the capture — warn, nothing persisted, job stays live", async () => {
    // Round-4 B3 pin update: a mid-body stall used to persist a b64-less
    // fixture and terminalize; it now persists nothing (retry on next poll).
    const bytes = Buffer.alloc(64, 0x65);
    contentHost = await startPlainContentHost(bytes, {
      chunkSize: 8,
      chunkDelayMs: 10,
      stallAfterBytes: 16,
    });
    upstream = await startOpenRouterVideoUpstream({ unsignedUrlOrigin: contentHost.url });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-or-video-idle-"));
    mock = new LLMock({
      port: 0,
      logLevel: "warn",
      record: {
        providers: { openrouter: upstream.url },
        fixturePath: tmpDir,
        upstreamTimeoutMs: 5000,
        bodyTimeoutMs: 300,
      },
    });
    await mock.start();
    const envelope = await submitAndGetEnvelope(mock, "stalling render");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const t0 = Date.now();
    const poll = await (
      await fetch(envelope.polling_url, { headers: { Authorization: "Bearer sk-idle" } })
    ).json();
    expect(poll.status).toBe("completed");
    expect(Date.now() - t0).toBeLessThan(3000);
    await waitUntil(() => warnSpy.mock.calls.some((c) => c.join(" ").includes("capture failed")));
    // Nothing persisted — the failed capture leaves the job a live proxy.
    expect(readRecordedFixtureFiles(tmpDir!)).toHaveLength(0);
  });

  test("the proxy-only content relay also streams with idle semantics — slow drip succeeds", async () => {
    const bytes = Buffer.alloc(64, 0x66);
    contentHost = await startPlainContentHost(bytes, { chunkSize: 4, chunkDelayMs: 50 });
    upstream = await startOpenRouterVideoUpstream({ unsignedUrlOrigin: contentHost.url });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-or-video-idle-"));
    mock = new LLMock({
      port: 0,
      logLevel: "silent",
      record: {
        providers: { openrouter: upstream.url },
        fixturePath: tmpDir,
        proxyOnly: true,
        upstreamTimeoutMs: 300,
        bodyTimeoutMs: 1000,
      },
    });
    await mock.start();
    const envelope = await submitAndGetEnvelope(mock, "proxy only drip");

    const poll = await (
      await fetch(envelope.polling_url, { headers: { Authorization: "Bearer sk-idle" } })
    ).json();
    expect(poll.status).toBe("completed");

    const download = await fetch(poll.unsigned_urls[0], {
      headers: { Authorization: "Bearer sk-idle" },
    });
    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer()).equals(bytes)).toBe(true);
  });

  test("B10: an undeclared-length stream past maxContentBytes aborts mid-read and retains nothing", async () => {
    const bytes = Buffer.alloc(64, 0x67); // 64 bytes, cap 16, no Content-Length (chunked drip)
    contentHost = await startPlainContentHost(bytes, { chunkSize: 8, chunkDelayMs: 5 });
    upstream = await startOpenRouterVideoUpstream({ unsignedUrlOrigin: contentHost.url });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-or-video-idle-"));
    mock = new LLMock({
      port: 0,
      logLevel: "warn",
      record: {
        providers: { openrouter: upstream.url },
        fixturePath: tmpDir,
        openRouterVideo: { maxContentBytes: 16 },
      },
    });
    await mock.start();
    const envelope = await submitAndGetEnvelope(mock, "streamed oversize");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const poll = await (
      await fetch(envelope.polling_url, { headers: { Authorization: "Bearer sk-idle" } })
    ).json();
    expect(poll.status).toBe("completed");
    await waitUntil(() => readRecordedFixtureFiles(tmpDir!).length === 1);
    expect(warnSpy.mock.calls.some((c) => c.join(" ").includes("maxContentBytes"))).toBe(true);

    // Fixture persisted WITHOUT b64, with a _warning in the file.
    const files = readRecordedFixtureFiles(tmpDir!);
    expect(files).toHaveLength(1);
    const saved = files[0].content as {
      fixtures: { response: { video: { b64?: string } } }[];
      _warning?: string;
    };
    expect(saved.fixtures[0].response.video.b64).toBeUndefined();
    expect(saved._warning).toContain("maxContentBytes");

    // Nothing oversized retained: same-session content serves the placeholder.
    const download = await fetch(poll.unsigned_urls[0], {
      headers: { Authorization: "Bearer sk-idle" },
    });
    const body = Buffer.from(await download.arrayBuffer());
    expect(body.equals(bytes)).toBe(false);
    expect(body.subarray(4, 8).toString("ascii")).toBe("ftyp");
  });
});

// ─── Round 2 CR: capturing-window race (A2) + capturing hygiene (A5) ────────

describe("OpenRouter video record — capturing window", () => {
  let mock: LLMock | undefined;
  let upstream: Awaited<ReturnType<typeof startOpenRouterVideoUpstream>> | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await mock?.stop();
    mock = undefined;
    await upstream?.close();
    upstream = undefined;
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  async function startMock(upstreamUrl: string): Promise<LLMock> {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-or-video-capwin-"));
    const m = new LLMock({
      port: 0,
      logLevel: "silent",
      record: { providers: { openrouter: upstreamUrl }, fixturePath: tmpDir },
    });
    await m.start();
    return m;
  }

  async function submitJob(
    m: LLMock,
    prompt: string,
  ): Promise<{ id: string; polling_url: string }> {
    const res = await fetch(`${m.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sk-win" },
      body: JSON.stringify({ model: "bytedance/seedance-2.0", prompt }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string; polling_url: string };
  }

  test("A2: the content URL is downloadable during the capturing window (no 400)", async () => {
    const bytes = Buffer.from("window bytes");
    // The capture's content fetch takes ~800ms — a wide-open capturing window.
    upstream = await startOpenRouterVideoUpstream({ videoBytes: bytes, contentDelayMs: 800 });
    mock = await startMock(upstream.url);
    const envelope = await submitJob(mock, "window render");

    // Poll A enters the capture sequence and hangs on the content fetch.
    // Deterministic ordering: wait for the capture's content fetch to ARRIVE
    // at the upstream (counts.content) instead of sleeping — the window is
    // then provably open (contentDelayMs keeps the fetch unanswered).
    const pollA = fetch(envelope.polling_url, { headers: { Authorization: "Bearer sk-win" } });
    await waitUntil(() => upstream!.counts.content === 1);

    // Poll B relays the upstream completed body during the window.
    const pollB = await fetch(envelope.polling_url, {
      headers: { Authorization: "Bearer sk-win" },
    });
    expect(pollB.status).toBe(200);
    // The window is ACTUALLY open: the capture's content fetch reached the
    // upstream but has not been answered yet (contentDelayMs), and nothing
    // is persisted — poll B returned mid-capture, not after it.
    expect(upstream.counts.content).toBe(1);
    expect(upstream.counts.contentServed).toBe(0);
    expect(readRecordedFixtureFiles(tmpDir!)).toHaveLength(0);
    const bodyB = (await pollB.json()) as { status: string; unsigned_urls: string[] };
    expect(bodyB.status).toBe("completed");
    expect(bodyB.unsigned_urls).toHaveLength(1);

    // Immediately fetch the relayed content URL — still inside the window.
    // Before the fix this 400s ("not completed"); it must live-proxy instead.
    const download = await fetch(bodyB.unsigned_urls[0], {
      headers: { Authorization: "Bearer sk-win" },
    });
    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer()).equals(bytes)).toBe(true);

    const a = await pollA;
    expect(a.status).toBe(200);
    expect(((await a.json()) as { status: string }).status).toBe("completed");
  });

  test("A5: a poll relayed during the capturing window refreshes the job TTL", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const bytes = Buffer.from("ttl window bytes");
    upstream = await startOpenRouterVideoUpstream({ videoBytes: bytes, contentDelayMs: 1200 });
    mock = await startMock(upstream.url);
    const envelope = await submitJob(mock, "ttl window render");

    // Deterministic: wait for the capture's content fetch to arrive at the
    // upstream — the capturing window is then provably open (contentDelayMs
    // keeps it unanswered while the fake clock jumps below).
    const pollA = fetch(envelope.polling_url, { headers: { Authorization: "Bearer sk-win" } });
    await waitUntil(() => upstream!.counts.content === 1);

    // +50min (inside the 1h TTL): the capturing-window relay must refresh.
    vi.setSystemTime(Date.now() + 50 * 60_000);
    const pollB = await fetch(envelope.polling_url, {
      headers: { Authorization: "Bearer sk-win" },
    });
    expect(pollB.status).toBe(200);
    await pollB.arrayBuffer();

    // +100min since submit, but only 50min since the refreshed poll.
    vi.setSystemTime(Date.now() + 50 * 60_000);
    const pollC = await fetch(envelope.polling_url, {
      headers: { Authorization: "Bearer sk-win" },
    });
    expect(pollC.status).toBe(200); // without the refresh: evicted → 404
    await pollC.arrayBuffer();

    await (await pollA).arrayBuffer();
  });

  test("A5: a throw inside the capture sequence resets job.capturing — the next poll captures", async () => {
    // No step of the capture sequence throws organically (fetch and persist
    // failures are caught) — inject one via a record.openRouterVideo getter
    // that throws when armed. The cap is resolved inside the capture sequence,
    // after `capturing` flips true, so the throw lands inside the try/finally.
    const bytes = Buffer.from("finally bytes");
    upstream = await startOpenRouterVideoUpstream({ videoBytes: bytes });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-or-video-capwin-"));
    let explode = false;
    const record = {
      providers: { openrouter: upstream.url },
      fixturePath: tmpDir,
      get openRouterVideo() {
        if (explode) throw new Error("injected capture failure");
        return undefined;
      },
    } as RecordConfig;
    mock = new LLMock({ port: 0, logLevel: "silent", record });
    await mock.start();

    const envelope = await submitJob(mock, "finally render");

    explode = true;
    const blown = await fetch(envelope.polling_url, {
      headers: { Authorization: "Bearer sk-win" },
    });
    // Round-3 A5: the capture is DETACHED — the relay has already left when
    // the injected throw fires, so the poll succeeds and the throw is
    // contained inside the capture sequence (logged, never unhandled).
    expect(blown.status).toBe(200);
    expect(((await blown.json()) as { status: string }).status).toBe("completed");
    expect(readRecordedFixtureFiles(tmpDir!)).toHaveLength(0); // nothing persisted
    explode = false;

    // Without the finally, `capturing` stays latched: this poll would
    // early-relay forever and never persist a fixture.
    const poll = await (
      await fetch(envelope.polling_url, { headers: { Authorization: "Bearer sk-win" } })
    ).json();
    expect(poll.status).toBe("completed");
    await waitUntil(() => readRecordedFixtureFiles(tmpDir!).length === 1);
    expect(readRecordedFixtureFiles(tmpDir!)).toHaveLength(1);
  });
});

// ─── Round 2 CR: relay hygiene (A3) ─────────────────────────────────────────

describe("OpenRouter video record — non-array unsigned_urls", () => {
  let mock: LLMock | undefined;
  let upstream: Awaited<ReturnType<typeof startOpenRouterVideoUpstream>> | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await mock?.stop();
    mock = undefined;
    await upstream?.close();
    upstream = undefined;
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  test("A3: a non-array unsigned_urls is stripped from the relay with a warn (never leaks)", async () => {
    upstream = await startOpenRouterVideoUpstream({
      statusBody: (selfUrl, jobId) => ({
        id: jobId,
        status: "completed",
        unsigned_urls: `${selfUrl}/api/v1/videos/${jobId}/content?secret=1`,
      }),
    });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-or-video-nonarray-"));
    mock = new LLMock({
      port: 0,
      logLevel: "warn",
      record: { providers: { openrouter: upstream.url }, fixturePath: tmpDir },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sk-na" },
      body: JSON.stringify({ model: "m/v", prompt: "non-array urls" }),
    });
    const envelope = (await submit.json()) as { polling_url: string };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const pollRes = await fetch(envelope.polling_url, {
      headers: { Authorization: "Bearer sk-na" },
    });
    expect(pollRes.status).toBe(200);
    const raw = await pollRes.text();
    const poll = JSON.parse(raw) as { status: string; unsigned_urls?: unknown };
    expect(poll.status).toBe("completed");
    // Stripped, not relayed verbatim — the upstream URL must not escape.
    expect(poll.unsigned_urls).toBeUndefined();
    expect(raw).not.toContain(upstream.url);
    expect(warnSpy.mock.calls.some((c) => c.join(" ").includes("non-array unsigned_urls"))).toBe(
      true,
    );
  });
});

// ─── Round 2 CR: strict gates record-job proxying (B1) ──────────────────────

describe("OpenRouter video record — strict gates record-job proxying", () => {
  let mock: LLMock | undefined;
  let upstream: Awaited<ReturnType<typeof startOpenRouterVideoUpstream>> | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    await mock?.stop();
    mock = undefined;
    await upstream?.close();
    upstream = undefined;
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  test("a per-request X-AIMock-Strict poll of a record job 503s without contacting the upstream", async () => {
    upstream = await startOpenRouterVideoUpstream({ pollsBeforeCompleted: 5 });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-or-video-strict-"));
    mock = new LLMock({
      port: 0,
      logLevel: "silent",
      record: { providers: { openrouter: upstream.url }, fixturePath: tmpDir },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sk-st" },
      body: JSON.stringify({ model: "m/v", prompt: "strict poll" }),
    });
    const envelope = (await submit.json()) as { polling_url: string };
    expect(upstream.counts.status).toBe(0);

    const blocked = await fetch(envelope.polling_url, {
      headers: { "X-AIMock-Strict": "true" },
    });
    expect(blocked.status).toBe(503);
    const data = await blocked.json();
    expect(data.error.message).toContain("Strict mode");
    expect(upstream.counts.status).toBe(0); // never reached the upstream

    // The gate is per-request: a normal poll still proxies.
    const ok = await fetch(envelope.polling_url);
    expect(ok.status).toBe(200);
    await ok.arrayBuffer();
    expect(upstream.counts.status).toBe(1);
  });

  test("server-level strict blocks record-job polls created under a per-request strict-off override", async () => {
    upstream = await startOpenRouterVideoUpstream({ pollsBeforeCompleted: 5 });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-or-video-strict-"));
    mock = new LLMock({
      port: 0,
      logLevel: "silent",
      strict: true,
      record: { providers: { openrouter: upstream.url }, fixturePath: tmpDir },
    });
    await mock.start();

    // Submit with strict overridden OFF — the record proxy engages.
    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer sk-st",
        "X-AIMock-Strict": "false",
      },
      body: JSON.stringify({ model: "m/v", prompt: "strict server poll" }),
    });
    expect(submit.status).toBe(200);
    const envelope = (await submit.json()) as { polling_url: string };

    // A header-less poll falls back to the server-level strict → 503.
    const blocked = await fetch(envelope.polling_url);
    expect(blocked.status).toBe(503);
    await blocked.arrayBuffer();
    expect(upstream.counts.status).toBe(0);

    // Strict-off override proxies again.
    const ok = await fetch(envelope.polling_url, { headers: { "X-AIMock-Strict": "false" } });
    expect(ok.status).toBe(200);
    await ok.arrayBuffer();
    expect(upstream.counts.status).toBe(1);
  });

  test("strict blocks the proxy-only content live-proxy", async () => {
    const bytes = Buffer.from("strict content bytes");
    upstream = await startOpenRouterVideoUpstream({ videoBytes: bytes });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-or-video-strict-"));
    mock = new LLMock({
      port: 0,
      logLevel: "silent",
      record: {
        providers: { openrouter: upstream.url },
        fixturePath: tmpDir,
        proxyOnly: true,
      },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sk-st" },
      body: JSON.stringify({ model: "m/v", prompt: "strict content" }),
    });
    const envelope = (await submit.json()) as { polling_url: string };
    const poll = (await (
      await fetch(envelope.polling_url, { headers: { Authorization: "Bearer sk-st" } })
    ).json()) as { unsigned_urls: string[] };

    const blocked = await fetch(poll.unsigned_urls[0], {
      headers: { Authorization: "Bearer sk-st", "X-AIMock-Strict": "true" },
    });
    expect(blocked.status).toBe(503);
    expect((await blocked.json()).error.message).toContain("Strict mode");
    expect(upstream.counts.content).toBe(0);

    // Without the strict override the live proxy serves the bytes.
    const ok = await fetch(poll.unsigned_urls[0], {
      headers: { Authorization: "Bearer sk-st" },
    });
    expect(ok.status).toBe(200);
    expect(Buffer.from(await ok.arrayBuffer()).equals(bytes)).toBe(true);
  });
});

// ─── Round 2 CR: proxy-only content index handling (B2) + 401 fidelity (B3) ─

describe("OpenRouter video record — proxy-only content index handling", () => {
  let mock: LLMock | undefined;
  let upstream: Awaited<ReturnType<typeof startOpenRouterVideoUpstream>> | undefined;
  let hostA: Awaited<ReturnType<typeof startPlainContentHost>> | undefined;
  let hostB: Awaited<ReturnType<typeof startPlainContentHost>> | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await mock?.stop();
    mock = undefined;
    await upstream?.close();
    upstream = undefined;
    await hostA?.close();
    hostA = undefined;
    await hostB?.close();
    hostB = undefined;
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  async function startProxyOnly(
    statusBody: (selfUrl: string, jobId: string) => Record<string, unknown>,
  ): Promise<{ m: LLMock; unsignedUrls: string[] }> {
    upstream = await startOpenRouterVideoUpstream({ statusBody });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-or-video-index-"));
    const m = new LLMock({
      port: 0,
      logLevel: "warn",
      record: {
        providers: { openrouter: upstream.url },
        fixturePath: tmpDir,
        proxyOnly: true,
      },
    });
    await m.start();
    mock = m;
    const submit = await fetch(`${m.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sk-idx" },
      body: JSON.stringify({ model: "m/v", prompt: "indexed content" }),
    });
    const envelope = (await submit.json()) as { polling_url: string };
    const poll = (await (
      await fetch(envelope.polling_url, { headers: { Authorization: "Bearer sk-idx" } })
    ).json()) as { unsigned_urls: string[] };
    return { m, unsignedUrls: poll.unsigned_urls };
  }

  test("B2: index selects the position-aligned upstream URL", async () => {
    hostA = await startPlainContentHost(Buffer.from("first video"));
    hostB = await startPlainContentHost(Buffer.from("second video"));
    const a = hostA.url;
    const b = hostB.url;
    const { unsignedUrls } = await startProxyOnly((_selfUrl, jobId) => ({
      id: jobId,
      status: "completed",
      unsigned_urls: [`${a}/a.mp4`, `${b}/b.mp4`],
    }));
    expect(unsignedUrls).toHaveLength(2);

    const dl = await fetch(unsignedUrls[1], { headers: { Authorization: "Bearer sk-idx" } });
    expect(dl.status).toBe(200);
    expect(Buffer.from(await dl.arrayBuffer()).toString()).toBe("second video");
  });

  test("B2: an out-of-range index warns and serves index 0", async () => {
    hostA = await startPlainContentHost(Buffer.from("first video"));
    const a = hostA.url;
    const { unsignedUrls } = await startProxyOnly((_selfUrl, jobId) => ({
      id: jobId,
      status: "completed",
      unsigned_urls: [`${a}/a.mp4`],
    }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const outOfRange = unsignedUrls[0].replace("index=0", "index=5");
    const dl = await fetch(outOfRange, { headers: { Authorization: "Bearer sk-idx" } });
    expect(dl.status).toBe(200);
    expect(Buffer.from(await dl.arrayBuffer()).toString()).toBe("first video");
    expect(
      warnSpy.mock.calls.some((c) => {
        const line = c.join(" ");
        return line.includes("index=5") && line.includes("serving index 0");
      }),
    ).toBe(true);
  });

  test("B2: non-string entries keep their position (skipped at use time)", async () => {
    hostB = await startPlainContentHost(Buffer.from("second video"));
    const b = hostB.url;
    const { unsignedUrls } = await startProxyOnly((_selfUrl, jobId) => ({
      id: jobId,
      status: "completed",
      unsigned_urls: [42, `${b}/b.mp4`],
    }));
    // The relay preserves array length — positions align.
    expect(unsignedUrls).toHaveLength(2);

    // index=1 resolves the REAL second entry (not shifted by filtering).
    const dl = await fetch(unsignedUrls[1], { headers: { Authorization: "Bearer sk-idx" } });
    expect(dl.status).toBe(200);
    expect(Buffer.from(await dl.arrayBuffer()).toString()).toBe("second video");

    // index=0 points at the unusable entry — its fallback (urls[0]) is the
    // same unusable entry, so the download 502s, naming the ACTUAL condition
    // (round-6 pin: urls exist but entry 0 is unusable — not "without
    // usable unsigned_urls", which describes an empty array).
    const bad = await fetch(unsignedUrls[0], { headers: { Authorization: "Bearer sk-idx" } });
    expect(bad.status).toBe(502);
    const badBody = (await bad.json()) as { error: { message: string } };
    expect(badBody.error.message).toContain("unsigned_urls[0] is unusable");
  });

  test("B3: an upstream 401 on the proxy-only content fetch passes through to the client", async () => {
    upstream = await startOpenRouterVideoUpstream({ contentStatus: 401 });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-or-video-index-"));
    mock = new LLMock({
      port: 0,
      logLevel: "silent",
      record: {
        providers: { openrouter: upstream.url },
        fixturePath: tmpDir,
        proxyOnly: true,
      },
    });
    await mock.start();
    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sk-401" },
      body: JSON.stringify({ model: "m/v", prompt: "upstream rejects auth" }),
    });
    const envelope = (await submit.json()) as { polling_url: string };
    const poll = (await (
      await fetch(envelope.polling_url, { headers: { Authorization: "Bearer sk-401" } })
    ).json()) as { unsigned_urls: string[] };

    const dl = await fetch(poll.unsigned_urls[0], {
      headers: { Authorization: "Bearer sk-401" },
    });
    // Real-API fidelity: the upstream's auth rejection reaches the client
    // as-is instead of a generic 502 proxy_error.
    expect(dl.status).toBe(401);
    expect(await dl.text()).toContain("stub content error");
  });
});

// ─── Round 2 CR: journal-after-guard (B4) + disableRecording (B6) ───────────

describe("OpenRouter video record — relay write hygiene", () => {
  let mock: LLMock | undefined;
  let upstream: Awaited<ReturnType<typeof startOpenRouterVideoUpstream>> | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    await mock?.stop();
    mock = undefined;
    await upstream?.close();
    upstream = undefined;
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  test("B4: a client that disconnects before the relay leaves no phantom 200 journal entry", async () => {
    upstream = await startOpenRouterVideoUpstream({ pollsBeforeCompleted: 5, statusDelayMs: 400 });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-or-video-phantom-"));
    mock = new LLMock({
      port: 0,
      logLevel: "silent",
      record: { providers: { openrouter: upstream.url }, fixturePath: tmpDir },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sk-ph" },
      body: JSON.stringify({ model: "m/v", prompt: "phantom journal" }),
    });
    const envelope = (await submit.json()) as { id: string; polling_url: string };

    const ac = new AbortController();
    const pending = fetch(envelope.polling_url, { signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    await expect(pending).rejects.toThrow();

    // Deterministic completion signal (no fixed sleep): a SECOND, normal poll
    // is dispatched after the abort, so its upstream response — delayed by
    // the same statusDelayMs — resolves strictly after the aborted poll's,
    // and Node processes the aborted poll's relay step first. By the time
    // poll #2's journal entry lands, poll #1 has definitely reached (and
    // skipped) its journal step.
    const second = await fetch(envelope.polling_url);
    expect(second.status).toBe(200);
    await second.arrayBuffer();

    const pollEntries = mock.journal
      .getAll()
      .filter((e) => e.method === "GET" && e.path.startsWith(`/api/v1/videos/${envelope.id}`));
    // Exactly ONE 200 entry — poll #2's. The aborted relay never left, so it
    // journaled nothing.
    expect(pollEntries.filter((e) => e.response.status === 200)).toHaveLength(1);
  });

  test("B6: disabling recording mid-flight fails record-job polls loudly — even non-terminal ones", async () => {
    upstream = await startOpenRouterVideoUpstream({ pollsBeforeCompleted: 5 });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-or-video-disable-"));
    mock = new LLMock({
      port: 0,
      logLevel: "silent",
      record: { providers: { openrouter: upstream.url }, fixturePath: tmpDir },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sk-dis" },
      body: JSON.stringify({ model: "m/v", prompt: "orphaned record job" }),
    });
    const envelope = (await submit.json()) as { polling_url: string };

    mock.disableRecording();

    const poll = await fetch(envelope.polling_url);
    expect(poll.status).toBe(502);
    expect((await poll.json()).error.message).toContain("no longer configured");
    // Fails loudly BEFORE contacting the upstream.
    expect(upstream.counts.status).toBe(0);
  });
});

// ─── Round 2 CR: contract pins (B13) ────────────────────────────────────────

describe("OpenRouter video record — round 2 contract pins", () => {
  let mock: LLMock | undefined;
  let upstream: Awaited<ReturnType<typeof startOpenRouterVideoUpstream>> | undefined;
  let contentHost: Awaited<ReturnType<typeof startPlainContentHost>> | undefined;
  let tmpDir: string | undefined;
  let blockerDir: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await mock?.stop();
    mock = undefined;
    await upstream?.close();
    upstream = undefined;
    await contentHost?.close();
    contentHost = undefined;
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
    if (blockerDir) {
      fs.rmSync(blockerDir, { recursive: true, force: true });
      blockerDir = undefined;
    }
  });

  test("the proxy-only content fetch drops the client Bearer for off-origin unsigned_urls", async () => {
    const bytes = Buffer.from("cdn proxied bytes");
    contentHost = await startPlainContentHost(bytes);
    const cdn = contentHost.url;
    upstream = await startOpenRouterVideoUpstream({
      statusBody: (_selfUrl, jobId) => ({
        id: jobId,
        status: "completed",
        unsigned_urls: [`${cdn}/v.mp4`],
      }),
    });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-or-video-pin-"));
    mock = new LLMock({
      port: 0,
      logLevel: "warn",
      record: {
        providers: { openrouter: upstream.url },
        fixturePath: tmpDir,
        proxyOnly: true,
      },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sk-pin" },
      body: JSON.stringify({ model: "m/v", prompt: "cdn proxy only" }),
    });
    const envelope = (await submit.json()) as { polling_url: string };
    const poll = (await (
      await fetch(envelope.polling_url, { headers: { Authorization: "Bearer sk-pin" } })
    ).json()) as { unsigned_urls: string[] };

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dl = await fetch(poll.unsigned_urls[0], {
      headers: { Authorization: "Bearer sk-pin" },
    });
    expect(dl.status).toBe(200);
    expect(Buffer.from(await dl.arrayBuffer()).equals(bytes)).toBe(true);
    // The off-origin host never received the client's Bearer.
    expect(contentHost.lastHeaders()).toBeDefined();
    expect(contentHost.lastHeaders()!.authorization).toBeUndefined();
    expect(
      warnSpy.mock.calls.some((c) => {
        const line = c.join(" ");
        return line.includes("differs from the provider origin") && line.includes("Authorization");
      }),
    ).toBe(true);
  });

  test("proxy-only completed-without-unsigned_urls 502s on content", async () => {
    upstream = await startOpenRouterVideoUpstream({
      statusBody: (_selfUrl, jobId) => ({ id: jobId, status: "completed" }),
    });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-or-video-pin-"));
    mock = new LLMock({
      port: 0,
      logLevel: "silent",
      record: {
        providers: { openrouter: upstream.url },
        fixturePath: tmpDir,
        proxyOnly: true,
      },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sk-pin" },
      body: JSON.stringify({ model: "m/v", prompt: "urlless proxy only" }),
    });
    const envelope = (await submit.json()) as { id: string; polling_url: string };
    const poll = await fetch(envelope.polling_url, {
      headers: { Authorization: "Bearer sk-pin" },
    });
    expect(((await poll.json()) as { status: string }).status).toBe("completed");

    const dl = await fetch(`${mock.url}/api/v1/videos/${envelope.id}/content?index=0`, {
      headers: { Authorization: "Bearer sk-pin" },
    });
    expect(dl.status).toBe(502);
    expect((await dl.json()).error.type).toBe("proxy_error");
  });

  test("rewritten poll-body URLs embed ?testId= for a non-default testId", async () => {
    upstream = await startOpenRouterVideoUpstream({
      statusBody: (selfUrl, jobId) => ({
        id: jobId,
        status: "completed",
        polling_url: `${selfUrl}/api/v1/videos/${jobId}`,
        unsigned_urls: [`${selfUrl}/api/v1/videos/${jobId}/content?index=0`],
      }),
    });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-or-video-pin-"));
    mock = new LLMock({
      port: 0,
      logLevel: "silent",
      record: { providers: { openrouter: upstream.url }, fixturePath: tmpDir },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer sk-tid",
        "X-Test-Id": "round2-pin",
      },
      body: JSON.stringify({ model: "m/v", prompt: "testid urls" }),
    });
    const envelope = (await submit.json()) as { id: string; polling_url: string };
    expect(envelope.polling_url).toContain("?testId=round2-pin");

    const poll = (await (
      await fetch(envelope.polling_url, { headers: { Authorization: "Bearer sk-tid" } })
    ).json()) as { polling_url: string; unsigned_urls: string[] };
    expect(poll.polling_url).toBe(`${mock.url}/api/v1/videos/${envelope.id}?testId=round2-pin`);
    expect(poll.unsigned_urls).toEqual([
      `${mock.url}/api/v1/videos/${envelope.id}/content?index=0&testId=round2-pin`,
    ]);
  });

  test("a persist failure on the FAILED branch sets X-AIMock-Record-Error", async () => {
    upstream = await startOpenRouterVideoUpstream({
      finalStatus: "failed",
      error: "doomed render",
    });
    blockerDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-or-video-pin-"));
    const blockerFile = path.join(blockerDir, "not-a-dir");
    fs.writeFileSync(blockerFile, "in the way");
    mock = new LLMock({
      port: 0,
      logLevel: "silent",
      record: { providers: { openrouter: upstream.url }, fixturePath: blockerFile },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sk-ff" },
      body: JSON.stringify({ model: "m/v", prompt: "unsaveable failure" }),
    });
    const envelope = (await submit.json()) as { polling_url: string };

    const poll = await fetch(envelope.polling_url, {
      headers: { Authorization: "Bearer sk-ff" },
    });
    expect(poll.status).toBe(200);
    expect(((await poll.json()) as { status: string }).status).toBe("failed");
    expect(poll.headers.get("x-aimock-record-error")).toBeTruthy();
  });
});

// ─── Round 3 CR: stale-reference resurrection (A1), failed-branch concurrency
// (A2), content record-disabled gate (A3), detached capture (A5), streamed
// content relay (A6), models fallback label (B2), unusable-[0] warn (B5),
// 403 passthrough pin (B9) ────────────────────────────────────────────────────

describe("OpenRouter video record — round 3 CR", () => {
  let mock: LLMock | undefined;
  let upstream: Awaited<ReturnType<typeof startOpenRouterVideoUpstream>> | undefined;
  let contentHost: Awaited<ReturnType<typeof startPlainContentHost>> | undefined;
  let rawUpstream: { url: string; close: () => Promise<void> } | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await mock?.stop();
    mock = undefined;
    await upstream?.close();
    upstream = undefined;
    await contentHost?.close();
    contentHost = undefined;
    await rawUpstream?.close();
    rawUpstream = undefined;
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  async function startMock(
    upstreamUrl: string,
    extra?: Partial<RecordConfig> & { logLevel?: "silent" | "warn" },
  ): Promise<LLMock> {
    const { logLevel, ...record } = extra ?? {};
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-or-video-r3-"));
    const m = new LLMock({
      port: 0,
      logLevel: logLevel ?? "silent",
      record: { providers: { openrouter: upstreamUrl }, fixturePath: tmpDir, ...record },
    });
    await m.start();
    mock = m;
    return m;
  }

  async function submitJob(
    m: LLMock,
    prompt: string,
  ): Promise<{ id: string; polling_url: string }> {
    const res = await fetch(`${m.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sk-r3" },
      body: JSON.stringify({ model: "bytedance/seedance-2.0", prompt }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string; polling_url: string };
  }

  const auth = { Authorization: "Bearer sk-r3" };

  test("A1: a stale concurrent poll cannot resurrect the record job over the captured replay job", async () => {
    const bytes = Buffer.from("resurrection bytes");
    // Both polls' upstream status fetches take statusDelayMs. Poll A's capture
    // replaces the map entry at ~statusDelayMs + contentDelayMs; poll B is
    // dispatched mid-flight so its status response resolves strictly AFTER
    // that replacement — its dispatch-time job reference is then detached.
    upstream = await startOpenRouterVideoUpstream({
      videoBytes: bytes,
      contentDelayMs: 400,
      statusDelayMs: 800,
    });
    const m = await startMock(upstream.url);
    const envelope = await submitJob(m, "resurrection render");

    const pollA = fetch(envelope.polling_url, { headers: auth }); // status resolves ~800
    // Deterministic capture-started gate: wait for the capture's content
    // fetch to ARRIVE at the upstream (counts.content — incremented on
    // arrival, answered contentDelayMs later) instead of sleeping. Poll B is
    // then dispatched while the map still holds the record job (replacement
    // needs the content response, ~400ms away), and B's own status response
    // (dispatch + 800ms) resolves strictly after the replacement — both
    // margins are anchored to server-side timers, not CI wall-clock speed.
    await waitUntil(() => upstream!.counts.content >= 1);
    const pollB = fetch(envelope.polling_url, { headers: auth }); // resolves ~dispatch+800; entry replaced ~dispatch+400
    const [a, b] = await Promise.all([pollA, pollB]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(((await a.json()) as { status: string }).status).toBe("completed");
    expect(((await b.json()) as { status: string }).status).toBe("completed");
    await waitUntil(() => readRecordedFixtureFiles(tmpDir!).length === 1);
    expect(upstream.counts.status).toBe(2);

    // The third poll must be served from the terminal replay job — a
    // resurrected record job would proxy upstream (counts.status would grow)
    // and live-proxy content forever.
    const third = await (await fetch(envelope.polling_url, { headers: auth })).json();
    expect((third as { status: string }).status).toBe("completed");
    expect(upstream.counts.status).toBe(2);

    const download = await fetch(`${m.url}/api/v1/videos/${envelope.id}/content?index=0`, {
      headers: auth,
    });
    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer()).equals(bytes)).toBe(true);
    expect(upstream.counts.content).toBe(1); // captured bytes, not a live proxy
  });

  test("A1: a stale pending response cannot regress a captured terminal job", async () => {
    const bytes = Buffer.from("regress bytes");
    // Custom upstream: the FIRST status request hangs 700ms then reports
    // pending; every later one reports completed immediately. The slow
    // pending resolves AFTER the fast poll's capture replaced the entry.
    let statusCalls = 0;
    let selfUrl = "http://stub";
    rawUpstream = await new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", selfUrl);
        const sendJson = (status: number, body: unknown): void => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(body));
        };
        if (req.method === "POST" && url.pathname === "/api/v1/videos") {
          req.resume();
          req.on("end", () =>
            sendJson(200, {
              id: "up-regress-1",
              polling_url: `${selfUrl}/api/v1/videos/up-regress-1`,
              status: "pending",
            }),
          );
          return;
        }
        if (req.method === "GET" && url.pathname.endsWith("/content")) {
          res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": bytes.length });
          res.end(bytes);
          return;
        }
        if (req.method === "GET") {
          statusCalls++;
          if (statusCalls === 1) {
            setTimeout(() => sendJson(200, { id: "up-regress-1", status: "pending" }), 700);
          } else {
            sendJson(200, {
              id: "up-regress-1",
              status: "completed",
              unsigned_urls: [`${selfUrl}/api/v1/videos/up-regress-1/content`],
              usage: { cost: 0.1 },
            });
          }
          return;
        }
        sendJson(404, {});
      });
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as { port: number };
        selfUrl = `http://127.0.0.1:${port}`;
        resolve({
          url: selfUrl,
          close: () => new Promise<void>((r) => server.close(() => r())),
        });
      });
    });
    const m = await startMock(rawUpstream.url);
    const envelope = await submitJob(m, "regress render");

    const slowPending = fetch(envelope.polling_url, { headers: auth }); // status call #1
    // Deterministic ordering: the slow-pending poll must be status call #1 —
    // wait for its ARRIVAL at the upstream instead of sleeping.
    await waitUntil(() => statusCalls === 1);
    const fast = await fetch(envelope.polling_url, { headers: auth }); // status call #2 → capture
    expect(((await fast.json()) as { status: string }).status).toBe("completed");
    await waitUntil(() => readRecordedFixtureFiles(tmpDir!).length === 1);

    // The stale pending body is still relayed verbatim to ITS caller...
    const slow = await slowPending;
    expect(((await slow.json()) as { status: string }).status).toBe("pending");

    // ...but must not have regressed the terminal job: the next poll is
    // served locally as completed, with no extra upstream call.
    const again = await (await fetch(envelope.polling_url, { headers: auth })).json();
    expect((again as { status: string }).status).toBe("completed");
    expect(statusCalls).toBe(2);
  });

  test("A2: two parallel polls at failed persist exactly one fixture and one registration", async () => {
    upstream = await startOpenRouterVideoUpstream({
      finalStatus: "failed",
      error: "double doom",
      statusDelayMs: 150,
    });
    const m = await startMock(upstream.url);
    const envelope = await submitJob(m, "race failure");

    const [a, b] = await Promise.all([
      fetch(envelope.polling_url, { headers: auth }),
      fetch(envelope.polling_url, { headers: auth }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(((await a.json()) as { status: string }).status).toBe("failed");
    expect(((await b.json()) as { status: string }).status).toBe("failed");

    // Exactly one fixture file with one entry on disk...
    const files = readRecordedFixtureFiles(tmpDir!);
    expect(files).toHaveLength(1);
    expect((files[0].content as { fixtures: unknown[] }).fixtures).toHaveLength(1);
    // ...and exactly one in-memory registration.
    expect(m.getFixtures().filter((f) => f.match.userMessage === "race failure")).toHaveLength(1);
  });

  test("A3: disabling recording mid-flight fails record-job content downloads loudly", async () => {
    const bytes = Buffer.from("gated content bytes");
    upstream = await startOpenRouterVideoUpstream({ videoBytes: bytes });
    const m = await startMock(upstream.url, { proxyOnly: true });
    const envelope = await submitJob(m, "orphaned content job");

    // Proxy-only keeps the job kind:"record" after the terminal poll.
    const poll = (await (await fetch(envelope.polling_url, { headers: auth })).json()) as {
      status: string;
      unsigned_urls: string[];
    };
    expect(poll.status).toBe("completed");

    m.disableRecording();

    // The orphaned record job must fail loudly BEFORE contacting the
    // upstream — and before forwarding the client's Bearer anywhere.
    const dl = await fetch(poll.unsigned_urls[0], { headers: auth });
    expect(dl.status).toBe(502);
    expect((await dl.json()).error.message).toContain("no longer configured");
    expect(upstream.counts.content).toBe(0);
  });

  test("A5: the completed poll relays before the capture download finishes; the fixture lands later", async () => {
    const bytes = Buffer.from("detached capture bytes");
    upstream = await startOpenRouterVideoUpstream({ videoBytes: bytes, contentDelayMs: 1500 });
    const m = await startMock(upstream.url);
    const envelope = await submitJob(m, "detached render");

    const t0 = Date.now();
    const poll = (await (await fetch(envelope.polling_url, { headers: auth })).json()) as {
      status: string;
    };
    const elapsed = Date.now() - t0;
    expect(poll.status).toBe("completed");
    // The relay must NOT have waited out the 1500ms content download.
    expect(elapsed).toBeLessThan(1000);
    // The capture is still in flight at relay time...
    expect(readRecordedFixtureFiles(tmpDir!)).toHaveLength(0);
    // ...and lands later with the real bytes.
    await waitUntil(() => readRecordedFixtureFiles(tmpDir!).length === 1, 8000);
    const saved = readRecordedFixtureFiles(tmpDir!)[0].content as {
      fixtures: { response: { video: { b64?: string } } }[];
    };
    expect(saved.fixtures[0].response.video.b64).toBe(bytes.toString("base64"));
    expect(upstream.counts.content).toBe(1);
  });

  test("A6: the content live-proxy streams — client sees headers before the upstream finishes", async () => {
    const bytes = Buffer.alloc(64, 0x68);
    // 16 chunks × 50ms ≈ 800ms of upstream drip, idle timeout 1000ms.
    contentHost = await startPlainContentHost(bytes, { chunkSize: 4, chunkDelayMs: 50 });
    upstream = await startOpenRouterVideoUpstream({ unsignedUrlOrigin: contentHost.url });
    const m = await startMock(upstream.url, { proxyOnly: true, bodyTimeoutMs: 1000 });
    const envelope = await submitJob(m, "streamed relay");

    const poll = (await (await fetch(envelope.polling_url, { headers: auth })).json()) as {
      unsigned_urls: string[];
    };

    const dl = await fetch(poll.unsigned_urls[0], { headers: auth }); // resolves on HEADERS
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-type")).toBe("video/mp4");
    // First byte beat the upstream: the drip is still writing when the
    // client already holds the response head — streaming, not buffering.
    expect(contentHost.finishedAt()).toBeUndefined();
    const got = Buffer.from(await dl.arrayBuffer());
    expect(got.equals(bytes)).toBe(true);
    expect(contentHost.finishedAt()).toBeDefined();
  });

  test("B2: the synthesized fallback after a failed models proxy journals source internal", async () => {
    const m = await startMock(UPSTREAM_DOWN_URL);
    const res = await fetch(`${m.url}/api/v1/videos/models`);
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    const entry = m.journal
      .getAll()
      .find((e) => e.method === "GET" && e.path === "/api/v1/videos/models");
    expect(entry).toBeDefined();
    expect(entry!.response.status).toBe(200);
    expect(entry!.response.source).toBe("internal");
  });

  test("B5: unsigned_urls present but [0] unusable warns distinctly from absent unsigned_urls", async () => {
    // Round-4 B3 pin update: the unusable-[0] capture failure no longer
    // persists a b64-less fixture — the distinct warn is the surviving
    // contract; the job stays a live proxy.
    upstream = await startOpenRouterVideoUpstream({
      statusBody: (_selfUrl, jobId) => ({
        id: jobId,
        status: "completed",
        unsigned_urls: [""],
      }),
    });
    const m = await startMock(upstream.url, { logLevel: "warn" });
    const envelope = await submitJob(m, "unusable first url");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const poll = (await (await fetch(envelope.polling_url, { headers: auth })).json()) as {
      status: string;
    };
    expect(poll.status).toBe("completed");
    await waitUntil(() =>
      warnSpy.mock.calls.some((c) => c.join(" ").includes("unusable unsigned_urls[0]")),
    );
    expect(readRecordedFixtureFiles(tmpDir!)).toHaveLength(0);
  });

  test("B9: an upstream 403 on the proxy-only content fetch passes through to the client", async () => {
    upstream = await startOpenRouterVideoUpstream({ contentStatus: 403 });
    const m = await startMock(upstream.url, { proxyOnly: true });
    const envelope = await submitJob(m, "upstream forbids");
    const poll = (await (await fetch(envelope.polling_url, { headers: auth })).json()) as {
      unsigned_urls: string[];
    };

    const dl = await fetch(poll.unsigned_urls[0], { headers: auth });
    // Real-API fidelity: the upstream's 403 reaches the client as-is instead
    // of a generic 502 proxy_error (only the 401 case was pinned before).
    expect(dl.status).toBe(403);
    expect(await dl.text()).toContain("stub content error");
  });
});

// ─── Round 4 CR: orphaned-read hygiene (A1), bounded error-body read (A2),
// reset-array pollution (A3), bounded drain wait (A4), in-window status
// regression (A5), disconnect guards (B1), poll 401/403 passthrough (B2),
// capture-failure retry (B3), content TTL refresh (B6), strict-suppressed
// models journal (B9) ────────────────────────────────────────────────────────

describe("OpenRouter video record — round 4 CR", () => {
  let mock: LLMock | undefined;
  let upstream: Awaited<ReturnType<typeof startOpenRouterVideoUpstream>> | undefined;
  let contentHost: Awaited<ReturnType<typeof startPlainContentHost>> | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await mock?.stop();
    mock = undefined;
    await upstream?.close();
    upstream = undefined;
    await contentHost?.close();
    contentHost = undefined;
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  async function startMock(
    upstreamUrl: string,
    extra?: Partial<RecordConfig> & { logLevel?: "silent" | "warn" },
  ): Promise<LLMock> {
    const { logLevel, ...record } = extra ?? {};
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-or-video-r4-"));
    const m = new LLMock({
      port: 0,
      logLevel: logLevel ?? "silent",
      record: { providers: { openrouter: upstreamUrl }, fixturePath: tmpDir, ...record },
    });
    await m.start();
    mock = m;
    return m;
  }

  const auth = { Authorization: "Bearer sk-r4" };

  async function submitJob(
    m: LLMock,
    prompt: string,
  ): Promise<{ id: string; polling_url: string }> {
    const res = await fetch(`${m.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ model: "bytedance/seedance-2.0", prompt }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string; polling_url: string };
  }

  /** Collect unhandledRejection events around `fn` and assert there were none.
   *  NOTE on red-green: Promise.race subscribes to every input promise, so a
   *  read rejecting after the idle timeout won the race is mechanically
   *  handled today — this is a defense-in-depth PIN (documented in the A1
   *  source comment) guarding the invariant against a refactor that races the
   *  read differently, not a reproducible crash. */
  async function expectNoUnhandledRejection(fn: () => Promise<void>): Promise<void> {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    try {
      await fn();
      // One extra macrotask turn so a would-be rejection from the just-
      // destroyed socket has a chance to surface before we assert.
      await sleep(100);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
    expect(rejections).toEqual([]);
  }

  test("A1: a stream error after the capture's idle timeout cannot crash the server (orphaned read pin)", async () => {
    await expectNoUnhandledRejection(async () => {
      const bytes = Buffer.alloc(64, 0x71);
      // Stall mid-body so the idle timeout (200ms) wins the race and the
      // in-flight read is orphaned...
      contentHost = await startPlainContentHost(bytes, {
        chunkSize: 8,
        chunkDelayMs: 5,
        stallAfterBytes: 16,
      });
      upstream = await startOpenRouterVideoUpstream({ unsignedUrlOrigin: contentHost.url });
      const m = await startMock(upstream.url, { bodyTimeoutMs: 200, logLevel: "warn" });
      const envelope = await submitJob(m, "orphan read render");
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const poll = (await (await fetch(envelope.polling_url, { headers: auth })).json()) as {
        status: string;
      };
      expect(poll.status).toBe("completed");
      await waitUntil(() => warnSpy.mock.calls.some((c) => c.join(" ").includes("capture failed")));

      // ...then destroy the stalled socket so the orphaned read errors NOW.
      await contentHost.close();
      contentHost = undefined;

      // The server survives and keeps serving.
      const alive = await fetch(`${m.url}/api/v1/videos/models`);
      expect(alive.status).toBe(200);
      await alive.arrayBuffer();
    });
  });

  test("A1: a stream error after the streamed relay's idle timeout cannot crash the server", async () => {
    await expectNoUnhandledRejection(async () => {
      const bytes = Buffer.alloc(64, 0x72);
      contentHost = await startPlainContentHost(bytes, {
        chunkSize: 8,
        chunkDelayMs: 5,
        stallAfterBytes: 16,
      });
      upstream = await startOpenRouterVideoUpstream({ unsignedUrlOrigin: contentHost.url });
      const m = await startMock(upstream.url, {
        proxyOnly: true,
        bodyTimeoutMs: 200,
        logLevel: "warn",
      });
      const envelope = await submitJob(m, "orphan relay render");

      const poll = (await (await fetch(envelope.polling_url, { headers: auth })).json()) as {
        unsigned_urls: string[];
      };
      // The relay commits a 200 then stalls with the upstream; the idle abort
      // truncates the transfer — the client download fails mid-body.
      await expect(
        fetch(poll.unsigned_urls[0], { headers: auth }).then((r) => r.arrayBuffer()),
      ).rejects.toThrow();

      // Destroy the stalled upstream socket so any orphaned read errors now.
      await contentHost.close();
      contentHost = undefined;

      const alive = await fetch(`${m.url}/api/v1/videos/models`);
      expect(alive.status).toBe(200);
      await alive.arrayBuffer();
    });
  });

  test("A2: an upstream 401 with a stalling body is bounded by bodyTimeoutMs — 502, no hang", async () => {
    // Documented choice: an error body that stalls past the idle timeout
    // surfaces as a 502 proxy_error (the upstream status cannot be relayed
    // faithfully without its body); an over-cap error body instead relays
    // the upstream status with an empty body (see the source comment).
    upstream = await startOpenRouterVideoUpstream({ contentStatus: 401, stallContentBody: true });
    const m = await startMock(upstream.url, { proxyOnly: true, bodyTimeoutMs: 200 });
    const envelope = await submitJob(m, "stalling 401 body");
    const poll = (await (await fetch(envelope.polling_url, { headers: auth })).json()) as {
      unsigned_urls: string[];
    };

    const t0 = Date.now();
    const dl = await fetch(poll.unsigned_urls[0], { headers: auth });
    expect(dl.status).toBe(502);
    expect((await dl.json()).error.type).toBe("proxy_error");
    // Bounded by the 200ms idle timeout, not hung on a bare arrayBuffer().
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  test("A3: a fixtures reset during an in-flight capture discards the stale fixture (memory and disk)", async () => {
    const bytes = Buffer.from("stale world bytes");
    upstream = await startOpenRouterVideoUpstream({ videoBytes: bytes, contentDelayMs: 600 });
    const m = await startMock(upstream.url, { logLevel: "warn" });
    const envelope = await submitJob(m, "reset mid-capture");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const poll = (await (await fetch(envelope.polling_url, { headers: auth })).json()) as {
      status: string;
    };
    expect(poll.status).toBe("completed");
    // The capture's content fetch is in flight (contentDelayMs holds it open).
    await waitUntil(() => upstream!.counts.content === 1);

    // The world resets mid-capture: fixtures array cleared, job map cleared.
    const reset = await fetch(`${m.url}/__aimock/reset/fixtures`, { method: "POST" });
    expect(reset.status).toBe(200);
    await reset.arrayBuffer();

    // Deterministic completion signal: the capture notices the reset and
    // warns instead of persisting (the warn names both possible causes —
    // fixtures reset or TTL eviction — since the guard cannot tell them apart).
    await waitUntil(() =>
      warnSpy.mock.calls.some((c) => c.join(" ").includes("no longer holds this job")),
    );

    // The stale fixture landed NOWHERE: not in the next world's in-memory
    // array, not on disk.
    expect(m.getFixtures()).toHaveLength(0);
    expect(readRecordedFixtureFiles(tmpDir!)).toHaveLength(0);
  });

  test("A4: a client that stops reading cannot wedge the streamed relay — bounded by bodyTimeoutMs", async () => {
    // 8 MB through the relay against a client that never reads: res.write
    // returns false once the socket buffers fill, and the drain never comes.
    const bytes = Buffer.alloc(8 * 1024 * 1024, 0x73);
    contentHost = await startPlainContentHost(bytes);
    upstream = await startOpenRouterVideoUpstream({ unsignedUrlOrigin: contentHost.url });
    const m = await startMock(upstream.url, {
      proxyOnly: true,
      bodyTimeoutMs: 300,
      logLevel: "warn",
    });
    const envelope = await submitJob(m, "stalled client render");
    const poll = (await (await fetch(envelope.polling_url, { headers: auth })).json()) as {
      unsigned_urls: string[];
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Raw http client so the response can be paused (never consumed). NOTE:
    // the paused client cannot OBSERVE the server-side destroy (the FIN sits
    // in the kernel buffer behind the data it refuses to read), so the
    // assertions below are server-side: the bounded-abort warn fires and the
    // upstream connection is released.
    const target = new URL(poll.unsigned_urls[0]);
    const t0 = Date.now();
    const clientReq = await new Promise<http.ClientRequest>((resolve, reject) => {
      const req = http.get(
        {
          hostname: target.hostname,
          port: target.port,
          path: `${target.pathname}${target.search}`,
          headers: auth,
        },
        (res) => {
          expect(res.statusCode).toBe(200);
          res.pause(); // stop reading forever — the wedge
          res.on("error", () => {}); // premature close is the EXPECTED outcome
          resolve(req);
        },
      );
      req.on("error", reject);
    });

    try {
      // The relay terminates within the 300ms bound (+ scheduling margin) —
      // before the fix the drain wait never resolves and this warn never
      // fires (the waitUntil times out).
      await waitUntil(() =>
        warnSpy.mock.calls.some((c) => c.join(" ").includes("stopped reading")),
      );
      expect(Date.now() - t0).toBeLessThan(5000);
      // ...and the upstream reader was released: the relay's cancel tears the
      // mock→upstream connection down (a wedged relay pins it forever).
      await waitUntil(() => contentHost!.openSockets() === 0);
    } finally {
      clientReq.destroy();
    }
  });

  test("A5: a stale pending response during the capture window cannot regress the job (content stays 200)", async () => {
    const bytes = Buffer.from("window regress bytes");
    let statusCallNum = 0;
    upstream = await startOpenRouterVideoUpstream({
      videoBytes: bytes,
      contentDelayMs: 800,
      statusBody: (selfUrl, jobId) => {
        statusCallNum++;
        // First poll completes (opening the capture window — contentDelayMs
        // keeps it open); every later poll reports a STALE pending.
        return statusCallNum === 1
          ? {
              id: jobId,
              status: "completed",
              unsigned_urls: [`${selfUrl}/api/v1/videos/${jobId}/content?index=0`],
              usage: { cost: 0.1 },
            }
          : { id: jobId, status: "pending" };
      },
    });
    const m = await startMock(upstream.url);
    const envelope = await submitJob(m, "window regress render");

    const poll1 = (await (await fetch(envelope.polling_url, { headers: auth })).json()) as {
      status: string;
      unsigned_urls: string[];
    };
    expect(poll1.status).toBe("completed");
    // Capture window provably open: the content fetch arrived upstream.
    await waitUntil(() => upstream!.counts.content === 1);

    // The stale pending is relayed verbatim to ITS caller (identity holds
    // during the window, so this used to overwrite job.status)...
    const poll2 = (await (await fetch(envelope.polling_url, { headers: auth })).json()) as {
      status: string;
    };
    expect(poll2.status).toBe("pending");

    // ...but must NOT have reopened the 400 content window: the download
    // still live-proxies during the capture window.
    const dl = await fetch(poll1.unsigned_urls[0], { headers: auth });
    expect(dl.status).toBe(200);
    expect(Buffer.from(await dl.arrayBuffer()).equals(bytes)).toBe(true);
  });

  test("B1: a client that disconnects during the models proxy attempt leaves no synthesis journal entry", async () => {
    upstream = await startOpenRouterVideoUpstream({ hangOnModels: true });
    const m = await startMock(upstream.url, { upstreamTimeoutMs: 300 });

    const ac = new AbortController();
    const pending = fetch(`${m.url}/api/v1/videos/models`, { signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    await expect(pending).rejects.toThrow();

    // A second, normal request lands strictly after the first one's failed
    // proxy attempt (both wait out the same 300ms timeout; the first started
    // earlier) — by then the aborted handler has reached (and skipped) its
    // journal step.
    const second = await fetch(`${m.url}/api/v1/videos/models`);
    expect(second.status).toBe(200);
    await second.arrayBuffer();

    const entries = m.journal
      .getAll()
      .filter((e) => e.method === "GET" && e.path === "/api/v1/videos/models");
    // Exactly ONE entry — the second request's. The aborted synthesis never
    // left, so it journaled nothing.
    expect(entries).toHaveLength(1);
  });

  test("B1: a client that disconnects during a slow ResponseFactory replay leaves no journal entry", async () => {
    const m = new LLMock({ port: 0, logLevel: "silent" });
    m.addFixture({
      match: { userMessage: "slow factory", endpoint: "video" },
      response: async () => {
        await sleep(400);
        return { video: { id: "v-slow", status: "completed", b64: "AAAA" } };
      },
    });
    await m.start();
    mock = m;

    const ac = new AbortController();
    const pending = fetch(`${m.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m/v", prompt: "slow factory" }),
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 100);
    await expect(pending).rejects.toThrow();

    // Second, normal submit: its factory resolves strictly after the aborted
    // one's (started 100ms+ later), so the aborted handler has already
    // reached (and skipped) its journal step.
    const ok = await fetch(`${m.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m/v", prompt: "slow factory" }),
    });
    expect(ok.status).toBe(200);
    await ok.arrayBuffer();

    const entries = m.journal
      .getAll()
      .filter(
        (e) => e.method === "POST" && e.path === "/api/v1/videos" && e.response.status === 200,
      );
    expect(entries).toHaveLength(1);
  });

  for (const status of [401, 403] as const) {
    test(`B2: an upstream ${status} on the record-job poll passes through verbatim`, async () => {
      upstream = await startOpenRouterVideoUpstream({ statusHttpStatus: status });
      const m = await startMock(upstream.url);
      const envelope = await submitJob(m, `poll auth reject ${status}`);

      const poll = await fetch(envelope.polling_url, { headers: auth });
      // Real-API fidelity (mirrors the content path): the upstream's auth
      // rejection reaches the client as-is, not as a generic 502 proxy_error.
      expect(poll.status).toBe(status);
      const body = (await poll.json()) as { error: { message: string; code: number } };
      expect(body.error.message).toBe("stub poll rejected");
      expect(body.error.code).toBe(status);

      const entry = m.journal
        .getAll()
        .find((e) => e.method === "GET" && e.path.startsWith(`/api/v1/videos/${envelope.id}`));
      expect(entry).toBeDefined();
      expect(entry!.response.status).toBe(status);
      expect(entry!.response.source).toBe("proxy");

      // The job is untouched — the next poll proxies upstream again.
      const again = await fetch(envelope.polling_url, { headers: auth });
      expect(again.status).toBe(status);
      await again.arrayBuffer();
      expect(upstream!.counts.status).toBe(2);
    });
  }

  test("B6: replay-job content fetches refresh the TTL — long downloads keep the job alive", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const m = new LLMock({ port: 0, logLevel: "silent" });
    m.addFixture({
      match: { userMessage: "ttl content render", endpoint: "video" },
      response: { video: { id: "v-ttl", status: "completed", b64: "QUFBQQ==" } },
    });
    await m.start();
    mock = m;

    const submit = await fetch(`${m.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m/v", prompt: "ttl content render" }),
    });
    const envelope = (await submit.json()) as { id: string };
    const contentUrl = `${m.url}/api/v1/videos/${envelope.id}/content?index=0`;

    // +55min (inside the 1h TTL): the content fetch succeeds and refreshes.
    vi.setSystemTime(Date.now() + 55 * 60_000);
    const first = await fetch(contentUrl, { headers: auth });
    expect(first.status).toBe(200);
    await first.arrayBuffer();

    // +110min since submit, but only 55min since the refreshed content fetch
    // — without the refresh this is evicted → 404.
    vi.setSystemTime(Date.now() + 55 * 60_000);
    const second = await fetch(contentUrl, { headers: auth });
    expect(second.status).toBe(200);
    await second.arrayBuffer();
  });

  test("B6: record-job (proxy-only) content fetches refresh the TTL too", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const bytes = Buffer.from("ttl proxied bytes");
    upstream = await startOpenRouterVideoUpstream({ videoBytes: bytes });
    const m = await startMock(upstream.url, { proxyOnly: true });
    const envelope = await submitJob(m, "ttl proxied render");

    const poll = (await (await fetch(envelope.polling_url, { headers: auth })).json()) as {
      unsigned_urls: string[];
    };

    // +55min: live-proxied download succeeds and refreshes.
    vi.setSystemTime(Date.now() + 55 * 60_000);
    const first = await fetch(poll.unsigned_urls[0], { headers: auth });
    expect(first.status).toBe(200);
    await first.arrayBuffer();

    // +110min since the last poll, 55min since the refreshed download.
    vi.setSystemTime(Date.now() + 55 * 60_000);
    const second = await fetch(poll.unsigned_urls[0], { headers: auth });
    expect(second.status).toBe(200);
    await second.arrayBuffer();
  });

  test("B9: a strict-suppressed models proxy journals the strict override (no source — synthesis convention)", async () => {
    upstream = await startOpenRouterVideoUpstream({});
    const m = await startMock(upstream.url);

    // Per-request strict ON (server default off): the proxy is suppressed
    // and the synthesized listing is served.
    const res = await fetch(`${m.url}/api/v1/videos/models`, {
      headers: { "X-AIMock-Strict": "true" },
    });
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    expect(upstream.counts.models).toBe(0);

    const entry = m.journal
      .getAll()
      .find((e) => e.method === "GET" && e.path === "/api/v1/videos/models");
    expect(entry).toBeDefined();
    expect(entry!.response.strictOverride).toBe(true);
    // Convention pin: only a FAILED proxy attempt labels the synthesis
    // source:"internal"; a never-attempted proxy (strict-suppressed, like
    // plain no-record) omits source entirely.
    expect(entry!.response.source).toBeUndefined();
  });
});

// ─── Round 5 CR: submit 401/403 passthrough, capture-window URL refresh,
// world-generation guard on submit insertion, strict-override-relayed models
// journal ─────────────────────────────────────────────────────────────────────

describe("OpenRouter video record — round 5 CR", () => {
  let mock: LLMock | undefined;
  let upstream: Awaited<ReturnType<typeof startOpenRouterVideoUpstream>> | undefined;
  let hostA: Awaited<ReturnType<typeof startPlainContentHost>> | undefined;
  let hostB: Awaited<ReturnType<typeof startPlainContentHost>> | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await mock?.stop();
    mock = undefined;
    await upstream?.close();
    upstream = undefined;
    await hostA?.close();
    hostA = undefined;
    await hostB?.close();
    hostB = undefined;
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  async function startMock(
    upstreamUrl: string,
    extra?: Partial<RecordConfig> & { logLevel?: "silent" | "warn"; strict?: boolean },
  ): Promise<LLMock> {
    const { logLevel, strict, ...record } = extra ?? {};
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-or-video-r5-"));
    const m = new LLMock({
      port: 0,
      logLevel: logLevel ?? "silent",
      strict,
      record: { providers: { openrouter: upstreamUrl }, fixturePath: tmpDir, ...record },
    });
    await m.start();
    mock = m;
    return m;
  }

  const auth = { Authorization: "Bearer sk-r5" };

  async function submitJob(
    m: LLMock,
    prompt: string,
  ): Promise<{ id: string; polling_url: string }> {
    const res = await fetch(`${m.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ model: "bytedance/seedance-2.0", prompt }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string; polling_url: string };
  }

  for (const status of [401, 403] as const) {
    test(`an upstream ${status} on the record submit passes through verbatim`, async () => {
      upstream = await startOpenRouterVideoUpstream({ submitHttpStatus: status });
      const m = await startMock(upstream.url, { logLevel: "warn" });

      const res = await fetch(`${m.url}/api/v1/videos`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...auth },
        body: JSON.stringify({
          model: "bytedance/seedance-2.0",
          prompt: `submit reject ${status}`,
        }),
      });
      // Real-API fidelity (mirrors the poll and content paths): the
      // upstream's auth rejection reaches the client as-is, not as a generic
      // 502 proxy_error.
      expect(res.status).toBe(status);
      const body = (await res.json()) as { error: { message: string; code: number } };
      expect(body.error.message).toBe("stub submit rejected");
      expect(body.error.code).toBe(status);

      const entry = m.journal
        .getAll()
        .find((e) => e.method === "POST" && e.path === "/api/v1/videos");
      expect(entry).toBeDefined();
      expect(entry!.response.status).toBe(status);
      expect(entry!.response.source).toBe("proxy");

      // Nothing was persisted and no job was created for the rejected submit.
      expect(readRecordedFixtureFiles(tmpDir!)).toHaveLength(0);
    });
  }

  test("a later completed poll refreshes the capture-window upstream URLs (rotated unsigned_urls)", async () => {
    const bytesA = Buffer.alloc(40, 0x61);
    const bytesB = Buffer.from("fresh rotated bytes");
    // Host A drips slowly so the eager capture (which fetches the FIRST
    // completed poll's URL) keeps the capturing window open while the test
    // polls again and downloads.
    hostA = await startPlainContentHost(bytesA, { chunkSize: 4, chunkDelayMs: 200 });
    hostB = await startPlainContentHost(bytesB);
    let terminalPolls = 0;
    upstream = await startOpenRouterVideoUpstream({
      statusBody: (_selfUrl, jobId) => {
        terminalPolls++;
        const host = terminalPolls === 1 ? hostA!.url : hostB!.url;
        return {
          id: jobId,
          status: "completed",
          unsigned_urls: [`${host}/api/v1/videos/${jobId}/content?index=0`],
        };
      },
    });
    const m = await startMock(upstream.url);
    const envelope = await submitJob(m, "rotated urls render");

    // First completed poll opens the capture window (capture fetch: host A,
    // dripping for ~2s).
    const first = await fetch(envelope.polling_url, { headers: auth });
    expect(first.status).toBe(200);
    await first.arrayBuffer();

    // Second completed poll carries the ROTATED URL set — the window must
    // refresh its stored upstream URLs.
    const second = await fetch(envelope.polling_url, { headers: auth });
    expect(second.status).toBe(200);
    await second.arrayBuffer();

    // The in-window live-proxied download must hit the FRESH upstream URL.
    const dl = await fetch(`${m.url}/api/v1/videos/${envelope.id}/content?index=0`, {
      headers: auth,
    });
    expect(dl.status).toBe(200);
    expect(Buffer.from(await dl.arrayBuffer()).equals(bytesB)).toBe(true);
    expect(hostB.lastHeaders()).toBeDefined(); // host B actually served it
  });

  test("a fixtures reset landing mid-submit-fetch never inserts the job into the new world", async () => {
    upstream = await startOpenRouterVideoUpstream({ submitDelayMs: 400 });
    const m = await startMock(upstream.url, { logLevel: "warn" });

    const submitPromise = fetch(`${m.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ model: "bytedance/seedance-2.0", prompt: "reset mid submit" }),
    });
    await sleep(150); // the upstream submit is in flight
    const reset = await fetch(`${m.url}/__aimock/reset/fixtures`, { method: "POST" });
    expect(reset.status).toBe(200);
    await reset.arrayBuffer();

    // The envelope still relays (documented choice — the warned 404-on-poll
    // outcome matches TTL eviction semantics)...
    const res = await submitPromise;
    expect(res.status).toBe(200);
    const envelope = (await res.json()) as { polling_url: string };

    // ...but the stale job was NOT inserted into the new world: the poll
    // 404s locally and the upstream status endpoint is never contacted.
    const poll = await fetch(envelope.polling_url, { headers: auth });
    expect(poll.status).toBe(404);
    await poll.arrayBuffer();
    expect(upstream.counts.status).toBe(0);
  });

  test("a strict-override-relayed models listing journals the override (strictOverride: false)", async () => {
    upstream = await startOpenRouterVideoUpstream({});
    const m = await startMock(upstream.url, { strict: true });

    // Server default strict ON, per-request strict OFF: the proxy engages
    // and the relay entry must surface the override like every other
    // strict-influenced journal entry on this surface.
    const res = await fetch(`${m.url}/api/v1/videos/models`, {
      headers: { "X-AIMock-Strict": "false" },
    });
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    expect(upstream.counts.models).toBe(1);

    const entry = m.journal
      .getAll()
      .find((e) => e.method === "GET" && e.path === "/api/v1/videos/models");
    expect(entry).toBeDefined();
    expect(entry!.response.source).toBe("proxy");
    expect(entry!.response.strictOverride).toBe(false);
  });
});

// ─── Round 6 CR: proxyOnly stash clobber, strictOverride journal consistency,
// capture-failure body samples, warn latches, envelope-read bounding ─────────

describe("OpenRouter video record — round 6 CR", () => {
  let mock: LLMock | undefined;
  let upstream: Awaited<ReturnType<typeof startOpenRouterVideoUpstream>> | undefined;
  let rawUpstream: { url: string; close: () => Promise<void> } | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await mock?.stop();
    mock = undefined;
    await upstream?.close();
    upstream = undefined;
    await rawUpstream?.close();
    rawUpstream = undefined;
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  async function startMock(
    upstreamUrl: string,
    extra?: Partial<RecordConfig> & { logLevel?: "silent" | "warn"; strict?: boolean },
  ): Promise<LLMock> {
    const { logLevel, strict, ...record } = extra ?? {};
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-or-video-r6-"));
    const m = new LLMock({
      port: 0,
      logLevel: logLevel ?? "silent",
      strict,
      record: { providers: { openrouter: upstreamUrl }, fixturePath: tmpDir, ...record },
    });
    await m.start();
    mock = m;
    return m;
  }

  const auth = { Authorization: "Bearer sk-r6" };

  async function submitJob(
    m: LLMock,
    prompt: string,
    headers?: Record<string, string>,
  ): Promise<{ id: string; polling_url: string }> {
    const res = await fetch(`${m.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth, ...headers },
      body: JSON.stringify({ model: "bytedance/seedance-2.0", prompt }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string; polling_url: string };
  }

  test("proxyOnly: a later completed poll without unsigned_urls does not clobber a usable stash", async () => {
    const bytes = Buffer.from("stash survives bytes");
    let terminalPolls = 0;
    upstream = await startOpenRouterVideoUpstream({
      videoBytes: bytes,
      statusBody: (selfUrl, jobId) => {
        terminalPolls++;
        // First completed poll carries the urls; the second omits them (a
        // defective later poll must not clobber the usable stash).
        return terminalPolls === 1
          ? {
              id: jobId,
              status: "completed",
              unsigned_urls: [`${selfUrl}/api/v1/videos/${jobId}/content?index=0`],
            }
          : { id: jobId, status: "completed" };
      },
    });
    const m = await startMock(upstream.url, { proxyOnly: true });
    const envelope = await submitJob(m, "stash clobber render");

    const first = (await (await fetch(envelope.polling_url, { headers: auth })).json()) as {
      status: string;
      unsigned_urls: string[];
    };
    expect(first.status).toBe("completed");
    expect(first.unsigned_urls).toHaveLength(1);

    const second = (await (await fetch(envelope.polling_url, { headers: auth })).json()) as {
      status: string;
      unsigned_urls?: unknown;
    };
    expect(second.status).toBe("completed");
    expect(second.unsigned_urls).toBeUndefined();

    // The download after the defective second poll must still live-proxy the
    // FIRST poll's stashed upstream URL instead of 502ing on a clobbered
    // (undefined) stash.
    const dl = await fetch(first.unsigned_urls[0], { headers: auth });
    expect(dl.status).toBe(200);
    expect(Buffer.from(await dl.arrayBuffer()).equals(bytes)).toBe(true);
  });

  test("a strict-OFF override on a record-job poll journals strictOverride: false (proxied entries)", async () => {
    upstream = await startOpenRouterVideoUpstream({ pollsBeforeCompleted: 2 });
    const m = await startMock(upstream.url, { strict: true });
    const override = { "X-AIMock-Strict": "false" };

    const envelope = await submitJob(m, "strict override journal", override);
    const poll = await fetch(envelope.polling_url, { headers: { ...auth, ...override } });
    expect(poll.status).toBe(200);
    await poll.arrayBuffer();
    expect(upstream.counts.status).toBe(1);

    // The proxied poll entry must surface the override like every other
    // strict-influenced journal entry on this surface (file-wide convention).
    const entry = m.journal
      .getAll()
      .find((e) => e.method === "GET" && e.path.startsWith(`/api/v1/videos/${envelope.id}`));
    expect(entry).toBeDefined();
    expect(entry!.response.source).toBe("proxy");
    expect(entry!.response.strictOverride).toBe(false);

    // The proxied submit entry carries it too.
    const submitEntry = m.journal
      .getAll()
      .find((e) => e.method === "POST" && e.path === "/api/v1/videos");
    expect(submitEntry).toBeDefined();
    expect(submitEntry!.response.source).toBe("proxy");
    expect(submitEntry!.response.strictOverride).toBe(false);
  });

  test("a capture content-fetch failure names the upstream status AND a body sample", async () => {
    upstream = await startOpenRouterVideoUpstream({ contentStatus: 500 });
    const m = await startMock(upstream.url, { logLevel: "warn" });
    const envelope = await submitJob(m, "capture failure sample");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const poll = await fetch(envelope.polling_url, { headers: auth });
    expect(poll.status).toBe(200);
    await poll.arrayBuffer();
    await waitUntil(() => warnSpy.mock.calls.some((c) => c.join(" ").includes("capture failed")));

    const line = warnSpy.mock.calls.map((c) => c.join(" ")).find((l) => l.includes("Content 500"));
    expect(line).toBeDefined();
    // The bounded body sample makes the failure diagnosable (mirrors the
    // submit/poll proxy errors, which always carried a body snippet).
    expect(line).toContain("stub content error");
  });

  test("a proxy-only content-fetch failure 502s with the upstream status AND a body sample", async () => {
    upstream = await startOpenRouterVideoUpstream({ contentStatus: 500 });
    const m = await startMock(upstream.url, { proxyOnly: true });
    const envelope = await submitJob(m, "proxy content failure sample");
    const poll = (await (await fetch(envelope.polling_url, { headers: auth })).json()) as {
      unsigned_urls: string[];
    };

    const dl = await fetch(poll.unsigned_urls[0], { headers: auth });
    expect(dl.status).toBe(502);
    const body = (await dl.json()) as { error: { message: string } };
    expect(body.error.message).toContain("Content 500");
    expect(body.error.message).toContain("stub content error");
  });

  test("the non-array unsigned_urls warn fires once per job, not once per poll", async () => {
    upstream = await startOpenRouterVideoUpstream({
      statusBody: (selfUrl, jobId) => ({
        id: jobId,
        status: "completed",
        unsigned_urls: `${selfUrl}/api/v1/videos/${jobId}/content?secret=1`,
      }),
    });
    const m = await startMock(upstream.url, { proxyOnly: true, logLevel: "warn" });
    const envelope = await submitJob(m, "non-array warn latch");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    for (let i = 0; i < 2; i++) {
      const poll = await fetch(envelope.polling_url, { headers: auth });
      expect(poll.status).toBe(200);
      await poll.arrayBuffer();
    }

    const warns = warnSpy.mock.calls.filter((c) => c.join(" ").includes("non-array unsigned_urls"));
    expect(warns).toHaveLength(1);
  });

  test("the non-number usage.cost warn fires once per job, not once per poll", async () => {
    upstream = await startOpenRouterVideoUpstream({
      statusBody: (selfUrl, jobId) => ({
        id: jobId,
        status: "completed",
        unsigned_urls: [`${selfUrl}/api/v1/videos/${jobId}/content?index=0`],
        usage: { cost: "lots" },
      }),
    });
    const m = await startMock(upstream.url, { proxyOnly: true, logLevel: "warn" });
    const envelope = await submitJob(m, "bad cost warn latch");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    for (let i = 0; i < 2; i++) {
      const poll = await fetch(envelope.polling_url, { headers: auth });
      expect(poll.status).toBe(200);
      await poll.arrayBuffer();
    }

    const warns = warnSpy.mock.calls.filter((c) => c.join(" ").includes("non-number usage.cost"));
    expect(warns).toHaveLength(1);
  });

  test("an over-cap models envelope is refused and falls back to the synthesized listing", async () => {
    // A pathological multi-megabyte "envelope" must not be buffered in full
    // and relayed — the bounded read refuses it and the synthesis serves.
    let selfUrl = "http://stub";
    rawUpstream = await new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ data: [{ id: "x".repeat(2 * 1024 * 1024) }] }));
        });
      });
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as { port: number };
        selfUrl = `http://127.0.0.1:${port}`;
        resolve({
          url: selfUrl,
          close: () => new Promise<void>((r) => server.close(() => r())),
        });
      });
    });
    const m = await startMock(rawUpstream.url);
    m.addFixture({
      match: { userMessage: "synth model render", endpoint: "video", model: "synth/model-1" },
      response: { video: { id: "v-synth", status: "completed" } },
    });

    const res = await fetch(`${m.url}/api/v1/videos/models`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { data: { id: string }[] };
    // Synthesized from fixtures — not the over-cap upstream listing.
    expect(data.data.map((e) => e.id)).toEqual(["synth/model-1"]);
  });
});
