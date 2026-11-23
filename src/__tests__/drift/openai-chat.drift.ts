/**
 * OpenAI Chat Completions API drift tests.
 *
 * Three-way comparison: SDK types × real API × aimock output.
 */

import http from "node:http";
import type {
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ServerInstance } from "../../server.js";
import { createServer } from "../../server.js";
import { LLMock } from "../../llmock.js";
import type { Fixture } from "../../types.js";
import { extractShape, triangulate, formatDriftReport } from "./schema.js";
import {
  openaiChatCompletionShape,
  openaiChatCompletionToolCallShape,
  openaiChatCompletionChunkShape,
  openaiChatCompletionReasoningShape,
  openaiChatCompletionReasoningChunkShape,
} from "./sdk-shapes.js";
import {
  resolveLiveModel,
  isInfraSkip,
  isModelNotFound,
  type ResolvedModel,
  type LiveModelEntry,
} from "./providers.js";
import { httpPost, parseDataOnlySSE, startDriftServer, stopDriftServer } from "./helpers.js";

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let instance: ServerInstance;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

beforeAll(async () => {
  instance = await startDriftServer();
});

afterAll(async () => {
  await stopDriftServer(instance);
});

// ---------------------------------------------------------------------------
// Live chat-model resolution (self-healing — generalizes cohere #325 / R0)
// ---------------------------------------------------------------------------
//
// `gpt-4o-mini` is a stable OpenAI alias (not a dated snapshot), but OpenAI
// still retires aliases on its own schedule. Discover a currently-live,
// non-deprecated chat model from OpenAI's own `/v1/models` listing rather
// than trusting the hardcoded literal to remain valid forever, and treat any
// auth/credit/rate-limit/5xx condition on the listing (or on the real chat
// call itself) as an HONEST SKIP rather than a drift finding that reds the
// PR. A real shape drift (a 2xx envelope that doesn't match) is never
// skipped — only status-classified provider-side conditions are.
//
// providers.ts's own `openaiChatNonStreaming`/`openaiChatStreaming` hardcode
// "gpt-4o-mini" and take no model parameter, so the resolved model below is
// threaded through a LOCAL, model-parameterized raw fetch (mirrors
// openai-responses.drift.ts's `fetchOpenAIResponses`) rather than a
// providers.ts edit — otherwise the discovered model never reaches the real
// API and the self-healing degrades to an eternal honest-skip once
// gpt-4o-mini retires.

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";

/** Maps OpenAI's `/v1/models` listing shape onto the shared `LiveModelEntry`. */
async function fetchOpenAIModelListing(): Promise<{ status: number; models: LiveModelEntry[] }> {
  const res = await fetch(OPENAI_MODELS_URL, {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
  });
  if (!res.ok) return { status: res.status, models: [] };
  const json = (await res.json()) as { data?: { id: string }[] };
  // OpenAI's listing does not expose a `deprecated` flag — every listed id is
  // presumed live; retirement shows up as a model-not-found on the real call.
  const models: LiveModelEntry[] = (json.data ?? []).map((m) => ({ id: m.id }));
  return { status: res.status, models };
}

let openaiChatModelPromise: Promise<ResolvedModel> | null = null;

/** Memoized so the whole live leg makes exactly one model-listing call. */
function getOpenAIChatModel(): Promise<ResolvedModel> {
  if (!openaiChatModelPromise) {
    openaiChatModelPromise = resolveLiveModel("openai-chat", fetchOpenAIModelListing, [
      "gpt-4o-mini",
    ]);
  }
  return openaiChatModelPromise;
}

/**
 * Raw Chat Completions fetch parameterized by a discovered model id,
 * returning the raw status/body so the caller can classify a retired-model or
 * provider-side condition via {@link isModelNotFound}/{@link isInfraSkip}
 * BEFORE asserting success (unlike providers.ts's variants, which throw an
 * opaque InfraError on any non-2xx).
 */
