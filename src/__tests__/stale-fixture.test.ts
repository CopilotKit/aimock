/**
 * Stale-fixture detection (#638).
 *
 * A recorded fixture carries `metadata.requestHash`, a hash of the request it
 * was recorded on. When a replayed request still matches the fixture but no
 * longer hashes the same (for example a tool result changed), the journal entry
 * gets `response.staleFixture` and one warning is logged. Serving is unchanged.
 *
 * Every case records through the real recorder against a local upstream, then
 * replays the written fixture file on a fresh server over real HTTP.
 */
import { describe, it, expect, afterEach, vi, type MockInstance } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ChatCompletionRequest, Fixture, JournalEntry } from "../types.js";
import { createServer, type ServerInstance } from "../server.js";
import { loadFixtureFile } from "../fixture-loader.js";

function postRaw(
  url: string,
  rawBody: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(rawBody),
          Authorization: "Bearer test",
          "x-api-key": "test",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on("error", reject);
    req.write(rawBody);
    req.end();
  });
}

const post = (url: string, body: unknown) => postRaw(url, JSON.stringify(body));

const servers: ServerInstance[] = [];
const tmpDirs: string[] = [];
let warnSpy: MockInstance | undefined;

afterEach(async () => {
  warnSpy?.mockRestore();
  warnSpy = undefined;
  for (const s of servers.splice(0)) {
    await new Promise<void>((resolve) => s.server.close(() => resolve()));
  }
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const REPLY = "Done - refunded $500 for order A1.";

/** Record `body` on `route` through a real recording server; return the written fixtures. */
async function record(
  route: string,
  body: unknown,
  requestTransform?: (req: ChatCompletionRequest) => ChatCompletionRequest,
): Promise<Fixture[]> {
  const upstream = await createServer(
    [{ match: { userMessage: "Refund order A1" }, response: { content: REPLY } }],
    { port: 0, logLevel: "silent" },
  );
  servers.push(upstream);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-stale-"));
  tmpDirs.push(dir);
  const recorder = await createServer([], {
    port: 0,
    logLevel: "silent",
    record: {
      providers: { openai: upstream.url, anthropic: upstream.url, cohere: upstream.url },
      fixturePath: dir,
    },
    ...(requestTransform && { requestTransform }),
  });
  servers.push(recorder);
  const res = await post(`${recorder.url}${route}`, body);
  expect(res.status).toBe(200);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  expect(files).toHaveLength(1);
  return loadFixtureFile(path.join(dir, files[0]));
}

/** Replay on a fresh server with warn-level logging captured. */
async function replay(
  fixtures: Fixture[],
  route: string,
  rawBody: string,
  requestTransform?: (req: ChatCompletionRequest) => ChatCompletionRequest,
): Promise<{
  status: number;
  body: string;
  entry: JournalEntry;
  warnings: string[];
}> {
  const server = await createServer(fixtures, {
    port: 0,
    logLevel: "warn",
    ...(requestTransform && { requestTransform }),
  });
  servers.push(server);
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  const res = await postRaw(`${server.url}${route}`, rawBody);
  const warnings = warnSpy.mock.calls.map((c) => c.map(String).join(" "));
  warnSpy.mockRestore();
  warnSpy = undefined;
  const entries = server.journal.getAll();
  expect(entries).toHaveLength(1);
  return { status: res.status, body: res.body, entry: entries[0], warnings };
}

const staleWarnings = (warnings: string[]) => warnings.filter((w) => /stale fixture/i.test(w));

// ─── Request builders: the issue's refund flow, last turn ───────────────────

function openaiBody(refundResult: string, model = "gpt-5") {
  return {
    model,
    messages: [
      { role: "user", content: "Refund order A1" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "lookup_order", arguments: '{"order_id":"A1"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: '{"status":"paid","amount":500}' },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_2",
            type: "function",
            function: { name: "refund", arguments: '{"order_id":"A1","amount":500}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_2", content: refundResult },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "refund",
          description: "Refund an order",
          parameters: {
            type: "object",
            properties: { order_id: { type: "string" }, amount: { type: "number" } },
          },
        },
      },
    ],
  };
}

function anthropicBody(refundResult: string) {
  return {
    model: "claude-sonnet-4-5",
    max_tokens: 256,
    stream: true,
    tools: [
      {
        name: "refund",
        description: "Refund an order",
        input_schema: { type: "object", properties: { order_id: { type: "string" } } },
      },
    ],
    messages: [
      { role: "user", content: "Refund order A1" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "refund", input: { order_id: "A1" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: refundResult }],
      },
    ],
  };
}

function responsesBody(refundResult: string) {
  return {
    model: "gpt-5",
    stream: true,
    tools: [
      {
        type: "function",
        name: "refund",
        description: "Refund an order",
        parameters: { type: "object", properties: { order_id: { type: "string" } } },
      },
    ],
    input: [
      { role: "user", content: "Refund order A1" },
      {
        type: "function_call",
        call_id: "call_1",
        name: "refund",
        arguments: '{"order_id":"A1"}',
      },
      { type: "function_call_output", call_id: "call_1", output: refundResult },
    ],
  };
}

const RECORDED = '{"refunded":500}';
const CHANGED = '{"blocked":true}';

const PROVIDERS = [
  { name: "OpenAI chat completions", route: "/v1/chat/completions", build: openaiBody },
  { name: "Anthropic messages (streamed)", route: "/v1/messages", build: anthropicBody },
  { name: "OpenAI Responses (streamed)", route: "/v1/responses", build: responsesBody },
] as const;

describe("stale fixture detection (#638)", () => {
  for (const p of PROVIDERS) {
    describe(p.name, () => {
      it("records a requestHash next to the other metadata hashes", async () => {
        const fixtures = await record(p.route, p.build(RECORDED));
        expect(fixtures).toHaveLength(1);
        expect(fixtures[0].metadata?.requestHash).toMatch(/^[0-9a-f]{16}$/);
      });

      it("flags a replay whose tool result changed, and still serves the recording", async () => {
        const fixtures = await record(p.route, p.build(RECORDED));
        const expected = fixtures[0].metadata?.requestHash;
        const baseline = await replay(fixtures, p.route, JSON.stringify(p.build(RECORDED)));
        const r = await replay(fixtures, p.route, JSON.stringify(p.build(CHANGED)));

        // Serving is unchanged: same status, same body as an unchanged replay.
        expect(r.status).toBe(200);
        expect(r.body.includes("refunded $500")).toBe(true);
        expect(r.entry.response.status).toBe(baseline.entry.response.status);

        expect(r.entry.response.staleFixture).toEqual({
          expected,
          actual: expect.stringMatching(/^[0-9a-f]{16}$/),
        });
        expect(r.entry.response.staleFixture?.actual).not.toBe(expected);
        const lines = staleWarnings(r.warnings);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain(String(expected));
        expect(lines[0]).toContain(String(r.entry.response.staleFixture?.actual));
      });

      it("does not flag the unchanged request", async () => {
        const fixtures = await record(p.route, p.build(RECORDED));
        const r = await replay(fixtures, p.route, JSON.stringify(p.build(RECORDED)));
        expect(r.status).toBe(200);
        expect(r.entry.response).not.toHaveProperty("staleFixture");
        expect(staleWarnings(r.warnings)).toEqual([]);
      });
    });
  }

  it("the issue's hand-written fixtures (no hash) are never flagged", async () => {
    const fixtures: Fixture[] = [
      {
        match: {
          userMessage: "Refund order A1",
          model: "gpt-5",
          turnIndex: 2,
          hasToolResult: true,
        },
        response: { content: REPLY },
      },
    ];
    const r = await replay(fixtures, "/v1/chat/completions", JSON.stringify(openaiBody(CHANGED)));
    expect(r.status).toBe(200);
    expect(r.entry.response).not.toHaveProperty("staleFixture");
    expect(staleWarnings(r.warnings)).toEqual([]);
  });

  it("a recorded fixture with its requestHash removed (older recording) is never flagged", async () => {
    const fixtures = await record("/v1/chat/completions", openaiBody(RECORDED));
    delete fixtures[0].metadata?.requestHash;
    const r = await replay(fixtures, "/v1/chat/completions", JSON.stringify(openaiBody(CHANGED)));
    expect(r.status).toBe(200);
    expect(r.entry.response).not.toHaveProperty("staleFixture");
    expect(staleWarnings(r.warnings)).toEqual([]);
  });

  it("key order and whitespace do not make a request stale", async () => {
    const fixtures = await record("/v1/chat/completions", openaiBody(RECORDED));
    // Reverse key order at every object depth, then pretty-print.
    const reorder = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(reorder);
      if (v && typeof v === "object") {
        return Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .reverse()
            .map(([k, x]) => [k, reorder(x)]),
        );
      }
      return v;
    };
    const raw = JSON.stringify(reorder(openaiBody(RECORDED)), null, 4);
    const r = await replay(fixtures, "/v1/chat/completions", raw);
    expect(r.status).toBe(200);
    expect(r.entry.response).not.toHaveProperty("staleFixture");
    expect(staleWarnings(r.warnings)).toEqual([]);
  });

  it("a dated model name does not make a request stale", async () => {
    const fixtures = await record("/v1/chat/completions", openaiBody(RECORDED, "gpt-4o"));
    const r = await replay(
      fixtures,
      "/v1/chat/completions",
      JSON.stringify(openaiBody(RECORDED, "gpt-4o-2024-08-06")),
    );
    expect(r.status).toBe(200);
    expect(r.entry.response.fixture).not.toBeNull();
    expect(r.entry.response).not.toHaveProperty("staleFixture");
    expect(staleWarnings(r.warnings)).toEqual([]);
  });

  it("a request with neither a system prompt nor tools records no hash and is never flagged", async () => {
    const bare: Record<string, unknown> = openaiBody(RECORDED);
    delete bare.tools;
    const fixtures = await record("/v1/chat/completions", bare);
    // Recorded output stays as before: no metadata block at all.
    expect(fixtures[0].metadata).toBeUndefined();
    const changed: Record<string, unknown> = openaiBody(CHANGED);
    delete changed.tools;
    const r = await replay(fixtures, "/v1/chat/completions", JSON.stringify(changed));
    expect(r.status).toBe(200);
    expect(r.entry.response).not.toHaveProperty("staleFixture");
    expect(staleWarnings(r.warnings)).toEqual([]);
  });

  it("a stream flag change alone does not make a request stale", async () => {
    const fixtures = await record("/v1/chat/completions", openaiBody(RECORDED));
    const r = await replay(
      fixtures,
      "/v1/chat/completions",
      JSON.stringify({ ...openaiBody(RECORDED), stream: true }),
    );
    expect(r.status).toBe(200);
    expect(r.entry.response).not.toHaveProperty("staleFixture");
    expect(staleWarnings(r.warnings)).toEqual([]);
  });
});

