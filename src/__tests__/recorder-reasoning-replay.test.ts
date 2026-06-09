import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Fixture } from "../types.js";
import { createServer, type ServerInstance } from "../server.js";
import { loadFixtureFile } from "../fixture-loader.js";
import { collapseAnthropicSSE } from "../stream-collapse.js";

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

const ENABLED = { type: "enabled" as const, budget_tokens: 1024 };

// ---------------------------------------------------------------------------
// Replay: recorded signature takes precedence over the placeholder
// ---------------------------------------------------------------------------

describe("Anthropic replay prefers a recorded reasoningSignature over the placeholder", () => {
  let server: ServerInstance;

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server.server.close(() => r()));
  });

  const REAL_SIGNATURE = "ErcBCkgIA...recordedRealCryptographicSignature==";

  function thinkingSignatureFromEvents(events: Array<Record<string, unknown>>): string | undefined {
    const sigDelta = events.find(
      (e) =>
        e.type === "content_block_delta" &&
        (e.delta as { type?: string } | undefined)?.type === "signature_delta",
    );
    return (sigDelta?.delta as { signature?: string } | undefined)?.signature;
  }

  it("streamed text turn emits the recorded signature when reasoningSignature is set", async () => {
    const fixture: Fixture = {
      match: { userMessage: "weather?" },
      response: {
        content: "It is sunny.",
        reasoning: "Let me check the weather.",
        reasoningSignature: REAL_SIGNATURE,
      },
    };
    server = await createServer([fixture], { port: 0 });

    const res = await post(`${server.url}/v1/messages`, {
      model: "claude-3-7-sonnet-20250219",
      max_tokens: 1024,
      thinking: ENABLED,
      stream: true,
      messages: [{ role: "user", content: "weather?" }],
    });
    expect(res.status).toBe(200);
    const events = parseClaudeSSEEvents(res.body);
    expect(thinkingSignatureFromEvents(events)).toBe(REAL_SIGNATURE);
  });

  it("streamed text turn falls back to the placeholder when reasoningSignature is absent", async () => {
    const fixture: Fixture = {
      match: { userMessage: "weather?" },
      response: { content: "It is sunny.", reasoning: "Let me check the weather." },
    };
    server = await createServer([fixture], { port: 0 });

    const res = await post(`${server.url}/v1/messages`, {
      model: "claude-3-7-sonnet-20250219",
      max_tokens: 1024,
      thinking: ENABLED,
      stream: true,
      messages: [{ role: "user", content: "weather?" }],
    });
    expect(res.status).toBe(200);
    const events = parseClaudeSSEEvents(res.body);
    expect(thinkingSignatureFromEvents(events)).toBe("aimock-placeholder-signature");
  });

  it("non-streaming text turn emits the recorded signature on the thinking block", async () => {
    const fixture: Fixture = {
      match: { userMessage: "weather?" },
      response: {
        content: "It is sunny.",
        reasoning: "Let me check the weather.",
        reasoningSignature: REAL_SIGNATURE,
      },
    };
    server = await createServer([fixture], { port: 0 });

    const res = await post(`${server.url}/v1/messages`, {
      model: "claude-3-7-sonnet-20250219",
      max_tokens: 1024,
      thinking: ENABLED,
      messages: [{ role: "user", content: "weather?" }],
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as {
      content: Array<{ type: string; signature?: string }>;
    };
    const thinking = body.content.find((b) => b.type === "thinking");
    expect(thinking?.signature).toBe(REAL_SIGNATURE);
  });

  it("streamed tool-call turn emits the recorded signature on the leading thinking block", async () => {
    const fixture: Fixture = {
      match: { userMessage: "weather?" },
      response: {
        toolCalls: [{ name: "get_weather", arguments: '{"city":"Paris"}' }],
        reasoning: "I should call the weather tool.",
        reasoningSignature: REAL_SIGNATURE,
      },
    };
    server = await createServer([fixture], { port: 0 });

    const res = await post(`${server.url}/v1/messages`, {
      model: "claude-3-7-sonnet-20250219",
      max_tokens: 1024,
      thinking: ENABLED,
      stream: true,
      messages: [{ role: "user", content: "weather?" }],
    });
    expect(res.status).toBe(200);
    const events = parseClaudeSSEEvents(res.body);
    expect(thinkingSignatureFromEvents(events)).toBe(REAL_SIGNATURE);
  });

  it("streamed content+tool turn emits the recorded signature on the leading thinking block", async () => {
    const fixture: Fixture = {
      match: { userMessage: "weather?" },
      response: {
        content: "Checking now.",
        toolCalls: [{ name: "get_weather", arguments: '{"city":"Paris"}' }],
        reasoning: "I should call the weather tool.",
        reasoningSignature: REAL_SIGNATURE,
      },
    };
    server = await createServer([fixture], { port: 0 });

    const res = await post(`${server.url}/v1/messages`, {
      model: "claude-3-7-sonnet-20250219",
      max_tokens: 1024,
      thinking: ENABLED,
      stream: true,
      messages: [{ role: "user", content: "weather?" }],
    });
    expect(res.status).toBe(200);
    const events = parseClaudeSSEEvents(res.body);
    expect(thinkingSignatureFromEvents(events)).toBe(REAL_SIGNATURE);
  });
});

