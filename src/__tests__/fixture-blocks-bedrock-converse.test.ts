import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as http from "node:http";
import { crc32 } from "node:zlib";
import type { Fixture } from "../types.js";
import { createServer, type ServerInstance } from "../server.js";

// ---------------------------------------------------------------------------
// REPLAY block-ordering for the Bedrock Converse provider (#274 completion).
//
// Converse emits positional/ordered content: `output.message.content` is an
// ARRAY (non-stream), and `contentBlockStart`/`contentBlockDelta` events carry
// an explicit `contentBlockIndex` (stream). Both surfaces are order-observable,
// so tool-first ordering (`toolUse` before `text`) IS wire-expressible — the
// fixture's `blocks` array drives the emitted order.
//
// Mirrors the harness in bedrock-converse-toolonly-reasoning.test.ts.
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
 * Returns an array of { eventType, payload } objects in wire order.
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

// Index of the first contentBlockStart frame that begins a `text` block.
function firstTextStartIndex(frames: Array<{ eventType: string; payload: object }>): number {
  return frames.findIndex(
    (f) =>
      f.eventType === "contentBlockStart" &&
      (f.payload as { start?: { toolUse?: unknown } }).start?.toolUse === undefined,
  );
}

// Index of the first contentBlockStart frame that begins a `toolUse` block.
function firstToolUseStartIndex(frames: Array<{ eventType: string; payload: object }>): number {
  return frames.findIndex(
    (f) =>
      f.eventType === "contentBlockStart" &&
      (f.payload as { start?: { toolUse?: unknown } }).start?.toolUse !== undefined,
  );
}

const MODEL = "anthropic.claude-3-5-sonnet-20241022-v2:0";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// tool-first combined fixture: `blocks` orders toolCall BEFORE text. The
// legacy {content, toolCalls} fields are also present so back-compat callers
// (no blocks) would still match — but with blocks present, ordering wins.
const toolFirstBlocksFixture: Fixture = {
  match: { userMessage: "tool-first" },
  response: {
    content: "Here is the weather.",
    toolCalls: [{ name: "get_weather", arguments: '{"city":"SF"}' }],
    blocks: [
      { type: "toolCall", name: "get_weather", arguments: '{"city":"SF"}' },
      { type: "text", text: "Here is the weather." },
    ],
  },
};

// blocks-only fixture (post-F0): no content/toolCalls, ordered tool-first.
const blocksOnlyFixture: Fixture = {
  match: { userMessage: "blocks-only-fixture" },
  response: {
    blocks: [
      { type: "toolCall", name: "lookup", arguments: '{"q":"x"}' },
      { type: "text", text: "Done looking up." },
    ],
  },
};

// back-compat fixture: legacy combined shape, NO blocks. Must emit the
// unchanged text-first legacy ordering.
const legacyFixture: Fixture = {
  match: { userMessage: "legacy-combined" },
  response: {
    content: "Legacy text first.",
    toolCalls: [{ name: "get_weather", arguments: '{"city":"NY"}' }],
  },
};

const allFixtures: Fixture[] = [toolFirstBlocksFixture, blocksOnlyFixture, legacyFixture];

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
// Non-streaming: content array ordering
// ---------------------------------------------------------------------------

