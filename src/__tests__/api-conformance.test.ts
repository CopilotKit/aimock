/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { createServer, type ServerInstance } from "../server.js";
import type { Fixture } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function httpPost(
  url: string,
  body: object,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
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
            headers: res.headers,
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

// Parse SSE events that use data-only format (OpenAI Chat Completions, Gemini)
function parseDataOnlySSE(body: string): object[] {
  return body
    .split("\n\n")
    .filter((block) => block.startsWith("data: ") && !block.includes("[DONE]"))
    .map((block) => JSON.parse(block.slice(6)));
}

// Parse SSE events that use event: + data: format (Responses API, Claude)
function parseTypedSSE(body: string): { type: string; data: Record<string, any> }[] {
  return body
    .split("\n\n")
    .filter((block) => block.includes("event: ") && block.includes("data: "))
    .map((block) => {
      const eventMatch = block.match(/^event: (.+)$/m);
      const dataMatch = block.match(/^data: (.+)$/m);
      return {
        type: eventMatch![1],
        data: JSON.parse(dataMatch![1]),
      };
    });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEXT_FIXTURE: Fixture = {
  match: { userMessage: "hello" },
  response: { content: "Hello!" },
};

const TOOL_FIXTURE: Fixture = {
  match: { userMessage: "weather" },
  response: {
    toolCalls: [{ name: "get_weather", arguments: '{"city":"SF"}' }],
  },
};

const ERROR_FIXTURE: Fixture = {
  match: { userMessage: "error-test" },
  response: {
    error: { message: "Rate limited", type: "rate_limit_error" },
    status: 429,
  },
};

// ---------------------------------------------------------------------------
// Shared server instance
// ---------------------------------------------------------------------------

let instance: ServerInstance;

beforeAll(async () => {
  instance = await createServer([TEXT_FIXTURE, TOOL_FIXTURE, ERROR_FIXTURE], {
    port: 0,
    chunkSize: 100,
  });
});

afterAll(async () => {
  await new Promise<void>((r) => instance.server.close(() => r()));
});

// ---------------------------------------------------------------------------
// 1. OpenAI Chat Completions conformance
// ---------------------------------------------------------------------------

describe("OpenAI Chat Completions conformance", () => {
  const chatPath = () => `${instance.url}/v1/chat/completions`;

  describe("non-streaming", () => {
    it("has all required top-level fields", async () => {
      const res = await httpPost(chatPath(), {
        model: "gpt-4",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      });
      const json = JSON.parse(res.body);
      expect(json).toHaveProperty("id");
      expect(json).toHaveProperty("object");
      expect(json).toHaveProperty("created");
      expect(json).toHaveProperty("model");
      expect(json).toHaveProperty("choices");
      expect(json).toHaveProperty("usage");
    });

    it("object is chat.completion", async () => {
      const res = await httpPost(chatPath(), {
        model: "gpt-4",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      });
      const json = JSON.parse(res.body);
      expect(json.object).toBe("chat.completion");
    });

    it("id starts with chatcmpl-", async () => {
      const res = await httpPost(chatPath(), {
        model: "gpt-4",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      });
      const json = JSON.parse(res.body);
      expect(json.id).toMatch(/^chatcmpl-/);
    });

    it("created is a unix timestamp number", async () => {
      const res = await httpPost(chatPath(), {
        model: "gpt-4",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      });
      const json = JSON.parse(res.body);
      expect(typeof json.created).toBe("number");
    });

    it("choices[0] has index, message, and finish_reason", async () => {
      const res = await httpPost(chatPath(), {
        model: "gpt-4",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      });
      const json = JSON.parse(res.body);
      const choice = json.choices[0];
      expect(choice).toHaveProperty("index");
      expect(choice).toHaveProperty("message");
      expect(choice).toHaveProperty("finish_reason");
      expect(choice.message.role).toBe("assistant");
      expect(typeof choice.message.content).toBe("string");
      expect(choice.message).toHaveProperty("refusal");
      expect(choice.message.refusal).toBeNull();
    });

    it("usage has prompt_tokens, completion_tokens, total_tokens as numbers", async () => {
      const res = await httpPost(chatPath(), {
        model: "gpt-4",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      });
      const json = JSON.parse(res.body);
      expect(typeof json.usage.prompt_tokens).toBe("number");
      expect(typeof json.usage.completion_tokens).toBe("number");
      expect(typeof json.usage.total_tokens).toBe("number");
    });

    it("tool call: finish_reason is tool_calls with properly structured tool_calls array", async () => {
      const res = await httpPost(chatPath(), {
        model: "gpt-4",
        messages: [{ role: "user", content: "weather" }],
        stream: false,
      });
      const json = JSON.parse(res.body);
      const choice = json.choices[0];
      expect(choice.finish_reason).toBe("tool_calls");
      expect(Array.isArray(choice.message.tool_calls)).toBe(true);

      const tc = choice.message.tool_calls[0];
      expect(tc.id).toMatch(/^call_/);
      expect(tc.type).toBe("function");
      expect(typeof tc.function.name).toBe("string");
      expect(typeof tc.function.arguments).toBe("string");
    });
  });

  describe("streaming", () => {
    it("Content-Type is text/event-stream", async () => {
      const res = await httpPost(chatPath(), {
        model: "gpt-4",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      });
      expect(res.headers["content-type"]).toContain("text/event-stream");
    });

    it("stream ends with data: [DONE]", async () => {
      const res = await httpPost(chatPath(), {
        model: "gpt-4",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      });
      expect(res.body.trimEnd()).toMatch(/data: \[DONE\]$/);
    });

    it("each chunk has id, object chat.completion.chunk, created, model, choices", async () => {
      const res = await httpPost(chatPath(), {
        model: "gpt-4",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      });
      const chunks = parseDataOnlySSE(res.body);
      expect(chunks.length).toBeGreaterThan(0);
      for (const chunk of chunks) {
        const c = chunk as any;
        expect(c.object).toBe("chat.completion.chunk");
        expect(c).toHaveProperty("id");
        expect(c).toHaveProperty("created");
        expect(c).toHaveProperty("model");
        expect(c).toHaveProperty("choices");
      }
    });

    it("first chunk has delta.role === assistant", async () => {
      const res = await httpPost(chatPath(), {
        model: "gpt-4",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      });
      const chunks = parseDataOnlySSE(res.body) as any[];
      expect(chunks[0].choices[0].delta.role).toBe("assistant");
    });

    it("content chunks have delta.content as string", async () => {
      const res = await httpPost(chatPath(), {
        model: "gpt-4",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      });
      const chunks = parseDataOnlySSE(res.body) as any[];
      const contentChunks = chunks.filter((c) => c.choices[0].delta.content !== undefined);
      expect(contentChunks.length).toBeGreaterThan(0);
      for (const c of contentChunks) {
        expect(typeof c.choices[0].delta.content).toBe("string");
      }
    });

    it("last data chunk has finish_reason stop or tool_calls", async () => {
      const res = await httpPost(chatPath(), {
        model: "gpt-4",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      });
      const chunks = parseDataOnlySSE(res.body) as any[];
      const last = chunks[chunks.length - 1];
      expect(["stop", "tool_calls"]).toContain(last.choices[0].finish_reason);
    });

    it("all chunks share the same id", async () => {
      const res = await httpPost(chatPath(), {
        model: "gpt-4",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      });
      const chunks = parseDataOnlySSE(res.body) as any[];
      const ids = new Set(chunks.map((c) => c.id));
      expect(ids.size).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// 2. OpenAI Responses API conformance
// ---------------------------------------------------------------------------

describe("OpenAI Responses API conformance", () => {
  const responsesPath = () => `${instance.url}/v1/responses`;

  describe("streaming (default)", () => {
    it("Content-Type is text/event-stream", async () => {
      const res = await httpPost(responsesPath(), {
        model: "gpt-4",
        input: [{ role: "user", content: "hello" }],
      });
      expect(res.headers["content-type"]).toContain("text/event-stream");
    });

    it("events use event: + data: format (no [DONE] sentinel)", async () => {
      const res = await httpPost(responsesPath(), {
        model: "gpt-4",
        input: [{ role: "user", content: "hello" }],
      });
      expect(res.body).not.toContain("[DONE]");
      const events = parseTypedSSE(res.body);
      expect(events.length).toBeGreaterThan(0);
      // Every parsed event should have both type and data
      for (const ev of events) {
        expect(typeof ev.type).toBe("string");
        expect(ev.data).toBeDefined();
      }
    });

    it("event sequence includes all required event types", async () => {
      const res = await httpPost(responsesPath(), {
        model: "gpt-4",
        input: [{ role: "user", content: "hello" }],
      });
      const events = parseTypedSSE(res.body);
      const types = events.map((e) => e.type);
      const required = [
        "response.created",
        "response.output_item.added",
        "response.content_part.added",
        "response.output_text.delta",
        "response.output_text.done",
        "response.content_part.done",
        "response.output_item.done",
        "response.completed",
      ];
      for (const r of required) {
        expect(types).toContain(r);
      }
    });

    it("response.created has proper response structure", async () => {
      const res = await httpPost(responsesPath(), {
        model: "gpt-4",
        input: [{ role: "user", content: "hello" }],
      });
      const events = parseTypedSSE(res.body);
      const created = events.find((e) => e.type === "response.created")!;
      expect(created.data.response.id).toMatch(/^resp[-_]/);
      expect(created.data.response.object).toBe("response");
      expect(created.data.response.status).toBe("in_progress");
      expect(created.data.response.output).toEqual([]);
    });

    it("delta events have delta field as string", async () => {
      const res = await httpPost(responsesPath(), {
        model: "gpt-4",
        input: [{ role: "user", content: "hello" }],
      });
      const events = parseTypedSSE(res.body);
      const deltas = events.filter((e) => e.type === "response.output_text.delta");
      expect(deltas.length).toBeGreaterThan(0);
      for (const d of deltas) {
        expect(typeof d.data.delta).toBe("string");
      }
    });

    it("response.completed has status completed and output array", async () => {
      const res = await httpPost(responsesPath(), {
        model: "gpt-4",
        input: [{ role: "user", content: "hello" }],
      });
      const events = parseTypedSSE(res.body);
      const completed = events.find((e) => e.type === "response.completed")!;
      expect(completed.data.response.status).toBe("completed");
      expect(Array.isArray(completed.data.response.output)).toBe(true);
    });

    it("tool call sequence includes function_call output item", async () => {
      const res = await httpPost(responsesPath(), {
        model: "gpt-4",
        input: [{ role: "user", content: "weather" }],
      });
      const events = parseTypedSSE(res.body);
      const itemAdded = events.find(
        (e) => e.type === "response.output_item.added" && e.data.item?.type === "function_call",
      );
      expect(itemAdded).toBeDefined();
    });
  });

  describe("non-streaming", () => {
    it("response has resp- id, object response, status completed, output array", async () => {
      const res = await httpPost(responsesPath(), {
        model: "gpt-4",
        input: [{ role: "user", content: "hello" }],
        stream: false,
      });
      const json = JSON.parse(res.body);
      expect(json.id).toMatch(/^resp[-_]/);
      expect(json.object).toBe("response");
      expect(json.status).toBe("completed");
      expect(Array.isArray(json.output)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Anthropic Claude Messages API conformance
// ---------------------------------------------------------------------------

describe("Anthropic Claude Messages API conformance", () => {
  const claudePath = () => `${instance.url}/v1/messages`;

  describe("non-streaming", () => {
    it("has all required top-level fields", async () => {
      const res = await httpPost(claudePath(), {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      });
      const json = JSON.parse(res.body);
      expect(json).toHaveProperty("id");
      expect(json).toHaveProperty("type");
      expect(json).toHaveProperty("role");
      expect(json).toHaveProperty("content");
      expect(json).toHaveProperty("model");
      expect(json).toHaveProperty("stop_reason");
      expect(json).toHaveProperty("stop_sequence");
      expect(json).toHaveProperty("usage");
    });

    it("type is message", async () => {
      const res = await httpPost(claudePath(), {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      });
      const json = JSON.parse(res.body);
      expect(json.type).toBe("message");
    });

    it("id starts with msg_", async () => {
      const res = await httpPost(claudePath(), {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      });
      const json = JSON.parse(res.body);
      expect(json.id).toMatch(/^msg_/);
    });

    it("role is assistant and content is array of text blocks", async () => {
      const res = await httpPost(claudePath(), {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      });
      const json = JSON.parse(res.body);
      expect(json.role).toBe("assistant");
      expect(Array.isArray(json.content)).toBe(true);
      expect(json.content[0].type).toBe("text");
      expect(typeof json.content[0].text).toBe("string");
    });

    it("stop_reason is end_turn for text, stop_sequence is null", async () => {
      const res = await httpPost(claudePath(), {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      });
      const json = JSON.parse(res.body);
      expect(json.stop_reason).toBe("end_turn");
      expect(json.stop_sequence).toBeNull();
    });

    it("usage has input_tokens and output_tokens (numbers), no total_tokens", async () => {
      const res = await httpPost(claudePath(), {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      });
      const json = JSON.parse(res.body);
      expect(typeof json.usage.input_tokens).toBe("number");
      expect(typeof json.usage.output_tokens).toBe("number");
      expect(json.usage).not.toHaveProperty("total_tokens");
    });

    it("tool call: stop_reason is tool_use, content has tool_use blocks with object input", async () => {
      const res = await httpPost(claudePath(), {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [{ role: "user", content: "weather" }],
        stream: false,
      });
      const json = JSON.parse(res.body);
      expect(json.stop_reason).toBe("tool_use");

      const toolBlock = json.content.find((b: any) => b.type === "tool_use");
      expect(toolBlock).toBeDefined();
      expect(toolBlock.id).toMatch(/^toolu_/);
      expect(typeof toolBlock.name).toBe("string");
      expect(typeof toolBlock.input).toBe("object");
      // input should be an object, not a string
      expect(typeof toolBlock.input).not.toBe("string");
    });
  });

  describe("streaming", () => {
    it("Content-Type is text/event-stream", async () => {
      const res = await httpPost(claudePath(), {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hello" }],
      });
      expect(res.headers["content-type"]).toContain("text/event-stream");
    });

    it("events use event: + data: format with no [DONE] sentinel", async () => {
      const res = await httpPost(claudePath(), {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hello" }],
      });
      expect(res.body).not.toContain("[DONE]");
      const events = parseTypedSSE(res.body);
      expect(events.length).toBeGreaterThan(0);
    });

    it("event sequence follows message_start -> content_block_start -> deltas -> content_block_stop -> message_delta -> message_stop", async () => {
      const res = await httpPost(claudePath(), {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hello" }],
      });
      const events = parseTypedSSE(res.body);
      const types = events.map((e) => e.type);
      expect(types[0]).toBe("message_start");
      expect(types).toContain("content_block_start");
      expect(types).toContain("content_block_delta");
      expect(types).toContain("content_block_stop");
      expect(types).toContain("message_delta");
      expect(types[types.length - 1]).toBe("message_stop");
    });

    it("message_start has proper message structure", async () => {
      const res = await httpPost(claudePath(), {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hello" }],
      });
      const events = parseTypedSSE(res.body);
      const start = events.find((e) => e.type === "message_start")!;
      expect(start.data.message.id).toMatch(/^msg_/);
      expect(start.data.message.type).toBe("message");
      expect(start.data.message.role).toBe("assistant");
      expect(start.data.message.content).toEqual([]);
      expect(start.data.message.stop_reason).toBeNull();
    });

    it("content_block_start has type text with empty text", async () => {
      const res = await httpPost(claudePath(), {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hello" }],
      });
      const events = parseTypedSSE(res.body);
      const blockStart = events.find((e) => e.type === "content_block_start")!;
      expect(blockStart.data.content_block.type).toBe("text");
      expect(blockStart.data.content_block.text).toBe("");
    });

    it("content_block_delta has text_delta type with text string", async () => {
      const res = await httpPost(claudePath(), {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hello" }],
      });
      const events = parseTypedSSE(res.body);
      const deltas = events.filter((e) => e.type === "content_block_delta");
      expect(deltas.length).toBeGreaterThan(0);
      for (const d of deltas) {
        expect(d.data.delta.type).toBe("text_delta");
        expect(typeof d.data.delta.text).toBe("string");
      }
    });

    it("message_delta has stop_reason end_turn for text responses", async () => {
      const res = await httpPost(claudePath(), {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hello" }],
      });
      const events = parseTypedSSE(res.body);
      const msgDelta = events.find((e) => e.type === "message_delta")!;
      expect(msgDelta.data.delta.stop_reason).toBe("end_turn");
    });

    it("message_stop event has type message_stop", async () => {
      const res = await httpPost(claudePath(), {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hello" }],
      });
      const events = parseTypedSSE(res.body);
      const stop = events.find((e) => e.type === "message_stop")!;
      expect(stop).toBeDefined();
      expect(stop.data.type).toBe("message_stop");
    });

    it("tool streaming: content_block_start with tool_use type and input_json_delta deltas", async () => {
      const res = await httpPost(claudePath(), {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [{ role: "user", content: "weather" }],
      });
      const events = parseTypedSSE(res.body);

      const toolBlockStart = events.find(
        (e) => e.type === "content_block_start" && e.data.content_block?.type === "tool_use",
      );
      expect(toolBlockStart).toBeDefined();
      expect(toolBlockStart!.data.content_block.id).toMatch(/^toolu_/);
      expect(typeof toolBlockStart!.data.content_block.name).toBe("string");

      const jsonDeltas = events.filter(
        (e) => e.type === "content_block_delta" && e.data.delta?.type === "input_json_delta",
      );
      expect(jsonDeltas.length).toBeGreaterThan(0);
      for (const d of jsonDeltas) {
        expect(typeof d.data.delta.partial_json).toBe("string");
      }

      const msgDelta = events.find((e) => e.type === "message_delta")!;
      expect(msgDelta.data.delta.stop_reason).toBe("tool_use");
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Google Gemini conformance
// ---------------------------------------------------------------------------

describe("Google Gemini conformance", () => {
  const geminiContentPath = () => `${instance.url}/v1beta/models/gemini-2.0-flash:generateContent`;
  const geminiStreamPath = () =>
    `${instance.url}/v1beta/models/gemini-2.0-flash:streamGenerateContent`;

  describe("non-streaming", () => {
    it("response has candidates and usageMetadata", async () => {
      const res = await httpPost(geminiContentPath(), {
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
      });
      const json = JSON.parse(res.body);
      expect(json).toHaveProperty("candidates");
      expect(json).toHaveProperty("usageMetadata");
    });

    it("candidates[0] has content, finishReason, and index", async () => {
      const res = await httpPost(geminiContentPath(), {
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
      });
      const json = JSON.parse(res.body);
      const candidate = json.candidates[0];
      expect(candidate).toHaveProperty("content");
      expect(candidate).toHaveProperty("finishReason");
      expect(candidate).toHaveProperty("index");
    });

    it("content.role is model and content.parts has text", async () => {
      const res = await httpPost(geminiContentPath(), {
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
      });
      const json = JSON.parse(res.body);
      const content = json.candidates[0].content;
      expect(content.role).toBe("model");
      expect(Array.isArray(content.parts)).toBe(true);
      expect(typeof content.parts[0].text).toBe("string");
    });

    it("finishReason is STOP for text (SCREAMING_SNAKE_CASE)", async () => {
      const res = await httpPost(geminiContentPath(), {
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
      });
      const json = JSON.parse(res.body);
      expect(json.candidates[0].finishReason).toBe("STOP");
    });

    it("usageMetadata has camelCase token counts as numbers", async () => {
      const res = await httpPost(geminiContentPath(), {
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
      });
      const json = JSON.parse(res.body);
      const usage = json.usageMetadata;
      expect(typeof usage.promptTokenCount).toBe("number");
      expect(typeof usage.candidatesTokenCount).toBe("number");
      expect(typeof usage.totalTokenCount).toBe("number");
    });

    it("tool call: finishReason is FUNCTION_CALL, parts have functionCall with object args", async () => {
      const res = await httpPost(geminiContentPath(), {
        contents: [{ role: "user", parts: [{ text: "weather" }] }],
      });
      const json = JSON.parse(res.body);
      expect(json.candidates[0].finishReason).toBe("FUNCTION_CALL");

      const fcPart = json.candidates[0].content.parts.find((p: any) => p.functionCall);
      expect(fcPart).toBeDefined();
      expect(typeof fcPart.functionCall.name).toBe("string");
      expect(typeof fcPart.functionCall.args).toBe("object");
      // args should be an object, not a string
      expect(typeof fcPart.functionCall.args).not.toBe("string");
    });
  });

  describe("streaming", () => {
    it("Content-Type is text/event-stream", async () => {
      const res = await httpPost(geminiStreamPath(), {
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
      });
      expect(res.headers["content-type"]).toContain("text/event-stream");
    });

    it("events use data-only format with no event: prefix and no [DONE]", async () => {
      const res = await httpPost(geminiStreamPath(), {
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
      });
      expect(res.body).not.toContain("[DONE]");
      // Should not have event: lines
      expect(res.body).not.toMatch(/^event: /m);
      const chunks = parseDataOnlySSE(res.body);
      expect(chunks.length).toBeGreaterThan(0);
    });

    it("each chunk has candidates structure", async () => {
      const res = await httpPost(geminiStreamPath(), {
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
      });
      const chunks = parseDataOnlySSE(res.body) as any[];
      for (const chunk of chunks) {
        expect(chunk).toHaveProperty("candidates");
        expect(chunk.candidates[0]).toHaveProperty("content");
      }
    });

    it("intermediate chunks have text parts but no finishReason; last chunk has finishReason and usageMetadata", async () => {
      // Use a dedicated server with small chunkSize to guarantee multiple chunks
      const longFixture: Fixture = {
        match: { userMessage: "chunk-test" },
        response: { content: "abcdefghijklmnopqrstuvwxyz" },
      };
      const smallChunkInstance = await createServer([longFixture], { port: 0, chunkSize: 5 });
      try {
        const res = await httpPost(
          `${smallChunkInstance.url}/v1beta/models/gemini-2.0-flash:streamGenerateContent`,
          { contents: [{ role: "user", parts: [{ text: "chunk-test" }] }] },
        );
        const chunks = parseDataOnlySSE(res.body) as any[];
        expect(chunks.length).toBeGreaterThan(1);

        // Intermediate chunks (all but last) should have text content but no finishReason
        for (let i = 0; i < chunks.length - 1; i++) {
          const part = chunks[i].candidates[0].content.parts[0];
          expect(typeof part.text).toBe("string");
          expect(chunks[i].candidates[0].finishReason).toBeUndefined();
          expect(chunks[i].usageMetadata).toBeUndefined();
        }

        // Last chunk should have finishReason and usageMetadata
        const last = chunks[chunks.length - 1];
        expect(last.candidates[0].finishReason).toBeDefined();
        expect(last.usageMetadata).toBeDefined();
      } finally {
        await new Promise<void>((r) => smallChunkInstance.server.close(() => r()));
      }
    });
  });
});

// ---------------------------------------------------------------------------
// 5. Cross-provider invariants
// ---------------------------------------------------------------------------

describe("Cross-provider invariants", () => {
  it("all providers return text/event-stream for streaming responses", async () => {
    const base = instance.url;

    const [chat, responses, claude, gemini] = await Promise.all([
      httpPost(`${base}/v1/chat/completions`, {
        model: "gpt-4",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      }),
      httpPost(`${base}/v1/responses`, {
        model: "gpt-4",
        input: [{ role: "user", content: "hello" }],
      }),
      httpPost(`${base}/v1/messages`, {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hello" }],
      }),
      httpPost(`${base}/v1beta/models/gemini-2.0-flash:streamGenerateContent`, {
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
      }),
    ]);

    expect(chat.headers["content-type"]).toContain("text/event-stream");
    expect(responses.headers["content-type"]).toContain("text/event-stream");
    expect(claude.headers["content-type"]).toContain("text/event-stream");
    expect(gemini.headers["content-type"]).toContain("text/event-stream");
  });

  it("all non-streaming providers return application/json", async () => {
    const base = instance.url;

    const [chat, responses, claude, gemini] = await Promise.all([
      httpPost(`${base}/v1/chat/completions`, {
        model: "gpt-4",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      }),
      httpPost(`${base}/v1/responses`, {
        model: "gpt-4",
        input: [{ role: "user", content: "hello" }],
        stream: false,
      }),
      httpPost(`${base}/v1/messages`, {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      }),
      httpPost(`${base}/v1beta/models/gemini-2.0-flash:generateContent`, {
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
      }),
    ]);

    expect(chat.headers["content-type"]).toContain("application/json");
    expect(responses.headers["content-type"]).toContain("application/json");
    expect(claude.headers["content-type"]).toContain("application/json");
    expect(gemini.headers["content-type"]).toContain("application/json");
  });

  it("all providers return proper error status and JSON body on error fixture", async () => {
    const base = instance.url;

    const [chat, responses, claude, gemini] = await Promise.all([
      httpPost(`${base}/v1/chat/completions`, {
        model: "gpt-4",
        messages: [{ role: "user", content: "error-test" }],
        stream: false,
      }),
      httpPost(`${base}/v1/responses`, {
        model: "gpt-4",
        input: [{ role: "user", content: "error-test" }],
        stream: false,
      }),
      httpPost(`${base}/v1/messages`, {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [{ role: "user", content: "error-test" }],
        stream: false,
      }),
      httpPost(`${base}/v1beta/models/gemini-2.0-flash:generateContent`, {
        contents: [{ role: "user", parts: [{ text: "error-test" }] }],
      }),
    ]);

    for (const res of [chat, responses, claude, gemini]) {
      expect(res.status).toBe(429);
      const json = JSON.parse(res.body);
      expect(json).toHaveProperty("error");
    }
  });

  it("all providers return 404 with JSON error body when no fixture matches", async () => {
    const base = instance.url;

    const [chat, responses, claude, gemini] = await Promise.all([
      httpPost(`${base}/v1/chat/completions`, {
        model: "gpt-4",
        messages: [{ role: "user", content: "no-match-xyz-9999" }],
        stream: false,
      }),
      httpPost(`${base}/v1/responses`, {
        model: "gpt-4",
        input: [{ role: "user", content: "no-match-xyz-9999" }],
        stream: false,
      }),
      httpPost(`${base}/v1/messages`, {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [{ role: "user", content: "no-match-xyz-9999" }],
        stream: false,
      }),
      httpPost(`${base}/v1beta/models/gemini-2.0-flash:generateContent`, {
        contents: [{ role: "user", parts: [{ text: "no-match-xyz-9999" }] }],
      }),
    ]);

    for (const res of [chat, responses, claude, gemini]) {
      expect(res.status).toBe(404);
      const json = JSON.parse(res.body);
      expect(json).toHaveProperty("error");
    }
  });
});
