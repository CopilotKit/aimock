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
