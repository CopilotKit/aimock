import { CohereClientV2 } from "cohere-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LLMock } from "../llmock.js";
import type { RawResponse } from "../types.js";

// Raw passthrough on the Cohere v2 chat wire (#549).

const events: Record<string, unknown>[] = [
  { type: "message-start", id: "raw-cohere", delta: { message: { role: "assistant" } } },
  { type: "content-start", index: 0, delta: { message: { content: { type: "text", text: "" } } } },
  { type: "content-delta", index: 0, delta: { message: { content: { text: "Raw cohere." } } } },
  { type: "content-end", index: 0 },
  { type: "message-end", delta: { finish_reason: "COMPLETE" } },
];

const json = {
  id: "raw-cohere-json",
  finish_reason: "COMPLETE",
  message: { role: "assistant", content: [{ type: "text", text: "Raw JSON reply." }] },
};

const raw: RawResponse = { raw: { wire: "cohere", events, json } };

let mock: LLMock;
let client: CohereClientV2;

beforeEach(async () => {
  mock = new LLMock({ port: 0, host: "127.0.0.1", logLevel: "silent" });
  mock.on({ userMessage: "raw-proof" }, () => raw);
  await mock.start();
  client = new CohereClientV2({
    token: "local-proof",
    baseUrl: mock.url,
    maxRetries: 0,
    timeoutInSeconds: 5,
  });
});

afterEach(async () => {
  await mock.stop();
});

const request = {
  model: "command-r-plus",
  messages: [{ role: "user" as const, content: "raw-proof" }],
};

describe("raw passthrough: cohere", () => {
  it("streams exactly the authored events in order", async () => {
    const received: { type?: string }[] = [];
    for await (const event of await client.chatStream(request)) received.push(event);
    // The SDK camel-cases keys (finish_reason -> finishReason); the event
    // sequence and authored text must survive unchanged.
    expect(received.map((event) => event.type)).toEqual(events.map((event) => event.type));
    expect(received[2]).toMatchObject(events[2]);
    expect(received[4]).toMatchObject({ delta: { finishReason: "COMPLETE" } });
  });

  it("returns the authored json for a non-streaming request", async () => {
    const reply = await client.chat(request);
    expect(reply).toMatchObject({
      id: "raw-cohere-json",
      finishReason: "COMPLETE",
      message: { role: "assistant", content: [{ type: "text", text: "Raw JSON reply." }] },
    });
  });

  it("frames each event as a named SSE event with no [DONE] terminal", async () => {
    const res = await fetch(`${mock.url}/v2/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...request, stream: true }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const text = await res.text();
    expect(text).toBe(
      events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join(""),
    );
    expect(text).not.toContain("[DONE]");
  });
});

describe("raw passthrough: cohere error bodies", () => {
  async function post(content: string, stream: boolean): Promise<{ status: number; body: string }> {
    const res = await fetch(`${mock.url}/v2/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "command-r-plus",
        messages: [{ role: "user", content }],
        stream,
      }),
    });
    return { status: res.status, body: await res.text() };
  }

  const expected = (code: string, message: string): string => JSON.stringify({ message, code });

  it("a streaming request on a json-only fixture: aimock_raw_mode_unavailable", async () => {
    mock.on({ userMessage: "json-only" }, () => ({ raw: { wire: "cohere", json } }));
    const got = await post("json-only", true);
    expect(got.status).toBe(500);
    expect(got.body).toBe(
      expected(
        "aimock_raw_mode_unavailable",
        `raw fixture has no "events" body for a streaming request on cohere`,
      ),
    );
  });

  it("a non-streaming request on an events-only fixture: aimock_raw_mode_unavailable", async () => {
    mock.on({ userMessage: "events-only" }, () => ({ raw: { wire: "cohere", events } }));
    const got = await post("events-only", false);
    expect(got.status).toBe(500);
    expect(got.body).toBe(
      expected(
        "aimock_raw_mode_unavailable",
        `raw fixture has no "json" body for a non-streaming request on cohere`,
      ),
    );
  });

  it("a factory for another wire: aimock_raw_fixture_invalid", async () => {
    mock.on({ userMessage: "other-wire" }, () => ({ raw: { wire: "ollama", json } }));
    const got = await post("other-wire", false);
    expect(got.status).toBe(500);
    expect(got.body).toBe(
      expected("aimock_raw_fixture_invalid", "raw fixture is for ollama, not cohere"),
    );
  });

  it("a factory that sets done (openai-chat only): aimock_raw_fixture_invalid", async () => {
    mock.on({ userMessage: "bad-done" }, () => ({ raw: { wire: "cohere", events, done: true } }));
    const got = await post("bad-done", true);
    expect(got.status).toBe(500);
    const parsed = JSON.parse(got.body) as { message: string; code: string };
    expect(Object.keys(parsed)).toEqual(["message", "code"]);
    expect(parsed.code).toBe("aimock_raw_fixture_invalid");
    expect(parsed.message).toMatch(/^invalid raw fixture: .*done/);
  });

  it("a factory that fails the checker: aimock_raw_fixture_invalid", async () => {
    mock.on({ userMessage: "bad-status" }, () => ({ raw: { wire: "cohere", json, status: 99 } }));
    const got = await post("bad-status", false);
    expect(got.status).toBe(500);
    const parsed = JSON.parse(got.body) as { message: string; code: string };
    expect(Object.keys(parsed)).toEqual(["message", "code"]);
    expect(parsed.code).toBe("aimock_raw_fixture_invalid");
    expect(parsed.message).toMatch(/^invalid raw fixture: .*status/);
  });
});
