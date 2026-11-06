import { describe, test, expect, afterEach } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LLMock } from "../llmock.js";

// Bytes above 0x7f would be mangled by a utf8 round-trip; the test proves they are not.
const TAKE = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0xff, 0xfe, 0x80, 0xc3, 0x28, 0x0d, 0x0a]);

interface Captured {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function createUpstream(
  respond: (c: Captured, res: http.ServerResponse) => void,
): Promise<{ server: http.Server; url: string; seen: Captured[] }> {
  const seen: Captured[] = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const c = { url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) };
        seen.push(c);
        respond(c, res);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${port}`, seen });
    });
  });
}

function seedBody(requestRefs = true): string {
  return JSON.stringify({
    model: "seed-audio-1",
    text_prompt: "@Audio1 Hello there, traveller.",
    ...(requestRefs ? { references: [{ audio_data: TAKE.toString("base64") }] } : {}),
    audio_config: { format: "wav", sample_rate: 44100 },
  });
}

function scribeForm(bytes: Buffer): FormData {
  const form = new FormData();
  form.append("model_id", "scribe_v2");
  form.append("file", new Blob([new Uint8Array(bytes)], { type: "audio/wav" }), "take.wav");
  form.append("language_code", "en");
  form.append("timestamps_granularity", "word");
  form.append("tag_audio_events", "false");
  return form;
}

function isolationForm(bytes: Buffer): FormData {
  const form = new FormData();
  form.append("audio", new Blob([new Uint8Array(bytes)], { type: "audio/wav" }), "slice.wav");
  return form;
}

describe("voice pipeline record + replay (#600)", () => {
  let mock: LLMock | undefined;
  let tmp: string | undefined;
  let upstream: http.Server | undefined;

  afterEach(async () => {
    await mock?.stop().catch(() => {});
    mock = undefined;
    if (upstream) await new Promise((r) => upstream!.close(() => r(undefined)));
    upstream = undefined;
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  async function recorder(providers: Record<string, string>): Promise<LLMock> {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-audio-pipeline-"));
    mock = new LLMock({ port: 0, record: { providers, fixturePath: tmp } });
    await mock.start();
    return mock;
  }

  test("Seed Speech TTS records verbatim JSON and replays it, ignoring X-Api-Request-Id", async () => {
    const payload = {
      code: 0,
      message: "",
      audio: TAKE.toString("base64"),
      original_duration: 4.2,
    };
    const up = await createUpstream((_c, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    });
    upstream = up.server;
    const m = await recorder({ "byteplus-speech": up.url });

    const send = (requestId: string) =>
      fetch(`${m.url}/api/v3/tts/create`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": "k",
          "X-Api-Request-Id": requestId,
        },
        body: seedBody(),
      });

    const first = await send("req-1");
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual(payload);
    expect(up.seen[0].url).toBe("/api/v3/tts/create");
    expect(up.seen[0].headers["x-api-key"]).toBe("k");

    const [fixture] = m.getFixtures();
    expect(fixture.match.endpoint).toBe("byteplus-tts");
    expect(fixture.match.model).toBe("seed-audio-1");
    expect(fixture.match.userMessage).toMatch(
      /^@Audio1 Hello there, traveller\.\n\[reference sha256:[0-9a-f]{16}\]$/,
    );
    expect(fixture.response).toEqual({ json: payload, status: 200 });

    m.disableRecording();
    const replayed = await send("req-2");
    expect(replayed.status).toBe(200);
    expect(await replayed.json()).toEqual(payload);
    expect(up.seen).toHaveLength(1);
  });

  test("a recorded Seed 429 replays as a 429 with its body", async () => {
    const up = await createUpstream((_c, res) => {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 45000292, message: "quota exceeded" }));
    });
    upstream = up.server;
    const m = await recorder({ "byteplus-speech": up.url });
    const req = () =>
      fetch(`${m.url}/api/v3/tts/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: seedBody(false),
      });
    await req();
    m.disableRecording();
    const replayed = await req();
    expect(replayed.status).toBe(429);
    expect(await replayed.json()).toEqual({ code: 45000292, message: "quota exceeded" });
  });

  test("Scribe forwards the multipart bytes intact and replays by file hash", async () => {
    const transcript = {
      text: "Hello there, traveller.",
      audio_duration_secs: 4.2,
      words: [{ type: "word", text: "Hello", start: 0.1, end: 0.4 }],
    };
    const up = await createUpstream((_c, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(transcript));
    });
    upstream = up.server;
    const m = await recorder({ elevenlabs: up.url });

    const first = await fetch(`${m.url}/v1/speech-to-text`, {
      method: "POST",
      body: scribeForm(TAKE),
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual(transcript);
    // The upload reached upstream byte-for-byte.
    expect(up.seen[0].body.includes(TAKE)).toBe(true);

    const [fixture] = m.getFixtures();
    expect(fixture.match.endpoint).toBe("elevenlabs-stt");
    expect(fixture.match.model).toBe("scribe_v2");
    expect(fixture.match.userMessage).toMatch(/^sha256:[0-9a-f]{64}$/);

    m.disableRecording();
    const replayed = await fetch(`${m.url}/v1/speech-to-text`, {
      method: "POST",
      body: scribeForm(TAKE),
    });
    expect(await replayed.json()).toEqual(transcript);

    // Different audio misses.
    const other = await fetch(`${m.url}/v1/speech-to-text`, {
      method: "POST",
      body: scribeForm(Buffer.from("other")),
    });
    expect(other.status).toBe(404);
  });

  test("Audio Isolation records binary audio and replays the same bytes", async () => {
    const cleaned = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x01, 0x80]);
    const up = await createUpstream((_c, res) => {
      res.writeHead(200, { "Content-Type": "audio/mpeg" });
      res.end(cleaned);
    });
    upstream = up.server;
    const m = await recorder({ elevenlabs: up.url });

    const first = await fetch(`${m.url}/v1/audio-isolation`, {
      method: "POST",
      body: isolationForm(TAKE),
    });
    expect(Buffer.from(await first.arrayBuffer())).toEqual(cleaned);
    expect(m.getFixtures()[0].match.endpoint).toBe("elevenlabs-audio-isolation");

    m.disableRecording();
    const replayed = await fetch(`${m.url}/v1/audio-isolation`, {
      method: "POST",
      body: isolationForm(TAKE),
    });
    expect(replayed.status).toBe(200);
    expect(replayed.headers.get("content-type")).toBe("audio/mpeg");
    expect(Buffer.from(await replayed.arrayBuffer())).toEqual(cleaned);
  });

  test("strict mode refuses a miss with 503", async () => {
    mock = new LLMock({ port: 0, strict: true });
    await mock.start();
    const res = await fetch(`${mock.url}/v1/audio-isolation`, {
      method: "POST",
      body: isolationForm(TAKE),
    });
    expect(res.status).toBe(503);
  });

  test("a hand-written fixture keyed on text_prompt alone matches a request with references", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { endpoint: "byteplus-tts", userMessage: "Hello there" },
      response: { json: { code: 0, audio: "", original_duration: 0 } },
    });
    await mock.start();
    const res = await fetch(`${mock.url}/api/v3/tts/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: seedBody(),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).code).toBe(0);
  });

  test("missing required fields answer 400", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();
    const seed = await fetch(`${mock.url}/api/v3/tts/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m" }),
    });
    expect(seed.status).toBe(400);
    const form = new FormData();
    form.append("model_id", "scribe_v2");
    const scribe = await fetch(`${mock.url}/v1/speech-to-text`, { method: "POST", body: form });
    expect(scribe.status).toBe(400);
  });
});
