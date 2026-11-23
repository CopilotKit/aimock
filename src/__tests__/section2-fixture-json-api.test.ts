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

async function chat(content = "first") {
  const response = await fetch(mock.url + "/v1/chat/completions", {
    method: "POST",
    signal: AbortSignal.timeout(5000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content }],
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

const malformedMatchCases = [
  { name: "string", match: "nope" },
  { name: "number", match: 42 },
  { name: "array", match: [] },
];

for (const format of ["string", "parsed"] as const) {
  describe(`${format} JSON API atomic match validation`, () => {
    for (const { name, match } of malformedMatchCases) {
      test.each([0, 1, 2])(
        `rejects ${name} match at position %i without mutation`,
        async (position) => {
          mock.addFixture({
            match: { userMessage: "first", sequenceIndex: 0 },
            response: { content: "FIRST" },
          });
          mock.addFixture({
            match: { userMessage: "first" },
            response: { content: "SECOND" },
          });
          mock.nextRequestError(429, { message: "QUEUED" });
          const before = [...mock.getFixtures()];
          const entries = [
            { match: { userMessage: "before" }, response: { content: "BEFORE" } },
            { match: { userMessage: "after" }, response: { content: "AFTER" } },
          ];
          entries.splice(
            position,
            0,
            JSON.parse(JSON.stringify({ match, response: { content: "BAD" } })),
          );
          const serialized = JSON.stringify(entries);
          let caught: unknown;
          try {
            mock.addFixturesFromJSON(format === "string" ? serialized : JSON.parse(serialized));
          } catch (error) {
            caught = error;
          }
          const after = [...mock.getFixtures()];
          const queued = await chat();
          const first = await chat();
          const second = await chat();
          const unrelated = await chat("unrelated");
          const beforeSibling = await chat("before");
          const afterSibling = await chat("after");
          console.log(
            JSON.stringify({
              format,
              name,
              position,
              error: caught instanceof Error ? `${caught.name}: ${caught.message}` : null,
              count: after.length,
              queued,
              first,
              second,
              unrelated,
              beforeSibling,
              afterSibling,
            }),
          );
          expect(caught).toBeInstanceOf(TypeError);
          expect(caught instanceof Error ? caught.message : undefined).toMatch(/match.*object/i);
          expect(after).toEqual(before);
          for (const [index, fixture] of before.entries()) expect(after[index]).toBe(fixture);
          expect(queued.status).toBe(429);
          expect(queued.body).toContain("QUEUED");
          expect(first.status).toBe(200);
          expect(first.body).toContain("FIRST");
          expect(second.status).toBe(200);
          expect(second.body).toContain("SECOND");
          for (const response of [unrelated, beforeSibling, afterSibling])
            expect(response.status).toBe(404);
        },
      );
    }

    test("explicit empty match remains a catch-all after ordered siblings", async () => {
      const entries: FixtureFileEntry[] = [
        { match: { userMessage: "first" }, response: { content: "FIRST" } },
        { match: { userMessage: "first" }, response: { content: "SECOND" } },
        { match: {}, response: { content: "CATCH_ALL" } },
      ];
      expect(
        mock.addFixturesFromJSON(format === "string" ? JSON.stringify(entries) : entries),
      ).toBe(mock);
      const first = await chat();
      const unrelated = await chat("unrelated");
      expect(first.status).toBe(200);
      expect(first.body).toContain("FIRST");
      expect(unrelated.status).toBe(200);
      expect(unrelated.body).toContain("CATCH_ALL");
    });
  });
}
