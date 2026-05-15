import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import { crc32 } from "node:zlib";
import type { Fixture } from "../types.js";
import { createServer, type ServerInstance } from "../server.js";
import {
  converseToCompletionRequest,
  handleConverse,
  handleConverseStream,
} from "../bedrock-converse.js";
import { Journal } from "../journal.js";
import { createMockReq, createMockRes, createDefaults } from "./helpers/mock-res.js";

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
    let resolved = false;
    const safeResolve = (value: { body: Buffer; aborted: boolean }) => {
      if (!resolved) {
        resolved = true;
        resolve(value);
      }
    };
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
          safeResolve({ body: Buffer.concat(chunks), aborted });
        });
        res.on("error", () => {
          aborted = true;
        });
        res.on("close", () => {
          safeResolve({ body: Buffer.concat(chunks), aborted });
        });
      },
    );
    req.on("error", () => {
      aborted = true;
      safeResolve({ body: Buffer.concat(chunks), aborted });
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

const contentWithToolCallsFixture: Fixture = {
  match: { userMessage: "search-and-explain" },
  response: {
    content: "Let me look that up.",
    toolCalls: [
      {
        name: "web_search",
        arguments: '{"query":"vitest testing"}',
      },
    ],
  },
};

const allFixtures: Fixture[] = [
  textFixture,
  toolFixture,
  errorFixture,
  contentWithToolCallsFixture,
];

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

    // InvokeModelWithResponseStream wraps Anthropic-native stream events in Bedrock
    // EventStream chunk frames.
    expect(frames[0].eventType).toBe("chunk");
    expect(frames[0].payload).toMatchObject({
      type: "message_start",
      message: { role: "assistant", model: MODEL_ID },
    });

    expect(frames[1].eventType).toBe("chunk");
    expect(frames[1].payload).toEqual({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });

    // Content delta(s) — collect text
    const deltas = frames.filter(
      (f) => (f.payload as { type?: string }).type === "content_block_delta",
    );
    expect(deltas.length).toBeGreaterThanOrEqual(1);
    const fullText = deltas
      .map((f) => (f.payload as { delta: { text: string } }).delta.text)
      .join("");
    expect(fullText).toBe("Hi there!");

    // content_block_stop
    const stopBlock = frames.find(
      (f) => (f.payload as { type?: string }).type === "content_block_stop",
    );
    expect(stopBlock).toBeDefined();
    expect(stopBlock!.payload).toEqual({ type: "content_block_stop", index: 0 });

    // message_delta/message_stop
    const msgDelta = frames.find((f) => (f.payload as { type?: string }).type === "message_delta");
    expect(msgDelta).toBeDefined();
    expect(msgDelta!.payload).toMatchObject({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
    });
    const msgStop = frames.find((f) => (f.payload as { type?: string }).type === "message_stop");
    expect(msgStop).toBeDefined();
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

    expect(frames[0].eventType).toBe("chunk");
    expect(frames[0].payload).toMatchObject({ type: "message_start" });

    // content_block_start with tool_use
    expect(frames[1].eventType).toBe("chunk");
    const startPayload = frames[1].payload as {
      type: string;
      index: number;
      content_block: { type: string; id: string; name: string; input: object };
    };
    expect(startPayload).toMatchObject({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", name: "get_weather", input: {} },
    });
    expect(startPayload.content_block.id).toBeDefined();

    // content_block_delta(s) with input_json_delta
    const deltas = frames.filter(
      (f) => (f.payload as { type?: string }).type === "content_block_delta",
    );
    expect(deltas.length).toBeGreaterThanOrEqual(1);
    const fullJson = deltas
      .map((f) => (f.payload as { delta: { partial_json: string } }).delta.partial_json)
      .join("");
    expect(JSON.parse(fullJson)).toEqual({ city: "SF" });

    const msgDelta = frames.find((f) => (f.payload as { type?: string }).type === "message_delta");
    expect(msgDelta!.payload).toMatchObject({
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
    });
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

    // Find content_block_start frames
    const blockStarts = frames.filter(
      (f) => (f.payload as { type?: string }).type === "content_block_start",
    );
    expect(blockStarts.length).toBeGreaterThanOrEqual(2);

    // First tool at index 0
    const start0 = blockStarts[0].payload as {
      index: number;
      content_block: { name: string };
    };
    expect(start0.index).toBe(0);
    expect(start0.content_block.name).toBe("get_weather");

    // Second tool at index 1
    const start1 = blockStarts[1].payload as {
      index: number;
      content_block: { name: string };
    };
    expect(start1.index).toBe(1);
    expect(start1.content_block.name).toBe("get_time");

    // content_block_stop should also have correct indices
    const blockStops = frames.filter(
      (f) => (f.payload as { type?: string }).type === "content_block_stop",
    );
    expect(blockStops.length).toBeGreaterThanOrEqual(2);
    expect((blockStops[0].payload as { index: number }).index).toBe(0);
    expect((blockStops[1].payload as { index: number }).index).toBe(1);

    // message_delta should indicate tool_use
    const msgDelta = frames.find((f) => (f.payload as { type?: string }).type === "message_delta");
    expect(msgDelta!.payload).toMatchObject({ delta: { stop_reason: "tool_use" } });
  });
});

