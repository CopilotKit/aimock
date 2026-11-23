import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { LLMock } from "../llmock.js";
import { handleEmbeddings } from "../embeddings.js";
import { generateDeterministicEmbedding } from "../helpers.js";
import { Journal } from "../journal.js";
import { Logger } from "../logger.js";

let mock: LLMock | undefined;
afterEach(async () => {
  await mock?.stop();
  mock = undefined;
});
const vector = [0.125, -0.25, 0.5];
async function startEmbeddingMock(fixture: boolean) {
  mock = new LLMock({ port: 0, logLevel: "silent" });
  if (fixture) {
    mock.addFixture({
      match: { inputText: "hello", sequenceIndex: 0 },
      response: { embedding: vector },
    });
  }
  await mock.start();
  return mock;
}
async function postEmbedding(url: string, input: unknown = "hello", model?: string) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input, dimensions: 3, ...(model === undefined ? {} : { model }) }),
    signal: AbortSignal.timeout(5000),
  });
  const body: unknown = await response.json();
  return { status: response.status, body };
}
function embeddingBody(inputs: string[], model?: string, fixture = false) {
  return {
    object: "list",
    data: inputs.map((input, index) => ({
      object: "embedding",
      index,
      embedding: fixture ? vector : generateDeterministicEmbedding(input, 3),
    })),
    ...(model === undefined ? {} : { model }),
    usage: { prompt_tokens: 0, total_tokens: 0 },
  };
}

describe.each([false, true])("native embedding model, fixture=%s", (fixture) => {
  it.each(["/v1/embeddings", "/v1/embeddings?probe=1"])(
    "rejects missing model before consuming fixtures on %s",
    async (path) => {
      const server = await startEmbeddingMock(fixture);
      const invalid = await postEmbedding(server.url + path);
      expect(invalid).toEqual({
        status: 400,
        body: {
          error: { message: "Missing required parameter: 'model'", type: "invalid_request_error" },
        },
      });
      expect(server.journal.fixtureMatchCounts.size).toBe(0);
      expect(server.getLastRequest()).toMatchObject({
        path,
        body: null,
        response: { status: 400, fixture: null },
      });
      const valid = await postEmbedding(server.url + path, "hello", "explicit-model");
      expect(valid).toEqual({
        status: 200,
        body: embeddingBody(["hello"], "explicit-model", fixture),
      });
      expect([...server.journal.fixtureMatchCounts.values()]).toEqual(fixture ? [1] : []);
    },
  );
});

const aliases = [
  {
    path: "/openai/deployments/test-deployment/embeddings?api-version=2024-02-01",
    model: "test-deployment",
  },
  { path: "/compatible/embeddings", model: undefined },
  { path: "/openai/v1/embeddings", model: undefined },
];
describe.each([false, true])("embedding aliases, fixture=%s", (fixture) => {
  it.each(aliases)("preserves omitted and explicit models on $path", async ({ path, model }) => {
    const server = await startEmbeddingMock(fixture);
    expect(await postEmbedding(server.url + path)).toEqual({
      status: 200,
      body: embeddingBody(["hello"], model, fixture),
    });
    expect(await postEmbedding(server.url + path, "hello", "explicit-model")).toEqual({
      status: 200,
      body: embeddingBody(["hello"], "explicit-model"),
    });
  });
});
it.each([
  { input: "", normalized: [""] },
  { input: [], normalized: [] },
  { input: [""], normalized: [""] },
  { input: [[]], normalized: [""] },
  { input: [1, 2], normalized: ["1 2"] },
  { input: [[1, 2], [3]], normalized: ["1 2", "3"] },
])("preserves supported input $input with explicit model", async ({ input, normalized }) => {
  const server = await startEmbeddingMock(false);
  expect(await postEmbedding(server.url + "/v1/embeddings", input, "explicit-model")).toEqual({
    status: 200,
    body: embeddingBody(normalized, "explicit-model"),
  });
});

it("preserves omitted model for existing public handler calls", async () => {
  const journal = new Journal();
  const server = createServer(async (req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    for await (const chunk of req) raw += chunk;
    await handleEmbeddings(
      req,
      res,
      raw,
      [],
      journal,
      {
        latency: 0,
        chunkSize: 10,
        replaySpeed: 1,
        logger: new Logger("silent"),
      },
      () => {},
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP listener");
    expect(await postEmbedding(`http://127.0.0.1:${address.port}/v1/embeddings`)).toEqual({
      status: 200,
      body: embeddingBody(["hello"]),
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
