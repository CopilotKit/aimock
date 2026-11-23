import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { LLMock } from "../../llmock.js";
import { describeDeliveryLifecycle } from "../helpers/delivery-lifecycle-harness.js";

// Transcription streams only (non-streaming timing is out of scope, plan T14),
// so the harness runs the abort, healthy and truncate rows on the multipart
// request. Each delta carries `chunkSize` (8) characters of the text.
const streamBody = { model: "gpt-4o-transcribe", stream: "true" };

describeDeliveryLifecycle({
  name: "Audio transcription",
  streamPath: "/v1/audio/transcriptions",
  nonStreamPath: "/v1/audio/transcriptions",
  streamBody,
  nonStreamBody: { model: "gpt-4o-transcribe" },
  bodyKind: "multipart",
  transport: "http",
  surface: "other",
  nonStream: false,
  match: { endpoint: "transcription" },
  streamResponse: {
    transcription: {
      text: "The quick brown fox jumps over the lazy dog, again and again, for a long time.",
    },
  },
});

// The harness's stream abort lands between frames. This one lands in the
// first-frame wait: nothing is written after it, and since no byte of the
// response reached the socket, the journal status is 0.
describe("delivery lifecycle: Audio transcription, abort during the first-frame wait", () => {
  let mock: LLMock;

  beforeAll(async () => {
    mock = new LLMock({ port: 0, host: "127.0.0.1" });
    await mock.start();
  });
  afterAll(async () => {
    await mock.stop();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stops the wait, writes nothing and journals the client abort", async () => {
    mock.addFixture({
      match: { endpoint: "transcription" },
      response: { transcription: { text: "a transcript that never gets sent" } },
      streamingProfile: { ttft: 2000 },
    });
    const boundary = "----aimock-transcription-wait";
    const payload =
      `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\ngpt-4o-transcribe\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="stream"\r\n\r\ntrue\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\n` +
      `Content-Type: audio/wav\r\n\r\nRIFF\r\n--${boundary}--\r\n`;
    let gotBytes = 0;
    const req = http.request(new URL("/v1/audio/transcriptions", mock.url), {
      method: "POST",
      agent: false,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    });
    req.on("error", () => undefined);
    req.on("response", (res) => {
      res.on("data", (c: Buffer) => {
        gotBytes += c.length;
      });
      res.on("error", () => undefined);
    });
    req.end(payload);
    await new Promise((resolve) => setTimeout(resolve, 150));
    let writes = 0;
    for (const method of ["writeHead", "write", "end"] as const) {
      const original = http.ServerResponse.prototype[method];
      vi.spyOn(http.ServerResponse.prototype, method).mockImplementation(function (
        this: http.ServerResponse,
        ...args: unknown[]
      ) {
        writes++;
        return Reflect.apply(original, this, args);
      });
    }
    req.destroy();

    await expect
      .poll(() => mock.getRequests().at(-1)?.response.interrupted, { timeout: 1000 })
      .toBe(true);
    const entry = mock.getRequests().at(-1)!;
    expect(entry.response.interruptReason).toBe("client aborted");
    expect(entry.response.status).toBe(0);
    // Past the full 2000ms wait: nothing was ever written.
    await new Promise((resolve) => setTimeout(resolve, 2100));
    expect(writes).toBe(0);
    expect(gotBytes).toBe(0);
  }, 10000);
});

// Record mode relays a fixture miss to the real provider. A client that hangs
// up mid-relay is journaled as a client abort, as on every other handler.
describe("delivery lifecycle: Audio transcription, client hang-up during a record-mode relay", () => {
  let upstream: http.Server;
  let mock: LLMock;
  let fixturePath: string;

  beforeAll(async () => {
    // An upstream that sends one transcription delta every 200ms.
    upstream = http.createServer((req, res) => {
      req.resume();
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      let i = 0;
      const next = (): void => {
        if (res.destroyed) return;
        if (i >= 10) {
          res.end(`data: ${JSON.stringify({ type: "transcript.text.done", text: "done" })}\n\n`);
          return;
        }
        res.write(
          `data: ${JSON.stringify({ type: "transcript.text.delta", delta: `w${i++} ` })}\n\n`,
        );
        setTimeout(next, 200);
      };
      next();
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const { port } = upstream.address() as AddressInfo;
    fixturePath = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-transcription-hangup-"));
    mock = new LLMock({
      port: 0,
      host: "127.0.0.1",
      record: { providers: { openai: `http://127.0.0.1:${port}` }, fixturePath },
    });
    await mock.start();
  });
  afterAll(async () => {
    await mock.stop();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    fs.rmSync(fixturePath, { recursive: true, force: true });
  });

  it("journals the client abort", async () => {
    const boundary = "----aimock-transcription-record";
    const payload =
      `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\ngpt-4o-transcribe\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="stream"\r\n\r\ntrue\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\n` +
      `Content-Type: audio/wav\r\n\r\nRIFF\r\n--${boundary}--\r\n`;
    const req = http.request(new URL("/v1/audio/transcriptions", mock.url), {
      method: "POST",
      agent: false,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    });
    req.on("error", () => undefined);
    const firstBytes = new Promise<void>((resolve) => {
      req.on("response", (res) => {
        res.on("error", () => undefined);
        res.once("data", () => resolve());
      });
    });
    req.end(payload);
    await firstBytes;
    req.destroy();

    await expect.poll(() => mock.getRequests().length, { timeout: 5000 }).toBeGreaterThan(0);
    const entry = mock.getRequests().at(-1)!;
    expect(entry.response.source).toBe("proxy");
    expect(entry.response.interrupted).toBe(true);
    expect(entry.response.interruptReason).toBe("client aborted");
  }, 10000);
});