describe("Bedrock Converse blocks ordering (non-streaming)", () => {
  it("tool-first: toolUse precedes text in the content array", async () => {
    const res = await post(`/model/${MODEL}/converse`, {
      messages: [{ role: "user", content: [{ text: "tool-first" }] }],
    });

    expect(res.status).toBe(200);
    const content = JSON.parse(res.body).output.message.content as Array<Record<string, unknown>>;
    const toolIdx = content.findIndex((b) => "toolUse" in b);
    const textIdx = content.findIndex((b) => "text" in b);
    expect(toolIdx).toBeGreaterThanOrEqual(0);
    expect(textIdx).toBeGreaterThanOrEqual(0);
    // tool-first: toolUse block comes BEFORE the text block.
    expect(toolIdx).toBeLessThan(textIdx);

    const toolUse = content[toolIdx].toolUse as { name: string; input: unknown };
    expect(toolUse.name).toBe("get_weather");
    expect(toolUse.input).toEqual({ city: "SF" });
    expect((content[textIdx] as { text: string }).text).toBe("Here is the weather.");
  });

  it("blocks-only fixture: toolUse precedes text in the content array", async () => {
    const res = await post(`/model/${MODEL}/converse`, {
      messages: [{ role: "user", content: [{ text: "blocks-only-fixture" }] }],
    });

    expect(res.status).toBe(200);
    const content = JSON.parse(res.body).output.message.content as Array<Record<string, unknown>>;
    const toolIdx = content.findIndex((b) => "toolUse" in b);
    const textIdx = content.findIndex((b) => "text" in b);
    expect(toolIdx).toBeGreaterThanOrEqual(0);
    expect(textIdx).toBeGreaterThanOrEqual(0);
    expect(toolIdx).toBeLessThan(textIdx);
    expect((content[toolIdx].toolUse as { name: string }).name).toBe("lookup");
    expect((content[textIdx] as { text: string }).text).toBe("Done looking up.");
  });

  it("back-compat: no-blocks fixture emits unchanged text-first legacy order", async () => {
    const res = await post(`/model/${MODEL}/converse`, {
      messages: [{ role: "user", content: [{ text: "legacy-combined" }] }],
    });

    expect(res.status).toBe(200);
    const content = JSON.parse(res.body).output.message.content as Array<Record<string, unknown>>;
    const toolIdx = content.findIndex((b) => "toolUse" in b);
    const textIdx = content.findIndex((b) => "text" in b);
    // legacy: text block leads, toolUse follows.
    expect(textIdx).toBeLessThan(toolIdx);
    expect((content[textIdx] as { text: string }).text).toBe("Legacy text first.");
    expect((content[toolIdx].toolUse as { name: string }).name).toBe("get_weather");
  });
});

// ---------------------------------------------------------------------------
// Streaming: contentBlock event ordering
// ---------------------------------------------------------------------------

describe("Bedrock Converse blocks ordering (streaming)", () => {
  it("tool-first: toolUse contentBlockStart precedes text contentBlockStart", async () => {
    const res = await postRaw(`/model/${MODEL}/converse-stream`, {
      messages: [{ role: "user", content: [{ text: "tool-first" }] }],
    });

    expect(res.status).toBe(200);
    const frames = decodeEventStreamFrames(res.body);
    const toolStart = firstToolUseStartIndex(frames);
    const textStart = firstTextStartIndex(frames);
    expect(toolStart).toBeGreaterThanOrEqual(0);
    expect(textStart).toBeGreaterThanOrEqual(0);
    // tool-first: the toolUse block opens BEFORE the text block.
    expect(toolStart).toBeLessThan(textStart);

    // contentBlockIndex follows encounter order: toolUse=0, text=1.
    expect((frames[toolStart].payload as { contentBlockIndex: number }).contentBlockIndex).toBe(0);
    expect((frames[textStart].payload as { contentBlockIndex: number }).contentBlockIndex).toBe(1);
  });

  it("blocks-only fixture streams tool-first", async () => {
    const res = await postRaw(`/model/${MODEL}/converse-stream`, {
      messages: [{ role: "user", content: [{ text: "blocks-only-fixture" }] }],
    });

    expect(res.status).toBe(200);
    const frames = decodeEventStreamFrames(res.body);
    const toolStart = firstToolUseStartIndex(frames);
    const textStart = firstTextStartIndex(frames);
    expect(toolStart).toBeGreaterThanOrEqual(0);
    expect(textStart).toBeGreaterThanOrEqual(0);
    expect(toolStart).toBeLessThan(textStart);
    expect(
      (frames[toolStart].payload as { start: { toolUse: { name: string } } }).start.toolUse.name,
    ).toBe("lookup");
  });

  it("back-compat: no-blocks fixture streams unchanged text-first legacy order", async () => {
    const res = await postRaw(`/model/${MODEL}/converse-stream`, {
      messages: [{ role: "user", content: [{ text: "legacy-combined" }] }],
    });

    expect(res.status).toBe(200);
    const frames = decodeEventStreamFrames(res.body);
    const toolStart = firstToolUseStartIndex(frames);
    const textStart = firstTextStartIndex(frames);
    // legacy: text block opens first (index 0), toolUse follows (index 1).
    expect(textStart).toBeLessThan(toolStart);
    expect((frames[textStart].payload as { contentBlockIndex: number }).contentBlockIndex).toBe(0);
    expect((frames[toolStart].payload as { contentBlockIndex: number }).contentBlockIndex).toBe(1);
  });
});
