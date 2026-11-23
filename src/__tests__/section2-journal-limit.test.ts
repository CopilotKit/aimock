import { afterEach, expect, test } from "vitest";
import { LLMock } from "../llmock.js";
import type { Fixture } from "../types.js";

let mock: LLMock | undefined;
afterEach(async () => {
  await mock?.stop();
  mock = undefined;
});

async function chat(server: LLMock, content: string) {
  const response = await fetch(`${server.url}/v1/chat/completions`, {
    signal: AbortSignal.timeout(5000),
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      stream: false,
      messages: [{ role: "user", content }],
    }),
  });
  return { status: response.status, body: await response.text() };
}

async function seedJournal() {
  const server = new LLMock({ port: 0 });
  mock = server;
  const seed: Fixture = { match: { userMessage: "seed" }, response: { content: "SEEDED" } };
  const sentinel: Fixture = {
    match: { userMessage: "sentinel", sequenceIndex: 0 },
    response: { content: "PRESERVED" },
  };
  server.addFixture(seed);
  server.addFixture(sentinel);
  await server.start();
  for (let index = 0; index < 12; index++) {
    const response = await chat(server, `seed-${index}`);
    expect(response.status).toBe(200);
    expect(response.body).toContain("SEEDED");
  }
  const baseline = structuredClone(server.getRequests());
  expect(baseline).toHaveLength(12);
  const seedCount = server.journal.getFixtureMatchCount(seed);
  const sentinelCount = server.journal.getFixtureMatchCount(sentinel);
  return {
    server,
    baseline,
    assertUnchanged() {
      expect(server.getRequests()).toEqual(baseline);
      expect(server.journal.getFixtureMatchCount(seed)).toBe(seedCount);
      expect(server.journal.getFixtureMatchCount(sentinel)).toBe(sentinelCount);
    },
  };
}

async function readLimit(server: LLMock, limit: string | undefined) {
  const query = limit === undefined ? "" : `?limit=${encodeURIComponent(limit)}`;
  const response = await fetch(`${server.url}/v1/_requests${query}`, {
    signal: AbortSignal.timeout(5000),
  });
  const body = await response.json();
  process.stdout.write(JSON.stringify({ limit, status: response.status, body }) + "\n");
  return { status: response.status, body };
}

function invalidLimitBody(limit: string) {
  return {
    error: { message: `Invalid limit parameter: "${limit}"`, type: "invalid_request_error" },
  };
}

test.each(["10abc", "1.5", "1e2", "9007199254740993"])(
  "rejects malformed legacy journal limit %s without consuming fixture state",
  async (limit) => {
    const seeded = await seedJournal();
    const response = await readLimit(seeded.server, limit);
    seeded.assertUnchanged();
    expect(response.status).toBe(400);
    expect(response.body).toEqual(invalidLimitBody(limit));
    const sentinel = await chat(seeded.server, "sentinel");
    expect(sentinel.status).toBe(200);
    expect(sentinel.body).toContain("PRESERVED");
  },
);

test.each([
  { limit: undefined, count: 12 },
  { limit: "", count: 12 },
  { limit: "10", count: 10 },
  { limit: "0010", count: 10 },
  { limit: " 10 ", count: 10 },
  { limit: "+10", count: 10 },
  { limit: "9007199254740991", count: 12 },
])("preserves legacy journal limit $limit", async ({ limit, count }) => {
  const seeded = await seedJournal();
  const response = await readLimit(seeded.server, limit);
  expect(response.status).toBe(200);
  expect(response.body).toEqual(seeded.baseline.slice(-count));
  seeded.assertUnchanged();
});

test.each(["-1", "0", "abc", "   "])("preserves existing rejection for %s", async (limit) => {
  const seeded = await seedJournal();
  const response = await readLimit(seeded.server, limit);
  expect(response.status).toBe(400);
  expect(response.body).toEqual(invalidLimitBody(limit));
  seeded.assertUnchanged();
});

test("preserves separate control journal zero behavior", async () => {
  const seeded = await seedJournal();
  const response = await fetch(`${seeded.server.url}/__aimock/journal?limit=0`, {
    signal: AbortSignal.timeout(5000),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual([]);
  seeded.assertUnchanged();
});
