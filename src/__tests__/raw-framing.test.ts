import { crc32 } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LLMock } from "../llmock.js";
import { encodeRawFrame, rawContentType, rawTrailer } from "../response/raw.js";
import type { RawWireId } from "../types.js";

// Per-wire framing for raw passthrough fixtures (#549 T6): exact bytes, and
// the same bytes the typed handler writes for the same event objects.

interface DecodedFrame {
  headers: Record<string, string>;
  payload: Buffer;
}

/** Decode AWS event-stream frames, checking both CRCs (as aws-event-stream.test.ts does). */
function decodeFrames(data: Buffer): DecodedFrame[] {
  const frames: DecodedFrame[] = [];
  let offset = 0;
  while (offset < data.length) {
    const total = data.readUInt32BE(offset);
    const headersLength = data.readUInt32BE(offset + 4);
    const frame = data.subarray(offset, offset + total);
    expect(frame.readUInt32BE(8)).toBe(crc32(frame.subarray(0, 8)));
    expect(frame.readUInt32BE(total - 4)).toBe(crc32(frame.subarray(0, total - 4)));
    const headers: Record<string, string> = {};
    let h = 12;
    while (h < 12 + headersLength) {
      const nameLength = frame.readUInt8(h);
      const name = frame.subarray(h + 1, h + 1 + nameLength).toString("utf8");
      h += 1 + nameLength;
      expect(frame.readUInt8(h)).toBe(7); // string header
      const valueLength = frame.readUInt16BE(h + 1);
      headers[name] = frame.subarray(h + 3, h + 3 + valueLength).toString("utf8");
      h += 3 + valueLength;
    }
    frames.push({ headers, payload: frame.subarray(12 + headersLength, total - 4) });
    offset += total;
  }
  return frames;
}

describe("rawContentType", () => {
  it.each([
    ["openai-responses", "text/event-stream"],
    ["openai-chat", "text/event-stream"],
    ["anthropic", "text/event-stream"],
    ["gemini", "text/event-stream"],
    ["gemini-interactions", "text/event-stream"],
    ["cohere", "text/event-stream"],
    ["ollama", "application/x-ndjson"],
    ["ollama-generate", "application/x-ndjson"],
    ["bedrock-invoke", "application/vnd.amazon.eventstream"],
    ["bedrock-converse", "application/vnd.amazon.eventstream"],
  ] as const)("%s -> %s", (wire, type) => {
    expect(rawContentType(wire)).toBe(type);
  });
});

describe("encodeRawFrame: exact bytes", () => {
  it.each(["openai-responses", "anthropic", "cohere"] as const)("%s: named SSE", (wire) => {
    expect(encodeRawFrame(wire, { type: "x.y", n: 1 })).toBe(
      'event: x.y\ndata: {"type":"x.y","n":1}\n\n',
    );
  });

  it.each(["openai-chat", "gemini", "gemini-interactions"] as const)("%s: data SSE", (wire) => {
    expect(encodeRawFrame(wire, { a: [1, "b"] })).toBe('data: {"a":[1,"b"]}\n\n');
  });

  it.each(["ollama", "ollama-generate"] as const)("%s: NDJSON", (wire) => {
    expect(encodeRawFrame(wire, { done: true })).toBe('{"done":true}\n');
  });

  it("bedrock-invoke: a chunk frame whose base64 bytes are the event JSON", () => {
    const event = { type: "content_block_delta", delta: { text: "é" } };
    const frame = encodeRawFrame("bedrock-invoke", event);
    expect(Buffer.isBuffer(frame)).toBe(true);
    const [decoded] = decodeFrames(Buffer.from(frame));
    expect(decoded.headers).toEqual({
      ":content-type": "application/json",
      ":event-type": "chunk",
      ":message-type": "event",
    });
    const payload = JSON.parse(decoded.payload.toString("utf8")) as { bytes: string };
    expect(Buffer.from(payload.bytes, "base64").toString("utf8")).toBe(JSON.stringify(event));
  });

  it("bedrock-converse: the single key is the event type, its value the payload", () => {
    const frame = encodeRawFrame("bedrock-converse", {
      contentBlockDelta: { contentBlockIndex: 0, delta: { text: "hi" } },
    });
    const [decoded] = decodeFrames(Buffer.from(frame));
    expect(decoded.headers[":event-type"]).toBe("contentBlockDelta");
    expect(decoded.headers[":message-type"]).toBe("event");
    expect(decoded.payload.toString("utf8")).toBe('{"contentBlockIndex":0,"delta":{"text":"hi"}}');
  });
});

describe("rawTrailer", () => {
  it("openai-chat sends [DONE] by default and when done is true", () => {
    expect(rawTrailer("openai-chat", { wire: "openai-chat" }, false)).toBe("data: [DONE]\n\n");
    expect(rawTrailer("openai-chat", { wire: "openai-chat", done: true }, false)).toBe(
      "data: [DONE]\n\n",
    );
  });

  it("openai-chat omits [DONE] when done is false or the stream was aborted", () => {
    expect(rawTrailer("openai-chat", { wire: "openai-chat", done: false }, false)).toBeUndefined();
    expect(rawTrailer("openai-chat", { wire: "openai-chat" }, true)).toBeUndefined();
  });

  it.each([
    "openai-responses",
    "anthropic",
    "gemini",
    "gemini-interactions",
    "cohere",
    "ollama",
    "ollama-generate",
    "bedrock-invoke",
    "bedrock-converse",
  ] as const)("%s has no terminal", (wire) => {
    expect(rawTrailer(wire, { wire }, false)).toBeUndefined();
  });
});

