import { describe, test, expect } from "vitest";
import { LLMock } from "../llmock.js";

describe("image generation", () => {
  test("image generation returns fixture (OpenAI format)", async () => {
    const mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "a guitar", endpoint: "image" },
      response: {
        image: { url: "https://example.com/guitar.png", revisedPrompt: "a guitar on display" },
      },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/images/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({ model: "dall-e-3", prompt: "a guitar", n: 1 }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.data[0].url).toBe("https://example.com/guitar.png");
    expect(data.data[0].revised_prompt).toBe("a guitar on display");
    expect(typeof data.created).toBe("number");
    await mock.stop();
  });

  test("multiple images", async () => {
    const mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "guitars", endpoint: "image" },
      response: {
        images: [{ url: "https://example.com/1.png" }, { url: "https://example.com/2.png" }],
      },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/images/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({ model: "dall-e-3", prompt: "guitars", n: 2 }),
    });
    const data = await res.json();
    expect(data.data).toHaveLength(2);
    expect(data.data[0].url).toBe("https://example.com/1.png");
    expect(data.data[1].url).toBe("https://example.com/2.png");
    await mock.stop();
  });

  test("base64 image response", async () => {
    const mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "a cat", endpoint: "image" },
      response: { image: { b64Json: "iVBORw0KGgo=" } },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/images/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({ model: "dall-e-3", prompt: "a cat", response_format: "b64_json" }),
    });
    const data = await res.json();
    expect(data.data[0].b64_json).toBe("iVBORw0KGgo=");
    await mock.stop();
  });

  test("Gemini Imagen endpoint", async () => {
    const mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "a guitar", endpoint: "image" },
      response: { image: { b64Json: "iVBORw0KGgo=" } },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1beta/models/imagen-3.0-generate-002:predict`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instances: [{ prompt: "a guitar" }], parameters: { sampleCount: 1 } }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.predictions[0].bytesBase64Encoded).toBe("iVBORw0KGgo=");
    expect(data.predictions[0].mimeType).toBe("image/png");
    await mock.stop();
  });
});

describe("audio transcription", () => {
  test("transcription returns text", async () => {
    const mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { endpoint: "transcription" },
      response: { transcription: { text: "Welcome", language: "english", duration: 2.5 } },
    });
    await mock.start();

    const formData = new FormData();
    formData.append("file", new Blob(["fake audio"], { type: "audio/wav" }), "test.wav");
    formData.append("model", "whisper-1");

    const res = await fetch(`${mock.url}/v1/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: "Bearer test" },
      body: formData,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.text).toBe("Welcome");
    await mock.stop();
  });

  test("verbose transcription includes words and segments", async () => {
    const mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { endpoint: "transcription" },
      response: {
        transcription: {
          text: "Welcome",
          language: "english",
          duration: 2.5,
          words: [{ word: "Welcome", start: 0.0, end: 0.5 }],
          segments: [{ id: 0, text: "Welcome", start: 0.0, end: 2.5 }],
        },
      },
    });
    await mock.start();

    const formData = new FormData();
    formData.append("file", new Blob(["fake audio"]), "test.wav");
    formData.append("model", "whisper-1");
    formData.append("response_format", "verbose_json");

    const res = await fetch(`${mock.url}/v1/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: "Bearer test" },
      body: formData,
    });
    const data = await res.json();
    expect(data.task).toBe("transcribe");
    expect(data.words).toHaveLength(1);
    expect(data.segments).toHaveLength(1);
    await mock.stop();
  });
});

describe("audio translation", () => {
  test("translation returns text", async () => {
    const mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { endpoint: "translation" },
      response: { transcription: { text: "Hello world", language: "english", duration: 3.0 } },
    });
    await mock.start();

    const formData = new FormData();
    formData.append("file", new Blob(["fake audio"], { type: "audio/wav" }), "test.wav");
    formData.append("model", "whisper-1");

    const res = await fetch(`${mock.url}/v1/audio/translations`, {
      method: "POST",
      headers: { Authorization: "Bearer test" },
      body: formData,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.text).toBe("Hello world");
    await mock.stop();
  });

  test("verbose translation includes task=translate", async () => {
    const mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { endpoint: "translation" },
      response: {
        transcription: {
          text: "Hello world",
          language: "english",
          duration: 3.0,
          words: [{ word: "Hello", start: 0.0, end: 0.3 }],
          segments: [{ id: 0, text: "Hello world", start: 0.0, end: 3.0 }],
        },
      },
    });
    await mock.start();

    const formData = new FormData();
    formData.append("file", new Blob(["fake audio"]), "test.wav");
    formData.append("model", "whisper-1");
    formData.append("response_format", "verbose_json");

    const res = await fetch(`${mock.url}/v1/audio/translations`, {
      method: "POST",
      headers: { Authorization: "Bearer test" },
      body: formData,
    });
    const data = await res.json();
    expect(data.task).toBe("translate");
    expect(data.words).toHaveLength(1);
    expect(data.segments).toHaveLength(1);
    await mock.stop();
  });

  test("onTranslation creates fixture with correct endpoint", async () => {
    const mock = new LLMock({ port: 0 });
    mock.onTranslation({ transcription: { text: "translated text" } });
    await mock.start();

    const formData = new FormData();
    formData.append("file", new Blob(["audio"]), "test.wav");
    formData.append("model", "whisper-1");
    const res = await fetch(`${mock.url}/v1/audio/translations`, {
      method: "POST",
      headers: { Authorization: "Bearer t" },
      body: formData,
    });
    expect((await res.json()).text).toBe("translated text");
    await mock.stop();
  });

  test("translation and transcription fixtures do not cross-match", async () => {
    const mock = new LLMock({ port: 0 });
    mock.onTranscription({ transcription: { text: "transcribed" } });
    mock.onTranslation({ transcription: { text: "translated" } });
    await mock.start();

    const makeForm = () => {
      const formData = new FormData();
      formData.append("file", new Blob(["audio"]), "test.wav");
      formData.append("model", "whisper-1");
      return formData;
    };

    const transcriptionRes = await fetch(`${mock.url}/v1/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: "Bearer t" },
      body: makeForm(),
    });
    expect((await transcriptionRes.json()).text).toBe("transcribed");

    const translationRes = await fetch(`${mock.url}/v1/audio/translations`, {
      method: "POST",
      headers: { Authorization: "Bearer t" },
      body: makeForm(),
    });
    expect((await translationRes.json()).text).toBe("translated");

    await mock.stop();
  });
});

