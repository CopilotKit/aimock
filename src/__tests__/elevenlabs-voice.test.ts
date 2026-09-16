import { describe, test, expect, afterEach } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LLMock } from "../llmock.js";

const SEA_CAPTAIN = "A weathered sea captain in his sixties, gravelly, unhurried";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aimock-voice-design-"));
}

function createUpstream(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("ElevenLabs Voice Design", () => {
  let mock: LLMock;

  afterEach(async () => {
    await mock?.stop();
  });

  test("design matches voice_description and returns previews JSON", async () => {
    mock = new LLMock({ port: 0 });
    mock.onElevenLabsVoiceDesign(/sea captain/, {
      previews: [
        {
          generated_voice_id: "preview_captain",
          audio_base_64: "SGVsbG8=",
          media_type: "audio/mpeg",
          duration_secs: 1.2,
          language: "en",
        },
      ],
      text: "Ahoy there.",
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/text-to-voice/design`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        voice_description: SEA_CAPTAIN,
        model_id: "eleven_ttv_v3",
        auto_generate_text: true,
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const data = await res.json();
    expect(data.text).toBe("Ahoy there.");
    expect(data.previews).toHaveLength(1);
    expect(data.previews[0].generated_voice_id).toBe("preview_captain");
    expect(data.previews[0].audio_base_64).toBe("SGVsbG8=");
    expect(data.previews[0].media_type).toBe("audio/mpeg");
  });

  test("design substring match works without regex", async () => {
    mock = new LLMock({ port: 0 });
    mock.onElevenLabsVoiceDesign("sea captain", {
      previews: [{ generated_voice_id: "p1", audio_base_64: "QQ==" }],
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/text-to-voice/design`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voice_description: SEA_CAPTAIN }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.previews[0].generated_voice_id).toBe("p1");
    expect(data.previews[0].media_type).toBe("audio/mpeg");
    expect(data.text).toBe("");
  });

  test("design missing voice_description returns 400", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/text-to-voice/design`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model_id: "eleven_ttv_v3" }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.message).toContain("voice_description");
  });

  test("design malformed JSON returns 400", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/text-to-voice/design`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.message).toContain("Malformed JSON");
  });

  test("design no matching fixture returns 404", async () => {
    mock = new LLMock({ port: 0 });
    mock.onElevenLabsVoiceDesign("sea captain", {
      previews: [{ generated_voice_id: "p1", audio_base_64: "QQ==" }],
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/text-to-voice/design`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voice_description: "a cheerful cartoon mouse" }),
    });

    expect(res.status).toBe(404);
  });

  test("design error fixture returns error status", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "rate limited", endpoint: "elevenlabs-voice-design" },
      response: { error: { message: "rate limit", type: "rate_limit_error" }, status: 429 },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/text-to-voice/design`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voice_description: "rate limited voice description here" }),
    });

    expect(res.status).toBe(429);
    const data = await res.json();
    expect(data.error.message).toBe("rate limit");
  });

  test("design fixture does not match TTS", async () => {
    mock = new LLMock({ port: 0 });
    mock.onElevenLabsVoiceDesign("Hello world", {
      previews: [{ generated_voice_id: "p1", audio_base_64: "QQ==" }],
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Hello world" }),
    });

    expect(res.status).toBe(404);
  });
});

