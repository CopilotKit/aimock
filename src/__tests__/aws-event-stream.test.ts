import { describe, it, expect, vi, afterEach } from "vitest";
import { crc32 } from "node:zlib";
import { PassThrough } from "node:stream";
import type * as http from "node:http";
import {
  encodeEventStreamFrame,
  encodeEventStreamMessage,
  writeEventStream,
} from "../aws-event-stream.js";

// ─── Test helpers ────────────────────────────────────────────────────────────

function makeMockResponse(): {
  res: http.ServerResponse;
  chunks: Buffer[];
  headers: () => Record<string, string | string[] | number | undefined>;
  ended: () => boolean;
} {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));

  const writtenHeaders: Record<string, string | string[] | number | undefined> = {};
  let isEnded = false;

  const res = {
    setHeader(name: string, value: string) {
      writtenHeaders[name] = value;
    },
    writeHead(statusCode: number, headers?: Record<string, string>) {
      if (headers) {
        for (const [k, v] of Object.entries(headers)) {
          writtenHeaders[k] = v;
        }
      }
    },
    write(data: Buffer | string) {
      stream.write(data);
    },
    end(data?: Buffer | string) {
      if (data !== undefined) {
        stream.write(data);
      }
      isEnded = true;
      stream.end();
    },
    writableEnded: false,
  } as unknown as http.ServerResponse;

  // Make writableEnded track our isEnded state
  Object.defineProperty(res, "writableEnded", {
    get: () => isEnded,
  });

  return {
    res,
    chunks,
    headers: () => writtenHeaders,
    ended: () => isEnded,
  };
}

/**
 * Parse the binary frame manually and return its components.
 */
function parseFrame(frame: Buffer) {
  const totalLength = frame.readUInt32BE(0);
  const headersLength = frame.readUInt32BE(4);
  const preludeCrc = frame.readUInt32BE(8);
  const headersStart = 12;
  const headersEnd = headersStart + headersLength;
  const payloadStart = headersEnd;
  const payloadEnd = totalLength - 4;
  const messageCrc = frame.readUInt32BE(totalLength - 4);

  // Parse headers
  const headers: Array<{ name: string; type: number; value: string }> = [];
  let offset = headersStart;
  while (offset < headersEnd) {
    const nameLen = frame.readUInt8(offset);
    offset += 1;
    const name = frame.subarray(offset, offset + nameLen).toString("utf8");
    offset += nameLen;
    const type = frame.readUInt8(offset);
    offset += 1;
    const valueLen = frame.readUInt16BE(offset);
    offset += 2;
    const value = frame.subarray(offset, offset + valueLen).toString("utf8");
    offset += valueLen;
    headers.push({ name, type, value });
  }

  const payload = frame.subarray(payloadStart, payloadEnd);

  return { totalLength, headersLength, preludeCrc, headers, payload, messageCrc };
}

// ─── encodeEventStreamFrame ─────────────────────────────────────────────────

