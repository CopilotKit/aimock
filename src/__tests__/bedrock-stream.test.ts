import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import { crc32 } from "node:zlib";
import type { Fixture, HandlerDefaults } from "../types.js";
import { createServer, type ServerInstance } from "../server.js";
import {
  converseToCompletionRequest,
  handleConverse,
  handleConverseStream,
} from "../bedrock-converse.js";
import { Journal } from "../journal.js";
import { Logger } from "../logger.js";

// --- helpers ---

function post(
  url: string,
  body: unknown,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
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

function postBinary(
  url: string,
  body: unknown,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
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
 * Parse sequential binary Event Stream frames from a buffer.
 */
interface ParsedFrame {
  eventType: string;
  messageType: string;
  payload: unknown;
  preludeCrc: { expected: number; actual: number };
  messageCrc: { expected: number; actual: number };
}

function parseFrames(buf: Buffer): ParsedFrame[] {
  const frames: ParsedFrame[] = [];
  let offset = 0;

  while (offset < buf.length) {
    const totalLength = buf.readUInt32BE(offset);
    const frame = buf.subarray(offset, offset + totalLength);

    // Compute CRCs for later assertion
    const computedPreludeCrc = crc32(frame.subarray(0, 8)) >>> 0;
    const storedPreludeCrc = frame.readUInt32BE(8);
    const computedMessageCrc = crc32(frame.subarray(0, totalLength - 4)) >>> 0;
    const storedMessageCrc = frame.readUInt32BE(totalLength - 4);

    // Parse headers
    const headersLength = frame.readUInt32BE(4);
    const headersStart = 12;
    const headersEnd = headersStart + headersLength;
    const headers: Record<string, string> = {};
    let hOffset = headersStart;
    while (hOffset < headersEnd) {
      const nameLen = frame.readUInt8(hOffset);
      hOffset += 1;
      const name = frame.subarray(hOffset, hOffset + nameLen).toString("utf8");
      hOffset += nameLen;
      hOffset += 1; // type byte (7 = STRING)
      const valueLen = frame.readUInt16BE(hOffset);
      hOffset += 2;
      const value = frame.subarray(hOffset, hOffset + valueLen).toString("utf8");
      hOffset += valueLen;
      headers[name] = value;
    }

    // Parse payload
    const payloadStart = headersEnd;
    const payloadEnd = totalLength - 4;
    const payloadBuf = frame.subarray(payloadStart, payloadEnd);
    let payload: unknown = null;
    if (payloadBuf.length > 0) {
      payload = JSON.parse(payloadBuf.toString("utf8"));
    }

    frames.push({
      eventType: headers[":event-type"] ?? "",
      messageType: headers[":message-type"] ?? "",
      payload,
      preludeCrc: { expected: storedPreludeCrc, actual: computedPreludeCrc },
      messageCrc: { expected: storedMessageCrc, actual: computedMessageCrc },
    });

    offset += totalLength;
  }

  return frames;
}

function postPartialBinary(
  url: string,
  body: unknown,
): Promise<{ body: Buffer; aborted: boolean }> {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const parsed = new URL(url);
    const chunks: Buffer[] = [];
    let aborted = false;
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({ body: Buffer.concat(chunks), aborted });
        });
        res.on("error", () => {
          aborted = true;
        });
        res.on("aborted", () => {
          aborted = true;
        });
        res.on("close", () => {
          resolve({ body: Buffer.concat(chunks), aborted });
        });
      },
    );
    req.on("error", () => {
      aborted = true;
      resolve({ body: Buffer.concat(chunks), aborted });
    });
    req.write(data);
    req.end();
  });
}

// --- fixtures ---

const textFixture: Fixture = {
  match: { userMessage: "hello" },
  response: { content: "Hi there!" },
};

const toolFixture: Fixture = {
  match: { userMessage: "weather" },
  response: {
    toolCalls: [
      {
        name: "get_weather",
        arguments: '{"city":"SF"}',
      },
    ],
  },
};

const errorFixture: Fixture = {
  match: { userMessage: "fail" },
  response: {
    error: {
      message: "Rate limited",
      type: "rate_limit_error",
    },
    status: 429,
  },
};

const allFixtures: Fixture[] = [textFixture, toolFixture, errorFixture];

// --- test lifecycle ---

let instance: ServerInstance | null = null;

afterEach(async () => {
  if (instance) {
    await new Promise<void>((resolve) => {
      instance!.server.close(() => resolve());
    });
    instance = null;
  }
});

// ─── invoke-with-response-stream ────────────────────────────────────────────

