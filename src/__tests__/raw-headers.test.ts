import * as http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Journal } from "../journal.js";
import { LLMock } from "../llmock.js";
import { Logger } from "../logger.js";
import { serveRawResponse } from "../response/raw.js";
import type { HandlerDefaults, RawResponse, RawWireId } from "../types.js";

// Raw response headers (#549): an authored header replaces a default of the
// same name in any letter case (one header on the wire, never two), and a raw
// stream sends the same default headers as the typed stream on its wire.

const MODEL = "anthropic.claude-3-5-sonnet-20241022-v2:0";

/** A streaming request per wire whose user message is `text`. */
function streamRequest(wire: RawWireId, text: string): { path: string; body: unknown } {
  switch (wire) {
    case "openai-responses":
      return { path: "/v1/responses", body: { model: "gpt-4.1", input: text, stream: true } };
    case "openai-chat":
      return {
        path: "/v1/chat/completions",
        body: { model: "gpt-4.1", messages: [{ role: "user", content: text }], stream: true },
      };
    case "anthropic":
      return {
        path: "/v1/messages",
        body: {
          model: "claude-sonnet-4-5",
          max_tokens: 64,
          messages: [{ role: "user", content: text }],
          stream: true,
        },
      };
    case "gemini":
      return {
        path: "/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
        body: { contents: [{ role: "user", parts: [{ text }] }] },
      };
    case "gemini-interactions":
      return {
        path: "/v1beta/interactions",
        body: { model: "gemini-2.5-flash", input: text, stream: true },
      };
    case "cohere":
      return {
        path: "/v2/chat",
        body: {
          model: "command-r-plus",
          messages: [{ role: "user", content: text }],
          stream: true,
        },
      };
    case "ollama":
      return {
        path: "/api/chat",
        body: { model: "llama3.1", messages: [{ role: "user", content: text }], stream: true },
      };
    case "ollama-generate":
      return { path: "/api/generate", body: { model: "llama3.1", prompt: text, stream: true } };
    case "bedrock-invoke":
      return {
        path: `/model/${MODEL}/invoke-with-response-stream`,
        body: {
          anthropic_version: "bedrock-2023-05-31",
          max_tokens: 64,
          messages: [{ role: "user", content: text }],
        },
      };
    case "bedrock-converse":
      return {
        path: `/model/${MODEL}/converse-stream`,
        body: { messages: [{ role: "user", content: [{ text }] }] },
      };
  }
}

/** One valid raw event for each wire. */
function rawEvent(wire: RawWireId): Record<string, unknown> {
  return wire === "bedrock-converse" ? { messageStop: { stopReason: "end_turn" } } : { type: "x" };
}

const WIRES: RawWireId[] = [
  "openai-responses",
  "openai-chat",
  "anthropic",
  "gemini",
  "gemini-interactions",
  "cohere",
  "ollama",
  "ollama-generate",
  "bedrock-invoke",
  "bedrock-converse",
];

interface Reply {
  status: number;
  /** The header lines exactly as written, as [name, value] pairs. */
  rawHeaders: [string, string][];
}