describe("ElevenLabs Voice Design save + voices", () => {
  let mock: LLMock;

  afterEach(async () => {
    await mock?.stop();
  });

  test("save echoes generated_voice_id as a stable voice_id", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/text-to-voice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        voice_name: "Captain",
        voice_description: SEA_CAPTAIN,
        generated_voice_id: "preview_captain",
      }),
    });

    expect(res.status).toBe(200);
    const voice = await res.json();
    expect(voice.voice_id).toBe("preview_captain");
    expect(voice.name).toBe("Captain");
    expect(voice.description).toBe(SEA_CAPTAIN);
    expect(voice.category).toBe("generated");
  });

  test("save then TTS with returned voice_id hits an existing TTS fixture", async () => {
    mock = new LLMock({ port: 0 });
    mock.onElevenLabsVoiceDesign(/sea captain/, {
      previews: [{ generated_voice_id: "preview_captain", audio_base_64: "SGVsbG8=" }],
    });
    mock.onElevenLabsTTS("Ahoy", { audio: "SGVsbG8=", format: "mp3" });
    await mock.start();

    const designed = await fetch(`${mock.url}/v1/text-to-voice/design`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voice_description: SEA_CAPTAIN }),
    });
    const previews = await designed.json();
    const generatedId = previews.previews[0].generated_voice_id;

    const saved = await fetch(`${mock.url}/v1/text-to-voice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        voice_name: "Captain",
        voice_description: SEA_CAPTAIN,
        generated_voice_id: generatedId,
      }),
    });
    const voice = await saved.json();

    const spoken = await fetch(`${mock.url}/v1/text-to-speech/${voice.voice_id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Ahoy" }),
    });

    expect(spoken.status).toBe(200);
    expect(spoken.headers.get("content-type")).toBe("audio/mpeg");
    const buffer = await spoken.arrayBuffer();
    expect(buffer.byteLength).toBe(5);
  });

  test("save missing generated_voice_id returns 400", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/text-to-voice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        voice_name: "Captain",
        voice_description: SEA_CAPTAIN,
      }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.message).toContain("generated_voice_id");
  });

  test("GET /v1/voices/{id} returns a saved voice", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    await fetch(`${mock.url}/v1/text-to-voice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        voice_name: "Captain",
        voice_description: SEA_CAPTAIN,
        generated_voice_id: "preview_captain",
      }),
    });

    const res = await fetch(`${mock.url}/v1/voices/preview_captain`);
    expect(res.status).toBe(200);
    const voice = await res.json();
    expect(voice.voice_id).toBe("preview_captain");
    expect(voice.name).toBe("Captain");
  });

  test("GET unknown voice returns 404", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/voices/does-not-exist`);
    expect(res.status).toBe(404);
  });

  test("DELETE is idempotent on missing voice", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    const first = await fetch(`${mock.url}/v1/voices/missing`, { method: "DELETE" });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ status: "ok" });

    const second = await fetch(`${mock.url}/v1/voices/missing`, { method: "DELETE" });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ status: "ok" });
  });

  test("DELETE removes a saved voice so GET 404s", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    await fetch(`${mock.url}/v1/text-to-voice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        voice_name: "Captain",
        voice_description: SEA_CAPTAIN,
        generated_voice_id: "preview_captain",
      }),
    });

    const del = await fetch(`${mock.url}/v1/voices/preview_captain`, { method: "DELETE" });
    expect(del.status).toBe(200);

    const get = await fetch(`${mock.url}/v1/voices/preview_captain`);
    expect(get.status).toBe(404);
  });

  test("reset clears saved voices", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    await fetch(`${mock.url}/v1/text-to-voice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        voice_name: "Captain",
        voice_description: SEA_CAPTAIN,
        generated_voice_id: "preview_captain",
      }),
    });

    mock.reset();

    const res = await fetch(`${mock.url}/v1/voices/preview_captain`);
    expect(res.status).toBe(404);
  });
});

describe("ElevenLabs Voice Design record", () => {
  let mock: LLMock;

  afterEach(async () => {
    await mock?.stop();
  });

  test("records design JSON as a json fixture and replays it", async () => {
    const fixturePath = makeTmpDir();
    const upstreamPayload = {
      previews: [
        {
          generated_voice_id: "upstream_preview",
          audio_base_64: "SGVsbG8=",
          media_type: "audio/mpeg",
          duration_secs: 2.4,
          language: "en",
        },
      ],
      text: "Recorded preview text",
    };
    const { server, url } = await createUpstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(upstreamPayload));
    });

    mock = new LLMock({
      port: 0,
      record: { providers: { elevenlabs: url }, fixturePath },
    });
    await mock.start();

    try {
      const recorded = await fetch(`${mock.url}/v1/text-to-voice/design`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voice_description: SEA_CAPTAIN }),
      });
      expect(recorded.status).toBe(200);
      expect(await recorded.json()).toEqual(upstreamPayload);

      const fixtures = mock.getFixtures();
      expect(fixtures).toHaveLength(1);
      expect(fixtures[0].match.endpoint).toBe("elevenlabs-voice-design");
      expect(fixtures[0].match.userMessage).toBe(SEA_CAPTAIN);
      expect(fixtures[0].response).toEqual({ json: upstreamPayload, status: 200 });

      mock.disableRecording();
      const replayed = await fetch(`${mock.url}/v1/text-to-voice/design`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voice_description: SEA_CAPTAIN }),
      });
      expect(replayed.status).toBe(200);
      expect(await replayed.json()).toEqual(upstreamPayload);
    } finally {
      await closeServer(server);
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });
});
