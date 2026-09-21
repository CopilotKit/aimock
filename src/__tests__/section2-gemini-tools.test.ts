import { afterEach, expect, test } from "vitest";
import { LLMock } from "../llmock.js";

let mock: LLMock | undefined;
afterEach(async () => {
  await mock?.stop();
  mock = undefined;
});

async function start() {
  mock = new LLMock({ port: 0 });
  mock.addFixture({ match: { sequenceIndex: 0 }, response: { content: "C06-tools-first" } });
  await mock.start();
  return mock;
}

const contents = [{ role: "user", parts: [{ text: "hello" }] }];
async function post(server: LLMock, id: string, body: unknown) {
  const response = await fetch(server.url + "/v1beta/models/gemini-2.0-flash:generateContent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = { status: response.status, text: await response.text() };
  console.log(JSON.stringify({ id, body, result }));
  return result;
}

const candidates = [
  { id: "tools-string", tools: "bad" },
  { id: "tools-null-item", tools: [null] },
  { id: "declarations-null-item", tools: [{ functionDeclarations: [null] }] },
];
test.each(candidates)("C06-tools $id rejects before fixture consumption", async ({ id, tools }) => {
  const server = await start();
  const result = await post(server, id, { contents, tools });
  const control = await post(server, `${id}-sequence-control`, { contents });
  expect(control.status).toBe(200);
  expect(JSON.parse(control.text)).toMatchObject({
    candidates: [{ content: { parts: [{ text: "C06-tools-first" }] } }],
  });
  expect(result.status).toBe(400);
  expect(JSON.parse(result.text)).toMatchObject({
    error: { code: 400, status: "INVALID_ARGUMENT" },
  });
});

const controls = [
  {
    id: "nonarray-declarations",
    body: { contents, tools: [{ functionDeclarations: { name: "lookup" } }] },
  },
  {
    id: "primitive-declarations",
    body: { contents, tools: [{ functionDeclarations: [42, "bad"] }] },
  },
  { id: "absent-tools", body: { contents } },
  { id: "null-tools", body: { contents, tools: null } },
  { id: "empty-tools", body: { contents, tools: [] } },
  { id: "google-search", body: { contents, tools: [{ googleSearch: {} }] } },
  { id: "null-declarations", body: { contents, tools: [{ functionDeclarations: null }] } },
  { id: "empty-declarations", body: { contents, tools: [{ functionDeclarations: [] }] } },
  {
    id: "native-declarations",
    body: {
      contents,
      tools: [
        {
          functionDeclarations: [
            { name: "lookup", description: "Look up city", parameters: { type: "object" } },
          ],
        },
        { googleSearch: {} },
      ],
    },
  },
];
test.each(controls)("C06-tools control $id preserves fixture output", async ({ id, body }) => {
  const server = await start();
  const result = await post(server, id, body);
  expect(result.status).toBe(200);
  expect(JSON.parse(result.text)).toMatchObject({
    candidates: [{ content: { parts: [{ text: "C06-tools-first" }] } }],
  });
  const journal = server.getRequests();
  console.log(JSON.stringify({ id: `${id}-journal`, journal }));
  if (id === "native-declarations") {
    expect(journal[0].body).toMatchObject({
      tools: [
        {
          type: "function",
          function: { name: "lookup", description: "Look up city", parameters: { type: "object" } },
        },
      ],
    });
  }
});
