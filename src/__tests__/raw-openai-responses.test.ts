import OpenAI from "openai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LLMock } from "../llmock.js";
import type { RawResponse } from "../types.js";

// Raw passthrough on the OpenAI Responses wire (#549).

const events: Record<string, unknown>[] = [
  {
    type: "response.created",
    sequence_number: 0,
    response: { id: "resp_raw", object: "response", status: "in_progress", output: [] },
  },
  {
    type: "response.output_text.delta",
    sequence_number: 1,
    item_id: "msg_raw",
    output_index: 0,
    content_index: 0,
    delta: "Paris is the capital.",
  },
  {
    type: "response.output_text.annotation.added",
    sequence_number: 2,
    item_id: "msg_raw",
    output_index: 0,
    content_index: 0,
    annotation_index: 0,
    annotation: {
      type: "url_citation",
      url: "https://example.com/paris",
      title: "Paris",
      start_index: 0,
      end_index: 5,
    },
  },
  {
    type: "response.completed",
    sequence_number: 3,
    response: { id: "resp_raw", object: "response", status: "completed", output: [] },
  },
];

const json = {
  id: "resp_raw_json",
  object: "response",
  created_at: 1,
  status: "completed",
  model: "gpt-4.1",
  output: [
    {
      type: "message",
      id: "msg_raw_json",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Raw JSON reply.", annotations: [] }],
    },
  ],
};

const raw: RawResponse = { raw: { wire: "openai-responses", events, json } };

let mock: LLMock;
let client: OpenAI;

beforeEach(async () => {
  mock = new LLMock({ port: 0, host: "127.0.0.1", logLevel: "silent" });
  mock.on({ userMessage: "raw-proof" }, () => raw);
  await mock.start();
  client = new OpenAI({ apiKey: "local-proof", baseURL: `${mock.url}/v1`, maxRetries: 0 });
});

afterEach(async () => {
  await mock.stop();
});

describe("raw passthrough: openai-responses", () => {
  it("streams exactly the authored events in order", async () => {
    const stream = await client.responses.create({
      model: "gpt-4.1",
      input: "raw-proof",
      stream: true,
    });
    const received: unknown[] = [];
    for await (const event of stream) received.push(event);
    expect(received).toEqual(events);
  });

  it("returns the authored json for a non-streaming request", async () => {
    const reply = await client.responses.create({ model: "gpt-4.1", input: "raw-proof" });
    expect(reply).toMatchObject(json);
  });

  it("passes the authored status and headers to the SDK", async () => {
    mock.on({ userMessage: "raw-headers" }, () => ({
      raw: { ...raw.raw, status: 201, headers: { "x-request-id": "req_raw_proof" } },
    }));
    const { response } = await client.responses
      .create({ model: "gpt-4.1", input: "raw-headers", stream: true })
      .withResponse();
    expect(response.status).toBe(201);
    expect(response.headers.get("x-request-id")).toBe("req_raw_proof");
    expect(response.headers.get("content-type")).toBe("text/event-stream");
  });

  it("frames each event as a named SSE event with no [DONE]", async () => {
    const res = await fetch(`${mock.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4.1", input: "raw-proof", stream: true }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const text = await res.text();
    expect(text).toBe(
      events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join(""),
    );
  });
});

describe("raw passthrough: openai-responses error bodies", () => {
  async function post(input: string, stream: boolean): Promise<{ status: number; body: string }> {
    const res = await fetch(`${mock.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4.1", input, stream }),
    });
    return { status: res.status, body: await res.text() };
  }

  const expected = (code: string, message: string): string =>
    JSON.stringify({ error: { message, type: "server_error", code } });

  it("a streaming request on a json-only fixture: aimock_raw_mode_unavailable", async () => {
    mock.on({ userMessage: "json-only" }, () => ({ raw: { wire: "openai-responses", json } }));
    const got = await post("json-only", true);
    expect(got.status).toBe(500);
    expect(got.body).toBe(
      expected(
        "aimock_raw_mode_unavailable",
        `raw fixture has no "events" body for a streaming request on openai-responses`,
      ),
    );
  });

  it("a non-streaming request on an events-only fixture: aimock_raw_mode_unavailable", async () => {
    mock.on({ userMessage: "events-only" }, () => ({
      raw: { wire: "openai-responses", events },
    }));
    const got = await post("events-only", false);
    expect(got.status).toBe(500);
    expect(got.body).toBe(
      expected(
        "aimock_raw_mode_unavailable",
        `raw fixture has no "json" body for a non-streaming request on openai-responses`,
      ),
    );
  });

  it("a factory for another wire: aimock_raw_fixture_invalid", async () => {
    mock.on({ userMessage: "other-wire" }, () => ({ raw: { wire: "anthropic", json } }));
    const got = await post("other-wire", false);
    expect(got.status).toBe(500);
    expect(got.body).toBe(
      expected("aimock_raw_fixture_invalid", "raw fixture is for anthropic, not openai-responses"),
    );
  });

  it("a factory that fails the checker: aimock_raw_fixture_invalid", async () => {
    mock.on({ userMessage: "bad-status" }, () => ({
      raw: { wire: "openai-responses", json, status: 99 },
    }));
    const got = await post("bad-status", false);
    expect(got.status).toBe(500);
    const parsed = JSON.parse(got.body) as { error: { code: string; message: string } };
    expect(Object.keys(parsed.error)).toEqual(["message", "type", "code"]);
    expect(parsed.error.code).toBe("aimock_raw_fixture_invalid");
    expect(parsed.error.message).toMatch(/^invalid raw fixture: .*status/);
  });
});