// ─── invoke-with-response-stream: content + tool calls ────────────────────

describe("POST /model/{modelId}/invoke-with-response-stream (content + toolCalls)", () => {
  const MODEL_ID = "anthropic.claude-3-5-sonnet-20241022-v2:0";

  it("streams text block followed by tool_use block in Anthropic-native format", async () => {
    instance = await createServer(allFixtures);
    const res = await postBinary(`${instance.url}/model/${MODEL_ID}/invoke-with-response-stream`, {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 512,
      messages: [{ role: "user", content: "search-and-explain" }],
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/vnd.amazon.eventstream");

    const frames = parseFrames(res.body);

    // All frames should be "chunk" eventType (Anthropic-native wrapping)
    expect(frames.every((f) => f.eventType === "chunk")).toBe(true);

    // message_start
    expect(frames[0].payload).toMatchObject({
      type: "message_start",
      message: { role: "assistant", model: MODEL_ID },
    });

    // Text content_block_start at index 0
    const textBlockStart = frames.find(
      (f) =>
        (f.payload as { type?: string }).type === "content_block_start" &&
        (f.payload as { content_block?: { type: string } }).content_block?.type === "text",
    );
    expect(textBlockStart).toBeDefined();
    expect(textBlockStart!.payload).toMatchObject({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });

    // Text deltas — collect and verify full text
    const textDeltas = frames.filter(
      (f) =>
        (f.payload as { type?: string }).type === "content_block_delta" &&
        (f.payload as { delta?: { type?: string } }).delta?.type === "text_delta",
    );
    expect(textDeltas.length).toBeGreaterThanOrEqual(1);
    const fullText = textDeltas
      .map((f) => (f.payload as { delta: { text: string } }).delta.text)
      .join("");
    expect(fullText).toBe("Let me look that up.");

    // Tool use content_block_start at index 1
    const toolBlockStart = frames.find(
      (f) =>
        (f.payload as { type?: string }).type === "content_block_start" &&
        (f.payload as { content_block?: { type: string } }).content_block?.type === "tool_use",
    );
    expect(toolBlockStart).toBeDefined();
    const toolStartPayload = toolBlockStart!.payload as {
      index: number;
      content_block: { type: string; id: string; name: string; input: object };
    };
    expect(toolStartPayload.index).toBe(1);
    expect(toolStartPayload.content_block.name).toBe("web_search");
    expect(toolStartPayload.content_block.id).toBeDefined();

    // Tool deltas — input_json_delta with partial_json
    const toolDeltas = frames.filter(
      (f) =>
        (f.payload as { type?: string }).type === "content_block_delta" &&
        (f.payload as { delta?: { type?: string } }).delta?.type === "input_json_delta",
    );
    expect(toolDeltas.length).toBeGreaterThanOrEqual(1);
    const fullJson = toolDeltas
      .map((f) => (f.payload as { delta: { partial_json: string } }).delta.partial_json)
      .join("");
    expect(JSON.parse(fullJson)).toEqual({ query: "vitest testing" });

    // message_delta with stop_reason "tool_use"
    const msgDelta = frames.find((f) => (f.payload as { type?: string }).type === "message_delta");
    expect(msgDelta!.payload).toMatchObject({
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
    });

    // message_stop
    const msgStop = frames.find((f) => (f.payload as { type?: string }).type === "message_stop");
    expect(msgStop).toBeDefined();
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
    expect(typeof body.metrics.latencyMs).toBe("number");
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
    expect(typeof body.metrics.latencyMs).toBe("number");
  });

  it("returns metrics field in content+toolCalls response", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/model/${MODEL_ID}/converse`, {
      messages: [{ role: "user", content: [{ text: "search-and-explain" }] }],
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(typeof body.metrics.latencyMs).toBe("number");
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

    // Verify event sequence — payloads are NOT wrapped with the event type name;
    // the :event-type header already carries that information.
    expect(frames[0].eventType).toBe("messageStart");
    expect(frames[0].payload).toEqual({ role: "assistant" });

    expect(frames[1].eventType).toBe("contentBlockStart");
    // Text contentBlockStart has an empty start object (no spurious `type` field)
    const startPayloadText = frames[1].payload as { start: Record<string, unknown> };
    expect(startPayloadText.start).not.toHaveProperty("type");
    expect(Object.keys(startPayloadText.start)).toEqual([]);

    const deltas = frames.filter((f) => f.eventType === "contentBlockDelta");
    // Verify no spurious `type` field in any text delta
    for (const d of deltas) {
      const delta = (d.payload as { delta: Record<string, unknown> }).delta;
      expect(delta).not.toHaveProperty("type");
      expect(Object.keys(delta)).toEqual(["text"]);
    }
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
    expect(frames[0].payload).toEqual({ role: "assistant" });

    const startFrame = frames.find((f) => f.eventType === "contentBlockStart");
    const startPayload = startFrame!.payload as {
      contentBlockIndex: number;
      start: { toolUse: { toolUseId: string; name: string } };
    };
    expect(startPayload.start.toolUse.name).toBe("get_weather");

    const deltas = frames.filter((f) => f.eventType === "contentBlockDelta");
    const fullJson = deltas
      .map((f) => (f.payload as { delta: { toolUse: { input: string } } }).delta.toolUse.input)
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

// ─── converse-stream: content + tool calls ─────────────────────────────────

describe("POST /model/{modelId}/converse-stream (content + toolCalls)", () => {
  const MODEL_ID = "anthropic.claude-3-5-sonnet-20241022-v2:0";

  it("streams text block followed by toolUse block in Converse camelCase format", async () => {
    instance = await createServer(allFixtures);
    const res = await postBinary(`${instance.url}/model/${MODEL_ID}/converse-stream`, {
      messages: [{ role: "user", content: [{ text: "search-and-explain" }] }],
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/vnd.amazon.eventstream");

    const frames = parseFrames(res.body);

    // messageStart — payload is flat (not wrapped with event type name)
    expect(frames[0].eventType).toBe("messageStart");
    expect(frames[0].payload).toEqual({ role: "assistant" });

    // Text contentBlockStart — start is an empty object (no spurious `type` field)
    const textBlockStart = frames.find(
      (f) =>
        f.eventType === "contentBlockStart" &&
        !(f.payload as { start?: { toolUse?: unknown; reasoningContent?: unknown } }).start
          ?.toolUse &&
        !(f.payload as { start?: { toolUse?: unknown; reasoningContent?: unknown } }).start
          ?.reasoningContent,
    );
    expect(textBlockStart).toBeDefined();
    const textStart = (textBlockStart!.payload as { start: Record<string, unknown> }).start;
    expect(textStart).not.toHaveProperty("type");
    expect(Object.keys(textStart)).toEqual([]);

    // Text deltas — no spurious `type` field in delta
    const textDeltas = frames.filter(
      (f) =>
        f.eventType === "contentBlockDelta" &&
        (f.payload as { delta?: { text?: string } }).delta?.text !== undefined,
    );
    expect(textDeltas.length).toBeGreaterThanOrEqual(1);
    for (const td of textDeltas) {
      const delta = (td.payload as { delta: Record<string, unknown> }).delta;
      expect(delta).not.toHaveProperty("type");
      expect(Object.keys(delta)).toEqual(["text"]);
    }
    const fullText = textDeltas
      .map((f) => (f.payload as { delta: { text: string } }).delta.text)
      .join("");
    expect(fullText).toBe("Let me look that up.");

    // Tool use contentBlockStart
    const toolBlockStart = frames.find(
      (f) =>
        f.eventType === "contentBlockStart" &&
        (f.payload as { start?: { toolUse?: unknown } }).start?.toolUse !== undefined,
    );
    expect(toolBlockStart).toBeDefined();
    const toolStartPayload = toolBlockStart!.payload as {
      contentBlockIndex: number;
      start: { toolUse: { toolUseId: string; name: string } };
    };
    expect(toolStartPayload.start.toolUse.name).toBe("web_search");
    expect(toolStartPayload.start.toolUse.toolUseId).toBeDefined();

    // Tool deltas — toolUse.input
    const toolDeltas = frames.filter(
      (f) =>
        f.eventType === "contentBlockDelta" &&
        (f.payload as { delta?: { toolUse?: unknown } }).delta?.toolUse !== undefined,
    );
    expect(toolDeltas.length).toBeGreaterThanOrEqual(1);
    const fullJson = toolDeltas
      .map((f) => (f.payload as { delta: { toolUse: { input: string } } }).delta.toolUse.input)
      .join("");
    expect(JSON.parse(fullJson)).toEqual({ query: "vitest testing" });

    // messageStop with tool_use stop reason
    const msgStop = frames.find((f) => f.eventType === "messageStop");
    expect(msgStop!.payload).toEqual({ stopReason: "tool_use" });
  });
});

// ─── converse-stream: payload shape (not double-wrapped) ──────────────────────

describe("POST /model/{modelId}/converse-stream (payload shape)", () => {
  const MODEL_ID = "anthropic.claude-3-5-sonnet-20241022-v2:0";

  it("contentBlockStop payloads are flat { contentBlockIndex: N } (not double-wrapped)", async () => {
    instance = await createServer(allFixtures);
    const res = await postBinary(`${instance.url}/model/${MODEL_ID}/converse-stream`, {
      messages: [{ role: "user", content: [{ text: "hello" }] }],
    });

    expect(res.status).toBe(200);
    const frames = parseFrames(res.body);

    const stopFrames = frames.filter((f) => f.eventType === "contentBlockStop");
    expect(stopFrames.length).toBeGreaterThanOrEqual(1);

    for (const frame of stopFrames) {
      const payload = frame.payload as { contentBlockIndex: number };
      expect(payload).toHaveProperty("contentBlockIndex");
      expect(typeof payload.contentBlockIndex).toBe("number");
      // Must NOT be double-wrapped with the event type name
      expect(payload).not.toHaveProperty("contentBlockStop");
    }
  });

  it("tool-call contentBlockStop payloads are also flat", async () => {
    instance = await createServer(allFixtures);
    const res = await postBinary(`${instance.url}/model/${MODEL_ID}/converse-stream`, {
      messages: [{ role: "user", content: [{ text: "weather" }] }],
    });

    expect(res.status).toBe(200);
    const frames = parseFrames(res.body);

    const stopFrames = frames.filter((f) => f.eventType === "contentBlockStop");
    expect(stopFrames.length).toBeGreaterThanOrEqual(1);

    for (const frame of stopFrames) {
      const payload = frame.payload as { contentBlockIndex: number };
      expect(payload).toHaveProperty("contentBlockIndex");
      expect(payload).not.toHaveProperty("contentBlockStop");
    }
  });

  it("messageStop payloads are flat { stopReason: '...' } (not double-wrapped)", async () => {
    instance = await createServer(allFixtures);
    const res = await postBinary(`${instance.url}/model/${MODEL_ID}/converse-stream`, {
      messages: [{ role: "user", content: [{ text: "hello" }] }],
    });

    expect(res.status).toBe(200);
    const frames = parseFrames(res.body);

    const msgStopFrames = frames.filter((f) => f.eventType === "messageStop");
    expect(msgStopFrames).toHaveLength(1);

    const payload = msgStopFrames[0].payload as { stopReason: string };
    expect(payload).toHaveProperty("stopReason");
    expect(payload).not.toHaveProperty("messageStop");
    expect(Object.keys(payload)).toEqual(["stopReason"]);
  });

  it("messageStart payloads are flat { role: 'assistant' } (not double-wrapped)", async () => {
    instance = await createServer(allFixtures);
    const res = await postBinary(`${instance.url}/model/${MODEL_ID}/converse-stream`, {
      messages: [{ role: "user", content: [{ text: "hello" }] }],
    });

    expect(res.status).toBe(200);
    const frames = parseFrames(res.body);

    const msgStartFrames = frames.filter((f) => f.eventType === "messageStart");
    expect(msgStartFrames).toHaveLength(1);

    const payload = msgStartFrames[0].payload as { role: string };
    expect(payload).toEqual({ role: "assistant" });
    expect(payload).not.toHaveProperty("messageStart");
  });

  it("metadata payloads are flat { usage: ..., metrics: ... } (not double-wrapped)", async () => {
    instance = await createServer(allFixtures);
    const res = await postBinary(`${instance.url}/model/${MODEL_ID}/converse-stream`, {
      messages: [{ role: "user", content: [{ text: "hello" }] }],
    });

    expect(res.status).toBe(200);
    const frames = parseFrames(res.body);

    const metadataFrames = frames.filter((f) => f.eventType === "metadata");
    expect(metadataFrames).toHaveLength(1);

    const payload = metadataFrames[0].payload as { usage: object; metrics: object };
    expect(payload).toHaveProperty("usage");
    expect(payload).toHaveProperty("metrics");
    expect(payload).not.toHaveProperty("metadata");
  });
});

// ─── converse-stream: contentWithToolCalls full structure ─────────────────────

describe("POST /model/{modelId}/converse-stream (contentWithToolCalls full structure)", () => {
  const MODEL_ID = "anthropic.claude-3-5-sonnet-20241022-v2:0";

  it("verifies complete event sequence for content + tool calls", async () => {
    instance = await createServer(allFixtures);
    const res = await postBinary(`${instance.url}/model/${MODEL_ID}/converse-stream`, {
      messages: [{ role: "user", content: [{ text: "search-and-explain" }] }],
    });

    expect(res.status).toBe(200);
    const frames = parseFrames(res.body);

    // 1. Stream starts with messageStart (role: assistant) — flat payload
    expect(frames[0].eventType).toBe("messageStart");
    expect(frames[0].payload).toEqual({ role: "assistant" });

    // 2. Collect all contentBlockStart frames
    const blockStarts = frames.filter((f) => f.eventType === "contentBlockStart");
    expect(blockStarts.length).toBe(2); // one text, one tool

    // 3. Text content block appears before tool call block
    //    Text block start has an empty `start` object (no `type` field)
    const textBlockStartIdx = frames.findIndex(
      (f) =>
        f.eventType === "contentBlockStart" &&
        !(f.payload as { start?: { toolUse?: unknown; reasoningContent?: unknown } }).start
          ?.toolUse &&
        !(f.payload as { start?: { toolUse?: unknown; reasoningContent?: unknown } }).start
          ?.reasoningContent,
    );
    const toolBlockStartIdx = frames.findIndex(
      (f) =>
        f.eventType === "contentBlockStart" &&
        (f.payload as { start?: { toolUse?: unknown } }).start?.toolUse !== undefined,
    );
    expect(textBlockStartIdx).toBeLessThan(toolBlockStartIdx);

    // 4. Tool call block has contentBlockStart with toolUse (toolUseId + name) — flat payload
    const toolBlockStart = frames[toolBlockStartIdx];
    const toolStartPayload = toolBlockStart.payload as {
      contentBlockIndex: number;
      start: { toolUse: { toolUseId: string; name: string } };
    };
    expect(toolStartPayload.start.toolUse.name).toBe("web_search");
    expect(toolStartPayload.start.toolUse.toolUseId).toBeDefined();
    expect(typeof toolStartPayload.start.toolUse.toolUseId).toBe("string");

    // 5. Tool call block has contentBlockDelta chunks after its start
    const toolBlockIndex = toolStartPayload.contentBlockIndex;
    const toolDeltas = frames.filter(
      (f) =>
        f.eventType === "contentBlockDelta" &&
        (f.payload as { contentBlockIndex?: number }).contentBlockIndex === toolBlockIndex,
    );
    expect(toolDeltas.length).toBeGreaterThanOrEqual(1);

    // 6. Tool call block has contentBlockStop — flat payload
    const toolBlockStop = frames.find(
      (f) =>
        f.eventType === "contentBlockStop" &&
        (f.payload as { contentBlockIndex?: number }).contentBlockIndex === toolBlockIndex,
    );
    expect(toolBlockStop).toBeDefined();
    expect(toolBlockStop!.payload).toEqual({ contentBlockIndex: toolBlockIndex });

    // 7. Stream ends with messageStop (stopReason: tool_use) then metadata
    const msgStopIdx = frames.findIndex((f) => f.eventType === "messageStop");
    const metadataIdx = frames.findIndex((f) => f.eventType === "metadata");
    expect(msgStopIdx).toBeGreaterThan(-1);
    expect(metadataIdx).toBeGreaterThan(-1);
    expect(metadataIdx).toBe(msgStopIdx + 1); // metadata immediately follows messageStop
    expect(metadataIdx).toBe(frames.length - 1); // metadata is last frame

    const msgStopPayload = frames[msgStopIdx].payload as { stopReason: string };
    expect(msgStopPayload).toEqual({ stopReason: "tool_use" });

    // 8. contentBlockIndex values are sequential across text and tool blocks — flat payloads
    const allBlockStarts = frames
      .filter((f) => f.eventType === "contentBlockStart")
      .map((f) => (f.payload as { contentBlockIndex: number }).contentBlockIndex);
    expect(allBlockStarts).toEqual([0, 1]);

    const allBlockStops = frames
      .filter((f) => f.eventType === "contentBlockStop")
      .map((f) => (f.payload as { contentBlockIndex: number }).contentBlockIndex);
    expect(allBlockStops).toEqual([0, 1]);
  });

  it("verifies sequential contentBlockIndex with multiple tool calls", async () => {
    const multiToolContentFixture: Fixture = {
      match: { userMessage: "multi-tool-with-text" },
      response: {
        content: "I will use two tools.",
        toolCalls: [
          { name: "tool_a", arguments: '{"x":1}' },
          { name: "tool_b", arguments: '{"y":2}' },
        ],
      },
    };
    instance = await createServer([multiToolContentFixture]);
    const res = await postBinary(`${instance.url}/model/${MODEL_ID}/converse-stream`, {
      messages: [{ role: "user", content: [{ text: "multi-tool-with-text" }] }],
    });

    expect(res.status).toBe(200);
    const frames = parseFrames(res.body);

    // contentBlockIndex: 0 = text, 1 = tool_a, 2 = tool_b — flat payloads
    const blockStarts = frames.filter((f) => f.eventType === "contentBlockStart");
    expect(blockStarts).toHaveLength(3);

    const indices = blockStarts.map(
      (f) => (f.payload as { contentBlockIndex: number }).contentBlockIndex,
    );
    expect(indices).toEqual([0, 1, 2]);

    // Text block at index 0 — start is empty (no `type` field)
    const textStartPayload = blockStarts[0].payload as { start: Record<string, unknown> };
    expect(Object.keys(textStartPayload.start)).toEqual([]);
    expect(textStartPayload.start).not.toHaveProperty("type");

    // Tool blocks at indices 1 and 2
    const tool1Start = blockStarts[1].payload as {
      start: { toolUse: { name: string } };
    };
    expect(tool1Start.start.toolUse.name).toBe("tool_a");

    const tool2Start = blockStarts[2].payload as {
      start: { toolUse: { name: string } };
    };
    expect(tool2Start.start.toolUse.name).toBe("tool_b");

    // contentBlockStop indices are also sequential — flat payloads
    const blockStops = frames.filter((f) => f.eventType === "contentBlockStop");
    const stopIndices = blockStops.map(
      (f) => (f.payload as { contentBlockIndex: number }).contentBlockIndex,
    );
    expect(stopIndices).toEqual([0, 1, 2]);

    // messageStop with tool_use — flat payload
    const msgStop = frames.find((f) => f.eventType === "messageStop");
    expect(msgStop!.payload).toEqual({ stopReason: "tool_use" });
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

  it("forwards inferenceConfig.maxTokens as max_tokens", () => {
    const result = converseToCompletionRequest(
      {
        messages: [{ role: "user", content: [{ text: "hi" }] }],
        inferenceConfig: { maxTokens: 100 },
      },
      "model-id",
    );

    expect(result.max_tokens).toBe(100);
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
    expect(body.error.message).toMatch(/^Malformed JSON: /);
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

    // Find Anthropic-native content_block_delta frames with input_json_delta
    const deltas = frames.filter(
      (f) => (f.payload as { type?: string }).type === "content_block_delta",
    );
    const fullJson = deltas
      .map((f) => (f.payload as { delta: { partial_json?: string } }).delta.partial_json ?? "")
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

    // Should still have message_start, content_block_start, content_block_stop, message_stop
    // payloads inside Bedrock EventStream chunk frames.
    expect(frames[0].eventType).toBe("chunk");
    expect(frames[0].payload).toMatchObject({ type: "message_start" });
    expect(
      frames.find((f) => (f.payload as { type?: string }).type === "content_block_start"),
    ).toBeDefined();
    expect(
      frames.find((f) => (f.payload as { type?: string }).type === "content_block_stop"),
    ).toBeDefined();
    expect(
      frames.find((f) => (f.payload as { type?: string }).type === "message_stop"),
    ).toBeDefined();

    // Content deltas should be zero (empty string → no chunks)
    const deltas = frames.filter(
      (f) => (f.payload as { type?: string }).type === "content_block_delta",
    );
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
    expect(body.error.message).toMatch(/^Malformed JSON: /);
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
    expect(result.max_tokens).toBe(100);
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
    // Empty text → content is null (|| coerces empty string to null)
    expect(result.messages[0].content).toBe(null);
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
