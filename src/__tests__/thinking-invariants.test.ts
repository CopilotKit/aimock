import { describe, it, expect, afterEach, vi } from "vitest";
import * as http from "node:http";
import type { Fixture } from "../types.js";
import { createServer, type ServerInstance } from "../server.js";
import {
  validateThinkingInvariants,
  handleMessages,
  claudeToCompletionRequest,
} from "../messages.js";
import { Journal } from "../journal.js";
import { Logger } from "../logger.js";
import { createMockRes, createDefaults } from "./helpers/mock-res.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function post(
  url: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function parseClaudeSSEEvents(body: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const line of body.split("\n")) {
    if (line.startsWith("data: ")) {
      events.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Request builders
// ---------------------------------------------------------------------------

const ENABLED = { type: "enabled" as const, budget_tokens: 1024 };

// A well-formed in-scope continuation: assistant turn leads with a thinking
// block + signature, carries a tool_use, and the next user turn answers it.
function continuationRequest(opts: {
  thinking?: unknown;
  // The assistant turn's content blocks (the in-scope turn at index 1).
  assistantContent: unknown;
  // Whether to append a user tool_result turn answering tool_use id "tu_1".
  answer?: boolean;
}): Record<string, unknown> {
  const messages: unknown[] = [
    { role: "user", content: "What is the weather?" },
    { role: "assistant", content: opts.assistantContent },
  ];
  if (opts.answer !== false) {
    messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu_1", content: "Sunny" }],
    });
  }
  return {
    model: "claude-3-7-sonnet-20250219",
    max_tokens: 1024,
    ...(opts.thinking !== undefined ? { thinking: opts.thinking } : {}),
    messages,
  };
}

const validThinkingBlock = { type: "thinking", thinking: "Let me check.", signature: "sig-abc" };
const toolUseBlock = { type: "tool_use", id: "tu_1", name: "get_weather", input: { city: "NYC" } };

// ---------------------------------------------------------------------------
// 8.1 Pure-helper unit tests
// ---------------------------------------------------------------------------

