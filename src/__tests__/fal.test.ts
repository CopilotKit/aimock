import { describe, test, expect, afterEach } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LLMock } from "../llmock.js";

// Spin up a tiny stub upstream that responds with whatever JSON the test
// hands it; lets us exercise the record-and-replay path without depending on
// fal.ai itself.
function startStubUpstream(
  handler: (req: http.IncomingMessage, body: string) => { status?: number; body: unknown },
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        const result = handler(req, body);
        res.writeHead(result.status ?? 200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result.body));
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
}

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

describe("fal.ai general handler — record and replay", () => {
  let mock: LLMock;
  let upstream: { url: string; close: () => Promise<void> } | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    await mock?.stop();
    await upstream?.close();
    upstream = undefined;
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  test("proxies unmatched fal request to upstream and saves fixture", async () => {
    upstream = await startStubUpstream(() => ({
      body: { images: [{ url: "https://example.com/recorded.png" }] },
    }));
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-fal-record-"));

    mock = new LLMock({
      port: 0,
      record: { providers: { fal: upstream.url }, fixturePath: tmpDir },
    });
    await mock.start();

    // In record mode the proxy is transparent — what upstream says is what
    // the client gets. Queue envelope synthesis only happens in fixture mode.
    const res = await fetch(`${mock.url}/fal/fal-ai/flux/dev`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-fal-target-host": "queue.fal.run" },
      body: JSON.stringify({ input: { prompt: "a cat" } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ images: [{ url: "https://example.com/recorded.png" }] });

    const files = fs.readdirSync(tmpDir);
    const falFixtures = files.filter((f) => f.startsWith("fal-") && f.endsWith(".json"));
    expect(falFixtures.length).toBeGreaterThanOrEqual(1);

    const recorded = JSON.parse(fs.readFileSync(path.join(tmpDir, falFixtures[0]), "utf-8"));
    expect(recorded.fixtures[0].match.endpoint).toBe("fal");
    expect(recorded.fixtures[0].response.json).toEqual({
      images: [{ url: "https://example.com/recorded.png" }],
    });
  });

  test("replays from in-memory fixture on second identical request (no second proxy)", async () => {
    let upstreamCalls = 0;
    upstream = await startStubUpstream(() => {
      upstreamCalls++;
      return { body: { images: [{ url: "https://example.com/replay.png" }] } };
    });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-fal-replay-"));

    mock = new LLMock({
      port: 0,
      record: { providers: { fal: upstream.url }, fixturePath: tmpDir },
    });
    await mock.start();

    // First call — hits upstream
    await fetch(`${mock.url}/fal/fal-ai/flux/dev`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-fal-target-host": "queue.fal.run" },
      body: JSON.stringify({ input: { prompt: "a cat" } }),
    });
    expect(upstreamCalls).toBe(1);

    // Second call — should match recorded fixture, no upstream hit
    const res2 = await fetch(`${mock.url}/fal/fal-ai/flux/dev`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-fal-target-host": "queue.fal.run" },
      body: JSON.stringify({ input: { prompt: "a cat" } }),
    });
    expect(res2.status).toBe(200);
    expect(upstreamCalls).toBe(1);
  });
});
