import { afterEach, expect, test } from "vitest";
import { LLMock } from "../llmock.js";
import { validateToolsField } from "../helpers.js";

let mock: LLMock | undefined;
afterEach(async () => {
  await mock?.stop();
  mock = undefined;
});

const nested = [{ type: "function", function: { name: "f", parameters: {} } }];
const messages = [{ role: "user", content: "hello" }];

async function start() {
  mock = new LLMock({ port: 0 });
  mock.on({ toolName: "f", sequenceIndex: 0 }, { content: "first" });
  mock.on({ toolName: "f", sequenceIndex: 1 }, { content: "second" });
  mock.on({ userMessage: "hello" }, { content: "plain" });
  await mock.start();
  return mock;
}

async function post(
  server: LLMock,
  tools: unknown,
  stream = false,
  inputMessages: unknown = messages,
) {
  const response = await fetch(`${server.url}/api/chat`, {
    method: "POST",
    signal: AbortSignal.timeout(5_000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "llama3", messages: inputMessages, stream, tools }),
  });
  const text = await response.text();
  process.stdout.write(
    `${JSON.stringify({ tools, stream, status: response.status, body: text })}\n`,
  );
  return { status: response.status, text };
}

test.each([
  ["C02-string", "bad", "tools must be an array"],
  ["C02-null-entry", [null], "tools[0] must be an object"],
  ["C02-null-function", [{ type: "function", function: null }], "function"],
])("%s rejects malformed tools before consuming first fixture", async (_id, tools, error) => {
  const server = await start();
  const result = await post(server, tools);
  const first = await post(server, nested);
  const second = await post(server, nested);
  expect(first.status).toBe(200);
  expect(JSON.parse(first.text)).toMatchObject({ message: { content: "first" }, done: true });
  expect(JSON.parse(second.text)).toMatchObject({ message: { content: "second" }, done: true });
  expect(result.status).toBe(400);
  expect(result.text).toContain(error);
  expect(result.text).not.toContain("TypeError");
});

test.each([undefined, null, []])("control optional tools %j", async (tools) => {
  const result = await post(await start(), tools);
  expect(result.status).toBe(200);
  expect(JSON.parse(result.text)).toMatchObject({ message: { content: "plain" }, done: true });
});

function expectTextResponse(
  result: Awaited<ReturnType<typeof post>>,
  stream: boolean,
  content: string,
) {
  expect(result.status).toBe(200);
  if (stream) {
    const chunks = result.text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(chunks.map((chunk) => chunk.message.content).join("")).toBe(content);
    expect(chunks.at(-1)).toMatchObject({ done: true, done_reason: "stop" });
  } else {
    expect(JSON.parse(result.text)).toMatchObject({ message: { content }, done: true });
  }
}

const shorthandCases = [false, true].flatMap((stream) =>
  ["model", "tool"].map((matcher) => ({ stream, matcher })),
);

test.each(shorthandCases)(
  "missing function rejects before consuming $matcher fixture (stream=$stream)",
  async ({ stream, matcher }) => {
    const shorthand = [{ type: "function" }];
    expect(validateToolsField(shorthand)).toBeNull();
    const server = await start();
    server
      .clearFixtures()
      .on(
        matcher === "model"
          ? { model: "llama3", sequenceIndex: 0 }
          : { toolName: "f", sequenceIndex: 0 },
        { content: "sentinel" },
      );
    server.on({ model: "llama3" }, { content: "fallback" });
    const result = await post(server, shorthand, stream);
    expectTextResponse(await post(server, nested, stream), stream, "sentinel");
    expect(result.status).toBe(400);
    expect(JSON.parse(result.text)).toEqual({
      error: {
        message: "Invalid request: tools[0].function must be an object",
        type: "invalid_request_error",
      },
    });
  },
);

const toleratedFunctions = ["x", 1, false, []].flatMap((func) =>
  [false, true].map((stream) => ({ func, stream })),
);

test.each(toleratedFunctions)(
  "control non-null function $func remains accepted (stream=$stream)",
  async ({ func, stream }) => {
    const result = await post(await start(), [{ type: "function", function: func }], stream);
    expectTextResponse(result, stream, "plain");
  },
);

test("control nested tools complete NDJSON", async () => {
  const result = await post(await start(), nested, true);
  expectTextResponse(result, true, "first");
});

test("control Ollama output tool-call arguments remain objects", async () => {
  const server = await start();
  server.clearFixtures().onToolCall("f", { toolCalls: [{ name: "f", arguments: { value: 7 } }] });
  const result = await post(server, nested);
  expect(result.status).toBe(200);
  expect(JSON.parse(result.text)).toMatchObject({
    message: { tool_calls: [{ function: { name: "f", arguments: { value: 7 } } }] },
    done: true,
  });
});

test("control inbound Ollama object arguments are converted to JSON strings", async () => {
  const server = await start();
  server.clearFixtures().on(
    {
      predicate: (request) =>
        request.messages[1]?.tool_calls?.[0]?.function.arguments === '{"value":7}',
    },
    { content: "arguments matched" },
  );
  const result = await post(server, nested, false, [
    ...messages,
    {
      role: "assistant",
      content: "",
      tool_calls: [{ function: { name: "f", arguments: { value: 7 } } }],
    },
  ]);
  expect(result.status).toBe(200);
  expect(JSON.parse(result.text)).toMatchObject({
    message: { content: "arguments matched" },
    done: true,
  });
});
