import * as http from "node:http";
import { GoogleGenAI } from "@google/genai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LLMock } from "../llmock.js";
import type { RawResponse } from "../types.js";

// Raw passthrough on the Gemini Interactions wire (#549).

const events: Record<string, unknown>[] = [
  {
    event_type: "interaction.created",
    interaction: { id: "int_raw", status: "in_progress" },
    event_id: "evt_1",
  },
  { event_type: "step.start", index: 0, step: { type: "model_output" }, event_id: "evt_2" },
  {
    event_type: "step.delta",
    index: 0,
    delta: { type: "text", text: "Raw interactions stream." },
    event_id: "evt_3",
  },
  { event_type: "step.stop", index: 0, event_id: "evt_4" },
  {
    event_type: "interaction.completed",
    interaction: {
      id: "int_raw",
      status: "completed",
      usage: { total_input_tokens: 1, total_output_tokens: 3, total_tokens: 4 },
    },
    event_id: "evt_5",
  },
];

const json = {
  id: "int_raw_json",
  status: "completed",
  steps: [{ type: "model_output", content: [{ type: "text", text: "Raw JSON reply." }] }],
  usage: { total_input_tokens: 1, total_output_tokens: 3, total_tokens: 4 },
};

const raw: RawResponse = { raw: { wire: "gemini-interactions", events, json } };

let mock: LLMock;
let client: GoogleGenAI;

beforeEach(async () => {
  mock = new LLMock({ port: 0, host: "127.0.0.1", logLevel: "silent" });
  mock.on({ userMessage: "raw-proof" }, () => raw);
  await mock.start();
  client = new GoogleGenAI({ apiKey: "local-proof", httpOptions: { baseUrl: mock.url } });
});

afterEach(async () => {
  await mock.stop();
});

describe("raw passthrough: gemini-interactions", () => {
  it("streams exactly the authored events in order", async () => {
    const stream = await client.interactions.create(
      { model: "gemini-2.5-flash", input: "raw-proof", stream: true },
      { maxRetries: 0, timeout: 5000 },
    );
    const received: unknown[] = [];
    for await (const event of stream) received.push(event);
    expect(received).toEqual(events);
  });

  it("returns the authored json for a non-streaming request", async () => {
    const reply = await client.interactions.create(
      { model: "gemini-2.5-flash", input: "raw-proof", stream: false },
      { maxRetries: 0, timeout: 5000 },
    );
    expect(reply).toMatchObject(json);
  });
});

describe("raw passthrough: gemini-interactions framing", () => {
  async function post(input: string, stream?: boolean): Promise<Response> {
    return fetch(`${mock.url}/v1beta/interactions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gemini-2.5-flash",
        input,
        ...(stream === undefined ? {} : { stream }),
      }),
    });
  }

  // Collects every byte that arrives before the server destroys the socket.
  function postPartial(input: string): Promise<string> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      const done = () => resolve(Buffer.concat(chunks).toString("utf8"));
      const req = http.request(
        `${mock.url}/v1beta/interactions`,
        { method: "POST", headers: { "content-type": "application/json" } },
        (res) => {
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", done);
          res.on("error", done);
          res.on("aborted", done);
        },
      );
      req.on("error", done);
      req.end(JSON.stringify({ model: "gemini-2.5-flash", input, stream: true }));
    });
  }

  it("streams when stream is omitted, as bare SSE data lines", async () => {
    const res = await post("raw-proof");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await res.text()).toBe(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""));
  });

  it("truncateAfterChunks: 2 counts every raw frame", async () => {
    // Typed Interactions streams count only step.delta toward the budget; raw
    // counts every frame, so this stream (one step.delta) stops after step.start.
    mock.addFixture({
      match: { userMessage: "raw-truncate" },
      response: raw,
      latency: 10,
      truncateAfterChunks: 2,
    });
    const frame = (e: Record<string, unknown>) => `data: ${JSON.stringify(e)}\n\n`;
    const text = await postPartial("raw-truncate");
    // The socket is destroyed right after the second frame is written, so that
    // frame may or may not arrive; nothing after it ever does.
    expect(text.startsWith(frame(events[0]))).toBe(true);
    expect((frame(events[0]) + frame(events[1])).startsWith(text)).toBe(true);
    await expect
      .poll(() => mock.getLastRequest()?.response.interrupted, { timeout: 1000 })
      .toBe(true);
    expect(mock.getLastRequest()?.response.interruptReason).toBe("truncateAfterChunks");
  });
});

describe("raw passthrough: gemini-interactions error bodies", () => {
  async function post(input: string, stream: boolean): Promise<{ status: number; body: string }> {
    const res = await fetch(`${mock.url}/v1beta/interactions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gemini-2.5-flash", input, stream }),
    });
    return { status: res.status, body: await res.text() };
  }

  const expected = (code: string, message: string): string =>
    JSON.stringify({ error: { code, message } });

  it("a streaming request on a json-only fixture: aimock_raw_mode_unavailable", async () => {
    mock.on({ userMessage: "json-only" }, () => ({ raw: { wire: "gemini-interactions", json } }));
    const got = await post("json-only", true);
    expect(got.status).toBe(500);
    expect(got.body).toBe(
      expected(
        "aimock_raw_mode_unavailable",
        `raw fixture has no "events" body for a streaming request on gemini-interactions`,
      ),
    );
  });

  it("a non-streaming request on an events-only fixture: aimock_raw_mode_unavailable", async () => {
    mock.on({ userMessage: "events-only" }, () => ({
      raw: { wire: "gemini-interactions", events },
    }));
    const got = await post("events-only", false);
    expect(got.status).toBe(500);
    expect(got.body).toBe(
      expected(
        "aimock_raw_mode_unavailable",
        `raw fixture has no "json" body for a non-streaming request on gemini-interactions`,
      ),
    );
  });

  it("a factory for another wire: aimock_raw_fixture_invalid", async () => {
    mock.on({ userMessage: "other-wire" }, () => ({ raw: { wire: "gemini", json } }));
    const got = await post("other-wire", false);
    expect(got.status).toBe(500);
    expect(got.body).toBe(
      expected("aimock_raw_fixture_invalid", "raw fixture is for gemini, not gemini-interactions"),
    );
  });

  it("a factory that fails the checker: aimock_raw_fixture_invalid", async () => {
    mock.on({ userMessage: "bad-status" }, () => ({
      raw: { wire: "gemini-interactions", json, status: 99 },
    }));
    const got = await post("bad-status", false);
    expect(got.status).toBe(500);
    const parsed = JSON.parse(got.body) as { error: { code: string; message: string } };
    expect(Object.keys(parsed.error)).toEqual(["code", "message"]);
    expect(parsed.error.code).toBe("aimock_raw_fixture_invalid");
    expect(parsed.error.message).toMatch(/^invalid raw fixture: .*status/);
  });
});
