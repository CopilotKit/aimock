import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LLMock } from "../llmock.js";

let mock: LLMock;
let directory: string;
beforeEach(() => {
  mock = new LLMock({ port: 0 });
  directory = mkdtempSync(join(tmpdir(), "section2-fixture-disk-"));
});
afterEach(async () => {
  await mock.stop();
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

function fixtureFile(entries: unknown[]) {
  const path = join(directory, "fixtures.json");
  writeFileSync(path, JSON.stringify({ fixtures: entries }));
  return path;
}

function fixture(prompt: string, content: string) {
  return { match: { userMessage: prompt }, response: { content } };
}

async function chat(prompt: string) {
  const response = await fetch(mock.url + "/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      stream: false,
    }),
    signal: AbortSignal.timeout(5000),
  });
  return { status: response.status, text: await response.text() };
}

async function expectContent(prompt: string, content: string) {
  const response = await chat(prompt);
  expect(response.status).toBe(200);
  expect(response.text).toContain(`"content":"${content}"`);
}

const malformedMatches = [
  { name: "string", match: "nope" },
  { name: "number", match: 42 },
  { name: "array", match: [] },
];

describe.each(malformedMatches)("disk match $name", ({ match }) => {
  test.each([0, 1, 2])(
    "skips malformed entry at index %i without shadowing siblings",
    async (index) => {
      const warning = vi.spyOn(console, "warn");
      mock.addFixture(fixture("existing", "EXISTING"));
      const entries: unknown[] = [fixture("before", "BEFORE"), fixture("after", "AFTER")];
      entries.splice(index, 0, { match, response: { content: "BAD" } });
      const path = fixtureFile(entries);
      mock.loadFixtureFile(path);
      await mock.start();
      const unrelated = await chat("unrelated");
      console.log(JSON.stringify({ match, index, count: mock.getFixtures().length, unrelated }));
      expect(unrelated.status).toBe(404);
      expect(unrelated.text).not.toContain('"content":"BAD"');
      expect(mock.getFixtures().map((entry) => entry.match.userMessage)).toEqual([
        "existing",
        "before",
        "after",
      ]);
      expect(warning).toHaveBeenCalledWith(
        `[fixture-loader] Skipping fixture at index ${index} in ${path}: Fixture match must be an object`,
      );
      await expectContent("before", "BEFORE");
      await expectContent("after", "AFTER");
      await expectContent("existing", "EXISTING");
    },
  );
});

test("disk filtering retains sequence position and queued error", async () => {
  mock.addFixtures([
    { match: { userMessage: "existing", sequenceIndex: 0 }, response: { content: "FIRST" } },
    { match: { userMessage: "existing", sequenceIndex: 1 }, response: { content: "SECOND" } },
  ]);
  await mock.start();
  await expectContent("existing", "FIRST");
  mock.nextRequestError(429, { message: "QUEUED_ERROR" });
  mock.loadFixtureFile(
    fixtureFile([
      fixture("before", "BEFORE"),
      { match: "nope", response: { content: "BAD" } },
      fixture("after", "AFTER"),
    ]),
  );
  const queued = await chat("unrelated");
  expect(queued.status).toBe(429);
  expect(queued.text).toContain("QUEUED_ERROR");
  await expectContent("existing", "SECOND");
  await expectContent("before", "BEFORE");
  await expectContent("after", "AFTER");
  expect(mock.getFixtures()).toHaveLength(4);
});

test.each([
  { name: "missing match", entry: { response: { content: "BAD" } } },
  { name: "null match", entry: { match: null, response: { content: "BAD" } } },
  { name: "null entry", entry: null },
  { name: "array entry", entry: [] },
  { name: "scalar entry", entry: 42 },
  {
    name: "unrelated normalization failure",
    entry: { match: {}, response: { toolCalls: [null] } },
  },
])("preserves whole-file failure for $name", async ({ entry }) => {
  mock.addFixture(fixture("existing", "EXISTING"));
  const existing = [...mock.getFixtures()];
  expect(() =>
    mock.loadFixtureFile(
      fixtureFile([fixture("before", "BEFORE"), entry, fixture("after", "AFTER")]),
    ),
  ).toThrow(TypeError);
  expect(mock.getFixtures()).toEqual(existing);
  await mock.start();
  await expectContent("existing", "EXISTING");
  expect((await chat("before")).status).toBe(404);
  expect((await chat("after")).status).toBe(404);
});
