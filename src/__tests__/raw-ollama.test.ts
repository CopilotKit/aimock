import { Ollama } from "ollama";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LLMock } from "../llmock.js";
import type { RawResponse } from "../types.js";

// Raw passthrough on the Ollama wire, /api/chat and /api/generate (#549).
// The ollama SDK has no retry loop, so a 500 fails once.

const chatEvents: Record<string, unknown>[] = [
  {
    model: "llama3.1",
    created_at: "2026-01-01T00:00:00Z",
    message: { role: "assistant", content: "Raw " },
    done: false,
  },
  {
    model: "llama3.1",
    created_at: "2026-01-01T00:00:00Z",
    message: { role: "assistant", content: "ollama." },
    done: true,
    done_reason: "stop",
  },
];
const chatJson = {
  model: "llama3.1",
  created_at: "2026-01-01T00:00:00Z",
  message: { role: "assistant", content: "Raw JSON reply." },
  done: true,
  done_reason: "stop",
};
const generateEvents: Record<string, unknown>[] = [
  { model: "llama3.1", created_at: "2026-01-01T00:00:00Z", response: "Raw ", done: false },
  {
    model: "llama3.1",
    created_at: "2026-01-01T00:00:00Z",
    response: "generate.",
    done: true,
    done_reason: "stop",
  },
];
const generateJson = {
  model: "llama3.1",
  created_at: "2026-01-01T00:00:00Z",
  response: "Raw JSON reply.",
  done: true,
  done_reason: "stop",
};

const chatRaw: RawResponse = { raw: { wire: "ollama", events: chatEvents, json: chatJson } };
const generateRaw: RawResponse = {
  raw: { wire: "ollama-generate", events: generateEvents, json: generateJson },
};

let mock: LLMock;
let client: Ollama;

beforeEach(async () => {
  mock = new LLMock({ port: 0, host: "127.0.0.1", logLevel: "silent" });
  mock.on({ userMessage: "raw-proof" }, () => chatRaw);
  mock.on({ userMessage: "raw-generate" }, () => generateRaw);
  await mock.start();
  client = new Ollama({ host: mock.url });
});

afterEach(async () => {
  await mock.stop();
});

const chatRequest = { model: "llama3.1", messages: [{ role: "user", content: "raw-proof" }] };

