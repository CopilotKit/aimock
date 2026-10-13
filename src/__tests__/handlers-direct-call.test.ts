/**
 * The exported chat handlers, called directly with a hand-built positional
 * `HandlerDefaults` — no `createServer`, no `LLMock`. Each handler is mounted
 * in a bare `http.createServer` so it gets a real `IncomingMessage` /
 * `ServerResponse` pair, then driven over HTTP.
 *
 * The server-driven corpus and the `.d.ts` diff cannot see a handler that
 * stops reading `defaults.strict` (or starts depending on something only the
 * server sets up). These tests can: a fixture miss must be a 503 with
 * `strict: true` and the non-strict status (404, or a synthesized reply for
 * embeddings) with `strict: false`, from the `defaults` argument alone.
 * Bodies are pinned via `expectGolden("direct-call", …)`, after the harness's
 * id/timestamp normalization.
 *
 * A handler that throws (or a request stream error) is a test failure, never
 * a capture: the mount destroys the connection without writing anything, and
 * `post` (or, failing that, `afterEach`) throws the recorded error.
 */
import { readFileSync } from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleBedrock,
  handleBedrockStream,
  handleCohere,
  handleConverse,
  handleConverseStream,
  handleEmbeddings,
  handleGemini,
  handleGeminiInteractions,
  handleMessages,
  handleOllama,
  handleOllamaGenerate,
  handleResponses,
} from "../index.js";
import { Journal } from "../journal.js";
import { Logger } from "../logger.js";
import type { Fixture, HandlerDefaults } from "../types.js";
import {
  captureHttp,
  expectGolden,
  goldenPath,
  serializeGolden,
  type CapturedExchange,
  type FrameMode,
} from "./golden/harness.js";

const SUITE = "direct-call";

type Handler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  raw: string,
  fixtures: Fixture[],
  journal: Journal,
  defaults: HandlerDefaults,
) => Promise<void>;

const noCors = (): void => {};

function makeDefaults(overrides: Partial<HandlerDefaults> = {}): HandlerDefaults {
  return {
    latency: 0,
    chunkSize: 20,
    replaySpeed: 1,
    logger: new Logger("silent"),
    ...overrides,
  };
}

interface Mounted {
  url: string;
  journal: Journal;
  /** Handler throws and request stream errors not yet reported by `post`. */
  errors: unknown[];
  close: () => Promise<void>;
}

const open: Mounted[] = [];

/** Takes `m`'s unreported errors; returns an Error naming them, or undefined. */
function takeHandlerErrors(m: Mounted): Error | undefined {
  const errs = m.errors.splice(0);
  if (errs.length === 0) return undefined;
  return new Error(`direct-call handler threw: ${errs.map(String).join("; ")}`, {
    cause: errs[0],
  });
}

async function closeMounts(): Promise<void> {
  const mounts = open.splice(0);
  const failures: unknown[] = [];
  // Close every server even if one close fails.
  for (const r of await Promise.allSettled(mounts.map((m) => m.close()))) {
    if (r.status === "rejected") failures.push(r.reason);
  }
  // Closing settles handlers, including errors raised after `post` returned.
  failures.push(...mounts.flatMap((m) => takeHandlerErrors(m) ?? []));
  if (failures.length > 0) throw failures[0];
}

afterEach(closeMounts);

/** Mount one handler, with fixed fixtures and defaults, in a bare HTTP server. */
async function mount(
  handler: Handler,
  fixtures: Fixture[],
  defaults: HandlerDefaults,
): Promise<Mounted> {
  const journal = new Journal();
  const errors: unknown[] = [];
  const invocations: Promise<void>[] = [];
  // Record first, then destroy: nothing about the failure reaches the response,
  // so no capture can pin it, and the client's error arrives after the record.
  const fail = (err: unknown, res: http.ServerResponse): void => {
    errors.push(err);
    res.destroy();
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("error", (err) => fail(err, res));
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      invocations.push(
        Promise.resolve()
          .then(() => handler(req, res, raw, fixtures, journal, defaults))
          .catch((err: unknown) => fail(err, res)),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const mounted: Mounted = {
    url: `http://127.0.0.1:${port}`,
    journal,
    errors,
    close: async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all(invocations),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(new Error("direct-call handler did not settle within 1000 ms")),
              1000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timeout);
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
          server.closeAllConnections();
        });
      }
    },
  };
  open.push(mounted);
  return mounted;
}

/** POST to a mount; throws the handler's error instead of returning a capture of it. */
async function post(
  m: Mounted,
  path: string,
  body: unknown,
  frames?: FrameMode,
): Promise<CapturedExchange> {
  let got: CapturedExchange;
  try {
    got = await captureHttp(m.url + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      frames,
    });
  } catch (err) {
    throw takeHandlerErrors(m) ?? err;
  }
  const handlerError = takeHandlerErrors(m);
  if (handlerError) throw handlerError;
  return got;
}

