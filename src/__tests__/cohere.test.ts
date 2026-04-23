import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import type { Fixture, HandlerDefaults } from "../types.js";
import { createServer, type ServerInstance } from "../server.js";
import { cohereToCompletionRequest, handleCohere } from "../cohere.js";
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

function postWithHeaders(
  url: string,
  body: unknown,
  extraHeaders: Record<string, string>,
): Promise<{ status: number; body: string }> {
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
          ...extraHeaders,
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
}

interface SSEEvent {
  event: string;
  data: Record<string, unknown>;
}

function parseSSEEvents(body: string): SSEEvent[] {
  const events: SSEEvent[] = [];
  const blocks = body.split("\n\n").filter((b) => b.trim() !== "");
  for (const block of blocks) {
    const lines = block.split("\n");
    let eventType = "";
    let dataStr = "";
    for (const line of lines) {
      if (line.startsWith("event: ")) {
        eventType = line.slice(7);
      } else if (line.startsWith("data: ")) {
        dataStr = line.slice(6);
      }
    }
    if (eventType && dataStr) {
      events.push({ event: eventType, data: JSON.parse(dataStr) as Record<string, unknown> });
    }
  }
  return events;
}

// --- fixtures ---

const textFixture: Fixture = {
  match: { userMessage: "hello" },
  response: { content: "The capital of France is Paris." },
};

