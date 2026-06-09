import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as http from "node:http";
import type { Fixture } from "../types.js";
import { createServer, type ServerInstance } from "../server.js";
import {
  geminiInteractionsToCompletionRequest,
  resetInteractionCounter,
  resetEventIdCounter,
  buildInteractionsTextResponse,
  buildInteractionsToolCallResponse,
  buildInteractionsContentWithToolCallsResponse,
  buildInteractionsTextSSEEvents,
  buildInteractionsToolCallSSEEvents,
  buildInteractionsContentWithToolCallsSSEEvents,
} from "../gemini-interactions.js";
import { collapseGeminiInteractionsSSE } from "../stream-collapse.js";
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

function parseInteractionsSSEEvents(body: string): unknown[] {
  const events: unknown[] = [];
  for (const line of body.split("\n")) {
    if (line.startsWith("data: ")) {
      events.push(JSON.parse(line.slice(6)));
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
        id: "call_1",
      },
    ],
  },
};

const contentWithToolsFixture: Fixture = {
  match: { userMessage: "analyze" },
  response: {
    content: "Let me help you",
    toolCalls: [
      {
        name: "analyze_data",
        arguments: '{"dataset":"sales"}',
        id: "call_2",
      },
    ],
  },
};

const errorFixture: Fixture = {
  match: { userMessage: "fail" },
  response: {
    error: {
      message: "Rate limited",
      type: "RESOURCE_EXHAUSTED",
      code: "rate_limit",
    },
    status: 429,
  },
};

const sequenceFixture0: Fixture = {
  match: { userMessage: "step", sequenceIndex: 0 },
  response: { content: "First" },
};

const sequenceFixture1: Fixture = {
  match: { userMessage: "step", sequenceIndex: 1 },
  response: { content: "Second" },
};

const modelFixture: Fixture = {
  match: { model: "gemini-2.5-pro" },
  response: { content: "Pro response" },
};

const predicateFixture: Fixture = {
  match: {
    predicate: (req) => {
      const lastMsg = req.messages[req.messages.length - 1];
      return lastMsg?.content === "custom-check";
    },
  },
  response: { content: "Predicate matched" },
};

const toolNameFixture: Fixture = {
  match: { toolName: "search_tool" },
  response: {
    toolCalls: [{ name: "search_tool", arguments: '{"q":"test"}' }],
  },
};

const allFixtures: Fixture[] = [
  textFixture,
  toolFixture,
  contentWithToolsFixture,
  errorFixture,
  sequenceFixture0,
  sequenceFixture1,
  modelFixture,
  predicateFixture,
  toolNameFixture,
];

// --- tests ---

let instance: ServerInstance | null = null;

beforeEach(() => {
  resetInteractionCounter();
  resetEventIdCounter();
});

afterEach(async () => {
  if (instance) {
    await new Promise<void>((resolve) => {
      instance!.server.close(() => resolve());
    });
    instance = null;
  }
});

// ─── Unit tests: input conversion ────────────────────────────────────────

