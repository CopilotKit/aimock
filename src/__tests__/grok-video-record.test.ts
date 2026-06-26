import { describe, test, expect, afterAll, afterEach, vi } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LLMock } from "../llmock.js";
import { startRefusingUpstream } from "./helpers/refusing-upstream.js";

// ─── Grok video fake upstream ────────────────────────────────────────────────
// A real http.createServer on 127.0.0.1:0 implementing the two xAI Grok Imagine
// video endpoints: submit (POST /v1/videos/generations → {request_id}) and
// status poll (GET /v1/videos/{id} → pending/done/failed/expired). Tracks
// per-endpoint counts and the last-received headers so tests can assert what
// hit the wire (and with which auth) vs. what was served from aimock's state.

interface GrokVideoUpstreamOptions {
  /** Terminal status the poll endpoint converges on. Default: "done". */
  finalStatus?: "done" | "failed" | "expired";
  /** Non-terminal polls served before the terminal status. Default: 0. */
  pollsBeforeDone?: number;
  /** video.url reported on done. Default: a stub https url. */
  url?: string;
  /** video.duration reported on done. Default: 6. */
  duration?: number;
  /** usage.cost_in_usd_ticks reported on done. Default: 5_000_000_000. */
  costInUsdTicks?: number;
  /** error reported on failure. Default: "upstream grok failure". */
  error?: string;
  /** Force the SUBMIT endpoint to reply with this HTTP status (JSON error). */
  submitHttpStatus?: number;
  /** Force the STATUS endpoint to reply with this HTTP status (JSON error). */
  statusHttpStatus?: number;
}

interface GrokVideoUpstream {
  url: string;
  close: () => Promise<void>;
  counts: { submit: number; status: number };
  lastHeaders: { submit?: http.IncomingHttpHeaders; status?: http.IncomingHttpHeaders };
}

const UPSTREAM_REQUEST_ID = "grok-up-1";

function startGrokVideoUpstream(opts: GrokVideoUpstreamOptions): Promise<GrokVideoUpstream> {
  const finalStatus = opts.finalStatus ?? "done";
  const pollsBeforeDone = opts.pollsBeforeDone ?? 0;
  const url = opts.url ?? "https://cdn.x.ai/stub-grok-video.mp4";
  const duration = opts.duration ?? 6;
  const costInUsdTicks = opts.costInUsdTicks ?? 5_000_000_000;
  const error = opts.error ?? "upstream grok failure";
  const counts = { submit: 0, status: 0 };
  const lastHeaders: GrokVideoUpstream["lastHeaders"] = {};
  const statusPolls = new Map<string, number>();
  const statusRe = /^\/v1\/videos\/([^/]+)$/;

  return new Promise((resolve, reject) => {
    let selfUrl = "http://stub";
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const reqUrl = new URL(req.url ?? "/", selfUrl);
        const sendJson = (status: number, body: unknown): void => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(body));
        };

        if (req.method === "POST" && reqUrl.pathname === "/v1/videos/generations") {
          counts.submit++;
          lastHeaders.submit = req.headers;
          if (opts.submitHttpStatus !== undefined && opts.submitHttpStatus !== 200) {
            sendJson(opts.submitHttpStatus, {
              code: "submit_rejected",
              error: "stub submit rejected",
            });
            return;
          }
          sendJson(200, { request_id: UPSTREAM_REQUEST_ID });
          return;
        }

        const statusMatch = reqUrl.pathname.match(statusRe);
        if (req.method === "GET" && statusMatch && statusMatch[1] !== "generations") {
          counts.status++;
          lastHeaders.status = req.headers;
          if (opts.statusHttpStatus !== undefined && opts.statusHttpStatus !== 200) {
            sendJson(opts.statusHttpStatus, { code: "poll_rejected", error: "stub poll rejected" });
            return;
          }
          const id = statusMatch[1];
          const n = (statusPolls.get(id) ?? 0) + 1;
          statusPolls.set(id, n);
          if (n <= pollsBeforeDone) {
            sendJson(200, { status: "pending", progress: Math.min(90, n * 30) });
            return;
          }
          if (finalStatus === "done") {
            sendJson(200, {
              status: "done",
              progress: 100,
              video: { url, duration },
              usage: { cost_in_usd_ticks: costInUsdTicks },
            });
            return;
          }
          if (finalStatus === "failed") {
            sendJson(200, { status: "failed", code: "generation_failed", error });
            return;
          }
          // expired (terminal, not representable in VideoResponse.status)
          sendJson(200, { status: "expired", progress: 100 });
          return;
        }

        sendJson(404, { code: "not_found", error: `stub: unhandled ${reqUrl.pathname}` });
      });
    });
    server.once("error", reject);
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

