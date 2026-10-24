import * as http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { LLMock as PlainLLMock } from "../llmock.js";
import { LLMock } from "./helpers/misbehavior-enabled.js";
import type { FixtureFileResponse, FixtureOpts, MockServerOptions, RawWireId } from "../types.js";

// Raw passthrough fixtures (#549) combined with the features every typed
// fixture already has: stream interruption, client hang-ups, streaming and
// non-streaming timing, chaos, misbehavior, strict mode and sequence/turn
// matching. Raw goes through the shared delivery layer, so each case expects
// what a typed fixture gets on the same wire.

const MODEL = "anthropic.claude-3-5-sonnet-20241022-v2:0";

type Framing = "sse" | "ndjson" | "eventstream";

interface StreamSite {
  wire: RawWireId;
  framing: Framing;
  path: string;
  body: (text: string) => unknown;
  /** Five authored events: `truncateAfterChunks: 2` stops before the end. */
  events: Record<string, unknown>[];
}

/** One streaming site per framing family, plus both OpenAI wires. */
const STREAM_SITES: StreamSite[] = [
  {
    wire: "openai-responses",
    framing: "sse",
    path: "/v1/responses",
    body: (text) => ({ model: "gpt-4.1", input: text, stream: true }),
    events: [
      { type: "response.created", response: { id: "resp_f" } },
      { type: "response.output_text.delta", delta: "a" },
      { type: "response.output_text.delta", delta: "b" },
      { type: "response.output_text.delta", delta: "c" },
      { type: "response.completed", response: { id: "resp_f" } },
    ],
  },
  {
    wire: "openai-chat",
    framing: "sse",
    path: "/v1/chat/completions",
    body: (text) => ({
      model: "gpt-4.1",
      stream: true,
      messages: [{ role: "user", content: text }],
    }),
    events: ["a", "b", "c", "d", "e"].map((content) => ({
      id: "chatcmpl_f",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    })),
  },
  {
    wire: "ollama",
    framing: "ndjson",
    path: "/api/chat",
    body: (text) => ({ model: "llama3.1", messages: [{ role: "user", content: text }] }),
    events: ["a", "b", "c", "d", ""].map((content, i) => ({
      model: "llama3.1",
      message: { role: "assistant", content },
      done: i === 4,
    })),
  },
  {
    wire: "bedrock-converse",
    framing: "eventstream",
    path: `/model/${MODEL}/converse-stream`,
    body: (text) => ({ messages: [{ role: "user", content: [{ text }] }] }),
    events: [
      { messageStart: { role: "assistant" } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "a" } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "b" } } },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { messageStop: { stopReason: "end_turn" } },
    ],
  },
];

interface JsonSite {
  wire: RawWireId;
  path: string;
  body: (text: string) => unknown;
}

/** One non-streaming request per wire (all 9). */
const JSON_SITES: JsonSite[] = [
  {
    wire: "openai-responses",
    path: "/v1/responses",
    body: (text) => ({ model: "gpt-4.1", input: text, stream: false }),
  },
  {
    wire: "openai-chat",
    path: "/v1/chat/completions",
    body: (text) => ({ model: "gpt-4.1", messages: [{ role: "user", content: text }] }),
  },
  {
    wire: "anthropic",
    path: "/v1/messages",
    body: (text) => ({
      model: "claude-sonnet-4-5",
      max_tokens: 64,
      messages: [{ role: "user", content: text }],
    }),
  },
  {
    wire: "gemini",
    path: "/v1beta/models/gemini-2.5-flash:generateContent",
    body: (text) => ({ contents: [{ role: "user", parts: [{ text }] }] }),
  },
  {
    wire: "gemini-interactions",
    path: "/v1beta/interactions",
    body: (text) => ({ model: "gemini-2.5-flash", input: text, stream: false }),
  },
  {
    wire: "cohere",
    path: "/v2/chat",
    body: (text) => ({ model: "command-r-plus", messages: [{ role: "user", content: text }] }),
  },
  {
    wire: "ollama",
    path: "/api/chat",
    body: (text) => ({
      model: "llama3.1",
      messages: [{ role: "user", content: text }],
      stream: false,
    }),
  },
  {
    wire: "bedrock-invoke",
    path: `/model/${MODEL}/invoke`,
    body: (text) => ({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 64,
      messages: [{ role: "user", content: text }],
    }),
  },
  {
    wire: "bedrock-converse",
    path: `/model/${MODEL}/converse`,
    body: (text) => ({ messages: [{ role: "user", content: [{ text }] }] }),
  },
];

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  bytes: Buffer;
  /** Milliseconds from the request to the first body byte (or the end). */
  firstByteMs: number;
  ms: number;
  /** Whether the body ended cleanly (false: the socket was torn down). */
  ended: boolean;
  error?: string;
}

