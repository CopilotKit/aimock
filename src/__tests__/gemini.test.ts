import { describe, it, expect, afterEach } from "vitest";
import { GoogleGenAI } from "@google/genai";
import * as http from "node:http";
import type { Fixture } from "../types.js";
import { createServer, type ServerInstance } from "../server.js";
import { geminiToCompletionRequest } from "../gemini.js";
import { SKIPPED_BY_STATE_RE } from "./helpers/strict-matchers.js";

// --- helpers ---

function post(
  url: string,
  body: unknown,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          });
        });
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function postRaw(url: string, raw: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(raw),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
          });
        });
      },
    );
    req.on("error", reject);
    req.write(raw);
    req.end();
  });
}

function parseGeminiSSEChunks(body: string): unknown[] {
  const chunks: unknown[] = [];
  for (const line of body.split("\n")) {
    if (line.startsWith("data: ")) {
      chunks.push(JSON.parse(line.slice(6)));
    }
  }
  return chunks;
}

// --- fixtures ---

const textFixture: Fixture = {
  match: { userMessage: "hello" },
  response: { content: "Hi there!" },
};

const toolFixture: Fixture = {
  match: { userMessage: "weather" },
  response: {
    toolCalls: [
      {
        name: "get_weather",
        arguments: '{"city":"NYC"}',
      },
    ],
  },
};

const multiToolFixture: Fixture = {
  match: { userMessage: "multi-tool" },
  response: {
    toolCalls: [
      { name: "get_weather", arguments: '{"city":"NYC"}' },
      { name: "get_time", arguments: '{"tz":"EST"}' },
    ],
  },
};

// Fixture with `id` pinned on the tool call. Exercises the egress
// counterpart to #196's ingest fix: aimock must surface tc.id on the
// Gemini `functionCall` so clients have an id to preserve across the
// round trip.
const toolFixtureWithId: Fixture = {
  match: { userMessage: "pinned-id" },
  response: {
    toolCalls: [{ id: "call_test_pinned_001", name: "get_weather", arguments: '{"city":"Tokyo"}' }],
  },
};

const multiToolFixtureWithIds: Fixture = {
  match: { userMessage: "pinned-multi" },
  response: {
    toolCalls: [
      { id: "call_test_a", name: "get_weather", arguments: '{"city":"NYC"}' },
      { id: "call_test_b", name: "get_time", arguments: '{"tz":"EST"}' },
    ],
  },
};

const errorFixture: Fixture = {
  match: { userMessage: "fail" },
  response: {
    error: {
      message: "Rate limited",
      type: "RESOURCE_EXHAUSTED",
      code: "rate_limit",
    },
    status: 429,
  },
};

const badResponseFixture: Fixture = {
  match: { userMessage: "badtype" },
  response: { content: 42 } as unknown as Fixture["response"],
};

const allFixtures: Fixture[] = [
  textFixture,
  toolFixture,
  multiToolFixture,
  toolFixtureWithId,
  multiToolFixtureWithIds,
  errorFixture,
  badResponseFixture,
];

// --- tests ---

let instance: ServerInstance | null = null;

afterEach(async () => {
  if (instance) {
    await new Promise<void>((resolve) => {
      instance!.server.close(() => resolve());
    });
    instance = null;
  }
});

// ─── Unit tests: input conversion ────────────────────────────────────────────

describe("geminiToCompletionRequest", () => {
  it("converts user text message", () => {
    const result = geminiToCompletionRequest(
      {
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
      },
      "gemini-2.0-flash",
      false,
    );
    expect(result.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(result.model).toBe("gemini-2.0-flash");
    expect(result.stream).toBe(false);
  });

  it("converts systemInstruction to system message", () => {
    const result = geminiToCompletionRequest(
      {
        systemInstruction: { parts: [{ text: "Be helpful" }] },
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
      },
      "gemini-2.0-flash",
      false,
    );
    expect(result.messages).toEqual([
      { role: "system", content: "Be helpful" },
      { role: "user", content: "hi" },
    ]);
  });

  it("converts model (assistant) messages", () => {
    const result = geminiToCompletionRequest(
      {
        contents: [
          { role: "user", parts: [{ text: "hi" }] },
          { role: "model", parts: [{ text: "hello" }] },
        ],
      },
      "gemini-2.0-flash",
      false,
    );
    expect(result.messages[1]).toEqual({ role: "assistant", content: "hello" });
  });

  it("converts functionCall parts to tool_calls", () => {
    const result = geminiToCompletionRequest(
      {
        contents: [
          {
            role: "model",
            parts: [
              {
                functionCall: {
                  name: "get_weather",
                  args: { city: "NYC" },
                },
              },
            ],
          },
        ],
      },
      "gemini-2.0-flash",
      false,
    );
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("assistant");
    expect(result.messages[0].content).toBeNull();
    expect(result.messages[0].tool_calls).toHaveLength(1);
    expect(result.messages[0].tool_calls![0].id).toBe("call_gemini_get_weather_0");
    expect(result.messages[0].tool_calls![0].function.name).toBe("get_weather");
    expect(result.messages[0].tool_calls![0].function.arguments).toBe('{"city":"NYC"}');
  });

  it("converts functionResponse parts to tool messages", () => {
    const result = geminiToCompletionRequest(
      {
        contents: [
          {
            role: "user",
            parts: [
              {
                functionResponse: {
                  name: "get_weather",
                  response: { temp: 72 },
                },
              },
            ],
          },
        ],
      },
      "gemini-2.0-flash",
      false,
    );
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("tool");
    expect(result.messages[0].content).toBe('{"temp":72}');
    expect(result.messages[0].tool_call_id).toBe("call_gemini_get_weather_0");
  });

  it("extracts model from function parameter, not request body", () => {
    const result = geminiToCompletionRequest(
      {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
      },
      "gemini-1.5-pro",
      true,
    );
    expect(result.model).toBe("gemini-1.5-pro");
    expect(result.stream).toBe(true);
  });

  it("converts functionDeclarations to ToolDefinition", () => {
    const result = geminiToCompletionRequest(
      {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        tools: [
          {
            functionDeclarations: [
              {
                name: "get_weather",
                description: "Get weather",
                parameters: { type: "object" },
              },
            ],
          },
        ],
      },
      "gemini-2.0-flash",
      false,
    );
    expect(result.tools).toEqual([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather",
          parameters: { type: "object" },
        },
      },
    ]);
  });

  it("passes through generationConfig temperature", () => {
    const result = geminiToCompletionRequest(
      {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        generationConfig: { temperature: 0.7 },
      },
      "gemini-2.0-flash",
      false,
    );
    expect(result.temperature).toBe(0.7);
  });

  it("forwards generationConfig.maxOutputTokens as max_tokens", () => {
    const result = geminiToCompletionRequest(
      {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        generationConfig: { maxOutputTokens: 1024 },
      },
      "gemini-2.0-flash",
      false,
    );
    expect(result.max_tokens).toBe(1024);
  });

  it("forwards generationConfig.topP and topK", () => {
    const result = geminiToCompletionRequest(
      {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        generationConfig: { topP: 0.95, topK: 40 },
      },
      "gemini-2.0-flash",
      false,
    );
    expect(result.top_p).toBe(0.95);
    expect(result.top_k).toBe(40);
  });

  it("leaves max_tokens/top_p/top_k undefined when generationConfig omits them", () => {
    const result = geminiToCompletionRequest(
      {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        generationConfig: { temperature: 0.5 },
      },
      "gemini-2.0-flash",
      false,
    );
    expect(result.max_tokens).toBeUndefined();
    expect(result.top_p).toBeUndefined();
    expect(result.top_k).toBeUndefined();
  });

  it("converts multiple functionResponse parts with unique tool_call_ids", () => {
    const result = geminiToCompletionRequest(
      {
        contents: [
          {
            role: "user",
            parts: [
              {
                functionResponse: {
                  name: "search",
                  response: { results: ["cats"] },
                },
              },
              {
                functionResponse: {
                  name: "search",
                  response: { results: ["dogs"] },
                },
              },
            ],
          },
        ],
      },
      "gemini-2.0-flash",
      false,
    );
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe("tool");
    expect(result.messages[1].role).toBe("tool");
    // IDs should be unique even for same function name
    expect(result.messages[0].tool_call_id).toBe("call_gemini_search_0");
    expect(result.messages[1].tool_call_id).toBe("call_gemini_search_1");
    expect(result.messages[0].tool_call_id).not.toBe(result.messages[1].tool_call_id);
  });

  it("preserves functionCall.id from Gemini conversation history", () => {
    const result = geminiToCompletionRequest(
      {
        contents: [
          { role: "user", parts: [{ text: "weather in Tokyo" }] },
          {
            role: "model",
            parts: [
              {
                functionCall: {
                  name: "get_weather",
                  args: { location: "Tokyo" },
                  id: "call_fp_get_weather_001",
                },
              },
            ],
          },
          {
            role: "user",
            parts: [
              {
                functionResponse: {
                  name: "get_weather",
                  response: { temperature: 72 },
                },
              },
            ],
          },
          { role: "user", parts: [{ text: "thanks" }] },
        ],
      },
      "gemini-2.0-flash",
      false,
    );

    const assistantMsg = result.messages.find((m) => m.role === "assistant" && m.tool_calls);
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.tool_calls![0].id).toBe("call_fp_get_weather_001");

    const toolMsg = result.messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.tool_call_id).toBe("call_fp_get_weather_001");
  });

  it("aligns functionCall and functionResponse IDs across a round trip", () => {
    // Model turn: two functionCall parts
    const modelTurn = geminiToCompletionRequest(
      {
        contents: [
          {
            role: "model",
            parts: [
              { functionCall: { name: "search", args: { q: "cats" } } },
              { functionCall: { name: "search", args: { q: "dogs" } } },
            ],
          },
        ],
      },
      "gemini-2.0-flash",
      false,
    );

    // User turn: two functionResponse parts in same order
    const userTurn = geminiToCompletionRequest(
      {
        contents: [
          {
            role: "user",
            parts: [
              { functionResponse: { name: "search", response: { r: "cats" } } },
              { functionResponse: { name: "search", response: { r: "dogs" } } },
            ],
          },
        ],
      },
      "gemini-2.0-flash",
      false,
    );

    // IDs should align: call[0] matches response[0], call[1] matches response[1]
    expect(modelTurn.messages[0].tool_calls![0].id).toBe(userTurn.messages[0].tool_call_id);
    expect(modelTurn.messages[0].tool_calls![1].id).toBe(userTurn.messages[1].tool_call_id);
  });
});

