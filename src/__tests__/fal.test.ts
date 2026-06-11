import { describe, test, expect, afterEach, vi } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LLMock } from "../llmock.js";

describe("fal.ai general handler — fixture lookup", () => {
  let mock: LLMock;

  afterEach(async () => {
    await mock?.stop();
  });

  test("onFalQueue: submit returns envelope, status returns COMPLETED, result returns JSON", async () => {
    mock = new LLMock({ port: 0 });
    mock.onFalQueue(/flux/, { images: [{ url: "https://example.com/cat.png" }] });
    await mock.start();

    const submit = await fetch(`${mock.url}/fal/fal-ai/flux/dev`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-fal-target-host": "queue.fal.run" },
      body: JSON.stringify({ input: { prompt: "a cat" } }),
    });
    expect(submit.status).toBe(200);
    const envelope = await submit.json();
    expect(envelope.request_id).toBeDefined();
    expect(envelope.status_url).toContain(envelope.request_id);
    expect(envelope.response_url).toContain(envelope.request_id);
    expect(envelope.cancel_url).toContain(envelope.request_id);

    const status = await fetch(
      `${mock.url}/fal/fal-ai/flux/dev/requests/${envelope.request_id}/status`,
      { headers: { "x-fal-target-host": "queue.fal.run" } },
    );
    expect(status.status).toBe(200);
    const statusBody = await status.json();
    expect(statusBody.status).toBe("COMPLETED");
    expect(statusBody.request_id).toBe(envelope.request_id);

    const result = await fetch(`${mock.url}/fal/fal-ai/flux/dev/requests/${envelope.request_id}`, {
      headers: { "x-fal-target-host": "queue.fal.run" },
    });
    expect(result.status).toBe(200);
    const resultBody = await result.json();
    expect(resultBody).toEqual({ images: [{ url: "https://example.com/cat.png" }] });
  });

  test("body extraction handles input.prompt nesting (fal-client default shape)", async () => {
    mock = new LLMock({ port: 0 });
    mock.onFalQueue(/flux/, { images: [{ url: "https://example.com/x.png" }] });
    await mock.start();

    const submit = await fetch(`${mock.url}/fal/fal-ai/flux/dev`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-fal-target-host": "queue.fal.run" },
      body: JSON.stringify({ input: { prompt: "a cat", image_size: "square_hd" }, logs: false }),
    });
    expect(submit.status).toBe(200);
  });

  test("sync run returns JSON directly via x-fal-target-host: fal.run", async () => {
    mock = new LLMock({ port: 0 });
    mock.onFalRun(/flux/, { images: [{ url: "https://example.com/sync.png" }] });
    await mock.start();

    const res = await fetch(`${mock.url}/fal/fal-ai/flux/dev`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-fal-target-host": "fal.run" },
      body: JSON.stringify({ prompt: "a cat" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ images: [{ url: "https://example.com/sync.png" }] });
    expect(data.request_id).toBeUndefined();
  });

  test("cancel returns ALREADY_COMPLETED for stored job", async () => {
    mock = new LLMock({ port: 0 });
    mock.onFalQueue(/kling/, { video: { url: "https://example.com/v.mp4" } });
    await mock.start();

    const submit = await fetch(`${mock.url}/fal/fal-ai/kling/v1`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-fal-target-host": "queue.fal.run" },
      body: JSON.stringify({ input: { prompt: "river" } }),
    });
    const envelope = await submit.json();

    const cancel = await fetch(
      `${mock.url}/fal/fal-ai/kling/v1/requests/${envelope.request_id}/cancel`,
      { method: "PUT", headers: { "x-fal-target-host": "queue.fal.run" } },
    );
    expect(cancel.status).toBe(400);
    const body = await cancel.json();
    expect(body.status).toBe("ALREADY_COMPLETED");
  });

  test("status for unknown request_id returns 404", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    const res = await fetch(`${mock.url}/fal/fal-ai/flux/dev/requests/missing/status`, {
      headers: { "x-fal-target-host": "queue.fal.run" },
    });
    expect(res.status).toBe(404);
  });

  test("no fixture match returns 404 in non-strict mode", async () => {
    mock = new LLMock({ port: 0 });
    mock.onFalQueue(/flux/, { images: [] });
    await mock.start();

    const res = await fetch(`${mock.url}/fal/fal-ai/different-model/v1`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-fal-target-host": "queue.fal.run" },
      body: JSON.stringify({ input: { prompt: "x" } }),
    });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error.code).toBe("no_fixture_match");
  });

  test("error fixture returns the configured status", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { model: /kling/, endpoint: "fal" },
      response: { error: { message: "rate limited", type: "rate_limit_error" }, status: 429 },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/fal/fal-ai/kling/v1`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-fal-target-host": "queue.fal.run" },
      body: JSON.stringify({ input: { prompt: "river" } }),
    });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.message).toBe("rate limited");
  });

  test("storage upload initiate returns synthesised envelope", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    const res = await fetch(`${mock.url}/fal/storage/upload/initiate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-fal-target-host": "rest.alpha.fal.ai" },
      body: JSON.stringify({ filename: "cat.png" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.upload_url).toContain("rest.alpha.fal.ai");
    expect(data.file_url).toContain("cat.png");
  });

  test("X-Test-Id isolation across queue jobs", async () => {
    mock = new LLMock({ port: 0 });
    mock.onFalQueue(/flux/, { images: [{ url: "https://example.com/iso.png" }] });
    await mock.start();

    const submitA = await fetch(`${mock.url}/fal/fal-ai/flux/dev`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-fal-target-host": "queue.fal.run",
        "X-Test-Id": "A",
      },
      body: JSON.stringify({ input: { prompt: "a" } }),
    });
    const envelopeA = await submitA.json();

    const cross = await fetch(
      `${mock.url}/fal/fal-ai/flux/dev/requests/${envelopeA.request_id}/status`,
      {
        headers: { "x-fal-target-host": "queue.fal.run", "X-Test-Id": "B" },
      },
    );
    expect(cross.status).toBe(404);

    const same = await fetch(
      `${mock.url}/fal/fal-ai/flux/dev/requests/${envelopeA.request_id}/status`,
      {
        headers: { "x-fal-target-host": "queue.fal.run", "X-Test-Id": "A" },
      },
    );
    expect(same.status).toBe(200);
  });

  test("legacy /fal/queue/submit/{model} path still works for audio fixtures", async () => {
    mock = new LLMock({ port: 0 });
    mock.onFalAudio("drum", { audio: "SGVsbG8=", format: "mp3" });
    await mock.start();

    const submit = await fetch(`${mock.url}/fal/queue/submit/fal-ai/stable-audio`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "drum" }),
    });
    expect(submit.status).toBe(200);
  });
});

