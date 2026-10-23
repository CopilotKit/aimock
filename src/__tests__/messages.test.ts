import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import Anthropic from "@anthropic-ai/sdk";
import { PassThrough } from "node:stream";
import type { Fixture } from "../types.js";
import { createServer, type ServerInstance } from "../server.js";
import { claudeToCompletionRequest, handleMessages } from "../messages.js";
import { Journal } from "../journal.js";
import { Logger } from "../logger.js";
import { SKIPPED_BY_STATE_RE } from "./helpers/strict-matchers.js";

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

interface SSEEvent {
  type: string;
  [key: string]: unknown;
}

function parseClaudeSSEEvents(body: string): SSEEvent[] {
  const events: SSEEvent[] = [];
  const lines = body.split("\n");
  for (const line of lines) {
    if (line.startsWith("data: ")) {
      events.push(JSON.parse(line.slice(6)) as SSEEvent);
    }
  }
  return events;
}

// --- fixtures ---

const textFixture: Fixture = {
  match: { userMessage: "hello" },
  response: { content: "Hi there!" },
};

const toolFixture: Fixture = {
  match: { userMessage: "weather" },
  response: {
    toolCalls: [
      {
        name: "get_weather",
        arguments: '{"city":"NYC"}',
      },
    ],
  },
};

const multiToolFixture: Fixture = {
  match: { userMessage: "multi-tool" },
  response: {
    toolCalls: [
      { name: "get_weather", arguments: '{"city":"NYC"}' },
      { name: "get_time", arguments: '{"tz":"EST"}' },
    ],
  },
};

const errorFixture: Fixture = {
  match: { userMessage: "fail" },
  response: {
    error: {
      message: "Rate limited",
      type: "rate_limit_error",
      code: "rate_limit",
    },
    status: 429,
  },
};

const badResponseFixture: Fixture = {
  match: { userMessage: "badtype" },
  response: { content: 42 } as unknown as Fixture["response"],
};

const allFixtures: Fixture[] = [
  textFixture,
  toolFixture,
  multiToolFixture,
  errorFixture,
  badResponseFixture,
];

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

// ─── Unit tests: input conversion ────────────────────────────────────────────

describe("claudeToCompletionRequest", () => {
  it("converts user message with string content", () => {
    const result = claudeToCompletionRequest({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hello" }],
    });
    expect(result.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(result.model).toBe("claude-3-5-sonnet-20241022");
  });

  it("converts user message with content blocks", () => {
    const result = claudeToCompletionRequest({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hello " },
            { type: "text", text: "world" },
          ],
        },
      ],
    });
    expect(result.messages).toEqual([{ role: "user", content: "hello world" }]);
  });

  it("converts system string to system message", () => {
    const result = claudeToCompletionRequest({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      system: "Be helpful",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.messages).toEqual([
      { role: "system", content: "Be helpful" },
      { role: "user", content: "hi" },
    ]);
  });

  it("converts system content blocks to system message", () => {
    const result = claudeToCompletionRequest({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      system: [{ type: "text", text: "System prompt" }],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.messages).toEqual([
      { role: "system", content: "System prompt" },
      { role: "user", content: "hi" },
    ]);
  });

  it("converts assistant message with string content", () => {
    const result = claudeToCompletionRequest({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
    });
    expect(result.messages[1]).toEqual({ role: "assistant", content: "hello" });
  });

  it("handles assistant message with null content", () => {
    const result = claudeToCompletionRequest({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [
        {
          role: "assistant",
          content: null as unknown as string,
        },
      ],
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("assistant");
    expect(result.messages[0].content).toBeNull();
  });

  it("converts assistant tool_use blocks to tool_calls", () => {
    const result = claudeToCompletionRequest({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_123",
              name: "get_weather",
              input: { city: "NYC" },
            },
          ],
        },
      ],
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("assistant");
    expect(result.messages[0].content).toBeNull();
    expect(result.messages[0].tool_calls).toHaveLength(1);
    expect(result.messages[0].tool_calls![0].id).toBe("toolu_123");
    expect(result.messages[0].tool_calls![0].function.name).toBe("get_weather");
    expect(result.messages[0].tool_calls![0].function.arguments).toBe('{"city":"NYC"}');
  });

  it("converts tool_result blocks to tool messages", () => {
    const result = claudeToCompletionRequest({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_123",
              content: '{"temp":72}',
            },
          ],
        },
      ],
    });
    expect(result.messages).toEqual([
      { role: "tool", content: '{"temp":72}', tool_call_id: "toolu_123" },
    ]);
  });

  it("converts tool_result with nested text content blocks", () => {
    const result = claudeToCompletionRequest({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_456",
              content: [{ type: "text", text: "result data" }],
            },
          ],
        },
      ],
    });
    expect(result.messages).toEqual([
      { role: "tool", content: "result data", tool_call_id: "toolu_456" },
    ]);
  });

  it("converts tools with input_schema to ToolDefinition", () => {
    const result = claudeToCompletionRequest({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          name: "get_weather",
          description: "Get weather info",
          input_schema: { type: "object", properties: { city: { type: "string" } } },
        },
      ],
    });
    expect(result.tools).toEqual([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather info",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
          },
        },
      },
    ]);
  });

  it("returns undefined tools when none provided", () => {
    const result = claudeToCompletionRequest({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.tools).toBeUndefined();
  });
});

// ─── Integration tests: POST /v1/messages ───────────────────────────────────