// ─── Integration tests: Gemini non-streaming ────────────────────────────────

describe("POST /v1beta/models/{model}:generateContent (non-streaming)", () => {
  it("returns text response as JSON", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1beta/models/gemini-2.0-flash:generateContent`, {
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");

    const body = JSON.parse(res.body);
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0].content.role).toBe("model");
    expect(body.candidates[0].content.parts[0].text).toBe("Hi there!");
    expect(body.candidates[0].finishReason).toBe("STOP");
    expect(body.candidates[0].index).toBe(0);
    expect(body.usageMetadata).toBeDefined();
  });

  it("returns tool call response with functionCall parts", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1beta/models/gemini-2.0-flash:generateContent`, {
      contents: [{ role: "user", parts: [{ text: "weather" }] }],
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.candidates[0].content.parts[0].functionCall).toBeDefined();
    expect(body.candidates[0].content.parts[0].functionCall.name).toBe("get_weather");
    expect(body.candidates[0].content.parts[0].functionCall.args).toEqual({ city: "NYC" });
    expect(body.candidates[0].finishReason).toBe("FUNCTION_CALL");
  });

  it("returns multiple tool calls as multiple parts", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1beta/models/gemini-2.0-flash:generateContent`, {
      contents: [{ role: "user", parts: [{ text: "multi-tool" }] }],
    });

    const body = JSON.parse(res.body);
    expect(body.candidates[0].content.parts).toHaveLength(2);
    expect(body.candidates[0].content.parts[0].functionCall.name).toBe("get_weather");
    expect(body.candidates[0].content.parts[1].functionCall.name).toBe("get_time");
  });

  it("omits functionCall.id when the fixture does not pin one (backward compatible)", async () => {
    // Fixtures authored before id-preservation existed didn't set tc.id;
    // those must continue to serialize without an id field so the
    // ingest-side fallback generator (`call_gemini_<name>_<i>`) handles
    // them on the next request. Pre-#196 fixtures rely on this.
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1beta/models/gemini-2.0-flash:generateContent`, {
      contents: [{ role: "user", parts: [{ text: "weather" }] }],
    });

    const body = JSON.parse(res.body);
    const fc = body.candidates[0].content.parts[0].functionCall;
    expect(fc.name).toBe("get_weather");
    expect(fc.args).toEqual({ city: "NYC" });
    expect(fc).not.toHaveProperty("id");
  });

  it("surfaces functionCall.id when the fixture pins tc.id", async () => {
    // Egress counterpart to #196's INGEST-direction fix
    // (v1.23.1 — preserve functionCall.id when aimock PARSES an
    // incoming Gemini request). That fix only helps if there's an id in
    // the response body to begin with; without this egress surfacing,
    // aimock emits `{ functionCall: { name, args } }` and clients have
    // nothing to round-trip. Any fixture chain that keys a follow-up on
    // `toolCallId` then falls through to the first-leg `userMessage`
    // matcher, creating an infinite loop on Gemini/ADK integrations.
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1beta/models/gemini-2.0-flash:generateContent`, {
      contents: [{ role: "user", parts: [{ text: "pinned-id" }] }],
    });

    const body = JSON.parse(res.body);
    const fc = body.candidates[0].content.parts[0].functionCall;
    expect(fc.name).toBe("get_weather");
    expect(fc.args).toEqual({ city: "Tokyo" });
    expect(fc.id).toBe("call_test_pinned_001");
  });

  it("surfaces functionCall.id on every tool call when multiple are pinned", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1beta/models/gemini-2.0-flash:generateContent`, {
      contents: [{ role: "user", parts: [{ text: "pinned-multi" }] }],
    });

    const body = JSON.parse(res.body);
    const parts = body.candidates[0].content.parts;
    expect(parts).toHaveLength(2);
    expect(parts[0].functionCall.name).toBe("get_weather");
    expect(parts[0].functionCall.id).toBe("call_test_a");
    expect(parts[1].functionCall.name).toBe("get_time");
    expect(parts[1].functionCall.id).toBe("call_test_b");
  });
});

// ─── Integration tests: Gemini streaming ────────────────────────────────────

describe("POST /v1beta/models/{model}:streamGenerateContent (streaming)", () => {
  it("streams text response as SSE", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1beta/models/gemini-2.0-flash:streamGenerateContent`, {
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream");

    const chunks = parseGeminiSSEChunks(res.body) as {
      candidates: {
        content: { role: string; parts: { text?: string }[] };
        finishReason?: string;
      }[];
      usageMetadata?: unknown;
    }[];

    expect(chunks.length).toBeGreaterThan(0);

    // All chunks have model role
    for (const chunk of chunks) {
      expect(chunk.candidates[0].content.role).toBe("model");
    }

    // Reconstruct content from text parts
    const fullText = chunks.map((c) => c.candidates[0].content.parts[0].text ?? "").join("");
    expect(fullText).toBe("Hi there!");

    // Only last chunk has finishReason
    const lastChunk = chunks[chunks.length - 1];
    expect(lastChunk.candidates[0].finishReason).toBe("STOP");
    expect(lastChunk.usageMetadata).toBeDefined();

    // Non-last chunks have no finishReason
    if (chunks.length > 1) {
      expect(chunks[0].candidates[0].finishReason).toBeUndefined();
    }

    // No [DONE] or event: prefix
    expect(res.body).not.toContain("[DONE]");
    expect(res.body).not.toContain("event:");
  });

  it("streams tool calls as SSE", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1beta/models/gemini-2.0-flash:streamGenerateContent`, {
      contents: [{ role: "user", parts: [{ text: "weather" }] }],
    });

    expect(res.status).toBe(200);

    const chunks = parseGeminiSSEChunks(res.body) as {
      candidates: {
        content: {
          parts: { functionCall?: { name: string; args: unknown; id?: string } }[];
        };
        finishReason?: string;
      }[];
    }[];

    // Tool calls come as a single chunk
    expect(chunks).toHaveLength(1);
    expect(chunks[0].candidates[0].content.parts[0].functionCall).toBeDefined();
    expect(chunks[0].candidates[0].content.parts[0].functionCall!.name).toBe("get_weather");
    expect(chunks[0].candidates[0].content.parts[0].functionCall!.args).toEqual({
      city: "NYC",
    });
    // Fixture didn't pin an id, so the streamed functionCall should
    // omit `id` too — same backward-compat contract as the buffered path.
    expect(chunks[0].candidates[0].content.parts[0].functionCall!).not.toHaveProperty("id");
    expect(chunks[0].candidates[0].finishReason).toBe("FUNCTION_CALL");
  });

  it("streams functionCall.id when the fixture pins tc.id", async () => {
    // Streaming and buffered tool-call responses both flow through
    // `parseToolCallPart`. This test guards against a future regression
    // where streaming gets its own serializer that drops the id.
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1beta/models/gemini-2.0-flash:streamGenerateContent`, {
      contents: [{ role: "user", parts: [{ text: "pinned-id" }] }],
    });

    expect(res.status).toBe(200);

    const chunks = parseGeminiSSEChunks(res.body) as {
      candidates: {
        content: {
          parts: { functionCall?: { name: string; args: unknown; id?: string } }[];
        };
      }[];
    }[];

    expect(chunks).toHaveLength(1);
    const fc = chunks[0].candidates[0].content.parts[0].functionCall;
    expect(fc).toBeDefined();
    expect(fc!.id).toBe("call_test_pinned_001");
  });

  it("uses fixture chunkSize for text streaming", async () => {
    const bigChunkFixture: Fixture = {
      match: { userMessage: "bigchunk" },
      response: { content: "ABCDEFGHIJ" },
      chunkSize: 5,
    };
    instance = await createServer([bigChunkFixture], { chunkSize: 2 });
    const res = await post(`${instance.url}/v1beta/models/gemini-2.0-flash:streamGenerateContent`, {
      contents: [{ role: "user", parts: [{ text: "bigchunk" }] }],
    });

    const chunks = parseGeminiSSEChunks(res.body) as {
      candidates: { content: { parts: { text: string }[] } }[];
    }[];
    // 10 chars / chunkSize 5 = 2 chunks
    expect(chunks).toHaveLength(2);
    expect(chunks[0].candidates[0].content.parts[0].text).toBe("ABCDE");
    expect(chunks[1].candidates[0].content.parts[0].text).toBe("FGHIJ");
  });
});

// ─── Error handling ─────────────────────────────────────────────────────────

describe("Gemini error handling", () => {
  it("returns error fixture with correct status", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1beta/models/gemini-2.0-flash:generateContent`, {
      contents: [{ role: "user", parts: [{ text: "fail" }] }],
    });

    expect(res.status).toBe(429);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("Rate limited");
  });

  it("returns 404 when no fixture matches", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1beta/models/gemini-2.0-flash:generateContent`, {
      contents: [{ role: "user", parts: [{ text: "unknown" }] }],
    });

    expect(res.status).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("No fixture matched");
  });

  it("returns 400 for malformed JSON", async () => {
    instance = await createServer(allFixtures);
    const res = await postRaw(
      `${instance.url}/v1beta/models/gemini-2.0-flash:generateContent`,
      "{not valid",
    );

    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.message).toMatch(/^Malformed JSON body: /);
  });

  it("returns 500 for unknown response type", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1beta/models/gemini-2.0-flash:generateContent`, {
      contents: [{ role: "user", parts: [{ text: "badtype" }] }],
    });

    expect(res.status).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error.message).toContain("did not match any known type");
  });
});

