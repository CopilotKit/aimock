import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LLMock } from "../llmock.js";
import type { RawResponse } from "../types.js";

// Raw passthrough on the Anthropic Messages wire (#549).

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
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Raw stream." } },
  { type: "content_block_stop", index: 0 },
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 3 },
  },
  { type: "message_stop" },
];

const json = {
  id: "msg_raw_json",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-4-5",
  content: [{ type: "text", text: "Raw JSON reply." }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 3 },
};

const raw: RawResponse = { raw: { wire: "anthropic", events, json } };

// MessageStream accumulates its snapshot into the `message_start` event object
// as later events arrive, so each event is cloned when the SDK emits it.
async function collectEvents(stream: ReturnType<Anthropic["messages"]["stream"]>) {
  const received: unknown[] = [];
  stream.on("streamEvent", (event: unknown) => received.push(structuredClone(event)));
  await stream.done();
  return received;
}

let mock: LLMock;
let client: Anthropic;

beforeEach(async () => {
  mock = new LLMock({ port: 0, host: "127.0.0.1", logLevel: "silent" });
  mock.on({ userMessage: "raw-proof" }, () => raw);
  await mock.start();
  client = new Anthropic({ apiKey: "local-proof", baseURL: mock.url, maxRetries: 0 });
});

afterEach(async () => {
  await mock.stop();
});

describe("raw passthrough: anthropic", () => {
  it("streams exactly the authored events in order", async () => {
    const stream = client.messages.stream({
      model: "claude-sonnet-4-5",
      max_tokens: 64,
      messages: [{ role: "user", content: "raw-proof" }],
    });
    const received = await collectEvents(stream);
    expect(received).toEqual(events);
  });

  it("returns the authored json for a non-streaming request", async () => {
    const reply = await client.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 64,
      messages: [{ role: "user", content: "raw-proof" }],
    });
    expect(reply).toEqual(json);
  });
});

describe("raw passthrough: anthropic wire details", () => {
  it("passes an unmodeled delta type through messages.stream", async () => {
    const future: Record<string, unknown>[] = [
      events[0],
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "future_delta", payload: [1, 2] } },
      { type: "content_block_stop", index: 0 },
      events[4],
      events[5],
    ];
    mock.on({ userMessage: "raw-future" }, () => ({ raw: { wire: "anthropic", events: future } }));
    const stream = client.messages.stream({
      model: "claude-sonnet-4-5",
      max_tokens: 64,
      messages: [{ role: "user", content: "raw-future" }],
    });
    const received = await collectEvents(stream);
    expect(received).toEqual(future);
  });

  it("frames each event as a named SSE event", async () => {
    const res = await fetch(`${mock.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "raw-proof" }],
      }),
    });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await res.text()).toBe(
      events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join(""),
    );
  });

  it("journals a client abort mid-stream as client aborted", async () => {
    const slow = new LLMock({ port: 0, host: "127.0.0.1", logLevel: "silent", latency: 2000 });
    slow.on({ userMessage: "raw-abort" }, () => raw);
    await slow.start();
    try {
      const controller = new AbortController();
      const res = await fetch(`${slow.url}/v1/messages`, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 64,
          stream: true,
          messages: [{ role: "user", content: "raw-abort" }],
        }),
      });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      expect((await reader.read()).done).toBe(false);
      controller.abort();
      await expect(reader.read()).rejects.toMatchObject({ name: "AbortError" });
      await expect
        .poll(() => slow.getRequests()[0]?.response.interrupted, { timeout: 1000 })
        .toBe(true);
      expect(slow.getRequests()[0].response.interruptReason).toBe("client aborted");
      expect(slow.getRequests()[0].response.status).toBe(200);
    } finally {
      await slow.stop();
    }
  }, 10000);
});

describe("raw passthrough: anthropic error bodies", () => {
  async function post(content: string, stream: boolean): Promise<{ status: number; body: string }> {
    const res = await fetch(`${mock.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 64,
        stream,
        messages: [{ role: "user", content }],
      }),
    });
    return { status: res.status, body: await res.text() };
  }

  const expected = (code: string, message: string): string =>
    JSON.stringify({ type: "error", error: { type: "api_error", code, message } });

  it("a streaming request on a json-only fixture: aimock_raw_mode_unavailable", async () => {
    mock.on({ userMessage: "json-only" }, () => ({ raw: { wire: "anthropic", json } }));
    const got = await post("json-only", true);
    expect(got.status).toBe(500);
    expect(got.body).toBe(
      expected(
        "aimock_raw_mode_unavailable",
        `raw fixture has no "events" body for a streaming request on anthropic`,
      ),
    );
  });

  it("a non-streaming request on an events-only fixture: aimock_raw_mode_unavailable", async () => {
    mock.on({ userMessage: "events-only" }, () => ({ raw: { wire: "anthropic", events } }));
    const got = await post("events-only", false);
    expect(got.status).toBe(500);
    expect(got.body).toBe(
      expected(
        "aimock_raw_mode_unavailable",
        `raw fixture has no "json" body for a non-streaming request on anthropic`,
      ),
    );
  });

  it("a factory for another wire: aimock_raw_fixture_invalid", async () => {
    mock.on({ userMessage: "other-wire" }, () => ({ raw: { wire: "openai-responses", json } }));
    const got = await post("other-wire", false);
    expect(got.status).toBe(500);
    expect(got.body).toBe(
      expected("aimock_raw_fixture_invalid", "raw fixture is for openai-responses, not anthropic"),
    );
  });

  it("a factory that fails the checker: aimock_raw_fixture_invalid", async () => {
    mock.on({ userMessage: "bad-status" }, () => ({
      raw: { wire: "anthropic", json, status: 99 },
    }));
    const got = await post("bad-status", false);
    expect(got.status).toBe(500);
    const parsed = JSON.parse(got.body) as {
      type: string;
      error: { type: string; code: string; message: string };
    };
    expect(Object.keys(parsed)).toEqual(["type", "error"]);
    expect(Object.keys(parsed.error)).toEqual(["type", "code", "message"]);
    expect(parsed.error.type).toBe("api_error");
    expect(parsed.error.code).toBe("aimock_raw_fixture_invalid");
    expect(parsed.error.message).toMatch(/^invalid raw fixture: .*status/);
  });
});
