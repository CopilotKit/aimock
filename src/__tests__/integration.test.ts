import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { resolve } from "node:path";
import { createServer, type ServerInstance } from "../server.js";
import { loadFixturesFromDir } from "../fixture-loader.js";
import { LLMock } from "../llmock.js";
import type { Fixture, SSEChunk, ChatCompletionRequest, JournalEntry } from "../types.js";
import { isChatCompletionBody } from "../journal.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The chat request a journal entry recorded.
 *
 * `JournalEntry.body` is a union — not every service journals a chat request —
 * so reading `messages` off one needs a narrowing step. Throwing here names the
 * problem ("this entry is not a chat request") at the point it exists, instead
 * of letting a non-chat entry surface as an undefined property inside an
 * expectation.
 */
function chatBodyOf(entry: JournalEntry | null | undefined): ChatCompletionRequest {
  const body = entry?.body;
  if (!isChatCompletionBody(body)) {
    throw new Error(`journal entry has no chat-completion body: ${JSON.stringify(body)}`);
  }
  return body;
}

function parseSSEResponse(body: string): SSEChunk[] {
  return body
    .split("\n\n")
    .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
    .map((line) => JSON.parse(line.slice(6)));
}

async function httpPost(url: string, body: object): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
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

function chatRequest(
  userContent: string,
  extra: Partial<ChatCompletionRequest> = {},
): ChatCompletionRequest {
  return {
    model: "gpt-4",
    stream: true,
    messages: [{ role: "user", content: userContent }],
    ...extra,
  };
}

function reassembleTextContent(chunks: SSEChunk[]): string {
  return chunks.map((c) => c.choices?.[0]?.delta?.content ?? "").join("");
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

describe("integration: text response flow", () => {
  it("streams a complete text response via SSE", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: { content: "Hello! How can I help?" },
      },
    ];

    instance = await createServer(fixtures, {
      port: 0,
      chunkSize: 10,
    });

    const res = await httpPost(`${instance.url}/v1/chat/completions`, chatRequest("hello"));

    expect(res.status).toBe(200);

    const chunks = parseSSEResponse(res.body);
    expect(chunks.length).toBeGreaterThan(0);

    // First chunk should have the role
    expect(chunks[0].choices[0].delta.role).toBe("assistant");

    // Reassemble content from all chunks
    const content = reassembleTextContent(chunks);
    expect(content).toBe("Hello! How can I help?");

    // Last chunk should have finish_reason "stop"
    const last = chunks[chunks.length - 1];
    expect(last.choices[0].finish_reason).toBe("stop");

    // All chunks share the same id
    const ids = new Set(chunks.map((c) => c.id));
    expect(ids.size).toBe(1);

    // Raw response ends with [DONE]
    expect(res.body).toContain("data: [DONE]");
  });
});

describe("integration: tool call flow", () => {
  it("streams tool call chunks via SSE", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "weather" },
        response: {
          toolCalls: [
            {
              name: "get_weather",
              arguments: '{"location":"SF"}',
            },
          ],
        },
      },
    ];

    instance = await createServer(fixtures, {
      port: 0,
      chunkSize: 50,
    });

    const res = await httpPost(
      `${instance.url}/v1/chat/completions`,
      chatRequest("what is the weather?", {
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              parameters: {},
            },
          },
        ],
      }),
    );

    expect(res.status).toBe(200);

    const chunks = parseSSEResponse(res.body);
    expect(chunks.length).toBeGreaterThan(0);

    // Role chunk should have content: null
    expect(chunks[0].choices[0].delta.role).toBe("assistant");
    expect(chunks[0].choices[0].delta.content).toBeNull();

    // Find the initial tool call chunk
    const tcChunk = chunks.find((c) => c.choices[0].delta.tool_calls?.[0]?.type === "function");
    expect(tcChunk).toBeDefined();
    expect(tcChunk!.choices[0].delta.tool_calls![0].function?.name).toBe("get_weather");
    expect(tcChunk!.choices[0].delta.tool_calls![0].id).toMatch(/^call_/);

    // Reassemble tool call arguments
    const argChunks = chunks.filter(
      (c) => c.choices[0].delta.tool_calls?.[0]?.function?.arguments !== undefined,
    );
    const args = argChunks
      .map((c) => c.choices[0].delta.tool_calls![0].function!.arguments)
      .join("");
    expect(args).toBe('{"location":"SF"}');

    // Last chunk finish reason
    const last = chunks[chunks.length - 1];
    expect(last.choices[0].finish_reason).toBe("tool_calls");
  });
});

