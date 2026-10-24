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
 *
 * The last two sections pin `response.usage`: the exact finding the load-time
 * validator gives for a representative set of usage shapes, and that every
 * usage the recorder sanitizer writes passes that validator.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  entryToFixture,
  markFixtureResponsesToolsExtended,
  validateFixtures,
} from "../fixture-loader.js";
import { LLMock } from "../llmock.js";
import { sanitizeRecordedUsage } from "../recorder.js";
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

describe("name and id types: toolCalls get no new finding (as 1.44.0); customToolCalls are errors", () => {
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

interface ChatToolCall {
  type?: string;
  function?: { name?: string };
}

/**
 * The type and function name of each Chat Completions tool call, from a JSON body or,
 * when streamed, from the SSE chunks that open a call (they carry its type).
 */
function chatToolCalls(text: string, stream: boolean): Array<{ type?: string; name?: string }> {
  let calls: ChatToolCall[];
  if (stream) {
    calls = text
      .split("\n")
      .filter((line) => line.startsWith("data: {"))
      .flatMap((line) => {
        const chunk = JSON.parse(line.slice("data: ".length)) as {
          choices: Array<{ delta: { tool_calls?: ChatToolCall[] } }>;
        };
        return chunk.choices.flatMap((c) => c.delta.tool_calls ?? []);
      })
      .filter((call) => call.type !== undefined);
  } else {
    calls =
      (JSON.parse(text) as { choices: Array<{ message: { tool_calls?: ChatToolCall[] } }> })
        .choices[0].message.tool_calls ?? [];
  }
  return calls.map((call) => ({ type: call.type, name: call.function?.name }));
}

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
        expect(res.status, res.text).toBe(500);
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
        expect(chatToolCalls(chat.text, stream), chat.text).toEqual([
          { type: "function", name: "search" },
        ]);
        expect(chat.text).not.toContain("custom");
        expect(chat.text).not.toContain('"namespace"');
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
      expect(res.status, res.text).toBe(500);
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
      // Shorter than the 5 s test timeout, so a hang fails here with a clear
      // message and the finally block still closes the socket.
      [raw] = await ws.waitForMessages(1, 2000);
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
    expect(entries[0].response.status, entries[0].response.error).toBe(500);
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
    expect(res.status, res.text).toBe(200);
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
    expect(responses.status, responses.text).toBe(200);
    const output = (JSON.parse(responses.text) as { output: Array<Record<string, unknown>> })
      .output;
    expect(output.map((o) => [o.type, o.name])).toEqual([["function_call", "search"]]);
    const chat = await post(m, "/v1/chat/completions", chatBody(false));
    expect(chat.status, chat.text).toBe(200);
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
      expect(res.status, res.text).toBe(500);
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
      expect(chatToolCalls(res.text, stream), res.text).toEqual([
        { type: "function", name: "search" },
      ]);
      expect(res.text).not.toContain('"namespace"');
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
    expect(res.status, res.text).toBe(200);
    expect(res.text).toContain("fallback");
    expect(res.text).not.toContain("EMPTY-NS");
  });
});

// ─── response.usage: load-time validator and recorder sanitizer ─────────────
//
// A representative set of usage shapes, with the exact finding each gives
// today. The recorder sanitizer must only ever write shapes the validator
// accepts, so each input is also passed through sanitizeRecordedUsage and
// the result re-validated.

function usageIssues(usage: unknown) {
  const entry = { match: { userMessage: "go" }, response: { content: "x", usage } };
  return validateFixtures([entryToFixture(entry as FixtureFileEntry)]).map((r) => [
    r.severity,
    r.message,
  ]);
}

const VALID_OPENROUTER_USAGE = {
  prompt_tokens: 12,
  completion_tokens: 3,
  total_tokens: 15,
  cost: 0.00042,
  is_byok: false,
  cost_details: {
    upstream_inference_cost: 0.0004,
    upstream_inference_prompt_cost: 0.0003,
    upstream_inference_completions_cost: 0.0001,
  },
  prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 2, audio_tokens: 0 },
  completion_tokens_details: { reasoning_tokens: 1 },
};

