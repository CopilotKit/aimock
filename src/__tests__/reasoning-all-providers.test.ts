import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import { crc32 } from "node:zlib";
import type { Fixture } from "../types.js";
import { createServer, type ServerInstance } from "../server.js";
import { buildBedrockStreamTextEvents } from "../bedrock.js";

// --- helpers ---

let instance: ServerInstance;
let baseUrl: string;

function post(
  path: string,
  body: unknown,
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

    // Verify prelude CRC
    const computedPreludeCrc = crc32(buf.subarray(offset, offset + 8));
    if (computedPreludeCrc >>> 0 !== preludeCrc) {
      throw new Error("Prelude CRC mismatch");
    }

    // Parse headers
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

    // Parse payload
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

interface SSEEvent {
  type?: string;
  choices?: {
    delta: { content?: string; reasoning_content?: string; role?: string };
    finish_reason: string | null;
  }[];
  [key: string]: unknown;
}

function parseSSEEvents(body: string): SSEEvent[] {
  const events: SSEEvent[] = [];
  for (const line of body.split("\n")) {
    if (line.startsWith("data: ") && line.slice(6).trim() !== "[DONE]") {
      events.push(JSON.parse(line.slice(6)) as SSEEvent);
    }
  }
  return events;
}

// --- fixtures ---

const reasoningFixture: Fixture = {
  match: { userMessage: "think" },
  response: {
    content: "The answer is 42.",
    reasoning: "Let me think step by step about this problem.",
  },
};

const plainFixture: Fixture = {
  match: { userMessage: "plain" },
  response: { content: "Just plain text." },
};

const allFixtures: Fixture[] = [reasoningFixture, plainFixture];

// --- server lifecycle ---

beforeAll(async () => {
  instance = await createServer(allFixtures);
  baseUrl = instance.url;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    instance.server.close(() => resolve());
  });
});

// ─── OpenAI Chat Completions: Reasoning ─────────────────────────────────────

describe("POST /v1/chat/completions (reasoning non-streaming)", () => {
  it("includes reasoning_content field on assistant message", async () => {
    const res = await post(`/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "think" }],
      stream: false,
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.choices[0].message.content).toBe("The answer is 42.");
    expect(body.choices[0].message.reasoning_content).toBe(
      "Let me think step by step about this problem.",
    );
  });

  it("omits reasoning_content when reasoning is absent", async () => {
    const res = await post(`/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "plain" }],
      stream: false,
    });

    const body = JSON.parse(res.body);
    expect(body.choices[0].message.content).toBe("Just plain text.");
    expect(body.choices[0].message.reasoning_content).toBeUndefined();
  });
});

describe("POST /v1/chat/completions (reasoning streaming)", () => {
  it("emits reasoning_content deltas before content deltas", async () => {
    const res = await post(`/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "think" }],
      stream: true,
    });

    expect(res.status).toBe(200);
    const events = parseSSEEvents(res.body);

    const reasoningDeltas = events
      .filter((e) => e.choices?.[0]?.delta?.reasoning_content !== undefined)
      .map((e) => e.choices![0].delta.reasoning_content);
    expect(reasoningDeltas.join("")).toBe("Let me think step by step about this problem.");

    const contentDeltas = events
      .filter(
        (e) => e.choices?.[0]?.delta?.content !== undefined && e.choices[0].delta.content !== "",
      )
      .map((e) => e.choices![0].delta.content);
    expect(contentDeltas.join("")).toBe("The answer is 42.");

    const lastReasoningIdx = events.reduce(
      (acc, e, idx) => (e.choices?.[0]?.delta?.reasoning_content !== undefined ? idx : acc),
      -1,
    );
    const firstContentIdx = events.findIndex(
      (e) => e.choices?.[0]?.delta?.content !== undefined && e.choices[0].delta.content !== "",
    );
    expect(lastReasoningIdx).toBeLessThan(firstContentIdx);
  });

  it("no reasoning_content deltas when reasoning is absent", async () => {
    const res = await post(`/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "plain" }],
      stream: true,
    });

    const events = parseSSEEvents(res.body);
    const reasoningDeltas = events.filter(
      (e) => e.choices?.[0]?.delta?.reasoning_content !== undefined,
    );
    expect(reasoningDeltas).toHaveLength(0);
  });
});

