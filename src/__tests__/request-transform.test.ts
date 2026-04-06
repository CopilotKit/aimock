import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { matchFixture } from "../router.js";
import { LLMock } from "../llmock.js";
import type { ChatCompletionRequest, Fixture } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReq(overrides: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return {
    model: "gpt-4o",
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  };
}

function makeFixture(
  match: Fixture["match"],
  response: Fixture["response"] = { content: "ok" },
): Fixture {
  return { match, response };
}

async function httpPost(url: string, body: object): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

/** Strip ISO timestamps from text content. */
const stripTimestamps = (req: ChatCompletionRequest): ChatCompletionRequest => ({
  ...req,
  messages: req.messages.map((m) => ({
    ...m,
    content:
      typeof m.content === "string"
        ? m.content.replace(/\d{4}-\d{2}-\d{2}T[\d:.+Z-]+/g, "")
        : m.content,
  })),
});

// ---------------------------------------------------------------------------
// Unit tests — matchFixture with requestTransform
// ---------------------------------------------------------------------------

describe("matchFixture — requestTransform", () => {
  it("matches after transform strips dynamic data", () => {
    const fixture = makeFixture({ userMessage: "tell me the weather" });
    const req = makeReq({
      messages: [{ role: "user", content: "tell me the weather 2026-04-02T10:30:00.000Z" }],
    });

    // Without transform — exact match would fail, but includes works
    expect(matchFixture([fixture], req)).toBe(fixture);

    // With transform — also matches (exact match against stripped text)
    const transformedFixture = makeFixture({ userMessage: "tell me the weather " });
    expect(matchFixture([transformedFixture], req, undefined, stripTimestamps)).toBe(
      transformedFixture,
    );
  });

  it("uses exact equality (===) when transform is provided", () => {
    // Fixture matches a substring — without transform, includes would match
    const fixture = makeFixture({ userMessage: "hello" });
    const req = makeReq({
      messages: [{ role: "user", content: "hello world" }],
    });

    // Without transform — includes matches
    expect(matchFixture([fixture], req)).toBe(fixture);

    // With transform (identity) — exact match fails because "hello world" !== "hello"
    const identity = (r: ChatCompletionRequest): ChatCompletionRequest => r;
    expect(matchFixture([fixture], req, undefined, identity)).toBeNull();
  });

  it("exact match succeeds when text matches precisely", () => {
    const fixture = makeFixture({ userMessage: "hello world" });
    const req = makeReq({
      messages: [{ role: "user", content: "hello world" }],
    });

    const identity = (r: ChatCompletionRequest): ChatCompletionRequest => r;
    expect(matchFixture([fixture], req, undefined, identity)).toBe(fixture);
  });

  it("preserves includes behavior when no transform is provided", () => {
    const fixture = makeFixture({ userMessage: "hello" });
    const req = makeReq({
      messages: [{ role: "user", content: "say hello to me" }],
    });

    // No transform — includes matching
    expect(matchFixture([fixture], req)).toBe(fixture);
  });

  it("applies transform to inputText (embedding) matching with exact equality", () => {
    const fixture = makeFixture({ inputText: "embed this text" });
    const req = makeReq({ embeddingInput: "embed this text plus extra" });

    // Without transform — includes matches
    expect(matchFixture([fixture], req)).toBe(fixture);

    // With identity transform — exact match fails
    const identity = (r: ChatCompletionRequest): ChatCompletionRequest => r;
    expect(matchFixture([fixture], req, undefined, identity)).toBeNull();

    // With identity transform — exact match succeeds
    const exactFixture = makeFixture({ inputText: "embed this text plus extra" });
    expect(matchFixture([exactFixture], req, undefined, identity)).toBe(exactFixture);
  });

  it("regex matching still works with transform", () => {
    const fixture = makeFixture({ userMessage: /weather/i });
    const req = makeReq({
      messages: [{ role: "user", content: "tell me the weather 2026-04-02T10:30:00.000Z" }],
    });

    // Regex always uses .test(), not exact match
    expect(matchFixture([fixture], req, undefined, stripTimestamps)).toBe(fixture);
  });

  it("predicate receives original (untransformed) request", () => {
    let receivedContent: string | null = null;
    const fixture = makeFixture({
      predicate: (r) => {
        const msg = r.messages.find((m) => m.role === "user");
        receivedContent = typeof msg?.content === "string" ? msg.content : null;
        return true;
      },
    });

    const originalContent = "hello 2026-04-02T10:30:00.000Z";
    const req = makeReq({
      messages: [{ role: "user", content: originalContent }],
    });

    matchFixture([fixture], req, undefined, stripTimestamps);
    // Predicate should see the original request, not the transformed one
    expect(receivedContent).toBe(originalContent);
  });

  it("transform applies to model matching", () => {
    const fixture = makeFixture({ model: "cleaned-model" });
    const req = makeReq({ model: "original-model" });

    const modelTransform = (r: ChatCompletionRequest): ChatCompletionRequest => ({
      ...r,
      model: "cleaned-model",
    });

    expect(matchFixture([fixture], req, undefined, modelTransform)).toBe(fixture);
  });

  it("identity transform does not break tool call matching", () => {
    const fixture = makeFixture({ toolName: "get_weather" });
    const req = makeReq({
      tools: [
        {
          type: "function",
          function: { name: "get_weather", description: "Get weather" },
        },
      ],
    });

    const identity = (r: ChatCompletionRequest): ChatCompletionRequest => r;
    expect(matchFixture([fixture], req, undefined, identity)).toBe(fixture);
  });

  it("identity transform does not break toolCallId matching", () => {
    const fixture = makeFixture({ toolCallId: "call_123" });
    const req = makeReq({
      messages: [
        { role: "user", content: "hi" },
        { role: "tool", content: "result", tool_call_id: "call_123" },
      ],
    });

    const identity = (r: ChatCompletionRequest): ChatCompletionRequest => r;
    expect(matchFixture([fixture], req, undefined, identity)).toBe(fixture);
  });

  it("sequenceIndex still works with transform", () => {
    const fixture = makeFixture({ userMessage: "cleaned", sequenceIndex: 1 });
    const req = makeReq({
      messages: [{ role: "user", content: "cleaned" }],
    });

    const identity = (r: ChatCompletionRequest): ChatCompletionRequest => r;
    const counts = new Map<Fixture, number>();

    // First call (count 0) — sequenceIndex 1 should not match
    expect(matchFixture([fixture], req, counts, identity)).toBeNull();

    // Simulate count increment
    counts.set(fixture, 1);
    expect(matchFixture([fixture], req, counts, identity)).toBe(fixture);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — LLMock server with requestTransform
// ---------------------------------------------------------------------------

let mock: LLMock | null = null;

afterEach(async () => {
  if (mock) {
    await mock.stop();
    mock = null;
  }
});

describe("LLMock server — requestTransform", () => {
  it("matches fixture after transform strips timestamps from request", async () => {
    mock = new LLMock({
      requestTransform: stripTimestamps,
    });

    // Fixture expects the cleaned message (no timestamp)
    mock.onMessage("tell me the weather ", { content: "It will be sunny" });

    const url = await mock.start();

    const res = await httpPost(`${url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [
        {
          role: "user",
          content: "tell me the weather 2026-04-02T10:30:00.000Z",
        },
      ],
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.choices[0].message.content).toBe("It will be sunny");
  });

  it("uses exact equality with transform — prevents false positive substring matches", async () => {
    mock = new LLMock({
      requestTransform: (req) => req, // identity
    });

    // "hello" is a substring of "hello world" — but with transform,
    // exact match is used, so this should NOT match
    mock.onMessage("hello", { content: "should not match" });
    mock.onMessage("hello world", { content: "correct match" });

    const url = await mock.start();

    const res = await httpPost(`${url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "hello world" }],
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.choices[0].message.content).toBe("correct match");
  });

  it("works without requestTransform — backward compatible includes matching", async () => {
    mock = new LLMock();

    mock.onMessage("hello", { content: "matched via includes" });

    const url = await mock.start();

    const res = await httpPost(`${url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "say hello to everyone" }],
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.choices[0].message.content).toBe("matched via includes");
  });

  it("transform works with streaming responses", async () => {
    mock = new LLMock({
      requestTransform: stripTimestamps,
    });

    mock.onMessage("weather ", { content: "sunny" });

    const url = await mock.start();

    const res = await httpPost(`${url}/v1/chat/completions`, {
      model: "gpt-4",
      stream: true,
      messages: [{ role: "user", content: "weather 2026-01-01T00:00:00Z" }],
    });

    expect(res.status).toBe(200);
    // Streaming responses have SSE format — just verify it returned 200
    expect(res.body).toContain("sunny");
  });

  it("transform works with embedding requests", async () => {
    mock = new LLMock({
      requestTransform: (req) => ({
        ...req,
        embeddingInput: req.embeddingInput?.replace(/\d{4}-\d{2}-\d{2}T[\d:.+Z-]+/g, ""),
      }),
    });

    mock.onEmbedding("embed this ", { embedding: [0.1, 0.2, 0.3] });

    const url = await mock.start();

    const res = await httpPost(`${url}/v1/embeddings`, {
      model: "text-embedding-3-small",
      input: "embed this 2026-04-02T10:30:00Z",
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data[0].embedding).toEqual([0.1, 0.2, 0.3]);
  });
});
