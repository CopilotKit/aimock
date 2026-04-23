import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import type { Fixture, HandlerDefaults } from "../types.js";
import { createServer, type ServerInstance } from "../server.js";
import { ollamaToCompletionRequest, handleOllama, handleOllamaGenerate } from "../ollama.js";
import { writeNDJSONStream } from "../ndjson-writer.js";
import { Journal } from "../journal.js";
import { Logger } from "../logger.js";

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

function get(
  url: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "GET",
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

function parseNDJSON(body: string): object[] {
  return body
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as object);
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

const modelFixture: Fixture = {
  match: { model: "llama3", userMessage: "greet" },
  response: { content: "Hello from Ollama!" },
};

const errorFixture: Fixture = {
  match: { userMessage: "fail" },
  response: {
    error: {
      message: "Rate limited",
      type: "rate_limit_error",
    },
    status: 429,
  },
};

const allFixtures: Fixture[] = [textFixture, toolFixture, modelFixture, errorFixture];

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

// ─── Unit tests: ollamaToCompletionRequest ──────────────────────────────────

describe("ollamaToCompletionRequest", () => {
  it("converts basic chat request", () => {
    const result = ollamaToCompletionRequest({
      model: "llama3",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(result.model).toBe("llama3");
    expect(result.messages).toEqual([{ role: "user", content: "hello" }]);
  });

  it("passes through stream field", () => {
    const result = ollamaToCompletionRequest({
      model: "llama3",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    });
    expect(result.stream).toBe(false);
  });

  it("converts options to temperature and max_tokens", () => {
    const result = ollamaToCompletionRequest({
      model: "llama3",
      messages: [{ role: "user", content: "hi" }],
      options: { temperature: 0.7, num_predict: 100 },
    });
    expect(result.temperature).toBe(0.7);
    expect(result.max_tokens).toBe(100);
  });

  it("converts tools", () => {
    const result = ollamaToCompletionRequest({
      model: "llama3",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get weather",
            parameters: { type: "object", properties: { city: { type: "string" } } },
          },
        },
      ],
    });
    expect(result.tools).toHaveLength(1);
    expect(result.tools![0]).toEqual({
      type: "function",
      function: {
        name: "get_weather",
        description: "Get weather",
        parameters: { type: "object", properties: { city: { type: "string" } } },
      },
    });
  });

  it("returns undefined tools when none provided", () => {
    const result = ollamaToCompletionRequest({
      model: "llama3",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.tools).toBeUndefined();
  });
});

// ─── Unit tests: NDJSON writer ──────────────────────────────────────────────

describe("writeNDJSONStream", () => {
  it("writes correct NDJSON format", async () => {
    const chunks: string[] = [];
    const res = {
      writableEnded: false,
      setHeader: () => {},
      write: (data: string) => {
        chunks.push(data);
        return true;
      },
      end: () => {
        (res as { writableEnded: boolean }).writableEnded = true;
      },
    } as unknown as http.ServerResponse;

    const data = [
      { model: "llama3", done: false },
      { model: "llama3", done: true },
    ];
    const completed = await writeNDJSONStream(res, data);

    expect(completed).toBe(true);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe('{"model":"llama3","done":false}\n');
    expect(chunks[1]).toBe('{"model":"llama3","done":true}\n');
  });

  it("respects abort signal for interruption", async () => {
    const chunks: string[] = [];
    const controller = new AbortController();
    const res = {
      writableEnded: false,
      setHeader: () => {},
      write: (data: string) => {
        chunks.push(data);
        // Abort after first chunk
        controller.abort();
        return true;
      },
      end: () => {
        (res as { writableEnded: boolean }).writableEnded = true;
      },
    } as unknown as http.ServerResponse;

    const data = [
      { model: "llama3", done: false },
      { model: "llama3", done: false },
      { model: "llama3", done: true },
    ];
    const completed = await writeNDJSONStream(res, data, { signal: controller.signal });

    expect(completed).toBe(false);
    expect(chunks).toHaveLength(1);
  });

  it("applies streaming profile latency", async () => {
    const chunks: string[] = [];
    const res = {
      writableEnded: false,
      setHeader: () => {},
      write: (data: string) => {
        chunks.push(data);
        return true;
      },
      end: () => {
        (res as { writableEnded: boolean }).writableEnded = true;
      },
    } as unknown as http.ServerResponse;

    const data = [{ done: false }, { done: true }];
    const start = Date.now();
    await writeNDJSONStream(res, data, {
      streamingProfile: { ttft: 50, tps: 100, jitter: 0 },
    });
    const elapsed = Date.now() - start;

    // Should have at least some delay from the streaming profile
    expect(elapsed).toBeGreaterThanOrEqual(40); // ttft ~50ms + 1/100 tps ~10ms
    expect(chunks).toHaveLength(2);
  });
});

// ─── Integration tests: POST /api/chat (non-streaming) ─────────────────────

describe("POST /api/chat (non-streaming)", () => {
  it("returns text response with all final fields", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/api/chat`, {
      model: "llama3",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");

    const body = JSON.parse(res.body);
    expect(body.model).toBe("llama3");
    expect(body.message.role).toBe("assistant");
    expect(body.message.content).toBe("Hi there!");
    expect(body.done).toBe(true);
    expect(body.done_reason).toBe("stop");
    expect(body.total_duration).toBe(0);
    expect(body.load_duration).toBe(0);
    expect(body.prompt_eval_count).toBe(0);
    expect(body.prompt_eval_duration).toBe(0);
    expect(body.eval_count).toBe(0);
    expect(body.eval_duration).toBe(0);
  });

  it("returns tool call with arguments as object and no id", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/api/chat`, {
      model: "llama3",
      messages: [{ role: "user", content: "weather" }],
      stream: false,
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.done).toBe(true);
    expect(body.message.tool_calls).toHaveLength(1);
    expect(body.message.tool_calls[0].function.name).toBe("get_weather");
    // Arguments must be an OBJECT, not a JSON string
    expect(body.message.tool_calls[0].function.arguments).toEqual({ city: "NYC" });
    // No id field on tool calls
    expect(body.message.tool_calls[0].id).toBeUndefined();
  });
});

