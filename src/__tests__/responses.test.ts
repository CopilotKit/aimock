import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import type { Fixture } from "../types.js";
import { createServer, type ServerInstance } from "../server.js";
import { responsesInputToMessages, responsesToCompletionRequest } from "../responses.js";

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

  it("converts function_call_output to tool message", () => {
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
    expect(messages).toEqual([{ role: "tool", content: '{"temp":72}', tool_call_id: "call_123" }]);
  });

  it("skips unknown item types", () => {
    const messages = responsesInputToMessages({
      model: "gpt-4",
      input: [
        { type: "item_reference", id: "ref_123" },
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
    expect(body.error.message).toBe("Malformed JSON");
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
