import { describe, it, expect, afterEach } from "vitest";
import { isContentWithToolCallsResponse, isTextResponse, isToolCallResponse } from "../helpers.js";
import { LLMock } from "../llmock.js";
import type { SSEChunk } from "../types.js";

describe("isContentWithToolCallsResponse", () => {
  it("returns true when both content and toolCalls are present", () => {
    const r = {
      content: "Hello",
      toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
    };
    expect(isContentWithToolCallsResponse(r)).toBe(true);
  });

  it("returns false for text-only response", () => {
    const r = { content: "Hello" };
    expect(isContentWithToolCallsResponse(r)).toBe(false);
  });

  it("returns false for tool-call-only response", () => {
    const r = { toolCalls: [{ name: "get_weather", arguments: "{}" }] };
    expect(isContentWithToolCallsResponse(r)).toBe(false);
  });

  it("returns false for error response", () => {
    const r = { error: { message: "fail" } };
    expect(isContentWithToolCallsResponse(r)).toBe(false);
  });

  it("existing guards are mutually exclusive with combined response", () => {
    const r = {
      content: "Hello",
      toolCalls: [{ name: "get_weather", arguments: "{}" }],
    };
    // Guards are mutually exclusive — combined response only matches isContentWithToolCallsResponse
    expect(isTextResponse(r)).toBe(false);
    expect(isToolCallResponse(r)).toBe(false);
    expect(isContentWithToolCallsResponse(r)).toBe(true);
  });
});

function parseSSEChunks(body: string): SSEChunk[] {
  return body
    .split("\n\n")
    .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
    .map((line) => JSON.parse(line.slice(6)) as SSEChunk);
}

describe("OpenAI Chat Completions — content + toolCalls", () => {
  let mock: LLMock | null = null;

  afterEach(async () => {
    if (mock) {
      await mock.stop();
      mock = null;
    }
  });

  it("streams content chunks then tool call chunks with finish_reason tool_calls", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "test combined" },
      response: {
        content: "Let me check.",
        toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
      },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "test combined" }],
        stream: true,
      }),
    });

    const chunks = parseSSEChunks(await res.text());
    const contentChunks = chunks.filter((c) => c.choices?.[0]?.delta?.content);
    const toolChunks = chunks.filter((c) => c.choices?.[0]?.delta?.tool_calls);
    const finishChunk = chunks.find((c) => c.choices?.[0]?.finish_reason);

    expect(contentChunks.length).toBeGreaterThan(0);
    expect(toolChunks.length).toBeGreaterThan(0);
    expect(finishChunk!.choices[0].finish_reason).toBe("tool_calls");

    const lastContentIdx = chunks.lastIndexOf(contentChunks.at(-1)!);
    const firstToolIdx = chunks.indexOf(toolChunks[0]);
    expect(lastContentIdx).toBeLessThan(firstToolIdx);

    const fullContent = contentChunks.map((c) => c.choices[0].delta.content).join("");
    expect(fullContent).toBe("Let me check.");
  });

  it("non-streaming returns both content and tool_calls", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "test combined non-stream" },
      response: {
        content: "Checking now.",
        toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
      },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "test combined non-stream" }],
        stream: false,
      }),
    });

    const body = await res.json();
    const msg = body.choices[0].message;
    expect(msg.content).toBe("Checking now.");
    expect(msg.tool_calls).toHaveLength(1);
    expect(msg.tool_calls[0].function.name).toBe("get_weather");
    expect(body.choices[0].finish_reason).toBe("tool_calls");
  });
});

function parseResponsesSSEEvents(body: string): Array<{ type: string; [key: string]: unknown }> {
  return body
    .split("\n\n")
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
      if (!dataLine) return null;
      return JSON.parse(dataLine.slice(6)) as { type: string; [key: string]: unknown };
    })
    .filter(Boolean) as Array<{ type: string; [key: string]: unknown }>;
}

