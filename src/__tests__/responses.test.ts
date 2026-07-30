import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import { PassThrough } from "node:stream";
import type { Fixture } from "../types.js";
import { createServer, type ServerInstance } from "../server.js";
import {
  responsesInputToMessages,
  responsesToCompletionRequest,
  handleResponses,
  buildTextStreamEvents,
  buildContentWithToolCallsStreamEvents,
} from "../responses.js";
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

function parseResponsesSSEEvents(body: string): SSEEvent[] {
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

describe("responsesInputToMessages", () => {
  it("converts user message with string content", () => {
    const messages = responsesInputToMessages({
      model: "gpt-4",
      input: [{ role: "user", content: "hello" }],
    });
    expect(messages).toEqual([{ role: "user", content: "hello" }]);
  });

  it("converts user message with content parts", () => {
    const messages = responsesInputToMessages({
      model: "gpt-4",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "hello " },
            { type: "input_text", text: "world" },
          ],
        },
      ],
    });
    expect(messages).toEqual([{ role: "user", content: "hello world" }]);
  });

  it("converts instructions to system message", () => {
    const messages = responsesInputToMessages({
      model: "gpt-4",
      input: [{ role: "user", content: "hi" }],
      instructions: "Be helpful",
    });
    expect(messages).toEqual([
      { role: "system", content: "Be helpful" },
      { role: "user", content: "hi" },
    ]);
  });

  it("converts developer role to system message", () => {
    const messages = responsesInputToMessages({
      model: "gpt-4",
      input: [
        { role: "developer", content: "System prompt" },
        { role: "user", content: "hi" },
      ],
    });
    expect(messages).toEqual([
      { role: "system", content: "System prompt" },
      { role: "user", content: "hi" },
    ]);
  });

  it("converts assistant message", () => {
    const messages = responsesInputToMessages({
      model: "gpt-4",
      input: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
    });
    expect(messages[1]).toEqual({ role: "assistant", content: "hello" });
  });

  it("converts function_call to assistant tool_calls message", () => {
    const messages = responsesInputToMessages({
      model: "gpt-4",
      input: [
        {
          type: "function_call",
          call_id: "call_123",
          name: "get_weather",
          arguments: '{"city":"NYC"}',
        },
      ],
    });
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("assistant");
    expect(messages[0].content).toBeNull();
    expect(messages[0].tool_calls).toHaveLength(1);
    expect(messages[0].tool_calls![0].id).toBe("call_123");
    expect(messages[0].tool_calls![0].function.name).toBe("get_weather");
    expect(messages[0].tool_calls![0].function.arguments).toBe('{"city":"NYC"}');
  });

  it("converts function_call_output to tool message (with synthesized assistant)", () => {
    const messages = responsesInputToMessages({
      model: "gpt-4",
      input: [
        {
          type: "function_call_output",
          call_id: "call_123",
          output: '{"temp":72}',
        },
      ],
    });
    // Bug 1 fix: a synthetic assistant message is now prepended when no
    // matching function_call precedes the function_call_output
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("assistant");
    expect(messages[0].tool_calls![0].id).toBe("call_123");
    expect(messages[1]).toEqual({
      role: "tool",
      content: '{"temp":72}',
      tool_call_id: "call_123",
    });
  });

  it("converts item_reference to assistant placeholder", () => {
    const messages = responsesInputToMessages({
      model: "gpt-4",
      input: [
        { type: "item_reference", id: "ref_123" },
        { role: "user", content: "hi" },
      ],
    });
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: "assistant", content: "" });
    expect(messages[1]).toEqual({ role: "user", content: "hi" });
  });

  it("skips truly unknown item types (local_shell_call, mcp_list_tools, etc.)", () => {
    const messages = responsesInputToMessages({
      model: "gpt-4",
      input: [
        { type: "local_shell_call" } as { type: string; role?: string },
        { role: "user", content: "hi" },
      ],
    });
    expect(messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("handles empty content", () => {
    const messages = responsesInputToMessages({
      model: "gpt-4",
      input: [{ role: "user" }],
    });
    expect(messages).toEqual([{ role: "user", content: "" }]);
  });

  it("filters non-text content parts", () => {
    const messages = responsesInputToMessages({
      model: "gpt-4",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "hello" },
            { type: "input_image", text: "ignored" },
          ],
        },
      ],
    });
    expect(messages).toEqual([{ role: "user", content: "hello" }]);
  });
});

describe("responsesToCompletionRequest", () => {
  it("converts a full Responses API request", () => {
    const result = responsesToCompletionRequest({
      model: "gpt-4o",
      input: [{ role: "user", content: "hello" }],
      instructions: "Be concise",
      stream: true,
      temperature: 0.5,
      tools: [
        {
          type: "function",
          name: "get_weather",
          description: "Get weather info",
          parameters: { type: "object" },
        },
      ],
      tool_choice: "auto",
    });

    expect(result.model).toBe("gpt-4o");
    expect(result.stream).toBe(true);
    expect(result.temperature).toBe(0.5);
    expect(result.tool_choice).toBe("auto");
    expect(result.messages).toEqual([
      { role: "system", content: "Be concise" },
      { role: "user", content: "hello" },
    ]);
    expect(result.tools).toEqual([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather info",
          parameters: { type: "object" },
        },
      },
    ]);
  });

  it("returns undefined tools when none provided", () => {
    const result = responsesToCompletionRequest({
      model: "gpt-4",
      input: [{ role: "user", content: "hi" }],
    });
    expect(result.tools).toBeUndefined();
  });

  it("returns undefined tools for empty tools array", () => {
    const result = responsesToCompletionRequest({
      model: "gpt-4",
      input: [{ role: "user", content: "hi" }],
      tools: [],
    });
    expect(result.tools).toBeUndefined();
  });

  it("forwards max_output_tokens as max_tokens", () => {
    const result = responsesToCompletionRequest({
      model: "gpt-4o",
      input: [{ role: "user", content: "hi" }],
      max_output_tokens: 4096,
    });
    expect(result.max_tokens).toBe(4096);
  });

  it("leaves max_tokens undefined when max_output_tokens is not set", () => {
    const result = responsesToCompletionRequest({
      model: "gpt-4o",
      input: [{ role: "user", content: "hi" }],
    });
    expect(result.max_tokens).toBeUndefined();
  });

  it("forwards response_format", () => {
    const result = responsesToCompletionRequest({
      model: "gpt-4o",
      input: [{ role: "user", content: "hi" }],
      response_format: { type: "json_object" },
    });
    expect(result.response_format).toEqual({ type: "json_object" });
  });

  it("forwards response_format with json_schema", () => {
    const schema = {
      type: "json_schema",
      json_schema: { name: "my_schema", schema: { type: "object" } },
    };
    const result = responsesToCompletionRequest({
      model: "gpt-4o",
      input: [{ role: "user", content: "hi" }],
      response_format: schema,
    });
    expect(result.response_format).toEqual(schema);
  });

  it("leaves response_format undefined when not set", () => {
    const result = responsesToCompletionRequest({
      model: "gpt-4o",
      input: [{ role: "user", content: "hi" }],
    });
    expect(result.response_format).toBeUndefined();
  });
});

// ─── Integration tests: POST /v1/responses ───────────────────────────────────

