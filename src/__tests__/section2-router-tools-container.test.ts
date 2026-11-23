import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { LLMock } from "../llmock.js";
import { matchFixture } from "../router.js";
import type { Fixture, MockServerOptions } from "../types.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const routes = [
  "/api/v1/chat/completions",
  "/custom/v1/chat/completions",
  "/openai/deployments/gpt-4o/chat/completions",
];
const shapes = [
  { label: "string", tools: "bad" },
  { label: "empty-string", tools: "" },
  { label: "number", tools: 42 },
  { label: "zero", tools: 0 },
  { label: "object", tools: {} },
  { label: "true", tools: true },
  { label: "false", tools: false },
];
const valid = [{ type: "function", function: { name: "f" } }];
function request(tools: unknown) {
  return { model: "gpt-4o", messages: [{ role: "user", content: "hello" }], tools };
}
async function start(fallback = true, options: MockServerOptions = {}, toolFixtures = true) {
  const mock = new LLMock({ port: 0, ...options });
  cleanup.push(() => mock.stop());
  if (toolFixtures) {
    mock.on({ toolName: "f", sequenceIndex: 0 }, { content: "tool-zero" });
    mock.on({ toolName: "f", sequenceIndex: 1 }, { content: "tool-one" });
  }
  if (fallback) mock.on({ model: "gpt-4o" }, { content: "fallback" });
  await mock.start();
  return mock;
}
async function post(mock: LLMock, path: string, tools: unknown) {
  const response = await fetch(mock.url + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request(tools)),
    signal: AbortSignal.timeout(5000),
  });
  const body: unknown = await response.json();
  const result = { status: response.status, body };
  process.stdout.write(JSON.stringify({ path, tools, ...result }) + "\n");
  return result;
}
function content(result: Awaited<ReturnType<typeof post>>, expected: string) {
  expect(result).toMatchObject({
    status: 200,
    body: { choices: [{ message: { content: expected } }] },
  });
}
for (const path of routes) {
  test.each(shapes)(
    `${path} $label falls through without consuming tool sequence`,
    async ({ tools }) => {
      const mock = await start();
      const malformed = await post(mock, path, tools);
      content(await post(mock, path, valid), "tool-zero");
      content(await post(mock, path, valid), "tool-one");
      content(await post(mock, path, valid), "fallback");
      content(malformed, "fallback");
    },
  );
  test.each([
    { strict: false, status: 404 },
    { strict: true, status: 503 },
  ])(`${path} no fallback strict=$strict`, async ({ strict, status }) => {
    const mock = await start(false, { strict });
    const malformed = await post(mock, path, "bad");
    content(await post(mock, path, valid), "tool-zero");
    expect(malformed.status).toBe(status);
  });
  test(`${path} model-only malformed tools remain accepted`, async () => {
    const mock = await start(true, {}, false);
    for (const { tools } of shapes) content(await post(mock, path, tools), "fallback");
  });
  test(`${path} array entries and missing tools retain fallback`, async () => {
    const mock = await start();
    for (const tools of [
      undefined,
      null,
      [],
      [null],
      ["bad"],
      [42],
      [false],
      [[]],
      [{ type: "function" }],
      [{ type: "function", function: null }],
      [{ function: null }],
      [{ type: "custom", function: null }],
    ]) {
      content(await post(mock, path, tools), "fallback");
    }
    content(await post(mock, path, valid), "tool-zero");
  });
}

test("direct matcher preserves original first fixture, request and diagnostic counts", () => {
  const first: Fixture = {
    match: { toolName: "f", sequenceIndex: 0 },
    response: { content: "first" },
  };
  const second: Fixture = {
    match: { toolName: "f", sequenceIndex: 0 },
    response: { content: "second" },
  };
  const counts = new Map<Fixture, number>();
  // JSON parsing supplies actual runtime inputs without pretending malformed tools satisfy the static type.
  for (const tools of [
    ...shapes.map((shape) => shape.tools),
    undefined,
    null,
    [],
    [{ type: "function" }],
  ]) {
    const body = JSON.parse(JSON.stringify(request(tools)));
    const before = JSON.stringify(body);
    expect(matchFixture([first, second], body, counts)).toBeNull();
    expect(JSON.stringify(body)).toBe(before);
  }
  const body = JSON.parse(JSON.stringify(request(valid)));
  expect(matchFixture([first, second], body, counts)).toBe(first);
  expect(matchFixture([first, second], body, counts)).toBe(first);
  expect(counts.size).toBe(0);
});

test("record miss forwards original malformed tools to real local upstream and preserves tool fixture", async () => {
  const seen: unknown[] = [];
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    seen.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        id: "local",
        object: "chat.completion",
        created: 1,
        model: "gpt-4o",
        choices: [
          { index: 0, message: { role: "assistant", content: "upstream" }, finish_reason: "stop" },
        ],
      }),
    );
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) =>
        upstream.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("Missing upstream port");
  const fixturePath = await mkdtemp(join(tmpdir(), "aimock-router-tools-"));
  cleanup.push(() => rm(fixturePath, { recursive: true, force: true }));
  const mock = await start(false, {
    record: { fixturePath, providers: { openai: `http://127.0.0.1:${address.port}` } },
  });
  const result = await post(mock, routes[1], "bad");
  content(await post(mock, routes[1], valid), "tool-zero");
  content(result, "upstream");
  expect(seen).toEqual([request("bad")]);
});