// ─── Integration tests: POST /api/chat (streaming) ──────────────────────────

describe("POST /api/chat (streaming)", () => {
  it("streams NDJSON when stream is absent (default streaming)", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/api/chat`, {
      model: "llama3",
      messages: [{ role: "user", content: "hello" }],
      // stream field intentionally omitted — Ollama defaults to true
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/x-ndjson");

    const chunks = parseNDJSON(res.body);
    expect(chunks.length).toBeGreaterThan(1);

    // All non-final chunks should have done: false
    const nonFinal = chunks.slice(0, -1);
    for (const chunk of nonFinal) {
      expect((chunk as { done: boolean }).done).toBe(false);
    }

    // Final chunk should have done: true and all duration fields
    const final = chunks[chunks.length - 1] as Record<string, unknown>;
    expect(final.done).toBe(true);
    expect(final.done_reason).toBe("stop");
    expect(final.total_duration).toBe(0);
    expect(final.load_duration).toBe(0);
    expect(final.prompt_eval_count).toBe(0);
    expect(final.prompt_eval_duration).toBe(0);
    expect(final.eval_count).toBe(0);
    expect(final.eval_duration).toBe(0);
  });

  it("streams NDJSON when stream is explicitly true", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/api/chat`, {
      model: "llama3",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/x-ndjson");

    const chunks = parseNDJSON(res.body);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("reconstructs full text from streaming chunks", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/api/chat`, {
      model: "llama3",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    });

    const chunks = parseNDJSON(res.body) as Array<{
      message: { content: string };
      done: boolean;
    }>;
    const fullText = chunks
      .filter((c) => !c.done)
      .map((c) => c.message.content)
      .join("");
    expect(fullText).toBe("Hi there!");
  });

  it("streams tool call with arguments as object", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/api/chat`, {
      model: "llama3",
      messages: [{ role: "user", content: "weather" }],
      stream: true,
    });

    const chunks = parseNDJSON(res.body) as Array<{
      message: { tool_calls?: Array<{ function: { name: string; arguments: unknown } }> };
      done: boolean;
    }>;
    const toolChunk = chunks.find((c) => c.message.tool_calls && c.message.tool_calls.length > 0);
    expect(toolChunk).toBeDefined();
    expect(toolChunk!.message.tool_calls![0].function.name).toBe("get_weather");
    expect(toolChunk!.message.tool_calls![0].function.arguments).toEqual({ city: "NYC" });
  });

  it("uses fixture chunkSize for text streaming", async () => {
    const bigChunkFixture: Fixture = {
      match: { userMessage: "bigchunk" },
      response: { content: "ABCDEFGHIJ" },
      chunkSize: 5,
    };
    instance = await createServer([bigChunkFixture], { chunkSize: 2 });
    const res = await post(`${instance.url}/api/chat`, {
      model: "llama3",
      messages: [{ role: "user", content: "bigchunk" }],
      stream: true,
    });

    const chunks = parseNDJSON(res.body) as Array<{
      message: { content: string };
      done: boolean;
    }>;
    // 10 chars / chunkSize 5 = 2 content chunks + 1 final = 3 total
    expect(chunks).toHaveLength(3);
    expect(chunks[0].message.content).toBe("ABCDE");
    expect(chunks[1].message.content).toBe("FGHIJ");
    expect(chunks[2].done).toBe(true);
  });
});

// ─── Integration tests: POST /api/chat (streaming profile) ─────────────────

describe("POST /api/chat (streaming profile)", () => {
  it("applies streaming profile latency", async () => {
    const slowFixture: Fixture = {
      match: { userMessage: "slow" },
      response: { content: "AB" },
      chunkSize: 1,
      streamingProfile: { ttft: 50, tps: 20, jitter: 0 },
    };
    instance = await createServer([slowFixture]);

    const start = Date.now();
    const res = await post(`${instance.url}/api/chat`, {
      model: "llama3",
      messages: [{ role: "user", content: "slow" }],
      stream: true,
    });
    const elapsed = Date.now() - start;

    expect(res.status).toBe(200);
    // Should have noticeable delay: ttft 50ms + at least 2 chunks at 20tps (50ms each) + final
    expect(elapsed).toBeGreaterThanOrEqual(80);
  });
});

