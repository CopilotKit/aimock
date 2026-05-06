import { describe, it, expect, afterEach } from "vitest";
import { LLMock } from "../llmock.js";
import type { ChatCompletionRequest, SSEChunk } from "../types.js";

function parseSSEChunks(body: string): SSEChunk[] {
  return body
    .split("\n\n")
    .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
    .map((line) => JSON.parse(line.slice(6)) as SSEChunk);
}

describe("async fixture response (function responses)", () => {
  let mock: LLMock | null = null;

  afterEach(async () => {
    if (mock) {
      await mock.stop();
      mock = null;
    }
  });

  it("resolves a sync function response", async () => {
    mock = new LLMock({ port: 0 });
    mock.on({ userMessage: "sync-fn" }, () => ({ content: "sync-factory-result" }));
    await mock.start();

    const res = await fetch(`${mock.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "sync-fn" }],
        stream: false,
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.choices[0].message.content).toBe("sync-factory-result");
  });

  it("resolves an async function response", async () => {
    mock = new LLMock({ port: 0 });
    mock.on({ userMessage: "async-fn" }, async () => {
      return { content: "async-factory-result" };
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "async-fn" }],
        stream: false,
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.choices[0].message.content).toBe("async-factory-result");
  });

  it("receives the request object in the factory function", async () => {
    mock = new LLMock({ port: 0 });
    mock.on({ userMessage: "echo-model" }, (req: ChatCompletionRequest) => ({
      content: `model=${req.model}`,
    }));
    await mock.start();

    const res = await fetch(`${mock.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "echo-model" }],
        stream: false,
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.choices[0].message.content).toBe("model=gpt-4o-mini");
  });

  it("works with streaming responses from a factory", async () => {
    mock = new LLMock({ port: 0 });
    mock.on({ userMessage: "stream-fn" }, () => ({ content: "streamed-from-factory" }));
    await mock.start();

    const res = await fetch(`${mock.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "stream-fn" }],
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    const chunks = parseSSEChunks(await res.text());
    const content = chunks.map((c) => c.choices?.[0]?.delta?.content ?? "").join("");
    expect(content).toBe("streamed-from-factory");
  });

  it("works with onMessage convenience method", async () => {
    mock = new LLMock({ port: 0 });
    mock.onMessage("convenience-fn", (req: ChatCompletionRequest) => ({
      content: `msg-count=${req.messages.length}`,
    }));
    await mock.start();

    const res = await fetch(`${mock.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [
          { role: "system", content: "you are helpful" },
          { role: "user", content: "convenience-fn" },
        ],
        stream: false,
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.choices[0].message.content).toBe("msg-count=2");
  });

  it("static response still works alongside function responses", async () => {
    mock = new LLMock({ port: 0 });
    mock.on({ userMessage: "static" }, { content: "plain-static" });
    mock.on({ userMessage: "dynamic" }, () => ({ content: "from-function" }));
    await mock.start();

    const [staticRes, dynamicRes] = await Promise.all([
      fetch(`${mock.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [{ role: "user", content: "static" }],
          stream: false,
        }),
      }),
      fetch(`${mock.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [{ role: "user", content: "dynamic" }],
          stream: false,
        }),
      }),
    ]);

    expect(staticRes.status).toBe(200);
    expect(dynamicRes.status).toBe(200);

    const staticJson = await staticRes.json();
    const dynamicJson = await dynamicRes.json();

    expect(staticJson.choices[0].message.content).toBe("plain-static");
    expect(dynamicJson.choices[0].message.content).toBe("from-function");
  });

  it("returns 500 when factory throws", async () => {
    mock = new LLMock({ port: 0 });
    mock.on({ userMessage: "boom" }, () => {
      throw new Error("factory exploded");
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "boom" }],
        stream: false,
      }),
    });

    expect(res.status).toBe(500);
  });

  it("returns 500 when async factory rejects", async () => {
    mock = new LLMock({ port: 0 });
    mock.on({ userMessage: "reject" }, async () => {
      throw new Error("async rejection");
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "reject" }],
        stream: false,
      }),
    });

    expect(res.status).toBe(500);
  });

  it("returns 500 when factory returns invalid response shape", async () => {
    mock = new LLMock({ port: 0 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mock.on({ userMessage: "bad" }, () => ({ notAValidField: true }) as any);
    await mock.start();

    const res = await fetch(`${mock.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "bad" }],
        stream: false,
      }),
    });

    expect(res.status).toBe(500);
  });

  it("works with async factory and streaming", async () => {
    mock = new LLMock({ port: 0 });
    mock.on({ userMessage: "async-stream" }, async () => {
      await new Promise((r) => setTimeout(r, 10));
      return { content: "async-streamed-result" };
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "async-stream" }],
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    const chunks = parseSSEChunks(await res.text());
    const content = chunks.map((c) => c.choices?.[0]?.delta?.content ?? "").join("");
    expect(content).toBe("async-streamed-result");
  });
});