const toolFixture: Fixture = {
  match: { userMessage: "weather" },
  response: {
    toolCalls: [
      {
        name: "get_weather",
        arguments: '{"city":"SF"}',
      },
    ],
  },
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

const allFixtures: Fixture[] = [textFixture, toolFixture, errorFixture];

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

// ─── Unit tests: cohereToCompletionRequest ──────────────────────────────────

describe("cohereToCompletionRequest", () => {
  it("converts basic user message", () => {
    const result = cohereToCompletionRequest({
      model: "command-r-plus",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(result.model).toBe("command-r-plus");
    expect(result.messages).toEqual([{ role: "user", content: "hello" }]);
  });

  it("converts system message", () => {
    const result = cohereToCompletionRequest({
      model: "command-r-plus",
      messages: [
        { role: "system", content: "Be helpful" },
        { role: "user", content: "hello" },
      ],
    });
    expect(result.messages[0]).toEqual({ role: "system", content: "Be helpful" });
    expect(result.messages[1]).toEqual({ role: "user", content: "hello" });
  });

  it("converts tool message with tool_call_id", () => {
    const result = cohereToCompletionRequest({
      model: "command-r-plus",
      messages: [
        {
          role: "tool",
          content: '{"temp":72}',
          tool_call_id: "call_abc",
        },
      ],
    });
    expect(result.messages[0]).toEqual({
      role: "tool",
      content: '{"temp":72}',
      tool_call_id: "call_abc",
    });
  });

  it("converts tools", () => {
    const result = cohereToCompletionRequest({
      model: "command-r-plus",
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

  it("passes through stream field", () => {
    const result = cohereToCompletionRequest({
      model: "command-r-plus",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    expect(result.stream).toBe(true);
  });

  it("returns undefined tools when none provided", () => {
    const result = cohereToCompletionRequest({
      model: "command-r-plus",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.tools).toBeUndefined();
  });
});

// ─── Unit tests: cohereToCompletionRequest (assistant message) ───────────────

describe("cohereToCompletionRequest (assistant message)", () => {
  it("converts assistant message", () => {
    const result = cohereToCompletionRequest({
      model: "command-r-plus",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "Hi there" },
      ],
    });
    expect(result.messages[1]).toEqual({ role: "assistant", content: "Hi there" });
  });
});

// ─── Integration tests: POST /v2/chat (non-streaming text) ─────────────────

describe("POST /v2/chat (non-streaming text)", () => {
  it("returns text response with all required fields", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v2/chat`, {
      model: "command-r-plus",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");

    const body = JSON.parse(res.body);
    expect(body.id).toMatch(/^msg_/);
    expect(body.finish_reason).toBe("COMPLETE");
    expect(body.message.role).toBe("assistant");
    expect(body.message.content).toEqual([
      { type: "text", text: "The capital of France is Paris." },
    ]);
    expect(body.message.tool_calls).toEqual([]);
    expect(body.message.tool_plan).toBe("");
    expect(body.message.citations).toEqual([]);
    expect(body.usage.billed_units).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      search_units: 0,
      classifications: 0,
    });
    expect(body.usage.tokens).toEqual({ input_tokens: 0, output_tokens: 0 });
  });
});

// ─── Integration tests: POST /v2/chat (non-streaming tool call) ─────────────

describe("POST /v2/chat (non-streaming tool call)", () => {
  it("returns tool call with TOOL_CALL finish_reason", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v2/chat`, {
      model: "command-r-plus",
      messages: [{ role: "user", content: "weather" }],
      stream: false,
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.finish_reason).toBe("TOOL_CALL");
    expect(body.message.tool_calls).toHaveLength(1);
    expect(body.message.tool_calls[0].id).toMatch(/^call_/);
    expect(body.message.tool_calls[0].type).toBe("function");
    expect(body.message.tool_calls[0].function.name).toBe("get_weather");
    expect(body.message.tool_calls[0].function.arguments).toBe('{"city":"SF"}');
    expect(body.message.content).toEqual([]);
    expect(body.usage).toBeDefined();
  });
});

// ─── Integration tests: POST /v2/chat (streaming text) ─────────────────────

describe("POST /v2/chat (streaming text)", () => {
  it("produces correct event sequence", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v2/chat`, {
      model: "command-r-plus",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream");

    const events = parseSSEEvents(res.body);
    expect(events.length).toBeGreaterThanOrEqual(5);

    // message-start
    expect(events[0].event).toBe("message-start");
    expect(events[0].data.type).toBe("message-start");
    const msgStart = events[0].data.delta as Record<string, unknown>;
    const startMsg = msgStart.message as Record<string, unknown>;
    expect(startMsg.role).toBe("assistant");
    expect(startMsg.content).toEqual([]);
    expect(startMsg.tool_plan).toBe("");
    expect(startMsg.tool_calls).toEqual([]);
    expect(startMsg.citations).toEqual([]);

    // content-start (type: "text" only, no text field)
    expect(events[1].event).toBe("content-start");
    expect(events[1].data.type).toBe("content-start");
    expect(events[1].data.index).toBe(0);
    const csDelta = events[1].data.delta as Record<string, unknown>;
    const csMsg = csDelta.message as Record<string, unknown>;
    const csContent = csMsg.content as Record<string, unknown>;
    expect(csContent.type).toBe("text");
    expect(csContent).not.toHaveProperty("text");

    // content-delta(s)
    const contentDeltas = events.filter((e) => e.event === "content-delta");
    expect(contentDeltas.length).toBeGreaterThanOrEqual(1);
    for (const cd of contentDeltas) {
      expect(cd.data.type).toBe("content-delta");
      expect(cd.data.index).toBe(0);
      const delta = cd.data.delta as Record<string, unknown>;
      const msg = delta.message as Record<string, unknown>;
      const content = msg.content as Record<string, unknown>;
      expect(content.type).toBe("text");
      expect(typeof content.text).toBe("string");
    }

    // Reconstruct full text from deltas
    const fullText = contentDeltas
      .map((cd) => {
        const delta = cd.data.delta as Record<string, unknown>;
        const msg = delta.message as Record<string, unknown>;
        const content = msg.content as Record<string, unknown>;
        return content.text as string;
      })
      .join("");
    expect(fullText).toBe("The capital of France is Paris.");

    // content-end
    const contentEnd = events.find((e) => e.event === "content-end");
    expect(contentEnd).toBeDefined();
    expect(contentEnd!.data.type).toBe("content-end");
    expect(contentEnd!.data.index).toBe(0);

    // message-end
    const msgEnd = events[events.length - 1];
    expect(msgEnd.event).toBe("message-end");
    expect(msgEnd.data.type).toBe("message-end");
    const endDelta = msgEnd.data.delta as Record<string, unknown>;
    expect(endDelta.finish_reason).toBe("COMPLETE");
    const usage = endDelta.usage as Record<string, unknown>;
    expect(usage.billed_units).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      search_units: 0,
      classifications: 0,
    });
    expect(usage.tokens).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  it("content-start has type:text only and no text field", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v2/chat`, {
      model: "command-r-plus",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    });

    const events = parseSSEEvents(res.body);
    const contentStart = events.find((e) => e.event === "content-start");
    expect(contentStart).toBeDefined();
    const delta = contentStart!.data.delta as Record<string, unknown>;
    const msg = delta.message as Record<string, unknown>;
    const content = msg.content as Record<string, unknown>;
    expect(content.type).toBe("text");
    expect(Object.keys(content)).toEqual(["type"]);
  });
});

// ─── Integration tests: POST /v2/chat (streaming tool calls) ────────────────

describe("POST /v2/chat (streaming tool calls)", () => {
  it("produces correct tool call event sequence", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v2/chat`, {
      model: "command-r-plus",
      messages: [{ role: "user", content: "weather" }],
      stream: true,
    });

    expect(res.status).toBe(200);
    const events = parseSSEEvents(res.body);

    // message-start
    expect(events[0].event).toBe("message-start");

    // tool-plan-delta
    const planDelta = events.find((e) => e.event === "tool-plan-delta");
    expect(planDelta).toBeDefined();
    expect(planDelta!.data.type).toBe("tool-plan-delta");
    const planMsg = (planDelta!.data.delta as Record<string, unknown>).message as Record<
      string,
      unknown
    >;
    expect(typeof planMsg.tool_plan).toBe("string");

    // tool-call-start
    const tcStart = events.find((e) => e.event === "tool-call-start");
    expect(tcStart).toBeDefined();
    expect(tcStart!.data.type).toBe("tool-call-start");
    expect(tcStart!.data.index).toBe(0);
    const tcStartDelta = tcStart!.data.delta as Record<string, unknown>;
    const tcStartMsg = tcStartDelta.message as Record<string, unknown>;
    const tcStartCalls = tcStartMsg.tool_calls as Record<string, unknown>;
    expect(tcStartCalls.id).toMatch(/^call_/);
    expect(tcStartCalls.type).toBe("function");
    const tcStartFn = tcStartCalls.function as Record<string, unknown>;
    expect(tcStartFn.name).toBe("get_weather");
    expect(tcStartFn.arguments).toBe("");

    // tool-call-delta(s)
    const tcDeltas = events.filter((e) => e.event === "tool-call-delta");
    expect(tcDeltas.length).toBeGreaterThanOrEqual(1);
    const argsAccum = tcDeltas
      .map((e) => {
        const delta = e.data.delta as Record<string, unknown>;
        const msg = delta.message as Record<string, unknown>;
        const calls = msg.tool_calls as Record<string, unknown>;
        const fn = calls.function as Record<string, unknown>;
        return fn.arguments as string;
      })
      .join("");
    expect(argsAccum).toBe('{"city":"SF"}');

    // tool-call-end
    const tcEnd = events.find((e) => e.event === "tool-call-end");
    expect(tcEnd).toBeDefined();
    expect(tcEnd!.data.type).toBe("tool-call-end");
    expect(tcEnd!.data.index).toBe(0);

    // message-end with TOOL_CALL
    const msgEnd = events[events.length - 1];
    expect(msgEnd.event).toBe("message-end");
    const endDelta = msgEnd.data.delta as Record<string, unknown>;
    expect(endDelta.finish_reason).toBe("TOOL_CALL");
    expect(endDelta.usage).toBeDefined();
  });
});

// ─── Integration tests: POST /v2/chat (message-end usage) ───────────────────

describe("POST /v2/chat (message-end usage)", () => {
  it("includes usage with both billed_units and tokens", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v2/chat`, {
      model: "command-r-plus",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    });

    const events = parseSSEEvents(res.body);
    const msgEnd = events.find((e) => e.event === "message-end");
    expect(msgEnd).toBeDefined();
    const delta = msgEnd!.data.delta as Record<string, unknown>;
    const usage = delta.usage as Record<string, unknown>;
    expect(usage.billed_units).toBeDefined();
    expect(usage.tokens).toBeDefined();
    const billedUnits = usage.billed_units as Record<string, unknown>;
    expect(billedUnits.input_tokens).toBe(0);
    expect(billedUnits.output_tokens).toBe(0);
    expect(billedUnits.search_units).toBe(0);
    expect(billedUnits.classifications).toBe(0);
    const tokens = usage.tokens as Record<string, unknown>;
    expect(tokens.input_tokens).toBe(0);
    expect(tokens.output_tokens).toBe(0);
  });
});

// ─── Integration tests: POST /v2/chat (validation) ──────────────────────────

describe("POST /v2/chat (validation)", () => {
  it("returns 400 when model is missing", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v2/chat`, {
      messages: [{ role: "user", content: "hello" }],
    });

    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("model is required");
  });

  it("returns 400 when messages array is missing", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v2/chat`, {
      model: "command-r",
    });

    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("Invalid request: messages array is required");
  });

  it("returns 400 for malformed JSON", async () => {
    instance = await createServer(allFixtures);
    const res = await postRaw(`${instance.url}/v2/chat`, "{not valid");

    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("Malformed JSON");
  });

  it("returns 404 when no fixture matches", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v2/chat`, {
      model: "command-r-plus",
      messages: [{ role: "user", content: "nomatch" }],
      stream: false,
    });

    expect(res.status).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("No fixture matched");
  });
});

// ─── Integration tests: POST /v2/chat (streaming profile) ───────────────────

describe("POST /v2/chat (streaming profile)", () => {
  it("applies streaming profile latency", async () => {
    const slowFixture: Fixture = {
      match: { userMessage: "slow" },
      response: { content: "AB" },
      chunkSize: 1,
      streamingProfile: { ttft: 50, tps: 20, jitter: 0 },
    };
    instance = await createServer([slowFixture]);

    const start = Date.now();
    const res = await post(`${instance.url}/v2/chat`, {
      model: "command-r-plus",
      messages: [{ role: "user", content: "slow" }],
      stream: true,
    });
    const elapsed = Date.now() - start;

    expect(res.status).toBe(200);
    // Should have noticeable delay from streaming profile
    expect(elapsed).toBeGreaterThanOrEqual(80);
  });
});

// ─── Integration tests: POST /v2/chat (interruption) ────────────────────────

describe("POST /v2/chat (interruption)", () => {
  it("truncates after specified number of chunks", async () => {
    const truncFixture: Fixture = {
      match: { userMessage: "truncate" },
      response: { content: "ABCDEFGHIJ" },
      chunkSize: 1,
      truncateAfterChunks: 3,
    };
    instance = await createServer([truncFixture]);

    const res = await new Promise<{ aborted: boolean; body: string }>((resolve) => {
      const data = JSON.stringify({
        model: "command-r-plus",
        messages: [{ role: "user", content: "truncate" }],
        stream: true,
      });
      const parsed = new URL(`${instance!.url}/v2/chat`);
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

// ─── Integration tests: POST /v2/chat (chaos) ──────────────────────────────

describe("POST /v2/chat (chaos)", () => {
  it("drops request when chaos drop header is set to 1.0", async () => {
    instance = await createServer(allFixtures);
    const res = await postWithHeaders(
      `${instance.url}/v2/chat`,
      {
        model: "command-r-plus",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      },
      { "x-aimock-chaos-drop": "1.0" },
    );

    expect(res.status).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("chaos_drop");
  });
});

// ─── Integration tests: POST /v2/chat (error fixture) ───────────────────────

describe("POST /v2/chat (error fixture)", () => {
  it("returns error fixture with correct status", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v2/chat`, {
      model: "command-r-plus",
      messages: [{ role: "user", content: "fail" }],
      stream: false,
    });

    expect(res.status).toBe(429);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("Rate limited");
  });
});

