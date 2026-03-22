import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import type { Fixture } from "../types.js";
import { createServer, type ServerInstance } from "../server.js";
import { bedrockToCompletionRequest } from "../bedrock.js";

// --- helpers ---

function post(
  url: string,
  body: unknown,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          });
        });
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function postRaw(url: string, raw: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(raw),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
          });
        });
      },
    );
    req.on("error", reject);
    req.write(raw);
    req.end();
  });
}

// --- fixtures ---

const textFixture: Fixture = {
  match: { userMessage: "hello" },
  response: { content: "Hi there!" },
};

const modelFixture: Fixture = {
  match: { model: "anthropic.claude-3-5-sonnet-20241022-v2:0", userMessage: "greet" },
  response: { content: "Hello from Bedrock!" },
};

const toolFixture: Fixture = {
  match: { userMessage: "weather" },
  response: {
    toolCalls: [
      {
        name: "get_weather",
        arguments: '{"city":"SF"}',
      },
    ],
  },
};

const errorFixture: Fixture = {
  match: { userMessage: "fail" },
  response: {
    error: {
      message: "Rate limited",
      type: "rate_limit_error",
    },
    status: 429,
  },
};

const allFixtures: Fixture[] = [textFixture, modelFixture, toolFixture, errorFixture];

// --- tests ---

let instance: ServerInstance | null = null;

afterEach(async () => {
  if (instance) {
    await new Promise<void>((resolve) => {
      instance!.server.close(() => resolve());
    });
    instance = null;
  }
});

describe("POST /model/{modelId}/invoke (text response)", () => {
  it("returns text response in Anthropic Messages format", async () => {
    instance = await createServer(allFixtures);
    const res = await post(
      `${instance.url}/model/anthropic.claude-3-5-sonnet-20241022-v2:0/invoke`,
      {
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 512,
        messages: [{ role: "user", content: "hello" }],
      },
    );

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");

    const body = JSON.parse(res.body);
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(body.id).toMatch(/^msg_/);
    expect(body.content).toHaveLength(1);
    expect(body.content[0].type).toBe("text");
    expect(body.content[0].text).toBe("Hi there!");
    expect(body.stop_reason).toBe("end_turn");
    expect(body.stop_sequence).toBeNull();
    expect(body.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });
});

describe("POST /model/{modelId}/invoke (tool call response)", () => {
  it("returns tool call response in Anthropic Messages format", async () => {
    instance = await createServer(allFixtures);
    const res = await post(
      `${instance.url}/model/anthropic.claude-3-5-sonnet-20241022-v2:0/invoke`,
      {
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 512,
        messages: [{ role: "user", content: "weather" }],
      },
    );

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.type).toBe("message");
    expect(body.stop_reason).toBe("tool_use");
    expect(body.content).toHaveLength(1);
    expect(body.content[0].type).toBe("tool_use");
    expect(body.content[0].name).toBe("get_weather");
    expect(body.content[0].input).toEqual({ city: "SF" });
    expect(body.content[0].id).toBeDefined();
  });
});

describe("POST /model/{modelId}/invoke (error handling)", () => {
  it("returns error fixture with correct status", async () => {
    instance = await createServer(allFixtures);
    const res = await post(
      `${instance.url}/model/anthropic.claude-3-5-sonnet-20241022-v2:0/invoke`,
      {
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 512,
        messages: [{ role: "user", content: "fail" }],
      },
    );

    expect(res.status).toBe(429);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("Rate limited");
  });

  it("returns error in Anthropic format: { type: 'error', error: { type, message } }", async () => {
    instance = await createServer(allFixtures);
    const res = await post(
      `${instance.url}/model/anthropic.claude-3-5-sonnet-20241022-v2:0/invoke`,
      {
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 512,
        messages: [{ role: "user", content: "fail" }],
      },
    );

    expect(res.status).toBe(429);
    const body = JSON.parse(res.body);
    // Bedrock uses Anthropic Messages format for errors
    expect(body.type).toBe("error");
    expect(body.error).toBeDefined();
    expect(body.error.type).toBe("rate_limit_error");
    expect(body.error.message).toBe("Rate limited");
    // Should NOT have OpenAI-style fields
    expect(body.status).toBeUndefined();
    expect(body.error.code).toBeUndefined();
  });

  it("returns 404 when no fixture matches", async () => {
    instance = await createServer(allFixtures);
    const res = await post(
      `${instance.url}/model/anthropic.claude-3-5-sonnet-20241022-v2:0/invoke`,
      {
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 512,
        messages: [{ role: "user", content: "nomatch" }],
      },
    );

    expect(res.status).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("No fixture matched");
  });

  it("returns 400 for malformed JSON", async () => {
    instance = await createServer(allFixtures);
    const res = await postRaw(
      `${instance.url}/model/anthropic.claude-3-5-sonnet-20241022-v2:0/invoke`,
      "{not valid",
    );

    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("Malformed JSON");
  });
});

