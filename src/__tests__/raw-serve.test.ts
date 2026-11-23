import * as http from "node:http";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Journal } from "../journal.js";
import { Logger } from "../logger.js";
import { serveRawResponse } from "../response/raw.js";
import { LLMock as PlainLLMock } from "../llmock.js";
import { LLMock } from "./helpers/misbehavior-enabled.js";
import type {
  Fixture,
  FixtureFileResponse,
  FixtureOpts,
  HandlerDefaults,
  RawResponse,
  ResponseFactory,
} from "../types.js";

// serveRawResponse (#549), driven through the OpenAI Responses wire: serve-time
// checks for fixtures that skip load validation, status and header passthrough,
// timing rules and misbehavior journaling.

const json = { id: "resp_serve", object: "response", status: "completed", output: [] };
const events = [
  { type: "response.created", response: { id: "resp_serve" } },
  { type: "response.completed", response: { id: "resp_serve" } },
];

let mock: PlainLLMock | undefined;

afterEach(async () => {
  await mock?.stop();
  mock = undefined;
});

async function start(
  response: FixtureFileResponse | ResponseFactory,
  opts?: FixtureOpts,
  server: PlainLLMock = new PlainLLMock({ port: 0, host: "127.0.0.1", logLevel: "silent" }),
): Promise<PlainLLMock> {
  mock = server;
  server.on({ userMessage: "serve" }, response, opts);
  await server.start();
  return server;
}

