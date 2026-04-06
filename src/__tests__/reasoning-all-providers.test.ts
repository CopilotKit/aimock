import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import type { Fixture } from "../types.js";
import { createServer, type ServerInstance } from "../server.js";

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

interface SSEEvent {
  type?: string;
  choices?: {
    delta: { content?: string; reasoning_content?: string; role?: string };
    finish_reason: string | null;
  }[];
  [key: string]: unknown;
}

function parseSSEEvents(body: string): SSEEvent[] {
  const events: SSEEvent[] = [];
  for (const line of body.split("\n")) {
    if (line.startsWith("data: ") && line.slice(6).trim() !== "[DONE]") {
      events.push(JSON.parse(line.slice(6)) as SSEEvent);
    }
  }
  return events;
}

// --- fixtures ---

const reasoningFixture: Fixture = {
  match: { userMessage: "think" },
  response: {
    content: "The answer is 42.",
    reasoning: "Let me think step by step about this problem.",
  },
};

const plainFixture: Fixture = {
  match: { userMessage: "plain" },
  response: { content: "Just plain text." },
};

const allFixtures: Fixture[] = [reasoningFixture, plainFixture];

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

// ─── OpenAI Chat Completions: Reasoning ─────────────────────────────────────

describe("POST /v1/chat/completions (reasoning non-streaming)", () => {
  it("includes reasoning_content field on assistant message", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "think" }],
      stream: false,
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.choices[0].message.content).toBe("The answer is 42.");
    expect(body.choices[0].message.reasoning_content).toBe(
      "Let me think step by step about this problem.",
    );
  });

  it("omits reasoning_content when reasoning is absent", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "plain" }],
      stream: false,
    });

    const body = JSON.parse(res.body);
    expect(body.choices[0].message.content).toBe("Just plain text.");
    expect(body.choices[0].message.reasoning_content).toBeUndefined();
  });
});

describe("POST /v1/chat/completions (reasoning streaming)", () => {
  it("emits reasoning_content deltas before content deltas", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "think" }],
      stream: true,
    });

    expect(res.status).toBe(200);
    const events = parseSSEEvents(res.body);

    const reasoningDeltas = events
      .filter((e) => e.choices?.[0]?.delta?.reasoning_content !== undefined)
      .map((e) => e.choices![0].delta.reasoning_content);
    expect(reasoningDeltas.join("")).toBe("Let me think step by step about this problem.");

    const contentDeltas = events
      .filter(
        (e) => e.choices?.[0]?.delta?.content !== undefined && e.choices[0].delta.content !== "",
      )
      .map((e) => e.choices![0].delta.content);
    expect(contentDeltas.join("")).toBe("The answer is 42.");

    const lastReasoningIdx = events.reduce(
      (acc, e, idx) => (e.choices?.[0]?.delta?.reasoning_content !== undefined ? idx : acc),
      -1,
    );
    const firstContentIdx = events.findIndex(
      (e) => e.choices?.[0]?.delta?.content !== undefined && e.choices[0].delta.content !== "",
    );
    expect(lastReasoningIdx).toBeLessThan(firstContentIdx);
  });

  it("no reasoning_content deltas when reasoning is absent", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "plain" }],
      stream: true,
    });

    const events = parseSSEEvents(res.body);
    const reasoningDeltas = events.filter(
      (e) => e.choices?.[0]?.delta?.reasoning_content !== undefined,
    );
    expect(reasoningDeltas).toHaveLength(0);
  });
});

// ─── Gemini: Reasoning ──────────────────────────────────────────────────────

function parseGeminiSSEChunks(body: string): unknown[] {
  const chunks: unknown[] = [];
  for (const line of body.split("\n")) {
    if (line.startsWith("data: ")) {
      chunks.push(JSON.parse(line.slice(6)));
    }
  }
  return chunks;
}

describe("POST /v1beta/models/{model}:generateContent (reasoning non-streaming)", () => {
  it("includes thought part before text part", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1beta/models/gemini-2.5-flash:generateContent`, {
      contents: [{ role: "user", parts: [{ text: "think" }] }],
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    const parts = body.candidates[0].content.parts;
    expect(parts).toHaveLength(2);
    expect(parts[0].thought).toBe(true);
    expect(parts[0].text).toBe("Let me think step by step about this problem.");
    expect(parts[1].text).toBe("The answer is 42.");
    expect(parts[1].thought).toBeUndefined();
  });

  it("no thought part when reasoning is absent", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1beta/models/gemini-2.5-flash:generateContent`, {
      contents: [{ role: "user", parts: [{ text: "plain" }] }],
    });

    const body = JSON.parse(res.body);
    const parts = body.candidates[0].content.parts;
    expect(parts).toHaveLength(1);
    expect(parts[0].text).toBe("Just plain text.");
    expect(parts[0].thought).toBeUndefined();
  });
});

describe("POST /v1beta/models/{model}:streamGenerateContent (reasoning streaming)", () => {
  it("streams thought chunks before text chunks", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1beta/models/gemini-2.5-flash:streamGenerateContent`, {
      contents: [{ role: "user", parts: [{ text: "think" }] }],
    });

    expect(res.status).toBe(200);
    const chunks = parseGeminiSSEChunks(res.body) as {
      candidates: {
        content: { role: string; parts: { text?: string; thought?: boolean }[] };
        finishReason?: string;
      }[];
    }[];

    const thoughtChunks = chunks.filter((c) => c.candidates[0].content.parts[0].thought === true);
    const textChunks = chunks.filter((c) => c.candidates[0].content.parts[0].thought === undefined);

    expect(thoughtChunks.length).toBeGreaterThan(0);
    expect(textChunks.length).toBeGreaterThan(0);

    const fullThought = thoughtChunks
      .map((c) => c.candidates[0].content.parts[0].text ?? "")
      .join("");
    expect(fullThought).toBe("Let me think step by step about this problem.");

    const fullText = textChunks.map((c) => c.candidates[0].content.parts[0].text ?? "").join("");
    expect(fullText).toBe("The answer is 42.");

    const lastChunk = chunks[chunks.length - 1];
    expect(lastChunk.candidates[0].finishReason).toBe("STOP");
  });

  it("no thought chunks when reasoning is absent", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1beta/models/gemini-2.5-flash:streamGenerateContent`, {
      contents: [{ role: "user", parts: [{ text: "plain" }] }],
    });

    const chunks = parseGeminiSSEChunks(res.body) as {
      candidates: {
        content: { parts: { text?: string; thought?: boolean }[] };
      }[];
    }[];

    const thoughtChunks = chunks.filter((c) => c.candidates[0].content.parts[0].thought === true);
    expect(thoughtChunks).toHaveLength(0);
  });
});