// ─── Integration tests: POST /v2/chat (streaming default) ───────────────────

describe("POST /v2/chat (streaming default)", () => {
  it("20. returns non-streaming JSON when stream field is omitted", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v2/chat`, {
      model: "command-r-plus",
      messages: [{ role: "user", content: "hello" }],
      // stream field intentionally omitted — Cohere defaults to non-streaming
    });

    expect(res.status).toBe(200);
    // Should be non-streaming JSON, NOT SSE
    expect(res.headers["content-type"]).toBe("application/json");

    const body = JSON.parse(res.body);
    expect(body.id).toMatch(/^msg_/);
    expect(body.finish_reason).toBe("COMPLETE");
    expect(body.message.role).toBe("assistant");
    expect(body.message.content).toEqual([
      { type: "text", text: "The capital of France is Paris." },
    ]);
  });
});

// ─── Integration tests: POST /v2/chat (multiple tool calls) ─────────────────

describe("POST /v2/chat (multiple tool calls)", () => {
  const multiToolFixture: Fixture = {
    match: { userMessage: "multi-tool" },
    response: {
      toolCalls: [
        { name: "get_weather", arguments: '{"city":"NYC"}' },
        { name: "get_time", arguments: '{"tz":"EST"}' },
      ],
    },
  };

  it("21a. non-streaming returns 2 items in tool_calls array", async () => {
    instance = await createServer([multiToolFixture]);
    const res = await post(`${instance.url}/v2/chat`, {
      model: "command-r-plus",
      messages: [{ role: "user", content: "multi-tool" }],
      stream: false,
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.finish_reason).toBe("TOOL_CALL");
    expect(body.message.tool_calls).toHaveLength(2);
    expect(body.message.tool_calls[0].function.name).toBe("get_weather");
    expect(body.message.tool_calls[1].function.name).toBe("get_time");
  });

  it("21b. streaming produces 2 tool-call-start events", async () => {
    instance = await createServer([multiToolFixture]);
    const res = await post(`${instance.url}/v2/chat`, {
      model: "command-r-plus",
      messages: [{ role: "user", content: "multi-tool" }],
      stream: true,
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream");

    const events = parseSSEEvents(res.body);
    const toolCallStarts = events.filter((e) => e.event === "tool-call-start");
    expect(toolCallStarts).toHaveLength(2);

    // First tool at index 0
    expect(toolCallStarts[0].data.index).toBe(0);
    const tc0Delta = toolCallStarts[0].data.delta as Record<string, unknown>;
    const tc0Msg = tc0Delta.message as Record<string, unknown>;
    const tc0Calls = tc0Msg.tool_calls as Record<string, unknown>;
    const tc0Fn = tc0Calls.function as Record<string, unknown>;
    expect(tc0Fn.name).toBe("get_weather");

    // Second tool at index 1
    expect(toolCallStarts[1].data.index).toBe(1);
    const tc1Delta = toolCallStarts[1].data.delta as Record<string, unknown>;
    const tc1Msg = tc1Delta.message as Record<string, unknown>;
    const tc1Calls = tc1Msg.tool_calls as Record<string, unknown>;
    const tc1Fn = tc1Calls.function as Record<string, unknown>;
    expect(tc1Fn.name).toBe("get_time");

    // message-end should have TOOL_CALL finish_reason
    const msgEnd = events.find((e) => e.event === "message-end");
    expect(msgEnd).toBeDefined();
    const endDelta = msgEnd!.data.delta as Record<string, unknown>;
    expect(endDelta.finish_reason).toBe("TOOL_CALL");
  });
});

// ─── Integration tests: POST /v2/chat (malformed tool call arguments) ───────

describe("POST /v2/chat (malformed tool call arguments)", () => {
  it("falls back to empty string when arguments is not valid JSON", async () => {
    const badArgsFixture: Fixture = {
      match: { userMessage: "bad-args" },
      response: {
        toolCalls: [{ name: "fn", arguments: "NOT VALID JSON" }],
      },
    };
    instance = await createServer([badArgsFixture]);
    const res = await post(`${instance.url}/v2/chat`, {
      model: "command-r-plus",
      messages: [{ role: "user", content: "bad-args" }],
      stream: false,
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.message.tool_calls).toHaveLength(1);
    expect(body.message.tool_calls[0].function.name).toBe("fn");
    // Malformed JSON falls back to "{}" (logs warning)
    expect(body.message.tool_calls[0].function.arguments).toBe("{}");
  });
});

// ─── Integration tests: POST /v2/chat (strict mode) ────────────────────────

describe("POST /v2/chat (strict mode)", () => {
  it("returns 503 in strict mode with no fixtures", async () => {
    instance = await createServer([], { strict: true });
    const res = await post(`${instance.url}/v2/chat`, {
      model: "command-r-plus",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    });

    expect(res.status).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.error.message).toContain("no fixture matched");
  });
});

// ─── Integration tests: POST /v2/chat (unknown response type → 500) ─────────

describe("POST /v2/chat (unknown response type)", () => {
  it("returns 500 for a fixture with unrecognizable response shape", async () => {
    const weirdFixture: Fixture = {
      match: { userMessage: "weird" },
      response: { embedding: [0.1, 0.2, 0.3] },
    };
    instance = await createServer([weirdFixture]);
    const res = await post(`${instance.url}/v2/chat`, {
      model: "command-r-plus",
      messages: [{ role: "user", content: "weird" }],
      stream: false,
    });

    expect(res.status).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error.message).toContain("did not match any known type");
  });
});

// ─── Integration tests: POST /v2/chat (error fixture no explicit status) ────

describe("POST /v2/chat (error fixture no explicit status)", () => {
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
    const res = await post(`${instance.url}/v2/chat`, {
      model: "command-r-plus",
      messages: [{ role: "user", content: "err-no-status" }],
      stream: false,
    });

    expect(res.status).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("Something went wrong");
  });
});

// ─── Integration tests: POST /v2/chat (CORS headers) ────────────────────────

describe("POST /v2/chat (CORS headers)", () => {
  it("includes CORS headers in response", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v2/chat`, {
      model: "command-r-plus",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    });

    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });
});