describe("validateThinkingInvariants (pure helper)", () => {
  it("U1: thinking disabled (no thinking field) → null", () => {
    const req = continuationRequest({ assistantContent: [toolUseBlock] });
    expect(validateThinkingInvariants(req as never)).toBeNull();
  });

  it("U2: thinking.type disabled → null", () => {
    const req = continuationRequest({
      thinking: { type: "disabled" },
      assistantContent: [toolUseBlock],
    });
    expect(validateThinkingInvariants(req as never)).toBeNull();
  });

  it("U3: malformed thinking (true) → null", () => {
    const req = continuationRequest({ thinking: true, assistantContent: [toolUseBlock] });
    expect(validateThinkingInvariants(req as never)).toBeNull();
  });

  it("U4: malformed thinking ({}) → null", () => {
    const req = continuationRequest({ thinking: {}, assistantContent: [toolUseBlock] });
    expect(validateThinkingInvariants(req as never)).toBeNull();
  });

  it("U5: enabled, single user turn only → null", () => {
    const req = {
      model: "claude-3-7-sonnet-20250219",
      max_tokens: 1024,
      thinking: ENABLED,
      messages: [{ role: "user", content: "hello" }],
    };
    expect(validateThinkingInvariants(req as never)).toBeNull();
  });

  it("U6: enabled, in-scope turn leads with valid thinking + signature → null", () => {
    const req = continuationRequest({
      thinking: ENABLED,
      assistantContent: [validThinkingBlock, toolUseBlock],
    });
    expect(validateThinkingInvariants(req as never)).toBeNull();
  });

  it("U7: enabled, text-only assistant turn (no tool_use) → null (exempt)", () => {
    const req = continuationRequest({
      thinking: ENABLED,
      assistantContent: [{ type: "text", text: "Final answer." }],
      answer: false,
    });
    expect(validateThinkingInvariants(req as never)).toBeNull();
  });

  it("U8: enabled, tool_use turn answered, leads with text → missing_thinking_first", () => {
    const req = continuationRequest({
      thinking: ENABLED,
      assistantContent: [{ type: "text", text: "thinking..." }, toolUseBlock],
    });
    expect(validateThinkingInvariants(req as never)).toEqual({
      kind: "missing_thinking_first",
      messageIndex: 1,
      observedFirstBlockType: "text",
    });
  });

  it("U9: enabled, first block is tool_use (reasoning dropped) → missing_thinking_first", () => {
    const req = continuationRequest({
      thinking: ENABLED,
      assistantContent: [toolUseBlock],
    });
    expect(validateThinkingInvariants(req as never)).toEqual({
      kind: "missing_thinking_first",
      messageIndex: 1,
      observedFirstBlockType: "tool_use",
    });
  });

  it("U10: enabled, trailing unanswered tool_use (no tool_result) → null (out of scope)", () => {
    const req = continuationRequest({
      thinking: ENABLED,
      assistantContent: [toolUseBlock],
      answer: false,
    });
    expect(validateThinkingInvariants(req as never)).toBeNull();
  });

  it("U11: enabled, leading thinking with empty signature → missing_signature", () => {
    const req = continuationRequest({
      thinking: ENABLED,
      assistantContent: [{ type: "thinking", thinking: "x", signature: "" }, toolUseBlock],
    });
    expect(validateThinkingInvariants(req as never)).toEqual({
      kind: "missing_signature",
      messageIndex: 1,
    });
  });

  it("U12: enabled, leading thinking with missing signature → missing_signature", () => {
    const req = continuationRequest({
      thinking: ENABLED,
      assistantContent: [{ type: "thinking", thinking: "x" }, toolUseBlock],
    });
    expect(validateThinkingInvariants(req as never)).toEqual({
      kind: "missing_signature",
      messageIndex: 1,
    });
  });

  it("U13: enabled, leading redacted_thinking with non-empty data → null", () => {
    const req = continuationRequest({
      thinking: ENABLED,
      assistantContent: [{ type: "redacted_thinking", data: "encrypted" }, toolUseBlock],
    });
    expect(validateThinkingInvariants(req as never)).toBeNull();
  });

  it("U14: enabled, in-scope leading redacted_thinking with missing data → dropped_redacted_thinking", () => {
    const req = continuationRequest({
      thinking: ENABLED,
      assistantContent: [{ type: "redacted_thinking" }, toolUseBlock],
    });
    expect(validateThinkingInvariants(req as never)).toEqual({
      kind: "dropped_redacted_thinking",
      messageIndex: 1,
    });
  });

  it("U14b: enabled, out-of-scope redacted_thinking with empty data → null (boundary guard)", () => {
    const req = continuationRequest({
      thinking: ENABLED,
      assistantContent: [{ type: "redacted_thinking", data: "" }, toolUseBlock],
      answer: false,
    });
    expect(validateThinkingInvariants(req as never)).toBeNull();
  });

  it("U14c: enabled, in-scope leading redacted_thinking with empty-string data → dropped_redacted_thinking", () => {
    // Exercises the empty-string `data` case of invariant (c) on an in-scope
    // turn. U14 covers `data` undefined (missing); this covers the empty-string
    // case. Both the current `length === 0` guard and a `!first.data` guard
    // satisfy this — it documents the empty-string intent, it does not
    // discriminate between those implementations.
    const req = continuationRequest({
      thinking: ENABLED,
      assistantContent: [{ type: "redacted_thinking", data: "" }, toolUseBlock],
    });
    expect(validateThinkingInvariants(req as never)).toEqual({
      kind: "dropped_redacted_thinking",
      messageIndex: 1,
    });
  });

  it("U15: enabled, two in-scope turns, first valid, second drops thinking → reports second", () => {
    const req = {
      model: "claude-3-7-sonnet-20250219",
      max_tokens: 1024,
      thinking: ENABLED,
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [validThinkingBlock, { ...toolUseBlock, id: "tu_1" }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "tu_2", name: "f", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_2", content: "ok" }] },
      ],
    };
    expect(validateThinkingInvariants(req as never)).toEqual({
      kind: "missing_thinking_first",
      messageIndex: 3,
      observedFirstBlockType: "tool_use",
    });
  });

  it("U16: enabled, two in-scope turns, first drops thinking, second valid → reports first (bug #2)", () => {
    const req = {
      model: "claude-3-7-sonnet-20250219",
      max_tokens: 1024,
      thinking: ENABLED,
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "f", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }] },
        {
          role: "assistant",
          content: [validThinkingBlock, { type: "tool_use", id: "tu_2", name: "f", input: {} }],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_2", content: "ok" }] },
      ],
    };
    expect(validateThinkingInvariants(req as never)).toEqual({
      kind: "missing_thinking_first",
      messageIndex: 1,
      observedFirstBlockType: "tool_use",
    });
  });

  it("U17: enabled, assistant turn with string content → null (exempt)", () => {
    const req = continuationRequest({
      thinking: ENABLED,
      assistantContent: "I will look that up.",
    });
    expect(validateThinkingInvariants(req as never)).toBeNull();
  });

  it("U18: enabled, assistant turn with empty array content → null (exempt)", () => {
    const req = continuationRequest({ thinking: ENABLED, assistantContent: [] });
    expect(validateThinkingInvariants(req as never)).toBeNull();
  });

  it("U19: enabled, tool_result on user turn, assistant turns valid → null", () => {
    const req = {
      model: "claude-3-7-sonnet-20250219",
      max_tokens: 1024,
      thinking: ENABLED,
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [validThinkingBlock, { ...toolUseBlock, id: "tu_1" }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }] },
      ],
    };
    expect(validateThinkingInvariants(req as never)).toBeNull();
  });

  // Malformed-input crash guards: `req.messages` comes from untrusted
  // JSON.parse, so message entries and content blocks may be null / non-object.
  // The validator must not throw on them.

  it("U20: enabled, messages contains a null entry → null (no throw)", () => {
    const req = {
      model: "claude-3-7-sonnet-20250219",
      max_tokens: 1024,
      thinking: ENABLED,
      messages: [null],
    };
    expect(() => validateThinkingInvariants(req as never)).not.toThrow();
    expect(validateThinkingInvariants(req as never)).toBeNull();
  });

  it("U21: enabled, messages contains a non-object (string) entry → null (no throw)", () => {
    const req = {
      model: "claude-3-7-sonnet-20250219",
      max_tokens: 1024,
      thinking: ENABLED,
      messages: ["foo"],
    };
    expect(() => validateThinkingInvariants(req as never)).not.toThrow();
    expect(validateThinkingInvariants(req as never)).toBeNull();
  });

  it("U22: enabled, in-scope assistant turn whose content leads with null → missing_thinking_first (no throw)", () => {
    const req = continuationRequest({
      thinking: ENABLED,
      assistantContent: [null, toolUseBlock],
    });
    expect(() => validateThinkingInvariants(req as never)).not.toThrow();
    expect(validateThinkingInvariants(req as never)).toEqual({
      kind: "missing_thinking_first",
      messageIndex: 1,
      observedFirstBlockType: undefined,
    });
  });

  it("U23: enabled, in-scope assistant turn whose content leads with a string block → missing_thinking_first (no throw)", () => {
    const req = continuationRequest({
      thinking: ENABLED,
      assistantContent: ["x", toolUseBlock],
    });
    expect(() => validateThinkingInvariants(req as never)).not.toThrow();
    expect(validateThinkingInvariants(req as never)).toEqual({
      kind: "missing_thinking_first",
      messageIndex: 1,
      observedFirstBlockType: undefined,
    });
  });
});

