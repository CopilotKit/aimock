import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LLMock } from "../llmock.js";
import type { RawResponse } from "../types.js";

// Raw passthrough on the Bedrock Converse wire (#549).

const events: Record<string, unknown>[] = [
  { messageStart: { role: "assistant" } },
  { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Raw converse." } } },
  { contentBlockStop: { contentBlockIndex: 0 } },
  { messageStop: { stopReason: "end_turn" } },
  {
    metadata: {
      usage: { inputTokens: 1, outputTokens: 3, totalTokens: 4 },
      metrics: { latencyMs: 1 },
    },
  },
];

const json = {
  output: { message: { role: "assistant", content: [{ text: "Raw JSON reply." }] } },
  stopReason: "end_turn",
  usage: { inputTokens: 1, outputTokens: 3, totalTokens: 4 },
  metrics: { latencyMs: 1 },
};

const raw: RawResponse = { raw: { wire: "bedrock-converse", events, json } };

const converse = {
  modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
  messages: [{ role: "user" as const, content: [{ text: "raw-proof" }] }],
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

describe("raw passthrough: bedrock-converse", () => {
  it("streams exactly the authored events in order", async () => {
    const stream = await client.send(new ConverseStreamCommand(converse));
    const received: unknown[] = [];
    for await (const event of stream.stream ?? []) received.push(event);
    expect(received).toEqual(events);
  });

  it("returns the authored json for Converse", async () => {
    const reply = await client.send(new ConverseCommand(converse));
    // $metadata is added by the SDK, not by the wire; every other field is exact.
    expect({ ...reply, $metadata: undefined }).toEqual(json);
  });
});

describe("raw passthrough: bedrock-converse error bodies", () => {
  const model = "anthropic.claude-3-5-sonnet-20241022-v2:0";

  async function post(
    userMessage: string,
    stream: boolean,
  ): Promise<{ status: number; errorType: string | null; body: string }> {
    const path = stream ? "converse-stream" : "converse";
    const res = await fetch(`${mock.url}/model/${model}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: [{ text: userMessage }] }] }),
    });
    return {
      status: res.status,
      errorType: res.headers.get("x-amzn-errortype"),
      body: await res.text(),
    };
  }

  const expected = (code: string, message: string): string =>
    JSON.stringify({ __type: "InternalServerException", message, code });

  it("a streaming request on a json-only fixture: aimock_raw_mode_unavailable", async () => {
    mock.on({ userMessage: "json-only" }, () => ({ raw: { wire: "bedrock-converse", json } }));
    const got = await post("json-only", true);
    expect(got.status).toBe(500);
    expect(got.errorType).toBe("InternalServerException");
    expect(got.body).toBe(
      expected(
        "aimock_raw_mode_unavailable",
        `raw fixture has no "events" body for a streaming request on bedrock-converse`,
      ),
    );
  });

  it("a non-streaming request on an events-only fixture: aimock_raw_mode_unavailable", async () => {
    mock.on({ userMessage: "events-only" }, () => ({
      raw: { wire: "bedrock-converse", events },
    }));
    const got = await post("events-only", false);
    expect(got.status).toBe(500);
    expect(got.errorType).toBe("InternalServerException");
    expect(got.body).toBe(
      expected(
        "aimock_raw_mode_unavailable",
        `raw fixture has no "json" body for a non-streaming request on bedrock-converse`,
      ),
    );
  });

  it("a factory for another wire: aimock_raw_fixture_invalid", async () => {
    mock.on({ userMessage: "other-wire" }, () => ({ raw: { wire: "bedrock-invoke", json } }));
    const got = await post("other-wire", false);
    expect(got.status).toBe(500);
    expect(got.errorType).toBe("InternalServerException");
    expect(got.body).toBe(
      expected(
        "aimock_raw_fixture_invalid",
        "raw fixture is for bedrock-invoke, not bedrock-converse",
      ),
    );
  });

  it("a factory that fails the checker: aimock_raw_fixture_invalid", async () => {
    mock.on({ userMessage: "bad-status" }, () => ({
      raw: { wire: "bedrock-converse", json, status: 99 },
    }));
    const got = await post("bad-status", false);
    expect(got.status).toBe(500);
    expect(got.errorType).toBe("InternalServerException");
    const parsed = JSON.parse(got.body) as Record<string, string>;
    expect(Object.keys(parsed)).toEqual(["__type", "message", "code"]);
    expect(parsed.code).toBe("aimock_raw_fixture_invalid");
    expect(parsed.message).toMatch(/^invalid raw fixture: .*status/);
  });

  it("an event whose payload is not a JSON object: aimock_raw_fixture_invalid", async () => {
    mock.on({ userMessage: "bad-event" }, () => ({
      raw: { wire: "bedrock-converse", events: [{ contentBlockDelta: "text" }] },
    }));
    const got = await post("bad-event", true);
    expect(got.status).toBe(500);
    expect(got.errorType).toBe("InternalServerException");
    expect(got.body).toBe(
      expected(
        "aimock_raw_fixture_invalid",
        "invalid raw fixture: raw.events[0].contentBlockDelta must be a JSON object " +
          "(the frame payload) on bedrock-converse",
      ),
    );
  });
});
