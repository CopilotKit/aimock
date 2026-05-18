import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { createServer, type ServerInstance } from "../server.js";
import {
  estimateTokens,
  estimatePromptTokens,
  buildTextCompletion,
  buildToolCallCompletion,
  buildContentWithToolCallsCompletion,
} from "../helpers.js";
import type { Fixture, ChatMessage } from "../types.js";

// ---------------------------------------------------------------------------
// Unit tests for estimateTokens
// ---------------------------------------------------------------------------

describe("estimateTokens", () => {
  it("returns 1 for very short text", () => {
    expect(estimateTokens("hi")).toBe(1);
  });

  it("returns ceil(length/4) for longer text", () => {
    // 20 chars → 5 tokens
    expect(estimateTokens("12345678901234567890")).toBe(5);
  });

  it("returns at least 1 for empty string", () => {
    // empty string length is 0, ceil(0/4) = 0, but max(1, 0) = 1
    expect(estimateTokens("")).toBe(1);
  });

  it("is roughly proportional to content length", () => {
    const short = estimateTokens("Hello");
    const long = estimateTokens("Hello".repeat(10));
    expect(long).toBeGreaterThan(short);
    // 50 chars / 4 = 12.5 → 13 vs 5 chars / 4 = 1.25 → 2
    expect(long / short).toBeGreaterThanOrEqual(5);
  });
});

describe("estimatePromptTokens", () => {
  it("estimates from message content strings", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "Hello world" }];
    const tokens = estimatePromptTokens(messages);
    // "Hello world" = 11 chars + "user" = 4 chars = 15 → ceil(15/4) = 4
    expect(tokens).toBeGreaterThan(0);
  });

  it("handles content part arrays", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Describe this" }, { type: "image_url" }],
      },
    ];
    const tokens = estimatePromptTokens(messages);
    expect(tokens).toBeGreaterThan(0);
  });

  it("handles null content gracefully", () => {
    const messages: ChatMessage[] = [{ role: "assistant", content: null }];
    const tokens = estimatePromptTokens(messages);
    // Only role "assistant" (9 chars) → ceil(9/4) = 3
    expect(tokens).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Non-streaming completion builders with estimation
// ---------------------------------------------------------------------------

describe("buildTextCompletion token estimation", () => {
  it("estimates non-zero tokens when no explicit usage", () => {
    const result = buildTextCompletion(
      "This is a response with some content.",
      "gpt-4",
      undefined,
      undefined,
      [{ role: "user", content: "What is the weather?" }],
    );
    expect(result.usage.prompt_tokens).toBeGreaterThan(0);
    expect(result.usage.completion_tokens).toBeGreaterThan(0);
    expect(result.usage.total_tokens).toBe(
      result.usage.prompt_tokens + result.usage.completion_tokens,
    );
  });

  it("uses explicit fixture usage when provided", () => {
    const result = buildTextCompletion(
      "Hello!",
      "gpt-4",
      undefined,
      {
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150,
        },
      },
      [{ role: "user", content: "hello" }],
    );
    expect(result.usage).toEqual({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
    });
  });

  it("auto-computes total when only prompt+completion given", () => {
    const result = buildTextCompletion("Hi!", "gpt-4", undefined, {
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    expect(result.usage.total_tokens).toBe(15);
  });

  it("estimated tokens are proportional to content length", () => {
    const short = buildTextCompletion("Hi", "gpt-4");
    const long = buildTextCompletion(
      "This is a much longer response with many more characters.",
      "gpt-4",
    );
    expect(long.usage.completion_tokens).toBeGreaterThan(short.usage.completion_tokens);
  });
});

describe("buildToolCallCompletion token estimation", () => {
  it("estimates non-zero tokens for tool calls", () => {
    const result = buildToolCallCompletion(
      [{ name: "get_weather", arguments: '{"city":"New York"}' }],
      "gpt-4",
      undefined,
      [{ role: "user", content: "What is the weather in NYC?" }],
    );
    expect(result.usage.prompt_tokens).toBeGreaterThan(0);
    expect(result.usage.completion_tokens).toBeGreaterThan(0);
    expect(result.usage.total_tokens).toBe(
      result.usage.prompt_tokens + result.usage.completion_tokens,
    );
  });

  it("uses explicit usage when provided", () => {
    const result = buildToolCallCompletion(
      [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
      "gpt-4",
      { usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } },
    );
    expect(result.usage).toEqual({
      prompt_tokens: 20,
      completion_tokens: 10,
      total_tokens: 30,
    });
  });
});

describe("buildContentWithToolCallsCompletion token estimation", () => {
  it("estimates non-zero tokens for content+toolCalls", () => {
    const result = buildContentWithToolCallsCompletion(
      "Let me search for that.",
      [{ name: "search", arguments: '{"query":"test"}' }],
      "gpt-4",
      undefined,
      undefined,
      [{ role: "user", content: "Find me some info" }],
    );
    expect(result.usage.prompt_tokens).toBeGreaterThan(0);
    expect(result.usage.completion_tokens).toBeGreaterThan(0);
    expect(result.usage.total_tokens).toBe(
      result.usage.prompt_tokens + result.usage.completion_tokens,
    );
  });

  it("uses explicit usage when provided", () => {
    const result = buildContentWithToolCallsCompletion(
      "Ok.",
      [{ name: "fn", arguments: "{}" }],
      "gpt-4",
      undefined,
      { usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } },
    );
    expect(result.usage).toEqual({
      prompt_tokens: 5,
      completion_tokens: 3,
      total_tokens: 8,
    });
  });
});

// ---------------------------------------------------------------------------
// Integration: non-streaming responses via server
// ---------------------------------------------------------------------------

let instance: ServerInstance | null = null;

afterEach(async () => {
  if (instance) {
    await new Promise<void>((resolve) => instance!.server.close(() => resolve()));
    instance = null;
  }
});

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

describe("server: automatic token estimation in non-streaming responses", () => {
  it("returns non-zero usage without explicit fixture usage", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: { content: "Hello! How can I help you today?" },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    });
    const json = JSON.parse(res.body);
    expect(json.usage.prompt_tokens).toBeGreaterThan(0);
    expect(json.usage.completion_tokens).toBeGreaterThan(0);
    expect(json.usage.total_tokens).toBe(json.usage.prompt_tokens + json.usage.completion_tokens);
  });

  it("respects explicit fixture usage overrides", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "precise" },
        response: {
          content: "Ok!",
          usage: {
            prompt_tokens: 100,
            completion_tokens: 50,
            total_tokens: 150,
          },
        },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      stream: false,
      messages: [{ role: "user", content: "precise" }],
    });
    const json = JSON.parse(res.body);
    expect(json.usage).toEqual({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
    });
  });

  it("longer responses produce more completion tokens", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "short" },
        response: { content: "Hi" },
      },
      {
        match: { userMessage: "long" },
        response: {
          content:
            "This is a much longer response that contains many more characters and therefore should produce more estimated tokens.",
        },
      },
    ];
    instance = await createServer(fixtures);

    const shortRes = await httpPost(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      stream: false,
      messages: [{ role: "user", content: "short" }],
    });
    const longRes = await httpPost(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      stream: false,
      messages: [{ role: "user", content: "long" }],
    });

    const shortJson = JSON.parse(shortRes.body);
    const longJson = JSON.parse(longRes.body);
    expect(longJson.usage.completion_tokens).toBeGreaterThan(shortJson.usage.completion_tokens);
  });
});