// ─── Tool calls without ids: converters make up random ids ──────────────────

/** Responses API history whose call and output carry no `call_id`. */
function responsesNoIdsBody(refundResult: string) {
  const body = responsesBody(refundResult);
  return {
    ...body,
    input: body.input.map((item) => {
      const copy: Record<string, unknown> = { ...item };
      delete copy.call_id;
      return copy;
    }),
  };
}

/** Cohere v2 history whose tool call and tool result carry no ids. */
function cohereNoIdsBody(refundResult: string) {
  return {
    model: "command-r-plus",
    tools: [
      {
        type: "function",
        function: {
          name: "refund",
          description: "Refund an order",
          parameters: { type: "object", properties: { order_id: { type: "string" } } },
        },
      },
    ],
    messages: [
      { role: "user", content: "Refund order A1" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { type: "function", function: { name: "refund", arguments: '{"order_id":"A1"}' } },
        ],
      },
      { role: "tool", content: refundResult },
    ],
  };
}

const NO_ID_PROVIDERS = [
  { name: "OpenAI Responses", route: "/v1/responses", build: responsesNoIdsBody },
  { name: "Cohere v2", route: "/v2/chat", build: cohereNoIdsBody },
] as const;

describe("tool calls without ids (#638)", () => {
  for (const p of NO_ID_PROVIDERS) {
    it(`${p.name}: an unchanged replay is not flagged`, async () => {
      const fixtures = await record(p.route, p.build(RECORDED));
      expect(fixtures[0].metadata?.requestHash).toMatch(/^[0-9a-f]{16}$/);
      const r = await replay(fixtures, p.route, JSON.stringify(p.build(RECORDED)));
      expect(r.status).toBe(200);
      expect(r.entry.response.fixture).not.toBeNull();
      expect(r.entry.response).not.toHaveProperty("staleFixture");
      expect(staleWarnings(r.warnings)).toEqual([]);
    });

    it(`${p.name}: a changed tool result is still flagged`, async () => {
      const fixtures = await record(p.route, p.build(RECORDED));
      const r = await replay(fixtures, p.route, JSON.stringify(p.build(CHANGED)));
      expect(r.status).toBe(200);
      expect(r.entry.response.staleFixture?.expected).toBe(fixtures[0].metadata?.requestHash);
      expect(staleWarnings(r.warnings)).toHaveLength(1);
    });
  }
});

