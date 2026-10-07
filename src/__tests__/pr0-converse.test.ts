import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import {
  BedrockRuntimeClient,
  BedrockRuntimeServiceException,
  ConverseCommand,
  ConverseStreamCommand,
  type ConverseCommandInput,
  type ConverseCommandOutput,
  type ConverseStreamOutput,
} from "@aws-sdk/client-bedrock-runtime";
import { afterEach, expect, test } from "vitest";
import { LLMock } from "../llmock.js";

const shapes = ["blocks", "legacy-combined", "legacy-tool-only"] as const;
type Shape = (typeof shapes)[number];
const modes = shapes.flatMap((shape) => [false, true].map((stream) => ({ shape, stream })));
const malformed = '{"city":';
const request: ConverseCommandInput = {
  modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
  messages: [{ role: "user", content: [{ text: "lookup" }] }],
};
let mock: LLMock | undefined;
let client: BedrockRuntimeClient | undefined;
let directory: string | undefined;

afterEach(async () => {
  client?.destroy();
  client = undefined;
  await mock?.stop();
  mock = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

async function observe(shape: Shape, stream: boolean, args: string | undefined) {
  const tool = { id: "call_pr0_converse", name: "lookup", arguments: args };
  const response =
    shape === "blocks"
      ? {
          blocks: [
            { type: "toolCall", ...tool },
            { type: "text", text: "Done." },
          ],
        }
      : shape === "legacy-combined"
        ? { content: "Done.", toolCalls: [tool] }
        : { toolCalls: [tool] };
  directory = await mkdtemp(join(tmpdir(), "pr0-converse-"));
  const fixturePath = join(directory, "fixture.json");
  await writeFile(fixturePath, JSON.stringify({ fixtures: [{ match: {}, response }] }));
  mock = new LLMock({ port: 0, logLevel: "silent", chunkSize: 2 });
  mock.loadFixtureFile(fixturePath);
  expect(mock.getFixtures()).toHaveLength(1);
  await mock.start();
  client = new BedrockRuntimeClient({
    endpoint: mock.url,
    region: "us-east-1",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
    maxAttempts: 1,
    requestHandler: new NodeHttpHandler(),
  });
  // A second real request records raw wire bytes, independently of SDK decoding.
  const wire = await fetch(
    `${mock.url}/model/${encodeURIComponent(request.modelId!)}/converse${stream ? "-stream" : ""}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: request.messages }),
      signal: AbortSignal.timeout(5000),
    },
  );
  const wireBytes = Buffer.from(await wire.arrayBuffer());
  const wireOutput: ConverseCommandOutput | undefined = stream
    ? undefined
    : JSON.parse(wireBytes.toString("utf8"));
  const wireValue = wireOutput?.output?.message?.content?.find((block) => block.toolUse)?.toolUse
    ?.input;
  const wireJournal = mock.getLastRequest();
  const events: ConverseStreamOutput[] = [];
  let value: unknown;
  let status: number | undefined;
  let failure: unknown;
  let identity: { toolUseId?: string; name?: string } | undefined;
  let order: string[] = [];
  let stopReason: string | undefined;
  try {
    if (stream) {
      const result = await client.send(new ConverseStreamCommand(request), {
        abortSignal: AbortSignal.timeout(5000),
      });
      status = result.$metadata.httpStatusCode;
      for await (const event of result.stream ?? []) events.push(event);
      value = events.map((event) => event.contentBlockDelta?.delta?.toolUse?.input ?? "").join("");
      const starts = events.flatMap((event) =>
        event.contentBlockStart ? [event.contentBlockStart] : [],
      );
      identity = starts.find((block) => block.start?.toolUse)?.start?.toolUse;
      order = starts.map((block) => (block.start?.toolUse ? "tool" : "text"));
      stopReason = events.find((event) => event.messageStop)?.messageStop?.stopReason;
    } else {
      const result = await client.send(new ConverseCommand(request), {
        abortSignal: AbortSignal.timeout(5000),
      });
      status = result.$metadata.httpStatusCode;
      const content = result.output?.message?.content ?? [];
      const toolUse = content.find((block) => block.toolUse)?.toolUse;
      value = toolUse?.input;
      identity = toolUse;
      order = content.map((block) => (block.toolUse ? "tool" : "text"));
      stopReason = result.stopReason;
    }
  } catch (error) {
    failure = error;
    if (error instanceof BedrockRuntimeServiceException) status = error.$metadata.httpStatusCode;
  }
  const journal = mock.getLastRequest();
  console.log(
    JSON.stringify({
      shape,
      stream,
      authoredArguments: args ?? "<missing>",
      wireStatus: wire.status,
      wireBody: stream ? wireBytes.toString("base64") : wireBytes.toString("utf8"),
      wireEncoding: stream ? "base64" : "utf8",
      wireJournal,
      sdkStatus: status,
      value,
      events,
      journal,
      failure:
        failure instanceof Error ? { name: failure.name, message: failure.message } : failure,
    }),
  );
  return {
    status,
    value,
    failure,
    identity,
    order,
    stopReason,
    events,
    journal,
    wireJournal,
    wireStatus: wire.status,
    wireBody: wireBytes.toString("utf8"),
    wireValue,
  };
}

test.each(modes)("PR0 converse malformed $shape stream=$stream", async ({ shape, stream }) => {
  const result = await observe(shape, stream, malformed);
  if (stream) {
    expect(result.failure).toBeUndefined();
    expect(result.status).toBe(200);
    expect(result.value).toBe(malformed);
  } else {
    expect.soft(result.wireStatus).toBe(500);
    expect.soft(result.wireBody).toContain("invalid JSON arguments");
    expect
      .soft(result.wireBody)
      .toContain("Use a wire that carries tool arguments as a string to test malformed JSON.");
    expect.soft(result.status).toBe(500);
    expect.soft(result.failure).toBeInstanceOf(BedrockRuntimeServiceException);
    expect.soft(result.failure).toMatchObject({
      name: "InternalServerException",
      message: expect.stringContaining('fixture tool call "lookup" has invalid JSON arguments'),
    });
    expect.soft(result.failure).toMatchObject({
      message: expect.stringContaining(
        "Use a wire that carries tool arguments as a string to test malformed JSON.",
      ),
    });

    expect.soft(result.journal?.response.status).toBe(500);
    expect.soft(result.journal?.response.error).toContain("invalid JSON arguments");
    expect.soft(result.wireJournal?.response.status).toBe(500);
    expect.soft(result.wireJournal?.response.error).toContain("invalid JSON arguments");
    expect(result.wireBody).not.toContain('"output"');
  }
});

const controls = [
  { label: "object", args: '{ "city": "Paris", "n": 2 }', value: { city: "Paris", n: 2 } },
  { label: "array", args: '[1, "x"]', value: [1, "x"] },
  { label: "null", args: "null", value: null },
  { label: "number", args: "42", value: 42 },
  { label: "boolean", args: "false", value: false },
  { label: "string", args: '"Paris"', value: "Paris" },
  { label: "empty", args: "", value: {} },
  { label: "missing", args: undefined, value: {} },
];

test.each(modes.flatMap((mode) => controls.map((control) => ({ ...mode, ...control }))))(
  "PR0 converse control $shape stream=$stream $label",
  async ({ shape, stream, args, value }) => {
    const result = await observe(shape, stream, args);
    if (shape === "blocks" && args === undefined) {
      // Existing block validation rejects missing arguments before the parse sites.
      expect(result.wireStatus).toBe(500);
      expect(result.status).toBe(500);
      expect(result.failure).toBeInstanceOf(BedrockRuntimeServiceException);
      expect(result.wireBody).toContain("requires a string or object");
      return;
    }
    expect(result.failure).toBeUndefined();
    expect(result.status).toBe(200);
    expect(result.wireStatus).toBe(200);
    if (stream) {
      expect(result.value).toBe(JSON.stringify(value));
    } else {
      // The official SDK omits a null document; assert the wire retains null exactly.
      expect(result.wireValue).toEqual(value);
      expect(result.value).toEqual(value === null ? undefined : value);
    }
    expect(result.identity).toMatchObject({ toolUseId: "call_pr0_converse", name: "lookup" });
    expect(result.order).toEqual(
      shape === "blocks"
        ? ["tool", "text"]
        : shape === "legacy-combined"
          ? ["text", "tool"]
          : ["tool"],
    );
    expect(result.stopReason).toBe("tool_use");
    expect(result.journal?.response.status).toBe(200);
    expect(result.journal?.response.error).toBeUndefined();
    if (stream) {
      expect(result.events[0].messageStart?.role).toBe("assistant");
      expect(result.events.at(-1)?.metadata?.usage).toMatchObject({
        inputTokens: 0,
        outputTokens: 0,
      });
      const indices = result.events.flatMap((event) =>
        event.contentBlockStart ? [event.contentBlockStart.contentBlockIndex] : [],
      );
      expect(indices).toEqual(shape === "legacy-tool-only" ? [0] : [0, 1]);
    }
  },
);
