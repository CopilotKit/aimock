import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  InvokeModelCommand,
  InvokeModelWithResponseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { afterEach, expect, test } from "vitest";
import { LLMock } from "../llmock.js";

let mock: LLMock | undefined;
let client: BedrockRuntimeClient | undefined;

afterEach(async () => {
  client?.destroy();
  await mock?.stop();
  mock = undefined;
  client = undefined;
});

test("documented HTTP/1 handler supports Bedrock Invoke, Converse and both binary streams", async () => {
  mock = new LLMock({ port: 0, logLevel: "silent", strict: true, chunkSize: 3 });
  mock.onMessage("hello", { content: "Hello from Bedrock!" });
  await mock.start();
  client = new BedrockRuntimeClient({
    endpoint: mock.url,
    region: "us-east-1",
    credentials: { accessKeyId: "mock", secretAccessKey: "mock" },
    maxAttempts: 1,
    requestHandler: new NodeHttpHandler(),
  });
  const modelId = "anthropic.claude-3-5-sonnet-20241022-v2:0";
  const invoke = {
    modelId,
    contentType: "application/json",
    body: JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 128,
      messages: [{ role: "user", content: "hello" }],
    }),
  };
  const normal = await client.send(new InvokeModelCommand(invoke));
  expect(normal.$metadata.httpStatusCode).toBe(200);
  expect(JSON.parse(new TextDecoder().decode(normal.body)).content[0].text).toBe(
    "Hello from Bedrock!",
  );
  const streamed = await client.send(new InvokeModelWithResponseStreamCommand(invoke));
  let text = "";
  for await (const event of streamed.body ?? []) {
    if (!event.chunk?.bytes) continue;
    const data = JSON.parse(new TextDecoder().decode(event.chunk.bytes));
    if (data.type === "content_block_delta") text += data.delta.text ?? "";
  }
  expect(text).toBe("Hello from Bedrock!");
  const converse = { modelId, messages: [{ role: "user" as const, content: [{ text: "hello" }] }] };
  const reply = await client.send(new ConverseCommand(converse));
  expect(reply.output?.message?.content?.[0].text).toBe("Hello from Bedrock!");
  const stream = await client.send(new ConverseStreamCommand(converse));
  text = "";
  for await (const event of stream.stream ?? []) text += event.contentBlockDelta?.delta?.text ?? "";
  expect(text).toBe("Hello from Bedrock!");
  await expect(
    client.send(
      new ConverseCommand({
        modelId,
        messages: [{ role: "user", content: [{ text: "missing" }] }],
      }),
    ),
  ).rejects.toMatchObject({ $metadata: { httpStatusCode: 503 } });
});
