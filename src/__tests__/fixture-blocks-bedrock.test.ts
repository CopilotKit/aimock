import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import { crc32 } from "node:zlib";
import type { Fixture } from "../types.js";
import { createServer, type ServerInstance } from "../server.js";

// ─── HTTP helpers (mirror bedrock-stream.test.ts) ───────────────────────────

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

interface ParsedFrame {
  eventType: string;
  payload: unknown;
}

function parseFrames(buf: Buffer): ParsedFrame[] {
  const frames: ParsedFrame[] = [];
  let offset = 0;

  while (offset < buf.length) {
    const totalLength = buf.readUInt32BE(offset);
    const frame = buf.subarray(offset, offset + totalLength);

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

    const payloadStart = headersEnd;
    const payloadEnd = totalLength - 4;
    const payloadBuf = frame.subarray(payloadStart, payloadEnd);
    let payload: unknown = null;
    if (payloadBuf.length > 0) {
      payload = JSON.parse(payloadBuf.toString("utf8"));
    }

    // crc32 is imported to keep the parser shape identical to the sibling
    // suite; checksum validation is exercised exhaustively in bedrock-stream.
    void crc32;

    frames.push({
      eventType: headers[":event-type"] ?? "",
      payload,
    });

    offset += totalLength;
  }

  return frames;
}

// ─── test lifecycle ─────────────────────────────────────────────────────────

const MODEL_ID = "anthropic.claude-3-5-sonnet-20241022-v2:0";

let instance: ServerInstance | null = null;

afterEach(async () => {
  if (instance) {
    await new Promise<void>((resolve) => {
      instance!.server.close(() => resolve());
    });
    instance = null;
  }
});

// ─── tool-first ordering (combined fixture: content + toolCalls + blocks) ────

