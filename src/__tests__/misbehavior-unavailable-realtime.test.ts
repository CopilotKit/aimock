import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TEST_ID } from "../journal.js";
import { createServer, type ServerInstance } from "../server.js";
import type { Fixture, FixtureResponse, MisbehaviorConfig } from "../types.js";
import { connectWebSocket, type WSTestClient } from "./ws-test-client.js";

let server: ServerInstance;
let ws: WSTestClient | undefined;
afterEach(async () => {
  ws?.destroy();
  ws = undefined;
  if (server) await new Promise<void>((resolve) => server.server.close(() => resolve()));
});

const fault: MisbehaviorConfig = { faults: [{ fault: "refusal", times: 1 }] };
const responses: [string, FixtureResponse][] = [
  ["text", { content: "hello" }],
  ["tool", { toolCalls: [{ name: "weather", arguments: '{"city":"Paris"}' }] }],
  ["combined", { content: "checking", toolCalls: [{ name: "weather", arguments: "{}" }] }],
  [
    "ordered blocks",
    {
      blocks: [
        { type: "text", text: "checking" },
        { type: "toolCall", name: "weather", arguments: "{}" },
      ],
    },
  ],
];

async function turn(client: WSTestClient) {
  const start = client.getMessages().length;
  client.send(JSON.stringify({ type: "response.create" }));
  for (let count = start + 1; ; count++) {
    const raw = await client.waitForMessages(count);
    const event = JSON.parse(raw[count - 1]) as { type: string; error?: { code: string } };
    if (event.type === "error" || event.type === "response.done") return event;
  }
}

async function connect(headers?: Record<string, string>, path = "/v1/realtime") {
  ws = await connectWebSocket(server.url, path, headers);
  await ws.waitForMessages(1);
  return ws;
}