// ─── Per-handler wiring ─────────────────────────────────────────────────────

const HELLO: Fixture = { match: { userMessage: "hello" }, response: { content: "Hi there." } };

interface ChatCase {
  /** Golden case-name prefix. */
  name: string;
  handler: Handler;
  path: string;
  /** Request body carrying the given user text. */
  body: (text: string) => unknown;
  frames?: FrameMode;
  fixtures?: Fixture[];
  /** Status of a non-strict miss; 404 unless the handler synthesizes a reply. */
  missStatus?: number;
}

const CLAUDE_MODEL = "claude-3-5-sonnet-20241022";
const BEDROCK_MODEL = "anthropic.claude-3-5-sonnet-20241022-v2:0";

const CASES: ChatCase[] = [
  {
    name: "messages",
    handler: (req, res, raw, f, j, d) => handleMessages(req, res, raw, f, j, d, noCors),
    path: "/v1/messages",
    body: (text) => ({
      model: CLAUDE_MODEL,
      max_tokens: 64,
      messages: [{ role: "user", content: text }],
    }),
  },
  {
    name: "messages-stream",
    handler: (req, res, raw, f, j, d) => handleMessages(req, res, raw, f, j, d, noCors),
    path: "/v1/messages",
    body: (text) => ({
      model: CLAUDE_MODEL,
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: text }],
    }),
    frames: "sse",
  },
  {
    name: "bedrock",
    handler: (req, res, raw, f, j, d) =>
      handleBedrock(req, res, raw, BEDROCK_MODEL, f, j, d, noCors),
    path: `/model/${BEDROCK_MODEL}/invoke`,
    body: (text) => ({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 64,
      messages: [{ role: "user", content: text }],
    }),
  },
  {
    name: "bedrock-stream",
    handler: (req, res, raw, f, j, d) =>
      handleBedrockStream(req, res, raw, BEDROCK_MODEL, f, j, d, noCors),
    path: `/model/${BEDROCK_MODEL}/invoke-with-response-stream`,
    body: (text) => ({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 64,
      messages: [{ role: "user", content: text }],
    }),
    frames: "aws",
  },
  {
    name: "converse",
    handler: (req, res, raw, f, j, d) =>
      handleConverse(req, res, raw, BEDROCK_MODEL, f, j, d, noCors),
    path: `/model/${BEDROCK_MODEL}/converse`,
    body: (text) => ({ messages: [{ role: "user", content: [{ text }] }] }),
  },
  {
    name: "converse-stream",
    handler: (req, res, raw, f, j, d) =>
      handleConverseStream(req, res, raw, BEDROCK_MODEL, f, j, d, noCors),
    path: `/model/${BEDROCK_MODEL}/converse-stream`,
    body: (text) => ({ messages: [{ role: "user", content: [{ text }] }] }),
    frames: "aws",
  },
  {
    name: "gemini",
    handler: (req, res, raw, f, j, d) =>
      handleGemini(req, res, raw, "gemini-2.0-flash", false, f, j, d, noCors),
    path: "/v1beta/models/gemini-2.0-flash:generateContent",
    body: (text) => ({ contents: [{ role: "user", parts: [{ text }] }] }),
  },
  {
    name: "gemini-stream",
    handler: (req, res, raw, f, j, d) =>
      handleGemini(req, res, raw, "gemini-2.0-flash", true, f, j, d, noCors),
    path: "/v1beta/models/gemini-2.0-flash:streamGenerateContent",
    body: (text) => ({ contents: [{ role: "user", parts: [{ text }] }] }),
    frames: "sse",
  },
  {
    name: "gemini-interactions",
    handler: (req, res, raw, f, j, d) => handleGeminiInteractions(req, res, raw, f, j, d, noCors),
    path: "/v1beta/interactions",
    body: (text) => ({ model: "gemini-2.5-flash", input: text }),
  },
  {
    name: "responses",
    handler: (req, res, raw, f, j, d) => handleResponses(req, res, raw, f, j, d, noCors),
    path: "/v1/responses",
    body: (text) => ({ model: "gpt-4o", input: text }),
  },
  {
    name: "ollama",
    handler: (req, res, raw, f, j, d) => handleOllama(req, res, raw, f, j, d, noCors),
    path: "/api/chat",
    body: (text) => ({
      model: "llama3",
      stream: false,
      messages: [{ role: "user", content: text }],
    }),
  },
  {
    name: "ollama-generate",
    handler: (req, res, raw, f, j, d) => handleOllamaGenerate(req, res, raw, f, j, d, noCors),
    path: "/api/generate",
    body: (text) => ({ model: "llama3", stream: false, prompt: text }),
  },
  {
    name: "cohere",
    handler: (req, res, raw, f, j, d) => handleCohere(req, res, raw, f, j, d, noCors),
    path: "/v2/chat",
    body: (text) => ({ model: "command-r-plus", messages: [{ role: "user", content: text }] }),
  },
  {
    name: "embeddings",
    handler: (req, res, raw, f, j, d) => handleEmbeddings(req, res, raw, f, j, d, noCors),
    path: "/v1/embeddings",
    body: (text) => ({ model: "text-embedding-3-small", input: text }),
    fixtures: [{ match: { inputText: "hello" }, response: { embedding: [0.25, -0.5, 0.75] } }],
    // A non-strict miss serves a deterministic generated embedding instead of a 404.
    missStatus: 200,
  },
];

