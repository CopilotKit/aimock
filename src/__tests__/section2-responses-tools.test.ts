import { afterEach, expect, test } from "vitest";
import { LLMock } from "../llmock.js";

let mock: LLMock | undefined;

afterEach(async () => {
  await mock?.stop();
  mock = undefined;
});

async function post(fields: { tools?: unknown } = {}) {
  if (!mock) {
    mock = new LLMock({ port: 0 });
    for (const [sequenceIndex, content] of ["C04 tools first", "C04 tools second"].entries()) {
      mock.addFixture({
        match: { model: "c04-tools", sequenceIndex },
        response: { content },
      });
    }
    await mock.start();
  }
  const request = { model: "c04-tools", input: "hello", stream: false, ...fields };
  const response = await fetch(`${mock.url}/v1/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  return { request, status: response.status, text: await response.text() };
}

test.each([
  { id: "string-tools", tools: "bad" },
  { id: "null-tool-item", tools: [null] },
])("candidate $id rejects before fixture consumption", async ({ id, tools }) => {
  const result = await post({ tools });
  const first = await post();
  const second = await post();
  console.log(JSON.stringify({ id, result, first, second }));
  expect(first.status).toBe(200);
  expect(first.text).toContain("C04 tools first");
  expect(second.status).toBe(200);
  expect(second.text).toContain("C04 tools second");
  expect(result.status).toBe(400);
  expect(result.text).toContain("tools");
  expect(result.text).toContain("invalid_request_error");
  expect(result.text).not.toMatch(/TypeError|\.filter is not a function/);
});

test.each([
  { id: "absent", fields: {} },
  { id: "null", fields: { tools: null } },
  { id: "empty", fields: { tools: [] } },
  {
    id: "native-flat-function",
    fields: { tools: [{ type: "function", name: "f", parameters: { type: "object" } }] },
  },
  { id: "non-function", fields: { tools: [{ type: "web_search_preview" }] } },
  { id: "empty-string", fields: { tools: "" } },
  { id: "false", fields: { tools: false } },
  { id: "zero", fields: { tools: 0 } },
  { id: "zero-length-object", fields: { tools: { length: 0 } } },
  { id: "inert-primitive-items", fields: { tools: [42, false, "ignored", []] } },
])("control $id preserves fixture output", async ({ id, fields }) => {
  const result = await post(fields);
  console.log(JSON.stringify({ id, ...result }));
  expect(result.status).toBe(200);
  expect(result.text).toContain("C04 tools first");
  expect(result.text).toContain('"status":"completed"');
});
