import { afterEach, expect, test } from "vitest";
import { LLMock } from "../llmock.js";

let mock: LLMock | undefined;

afterEach(async () => {
  await mock?.stop();
  mock = undefined;
});

async function characterize(id: string, fields: object, normalized: unknown) {
  mock = new LLMock({ port: 0 });
  mock.addFixture({ match: {}, response: { content: "C05 replay" } });
  await mock.start();
  const request = { model: "claude-sonnet-4-20250514", max_tokens: 32, ...fields };
  const response = await fetch(`${mock.url}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  const text = await response.text();
  const journal = mock.getLastRequest();
  console.log(
    JSON.stringify({
      id,
      request,
      status: response.status,
      body: text,
      normalized: journal?.body?.messages,
    }),
  );
  expect(response.status).toBe(200);
  expect(JSON.parse(text)).toMatchObject({
    type: "message",
    content: [{ type: "text", text: "C05 replay" }],
  });
  expect(journal?.body?.messages).toEqual(normalized);
}

// Phase A characterization: acceptance is not by itself a compatibility contract.
// These assertions preserve the observed safe normalizations pending independent review.
test.each([
  { id: "C05-missing", fields: {}, normalized: [] },
  { id: "C05-number", fields: { messages: 42 }, normalized: [] },
  { id: "C05-string", fields: { messages: "hello" }, normalized: [] },
  { id: "C05-object", fields: { messages: {} }, normalized: [] },
  { id: "C05-null", fields: { messages: null }, normalized: [] },
  { id: "C05-null-entry", fields: { messages: [null] }, normalized: [] },
  {
    id: "C05-number-user-content",
    fields: { messages: [{ role: "user", content: 42 }] },
    normalized: [{ role: "user", content: "" }],
  },
  {
    id: "C05-number-assistant-content",
    fields: { messages: [{ role: "assistant", content: 42 }] },
    normalized: [{ role: "assistant", content: null }],
  },
])("candidate $id", async ({ id, fields, normalized }) => {
  await characterize(id, fields, normalized);
});

test.each([
  { id: "empty-messages", messages: [], normalized: [] },
  {
    id: "empty-content",
    messages: [{ role: "user", content: [] }],
    normalized: [{ role: "user", content: "" }],
  },
  {
    id: "absent-user-content",
    messages: [{ role: "user" }],
    normalized: [{ role: "user", content: "" }],
  },
  {
    id: "null-user-content",
    messages: [{ role: "user", content: null }],
    normalized: [{ role: "user", content: "" }],
  },
  {
    id: "absent-assistant-content",
    messages: [{ role: "assistant" }],
    normalized: [{ role: "assistant", content: null }],
  },
  {
    id: "null-assistant-content",
    messages: [{ role: "assistant", content: null }],
    normalized: [{ role: "assistant", content: null }],
  },
  {
    id: "inert-tool-calls",
    messages: [{ role: "user", content: "hello", tool_calls: [null] }],
    normalized: [{ role: "user", content: "hello" }],
  },
  {
    id: "ignored-content-entry",
    messages: [{ role: "user", content: [null, { type: "text", text: "hello" }] }],
    normalized: [{ role: "user", content: "hello" }],
  },
  {
    id: "native-tool-thinking",
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "consider", signature: "sig" },
          { type: "tool_use", id: "tool_1", name: "f", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool_1",
            content: [{ type: "text", text: "result" }],
          },
        ],
      },
    ],
    normalized: [
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "tool_1", type: "function", function: { name: "f", arguments: "{}" } }],
      },
      { role: "tool", content: "result", tool_call_id: "tool_1" },
    ],
  },
])("control $id", async ({ id, messages, normalized }) => {
  await characterize(
    id,
    { messages, tools: [{ name: "f", input_schema: { type: "object" } }] },
    normalized,
  );
});