describe("encodeEventStreamFrame", () => {
  it("produces a frame whose total_length field matches actual buffer size", () => {
    const headers = { ":event-type": "contentBlockDelta" };
    const payload = Buffer.from(JSON.stringify({ hello: "world" }), "utf8");
    const frame = encodeEventStreamFrame(headers, payload);

    const totalLength = frame.readUInt32BE(0);
    expect(totalLength).toBe(frame.length);
  });

  it("headers_length field matches actual serialised headers size", () => {
    const headers = {
      ":content-type": "application/json",
      ":event-type": "contentBlockDelta",
    };
    const payload = Buffer.from("{}", "utf8");
    const frame = encodeEventStreamFrame(headers, payload);

    const parsed = parseFrame(frame);

    // Manually compute expected headers size
    let expectedLen = 0;
    for (const [name, value] of Object.entries(headers)) {
      const nameBytes = Buffer.byteLength(name, "utf8");
      const valueBytes = Buffer.byteLength(value, "utf8");
      expectedLen += 1 + nameBytes + 1 + 2 + valueBytes;
    }
    expect(parsed.headersLength).toBe(expectedLen);
  });

  it("prelude CRC32 covers first 8 bytes correctly", () => {
    const headers = { ":message-type": "event" };
    const payload = Buffer.from("test", "utf8");
    const frame = encodeEventStreamFrame(headers, payload);

    const expected = crc32(frame.subarray(0, 8));
    expect(frame.readUInt32BE(8)).toBe(expected >>> 0);
  });

  it("message CRC32 covers entire frame minus last 4 bytes", () => {
    const headers = { key: "val" };
    const payload = Buffer.from(JSON.stringify({ n: 42 }), "utf8");
    const frame = encodeEventStreamFrame(headers, payload);

    const expected = crc32(frame.subarray(0, frame.length - 4));
    expect(frame.readUInt32BE(frame.length - 4)).toBe(expected >>> 0);
  });

  it("encodes each header with name_length + name + type(7) + value_length + value", () => {
    const headers = { ":event-type": "chunk", ":message-type": "event" };
    const payload = Buffer.alloc(0);
    const frame = encodeEventStreamFrame(headers, payload);

    const parsed = parseFrame(frame);
    expect(parsed.headers).toHaveLength(2);

    expect(parsed.headers[0].name).toBe(":event-type");
    expect(parsed.headers[0].type).toBe(7);
    expect(parsed.headers[0].value).toBe("chunk");

    expect(parsed.headers[1].name).toBe(":message-type");
    expect(parsed.headers[1].type).toBe(7);
    expect(parsed.headers[1].value).toBe("event");
  });

  it("payload is raw bytes (not base64)", () => {
    const obj = { text: "hello world" };
    const payload = Buffer.from(JSON.stringify(obj), "utf8");
    const frame = encodeEventStreamFrame({}, payload);

    const parsed = parseFrame(frame);
    const decoded = JSON.parse(parsed.payload.toString("utf8"));
    expect(decoded).toEqual(obj);
  });

  it("handles empty headers and empty payload", () => {
    const frame = encodeEventStreamFrame({}, Buffer.alloc(0));
    const parsed = parseFrame(frame);

    // 4 (total) + 4 (headers_length) + 4 (prelude_crc) + 0 (headers) + 0 (payload) + 4 (msg_crc) = 16
    expect(parsed.totalLength).toBe(16);
    expect(parsed.headersLength).toBe(0);
    expect(parsed.headers).toHaveLength(0);
    expect(parsed.payload.length).toBe(0);
  });

  it("large payload (100KB) encoding correctness", () => {
    const largeString = "A".repeat(100 * 1024);
    const payload = Buffer.from(JSON.stringify({ data: largeString }), "utf8");
    const frame = encodeEventStreamFrame({ ":event-type": "big" }, payload);

    const parsed = parseFrame(frame);
    expect(parsed.totalLength).toBe(frame.length);

    // Verify CRCs
    const expectedPrelude = crc32(frame.subarray(0, 8));
    expect(parsed.preludeCrc).toBe(expectedPrelude >>> 0);
    const expectedMsg = crc32(frame.subarray(0, frame.length - 4));
    expect(parsed.messageCrc).toBe(expectedMsg >>> 0);

    // Verify payload
    const decoded = JSON.parse(parsed.payload.toString("utf8"));
    expect(decoded.data.length).toBe(100 * 1024);
  });

  it("handles UTF-8 multi-byte characters in headers and payload", () => {
    const headers = { "x-emoji": "\u{1F600}" };
    const payload = Buffer.from(JSON.stringify({ msg: "\u{1F4A9}" }), "utf8");
    const frame = encodeEventStreamFrame(headers, payload);

    const parsed = parseFrame(frame);
    expect(parsed.headers[0].value).toBe("\u{1F600}");
    const decoded = JSON.parse(parsed.payload.toString("utf8"));
    expect(decoded.msg).toBe("\u{1F4A9}");
  });
});

// ─── encodeEventStreamMessage ───────────────────────────────────────────────

describe("encodeEventStreamMessage", () => {
  it("wraps JSON payload with standard AWS headers", () => {
    const frame = encodeEventStreamMessage("contentBlockDelta", { delta: { text: "hi" } });
    const parsed = parseFrame(frame);

    const headerMap = Object.fromEntries(parsed.headers.map((h) => [h.name, h.value]));
    expect(headerMap[":content-type"]).toBe("application/json");
    expect(headerMap[":event-type"]).toBe("contentBlockDelta");
    expect(headerMap[":message-type"]).toBe("event");
  });

  it("payload is raw JSON bytes (not base64)", () => {
    const obj = { delta: { text: "test" } };
    const frame = encodeEventStreamMessage("contentBlockDelta", obj);
    const parsed = parseFrame(frame);

    const decoded = JSON.parse(parsed.payload.toString("utf8"));
    expect(decoded).toEqual(obj);
  });

  it("round-trip: encode then parse produces identical data", () => {
    const eventType = "messageStop";
    const payload = { stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } };
    const frame = encodeEventStreamMessage(eventType, payload);
    const parsed = parseFrame(frame);

    // Verify structural integrity
    expect(parsed.totalLength).toBe(frame.length);
    const preludeCrc = crc32(frame.subarray(0, 8));
    expect(parsed.preludeCrc).toBe(preludeCrc >>> 0);
    const messageCrc = crc32(frame.subarray(0, frame.length - 4));
    expect(parsed.messageCrc).toBe(messageCrc >>> 0);

    // Verify content
    const headerMap = Object.fromEntries(parsed.headers.map((h) => [h.name, h.value]));
    expect(headerMap[":event-type"]).toBe(eventType);
    expect(JSON.parse(parsed.payload.toString("utf8"))).toEqual(payload);
  });
});