describe("integration: multi-turn flow", () => {
  it("handles initial request and tool result follow-up", async () => {
    // toolCallId fixtures only fire when the request's last message is a tool
    // result, so fixture order between toolCallId and userMessage does not
    // matter here — turn 1 (last = user) hits userMessage; turn 2 (last = tool)
    // hits toolCallId.
    const fixtures: Fixture[] = [
      {
        match: { toolCallId: "call_bg_001" },
        response: {
          content: "Background changed to blue!",
        },
      },
      {
        match: { userMessage: "change background" },
        response: {
          toolCalls: [
            {
              name: "set_bg",
              arguments: '{"color":"blue"}',
              id: "call_bg_001",
            },
          ],
        },
      },
    ];

    instance = await createServer(fixtures, {
      port: 0,
      chunkSize: 100,
    });

    // Turn 1: user request -> tool call response
    const res1 = await httpPost(
      `${instance.url}/v1/chat/completions`,
      chatRequest("change background", {
        tools: [
          {
            type: "function",
            function: {
              name: "set_bg",
              parameters: {},
            },
          },
        ],
      }),
    );

    expect(res1.status).toBe(200);
    const chunks1 = parseSSEResponse(res1.body);
    const tcChunk = chunks1.find((c) => c.choices[0].delta.tool_calls?.[0]?.id === "call_bg_001");
    expect(tcChunk).toBeDefined();

    // Turn 2: send tool result -> text response
    const res2 = await httpPost(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      stream: true,
      messages: [
        {
          role: "user",
          content: "change background",
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_bg_001",
              type: "function",
              function: {
                name: "set_bg",
                arguments: '{"color":"blue"}',
              },
            },
          ],
        },
        {
          role: "tool",
          content: '{"success":true}',
          tool_call_id: "call_bg_001",
        },
      ],
    });

    expect(res2.status).toBe(200);
    const chunks2 = parseSSEResponse(res2.body);
    const content = reassembleTextContent(chunks2);
    expect(content).toBe("Background changed to blue!");
  });
});

describe("integration: error fixture flow", () => {
  it("returns correct HTTP status and error body", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "trigger-error" },
        response: {
          error: {
            message: "Rate limit exceeded",
            type: "rate_limit_error",
            code: "rate_limit",
          },
          status: 429,
        },
      },
    ];

    instance = await createServer(fixtures, {
      port: 0,
    });

    const res = await httpPost(`${instance.url}/v1/chat/completions`, chatRequest("trigger-error"));

    expect(res.status).toBe(429);

    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("Rate limit exceeded");
    expect(body.error.type).toBe("rate_limit_error");
    expect(body.error.code).toBe("rate_limit");
  });
});

describe("integration: no match flow", () => {
  it("returns 404 when no fixture matches", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "specific-only" },
        response: { content: "matched" },
      },
    ];

    instance = await createServer(fixtures, {
      port: 0,
    });

    const res = await httpPost(
      `${instance.url}/v1/chat/completions`,
      chatRequest("something completely different"),
    );

    expect(res.status).toBe(404);

    const body = JSON.parse(res.body);
    expect(body.error).toBeDefined();
    expect(body.error.message).toMatch(/no.*fixture/i);
  });
});