describe("exported handlers called directly: fixture hit and strict miss", () => {
  describe.each(CASES)("$name", (c) => {
    const fixtures = c.fixtures ?? [HELLO];
    // A miss answers with plain JSON, not a stream, even on a streaming route, so
    // it is captured as a `body` (no `frames`); the content-type check pins that.
    const missJson = (got: CapturedExchange): void => {
      expect(got.headers["content-type"]).toBe("application/json");
    };

    it("serves the matching fixture", async () => {
      const m = await mount(c.handler, fixtures, makeDefaults());
      const got = await post(m, c.path, c.body("hello"), c.frames);
      expect(got.status).toBe(200);
      expectGolden(SUITE, `${c.name}-hit`, got);
    });

    it("strict: true in defaults turns a miss into 503", async () => {
      const m = await mount(c.handler, fixtures, makeDefaults({ strict: true }));
      const got = await post(m, c.path, c.body("no fixture matches this"));
      expect(got.status).toBe(503);
      missJson(got);
      expect(m.journal.getLast()?.response.status).toBe(503);
      expectGolden(SUITE, `${c.name}-miss-strict`, got);
    });

    it("strict: false in defaults keeps the non-strict miss status", async () => {
      const m = await mount(c.handler, fixtures, makeDefaults({ strict: false }));
      const got = await post(m, c.path, c.body("no fixture matches this"));
      expect(got.status).toBe(c.missStatus ?? 404);
      missJson(got);
      expect(m.journal.getLast()?.response.status).toBe(c.missStatus ?? 404);
      expectGolden(SUITE, `${c.name}-miss-nonstrict`, got);
    });

    it("strict absent from defaults behaves as strict: false", async () => {
      const m = await mount(c.handler, fixtures, makeDefaults());
      const got = await post(m, c.path, c.body("no fixture matches this"));
      expect(got.status).toBe(c.missStatus ?? 404);
      missJson(got);
      expect(m.journal.getLast()?.response.status).toBe(c.missStatus ?? 404);
      // Same bytes as the strict: false golden (compared here, never written).
      const nonstrict = goldenPath(SUITE, `${c.name}-miss-nonstrict`);
      expect(serializeGolden(got), `differs from ${nonstrict}`).toBe(
        readFileSync(nonstrict, "utf8"),
      );
    });
  });
});

// ─── Messages: thinking-invariant violation, strict vs warn ─────────────────

describe("handleMessages called directly: thinking invariants follow defaults.strict", () => {
  const toolUse = { type: "tool_use", id: "tu_1", name: "get_weather", input: { city: "NYC" } };
  // Thinking enabled, but the in-scope assistant turn has no leading thinking block.
  const violating = {
    model: "claude-3-7-sonnet-20250219",
    max_tokens: 1024,
    thinking: { type: "enabled", budget_tokens: 1024 },
    messages: [
      { role: "user", content: "What is the weather?" },
      { role: "assistant", content: [toolUse] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "Sunny" }] },
    ],
  };
  const continuation: Fixture = {
    match: { toolCallId: "tu_1" },
    response: { content: "It is sunny." },
  };
  const handler: Handler = (req, res, raw, f, j, d) =>
    handleMessages(req, res, raw, f, j, d, noCors);

  it("strict: true rejects the request with 400", async () => {
    const logger = new Logger("silent");
    const warn = vi.spyOn(logger, "warn");
    const m = await mount(handler, [continuation], makeDefaults({ strict: true, logger }));
    const got = await post(m, "/v1/messages", violating);
    expect(got.status).toBe(400);
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/THINKING/);
    expectGolden(SUITE, "messages-thinking-violation-strict", got);
  });

  it("strict: false serves the fixture and warns", async () => {
    const logger = new Logger("silent");
    const warn = vi.spyOn(logger, "warn");
    const m = await mount(handler, [continuation], makeDefaults({ strict: false, logger }));
    const got = await post(m, "/v1/messages", violating);
    expect(got.status).toBe(200);
    const warned = warn.mock.calls.flat().join(" ");
    expect(warned).toMatch(/THINKING/);
    expect(warned).toMatch(/strict off/);
    expectGolden(SUITE, "messages-thinking-violation-nonstrict", got);
  });
});

