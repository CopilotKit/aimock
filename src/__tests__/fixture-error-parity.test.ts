/**
 * The same fixture mistake in the new Responses keys (`customToolCalls`,
 * `responsesBlocks`) produces the same coded error whichever transport
 * carries it (HTTP non-streaming, HTTP streaming, WebSocket). Fixtures that
 * 1.44.0 accepted or rejected (legacy `toolCalls` / `blocks`) keep the 1.44.0
 * status and message. Serving the new keys needs responsesTools "extended".
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

let mock: LLMock | undefined;

afterEach(async () => {
  await mock?.stop();
  mock = undefined;
});

async function start(fixtures: Fixture[], responsesTools?: "legacy" | "extended"): Promise<LLMock> {
  mock = new LLMock({ port: 0, logLevel: "silent", responsesTools });
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

describe("malformed responsesBlocks tool blocks carry aimock_invalid_fixture_tool_call", () => {
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
    const m = await start(
      [
        {
          match: {},
          response: { responsesBlocks: [{ type: "text", text: "hi" }, block] },
        } as Fixture,
      ],
      "extended",
    );
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

  it("a malformed legacy blocks entry keeps the 1.44.0 uncoded error on every wire", async () => {
    const m = await start([
      { match: {}, response: { blocks: [{ type: "toolCall", arguments: "{}" }] } } as Fixture,
    ]);
    const message =
      'Invalid fixture block at index 0: "toolCall" block requires a string "name" field';
    for (const stream of [false, true]) {
      for (const [path, body] of [
        ["/v1/chat/completions", CHAT],
        ["/v1/responses", RESPONSES],
      ] as const) {
        const r = await post(m, path, { ...body, stream });
        expect(r.status, r.text).toBe(500);
        expect(errorOf(r.text)).toEqual({ message, type: "server_error" });
      }
    }
  });

  it.each([
    ["a stray input", { type: "toolCall", name: "f", arguments: "{}", input: "zz" }],
    ["an empty namespace", { type: "toolCall", name: "f", arguments: "{}", namespace: "" }],
  ])("a legacy toolCall block with %s serves, as 1.44.0", async (_l, block) => {
    const m = await start([
      { match: {}, response: { blocks: [{ type: "text", text: "hi" }, block] } } as Fixture,
    ]);
    for (const stream of [false, true]) {
      expect((await post(m, "/v1/responses", { ...RESPONSES, stream })).status).toBe(200);
      expect((await post(m, "/v1/chat/completions", { ...CHAT, stream })).status).toBe(200);
    }
    const ev = await wsFirstEvent(m, RESPONSES);
    expect(ev.type).toBe("response.created");
  });

  it("a customToolCall block in legacy blocks keeps the 1.44.0 unknown-type error", async () => {
    const m = await start([
      {
        match: {},
        response: {
          blocks: [
            { type: "text", text: "hi" },
            { type: "customToolCall", name: "p", input: "x" },
          ],
        },
      } as Fixture,
    ]);
    const message =
      'Invalid fixture block at index 1: unknown type "customToolCall" (expected "text" or "toolCall")';
    for (const stream of [false, true]) {
      for (const [path, body] of [
        ["/v1/chat/completions", CHAT],
        ["/v1/responses", RESPONSES],
      ] as const) {
        const r = await post(m, path, { ...body, stream });
        expect(r.status, r.text).toBe(500);
        expect(errorOf(r.text)).toEqual({ message, type: "server_error" });
      }
    }
  });
});

describe("a custom call on a non-Responses wire is unsupported before its fields are checked", () => {
  it.each([
    [
      "customToolCalls entry",
      { toolCalls: [], customToolCalls: [{ name: "x", input: "a", namespace: "" }] },
    ],
    [
      "customToolCall responsesBlock",
      { responsesBlocks: [{ type: "customToolCall", name: "x", namespace: "" }] },
    ],
  ])("%s with a bad namespace answers aimock_unsupported_tool_call", async (_id, response) => {
    const m = await start([{ match: {}, response } as Fixture], "extended");
    for (const stream of [false, true]) {
      const r = await post(m, "/v1/chat/completions", { ...CHAT, stream });
      expect(r.status, r.text).toBe(500);
      expect(errorOf(r.text).code, r.text).toBe("aimock_unsupported_tool_call");
    }
  });
});

describe("malformed nested Responses tool lists are dropped, not rejected (1.44.0 ignored them)", () => {
  const cases: Array<{ id: string; extra: Record<string, unknown>; message?: string }> = [
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

  it.each(cases)(
    "$id: 200 on HTTP (both modes) and WS, in either responsesTools mode",
    async ({ extra }) => {
      for (const responsesTools of ["legacy", "extended"] as const) {
        mock = new LLMock({ port: 0, logLevel: "silent", responsesTools });
        mock.addFixture({ match: {}, response: { content: "ok" } });
        await mock.start();
        const m = mock;
        for (const stream of [false, true]) {
          const r = await post(m, "/v1/responses", { ...RESPONSES, ...extra, stream });
          expect(r.status, r.text).toBe(200);
        }
        const ev = await wsFirstEvent(m, { ...RESPONSES, ...extra });
        expect(ev.type).toBe("response.created");
        expect(m.getLastRequest()?.response.status).toBe(200);
        await m.stop();
        mock = undefined;
      }
    },
  );

  it("a top-level null tool or non-array tools stays a 400 on HTTP, as 1.44.0", async () => {
    const m = await start([{ match: {}, response: { content: "ok" } }]);
    for (const [extra, message] of [
      [{ tools: [null] }, "tools entries must not be null"],
      [{ tools: { a: 1 } }, "tools must be an array"],
    ] as const) {
      const r = await post(m, "/v1/responses", { ...RESPONSES, ...extra });
      expect(r.status, r.text).toBe(400);
      expect(errorOf(r.text)).toEqual({ type: "invalid_request_error", message });
    }
  });
});

describe("custom_tool_call.input in request history (responsesTools extended)", () => {
  it("a non-string input reaches predicates as a string", async () => {
    mock = new LLMock({ port: 0, logLevel: "silent", responsesTools: "extended" });
    for (const f of [
      {
        match: {
          predicate: (req: { messages: Array<{ custom_tool_calls?: Array<{ input: string }> }> }) =>
            req.messages.some((msg) =>
              msg.custom_tool_calls?.some((tc) => tc.input.includes("PATCH")),
            ),
        },
        response: { content: "matched" },
      },
      { match: {}, response: { content: "fallback" } },
    ] as Fixture[])
      mock.addFixture(f);
    await mock.start();
    const m = mock;
    const input = [
      { role: "user", content: "go" },
      { type: "custom_tool_call", call_id: "c1", name: "apply_patch", input: { a: 1 } },
      { type: "custom_tool_call_output", call_id: "c1", output: "done" },
    ];
    const r = await post(m, "/v1/responses", { model: "gpt-5", input });
    expect(r.status, r.text).toBe(200);
    expect(r.text).toContain("fallback");
    const body = m.getLastRequest()?.body as {
      messages: Array<{ custom_tool_calls?: Array<{ input: unknown }> }>;
    };
    const call = body.messages.find((msg) => msg.custom_tool_calls)?.custom_tool_calls?.[0];
    expect(call?.input).toBe("");
  });
});

describe("load-time warning for custom calls on a non-chat endpoint (responsesTools extended)", () => {
  it.each([
    ["customToolCalls", { toolCalls: [], customToolCalls: [{ name: "apply_patch", input: "x" }] }],
    [
      "responsesBlocks",
      { responsesBlocks: [{ type: "customToolCall", name: "apply_patch", input: "x" }] },
    ],
  ])("%s with endpoint embedding warns", (id, response) => {
    const f = entryToFixture({
      match: { userMessage: "go", endpoint: "embedding" },
      response,
    } as FixtureFileEntry);
    markFixtureResponsesToolsExtended(f);
    const warnings = validateFixtures([f]).filter((r) => r.severity === "warning");
    // The text must hold for every non-chat endpoint: media handlers answer an
    // uncoded 500 shape error, Realtime sends an error event, and openai-live
    // rejects the fixture at load. So it names no status code or error code.
    expect(warnings.map((w) => w.message)).toEqual([
      `${id}[0] is a custom tool call, which only OpenAI Responses requests (endpoint "chat") can carry — endpoint "embedding" never serves it, so a request that matches this fixture gets an error instead`,
    ]);
  });

  it("a 1.44.0 typed toolCalls entry on a non-chat endpoint gets no new warning", () => {
    const f = entryToFixture({
      match: { userMessage: "go", endpoint: "image" },
      response: { toolCalls: [{ type: "custom", name: "apply_patch", arguments: "{}" }] },
    } as FixtureFileEntry);
    const messages = validateFixtures([f]).map((w) => w.message);
    expect(messages.filter((m) => m.includes("is a custom tool call"))).toEqual([]);
  });

  it("endpoint chat and an absent endpoint do not warn", () => {
    for (const endpoint of ["chat", undefined]) {
      const f = entryToFixture({
        match: { userMessage: "go", ...(endpoint ? { endpoint } : {}) },
        response: { toolCalls: [], customToolCalls: [{ name: "apply_patch", input: "x" }] },
      } as FixtureFileEntry);
      markFixtureResponsesToolsExtended(f);
      expect(validateFixtures([f]).filter((r) => r.severity === "warning")).toEqual([]);
    }
  });
});

describe("Ollama /api/generate keeps the 1.44.0 handling of blocks", () => {
  // /api/generate serves only text fixtures. A text fixture (string content,
  // no toolCalls) is served as text and its blocks are not read there, as in
  // 1.44.0; a blocks-only fixture is a tool-call fixture rejected with a 400.
  it.each([
    [
      "a customToolCall block",
      [
        { type: "text", text: "hi" },
        { type: "customToolCall", name: "p", input: "x" },
      ],
    ],
    ["a misspelled block type", [{ type: "toolcall", name: "f", arguments: "{}" }]],
    ["a toolCall block", [{ type: "toolCall", name: "f", arguments: "{}" }]],
  ])("content plus %s serves the content as text", async (_l, blocks) => {
    const m = await start([{ match: {}, response: { content: "hi", blocks } } as Fixture]);
    for (const stream of [false, true]) {
      const r = await post(m, "/api/generate", { model: "llama3", prompt: "go", stream });
      expect(r.status, r.text).toBe(200);
      expect(r.text).toContain("hi");
    }
  });

  it("a blocks-only fixture is rejected as a tool-call fixture", async () => {
    const m = await start([
      {
        match: {},
        response: { blocks: [{ type: "toolCall", name: "f", arguments: "{}" }] },
      } as Fixture,
    ]);
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
    const m = await start(
      [
        {
          match: {},
          response: {
            toolCalls: [],
            customToolCalls: [{ type: "custom", name: "apply_patch", input: "x" }],
          },
        },
      ],
      "extended",
    );
    for (const stream of [false, true]) {
      const r = await post(m, "/api/v3/chat/completions", { ...CHAT, model: "doubao", stream });
      expect(r.status, r.text).toBe(500);
      expect(String(errorOf(r.text).message)).toContain(
        "this request arrived on BytePlus ModelArk Chat Completions",
      );
    }
  });
});
