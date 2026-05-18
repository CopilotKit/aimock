import { describe, test, expect, afterEach } from "vitest";
import { LLMock } from "../llmock.js";

describe("ElevenLabs sound generation", () => {
  let mock: LLMock;

  afterEach(async () => {
    await mock?.stop();
  });

  test("sound generation with string-form audio returns binary", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "castle door opening", endpoint: "audio-gen" },
      response: { audio: "SGVsbG8=", format: "mp3" },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/sound-generation`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({ text: "castle door opening" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    const buffer = await res.arrayBuffer();
    expect(buffer.byteLength).toBeGreaterThan(0);
    // "SGVsbG8=" decodes to "Hello" (5 bytes)
    expect(buffer.byteLength).toBe(5);
  });

  test("sound generation with object-form audio", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "explosion", endpoint: "audio-gen" },
      response: { audio: { b64Json: "SGVsbG8=", contentType: "audio/wav" } },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/sound-generation`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({ text: "explosion" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/wav");
    const buffer = await res.arrayBuffer();
    expect(buffer.byteLength).toBe(5);
  });

  test("missing text field returns 400", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/sound-generation`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.message).toContain("text");
  });

  test("no matching fixture returns 404", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "specific sound", endpoint: "audio-gen" },
      response: { audio: "SGVsbG8=" },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/sound-generation`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({ text: "completely different sound" }),
    });

    expect(res.status).toBe(404);
  });

  test("error fixture returns error status", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "rate limited", endpoint: "audio-gen" },
      response: { error: { message: "rate limit", type: "rate_limit_error" }, status: 429 },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/sound-generation`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({ text: "rate limited" }),
    });

    expect(res.status).toBe(429);
    const data = await res.json();
    expect(data.error.message).toBe("rate limit");
  });
});

describe("ElevenLabs music", () => {
  let mock: LLMock;

  afterEach(async () => {
    await mock?.stop();
  });

  test("music compose returns binary audio with song-id header", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "upbeat piano", endpoint: "audio-gen" },
      response: { audio: "SGVsbG8=", format: "mp3" },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/music`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({ prompt: "upbeat piano" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(res.headers.get("song-id")).toBeTruthy();
    expect(res.headers.get("song-id")).toMatch(/^mock-song-/);
    const buffer = await res.arrayBuffer();
    expect(buffer.byteLength).toBe(5);
  });

  test("music stream returns binary audio", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "ambient drone", endpoint: "audio-gen" },
      response: { audio: "SGVsbG8=" },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/music/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({ prompt: "ambient drone" }),
    });

    expect(res.status).toBe(200);
    const buffer = await res.arrayBuffer();
    expect(buffer.byteLength).toBe(5);
  });

  test("music plan returns JSON text", async () => {
    mock = new LLMock({ port: 0 });
    const compositionPlan = JSON.stringify({ sections: ["intro", "verse", "chorus"] });
    mock.addFixture({
      match: { userMessage: "jazz song", endpoint: "audio-gen" },
      response: { content: compositionPlan },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/music/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({ prompt: "jazz song" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    const data = await res.json();
    expect(data.sections).toEqual(["intro", "verse", "chorus"]);
  });

  test("missing prompt returns 400 for music", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/music`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.message).toContain("prompt");
  });
});

describe("ElevenLabs text-to-speech", () => {
  let mock: LLMock;

  afterEach(async () => {
    await mock?.stop();
  });

  test("TTS with voice_id in path returns binary audio", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "Hello world", endpoint: "elevenlabs-tts" },
      response: { audio: "SGVsbG8=", format: "mp3" },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({
        text: "Hello world",
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    const buffer = await res.arrayBuffer();
    expect(buffer.byteLength).toBe(5);
  });

  test("TTS with different voice_id routes correctly", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "Goodbye", endpoint: "elevenlabs-tts" },
      response: { audio: "SGVsbG8=", format: "wav" },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/text-to-speech/EXAVITQu4vr4xnSDxMaL`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({ text: "Goodbye" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/wav");
  });

  test("TTS with object-form audio response", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "object audio", endpoint: "elevenlabs-tts" },
      response: { audio: { b64Json: "SGVsbG8=", contentType: "audio/ogg" } },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/text-to-speech/voiceABC`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({ text: "object audio" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/ogg");
    const buffer = await res.arrayBuffer();
    expect(buffer.byteLength).toBe(5);
  });

  test("TTS missing text returns 400", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({ model_id: "eleven_multilingual_v2" }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.message).toContain("text");
  });

  test("TTS malformed JSON returns 400", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: "not json",
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.message).toContain("Malformed JSON");
  });

  test("TTS no matching fixture returns 404", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "specific text", endpoint: "elevenlabs-tts" },
      response: { audio: "SGVsbG8=" },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({ text: "completely different text" }),
    });

    expect(res.status).toBe(404);
  });

  test("TTS error fixture returns error status", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "rate limited", endpoint: "elevenlabs-tts" },
      response: { error: { message: "rate limit", type: "rate_limit_error" }, status: 429 },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({ text: "rate limited" }),
    });

    expect(res.status).toBe(429);
    const data = await res.json();
    expect(data.error.message).toBe("rate limit");
  });

  test("onElevenLabsTTS convenience method works", async () => {
    mock = new LLMock({ port: 0 });
    mock.onElevenLabsTTS("convenience test", { audio: "SGVsbG8=", format: "mp3" });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({ text: "convenience test" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    const buffer = await res.arrayBuffer();
    expect(buffer.byteLength).toBe(5);
  });
});

describe("ElevenLabs convenience methods", () => {
  let mock: LLMock;

  afterEach(async () => {
    await mock?.stop();
  });

  test("onSoundEffect creates fixture with correct endpoint", async () => {
    mock = new LLMock({ port: 0 });
    mock.onSoundEffect("door", { audio: "SGVsbG8=" });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/sound-generation`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({ text: "door" }),
    });

    expect(res.status).toBe(200);
    const buffer = await res.arrayBuffer();
    expect(buffer.byteLength).toBe(5);
  });

  test("onMusic creates fixture with correct endpoint", async () => {
    mock = new LLMock({ port: 0 });
    mock.onMusic("piano", { audio: "SGVsbG8=" });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/music`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({ prompt: "piano" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("song-id")).toBeTruthy();
    const buffer = await res.arrayBuffer();
    expect(buffer.byteLength).toBe(5);
  });
});
