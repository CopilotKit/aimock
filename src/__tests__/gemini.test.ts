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