describe("response.usage validation: every shape and its exact message", () => {
  it.each<[string, unknown]>([
    ["plain token counts", { input_tokens: 10, output_tokens: 5 }],
    ["numeric cache_creation", { input_tokens: 10, cache_creation: 7 }],
    [
      "Anthropic cache scalars",
      { input_tokens: 10, cache_creation_input_tokens: 7, cache_read_input_tokens: 3 },
    ],
    ["unknown extra numeric key", { input_tokens: 10, some_future_count: 2 }],
    ["valid OpenRouter breakdown objects", VALID_OPENROUTER_USAGE],
    [
      "undocumented inner members of an OpenRouter object (escape hatch, even strings)",
      { cost_details: { upstream_inference_cost: 1, future_member: "x" } },
    ],
    ["an undefined member is skipped", { input_tokens: undefined, output_tokens: 1 }],
  ])("%s loads clean", (_label, usage) => {
    expect(usageIssues(usage)).toEqual([]);
  });

  it("object cache_creation loads clean", () => {
    expect(
      usageIssues({
        input_tokens: 10,
        cache_creation: { ephemeral_5m_input_tokens: 7, ephemeral_1h_input_tokens: 0 },
      }),
    ).toEqual([]);
  });

  it.each<[string, unknown, string[]]>([
    ["usage not an object", 5, ['override "usage" must be an object']],
    ["usage an array", [1, 2], ['override "usage" must be an object']],
    ["usage null", null, ['override "usage" must be an object']],
    [
      "string token fields",
      { input_tokens: "10", cache_read_input_tokens: "3" },
      [
        'override "usage.input_tokens" must be a number, got string',
        'override "usage.cache_read_input_tokens" must be a number, got string',
      ],
    ],
    [
      "a null member",
      { output_tokens: null },
      ['override "usage.output_tokens" must be a number, got object'],
    ],
    [
      "a boolean member",
      { output_tokens: true },
      ['override "usage.output_tokens" must be a number, got boolean'],
    ],
    [
      "an unknown object member",
      { server_tool_use: { web_search_requests: 1 } },
      ['override "usage.server_tool_use" must be a number, got object'],
    ],
    [
      "nested strings in OpenRouter objects",
      {
        cost_details: { upstream_inference_cost: "0.1" },
        prompt_tokens_details: { cached_tokens: "4", audio_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: "1" },
      },
      [
        'override "usage.cost_details.upstream_inference_cost" must be a number, got string',
        'override "usage.prompt_tokens_details.cached_tokens" must be a number, got string',
        'override "usage.completion_tokens_details.reasoning_tokens" must be a number, got string',
      ],
    ],
    [
      "OpenRouter objects of the wrong type",
      { cost_details: 0.1, prompt_tokens_details: [4], completion_tokens_details: null },
      [
        'override "usage.cost_details" must be an object, got number',
        'override "usage.prompt_tokens_details" must be an object, got array',
        'override "usage.completion_tokens_details" must be an object, got object',
      ],
    ],
    [
      "is_byok not a boolean",
      { is_byok: "true" },
      ['override "usage.is_byok" must be a boolean, got string'],
    ],
  ])("%s is an error", (_label, usage, messages) => {
    expect(usageIssues(usage)).toEqual(messages.map((m) => ["error", m]));
  });
});

