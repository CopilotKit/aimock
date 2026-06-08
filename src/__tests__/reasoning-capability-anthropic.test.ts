/**
 * Anthropic Messages API — model-capability-aware reasoning gating (aimock#254).
 *
 * aimock synthesizes a `thinking` channel whenever a fixture carries a
 * `reasoning` string. These tests assert the emission is now gated on the
 * REQUESTED model's reasoning capability:
 *   - reasoning-capable Claude model + reasoning fixture → emit thinking block
 *   - non-reasoning model + reasoning fixture, strict OFF → emit + logger.warn
 *   - non-reasoning model + reasoning fixture, strict ON  → suppress + logger.error
 *   - fixture without reasoning                           → no-op (no thinking, no log)
 *
 * Driven through `handleMessages` directly so the test owns the Logger (to spy
 * on warn/error) and a body-capturing mock response (to assert on the wire
 * payload for both streaming and non-streaming paths).
 */
import { describe, it, expect, vi } from "vitest";
import * as http from "node:http";
import { PassThrough } from "node:stream";
import type { Fixture, HandlerDefaults } from "../types.js";
import { handleMessages } from "../messages.js";
import { Journal } from "../journal.js";
import { Logger } from "../logger.js";

// --- helpers ---

const REASONING_TEXT = "Let me think step by step about this problem.";

const reasoningFixture: Fixture = {
  match: { userMessage: "think" },
  response: { content: "The answer is 42.", reasoning: REASONING_TEXT },
};

const plainFixture: Fixture = {
  match: { userMessage: "plain" },
  response: { content: "Just plain text." },
};

const CONTENT_TEXT = "I will call a tool.";

const contentWithToolsReasoningFixture: Fixture = {
  match: { userMessage: "tooled" },
  response: {
    content: CONTENT_TEXT,
    reasoning: REASONING_TEXT,
    toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
  },
};

const toolOnlyReasoningFixture: Fixture = {
  match: { userMessage: "toolonly" },
  response: {
    reasoning: REASONING_TEXT,
    toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
  },
};

const allFixtures: Fixture[] = [
  reasoningFixture,
  plainFixture,
  contentWithToolsReasoningFixture,
  toolOnlyReasoningFixture,
];

/** Mock ServerResponse that captures everything written to the body. */
function createCapturingRes(): { res: http.ServerResponse; getBody: () => string } {
  const res = new PassThrough() as unknown as http.ServerResponse;
  let ended = false;
  let body = "";
  const headers: Record<string, string> = {};
  res.setHeader = (name: string, value: string | number | readonly string[]) => {
    headers[name.toLowerCase()] = String(value);
    return res;
  };
  res.writeHead = ((statusCode: number, hdrs?: Record<string, string>) => {
    (res as { statusCode: number }).statusCode = statusCode;
    if (hdrs) {
      for (const [k, v] of Object.entries(hdrs)) headers[k.toLowerCase()] = v;
    }
    return res;
  }) as typeof res.writeHead;
  res.write = ((chunk: string | Buffer) => {
    body += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  }) as typeof res.write;
  res.end = ((...args: unknown[]) => {
    const chunk = args[0];
    if (typeof chunk === "string") body += chunk;
    else if (Buffer.isBuffer(chunk)) body += chunk.toString();
    ended = true;
    return res;
  }) as typeof res.end;
  Object.defineProperty(res, "writableEnded", { get: () => ended });
  res.destroy = () => {
    ended = true;
    return res;
  };
  return { res, getBody: () => body };
}

function makeReq(headers: http.IncomingHttpHeaders = {}): http.IncomingMessage {
  return {
    method: "POST",
    url: "/v1/messages",
    headers,
  } as unknown as http.IncomingMessage;
}

function makeDefaults(logger: Logger, strict?: boolean): HandlerDefaults {
  return { latency: 0, chunkSize: 10, replaySpeed: 0, logger, strict };
}