// ---------------------------------------------------------------------------
// Replay: non-streaming content+tool array ordering with BOTH reasoning
// (+signature) AND redactedThinking on a reasoning-capable model.
// ---------------------------------------------------------------------------

describe("Anthropic replay orders the non-streaming content+tool array correctly", () => {
  let server: ServerInstance;

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server.server.close(() => r()));
  });

  const REAL_SIGNATURE = "ErcBCkgIA...recordedRealCryptographicSignature==";
  const REDACTED_A = "EncryptedRedactedThinkingPayloadAAA==";
  const REDACTED_B = "EncryptedRedactedThinkingPayloadBBB==";

  it("emits content blocks in [redacted_thinking..., thinking, text, tool_use] order", async () => {
    // A content+tool turn carrying BOTH plaintext reasoning (+signature) AND
    // recorded redacted_thinking. The non-streaming builder leads with every
    // redacted block, then the single joined thinking block, then the text
    // block, then the tool_use block — a fixed, replay-invariant order.
    const fixture: Fixture = {
      match: { userMessage: "weather?" },
      response: {
        content: "Checking now.",
        toolCalls: [{ name: "get_weather", arguments: '{"city":"Paris"}' }],
        reasoning: "I should call the weather tool.",
        reasoningSignature: REAL_SIGNATURE,
        redactedThinking: [REDACTED_A, REDACTED_B],
      },
    };
    server = await createServer([fixture], { port: 0 });

    const res = await post(`${server.url}/v1/messages`, {
      model: "claude-3-7-sonnet-20250219",
      max_tokens: 1024,
      thinking: ENABLED,
      messages: [{ role: "user", content: "weather?" }],
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as {
      content: Array<{ type: string; signature?: string; data?: string; text?: string }>;
    };

    // The content array order is exactly: both redacted blocks, then thinking,
    // then text, then tool_use.
    expect(body.content.map((b) => b.type)).toEqual([
      "redacted_thinking",
      "redacted_thinking",
      "thinking",
      "text",
      "tool_use",
    ]);
    // The redacted blocks lead in recorded order.
    expect(body.content[0].data).toBe(REDACTED_A);
    expect(body.content[1].data).toBe(REDACTED_B);
    // The thinking block carries the recorded signature.
    expect(body.content[2].signature).toBe(REAL_SIGNATURE);
    // The text block carries the content.
    expect(body.content[3].text).toBe("Checking now.");
  });
});

// ---------------------------------------------------------------------------
// Replay: redacted_thinking blocks round-trip faithfully
// ---------------------------------------------------------------------------

