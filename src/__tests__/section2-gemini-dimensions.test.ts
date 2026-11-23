import { afterEach, describe, expect, it } from "vitest";
import { LLMock } from "../llmock.js";
import type { Fixture, MockServerOptions } from "../types.js";

const servers: LLMock[] = [];
const path = "/v1beta/models/text-embedding-004:embedContent";
const overBudget = [
  100_001,
  2_000_000,
  "100001",
  "2000000",
  [100_001],
  [[100_001]],
  ["100001"],
] as const;
const candidates = ["abc", -1, 1.5, ...overBudget] as const;

async function start(options: MockServerOptions = {}, fixtures: Fixture[] = []) {
  const mock = new LLMock({ port: 0, logLevel: "silent", ...options });
  mock.addFixtures(fixtures);
  await mock.start();
  servers.push(mock);
  return mock;
}

afterEach(async () => {
  for (const mock of servers.splice(0).reverse()) await mock.stop();
});

async function post(mock: LLMock, dimension: unknown, text = "hello") {
  const response = await fetch(`${mock.url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: { parts: [{ text }] }, outputDimensionality: dimension }),
  });
  const body: unknown = await response.json();
  process.stdout.write(
    JSON.stringify({
      dimension: dimension ?? "default",
      status: response.status,
      width: response.status === 200 ? values(body).length : undefined,
      body: JSON.stringify(body).length > 300 ? "large embedding; checked by assertions" : body,
    }) + "\n",
  );
  return { status: response.status, body };
}

function values(body: unknown): unknown[] {
  if (body === null || typeof body !== "object" || !("embedding" in body)) {
    throw new Error("Missing embedding object");
  }
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

describe("C07 fallback failure surface", () => {
  it.each(["abc", -1, 1.5])(
    "reports Gemini validation envelope for approved case %j",
    async (dimension) => {
      const mock = await start();
      const response = await post(mock, dimension);
      expect(response).toEqual({
        status: 400,
        body: {
          error: {
            code: 400,
            status: "INVALID_ARGUMENT",
            message: "outputDimensionality cannot produce a numeric embedding",
          },
        },
      });
      expect(mock.getLastRequest()?.response).toMatchObject({ status: 400, fixture: null });
    },
  );

  it.each(["abc", -1, 1.5])(
    "does not crash or return nonnumeric embeddings for %j",
    async (dimension) => {
      const mock = await start();
      const response = await post(mock, dimension);
      // No desired 400 contract: expose server crashes or a corrupt success payload.
      expect(response.status).toBeLessThan(500);
      if (response.status === 200) {
        expect(
          values(response.body).every(
            (value) => typeof value === "number" && Number.isFinite(value),
          ),
        ).toBe(true);
      }
    },
  );
});

describe("Gemini fallback serialization budget", () => {
  it.each(overBudget.map((dimension) => ({ dimension })))(
    "enforces the fallback budget for %j",
    async ({ dimension }) => {
      const mock = await start({}, [
        { match: { inputText: "control", sequenceIndex: 0 }, response: { embedding: [0.5] } },
      ]);
      const response = await post(mock, dimension);
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: {
          code: 400,
          status: "INVALID_ARGUMENT",
          message: "outputDimensionality exceeds the fallback serialization budget of 100000",
        },
      });
      expect(mock.getLastRequest()?.response).toMatchObject({ status: 400, fixture: null });
      expect(await post(mock, 1, "control")).toEqual({
        status: 200,
        body: { embedding: { values: [0.5] } },
      });
    },
  );

  it.each(overBudget.map((dimension) => ({ dimension })))(
    "fixture errors ignore unused dimension %j",
    async ({ dimension }) => {
      const mock = await start({}, [
        {
          match: { inputText: "hello" },
          response: { error: { message: "fixture unavailable", type: "UNAVAILABLE" }, status: 503 },
        },
      ]);
      expect(await post(mock, dimension)).toEqual({
        status: 503,
        body: { error: { code: 503, status: "UNAVAILABLE", message: "fixture unavailable" } },
      });
    },
  );
});

describe("C07 supported controls", () => {
  it.each([
    ["2", 2],
    ["1.5", 2],
    ["1e1", 10],
    [" 2 ", 2],
    [[2], 2],
    [[[2]], 2],
  ])("preserves existing numeric-string coercion %j", async (dimension, width) => {
    const response = await post(await start(), dimension);
    expect(response.status).toBe(200);
    expect(values(response.body)).toHaveLength(width);
    expect(values(response.body).every((value) => typeof value === "number")).toBe(true);
  });

  it.each([[], {}, false].map((dimension) => ({ dimension })))(
    "preserves inert fallback input $dimension",
    async ({ dimension }) => {
      const response = await post(await start(), dimension);
      expect(response).toEqual({ status: 200, body: { embedding: { values: [dimension] } } });
    },
  );

  it.each([
    [undefined, 768],
    [null, 768],
    [1, 1],
    [256, 256],
    [0, 0],
    [100_000, 100_000],
    ["100000", 100_000],
    [[100_000], 100_000],
    [true, 1],
  ])("preserves fallback width %j", async (dimension, width) => {
    const response = await post(await start(), dimension);
    expect(response.status).toBe(200);
    const vector = values(response.body);
    expect(vector).toHaveLength(width);
    expect(vector.every((value) => typeof value === "number" && Number.isFinite(value))).toBe(true);
  });

  it.each(candidates.map((dimension) => ({ dimension })))(
    "fixture replay ignores unused dimension %j",
    async ({ dimension }) => {
      const mock = await start({}, [
        { match: { inputText: "hello", sequenceIndex: 0 }, response: { embedding: [0.25] } },
        { match: { inputText: "hello", sequenceIndex: 1 }, response: { embedding: [0.75] } },
      ]);
      expect(await post(mock, dimension)).toEqual({
        status: 200,
        body: { embedding: { values: [0.25] } },
      });
      expect(await post(mock, 1)).toEqual({ status: 200, body: { embedding: { values: [0.75] } } });
    },
  );

  it.each(candidates.map((dimension) => ({ dimension })))(
    "strict mode bypasses unused dimension %j",
    async ({ dimension }) => {
      const response = await post(await start({ strict: true }), dimension);
      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({ error: { status: "UNAVAILABLE" } });
    },
  );

  it.each(candidates.map((dimension) => ({ dimension })))(
    "chaos bypasses unused dimension %j",
    async ({ dimension }) => {
      const response = await post(await start({ chaos: { rateLimitRate: 1 } }), dimension);
      expect(response.status).toBe(429);
    },
  );

  it.each(candidates.map((dimension) => ({ dimension })))(
    "proxy forwards unused dimension %j",
    async ({ dimension }) => {
      const upstream = await start({}, [
        { match: { inputText: "hello" }, response: { embedding: [0.125] } },
      ]);
      const proxy = await start({
        record: { providers: { gemini: upstream.url }, proxyOnly: true },
      });
      expect(await post(proxy, dimension)).toEqual({
        status: 200,
        body: { embedding: { values: [0.125] } },
      });
      expect(upstream.getRequests()).toHaveLength(1);
      expect(proxy.getLastRequest()?.response.source).toBe("proxy");
    },
  );

  it("fallback failure does not consume an unmatched sequence fixture", async () => {
    const mock = await start({}, [
      { match: { inputText: "control", sequenceIndex: 0 }, response: { embedding: [0.5] } },
    ]);
    await post(mock, -1);
    expect(await post(mock, 1, "control")).toEqual({
      status: 200,
      body: { embedding: { values: [0.5] } },
    });
  });
});
