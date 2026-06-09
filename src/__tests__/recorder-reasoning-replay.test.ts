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
