import { describe, test, expect, afterAll, afterEach, vi } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LLMock } from "../llmock.js";
import { startRefusingUpstream } from "./helpers/refusing-upstream.js";

// ─── Protocol-aware stub Veo upstream ────────────────────────────────────────
// A real http.createServer on 127.0.0.1:0 implementing the two Veo endpoints —
// submit (POST :predictLongRunning → { name }) and operation poll (GET
// /v1beta/operations/{name} → done:false ... done:true with the Files-API uri).
// Tracks per-endpoint call counts and the last-received headers.

interface VeoUpstreamOptions {
  /** Non-terminal polls served before done:true. Default: 0. */
  pollsBeforeDone?: number;
  /** Files-API uri served on done:true. Default: a stub files url. */
  uri?: string;
  /** Terminal failure instead of success: { code, message }. */
  failError?: { code: number; message: string };
  /** Force the SUBMIT endpoint to reply with this HTTP status (JSON error). */
  submitHttpStatus?: number;
  /** Accept the submit and never respond (socket hang). */
  hangOnSubmit?: boolean;
}

interface VeoUpstream {
  url: string;
  close: () => Promise<void>;
  counts: { submit: number; status: number };
  lastHeaders: { submit?: http.IncomingHttpHeaders; status?: http.IncomingHttpHeaders };
}

const UPSTREAM_OP_NAME = "operations/up-veo-1";

function startVeoVideoUpstream(opts: VeoUpstreamOptions): Promise<VeoUpstream> {
  const pollsBeforeDone = opts.pollsBeforeDone ?? 0;
  const uri = opts.uri ?? "https://files.example/upstream.mp4";
  const counts = { submit: 0, status: 0 };
  const lastHeaders: VeoUpstream["lastHeaders"] = {};
  const opPolls = new Map<string, number>();
  const submitRe = /^\/v1beta\/models\/([^:]+):predictLongRunning$/;
  const operationRe = /^\/v1beta\/(operations\/.+)$/;

  return new Promise((resolve, reject) => {
    let selfUrl = "http://stub";
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const url = new URL(req.url ?? "/", selfUrl);
        const sendJson = (status: number, body: unknown): void => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(body));
        };

        if (req.method === "POST" && submitRe.test(url.pathname)) {
          counts.submit++;
          lastHeaders.submit = req.headers;
          if (opts.hangOnSubmit) return; // accept, never respond
          if (opts.submitHttpStatus !== undefined && opts.submitHttpStatus !== 200) {
            sendJson(opts.submitHttpStatus, {
              error: { code: opts.submitHttpStatus, message: "stub submit rejected" },
            });
            return;
          }
          sendJson(200, { name: UPSTREAM_OP_NAME });
          return;
        }

        const opMatch = url.pathname.match(operationRe);
        if (req.method === "GET" && opMatch) {
          counts.status++;
          lastHeaders.status = req.headers;
          const opName = opMatch[1];
          const n = (opPolls.get(opName) ?? 0) + 1;
          opPolls.set(opName, n);
          if (n <= pollsBeforeDone) {
            sendJson(200, { name: opName, done: false });
            return;
          }
          if (opts.failError) {
            sendJson(200, { name: opName, done: true, error: opts.failError });
            return;
          }
          sendJson(200, {
            name: opName,
            done: true,
            response: { generateVideoResponse: { generatedSamples: [{ video: { uri } }] } },
          });
          return;
        }

        sendJson(404, { error: { code: 404, message: "stub: unhandled", path: url.pathname } });
      });
    });
    server.once("error", reject);
    const sockets = new Set<net.Socket>();
    server.on("connection", (s) => {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
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
    .map((f) => ({ file: f, content: JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) }));
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

function veoSubmitUrl(base: string, model = "veo-3.1-generate-preview"): string {
  return `${base}/v1beta/models/${model}:predictLongRunning`;
}

// ─── Stub self-test ───────────────────────────────────────────────────────────

describe("startVeoVideoUpstream (stub self-test)", () => {
  let upstream: Awaited<ReturnType<typeof startVeoVideoUpstream>> | undefined;

  afterEach(async () => {
    await upstream?.close();
    upstream = undefined;
  });

  test("submit returns a name, polls advance done:false → done:true with the uri", async () => {
    upstream = await startVeoVideoUpstream({
      pollsBeforeDone: 1,
      uri: "https://files.example/x.mp4",
    });
    const submit = await fetch(veoSubmitUrl(upstream.url), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sk-up" },
      body: JSON.stringify({ instances: [{ prompt: "hi" }] }),
    });
    expect((await submit.json()).name).toBe(UPSTREAM_OP_NAME);
    expect(upstream.counts.submit).toBe(1);
    expect(upstream.lastHeaders.submit?.authorization).toBe("Bearer sk-up");

    const opUrl = `${upstream.url}/v1beta/${UPSTREAM_OP_NAME}`;
    expect((await (await fetch(opUrl)).json()).done).toBe(false);
    const done = await (await fetch(opUrl)).json();
    expect(done.done).toBe(true);
    expect(done.response.generateVideoResponse.generatedSamples[0].video.uri).toBe(
      "https://files.example/x.mp4",
    );
  });
});

