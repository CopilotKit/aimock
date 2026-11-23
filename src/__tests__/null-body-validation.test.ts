import { describe, test, expect, afterEach } from "vitest";
import { LLMock } from "../llmock.js";
import { VectorMock } from "../vector-mock.js";
import { isJsonObject } from "../helpers.js";

/**
 * A JSON body of `null` parses successfully, so the malformed-JSON branch
 * never runs — but the first field read (`body.prompt`, `body.messages`,
 * …) then throws a TypeError that the server answers with a generic 500.
 * Every JSON handler must reject a non-object body with a 400 instead.
 */

const BEDROCK_MODEL = "/model/anthropic.claude-3-sonnet-20240229-v1:0";

let mock: LLMock | null = null;

afterEach(async () => {
  await mock?.stop();
  mock = null;
});

async function start(): Promise<string> {
  mock = new LLMock({ port: 0 });
  await mock.start();
  return mock.url;
}

async function postRaw(
  url: string,
  rawBody: string,
): Promise<{ status: number; message: unknown }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: rawBody,
  });
  const json = (await res.json()) as { error?: { message?: unknown } };
  return { status: res.status, message: json?.error?.message };
}

async function expect400ObjectBody(url: string): Promise<void> {
  const { status, message } = await postRaw(url, "null");
  expect(status).toBe(400);
  expect(message).toBe("Request body must be a JSON object");
}

describe("isJsonObject", () => {
  test("accepts plain objects", () => {
    expect(isJsonObject({})).toBe(true);
    expect(isJsonObject({ prompt: "hi" })).toBe(true);
  });

  test("rejects null, arrays, and scalars", () => {
    expect(isJsonObject(null)).toBe(false);
    expect(isJsonObject(undefined)).toBe(false);
    expect(isJsonObject([])).toBe(false);
    expect(isJsonObject([{ prompt: "hi" }])).toBe(false);
    expect(isJsonObject("hi")).toBe(false);
    expect(isJsonObject(123)).toBe(false);
    expect(isJsonObject(true)).toBe(false);
  });
});

describe("null JSON body returns 400, not 500", () => {
  test("POST /v1/images/generations", async () => {
    await expect400ObjectBody(`${await start()}/v1/images/generations`);
  });

  test("POST /v1/audio/speech", async () => {
    await expect400ObjectBody(`${await start()}/v1/audio/speech`);
  });

  test("POST /v1/videos", async () => {
    await expect400ObjectBody(`${await start()}/v1/videos`);
  });

  test("POST /v1/embeddings", async () => {
    await expect400ObjectBody(`${await start()}/v1/embeddings`);
  });

  test("POST /v1/moderations", async () => {
    await expect400ObjectBody(`${await start()}/v1/moderations`);
  });

  test("POST /search", async () => {
    await expect400ObjectBody(`${await start()}/search`);
  });

  test("POST /v2/rerank", async () => {
    await expect400ObjectBody(`${await start()}/v2/rerank`);
  });

  test("POST /fal/queue/submit/{model} (fal-audio)", async () => {
    await expect400ObjectBody(`${await start()}/fal/queue/submit/fal-ai/stable-audio`);
  });

  test("POST /fal/run/{model} (fal-audio)", async () => {
    await expect400ObjectBody(`${await start()}/fal/run/fal-ai/stable-audio`);
  });

  test("POST /v1/text-to-speech/{voice_id} (elevenlabs)", async () => {
    await expect400ObjectBody(`${await start()}/v1/text-to-speech/eleven_multilingual_v2`);
  });

  test("POST /v1/sound-generation (elevenlabs)", async () => {
    await expect400ObjectBody(`${await start()}/v1/sound-generation`);
  });

  test("POST /v1/text-to-voice/design (elevenlabs)", async () => {
    await expect400ObjectBody(`${await start()}/v1/text-to-voice/design`);
  });

  test("POST /v1/text-to-voice (elevenlabs)", async () => {
    await expect400ObjectBody(`${await start()}/v1/text-to-voice`);
  });

  test("POST /v1/chat/completions", async () => {
    await expect400ObjectBody(`${await start()}/v1/chat/completions`);
  });

  test("POST /v1/messages", async () => {
    await expect400ObjectBody(`${await start()}/v1/messages`);
  });

  test("POST /v1/responses", async () => {
    await expect400ObjectBody(`${await start()}/v1/responses`);
  });

  test("POST /v2/chat (cohere)", async () => {
    await expect400ObjectBody(`${await start()}/v2/chat`);
  });

  test("POST /v2/embed (cohere)", async () => {
    await expect400ObjectBody(`${await start()}/v2/embed`);
  });

  test("POST /v1beta/models/{model}:generateContent (gemini)", async () => {
    await expect400ObjectBody(`${await start()}/v1beta/models/gemini-2.0-flash:generateContent`);
  });

  test("POST /v1beta/models/{model}:embedContent (gemini)", async () => {
    await expect400ObjectBody(`${await start()}/v1beta/models/text-embedding-004:embedContent`);
  });

  test("POST /v1beta/interactions (gemini)", async () => {
    await expect400ObjectBody(`${await start()}/v1beta/interactions`);
  });

  test("POST /api/chat (ollama)", async () => {
    await expect400ObjectBody(`${await start()}/api/chat`);
  });

  test("POST /api/generate (ollama)", async () => {
    await expect400ObjectBody(`${await start()}/api/generate`);
  });

  test("POST /api/embeddings (ollama)", async () => {
    await expect400ObjectBody(`${await start()}/api/embeddings`);
  });

  test("POST /model/{id}/invoke (bedrock)", async () => {
    await expect400ObjectBody(`${await start()}${BEDROCK_MODEL}/invoke`);
  });

  test("POST /model/{id}/invoke-with-response-stream (bedrock)", async () => {
    await expect400ObjectBody(`${await start()}${BEDROCK_MODEL}/invoke-with-response-stream`);
  });

  test("POST /model/{id}/converse (bedrock)", async () => {
    await expect400ObjectBody(`${await start()}${BEDROCK_MODEL}/converse`);
  });

  test("POST /model/{id}/converse-stream (bedrock)", async () => {
    await expect400ObjectBody(`${await start()}${BEDROCK_MODEL}/converse-stream`);
  });
});