describe("Anthropic replay emits faithful redacted_thinking blocks", () => {
  let server: ServerInstance;

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server.server.close(() => r()));
  });

  const REDACTED_A = "EncryptedRedactedThinkingPayloadAAA==";
  const REDACTED_B = "EncryptedRedactedThinkingPayloadBBB==";

  /** All `data` values from streamed redacted_thinking content_block_start events, in order. */
  function redactedDataFromEvents(events: Array<Record<string, unknown>>): string[] {
    return events
      .filter(
        (e) =>
          e.type === "content_block_start" &&
          (e.content_block as { type?: string } | undefined)?.type === "redacted_thinking",
      )
      .map((e) => (e.content_block as { data?: string }).data ?? "");
  }

  it("streamed text turn emits redacted_thinking start/stop blocks with the recorded data", async () => {
    const fixture: Fixture = {
      match: { userMessage: "weather?" },
      response: {
        content: "It is sunny.",
        redactedThinking: [REDACTED_A],
      },
    };
    server = await createServer([fixture], { port: 0 });

    const res = await post(`${server.url}/v1/messages`, {
      model: "claude-3-7-sonnet-20250219",
      max_tokens: 1024,
      thinking: ENABLED,
      stream: true,
      messages: [{ role: "user", content: "weather?" }],
    });
    expect(res.status).toBe(200);
    const events = parseClaudeSSEEvents(res.body);
    expect(redactedDataFromEvents(events)).toEqual([REDACTED_A]);
    // The redacted block opens at index 0 and carries no thinking_delta (its
    // reasoning lives only in the opaque `data`), and a content_block_stop closes it.
    const redactedStart = events.find(
      (e) =>
        e.type === "content_block_start" &&
        (e.content_block as { type?: string }).type === "redacted_thinking",
    );
    expect(redactedStart?.index).toBe(0);
    const stopForRedacted = events.find((e) => e.type === "content_block_stop" && e.index === 0);
    expect(stopForRedacted).toBeDefined();
  });

  it("streamed text turn emits multiple redacted_thinking blocks in order", async () => {
    const fixture: Fixture = {
      match: { userMessage: "weather?" },
      response: {
        content: "It is sunny.",
        redactedThinking: [REDACTED_A, REDACTED_B],
      },
    };
    server = await createServer([fixture], { port: 0 });

    const res = await post(`${server.url}/v1/messages`, {
      model: "claude-3-7-sonnet-20250219",
      max_tokens: 1024,
      thinking: ENABLED,
      stream: true,
      messages: [{ role: "user", content: "weather?" }],
    });
    expect(res.status).toBe(200);
    const events = parseClaudeSSEEvents(res.body);
    expect(redactedDataFromEvents(events)).toEqual([REDACTED_A, REDACTED_B]);
  });

  it("non-streaming text turn emits redacted_thinking content blocks with the recorded data", async () => {
    const fixture: Fixture = {
      match: { userMessage: "weather?" },
      response: {
        content: "It is sunny.",
        redactedThinking: [REDACTED_A],
      },
    };
    server = await createServer([fixture], { port: 0 });

    const res = await post(`${server.url}/v1/messages`, {
      model: "claude-3-7-sonnet-20250219",
      max_tokens: 1024,
      thinking: ENABLED,
      messages: [{ role: "user", content: "weather?" }],
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as {
      content: Array<{ type: string; data?: string }>;
    };
    const redacted = body.content.filter((b) => b.type === "redacted_thinking");
    expect(redacted.map((b) => b.data)).toEqual([REDACTED_A]);
    // The redacted block leads the content array (before the text block).
    expect(body.content[0].type).toBe("redacted_thinking");
  });

  it("streamed tool-call turn emits the recorded redacted_thinking block before tool_use", async () => {
    const fixture: Fixture = {
      match: { userMessage: "weather?" },
      response: {
        toolCalls: [{ name: "get_weather", arguments: '{"city":"Paris"}' }],
        redactedThinking: [REDACTED_A],
      },
    };
    server = await createServer([fixture], { port: 0 });

    const res = await post(`${server.url}/v1/messages`, {
      model: "claude-3-7-sonnet-20250219",
      max_tokens: 1024,
      thinking: ENABLED,
      stream: true,
      messages: [{ role: "user", content: "weather?" }],
    });
    expect(res.status).toBe(200);
    const events = parseClaudeSSEEvents(res.body);
    expect(redactedDataFromEvents(events)).toEqual([REDACTED_A]);
  });

  it("non-streaming tool-call turn emits the recorded redacted_thinking block before tool_use", async () => {
    const fixture: Fixture = {
      match: { userMessage: "weather?" },
      response: {
        toolCalls: [{ name: "get_weather", arguments: '{"city":"Paris"}' }],
        redactedThinking: [REDACTED_A],
      },
    };
    server = await createServer([fixture], { port: 0 });

    const res = await post(`${server.url}/v1/messages`, {
      model: "claude-3-7-sonnet-20250219",
      max_tokens: 1024,
      thinking: ENABLED,
      messages: [{ role: "user", content: "weather?" }],
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as {
      content: Array<{ type: string; data?: string }>;
    };
    expect(body.content[0].type).toBe("redacted_thinking");
    expect(body.content[0].data).toBe(REDACTED_A);
  });

  it("emits no redacted_thinking blocks when redactedThinking is absent", async () => {
    const fixture: Fixture = {
      match: { userMessage: "weather?" },
      response: { content: "It is sunny." },
    };
    server = await createServer([fixture], { port: 0 });

    const res = await post(`${server.url}/v1/messages`, {
      model: "claude-3-7-sonnet-20250219",
      max_tokens: 1024,
      thinking: ENABLED,
      stream: true,
      messages: [{ role: "user", content: "weather?" }],
    });
    expect(res.status).toBe(200);
    const events = parseClaudeSSEEvents(res.body);
    expect(redactedDataFromEvents(events)).toEqual([]);
  });

  it("an explicit empty redactedThinking array emits NO redacted_thinking blocks (streaming)", async () => {
    // `redactedThinking: []` (explicit empty) is a no-op: no redacted_thinking
    // start/stop events are emitted, and no stray empty redacted block leaks in.
    const fixture: Fixture = {
      match: { userMessage: "weather?" },
      response: { content: "It is sunny.", redactedThinking: [] },
    };
    server = await createServer([fixture], { port: 0 });

    const res = await post(`${server.url}/v1/messages`, {
      model: "claude-3-7-sonnet-20250219",
      max_tokens: 1024,
      thinking: ENABLED,
      stream: true,
      messages: [{ role: "user", content: "weather?" }],
    });
    expect(res.status).toBe(200);
    const events = parseClaudeSSEEvents(res.body);
    const redactedStarts = events.filter(
      (e) =>
        e.type === "content_block_start" &&
        (e.content_block as { type?: string } | undefined)?.type === "redacted_thinking",
    );
    expect(redactedStarts).toHaveLength(0);
    expect(redactedDataFromEvents(events)).toEqual([]);
  });

  it("an explicit empty redactedThinking array emits NO redacted_thinking blocks (non-streaming)", async () => {
    const fixture: Fixture = {
      match: { userMessage: "weather?" },
      response: { content: "It is sunny.", redactedThinking: [] },
    };
    server = await createServer([fixture], { port: 0 });

    const res = await post(`${server.url}/v1/messages`, {
      model: "claude-3-7-sonnet-20250219",
      max_tokens: 1024,
      thinking: ENABLED,
      messages: [{ role: "user", content: "weather?" }],
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { content: Array<{ type: string }> };
    // No redacted_thinking block leaks into the content array.
    expect(body.content.some((b) => b.type === "redacted_thinking")).toBe(false);
  });

  // A turn recorded by the empty-content branch can carry ONLY redacted_thinking
  // (content: "", no plaintext reasoning). This is the exact fixture shape the
  // recorder produces for a redacted-thinking-only turn with no text output.
  it("redacted-only fixture (empty content, no reasoning) replays the redacted block then an empty text block", async () => {
    const fixture: Fixture = {
      match: { userMessage: "weather?" },
      response: { content: "", redactedThinking: [REDACTED_A] },
    };
    server = await createServer([fixture], { port: 0 });

    const res = await post(`${server.url}/v1/messages`, {
      model: "claude-3-7-sonnet-20250219",
      max_tokens: 1024,
      thinking: ENABLED,
      stream: true,
      messages: [{ role: "user", content: "weather?" }],
    });
    expect(res.status).toBe(200);
    const events = parseClaudeSSEEvents(res.body);

    // The redacted block opens at index 0 (it leads the turn).
    const redactedStart = events.find(
      (e) =>
        e.type === "content_block_start" &&
        (e.content_block as { type?: string }).type === "redacted_thinking",
    );
    expect(redactedStart?.index).toBe(0);
    expect((redactedStart?.content_block as { data?: string }).data).toBe(REDACTED_A);

    // The empty text block follows at index 1 (no thinking block is emitted
    // because there is no plaintext reasoning).
    const textStart = events.find(
      (e) =>
        e.type === "content_block_start" && (e.content_block as { type?: string }).type === "text",
    );
    expect(textStart?.index).toBe(1);
    // No text_delta events were emitted for the empty content.
    const textDeltas = events.filter(
      (e) =>
        e.type === "content_block_delta" && (e.delta as { type?: string }).type === "text_delta",
    );
    expect(textDeltas).toHaveLength(0);
  });

  it("redacted-only fixture replays the redacted block leading the content array (non-streaming)", async () => {
    const fixture: Fixture = {
      match: { userMessage: "weather?" },
      response: { content: "", redactedThinking: [REDACTED_A] },
    };
    server = await createServer([fixture], { port: 0 });

    const res = await post(`${server.url}/v1/messages`, {
      model: "claude-3-7-sonnet-20250219",
      max_tokens: 1024,
      thinking: ENABLED,
      messages: [{ role: "user", content: "weather?" }],
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as {
      content: Array<{ type: string; data?: string }>;
    };
    // The redacted block leads the content array.
    expect(body.content[0].type).toBe("redacted_thinking");
    expect(body.content[0].data).toBe(REDACTED_A);
  });
});

// ---------------------------------------------------------------------------
// Replay: new reasoning fields survive the on-disk FILE-LOAD path
// ---------------------------------------------------------------------------

describe("Anthropic replay round-trips reasoningSignature + redactedThinking from a fixture FILE", () => {
  let server: ServerInstance;
  let tmpDir: string;

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server.server.close(() => r()));
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const REAL_SIGNATURE = "ErcBCkgIA...recordedRealCryptographicSignature==";
  const REDACTED_DATA = "EncryptedRedactedThinkingPayloadAAA==";

  it("loads a fixture file with reasoningSignature + redactedThinking and replays both", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-replay-fileload-"));
    const filePath = path.join(tmpDir, "reasoning-fixture.json");
    // Write a real fixture FILE (not an in-memory object) so the fields must
    // survive normalizeResponse's raw spread in the file-load path.
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        fixtures: [
          {
            match: { userMessage: "weather?" },
            response: {
              content: "It is sunny.",
              reasoning: "Let me check the weather.",
              reasoningSignature: REAL_SIGNATURE,
              redactedThinking: [REDACTED_DATA],
            },
          },
        ],
      }),
    );

    const fixtures = loadFixtureFile(filePath);
    server = await createServer(fixtures, { port: 0 });

    const res = await post(`${server.url}/v1/messages`, {
      model: "claude-3-7-sonnet-20250219",
      max_tokens: 1024,
      thinking: ENABLED,
      stream: true,
      messages: [{ role: "user", content: "weather?" }],
    });
    expect(res.status).toBe(200);
    const events = parseClaudeSSEEvents(res.body);

    // The recorded redacted block is emitted from the loaded file.
    const redactedData = events
      .filter(
        (e) =>
          e.type === "content_block_start" &&
          (e.content_block as { type?: string }).type === "redacted_thinking",
      )
      .map((e) => (e.content_block as { data?: string }).data);
    expect(redactedData).toEqual([REDACTED_DATA]);

    // The recorded real signature is emitted (not the placeholder).
    const sigDelta = events.find(
      (e) =>
        e.type === "content_block_delta" &&
        (e.delta as { type?: string }).type === "signature_delta",
    );
    expect((sigDelta?.delta as { signature?: string }).signature).toBe(REAL_SIGNATURE);
  });
});

// ---------------------------------------------------------------------------
// Capability gate: encrypted reasoning artifacts (redacted_thinking +
// signature) are suppressed wholesale on non-reasoning models under strict
// mode, just like the plaintext reasoning channel — see aimock#254.
// ---------------------------------------------------------------------------

describe("Anthropic replay gates encrypted reasoning artifacts on model capability", () => {
  let server: ServerInstance;

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server.server.close(() => r()));
  });

  const REAL_SIGNATURE = "ErcBCkgIA...recordedRealCryptographicSignature==";
  const REDACTED_A = "EncryptedRedactedThinkingPayloadAAA==";
  const REDACTED_B = "EncryptedRedactedThinkingPayloadBBB==";
  // claude-3-5-sonnet is in NONREASONING_FAMILIES — the real provider for it
  // emits no thinking/redacted_thinking channel at all.
  const NONREASONING_MODEL = "claude-3-5-sonnet-20241022";
  const REASONING_MODEL = "claude-3-7-sonnet-20250219";
  const STRICT = { "X-AIMock-Strict": "true" };

  function thinkingBlocks(events: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    return events.filter(
      (e) =>
        e.type === "content_block_start" &&
        (e.content_block as { type?: string } | undefined)?.type === "thinking",
    );
  }

  function redactedBlocks(events: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    return events.filter(
      (e) =>
        e.type === "content_block_start" &&
        (e.content_block as { type?: string } | undefined)?.type === "redacted_thinking",
    );
  }

  function signatureDeltas(events: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    return events.filter(
      (e) =>
        e.type === "content_block_delta" &&
        (e.delta as { type?: string } | undefined)?.type === "signature_delta",
    );
  }

  // -- Streaming, strict ON: full reasoning channel suppressed ----------------

  it("strict mode: streamed text turn strips thinking AND redacted_thinking on a non-reasoning model", async () => {
    const fixture: Fixture = {
      match: { userMessage: "weather?" },
      response: {
        content: "It is sunny.",
        reasoning: "Let me check the weather.",
        reasoningSignature: REAL_SIGNATURE,
        redactedThinking: [REDACTED_A, REDACTED_B],
      },
    };
    server = await createServer([fixture], { port: 0 });

    const res = await post(
      `${server.url}/v1/messages`,
      {
        model: NONREASONING_MODEL,
        max_tokens: 1024,
        thinking: ENABLED,
        stream: true,
        messages: [{ role: "user", content: "weather?" }],
      },
      STRICT,
    );
    expect(res.status).toBe(200);
    const events = parseClaudeSSEEvents(res.body);
    expect(thinkingBlocks(events)).toHaveLength(0);
    expect(redactedBlocks(events)).toHaveLength(0);
    expect(signatureDeltas(events)).toHaveLength(0);
  });

  it("strict mode: non-streaming text turn strips thinking AND redacted_thinking on a non-reasoning model", async () => {
    const fixture: Fixture = {
      match: { userMessage: "weather?" },
      response: {
        content: "It is sunny.",
        reasoning: "Let me check the weather.",
        reasoningSignature: REAL_SIGNATURE,
        redactedThinking: [REDACTED_A],
      },
    };
    server = await createServer([fixture], { port: 0 });

    const res = await post(
      `${server.url}/v1/messages`,
      {
        model: NONREASONING_MODEL,
        max_tokens: 1024,
        thinking: ENABLED,
        messages: [{ role: "user", content: "weather?" }],
      },
      STRICT,
    );
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { content: Array<{ type: string }> };
    expect(body.content.some((b) => b.type === "thinking")).toBe(false);
    expect(body.content.some((b) => b.type === "redacted_thinking")).toBe(false);
  });

  it("strict mode: non-streaming tool-call turn strips thinking AND redacted_thinking on a non-reasoning model", async () => {
    const fixture: Fixture = {
      match: { userMessage: "weather?" },
      response: {
        toolCalls: [{ name: "get_weather", arguments: '{"city":"Paris"}' }],
        reasoning: "I should call the weather tool.",
        reasoningSignature: REAL_SIGNATURE,
        redactedThinking: [REDACTED_A],
      },
    };
    server = await createServer([fixture], { port: 0 });

    const res = await post(
      `${server.url}/v1/messages`,
      {
        model: NONREASONING_MODEL,
        max_tokens: 1024,
        thinking: ENABLED,
        messages: [{ role: "user", content: "weather?" }],
      },
      STRICT,
    );
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { content: Array<{ type: string }> };
    expect(body.content.some((b) => b.type === "thinking")).toBe(false);
    expect(body.content.some((b) => b.type === "redacted_thinking")).toBe(false);
    expect(body.content.some((b) => b.type === "tool_use")).toBe(true);
  });

  it("strict mode: non-streaming content+tool turn strips thinking AND redacted_thinking on a non-reasoning model", async () => {
    const fixture: Fixture = {
      match: { userMessage: "weather?" },
      response: {
        content: "Checking now.",
        toolCalls: [{ name: "get_weather", arguments: '{"city":"Paris"}' }],
        reasoning: "I should call the weather tool.",
        reasoningSignature: REAL_SIGNATURE,
        redactedThinking: [REDACTED_A],
      },
    };
    server = await createServer([fixture], { port: 0 });

    const res = await post(
      `${server.url}/v1/messages`,
      {
        model: NONREASONING_MODEL,
        max_tokens: 1024,
        thinking: ENABLED,
        messages: [{ role: "user", content: "weather?" }],
      },
      STRICT,
    );
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { content: Array<{ type: string }> };
    expect(body.content.some((b) => b.type === "thinking")).toBe(false);
    expect(body.content.some((b) => b.type === "redacted_thinking")).toBe(false);
    expect(body.content.some((b) => b.type === "text")).toBe(true);
    expect(body.content.some((b) => b.type === "tool_use")).toBe(true);
  });

  it("strict mode: suppresses redacted_thinking even when there is NO plaintext reasoning", async () => {
    const fixture: Fixture = {
      match: { userMessage: "weather?" },
      response: {
        content: "It is sunny.",
        redactedThinking: [REDACTED_A],
      },
    };
    server = await createServer([fixture], { port: 0 });

    const res = await post(
      `${server.url}/v1/messages`,
      {
        model: NONREASONING_MODEL,
        max_tokens: 1024,
        thinking: ENABLED,
        stream: true,
        messages: [{ role: "user", content: "weather?" }],
      },
      STRICT,
    );
    expect(res.status).toBe(200);
    const events = parseClaudeSSEEvents(res.body);
    expect(redactedBlocks(events)).toHaveLength(0);
  });

  it("strict mode: streamed tool-call turn strips redacted_thinking on a non-reasoning model", async () => {
    const fixture: Fixture = {
      match: { userMessage: "weather?" },
      response: {
        toolCalls: [{ name: "get_weather", arguments: '{"city":"Paris"}' }],
        reasoning: "I should call the weather tool.",
        reasoningSignature: REAL_SIGNATURE,
        redactedThinking: [REDACTED_A],
      },
    };
    server = await createServer([fixture], { port: 0 });

    const res = await post(
      `${server.url}/v1/messages`,
      {
        model: NONREASONING_MODEL,
        max_tokens: 1024,
        thinking: ENABLED,
        stream: true,
        messages: [{ role: "user", content: "weather?" }],
      },
      STRICT,
    );
    expect(res.status).toBe(200);
    const events = parseClaudeSSEEvents(res.body);
    expect(thinkingBlocks(events)).toHaveLength(0);
    expect(redactedBlocks(events)).toHaveLength(0);
  });

  it("strict mode: streamed content+tool turn strips redacted_thinking on a non-reasoning model", async () => {
    const fixture: Fixture = {
      match: { userMessage: "weather?" },
      response: {
        content: "Checking now.",
        toolCalls: [{ name: "get_weather", arguments: '{"city":"Paris"}' }],
        reasoning: "I should call the weather tool.",
        reasoningSignature: REAL_SIGNATURE,
        redactedThinking: [REDACTED_A],
      },
    };
    server = await createServer([fixture], { port: 0 });

    const res = await post(
      `${server.url}/v1/messages`,
      {
        model: NONREASONING_MODEL,
        max_tokens: 1024,
        thinking: ENABLED,
        stream: true,
        messages: [{ role: "user", content: "weather?" }],
      },
      STRICT,
    );
    expect(res.status).toBe(200);
    const events = parseClaudeSSEEvents(res.body);
    expect(thinkingBlocks(events)).toHaveLength(0);
    expect(redactedBlocks(events)).toHaveLength(0);
  });

  // -- Reasoning-capable model path is unchanged under strict mode ------------

  it("reasoning-capable model under strict mode still emits thinking, signature, and redacted_thinking", async () => {
    const fixture: Fixture = {
      match: { userMessage: "weather?" },
      response: {
        content: "It is sunny.",
        reasoning: "Let me check the weather.",
        reasoningSignature: REAL_SIGNATURE,
        redactedThinking: [REDACTED_A],
      },
    };
    server = await createServer([fixture], { port: 0 });

    const res = await post(
      `${server.url}/v1/messages`,
      {
        model: REASONING_MODEL,
        max_tokens: 1024,
        thinking: ENABLED,
        stream: true,
        messages: [{ role: "user", content: "weather?" }],
      },
      STRICT,
    );
    expect(res.status).toBe(200);
    const events = parseClaudeSSEEvents(res.body);
    expect(redactedBlocks(events).map((e) => (e.content_block as { data?: string }).data)).toEqual([
      REDACTED_A,
    ]);
    const sig = signatureDeltas(events)[0];
    expect((sig?.delta as { signature?: string } | undefined)?.signature).toBe(REAL_SIGNATURE);
  });

  // -- Non-strict (warn) mode: artifacts still emitted, mirroring plaintext ---

  it("non-strict mode: non-reasoning model still emits redacted_thinking (warn, not suppress)", async () => {
    const fixture: Fixture = {
      match: { userMessage: "weather?" },
      response: {
        content: "It is sunny.",
        reasoningSignature: REAL_SIGNATURE,
        redactedThinking: [REDACTED_A],
      },
    };
    server = await createServer([fixture], { port: 0 });

    const res = await post(`${server.url}/v1/messages`, {
      model: NONREASONING_MODEL,
      max_tokens: 1024,
      thinking: ENABLED,
      stream: true,
      messages: [{ role: "user", content: "weather?" }],
    });
    expect(res.status).toBe(200);
    const events = parseClaudeSSEEvents(res.body);
    expect(redactedBlocks(events).map((e) => (e.content_block as { data?: string }).data)).toEqual([
      REDACTED_A,
    ]);
  });

  it("non-strict mode: non-reasoning model still emits the thinking block carrying the recorded signature (warn, not suppress)", async () => {
    // Warn-and-emit parity for the signature half: a non-reasoning model in
    // NON-strict mode still emits the plaintext thinking block, and that block
    // carries the RECORDED signature (not the placeholder) just as a reasoning
    // model would — the capability gate only suppresses under strict mode.
    const fixture: Fixture = {
      match: { userMessage: "weather?" },
      response: {
        content: "It is sunny.",
        reasoning: "Let me check the weather.",
        reasoningSignature: REAL_SIGNATURE,
      },
    };
    server = await createServer([fixture], { port: 0 });

    const res = await post(`${server.url}/v1/messages`, {
      model: NONREASONING_MODEL,
      max_tokens: 1024,
      thinking: ENABLED,
      stream: true,
      messages: [{ role: "user", content: "weather?" }],
    });
    expect(res.status).toBe(200);
    const events = parseClaudeSSEEvents(res.body);
    // The thinking block is emitted (not suppressed)...
    expect(thinkingBlocks(events)).toHaveLength(1);
    // ...carrying the recorded real signature, not the placeholder.
    expect(
      signatureDeltas(events).map((e) => (e.delta as { signature?: string }).signature),
    ).toEqual([REAL_SIGNATURE]);
  });
});