// ---------------------------------------------------------------------------
// 8.2 Integration tests — strict ON
// ---------------------------------------------------------------------------

describe("thinking invariants — strict ON integration", () => {
  let server: ServerInstance;
  // A fixture that answers any continuation (matches the tool_result turn).
  const continuationFixture: Fixture = {
    match: { toolCallId: "tu_1" },
    response: { content: "It is sunny." },
  };
  const textFixture: Fixture = {
    match: { userMessage: "Final answer please" },
    response: { content: "Done." },
  };

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server.server.close(() => r()));
  });

  it("I1: valid thinking continuation + matching fixture → 200", async () => {
    server = await createServer([continuationFixture], { port: 0, strict: true });
    const res = await post(
      `${server.url}/v1/messages`,
      continuationRequest({
        thinking: ENABLED,
        assistantContent: [validThinkingBlock, toolUseBlock],
      }),
    );
    expect(res.status).toBe(200);
  });

  it("I2: text-only assistant turn (exempt) + matching fixture → 200, no false 400", async () => {
    server = await createServer([textFixture], { port: 0, strict: true });
    const res = await post(`${server.url}/v1/messages`, {
      model: "claude-3-7-sonnet-20250219",
      max_tokens: 1024,
      thinking: ENABLED,
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "text", text: "answer" }] },
        { role: "user", content: "Final answer please" },
      ],
    });
    expect(res.status).toBe(200);
  });

  it("I3: in-scope continuation turn missing thinking block → 400 invalid_request_error", async () => {
    server = await createServer([continuationFixture], { port: 0, strict: true });
    const res = await post(
      `${server.url}/v1/messages`,
      continuationRequest({ thinking: ENABLED, assistantContent: [toolUseBlock] }),
    );
    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toMatch(/content\.0.*must begin with a `thinking` block/);
    const entries = server.journal.getAll();
    expect(entries[entries.length - 1].response.status).toBe(400);
    expect(entries[entries.length - 1].response.fixture).toBeNull();
  });

  it("I4: leading thinking with empty signature → 400 mentioning signature", async () => {
    server = await createServer([continuationFixture], { port: 0, strict: true });
    const res = await post(
      `${server.url}/v1/messages`,
      continuationRequest({
        thinking: ENABLED,
        assistantContent: [{ type: "thinking", thinking: "x", signature: "" }, toolUseBlock],
      }),
    );
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error.message).toMatch(/signature/);
  });

  it("I5: leading redacted_thinking with dropped data → 400 mentioning redacted_thinking/data", async () => {
    server = await createServer([continuationFixture], { port: 0, strict: true });
    const res = await post(
      `${server.url}/v1/messages`,
      continuationRequest({
        thinking: ENABLED,
        assistantContent: [{ type: "redacted_thinking" }, toolUseBlock],
      }),
    );
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error.message).toMatch(/redacted_thinking.*data/);
  });

  it("I6: strict via X-AIMock-Strict header (server default off) → 400 + strictOverride", async () => {
    server = await createServer([continuationFixture], { port: 0 });
    const res = await post(
      `${server.url}/v1/messages`,
      continuationRequest({ thinking: ENABLED, assistantContent: [toolUseBlock] }),
      { "X-AIMock-Strict": "true" },
    );
    expect(res.status).toBe(400);
    const entries = server.journal.getAll();
    expect(entries[entries.length - 1].response.strictOverride).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8.3 Integration tests — strict OFF (backward compat) + warn-spy
// ---------------------------------------------------------------------------

describe("thinking invariants — strict OFF backward compat", () => {
  const continuationFixture: Fixture = {
    match: { toolCallId: "tu_1" },
    response: { content: "It is sunny." },
  };

  it("B1: strict OFF + violation + matching fixture → 200 replay + warn fires", async () => {
    const journal = new Journal();
    const logger = new Logger("warn");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const defaults = createDefaults({ chunkSize: 10, logger, strict: false });
      const mockReq = {
        method: "POST",
        url: "/v1/messages",
        headers: {},
      } as unknown as http.IncomingMessage;
      const mockRes = createMockRes();
      await handleMessages(
        mockReq,
        mockRes,
        JSON.stringify(
          continuationRequest({ thinking: ENABLED, assistantContent: [toolUseBlock] }),
        ),
        [continuationFixture],
        journal,
        defaults,
        () => {},
      );
      expect(journal.getLast()!.response.status).toBe(200);
      expect(warnSpy).toHaveBeenCalled();
      const warned = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(warned).toMatch(/THINKING/);
      expect(warned).toMatch(/strict off/);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("B2: strict OFF + thinking disabled → no warn (validator short-circuits)", async () => {
    const journal = new Journal();
    const logger = new Logger("warn");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const defaults = createDefaults({ chunkSize: 10, logger, strict: false });
      const mockReq = {
        method: "POST",
        url: "/v1/messages",
        headers: {},
      } as unknown as http.IncomingMessage;
      const mockRes = createMockRes();
      await handleMessages(
        mockReq,
        mockRes,
        JSON.stringify(continuationRequest({ assistantContent: [toolUseBlock] })),
        [continuationFixture],
        journal,
        defaults,
        () => {},
      );
      expect(journal.getLast()!.response.status).toBe(200);
      const warned = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(warned).not.toMatch(/THINKING/);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("B3: header X-AIMock-Strict false overriding server strict:true + violation → 200 + warn", async () => {
    const journal = new Journal();
    const logger = new Logger("warn");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const defaults = createDefaults({ chunkSize: 10, logger, strict: true });
      const mockReq = {
        method: "POST",
        url: "/v1/messages",
        headers: { "x-aimock-strict": "false" },
      } as unknown as http.IncomingMessage;
      const mockRes = createMockRes();
      await handleMessages(
        mockReq,
        mockRes,
        JSON.stringify(
          continuationRequest({ thinking: ENABLED, assistantContent: [toolUseBlock] }),
        ),
        [continuationFixture],
        journal,
        defaults,
        () => {},
      );
      expect(journal.getLast()!.response.status).toBe(200);
      const warned = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(warned).toMatch(/THINKING/);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// 8.4 Emit-side round-trip regression (OQ3)
// ---------------------------------------------------------------------------

describe("emit-side placeholder signature round-trip", () => {
  let server: ServerInstance;
  // Fixture that emits a thinking block (reasoning present) on the first turn.
  const reasoningFixture: Fixture = {
    match: { userMessage: "What is the weather?" },
    response: { content: "Let me check.", reasoning: "I should call the weather tool." },
  };
  const continuationFixture: Fixture = {
    match: { toolCallId: "tu_1" },
    response: { content: "It is sunny." },
  };

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server.server.close(() => r()));
  });

  it("RT1: emitted placeholder signature replays into a strict continuation → 200", async () => {
    server = await createServer([reasoningFixture, continuationFixture], { port: 0, strict: true });

    // First turn: streaming, captures the emitted thinking block's signature.
    const first = await post(`${server.url}/v1/messages`, {
      model: "claude-3-7-sonnet-20250219",
      max_tokens: 1024,
      thinking: ENABLED,
      stream: true,
      messages: [{ role: "user", content: "What is the weather?" }],
    });
    expect(first.status).toBe(200);
    const events = parseClaudeSSEEvents(first.body);
    // The thinking `content_block_start` carries an empty signature (mirrors
    // real Anthropic); the signature arrives only via `signature_delta`.
    const thinkingStart = events.find(
      (e) =>
        e.type === "content_block_start" &&
        (e.content_block as { type?: string } | undefined)?.type === "thinking",
    );
    expect((thinkingStart?.content_block as { signature?: string } | undefined)?.signature).toBe(
      "",
    );
    // Assembled signature is the signature_delta value, not the start placeholder.
    const sigDelta = events.find(
      (e) =>
        e.type === "content_block_delta" &&
        (e.delta as { type?: string } | undefined)?.type === "signature_delta",
    );
    const signature = (sigDelta?.delta as { signature?: string } | undefined)?.signature;
    expect(signature).toBe("aimock-placeholder-signature");

    // Replay the captured thinking block back into a strict continuation.
    const cont = await post(`${server.url}/v1/messages`, {
      model: "claude-3-7-sonnet-20250219",
      max_tokens: 1024,
      thinking: ENABLED,
      messages: [
        { role: "user", content: "What is the weather?" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "I should call the weather tool.", signature },
            toolUseBlock,
          ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "Sunny" }] },
      ],
    });
    expect(cont.status).toBe(200);
  });

  it("RT2: non-streaming assembled thinking block carries the non-empty placeholder", async () => {
    server = await createServer([reasoningFixture], { port: 0 });
    const res = await post(`${server.url}/v1/messages`, {
      model: "claude-3-7-sonnet-20250219",
      max_tokens: 1024,
      thinking: ENABLED,
      messages: [{ role: "user", content: "What is the weather?" }],
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { content: Array<{ type: string; signature?: string }> };
    const thinkingBlock = body.content.find((b) => b.type === "thinking");
    expect(thinkingBlock?.signature).toBe("aimock-placeholder-signature");
  });
});

// ---------------------------------------------------------------------------
// 8.5 Tool-call-only thinking emission (parity with content+tool path)
//
// A pure-tool-call fixture WITH `reasoning` must emit a leading thinking block
// exactly as the content+tool path does — streaming (content_block_start
// thinking signature "", signature_delta = placeholder) and non-streaming
// (content[0] is the thinking block). Without it, replaying aimock's own
// tool-only-with-thinking turn into a strict continuation self-trips
// `missing_thinking_first`.
// ---------------------------------------------------------------------------

describe("tool-call-only thinking emission", () => {
  let server: ServerInstance;
  // Pure tool-call fixture WITH reasoning — no `content` field, so this routes
  // through the isToolCallResponse branch (not content+tool).
  const toolOnlyReasoningFixture: Fixture = {
    match: { userMessage: "What is the weather?" },
    response: {
      toolCalls: [{ id: "tu_1", name: "get_weather", arguments: '{"city":"NYC"}' }],
      reasoning: "I should call the weather tool.",
    },
  };
  const continuationFixture: Fixture = {
    match: { toolCallId: "tu_1" },
    response: { content: "It is sunny." },
  };

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server.server.close(() => r()));
  });

  it("T1: streaming tool-only + reasoning → leading thinking block, tool_use shifted to index 1", async () => {
    server = await createServer([toolOnlyReasoningFixture], { port: 0 });
    const res = await post(`${server.url}/v1/messages`, {
      model: "claude-3-7-sonnet-20250219",
      max_tokens: 1024,
      thinking: ENABLED,
      stream: true,
      messages: [{ role: "user", content: "What is the weather?" }],
    });
    expect(res.status).toBe(200);
    const events = parseClaudeSSEEvents(res.body);

    // Leading thinking block: content_block_start at index 0 with empty signature.
    const thinkingStart = events.find(
      (e) =>
        e.type === "content_block_start" &&
        (e.content_block as { type?: string } | undefined)?.type === "thinking",
    );
    expect(thinkingStart).toBeTruthy();
    expect(thinkingStart!.index).toBe(0);
    expect((thinkingStart!.content_block as { signature?: string }).signature).toBe("");

    // signature_delta carries the placeholder.
    const sigDelta = events.find(
      (e) =>
        e.type === "content_block_delta" &&
        (e.delta as { type?: string } | undefined)?.type === "signature_delta",
    );
    expect((sigDelta?.delta as { signature?: string } | undefined)?.signature).toBe(
      "aimock-placeholder-signature",
    );

    // tool_use block intact, shifted to index 1 by the prepended thinking block.
    const toolStart = events.find(
      (e) =>
        e.type === "content_block_start" &&
        (e.content_block as { type?: string } | undefined)?.type === "tool_use",
    );
    expect(toolStart).toBeTruthy();
    expect(toolStart!.index).toBe(1);
    expect((toolStart!.content_block as { name?: string }).name).toBe("get_weather");
  });

  it("T2: non-streaming tool-only + reasoning → content[0] thinking block, tool_use at content[1]", async () => {
    server = await createServer([toolOnlyReasoningFixture], { port: 0 });
    const res = await post(`${server.url}/v1/messages`, {
      model: "claude-3-7-sonnet-20250219",
      max_tokens: 1024,
      thinking: ENABLED,
      messages: [{ role: "user", content: "What is the weather?" }],
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as {
      content: Array<{ type: string; signature?: string; name?: string }>;
    };
    expect(body.content[0].type).toBe("thinking");
    expect(body.content[0].signature).toBe("aimock-placeholder-signature");
    expect(body.content[1].type).toBe("tool_use");
    expect(body.content[1].name).toBe("get_weather");
  });

  it("T3: aimock's emitted tool-only-with-thinking turn replays into a strict continuation → 200", async () => {
    server = await createServer([toolOnlyReasoningFixture, continuationFixture], {
      port: 0,
      strict: true,
    });

    // First turn (streaming): capture the emitted signature.
    const first = await post(`${server.url}/v1/messages`, {
      model: "claude-3-7-sonnet-20250219",
      max_tokens: 1024,
      thinking: ENABLED,
      stream: true,
      messages: [{ role: "user", content: "What is the weather?" }],
    });
    expect(first.status).toBe(200);
    const events = parseClaudeSSEEvents(first.body);
    const sigDelta = events.find(
      (e) =>
        e.type === "content_block_delta" &&
        (e.delta as { type?: string } | undefined)?.type === "signature_delta",
    );
    const signature = (sigDelta?.delta as { signature?: string } | undefined)?.signature;
    expect(signature).toBe("aimock-placeholder-signature");

    // Replay the emitted tool-only-with-thinking turn into a strict continuation.
    const cont = await post(`${server.url}/v1/messages`, {
      model: "claude-3-7-sonnet-20250219",
      max_tokens: 1024,
      thinking: ENABLED,
      messages: [
        { role: "user", content: "What is the weather?" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "I should call the weather tool.", signature },
            toolUseBlock,
          ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "Sunny" }] },
      ],
    });
    expect(cont.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// claudeToCompletionRequest — malformed-input crash hardening
//
// `req.messages` and every content-block array come from untrusted JSON.parse,
// so message entries and content blocks may be null / non-object / primitive.
// The conversion path runs on every request right after validation; it must
// skip such entries rather than throw an unhandled TypeError (which the real
// Anthropic API answers with a 400, not a 500/hang).
// ---------------------------------------------------------------------------

describe("claudeToCompletionRequest — malformed-input crash hardening", () => {
  it("C1: user turn with a null content block → does not throw", () => {
    const req = {
      model: "claude-3-7-sonnet-20250219",
      max_tokens: 1024,
      messages: [{ role: "user", content: [null] }],
    };
    expect(() => claudeToCompletionRequest(req as never)).not.toThrow();
  });

  it("C2: assistant turn with a string + null content block → does not throw", () => {
    const req = {
      model: "claude-3-7-sonnet-20250219",
      max_tokens: 1024,
      messages: [{ role: "assistant", content: ["x", null] }],
    };
    expect(() => claudeToCompletionRequest(req as never)).not.toThrow();
  });

  it("C3: user turn with a primitive (number) content block → does not throw", () => {
    const req = {
      model: "claude-3-7-sonnet-20250219",
      max_tokens: 1024,
      messages: [{ role: "user", content: [42] }],
    };
    expect(() => claudeToCompletionRequest(req as never)).not.toThrow();
  });

  it("C4: tool_result with a null inner content block → does not throw", () => {
    const req = {
      model: "claude-3-7-sonnet-20250219",
      max_tokens: 1024,
      messages: [
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: [null] }] },
      ],
    };
    expect(() => claudeToCompletionRequest(req as never)).not.toThrow();
  });

  it("C5: messages array contains a null / non-object entry → does not throw", () => {
    const req = {
      model: "claude-3-7-sonnet-20250219",
      max_tokens: 1024,
      messages: [null, "foo"],
    };
    expect(() => claudeToCompletionRequest(req as never)).not.toThrow();
  });

  it("C6: system field array with a null block → does not throw", () => {
    const req = {
      model: "claude-3-7-sonnet-20250219",
      max_tokens: 1024,
      system: [null, { type: "text", text: "sys" }],
      messages: [{ role: "user", content: "hi" }],
    };
    expect(() => claudeToCompletionRequest(req as never)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// handleMessages — end-to-end no-crash on malformed content blocks
//
// Drives the full request path (the same place claudeToCompletionRequest runs)
// with malformed content arrays and asserts a clean Anthropic-shaped response,
// never an unhandled exception (500/hang).
// ---------------------------------------------------------------------------

describe("handleMessages — malformed content blocks do not crash", () => {
  const anyFixture: Fixture = {
    match: {},
    response: { content: "ok" },
  };

  async function run(body: unknown): Promise<{ status: number }> {
    const journal = new Journal();
    const logger = new Logger("silent");
    const defaults = createDefaults({ chunkSize: 10, logger, strict: false });
    const mockReq = {
      method: "POST",
      url: "/v1/messages",
      headers: {},
    } as unknown as http.IncomingMessage;
    const mockRes = createMockRes();
    await handleMessages(
      mockReq,
      mockRes,
      JSON.stringify(body),
      [anyFixture],
      journal,
      defaults,
      () => {},
    );
    return { status: journal.getLast()!.response.status };
  }

  it("M1: user content [null] → no throw, clean status", async () => {
    await expect(
      run({
        model: "claude-3-7-sonnet-20250219",
        max_tokens: 1024,
        messages: [{ role: "user", content: [null] }],
      }),
    ).resolves.toEqual({ status: 200 });
  });

  it("M2: assistant content ['x', null] → no throw, clean status", async () => {
    await expect(
      run({
        model: "claude-3-7-sonnet-20250219",
        max_tokens: 1024,
        messages: [{ role: "assistant", content: ["x", null] }],
      }),
    ).resolves.toEqual({ status: 200 });
  });
});
