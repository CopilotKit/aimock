import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { createServer, type ServerInstance } from "../server.js";
import type {
  Fixture,
  SSEChunk,
  TextResponse,
  ToolCallResponse,
  ContentWithToolCallsResponse,
} from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseSSEResponse(body: string): SSEChunk[] {
  return body
    .split("\n\n")
    .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
    .map((line) => JSON.parse(line.slice(6)));
}

function parseClaudeSSE(body: string): object[] {
  return body
    .split("\n\n")
    .filter((line) => line.includes("data: "))
    .map((line) => {
      const dataLine = line.split("\n").find((l) => l.startsWith("data: "));
      return JSON.parse(dataLine!.slice(6));
    });
}

function parseGeminiSSE(body: string): object[] {
  return body
    .split("\n\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
}

function parseResponsesSSE(body: string): object[] {
  return body
    .split("\n\n")
    .filter((line) => line.includes("data: "))
    .map((line) => {
      const dataLine = line.split("\n").find((l) => l.startsWith("data: "));
      return JSON.parse(dataLine!.slice(6));
    });
}

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
          resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let instance: ServerInstance | null = null;

afterEach(async () => {
  if (instance) {
    await new Promise<void>((resolve) => instance!.server.close(() => resolve()));
    instance = null;
  }
});

describe("response overrides: OpenAI Chat Completions (non-streaming)", () => {
  it("applies id override", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: { content: "Hi!", id: "chatcmpl-test123" },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    });
    const json = JSON.parse(res.body);
    expect(json.id).toBe("chatcmpl-test123");
  });

  it("applies created override", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: { content: "Hi!", created: 1700000000 },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    });
    const json = JSON.parse(res.body);
    expect(json.created).toBe(1700000000);
  });

  it("applies model override", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: { content: "Hi!", model: "gpt-4o-2024-08-06" },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    });
    const json = JSON.parse(res.body);
    expect(json.model).toBe("gpt-4o-2024-08-06");
  });

  it("applies usage override", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: {
          content: "Hi!",
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    });
    const json = JSON.parse(res.body);
    expect(json.usage.prompt_tokens).toBe(10);
    expect(json.usage.completion_tokens).toBe(5);
    expect(json.usage.total_tokens).toBe(15);
  });

  it("applies finishReason override", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: { content: "Hi!", finishReason: "length" },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    });
    const json = JSON.parse(res.body);
    expect(json.choices[0].finish_reason).toBe("length");
  });

  it("applies role override", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: { content: "Hi!", role: "system" },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    });
    const json = JSON.parse(res.body);
    expect(json.choices[0].message.role).toBe("system");
  });

  it("applies systemFingerprint override", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: { content: "Hi!", systemFingerprint: "fp_abc123" },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    });
    const json = JSON.parse(res.body);
    expect(json.system_fingerprint).toBe("fp_abc123");
  });

  it("partial usage merge — only prompt_tokens set", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: { content: "Hi!", usage: { prompt_tokens: 42 } },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    });
    const json = JSON.parse(res.body);
    expect(json.usage.prompt_tokens).toBe(42);
    expect(json.usage.completion_tokens).toBe(0);
    expect(json.usage.total_tokens).toBe(42);
  });

  it("default behavior unchanged when no overrides specified", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: { content: "Hi!" },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    });
    const json = JSON.parse(res.body);
    expect(json.id).toMatch(/^chatcmpl-/);
    expect(json.model).toBe("gpt-4");
    expect(json.choices[0].message.role).toBe("assistant");
    expect(json.choices[0].finish_reason).toBe("stop");
    // "hello" → 5 chars → ceil(5/4) = 2 estimated prompt tokens
    expect(json.usage.prompt_tokens).toBeGreaterThan(0);
    expect(json.system_fingerprint).toBeUndefined();
  });
});