// ─── Config acceptance ─────────────────────────────────────────────────────────

describe("Veo video record — config acceptance", () => {
  let mock: LLMock | undefined;
  afterEach(async () => {
    await mock?.stop();
    mock = undefined;
  });

  test("LLMock accepts record.providers.veo", async () => {
    mock = new LLMock({
      port: 0,
      record: { providers: { veo: "https://generativelanguage.googleapis.com" } },
    });
    await mock.start();
    expect(mock.url).toMatch(/^http:/);
  });
});

// ─── Record lifecycle ──────────────────────────────────────────────────────────

const refusingUpstream = await startRefusingUpstream();
const UPSTREAM_DOWN_URL = refusingUpstream.url;
afterAll(() => refusingUpstream.close());

describe("Veo video record — submit + poll proxy and eager capture", () => {
  let mock: LLMock | undefined;
  let upstream: Awaited<ReturnType<typeof startVeoVideoUpstream>> | undefined;
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
    return fs.mkdtempSync(path.join(os.tmpdir(), "aimock-veo-record-"));
  }

  async function startRecordingMock(upstreamUrl: string): Promise<LLMock> {
    tmpDir = makeTmpDir();
    const m = new LLMock({
      port: 0,
      logLevel: "silent",
      record: { providers: { veo: upstreamUrl }, fixturePath: tmpDir },
    });
    await m.start();
    return m;
  }

  async function submitRecord(m: LLMock, prompt: string): Promise<string> {
    const res = await fetch(veoSubmitUrl(m.url), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sk-test" },
      body: JSON.stringify({ instances: [{ prompt }] }),
    });
    expect(res.status).toBe(200);
    return (await res.json()).name as string;
  }

  test("proxies an unmatched submit and returns a mock-rewritten {name}", async () => {
    upstream = await startVeoVideoUpstream({ pollsBeforeDone: 1 });
    mock = await startRecordingMock(upstream.url);

    const res = await fetch(veoSubmitUrl(mock.url), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer sk-test",
        "X-Test-Id": "rec-a",
      },
      body: JSON.stringify({ instances: [{ prompt: "record me" }] }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.name.startsWith("operations/")).toBe(true);
    // The mock operation name must NOT be the upstream's.
    expect(data.name).not.toBe(UPSTREAM_OP_NAME);
    expect(upstream.counts.submit).toBe(1);
    expect(upstream.lastHeaders.submit?.authorization).toBe("Bearer sk-test");

    const submitEntry = mock.journal
      .getAll()
      .find((e) => e.method === "POST" && e.path.includes(":predictLongRunning"));
    expect(submitEntry?.response.source).toBe("proxy");
  });

  test("strict mode wins over record: 503, nothing proxied", async () => {
    upstream = await startVeoVideoUpstream({});
    tmpDir = makeTmpDir();
    mock = new LLMock({
      port: 0,
      strict: true,
      logLevel: "silent",
      record: { providers: { veo: upstream.url }, fixturePath: tmpDir },
    });
    await mock.start();
    const res = await fetch(veoSubmitUrl(mock.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instances: [{ prompt: "no fixture" }] }),
    });
    expect(res.status).toBe(503);
    expect(upstream.counts.submit).toBe(0);
  });

  test("record without a veo provider warns and falls through to 404", async () => {
    tmpDir = makeTmpDir();
    mock = new LLMock({
      port: 0,
      logLevel: "silent",
      record: { providers: { openrouter: "https://openrouter.ai" }, fixturePath: tmpDir },
    });
    await mock.start();
    const res = await fetch(veoSubmitUrl(mock.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instances: [{ prompt: "no veo provider" }] }),
    });
    expect(res.status).toBe(404);
  });

  test("upstream connection failure returns 502 proxy_error journaled as proxy", async () => {
    tmpDir = makeTmpDir();
    mock = new LLMock({
      port: 0,
      logLevel: "silent",
      record: { providers: { veo: UPSTREAM_DOWN_URL }, fixturePath: tmpDir },
    });
    await mock.start();
    const res = await fetch(veoSubmitUrl(mock.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instances: [{ prompt: "down upstream" }] }),
    });
    expect(res.status).toBe(502);
    expect((await res.json()).error.type).toBe("proxy_error");
    const entry = mock.journal
      .getAll()
      .find((e) => e.method === "POST" && e.path.includes(":predictLongRunning"));
    expect(entry?.response.source).toBe("proxy");
  });

  test("non-terminal polls proxied 1:1 and relayed with the mock operation name", async () => {
    upstream = await startVeoVideoUpstream({ pollsBeforeDone: 2 });
    mock = await startRecordingMock(upstream.url);
    const name = await submitRecord(mock, "slow record");

    const poll1 = await (await fetch(`${mock.url}/v1beta/${name}`)).json();
    expect(poll1.name).toBe(name);
    expect(poll1.done).toBe(false);
    expect(upstream.counts.status).toBe(1);

    const poll2 = await (await fetch(`${mock.url}/v1beta/${name}`)).json();
    expect(poll2.done).toBe(false);
    expect(upstream.counts.status).toBe(2);

    const pollEntries = mock.journal
      .getAll()
      .filter((e) => e.method === "GET" && e.path.includes(name));
    expect(pollEntries.length).toBe(2);
    for (const e of pollEntries) expect(e.response.source).toBe("proxy");
  });

  test("completed poll captures the fixture eagerly (uri) — NO byte download", async () => {
    upstream = await startVeoVideoUpstream({ uri: "https://files.example/captured.mp4" });
    mock = await startRecordingMock(upstream.url);
    const name = await submitRecord(mock, "capture me");

    const done = await (await fetch(`${mock.url}/v1beta/${name}`)).json();
    expect(done.done).toBe(true);
    expect(done.response.generateVideoResponse.generatedSamples[0].video.uri).toBe(
      "https://files.example/captured.mp4",
    );

    const dir = tmpDir as string;
    await waitUntil(() => readRecordedFixtureFiles(dir).length > 0);
    const fixtures = readRecordedFixtureFiles(dir);
    expect(fixtures.length).toBe(1);
    const content = fixtures[0].content as {
      fixtures: { response: { video: { url: string; status: string } } }[];
    };
    expect(content.fixtures[0].response.video.url).toBe("https://files.example/captured.mp4");
    expect(content.fixtures[0].response.video.status).toBe("completed");
    // Veo's operations envelope carries no cost field — capture must not invent one.
    expect(content.fixtures[0].response.video).not.toHaveProperty("cost");
  });

  test("post-capture polls served from the mutated replay job (upstream not hit again)", async () => {
    upstream = await startVeoVideoUpstream({ uri: "https://files.example/post.mp4" });
    mock = await startRecordingMock(upstream.url);
    const name = await submitRecord(mock, "post capture");

    await (await fetch(`${mock.url}/v1beta/${name}`)).json(); // triggers capture
    const dir = tmpDir as string;
    await waitUntil(() => readRecordedFixtureFiles(dir).length > 0);
    const statusAfterCapture = upstream.counts.status;

    const replayed = await (await fetch(`${mock.url}/v1beta/${name}`)).json();
    expect(replayed.done).toBe(true);
    expect(replayed.response.generateVideoResponse.generatedSamples[0].video.uri).toBe(
      "https://files.example/post.mp4",
    );
    // The mutated replay job serves locally — no new upstream poll.
    expect(upstream.counts.status).toBe(statusAfterCapture);
  });

  test("proxyOnly: terminal job keeps proxying live, nothing persisted", async () => {
    upstream = await startVeoVideoUpstream({ uri: "https://files.example/proxyonly.mp4" });
    tmpDir = makeTmpDir();
    mock = new LLMock({
      port: 0,
      logLevel: "silent",
      record: { providers: { veo: upstream.url }, fixturePath: tmpDir, proxyOnly: true },
    });
    await mock.start();
    const name = await submitRecord(mock, "proxy only");

    const done1 = await (await fetch(`${mock.url}/v1beta/${name}`)).json();
    expect(done1.done).toBe(true);
    const statusAfter = upstream.counts.status;
    // A second poll still hits the upstream (no replay mutation under proxyOnly).
    const done2 = await (await fetch(`${mock.url}/v1beta/${name}`)).json();
    expect(done2.done).toBe(true);
    expect(upstream.counts.status).toBe(statusAfter + 1);
    expect(readRecordedFixtureFiles(tmpDir).length).toBe(0);
  });

  test("round trip: record session then replay session matches", async () => {
    upstream = await startVeoVideoUpstream({
      pollsBeforeDone: 1,
      uri: "https://files.example/roundtrip.mp4",
    });
    mock = await startRecordingMock(upstream.url);
    const name = await submitRecord(mock, "round trip render");

    // Drive to terminal.
    await (await fetch(`${mock.url}/v1beta/${name}`)).json(); // done:false
    const done = await (await fetch(`${mock.url}/v1beta/${name}`)).json(); // done:true
    expect(done.done).toBe(true);
    const dir = tmpDir as string;
    await waitUntil(() => readRecordedFixtureFiles(dir).length > 0);
    await mock.stop();
    mock = undefined;

    // Fresh replay session loads the recorded fixture.
    const replayMock = new LLMock({ port: 0, logLevel: "silent" });
    replayMock.loadFixtureDir(dir);
    await replayMock.start();
    try {
      const submit = await fetch(veoSubmitUrl(replayMock.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instances: [{ prompt: "round trip render" }] }),
      });
      expect(submit.status).toBe(200);
      const replayName = (await submit.json()).name as string;
      const replayDone = await (await fetch(`${replayMock.url}/v1beta/${replayName}`)).json();
      expect(replayDone.done).toBe(true);
      expect(replayDone.response.generateVideoResponse.generatedSamples[0].video.uri).toBe(
        "https://files.example/roundtrip.mp4",
      );
      // No upstream contact during replay (upstream poll count unchanged from
      // the record session's two polls).
      expect(upstream.counts.status).toBe(2);
    } finally {
      await replayMock.stop();
    }
  });
});