// ─── Error format conformance ────────────────────────────────────────────────

describe("Gemini error format conformance", () => {
  it("returns error in Gemini format: { error: { code, message, status } }", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1beta/models/gemini-2.0-flash:generateContent`, {
      contents: [{ role: "user", parts: [{ text: "fail" }] }],
    });

    expect(res.status).toBe(429);
    const body = JSON.parse(res.body);
    // Gemini wraps errors as { error: { code, message, status } }
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe(429);
    expect(body.error.message).toBe("Rate limited");
    expect(body.error.status).toBe("RESOURCE_EXHAUSTED");
    // Should NOT have OpenAI-style fields
    expect(body.error.type).toBeUndefined();
    expect(body.status).toBeUndefined();
  });
});

// ─── Error field preservation ────────────────────────────────────────────────

describe("Gemini error field preservation", () => {
  it("error type and code fields are preserved", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1beta/models/gemini-2.0-flash:generateContent`, {
      contents: [{ role: "user", parts: [{ text: "fail" }] }],
    });

    expect(res.status).toBe(429);
    const body = JSON.parse(res.body);
    // Gemini format: { error: { code: <httpStatus>, message, status: <type> } }
    expect(body.error.code).toBe(429);
    expect(body.error.message).toBe("Rate limited");
    expect(body.error.status).toBe("RESOURCE_EXHAUSTED");
  });
});

// ─── Routing ────────────────────────────────────────────────────────────────

describe("Gemini routing", () => {
  it("returns 404 for GET on Gemini endpoint", async () => {
    instance = await createServer(allFixtures);
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const parsed = new URL(instance!.url);
      const req = http.request(
        {
          hostname: parsed.hostname,
          port: parsed.port,
          path: "/v1beta/models/gemini-2.0-flash:generateContent",
          method: "GET",
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString(),
            });
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 for unknown Gemini-like path", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1beta/models/gemini-2.0-flash:unknownAction`, {
      contents: [],
    });
    expect(res.status).toBe(404);
  });

  it("extracts model name from URL path", async () => {
    instance = await createServer(allFixtures);
    await post(`${instance.url}/v1beta/models/gemini-1.5-pro:generateContent`, {
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
    });

    const entry = instance.journal.getLast();
    expect(entry).not.toBeNull();
    expect(entry!.body!.model).toBe("gemini-1.5-pro");
  });
});

// ─── Journal ────────────────────────────────────────────────────────────────

describe("Gemini journal", () => {
  it("records successful text response", async () => {
    instance = await createServer(allFixtures);
    await post(`${instance.url}/v1beta/models/gemini-2.0-flash:generateContent`, {
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
    });

    expect(instance.journal.size).toBe(1);
    const entry = instance.journal.getLast();
    expect(entry!.path).toBe("/v1beta/models/gemini-2.0-flash:generateContent");
    expect(entry!.response.status).toBe(200);
    expect(entry!.response.fixture).toBe(textFixture);
  });

  it("records unmatched response with null fixture", async () => {
    instance = await createServer(allFixtures);
    await post(`${instance.url}/v1beta/models/gemini-2.0-flash:generateContent`, {
      contents: [{ role: "user", parts: [{ text: "nomatch" }] }],
    });

    const entry = instance.journal.getLast();
    expect(entry!.response.status).toBe(404);
    expect(entry!.response.fixture).toBeNull();
  });
});

// ─── Error fixture without type field ─────────────────────────────────────────

describe("Gemini error fixture without type", () => {
  it("falls back to ERROR status when error.type is undefined", async () => {
    const noTypeFixture: Fixture = {
      match: { userMessage: "no-type-error" },
      response: {
        error: {
          message: "Something went wrong",
        },
        status: 500,
      },
    };
    instance = await createServer([noTypeFixture]);
    const res = await post(`${instance.url}/v1beta/models/gemini-2.0-flash:generateContent`, {
      contents: [{ role: "user", parts: [{ text: "no-type-error" }] }],
    });

    expect(res.status).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("Something went wrong");
    expect(body.error.status).toBe("ERROR");
  });
});

// ─── CORS ───────────────────────────────────────────────────────────────────

