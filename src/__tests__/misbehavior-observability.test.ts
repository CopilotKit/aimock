import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import OpenAI from "openai";
import type { ServerInstance } from "../server.js";
import { afterEach, expect, test, vi } from "vitest";
import { Journal } from "../journal.js";
import { Logger } from "../logger.js";
import { createMetricsRegistry } from "../metrics.js";
import {
  recordMisbehaviorOutcome,
  resolveMisbehaviorShortCircuit,
  setFixtureMisbehaviorPosition,
} from "../misbehavior.js";
import type { MisbehaviorSummary } from "../misbehavior.js";
import type { Fixture, HandlerDefaults } from "../types.js";
import { LLMock, createServer } from "./helpers/misbehavior-enabled.js";

afterEach(() => vi.restoreAllMocks());

function context() {
  const journal = new Journal();
  const defaults: HandlerDefaults = {
    // A scope means misbehavior is enabled (the server creates one only then).
    misbehavior: { byTestId: new Map() },
    latency: 0,
    chunkSize: 10,
    replaySpeed: 1,
    logger: new Logger("silent"),
    registry: createMetricsRegistry(),
  };
  const add = () =>
    journal.add({
      method: "POST",
      path: "/v1/chat/completions",
      headers: {},
      body: null,
      response: { status: 200, fixture: null },
    });
  return { journal, defaults, add };
}

function applied(): MisbehaviorSummary {
  return {
    applied: true,
    wire: "openai-chat",
    fault: "tool-args-invalid-json",
    source: "fixture",
    evaluations: [
      { entryIndex: 0, fault: "tool-args-invalid-json", outcome: "applied", ordinal: 0 },
    ],
    servedToolCalls: [{ id: "call_prepared_once", name: "weather", arguments: '{"city":' }],
  };
}

function unsupported(): MisbehaviorSummary {
  return {
    applied: false,
    wire: "anthropic",
    fault: "content-filter",
    reason: "unsupported-on-wire",
    evaluations: [
      { entryIndex: 0, fault: "content-filter", outcome: "skipped", reason: "unsupported-on-wire" },
    ],
  };
}

test("records on the exact existing journal entry and retains prepared output after interruption", () => {
  const { journal, defaults, add } = context();
  const entry = add();
  const later = add();
  entry.response.interrupted = true;
  entry.response.interruptReason = "disconnect";
  const summary = applied();
  recordMisbehaviorOutcome({ entry, summary, defaults, testId: "test" });
  expect(journal.getAll()).toEqual([entry, later]);
  expect(entry.response.misbehavior).toBe(summary);
  expect(entry.response).toMatchObject({ interrupted: true, interruptReason: "disconnect" });
  expect(later.response).not.toHaveProperty("misbehavior");
  console.log(
    JSON.stringify({ journal: journal.getAll(), metrics: defaults.registry?.serialize() }),
  );
});

test("counts every ordered evaluation exactly once rather than only the winner", () => {
  const { defaults, add } = context();
  const entry = add();
  const summary = applied();
  summary.evaluations.unshift({
    entryIndex: 0,
    fault: "empty-response",
    outcome: "skipped",
    reason: "not-rolled",
    ordinal: 0,
  });
  summary.evaluations[1].entryIndex = 1;
  const info = vi.spyOn(defaults.logger, "info");
  const debug = vi.spyOn(defaults.logger, "debug");
  recordMisbehaviorOutcome({ entry, summary, defaults, testId: "test" });
  recordMisbehaviorOutcome({ entry, summary: structuredClone(summary), defaults, testId: "test" });
  expect(defaults.registry?.serialize()).toBe(
    [
      "# TYPE aimock_misbehavior_total counter",
      'aimock_misbehavior_total{fault="empty-response",outcome="skipped:not-rolled",wire="openai-chat"} 1',
      'aimock_misbehavior_total{fault="tool-args-invalid-json",outcome="applied",wire="openai-chat"} 1',
      "",
    ].join("\n"),
  );
  expect(entry.response).toHaveProperty("misbehavior.evaluations", summary.evaluations);
  expect(info).toHaveBeenCalledTimes(1);
  expect(debug).toHaveBeenCalledTimes(1);
});

test.each(["disabled", "proxied", "chaos-fired"] as const)(
  "journals %s with no phantom metric",
  (reason) => {
    const { defaults, add } = context();
    const entry = add();
    const summary: MisbehaviorSummary = { applied: false, reason, evaluations: [] };
    recordMisbehaviorOutcome({ entry, summary, defaults, testId: "test" });
    expect(entry.response).toHaveProperty("misbehavior", summary);
    expect(defaults.registry?.serialize()).toBe("");
  },
);