// ─── Integration tests: POST /api/chat (interruption) ───────────────────────

describe("POST /api/chat (interruption)", () => {
  it("truncates after specified number of chunks", async () => {
    const truncFixture: Fixture = {
      match: { userMessage: "truncate" },
      response: { content: "ABCDEFGHIJ" },
      chunkSize: 1,
      truncateAfterChunks: 3,
    };
    instance = await createServer([truncFixture]);

    // Use a custom request that tolerates abrupt socket close
    const res = await new Promise<{ aborted: boolean; body: string }>((resolve) => {
      const data = JSON.stringify({
        model: "llama3",
        messages: [{ role: "user", content: "truncate" }],
        stream: true,
      });
      const parsed = new URL(`${instance!.url}/api/chat`);
      const chunks: Buffer[] = [];
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
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            resolve({ aborted: false, body: Buffer.concat(chunks).toString() });
          });
          res.on("aborted", () => {
            resolve({ aborted: true, body: Buffer.concat(chunks).toString() });
          });
        },
      );
      req.on("error", () => {
        resolve({ aborted: true, body: Buffer.concat(chunks).toString() });
      });
      req.write(data);
      req.end();
    });

    // Stream was truncated — res.destroy() causes abrupt close
    expect(res.aborted).toBe(true);

    // Journal should record interruption
    await new Promise((r) => setTimeout(r, 50));
    const entry = instance.journal.getLast();
    expect(entry!.response.interrupted).toBe(true);
    expect(entry!.response.interruptReason).toBe("truncateAfterChunks");
  });
});

// ─── Integration tests: POST /api/chat (chaos) ─────────────────────────────

describe("POST /api/chat (chaos)", () => {
  it("drops request when chaos drop header is set to 1.0", async () => {
    instance = await createServer(allFixtures);
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const data = JSON.stringify({
        model: "llama3",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      });
      const parsed = new URL(`${instance!.url}/api/chat`);
      const req = http.request(
        {
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.pathname,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(data),
            "x-aimock-chaos-drop": "1.0",
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
      req.write(data);
      req.end();
    });

    expect(res.status).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("chaos_drop");
  });
});

// ─── Integration tests: POST /api/chat (error handling) ─────────────────────

describe("POST /api/chat (error handling)", () => {
  it("returns error fixture with correct status", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/api/chat`, {
      model: "llama3",
      messages: [{ role: "user", content: "fail" }],
      stream: false,
    });

    expect(res.status).toBe(429);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("Rate limited");
  });

  it("returns 404 when no fixture matches", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/api/chat`, {
      model: "llama3",
      messages: [{ role: "user", content: "nomatch" }],
      stream: false,
    });

    expect(res.status).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("No fixture matched");
  });

  it("returns 400 when messages array is missing from /api/chat", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/api/chat`, {
      model: "llama3",
      stream: false,
    });

    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("Invalid request: messages array is required");
  });

  it("returns 400 when prompt is missing from /api/generate", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/api/generate`, {
      model: "llama3",
      stream: false,
    });

    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("Invalid request: prompt field is required");
  });

  it("returns 400 for malformed JSON", async () => {
    instance = await createServer(allFixtures);
    const res = await postRaw(`${instance.url}/api/chat`, "{not valid");

    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("Malformed JSON");
  });
});

// ─── Integration tests: POST /api/generate (non-streaming) ─────────────────

describe("POST /api/generate (non-streaming)", () => {
  it("returns text in response field (not message)", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/api/generate`, {
      model: "llama3",
      prompt: "hello",
      stream: false,
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");

    const body = JSON.parse(res.body);
    expect(body.model).toBe("llama3");
    expect(body.response).toBe("Hi there!");
    expect(body.done).toBe(true);
    expect(body.done_reason).toBe("stop");
    expect(body.context).toEqual([]);
    expect(body.created_at).toBeDefined();
    // Should NOT have message field
    expect(body.message).toBeUndefined();
  });
});

// ─── Integration tests: POST /api/generate (error/chaos/strict/no-match) ────

describe("POST /api/generate (error fixture)", () => {
  it("19a. returns error fixture through /api/generate", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/api/generate`, {
      model: "llama3",
      prompt: "fail",
      stream: false,
    });

    expect(res.status).toBe(429);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("Rate limited");
  });
});

describe("POST /api/generate (chaos)", () => {
  it("19b. drops request with chaos-drop header", async () => {
    instance = await createServer(allFixtures);
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const data = JSON.stringify({
        model: "llama3",
        prompt: "hello",
        stream: false,
      });
      const parsed = new URL(`${instance!.url}/api/generate`);
      const req = http.request(
        {
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.pathname,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(data),
            "x-aimock-chaos-drop": "1.0",
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
      req.write(data);
      req.end();
    });

    expect(res.status).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("chaos_drop");
  });
});

