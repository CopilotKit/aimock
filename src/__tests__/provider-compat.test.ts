import { describe, it, expect, afterEach } from "vitest";
import { createServer, type ServerInstance } from "../server.js";
import type { Fixture } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function httpPost(
  url: string,
  body: object,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.text() };
}

async function httpGet(url: string): Promise<{ status: number; body: string }> {
  const res = await fetch(url);
  return { status: res.status, body: await res.text() };
}

// ---------------------------------------------------------------------------
// Shared fixtures — catch-all that responds to any model
// ---------------------------------------------------------------------------

const CATCH_ALL_FIXTURES: Fixture[] = [
  {
    match: { userMessage: "hello" },
    response: { content: "Hello from llmock!" },
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let instance: ServerInstance | null = null;

afterEach(async () => {
  if (instance) {
    await new Promise<void>((resolve) => instance!.server.close(() => resolve()));
    instance = null;
  }
});

describe("Mistral compatibility", () => {
  // Mistral uses standard /v1/chat/completions with model names like "mistral-large-latest"
  it("handles Mistral-style request via /v1/chat/completions", async () => {
    instance = await createServer(CATCH_ALL_FIXTURES);

    const { status, body } = await httpPost(
      `${instance.url}/v1/chat/completions`,
      {
        model: "mistral-large-latest",
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      },
      { Authorization: "Bearer mock-mistral-key" },
    );

    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed.choices).toBeDefined();
    expect(parsed.choices[0].message.content).toBe("Hello from llmock!");
    expect(parsed.object).toBe("chat.completion");
  });
});

describe("Groq compatibility", () => {
  // Groq uses /openai/v1/chat/completions prefix
  it("handles Groq-style request via /openai/v1/chat/completions prefix", async () => {
    instance = await createServer(CATCH_ALL_FIXTURES);

    const { status, body } = await httpPost(
      `${instance.url}/openai/v1/chat/completions`,
      {
        model: "llama-3.3-70b-versatile",
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      },
      { Authorization: "Bearer mock-groq-key" },
    );

    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed.choices).toBeDefined();
    expect(parsed.choices[0].message.content).toBe("Hello from llmock!");
    expect(parsed.object).toBe("chat.completion");
  });

  it("handles Groq-style /openai/v1/models request", async () => {
    instance = await createServer(CATCH_ALL_FIXTURES);

    const { status, body } = await httpGet(`${instance.url}/openai/v1/models`);

    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed.object).toBe("list");
    expect(parsed.data).toBeInstanceOf(Array);
  });

  it("handles Groq-style /openai/v1/embeddings request", async () => {
    instance = await createServer(CATCH_ALL_FIXTURES);

    const { status, body } = await httpPost(`${instance.url}/openai/v1/embeddings`, {
      model: "text-embedding-3-small",
      input: "test embedding via groq prefix",
    });

    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed.object).toBe("list");
    expect(parsed.data[0].embedding).toBeInstanceOf(Array);
  });
});

describe("Ollama compatibility", () => {
  // Ollama uses standard /v1/chat/completions with local model names like "llama3.2"
  it("handles Ollama-style request via /v1/chat/completions", async () => {
    instance = await createServer(CATCH_ALL_FIXTURES);

    const { status, body } = await httpPost(`${instance.url}/v1/chat/completions`, {
      model: "llama3.2",
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    });

    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed.choices).toBeDefined();
    expect(parsed.choices[0].message.content).toBe("Hello from llmock!");
    expect(parsed.object).toBe("chat.completion");
  });
});

describe("Together AI compatibility", () => {
  // Together AI uses standard /v1/chat/completions with model names like "meta-llama/Llama-3-70b-chat-hf"
  it("handles Together AI-style request via /v1/chat/completions", async () => {
    instance = await createServer(CATCH_ALL_FIXTURES);

    const { status, body } = await httpPost(
      `${instance.url}/v1/chat/completions`,
      {
        model: "meta-llama/Llama-3-70b-chat-hf",
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      },
      { Authorization: "Bearer mock-together-key" },
    );

    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed.choices).toBeDefined();
    expect(parsed.choices[0].message.content).toBe("Hello from llmock!");
  });
});

describe("vLLM compatibility", () => {
  // vLLM uses standard /v1/chat/completions with custom model names
  it("handles vLLM-style request via /v1/chat/completions", async () => {
    instance = await createServer(CATCH_ALL_FIXTURES);

    const { status, body } = await httpPost(`${instance.url}/v1/chat/completions`, {
      model: "my-fine-tuned-model",
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    });

    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed.choices).toBeDefined();
    expect(parsed.choices[0].message.content).toBe("Hello from llmock!");
  });
});
