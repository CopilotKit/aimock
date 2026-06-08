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

interface CohereTextResponse {
  message: { content: { type: string; text: string }[] };
}

/** Extract every text-block string emitted by a non-streaming Cohere response. */
function nonStreamTexts(rawBody: string): string[] {
  const body = JSON.parse(rawBody) as CohereTextResponse;
  return body.message.content.filter((b) => b.type === "text").map((b) => b.text);
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

const REASONING = "Let me think step by step about this problem.";
const CONTENT = "The capital of France is Paris.";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const reasoningFixture: Fixture = {
  match: { userMessage: "hello" },
  response: { content: CONTENT, reasoning: REASONING },
};

const noReasoningFixture: Fixture = {
  match: { userMessage: "plain" },
  response: { content: CONTENT },
};

const reasoningWithToolFixture: Fixture = {
  match: { userMessage: "weather" },
  response: {
    content: CONTENT,
    reasoning: REASONING,
    toolCalls: [{ name: "get_weather", arguments: '{"city":"SF"}' }],
  },
};

const allFixtures: Fixture[] = [reasoningFixture, noReasoningFixture, reasoningWithToolFixture];

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

describe("Cohere reasoning capability gating", () => {
  describe("reasoning-capable model", () => {
    it("emits the reasoning text block (non-stream)", async () => {
      instance = await createServer(allFixtures, { port: 0 });
      const res = await post(
        `${instance.url}${COHERE_PATH}`,
        chatReq("command-a-reasoning", "hello"),
      );
      expect(res.status).toBe(200);
      const texts = nonStreamTexts(res.body);
      // capable model leaves reasoning untouched: reasoning block precedes content
      expect(texts).toContain(REASONING);
      expect(texts).toContain(CONTENT);
    });

    it("emits reasoning deltas (stream)", async () => {
      instance = await createServer(allFixtures, { port: 0 });
      const res = await post(
        `${instance.url}${COHERE_PATH}`,
        chatReq("command-a-reasoning", "hello", true),
      );
      expect(streamDeltaTexts(res.body)).toContain(REASONING);
    });
  });

  describe("non-reasoning model + reasoning fixture", () => {
    it("strict OFF: still emits reasoning and logs a warn (non-stream)", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      instance = await createServer(allFixtures, { port: 0, logLevel: "warn" });
      const res = await post(`${instance.url}${COHERE_PATH}`, chatReq("gpt-4.1", "hello"));
      expect(res.status).toBe(200);
      expect(nonStreamTexts(res.body)).toContain(REASONING);
      expect(warnSpy).toHaveBeenCalled();
      const warned = warnSpy.mock.calls.flat().join(" ");
      expect(warned).toContain("gpt-4.1");
      expect(warned).toContain("not reasoning-capable");
    });

    it("strict OFF: still emits reasoning deltas + warns (stream)", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      instance = await createServer(allFixtures, { port: 0, logLevel: "warn" });
      const res = await post(`${instance.url}${COHERE_PATH}`, chatReq("gpt-4.1", "hello", true));
      expect(streamDeltaTexts(res.body)).toContain(REASONING);
      expect(warnSpy).toHaveBeenCalled();
    });

    it("strict ON: suppresses reasoning and logs an error (non-stream)", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      instance = await createServer(allFixtures, { port: 0, logLevel: "warn" });
      const res = await post(`${instance.url}${COHERE_PATH}`, chatReq("gpt-4.1", "hello"), {
        "X-AIMock-Strict": "true",
      });
      expect(res.status).toBe(200);
      const texts = nonStreamTexts(res.body);
      expect(texts).not.toContain(REASONING);
      expect(texts).toContain(CONTENT);
      expect(errorSpy).toHaveBeenCalled();
      const errored = errorSpy.mock.calls.flat().join(" ");
      expect(errored).toContain("gpt-4.1");
    });

    it("strict ON: suppresses reasoning deltas (stream)", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      instance = await createServer(allFixtures, { port: 0, logLevel: "warn" });
      const res = await post(`${instance.url}${COHERE_PATH}`, chatReq("gpt-4.1", "hello", true), {
        "X-AIMock-Strict": "true",
      });
      const streamed = streamDeltaTexts(res.body);
      expect(streamed).not.toContain(REASONING);
      expect(streamed).toContain(CONTENT);
    });
  });

  describe("content + tool calls branch", () => {
    it("strict ON: suppresses reasoning, keeps content + tool call (non-stream)", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      instance = await createServer(allFixtures, { port: 0, logLevel: "warn" });
      const res = await post(`${instance.url}${COHERE_PATH}`, chatReq("gpt-4.1", "weather"), {
        "X-AIMock-Strict": "true",
      });
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body) as {
        message: { content: { type: string; text: string }[]; tool_calls: unknown[] };
      };
      const texts = body.message.content.filter((b) => b.type === "text").map((b) => b.text);
      expect(texts).not.toContain(REASONING);
      expect(texts).toContain(CONTENT);
      expect(body.message.tool_calls.length).toBeGreaterThan(0);
    });

    it("capable model: emits reasoning in content+tool stream", async () => {
      instance = await createServer(allFixtures, { port: 0 });
      const res = await post(
        `${instance.url}${COHERE_PATH}`,
        chatReq("command-a-reasoning", "weather", true),
      );
      expect(streamDeltaTexts(res.body)).toContain(REASONING);
    });
  });

  describe("reasoning absent", () => {
    it("non-reasoning model, no fixture reasoning: no warn, no error (non-stream)", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      instance = await createServer(allFixtures, { port: 0, logLevel: "warn" });
      const res = await post(`${instance.url}${COHERE_PATH}`, chatReq("gpt-4.1", "plain"));
      expect(res.status).toBe(200);
      expect(nonStreamTexts(res.body)).toEqual([CONTENT]);
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it("strict ON + no fixture reasoning: short-circuits, no error (non-stream)", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      instance = await createServer(allFixtures, { port: 0, logLevel: "warn" });
      const res = await post(`${instance.url}${COHERE_PATH}`, chatReq("gpt-4.1", "plain"), {
        "X-AIMock-Strict": "true",
      });
      expect(res.status).toBe(200);
      expect(nonStreamTexts(res.body)).toEqual([CONTENT]);
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });

  describe("unknown model", () => {
    it("emits reasoning with no warn (fail-open default)", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      instance = await createServer(allFixtures, { port: 0, logLevel: "warn" });
      const res = await post(`${instance.url}${COHERE_PATH}`, chatReq("command-future-x", "hello"));
      expect(res.status).toBe(200);
      expect(nonStreamTexts(res.body)).toContain(REASONING);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});
