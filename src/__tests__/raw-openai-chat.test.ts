import OpenAI from "openai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LLMock } from "../llmock.js";
import type { RawResponse } from "../types.js";

// Raw passthrough on the OpenAI Chat Completions wire (#549), including the
// OpenRouter and Azure routes that share handleCompletions.

const events: Record<string, unknown>[] = [
  {
    id: "chatcmpl-raw",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-4.1",
    choices: [{ index: 0, delta: { role: "assistant", content: "Raw " }, finish_reason: null }],
  },
  {
    id: "chatcmpl-raw",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-4.1",
    choices: [{ index: 0, delta: { content: "chunk." }, finish_reason: null }],
    unmodeled_extension: { kept: true },
  },
  {
    id: "chatcmpl-raw",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-4.1",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  },
];

const json = {
  id: "chatcmpl-raw-json",
  object: "chat.completion",
  created: 1,
  model: "gpt-4.1",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "Raw JSON reply.", refusal: null },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 },
};

const raw: RawResponse = { raw: { wire: "openai-chat", events, json } };

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

describe("raw passthrough: openai-chat", () => {
  it("streams exactly the authored chunks in order", async () => {
    const stream = await client.chat.completions.create({
      model: "gpt-4.1",
      messages: [{ role: "user", content: "raw-proof" }],
      stream: true,
    });
    const received: unknown[] = [];
    for await (const chunk of stream) received.push(chunk);
    expect(received).toEqual(events);
  });

  it("returns the authored json for a non-streaming request", async () => {
    const reply = await client.chat.completions.create({
      model: "gpt-4.1",
      messages: [{ role: "user", content: "raw-proof" }],
    });
    expect(reply).toEqual(json);
  });
});

describe("raw passthrough: openai-chat framing", () => {
  async function streamText(content: string): Promise<{ type: string | null; text: string }> {
    const res = await fetch(`${mock.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4.1",
        messages: [{ role: "user", content }],
        stream: true,
      }),
    });
    return { type: res.headers.get("content-type"), text: await res.text() };
  }

  const frames = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

  it("frames each chunk as a data line and ends with data: [DONE] by default", async () => {
    const got = await streamText("raw-proof");
    expect(got.type).toBe("text/event-stream");
    expect(got.text).toBe(`${frames}data: [DONE]\n\n`);
  });

  it("omits data: [DONE] when done is false", async () => {
    mock.on({ userMessage: "raw-no-done" }, () => ({ raw: { ...raw.raw, done: false } }));
    const got = await streamText("raw-no-done");
    expect(got.text).toBe(frames);
  });

  it("passes the authored status and headers to the SDK", async () => {
    mock.on({ userMessage: "raw-headers" }, () => ({
      raw: { ...raw.raw, status: 201, headers: { "x-request-id": "req_raw_chat" } },
    }));
    const { response } = await client.chat.completions
      .create({
        model: "gpt-4.1",
        messages: [{ role: "user", content: "raw-headers" }],
        stream: true,
      })
      .withResponse();
    expect(response.status).toBe(201);
    expect(response.headers.get("x-request-id")).toBe("req_raw_chat");
  });
});

describe("raw passthrough: openai-chat via OpenRouter and Azure", () => {
  it("serves the same raw chunks and json on the OpenRouter route", async () => {
    const openRouter = new OpenAI({
      apiKey: "local-proof",
      baseURL: `${mock.url}/api/v1`,
      maxRetries: 0,
    });
    const stream = await openRouter.chat.completions.create({
      model: "openai/gpt-4.1",
      messages: [{ role: "user", content: "raw-proof" }],
      stream: true,
    });
    const received: unknown[] = [];
    for await (const chunk of stream) received.push(chunk);
    expect(received).toEqual(events);

    const reply = await openRouter.chat.completions.create({
      model: "openai/gpt-4.1",
      messages: [{ role: "user", content: "raw-proof" }],
    });
    expect(reply).toEqual(json);
  });

  it("sends the same bytes on the OpenRouter route as on /v1", async () => {
    const send = async (path: string): Promise<string> => {
      const res = await fetch(`${mock.url}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "openai/gpt-4.1",
          messages: [{ role: "user", content: "raw-proof" }],
          stream: true,
        }),
      });
      return res.text();
    };
    expect(await send("/api/v1/chat/completions")).toBe(await send("/v1/chat/completions"));
  });

  it("serves the raw json on the Azure deployment route", async () => {
    const res = await fetch(
      `${mock.url}/openai/deployments/my-gpt/chat/completions?api-version=2024-10-21`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "api-key": "local-proof" },
        body: JSON.stringify({ messages: [{ role: "user", content: "raw-proof" }] }),
      },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(json);
  });
});