describe("POST /model/{modelId}/invoke-with-response-stream", () => {
  const MODEL_ID = "anthropic.claude-3-5-sonnet-20241022-v2:0";

  it("returns text response as binary Event Stream frames", async () => {
    instance = await createServer(allFixtures);
    const res = await postBinary(`${instance.url}/model/${MODEL_ID}/invoke-with-response-stream`, {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 512,
      messages: [{ role: "user", content: "hello" }],
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/vnd.amazon.eventstream");

    const frames = parseFrames(res.body);
    expect(frames.length).toBeGreaterThanOrEqual(5);

    // messageStart
    expect(frames[0].eventType).toBe("messageStart");
    expect(frames[0].payload).toEqual({ role: "assistant" });

    // contentBlockStart
    expect(frames[1].eventType).toBe("contentBlockStart");
    expect(frames[1].payload).toEqual({ contentBlockIndex: 0, start: {} });

    // Content delta(s) — collect text
    const deltas = frames.filter((f) => f.eventType === "contentBlockDelta");
    expect(deltas.length).toBeGreaterThanOrEqual(1);
    const fullText = deltas
      .map((f) => (f.payload as { delta: { text: string } }).delta.text)
      .join("");
    expect(fullText).toBe("Hi there!");

    // contentBlockStop
    const stopBlock = frames.find((f) => f.eventType === "contentBlockStop");
    expect(stopBlock).toBeDefined();
    expect(stopBlock!.payload).toEqual({ contentBlockIndex: 0 });

    // messageStop
    const msgStop = frames.find((f) => f.eventType === "messageStop");
    expect(msgStop).toBeDefined();
    expect(msgStop!.payload).toEqual({ stopReason: "end_turn" });
  });

  it("returns tool call response as binary Event Stream frames", async () => {
    instance = await createServer(allFixtures);
    const res = await postBinary(`${instance.url}/model/${MODEL_ID}/invoke-with-response-stream`, {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 512,
      messages: [{ role: "user", content: "weather" }],
    });

    expect(res.status).toBe(200);
    const frames = parseFrames(res.body);

    // messageStart
    expect(frames[0].eventType).toBe("messageStart");
    expect(frames[0].payload).toEqual({ role: "assistant" });

    // contentBlockStart with toolUse
    expect(frames[1].eventType).toBe("contentBlockStart");
    const startPayload = frames[1].payload as {
      contentBlockIndex: number;
      start: { toolUse: { toolUseId: string; name: string } };
    };
    expect(startPayload.contentBlockIndex).toBe(0);
    expect(startPayload.start.toolUse.name).toBe("get_weather");
    expect(startPayload.start.toolUse.toolUseId).toBeDefined();

    // contentBlockDelta(s) with input_json_delta
    const deltas = frames.filter((f) => f.eventType === "contentBlockDelta");
    expect(deltas.length).toBeGreaterThanOrEqual(1);
    const fullJson = deltas
      .map((f) => (f.payload as { delta: { inputJSON: string } }).delta.inputJSON)
      .join("");
    expect(JSON.parse(fullJson)).toEqual({ city: "SF" });

    // messageStop
    const msgStop = frames.find((f) => f.eventType === "messageStop");
    expect(msgStop!.payload).toEqual({ stopReason: "tool_use" });
  });

  it("Content-Type is application/vnd.amazon.eventstream", async () => {
    instance = await createServer(allFixtures);
    const res = await postBinary(`${instance.url}/model/${MODEL_ID}/invoke-with-response-stream`, {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 512,
      messages: [{ role: "user", content: "hello" }],
    });

    expect(res.headers["content-type"]).toBe("application/vnd.amazon.eventstream");
  });

  it("binary frames have valid CRC32 checksums", async () => {
    instance = await createServer(allFixtures);
    const res = await postBinary(`${instance.url}/model/${MODEL_ID}/invoke-with-response-stream`, {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 512,
      messages: [{ role: "user", content: "hello" }],
    });

    const frames = parseFrames(res.body);
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      expect(frame.preludeCrc.actual).toBe(frame.preludeCrc.expected);
      expect(frame.messageCrc.actual).toBe(frame.messageCrc.expected);
    }
  });

  it("returns error fixture with correct status", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/model/${MODEL_ID}/invoke-with-response-stream`, {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 512,
      messages: [{ role: "user", content: "fail" }],
    });

    expect(res.status).toBe(429);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("Rate limited");
  });

  it("returns 404 when no fixture matches", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/model/${MODEL_ID}/invoke-with-response-stream`, {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 512,
      messages: [{ role: "user", content: "nomatch" }],
    });

    expect(res.status).toBe(404);
  });

  it("returns 400 for malformed JSON", async () => {
    instance = await createServer(allFixtures);
    const parsed = new URL(`${instance.url}/model/${MODEL_ID}/invoke-with-response-stream`);
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const raw = "{not valid";
      const req = http.request(
        {
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.pathname,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(raw),
          },
        },
        (r) => {
          const chunks: Buffer[] = [];
          r.on("data", (c: Buffer) => chunks.push(c));
          r.on("end", () => {
            resolve({
              status: r.statusCode ?? 0,
              body: Buffer.concat(chunks).toString(),
            });
          });
        },
      );
      req.on("error", reject);
      req.write(raw);
      req.end();
    });

    expect(res.status).toBe(400);
  });
});

// ─── invoke-with-response-stream: missing messages ──────────────────────────

