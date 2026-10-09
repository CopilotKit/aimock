import OpenAI from "openai";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createServer } from "../server.js";
import { LLMock } from "../llmock.js";
import { DEFAULT_TEST_ID } from "../journal.js";
import type { Fixture, FixtureResponse, MisbehaviorConfig } from "../types.js";

const mocks: LLMock[] = [];
afterEach(async () => {
  await Promise.all(mocks.splice(0).map((mock) => mock.stop()));
  vi.restoreAllMocks();
});
const outputs: { name: string; response: FixtureResponse }[] = [
  { name: "text", response: { content: "hello" } },
  { name: "tool", response: { toolCalls: [{ name: "weather", arguments: '{"city":"Paris"}' }] } },
  {
    name: "combined",
    response: { content: "hello", toolCalls: [{ name: "weather", arguments: '{"city":"Paris"}' }] },
  },
  {
    name: "blocks",
    response: {
      blocks: [
        { type: "toolCall", name: "weather", arguments: '{"city":"Paris"}' },
        { type: "text", text: "hello" },
      ],
    },
  },
];
async function setup(
  response: FixtureResponse,
  config?: MisbehaviorConfig,
  baseline?: MisbehaviorConfig,
) {
  const mock = new LLMock({ port: 0, logLevel: "silent", misbehavior: baseline });
  mocks.push(mock);
  let calls = 0;
  mock.addFixture({
    match: { userMessage: "hello" },
    response: () => {
      calls++;
      return response;
    },
    misbehavior: config,
  });
  const url = await mock.start();
  return {
    mock,
    url,
    calls: () => calls,
    client: new OpenAI({ apiKey: "local", baseURL: `${url}/v1`, maxRetries: 0 }),
  };
}
async function request(url: string, stream: boolean, header?: string) {
  const result = await fetch(`${url}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(header === undefined ? {} : { "x-aimock-misbehavior": header }),
    },
    body: JSON.stringify({ model: "gpt-4o", input: "hello", stream }),
    signal: AbortSignal.timeout(5000),
  });
  const body = await result.text();
  console.log(JSON.stringify({ stream, header, status: result.status, body }));
  return { status: result.status, body };
}
const config: MisbehaviorConfig = { faults: [{ fault: "refusal", rate: 1, times: 1 }] };
describe.each([false, true])("Responses inherited guard transition stream=%s", (stream) => {
  test.each(outputs)(
    "applies explicit fixture on $name with one journal entry",
    async ({ response }) => {
      const ctx = await setup(response, config);
      const result = await request(ctx.url, stream);
      expect(result.status).toBe(200);
      expect(result.body).toContain("refusal");
      expect(ctx.calls()).toBe(1);
      expect(ctx.mock.getRequests()).toHaveLength(1);
      expect(ctx.mock.getRequests()[0].response).toMatchObject({
        status: 200,
        misbehavior: {
          wire: "openai-responses",
          source: "fixture",
          applied: true,
          servedToolCalls: [],
          evaluations: [{ entryIndex: 0, fault: "refusal", outcome: "applied", ordinal: 0 }],
        },
      });
    },
  );
  test.each(outputs)(
    "baseline applies on $name with one observation and one roll",
    async ({ response }) => {
      const ctx = await setup(response, undefined, config);
      expect((await request(ctx.url, stream)).status).toBe(200);
      expect(ctx.calls()).toBe(1);
      expect(ctx.mock.getRequests()).toHaveLength(1);
      expect(ctx.mock.getRequests()[0].response.misbehavior).toMatchObject({
        source: "server",
        applied: true,
        evaluations: [{ entryIndex: 0, fault: "refusal", outcome: "applied", ordinal: 0 }],
      });
      expect(ctx.mock.getRequests()[0].response.misbehavior?.evaluations[0]).toHaveProperty(
        "ordinal",
        0,
      );
    },
  );
  test("supported header applies and inapplicable or malformed errors remain native", async () => {
    const ctx = await setup({ content: "hello" }, undefined, config);
    expect((await request(ctx.url, stream, "refusal")).status).toBe(200);
    const inapplicable = await request(ctx.url, stream, "tool-args-invalid-json");
    expect(inapplicable.status).toBe(501);
    expect(JSON.parse(inapplicable.body).error.code).toBe("aimock_misbehavior_not_applicable");
    const invalid = await request(ctx.url, stream, "typo");
    expect(invalid.status).toBe(400);
    expect(JSON.parse(invalid.body)).toMatchObject({
      error: { code: "aimock_misbehavior_invalid" },
    });
    expect(ctx.mock.getRequests().map((entry) => entry.response.status)).toEqual([200, 501, 400]);
  });
  test("provider exclusion preserves success", async () => {
    const ctx = await setup(
      { content: "hello" },
      { faults: [{ fault: "refusal", providers: ["openai-chat"] }] },
    );
    expect((await request(ctx.url, stream)).status).toBe(200);
    expect(ctx.mock.getRequests()[0].response.misbehavior?.evaluations).toEqual([
      { entryIndex: 0, fault: "refusal", outcome: "skipped", reason: "provider-excluded" },
    ]);
  });
  test.each(outputs)("no config preserves $name", async ({ response }) => {
    const ctx = await setup(response);
    expect((await request(ctx.url, stream)).status).toBe(200);
    expect(ctx.calls()).toBe(1);
    expect(ctx.mock.getRequests()).toHaveLength(1);
    expect(ctx.mock.getRequests()[0].response).not.toHaveProperty("misbehavior");
  });
});
test("official OpenAI SDK retains native applicability 501 without retries", async () => {
  const ctx = await setup({ content: "hello" }, { faults: [{ fault: "tool-args-invalid-json" }] });
  await expect(
    ctx.client.responses.create({ model: "gpt-4o", input: "hello" }),
  ).rejects.toMatchObject({ status: 501, code: "aimock_misbehavior_not_applicable" });
  expect(ctx.calls()).toBe(1);
});

test("runtime times budget fires once then skips without another rate ordinal", async () => {
  const mock = new LLMock({ port: 0, logLevel: "silent", metrics: true });
  mocks.push(mock);
  mock.addFixture({ match: { userMessage: "hello" }, response: { content: "hello" } });
  const url = await mock.start();
  const control = await fetch(`${url}/__aimock/misbehavior`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(config),
  });
  expect(control.status).toBe(200);
  for (const stream of [false, true]) expect((await request(url, stream)).status).toBe(200);
  const entries = mock.getRequests().filter((entry) => entry.path === "/v1/responses");
  expect(entries).toHaveLength(2);
  expect(entries.map((entry) => entry.response.misbehavior?.source)).toEqual(["scope", "scope"]);
  const key = { testId: DEFAULT_TEST_ID, sourceKey: `scope:${DEFAULT_TEST_ID}`, entryIndex: 0 };
  expect(mock.journal.getFiringCount(key)).toBe(1);
  expect(mock.journal.nextOrdinal(key)).toBe(1);
  const metrics = await (await fetch(`${url}/metrics`)).text();
  expect(metrics).toContain(
    'aimock_misbehavior_total{fault="refusal",outcome="applied",wire="openai-responses"} 1',
  );
});

test("ambiguous static fixture applies on the supported Responses wire", async () => {
  const mock = new LLMock({ port: 0, logLevel: "silent" });
  mocks.push(mock);
  mock.addFixture({
    match: { userMessage: "hello" },
    response: { content: "hello" },
    misbehavior: config,
  });
  expect((await request(await mock.start(), false)).status).toBe(200);
  expect(mock.getRequests()).toHaveLength(1);
});

test("factory error response uses applicability and baseline preserves native status", async () => {
  const response = { error: { message: "fixture failure", type: "server_error" }, status: 503 };
  const explicit = await setup(response, config);
  const result = await request(explicit.url, false);
  expect(result.status).toBe(501);
  expect(JSON.parse(result.body)).toMatchObject({
    error: { code: "aimock_misbehavior_not_applicable" },
  });
  const scoped = await setup(response, undefined, config);
  expect((await request(scoped.url, false)).status).toBe(503);
  expect(scoped.mock.getRequests()).toHaveLength(1);
  expect(scoped.mock.getRequests()[0].response.misbehavior?.reason).toBe("not-applicable");
  expect(explicit.calls()).toBe(1);
  expect(scoped.calls()).toBe(1);
});

describe("review corrections on real Responses HTTP", () => {
  test.each([true, false])(
    "unknown factory output retains fallback status and scoped observation configured=%s",
    async (configured) => {
      const ctx = await setup(
        { embedding: [0.1, 0.2] },
        undefined,
        configured ? config : undefined,
      );
      const result = await request(ctx.url, false);
      expect(result.status).toBe(500);
      expect(JSON.parse(result.body)).toMatchObject({
        error: { type: "server_error", message: "Fixture response did not match any known type" },
      });
      expect(ctx.calls()).toBe(1);
      expect(ctx.mock.getRequests()).toHaveLength(1);
      const entry = ctx.mock.getRequests()[0];
      console.log("U2 fallback journal", JSON.stringify(entry.response));
      if (configured) {
        expect(entry.response.misbehavior).toMatchObject({
          applied: false,
          source: "server",
          wire: "openai-responses",
          evaluations: [
            { entryIndex: 0, fault: "refusal", outcome: "skipped", reason: "not-applicable" },
          ],
        });
        const key = { testId: DEFAULT_TEST_ID, sourceKey: "server", entryIndex: 0 };
        expect(ctx.mock.journal.getFiringCount(key)).toBe(0);
        expect(ctx.mock.journal.nextOrdinal(key)).toBe(0);
      } else expect(entry.response).not.toHaveProperty("misbehavior");
    },
  );

  test.each([true, false])(
    "direct fixture error logs exactly once malformed=%s",
    async (malformed) => {
      const fixture: Fixture = {
        match: { userMessage: "hello" },
        response: { content: "hello" },
        misbehavior: malformed
          ? Object.assign({ faults: [] }, { typo: true })
          : { faults: [{ fault: "tool-args-invalid-json" }] },
      };
      const server = await createServer([fixture], { port: 0, logLevel: "warn", metrics: true });
      const errors = vi.spyOn(console, "error");
      try {
        const result = await request(server.url, false);
        expect(result.status).toBe(501);
        const body = JSON.parse(result.body);
        expect(body.error.code).toBe("aimock_misbehavior_not_applicable");
        const journal = server.journal.getAll();
        console.log("U2 direct journal", JSON.stringify(journal));
        expect(journal).toHaveLength(1);
        expect(journal[0].response.status).toBe(501);
        expect(errors).toHaveBeenCalledTimes(1);
        if (malformed) {
          expect(journal[0].response.misbehavior).toEqual({
            applied: false,
            source: "fixture",
            wire: "openai-responses",
            evaluations: [],
          });
          expect(errors.mock.calls[0].join(" ")).toContain(body.error.message);
          const metrics = await (await fetch(`${server.url}/metrics`)).text();
          expect(metrics).not.toContain("aimock_misbehavior_total{");
        }
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );
});

test("permanent Responses refusal category restriction stays native and scoped", async () => {
  const category: MisbehaviorConfig = { faults: [{ fault: "refusal", category: "safety" }] };
  const ctx = await setup({ content: "hello" }, undefined, category);
  const explicit = await request(ctx.url, false, "refusal;category=safety");
  expect(explicit.status).toBe(501);
  expect(JSON.parse(explicit.body)).toMatchObject({
    error: { code: "aimock_misbehavior_unsupported" },
  });
  expect((await request(ctx.url, false)).status).toBe(200);
  expect(ctx.mock.getRequests()).toHaveLength(2);
  expect(ctx.mock.getRequests()[1].response.misbehavior).toMatchObject({
    applied: false,
    reason: "unsupported-on-wire",
    evaluations: [
      { entryIndex: 0, fault: "refusal", outcome: "skipped", reason: "unsupported-on-wire" },
    ],
  });
});
