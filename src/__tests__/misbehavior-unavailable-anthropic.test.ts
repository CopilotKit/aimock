import { afterEach, expect, test, vi } from "vitest";
import { createServer } from "../server.js";
import { LLMock } from "../llmock.js";
import type { FixtureResponse, MisbehaviorConfig } from "../types.js";

let mock: LLMock | undefined;
afterEach(async () => {
  await mock?.stop();
  mock = undefined;
});

const tool = { id: "toolu_guard", name: "weather", arguments: '{"city":"Paris"}' };
const outputs = [
  { name: "text", response: { content: "Sunny" } },
  { name: "tools", response: { toolCalls: [tool] } },
  { name: "mixed", response: { content: "Sunny", toolCalls: [tool] } },
  {
    name: "blocks",
    response: {
      blocks: [
        { type: "text", text: "Sunny" },
        { type: "toolCall", ...tool },
      ],
    },
  },
] satisfies { name: string; response: FixtureResponse }[];
const cells = outputs.flatMap((output) => [false, true].map((stream) => ({ ...output, stream })));
const config: MisbehaviorConfig = { faults: [{ fault: "content-filter", rate: 0, times: 1 }] };

async function serve(
  response: FixtureResponse,
  stream: boolean,
  source: "fixture" | "header" | "server" | "scope" | "none" | "excluded" | "invalid",
  factory = true,
) {
  let calls = 0;
  mock = new LLMock({ port: 0, logLevel: "silent", metrics: true, latency: 0 });
  mock.addFixture({
    match: { userMessage: "weather" },
    response: factory
      ? () => {
          calls++;
          return response;
        }
      : response,
    ...(source === "fixture" ? { misbehavior: config } : {}),
    ...(source === "excluded"
      ? {
          misbehavior: {
            faults: [{ fault: "content-filter", providers: ["openai-chat"] }],
          } satisfies MisbehaviorConfig,
        }
      : {}),
  });
  if (source === "server" || source === "invalid") mock.setMisbehavior(config);
  const url = await mock.start();
  if (source === "scope") {
    const installed = await fetch(`${url}/__aimock/misbehavior`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-id": "anthropic-guard" },
      body: JSON.stringify(config),
    });
    expect(installed.status).toBe(200);
  }
  const result = await fetch(`${url}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-test-id": "anthropic-guard",
      ...(source === "header" ? { "x-aimock-misbehavior": "content-filter; rate=0" } : {}),
      ...(source === "invalid" ? { "x-aimock-misbehavior": "not-a-fault" } : {}),
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 64,
      messages: [{ role: "user", content: "weather" }],
      stream,
    }),
  });
  const body = await result.text();
  const entries = mock.getRequests();
  const metrics = await (await fetch(`${url}/metrics`)).text();
  console.log(
    JSON.stringify({ source, stream, response, status: result.status, body, calls, entries }),
  );
  return { status: result.status, body, calls, entries, metrics };
}

// Permanent K8 exclusion retains stage1 native errors and scoped skips.
// Supported empty responses have positive proof in misbehavior-anthropic.test.ts.
test.each(cells)(
  "explicit fixture unavailable: $name stream=$stream",
  async ({ response, stream }) => {
    const result = await serve(response, stream, "fixture");
    expect(result.status).toBe(501);
    expect(JSON.parse(result.body)).toMatchObject({
      type: "error",
      error: { type: "api_error", code: "aimock_misbehavior_unsupported" },
    });
    expect(result.calls).toBe(1);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.response).toMatchObject({
      status: 501,
      misbehavior: {
        applied: false,
        wire: "anthropic",
        source: "fixture",
        reason: "unsupported-on-wire",
        evaluations: [
          {
            entryIndex: 0,
            fault: "content-filter",
            outcome: "error",
            reason: "unsupported-on-wire",
          },
        ],
      },
    });
    expect(result.entries[0]?.response.misbehavior?.evaluations[0]).not.toHaveProperty("ordinal");
    expect(result.metrics).toContain('outcome="error:unsupported-on-wire",wire="anthropic"} 1');
  },
);

test.each(cells)(
  "runtime unavailable skips: $name stream=$stream",
  async ({ response, stream }) => {
    const result = await serve(response, stream, "scope");
    expect(result.status).toBe(200);
    expect(result.calls).toBe(1);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.response.misbehavior).toMatchObject({
      applied: false,
      source: "scope",
      reason: "unsupported-on-wire",
      evaluations: [
        {
          entryIndex: 0,
          fault: "content-filter",
          outcome: "skipped",
          reason: "unsupported-on-wire",
        },
      ],
    });
    expect(result.entries[0]?.response.misbehavior?.evaluations[0]).not.toHaveProperty("ordinal");
    expect(result.body).toContain(stream ? "message_stop" : '"type":"message"');
    expect(result.metrics).toContain('outcome="skipped:unsupported-on-wire",wire="anthropic"} 1');
  },
);

test("header unavailable is explicit even at rate zero", async () => {
  const result = await serve({ content: "Sunny" }, true, "header");
  expect(result.status).toBe(501);
  expect(result.entries).toHaveLength(1);
  expect(result.entries[0]?.response.misbehavior).toMatchObject({
    source: "header",
    reason: "unsupported-on-wire",
  });
});

test("server unavailable skips without spending a roll", async () => {
  const result = await serve({ content: "Sunny" }, false, "server");
  expect(result.status).toBe(200);
  expect(result.entries).toHaveLength(1);
  expect(result.entries[0]?.response.misbehavior).toMatchObject({
    source: "server",
    reason: "unsupported-on-wire",
  });
  expect(result.entries[0]?.response.misbehavior?.evaluations[0]).not.toHaveProperty("ordinal");
});

test("provider exclusion precedes unsupported rejection", async () => {
  const result = await serve({ content: "Sunny" }, false, "excluded");
  expect(result.status).toBe(200);
  expect(result.entries).toHaveLength(1);
  expect(result.entries[0]?.response.misbehavior).toMatchObject({ reason: "provider-excluded" });
});

test("malformed header cannot hide behind a server skip", async () => {
  const result = await serve({ content: "Sunny" }, false, "invalid");
  expect(result.status).toBe(400);
  expect(result.body).toContain("aimock_misbehavior_invalid");
  expect(result.calls).toBe(0);
  expect(result.entries).toHaveLength(1);
});

test.each(cells)(
  "no config preserves output: $name stream=$stream",
  async ({ response, stream }) => {
    const result = await serve(response, stream, "none");
    expect(result.status).toBe(200);
    expect(result.calls).toBe(1);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.response).not.toHaveProperty("misbehavior");
    expect(result.metrics).not.toContain("aimock_misbehavior_total{");
    expect(result.body).toContain(stream ? "message_stop" : '"type":"message"');
  },
);

test("an endpoint-ambiguous static fixture reaches the unavailable guard", async () => {
  const result = await serve({ content: "Sunny" }, false, "fixture", false);
  expect(result.status).toBe(501);
  expect(result.calls).toBe(0);
  expect(result.entries).toHaveLength(1);
  expect(result.entries[0]?.response.misbehavior).toMatchObject({ reason: "unsupported-on-wire" });
});

test("an explicit factory error is not applicable", async () => {
  const result = await serve(
    { error: { message: "fixture failure" }, status: 429 },
    false,
    "fixture",
  );
  expect(result.status).toBe(501);
  expect(result.calls).toBe(1);
  expect(result.entries).toHaveLength(1);
  expect(JSON.parse(result.body)).toMatchObject({
    type: "error",
    error: { code: "aimock_misbehavior_not_applicable" },
  });
  expect(result.entries[0]?.response.misbehavior).toMatchObject({ reason: "not-applicable" });
});

test("a scoped factory error skips and preserves its native error status", async () => {
  const result = await serve(
    { error: { message: "fixture failure" }, status: 429 },
    false,
    "scope",
  );
  expect(result.status).toBe(429);
  expect(result.calls).toBe(1);
  expect(result.entries).toHaveLength(1);
  expect(JSON.parse(result.body)).toMatchObject({
    type: "error",
    error: { type: "api_error", message: "fixture failure" },
  });
  expect(result.entries[0]?.response.misbehavior).toMatchObject({ reason: "not-applicable" });
});

// createServer deliberately accepts fixtures without LLMock's load validation.
// A numeric rate outside [0,1] is typed but fails request-time parsing.
test.each([false, true])("direct fixture parse errors log once, stream=%s", async (stream) => {
  const logs = vi.spyOn(console, "error");
  const server = await createServer(
    [
      {
        match: {},
        response: { content: "Sunny" },
        misbehavior: { faults: [{ fault: "content-filter", rate: 2 }] },
      },
    ],
    { port: 0, logLevel: "warn", metrics: true },
  );
  try {
    const result = await fetch(`${server.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 64,
        messages: [{ role: "user", content: "weather" }],
        stream,
      }),
    });
    const body = await result.json();
    const entries = server.journal.getAll();
    const metrics = await (await fetch(`${server.url}/metrics`)).text();
    console.log(
      JSON.stringify({
        phase: "direct-parse-log",
        stream,
        status: result.status,
        body,
        entries,
        errorLogs: logs.mock.calls,
      }),
    );
    expect(result.status).toBe(501);
    expect(body).toMatchObject({
      type: "error",
      error: { type: "api_error", code: "aimock_misbehavior_not_applicable" },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.response.misbehavior).toMatchObject({
      applied: false,
      source: "fixture",
      wire: "anthropic",
      evaluations: [],
    });
    expect(metrics).not.toContain("aimock_misbehavior_total{");
    expect(logs).toHaveBeenCalledTimes(1);
    expect(logs.mock.calls[0]?.join(" ")).toContain(body.error.message);
  } finally {
    logs.mockRestore();
    await new Promise<void>((resolve, reject) =>
      server.server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test.each([false, true])(
  "evaluated unsupported errors are not double logged, stream=%s",
  async (stream) => {
    const logs = vi.spyOn(console, "error");
    const server = await createServer(
      [{ match: {}, response: { content: "Sunny" }, misbehavior: "content-filter" }],
      { port: 0, logLevel: "warn", metrics: true },
    );
    try {
      const result = await fetch(`${server.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 64,
          messages: [{ role: "user", content: "weather" }],
          stream,
        }),
      });
      const body = await result.json();
      const entries = server.journal.getAll();
      const metrics = await (await fetch(`${server.url}/metrics`)).text();
      console.log(
        JSON.stringify({
          phase: "evaluated-error-log",
          stream,
          status: result.status,
          body,
          entries,
          errorLogs: logs.mock.calls,
        }),
      );
      expect(result.status).toBe(501);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.response.misbehavior?.evaluations).toHaveLength(1);
      expect(logs).toHaveBeenCalledTimes(1);
      expect(logs.mock.calls[0]?.join(" ")).toContain(
        "content-filter error:unsupported-on-wire on anthropic",
      );
      expect(metrics).toContain('outcome="error:unsupported-on-wire",wire="anthropic"} 1');
    } finally {
      logs.mockRestore();
      await new Promise<void>((resolve, reject) =>
        server.server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
