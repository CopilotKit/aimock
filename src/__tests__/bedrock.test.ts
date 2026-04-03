import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import type { Fixture, HandlerDefaults } from "../types.js";
import { createServer, type ServerInstance } from "../server.js";
import { bedrockToCompletionRequest, handleBedrock, handleBedrockStream } from "../bedrock.js";
import { Journal } from "../journal.js";
import { Logger } from "../logger.js";

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
// bedrockToCompletionRequest: edge case branches
// ---------------------------------------------------------------------------

describe("bedrockToCompletionRequest (edge cases)", () => {
  it("handles system content blocks with missing text (text ?? '' fallback)", () => {
    const result = bedrockToCompletionRequest(
      {
        messages: [{ role: "user", content: "hi" }],
        system: [{ type: "text" }, { type: "text", text: "Hello" }] as unknown[],
        max_tokens: 100,
      } as unknown as Parameters<typeof bedrockToCompletionRequest>[0],
      "model",
    );
    // First block has undefined text → falls back to ""
    expect(result.messages[0]).toEqual({ role: "system", content: "Hello" });
  });

  it("handles empty system text (no system message pushed)", () => {
    const result = bedrockToCompletionRequest(
      {
        messages: [{ role: "user", content: "hi" }],
        system: [{ type: "text" }] as unknown[],
        max_tokens: 100,
      } as unknown as Parameters<typeof bedrockToCompletionRequest>[0],
      "model",
    );
    // Empty systemText → no system message
    expect(result.messages[0]).toEqual({ role: "user", content: "hi" });
  });

  it("handles tool_result content as array of content blocks", () => {
    const result = bedrockToCompletionRequest(
      {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_123",
                content: [
                  { type: "text", text: "Part 1" },
                  { type: "text", text: " Part 2" },
                ],
              },
            ],
          },
        ],
        max_tokens: 100,
      },
      "model",
    );
    expect(result.messages[0]).toEqual({
      role: "tool",
      content: "Part 1 Part 2",
      tool_call_id: "toolu_123",
    });
  });

  it("handles tool_result with non-string non-array content (fallback to '')", () => {
    const result = bedrockToCompletionRequest(
      {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_789",
                content: undefined,
              },
            ],
          },
        ],
        max_tokens: 100,
      } as unknown as Parameters<typeof bedrockToCompletionRequest>[0],
      "model",
    );
    expect(result.messages[0]).toEqual({
      role: "tool",
      content: "",
      tool_call_id: "toolu_789",
    });
  });

  it("handles assistant tool_use block with missing id (generates one)", () => {
    const result = bedrockToCompletionRequest(
      {
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                name: "search",
                input: { query: "test" },
              },
            ],
          },
        ],
        max_tokens: 100,
      },
      "model",
    );
    expect(result.messages[0].tool_calls![0].id).toMatch(/^toolu_/);
  });

  it("handles assistant tool_use block with missing name (falls back to '')", () => {
    const result = bedrockToCompletionRequest(
      {
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_123",
                input: { x: 1 },
              },
            ],
          },
        ],
        max_tokens: 100,
      },
      "model",
    );
    expect(result.messages[0].tool_calls![0].function.name).toBe("");
  });

  it("handles assistant tool_use with string input", () => {
    const result = bedrockToCompletionRequest(
      {
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_123",
                name: "fn",
                input: '{"key":"value"}',
              },
            ],
          },
        ],
        max_tokens: 100,
      },
      "model",
    );
    expect(result.messages[0].tool_calls![0].function.arguments).toBe('{"key":"value"}');
  });

  it("handles assistant tool_use with undefined input (falls back to {})", () => {
    const result = bedrockToCompletionRequest(
      {
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_123",
                name: "fn",
              },
            ],
          },
        ],
        max_tokens: 100,
      },
      "model",
    );
    expect(result.messages[0].tool_calls![0].function.arguments).toBe("{}");
  });

  it("handles assistant content that is neither string nor array (null branch)", () => {
    const result = bedrockToCompletionRequest(
      {
        messages: [
          {
            role: "assistant",
            content: 42,
          },
        ],
        max_tokens: 100,
      } as unknown as Parameters<typeof bedrockToCompletionRequest>[0],
      "model",
    );
    expect(result.messages[0]).toEqual({ role: "assistant", content: null });
  });

  it("handles assistant text-only content blocks (no tool_use, content or null)", () => {
    const result = bedrockToCompletionRequest(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Just text" }],
          },
        ],
        max_tokens: 100,
      },
      "model",
    );
    expect(result.messages[0]).toEqual({ role: "assistant", content: "Just text" });
  });

  it("handles assistant empty content blocks (content: null)", () => {
    const result = bedrockToCompletionRequest(
      {
        messages: [
          {
            role: "assistant",
            content: [],
          },
        ],
        max_tokens: 100,
      },
      "model",
    );
    // Empty array → no tool_use blocks, textContent is "" → null
    expect(result.messages[0]).toEqual({ role: "assistant", content: null });
  });

  it("handles user message with content blocks but no tool_results (text extraction)", () => {
    const result = bedrockToCompletionRequest(
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Hello " },
              { type: "text", text: "World" },
            ],
          },
        ],
        max_tokens: 100,
      },
      "model",
    );
    expect(result.messages[0]).toEqual({ role: "user", content: "Hello World" });
  });

  it("handles tool_result content blocks with missing text (text ?? '' fallback)", () => {
    const result = bedrockToCompletionRequest(
      {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_abc",
                content: [{ type: "text" }, { type: "image" }],
              },
            ],
          },
        ],
        max_tokens: 100,
      } as unknown as Parameters<typeof bedrockToCompletionRequest>[0],
      "model",
    );
    // First block has no text → "", second is image (filtered out)
    expect(result.messages[0].content).toBe("");
  });

  it("handles user message with text blocks alongside tool_results (text ?? '' fallback)", () => {
    const result = bedrockToCompletionRequest(
      {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_abc",
                content: "result",
              },
              {
                type: "text",
                // text field missing - uses ?? ""
              },
            ],
          },
        ],
        max_tokens: 100,
      } as unknown as Parameters<typeof bedrockToCompletionRequest>[0],
      "model",
    );
    // tool result + text block with missing text
    expect(result.messages).toHaveLength(2);
    expect(result.messages[1].content).toBe("");
  });

  it("omits system message when system field is absent", () => {
    const result = bedrockToCompletionRequest(
      {
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 100,
      },
      "model",
    );
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("user");
  });

  it("omits tools when tools array is empty", () => {
    const result = bedrockToCompletionRequest(
      {
        messages: [{ role: "user", content: "hi" }],
        tools: [],
        max_tokens: 100,
      },
      "model",
    );
    expect(result.tools).toBeUndefined();
  });

  it("sets stream to false", () => {
    const result = bedrockToCompletionRequest(
      {
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 100,
      },
      "model",
    );
    expect(result.stream).toBe(false);
  });

  it("passes through temperature", () => {
    const result = bedrockToCompletionRequest(
      {
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 100,
        temperature: 0.5,
      },
      "model",
    );
    expect(result.temperature).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// handleBedrock: invoke-level edge case branches
// ---------------------------------------------------------------------------

describe("POST /model/{modelId}/invoke (unknown response type)", () => {
  it("returns 500 for embedding fixture on invoke endpoint", async () => {
    const embeddingFixture: Fixture = {
      match: { userMessage: "embed-invoke" },
      response: { embedding: [0.1, 0.2, 0.3] },
    };
    instance = await createServer([embeddingFixture]);
    const res = await post(
      `${instance.url}/model/anthropic.claude-3-5-sonnet-20241022-v2:0/invoke`,
      {
        max_tokens: 512,
        messages: [{ role: "user", content: "embed-invoke" }],
      },
    );

    expect(res.status).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error.message).toContain("did not match any known type");
  });
});

describe("POST /model/{modelId}/invoke (error fixture no explicit status)", () => {
  it("defaults to 500 when error fixture has no status", async () => {
    const noStatusError: Fixture = {
      match: { userMessage: "err-no-status" },
      response: {
        error: {
          message: "Something went wrong",
          type: "server_error",
        },
      },
    };
    instance = await createServer([noStatusError]);
    const res = await post(
      `${instance.url}/model/anthropic.claude-3-5-sonnet-20241022-v2:0/invoke`,
      {
        max_tokens: 512,
        messages: [{ role: "user", content: "err-no-status" }],
      },
    );

    expect(res.status).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("Something went wrong");
  });
});

describe("POST /model/{modelId}/invoke (malformed tool call arguments)", () => {
  it("falls back to empty object for malformed JSON in non-streaming", async () => {
    const badArgsFixture: Fixture = {
      match: { userMessage: "bad-args" },
      response: {
        toolCalls: [{ name: "fn", arguments: "NOT VALID JSON" }],
      },
    };
    instance = await createServer([badArgsFixture]);
    const res = await post(
      `${instance.url}/model/anthropic.claude-3-5-sonnet-20241022-v2:0/invoke`,
      {
        max_tokens: 512,
        messages: [{ role: "user", content: "bad-args" }],
      },
    );

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.content[0].input).toEqual({});
  });
});