describe("POST /model/{modelId}/invoke (model matching)", () => {
  it("uses modelId from URL for fixture matching", async () => {
    instance = await createServer(allFixtures);
    const res = await post(
      `${instance.url}/model/anthropic.claude-3-5-sonnet-20241022-v2:0/invoke`,
      {
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 512,
        messages: [{ role: "user", content: "greet" }],
      },
    );

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.content[0].text).toBe("Hello from Bedrock!");
    expect(body.model).toBe("anthropic.claude-3-5-sonnet-20241022-v2:0");
  });
});

describe("POST /model/{modelId}/invoke (journal)", () => {
  it("records the request in the journal", async () => {
    instance = await createServer(allFixtures);
    await post(`${instance.url}/model/anthropic.claude-3-5-sonnet-20241022-v2:0/invoke`, {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 512,
      messages: [{ role: "user", content: "hello" }],
    });

    expect(instance.journal.size).toBe(1);
    const entry = instance.journal.getLast();
    expect(entry!.path).toBe("/model/anthropic.claude-3-5-sonnet-20241022-v2:0/invoke");
    expect(entry!.response.status).toBe(200);
    expect(entry!.response.fixture).toBe(textFixture);
    expect(entry!.body.model).toBe("anthropic.claude-3-5-sonnet-20241022-v2:0");
  });
});

describe("POST /model/{modelId}/invoke (anthropic_version)", () => {
  it("accepts anthropic_version field without error", async () => {
    instance = await createServer(allFixtures);
    const res = await post(
      `${instance.url}/model/anthropic.claude-3-5-sonnet-20241022-v2:0/invoke`,
      {
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 512,
        messages: [{ role: "user", content: "hello" }],
      },
    );

    expect(res.status).toBe(200);
  });

  it("works without anthropic_version field", async () => {
    instance = await createServer(allFixtures);
    const res = await post(
      `${instance.url}/model/anthropic.claude-3-5-sonnet-20241022-v2:0/invoke`,
      {
        max_tokens: 512,
        messages: [{ role: "user", content: "hello" }],
      },
    );

    expect(res.status).toBe(200);
  });
});

describe("POST /model/{modelId}/invoke (CORS)", () => {
  it("includes CORS headers", async () => {
    instance = await createServer(allFixtures);
    const res = await post(
      `${instance.url}/model/anthropic.claude-3-5-sonnet-20241022-v2:0/invoke`,
      {
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 512,
        messages: [{ role: "user", content: "hello" }],
      },
    );

    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });
});

describe("POST /model/{modelId}/invoke (structural validation)", () => {
  it("returns 400 when messages array is missing", async () => {
    instance = await createServer(allFixtures);
    const res = await post(
      `${instance.url}/model/anthropic.claude-3-5-sonnet-20241022-v2:0/invoke`,
      {
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 512,
      },
    );

    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("Invalid request: messages array is required");
  });

  it("returns 400 when messages is not an array", async () => {
    instance = await createServer(allFixtures);
    const res = await post(
      `${instance.url}/model/anthropic.claude-3-5-sonnet-20241022-v2:0/invoke`,
      {
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 512,
        messages: "not-an-array",
      },
    );

    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("Invalid request: messages array is required");
  });
});

// ---------------------------------------------------------------------------
// bedrockToCompletionRequest unit tests
// ---------------------------------------------------------------------------

