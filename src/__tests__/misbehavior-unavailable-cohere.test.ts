import { expect, test, vi } from "vitest";
import { LLMock } from "../llmock.js";
import { createServer } from "../server.js";
import type { FixtureResponse, MisbehaviorConfig } from "../types.js";

const shapes = [
  { name: "text", response: { content: "hello" } },
  { name: "tool", response: { toolCalls: [{ name: "weather", arguments: '{"city":"Paris"}' }] } },
  {
    name: "mixed",
    response: { content: "hello", toolCalls: [{ name: "weather", arguments: '{"city":"Paris"}' }] },
  },
  {
    name: "blocks",
    response: {
      blocks: [
        { type: "text", text: "hello" },
        { type: "toolCall", name: "weather", arguments: '{"city":"Paris"}' },
      ],
    },
  },
] satisfies { name: string; response: FixtureResponse }[];
const modes = shapes.flatMap((shape) => [false, true].map((stream) => ({ ...shape, stream })));
const config: MisbehaviorConfig = { faults: [{ fault: "empty-response", times: 1 }] };

async function request(mock: LLMock, stream: boolean, headers: Record<string, string> = {}) {
  const result = await fetch(`${mock.url}/v2/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      model: "command-r-plus",
      messages: [{ role: "user", content: "weather" }],
      stream,
    }),
  });
  const body = await result.text();
  console.log(
    JSON.stringify({ stream, headers, status: result.status, body, journal: mock.getRequests() }),
  );
  return { status: result.status, body };
}

// Stage1 source and proof are preserved externally; supported cells now assert native output.
test.each(modes)(
  "Cohere $name stream=$stream applies an explicit empty response after resolving once",
  async ({ response, stream }) => {
    const mock = new LLMock({ port: 0, logLevel: "silent", metrics: true });
    let calls = 0;
    mock.addFixture({
      match: {},
      response: () => {
        calls++;
        return response;
      },
      misbehavior: config,
    });
    try {
      await mock.start();
      const result = await request(mock, stream);
      expect(result.status).toBe(200);
      if (stream) {
        const events = result.body
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => JSON.parse(line.slice(6)));
        expect(events.map((event) => event.type)).toEqual(["message-start", "message-end"]);
      } else {
        expect(JSON.parse(result.body).message).toMatchObject({ content: [], tool_calls: [] });
      }
      expect(calls).toBe(1);
      expect(mock.getRequests()).toHaveLength(1);
      expect(mock.getLastRequest()?.response.misbehavior).toMatchObject({
        source: "fixture",
        wire: "cohere",
        applied: true,
        evaluations: [{ entryIndex: 0, outcome: "applied", ordinal: 0 }],
        servedToolCalls: [],
      });
      expect(await (await fetch(`${mock.url}/metrics`)).text()).toContain(
        'aimock_misbehavior_total{fault="empty-response",outcome="applied",wire="cohere"} 1',
      );
    } finally {
      await mock.stop();
    }
  },
);

test.each(modes)(
  "Cohere $name stream=$stream applies baseline once then preserves output without another roll",
  async ({ response, stream }) => {
    const mock = new LLMock({ port: 0, logLevel: "silent", misbehavior: config, metrics: true });
    mock.addFixture({ match: {}, response });
    try {
      await mock.start();
      for (let i = 0; i < 2; i++) {
        expect((await request(mock, stream)).status).toBe(200);
        const summary = mock.getLastRequest()?.response.misbehavior;
        expect(summary).toMatchObject({
          source: "server",
          wire: "cohere",
          applied: i === 0,
          evaluations: [
            i === 0
              ? { entryIndex: 0, outcome: "applied", ordinal: 0 }
              : { entryIndex: 0, outcome: "skipped", reason: "times-exhausted" },
          ],
        });
        if (i === 1) expect(summary?.evaluations[0]).not.toHaveProperty("ordinal");
      }
      expect(mock.getRequests()).toHaveLength(2);
      expect(await (await fetch(`${mock.url}/metrics`)).text()).toContain(
        'aimock_misbehavior_total{fault="empty-response",outcome="skipped:times-exhausted",wire="cohere"} 1',
      );
    } finally {
      await mock.stop();
    }
  },
);

test("Cohere header precedence, invalid input, provider filtering, opt-out and no-config compatibility", async () => {
  const mock = new LLMock({ port: 0, logLevel: "silent", misbehavior: config });
  mock.addFixture({ match: {}, response: { content: "hello", id: "stable" } });
  try {
    await mock.start();
    expect((await request(mock, false, { "x-aimock-misbehavior": "empty-response" })).status).toBe(
      200,
    );
    expect(mock.getLastRequest()?.response.misbehavior?.source).toBe("header");
    expect((await request(mock, true, { "x-aimock-misbehavior": "{" })).status).toBe(400);
    mock.setMisbehavior({ faults: [{ fault: "empty-response", providers: ["openai-chat"] }] });
    expect((await request(mock, false)).status).toBe(200);
    expect(mock.getLastRequest()?.response.misbehavior?.reason).toBe("provider-excluded");
    mock.setMisbehavior({ faults: [] });
    const disabled = await request(mock, false);
    expect(disabled.status).toBe(200);
    expect(mock.getLastRequest()?.response.misbehavior?.reason).toBe("disabled");
    mock.clearMisbehavior();
    const plain = await request(mock, false);
    expect(plain).toEqual(disabled);
    expect(mock.getLastRequest()?.response).not.toHaveProperty("misbehavior");
    expect(mock.getRequests()).toHaveLength(5);
  } finally {
    await mock.stop();
  }
});

test.each(["refusal", "content-filter", "reasoning-only"] as const)(
  "Cohere guards %s on actual tool JSON and SSE output",
  async (fault) => {
    const mock = new LLMock({ port: 0, logLevel: "silent" });
    mock.addFixture({ match: {}, response: shapes[1].response });
    try {
      await mock.start();
      for (const stream of [false, true]) {
        const result = await request(mock, stream, { "x-aimock-misbehavior": fault });
        expect(result.status).toBe(501);
        expect(JSON.parse(result.body)).toMatchObject({
          message: expect.stringContaining(`${fault} on cohere`),
          code: "aimock_misbehavior_unsupported",
        });
        expect(mock.getLastRequest()?.response.misbehavior?.evaluations).toEqual([
          { entryIndex: 0, fault, outcome: "error", reason: "unsupported-on-wire" },
        ]);
      }
      expect(mock.getRequests()).toHaveLength(2);
    } finally {
      await mock.stop();
    }
  },
);

test("Cohere runtime skips non-chat response families without masking their native error", async () => {
  const mock = new LLMock({ port: 0, logLevel: "silent", misbehavior: config });
  mock.addFixture({
    match: {},
    response: { error: { message: "fixture-error", type: "fixture" }, status: 429 },
  });
  try {
    await mock.start();
    const result = await request(mock, false);
    expect(result.status).toBe(429);
    expect(result.body).toContain("fixture-error");
    expect(mock.getLastRequest()?.response.misbehavior).toMatchObject({
      applied: false,
      reason: "not-applicable",
    });
    expect(mock.getRequests()).toHaveLength(1);
  } finally {
    await mock.stop();
  }
});

test.each(
  [false, true].flatMap((stream) => [false, true].map((malformed) => ({ stream, malformed }))),
)(
  "Cohere direct fixture diagnostic stream=$stream malformed=$malformed logs exactly once",
  async ({ stream, malformed }) => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // warn is the lowest enabled level in Logger; error() emits at that level.
    const instance = await createServer(
      [
        {
          match: {},
          response: { content: "hello" },
          misbehavior: { faults: [{ fault: "content-filter", rate: malformed ? 2 : 1 }] },
        },
      ],
      { port: 0, logLevel: "warn", metrics: true },
    );
    try {
      const response = await fetch(`${instance.url}/v2/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "command-r-plus",
          messages: [{ role: "user", content: "weather" }],
          stream,
        }),
      });
      const body = await response.json();
      const metrics = await (await fetch(`${instance.url}/metrics`)).text();
      const entries = instance.journal.getAll();
      console.log(
        JSON.stringify({
          stream,
          malformed,
          status: response.status,
          body,
          entries,
          errors: errors.mock.calls,
          metrics,
        }),
      );
      expect(response.status).toBe(501);
      expect(entries).toHaveLength(1);
      expect(errors).toHaveBeenCalledTimes(1);
      if (malformed) {
        expect(errors).toHaveBeenCalledWith("[aimock]", body.message);
        expect(entries[0].response.misbehavior?.evaluations).toEqual([]);
        expect(metrics).not.toContain("aimock_misbehavior_total");
      } else {
        expect(errors).toHaveBeenCalledWith(
          "[aimock]",
          expect.stringContaining("content-filter error:unsupported-on-wire on cohere"),
        );
        expect(entries[0].response.misbehavior?.evaluations).toHaveLength(1);
        expect(metrics).toContain(
          'aimock_misbehavior_total{fault="content-filter",outcome="error:unsupported-on-wire",wire="cohere"} 1',
        );
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        instance.server.close((error) => (error ? reject(error) : resolve())),
      );
      errors.mockRestore();
    }
  },
);

