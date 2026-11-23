import { afterEach, expect, test } from "vitest";
import { LLMock } from "../llmock.js";

let mock: LLMock | undefined;

afterEach(async () => {
  await mock?.stop();
  mock = undefined;
});

async function post(server: LLMock, fields: object) {
  const request = { model: "claude-sonnet-4-20250514", max_tokens: 32, ...fields };
  const response = await fetch(`${server.url}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(5000),
  });
  return {
    request,
    status: response.status,
    contentType: response.headers.get("content-type"),
    body: await response.text(),
    journal: server.getLastRequest(),
  };
}

function expectReplay(result: Awaited<ReturnType<typeof post>>, content: string, stream: boolean) {
  expect(result.status).toBe(200);
  if (stream) {
    expect(result.contentType).toContain("text/event-stream");
    expect(result.body).toContain(`"text":"${content}"`);
    expect(result.body).toContain("event: message_stop");
  } else {
    expect(JSON.parse(result.body)).toMatchObject({
      type: "message",
      content: [{ type: "text", text: content }],
    });
  }
}

async function characterize(id: string, fields: object, normalized: unknown, stream = false) {
  mock = new LLMock({ port: 0 });
  mock.addFixture({ match: {}, response: { content: "C05 replay" } });
  await mock.start();
  const result = await post(mock, { ...fields, stream });
  console.log(JSON.stringify({ id, ...result }));
  expectReplay(result, "C05 replay", stream);
  expect(result.journal?.body?.messages).toEqual(normalized);
}

const malformedMessages = [
  { id: "missing", fields: {} },
  { id: "number", fields: { messages: 42 } },
  { id: "string", fields: { messages: "bad" } },
  { id: "object", fields: { messages: {} } },
  { id: "null", fields: { messages: null } },
  { id: "null-entry", fields: { messages: [null] } },
  { id: "number-entry", fields: { messages: [42] } },
  { id: "string-entry", fields: { messages: ["bad"] } },
  { id: "boolean-entry", fields: { messages: [false] } },
  { id: "array-entry", fields: { messages: [[]] } },
];

test.each(
  malformedMessages.flatMap((cell) => [false, true].map((stream) => ({ ...cell, stream }))),
)(
  "rejects $id messages before fixture matching (stream=$stream)",
  async ({ id, fields, stream }) => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({ match: { sequenceIndex: 0 }, response: { content: "FIRST" } });
    mock.addFixture({ match: { sequenceIndex: 1 }, response: { content: "SECOND" } });
    await mock.start();
    const malformed = await post(mock, { ...fields, stream });
    const sentinel = await post(mock, { messages: [{ role: "user", content: "hello" }], stream });
    console.log(JSON.stringify({ id, stream, malformed, sentinel }));
    expect(malformed.status).toBe(400);
    expect(malformed.contentType).toContain("application/json");
    expect(JSON.parse(malformed.body)).toMatchObject({ error: { type: "invalid_request_error" } });
    expect(malformed.journal?.response).toMatchObject({ status: 400, fixture: null });
    expectReplay(sentinel, "FIRST", stream);
  },
);

const supportedMessages = [
  { id: "empty-messages", messages: [], normalized: [] },
  {
    id: "multimodal",
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
          { type: "text", text: "describe" },
        ],
      },
    ],
    normalized: [{ role: "user", content: "describe" }],
  },
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
];

test.each(
  supportedMessages.flatMap((cell) => [false, true].map((stream) => ({ ...cell, stream }))),
)("control $id (stream=$stream)", async ({ id, messages, normalized, stream }) => {
  await characterize(
    id,
    { messages, tools: [{ name: "f", input_schema: { type: "object" } }] },
    normalized,
    stream,
  );
});