describe("geminiInteractionsToCompletionRequest", () => {
  it("converts string input to single user message", () => {
    const result = geminiInteractionsToCompletionRequest({
      model: "gemini-2.5-flash",
      input: "hello world",
    });
    expect(result.messages).toEqual([{ role: "user", content: "hello world" }]);
    expect(result.model).toBe("gemini-2.5-flash");
    expect(result.stream).toBe(true); // default
  });

  it("converts Turn[] input with role mapping", () => {
    const result = geminiInteractionsToCompletionRequest({
      model: "gemini-2.5-flash",
      input: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "model", content: [{ type: "text", text: "hello" }] },
      ],
    });
    expect(result.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  it("converts Content[] input to single user message", () => {
    const result = geminiInteractionsToCompletionRequest({
      model: "gemini-2.5-flash",
      input: [
        { type: "text", text: "part one " },
        { type: "text", text: "part two" },
      ],
    });
    expect(result.messages).toEqual([{ role: "user", content: "part one part two" }]);
  });

  it("converts function_result input to tool messages", () => {
    const result = geminiInteractionsToCompletionRequest({
      model: "gemini-2.5-flash",
      input: [
        {
          role: "user",
          content: [
            {
              type: "function_result",
              call_id: "call_abc",
              result: { temperature: 72 },
            },
          ],
        },
      ],
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("tool");
    expect(result.messages[0].content).toBe('{"temperature":72}');
    expect(result.messages[0].tool_call_id).toBe("call_abc");
  });

  it("converts system_instruction to system message", () => {
    const result = geminiInteractionsToCompletionRequest({
      model: "gemini-2.5-flash",
      system_instruction: "Be helpful and concise",
      input: "hi",
    });
    expect(result.messages[0]).toEqual({
      role: "system",
      content: "Be helpful and concise",
    });
    expect(result.messages[1]).toEqual({ role: "user", content: "hi" });
  });

  it("converts function tool definitions", () => {
    const result = geminiInteractionsToCompletionRequest({
      model: "gemini-2.5-flash",
      input: "hi",
      tools: [
        {
          type: "function",
          name: "get_weather",
          description: "Get weather info",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      ],
    });
    expect(result.tools).toEqual([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather info",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      },
    ]);
  });

  it("maps generation_config.temperature", () => {
    const result = geminiInteractionsToCompletionRequest({
      model: "gemini-2.5-flash",
      input: "hi",
      generation_config: { temperature: 0.5 },
    });
    expect(result.temperature).toBe(0.5);
  });

  it("maps generation_config.max_output_tokens", () => {
    const result = geminiInteractionsToCompletionRequest({
      model: "gemini-2.5-flash",
      input: "hi",
      generation_config: { max_output_tokens: 1024 },
    });
    expect(result.max_tokens).toBe(1024);
  });

  it("defaults model to gemini-2.5-flash when missing", () => {
    const result = geminiInteractionsToCompletionRequest({
      input: "hi",
    });
    expect(result.model).toBe("gemini-2.5-flash");
  });

  it("handles empty input", () => {
    const result = geminiInteractionsToCompletionRequest({
      model: "gemini-2.5-flash",
    });
    expect(result.messages).toEqual([]);
  });

  it("handles mixed content blocks (text and function_call)", () => {
    const result = geminiInteractionsToCompletionRequest({
      model: "gemini-2.5-flash",
      input: [
        {
          role: "model",
          content: [
            { type: "text", text: "Calling tool..." },
            {
              type: "function_call",
              name: "search",
              id: "call_x",
              arguments: { query: "test" },
            },
          ],
        },
      ],
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("assistant");
    expect(result.messages[0].content).toBe("Calling tool...");
    expect(result.messages[0].tool_calls).toHaveLength(1);
    expect(result.messages[0].tool_calls![0].function.name).toBe("search");
  });

  it("respects stream=false", () => {
    const result = geminiInteractionsToCompletionRequest({
      model: "gemini-2.5-flash",
      input: "hi",
      stream: false,
    });
    expect(result.stream).toBe(false);
  });

  it("handles Turn with empty content array — user/assistant produce empty-content message", () => {
    const result = geminiInteractionsToCompletionRequest({
      model: "gemini-2.5-flash",
      input: [
        { role: "user", content: [] },
        { role: "model", content: [] },
      ],
    });
    expect(result.messages).toEqual([
      { role: "user", content: "" },
      { role: "assistant", content: "" },
    ]);
  });

  it("handles Turn with empty content array — non-user/non-assistant role is skipped", () => {
    const result = geminiInteractionsToCompletionRequest({
      model: "gemini-2.5-flash",
      input: [
        { role: "system", content: [] },
        { role: "user", content: [{ type: "text", text: "hi" }] },
      ],
    });
    // The system turn with empty content is skipped; only the user turn is kept
    expect(result.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("converts function_result with string result (passes through as-is)", () => {
    const result = geminiInteractionsToCompletionRequest({
      model: "gemini-2.5-flash",
      input: [
        {
          role: "user",
          content: [
            {
              type: "function_result",
              call_id: "call_str",
              result: "plain string result",
            },
          ],
        },
      ],
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("tool");
    expect(result.messages[0].content).toBe("plain string result");
    expect(result.messages[0].tool_call_id).toBe("call_str");
  });

  // ─── Legacy parts fallback tests ──────────────────────────────────────

  it("handles Turn[] with legacy parts field for text (backwards compat)", () => {
    const result = geminiInteractionsToCompletionRequest({
      model: "gemini-2.5-flash",
      input: [
        { role: "user", parts: [{ type: "text", text: "hi from parts" }] },
        { role: "model", parts: [{ type: "text", text: "hello from parts" }] },
      ],
    });
    expect(result.messages).toEqual([
      { role: "user", content: "hi from parts" },
      { role: "assistant", content: "hello from parts" },
    ]);
  });

  it("handles Turn[] with legacy parts field for function_call (backwards compat)", () => {
    const result = geminiInteractionsToCompletionRequest({
      model: "gemini-2.5-flash",
      input: [
        {
          role: "model",
          parts: [
            {
              type: "function_call",
              name: "legacy_tool",
              id: "call_legacy",
              arguments: { key: "value" },
            },
          ],
        },
      ],
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("assistant");
    expect(result.messages[0].tool_calls).toHaveLength(1);
    expect(result.messages[0].tool_calls![0].function.name).toBe("legacy_tool");
    expect(result.messages[0].tool_calls![0].id).toBe("call_legacy");
  });

  it("handles Turn[] with legacy parts field for function_result (backwards compat)", () => {
    const result = geminiInteractionsToCompletionRequest({
      model: "gemini-2.5-flash",
      input: [
        {
          role: "user",
          parts: [
            {
              type: "function_result",
              call_id: "call_legacy_result",
              result: { status: "ok" },
            },
          ],
        },
      ],
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("tool");
    expect(result.messages[0].content).toBe('{"status":"ok"}');
    expect(result.messages[0].tool_call_id).toBe("call_legacy_result");
  });

  // ─── result vs output preference tests ────────────────────────────────

  it("falls back to output when result is not present (backwards compat)", () => {
    const result = geminiInteractionsToCompletionRequest({
      model: "gemini-2.5-flash",
      input: [
        {
          role: "user",
          content: [
            {
              type: "function_result",
              call_id: "call_old",
              output: { legacy: true },
            },
          ],
        },
      ],
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("tool");
    expect(result.messages[0].content).toBe('{"legacy":true}');
    expect(result.messages[0].tool_call_id).toBe("call_old");
  });

  it("prefers result over output when both are present on a function_result", () => {
    const result = geminiInteractionsToCompletionRequest({
      model: "gemini-2.5-flash",
      input: [
        {
          role: "user",
          content: [
            {
              type: "function_result",
              call_id: "call_both",
              result: { from: "result" },
              output: { from: "output" },
            },
          ],
        },
      ],
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("tool");
    expect(result.messages[0].content).toBe('{"from":"result"}');
    expect(result.messages[0].tool_call_id).toBe("call_both");
  });

  // ─── content vs parts preference test ─────────────────────────────────

  it("prefers content over parts when both are present on a Turn", () => {
    const result = geminiInteractionsToCompletionRequest({
      model: "gemini-2.5-flash",
      input: [
        {
          role: "user",
          content: [{ type: "text", text: "from-content" }],
          parts: [{ type: "text", text: "from-parts" }],
        },
      ],
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content).toBe("from-content");
  });

  // ─── Step[] envelope (live API wire contract) ─────────────────────────

  it("converts Step[] user_input step to a user message", () => {
    const result = geminiInteractionsToCompletionRequest({
      model: "gemini-2.5-flash",
      input: [{ type: "user_input", content: [{ type: "text", text: "hi" }] }],
    });
    expect(result.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("converts Step[] user_input with multiple text parts (concatenates)", () => {
    const result = geminiInteractionsToCompletionRequest({
      model: "gemini-2.5-flash",
      input: [
        {
          type: "user_input",
          content: [
            { type: "text", text: "part one " },
            { type: "text", text: "part two" },
          ],
        },
      ],
    });
    expect(result.messages).toEqual([{ role: "user", content: "part one part two" }]);
  });

  it("converts Step[] function_result step to a tool message", () => {
    const result = geminiInteractionsToCompletionRequest({
      model: "gemini-2.5-flash",
      input: [
        {
          type: "function_result",
          call_id: "call_abc",
          name: "get_weather",
          result: { temperature: 72 },
        },
      ],
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("tool");
    expect(result.messages[0].content).toBe('{"temperature":72}');
    expect(result.messages[0].tool_call_id).toBe("call_abc");
  });

  it("passes through Step[] function_result with string result", () => {
    const result = geminiInteractionsToCompletionRequest({
      model: "gemini-2.5-flash",
      input: [{ type: "function_result", call_id: "call_x", result: "ok" }],
    });
    expect(result.messages).toEqual([{ role: "tool", content: "ok", tool_call_id: "call_x" }]);
  });

  it("converts Step[] model_output text step to an assistant message", () => {
    const result = geminiInteractionsToCompletionRequest({
      model: "gemini-2.5-flash",
      input: [
        { type: "user_input", content: [{ type: "text", text: "hi" }] },
        { type: "model_output", content: [{ type: "text", text: "hello" }] },
      ],
    });
    expect(result.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  it("converts Step[] model_output with function_call into assistant tool_calls", () => {
    const result = geminiInteractionsToCompletionRequest({
      model: "gemini-2.5-flash",
      input: [
        {
          type: "model_output",
          content: [
            { type: "text", text: "Calling tool..." },
            {
              type: "function_call",
              name: "search",
              id: "call_x",
              arguments: { query: "test" },
            },
          ],
        },
      ],
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("assistant");
    expect(result.messages[0].content).toBe("Calling tool...");
    expect(result.messages[0].tool_calls).toHaveLength(1);
    expect(result.messages[0].tool_calls![0].function.name).toBe("search");
    expect(result.messages[0].tool_calls![0].id).toBe("call_x");
  });

  it("converts a multi-step Step[] agent loop in order", () => {
    const result = geminiInteractionsToCompletionRequest({
      model: "gemini-2.5-flash",
      input: [
        { type: "user_input", content: [{ type: "text", text: "what's the weather?" }] },
        {
          type: "model_output",
          content: [
            {
              type: "function_call",
              name: "get_weather",
              id: "call_w",
              arguments: { city: "NYC" },
            },
          ],
        },
        { type: "function_result", call_id: "call_w", result: { temp: 72 } },
        { type: "user_input", content: [{ type: "text", text: "thanks" }] },
      ],
    });
    expect(result.messages).toHaveLength(4);
    expect(result.messages[0]).toEqual({ role: "user", content: "what's the weather?" });
    expect(result.messages[1].role).toBe("assistant");
    expect(result.messages[1].tool_calls![0].function.name).toBe("get_weather");
    expect(result.messages[2]).toEqual({
      role: "tool",
      content: '{"temp":72}',
      tool_call_id: "call_w",
    });
    expect(result.messages[3]).toEqual({ role: "user", content: "thanks" });
  });

  it("handles other *_result Step types as tool messages", () => {
    const result = geminiInteractionsToCompletionRequest({
      model: "gemini-2.5-flash",
      input: [
        {
          type: "code_execution_result",
          call_id: "call_code",
          result: "stdout: 42\n",
        },
      ],
    });
    expect(result.messages).toEqual([
      { role: "tool", content: "stdout: 42\n", tool_call_id: "call_code" },
    ]);
  });

  it.each([
    "url_context_result",
    "google_search_result",
    "google_maps_result",
    "mcp_server_tool_result",
    "file_search_result",
  ])("handles Step[] %s as a tool message", (stepType) => {
    const result = geminiInteractionsToCompletionRequest({
      model: "gemini-2.5-flash",
      input: [
        {
          type: stepType,
          call_id: `call_${stepType}`,
          result: { data: "test" },
        },
      ],
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("tool");
    expect(result.messages[0].content).toBe('{"data":"test"}');
    expect(result.messages[0].tool_call_id).toBe(`call_${stepType}`);
  });

  it("handles Step[] user_input with empty content", () => {
    const result = geminiInteractionsToCompletionRequest({
      model: "gemini-2.5-flash",
      input: [{ type: "user_input", content: [] }],
    });
    expect(result.messages).toEqual([{ role: "user", content: "" }]);
  });

  it("handles Step[] model_output with undefined content", () => {
    const result = geminiInteractionsToCompletionRequest({
      model: "gemini-2.5-flash",
      input: [{ type: "model_output" }],
    });
    expect(result.messages).toEqual([{ role: "assistant", content: "" }]);
  });

  it("handles Step[] model_output with empty content array", () => {
    const result = geminiInteractionsToCompletionRequest({
      model: "gemini-2.5-flash",
      input: [{ type: "model_output", content: [] }],
    });
    expect(result.messages).toEqual([{ role: "assistant", content: "" }]);
  });
});

// ─── Unit tests: response builders ──────────────────────────────────────

describe("response builders", () => {
  const logger = new Logger("silent");

  it("builds text response", () => {
    const resp = buildInteractionsTextResponse(
      "Hello!",
      "gemini-2.5-flash",
      "aimock-int-0",
    ) as Record<string, unknown>;
    expect(resp.id).toBe("aimock-int-0");
    expect(resp.status).toBe("completed");
    expect(resp.model).toBe("gemini-2.5-flash");
    expect(resp.role).toBe("model");
    expect(resp.outputs).toEqual([{ type: "text", text: "Hello!" }]);
  });

  it("builds tool call response", () => {
    const resp = buildInteractionsToolCallResponse(
      [{ name: "get_weather", arguments: '{"city":"NYC"}', id: "call_1" }],
      "gemini-2.5-flash",
      "aimock-int-0",
      logger,
    ) as Record<string, unknown>;
    expect(resp.status).toBe("requires_action");
    const outputs = resp.outputs as Array<Record<string, unknown>>;
    expect(outputs).toHaveLength(1);
    expect(outputs[0].type).toBe("function_call");
    expect(outputs[0].name).toBe("get_weather");
    expect(outputs[0].arguments).toEqual({ city: "NYC" });
  });

  it("builds content+tools response", () => {
    const resp = buildInteractionsContentWithToolCallsResponse(
      "Here is the analysis",
      [{ name: "analyze", arguments: '{"x":1}', id: "call_3" }],
      "gemini-2.5-flash",
      "aimock-int-0",
      logger,
    ) as Record<string, unknown>;
    expect(resp.status).toBe("requires_action");
    const outputs = resp.outputs as Array<Record<string, unknown>>;
    expect(outputs).toHaveLength(2);
    expect(outputs[0].type).toBe("text");
    expect(outputs[1].type).toBe("function_call");
  });

  it("includes usage metadata", () => {
    const resp = buildInteractionsTextResponse("Hello!", "gemini-2.5-flash", "aimock-int-0", {
      usage: { input_tokens: 10, output_tokens: 5 },
    }) as Record<string, unknown>;
    expect(resp.usage).toEqual({
      total_input_tokens: 10,
      total_output_tokens: 5,
      total_tokens: 15,
    });
  });

  it("generates deterministic interactionIds", () => {
    resetInteractionCounter();
    const r1 = buildInteractionsTextResponse("a", "m", "aimock-int-0");
    const r2 = buildInteractionsTextResponse("b", "m", "aimock-int-1");
    expect((r1 as Record<string, unknown>).id).toBe("aimock-int-0");
    expect((r2 as Record<string, unknown>).id).toBe("aimock-int-1");
  });

  it("uses correct status values for different response types", () => {
    const textResp = buildInteractionsTextResponse("Hello", "m", "id-0") as Record<string, unknown>;
    const toolResp = buildInteractionsToolCallResponse(
      [{ name: "fn", arguments: "{}" }],
      "m",
      "id-1",
      logger,
    ) as Record<string, unknown>;
    expect(textResp.status).toBe("completed");
    expect(toolResp.status).toBe("requires_action");
  });

  it("handles malformed JSON in tool call arguments gracefully", () => {
    const resp = buildInteractionsToolCallResponse(
      [{ name: "fn", arguments: "not-json", id: "call_x" }],
      "m",
      "id-0",
      logger,
    ) as Record<string, unknown>;
    const outputs = resp.outputs as Array<Record<string, unknown>>;
    expect(outputs[0].arguments).toEqual({});
  });
});

// ─── Unit tests: SSE event builders ─────────────────────────────────────

describe("SSE event builders", () => {
  const logger = new Logger("silent");

  beforeEach(() => {
    resetEventIdCounter();
  });

  it("builds correct text SSE event sequence", () => {
    const events = buildInteractionsTextSSEEvents("Hello!", "aimock-int-0", 100);
    expect(events[0].event_type).toBe("interaction.start");
    expect(events[1].event_type).toBe("content.start");
    expect(events[1].index).toBe(0);
    expect(events[2].event_type).toBe("content.delta");
    expect((events[2].delta as Record<string, unknown>).type).toBe("text");
    expect((events[2].delta as Record<string, unknown>).text).toBe("Hello!");
    expect(events[3].event_type).toBe("content.stop");
    expect(events[4].event_type).toBe("interaction.complete");
  });

  it("builds correct tool call SSE event sequence", () => {
    const events = buildInteractionsToolCallSSEEvents(
      [{ name: "get_weather", arguments: '{"city":"NYC"}', id: "call_1" }],
      "aimock-int-0",
      logger,
    );
    const eventTypes = events.map((e) => e.event_type);
    expect(eventTypes).toEqual([
      "interaction.start",
      "content.start",
      "content.delta",
      "content.stop",
      "interaction.complete",
    ]);
    const delta = events[2].delta as Record<string, unknown>;
    expect(delta.type).toBe("function_call");
    expect(delta.name).toBe("get_weather");
    expect(delta.arguments).toEqual({ city: "NYC" });
  });

  it("builds content+tools SSE with correct indices", () => {
    const events = buildInteractionsContentWithToolCallsSSEEvents(
      "Text",
      [{ name: "fn", arguments: '{"a":1}', id: "call_1" }],
      "aimock-int-0",
      100,
      logger,
    );
    // Find content.start events — should have indices 0 and 1
    const contentStarts = events.filter((e) => e.event_type === "content.start");
    expect(contentStarts).toHaveLength(2);
    expect(contentStarts[0].index).toBe(0); // text
    expect((contentStarts[0].content as Record<string, unknown>).type).toBe("text");
    expect(contentStarts[1].index).toBe(1); // function_call
    expect((contentStarts[1].content as Record<string, unknown>).type).toBe("function_call");
  });

  it("increments event_id correctly", () => {
    const events = buildInteractionsTextSSEEvents("Hi", "aimock-int-0", 100);
    const ids = events.map((e) => e.event_id);
    expect(ids).toEqual(["evt_1", "evt_2", "evt_3", "evt_4", "evt_5"]);
  });

  it("includes usage in interaction.complete event", () => {
    const events = buildInteractionsTextSSEEvents("Hi", "aimock-int-0", 100, {
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const completeEvent = events.find((e) => e.event_type === "interaction.complete")!;
    const interaction = completeEvent.interaction as Record<string, unknown>;
    expect(interaction.usage).toEqual({
      total_input_tokens: 10,
      total_output_tokens: 5,
      total_tokens: 15,
    });
  });

  it("chunks text by chunkSize", () => {
    const events = buildInteractionsTextSSEEvents("ABCDEFGH", "aimock-int-0", 3);
    const deltas = events.filter((e) => e.event_type === "content.delta");
    expect(deltas).toHaveLength(3); // ABC, DEF, GH
    expect((deltas[0].delta as Record<string, unknown>).text).toBe("ABC");
    expect((deltas[1].delta as Record<string, unknown>).text).toBe("DEF");
    expect((deltas[2].delta as Record<string, unknown>).text).toBe("GH");
  });
});

// ─── Integration tests: non-streaming ───────────────────────────────────

describe("Gemini Interactions — non-streaming", () => {
  it("returns text response", async () => {
    instance = await createServer([...allFixtures]);
    const res = await post(`${instance.url}/v1beta/interactions`, {
      model: "gemini-2.5-flash",
      input: "hello",
      stream: false,
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("completed");
    expect(body.role).toBe("model");
    expect(body.outputs).toEqual([{ type: "text", text: "Hi there!" }]);
    expect(body.id).toMatch(/^aimock-int-/);
  });

  it("returns tool call response", async () => {
    instance = await createServer([...allFixtures]);
    const res = await post(`${instance.url}/v1beta/interactions`, {
      model: "gemini-2.5-flash",
      input: "weather",
      stream: false,
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("requires_action");
    const outputs = body.outputs;
    expect(outputs).toHaveLength(1);
    expect(outputs[0].type).toBe("function_call");
    expect(outputs[0].name).toBe("get_weather");
    expect(outputs[0].arguments).toEqual({ city: "NYC" });
  });

  it("returns content + tool calls response", async () => {
    instance = await createServer([...allFixtures]);
    const res = await post(`${instance.url}/v1beta/interactions`, {
      model: "gemini-2.5-flash",
      input: "analyze",
      stream: false,
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("requires_action");
    expect(body.outputs).toHaveLength(2);
    expect(body.outputs[0].type).toBe("text");
    expect(body.outputs[0].text).toBe("Let me help you");
    expect(body.outputs[1].type).toBe("function_call");
    expect(body.outputs[1].name).toBe("analyze_data");
  });

  it("returns error response", async () => {
    instance = await createServer([...allFixtures]);
    const res = await post(`${instance.url}/v1beta/interactions`, {
      model: "gemini-2.5-flash",
      input: "fail",
      stream: false,
    });
    expect(res.status).toBe(429);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("Rate limited");
    expect(body.error.code).toBe("RESOURCE_EXHAUSTED");
  });

  it("returns 404 when no fixture matches", async () => {
    instance = await createServer([...allFixtures]);
    const res = await post(`${instance.url}/v1beta/interactions`, {
      model: "gemini-2.5-flash",
      input: "unmatched query",
      stream: false,
    });
    expect(res.status).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("returns 503 in strict mode", async () => {
    instance = await createServer([...allFixtures], { strict: true });
    const res = await post(`${instance.url}/v1beta/interactions`, {
      model: "gemini-2.5-flash",
      input: "unmatched",
      stream: false,
    });
    expect(res.status).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("UNAVAILABLE");
  });

  it("returns the skipped-by-state message when a sequence-exhausted fixture is replayed", async () => {
    const seqFixture: Fixture = {
      match: { userMessage: "seq-step", sequenceIndex: 0 },
      response: { content: "First" },
    };
    instance = await createServer([seqFixture], { strict: true });
    // First call consumes the sequenceIndex:0 fixture (count → 1).
    const first = await post(`${instance.url}/v1beta/interactions`, {
      model: "gemini-2.5-flash",
      input: "seq-step",
      stream: false,
    });
    expect(first.status).toBe(200);
    // Replay: shape still matches but the fixture is skipped by sequence state.
    const res = await post(`${instance.url}/v1beta/interactions`, {
      model: "gemini-2.5-flash",
      input: "seq-step",
      stream: false,
    });
    expect(res.status).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.error.message).toMatch(/candidate fixture\(s\) skipped by sequence\/turn state/);
  });

  it("matches userMessage fixture when input is Step[] envelope (issue #228)", async () => {
    // Reproduces the live wire contract that Google's /v1beta/interactions accepts:
    // a top-level Array<Step> where each step is { type: "user_input", content: [...] }.
    // Pre-fix this fell through to the Content[] branch and produced an empty user
    // message, so userMessage-based fixtures never matched.
    instance = await createServer([textFixture]);
    const res = await post(`${instance.url}/v1beta/interactions`, {
      model: "gemini-2.5-flash",
      stream: false,
      input: [{ type: "user_input", content: [{ type: "text", text: "hello" }] }],
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.outputs).toEqual([{ type: "text", text: "Hi there!" }]);
  });

  it("handles sequenceIndex for multi-turn", async () => {
    instance = await createServer([...allFixtures]);
    const r1 = await post(`${instance.url}/v1beta/interactions`, {
      model: "gemini-2.5-flash",
      input: "step",
      stream: false,
    });
    const r2 = await post(`${instance.url}/v1beta/interactions`, {
      model: "gemini-2.5-flash",
      input: "step",
      stream: false,
    });
    expect(JSON.parse(r1.body).outputs[0].text).toBe("First");
    expect(JSON.parse(r2.body).outputs[0].text).toBe("Second");
  });
});

// ─── Integration tests: streaming ───────────────────────────────────────

describe("Gemini Interactions — streaming", () => {
  it("streams text response with correct SSE sequence", async () => {
    instance = await createServer([...allFixtures]);
    const res = await post(`${instance.url}/v1beta/interactions`, {
      model: "gemini-2.5-flash",
      input: "hello",
      stream: true,
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream");

    const events = parseInteractionsSSEEvents(res.body);
    expect(events.length).toBeGreaterThanOrEqual(5);

    const eventTypes = (events as Array<Record<string, unknown>>).map((e) => e.event_type);
    expect(eventTypes[0]).toBe("interaction.start");
    expect(eventTypes[1]).toBe("content.start");
    expect(eventTypes).toContain("content.delta");
    expect(eventTypes).toContain("content.stop");
    expect(eventTypes[eventTypes.length - 1]).toBe("interaction.complete");
  });

  it("accumulates content from text deltas", async () => {
    instance = await createServer([
      {
        match: { userMessage: "chunked" },
        response: { content: "ABCDEFGHIJ" },
        chunkSize: 3,
      },
    ]);
    const res = await post(`${instance.url}/v1beta/interactions`, {
      model: "gemini-2.5-flash",
      input: "chunked",
      stream: true,
    });
    const events = parseInteractionsSSEEvents(res.body) as Array<Record<string, unknown>>;
    const textDeltas = events.filter(
      (e) =>
        e.event_type === "content.delta" && (e.delta as Record<string, unknown>).type === "text",
    );
    const accumulated = textDeltas.map((e) => (e.delta as Record<string, unknown>).text).join("");
    expect(accumulated).toBe("ABCDEFGHIJ");
  });

  it("streams tool call deltas", async () => {
    instance = await createServer([...allFixtures]);
    const res = await post(`${instance.url}/v1beta/interactions`, {
      model: "gemini-2.5-flash",
      input: "weather",
      stream: true,
    });
    const events = parseInteractionsSSEEvents(res.body) as Array<Record<string, unknown>>;
    const funcDeltas = events.filter(
      (e) =>
        e.event_type === "content.delta" &&
        (e.delta as Record<string, unknown>).type === "function_call",
    );
    expect(funcDeltas).toHaveLength(1);
    const delta = funcDeltas[0].delta as Record<string, unknown>;
    expect(delta.name).toBe("get_weather");
    expect(delta.arguments).toEqual({ city: "NYC" });
  });

  it("assigns correct indices for content+tools stream", async () => {
    instance = await createServer([...allFixtures]);
    const res = await post(`${instance.url}/v1beta/interactions`, {
      model: "gemini-2.5-flash",
      input: "analyze",
      stream: true,
    });
    const events = parseInteractionsSSEEvents(res.body) as Array<Record<string, unknown>>;

    // Text at index 0, tool call at index 1
    const textDelta = events.find(
      (e) =>
        e.event_type === "content.delta" && (e.delta as Record<string, unknown>).type === "text",
    );
    const toolDelta = events.find(
      (e) =>
        e.event_type === "content.delta" &&
        (e.delta as Record<string, unknown>).type === "function_call",
    );
    expect(textDelta?.index).toBe(0);
    expect(toolDelta?.index).toBe(1);
  });

  it("includes interactionId in lifecycle events", async () => {
    instance = await createServer([...allFixtures]);
    const res = await post(`${instance.url}/v1beta/interactions`, {
      model: "gemini-2.5-flash",
      input: "hello",
      stream: true,
    });
    const events = parseInteractionsSSEEvents(res.body) as Array<Record<string, unknown>>;

    const startEvent = events.find((e) => e.event_type === "interaction.start")!;
    const completeEvent = events.find((e) => e.event_type === "interaction.complete")!;

    const startInteraction = startEvent.interaction as Record<string, unknown>;
    const completeInteraction = completeEvent.interaction as Record<string, unknown>;

    expect(startInteraction.id).toMatch(/^aimock-int-/);
    expect(completeInteraction.id).toBe(startInteraction.id);
    expect(startInteraction.status).toBe("in_progress");
    expect(completeInteraction.status).toBe("completed");
  });

  it("respects streaming profile", async () => {
    instance = await createServer([
      {
        match: { userMessage: "slow" },
        response: { content: "ABCD" },
        chunkSize: 1,
        streamingProfile: { ttft: 50, tps: 100 },
      },
    ]);
    const start = Date.now();
    const res = await post(`${instance.url}/v1beta/interactions`, {
      model: "gemini-2.5-flash",
      input: "slow",
      stream: true,
    });
    const elapsed = Date.now() - start;
    expect(res.status).toBe(200);
    // ttft=50ms + 4 chunks at ~10ms each ≈ 90ms; 40ms is a safe lower bound
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });

  it("defaults to streaming when stream field is omitted", async () => {
    instance = await createServer([...allFixtures]);
    const res = await post(`${instance.url}/v1beta/interactions`, {
      model: "gemini-2.5-flash",
      input: "hello",
      // no stream field — defaults to true
    });
    expect(res.headers["content-type"]).toBe("text/event-stream");
  });

  it("handles interruption via truncateAfterChunks", async () => {
    instance = await createServer([
      {
        match: { userMessage: "interrupt" },
        response: { content: "A".repeat(100) },
        chunkSize: 1,
        truncateAfterChunks: 3,
      },
    ]);
    // The server destroys the socket on truncation, so we may get a partial
    // response or a connection reset. Either outcome is correct.
    let body = "";
    try {
      const res = await post(`${instance.url}/v1beta/interactions`, {
        model: "gemini-2.5-flash",
        input: "interrupt",
        stream: true,
      });
      body = res.body;
    } catch (err: unknown) {
      // socket hang up / ECONNRESET is expected when truncation destroys the connection
      const code = (err as { code?: string }).code;
      if (code !== "ECONNRESET") throw err;
      // Interruption confirmed by connection being destroyed
      return;
    }
    // If we got a response body, it should be truncated
    const events = parseInteractionsSSEEvents(body);
    expect(events.length).toBeLessThan(105);
  });
});

// ─── Fixture matching ───────────────────────────────────────────────────

describe("Gemini Interactions — fixture matching", () => {
  it("matches by userMessage", async () => {
    instance = await createServer([...allFixtures]);
    const res = await post(`${instance.url}/v1beta/interactions`, {
      model: "gemini-2.5-flash",
      input: "hello",
      stream: false,
    });
    expect(JSON.parse(res.body).outputs[0].text).toBe("Hi there!");
  });

  it("matches by sequenceIndex chaining", async () => {
    instance = await createServer([...allFixtures]);
    const r1 = await post(`${instance.url}/v1beta/interactions`, {
      model: "gemini-2.5-flash",
      input: "step",
      stream: false,
    });
    const r2 = await post(`${instance.url}/v1beta/interactions`, {
      model: "gemini-2.5-flash",
      input: "step",
      stream: false,
    });
    expect(JSON.parse(r1.body).outputs[0].text).toBe("First");
    expect(JSON.parse(r2.body).outputs[0].text).toBe("Second");
  });

  it("matches by model", async () => {
    instance = await createServer([...allFixtures]);
    const res = await post(`${instance.url}/v1beta/interactions`, {
      model: "gemini-2.5-pro",
      input: "anything",
      stream: false,
    });
    expect(JSON.parse(res.body).outputs[0].text).toBe("Pro response");
  });

  it("matches by predicate", async () => {
    instance = await createServer([...allFixtures]);
    const res = await post(`${instance.url}/v1beta/interactions`, {
      model: "gemini-2.5-flash",
      input: "custom-check",
      stream: false,
    });
    expect(JSON.parse(res.body).outputs[0].text).toBe("Predicate matched");
  });

  it("matches by toolName for tool-related fixtures", async () => {
    instance = await createServer([...allFixtures]);
    const res = await post(`${instance.url}/v1beta/interactions`, {
      model: "gemini-2.5-flash",
      input: [
        {
          role: "user",
          content: [
            {
              type: "function_result",
              call_id: "call_abc",
              result: "result",
            },
          ],
        },
      ],
      tools: [{ type: "function", name: "search_tool", description: "Search" }],
      stream: false,
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.outputs[0].name).toBe("search_tool");
  });
});

// ─── Stream collapse ────────────────────────────────────────────────────

describe("collapseGeminiInteractionsSSE", () => {
  it("collapses text deltas", () => {
    const sse = [
      'data: {"event_type":"interaction.start","interaction":{"id":"int-0","status":"in_progress"},"event_id":"evt_1"}',
      'data: {"event_type":"content.start","index":0,"content":{"type":"text"},"event_id":"evt_2"}',
      'data: {"event_type":"content.delta","index":0,"delta":{"type":"text","text":"Hello "},"event_id":"evt_3"}',
      'data: {"event_type":"content.delta","index":0,"delta":{"type":"text","text":"World"},"event_id":"evt_4"}',
      'data: {"event_type":"content.stop","index":0,"event_id":"evt_5"}',
      'data: {"event_type":"interaction.complete","interaction":{"id":"int-0","status":"completed","usage":{"total_input_tokens":10,"total_output_tokens":5,"total_tokens":15}},"event_id":"evt_6"}',
    ].join("\n\n");
    const result = collapseGeminiInteractionsSSE(sse);
    expect(result.content).toBe("Hello World");
    expect(result.toolCalls).toBeUndefined();
  });

  it("collapses tool call deltas", () => {
    const sse = [
      'data: {"event_type":"interaction.start","interaction":{"id":"int-0"},"event_id":"evt_1"}',
      'data: {"event_type":"content.start","index":0,"content":{"type":"function_call"},"event_id":"evt_2"}',
      'data: {"event_type":"content.delta","index":0,"delta":{"type":"function_call","id":"call_1","name":"get_weather","arguments":{"city":"NYC"}},"event_id":"evt_3"}',
      'data: {"event_type":"content.stop","index":0,"event_id":"evt_4"}',
      'data: {"event_type":"interaction.complete","interaction":{"id":"int-0","status":"requires_action"},"event_id":"evt_5"}',
    ].join("\n\n");
    const result = collapseGeminiInteractionsSSE(sse);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].name).toBe("get_weather");
    expect(result.toolCalls![0].arguments).toBe('{"city":"NYC"}');
    expect(result.toolCalls![0].id).toBe("call_1");
  });

  it("collapses content + tool calls", () => {
    const sse = [
      'data: {"event_type":"content.delta","index":0,"delta":{"type":"text","text":"Help"},"event_id":"evt_1"}',
      'data: {"event_type":"content.delta","index":1,"delta":{"type":"function_call","id":"c1","name":"fn","arguments":{"x":1}},"event_id":"evt_2"}',
    ].join("\n\n");
    const result = collapseGeminiInteractionsSSE(sse);
    expect(result.content).toBe("Help");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].name).toBe("fn");
  });

  it("collapses thought_summary deltas as reasoning", () => {
    const sse = [
      'data: {"event_type":"content.delta","index":0,"delta":{"type":"thought_summary","text":"Thinking..."},"event_id":"evt_1"}',
      'data: {"event_type":"content.delta","index":1,"delta":{"type":"text","text":"Answer"},"event_id":"evt_2"}',
    ].join("\n\n");
    const result = collapseGeminiInteractionsSSE(sse);
    expect(result.reasoning).toBe("Thinking...");
    expect(result.content).toBe("Answer");
  });

  it("handles malformed chunks gracefully", () => {
    const sse = [
      "data: not-json",
      'data: {"event_type":"content.delta","index":0,"delta":{"type":"text","text":"ok"},"event_id":"evt_1"}',
    ].join("\n\n");
    const result = collapseGeminiInteractionsSSE(sse);
    expect(result.content).toBe("ok");
    expect(result.droppedChunks).toBe(1);
  });

  it("handles incomplete stream (no interaction.complete)", () => {
    const sse = [
      'data: {"event_type":"content.delta","index":0,"delta":{"type":"text","text":"partial"},"event_id":"evt_1"}',
    ].join("\n\n");
    const result = collapseGeminiInteractionsSSE(sse);
    expect(result.content).toBe("partial");
  });

  it("returns empty content for stream with no data events", () => {
    const result = collapseGeminiInteractionsSSE("");
    expect(result.content).toBe("");
  });
});

// ─── CORS ───────────────────────────────────────────────────────────────

describe("Gemini Interactions — CORS", () => {
  it("sets CORS headers on response", async () => {
    instance = await createServer([...allFixtures]);
    const res = await post(`${instance.url}/v1beta/interactions`, {
      model: "gemini-2.5-flash",
      input: "hello",
      stream: false,
    });
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });
});

// ─── Journal ────────────────────────────────────────────────────────────

describe("Gemini Interactions — journal", () => {
  it("records request in journal", async () => {
    instance = await createServer([...allFixtures]);
    await post(`${instance.url}/v1beta/interactions`, {
      model: "gemini-2.5-flash",
      input: "hello",
      stream: false,
    });
    const entries = instance.journal.getAll();
    expect(entries.length).toBeGreaterThan(0);
    const last = entries[entries.length - 1];
    expect(last.path).toBe("/v1beta/interactions");
    expect(last.response.status).toBe(200);
  });
});

// ─── Edge cases ─────────────────────────────────────────────────────────

describe("Gemini Interactions — edge cases", () => {
  it("returns 400 for malformed JSON", async () => {
    instance = await createServer([...allFixtures]);
    const res = await postRaw(`${instance.url}/v1beta/interactions`, "{bad json");
    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("INVALID_ARGUMENT");
  });

  it("handles empty content text response", async () => {
    instance = await createServer([
      {
        match: { userMessage: "empty" },
        response: { content: "" },
      },
    ]);
    const res = await post(`${instance.url}/v1beta/interactions`, {
      model: "gemini-2.5-flash",
      input: "empty",
      stream: false,
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.outputs[0].text).toBe("");
  });

  it("streams empty content correctly", async () => {
    instance = await createServer([
      {
        match: { userMessage: "empty-stream" },
        response: { content: "" },
      },
    ]);
    const res = await post(`${instance.url}/v1beta/interactions`, {
      model: "gemini-2.5-flash",
      input: "empty-stream",
      stream: true,
    });
    const events = parseInteractionsSSEEvents(res.body) as Array<Record<string, unknown>>;
    const deltas = events.filter((e) => e.event_type === "content.delta");
    expect(deltas).toHaveLength(1);
    expect((deltas[0].delta as Record<string, unknown>).text).toBe("");
  });

  it("returns 500 for unrecognized fixture response type", async () => {
    instance = await createServer([
      {
        match: { userMessage: "bad-shape" },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        response: { unknownField: true } as any,
      },
    ]);
    const res = await post(`${instance.url}/v1beta/interactions`, {
      model: "gemini-2.5-flash",
      input: "bad-shape",
      stream: false,
    });
    expect(res.status).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("INTERNAL");
    expect(body.error.message).toBe("Fixture response did not match any known type");
  });
});