// ─── Integration tests: POST /v2/chat (journal) ────────────────────────────

describe("POST /v2/chat (journal)", () => {
  it("records request in the journal", async () => {
    instance = await createServer(allFixtures);
    await post(`${instance.url}/v2/chat`, {
      model: "command-r-plus",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    });

    expect(instance.journal.size).toBe(1);
    const entry = instance.journal.getLast();
    expect(entry!.path).toBe("/v2/chat");
    expect(entry!.response.status).toBe(200);
    expect(entry!.response.fixture).toBe(textFixture);
    expect(entry!.body.model).toBe("command-r-plus");
  });
});

// ─── Integration tests: POST /v2/chat (streaming malformed tool call args) ──

describe("POST /v2/chat (streaming malformed tool call arguments)", () => {
  it("falls back to '{}' for malformed JSON in streaming tool call", async () => {
    const badArgsFixture: Fixture = {
      match: { userMessage: "bad-stream-args" },
      response: {
        toolCalls: [{ name: "fn", arguments: "NOT VALID JSON" }],
      },
    };
    instance = await createServer([badArgsFixture]);
    const res = await post(`${instance.url}/v2/chat`, {
      model: "command-r-plus",
      messages: [{ role: "user", content: "bad-stream-args" }],
      stream: true,
    });

    expect(res.status).toBe(200);
    const events = parseSSEEvents(res.body);
    const tcDeltas = events.filter((e) => e.event === "tool-call-delta");
    const argsAccum = tcDeltas
      .map((e) => {
        const delta = e.data.delta as Record<string, unknown>;
        const msg = delta.message as Record<string, unknown>;
        const calls = msg.tool_calls as Record<string, unknown>;
        const fn = calls.function as Record<string, unknown>;
        return fn.arguments as string;
      })
      .join("");
    expect(argsAccum).toBe("{}");
  });
});