describe("POST /model/{modelId}/invoke-with-response-stream (missing messages)", () => {
  const MODEL_ID = "anthropic.claude-3-5-sonnet-20241022-v2:0";

  it("23. returns 400 for empty body (no messages)", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/model/${MODEL_ID}/invoke-with-response-stream`, {});

    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.message).toContain("messages");
  });
});

// ─── invoke-with-response-stream: multiple tool calls ───────────────────────

describe("POST /model/{modelId}/invoke-with-response-stream (multiple tool calls)", () => {
  const MODEL_ID = "anthropic.claude-3-5-sonnet-20241022-v2:0";

  it("24. emits correct contentBlockIndex for 2 tool calls", async () => {
    const multiToolFixture: Fixture = {
      match: { userMessage: "multi-tool" },
      response: {
        toolCalls: [
          { name: "get_weather", arguments: '{"city":"NYC"}' },
          { name: "get_time", arguments: '{"tz":"EST"}' },
        ],
      },
    };
    instance = await createServer([multiToolFixture]);
    const res = await postBinary(`${instance.url}/model/${MODEL_ID}/invoke-with-response-stream`, {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 512,
      messages: [{ role: "user", content: "multi-tool" }],
    });

    expect(res.status).toBe(200);
    const frames = parseFrames(res.body);

    // Find contentBlockStart frames
    const blockStarts = frames.filter((f) => f.eventType === "contentBlockStart");
    expect(blockStarts.length).toBeGreaterThanOrEqual(2);

    // First tool at contentBlockIndex 0
    const start0 = blockStarts[0].payload as {
      contentBlockIndex: number;
      start: { toolUse: { name: string } };
    };
    expect(start0.contentBlockIndex).toBe(0);
    expect(start0.start.toolUse.name).toBe("get_weather");

    // Second tool at contentBlockIndex 1
    const start1 = blockStarts[1].payload as {
      contentBlockIndex: number;
      start: { toolUse: { name: string } };
    };
    expect(start1.contentBlockIndex).toBe(1);
    expect(start1.start.toolUse.name).toBe("get_time");

    // contentBlockStop should also have correct indices
    const blockStops = frames.filter((f) => f.eventType === "contentBlockStop");
    expect(blockStops.length).toBeGreaterThanOrEqual(2);
    expect((blockStops[0].payload as { contentBlockIndex: number }).contentBlockIndex).toBe(0);
    expect((blockStops[1].payload as { contentBlockIndex: number }).contentBlockIndex).toBe(1);

    // messageStop should indicate tool_use
    const msgStop = frames.find((f) => f.eventType === "messageStop");
    expect(msgStop!.payload).toEqual({ stopReason: "tool_use" });
  });
});

// ─── invoke-with-response-stream: interruption ─────────────────────────────

describe("POST /model/{modelId}/invoke-with-response-stream (interruption)", () => {
  const MODEL_ID = "anthropic.claude-3-5-sonnet-20241022-v2:0";

  it("truncateAfterChunks truncates the stream", async () => {
    const truncatedFixture: Fixture = {
      match: { userMessage: "hello" },
      response: { content: "Hello, World! This is a longer message for chunking." },
      chunkSize: 5,
      truncateAfterChunks: 3,
    };
    instance = await createServer([truncatedFixture]);

    const res = await postPartialBinary(
      `${instance.url}/model/${MODEL_ID}/invoke-with-response-stream`,
      {
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 512,
        messages: [{ role: "user", content: "hello" }],
      },
    );

    // Stream was truncated — res.destroy() causes abrupt close
    expect(res.aborted).toBe(true);

    // Journal should record interruption
    await new Promise((r) => setTimeout(r, 50));
    const entry = instance.journal.getLast();
    expect(entry!.response.interrupted).toBe(true);
    expect(entry!.response.interruptReason).toBe("truncateAfterChunks");
  });
});

// ─── invoke-with-response-stream: chaos ─────────────────────────────────────

describe("POST /model/{modelId}/invoke-with-response-stream (chaos)", () => {
  const MODEL_ID = "anthropic.claude-3-5-sonnet-20241022-v2:0";

  it("chaos drops requests when dropRate is 1", async () => {
    instance = await createServer(allFixtures, { chaos: { dropRate: 1.0 } });
    const res = await post(`${instance.url}/model/${MODEL_ID}/invoke-with-response-stream`, {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 512,
      messages: [{ role: "user", content: "hello" }],
    });

    // Chaos drop returns 500 with server_error
    expect(res.status).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error.type).toBe("server_error");
  });
});

// ─── Converse non-streaming ─────────────────────────────────────────────────

describe("POST /model/{modelId}/converse (non-streaming)", () => {
  const MODEL_ID = "anthropic.claude-3-5-sonnet-20241022-v2:0";

  it("returns text response in Converse format", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/model/${MODEL_ID}/converse`, {
      messages: [{ role: "user", content: [{ text: "hello" }] }],
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");

    const body = JSON.parse(res.body);
    expect(body.output.message.role).toBe("assistant");
    expect(body.output.message.content).toHaveLength(1);
    expect(body.output.message.content[0].text).toBe("Hi there!");
    expect(body.stopReason).toBe("end_turn");
    expect(body.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });

  it("returns tool call response in Converse format", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/model/${MODEL_ID}/converse`, {
      messages: [{ role: "user", content: [{ text: "weather" }] }],
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.output.message.role).toBe("assistant");
    expect(body.output.message.content).toHaveLength(1);
    expect(body.output.message.content[0].toolUse.name).toBe("get_weather");
    expect(body.output.message.content[0].toolUse.input).toEqual({ city: "SF" });
    expect(body.output.message.content[0].toolUse.toolUseId).toBeDefined();
    expect(body.stopReason).toBe("tool_use");
  });

  it("returns 404 when no fixture matches", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/model/${MODEL_ID}/converse`, {
      messages: [{ role: "user", content: [{ text: "nomatch" }] }],
    });

    expect(res.status).toBe(404);
  });

  it("returns 400 for missing messages", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/model/${MODEL_ID}/converse`, {});

    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("Invalid request: messages array is required");
  });

  it("chaos applies to converse endpoint", async () => {
    instance = await createServer(allFixtures, { chaos: { dropRate: 1.0 } });
    const res = await post(`${instance.url}/model/${MODEL_ID}/converse`, {
      messages: [{ role: "user", content: [{ text: "hello" }] }],
    });

    expect(res.status).toBe(500);
  });
});

// ─── Converse streaming ─────────────────────────────────────────────────────

describe("POST /model/{modelId}/converse-stream", () => {
  const MODEL_ID = "anthropic.claude-3-5-sonnet-20241022-v2:0";

  it("returns text response as Event Stream", async () => {
    instance = await createServer(allFixtures);
    const res = await postBinary(`${instance.url}/model/${MODEL_ID}/converse-stream`, {
      messages: [{ role: "user", content: [{ text: "hello" }] }],
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/vnd.amazon.eventstream");

    const frames = parseFrames(res.body);

    // Verify event sequence
    expect(frames[0].eventType).toBe("messageStart");
    expect(frames[0].payload).toEqual({ role: "assistant" });

    expect(frames[1].eventType).toBe("contentBlockStart");

    const deltas = frames.filter((f) => f.eventType === "contentBlockDelta");
    const fullText = deltas
      .map((f) => (f.payload as { delta: { text: string } }).delta.text)
      .join("");
    expect(fullText).toBe("Hi there!");

    const msgStop = frames.find((f) => f.eventType === "messageStop");
    expect(msgStop!.payload).toEqual({ stopReason: "end_turn" });
  });

  it("returns tool call response as Event Stream", async () => {
    instance = await createServer(allFixtures);
    const res = await postBinary(`${instance.url}/model/${MODEL_ID}/converse-stream`, {
      messages: [{ role: "user", content: [{ text: "weather" }] }],
    });

    expect(res.status).toBe(200);
    const frames = parseFrames(res.body);

    expect(frames[0].eventType).toBe("messageStart");

    const startFrame = frames.find((f) => f.eventType === "contentBlockStart");
    const startPayload = startFrame!.payload as {
      contentBlockIndex: number;
      start: { toolUse: { toolUseId: string; name: string } };
    };
    expect(startPayload.start.toolUse.name).toBe("get_weather");

    const deltas = frames.filter((f) => f.eventType === "contentBlockDelta");
    const fullJson = deltas
      .map((f) => (f.payload as { delta: { inputJSON: string } }).delta.inputJSON)
      .join("");
    expect(JSON.parse(fullJson)).toEqual({ city: "SF" });

    const msgStop = frames.find((f) => f.eventType === "messageStop");
    expect(msgStop!.payload).toEqual({ stopReason: "tool_use" });
  });

  it("supports streaming profile (ttft/tps)", async () => {
    const profileFixture: Fixture = {
      match: { userMessage: "hello" },
      response: { content: "Hi" },
      streamingProfile: { ttft: 0, tps: 10000 },
    };
    instance = await createServer([profileFixture]);

    const res = await postBinary(`${instance.url}/model/${MODEL_ID}/converse-stream`, {
      messages: [{ role: "user", content: [{ text: "hello" }] }],
    });

    expect(res.status).toBe(200);
    const frames = parseFrames(res.body);
    expect(frames.length).toBeGreaterThan(0);
  });

  it("truncateAfterChunks interrupts the stream", async () => {
    const truncatedFixture: Fixture = {
      match: { userMessage: "hello" },
      response: { content: "Hello, World! This is a longer message." },
      chunkSize: 5,
      truncateAfterChunks: 2,
    };
    instance = await createServer([truncatedFixture]);

    const res = await postPartialBinary(`${instance.url}/model/${MODEL_ID}/converse-stream`, {
      messages: [{ role: "user", content: [{ text: "hello" }] }],
    });

    // Stream was truncated — res.destroy() causes abrupt close
    expect(res.aborted).toBe(true);

    // Journal should record interruption
    await new Promise((r) => setTimeout(r, 50));
    const entry = instance.journal.getLast();
    expect(entry!.response.interrupted).toBe(true);
    expect(entry!.response.interruptReason).toBe("truncateAfterChunks");
  });

  it("chaos applies to converse-stream endpoint", async () => {
    instance = await createServer(allFixtures, { chaos: { dropRate: 1.0 } });
    const res = await post(`${instance.url}/model/${MODEL_ID}/converse-stream`, {
      messages: [{ role: "user", content: [{ text: "hello" }] }],
    });

    expect(res.status).toBe(500);
  });
});

// ─── converseToCompletionRequest unit tests ─────────────────────────────────

describe("converseToCompletionRequest", () => {
  it("converts system messages", () => {
    const result = converseToCompletionRequest(
      {
        messages: [{ role: "user", content: [{ text: "hi" }] }],
        system: [{ text: "You are a helpful assistant." }],
      },
      "anthropic.claude-3-5-sonnet",
    );

    expect(result.messages[0]).toEqual({
      role: "system",
      content: "You are a helpful assistant.",
    });
    expect(result.messages[1]).toEqual({ role: "user", content: "hi" });
  });

  it("concatenates multiple system blocks", () => {
    const result = converseToCompletionRequest(
      {
        messages: [{ role: "user", content: [{ text: "hi" }] }],
        system: [{ text: "You are " }, { text: "a helpful assistant." }],
      },
      "anthropic.claude-3-5-sonnet",
    );

    expect(result.messages[0]).toEqual({
      role: "system",
      content: "You are a helpful assistant.",
    });
  });

  it("converts user messages with text content", () => {
    const result = converseToCompletionRequest(
      {
        messages: [{ role: "user", content: [{ text: "Hello" }, { text: " World" }] }],
      },
      "model-id",
    );

    expect(result.messages[0]).toEqual({ role: "user", content: "Hello World" });
  });

  it("converts tool results in user messages", () => {
    const result = converseToCompletionRequest(
      {
        messages: [
          {
            role: "user",
            content: [
              {
                toolResult: {
                  toolUseId: "toolu_123",
                  content: [{ text: "72F and sunny" }],
                },
              },
              { text: "Tell me more" },
            ],
          },
        ],
      },
      "model-id",
    );

    expect(result.messages[0]).toEqual({
      role: "tool",
      content: "72F and sunny",
      tool_call_id: "toolu_123",
    });
    expect(result.messages[1]).toEqual({
      role: "user",
      content: "Tell me more",
    });
  });

  it("converts assistant messages with toolUse blocks", () => {
    const result = converseToCompletionRequest(
      {
        messages: [
          { role: "user", content: [{ text: "search" }] },
          {
            role: "assistant",
            content: [
              { text: "Let me search." },
              {
                toolUse: {
                  toolUseId: "toolu_456",
                  name: "search",
                  input: { query: "cats" },
                },
              },
            ],
          },
        ],
      },
      "model-id",
    );

    expect(result.messages[1]).toMatchObject({
      role: "assistant",
      content: "Let me search.",
      tool_calls: [
        {
          id: "toolu_456",
          type: "function",
          function: { name: "search", arguments: '{"query":"cats"}' },
        },
      ],
    });
  });

  it("converts tool definitions from toolConfig", () => {
    const result = converseToCompletionRequest(
      {
        messages: [{ role: "user", content: [{ text: "hi" }] }],
        toolConfig: {
          tools: [
            {
              toolSpec: {
                name: "get_weather",
                description: "Get weather for a city",
                inputSchema: {
                  type: "object",
                  properties: { city: { type: "string" } },
                  required: ["city"],
                },
              },
            },
          ],
        },
      },
      "model-id",
    );

    expect(result.tools).toHaveLength(1);
    expect(result.tools![0]).toEqual({
      type: "function",
      function: {
        name: "get_weather",
        description: "Get weather for a city",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    });
  });

  it("passes through inferenceConfig temperature", () => {
    const result = converseToCompletionRequest(
      {
        messages: [{ role: "user", content: [{ text: "hi" }] }],
        inferenceConfig: { temperature: 0.7 },
      },
      "model-id",
    );

    expect(result.temperature).toBe(0.7);
  });

  it("sets model from modelId parameter", () => {
    const result = converseToCompletionRequest(
      {
        messages: [{ role: "user", content: [{ text: "hi" }] }],
      },
      "anthropic.claude-3-5-sonnet-20241022-v2:0",
    );

    expect(result.model).toBe("anthropic.claude-3-5-sonnet-20241022-v2:0");
  });
});

// ─── Converse edge cases ─────────────────────────────────────────────────────

function postRaw(url: string, raw: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(raw),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
          });
        });
      },
    );
    req.on("error", reject);
    req.write(raw);
    req.end();
  });
}

describe("POST /model/{modelId}/converse (malformed JSON)", () => {
  const MODEL_ID = "anthropic.claude-3-5-sonnet-20241022-v2:0";

  it("returns 400 for malformed JSON body", async () => {
    instance = await createServer(allFixtures);
    const res = await postRaw(`${instance.url}/model/${MODEL_ID}/converse`, "{not valid");

    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("Malformed JSON");
  });
});

describe("POST /model/{modelId}/converse-stream (missing messages)", () => {
  const MODEL_ID = "anthropic.claude-3-5-sonnet-20241022-v2:0";

  it("returns 400 when messages array is missing", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/model/${MODEL_ID}/converse-stream`, {});

    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("Invalid request: messages array is required");
  });
});

