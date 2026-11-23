import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LLMock } from "../llmock.js";
import type { MockServerOptions } from "../types.js";

const servers: LLMock[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function start(fixture = false, options: MockServerOptions = {}) {
  const mock = new LLMock({ port: 0, logLevel: "silent", ...options });
  servers.push(mock);
  if (fixture)
    mock.addFixtures([
      { match: { inputText: "hello", sequenceIndex: 0 }, response: { embedding: [0.1, 0.2] } },
      { match: { inputText: "hello" }, response: { embedding: [0.3, 0.4] } },
    ]);
  await mock.start();
  return mock;
}

async function post(mock: LLMock, value: unknown) {
  const request = {
    model: "embed-v4.0",
    texts: ["hello"],
    input_type: "search_document",
    ...(value === undefined ? {} : { embedding_types: value }),
  };
  const response = await fetch(mock.url + "/v2/embed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(5000),
  });
  const result = { status: response.status, body: await response.json() };
  process.stdout.write(JSON.stringify({ request, ...result }) + "\n");
  return result;
}

for (const fixture of [false, true]) {
  test.each([
    ...["float", "int8", 7, {}, "", 0, false].map((value) => ({
      value,
      message: "Invalid request: embedding_types must be an array",
    })),
    ...[[7], [null], [{}], [false], [["float"]], ["float", 7]].map((value) => ({
      value,
      message: "Invalid request: embedding_types must be an array of strings",
    })),
  ])(`rejects consumed invalid selector $value fixture=${fixture}`, async ({ value, message }) => {
    const mock = await start(fixture);
    const invalid = await post(mock, value);
    const entry = mock.getLastRequest();
    const valid = await post(mock, ["float"]);
    if (fixture) expect(valid.body.embeddings.float).toEqual([[0.3, 0.4]]);
    else expect(valid.body.embeddings.float[0]).toHaveLength(1024);
    expect(invalid.status).toBe(400);
    expect(invalid.body).toEqual({
      error: {
        message,
        type: "invalid_request_error",
      },
    });
    expect(entry?.response.status).toBe(400);
    if (fixture) expect(entry?.response.fixture?.response).toEqual({ embedding: [0.1, 0.2] });
    else expect(entry?.response.fixture).toBeNull();
  });
  test.each([
    { name: "omitted", value: undefined, keys: ["float"] },
    { name: "null", value: null, keys: ["float"] },
    { name: "empty", value: [], keys: ["float"] },
    { name: "float", value: ["float"], keys: ["float"] },
    {
      name: "multiple and extension",
      value: ["float", "int8", "uint8", "binary", "ubinary", "custom"],
      keys: ["float", "int8", "uint8", "binary", "ubinary", "custom"],
    },
  ])(`preserves $name fixture=${fixture}`, async ({ value, keys }) => {
    const mock = await start(fixture);
    const result = await post(mock, value);
    const control = await post(mock, ["float"]);
    expect(result.status).toBe(200);
    expect(Object.keys(result.body.embeddings)).toEqual(keys);
    for (const key of keys)
      expect(result.body.embeddings[key]).toEqual(
        fixture ? [[0.1, 0.2]] : control.body.embeddings.float,
      );
    if (fixture) expect(control.body.embeddings.float).toEqual([[0.3, 0.4]]);
    else expect(control.body.embeddings.float[0]).toHaveLength(1024);
  });
}

test.each([{ value: "float" }, { value: [7] }])(
  "preserves explicit error fixtures when selector $value is not consumed",
  async ({ value }) => {
    const mock = await start();
    mock.addFixtures([
      {
        match: { inputText: "hello" },
        response: { status: 429, error: { message: "chosen error", type: "test_error" } },
      },
    ]);
    const result = await post(mock, value);
    expect(result.status).toBe(429);
    expect(result.body.error.message).toBe("chosen error");
  },
);

test.each([{ value: "float" }, { value: [7] }])(
  "preserves strict no-match when selector $value is not consumed",
  async ({ value }) => {
    const mock = await start(false, { strict: true });
    const result = await post(mock, value);
    expect(result.status).toBe(503);
    expect(result.body.error.message).toContain("Strict mode");
  },
);

test.each([{ value: "float" }, { value: [7] }])(
  "preserves real record proxy when selector $value is not consumed",
  async ({ value }) => {
    const upstream = await start();
    upstream.addFixtures([
      {
        match: { inputText: "hello" },
        response: { status: 429, error: { message: "upstream sentinel", type: "test_error" } },
      },
    ]);
    const fixturePath = await mkdtemp(join(tmpdir(), "cohere-selector-"));
    directories.push(fixturePath);
    const mock = await start(false, {
      record: { providers: { cohere: upstream.url }, fixturePath },
    });
    const result = await post(mock, value);
    expect(result.status).toBe(502);
    expect(result.body.error.message).toBe("upstream sentinel");
    expect(upstream.getRequests()).toHaveLength(1);
  },
);