// ---------------------------------------------------------------------------
// Round-trip contract: anything the capture path persists must pass the
// replay-side validator. An upstream emitting `data: ""` on a redacted_thinking
// block must NOT yield a fixture that 400s as a strict tool-loop continuation.
// (Convergence-audit lever: closes the record-green / replay-400 gap by tying
// capture and validation to a single invariant.)
// ---------------------------------------------------------------------------

describe("redacted_thinking capture ↔ strict-replay round-trip contract", () => {
  let server: ServerInstance;

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server.server.close(() => r()));
  });

  // Replay the captured assistant turn as a strict tool-loop continuation: the
  // assistant turn leads with the captured redacted_thinking blocks + a tool_use
  // that the following user turn answers, which is exactly the shape
  // validateThinkingInvariants checks. A leading empty-data block would 400.
  function continuationFrom(redactedThinking: string[] | undefined): Record<string, unknown> {
    const redactedBlocks = (redactedThinking ?? []).map((data) => ({
      type: "redacted_thinking",
      data,
    }));
    return {
      model: "claude-3-7-sonnet-20250219",
      max_tokens: 1024,
      thinking: ENABLED,
      messages: [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: [
            ...redactedBlocks,
            { type: "tool_use", id: "tu_1", name: "get_weather", input: { city: "NYC" } },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu_1", content: "Sunny" }],
        },
      ],
    };
  }

  it('upstream `data: ""` is dropped at capture, so the strict continuation replays without a dropped_redacted_thinking 400', async () => {
    // Upstream leads with an empty-data redacted_thinking block (the offending
    // shape), followed by a real redacted block and a tool_use. Capture must
    // drop the empty leader so the surviving real block leads the replayed turn.
    const upstream = [
      `event: content_block_start\ndata: ${JSON.stringify({ index: 0, content_block: { type: "redacted_thinking", data: "" } })}`,
      "",
      `event: content_block_stop\ndata: ${JSON.stringify({ index: 0 })}`,
      "",
      `event: content_block_start\ndata: ${JSON.stringify({ index: 1, content_block: { type: "redacted_thinking", data: "EncryptedRedactedPayload==" } })}`,
      "",
      `event: content_block_stop\ndata: ${JSON.stringify({ index: 1 })}`,
      "",
      `event: content_block_start\ndata: ${JSON.stringify({ index: 2, content_block: { type: "tool_use", id: "tu_1", name: "get_weather" } })}`,
      "",
      `event: content_block_delta\ndata: ${JSON.stringify({ index: 2, delta: { type: "input_json_delta", partial_json: '{"city":"NYC"}' } })}`,
      "",
      `event: content_block_stop\ndata: ${JSON.stringify({ index: 2 })}`,
      "",
      `event: message_stop\ndata: {}`,
      "",
    ].join("\n");

    // Capture path: this is what the recorder persists into the fixture.
    const collapsed = collapseAnthropicSSE(upstream);

    // The captured turn, replayed verbatim, must satisfy the strict validator.
    server = await createServer([], { port: 0, strict: true });
    const res = await post(
      `${server.url}/v1/messages`,
      continuationFrom(collapsed.redactedThinking),
    );

    // Record-green must imply replay-green: the empty block was never captured,
    // so the continuation does not lead with an empty-data redacted_thinking.
    expect(res.status).not.toBe(400);
    expect(res.body).not.toContain("dropped_redacted_thinking");
  });
});

