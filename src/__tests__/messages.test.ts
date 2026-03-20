import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import type { Fixture } from "../types.js";
import { createServer, type ServerInstance } from "../server.js";
import { claudeToCompletionRequest } from "../messages.js";

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
    expect(body.error.message).toBe("Malformed JSON");
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
    expect(entry!.body.model).toBe("claude-3-5-sonnet-20241022");
    expect(entry!.body.messages).toEqual([
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
