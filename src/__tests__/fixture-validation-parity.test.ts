/**
 * #505 — namespaced and custom tool calls are validated the same way on every
 * fixture entry path: file load (`validateFixtures`), programmatic fixtures
 * (`addFixture` / `on`) and response factories. Programmatic and factory
 * fixtures are never load-validated, so the request-time guard is the check:
 * a malformed custom call or namespace is a 500 carrying the guard's message
 * and code, never a 200 with the malformed value on the wire. Function-call
 * shapes that loaded and served before custom calls existed (a legacy
 * `type: "toolCall"`, a wrong-case `"Custom"`, a stray `input`) still serve as
 * function calls; file load only warns on them. A request namespace tool named
 * "" is a 400 before any fixture is consulted.
 */
import { afterEach, describe, expect, it } from "vitest";
import { entryToFixture, validateFixtures } from "../fixture-loader.js";
import { LLMock } from "../llmock.js";
import type { Fixture, FixtureFileEntry } from "../types.js";
import { connectWebSocket } from "./ws-test-client.js";

const CODE = "aimock_invalid_fixture_tool_call";

function issuesFor(match: Record<string, unknown>, response: Record<string, unknown>) {
  const entry = { match, response } as FixtureFileEntry;
  return validateFixtures([entryToFixture(entry)]).map((r) => [r.severity, r.message]);
}

const DIVERGE =
  "blocks toolCalls diverge from toolCalls — builders stream blocks and ignore the redundant toolCalls field";

describe("blocks vs toolCalls divergence compares kind, name and namespace", () => {
  it("custom blocks that exactly match custom toolCalls do not warn", () => {
    const issues = issuesFor(
      { userMessage: "go" },
      {
        content: "hi",
        toolCalls: [{ type: "custom", name: "apply_patch", namespace: "sandbox", input: "x" }],
        blocks: [
          { type: "text", text: "hi" },
          { type: "customToolCall", name: "apply_patch", namespace: "sandbox", input: "x" },
        ],
      },
    );
    expect(issues).toEqual([]);
  });

  it("mixed function and custom calls in the same order do not warn", () => {
    const issues = issuesFor(
      { userMessage: "go" },
      {
        content: "hi",
        toolCalls: [
          { name: "search", arguments: "{}" },
          { type: "custom", name: "apply_patch", input: "x" },
        ],
        blocks: [
          { type: "text", text: "hi" },
          { type: "toolCall", name: "search", arguments: "{}" },
          { type: "customToolCall", name: "apply_patch", input: "x" },
        ],
      },
    );
    expect(issues).toEqual([]);
  });

  it.each([
    [
      "custom name differs",
      [{ type: "custom", name: "apply_patch", input: "x" }],
      [{ type: "customToolCall", name: "run_shell", input: "x" }],
    ],
    [
      "same name, different kind",
      [{ name: "apply_patch", arguments: "{}" }],
      [{ type: "customToolCall", name: "apply_patch", input: "x" }],
    ],
    [
      "same name, different namespace",
      [{ name: "search", namespace: "mcp__a__", arguments: "{}" }],
      [{ type: "toolCall", name: "search", namespace: "mcp__b__", arguments: "{}" }],
    ],
  ])("warns when %s", (_label, toolCalls, toolBlocks) => {
    const issues = issuesFor(
      { userMessage: "go" },
      { content: "hi", toolCalls, blocks: [{ type: "text", text: "hi" }, ...toolBlocks] },
    );
    expect(issues).toEqual([["warning", DIVERGE]]);
  });
});

describe("toolCalls entry name and id types match the block rules", () => {
  it.each([
    [{ type: "custom", name: 5, input: "x" }, "toolCalls[0].name must be a string, got number"],
    [
      { type: "custom", name: "apply_patch", input: "x", id: 7 },
      "toolCalls[0].id must be a string, got number",
    ],
  ])("%j is an error", (call, message) => {
    expect(issuesFor({ userMessage: "go" }, { toolCalls: [call] })).toEqual([["error", message]]);
  });

  // Function calls with these loaded before custom calls existed: a warning.
  it.each([
    [{ name: 5, arguments: "{}" }, "toolCalls[0].name must be a string, got number"],
    [{ name: "search", arguments: "{}", id: 7 }, "toolCalls[0].id must be a string, got number"],
  ])("%j is a warning", (call, message) => {
    expect(issuesFor({ userMessage: "go" }, { toolCalls: [call] })).toEqual([["warning", message]]);
  });

  it("an empty name keeps its existing message", () => {
    expect(
      issuesFor({ userMessage: "go" }, { toolCalls: [{ type: "custom", name: "", input: "x" }] }),
    ).toEqual([["error", "toolCalls[0].name is empty"]]);
  });
});