// Typed-framing equality (m4): stream a typed fixture from the real server,
// split the dump into the event objects it carries, re-encode those objects
// with encodeRawFrame, and require the identical bytes. The typed writers stay
// module-private; only their wire output is compared.
describe("encodeRawFrame matches the typed handler's bytes", () => {
  let mock: LLMock;
  beforeAll(async () => {
    mock = new LLMock({ port: 0, host: "127.0.0.1", logLevel: "silent", chunkSize: 4 });
    mock.on({ userMessage: "typed" }, { content: "Typed framing check." });
    await mock.start();
  });
  afterAll(async () => {
    await mock.stop();
  });

  const MODEL = "anthropic.claude-3-5-sonnet-20241022-v2:0";
  const requests: Record<RawWireId, { path: string; body: unknown }> = {
    "openai-responses": {
      path: "/v1/responses",
      body: { model: "gpt-4.1", input: "typed", stream: true },
    },
    "openai-chat": {
      path: "/v1/chat/completions",
      body: { model: "gpt-4.1", messages: [{ role: "user", content: "typed" }], stream: true },
    },
    anthropic: {
      path: "/v1/messages",
      body: {
        model: "claude-sonnet-4-5",
        max_tokens: 64,
        messages: [{ role: "user", content: "typed" }],
        stream: true,
      },
    },
    gemini: {
      path: "/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
      body: { contents: [{ role: "user", parts: [{ text: "typed" }] }] },
    },
    "gemini-interactions": {
      path: "/v1beta/interactions",
      body: { model: "gemini-2.5-flash", input: "typed", stream: true },
    },
    cohere: {
      path: "/v2/chat",
      body: {
        model: "command-r-plus",
        messages: [{ role: "user", content: "typed" }],
        stream: true,
      },
    },
    ollama: {
      path: "/api/chat",
      body: { model: "llama3.1", messages: [{ role: "user", content: "typed" }], stream: true },
    },
    "ollama-generate": {
      path: "/api/generate",
      body: { model: "llama3.1", prompt: "typed", stream: true },
    },
    "bedrock-invoke": {
      path: `/model/${MODEL}/invoke-with-response-stream`,
      body: {
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 64,
        messages: [{ role: "user", content: "typed" }],
      },
    },
    "bedrock-converse": {
      path: `/model/${MODEL}/converse-stream`,
      body: { messages: [{ role: "user", content: [{ text: "typed" }] }] },
    },
  };

  async function dump(wire: RawWireId): Promise<{ contentType: string | null; bytes: Buffer }> {
    const { path, body } = requests[wire];
    const res = await fetch(`${mock.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    return {
      contentType: res.headers.get("content-type"),
      bytes: Buffer.from(await res.arrayBuffer()),
    };
  }

  /** The event objects a typed dump carries, in order, plus any terminal bytes. */
  function eventsIn(
    wire: RawWireId,
    bytes: Buffer,
  ): { events: Record<string, unknown>[]; tail: string } {
    if (wire === "bedrock-invoke") {
      return {
        events: decodeFrames(bytes).map((f) => {
          const { bytes: b64 } = JSON.parse(f.payload.toString("utf8")) as { bytes: string };
          return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
        }),
        tail: "",
      };
    }
    if (wire === "bedrock-converse") {
      return {
        events: decodeFrames(bytes).map((f) => ({
          [f.headers[":event-type"]]: JSON.parse(f.payload.toString("utf8")),
        })),
        tail: "",
      };
    }
    const text = bytes.toString("utf8");
    if (wire === "ollama" || wire === "ollama-generate") {
      return {
        events: text
          .trimEnd()
          .split("\n")
          .map((line) => JSON.parse(line)),
        tail: "",
      };
    }
    const blocks = text.split("\n\n").filter((b) => b.length > 0);
    const done = blocks.at(-1) === "data: [DONE]";
    const events = (done ? blocks.slice(0, -1) : blocks).map((block) =>
      JSON.parse(block.slice(block.indexOf("data: ") + "data: ".length)),
    );
    return { events, tail: done ? "data: [DONE]\n\n" : "" };
  }

  it.each(Object.keys(requests) as RawWireId[])("%s", async (wire) => {
    const { contentType, bytes } = await dump(wire);
    expect(contentType?.split(";")[0]).toBe(rawContentType(wire));
    const { events, tail } = eventsIn(wire, bytes);
    expect(events.length).toBeGreaterThan(1);
    const reencoded = Buffer.concat([
      ...events.map((event) => Buffer.from(encodeRawFrame(wire, event))),
      Buffer.from(rawTrailer(wire, { wire }, false) ?? ""),
    ]);
    expect(tail).toBe(rawTrailer(wire, { wire }, false) ?? "");
    expect(reencoded.equals(bytes)).toBe(true);
  });
});

describe("encodeRawFrame: a checker/framer mismatch is an internal error", () => {
  it("bedrock-converse with a non-object payload throws instead of framing {}", () => {
    expect(() => encodeRawFrame("bedrock-converse", { messageStart: "not an object" })).toThrow(
      /internal error/,
    );
  });
});
