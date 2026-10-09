/**
 * The same fixture mistake produces the same coded error no matter where it is
 * written (a `toolCalls` entry or an ordered `blocks` entry) or which transport
 * carries it (HTTP non-streaming, HTTP streaming, WebSocket).
 */
import { afterEach, describe, expect, it } from "vitest";
import { entryToFixture, validateFixtures } from "../fixture-loader.js";
import { LLMock } from "../llmock.js";
import type { Fixture, FixtureFileEntry } from "../types.js";
import { connectWebSocket } from "./ws-test-client.js";

let mock: LLMock | undefined;

afterEach(async () => {
  await mock?.stop();
  mock = undefined;
});

async function start(fixtures: Fixture[]): Promise<LLMock> {
  mock = new LLMock({ port: 0, logLevel: "silent" });
  for (const f of fixtures) mock.addFixture(f);
  await mock.start();
  return mock;
}

async function post(
  m: LLMock,
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  const res = await fetch(`${m.url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  return { status: res.status, text: await res.text() };
}

function errorOf(text: string): { code?: unknown; message?: unknown; type?: unknown } {
  return (JSON.parse(text) as { error?: { code?: unknown; message?: unknown; type?: unknown } })
    .error!;
}

async function wsFirstEvent(m: LLMock, payload: Record<string, unknown>) {
  const ws = await connectWebSocket(m.url, "/v1/responses");
  try {
    ws.send(JSON.stringify({ type: "response.create", ...payload }));
    const [first] = await ws.waitForMessages(1, 5000);
    return JSON.parse(first) as {
      type: string;
      error?: { code?: unknown; message?: unknown; type?: unknown };
    };
  } finally {
    ws.close();
  }
}

const CHAT = { model: "gpt-4o", messages: [{ role: "user", content: "go" }] };
const RESPONSES = { model: "gpt-5", input: "go" };
const INVALID = "aimock_invalid_fixture_tool_call";

describe("malformed tool-call blocks carry aimock_invalid_fixture_tool_call", () => {
  const cases: Array<{ id: string; block: Record<string, unknown>; message: string }> = [
    {
      id: "customToolCall without input",
      block: { type: "customToolCall", name: "apply_patch" },
      message: '"customToolCall" block requires a string "input" field',
    },
    {
      id: "customToolCall with an empty name",
      block: { type: "customToolCall", name: "", input: "x" },
      message: '"customToolCall" block requires a non-empty string "name" field',
    },
    {
      id: "customToolCall with arguments",
      block: { type: "customToolCall", name: "p", input: "x", arguments: "{}" },
      message: '"customToolCall" block takes "input", not "arguments"',
    },
    {
      id: "toolCall with an empty namespace",
      block: { type: "toolCall", name: "f", namespace: "", arguments: "{}" },
      message: '"namespace" must be a non-empty string when present',
    },
    {
      id: "toolCall without a name",
      block: { type: "toolCall", arguments: "{}" },
      message: '"toolCall" block requires a string "name" field',
    },
    {
      id: "toolCall with non-string arguments",
      block: { type: "toolCall", name: "f", arguments: 7 },
      message: '"toolCall" block requires a string or object "arguments" field',
    },
    {
      id: "toolCall with a stray input",
      block: { type: "toolCall", name: "f", arguments: "{}", input: "zz" },
      message: '"input" is only valid on a "customToolCall" block',
    },
  ];

  it.each(cases)("$id: Responses HTTP (both modes) and WS agree", async ({ block, message }) => {
    const m = await start([
      { match: {}, response: { blocks: [{ type: "text", text: "hi" }, block] } } as Fixture,
    ]);
    const expected = `Invalid fixture block at index 1: ${message}`;
    for (const stream of [false, true]) {
      const r = await post(m, "/v1/responses", { ...RESPONSES, stream });
      expect(r.status, r.text).toBe(500);
      expect(errorOf(r.text)).toMatchObject({ code: INVALID, message: expected });
      expect(m.getLastRequest()?.response).toMatchObject({ status: 500, error: expected });
    }
    const ev = await wsFirstEvent(m, RESPONSES);
    expect(ev.type).toBe("error");
    expect(ev.error).toMatchObject({ code: INVALID, message: expected });
  });

  it("a malformed toolCall block is coded on Chat Completions and Gemini Interactions", async () => {
    const m = await start([
      { match: {}, response: { blocks: [{ type: "toolCall", arguments: "{}" }] } } as Fixture,
    ]);
    for (const stream of [false, true]) {
      const chat = await post(m, "/v1/chat/completions", { ...CHAT, stream });
      expect(chat.status, chat.text).toBe(500);
      expect(errorOf(chat.text).code, chat.text).toBe(INVALID);
      expect(m.getLastRequest()?.response.error).toContain('"toolCall" block requires');
      const gi = await post(m, "/v1beta/interactions", {
        model: "gemini-2.5-flash",
        input: "go",
        stream,
      });
      expect(gi.status, gi.text).toBe(500);
      expect(gi.text).toContain(INVALID);
    }
  });
});

describe("a custom call on a non-Responses wire is unsupported before its fields are checked", () => {
  it.each([
    ["toolCalls entry", { toolCalls: [{ type: "custom", name: "x", input: "a", namespace: "" }] }],
    ["customToolCall block", { blocks: [{ type: "customToolCall", name: "x", namespace: "" }] }],
  ])("%s with a bad namespace answers aimock_unsupported_tool_call", async (_id, response) => {
    const m = await start([{ match: {}, response } as Fixture]);
    for (const stream of [false, true]) {
      const r = await post(m, "/v1/chat/completions", { ...CHAT, stream });
      expect(r.status, r.text).toBe(500);
      expect(errorOf(r.text).code, r.text).toBe("aimock_unsupported_tool_call");
    }
  });
});

describe("nested Responses tool lists are validated like top-level tools", () => {
  const cases: Array<{ id: string; extra: Record<string, unknown>; message: string }> = [
    {
      id: "namespace tool without tools",
      extra: { tools: [{ type: "namespace", name: "ns" }] },
      message: "tools[0].tools must be an array for a namespace tool",
    },
    {
      id: "namespace tool with non-array tools",
      extra: { tools: [{ type: "namespace", name: "ns", tools: "x" }] },
      message: "tools[0].tools must be an array for a namespace tool",
    },
    {
      id: "null inside a namespace tool",
      extra: {
        tools: [{ type: "namespace", name: "ns", tools: [{ type: "function", name: "f" }, null] }],
      },
      message: "tools[0].tools entries must not be null",
    },
    {
      id: "null inside additional_tools",
      extra: {
        input: [
          { type: "additional_tools", tools: [null] },
          { role: "user", content: "go" },
        ],
      },
      message: "input[0].tools entries must not be null",
    },
    {
      id: "non-array tool_search_output tools",
      extra: {
        input: [
          { role: "user", content: "go" },
          { type: "tool_search_output", tools: "x" },
        ],
      },
      message: "input[1].tools must be an array",
    },
    {
      id: "namespace inside additional_tools without tools",
      extra: {
        input: [
          { type: "additional_tools", tools: [{ type: "namespace", name: "ns" }] },
          { role: "user", content: "go" },
        ],
      },
      message: "input[0].tools[0].tools must be an array for a namespace tool",
    },
  ];

  it.each(cases)("$id: 400 on HTTP (both modes) and WS", async ({ extra, message }) => {
    const m = await start([{ match: {}, response: { content: "ok" } }]);
    for (const stream of [false, true]) {
      const r = await post(m, "/v1/responses", { ...RESPONSES, ...extra, stream });
      expect(r.status, r.text).toBe(400);
      expect(errorOf(r.text)).toMatchObject({ type: "invalid_request_error", message });
    }
    const ev = await wsFirstEvent(m, { ...RESPONSES, ...extra });
    expect(ev.type).toBe("error");
    expect(ev.error).toMatchObject({ type: "invalid_request_error", message });
    expect(m.getLastRequest()?.response.status).toBe(400);
  });
});

describe("custom_tool_call.input in request history", () => {
  it("a non-string input reaches predicates as a string", async () => {
    const m = await start([
      {
        match: {
          predicate: (req) =>
            req.messages.some((msg) =>
              msg.tool_calls?.some((tc) => tc.function.arguments.includes("PATCH")),
            ),
        },
        response: { content: "matched" },
      },
      { match: {}, response: { content: "fallback" } },
    ]);
    const input = [
      { role: "user", content: "go" },
      { type: "custom_tool_call", call_id: "c1", name: "apply_patch", input: { a: 1 } },
      { type: "custom_tool_call_output", call_id: "c1", output: "done" },
    ];
    const r = await post(m, "/v1/responses", { model: "gpt-5", input });
    expect(r.status, r.text).toBe(200);
    expect(r.text).toContain("fallback");
    const body = m.getLastRequest()?.body as {
      messages: Array<{ tool_calls?: Array<{ function: { arguments: unknown } }> }>;
    };
    const call = body.messages.find((msg) => msg.tool_calls)?.tool_calls?.[0];
    expect(call?.function.arguments).toBe("");
  });
});

describe("load-time warning for custom calls on a non-chat endpoint", () => {
  it.each([
    ["toolCalls", { toolCalls: [{ type: "custom", name: "apply_patch", input: "x" }] }],
    ["blocks", { blocks: [{ type: "customToolCall", name: "apply_patch", input: "x" }] }],
  ])("%s with endpoint embedding warns", (id, response) => {
    const f = entryToFixture({
      match: { userMessage: "go", endpoint: "embedding" },
      response,
    } as FixtureFileEntry);
    const warnings = validateFixtures([f]).filter((r) => r.severity === "warning");
    // The text must hold for every non-chat endpoint: media handlers answer an
    // uncoded 500 shape error, Realtime sends an error event, and openai-live
    // rejects the fixture at load. So it names no status code or error code.
    expect(warnings.map((w) => w.message)).toEqual([
      `${id}[0] is a custom tool call, which only OpenAI Responses requests (endpoint "chat") can carry — endpoint "embedding" never serves it, so a request that matches this fixture gets an error instead`,
    ]);
  });

  it("ignores a custom call in legacy toolCalls when non-empty blocks are served", () => {
    // Non-empty blocks are authoritative, so the legacy toolCalls entry is never sent.
    const f = entryToFixture({
      match: { userMessage: "go", endpoint: "image" },
      response: {
        content: "x",
        toolCalls: [{ type: "custom", name: "apply_patch", input: "x" }],
        blocks: [{ type: "text", text: "x" }],
      },
    } as FixtureFileEntry);
    const messages = validateFixtures([f])
      .filter((r) => r.severity === "warning")
      .map((w) => w.message);
    expect(messages.filter((m) => m.includes("is a custom tool call"))).toEqual([]);
  });

  it("endpoint chat and an absent endpoint do not warn", () => {
    for (const endpoint of ["chat", undefined]) {
      const f = entryToFixture({
        match: { userMessage: "go", ...(endpoint ? { endpoint } : {}) },
        response: { toolCalls: [{ type: "custom", name: "apply_patch", input: "x" }] },
      } as FixtureFileEntry);
      expect(validateFixtures([f]).filter((r) => r.severity === "warning")).toEqual([]);
    }
  });
});

describe("Ollama /api/generate", () => {
  it("rejects content plus a customToolCall block like other tool-call fixtures", async () => {
    const m = await start([
      {
        match: {},
        response: {
          content: "hi",
          blocks: [
            { type: "text", text: "hi" },
            { type: "customToolCall", name: "p", input: "x" },
          ],
        },
      } as Fixture,
    ]);
    for (const stream of [false, true]) {
      const r = await post(m, "/api/generate", { model: "llama3", prompt: "go", stream });
      expect(r.status, r.text).toBe(400);
      expect(r.text).toContain("Tool call fixtures are not supported on /api/generate");
    }
  });

  it.each([
    ["misspelled type", { type: "toolcall", name: "f", arguments: "{}" }],
    ["unknown type", { type: "image", url: "x" }],
    ["null type", { type: null }],
  ])("answers a %s block with the same error as /api/chat", async (_label, block) => {
    const m = await start([{ match: {}, response: { content: "", blocks: [block] } } as Fixture]);
    const chat = await post(m, "/api/chat", {
      model: "llama3",
      messages: [{ role: "user", content: "go" }],
      stream: false,
    });
    expect(chat.status, chat.text).toBe(500);
    expect(chat.text).toContain("Invalid fixture block at index 0");
    for (const stream of [false, true]) {
      const r = await post(m, "/api/generate", { model: "llama3", prompt: "go", stream });
      expect(r.status, r.text).toBe(chat.status);
      expect(r.text).toBe(chat.text);
    }
  });

  it.each([
    [
      "toolCall then unknown",
      [
        { type: "toolCall", name: "f", arguments: "{}" },
        { type: "image", url: "x" },
      ],
      "Invalid fixture block at index 1",
    ],
    [
      "unknown then toolCall",
      [
        { type: "image", url: "x" },
        { type: "toolCall", name: "f", arguments: "{}" },
      ],
      "Invalid fixture block at index 0",
    ],
  ])("answers a %s block list with the same error as /api/chat", async (_l, blocks, msg) => {
    const m = await start([{ match: {}, response: { content: "", blocks } } as Fixture]);
    const chat = await post(m, "/api/chat", {
      model: "llama3",
      messages: [{ role: "user", content: "go" }],
      stream: false,
    });
    expect(chat.status, chat.text).toBe(500);
    expect(chat.text).toContain(msg);
    for (const stream of [false, true]) {
      const r = await post(m, "/api/generate", { model: "llama3", prompt: "go", stream });
      expect(r.status, r.text).toBe(chat.status);
      expect(r.text).toBe(chat.text);
    }
  });

  it("reports a malformed toolCall block with /api/chat's status, message and code", async () => {
    // The body envelope differs: server.ts gives only /api/chat Ollama's bare
    // string error shape, so /api/generate keeps the OpenAI-style envelope.
    const blocks = [
      { type: "toolCall", arguments: "{}" },
      { type: "image", url: "x" },
    ];
    const m = await start([{ match: {}, response: { content: "", blocks } } as Fixture]);
    const chat = await post(m, "/api/chat", {
      model: "llama3",
      messages: [{ role: "user", content: "go" }],
      stream: false,
    });
    const chatBody = JSON.parse(chat.text) as { error: string; code: string };
    expect(chat.status, chat.text).toBe(500);
    expect(chatBody.code).toBe(INVALID);
    expect(chatBody.error).toContain('index 0: "toolCall" block requires a string "name" field');
    for (const stream of [false, true]) {
      const r = await post(m, "/api/generate", { model: "llama3", prompt: "go", stream });
      expect(r.status, r.text).toBe(chat.status);
      expect(errorOf(r.text)).toMatchObject({ message: chatBody.error, code: chatBody.code });
    }
  });

  it.each([
    ["no misbehavior", {}],
    ["a misbehavior header", { "x-aimock-misbehavior": "empty-response" }],
  ])("journals a bad block on /api/generate as /api/chat does, with %s", async (_l, headers) => {
    const m = await start([
      { match: {}, response: { content: "", blocks: [{ type: "image", url: "x" }] } } as Fixture,
    ]);
    const chat = await post(
      m,
      "/api/chat",
      { model: "llama3", messages: [{ role: "user", content: "go" }], stream: false },
      headers,
    );
    expect(chat.status, chat.text).toBe(500);
    const chatEntry = m.getLastRequest()!;
    expect(chatEntry.body).not.toBeNull();
    expect(chatEntry.response.fixture).not.toBeNull();
    for (const stream of [false, true]) {
      const r = await post(m, "/api/generate", { model: "llama3", prompt: "go", stream }, headers);
      expect(r.text).toBe(chat.text);
      const entry = m.getLastRequest()!;
      expect(entry.path).toBe("/api/generate");
      expect(entry.body).toMatchObject({
        model: "llama3",
        messages: [{ role: "user", content: "go" }],
      });
      expect(entry.response).toEqual(chatEntry.response);
    }
  });

  it.each([
    ["toolCall", { type: "toolCall", name: "f", arguments: "{}" }],
    ["customToolCall", { type: "customToolCall", name: "p", input: "x" }],
  ])("still rejects a %s block as a tool-call fixture", async (_label, block) => {
    const m = await start([{ match: {}, response: { content: "", blocks: [block] } } as Fixture]);
    const r = await post(m, "/api/generate", { model: "llama3", prompt: "go", stream: false });
    expect(r.status, r.text).toBe(400);
    expect(r.text).toContain("Tool call fixtures are not supported on /api/generate");
  });

  it("rejects a customToolCall block ahead of an unknown block, as /api/chat does", async () => {
    // /api/chat rejects a custom call before any other block check, so the
    // unknown block is never reported there either.
    const blocks = [
      { type: "image", url: "x" },
      { type: "customToolCall", name: "p", input: "x" },
    ];
    const m = await start([{ match: {}, response: { content: "", blocks } } as Fixture]);
    const r = await post(m, "/api/generate", { model: "llama3", prompt: "go", stream: false });
    expect(r.status, r.text).toBe(400);
    expect(r.text).toContain("Tool call fixtures are not supported on /api/generate");
  });

  it("still serves content plus text-only blocks as text", async () => {
    const m = await start([
      { match: {}, response: { content: "hi", blocks: [{ type: "text", text: "hi" }] } },
    ]);
    const r = await post(m, "/api/generate", { model: "llama3", prompt: "go", stream: false });
    expect(r.status, r.text).toBe(200);
  });
});

describe("BytePlus wire label", () => {
  it("names BytePlus for /api/v3/chat/completions without record config", async () => {
    const m = await start([
      {
        match: {},
        response: { toolCalls: [{ type: "custom", name: "apply_patch", input: "x" }] },
      },
    ]);
    for (const stream of [false, true]) {
      const r = await post(m, "/api/v3/chat/completions", { ...CHAT, model: "doubao", stream });
      expect(r.status, r.text).toBe(500);
      expect(String(errorOf(r.text).message)).toContain(
        "this request arrived on BytePlus ModelArk Chat Completions",
      );
    }
  });
});