describe("raw passthrough: openai-chat error bodies", () => {
  async function post(
    content: string,
    stream: boolean,
    path = "/v1/chat/completions",
  ): Promise<{ status: number; body: string }> {
    const res = await fetch(`${mock.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4.1", messages: [{ role: "user", content }], stream }),
    });
    return { status: res.status, body: await res.text() };
  }

  const expected = (code: string, message: string): string =>
    JSON.stringify({ error: { message, type: "server_error", param: null, code } });
  const expectedOpenRouter = (code: string, message: string): string =>
    JSON.stringify({ error: { code: 500, message: `${code}: ${message}` } });

  it("a streaming request on a json-only fixture: aimock_raw_mode_unavailable", async () => {
    mock.on({ userMessage: "json-only" }, () => ({ raw: { wire: "openai-chat", json } }));
    const got = await post("json-only", true);
    expect(got.status).toBe(500);
    expect(got.body).toBe(
      expected(
        "aimock_raw_mode_unavailable",
        `raw fixture has no "events" body for a streaming request on openai-chat`,
      ),
    );
  });

  it("a non-streaming request on an events-only fixture: aimock_raw_mode_unavailable", async () => {
    mock.on({ userMessage: "events-only" }, () => ({ raw: { wire: "openai-chat", events } }));
    const got = await post("events-only", false);
    expect(got.status).toBe(500);
    expect(got.body).toBe(
      expected(
        "aimock_raw_mode_unavailable",
        `raw fixture has no "json" body for a non-streaming request on openai-chat`,
      ),
    );
  });

  it("a factory for another wire: aimock_raw_fixture_invalid", async () => {
    mock.on({ userMessage: "other-wire" }, () => ({ raw: { wire: "anthropic", json } }));
    const got = await post("other-wire", false);
    expect(got.status).toBe(500);
    expect(got.body).toBe(
      expected("aimock_raw_fixture_invalid", "raw fixture is for anthropic, not openai-chat"),
    );
  });

  it("a factory that fails the checker: aimock_raw_fixture_invalid", async () => {
    mock.on({ userMessage: "bad-status" }, () => ({
      raw: { wire: "openai-chat", json, status: 99 },
    }));
    const got = await post("bad-status", false);
    expect(got.status).toBe(500);
    const parsed = JSON.parse(got.body) as { error: { code: string; message: string } };
    expect(Object.keys(parsed.error)).toEqual(["message", "type", "param", "code"]);
    expect(parsed.error.code).toBe("aimock_raw_fixture_invalid");
    expect(parsed.error.message).toMatch(/^invalid raw fixture: .*status/);
  });

  it("OpenRouter, mode mismatch: aimock_raw_mode_unavailable in the OpenRouter dialect", async () => {
    mock.on({ userMessage: "json-only" }, () => ({ raw: { wire: "openai-chat", json } }));
    const got = await post("json-only", true, "/api/v1/chat/completions");
    expect(got.status).toBe(500);
    expect(got.body).toBe(
      expectedOpenRouter(
        "aimock_raw_mode_unavailable",
        `raw fixture has no "events" body for a streaming request on openai-chat`,
      ),
    );
  });

  it("OpenRouter, wrong wire: aimock_raw_fixture_invalid in the OpenRouter dialect", async () => {
    mock.on({ userMessage: "other-wire" }, () => ({ raw: { wire: "anthropic", json } }));
    const got = await post("other-wire", false, "/api/v1/chat/completions");
    expect(got.status).toBe(500);
    expect(got.body).toBe(
      expectedOpenRouter(
        "aimock_raw_fixture_invalid",
        "raw fixture is for anthropic, not openai-chat",
      ),
    );
  });
});