describe("video generation", () => {
  test("video creation and status check", async () => {
    const mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "a guitar", endpoint: "video" },
      response: {
        video: { id: "vid_123", status: "completed", url: "https://example.com/video.mp4" },
      },
    });
    await mock.start();

    // Create
    const create = await fetch(`${mock.url}/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({ model: "sora-2", prompt: "a guitar" }),
    });
    const job = await create.json();
    expect(job.id).toBe("vid_123");
    expect(job.status).toBe("completed");

    // Status check
    const status = await fetch(`${mock.url}/v1/videos/vid_123`, {
      headers: { Authorization: "Bearer test" },
    });
    const result = await status.json();
    expect(result.status).toBe("completed");
    expect(result.url).toBe("https://example.com/video.mp4");
    await mock.stop();
  });

  test("video processing returns minimal response then status on GET", async () => {
    const mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "slow motion", endpoint: "video" },
      response: {
        video: { id: "vid_456", status: "processing", url: "https://example.com/slow.mp4" },
      },
    });
    await mock.start();

    const create = await fetch(`${mock.url}/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({ model: "sora-2", prompt: "slow motion" }),
    });
    const job = await create.json();
    expect(job.id).toBe("vid_456");
    expect(job.status).toBe("processing");
    expect(job.url).toBeUndefined();

    const status = await fetch(`${mock.url}/v1/videos/vid_456`, {
      headers: { Authorization: "Bearer test" },
    });
    const result = await status.json();
    expect(result.id).toBe("vid_456");
    expect(result.status).toBe("processing");
    await mock.stop();
  });

  test("video status 404 for unknown id", async () => {
    const mock = new LLMock({ port: 0 });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/videos/unknown`, {
      headers: { Authorization: "Bearer test" },
    });
    expect(res.status).toBe(404);
    await mock.stop();
  });

  test("video creation parses multipart/form-data body (OpenAI SDK 6.28.0+)", async () => {
    const mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "a guitar", endpoint: "video" },
      response: {
        video: { id: "vid_mp", status: "completed", url: "https://example.com/video.mp4" },
      },
    });
    await mock.start();

    // The OpenAI SDK (>=6.28.0) sends videos.create as multipart/form-data.
    // `fetch` sets the multipart Content-Type (with boundary) automatically.
    const form = new FormData();
    form.set("model", "sora-2");
    form.set("prompt", "a guitar");
    form.set("seconds", "8");
    const create = await fetch(`${mock.url}/v1/videos`, {
      method: "POST",
      headers: { Authorization: "Bearer test" },
      body: form,
    });
    const job = await create.json();
    expect(job.id).toBe("vid_mp");
    expect(job.status).toBe("completed");
    await mock.stop();
  });
});

describe("convenience methods", () => {
  test("onImage creates fixture with correct endpoint", async () => {
    const mock = new LLMock({ port: 0 });
    mock.onImage("sunset", { image: { url: "sunset.png" } });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/images/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
      body: JSON.stringify({ prompt: "sunset" }),
    });
    expect((await res.json()).data[0].url).toBe("sunset.png");
    await mock.stop();
  });

  test("onSpeech creates fixture with correct endpoint", async () => {
    const mock = new LLMock({ port: 0 });
    mock.onSpeech("hello", { audio: "AAAA", format: "mp3" });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
      body: JSON.stringify({ input: "hello", model: "tts-1", voice: "alloy" }),
    });
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    await mock.stop();
  });

  test("onTranscription creates fixture with correct endpoint", async () => {
    const mock = new LLMock({ port: 0 });
    mock.onTranscription({ transcription: { text: "hello world" } });
    await mock.start();

    const formData = new FormData();
    formData.append("file", new Blob(["audio"]), "test.wav");
    formData.append("model", "whisper-1");
    const res = await fetch(`${mock.url}/v1/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: "Bearer t" },
      body: formData,
    });
    expect((await res.json()).text).toBe("hello world");
    await mock.stop();
  });

  test("onVideo creates fixture with correct endpoint", async () => {
    const mock = new LLMock({ port: 0 });
    mock.onVideo("dancing", { video: { id: "v1", status: "completed", url: "dance.mp4" } });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
      body: JSON.stringify({ prompt: "dancing" }),
    });
    expect((await res.json()).id).toBe("v1");
    await mock.stop();
  });
});