describe("toolNamespace with an endpoint that never carries tool namespaces", () => {
  const WARN =
    'match.toolNamespace never matches with endpoint "image" — only OpenAI Responses requests (endpoint "chat") carry tool namespaces';

  it("warns for a non-chat endpoint", () => {
    expect(
      issuesFor({ toolNamespace: "mcp__docs__", endpoint: "image" }, { content: "x" }),
    ).toEqual([["warning", WARN]]);
  });

  it('stays silent for endpoint "chat", which Responses requests carry', () => {
    expect(issuesFor({ toolNamespace: "mcp__docs__", endpoint: "chat" }, { content: "x" })).toEqual(
      [],
    );
  });

  it("stays silent without an endpoint", () => {
    expect(issuesFor({ toolNamespace: "mcp__docs__" }, { content: "x" })).toEqual([]);
  });
});

// ─── Request-time guard for programmatic and factory fixtures ───────────────

let mock: LLMock | null = null;

afterEach(async () => {
  await mock?.stop();
  mock = null;
});

async function serve(fixtures: Fixture[]): Promise<LLMock> {
  mock = new LLMock({ port: 0, logLevel: "silent" });
  for (const f of fixtures) mock.addFixture(f);
  await mock.start();
  return mock;
}

async function post(m: LLMock, path: string, body: Record<string, unknown>) {
  const res = await fetch(m.url + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

/** The `{ error: { message, code } }` envelope of a failed request. */
function errorOf(text: string): { message: string; code?: string } {
  return (JSON.parse(text) as { error: { message: string; code?: string } }).error;
}

const responsesBody = (stream: boolean, extra: Record<string, unknown> = {}) => ({
  model: "gpt-5",
  input: "go",
  stream,
  ...extra,
});
const chatBody = (stream: boolean) => ({
  model: "gpt-4o",
  messages: [{ role: "user", content: "go" }],
  stream,
});

/** Build a `Fixture` from a deliberately malformed in-code response. */
function fixtureWith(response: Record<string, unknown>): Fixture {
  return { match: { userMessage: "go" }, response } as unknown as Fixture;
}

describe("programmatic toolCalls are guarded like blocks at request time", () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    [
      "empty namespace",
      { name: "search", arguments: "{}", namespace: "" },
      '"namespace" must be a non-empty string when present',
    ],
    [
      "null namespace",
      { name: "search", arguments: "{}", namespace: null },
      '"namespace" must be a non-empty string when present',
    ],
    [
      "numeric namespace",
      { name: "search", arguments: "{}", namespace: 5 },
      '"namespace" must be a non-empty string when present',
    ],
    [
      "custom with numeric name",
      { type: "custom", name: 5, input: "x" },
      'custom tool call requires a non-empty string "name" field',
    ],
    [
      "custom with numeric id",
      { type: "custom", name: "apply_patch", input: "x", id: 7 },
      'custom tool call "id" must be a string when present',
    ],
    [
      "custom with arguments",
      { type: "custom", name: "apply_patch", input: "x", arguments: "{}" },
      'custom tool call takes "input", not "arguments"',
    ],
    [
      "custom without input",
      { type: "custom", name: "apply_patch" },
      '"input" must be a string for a custom tool call',
    ],
    [
      'block discriminator "customToolCall"',
      { type: "customToolCall", name: "apply_patch", input: "x" },
      'unknown type "customToolCall" (expected "function" or "custom")',
    ],
  ];

  for (const stream of [false, true]) {
    it.each(cases)(`Responses stream=${stream}: %s is a 500`, async (_label, call, message) => {
      const m = await serve([fixtureWith({ toolCalls: [call] })]);
      const res = await post(m, "/v1/responses", responsesBody(stream));
      expect(res.status).toBe(500);
      const error = errorOf(res.text);
      expect(error.message).toContain(message);
      expect(error.code).toBe(CODE);
    });
  }

  it("Responses content+toolCalls: an empty namespace is a 500", async () => {
    const m = await serve([
      fixtureWith({
        content: "hi",
        toolCalls: [{ name: "search", arguments: "{}", namespace: "" }],
      }),
    ]);
    for (const stream of [false, true]) {
      const res = await post(m, "/v1/responses", responsesBody(stream));
      expect(res.status).toBe(500);
      expect(errorOf(res.text)).toEqual({
        message: expect.stringContaining('"namespace" must be a non-empty string when present'),
        type: "server_error",
        code: CODE,
      });
    }
  });

  it.each([
    [
      "empty namespace",
      { name: "search", arguments: "{}", namespace: "" },
      '"namespace" must be a non-empty string when present',
    ],
    [
      'block discriminator "customToolCall"',
      { type: "customToolCall", name: "apply_patch", input: "x" },
      'unknown type "customToolCall" (expected "function" or "custom")',
    ],
  ])("Chat Completions: %s is a 500", async (_label, call, message) => {
    const m = await serve([fixtureWith({ toolCalls: [call] })]);
    for (const stream of [false, true]) {
      const res = await post(m, "/v1/chat/completions", chatBody(stream));
      expect(res.status).toBe(500);
      expect(errorOf(res.text).message).toContain(message);
      expect(errorOf(res.text).code).toBe(CODE);
    }
  });

  it("Responses WebSocket: a numeric namespace is an error event with the code", async () => {
    const m = await serve([
      fixtureWith({ toolCalls: [{ name: "search", arguments: "{}", namespace: 7 }] }),
    ]);
    const ws = await connectWebSocket(m.url, "/v1/responses");
    let raw: string;
    try {
      ws.send(
        JSON.stringify({
          type: "response.create",
          model: "gpt-5",
          input: [{ role: "user", content: "go" }],
        }),
      );
      [raw] = await ws.waitForMessages(1);
    } finally {
      ws.close();
    }
    const event = JSON.parse(raw) as {
      type: string;
      error: { message: string; type: string; code: string };
    };
    expect(event.type).toBe("error");
    expect(event.error.message).toContain('"namespace" must be a non-empty string when present');
    expect(event.error.type).toBe("server_error");
    expect(event.error.code).toBe(CODE);
    const entries = m.getRequests();
    expect(entries).toHaveLength(1);
    expect(entries[0].response.status).toBe(500);
    expect(entries[0].response.error).toContain(
      '"namespace" must be a non-empty string when present',
    );
  });

  it("a well-formed namespaced function call and custom call still emit", async () => {
    const m = await serve([
      fixtureWith({
        toolCalls: [
          { name: "search", arguments: "{}", namespace: "mcp__docs__" },
          { type: "custom", name: "apply_patch", input: "x", id: "call_1" },
        ],
      }),
    ]);
    const res = await post(m, "/v1/responses", responsesBody(false));
    expect(res.status).toBe(200);
    const output = (JSON.parse(res.text) as { output: Array<Record<string, unknown>> }).output;
    expect(output.map((o) => [o.type, o.namespace, o.name, o.arguments, o.input])).toEqual([
      ["function_call", "mcp__docs__", "search", "{}", undefined],
      ["custom_tool_call", undefined, "apply_patch", undefined, "x"],
    ]);
    expect(output[0].call_id).toEqual(expect.any(String));
    expect(output[1].call_id).toBe("call_1");
  });
});

