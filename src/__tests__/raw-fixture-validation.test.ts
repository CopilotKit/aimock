import { afterEach, describe, expect, it } from "vitest";
import {
  enableHeldFixtureMisbehavior,
  entryToFixture,
  validateFixtures,
} from "../fixture-loader.js";
import { LLMock } from "../llmock.js";
import { checkRawResponse } from "../raw-validation.js";
import type { FixtureFileEntry, RawResponse, ResponseFactory } from "../types.js";

// Load-time checks for raw passthrough fixtures (#549 T4).

const WIRES =
  "openai-responses, openai-chat, anthropic, gemini, gemini-interactions, cohere, ollama, ollama-generate, bedrock-invoke, bedrock-converse";

/** Loader findings for one file entry given as JSON (deliberately invalid shapes need no cast). */
function load(json: string) {
  const entry: FixtureFileEntry = JSON.parse(json);
  return validateFixtures([entryToFixture(entry)]).map((r) => [r.severity, r.message]);
}

function check(json: string) {
  return checkRawResponse(JSON.parse(json)).map((f) => [f.severity, f.message]);
}

describe("checkRawResponse", () => {
  it.each([
    ['{"wire":"openai-chat","json":{}}'],
    ['{"wire":"openai-chat","events":[{"choices":[]}],"done":false}'],
    ['{"wire":"openai-responses","events":[{"type":"response.created"}]}'],
    ['{"wire":"bedrock-converse","events":[{"messageStart":{"role":"assistant"}}]}'],
    ['{"wire":"ollama","events":[{"done":true}],"json":{},"status":429}'],
    ['{"wire":"ollama-generate","json":{"response":"x","done":true}}'],
    [
      '{"wire":"gemini","json":{},"headers":{"x-request-id":"r1","Content-Type":"application/json"}}',
    ],
  ])("accepts %s", (raw) => {
    expect(check(raw)).toEqual([]);
  });

  it.each([
    ['"x"', "raw must be an object"],
    ["[]", "raw must be an object"],
    [
      '{"wire":"openai-realtime","json":{}}',
      `raw.wire must be one of ${WIRES}; got "openai-realtime"`,
    ],
    ['{"json":{}}', `raw.wire must be one of ${WIRES}; got undefined`],
    ['{"wire":"openai-chat"}', 'raw needs "events" (streaming), "json" (non-streaming), or both'],
    ['{"wire":"openai-chat","events":{}}', "raw.events must be an array"],
    ['{"wire":"openai-chat","events":[1]}', "raw.events[0] must be a JSON object"],
    ['{"wire":"gemini","events":[{},[]]}', "raw.events[1] must be a JSON object"],
    [
      '{"wire":"openai-chat","json":{},"status":99}',
      "raw.status must be an integer from 200 to 599; got 99",
    ],
    [
      '{"wire":"openai-chat","json":{},"status":600}',
      "raw.status must be an integer from 200 to 599; got 600",
    ],
    [
      '{"wire":"openai-chat","json":{},"status":200.5}',
      "raw.status must be an integer from 200 to 599; got 200.5",
    ],
    [
      '{"wire":"openai-chat","json":{},"status":"200"}',
      'raw.status must be an integer from 200 to 599; got "200"',
    ],
    [
      '{"wire":"openai-chat","json":{},"headers":[]}',
      "raw.headers must be an object of string values",
    ],
    ['{"wire":"openai-chat","json":{},"headers":{"x-a":1}}', 'raw.headers["x-a"] must be a string'],
    [
      '{"wire":"openai-chat","json":{},"headers":{"bad name":"v"}}',
      'raw.headers["bad name"] is not a valid header name',
    ],
    [
      '{"wire":"openai-chat","json":{},"headers":{"x-a":"line\\nbreak"}}',
      'raw.headers["x-a"] has an invalid header value',
    ],
    ...["content-length", "Transfer-Encoding", "CONNECTION", "content-encoding"].map((name) => [
      `{"wire":"openai-chat","json":{},"headers":{"${name}":"5"}}`,
      `raw.headers["${name}"] is not allowed: aimock frames the body and sets this header itself`,
    ]),
    [
      '{"wire":"cohere","json":{},"done":true}',
      "raw.done applies only to openai-chat (the only wire with a [DONE] terminal), not cohere",
    ],
    [
      '{"wire":"openai-responses","events":[{"delta":"x"}]}',
      'raw.events[0] needs a string "type" on openai-responses',
    ],
    [
      '{"wire":"anthropic","events":[{"type":1}]}',
      'raw.events[0] needs a string "type" on anthropic',
    ],
    [
      '{"wire":"cohere","events":[{"type":"message-start"},{}]}',
      'raw.events[1] needs a string "type" on cohere',
    ],
    [
      '{"wire":"bedrock-converse","events":[{"a":{},"b":{}}]}',
      "raw.events[0] must have exactly one top-level key (the event type) on bedrock-converse",
    ],
    [
      '{"wire":"bedrock-converse","events":[{}]}',
      "raw.events[0] must have exactly one top-level key (the event type) on bedrock-converse",
    ],
    [
      '{"wire":"bedrock-converse","events":[{"messageStop":"end_turn"}]}',
      "raw.events[0].messageStop must be a JSON object (the frame payload) on bedrock-converse",
    ],
  ])("rejects %s", (raw, message) => {
    expect(check(raw)).toEqual([["error", message]]);
  });

  it("warns on empty events", () => {
    expect(check('{"wire":"openai-chat","events":[]}')).toEqual([
      ["warning", "raw.events is empty; a streaming request gets no frames"],
    ]);
  });

  it("does not need a type on data-only wires", () => {
    expect(check('{"wire":"openai-chat","events":[{}]}')).toEqual([]);
    expect(check('{"wire":"gemini-interactions","events":[{"event_type":"x"}]}')).toEqual([]);
  });
});