interface ClaudeContentBlock {
  type: string;
  thinking?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

/** Parse Claude SSE frames into their JSON `data:` payloads. */
function parseClaudeSSE(body: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const line of body.split("\n")) {
    if (line.startsWith("data: ")) {
      events.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
    }
  }
  return events;
}

async function run(
  bodyObj: object,
  defaults: HandlerDefaults,
  reqHeaders: http.IncomingHttpHeaders = {},
): Promise<string> {
  const { res, getBody } = createCapturingRes();
  await handleMessages(
    makeReq(reqHeaders),
    res,
    JSON.stringify(bodyObj),
    allFixtures,
    new Journal(),
    defaults,
    () => {},
  );
  return getBody();
}

function thinkingBlocks(jsonBody: string): ClaudeContentBlock[] {
  const parsed = JSON.parse(jsonBody) as { content: ClaudeContentBlock[] };
  return parsed.content.filter((b) => b.type === "thinking");
}

function streamThinkingDeltas(sseBody: string): string[] {
  return parseClaudeSSE(sseBody)
    .filter(
      (e) =>
        e.type === "content_block_delta" &&
        (e.delta as { type?: string } | undefined)?.type === "thinking_delta",
    )
    .map((e) => (e.delta as { thinking: string }).thinking);
}

/** All top-level content blocks (in order) from a non-streaming response. */
function contentBlocks(jsonBody: string): ClaudeContentBlock[] {
  return (JSON.parse(jsonBody) as { content: ClaudeContentBlock[] }).content;
}

/** `content_block_start` blocks from an SSE stream, ordered by their index. */
function streamStartedBlocks(sseBody: string): ClaudeContentBlock[] {
  return parseClaudeSSE(sseBody)
    .filter((e) => e.type === "content_block_start")
    .sort((a, b) => (a.index as number) - (b.index as number))
    .map((e) => e.content_block as ClaudeContentBlock);
}

/** Reassembled text from `text_delta` SSE events. */
function streamTextDeltas(sseBody: string): string {
  return parseClaudeSSE(sseBody)
    .filter(
      (e) =>
        e.type === "content_block_delta" &&
        (e.delta as { type?: string } | undefined)?.type === "text_delta",
    )
    .map((e) => (e.delta as { text: string }).text)
    .join("");
}

// ─── reasoning-capable Claude model → emit thinking ─────────────────────────