describe("POST /v1/messages (streaming)", () => {
  it("streams text response with correct event types", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream");

    const events = parseClaudeSSEEvents(res.body);
    const types = events.map((e) => e.type);

    expect(types[0]).toBe("message_start");
    expect(types).toContain("content_block_start");
    expect(types).toContain("content_block_delta");
    expect(types).toContain("content_block_stop");
    expect(types).toContain("message_delta");
    expect(types[types.length - 1]).toBe("message_stop");

    // No [DONE] sentinel
    expect(res.body).not.toContain("[DONE]");
  });

  it("message_start contains msg_ prefixed id", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    });

    const events = parseClaudeSSEEvents(res.body);
    const msgStart = events.find((e) => e.type === "message_start") as SSEEvent & {
      message: { id: string; role: string; model: string };
    };
    expect(msgStart).toBeDefined();
    expect(msgStart.message.id).toMatch(/^msg_/);
    expect(msgStart.message.role).toBe("assistant");
    expect(msgStart.message.model).toBe("claude-3-5-sonnet-20241022");
  });

  it("text deltas reconstruct full content", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    });

    const events = parseClaudeSSEEvents(res.body);
    const deltas = events.filter((e) => e.type === "content_block_delta") as (SSEEvent & {
      delta: { type: string; text: string };
    })[];
    const fullText = deltas.map((d) => d.delta.text).join("");
    expect(fullText).toBe("Hi there!");
  });

  it("message_delta has stop_reason end_turn for text", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    });

    const events = parseClaudeSSEEvents(res.body);
    const msgDelta = events.find((e) => e.type === "message_delta") as SSEEvent & {
      delta: { stop_reason: string };
    };
    expect(msgDelta).toBeDefined();
    expect(msgDelta.delta.stop_reason).toBe("end_turn");
  });

  it("streams tool call response with tool_use blocks", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "weather" }],
      stream: true,
    });

    expect(res.status).toBe(200);

    const events = parseClaudeSSEEvents(res.body);
    const types = events.map((e) => e.type);

    expect(types[0]).toBe("message_start");
    expect(types).toContain("content_block_start");
    expect(types).toContain("content_block_delta");
    expect(types).toContain("content_block_stop");
    expect(types).toContain("message_delta");
    expect(types[types.length - 1]).toBe("message_stop");

    // content_block_start should have tool_use type
    const blockStart = events.find(
      (e) =>
        e.type === "content_block_start" &&
        (e.content_block as { type: string })?.type === "tool_use",
    ) as SSEEvent & {
      content_block: { type: string; id: string; name: string };
    };
    expect(blockStart).toBeDefined();
    expect(blockStart.content_block.id).toMatch(/^toolu_/);
    expect(blockStart.content_block.name).toBe("get_weather");
  });

  it("tool call deltas use input_json_delta and reconstruct arguments", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "weather" }],
      stream: true,
    });

    const events = parseClaudeSSEEvents(res.body);
    const deltas = events.filter(
      (e) =>
        e.type === "content_block_delta" &&
        (e.delta as { type: string })?.type === "input_json_delta",
    ) as (SSEEvent & { delta: { type: string; partial_json: string } })[];

    expect(deltas.length).toBeGreaterThan(0);
    const fullJson = deltas.map((d) => d.delta.partial_json).join("");
    const parsed = JSON.parse(fullJson);
    expect(parsed).toEqual({ city: "NYC" });
  });

  it("message_delta has stop_reason tool_use for tool calls", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "weather" }],
      stream: true,
    });

    const events = parseClaudeSSEEvents(res.body);
    const msgDelta = events.find((e) => e.type === "message_delta") as SSEEvent & {
      delta: { stop_reason: string };
    };
    expect(msgDelta.delta.stop_reason).toBe("tool_use");
  });

  it("streams multiple tool calls with correct indices", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "multi-tool" }],
      stream: true,
    });

    const events = parseClaudeSSEEvents(res.body);
    const blockStarts = events.filter(
      (e) =>
        e.type === "content_block_start" &&
        (e.content_block as { type: string })?.type === "tool_use",
    );
    expect(blockStarts).toHaveLength(2);
    expect(blockStarts[0].index).toBe(0);
    expect(blockStarts[1].index).toBe(1);
  });

  it("uses fixture chunkSize for text streaming", async () => {
    const bigChunkFixture: Fixture = {
      match: { userMessage: "bigchunk" },
      response: { content: "ABCDEFGHIJ" },
      chunkSize: 5,
    };
    instance = await createServer([bigChunkFixture], { chunkSize: 2 });
    const res = await post(`${instance.url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "bigchunk" }],
      stream: true,
    });

    const events = parseClaudeSSEEvents(res.body);
    const deltas = events.filter(
      (e) =>
        e.type === "content_block_delta" && (e.delta as { type: string })?.type === "text_delta",
    ) as (SSEEvent & { delta: { text: string } })[];
    // 10 chars / chunkSize 5 = 2 deltas
    expect(deltas).toHaveLength(2);
    expect(deltas[0].delta.text).toBe("ABCDE");
    expect(deltas[1].delta.text).toBe("FGHIJ");
  });
});

describe("POST /v1/messages (non-streaming)", () => {
  it("returns text response as JSON", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    });

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
  });

  it("returns tool call response as JSON with object input", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "weather" }],
      stream: false,
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.type).toBe("message");
    expect(body.stop_reason).toBe("tool_use");
    expect(body.content).toHaveLength(1);
    expect(body.content[0].type).toBe("tool_use");
    expect(body.content[0].name).toBe("get_weather");
    // Claude uses object input, not string
    expect(body.content[0].input).toEqual({ city: "NYC" });
    expect(body.content[0].id).toBeDefined();
  });

  it("returns multiple tool calls as JSON", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "multi-tool" }],
      stream: false,
    });

    const body = JSON.parse(res.body);
    expect(body.content).toHaveLength(2);
    expect(body.content[0].name).toBe("get_weather");
    expect(body.content[1].name).toBe("get_time");
  });
});

describe("POST /v1/messages (default non-streaming)", () => {
  it("returns JSON response when stream field is omitted", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hello" }],
      // stream field intentionally omitted
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");

    const body = JSON.parse(res.body);
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(body.content[0].text).toBe("Hi there!");
  });

  it("returns JSON tool call response when stream field is omitted", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "weather" }],
      // stream field intentionally omitted
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");

    const body = JSON.parse(res.body);
    expect(body.type).toBe("message");
    expect(body.content[0].type).toBe("tool_use");
    expect(body.content[0].name).toBe("get_weather");
  });
});

describe("POST /v1/messages (error handling)", () => {
  it("returns error fixture with correct status", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "fail" }],
    });

    expect(res.status).toBe(429);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("Rate limited");
  });

  it("returns error in Anthropic format: { type: 'error', error: { type, message } }", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "fail" }],
    });

    expect(res.status).toBe(429);
    const body = JSON.parse(res.body);
    // Anthropic wraps errors as { type: "error", error: { type, message } }
    expect(body.type).toBe("error");
    expect(body.error).toBeDefined();
    expect(body.error.type).toBe("rate_limit_error");
    expect(body.error.message).toBe("Rate limited");
    // Should NOT have OpenAI-style fields at the top level
    expect(body.status).toBeUndefined();
    expect(body.error.code).toBeUndefined();
  });

  it("returns 404 when no fixture matches", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "unknown" }],
    });

    expect(res.status).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("No fixture matched");
  });

  it("returns 400 for malformed JSON", async () => {
    instance = await createServer(allFixtures);
    const res = await postRaw(`${instance.url}/v1/messages`, "{not valid");

    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.message).toMatch(/^Malformed JSON: /);
  });

  it("returns 500 for unknown response type", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "badtype" }],
    });

    expect(res.status).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error.message).toContain("did not match any known type");
  });
});

describe("POST /v1/messages (journal)", () => {
  it("records successful text response", async () => {
    instance = await createServer(allFixtures);
    await post(`${instance.url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hello" }],
    });

    expect(instance.journal.size).toBe(1);
    const entry = instance.journal.getLast();
    expect(entry!.path).toBe("/v1/messages");
    expect(entry!.response.status).toBe(200);
    expect(entry!.response.fixture).toBe(textFixture);
  });

  it("records unmatched response with null fixture", async () => {
    instance = await createServer(allFixtures);
    await post(`${instance.url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "nomatch" }],
    });

    const entry = instance.journal.getLast();
    expect(entry!.response.status).toBe(404);
    expect(entry!.response.fixture).toBeNull();
  });

  it("journal body contains converted ChatCompletionRequest", async () => {
    instance = await createServer(allFixtures);
    await post(`${instance.url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      system: "Be nice",
      messages: [{ role: "user", content: "hello" }],
    });

    const entry = instance.journal.getLast();
    expect(entry!.body!.model).toBe("claude-3-5-sonnet-20241022");
    expect(entry!.body!.messages).toEqual([
      { role: "system", content: "Be nice" },
      { role: "user", content: "hello" },
    ]);
  });
});

