import { afterEach, expect, test } from "vitest";
import { LLMock } from "../llmock.js";

let mock: LLMock | undefined;

afterEach(async () => {
  await mock?.stop();
  mock = undefined;
});

async function post(body: unknown) {
  if (!mock) {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { model: "c04", sequenceIndex: 0 },
      response: { content: "C04 first fixture" },
    });
    mock.addFixture({
      match: { model: "c04", sequenceIndex: 1 },
      response: { content: "C04 second fixture" },
    });
    await mock.start();
  }
  const response = await fetch(`${mock.url}/v1/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

const candidates = [
  { id: "missing-input", fields: {} },
  { id: "numeric-input", fields: { input: 42 } },
  { id: "object-input", fields: { input: {} } },
  { id: "null-item", fields: { input: [null] } },
  { id: "numeric-message-content", fields: { input: [{ role: "user", content: 42 }] } },
];

test.each(candidates)(
  "candidate $id rejects before consuming a fixture",
  async ({ id, fields }) => {
    const request = { model: "c04", stream: false, ...fields };
    const result = await post(request);
    console.log(JSON.stringify({ id, request, ...result }));
    const first = await post({ model: "c04", stream: false, input: "hello" });
    const second = await post({ model: "c04", stream: false, input: "hello" });
    console.log(JSON.stringify({ id, first, second }));
    expect(first.status).toBe(200);
    expect(first.text).toContain("C04 first fixture");
    expect(second.status).toBe(200);
    expect(second.text).toContain("C04 second fixture");
    expect(result.status).toBe(400);
    expect(result.text).toContain("input");
    expect(result.text).toContain("invalid_request_error");
    expect(result.text).not.toMatch(/TypeError|\.filter is not a function|not iterable/);
  },
);

const controls = [
  { id: "string", input: "hello" },
  {
    id: "input-items",
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
  },
  { id: "item-reference", input: [{ type: "item_reference", id: "ref_1" }] },
  {
    id: "function-call",
    input: [{ type: "function_call", call_id: "call_1", name: "f", arguments: "{}" }],
  },
  {
    id: "function-output",
    input: [{ type: "function_call_output", call_id: "call_1", output: "ok" }],
  },
  { id: "function-defaults", input: [{ type: "function_call" }, { type: "function_call_output" }] },
  { id: "omitted-content", input: [{ role: "user" }] },
  { id: "null-content", input: [{ role: "assistant", content: null }] },
  { id: "ignored-content-block", input: [{ role: "user", content: [{ type: "input_image" }] }] },
  { id: "ignored-item-inert-content", input: [{ type: "local_shell_call", content: 42 }] },
  { id: "empty-input", input: [] },
  { id: "empty-content", input: [{ role: "user", content: [] }] },
  { id: "zero-content", input: [{ role: "user", content: 0 }] },
  { id: "false-content", input: [{ role: "assistant", content: false }] },
  { id: "inert-primitive-items", input: [42, false, "ignored", []] },
];

test.each(controls)("control $id preserves fixture output", async ({ id, input }) => {
  const request = { model: "c04", stream: false, input };
  const result = await post(request);
  console.log(JSON.stringify({ id, request, ...result }));
  expect(result.status).toBe(200);
  expect(result.text).toContain("C04 first fixture");
  expect(result.text).toContain('"status":"completed"');
});