test.each(
  [false, true].flatMap((stream) =>
    ["refusal", "content-filter", "reasoning-only"].map((fault) => ({ stream, fault })),
  ),
)(
  "Cohere permanent runtime limit $fault stream=$stream preserves ordinary bytes and skips without rolls",
  async ({ stream, fault }) => {
    const mock = new LLMock({ port: 0, logLevel: "silent", metrics: true });
    mock.addFixture({
      match: {},
      response: { content: "hello", id: "stable", usage: { input_tokens: 4, output_tokens: 8 } },
    });
    // setMisbehavior validates externally supplied runtime configuration.
    await mock.start();
    try {
      const configured = await fetch(`${mock.url}/__aimock/misbehavior`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ faults: [{ fault, times: 1 }] }),
      });
      expect(configured.status).toBe(200);
      const first = await request(mock, stream);
      const second = await request(mock, stream);
      expect(first.status).toBe(200);
      expect(second).toEqual(first);
      for (const entry of mock.getRequests()) {
        if (entry.path !== "/v2/chat") continue;
        expect(entry.response.misbehavior?.reason).toBe("unsupported-on-wire");
        expect(entry.response.misbehavior?.evaluations[0]).not.toHaveProperty("ordinal");
      }
      mock.clearMisbehavior();
      expect(await request(mock, stream)).toEqual(first);
      expect(await (await fetch(`${mock.url}/metrics`)).text()).toContain(
        `aimock_misbehavior_total{fault="${fault}",outcome="skipped:unsupported-on-wire",wire="cohere"} 2`,
      );
    } finally {
      await mock.stop();
    }
  },
);