// Queue-protocol-aware stub upstream. Implements the three endpoints fal's
// queue uses: POST submit → IN_QUEUE envelope, GET .../status (polled) →
// IN_QUEUE/IN_PROGRESS until the configured threshold is reached, then
// COMPLETED, and GET .../<id> → the supplied final body. Tracks call counts
// per endpoint so tests can assert what hit the wire vs. the in-memory cache.
function startFalQueueUpstream(opts: {
  finalBody: unknown;
  pollsBeforeCompleted?: number;
  upstreamRequestId?: string;
}): Promise<{
  url: string;
  close: () => Promise<void>;
  counts: { submit: number; status: number; result: number };
  lastHeaders: { submit?: http.IncomingHttpHeaders };
}> {
  const upstreamRequestId = opts.upstreamRequestId ?? "upstream-req-id";
  const pollsBeforeCompleted = opts.pollsBeforeCompleted ?? 2;
  const counts = { submit: 0, status: 0, result: 0 };
  const lastHeaders: { submit?: http.IncomingHttpHeaders } = {};
  const statusPolls = new Map<string, number>();
  const statusRe = /^\/(.+)\/requests\/([^/]+)\/status$/;
  const resultRe = /^\/(.+)\/requests\/([^/]+)$/;

  return new Promise((resolve, reject) => {
    let selfUrl = "http://stub";
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const url = new URL(req.url ?? "/", selfUrl);
        const send = (status: number, body: unknown) => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(body));
        };

        const statusMatch = url.pathname.match(statusRe);
        const resultMatch = url.pathname.match(resultRe);

        if (req.method === "GET" && statusMatch) {
          counts.status++;
          const reqId = statusMatch[2];
          const n = (statusPolls.get(reqId) ?? 0) + 1;
          statusPolls.set(reqId, n);
          const status = n >= pollsBeforeCompleted ? "COMPLETED" : "IN_QUEUE";
          send(200, {
            status,
            request_id: reqId,
            ...(status === "IN_QUEUE" ? { queue_position: 1 } : {}),
          });
          return;
        }
        if (req.method === "GET" && resultMatch && !statusMatch) {
          counts.result++;
          send(200, opts.finalBody);
          return;
        }
        if (req.method === "POST") {
          counts.submit++;
          lastHeaders.submit = req.headers;
          const modelPath = url.pathname.replace(/^\/+/, "");
          const base = `${selfUrl}/${modelPath}/requests/${upstreamRequestId}`;
          send(200, {
            request_id: upstreamRequestId,
            response_url: base,
            status_url: `${base}/status`,
            cancel_url: `${base}/cancel`,
            status: "IN_QUEUE",
            queue_position: 1,
          });
          return;
        }
        send(404, { error: { message: "stub: unhandled", path: url.pathname } });
      });
    });
    // A listen failure must reject instead of leaving the returned promise
    // pending forever.
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      selfUrl = `http://127.0.0.1:${port}`;
      resolve({
        url: selfUrl,
        counts,
        lastHeaders,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

describe("fal.ai general handler — record and replay", () => {
  let mock: LLMock;
  let upstream: { url: string; close: () => Promise<void> } | undefined;
  let queueUpstream: Awaited<ReturnType<typeof startFalQueueUpstream>> | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    await mock?.stop();
    await upstream?.close();
    await queueUpstream?.close();
    upstream = undefined;
    queueUpstream = undefined;
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  test("walks the queue upstream during recording and persists the FINAL body, not the submit envelope", async () => {
    const FINAL_BODY = {
      images: [{ url: "https://mock.fal.media/files/recorded-cat.png" }],
      seed: 42,
    };
    queueUpstream = await startFalQueueUpstream({
      finalBody: FINAL_BODY,
      pollsBeforeCompleted: 2,
      upstreamRequestId: "upstream-req-1",
    });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-fal-queue-record-"));

    mock = new LLMock({
      port: 0,
      record: {
        providers: { fal: queueUpstream.url },
        fixturePath: tmpDir,
        fal: { pollIntervalMs: 5, timeoutMs: 5000 },
      },
    });
    await mock.start();

    // Submit — client should see a synthesised envelope (aimock requestId),
    // NOT upstream's IN_QUEUE envelope. The whole point of the fix.
    const submit = await fetch(`${mock.url}/fal/fal-ai/flux/dev`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-fal-target-host": "queue.fal.run" },
      body: JSON.stringify({ input: { prompt: "a cat" } }),
    });
    expect(submit.status).toBe(200);
    const envelope = await submit.json();
    expect(typeof envelope.request_id).toBe("string");
    expect(envelope.request_id).not.toBe("upstream-req-1");
    expect(envelope.status_url).toContain(envelope.request_id);

    // Status — local job seeded with the final body, so this is COMPLETED.
    const status = await fetch(
      `${mock.url}/fal/fal-ai/flux/dev/requests/${envelope.request_id}/status`,
      { headers: { "x-fal-target-host": "queue.fal.run" } },
    );
    expect(status.status).toBe(200);
    expect((await status.json()).status).toBe("COMPLETED");

    // Result — must be the FINAL body, not the upstream submit envelope.
    // This is the assertion that fails before the fix: on main, the recorder
    // persisted the IN_QUEUE envelope, so this returned `{ request_id: ..., status: "IN_QUEUE", ... }`.
    const result = await fetch(`${mock.url}/fal/fal-ai/flux/dev/requests/${envelope.request_id}`, {
      headers: { "x-fal-target-host": "queue.fal.run" },
    });
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual(FINAL_BODY);

    expect(queueUpstream.counts.submit).toBe(1);
    expect(queueUpstream.counts.status).toBeGreaterThanOrEqual(2);
    expect(queueUpstream.counts.result).toBe(1);

    // Persisted fixture: response.json must be the FINAL body, not the envelope.
    const files = fs.readdirSync(tmpDir);
    const falFixtures = files.filter((f) => f.startsWith("fal-") && f.endsWith(".json"));
    expect(falFixtures.length).toBe(1);
    const recorded = JSON.parse(fs.readFileSync(path.join(tmpDir, falFixtures[0]), "utf-8"));
    expect(recorded.fixtures[0].match.endpoint).toBe("fal");
    expect(recorded.fixtures[0].response.json).toEqual(FINAL_BODY);
  });

  test("mock-internal headers never reach the upstream on the recorded queue walk", async () => {
    // CHANGELOG/docs claim x-test-id / x-aimock-strict / x-aimock-context /
    // x-aimock-chaos-* are stripped "on every provider proxy path" — pin the
    // fal queue walk (buildForwardHeaders) to that claim.
    queueUpstream = await startFalQueueUpstream({
      finalBody: { images: [{ url: "https://example.com/hdr.png" }] },
      pollsBeforeCompleted: 1,
    });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-fal-queue-hdrs-"));
    mock = new LLMock({
      port: 0,
      record: {
        providers: { fal: queueUpstream.url },
        fixturePath: tmpDir,
        fal: { pollIntervalMs: 5, timeoutMs: 5000 },
      },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/fal/fal-ai/flux/dev`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-fal-target-host": "queue.fal.run",
        Authorization: "Key fal-secret",
        "X-Test-Id": "fal-hdr-strip",
        "X-AIMock-Strict": "false",
        "X-AIMock-Context": "ctx-strip",
        "X-AIMock-Chaos-Drop": "0",
      },
      body: JSON.stringify({ input: { prompt: "a cat" } }),
    });
    expect(submit.status).toBe(200);

    const captured = queueUpstream.lastHeaders.submit;
    expect(captured).toBeDefined();
    expect(captured!["x-test-id"]).toBeUndefined();
    expect(captured!["x-aimock-strict"]).toBeUndefined();
    expect(captured!["x-aimock-context"]).toBeUndefined();
    expect(captured!["x-aimock-chaos-drop"]).toBeUndefined();
    // Auth still forwarded.
    expect(captured!.authorization).toBe("Key fal-secret");
  });

  test("replays from in-memory fixture on second identical request without a second queue walk", async () => {
    queueUpstream = await startFalQueueUpstream({
      finalBody: { images: [{ url: "https://example.com/replay.png" }] },
      pollsBeforeCompleted: 1,
    });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-fal-queue-replay-"));

    mock = new LLMock({
      port: 0,
      record: {
        providers: { fal: queueUpstream.url },
        fixturePath: tmpDir,
        fal: { pollIntervalMs: 5, timeoutMs: 5000 },
      },
    });
    await mock.start();

    // First call: records via a full queue walk
    const firstSubmit = await fetch(`${mock.url}/fal/fal-ai/flux/dev`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-fal-target-host": "queue.fal.run" },
      body: JSON.stringify({ input: { prompt: "a cat" } }),
    });
    expect(firstSubmit.status).toBe(200);
    expect(queueUpstream.counts.submit).toBe(1);

    // Second call with the same body — should match the cached fixture, no
    // upstream walk. Submit, status, result all served locally.
    const beforeReplay = { ...queueUpstream.counts };
    const replaySubmit = await fetch(`${mock.url}/fal/fal-ai/flux/dev`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-fal-target-host": "queue.fal.run" },
      body: JSON.stringify({ input: { prompt: "a cat" } }),
    });
    expect(replaySubmit.status).toBe(200);
    const replayEnvelope = await replaySubmit.json();
    const replayResult = await fetch(
      `${mock.url}/fal/fal-ai/flux/dev/requests/${replayEnvelope.request_id}`,
      { headers: { "x-fal-target-host": "queue.fal.run" } },
    );
    expect(replayResult.status).toBe(200);
    expect(await replayResult.json()).toEqual({
      images: [{ url: "https://example.com/replay.png" }],
    });

    expect(queueUpstream.counts).toEqual(beforeReplay);
  });

  test("queue walk failure surfaces 502 and does not write a fixture", async () => {
    // Upstream returns a submit envelope, but status calls 500. Recorder must
    // give up cleanly: client sees 502, no fixture is persisted (a partial
    // fixture would shadow real requests on the next run).
    // The envelope URLs must use the server's REAL origin (selfUrl), not a
    // literal placeholder host: walkFalQueue adopts same-origin envelope URLs,
    // so a bogus host would fail on DNS/connect instead of exercising the
    // intended status-500 branch (round-4 B8).
    let selfUrl = "http://stub";
    upstream = await new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          const url = new URL(req.url ?? "/", selfUrl);
          if (req.method === "POST" && !url.pathname.includes("/requests/")) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                request_id: "x",
                status_url: `${selfUrl}${url.pathname}/requests/x/status`,
                response_url: `${selfUrl}${url.pathname}/requests/x`,
              }),
            );
            return;
          }
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "upstream broke" } }));
        });
      });
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as { port: number };
        selfUrl = `http://127.0.0.1:${port}`;
        resolve({
          url: selfUrl,
          close: () =>
            new Promise<void>((r) => {
              server.close(() => r());
            }),
        });
      });
    });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-fal-queue-fail-"));

    mock = new LLMock({
      port: 0,
      record: {
        providers: { fal: upstream.url },
        fixturePath: tmpDir,
        fal: { pollIntervalMs: 5, timeoutMs: 2000 },
      },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/fal/fal-ai/flux/dev`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-fal-target-host": "queue.fal.run" },
      body: JSON.stringify({ input: { prompt: "a cat" } }),
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.type).toBe("proxy_error");

    const files = fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir) : [];
    const falFixtures = files.filter((f) => f.startsWith("fal-") && f.endsWith(".json"));
    expect(falFixtures.length).toBe(0);
  });

  test("A6: envelope-nominated off-origin queue URLs are never followed with the client's credentials", async () => {
    // Round-4 A6 (red-green): the same-origin policy the OpenRouter video
    // proxy applies to envelope polling_urls now gates the fal queue walk —
    // an envelope nominating a foreign host must not receive the client's
    // Authorization; the walk falls back to the constructed canonical paths
    // on the configured upstream origin (with a warn).
    const FINAL_BODY = { images: [{ url: "https://example.com/canonical.png" }] };
    const evilRequests: { path: string; auth?: string }[] = [];
    const evil = await new Promise<{ url: string; close: () => Promise<void> }>(
      (resolve, reject) => {
        const server = http.createServer((req, res) => {
          evilRequests.push({ path: req.url ?? "", auth: req.headers.authorization });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "COMPLETED", request_id: "evil" }));
        });
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const { port } = server.address() as { port: number };
          resolve({
            url: `http://127.0.0.1:${port}`,
            close: () => new Promise<void>((r) => server.close(() => r())),
          });
        });
      },
    );
    let warnSpy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const evilUrl = evil.url;
      // Real upstream: the submit envelope nominates the EVIL host; the
      // constructed canonical paths on this origin serve the true lifecycle.
      let selfUrl = "http://stub";
      upstream = await new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
          const chunks: Buffer[] = [];
          req.on("data", (c: Buffer) => chunks.push(c));
          req.on("end", () => {
            const url = new URL(req.url ?? "/", selfUrl);
            const send = (status: number, body: unknown): void => {
              res.writeHead(status, { "Content-Type": "application/json" });
              res.end(JSON.stringify(body));
            };
            if (req.method === "POST") {
              send(200, {
                request_id: "r-a6",
                status_url: `${evilUrl}/hijacked/requests/r-a6/status`,
                response_url: `${evilUrl}/hijacked/requests/r-a6`,
                status: "IN_QUEUE",
              });
              return;
            }
            if (url.pathname.endsWith("/status")) {
              send(200, { status: "COMPLETED", request_id: "r-a6" });
              return;
            }
            send(200, FINAL_BODY);
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
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-fal-a6-"));
      mock = new LLMock({
        port: 0,
        logLevel: "warn",
        record: {
          providers: { fal: upstream.url },
          fixturePath: tmpDir,
          fal: { pollIntervalMs: 5, timeoutMs: 5000 },
        },
      });
      await mock.start();
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const submit = await fetch(`${mock.url}/fal/fal-ai/flux/dev`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-fal-target-host": "queue.fal.run",
          Authorization: "Key fal-secret",
        },
        body: JSON.stringify({ input: { prompt: "a hijack" } }),
      });
      expect(submit.status).toBe(200);

      // The evil host never saw a single request — let alone the credential.
      expect(evilRequests).toHaveLength(0);
      // The walk warned about the off-origin envelope URLs...
      expect(
        warnSpy.mock.calls.some((c) => c.join(" ").includes("differs from the upstream origin")),
      ).toBe(true);
      // ...and recorded the CANONICAL final body from the real upstream.
      const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".json"));
      expect(files).toHaveLength(1);
      const recorded = JSON.parse(fs.readFileSync(path.join(tmpDir, files[0]), "utf-8"));
      expect(recorded.fixtures[0].response.json).toEqual(FINAL_BODY);
    } finally {
      // Restore in the finally: a failing assertion above must not leak the
      // console.warn stub into later tests.
      warnSpy?.mockRestore();
      await evil.close();
    }
  });

  test("B5: a persist failure on the queue-walk record sets X-AIMock-Record-Error on the envelope", async () => {
    // Parity with the generic recorder and the OpenRouter failed branch: the
    // envelope's headers have not been sent when persistFixture fails, so the
    // failure can (and now does) ride the response.
    queueUpstream = await startFalQueueUpstream({
      finalBody: { images: [{ url: "https://example.com/unsaveable.png" }] },
      pollsBeforeCompleted: 1,
    });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-fal-persistfail-"));
    const blockerFile = path.join(tmpDir, "not-a-dir");
    fs.writeFileSync(blockerFile, "in the way");
    mock = new LLMock({
      port: 0,
      logLevel: "silent",
      record: {
        providers: { fal: queueUpstream.url },
        fixturePath: blockerFile,
        fal: { pollIntervalMs: 5, timeoutMs: 5000 },
      },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/fal/fal-ai/flux/dev`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-fal-target-host": "queue.fal.run" },
      body: JSON.stringify({ input: { prompt: "unsaveable" } }),
    });
    expect(submit.status).toBe(200);
    expect(submit.headers.get("x-aimock-record-error")).toBeTruthy();
    await submit.arrayBuffer();
  });

  test("a hung upstream status poll is bounded by record.upstreamTimeoutMs (502, no hang)", async () => {
    // The walk-level timeoutMs only fires BETWEEN polls — a status fetch
    // whose upstream accepts the request and never responds must be bounded
    // by the per-fetch upstreamTimeoutMs, surfacing through the walk's
    // existing 502/no-fixture failure handling.
    let selfUrl = "http://stub";
    const sockets = new Set<net.Socket>();
    upstream = await new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          const url = new URL(req.url ?? "/", selfUrl);
          if (req.method === "POST" && !url.pathname.includes("/requests/")) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                request_id: "x",
                status_url: `${selfUrl}${url.pathname}/requests/x/status`,
                response_url: `${selfUrl}${url.pathname}/requests/x`,
              }),
            );
            return;
          }
          // status/result: accept the request and never respond.
        });
      });
      server.on("connection", (s) => {
        sockets.add(s);
        s.on("close", () => sockets.delete(s));
      });
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as { port: number };
        selfUrl = `http://127.0.0.1:${port}`;
        resolve({
          url: selfUrl,
          close: () =>
            new Promise<void>((r) => {
              for (const s of sockets) s.destroy();
              server.close(() => r());
            }),
        });
      });
    });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-fal-hung-status-"));
    mock = new LLMock({
      port: 0,
      logLevel: "silent",
      record: {
        providers: { fal: upstream.url },
        fixturePath: tmpDir,
        upstreamTimeoutMs: 300,
        // Walk budget far above the per-fetch timeout: only the AbortSignal
        // on the status fetch can produce the bounded 502 below.
        fal: { pollIntervalMs: 5, timeoutMs: 60_000 },
      },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/fal/fal-ai/flux/dev`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-fal-target-host": "queue.fal.run" },
      body: JSON.stringify({ input: { prompt: "a hung poll" } }),
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.type).toBe("proxy_error");
    const files = fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir) : [];
    expect(files.filter((f) => f.endsWith(".json"))).toHaveLength(0);
  }, 10_000);

  test("pollIntervalMs: 0 completes the walk instead of timing out immediately", async () => {
    // A zero poll interval used to satisfy the `sleep <= 0` timeout check on
    // the FIRST non-terminal poll, producing a spurious "Queue walk timed
    // out" with the whole budget left — the walk must only time out when the
    // deadline is actually exhausted.
    const FINAL_BODY = { images: [{ url: "https://mock.fal.media/files/zero-interval.png" }] };
    queueUpstream = await startFalQueueUpstream({
      finalBody: FINAL_BODY,
      pollsBeforeCompleted: 2,
    });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-fal-zero-interval-"));
    mock = new LLMock({
      port: 0,
      logLevel: "silent",
      record: {
        providers: { fal: queueUpstream.url },
        fixturePath: tmpDir,
        fal: { pollIntervalMs: 0, timeoutMs: 5000 },
      },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/fal/fal-ai/flux/dev`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-fal-target-host": "queue.fal.run" },
      body: JSON.stringify({ input: { prompt: "zero interval" } }),
    });
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    const recorded = JSON.parse(fs.readFileSync(path.join(tmpDir, files[0]), "utf-8"));
    expect(recorded.fixtures[0].response.json).toEqual(FINAL_BODY);
  });

  test("a null submit body fails the walk with a clean message, not a TypeError (round 6)", async () => {
    // JSON.parse("null") passes parseJsonOrThrow — the walk must reject the
    // non-object shape itself instead of TypeError-ing on env.request_id.
    let selfUrl = "http://stub";
    upstream = await new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("null");
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-fal-null-submit-"));
    mock = new LLMock({
      port: 0,
      logLevel: "silent",
      record: {
        providers: { fal: upstream.url },
        fixturePath: tmpDir,
        fal: { pollIntervalMs: 5, timeoutMs: 2000 },
      },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/fal/fal-ai/flux/dev`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-fal-target-host": "queue.fal.run" },
      body: JSON.stringify({ input: { prompt: "null envelope" } }),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { message: string; type: string } };
    expect(body.error.type).toBe("proxy_error");
    expect(body.error.message).toContain("Submit response is not a JSON object");
  });

  test("a client that disconnects during the queue walk leaves no journal entry (round 6)", async () => {
    // The walk is a multi-second await — a client gone by the time it
    // finishes must get neither a write nor a journal entry (the
    // openrouter-video file convention). The fixture itself still persists:
    // the captured upstream response is valuable regardless.
    queueUpstream = await startFalQueueUpstream({
      finalBody: { images: [{ url: "https://example.com/gone-client.png" }] },
      pollsBeforeCompleted: 3,
    });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-fal-disconnect-"));
    mock = new LLMock({
      port: 0,
      logLevel: "silent",
      record: {
        providers: { fal: queueUpstream.url },
        fixturePath: tmpDir,
        fal: { pollIntervalMs: 200, timeoutMs: 5000 },
      },
    });
    await mock.start();

    const ac = new AbortController();
    const pending = fetch(`${mock.url}/fal/fal-ai/flux/dev`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-fal-target-host": "queue.fal.run" },
      body: JSON.stringify({ input: { prompt: "client walks away" } }),
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 100);
    await expect(pending).rejects.toThrow();

    // The walk continues server-side — wait for it to fetch the result, then
    // give the handler's post-walk steps a beat to run.
    const deadline = Date.now() + 5000;
    while (queueUpstream.counts.result < 1) {
      if (Date.now() > deadline) throw new Error("queue walk never completed");
      await new Promise<void>((r) => setTimeout(r, 20));
    }
    await new Promise<void>((r) => setTimeout(r, 150));

    // No journal entry for the aborted submit — the 200 never left.
    const entry = mock.journal
      .getAll()
      .find((e) => e.method === "POST" && e.path === "/fal/fal-ai/flux/dev");
    expect(entry).toBeUndefined();
    // The fixture still landed (deliberate: the walk completed upstream-side).
    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
  });
});

describe("fal.ai general handler — typed helpers + polling progression", () => {
  let mock: LLMock;

  afterEach(async () => {
    await mock?.stop();
  });

  test("onFalImage wraps an ImageResponse into fal's image envelope", async () => {
    mock = new LLMock({ port: 0 });
    mock.onFalImage(/flux/, {
      images: [{ url: "https://mock.fal.media/files/x.png" }],
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/fal/fal-ai/flux/dev`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-fal-target-host": "queue.fal.run" },
      body: JSON.stringify({ input: { prompt: "a cat" } }),
    });
    expect(submit.status).toBe(200);
    const envelope = await submit.json();

    const result = await fetch(`${mock.url}/fal/fal-ai/flux/dev/requests/${envelope.request_id}`, {
      headers: { "x-fal-target-host": "queue.fal.run" },
    });
    expect(result.status).toBe(200);
    const data = await result.json();
    expect(data.images).toEqual([
      {
        url: "https://mock.fal.media/files/x.png",
        width: 1024,
        height: 1024,
        content_type: "image/png",
      },
    ]);
    expect(data.has_nsfw_concepts).toEqual([false]);
    expect(data.timings).toEqual({ inference: 0 });
    expect(data.seed).toBe(0);
  });

  test("onFalImage falls back to a mock URL when ImageItem omits one", async () => {
    mock = new LLMock({ port: 0 });
    mock.onFalImage(/flux/, { images: [{}] });
    await mock.start();

    const submit = await fetch(`${mock.url}/fal/fal-ai/flux/dev`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-fal-target-host": "queue.fal.run" },
      body: JSON.stringify({ input: { prompt: "fallback" } }),
    });
    const envelope = await submit.json();
    const result = await fetch(`${mock.url}/fal/fal-ai/flux/dev/requests/${envelope.request_id}`, {
      headers: { "x-fal-target-host": "queue.fal.run" },
    });
    const data = await result.json();
    expect(data.images[0].url).toBe("https://mock.fal.media/files/generated_image_0.png");
  });

  test("onFalVideo wraps a VideoResponse into fal's video envelope", async () => {
    mock = new LLMock({ port: 0 });
    mock.onFalVideo(/kling/, {
      video: { id: "v1", status: "completed", url: "https://mock.fal.media/files/clip.mp4" },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/fal/fal-ai/kling-video/v2/master`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-fal-target-host": "queue.fal.run" },
      body: JSON.stringify({ input: { prompt: "a dragon" } }),
    });
    const envelope = await submit.json();

    const result = await fetch(
      `${mock.url}/fal/fal-ai/kling-video/v2/master/requests/${envelope.request_id}`,
      { headers: { "x-fal-target-host": "queue.fal.run" } },
    );
    expect(result.status).toBe(200);
    const data = await result.json();
    expect(data.video).toEqual({
      url: "https://mock.fal.media/files/clip.mp4",
      content_type: "video/mp4",
      file_name: "clip.mp4",
      file_size: 0,
    });
    expect(data.seed).toBe(0);
  });

  test("sync run returns the image envelope directly", async () => {
    mock = new LLMock({ port: 0 });
    mock.onFalImage(/flux/, { images: [{ url: "https://mock.fal.media/y.jpg" }] });
    await mock.start();

    const res = await fetch(`${mock.url}/fal/fal-ai/flux/dev`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-fal-target-host": "fal.run" },
      body: JSON.stringify({ prompt: "flux sync" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.images[0].content_type).toBe("image/jpeg");
    expect(data.request_id).toBeUndefined();
  });

  test("polling progression: IN_QUEUE -> IN_PROGRESS -> COMPLETED with logs + metrics", async () => {
    mock = new LLMock({
      port: 0,
      falQueue: { pollsBeforeInProgress: 1, pollsBeforeCompleted: 2 },
    });
    mock.onFalImage(/flux/, { images: [{ url: "https://mock.fal.media/x.png" }] });
    await mock.start();

    const submit = await fetch(`${mock.url}/fal/fal-ai/flux/dev`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-fal-target-host": "queue.fal.run" },
      body: JSON.stringify({ input: { prompt: "slow" } }),
    });
    const envelope = await submit.json();
    expect(envelope.queue_position).toBe(1);

    const jobPath = `${mock.url}/fal/fal-ai/flux/dev/requests/${envelope.request_id}`;
    const headers = { "x-fal-target-host": "queue.fal.run" };

    const poll1 = await fetch(`${jobPath}/status`, { headers });
    const poll1Data = await poll1.json();
    expect(poll1Data.status).toBe("IN_PROGRESS");
    expect(poll1Data.queue_position).toBe(0);
    expect(Array.isArray(poll1Data.logs)).toBe(true);
    expect(poll1Data.logs.length).toBeGreaterThanOrEqual(2);
    expect(poll1Data.metrics).toBeUndefined();

    const poll2 = await fetch(`${jobPath}/status`, { headers });
    const poll2Data = await poll2.json();
    expect(poll2Data.status).toBe("COMPLETED");
    expect(poll2Data.metrics).toBeDefined();
    expect(typeof poll2Data.metrics.inference_time).toBe("number");

    const result = await fetch(jobPath, { headers });
    expect(result.status).toBe(200);
    const resultData = await result.json();
    expect(resultData.images).toBeDefined();
  });

  test("result before completion returns 202 with current status", async () => {
    mock = new LLMock({
      port: 0,
      falQueue: { pollsBeforeInProgress: 5, pollsBeforeCompleted: 10 },
    });
    mock.onFalImage(/flux/, { images: [{ url: "https://mock.fal.media/x.png" }] });
    await mock.start();

    const submit = await fetch(`${mock.url}/fal/fal-ai/flux/dev`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-fal-target-host": "queue.fal.run" },
      body: JSON.stringify({ input: { prompt: "never" } }),
    });
    const { request_id } = await submit.json();

    const result = await fetch(`${mock.url}/fal/fal-ai/flux/dev/requests/${request_id}`, {
      headers: { "x-fal-target-host": "queue.fal.run" },
    });
    expect(result.status).toBe(202);
    const data = await result.json();
    expect(data.status).toBe("IN_QUEUE");
    expect(data.images).toBeUndefined();
  });

  test("cancel before completion returns 200 CANCELLED", async () => {
    mock = new LLMock({
      port: 0,
      falQueue: { pollsBeforeInProgress: 5, pollsBeforeCompleted: 10 },
    });
    mock.onFalImage(/flux/, { images: [{ url: "https://mock.fal.media/x.png" }] });
    await mock.start();

    const submit = await fetch(`${mock.url}/fal/fal-ai/flux/dev`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-fal-target-host": "queue.fal.run" },
      body: JSON.stringify({ input: { prompt: "cancel me" } }),
    });
    const { request_id } = await submit.json();

    const cancel = await fetch(`${mock.url}/fal/fal-ai/flux/dev/requests/${request_id}/cancel`, {
      method: "PUT",
      headers: { "x-fal-target-host": "queue.fal.run" },
    });
    expect(cancel.status).toBe(200);
    expect((await cancel.json()).status).toBe("CANCELLED");

    const status = await fetch(`${mock.url}/fal/fal-ai/flux/dev/requests/${request_id}/status`, {
      headers: { "x-fal-target-host": "queue.fal.run" },
    });
    const statusData = await status.json();
    expect(statusData.status).toBe("CANCELLED");
  });

  test("cancel after completion keeps ALREADY_COMPLETED semantics", async () => {
    mock = new LLMock({ port: 0 });
    mock.onFalImage(/flux/, { images: [{ url: "https://mock.fal.media/x.png" }] });
    await mock.start();

    const submit = await fetch(`${mock.url}/fal/fal-ai/flux/dev`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-fal-target-host": "queue.fal.run" },
      body: JSON.stringify({ input: { prompt: "done" } }),
    });
    const { request_id } = await submit.json();

    const cancel = await fetch(`${mock.url}/fal/fal-ai/flux/dev/requests/${request_id}/cancel`, {
      method: "PUT",
      headers: { "x-fal-target-host": "queue.fal.run" },
    });
    expect(cancel.status).toBe(400);
    expect((await cancel.json()).status).toBe("ALREADY_COMPLETED");
  });

  test("IN_PROGRESS state is not skipped when only pollsBeforeInProgress is set", async () => {
    mock = new LLMock({
      port: 0,
      falQueue: { pollsBeforeInProgress: 2 },
    });
    mock.onFalImage(/flux/, { images: [{ url: "https://mock.fal.media/x.png" }] });
    await mock.start();

    const submit = await fetch(`${mock.url}/fal/fal-ai/flux/dev`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-fal-target-host": "queue.fal.run" },
      body: JSON.stringify({ input: { prompt: "p" } }),
    });
    const envelope = await submit.json();
    const jobPath = `${mock.url}/fal/fal-ai/flux/dev/requests/${envelope.request_id}`;
    const headers = { "x-fal-target-host": "queue.fal.run" };

    const poll1 = await (await fetch(`${jobPath}/status`, { headers })).json();
    expect(poll1.status).toBe("IN_QUEUE");
    const poll2 = await (await fetch(`${jobPath}/status`, { headers })).json();
    expect(poll2.status).toBe("IN_PROGRESS");
    const poll3 = await (await fetch(`${jobPath}/status`, { headers })).json();
    expect(poll3.status).toBe("COMPLETED");
  });

  test("equal pollsBeforeInProgress and pollsBeforeCompleted still routes through IN_PROGRESS", async () => {
    // Pins the advanceJob if/else reorder: with equal thresholds, the IN_QUEUE
    // branch must fire first so a single poll emits IN_PROGRESS rather than
    // jumping straight to COMPLETED.
    mock = new LLMock({
      port: 0,
      falQueue: { pollsBeforeInProgress: 1, pollsBeforeCompleted: 1 },
    });
    mock.onFalImage(/flux/, { images: [{ url: "https://mock.fal.media/x.png" }] });
    await mock.start();

    const submit = await fetch(`${mock.url}/fal/fal-ai/flux/dev`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-fal-target-host": "queue.fal.run" },
      body: JSON.stringify({ input: { prompt: "p" } }),
    });
    const envelope = await submit.json();
    const jobPath = `${mock.url}/fal/fal-ai/flux/dev/requests/${envelope.request_id}`;
    const headers = { "x-fal-target-host": "queue.fal.run" };

    const poll1 = await (await fetch(`${jobPath}/status`, { headers })).json();
    expect(poll1.status).toBe("IN_PROGRESS");
    const poll2 = await (await fetch(`${jobPath}/status`, { headers })).json();
    expect(poll2.status).toBe("COMPLETED");
  });

  test("misconfigured pollsBeforeCompleted < pollsBeforeInProgress clamps up", async () => {
    // Caller misorders thresholds — resolveProgression must clamp so the job
    // still passes through IN_PROGRESS instead of skipping straight to COMPLETED.
    mock = new LLMock({
      port: 0,
      falQueue: { pollsBeforeInProgress: 3, pollsBeforeCompleted: 1 },
    });
    mock.onFalImage(/flux/, { images: [{ url: "https://mock.fal.media/x.png" }] });
    await mock.start();

    const submit = await fetch(`${mock.url}/fal/fal-ai/flux/dev`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-fal-target-host": "queue.fal.run" },
      body: JSON.stringify({ input: { prompt: "p" } }),
    });
    const envelope = await submit.json();
    const jobPath = `${mock.url}/fal/fal-ai/flux/dev/requests/${envelope.request_id}`;
    const headers = { "x-fal-target-host": "queue.fal.run" };

    // pollsBeforeCompleted clamped to 3. Poll 1+2 stay IN_QUEUE, poll 3 →
    // IN_PROGRESS, poll 4 → COMPLETED.
    const poll1 = await (await fetch(`${jobPath}/status`, { headers })).json();
    expect(poll1.status).toBe("IN_QUEUE");
    const poll2 = await (await fetch(`${jobPath}/status`, { headers })).json();
    expect(poll2.status).toBe("IN_QUEUE");
    const poll3 = await (await fetch(`${jobPath}/status`, { headers })).json();
    expect(poll3.status).toBe("IN_PROGRESS");
    const poll4 = await (await fetch(`${jobPath}/status`, { headers })).json();
    expect(poll4.status).toBe("COMPLETED");
  });

  test("image URL without an extension produces a valid content_type", async () => {
    mock = new LLMock({ port: 0 });
    mock.onFalImage(/flux/, { images: [{ url: "https://example.com/image" }] });
    await mock.start();

    const submit = await fetch(`${mock.url}/fal/fal-ai/flux/dev`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-fal-target-host": "queue.fal.run" },
      body: JSON.stringify({ input: { prompt: "p" } }),
    });
    const envelope = await submit.json();
    const result = await fetch(`${mock.url}/fal/fal-ai/flux/dev/requests/${envelope.request_id}`, {
      headers: { "x-fal-target-host": "queue.fal.run" },
    });
    const data = await result.json();
    expect(data.images[0].content_type).toBe("image/png");
  });

  test("image URL with fragment strips it when deriving extension", async () => {
    mock = new LLMock({ port: 0 });
    // Fragment-only — old code returned "image/png#section" because the
    // split("?") guard didn't strip the trailing fragment.
    mock.onFalImage(/flux/, {
      images: [{ url: "https://example.com/path/to/pic.png#section" }],
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/fal/fal-ai/flux/dev`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-fal-target-host": "queue.fal.run" },
      body: JSON.stringify({ input: { prompt: "p" } }),
    });
    const envelope = await submit.json();
    const result = await fetch(`${mock.url}/fal/fal-ai/flux/dev/requests/${envelope.request_id}`, {
      headers: { "x-fal-target-host": "queue.fal.run" },
    });
    const data = await result.json();
    expect(data.images[0].content_type).toBe("image/png");
  });

  test("video URL without an extension falls back to mp4 content_type", async () => {
    mock = new LLMock({ port: 0 });
    mock.onFalVideo(/kling/, {
      video: { id: "v", status: "completed", url: "https://example.com/clip" },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/fal/fal-ai/kling-video/v2/master`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-fal-target-host": "queue.fal.run" },
      body: JSON.stringify({ input: { prompt: "p" } }),
    });
    const envelope = await submit.json();
    const result = await fetch(
      `${mock.url}/fal/fal-ai/kling-video/v2/master/requests/${envelope.request_id}`,
      { headers: { "x-fal-target-host": "queue.fal.run" } },
    );
    const data = await result.json();
    expect(data.video.content_type).toBe("video/mp4");
    expect(data.video.file_name).toBe("clip");
  });

  test("video URL with fragment strips it when deriving extension", async () => {
    mock = new LLMock({ port: 0 });
    mock.onFalVideo(/kling/, {
      video: { id: "v", status: "completed", url: "https://example.com/clip.webm#t=10" },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/fal/fal-ai/kling-video/v2/master`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-fal-target-host": "queue.fal.run" },
      body: JSON.stringify({ input: { prompt: "p" } }),
    });
    const envelope = await submit.json();
    const result = await fetch(
      `${mock.url}/fal/fal-ai/kling-video/v2/master/requests/${envelope.request_id}`,
      { headers: { "x-fal-target-host": "queue.fal.run" } },
    );
    const data = await result.json();
    expect(data.video.content_type).toBe("video/webm");
    expect(data.video.file_name).toBe("clip.webm");
  });

  test("double cancel does not push duplicate log entries", async () => {
    mock = new LLMock({
      port: 0,
      falQueue: { pollsBeforeInProgress: 5, pollsBeforeCompleted: 10 },
    });
    mock.onFalImage(/flux/, { images: [{ url: "https://mock.fal.media/x.png" }] });
    await mock.start();

    const submit = await fetch(`${mock.url}/fal/fal-ai/flux/dev`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-fal-target-host": "queue.fal.run" },
      body: JSON.stringify({ input: { prompt: "p" } }),
    });
    const { request_id } = await submit.json();
    const cancelUrl = `${mock.url}/fal/fal-ai/flux/dev/requests/${request_id}/cancel`;
    const cancelHeaders = { "x-fal-target-host": "queue.fal.run" };

    const first = await fetch(cancelUrl, { method: "PUT", headers: cancelHeaders });
    expect(first.status).toBe(200);
    const second = await fetch(cancelUrl, { method: "PUT", headers: cancelHeaders });
    expect(second.status).toBe(200);
    expect((await second.json()).status).toBe("CANCELLED");

    const status = await fetch(`${mock.url}/fal/fal-ai/flux/dev/requests/${request_id}/status`, {
      headers: cancelHeaders,
    });
    const statusBody = await status.json();
    expect(statusBody.status).toBe("CANCELLED");
    const cancelLogs = statusBody.logs.filter(
      (l: { message: string }) => l.message === "Job cancelled.",
    );
    expect(cancelLogs).toHaveLength(1);
  });

  test("malformed JSON body returns 400 invalid_json", async () => {
    mock = new LLMock({ port: 0 });
    mock.onFalImage(/flux/, { images: [{ url: "https://mock.fal.media/x.png" }] });
    await mock.start();

    const submit = await fetch(`${mock.url}/fal/fal-ai/flux/dev`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-fal-target-host": "queue.fal.run" },
      body: "{not valid json",
    });
    expect(submit.status).toBe(400);
    const err = await submit.json();
    expect(err.error.code).toBe("invalid_json");
    expect(err.error.type).toBe("invalid_request_error");

    const sync = await fetch(`${mock.url}/fal/fal-ai/flux/dev`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-fal-target-host": "fal.run" },
      body: "{still bad",
    });
    expect(sync.status).toBe(400);
    expect((await sync.json()).error.code).toBe("invalid_json");
  });
});
