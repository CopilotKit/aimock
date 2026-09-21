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
  { id: "string-tools", toolConfig: { tools: "bad" } },
  { id: "null-toolSpec", toolConfig: { tools: [{ toolSpec: null }] } },
];
const schema = { type: "object", properties: { city: { type: "string" } } };
const native = { name: "weather", description: "Weather lookup", inputSchema: { json: schema } };
const controls = [
  { id: "absent", toolConfig: undefined, expected: undefined },
  ...[null, false, 0, "bad", [], {}].map((toolConfig, i) => ({
    id: `inert-container-${i}`,
    toolConfig,
    expected: undefined,
  })),
  ...[undefined, null, false, 0, "", [], {}, { length: 0 }].map((tools, i) => ({
    id: `inert-tools-${i}`,
    toolConfig: { tools },
    expected: undefined,
  })),
  {
    id: "native-json-schema",
    toolConfig: { tools: [{ toolSpec: native }], toolChoice: { auto: {} } },
    expected: [
      {
        type: "function",
        function: { name: "weather", description: "Weather lookup", parameters: schema },
      },
    ],
  },
  {
    id: "plain-schema",
    toolConfig: { tools: [{ toolSpec: { name: "weather", inputSchema: schema } }] },
    expected: [{ type: "function", function: { name: "weather", parameters: schema } }],
  },
  {
    id: "minimal-definition",
    toolConfig: { tools: [{ toolSpec: { name: "weather" } }] },
    expected: [{ type: "function", function: { name: "weather" } }],
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
async function post(suffix: string, toolConfig: unknown) {
  const response = await fetch(`${baseUrl}/model/test/${suffix}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: [{ text: "hello" }] }],
      toolConfig,
    }),
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
describe.each(paths)("%s tools boundary", (suffix) => {
  it.each(candidates)("candidate $id", async ({ id, toolConfig }) => {
    const result = await post(suffix, toolConfig);
    console.log(
      JSON.stringify({
        cell: `${suffix}/${id}`,
        toolConfig,
        status: result.status,
        contentType: result.contentType,
        body: result.body.toString(),
      }),
    );
    expectFirst(suffix, await post(suffix, undefined));
    console.log(`${suffix}/${id}: first sequence fixture preserved`);
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body.toString())).toMatchObject({
      error: {
        type: "invalid_request_error",
        message: expect.stringContaining("toolConfig.tools"),
      },
    });
  });
  it.each(controls)("control $id", async ({ id, toolConfig, expected }) => {
    const result = await post(suffix, toolConfig);
    expectFirst(suffix, result);
    expect(mock.journal.getAll()[0].body?.tools).toEqual(expected);
    console.log(
      JSON.stringify({
        cell: `${suffix}/${id}`,
        toolConfig,
        status: result.status,
        converted: mock.journal.getAll()[0].body?.tools,
        completion: "verified",
      }),
    );
  });
});