describe("OpenAI Responses API — content + toolCalls", () => {
  let mock: LLMock | null = null;

  afterEach(async () => {
    if (mock) {
      await mock.stop();
      mock = null;
    }
  });

  it("streams text output then function_call output", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "test responses combined" },
      response: {
        content: "Sure.",
        toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
      },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({
        model: "gpt-4o",
        input: [{ role: "user", content: "test responses combined" }],
        stream: true,
      }),
    });

    const events = parseResponsesSSEEvents(await res.text());

    const textDelta = events.find((e) => e.type === "response.output_text.delta");
    const fcAdded = events.find(
      (e) =>
        e.type === "response.output_item.added" &&
        (e.item as { type: string })?.type === "function_call",
    );
    const completed = events.find((e) => e.type === "response.completed");
    const output = (completed!.response as { output: Array<{ type: string }> }).output;

    expect(textDelta).toBeDefined();
    const allTextDeltas = events
      .filter((e) => e.type === "response.output_text.delta")
      .map((e) => (e as unknown as { delta: string }).delta)
      .join("");
    expect(allTextDeltas).toBe("Sure.");
    expect(fcAdded).toBeDefined();

    const types = output.map((o) => o.type);
    expect(types).toContain("message");
    expect(types).toContain("function_call");
    expect(types.indexOf("message")).toBeLessThan(types.indexOf("function_call"));
  });

  it("non-streaming returns both message and function_call output", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "test responses combined ns" },
      response: {
        content: "Sure.",
        toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
      },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({
        model: "gpt-4o",
        input: [{ role: "user", content: "test responses combined ns" }],
        stream: false,
      }),
    });

    const body = await res.json();
    const output = body.output as Array<{ type: string; content?: Array<{ text: string }> }>;
    const msgItem = output.find((o) => o.type === "message");
    const fcItem = output.find((o) => o.type === "function_call");

    expect(msgItem).toBeDefined();
    expect(msgItem!.content![0].text).toBe("Sure.");
    expect(fcItem).toBeDefined();
  });
});

function parseAnthropicSSEEvents(body: string): Array<{ type: string; [key: string]: unknown }> {
  return body
    .split("\n\n")
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
      if (!dataLine) return null;
      return JSON.parse(dataLine.slice(6)) as { type: string; [key: string]: unknown };
    })
    .filter(Boolean) as Array<{ type: string; [key: string]: unknown }>;
}

describe("Anthropic Messages — content + toolCalls", () => {
  let mock: LLMock | null = null;

  afterEach(async () => {
    if (mock) {
      await mock.stop();
      mock = null;
    }
  });

  it("streams text block then tool_use blocks with stop_reason tool_use", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "test anthropic combined" },
      response: {
        content: "Checking.",
        toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
      },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "test-key",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        messages: [{ role: "user", content: "test anthropic combined" }],
        stream: true,
      }),
    });

    const events = parseAnthropicSSEEvents(await res.text());

    const textBlockStart = events.find(
      (e) =>
        e.type === "content_block_start" && (e.content_block as { type: string })?.type === "text",
    );
    const toolBlockStart = events.find(
      (e) =>
        e.type === "content_block_start" &&
        (e.content_block as { type: string })?.type === "tool_use",
    );
    const messageDelta = events.find((e) => e.type === "message_delta");

    expect(textBlockStart).toBeDefined();
    expect(toolBlockStart).toBeDefined();
    expect((messageDelta!.delta as { stop_reason: string }).stop_reason).toBe("tool_use");

    const textIdx = events.indexOf(textBlockStart!);
    const toolIdx = events.indexOf(toolBlockStart!);
    expect(textIdx).toBeLessThan(toolIdx);
  });

  it("non-streaming returns text and tool_use content blocks", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "test anthropic combined ns" },
      response: {
        content: "Checking.",
        toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
      },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "test-key",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        messages: [{ role: "user", content: "test anthropic combined ns" }],
        stream: false,
      }),
    });

    const body = await res.json();
    expect(body.content).toHaveLength(2);
    expect(body.content[0].type).toBe("text");
    expect(body.content[0].text).toBe("Checking.");
    expect(body.content[1].type).toBe("tool_use");
    expect(body.content[1].name).toBe("get_weather");
    expect(body.stop_reason).toBe("tool_use");
  });
});

