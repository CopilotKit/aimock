import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import type { Fixture } from "../types.js";
import { createServer, type ServerInstance } from "../server.js";

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
});
