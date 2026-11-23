import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LLMock } from "../llmock.js";
import type { MockServerOptions } from "../types.js";

const mocks: LLMock[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(mocks.splice(0).map((mock) => mock.stop()));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function start(options: MockServerOptions = {}) {
  const mock = new LLMock({ ...options, port: 0 });
  mocks.push(mock);
  await mock.start();
  return mock;
}

const malformed = [
  { label: "string", tools: "bad" },
  { label: "empty string", tools: "" },
  { label: "number", tools: 42 },
  { label: "zero", tools: 0 },
  { label: "object", tools: {} },
  { label: "true", tools: true },
  { label: "false", tools: false },
  { label: "null entry", tools: [null] },
  { label: "string entry", tools: ["bad"] },
  { label: "number entry", tools: [42] },
  { label: "boolean entry", tools: [false] },
  { label: "array entry", tools: [[]] },
  { label: "null function", tools: [{ type: "function", function: null }] },
  { label: "untyped null function", tools: [{ function: null }] },
  { label: "custom null function", tools: [{ type: "custom", function: null }] },
];
const nested = [{ type: "function", function: { name: "f" } }];
const supported = [
  { label: "absent", tools: undefined },
  { label: "null", tools: null },
  { label: "empty", tools: [] },
  { label: "shorthand", tools: [{ type: "function" }] },
  { label: "nested", tools: nested },
  { label: "inert function metadata", tools: [{ type: "function", function: "inert" }] },
  { label: "custom", tools: [{ type: "custom", name: "f" }] },
];

async function post(mock: LLMock, tools: unknown, path = "/v1/chat/completions") {
  const response = await fetch(mock.url + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hello" }],
      tools,
    }),
    signal: AbortSignal.timeout(5000),
  });
  const body: unknown = await response.json();
  const result = { status: response.status, body };
  process.stdout.write(`${JSON.stringify({ path, tools, ...result })}\n`);
  return result;
}

function expectContent(result: Awaited<ReturnType<typeof post>>, content: string) {
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ choices: [{ message: { content } }] });
}

function expectInvalid(result: Awaited<ReturnType<typeof post>>) {
  expect(result.status).toBe(400);
  expect(result.body).toMatchObject({
    error: { type: "invalid_request_error", message: expect.stringContaining("tools") },
  });
}

async function startRecording() {
  const upstream = await start();
  upstream.on({ model: "gpt-4o" }, { content: "upstream" });
  const fixturePath = await mkdtemp(join(tmpdir(), "section2-chat-tools-"));
  directories.push(fixturePath);
  const mock = await start({ record: { providers: { openai: upstream.url }, fixturePath } });
  return { mock, upstream };
}

for (const fixtureKind of ["model", "toolName"] as const) {
  describe(`${fixtureKind} sequence fixture`, () => {
    test.each(malformed)("rejects $label before matching", async ({ tools }) => {
      const mock = await start();
      mock.on(
        {
          ...(fixtureKind === "model" ? { model: "gpt-4o" } : { toolName: "f" }),
          sequenceIndex: 0,
        },
        { content: "sentinel-zero" },
      );
      const invalid = await post(mock, tools);
      const following = await post(mock, nested);
      process.stdout.write(
        `${JSON.stringify({ journal: mock.getRequests().map((entry) => entry.response) })}\n`,
      );
      expectInvalid(invalid);
      expectContent(following, "sentinel-zero");
      expect(mock.getRequests()[0].response).toMatchObject({ status: 400, fixture: null });
    });
  });
}

test.each(malformed)("rejects $label before strict no-match", async ({ tools }) => {
  expectInvalid(await post(await start({ strict: true }), tools));
});

test.each(malformed)("rejects $label before proxy", async ({ tools }) => {
  const { mock, upstream } = await startRecording();
  const invalid = await post(mock, tools);
  process.stdout.write(`${JSON.stringify({ upstreamRequests: upstream.getRequests().length })}\n`);
  expectInvalid(invalid);
  expect(upstream.getRequests()).toHaveLength(0);
});

test.each(supported)("preserves native $label", async ({ tools }) => {
  const mock = await start();
  mock.on({ model: "gpt-4o" }, { content: "supported" });
  expectContent(await post(mock, tools), "supported");
});

for (const path of [
  "/api/v1/chat/completions",
  "/custom/v1/chat/completions",
  "/openai/deployments/gpt-4o/chat/completions",
]) {
  test.each([...malformed, ...supported])(
    `preserves compatible $label at ${path}`,
    async ({ tools }) => {
      const mock = await start();
      mock.on({ model: "gpt-4o" }, { content: "compatible" });
      expectContent(await post(mock, tools, path), "compatible");
    },
  );
}

test("native query string does not bypass tools validation", async () => {
  const mock = await start();
  mock.on({ model: "gpt-4o" }, { content: "unexpected" });
  expectInvalid(await post(mock, "bad", "/v1/chat/completions?test=1"));
});

test("valid native tools retain strict no-match", async () => {
  expect((await post(await start({ strict: true }), nested)).status).toBe(503);
});

test("valid native tools retain proxy forwarding", async () => {
  const { mock, upstream } = await startRecording();
  expectContent(await post(mock, nested), "upstream");
  expect(upstream.getRequests()).toHaveLength(1);
});
