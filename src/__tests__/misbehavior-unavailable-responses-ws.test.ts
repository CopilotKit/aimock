import { afterEach, describe, expect, test, vi } from "vitest";
import { LLMock } from "../llmock.js";
import { createServer, type ServerInstance } from "../server.js";
import type { FixtureResponse, MisbehaviorConfig } from "../types.js";
import type { ResponsesSSEEvent } from "../responses.js";
import { connectWebSocket, type WSTestClient } from "./ws-test-client.js";

let mock: LLMock | undefined;
let ws: WSTestClient | undefined;
let directServer: ServerInstance | undefined;
afterEach(async () => {
  if (ws) {
    ws.close();
    await ws.waitForClose();
    ws.destroy();
  }
  ws = undefined;
  await mock?.stop();
  mock = undefined;
  if (directServer) {
    await new Promise<void>((resolve, reject) => {
      directServer!.server.close((error) => (error ? reject(error) : resolve()));
    });
    directServer = undefined;
  }
  vi.restoreAllMocks();
});

const outputs: { name: string; response: FixtureResponse }[] = [
  { name: "text", response: { content: "hello" } },
  { name: "tool", response: { toolCalls: [{ name: "weather", arguments: '{"city":"Paris"}' }] } },
  {
    name: "combined",
    response: { content: "hello", toolCalls: [{ name: "weather", arguments: '{"city":"Paris"}' }] },
  },
];
const fault: MisbehaviorConfig = { faults: [{ fault: "empty-response", rate: 1, times: 1 }] };

test.each(["malformed", "evaluated"] as const)(
  "direct server %s fixture errors log exactly once and recover without phantom metrics",
  async (kind) => {
    const errors = vi.spyOn(console, "error");
    directServer = await createServer(
      [
        {
          match: { userMessage: "fault" },
          response: { content: "hello" },
          misbehavior:
            kind === "malformed"
              ? { faults: [{ fault: "empty-response", rate: -1 }] }
              : { faults: [{ fault: "tool-args-invalid-json" }] },
        },
        { match: { userMessage: "valid" }, response: { content: "recovered" } },
      ],
      { port: 0, metrics: true, logLevel: "warn" },
    );
    ws = await connectWebSocket(directServer.url, "/v1/responses", { "X-Test-Id": "u3-log" });
    const failed = await exchange("fault");
    expect(failed).toMatchObject([
      {
        type: "error",
        error: {
          type: "invalid_request_error",
          code: "aimock_misbehavior_not_applicable",
          message: expect.stringContaining("openai-responses"),
        },
      },
    ]);
    expect(directServer.journal.getAll()).toHaveLength(1);
    const failedEntry = directServer.journal.getAll()[0];
    expect(failedEntry.response.status).toBe(501);
    expect(failedEntry.response.misbehavior?.evaluations).toHaveLength(
      kind === "malformed" ? 0 : 1,
    );
    expectComplete(await exchange("valid"), { content: "recovered" });
    expect(directServer.journal.getAll().map((entry) => entry.response.status)).toEqual([501, 200]);
    const metrics = await (await fetch(`${directServer.url}/metrics`)).text();
    if (kind === "malformed") expect(metrics).not.toContain("aimock_misbehavior_total");
    else
      expect(metrics).toMatch(
        /aimock_misbehavior_total\{[^\n]*outcome="error:not-applicable"[^\n]*\} 1/,
      );
    const logs = errors.mock.calls.filter((args) =>
      args.some((arg) => typeof arg === "string" && arg.includes("[misbehavior]")),
    );
    console.log(JSON.stringify({ kind, failed, failedEntry, metrics, errorLogs: logs }));
    expect(logs).toHaveLength(1);
    expect(logs[0].join(" ")).toContain("openai-responses");
  },
);

async function exchange(input: string, stream = true) {
  if (!ws) throw new Error("WebSocket is not connected");
  const offset = ws.getMessages().length;
  ws.send(JSON.stringify({ type: "response.create", model: "gpt-4o", input, stream }));
  const events: ResponsesSSEEvent[] = [];
  for (;;) {
    const messages = await ws.waitForMessages(offset + events.length + 1);
    const event: ResponsesSSEEvent = JSON.parse(messages.at(-1)!);
    events.push(event);
    if (event.type === "error" || event.type === "response.completed") return events;
  }
}