describe("non-object JSON bodies are rejected with the same 400", () => {
  test("array body on POST /v1/images/generations", async () => {
    const base = await start();
    const { status, message } = await postRaw(`${base}/v1/images/generations`, '[{"prompt":"hi"}]');
    expect(status).toBe(400);
    expect(message).toBe("Request body must be a JSON object");
  });

  test("scalar body on POST /v1/embeddings", async () => {
    const base = await start();
    const { status, message } = await postRaw(`${base}/v1/embeddings`, '"hi"');
    expect(status).toBe(400);
    expect(message).toBe("Request body must be a JSON object");
  });

  test("numeric body on POST /search", async () => {
    const base = await start();
    const { status, message } = await postRaw(`${base}/search`, "123");
    expect(status).toBe(400);
    expect(message).toBe("Request body must be a JSON object");
  });

  test("array body on POST /v1/responses", async () => {
    const base = await start();
    const { status, message } = await postRaw(`${base}/v1/responses`, '[{"model":"gpt-4o"}]');
    expect(status).toBe(400);
    expect(message).toBe("Request body must be a JSON object");
  });

  test("string body on POST /v1/responses", async () => {
    const base = await start();
    const { status, message } = await postRaw(`${base}/v1/responses`, '"hi"');
    expect(status).toBe(400);
    expect(message).toBe("Request body must be a JSON object");
  });

  test("scalar body on POST /v1beta/models/{model}:embedContent", async () => {
    const base = await start();
    const { status, message } = await postRaw(
      `${base}/v1beta/models/text-embedding-004:embedContent`,
      "123",
    );
    expect(status).toBe(400);
    expect(message).toBe("Request body must be a JSON object");
  });

  test("array body on POST /v1/chat/completions", async () => {
    const base = await start();
    const { status, message } = await postRaw(`${base}/v1/chat/completions`, "[]");
    expect(status).toBe(400);
    expect(message).toBe("Request body must be a JSON object");
  });
});

describe("the non-object-body 400 does not claim the JSON was malformed", () => {
  test("omits `code` — `invalid_json` belongs to the parse-failure branch", async () => {
    const base = await start();
    const res = await fetch(`${base}/v1/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "null",
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: Record<string, unknown> };
    expect(json.error.message).toBe("Request body must be a JSON object");
    expect(json.error).not.toHaveProperty("code");

    // The adjacent malformed-JSON branch still carries it.
    const bad = await fetch(`${base}/v1/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{oops",
    });
    expect(bad.status).toBe(400);
    const badJson = (await bad.json()) as { error: Record<string, unknown> };
    expect(badJson.error.code).toBe("invalid_json");
    expect(String(badJson.error.message)).toContain("Malformed JSON");
  });
});

