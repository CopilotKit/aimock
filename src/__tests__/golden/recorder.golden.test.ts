/**
 * Golden corpus: recorder and stream collapse (suite `recorder`).
 *
 * Two surfaces per upstream body:
 *   (a) the exported `collapse*` result on the canned raw stream, and
 *   (b) the fixture file aimock writes in record mode against a stub upstream
 *       serving that body (usage goes through `sanitizeRecordedUsage`).
 *
 * Anthropic and Bedrock results retain the upstream token and cache usage.
 * The `replaced-*` names mark goldens replaced when usage capture was enabled.
 * Every other golden stays byte-identical.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { encodeEventStreamFrame } from "../../aws-event-stream.js";
import {
  collapseAnthropicSSE,
  collapseBedrockEventStream,
  collapseOpenAISSE,
} from "../../stream-collapse.js";
import type { RecordProviderKey } from "../../types.js";
import {
  expectGolden,
  startGoldenServer,
  startStubUpstream,
  type GoldenServer,
} from "./harness.js";

const SUITE = "recorder";

// ─── Canned upstream bodies ─────────────────────────────────────────────────

/** Upstream `message_start.message.usage`: token counts plus cache keys. */
const ANTHROPIC_START_USAGE = {
  input_tokens: 20,
  output_tokens: 1,
  cache_read_input_tokens: 8,
  cache_creation_input_tokens: 4,
  cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 0 },
};

/** The ordered Anthropic stream events, with a chosen `message_delta.usage`. */
function anthropicEvents(deltaUsage: Record<string, unknown>): Array<Record<string, unknown>> {
  return [
    {
      type: "message_start",
      message: {
        id: "msg_upstream_fixed_1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: ANTHROPIC_START_USAGE,
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "toolu_fixed_1", name: "get_weather", input: {} },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"city":' },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '"Paris"}' },
    },
    { type: "content_block_stop", index: 1 },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: deltaUsage,
    },
    { type: "message_stop" },
  ];
}

/** Numeric `message_delta.usage` fields. */
const DELTA_USAGE = { output_tokens: 15, cache_read_input_tokens: 8 };
/** `message_delta.usage` with `input_tokens: null` (typed `number | null`). */
const DELTA_USAGE_NULL_INPUT = {
  output_tokens: 15,
  input_tokens: null,
  cache_read_input_tokens: 8,
};

