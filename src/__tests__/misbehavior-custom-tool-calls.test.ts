/**
 * #505 × #508 — model misbehavior faults with namespaced and custom tool calls.
 *
 * - OpenAI Responses (HTTP and WebSocket): a fault targets function calls
 *   only. Custom tool calls and namespaces pass through the faulted output
 *   unchanged, and the journal's served calls record a custom call's input.
 * - Every other wire: a fixture that would emit a custom tool call is never
 *   faulted; the wire's guard answers the coded aimock_unsupported_tool_call
 *   500, journaled with the request body and the matched fixture.
 * - Any wire: a malformed fixture tool call is never faulted either; the
 *   normal path answers the coded aimock_invalid_fixture_tool_call 500.
 * - Gemini Interactions' reasoning-only fault still carries an interaction id.
 *
 * Real surfaces: a real LLMock over HTTP and WebSocket.
 */
import { afterEach, describe, expect, it } from "vitest";
import { LLMock } from "../llmock.js";
import { validateFixtureMisbehavior } from "../misbehavior.js";
import type { Fixture } from "../types.js";
import { connectWebSocket } from "./ws-test-client.js";

let mock: LLMock | null = null;

afterEach(async () => {
  await mock?.stop();
  mock = null;
});

async function start(response: Record<string, unknown>): Promise<LLMock> {
  mock = new LLMock({ port: 0, logLevel: "silent" });
  // Deliberately loose: some cases carry malformed in-code tool calls.
  mock.addFixture({ match: { userMessage: "go" }, response } as unknown as Fixture);
  await mock.start();
  return mock;
}

