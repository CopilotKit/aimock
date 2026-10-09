/**
 * #505 — the non-Responses wires listed in `routes` below, plus the Realtime
 * and Gemini Live WebSockets, reject a custom tool call before any content and
 * drop `namespace` from a function call (in `toolCalls` or a `toolCall` block).
 *
 * The rejection contract on those wires:
 * - it checks only what the wire will emit: the ordered `blocks` when present
 *   (legacy `toolCalls` are not read then, whatever their shape), otherwise
 *   `toolCalls`;
 * - the message names the wire the request arrived on;
 * - the error is a 500 carrying `aimock_unsupported_tool_call` in the error
 *   envelope that wire's handler uses (Cohere's is the OpenAI-style
 *   `{ error: { message, type, code } }`, see `expectedEnvelope`);
 * - the journal entry keeps the request body and the matched fixture, like the
 *   invalid-tool-arguments path;
 * - the rejection changes no session state (Realtime and Gemini Live history,
 *   Gemini Interactions ids).
 *
 * Ollama `/api/generate` is the exception: it rejects every tool-call fixture
 * with a 400, custom or not.
 *
 * Real surfaces: a real LLMock over HTTP (streaming and non-streaming) and the
 * Realtime / Gemini Live WebSockets.
 */
import { afterEach, describe, expect, it } from "vitest";
import { LLMock } from "../llmock.js";
import type { Fixture, FixtureResponse } from "../types.js";
import { connectWebSocket } from "./ws-test-client.js";

const SENTINEL = "must not be emitted";
const CODE = "aimock_unsupported_tool_call";

function customMessage(wire: string): string {
  return (
    'aimock: fixture tool call "apply_patch" is a custom tool call, which only the OpenAI Responses API supports; ' +
    `this request arrived on ${wire}`
  );
}

const custom = { type: "custom" as const, name: "apply_patch", input: "*** Begin Patch" };
const fn = { name: "lookup", arguments: '{"q":"x"}' };

const variants: Array<{ id: string; response: FixtureResponse }> = [
  { id: "toolCalls tool-only", response: { toolCalls: [fn, custom] } },
  { id: "content+toolCalls", response: { content: SENTINEL, toolCalls: [custom] } },
  {
    id: "blocks-only customToolCall",
    response: {
      blocks: [
        { type: "text", text: SENTINEL },
        { type: "customToolCall", name: "apply_patch", input: "*** Begin Patch" },
      ],
    },
  },
  {
    id: "content+toolCalls+blocks customToolCall",
    response: {
      content: SENTINEL,
      toolCalls: [custom],
      blocks: [
        { type: "text", text: SENTINEL },
        { type: "customToolCall", name: "apply_patch", input: "*** Begin Patch" },
      ],
    },
  },
  {
    id: "customToolCall block with an invalid namespace",
    response: {
      blocks: [
        { type: "text", text: SENTINEL },
        { type: "customToolCall", name: "apply_patch", input: "*** Begin Patch", namespace: "" },
      ],
    },
  },
];

type Shape =
  | "openai"
  | "openrouter"
  | "messages"
  | "google"
  | "bedrock"
  | "ollama"
  | "interactions";

interface Route {
  path: string;
  body: Record<string, unknown>;
  wire: string;
  shape: Shape;
}

const chatBody = { model: "gpt-4o", messages: [{ role: "user", content: "go" }] };
const geminiBody = { contents: [{ role: "user", parts: [{ text: "go" }] }] };
const VERTEX = "/v1/projects/p/locations/us-central1/publishers/google/models/gemini-2.0-flash";