// ─── invoke-with-response-stream: unknown response type → 500 ──────────────

describe("POST /model/{modelId}/invoke-with-response-stream (unknown response type)", () => {
  const MODEL_ID = "anthropic.claude-3-5-sonnet-20241022-v2:0";

  it("returns 500 for embedding fixture on streaming endpoint", async () => {
    const embeddingFixture: Fixture = {
      match: { userMessage: "embed-stream" },
      response: { embedding: [0.1, 0.2, 0.3] },
    };
    instance = await createServer([embeddingFixture]);
    const res = await post(`${instance.url}/model/${MODEL_ID}/invoke-with-response-stream`, {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 512,
      messages: [{ role: "user", content: "embed-stream" }],
    });

    expect(res.status).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error.message).toContain("did not match any known type");
  });
});

// ─── invoke-with-response-stream: malformed tool call arguments ─────────────

describe("POST /model/{modelId}/invoke-with-response-stream (malformed tool args)", () => {
  const MODEL_ID = "anthropic.claude-3-5-sonnet-20241022-v2:0";

  it("malformed tool call arguments fall back to empty JSON string", async () => {
    const badArgsFixture: Fixture = {
      match: { userMessage: "bad-tool-args" },
      response: {
        toolCalls: [{ name: "fn", arguments: "NOT VALID JSON" }],
      },
    };
    instance = await createServer([badArgsFixture]);
    const res = await postBinary(`${instance.url}/model/${MODEL_ID}/invoke-with-response-stream`, {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 512,
      messages: [{ role: "user", content: "bad-tool-args" }],
    });

    expect(res.status).toBe(200);
    const frames = parseFrames(res.body);

    // Find contentBlockDelta frames with inputJSON
    const deltas = frames.filter((f) => f.eventType === "contentBlockDelta");
    const fullJson = deltas
      .map((f) => {
        const payload = f.payload as { delta: { inputJSON?: string } };
        return payload.delta.inputJSON ?? "";
      })
      .join("");
    // Malformed arguments should fall back to "{}"
    expect(fullJson).toBe("{}");
  });
});

