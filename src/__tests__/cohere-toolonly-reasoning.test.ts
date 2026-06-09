import { describe, it, expect, afterEach, vi } from "vitest";
import * as http from "node:http";
import type { Fixture } from "../types.js";
import { createServer, type ServerInstance } from "../server.js";

// ─── HTTP helper ────────────────────────────────────────────────────────────

function post(
  url: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
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
          ...extraHeaders,
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

interface CohereToolOnlyResponse {
  message: {
    content: { type: string; text: string }[];
    tool_calls: { function: { name: string } }[];
  };
}

/** Extract every text-block string emitted by a non-streaming Cohere response. */
function nonStreamTexts(rawBody: string): string[] {
  const body = JSON.parse(rawBody) as CohereToolOnlyResponse;
  return body.message.content.filter((b) => b.type === "text").map((b) => b.text);
}

/** Tool-call names emitted by a non-streaming Cohere tool-only response. */
function nonStreamToolNames(rawBody: string): string[] {
  const body = JSON.parse(rawBody) as CohereToolOnlyResponse;
  return body.message.tool_calls.map((tc) => tc.function.name);
}

/** Concatenate all content-delta text slices from a streamed Cohere response. */
function streamDeltaTexts(rawBody: string): string {
  const events = parseSSEEvents(rawBody);
  return events
    .filter((e) => e.event === "content-delta")
    .map((e) => {
      const delta = e.data.delta as
        | { message?: { content?: { type?: string; text?: string } } }
        | undefined;
      return delta?.message?.content?.text ?? "";
    })
    .join("");
}

/** Did the stream emit any tool-call-start event? */
function streamHasToolCall(rawBody: string): boolean {
  return parseSSEEvents(rawBody).some((e) => e.event === "tool-call-start");
}

const REASONING = "Let me think step by step about which tool to call.";

// ─── Fixtures (tool-call-only: toolCalls present, no content) ────────────────

const reasoningToolOnlyFixture: Fixture = {
  match: { userMessage: "weather-only" },
  response: {
    reasoning: REASONING,
    toolCalls: [{ name: "get_weather", arguments: '{"city":"SF"}' }],
  },
};

const noReasoningToolOnlyFixture: Fixture = {
  match: { userMessage: "plain-tool" },
  response: {
    toolCalls: [{ name: "get_weather", arguments: '{"city":"SF"}' }],
  },
};

const allFixtures: Fixture[] = [reasoningToolOnlyFixture, noReasoningToolOnlyFixture];

const COHERE_PATH = "/v2/chat";

function chatReq(model: string, userMessage: string, stream = false): unknown {
  return { model, stream, messages: [{ role: "user", content: userMessage }] };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

let instance: ServerInstance | null = null;

afterEach(async () => {
  if (instance) {
    await new Promise<void>((resolve) => instance!.server.close(() => resolve()));
    instance = null;
  }
  vi.restoreAllMocks();
});

describe("Cohere tool-only reasoning capability gating", () => {
  describe("reasoning-capable model", () => {
    it("emits reasoning text block alongside the tool call (non-stream)", async () => {
      instance = await createServer(allFixtures, { port: 0 });
      const res = await post(
        `${instance.url}${COHERE_PATH}`,
        chatReq("command-a-reasoning", "weather-only"),
      );
      expect(res.status).toBe(200);
      expect(nonStreamTexts(res.body)).toContain(REASONING);
      expect(nonStreamToolNames(res.body)).toContain("get_weather");
    });

    it("emits reasoning deltas alongside the tool call (stream)", async () => {
      instance = await createServer(allFixtures, { port: 0 });
      const res = await post(
        `${instance.url}${COHERE_PATH}`,
        chatReq("command-a-reasoning", "weather-only", true),
      );
      expect(streamDeltaTexts(res.body)).toContain(REASONING);
      expect(streamHasToolCall(res.body)).toBe(true);
    });
  });

  describe("non-reasoning model + reasoning fixture", () => {
    it("strict OFF: still emits reasoning and warns (non-stream)", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      instance = await createServer(allFixtures, { port: 0, logLevel: "warn" });
      const res = await post(`${instance.url}${COHERE_PATH}`, chatReq("gpt-4.1", "weather-only"));
      expect(res.status).toBe(200);
      expect(nonStreamTexts(res.body)).toContain(REASONING);
      expect(nonStreamToolNames(res.body)).toContain("get_weather");
      expect(warnSpy).toHaveBeenCalled();
      const warned = warnSpy.mock.calls.flat().join(" ");
      expect(warned).toContain("gpt-4.1");
      expect(warned).toContain("not reasoning-capable");
    });

    it("strict OFF: still emits reasoning deltas + warns (stream)", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      instance = await createServer(allFixtures, { port: 0, logLevel: "warn" });
      const res = await post(
        `${instance.url}${COHERE_PATH}`,
        chatReq("gpt-4.1", "weather-only", true),
      );
      expect(streamDeltaTexts(res.body)).toContain(REASONING);
      expect(streamHasToolCall(res.body)).toBe(true);
      expect(warnSpy).toHaveBeenCalled();
    });

    it("strict ON: suppresses reasoning, keeps tool call + logs error (non-stream)", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      instance = await createServer(allFixtures, { port: 0, logLevel: "warn" });
      const res = await post(`${instance.url}${COHERE_PATH}`, chatReq("gpt-4.1", "weather-only"), {
        "X-AIMock-Strict": "true",
      });
      expect(res.status).toBe(200);
      expect(nonStreamTexts(res.body)).not.toContain(REASONING);
      expect(nonStreamToolNames(res.body)).toContain("get_weather");
      expect(errorSpy).toHaveBeenCalled();
      const errored = errorSpy.mock.calls.flat().join(" ");
      expect(errored).toContain("gpt-4.1");
    });

    it("strict ON: suppresses reasoning deltas, keeps tool call (stream)", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      instance = await createServer(allFixtures, { port: 0, logLevel: "warn" });
      const res = await post(
        `${instance.url}${COHERE_PATH}`,
        chatReq("gpt-4.1", "weather-only", true),
        { "X-AIMock-Strict": "true" },
      );
      expect(streamDeltaTexts(res.body)).not.toContain(REASONING);
      expect(streamHasToolCall(res.body)).toBe(true);
    });
  });

  describe("reasoning absent (no-op)", () => {
    it("non-reasoning model, no fixture reasoning: tool call only, no warn/error (non-stream)", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      instance = await createServer(allFixtures, { port: 0, logLevel: "warn" });
      const res = await post(`${instance.url}${COHERE_PATH}`, chatReq("gpt-4.1", "plain-tool"));
      expect(res.status).toBe(200);
      expect(nonStreamTexts(res.body)).toEqual([]);
      expect(nonStreamToolNames(res.body)).toContain("get_weather");
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it("no fixture reasoning: tool call only, no reasoning deltas (stream)", async () => {
      instance = await createServer(allFixtures, { port: 0 });
      const res = await post(
        `${instance.url}${COHERE_PATH}`,
        chatReq("gpt-4.1", "plain-tool", true),
      );
      expect(streamDeltaTexts(res.body)).toBe("");
      expect(streamHasToolCall(res.body)).toBe(true);
    });
  });
});