describe("POST /v1/messages (error field preservation)", () => {
  it("error type and message fields are preserved in Anthropic format", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "fail" }],
    });

    expect(res.status).toBe(429);
    const body = JSON.parse(res.body);
    // Anthropic format: { type: "error", error: { type, message } }
    expect(body.type).toBe("error");
    expect(body.error.message).toBe("Rate limited");
    expect(body.error.type).toBe("rate_limit_error");
  });

  it("Content-Type is application/json on error responses", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "fail" }],
    });

    expect(res.status).toBe(429);
    expect(res.headers["content-type"]).toBe("application/json");
  });
});

describe("POST /v1/messages (CORS)", () => {
  it("includes CORS headers", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hello" }],
    });

    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });
});

// ─── Branch coverage: ?? defaults and fallback paths ─────────────────────────

describe("claudeToCompletionRequest (fallback branches)", () => {
  it("handles tool_result with undefined content (defaults to empty string)", () => {
    const result = claudeToCompletionRequest({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_abc",
              // content intentionally omitted (undefined)
            },
          ],
        },
      ],
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("tool");
    expect(result.messages[0].content).toBe("");
  });

  it("handles tool_result with text blocks alongside in same user message", () => {
    const result = claudeToCompletionRequest({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_abc",
              content: "result data",
            },
            { type: "text", text: "follow up question" },
          ],
        },
      ],
    });
    // Should produce user message (accompanying text) THEN tool message. The
    // text is emitted FIRST so the tool message trails the last user message and
    // the current-turn hasToolResult predicate classifies this leg-2 turn as
    // carrying a tool result (`true`). Emitting the tool first would make this
    // byte-identical to a genuine leg-1 turn and misclassify it `false`.
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].content).toBe("follow up question");
    expect(result.messages[1].role).toBe("tool");
    expect(result.messages[1].content).toBe("result data");
  });

  it("handles text content blocks with missing text (text ?? '')", () => {
    const result = claudeToCompletionRequest({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            { type: "text" }, // text field missing
          ] as Array<{ type: "text"; text?: string }>,
        },
      ],
    });
    expect(result.messages[0].content).toBe("");
  });

  it("handles assistant tool_use block with missing id (generates one)", () => {
    const result = claudeToCompletionRequest({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              // id intentionally omitted
              name: "my_tool",
              input: { x: 1 },
            },
          ],
        },
      ],
    });
    expect(result.messages[0].tool_calls![0].id).toMatch(/^toolu_/);
  });

  it("handles assistant tool_use block with missing name (defaults to empty)", () => {
    const result = claudeToCompletionRequest({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_xyz",
              // name intentionally omitted
              input: { x: 1 },
            },
          ],
        },
      ],
    });
    expect(result.messages[0].tool_calls![0].function.name).toBe("");
  });

  it("handles assistant tool_use with string input", () => {
    const result = claudeToCompletionRequest({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_xyz",
              name: "my_tool",
              input: '{"already":"stringified"}',
            },
          ],
        },
      ],
    });
    expect(result.messages[0].tool_calls![0].function.arguments).toBe('{"already":"stringified"}');
  });

  it("handles assistant tool_use with undefined input (defaults to {})", () => {
    const result = claudeToCompletionRequest({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_xyz",
              name: "my_tool",
              // input intentionally omitted
            },
          ],
        },
      ],
    });
    expect(result.messages[0].tool_calls![0].function.arguments).toBe("{}");
  });

  it("handles assistant content blocks with text and tool_use together", () => {
    const result = claudeToCompletionRequest({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me help with that." },
            {
              type: "tool_use",
              id: "toolu_123",
              name: "search",
              input: { q: "test" },
            },
          ],
        },
      ],
    });
    expect(result.messages[0].content).toBe("Let me help with that.");
    expect(result.messages[0].tool_calls).toHaveLength(1);
  });

  it("handles assistant content blocks with only text (no tool_use)", () => {
    const result = claudeToCompletionRequest({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Just text" }],
        },
      ],
    });
    // No tool_use blocks, so textContent is used; no tool_calls
    expect(result.messages[0].content).toBe("Just text");
    expect(result.messages[0].tool_calls).toBeUndefined();
  });

  it("handles assistant content blocks with empty text (null fallback)", () => {
    const result = claudeToCompletionRequest({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [
        {
          role: "assistant",
          content: [{ type: "image" }] as Array<{
            type: "text" | "tool_use" | "image";
            text?: string;
          }>,
        },
      ],
    });
    // No text blocks, no tool_use blocks → textContent is "" → falls to null
    expect(result.messages[0].content).toBeNull();
  });

  it("handles system as empty content blocks array (no system message added)", () => {
    const result = claudeToCompletionRequest({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      system: [{ type: "text" }] as Array<{ type: "text"; text?: string }>,
      messages: [{ role: "user", content: "hi" }],
    });
    // text ?? "" gives "", which is falsy → no system message pushed
    expect(result.messages[0].role).toBe("user");
    expect(result.messages).toHaveLength(1);
  });

  it("returns undefined tools for empty tools array", () => {
    const result = claudeToCompletionRequest({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    });
    expect(result.tools).toBeUndefined();
  });

  it("handles tool_result with nested text blocks where text is missing", () => {
    const result = claudeToCompletionRequest({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_789",
              content: [
                { type: "text" }, // text field missing
              ] as Array<{ type: "text"; text?: string }>,
            },
          ],
        },
      ],
    });
    expect(result.messages[0].content).toBe("");
  });

  it("handles text blocks in tool_result+text user message where text is missing", () => {
    const result = claudeToCompletionRequest({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_abc",
              content: "result",
            },
            { type: "text" }, // text missing → text ?? ""
          ] as Array<{
            type: "text" | "tool_result";
            text?: string;
            tool_use_id?: string;
            content?: string;
          }>,
        },
      ],
    });
    // Accompanying text is emitted BEFORE the tool message (see the ordering
    // rationale in claudeToCompletionRequest); a missing text field → "".
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].content).toBe("");
    expect(result.messages[1].role).toBe("tool");
    expect(result.messages[1].content).toBe("result");
  });

  it("handles system content blocks with text ?? '' in filter/map", () => {
    const result = claudeToCompletionRequest({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      system: [
        { type: "text", text: "Part 1" },
        { type: "text", text: " Part 2" },
      ],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.messages[0]).toEqual({ role: "system", content: "Part 1 Part 2" });
  });
});