// ─── invoke-with-response-stream: empty content string ──────────────────────

describe("POST /model/{modelId}/invoke-with-response-stream (empty content)", () => {
  const MODEL_ID = "anthropic.claude-3-5-sonnet-20241022-v2:0";

  it("empty content produces event sequence with zero content deltas", async () => {
    const emptyContentFixture: Fixture = {
      match: { userMessage: "empty-content" },
      response: { content: "" },
    };
    instance = await createServer([emptyContentFixture]);
    const res = await postBinary(`${instance.url}/model/${MODEL_ID}/invoke-with-response-stream`, {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 512,
      messages: [{ role: "user", content: "empty-content" }],
    });

    expect(res.status).toBe(200);
    const frames = parseFrames(res.body);

    // Should still have messageStart, contentBlockStart, contentBlockStop, messageStop
    expect(frames[0].eventType).toBe("messageStart");
    expect(frames.find((f) => f.eventType === "contentBlockStart")).toBeDefined();
    expect(frames.find((f) => f.eventType === "contentBlockStop")).toBeDefined();
    expect(frames.find((f) => f.eventType === "messageStop")).toBeDefined();

    // Content deltas should be zero (empty string → no chunks)
    const deltas = frames.filter((f) => f.eventType === "contentBlockDelta");
    expect(deltas).toHaveLength(0);
  });
});

// ─── converse-stream: malformed JSON → 400 ──────────────────────────────────

describe("POST /model/{modelId}/converse-stream (malformed JSON)", () => {
  const MODEL_ID = "anthropic.claude-3-5-sonnet-20241022-v2:0";

  it("returns 400 for malformed JSON body", async () => {
    instance = await createServer(allFixtures);
    const res = await postRaw(`${instance.url}/model/${MODEL_ID}/converse-stream`, "{not valid");

    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("Malformed JSON");
  });
});

// ─── Strict mode: converse and converse-stream ──────────────────────────────

describe("POST /model/{modelId}/converse (strict mode)", () => {
  const MODEL_ID = "anthropic.claude-3-5-sonnet-20241022-v2:0";

  it("returns 503 in strict mode when no fixture matches", async () => {
    instance = await createServer([], { strict: true });
    const res = await post(`${instance.url}/model/${MODEL_ID}/converse`, {
      messages: [{ role: "user", content: [{ text: "nomatch" }] }],
    });

    expect(res.status).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("Strict mode: no fixture matched");
  });
});

describe("POST /model/{modelId}/converse-stream (strict mode)", () => {
  const MODEL_ID = "anthropic.claude-3-5-sonnet-20241022-v2:0";

  it("returns 503 in strict mode when no fixture matches", async () => {
    instance = await createServer([], { strict: true });
    const res = await post(`${instance.url}/model/${MODEL_ID}/converse-stream`, {
      messages: [{ role: "user", content: [{ text: "nomatch" }] }],
    });

    expect(res.status).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("Strict mode: no fixture matched");
  });
});

