/**
 * #505 — Responses request-input handling of custom items and tools.
 *
 * Exercised through a real LLMock over HTTP (streaming and non-streaming) and
 * WebSocket:
 * - a malformed `custom_tool_call_output.output` never turns into a 500;
 * - an orphan `custom_tool_call_output` synthesizes a `custom` tool call;
 * - a WebSocket builder failure journals both status and message;
 * - malformed `tools` and namespace names are rejected the same way on both
 *   transports.
 */
import { afterEach, describe, expect, it } from "vitest";
import { LLMock } from "../llmock.js";
import type { ChatCompletionRequest, ChatMessage, Fixture, JournalEntry } from "../types.js";
import { connectWebSocket } from "./ws-test-client.js";

let mock: LLMock | null = null;
afterEach(async () => {
  await mock?.stop();
  mock = null;
});

async function start(fixtures: Fixture[]): Promise<LLMock> {
  mock = new LLMock({ port: 0, logLevel: "silent" });
  mock.addFixtures(fixtures);
  await mock.start();
  return mock;
}

async function post(m: LLMock, body: Record<string, unknown>, stream = false) {
  const res = await fetch(`${m.url}/v1/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-5", stream, ...body }),
  });
  return { status: res.status, text: await res.text() };
}

/**
 * Send one `response.create` over WebSocket and return every message received
 * up to and including the terminal `response.completed` or `error` event.
 * Throws if no terminal event arrives within 3s (inside the 5s test timeout), so a hung or
 * truncated turn fails the test instead of returning a partial transcript.
 */
async function wsPost(m: LLMock, body: Record<string, unknown>): Promise<string[]> {
  const client = await connectWebSocket(m.url, "/v1/responses");
  try {
    client.send(JSON.stringify({ type: "response.create", model: "gpt-5", ...body }));
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const msgs = client.getMessages();
      if (msgs.some((x) => /"type":"(response\.completed|error)"/.test(x))) return msgs;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(
      `WS turn did not reach response.completed or error within 3s; got ${JSON.stringify(client.getMessages())}`,
    );
  } finally {
    client.close();
  }
}

const USER = { role: "user", content: "hi" };

/** The converted messages journaled for a matched Responses request. */
function messagesOf(e: JournalEntry): ChatMessage[] {
  return (e.body as ChatCompletionRequest | null)?.messages ?? [];
}

function customRound(output: unknown) {
  return [
    USER,
    { type: "custom_tool_call", call_id: "c1", name: "apply_patch", input: "patch" },
    { type: "custom_tool_call_output", call_id: "c1", output },
  ];
}

describe("custom_tool_call_output with a malformed output", () => {
  const fixtures: Fixture[] = [
    { match: { toolResultContains: "kept" }, response: { content: "matched kept text" } },
    { match: { hasToolResult: true }, response: { content: "tool round" } },
  ];
  const malformed: Array<[string, unknown]> = [
    ["null", null],
    ["an object", { a: 1 }],
    ["a number", 5],
    ["an array containing null", [null, 7, { type: "input_text", text: 3 }]],
  ];

  for (const [label, output] of malformed) {
    it(`treats ${label} as empty text over HTTP (both modes) and WS, never a 500`, async () => {
      const m = await start(fixtures);
      for (const stream of [false, true]) {
        const r = await post(m, { input: customRound(output) }, stream);
        expect(r.status, r.text).toBe(200);
        expect(r.text).toContain("tool round");
      }
      const msgs = await wsPost(m, { input: customRound(output) });
      expect(msgs.join("\n")).toContain("tool round");
      expect(msgs.join("\n")).not.toContain('"type":"error"');
      const entries = m.getRequests();
      expect(entries).toHaveLength(3);
      for (const e of entries) {
        expect(e.response.status).toBe(200);
        const tool = messagesOf(e).find((msg) => msg.role === "tool");
        expect(tool?.content).toBe("");
      }
    });
  }

  it("keeps the input_text parts of an array that also holds null entries", async () => {
    const m = await start(fixtures);
    const output = [null, { type: "input_text", text: "kept" }, "junk"];
    const r = await post(m, { input: customRound(output) });
    expect(r.status, r.text).toBe(200);
    expect(r.text).toContain("matched kept text");
    expect((await wsPost(m, { input: customRound(output) })).join("\n")).toContain(
      "matched kept text",
    );
    const entries = m.getRequests();
    expect(entries).toHaveLength(2);
    for (const e of entries) {
      expect(messagesOf(e).find((msg) => msg.role === "tool")?.content).toBe("kept");
    }
  });
});

describe("orphan custom_tool_call_output", () => {
  it("synthesizes a custom tool call, not a function call", async () => {
    const m = await start([{ match: { hasToolResult: true }, response: { content: "ok" } }]);
    const input = [USER, { type: "custom_tool_call_output", call_id: "orph", output: "r" }];
    const r = await post(m, { input });
    expect(r.status, r.text).toBe(200);
    expect(r.text).toContain('"ok"');
    const ws = (await wsPost(m, { input })).join("\n");
    expect(ws).toContain('"response.completed"');
    expect(ws).toContain('"ok"');
    const entries = m.getRequests();
    expect(entries).toHaveLength(2);
    for (const e of entries) {
      expect(e.response.status).toBe(200);
      const assistant = messagesOf(e).find((msg) => msg.role === "assistant");
      expect(assistant?.tool_calls).toEqual([
        { id: "orph", type: "custom", function: { name: "", arguments: "" } },
      ]);
    }
  });

  it("upgrades an item_reference placeholder to a custom tool call", async () => {
    const m = await start([{ match: { hasToolResult: true }, response: { content: "ok" } }]);
    const input = [
      USER,
      { type: "item_reference", id: "ref1" },
      { type: "custom_tool_call_output", call_id: "c1", output: "r" },
      { type: "function_call_output", call_id: "f1", output: "r" },
    ];
    for (const stream of [false, true]) {
      const r = await post(m, { input }, stream);
      expect(r.status, r.text).toBe(200);
    }
    expect((await wsPost(m, { input })).join("\n")).toContain('"response.completed"');
    const entries = m.getRequests();
    expect(entries).toHaveLength(3);
    for (const e of entries) {
      const assistant = messagesOf(e).find((msg) => msg.role === "assistant");
      expect(assistant?.tool_calls?.map((tc) => [tc.id, tc.type])).toEqual([
        ["c1", "custom"],
        ["f1", "function"],
      ]);
    }
  });
});

describe("WebSocket builder failure journals status and message", () => {
  const bad = (content?: string): Fixture => ({
    match: { userMessage: "bad" },
    response: {
      ...(content !== undefined ? { content } : {}),
      toolCalls: [{ type: "custom", name: "apply_patch", input: 42 as unknown as string }],
    },
  });

  for (const [label, content] of [
    ["tool-only", undefined],
    ["content + tool calls", "hello"],
  ] as const) {
    it(`records the error message on a ${label} response`, async () => {
      const m = await start([bad(content)]);
      const msgs = await wsPost(m, { input: [{ role: "user", content: "bad" }] });
      const errors = msgs.map((x) => JSON.parse(x)).filter((e) => e.type === "error");
      expect(errors).toHaveLength(1);
      expect(errors[0]).toEqual({
        type: "error",
        error: {
          message: expect.stringMatching(/Invalid fixture tool call: "input" must be a string/),
          type: "server_error",
          code: "aimock_invalid_fixture_tool_call",
        },
      });
      expect(msgs.join("\n")).not.toContain('"response.completed"');
      const entries = m.getRequests();
      expect(entries).toHaveLength(1);
      expect(entries[0].response.status).toBe(500);
      expect(entries[0].response.error).toMatch(
        /Invalid fixture tool call: "input" must be a string/,
      );
    });
  }
});

describe("malformed tools are rejected consistently over HTTP and WS", () => {
  const fixtures: Fixture[] = [{ match: { userMessage: "hi" }, response: { content: "ok" } }];

  async function expectRejected(body: Record<string, unknown>, message: RegExp) {
    const m = await start(fixtures);
    for (const stream of [false, true]) {
      const r = await post(m, body, stream);
      expect(r.status, r.text).toBe(400);
      expect(JSON.parse(r.text).error).toMatchObject({ type: "invalid_request_error" });
      expect(JSON.parse(r.text).error.message).toMatch(message);
    }
    const msgs = await wsPost(m, body);
    expect(msgs).toHaveLength(1);
    const event = JSON.parse(msgs[0]);
    expect(event).toMatchObject({ type: "error", error: { type: "invalid_request_error" } });
    expect(event.error.message).toMatch(message);
    const entries = m.getRequests();
    expect(entries).toHaveLength(3);
    for (const e of entries) expect(e.response.status).toBe(400);
  }

  for (const tools of [{ type: "function", name: "f" }, "abc", 5]) {
    it(`rejects non-array tools ${JSON.stringify(tools)}`, async () => {
      await expectRejected({ input: [USER], tools }, /^tools must be an array$/);
    });
  }

  it("rejects null tools entries on WS as on HTTP", async () => {
    await expectRejected({ input: [USER], tools: [null] }, /^tools entries must not be null$/);
  });

  for (const [label, ns] of [
    ["missing", { type: "namespace", tools: [{ type: "function", name: "f" }] }],
    ["non-string", { type: "namespace", name: 7, tools: [{ type: "function", name: "f" }] }],
    ["empty", { type: "namespace", name: "", tools: [{ type: "function", name: "f" }] }],
  ] as const) {
    it(`rejects a namespace tool whose name is ${label}`, async () => {
      await expectRejected(
        { input: [USER], tools: [{ type: "function", name: "top" }, ns] },
        /^tools\[1\]\.name must be a non-empty string for a namespace tool$/,
      );
    });

    it(`rejects an additional_tools namespace whose name is ${label}`, async () => {
      await expectRejected(
        { input: [USER, { type: "additional_tools", tools: [ns] }] },
        /^input\[1\]\.tools\[0\]\.name must be a non-empty string for a namespace tool$/,
      );
    });
  }

  it("still accepts empty / absent tools and well-formed namespaces on both transports", async () => {
    const m = await start(fixtures);
    const ns = { type: "namespace", name: "mcp", tools: [{ type: "function", name: "f" }] };
    for (const body of [
      { input: [USER] },
      { input: [USER], tools: [] },
      { input: [USER], tools: [ns] },
      { input: [USER, { type: "additional_tools", tools: [ns] }] },
    ]) {
      expect((await post(m, body)).status).toBe(200);
      expect((await wsPost(m, body)).join("\n")).toContain('"response.completed"');
    }
  });
});

describe("tools loaded by a tool_search_output input item", () => {
  // Shape per OpenAPI ToolSearchOutputItemParam / ToolSearchOutputNamespaceToolParam:
  // Codex loads deferred MCP namespaces through this item.
  const GITHUB = {
    type: "namespace",
    name: "mcp__github",
    description: "GitHub MCP",
    tools: [{ type: "function", name: "list_issues", parameters: { type: "object" } }],
  };
  const searchRound = (tools: unknown[]) => [
    USER,
    { type: "tool_search_call", call_id: "ts1", execution: "client", arguments: { q: "gh" } },
    { type: "tool_search_output", call_id: "ts1", execution: "client", tools },
  ];
  const fixtures: Fixture[] = [
    {
      match: { toolName: "list_issues", toolNamespace: "mcp__github" },
      response: {
        toolCalls: [{ name: "list_issues", namespace: "mcp__github", arguments: "{}" }],
      },
    },
    { match: { userMessage: "hi" }, response: { content: "fell through" } },
  ];

  it("flattens its namespace tools so toolName + toolNamespace match over HTTP and WS", async () => {
    const m = await start(fixtures);
    const input = searchRound([GITHUB, { type: "web_search" }]);
    for (const stream of [false, true]) {
      const r = await post(m, { input }, stream);
      expect(r.status, r.text).toBe(200);
      expect(r.text).toContain('"namespace":"mcp__github"');
      expect(r.text).not.toContain("fell through");
    }
    const ws = (await wsPost(m, { input })).join("\n");
    expect(ws).toContain('"namespace":"mcp__github"');
    expect(ws).not.toContain("fell through");
    const entries = m.getRequests();
    expect(entries).toHaveLength(3);
    for (const e of entries) {
      expect(e.response.status).toBe(200);
      expect(e.body?.tools).toEqual([
        {
          type: "function",
          namespace: "mcp__github",
          function: { name: "list_issues", description: undefined, parameters: { type: "object" } },
        },
      ]);
      // No message is added for the item: the conversation is unchanged.
      expect(messagesOf(e)).toEqual([{ role: "user", content: "hi" }]);
    }
  });

  it("rejects a tool_search_output namespace without a name, like other tool sources", async () => {
    const m = await start(fixtures);
    const input = searchRound([{ ...GITHUB, name: "" }]);
    const message = "input[2].tools[0].name must be a non-empty string for a namespace tool";
    const r = await post(m, { input });
    expect(r.status).toBe(400);
    expect(JSON.parse(r.text).error).toEqual({ message, type: "invalid_request_error" });
    const msgs = await wsPost(m, { input });
    expect(msgs).toHaveLength(1);
    expect(JSON.parse(msgs[0])).toEqual({
      type: "error",
      error: { message, type: "invalid_request_error" },
    });
    const entries = m.getRequests();
    expect(entries).toHaveLength(2);
    for (const e of entries) expect(e.response.status).toBe(400);
  });
});