describe('a legacy toolCalls entry typed "toolCall" stays a function call', () => {
  it("loads with a warning, not an error", () => {
    expect(
      issuesFor(
        { userMessage: "go" },
        { toolCalls: [{ type: "toolCall", name: "search", arguments: "{}" }] },
      ),
    ).toEqual([
      [
        "warning",
        'toolCalls[0].type "toolCall" is read as a function call; use "function" (or omit type), or "custom" for a custom tool call',
      ],
    ]);
  });

  it("emits a function call on Responses and Chat Completions", async () => {
    const m = await serve([
      fixtureWith({ toolCalls: [{ type: "toolCall", name: "search", arguments: "{}" }] }),
    ]);
    const responses = await post(m, "/v1/responses", responsesBody(false));
    expect(responses.status).toBe(200);
    const output = (JSON.parse(responses.text) as { output: Array<Record<string, unknown>> })
      .output;
    expect(output.map((o) => [o.type, o.name])).toEqual([["function_call", "search"]]);
    const chat = await post(m, "/v1/chat/completions", chatBody(false));
    expect(chat.status).toBe(200);
    const toolCalls = (
      JSON.parse(chat.text) as {
        choices: Array<{ message: { tool_calls: Array<Record<string, unknown>> } }>;
      }
    ).choices[0].message.tool_calls;
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({
      type: "function",
      function: { name: "search", arguments: "{}" },
    });
    expect(chat.text).not.toContain('"type":"toolCall"');
  });

  // Served as function calls before custom calls existed, so they still are.
  it.each([
    ['wrong-case type "Custom"', { type: "Custom", name: "search", arguments: "{}", input: "x" }],
    ["function with input", { name: "search", arguments: "{}", input: "x" }],
  ])("%s is served as a function call", async (_label, call) => {
    const m = await serve([fixtureWith({ toolCalls: [call] })]);
    for (const stream of [false, true]) {
      const res = await post(m, "/v1/responses", responsesBody(stream));
      expect(res.status).toBe(200);
      expect(res.text).toContain('"type":"function_call"');
      expect(res.text).not.toContain("custom_tool_call");
    }
  });
});