describe("response overrides: OpenAI Chat Completions (streaming)", () => {
  it("overrides id/created/model on every chunk", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: {
          content: "Hi!",
          id: "chatcmpl-stream-test",
          created: 1700000000,
          model: "gpt-4o-override",
        },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    });
    const chunks = parseSSEResponse(res.body);
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.id).toBe("chatcmpl-stream-test");
      expect(chunk.created).toBe(1700000000);
      expect(chunk.model).toBe("gpt-4o-override");
    }
  });

  it("overrides finishReason on final chunk only", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: { content: "Hi!", finishReason: "length" },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    });
    const chunks = parseSSEResponse(res.body);
    const lastChunk = chunks[chunks.length - 1];
    expect(lastChunk.choices[0].finish_reason).toBe("length");
  });

  it("overrides role on role chunk", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: { content: "Hi!", role: "system" },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    });
    const chunks = parseSSEResponse(res.body);
    const roleChunk = chunks.find((c) => c.choices[0]?.delta?.role !== undefined);
    expect(roleChunk?.choices[0].delta.role).toBe("system");
  });

  it("adds systemFingerprint to every chunk", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: { content: "Hi!", systemFingerprint: "fp_stream" },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    });
    const chunks = parseSSEResponse(res.body);
    for (const chunk of chunks) {
      expect((chunk as Record<string, unknown>).system_fingerprint).toBe("fp_stream");
    }
  });
});

describe("response overrides: tool call", () => {
  it("applies role override on tool-call-only response", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "weather" },
        response: {
          toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
          role: "system",
        },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      stream: false,
      messages: [{ role: "user", content: "weather" }],
    });
    const json = JSON.parse(res.body);
    expect(json.choices[0].message.role).toBe("system");
  });

  it("applies finishReason on tool call response", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "weather" },
        response: {
          toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
          finishReason: "stop",
        },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      stream: false,
      messages: [{ role: "user", content: "weather" }],
    });
    const json = JSON.parse(res.body);
    expect(json.choices[0].finish_reason).toBe("stop");
  });
});

describe("response overrides: content+toolCalls", () => {
  it("applies all overrides on combined response", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "search" },
        response: {
          content: "Let me search",
          toolCalls: [{ name: "search", arguments: '{"q":"test"}' }],
          id: "chatcmpl-combo",
          model: "gpt-4o-combo",
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
          systemFingerprint: "fp_combo",
          role: "system",
          finishReason: "stop",
        },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      stream: false,
      messages: [{ role: "user", content: "search" }],
    });
    const json = JSON.parse(res.body);
    expect(json.id).toBe("chatcmpl-combo");
    expect(json.model).toBe("gpt-4o-combo");
    expect(json.usage.prompt_tokens).toBe(20);
    expect(json.system_fingerprint).toBe("fp_combo");
    expect(json.choices[0].message.role).toBe("system");
    expect(json.choices[0].finish_reason).toBe("stop");
  });
});

describe("response overrides: Claude format", () => {
  it("maps id to message id", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: { content: "Hi!", id: "msg_test123" },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1/messages`, {
      model: "claude-3-opus-20240229",
      max_tokens: 100,
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    });
    const json = JSON.parse(res.body);
    expect(json.id).toBe("msg_test123");
  });

  it("maps finishReason 'stop' to stop_reason 'end_turn'", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: { content: "Hi!", finishReason: "stop" },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1/messages`, {
      model: "claude-3-opus-20240229",
      max_tokens: 100,
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    });
    const json = JSON.parse(res.body);
    expect(json.stop_reason).toBe("end_turn");
  });

  it("maps usage input_tokens/output_tokens", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: {
          content: "Hi!",
          usage: { input_tokens: 15, output_tokens: 8 },
        },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1/messages`, {
      model: "claude-3-opus-20240229",
      max_tokens: 100,
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    });
    const json = JSON.parse(res.body);
    expect(json.usage.input_tokens).toBe(15);
    expect(json.usage.output_tokens).toBe(8);
  });

  it("maps overrides in streaming mode", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: {
          content: "Hi!",
          id: "msg_stream_test",
          model: "claude-override",
          finishReason: "tool_calls",
        },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1/messages`, {
      model: "claude-3-opus-20240229",
      max_tokens: 100,
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    });
    const events = parseClaudeSSE(res.body);
    const msgStart = events.find((e: Record<string, unknown>) => e.type === "message_start") as
      | Record<string, unknown>
      | undefined;
    const msg = msgStart?.message as Record<string, unknown>;
    expect(msg.id).toBe("msg_stream_test");
    expect(msg.model).toBe("claude-override");

    const msgDelta = events.find((e: Record<string, unknown>) => e.type === "message_delta") as
      | Record<string, unknown>
      | undefined;
    const delta = msgDelta?.delta as Record<string, unknown>;
    expect(delta.stop_reason).toBe("tool_use");
  });
});