describe("POST /v1/responses (streaming)", () => {
  it("streams text response with correct event types", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [{ role: "user", content: "hello" }],
      stream: true,
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream");

    const events = parseResponsesSSEEvents(res.body);

    // Check event type sequence
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("response.created");
    expect(types[1]).toBe("response.in_progress");
    expect(types).toContain("response.output_item.added");
    expect(types).toContain("response.content_part.added");
    expect(types).toContain("response.output_text.delta");
    expect(types).toContain("response.output_text.done");
    expect(types).toContain("response.content_part.done");
    expect(types).toContain("response.output_item.done");
    expect(types[types.length - 1]).toBe("response.completed");
  });

  it("text deltas include item_id", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [{ role: "user", content: "hello" }],
      stream: true,
    });

    const events = parseResponsesSSEEvents(res.body);
    const deltas = events.filter((e) => e.type === "response.output_text.delta");
    expect(deltas.length).toBeGreaterThan(0);
    for (const d of deltas) {
      expect(d.item_id).toBeDefined();
      expect(typeof d.item_id).toBe("string");
    }
  });

  it("output_text.done includes item_id", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [{ role: "user", content: "hello" }],
      stream: true,
    });

    const events = parseResponsesSSEEvents(res.body);
    const doneEvents = events.filter((e) => e.type === "response.output_text.done");
    expect(doneEvents.length).toBeGreaterThan(0);
    for (const d of doneEvents) {
      expect(d.item_id).toBeDefined();
      expect(typeof d.item_id).toBe("string");
    }
  });

  it("content_part.added includes item_id", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [{ role: "user", content: "hello" }],
      stream: true,
    });

    const events = parseResponsesSSEEvents(res.body);
    const addedEvents = events.filter((e) => e.type === "response.content_part.added");
    expect(addedEvents.length).toBeGreaterThan(0);
    for (const d of addedEvents) {
      expect(d.item_id).toBeDefined();
      expect(typeof d.item_id).toBe("string");
    }
  });

  it("content_part.done includes item_id", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [{ role: "user", content: "hello" }],
      stream: true,
    });

    const events = parseResponsesSSEEvents(res.body);
    const doneEvents = events.filter((e) => e.type === "response.content_part.done");
    expect(doneEvents.length).toBeGreaterThan(0);
    for (const d of doneEvents) {
      expect(d.item_id).toBeDefined();
      expect(typeof d.item_id).toBe("string");
    }
  });

  it("text deltas reconstruct full content", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [{ role: "user", content: "hello" }],
      stream: true,
    });

    const events = parseResponsesSSEEvents(res.body);
    const deltas = events.filter((e) => e.type === "response.output_text.delta");
    const fullText = deltas.map((d) => d.delta).join("");
    expect(fullText).toBe("Hi there!");
  });

  it("response.completed contains full output", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [{ role: "user", content: "hello" }],
      stream: true,
    });

    const events = parseResponsesSSEEvents(res.body);
    const completed = events.find((e) => e.type === "response.completed") as SSEEvent & {
      response: { status: string; output: { content: { text: string }[] }[] };
    };
    expect(completed).toBeDefined();
    expect(completed.response.status).toBe("completed");
    expect(completed.response.output[0].content[0].text).toBe("Hi there!");
  });

  it("streams tool call response with correct event types", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [{ role: "user", content: "weather" }],
      stream: true,
    });

    expect(res.status).toBe(200);

    const events = parseResponsesSSEEvents(res.body);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("response.created");
    expect(types).toContain("response.output_item.added");
    expect(types).toContain("response.function_call_arguments.delta");
    expect(types).toContain("response.function_call_arguments.done");
    expect(types).toContain("response.output_item.done");
    expect(types[types.length - 1]).toBe("response.completed");
  });

  it("tool call argument deltas include item_id", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [{ role: "user", content: "weather" }],
      stream: true,
    });

    const events = parseResponsesSSEEvents(res.body);
    const deltas = events.filter((e) => e.type === "response.function_call_arguments.delta");
    expect(deltas.length).toBeGreaterThan(0);
    for (const d of deltas) {
      expect(d.item_id).toBeDefined();
      expect(typeof d.item_id).toBe("string");
    }
  });

  it("tool call argument done events include item_id", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [{ role: "user", content: "weather" }],
      stream: true,
    });

    const events = parseResponsesSSEEvents(res.body);
    const doneEvents = events.filter((e) => e.type === "response.function_call_arguments.done");
    expect(doneEvents.length).toBeGreaterThan(0);
    for (const d of doneEvents) {
      expect(d.item_id).toBeDefined();
      expect(typeof d.item_id).toBe("string");
    }
  });

  it("tool call argument deltas reconstruct full arguments", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [{ role: "user", content: "weather" }],
      stream: true,
    });

    const events = parseResponsesSSEEvents(res.body);
    const deltas = events.filter((e) => e.type === "response.function_call_arguments.delta");
    const fullArgs = deltas.map((d) => d.delta).join("");
    expect(fullArgs).toBe('{"city":"NYC"}');
  });

  it("streams multiple tool calls with correct output_index", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [{ role: "user", content: "multi-tool" }],
      stream: true,
    });

    const events = parseResponsesSSEEvents(res.body);
    const itemAdded = events.filter((e) => e.type === "response.output_item.added");
    expect(itemAdded).toHaveLength(2);
    expect(itemAdded[0].output_index).toBe(0);
    expect(itemAdded[1].output_index).toBe(1);

    const completed = events.find((e) => e.type === "response.completed") as SSEEvent & {
      response: { output: { name: string }[] };
    };
    expect(completed.response.output).toHaveLength(2);
    expect(completed.response.output[0].name).toBe("get_weather");
    expect(completed.response.output[1].name).toBe("get_time");
  });

  it("uses fixture chunkSize for text streaming", async () => {
    const bigChunkFixture: Fixture = {
      match: { userMessage: "bigchunk" },
      response: { content: "ABCDEFGHIJ" },
      chunkSize: 5,
    };
    instance = await createServer([bigChunkFixture], { chunkSize: 2 });
    const res = await post(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [{ role: "user", content: "bigchunk" }],
      stream: true,
    });

    const events = parseResponsesSSEEvents(res.body);
    const deltas = events.filter((e) => e.type === "response.output_text.delta");
    // 10 chars / chunkSize 5 = 2 deltas
    expect(deltas).toHaveLength(2);
    expect(deltas[0].delta).toBe("ABCDE");
    expect(deltas[1].delta).toBe("FGHIJ");
  });
});

describe("POST /v1/responses (non-streaming)", () => {
  it("returns text response as JSON", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [{ role: "user", content: "hello" }],
      stream: false,
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");

    const body = JSON.parse(res.body);
    expect(body.object).toBe("response");
    expect(body.status).toBe("completed");
    expect(body.output).toHaveLength(1);
    expect(body.output[0].type).toBe("message");
    expect(body.output[0].role).toBe("assistant");
    expect(body.output[0].content[0].type).toBe("output_text");
    expect(body.output[0].content[0].text).toBe("Hi there!");
  });

  it("returns tool call response as JSON", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [{ role: "user", content: "weather" }],
      stream: false,
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.object).toBe("response");
    expect(body.status).toBe("completed");
    expect(body.output).toHaveLength(1);
    expect(body.output[0].type).toBe("function_call");
    expect(body.output[0].name).toBe("get_weather");
    expect(body.output[0].arguments).toBe('{"city":"NYC"}');
    expect(body.output[0].call_id).toBeDefined();
  });

  it("returns multiple tool calls as JSON", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [{ role: "user", content: "multi-tool" }],
      stream: false,
    });

    const body = JSON.parse(res.body);
    expect(body.output).toHaveLength(2);
    expect(body.output[0].name).toBe("get_weather");
    expect(body.output[1].name).toBe("get_time");
  });
});

describe("POST /v1/responses (default non-streaming)", () => {
  it("returns JSON response when stream field is omitted", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [{ role: "user", content: "hello" }],
      // stream field intentionally omitted
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");

    const body = JSON.parse(res.body);
    expect(body.object).toBe("response");
    expect(body.status).toBe("completed");
    expect(body.output[0].content[0].text).toBe("Hi there!");
  });

  it("returns JSON tool call response when stream field is omitted", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [{ role: "user", content: "weather" }],
      // stream field intentionally omitted
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");

    const body = JSON.parse(res.body);
    expect(body.object).toBe("response");
    expect(body.output[0].type).toBe("function_call");
    expect(body.output[0].name).toBe("get_weather");
  });
});

describe("POST /v1/responses (error handling)", () => {
  it("returns error fixture with correct status", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [{ role: "user", content: "fail" }],
    });

    expect(res.status).toBe(429);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("Rate limited");
  });

  it("returns 404 when no fixture matches", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [{ role: "user", content: "unknown" }],
    });

    expect(res.status).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("No fixture matched");
    expect(body.error.code).toBe("no_fixture_match");
  });

  it("returns 400 for malformed JSON", async () => {
    instance = await createServer(allFixtures);
    const res = await postRaw(`${instance.url}/v1/responses`, "{not valid");

    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.message).toMatch(/^Malformed JSON: /);
    expect(body.error.code).toBe("invalid_json");
  });

  it("returns 500 for unknown response type", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [{ role: "user", content: "badtype" }],
    });

    expect(res.status).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error.message).toContain("did not match any known type");
  });
});

describe("POST /v1/responses (journal)", () => {
  it("records successful text response", async () => {
    instance = await createServer(allFixtures);
    await post(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [{ role: "user", content: "hello" }],
    });

    expect(instance.journal.size).toBe(1);
    const entry = instance.journal.getLast();
    expect(entry!.path).toBe("/v1/responses");
    expect(entry!.response.status).toBe(200);
    expect(entry!.response.fixture).toBe(textFixture);
  });

  it("records unmatched response with null fixture", async () => {
    instance = await createServer(allFixtures);
    await post(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [{ role: "user", content: "nomatch" }],
    });

    const entry = instance.journal.getLast();
    expect(entry!.response.status).toBe(404);
    expect(entry!.response.fixture).toBeNull();
  });

  it("records error fixture response", async () => {
    instance = await createServer(allFixtures);
    await post(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [{ role: "user", content: "fail" }],
    });

    const entry = instance.journal.getLast();
    expect(entry!.response.status).toBe(429);
    expect(entry!.response.fixture).toBe(errorFixture);
  });

  it("journal body contains converted ChatCompletionRequest", async () => {
    instance = await createServer(allFixtures);
    await post(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [{ role: "user", content: "hello" }],
      instructions: "Be nice",
    });

    const entry = instance.journal.getLast();
    expect(entry!.body.model).toBe("gpt-4");
    expect(entry!.body.messages).toEqual([
      { role: "system", content: "Be nice" },
      { role: "user", content: "hello" },
    ]);
  });
});