const routes: Route[] = [
  {
    path: "/v1/chat/completions",
    body: chatBody,
    wire: "OpenAI Chat Completions",
    shape: "openai",
  },
  {
    path: "/v1/chat/completions",
    body: { ...chatBody, stream: true },
    wire: "OpenAI Chat Completions",
    shape: "openai",
  },
  {
    path: "/api/v1/chat/completions",
    body: { ...chatBody, model: "openai/gpt-4o" },
    wire: "OpenRouter Chat Completions",
    shape: "openrouter",
  },
  {
    path: "/api/v1/chat/completions",
    body: { ...chatBody, model: "openai/gpt-4o", stream: true },
    wire: "OpenRouter Chat Completions",
    shape: "openrouter",
  },
  {
    path: "/api/v3/chat/completions",
    body: { ...chatBody, model: "doubao-seed-1-6" },
    wire: "BytePlus ModelArk Chat Completions",
    shape: "openai",
  },
  {
    path: "/api/v3/chat/completions",
    body: { ...chatBody, model: "doubao-seed-1-6", stream: true },
    wire: "BytePlus ModelArk Chat Completions",
    shape: "openai",
  },
  {
    path: "/openai/deployments/dep/chat/completions?api-version=2024-10-21",
    body: { messages: chatBody.messages },
    wire: "Azure OpenAI Chat Completions",
    shape: "openai",
  },
  {
    path: "/v1/messages",
    body: { model: "claude", max_tokens: 64, messages: [{ role: "user", content: "go" }] },
    wire: "Anthropic Messages",
    shape: "messages",
  },
  {
    path: "/v1/messages",
    body: {
      model: "claude",
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "go" }],
    },
    wire: "Anthropic Messages",
    shape: "messages",
  },
  {
    path: "/v1beta/models/gemini-2.0-flash:generateContent",
    body: geminiBody,
    wire: "Gemini",
    shape: "google",
  },
  {
    path: "/v1beta/models/gemini-2.0-flash:streamGenerateContent",
    body: geminiBody,
    wire: "Gemini",
    shape: "google",
  },
  { path: `${VERTEX}:generateContent`, body: geminiBody, wire: "Vertex AI", shape: "google" },
  { path: `${VERTEX}:streamGenerateContent`, body: geminiBody, wire: "Vertex AI", shape: "google" },
  {
    path: "/model/claude/invoke",
    body: { max_tokens: 64, messages: [{ role: "user", content: "go" }] },
    wire: "Bedrock InvokeModel",
    shape: "bedrock",
  },
  {
    path: "/model/claude/invoke-with-response-stream",
    body: { max_tokens: 64, messages: [{ role: "user", content: "go" }] },
    wire: "Bedrock InvokeModel",
    shape: "bedrock",
  },
  {
    path: "/model/claude/converse",
    body: { messages: [{ role: "user", content: [{ text: "go" }] }] },
    wire: "Bedrock Converse",
    shape: "bedrock",
  },
  {
    path: "/model/claude/converse-stream",
    body: { messages: [{ role: "user", content: [{ text: "go" }] }] },
    wire: "Bedrock Converse",
    shape: "bedrock",
  },
  {
    path: "/api/chat",
    body: { model: "llama3", stream: false, messages: [{ role: "user", content: "go" }] },
    wire: "Ollama",
    shape: "ollama",
  },
  {
    path: "/api/chat",
    body: { model: "llama3", stream: true, messages: [{ role: "user", content: "go" }] },
    wire: "Ollama",
    shape: "ollama",
  },
  {
    path: "/v2/chat",
    body: { model: "command-r", messages: [{ role: "user", content: "go" }] },
    wire: "Cohere",
    shape: "openai",
  },
  {
    path: "/v2/chat",
    body: { model: "command-r", stream: true, messages: [{ role: "user", content: "go" }] },
    wire: "Cohere",
    shape: "openai",
  },
  {
    path: "/v1beta/interactions",
    body: { model: "gemini-2.5-flash", input: "go", stream: false },
    wire: "Gemini Interactions",
    shape: "interactions",
  },
  {
    path: "/v1beta/interactions",
    body: { model: "gemini-2.5-flash", input: "go", stream: true },
    wire: "Gemini Interactions",
    shape: "interactions",
  },
];

/** The error envelope each wire's handler answers with, carrying the message and {@link CODE}. */
function expectedEnvelope(shape: Shape, message: string): unknown {
  switch (shape) {
    case "openai":
      return { error: { message, type: "server_error", code: CODE } };
    case "openrouter":
      return { error: { code: 500, message, metadata: { reason: CODE } } };
    case "messages":
      return { type: "error", error: { type: "api_error", code: CODE, message } };
    case "google":
      return {
        error: {
          code: 500,
          message,
          status: "INTERNAL",
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.ErrorInfo",
              reason: "AIMOCK_UNSUPPORTED_TOOL_CALL",
              domain: "aimock",
              metadata: { code: CODE },
            },
          ],
        },
      };
    case "bedrock":
      return { __type: "InternalServerException", message, reason: CODE };
    case "ollama":
      return { error: message, code: CODE };
    case "interactions":
      return { error: { code: CODE, message } };
  }
}

let mock: LLMock | null = null;
afterEach(async () => {
  await mock?.stop();
  mock = null;
});

async function start(response: FixtureResponse): Promise<LLMock> {
  mock = new LLMock({ port: 0, logLevel: "silent" });
  mock.addFixture({ match: {}, response } as Fixture);
  await mock.start();
  return mock;
}