// ─── Integration tests: POST /v2/chat (streaming tool call with empty args) ─

describe("POST /v2/chat (streaming tool call with empty arguments)", () => {
  it("defaults to '{}' when arguments is empty string in streaming", async () => {
    const emptyArgsFixture: Fixture = {
      match: { userMessage: "empty-stream-args" },
      response: {
        toolCalls: [{ name: "fn", arguments: "" }],
      },
    };
    instance = await createServer([emptyArgsFixture]);
    const res = await post(`${instance.url}/v2/chat`, {
      model: "command-r-plus",
      messages: [{ role: "user", content: "empty-stream-args" }],
      stream: true,
    });

    expect(res.status).toBe(200);
    const events = parseSSEEvents(res.body);
    const tcDeltas = events.filter((e) => e.event === "tool-call-delta");
    const argsAccum = tcDeltas
      .map((e) => {
        const delta = e.data.delta as Record<string, unknown>;
        const msg = delta.message as Record<string, unknown>;
        const calls = msg.tool_calls as Record<string, unknown>;
        const fn = calls.function as Record<string, unknown>;
        return fn.arguments as string;
      })
      .join("");
    expect(argsAccum).toBe("{}");
  });
});

// ─── Integration tests: POST /v2/chat (tool call with empty/missing args non-streaming) ─