// ─── A requestTransform result that cannot be hashed ────────────────────────

/** Adds a self-reference to the last message. */
const selfReferential = (req: ChatCompletionRequest): ChatCompletionRequest => {
  const messages = req.messages.map((m) => ({ ...m }));
  const last = messages[messages.length - 1] as Record<string, unknown>;
  last.self = last;
  return { ...req, messages };
};

/** Adds a BigInt to the last message. */
const withBigInt = (req: ChatCompletionRequest): ChatCompletionRequest => {
  const messages = req.messages.map((m) => ({ ...m }));
  (messages[messages.length - 1] as Record<string, unknown>).big = 1n;
  return { ...req, messages };
};

describe("a requestTransform result that cannot be hashed (#638)", () => {
  for (const [name, transform] of [
    ["self-referential", selfReferential],
    ["BigInt", withBigInt],
  ] as const) {
    it(`${name}: records normally, with no requestHash`, { timeout: 15_000 }, async () => {
      const fixtures = await record("/v1/chat/completions", openaiBody(RECORDED), transform);
      expect(fixtures).toHaveLength(1);
      expect(fixtures[0].metadata?.toolsHash).toMatch(/^[0-9a-f]{8}$/);
      expect(fixtures[0].metadata).not.toHaveProperty("requestHash");
    });

    it(`${name}: serves normally and marks nothing`, { timeout: 15_000 }, async () => {
      const fixtures = await record("/v1/chat/completions", openaiBody(RECORDED));
      const r = await replay(
        fixtures,
        "/v1/chat/completions",
        JSON.stringify(openaiBody(CHANGED)),
        transform,
      );
      expect(r.status).toBe(200);
      expect(r.body.includes("refunded $500")).toBe(true);
      expect(r.entry.response).not.toHaveProperty("staleFixture");
      expect(staleWarnings(r.warnings)).toEqual([]);
    });
  }
});
