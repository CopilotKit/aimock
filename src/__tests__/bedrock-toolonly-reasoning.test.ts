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

interface StreamFrame {
  eventType: string;
  payload: {
    type?: string;
    index?: number;
    delta?: { type?: string };
    content_block?: { type?: string };
  };
}

/**
 * Decode AWS Event Stream binary frames from a Buffer.
 * Returns an array of { eventType, payload } objects.
 */
function decodeEventStreamFrames(buf: Buffer): StreamFrame[] {
  const frames: StreamFrame[] = [];
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

function hasInvokeThinkingDelta(frames: StreamFrame[]): boolean {
  return frames.some(
    (f) => f.payload.type === "content_block_delta" && f.payload.delta?.type === "thinking_delta",
  );
}

// ---------------------------------------------------------------------------
// Fixtures — tool-only responses (toolCalls present, no `content`)
// ---------------------------------------------------------------------------

const toolOnlyReasoningFixture: Fixture = {
  match: { userMessage: "tool-think" },
  response: {
    reasoning: "I should call get_weather to answer this.",
    toolCalls: [{ name: "get_weather", arguments: '{"city":"SF"}' }],
  },
};

const toolOnlyPlainFixture: Fixture = {
  match: { userMessage: "tool-plain" },
  response: {
    toolCalls: [{ name: "get_weather", arguments: '{"city":"SF"}' }],
  },
};

const allFixtures: Fixture[] = [toolOnlyReasoningFixture, toolOnlyPlainFixture];

// Model ids carrying Bedrock provider prefixes.
const REASONING_MODEL = "anthropic.claude-opus-4-20250514-v1:0"; // Claude 4 → reasoning-capable
const NON_REASONING_MODEL = "anthropic.claude-3-5-sonnet-20241022-v2:0"; // 3.5 → not reasoning-capable

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
// Bedrock InvokeModel tool-only — non-streaming
// ---------------------------------------------------------------------------

describe("Bedrock InvokeModel tool-only reasoning capability gating (non-streaming)", () => {
  it("emits a thinking block before tool_use for a reasoning-capable model", async () => {
    const res = await post(`/model/${REASONING_MODEL}/invoke`, {
      messages: [{ role: "user", content: [{ type: "text", text: "tool-think" }] }],
      max_tokens: 1024,
      anthropic_version: "bedrock-2023-05-31",
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    const types = (body.content as Array<{ type: string }>).map((b) => b.type);
    expect(types[0]).toBe("thinking");
    expect(body.content[0].thinking).toBe("I should call get_weather to answer this.");
    expect(types).toContain("tool_use");
    expect(body.stop_reason).toBe("tool_use");
  });

  it("non-reasoning model + strict OFF: still emits thinking and logs a warning", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await post(`/model/${NON_REASONING_MODEL}/invoke`, {
      messages: [{ role: "user", content: [{ type: "text", text: "tool-think" }] }],
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
        messages: [{ role: "user", content: [{ type: "text", text: "tool-think" }] }],
        max_tokens: 1024,
        anthropic_version: "bedrock-2023-05-31",
      },
      { "X-AIMock-Strict": "true" },
    );

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    const types = (body.content as Array<{ type: string }>).map((b) => b.type);
    expect(types).not.toContain("thinking");
    expect(types).toContain("tool_use");
  });

  it("reasoning absent: no thinking block, no gating log", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await post(`/model/${NON_REASONING_MODEL}/invoke`, {
      messages: [{ role: "user", content: [{ type: "text", text: "tool-plain" }] }],
      max_tokens: 1024,
      anthropic_version: "bedrock-2023-05-31",
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    const types = (body.content as Array<{ type: string }>).map((b) => b.type);
    expect(types).not.toContain("thinking");
    expect(types).toContain("tool_use");
    expect(warnSpy.mock.calls.flat().join(" ").includes("not reasoning-capable")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Bedrock InvokeModel tool-only — streaming
// ---------------------------------------------------------------------------

describe("Bedrock InvokeModel tool-only reasoning capability gating (streaming)", () => {
  it("emits thinking_delta for a reasoning-capable model", async () => {
    const res = await postRaw(`/model/${REASONING_MODEL}/invoke-with-response-stream`, {
      messages: [{ role: "user", content: [{ type: "text", text: "tool-think" }] }],
      max_tokens: 1024,
      anthropic_version: "bedrock-2023-05-31",
    });

    expect(res.status).toBe(200);
    expect(hasInvokeThinkingDelta(decodeEventStreamFrames(res.body))).toBe(true);
  });

  it("non-reasoning model + strict OFF: still emits thinking_delta + warns", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await postRaw(`/model/${NON_REASONING_MODEL}/invoke-with-response-stream`, {
      messages: [{ role: "user", content: [{ type: "text", text: "tool-think" }] }],
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
        messages: [{ role: "user", content: [{ type: "text", text: "tool-think" }] }],
        max_tokens: 1024,
        anthropic_version: "bedrock-2023-05-31",
      },
      { "X-AIMock-Strict": "true" },
    );

    expect(res.status).toBe(200);
    expect(hasInvokeThinkingDelta(decodeEventStreamFrames(res.body))).toBe(false);
  });

  it("reasoning absent: no thinking_delta", async () => {
    const res = await postRaw(`/model/${NON_REASONING_MODEL}/invoke-with-response-stream`, {
      messages: [{ role: "user", content: [{ type: "text", text: "tool-plain" }] }],
      max_tokens: 1024,
      anthropic_version: "bedrock-2023-05-31",
    });

    expect(res.status).toBe(200);
    expect(hasInvokeThinkingDelta(decodeEventStreamFrames(res.body))).toBe(false);
  });

  it("block-index ordering: leading thinking block shifts tool_use to index 1", async () => {
    const res = await postRaw(`/model/${REASONING_MODEL}/invoke-with-response-stream`, {
      messages: [{ role: "user", content: [{ type: "text", text: "tool-think" }] }],
      max_tokens: 1024,
      anthropic_version: "bedrock-2023-05-31",
    });

    expect(res.status).toBe(200);
    const frames = decodeEventStreamFrames(res.body);

    const starts = frames.filter((f) => f.payload.type === "content_block_start");
    // First content_block_start is the thinking block at index 0.
    expect(starts[0].payload.index).toBe(0);
    expect(starts[0].payload.content_block?.type).toBe("thinking");
    // The tool_use block must follow at index 1 (shifted by the leading thinking block).
    const toolStart = starts.find((f) => f.payload.content_block?.type === "tool_use");
    expect(toolStart).toBeDefined();
    expect(toolStart!.payload.index).toBe(1);

    // Indices must be contiguous and unique across all content_block_start frames.
    const indices = starts.map((f) => f.payload.index);
    expect(indices).toEqual([...Array(starts.length).keys()]);
  });

  it("block-index ordering: without reasoning, tool_use stays at index 0", async () => {
    const res = await postRaw(`/model/${REASONING_MODEL}/invoke-with-response-stream`, {
      messages: [{ role: "user", content: [{ type: "text", text: "tool-plain" }] }],
      max_tokens: 1024,
      anthropic_version: "bedrock-2023-05-31",
    });

    expect(res.status).toBe(200);
    const frames = decodeEventStreamFrames(res.body);
    const starts = frames.filter((f) => f.payload.type === "content_block_start");
    expect(starts[0].payload.content_block?.type).toBe("tool_use");
    expect(starts[0].payload.index).toBe(0);
  });
});