describe("recorder sanitizer output always passes the validator", () => {
  // [label, raw usage, what the sanitizer keeps today (undefined: nothing)].
  const RAW_SHAPES: Array<[string, unknown, unknown]> = [
    [
      "plain token counts",
      { input_tokens: 10, output_tokens: 5 },
      { input_tokens: 10, output_tokens: 5 },
    ],
    [
      "numeric cache_creation",
      { input_tokens: 10, cache_creation: 7 },
      { input_tokens: 10, cache_creation: 7 },
    ],
    [
      "object cache_creation",
      { input_tokens: 10, cache_creation: { ephemeral_5m_input_tokens: 7 } },
      { input_tokens: 10, cache_creation: { ephemeral_5m_input_tokens: 7 } },
    ],
    [
      "Anthropic cache scalars",
      { input_tokens: 10, cache_creation_input_tokens: 7, cache_read_input_tokens: 3 },
      { input_tokens: 10, cache_creation_input_tokens: 7, cache_read_input_tokens: 3 },
    ],
    ["string token fields", { input_tokens: "10", output_tokens: 5 }, { output_tokens: 5 }],
    [
      "null and non-finite members",
      { input_tokens: null, output_tokens: Infinity, total_tokens: 2 },
      { total_tokens: 2 },
    ],
    ["valid OpenRouter breakdown objects", VALID_OPENROUTER_USAGE, VALID_OPENROUTER_USAGE],
    [
      "nested strings in OpenRouter objects",
      {
        cost_details: { upstream_inference_cost: "0.1", upstream_inference_prompt_cost: 0.1 },
        prompt_tokens_details: { cached_tokens: "4" },
      },
      { cost_details: { upstream_inference_prompt_cost: 0.1 } },
    ],
    ["is_byok not a boolean", { is_byok: "true", prompt_tokens: 1 }, { prompt_tokens: 1 }],
    [
      "unknown object member",
      { server_tool_use: { web_search_requests: 1 }, output_tokens: 1 },
      { output_tokens: 1 },
    ],
    [
      "finite unknown cache object member survives",
      { input_tokens: "10", cache_creation: { a: 1 } },
      { cache_creation: { a: 1 } },
    ],
  ];

  // Every row asserts both the exact output and that it loads, so no row can
  // pass with zero assertions (an undefined result has no issues to report).
  it.each(RAW_SHAPES)("%s: sanitized usage is pinned and loads clean", (_label, raw, kept) => {
    const sanitized = sanitizeRecordedUsage(raw);
    expect(sanitized).toEqual(kept);
    expect(sanitized === undefined ? [] : usageIssues(sanitized)).toEqual([]);
  });

  it("returns undefined for usage that is not an object", () => {
    expect(sanitizeRecordedUsage([1])).toBeUndefined();
    expect(sanitizeRecordedUsage(null)).toBeUndefined();
  });
});

/**
 * #549 — raw passthrough fixtures get the same findings on every validating
 * entry path: the CLI's `--validate-on-load` file load, `addFixturesFromJSON`
 * and `POST /__aimock/fixtures`. `on()` is deliberately not in the triple: it
 * has never validated and must not start throwing (raw-no-regression.test.ts).
 */