async function waitUntil(cond: () => boolean, timeoutMs = 5000, intervalMs = 20): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    if (cond()) return;
    if (performance.now() > deadline) {
      throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
    }
    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
}

// ─── Stub self-test ──────────────────────────────────────────────────────────

describe("startGrokVideoUpstream (stub self-test)", () => {
  let upstream: GrokVideoUpstream | undefined;

  afterEach(async () => {
    await upstream?.close();
    upstream = undefined;
  });

  test("submit returns {request_id}, counts the call, captures headers", async () => {
    upstream = await startGrokVideoUpstream({});
    const res = await fetch(`${upstream.url}/v1/videos/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sk-upstream" },
      body: JSON.stringify({ model: "grok-imagine-video", prompt: "a sunset" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.request_id).toBe("grok-up-1");
    expect(upstream.counts.submit).toBe(1);
    expect(upstream.lastHeaders.submit?.authorization).toBe("Bearer sk-upstream");
  });

  test("status polls advance pending then done with video and usage", async () => {
    upstream = await startGrokVideoUpstream({ pollsBeforeDone: 1, costInUsdTicks: 4_200_000_000 });
    const url = `${upstream.url}/v1/videos/grok-up-1`;
    expect((await (await fetch(url)).json()).status).toBe("pending");
    const done = await (await fetch(url)).json();
    expect(done.status).toBe("done");
    expect(done.progress).toBe(100);
    expect(done.video.url).toBe("https://cdn.x.ai/stub-grok-video.mp4");
    expect(done.usage).toEqual({ cost_in_usd_ticks: 4_200_000_000 });
    expect(upstream.counts.status).toBe(2);
  });

  test("failed final status carries code+error", async () => {
    upstream = await startGrokVideoUpstream({ finalStatus: "failed", error: "nsfw" });
    const data = await (await fetch(`${upstream.url}/v1/videos/j1`)).json();
    expect(data.status).toBe("failed");
    expect(data.error).toBe("nsfw");
  });
});

// ─── Config acceptance ───────────────────────────────────────────────────────

const refusingUpstream = await startRefusingUpstream();
const UPSTREAM_DOWN_URL = refusingUpstream.url;
afterAll(() => refusingUpstream.close());

describe("Grok video record — config acceptance", () => {
  let mock: LLMock | undefined;

  afterEach(async () => {
    await mock?.stop();
    mock = undefined;
  });

  test("LLMock accepts record.providers.grok", async () => {
    mock = new LLMock({
      port: 0,
      record: { providers: { grok: "https://api.x.ai" } },
    });
    await mock.start();
    expect(mock.url).toMatch(/^http:/);
  });
});

// ─── Submit proxy ────────────────────────────────────────────────────────────

describe("Grok video record — submit proxy", () => {
  let mock: LLMock | undefined;
  let upstream: GrokVideoUpstream | undefined;
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
    return fs.mkdtempSync(path.join(os.tmpdir(), "aimock-grok-video-record-"));
  }

  test("proxies an unmatched submit and returns a mock-rewritten {request_id}", async () => {
    upstream = await startGrokVideoUpstream({});
    tmpDir = makeTmpDir();
    mock = new LLMock({
      port: 0,
      record: { providers: { grok: upstream.url }, fixturePath: tmpDir },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/videos/generations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer sk-test",
        "X-Test-Id": "rec-grok",
      },
      body: JSON.stringify({ model: "grok-imagine-video", prompt: "record me" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(typeof data.request_id).toBe("string");
    expect(data.request_id.length).toBeGreaterThan(0);
    expect(data.request_id).not.toBe("grok-up-1");
    expect(upstream.counts.submit).toBe(1);
    expect(upstream.lastHeaders.submit?.authorization).toBe("Bearer sk-test");

    const entry = mock.journal
      .getAll()
      .find((e) => e.method === "POST" && e.path === "/v1/videos/generations");
    expect(entry).toBeDefined();
    expect(entry!.response.status).toBe(200);
    expect(entry!.response.source).toBe("proxy");
  });

  test("strict mode wins over record: 503, nothing proxied", async () => {
    upstream = await startGrokVideoUpstream({});
    tmpDir = makeTmpDir();
    mock = new LLMock({
      port: 0,
      strict: true,
      record: { providers: { grok: upstream.url }, fixturePath: tmpDir },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/videos/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "grok-imagine-video", prompt: "no fixture" }),
    });
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("no_fixture_match");
    expect(upstream.counts.submit).toBe(0);
  });

  test("record without a grok provider warns and falls through to 404", async () => {
    tmpDir = makeTmpDir();
    mock = new LLMock({
      port: 0,
      logLevel: "warn",
      record: { providers: { openai: UPSTREAM_DOWN_URL }, fixturePath: tmpDir },
    });
    await mock.start();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await fetch(`${mock.url}/v1/videos/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "grok-imagine-video", prompt: "unrecorded" }),
    });
    expect(res.status).toBe(404);
    expect(
      warnSpy.mock.calls.some((c) =>
        c.join(" ").includes('No upstream URL configured for provider "grok"'),
      ),
    ).toBe(true);
  });

  test("upstream connection failure returns 502 proxy_error journaled as proxy", async () => {
    tmpDir = makeTmpDir();
    mock = new LLMock({
      port: 0,
      logLevel: "silent",
      record: { providers: { grok: UPSTREAM_DOWN_URL }, fixturePath: tmpDir },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/videos/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "grok-imagine-video", prompt: "dead upstream" }),
    });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("Proxy to upstream failed");

    const entry = mock.journal
      .getAll()
      .find((e) => e.method === "POST" && e.path === "/v1/videos/generations");
    expect(entry).toBeDefined();
    expect(entry!.response.status).toBe(502);
    expect(entry!.response.source).toBe("proxy");
  });

  test("a matching fixture still replays without touching the upstream", async () => {
    upstream = await startGrokVideoUpstream({});
    tmpDir = makeTmpDir();
    mock = new LLMock({
      port: 0,
      record: { providers: { grok: upstream.url }, fixturePath: tmpDir },
    });
    mock.addFixture({
      match: { userMessage: "already recorded", endpoint: "video" },
      response: { video: { id: "vid_r", status: "completed", url: "https://x/v.mp4" } },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/videos/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "grok-imagine-video", prompt: "already recorded" }),
    });
    expect(res.status).toBe(200);
    expect(upstream.counts.submit).toBe(0);
  });
});