async function post(m: LLMock, path: string, body: unknown, fault?: string) {
  const res = await fetch(m.url + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(fault ? { "X-AIMock-Misbehavior": fault } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  return { status: res.status, text: await res.text() };
}

type Item = Record<string, unknown>;

function responsesOutput(text: string, stream: boolean): Item[] {
  if (!stream) return (JSON.parse(text) as { output: Item[] }).output;
  const done = text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as Item)
    .find((event) => event.type === "response.completed" || event.type === "response.incomplete");
  expect(done, text).toBeDefined();
  return (done!.response as { output: Item[] }).output;
}

const weatherTool = {
  type: "function",
  name: "weather",
  parameters: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
};
const responsesBody = (stream: boolean) => ({
  model: "gpt-4o",
  input: "go",
  tools: [weatherTool],
  stream,
});
const chatBody = { model: "gpt-4o", messages: [{ role: "user", content: "go" }] };

const PATCH = "*** Begin Patch\n*** End Patch\n";
const mixedCalls = {
  toolCalls: [
    { type: "custom", name: "apply_patch", input: PATCH, id: "call_patch" },
    { name: "weather", arguments: '{"city":"Paris"}', id: "call_weather" },
    { name: "lookup", arguments: '{"q":"x"}', id: "call_lookup", namespace: "mcp__docs" },
  ],
};

describe("Responses HTTP: faults target function calls; custom and namespaced calls pass through", () => {
  it.each([false, true])("tool-args-invalid-json, stream=%s", async (stream) => {
    const m = await start(mixedCalls);
    const r = await post(m, "/v1/responses", responsesBody(stream), "tool-args-invalid-json");
    expect(r.status, r.text).toBe(200);
    const output = responsesOutput(r.text, stream);
    expect(output.map((item) => item.type)).toEqual([
      "custom_tool_call",
      "function_call",
      "function_call",
    ]);
    expect(output[0]).toMatchObject({ name: "apply_patch", input: PATCH, call_id: "call_patch" });
    // The first FUNCTION call is the target; its arguments are now invalid JSON.
    expect(output[1]).toMatchObject({ name: "weather", call_id: "call_weather" });
    expect(() => JSON.parse(output[1].arguments as string)).toThrow();
    expect(output[2]).toMatchObject({
      name: "lookup",
      namespace: "mcp__docs",
      arguments: '{"q":"x"}',
    });

    const summary = m.getLastRequest()?.response.misbehavior;
    expect(summary).toMatchObject({
      applied: true,
      fault: "tool-args-invalid-json",
      target: { tool: "weather", index: 1 },
    });
    expect(summary?.servedToolCalls?.[0]).toEqual({
      type: "custom",
      name: "apply_patch",
      arguments: PATCH,
      id: "call_patch",
    });
    expect(summary?.servedToolCalls?.[2]).toMatchObject({
      name: "lookup",
      namespace: "mcp__docs",
    });
  });

  it("ordered blocks keep a customToolCall block unchanged under tool-unknown-name", async () => {
    const m = await start({
      blocks: [
        { type: "text", text: "Patching." },
        { type: "customToolCall", name: "apply_patch", input: PATCH },
        { type: "toolCall", name: "weather", arguments: '{"city":"Paris"}' },
      ],
    });
    const r = await post(m, "/v1/responses", responsesBody(false), "tool-unknown-name");
    expect(r.status, r.text).toBe(200);
    const output = responsesOutput(r.text, false);
    expect(output.map((item) => item.type)).toEqual([
      "message",
      "custom_tool_call",
      "function_call",
    ]);
    expect(output[1]).toMatchObject({ name: "apply_patch", input: PATCH });
    expect(output[2]).toMatchObject({ name: "weather_v2", arguments: '{"city":"Paris"}' });
  });

  // tool-call-id-duplicate copies the source's id onto the next FUNCTION call;
  // a custom call is never the destination. With one function call, a copy of
  // it is inserted right after it, as for a response with a single call.
  const fnA = { name: "weather", arguments: '{"city":"Paris"}', id: "call_a" };
  const fnB = { name: "lookup", arguments: '{"q":"x"}', id: "call_b" };
  const customC = { type: "custom", name: "apply_patch", input: PATCH, id: "call_patch" };
  const fnANoId = { name: fnA.name, arguments: fnA.arguments };
  it.each([
    ["[A,C,B]", [fnA, customC, fnB], "tool-call-id-duplicate", ["call_a", "call_patch", "call_a"]],
    [
      "[A,B,C] tool=lookup",
      [fnA, fnB, customC],
      "tool-call-id-duplicate; tool=lookup",
      ["call_b", "call_b", "call_patch"],
    ],
    [
      "[A,C] one function",
      [fnA, customC],
      "tool-call-id-duplicate",
      ["call_a", "call_a", "call_patch"],
    ],
    [
      "[A no id,C] one function",
      [fnANoId, customC],
      "tool-call-id-duplicate",
      ["*", "*", "call_patch"],
    ],
  ] as const)(
    "tool-call-id-duplicate never rewrites a custom call's id: %s",
    async (_label, toolCalls, fault, ids) => {
      for (const stream of [false, true]) {
        const m = await start({ toolCalls });
        const r = await post(m, "/v1/responses", responsesBody(stream), fault);
        expect(r.status, r.text).toBe(200);
        const output = responsesOutput(r.text, stream);
        const callIds = output.map((item) => item.call_id as string);
        const custom = output.filter((item) => item.type === "custom_tool_call");
        expect(custom, r.text).toHaveLength(1);
        expect(custom[0]).toMatchObject({
          name: "apply_patch",
          input: PATCH,
          call_id: "call_patch",
        });
        if (ids[0] === "*") {
          // Generated source id: the inserted copy shares it; the custom id stays.
          expect(callIds[1]).toBe(callIds[0]);
          expect(callIds[2]).toBe("call_patch");
        } else {
          expect(callIds).toEqual(ids);
        }
        const served = m.getLastRequest()?.response.misbehavior?.servedToolCalls ?? [];
        expect(served.filter((call) => call.type === "custom")).toEqual([
          { type: "custom", name: "apply_patch", arguments: PATCH, id: "call_patch" },
        ]);
        await m.stop();
        mock = null;
      }
    },
  );

  it("tool-call-id-duplicate with ordered blocks inserts the copy after its source", async () => {
    const m = await start({
      blocks: [
        { type: "toolCall", name: "weather", arguments: '{"city":"Paris"}', id: "call_a" },
        { type: "text", text: "Patching." },
        { type: "customToolCall", name: "apply_patch", input: PATCH, id: "call_patch" },
      ],
    });
    const r = await post(m, "/v1/responses", responsesBody(false), "tool-call-id-duplicate");
    expect(r.status, r.text).toBe(200);
    const output = responsesOutput(r.text, false);
    expect(output.map((item) => [item.type, item.call_id])).toEqual([
      ["function_call", "call_a"],
      ["function_call", "call_a"],
      ["message", undefined],
      ["custom_tool_call", "call_patch"],
    ]);
  });

  it("a tool fault naming a custom tool call is not applicable", async () => {
    const m = await start(mixedCalls);
    const r = await post(
      m,
      "/v1/responses",
      responsesBody(false),
      "tool-args-invalid-json; tool=apply_patch",
    );
    expect(r.status, r.text).toBe(501);
    expect(JSON.parse(r.text).error.code).toBe("aimock_misbehavior_not_applicable");
  });

  // The output-clearing faults accept tool=<name>; a custom call is never selected.
  const clearingFaults = ["empty-response", "refusal", "content-filter", "reasoning-only"] as const;
  const customAndFunction = { toolCalls: mixedCalls.toolCalls.slice(0, 2) };

  it.each(clearingFaults)(
    "%s with tool=<custom name> is not applicable and keeps the custom call",
    async (fault) => {
      for (const stream of [false, true]) {
        const m = await start(customAndFunction);
        // Explicit header: the coded not-applicable error, as for any not-applicable fault.
        const explicit = await post(
          m,
          "/v1/responses",
          responsesBody(stream),
          `${fault}; tool=apply_patch`,
        );
        expect(explicit.status, explicit.text).toBe(501);
        expect(JSON.parse(explicit.text).error.code).toBe("aimock_misbehavior_not_applicable");
        expect(m.getLastRequest()?.response.misbehavior).toMatchObject({
          applied: false,
          fault,
          reason: "not-applicable",
          detail: "Target tool call is a custom tool call",
        });

        // Runtime config: skipped, and the fixture is served unchanged.
        m.setMisbehavior({ faults: [{ fault, tool: "apply_patch" }] });
        const r = await post(m, "/v1/responses", responsesBody(stream));
        expect(r.status, r.text).toBe(200);
        const output = responsesOutput(r.text, stream);
        expect(output.map((item) => item.type)).toEqual(["custom_tool_call", "function_call"]);
        expect(output[0]).toMatchObject({
          name: "apply_patch",
          input: PATCH,
          call_id: "call_patch",
        });
        expect(output[1]).toMatchObject({ name: "weather", arguments: '{"city":"Paris"}' });
        expect(m.getLastRequest()?.response.misbehavior).toMatchObject({
          applied: false,
          fault,
          reason: "not-applicable",
          detail: "Target tool call is a custom tool call",
        });
        await m.stop();
        mock = null;
      }
    },
  );

  it.each(clearingFaults)("%s with tool=<function name> still applies", async (fault) => {
    for (const stream of [false, true]) {
      const m = await start(customAndFunction);
      const r = await post(m, "/v1/responses", responsesBody(stream), `${fault}; tool=weather`);
      expect(r.status, r.text).toBe(200);
      const output = responsesOutput(r.text, stream);
      expect(output.some((item) => item.type === "custom_tool_call")).toBe(false);
      expect(output.some((item) => item.type === "function_call")).toBe(false);
      expect(m.getLastRequest()?.response.misbehavior).toMatchObject({ applied: true, fault });
      await m.stop();
      mock = null;
    }
  });

  it.each(clearingFaults)("a fixture %s with tool=<custom name> fails validation", (fault) => {
    const fixture = {
      match: { userMessage: "go" },
      response: customAndFunction,
      misbehavior: { faults: [{ fault, tool: "apply_patch" }] },
    } as unknown as Fixture;
    expect(validateFixtureMisbehavior(fixture)?.rule).toBe("misbehavior/not-applicable");
    const functionFixture = {
      ...fixture,
      misbehavior: { faults: [{ fault, tool: "weather" }] },
    } as unknown as Fixture;
    expect(validateFixtureMisbehavior(functionFixture)).toBeUndefined();
  });

  // stop-length-mid-tool cuts the first FUNCTION call. A custom call before the
  // cut is emitted whole and completed; custom calls after the cut are dropped.
  it.each([false, true])(
    "stop-length-mid-tool cuts the function call, never a custom call, stream=%s",
    async (stream) => {
      const grep = { type: "custom", name: "grep", input: "needle", id: "call_grep" };
      const m = await start({ toolCalls: [...mixedCalls.toolCalls.slice(0, 2), grep] });
      const r = await post(m, "/v1/responses", responsesBody(stream), "stop-length-mid-tool");
      expect(r.status, r.text).toBe(200);
      const body = stream
        ? (r.text
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => JSON.parse(line.slice(6)) as Item)
            .find((event) => event.type === "response.incomplete")?.response as Item)
        : (JSON.parse(r.text) as Item);
      expect(body, r.text).toMatchObject({ status: "incomplete" });
      const output = body.output as Item[];
      expect(output.map((item) => [item.type, item.status])).toEqual([
        ["custom_tool_call", "completed"],
        ["function_call", "incomplete"],
      ]);
      expect(output[0]).toMatchObject({ name: "apply_patch", input: PATCH, call_id: "call_patch" });
      expect(output[1]).toMatchObject({ name: "weather", call_id: "call_weather" });
      expect('{"city":"Paris"}'.startsWith(output[1].arguments as string)).toBe(true);
      expect((output[1].arguments as string).length).toBeLessThan('{"city":"Paris"}'.length);
      expect(m.getLastRequest()?.response.misbehavior).toMatchObject({
        applied: true,
        fault: "stop-length-mid-tool",
        target: { tool: "weather", index: 1 },
      });
    },
  );

  it("stop-length-mid-tool with only custom calls is not applicable", async () => {
    const m = await start({ toolCalls: [mixedCalls.toolCalls[0]] });
    const r = await post(m, "/v1/responses", responsesBody(false), "stop-length-mid-tool");
    expect(r.status, r.text).toBe(501);
    expect(JSON.parse(r.text).error.code).toBe("aimock_misbehavior_not_applicable");
  });

  it("a malformed custom call is a coded fixture error, not a faulted response", async () => {
    const m = await start({
      toolCalls: [
        { type: "custom", name: "apply_patch", input: 5 },
        { name: "weather", arguments: '{"city":"Paris"}' },
      ],
    });
    const r = await post(m, "/v1/responses", responsesBody(false), "tool-args-invalid-json");
    expect(r.status, r.text).toBe(500);
    expect(JSON.parse(r.text).error.code).toBe("aimock_invalid_fixture_tool_call");
    expect(m.getRequests()).toHaveLength(1);
    const entry = m.getLastRequest();
    expect(entry?.body).not.toBeNull();
    expect(entry?.response.fixture).not.toBeNull();
    expect(entry?.response.status).toBe(500);
    expect(entry?.response.misbehavior).toBeUndefined();
  });
});