test("absent configuration is silent and does not consume the entry's observation", () => {
  const { defaults, add } = context();
  const entry = add();
  recordMisbehaviorOutcome({ entry, summary: undefined, defaults, testId: "test" });
  expect(entry.response).not.toHaveProperty("misbehavior");
  expect(defaults.registry?.serialize()).toBe("");
  recordMisbehaviorOutcome({ entry, summary: applied(), defaults, testId: "test" });
  expect(entry.response).toHaveProperty("misbehavior.applied", true);
});

test("rejects unprepared applied output without observations and accepts genuine empty calls", () => {
  const { defaults, add } = context();
  const entry = add();
  const summary = applied();
  delete summary.servedToolCalls;
  expect(() => recordMisbehaviorOutcome({ entry, summary, defaults, testId: "test" })).toThrow(
    "servedToolCalls",
  );
  expect(entry.response).not.toHaveProperty("misbehavior");
  expect(defaults.registry?.serialize()).toBe("");
  summary.servedToolCalls = [];
  recordMisbehaviorOutcome({ entry, summary, defaults, testId: "test" });
  expect(entry.response).toHaveProperty("misbehavior.servedToolCalls", []);
});

test("uses info for applied, debug for ordinary skips, and error for fail-loud evaluations", () => {
  const { defaults, add } = context();
  const info = vi.spyOn(defaults.logger, "info");
  const debug = vi.spyOn(defaults.logger, "debug");
  const error = vi.spyOn(defaults.logger, "error");
  recordMisbehaviorOutcome({ entry: add(), summary: applied(), defaults, testId: "test" });
  const summary = unsupported();
  summary.evaluations[0].reason = "not-applicable";
  recordMisbehaviorOutcome({ entry: add(), summary, defaults, testId: "test" });
  summary.evaluations[0].outcome = "error";
  recordMisbehaviorOutcome({ entry: add(), summary, defaults, testId: "test" });
  expect(info).toHaveBeenCalledTimes(1);
  expect(debug).toHaveBeenCalledTimes(1);
  expect(error).toHaveBeenCalledTimes(1);
  expect(defaults.registry?.serialize()).toContain('outcome="error:not-applicable"');
});

test("warns once per test/fault/wire/server while retaining every unsupported evaluation", () => {
  const { defaults, add } = context();
  const warn = vi.spyOn(defaults.logger, "warn");
  const summary = unsupported();
  const record = (testId: string, value = summary) =>
    recordMisbehaviorOutcome({ entry: add(), summary: value, defaults, testId });
  record("first");
  record("first");
  record("second");
  record("first", { ...summary, wire: "gemini" });
  record("first", {
    ...summary,
    evaluations: [{ ...summary.evaluations[0], fault: "tool-call-id-duplicate" }],
  });
  expect(warn).toHaveBeenCalledTimes(4);
  expect(defaults.registry?.serialize()).toContain(
    'fault="content-filter",outcome="skipped:unsupported-on-wire",wire="anthropic"} 3',
  );
  const other = context();
  const otherWarn = vi.spyOn(other.defaults.logger, "warn");
  recordMisbehaviorOutcome({
    entry: other.add(),
    summary,
    defaults: other.defaults,
    testId: "first",
  });
  expect(otherWarn).toHaveBeenCalledTimes(1);
});

test("rejects evaluation metadata without a wire before making observations", () => {
  const { defaults, add } = context();
  const entry = add();
  const summary = unsupported();
  delete summary.wire;
  expect(() => recordMisbehaviorOutcome({ entry, summary, defaults, testId: "test" })).toThrow(
    "wire",
  );
  expect(entry.response).not.toHaveProperty("misbehavior");
  expect(defaults.registry?.serialize()).toBe("");
});

test("fail-loud unsupported errors remain errors on every request", () => {
  const { defaults, add } = context();
  const error = vi.spyOn(defaults.logger, "error");
  const summary = unsupported();
  summary.evaluations[0].outcome = "error";
  recordMisbehaviorOutcome({ entry: add(), summary, defaults, testId: "test" });
  recordMisbehaviorOutcome({ entry: add(), summary, defaults, testId: "test" });
  expect(error).toHaveBeenCalledTimes(2);
  expect(defaults.registry?.serialize()).toContain(
    'outcome="error:unsupported-on-wire",wire="anthropic"} 2',
  );
});

