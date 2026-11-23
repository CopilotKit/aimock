import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { crc32 } from "node:zlib";
import { LLMock } from "../llmock.js";

// Existing file-local reference decoder copied because it is not exported;
// ownership of this slot excludes edits to shared test helpers.
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

const paths = ["converse", "converse-stream"];
const candidates = [
  { id: "null-message", messages: [null] },
  { id: "string-content", messages: [{ role: "user", content: "bad" }] },
  { id: "null-content", messages: [{ role: "user", content: [null] }] },
  {
    id: "string-tool-result-content",
    messages: [{ role: "user", content: [{ toolResult: { toolUseId: "t1", content: "bad" } }] }],
  },
];
const controls = [
  {
    id: "unknown-role-inert-content",
    messages: [
      { role: "future", content: "bad" },
      { role: "user", content: [{ text: "hello" }] },
    ],
    converted: [{ role: "user", content: "hello" }],
  },
  {
    id: "assistant-inert-tool-result",
    messages: [
      {
        role: "assistant",
        content: [{ toolResult: { toolUseId: "unused", content: "bad" } }, { text: "hello" }],
      },
    ],
    converted: [{ role: "assistant", content: "hello" }],
  },
  {
    id: "text",
    messages: [{ role: "user", content: [{ text: "hello" }] }],
    converted: [{ role: "user", content: "hello" }],
  },
  {
    id: "tool-use-result",
    messages: [
      {
        role: "assistant",
        content: [{ toolUse: { toolUseId: "t1", name: "lookup", input: { q: "hello" } } }],
      },
      {
        role: "user",
        content: [{ toolResult: { toolUseId: "t1", content: [{ text: "found" }] } }],
      },
    ],
    converted: [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "t1", type: "function", function: { name: "lookup", arguments: '{"q":"hello"}' } },
        ],
      },
      { role: "tool", content: "found", tool_call_id: "t1" },
    ],
  },
  {
    id: "image-document-dropped-blocks",
    messages: [
      {
        role: "user",
        content: [
          { text: "hello" },
          { image: { format: "png", source: { bytes: "AA==" } } },
          { document: { format: "txt", name: "doc", source: { bytes: "aGk=" } } },
          { cachePoint: { type: "default" } },
          {},
        ],
      },
    ],
    converted: [{ role: "user", content: "hello" }],
  },
];
let mock: LLMock;
let baseUrl: string;
beforeEach(async () => {
  mock = new LLMock({ port: 0, logLevel: "silent", latency: 0 });
  mock.addFixture({ match: { sequenceIndex: 0 }, response: { content: "first" } });
  mock.addFixture({ match: {}, response: { content: "later" } });
  baseUrl = await mock.start();
});
afterEach(async () => {
  await mock.stop();
});
async function post(suffix: string, messages: unknown) {
  const response = await fetch(`${baseUrl}/model/test/${suffix}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    body: Buffer.from(await response.arrayBuffer()),
  };
}
function expectFirst(suffix: string, result: Awaited<ReturnType<typeof post>>) {
  expect(result.status).toBe(200);
  if (suffix === "converse-stream") {
    expect(result.contentType).toContain("application/vnd.amazon.eventstream");
    const frames = decodeEventStreamFrames(result.body);
    expect(frames.find((f) => f.eventType === "messageStop")?.payload).toEqual({
      stopReason: "end_turn",
    });
    expect(frames.filter((f) => f.eventType === "contentBlockDelta").map((f) => f.payload)).toEqual(
      [{ contentBlockIndex: 0, delta: { text: "first" } }],
    );
    expect(frames.at(-1)?.eventType).toBe("metadata");
  } else {
    expect(JSON.parse(result.body.toString())).toMatchObject({
      output: { message: { role: "assistant", content: [{ text: "first" }] } },
      stopReason: "end_turn",
    });
  }
}
describe.each(paths)("%s message boundary", (suffix) => {
  it.each(candidates)("candidate $id", async ({ id, messages }) => {
    const result = await post(suffix, messages);
    console.log(
      JSON.stringify({
        cell: `${suffix}/${id}`,
        request: { messages },
        status: result.status,
        contentType: result.contentType,
        body: result.body.toString(),
      }),
    );
    const control = await post(suffix, [{ role: "user", content: [{ text: "hello" }] }]);
    expectFirst(suffix, control);
    console.log(`${suffix}/${id}: first sequence fixture preserved`);
    // The same concrete shapes first reproduced HTTP 500 in characterization.log.
    // Expected existing invalid-request envelope; production remains review-gated.
    expect(result.status).toBe(400);
    expect(result.contentType).toContain("application/json");
    expect(JSON.parse(result.body.toString())).toMatchObject({
      error: { type: "invalid_request_error", message: expect.any(String) },
    });
  });
  it.each(controls)("control $id", async ({ id, messages, converted }) => {
    const result = await post(suffix, messages);
    expectFirst(suffix, result);
    expect(mock.journal.getAll()[0].body).toMatchObject({ messages: converted });
    console.log(
      `${suffix}/${id}: 200, first response, normalized messages and completion verified`,
    );
  });
});
