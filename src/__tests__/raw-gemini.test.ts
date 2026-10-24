import { GoogleGenAI } from "@google/genai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LLMock } from "../llmock.js";
import type { RawResponse } from "../types.js";

// Raw passthrough on the Gemini generateContent wire (#549).

const events: Record<string, unknown>[] = [
  {
    candidates: [{ content: { role: "model", parts: [{ text: "Raw " }] }, index: 0 }],
    modelVersion: "gemini-2.5-flash",
  },
  {
    candidates: [
      {
        content: {
          role: "model",
          parts: [{ inlineData: { mimeType: "image/png", data: "iVBORw0KGgo=" } }],
        },
        index: 0,
      },
    ],
    modelVersion: "gemini-2.5-flash",
  },
  {
    candidates: [
      { content: { role: "model", parts: [{ text: "stream." }] }, finishReason: "STOP", index: 0 },
    ],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 3, totalTokenCount: 4 },
    modelVersion: "gemini-2.5-flash",
  },
];

const json = {
  candidates: [
    {
      content: { role: "model", parts: [{ text: "Raw JSON reply." }] },
      finishReason: "STOP",
      index: 0,
    },
  ],
  usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 3, totalTokenCount: 4 },
  modelVersion: "gemini-2.5-flash",
};

const raw: RawResponse = { raw: { wire: "gemini", events, json } };

let mock: LLMock;
let client: GoogleGenAI;

beforeEach(async () => {
  mock = new LLMock({ port: 0, host: "127.0.0.1", logLevel: "silent" });
  mock.on({ userMessage: "raw-proof" }, () => raw);
  await mock.start();
  client = new GoogleGenAI({
    apiKey: "local-proof",
    httpOptions: { baseUrl: mock.url, timeout: 5000, retryOptions: { attempts: 1 } },
  });
});

afterEach(async () => {
  await mock.stop();
});

describe("raw passthrough: gemini", () => {
  it("streams exactly the authored chunks in order", async () => {
    const received: unknown[] = [];
    for await (const chunk of await client.models.generateContentStream({
      model: "gemini-2.5-flash",
      contents: "raw-proof",
    }))
      received.push(chunk);
    expect(received).toHaveLength(events.length);
    received.forEach((chunk, index) => expect(chunk).toMatchObject(events[index]));
  });

  it("returns the authored json for a non-streaming request", async () => {
    const reply = await client.models.generateContent({
      model: "gemini-2.5-flash",
      contents: "raw-proof",
    });
    expect(reply).toMatchObject(json);
  });
});

describe("raw passthrough: gemini framing", () => {
  const sse = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  const body = JSON.stringify({ contents: [{ role: "user", parts: [{ text: "raw-proof" }] }] });

  it("frames each chunk as a bare SSE data line, inlineData included", async () => {
    const res = await fetch(
      `${mock.url}/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse`,
      { method: "POST", headers: { "content-type": "application/json" }, body },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await res.text()).toBe(sse);
  });

  it("serves the same chunks and json on the Vertex AI path", async () => {
    const base = `${mock.url}/v1/projects/p/locations/us-central1/publishers/google/models/gemini-2.5-flash`;
    const stream = await fetch(`${base}:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(stream.status).toBe(200);
    expect(await stream.text()).toBe(sse);
    const nonStream = await fetch(`${base}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(nonStream.status).toBe(200);
    expect(await nonStream.text()).toBe(JSON.stringify(json));
  });
});

describe("raw passthrough: gemini error bodies", () => {
  async function post(text: string, stream: boolean): Promise<{ status: number; body: string }> {
    const method = stream ? "streamGenerateContent?alt=sse" : "generateContent";
    const res = await fetch(`${mock.url}/v1beta/models/gemini-2.5-flash:${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text }] }] }),
    });
    return { status: res.status, body: await res.text() };
  }

  // Gemini's misbehavior template has no code slot: the code leads the message.
  const expected = (code: string, message: string): string =>
    JSON.stringify({ error: { code: 500, message: `${code}: ${message}`, status: "INTERNAL" } });

  it("a streaming request on a json-only fixture: aimock_raw_mode_unavailable", async () => {
    mock.on({ userMessage: "json-only" }, () => ({ raw: { wire: "gemini", json } }));
    const got = await post("json-only", true);
    expect(got.status).toBe(500);
    expect(got.body).toBe(
      expected(
        "aimock_raw_mode_unavailable",
        `raw fixture has no "events" body for a streaming request on gemini`,
      ),
    );
  });

  it("a non-streaming request on an events-only fixture: aimock_raw_mode_unavailable", async () => {
    mock.on({ userMessage: "events-only" }, () => ({ raw: { wire: "gemini", events } }));
    const got = await post("events-only", false);
    expect(got.status).toBe(500);
    expect(got.body).toBe(
      expected(
        "aimock_raw_mode_unavailable",
        `raw fixture has no "json" body for a non-streaming request on gemini`,
      ),
    );
  });

  it("a factory for another wire: aimock_raw_fixture_invalid", async () => {
    mock.on({ userMessage: "other-wire" }, () => ({ raw: { wire: "anthropic", json } }));
    const got = await post("other-wire", false);
    expect(got.status).toBe(500);
    expect(got.body).toBe(
      expected("aimock_raw_fixture_invalid", "raw fixture is for anthropic, not gemini"),
    );
  });

  it("a factory that fails the checker: aimock_raw_fixture_invalid", async () => {
    mock.on({ userMessage: "bad-status" }, () => ({
      raw: { wire: "gemini", json, status: 99 },
    }));
    const got = await post("bad-status", false);
    expect(got.status).toBe(500);
    const parsed = JSON.parse(got.body) as {
      error: { code: number; message: string; status: string };
    };
    expect(Object.keys(parsed.error)).toEqual(["code", "message", "status"]);
    expect(parsed.error.code).toBe(500);
    expect(parsed.error.status).toBe("INTERNAL");
    expect(parsed.error.message).toMatch(
      /^aimock_raw_fixture_invalid: invalid raw fixture: .*status/,
    );
  });
});
