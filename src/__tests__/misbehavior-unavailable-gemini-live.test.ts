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

const livePath = "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

const fault: MisbehaviorConfig = { faults: [{ fault: "stop-length-mid-tool", times: 1 }] };
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

async function turn(client: WSTestClient, toolResponse = false) {
  const start = client.getMessages().length;
  client.send(
    JSON.stringify(
      toolResponse
        ? {
            toolResponse: {
              functionResponses: [
                { id: "call_weather", name: "weather", response: { result: "sunny" } },
              ],
            },
          }
        : {
            clientContent: {
              turns: [{ role: "user", parts: [{ text: "hello" }] }],
              turnComplete: true,
            },
          },
    ),
  );
  for (let count = start + 1; ; count++) {
    const raw = await client.waitForMessages(count);
    const event = JSON.parse(raw[count - 1]) as {
      serverContent?: { turnComplete?: boolean };
      error?: { code: number; status: string };
    };
    if (event.error || event.serverContent?.turnComplete) return event;
  }
}

async function connect(headers?: Record<string, string>, path = livePath) {
  ws = await connectWebSocket(server.url, path, headers);
  ws.send(JSON.stringify({ setup: { model: "gemini-live" } }));
  await ws.waitForMessages(1);
  return ws;
}

// Stage 4 positive K1–K4/K6 proofs live in misbehavior-gemini-live.test.ts.
// These inherited guards now use permanently unsupported K5; Q1 proof stays archived.
describe("Gemini Live unavailable misbehavior", () => {
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
        error: { code: 12, status: "UNIMPLEMENTED" },
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
      expect(await turn(client)).toMatchObject({ serverContent: { turnComplete: true } });
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
    expect(await turn(client)).toMatchObject({ serverContent: { turnComplete: true } });
    expect(server.journal.getAll()).toHaveLength(1);
    const summary = server.journal.getAll()[0].response.misbehavior;
    expect(summary).toMatchObject({
      applied: false,
      source: "server",
      wire: "gemini-live",
      evaluations: [
        {
          entryIndex: 0,
          fault: "stop-length-mid-tool",
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
      'aimock_misbehavior_total{fault="stop-length-mid-tool",outcome="skipped:unsupported-on-wire",wire="gemini-live"} 1',
    );
  });

  it.each<MisbehaviorConfig>([
    { faults: [{ fault: "refusal" }] },
    { faults: [{ fault: "content-filter" }] },
    { faults: [{ fault: "reasoning-only" }] },
    { faults: [{ fault: "tool-args-schema-violation", violation: "not-object" }] },
  ])("preserves permanent Live fault/parameter boundary %j", async (misbehavior) => {
    server = await createServer([{ match: {}, response: responses[1][1], misbehavior }], {
      logLevel: "silent",
    });
    expect(await turn(await connect())).toMatchObject({
      error: { code: 12, status: "UNIMPLEMENTED" },
    });
    expect(server.journal.getAll()).toHaveLength(1);
    expect(server.journal.getAll()[0].response.misbehavior).toMatchObject({
      reason: "unsupported-on-wire",
    });
  });

  it("guards toolResponse turns and recovers on the same session", async () => {
    const fixture: Fixture = { match: {}, response: responses[1][1], misbehavior: fault };
    server = await createServer([fixture], { logLevel: "silent" });
    const client = await connect();
    expect(await turn(client, true)).toMatchObject({
      error: { code: 12, status: "UNIMPLEMENTED" },
    });
    fixture.misbehavior = { faults: [] };
    expect(await turn(client, true)).toMatchObject({ serverContent: { turnComplete: true } });
    expect(server.journal.getAll()).toHaveLength(2);
  });

  it.each<FixtureResponse>([
    { audio: { b64Json: "QUJD", contentType: "audio/pcm;rate=24000" } },
    {
      audio: { b64Json: "QUJD", contentType: "audio/pcm;rate=24000" },
      content: "companion",
      toolCalls: [{ name: "weather", arguments: "{}" }],
    },
  ])("guards audio families without losing native output after opt-out: %j", async (response) => {
    const fixture: Fixture = { match: {}, response, misbehavior: fault };
    server = await createServer([fixture], { logLevel: "silent" });
    const client = await connect();
    expect(await turn(client)).toMatchObject({ error: { code: 12, status: "UNIMPLEMENTED" } });
    expect(server.journal.getAll()).toHaveLength(1);
    fixture.misbehavior = { faults: [] };
    expect(await turn(client)).toMatchObject({ serverContent: { turnComplete: true } });
    expect(client.getMessages().some((raw) => raw.includes('"inlineData"'))).toBe(true);
    expect(server.journal.getAll()).toHaveLength(2);
  });

  it("uses the session query test ID for live runtime overrides", async () => {
    server = await createServer([{ match: {}, response: responses[1][1] }], { logLevel: "silent" });
    const client = await connect(undefined, `${livePath}?testId=scoped-live`);
    expect(await turn(client)).toMatchObject({ serverContent: { turnComplete: true } });
    expect(server.journal.getAll()[0].response).not.toHaveProperty("misbehavior");
    const installed = await fetch(`${server.url}/__aimock/misbehavior`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-id": "scoped-live" },
      body: JSON.stringify(fault),
    });
    expect(installed.status).toBe(200);
    expect(await turn(client)).toMatchObject({ serverContent: { turnComplete: true } });
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
      error: { code: 12, status: "UNIMPLEMENTED" },
    });
    expect(server.journal.getAll()[0].response).toMatchObject({
      status: 501,
      misbehavior: { reason: "not-applicable" },
    });
    fixture.misbehavior = { faults: [] };
    expect(await turn(client)).toMatchObject({
      error: { code: 8, message: "native fixture error" },
    });
    expect(server.journal.getAll()[1].response.status).toBe(429);
  });

  it("skips baseline fault on an error response without changing native status", async () => {
    server = await createServer(
      [{ match: {}, response: { error: { message: "native" }, status: 429 } }],
      { misbehavior: fault, logLevel: "silent" },
    );
    expect(await turn(await connect())).toMatchObject({ error: { code: 8, message: "native" } });
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
            faults: [{ fault: "tool-args-invalid-json", providers: ["openai-chat"] }],
          },
        },
      ],
      { logLevel: "silent" },
    );
    expect(await turn(await connect())).toMatchObject({ serverContent: { turnComplete: true } });
    expect(server.journal.getAll()[0].response.misbehavior).toMatchObject({
      reason: "provider-excluded",
    });
  });

  it.each(["tool-args-invalid-json", "unknown-fault"])(
    "rejects upgrade header %s before any session",
    async (header) => {
      server = await createServer([], { logLevel: "silent" });
      await expect(
        connectWebSocket(server.url, livePath, { "x-aimock-misbehavior": header }),
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
        misbehavior: { faults: [{ fault: "tool-args-invalid-json", rate: -1 }] },
      };
      server = await createServer([fixture], { logLevel: "warn", metrics: true });
      const client = await connect();
      const event = await turn(client);
      expect(event).toMatchObject({
        error: { code: 12, status: "UNIMPLEMENTED" },
      });
      expect(server.journal.getAll()).toHaveLength(1);
      expect(server.journal.getAll()[0].response).toMatchObject({
        status: 501,
        misbehavior: { applied: false, evaluations: [] },
      });
      const metrics = await (await fetch(`${server.url}/metrics`)).text();
      expect(metrics).not.toContain("aimock_misbehavior_total");
      console.log(
        "Gemini Live malformed-config native proof",
        event,
        "error log count",
        errors.mock.calls.length,
      );
      expect(errors).toHaveBeenCalledTimes(1);
      expect(errors.mock.calls[0].join(" ")).toContain("[misbehavior]");
      expect(errors.mock.calls[0].join(" ")).toContain("gemini-live");
      expect(errors.mock.calls[0].join(" ")).toContain("rate");

      fixture.misbehavior = fault;
      expect(await turn(client)).toMatchObject({
        error: { code: 12, status: "UNIMPLEMENTED" },
      });
      expect(errors).toHaveBeenCalledTimes(2);
      fixture.misbehavior = { faults: [] };
      expect(await turn(client)).toMatchObject({ serverContent: { turnComplete: true } });
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
});