// ─── Poll proxy + eager capture ──────────────────────────────────────────────

describe("Grok video record — poll proxy and eager capture", () => {
  let mock: LLMock | undefined;
  let upstream: GrokVideoUpstream | undefined;
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
    return fs.mkdtempSync(path.join(os.tmpdir(), "aimock-grok-video-poll-"));
  }

  async function startRecordingMock(upstreamUrl: string): Promise<LLMock> {
    tmpDir = makeTmpDir();
    const m = new LLMock({
      port: 0,
      logLevel: "silent",
      record: { providers: { grok: upstreamUrl }, fixturePath: tmpDir },
    });
    await m.start();
    return m;
  }

  async function submitRecordJob(m: LLMock, prompt: string): Promise<{ request_id: string }> {
    const res = await fetch(`${m.url}/v1/videos/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sk-test" },
      body: JSON.stringify({ model: "grok-imagine-video", prompt }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { request_id: string };
  }

  test("pending polls are proxied 1:1 with synthesized/relayed progress", async () => {
    upstream = await startGrokVideoUpstream({ pollsBeforeDone: 2 });
    mock = await startRecordingMock(upstream.url);
    const { request_id } = await submitRecordJob(mock, "slow record");

    const poll1 = await (await fetch(`${mock.url}/v1/videos/${request_id}`)).json();
    expect(poll1.status).toBe("pending");
    expect(typeof poll1.progress).toBe("number");
    expect(upstream.counts.status).toBe(1);

    const poll2 = await (await fetch(`${mock.url}/v1/videos/${request_id}`)).json();
    expect(poll2.status).toBe("pending");
    expect(upstream.counts.status).toBe(2);

    const pollEntries = mock.journal
      .getAll()
      .filter((e) => e.method === "GET" && e.path.startsWith(`/v1/videos/${request_id}`));
    expect(pollEntries).toHaveLength(2);
    for (const e of pollEntries) {
      expect(e.response.status).toBe(200);
      expect(e.response.source).toBe("proxy");
    }
  });

  test("done poll captures the fixture eagerly (url, duration, cost) — NO byte download", async () => {
    upstream = await startGrokVideoUpstream({
      url: "https://cdn.x.ai/captured.mp4",
      duration: 8,
      costInUsdTicks: 4_200_000_000,
    });
    mock = await startRecordingMock(upstream.url);
    const { request_id } = await submitRecordJob(mock, "capture me");

    const poll = await (await fetch(`${mock.url}/v1/videos/${request_id}`)).json();
    expect(poll.request_id).toBe(request_id);
    expect(poll.status).toBe("done");
    expect(poll.video.url).toBe("https://cdn.x.ai/captured.mp4");
    expect(poll.video.duration).toBe(8);
    expect(poll.usage).toEqual({ cost_in_usd_ticks: 4_200_000_000 });

    await waitUntil(() => readRecordedFixtureFiles(tmpDir!).length === 1);

    const files = readRecordedFixtureFiles(tmpDir!);
    expect(files).toHaveLength(1);
    const saved = files[0].content as { fixtures: unknown[] };
    expect(saved.fixtures).toHaveLength(1);
    // STORED video.status is "completed" (NOT the wire "done"); cost persisted
    // as USD (ticks/1e10 = 4_200_000_000 / 1e10 = 0.42).
    expect(saved.fixtures[0]).toEqual({
      match: { endpoint: "video", userMessage: "capture me", model: "grok-imagine-video" },
      response: {
        video: {
          id: "grok-up-1",
          status: "completed",
          url: "https://cdn.x.ai/captured.mp4",
          duration: 8,
          cost: 0.42,
        },
      },
    });

    // A second identical submit replays without touching the upstream again.
    const second = await submitRecordJob(mock!, "capture me");
    expect(upstream.counts.submit).toBe(1);
    const secondPoll = await (await fetch(`${mock.url}/v1/videos/${second.request_id}`)).json();
    expect(secondPoll.status).toBe("done");
    expect(secondPoll.video.url).toBe("https://cdn.x.ai/captured.mp4");
    expect(secondPoll.usage).toEqual({ cost_in_usd_ticks: 4_200_000_000 });
    expect(upstream.counts.status).toBe(1); // served from the mutated replay job
  });

  test("post-capture polls served from the mutated replay job (upstream not hit again)", async () => {
    upstream = await startGrokVideoUpstream({});
    mock = await startRecordingMock(upstream.url);
    const { request_id } = await submitRecordJob(mock, "poll after done");

    await (await fetch(`${mock.url}/v1/videos/${request_id}`)).arrayBuffer();
    await waitUntil(() => readRecordedFixtureFiles(tmpDir!).length === 1);
    expect(upstream.counts.status).toBe(1);

    const again = await (await fetch(`${mock.url}/v1/videos/${request_id}`)).json();
    expect(again.status).toBe("done");
    expect(upstream.counts.status).toBe(1); // served from the mutated replay job
  });

  test("failed upstream persists a failed fixture and relays {code,error}", async () => {
    upstream = await startGrokVideoUpstream({
      finalStatus: "failed",
      error: "content policy violation",
    });
    mock = await startRecordingMock(upstream.url);
    const { request_id } = await submitRecordJob(mock, "doomed record");

    const poll = await (await fetch(`${mock.url}/v1/videos/${request_id}`)).json();
    expect(poll.status).toBe("failed");
    expect(typeof poll.code).toBe("string");
    expect(poll.error).toBe("content policy violation");

    await waitUntil(() => readRecordedFixtureFiles(tmpDir!).length === 1);
    const files = readRecordedFixtureFiles(tmpDir!);
    const saved = files[0].content as {
      fixtures: { response: { video: Record<string, unknown> } }[];
    };
    expect(saved.fixtures[0].response).toEqual({
      video: { id: "grok-up-1", status: "failed", error: "content policy violation" },
    });

    // Terminal conversion: the next poll is served from memory.
    const again = await (await fetch(`${mock.url}/v1/videos/${request_id}`)).json();
    expect(again.status).toBe("failed");
    expect(again.error).toBe("content policy violation");
    expect(upstream.counts.status).toBe(1);
  });

  test("expired upstream passes through, warns, persists nothing, keeps proxying", async () => {
    upstream = await startGrokVideoUpstream({ finalStatus: "expired" });
    tmpDir = makeTmpDir();
    mock = new LLMock({
      port: 0,
      logLevel: "warn",
      record: { providers: { grok: upstream.url }, fixturePath: tmpDir },
    });
    await mock.start();
    const { request_id } = await (async () => {
      const res = await fetch(`${mock!.url}/v1/videos/generations`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer sk-test" },
        body: JSON.stringify({ model: "grok-imagine-video", prompt: "expired record" }),
      });
      return (await res.json()) as { request_id: string };
    })();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const poll = await (await fetch(`${mock.url}/v1/videos/${request_id}`)).json();
    expect(poll.status).toBe("expired");
    expect(warnSpy.mock.calls.some((c) => c.join(" ").includes("not representable"))).toBe(true);

    // No fixture written; subsequent polls keep proxying live.
    expect(readRecordedFixtureFiles(tmpDir!)).toHaveLength(0);
    const again = await (await fetch(`${mock.url}/v1/videos/${request_id}`)).json();
    expect(again.status).toBe("expired");
    expect(upstream.counts.status).toBe(2);
  });

  test("upstream poll failure returns 502 proxy_error journaled as proxy", async () => {
    upstream = await startGrokVideoUpstream({});
    mock = await startRecordingMock(upstream.url);
    const { request_id } = await submitRecordJob(mock, "upstream dies");
    await upstream.close();
    upstream = undefined;

    const poll = await fetch(`${mock.url}/v1/videos/${request_id}`);
    expect(poll.status).toBe(502);
    expect((await poll.json()).error).toContain("Proxy to upstream failed");
    const entry = mock.journal
      .getAll()
      .find((e) => e.method === "GET" && e.path.startsWith(`/v1/videos/${request_id}`));
    expect(entry).toBeDefined();
    expect(entry!.response.status).toBe(502);
    expect(entry!.response.source).toBe("proxy");
  });

  test("Sora status still unaffected while a Grok record job exists", async () => {
    upstream = await startGrokVideoUpstream({ pollsBeforeDone: 5 });
    tmpDir = makeTmpDir();
    mock = new LLMock({
      port: 0,
      logLevel: "silent",
      record: { providers: { grok: upstream.url }, fixturePath: tmpDir },
    });
    // Sora fixture coexists with the live Grok record job.
    mock.addFixture({
      match: { userMessage: "sora coexists", endpoint: "video" },
      response: { video: { id: "video_sora_x", status: "completed", url: "https://s/c.mp4" } },
    });
    await mock.start();

    // Create the Grok record job (a live proxy, never terminal here).
    await (
      await fetch(`${mock.url}/v1/videos/generations`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer sk-test" },
        body: JSON.stringify({ model: "grok-imagine-video", prompt: "live grok" }),
      })
    ).arrayBuffer();

    // Create + poll a Sora video: it must serve the Sora envelope, NOT a Grok
    // proxy poll (the Grok job map miss falls through to handleVideoStatus).
    const create = await fetch(`${mock.url}/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "sora-2", prompt: "sora coexists" }),
    });
    const created = await create.json();
    const status = await fetch(`${mock.url}/v1/videos/${created.id}`);
    expect(status.status).toBe(200);
    const body = await status.json();
    expect(body.id).toBe(created.id);
    expect(body.status).toBe("completed");
    expect(typeof body.created_at).toBe("number");
    expect(body.request_id).toBeUndefined();
    expect(body.progress).toBeUndefined();
  });
});

