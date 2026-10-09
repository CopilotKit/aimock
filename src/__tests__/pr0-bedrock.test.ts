import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  InvokeModelWithResponseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { afterEach, expect, test } from "vitest";
import { LLMock } from "../llmock.js";

let mock: LLMock | undefined;
let client: BedrockRuntimeClient | undefined;
let directory: string | undefined;
afterEach(async () => {
  client?.destroy();
  await mock?.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
  client = undefined;
  mock = undefined;
  directory = undefined;
});

const modes = [
  { shape: "tool-only", stream: false },
  { shape: "mixed", stream: false },
  { shape: "blocks", stream: false },
  { shape: "tool-only", stream: true },
  { shape: "mixed", stream: true },
  { shape: "blocks", stream: true },
] as const;

async function invoke(mode: (typeof modes)[number], args: string | undefined) {
  const tool = { id: "call_pr0", name: "lookup", arguments: args };
  const response =
    mode.shape === "blocks"
      ? {
          content: "",
          toolCalls: [],
          blocks: [
            { type: "toolCall", ...tool },
            { type: "text", text: "tail" },
          ],
        }
      : mode.shape === "mixed"
        ? { content: "lead", toolCalls: [tool] }
        : { toolCalls: [tool] };
  directory = await mkdtemp(join(tmpdir(), "aimock-pr0-bedrock-"));
  const fixturePath = join(directory, "fixture.json");
  await writeFile(fixturePath, JSON.stringify({ fixtures: [{ match: {}, response }] }));
  mock = new LLMock({ port: 0, logLevel: "silent", chunkSize: 3 });
  mock.loadFixtureFile(fixturePath);
  await mock.start();
  client = new BedrockRuntimeClient({
    endpoint: mock.url,
    region: "us-east-1",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
    maxAttempts: 1,
    requestHandler: new NodeHttpHandler(),
  });
  const input = {
    modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
    contentType: "application/json",
    body: JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 128,
      messages: [{ role: "user", content: "lookup" }],
    }),
  };
  let status: number | undefined;
  let body = "";
  let rawFramesBase64: string | undefined;
  const events: unknown[] = [];
  const sdkEvents: unknown[] = [];
  let error: unknown;
  try {
    if (mode.stream) {
      const result = await client.send(new InvokeModelWithResponseStreamCommand(input), {
        abortSignal: AbortSignal.timeout(5000),
      });
      status = result.$metadata.httpStatusCode;
      if (result.body) {
        for await (const event of result.body) {
          sdkEvents.push(event);
          if (event.chunk?.bytes) {
            const wire = new TextDecoder().decode(event.chunk.bytes);
            sdkEvents.push({ decodedBytes: wire });
          }
        }
      }
      // Retain a real HTTP companion to inspect the framed Invoke payloads
      // alongside the official SDK bytes observed above.
      const wireResponse = await fetch(
        `${mock.url}/model/${encodeURIComponent(input.modelId)}/invoke-with-response-stream`,
        {
          method: "POST",
          headers: { "Content-Type": input.contentType },
          body: input.body,
          signal: AbortSignal.timeout(5000),
        },
      );
      expect(wireResponse.status).toBe(status);
      const frames = Buffer.from(await wireResponse.arrayBuffer());
      rawFramesBase64 = frames.toString("base64");
      for (let offset = 0; offset < frames.length; ) {
        expect(frames.length - offset).toBeGreaterThanOrEqual(16);
        const length = frames.readUInt32BE(offset);
        const headersLength = frames.readUInt32BE(offset + 4);
        expect(length).toBeGreaterThanOrEqual(16 + headersLength);
        expect(offset + length).toBeLessThanOrEqual(frames.length);
        const wire = frames
          .subarray(offset + 12 + headersLength, offset + length - 4)
          .toString("utf8");
        body += wire + "\n";
        const payload = JSON.parse(wire);
        events.push(
          typeof payload.bytes === "string"
            ? JSON.parse(Buffer.from(payload.bytes, "base64").toString("utf8"))
            : payload,
        );
        offset += length;
      }
    } else {
      const result = await client.send(new InvokeModelCommand(input), {
        abortSignal: AbortSignal.timeout(5000),
      });
      status = result.$metadata.httpStatusCode;
      body = new TextDecoder().decode(result.body);
    }
  } catch (caught) {
    error = caught;
    if (caught && typeof caught === "object" && "$metadata" in caught) {
      const metadata = caught.$metadata;
      if (
        metadata &&
        typeof metadata === "object" &&
        "httpStatusCode" in metadata &&
        typeof metadata.httpStatusCode === "number"
      )
        status = metadata.httpStatusCode;
    }
  }
  const journal = mock.getLastRequest();
  console.log(
    JSON.stringify({
      mode,
      authoredArguments: args ?? "<missing>",
      status,
      body,
      rawFramesBase64,
      sdkEvents,
      error: error instanceof Error ? error.message : error,
      journal,
    }),
  );
  return { status, body, events, error, journal };
}

function streamArguments(events: unknown[]) {
  return events
    .map((event) => {
      if (!event || typeof event !== "object" || !("delta" in event)) return "";
      const delta = event.delta;
      return delta &&
        typeof delta === "object" &&
        "partial_json" in delta &&
        typeof delta.partial_json === "string"
        ? delta.partial_json
        : "";
    })
    .join("");
}

test.each(modes)("PR0 Bedrock $shape stream=$stream malformed arguments", async (mode) => {
  const args = '{"city":';
  const result = await invoke(mode, args);
  if (mode.stream) {
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(200);
    expect(streamArguments(result.events)).toBe(args);
  } else {
    expect(result.status).toBe(500);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error).toMatchObject({
      name: "InternalServerException",
      message: expect.stringContaining('fixture tool call "lookup" has invalid JSON arguments'),
    });
    expect(result.error).toMatchObject({
      message: expect.stringContaining(
        "Use a wire that carries tool arguments as a string to test malformed JSON.",
      ),
    });
    expect(result.journal?.response.status).toBe(500);
  }
});

const controls = [
  { label: "object", args: '{ "z": 1, "city": "Paris" }' },
  { label: "array", args: '[1,"two"]' },
  { label: "null", args: "null" },
  { label: "string", args: '"hello"' },
  { label: "number", args: "42" },
  { label: "boolean", args: "false" },
  { label: "empty", args: "" },
  { label: "missing", args: undefined },
];
test.each(modes.flatMap((mode) => controls.map((control) => ({ ...mode, ...control }))))(
  "PR0 Bedrock control $shape stream=$stream $label",
  async (mode) => {
    const result = await invoke(mode, mode.args);
    // Ordered blocks reject absent arguments before the provider parser.
    // Keep the existing structural validation; PR0 changes no loader contract.
    if (mode.shape === "blocks" && mode.args === undefined) {
      expect(result.status).toBe(500);
      expect(result.error).toBeInstanceOf(Error);
      expect(JSON.stringify(result.error)).toContain("arguments");
      expect(result.journal?.response.status).toBe(500);
      return;
    }
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(200);
    const expected: unknown = JSON.parse(mode.args || "{}");
    if (mode.stream) {
      expect(streamArguments(result.events)).toBe(JSON.stringify(expected));
    } else {
      const body: unknown = JSON.parse(result.body);
      expect(body).toMatchObject({
        content: expect.arrayContaining([
          { type: "tool_use", id: "call_pr0", name: "lookup", input: expected },
        ]),
      });
    }
    expect(result.journal?.response.status).toBe(200);
  },
);