describe("raw fixtures: validation parity across entry paths", () => {
  const CLI_PATH = resolve(__dirname, "../../dist/cli.js");
  const SOURCES = ["../fixture-loader.ts", "../raw-validation.ts", "../helpers.ts"].map((s) =>
    resolve(__dirname, s),
  );

  /** The built CLI is a different program when older than the sources it bundles. */
  function assertBuiltCliIsCurrent(): void {
    const builtAt = statSync(CLI_PATH).mtimeMs;
    for (const source of SOURCES) {
      if (builtAt < statSync(source).mtimeMs) {
        throw new Error(`dist/cli.js is older than ${source}: run \`pnpm build\` first`);
      }
    }
  }

  const VALID: [string, Record<string, unknown>][] = [
    ["openai-chat json", { wire: "openai-chat", json: { ok: true } }],
    [
      "anthropic events + headers",
      { wire: "anthropic", events: [{ type: "message_stop" }], headers: { "request-id": "r1" } },
    ],
    [
      "bedrock-converse events + status",
      { wire: "bedrock-converse", events: [{ messageStop: {} }], json: {}, status: 429 },
    ],
  ];
  const INVALID: [string, Record<string, unknown>, string][] = [
    [
      "forbidden content-length header",
      { wire: "openai-chat", json: {}, headers: { "content-length": "5" } },
      'raw.headers["content-length"] is not allowed: aimock frames the body and sets this header itself',
    ],
    [
      "status 99",
      { wire: "openai-chat", json: {}, status: 99 },
      "raw.status must be an integer from 200 to 599; got 99",
    ],
    [
      "done on cohere",
      { wire: "cohere", events: [{ type: "message-end" }], done: true },
      "raw.done applies only to openai-chat (the only wire with a [DONE] terminal), not cohere",
    ],
  ];

  function entries(raw: Record<string, unknown>): FixtureFileEntry[] {
    return JSON.parse(JSON.stringify([{ match: { userMessage: "parity" }, response: { raw } }]));
  }

  /** Error messages from the CLI's --validate-on-load (exit 1 + `Fixture N: msg` lines). */
  async function cliErrors(raw: Record<string, unknown>): Promise<string[]> {
    assertBuiltCliIsCurrent();
    const dir = mkdtempSync(join(tmpdir(), "aimock-raw-parity-"));
    try {
      const file = join(dir, "fixtures.json");
      writeFileSync(file, JSON.stringify({ fixtures: entries(raw) }));
      const { stderr, code } = await new Promise<{ stderr: string; code: number | null }>(
        (done) => {
          // A valid file starts a server: stop it once it is listening.
          const cp = execFile("node", [CLI_PATH, "-f", file, "-p", "0", "--validate-on-load"]);
          let err = "";
          let out = "";
          cp.stderr?.on("data", (d) => (err += d));
          cp.stdout?.on("data", (d) => {
            out += d;
            if (/listening on/i.test(out)) cp.kill("SIGTERM");
          });
          cp.on("close", (code) => done({ stderr: err, code }));
        },
      );
      const errors = [...stderr.matchAll(/Fixture 0: (.+)/g)].map((m) => m[1]);
      expect(code !== 1 || /Validation failed/.test(stderr)).toBe(true);
      return code === 1 ? errors : [];
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  function addFromJSONErrors(raw: Record<string, unknown>): string[] {
    try {
      new LLMock({ logLevel: "silent" }).addFixturesFromJSON(entries(raw));
      return [];
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      const details: { message: string }[] = JSON.parse(
        text.replace(/^Fixture validation failed: /, ""),
      );
      return details.map((d) => d.message);
    }
  }

  async function controlApiErrors(raw: Record<string, unknown>): Promise<string[]> {
    const mock = new LLMock({ port: 0, host: "127.0.0.1", logLevel: "silent" });
    await mock.start();
    try {
      const res = await fetch(`${mock.url}/__aimock/fixtures`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fixtures: entries(raw) }),
      });
      if (res.status === 200) return [];
      expect(res.status).toBe(400);
      const body = (await res.json()) as { details: { message: string }[] };
      return body.details.map((d) => d.message);
    } finally {
      await mock.stop();
    }
  }

  it.skipIf(!existsSync(CLI_PATH)).each(VALID)(
    "%s: accepted on all three paths",
    async (_label, raw) => {
      expect(await cliErrors(raw)).toEqual([]);
      expect(addFromJSONErrors(raw)).toEqual([]);
      expect(await controlApiErrors(raw)).toEqual([]);
    },
  );

  it.skipIf(!existsSync(CLI_PATH)).each(INVALID)(
    "%s: the same error on all three paths",
    async (_label, raw, message) => {
      expect(await cliErrors(raw)).toEqual([message]);
      expect(addFromJSONErrors(raw)).toEqual([message]);
      expect(await controlApiErrors(raw)).toEqual([message]);
    },
  );
});