// ─── strictToolArguments on a direct call ───────────────────────────────────

describe("strictToolArguments in defaults on a direct handler call", () => {
  // The server enters the strictToolArguments scope once per HTTP request
  // (server.ts, runWithToolArgumentsScope); the handlers never read
  // `defaults.strictToolArguments` themselves. A direct caller therefore gets
  // the default treatment of malformed fixture arguments (served as `{}` with
  // a warning) whatever the flag says. These goldens pin that current
  // behaviour, not a contract: when direct calls start honouring the flag,
  // replace the `strict-true` golden and this test's expectations; the change
  // is the fix, not a regression.
  const malformed: Fixture = {
    match: { userMessage: "hello" },
    response: { toolCalls: [{ name: "get_weather", arguments: "{not json" }] },
  };
  const handler: Handler = (req, res, raw, f, j, d) =>
    handleMessages(req, res, raw, f, j, d, noCors);
  const body = {
    model: CLAUDE_MODEL,
    max_tokens: 64,
    messages: [{ role: "user", content: "hello" }],
  };

  it.each([
    ["true", true],
    ["false", false],
  ])("strictToolArguments: %s serves malformed arguments as {}", async (label, flag) => {
    const logger = new Logger("silent");
    const warn = vi.spyOn(logger, "warn");
    const m = await mount(
      handler,
      [malformed],
      makeDefaults({ strictToolArguments: flag, logger }),
    );
    const got = await post(m, "/v1/messages", body);
    expect(got.status).toBe(200);
    const parsed = JSON.parse(got.body!) as { content: Array<{ type: string; input?: unknown }> };
    expect(parsed.content.find((b) => b.type === "tool_use")?.input).toEqual({});
    expect(warn.mock.calls.flat().join(" ")).toMatch(/Malformed JSON in fixture tool call/);
    // One golden per flag: a shared file would let the second capture overwrite the first.
    expectGolden(SUITE, `messages-malformed-tool-args-strict-${label}`, got);
  });
});

// ─── The mount harness itself ───────────────────────────────────────────────

describe("direct-call mount harness: a handler that throws never yields a capture", () => {
  it("throw before headers: post rejects with the handler error", async () => {
    const m = await mount(
      async () => {
        throw new Error("boom before headers");
      },
      [],
      makeDefaults(),
    );
    await expect(post(m, "/x", {})).rejects.toThrow(/boom before headers/);
  });

  it("throw after headers (mid-stream): post rejects with the handler error", async () => {
    const m = await mount(
      async (_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: first\n\n");
        await new Promise((r) => setTimeout(r, 10));
        throw new Error("boom mid-stream");
      },
      [],
      makeDefaults(),
    );
    await expect(post(m, "/x", {}, "sse")).rejects.toThrow(/boom mid-stream/);
  });

  it.each([false, true])("settles work after response capture (rejects: %s)", async (rejects) => {
    let release!: () => void;
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    let settled = false;
    const m = await mount(
      async (_req, res) => {
        res.end("completed response");
        await resume;
        settled = true;
        if (rejects) throw new Error("boom after response capture");
      },
      [],
      makeDefaults(),
    );
    expect((await post(m, "/x", {})).body).toBe("completed response");
    setTimeout(release, 10);
    if (rejects) {
      await expect(closeMounts()).rejects.toThrow(/boom after response capture/);
    } else {
      await closeMounts();
    }
    expect(settled).toBe(true);
  });

  it("bounds unfinished work and closes every server before failing", async () => {
    let release!: () => void;
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = await mount(
      async (_req, res) => {
        res.end("completed response");
        await resume;
      },
      [],
      makeDefaults(),
    );
    const completed = await mount(
      async (_req, res) => {
        res.end("completed response");
      },
      [],
      makeDefaults(),
    );
    await post(pending, "/x", {});
    await post(completed, "/x", {});
    try {
      await expect(closeMounts()).rejects.toThrow(/did not settle within 1000 ms/);
      await expect(post(pending, "/x", {})).rejects.toMatchObject({
        cause: { code: "ECONNREFUSED" },
      });
      await expect(post(completed, "/x", {})).rejects.toMatchObject({
        cause: { code: "ECONNREFUSED" },
      });
    } finally {
      release();
    }
  });
});