async function connect(path = "/v1/responses", headers = { "X-Test-Id": "u3" }) {
  if (!mock) throw new Error("Mock is not configured");
  await mock.start();
  ws = await connectWebSocket(mock.url, path, headers);
}

function expectComplete(events: ResponsesSSEEvent[], response?: FixtureResponse) {
  expect(events[0].type).toBe("response.created");
  expect(events.at(-1)?.type).toBe("response.completed");
  if (response && "content" in response) {
    expect(
      events
        .filter((event) => event.type === "response.output_text.delta")
        .map((event) => event.delta)
        .join(""),
    ).toBe(response.content);
  }
  if (response && "toolCalls" in response && response.toolCalls) {
    expect(events.at(-1)).toMatchObject({
      response: {
        output: expect.arrayContaining(
          response.toolCalls.map((call) =>
            expect.objectContaining({
              type: "function_call",
              name: call.name,
              arguments: call.arguments,
            }),
          ),
        ),
      },
    });
  }
}

describe.each(outputs)("Responses WS $name inherited guard transition", ({ name, response }) => {
  test("explicit supported fault applies, then the same connection recovers", async () => {
    mock = new LLMock({ port: 0 });
    let calls = 0;
    mock.addFixture({
      match: { userMessage: "fault" },
      response: (request) => {
        calls++;
        expect(request.messages).toEqual([{ role: "user", content: "fault" }]);
        return response;
      },
      misbehavior: fault,
    });
    mock.addFixture({ match: { userMessage: "valid" }, response });
    await connect();
    const applied = await exchange("fault", false);
    const recovered = await exchange("valid");
    const entries = mock.getRequests();
    console.log(JSON.stringify({ cell: name, applied, recovered: recovered.at(-1), entries }));
    expectComplete(applied);
    expect(applied.at(-1)).toMatchObject({ response: { output: [] } });
    expectComplete(recovered, response);
    expect(calls).toBe(1);
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.response.status)).toEqual([200, 200]);
    expect(entries[0].response.fixture).toBe(mock.getFixtures()[0]);
    expect(entries[0].response.misbehavior).toMatchObject({
      applied: true,
      source: "fixture",
      wire: "openai-responses",
      evaluations: [{ entryIndex: 0, fault: "empty-response", outcome: "applied", ordinal: 0 }],
    });
    expect(entries[0].response.misbehavior?.servedToolCalls).toEqual([]);
    expect(entries[1].response.misbehavior).toBeUndefined();
  });

  test.each(["scope", "server"] as const)(
    "%s applies once then preserves output without spending another roll",
    async (source) => {
      const warnings = vi.spyOn(console, "warn");
      mock = new LLMock({
        port: 0,
        metrics: true,
        logLevel: "warn",
        ...(source === "server" ? { misbehavior: fault } : {}),
      });
      mock.addFixture({ match: { userMessage: "valid" }, response });
      await connect();
      if (source === "scope") {
        const installed = await fetch(`${mock.url}/__aimock/misbehavior`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Test-Id": "u3" },
          body: JSON.stringify(fault),
        });
        expect(installed.status).toBe(200);
      }
      const first = await exchange("valid");
      expectComplete(first);
      expect(first.at(-1)).toMatchObject({ response: { output: [] } });
      expectComplete(await exchange("valid"), response);
      const entries = mock.getRequests();
      expect(entries).toHaveLength(2);
      expect(entries.map((entry) => entry.response.status)).toEqual([200, 200]);
      expect(entries[0].response.misbehavior).toMatchObject({
        applied: true,
        source,
        wire: "openai-responses",
        servedToolCalls: [],
        evaluations: [{ entryIndex: 0, fault: "empty-response", outcome: "applied", ordinal: 0 }],
      });
      expect(entries[1].response.misbehavior).toMatchObject({
        applied: false,
        source,
        wire: "openai-responses",
        evaluations: [
          { entryIndex: 0, fault: "empty-response", outcome: "skipped", reason: "times-exhausted" },
        ],
      });
      expect(entries[1].response.misbehavior?.evaluations[0].ordinal).toBeUndefined();
      const key = {
        testId: "u3",
        sourceKey: source === "scope" ? "scope:u3" : "server",
        entryIndex: 0,
      };
      expect(mock.journal.getFiringCount(key)).toBe(1);
      expect(mock.journal.nextOrdinal(key)).toBe(1);
      const metrics = await (await fetch(`${mock.url}/metrics`)).text();
      expect(metrics).toMatch(/aimock_misbehavior_total\{[^\n]*outcome="applied"[^\n]*\} 1/);
      expect(metrics).toMatch(
        /aimock_misbehavior_total\{[^\n]*outcome="skipped:times-exhausted"[^\n]*\} 1/,
      );
      expect(
        warnings.mock.calls.filter((args) =>
          args.some((arg) => typeof arg === "string" && arg.includes("[misbehavior]")),
        ),
      ).toHaveLength(0);
      console.log(JSON.stringify({ cell: name, source, entries, metrics }));
    },
  );
});

