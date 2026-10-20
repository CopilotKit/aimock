import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { Ollama } from "ollama";
import { afterEach, expect, test } from "vitest";
import { LLMock } from "../llmock.js";

const mocks: LLMock[] = [];
let upstream: http.Server | undefined;
let directory: string | undefined;

afterEach(async () => {
  for (const mock of mocks.splice(0)) await mock.stop();
  if (upstream?.listening) await new Promise<void>((resolve) => upstream!.close(() => resolve()));
  upstream = undefined;
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

test("Ollama SDK embed preserves ordered batch vectors through recording and offline replay", async () => {
  const expected = {
    model: "nomic-embed-text",
    embeddings: [
      [0.1, 0.2],
      [0.3, 0.4],
    ],
    prompt_eval_count: 7,
  };
  upstream = http.createServer((req, res) => {
    expect(req.url).toBe("/api/embed");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(expected));
  });
  await new Promise<void>((resolve) => upstream!.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("No upstream port");
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-ollama-embed-"));
  const recorder = new LLMock({
    port: 0,
    logLevel: "silent",
    record: { providers: { ollama: `http://127.0.0.1:${address.port}` }, fixturePath: directory },
  });
  mocks.push(recorder);
  await recorder.start();
  const input = { model: "nomic-embed-text", input: ["first", "second"] };
  expect(await new Ollama({ host: recorder.url }).embed(input)).toEqual(expected);
  await recorder.stop();
  mocks.splice(mocks.indexOf(recorder), 1);
  await new Promise<void>((resolve) => upstream!.close(() => resolve()));
  const replay = new LLMock({ port: 0, logLevel: "silent", strict: true });
  replay.loadFixtureDir(directory);
  mocks.push(replay);
  await replay.start();
  expect(await new Ollama({ host: replay.url }).embed(input)).toEqual(expected);
});

test("Ollama recordings distinguish successive input shapes, dimensions and models on disk", async () => {
  const cases = [
    {
      request: { model: "embed", input: ["first", "second"], dimensions: 2 },
      embeddings: [
        [1, 2],
        [3, 4],
      ],
    },
    {
      request: { model: "embed", input: ["first", "second"], dimensions: 3 },
      embeddings: [
        [5, 6, 7],
        [8, 9, 10],
      ],
    },
    { request: { model: "embed", input: "first second", dimensions: 2 }, embeddings: [[11, 12]] },
    {
      request: { model: "embed", input: "first second", dimensions: 3 },
      embeddings: [[13, 14, 15]],
    },
    { request: { model: "embed", input: ["first second"], dimensions: 2 }, embeddings: [[16, 17]] },
    {
      request: { model: "embed", input: ["second", "first"], dimensions: 2 },
      embeddings: [
        [18, 19],
        [20, 21],
      ],
    },
    {
      request: { model: "embed", input: ["first", "second"], dimensions: undefined },
      embeddings: [[22], [23]],
    },
    {
      request: { model: "other", input: ["first", "second"], dimensions: 2 },
      embeddings: [
        [24, 25],
        [26, 27],
      ],
    },
  ];
  let calls = 0;
  upstream = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      calls++;
      const body = JSON.parse(raw);
      const entry = cases.find(
        ({ request }) =>
          request.model === body.model &&
          request.dimensions === body.dimensions &&
          JSON.stringify(request.input) === JSON.stringify(body.input),
      );
      res.writeHead(entry ? 200 : 400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          entry
            ? { model: entry.request.model, embeddings: entry.embeddings }
            : { error: "Unexpected request" },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => upstream!.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("No upstream port");
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-ollama-identity-"));
  const recorder = new LLMock({
    port: 0,
    logLevel: "silent",
    record: {
      providers: { ollama: `http://127.0.0.1:${address.port}` },
      fixturePath: directory,
    },
  });
  mocks.push(recorder);
  await recorder.start();
  const recordingClient = new Ollama({ host: recorder.url });
  for (const entry of cases) {
    expect(await recordingClient.embed(entry.request)).toEqual({
      model: entry.request.model,
      embeddings: entry.embeddings,
    });
  }
  expect(calls).toBe(cases.length);
  // Repeat in reverse order while recording: each request must hit its own cache entry.
  for (const entry of [...cases].reverse()) {
    expect(await recordingClient.embed(entry.request)).toEqual({
      model: entry.request.model,
      embeddings: entry.embeddings,
    });
  }
  expect(calls).toBe(cases.length);
  await recorder.stop();
  mocks.splice(mocks.indexOf(recorder), 1);
  await new Promise<void>((resolve) => upstream!.close(() => resolve()));
  const replay = new LLMock({ port: 0, logLevel: "silent", strict: true });
  replay.loadFixtureDir(directory);
  mocks.push(replay);
  await replay.start();
  const offlineClient = new Ollama({ host: replay.url });
  for (const entry of [...cases].reverse()) {
    expect(await offlineClient.embed(entry.request)).toEqual({
      model: entry.request.model,
      embeddings: entry.embeddings,
    });
  }
  await expect(
    offlineClient.embed({ model: "embed", input: ["first", "second"], dimensions: 4 }),
  ).rejects.toMatchObject({ status_code: 503 });
  await expect(
    offlineClient.embed({ model: "embed", input: ["first", "second third"], dimensions: 2 }),
  ).rejects.toMatchObject({ status_code: 503 });
});

test("Ollama SDK embeds each batch item independently with the requested dimensions", async () => {
  const mock = new LLMock({ port: 0, logLevel: "silent" });
  mocks.push(mock);
  await mock.start();
  const client = new Ollama({ host: mock.url });
  const batch = await client.embed({
    model: "nomic-embed-text",
    input: ["first", "second", "first"],
    dimensions: 8,
  });
  expect(batch.embeddings.map((vector) => vector.length)).toEqual([8, 8, 8]);
  expect(batch.embeddings[0]).toEqual(batch.embeddings[2]);
  expect(batch.embeddings[0]).not.toEqual(batch.embeddings[1]);
  const single = await client.embed({ model: "nomic-embed-text", input: "second", dimensions: 8 });
  expect(single.embeddings).toEqual([batch.embeddings[1]]);
});

test.each([
  { endpoint: "/api/embeddings", legacyFirst: false },
  { endpoint: "/api/embeddings", legacyFirst: true },
  { endpoint: "/v1/embeddings", legacyFirst: false },
  { endpoint: "/v1/embeddings", legacyFirst: true },
])(
  "modern Ollama recordings stay separate from $endpoint, legacyFirst=$legacyFirst",
  async ({ endpoint, legacyFirst }) => {
    const modern = { model: "embed", embeddings: [[0.1, 0.2]] };
    const wide = { model: "embed", embeddings: [[0.7, 0.8, 0.9]] };
    const request = { model: "embed", input: "same text", dimensions: 2 };
    let calls = 0;
    upstream = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        calls++;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify(
            req.url === "/api/embed"
              ? JSON.parse(raw).dimensions === 3
                ? wide
                : modern
              : req.url === "/api/embeddings"
                ? { embedding: [0.3, 0.4] }
                : {
                    object: "list",
                    model: "embed",
                    data: [{ object: "embedding", index: 0, embedding: [0.3, 0.4] }],
                    usage: { prompt_tokens: 1, total_tokens: 1 },
                  },
          ),
        );
      });
    });
    await new Promise<void>((resolve) => upstream!.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("No upstream port");
    const url = `http://127.0.0.1:${address.port}`;
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-ollama-operation-"));
    const recorder = new LLMock({
      port: 0,
      logLevel: "silent",
      record: { providers: { ollama: url, openai: url }, fixturePath: directory },
    });
    mocks.push(recorder);
    await recorder.start();
    if (!legacyFirst)
      expect(await new Ollama({ host: recorder.url }).embed(request)).toEqual(modern);
    const recordingResponse = await fetch(`${recorder.url}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        endpoint === "/api/embeddings" ? { model: "embed", prompt: "same text" } : request,
      ),
    });
    expect(recordingResponse.status).toBe(200);
    const recordingBody = await recordingResponse.json();
    expect(
      endpoint === "/api/embeddings" ? recordingBody.embedding : recordingBody.data[0].embedding,
    ).toEqual([0.3, 0.4]);
    expect(await new Ollama({ host: recorder.url }).embed(request)).toEqual(modern);
    expect(await new Ollama({ host: recorder.url }).embed({ ...request, dimensions: 3 })).toEqual(
      wide,
    );
    expect(calls).toBe(3);
    await recorder.stop();
    mocks.splice(mocks.indexOf(recorder), 1);
    await new Promise<void>((resolve) => upstream!.close(() => resolve()));
    const replay = new LLMock({ port: 0, logLevel: "silent", strict: true });
    replay.loadFixtureDir(directory);
    mocks.push(replay);
    await replay.start();
    const response = await fetch(`${replay.url}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        endpoint === "/api/embeddings" ? { model: "embed", prompt: "same text" } : request,
      ),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(endpoint === "/api/embeddings" ? body.embedding : body.data[0].embedding).toEqual([
      0.3, 0.4,
    ]);
    expect(await new Ollama({ host: replay.url }).embed(request)).toEqual(modern);
    expect(await new Ollama({ host: replay.url }).embed({ ...request, dimensions: 3 })).toEqual(
      wide,
    );
  },
);