test("records without requiring metrics to be enabled", () => {
  const { defaults, add } = context();
  delete defaults.registry;
  const entry = add();
  const summary = applied();
  recordMisbehaviorOutcome({ entry, summary, defaults, testId: "test" });
  expect(entry.response.misbehavior).toBe(summary);
});

function bypassContext() {
  const ctx = context();
  const fixture: Fixture = {
    match: {},
    response: { content: "unchanged" },
    misbehavior: "empty-response",
  };
  ctx.defaults.misbehavior = {
    baseline: { seed: "random", faults: [{ fault: "refusal", times: 1 }] },
    byTestId: new Map([["scoped", { faults: [{ fault: "content-filter" }] }]]),
  };
  ctx.defaults.misbehaviorCounters = ctx.journal;
  return {
    ...ctx,
    input: {
      wire: "openai-chat" as const,
      fixture,
      defaults: ctx.defaults,
      rawHeaders: { "x-test-id": "scoped", "x-aimock-misbehavior": "empty-response;rate=0" },
      url: "/v1/chat/completions",
      reason: "chaos-fired" as const,
    },
  };
}

test.each(["proxied", "chaos-fired"] as const)(
  "%s resolves whole-level precedence without selecting a fault",
  (reason) => {
    const { input } = bypassContext();
    const expected = { applied: false, wire: "openai-chat", reason, evaluations: [] };
    expect(resolveMisbehaviorShortCircuit({ ...input, reason })).toEqual({
      ...expected,
      source: "header",
    });
    const fixtureInput = { ...input, reason, rawHeaders: { "x-test-id": "scoped" } };
    expect(resolveMisbehaviorShortCircuit(fixtureInput)).toEqual({
      ...expected,
      source: "fixture",
    });
    const scopeInput = { ...fixtureInput, fixture: undefined };
    expect(resolveMisbehaviorShortCircuit(scopeInput)).toEqual({ ...expected, source: "scope" });
    expect(resolveMisbehaviorShortCircuit({ ...scopeInput, rawHeaders: {} })).toEqual({
      ...expected,
      source: "server",
    });
  },
);

test("bypass uses the shared header, query and default test identity rules", () => {
  const { input, defaults } = bypassContext();
  const scoped = {
    ...input,
    fixture: undefined,
    rawHeaders: {},
    url: "/v1/chat/completions?testId=scoped",
  };
  expect(resolveMisbehaviorShortCircuit(scoped)?.source).toBe("scope");
  expect(
    resolveMisbehaviorShortCircuit({ ...scoped, rawHeaders: { "x-test-id": ["other", "scoped"] } })
      ?.source,
  ).toBe("server");
  defaults.misbehavior?.byTestId.set("__default__", { faults: [] });
  expect(resolveMisbehaviorShortCircuit({ ...scoped, url: undefined })?.source).toBe("scope");
});

test.each(["proxied", "chaos-fired"] as const)(
  "%s has no summary without effective config",
  (reason) => {
    const { defaults } = context();
    const input = {
      defaults,
      wire: "openai-chat" as const,
      rawHeaders: {},
      url: undefined,
      reason,
    };
    expect(resolveMisbehaviorShortCircuit(input)).toBeUndefined();
    defaults.misbehavior = {
      byTestId: new Map([["other", { faults: [{ fault: "empty-response" }] }]]),
    };
    expect(resolveMisbehaviorShortCircuit(input)).toBeUndefined();
  },
);

test("explicit empty configs suppress lower levels but retain the bypass reason", () => {
  const { input, defaults } = bypassContext();
  input.fixture.misbehavior = { faults: [] };
  const fixtureInput = { ...input, rawHeaders: { "x-test-id": "scoped" } };
  expect(resolveMisbehaviorShortCircuit(fixtureInput)).toEqual({
    applied: false,
    source: "fixture",
    wire: "openai-chat",
    reason: "chaos-fired",
    evaluations: [],
  });
  defaults.misbehavior?.byTestId.set("scoped", { faults: [] });
  expect(resolveMisbehaviorShortCircuit({ ...fixtureInput, fixture: undefined })).toEqual({
    applied: false,
    source: "scope",
    wire: "openai-chat",
    reason: "chaos-fired",
    evaluations: [],
  });
});