describe("POST /v1/messages (strict mode)", () => {
  it("returns 503 when strict mode is enabled and no fixture matches", async () => {
    instance = await createServer([], { strict: true });
    const res = await post(`${instance.url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "unmatched" }],
    });

    expect(res.status).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("Strict mode: no fixture matched");
  });

  it("returns the skipped-by-state message when a sequence-exhausted fixture is replayed", async () => {
    const seqFixture: Fixture = {
      match: { userMessage: "hello", sequenceIndex: 0 },
      response: { content: "Hi there!" },
    };
    instance = await createServer([seqFixture], { strict: true });
    // First call consumes the sequenceIndex:0 fixture (count → 1).
    const first = await post(`${instance.url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hello" }],
    });
    expect(first.status).toBe(200);
    // Replay: shape still matches but the fixture is skipped by sequence state.
    const res = await post(`${instance.url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hello" }],
    });
    expect(res.status).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.error.message).toMatch(SKIPPED_BY_STATE_RE);
  });
});

describe("POST /v1/messages (error response with default status)", () => {
  it("defaults error status to 500 when status field is omitted", async () => {
    const errorNoStatus: Fixture = {
      match: { userMessage: "error-no-status" },
      response: {
        error: {
          message: "Internal failure",
          type: "server_error",
        },
      } as Fixture["response"],
    };
    instance = await createServer([errorNoStatus]);
    const res = await post(`${instance.url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "error-no-status" }],
    });

    expect(res.status).toBe(500);
  });

  it("defaults error.type to api_error when type is omitted", async () => {
    const errorNoType: Fixture = {
      match: { userMessage: "error-no-type" },
      response: {
        error: {
          message: "Something went wrong",
        },
        status: 500,
      } as Fixture["response"],
    };
    instance = await createServer([errorNoType]);
    const res = await post(`${instance.url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "error-no-type" }],
    });

    expect(res.status).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error.type).toBe("api_error");
  });
});

describe("POST /v1/messages (tool call with malformed JSON arguments)", () => {
  it("falls back to {} for malformed tool call arguments in non-streaming", async () => {
    const malformedToolFixture: Fixture = {
      match: { userMessage: "malformed-args" },
      response: {
        toolCalls: [
          {
            name: "broken_tool",
            arguments: "not valid json{",
          },
        ],
      },
    };
    instance = await createServer([malformedToolFixture]);
    const res = await post(`${instance.url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "malformed-args" }],
      stream: false,
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.content[0].input).toEqual({});
  });

  it("falls back to {} for malformed tool call arguments in streaming", async () => {
    const malformedToolFixture: Fixture = {
      match: { userMessage: "malformed-args-stream" },
      response: {
        toolCalls: [
          {
            name: "broken_tool",
            arguments: "{{invalid}}",
          },
        ],
      },
    };
    instance = await createServer([malformedToolFixture]);
    const res = await post(`${instance.url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "malformed-args-stream" }],
      stream: true,
    });

    expect(res.status).toBe(200);
    const events = parseClaudeSSEEvents(res.body);
    // The arguments delta should contain "{}" since the malformed JSON falls back to {}
    const deltas = events.filter(
      (e) =>
        e.type === "content_block_delta" &&
        (e.delta as { type: string })?.type === "input_json_delta",
    ) as (SSEEvent & { delta: { partial_json: string } })[];
    const fullJson = deltas.map((d) => d.delta.partial_json).join("");
    expect(JSON.parse(fullJson)).toEqual({});
  });
});

describe("POST /v1/messages (tool call with empty arguments)", () => {
  it("defaults empty arguments to '{}' in non-streaming", async () => {
    const emptyArgsFixture: Fixture = {
      match: { userMessage: "empty-args" },
      response: {
        toolCalls: [
          {
            name: "no_args_tool",
            arguments: "",
          },
        ],
      },
    };
    instance = await createServer([emptyArgsFixture]);
    const res = await post(`${instance.url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "empty-args" }],
      stream: false,
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.content[0].input).toEqual({});
  });

  it("defaults empty arguments to '{}' in streaming", async () => {
    const emptyArgsFixture: Fixture = {
      match: { userMessage: "empty-args-stream" },
      response: {
        toolCalls: [
          {
            name: "no_args_tool",
            arguments: "",
          },
        ],
      },
    };
    instance = await createServer([emptyArgsFixture]);
    const res = await post(`${instance.url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "empty-args-stream" }],
      stream: true,
    });

    expect(res.status).toBe(200);
    const events = parseClaudeSSEEvents(res.body);
    const deltas = events.filter(
      (e) =>
        e.type === "content_block_delta" &&
        (e.delta as { type: string })?.type === "input_json_delta",
    ) as (SSEEvent & { delta: { partial_json: string } })[];
    const fullJson = deltas.map((d) => d.delta.partial_json).join("");
    expect(JSON.parse(fullJson)).toEqual({});
  });
});

describe("POST /v1/messages (tool call with explicit id)", () => {
  it("uses explicit tool call id in non-streaming", async () => {
    const toolWithId: Fixture = {
      match: { userMessage: "tool-explicit-id" },
      response: {
        toolCalls: [
          {
            id: "toolu_explicit_123",
            name: "my_func",
            arguments: '{"a":1}',
          },
        ],
      },
    };
    instance = await createServer([toolWithId]);
    const res = await post(`${instance.url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "tool-explicit-id" }],
      stream: false,
    });
    const body = JSON.parse(res.body);
    expect(body.content[0].id).toBe("toolu_explicit_123");
  });

  it("uses explicit tool call id in streaming", async () => {
    const toolWithId: Fixture = {
      match: { userMessage: "tool-explicit-id-stream" },
      response: {
        toolCalls: [
          {
            id: "toolu_explicit_456",
            name: "my_func",
            arguments: '{"a":1}',
          },
        ],
      },
    };
    instance = await createServer([toolWithId]);
    const res = await post(`${instance.url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "tool-explicit-id-stream" }],
      stream: true,
    });
    const events = parseClaudeSSEEvents(res.body);
    const blockStart = events.find(
      (e) =>
        e.type === "content_block_start" &&
        (e.content_block as { type: string })?.type === "tool_use",
    ) as SSEEvent & { content_block: { id: string } };
    expect(blockStart.content_block.id).toBe("toolu_explicit_456");
  });

  it("generates tool call id when id is empty string", async () => {
    const toolEmptyId: Fixture = {
      match: { userMessage: "tool-empty-id" },
      response: {
        toolCalls: [
          {
            id: "",
            name: "my_func",
            arguments: '{"a":1}',
          },
        ],
      },
    };
    instance = await createServer([toolEmptyId]);
    const res = await post(`${instance.url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "tool-empty-id" }],
      stream: false,
    });
    const body = JSON.parse(res.body);
    expect(body.content[0].id).toMatch(/^toolu_/);
  });
});