interface SendOptions {
  headers?: Record<string, string>;
  /** Destroy the request once the first body byte arrives. */
  hangUpAfterFirstByte?: boolean;
  /** Destroy the request this many ms after sending it. */
  hangUpAfterMs?: number;
}

/** A raw HTTP request that never rejects, so torn sockets can be inspected. */
function send(url: string, path: string, body: unknown, opts: SendOptions = {}): Promise<Reply> {
  const started = Date.now();
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let status = 0;
    let headers: http.IncomingHttpHeaders = {};
    let firstByteMs: number | undefined;
    let settled = false;
    const done = (ended: boolean, error?: string): void => {
      if (settled) return;
      settled = true;
      const ms = Date.now() - started;
      resolve({
        status,
        headers,
        bytes: Buffer.concat(chunks),
        firstByteMs: firstByteMs ?? ms,
        ms,
        ended,
        error,
      });
    };
    const req = http.request(
      `${url}${path}`,
      { method: "POST", headers: { "content-type": "application/json", ...opts.headers } },
      (res) => {
        status = res.statusCode ?? 0;
        headers = res.headers;
        res.on("data", (chunk: Buffer) => {
          firstByteMs ??= Date.now() - started;
          chunks.push(chunk);
          if (opts.hangUpAfterFirstByte) {
            req.destroy();
            done(false, "hung up");
          }
        });
        res.on("end", () => done(true));
        res.on("aborted", () => done(false, "aborted"));
        res.on("error", (err) => done(false, err.message));
        res.on("close", () => done(res.complete));
      },
    );
    req.on("error", (err) => done(false, err.message));
    if (opts.hangUpAfterMs !== undefined) {
      setTimeout(() => {
        req.destroy();
        done(false, "hung up");
      }, opts.hangUpAfterMs);
    }
    req.end(JSON.stringify(body));
  });
}

/** The authored frames in a streamed body, without the chat `[DONE]` terminal. */
function frames(framing: Framing, bytes: Buffer): string[] {
  if (framing === "eventstream") {
    const out: string[] = [];
    for (let offset = 0; offset + 12 <= bytes.length; ) {
      const length = bytes.readUInt32BE(offset);
      if (offset + length > bytes.length) break;
      const headerLength = bytes.readUInt32BE(offset + 4);
      out.push(bytes.subarray(offset + 12 + headerLength, offset + length - 4).toString("utf8"));
      offset += length;
    }
    return out;
  }
  const text = bytes.toString("utf8");
  if (framing === "ndjson") return text.split("\n").filter((line) => line.length > 0);
  return text
    .split("\n\n")
    .filter((frame) => frame.length > 0 && frame !== "data: [DONE]" && frame.endsWith("}"));
}

let servers: PlainLLMock[] = [];

afterEach(async () => {
  await Promise.all(servers.map((s) => s.stop()));
  servers = [];
});

async function start(options: MockServerOptions = {}, misbehavior = false): Promise<PlainLLMock> {
  const merged = { port: 0, host: "127.0.0.1", logLevel: "silent" as const, ...options };
  const server = misbehavior ? new LLMock(merged) : new PlainLLMock(merged);
  servers.push(server);
  return server;
}