describe("POST /api/generate (strict mode)", () => {
  it("19c. returns 503 in strict mode with no fixtures", async () => {
    instance = await createServer([], { strict: true });
    const res = await post(`${instance.url}/api/generate`, {
      model: "llama3",
      prompt: "hello",
      stream: false,
    });

    expect(res.status).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.error.message).toContain("no fixture matched");
  });
});

describe("POST /api/generate (no fixture match)", () => {
  it("19d. returns 404 when no fixture matches", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/api/generate`, {
      model: "llama3",
      prompt: "nomatch_xyz",
      stream: false,
    });

    expect(res.status).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("No fixture matched");
  });
});

// ─── Integration tests: POST /api/generate (streaming) ──────────────────────

describe("POST /api/generate (streaming)", () => {
  it("streams NDJSON with response field", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/api/generate`, {
      model: "llama3",
      prompt: "hello",
      // stream omitted — defaults to true
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/x-ndjson");

    const chunks = parseNDJSON(res.body) as Array<{
      model: string;
      created_at: string;
      response: string;
      done: boolean;
    }>;
    expect(chunks.length).toBeGreaterThan(1);

    // Non-final chunks use response field
    const nonFinal = chunks.slice(0, -1);
    for (const chunk of nonFinal) {
      expect(chunk.response).toBeDefined();
      expect(chunk.done).toBe(false);
      expect(chunk.created_at).toBeDefined();
      // Should NOT have message field
      expect((chunk as Record<string, unknown>).message).toBeUndefined();
    }

    // Reconstruct text
    const fullText = nonFinal.map((c) => c.response).join("");
    expect(fullText).toBe("Hi there!");

    // Final chunk
    const final = chunks[chunks.length - 1] as Record<string, unknown>;
    expect(final.done).toBe(true);
    expect(final.response).toBe("");
    expect(final.done_reason).toBe("stop");
    expect(final.context).toEqual([]);
  });

  it("defaults to streaming when stream field is absent", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/api/generate`, {
      model: "llama3",
      prompt: "hello",
    });

    expect(res.headers["content-type"]).toBe("application/x-ndjson");
  });
});

// ─── Integration tests: GET /api/tags ───────────────────────────────────────

describe("GET /api/tags", () => {
  it("returns model list from fixtures", async () => {
    instance = await createServer(allFixtures);
    const res = await get(`${instance.url}/api/tags`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");

    const body = JSON.parse(res.body);
    expect(body.models).toBeDefined();
    expect(Array.isArray(body.models)).toBe(true);
    // modelFixture has model: "llama3", so it should appear
    const names = body.models.map((m: { name: string }) => m.name);
    expect(names).toContain("llama3");
  });

  it("returns default models when no fixture has model match", async () => {
    const noModelFixtures: Fixture[] = [
      { match: { userMessage: "hi" }, response: { content: "hello" } },
    ];
    instance = await createServer(noModelFixtures);
    const res = await get(`${instance.url}/api/tags`);

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.models.length).toBeGreaterThan(0);
    // Default models should include standard ones
    const names = body.models.map((m: { name: string }) => m.name);
    expect(names).toContain("gpt-4");
  });
});

// ─── Integration tests: journal ─────────────────────────────────────────────

describe("POST /api/chat (journal)", () => {
  it("records request in the journal", async () => {
    instance = await createServer(allFixtures);
    await post(`${instance.url}/api/chat`, {
      model: "llama3",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    });

    expect(instance.journal.size).toBe(1);
    const entry = instance.journal.getLast();
    expect(entry!.path).toBe("/api/chat");
    expect(entry!.response.status).toBe(200);
    expect(entry!.response.fixture).toBe(textFixture);
    expect(entry!.body.model).toBe("llama3");
  });
});

describe("POST /api/generate (journal)", () => {
  it("records request in the journal", async () => {
    instance = await createServer(allFixtures);
    await post(`${instance.url}/api/generate`, {
      model: "llama3",
      prompt: "hello",
      stream: false,
    });

    expect(instance.journal.size).toBe(1);
    const entry = instance.journal.getLast();
    expect(entry!.path).toBe("/api/generate");
    expect(entry!.response.status).toBe(200);
  });
});

// ─── Integration tests: malformed tool call arguments ───────────────────────

describe("POST /api/chat (malformed tool call arguments)", () => {
  it("falls back to empty object when arguments is not valid JSON", async () => {
    const badArgsFixture: Fixture = {
      match: { userMessage: "bad-args" },
      response: {
        toolCalls: [{ name: "fn", arguments: "NOT VALID JSON" }],
      },
    };
    instance = await createServer([badArgsFixture]);
    const res = await post(`${instance.url}/api/chat`, {
      model: "llama3",
      messages: [{ role: "user", content: "bad-args" }],
      stream: false,
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.message.tool_calls).toHaveLength(1);
    expect(body.message.tool_calls[0].function.name).toBe("fn");
    // Malformed JSON falls back to empty object
    expect(body.message.tool_calls[0].function.arguments).toEqual({});
  });
});

// ─── Integration tests: tool call on /api/generate → 500 ───────────────────

describe("POST /api/generate (tool call fixture)", () => {
  it("returns 400 for tool call fixtures on /api/generate with clear error", async () => {
    const tcFixture: Fixture = {
      match: { userMessage: "tool-gen" },
      response: {
        toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
      },
    };
    instance = await createServer([tcFixture]);
    const res = await post(`${instance.url}/api/generate`, {
      model: "llama3",
      prompt: "tool-gen",
      stream: false,
    });

    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.message).toContain("Tool call fixtures are not supported on /api/generate");
  });
});

// ─── Integration tests: CORS ────────────────────────────────────────────────

describe("POST /api/chat (CORS)", () => {
  it("includes CORS headers", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/api/chat`, {
      model: "llama3",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    });

    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });
});