describe("POST /v1/messages (streaming interruption)", () => {
  it("truncates text stream after specified chunks and records interruption", async () => {
    const truncatedFixture: Fixture = {
      match: { userMessage: "truncate-text" },
      response: { content: "ABCDEFGHIJKLMNOP" },
      chunkSize: 1,
      truncateAfterChunks: 2,
    };
    instance = await createServer([truncatedFixture]);
    try {
      await post(`${instance.url}/v1/messages`, {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [{ role: "user", content: "truncate-text" }],
        stream: true,
      });
    } catch {
      // Expected: socket hang up due to server destroying connection
    }

    await new Promise((r) => setTimeout(r, 50));
    const entry = instance.journal.getLast();
    expect(entry!.response.interrupted).toBe(true);
    expect(entry!.response.interruptReason).toBe("truncateAfterChunks");
  });

  it("truncates tool call stream after specified chunks and records interruption", async () => {
    const truncatedToolFixture: Fixture = {
      match: { userMessage: "truncate-tool" },
      response: {
        toolCalls: [
          {
            name: "my_func",
            arguments: '{"key":"value"}',
          },
        ],
      },
      chunkSize: 1,
      truncateAfterChunks: 2,
    };
    instance = await createServer([truncatedToolFixture]);
    try {
      await post(`${instance.url}/v1/messages`, {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [{ role: "user", content: "truncate-tool" }],
        stream: true,
      });
    } catch {
      // Expected: socket hang up due to server destroying connection
    }

    await new Promise((r) => setTimeout(r, 50));
    const entry = instance.journal.getLast();
    expect(entry!.response.interrupted).toBe(true);
    expect(entry!.response.interruptReason).toBe("truncateAfterChunks");
  });
});