// ─── Unknown response type through converse and converse-stream ─────────────

describe("POST /model/{modelId}/converse (unknown response type)", () => {
  const MODEL_ID = "anthropic.claude-3-5-sonnet-20241022-v2:0";

  it("returns 500 for embedding fixture on converse endpoint", async () => {
    const embeddingFixture: Fixture = {
      match: { userMessage: "embed-converse" },
      response: { embedding: [0.1, 0.2, 0.3] },
    };
    instance = await createServer([embeddingFixture]);
    const res = await post(`${instance.url}/model/${MODEL_ID}/converse`, {
      messages: [{ role: "user", content: [{ text: "embed-converse" }] }],
    });

    expect(res.status).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error.message).toContain("did not match any known type");
  });
});

describe("POST /model/{modelId}/converse-stream (unknown response type)", () => {
  const MODEL_ID = "anthropic.claude-3-5-sonnet-20241022-v2:0";

  it("returns 500 for embedding fixture on converse-stream endpoint", async () => {
    const embeddingFixture: Fixture = {
      match: { userMessage: "embed-stream" },
      response: { embedding: [0.1, 0.2, 0.3] },
    };
    instance = await createServer([embeddingFixture]);
    const res = await post(`${instance.url}/model/${MODEL_ID}/converse-stream`, {
      messages: [{ role: "user", content: [{ text: "embed-stream" }] }],
    });

    expect(res.status).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error.message).toContain("did not match any known type");
  });
});

// ─── Error fixture through converse-stream ──────────────────────────────────

describe("POST /model/{modelId}/converse-stream (error fixture)", () => {
  const MODEL_ID = "anthropic.claude-3-5-sonnet-20241022-v2:0";

  it("returns error fixture with correct status through /converse-stream", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/model/${MODEL_ID}/converse-stream`, {
      messages: [{ role: "user", content: [{ text: "fail" }] }],
    });

    expect(res.status).toBe(429);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("Rate limited");
  });
});

// ─── Error fixture through /converse endpoint ───────────────────────────────

describe("POST /model/{modelId}/converse (error fixture)", () => {
  const MODEL_ID = "anthropic.claude-3-5-sonnet-20241022-v2:0";

  it("returns error fixture with correct status through /converse", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/model/${MODEL_ID}/converse`, {
      messages: [{ role: "user", content: [{ text: "fail" }] }],
    });

    expect(res.status).toBe(429);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("Rate limited");
  });
});

// ─── converseToCompletionRequest: edge case branches ─────────────────────────

describe("converseToCompletionRequest (edge cases)", () => {
  it("handles empty system array (no system message pushed)", () => {
    const result = converseToCompletionRequest(
      {
        messages: [{ role: "user", content: [{ text: "hi" }] }],
        system: [],
      },
      "model",
    );
    expect(result.messages[0]).toEqual({ role: "user", content: "hi" });
  });

  it("handles system with empty text (no system message pushed)", () => {
    const result = converseToCompletionRequest(
      {
        messages: [{ role: "user", content: [{ text: "hi" }] }],
        system: [{ text: "" }],
      },
      "model",
    );
    // Empty systemText → no system message
    expect(result.messages[0]).toEqual({ role: "user", content: "hi" });
  });

  it("handles user text content blocks with missing text (text ?? '' fallback)", () => {
    const result = converseToCompletionRequest(
      {
        messages: [
          {
            role: "user",
            content: [{ text: undefined }],
          },
        ],
      } as unknown as Parameters<typeof converseToCompletionRequest>[0],
      "model",
    );
    expect(result.messages[0]).toEqual({ role: "user", content: "" });
  });

  it("handles assistant text-only messages (no toolUse blocks)", () => {
    const result = converseToCompletionRequest(
      {
        messages: [
          {
            role: "assistant",
            content: [{ text: "Just text" }],
          },
        ],
      },
      "model",
    );
    expect(result.messages[0]).toEqual({ role: "assistant", content: "Just text" });
  });

  it("handles assistant empty content (content: null)", () => {
    const result = converseToCompletionRequest(
      {
        messages: [
          {
            role: "assistant",
            content: [],
          },
        ],
      },
      "model",
    );
    expect(result.messages[0]).toEqual({ role: "assistant", content: null });
  });

  it("handles user tool result with missing text in content items (text ?? '' fallback)", () => {
    const result = converseToCompletionRequest(
      {
        messages: [
          {
            role: "user",
            content: [
              {
                toolResult: {
                  toolUseId: "toolu_x",
                  content: [{ text: undefined }, { text: "result" }],
                },
              },
            ],
          },
        ],
      } as unknown as Parameters<typeof converseToCompletionRequest>[0],
      "model",
    );
    expect(result.messages[0]).toEqual({
      role: "tool",
      content: "result",
      tool_call_id: "toolu_x",
    });
  });

  it("handles user tool results with text blocks alongside", () => {
    const result = converseToCompletionRequest(
      {
        messages: [
          {
            role: "user",
            content: [
              {
                toolResult: {
                  toolUseId: "toolu_x",
                  content: [{ text: "ok" }],
                },
              },
              { text: "extra info" },
            ],
          },
        ],
      },
      "model",
    );
    expect(result.messages[0]).toEqual({
      role: "tool",
      content: "ok",
      tool_call_id: "toolu_x",
    });
    expect(result.messages[1]).toEqual({ role: "user", content: "extra info" });
  });

  it("omits tools when no toolConfig is provided", () => {
    const result = converseToCompletionRequest(
      {
        messages: [{ role: "user", content: [{ text: "hi" }] }],
      },
      "model",
    );
    expect(result.tools).toBeUndefined();
  });

  it("omits tools when toolConfig has empty tools array", () => {
    const result = converseToCompletionRequest(
      {
        messages: [{ role: "user", content: [{ text: "hi" }] }],
        toolConfig: { tools: [] },
      },
      "model",
    );
    expect(result.tools).toBeUndefined();
  });

  it("handles inferenceConfig without temperature (undefined)", () => {
    const result = converseToCompletionRequest(
      {
        messages: [{ role: "user", content: [{ text: "hi" }] }],
        inferenceConfig: { maxTokens: 100 },
      },
      "model",
    );
    expect(result.temperature).toBeUndefined();
  });

  it("handles assistant text blocks with missing text alongside toolUse (text ?? '')", () => {
    const result = converseToCompletionRequest(
      {
        messages: [
          {
            role: "assistant",
            content: [
              { text: undefined },
              {
                toolUse: {
                  toolUseId: "toolu_123",
                  name: "fn",
                  input: {},
                },
              },
            ],
          },
        ],
      } as unknown as Parameters<typeof converseToCompletionRequest>[0],
      "model",
    );
    expect(result.messages[0].tool_calls).toHaveLength(1);
    // Empty text → content is null (falsy)
    expect(result.messages[0].content).toBeNull();
  });
});

