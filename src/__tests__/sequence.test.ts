import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { LLMock } from "../llmock.js";

// ---------------------------------------------------------------------------
// Integration tests for sequential / stateful responses (sequenceIndex)
// ---------------------------------------------------------------------------

describe("sequential responses", () => {
  let mock: LLMock;

  beforeAll(async () => {
    mock = new LLMock();
    await mock.start();
  });

  afterAll(async () => {
    await mock.stop();
  });

  it("basic 2-step sequence: same match returns different responses", async () => {
    mock.reset();
    mock.on({ userMessage: "plan", sequenceIndex: 0 }, { content: "Step 1: planning..." });
    mock.on({ userMessage: "plan", sequenceIndex: 1 }, { content: "Step 2: done!" });

    // First request matching "plan" → first response
    const res1 = await fetch(`${mock.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "plan" }],
        stream: false,
      }),
    });
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { choices: { message: { content: string } }[] };
    expect(body1.choices[0].message.content).toBe("Step 1: planning...");

    // Second request matching "plan" → second response
    const res2 = await fetch(`${mock.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "plan" }],
        stream: false,
      }),
    });
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { choices: { message: { content: string } }[] };
    expect(body2.choices[0].message.content).toBe("Step 2: done!");
  });

  it("3-step sequence", async () => {
    mock.reset();
    mock.on({ userMessage: "go", sequenceIndex: 0 }, { content: "first" });
    mock.on({ userMessage: "go", sequenceIndex: 1 }, { content: "second" });
    mock.on({ userMessage: "go", sequenceIndex: 2 }, { content: "third" });

    const responses: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${mock.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4",
          messages: [{ role: "user", content: "go" }],
          stream: false,
        }),
      });
      const body = (await res.json()) as { choices: { message: { content: string } }[] };
      responses.push(body.choices[0].message.content);
    }
    expect(responses).toEqual(["first", "second", "third"]);
  });

  it("sequence with different match criteria does not interfere", async () => {
    mock.reset();
    mock.on({ userMessage: "alpha", sequenceIndex: 0 }, { content: "alpha-0" });
    mock.on({ userMessage: "alpha", sequenceIndex: 1 }, { content: "alpha-1" });
    mock.on({ userMessage: "beta", sequenceIndex: 0 }, { content: "beta-0" });

    // Hit alpha once
    const res1 = await fetch(`${mock.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "alpha" }],
        stream: false,
      }),
    });
    const body1 = (await res1.json()) as { choices: { message: { content: string } }[] };
    expect(body1.choices[0].message.content).toBe("alpha-0");

    // Hit beta — should be at sequenceIndex 0, not affected by alpha's count
    const res2 = await fetch(`${mock.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "beta" }],
        stream: false,
      }),
    });
    const body2 = (await res2.json()) as { choices: { message: { content: string } }[] };
    expect(body2.choices[0].message.content).toBe("beta-0");

    // Hit alpha again — should be at sequenceIndex 1
    const res3 = await fetch(`${mock.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "alpha" }],
        stream: false,
      }),
    });
    const body3 = (await res3.json()) as { choices: { message: { content: string } }[] };
    expect(body3.choices[0].message.content).toBe("alpha-1");
  });

  it("sequence index out of bounds falls through to next fixture", async () => {
    mock.reset();
    mock.on({ userMessage: "once", sequenceIndex: 0 }, { content: "only-first-time" });
    // Fallback for any subsequent matches
    mock.on({ userMessage: "once" }, { content: "fallback" });

    const res1 = await fetch(`${mock.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "once" }],
        stream: false,
      }),
    });
    const body1 = (await res1.json()) as { choices: { message: { content: string } }[] };
    expect(body1.choices[0].message.content).toBe("only-first-time");

    // Second request: sequenceIndex 0 won't match (count is now 1), falls to fallback
    const res2 = await fetch(`${mock.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "once" }],
        stream: false,
      }),
    });
    const body2 = (await res2.json()) as { choices: { message: { content: string } }[] };
    expect(body2.choices[0].message.content).toBe("fallback");
  });

  it("sequenceIndex undefined matches any occurrence (backward compat)", async () => {
    mock.reset();
    mock.on({ userMessage: "always" }, { content: "same-every-time" });

    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${mock.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4",
          messages: [{ role: "user", content: "always" }],
          stream: false,
        }),
      });
      const body = (await res.json()) as { choices: { message: { content: string } }[] };
      expect(body.choices[0].message.content).toBe("same-every-time");
    }
  });

  it("streaming sequence returns different streamed content on each call", async () => {
    mock.reset();
    mock.on({ userMessage: "stream-seq", sequenceIndex: 0 }, { content: "stream-first" });
    mock.on({ userMessage: "stream-seq", sequenceIndex: 1 }, { content: "stream-second" });

    // First streaming request
    const res1 = await fetch(`${mock.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "stream-seq" }],
        stream: true,
      }),
    });
    expect(res1.status).toBe(200);
    const text1 = await res1.text();
    expect(text1).toContain("stream-first");

    // Second streaming request
    const res2 = await fetch(`${mock.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "stream-seq" }],
        stream: true,
      }),
    });
    expect(res2.status).toBe(200);
    const text2 = await res2.text();
    expect(text2).toContain("stream-second");
  });

  it("sequence works across Responses API endpoint", async () => {
    mock.reset();
    mock.on({ userMessage: "resp-seq", sequenceIndex: 0 }, { content: "resp-first" });
    mock.on({ userMessage: "resp-seq", sequenceIndex: 1 }, { content: "resp-second" });

    // First via Responses API
    const res1 = await fetch(`${mock.url}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        input: [{ role: "user", content: "resp-seq" }],
        stream: false,
      }),
    });
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { output: { content: { text: string }[] }[] };
    expect(body1.output[0].content[0].text).toBe("resp-first");

    // Second via Responses API
    const res2 = await fetch(`${mock.url}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        input: [{ role: "user", content: "resp-seq" }],
        stream: false,
      }),
    });
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { output: { content: { text: string }[] }[] };
    expect(body2.output[0].content[0].text).toBe("resp-second");
  });

  it("journal match counts reset on reset()", async () => {
    mock.reset();
    mock.on({ userMessage: "count", sequenceIndex: 0 }, { content: "first" });
    mock.on({ userMessage: "count", sequenceIndex: 1 }, { content: "second" });

    // First request
    const res1 = await fetch(`${mock.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "count" }],
        stream: false,
      }),
    });
    const body1 = (await res1.json()) as { choices: { message: { content: string } }[] };
    expect(body1.choices[0].message.content).toBe("first");

    // Reset and re-add the same fixtures
    mock.reset();
    mock.on({ userMessage: "count", sequenceIndex: 0 }, { content: "first" });
    mock.on({ userMessage: "count", sequenceIndex: 1 }, { content: "second" });

    // After reset, the count should be back to 0 — first request should match sequenceIndex 0 again
    const res2 = await fetch(`${mock.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "count" }],
        stream: false,
      }),
    });
    const body2 = (await res2.json()) as { choices: { message: { content: string } }[] };
    expect(body2.choices[0].message.content).toBe("first");
  });
});

// ---------------------------------------------------------------------------
// Helper for non-streaming OpenAI chat completions POST
// ---------------------------------------------------------------------------

async function chatPost(
  baseUrl: string,
  userContent: string,
  extra: Record<string, unknown> = {},
): Promise<{ status: number; body: string }> {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4",
      messages: [{ role: "user", content: userContent }],
      stream: false,
      ...extra,
    }),
  });
  return { status: res.status, body: await res.text() };
}

// ---------------------------------------------------------------------------
// 1. Sequential error responses
// ---------------------------------------------------------------------------

describe("sequential error responses", () => {
  let mock: LLMock;

  beforeAll(async () => {
    mock = new LLMock();
    await mock.start();
  });

  afterAll(async () => {
    await mock.stop();
  });

  it("step 0 returns text, step 1 returns a 429 error", async () => {
    mock.reset();
    mock.on({ userMessage: "seq-err", sequenceIndex: 0 }, { content: "Success response" });
    mock.on(
      { userMessage: "seq-err", sequenceIndex: 1 },
      {
        error: { message: "Rate limited", type: "rate_limit_error", code: "rate_limit" },
        status: 429,
      },
    );

    // First request — should succeed
    const r1 = await chatPost(mock.url, "seq-err");
    expect(r1.status).toBe(200);
    const b1 = JSON.parse(r1.body);
    expect(b1.choices[0].message.content).toBe("Success response");

    // Second request — should return the error
    const r2 = await chatPost(mock.url, "seq-err");
    expect(r2.status).toBe(429);
    const b2 = JSON.parse(r2.body);
    expect(b2.error.message).toBe("Rate limited");
    expect(b2.error.type).toBe("rate_limit_error");
  });
});

// ---------------------------------------------------------------------------
// 2. Sequential tool call responses
// ---------------------------------------------------------------------------

describe("sequential tool call responses", () => {
  let mock: LLMock;

  beforeAll(async () => {
    mock = new LLMock();
    await mock.start();
  });

  afterAll(async () => {
    await mock.stop();
  });

  it("step 0 returns text, step 1 returns a tool call", async () => {
    mock.reset();
    mock.on({ userMessage: "seq-tool", sequenceIndex: 0 }, { content: "Thinking..." });
    mock.on(
      { userMessage: "seq-tool", sequenceIndex: 1 },
      {
        toolCalls: [
          {
            name: "get_weather",
            arguments: '{"city":"NYC"}',
            id: "call_seq_tool_1",
          },
        ],
      },
    );

    // First request — text
    const r1 = await chatPost(mock.url, "seq-tool");
    expect(r1.status).toBe(200);
    const b1 = JSON.parse(r1.body);
    expect(b1.choices[0].message.content).toBe("Thinking...");

    // Second request — tool call
    const r2 = await chatPost(mock.url, "seq-tool");
    expect(r2.status).toBe(200);
    const b2 = JSON.parse(r2.body);
    const tc = b2.choices[0].message.tool_calls[0];
    expect(tc.function.name).toBe("get_weather");
    expect(tc.id).toBe("call_seq_tool_1");
    expect(JSON.parse(tc.function.arguments)).toEqual({ city: "NYC" });
    expect(b2.choices[0].finish_reason).toBe("tool_calls");
  });
});

// ---------------------------------------------------------------------------
// 3. Skipped sequenceIndex (gap in indices)
// ---------------------------------------------------------------------------

describe("skipped sequenceIndex (gap in indices)", () => {
  let mock: LLMock;

  beforeAll(async () => {
    mock = new LLMock();
    await mock.start();
  });

  afterAll(async () => {
    await mock.stop();
  });

  it("index 0 matches, missing index 1 falls to fallback, subsequent calls also use fallback", async () => {
    mock.reset();
    mock.on({ userMessage: "gap", sequenceIndex: 0 }, { content: "zero" });
    mock.on({ userMessage: "gap", sequenceIndex: 2 }, { content: "two" });
    // Fallback with no sequenceIndex — matches any count
    mock.on({ userMessage: "gap" }, { content: "fallback" });

    // Call 1 → sequenceIndex 0 matches (count goes from 0→1 for all sequenced siblings)
    const r1 = await chatPost(mock.url, "gap");
    expect(JSON.parse(r1.body).choices[0].message.content).toBe("zero");

    // Call 2 → count is 1 for sequenced fixtures, no fixture for index 1, falls to fallback
    const r2 = await chatPost(mock.url, "gap");
    expect(JSON.parse(r2.body).choices[0].message.content).toBe("fallback");

    // Call 3 → the fallback (non-sequenced) doesn't increment sibling counts,
    // so sequenceIndex:2 still has count 1, not 2. Falls through to fallback again.
    const r3 = await chatPost(mock.url, "gap");
    expect(JSON.parse(r3.body).choices[0].message.content).toBe("fallback");
  });
});

// ---------------------------------------------------------------------------
// 4. Anthropic Messages API sequences
// ---------------------------------------------------------------------------

describe("Anthropic Messages API sequences", () => {
  let mock: LLMock;

  beforeAll(async () => {
    mock = new LLMock();
    await mock.start();
  });

  afterAll(async () => {
    await mock.stop();
  });

  it("2-step sequence on /v1/messages", async () => {
    mock.reset();
    mock.on({ userMessage: "anthropic-seq", sequenceIndex: 0 }, { content: "Claude response 1" });
    mock.on({ userMessage: "anthropic-seq", sequenceIndex: 1 }, { content: "Claude response 2" });

    const anthropicPost = async (msg: string) => {
      const res = await fetch(`${mock.url}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-3-5-sonnet-20241022",
          max_tokens: 1024,
          messages: [{ role: "user", content: msg }],
          stream: false,
        }),
      });
      return { status: res.status, body: await res.json() };
    };

    const r1 = await anthropicPost("anthropic-seq");
    expect(r1.status).toBe(200);
    expect((r1.body as { content: { text: string }[] }).content[0].text).toBe("Claude response 1");

    const r2 = await anthropicPost("anthropic-seq");
    expect(r2.status).toBe(200);
    expect((r2.body as { content: { text: string }[] }).content[0].text).toBe("Claude response 2");
  });
});

