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
    signal: AbortSignal.timeout(5_000),
  });
  return { status: response.status, body: await response.text() };
}
function chat(content = "unrelated") {
  return post("/v1/chat/completions", {
    model: "gpt-4o",
    messages: [{ role: "user", content }],
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

describe("malformed control fixture match batches", () => {
  const candidates = [
    { name: "string", match: "nope" },
    { name: "number", match: 42 },
    { name: "array", match: [] },
  ];
  const cases = candidates.flatMap((candidate) =>
    [0, 1, 2].map((index) => ({ ...candidate, index })),
  );

  test.each(cases)("rejects $name match at index $index atomically", async ({ match, index }) => {
    mock.addFixture({ match: { sequenceIndex: 0 }, response: { content: "FIRST" } });
    mock.nextRequestError(429, { message: "QUEUED" });
    const before = [...mock.getFixtures()];
    const fixtures: unknown[] = [
      { match: { userMessage: "before" }, response: { content: "BEFORE" } },
      { match: { userMessage: "after" }, response: { content: "AFTER" } },
    ];
    fixtures.splice(index, 0, { match, response: { content: "BAD" } });
    const result = await post("/__aimock/fixtures", { fixtures });
    const after = [...mock.getFixtures()];
    const queued = await chat();
    const sequence = await chat();
    const unrelated = await chat();
    const firstSibling = await chat("before");
    const lastSibling = await chat("after");
    console.log(
      JSON.stringify({
        match,
        index,
        result,
        countBefore: before.length,
        countAfter: after.length,
        queued,
        sequence,
        unrelated,
        firstSibling,
        lastSibling,
      }),
    );
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: `Fixture at index ${index}: match must be an object`,
    });
    expect(after).toEqual(before);
    expect(queued.status).toBe(429);
    expect(queued.body).toContain("QUEUED");
    expect(sequence.status).toBe(200);
    expect(sequence.body).toContain("FIRST");
    for (const response of [unrelated, firstSibling, lastSibling]) {
      expect(response.status).toBe(404);
    }
  });

  test("preserves unrelated response normalization errors", async () => {
    const result = await preservedAttempt({
      fixtures: [{ match: {}, response: { toolCalls: [null] } }],
    });
    expect(result.status).toBe(500);
    expect(JSON.parse(result.body)).toEqual({
      error: {
        message: "Cannot read properties of null (reading 'arguments')",
        type: "server_error",
      },
    });
  });
});
