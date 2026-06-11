import { describe, test, expect, afterEach } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LLMock } from "../llmock.js";

describe("fal.ai audio queue", () => {
  let mock: LLMock;

  afterEach(async () => {
    await mock?.stop();
  });

  test("queue submit returns queue envelope", async () => {
    mock = new LLMock({ port: 0 });
    mock.onFalAudio("drum loop", { audio: "SGVsbG8=", format: "mp3" });
    await mock.start();

    const res = await fetch(`${mock.url}/fal/queue/submit/fal-ai/stable-audio`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "drum loop" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.request_id).toBeDefined();
    expect(typeof data.request_id).toBe("string");
    expect(data.response_url).toContain(data.request_id);
    expect(data.status_url).toContain(data.request_id);
    expect(data.cancel_url).toContain(data.request_id);
    expect(data.queue_position).toBe(0);
  });

  test("queue status returns COMPLETED", async () => {
    mock = new LLMock({ port: 0 });
    mock.onFalAudio("drum loop", { audio: "SGVsbG8=", format: "mp3" });
    await mock.start();

    // Submit first
    const submit = await fetch(`${mock.url}/fal/queue/submit/fal-ai/stable-audio`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "drum loop" }),
    });
    const envelope = await submit.json();

    // Check status
    const status = await fetch(`${mock.url}/fal/queue/requests/${envelope.request_id}/status`);
    expect(status.status).toBe(200);
    const statusData = await status.json();
    expect(statusData.status).toBe("COMPLETED");
    expect(statusData.request_id).toBe(envelope.request_id);
    expect(statusData.response_url).toBeDefined();
  });

  test("queue result returns audio file object", async () => {
    mock = new LLMock({ port: 0 });
    mock.onFalAudio("drum loop", { audio: "SGVsbG8=", format: "mp3" });
    await mock.start();

    // Submit
    const submit = await fetch(`${mock.url}/fal/queue/submit/fal-ai/stable-audio`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "drum loop" }),
    });
    const envelope = await submit.json();

    // Get result
    const result = await fetch(`${mock.url}/fal/queue/requests/${envelope.request_id}`);
    expect(result.status).toBe(200);
    const data = await result.json();
    expect(data.audio).toBeDefined();
    expect(data.audio.url).toContain("generated_audio.mp3");
    expect(data.audio.content_type).toBe("audio/mpeg");
    expect(data.audio.file_name).toBe("generated_audio.mp3");
    expect(typeof data.audio.file_size).toBe("number");
    expect(data.audio.file_size).toBeGreaterThan(0);
  });

  test("full queue lifecycle: submit -> status -> result", async () => {
    mock = new LLMock({ port: 0 });
    mock.onFalAudio("synth pad", { audio: "AAAA", format: "wav" });
    await mock.start();

    // Submit
    const submit = await fetch(`${mock.url}/fal/queue/submit/fal-ai/stable-audio`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "synth pad" }),
    });
    expect(submit.status).toBe(200);
    const envelope = await submit.json();
    const requestId = envelope.request_id;

    // Status
    const status = await fetch(`${mock.url}/fal/queue/requests/${requestId}/status`);
    expect(status.status).toBe(200);
    const statusData = await status.json();
    expect(statusData.status).toBe("COMPLETED");

    // Result
    const result = await fetch(`${mock.url}/fal/queue/requests/${requestId}`);
    expect(result.status).toBe(200);
    const resultData = await result.json();
    expect(resultData.audio.url).toContain("generated_audio.wav");
    expect(resultData.audio.content_type).toBe("audio/wav");
  });

  test("synchronous run returns result directly", async () => {
    mock = new LLMock({ port: 0 });
    mock.onFalAudio("drum loop", { audio: "SGVsbG8=", format: "mp3" });
    await mock.start();

    const res = await fetch(`${mock.url}/fal/run/fal-ai/stable-audio`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "drum loop" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    // Synchronous run returns result directly, no queue envelope
    expect(data.audio).toBeDefined();
    expect(data.audio.url).toContain("generated_audio.mp3");
    expect(data.audio.content_type).toBe("audio/mpeg");
    expect(data.request_id).toBeUndefined(); // no queue envelope
  });

  test("cancel returns ALREADY_COMPLETED", async () => {
    mock = new LLMock({ port: 0 });
    mock.onFalAudio("drum loop", { audio: "SGVsbG8=" });
    await mock.start();

    // Submit
    const submit = await fetch(`${mock.url}/fal/queue/submit/fal-ai/stable-audio`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "drum loop" }),
    });
    const envelope = await submit.json();

    // Cancel
    const cancel = await fetch(`${mock.url}/fal/queue/requests/${envelope.request_id}/cancel`, {
      method: "PUT",
    });
    expect(cancel.status).toBe(400);
    const cancelData = await cancel.json();
    expect(cancelData.status).toBe("ALREADY_COMPLETED");
  });

  test("unknown request_id returns 404", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    const res = await fetch(`${mock.url}/fal/queue/requests/nonexistent/status`);
    expect(res.status).toBe(404);
  });

  test("object-form audio response with contentType", async () => {
    mock = new LLMock({ port: 0 });
    mock.onFalAudio("speech", {
      audio: { b64Json: "SGVsbG8=", contentType: "audio/wav" },
    });
    await mock.start();

    // Submit
    const submit = await fetch(`${mock.url}/fal/queue/submit/fal-ai/stable-audio`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "speech" }),
    });
    const envelope = await submit.json();

    // Get result
    const result = await fetch(`${mock.url}/fal/queue/requests/${envelope.request_id}`);
    const data = await result.json();
    expect(data.audio.content_type).toBe("audio/wav");
  });

  test("onFalAudio convenience method registers fixture correctly", async () => {
    mock = new LLMock({ port: 0 });
    mock.onFalAudio("loop", { audio: "SGVsbG8=" });
    await mock.start();

    const submit = await fetch(`${mock.url}/fal/queue/submit/fal-ai/stable-audio`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "loop" }),
    });
    expect(submit.status).toBe(200);
    const envelope = await submit.json();
    expect(envelope.request_id).toBeDefined();

    // Verify result is retrievable
    const result = await fetch(`${mock.url}/fal/queue/requests/${envelope.request_id}`);
    expect(result.status).toBe(200);
    const data = await result.json();
    expect(data.audio).toBeDefined();
  });

  test("no matching fixture returns 404", async () => {
    mock = new LLMock({ port: 0 });
    mock.onFalAudio("specific prompt", { audio: "SGVsbG8=" });
    await mock.start();

    const res = await fetch(`${mock.url}/fal/queue/submit/fal-ai/stable-audio`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "completely different" }),
    });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error.message).toContain("No fixture matched");
  });

  test("error fixture returns error status", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "quota", endpoint: "fal-audio" },
      response: { error: { message: "quota exceeded", type: "rate_limit" }, status: 429 },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/fal/queue/submit/fal-ai/stable-audio`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "quota" }),
    });
    expect(res.status).toBe(429);
    const data = await res.json();
    expect(data.error.message).toBe("quota exceeded");
  });

  test("X-Test-Id isolation for fal queue jobs", async () => {
    mock = new LLMock({ port: 0 });
    mock.onFalAudio("drum", { audio: "SGVsbG8=" });
    await mock.start();

    // Submit with test-id A
    const submitA = await fetch(`${mock.url}/fal/queue/submit/fal-ai/stable-audio`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-Id": "testA" },
      body: JSON.stringify({ prompt: "drum" }),
    });
    const envelopeA = await submitA.json();

    // Submit with test-id B
    const submitB = await fetch(`${mock.url}/fal/queue/submit/fal-ai/stable-audio`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-Id": "testB" },
      body: JSON.stringify({ prompt: "drum" }),
    });
    const envelopeB = await submitB.json();

    // A's request_id should not be visible to B
    const crossLookup = await fetch(
      `${mock.url}/fal/queue/requests/${envelopeA.request_id}/status`,
      { headers: { "X-Test-Id": "testB" } },
    );
    expect(crossLookup.status).toBe(404);

    // A's request_id should be visible to A
    const sameLookup = await fetch(
      `${mock.url}/fal/queue/requests/${envelopeA.request_id}/status`,
      { headers: { "X-Test-Id": "testA" } },
    );
    expect(sameLookup.status).toBe(200);

    // B's request_id should be visible to B
    const bLookup = await fetch(`${mock.url}/fal/queue/requests/${envelopeB.request_id}/status`, {
      headers: { "X-Test-Id": "testB" },
    });
    expect(bLookup.status).toBe(200);
  });
});

describe("fal.ai audio queue — record walk (round 5)", () => {
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

  test("a persist failure on the legacy audio queue-walk sets X-AIMock-Record-Error", async () => {
    // Parity with fal.ts's queue-walk record path (and the generic recorder):
    // the synthesized envelope's headers have not been sent when
    // persistFixture fails, so the failure can ride the response.
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
              request_id: "aud-1",
              status_url: `${selfUrl}/fal/queue/requests/aud-1/status`,
              response_url: `${selfUrl}/fal/queue/requests/aud-1`,
            });
            return;
          }
          if (url.pathname.endsWith("/status")) {
            send(200, { status: "COMPLETED", request_id: "aud-1" });
            return;
          }
          send(200, { audio: { url: "https://example.com/unsaveable.mp3" } });
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
          close: () => new Promise<void>((r) => server.close(() => r())),
        });
      });
    });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-fal-audio-persistfail-"));
    const blockerFile = path.join(tmpDir, "not-a-dir");
    fs.writeFileSync(blockerFile, "in the way");
    mock = new LLMock({
      port: 0,
      logLevel: "silent",
      record: {
        providers: { fal: upstream.url },
        fixturePath: blockerFile,
        fal: { pollIntervalMs: 5, timeoutMs: 5000 },
      },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/fal/queue/submit/fal-ai/stable-audio`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "unsaveable loop" }),
    });
    expect(submit.status).toBe(200);
    expect(submit.headers.get("x-aimock-record-error")).toBeTruthy();
    await submit.arrayBuffer();
  });
});