// ─── Converse response edge cases ───────────────────────────────────────────

describe("POST /model/{modelId}/converse (malformed tool call arguments)", () => {
  const MODEL_ID = "anthropic.claude-3-5-sonnet-20241022-v2:0";

  it("falls back to empty input for malformed JSON", async () => {
    const badArgsFixture: Fixture = {
      match: { userMessage: "bad-args" },
      response: {
        toolCalls: [{ name: "fn", arguments: "NOT VALID" }],
      },
    };
    instance = await createServer([badArgsFixture]);
    const res = await post(`${instance.url}/model/${MODEL_ID}/converse`, {
      messages: [{ role: "user", content: [{ text: "bad-args" }] }],
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.output.message.content[0].toolUse.input).toEqual({});
  });
});

describe("POST /model/{modelId}/converse (tool call with no id)", () => {
  const MODEL_ID = "anthropic.claude-3-5-sonnet-20241022-v2:0";

  it("generates tool use id when fixture provides none", async () => {
    const noIdFixture: Fixture = {
      match: { userMessage: "no-id-tool" },
      response: {
        toolCalls: [{ name: "fn", arguments: '{"x":1}' }],
      },
    };
    instance = await createServer([noIdFixture]);
    const res = await post(`${instance.url}/model/${MODEL_ID}/converse`, {
      messages: [{ role: "user", content: [{ text: "no-id-tool" }] }],
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.output.message.content[0].toolUse.toolUseId).toMatch(/^toolu_/);
  });
});

describe("POST /model/{modelId}/converse (tool call with empty arguments)", () => {
  const MODEL_ID = "anthropic.claude-3-5-sonnet-20241022-v2:0";

  it("defaults to {} when arguments is empty string", async () => {
    const emptyArgsFixture: Fixture = {
      match: { userMessage: "empty-args" },
      response: {
        toolCalls: [{ name: "fn", arguments: "" }],
      },
    };
    instance = await createServer([emptyArgsFixture]);
    const res = await post(`${instance.url}/model/${MODEL_ID}/converse`, {
      messages: [{ role: "user", content: [{ text: "empty-args" }] }],
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.output.message.content[0].toolUse.input).toEqual({});
  });
});

describe("POST /model/{modelId}/converse (error fixture no explicit status)", () => {
  const MODEL_ID = "anthropic.claude-3-5-sonnet-20241022-v2:0";

  it("defaults to 500 when error fixture has no status", async () => {
    const noStatusError: Fixture = {
      match: { userMessage: "err-no-status" },
      response: {
        error: {
          message: "Something went wrong",
          type: "server_error",
        },
      },
    };
    instance = await createServer([noStatusError]);
    const res = await post(`${instance.url}/model/${MODEL_ID}/converse`, {
      messages: [{ role: "user", content: [{ text: "err-no-status" }] }],
    });

    expect(res.status).toBe(500);
  });
});

describe("POST /model/{modelId}/converse-stream (error fixture no explicit status)", () => {
  const MODEL_ID = "anthropic.claude-3-5-sonnet-20241022-v2:0";

  it("defaults to 500 when error fixture has no status", async () => {
    const noStatusError: Fixture = {
      match: { userMessage: "err-no-status" },
      response: {
        error: {
          message: "Something went wrong",
          type: "server_error",
        },
      },
    };
    instance = await createServer([noStatusError]);
    const res = await post(`${instance.url}/model/${MODEL_ID}/converse-stream`, {
      messages: [{ role: "user", content: [{ text: "err-no-status" }] }],
    });

    expect(res.status).toBe(500);
  });
});

describe("POST /model/{modelId}/invoke-with-response-stream (error fixture no explicit status)", () => {
  const MODEL_ID = "anthropic.claude-3-5-sonnet-20241022-v2:0";

  it("defaults to 500 when streaming error fixture has no status", async () => {
    const noStatusError: Fixture = {
      match: { userMessage: "err-no-status" },
      response: {
        error: {
          message: "Something went wrong",
          type: "server_error",
        },
      },
    };
    instance = await createServer([noStatusError]);
    const res = await post(`${instance.url}/model/${MODEL_ID}/invoke-with-response-stream`, {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 512,
      messages: [{ role: "user", content: "err-no-status" }],
    });

    expect(res.status).toBe(500);
  });
});

// ─── Direct handler tests for req.method/req.url fallback branches ──────────

function createMockReq(overrides: Partial<http.IncomingMessage> = {}): http.IncomingMessage {
  return {
    method: undefined,
    url: undefined,
    headers: {},
    ...overrides,
  } as unknown as http.IncomingMessage;
}

function createMockRes(): http.ServerResponse & { _written: string; _status: number } {
  const res = {
    _written: "",
    _status: 0,
    writableEnded: false,
    statusCode: 0,
    writeHead(status: number) {
      res._status = status;
      res.statusCode = status;
    },
    setHeader() {},
    write(data: string) {
      res._written += data;
      return true;
    },
    end(data?: string) {
      if (data) res._written += data;
      res.writableEnded = true;
    },
    destroy() {
      res.writableEnded = true;
    },
  };
  return res as unknown as http.ServerResponse & { _written: string; _status: number };
}

function createDefaults(overrides: Partial<HandlerDefaults> = {}): HandlerDefaults {
  return {
    latency: 0,
    chunkSize: 100,
    logger: new Logger("silent"),
    ...overrides,
  };
}

describe("handleConverse (direct handler call, method/url fallbacks)", () => {
  it("uses fallback for text response with undefined method/url", async () => {
    const fixture: Fixture = {
      match: { userMessage: "hi" },
      response: { content: "Hello" },
    };
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();
    const raw = JSON.stringify({
      messages: [{ role: "user", content: [{ text: "hi" }] }],
    });

    await handleConverse(req, res, raw, "model-id", [fixture], journal, createDefaults(), () => {});

    expect(res._status).toBe(200);
    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.path).toContain("/model/model-id/converse");
  });

  it("uses fallback for malformed JSON", async () => {
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();

    await handleConverse(req, res, "{bad", "model-id", [], journal, createDefaults(), () => {});

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
  });

  it("uses fallback for missing messages", async () => {
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();

    await handleConverse(
      req,
      res,
      JSON.stringify({}),
      "model-id",
      [],
      journal,
      createDefaults(),
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.response.status).toBe(400);
  });

  it("uses fallback for no fixture match", async () => {
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();

    await handleConverse(
      req,
      res,
      JSON.stringify({ messages: [{ role: "user", content: [{ text: "x" }] }] }),
      "model-id",
      [],
      journal,
      createDefaults(),
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.response.status).toBe(404);
  });

  it("uses fallback for strict mode", async () => {
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();

    await handleConverse(
      req,
      res,
      JSON.stringify({ messages: [{ role: "user", content: [{ text: "x" }] }] }),
      "model-id",
      [],
      journal,
      createDefaults({ strict: true }),
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.response.status).toBe(503);
  });

  it("uses fallback for error response", async () => {
    const fixture: Fixture = {
      match: { userMessage: "err" },
      response: { error: { message: "fail", type: "err" }, status: 500 },
    };
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();

    await handleConverse(
      req,
      res,
      JSON.stringify({ messages: [{ role: "user", content: [{ text: "err" }] }] }),
      "model-id",
      [fixture],
      journal,
      createDefaults(),
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.response.status).toBe(500);
  });

  it("uses fallback for tool call response", async () => {
    const fixture: Fixture = {
      match: { userMessage: "tool" },
      response: { toolCalls: [{ name: "fn", arguments: '{"x":1}' }] },
    };
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();

    await handleConverse(
      req,
      res,
      JSON.stringify({ messages: [{ role: "user", content: [{ text: "tool" }] }] }),
      "model-id",
      [fixture],
      journal,
      createDefaults(),
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.response.status).toBe(200);
  });

  it("uses fallback for unknown response type", async () => {
    const fixture: Fixture = {
      match: { userMessage: "embed" },
      response: { embedding: [0.1] },
    };
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();

    await handleConverse(
      req,
      res,
      JSON.stringify({ messages: [{ role: "user", content: [{ text: "embed" }] }] }),
      "model-id",
      [fixture],
      journal,
      createDefaults(),
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.response.status).toBe(500);
  });
});

describe("handleConverseStream (direct handler call, method/url fallbacks)", () => {
  it("uses fallback for text response with undefined method/url", async () => {
    const fixture: Fixture = {
      match: { userMessage: "hi" },
      response: { content: "Hello" },
    };
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();

    await handleConverseStream(
      req,
      res,
      JSON.stringify({ messages: [{ role: "user", content: [{ text: "hi" }] }] }),
      "model-id",
      [fixture],
      journal,
      createDefaults(),
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.path).toContain("/model/model-id/converse-stream");
  });

  it("uses fallback for malformed JSON in streaming", async () => {
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();

    await handleConverseStream(
      req,
      res,
      "{bad",
      "model-id",
      [],
      journal,
      createDefaults(),
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
  });

  it("uses fallback for missing messages in streaming", async () => {
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();

    await handleConverseStream(
      req,
      res,
      JSON.stringify({}),
      "model-id",
      [],
      journal,
      createDefaults(),
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.response.status).toBe(400);
  });

  it("uses fallback for no fixture match in streaming", async () => {
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();

    await handleConverseStream(
      req,
      res,
      JSON.stringify({ messages: [{ role: "user", content: [{ text: "x" }] }] }),
      "model-id",
      [],
      journal,
      createDefaults(),
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.response.status).toBe(404);
  });

  it("uses fallback for strict mode in streaming", async () => {
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();

    await handleConverseStream(
      req,
      res,
      JSON.stringify({ messages: [{ role: "user", content: [{ text: "x" }] }] }),
      "model-id",
      [],
      journal,
      createDefaults({ strict: true }),
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.response.status).toBe(503);
  });

  it("uses fallback for error response in streaming", async () => {
    const fixture: Fixture = {
      match: { userMessage: "err" },
      response: { error: { message: "fail", type: "err" }, status: 500 },
    };
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();

    await handleConverseStream(
      req,
      res,
      JSON.stringify({ messages: [{ role: "user", content: [{ text: "err" }] }] }),
      "model-id",
      [fixture],
      journal,
      createDefaults(),
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.response.status).toBe(500);
  });

  it("uses fallback for tool call response in streaming", async () => {
    const fixture: Fixture = {
      match: { userMessage: "tool" },
      response: { toolCalls: [{ name: "fn", arguments: '{"x":1}' }] },
    };
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();

    await handleConverseStream(
      req,
      res,
      JSON.stringify({ messages: [{ role: "user", content: [{ text: "tool" }] }] }),
      "model-id",
      [fixture],
      journal,
      createDefaults(),
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.response.status).toBe(200);
  });

  it("uses fallback for unknown response type in streaming", async () => {
    const fixture: Fixture = {
      match: { userMessage: "embed" },
      response: { embedding: [0.1] },
    };
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();

    await handleConverseStream(
      req,
      res,
      JSON.stringify({ messages: [{ role: "user", content: [{ text: "embed" }] }] }),
      "model-id",
      [fixture],
      journal,
      createDefaults(),
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.response.status).toBe(500);
  });
});
