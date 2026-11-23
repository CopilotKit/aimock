import * as http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeDeliveryLifecycle, HARNESS_MATCH } from "../helpers/delivery-lifecycle-harness.js";
import { LLMock } from "../helpers/misbehavior-enabled.js";
import type { Fixture } from "../../types.js";

const messages = [{ role: "user", content: HARNESS_MATCH }];
const line = (obj: Record<string, unknown>) => JSON.stringify(obj) + "\n";
const created_at = "2024-01-01T00:00:00Z";

describeDeliveryLifecycle({
  name: "Ollama chat",
  streamPath: "/api/chat",
  nonStreamPath: "/api/chat",
  streamBody: { model: "llama3", messages },
  // Ollama streams unless the request sends `stream: false` explicitly.
  nonStreamBody: { model: "llama3", messages, stream: false },
  bodyKind: "json",
  transport: "http",
  surface: "other",
  proxy: {
    provider: "ollama",
    contentType: "application/x-ndjson",
    frames: [
      line({
        model: "llama3",
        created_at,
        message: { role: "assistant", content: "alpha " },
        done: false,
      }),
      line({
        model: "llama3",
        created_at,
        message: { role: "assistant", content: "beta " },
        done: false,
      }),
      line({
        model: "llama3",
        created_at,
        message: { role: "assistant", content: "gamma" },
        done: false,
      }),
      line({
        model: "llama3",
        created_at,
        message: { role: "assistant", content: "" },
        done: true,
      }),
    ],
  },
});

describeDeliveryLifecycle({
  name: "Ollama generate",
  streamPath: "/api/generate",
  nonStreamPath: "/api/generate",
  streamBody: { model: "llama3", prompt: HARNESS_MATCH },
  nonStreamBody: { model: "llama3", prompt: HARNESS_MATCH, stream: false },
  bodyKind: "json",
  transport: "http",
  surface: "other",
  proxy: {
    provider: "ollama",
    contentType: "application/x-ndjson",
    frames: [
      line({ model: "llama3", created_at, response: "alpha ", done: false }),
      line({ model: "llama3", created_at, response: "beta ", done: false }),
      line({ model: "llama3", created_at, response: "gamma", done: false }),
      line({ model: "llama3", created_at, response: "", done: true }),
    ],
  },
});

// ─── Misbehavior non-stream replies (plan n1) ──────────────────────────────

interface Reply {
  status: number;
  elapsedMs: number;
  body: string;
}

function post(url: string, pathName: string, body: Record<string, unknown>): Promise<Reply> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(pathName, url), {
      method: "POST",
      agent: false,
      headers: { "content-type": "application/json" },
    });
    req.on("response", (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          elapsedMs: Date.now() - start,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

describe("delivery lifecycle: Ollama chat misbehavior non-stream replies", () => {
  let mock: LLMock;
  const weatherTool = {
    type: "function",
    function: {
      name: "weather",
      parameters: { type: "object", properties: { city: { type: "string" } } },
    },
  };
  const request = {
    model: "llama3",
    messages,
    tools: [weatherTool],
    stream: false,
  };

  beforeAll(async () => {
    mock = new LLMock({ port: 0, host: "127.0.0.1", logLevel: "silent" });
    await mock.start();
  });
  afterAll(async () => {
    await mock.stop();
  });

  const serve = async (extra: Partial<Fixture>, misbehavior: Fixture["misbehavior"]) => {
    mock.clearFixtures();
    mock.clearRequests();
    mock.resetMatchCounts();
    mock.addFixture({
      match: { userMessage: HARNESS_MATCH },
      response: { toolCalls: [{ name: "weather", arguments: '{"city":"Paris"}' }] },
      misbehavior,
      ...extra,
    });
    const reply = await post(mock.url, "/api/chat", request);
    return { reply, entry: mock.getRequests().at(-1) };
  };

  it("never delays a misbehavior reply whose status is not 200, and keeps its bytes", async () => {
    const fault: Fixture["misbehavior"] = {
      faults: [{ fault: "tool-args-invalid-json", style: "truncated", tool: "weather" }],
    };
    const base = await serve({}, fault);
    const timed = await serve(
      { nonStreamingTimingAllProviders: true, streamingProfile: { ttft: 2000 } },
      fault,
    );
    expect(base.reply.status).toBe(500);
    expect(timed.reply.status).toBe(500);
    expect(timed.reply.elapsedMs).toBeLessThan(1000);
    expect(timed.reply.body).toBe(base.reply.body);
    expect(timed.entry?.response.status).toBe(500);
    expect(timed.entry?.response.interrupted).toBeUndefined();
  }, 10000);

  it("delays a 200 misbehavior reply when nonStreamingTimingAllProviders is set", async () => {
    const fault: Fixture["misbehavior"] = {
      faults: [{ fault: "tool-unknown-name", tool: "weather", name: "missing_weather" }],
    };
    const instant = await serve({ streamingProfile: { ttft: 300, tps: 10000 } }, fault);
    const timed = await serve(
      { nonStreamingTimingAllProviders: true, streamingProfile: { ttft: 300, tps: 10000 } },
      fault,
    );
    expect(instant.reply.status).toBe(200);
    expect(instant.reply.elapsedMs).toBeLessThan(250);
    expect(timed.reply.status).toBe(200);
    expect(timed.reply.elapsedMs).toBeGreaterThanOrEqual(250);
    expect(timed.reply.body).toContain("missing_weather");
    expect(timed.entry?.response.misbehavior).toMatchObject({ applied: true });
  }, 10000);
});

// /api/generate serves a text fixture's content and never reads its blocks
// (fixture-error-parity.test.ts). The wait is sized from that served text, so
// a block list the chat wire would reject never fails a timed generate reply.
describe("delivery lifecycle: Ollama generate sizes the wait from the served text", () => {
  let mock: LLMock;
  beforeAll(async () => {
    mock = new LLMock({ port: 0, host: "127.0.0.1", logLevel: "silent" });
    await mock.start();
  });
  afterAll(async () => {
    await mock.stop();
  });

  it("delays content plus unread invalid blocks and serves the content", async () => {
    mock.addFixture({
      match: { userMessage: HARNESS_MATCH },
      response: { content: "hi", blocks: [{ type: "toolcall", name: "f", arguments: "{}" }] },
      nonStreamingTimingAllProviders: true,
      streamingProfile: { ttft: 300, tps: 10000 },
    } as Fixture);
    const reply = await post(mock.url, "/api/generate", {
      model: "llama3",
      prompt: HARNESS_MATCH,
      stream: false,
    });
    expect(reply.status, reply.body).toBe(200);
    expect(reply.body).toContain("hi");
    expect(reply.elapsedMs).toBeGreaterThanOrEqual(250);
  }, 10000);
});
