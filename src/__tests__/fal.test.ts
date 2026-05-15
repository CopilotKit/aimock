import { describe, test, expect, afterEach } from "vitest";
import * as http from "node:http";
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
}> {
  const upstreamRequestId = opts.upstreamRequestId ?? "upstream-req-id";
  const pollsBeforeCompleted = opts.pollsBeforeCompleted ?? 2;
  const counts = { submit: 0, status: 0, result: 0 };
  const statusPolls = new Map<string, number>();
  const statusRe = /^\/(.+)\/requests\/([^/]+)\/status$/;
  const resultRe = /^\/(.+)\/requests\/([^/]+)$/;

  return new Promise((resolve) => {
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
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      selfUrl = `http://127.0.0.1:${port}`;
      resolve({
        url: selfUrl,
        counts,
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
  let queueUpstream:
    | {
        url: string;
        close: () => Promise<void>;
        counts: { submit: number; status: number; result: number };
      }
    | undefined;
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
    upstream = await new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          const url = new URL(req.url ?? "/", "http://stub");
          if (req.method === "POST" && !url.pathname.includes("/requests/")) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                request_id: "x",
                status_url: `http://stub${url.pathname}/requests/x/status`,
                response_url: `http://stub${url.pathname}/requests/x`,
              }),
            );
            return;
          }
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "upstream broke" } }));
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as { port: number };
        resolve({
          url: `http://127.0.0.1:${port}`,
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