// ─── Gemini: Reasoning ──────────────────────────────────────────────────────

function parseGeminiSSEChunks(body: string): unknown[] {
  const chunks: unknown[] = [];
  for (const line of body.split("\n")) {
    if (line.startsWith("data: ")) {
      chunks.push(JSON.parse(line.slice(6)));
    }
  }
  return chunks;
}

describe("POST /v1beta/models/{model}:generateContent (reasoning non-streaming)", () => {
  it("includes thought part before text part", async () => {
    const res = await post(`/v1beta/models/gemini-2.5-flash:generateContent`, {
      contents: [{ role: "user", parts: [{ text: "think" }] }],
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    const parts = body.candidates[0].content.parts;
    expect(parts).toHaveLength(2);
    expect(parts[0].thought).toBe(true);
    expect(parts[0].text).toBe("Let me think step by step about this problem.");
    expect(parts[1].text).toBe("The answer is 42.");
    expect(parts[1].thought).toBeUndefined();
  });

  it("no thought part when reasoning is absent", async () => {
    const res = await post(`/v1beta/models/gemini-2.5-flash:generateContent`, {
      contents: [{ role: "user", parts: [{ text: "plain" }] }],
    });

    const body = JSON.parse(res.body);
    const parts = body.candidates[0].content.parts;
    expect(parts).toHaveLength(1);
    expect(parts[0].text).toBe("Just plain text.");
    expect(parts[0].thought).toBeUndefined();
  });
});

describe("POST /v1beta/models/{model}:streamGenerateContent (reasoning streaming)", () => {
  it("streams thought chunks before text chunks", async () => {
    const res = await post(`/v1beta/models/gemini-2.5-flash:streamGenerateContent`, {
      contents: [{ role: "user", parts: [{ text: "think" }] }],
    });

    expect(res.status).toBe(200);
    const chunks = parseGeminiSSEChunks(res.body) as {
      candidates: {
        content: { role: string; parts: { text?: string; thought?: boolean }[] };
        finishReason?: string;
      }[];
    }[];

    const thoughtChunks = chunks.filter((c) => c.candidates[0].content.parts[0].thought === true);
    const textChunks = chunks.filter((c) => c.candidates[0].content.parts[0].thought === undefined);

    expect(thoughtChunks.length).toBeGreaterThan(0);
    expect(textChunks.length).toBeGreaterThan(0);

    const fullThought = thoughtChunks
      .map((c) => c.candidates[0].content.parts[0].text ?? "")
      .join("");
    expect(fullThought).toBe("Let me think step by step about this problem.");

    const fullText = textChunks.map((c) => c.candidates[0].content.parts[0].text ?? "").join("");
    expect(fullText).toBe("The answer is 42.");

    const lastChunk = chunks[chunks.length - 1];
    expect(lastChunk.candidates[0].finishReason).toBe("STOP");
  });

  it("no thought chunks when reasoning is absent", async () => {
    const res = await post(`/v1beta/models/gemini-2.5-flash:streamGenerateContent`, {
      contents: [{ role: "user", parts: [{ text: "plain" }] }],
    });

    const chunks = parseGeminiSSEChunks(res.body) as {
      candidates: {
        content: { parts: { text?: string; thought?: boolean }[] };
      }[];
    }[];

    const thoughtChunks = chunks.filter((c) => c.candidates[0].content.parts[0].thought === true);
    expect(thoughtChunks).toHaveLength(0);
  });
});

// ─── Bedrock InvokeModel: Reasoning ─────────────────────────────────────────

describe("POST /model/{id}/invoke (reasoning non-streaming)", () => {
  it("includes thinking content block before text block", async () => {
    const res = await post(`/model/anthropic.claude-3-sonnet-20240229-v1:0/invoke`, {
      messages: [{ role: "user", content: [{ type: "text", text: "think" }] }],
      max_tokens: 1024,
      anthropic_version: "bedrock-2023-05-31",
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.content).toHaveLength(2);
    expect(body.content[0].type).toBe("thinking");
    expect(body.content[0].thinking).toBe("Let me think step by step about this problem.");
    expect(body.content[1].type).toBe("text");
    expect(body.content[1].text).toBe("The answer is 42.");
  });

  it("no thinking block when reasoning is absent", async () => {
    const res = await post(`/model/anthropic.claude-3-sonnet-20240229-v1:0/invoke`, {
      messages: [{ role: "user", content: [{ type: "text", text: "plain" }] }],
      max_tokens: 1024,
      anthropic_version: "bedrock-2023-05-31",
    });

    const body = JSON.parse(res.body);
    expect(body.content).toHaveLength(1);
    expect(body.content[0].type).toBe("text");
  });
});

// ─── Bedrock Converse: Reasoning ────────────────────────────────────────────

describe("POST /model/{id}/converse (reasoning non-streaming)", () => {
  it("includes reasoningContent block before text block", async () => {
    const res = await post(`/model/anthropic.claude-3-sonnet-20240229-v1:0/converse`, {
      messages: [{ role: "user", content: [{ text: "think" }] }],
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    const content = body.output.message.content;
    expect(content).toHaveLength(2);
    expect(content[0].reasoningContent).toBeDefined();
    expect(content[0].reasoningContent.reasoningText.text).toBe(
      "Let me think step by step about this problem.",
    );
    expect(content[1].text).toBe("The answer is 42.");
  });

  it("no reasoningContent block when reasoning is absent", async () => {
    const res = await post(`/model/anthropic.claude-3-sonnet-20240229-v1:0/converse`, {
      messages: [{ role: "user", content: [{ text: "plain" }] }],
    });

    const body = JSON.parse(res.body);
    const content = body.output.message.content;
    expect(content).toHaveLength(1);
    expect(content[0].text).toBe("Just plain text.");
  });
});

// ─── Bedrock InvokeModel Streaming: Reasoning ─────────────────────────────────

describe("POST /model/{id}/invoke-with-response-stream (reasoning streaming)", () => {
  it("emits thinking block events before text content events", async () => {
    const res = await postRaw(
      `/model/anthropic.claude-3-sonnet-20240229-v1:0/invoke-with-response-stream`,
      {
        messages: [{ role: "user", content: [{ type: "text", text: "think" }] }],
        max_tokens: 1024,
        anthropic_version: "bedrock-2023-05-31",
      },
    );

    expect(res.status).toBe(200);
    const frames = decodeEventStreamFrames(res.body);
    const eventTypes = frames.map((f) => f.eventType);

    // Should start with messageStart
    expect(eventTypes[0]).toBe("messageStart");

    // Find thinking and text block starts
    const thinkingStartIdx = frames.findIndex(
      (f) =>
        f.eventType === "contentBlockStart" &&
        (f.payload as { contentBlockStart?: { start?: { type?: string } } }).contentBlockStart
          ?.start?.type === "thinking",
    );
    const textStartIdx = frames.findIndex(
      (f) =>
        f.eventType === "contentBlockStart" &&
        (f.payload as { contentBlockStart?: { start?: { type?: string } } }).contentBlockStart
          ?.start?.type === "text",
    );

    expect(thinkingStartIdx).toBeGreaterThan(0);
    expect(textStartIdx).toBeGreaterThan(thinkingStartIdx);

    // Verify thinking content
    const thinkingDeltas = frames.filter(
      (f) =>
        f.eventType === "contentBlockDelta" &&
        (f.payload as { contentBlockDelta?: { delta?: { type?: string } } }).contentBlockDelta
          ?.delta?.type === "thinking_delta",
    );
    const fullThinking = thinkingDeltas
      .map(
        (f) =>
          (f.payload as { contentBlockDelta: { delta: { thinking: string } } }).contentBlockDelta
            .delta.thinking,
      )
      .join("");
    expect(fullThinking).toBe("Let me think step by step about this problem.");

    // Verify text content
    const textDeltas = frames.filter(
      (f) =>
        f.eventType === "contentBlockDelta" &&
        typeof (f.payload as { contentBlockDelta?: { delta?: { text?: string } } })
          .contentBlockDelta?.delta?.text === "string",
    );
    const fullText = textDeltas
      .map(
        (f) =>
          (f.payload as { contentBlockDelta: { delta: { text: string } } }).contentBlockDelta.delta
            .text,
      )
      .join("");
    expect(fullText).toBe("The answer is 42.");

    // Should end with messageStop
    expect(eventTypes[eventTypes.length - 1]).toBe("messageStop");
  });

  it("no thinking block when reasoning is absent", async () => {
    const res = await postRaw(
      `/model/anthropic.claude-3-sonnet-20240229-v1:0/invoke-with-response-stream`,
      {
        messages: [{ role: "user", content: [{ type: "text", text: "plain" }] }],
        max_tokens: 1024,
        anthropic_version: "bedrock-2023-05-31",
      },
    );

    expect(res.status).toBe(200);
    const frames = decodeEventStreamFrames(res.body);

    const thinkingDeltas = frames.filter(
      (f) =>
        f.eventType === "contentBlockDelta" &&
        (f.payload as { contentBlockDelta?: { delta?: { type?: string } } }).contentBlockDelta
          ?.delta?.type === "thinking_delta",
    );
    expect(thinkingDeltas).toHaveLength(0);
  });
});

// ─── Bedrock Converse Streaming: Reasoning ────────────────────────────────────

describe("POST /model/{id}/converse-stream (reasoning streaming)", () => {
  it("emits thinking block events before text content events", async () => {
    const res = await postRaw(`/model/anthropic.claude-3-sonnet-20240229-v1:0/converse-stream`, {
      messages: [{ role: "user", content: [{ text: "think" }] }],
    });

    expect(res.status).toBe(200);
    const frames = decodeEventStreamFrames(res.body);
    const eventTypes = frames.map((f) => f.eventType);

    expect(eventTypes[0]).toBe("messageStart");

    // Find thinking and text block starts
    const thinkingStartIdx = frames.findIndex(
      (f) =>
        f.eventType === "contentBlockStart" &&
        (f.payload as { contentBlockStart?: { start?: { type?: string } } }).contentBlockStart
          ?.start?.type === "thinking",
    );
    const textStartIdx = frames.findIndex(
      (f) =>
        f.eventType === "contentBlockStart" &&
        (f.payload as { contentBlockStart?: { start?: { type?: string } } }).contentBlockStart
          ?.start?.type === "text",
    );

    expect(thinkingStartIdx).toBeGreaterThan(0);
    expect(textStartIdx).toBeGreaterThan(thinkingStartIdx);

    // Verify reasoning content appears in the stream
    const thinkingDeltas = frames.filter(
      (f) =>
        f.eventType === "contentBlockDelta" &&
        (f.payload as { contentBlockDelta?: { delta?: { type?: string } } }).contentBlockDelta
          ?.delta?.type === "thinking_delta",
    );
    const fullThinking = thinkingDeltas
      .map(
        (f) =>
          (f.payload as { contentBlockDelta: { delta: { thinking: string } } }).contentBlockDelta
            .delta.thinking,
      )
      .join("");
    expect(fullThinking).toBe("Let me think step by step about this problem.");

    expect(eventTypes[eventTypes.length - 1]).toBe("messageStop");
  });

  it("no thinking block when reasoning is absent", async () => {
    const res = await postRaw(`/model/anthropic.claude-3-sonnet-20240229-v1:0/converse-stream`, {
      messages: [{ role: "user", content: [{ text: "plain" }] }],
    });

    expect(res.status).toBe(200);
    const frames = decodeEventStreamFrames(res.body);

    const thinkingDeltas = frames.filter(
      (f) =>
        f.eventType === "contentBlockDelta" &&
        (f.payload as { contentBlockDelta?: { delta?: { type?: string } } }).contentBlockDelta
          ?.delta?.type === "thinking_delta",
    );
    expect(thinkingDeltas).toHaveLength(0);
  });
});

// ─── Ollama /api/chat: Reasoning ────────────────────────────────────────────

function parseNDJSON(body: string): object[] {
  return body
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as object);
}

describe("POST /api/chat (reasoning non-streaming)", () => {
  it("includes reasoning_content on assistant message", async () => {
    const res = await post(`/api/chat`, {
      model: "deepseek-r1",
      messages: [{ role: "user", content: "think" }],
      stream: false,
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.message.content).toBe("The answer is 42.");
    expect(body.message.reasoning_content).toBe("Let me think step by step about this problem.");
  });

  it("omits reasoning_content when reasoning is absent", async () => {
    const res = await post(`/api/chat`, {
      model: "deepseek-r1",
      messages: [{ role: "user", content: "plain" }],
      stream: false,
    });

    const body = JSON.parse(res.body);
    expect(body.message.content).toBe("Just plain text.");
    expect(body.message.reasoning_content).toBeUndefined();
  });
});

describe("POST /api/chat (reasoning streaming)", () => {
  it("streams reasoning_content chunks before content chunks", async () => {
    const res = await post(`/api/chat`, {
      model: "deepseek-r1",
      messages: [{ role: "user", content: "think" }],
      stream: true,
    });

    expect(res.status).toBe(200);
    const chunks = parseNDJSON(res.body) as {
      message: { role: string; content: string; reasoning_content?: string };
      done: boolean;
    }[];

    const reasoningChunks = chunks.filter(
      (c) => !c.done && c.message.reasoning_content !== undefined,
    );
    expect(reasoningChunks.length).toBeGreaterThan(0);
    const fullReasoning = reasoningChunks.map((c) => c.message.reasoning_content).join("");
    expect(fullReasoning).toBe("Let me think step by step about this problem.");

    const contentChunks = chunks.filter(
      (c) => !c.done && c.message.content !== "" && c.message.reasoning_content === undefined,
    );
    expect(contentChunks.length).toBeGreaterThan(0);
    const fullContent = contentChunks.map((c) => c.message.content).join("");
    expect(fullContent).toBe("The answer is 42.");
  });

  it("no reasoning_content chunks when reasoning is absent", async () => {
    const res = await post(`/api/chat`, {
      model: "deepseek-r1",
      messages: [{ role: "user", content: "plain" }],
      stream: true,
    });

    const chunks = parseNDJSON(res.body) as {
      message: { reasoning_content?: string };
      done: boolean;
    }[];

    const reasoningChunks = chunks.filter(
      (c) => !c.done && c.message.reasoning_content !== undefined,
    );
    expect(reasoningChunks).toHaveLength(0);
  });
});

// ─── Ollama /api/generate: Reasoning ────────────────────────────────────────

describe("POST /api/generate (reasoning non-streaming)", () => {
  it("includes reasoning_content field", async () => {
    const res = await post(`/api/generate`, {
      model: "deepseek-r1",
      prompt: "think",
      stream: false,
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.response).toBe("The answer is 42.");
    expect(body.reasoning_content).toBe("Let me think step by step about this problem.");
  });

  it("omits reasoning_content when reasoning is absent", async () => {
    const res = await post(`/api/generate`, {
      model: "deepseek-r1",
      prompt: "plain",
      stream: false,
    });

    const body = JSON.parse(res.body);
    expect(body.response).toBe("Just plain text.");
    expect(body.reasoning_content).toBeUndefined();
  });
});

describe("POST /api/generate (reasoning streaming)", () => {
  it("streams reasoning_content chunks before response chunks", async () => {
    const res = await post(`/api/generate`, {
      model: "deepseek-r1",
      prompt: "think",
      stream: true,
    });

    expect(res.status).toBe(200);
    const chunks = parseNDJSON(res.body) as {
      response: string;
      reasoning_content?: string;
      done: boolean;
    }[];

    const reasoningChunks = chunks.filter((c) => !c.done && c.reasoning_content !== undefined);
    expect(reasoningChunks.length).toBeGreaterThan(0);
    const fullReasoning = reasoningChunks.map((c) => c.reasoning_content).join("");
    expect(fullReasoning).toBe("Let me think step by step about this problem.");

    const contentChunks = chunks.filter(
      (c) => !c.done && c.response !== "" && c.reasoning_content === undefined,
    );
    expect(contentChunks.length).toBeGreaterThan(0);
    const fullContent = contentChunks.map((c) => c.response).join("");
    expect(fullContent).toBe("The answer is 42.");
  });

  it("no reasoning_content chunks when reasoning is absent", async () => {
    const res = await post(`/api/generate`, {
      model: "deepseek-r1",
      prompt: "plain",
      stream: true,
    });

    const chunks = parseNDJSON(res.body) as {
      reasoning_content?: string;
      done: boolean;
    }[];

    const reasoningChunks = chunks.filter((c) => !c.done && c.reasoning_content !== undefined);
    expect(reasoningChunks).toHaveLength(0);
  });
});

// ─── Bedrock streaming reasoning: unit test ─────────────────────────────────

describe("buildBedrockStreamTextEvents (reasoning)", () => {
  it("emits thinking block events before text block events", () => {
    const events = buildBedrockStreamTextEvents("The answer.", 100, "Step by step.");
    const types = events.map((e) => e.eventType);

    // messageStart → thinking block → text block → messageStop
    expect(types[0]).toBe("messageStart");

    // Thinking block at index 0
    expect(events[1]).toEqual({
      eventType: "contentBlockStart",
      payload: {
        contentBlockIndex: 0,
        contentBlockStart: { contentBlockIndex: 0, start: { type: "thinking" } },
      },
    });
    expect(events[2]).toEqual({
      eventType: "contentBlockDelta",
      payload: {
        contentBlockIndex: 0,
        contentBlockDelta: {
          contentBlockIndex: 0,
          delta: { type: "thinking_delta", thinking: "Step by step." },
        },
      },
    });
    expect(events[3]).toEqual({
      eventType: "contentBlockStop",
      payload: { contentBlockIndex: 0 },
    });

    // Text block at index 1
    expect(events[4]).toEqual({
      eventType: "contentBlockStart",
      payload: {
        contentBlockIndex: 1,
        contentBlockStart: { contentBlockIndex: 1, start: { type: "text" } },
      },
    });
    expect(events[5]).toEqual({
      eventType: "contentBlockDelta",
      payload: {
        contentBlockIndex: 1,
        contentBlockDelta: {
          contentBlockIndex: 1,
          delta: { type: "text_delta", text: "The answer." },
        },
      },
    });
    expect(events[6]).toEqual({
      eventType: "contentBlockStop",
      payload: { contentBlockIndex: 1 },
    });

    expect(events[7]).toEqual({
      eventType: "messageStop",
      payload: { stopReason: "end_turn" },
    });
  });

  it("no thinking block when reasoning is absent", () => {
    const events = buildBedrockStreamTextEvents("Hello.", 100);
    const types = events.map((e) => e.eventType);

    // messageStart → text block at index 0 → messageStop
    expect(types).toEqual([
      "messageStart",
      "contentBlockStart",
      "contentBlockDelta",
      "contentBlockStop",
      "messageStop",
    ]);
    expect((events[1].payload as { contentBlockIndex: number }).contentBlockIndex).toBe(0);
  });
});