test("bypass does not evaluate unsupported or excluded faults, allocate random seed, move counters or observe", () => {
  const { input, defaults, journal } = bypassContext();
  const counters = [
    vi.spyOn(journal, "nextOrdinal"),
    vi.spyOn(journal, "getFiringCount"),
    vi.spyOn(journal, "recordFiring"),
  ];
  const random = vi.spyOn(Math, "random");
  const logs = [
    vi.spyOn(defaults.logger, "info"),
    vi.spyOn(defaults.logger, "warn"),
    vi.spyOn(defaults.logger, "debug"),
    vi.spyOn(defaults.logger, "error"),
  ];
  const fixture: Fixture = {
    ...input.fixture,
    misbehavior: {
      seed: "random",
      faults: [{ fault: "content-filter", providers: ["anthropic"], rate: 1, times: 1 }],
    },
  };
  const configBefore = structuredClone(fixture);
  const bypass = { ...input, fixture, wire: "gemini" as const, rawHeaders: {} };
  for (let i = 0; i < 2; i++)
    expect(resolveMisbehaviorShortCircuit(bypass)).toEqual({
      applied: false,
      source: "fixture",
      wire: "gemini",
      reason: "chaos-fired",
      evaluations: [],
    });
  expect(fixture).toEqual(configBefore);
  expect(random).not.toHaveBeenCalled();
  for (const counter of counters) expect(counter).not.toHaveBeenCalled();
  for (const log of logs) expect(log).not.toHaveBeenCalled();
  expect(journal.getAll()).toEqual([]);
  expect(defaults.registry?.serialize()).toBe("");
});

const observationRequest = {
  model: "gpt-4o",
  messages: [{ role: "user", content: "weather" }],
  tools: [{ type: "function", function: { name: "weather", parameters: { type: "object" } } }],
} satisfies OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;

async function withObservedServer(
  fixture: Fixture,
  run: (instance: ServerInstance, client: OpenAI) => Promise<void>,
) {
  // Direct server construction needs the stable identity normally assigned by LLMock ingress.
  setFixtureMisbehaviorPosition(fixture, "code#0");
  const instance = await createServer([fixture], {
    port: 0,
    metrics: true,
    logLevel: "silent",
    misbehavior: "empty-response",
  });
  const client = new OpenAI({
    baseURL: `${instance.url}/v1`,
    apiKey: "local",
    maxRetries: 0,
    timeout: 5000,
  });
  try {
    await run(instance, client);
  } finally {
    await new Promise<void>((resolve, reject) =>
      instance.server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function observationMetrics(defaults: HandlerDefaults) {
  return (defaults.registry?.serialize() ?? "")
    .split("\n")
    .filter((line) => line.startsWith("aimock_misbehavior_total{"));
}

const observationCases: Array<{
  cell: string;
  config: Fixture["misbehavior"];
  applied: boolean;
  reason?: string;
  outcomes: Array<{ fault: string; outcome: string; reason?: string }>;
}> = [
  {
    cell: "skipped-then-applied",
    config: { faults: [{ fault: "empty-response", rate: 0 }, { fault: "tool-args-invalid-json" }] },
    applied: true,
    outcomes: [
      { fault: "empty-response", outcome: "skipped", reason: "not-rolled" },
      { fault: "tool-args-invalid-json", outcome: "applied" },
    ],
  },
  {
    cell: "multiple-skips",
    config: {
      faults: [
        { fault: "empty-response", rate: 0 },
        { fault: "tool-args-invalid-json", rate: 0 },
      ],
    },
    applied: false,
    reason: "not-rolled",
    outcomes: [
      { fault: "empty-response", outcome: "skipped", reason: "not-rolled" },
      { fault: "tool-args-invalid-json", outcome: "skipped", reason: "not-rolled" },
    ],
  },
  {
    cell: "all-filtered",
    config: {
      faults: [
        { fault: "empty-response", providers: ["anthropic"] },
        { fault: "tool-args-invalid-json", providers: ["gemini"] },
      ],
    },
    applied: false,
    reason: "provider-excluded",
    outcomes: [
      { fault: "empty-response", outcome: "skipped", reason: "provider-excluded" },
      { fault: "tool-args-invalid-json", outcome: "skipped", reason: "provider-excluded" },
    ],
  },
  { cell: "optout", config: { faults: [] }, applied: false, reason: "disabled", outcomes: [] },
];

test.each(observationCases)("O2a actual SDK observations: $cell", async (cell) => {
  await withObservedServer(
    {
      match: {},
      misbehavior: cell.config,
      response: { toolCalls: [{ name: "weather", arguments: '{"city":"Paris"}' }] },
    },
    async ({ journal, defaults }, client) => {
      const info = vi.spyOn(defaults.logger, "info");
      const debug = vi.spyOn(defaults.logger, "debug");
      const error = vi.spyOn(defaults.logger, "error");
      const { data, response } = await client.chat.completions
        .create(observationRequest)
        .withResponse();
      expect(response.status).toBe(200);
      const entries = journal.getAll();
      expect(entries).toHaveLength(1);
      const summary = entries[0].response.misbehavior;
      expect(summary).toMatchObject({
        applied: cell.applied,
        source: "fixture",
        wire: "openai-chat",
      });
      expect(summary?.reason).toBe(cell.reason);
      expect(
        summary?.evaluations.map(({ fault, outcome, reason }) => ({
          fault,
          outcome,
          ...(reason ? { reason } : {}),
        })),
      ).toEqual(cell.outcomes);
      expect(summary?.evaluations.map((row) => row.entryIndex)).toEqual(
        cell.outcomes.map((_, i) => i),
      );
      const metrics = observationMetrics(defaults);
      expect(metrics).toEqual(
        cell.outcomes
          .map(
            (row) =>
              `aimock_misbehavior_total{fault="${row.fault}",outcome="${row.outcome}${row.reason ? `:${row.reason}` : ""}",wire="openai-chat"} 1`,
          )
          .sort(),
      );
      expect(info).toHaveBeenCalledTimes(cell.applied ? 1 : 0);
      expect(
        debug.mock.calls.filter(([message]) => String(message).startsWith("[misbehavior]")),
      ).toHaveLength(cell.outcomes.filter((row) => row.outcome === "skipped").length);
      expect(error).not.toHaveBeenCalled();
      const calls = data.choices[0].message.tool_calls?.map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      }));
      expect(calls).toHaveLength(1);
      expect(calls?.[0].arguments).toBe(cell.applied ? '{"city":' : '{"city":"Paris"}');
      if (cell.applied) expect(summary?.servedToolCalls).toEqual(calls);
      console.log(
        JSON.stringify({
          cell: cell.cell,
          status: response.status,
          data,
          entries,
          metrics,
          info: info.mock.calls,
          debug: debug.mock.calls,
        }),
      );
    },
  );
});