describe("response overrides: Gemini format", () => {
  it("maps finishReason 'stop' to 'STOP'", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: { content: "Hi!", finishReason: "stop" },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1beta/models/gemini-pro:generateContent`, {
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
    });
    const json = JSON.parse(res.body);
    expect(json.candidates[0].finishReason).toBe("STOP");
  });

  it("maps usage to usageMetadata", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: {
          content: "Hi!",
          usage: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
        },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1beta/models/gemini-pro:generateContent`, {
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
    });
    const json = JSON.parse(res.body);
    expect(json.usageMetadata.promptTokenCount).toBe(10);
    expect(json.usageMetadata.candidatesTokenCount).toBe(5);
    expect(json.usageMetadata.totalTokenCount).toBe(15);
  });

  it("id/model/created are ignored in Gemini format", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: {
          content: "Hi!",
          id: "should-be-ignored",
          model: "should-be-ignored",
          created: 1700000000,
        },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1beta/models/gemini-pro:generateContent`, {
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
    });
    const json = JSON.parse(res.body);
    // Gemini format does not have id, model, or created at top level
    expect(json.id).toBeUndefined();
    expect(json.model).toBeUndefined();
    expect(json.created).toBeUndefined();
  });

  it("auto-computes totalTokenCount in streaming mode when omitted", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: {
          content: "Hi!",
          usage: { promptTokenCount: 10, candidatesTokenCount: 20 },
        },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(
      `${instance.url}/v1beta/models/gemini-pro:streamGenerateContent?alt=sse`,
      {
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
      },
    );
    const chunks = parseGeminiSSE(res.body) as Array<Record<string, unknown>>;
    // Find the last chunk that has usageMetadata
    const chunksWithUsage = chunks.filter((c) => c.usageMetadata !== undefined);
    expect(chunksWithUsage.length).toBeGreaterThan(0);
    const lastWithUsage = chunksWithUsage[chunksWithUsage.length - 1];
    const usage = lastWithUsage.usageMetadata as Record<string, number>;
    expect(usage.totalTokenCount).toBe(30);
  });

  it("maps finishReason in streaming mode", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: { content: "Hi!", finishReason: "tool_calls" },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(
      `${instance.url}/v1beta/models/gemini-pro:streamGenerateContent?alt=sse`,
      {
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
      },
    );
    const chunks = parseGeminiSSE(res.body) as Array<Record<string, unknown>>;
    const lastChunk = chunks[chunks.length - 1];
    const candidates = lastChunk.candidates as Array<Record<string, unknown>>;
    expect(candidates[0].finishReason).toBe("FUNCTION_CALL");
  });
});

describe("response overrides: Responses API", () => {
  it("applies id/created_at/model in envelope", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: {
          content: "Hi!",
          id: "resp_test123",
          created: 1700000000,
          model: "gpt-4o-responses",
        },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      stream: false,
      input: [{ role: "user", content: "hello" }],
    });
    const json = JSON.parse(res.body);
    expect(json.id).toBe("resp_test123");
    expect(json.created_at).toBe(1700000000);
    expect(json.model).toBe("gpt-4o-responses");
  });

  it("maps finishReason 'stop' to status 'completed'", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: { content: "Hi!", finishReason: "stop" },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      stream: false,
      input: [{ role: "user", content: "hello" }],
    });
    const json = JSON.parse(res.body);
    expect(json.status).toBe("completed");
  });

  it("maps finishReason 'length' to status 'incomplete'", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: { content: "Hi!", finishReason: "length" },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      stream: false,
      input: [{ role: "user", content: "hello" }],
    });
    const json = JSON.parse(res.body);
    expect(json.status).toBe("incomplete");
  });

  it("maps usage in Responses API format", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: {
          content: "Hi!",
          usage: { input_tokens: 12, output_tokens: 6, total_tokens: 18 },
        },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      stream: false,
      input: [{ role: "user", content: "hello" }],
    });
    const json = JSON.parse(res.body);
    expect(json.usage.input_tokens).toBe(12);
    expect(json.usage.output_tokens).toBe(6);
    expect(json.usage.total_tokens).toBe(18);
  });

  it("applies overrides in streaming mode", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: {
          content: "Hi!",
          id: "resp_stream",
          created: 1700000000,
          model: "gpt-4o-stream-resp",
          finishReason: "length",
          usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
        },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      stream: true,
      input: [{ role: "user", content: "hello" }],
    });
    const events = parseResponsesSSE(res.body) as Array<Record<string, unknown>>;

    const created = events.find((e) => e.type === "response.created") as Record<string, unknown>;
    const createdResp = created.response as Record<string, unknown>;
    expect(createdResp.id).toBe("resp_stream");
    expect(createdResp.created_at).toBe(1700000000);
    expect(createdResp.model).toBe("gpt-4o-stream-resp");

    const completed = events.find((e) => e.type === "response.completed") as Record<
      string,
      unknown
    >;
    const completedResp = completed.response as Record<string, unknown>;
    expect(completedResp.status).toBe("incomplete");
    const usage = completedResp.usage as Record<string, unknown>;
    expect(usage.input_tokens).toBe(5);
    expect(usage.output_tokens).toBe(3);
    expect(usage.total_tokens).toBe(8);
  });
});

describe("response overrides: cross-provider tool call coverage", () => {
  it("Gemini tool call finishReason maps to FUNCTION_CALL", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "weather" },
        response: {
          toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
          finishReason: "tool_calls",
        },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1beta/models/gemini-2.0-flash:generateContent`, {
      contents: [{ role: "user", parts: [{ text: "weather" }] }],
    });
    const json = JSON.parse(res.body);
    expect(json.candidates[0].finishReason).toBe("FUNCTION_CALL");
  });

  it("Claude tool call finishReason maps to tool_use", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "weather" },
        response: {
          toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
          finishReason: "tool_calls",
        },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1/messages`, {
      model: "claude-3-opus-20240229",
      max_tokens: 100,
      stream: false,
      messages: [{ role: "user", content: "weather" }],
    });
    const json = JSON.parse(res.body);
    expect(json.stop_reason).toBe("tool_use");
  });

  it("Responses API tool call with id and finishReason overrides", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "weather" },
        response: {
          toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
          id: "resp_custom_tc",
          finishReason: "stop",
        },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1/responses`, {
      model: "gpt-4o",
      input: [{ role: "user", content: "weather" }],
    });
    const json = JSON.parse(res.body);
    expect(json.id).toBe("resp_custom_tc");
    expect(json.status).toBe("completed");
  });
});

