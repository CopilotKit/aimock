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

test("control shorthand retains generic validation acceptance and characterizes Ollama failure", async () => {
  const shorthand = [{ type: "function" }];
  expect(validateToolsField(shorthand)).toBeNull();
  const result = await post(await start(), shorthand);
  // Phase A characterization only: no new rejection or shorthand normalization is authorized.
  expect(result.status).toBe(500);
});

test("control nested tools complete NDJSON", async () => {
  const result = await post(await start(), nested, true);
  expect(result.status).toBe(200);
  const chunks = result.text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(chunks.map((chunk) => chunk.message.content).join("")).toBe("first");
  expect(chunks.at(-1)).toMatchObject({ done: true, done_reason: "stop" });
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