// ─── writeEventStream ───────────────────────────────────────────────────────

describe("writeEventStream", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sets Content-Type to application/vnd.amazon.eventstream", async () => {
    const { res, headers } = makeMockResponse();
    await writeEventStream(res, []);
    expect(headers()["Content-Type"]).toBe("application/vnd.amazon.eventstream");
  });

  it("writes binary frames for each event", async () => {
    const { res, chunks } = makeMockResponse();
    const events = [
      { eventType: "contentBlockDelta", payload: { delta: { text: "A" } } },
      { eventType: "contentBlockDelta", payload: { delta: { text: "B" } } },
    ];
    await writeEventStream(res, events);

    // Wait a tick for PassThrough to flush
    await new Promise((r) => setTimeout(r, 10));

    const output = Buffer.concat(chunks);
    expect(output.length).toBeGreaterThan(0);

    // Parse the first frame from the output
    const firstTotalLen = output.readUInt32BE(0);
    const firstParsed = parseFrame(output.subarray(0, firstTotalLen));
    const firstPayload = JSON.parse(firstParsed.payload.toString("utf8"));
    expect(firstPayload).toEqual({ delta: { text: "A" } });

    // Parse the second frame
    const secondParsed = parseFrame(output.subarray(firstTotalLen));
    const secondPayload = JSON.parse(secondParsed.payload.toString("utf8"));
    expect(secondPayload).toEqual({ delta: { text: "B" } });
  });

  it("returns true when stream completes normally", async () => {
    const { res } = makeMockResponse();
    const result = await writeEventStream(res, [{ eventType: "test", payload: { data: 1 } }]);
    expect(result).toBe(true);
  });

  it("calls res.end() when done", async () => {
    const { res, ended } = makeMockResponse();
    await writeEventStream(res, []);
    expect(ended()).toBe(true);
  });

  it("returns true immediately when res.writableEnded is already true", async () => {
    const { res, headers } = makeMockResponse();
    // Force writableEnded to true
    Object.defineProperty(res, "writableEnded", { get: () => true });
    const result = await writeEventStream(res, [{ eventType: "test", payload: { data: 1 } }]);
    expect(result).toBe(true);
    expect(headers()["Content-Type"]).toBeUndefined();
  });

  it("supports streaming profile delays", async () => {
    vi.useFakeTimers();
    const { res } = makeMockResponse();
    const events = [
      { eventType: "test", payload: { n: 1 } },
      { eventType: "test", payload: { n: 2 } },
    ];

    const promise = writeEventStream(res, events, {
      streamingProfile: { ttft: 100, tps: 10 },
    });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toBe(true);
  });

  it("supports latency option", async () => {
    vi.useFakeTimers();
    const { res } = makeMockResponse();
    const events = [{ eventType: "test", payload: { n: 1 } }];

    const promise = writeEventStream(res, events, { latency: 50 });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toBe(true);
  });

  it("stops mid-stream on abort signal and returns false", async () => {
    const { res } = makeMockResponse();
    const controller = new AbortController();

    const events = [
      { eventType: "test", payload: { n: 1 } },
      { eventType: "test", payload: { n: 2 } },
      { eventType: "test", payload: { n: 3 } },
    ];

    let chunksSent = 0;
    const result = await writeEventStream(res, events, {
      signal: controller.signal,
      onChunkSent: () => {
        chunksSent++;
        if (chunksSent === 1) controller.abort();
      },
    });

    expect(result).toBe(false);
    // Should have written exactly one frame before abort
    expect(chunksSent).toBe(1);
  });

  it("sets Transfer-Encoding: chunked header", async () => {
    const { res, headers } = makeMockResponse();
    await writeEventStream(res, [{ eventType: "test", payload: { n: 1 } }]);
    expect(headers()["Transfer-Encoding"]).toBe("chunked");
  });

  it("onChunkSent fires per event", async () => {
    const { res } = makeMockResponse();
    const events = [
      { eventType: "test", payload: { n: 1 } },
      { eventType: "test", payload: { n: 2 } },
      { eventType: "test", payload: { n: 3 } },
    ];
    let count = 0;
    await writeEventStream(res, events, {
      onChunkSent: () => {
        count++;
      },
    });
    expect(count).toBe(3);
  });
});