describe("response overrides: finishReason cross-provider mappings", () => {
  it("finishReason length maps to max_tokens on Claude", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: { content: "Hi!", finishReason: "length" },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1/messages`, {
      model: "claude-3-opus-20240229",
      max_tokens: 100,
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    });
    const json = JSON.parse(res.body);
    expect(json.stop_reason).toBe("max_tokens");
  });

  it("finishReason length maps to MAX_TOKENS on Gemini", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: { content: "Hi!", finishReason: "length" },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1beta/models/gemini-pro:generateContent`, {
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
    });
    const json = JSON.parse(res.body);
    expect(json.candidates[0].finishReason).toBe("MAX_TOKENS");
  });

  it("content_filter passthrough on OpenAI", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: { content: "Hi!", finishReason: "content_filter" },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    });
    const json = JSON.parse(res.body);
    expect(json.choices[0].finish_reason).toBe("content_filter");
  });

  it("unknown finishReason passthrough", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: { content: "Hi!", finishReason: "custom_reason" },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    });
    const json = JSON.parse(res.body);
    expect(json.choices[0].finish_reason).toBe("custom_reason");
  });

  it("content_filter maps to SAFETY on Gemini", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: { content: "Hi!", finishReason: "content_filter" },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1beta/models/gemini-pro:generateContent`, {
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
    });
    const json = JSON.parse(res.body);
    expect(json.candidates[0].finishReason).toBe("SAFETY");
  });

  it("content_filter maps to failed on Responses API", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: { content: "Hi!", finishReason: "content_filter" },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      stream: false,
      input: [{ role: "user", content: "hello" }],
    });
    const json = JSON.parse(res.body);
    expect(json.status).toBe("failed");
  });

  it("content_filter passthrough on Claude", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: { content: "Hi!", finishReason: "content_filter" },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1/messages`, {
      model: "claude-3-opus-20240229",
      max_tokens: 100,
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    });
    const json = JSON.parse(res.body);
    expect(json.stop_reason).toBe("content_filter");
  });
});

