import { describe, test, expect, afterEach } from "vitest";
import { LLMock } from "../llmock.js";

describe("Gemini audio responses", () => {
  let mock: LLMock;

  afterEach(async () => {
    await mock?.stop();
  });

  test("non-streaming generateContent with string-form audio", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "piano loop" },
      response: { audio: "SGVsbG8=", format: "mp3" },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1beta/models/lyria-3:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "piano loop" }] }],
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.candidates[0].content.parts[0].inlineData).toEqual({
      mimeType: "audio/mpeg",
      data: "SGVsbG8=",
    });
    expect(data.candidates[0].finishReason).toBe("STOP");
    expect(data.usageMetadata).toBeDefined();
  });

  test("streaming streamGenerateContent with string-form audio", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "piano loop" },
      response: { audio: "SGVsbG8=", format: "mp3" },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1beta/models/lyria-3:streamGenerateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "piano loop" }] }],
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const text = await res.text();
    // Parse SSE data lines
    const chunks = text
      .split("\n\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.replace("data: ", "")));

    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const chunk = chunks[0];
    expect(chunk.candidates[0].content.parts[0].inlineData).toEqual({
      mimeType: "audio/mpeg",
      data: "SGVsbG8=",
    });
    expect(chunk.candidates[0].finishReason).toBe("STOP");
  });

  test("non-streaming with object-form audio", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "wav audio" },
      response: { audio: { b64Json: "SGVsbG8=", contentType: "audio/wav" } },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1beta/models/lyria-3:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "wav audio" }] }],
      }),
    });
    const data = await res.json();
    expect(data.candidates[0].content.parts[0].inlineData).toEqual({
      mimeType: "audio/wav",
      data: "SGVsbG8=",
    });
  });

  test("object-form audio without contentType defaults to audio/mpeg", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "default format" },
      response: { audio: { b64Json: "SGVsbG8=" } },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1beta/models/lyria-3:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "default format" }] }],
      }),
    });
    const data = await res.json();
    expect(data.candidates[0].content.parts[0].inlineData.mimeType).toBe("audio/mpeg");
  });

  test("string-form audio with format opus", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "opus audio" },
      response: { audio: "SGVsbG8=", format: "opus" },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1beta/models/lyria-3:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "opus audio" }] }],
      }),
    });
    const data = await res.json();
    expect(data.candidates[0].content.parts[0].inlineData.mimeType).toBe("audio/opus");
  });

  test("Vertex AI path works too", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "piano loop" },
      response: { audio: "SGVsbG8=", format: "mp3" },
    });
    await mock.start();

    const res = await fetch(
      `${mock.url}/v1/projects/proj/locations/us-central1/publishers/google/models/lyria-3:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "piano loop" }] }],
        }),
      },
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.candidates[0].content.parts[0].inlineData).toEqual({
      mimeType: "audio/mpeg",
      data: "SGVsbG8=",
    });
  });

  test("non-streaming audio turn replays companion tool call + content + reasoning", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "audio with tool call" },
      response: {
        audio: "SGVsbG8=",
        format: "mp3",
        content: "Here is the audio you asked for.",
        reasoning: "User wants audio plus a lookup.",
        toolCalls: [{ id: "call_1", name: "lookup", arguments: '{"query":"weather"}' }],
      },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1beta/models/lyria-3:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "audio with tool call" }] }],
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    const parts = data.candidates[0].content.parts;

    // Audio (inlineData) must still be present and first.
    expect(parts[0].inlineData).toEqual({ mimeType: "audio/mpeg", data: "SGVsbG8=" });

    // Coverage pin: a tool-call-bearing turn must finish with FUNCTION_CALL,
    // never STOP — guards against a regression that emits STOP with a tool call.
    expect(data.candidates[0].finishReason).toBe("FUNCTION_CALL");

    // Companion modalities must NOT be dropped on replay.
    const functionCallPart = parts.find((p: { functionCall?: unknown }) => p.functionCall);
    expect(functionCallPart).toBeDefined();
    expect(functionCallPart.functionCall.name).toBe("lookup");
    expect(functionCallPart.functionCall.args).toEqual({ query: "weather" });
    expect(functionCallPart.functionCall.id).toBe("call_1");

    const textPart = parts.find((p: { text?: string; thought?: boolean }) => p.text && !p.thought);
    expect(textPart?.text).toBe("Here is the audio you asked for.");

    const thoughtPart = parts.find((p: { text?: string; thought?: boolean }) => p.thought);
    expect(thoughtPart?.text).toBe("User wants audio plus a lookup.");
  });

  test("streaming audio turn replays companion tool call + content + reasoning", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "stream audio with tool call" },
      response: {
        audio: "SGVsbG8=",
        format: "mp3",
        content: "Streamed text.",
        reasoning: "Streamed thought.",
        toolCalls: [{ id: "call_2", name: "fetch", arguments: '{"url":"x"}' }],
      },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1beta/models/lyria-3:streamGenerateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "stream audio with tool call" }] }],
      }),
    });
    expect(res.status).toBe(200);

    const text = await res.text();
    const chunks = text
      .split("\n\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.replace("data: ", "")));

    const allParts = chunks.flatMap((c) => c.candidates[0].content.parts);

    expect(allParts.some((p: { inlineData?: unknown }) => p.inlineData)).toBe(true);

    // Coverage pin: a tool-call-bearing turn must finish with FUNCTION_CALL,
    // never STOP — guards against a regression that emits STOP with a tool call.
    expect(
      chunks.some(
        (c: { candidates: Array<{ finishReason?: string }> }) =>
          c.candidates[0].finishReason === "FUNCTION_CALL",
      ),
    ).toBe(true);

    const functionCallPart = allParts.find((p: { functionCall?: unknown }) => p.functionCall);
    expect(functionCallPart).toBeDefined();
    expect(functionCallPart.functionCall.name).toBe("fetch");
    expect(functionCallPart.functionCall.id).toBe("call_2");

    const textPart = allParts.find(
      (p: { text?: string; thought?: boolean }) => p.text && !p.thought,
    );
    expect(textPart?.text).toBe("Streamed text.");

    const thoughtPart = allParts.find((p: { text?: string; thought?: boolean }) => p.thought);
    expect(thoughtPart?.text).toBe("Streamed thought.");
  });

  test("onAudio() convenience method works via Gemini", async () => {
    mock = new LLMock({ port: 0 });
    mock.onAudio("piano loop", { audio: "SGVsbG8=" });
    await mock.start();

    const res = await fetch(`${mock.url}/v1beta/models/lyria-3:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "piano loop" }] }],
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    // onAudio without format defaults to mp3
    expect(data.candidates[0].content.parts[0].inlineData).toEqual({
      mimeType: "audio/mpeg",
      data: "SGVsbG8=",
    });
  });
});