describe("POST /v1/responses (CORS)", () => {
  it("includes CORS headers", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [{ role: "user", content: "hello" }],
    });

    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });
});

// ─── Branch coverage: ?? defaults and fallback paths ─────────────────────────

describe("responsesInputToMessages (fallback branches)", () => {
  it("generates call_id when function_call has no call_id", () => {
    const messages = responsesInputToMessages({
      model: "gpt-4",
      input: [
        {
          type: "function_call",
          name: "do_thing",
          arguments: '{"x":1}',
          // call_id intentionally omitted
        },
      ],
    });
    expect(messages).toHaveLength(1);
    expect(messages[0].tool_calls![0].id).toMatch(/^call_/);
  });

  it("defaults name to empty string when function_call has no name", () => {
    const messages = responsesInputToMessages({
      model: "gpt-4",
      input: [
        {
          type: "function_call",
          call_id: "call_abc",
          // name intentionally omitted
          arguments: '{"x":1}',
        },
      ],
    });
    expect(messages[0].tool_calls![0].function.name).toBe("");
  });

  it("defaults arguments to empty string when function_call has no arguments", () => {
    const messages = responsesInputToMessages({
      model: "gpt-4",
      input: [
        {
          type: "function_call",
          call_id: "call_abc",
          name: "do_thing",
          // arguments intentionally omitted
        },
      ],
    });
    expect(messages[0].tool_calls![0].function.arguments).toBe("");
  });

  it("defaults output to empty string when function_call_output has no output", () => {
    const messages = responsesInputToMessages({
      model: "gpt-4",
      input: [
        {
          type: "function_call_output",
          call_id: "call_abc",
          // output intentionally omitted
        },
      ],
    });
    // messages[0] is the synthesized assistant (Bug 1 fix), messages[1] is the tool
    expect(messages).toHaveLength(2);
    expect(messages[1].role).toBe("tool");
    expect(messages[1].content).toBe("");
  });

  it("handles content parts with missing text (text ?? '')", () => {
    const messages = responsesInputToMessages({
      model: "gpt-4",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text" }, // text field missing
          ] as Array<{ type: string; text?: string }>,
        },
      ],
    });
    expect(messages[0].content).toBe("");
  });

  it("handles output_text content parts", () => {
    const messages = responsesInputToMessages({
      model: "gpt-4",
      input: [
        {
          role: "assistant",
          content: [{ type: "output_text", text: "response text" }] as Array<{
            type: string;
            text?: string;
          }>,
        },
      ],
    });
    expect(messages[0].content).toBe("response text");
  });

  it("handles system role input item", () => {
    const messages = responsesInputToMessages({
      model: "gpt-4",
      input: [{ role: "system", content: "You are helpful" }],
    });
    expect(messages).toEqual([{ role: "system", content: "You are helpful" }]);
  });
});

describe("responsesToCompletionRequest (tool filtering)", () => {
  it("filters out non-function type tools", () => {
    const result = responsesToCompletionRequest({
      model: "gpt-4",
      input: [{ role: "user", content: "hi" }],
      tools: [
        { type: "function", name: "real_tool", description: "a tool" },
        { type: "web_search" as "function", name: "web", description: "search" },
      ],
    });
    // Only the "function" type tool should be included
    expect(result.tools).toHaveLength(1);
    expect(result.tools![0].function.name).toBe("real_tool");
  });
});

describe("POST /v1/responses (strict mode)", () => {
  it("returns 503 when strict mode is enabled and no fixture matches", async () => {
    instance = await createServer([], { strict: true });
    const res = await post(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [{ role: "user", content: "unmatched" }],
    });

    expect(res.status).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("Strict mode: no fixture matched");
    expect(body.error.code).toBe("no_fixture_match");
  });

  it("returns the skipped-by-state message when a sequence-exhausted fixture is replayed", async () => {
    const seqFixture: Fixture = {
      match: { userMessage: "hello", sequenceIndex: 0 },
      response: { content: "Hi there!" },
    };
    instance = await createServer([seqFixture], { strict: true });
    // First call consumes the sequenceIndex:0 fixture (count → 1).
    const first = await post(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [{ role: "user", content: "hello" }],
    });
    expect(first.status).toBe(200);
    // Replay: shape still matches but the fixture is skipped by sequence state.
    const res = await post(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [{ role: "user", content: "hello" }],
    });
    expect(res.status).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.error.message).toMatch(SKIPPED_BY_STATE_RE);
  });
});

describe("POST /v1/responses (error response with default status)", () => {
  it("defaults error status to 500 when status is omitted", async () => {
    const errorNoStatus: Fixture = {
      match: { userMessage: "error-no-status" },
      response: {
        error: {
          message: "Something broke",
          type: "server_error",
        },
      } as Fixture["response"],
    };
    instance = await createServer([errorNoStatus]);
    const res = await post(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [{ role: "user", content: "error-no-status" }],
    });

    expect(res.status).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("Something broke");
  });
});

describe("POST /v1/responses (latency and chunkSize defaults)", () => {
  it("uses server default latency when fixture has no latency", async () => {
    instance = await createServer([textFixture], { latency: 0 });
    const res = await post(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [{ role: "user", content: "hello" }],
      stream: true,
    });
    expect(res.status).toBe(200);
    const events = parseResponsesSSEEvents(res.body);
    expect(events.length).toBeGreaterThan(0);
  });

  it("uses server default chunkSize when fixture has no chunkSize", async () => {
    instance = await createServer([textFixture], { chunkSize: 3 });
    const res = await post(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [{ role: "user", content: "hello" }],
      stream: true,
    });
    expect(res.status).toBe(200);
    const events = parseResponsesSSEEvents(res.body);
    const deltas = events.filter((e) => e.type === "response.output_text.delta");
    // "Hi there!" = 9 chars, chunkSize 3 => 3 deltas
    expect(deltas).toHaveLength(3);
  });
});

describe("POST /v1/responses (tool call with explicit id)", () => {
  it("uses explicit tool call id when provided", async () => {
    const toolWithId: Fixture = {
      match: { userMessage: "tool-with-id" },
      response: {
        toolCalls: [
          {
            id: "call_explicit_123",
            name: "my_func",
            arguments: '{"a":1}',
          },
        ],
      },
    };
    instance = await createServer([toolWithId]);

    // Non-streaming
    const res = await post(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [{ role: "user", content: "tool-with-id" }],
      stream: false,
    });
    const body = JSON.parse(res.body);
    expect(body.output[0].call_id).toBe("call_explicit_123");
  });

  it("uses explicit tool call id in streaming mode", async () => {
    const toolWithId: Fixture = {
      match: { userMessage: "tool-with-id-stream" },
      response: {
        toolCalls: [
          {
            id: "call_explicit_456",
            name: "my_func",
            arguments: '{"a":1}',
          },
        ],
      },
    };
    instance = await createServer([toolWithId]);

    const res = await post(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [{ role: "user", content: "tool-with-id-stream" }],
      stream: true,
    });
    const events = parseResponsesSSEEvents(res.body);
    const itemAdded = events.find((e) => e.type === "response.output_item.added") as SSEEvent & {
      item: { call_id: string };
    };
    expect(itemAdded.item.call_id).toBe("call_explicit_456");
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

    const res = await post(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [{ role: "user", content: "tool-empty-id" }],
      stream: false,
    });
    const body = JSON.parse(res.body);
    // Empty string is falsy, so it should generate an id
    expect(body.output[0].call_id).toMatch(/^call_/);
  });
});