// ─── Integration tests: strict mode → 503 ──────────────────────────────────

describe("POST /api/chat (strict mode)", () => {
  it("returns 503 in strict mode with no matching fixture", async () => {
    instance = await createServer([], { strict: true });
    const res = await post(`${instance.url}/api/chat`, {
      model: "llama3",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    });

    expect(res.status).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.error.message).toContain("no fixture matched");
  });
});

// ─── Integration tests: multiple tool calls ─────────────────────────────────

describe("POST /api/chat (multiple tool calls)", () => {
  it("returns 2 tool calls in a single non-streaming response", async () => {
    const multiToolFixture: Fixture = {
      match: { userMessage: "multi-tool" },
      response: {
        toolCalls: [
          { name: "get_weather", arguments: '{"city":"NYC"}' },
          { name: "get_time", arguments: '{"tz":"EST"}' },
        ],
      },
    };
    instance = await createServer([multiToolFixture]);
    const res = await post(`${instance.url}/api/chat`, {
      model: "llama3",
      messages: [{ role: "user", content: "multi-tool" }],
      stream: false,
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.message.tool_calls).toHaveLength(2);
    expect(body.message.tool_calls[0].function.name).toBe("get_weather");
    expect(body.message.tool_calls[0].function.arguments).toEqual({ city: "NYC" });
    expect(body.message.tool_calls[1].function.name).toBe("get_time");
    expect(body.message.tool_calls[1].function.arguments).toEqual({ tz: "EST" });
  });
});

// ─── Integration tests: error fixture with no explicit status ───────────────

describe("POST /api/chat (error fixture no explicit status)", () => {
  it("defaults to 500 when error fixture has no status", async () => {
    const noStatusError: Fixture = {
      match: { userMessage: "err-no-status" },
      response: {
        error: {
          message: "Something went wrong",
          type: "server_error",
        },
      },
    };
    instance = await createServer([noStatusError]);
    const res = await post(`${instance.url}/api/chat`, {
      model: "llama3",
      messages: [{ role: "user", content: "err-no-status" }],
      stream: false,
    });

    expect(res.status).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("Something went wrong");
  });
});

// ─── Integration tests: POST /api/chat (unknown response type) ──────────────

describe("POST /api/chat (unknown response type)", () => {
  it("returns 500 for embedding fixture", async () => {
    const embeddingFixture: Fixture = {
      match: { userMessage: "embed-chat" },
      response: { embedding: [0.1, 0.2, 0.3] },
    };
    instance = await createServer([embeddingFixture]);
    const res = await post(`${instance.url}/api/chat`, {
      model: "llama3",
      messages: [{ role: "user", content: "embed-chat" }],
      stream: false,
    });

    expect(res.status).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error.message).toContain("did not match any known type");
  });
});

// ─── Integration tests: POST /api/chat (error fixture streaming) ────────────

describe("POST /api/chat (error fixture streaming)", () => {
  it("returns error fixture for streaming request too", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/api/chat`, {
      model: "llama3",
      messages: [{ role: "user", content: "fail" }],
      // stream omitted → defaults to true
    });

    expect(res.status).toBe(429);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("Rate limited");
  });
});

// ─── Integration tests: POST /api/generate (malformed JSON) ─────────────────

describe("POST /api/generate (malformed JSON)", () => {
  it("returns 400 for malformed JSON body", async () => {
    instance = await createServer(allFixtures);
    const res = await postRaw(`${instance.url}/api/generate`, "{not valid");

    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("Malformed JSON");
  });
});

// ─── Integration tests: POST /api/generate (unknown response type streaming) ─

describe("POST /api/generate (unknown response type streaming)", () => {
  it("returns 400 for tool call fixture on /api/generate (streaming default)", async () => {
    const tcFixture: Fixture = {
      match: { userMessage: "tool-gen-stream" },
      response: {
        toolCalls: [{ name: "fn", arguments: '{"x":1}' }],
      },
    };
    instance = await createServer([tcFixture]);
    const res = await post(`${instance.url}/api/generate`, {
      model: "llama3",
      prompt: "tool-gen-stream",
      // stream omitted → defaults to true
    });

    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.message).toContain("Tool call fixtures are not supported on /api/generate");
  });
});

// ─── Integration tests: POST /api/generate (error fixture streaming) ────────

describe("POST /api/generate (error fixture streaming)", () => {
  it("returns error fixture for streaming generate request", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/api/generate`, {
      model: "llama3",
      prompt: "fail",
      // stream omitted → defaults to true
    });

    expect(res.status).toBe(429);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("Rate limited");
  });
});

