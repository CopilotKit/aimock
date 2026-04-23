import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import crypto from "node:crypto";
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
    response: { content: "Hello from aimock!" },
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
    expect(parsed.choices[0].message.content).toBe("Hello from aimock!");
    expect(parsed.object).toBe("chat.completion");
  });
});

describe("Groq streaming compatibility", () => {
  it("Groq streaming through /openai/v1/chat/completions", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "stream-groq" },
        response: { content: "Groq streamed!" },
      },
    ];
    instance = await createServer(fixtures);

    const { status, body } = await httpPost(
      `${instance.url}/openai/v1/chat/completions`,
      {
        model: "llama-3.3-70b-versatile",
        stream: true,
        messages: [{ role: "user", content: "stream-groq" }],
      },
      { Authorization: "Bearer mock-groq-key" },
    );

    expect(status).toBe(200);

    // Parse SSE events
    const events: unknown[] = [];
    for (const line of body.split("\n")) {
      if (line.startsWith("data: ") && line !== "data: [DONE]") {
        events.push(JSON.parse(line.slice(6)));
      }
    }

    expect(events.length).toBeGreaterThanOrEqual(3);

    // All chunks should have chat.completion.chunk object type
    for (const event of events) {
      const ev = event as { object: string };
      expect(ev.object).toBe("chat.completion.chunk");
    }

    // Content should be present across the chunks
    const contentParts = events
      .map((e) => (e as { choices: [{ delta: { content?: string } }] }).choices[0].delta.content)
      .filter(Boolean);
    expect(contentParts.join("")).toBe("Groq streamed!");

    // Body ends with [DONE]
    expect(body).toContain("data: [DONE]");
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
    expect(parsed.choices[0].message.content).toBe("Hello from aimock!");
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
    expect(parsed.choices[0].message.content).toBe("Hello from aimock!");
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
    expect(parsed.choices[0].message.content).toBe("Hello from aimock!");
  });
});