describe("Gemini CORS", () => {
  it("includes CORS headers", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1beta/models/gemini-2.0-flash:generateContent`, {
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
    });

    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });
});

// ─── Input conversion: additional branch coverage ────────────────────────────

describe("geminiToCompletionRequest — additional branches", () => {
  it("defaults role to 'user' when content.role is missing", () => {
    const result = geminiToCompletionRequest(
      {
        contents: [{ parts: [{ text: "no role" }] }],
      },
      "gemini-2.0-flash",
      false,
    );
    // role defaults to "user"
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].content).toBe("no role");
  });

  it("converts functionResponse.response that is a string", () => {
    const result = geminiToCompletionRequest(
      {
        contents: [
          {
            role: "user",
            parts: [
              {
                functionResponse: {
                  name: "search",
                  response: "plain string response" as unknown as Record<string, unknown>,
                },
              },
            ],
          },
        ],
      },
      "gemini-2.0-flash",
      false,
    );
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("tool");
    // String response is used directly
    expect(result.messages[0].content).toBe("plain string response");
  });

  it("includes text parts alongside functionResponse parts", () => {
    const result = geminiToCompletionRequest(
      {
        contents: [
          {
            role: "user",
            parts: [
              {
                functionResponse: {
                  name: "search",
                  response: { data: "result" },
                },
              },
              { text: "Additional context" },
            ],
          },
        ],
      },
      "gemini-2.0-flash",
      false,
    );
    // functionResponse → tool message, then text → user message
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe("tool");
    expect(result.messages[1].role).toBe("user");
    expect(result.messages[1].content).toBe("Additional context");
  });

  it("handles tools with empty functionDeclarations", () => {
    const result = geminiToCompletionRequest(
      {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        tools: [{}],
      },
      "gemini-2.0-flash",
      false,
    );
    // No functionDeclarations → tools should be undefined
    expect(result.tools).toBeUndefined();
  });

  it("handles empty systemInstruction text", () => {
    const result = geminiToCompletionRequest(
      {
        systemInstruction: { parts: [{ functionCall: { name: "x", args: {} } }] },
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
      },
      "gemini-2.0-flash",
      false,
    );
    // systemInstruction has no text parts → no system message
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("user");
  });
});

// ─── Streaming: empty content ────────────────────────────────────────────────

describe("Gemini streaming empty content", () => {
  it("streams a single empty-text chunk for empty content", async () => {
    const emptyFixture: Fixture = {
      match: { userMessage: "empty" },
      response: { content: "" },
    };
    instance = await createServer([emptyFixture]);
    const res = await post(`${instance.url}/v1beta/models/gemini-2.0-flash:streamGenerateContent`, {
      contents: [{ role: "user", parts: [{ text: "empty" }] }],
    });

    expect(res.status).toBe(200);

    const chunks = parseGeminiSSEChunks(res.body) as {
      candidates: {
        content: { parts: { text: string }[] };
        finishReason?: string;
      }[];
      usageMetadata?: unknown;
    }[];

    // Empty content produces a single chunk with empty text
    expect(chunks).toHaveLength(1);
    expect(chunks[0].candidates[0].content.parts[0].text).toBe("");
    expect(chunks[0].candidates[0].finishReason).toBe("STOP");
    expect(chunks[0].usageMetadata).toBeDefined();
  });
});

// ─── Tool call with malformed JSON arguments ─────────────────────────────────

describe("Gemini tool call malformed arguments", () => {
  it("non-streaming: falls back to empty args for malformed JSON", async () => {
    const malformedToolFixture: Fixture = {
      match: { userMessage: "malformed-args" },
      response: {
        toolCalls: [{ name: "broken_tool", arguments: "{not valid json}" }],
      },
    };
    instance = await createServer([malformedToolFixture]);
    const res = await post(`${instance.url}/v1beta/models/gemini-2.0-flash:generateContent`, {
      contents: [{ role: "user", parts: [{ text: "malformed-args" }] }],
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.candidates[0].content.parts[0].functionCall.name).toBe("broken_tool");
    // Falls back to empty args
    expect(body.candidates[0].content.parts[0].functionCall.args).toEqual({});
    expect(body.candidates[0].finishReason).toBe("FUNCTION_CALL");
  });

  it("non-streaming: uses empty object for empty arguments string", async () => {
    const emptyArgsFixture: Fixture = {
      match: { userMessage: "empty-args" },
      response: {
        toolCalls: [{ name: "no_args_tool", arguments: "" }],
      },
    };
    instance = await createServer([emptyArgsFixture]);
    const res = await post(`${instance.url}/v1beta/models/gemini-2.0-flash:generateContent`, {
      contents: [{ role: "user", parts: [{ text: "empty-args" }] }],
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.candidates[0].content.parts[0].functionCall.name).toBe("no_args_tool");
    expect(body.candidates[0].content.parts[0].functionCall.args).toEqual({});
  });

  it("streaming: falls back to empty args for malformed JSON", async () => {
    const malformedToolFixture: Fixture = {
      match: { userMessage: "malformed-stream" },
      response: {
        toolCalls: [{ name: "broken_tool", arguments: "{{bad}}" }],
      },
    };
    instance = await createServer([malformedToolFixture]);
    const res = await post(`${instance.url}/v1beta/models/gemini-2.0-flash:streamGenerateContent`, {
      contents: [{ role: "user", parts: [{ text: "malformed-stream" }] }],
    });

    expect(res.status).toBe(200);
    const chunks = parseGeminiSSEChunks(res.body) as {
      candidates: {
        content: { parts: { functionCall: { name: string; args: unknown } }[] };
      }[];
    }[];

    expect(chunks).toHaveLength(1);
    expect(chunks[0].candidates[0].content.parts[0].functionCall.name).toBe("broken_tool");
    expect(chunks[0].candidates[0].content.parts[0].functionCall.args).toEqual({});
  });

  it("streaming: uses empty object for empty arguments string", async () => {
    const emptyArgsFixture: Fixture = {
      match: { userMessage: "empty-args-stream" },
      response: {
        toolCalls: [{ name: "no_args_tool", arguments: "" }],
      },
    };
    instance = await createServer([emptyArgsFixture]);
    const res = await post(`${instance.url}/v1beta/models/gemini-2.0-flash:streamGenerateContent`, {
      contents: [{ role: "user", parts: [{ text: "empty-args-stream" }] }],
    });

    expect(res.status).toBe(200);
    const chunks = parseGeminiSSEChunks(res.body) as {
      candidates: {
        content: { parts: { functionCall: { name: string; args: unknown } }[] };
      }[];
    }[];

    expect(chunks).toHaveLength(1);
    expect(chunks[0].candidates[0].content.parts[0].functionCall.name).toBe("no_args_tool");
    expect(chunks[0].candidates[0].content.parts[0].functionCall.args).toEqual({});
  });
});

// ─── Strict mode ─────────────────────────────────────────────────────────────

describe("Gemini strict mode", () => {
  it("returns 503 in strict mode when no fixture matches", async () => {
    instance = await createServer(allFixtures, { strict: true });
    const res = await post(`${instance.url}/v1beta/models/gemini-2.0-flash:generateContent`, {
      contents: [{ role: "user", parts: [{ text: "nomatch-strict" }] }],
    });

    expect(res.status).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("Strict mode: no fixture matched");
    expect(body.error.status).toBe("UNAVAILABLE");
  });

  it("returns the skipped-by-state message when a sequence-exhausted fixture is replayed", async () => {
    const seqFixture: Fixture = {
      match: { userMessage: "hello", sequenceIndex: 0 },
      response: { content: "Hi there!" },
    };
    instance = await createServer([seqFixture], { strict: true });
    // First call consumes the sequenceIndex:0 fixture (count → 1).
    const first = await post(`${instance.url}/v1beta/models/gemini-2.0-flash:generateContent`, {
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
    });
    expect(first.status).toBe(200);
    // Replay: shape still matches but the fixture is skipped by sequence state.
    const res = await post(`${instance.url}/v1beta/models/gemini-2.0-flash:generateContent`, {
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
    });
    expect(res.status).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.error.message).toMatch(SKIPPED_BY_STATE_RE);
  });
});

// ─── Streaming interruptions ─────────────────────────────────────────────────

describe("Gemini streaming interruptions", () => {
  it("text: records interruption in journal when stream is truncated", async () => {
    const interruptFixture: Fixture = {
      match: { userMessage: "interrupt-text" },
      response: { content: "ABCDEFGHIJKLMNOP" },
      chunkSize: 1,
      latency: 10,
      truncateAfterChunks: 3,
    };
    instance = await createServer([interruptFixture]);

    // The server destroys the connection mid-stream, so the client will get
    // a socket error. Use a race with a timeout to avoid hanging.
    const parsed = new URL(instance.url);
    await new Promise<void>((resolve) => {
      const data = JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "interrupt-text" }] }],
      });
      const req = http.request(
        {
          hostname: parsed.hostname,
          port: parsed.port,
          path: "/v1beta/models/gemini-2.0-flash:streamGenerateContent",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(data),
          },
        },
        (res) => {
          res.on("data", () => {});
          res.on("end", () => resolve());
          res.on("error", () => resolve());
          res.on("close", () => resolve());
        },
      );
      req.on("error", () => resolve());
      req.write(data);
      req.end();
    });

    // Wait briefly for the server to finish processing
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Journal should record interruption
    const entry = instance.journal.getLast();
    expect(entry).not.toBeNull();
    expect(entry!.response.interrupted).toBe(true);
    expect(entry!.response.interruptReason).toBe("truncateAfterChunks");
  });

  it("tool call: records interruption in journal when disconnected", async () => {
    const interruptToolFixture: Fixture = {
      match: { userMessage: "interrupt-tool" },
      response: {
        toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
      },
      disconnectAfterMs: 1,
      latency: 100,
    };
    instance = await createServer([interruptToolFixture]);

    try {
      await post(`${instance.url}/v1beta/models/gemini-2.0-flash:streamGenerateContent`, {
        contents: [{ role: "user", parts: [{ text: "interrupt-tool" }] }],
      });
    } catch {
      // Expected — socket hang up
    }

    // Wait briefly for the server to finish processing
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Journal should record interruption
    const entry = instance.journal.getLast();
    expect(entry).not.toBeNull();
    expect(entry!.response.interrupted).toBe(true);
    expect(entry!.response.interruptReason).toBe("disconnectAfterMs");
  });
});

describe("Gemini model-generated files", () => {
  const png = "iVBORw0KGgo=";
  const fileFixture: Fixture = {
    match: { userMessage: "draw" },
    response: { content: "Here is your image.", files: [{ mimeType: "image/png", data: png }] },
  };

  it("non-streaming emits inlineData parts before the text", async () => {
    instance = await createServer([fileFixture]);
    const res = await post(`${instance.url}/v1beta/models/gemini-2.0-flash:generateContent`, {
      contents: [{ role: "user", parts: [{ text: "draw" }] }],
    });
    const parts = JSON.parse(res.body).candidates[0].content.parts;
    expect(parts).toEqual([
      { inlineData: { mimeType: "image/png", data: png } },
      { text: "Here is your image." },
    ]);
  });

  it("streaming emits an inlineData chunk before the text chunks", async () => {
    instance = await createServer([fileFixture]);
    const res = await post(`${instance.url}/v1beta/models/gemini-2.0-flash:streamGenerateContent`, {
      contents: [{ role: "user", parts: [{ text: "draw" }] }],
    });
    const chunks = parseGeminiSSEChunks(res.body) as {
      candidates: { content: { parts: { text?: string; inlineData?: unknown }[] } }[];
    }[];
    expect(chunks[0].candidates[0].content.parts).toEqual([
      { inlineData: { mimeType: "image/png", data: png } },
    ]);
    const text = chunks
      .slice(1)
      .map((c) => c.candidates[0].content.parts[0].text ?? "")
      .join("");
    expect(text).toBe("Here is your image.");
  });

  // Combined content+toolCalls turns (legacy and `blocks`) used to drop `files`
  // on both wires; they must emit the same leading inlineData part as text turns.
  type FilesChunk = {
    candidates: {
      content: {
        parts: { text?: string; inlineData?: unknown; functionCall?: { name: string } }[];
      };
    }[];
  };
  const combinedFileFixtures: Fixture[] = [
    {
      match: { userMessage: "draw-empty-tools" },
      response: {
        content: "Here is your image.",
        toolCalls: [],
        files: [{ mimeType: "image/png", data: png }],
      },
    },
    {
      match: { userMessage: "draw-and-save" },
      response: {
        content: "Saving it.",
        toolCalls: [{ name: "save", arguments: '{"x":1}' }],
        files: [{ mimeType: "image/png", data: png }],
      },
    },
    {
      match: { userMessage: "draw-blocks" },
      response: {
        blocks: [
          { type: "toolCall", name: "save", arguments: '{"x":1}' },
          { type: "text", text: "Saved it." },
        ],
        files: [{ mimeType: "image/png", data: png }],
      },
    },
  ];

  it.each([
    ["draw-empty-tools", [{ text: "Here is your image." }]],
    ["draw-and-save", [{ text: "Saving it." }, { functionCall: { name: "save", args: { x: 1 } } }]],
    ["draw-blocks", [{ functionCall: { name: "save", args: { x: 1 } } }, { text: "Saved it." }]],
  ])("non-streaming combined turn %s emits inlineData before its parts", async (msg, rest) => {
    instance = await createServer(combinedFileFixtures);
    const res = await post(`${instance.url}/v1beta/models/gemini-2.0-flash:generateContent`, {
      contents: [{ role: "user", parts: [{ text: msg }] }],
    });
    const parts = JSON.parse(res.body).candidates[0].content.parts;
    expect(parts).toEqual([{ inlineData: { mimeType: "image/png", data: png } }, ...rest]);
  });

  it.each([
    ["draw-empty-tools", "Here is your image.", []],
    ["draw-and-save", "Saving it.", ["save"]],
    ["draw-blocks", "Saved it.", ["save"]],
  ])("streaming combined turn %s emits an inlineData chunk first", async (msg, text, toolNames) => {
    instance = await createServer(combinedFileFixtures);
    const res = await post(`${instance.url}/v1beta/models/gemini-2.0-flash:streamGenerateContent`, {
      contents: [{ role: "user", parts: [{ text: msg }] }],
    });
    const chunks = parseGeminiSSEChunks(res.body) as FilesChunk[];
    expect(chunks[0].candidates[0].content.parts).toEqual([
      { inlineData: { mimeType: "image/png", data: png } },
    ]);
    const rest = chunks.slice(1).flatMap((c) => c.candidates[0].content.parts);
    expect(rest.some((p) => p.inlineData !== undefined)).toBe(false);
    expect(rest.map((p) => p.text ?? "").join("")).toBe(text);
    expect(rest.flatMap((p) => (p.functionCall ? [p.functionCall.name] : []))).toEqual(toolNames);
  });

  // Tool-only turns (no text) keep their files too: after any thought part,
  // before the functionCall parts, matching the text and combined shapes.
  const toolOnlyFileFixtures: Fixture[] = [
    {
      match: { userMessage: "plain-tool-file" },
      response: {
        toolCalls: [{ name: "save", arguments: '{"x":1}' }],
        files: [{ mimeType: "image/png", data: png }],
      },
    },
    {
      match: { userMessage: "thinking-tool-file" },
      response: {
        reasoning: "Plan.",
        toolCalls: [{ name: "save", arguments: '{"x":1}' }],
        files: [{ mimeType: "image/png", data: png }],
      },
    },
  ];

  it.each([
    ["plain-tool-file", []],
    ["thinking-tool-file", [{ text: "Plan.", thought: true }]],
  ])("non-streaming tool-only turn %s emits inlineData before functionCall", async (msg, lead) => {
    instance = await createServer(toolOnlyFileFixtures);
    const res = await post(`${instance.url}/v1beta/models/gemini-2.5-flash:generateContent`, {
      contents: [{ role: "user", parts: [{ text: msg }] }],
    });
    const parts = JSON.parse(res.body).candidates[0].content.parts;
    expect(parts).toEqual([
      ...lead,
      { inlineData: { mimeType: "image/png", data: png } },
      { functionCall: { name: "save", args: { x: 1 } } },
    ]);
  });

  it.each([
    ["plain-tool-file", []],
    ["thinking-tool-file", [[{ text: "Plan.", thought: true }]]],
  ])(
    "streaming tool-only turn %s emits an inlineData chunk before functionCall",
    async (msg, lead) => {
      instance = await createServer(toolOnlyFileFixtures);
      const res = await post(
        `${instance.url}/v1beta/models/gemini-2.5-flash:streamGenerateContent`,
        {
          contents: [{ role: "user", parts: [{ text: msg }] }],
        },
      );
      const chunks = parseGeminiSSEChunks(res.body) as FilesChunk[];
      expect(chunks.map((c) => c.candidates[0].content.parts)).toEqual([
        ...lead,
        [{ inlineData: { mimeType: "image/png", data: png } }],
        [{ functionCall: { name: "save", args: { x: 1 } } }],
      ]);
    },
  );

  it("fixtures without files emit no inlineData on combined turns", async () => {
    instance = await createServer([
      {
        match: { userMessage: "plain-combined" },
        response: { content: "Saving it.", toolCalls: [{ name: "save", arguments: "{}" }] },
      },
    ]);
    const res = await post(`${instance.url}/v1beta/models/gemini-2.0-flash:generateContent`, {
      contents: [{ role: "user", parts: [{ text: "plain-combined" }] }],
    });
    expect(res.body).not.toContain("inlineData");
  });

  it("fixtures without files emit no inlineData on tool-only turns", async () => {
    instance = await createServer([
      {
        match: { userMessage: "plain-tool" },
        response: { toolCalls: [{ name: "save", arguments: "{}" }] },
      },
    ]);
    for (const ep of ["generateContent", "streamGenerateContent"]) {
      const res = await post(`${instance.url}/v1beta/models/gemini-2.0-flash:${ep}`, {
        contents: [{ role: "user", parts: [{ text: "plain-tool" }] }],
      });
      expect(res.body).not.toContain("inlineData");
    }
  });
});

describe("Gemini citations (groundingMetadata)", () => {
  const citeFixture: Fixture = {
    match: { userMessage: "cite-me" },
    response: {
      // "é" is two UTF-8 bytes, so byte offsets differ from character offsets.
      content: "Café Mastra is a framework.",
      citations: [
        { url: "https://mastra.ai", title: "Mastra", startIndex: 5, endIndex: 11 },
        { url: "https://mastra.ai/docs" },
      ],
    },
  };
  const expected = {
    groundingChunks: [
      { web: { uri: "https://mastra.ai", title: "Mastra" } },
      { web: { uri: "https://mastra.ai/docs", title: "https://mastra.ai/docs" } },
    ],
    groundingSupports: [
      {
        segment: { partIndex: 0, startIndex: 6, endIndex: 12, text: "Mastra" },
        groundingChunkIndices: [0],
      },
      {
        segment: { partIndex: 0, startIndex: 0, endIndex: 28, text: "Café Mastra is a framework." },
        groundingChunkIndices: [1],
      },
    ],
  };
  type GroundedChunk = {
    candidates: {
      content?: { parts: { text?: string }[] };
      finishReason?: string;
      groundingMetadata?: unknown;
    }[];
  };

  it("non-streaming candidate carries groundingMetadata with byte offsets", async () => {
    instance = await createServer([citeFixture]);
    const res = await post(`${instance.url}/v1beta/models/gemini-2.0-flash:generateContent`, {
      contents: [{ role: "user", parts: [{ text: "cite-me" }] }],
    });
    expect(JSON.parse(res.body).candidates[0].groundingMetadata).toEqual(expected);
  });

  it("streaming grounds each chunk with byte offsets into its own text part", async () => {
    instance = await createServer([citeFixture]);
    const res = await post(`${instance.url}/v1beta/models/gemini-2.0-flash:streamGenerateContent`, {
      contents: [{ role: "user", parts: [{ text: "cite-me" }] }],
    });
    const chunks = parseGeminiSSEChunks(res.body) as GroundedChunk[];
    // The default chunkSize (20) streams "Café Mastra is a fra" then "mework.".
    expect(chunks.map((c) => c.candidates[0].content?.parts[0].text)).toEqual([
      "Café Mastra is a fra",
      "mework.",
    ]);
    expect(chunks[1].candidates[0].finishReason).toBe("STOP");
    const { groundingChunks } = expected;
    expect(chunks.map((c) => c.candidates[0].groundingMetadata)).toEqual([
      {
        groundingChunks,
        groundingSupports: [
          {
            segment: { partIndex: 0, startIndex: 6, endIndex: 12, text: "Mastra" },
            groundingChunkIndices: [0],
          },
          {
            segment: { partIndex: 0, startIndex: 0, endIndex: 21, text: "Café Mastra is a fra" },
            groundingChunkIndices: [1],
          },
        ],
      },
      {
        groundingChunks,
        groundingSupports: [
          {
            segment: { partIndex: 0, startIndex: 0, endIndex: 7, text: "mework." },
            groundingChunkIndices: [1],
          },
        ],
      },
    ]);
  });

  it.each([
    [
      "legacy",
      0,
      {
        content: "Checking.",
        toolCalls: [{ name: "lookup", arguments: "{}" }],
        citations: [{ url: "https://example.com" }],
      },
      "FUNCTION_CALL",
    ],
    [
      "blocks",
      1,
      {
        blocks: [
          { type: "toolCall" as const, name: "lookup", arguments: "{}" },
          { type: "text" as const, text: "Checking." },
        ],
        citations: [{ url: "https://example.com" }],
      },
      "FUNCTION_CALL",
    ],
  ])(
    "content+toolCalls (%s) carries groundingMetadata on both modes",
    async (_name, textPart, response, finishReason) => {
      instance = await createServer([{ match: { userMessage: "cite-tools" }, response }]);
      const want = (partIndex: number) => ({
        groundingChunks: [{ web: { uri: "https://example.com", title: "https://example.com" } }],
        groundingSupports: [
          {
            segment: { partIndex, startIndex: 0, endIndex: 9, text: "Checking." },
            groundingChunkIndices: [0],
          },
        ],
      });
      const res = await post(`${instance.url}/v1beta/models/gemini-2.0-flash:generateContent`, {
        contents: [{ role: "user", parts: [{ text: "cite-tools" }] }],
      });
      expect(JSON.parse(res.body).candidates[0].groundingMetadata).toEqual(want(textPart));
      expect(JSON.parse(res.body).candidates[0].finishReason).toBe(finishReason);
      const streamed = await post(
        `${instance.url}/v1beta/models/gemini-2.0-flash:streamGenerateContent`,
        { contents: [{ role: "user", parts: [{ text: "cite-tools" }] }] },
      );
      const chunks = parseGeminiSSEChunks(streamed.body) as GroundedChunk[];
      // The stream finishes with the fixture's finish reason. The grounded
      // chunk is the text chunk, which is not always the finishing chunk.
      expect(chunks[chunks.length - 1].candidates[0].finishReason).toBe(finishReason);
      const grounded = chunks.filter((c) => c.candidates[0].groundingMetadata !== undefined);
      expect(grounded).toHaveLength(1);
      // The grounded chunk carries the text the offsets refer to, as part 0.
      expect(grounded[0].candidates[0].content?.parts[0].text).toBe("Checking.");
      expect(grounded[0].candidates[0].groundingMetadata).toEqual(want(0));
    },
  );

  it("skips file citations, which grounding metadata has no form for (both modes)", async () => {
    instance = await createServer([
      {
        match: { userMessage: "cite-file" },
        response: {
          content: "Hello.",
          citations: [
            { type: "file", fileId: "file-abc123", filename: "plan.pdf" },
            { url: "https://example.com" },
          ],
        },
      },
      {
        match: { userMessage: "file-only" },
        response: {
          content: "Hello.",
          citations: [{ type: "file", fileId: "file-abc123", filename: "plan.pdf" }],
        },
      },
    ]);
    const want = {
      groundingChunks: [{ web: { uri: "https://example.com", title: "https://example.com" } }],
      groundingSupports: [
        {
          segment: { partIndex: 0, startIndex: 0, endIndex: 6, text: "Hello." },
          groundingChunkIndices: [0],
        },
      ],
    };
    const res = await post(`${instance.url}/v1beta/models/gemini-2.0-flash:generateContent`, {
      contents: [{ role: "user", parts: [{ text: "cite-file" }] }],
    });
    expect(JSON.parse(res.body).candidates[0].groundingMetadata).toEqual(want);
    const streamed = await post(
      `${instance.url}/v1beta/models/gemini-2.0-flash:streamGenerateContent`,
      { contents: [{ role: "user", parts: [{ text: "cite-file" }] }] },
    );
    const grounded = (parseGeminiSSEChunks(streamed.body) as GroundedChunk[]).filter(
      (c) => c.candidates[0].groundingMetadata !== undefined,
    );
    expect(grounded.map((c) => c.candidates[0].groundingMetadata)).toEqual([want]);

    for (const path of ["generateContent", "streamGenerateContent"]) {
      const fileOnly = await post(`${instance.url}/v1beta/models/gemini-2.0-flash:${path}`, {
        contents: [{ role: "user", parts: [{ text: "file-only" }] }],
      });
      expect(fileOnly.body).not.toContain("groundingMetadata");
    }
  });

  it.each([
    [
      "generateContent",
      '{"candidates":[{"content":{"role":"model","parts":[{"text":"hi"}]},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":0,"candidatesTokenCount":0,"totalTokenCount":0}}',
    ],
    [
      "streamGenerateContent",
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"hi"}]},"index":0,"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":0,"candidatesTokenCount":0,"totalTokenCount":0}}\n\n',
    ],
  ])(
    "omitting citations leaves :%s byte-identical to the no-citations baseline",
    async (method, baseline) => {
      instance = await createServer([
        { match: { userMessage: "plain" }, response: { content: "hi" } },
      ]);
      const res = await post(`${instance.url}/v1beta/models/gemini-2.0-flash:${method}`, {
        contents: [{ role: "user", parts: [{ text: "plain" }] }],
      });
      expect(res.body).toBe(baseline);
    },
  );
});

// `groundingSupports[].segment.partIndex` must name the text part the byte
// offsets refer to, within the parts of the candidate that carries the
// grounding. Leading thought and inlineData parts shift that index, and a
// trailing functionCall part must never be the one it names.
describe("Gemini citations — segment.partIndex", () => {
  type Part = { text?: string; thought?: boolean; inlineData?: unknown; functionCall?: unknown };
  type Support = {
    segment: { partIndex?: number; startIndex: number; endIndex: number; text: string };
    groundingChunkIndices: number[];
  };
  type Candidate = {
    content?: { parts: Part[] };
    finishReason?: string;
    groundingMetadata?: { groundingSupports: Support[] };
  };
  type Body = { candidates: Candidate[] };

  const png = "iVBORw0KGgo=";
  const citations = [
    { url: "https://mastra.ai", title: "Mastra", startIndex: 5, endIndex: 11 },
    { url: "https://mastra.ai/docs" },
  ];
  // Byte offsets of "Mastra" (after the two-byte "é") and of the whole text.
  const segments = [
    { startIndex: 6, endIndex: 12, text: "Mastra" },
    { startIndex: 0, endIndex: 28, text: "Café Mastra is a framework." },
  ];
  const content = "Café Mastra is a framework.";

  async function nonStreaming(userMessage: string): Promise<Candidate> {
    const res = await post(`${instance!.url}/v1beta/models/gemini-2.5-flash:generateContent`, {
      contents: [{ role: "user", parts: [{ text: userMessage }] }],
    });
    expect(res.status).toBe(200);
    return (JSON.parse(res.body) as Body).candidates[0];
  }

  // The streamed candidates carrying groundingMetadata, and the streamed
  // (non-thought) text.
  async function streaming(userMessage: string): Promise<{ grounded: Candidate[]; text: string }> {
    const res = await post(
      `${instance!.url}/v1beta/models/gemini-2.5-flash:streamGenerateContent`,
      { contents: [{ role: "user", parts: [{ text: userMessage }] }] },
    );
    expect(res.status).toBe(200);
    const chunks = parseGeminiSSEChunks(res.body) as Body[];
    const grounded = chunks
      .map((c) => c.candidates[0])
      .filter((c) => c.groundingMetadata !== undefined);
    const text = chunks
      .flatMap((c) => c.candidates[0].content?.parts ?? [])
      .filter((p) => p.text !== undefined && !p.thought)
      .map((p) => p.text)
      .join("");
    return { grounded, text };
  }

  // Every streamed support names part 0 of its chunk, and its byte offsets
  // slice that part's text to `segment.text`. Returns the cited text per
  // grounding chunk index, joined across chunks in stream order.
  function streamedCitedText(grounded: Candidate[]): string[] {
    const cited: string[] = [];
    for (const candidate of grounded) {
      for (const { segment, part } of citedParts(candidate)) {
        expect(segment.partIndex).toBe(0);
        expect(bytes(part.text!, segment.startIndex, segment.endIndex)).toBe(segment.text);
      }
      for (const s of candidate.groundingMetadata!.groundingSupports) {
        for (const i of s.groundingChunkIndices) cited[i] = (cited[i] ?? "") + s.segment.text;
      }
    }
    return cited;
  }

  // Every support names a non-thought text part of `candidate`; returns the
  // segments with that part's text for offset checks.
  function citedParts(candidate: Candidate): { segment: Support["segment"]; part: Part }[] {
    const parts = candidate.content?.parts ?? [];
    return (candidate.groundingMetadata?.groundingSupports ?? []).map((s) => {
      expect(s.segment.partIndex).toBeTypeOf("number");
      const part = parts[s.segment.partIndex ?? 0];
      expect(part?.text).toBeTypeOf("string");
      expect(part?.thought).toBeUndefined();
      return { segment: s.segment, part };
    });
  }

  function bytes(text: string, start: number, end: number): string {
    return Buffer.from(text, "utf8").subarray(start, end).toString("utf8");
  }

  it.each([
    ["reasoning", { content, reasoning: "Thinking it through.", citations }, 1],
    ["files", { content, files: [{ mimeType: "image/png", data: png }], citations }, 1],
    [
      "reasoning + files",
      {
        content,
        reasoning: "Thinking it through.",
        files: [{ mimeType: "image/png", data: png }],
        citations,
      },
      2,
    ],
  ])("%s: non-streaming partIndex names the text part", async (_n, response, want) => {
    instance = await createServer([{ match: { userMessage: "pi-text" }, response }]);
    const candidate = await nonStreaming("pi-text");
    const cited = citedParts(candidate);
    expect(cited.map((c) => c.segment)).toEqual(segments.map((s) => ({ ...s, partIndex: want })));
    for (const { segment, part } of cited) {
      expect(bytes(part.text!, segment.startIndex, segment.endIndex)).toBe(segment.text);
    }
  });

  it.each([
    ["reasoning", { content, reasoning: "Thinking it through.", citations }],
    ["files", { content, files: [{ mimeType: "image/png", data: png }], citations }],
  ])("%s: streaming partIndex names the text part of each grounded chunk", async (_n, response) => {
    instance = await createServer([{ match: { userMessage: "pi-text" }, response }]);
    const { grounded, text } = await streaming("pi-text");
    expect(grounded[grounded.length - 1].finishReason).toBe("STOP");
    expect(text).toBe(content);
    expect(streamedCitedText(grounded)).toEqual(segments.map((s) => s.text));
  });

  const toolLast = {
    legacy: {
      content,
      toolCalls: [{ name: "lookup", arguments: "{}" }],
      files: [{ mimeType: "image/png", data: png }],
      reasoning: "Thinking it through.",
      citations,
    },
    blocks: {
      blocks: [
        { type: "text" as const, text: content },
        { type: "toolCall" as const, name: "lookup", arguments: "{}" },
      ],
      files: [{ mimeType: "image/png", data: png }],
      reasoning: "Thinking it through.",
      citations,
    },
  };

  it.each(Object.entries(toolLast))(
    "content + trailing toolCall (%s): non-streaming partIndex skips thought/files and names the text",
    async (_n, response) => {
      instance = await createServer([{ match: { userMessage: "pi-tool" }, response }]);
      const candidate = await nonStreaming("pi-tool");
      expect(candidate.content?.parts.map((p) => Object.keys(p).sort().join(","))).toEqual([
        "text,thought",
        "inlineData",
        "text",
        "functionCall",
      ]);
      const cited = citedParts(candidate);
      expect(cited.map((c) => c.segment)).toEqual(segments.map((s) => ({ ...s, partIndex: 2 })));
      for (const { segment, part } of cited) {
        expect(bytes(part.text!, segment.startIndex, segment.endIndex)).toBe(segment.text);
      }
    },
  );

  it.each(Object.entries(toolLast))(
    "content + trailing toolCall (%s): streaming grounds the text chunk, not the functionCall chunk",
    async (_n, response) => {
      instance = await createServer([{ match: { userMessage: "pi-tool" }, response }]);
      const { grounded, text } = await streaming("pi-tool");
      for (const candidate of grounded) {
        expect(candidate.content?.parts.some((p) => p.functionCall !== undefined)).toBe(false);
      }
      expect(text).toBe(content);
      expect(streamedCitedText(grounded)).toEqual(segments.map((s) => s.text));
    },
  );

  it.each(Object.entries(toolLast))(
    "content + trailing toolCall (%s): @google/genai parses partIndex onto the cited text part",
    async (_n, response) => {
      instance = await createServer([{ match: { userMessage: "pi-tool" }, response }]);
      // Loopback only: the SDK talks to the local aimock instance.
      const client = new GoogleGenAI({
        apiKey: "local",
        httpOptions: { baseUrl: instance.url, timeout: 5000, retryOptions: { attempts: 1 } },
      });
      const request = { model: "gemini-2.5-flash", contents: "pi-tool" };
      const whole = await client.models.generateContent(request);
      const candidate = whole.candidates![0];
      const support = candidate.groundingMetadata!.groundingSupports![0];
      expect(support.segment).toEqual({ ...segments[0], partIndex: 2 });
      expect(candidate.content!.parts![support.segment!.partIndex!].text).toBe(content);
      const grounded = [];
      for await (const chunk of await client.models.generateContentStream(request)) {
        if (chunk.candidates?.[0].groundingMetadata) grounded.push(chunk.candidates[0]);
      }
      // The default chunkSize streams "Café Mastra is a fra" then "mework.";
      // "Mastra" lies in the first chunk, at the same byte offsets.
      expect(grounded).toHaveLength(2);
      const streamed = grounded[0].groundingMetadata!.groundingSupports![0].segment!;
      expect(streamed).toEqual({ ...segments[0], partIndex: 0 });
      // Every streamed segment slices its own chunk's part, as a client reads it.
      for (const chunk of grounded) {
        for (const { segment } of chunk.groundingMetadata!.groundingSupports!) {
          const part = chunk.content!.parts![segment!.partIndex!];
          expect(part.functionCall).toBeUndefined();
          expect(bytes(part.text!, segment!.startIndex!, segment!.endIndex!)).toBe(segment!.text);
        }
      }
    },
  );

  it("blocks with two text parts: non-streaming names the part holding the citation", async () => {
    instance = await createServer([
      {
        match: { userMessage: "pi-two" },
        response: {
          blocks: [
            { type: "text", text: "Hi. " },
            { type: "toolCall", name: "lookup", arguments: "{}" },
            { type: "text", text: content },
          ],
          // "Mastra" in the concatenated text "Hi. Café Mastra is a framework."
          citations: [{ url: "https://mastra.ai", title: "Mastra", startIndex: 9, endIndex: 15 }],
        },
      },
    ]);
    const candidate = await nonStreaming("pi-two");
    const cited = citedParts(candidate);
    expect(cited.map((c) => c.segment)).toEqual([{ ...segments[0], partIndex: 2 }]);
    expect(bytes(cited[0].part.text!, 6, 12)).toBe("Mastra");
  });

  it("blocks with two text parts: streaming grounds every text chunk, through the last text block", async () => {
    instance = await createServer([
      {
        match: { userMessage: "pi-two-stream" },
        response: {
          blocks: [
            { type: "text", text: "Hi. " },
            { type: "toolCall", name: "lookup", arguments: "{}" },
            { type: "text", text: content },
          ],
          citations: [{ url: "https://mastra.ai" }],
        },
      },
    ]);
    const res = await post(`${instance.url}/v1beta/models/gemini-2.5-flash:streamGenerateContent`, {
      contents: [{ role: "user", parts: [{ text: "pi-two-stream" }] }],
    });
    expect(res.status).toBe(200);
    const candidates = (parseGeminiSSEChunks(res.body) as Body[]).map((c) => c.candidates[0]);
    // Per-chunk grounding: the offset-less citation covers the joined text, so
    // every chunk carrying text is grounded within its own part, and the
    // functionCall chunk is not.
    const groundedAt = candidates.flatMap((c, i) => (c.groundingMetadata ? [i] : []));
    const textAt = candidates.flatMap((c, i) =>
      c.content?.parts.some((p) => typeof p.text === "string" && p.text !== "" && !p.thought)
        ? [i]
        : [],
    );
    expect(groundedAt).toEqual(textAt);
    const callAt = candidates.findIndex((c) =>
      c.content?.parts.some((p) => p.functionCall !== undefined),
    );
    expect(callAt).toBeGreaterThanOrEqual(0);
    expect(groundedAt).not.toContain(callAt);
    // The last grounded chunk comes after the functionCall, and ends the last text block.
    const last = groundedAt[groundedAt.length - 1];
    expect(last).toBeGreaterThan(callAt);
    expect(content.endsWith(candidates[last].content!.parts[0].text!)).toBe(true);
    expect(streamedCitedText(candidates.filter((c) => c.groundingMetadata))).toEqual([
      "Hi. " + content,
    ]);
  });

  it.each([
    ["text", { content: "", citations: [{ url: "https://example.com" }] }],
    [
      "legacy content + toolCall",
      {
        content: "",
        toolCalls: [{ name: "lookup", arguments: "{}" }],
        citations: [{ url: "https://example.com" }],
      },
    ],
    [
      "blocks empty text + toolCall",
      {
        blocks: [
          { type: "text" as const, text: "" },
          { type: "toolCall" as const, name: "lookup", arguments: "{}" },
        ],
        citations: [{ url: "https://example.com" }],
      },
    ],
  ])("empty text (%s): both modes answer the no-text citation 500", async (_n, response) => {
    // Citations on a turn with no text have nothing to cite: a fixture error.
    instance = await createServer([{ match: { userMessage: "pi-empty" }, response }]);
    for (const path of [
      "/v1beta/models/gemini-2.5-flash:generateContent",
      "/v1beta/models/gemini-2.5-flash:streamGenerateContent",
    ]) {
      const res = await post(`${instance!.url}${path}`, {
        contents: [{ role: "user", parts: [{ text: "pi-empty" }] }],
      });
      expect(res.status, res.body).toBe(500);
      const body = JSON.parse(res.body) as {
        error: { message: string; details?: { metadata?: { code?: string } }[] };
      };
      expect(body.error.details?.[0]?.metadata?.code).toBe("aimock_invalid_fixture_citation");
      expect(body.error.message).toContain("add text to the response or remove the citations");
    }
  });
});

// A client reads each support the way the @google/genai `Segment` type
// documents it: UTF-8 byte offsets into `parts[partIndex]` of the Content that
// carries the grounding. In every candidate (non-streaming) or streamed chunk
// carrying groundingMetadata, that slice must equal `segment.text`, and the
// slices for one grounding source, joined in order, must equal the cited text.
describe("Gemini citations — client-side segment slicing", () => {
  type Part = { text?: string; thought?: boolean };
  type Candidate = {
    content?: { parts: Part[] };
    groundingMetadata?: {
      groundingChunks: { web: { uri: string } }[];
      groundingSupports: {
        segment: { partIndex: number; startIndex: number; endIndex: number; text: string };
        groundingChunkIndices: number[];
      }[];
    };
  };

  // The cited text per grounding source URI, as a client rebuilds it from the
  // candidates that carry groundingMetadata.
  function clientCitedText(candidates: Candidate[]): Record<string, string> {
    const cited: Record<string, string> = {};
    for (const candidate of candidates) {
      const meta = candidate.groundingMetadata;
      if (!meta) continue;
      for (const support of meta.groundingSupports) {
        const part = candidate.content?.parts[support.segment.partIndex];
        expect(part?.text).toBeTypeOf("string");
        expect(part?.thought).toBeUndefined();
        const sliced = Buffer.from(part?.text ?? "", "utf8")
          .subarray(support.segment.startIndex, support.segment.endIndex)
          .toString("utf8");
        expect(sliced).toBe(support.segment.text);
        for (const idx of support.groundingChunkIndices) {
          const uri = meta.groundingChunks[idx].web.uri;
          cited[uri] = (cited[uri] ?? "") + sliced;
        }
      }
    }
    return cited;
  }

  const textContent = "Café Mastra is a framework.";
  const blockA = "Hi é. ";
  const fullBlocks = blockA + textContent;
  const cases: [string, Fixture["response"], number | undefined, Record<string, string>][] = [
    [
      "single text, default chunkSize",
      {
        content: textContent,
        citations: [
          { url: "https://mastra.ai", title: "Mastra", startIndex: 5, endIndex: 11 },
          { url: "https://mastra.ai/docs" },
        ],
      },
      undefined,
      { "https://mastra.ai": "Mastra", "https://mastra.ai/docs": textContent },
    ],
    [
      "single text, chunkSize 4",
      {
        content: textContent,
        citations: [
          { url: "https://mastra.ai", title: "Mastra", startIndex: 2, endIndex: 11 },
          { url: "https://mastra.ai/docs" },
        ],
      },
      4,
      { "https://mastra.ai": "fé Mastra", "https://mastra.ai/docs": textContent },
    ],
    [
      "multi-block, a citation spanning blocks",
      {
        blocks: [
          { type: "text", text: blockA },
          { type: "toolCall", name: "lookup", arguments: "{}" },
          { type: "text", text: textContent },
        ],
        citations: [
          { url: "https://span.example", startIndex: 3, endIndex: 15 },
          { url: "https://mastra.ai", startIndex: 11, endIndex: 17 },
        ],
      },
      5,
      {
        "https://span.example": fullBlocks.slice(3, 15),
        "https://mastra.ai": fullBlocks.slice(11, 17),
      },
    ],
  ];

  async function serve(response: Fixture["response"], chunkSize: number | undefined) {
    instance = await createServer([
      { match: { userMessage: "slice" }, response, ...(chunkSize ? { chunkSize } : {}) },
    ]);
  }

  it.each(cases)(
    "%s: non-streaming slices equal the cited text",
    async (_n, response, cs, want) => {
      await serve(response, cs);
      const res = await post(`${instance!.url}/v1beta/models/gemini-2.5-flash:generateContent`, {
        contents: [{ role: "user", parts: [{ text: "slice" }] }],
      });
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body) as { candidates: Candidate[] };
      expect(clientCitedText(body.candidates)).toEqual(want);
    },
  );

  it.each(cases)("%s: streaming slices equal the cited text", async (_n, response, cs, want) => {
    await serve(response, cs);
    const res = await post(
      `${instance!.url}/v1beta/models/gemini-2.5-flash:streamGenerateContent`,
      {
        contents: [{ role: "user", parts: [{ text: "slice" }] }],
      },
    );
    expect(res.status).toBe(200);
    const chunks = parseGeminiSSEChunks(res.body) as { candidates: Candidate[] }[];
    expect(clientCitedText(chunks.map((c) => c.candidates[0]))).toEqual(want);
  });
});

// A chunk boundary that falls inside an emoji must not split its surrogate
// pair: each streamed part must be valid UTF-16, and the byte offsets of the
// citations after the emoji must slice the part to the cited text.
describe("Gemini citations — emoji at a stream chunk boundary", () => {
  type Part = { text?: string };
  type Candidate = {
    content?: { parts: Part[] };
    groundingMetadata?: {
      groundingChunks: { web: { uri: string } }[];
      groundingSupports: {
        segment: { partIndex: number; startIndex: number; endIndex: number; text: string };
        groundingChunkIndices: number[];
      }[];
    };
  };
  const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  // "Hi " is 3 UTF-16 units, so chunkSize 4 cuts between the emoji's halves.
  const text = "Hi \u{1F600} Mastra rocks.";
  const cites = [
    { url: "https://mastra.ai", startIndex: 6, endIndex: 12 },
    { url: "https://mastra.ai/docs" },
  ];
  const cases: [string, Fixture["response"], Record<string, string>][] = [
    [
      "text",
      { content: text, citations: cites },
      { "https://mastra.ai": "Mastra", "https://mastra.ai/docs": text },
    ],
    [
      "content with tool calls",
      {
        content: text,
        toolCalls: [{ name: "lookup", arguments: "{}" }],
        citations: cites,
      },
      { "https://mastra.ai": "Mastra", "https://mastra.ai/docs": text },
    ],
    [
      "blocks",
      {
        blocks: [
          { type: "toolCall", name: "lookup", arguments: "{}" },
          { type: "text", text },
        ],
        citations: cites,
      },
      { "https://mastra.ai": "Mastra", "https://mastra.ai/docs": text },
    ],
  ];

  it.each(cases)(
    "%s: parts stay valid UTF-16 and offsets slice the cited text",
    async (_n, response, want) => {
      instance = await createServer([{ match: { userMessage: "emoji" }, response, chunkSize: 4 }]);
      const res = await post(
        `${instance!.url}/v1beta/models/gemini-2.5-flash:streamGenerateContent`,
        { contents: [{ role: "user", parts: [{ text: "emoji" }] }] },
      );
      expect(res.status).toBe(200);
      const chunks = parseGeminiSSEChunks(res.body) as { candidates: Candidate[] }[];
      const candidates = chunks.map((c) => c.candidates[0]);
      let joined = "";
      for (const candidate of candidates) {
        for (const part of candidate.content?.parts ?? []) {
          if (typeof part.text !== "string") continue;
          expect(part.text).not.toMatch(LONE_SURROGATE);
          joined += part.text;
        }
      }
      expect(joined).toBe(text);
      const cited: Record<string, string> = {};
      for (const candidate of candidates) {
        const meta = candidate.groundingMetadata;
        if (!meta) continue;
        for (const support of meta.groundingSupports) {
          const part = candidate.content!.parts[support.segment.partIndex];
          const sliced = Buffer.from(part.text ?? "", "utf8")
            .subarray(support.segment.startIndex, support.segment.endIndex)
            .toString("utf8");
          expect(sliced).toBe(support.segment.text);
          for (const idx of support.groundingChunkIndices) {
            const uri = meta.groundingChunks[idx].web.uri;
            cited[uri] = (cited[uri] ?? "") + sliced;
          }
        }
      }
      expect(cited).toEqual(want);
    },
  );
});