describe("Responses: a schema-violation fault uses the called namespace's schema", () => {
  const props = { q: { type: "string" }, limit: { type: "integer" } };
  const requiresBoth = { type: "object", properties: props, required: ["q", "limit"] };
  const requiresLimit = { type: "object", properties: props, required: ["limit"] };
  const lookupIn = (namespace: string, parameters: object) => ({
    type: "namespace",
    name: namespace,
    tools: [{ type: "function", name: "lookup", parameters }],
  });
  const lookupCall = (namespace?: string) => ({
    toolCalls: [
      {
        name: "lookup",
        arguments: '{"q":"x","limit":1}',
        id: "call_lookup",
        ...(namespace !== undefined ? { namespace } : {}),
      },
    ],
  });
  const FAULT = "tool-args-schema-violation; violation=missing-required";

  async function served(response: Record<string, unknown>, tools: unknown[], stream: boolean) {
    const m = await start(response);
    const r = await post(
      m,
      "/v1/responses",
      { model: "gpt-4o", input: "go", tools, stream },
      FAULT,
    );
    expect(r.status, r.text).toBe(200);
    const call = responsesOutput(r.text, stream).find((item) => item.type === "function_call");
    return {
      call: call!,
      args: JSON.parse(call!.arguments as string) as Record<string, unknown>,
      summary: m.getLastRequest()?.response.misbehavior,
    };
  }

  it.each([false, true])(
    "namespace b's lookup loses b's required property, not a's, stream=%s",
    async (stream) => {
      const tools = [lookupIn("a", requiresBoth), lookupIn("b", requiresLimit)];
      const { call, args, summary } = await served(lookupCall("b"), tools, stream);
      expect(call).toMatchObject({ name: "lookup", namespace: "b" });
      expect(summary).toMatchObject({ applied: true, detail: "missing-required" });
      // The served arguments must violate b's schema, which requires only `limit`.
      expect(args).toEqual({ q: "x" });
    },
  );

  it("a non-namespaced call uses the top-level tool, not a namespaced one", async () => {
    const tools = [
      lookupIn("a", requiresBoth),
      { type: "function", name: "lookup", parameters: requiresLimit },
    ];
    const { call, args, summary } = await served(lookupCall(), tools, false);
    expect(call.namespace).toBeUndefined();
    expect(summary).toMatchObject({ applied: true, detail: "missing-required" });
    expect(args).toEqual({ q: "x" });
  });

  it("a namespace with no offered lookup takes the no-schema path", async () => {
    const m = await start(lookupCall("c"));
    const tools = [lookupIn("a", requiresBoth), lookupIn("b", requiresLimit)];
    const r = await post(m, "/v1/responses", { model: "gpt-4o", input: "go", tools }, FAULT);
    expect(r.status, r.text).toBe(501);
    const error = JSON.parse(r.text).error;
    expect(error.code).toBe("aimock_misbehavior_not_applicable");
    expect(error.message).toContain("Target tool has no direct schema");
  });

  it("control: a lone top-level lookup still loses its first required property", async () => {
    const tools = [{ type: "function", name: "lookup", parameters: requiresBoth }];
    const { args, summary } = await served(lookupCall(), tools, false);
    expect(summary).toMatchObject({ applied: true, detail: "missing-required" });
    expect(args).toEqual({ limit: 1 });
  });
});

