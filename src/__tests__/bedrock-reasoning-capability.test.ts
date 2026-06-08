import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as http from "node:http";
import { crc32 } from "node:zlib";
import type { Fixture } from "../types.js";
import { createServer, type ServerInstance } from "../server.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let instance: ServerInstance | null = null;
let baseUrl: string;

function post(
  path: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const parsed = new URL(baseUrl);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path,
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
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          });
        });
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function postRaw(
  path: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const parsed = new URL(baseUrl);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path,
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
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

/**
 * Decode AWS Event Stream binary frames from a Buffer.
 * Returns an array of { eventType, payload } objects.
 */
function decodeEventStreamFrames(buf: Buffer): Array<{ eventType: string; payload: object }> {
  const frames: Array<{ eventType: string; payload: object }> = [];
  let offset = 0;

  while (offset < buf.length) {
    if (offset + 12 > buf.length) break;

    const totalLength = buf.readUInt32BE(offset);
    const headersLength = buf.readUInt32BE(offset + 4);
    const preludeCrc = buf.readUInt32BE(offset + 8);

    const computedPreludeCrc = crc32(buf.subarray(offset, offset + 8));
    if (computedPreludeCrc >>> 0 !== preludeCrc) {
      throw new Error("Prelude CRC mismatch");
    }

    const headersStart = offset + 12;
    const headersEnd = headersStart + headersLength;
    const headers: Record<string, string> = {};
    let hOff = headersStart;
    while (hOff < headersEnd) {
      const nameLen = buf.readUInt8(hOff);
      hOff += 1;
      const name = buf.subarray(hOff, hOff + nameLen).toString("utf8");
      hOff += nameLen;
      hOff += 1; // skip header type byte (7 = STRING)
      const valueLen = buf.readUInt16BE(hOff);
      hOff += 2;
      const value = buf.subarray(hOff, hOff + valueLen).toString("utf8");
      hOff += valueLen;
      headers[name] = value;
    }

    const payloadStart = headersEnd;
    const payloadEnd = offset + totalLength - 4; // minus message CRC
    const payloadBuf = buf.subarray(payloadStart, payloadEnd);
    const payload = payloadBuf.length > 0 ? JSON.parse(payloadBuf.toString("utf8")) : {};

    frames.push({
      eventType: headers[":event-type"] ?? "",
      payload,
    });

    offset += totalLength;
  }

  return frames;
}

// Predicates over decoded InvokeModel stream frames
function hasInvokeThinkingDelta(frames: Array<{ eventType: string; payload: object }>): boolean {
  return frames.some(
    (f) =>
      (f.payload as { type?: string }).type === "content_block_delta" &&
      (f.payload as { delta?: { type?: string } }).delta?.type === "thinking_delta",
  );
}

// Predicates over decoded Converse stream frames
function hasConverseReasoningDelta(frames: Array<{ eventType: string; payload: object }>): boolean {
  return frames.some(
    (f) =>
      f.eventType === "contentBlockDelta" &&
      (f.payload as { delta?: { reasoningContent?: unknown } }).delta?.reasoningContent !==
        undefined,
  );
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const reasoningFixture: Fixture = {
  match: { userMessage: "think" },
  response: {
    content: "The answer is 42.",
    reasoning: "Let me think step by step about this problem.",
  },
};

const reasoningWithToolsFixture: Fixture = {
  match: { userMessage: "reason-and-call" },
  response: {
    content: "Calling a tool.",
    reasoning: "I should call get_weather.",
    toolCalls: [{ name: "get_weather", arguments: '{"city":"SF"}' }],
  },
};

const plainFixture: Fixture = {
  match: { userMessage: "plain" },
  response: { content: "Just plain text." },
};

const allFixtures: Fixture[] = [reasoningFixture, reasoningWithToolsFixture, plainFixture];

// Model ids carrying Bedrock provider prefixes.
const REASONING_MODEL = "anthropic.claude-opus-4-20250514-v1:0"; // Claude 4 → reasoning-capable
const NON_REASONING_MODEL = "anthropic.claude-3-5-sonnet-20241022-v2:0"; // 3.5 → not reasoning-capable
const UNKNOWN_MODEL = "anthropic.future-model-x"; // unknown → fail open (capable)

// ---------------------------------------------------------------------------
// Server lifecycle (default: strict OFF, warn-level logging so warns surface)
// ---------------------------------------------------------------------------

beforeEach(async () => {
  instance = await createServer(allFixtures, { port: 0, logLevel: "warn" });
  baseUrl = instance.url;
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (instance) {
    await new Promise<void>((resolve) => {
      instance!.server.close(() => resolve());
    });
    instance = null;
  }
});

// ---------------------------------------------------------------------------
// Bedrock InvokeModel — non-streaming
// ---------------------------------------------------------------------------

describe("Bedrock InvokeModel reasoning capability gating (non-streaming)", () => {
  it("emits thinking block for a reasoning-capable bedrock-prefixed model", async () => {
    const res = await post(`/model/${REASONING_MODEL}/invoke`, {
      messages: [{ role: "user", content: [{ type: "text", text: "think" }] }],
      max_tokens: 1024,
      anthropic_version: "bedrock-2023-05-31",
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.content[0].type).toBe("thinking");
    expect(body.content[0].thinking).toBe("Let me think step by step about this problem.");
  });

  it("non-reasoning model + strict OFF: still emits thinking and logs a warning", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await post(`/model/${NON_REASONING_MODEL}/invoke`, {
      messages: [{ role: "user", content: [{ type: "text", text: "think" }] }],
      max_tokens: 1024,
      anthropic_version: "bedrock-2023-05-31",
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.content[0].type).toBe("thinking");
    expect(warnSpy.mock.calls.flat().join(" ").includes("not reasoning-capable")).toBe(true);
  });

  it("non-reasoning model + strict ON: suppresses thinking block", async () => {
    const res = await post(
      `/model/${NON_REASONING_MODEL}/invoke`,
      {
        messages: [{ role: "user", content: [{ type: "text", text: "think" }] }],
        max_tokens: 1024,
        anthropic_version: "bedrock-2023-05-31",
      },
      { "X-AIMock-Strict": "true" },
    );

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.content).toHaveLength(1);
    expect(body.content[0].type).toBe("text");
  });

  it("unknown model: emits thinking (fail open)", async () => {
    const res = await post(`/model/${UNKNOWN_MODEL}/invoke`, {
      messages: [{ role: "user", content: [{ type: "text", text: "think" }] }],
      max_tokens: 1024,
      anthropic_version: "bedrock-2023-05-31",
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.content[0].type).toBe("thinking");
  });

  it("reasoning absent: no thinking block, no gating log", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await post(`/model/${NON_REASONING_MODEL}/invoke`, {
      messages: [{ role: "user", content: [{ type: "text", text: "plain" }] }],
      max_tokens: 1024,
      anthropic_version: "bedrock-2023-05-31",
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.content).toHaveLength(1);
    expect(body.content[0].type).toBe("text");
    expect(warnSpy.mock.calls.flat().join(" ").includes("not reasoning-capable")).toBe(false);
  });

  it("content+tool calls: non-reasoning model + strict ON suppresses thinking", async () => {
    const res = await post(
      `/model/${NON_REASONING_MODEL}/invoke`,
      {
        messages: [{ role: "user", content: [{ type: "text", text: "reason-and-call" }] }],
        max_tokens: 1024,
        anthropic_version: "bedrock-2023-05-31",
      },
      { "X-AIMock-Strict": "true" },
    );

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    const types = (body.content as Array<{ type: string }>).map((b) => b.type);
    expect(types).not.toContain("thinking");
    expect(types).toContain("text");
    expect(types).toContain("tool_use");
  });
});

// ---------------------------------------------------------------------------
// Bedrock InvokeModel — streaming
// ---------------------------------------------------------------------------

describe("Bedrock InvokeModel reasoning capability gating (streaming)", () => {
  it("emits thinking_delta for a reasoning-capable model", async () => {
    const res = await postRaw(`/model/${REASONING_MODEL}/invoke-with-response-stream`, {
      messages: [{ role: "user", content: [{ type: "text", text: "think" }] }],
      max_tokens: 1024,
      anthropic_version: "bedrock-2023-05-31",
    });

    expect(res.status).toBe(200);
    expect(hasInvokeThinkingDelta(decodeEventStreamFrames(res.body))).toBe(true);
  });

  it("non-reasoning model + strict OFF: still emits thinking_delta + warns", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await postRaw(`/model/${NON_REASONING_MODEL}/invoke-with-response-stream`, {
      messages: [{ role: "user", content: [{ type: "text", text: "think" }] }],
      max_tokens: 1024,
      anthropic_version: "bedrock-2023-05-31",
    });

    expect(res.status).toBe(200);
    expect(hasInvokeThinkingDelta(decodeEventStreamFrames(res.body))).toBe(true);
    expect(warnSpy.mock.calls.flat().join(" ").includes("not reasoning-capable")).toBe(true);
  });

  it("non-reasoning model + strict ON: suppresses thinking_delta", async () => {
    const res = await postRaw(
      `/model/${NON_REASONING_MODEL}/invoke-with-response-stream`,
      {
        messages: [{ role: "user", content: [{ type: "text", text: "think" }] }],
        max_tokens: 1024,
        anthropic_version: "bedrock-2023-05-31",
      },
      { "X-AIMock-Strict": "true" },
    );

    expect(res.status).toBe(200);
    expect(hasInvokeThinkingDelta(decodeEventStreamFrames(res.body))).toBe(false);
  });

  it("content+tool calls: non-reasoning model + strict ON suppresses thinking_delta", async () => {
    const res = await postRaw(
      `/model/${NON_REASONING_MODEL}/invoke-with-response-stream`,
      {
        messages: [{ role: "user", content: [{ type: "text", text: "reason-and-call" }] }],
        max_tokens: 1024,
        anthropic_version: "bedrock-2023-05-31",
      },
      { "X-AIMock-Strict": "true" },
    );

    expect(res.status).toBe(200);
    expect(hasInvokeThinkingDelta(decodeEventStreamFrames(res.body))).toBe(false);
  });

  it("unknown model: emits thinking_delta (fail open)", async () => {
    const res = await postRaw(`/model/${UNKNOWN_MODEL}/invoke-with-response-stream`, {
      messages: [{ role: "user", content: [{ type: "text", text: "think" }] }],
      max_tokens: 1024,
      anthropic_version: "bedrock-2023-05-31",
    });

    expect(res.status).toBe(200);
    expect(hasInvokeThinkingDelta(decodeEventStreamFrames(res.body))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Bedrock Converse — non-streaming
// ---------------------------------------------------------------------------

describe("Bedrock Converse reasoning capability gating (non-streaming)", () => {
  it("emits reasoningContent block for a reasoning-capable model", async () => {
    const res = await post(`/model/${REASONING_MODEL}/converse`, {
      messages: [{ role: "user", content: [{ text: "think" }] }],
    });

    expect(res.status).toBe(200);
    const content = JSON.parse(res.body).output.message.content;
    expect(content[0].reasoningContent).toBeDefined();
    expect(content[0].reasoningContent.reasoningText.text).toBe(
      "Let me think step by step about this problem.",
    );
  });

  it("non-reasoning model + strict OFF: still emits reasoningContent + warns", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await post(`/model/${NON_REASONING_MODEL}/converse`, {
      messages: [{ role: "user", content: [{ text: "think" }] }],
    });

    expect(res.status).toBe(200);
    const content = JSON.parse(res.body).output.message.content;
    expect(content[0].reasoningContent).toBeDefined();
    expect(warnSpy.mock.calls.flat().join(" ").includes("not reasoning-capable")).toBe(true);
  });

  it("non-reasoning model + strict ON: suppresses reasoningContent", async () => {
    const res = await post(
      `/model/${NON_REASONING_MODEL}/converse`,
      { messages: [{ role: "user", content: [{ text: "think" }] }] },
      { "X-AIMock-Strict": "true" },
    );

    expect(res.status).toBe(200);
    const content = JSON.parse(res.body).output.message.content;
    expect(content).toHaveLength(1);
    expect(content[0].reasoningContent).toBeUndefined();
    expect(content[0].text).toBe("The answer is 42.");
  });

  it("unknown model: emits reasoningContent (fail open)", async () => {
    const res = await post(`/model/${UNKNOWN_MODEL}/converse`, {
      messages: [{ role: "user", content: [{ text: "think" }] }],
    });

    expect(res.status).toBe(200);
    const content = JSON.parse(res.body).output.message.content;
    expect(content[0].reasoningContent).toBeDefined();
  });

  it("content+tool calls: non-reasoning model + strict ON suppresses reasoningContent", async () => {
    const res = await post(
      `/model/${NON_REASONING_MODEL}/converse`,
      { messages: [{ role: "user", content: [{ text: "reason-and-call" }] }] },
      { "X-AIMock-Strict": "true" },
    );

    expect(res.status).toBe(200);
    const content = JSON.parse(res.body).output.message.content as Array<Record<string, unknown>>;
    expect(content.some((b) => "reasoningContent" in b)).toBe(false);
    expect(content.some((b) => "toolUse" in b)).toBe(true);
  });

  it("reasoning absent: no reasoningContent, no gating log", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await post(`/model/${NON_REASONING_MODEL}/converse`, {
      messages: [{ role: "user", content: [{ text: "plain" }] }],
    });

    expect(res.status).toBe(200);
    const content = JSON.parse(res.body).output.message.content;
    expect(content).toHaveLength(1);
    expect(content[0].reasoningContent).toBeUndefined();
    expect(warnSpy.mock.calls.flat().join(" ").includes("not reasoning-capable")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Bedrock Converse — streaming
// ---------------------------------------------------------------------------

describe("Bedrock Converse reasoning capability gating (streaming)", () => {
  it("emits reasoningContent delta for a reasoning-capable model", async () => {
    const res = await postRaw(`/model/${REASONING_MODEL}/converse-stream`, {
      messages: [{ role: "user", content: [{ text: "think" }] }],
    });

    expect(res.status).toBe(200);
    expect(hasConverseReasoningDelta(decodeEventStreamFrames(res.body))).toBe(true);
  });

  it("non-reasoning model + strict OFF: still emits reasoningContent delta + warns", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await postRaw(`/model/${NON_REASONING_MODEL}/converse-stream`, {
      messages: [{ role: "user", content: [{ text: "think" }] }],
    });

    expect(res.status).toBe(200);
    expect(hasConverseReasoningDelta(decodeEventStreamFrames(res.body))).toBe(true);
    expect(warnSpy.mock.calls.flat().join(" ").includes("not reasoning-capable")).toBe(true);
  });

  it("non-reasoning model + strict ON: suppresses reasoningContent delta", async () => {
    const res = await postRaw(
      `/model/${NON_REASONING_MODEL}/converse-stream`,
      { messages: [{ role: "user", content: [{ text: "think" }] }] },
      { "X-AIMock-Strict": "true" },
    );

    expect(res.status).toBe(200);
    expect(hasConverseReasoningDelta(decodeEventStreamFrames(res.body))).toBe(false);
  });

  it("content+tool calls: non-reasoning model + strict ON suppresses reasoningContent delta", async () => {
    const res = await postRaw(
      `/model/${NON_REASONING_MODEL}/converse-stream`,
      { messages: [{ role: "user", content: [{ text: "reason-and-call" }] }] },
      { "X-AIMock-Strict": "true" },
    );

    expect(res.status).toBe(200);
    expect(hasConverseReasoningDelta(decodeEventStreamFrames(res.body))).toBe(false);
  });

  it("unknown model: emits reasoningContent delta (fail open)", async () => {
    const res = await postRaw(`/model/${UNKNOWN_MODEL}/converse-stream`, {
      messages: [{ role: "user", content: [{ text: "think" }] }],
    });

    expect(res.status).toBe(200);
    expect(hasConverseReasoningDelta(decodeEventStreamFrames(res.body))).toBe(true);
  });
});
