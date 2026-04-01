import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import type { Fixture } from "../types.js";
import { createServer, type ServerInstance } from "../server.js";
import { geminiToCompletionRequest } from "../gemini.js";

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

const errorFixture: Fixture = {
  match: { userMessage: "fail" },
  response: {
    error: {
      message: "Rate limited",
      type: "rate_limit_error",
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
          parts: { functionCall?: { name: string; args: unknown } }[];
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
    expect(chunks[0].candidates[0].finishReason).toBe("FUNCTION_CALL");
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
    expect(body.error.message).toBe("Malformed JSON");
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
    expect(body.error.status).toBe("rate_limit_error");
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
    expect(body.error.status).toBe("rate_limit_error");
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
    expect(entry!.body.model).toBe("gemini-1.5-pro");
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