describe("response factories are guarded the same way", () => {
  type FactoryResult = ReturnType<Extract<Fixture["response"], (...a: never[]) => unknown>>;
  const factory = (toolCall: Record<string, unknown>): Fixture => ({
    match: { userMessage: "go" },
    response: () => ({ toolCalls: [toolCall] }) as unknown as FactoryResult,
  });

  for (const stream of [false, true]) {
    it(`Responses stream=${stream}: a factory custom call that also carries arguments is a 500`, async () => {
      const m = await serve([
        factory({ type: "custom", name: "apply_patch", input: "x", arguments: { a: 1 } }),
      ]);
      const res = await post(m, "/v1/responses", responsesBody(stream));
      expect(res.status).toBe(500);
      expect(errorOf(res.text).message).toContain(
        'custom tool call takes "input", not "arguments"',
      );
      expect(errorOf(res.text).code).toBe(CODE);
    });

    it(`Chat Completions stream=${stream}: a factory function call with an empty namespace is a 500`, async () => {
      const m = await serve([factory({ name: "search", arguments: "{}", namespace: "" })]);
      const res = await post(m, "/v1/chat/completions", chatBody(stream));
      expect(res.status).toBe(500);
      expect(errorOf(res.text).message).toContain(
        '"namespace" must be a non-empty string when present',
      );
      expect(errorOf(res.text).code).toBe(CODE);
    });
  }
});

describe('empty namespaces: a request namespace named "" is a 400; toolNamespace "" never matches', () => {
  // The OpenAI schema requires a namespace tool name of at least one
  // character, so aimock answers a namespace tool named "" with a 400 before
  // any fixture is consulted — whatever its fixtures match on.
  const EMPTY_NS_TOOLS = {
    tools: [
      {
        type: "namespace",
        name: "",
        tools: [{ type: "function", name: "f", parameters: {} }],
      },
    ],
  };

  function expectEmptyNamespaceRejected(res: { status: number; text: string }) {
    expect(res.status).toBe(400);
    expect(JSON.parse(res.text)).toEqual({
      error: {
        message: "tools[0].name must be a non-empty string for a namespace tool",
        type: "invalid_request_error",
      },
    });
  }

  it('a request namespace named "" is a 400, so toolNamespace "" never matches it', async () => {
    const m = await serve([
      { match: { userMessage: "go", toolNamespace: "" }, response: { content: "EMPTY-NS" } },
      { match: { userMessage: "go" }, response: { content: "fallback" } },
    ]);
    const res = await post(m, "/v1/responses", responsesBody(false, EMPTY_NS_TOOLS));
    expectEmptyNamespaceRejected(res);
    expect(res.text).not.toContain("EMPTY-NS");
  });

  it("the inner tools of an empty-named namespace are rejected, not matched by toolName", async () => {
    const m = await serve([
      { match: { userMessage: "go", toolName: "f" }, response: { content: "BY-NAME" } },
    ]);
    const res = await post(m, "/v1/responses", responsesBody(false, EMPTY_NS_TOOLS));
    expectEmptyNamespaceRejected(res);
    expect(res.text).not.toContain("BY-NAME");
  });

  it('toolNamespace "" matches neither un-namespaced nor namespaced tools', async () => {
    const m = await serve([
      { match: { userMessage: "go", toolNamespace: "" }, response: { content: "EMPTY-NS" } },
      { match: { userMessage: "go" }, response: { content: "fallback" } },
    ]);
    const res = await post(
      m,
      "/v1/responses",
      responsesBody(false, {
        tools: [
          { type: "function", name: "top", parameters: {} },
          { type: "namespace", name: "mcp", tools: [{ type: "function", name: "f" }] },
        ],
      }),
    );
    expect(res.status).toBe(200);
    expect(res.text).toContain("fallback");
    expect(res.text).not.toContain("EMPTY-NS");
  });
});
