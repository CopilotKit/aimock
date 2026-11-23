import { afterEach, expect, test, vi } from "vitest";
import type { FixtureResponse, MisbehaviorConfig } from "../types.js";
import { LLMock, createServer } from "./helpers/misbehavior-enabled.js";

let mock: LLMock | undefined;
afterEach(async () => {
  await mock?.stop();
  mock = undefined;
});
const routes = [false, true].flatMap((vertex) =>
  [false, true].map((stream) => ({
    vertex,
    stream,
    id: `${vertex ? "vertex" : "gemini"}-${stream ? "stream" : "nonstream"}`,
  })),
);
const tool = { name: "lookup", arguments: '{"city":"Paris"}', id: "call_lookup" };
const shapes: { shape: string; response: FixtureResponse }[] = [
  { shape: "text", response: { content: "ordinary answer" } },
  { shape: "tools", response: { toolCalls: [tool] } },
  { shape: "mixed", response: { content: "ordinary answer", toolCalls: [tool] } },
  {
    shape: "blocks",
    response: {
      blocks: [
        { type: "toolCall", ...tool },
        { type: "text", text: "ordinary answer" },
      ],
    },
  },
];
async function request(route: (typeof routes)[number], headers: Record<string, string> = {}) {
  const resource = route.vertex
    ? "v1/projects/u8/locations/us-central1/publishers/google/models/gemini-2.5-flash"
    : "v1beta/models/gemini-2.5-flash";
  const result = await fetch(
    `${mock!.url}/${resource}:${route.stream ? "streamGenerateContent?alt=sse" : "generateContent"}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "lookup" }] }] }),
      signal: AbortSignal.timeout(5000),
    },
  );
  const wire = {
    status: result.status,
    contentType: result.headers.get("content-type"),
    body: await result.text(),
  };
  console.log(JSON.stringify({ route: route.id, wire, journal: mock!.getRequests() }));
  return wire;
}
// Stage4 keeps these native guards on permanently unsupported K7; supported K6
// moved to misbehavior-gemini.test.ts. Historical U8 bytes are preserved in receipts.
const config: MisbehaviorConfig = { faults: [{ fault: "refusal", rate: 0, times: 1 }] };

test.each(routes.flatMap((route) => shapes.map((shape) => ({ ...route, ...shape }))))(
  "$id $shape explicit unavailable guard precedes output and does not roll",
  async (scenario) => {
    let calls = 0;
    mock = new LLMock({ port: 0, logLevel: "silent", metrics: true });
    // No endpoint constraint: runtime routing must resolve ambiguous fixture wiring.
    mock.addFixture({
      match: {},
      response: () => {
        calls++;
        return scenario.response;
      },
      misbehavior: config,
    });
    await mock.start();
    const wire = await request(scenario);
    expect(wire.status).toBe(501);
    expect(wire.contentType).toContain("application/json");
    expect(JSON.parse(wire.body)).toMatchObject({ error: { code: 501, status: "UNIMPLEMENTED" } });
    expect(wire.body).not.toContain("data:");
    expect(wire.body).not.toContain("ordinary answer");
    expect(calls).toBe(1);
    const entries = mock.getRequests();
    expect(entries).toHaveLength(1);
    expect(entries[0].body).toMatchObject({
      model: "gemini-2.5-flash",
      stream: scenario.stream,
      messages: [{ role: "user", content: "lookup" }],
    });
    expect(entries[0].response.misbehavior).toMatchObject({
      applied: false,
      source: "fixture",
      wire: "gemini",
      reason: "unsupported-on-wire",
      evaluations: [
        { entryIndex: 0, fault: "refusal", outcome: "error", reason: "unsupported-on-wire" },
      ],
    });
    expect(entries[0].response.misbehavior?.evaluations[0].ordinal).toBeUndefined();
  },
);

test.each(routes)("$id header rejects unsupported and malformed config", async (route) => {
  mock = new LLMock({ port: 0, logLevel: "silent", metrics: true, misbehavior: config });
  mock.addFixture({ match: {}, response: { content: "ordinary answer" } });
  await mock.start();
  const unsupported = await request(route, { "x-aimock-misbehavior": "refusal" });
  expect(unsupported.status).toBe(501);
  expect(JSON.parse(unsupported.body)).toMatchObject({
    error: { code: 501, status: "UNIMPLEMENTED" },
  });
  const malformed = await request(route, { "x-aimock-misbehavior": "unknown-fault" });
  expect(malformed.status).toBe(400);
  expect(JSON.parse(malformed.body)).toMatchObject({
    error: { code: 400, status: "INVALID_ARGUMENT" },
  });
  expect(mock.getRequests()).toHaveLength(2);
});

test.each(routes)(
  "$id baseline skips with one evaluation and preserves ordinary output",
  async (route) => {
    mock = new LLMock({ port: 0, logLevel: "silent", metrics: true, misbehavior: config });
    mock.addFixture({ match: {}, response: { content: "ordinary answer" } });
    await mock.start();
    const wire = await request(route);
    expect(wire.status).toBe(200);
    expect(wire.body).toContain("ordinary answer");
    const entries = mock.getRequests();
    expect(entries).toHaveLength(1);
    expect(entries[0].response.misbehavior).toMatchObject({
      source: "server",
      wire: "gemini",
      reason: "unsupported-on-wire",
      evaluations: [{ entryIndex: 0, outcome: "skipped", reason: "unsupported-on-wire" }],
    });
    expect(entries[0].response.misbehavior?.evaluations).toHaveLength(1);
    expect(entries[0].response.misbehavior?.evaluations[0].ordinal).toBeUndefined();
  },
);

test.each(routes)("$id provider filter excludes fault before unsupported guard", async (route) => {
  mock = new LLMock({ port: 0, logLevel: "silent", metrics: true });
  mock.addFixture({
    match: {},
    response: { toolCalls: [tool] },
    misbehavior: { faults: [{ fault: "tool-args-invalid-json", providers: ["openai-chat"] }] },
  });
  await mock.start();
  const wire = await request(route);
  expect(wire.status).toBe(200);
  expect(wire.body).toContain("Paris");
  expect(mock.getRequests()).toHaveLength(1);
  expect(mock.getRequests()[0].response.misbehavior).toMatchObject({
    reason: "provider-excluded",
    evaluations: [{ outcome: "skipped", reason: "provider-excluded" }],
  });
});

test.each(routes)("$id no config preserves output without metadata", async (route) => {
  mock = new LLMock({ port: 0, logLevel: "silent", metrics: true });
  mock.addFixture({ match: {}, response: { toolCalls: [tool] } });
  await mock.start();
  const wire = await request(route);
  expect(wire.status).toBe(200);
  expect(wire.body).toContain("Paris");
  expect(mock.getRequests()).toHaveLength(1);
  expect(mock.getRequests()[0].response.misbehavior).toBeUndefined();
});

test.each(routes)("$id runtime scope skips without counters and exposes metrics", async (route) => {
  mock = new LLMock({ port: 0, logLevel: "silent", metrics: true });
  mock.addFixture({ match: {}, response: { content: "ordinary answer", toolCalls: [tool] } });
  await mock.start();
  const configured = await fetch(`${mock.url}/__aimock/misbehavior`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-id": "u8" },
    body: JSON.stringify(config),
  });
  expect(configured.status).toBe(200);
  for (let i = 0; i < 2; i++) {
    expect((await request(route, { "x-test-id": "u8" })).status).toBe(200);
  }
  const entries = mock.getRequests();
  expect(entries).toHaveLength(2);
  for (const entry of entries) {
    expect(entry.response.misbehavior).toMatchObject({
      source: "scope",
      reason: "unsupported-on-wire",
    });
    expect(entry.response.misbehavior?.evaluations).toEqual([
      { entryIndex: 0, fault: "refusal", outcome: "skipped", reason: "unsupported-on-wire" },
    ]);
  }
  const metrics = await (await fetch(`${mock.url}/metrics`)).text();
  expect(metrics).toMatch(
    /aimock_misbehavior_total\{[^\n]*fault="refusal"[^\n]*outcome="skipped:unsupported-on-wire"[^\n]*wire="gemini"[^\n]*\} 2/,
  );
});

test.each(routes)("$id explicit error response is not applicable", async (route) => {
  mock = new LLMock({ port: 0, logLevel: "silent", metrics: true });
  mock.addFixture({
    match: {},
    response: () => ({ error: { message: "original failure" }, status: 429 }),
    misbehavior: "empty-response",
  });
  await mock.start();
  expect((await request(route)).status).toBe(501);
  expect(mock.getRequests()).toHaveLength(1);
  expect(mock.getRequests()[0].response.misbehavior).toMatchObject({ reason: "not-applicable" });
});

test.each(routes.flatMap((route) => [true, false].map((malformed) => ({ ...route, malformed }))))(
  "$id direct fixture parse error=$malformed logs once without phantom metrics",
  async (route) => {
    const logs: unknown[][] = [];
    const capture = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => logs.push(args));
    const instance = await createServer(
      [
        {
          match: {},
          response: { content: "ordinary answer" },
          misbehavior: { faults: [{ fault: "refusal", rate: route.malformed ? 2 : 1 }] },
        },
      ],
      { port: 0, logLevel: "warn", metrics: true },
    );
    try {
      const resource = route.vertex
        ? "v1/projects/u8/locations/us-central1/publishers/google/models/gemini-2.5-flash"
        : "v1beta/models/gemini-2.5-flash";
      const path = `/${resource}:${route.stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
      const response = await fetch(`${instance.url}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "lookup" }] }] }),
        signal: AbortSignal.timeout(5000),
      });
      const body = await response.json();
      const entries = instance.journal.getAll();
      const metrics = instance.defaults.registry?.serialize() ?? "";
      console.log(
        JSON.stringify({
          route: route.id,
          malformed: route.malformed,
          status: response.status,
          body,
          logs,
          entries,
          metrics,
        }),
      );
      expect(response.status).toBe(501);
      expect(body).toMatchObject({ error: { code: 501, status: "UNIMPLEMENTED" } });
      expect(entries).toHaveLength(1);
      expect(logs).toHaveLength(1);
      if (route.malformed) {
        expect(logs[0].join(" ")).toContain(body.error.message);
        expect(entries[0].response.misbehavior?.evaluations).toEqual([]);
        expect(metrics).not.toContain("aimock_misbehavior_total");
      } else {
        expect(logs[0].join(" ")).toContain("refusal error:unsupported-on-wire on gemini");
        expect(entries[0].response.misbehavior?.evaluations).toHaveLength(1);
        expect(
          metrics.split("\n").filter((line) => line.startsWith("aimock_misbehavior_total{")),
        ).toEqual([
          'aimock_misbehavior_total{fault="refusal",outcome="error:unsupported-on-wire",wire="gemini"} 1',
        ]);
      }
    } finally {
      capture.mockRestore();
      await new Promise<void>((resolve, reject) =>
        instance.server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);

test.each(routes)(
  "$id K2 non-object argument remains unsupported on the object wire",
  async (route) => {
    mock = new LLMock({ port: 0, logLevel: "silent" });
    mock.addFixture({ match: {}, response: { toolCalls: [tool] } });
    await mock.start();
    const wire = await request(route, {
      "x-aimock-misbehavior": "tool-args-schema-violation;violation=not-object",
    });
    expect(wire.status).toBe(501);
    expect(JSON.parse(wire.body)).toMatchObject({ error: { code: 501, status: "UNIMPLEMENTED" } });
    expect(mock.getRequests()).toHaveLength(1);
    expect(mock.getRequests()[0].response.misbehavior).toMatchObject({
      reason: "unsupported-on-wire",
      evaluations: [{ outcome: "error", reason: "unsupported-on-wire" }],
    });
    expect(mock.getRequests()[0].response.misbehavior?.evaluations[0].ordinal).toBeUndefined();
  },
);