/** A server with one raw fixture on `text`, started. */
async function serve(
  text: string,
  response: FixtureFileResponse,
  opts?: FixtureOpts,
  options?: MockServerOptions,
): Promise<PlainLLMock> {
  const server = await start(options);
  server.on({ userMessage: text }, response, opts);
  await server.start();
  return server;
}

/** The first journal entry once it is marked interrupted. */
async function interruptedEntry(server: PlainLLMock) {
  await expect
    .poll(() => server.getRequests()[0]?.response.interrupted, { timeout: 3000 })
    .toBe(true);
  return server.getRequests()[0];
}

// ─── Stream interruption, hang-ups and streaming timing ─────────────────────

describe.each(STREAM_SITES)("raw stream features: $wire", (site) => {
  const raw = (): FixtureFileResponse => ({ raw: { wire: site.wire, events: site.events } });

  it("streams all five authored frames by default (baseline)", async () => {
    const server = await serve("f", raw());
    const got = await send(server.url, site.path, site.body("f"));
    expect(got.status).toBe(200);
    expect(got.ended).toBe(true);
    expect(frames(site.framing, got.bytes)).toHaveLength(5);
  });

  it("truncateAfterChunks: 2 stops after the second frame and tears the stream down", async () => {
    const server = await serve("f", raw(), { latency: 10, truncateAfterChunks: 2 });
    const got = await send(server.url, site.path, site.body("f"));
    expect(got.status).toBe(200);
    expect(got.ended).toBe(false);
    // The socket is destroyed right after the second frame is written, so that
    // frame may or may not arrive; nothing after it ever does.
    const received = frames(site.framing, got.bytes);
    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received.length).toBeLessThanOrEqual(2);
    expect(got.bytes.toString("utf8")).not.toContain("[DONE]");
    const entry = await interruptedEntry(server);
    expect(entry.response.interruptReason).toBe("truncateAfterChunks");
    expect(entry.response.status).toBe(200);
  });

  it("disconnectAfterMs tears a slow stream down before it ends", async () => {
    const server = await serve("f", raw(), {
      streamingProfile: { ttft: 0, tps: 5 },
      disconnectAfterMs: 300,
    });
    const got = await send(server.url, site.path, site.body("f"));
    expect(got.status).toBe(200);
    expect(got.ended).toBe(false);
    expect(frames(site.framing, got.bytes).length).toBeLessThan(5);
    const entry = await interruptedEntry(server);
    expect(entry.response.interruptReason).toBe("disconnectAfterMs");
    expect(entry.response.status).toBe(200);
  });

  it("a client hang-up mid-stream is journaled as client aborted, as for a typed fixture", async () => {
    const opts: FixtureOpts = { streamingProfile: { ttft: 0, tps: 2 } };
    const server = await serve("f", raw(), opts);
    server.on({ userMessage: "typed" }, { content: "a b c d e f g h" }, opts);
    const got = await send(server.url, site.path, site.body("f"), { hangUpAfterFirstByte: true });
    expect(got.status).toBe(200);
    const entry = await interruptedEntry(server);
    expect(entry.response.interruptReason).toBe("client aborted");
    expect(entry.response.status).toBe(200);

    // Parity: the same hang-up on a typed fixture on the same wire.
    await send(server.url, site.path, site.body("typed"), { hangUpAfterFirstByte: true });
    await expect
      .poll(() => server.getRequests()[1]?.response.interrupted, { timeout: 3000 })
      .toBe(true);
    const typed = server.getRequests()[1].response;
    expect({
      status: entry.response.status,
      interrupted: entry.response.interrupted,
      interruptReason: entry.response.interruptReason,
    }).toEqual({
      status: typed.status,
      interrupted: typed.interrupted,
      interruptReason: typed.interruptReason,
    });
  });

  it("streamingProfile.ttft delays the first frame", async () => {
    const server = await serve("f", raw(), { streamingProfile: { ttft: 600, tps: 1000 } });
    const got = await send(server.url, site.path, site.body("f"));
    expect(got.status).toBe(200);
    expect(got.firstByteMs).toBeGreaterThanOrEqual(500);
    expect(frames(site.framing, got.bytes)).toHaveLength(5);
  });

  it("recordedTimings gaps space the frames", async () => {
    const server = await serve("f", raw(), {
      recordedTimings: {
        ttftMs: 0,
        interChunkDelaysMs: [150, 150, 150, 150],
        totalDurationMs: 600,
      },
    });
    const got = await send(server.url, site.path, site.body("f"));
    expect(got.status).toBe(200);
    expect(got.ms).toBeGreaterThanOrEqual(500);
    expect(frames(site.framing, got.bytes)).toHaveLength(5);
  });

  it("chaos drop answers 500 and journals the matched raw fixture", async () => {
    const server = await serve("f", raw(), { chaos: { dropRate: 1 } });
    const got = await send(server.url, site.path, site.body("f"));
    expect(got.status).toBe(500);
    expect(got.bytes.toString("utf8")).toContain("chaos_drop");
    const [entry] = server.getRequests();
    expect(entry.response.chaosAction).toBe("drop");
    expect(entry.response.fixture).toBe(server.getFixtures()[0]);
  });

  it("chaos malformed answers unparseable JSON instead of the raw frames", async () => {
    const server = await serve("f", raw(), { chaos: { malformedRate: 1 } });
    const got = await send(server.url, site.path, site.body("f"));
    expect(got.status).toBe(200);
    expect(() => JSON.parse(got.bytes.toString("utf8"))).toThrow();
    expect(got.headers["content-type"]).not.toMatch(/event-stream|ndjson|eventstream/);
    expect(server.getRequests()[0].response.chaosAction).toBe("malformed");
  });

  it("chaos disconnect tears the socket down with status 0", async () => {
    const server = await serve("f", raw(), { chaos: { disconnectRate: 1 } });
    const got = await send(server.url, site.path, site.body("f"));
    expect(got.ended).toBe(false);
    expect(got.bytes.length).toBe(0);
    const [entry] = server.getRequests();
    expect(entry.response.chaosAction).toBe("disconnect");
    expect(entry.response.status).toBe(0);
  });
});

