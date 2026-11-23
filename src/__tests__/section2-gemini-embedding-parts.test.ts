import { afterEach, describe, expect, it } from "vitest";
import { LLMock } from "../llmock.js";
import type { Fixture } from "../types.js";

const servers: LLMock[] = [];
const path = "/v1beta/models/text-embedding-004:embedContent";

async function start(fixtures: Fixture[] = []) {
  const mock = new LLMock({ port: 0, logLevel: "silent" });
  mock.addFixtures(fixtures);
  await mock.start();
  servers.push(mock);
  return mock;
}

afterEach(async () => {
  for (const mock of servers.splice(0)) await mock.stop();
});

async function post(mock: LLMock, body: unknown) {
  const response = await fetch(mock.url + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  process.stdout.write(
    JSON.stringify({ request: body, status: response.status, body: text }) + "\n",
  );
  return { status: response.status, body: JSON.parse(text) as unknown };
}

function values(body: unknown): unknown[] {
  if (body === null || typeof body !== "object" || !("embedding" in body))
    throw new Error("Missing embedding");
  const embedding = body.embedding;
  if (
    embedding === null ||
    typeof embedding !== "object" ||
    !("values" in embedding) ||
    !Array.isArray(embedding.values)
  )
    throw new Error("Missing embedding values");
  return embedding.values;
}

describe("C13 failure surface", () => {
  it.each(["bad", [null]])("does not crash converting parts %j", async (parts) => {
    const mock = await start([
      { match: { sequenceIndex: 0 }, response: { embedding: [0.13] } },
      { match: {}, response: { embedding: [0.26] } },
    ]);
    const invalid = await post(mock, { content: { parts } });
    const firstValid = await post(mock, { content: { parts: [{ text: "hello" }] } });
    expect(firstValid).toEqual({ status: 200, body: { embedding: { values: [0.13] } } });
    expect(invalid).toEqual({
      status: 400,
      body: {
        error: {
          code: 400,
          status: "INVALID_ARGUMENT",
          message: Array.isArray(parts)
            ? "content.parts must not contain null entries"
            : "content.parts must be an array",
        },
      },
    });
  });
});

describe("C13 supported controls", () => {
  it.each([
    {},
    { content: null },
    { content: {} },
    { content: { parts: null } },
    { content: { parts: [] } },
  ])("preserves empty normalization %j", async (body) => {
    const mock = await start();
    const response = await post(mock, body);
    const empty = await post(mock, { content: { parts: [] } });
    expect(response.status).toBe(200);
    expect(response.body).toEqual(empty.body);
    expect(values(response.body)).toHaveLength(768);
    expect(
      values(response.body).every((value) => typeof value === "number" && Number.isFinite(value)),
    ).toBe(true);
  });

  it("preserves text concatenation, fixture replay, ignored entries and width defaults", async () => {
    const mock = await start([
      { match: { inputText: "hello world" }, response: { embedding: [0.1, 0.2] } },
    ]);
    const replay = await post(mock, {
      content: { parts: [{ text: "hello" }, {}, false, 1, "ignored", [], { text: "world" }] },
    });
    expect(replay).toEqual({ status: 200, body: { embedding: { values: [0.1, 0.2] } } });
    const fallback = await post(mock, { content: { parts: [{ text: "fallback" }] } });
    expect(fallback.status).toBe(200);
    expect(values(fallback.body)).toHaveLength(768);
    const small = await post(mock, {
      content: { parts: [{ text: "fallback" }] },
      outputDimensionality: 1,
    });
    expect(small.status).toBe(200);
    expect(values(small.body)).toHaveLength(1);
  });
});