describe("X-Test-Id isolation", () => {
  test("X-Test-Id works for image endpoint", async () => {
    const mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "g", endpoint: "image", sequenceIndex: 0 },
      response: { image: { url: "1.png" } },
    });
    mock.addFixture({
      match: { userMessage: "g", endpoint: "image", sequenceIndex: 1 },
      response: { image: { url: "2.png" } },
    });
    await mock.start();

    const req = (testId: string) =>
      fetch(`${mock.url}/v1/images/generations`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer t",
          "X-Test-Id": testId,
        },
        body: JSON.stringify({ model: "dall-e-3", prompt: "g" }),
      }).then((r) => r.json());

    const [a, b] = await Promise.all([req("A"), req("B")]);
    expect(a.data[0].url).toBe("1.png");
    expect(b.data[0].url).toBe("1.png"); // both get sequenceIndex 0

    await mock.stop();
  });
});

describe("endpoint cross-matching prevention", () => {
  test("image fixture does not match chat request", async () => {
    const mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "guitar", endpoint: "image" },
      response: { image: { url: "img.png" } },
    });
    mock.addFixture({
      match: { userMessage: "guitar" },
      response: { content: "Chat about guitars" },
    });
    await mock.start();

    // Chat request should NOT match the image fixture
    const chat = await fetch(`${mock.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "guitar" }],
        stream: false,
      }),
    });
    const chatData = await chat.json();
    expect(chatData.choices[0].message.content).toBe("Chat about guitars");

    // Image request should match the image fixture
    const img = await fetch(`${mock.url}/v1/images/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
      body: JSON.stringify({ model: "dall-e-3", prompt: "guitar" }),
    });
    const imgData = await img.json();
    expect(imgData.data[0].url).toBe("img.png");

    await mock.stop();
  });
});

describe("endpoint backfill on existing handlers", () => {
  test("fixture with endpoint: chat matches chat completions", async () => {
    const mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "hello", endpoint: "chat" },
      response: { content: "Hi there" },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      }),
    });
    const data = await res.json();
    expect(data.choices[0].message.content).toBe("Hi there");
    await mock.stop();
  });

  test("fixture with endpoint: embedding matches embeddings", async () => {
    const mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { inputText: "test input", endpoint: "embedding" },
      response: { embedding: [0.1, 0.2, 0.3] },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
      body: JSON.stringify({ model: "text-embedding-3-small", input: "test input" }),
    });
    const data = await res.json();
    expect(data.data[0].embedding).toEqual([0.1, 0.2, 0.3]);
    await mock.stop();
  });
});

describe("text-to-speech", () => {
  test("TTS returns audio bytes with correct content-type", async () => {
    const mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "hello world", endpoint: "speech" },
      response: { audio: "AAAA", format: "mp3" },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({ model: "tts-1", input: "hello world", voice: "alloy" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    const buffer = await res.arrayBuffer();
    expect(buffer.byteLength).toBeGreaterThan(0);
    await mock.stop();
  });

  test("TTS respects format for content-type", async () => {
    const mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "test", endpoint: "speech" },
      response: { audio: "AAAA", format: "opus" },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({ model: "tts-1", input: "test", voice: "alloy" }),
    });
    expect(res.headers.get("content-type")).toBe("audio/opus");
    await mock.stop();
  });

  test("TTS defaults to mp3 when no format specified", async () => {
    const mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "default", endpoint: "speech" },
      response: { audio: "AAAA" },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({ model: "tts-1", input: "default", voice: "alloy" }),
    });
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    await mock.stop();
  });
});