// ─── Misbehavior, strict mode, sequence and turn matching ───────────────────

describe.each(STREAM_SITES)("raw fixture matching features: $wire", (site) => {
  const raw = (events = site.events): FixtureFileResponse => ({
    raw: { wire: site.wire, events },
  });

  it("an explicit misbehavior header is not applicable: 501", async () => {
    const server = await start({}, true);
    server.on({ userMessage: "f" }, raw());
    await server.start();
    const got = await send(server.url, site.path, site.body("f"), {
      headers: { "x-aimock-misbehavior": "empty-response" },
    });
    expect(got.status).toBe(501);
    expect(got.bytes.toString("utf8")).toContain("aimock_misbehavior_not_applicable");
    expect(got.headers["content-type"]).not.toMatch(/event-stream|ndjson|eventstream/);
    expect(server.getRequests()[0].response.misbehavior).toMatchObject({
      applied: false,
      source: "header",
      evaluations: [{ fault: "empty-response", outcome: "error", reason: "not-applicable" }],
    });
  });

  it("a server-level fault is skipped: the raw stream is served and the skip journaled", async () => {
    const server = await start(
      { misbehavior: { faults: [{ fault: "empty-response", rate: 1 }] } },
      true,
    );
    server.on({ userMessage: "f" }, raw());
    await server.start();
    const got = await send(server.url, site.path, site.body("f"));
    expect(got.status).toBe(200);
    expect(frames(site.framing, got.bytes)).toHaveLength(5);
    expect(server.getRequests()[0].response.misbehavior).toMatchObject({
      applied: false,
      source: "server",
      wire: site.wire,
      evaluations: [{ fault: "empty-response", outcome: "skipped", reason: "not-applicable" }],
    });
  });

  it("strict mode serves a matched raw fixture and answers a miss with 503", async () => {
    const server = await serve("f", raw(), undefined, { strict: true });
    const hit = await send(server.url, site.path, site.body("f"));
    expect(hit.status).toBe(200);
    expect(frames(site.framing, hit.bytes)).toHaveLength(5);
    const miss = await send(server.url, site.path, site.body("nothing matches this"));
    expect(miss.status).toBe(503);
  });

  it("sequenceIndex picks the raw fixture for each call in turn", async () => {
    const server = await start();
    server.on({ userMessage: "f", sequenceIndex: 0 }, raw(site.events.slice(0, 2)));
    server.on({ userMessage: "f", sequenceIndex: 1 }, raw(site.events.slice(0, 3)));
    await server.start();
    const first = await send(server.url, site.path, site.body("f"));
    const second = await send(server.url, site.path, site.body("f"));
    expect(frames(site.framing, first.bytes)).toHaveLength(2);
    expect(frames(site.framing, second.bytes)).toHaveLength(3);
  });
});