function send(url: string, path: string, body: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${url}${path}`,
      { method: "POST", headers: { "content-type": "application/json" } },
      (res) => {
        res.resume();
        res.on("end", () => {
          const pairs: [string, string][] = [];
          for (let i = 0; i < res.rawHeaders.length; i += 2) {
            pairs.push([res.rawHeaders[i], res.rawHeaders[i + 1]]);
          }
          resolve({ status: res.statusCode ?? 0, rawHeaders: pairs });
        });
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

/** Headers whose value differs per response; only their presence is compared. */
const PER_RESPONSE = new Set(["date", "x-request-id"]);

/** Header lines, names lowercased, sorted: the comparable header set. */
function comparable(reply: Reply): string[] {
  return reply.rawHeaders
    .map(([name, value]) => {
      const lower = name.toLowerCase();
      return PER_RESPONSE.has(lower) ? `${lower}: *` : `${lower}: ${value}`;
    })
    .sort();
}

/** Every value sent under `name`, in any letter case. */
function valuesOf(reply: Reply, name: string): string[] {
  return reply.rawHeaders.filter(([n]) => n.toLowerCase() === name).map(([, v]) => v);
}

describe("raw streams send the typed stream's default headers", () => {
  let mock: LLMock;
  beforeAll(async () => {
    mock = new LLMock({ port: 0, host: "127.0.0.1", logLevel: "silent" });
    mock.on({ userMessage: "typed" }, { content: "Typed headers check." });
    for (const wire of WIRES) {
      mock.on({ userMessage: "raw" }, { raw: { wire, events: [rawEvent(wire)] } });
    }
    await mock.start();
  });
  afterAll(async () => {
    await mock.stop();
  });

  it.each(WIRES)("%s", async (wire) => {
    const typedReq = streamRequest(wire, "typed");
    const rawReq = streamRequest(wire, "raw");
    const typed = await send(mock.url, typedReq.path, typedReq.body);
    const raw = await send(mock.url, rawReq.path, rawReq.body);
    expect(typed.status).toBe(200);
    expect(raw.status).toBe(200);
    expect(comparable(raw)).toEqual(comparable(typed));
  });
});

describe("an authored header replaces the default in any letter case", () => {
  let mock: LLMock;
  const fixtures: Record<string, RawResponse["raw"]> = {
    "json 200": {
      wire: "openai-responses",
      json: { id: "r" },
      headers: { "content-type": "application/vnd.test+json" },
    },
    "json 4xx": {
      wire: "openai-responses",
      json: { error: "x" },
      status: 418,
      headers: { "content-type": "application/vnd.test+json" },
    },
    "stream, default status": {
      wire: "openai-responses",
      events: [{ type: "x" }],
      headers: { "content-type": "text/plain", "cache-control": "max-age=5" },
    },
    "stream, authored status": {
      wire: "openai-responses",
      events: [{ type: "x" }],
      status: 200,
      headers: { "content-type": "text/plain", "cache-control": "max-age=5" },
    },
  };

  beforeAll(async () => {
    mock = new LLMock({ port: 0, host: "127.0.0.1", logLevel: "silent" });
    for (const [name, raw] of Object.entries(fixtures)) {
      mock.on({ userMessage: name }, { raw });
    }
    await mock.start();
  });
  afterAll(async () => {
    await mock.stop();
  });

  it.each(["json 200", "json 4xx"])("%s: one content-type, the authored value", async (name) => {
    const reply = await send(mock.url, "/v1/responses", {
      model: "gpt-4.1",
      input: name,
      stream: false,
    });
    expect(reply.status).toBe(fixtures[name].status ?? 200);
    expect(valuesOf(reply, "content-type")).toEqual(["application/vnd.test+json"]);
  });

  it.each(["stream, default status", "stream, authored status"])(
    "%s: one content-type and one cache-control, the authored values",
    async (name) => {
      const reply = await send(mock.url, "/v1/responses", {
        model: "gpt-4.1",
        input: name,
        stream: true,
      });
      expect(reply.status).toBe(200);
      expect(valuesOf(reply, "content-type")).toEqual(["text/plain"]);
      expect(valuesOf(reply, "cache-control")).toEqual(["max-age=5"]);
      // The other stream defaults stay.
      expect(valuesOf(reply, "connection")).toEqual(["keep-alive"]);
    },
  );
});

// A server that sets no header before the raw serve (an exported handler on a
// bare http.Server): Node then writes `writeHead`s header object as given, so
// two spellings of one name would go out as two header lines.
describe("an authored header replaces the default on a bare server", () => {
  let server: http.Server;
  let url = "";
  const fixtures: Record<string, RawResponse["raw"]> = {
    "/json-200": {
      wire: "ollama",
      json: { done: true },
      headers: { "content-type": "application/vnd.test+json" },
    },
    "/json-4xx": {
      wire: "ollama",
      json: { error: "x" },
      status: 418,
      headers: { "content-type": "application/vnd.test+json" },
    },
    "/stream-status": {
      wire: "ollama",
      events: [{ done: true }],
      status: 200,
      headers: { "content-type": "text/plain", "cache-control": "max-age=5" },
    },
  };

  beforeAll(async () => {
    const defaults: HandlerDefaults = {
      latency: 0,
      chunkSize: 10,
      replaySpeed: 1,
      logger: new Logger("silent"),
    };
    const journal = new Journal();
    server = http.createServer((req, res) => {
      const raw = fixtures[req.url ?? ""];
      req.resume();
      void serveRawResponse({
        wire: "ollama",
        stream: raw.events !== undefined,
        req,
        res,
        fixture: { match: {}, response: { raw } },
        response: { raw },
        body: null,
        journal,
        defaults,
        testId: "default",
        errorWire: "ollama",
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    url = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it.each(["/json-200", "/json-4xx"])("%s: one content-type, the authored value", async (path) => {
    const reply = await send(url, path, {});
    expect(reply.status).toBe(fixtures[path].status ?? 200);
    expect(valuesOf(reply, "content-type")).toEqual(["application/vnd.test+json"]);
  });

  it("/stream-status: the authored content-type and cache-control, the other defaults kept", async () => {
    const reply = await send(url, "/stream-status", {});
    expect(reply.status).toBe(200);
    expect(valuesOf(reply, "content-type")).toEqual(["text/plain"]);
    expect(valuesOf(reply, "cache-control")).toEqual(["max-age=5"]);
    expect(valuesOf(reply, "connection")).toEqual(["keep-alive"]);
  });
});