describe("Anthropic /v1/messages reasoning gating — capable model", () => {
  it("non-streaming: emits a thinking block, no warn/error", async () => {
    const logger = new Logger("warn");
    const warn = vi.spyOn(logger, "warn");
    const error = vi.spyOn(logger, "error");

    const body = await run(
      { model: "claude-opus-4", max_tokens: 1024, messages: [{ role: "user", content: "think" }] },
      makeDefaults(logger),
    );

    const blocks = thinkingBlocks(body);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].thinking).toBe(REASONING_TEXT);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("streaming: emits thinking_delta events, no warn/error", async () => {
    const logger = new Logger("warn");
    const warn = vi.spyOn(logger, "warn");
    const error = vi.spyOn(logger, "error");

    const body = await run(
      {
        model: "claude-opus-4",
        max_tokens: 1024,
        stream: true,
        messages: [{ role: "user", content: "think" }],
      },
      makeDefaults(logger),
    );

    expect(streamThinkingDeltas(body).join("")).toBe(REASONING_TEXT);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

// ─── non-reasoning model, strict OFF → emit + warn ──────────────────────────

describe("Anthropic /v1/messages reasoning gating — non-reasoning model, strict OFF", () => {
  it("non-streaming: still emits thinking but logs a warn naming the model", async () => {
    const logger = new Logger("warn");
    const warn = vi.spyOn(logger, "warn");
    const error = vi.spyOn(logger, "error");

    const body = await run(
      {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [{ role: "user", content: "think" }],
      },
      makeDefaults(logger, false),
    );

    expect(thinkingBlocks(body)).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.join(" ")).toContain("claude-3-5-sonnet-20241022");
    expect(error).not.toHaveBeenCalled();
  });

  it("streaming: still emits thinking deltas + a single warn", async () => {
    const logger = new Logger("warn");
    const warn = vi.spyOn(logger, "warn");
    const error = vi.spyOn(logger, "error");

    const body = await run(
      {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        stream: true,
        messages: [{ role: "user", content: "think" }],
      },
      makeDefaults(logger, false),
    );

    expect(streamThinkingDeltas(body).join("")).toBe(REASONING_TEXT);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });
});

// ─── non-reasoning model, strict ON → suppress + error ──────────────────────

describe("Anthropic /v1/messages reasoning gating — non-reasoning model, strict ON", () => {
  it("non-streaming: suppresses the thinking block and logs an error", async () => {
    const logger = new Logger("warn");
    const warn = vi.spyOn(logger, "warn");
    const error = vi.spyOn(logger, "error");

    const body = await run(
      {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [{ role: "user", content: "think" }],
      },
      makeDefaults(logger, true),
    );

    expect(thinkingBlocks(body)).toHaveLength(0);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.join(" ")).toContain("claude-3-5-sonnet-20241022");
    expect(warn).not.toHaveBeenCalled();
  });

  it("streaming: emits no thinking deltas and logs an error", async () => {
    const logger = new Logger("warn");
    const warn = vi.spyOn(logger, "warn");
    const error = vi.spyOn(logger, "error");

    const body = await run(
      {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        stream: true,
        messages: [{ role: "user", content: "think" }],
      },
      makeDefaults(logger, true),
    );

    expect(streamThinkingDeltas(body)).toHaveLength(0);
    expect(error).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("per-request X-AIMock-Strict header overrides a non-strict server (suppresses)", async () => {
    const logger = new Logger("warn");
    const error = vi.spyOn(logger, "error");

    const body = await run(
      {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [{ role: "user", content: "think" }],
      },
      makeDefaults(logger, false),
      { "x-aimock-strict": "true" },
    );

    expect(thinkingBlocks(body)).toHaveLength(0);
    expect(error).toHaveBeenCalledTimes(1);
  });
});

// ─── fixture without reasoning → no-op ──────────────────────────────────────

describe("Anthropic /v1/messages reasoning gating — no fixture reasoning", () => {
  it("non-reasoning model + no reasoning: no thinking block, no log (even strict)", async () => {
    const logger = new Logger("warn");
    const warn = vi.spyOn(logger, "warn");
    const error = vi.spyOn(logger, "error");

    const body = await run(
      {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [{ role: "user", content: "plain" }],
      },
      makeDefaults(logger, true),
    );

    expect(thinkingBlocks(body)).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

// ─── unknown model → fail open (emit) ───────────────────────────────────────

describe("Anthropic /v1/messages reasoning gating — unknown model", () => {
  it("unknown model + reasoning fixture: emits thinking, no warn (even strict)", async () => {
    const logger = new Logger("warn");
    const warn = vi.spyOn(logger, "warn");
    const error = vi.spyOn(logger, "error");

    const body = await run(
      {
        model: "some-future-claude",
        max_tokens: 1024,
        messages: [{ role: "user", content: "think" }],
      },
      makeDefaults(logger, true),
    );

    expect(thinkingBlocks(body)).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

// ─── content + toolCalls branch → gating on the combined-output path ─────────
//
// The content-with-tool-calls dispatch synthesizes thinking from the same
// `reasoning` field, but through a separate code path. These cases assert the
// capability gate is wired there too: the thinking block is gated while the
// text content and tool_use blocks always survive, in order.

describe("Anthropic /v1/messages reasoning gating — content+toolCalls, strict ON suppresses", () => {
  it("non-streaming: suppresses thinking, keeps text + tool_use in order", async () => {
    const logger = new Logger("warn");
    const warn = vi.spyOn(logger, "warn");
    const error = vi.spyOn(logger, "error");

    const body = await run(
      {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [{ role: "user", content: "tooled" }],
      },
      makeDefaults(logger, true),
    );

    const blocks = contentBlocks(body);
    expect(blocks.filter((b) => b.type === "thinking")).toHaveLength(0);

    // text content + tool_use both intact, and correctly ordered (text first).
    const text = blocks.find((b) => b.type === "text");
    const toolUse = blocks.find((b) => b.type === "tool_use");
    expect(text?.text).toBe(CONTENT_TEXT);
    expect(toolUse?.name).toBe("get_weather");
    expect(toolUse?.input).toEqual({ city: "NYC" });
    expect(blocks.findIndex((b) => b.type === "text")).toBeLessThan(
      blocks.findIndex((b) => b.type === "tool_use"),
    );

    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.join(" ")).toContain("claude-3-5-sonnet-20241022");
    expect(warn).not.toHaveBeenCalled();
  });

  it("streaming: emits no thinking deltas, keeps text + tool_use blocks in order", async () => {
    const logger = new Logger("warn");
    const warn = vi.spyOn(logger, "warn");
    const error = vi.spyOn(logger, "error");

    const body = await run(
      {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        stream: true,
        messages: [{ role: "user", content: "tooled" }],
      },
      makeDefaults(logger, true),
    );

    expect(streamThinkingDeltas(body)).toHaveLength(0);

    const started = streamStartedBlocks(body);
    expect(started.some((b) => b.type === "thinking")).toBe(false);
    expect(started.map((b) => b.type)).toEqual(["text", "tool_use"]);
    expect(streamTextDeltas(body)).toBe(CONTENT_TEXT);
    expect(started.find((b) => b.type === "tool_use")?.name).toBe("get_weather");

    expect(error).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("Anthropic /v1/messages reasoning gating — content+toolCalls, capable model emits", () => {
  it("non-streaming: emits thinking, keeps text + tool_use in order", async () => {
    const logger = new Logger("warn");
    const warn = vi.spyOn(logger, "warn");
    const error = vi.spyOn(logger, "error");

    const body = await run(
      {
        model: "claude-opus-4",
        max_tokens: 1024,
        messages: [{ role: "user", content: "tooled" }],
      },
      makeDefaults(logger),
    );

    const blocks = contentBlocks(body);
    const thinking = blocks.filter((b) => b.type === "thinking");
    expect(thinking).toHaveLength(1);
    expect(thinking[0].thinking).toBe(REASONING_TEXT);

    const text = blocks.find((b) => b.type === "text");
    const toolUse = blocks.find((b) => b.type === "tool_use");
    expect(text?.text).toBe(CONTENT_TEXT);
    expect(toolUse?.name).toBe("get_weather");
    expect(toolUse?.input).toEqual({ city: "NYC" });

    // Order: thinking → text → tool_use.
    expect(blocks.map((b) => b.type)).toEqual(["thinking", "text", "tool_use"]);

    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("streaming: emits thinking deltas, keeps text + tool_use blocks in order", async () => {
    const logger = new Logger("warn");
    const warn = vi.spyOn(logger, "warn");
    const error = vi.spyOn(logger, "error");

    const body = await run(
      {
        model: "claude-opus-4",
        max_tokens: 1024,
        stream: true,
        messages: [{ role: "user", content: "tooled" }],
      },
      makeDefaults(logger),
    );

    expect(streamThinkingDeltas(body).join("")).toBe(REASONING_TEXT);

    const started = streamStartedBlocks(body);
    expect(started.map((b) => b.type)).toEqual(["thinking", "text", "tool_use"]);
    expect(streamTextDeltas(body)).toBe(CONTENT_TEXT);
    expect(started.find((b) => b.type === "tool_use")?.name).toBe("get_weather");

    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

// ─── tool-only branch → gating on the pure-tool-call path ────────────────────
//
// aimock#253 newly synthesized a leading thinking block on the pure-tool-call
// dispatch (no text content) so a replayed tool-only turn under extended
// thinking does not self-trip `missing_thinking_first`. aimock#254's capability
// gate never covered that path (it didn't emit reasoning at #254's time). These
// cases lock in that the gate now applies there too: a non-reasoning model under
// strict SUPPRESSES the thinking block, a capable model EMITS it — while the
// tool_use block always survives. (Red without the `resolveReasoningForModel`
// routing: raw `response.reasoning` would emit the thinking block unconditionally.)

describe("Anthropic /v1/messages reasoning gating — tool-only, strict ON suppresses", () => {
  it("non-streaming: suppresses thinking, keeps tool_use", async () => {
    const logger = new Logger("warn");
    const warn = vi.spyOn(logger, "warn");
    const error = vi.spyOn(logger, "error");

    const body = await run(
      {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [{ role: "user", content: "toolonly" }],
      },
      makeDefaults(logger, true),
    );

    const blocks = contentBlocks(body);
    expect(blocks.filter((b) => b.type === "thinking")).toHaveLength(0);

    const toolUse = blocks.find((b) => b.type === "tool_use");
    expect(toolUse?.name).toBe("get_weather");
    expect(toolUse?.input).toEqual({ city: "NYC" });

    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.join(" ")).toContain("claude-3-5-sonnet-20241022");
    expect(warn).not.toHaveBeenCalled();
  });

  it("streaming: emits no thinking deltas, keeps tool_use block", async () => {
    const logger = new Logger("warn");
    const warn = vi.spyOn(logger, "warn");
    const error = vi.spyOn(logger, "error");

    const body = await run(
      {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        stream: true,
        messages: [{ role: "user", content: "toolonly" }],
      },
      makeDefaults(logger, true),
    );

    expect(streamThinkingDeltas(body)).toHaveLength(0);

    const started = streamStartedBlocks(body);
    expect(started.some((b) => b.type === "thinking")).toBe(false);
    expect(started.map((b) => b.type)).toEqual(["tool_use"]);
    expect(started.find((b) => b.type === "tool_use")?.name).toBe("get_weather");

    expect(error).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("Anthropic /v1/messages reasoning gating — tool-only, capable model emits", () => {
  it("non-streaming: emits thinking, keeps tool_use in order", async () => {
    const logger = new Logger("warn");
    const warn = vi.spyOn(logger, "warn");
    const error = vi.spyOn(logger, "error");

    const body = await run(
      {
        model: "claude-opus-4",
        max_tokens: 1024,
        messages: [{ role: "user", content: "toolonly" }],
      },
      makeDefaults(logger),
    );

    const blocks = contentBlocks(body);
    const thinking = blocks.filter((b) => b.type === "thinking");
    expect(thinking).toHaveLength(1);
    expect(thinking[0].thinking).toBe(REASONING_TEXT);

    const toolUse = blocks.find((b) => b.type === "tool_use");
    expect(toolUse?.name).toBe("get_weather");
    expect(toolUse?.input).toEqual({ city: "NYC" });

    // Order: thinking → tool_use.
    expect(blocks.map((b) => b.type)).toEqual(["thinking", "tool_use"]);

    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("streaming: emits thinking deltas, keeps tool_use block in order", async () => {
    const logger = new Logger("warn");
    const warn = vi.spyOn(logger, "warn");
    const error = vi.spyOn(logger, "error");

    const body = await run(
      {
        model: "claude-opus-4",
        max_tokens: 1024,
        stream: true,
        messages: [{ role: "user", content: "toolonly" }],
      },
      makeDefaults(logger),
    );

    expect(streamThinkingDeltas(body).join("")).toBe(REASONING_TEXT);

    const started = streamStartedBlocks(body);
    expect(started.map((b) => b.type)).toEqual(["thinking", "tool_use"]);
    expect(started.find((b) => b.type === "tool_use")?.name).toBe("get_weather");

    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