// ---------------------------------------------------------------------------
// 5. Gemini API sequences
// ---------------------------------------------------------------------------

describe("Gemini API sequences", () => {
  let mock: LLMock;

  beforeAll(async () => {
    mock = new LLMock();
    await mock.start();
  });

  afterAll(async () => {
    await mock.stop();
  });

  it("2-step sequence on Gemini generateContent", async () => {
    mock.reset();
    mock.on({ userMessage: "gemini-seq", sequenceIndex: 0 }, { content: "Gemini response 1" });
    mock.on({ userMessage: "gemini-seq", sequenceIndex: 1 }, { content: "Gemini response 2" });

    const geminiPost = async (msg: string) => {
      const res = await fetch(`${mock.url}/v1beta/models/gemini-2.0-flash:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: msg }] }],
        }),
      });
      return { status: res.status, body: await res.json() };
    };

    const r1 = await geminiPost("gemini-seq");
    expect(r1.status).toBe(200);
    type GeminiBody = {
      candidates: { content: { parts: { text: string }[] } }[];
    };
    expect((r1.body as GeminiBody).candidates[0].content.parts[0].text).toBe("Gemini response 1");

    const r2 = await geminiPost("gemini-seq");
    expect(r2.status).toBe(200);
    expect((r2.body as GeminiBody).candidates[0].content.parts[0].text).toBe("Gemini response 2");
  });
});

// ---------------------------------------------------------------------------
// 6. Sequential responses with predicate matching
// ---------------------------------------------------------------------------

describe("sequential responses with predicate matching", () => {
  let mock: LLMock;

  beforeAll(async () => {
    mock = new LLMock();
    await mock.start();
  });

  afterAll(async () => {
    await mock.stop();
  });

  it("predicate + sequenceIndex work together", async () => {
    mock.reset();
    // Use same function reference so matchCriteriaEqual recognizes them as siblings
    const pred = (req: import("../types.js").ChatCompletionRequest) =>
      req.model === "gpt-4" && req.temperature === 0.5;
    mock.on({ predicate: pred, sequenceIndex: 0 }, { content: "predicate-first" });
    mock.on({ predicate: pred, sequenceIndex: 1 }, { content: "predicate-second" });

    const r1 = await chatPost(mock.url, "anything", { temperature: 0.5 });
    expect(JSON.parse(r1.body).choices[0].message.content).toBe("predicate-first");

    const r2 = await chatPost(mock.url, "anything", { temperature: 0.5 });
    expect(JSON.parse(r2.body).choices[0].message.content).toBe("predicate-second");
  });
});

// ---------------------------------------------------------------------------
// 7. Sequential responses with model matching
// ---------------------------------------------------------------------------

describe("sequential responses with model matching", () => {
  let mock: LLMock;

  beforeAll(async () => {
    mock = new LLMock();
    await mock.start();
  });

  afterAll(async () => {
    await mock.stop();
  });

  it("two models each with 2-step sequences that do not interfere", async () => {
    mock.reset();
    mock.on(
      { userMessage: "model-seq", model: "gpt-4", sequenceIndex: 0 },
      { content: "gpt4-step0" },
    );
    mock.on(
      { userMessage: "model-seq", model: "gpt-4", sequenceIndex: 1 },
      { content: "gpt4-step1" },
    );
    mock.on(
      { userMessage: "model-seq", model: "gpt-3.5-turbo", sequenceIndex: 0 },
      { content: "gpt35-step0" },
    );
    mock.on(
      { userMessage: "model-seq", model: "gpt-3.5-turbo", sequenceIndex: 1 },
      { content: "gpt35-step1" },
    );

    // Hit gpt-4 first
    const r1 = await chatPost(mock.url, "model-seq", { model: "gpt-4" });
    expect(JSON.parse(r1.body).choices[0].message.content).toBe("gpt4-step0");

    // Hit gpt-3.5-turbo — its sequence should be independent
    const r2 = await chatPost(mock.url, "model-seq", { model: "gpt-3.5-turbo" });
    expect(JSON.parse(r2.body).choices[0].message.content).toBe("gpt35-step0");

    // Hit gpt-4 again — should be at step 1
    const r3 = await chatPost(mock.url, "model-seq", { model: "gpt-4" });
    expect(JSON.parse(r3.body).choices[0].message.content).toBe("gpt4-step1");

    // Hit gpt-3.5-turbo again — should be at step 1
    const r4 = await chatPost(mock.url, "model-seq", { model: "gpt-3.5-turbo" });
    expect(JSON.parse(r4.body).choices[0].message.content).toBe("gpt35-step1");
  });
});

// ---------------------------------------------------------------------------
// 8. resetMatchCounts preserves fixtures
// ---------------------------------------------------------------------------

describe("resetMatchCounts preserves fixtures", () => {
  let mock: LLMock;

  beforeAll(async () => {
    mock = new LLMock();
    await mock.start();
  });

  afterAll(async () => {
    await mock.stop();
  });

  it("sequence resets but fixtures remain after resetMatchCounts()", async () => {
    mock.reset();
    mock.on({ userMessage: "rmc", sequenceIndex: 0 }, { content: "rmc-first" });
    mock.on({ userMessage: "rmc", sequenceIndex: 1 }, { content: "rmc-second" });

    // Advance to step 1
    const r1 = await chatPost(mock.url, "rmc");
    expect(JSON.parse(r1.body).choices[0].message.content).toBe("rmc-first");

    const r2 = await chatPost(mock.url, "rmc");
    expect(JSON.parse(r2.body).choices[0].message.content).toBe("rmc-second");

    // Reset match counts only (not fixtures)
    mock.resetMatchCounts();

    // Fixtures should still be loaded — sequence starts over at step 0
    const r3 = await chatPost(mock.url, "rmc");
    expect(JSON.parse(r3.body).choices[0].message.content).toBe("rmc-first");

    const r4 = await chatPost(mock.url, "rmc");
    expect(JSON.parse(r4.body).choices[0].message.content).toBe("rmc-second");

    // Verify fixtures are still there
    expect(mock.getFixtures().length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 9. Concurrent sequential requests
// ---------------------------------------------------------------------------

describe("concurrent sequential requests", () => {
  let mock: LLMock;

  beforeAll(async () => {
    mock = new LLMock();
    await mock.start();
  });

  afterAll(async () => {
    await mock.stop();
  });

  it("3 concurrent requests against a 3-step sequence all get different responses", async () => {
    mock.reset();
    mock.on({ userMessage: "concurrent", sequenceIndex: 0 }, { content: "c-first" });
    mock.on({ userMessage: "concurrent", sequenceIndex: 1 }, { content: "c-second" });
    mock.on({ userMessage: "concurrent", sequenceIndex: 2 }, { content: "c-third" });

    const results = await Promise.all([
      chatPost(mock.url, "concurrent"),
      chatPost(mock.url, "concurrent"),
      chatPost(mock.url, "concurrent"),
    ]);

    const contents = results.map((r) => {
      expect(r.status).toBe(200);
      return JSON.parse(r.body).choices[0].message.content as string;
    });

    // All 3 different responses should appear (order may vary due to concurrency)
    expect(contents.sort()).toEqual(["c-first", "c-second", "c-third"]);
  });
});