describe("raw passthrough: ollama", () => {
  it("chat streams exactly the authored objects in order", async () => {
    const received: unknown[] = [];
    for await (const chunk of await client.chat({ ...chatRequest, stream: true }))
      received.push(chunk);
    expect(received).toEqual(chatEvents);
  });

  it("chat returns the authored json with stream:false", async () => {
    expect(await client.chat({ ...chatRequest, stream: false })).toEqual(chatJson);
  });

  it("generate streams exactly the authored objects in order", async () => {
    const received: unknown[] = [];
    for await (const chunk of await client.generate({
      model: "llama3.1",
      prompt: "raw-generate",
      stream: true,
    }))
      received.push(chunk);
    expect(received).toEqual(generateEvents);
  });

  it("generate returns the authored json with stream:false", async () => {
    expect(
      await client.generate({ model: "llama3.1", prompt: "raw-generate", stream: false }),
    ).toEqual(generateJson);
  });

  it("writes NDJSON, one authored object per line, when stream is absent", async () => {
    for (const [path, body, expected] of [
      ["/api/chat", chatRequest, chatEvents],
      ["/api/generate", { model: "llama3.1", prompt: "raw-generate" }, generateEvents],
    ] as const) {
      const res = await fetch(`${mock.url}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/x-ndjson");
      expect(await res.text()).toBe(expected.map((e) => `${JSON.stringify(e)}\n`).join(""));
    }
  });
});

describe("raw passthrough: ollama error bodies", () => {
  async function post(
    path: "/api/chat" | "/api/generate",
    content: string,
    stream: boolean,
  ): Promise<{ status: number; body: string }> {
    const body =
      path === "/api/chat"
        ? { model: "llama3.1", messages: [{ role: "user", content }], stream }
        : { model: "llama3.1", prompt: content, stream };
    const res = await fetch(`${mock.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.text() };
  }

  const expected = (code: string, message: string): string =>
    JSON.stringify({ error: `${code}: ${message}` });

  for (const path of ["/api/chat", "/api/generate"] as const) {
    const wire = path === "/api/chat" ? "ollama" : "ollama-generate";

    it(`${path}: a streaming request on a json-only fixture: aimock_raw_mode_unavailable`, async () => {
      mock.on({ userMessage: "json-only" }, () => ({ raw: { wire, json: chatJson } }));
      const got = await post(path, "json-only", true);
      expect(got.status).toBe(500);
      expect(got.body).toBe(
        expected(
          "aimock_raw_mode_unavailable",
          `raw fixture has no "events" body for a streaming request on ${wire}`,
        ),
      );
    });

    it(`${path}: a non-streaming request on an events-only fixture: aimock_raw_mode_unavailable`, async () => {
      mock.on({ userMessage: "events-only" }, () => ({
        raw: { wire, events: chatEvents },
      }));
      const got = await post(path, "events-only", false);
      expect(got.status).toBe(500);
      expect(got.body).toBe(
        expected(
          "aimock_raw_mode_unavailable",
          `raw fixture has no "json" body for a non-streaming request on ${wire}`,
        ),
      );
    });

    it(`${path}: a factory for another wire: aimock_raw_fixture_invalid`, async () => {
      mock.on({ userMessage: "other-wire" }, () => ({ raw: { wire: "cohere", json: chatJson } }));
      const got = await post(path, "other-wire", false);
      expect(got.status).toBe(500);
      expect(got.body).toBe(
        expected("aimock_raw_fixture_invalid", `raw fixture is for cohere, not ${wire}`),
      );
    });

    it(`${path}: a factory that fails the checker: aimock_raw_fixture_invalid`, async () => {
      mock.on({ userMessage: "bad-status" }, () => ({
        raw: { wire, json: chatJson, status: 99 },
      }));
      const got = await post(path, "bad-status", false);
      expect(got.status).toBe(500);
      const parsed = JSON.parse(got.body) as { error: string };
      expect(Object.keys(parsed)).toEqual(["error"]);
      expect(parsed.error).toMatch(/^aimock_raw_fixture_invalid: invalid raw fixture: .*status/);
    });
  }
});

describe("raw passthrough: ollama chat and generate are separate wires", () => {
  // Both fixtures match the same text, so only the wire can pick between them.
  // The chat fixture comes first: before the fix it also served /api/generate.
  let shared: LLMock;

  beforeEach(async () => {
    shared = new LLMock({ port: 0, host: "127.0.0.1", logLevel: "silent" });
    shared.addFixture({
      match: { userMessage: "shared" },
      response: { raw: { wire: "ollama", events: chatEvents, json: chatJson } },
    });
    shared.addFixture({
      match: { userMessage: "shared" },
      response: { raw: { wire: "ollama-generate", events: generateEvents, json: generateJson } },
    });
    await shared.start();
  });

  afterEach(async () => {
    await shared.stop();
  });

  it("/api/generate gets the ollama-generate fixture in generate shape", async () => {
    const sdk = new Ollama({ host: shared.url });
    const received: unknown[] = [];
    for await (const chunk of await sdk.generate({
      model: "llama3.1",
      prompt: "shared",
      stream: true,
    }))
      received.push(chunk);
    expect(received).toEqual(generateEvents);
    expect(await sdk.generate({ model: "llama3.1", prompt: "shared", stream: false })).toEqual(
      generateJson,
    );
  });

  it("/api/chat gets the ollama fixture in chat shape", async () => {
    const sdk = new Ollama({ host: shared.url });
    const req = { model: "llama3.1", messages: [{ role: "user", content: "shared" }] };
    const received: unknown[] = [];
    for await (const chunk of await sdk.chat({ ...req, stream: true })) received.push(chunk);
    expect(received).toEqual(chatEvents);
    expect(await sdk.chat({ ...req, stream: false })).toEqual(chatJson);
  });
});