describe("raw fixture matching features: turnIndex (openai-chat)", () => {
  const site = STREAM_SITES[1];
  it("turnIndex picks the raw fixture for the conversation turn", async () => {
    const server = await start();
    server.on(
      { userMessage: "f", turnIndex: 0 },
      { raw: { wire: site.wire, events: site.events.slice(0, 2) } },
    );
    server.on(
      { userMessage: "f", turnIndex: 1 },
      { raw: { wire: site.wire, events: site.events.slice(0, 3) } },
    );
    await server.start();
    const first = await send(server.url, site.path, site.body("f"));
    const second = await send(server.url, site.path, {
      model: "gpt-4.1",
      stream: true,
      messages: [
        { role: "user", content: "f" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "f" },
      ],
    });
    expect(frames("sse", first.bytes)).toHaveLength(2);
    expect(frames("sse", second.bytes)).toHaveLength(3);
  });
});

// ─── Non-streaming timing matrix (every wire) ───────────────────────────────

const TTFT = 2000;

interface Case {
  name: string;
  opts: FixtureOpts;
  /** Whether the reply waits on `openai-chat` and on every other wire. */
  waits: { chat: boolean; other: boolean };
}

const PROFILE: FixtureOpts = { streamingProfile: { ttft: TTFT } };

const CASES: Case[] = [
  { name: "neither flag", opts: PROFILE, waits: { chat: false, other: false } },
  {
    name: "nonStreamingTiming only",
    opts: { ...PROFILE, nonStreamingTiming: true },
    waits: { chat: true, other: false },
  },
  {
    name: "nonStreamingTimingAllProviders only",
    opts: { ...PROFILE, nonStreamingTimingAllProviders: true },
    waits: { chat: true, other: true },
  },
  {
    name: "both flags",
    opts: { ...PROFILE, nonStreamingTiming: true, nonStreamingTimingAllProviders: true },
    waits: { chat: true, other: true },
  },
  {
    name: "bare latency with both flags",
    opts: { latency: TTFT, nonStreamingTiming: true, nonStreamingTimingAllProviders: true },
    waits: { chat: false, other: false },
  },
  {
    name: "recordedTimings (no profile) with nonStreamingTimingAllProviders",
    opts: {
      recordedTimings: { ttftMs: TTFT, interChunkDelaysMs: [], totalDurationMs: TTFT },
      nonStreamingTimingAllProviders: true,
    },
    waits: { chat: true, other: true },
  },
];

