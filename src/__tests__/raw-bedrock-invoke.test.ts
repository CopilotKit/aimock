import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  InvokeModelWithResponseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LLMock } from "../llmock.js";
import type { RawResponse } from "../types.js";

// Raw passthrough on the Bedrock InvokeModel wire (#549).

const events: Record<string, unknown>[] = [
  {
    type: "message_start",
    message: {
      id: "msg_raw",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-5",
      content: [],
      stop_reason: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Raw bedrock." } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
  { type: "message_stop" },
];

const json = {
  id: "msg_raw_json",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-4-5",
  content: [{ type: "text", text: "Raw JSON reply." }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 3 },
};

const raw: RawResponse = { raw: { wire: "bedrock-invoke", events, json } };

const invoke = {
  modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
  contentType: "application/json",
  body: JSON.stringify({
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 64,
    messages: [{ role: "user", content: "raw-proof" }],
  }),
};

let mock: LLMock;
let client: BedrockRuntimeClient;

beforeEach(async () => {
  mock = new LLMock({ port: 0, host: "127.0.0.1", logLevel: "silent" });
  mock.on({ userMessage: "raw-proof" }, () => raw);
  await mock.start();
  client = new BedrockRuntimeClient({
    endpoint: mock.url,
    region: "us-east-1",
    credentials: { accessKeyId: "mock", secretAccessKey: "mock" },
    maxAttempts: 1,
    requestHandler: new NodeHttpHandler(),
  });
});

afterEach(async () => {
  client.destroy();
  await mock.stop();
});

describe("raw passthrough: bedrock-invoke", () => {
  it("streams exactly the authored events as chunk.bytes", async () => {
    const streamed = await client.send(new InvokeModelWithResponseStreamCommand(invoke));
    const received: unknown[] = [];
    const unexpected: unknown[] = [];
    for await (const event of streamed.body ?? []) {
      if (event.chunk?.bytes)
        received.push(JSON.parse(new TextDecoder().decode(event.chunk.bytes)));
      else unexpected.push(event);
    }
    expect(unexpected).toEqual([]);
    expect(received).toEqual(events);
  });

  it("returns the authored json for InvokeModel", async () => {
    const reply = await client.send(new InvokeModelCommand(invoke));
    expect(JSON.parse(new TextDecoder().decode(reply.body))).toEqual(json);
  });
});

describe("raw passthrough: bedrock-invoke error bodies", () => {
  const model = "anthropic.claude-3-5-sonnet-20241022-v2:0";

  async function post(
    userMessage: string,
    stream: boolean,
  ): Promise<{ status: number; errorType: string | null; body: string }> {
    const path = stream ? "invoke-with-response-stream" : "invoke";
    const res = await fetch(`${mock.url}/model/${model}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 64,
        messages: [{ role: "user", content: userMessage }],
      }),
    });
    return {
      status: res.status,
      errorType: res.headers.get("x-amzn-errortype"),
      body: await res.text(),
    };
  }

  const expected = (code: string, message: string): string =>
    JSON.stringify({ __type: "InternalServerException", code, message });

  it("a streaming request on a json-only fixture: aimock_raw_mode_unavailable", async () => {
    mock.on({ userMessage: "json-only" }, () => ({ raw: { wire: "bedrock-invoke", json } }));
    const got = await post("json-only", true);
    expect(got.status).toBe(500);
    expect(got.errorType).toBe("InternalServerException");
    expect(got.body).toBe(
      expected(
        "aimock_raw_mode_unavailable",
        `raw fixture has no "events" body for a streaming request on bedrock-invoke`,
      ),
    );
  });

  it("a non-streaming request on an events-only fixture: aimock_raw_mode_unavailable", async () => {
    mock.on({ userMessage: "events-only" }, () => ({ raw: { wire: "bedrock-invoke", events } }));
    const got = await post("events-only", false);
    expect(got.status).toBe(500);
    expect(got.errorType).toBe("InternalServerException");
    expect(got.body).toBe(
      expected(
        "aimock_raw_mode_unavailable",
        `raw fixture has no "json" body for a non-streaming request on bedrock-invoke`,
      ),
    );
  });

  it("a factory for another wire: aimock_raw_fixture_invalid", async () => {
    mock.on({ userMessage: "other-wire" }, () => ({ raw: { wire: "anthropic", json } }));
    const got = await post("other-wire", false);
    expect(got.status).toBe(500);
    expect(got.errorType).toBe("InternalServerException");
    expect(got.body).toBe(
      expected("aimock_raw_fixture_invalid", "raw fixture is for anthropic, not bedrock-invoke"),
    );
  });

  it("a factory that fails the checker: aimock_raw_fixture_invalid", async () => {
    mock.on({ userMessage: "bad-status" }, () => ({
      raw: { wire: "bedrock-invoke", events, status: 99 },
    }));
    const got = await post("bad-status", true);
    expect(got.status).toBe(500);
    expect(got.errorType).toBe("InternalServerException");
    const parsed = JSON.parse(got.body) as Record<string, string>;
    expect(Object.keys(parsed)).toEqual(["__type", "code", "message"]);
    expect(parsed.code).toBe("aimock_raw_fixture_invalid");
    expect(parsed.message).toMatch(/^invalid raw fixture: .*status/);
  });
});