describe("integration: journal verification", () => {
  it("records all requests in the journal", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "first" },
        response: { content: "response-1" },
      },
      {
        match: { userMessage: "second" },
        response: { content: "response-2" },
      },
    ];

    instance = await createServer(fixtures, {
      port: 0,
      chunkSize: 100,
    });

    // Make two requests
    await httpPost(`${instance.url}/v1/chat/completions`, chatRequest("first message"));
    await httpPost(`${instance.url}/v1/chat/completions`, chatRequest("second message"));

    // Verify journal
    const entries = instance.journal.getAll();
    expect(entries.length).toBe(2);

    // First entry
    expect(entries[0].method).toBe("POST");
    expect(entries[0].path).toBe("/v1/chat/completions");
    expect(chatBodyOf(entries[0]).messages[0].content).toBe("first message");
    expect(entries[0].response.status).toBe(200);
    expect(entries[0].response.fixture).not.toBeNull();
    expect(entries[0].id).toBeTruthy();
    expect(entries[0].timestamp).toBeGreaterThan(0);

    // Second entry
    expect(chatBodyOf(entries[1]).messages[0].content).toBe("second message");
    expect(entries[1].response.status).toBe(200);

    // Journal also records unmatched requests
    await httpPost(`${instance.url}/v1/chat/completions`, chatRequest("no match here"));

    const all = instance.journal.getAll();
    expect(all.length).toBe(3);
    expect(all[2].response.status).toBe(404);
    expect(all[2].response.fixture).toBeNull();
  });
});

describe("integration: fixture file loading", () => {
  it("loads fixtures from the fixtures/ directory", async () => {
    const fixturesDir = resolve(import.meta.dirname, "../../fixtures");
    const fixtures = loadFixturesFromDir(fixturesDir);

    // We know the example files contain fixtures
    expect(fixtures.length).toBeGreaterThan(0);

    instance = await createServer(fixtures, {
      port: 0,
      chunkSize: 100,
    });

    // Test the greeting fixture from example-greeting.json
    const res = await httpPost(`${instance.url}/v1/chat/completions`, chatRequest("hello there"));

    expect(res.status).toBe(200);

    const chunks = parseSSEResponse(res.body);
    const content = reassembleTextContent(chunks);
    expect(content).toBe("Hello! How can I help you today?");
  });

  it("loads tool call fixtures from files", async () => {
    const fixturesDir = resolve(import.meta.dirname, "../../fixtures");
    const fixtures = loadFixturesFromDir(fixturesDir);

    instance = await createServer(fixtures, {
      port: 0,
      chunkSize: 100,
    });

    // Test the tool call fixture from example-tool-call.json
    // It matches on toolName: "get_weather"
    const res = await httpPost(
      `${instance.url}/v1/chat/completions`,
      chatRequest("get the weather", {
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              parameters: {},
            },
          },
        ],
      }),
    );

    expect(res.status).toBe(200);

    const chunks = parseSSEResponse(res.body);

    // Find tool call chunk
    const tcChunk = chunks.find(
      (c) => c.choices[0].delta.tool_calls?.[0]?.function?.name === "get_weather",
    );
    expect(tcChunk).toBeDefined();

    // Reassemble arguments
    const argChunks = chunks.filter(
      (c) => c.choices[0].delta.tool_calls?.[0]?.function?.arguments !== undefined,
    );
    const args = argChunks
      .map((c) => c.choices[0].delta.tool_calls![0].function!.arguments)
      .join("");

    const parsed = JSON.parse(args);
    expect(parsed.location).toBe("San Francisco");
    expect(parsed.unit).toBe("fahrenheit");
  });
});

describe("integration: server options", () => {
  it("accepts custom host and port", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "ping" },
        response: { content: "pong" },
      },
    ];

    instance = await createServer(fixtures, {
      port: 0,
      host: "127.0.0.1",
    });

    expect(instance.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const res = await httpPost(`${instance.url}/v1/chat/completions`, chatRequest("ping"));

    expect(res.status).toBe(200);
    const chunks = parseSSEResponse(res.body);
    const content = reassembleTextContent(chunks);
    expect(content).toBe("pong");
  });
});