describe("POST /v1/responses (streaming interruption)", () => {
  it("truncates text stream after specified chunks and records interruption", async () => {
    const truncatedFixture: Fixture = {
      match: { userMessage: "truncate-text" },
      response: { content: "ABCDEFGHIJKLMNOP" },
      chunkSize: 1,
      truncateAfterChunks: 2,
    };
    instance = await createServer([truncatedFixture]);
    try {
      await post(`${instance.url}/v1/responses`, {
        model: "gpt-4",
        input: [{ role: "user", content: "truncate-text" }],
        stream: true,
      });
    } catch {
      // Expected: socket hang up due to server destroying connection
    }

    // Wait briefly for journal to be updated
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
      await post(`${instance.url}/v1/responses`, {
        model: "gpt-4",
        input: [{ role: "user", content: "truncate-tool" }],
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

describe("POST /v1/responses (streaming text — journal records tool call fixture)", () => {
  it("records streaming tool call response in journal", async () => {
    instance = await createServer(allFixtures);
    await post(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [{ role: "user", content: "weather" }],
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
  res.writeHead = (statusCode: number, hdrs?: Record<string, string>) => {
    (res as { statusCode: number }).statusCode = statusCode;
    if (hdrs) {
      for (const [k, v] of Object.entries(hdrs)) {
        headers[k.toLowerCase()] = v;
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

describe("handleResponses (direct call — ?? fallback branches)", () => {
  it("uses fallback POST and /v1/responses when req.method and req.url are undefined", async () => {
    const journal = new Journal();
    const logger = new Logger("silent");
    const defaults = { latency: 0, chunkSize: 10, logger };

    const mockReq = {
      method: undefined,
      url: undefined,
      headers: {},
    } as unknown as http.IncomingMessage;

    const mockRes = createMockRes();

    await handleResponses(
      mockReq,
      mockRes,
      JSON.stringify({
        model: "gpt-4",
        input: [{ role: "user", content: "hello" }],
      }),
      [textFixture],
      journal,
      defaults,
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.path).toBe("/v1/responses");
    expect(entry!.response.status).toBe(200);
  });

  it("uses fallback method/path on malformed JSON with undefined req fields", async () => {
    const journal = new Journal();
    const logger = new Logger("silent");
    const defaults = { latency: 0, chunkSize: 10, logger };

    const mockReq = {
      method: undefined,
      url: undefined,
      headers: {},
    } as unknown as http.IncomingMessage;

    const mockRes = createMockRes();

    await handleResponses(mockReq, mockRes, "{bad", [], journal, defaults, () => {});

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.path).toBe("/v1/responses");
    expect(entry!.response.status).toBe(400);
  });

  it("uses fallback method/path on no-match with undefined req fields", async () => {
    const journal = new Journal();
    const logger = new Logger("silent");
    const defaults = { latency: 0, chunkSize: 10, logger };

    const mockReq = {
      method: undefined,
      url: undefined,
      headers: {},
    } as unknown as http.IncomingMessage;

    const mockRes = createMockRes();

    await handleResponses(
      mockReq,
      mockRes,
      JSON.stringify({
        model: "gpt-4",
        input: [{ role: "user", content: "nomatch" }],
      }),
      [],
      journal,
      defaults,
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.path).toBe("/v1/responses");
    expect(entry!.response.status).toBe(404);
  });

  it("uses fallback method/path for error fixture with undefined req fields", async () => {
    const journal = new Journal();
    const logger = new Logger("silent");
    const defaults = { latency: 0, chunkSize: 10, logger };

    const mockReq = {
      method: undefined,
      url: undefined,
      headers: {},
    } as unknown as http.IncomingMessage;

    const mockRes = createMockRes();

    await handleResponses(
      mockReq,
      mockRes,
      JSON.stringify({
        model: "gpt-4",
        input: [{ role: "user", content: "fail" }],
      }),
      [errorFixture],
      journal,
      defaults,
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.path).toBe("/v1/responses");
    expect(entry!.response.status).toBe(429);
  });

  it("uses fallback for streaming text with undefined req fields", async () => {
    const journal = new Journal();
    const logger = new Logger("silent");
    const defaults = { latency: 0, chunkSize: 10, logger };

    const mockReq = {
      method: undefined,
      url: undefined,
      headers: {},
    } as unknown as http.IncomingMessage;

    const mockRes = createMockRes();

    await handleResponses(
      mockReq,
      mockRes,
      JSON.stringify({
        model: "gpt-4",
        input: [{ role: "user", content: "hello" }],
        stream: true,
      }),
      [textFixture],
      journal,
      defaults,
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.path).toBe("/v1/responses");
    expect(entry!.response.status).toBe(200);
  });

  it("uses fallback for streaming tool call with undefined req fields", async () => {
    const journal = new Journal();
    const logger = new Logger("silent");
    const defaults = { latency: 0, chunkSize: 10, logger };

    const mockReq = {
      method: undefined,
      url: undefined,
      headers: {},
    } as unknown as http.IncomingMessage;

    const mockRes = createMockRes();

    await handleResponses(
      mockReq,
      mockRes,
      JSON.stringify({
        model: "gpt-4",
        input: [{ role: "user", content: "weather" }],
        stream: true,
      }),
      [toolFixture],
      journal,
      defaults,
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.path).toBe("/v1/responses");
    expect(entry!.response.status).toBe(200);
  });

  it("uses fallback for unknown response type with undefined req fields", async () => {
    const journal = new Journal();
    const logger = new Logger("silent");
    const defaults = { latency: 0, chunkSize: 10, logger };

    const mockReq = {
      method: undefined,
      url: undefined,
      headers: {},
    } as unknown as http.IncomingMessage;

    const mockRes = createMockRes();

    await handleResponses(
      mockReq,
      mockRes,
      JSON.stringify({
        model: "gpt-4",
        input: [{ role: "user", content: "badtype" }],
      }),
      [badResponseFixture],
      journal,
      defaults,
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.path).toBe("/v1/responses");
    expect(entry!.response.status).toBe(500);
  });

  it("uses fallback for strict mode no-match with undefined req fields", async () => {
    const journal = new Journal();
    const logger = new Logger("silent");
    const defaults = { latency: 0, chunkSize: 10, logger, strict: true };

    const mockReq = {
      method: undefined,
      url: undefined,
      headers: {},
    } as unknown as http.IncomingMessage;

    const mockRes = createMockRes();

    await handleResponses(
      mockReq,
      mockRes,
      JSON.stringify({
        model: "gpt-4",
        input: [{ role: "user", content: "nomatch" }],
      }),
      [],
      journal,
      defaults,
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.path).toBe("/v1/responses");
    expect(entry!.response.status).toBe(503);
  });
});

// ─── Bug 1: item_reference dropped → turnIndex stuck at 0 ──────────────────

describe("Bug 1: item_reference + function_call_output synthesizes assistant", () => {
  it("[user, item_reference, function_call_output] produces user, assistant(synthetic), tool", () => {
    const messages = responsesInputToMessages({
      model: "gpt-4",
      input: [
        { role: "user", content: "hello" },
        { type: "item_reference", id: "ref_fc_123" },
        { type: "function_call_output", call_id: "call_abc", output: '{"result":42}' },
      ],
    });

    expect(messages).toHaveLength(3);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content).toBeNull();
    expect(messages[1].tool_calls).toHaveLength(1);
    expect(messages[1].tool_calls![0].id).toBe("call_abc");
    expect(messages[2].role).toBe("tool");
    expect(messages[2].content).toBe('{"result":42}');
    expect(messages[2].tool_call_id).toBe("call_abc");
  });

  it("[user, function_call, function_call_output] produces NO duplicate assistant", () => {
    const messages = responsesInputToMessages({
      model: "gpt-4",
      input: [
        { role: "user", content: "hello" },
        {
          type: "function_call",
          call_id: "call_real",
          name: "get_weather",
          arguments: '{"city":"NYC"}',
        },
        { type: "function_call_output", call_id: "call_real", output: '{"temp":72}' },
      ],
    });

    expect(messages).toHaveLength(3);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].tool_calls![0].id).toBe("call_real");
    expect(messages[1].tool_calls![0].function.name).toBe("get_weather");
    expect(messages[2].role).toBe("tool");
  });

  it("assistantCount equals 1 after [user, item_reference, function_call_output]", () => {
    const messages = responsesInputToMessages({
      model: "gpt-4",
      input: [
        { role: "user", content: "hello" },
        { type: "item_reference", id: "ref_123" },
        { type: "function_call_output", call_id: "call_xyz", output: "{}" },
      ],
    });

    const assistantCount = messages.filter((m) => m.role === "assistant").length;
    expect(assistantCount).toBe(1);
  });

  it("function_call_output without preceding item_reference or function_call still synthesizes", () => {
    const messages = responsesInputToMessages({
      model: "gpt-4",
      input: [
        { role: "user", content: "hello" },
        { type: "function_call_output", call_id: "call_orphan", output: '{"x":1}' },
      ],
    });

    expect(messages).toHaveLength(3);
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].tool_calls![0].id).toBe("call_orphan");
    expect(messages[2].role).toBe("tool");
  });
});

// ─── Bug 2: annotations missing on output_text content items ────────────────

describe("Bug 2: output_text includes annotations: []", () => {
  it("streaming content_part.added has annotations: []", () => {
    const events = buildTextStreamEvents("Hello", "gpt-4", 100);
    const partAdded = events.find((e) => e.type === "response.content_part.added");
    expect(partAdded).toBeDefined();
    const part = (partAdded as { part: { type: string; annotations: unknown[] } }).part;
    expect(part.type).toBe("output_text");
    expect(part.annotations).toEqual([]);
  });

  it("streaming content_part.done has annotations: []", () => {
    const events = buildTextStreamEvents("Hello", "gpt-4", 100);
    const partDone = events.find((e) => e.type === "response.content_part.done");
    expect(partDone).toBeDefined();
    const part = (partDone as { part: { type: string; text: string; annotations: unknown[] } })
      .part;
    expect(part.type).toBe("output_text");
    expect(part.text).toBe("Hello");
    expect(part.annotations).toEqual([]);
  });

  it("streaming output_item.done message content has annotations: []", () => {
    const events = buildTextStreamEvents("Hello", "gpt-4", 100);
    const itemDone = events.find(
      (e) =>
        e.type === "response.output_item.done" && (e.item as { type: string })?.type === "message",
    );
    expect(itemDone).toBeDefined();
    const item = itemDone!.item as { content: { type: string; annotations: unknown[] }[] };
    expect(item.content[0].annotations).toEqual([]);
  });

  it("streaming response.completed output message content has annotations: []", () => {
    const events = buildTextStreamEvents("Hello", "gpt-4", 100);
    const completed = events.find((e) => e.type === "response.completed");
    expect(completed).toBeDefined();
    const response = completed!.response as { output: { content: { annotations: unknown[] }[] }[] };
    const msgOutput = response.output.find(
      (o: { type?: string }) => (o as { type: string }).type === "message",
    ) as { content: { annotations: unknown[] }[] };
    expect(msgOutput).toBeDefined();
    expect(msgOutput.content[0].annotations).toEqual([]);
  });

  it("non-streaming response output_text has annotations: []", async () => {
    const textFix: Fixture = {
      match: { userMessage: "annotations-check" },
      response: { content: "annotated" },
    };
    instance = await createServer([textFix]);
    const res = await post(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [{ role: "user", content: "annotations-check" }],
      stream: false,
    });

    const body = JSON.parse(res.body);
    expect(body.output[0].content[0].annotations).toEqual([]);
  });

  it("content+toolCalls streaming has annotations: [] on output_text", () => {
    const events = buildContentWithToolCallsStreamEvents(
      "some text",
      [{ name: "fn", arguments: "{}" }],
      "gpt-4",
      100,
    );
    const partAdded = events.find((e) => e.type === "response.content_part.added");
    expect(partAdded).toBeDefined();
    const part = (partAdded as { part: { annotations: unknown[] } }).part;
    expect(part.annotations).toEqual([]);
  });
});

// ─── Bug 3 & 4: item_id missing on reasoning_summary_part events ────────────

describe("Bug 3 & 4: reasoning_summary_part events include item_id", () => {
  it("reasoning_summary_part.added includes item_id", () => {
    const events = buildTextStreamEvents("result", "gpt-4", 100, "thinking...");
    const partAdded = events.find((e) => e.type === "response.reasoning_summary_part.added");
    expect(partAdded).toBeDefined();
    expect(partAdded!.item_id).toBeDefined();
    expect(typeof partAdded!.item_id).toBe("string");
  });

  it("reasoning_summary_part.done includes item_id", () => {
    const events = buildTextStreamEvents("result", "gpt-4", 100, "thinking...");
    const partDone = events.find((e) => e.type === "response.reasoning_summary_part.done");
    expect(partDone).toBeDefined();
    expect(partDone!.item_id).toBeDefined();
    expect(typeof partDone!.item_id).toBe("string");
  });

  it("reasoning_summary_part.added and .done share the same item_id as the reasoning item", () => {
    const events = buildTextStreamEvents("result", "gpt-4", 100, "thinking...");
    const reasoningAdded = events.find(
      (e) =>
        e.type === "response.output_item.added" &&
        (e.item as { type: string })?.type === "reasoning",
    );
    const partAdded = events.find((e) => e.type === "response.reasoning_summary_part.added");
    const partDone = events.find((e) => e.type === "response.reasoning_summary_part.done");

    const reasoningId = (reasoningAdded!.item as { id: string }).id;
    expect(partAdded!.item_id).toBe(reasoningId);
    expect(partDone!.item_id).toBe(reasoningId);
  });
});

// ─── Bug 5: web_search_call action missing type:"search" ────────────────────

describe("Bug 5: web_search_call action includes type:search", () => {
  it("streaming web_search_call output_item.added has action.type=search", () => {
    const events = buildTextStreamEvents("result", "gpt-4", 100, undefined, ["test query"]);
    const searchAdded = events.find(
      (e) =>
        e.type === "response.output_item.added" &&
        (e.item as { type: string })?.type === "web_search_call",
    );
    expect(searchAdded).toBeDefined();
    const action = (searchAdded!.item as { action: { type: string; query: string } }).action;
    expect(action.type).toBe("search");
    expect(action.query).toBe("test query");
  });

  it("streaming web_search_call output_item.done has action.type=search", () => {
    const events = buildTextStreamEvents("result", "gpt-4", 100, undefined, ["test query"]);
    const searchDone = events.find(
      (e) =>
        e.type === "response.output_item.done" &&
        (e.item as { type: string })?.type === "web_search_call",
    );
    expect(searchDone).toBeDefined();
    const action = (searchDone!.item as { action: { type: string; query: string } }).action;
    expect(action.type).toBe("search");
    expect(action.query).toBe("test query");
  });

  it("non-streaming web_search_call has action.type=search", async () => {
    const webSearchFixture: Fixture = {
      match: { userMessage: "search-action-type" },
      response: { content: "found it", webSearches: ["copilotkit docs"] },
    };
    instance = await createServer([webSearchFixture]);
    const res = await post(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [{ role: "user", content: "search-action-type" }],
      stream: false,
    });

    const body = JSON.parse(res.body);
    const searchItem = body.output.find((o: { type: string }) => o.type === "web_search_call");
    expect(searchItem).toBeDefined();
    expect(searchItem.action.type).toBe("search");
    expect(searchItem.action.query).toBe("copilotkit docs");
  });

  it("multiple web searches all have action.type=search", () => {
    const events = buildTextStreamEvents("result", "gpt-4", 100, undefined, ["query1", "query2"]);
    const searchItems = events.filter(
      (e) =>
        e.type === "response.output_item.done" &&
        (e.item as { type: string })?.type === "web_search_call",
    );
    expect(searchItems).toHaveLength(2);
    for (const item of searchItems) {
      const action = (item.item as { action: { type: string } }).action;
      expect(action.type).toBe("search");
    }
  });
});

// ─── Bug 6: item_reference for assistant text messages ──────────────────────

describe("Bug 6: item_reference for assistant text turns counted in assistantCount", () => {
  it("[user, item_reference(text), user_2] → assistantCount = 1", () => {
    const messages = responsesInputToMessages({
      model: "gpt-4",
      input: [
        { role: "user", content: "hello" },
        { type: "item_reference", id: "ref_text_msg" },
        { role: "user", content: "follow up" },
      ],
    });

    expect(messages).toHaveLength(3);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content).toBe("");
    expect(messages[2].role).toBe("user");

    const assistantCount = messages.filter((m) => m.role === "assistant").length;
    expect(assistantCount).toBe(1);
  });

  it("[user, item_reference(fc), function_call_output, user_2] → assistantCount = 1 (not 2)", () => {
    const messages = responsesInputToMessages({
      model: "gpt-4",
      input: [
        { role: "user", content: "hello" },
        { type: "item_reference", id: "ref_fc" },
        { type: "function_call_output", call_id: "call_fc", output: '{"ok":true}' },
        { role: "user", content: "next" },
      ],
    });

    const assistantCount = messages.filter((m) => m.role === "assistant").length;
    expect(assistantCount).toBe(1);
    // The item_reference placeholder was upgraded to carry tool_calls
    const assistantMsg = messages.find((m) => m.role === "assistant")!;
    expect(assistantMsg.tool_calls).toHaveLength(1);
    expect(assistantMsg.tool_calls![0].id).toBe("call_fc");
  });

  it("[user, item_ref(text), user_2, item_ref(fc), function_call_output] → assistantCount = 2", () => {
    const messages = responsesInputToMessages({
      model: "gpt-4",
      input: [
        { role: "user", content: "hello" },
        { type: "item_reference", id: "ref_text" },
        { role: "user", content: "follow up" },
        { type: "item_reference", id: "ref_fc" },
        { type: "function_call_output", call_id: "call_fc2", output: '{"done":true}' },
      ],
    });

    const assistantMsgs = messages.filter((m) => m.role === "assistant");
    expect(assistantMsgs).toHaveLength(2);

    // First assistant is a text placeholder (no tool_calls)
    expect(assistantMsgs[0].content).toBe("");
    expect(assistantMsgs[0].tool_calls).toBeUndefined();

    // Second assistant was upgraded from item_reference to carry tool_calls
    expect(assistantMsgs[1].content).toBeNull();
    expect(assistantMsgs[1].tool_calls).toHaveLength(1);
    expect(assistantMsgs[1].tool_calls![0].id).toBe("call_fc2");
  });

  it("multiple item_references without function_call_output all count", () => {
    const messages = responsesInputToMessages({
      model: "gpt-4",
      input: [
        { role: "user", content: "q1" },
        { type: "item_reference", id: "ref_1" },
        { role: "user", content: "q2" },
        { type: "item_reference", id: "ref_2" },
        { role: "user", content: "q3" },
      ],
    });

    const assistantCount = messages.filter((m) => m.role === "assistant").length;
    expect(assistantCount).toBe(2);
    expect(messages).toHaveLength(5);
  });
});

// ─── Bug fix: reasoning_summary_text.done must include item_id ──────────────

describe("reasoning_summary_text.done includes item_id", () => {
  it("reasoning_summary_text.done has item_id matching the reasoning item", () => {
    const events = buildTextStreamEvents("result", "gpt-4", 100, "thinking hard");
    const textDone = events.find((e) => e.type === "response.reasoning_summary_text.done");
    expect(textDone).toBeDefined();
    expect(textDone!.item_id).toBeDefined();
    expect(typeof textDone!.item_id).toBe("string");

    // Verify it matches the reasoning item id
    const reasoningAdded = events.find(
      (e) =>
        e.type === "response.output_item.added" &&
        (e.item as { type: string })?.type === "reasoning",
    );
    const reasoningId = (reasoningAdded!.item as { id: string }).id;
    expect(textDone!.item_id).toBe(reasoningId);
  });
});

// ─── reasoning.encrypted_content (microsoft/agent-framework#7233) ────────────
//
// Real OpenAI populates an opaque `encrypted_content` blob on the reasoning item
// when the request opts in via `include: ["reasoning.encrypted_content"]` OR is
// stateless (`store:false`) — the path used by agent-framework-openai >= 1.11.0.
// aimock synthesizes a deterministic placeholder so that client can replay the
// reasoning item instead of hard-failing the reasoning + multi-tool follow-up
// request.
//
// aimock carries the blob on the TERMINAL (`output_item.done`) reasoning item and
// deliberately omits it from the in-progress `added` item. That is aimock's own
// CHOICE, not upstream parity — real OpenAI DOES populate `added`, but the field
// is `anyOf: [string, null]` and non-required, so `done` is where consumers must
// read it and omitting it on `added` is legal.

describe("reasoning.encrypted_content emission", () => {
  // Mirror of `syntheticEncryptedReasoning` in responses.ts — pins the id→blob
  // relationship so a non-deterministic (e.g. Math.random) blob is caught.
  const expectedBlob = (id: string): string =>
    Buffer.from(`aimock-encrypted-reasoning:${id}`).toString("base64");

  function reasoningItem(
    events: SSEEvent[],
    kind: "added" | "done",
  ): { id: string; encrypted_content?: string } | undefined {
    const ev = events.find(
      (e) =>
        e.type === `response.output_item.${kind}` &&
        (e.item as { type?: string })?.type === "reasoning",
    );
    return ev?.item as { id: string; encrypted_content?: string } | undefined;
  }

  // Pins aimock's deliberate omission of the blob on the in-progress `added` item
  // even when the gate is ON (see the header note — legal, but NOT a claim about
  // what upstream does). This replaces a conditional-expect helper that could
  // never fire: aimock builds the `added` item with no `emitEncrypted` opt at all,
  // so the guarded branch was unreachable and every call site asserted nothing.
  const expectAddedOmitsBlob = (item: object): void => {
    expect(item).not.toHaveProperty("encrypted_content");
  };

  const reasoningTextFixture: Fixture = {
    match: { userMessage: "textreason" },
    response: { content: "AAPL vs MSFT", reasoning: "Look up AAPL, then MSFT." },
  };
  const reasoningToolFixture: Fixture = {
    match: { userMessage: "toolreason" },
    response: { toolCalls: [{ name: "get_stock", arguments: "{}" }], reasoning: "Call the tool." },
  };
  const reasoningContentToolFixture: Fixture = {
    match: { userMessage: "bothreason" },
    response: {
      content: "done",
      toolCalls: [{ name: "get_stock", arguments: "{}" }],
      reasoning: "Think, then call.",
    },
  };
  // `blocks` forces the positional NEW branch of buildContentWithToolCalls* (both
  // streaming and non-streaming), which builds its own reasoning item.
  const reasoningBlocksFixture: Fixture = {
    match: { userMessage: "blocksreason" },
    response: {
      content: "done",
      toolCalls: [{ name: "get_stock", arguments: "{}" }],
      reasoning: "Think, then call.",
      blocks: [
        { type: "toolCall", name: "get_stock", arguments: "{}" },
        { type: "text", text: "done" },
      ],
    },
  };

  // --- Builder-level: placement + determinism ---

  it("builder omits encrypted_content everywhere when the flag is off", () => {
    const events = buildTextStreamEvents("result", "gpt-5-test", 100, "thinking...");
    expect(reasoningItem(events, "added")!.encrypted_content).toBeUndefined();
    expect(reasoningItem(events, "done")!.encrypted_content).toBeUndefined();
  });

  it("builder emits the blob on the done item, deterministic by id", () => {
    // trailing `true` = emitEncryptedReasoning
    const events = buildTextStreamEvents(
      "result",
      "gpt-5-test",
      100,
      "thinking...",
      undefined,
      undefined,
      true,
    );
    const done = reasoningItem(events, "done")!;
    expect(done.encrypted_content).toBe(expectedBlob(done.id)); // pins presence + determinism
    expectAddedOmitsBlob(reasoningItem(events, "added")!);
  });

  // --- HTTP streaming: every builder + gate triggers + completed.output ---

  async function streamReasoning(
    fixture: Fixture,
    userMessage: string,
    body: Record<string, unknown>,
  ): Promise<SSEEvent[]> {
    instance = await createServer([fixture]);
    const res = await post(`${instance!.url}/v1/responses`, {
      model: "gpt-5-test",
      input: [{ role: "user", content: userMessage }],
      stream: true,
      ...body,
    });
    expect(res.status).toBe(200);
    return parseResponsesSSEEvents(res.body);
  }

  const OPT_IN = { include: ["reasoning.encrypted_content"] };

  // One case per streaming builder: buildTextStreamEvents,
  // buildToolCallStreamEvents, buildContentWithToolCallsStreamEvents (legacy +
  // blocks branches). Each must carry the blob on the done reasoning item.
  const streamingCases: [string, Fixture, string][] = [
    ["text (buildTextStreamEvents)", reasoningTextFixture, "textreason"],
    ["tool-only (buildToolCallStreamEvents)", reasoningToolFixture, "toolreason"],
    [
      "content+tool legacy (buildContentWithToolCallsStreamEvents)",
      reasoningContentToolFixture,
      "bothreason",
    ],
    [
      "content+tool blocks (buildContentWithToolCallsStreamEvents)",
      reasoningBlocksFixture,
      "blocksreason",
    ],
  ];

  for (const [label, fixture, msg] of streamingCases) {
    it(`streaming ${label} carries the blob on done when opted in`, async () => {
      const events = await streamReasoning(fixture, msg, OPT_IN);
      const done = reasoningItem(events, "done")!;
      expect(done, "no done reasoning item").toBeDefined();
      expect(done.encrypted_content).toBe(expectedBlob(done.id));
      expectAddedOmitsBlob(reasoningItem(events, "added")!);
    });
  }

  it("streaming reflects the blob in response.completed.output", async () => {
    const events = await streamReasoning(reasoningTextFixture, "textreason", OPT_IN);
    const completed = events.find((e) => e.type === "response.completed") as SSEEvent & {
      response: { output: { type: string; id: string; encrypted_content?: string }[] };
    };
    const outputReasoning = completed.response.output.find((o) => o.type === "reasoning");
    expect(outputReasoning, "no reasoning item in completed.output").toBeDefined();
    // Pin the blob INDEPENDENTLY, against the id-derived expectation — NOT against
    // the `output_item.done` event's item. `buildResponsePreamble` pushes that very
    // object into `prefixOutputItems`, so the two are the SAME REFERENCE and
    // comparing them is `undefined === undefined` the moment emission stops: the
    // assertion passed with the feature entirely off.
    expect(outputReasoning!.encrypted_content).toBe(expectedBlob(outputReasoning!.id));
  });

  it("streaming emits the blob for a stateless request (store:false) without include", async () => {
    const events = await streamReasoning(reasoningTextFixture, "textreason", { store: false });
    const done = reasoningItem(events, "done")!;
    expect(done.encrypted_content).toBe(expectedBlob(done.id));
  });

  // --- HTTP streaming LEAK direction: the same builders must stay silent ---
  //
  // The positive cases above only prove the blob CAN be emitted; they pass just as
  // well if a call site hardcodes the flag ON. A leak is the worse failure for a
  // mock: it silently changes response bytes for every consumer that never opted
  // in (no `include`, no `store:false`), so the stored / opted-out replay is no
  // longer byte-identical.
  //
  // `handleResponses` threads the gate into each streaming builder from a SEPARATE
  // call site (buildTextStreamEvents, buildToolCallStreamEvents and
  // buildContentWithToolCallsStreamEvents), so one negative per case is required —
  // with only the text negative present, hardcoding the flag on at either of the
  // other two sites left the whole suite green.
  for (const [label, fixture, msg] of streamingCases) {
    it(`streaming ${label} omits the blob when the request did not opt in`, async () => {
      const events = await streamReasoning(fixture, msg, {});
      const done = reasoningItem(events, "done");
      expect(done, "no done reasoning item").toBeDefined();
      // Pin genuine key ABSENCE, not merely a falsy value.
      expect(done!).not.toHaveProperty("encrypted_content");
      expect(reasoningItem(events, "added")!).not.toHaveProperty("encrypted_content");
    });
  }

  // --- Non-streaming: every builder path (incl. the positional blocks branch) ---

  async function nonStreamReasoning(
    fixture: Fixture,
    userMessage: string,
    extra: Record<string, unknown> = OPT_IN,
  ): Promise<{ type: string; encrypted_content?: string; id: string }[]> {
    instance = await createServer([fixture]);
    const res = await post(`${instance!.url}/v1/responses`, {
      model: "gpt-5-test",
      input: [{ role: "user", content: userMessage }],
      stream: false,
      ...extra,
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as {
      output: { type: string; encrypted_content?: string; id: string }[];
    };
    return body.output;
  }

  const nonStreamingCases: [string, Fixture, string][] = [
    ["text (buildOutputPrefix)", reasoningTextFixture, "textreason"],
    ["tool-only (buildToolCallResponse)", reasoningToolFixture, "toolreason"],
    ["content+tool legacy (buildOutputPrefix)", reasoningContentToolFixture, "bothreason"],
    [
      "content+tool blocks (buildContentWithToolCallsResponse)",
      reasoningBlocksFixture,
      "blocksreason",
    ],
  ];

  for (const [label, fixture, msg] of nonStreamingCases) {
    it(`non-streaming ${label} carries the blob when opted in`, async () => {
      const output = await nonStreamReasoning(fixture, msg);
      const r = output.find((o) => o.type === "reasoning")!;
      expect(r, "no reasoning output item").toBeDefined();
      expect(r.encrypted_content).toBe(expectedBlob(r.id));
    });
  }

  // --- Non-streaming LEAK direction: the same builders must stay silent ---
  //
  // The positive cases above only prove the blob CAN be emitted; they pass just
  // as well if a builder emits it unconditionally. A leak is the worse failure
  // for a mock: it silently changes response bytes for every consumer that never
  // opted in (no `include`, no `store:false`), so the stored/opted-out replay is
  // no longer byte-identical. One negative per builder site — buildOutputPrefix
  // (text + content+tool legacy), buildToolCallResponse, and the `blocks` branch
  // of buildContentWithToolCallsResponse — each pinning genuine key ABSENCE, not
  // merely a falsy value.
  for (const [label, fixture, msg] of nonStreamingCases) {
    it(`non-streaming ${label} omits the blob when the request did not opt in`, async () => {
      const output = await nonStreamReasoning(fixture, msg, {});
      const r = output.find((o) => o.type === "reasoning")!;
      expect(r, "no reasoning output item").toBeDefined();
      expect(r).not.toHaveProperty("encrypted_content");
    });
  }

  // --- Summary-LESS fixtures: the blob must still reach an opted-in client ----
  //
  // The cases above all declare a `reasoning` summary in the fixture, which is
  // what makes the reasoning item exist in the first place. A fixture RECORDED
  // from the real stateless agent-framework flow typically has NO summary
  // (OpenAI returns `summary: []` unless summaries are explicitly requested), so
  // gating the item on a declared summary means the very flow this feature
  // exists to serve gets no item and therefore no blob. Real OpenAI, for a
  // reasoning-capable model, still returns a reasoning item carrying the blob.
  //
  // Emission stays gated on the SAME opt-in predicate, so a stored / opted-out
  // replay of a summary-less fixture is byte-identical to before (no reasoning
  // item at all), and on the requested model's reasoning capability, so a
  // gpt-4o replay does not grow an item the real provider would never send.

  const noSummaryTextFixture: Fixture = {
    match: { userMessage: "nosumtext" },
    response: { content: "AAPL is up" },
  };
  const noSummaryToolFixture: Fixture = {
    match: { userMessage: "nosumtool" },
    response: { toolCalls: [{ name: "get_stock", arguments: "{}" }] },
  };
  const noSummaryContentToolFixture: Fixture = {
    match: { userMessage: "nosumboth" },
    response: { content: "checking", toolCalls: [{ name: "get_stock", arguments: "{}" }] },
  };
  const noSummaryBlocksFixture: Fixture = {
    match: { userMessage: "nosumblocks" },
    response: {
      content: "checking",
      toolCalls: [{ name: "get_stock", arguments: "{}" }],
      blocks: [
        { type: "toolCall", name: "get_stock", arguments: "{}" },
        { type: "text", text: "checking" },
      ],
    },
  };

  const noSummaryCases: [string, Fixture, string][] = [
    ["text", noSummaryTextFixture, "nosumtext"],
    ["tool-only", noSummaryToolFixture, "nosumtool"],
    ["content+tool legacy", noSummaryContentToolFixture, "nosumboth"],
    ["content+tool blocks", noSummaryBlocksFixture, "nosumblocks"],
  ];

  for (const [label, fixture, msg] of noSummaryCases) {
    it(`non-streaming ${label} with NO declared summary carries an empty-summary item + blob when opted in`, async () => {
      const output = await nonStreamReasoning(fixture, msg);
      const r = output.find((o) => o.type === "reasoning") as
        | { id: string; summary: unknown[]; encrypted_content?: string }
        | undefined;
      expect(r, "no reasoning output item").toBeDefined();
      expect(r!.summary).toEqual([]);
      expect(r!.encrypted_content).toBe(expectedBlob(r!.id));
      // Real OpenAI leads the output array with the reasoning item.
      expect(output[0].type).toBe("reasoning");
    });

    it(`streaming ${label} with NO declared summary carries an empty-summary item + blob when opted in`, async () => {
      const events = await streamReasoning(fixture, msg, OPT_IN);
      const added = reasoningItem(events, "added") as
        | { id: string; summary: unknown[]; encrypted_content?: string }
        | undefined;
      const done = reasoningItem(events, "done") as
        | { id: string; summary: unknown[]; encrypted_content?: string }
        | undefined;
      expect(added, "no added reasoning item").toBeDefined();
      expect(done, "no done reasoning item").toBeDefined();
      expect(added!.summary).toEqual([]);
      expect(done!.summary).toEqual([]);
      expect(done!.encrypted_content).toBe(expectedBlob(done!.id));
      expectAddedOmitsBlob(added!);
    });

    // The whole blast-radius argument: nothing changes for a client that did not
    // opt in. Pins the ABSENCE of any reasoning item, streaming and not.
    it(`${label} with NO declared summary emits NO reasoning item when the request did not opt in`, async () => {
      const output = await nonStreamReasoning(fixture, msg, {});
      expect(output.some((o) => o.type === "reasoning")).toBe(false);

      const events = await streamReasoning(fixture, msg, {});
      expect(reasoningItem(events, "added")).toBeUndefined();
      expect(reasoningItem(events, "done")).toBeUndefined();
      expect(events.some((e) => e.type.startsWith("response.reasoning_summary"))).toBe(false);
    });
  }

  it("streaming a summary-less item emits added → done with NO summary-text events between", async () => {
    const events = await streamReasoning(noSummaryTextFixture, "nosumtext", OPT_IN);
    // An empty summary has no parts and no deltas: emitting a
    // reasoning_summary_part/text event for it would describe a part that does
    // not exist in the item's `summary: []`.
    expect(events.filter((e) => e.type.startsWith("response.reasoning_summary"))).toEqual([]);
    const seq = events
      .filter((e) => (e.item as { type?: string })?.type === "reasoning")
      .map((e) => e.type);
    expect(seq).toEqual(["response.output_item.added", "response.output_item.done"]);
  });

  it("streaming a synthesized reasoning item keeps output_index aligned with completed.output", async () => {
    const events = await streamReasoning(noSummaryContentToolFixture, "nosumboth", OPT_IN);
    const completed = events.find((e) => e.type === "response.completed") as SSEEvent & {
      response: { output: { type: string; id: string }[] };
    };
    // Reasoning must LEAD the output array and every other item shifts by one.
    expect(completed.response.output.map((o) => o.type)).toEqual([
      "reasoning",
      "message",
      "function_call",
    ]);
    // Every output_item.done event's output_index must equal that item's slot in
    // the final output array — an inserted leading item that failed to shift the
    // sequencing would desync here.
    const dones = events.filter((e) => e.type === "response.output_item.done");
    for (const d of dones) {
      const id = (d.item as { id: string }).id;
      expect(d.output_index).toBe(completed.response.output.findIndex((o) => o.id === id));
    }
  });

  it("does NOT synthesize a reasoning item for a non-reasoning model", async () => {
    // gpt-4o never emits a reasoning channel, so an opted-in replay against it
    // must not grow an item the real provider would never send (aimock#254).
    instance = await createServer([noSummaryTextFixture]);
    const res = await post(`${instance!.url}/v1/responses`, {
      model: "gpt-4o",
      input: [{ role: "user", content: "nosumtext" }],
      stream: false,
      ...OPT_IN,
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { output: { type: string }[] };
    expect(body.output.some((o) => o.type === "reasoning")).toBe(false);
  });

  // --- The 2x2 matrix: which trigger may CREATE an item vs only decorate one ---
  //
  // Two gates, deliberately different widths:
  //   blob on an item being emitted anyway → `include` OR `store: false`
  //   SYNTHESIZING an item the fixture never declared → `include` ONLY
  //
  // Creating an output item that did not previously exist is a bigger behavior
  // change than adding a field to one already on the wire, so it takes the gate
  // that is directly observable in the request rather than the inferred
  // `store: false` one. `agent-framework-openai` >= 1.11.0 sends `include` and
  // never `store`, so the motivating client is unaffected by the narrowing.

  it("row 3: store:false + a DECLARED summary still carries the blob (non-streaming, unchanged)", async () => {
    const output = await nonStreamReasoning(reasoningTextFixture, "textreason", { store: false });
    const r = output.find((o) => o.type === "reasoning")!;
    expect(r, "no reasoning output item").toBeDefined();
    expect(r.encrypted_content).toBe(expectedBlob(r.id));
  });

  // ROW 4 — the whole point of the narrowing, and the row that must never
  // silently regress: `store: false` must NOT conjure a reasoning item for a
  // fixture that declares no summary. Asserted on both transports' HTTP paths and
  // for a reasoning-CAPABLE model, so the model gate cannot be what makes it pass.
  it("row 4: store:false + NO declared summary synthesizes NOTHING (non-streaming)", async () => {
    const output = await nonStreamReasoning(noSummaryTextFixture, "nosumtext", { store: false });
    expect(output.some((o) => o.type === "reasoning")).toBe(false);
    // Guard against the model gate being the reason this passes: the SAME
    // fixture and model DO produce the item under the explicit `include` opt-in.
    const optedIn = await nonStreamReasoning(noSummaryTextFixture, "nosumtext");
    expect(optedIn.some((o) => o.type === "reasoning")).toBe(true);
  });

  it("row 4: store:false + NO declared summary synthesizes NOTHING (streaming)", async () => {
    const events = await streamReasoning(noSummaryTextFixture, "nosumtext", { store: false });
    expect(reasoningItem(events, "added")).toBeUndefined();
    expect(reasoningItem(events, "done")).toBeUndefined();
    const completed = events.find((e) => e.type === "response.completed") as SSEEvent & {
      response: { output: { type: string }[] };
    };
    expect(completed.response.output.some((o) => o.type === "reasoning")).toBe(false);
  });

  it("row 4 holds for every builder path (tool-only, content+tool legacy, blocks)", async () => {
    for (const [, fixture, msg] of noSummaryCases) {
      const output = await nonStreamReasoning(fixture, msg, { store: false });
      expect(
        output.some((o) => o.type === "reasoning"),
        `${msg} synthesized on store:false`,
      ).toBe(false);
      const events = await streamReasoning(fixture, msg, { store: false });
      expect(
        reasoningItem(events, "done"),
        `${msg} synthesized on store:false (stream)`,
      ).toBeUndefined();
    }
  });
});

// ─── Bug fix: multi-fco after single item_reference ─────────────────────────

describe("multi-fco after single item_reference", () => {
  it("[user, item_reference, fco_A, fco_B] produces assistantCount=1 with 2 tool_calls", () => {
    const messages = responsesInputToMessages({
      model: "gpt-4",
      input: [
        { role: "user", content: "hello" },
        { type: "item_reference", id: "ref_multi_fc" },
        { type: "function_call_output", call_id: "call_A", output: '{"a":1}' },
        { type: "function_call_output", call_id: "call_B", output: '{"b":2}' },
      ],
    });

    const assistantMsgs = messages.filter((m) => m.role === "assistant");
    expect(assistantMsgs).toHaveLength(1);
    expect(assistantMsgs[0].tool_calls).toHaveLength(2);
    expect(assistantMsgs[0].tool_calls![0].id).toBe("call_A");
    expect(assistantMsgs[0].tool_calls![1].id).toBe("call_B");

    const toolMsgs = messages.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(2);
  });

  it("[user, item_reference, fco_A, fco_B, user] produces assistantCount=1", () => {
    const messages = responsesInputToMessages({
      model: "gpt-4",
      input: [
        { role: "user", content: "hello" },
        { type: "item_reference", id: "ref_multi_fc" },
        { type: "function_call_output", call_id: "call_A", output: '{"a":1}' },
        { type: "function_call_output", call_id: "call_B", output: '{"b":2}' },
        { role: "user", content: "next question" },
      ],
    });

    const assistantCount = messages.filter((m) => m.role === "assistant").length;
    expect(assistantCount).toBe(1);
  });
});

// ─── e2e: turnIndex + item_reference via Responses API ──────────────────────

describe("turnIndex + item_reference via Responses API (e2e)", () => {
  it("selects turnIndex:1 fixture when input has item_reference + fco (assistantCount=1)", async () => {
    const turn0Fixture: Fixture = {
      match: { userMessage: "turn-index-test", turnIndex: 0 },
      response: { content: "turn zero response" },
    };
    const turn1Fixture: Fixture = {
      match: { userMessage: "turn-index-test", turnIndex: 1 },
      response: { content: "turn one response" },
    };
    instance = await createServer([turn0Fixture, turn1Fixture]);

    // Input: [user, item_reference, function_call_output, user]
    // This should produce assistantCount=1 → turnIndex 1 match
    const res = await post(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [
        { role: "user", content: "first question" },
        { type: "item_reference", id: "ref_prev_assistant" },
        { type: "function_call_output", call_id: "call_prev", output: '{"done":true}' },
        { role: "user", content: "turn-index-test" },
      ],
      stream: false,
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.output[0].content[0].text).toBe("turn one response");
  });

  it("multi-fco [user, item_reference, fco_A, fco_B, user] produces assistantCount=1", async () => {
    const turn0Fixture: Fixture = {
      match: { userMessage: "multi-fco-turn-test", turnIndex: 0 },
      response: { content: "should not match" },
    };
    const turn1Fixture: Fixture = {
      match: { userMessage: "multi-fco-turn-test", turnIndex: 1 },
      response: { content: "correct turn one" },
    };
    instance = await createServer([turn0Fixture, turn1Fixture]);

    const res = await post(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [
        { role: "user", content: "initial" },
        { type: "item_reference", id: "ref_2tool_assistant" },
        { type: "function_call_output", call_id: "call_X", output: '{"x":1}' },
        { type: "function_call_output", call_id: "call_Y", output: '{"y":2}' },
        { role: "user", content: "multi-fco-turn-test" },
      ],
      stream: false,
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.output[0].content[0].text).toBe("correct turn one");
  });
});

// ─── Debug logging in handleResponses ───────────────────────────────────────

describe("handleResponses debug logging", () => {
  it("logs debug on fixture match", async () => {
    const journal = new Journal();
    const debugMessages: string[] = [];
    const logger = new Logger("debug");
    const origDebug = logger.debug.bind(logger);
    logger.debug = (...args: unknown[]) => {
      debugMessages.push(String(args[0]));
      origDebug(...args);
    };
    const defaults = { latency: 0, chunkSize: 10, logger };

    const mockReq = {
      method: "POST",
      url: "/v1/responses",
      headers: {},
    } as unknown as http.IncomingMessage;

    const mockRes = createMockRes();

    await handleResponses(
      mockReq,
      mockRes,
      JSON.stringify({
        model: "gpt-4",
        input: [{ role: "user", content: "hello" }],
      }),
      [textFixture],
      journal,
      defaults,
      () => {},
    );

    expect(debugMessages.some((m) => m.includes("Responses fixture matched"))).toBe(true);
  });

  it("logs debug on no fixture match", async () => {
    const journal = new Journal();
    const debugMessages: string[] = [];
    const logger = new Logger("debug");
    const origDebug = logger.debug.bind(logger);
    logger.debug = (...args: unknown[]) => {
      debugMessages.push(String(args[0]));
      origDebug(...args);
    };
    const defaults = { latency: 0, chunkSize: 10, logger };

    const mockReq = {
      method: "POST",
      url: "/v1/responses",
      headers: {},
    } as unknown as http.IncomingMessage;

    const mockRes = createMockRes();

    await handleResponses(
      mockReq,
      mockRes,
      JSON.stringify({
        model: "gpt-4",
        input: [{ role: "user", content: "no-match-here" }],
      }),
      [],
      journal,
      defaults,
      () => {},
    );

    expect(debugMessages.some((m) => m.includes("No responses fixture matched"))).toBe(true);
  });
});