describe("validateFixtures with raw fixtures", () => {
  it("accepts a valid raw fixture with no findings", () => {
    expect(
      load('{"match":{"userMessage":"x"},"response":{"raw":{"wire":"openai-chat","json":{}}}}'),
    ).toEqual([]);
  });

  it("reports the checker's findings for an invalid raw fixture", () => {
    expect(
      load(
        '{"match":{"userMessage":"x"},"response":{"raw":{"wire":"openai-chat","json":{},"headers":{"content-length":"5"}}}}',
      ),
    ).toEqual([
      [
        "error",
        'raw.headers["content-length"] is not allowed: aimock frames the body and sets this header itself',
      ],
    ]);
  });

  it.each([
    ['"chunkSize":3', "chunkSize is ignored for raw fixtures: each event is one frame"],
    ['"openRouterProcessing":true', "openRouterProcessing is ignored for raw fixtures"],
  ])("warns when a raw fixture sets %s", (field, message) => {
    expect(
      load(
        `{"match":{"userMessage":"x"},"response":{"raw":{"wire":"openai-chat","json":{}}},${field}}`,
      ),
    ).toEqual([["warning", message]]);
  });

  it("names raw in the unrecognized-type message", () => {
    expect(load('{"match":{"userMessage":"x"},"response":{"nothing":1}}')).toEqual([
      [
        "error",
        "response is not a recognized type (must have content, toolCalls, error, embedding, image, audio, transcription, video, json, live, or raw)",
      ],
    ]);
  });

  it("gives a typed fixture with a stray raw key no new finding", () => {
    expect(
      load(
        '{"match":{"userMessage":"x"},"response":{"content":"hi","raw":{"wire":"nope","headers":{"content-length":"1"}}},"chunkSize":3}',
      ),
    ).toEqual([]);
  });
});

// ─── Round-1 validation gaps: each checked at load and at serve time ────────

const RAW_INVALID = "aimock_raw_fixture_invalid";

let servers: LLMock[] = [];

afterEach(async () => {
  await Promise.all(servers.map((s) => s.stop()));
  servers = [];
});

async function server(misbehavior = false): Promise<LLMock> {
  const s = new LLMock({
    port: 0,
    host: "127.0.0.1",
    logLevel: "silent",
    ...(misbehavior ? { enableMisbehavior: true } : {}),
  });
  servers.push(s);
  return s;
}

const CHAT_PATH = "/v1/chat/completions";
const MESSAGES_PATH = "/v1/messages";

function chatBody(text: string, stream: boolean) {
  return { model: "m", stream, messages: [{ role: "user", content: text }] };
}

function messagesBody(text: string) {
  return { model: "m", max_tokens: 10, stream: true, messages: [{ role: "user", content: text }] };
}