test.each([false, true])("O2a generated IDs match prepared metadata, stream=%s", async (stream) => {
  await withObservedServer(
    {
      match: {},
      misbehavior: "tool-call-id-duplicate",
      response: { toolCalls: [{ name: "weather", arguments: '{"city":"Paris"}' }] },
    },
    async ({ journal, defaults }, client) => {
      const calls: Array<{ id: string; name: string; arguments: string }> = [];
      if (stream) {
        const chunks = await client.chat.completions.create({
          ...observationRequest,
          stream: true,
        });
        for await (const chunk of chunks) {
          for (const delta of chunk.choices[0]?.delta.tool_calls ?? []) {
            const call = (calls[delta.index] ??= { id: "", name: "", arguments: "" });
            call.id += delta.id ?? "";
            call.name += delta.function?.name ?? "";
            call.arguments += delta.function?.arguments ?? "";
          }
        }
      } else {
        const result = await client.chat.completions.create(observationRequest);
        for (const call of result.choices[0].message.tool_calls ?? [])
          calls.push({ id: call.id, name: call.function.name, arguments: call.function.arguments });
      }
      expect(calls).toHaveLength(2);
      expect(calls[0].id).toMatch(/^call_/);
      expect(calls[1].id).toBe(calls[0].id);
      expect(journal.getAll()).toHaveLength(1);
      expect(journal.getAll()[0].response.misbehavior?.servedToolCalls).toEqual(calls);
      expect(observationMetrics(defaults)).toEqual([
        'aimock_misbehavior_total{fault="tool-call-id-duplicate",outcome="applied",wire="openai-chat"} 1',
      ]);
      console.log(
        JSON.stringify({
          cell: "generated-ids",
          stream,
          calls,
          entries: journal.getAll(),
          metrics: observationMetrics(defaults),
        }),
      );
    },
  );
});