// ─── Integration tests: POST /api/chat (streaming malformed tool call args) ──

describe("POST /api/chat (streaming malformed tool call arguments)", () => {
  it("falls back to empty object for malformed JSON in streaming", async () => {
    const badArgsFixture: Fixture = {
      match: { userMessage: "bad-stream-args" },
      response: {
        toolCalls: [{ name: "fn", arguments: "NOT VALID JSON" }],
      },
    };
    instance = await createServer([badArgsFixture]);
    const res = await post(`${instance.url}/api/chat`, {
      model: "llama3",
      messages: [{ role: "user", content: "bad-stream-args" }],
      // stream omitted → defaults to true
    });

    expect(res.status).toBe(200);
    const chunks = parseNDJSON(res.body) as Array<{
      message: { tool_calls?: Array<{ function: { arguments: unknown } }> };
      done: boolean;
    }>;
    const toolChunk = chunks.find((c) => c.message.tool_calls && c.message.tool_calls.length > 0);
    expect(toolChunk).toBeDefined();
    expect(toolChunk!.message.tool_calls![0].function.arguments).toEqual({});
  });
});

// ─── Integration tests: POST /api/chat (streaming tool call with empty args) ─

describe("POST /api/chat (streaming tool call with empty arguments)", () => {
  it("defaults to {} when arguments is empty string (streaming)", async () => {
    const emptyArgsFixture: Fixture = {
      match: { userMessage: "empty-stream-args" },
      response: {
        toolCalls: [{ name: "fn", arguments: "" }],
      },
    };
    instance = await createServer([emptyArgsFixture]);
    const res = await post(`${instance.url}/api/chat`, {
      model: "llama3",
      messages: [{ role: "user", content: "empty-stream-args" }],
      // stream omitted → defaults to true
    });

    expect(res.status).toBe(200);
    const chunks = parseNDJSON(res.body) as Array<{
      message: { tool_calls?: Array<{ function: { arguments: unknown } }> };
      done: boolean;
    }>;
    const toolChunk = chunks.find((c) => c.message.tool_calls && c.message.tool_calls.length > 0);
    expect(toolChunk).toBeDefined();
    expect(toolChunk!.message.tool_calls![0].function.arguments).toEqual({});
  });
});

// ─── Integration tests: POST /api/generate (interruption) ───────────────────

describe("POST /api/generate (interruption)", () => {
  it("truncates after specified number of chunks", async () => {
    const truncFixture: Fixture = {
      match: { userMessage: "truncate-gen" },
      response: { content: "ABCDEFGHIJ" },
      chunkSize: 1,
      truncateAfterChunks: 3,
    };
    instance = await createServer([truncFixture]);

    const res = await new Promise<{ aborted: boolean; body: string }>((resolve) => {
      const data = JSON.stringify({
        model: "llama3",
        prompt: "truncate-gen",
        // stream omitted → defaults to true
      });
      const parsed = new URL(`${instance!.url}/api/generate`);
      const chunks: Buffer[] = [];
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
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            resolve({ aborted: false, body: Buffer.concat(chunks).toString() });
          });
          res.on("aborted", () => {
            resolve({ aborted: true, body: Buffer.concat(chunks).toString() });
          });
        },
      );
      req.on("error", () => {
        resolve({ aborted: true, body: Buffer.concat(chunks).toString() });
      });
      req.write(data);
      req.end();
    });

    expect(res.aborted).toBe(true);

    await new Promise((r) => setTimeout(r, 50));
    const entry = instance.journal.getLast();
    expect(entry!.response.interrupted).toBe(true);
    expect(entry!.response.interruptReason).toBe("truncateAfterChunks");
  });
});

// ─── Unit tests: ollamaToCompletionRequest edge cases ───────────────────────

