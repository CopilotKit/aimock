import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { LLMock } from "../llmock.js";
import type { FixtureFileEntry } from "../types.js";

let mock: LLMock;
const valid: FixtureFileEntry = {
  match: { userMessage: "valid" },
  response: { content: "VALID" },
};
beforeEach(async () => {
  mock = new LLMock({ port: 0 });
  await mock.start();
});
afterEach(async () => {
  await mock.stop();
});

function attempt(input: string) {
  try {
    mock.addFixturesFromJSON(input);
    return "accepted";
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.log(JSON.stringify({ input, message, count: mock.getFixtures().length }));
    return message;
  }
}

async function chat() {
  const response = await fetch(mock.url + "/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: "first" }],
      stream: false,
    }),
  });
  return { status: response.status, body: await response.text() };
}

test("C20-01 JSON API explains the unsupported file-envelope mismatch", () => {
  let caught: unknown;
  try {
    mock.addFixturesFromJSON('{"fixtures":[]}');
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(TypeError);
  expect(mock.getFixtures()).toHaveLength(0);
  expect(caught instanceof TypeError ? caught.message : undefined).toBe(
    "addFixturesFromJSON: expected an array of fixture entries; use loadFixtureFile for a {fixtures:[...]} file",
  );
});

describe("supported controls", () => {
  test.each(["string", "parsed"] as const)(
    "%s array retains chaining and normalization",
    (format) => {
      const entries: FixtureFileEntry[] = [
        valid,
        { match: { userMessage: "object" }, response: { content: { answer: 42 } } },
        {
          match: { userMessage: "tool" },
          response: { toolCalls: [{ name: "lookup", arguments: { id: 42 } }] },
        },
      ];
      expect(
        mock.addFixturesFromJSON(format === "string" ? JSON.stringify(entries) : entries),
      ).toBe(mock);
      expect(mock.getFixtures()).toHaveLength(3);
      expect(mock.getFixtures()[1].response).toEqual({ content: '{"answer":42}' });
      expect(mock.getFixtures()[2].response).toEqual({
        toolCalls: [{ name: "lookup", arguments: '{"id":42}' }],
      });
    },
  );

  test("empty arrays preserve existing fixtures and return this", () => {
    mock.addFixturesFromJSON([valid]);
    const before = [...mock.getFixtures()];
    expect(mock.addFixturesFromJSON("[]")).toBe(mock);
    expect(mock.addFixturesFromJSON([])).toBe(mock);
    expect(mock.getFixtures()).toEqual(before);
  });

  test.each([
    ["envelope", '{"fixtures":[]}'],
    ["mixed conversion failure", JSON.stringify([valid, { response: { content: "BAD" } }, valid])],
    ["mixed validation failure", JSON.stringify([valid, { ...valid, latency: -1 }, valid])],
    ["invalid JSON", "["],
  ])("%s preserves the running fixture and sequence", async (_name, input) => {
    mock.addFixture({
      match: { sequenceIndex: 0 },
      response: { content: "FIRST" },
    });
    mock.nextRequestError(429, { message: "QUEUED" });
    const before = [...mock.getFixtures()];
    expect(attempt(input)).not.toBe("accepted");
    expect(mock.getFixtures()).toEqual(before);
    const queued = await chat();
    expect(queued.status).toBe(429);
    expect(queued.body).toContain("QUEUED");
    const response = await chat();
    console.log(JSON.stringify({ input, queued, response }));
    expect(response.status).toBe(200);
    expect(response.body).toContain("FIRST");
  });
});