describe("POST /model/{modelId}/invoke (tool call with no id)", () => {
  it("generates tool use id when fixture provides none", async () => {
    const noIdFixture: Fixture = {
      match: { userMessage: "no-id-tool" },
      response: {
        toolCalls: [{ name: "fn", arguments: '{"x":1}' }],
      },
    };
    instance = await createServer([noIdFixture]);
    const res = await post(
      `${instance.url}/model/anthropic.claude-3-5-sonnet-20241022-v2:0/invoke`,
      {
        max_tokens: 512,
        messages: [{ role: "user", content: "no-id-tool" }],
      },
    );

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.content[0].id).toMatch(/^toolu_/);
  });
});

describe("POST /model/{modelId}/invoke (tool call with empty arguments)", () => {
  it("defaults to {} when arguments is empty string", async () => {
    const emptyArgsFixture: Fixture = {
      match: { userMessage: "empty-args" },
      response: {
        toolCalls: [{ name: "fn", arguments: "" }],
      },
    };
    instance = await createServer([emptyArgsFixture]);
    const res = await post(
      `${instance.url}/model/anthropic.claude-3-5-sonnet-20241022-v2:0/invoke`,
      {
        max_tokens: 512,
        messages: [{ role: "user", content: "empty-args" }],
      },
    );

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.content[0].input).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Direct handler tests for req.method/req.url fallback branches
// ---------------------------------------------------------------------------

function createMockReq(overrides: Partial<http.IncomingMessage> = {}): http.IncomingMessage {
  return {
    method: undefined,
    url: undefined,
    headers: {},
    ...overrides,
  } as unknown as http.IncomingMessage;
}

function createMockRes(): http.ServerResponse & {
  _written: string;
  _status: number;
  _headers: Record<string, string>;
} {
  const res = {
    _written: "",
    _status: 0,
    _headers: {} as Record<string, string>,
    writableEnded: false,
    statusCode: 0,
    writeHead(status: number, headers?: Record<string, string>) {
      res._status = status;
      res.statusCode = status;
      if (headers) Object.assign(res._headers, headers);
    },
    setHeader(name: string, value: string) {
      res._headers[name] = value;
    },
    write(data: string) {
      res._written += data;
      return true;
    },
    end(data?: string) {
      if (data) res._written += data;
      res.writableEnded = true;
    },
    destroy() {
      res.writableEnded = true;
    },
  };
  return res as unknown as http.ServerResponse & {
    _written: string;
    _status: number;
    _headers: Record<string, string>;
  };
}

function createDefaults(overrides: Partial<HandlerDefaults> = {}): HandlerDefaults {
  return {
    latency: 0,
    chunkSize: 100,
    logger: new Logger("silent"),
    ...overrides,
  };
}

describe("handleBedrock (direct handler call, method/url fallbacks)", () => {
  it("uses fallback values when req.method and req.url are undefined", async () => {
    const fixture: Fixture = {
      match: { userMessage: "hi" },
      response: { content: "Hello" },
    };
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();
    const raw = JSON.stringify({
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 100,
    });

    await handleBedrock(req, res, raw, "model-id", [fixture], journal, createDefaults(), () => {});

    expect(res._status).toBe(200);
    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.path).toContain("/model/model-id/invoke");
  });

  it("uses fallback for malformed JSON with undefined method/url", async () => {
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();

    await handleBedrock(req, res, "{bad", "model-id", [], journal, createDefaults(), () => {});

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.response.status).toBe(400);
  });

  it("uses fallback for missing messages with undefined method/url", async () => {
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();

    await handleBedrock(
      req,
      res,
      JSON.stringify({}),
      "model-id",
      [],
      journal,
      createDefaults(),
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.response.status).toBe(400);
  });

  it("uses fallback for no fixture match with undefined method/url", async () => {
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();
    const raw = JSON.stringify({
      messages: [{ role: "user", content: "nomatch" }],
      max_tokens: 100,
    });

    await handleBedrock(req, res, raw, "model-id", [], journal, createDefaults(), () => {});

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.response.status).toBe(404);
  });

  it("uses fallback for strict mode with undefined method/url", async () => {
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();
    const raw = JSON.stringify({
      messages: [{ role: "user", content: "nomatch" }],
      max_tokens: 100,
    });

    await handleBedrock(
      req,
      res,
      raw,
      "model-id",
      [],
      journal,
      createDefaults({ strict: true }),
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.response.status).toBe(503);
  });

  it("uses fallback for error response with undefined method/url", async () => {
    const fixture: Fixture = {
      match: { userMessage: "err" },
      response: { error: { message: "fail", type: "err" }, status: 500 },
    };
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();
    const raw = JSON.stringify({
      messages: [{ role: "user", content: "err" }],
      max_tokens: 100,
    });

    await handleBedrock(req, res, raw, "model-id", [fixture], journal, createDefaults(), () => {});

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.response.status).toBe(500);
  });

  it("uses fallback for tool call response with undefined method/url", async () => {
    const fixture: Fixture = {
      match: { userMessage: "tool" },
      response: { toolCalls: [{ name: "fn", arguments: '{"x":1}' }] },
    };
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();
    const raw = JSON.stringify({
      messages: [{ role: "user", content: "tool" }],
      max_tokens: 100,
    });

    await handleBedrock(req, res, raw, "model-id", [fixture], journal, createDefaults(), () => {});

    expect(res._status).toBe(200);
    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
  });

  it("uses fallback for unknown response type with undefined method/url", async () => {
    const fixture: Fixture = {
      match: { userMessage: "embed" },
      response: { embedding: [0.1] },
    };
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();
    const raw = JSON.stringify({
      messages: [{ role: "user", content: "embed" }],
      max_tokens: 100,
    });

    await handleBedrock(req, res, raw, "model-id", [fixture], journal, createDefaults(), () => {});

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.response.status).toBe(500);
  });
});