describe("response overrides: total_tokens auto-sum", () => {
  it("total_tokens auto-sum with both prompt and completion tokens", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: {
          content: "Hi!",
          usage: { prompt_tokens: 10, completion_tokens: 20 },
        },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    });
    const json = JSON.parse(res.body);
    expect(json.usage.prompt_tokens).toBe(10);
    expect(json.usage.completion_tokens).toBe(20);
    // total_tokens is auto-computed from prompt_tokens + completion_tokens when omitted
    expect(json.usage.total_tokens).toBe(30);
  });

  it("Responses API total_tokens auto-sum", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: {
          content: "Hi!",
          usage: { input_tokens: 10, output_tokens: 20 },
        },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      stream: false,
      input: [{ role: "user", content: "hello" }],
    });
    const json = JSON.parse(res.body);
    expect(json.usage.input_tokens).toBe(10);
    expect(json.usage.output_tokens).toBe(20);
    expect(json.usage.total_tokens).toBe(30);
  });

  it("Gemini totalTokenCount auto-sum", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: {
          content: "Hi!",
          usage: { promptTokenCount: 10, candidatesTokenCount: 20 },
        },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1beta/models/gemini-pro:generateContent`, {
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
    });
    const json = JSON.parse(res.body);
    expect(json.usageMetadata.promptTokenCount).toBe(10);
    expect(json.usageMetadata.candidatesTokenCount).toBe(20);
    expect(json.usageMetadata.totalTokenCount).toBe(30);
  });
});

describe("response overrides: partial usage merge for non-OpenAI", () => {
  it("partial usage merge for Claude", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: {
          content: "Hi!",
          usage: { input_tokens: 42 },
        },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1/messages`, {
      model: "claude-3-opus-20240229",
      max_tokens: 100,
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    });
    const json = JSON.parse(res.body);
    expect(json.usage.input_tokens).toBe(42);
    expect(json.usage.output_tokens).toBe(0);
  });

  it("partial usage merge for Gemini", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: {
          content: "Hi!",
          usage: { promptTokenCount: 42 },
        },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1beta/models/gemini-pro:generateContent`, {
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
    });
    const json = JSON.parse(res.body);
    expect(json.usageMetadata.promptTokenCount).toBe(42);
    expect(json.usageMetadata.candidatesTokenCount).toBe(0);
    expect(json.usageMetadata.totalTokenCount).toBe(42);
  });

  it("partial usage merge for Responses API", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: {
          content: "Hi!",
          usage: { input_tokens: 42 },
        },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      stream: false,
      input: [{ role: "user", content: "hello" }],
    });
    const json = JSON.parse(res.body);
    expect(json.usage.input_tokens).toBe(42);
    expect(json.usage.output_tokens).toBe(0);
    expect(json.usage.total_tokens).toBe(42);
  });
});

describe("response overrides: streaming CWTC overrides", () => {
  it("streaming Claude CWTC overrides", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "search" },
        response: {
          content: "Let me search",
          toolCalls: [{ name: "search", arguments: '{"q":"test"}' }],
          id: "msg_cwtc_test",
          model: "claude-override",
        },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1/messages`, {
      model: "claude-3-opus-20240229",
      max_tokens: 100,
      stream: true,
      messages: [{ role: "user", content: "search" }],
    });
    const events = parseClaudeSSE(res.body);
    const msgStart = events.find((e: Record<string, unknown>) => e.type === "message_start") as
      | Record<string, unknown>
      | undefined;
    const msg = msgStart?.message as Record<string, unknown>;
    expect(msg.id).toBe("msg_cwtc_test");
    expect(msg.model).toBe("claude-override");
  });

  it("streaming Gemini CWTC finishReason", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "search" },
        response: {
          content: "Let me search",
          toolCalls: [{ name: "search", arguments: '{"q":"test"}' }],
          finishReason: "tool_calls",
        },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(
      `${instance.url}/v1beta/models/gemini-pro:streamGenerateContent?alt=sse`,
      {
        contents: [{ role: "user", parts: [{ text: "search" }] }],
      },
    );
    const chunks = parseGeminiSSE(res.body) as Array<Record<string, unknown>>;
    const lastChunk = chunks[chunks.length - 1];
    const candidates = lastChunk.candidates as Array<Record<string, unknown>>;
    expect(candidates[0].finishReason).toBe("FUNCTION_CALL");
  });

  it("streaming Responses API CWTC overrides", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "search" },
        response: {
          content: "Let me search",
          toolCalls: [{ name: "search", arguments: '{"q":"test"}' }],
          id: "resp_cwtc_test",
          model: "gpt-4o-cwtc",
        },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      stream: true,
      input: [{ role: "user", content: "search" }],
    });
    const events = parseResponsesSSE(res.body) as Array<Record<string, unknown>>;
    const completed = events.find((e) => e.type === "response.completed") as Record<
      string,
      unknown
    >;
    const completedResp = completed.response as Record<string, unknown>;
    expect(completedResp.id).toBe("resp_cwtc_test");
    expect(completedResp.model).toBe("gpt-4o-cwtc");
  });

  it("finishReason length in Claude streaming", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: { content: "Hi!", finishReason: "length" },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1/messages`, {
      model: "claude-3-opus-20240229",
      max_tokens: 100,
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    });
    const events = parseClaudeSSE(res.body);
    const msgDelta = events.find((e: Record<string, unknown>) => e.type === "message_delta") as
      | Record<string, unknown>
      | undefined;
    const delta = msgDelta?.delta as Record<string, unknown>;
    expect(delta.stop_reason).toBe("max_tokens");
  });
});

describe("response overrides: reasoning in CWTC", () => {
  it("reasoning in CWTC streaming OpenAI", async () => {
    // OpenAI CWTC streaming does not currently include reasoning_content chunks;
    // reasoning is only supported for text-only streaming in OpenAI format.
    // Verify that the content and tool call chunks still appear correctly.
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "think" },
        response: {
          content: "The answer is 42",
          toolCalls: [{ name: "calc", arguments: '{"x":42}' }],
          reasoning: "Let me think about this...",
        },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      stream: true,
      messages: [{ role: "user", content: "think" }],
    });
    const chunks = parseSSEResponse(res.body);
    const contentChunks = chunks.filter((c) => c.choices?.[0]?.delta?.content);
    const toolChunks = chunks.filter((c) => c.choices?.[0]?.delta?.tool_calls);
    expect(contentChunks.length).toBeGreaterThan(0);
    expect(toolChunks.length).toBeGreaterThan(0);
  });

  it("reasoning in CWTC for Claude non-streaming", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "think" },
        response: {
          content: "The answer is 42",
          toolCalls: [{ name: "calc", arguments: '{"x":42}' }],
          reasoning: "Let me think about this...",
        },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1/messages`, {
      model: "claude-3-opus-20240229",
      max_tokens: 100,
      stream: false,
      messages: [{ role: "user", content: "think" }],
    });
    const json = JSON.parse(res.body);
    const thinkingBlock = json.content.find((b: Record<string, unknown>) => b.type === "thinking");
    expect(thinkingBlock).toBeDefined();
    expect(thinkingBlock.thinking).toBe("Let me think about this...");
  });

  it("reasoning in CWTC for Gemini non-streaming", async () => {
    // Gemini CWTC does not currently include thought parts for reasoning;
    // reasoning is only supported for text-only responses in Gemini format.
    // Verify that the text and functionCall parts still appear correctly.
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "think" },
        response: {
          content: "The answer is 42",
          toolCalls: [{ name: "calc", arguments: '{"x":42}' }],
          reasoning: "Let me think about this...",
        },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1beta/models/gemini-pro:generateContent`, {
      contents: [{ role: "user", parts: [{ text: "think" }] }],
    });
    const json = JSON.parse(res.body);
    const parts = json.candidates[0].content.parts;
    const textPart = parts.find((p: Record<string, unknown>) => p.text !== undefined && !p.thought);
    const fcPart = parts.find((p: Record<string, unknown>) => p.functionCall !== undefined);
    expect(textPart).toBeDefined();
    expect(textPart.text).toBe("The answer is 42");
    expect(fcPart).toBeDefined();
  });
});

describe("response overrides: webSearches in CWTC", () => {
  it("webSearches in CWTC for Responses API", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "search" },
        response: {
          content: "Here are results",
          toolCalls: [{ name: "lookup", arguments: '{"q":"test"}' }],
          webSearches: ["search query 1"],
        },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      stream: false,
      input: [{ role: "user", content: "search" }],
    });
    const json = JSON.parse(res.body);
    const output = json.output as Array<Record<string, unknown>>;
    const webSearchItems = output.filter((o) => o.type === "web_search_call");
    expect(webSearchItems.length).toBeGreaterThan(0);
  });
});

describe("response overrides: streaming tool calls with overrides", () => {
  it("streaming tool call chunks with overrides per-chunk", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "weather" },
        response: {
          toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
          id: "chatcmpl-tc-override",
          model: "gpt-4o-tc-override",
        },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      stream: true,
      messages: [{ role: "user", content: "weather" }],
    });
    const chunks = parseSSEResponse(res.body);
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.id).toBe("chatcmpl-tc-override");
      expect(chunk.model).toBe("gpt-4o-tc-override");
    }
  });

  it("streaming content+toolCalls with overrides", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "combo" },
        response: {
          content: "Let me check",
          toolCalls: [{ name: "search", arguments: '{"q":"test"}' }],
          id: "chatcmpl-combo-stream",
          model: "gpt-4o-combo-stream",
        },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      stream: true,
      messages: [{ role: "user", content: "combo" }],
    });
    const chunks = parseSSEResponse(res.body);
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.id).toBe("chatcmpl-combo-stream");
      expect(chunk.model).toBe("gpt-4o-combo-stream");
    }
  });
});

describe("response overrides: extractOverrides unit tests", () => {
  it("extractOverrides with empty usage", async () => {
    const { extractOverrides } = await import("../helpers.js");
    const result = extractOverrides({ content: "hi", usage: {} } as TextResponse);
    expect(result.usage).toEqual({});
  });

  it("extractOverrides from ToolCallResponse", async () => {
    const { extractOverrides } = await import("../helpers.js");
    const result = extractOverrides({
      toolCalls: [{ name: "fn", arguments: "{}" }],
      id: "tc-1",
      finishReason: "tool_calls",
    } as ToolCallResponse);
    expect(result.id).toBe("tc-1");
    expect(result.finishReason).toBe("tool_calls");
  });

  it("extractOverrides from ContentWithToolCallsResponse", async () => {
    const { extractOverrides } = await import("../helpers.js");
    const result = extractOverrides({
      content: "Hello",
      toolCalls: [{ name: "fn", arguments: "{}" }],
      id: "cwtc-1",
      model: "gpt-4",
      created: 1700000000,
      finishReason: "tool_calls",
      role: "assistant",
      systemFingerprint: "fp_test",
      usage: { prompt_tokens: 10 },
    } as ContentWithToolCallsResponse);
    expect(result.id).toBe("cwtc-1");
    expect(result.model).toBe("gpt-4");
    expect(result.created).toBe(1700000000);
    expect(result.finishReason).toBe("tool_calls");
    expect(result.role).toBe("assistant");
    expect(result.systemFingerprint).toBe("fp_test");
    expect(result.usage).toEqual({ prompt_tokens: 10 });
  });
});

describe("response overrides: fixture file round-trip", () => {
  it("preserves override fields from fixture file format", async () => {
    // This tests that override fields on FixtureResponse are preserved through
    // entryToFixture (fixture-loader) since it copies response as-is
    const { entryToFixture } = await import("../fixture-loader.js");
    const fixture = entryToFixture({
      match: { userMessage: "hello" },
      response: {
        content: "Hi!",
        id: "chatcmpl-file",
        created: 1700000000,
        model: "gpt-4o-file",
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        finishReason: "stop",
        systemFingerprint: "fp_file",
      },
    });

    const response = fixture.response as Record<string, unknown>;
    expect(response.id).toBe("chatcmpl-file");
    expect(response.created).toBe(1700000000);
    expect(response.model).toBe("gpt-4o-file");
    expect(response.finishReason).toBe("stop");
    expect(response.systemFingerprint).toBe("fp_file");
    const usage = response.usage as Record<string, unknown>;
    expect(usage.prompt_tokens).toBe(10);
  });
});