// ---------------------------------------------------------------------------
// Strict-continuation round-trip: the replayed assistant turn (carrying the
// recorded reasoning + signature + redacted block) is fed BACK as a tool-loop
// continuation under strict mode and must survive the thinking invariants with
// no 400. This is the round-trip the PLACEHOLDER_SIGNATURE design promises: a
// reasoning turn aimock replays is itself a valid continuation input.
//
// Expected GREEN already — the replay path emits a non-empty signature (the
// recorded one, else the placeholder) and non-empty redacted data, both of
// which the strict thinking invariants require.
// ---------------------------------------------------------------------------

describe("Anthropic strict-mode reasoning round-trip (replay → continuation, no 400)", () => {
  let server: ServerInstance;

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server.server.close(() => r()));
  });

  const REASONING_MODEL = "claude-3-7-sonnet-20250219";
  const STRICT = { "X-AIMock-Strict": "true" };
  const REAL_SIGNATURE = "ErcBCkgIA...recordedRealCryptographicSignature==";
  const REDACTED_DATA = "EncryptedRedactedThinkingPayloadAAA==";

  type AnthropicBlock = {
    type: string;
    text?: string;
    thinking?: string;
    signature?: string;
    data?: string;
    id?: string;
    name?: string;
    input?: unknown;
  };

  it("replayed reasoning+tool turn round-trips as a strict continuation (200, no invariant 400)", async () => {
    // A reasoning-capable fixture that, on the FIRST turn, replays a thinking
    // block (with a recorded real signature) + a redacted block + a tool_use.
    // The SECOND turn (the tool_result continuation) matches a follow-up fixture.
    const firstTurn: Fixture = {
      match: { userMessage: "weather?" },
      response: {
        toolCalls: [{ name: "get_weather", arguments: '{"city":"Paris"}' }],
        reasoning: "I should call the weather tool.",
        reasoningSignature: REAL_SIGNATURE,
        redactedThinking: [REDACTED_DATA],
      },
    };
    const continuation: Fixture = {
      match: { hasToolResult: true },
      response: { content: "It is sunny in Paris." },
    };
    server = await createServer([firstTurn, continuation], { port: 0 });

    // Turn 1: replay the reasoning + tool turn (non-streaming JSON).
    const firstRes = await post(
      `${server.url}/v1/messages`,
      {
        model: REASONING_MODEL,
        max_tokens: 1024,
        thinking: ENABLED,
        messages: [{ role: "user", content: "weather?" }],
      },
      STRICT,
    );
    expect(firstRes.status).toBe(200);
    const firstBody = JSON.parse(firstRes.body) as { content: AnthropicBlock[] };

    // The replayed assistant turn leads with a thinking block carrying the
    // recorded real signature (NOT empty), the redacted block, and a tool_use.
    const thinkingBlock = firstBody.content.find((b) => b.type === "thinking");
    expect(thinkingBlock?.signature).toBe(REAL_SIGNATURE);
    const redactedBlock = firstBody.content.find((b) => b.type === "redacted_thinking");
    expect(redactedBlock?.data).toBe(REDACTED_DATA);
    const toolUseBlock = firstBody.content.find((b) => b.type === "tool_use");
    expect(toolUseBlock).toBeDefined();
    const toolUseId = String(toolUseBlock!.id);

    // Turn 2: feed the EXACT replayed assistant content back as a tool-loop
    // continuation under strict mode. The strict thinking invariants validate
    // the in-scope assistant turn (leading thinking block must carry a non-empty
    // signature; any redacted_thinking must carry non-empty data) — the
    // round-trip must pass with NO 400.
    const secondRes = await post(
      `${server.url}/v1/messages`,
      {
        model: REASONING_MODEL,
        max_tokens: 1024,
        thinking: ENABLED,
        messages: [
          { role: "user", content: "weather?" },
          { role: "assistant", content: firstBody.content },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: toolUseId, content: "Sunny" }],
          },
        ],
      },
      STRICT,
    );
    // No invariant violation: the replayed reasoning turn is a valid strict
    // continuation input.
    expect(secondRes.status).toBe(200);
  });

  it("replayed reasoning text turn (no recorded signature) round-trips via the placeholder (200)", async () => {
    // No reasoningSignature recorded → replay emits the placeholder signature,
    // which is itself non-empty, so the strict missing_signature invariant still
    // passes when the turn is fed back as a continuation.
    const firstTurn: Fixture = {
      match: { userMessage: "weather?" },
      response: {
        toolCalls: [{ name: "get_weather", arguments: '{"city":"Paris"}' }],
        reasoning: "Let me think about the weather.",
      },
    };
    const continuation: Fixture = {
      match: { hasToolResult: true },
      response: { content: "It is sunny in Paris." },
    };
    server = await createServer([firstTurn, continuation], { port: 0 });

    const firstRes = await post(
      `${server.url}/v1/messages`,
      {
        model: REASONING_MODEL,
        max_tokens: 1024,
        thinking: ENABLED,
        messages: [{ role: "user", content: "weather?" }],
      },
      STRICT,
    );
    expect(firstRes.status).toBe(200);
    const firstBody = JSON.parse(firstRes.body) as { content: AnthropicBlock[] };

    // The replayed thinking block carries the (non-empty) placeholder signature.
    const thinkingBlock = firstBody.content.find((b) => b.type === "thinking");
    expect(thinkingBlock?.signature).toBe("aimock-placeholder-signature");
    const toolUseBlock = firstBody.content.find((b) => b.type === "tool_use");
    const toolUseId = String(toolUseBlock!.id);

    const secondRes = await post(
      `${server.url}/v1/messages`,
      {
        model: REASONING_MODEL,
        max_tokens: 1024,
        thinking: ENABLED,
        messages: [
          { role: "user", content: "weather?" },
          { role: "assistant", content: firstBody.content },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: toolUseId, content: "Sunny" }],
          },
        ],
      },
      STRICT,
    );
    expect(secondRes.status).toBe(200);
  });
});
