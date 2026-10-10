/**
 * #505 — fixtures that worked before custom tool calls existed keep working.
 *
 * - Non-empty `blocks` are authoritative, so a fixture's legacy `toolCalls` is
 *   ignored whatever its shape (a `null` entry, a non-array value).
 * - A Gemini audio fixture with non-array companion `toolCalls` emits no tool
 *   parts.
 * - Function-call `toolCalls` entries that loaded before (legacy
 *   `type: "toolCall"`, any other `type`, a numeric `id`, a numeric `name`, a
 *   stray `input`) load with no finding at all and serve, through the control
 *   API, `addFixturesFromJSON` and programmatic fixtures alike.
 *
 * Real surfaces: a real LLMock over HTTP.
 */
import { afterEach, describe, expect, it } from "vitest";
import { entryToFixture, validateFixtures } from "../fixture-loader.js";
import { LLMock } from "../llmock.js";
import type {
  ContentWithToolCallsResponse,
  Fixture,
  FixtureBlock,
  FixtureFileEntry,
  ToolCall,
} from "../types.js";

let mock: LLMock | null = null;

afterEach(async () => {
  await mock?.stop();
  mock = null;
});

async function start(fixtures: Fixture[] = []): Promise<LLMock> {
  mock = new LLMock({ port: 0, logLevel: "silent" });
  for (const f of fixtures) mock.addFixture(f);
  await mock.start();
  return mock;
}