describe("Gemini — content + toolCalls", () => {
  let mock: LLMock | null = null;

  afterEach(async () => {
    if (mock) {
      await mock.stop();
      mock = null;
    }
  });

  it("streams text chunks then functionCall chunk with FUNCTION_CALL finishReason", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "test gemini combined" },
      response: {
        content: "Sure.",
        toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
      },
    });
    await mock.start();

    const res = await fetch(
      `${mock.url}/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "test gemini combined" }] }],
        }),
      },
    );

    const text = await res.text();
    const chunks = text
      .split("\n\n")
      .filter((block) => block.trim().length > 0)
      .map((block) => {
        const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
        return dataLine ? JSON.parse(dataLine.slice(6)) : null;
      })
      .filter(Boolean) as Array<{
      candidates: Array<{
        content: { parts: Array<{ text?: string; functionCall?: unknown }> };
        finishReason?: string;
      }>;
    }>;

    const textChunks = chunks.filter((c) =>
      c.candidates[0].content.parts.some((p) => p.text !== undefined),
    );
    const fcChunks = chunks.filter((c) =>
      c.candidates[0].content.parts.some((p) => p.functionCall !== undefined),
    );

    expect(textChunks.length).toBeGreaterThan(0);
    expect(fcChunks.length).toBeGreaterThan(0);

    const lastChunk = chunks[chunks.length - 1];
    expect(lastChunk.candidates[0].finishReason).toBe("FUNCTION_CALL");

    const lastTextIdx = chunks.lastIndexOf(textChunks.at(-1)!);
    const firstFcIdx = chunks.indexOf(fcChunks[0]);
    expect(lastTextIdx).toBeLessThan(firstFcIdx);
  });

  it("non-streaming returns both text and functionCall parts", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "test gemini combined ns" },
      response: {
        content: "Sure.",
        toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
      },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1beta/models/gemini-2.0-flash:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "test gemini combined ns" }] }],
      }),
    });

    const body = await res.json();
    const parts = body.candidates[0].content.parts;
    const textParts = parts.filter((p: { text?: string }) => p.text !== undefined);
    const fcParts = parts.filter((p: { functionCall?: unknown }) => p.functionCall !== undefined);

    expect(textParts.length).toBeGreaterThan(0);
    expect(textParts[0].text).toBe("Sure.");
    expect(fcParts.length).toBeGreaterThan(0);
    expect(fcParts[0].functionCall.name).toBe("get_weather");
    expect(body.candidates[0].finishReason).toBe("FUNCTION_CALL");
  });
});

describe("Gemini — multi-tool-call CWTC", () => {
  let mock: LLMock | null = null;

  afterEach(async () => {
    if (mock) {
      await mock.stop();
      mock = null;
    }
  });

  it("Gemini non-streaming multi-tool-call CWTC", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "test gemini multi-tc" },
      response: {
        content: "Sure, let me check.",
        toolCalls: [
          { name: "get_weather", arguments: '{"city":"NYC"}' },
          { name: "get_time", arguments: '{"tz":"EST"}' },
        ],
      },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1beta/models/gemini-2.0-flash:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "test gemini multi-tc" }] }],
      }),
    });

    const body = await res.json();
    const parts = body.candidates[0].content.parts;
    const fcParts = parts.filter((p: { functionCall?: unknown }) => p.functionCall !== undefined);
    expect(fcParts).toHaveLength(2);
    expect(fcParts[0].functionCall.name).toBe("get_weather");
    expect(fcParts[1].functionCall.name).toBe("get_time");
  });
});

describe("Anthropic — multi-tool-call CWTC streaming", () => {
  let mock: LLMock | null = null;

  afterEach(async () => {
    if (mock) {
      await mock.stop();
      mock = null;
    }
  });

  it("Claude streaming multi-tool-call CWTC", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "test claude multi-tc" },
      response: {
        content: "Checking.",
        toolCalls: [
          { name: "get_weather", arguments: '{"city":"NYC"}' },
          { name: "get_time", arguments: '{"tz":"EST"}' },
        ],
      },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "test-key",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        messages: [{ role: "user", content: "test claude multi-tc" }],
        stream: true,
      }),
    });

    const events = parseAnthropicSSEEvents(await res.text());
    const toolBlockStarts = events.filter(
      (e) =>
        e.type === "content_block_start" &&
        (e.content_block as { type: string })?.type === "tool_use",
    );
    expect(toolBlockStarts).toHaveLength(2);
  });
});

describe("OpenAI — multi-tool-call CWTC streaming indices", () => {
  let mock: LLMock | null = null;

  afterEach(async () => {
    if (mock) {
      await mock.stop();
      mock = null;
    }
  });

  it("streams content then multiple tool calls with correct indices", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "test multi-tc indices" },
      response: {
        content: "Here.",
        toolCalls: [
          { name: "fn_a", arguments: '{"a":1}' },
          { name: "fn_b", arguments: '{"b":2}' },
        ],
      },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "test multi-tc indices" }],
        stream: true,
      }),
    });

    const chunks = parseSSEChunks(await res.text());
    const toolChunks = chunks.filter((c) => c.choices?.[0]?.delta?.tool_calls);
    const indices = toolChunks.map((c) => c.choices[0].delta.tool_calls![0].index);
    // Should have both index 0 and index 1
    expect(indices).toContain(0);
    expect(indices).toContain(1);
  });
});

import {
  collapseOpenAISSE,
  collapseAnthropicSSE,
  collapseGeminiSSE,
  collapseOllamaNDJSON,
} from "../stream-collapse.js";

describe("stream-collapse — content + toolCalls coexistence", () => {
  it("OpenAI: preserves both content and toolCalls", () => {
    const body = [
      `data: ${JSON.stringify({ id: "c1", choices: [{ delta: { role: "assistant" } }] })}`,
      "",
      `data: ${JSON.stringify({ id: "c1", choices: [{ delta: { content: "Hello" } }] })}`,
      "",
      `data: ${JSON.stringify({
        id: "c1",
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_abc",
                  type: "function",
                  function: { name: "get_weather", arguments: '{"city":"NYC"}' },
                },
              ],
            },
          },
        ],
      })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n");

    const result = collapseOpenAISSE(body);
    expect(result.content).toBe("Hello");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].name).toBe("get_weather");
  });

  it("Anthropic: preserves both content and toolCalls", () => {
    const body = [
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: {} })}`,
      "",
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
      "",
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } })}`,
      "",
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
      "",
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_abc", name: "get_weather", input: {} } })}`,
      "",
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"city":"NYC"}' } })}`,
      "",
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 1 })}`,
      "",
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" } })}`,
      "",
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
      "",
    ].join("\n");

    const result = collapseAnthropicSSE(body);
    expect(result.content).toBe("Hello");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].name).toBe("get_weather");
  });

  it("Gemini: preserves both content and toolCalls", () => {
    const body = [
      `data: ${JSON.stringify({
        candidates: [{ content: { role: "model", parts: [{ text: "Hello" }] }, index: 0 }],
      })}`,
      "",
      `data: ${JSON.stringify({
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ functionCall: { name: "get_weather", args: { city: "NYC" } } }],
            },
            finishReason: "FUNCTION_CALL",
            index: 0,
          },
        ],
      })}`,
      "",
    ].join("\n");

    const result = collapseGeminiSSE(body);
    expect(result.content).toBe("Hello");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].name).toBe("get_weather");
  });

  it("Ollama: preserves both content and toolCalls", () => {
    const body = [
      JSON.stringify({
        model: "llama3",
        message: {
          role: "assistant",
          content: "Hello",
          tool_calls: [{ function: { name: "get_weather", arguments: { city: "NYC" } } }],
        },
        done: false,
      }),
      JSON.stringify({ model: "llama3", message: { role: "assistant", content: "" }, done: true }),
    ].join("\n");

    const result = collapseOllamaNDJSON(body);
    expect(result.content).toBe("Hello");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].name).toBe("get_weather");
  });
});