test("Ollama request widths keep independent fixture sequences", async () => {
  const mock = new LLMock({ port: 0, logLevel: "silent", strict: true });
  const cases = [
    { dimensions: 2, sequenceIndex: 0, embedding: [0.1, 0.2] },
    { dimensions: 2, sequenceIndex: 1, embedding: [0.3, 0.4] },
    { dimensions: 3, sequenceIndex: 0, embedding: [0.5, 0.6, 0.7] },
    { dimensions: 3, sequenceIndex: 1, embedding: [0.8, 0.9, 1.0] },
  ];
  for (const entry of cases) {
    mock.addFixture({
      match: {
        endpoint: "embedding",
        inputText: "same text",
        sequenceIndex: entry.sequenceIndex,
        embeddingRequest: {
          operation: "/api/embed",
          input: "same text",
          dimensions: entry.dimensions,
        },
      },
      response: { embedding: entry.embedding },
    });
  }
  mocks.push(mock);
  await mock.start();
  const client = new Ollama({ host: mock.url });
  for (const index of [0, 2, 1, 3]) {
    const entry = cases[index];
    expect(
      (await client.embed({ model: "embed", input: "same text", dimensions: entry.dimensions }))
        .embeddings,
    ).toEqual([entry.embedding]);
  }
});

test.each([
  { input: ["first", 2] },
  { input: [[1, 2], "second"] },
  { input: { text: "first" } },
  { input: true },
  { input: "first", model: 42 },
  { input: "first", dimensions: -1 },
  { input: "first", dimensions: 0 },
  { input: "first", dimensions: 1.5 },
  { input: "first", dimensions: 100001 },
])("Ollama current embeddings reject invalid input %j", async (fields) => {
  const mock = new LLMock({ port: 0, logLevel: "silent" });
  mocks.push(mock);
  await mock.start();
  const response = await fetch(`${mock.url}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "nomic-embed-text", ...fields }),
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: expect.any(String) });
});

test("Ollama SDK fixture batches and legacy embedding keep their own response shapes", async () => {
  const mock = new LLMock({ port: 0, logLevel: "silent", strict: true });
  mock.addFixture({
    match: { endpoint: "embedding", inputText: "first second" },
    response: { embedding: [0.1, 0.2] },
  });
  mocks.push(mock);
  await mock.start();
  const client = new Ollama({ host: mock.url });
  expect(
    (await client.embed({ model: "nomic-embed-text", input: ["first", "second"] })).embeddings,
  ).toEqual([
    [0.1, 0.2],
    [0.1, 0.2],
  ]);
  expect(
    (await client.embeddings({ model: "nomic-embed-text", prompt: "first second" })).embedding,
  ).toEqual([0.1, 0.2]);
  await expect(client.embed({ model: "nomic-embed-text", input: "missing" })).rejects.toMatchObject(
    { status_code: 503 },
  );
});

test("Ollama current endpoint matches input even when a legacy prompt is also supplied", async () => {
  const mock = new LLMock({ port: 0, logLevel: "silent", strict: true });
  mock.addFixture({ match: { inputText: "current" }, response: { embedding: [0.25] } });
  mocks.push(mock);
  await mock.start();
  const response = await fetch(`${mock.url}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "nomic-embed-text", input: "current", prompt: "legacy" }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ model: "nomic-embed-text", embeddings: [[0.25]] });
});

test("Ollama SDK receives a fixture error message and status on the current endpoint", async () => {
  const mock = new LLMock({ port: 0, logLevel: "silent", strict: true });
  mock.addFixture({
    match: { inputText: "failure" },
    response: {
      error: { message: "embedding unavailable", type: "server_error" },
      status: 429,
      retryAfter: 2,
    },
  });
  mocks.push(mock);
  await mock.start();
  await expect(
    new Ollama({ host: mock.url }).embed({ model: "nomic-embed-text", input: "failure" }),
  ).rejects.toMatchObject({ message: "embedding unavailable", status_code: 429 });
});

test("legacy Ollama fixture errors retain their existing envelope", async () => {
  const mock = new LLMock({ port: 0, logLevel: "silent", strict: true });
  mock.addFixture({
    match: { inputText: "legacy failure" },
    response: { error: { message: "legacy unavailable", type: "server_error" }, status: 429 },
  });
  mocks.push(mock);
  await mock.start();
  const response = await fetch(`${mock.url}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "nomic-embed-text", prompt: "legacy failure" }),
  });
  expect(response.status).toBe(429);
  expect(await response.json()).toEqual({
    error: { message: "legacy unavailable", type: "server_error", param: null, code: null },
  });
});