describe("POST /v2/chat (non-streaming tool call with empty arguments)", () => {
  it("defaults to '{}' when arguments is empty string", async () => {
    const emptyArgsFixture: Fixture = {
      match: { userMessage: "empty-args-ns" },
      response: {
        toolCalls: [{ name: "fn", arguments: "" }],
      },
    };
    instance = await createServer([emptyArgsFixture]);
    const res = await post(`${instance.url}/v2/chat`, {
      model: "command-r-plus",
      messages: [{ role: "user", content: "empty-args-ns" }],
      stream: false,
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.message.tool_calls[0].function.arguments).toBe("{}");
  });
});

// ─── Integration tests: POST /v2/chat (tool call with no id, non-streaming) ─

describe("POST /v2/chat (non-streaming tool call with no id)", () => {
  it("generates tool call id when fixture provides none", async () => {
    const noIdFixture: Fixture = {
      match: { userMessage: "no-id-ns" },
      response: {
        toolCalls: [{ name: "fn", arguments: '{"x":1}' }],
      },
    };
    instance = await createServer([noIdFixture]);
    const res = await post(`${instance.url}/v2/chat`, {
      model: "command-r-plus",
      messages: [{ role: "user", content: "no-id-ns" }],
      stream: false,
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.message.tool_calls[0].id).toMatch(/^call_/);
  });
});

// ─── Integration tests: POST /v2/chat (error fixture streaming) ─────────────

describe("POST /v2/chat (error fixture streaming)", () => {
  it("returns error fixture with correct status even when stream:true", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v2/chat`, {
      model: "command-r-plus",
      messages: [{ role: "user", content: "fail" }],
      stream: true,
    });

    expect(res.status).toBe(429);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("Rate limited");
  });
});

// ---------------------------------------------------------------------------
// Streaming tool call with explicit fixture id
// ---------------------------------------------------------------------------

describe("POST /v2/chat (streaming tool call with fixture-provided id)", () => {
  const toolFixtureWithId: Fixture = {
    match: { userMessage: "lookup" },
    response: {
      toolCalls: [
        {
          name: "search_db",
          arguments: '{"query":"cats"}',
          id: "call_fixture_custom_123",
        },
      ],
    },
  };

  it("preserves fixture-provided tool call id in streaming events", async () => {
    instance = await createServer([toolFixtureWithId]);
    const res = await post(`${instance.url}/v2/chat`, {
      model: "command-r-plus",
      messages: [{ role: "user", content: "lookup" }],
      stream: true,
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream");

    const events = parseSSEEvents(res.body);

    // tool-call-start should carry the fixture-provided id
    const tcStart = events.find((e) => e.event === "tool-call-start");
    expect(tcStart).toBeDefined();
    const tcStartDelta = tcStart!.data.delta as Record<string, unknown>;
    const tcStartMsg = tcStartDelta.message as Record<string, unknown>;
    const tcStartCalls = tcStartMsg.tool_calls as Record<string, unknown>;
    expect(tcStartCalls.id).toBe("call_fixture_custom_123");
    expect(tcStartCalls.type).toBe("function");
    const tcStartFn = tcStartCalls.function as Record<string, unknown>;
    expect(tcStartFn.name).toBe("search_db");

    // tool-call-delta(s) should accumulate to the full arguments
    const tcDeltas = events.filter((e) => e.event === "tool-call-delta");
    expect(tcDeltas.length).toBeGreaterThanOrEqual(1);
    const argsAccum = tcDeltas
      .map((e) => {
        const delta = e.data.delta as Record<string, unknown>;
        const msg = delta.message as Record<string, unknown>;
        const calls = msg.tool_calls as Record<string, unknown>;
        const fn = calls.function as Record<string, unknown>;
        return fn.arguments as string;
      })
      .join("");
    expect(argsAccum).toBe('{"query":"cats"}');

    // message-end with TOOL_CALL
    const msgEnd = events.find((e) => e.event === "message-end");
    expect(msgEnd).toBeDefined();
    const endDelta = msgEnd!.data.delta as Record<string, unknown>;
    expect(endDelta.finish_reason).toBe("TOOL_CALL");
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

describe("handleCohere (direct handler call, method/url fallbacks)", () => {
  it("uses fallback for text response (non-streaming) with undefined method/url", async () => {
    const fixture: Fixture = {
      match: { userMessage: "hi" },
      response: { content: "Hello" },
    };
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();

    await handleCohere(
      req,
      res,
      JSON.stringify({ model: "cmd-r", messages: [{ role: "user", content: "hi" }] }),
      [fixture],
      journal,
      createDefaults(),
      () => {},
    );

    expect(res._status).toBe(200);
    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.path).toBe("/v2/chat");
  });

  it("uses fallback for streaming text response", async () => {
    const fixture: Fixture = {
      match: { userMessage: "hi" },
      response: { content: "Hello" },
    };
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();

    await handleCohere(
      req,
      res,
      JSON.stringify({ model: "cmd-r", messages: [{ role: "user", content: "hi" }], stream: true }),
      [fixture],
      journal,
      createDefaults(),
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.path).toBe("/v2/chat");
  });

  it("uses fallback for malformed JSON", async () => {
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();

    await handleCohere(req, res, "{bad", [], journal, createDefaults(), () => {});

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.path).toBe("/v2/chat");
  });

  it("uses fallback for missing model", async () => {
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();

    await handleCohere(
      req,
      res,
      JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      [],
      journal,
      createDefaults(),
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.path).toBe("/v2/chat");
  });

  it("uses fallback for missing messages", async () => {
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();

    await handleCohere(
      req,
      res,
      JSON.stringify({ model: "cmd-r" }),
      [],
      journal,
      createDefaults(),
      () => {},
    );

    const entry = journal.getLast();
    expect(entry!.method).toBe("POST");
    expect(entry!.path).toBe("/v2/chat");
  });

  it("uses fallback for no fixture match", async () => {
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();

    await handleCohere(
      req,
      res,
      JSON.stringify({ model: "cmd-r", messages: [{ role: "user", content: "x" }] }),
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

    await handleCohere(
      req,
      res,
      JSON.stringify({ model: "cmd-r", messages: [{ role: "user", content: "x" }] }),
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

    await handleCohere(
      req,
      res,
      JSON.stringify({ model: "cmd-r", messages: [{ role: "user", content: "err" }] }),
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

    await handleCohere(
      req,
      res,
      JSON.stringify({ model: "cmd-r", messages: [{ role: "user", content: "tool" }] }),
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

    await handleCohere(
      req,
      res,
      JSON.stringify({
        model: "cmd-r",
        messages: [{ role: "user", content: "tool" }],
        stream: true,
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

  it("uses fallback for unknown response type", async () => {
    const fixture: Fixture = {
      match: { userMessage: "embed" },
      response: { embedding: [0.1] },
    };
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();

    await handleCohere(
      req,
      res,
      JSON.stringify({ model: "cmd-r", messages: [{ role: "user", content: "embed" }] }),
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

// ─── Cohere reasoning support ──────────────────────────────────────────────

describe("Cohere reasoning support", () => {
  it("includes reasoning as text block in non-streaming text response", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "think" },
        response: { content: "The answer is 42.", reasoning: "Let me reason step by step..." },
      },
    ];
    instance = await createServer(fixtures);
    const res = await post(`${instance.url}/v2/chat`, {
      model: "command-r-plus",
      messages: [{ role: "user", content: "think" }],
    });
    expect(res.status).toBe(200);
    const json = JSON.parse(res.body);
    expect(json.message.content).toHaveLength(2);
    expect(json.message.content[0].text).toBe("Let me reason step by step...");
    expect(json.message.content[1].text).toBe("The answer is 42.");
    expect(json.finish_reason).toBe("COMPLETE");
  });

  it("includes reasoning blocks in streaming text response", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "think-stream" },
        response: { content: "Result.", reasoning: "Thinking..." },
      },
    ];
    instance = await createServer(fixtures);
    const res = await post(`${instance.url}/v2/chat`, {
      model: "command-r-plus",
      messages: [{ role: "user", content: "think-stream" }],
      stream: true,
    });
    expect(res.status).toBe(200);
    const events = parseSSEEvents(res.body);

    // Should have content-start/delta/end for reasoning (index 0) then content (index 1)
    const contentDeltas = events.filter((e) => e.event === "content-delta");
    expect(contentDeltas.length).toBeGreaterThanOrEqual(2);
    // First content delta should be the reasoning text
    const firstDelta = contentDeltas[0].data as {
      delta: { message: { content: { text: string } } };
    };
    expect(firstDelta.delta.message.content.text).toBe("Thinking...");
  });

  it("includes reasoning in content+toolCalls non-streaming response", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "think-tool" },
        response: {
          content: "Let me check.",
          toolCalls: [{ name: "lookup", arguments: '{"q":"test"}' }],
          reasoning: "Need to look this up.",
        },
      },
    ];
    instance = await createServer(fixtures);
    const res = await post(`${instance.url}/v2/chat`, {
      model: "command-r-plus",
      messages: [{ role: "user", content: "think-tool" }],
    });
    expect(res.status).toBe(200);
    const json = JSON.parse(res.body);
    // reasoning block + text block
    expect(json.message.content.length).toBeGreaterThanOrEqual(2);
    expect(json.message.content[0].text).toBe("Need to look this up.");
    expect(json.message.content[1].text).toBe("Let me check.");
    expect(json.message.tool_calls.length).toBe(1);
    expect(json.finish_reason).toBe("TOOL_CALL");
  });
});

// ─── Cohere webSearches warning ────────────────────────────────────────────

describe("Cohere webSearches warning", () => {
  it("logs warning when text response has webSearches", async () => {
    const warnings: string[] = [];
    const logger = new Logger("silent");
    logger.warn = (msg: string) => {
      warnings.push(msg);
    };

    const fixture: Fixture = {
      match: { userMessage: "web" },
      response: { content: "Result.", webSearches: ["test"] },
    };
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();

    await handleCohere(
      req,
      res,
      JSON.stringify({ model: "cmd-r", messages: [{ role: "user", content: "web" }] }),
      [fixture],
      journal,
      createDefaults({ logger }),
      () => {},
    );

    expect(warnings.some((w) => w.includes("webSearches") && w.includes("Cohere"))).toBe(true);
  });

  it("logs warning when content+toolCalls response has webSearches", async () => {
    const warnings: string[] = [];
    const logger = new Logger("silent");
    logger.warn = (msg: string) => {
      warnings.push(msg);
    };

    const fixture: Fixture = {
      match: { userMessage: "web-tool" },
      response: {
        content: "Here.",
        toolCalls: [{ name: "fn", arguments: "{}" }],
        webSearches: ["test"],
      },
    };
    const journal = new Journal();
    const req = createMockReq();
    const res = createMockRes();

    await handleCohere(
      req,
      res,
      JSON.stringify({ model: "cmd-r", messages: [{ role: "user", content: "web-tool" }] }),
      [fixture],
      journal,
      createDefaults({ logger }),
      () => {},
    );

    expect(warnings.some((w) => w.includes("webSearches") && w.includes("Cohere"))).toBe(true);
  });
});

// ─── Cohere response_format forwarding ─────────────────────────────────────

describe("Cohere response_format forwarding", () => {
  it("forwards response_format to ChatCompletionRequest", () => {
    const result = cohereToCompletionRequest({
      model: "command-r-plus",
      messages: [{ role: "user", content: "hello" }],
      response_format: { type: "json_object" },
    } as Parameters<typeof cohereToCompletionRequest>[0]);
    expect(result.response_format).toEqual({ type: "json_object" });
  });

  it("omits response_format when not provided", () => {
    const result = cohereToCompletionRequest({
      model: "command-r-plus",
      messages: [{ role: "user", content: "hello" }],
    } as Parameters<typeof cohereToCompletionRequest>[0]);
    expect(result.response_format).toBeUndefined();
  });
});

// ─── Cohere assistant tool_calls mapping ───────────────────────────────────

describe("Cohere assistant tool_calls mapping", () => {
  it("maps assistant tool_calls to ChatCompletionRequest format", () => {
    const result = cohereToCompletionRequest({
      model: "command-r-plus",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "Using tool",
          tool_calls: [
            {
              id: "tc-1",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"SF"}' },
            },
          ],
        },
        { role: "tool", content: "72F", tool_call_id: "tc-1" },
        { role: "user", content: "thanks" },
      ],
    } as Parameters<typeof cohereToCompletionRequest>[0]);

    const assistantMsg = result.messages.find(
      (m) => m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0,
    );
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.tool_calls).toHaveLength(1);
    expect(assistantMsg!.tool_calls![0].function.name).toBe("get_weather");
    expect(assistantMsg!.tool_calls![0].function.arguments).toBe('{"city":"SF"}');
    expect(assistantMsg!.tool_calls![0].id).toBe("tc-1");
    expect(assistantMsg!.content).toBe("Using tool");
  });

  it("generates tool_call id when not provided", () => {
    const result = cohereToCompletionRequest({
      model: "command-r-plus",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              type: "function",
              function: { name: "fn", arguments: "{}" },
            },
          ],
        },
      ],
    } as Parameters<typeof cohereToCompletionRequest>[0]);

    const assistantMsg = result.messages.find(
      (m) => m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0,
    );
    expect(assistantMsg!.tool_calls![0].id).toBeTruthy();
  });

  it("falls back to plain assistant message when no tool_calls present", () => {
    const result = cohereToCompletionRequest({
      model: "command-r-plus",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "just text" },
      ],
    } as Parameters<typeof cohereToCompletionRequest>[0]);

    const assistantMsg = result.messages.find((m) => m.role === "assistant");
    expect(assistantMsg!.content).toBe("just text");
    expect(assistantMsg!.tool_calls).toBeUndefined();
  });
});

// ─── Cohere ResponseOverrides ──────────────────────────────────────────────

describe("Cohere ResponseOverrides", () => {
  it("applies id override on non-streaming text response", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "ov-id" },
        response: { content: "Hi!", id: "custom-id-123" },
      },
    ];
    instance = await createServer(fixtures);
    const res = await post(`${instance.url}/v2/chat`, {
      model: "command-r-plus",
      messages: [{ role: "user", content: "ov-id" }],
    });
    expect(res.status).toBe(200);
    const json = JSON.parse(res.body);
    expect(json.id).toBe("custom-id-123");
  });

  it("applies finishReason override on non-streaming text response", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "ov-fr" },
        response: { content: "Done.", finishReason: "length" },
      },
    ];
    instance = await createServer(fixtures);
    const res = await post(`${instance.url}/v2/chat`, {
      model: "command-r-plus",
      messages: [{ role: "user", content: "ov-fr" }],
    });
    expect(res.status).toBe(200);
    const json = JSON.parse(res.body);
    expect(json.finish_reason).toBe("MAX_TOKENS");
  });

  it("applies usage override on non-streaming text response", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "ov-usage" },
        response: {
          content: "Done.",
          usage: { prompt_tokens: 10, completion_tokens: 20 },
        },
      },
    ];
    instance = await createServer(fixtures);
    const res = await post(`${instance.url}/v2/chat`, {
      model: "command-r-plus",
      messages: [{ role: "user", content: "ov-usage" }],
    });
    expect(res.status).toBe(200);
    const json = JSON.parse(res.body);
    expect(json.usage.tokens.input_tokens).toBe(10);
    expect(json.usage.tokens.output_tokens).toBe(20);
    expect(json.usage.billed_units.input_tokens).toBe(10);
    expect(json.usage.billed_units.output_tokens).toBe(20);
  });

  it("applies overrides on non-streaming tool call response", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "ov-tc" },
        response: {
          toolCalls: [{ name: "fn", arguments: '{"a":1}' }],
          id: "tc-override-id",
          finishReason: "stop",
        },
      },
    ];
    instance = await createServer(fixtures);
    const res = await post(`${instance.url}/v2/chat`, {
      model: "command-r-plus",
      messages: [{ role: "user", content: "ov-tc" }],
    });
    expect(res.status).toBe(200);
    const json = JSON.parse(res.body);
    expect(json.id).toBe("tc-override-id");
    expect(json.finish_reason).toBe("COMPLETE");
  });
});