describe("bedrockToCompletionRequest", () => {
  it("converts system message (string form)", () => {
    const result = bedrockToCompletionRequest(
      {
        messages: [{ role: "user", content: "hi" }],
        system: "You are a helpful assistant.",
        max_tokens: 100,
      },
      "anthropic.claude-3-5-sonnet",
    );

    expect(result.messages[0]).toEqual({
      role: "system",
      content: "You are a helpful assistant.",
    });
    expect(result.messages[1]).toEqual({ role: "user", content: "hi" });
  });

  it("converts system message (content-block array form)", () => {
    const result = bedrockToCompletionRequest(
      {
        messages: [{ role: "user", content: "hi" }],
        system: [
          { type: "text", text: "You are " },
          { type: "text", text: "a helpful assistant." },
        ],
        max_tokens: 100,
      },
      "anthropic.claude-3-5-sonnet",
    );

    expect(result.messages[0]).toEqual({
      role: "system",
      content: "You are a helpful assistant.",
    });
  });

  it("converts multi-turn conversation with tool_result blocks in user messages", () => {
    const result = bedrockToCompletionRequest(
      {
        messages: [
          { role: "user", content: "What is the weather?" },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_123",
                name: "get_weather",
                input: { city: "SF" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_123",
                content: "72°F and sunny",
              },
              {
                type: "text",
                text: "Tell me more",
              },
            ],
          },
        ],
        max_tokens: 100,
      },
      "anthropic.claude-3-5-sonnet",
    );

    expect(result.messages).toHaveLength(4);
    expect(result.messages[0]).toEqual({ role: "user", content: "What is the weather?" });
    expect(result.messages[1]).toMatchObject({
      role: "assistant",
      tool_calls: [
        {
          id: "toolu_123",
          type: "function",
          function: { name: "get_weather", arguments: '{"city":"SF"}' },
        },
      ],
    });
    expect(result.messages[2]).toEqual({
      role: "tool",
      content: "72°F and sunny",
      tool_call_id: "toolu_123",
    });
    expect(result.messages[3]).toEqual({ role: "user", content: "Tell me more" });
  });

  it("converts assistant messages with tool_use blocks", () => {
    const result = bedrockToCompletionRequest(
      {
        messages: [
          { role: "user", content: "search for cats" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "Let me search." },
              {
                type: "tool_use",
                id: "toolu_456",
                name: "search",
                input: { query: "cats" },
              },
            ],
          },
        ],
        max_tokens: 100,
      },
      "anthropic.claude-3-5-sonnet",
    );

    expect(result.messages[1]).toMatchObject({
      role: "assistant",
      content: "Let me search.",
      tool_calls: [
        {
          id: "toolu_456",
          type: "function",
          function: { name: "search", arguments: '{"query":"cats"}' },
        },
      ],
    });
  });

  it("passes through tool definitions", () => {
    const result = bedrockToCompletionRequest(
      {
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            name: "get_weather",
            description: "Get weather for a city",
            input_schema: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        ],
        max_tokens: 100,
      },
      "anthropic.claude-3-5-sonnet",
    );

    expect(result.tools).toHaveLength(1);
    expect(result.tools![0]).toEqual({
      type: "function",
      function: {
        name: "get_weather",
        description: "Get weather for a city",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    });
  });
});

// ---------------------------------------------------------------------------
// strict:true returns 503 for unmatched Bedrock request
// ---------------------------------------------------------------------------

describe("POST /model/{modelId}/invoke (strict mode)", () => {
  it("returns 503 with strict message when no fixture matches in strict mode", async () => {
    instance = await createServer(allFixtures, { strict: true });
    const res = await post(
      `${instance.url}/model/anthropic.claude-3-5-sonnet-20241022-v2:0/invoke`,
      {
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 512,
        messages: [{ role: "user", content: "nomatch" }],
      },
    );

    expect(res.status).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("Strict mode: no fixture matched");
  });

  it("returns 200 when fixture matches even in strict mode", async () => {
    instance = await createServer(allFixtures, { strict: true });
    const res = await post(
      `${instance.url}/model/anthropic.claude-3-5-sonnet-20241022-v2:0/invoke`,
      {
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 512,
        messages: [{ role: "user", content: "hello" }],
      },
    );

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.content[0].text).toBe("Hi there!");
  });
});