// ─── Full record → replay round trip ─────────────────────────────────────────

describe("Grok video record — round trip (record session then replay session)", () => {
  let recordMock: LLMock | undefined;
  let replayMock: LLMock | undefined;
  let upstream: GrokVideoUpstream | undefined;
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
    const submit = await fetch(`${recordMock.url}/v1/videos/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sk-rec" },
      body: JSON.stringify({ model: "grok-imagine-video", prompt }),
    });
    expect(submit.status).toBe(200);
    const { request_id } = (await submit.json()) as { request_id: string };
    for (let i = 0; i < 10; i++) {
      const poll = await (
        await fetch(`${recordMock.url}/v1/videos/${request_id}`, {
          headers: { Authorization: "Bearer sk-rec" },
        })
      ).json();
      if (poll.status === "done" || poll.status === "failed") return;
    }
    throw new Error("record lifecycle did not terminate");
  }

  test("completed lifecycle round-trips: same url/duration, cost_in_usd_ticks reconstructed", async () => {
    upstream = await startGrokVideoUpstream({
      url: "https://cdn.x.ai/round-trip.mp4",
      duration: 10,
      costInUsdTicks: 12_300_000_000, // 1.23 USD
      pollsBeforeDone: 1,
    });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-grok-video-roundtrip-"));

    // ── Session 1: record ──
    recordMock = new LLMock({
      port: 0,
      logLevel: "silent",
      record: { providers: { grok: upstream.url }, fixturePath: tmpDir },
    });
    await recordMock.start();
    await recordLifecycle("round trip render");
    await waitUntil(() => readRecordedFixtureFiles(tmpDir!).length === 1);
    await recordMock.stop();
    recordMock = undefined;
    await upstream.close();
    upstream = undefined;

    // ── Session 2: replay from the recorded fixture file only ──
    replayMock = new LLMock({ port: 0 });
    replayMock.loadFixtureDir(tmpDir);
    await replayMock.start();

    const submit = await fetch(`${replayMock.url}/v1/videos/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "grok-imagine-video", prompt: "round trip render" }),
    });
    expect(submit.status).toBe(200);
    const { request_id } = (await submit.json()) as { request_id: string };

    const poll = await (await fetch(`${replayMock.url}/v1/videos/${request_id}`)).json();
    expect(poll.status).toBe("done");
    expect(poll.video.url).toBe("https://cdn.x.ai/round-trip.mp4");
    expect(poll.video.duration).toBe(10);
    // ticks = round(1.23 * 1e10) = 12_300_000_000
    expect(poll.usage).toEqual({ cost_in_usd_ticks: 12_300_000_000 });
  });

  test("failed lifecycle round-trips with the same error", async () => {
    upstream = await startGrokVideoUpstream({ finalStatus: "failed", error: "model exploded" });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-grok-video-roundtrip-"));

    recordMock = new LLMock({
      port: 0,
      logLevel: "silent",
      record: { providers: { grok: upstream.url }, fixturePath: tmpDir },
    });
    await recordMock.start();
    await recordLifecycle("round trip failure");
    await waitUntil(() => readRecordedFixtureFiles(tmpDir!).length === 1);
    await recordMock.stop();
    recordMock = undefined;
    await upstream.close();
    upstream = undefined;

    replayMock = new LLMock({ port: 0 });
    replayMock.loadFixtureDir(tmpDir);
    await replayMock.start();

    const submit = await fetch(`${replayMock.url}/v1/videos/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "grok-imagine-video", prompt: "round trip failure" }),
    });
    expect(submit.status).toBe(200);
    const { request_id } = (await submit.json()) as { request_id: string };

    const poll = await (await fetch(`${replayMock.url}/v1/videos/${request_id}`)).json();
    expect(poll.status).toBe("failed");
    expect(poll.error).toBe("model exploded");
  });
});