describe("integration: onToolResult", () => {
  let mock: LLMock | null = null;

  afterEach(async () => {
    if (mock) {
      try {
        await mock.stop();
      } catch (err) {
        if (!(err instanceof Error && err.message === "Server not started")) {
          throw err;
        }
      }
      mock = null;
    }
  });

  it("matches a tool result message and streams the expected response", async () => {
    mock = new LLMock();
    mock.onToolResult("call_abc", { content: "result text" });
    await mock.start();

    // Send a request with a tool result message matching the call ID
    const res = await httpPost(`${mock.url}/v1/chat/completions`, {
      model: "gpt-4",
      stream: true,
      messages: [
        {
          role: "user",
          content: "do something",
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_abc",
              type: "function",
              function: {
                name: "some_tool",
                arguments: "{}",
              },
            },
          ],
        },
        {
          role: "tool",
          content: "tool output here",
          tool_call_id: "call_abc",
        },
      ],
    });

    expect(res.status).toBe(200);

    // Parse SSE chunks and reassemble content
    const chunks = parseSSEResponse(res.body);
    expect(chunks.length).toBeGreaterThan(0);

    const content = reassembleTextContent(chunks);
    expect(content).toBe("result text");

    // Raw response ends with [DONE]
    expect(res.body).toContain("data: [DONE]");

    // Verify journal records the matched fixture
    const entries = mock.getRequests();
    expect(entries).toHaveLength(1);
    expect(entries[0].response.status).toBe(200);
    expect(entries[0].response.fixture).not.toBeNull();
    expect(entries[0].response.fixture!.match.toolCallId).toBe("call_abc");
  });
});

describe("integration: cross-provider fixture sharing", () => {
  it("same fixture works across all 4 endpoints", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: { content: "Hello from fixture!" },
      },
    ];

    instance = await createServer(fixtures, { port: 0, chunkSize: 100 });

    // OpenAI Chat Completions
    const r1 = await httpPost(`${instance.url}/v1/chat/completions`, chatRequest("hello"));
    expect(r1.status).toBe(200);

    // OpenAI Responses API
    const r2 = await httpPost(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [{ role: "user", content: "hello" }],
    });
    expect(r2.status).toBe(200);

    // Anthropic Claude Messages API
    const r3 = await httpPost(`${instance.url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hello" }],
    });
    expect(r3.status).toBe(200);

    // Google Gemini generateContent
    const r4 = await httpPost(`${instance.url}/v1beta/models/gemini-2.0-flash:generateContent`, {
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
    });
    expect(r4.status).toBe(200);

    // Journal should have 4 entries
    expect(instance.journal.size).toBe(4);
  });
});

describe("integration: large payload streaming", () => {
  it("streams and reassembles a large (50KB+) text response", async () => {
    const largeContent = "x".repeat(50000);

    const fixtures: Fixture[] = [
      {
        match: { userMessage: "big" },
        response: { content: largeContent },
      },
    ];

    instance = await createServer(fixtures, {
      port: 0,
      chunkSize: 20,
    });

    const res = await httpPost(`${instance.url}/v1/chat/completions`, chatRequest("big payload"));

    expect(res.status).toBe(200);

    const chunks = parseSSEResponse(res.body);
    expect(chunks.length).toBeGreaterThan(0);

    const content = reassembleTextContent(chunks);
    expect(content).toBe(largeContent);
    expect(content.length).toBe(50000);

    expect(res.body).toContain("data: [DONE]");
  });

  it("works with a very small chunkSize to maximize chunk count", async () => {
    const largeContent = "y".repeat(50000);

    const fixtures: Fixture[] = [
      {
        match: { userMessage: "tiny-chunks" },
        response: { content: largeContent },
        chunkSize: 5,
      },
    ];

    instance = await createServer(fixtures, {
      port: 0,
    });

    const res = await httpPost(
      `${instance.url}/v1/chat/completions`,
      chatRequest("tiny-chunks test"),
    );

    expect(res.status).toBe(200);

    const chunks = parseSSEResponse(res.body);

    // With chunkSize=5 on 50000 chars, we expect many chunks
    // (at least 50000/5 = 10000 content chunks, plus role + finish chunks)
    expect(chunks.length).toBeGreaterThan(5000);

    const content = reassembleTextContent(chunks);
    expect(content).toBe(largeContent);
    expect(content.length).toBe(50000);

    expect(res.body).toContain("data: [DONE]");
  });
});
