import { afterEach, expect, test } from "vitest";
import { LLMock } from "../llmock.js";

let mock: LLMock | undefined;
afterEach(async () => {
  await mock?.stop();
  mock = undefined;
});

const nativeTools = [{ name: "f", description: "f", parameter_definitions: {} }];
const nestedTools = [{ type: "function", function: { name: "f", parameters: {} } }];

async function start(toolMatch = false) {
  mock = new LLMock({ port: 0, logLevel: "silent" });
  mock.addFixtures([
    {
      match: { ...(toolMatch ? { toolName: "f" } : {}), sequenceIndex: 0 },
      response: { content: "first-fixture" },
    },
    { match: {}, response: { content: "later-fixture" } },
  ]);
  await mock.start();
}

async function post(tools: unknown, nullContent = false) {
  if (!mock) throw new Error("Test server not started");
  const request = {
    model: "command-r-plus",
    stream: false,
    messages: [
      ...(nullContent ? [{ role: "assistant", content: null, tool_calls: [] }] : []),
      { role: "user", content: "hello" },
    ],
    ...(tools === undefined ? {} : { tools }),
  };
  const response = await fetch(mock.url + "/v2/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  const result = { status: response.status, body: await response.text() };
  process.stdout.write(JSON.stringify({ request, ...result }) + "\n");
  return result;
}

test.each([
  { id: "C03-string", tools: "bad", field: "tools" },
  { id: "C03-null-item", tools: [null], field: "tools[0]" },
  {
    id: "C03-null-function",
    tools: [{ type: "function", function: null }],
    field: "tools[0].function",
  },
])("$id rejects consumed invalid tools before fixture state changes", async ({ tools, field }) => {
  await start(true);
  const invalid = await post(tools);
  const first = await post(nativeTools);
  const later = await post(nativeTools);
  expect(first.status).toBe(200);
  expect(first.body).toContain("first-fixture");
  expect(later.body).toContain("later-fixture");
  expect(invalid.status).toBe(400);
  expect(invalid.body).toContain("invalid_request_error");
  expect(invalid.body).toContain(field);
  expect(invalid.body).not.toMatch(/TypeError|Cannot read/);
});

test.each([
  { id: "native", tools: nativeTools, toolMatch: true },
  { id: "nested", tools: nestedTools, toolMatch: true },
  { id: "absent", tools: undefined, toolMatch: false },
  { id: "null", tools: null, toolMatch: false },
  { id: "empty", tools: [], toolMatch: false },
  { id: "shorthand", tools: [{ type: "function" }], toolMatch: false },
  { id: "null-content", tools: nativeTools, toolMatch: true, nullContent: true },
])("control $id preserves fixture response", async ({ tools, toolMatch, nullContent }) => {
  await start(toolMatch);
  const response = await post(tools, nullContent);
  expect(response.status).toBe(200);
  expect(response.body).toContain("first-fixture");
});