describe("OpenAI-compatible path prefix normalization", () => {
  it("normalizes /v4/chat/completions to /v1/chat/completions", async () => {
    instance = await createServer(CATCH_ALL_FIXTURES);

    const { status, body } = await httpPost(`${instance.url}/v4/chat/completions`, {
      model: "bigmodel-4",
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    });

    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed.choices).toBeDefined();
    expect(parsed.choices[0].message.content).toBe("Hello from aimock!");
    expect(parsed.object).toBe("chat.completion");
  });

  it("normalizes /api/coding/paas/v4/chat/completions to /v1/chat/completions", async () => {
    instance = await createServer(CATCH_ALL_FIXTURES);

    const { status, body } = await httpPost(`${instance.url}/api/coding/paas/v4/chat/completions`, {
      model: "bigmodel-4",
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    });

    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed.choices).toBeDefined();
    expect(parsed.choices[0].message.content).toBe("Hello from aimock!");
    expect(parsed.object).toBe("chat.completion");
  });

  it("still handles standard /v1/chat/completions (regression)", async () => {
    instance = await createServer(CATCH_ALL_FIXTURES);

    const { status, body } = await httpPost(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4o",
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    });

    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed.choices).toBeDefined();
    expect(parsed.choices[0].message.content).toBe("Hello from aimock!");
    expect(parsed.object).toBe("chat.completion");
  });

  it("normalizes /custom/embeddings to /v1/embeddings", async () => {
    instance = await createServer(CATCH_ALL_FIXTURES);

    const { status, body } = await httpPost(`${instance.url}/custom/embeddings`, {
      model: "text-embedding-3-small",
      input: "test embedding via custom prefix",
    });

    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed.object).toBe("list");
    expect(parsed.data[0].embedding).toBeInstanceOf(Array);
  });

  it("combines /openai/ prefix strip with normalization for non-v1 paths", async () => {
    instance = await createServer(CATCH_ALL_FIXTURES);

    // /openai/v4/chat/completions — strip /openai/ then normalize /v4/ to /v1/
    const { status, body } = await httpPost(
      `${instance.url}/openai/v4/chat/completions`,
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
    expect(parsed.choices[0].message.content).toBe("Hello from aimock!");
  });

  it("normalizes /custom/responses to /v1/responses", async () => {
    instance = await createServer(CATCH_ALL_FIXTURES);

    const { body } = await httpPost(`${instance.url}/custom/responses`, {
      model: "gpt-4o",
      input: "hello",
      stream: false,
    });

    // Normalization works: the Responses handler receives the request,
    // correctly parses the string input, matches the fixture, and returns
    // a valid Responses API envelope.
    const parsed = JSON.parse(body);
    expect(parsed.object).toBe("response");
    expect(parsed.output).toBeDefined();
    expect(parsed.output.length).toBeGreaterThan(0);
  });

  it("normalizes /custom/audio/speech to /v1/audio/speech", async () => {
    instance = await createServer(CATCH_ALL_FIXTURES);

    const { body } = await httpPost(`${instance.url}/custom/audio/speech`, {
      model: "tts-1",
      input: "test speech",
      voice: "alloy",
    });

    // Normalization works: handler reached (not "Not found")
    const parsed = JSON.parse(body);
    expect(parsed.error.type).toBe("invalid_request_error");
  });

  it("normalizes /custom/audio/transcriptions to /v1/audio/transcriptions", async () => {
    instance = await createServer(CATCH_ALL_FIXTURES);

    const { body } = await httpPost(`${instance.url}/custom/audio/transcriptions`, {
      model: "whisper-1",
      file: "test",
    });

    // Normalization works: handler reached (not "Not found")
    const parsed = JSON.parse(body);
    expect(parsed.error.type).toBe("invalid_request_error");
  });

  it("normalizes /custom/images/generations to /v1/images/generations", async () => {
    instance = await createServer(CATCH_ALL_FIXTURES);

    const { body } = await httpPost(`${instance.url}/custom/images/generations`, {
      model: "dall-e-3",
      prompt: "test",
    });

    // Normalization works: handler reached (not "Not found")
    const parsed = JSON.parse(body);
    expect(parsed.error.type).toBe("invalid_request_error");
  });

  it("does NOT normalize /v2/chat/completions (/v2/ guard for Cohere convention)", async () => {
    instance = await createServer(CATCH_ALL_FIXTURES);

    const { status } = await httpPost(`${instance.url}/v2/chat/completions`, {
      model: "command-r-plus",
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    });

    // /v2/chat/completions should NOT be rewritten to /v1/chat/completions
    // — the /v2/ guard prevents normalization, so this falls through to 404
    expect(status).toBe(404);
  });

  it("routes /v2/chat to Cohere handler (not normalization concern)", async () => {
    instance = await createServer(CATCH_ALL_FIXTURES);

    // /v2/chat is Cohere's endpoint — reaches the Cohere handler directly
    const { status } = await httpPost(`${instance.url}/v2/chat`, {
      model: "command-r-plus",
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    });

    expect(status).toBe(200);
  });

  it("returns 404 for unrecognized paths that don't match any suffix", async () => {
    instance = await createServer(CATCH_ALL_FIXTURES);

    const { status } = await httpPost(`${instance.url}/custom/foo/bar`, {
      model: "test",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(status).toBe(404);
  });
});

describe("WebSocket path normalization", () => {
  /**
   * Send an HTTP upgrade request and return the resulting status code.
   * 101 = upgrade succeeded (WebSocket), anything else = rejected.
   */
  function wsUpgrade(url: string, path: string): Promise<{ statusCode: number }> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const req = http.request({
        hostname: parsed.hostname,
        port: parsed.port,
        path,
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Key": Buffer.from(crypto.randomBytes(16)).toString("base64"),
          "Sec-WebSocket-Version": "13",
        },
      });
      req.on("upgrade", (_res, socket) => {
        socket.destroy();
        resolve({ statusCode: 101 });
      });
      req.on("response", (res) => {
        resolve({ statusCode: res.statusCode ?? 0 });
      });
      req.on("error", reject);
      req.end();
    });
  }

  it("WS upgrade to /custom/responses normalizes to /v1/responses", async () => {
    instance = await createServer(CATCH_ALL_FIXTURES);
    const { statusCode } = await wsUpgrade(instance.url, "/custom/responses");
    expect(statusCode).toBe(101);
  });

  it("WS upgrade to /openai/v1/responses works (/openai/ strip)", async () => {
    instance = await createServer(CATCH_ALL_FIXTURES);
    const { statusCode } = await wsUpgrade(instance.url, "/openai/v1/responses");
    expect(statusCode).toBe(101);
  });

  it("WS upgrade to /v2/responses is NOT normalized (returns 404)", async () => {
    instance = await createServer(CATCH_ALL_FIXTURES);
    const { statusCode } = await wsUpgrade(instance.url, "/v2/responses");
    expect(statusCode).toBe(404);
  });

  it("WS upgrade to Azure deployment path is NOT normalized", async () => {
    instance = await createServer(CATCH_ALL_FIXTURES);

    // Azure deployment WebSocket path should NOT have /openai/ stripped
    // or be normalized — it should 404 cleanly (Azure WS not supported)
    const { statusCode } = await wsUpgrade(
      instance.url,
      "/openai/deployments/gpt-4o/chat/completions",
    );

    // Not upgraded (Azure deployment paths don't support WS)
    expect(statusCode).toBe(404);
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
    expect(parsed.choices[0].message.content).toBe("Hello from aimock!");
  });
});
