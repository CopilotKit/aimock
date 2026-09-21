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
    match: { sequenceIndex: 0 },
    response: { content: "C06-first-fixture" },
  });
  await mock.start();
  return mock;
}

async function post(server: LLMock, body: unknown) {
  const response = await fetch(server.url + "/v1beta/models/gemini-2.0-flash:generateContent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

const validText = { contents: [{ role: "user", parts: [{ text: "hello" }] }] };
const rejected = [
  { id: "contents-number", body: { contents: 42 }, detail: "contents must be an array" },
  { id: "contents-string", body: { contents: "bad" }, detail: "contents must be an array" },
  { id: "content-null", body: { contents: [null] }, detail: "contents[0] must be an object" },
  {
    id: "parts-number",
    body: { contents: [{ parts: 42 }] },
    detail: "contents[0].parts must be an array",
  },
  {
    id: "parts-string",
    body: { contents: [{ parts: "bad" }] },
    detail: "contents[0].parts must be an array",
  },
  {
    id: "parts-object",
    body: { contents: [{ parts: {} }] },
    detail: "contents[0].parts must be an array",
  },
];

test.each(rejected)(
  "C06 $id already rejects before fixture consumption",
  async ({ id, body, detail }) => {
    const server = await start();
    const result = await post(server, body);
    console.log(JSON.stringify({ id, body, result }));
    expect(result.status).toBe(400);
    expect(JSON.parse(result.text)).toEqual({
      error: { message: `Invalid argument: ${detail}`, code: 400, status: "INVALID_ARGUMENT" },
    });
    const control = await post(server, validText);
    console.log(JSON.stringify({ id: `${id}-sequence-control`, body: validText, result: control }));
    expect(control.status).toBe(200);
    expect(control.text).toContain("C06-first-fixture");
  },
);

const controls = [
  { id: "absent-parts", body: { contents: [{ role: "user" }] } },
  { id: "null-parts", body: { contents: [{ role: "user", parts: null }] } },
  {
    id: "ignored-parts",
    body: {
      contents: [
        {
          role: "user",
          parts: [null, 42, "bad", {}, { inlineData: { mimeType: "image/png", data: "AA==" } }],
        },
      ],
    },
  },
  { id: "text", body: validText },
  {
    id: "function-pair",
    body: {
      contents: [
        {
          role: "model",
          parts: [{ functionCall: { name: "lookup", args: { city: "Paris" }, id: "call_lookup" } }],
        },
        {
          role: "user",
          parts: [{ functionResponse: { name: "lookup", response: { result: "sunny" } } }],
        },
      ],
      tools: [{ functionDeclarations: [{ name: "lookup", parameters: { type: "object" } }] }],
    },
  },
];

test.each(controls)("C06 control $id keeps fixture-backed output", async ({ id, body }) => {
  const server = await start();
  const result = await post(server, body);
  console.log(JSON.stringify({ id, body, result, journal: server.getRequests() }));
  expect(result.status).toBe(200);
  expect(JSON.parse(result.text)).toMatchObject({
    candidates: [{ content: { parts: [{ text: "C06-first-fixture" }] } }],
  });
  if (id === "function-pair") {
    expect(server.getRequests()[0].body).toMatchObject({
      messages: [
        {
          role: "assistant",
          tool_calls: [
            { id: "call_lookup", function: { name: "lookup", arguments: '{"city":"Paris"}' } },
          ],
        },
        { role: "tool", tool_call_id: "call_lookup", content: '{"result":"sunny"}' },
      ],
    });
  }
});
