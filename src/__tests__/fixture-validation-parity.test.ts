/**
 * #505 — namespaced and custom tool calls are validated the same way on every
 * fixture entry path: file load (`validateFixtures`), programmatic fixtures
 * (`addFixture` / `on`) and response factories. Custom calls live in the new
 * Responses-only keys `customToolCalls` / `responsesBlocks`; programmatic and
 * factory fixtures are never load-validated, so the request-time guard is the
 * check for those keys (a 500 carrying the guard's message and code). Every
 * `toolCalls` shape that 1.44.0 loaded and served (a `type` of any value, a
 * stray `input`, an invalid `namespace`) still serves as a function call with
 * no validation finding. A request namespace tool named "" is dropped, as
 * 1.44.0 ignored it.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  entryToFixture,
  markFixtureResponsesToolsExtended,
  validateFixtures,
} from "../fixture-loader.js";
import { LLMock } from "../llmock.js";
import type { Fixture, FixtureFileEntry } from "../types.js";
import { connectWebSocket } from "./ws-test-client.js";

const CODE = "aimock_invalid_fixture_tool_call";

function issuesFor(match: Record<string, unknown>, response: Record<string, unknown>) {
  const entry = { match, response } as FixtureFileEntry;
  // As loaded for a server with responsesTools "extended", which checks the new keys.
  const fixture = entryToFixture(entry);
  markFixtureResponsesToolsExtended(fixture);
  return validateFixtures([fixture]).map((r) => [r.severity, r.message]);
}

const DIVERGE =
  "blocks toolCalls diverge from toolCalls — builders stream blocks and ignore the redundant toolCalls field";

describe("blocks vs toolCalls divergence compares names, as 1.44.0", () => {
  it("same names in the same order do not warn, whatever their namespace", () => {
    const issues = issuesFor(
      { userMessage: "go" },
      {
        content: "hi",
        toolCalls: [{ name: "search", namespace: "mcp__a__", arguments: "{}" }],
        blocks: [
          { type: "text", text: "hi" },
          { type: "toolCall", name: "search", namespace: "mcp__b__", arguments: "{}" },
        ],
      },
    );
    expect(issues).toEqual([]);
  });

  it("warns when a name differs", () => {
    const issues = issuesFor(
      { userMessage: "go" },
      {
        content: "hi",
        toolCalls: [{ name: "search", arguments: "{}" }],
        blocks: [
          { type: "text", text: "hi" },
          { type: "toolCall", name: "lookup", arguments: "{}" },
        ],
      },
    );
    expect(issues).toEqual([["warning", DIVERGE]]);
  });
});

describe("toolCalls entry name and id types: no new finding (1.44.0 had none)", () => {
  it.each([
    [{ name: 5, arguments: "{}" }],
    [{ name: "search", arguments: "{}", id: 7 }],
    [{ type: "Custom", name: "search", arguments: "{}" }],
  ])("%j loads clean", (call) => {
    expect(issuesFor({ userMessage: "go" }, { toolCalls: [call] })).toEqual([]);
  });

  it.each([
    [{ name: 5, input: "x" }, "customToolCalls[0].name must be a non-empty string"],
    [
      { name: "apply_patch", input: "x", id: 7 },
      "customToolCalls[0].id must be a string, got number",
    ],
  ])("customToolCalls %j is an error", (call, message) => {
    expect(issuesFor({ userMessage: "go" }, { toolCalls: [], customToolCalls: [call] })).toEqual([
      ["error", message],
    ]);
  });

  it("an empty function name keeps its existing message", () => {
    expect(
      issuesFor({ userMessage: "go" }, { toolCalls: [{ name: "", arguments: "{}" }] }),
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

async function serve(fixtures: Fixture[], responsesTools?: "legacy" | "extended"): Promise<LLMock> {
  mock = new LLMock({ port: 0, logLevel: "silent", responsesTools });
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

describe("programmatic custom calls are guarded at request time; 1.44.0 toolCalls shapes serve", () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    [
      "empty namespace",
      { name: "apply_patch", input: "x", namespace: "" },
      '"namespace" must be a non-empty string when present',
    ],
    [
      "numeric namespace",
      { name: "apply_patch", input: "x", namespace: 5 },
      '"namespace" must be a non-empty string when present',
    ],
    [
      "numeric name",
      { name: 5, input: "x" },
      'custom tool call requires a non-empty string "name" field',
    ],
    [
      "numeric id",
      { name: "apply_patch", input: "x", id: 7 },
      'custom tool call "id" must be a string when present',
    ],
    [
      "arguments",
      { name: "apply_patch", input: "x", arguments: "{}" },
      'custom tool call takes "input", not "arguments"',
    ],
    ["no input", { name: "apply_patch" }, '"input" must be a string for a custom tool call'],
  ];

  for (const stream of [false, true]) {
    it.each(cases)(
      `Responses stream=${stream}: a custom call with %s is a 500`,
      async (_label, call, message) => {
        const m = await serve(
          [fixtureWith({ toolCalls: [], customToolCalls: [call] })],
          "extended",
        );
        const res = await post(m, "/v1/responses", responsesBody(stream));
        expect(res.status).toBe(500);
        const error = errorOf(res.text);
        expect(error.message).toContain(message);
        expect(error.message).toContain("(customToolCalls[0])");
        expect(error.code).toBe(CODE);
      },
    );
  }

  const legacy: Array<[string, Record<string, unknown>]> = [
    ["empty namespace", { name: "search", arguments: "{}", namespace: "" }],
    ["null namespace", { name: "search", arguments: "{}", namespace: null }],
    ["numeric namespace", { name: "search", arguments: "{}", namespace: 5 }],
    ['type "custom" with arguments', { type: "custom", name: "search", arguments: "{}" }],
    [
      'block discriminator "customToolCall"',
      { type: "customToolCall", name: "search", arguments: "{}" },
    ],
    ['wrong-case type "Custom"', { type: "Custom", name: "search", arguments: "{}", input: "x" }],
    ["function with input", { name: "search", arguments: "{}", input: "x" }],
  ];
  it.each(legacy)(
    "%s in toolCalls serves a function call on Responses and Chat (1.44.0)",
    async (_label, call) => {
      const m = await serve([fixtureWith({ toolCalls: [call] })]);
      for (const stream of [false, true]) {
        const res = await post(m, "/v1/responses", responsesBody(stream));
        expect(res.status, res.text).toBe(200);
        expect(res.text).toContain('"type":"function_call"');
        expect(res.text).not.toContain("custom_tool_call");
        expect(res.text).not.toContain('"namespace"');
        const chat = await post(m, "/v1/chat/completions", chatBody(stream));
        expect(chat.status, chat.text).toBe(200);
        expect(chat.text).toContain("search");
      }
    },
  );

  it("Chat Completions: a customToolCalls fixture is a 500 aimock_unsupported_tool_call", async () => {
    const m = await serve(
      [fixtureWith({ toolCalls: [], customToolCalls: [{ name: "apply_patch", input: "x" }] })],
      "extended",
    );
    for (const stream of [false, true]) {
      const res = await post(m, "/v1/chat/completions", chatBody(stream));
      expect(res.status).toBe(500);
      expect(errorOf(res.text).code).toBe("aimock_unsupported_tool_call");
    }
  });

  it("Responses WebSocket: a malformed custom call is an error event with the code", async () => {
    const m = await serve(
      [
        fixtureWith({
          toolCalls: [],
          customToolCalls: [{ name: "run", input: "x", namespace: 7 }],
        }),
      ],
      "extended",
    );
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

  it("a well-formed namespaced function call and custom call emit (namespace on toolCalls needs extended)", async () => {
    mock = new LLMock({ port: 0, logLevel: "silent", responsesTools: "extended" });
    mock.addFixture(
      fixtureWith({
        toolCalls: [{ name: "search", arguments: "{}", namespace: "mcp__docs__" }],
        customToolCalls: [{ type: "custom", name: "apply_patch", input: "x", id: "call_1" }],
      }),
    );
    await mock.start();
    const res = await post(mock, "/v1/responses", responsesBody(false));
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
  it("loads with no finding, as 1.44.0", () => {
    expect(
      issuesFor(
        { userMessage: "go" },
        { toolCalls: [{ type: "toolCall", name: "search", arguments: "{}" }] },
      ),
    ).toEqual([]);
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
});

describe("response factories are guarded the same way", () => {
  type FactoryResult = ReturnType<Extract<Fixture["response"], (...a: never[]) => unknown>>;
  const factory = (response: Record<string, unknown>): Fixture => ({
    match: { userMessage: "go" },
    response: () => response as unknown as FactoryResult,
  });

  for (const stream of [false, true]) {
    it(`Responses stream=${stream}: a factory custom call that also carries arguments is a 500`, async () => {
      const m = await serve(
        [
          factory({
            toolCalls: [],
            customToolCalls: [{ name: "apply_patch", input: "x", arguments: { a: 1 } }],
          }),
        ],
        "extended",
      );
      const res = await post(m, "/v1/responses", responsesBody(stream));
      expect(res.status).toBe(500);
      expect(errorOf(res.text).message).toContain(
        'custom tool call takes "input", not "arguments"',
      );
      expect(errorOf(res.text).code).toBe(CODE);
    });

    it(`Chat Completions stream=${stream}: a factory function call with an empty namespace serves (1.44.0)`, async () => {
      const m = await serve([
        factory({ toolCalls: [{ name: "search", arguments: "{}", namespace: "" }] }),
      ]);
      const res = await post(m, "/v1/chat/completions", chatBody(stream));
      expect(res.status, res.text).toBe(200);
      expect(res.text).toContain("search");
    });
  }
});

describe('empty namespaces: a request namespace named "" is dropped; toolNamespace "" never matches', () => {
  // OpenAI's schema requires a namespace tool name of at least one character.
  // aimock drops such a tool (1.44.0 ignored namespace tools altogether)
  // instead of failing the request.
  const EMPTY_NS_TOOLS = {
    tools: [
      {
        type: "namespace",
        name: "",
        tools: [{ type: "function", name: "f", parameters: {} }],
      },
    ],
  };

  it('a request namespace named "" is served, and toolNamespace "" never matches it', async () => {
    const m = await serve(
      [
        { match: { userMessage: "go", toolNamespace: "" }, response: { content: "EMPTY-NS" } },
        { match: { userMessage: "go" }, response: { content: "fallback" } },
      ],
      "extended",
    );
    const res = await post(m, "/v1/responses", responsesBody(false, EMPTY_NS_TOOLS));
    expect(res.status, res.text).toBe(200);
    expect(res.text).toContain("fallback");
    expect(res.text).not.toContain("EMPTY-NS");
  });

  it("the inner tools of an empty-named namespace are dropped, not matched by toolName (either mode)", async () => {
    for (const responsesTools of ["legacy", "extended"] as const) {
      mock = new LLMock({ port: 0, logLevel: "silent", responsesTools });
      mock.addFixture({
        match: { userMessage: "go", toolName: "f" },
        response: { content: "BY-NAME" },
      });
      await mock.start();
      const res = await post(mock, "/v1/responses", responsesBody(false, EMPTY_NS_TOOLS));
      expect(res.status, res.text).toBe(404);
      expect(res.text).not.toContain("BY-NAME");
      await mock.stop();
      mock = null;
    }
  });
  it('toolNamespace "" matches neither un-namespaced nor namespaced tools', async () => {
    const m = await serve(
      [
        { match: { userMessage: "go", toolNamespace: "" }, response: { content: "EMPTY-NS" } },
        { match: { userMessage: "go" }, response: { content: "fallback" } },
      ],
      "extended",
    );
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