async function fetchOpenAIChat(
  model: string,
  messages: { role: string; content: string }[],
  tools: object[] | undefined,
  stream: boolean,
): Promise<{ status: number; raw: string }> {
  const body: Record<string, unknown> = { model, messages, stream, max_tokens: 10 };
  if (tools) body.tools = tools;

  const res = await fetch(OPENAI_CHAT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  return { status: res.status, raw: await res.text() };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!OPENAI_API_KEY)("OpenAI Chat Completions drift", () => {
  it("K5 forced tool budget ends with length, requested usage, and clean DONE", async (ctx) => {
    const resolved = await getOpenAIChatModel();
    if ("infra" in resolved) {
      ctx.skip();
      return;
    }
    if ("unavailable" in resolved) {
      throw new Error("OpenAI /v1/models exposed no usable chat model");
    }
    // Real capture: openai-k5-20261008T060506Z.sse. The role and tool-name
    // deltas may share a chunk; the length -> usage -> DONE order is invariant.
    const request: ChatCompletionCreateParamsStreaming = {
      model: resolved.model,
      messages: [
        {
          role: "user",
          content:
            "Call record_text with text containing the numbers from 1 to 100 separated by spaces.",
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "record_text",
            description: "Record text",
            parameters: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "record_text" } },
      max_tokens: 12,
      stream: true,
      stream_options: { include_usage: true },
    };
    const real = await fetch(OPENAI_CHAT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify(request),
    });
    const realRaw = await real.text();
    if (isInfraSkip(real.status) || isModelNotFound(real.status, realRaw)) {
      ctx.skip();
      return;
    }
    expect(real.status, `Real API error: ${realRaw.slice(0, 300)}`).toBe(200);
    const k5Mock = new LLMock({ port: 0, chunkSize: 4, enableMisbehavior: true });
    k5Mock.addFixture({
      match: {},
      response: {
        toolCalls: [
          {
            name: "record_text",
            arguments: JSON.stringify({
              text: Array.from({ length: 100 }, (_, index) => index + 1).join(" "),
            }),
          },
        ],
      },
      misbehavior: { faults: [{ fault: "stop-length-mid-tool" }] },
    });
    const k5Url = await k5Mock.start();
    try {
      const mock = await httpPost(`${k5Url}/v1/chat/completions`, request);
      console.log(
        JSON.stringify({ capture: "OpenAI K5 terminal", request, realRaw, mockRaw: mock.body }),
      );
      expect(mock.status, mock.body).toBe(200);
      for (const [provider, raw] of [
        ["real", realRaw],
        ["aimock", mock.body],
      ]) {
        const blocks = raw.replace(/\r\n/g, "\n").trim().split("\n\n");
        expect(blocks.pop(), provider).toBe("data: [DONE]");
        const chunks = blocks.map((block) => {
          expect(block.startsWith("data: "), provider).toBe(true);
          const chunk: ChatCompletionChunk = JSON.parse(block.slice(6));
          return chunk;
        });
        expect(chunks[0]?.choices[0]?.delta.role, provider).toBe("assistant");
        const terminal = chunks.at(-2);
        expect(terminal?.choices, provider).toHaveLength(1);
        expect(terminal?.choices[0], provider).toMatchObject({
          delta: {},
          finish_reason: "length",
        });
        expect(terminal?.choices[0].delta, provider).toEqual({});
        expect(chunks.at(-1), provider).toMatchObject({
          choices: [],
          usage: { completion_tokens: expect.any(Number) },
        });
        const beforeTerminal = chunks.slice(0, -2);
        expect(beforeTerminal.length, provider).toBeGreaterThan(0);
        for (const chunk of beforeTerminal) {
          expect(chunk.choices, provider).toHaveLength(1);
          expect(chunk.choices[0].finish_reason, provider).toBeNull();
        }
        const calls = beforeTerminal.flatMap((chunk) => chunk.choices[0].delta.tool_calls ?? []);
        const nameIndex = calls.findIndex((call) => call.function?.name === "record_text");
        const firstArgumentsIndex = calls.findIndex(
          (call) => (call.function?.arguments ?? "").length > 0,
        );
        expect(nameIndex, provider).toBeGreaterThanOrEqual(0);
        expect(nameIndex, provider).toBeLessThan(firstArgumentsIndex);
        expect(
          calls.every((call) => call.index === 0),
          provider,
        ).toBe(true);
        const argumentsText = calls.map((call) => call.function?.arguments ?? "").join("");
        expect(argumentsText.length, provider).toBeGreaterThan(0);
        expect(() => JSON.parse(argumentsText), provider).toThrow(SyntaxError);
      }
    } finally {
      await k5Mock.stop();
    }
  });

  it("non-streaming text shape matches", async (ctx) => {
    const resolved = await getOpenAIChatModel();
    if ("infra" in resolved) {
      // Listing hit an auth/credit/rate-limit/5xx condition — honest skip.
      ctx.skip();
      return;
    }
    if ("unavailable" in resolved) {
      throw new Error("OpenAI /v1/models exposed no usable chat model");
    }
    const model = resolved.model;

    const sdkShape = openaiChatCompletionShape();
    const messages = [{ role: "user", content: "Say hello" }];

    const [realRes, mockRes] = await Promise.all([
      fetchOpenAIChat(model, messages, undefined, false),
      httpPost(`${instance.url}/v1/chat/completions`, {
        model,
        messages,
        stream: false,
      }),
    ]);

    if (isInfraSkip(realRes.status) || isModelNotFound(realRes.status, realRes.raw)) {
      // Retired model id or a transient provider-side condition — honest
      // skip, never a drift finding that quarantines the shared baseline.
      ctx.skip();
      return;
    }
    expect(realRes.status, `Real API error: ${realRes.raw.slice(0, 300)}`).toBe(200);

    const realShape = extractShape(JSON.parse(realRes.raw));
    const mockShape = extractShape(JSON.parse(mockRes.body));

    const diffs = triangulate(sdkShape, realShape, mockShape);
    const report = formatDriftReport("OpenAI Chat (non-streaming text)", diffs, "openai-chat");

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("streaming text shape matches", async (ctx) => {
    const resolved = await getOpenAIChatModel();
    if ("infra" in resolved) {
      ctx.skip();
      return;
    }
    if ("unavailable" in resolved) {
      throw new Error("OpenAI /v1/models exposed no usable chat model");
    }
    const model = resolved.model;

    const sdkChunkShape = openaiChatCompletionChunkShape();
    const messages = [{ role: "user", content: "Say hello" }];

    const [realRes, mockStreamRes] = await Promise.all([
      fetchOpenAIChat(model, messages, undefined, true),
      httpPost(`${instance.url}/v1/chat/completions`, {
        model,
        messages,
        stream: true,
      }),
    ]);

    if (isInfraSkip(realRes.status) || isModelNotFound(realRes.status, realRes.raw)) {
      ctx.skip();
      return;
    }
    expect(realRes.status, `Real API error: ${realRes.raw.slice(0, 300)}`).toBe(200);

    const realChunks = parseDataOnlySSE(realRes.raw);
    const mockChunks = parseDataOnlySSE(mockStreamRes.body);

    expect(realChunks.length, "Real API returned no SSE events").toBeGreaterThan(0);
    expect(mockChunks.length, "Mock returned no SSE chunks").toBeGreaterThan(0);

    const realChunkShape = extractShape(realChunks[0]);
    const mockChunkShape = extractShape(mockChunks[0]);

    const diffs = triangulate(sdkChunkShape, realChunkShape, mockChunkShape);
    const report = formatDriftReport("OpenAI Chat (streaming text chunks)", diffs, "openai-chat");

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("non-streaming tool call shape matches", async (ctx) => {
    const resolved = await getOpenAIChatModel();
    if ("infra" in resolved) {
      ctx.skip();
      return;
    }
    if ("unavailable" in resolved) {
      throw new Error("OpenAI /v1/models exposed no usable chat model");
    }
    const model = resolved.model;

    const sdkShape = openaiChatCompletionToolCallShape();

    const tools = [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      },
    ];
    const messages = [{ role: "user", content: "Weather in Paris" }];

    const [realRes, mockRes] = await Promise.all([
      fetchOpenAIChat(model, messages, tools, false),
      httpPost(`${instance.url}/v1/chat/completions`, {
        model,
        messages,
        stream: false,
        tools,
      }),
    ]);

    if (isInfraSkip(realRes.status) || isModelNotFound(realRes.status, realRes.raw)) {
      ctx.skip();
      return;
    }
    expect(realRes.status, `Real API error: ${realRes.raw.slice(0, 300)}`).toBe(200);

    const realShape = extractShape(JSON.parse(realRes.raw));
    const mockShape = extractShape(JSON.parse(mockRes.body));

    const diffs = triangulate(sdkShape, realShape, mockShape);
    const report = formatDriftReport("OpenAI Chat (non-streaming tool call)", diffs, "openai-chat");

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("streaming tool call shape matches", async (ctx) => {
    const resolved = await getOpenAIChatModel();
    if ("infra" in resolved) {
      ctx.skip();
      return;
    }
    if ("unavailable" in resolved) {
      throw new Error("OpenAI /v1/models exposed no usable chat model");
    }
    const model = resolved.model;

    const sdkChunkShape = openaiChatCompletionChunkShape();

    const tools = [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      },
    ];
    const messages = [{ role: "user", content: "Weather in Paris" }];

    const [realRes, mockStreamRes] = await Promise.all([
      fetchOpenAIChat(model, messages, tools, true),
      httpPost(`${instance.url}/v1/chat/completions`, {
        model,
        messages,
        stream: true,
        tools,
      }),
    ]);

    if (isInfraSkip(realRes.status) || isModelNotFound(realRes.status, realRes.raw)) {
      ctx.skip();
      return;
    }
    expect(realRes.status, `Real API error: ${realRes.raw.slice(0, 300)}`).toBe(200);

    const realChunks = parseDataOnlySSE(realRes.raw);
    const mockChunks = parseDataOnlySSE(mockStreamRes.body);

    expect(realChunks.length, "Real API returned no SSE events").toBeGreaterThan(0);
    expect(mockChunks.length, "Mock returned no SSE chunks").toBeGreaterThan(0);

    const realChunkShape = extractShape(realChunks[0]);
    const mockChunkShape = extractShape(mockChunks[0]);

    const diffs = triangulate(sdkChunkShape, realChunkShape, mockChunkShape);
    const report = formatDriftReport(
      "OpenAI Chat (streaming tool call chunks)",
      diffs,
      "openai-chat",
    );

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Error shape tests (mock-only — no real API key required)
// ---------------------------------------------------------------------------

describe("OpenAI Chat Completions error shapes", () => {
  /**
   * OpenAI error envelope per spec:
   * https://platform.openai.com/docs/guides/error-codes
   *
   * { error: { message: string, type: string, param: string | null, code: string | null } }
   */
  function openaiErrorShape() {
    return extractShape({
      error: {
        message: "example error",
        type: "invalid_request_error",
        param: null,
        code: "invalid_json",
      },
    });
  }

  it("400 error fixture returns OpenAI error envelope shape", async () => {
    // Stand up a server with an error fixture that triggers on any request
    const errorFixtures: Fixture[] = [
      {
        match: { userMessage: "trigger-error" },
        response: {
          error: {
            message: "You exceeded your current quota",
            type: "insufficient_quota",
            code: "insufficient_quota",
          },
          status: 400,
        },
      },
    ];
    const errorInstance = await createServer(errorFixtures, { port: 0, chunkSize: 100 });

    try {
      const res = await httpPost(`${errorInstance.url}/v1/chat/completions`, {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "trigger-error" }],
        stream: false,
      });

      expect(res.status).toBe(400);

      const body = JSON.parse(res.body);
      expect(body.error).toBeDefined();
      expect(body.error.message).toBe("You exceeded your current quota");
      expect(body.error.type).toBe("insufficient_quota");

      // Validate shape matches OpenAI error envelope
      const sdkShape = openaiErrorShape();
      const mockShape = extractShape(body);

      const diffs = triangulate(sdkShape, sdkShape, mockShape);
      const report = formatDriftReport("OpenAI Chat error fixture (400)", diffs, "openai-chat");

      expect(
        diffs.filter((d) => d.severity === "critical"),
        report,
      ).toEqual([]);
    } finally {
      await new Promise<void>((r) => errorInstance.server.close(() => r()));
    }
  });

  it("404 no-fixture-match returns OpenAI error envelope shape", async () => {
    // Empty fixtures — any request will 404
    const emptyInstance = await createServer([], { port: 0, chunkSize: 100 });

    try {
      const res = await httpPost(`${emptyInstance.url}/v1/chat/completions`, {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "no fixture will match this" }],
        stream: false,
      });

      expect(res.status).toBe(404);

      const body = JSON.parse(res.body);
      expect(body.error).toBeDefined();
      expect(body.error.message).toBe("No fixture matched");
      expect(body.error.type).toBe("invalid_request_error");
      expect(body.error.code).toBe("no_fixture_match");

      // Validate shape: error envelope should have message + type + code
      const sdkShape = openaiErrorShape();
      const mockShape = extractShape(body);

      const diffs = triangulate(sdkShape, sdkShape, mockShape);
      const report = formatDriftReport("OpenAI Chat no-fixture-match (404)", diffs, "openai-chat");

      expect(
        diffs.filter((d) => d.severity === "critical"),
        report,
      ).toEqual([]);
    } finally {
      await new Promise<void>((r) => emptyInstance.server.close(() => r()));
    }
  });

  it("malformed JSON body returns 400 with OpenAI error envelope shape", async () => {
    // Any server — the JSON parse error happens before fixture matching
    const malformedInstance = await createServer([], { port: 0, chunkSize: 100 });

    try {
      // Send raw malformed JSON using http directly (httpPost would stringify a valid object)
      const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const url = new URL(`${malformedInstance.url}/v1/chat/completions`);
        const req = http.request(
          {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: "POST",
            headers: { "Content-Type": "application/json" },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (c) => chunks.push(c));
            response.on("end", () =>
              resolve({
                status: response.statusCode!,
                body: Buffer.concat(chunks).toString(),
              }),
            );
          },
        );
        req.on("error", reject);
        req.write("{not valid json!!!}}}");
        req.end();
      });

      expect(res.status).toBe(400);

      const body = JSON.parse(res.body);
      expect(body.error).toBeDefined();
      expect(body.error.message).toMatch(/^Malformed JSON/);
      expect(body.error.type).toBe("invalid_request_error");
      expect(body.error.code).toBe("invalid_json");

      // Validate shape matches OpenAI error envelope
      const sdkShape = openaiErrorShape();
      const mockShape = extractShape(body);

      const diffs = triangulate(sdkShape, sdkShape, mockShape);
      const report = formatDriftReport("OpenAI Chat malformed JSON (400)", diffs, "openai-chat");

      expect(
        diffs.filter((d) => d.severity === "critical"),
        report,
      ).toEqual([]);
    } finally {
      await new Promise<void>((r) => malformedInstance.server.close(() => r()));
    }
  });
});

// ---------------------------------------------------------------------------
// Reasoning (reasoning_content) shape tests — mock-only, no real API key
// ---------------------------------------------------------------------------

describe("OpenAI Chat Completions reasoning shapes", () => {
  const REASONING_FIXTURE: Fixture = {
    match: { userMessage: "Think carefully" },
    response: {
      content: "The answer is 42.",
      reasoning: "Let me think step by step about this problem.",
    },
  };

  it("non-streaming reasoning_content shape matches SDK expectations", async () => {
    const reasoningInstance = await createServer([REASONING_FIXTURE], {
      port: 0,
      chunkSize: 100,
    });

    try {
      const mockRes = await httpPost(`${reasoningInstance.url}/v1/chat/completions`, {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Think carefully" }],
        stream: false,
      });

      expect(mockRes.status).toBe(200);

      const body = JSON.parse(mockRes.body);

      // ── Structural assertions on reasoning_content ────────────────────
      expect(body.choices).toBeDefined();
      expect(body.choices.length).toBeGreaterThanOrEqual(1);

      const message = body.choices[0].message;
      expect(message.role).toBe("assistant");
      expect(message.content).toBe("The answer is 42.");
      expect(message.reasoning_content).toBe("Let me think step by step about this problem.");
      expect(typeof message.reasoning_content).toBe("string");

      // ── Shape triangulation against SDK expectations ───────────────────
      const sdkShape = openaiChatCompletionReasoningShape();
      const mockShape = extractShape(body);

      const diffs = triangulate(sdkShape, sdkShape, mockShape);
      const report = formatDriftReport(
        "OpenAI Chat (non-streaming reasoning)",
        diffs,
        "openai-chat",
      );

      expect(
        diffs.filter((d) => d.severity === "critical"),
        report,
      ).toEqual([]);
    } finally {
      await new Promise<void>((r) => reasoningInstance.server.close(() => r()));
    }
  });

  it("streaming reasoning_content chunks have correct delta shape", async () => {
    const reasoningInstance = await createServer([REASONING_FIXTURE], {
      port: 0,
      chunkSize: 10,
    });

    try {
      const mockStreamRes = await httpPost(`${reasoningInstance.url}/v1/chat/completions`, {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Think carefully" }],
        stream: true,
      });

      expect(mockStreamRes.status).toBe(200);

      const mockChunks = parseDataOnlySSE(mockStreamRes.body);
      expect(mockChunks.length, "Mock returned no SSE chunks").toBeGreaterThan(0);

      // ── Identify reasoning chunks vs content chunks ───────────────────
      type DeltaChunk = {
        choices: Array<{
          delta: { reasoning_content?: string; content?: string; role?: string };
          finish_reason: string | null;
        }>;
      };

      const reasoningChunks = mockChunks.filter(
        (c) => (c as DeltaChunk).choices?.[0]?.delta?.reasoning_content !== undefined,
      ) as DeltaChunk[];

      const contentChunks = mockChunks.filter(
        (c) =>
          (c as DeltaChunk).choices?.[0]?.delta?.content !== undefined &&
          (c as DeltaChunk).choices?.[0]?.delta?.content !== "",
      ) as DeltaChunk[];

      expect(reasoningChunks.length, "No reasoning chunks emitted").toBeGreaterThan(0);
      expect(contentChunks.length, "No content chunks emitted").toBeGreaterThan(0);

      // ── Validate reasoning chunk shape ────────────────────────────────
      for (const chunk of reasoningChunks) {
        const delta = chunk.choices[0].delta;
        expect(typeof delta.reasoning_content).toBe("string");
        // Reasoning chunks should NOT have content or role
        expect(delta.content).toBeUndefined();
        expect(delta.role).toBeUndefined();
        expect(chunk.choices[0].finish_reason).toBeNull();
      }

      // ── Reassemble reasoning text ─────────────────────────────────────
      const fullReasoning = reasoningChunks
        .map((c) => c.choices[0].delta.reasoning_content!)
        .join("");
      expect(fullReasoning).toBe("Let me think step by step about this problem.");

      // ── Reassemble content text ───────────────────────────────────────
      const fullContent = contentChunks.map((c) => c.choices[0].delta.content!).join("");
      expect(fullContent).toBe("The answer is 42.");

      // ── Shape triangulation on a reasoning chunk ──────────────────────
      const sdkChunkShape = openaiChatCompletionReasoningChunkShape();
      const mockChunkShape = extractShape(reasoningChunks[0]);

      const diffs = triangulate(sdkChunkShape, sdkChunkShape, mockChunkShape);
      const report = formatDriftReport(
        "OpenAI Chat (streaming reasoning chunks)",
        diffs,
        "openai-chat",
      );

      expect(
        diffs.filter((d) => d.severity === "critical"),
        report,
      ).toEqual([]);
    } finally {
      await new Promise<void>((r) => reasoningInstance.server.close(() => r()));
    }
  });

  it("reasoning chunks precede role chunk in stream order", async () => {
    const reasoningInstance = await createServer([REASONING_FIXTURE], {
      port: 0,
      chunkSize: 10,
    });

    try {
      const mockStreamRes = await httpPost(`${reasoningInstance.url}/v1/chat/completions`, {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Think carefully" }],
        stream: true,
      });

      const mockChunks = parseDataOnlySSE(mockStreamRes.body);

      type DeltaChunk = {
        choices: Array<{
          delta: { reasoning_content?: string; content?: string; role?: string };
          finish_reason: string | null;
        }>;
      };

      // Find indices of first/last reasoning and first role chunks
      const firstReasoningIdx = mockChunks.findIndex(
        (c) => (c as DeltaChunk).choices?.[0]?.delta?.reasoning_content !== undefined,
      );
      const firstRoleIdx = mockChunks.findIndex(
        (c) => (c as DeltaChunk).choices?.[0]?.delta?.role !== undefined,
      );
      const lastReasoningIdx = mockChunks.reduce(
        (last, c, i) =>
          (c as DeltaChunk).choices?.[0]?.delta?.reasoning_content !== undefined ? i : last,
        -1,
      );

      expect(firstReasoningIdx, "No reasoning chunk found").toBeGreaterThanOrEqual(0);
      expect(firstRoleIdx, "No role chunk found").toBeGreaterThanOrEqual(0);

      // All reasoning chunks must precede the role chunk
      expect(lastReasoningIdx, "Last reasoning chunk must come before the role chunk").toBeLessThan(
        firstRoleIdx,
      );

      // The finish chunk must be last
      const finishIdx = mockChunks.findIndex(
        (c) => (c as DeltaChunk).choices?.[0]?.finish_reason === "stop",
      );
      expect(finishIdx, "No finish chunk found").toBeGreaterThanOrEqual(0);
      expect(finishIdx).toBe(mockChunks.length - 1);
    } finally {
      await new Promise<void>((r) => reasoningInstance.server.close(() => r()));
    }
  });
});