/** A raw HTTP request, so every byte and header the server wrote is visible. */
function post(
  url: string,
  stream: boolean,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string; ms: number }> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${url}/v1/responses`,
      { method: "POST", headers: { "content-type": "application/json" } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
            ms: Date.now() - started,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify({ model: "gpt-4.1", input: "serve", stream }));
  });
}

const forbidden = {
  raw: {
    wire: "openai-responses",
    json,
    headers: { "content-length": "5", "x-raw-fixture": "leaked" },
  },
} as RawResponse;

describe("serveRawResponse: serve-time checks", () => {
  it("a factory with a forbidden content-length header: 500 with the checker message only", async () => {
    const server = await start(() => forbidden);
    const got = await post(server.url, false);
    expect(got.status).toBe(500);
    expect(got.headers["content-type"]).toBe("application/json");
    const body = JSON.parse(got.body) as { error: { message: string; code: string } };
    expect(body.error.code).toBe("aimock_raw_fixture_invalid");
    expect(body.error.message).toMatch(/^invalid raw fixture: .*content-length/);
    // Nothing of the fixture's own body or headers was written.
    expect(got.body).not.toContain("resp_serve");
    expect(got.headers["x-raw-fixture"]).toBeUndefined();
    // Any Content-Length on the reply is the error body's own length, never the fixture's.
    const bodyLength = String(Buffer.byteLength(got.body));
    expect(got.headers["content-length"] ?? bodyLength).toBe(bodyLength);
    const [entry] = server.getRequests();
    expect(entry.response.status).toBe(500);
    expect(entry.response.error).toBe(body.error.message);
  });

  it("a factory with status 99: 500", async () => {
    const server = await start(() => ({ raw: { wire: "openai-responses", json, status: 99 } }));
    const got = await post(server.url, false);
    expect(got.status).toBe(500);
    expect(JSON.parse(got.body)).toMatchObject({
      error: { code: "aimock_raw_fixture_invalid" },
    });
  });

  it("on() with the same invalid object does not throw, and the request gets the same 500", async () => {
    const server = new PlainLLMock({ port: 0, host: "127.0.0.1", logLevel: "silent" });
    expect(() => server.on({ userMessage: "serve" }, forbidden)).not.toThrow();
    mock = server;
    await server.start();
    const got = await post(server.url, false);
    expect(got.status).toBe(500);
    const body = JSON.parse(got.body) as { error: { message: string; code: string } };
    expect(body.error.code).toBe("aimock_raw_fixture_invalid");
    expect(body.error.message).toMatch(/content-length/);
  });
});

describe("serveRawResponse: status and headers", () => {
  it("status 429 with json returns 429 untimed, even with the timing opt-in set", async () => {
    const server = await start(
      { raw: { wire: "openai-responses", json: { error: { message: "slow down" } }, status: 429 } },
      { streamingProfile: { ttft: 1500, tps: 1 }, nonStreamingTimingAllProviders: true },
    );
    const got = await post(server.url, false);
    expect(got.status).toBe(429);
    expect(JSON.parse(got.body)).toEqual({ error: { message: "slow down" } });
    expect(got.ms).toBeLessThan(1000);
    expect(server.getRequests()[0].response.status).toBe(429);
  });

  it("a custom status and header reach a stream", async () => {
    const server = await start({
      raw: { wire: "openai-responses", events, status: 201, headers: { "x-request-id": "r1" } },
    });
    const got = await post(server.url, true);
    expect(got.status).toBe(201);
    expect(got.headers["x-request-id"]).toBe("r1");
    expect(got.headers["content-type"]).toBe("text/event-stream");
  });
});

describe("serveRawResponse: non-streaming timing (surface rule)", () => {
  const profile = { streamingProfile: { ttft: 1200, tps: 100 } };

  it("nonStreamingTimingAllProviders delays a json reply on a non-chat wire", async () => {
    const server = await start(
      { raw: { wire: "openai-responses", json } },
      { ...profile, nonStreamingTimingAllProviders: true },
    );
    const got = await post(server.url, false);
    expect(got.status).toBe(200);
    expect(got.ms).toBeGreaterThanOrEqual(1000);
  });

  it("nonStreamingTiming alone does not delay a non-chat wire", async () => {
    const server = await start(
      { raw: { wire: "openai-responses", json } },
      { ...profile, nonStreamingTiming: true },
    );
    const got = await post(server.url, false);
    expect(got.status).toBe(200);
    expect(JSON.parse(got.body)).toEqual(json);
    expect(got.ms).toBeLessThan(1000);
  });
});

describe("serveRawResponse: misbehavior journaling", () => {
  it("records the skipped server-level fault on the journal entry", async () => {
    const server = await start(
      { raw: { wire: "openai-responses", json } },
      undefined,
      new LLMock({
        port: 0,
        host: "127.0.0.1",
        logLevel: "silent",
        misbehavior: { faults: [{ fault: "empty-response", rate: 1 }] },
      }),
    );
    const got = await post(server.url, false);
    expect(got.status).toBe(200);
    expect(JSON.parse(got.body)).toEqual(json);
    const [entry] = server.getRequests();
    expect(entry.response.misbehavior).toMatchObject({
      applied: false,
      source: "server",
      wire: "openai-responses",
      evaluations: [{ fault: "empty-response", outcome: "skipped", reason: "not-applicable" }],
    });
  });

  it("records it on a raw error 500 too", async () => {
    const server = await start(
      () => forbidden,
      undefined,
      new LLMock({
        port: 0,
        host: "127.0.0.1",
        logLevel: "silent",
        misbehavior: { faults: [{ fault: "empty-response", rate: 1 }] },
      }),
    );
    const got = await post(server.url, false);
    expect(got.status).toBe(500);
    expect(JSON.parse(got.body)).toMatchObject({
      error: { code: "aimock_raw_fixture_invalid" },
    });
    const [entry] = server.getRequests();
    expect(entry.response.misbehavior).toMatchObject({ applied: false, source: "server" });
  });
});

// ─── Error replies (CR round 1) ─────────────────────────────────────────────

describe("serveRawResponse: error replies are never delayed", () => {
  it("a stream with status 429 is not delayed, even with a streaming profile", async () => {
    const server = await start(
      { raw: { wire: "openai-responses", events, status: 429 } },
      { streamingProfile: { ttft: 1500, tps: 1 } },
    );
    const got = await post(server.url, true);
    expect(got.status).toBe(429);
    expect(got.body).toContain("response.completed");
    expect(got.ms).toBeLessThan(1000);
    expect(server.getRequests()[0].response.status).toBe(429);
  });

  it("a non-streaming 429 after the client left is journaled as client aborted and not written", async () => {
    const journal = new Journal();
    const response: RawResponse = {
      raw: { wire: "openai-responses", json: { error: "slow down" }, status: 429 },
    };
    const fixture: Fixture = { match: { userMessage: "serve" }, response };
    const defaults: HandlerDefaults = {
      latency: 0,
      chunkSize: 20,
      replaySpeed: 1,
      logger: new Logger("silent"),
    };
    let headersSent: boolean | undefined;
    let done: Promise<void> = Promise.resolve();
    const server = http.createServer((req, res) => {
      // Serve only once the client has gone.
      req.socket.once("close", () => {
        done = serveRawResponse({
          wire: "openai-responses",
          stream: false,
          req,
          res,
          fixture,
          response,
          body: null,
          journal,
          defaults,
          testId: "default",
          errorWire: "openai",
        }).then(() => {
          headersSent = res.headersSent;
        });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      const port = (server.address() as AddressInfo).port;
      await new Promise<void>((resolve) => {
        const req = http.request({ host: "127.0.0.1", port, method: "POST", agent: false });
        req.on("error", () => resolve());
        req.on("close", () => resolve());
        req.flushHeaders();
        setTimeout(() => req.destroy(), 50);
      });
      await expect.poll(() => journal.getAll().length, { timeout: 3000 }).toBe(1);
      await done;
      expect(headersSent).toBe(false);
      expect(journal.getAll()[0].response).toMatchObject({
        interrupted: true,
        interruptReason: "client aborted",
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("serveRawResponse: the non-streaming wait is sized from the served JSON", () => {
  it("a large JSON body waits longer than a small one", async () => {
    const opts: FixtureOpts = {
      streamingProfile: { ttft: 0, tps: 10 },
      nonStreamingTimingAllProviders: true,
    };
    const small = await start({ raw: { wire: "openai-responses", json: { a: 1 } } }, opts);
    const smallReply = await post(small.url, false);
    await small.stop();
    mock = undefined;
    const large = await start(
      { raw: { wire: "openai-responses", json: { text: "x".repeat(200) } } },
      opts,
    );
    const largeReply = await post(large.url, false);
    expect(smallReply.status).toBe(200);
    expect(largeReply.status).toBe(200);
    // 9 bytes: one chunk, no gap. 213 bytes at chunkSize 20: 11 chunks, 10 gaps of 100ms.
    expect(smallReply.ms).toBeLessThan(400);
    expect(largeReply.ms).toBeGreaterThanOrEqual(800);
  });
});

describe("serveRawResponse: invalid fixture logging", () => {
  it("an invalid raw fixture's 500 is logged at error level", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const server = await start(
        () => forbidden,
        undefined,
        new PlainLLMock({ port: 0, host: "127.0.0.1", logLevel: "warn" }),
      );
      const got = await post(server.url, false);
      expect(got.status).toBe(500);
      const lines = spy.mock.calls.map((args) => args.map(String).join(" "));
      expect(lines).toContainEqual(
        expect.stringMatching(
          /^\[aimock\] POST \/v1\/responses: invalid raw fixture: .*content-length/,
        ),
      );
    } finally {
      spy.mockRestore();
    }
  });
});

describe("serveRawResponse: an error status with json answers a streaming request with JSON", () => {
  const openAIError = {
    error: { message: "slow down", type: "rate_limit_error", param: null, code: "rate_limited" },
  };
  const anthropicError = {
    type: "error",
    error: { type: "rate_limit_error", message: "slow down" },
  };

  async function serveOn(response: FixtureFileResponse, opts?: FixtureOpts): Promise<PlainLLMock> {
    return start(response, opts);
  }

  it("openai-chat: the SDK throws a typed RateLimitError on stream:true", async () => {
    const server = await serveOn(
      { raw: { wire: "openai-chat", json: openAIError, status: 429 } },
      { streamingProfile: { ttft: 1500 } },
    );
    const client = new OpenAI({ apiKey: "k", baseURL: `${server.url}/v1`, maxRetries: 0 });
    const started = Date.now();
    const err = await client.chat.completions
      .create({ model: "gpt-4.1", stream: true, messages: [{ role: "user", content: "serve" }] })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(OpenAI.RateLimitError);
    expect(err instanceof OpenAI.RateLimitError && err.error).toMatchObject({
      message: "slow down",
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(server.getRequests()[0].response.status).toBe(429);
  });

  it("openai-responses: json wins over events for an error status on stream:true", async () => {
    const server = await serveOn({
      raw: {
        wire: "openai-responses",
        json: openAIError,
        events,
        status: 429,
        headers: { "x-r": "1" },
      },
    });
    const client = new OpenAI({ apiKey: "k", baseURL: `${server.url}/v1`, maxRetries: 0 });
    const err = await client.responses
      .create({ model: "gpt-4.1", input: "serve", stream: true })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(OpenAI.RateLimitError);
    const got = await post(server.url, true);
    expect(got.status).toBe(429);
    expect(got.headers["content-type"]).toBe("application/json");
    expect(got.headers["x-r"]).toBe("1");
    expect(JSON.parse(got.body)).toEqual(openAIError);
  });

  it("anthropic: the SDK throws a typed RateLimitError on stream:true", async () => {
    const server = await serveOn({
      raw: { wire: "anthropic", json: anthropicError, status: 429 },
    });
    const client = new Anthropic({ apiKey: "k", baseURL: server.url, maxRetries: 0 });
    const err = await client.messages
      .create({
        model: "claude-sonnet-4-5",
        max_tokens: 16,
        stream: true,
        messages: [{ role: "user", content: "serve" }],
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(Anthropic.RateLimitError);
  });

  it("a 2xx json-only fixture on a streaming request keeps the mode-mismatch 500", async () => {
    const server = await serveOn({ raw: { wire: "openai-responses", json } });
    const got = await post(server.url, true);
    expect(got.status).toBe(500);
    expect(JSON.parse(got.body)).toMatchObject({ error: { code: "aimock_raw_mode_unavailable" } });
  });
});