describe("handleBedrockStream (direct handler call, method/url fallbacks)", () => {
  it("uses fallback values when req.method and req.url are undefined", async () => {
    const fixture: Fixture = {
      match: { userMessage: "hi" },
      response: { content: "Hello" },
    };
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();
    const raw = JSON.stringify({
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 100,
    });

    await handleBedrockStream(
      req,
      res,
      raw,
      "model-id",
      [fixture],
      journal,
      createDefaults(),
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.path).toContain("/model/model-id/invoke-with-response-stream");
  });

  it("uses fallback for malformed JSON in streaming", async () => {
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();

    await handleBedrockStream(
      req,
      res,
      "{bad",
      "model-id",
      [],
      journal,
      createDefaults(),
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.response.status).toBe(400);
  });

  it("uses fallback for missing messages in streaming", async () => {
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();

    await handleBedrockStream(
      req,
      res,
      JSON.stringify({}),
      "model-id",
      [],
      journal,
      createDefaults(),
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.response.status).toBe(400);
  });

  it("uses fallback for no fixture match in streaming", async () => {
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();
    const raw = JSON.stringify({
      messages: [{ role: "user", content: "nomatch" }],
      max_tokens: 100,
    });

    await handleBedrockStream(req, res, raw, "model-id", [], journal, createDefaults(), () => {});

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.response.status).toBe(404);
  });

  it("uses fallback for strict mode in streaming", async () => {
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();
    const raw = JSON.stringify({
      messages: [{ role: "user", content: "nomatch" }],
      max_tokens: 100,
    });

    await handleBedrockStream(
      req,
      res,
      raw,
      "model-id",
      [],
      journal,
      createDefaults({ strict: true }),
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.response.status).toBe(503);
  });

  it("uses fallback for error response in streaming", async () => {
    const fixture: Fixture = {
      match: { userMessage: "err" },
      response: { error: { message: "fail", type: "err" }, status: 500 },
    };
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();
    const raw = JSON.stringify({
      messages: [{ role: "user", content: "err" }],
      max_tokens: 100,
    });

    await handleBedrockStream(
      req,
      res,
      raw,
      "model-id",
      [fixture],
      journal,
      createDefaults(),
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.response.status).toBe(500);
  });

  it("uses fallback for tool call response in streaming", async () => {
    const fixture: Fixture = {
      match: { userMessage: "tool" },
      response: { toolCalls: [{ name: "fn", arguments: '{"x":1}' }] },
    };
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();
    const raw = JSON.stringify({
      messages: [{ role: "user", content: "tool" }],
      max_tokens: 100,
    });

    await handleBedrockStream(
      req,
      res,
      raw,
      "model-id",
      [fixture],
      journal,
      createDefaults(),
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.response.status).toBe(200);
  });

  it("uses fallback for unknown response type in streaming", async () => {
    const fixture: Fixture = {
      match: { userMessage: "embed" },
      response: { embedding: [0.1] },
    };
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();
    const raw = JSON.stringify({
      messages: [{ role: "user", content: "embed" }],
      max_tokens: 100,
    });

    await handleBedrockStream(
      req,
      res,
      raw,
      "model-id",
      [fixture],
      journal,
      createDefaults(),
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.response.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Error fixture with error.type ?? "api_error" fallback
// ---------------------------------------------------------------------------

describe("POST /model/{modelId}/invoke (error fixture no error type)", () => {
  it("defaults to 'api_error' when error.type is undefined", async () => {
    const noTypeError: Fixture = {
      match: { userMessage: "err-no-type" },
      response: {
        error: {
          message: "Something went wrong",
        },
      },
    };
    instance = await createServer([noTypeError]);
    const res = await post(
      `${instance.url}/model/anthropic.claude-3-5-sonnet-20241022-v2:0/invoke`,
      {
        max_tokens: 512,
        messages: [{ role: "user", content: "err-no-type" }],
      },
    );

    expect(res.status).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error.type).toBe("api_error");
    expect(body.error.message).toBe("Something went wrong");
  });
});

// ---------------------------------------------------------------------------
// buildBedrockStreamTextEvents / buildBedrockStreamToolCallEvents unit tests
// ---------------------------------------------------------------------------

import { buildBedrockStreamTextEvents, buildBedrockStreamToolCallEvents } from "../bedrock.js";
import { Logger } from "../logger.js";

describe("buildBedrockStreamTextEvents", () => {
  it("creates correct event sequence for empty content", () => {
    const events = buildBedrockStreamTextEvents("", 10);
    // Should have: messageStart, contentBlockStart, contentBlockStop, messageStop (no deltas)
    expect(events).toHaveLength(4);
    expect(events[0].eventType).toBe("messageStart");
    expect(events[1].eventType).toBe("contentBlockStart");
    expect(events[2].eventType).toBe("contentBlockStop");
    expect(events[3].eventType).toBe("messageStop");
  });

  it("chunks content according to chunkSize", () => {
    const events = buildBedrockStreamTextEvents("ABCDEF", 2);
    const deltas = events.filter((e) => e.eventType === "contentBlockDelta");
    expect(deltas).toHaveLength(3);
    expect((deltas[0].payload as { delta: { text: string } }).delta.text).toBe("AB");
    expect((deltas[1].payload as { delta: { text: string } }).delta.text).toBe("CD");
    expect((deltas[2].payload as { delta: { text: string } }).delta.text).toBe("EF");
  });
});

describe("buildBedrockStreamToolCallEvents", () => {
  const logger = new Logger("silent");

  it("falls back to '{}' for malformed JSON arguments", () => {
    const events = buildBedrockStreamToolCallEvents(
      [{ name: "fn", arguments: "NOT VALID" }],
      100,
      logger,
    );
    const deltas = events.filter((e) => e.eventType === "contentBlockDelta");
    const fullJson = deltas
      .map((e) => (e.payload as { delta: { inputJSON: string } }).delta.inputJSON)
      .join("");
    expect(fullJson).toBe("{}");
  });

  it("generates tool use id when not provided", () => {
    const events = buildBedrockStreamToolCallEvents(
      [{ name: "fn", arguments: '{"x":1}' }],
      100,
      logger,
    );
    const startEvent = events.find((e) => e.eventType === "contentBlockStart");
    const payload = startEvent!.payload as {
      start: { toolUse: { toolUseId: string } };
    };
    expect(payload.start.toolUse.toolUseId).toMatch(/^toolu_/);
  });

  it("uses provided tool id", () => {
    const events = buildBedrockStreamToolCallEvents(
      [{ name: "fn", arguments: '{"x":1}', id: "custom_id" }],
      100,
      logger,
    );
    const startEvent = events.find((e) => e.eventType === "contentBlockStart");
    const payload = startEvent!.payload as {
      start: { toolUse: { toolUseId: string } };
    };
    expect(payload.start.toolUse.toolUseId).toBe("custom_id");
  });

  it("uses '{}' when arguments is empty string", () => {
    const events = buildBedrockStreamToolCallEvents([{ name: "fn", arguments: "" }], 100, logger);
    const deltas = events.filter((e) => e.eventType === "contentBlockDelta");
    const fullJson = deltas
      .map((e) => (e.payload as { delta: { inputJSON: string } }).delta.inputJSON)
      .join("");
    expect(fullJson).toBe("{}");
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