test("O2a interruption before tool output retains complete prepared metadata", async () => {
  await withObservedServer(
    {
      match: {},
      misbehavior: "tool-call-id-duplicate",
      response: { toolCalls: [{ name: "weather", arguments: '{"city":"Paris"}' }] },
      latency: 20,
      truncateAfterChunks: 1,
    },
    async ({ journal, defaults }, client) => {
      const chunks: OpenAI.Chat.Completions.ChatCompletionChunk[] = [];
      let interrupted: unknown;
      try {
        const stream = await client.chat.completions.create({
          ...observationRequest,
          stream: true,
        });
        for await (const chunk of stream) chunks.push(chunk);
      } catch (error) {
        interrupted = error;
      }
      expect(interrupted).toBeDefined();
      expect(
        chunks.flatMap((chunk) => chunk.choices.flatMap((choice) => choice.delta.tool_calls ?? [])),
      ).toEqual([]);
      await vi.waitFor(() => expect(journal.getAll()).toHaveLength(1));
      const entry = journal.getAll()[0];
      expect(entry.response).toMatchObject({
        interrupted: true,
        interruptReason: "truncateAfterChunks",
      });
      const calls = entry.response.misbehavior?.servedToolCalls;
      expect(calls).toHaveLength(2);
      expect(calls?.map((call) => call.arguments)).toEqual([
        '{"city":"Paris"}',
        '{"city":"Paris"}',
      ]);
      expect(calls?.[0].id).toMatch(/^call_/);
      expect(calls?.[1].id).toBe(calls?.[0].id);
      expect(observationMetrics(defaults)).toEqual([
        'aimock_misbehavior_total{fault="tool-call-id-duplicate",outcome="applied",wire="openai-chat"} 1',
      ]);
      console.log(
        JSON.stringify({
          cell: "interrupt-before-tool",
          chunks,
          error: String(interrupted),
          entry,
          metrics: observationMetrics(defaults),
        }),
      );
    },
  );
});

test("O2a native planner error records one status, error log and evaluation", async () => {
  await withObservedServer(
    { match: {}, misbehavior: "tool-args-invalid-json", response: { content: "no tool call" } },
    async ({ url, journal, defaults }) => {
      const error = vi.spyOn(defaults.logger, "error");
      const response = await fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(observationRequest),
      });
      const body = await response.json();
      expect(response.status).toBe(501);
      expect(body.error.code).toBe("aimock_misbehavior_not_applicable");
      expect(journal.getAll()).toHaveLength(1);
      expect(journal.getAll()[0].response).toMatchObject({
        status: 501,
        misbehavior: {
          applied: false,
          evaluations: [
            {
              entryIndex: 0,
              fault: "tool-args-invalid-json",
              outcome: "error",
              reason: "not-applicable",
            },
          ],
        },
      });
      expect(error).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0][0])).toContain("error:not-applicable on openai-chat");
      expect(observationMetrics(defaults)).toEqual([
        'aimock_misbehavior_total{fault="tool-args-invalid-json",outcome="error:not-applicable",wire="openai-chat"} 1',
      ]);
      console.log(
        JSON.stringify({
          cell: "native-error",
          status: response.status,
          body,
          entries: journal.getAll(),
          logs: error.mock.calls,
          metrics: observationMetrics(defaults),
        }),
      );
    },
  );
});

const bypassCases: Array<{
  cell: string;
  proxy?: boolean;
  config: "header" | "server" | "fixture" | "empty" | "absent";
  action?: "rateLimitRate" | "malformedRate" | "dropRate" | "disconnectRate";
  stream?: boolean;
  interrupted?: boolean;
}> = [
  { cell: "proxy-header", proxy: true, config: "header" },
  { cell: "proxy-stream", proxy: true, config: "server", stream: true },
  { cell: "chaos-rate", action: "rateLimitRate", config: "header" },
  { cell: "chaos-malformed", action: "malformedRate", config: "fixture" },
  { cell: "chaos-drop", action: "dropRate", config: "server" },
  { cell: "chaos-disconnect-optout", action: "disconnectRate", config: "empty" },
  { cell: "proxy-malformed", proxy: true, action: "malformedRate", config: "header" },
  {
    cell: "proxy-stream-malformed-bypassed",
    proxy: true,
    action: "malformedRate",
    config: "server",
    stream: true,
  },
  { cell: "proxy-unconfigured", proxy: true, config: "absent" },
  { cell: "chaos-unconfigured", action: "rateLimitRate", config: "absent" },
  { cell: "proxy-optout", proxy: true, config: "empty" },
  { cell: "proxy-interrupted", proxy: true, config: "server", stream: true, interrupted: true },
];

