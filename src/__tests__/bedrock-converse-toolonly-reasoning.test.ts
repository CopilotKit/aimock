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

// Predicates over decoded Converse stream frames
function hasConverseReasoningDelta(frames: Array<{ eventType: string; payload: object }>): boolean {
  return frames.some(
    (f) =>
      f.eventType === "contentBlockDelta" &&
      (f.payload as { delta?: { reasoningContent?: unknown } }).delta?.reasoningContent !==
        undefined,
  );
}

function hasConverseToolUseStart(frames: Array<{ eventType: string; payload: object }>): boolean {
  return frames.some(
    (f) =>
      f.eventType === "contentBlockStart" &&
      (f.payload as { start?: { toolUse?: unknown } }).start?.toolUse !== undefined,
  );
}

// ---------------------------------------------------------------------------
// Fixtures — tool-call-only path (no `content` string)
// ---------------------------------------------------------------------------

const toolOnlyReasoningFixture: Fixture = {
  match: { userMessage: "reason-then-call" },
  response: {
    reasoning: "I should call get_weather to find out.",
    toolCalls: [{ name: "get_weather", arguments: '{"city":"SF"}' }],
  },
};

const toolOnlyPlainFixture: Fixture = {
  match: { userMessage: "just-call" },
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
// Bedrock Converse tool-only — non-streaming
// ---------------------------------------------------------------------------

describe("Bedrock Converse tool-only reasoning capability gating (non-streaming)", () => {
  it("emits reasoningContent block for a reasoning-capable model", async () => {
    const res = await post(`/model/${REASONING_MODEL}/converse`, {
      messages: [{ role: "user", content: [{ text: "reason-then-call" }] }],
    });

    expect(res.status).toBe(200);
    const content = JSON.parse(res.body).output.message.content as Array<Record<string, unknown>>;
    expect(content[0].reasoningContent).toBeDefined();
    expect(
      (content[0].reasoningContent as { reasoningText: { text: string } }).reasoningText.text,
    ).toBe("I should call get_weather to find out.");
    // reasoning block precedes the toolUse block
    expect(content.some((b) => "toolUse" in b)).toBe(true);
    expect("reasoningContent" in content[0]).toBe(true);
    expect("toolUse" in content[content.length - 1]).toBe(true);
  });

  it("non-reasoning model + strict OFF: still emits reasoningContent + warns", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await post(`/model/${NON_REASONING_MODEL}/converse`, {
      messages: [{ role: "user", content: [{ text: "reason-then-call" }] }],
    });

    expect(res.status).toBe(200);
    const content = JSON.parse(res.body).output.message.content as Array<Record<string, unknown>>;
    expect(content[0].reasoningContent).toBeDefined();
    expect(warnSpy.mock.calls.flat().join(" ").includes("not reasoning-capable")).toBe(true);
  });

  it("non-reasoning model + strict ON: suppresses reasoningContent", async () => {
    const res = await post(
      `/model/${NON_REASONING_MODEL}/converse`,
      { messages: [{ role: "user", content: [{ text: "reason-then-call" }] }] },
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
      messages: [{ role: "user", content: [{ text: "just-call" }] }],
    });

    expect(res.status).toBe(200);
    const content = JSON.parse(res.body).output.message.content as Array<Record<string, unknown>>;
    expect(content.some((b) => "reasoningContent" in b)).toBe(false);
    expect(content.some((b) => "toolUse" in b)).toBe(true);
    expect(warnSpy.mock.calls.flat().join(" ").includes("not reasoning-capable")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Bedrock Converse tool-only — streaming
// ---------------------------------------------------------------------------

describe("Bedrock Converse tool-only reasoning capability gating (streaming)", () => {
  it("emits reasoningContent delta for a reasoning-capable model", async () => {
    const res = await postRaw(`/model/${REASONING_MODEL}/converse-stream`, {
      messages: [{ role: "user", content: [{ text: "reason-then-call" }] }],
    });

    expect(res.status).toBe(200);
    const frames = decodeEventStreamFrames(res.body);
    expect(hasConverseReasoningDelta(frames)).toBe(true);
    expect(hasConverseToolUseStart(frames)).toBe(true);
  });

  it("non-reasoning model + strict OFF: still emits reasoningContent delta + warns", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await postRaw(`/model/${NON_REASONING_MODEL}/converse-stream`, {
      messages: [{ role: "user", content: [{ text: "reason-then-call" }] }],
    });

    expect(res.status).toBe(200);
    expect(hasConverseReasoningDelta(decodeEventStreamFrames(res.body))).toBe(true);
    expect(warnSpy.mock.calls.flat().join(" ").includes("not reasoning-capable")).toBe(true);
  });

  it("non-reasoning model + strict ON: suppresses reasoningContent delta", async () => {
    const res = await postRaw(
      `/model/${NON_REASONING_MODEL}/converse-stream`,
      { messages: [{ role: "user", content: [{ text: "reason-then-call" }] }] },
      { "X-AIMock-Strict": "true" },
    );

    expect(res.status).toBe(200);
    const frames = decodeEventStreamFrames(res.body);
    expect(hasConverseReasoningDelta(frames)).toBe(false);
    expect(hasConverseToolUseStart(frames)).toBe(true);
  });

  it("reasoning absent: no reasoningContent delta", async () => {
    const res = await postRaw(`/model/${NON_REASONING_MODEL}/converse-stream`, {
      messages: [{ role: "user", content: [{ text: "just-call" }] }],
    });

    expect(res.status).toBe(200);
    const frames = decodeEventStreamFrames(res.body);
    expect(hasConverseReasoningDelta(frames)).toBe(false);
    expect(hasConverseToolUseStart(frames)).toBe(true);
  });

  it("contentBlockIndex ordering: reasoning block at index 0, toolUse blocks shifted by +1", async () => {
    const res = await postRaw(`/model/${REASONING_MODEL}/converse-stream`, {
      messages: [{ role: "user", content: [{ text: "reason-then-call" }] }],
    });

    expect(res.status).toBe(200);
    const frames = decodeEventStreamFrames(res.body);

    // Reasoning block occupies contentBlockIndex 0.
    const reasoningStart = frames.find(
      (f) =>
        f.eventType === "contentBlockStart" &&
        (f.payload as { start?: { reasoningContent?: unknown } }).start?.reasoningContent !==
          undefined,
    );
    expect(reasoningStart).toBeDefined();
    expect((reasoningStart!.payload as { contentBlockIndex: number }).contentBlockIndex).toBe(0);

    // The single toolUse block is shifted to contentBlockIndex 1 (not 0).
    const toolUseStart = frames.find(
      (f) =>
        f.eventType === "contentBlockStart" &&
        (f.payload as { start?: { toolUse?: unknown } }).start?.toolUse !== undefined,
    );
    expect(toolUseStart).toBeDefined();
    expect((toolUseStart!.payload as { contentBlockIndex: number }).contentBlockIndex).toBe(1);

    // All reasoning frames carry index 0; the toolUse delta/stop carry index 1.
    const reasoningDelta = frames.find(
      (f) =>
        f.eventType === "contentBlockDelta" &&
        (f.payload as { delta?: { reasoningContent?: unknown } }).delta?.reasoningContent !==
          undefined,
    );
    expect((reasoningDelta!.payload as { contentBlockIndex: number }).contentBlockIndex).toBe(0);

    const toolUseDelta = frames.find(
      (f) =>
        f.eventType === "contentBlockDelta" &&
        (f.payload as { delta?: { toolUse?: unknown } }).delta?.toolUse !== undefined,
    );
    expect((toolUseDelta!.payload as { contentBlockIndex: number }).contentBlockIndex).toBe(1);
  });
});