async function post(m: LLMock, path: string, body: unknown) {
  const res = await fetch(m.url + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

/** Build a `Fixture` from a deliberately malformed in-code response. */
function fixtureWith(response: Record<string, unknown>): Fixture {
  return { match: { userMessage: "go" }, response } as unknown as Fixture;
}

const chatMessages = [{ role: "user", content: "go" }];
const geminiBody = { contents: [{ role: "user", parts: [{ text: "go" }] }] };

const blockRoutes: Array<[string, string, Record<string, unknown>]> = [
  ["Chat Completions", "/v1/chat/completions", { model: "gpt-4o", messages: chatMessages }],
  [
    "Chat Completions stream",
    "/v1/chat/completions",
    { model: "gpt-4o", messages: chatMessages, stream: true },
  ],
  ["Messages", "/v1/messages", { model: "claude", max_tokens: 64, messages: chatMessages }],
  ["Ollama", "/api/chat", { model: "llama3", stream: false, messages: chatMessages }],
  ["Cohere", "/v2/chat", { model: "command-r", messages: chatMessages }],
  ["Bedrock InvokeModel", "/model/claude/invoke", { max_tokens: 64, messages: chatMessages }],
  [
    "Bedrock Converse",
    "/model/claude/converse",
    { messages: [{ role: "user", content: [{ text: "go" }] }] },
  ],
  ["Gemini", "/v1beta/models/gemini-2.0-flash:generateContent", geminiBody],
  [
    "Gemini Interactions",
    "/v1beta/interactions",
    { model: "gemini-2.5-flash", input: "go", stream: false },
  ],
];

describe("non-empty blocks ignore the legacy toolCalls whatever its shape", () => {
  const blocks = [{ type: "text", text: "BLOCK_TEXT" }];
  const shapes: Array<[string, Record<string, unknown>]> = [
    ["a null toolCalls entry", { content: "", toolCalls: [null], blocks }],
    ["a non-array toolCalls", { toolCalls: "nope", blocks }],
  ];
  for (const [shape, response] of shapes) {
    it.each(blockRoutes)(`${shape}: %s serves the blocks`, async (_wire, path, body) => {
      const m = await start([fixtureWith(response)]);
      const res = await post(m, path, body);
      expect(res.status).toBe(200);
      expect(res.text).toContain("BLOCK_TEXT");
      expect(m.getLastRequest()?.response.status).toBe(200);
    });
  }
});

describe("Gemini audio with a non-array companion toolCalls", () => {
  it("serves the audio with no tool parts", async () => {
    const m = await start([fixtureWith({ audio: "AAAA", toolCalls: {} })]);
    const res = await post(m, "/v1beta/models/gemini-2.0-flash:generateContent", geminiBody);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.text) as {
      candidates: Array<{
        content: { parts: Array<Record<string, unknown>> };
        finishReason: string;
      }>;
    };
    expect(body.candidates[0].finishReason).toBe("STOP");
    expect(body.candidates[0].content.parts.some((p) => "functionCall" in p)).toBe(false);
  });
});

const legacyEntries: Array<[string, Record<string, unknown>]> = [
  ['legacy type "toolCall"', { type: "toolCall", name: "lookup", arguments: '{"q":"x"}' }],
  ['unknown type "foo"', { type: "foo", name: "lookup", arguments: '{"q":"x"}' }],
  ['type "custom" with arguments', { type: "custom", name: "lookup", arguments: '{"q":"x"}' }],
  ["empty namespace", { name: "lookup", arguments: '{"q":"x"}', namespace: "" }],
  ["numeric id", { name: "lookup", arguments: '{"q":"x"}', id: 7 }],
  ["numeric name", { name: 5, arguments: '{"q":"x"}' }],
  ["input on a function call", { name: "lookup", arguments: '{"q":"x"}', input: "ignored" }],
];

const serveRoutes: Array<[string, string, Record<string, unknown>]> = [
  ["Chat Completions", "/v1/chat/completions", { model: "gpt-4o", messages: chatMessages }],
  ["Responses", "/v1/responses", { model: "gpt-4o", input: "go" }],
  ["Messages", "/v1/messages", { model: "claude", max_tokens: 64, messages: chatMessages }],
];

describe("function-call toolCalls entries that loaded before still load and serve", () => {
  it.each(legacyEntries)("%s: validation reports nothing, as 1.44.0", (_label, call) => {
    const entry = { match: { userMessage: "go" }, response: { toolCalls: [call] } };
    const issues = validateFixtures([entryToFixture(entry as unknown as FixtureFileEntry)]);
    expect(issues).toEqual([]);
  });

  it.each(legacyEntries)("%s: the control API adds it and it serves", async (_label, call) => {
    const m = await start();
    const added = await post(m, "/__aimock/fixtures", {
      fixtures: [{ match: { userMessage: "go" }, response: { toolCalls: [call] } }],
    });
    expect(added).toEqual({ status: 200, text: JSON.stringify({ added: 1 }) });
    for (const [, path, body] of serveRoutes) {
      const res = await post(m, path, body);
      expect(res.status).toBe(200);
    }
  });

  it.each(legacyEntries)("%s: addFixturesFromJSON accepts it", (_label, call) => {
    const m = new LLMock({ port: 0, logLevel: "silent" });
    expect(() =>
      m.addFixturesFromJSON([
        { match: { userMessage: "go" }, response: { toolCalls: [call] } } as FixtureFileEntry,
      ]),
    ).not.toThrow();
  });

  it.each(legacyEntries)("%s: a programmatic fixture serves", async (_label, call) => {
    const m = await start([fixtureWith({ toolCalls: [call] })]);
    for (const [, path, body] of serveRoutes) {
      const res = await post(m, path, body);
      expect(res.status).toBe(200);
    }
  });

  it("a legacy toolCall entry is served as a function call on Responses", async () => {
    const m = await start([
      fixtureWith({ toolCalls: [{ type: "toolCall", name: "lookup", arguments: "{}" }] }),
    ]);
    const res = await post(m, "/v1/responses", { model: "gpt-4o", input: "go" });
    const output = (JSON.parse(res.text) as { output: Array<Record<string, unknown>> }).output;
    expect(output.map((o) => [o.type, o.name])).toEqual([["function_call", "lookup"]]);
  });
});

describe("custom-shaped toolCalls entries get exactly the 1.44.0 findings", () => {
  // A toolCalls entry is a function call, so one without `arguments` fails
  // the arguments check, as it did in 1.44.0; nothing about `type`, `input`,
  // `id` or `namespace` is reported.
  const HINT = "to send invalid JSON on purpose, use `misbehavior: tool-args-invalid-json`";
  it.each([
    [{ type: "custom", name: "apply_patch", input: "x", id: 7 }],
    [{ type: "customToolCall", name: "apply_patch", input: "x" }],
  ])("%j", (call) => {
    const entry = { match: { userMessage: "go" }, response: { toolCalls: [call] } };
    const issues = validateFixtures([entryToFixture(entry as unknown as FixtureFileEntry)]);
    expect(issues.map((i) => [i.severity, i.message])).toEqual([
      ["error", `toolCalls[0].arguments is not valid JSON: undefined; ${HINT}`],
    ]);
  });
});

describe("TypeScript: a toolCall block is still assignable to a toolCalls entry", () => {
  it("compiles and serves the block-typed entry as a function call", async () => {
    const block: FixtureBlock = { type: "toolCall", name: "lookup", arguments: "{}", id: "c1" };
    const asCall: ToolCall = block;
    const response: ContentWithToolCallsResponse = {
      content: "hi",
      toolCalls: [asCall],
      blocks: [],
    };
    const m = await start([{ match: { userMessage: "go" }, response }]);
    const res = await post(m, "/v1/chat/completions", { model: "gpt-4o", messages: chatMessages });
    expect(res.status).toBe(200);
    expect(res.text).toContain('"name":"lookup"');
  });
});