function anthropicSSE(deltaUsage: Record<string, unknown>): string {
  return anthropicEvents(deltaUsage)
    .map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`)
    .join("");
}

/** Bedrock invoke-with-response-stream: each Claude event in a `chunk` frame. */
function bedrockEventStream(deltaUsage: Record<string, unknown>): Buffer {
  return Buffer.concat(
    anthropicEvents(deltaUsage).map((e) =>
      encodeEventStreamFrame(
        {
          ":event-type": "chunk",
          ":content-type": "application/json",
          ":message-type": "event",
        },
        Buffer.from(
          JSON.stringify({ bytes: Buffer.from(JSON.stringify(e)).toString("base64") }),
          "utf8",
        ),
      ),
    ),
  );
}

/** Non-stream Anthropic Messages body (also what Bedrock invoke returns). */
const ANTHROPIC_MESSAGE = JSON.stringify({
  id: "msg_upstream_fixed_2",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-4-5",
  content: [
    { type: "text", text: "Hello world" },
    { type: "tool_use", id: "toolu_fixed_2", name: "get_weather", input: { city: "Paris" } },
  ],
  stop_reason: "tool_use",
  stop_sequence: null,
  usage: { ...ANTHROPIC_START_USAGE, output_tokens: 15 },
});

/** OpenAI SSE: content deltas, finish chunk, then the empty-choices usage frame. */
const OPENAI_SSE = [
  {
    id: "chatcmpl-upstream-1",
    object: "chat.completion.chunk",
    created: 1700000000,
    model: "gpt-4o-mini",
    choices: [{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null }],
  },
  {
    id: "chatcmpl-upstream-1",
    object: "chat.completion.chunk",
    created: 1700000000,
    model: "gpt-4o-mini",
    choices: [{ index: 0, delta: { content: " world" }, finish_reason: null }],
  },
  {
    id: "chatcmpl-upstream-1",
    object: "chat.completion.chunk",
    created: 1700000000,
    model: "gpt-4o-mini",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  },
  {
    id: "chatcmpl-upstream-1",
    object: "chat.completion.chunk",
    created: 1700000000,
    model: "gpt-4o-mini",
    choices: [],
    usage: {
      prompt_tokens: 12,
      completion_tokens: 5,
      total_tokens: 17,
      prompt_tokens_details: { cached_tokens: 4, audio_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 2, accepted_prediction_tokens: 0 },
    },
  },
]
  .map((c) => `data: ${JSON.stringify(c)}\n\n`)
  .concat("data: [DONE]\n\n")
  .join("");

/** Non-stream OpenAI chat completion with usage breakdowns. */
const OPENAI_COMPLETION = JSON.stringify({
  id: "chatcmpl-upstream-2",
  object: "chat.completion",
  created: 1700000000,
  model: "gpt-4o-mini",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "Hello world" },
      finish_reason: "stop",
    },
  ],
  usage: {
    prompt_tokens: 12,
    completion_tokens: 5,
    total_tokens: 17,
    prompt_tokens_details: { cached_tokens: 4, audio_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 2 },
  },
});

/**
 * Non-stream OpenRouter completion. The usage mixes what the sanitizer keeps
 * (numbers, `is_byok`, numeric members of the breakdown objects) with what it
 * drops (a string member, a null, a string field, an unknown object).
 */
const OPENROUTER_COMPLETION = JSON.stringify({
  id: "gen-upstream-1",
  provider: "OpenAI",
  model: "openai/gpt-4o-mini",
  object: "chat.completion",
  created: 1700000000,
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "Hello world" },
      finish_reason: "stop",
      native_finish_reason: "stop",
    },
  ],
  usage: {
    prompt_tokens: 1234,
    completion_tokens: 567,
    total_tokens: 1801,
    cost: 0.0042,
    is_byok: false,
    cost_details: {
      upstream_inference_cost: 0.004,
      upstream_inference_prompt_cost: 0.001,
      upstream_inference_completions_cost: 0.003,
      label: "dropped",
    },
    prompt_tokens_details: { cached_tokens: 12, audio_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 34, image_tokens: null },
    native_tokens_prompt: 1200,
    native_tokens_completion: 550,
    native_tokens_reasoning: null,
    server_tool_use: { web_search_requests: 1 },
    provider_name: "OpenAI",
  },
});

// ─── Record-mode helper ─────────────────────────────────────────────────────

const tmpRoots: string[] = [];

afterAll(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

interface RecordCase {
  provider: RecordProviderKey;
  path: string;
  request: Record<string, unknown>;
  contentType: string;
  upstreamBody: string | Buffer;
}

/**
 * Streamed recordings carry `recordedTimings`, measured from the wall clock
 * per frame, so its numbers differ run to run and the harness does not cover
 * them. Replace each value with `"<ms>"` after checking it is a non-negative
 * integer. Key order and the number of inter-chunk delays (one per frame after
 * the first) stay pinned. Anything else in the file is left as written.
 */
function maskRecordedTimings(file: unknown): unknown {
  const fixtures = (file as { fixtures?: unknown }).fixtures;
  if (!Array.isArray(fixtures)) return file;
  const ms = (v: unknown): string => {
    expect(Number.isInteger(v) && (v as number) >= 0, `timing value ${String(v)}`).toBe(true);
    return "<ms>";
  };
  for (const fx of fixtures as Array<Record<string, unknown>>) {
    const t = fx.recordedTimings as Record<string, unknown> | undefined;
    if (t === undefined) continue;
    expect(Object.keys(t)).toEqual(["ttftMs", "interChunkDelaysMs", "totalDurationMs"]);
    expect(Array.isArray(t.interChunkDelaysMs)).toBe(true);
    fx.recordedTimings = {
      ttftMs: ms(t.ttftMs),
      interChunkDelaysMs: (t.interChunkDelaysMs as unknown[]).map(ms),
      totalDurationMs: ms(t.totalDurationMs),
    };
  }
  return file;
}

/** How long `recordOnce` waits for the recorder's fixture file to appear. */
const FIXTURE_WAIT_MS = 2000;

/**
 * Wait until `dir` holds a `.json` file, or `FIXTURE_WAIT_MS` passes, and
 * return the `.json` names. The recorder writes a temp file and renames it
 * into place, so a `.json` name is always a complete file. Waiting (instead
 * of reading once) keeps the check correct if the write ever lands after the
 * client sees the end of the response.
 */
async function waitForFixtureFiles(dir: string): Promise<string[]> {
  const deadline = Date.now() + FIXTURE_WAIT_MS;
  for (;;) {
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    if (files.length > 0 || Date.now() >= deadline) return files;
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * Run `body`, then every `cleanups` step (each even if an earlier one
 * fails). A failure in `body` is the error thrown; cleanup failures are
 * thrown only when `body` succeeded, and are otherwise appended to its
 * message so they are not lost.
 */
async function withCleanup<T>(
  body: () => Promise<T>,
  cleanups: Array<() => Promise<void> | undefined>,
): Promise<T> {
  let result: T | undefined;
  let primary: { err: unknown } | undefined;
  try {
    result = await body();
  } catch (err) {
    primary = { err };
  }
  const cleanupErrors: unknown[] = [];
  for (const step of cleanups) {
    try {
      await step();
    } catch (err) {
      cleanupErrors.push(err);
    }
  }
  if (primary) {
    if (cleanupErrors.length > 0 && primary.err instanceof Error) {
      primary.err.message += `\n(cleanup also failed: ${cleanupErrors.map(String).join("; ")})`;
    }
    throw primary.err;
  }
  if (cleanupErrors.length > 0) throw cleanupErrors[0];
  return result as T;
}

/**
 * Start a stub upstream serving `upstreamBody`, start aimock in record mode
 * against it with a fresh fixture dir, send one request, and return the one
 * fixture file aimock wrote (parsed, timings masked).
 */
async function recordOnce(c: RecordCase): Promise<unknown> {
  const fixturePath = mkdtempSync(join(tmpdir(), "aimock-golden-recorder-"));
  tmpRoots.push(fixturePath);
  const stub = await startStubUpstream((_req, res) => {
    res.writeHead(200, { "content-type": c.contentType });
    res.end(c.upstreamBody);
  });
  // Start the server inside `body` so the stub is closed even if it fails to start.
  let srv: GoldenServer | undefined;
  return withCleanup(async () => {
    srv = await startGoldenServer([], {
      record: { providers: { [c.provider]: stub.url }, fixturePath },
    });
    const res = await fetch(`${srv.url}${c.path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(c.request),
    });
    // Read the body before the status check so a failure reports aimock's error text.
    const text = await res.text();
    expect(res.status, text).toBe(200);
    expect(stub.requests).toHaveLength(1);
    const files = await waitForFixtureFiles(fixturePath);
    expect(files, `fixture files in ${fixturePath}`).toHaveLength(1);
    return maskRecordedTimings(JSON.parse(readFileSync(join(fixturePath, files[0]!), "utf8")));
  }, [() => srv?.close(), () => stub.close()]);
}