test("provider-excluded explicit config preserves output and records the skip", async () => {
  mock = new LLMock({ port: 0 });
  mock.addFixture({
    match: { userMessage: "valid" },
    response: { content: "hello" },
    misbehavior: { faults: [{ fault: "empty-response", providers: ["openai-chat"] }] },
  });
  await connect();
  expectComplete(await exchange("valid"));
  expect(mock.getRequests()).toHaveLength(1);
  expect(mock.getRequests()[0].response.misbehavior).toMatchObject({
    applied: false,
    reason: "provider-excluded",
    evaluations: [{ outcome: "skipped", reason: "provider-excluded" }],
  });
});

test("a factory error response gets not-applicable and permits the next valid turn", async () => {
  mock = new LLMock({ port: 0 });
  mock.addFixture({
    match: { userMessage: "fault" },
    response: () => ({ error: { message: "upstream error" }, status: 429 }),
    misbehavior: fault,
  });
  mock.addFixture({ match: { userMessage: "valid" }, response: { content: "hello" } });
  await connect();
  const failed = await exchange("fault");
  expect(failed).toMatchObject([
    { type: "error", error: { code: "aimock_misbehavior_not_applicable" } },
  ]);
  expectComplete(await exchange("valid"));
  expect(mock.getRequests().map((entry) => entry.response.status)).toEqual([501, 200]);
});

test("query-scoped runtime config is observed on the WebSocket session", async () => {
  mock = new LLMock({ port: 0 });
  mock.addFixture({ match: {}, response: { content: "hello" } });
  await connect("/v1/responses?testId=query-u3", { "X-Test-Id": "" });
  const installed = await fetch(`${mock.url}/__aimock/misbehavior`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Test-Id": "query-u3" },
    body: JSON.stringify(fault),
  });
  expect(installed.status).toBe(200);
  expectComplete(await exchange("valid"));
  expect(mock.getRequests()[0].response.misbehavior).toMatchObject({
    source: "scope",
    applied: true,
  });
});

test.each(["empty-response", "not-a-fault"])(
  "upgrade rejects %s header even when scope would skip",
  async (header) => {
    mock = new LLMock({ port: 0, misbehavior: fault });
    mock.addFixture({ match: {}, response: { content: "hello" } });
    await mock.start();
    await expect(
      connectWebSocket(mock.url, "/v1/responses", { "X-Aimock-Misbehavior": header }),
    ).rejects.toThrow("400");
    expect(mock.getRequests()).toHaveLength(0);
  },
);

test("permanent refusal-category guard errors explicitly, skips at scope, and keeps the socket open", async () => {
  const category: MisbehaviorConfig = { faults: [{ fault: "refusal", category: "safety" }] };
  directServer = await createServer(
    [
      { match: { userMessage: "fault" }, response: { content: "hello" }, misbehavior: category },
      { match: { userMessage: "valid" }, response: { content: "hello" } },
    ],
    { port: 0, misbehavior: category, metrics: true },
  );
  ws = await connectWebSocket(directServer.url, "/v1/responses", { "X-Test-Id": "category" });
  expect(await exchange("fault")).toMatchObject([
    { type: "error", error: { code: "aimock_misbehavior_unsupported" } },
  ]);
  expectComplete(await exchange("valid"), { content: "hello" });
  const entries = directServer.journal.getAll();
  expect(entries.map((entry) => entry.response.status)).toEqual([501, 200]);
  expect(entries[1].response.misbehavior).toMatchObject({
    applied: false,
    source: "server",
    reason: "unsupported-on-wire",
    evaluations: [{ fault: "refusal", outcome: "skipped", reason: "unsupported-on-wire" }],
  });
  const key = { testId: "category", sourceKey: "server", entryIndex: 0 };
  expect(directServer.journal.getFiringCount(key)).toBe(0);
  expect(directServer.journal.nextOrdinal(key)).toBe(0);
});