/**
 * `VectorMock` is a public export with its own body-reading entry points, and
 * it was the one surface the rest of this change missed. A `null` body reached
 * the route handlers, where `body.ids` / `body.vectors` / `body.points` threw a
 * TypeError that nothing catches — killing the process instead of answering the
 * request. Both entry points (mounted `handleRequest` and standalone `start`)
 * now reject a non-object body with the same 400 the JSON handlers return.
 */
describe("VectorMock rejects non-object bodies", () => {
  // Every route the vector handler serves with a request body, across all
  // three providers it emulates.
  const BODY_ROUTES: Array<[string, string]> = [
    ["POST", "/query"],
    ["POST", "/vectors/upsert"],
    ["POST", "/vectors/delete"],
    ["POST", "/collections/c1/points/search"],
    ["PUT", "/collections/c1/points"],
    ["POST", "/collections/c1/points/delete"],
    ["POST", "/api/v1/collections/c1/query"],
    ["POST", "/api/v1/collections/c1/add"],
  ];
  const NON_OBJECT_BODIES = ["null", "[]", "123", '"hi"', "true"];

  let vector: VectorMock | null = null;
  let mounted: LLMock | null = null;

  afterEach(async () => {
    // Only the standalone mock owns a listener; a mounted one is torn down
    // with its parent and throws "Server not started" if stopped directly.
    if (vector && !mounted) await vector.stop();
    vector = null;
    await mounted?.stop();
    mounted = null;
  });

  test("standalone: every body-carrying route answers 400, not a crash", async () => {
    vector = new VectorMock();
    vector.addCollection("c1", { dimension: 3 });
    const base = await vector.start();

    for (const [method, path] of BODY_ROUTES) {
      for (const rawBody of NON_OBJECT_BODIES) {
        const res = await fetch(base + path, {
          method,
          headers: { "Content-Type": "application/json" },
          body: rawBody,
        });
        const json = (await res.json()) as { error: Record<string, unknown> };
        expect(`${method} ${path} ${rawBody} -> ${res.status}`).toBe(
          `${method} ${path} ${rawBody} -> 400`,
        );
        expect(json.error.message).toBe("Request body must be a JSON object");
        expect(json.error.type).toBe("invalid_request_error");
        // The body parsed, so `invalid_json` would be inaccurate, and a
        // whole-body rejection names no field.
        expect(json.error).not.toHaveProperty("code");
        expect(json.error).not.toHaveProperty("param");
      }
    }
  });

  test("mounted: every body-carrying route answers 400, not a crash", async () => {
    vector = new VectorMock();
    vector.addCollection("c1", { dimension: 3 });
    mounted = new LLMock({ port: 0 });
    mounted.mount("/vector", vector);
    await mounted.start();

    for (const [method, path] of BODY_ROUTES) {
      const res = await fetch(`${mounted.url}/vector${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: "null",
      });
      const json = (await res.json()) as { error: Record<string, unknown> };
      expect(`${method} ${path} -> ${res.status}`).toBe(`${method} ${path} -> 400`);
      expect(json.error.message).toBe("Request body must be a JSON object");
      expect(json.error.type).toBe("invalid_request_error");
    }
  });

  test("legal object bodies still work", async () => {
    vector = new VectorMock();
    vector.addCollection("c1", { dimension: 3 });
    vector.onQuery("c1", [{ id: "v1", score: 0.9 }]);
    const base = await vector.start();

    const ok = await fetch(`${base}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vector: [1, 2, 3], topK: 5, namespace: "c1" }),
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { matches: unknown[] }).matches).toHaveLength(1);

    // An empty object is still a JSON object and must not be rejected.
    const empty = await fetch(`${base}/vectors/upsert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(empty.status).toBe(200);

    // A bodyless DELETE is unaffected by the guard.
    const del = await fetch(`${base}/api/v1/collections/c1`, { method: "DELETE" });
    expect(del.status).toBe(200);
  });

  test("the malformed-JSON branch still reports malformed JSON", async () => {
    vector = new VectorMock();
    const base = await vector.start();
    const res = await fetch(`${base}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{oops",
    });
    expect(res.status).toBe(400);
    expect(String(((await res.json()) as { error: string }).error)).toContain("Malformed JSON");
  });
});