function anthropicRequest(stream: boolean, text: string): Record<string, unknown> {
  return {
    model: "claude-sonnet-4-5",
    max_tokens: 64,
    stream,
    messages: [{ role: "user", content: text }],
  };
}

function bedrockRequest(text: string): Record<string, unknown> {
  return {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 64,
    messages: [{ role: "user", content: text }],
  };
}

function openaiRequest(model: string, stream: boolean, text: string): Record<string, unknown> {
  return {
    model,
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    messages: [{ role: "user", content: text }],
  };
}

const BEDROCK_MODEL = "anthropic.claude-sonnet-4-5-v1";

// ─── (a) Collapse results ───────────────────────────────────────────────────

describe("collapse results", () => {
  it("replaced-collapse-anthropic-sse", () => {
    expectGolden(
      SUITE,
      "replaced-collapse-anthropic-sse",
      collapseAnthropicSSE(anthropicSSE(DELTA_USAGE)),
    );
  });

  it("replaced-collapse-anthropic-sse-delta-null-input", () => {
    expectGolden(
      SUITE,
      "replaced-collapse-anthropic-sse-delta-null-input",
      collapseAnthropicSSE(anthropicSSE(DELTA_USAGE_NULL_INPUT)),
    );
  });

  it("replaced-collapse-bedrock-event-stream", () => {
    expectGolden(
      SUITE,
      "replaced-collapse-bedrock-event-stream",
      collapseBedrockEventStream(bedrockEventStream(DELTA_USAGE)),
    );
  });

  it("replaced-collapse-bedrock-event-stream-delta-null-input", () => {
    expectGolden(
      SUITE,
      "replaced-collapse-bedrock-event-stream-delta-null-input",
      collapseBedrockEventStream(bedrockEventStream(DELTA_USAGE_NULL_INPUT)),
    );
  });

  it("collapse-openai-sse-usage", () => {
    expectGolden(SUITE, "collapse-openai-sse-usage", collapseOpenAISSE(OPENAI_SSE));
  });
});

