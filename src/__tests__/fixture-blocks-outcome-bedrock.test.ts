import { afterEach, describe, expect, it } from "vitest";
import { crc32 } from "node:zlib";
import { LLMock } from "../llmock.js";
import type { Fixture } from "../types.js";

const model = "anthropic.claude-3-5-sonnet-20241022-v2:0";
const text = { type: "text", text: "BLOCK_TEXT" } as const;
const tool = {
  type: "toolCall",
  name: "weather",
  arguments: '{"city":"SF"}',
  id: "call_authored",
} as const;
let mock: LLMock | undefined;
afterEach(async () => {
  await mock?.stop();
  mock = undefined;
});

// Existing block suites have file-local decoders, not an exported utility.
// Verify both CRCs while decoding the actual binary HTTP response.
function decodeFrames(buffer: Buffer): unknown[] {
  const frames: unknown[] = [];
  for (let offset = 0; offset < buffer.length; ) {
    expect(buffer.length - offset).toBeGreaterThanOrEqual(16);
    const length = buffer.readUInt32BE(offset);
    const headers = buffer.readUInt32BE(offset + 4);
    expect(length).toBeGreaterThanOrEqual(16 + headers);
    expect(offset + length).toBeLessThanOrEqual(buffer.length);
    expect(crc32(buffer.subarray(offset, offset + 8))).toBe(buffer.readUInt32BE(offset + 8));
    expect(crc32(buffer.subarray(offset, offset + length - 4))).toBe(
      buffer.readUInt32BE(offset + length - 4),
    );
    const payload: unknown = JSON.parse(
      buffer.subarray(offset + 12 + headers, offset + length - 4).toString(),
    );
    if (
      payload &&
      typeof payload === "object" &&
      "bytes" in payload &&
      typeof payload.bytes === "string"
    ) {
      frames.push(JSON.parse(Buffer.from(payload.bytes, "base64").toString()));
    } else frames.push(payload);
    offset += length;
  }
  return frames;
}

function values(wire: unknown, key: string): unknown[] {
  if (!wire || typeof wire !== "object") return [];
  return Object.entries(wire).flatMap(([name, value]) =>
    name === key ? [value] : values(value, key),
  );
}

const cases: {
  name: string;
  response: Fixture["response"];
  text: string;
  tools: boolean;
  terminal?: string;
}[] = [
  { name: "text only", response: { blocks: [text] }, text: text.text, tools: false },
  {
    name: "empty text",
    response: { blocks: [{ type: "text", text: "" }] },
    text: "",
    tools: false,
  },
  { name: "tool only", response: { blocks: [tool] }, text: "", tools: true },
  { name: "tool first", response: { blocks: [tool, text] }, text: text.text, tools: true },
  { name: "text first", response: { blocks: [text, tool] }, text: text.text, tools: true },
  {
    name: "trailing empty text",
    response: { blocks: [tool, { type: "text", text: "" }] },
    text: "",
    tools: true,
  },
  {
    name: "authoritative blocks",
    response: {
      blocks: [text],
      content: "LEGACY_TEXT",
      toolCalls: [{ name: "legacy_tool", arguments: "{}" }],
    },
    text: text.text,
    tools: false,
  },
  {
    name: "explicit override",
    response: { blocks: [text], finishReason: "length" },
    text: text.text,
    tools: false,
    terminal: "max_tokens",
  },
  {
    name: "empty blocks legacy fallback",
    response: {
      blocks: [],
      content: "LEGACY_TEXT",
      toolCalls: [{ name: tool.name, arguments: tool.arguments, id: tool.id }],
    },
    text: "LEGACY_TEXT",
    tools: true,
  },
];

for (const protocol of ["invoke", "converse"] as const) {
  for (const stream of [false, true]) {
    describe(`${protocol} stream=${stream}`, () => {
      it.each(cases)("$name payload and terminal", async (testCase) => {
        mock = new LLMock({ port: 0, latency: 0, chunkSize: 100 });
        mock.addFixture({ match: {}, response: testCase.response });
        await mock.start();
        const action = stream
          ? protocol === "invoke"
            ? "invoke-with-response-stream"
            : "converse-stream"
          : protocol;
        const body =
          protocol === "invoke"
            ? {
                anthropic_version: "bedrock-2023-05-31",
                max_tokens: 100,
                messages: [{ role: "user", content: "probe" }],
              }
            : { messages: [{ role: "user", content: [{ text: "probe" }] }] };
        const response = await fetch(`${mock.url}/model/${model}/${action}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(200);
        const bytes = Buffer.from(await response.arrayBuffer());
        const wire: unknown = stream ? decodeFrames(bytes) : JSON.parse(bytes.toString());
        expect(
          values(wire, "text")
            .filter((v) => typeof v === "string")
            .join(""),
        ).toBe(testCase.text);
        expect(values(wire, "name")).toEqual(testCase.tools ? [tool.name] : []);
        if (testCase.tools) {
          expect(values(wire, protocol === "invoke" ? "id" : "toolUseId")).toContain(tool.id);
          const args = stream
            ? JSON.parse(values(wire, protocol === "invoke" ? "partial_json" : "input").join(""))
            : values(wire, "input").at(-1);
          expect(args).toEqual({ city: "SF" });
        }
        expect(
          values(wire, protocol === "invoke" ? "stop_reason" : "stopReason").filter(
            (v) => v !== null,
          ),
        ).toEqual([testCase.terminal ?? (testCase.tools ? "tool_use" : "end_turn")]);
      });
    });
  }
}