// Permanent Realtime K7 guard. The historical K1 unavailable proof is preserved
// at accepted Q1; supported K1 assertions now live in misbehavior-realtime.test.ts.
describe("Realtime unavailable misbehavior", () => {
  it.each(responses)(
    "rejects explicit %s fault and recovers on the same session",
    async (_name, response) => {
      let calls = 0;
      const fixture: Fixture = {
        match: {},
        response: () => {
          calls++;
          return response;
        },
        misbehavior: fault,
      };
      server = await createServer([fixture], { logLevel: "silent" });
      const client = await connect();
      expect(await turn(client)).toMatchObject({
        type: "error",
        error: { code: "aimock_misbehavior_unsupported" },
      });
      expect(calls).toBe(1);
      expect(server.journal.getAll()).toHaveLength(1);
      expect(server.journal.getAll()[0].response).toMatchObject({
        status: 501,
        misbehavior: {
          applied: false,
          evaluations: [{ outcome: "error", reason: "unsupported-on-wire" }],
        },
      });
      fixture.misbehavior = { faults: [] };
      expect(await turn(client)).toMatchObject({ type: "response.done" });
      expect(calls).toBe(2);
      expect(server.journal.getAll()).toHaveLength(2);
    },
  );

  it.each(responses)("records baseline %s skip without rolling", async (_name, response) => {
    server = await createServer([{ match: {}, response }], {
      misbehavior: fault,
      metrics: true,
      logLevel: "silent",
    });
    const client = await connect();
    expect(await turn(client)).toMatchObject({ type: "response.done" });
    expect(server.journal.getAll()).toHaveLength(1);
    const summary = server.journal.getAll()[0].response.misbehavior;
    expect(summary).toMatchObject({
      applied: false,
      source: "server",
      wire: "openai-realtime",
      evaluations: [
        {
          entryIndex: 0,
          fault: "refusal",
          outcome: "skipped",
          reason: "unsupported-on-wire",
        },
      ],
    });
    expect(summary?.evaluations[0]).not.toHaveProperty("ordinal");
    const key = { testId: DEFAULT_TEST_ID, sourceKey: "server", entryIndex: 0 };
    expect(server.journal.getFiringCount(key)).toBe(0);
    expect(server.journal.nextOrdinal(key)).toBe(0);

    const metrics = await (await fetch(`${server.url}/metrics`)).text();
    expect(metrics).toContain(
      'aimock_misbehavior_total{fault="refusal",outcome="skipped:unsupported-on-wire",wire="openai-realtime"} 1',
    );
  });

  it("uses the session query test ID for live runtime overrides", async () => {
    server = await createServer([{ match: {}, response: responses[1][1] }], { logLevel: "silent" });
    const client = await connect(undefined, "/v1/realtime?testId=scoped-realtime");
    expect(await turn(client)).toMatchObject({ type: "response.done" });
    expect(server.journal.getAll()[0].response).not.toHaveProperty("misbehavior");
    const installed = await fetch(`${server.url}/__aimock/misbehavior`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-id": "scoped-realtime" },
      body: JSON.stringify(fault),
    });
    expect(installed.status).toBe(200);
    expect(await turn(client)).toMatchObject({ type: "response.done" });
    expect(server.journal.getAll()[1].response.misbehavior).toMatchObject({
      source: "scope",
      reason: "unsupported-on-wire",
    });
  });

  it("reports an explicit fault on an error response as not applicable", async () => {
    const fixture: Fixture = {
      match: {},
      response: { error: { message: "native fixture error", code: "native_code" }, status: 429 },
      misbehavior: fault,
    };
    server = await createServer([fixture], { logLevel: "silent" });
    const client = await connect();
    expect(await turn(client)).toMatchObject({
      type: "error",
      error: { code: "aimock_misbehavior_not_applicable" },
    });
    expect(server.journal.getAll()[0].response).toMatchObject({
      status: 501,
      misbehavior: { reason: "not-applicable" },
    });
    fixture.misbehavior = { faults: [] };
    expect(await turn(client)).toMatchObject({
      type: "response.done",
      response: { status_details: { error: { code: "native_code" } } },
    });
    expect(server.journal.getAll()[1].response.status).toBe(429);
  });

  it("skips baseline fault on an error response without changing native status", async () => {
    server = await createServer(
      [{ match: {}, response: { error: { message: "native" }, status: 429 } }],
      { misbehavior: fault, logLevel: "silent" },
    );
    expect(await turn(await connect())).toMatchObject({ type: "response.done" });
    expect(server.journal.getAll()).toHaveLength(1);
    expect(server.journal.getAll()[0].response).toMatchObject({
      status: 429,
      misbehavior: { reason: "not-applicable" },
    });
  });

  it("filters provider-excluded explicit faults", async () => {
    server = await createServer(
      [
        {
          match: {},
          response: responses[1][1],
          misbehavior: {
            faults: [{ fault: "refusal", providers: ["openai-chat"] }],
          },
        },
      ],
      { logLevel: "silent" },
    );
    expect(await turn(await connect())).toMatchObject({ type: "response.done" });
    expect(server.journal.getAll()[0].response.misbehavior).toMatchObject({
      reason: "provider-excluded",
    });
  });

  it.each(["refusal", "unknown-fault"])(
    "rejects upgrade header %s before any session",
    async (header) => {
      server = await createServer([], { logLevel: "silent" });
      await expect(
        connectWebSocket(server.url, "/v1/realtime", { "x-aimock-misbehavior": header }),
      ).rejects.toThrow("400");
      expect(server.journal.getAll()).toHaveLength(0);
    },
  );

  it("logs malformed direct fixture errors once and recovers without duplicate evaluated logs", async () => {
    // Observe the real logger's console output without replacing its implementation.
    const errors = vi.spyOn(console, "error");
    try {
      const fixture: Fixture = {
        match: {},
        response: responses[1][1],
        misbehavior: { faults: [{ fault: "refusal", rate: -1 }] },
      };
      server = await createServer([fixture], { logLevel: "warn", metrics: true });
      const client = await connect();
      const event = await turn(client);
      expect(event).toMatchObject({
        type: "error",
        error: { code: "aimock_misbehavior_not_applicable" },
      });
      expect(server.journal.getAll()).toHaveLength(1);
      expect(server.journal.getAll()[0].response).toMatchObject({
        status: 501,
        misbehavior: { applied: false, evaluations: [] },
      });
      const metrics = await (await fetch(`${server.url}/metrics`)).text();
      expect(metrics).not.toContain("aimock_misbehavior_total");
      console.log(
        "Realtime malformed-config native proof",
        event,
        "error log count",
        errors.mock.calls.length,
      );
      expect(errors).toHaveBeenCalledTimes(1);
      expect(errors.mock.calls[0].join(" ")).toContain("[misbehavior]");
      expect(errors.mock.calls[0].join(" ")).toContain("openai-realtime");
      expect(errors.mock.calls[0].join(" ")).toContain("rate");

      fixture.misbehavior = fault;
      expect(await turn(client)).toMatchObject({
        type: "error",
        error: { code: "aimock_misbehavior_unsupported" },
      });
      expect(errors).toHaveBeenCalledTimes(2);
      fixture.misbehavior = { faults: [] };
      expect(await turn(client)).toMatchObject({ type: "response.done" });
      expect(server.journal.getAll()).toHaveLength(3);
      expect(server.journal.getAll()[2].response.status).toBe(200);
      expect(errors).toHaveBeenCalledTimes(2);
    } finally {
      if (ws) {
        ws.close();
        await ws.waitForClose();
        ws = undefined;
      }
      errors.mockRestore();
    }
  });

  it("preserves the retired beta native error and close", async () => {
    server = await createServer([], { misbehavior: fault, logLevel: "silent" });
    const client = await connect({ "openai-beta": "realtime=v1" });
    expect(JSON.parse(client.getMessages()[0])).toMatchObject({
      type: "error",
      error: { code: "beta_api_shape_disabled" },
    });
    expect(await client.waitForCloseFrame()).toMatchObject({ code: 4000 });
    expect(server.journal.getAll()).toHaveLength(0);
  });
});