// ─── (b) Recorded fixture files ─────────────────────────────────────────────

describe("recorded fixture files", () => {
  it("replaced-record-anthropic-stream", async () => {
    const file = await recordOnce({
      provider: "anthropic",
      path: "/v1/messages",
      request: anthropicRequest(true, "record anthropic stream"),
      contentType: "text/event-stream",
      upstreamBody: anthropicSSE(DELTA_USAGE),
    });
    expectGolden(SUITE, "replaced-record-anthropic-stream", file);
  });

  it("replaced-record-anthropic-stream-delta-null-input", async () => {
    const file = await recordOnce({
      provider: "anthropic",
      path: "/v1/messages",
      request: anthropicRequest(true, "record anthropic stream null input"),
      contentType: "text/event-stream",
      upstreamBody: anthropicSSE(DELTA_USAGE_NULL_INPUT),
    });
    expectGolden(SUITE, "replaced-record-anthropic-stream-delta-null-input", file);
  });

  it("replaced-record-anthropic-nonstream", async () => {
    const file = await recordOnce({
      provider: "anthropic",
      path: "/v1/messages",
      request: anthropicRequest(false, "record anthropic nonstream"),
      contentType: "application/json",
      upstreamBody: ANTHROPIC_MESSAGE,
    });
    expectGolden(SUITE, "replaced-record-anthropic-nonstream", file);
  });

  it("replaced-record-bedrock-invoke-stream", async () => {
    const file = await recordOnce({
      provider: "bedrock",
      path: `/model/${BEDROCK_MODEL}/invoke-with-response-stream`,
      request: bedrockRequest("record bedrock stream"),
      contentType: "application/vnd.amazon.eventstream",
      upstreamBody: bedrockEventStream(DELTA_USAGE),
    });
    expectGolden(SUITE, "replaced-record-bedrock-invoke-stream", file);
  });

  it("replaced-record-bedrock-invoke-nonstream", async () => {
    const file = await recordOnce({
      provider: "bedrock",
      path: `/model/${BEDROCK_MODEL}/invoke`,
      request: bedrockRequest("record bedrock nonstream"),
      contentType: "application/json",
      upstreamBody: ANTHROPIC_MESSAGE,
    });
    expectGolden(SUITE, "replaced-record-bedrock-invoke-nonstream", file);
  });

  it("record-openai-stream-usage", async () => {
    const file = await recordOnce({
      provider: "openai",
      path: "/v1/chat/completions",
      request: openaiRequest("gpt-4o-mini", true, "record openai stream"),
      contentType: "text/event-stream",
      upstreamBody: OPENAI_SSE,
    });
    expectGolden(SUITE, "record-openai-stream-usage", file);
  });

  it("record-openai-nonstream-usage", async () => {
    const file = await recordOnce({
      provider: "openai",
      path: "/v1/chat/completions",
      request: openaiRequest("gpt-4o-mini", false, "record openai nonstream"),
      contentType: "application/json",
      upstreamBody: OPENAI_COMPLETION,
    });
    expectGolden(SUITE, "record-openai-nonstream-usage", file);
  });

  it("record-openrouter-nonstream-cost", async () => {
    const file = await recordOnce({
      provider: "openrouter",
      path: "/api/v1/chat/completions",
      request: openaiRequest("openai/gpt-4o-mini", false, "record openrouter nonstream"),
      contentType: "application/json",
      upstreamBody: OPENROUTER_COMPLETION,
    });
    expectGolden(SUITE, "record-openrouter-nonstream-cost", file);
  });
});