describe.each(JSON_SITES)("raw non-streaming timing: $wire", (site) => {
  const json = { served: site.wire };
  const chat = site.wire === "openai-chat";

  it("applies the typed timing rule for each flag combination", async () => {
    const server = await start();
    CASES.forEach((c, i) =>
      server.on({ userMessage: `case-${i}` }, { raw: { wire: site.wire, json } }, c.opts),
    );
    await server.start();
    const replies = await Promise.all(
      CASES.map((_, i) => send(server.url, site.path, site.body(`case-${i}`))),
    );
    const observed = CASES.map((c, i) => ({
      name: c.name,
      status: replies[i].status,
      body: replies[i].bytes.toString("utf8"),
      waited: replies[i].ms >= TTFT - 500,
      fast: replies[i].ms < 1000,
    }));
    const expected = CASES.map((c) => {
      const waits = chat ? c.waits.chat : c.waits.other;
      return {
        name: c.name,
        status: 200,
        body: JSON.stringify(json),
        waited: waits,
        fast: !waits,
      };
    });
    expect(observed).toEqual(expected);
    // Both flags together wait once, not twice.
    const both = replies[CASES.findIndex((c) => c.name === "both flags")];
    expect(both.ms).toBeLessThan(TTFT + 1000);
  }, 15000);

  it("a tps profile sizes the wait by the payload: a bigger payload waits longer", async () => {
    // Relative only: the exact payload sizing is not pinned here. The wait is
    // sized from the served JSON, so the two fixtures differ only in the
    // length of their json (neither has events): about 1 chunk against 20+.
    const opts: FixtureOpts = {
      streamingProfile: { tps: 20 },
      nonStreamingTimingAllProviders: true,
    };
    const small = { raw: { wire: site.wire, json: { s: 1 } } };
    const big = {
      raw: {
        wire: site.wire,
        json: { served: site.wire, text: "a bigger payload than the small one ".repeat(12) },
      },
    };
    const server = await start();
    server.on({ userMessage: "small" }, small, opts);
    server.on({ userMessage: "big" }, big, opts);
    await server.start();
    const [smallReply, bigReply] = await Promise.all([
      send(server.url, site.path, site.body("small")),
      send(server.url, site.path, site.body("big")),
    ]);
    expect([smallReply.status, bigReply.status]).toEqual([200, 200]);
    expect(JSON.parse(bigReply.bytes.toString("utf8"))).toEqual(big.raw.json);
    expect(bigReply.ms).toBeGreaterThan(smallReply.ms + 300);
  }, 15000);

  it("json with status 429 is never delayed, even with both flags", async () => {
    const server = await serve(
      "f",
      { raw: { wire: site.wire, json: { error: "slow down" }, status: 429 } },
      { ...PROFILE, nonStreamingTiming: true, nonStreamingTimingAllProviders: true },
    );
    const got = await send(server.url, site.path, site.body("f"));
    expect(got.status).toBe(429);
    expect(JSON.parse(got.bytes.toString("utf8"))).toEqual({ error: "slow down" });
    expect(got.ms).toBeLessThan(1000);
    expect(server.getRequests()[0].response.status).toBe(429);
  });

  it("a client hang-up during an opted-in wait writes nothing and is journaled as client aborted, as for a typed fixture", async () => {
    const opts: FixtureOpts = { ...PROFILE, nonStreamingTimingAllProviders: true };
    const server = await serve("f", { raw: { wire: site.wire, json } }, opts);
    server.on({ userMessage: "typed" }, { content: "typed reply" }, opts);
    const got = await send(server.url, site.path, site.body("f"), { hangUpAfterMs: 300 });
    expect(got.status).toBe(0);
    expect(got.bytes.length).toBe(0);
    const entry = await interruptedEntry(server);
    expect(entry.response.interruptReason).toBe("client aborted");

    await send(server.url, site.path, site.body("typed"), { hangUpAfterMs: 300 });
    await expect
      .poll(() => server.getRequests()[1]?.response.interrupted, { timeout: 3000 })
      .toBe(true);
    const typed = server.getRequests()[1].response;
    expect({
      status: entry.response.status,
      interrupted: entry.response.interrupted,
      interruptReason: entry.response.interruptReason,
    }).toEqual({
      status: typed.status,
      interrupted: typed.interrupted,
      interruptReason: typed.interruptReason,
    });
  }, 10000);
});