async function post(url: string, path: string, body: unknown) {
  const res = await fetch(url + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

/** Load one file entry (JSON) and return its findings. */
function loadEntry(json: string) {
  return validateFixtures([entryToFixture(JSON.parse(json))]).map((r) => [r.severity, r.message]);
}

describe("raw.done must be a boolean (round-1 #1)", () => {
  const raw = '{"wire":"openai-chat","events":[{"x":1}],"done":"false"}';
  const message = 'raw.done must be a boolean; got "false"';

  it("is an error from the checker and the loader", () => {
    expect(check(raw)).toEqual([["error", message]]);
    expect(loadEntry(`{"match":{"userMessage":"x"},"response":{"raw":${raw}}}`)).toEqual([
      ["error", message],
    ]);
  });

  it("answers the coded 500 at serve time, with no [DONE]", async () => {
    const s = await server();
    s.on({ userMessage: "x" }, JSON.parse(`{"raw":${raw}}`));
    await s.start();
    const got = await post(s.url, CHAT_PATH, chatBody("x", true));
    expect(got.status).toBe(500);
    expect(got.text).toContain(RAW_INVALID);
    expect(got.text).toContain(message.replace(/"/g, '\\"'));
    expect(got.text).not.toContain("[DONE]");
  });
});

describe("an event type with a line break (round-1 #2)", () => {
  const raw = '{"wire":"anthropic","events":[{"type":"ping\\ndata: {\\"injected\\":true}"}]}';
  const message = "raw.events[0].type must not contain a line break (CR or LF) on anthropic";

  it.each([
    ["LF", '"a\\nb"'],
    ["CR", '"a\\rb"'],
  ])("is an error from the checker and the loader (%s)", (_, type) => {
    const r = `{"wire":"anthropic","events":[{"type":${type}}]}`;
    expect(check(r)).toEqual([["error", message]]);
    expect(loadEntry(`{"match":{"userMessage":"x"},"response":{"raw":${r}}}`)).toEqual([
      ["error", message],
    ]);
  });

  it("answers the coded 500 at serve time and writes no injected frame", async () => {
    const s = await server();
    s.on({ userMessage: "x" }, JSON.parse(`{"raw":${raw}}`));
    await s.start();
    const got = await post(s.url, MESSAGES_PATH, messagesBody("x"));
    expect(got.status).toBe(500);
    expect(got.text).toContain(RAW_INVALID);
    expect(got.text).not.toContain("event: ping");
  });
});

describe("status 204 or 304 with a body (round-1 #3)", () => {
  it.each([204, 304])("%i is an error from the checker and the loader", (status) => {
    const raw = `{"wire":"openai-chat","json":{"x":1},"status":${status}}`;
    const message = `raw.status ${status} cannot carry a body, so "events" and "json" would be dropped; use a status that allows a body`;
    expect(check(raw)).toEqual([["error", message]]);
    expect(loadEntry(`{"match":{"userMessage":"x"},"response":{"raw":${raw}}}`)).toEqual([
      ["error", message],
    ]);
  });

  it("answers the coded 500 at serve time instead of an empty 204", async () => {
    const s = await server();
    s.on(
      { userMessage: "x" },
      JSON.parse('{"raw":{"wire":"openai-chat","json":{"x":1},"status":204}}'),
    );
    await s.start();
    const got = await post(s.url, CHAT_PATH, chatBody("x", false));
    expect(got.status).toBe(500);
    expect(got.text).toContain(RAW_INVALID);
  });
});

describe("an unknown key inside raw (round-1 #4)", () => {
  const raw = '{"wire":"openai-chat","evnets":[{"x":1}],"json":{"x":1}}';
  const message =
    'raw["evnets"] is ignored: not a raw field (wire, events, json, status, headers, done)';

  it("is a warning from the checker and the loader", () => {
    expect(check(raw)).toEqual([["warning", message]]);
    expect(loadEntry(`{"match":{"userMessage":"x"},"response":{"raw":${raw}}}`)).toEqual([
      ["warning", message],
    ]);
  });

  it("still serves at serve time (a warning, not an error)", async () => {
    const s = await server();
    s.on({ userMessage: "x" }, JSON.parse(`{"raw":${raw}}`));
    await s.start();
    const got = await post(s.url, CHAT_PATH, chatBody("x", false));
    expect(got.status).toBe(200);
    expect(JSON.parse(got.text)).toEqual({ x: 1 });
  });
});

describe("raw combined with another response-type key (round-1 #5)", () => {
  it.each([
    ["responsesBlocks", '[{"type":"text","text":"t"}]'],
    ["customToolCalls", '[{"name":"t","input":"i"}]'],
  ])("{raw, %s} is a load error", (key, value) => {
    expect(
      loadEntry(
        `{"match":{"userMessage":"x"},"response":{"raw":{"wire":"openai-chat","json":{}},"${key}":${value}}}`,
      ),
    ).toEqual([
      ["error", `raw cannot be combined with "${key}": a raw fixture has no other response type`],
    ]);
  });

  it("answers the coded 500 at serve time for a fixture that skipped load validation", async () => {
    const s = await server();
    s.addFixture(
      entryToFixture(
        JSON.parse(
          '{"match":{"userMessage":"x"},"response":{"raw":{"wire":"openai-chat","json":{"x":1}},"customToolCalls":[{"name":"t","input":"i"}]}}',
        ),
      ),
    );
    await s.start();
    const got = await post(s.url, CHAT_PATH, chatBody("x", false));
    expect(got.status).toBe(500);
    expect(got.text).toContain(RAW_INVALID);
    expect(got.text).toContain("raw cannot be combined with");
  });
});

describe("a raw fixture with its own misbehavior (round-1 #6)", () => {
  const message = "misbehavior does not apply to raw fixtures";
  const entry =
    '{"match":{"userMessage":"x"},"response":{"raw":{"wire":"openai-chat","events":[{"x":1}]}},"misbehavior":"empty-response"}';

  it("is a load error from validateFixtures", () => {
    expect(loadEntry(entry)).toEqual([["error", message]]);
  });

  it("is a load error naming raw fixtures when misbehavior is enabled", () => {
    const fixture = entryToFixture(JSON.parse(entry));
    expect(() => enableHeldFixtureMisbehavior(fixture)).toThrow(message);
  });

  it("answers the coded 500, not a 501, for a factory raw fixture with misbehavior", async () => {
    const s = await server(true);
    const response: ResponseFactory = () => ({
      raw: { wire: "openai-chat", events: [{ x: 1 }] },
    });
    s.on({ userMessage: "x" }, response, { misbehavior: "empty-response" });
    await s.start();
    const got = await post(s.url, CHAT_PATH, chatBody("x", true));
    expect(got.status).toBe(500);
    expect(got.text).toContain(RAW_INVALID);
    expect(got.text).toContain(message);
  });

  it("answers the coded 500 for a static raw fixture with misbehavior", async () => {
    const s = await server();
    s.on(
      { userMessage: "x" },
      { raw: { wire: "openai-chat", events: [{ x: 1 }] } },
      { misbehavior: "empty-response" },
    );
    await s.start();
    const got = await post(s.url, CHAT_PATH, chatBody("x", true));
    expect(got.status).toBe(500);
    expect(got.text).toContain(RAW_INVALID);
    expect(got.text).toContain(message);
  });
});

// ─── Consumer-probe gaps: events must be plain JSON the encoders can frame ──

/** Findings for a code-built raw fixture (shapes JSON cannot express). */
function loadCode(raw: RawResponse["raw"]) {
  return validateFixtures([{ match: { userMessage: "x" }, response: { raw } }]).map((r) => [
    r.severity,
    r.message,
  ]);
}

/** A code-built raw fixture served on `path`: status and body text. */
async function serveCode(raw: RawResponse["raw"], path: string, body: unknown) {
  const s = await server();
  s.addFixture({ match: { userMessage: "x" }, response: { raw } });
  await s.start();
  return post(s.url, path, body);
}

describe("sparse or undefined events (probe #7)", () => {
  // eslint-disable-next-line no-sparse-arrays
  const sparse = [{ x: 1 }, , { x: 2 }] as unknown as Record<string, unknown>[];
  const withUndefined = [{ x: 1 }, undefined, { x: 2 }] as unknown as Record<string, unknown>[];

  it.each([
    ["a hole", sparse],
    ["an undefined entry", withUndefined],
  ])("%s is an error from the checker and the loader", (_, events) => {
    const raw: RawResponse["raw"] = { wire: "openai-chat", events };
    const expected = [["error", "raw.events[1] must be a JSON object"]];
    expect(checkRawResponse(raw).map((f) => [f.severity, f.message])).toEqual(expected);
    expect(loadCode(raw)).toEqual(expected);
  });

  it("a nested hole is an error", () => {
    // eslint-disable-next-line no-sparse-arrays
    const raw: RawResponse["raw"] = { wire: "openai-chat", events: [{ a: [1, , 3] }] };
    expect(loadCode(raw)).toEqual([
      ["error", 'raw.events[0]["a"][1] must not be a hole in a sparse array'],
    ]);
  });

  it("answers the coded 500 at serve time, with no data: undefined frame", async () => {
    const got = await serveCode(
      { wire: "openai-chat", events: sparse },
      CHAT_PATH,
      chatBody("x", true),
    );
    expect(got.status).toBe(500);
    expect(got.text).toContain(RAW_INVALID);
    expect(got.text).not.toContain("data: undefined");
  });
});

describe("non-plain event values (probe #8)", () => {
  it.each([
    [
      "a Date event",
      { wire: "ollama", events: [new Date(0) as unknown as Record<string, unknown>] },
      "raw.events[0] must be a JSON object",
    ],
    [
      "a Map event",
      { wire: "ollama", events: [new Map() as unknown as Record<string, unknown>] },
      "raw.events[0] must be a JSON object",
    ],
    [
      "a nested Date",
      { wire: "ollama", events: [{ at: new Date(0) }] },
      'raw.events[0]["at"] must be a plain JSON object',
    ],
    [
      "a nested function",
      { wire: "ollama", events: [{ f: () => 1 }] },
      'raw.events[0]["f"] must be a JSON value; got function',
    ],
    [
      "a NaN",
      { wire: "ollama", events: [{ n: Number.NaN }] },
      'raw.events[0]["n"] must be a finite number',
    ],
  ] satisfies [string, RawResponse["raw"], string][])(
    "%s is an error from the checker and the loader",
    (_, raw, message) => {
      expect(checkRawResponse(raw).map((f) => [f.severity, f.message])).toEqual([
        ["error", message],
      ]);
      expect(loadCode(raw)).toEqual([["error", message]]);
    },
  );

  it("a cyclic event is an error, not a crash", () => {
    const event: Record<string, unknown> = { a: 1 };
    event.self = event;
    expect(loadCode({ wire: "ollama", events: [event] })).toEqual([
      ["error", 'raw.events[0]["self"] must not contain itself'],
    ]);
  });

  it("answers the coded 500 at serve time instead of a bare-string Date frame", async () => {
    const got = await serveCode(
      { wire: "ollama", events: [new Date(0) as unknown as Record<string, unknown>] },
      "/api/chat",
      { model: "llama3.1", messages: [{ role: "user", content: "x" }] },
    );
    expect(got.status).toBe(500);
    expect(got.text).toContain(RAW_INVALID);
    expect(got.text).not.toContain("1970-01-01");
  });
});

describe("a bedrock-converse event type over the event-stream header limit (probe #9)", () => {
  const long = "k".repeat(65_536);
  const message =
    "raw.events[0] has an event type key over 65535 bytes, the event-stream header limit, on bedrock-converse";

  it("is an error from the checker and the loader; 65535 bytes is accepted", () => {
    const raw: RawResponse["raw"] = { wire: "bedrock-converse", events: [{ [long]: {} }] };
    expect(checkRawResponse(raw).map((f) => [f.severity, f.message])).toEqual([["error", message]]);
    expect(loadCode(raw)).toEqual([["error", message]]);
    expect(
      checkRawResponse({ wire: "bedrock-converse", events: [{ [long.slice(1)]: {} }] }),
    ).toEqual([]);
  });

  it("answers the coded 500 at serve time instead of a socket hang-up", async () => {
    const got = await serveCode(
      { wire: "bedrock-converse", events: [{ [long]: {} }] },
      "/model/anthropic.claude-3-haiku-20240307-v1:0/converse-stream",
      { messages: [{ role: "user", content: [{ text: "x" }] }] },
    );
    expect(got.status).toBe(500);
    expect(got.text).toContain(RAW_INVALID);
  });
});
