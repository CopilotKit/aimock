import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { LLMock } from "../llmock.js";

let mock: LLMock;
const valid = { match: { userMessage: "valid" }, response: { content: "VALID" } };
beforeEach(async () => {
  mock = new LLMock({ port: 0 });
  await mock.start();
});
afterEach(async () => {
  await mock.stop();
});

async function post(path: string, input: unknown) {
  const response = await fetch(mock.url + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return { status: response.status, body: await response.text() };
}
function chat() {
  return post("/v1/chat/completions", {
    model: "gpt-4o",
    messages: [{ role: "user", content: "unrelated" }],
    stream: false,
  });
}
async function preservedAttempt(input: unknown) {
  mock.addFixture({ match: { sequenceIndex: 0 }, response: { content: "FIRST" } });
  mock.nextRequestError(429, { message: "QUEUED" });
  const before = [...mock.getFixtures()];
  const result = await post("/__aimock/fixtures", input);
  expect(mock.getFixtures()).toEqual(before);
  const queued = await chat();
  const sequence = await chat();
  console.log(JSON.stringify({ input, result, countBefore: before.length, queued, sequence }));
  expect(queued.status).toBe(429);
  expect(queued.body).toContain("QUEUED");
  expect(sequence.status).toBe(200);
  expect(sequence.body).toContain("FIRST");
  return result;
}

describe("C21 existing malformed rejection classification", () => {
  test.each([
    ["missing match", { fixtures: [{ response: { content: "bad" } }] }],
    ["null match", { fixtures: [{ match: null, response: { content: "bad" } }] }],
    ["null envelope", null],
    ["mixed missing match", { fixtures: [valid, { response: { content: "bad" } }, valid] }],
  ])("%s returns controlled client error without changing queue/sequence", async (_name, input) => {
    const result = await preservedAttempt(input);
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body)).toEqual(expect.objectContaining({ error: expect.any(String) }));
  });
});

describe("C21 supported controls", () => {
  test.each([
    ["missing fixtures", {}],
    ["invalid fixtures", { fixtures: {} }],
    ["mixed validation failure", { fixtures: [valid, { match: {}, response: {} }, valid] }],
  ])("%s retains existing atomic 400 envelope", async (_name, input) => {
    const result = await preservedAttempt(input);
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body)).toEqual(expect.objectContaining({ error: expect.any(String) }));
  });
  test("valid batch preserves scoped match, normalized response, explicit catch-all", async () => {
    const input = { fixtures: [valid, { match: {}, response: { content: { answer: 42 } } }] };
    const result = await post("/__aimock/fixtures", input);
    expect(result).toEqual({ status: 200, body: '{"added":2}' });
    expect(mock.getFixtures()).toHaveLength(2);
    const scoped = await post("/v1/chat/completions", {
      model: "gpt-4o",
      messages: [{ role: "user", content: "valid" }],
      stream: false,
    });
    expect(scoped.status).toBe(200);
    expect(JSON.parse(scoped.body).choices[0].message.content).toBe("VALID");
    const response = await chat();
    console.log(JSON.stringify({ input, result, scoped, response }));
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).choices[0].message.content).toBe('{"answer":42}');
  });
});