describe("Responses WebSocket: a server fault keeps custom and namespaced calls", () => {
  it("tool-args-invalid-json", async () => {
    const m = await start(mixedCalls);
    m.setMisbehavior({ faults: [{ fault: "tool-args-invalid-json" }] });
    const client = await connectWebSocket(m.url, "/v1/responses");
    let messages: string[] = [];
    try {
      client.send(
        JSON.stringify({ type: "response.create", model: "gpt-4o", input: "go", tools: [] }),
      );
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        messages = client.getMessages();
        if (messages.some((x) => /"response\.completed"|"type":"error"/.test(x))) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      client.close();
    }
    const done = messages
      .map((x) => JSON.parse(x) as Item)
      .find((event) => event.type === "response.completed");
    expect(done, messages.join("\n")).toBeDefined();
    const output = (done!.response as { output: Item[] }).output;
    expect(output[0]).toMatchObject({ type: "custom_tool_call", input: PATCH });
    expect(() => JSON.parse(output[1].arguments as string)).toThrow();
    expect(output[2]).toMatchObject({ type: "function_call", namespace: "mcp__docs" });
    expect(m.getLastRequest()?.response.misbehavior).toMatchObject({ applied: true });
  });
});

describe("non-Responses wires: fixture tool-call errors win over faults", () => {
  it.each(["empty-response", "tool-args-invalid-json"])(
    "Chat Completions: a custom call under %s is aimock_unsupported_tool_call",
    async (fault) => {
      const m = await start(mixedCalls);
      const r = await post(m, "/v1/chat/completions", chatBody, fault);
      expect(r.status, r.text).toBe(500);
      expect(JSON.parse(r.text).error.code).toBe("aimock_unsupported_tool_call");
      expect(m.getRequests()).toHaveLength(1);
      const entry = m.getLastRequest();
      expect(entry?.body).not.toBeNull();
      expect(entry?.response.fixture).not.toBeNull();
      expect(entry?.response.misbehavior).toBeUndefined();
    },
  );

  it("Anthropic Messages: a custom call under a fault is aimock_unsupported_tool_call", async () => {
    const m = await start(mixedCalls);
    const r = await post(
      m,
      "/v1/messages",
      { model: "claude-sonnet-4-5", max_tokens: 64, messages: [{ role: "user", content: "go" }] },
      "tool-unknown-name",
    );
    expect(r.status, r.text).toBe(500);
    expect(JSON.parse(r.text).error.code).toBe("aimock_unsupported_tool_call");
  });

  // Ordered blocks are authoritative: a customToolCall BLOCK (not a legacy
  // toolCalls entry) must also reject the fixture before any fault applies.
  const customBlocks = {
    blocks: [
      { type: "text", text: "Patching." },
      { type: "customToolCall", name: "apply_patch", input: PATCH, id: "call_patch" },
      { type: "toolCall", name: "weather", arguments: '{"city":"Paris"}', id: "call_weather" },
    ],
  };
  const anthropicBody = {
    model: "claude-sonnet-4-5",
    max_tokens: 64,
    messages: [{ role: "user", content: "go" }],
  };
  it.each([
    ["Chat Completions", "empty-response", "/v1/chat/completions", chatBody],
    ["Chat Completions", "tool-args-invalid-json", "/v1/chat/completions", chatBody],
    ["Chat Completions", "tool-unknown-name", "/v1/chat/completions", chatBody],
    ["Anthropic Messages", "tool-unknown-name", "/v1/messages", anthropicBody],
    ["Anthropic Messages", "tool-args-invalid-json", "/v1/messages", anthropicBody],
  ] as const)(
    "%s: a customToolCall block under %s is aimock_unsupported_tool_call",
    async (_wire, fault, path, body) => {
      const m = await start(customBlocks);
      const r = await post(m, path, body, fault);
      expect(r.status, r.text).toBe(500);
      expect(JSON.parse(r.text).error.code).toBe("aimock_unsupported_tool_call");
      expect(m.getRequests()).toHaveLength(1);
      const entry = m.getLastRequest();
      expect(entry?.body).not.toBeNull();
      expect(entry?.response.fixture).not.toBeNull();
      expect(entry?.response.status).toBe(500);
      expect(entry?.response.misbehavior).toBeUndefined();
    },
  );

  it("Chat Completions: function-only blocks beside a custom legacy toolCall are still faulted", async () => {
    const m = await start({
      toolCalls: [{ type: "custom", name: "apply_patch", input: PATCH }],
      blocks: [{ type: "toolCall", name: "weather", arguments: '{"city":"Paris"}' }],
    });
    const r = await post(m, "/v1/chat/completions", chatBody, "tool-unknown-name");
    expect(r.status, r.text).toBe(200);
    expect(r.text).toContain("weather_v2");
    expect(m.getLastRequest()?.response.misbehavior).toMatchObject({ applied: true });
  });

  it("Chat Completions: a malformed function call is aimock_invalid_fixture_tool_call", async () => {
    const m = await start({
      toolCalls: [{ name: "weather", arguments: '{"city":"Paris"}', namespace: "" }],
    });
    const r = await post(m, "/v1/chat/completions", chatBody, "tool-unknown-name");
    expect(r.status, r.text).toBe(500);
    expect(JSON.parse(r.text).error.code).toBe("aimock_invalid_fixture_tool_call");
    expect(m.getRequests()).toHaveLength(1);
    const entry = m.getLastRequest();
    expect(entry?.body).not.toBeNull();
    expect(entry?.response.fixture).not.toBeNull();
  });
});

describe("Gemini Interactions reasoning-only", () => {
  it.each([false, true])("carries an interaction id, stream=%s", async (stream) => {
    const m = await start({ content: "Before.", toolCalls: [mixedCalls.toolCalls[1]] });
    const r = await post(
      m,
      "/v1beta/interactions",
      { model: "gemini-2.5-flash", input: "go", stream },
      "reasoning-only; reasoning=Thinking.",
    );
    expect(r.status, r.text).toBe(200);
    if (!stream) {
      expect(JSON.parse(r.text)).toMatchObject({ id: expect.any(String), status: "incomplete" });
    } else {
      const created = r.text
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)) as Item)
        .find((event) => event.event_type === "interaction.created");
      expect(created?.interaction).toMatchObject({ id: expect.any(String) });
    }
  });
});
