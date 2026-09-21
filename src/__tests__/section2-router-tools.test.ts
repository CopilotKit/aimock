import { afterEach, expect, test } from "vitest";
import { LLMock } from "../llmock.js";
import { matchFixture } from "../router.js";
import { validateToolsField } from "../helpers.js";
import type { ChatCompletionRequest, Fixture } from "../types.js";

let mock: LLMock | undefined;
afterEach(async () => {
  await mock?.stop();
  mock = undefined;
});

const nested = [{ type: "function", function: { name: "f", parameters: {} } }];
const candidates = [
  { id: "C22-missing-function", tools: [{ type: "function" }] },
  { id: "C22-null-function", tools: [{ type: "function", function: null }] },
  { id: "C22-null-entry", tools: [null] },
];

async function start(withToolFixtures = true) {
  mock = new LLMock({ port: 0 });
  if (withToolFixtures) {
    mock.on({ toolName: "f", sequenceIndex: 0 }, { content: "first" });
    mock.on({ toolName: "f", sequenceIndex: 1 }, { content: "second" });
  }
  mock.on({ model: "gpt-4o" }, { content: "fallback" });
  await mock.start();
  return mock;
}

async function post(server: LLMock, tools: unknown) {
  const body = { model: "gpt-4o", messages: [{ role: "user", content: "hello" }], tools };
  const response = await fetch(`${server.url}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  process.stdout.write(
    `${JSON.stringify({ request: body, status: response.status, body: text })}\n`,
  );
  return { status: response.status, text };
}

function expectContent(result: Awaited<ReturnType<typeof post>>, content: string) {
  expect(result.status).toBe(200);
  expect(JSON.parse(result.text)).toMatchObject({ choices: [{ message: { content } }] });
}

test.each(candidates)("$id real HTTP does not crash router", async ({ tools }) => {
  const server = await start();
  const result = await post(server, tools);
  // Establish sequence state independently before asserting the observed failure.
  expectContent(await post(server, nested), "first");
  expectContent(await post(server, nested), "second");
  expectContent(result, "fallback");
});

test.each(candidates)("control $id inert model-only acceptance", async ({ tools }) => {
  expectContent(await post(await start(false), tools), "fallback");
});

test.each([undefined, null, []])("control absent tools %j fall through", async (tools) => {
  expectContent(await post(await start(), tools), "fallback");
});

test("control native nested functions preserve sequence and registration order", async () => {
  const server = await start();
  expectContent(await post(server, nested), "first");
  expectContent(await post(server, nested), "second");
  expectContent(await post(server, nested), "fallback");
});

test("control shorthand generic validator remains permissive", () => {
  expect(validateToolsField([{ type: "function" }])).toBeNull();
});

test("control public matcher returns original first fixture without consuming diagnostic counts", () => {
  const first: Fixture = {
    match: { toolName: "f", sequenceIndex: 0 },
    response: { content: "first" },
  };
  const second: Fixture = {
    match: { toolName: "f", sequenceIndex: 0 },
    response: { content: "second" },
  };
  const request: ChatCompletionRequest = {
    model: "gpt-4o",
    messages: [{ role: "user", content: "hello" }],
    tools: [{ type: "function", function: { name: "f" } }],
  };
  const counts = new Map<Fixture, number>();
  expect(matchFixture([first, second], request, counts)).toBe(first);
  expect(matchFixture([first, second], request, counts)).toBe(first);
  expect(counts.size).toBe(0);
});