describe("ollamaToCompletionRequest (edge cases)", () => {
  it("handles missing options (temperature and max_tokens undefined)", () => {
    const result = ollamaToCompletionRequest({
      model: "llama3",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.temperature).toBeUndefined();
    expect(result.max_tokens).toBeUndefined();
  });

  it("defaults stream to true when absent (matches Ollama default)", () => {
    const result = ollamaToCompletionRequest({
      model: "llama3",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.stream).toBe(true);
  });

  it("handles empty tools array (returns undefined)", () => {
    const result = ollamaToCompletionRequest({
      model: "llama3",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    });
    expect(result.tools).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// writeNDJSONStream with non-zero latency
// ---------------------------------------------------------------------------

describe("writeNDJSONStream with non-zero latency", () => {
  it("delays between chunks when latency is set", async () => {
    const chunks: string[] = [];
    const timestamps: number[] = [];
    const res = {
      writableEnded: false,
      setHeader: () => {},
      write: (data: string) => {
        chunks.push(data);
        timestamps.push(Date.now());
        return true;
      },
      end: () => {
        (res as { writableEnded: boolean }).writableEnded = true;
      },
    } as unknown as http.ServerResponse;

    const data = [
      { model: "llama3", message: { content: "Hello" }, done: false },
      { model: "llama3", message: { content: " world" }, done: false },
      { model: "llama3", message: { content: "" }, done: true },
    ];

    const start = Date.now();
    const completed = await writeNDJSONStream(res, data, { latency: 30 });
    const elapsed = Date.now() - start;

    expect(completed).toBe(true);
    expect(chunks).toHaveLength(3);
    // With 30ms latency per chunk and 3 chunks, total should be >= 60ms
    // (first chunk has 0 delay with default profile, subsequent chunks have latency)
    expect(elapsed).toBeGreaterThanOrEqual(50);
  });

  it("all chunks are valid NDJSON with non-zero latency", async () => {
    const chunks: string[] = [];
    const res = {
      writableEnded: false,
      setHeader: () => {},
      write: (data: string) => {
        chunks.push(data);
        return true;
      },
      end: () => {
        (res as { writableEnded: boolean }).writableEnded = true;
      },
    } as unknown as http.ServerResponse;

    const data = [
      { model: "llama3", done: false, message: { content: "a" } },
      { model: "llama3", done: true, message: { content: "" } },
    ];

    const completed = await writeNDJSONStream(res, data, { latency: 10 });

    expect(completed).toBe(true);
    expect(chunks).toHaveLength(2);
    // Each chunk should be valid JSON followed by newline
    for (const chunk of chunks) {
      expect(chunk.endsWith("\n")).toBe(true);
      expect(() => JSON.parse(chunk.trim())).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Direct handler tests for req.method/req.url fallback branches
// ---------------------------------------------------------------------------

function createMockReq(overrides: Partial<http.IncomingMessage> = {}): http.IncomingMessage {
  return {
    method: undefined,
    url: undefined,
    headers: {},
    ...overrides,
  } as unknown as http.IncomingMessage;
}

function createMockRes(): http.ServerResponse & { _written: string; _status: number } {
  const res = {
    _written: "",
    _status: 0,
    writableEnded: false,
    statusCode: 0,
    writeHead(status: number) {
      res._status = status;
      res.statusCode = status;
    },
    setHeader() {},
    write(data: string) {
      res._written += data;
      return true;
    },
    end(data?: string) {
      if (data) res._written += data;
      res.writableEnded = true;
    },
    destroy() {
      res.writableEnded = true;
    },
  };
  return res as unknown as http.ServerResponse & { _written: string; _status: number };
}

function createDefaults(overrides: Partial<HandlerDefaults> = {}): HandlerDefaults {
  return {
    latency: 0,
    chunkSize: 100,
    logger: new Logger("silent"),
    ...overrides,
  };
}

describe("handleOllama (direct handler call, method/url fallbacks)", () => {
  it("uses fallback for non-streaming text response with undefined method/url", async () => {
    const fixture: Fixture = {
      match: { userMessage: "hi" },
      response: { content: "Hello" },
    };
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();

    await handleOllama(
      req,
      res,
      JSON.stringify({
        model: "llama3",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      }),
      [fixture],
      journal,
      createDefaults(),
      () => {},
    );

    expect(res._status).toBe(200);
    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.path).toBe("/api/chat");
  });

  it("uses fallback for streaming text response", async () => {
    const fixture: Fixture = {
      match: { userMessage: "hi" },
      response: { content: "Hello" },
    };
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();

    await handleOllama(
      req,
      res,
      JSON.stringify({ model: "llama3", messages: [{ role: "user", content: "hi" }] }),
      [fixture],
      journal,
      createDefaults(),
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.path).toBe("/api/chat");
  });

  it("uses fallback for malformed JSON", async () => {
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();

    await handleOllama(req, res, "{bad", [], journal, createDefaults(), () => {});

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.path).toBe("/api/chat");
  });

  it("uses fallback for missing messages", async () => {
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();

    await handleOllama(
      req,
      res,
      JSON.stringify({ model: "llama3" }),
      [],
      journal,
      createDefaults(),
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.response.status).toBe(400);
  });

  it("uses fallback for no fixture match", async () => {
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();

    await handleOllama(
      req,
      res,
      JSON.stringify({
        model: "llama3",
        messages: [{ role: "user", content: "x" }],
        stream: false,
      }),
      [],
      journal,
      createDefaults(),
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.response.status).toBe(404);
  });

  it("uses fallback for strict mode", async () => {
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();

    await handleOllama(
      req,
      res,
      JSON.stringify({
        model: "llama3",
        messages: [{ role: "user", content: "x" }],
        stream: false,
      }),
      [],
      journal,
      createDefaults({ strict: true }),
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.response.status).toBe(503);
  });

  it("uses fallback for error response", async () => {
    const fixture: Fixture = {
      match: { userMessage: "err" },
      response: { error: { message: "fail", type: "err" }, status: 500 },
    };
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();

    await handleOllama(
      req,
      res,
      JSON.stringify({
        model: "llama3",
        messages: [{ role: "user", content: "err" }],
        stream: false,
      }),
      [fixture],
      journal,
      createDefaults(),
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.response.status).toBe(500);
  });

  it("uses fallback for non-streaming tool call response", async () => {
    const fixture: Fixture = {
      match: { userMessage: "tool" },
      response: { toolCalls: [{ name: "fn", arguments: '{"x":1}' }] },
    };
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();

    await handleOllama(
      req,
      res,
      JSON.stringify({
        model: "llama3",
        messages: [{ role: "user", content: "tool" }],
        stream: false,
      }),
      [fixture],
      journal,
      createDefaults(),
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.response.status).toBe(200);
  });

  it("uses fallback for streaming tool call response", async () => {
    const fixture: Fixture = {
      match: { userMessage: "tool" },
      response: { toolCalls: [{ name: "fn", arguments: '{"x":1}' }] },
    };
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();

    await handleOllama(
      req,
      res,
      JSON.stringify({ model: "llama3", messages: [{ role: "user", content: "tool" }] }),
      [fixture],
      journal,
      createDefaults(),
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.response.status).toBe(200);
  });

  it("uses fallback for unknown response type", async () => {
    const fixture: Fixture = {
      match: { userMessage: "embed" },
      response: { embedding: [0.1] },
    };
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();

    await handleOllama(
      req,
      res,
      JSON.stringify({
        model: "llama3",
        messages: [{ role: "user", content: "embed" }],
        stream: false,
      }),
      [fixture],
      journal,
      createDefaults(),
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.response.status).toBe(500);
  });
});

describe("handleOllamaGenerate (direct handler call, method/url fallbacks)", () => {
  it("uses fallback for non-streaming text response", async () => {
    const fixture: Fixture = {
      match: { userMessage: "hi" },
      response: { content: "Hello" },
    };
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();

    await handleOllamaGenerate(
      req,
      res,
      JSON.stringify({ model: "llama3", prompt: "hi", stream: false }),
      [fixture],
      journal,
      createDefaults(),
      () => {},
    );

    expect(res._status).toBe(200);
    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.path).toBe("/api/generate");
  });

  it("uses fallback for streaming text response", async () => {
    const fixture: Fixture = {
      match: { userMessage: "hi" },
      response: { content: "Hello" },
    };
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();

    await handleOllamaGenerate(
      req,
      res,
      JSON.stringify({ model: "llama3", prompt: "hi" }),
      [fixture],
      journal,
      createDefaults(),
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.path).toBe("/api/generate");
  });

  it("uses fallback for malformed JSON", async () => {
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();

    await handleOllamaGenerate(req, res, "{bad", [], journal, createDefaults(), () => {});

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.path).toBe("/api/generate");
  });

  it("uses fallback for missing prompt", async () => {
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();

    await handleOllamaGenerate(
      req,
      res,
      JSON.stringify({ model: "llama3" }),
      [],
      journal,
      createDefaults(),
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.response.status).toBe(400);
  });

  it("uses fallback for no fixture match", async () => {
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();

    await handleOllamaGenerate(
      req,
      res,
      JSON.stringify({ model: "llama3", prompt: "x", stream: false }),
      [],
      journal,
      createDefaults(),
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.response.status).toBe(404);
  });

  it("uses fallback for strict mode", async () => {
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();

    await handleOllamaGenerate(
      req,
      res,
      JSON.stringify({ model: "llama3", prompt: "x", stream: false }),
      [],
      journal,
      createDefaults({ strict: true }),
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.response.status).toBe(503);
  });

  it("uses fallback for error response", async () => {
    const fixture: Fixture = {
      match: { userMessage: "err" },
      response: { error: { message: "fail", type: "err" }, status: 500 },
    };
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();

    await handleOllamaGenerate(
      req,
      res,
      JSON.stringify({ model: "llama3", prompt: "err", stream: false }),
      [fixture],
      journal,
      createDefaults(),
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.response.status).toBe(500);
  });

  it("uses fallback for unknown response type (non-streaming)", async () => {
    const fixture: Fixture = {
      match: { userMessage: "embed" },
      response: { embedding: [0.1] },
    };
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();

    await handleOllamaGenerate(
      req,
      res,
      JSON.stringify({ model: "llama3", prompt: "embed", stream: false }),
      [fixture],
      journal,
      createDefaults(),
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.response.status).toBe(500);
  });

  it("uses fallback for unknown response type (streaming)", async () => {
    const fixture: Fixture = {
      match: { userMessage: "embed" },
      response: { embedding: [0.1] },
    };
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();

    await handleOllamaGenerate(
      req,
      res,
      JSON.stringify({ model: "llama3", prompt: "embed" }),
      [fixture],
      journal,
      createDefaults(),
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.response.status).toBe(500);
  });
});