async function hit(m: LLMock, path: string, body: Record<string, unknown>) {
  const res = await fetch(m.url + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const text = await res.text();
  // Bedrock InvokeModel streams carry each event's JSON base64-encoded in "bytes".
  const decoded = [...text.matchAll(/"bytes":"([A-Za-z0-9+/=]+)"/g)]
    .map((match) => Buffer.from(match[1], "base64").toString("utf8"))
    .join("\n");
  return { status: res.status, text: decoded ? `${text}\n${decoded}` : text };
}

describe.each(variants)("custom tool call on non-Responses HTTP wires: $id", ({ response }) => {
  it.each(routes)(
    "$path $body.stream → 500 before content, wire envelope, journaled with body + fixture",
    async ({ path, body, wire, shape }) => {
      const m = await start(response);
      const r = await hit(m, path, body);
      expect(r.status, r.text).toBe(500);
      expect(r.text).not.toContain(SENTINEL);
      const message = customMessage(wire);
      expect(JSON.parse(r.text)).toEqual(expectedEnvelope(shape, message));

      expect(m.getRequests()).toHaveLength(1);
      const entry = m.getLastRequest();
      expect(entry?.body).not.toBeNull();
      expect(entry?.response.status).toBe(500);
      expect(entry?.response.error).toBe(message);
      expect(entry?.response.source).not.toBe("internal");
      expect(entry?.response.fixture?.response).toEqual(response);
    },
  );
});

describe("custom tool call on Ollama /api/generate", () => {
  it.each(variants)(
    "$id → rejected before content, journaled with body + fixture",
    async ({ response }) => {
      const m = await start(response);
      const r = await hit(m, "/api/generate", { model: "llama3", prompt: "go", stream: false });
      expect(r.status, r.text).toBe(400);
      expect(r.text).not.toContain(SENTINEL);
      expect(r.text).toContain("Tool call fixtures are not supported on /api/generate");
      const entry = m.getLastRequest();
      expect(entry?.body).not.toBeNull();
      expect(entry?.response.status).toBe(400);
      expect(entry?.response.fixture?.response).toEqual(response);
    },
  );
});

describe("namespaced function call on non-Responses HTTP wires emits the bare name", () => {
  const carriers: Array<{ id: string; response: FixtureResponse }> = [
    { id: "toolCalls", response: { toolCalls: [{ ...fn, namespace: "mcp__ns_marker" }] } },
    {
      id: "toolCall block",
      response: { blocks: [{ type: "toolCall", ...fn, namespace: "mcp__ns_marker" }] },
    },
  ];
  describe.each(carriers)("$id", ({ response }) => {
    it.each(routes)("$path $body.stream", async ({ path, body }) => {
      const m = await start(response);
      const r = await hit(m, path, body);
      expect(r.status, r.text).toBe(200);
      expect(r.text).toContain("lookup");
      expect(r.text).not.toContain("mcp__ns_marker");
      expect(m.getRequests()).toHaveLength(1);
      expect(m.getLastRequest()?.response.status).toBe(200);
    });
  });
});

/** Function-only blocks are authoritative; the custom entry in legacy toolCalls is never emitted. */
const BLOCK_TEXT = "from the blocks";
const blocksAuthoritative: FixtureResponse = {
  content: BLOCK_TEXT,
  toolCalls: [custom],
  blocks: [
    { type: "text", text: BLOCK_TEXT },
    { type: "toolCall", name: "lookup", arguments: '{"q":"x"}' },
  ],
};

/** Function-only blocks next to a legacy toolCalls entry that is malformed, not just custom. */
const blocksAuthoritativeMalformed = {
  content: BLOCK_TEXT,
  toolCalls: [{ type: "custom", name: 5, namespace: "", arguments: { a: 1 } }],
  blocks: blocksAuthoritative.blocks,
} as unknown as FixtureResponse;

describe("non-empty blocks are authoritative: legacy toolCalls are ignored", () => {
  describe.each([
    { id: "a custom entry", response: blocksAuthoritative },
    { id: "a malformed entry", response: blocksAuthoritativeMalformed },
  ])("$id", ({ response }) => {
    it.each(routes)("$path $body.stream → 200 from the blocks", async ({ path, body }) => {
      const m = await start(response);
      const r = await hit(m, path, body);
      expect(r.status, r.text).toBe(200);
      expect(r.text).toContain("lookup");
      expect(r.text).not.toContain("apply_patch");
      expect(m.getRequests()).toHaveLength(1);
      expect(m.getLastRequest()?.response.status).toBe(200);
    });
  });
});

describe("Gemini audio fixture with a custom companion tool call", () => {
  const audio = { audio: "AAAA", toolCalls: [custom] } as FixtureResponse;
  it.each([
    { path: "/v1beta/models/gemini-2.0-flash:generateContent", wire: "Gemini" },
    { path: "/v1beta/models/gemini-2.0-flash:streamGenerateContent", wire: "Gemini" },
    { path: `${VERTEX}:generateContent`, wire: "Vertex AI" },
  ])("$path → 500, no audio or functionCall emitted", async ({ path, wire }) => {
    const m = await start(audio);
    const r = await hit(m, path, geminiBody);
    expect(r.status, r.text).toBe(500);
    expect(r.text).not.toContain("inlineData");
    expect(r.text).not.toContain("functionCall");
    expect(JSON.parse(r.text)).toEqual(expectedEnvelope("google", customMessage(wire)));
    const entry = m.getLastRequest();
    expect(entry?.body).not.toBeNull();
    expect(entry?.response).toMatchObject({ status: 500, error: customMessage(wire) });
    expect(entry?.response.fixture?.response).toEqual(audio);
  });
});

// ─── WebSocket wires ────────────────────────────────────────────────────────

type WSClient = Awaited<ReturnType<typeof connectWebSocket>>;

/**
 * Wait until a message received at or after index `from` satisfies `done`.
 * Throws with the transcript if none does within 3s, so a hung or truncated
 * turn fails the test instead of being asserted on as a partial transcript.
 */
async function waitFrom(
  ws: WSClient,
  from: number,
  done: (msg: string) => boolean,
  what: string,
): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!ws.getMessages().slice(from).some(done)) {
    if (Date.now() > deadline) {
      throw new Error(`no ${what} within 3s; got ${JSON.stringify(ws.getMessages())}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** One Realtime turn per text; returns each turn's events from response.create on. */
async function realtimeTurns(
  m: LLMock,
  texts: string[],
): Promise<Array<Array<Record<string, unknown>>>> {
  const ws = await connectWebSocket(m.url, "/v1/realtime");
  try {
    await waitFrom(ws, 0, () => true, "session.created");
    const turns: Array<Array<Record<string, unknown>>> = [];
    for (const text of texts) {
      const beforeItem = ws.getMessages().length;
      ws.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
        }),
      );
      await waitFrom(ws, beforeItem, () => true, "conversation.item.created");
      const before = ws.getMessages().length;
      ws.send(JSON.stringify({ type: "response.create" }));
      await waitFrom(ws, before, (x) => /"type":"(error|response\.done)"/.test(x), "response.done");
      turns.push(
        ws
          .getMessages()
          .slice(before)
          .map((x) => JSON.parse(x) as Record<string, unknown>),
      );
    }
    return turns;
  } finally {
    ws.close();
  }
}

async function realtimeTurn(m: LLMock): Promise<Array<Record<string, unknown>>> {
  return (await realtimeTurns(m, ["go"]))[0];
}

const LIVE_PATH = "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

async function liveTurns(m: LLMock, texts: string[]): Promise<string[]> {
  const ws = await connectWebSocket(m.url, LIVE_PATH);
  try {
    ws.send(JSON.stringify({ setup: { model: "gemini-2.0-flash-exp" } }));
    await waitFrom(ws, 0, () => true, "setupComplete");
    for (const text of texts) {
      const before = ws.getMessages().length;
      ws.send(
        JSON.stringify({
          clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: true },
        }),
      );
      await waitFrom(ws, before, (x) => /"error"|"turnComplete":true/.test(x), "turn end");
    }
    return ws.getMessages().slice(1);
  } finally {
    ws.close();
  }
}

describe("custom tool call on WebSocket wires", () => {
  it.each(variants)(
    "Realtime: $id → failed response.done with the code, no output, journaled",
    async ({ response }) => {
      const m = await start(response);
      const events = await realtimeTurn(m);
      const all = JSON.stringify(events);
      expect(all).not.toContain(SENTINEL);
      expect(all).not.toContain("function_call_arguments");
      expect(all).not.toContain("output_item");
      expect(events.map((e) => e.type)).toEqual(["response.created", "response.done"]);
      const done = events[1] as {
        response: { status: string; status_details: { error: Record<string, unknown> } };
      };
      expect(done.response.status).toBe("failed");
      expect(done.response.status_details.error).toEqual({
        message: customMessage("OpenAI Realtime"),
        type: "server_error",
        code: CODE,
      });
      const entry = m.getLastRequest();
      expect(entry?.body).not.toBeNull();
      expect(entry?.response).toMatchObject({
        status: 500,
        error: customMessage("OpenAI Realtime"),
      });
      expect(entry?.response.fixture?.response).toEqual(response);
    },
  );

  it.each([
    ...variants,
    { id: "audio companion", response: { audio: "AAAA", toolCalls: [custom] } },
  ])("Gemini Live: $id → coded error frame, no output, socket stays open", async ({ response }) => {
    const m = await start(response as FixtureResponse);
    // A second turn on the same socket is answered too, so the rejection left it open.
    const msgs = await liveTurns(m, ["go", "go"]);
    expect(msgs).toHaveLength(2);
    expect(msgs[1]).toBe(msgs[0]);
    expect(m.getRequests().map((e) => e.response.status)).toEqual([500, 500]);
    expect(JSON.parse(msgs[0])).toEqual({
      error: {
        code: 13,
        message: customMessage("Gemini Live"),
        status: "INTERNAL",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "AIMOCK_UNSUPPORTED_TOOL_CALL",
            domain: "aimock",
            metadata: { code: CODE },
          },
        ],
      },
    });
    const entry = m.getLastRequest();
    expect(entry?.response).toMatchObject({ status: 500, error: customMessage("Gemini Live") });
    expect(entry?.response.fixture?.response).toEqual(response);
  });

  it("Realtime: function-only blocks are authoritative over a custom legacy toolCall", async () => {
    const m = await start(blocksAuthoritative);
    const all = JSON.stringify(await realtimeTurn(m));
    expect(all).toContain(BLOCK_TEXT);
    expect(all).toContain('"status":"completed"');
    expect(all).not.toContain("apply_patch");
    expect(m.getRequests()).toHaveLength(1);
    expect(m.getLastRequest()?.response.status).toBe(200);
  });

  it("Gemini Live: function-only blocks are authoritative over a custom legacy toolCall", async () => {
    const m = await start(blocksAuthoritative);
    const all = (await liveTurns(m, ["go"])).join("\n");
    expect(all).toContain(BLOCK_TEXT);
    expect(all).toContain("lookup");
    expect(all).not.toContain("apply_patch");
    expect(m.getRequests()).toHaveLength(1);
    expect(m.getLastRequest()?.response.status).toBe(200);
  });
});

describe("a rejection changes no session state", () => {
  it("Realtime: the rejected turn adds nothing to the conversation history", async () => {
    mock = new LLMock({ port: 0, logLevel: "silent" });
    mock.addFixture({ match: { userMessage: "first" }, response: { toolCalls: [custom] } });
    mock.addFixture({ match: { userMessage: "second" }, response: { content: "ok" } });
    await mock.start();
    const turns = await realtimeTurns(mock, ["first", "second"]);
    expect(
      turns.map((t) => (t.at(-1) as { response: { status: string } }).response.status),
    ).toEqual(["failed", "completed"]);
    const requests = mock.getRequests();
    expect(requests.map((r) => r.response.status)).toEqual([500, 200]);
    const body = requests[1].body as { messages: Array<{ role: string; content: unknown }> };
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "first" }] },
      { role: "user", content: [{ type: "text", text: "second" }] },
    ]);
  });

  it("Gemini Live: the rejected turn is not left in the conversation history", async () => {
    mock = new LLMock({ port: 0, logLevel: "silent" });
    mock.addFixture({ match: { userMessage: "first" }, response: { toolCalls: [custom] } });
    mock.addFixture({ match: { userMessage: "second" }, response: { content: "ok" } });
    await mock.start();
    await liveTurns(mock, ["first", "second"]);
    const requests = mock.getRequests();
    expect(requests.map((r) => r.response.status)).toEqual([500, 200]);
    const body = requests[1].body as { messages: Array<{ role: string; content: unknown }> };
    expect(body.messages).toEqual([{ role: "user", content: "second" }]);
  });

  it("Gemini Interactions: the rejection consumes no interaction id", async () => {
    mock = new LLMock({ port: 0, logLevel: "silent" });
    mock.addFixture({ match: { userMessage: "ok" }, response: { content: "fine" } });
    mock.addFixture({ match: { userMessage: "bad" }, response: { toolCalls: [custom] } });
    await mock.start();
    const ids: number[] = [];
    for (const input of ["ok", "bad", "ok"]) {
      const r = await hit(mock, "/v1beta/interactions", {
        model: "gemini-2.5-flash",
        input,
        stream: false,
      });
      if (input === "bad") {
        expect(r.status, r.text).toBe(500);
        continue;
      }
      expect(r.status, r.text).toBe(200);
      ids.push(Number(/"id":"aimock-int-(\d+)"/.exec(r.text)?.[1]));
    }
    expect(ids[1] - ids[0]).toBe(1);
  });
});
