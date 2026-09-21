import { afterEach, expect, test } from "vitest";
import { LLMock } from "../llmock.js";

let mock: LLMock | undefined;
afterEach(async () => {
  await mock?.stop();
  mock = undefined;
});

async function start() {
  mock = new LLMock({ port: 0 });
  mock.addFixture({
    match: { userMessage: "hello", sequenceIndex: 0 },
    response: { content: "first fixture" },
  });
  await mock.start();
  return mock;
}

async function post(server: LLMock, id: string, fields: object) {
  const request = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 32,
    messages: [{ role: "user", content: "hello" }],
    ...fields,
  };
  const response = await fetch(`${server.url}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  const body = await response.text();
  const observation = {
    id,
    request,
    status: response.status,
    body,
    normalizedTools: server.getLastRequest()?.body?.tools,
  };
  console.log(JSON.stringify(observation));
  return observation;
}

function expectReplay(result: Awaited<ReturnType<typeof post>>) {
  expect(result.status).toBe(200);
  expect(JSON.parse(result.body)).toMatchObject({
    type: "message",
    content: [{ type: "text", text: "first fixture" }],
  });
}

test.each([
  { id: "C05-tools-string", tools: "bad" },
  { id: "C05-tools-null-entry", tools: [null] },
])("candidate $id rejects before consuming first fixture", async ({ id, tools }) => {
  const server = await start();
  const invalid = await post(server, id, { tools });
  const valid = await post(server, `${id}-followup`, {});
  expectReplay(valid);
  expect(invalid.status).toBe(400);
  expect(JSON.parse(invalid.body)).toMatchObject({
    error: { type: "invalid_request_error" },
  });
});

test.each([
  { id: "absent", fields: {} },
  { id: "null", fields: { tools: null } },
  { id: "empty", fields: { tools: [] } },
])("control $id tools retains replay", async ({ id, fields }) => {
  const server = await start();
  const result = await post(server, `control-${id}`, fields);
  expectReplay(result);
  expect(result.normalizedTools).toBeUndefined();
});

test("control native definition preserves schema and name", async () => {
  const server = await start();
  const input_schema = {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  };
  const result = await post(server, "control-native", {
    tools: [{ name: "weather", description: "Weather lookup", input_schema }],
  });
  expectReplay(result);
  expect(result.normalizedTools).toEqual([
    {
      type: "function",
      function: { name: "weather", description: "Weather lookup", parameters: input_schema },
    },
  ]);
});

// These inputs were already inert or safely normalized before the crash fix.
test.each([
  { id: "empty-string", tools: "", normalized: undefined },
  { id: "false", tools: false, normalized: undefined },
  { id: "zero", tools: 0, normalized: undefined },
  { id: "number", tools: 42, normalized: undefined },
  { id: "object", tools: {}, normalized: undefined },
  { id: "zero-length-object", tools: { length: 0 }, normalized: undefined },
  {
    id: "primitive-entries",
    tools: [false, 42, "x", [], {}],
    normalized: Array.from({ length: 5 }, () => ({ type: "function", function: {} })),
  },
])("boundary control $id", async ({ id, tools, normalized }) => {
  const server = await start();
  const result = await post(server, `boundary-${id}`, { tools });
  expectReplay(result);
  // Compare wire-normalized fields: undefined properties are absent in JSON.
  expect(
    result.normalizedTools === undefined
      ? undefined
      : JSON.parse(JSON.stringify(result.normalizedTools)),
  ).toEqual(normalized);
});