test.each(bypassCases)("O2b actual HTTP bypass: $cell", async (cell) => {
  const directory = await mkdtemp(join(tmpdir(), "aimock-o2b-"));
  const fixturePath = join(directory, "recorded.json");
  const upstream = new LLMock({ port: 0, logLevel: "silent" });
  upstream.addFixture({
    match: {},
    response: { content: "upstream truth" },
    ...(cell.interrupted ? { chunkSize: 2, latency: 5, truncateAfterChunks: 3 } : {}),
  });
  const upstreamUrl = await upstream.start();
  const fixture: Fixture = {
    match: {},
    response: { content: "fixture truth" },
    ...(cell.config === "fixture" ? { misbehavior: "empty-response" as const } : {}),
  };
  setFixtureMisbehaviorPosition(fixture, "code#0");
  const fixtures = cell.proxy ? [] : [fixture];
  let instance: ServerInstance | undefined;
  try {
    instance = await createServer(fixtures, {
      port: 0,
      logLevel: "silent",
      metrics: true,
      ...(cell.proxy ? { record: { providers: { openai: upstreamUrl }, fixturePath } } : {}),
      ...(cell.action ? { chaos: { [cell.action]: 1 } } : {}),
      ...(cell.config === "server"
        ? { misbehavior: { faults: [{ fault: "empty-response" as const, times: 1 }] } }
        : {}),
      ...(cell.config === "empty" ? { misbehavior: { faults: [] } } : {}),
    });
    const { journal, defaults, url } = instance;
    const counters = [
      vi.spyOn(journal, "nextOrdinal"),
      vi.spyOn(journal, "getFiringCount"),
      vi.spyOn(journal, "recordFiring"),
    ];
    const logs = [
      vi.spyOn(defaults.logger, "info"),
      vi.spyOn(defaults.logger, "debug"),
      vi.spyOn(defaults.logger, "warn"),
      vi.spyOn(defaults.logger, "error"),
    ];
    let status: number | undefined;
    let wire = "";
    let transportError: unknown;
    try {
      const response = await fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-test-id": "O2b",
          "x-request-id": "shared-request-id",
          ...(cell.config === "header" ? { "x-aimock-misbehavior": "empty-response;rate=0" } : {}),
        },
        body: JSON.stringify({ ...observationRequest, stream: cell.stream ?? false }),
      });
      status = response.status;
      // Read incrementally so a broken upstream stream retains its delivered prefix.
      const reader = response.body?.getReader();
      if (reader) {
        const decoder = new TextDecoder();
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          wire += decoder.decode(chunk.value, { stream: true });
        }
      }
    } catch (error) {
      transportError = error;
    }
    await vi.waitFor(() => expect(journal.getAll()).toHaveLength(1));
    const entries = journal.getAll();
    const entry = entries[0];
    const metrics = observationMetrics(defaults);
    const misbehaviorLogs = logs
      .flatMap((log) => log.mock.calls)
      .filter(([message]) => String(message).startsWith("[misbehavior]"));
    const expectedStatus =
      cell.action === "rateLimitRate"
        ? 429
        : cell.action === "dropRate"
          ? 500
          : cell.action === "disconnectRate"
            ? 0
            : 200;
    const recorded =
      cell.proxy && !cell.interrupted
        ? (
            await Promise.all(
              (await readdir(fixturePath, { recursive: true }))
                .filter((file) => file.endsWith(".json"))
                .map((file) => readFile(join(fixturePath, file), "utf8")),
            )
          ).join("\n")
        : undefined;
    console.log(
      JSON.stringify({
        cell: cell.cell,
        status,
        wire,
        transportError: String(transportError),
        entries,
        metrics,
        logs: misbehaviorLogs,
        counters: counters.map((spy) => spy.mock.calls),
        recorded,
        upstream: upstream.getRequests(),
      }),
    );
    expect(entry.response.status).toBe(expectedStatus);
    if (cell.action === "disconnectRate" || cell.interrupted) expect(transportError).toBeDefined();
    else {
      expect(transportError).toBeUndefined();
      expect(status).toBe(expectedStatus);
    }
    if (cell.proxy) {
      expect(upstream.getRequests()).toHaveLength(1);
      if (!cell.interrupted) expect(recorded).toContain("upstream truth");
      if (!cell.action && !cell.interrupted)
        expect(wire).toContain(cell.stream ? "upstream" : "upstream truth");
    }
    if (cell.action === "malformedRate" && !cell.stream)
      expect(wire).toBe("{malformed json: <<<chaos>>>");
    if (cell.interrupted)
      expect(entry.response).toMatchObject({
        interrupted: true,
        interruptReason: "proxy stream destroyed",
      });
    expect(metrics).toEqual([]);
    expect(misbehaviorLogs).toEqual([]);
    for (const counter of counters) expect(counter).not.toHaveBeenCalled();
    if (cell.config === "absent") expect(entry.response).not.toHaveProperty("misbehavior");
    else
      expect(entry.response.misbehavior).toEqual({
        applied: false,
        source: cell.config === "empty" ? "server" : cell.config,
        wire: "openai-chat",
        reason: cell.action && !(cell.proxy && cell.stream) ? "chaos-fired" : "proxied",
        evaluations: [],
      });
  } finally {
    const server = instance?.server;
    if (server)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    await upstream.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("O2b bypass leaves the first normal ordinal and firing budget available", async () => {
  const instance = await createServer([{ match: {}, response: { content: "fixture truth" } }], {
    port: 0,
    metrics: true,
    logLevel: "silent",
    misbehavior: { faults: [{ fault: "empty-response", times: 1 }] },
  });
  try {
    const client = new OpenAI({
      baseURL: `${instance.url}/v1`,
      apiKey: "local",
      maxRetries: 0,
      timeout: 5000,
    });
    await expect(
      client.chat.completions.create(observationRequest, {
        headers: { "x-aimock-chaos-ratelimit": "1" },
      }),
    ).rejects.toMatchObject({ status: 429 });
    expect(observationMetrics(instance.defaults)).toEqual([]);
    const first = await client.chat.completions.create(observationRequest);
    const second = await client.chat.completions.create(observationRequest);
    expect(first.choices[0].message.content).toBe("");
    expect(second.choices[0].message.content).toBe("fixture truth");
    const entries = instance.journal.getAll();
    expect(entries).toHaveLength(3);
    expect(entries[0].response.misbehavior?.reason).toBe("chaos-fired");
    expect(entries[1].response.misbehavior).toMatchObject({ applied: true, ordinal: 0 });
    expect(entries[2].response.misbehavior).toMatchObject({
      applied: false,
      reason: "times-exhausted",
    });
    expect(observationMetrics(instance.defaults)).toEqual([
      'aimock_misbehavior_total{fault="empty-response",outcome="applied",wire="openai-chat"} 1',
      'aimock_misbehavior_total{fault="empty-response",outcome="skipped:times-exhausted",wire="openai-chat"} 1',
    ]);
    console.log(
      JSON.stringify({
        cell: "bypass-budget",
        entries,
        metrics: observationMetrics(instance.defaults),
      }),
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      instance.server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("O2b concurrent proxy and chaos requests sharing a request ID retain their own markers", async () => {
  let releaseUpstream = () => {};
  let markUpstreamSeen = () => {};
  const upstreamGate = new Promise<void>((resolve) => {
    releaseUpstream = resolve;
  });
  const upstreamSeen = new Promise<void>((resolve) => {
    markUpstreamSeen = resolve;
  });
  const upstream = new LLMock({ port: 0, logLevel: "silent" });
  upstream.addFixture({
    match: {},
    response: async () => {
      markUpstreamSeen();
      await upstreamGate;
      return { content: "upstream truth" };
    },
  });
  const upstreamUrl = await upstream.start();
  const instance = await createServer([], {
    port: 0,
    metrics: true,
    logLevel: "silent",
    record: { providers: { openai: upstreamUrl }, proxyOnly: true },
    misbehavior: "empty-response",
  });
  try {
    const headers = { "Content-Type": "application/json", "x-request-id": "shared-request-id" };
    const proxyResponse = fetch(`${instance.url}/v1/chat/completions?testId=proxy`, {
      method: "POST",
      headers,
      body: JSON.stringify(observationRequest),
    });
    await upstreamSeen;
    const chaosResponse = await fetch(`${instance.url}/v1/chat/completions?testId=chaos`, {
      method: "POST",
      headers: {
        ...headers,
        "x-aimock-chaos-ratelimit": "1",
        "x-aimock-misbehavior": "empty-response;rate=0",
      },
      body: JSON.stringify(observationRequest),
    });
    expect(chaosResponse.status).toBe(429);
    await chaosResponse.text();
    releaseUpstream();
    expect(await (await proxyResponse).text()).toContain("upstream truth");
    await vi.waitFor(() => expect(instance.journal.getAll()).toHaveLength(2));
    const entries = instance.journal.getAll();
    expect(entries[0].path).toContain("testId=chaos");
    expect(entries[0].response.misbehavior).toMatchObject({
      source: "header",
      reason: "chaos-fired",
      evaluations: [],
    });
    expect(entries[1].path).toContain("testId=proxy");
    expect(entries[1].response.misbehavior).toMatchObject({
      source: "server",
      reason: "proxied",
      evaluations: [],
    });
    expect(observationMetrics(instance.defaults)).toEqual([]);
    console.log(JSON.stringify({ cell: "concurrent-request-identity", entries }));
  } finally {
    releaseUpstream();
    await new Promise<void>((resolve, reject) =>
      instance.server.close((error) => (error ? reject(error) : resolve())),
    );
    await upstream.stop();
  }
});