describe("POST /v1/messages (streaming tool call journal)", () => {
  it("records streaming tool call response in journal", async () => {
    instance = await createServer(allFixtures);
    await post(`${instance.url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "weather" }],
      stream: true,
    });

    const entry = instance.journal.getLast();
    expect(entry!.response.status).toBe(200);
    expect(entry!.response.fixture).toBe(toolFixture);
  });
});

// ─── Direct handler tests: covering ?? fallbacks on req.method/req.url ───────

function createMockRes(): http.ServerResponse {
  const res = new PassThrough() as unknown as http.ServerResponse;
  let ended = false;
  const headers: Record<string, string> = {};
  res.setHeader = (name: string, value: string | number | readonly string[]) => {
    headers[name.toLowerCase()] = String(value);
    return res;
  };
  res.writeHead = (
    statusCode: number,
    arg1?: string | http.OutgoingHttpHeaders | http.OutgoingHttpHeader[],
    arg2?: http.OutgoingHttpHeaders | http.OutgoingHttpHeader[],
  ) => {
    (res as { statusCode: number }).statusCode = statusCode;
    const hdrs = typeof arg1 === "string" ? arg2 : arg1;
    if (hdrs && !Array.isArray(hdrs)) {
      for (const [k, v] of Object.entries(hdrs)) {
        headers[k.toLowerCase()] = String(v);
      }
    }
    return res;
  };
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  res.write = (chunk: string) => true;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  res.end = ((...args: unknown[]) => {
    ended = true;
    return res;
  }) as typeof res.end;
  Object.defineProperty(res, "writableEnded", { get: () => ended });
  res.destroy = () => {
    ended = true;
    return res;
  };
  return res;
}

describe("handleMessages (direct call — ?? fallback branches)", () => {
  it("uses fallback POST and /v1/messages when req.method and req.url are undefined", async () => {
    const journal = new Journal();
    const logger = new Logger("silent");
    const defaults = { latency: 0, chunkSize: 10, replaySpeed: 1, logger };

    const mockReq = {
      method: undefined,
      url: undefined,
      headers: {},
    } as unknown as http.IncomingMessage;

    const mockRes = createMockRes();

    await handleMessages(
      mockReq,
      mockRes,
      JSON.stringify({
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hello" }],
      }),
      [textFixture],
      journal,
      defaults,
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.path).toBe("/v1/messages");
    expect(entry!.response.status).toBe(200);
  });

  it("uses fallback method/path on malformed JSON with undefined req fields", async () => {
    const journal = new Journal();
    const logger = new Logger("silent");
    const defaults = { latency: 0, chunkSize: 10, replaySpeed: 1, logger };

    const mockReq = {
      method: undefined,
      url: undefined,
      headers: {},
    } as unknown as http.IncomingMessage;

    const mockRes = createMockRes();

    await handleMessages(mockReq, mockRes, "{bad", [], journal, defaults, () => {});

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.path).toBe("/v1/messages");
    expect(entry!.response.status).toBe(400);
  });

  it("uses fallback method/path on no-match with undefined req fields", async () => {
    const journal = new Journal();
    const logger = new Logger("silent");
    const defaults = { latency: 0, chunkSize: 10, replaySpeed: 1, logger };

    const mockReq = {
      method: undefined,
      url: undefined,
      headers: {},
    } as unknown as http.IncomingMessage;

    const mockRes = createMockRes();

    await handleMessages(
      mockReq,
      mockRes,
      JSON.stringify({
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [{ role: "user", content: "nomatch" }],
      }),
      [],
      journal,
      defaults,
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.path).toBe("/v1/messages");
    expect(entry!.response.status).toBe(404);
  });

  it("uses fallback for error fixture with undefined req fields", async () => {
    const journal = new Journal();
    const logger = new Logger("silent");
    const defaults = { latency: 0, chunkSize: 10, replaySpeed: 1, logger };

    const mockReq = {
      method: undefined,
      url: undefined,
      headers: {},
    } as unknown as http.IncomingMessage;

    const mockRes = createMockRes();

    await handleMessages(
      mockReq,
      mockRes,
      JSON.stringify({
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [{ role: "user", content: "fail" }],
      }),
      [errorFixture],
      journal,
      defaults,
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.path).toBe("/v1/messages");
    expect(entry!.response.status).toBe(429);
  });

  it("uses fallback for streaming text with undefined req fields", async () => {
    const journal = new Journal();
    const logger = new Logger("silent");
    const defaults = { latency: 0, chunkSize: 10, replaySpeed: 1, logger };

    const mockReq = {
      method: undefined,
      url: undefined,
      headers: {},
    } as unknown as http.IncomingMessage;

    const mockRes = createMockRes();

    await handleMessages(
      mockReq,
      mockRes,
      JSON.stringify({
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      }),
      [textFixture],
      journal,
      defaults,
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.path).toBe("/v1/messages");
    expect(entry!.response.status).toBe(200);
  });

  it("uses fallback for streaming tool call with undefined req fields", async () => {
    const journal = new Journal();
    const logger = new Logger("silent");
    const defaults = { latency: 0, chunkSize: 10, replaySpeed: 1, logger };

    const mockReq = {
      method: undefined,
      url: undefined,
      headers: {},
    } as unknown as http.IncomingMessage;

    const mockRes = createMockRes();

    await handleMessages(
      mockReq,
      mockRes,
      JSON.stringify({
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [{ role: "user", content: "weather" }],
        stream: true,
      }),
      [toolFixture],
      journal,
      defaults,
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.path).toBe("/v1/messages");
    expect(entry!.response.status).toBe(200);
  });

  it("uses fallback for unknown response type with undefined req fields", async () => {
    const journal = new Journal();
    const logger = new Logger("silent");
    const defaults = { latency: 0, chunkSize: 10, replaySpeed: 1, logger };

    const mockReq = {
      method: undefined,
      url: undefined,
      headers: {},
    } as unknown as http.IncomingMessage;

    const mockRes = createMockRes();

    await handleMessages(
      mockReq,
      mockRes,
      JSON.stringify({
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [{ role: "user", content: "badtype" }],
      }),
      [badResponseFixture],
      journal,
      defaults,
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.path).toBe("/v1/messages");
    expect(entry!.response.status).toBe(500);
  });

  it("uses fallback for strict mode no-match with undefined req fields", async () => {
    const journal = new Journal();
    const logger = new Logger("silent");
    const defaults = { latency: 0, chunkSize: 10, replaySpeed: 1, logger, strict: true };

    const mockReq = {
      method: undefined,
      url: undefined,
      headers: {},
    } as unknown as http.IncomingMessage;

    const mockRes = createMockRes();

    await handleMessages(
      mockReq,
      mockRes,
      JSON.stringify({
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [{ role: "user", content: "nomatch" }],
      }),
      [],
      journal,
      defaults,
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.path).toBe("/v1/messages");
    expect(entry!.response.status).toBe(503);
  });
});

describe("POST /v1/messages (citations and files)", () => {
  const citeFixture: Fixture = {
    match: { userMessage: "cite-me" },
    response: {
      content: "Mastra is a TypeScript framework.",
      citations: [
        { url: "https://mastra.ai", title: "Mastra" },
        { url: "https://mastra.ai/docs", startIndex: 0, endIndex: 6 },
      ],
    },
  };
  const messagesBody = (msg: string, stream: boolean) => ({
    model: "claude-3-5-sonnet-20241022",
    max_tokens: 100,
    stream,
    messages: [{ role: "user", content: msg }],
  });
  const citation = (cited: string, url: string, title: string) => ({
    type: "web_search_result_location",
    cited_text: cited,
    url,
    title,
    encrypted_index: expect.any(String),
  });

  it("non-streaming text block carries web_search_result_location citations", async () => {
    instance = await createServer([citeFixture]);
    const res = await post(`${instance.url}/v1/messages`, messagesBody("cite-me", false));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).content[0].citations).toEqual([
      citation("Mastra is a TypeScript framework.", "https://mastra.ai", "Mastra"),
      citation("Mastra", "https://mastra.ai/docs", "https://mastra.ai/docs"),
    ]);
  });

  it("streaming emits citations_delta after the text deltas, before content_block_stop", async () => {
    instance = await createServer([citeFixture]);
    const res = await post(`${instance.url}/v1/messages`, messagesBody("cite-me", true));
    const events = parseClaudeSSEEvents(res.body);
    const kinds = events
      .filter((e) => e.type === "content_block_delta" || e.type === "content_block_stop")
      .map((e) => (e.type === "content_block_stop" ? "stop" : (e.delta as { type: string }).type));
    const firstCitation = kinds.indexOf("citations_delta");
    expect(firstCitation).toBeGreaterThan(0);
    expect(kinds.slice(0, firstCitation).every((k) => k === "text_delta")).toBe(true);
    expect(kinds.slice(firstCitation)).toEqual(["citations_delta", "citations_delta", "stop"]);
    const citations = events
      .filter((e) => (e.delta as { type?: string } | undefined)?.type === "citations_delta")
      .map((e) => (e.delta as { citation: unknown }).citation);
    expect(citations).toEqual([
      citation("Mastra is a TypeScript framework.", "https://mastra.ai", "Mastra"),
      citation("Mastra", "https://mastra.ai/docs", "https://mastra.ai/docs"),
    ]);
  });

  it("content+toolCalls turns carry citations on the text block", async () => {
    instance = await createServer([
      {
        match: { userMessage: "cite-tools" },
        response: {
          content: "Checking.",
          toolCalls: [{ name: "lookup", arguments: "{}" }],
          citations: [{ url: "https://example.com" }],
        },
      },
    ]);
    const res = await post(`${instance.url}/v1/messages`, messagesBody("cite-tools", false));
    const content = JSON.parse(res.body).content;
    expect(content[0].citations).toEqual([
      citation("Checking.", "https://example.com", "https://example.com"),
    ]);
    expect(content[1].type).toBe("tool_use");
    const streamed = await post(`${instance.url}/v1/messages`, messagesBody("cite-tools", true));
    const deltas = parseClaudeSSEEvents(streamed.body).filter(
      (e) => (e.delta as { type?: string } | undefined)?.type === "citations_delta",
    );
    expect(deltas).toHaveLength(1);
    expect(deltas[0].index).toBe(0);
  });

  // `blocks` citation offsets index the joined text of all text blocks (the
  // Chat Completions / Gemini convention): "Alpha one. " + "Beta two.".
  const blocksCiteFixture = (reasoning?: string): Fixture => ({
    match: { userMessage: "cite-blocks" },
    response: {
      content: "",
      ...(reasoning !== undefined ? { reasoning } : {}),
      blocks: [
        { type: "text", text: "Alpha one. " },
        { type: "toolCall", name: "lookup", arguments: "{}" },
        { type: "text", text: "Beta two." },
      ],
      citations: [
        { url: "https://alpha.example", title: "Alpha", startIndex: 0, endIndex: 5 },
        { url: "https://beta.example", title: "Beta", startIndex: 11, endIndex: 15 },
      ],
    },
  });
  const alphaCite = citation("Alpha", "https://alpha.example", "Alpha");
  const betaCite = citation("Beta", "https://beta.example", "Beta");
  const citationDeltas = (body: string) =>
    parseClaudeSSEEvents(body)
      .filter((e) => (e.delta as { type?: string } | undefined)?.type === "citations_delta")
      .map((e) => ({ index: e.index, citation: (e.delta as { citation: unknown }).citation }));

  it("non-streaming blocks attach each citation only to the text block it starts in", async () => {
    instance = await createServer([blocksCiteFixture()]);
    const res = await post(`${instance.url}/v1/messages`, messagesBody("cite-blocks", false));
    const content = JSON.parse(res.body).content;
    expect(content.map((b: { type: string }) => b.type)).toEqual(["text", "tool_use", "text"]);
    expect(content[0].citations).toEqual([alphaCite]);
    expect(content[1].citations).toBeUndefined();
    expect(content[2].citations).toEqual([betaCite]);
  });

  it("streaming blocks emit each citations_delta once, on the owning text block", async () => {
    instance = await createServer([blocksCiteFixture()]);
    const res = await post(`${instance.url}/v1/messages`, messagesBody("cite-blocks", true));
    expect(citationDeltas(res.body)).toEqual([
      { index: 0, citation: alphaCite },
      { index: 2, citation: betaCite },
    ]);
  });

  it("thinking-first blocks: citations_delta indexes shift with the thinking block", async () => {
    instance = await createServer([blocksCiteFixture("Let me think.")]);
    const res = await post(`${instance.url}/v1/messages`, messagesBody("cite-blocks", true));
    expect(citationDeltas(res.body)).toEqual([
      { index: 1, citation: alphaCite },
      { index: 3, citation: betaCite },
    ]);
    const nonStream = await post(`${instance.url}/v1/messages`, messagesBody("cite-blocks", false));
    const content = JSON.parse(nonStream.body).content;
    expect(content[0].type).toBe("thinking");
    expect(content[1].citations).toEqual([alphaCite]);
    expect(content[3].citations).toEqual([betaCite]);
  });

  it("a citation spanning two text blocks goes to the block it starts in, cut at its end", async () => {
    // [6, 15) starts in "Alpha one. " (0-11) and ends in "Beta two." (11-20):
    // the starting block owns it, and cited_text stops at that block's end.
    instance = await createServer([
      {
        match: { userMessage: "cite-span" },
        response: {
          content: "",
          blocks: [
            { type: "text", text: "Alpha one. " },
            { type: "text", text: "Beta two." },
          ],
          citations: [{ url: "https://span.example", title: "Span", startIndex: 6, endIndex: 15 }],
        },
      },
    ]);
    const spanCite = citation("one. ", "https://span.example", "Span");
    const res = await post(`${instance.url}/v1/messages`, messagesBody("cite-span", false));
    const content = JSON.parse(res.body).content;
    expect(content.map((b: { type: string; text: string }) => [b.type, b.text])).toEqual([
      ["text", "Alpha one. "],
      ["text", "Beta two."],
    ]);
    expect(content[0].citations).toEqual([spanCite]);
    expect(content[1].citations).toBeUndefined();
    const streamed = await post(`${instance.url}/v1/messages`, messagesBody("cite-span", true));
    expect(citationDeltas(streamed.body)).toEqual([{ index: 0, citation: spanCite }]);
  });

  it("@anthropic-ai/sdk stream helper assembles per-block citations like the non-streaming body", async () => {
    instance = await createServer([blocksCiteFixture("Let me think.")]);
    const client = new Anthropic({ apiKey: "local", baseURL: instance.url, maxRetries: 0 });
    const params = {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 100,
      messages: [{ role: "user" as const, content: "cite-blocks" }],
    };
    const assembled = await client.messages.stream(params).finalMessage();
    const direct = await client.messages.create(params);
    const citesOf = (content: Anthropic.ContentBlock[]) =>
      content.map((b) => (b.type === "text" ? (b.citations ?? []).map((c) => c.cited_text) : null));
    expect(citesOf(assembled.content)).toEqual([null, ["Alpha"], null, ["Beta"]]);
    expect(citesOf(direct.content)).toEqual(citesOf(assembled.content));
  });

  it.each([false, true])(
    "omitting citations leaves the wire byte-identical to the no-citations baseline (stream: %s)",
    async (stream) => {
      instance = await createServer([textFixture]);
      const res = await post(`${instance.url}/v1/messages`, messagesBody("hello", stream));
      // Ids are random; everything else must match byte for byte.
      const normalized = res.body.replace(/"id":"[^"]*"/g, '"id":"<id>"');
      const model = '"model":"claude-3-5-sonnet-20241022"';
      if (!stream) {
        expect(normalized).toBe(
          `{"id":"<id>","type":"message","role":"assistant","content":[{"type":"text","text":"Hi there!"}],${model},"stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0}}`,
        );
        return;
      }
      const sse = (type: string, data: string) =>
        `event: ${type}\ndata: {"type":"${type}"${data}}\n\n`;
      expect(normalized).toBe(
        [
          sse(
            "message_start",
            `,"message":{"id":"<id>","type":"message","role":"assistant","content":[],${model},"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0}}`,
          ),
          sse("content_block_start", ',"index":0,"content_block":{"type":"text","text":""}'),
          sse("content_block_delta", ',"index":0,"delta":{"type":"text_delta","text":"Hi there!"}'),
          sse("content_block_stop", ',"index":0'),
          sse(
            "message_delta",
            ',"delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":0}',
          ),
          sse("message_stop", ""),
        ].join(""),
      );
    },
  );

  it.each([false, true])("rejects fixture files with a coded 500 (stream: %s)", async (stream) => {
    instance = await createServer([
      {
        match: { userMessage: "draw" },
        response: { content: "Here.", files: [{ mimeType: "image/png", data: "iVBORw0KGgo=" }] },
      },
    ]);
    const res = await post(`${instance.url}/v1/messages`, messagesBody("draw", stream));
    expect(res.status).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("aimock_unsupported_generated_file");
    expect(body.error.message).toContain("Anthropic Messages");
  });

  const generatedFile = [{ mimeType: "image/png", data: "iVBORw0KGgo=" }];

  it.each<[string, Fixture["response"]]>([
    ["tool-only", { toolCalls: [{ name: "lookup", arguments: "{}" }], files: generatedFile }],
    [
      "content + tool calls",
      {
        content: "Checking.",
        toolCalls: [{ name: "lookup", arguments: "{}" }],
        files: generatedFile,
      },
    ],
  ])("rejects fixture files on the %s path with a coded 500", async (_label, response) => {
    instance = await createServer([{ match: { userMessage: "draw" }, response }]);
    for (const stream of [false, true]) {
      const res = await post(`${instance.url}/v1/messages`, messagesBody("draw", stream));
      expect(res.status).toBe(500);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe("aimock_unsupported_generated_file");
      expect(body.error.message).toContain("Anthropic Messages");
    }
  });

  type TurnBlock = { type: string; text?: string; thinking?: string };
  // What a turn looks like on the wire, folded the same way for both modes.
  const messagesTurn = (body: string, stream: boolean) => {
    if (!stream) {
      const msg = JSON.parse(body) as { content: TurnBlock[]; stop_reason: string };
      return {
        blocks: msg.content.map((b) => b.type),
        text: msg.content.map((b) => b.text ?? b.thinking ?? "").join(""),
        stop: msg.stop_reason,
      };
    }
    const events = body
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)));
    return {
      blocks: events
        .filter((e) => e.type === "content_block_start")
        .map((e) => e.content_block.type),
      text: events
        .filter((e) => e.type === "content_block_delta")
        .map((e) => e.delta.text ?? e.delta.thinking ?? "")
        .join(""),
      stop: events.find((e) => e.type === "message_delta").delta.stop_reason,
    };
  };

  it.each([
    { fault: { fault: "refusal" as const }, turn: { blocks: [], text: "", stop: "refusal" } },
    {
      fault: { fault: "empty-response" as const },
      turn: { blocks: [], text: "", stop: "end_turn" },
    },
    {
      fault: { fault: "reasoning-only" as const, reasoning: "Thinking only." },
      turn: { blocks: ["thinking"], text: "Thinking only.", stop: "max_tokens" },
    },
  ])(
    "rejects fixture files under the $fault.fault misbehavior with a coded 500",
    async ({ fault, turn }) => {
      const misbehavior = { faults: [{ ...fault, rate: 1 }] };
      instance = await createServer(
        [
          {
            match: { userMessage: "draw" },
            response: { content: "Here.", files: generatedFile },
            misbehavior,
          },
          // Control: the same fault on a servable fixture is applied on this wire.
          { match: { userMessage: "plain" }, response: { content: "Here." }, misbehavior },
        ],
        { enableMisbehavior: true },
      );
      for (const stream of [false, true]) {
        const control = await post(`${instance.url}/v1/messages`, messagesBody("plain", stream));
        expect(control.status).toBe(200);
        expect(messagesTurn(control.body, stream)).toEqual(turn);

        const res = await post(`${instance.url}/v1/messages`, messagesBody("draw", stream));
        expect(res.status).toBe(500);
        const body = JSON.parse(res.body);
        expect(body.error.code).toBe("aimock_unsupported_generated_file");
        expect(body.error.message).toContain("Anthropic Messages");
      }
    },
  );

  it("skips file citations, which Anthropic has no URL-sourced form for (both modes)", async () => {
    instance = await createServer([
      {
        match: { userMessage: "cite-file" },
        response: {
          content: "Hello.",
          citations: [
            { type: "file", fileId: "file-abc123", filename: "plan.pdf" },
            { url: "https://example.com" },
          ],
        },
      },
      {
        match: { userMessage: "file-only" },
        response: {
          content: "Hello.",
          citations: [{ type: "file", fileId: "file-abc123", filename: "plan.pdf" }],
        },
      },
    ]);
    const urlOnly = [citation("Hello.", "https://example.com", "https://example.com")];
    const res = await post(`${instance.url}/v1/messages`, messagesBody("cite-file", false));
    expect(JSON.parse(res.body).content[0].citations).toEqual(urlOnly);
    const streamed = await post(`${instance.url}/v1/messages`, messagesBody("cite-file", true));
    const deltas = parseClaudeSSEEvents(streamed.body)
      .filter((e) => (e.delta as { type?: string } | undefined)?.type === "citations_delta")
      .map((e) => (e.delta as { citation: unknown }).citation);
    expect(deltas).toEqual(urlOnly);

    const fileOnly = await post(`${instance.url}/v1/messages`, messagesBody("file-only", false));
    expect("citations" in JSON.parse(fileOnly.body).content[0]).toBe(false);
    const fileOnlyStream = await post(
      `${instance.url}/v1/messages`,
      messagesBody("file-only", true),
    );
    expect(fileOnlyStream.body).not.toContain("citations_delta");
  });
});