describe("Bedrock invoke — ordered fixture blocks (tool-first)", () => {
  const toolFirstFixture: Fixture = {
    match: { userMessage: "bedrock blocks tool-first" },
    response: {
      content: "Checking.",
      toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
      blocks: [
        { type: "toolCall", name: "get_weather", arguments: '{"city":"NYC"}' },
        { type: "text", text: "Here you go." },
      ],
    },
  };

  it("non-streaming: emits tool_use content entry before text in content[]", async () => {
    instance = await createServer([toolFirstFixture]);
    const res = await post(`${instance.url}/model/${MODEL_ID}/invoke`, {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 512,
      messages: [{ role: "user", content: "bedrock blocks tool-first" }],
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as {
      content: Array<{ type: string; name?: string; text?: string; input?: unknown }>;
      stop_reason: string;
    };

    expect(body.content).toHaveLength(2);
    // tool_use FIRST (index 0), text SECOND (index 1).
    expect(body.content[0].type).toBe("tool_use");
    expect(body.content[0].name).toBe("get_weather");
    expect(body.content[0].input).toEqual({ city: "NYC" });
    expect(body.content[1].type).toBe("text");
    expect(body.content[1].text).toBe("Here you go.");
    expect(body.stop_reason).toBe("tool_use");
  });

  it("streaming: emits tool_use content_block events before text", async () => {
    instance = await createServer([toolFirstFixture]);
    const res = await postBinary(`${instance.url}/model/${MODEL_ID}/invoke-with-response-stream`, {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 512,
      messages: [{ role: "user", content: "bedrock blocks tool-first" }],
    });

    expect(res.status).toBe(200);
    const frames = parseFrames(res.body);

    const starts = frames.filter(
      (f) => (f.payload as { type?: string }).type === "content_block_start",
    );
    expect(starts).toHaveLength(2);

    // First content block at index 0 is the tool_use; text follows at index 1.
    const s0 = starts[0].payload as {
      index: number;
      content_block: { type: string; name?: string };
    };
    const s1 = starts[1].payload as { index: number; content_block: { type: string } };
    expect(s0.index).toBe(0);
    expect(s0.content_block.type).toBe("tool_use");
    expect(s0.content_block.name).toBe("get_weather");
    expect(s1.index).toBe(1);
    expect(s1.content_block.type).toBe("text");

    // tool_use start must precede the text start on the wire.
    const toolStartIdx = frames.findIndex(
      (f) =>
        (f.payload as { type?: string }).type === "content_block_start" &&
        (f.payload as { content_block?: { type: string } }).content_block?.type === "tool_use",
    );
    const textStartIdx = frames.findIndex(
      (f) =>
        (f.payload as { type?: string }).type === "content_block_start" &&
        (f.payload as { content_block?: { type: string } }).content_block?.type === "text",
    );
    expect(toolStartIdx).toBeLessThan(textStartIdx);

    // tool input arrives via input_json_delta on index 0.
    const toolDelta = frames.find(
      (f) =>
        (f.payload as { type?: string }).type === "content_block_delta" &&
        (f.payload as { index?: number }).index === 0 &&
        (f.payload as { delta?: { type?: string } }).delta?.type === "input_json_delta",
    );
    expect(toolDelta).toBeDefined();
    expect(
      JSON.parse((toolDelta!.payload as { delta: { partial_json: string } }).delta.partial_json),
    ).toEqual({ city: "NYC" });

    // text arrives via text_delta on index 1.
    const textDelta = frames.find(
      (f) =>
        (f.payload as { type?: string }).type === "content_block_delta" &&
        (f.payload as { index?: number }).index === 1 &&
        (f.payload as { delta?: { type?: string } }).delta?.type === "text_delta",
    );
    expect(textDelta).toBeDefined();
    expect((textDelta!.payload as { delta: { text: string } }).delta.text).toBe("Here you go.");

    // message envelope preserved, stop_reason tool_use.
    expect((frames[0].payload as { type?: string }).type).toBe("message_start");
    const msgDelta = frames.find((f) => (f.payload as { type?: string }).type === "message_delta");
    expect((msgDelta!.payload as { delta: { stop_reason: string } }).delta.stop_reason).toBe(
      "tool_use",
    );
    expect(
      frames.find((f) => (f.payload as { type?: string }).type === "message_stop"),
    ).toBeDefined();
  });
});

// ─── blocks-only fixture (no content / no toolCalls) ─────────────────────────

describe("Bedrock invoke — blocks-only fixture", () => {
  const blocksOnlyFixture: Fixture = {
    match: { userMessage: "bedrock blocks-only" },
    response: {
      blocks: [
        { type: "toolCall", name: "lookup", arguments: '{"id":7}' },
        { type: "text", text: "Done." },
      ],
    },
  };

  it("streaming: emits tool-first content_block events purely from blocks", async () => {
    instance = await createServer([blocksOnlyFixture]);
    const res = await postBinary(`${instance.url}/model/${MODEL_ID}/invoke-with-response-stream`, {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 512,
      messages: [{ role: "user", content: "bedrock blocks-only" }],
    });

    expect(res.status).toBe(200);
    const frames = parseFrames(res.body);

    const starts = frames.filter(
      (f) => (f.payload as { type?: string }).type === "content_block_start",
    );
    expect(starts).toHaveLength(2);

    const s0 = starts[0].payload as {
      index: number;
      content_block: { type: string; name?: string };
    };
    expect(s0.index).toBe(0);
    expect(s0.content_block.type).toBe("tool_use");
    expect(s0.content_block.name).toBe("lookup");

    const s1 = starts[1].payload as { index: number; content_block: { type: string } };
    expect(s1.index).toBe(1);
    expect(s1.content_block.type).toBe("text");

    const textDelta = frames.find(
      (f) =>
        (f.payload as { type?: string }).type === "content_block_delta" &&
        (f.payload as { index?: number }).index === 1 &&
        (f.payload as { delta?: { type?: string } }).delta?.type === "text_delta",
    );
    expect((textDelta!.payload as { delta: { text: string } }).delta.text).toBe("Done.");
  });

  it("non-streaming: emits tool-first content[] purely from blocks", async () => {
    instance = await createServer([blocksOnlyFixture]);
    const res = await post(`${instance.url}/model/${MODEL_ID}/invoke`, {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 512,
      messages: [{ role: "user", content: "bedrock blocks-only" }],
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as {
      content: Array<{ type: string; name?: string; text?: string }>;
    };
    expect(body.content).toHaveLength(2);
    expect(body.content[0].type).toBe("tool_use");
    expect(body.content[0].name).toBe("lookup");
    expect(body.content[1].type).toBe("text");
    expect(body.content[1].text).toBe("Done.");
  });
});

// ─── back-compat: no-blocks fixture → identical legacy text-first output ─────

describe("Bedrock invoke — back-compat (no blocks)", () => {
  const legacyFixture: Fixture = {
    match: { userMessage: "bedrock blocks legacy" },
    response: {
      content: "Checking.",
      toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
    },
  };

  it("non-streaming: legacy emits text content entry first, then tool_use", async () => {
    instance = await createServer([legacyFixture]);
    const res = await post(`${instance.url}/model/${MODEL_ID}/invoke`, {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 512,
      messages: [{ role: "user", content: "bedrock blocks legacy" }],
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as {
      content: Array<{ type: string; text?: string; name?: string }>;
    };
    expect(body.content).toHaveLength(2);
    expect(body.content[0].type).toBe("text");
    expect(body.content[0].text).toBe("Checking.");
    expect(body.content[1].type).toBe("tool_use");
    expect(body.content[1].name).toBe("get_weather");
  });

  it("streaming: legacy emits text block at index 0, then tool_use at index 1", async () => {
    instance = await createServer([legacyFixture]);
    const res = await postBinary(`${instance.url}/model/${MODEL_ID}/invoke-with-response-stream`, {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 512,
      messages: [{ role: "user", content: "bedrock blocks legacy" }],
    });

    expect(res.status).toBe(200);
    const frames = parseFrames(res.body);
    const starts = frames.filter(
      (f) => (f.payload as { type?: string }).type === "content_block_start",
    );
    expect(starts).toHaveLength(2);

    const s0 = starts[0].payload as { index: number; content_block: { type: string } };
    const s1 = starts[1].payload as { index: number; content_block: { type: string } };
    expect(s0.index).toBe(0);
    expect(s0.content_block.type).toBe("text");
    expect(s1.index).toBe(1);
    expect(s1.content_block.type).toBe("tool_use");
  });
});
