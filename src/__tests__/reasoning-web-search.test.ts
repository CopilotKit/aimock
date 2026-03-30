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
  type: string;
  [key: string]: unknown;
}

function parseResponsesSSEEvents(body: string): SSEEvent[] {
  const events: SSEEvent[] = [];
  const lines = body.split("\n");
  for (const line of lines) {
    if (line.startsWith("data: ")) {
      events.push(JSON.parse(line.slice(6)) as SSEEvent);
    }
  }
  return events;
}

const parseClaudeSSEEvents = parseResponsesSSEEvents;

// --- fixtures ---

const reasoningFixture: Fixture = {
  match: { userMessage: "think" },
  response: {
    content: "The answer is 42.",
    reasoning: "Let me think step by step about this problem.",
  },
};

const webSearchFixture: Fixture = {
  match: { userMessage: "search" },
  response: {
    content: "Here are the results.",
    webSearches: ["latest news", "weather forecast"],
  },
};

const combinedFixture: Fixture = {
  match: { userMessage: "combined" },
  response: {
    content: "Based on my analysis and research.",
    reasoning: "I need to reason through this carefully.",
    webSearches: ["relevant data"],
  },
};

const plainFixture: Fixture = {
  match: { userMessage: "plain" },
  response: { content: "Just plain text." },
};

const allFixtures: Fixture[] = [reasoningFixture, webSearchFixture, combinedFixture, plainFixture];

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

// ─── Responses API: Reasoning events ─────────────────────────────────────────

describe("POST /v1/responses (reasoning streaming)", () => {
  it("emits reasoning events before text events", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [{ role: "user", content: "think" }],
      stream: true,
    });

    expect(res.status).toBe(200);
    const events = parseResponsesSSEEvents(res.body);
    const types = events.map((e) => e.type);

    expect(types).toContain("response.output_item.added");
    expect(types).toContain("response.reasoning_summary_part.added");
    expect(types).toContain("response.reasoning_summary_text.delta");
    expect(types).toContain("response.reasoning_summary_text.done");
    expect(types).toContain("response.reasoning_summary_part.done");

    const reasoningDoneIdx = types.indexOf("response.reasoning_summary_text.done");
    const firstTextDelta = types.indexOf("response.output_text.delta");
    expect(reasoningDoneIdx).toBeLessThan(firstTextDelta);
  });

  it("reasoning deltas reconstruct full reasoning text", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [{ role: "user", content: "think" }],
      stream: true,
    });

    const events = parseResponsesSSEEvents(res.body);
    const reasoningDeltas = events.filter(
      (e) => e.type === "response.reasoning_summary_text.delta",
    );
    const fullReasoning = reasoningDeltas.map((d) => d.delta).join("");
    expect(fullReasoning).toBe("Let me think step by step about this problem.");
  });

  it("text deltas still reconstruct full content", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [{ role: "user", content: "think" }],
      stream: true,
    });

    const events = parseResponsesSSEEvents(res.body);
    const textDeltas = events.filter((e) => e.type === "response.output_text.delta");
    const fullText = textDeltas.map((d) => d.delta).join("");
    expect(fullText).toBe("The answer is 42.");
  });

  it("response.completed includes reasoning output item", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [{ role: "user", content: "think" }],
      stream: true,
    });

    const events = parseResponsesSSEEvents(res.body);
    const completed = events.find((e) => e.type === "response.completed") as SSEEvent & {
      response: { output: { type: string }[] };
    };
    expect(completed).toBeDefined();
    expect(completed.response.output.length).toBeGreaterThanOrEqual(2);
    expect(completed.response.output[0].type).toBe("reasoning");
    expect(completed.response.output[completed.response.output.length - 1].type).toBe("message");
  });
});

// ─── Responses API: Web search events ────────────────────────────────────────

describe("POST /v1/responses (web search streaming)", () => {
  it("emits web search events before text events", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [{ role: "user", content: "search" }],
      stream: true,
    });

    expect(res.status).toBe(200);
    const events = parseResponsesSSEEvents(res.body);
    const types = events.map((e) => e.type);

    const searchAddedEvents = events.filter(
      (e) =>
        e.type === "response.output_item.added" &&
        (e.item as { type: string })?.type === "web_search_call",
    );
    expect(searchAddedEvents).toHaveLength(2);

    const searchDoneEvents = events.filter(
      (e) =>
        e.type === "response.output_item.done" &&
        (e.item as { type: string })?.type === "web_search_call",
    );
    expect(searchDoneEvents).toHaveLength(2);

    const lastSearchDoneIdx = events.reduce(
      (acc, e, idx) =>
        e.type === "response.output_item.done" &&
        (e.item as { type: string })?.type === "web_search_call"
          ? idx
          : acc,
      -1,
    );
    const firstTextDelta = types.indexOf("response.output_text.delta");
    expect(lastSearchDoneIdx).toBeLessThan(firstTextDelta);
  });

  it("web search items contain query strings", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [{ role: "user", content: "search" }],
      stream: true,
    });

    const events = parseResponsesSSEEvents(res.body);
    const searchDone = events.filter(
      (e) =>
        e.type === "response.output_item.done" &&
        (e.item as { type: string })?.type === "web_search_call",
    ) as (SSEEvent & { item: { query: string } })[];

    expect(searchDone[0].item.query).toBe("latest news");
    expect(searchDone[1].item.query).toBe("weather forecast");
  });

  it("response.completed includes web search output items", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [{ role: "user", content: "search" }],
      stream: true,
    });

    const events = parseResponsesSSEEvents(res.body);
    const completed = events.find((e) => e.type === "response.completed") as SSEEvent & {
      response: { output: { type: string; query?: string }[] };
    };
    expect(completed).toBeDefined();

    const searchOutputs = completed.response.output.filter((o) => o.type === "web_search_call");
    expect(searchOutputs).toHaveLength(2);
    expect(searchOutputs[0].query).toBe("latest news");
    expect(searchOutputs[1].query).toBe("weather forecast");
  });
});

// ─── Responses API: Combined reasoning + web search + text ───────────────────

describe("POST /v1/responses (combined reasoning + web search)", () => {
  it("emits reasoning, then web search, then text events in order", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [{ role: "user", content: "combined" }],
      stream: true,
    });

    expect(res.status).toBe(200);
    const events = parseResponsesSSEEvents(res.body);
    const types = events.map((e) => e.type);

    expect(types).toContain("response.reasoning_summary_text.delta");

    const webSearchAdded = events.filter(
      (e) =>
        e.type === "response.output_item.added" &&
        (e.item as { type: string })?.type === "web_search_call",
    );
    expect(webSearchAdded).toHaveLength(1);

    expect(types).toContain("response.output_text.delta");

    const reasoningDoneIdx = types.indexOf("response.reasoning_summary_text.done");
    const firstWebSearch = events.findIndex(
      (e) =>
        e.type === "response.output_item.added" &&
        (e.item as { type: string })?.type === "web_search_call",
    );
    const firstTextDelta = types.indexOf("response.output_text.delta");

    expect(reasoningDoneIdx).toBeLessThan(firstWebSearch);
    expect(firstWebSearch).toBeLessThan(firstTextDelta);
  });

  it("response.completed output includes all item types in order", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [{ role: "user", content: "combined" }],
      stream: true,
    });

    const events = parseResponsesSSEEvents(res.body);
    const completed = events.find((e) => e.type === "response.completed") as SSEEvent & {
      response: { output: { type: string }[] };
    };
    expect(completed).toBeDefined();

    const outputTypes = completed.response.output.map((o) => o.type);
    expect(outputTypes).toEqual(["reasoning", "web_search_call", "message"]);
  });
});

// ─── Responses API: Non-streaming with reasoning ─────────────────────────────

describe("POST /v1/responses (non-streaming with reasoning)", () => {
  it("includes reasoning output item in non-streaming response", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [{ role: "user", content: "think" }],
      stream: false,
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.object).toBe("response");
    expect(body.status).toBe("completed");

    expect(body.output.length).toBeGreaterThanOrEqual(2);
    expect(body.output[0].type).toBe("reasoning");
    expect(body.output[0].summary[0].text).toBe("Let me think step by step about this problem.");
    expect(body.output[body.output.length - 1].type).toBe("message");
    expect(body.output[body.output.length - 1].content[0].text).toBe("The answer is 42.");
  });

  it("includes web search output items in non-streaming response", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [{ role: "user", content: "search" }],
      stream: false,
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);

    const searchOutputs = body.output.filter((o: { type: string }) => o.type === "web_search_call");
    expect(searchOutputs).toHaveLength(2);
    expect(searchOutputs[0].query).toBe("latest news");
    expect(searchOutputs[1].query).toBe("weather forecast");
  });

  it("combined non-streaming response has correct output order", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [{ role: "user", content: "combined" }],
      stream: false,
    });

    const body = JSON.parse(res.body);
    const outputTypes = body.output.map((o: { type: string }) => o.type);
    expect(outputTypes).toEqual(["reasoning", "web_search_call", "message"]);
  });
});

// ─── Responses API: Plain text still works ───────────────────────────────────

describe("POST /v1/responses (backward compatibility)", () => {
  it("plain text fixture works without reasoning or web search", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [{ role: "user", content: "plain" }],
      stream: true,
    });

    expect(res.status).toBe(200);
    const events = parseResponsesSSEEvents(res.body);
    const types = events.map((e) => e.type);

    expect(types).not.toContain("response.reasoning_summary_text.delta");

    const webSearchEvents = events.filter(
      (e) =>
        e.type === "response.output_item.added" &&
        (e.item as { type: string })?.type === "web_search_call",
    );
    expect(webSearchEvents).toHaveLength(0);

    const deltas = events.filter((e) => e.type === "response.output_text.delta");
    const fullText = deltas.map((d) => d.delta).join("");
    expect(fullText).toBe("Just plain text.");
  });

  it("plain text non-streaming response has no extra output items", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/responses`, {
      model: "gpt-4",
      input: [{ role: "user", content: "plain" }],
      stream: false,
    });

    const body = JSON.parse(res.body);
    expect(body.output).toHaveLength(1);
    expect(body.output[0].type).toBe("message");
  });
});

// ─── Anthropic Claude: Thinking blocks ───────────────────────────────────────

describe("POST /v1/messages (thinking blocks streaming)", () => {
  it("emits thinking block before text block when reasoning is present", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "think" }],
      stream: true,
    });

    expect(res.status).toBe(200);
    const events = parseClaudeSSEEvents(res.body);
    const types = events.map((e) => e.type);

    expect(types[0]).toBe("message_start");

    const blockStarts = events.filter((e) => e.type === "content_block_start");
    expect(blockStarts).toHaveLength(2);

    const thinkingBlock = blockStarts[0] as SSEEvent & {
      index: number;
      content_block: { type: string };
    };
    expect(thinkingBlock.index).toBe(0);
    expect(thinkingBlock.content_block.type).toBe("thinking");

    const textBlock = blockStarts[1] as SSEEvent & {
      index: number;
      content_block: { type: string };
    };
    expect(textBlock.index).toBe(1);
    expect(textBlock.content_block.type).toBe("text");
  });

  it("thinking deltas reconstruct full reasoning text", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "think" }],
      stream: true,
    });

    const events = parseClaudeSSEEvents(res.body);
    const thinkingDeltas = events.filter(
      (e) =>
        e.type === "content_block_delta" &&
        (e.delta as { type: string })?.type === "thinking_delta",
    ) as (SSEEvent & { delta: { thinking: string } })[];

    expect(thinkingDeltas.length).toBeGreaterThan(0);
    const fullThinking = thinkingDeltas.map((d) => d.delta.thinking).join("");
    expect(fullThinking).toBe("Let me think step by step about this problem.");
  });

  it("text deltas still reconstruct full content after thinking", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "think" }],
      stream: true,
    });

    const events = parseClaudeSSEEvents(res.body);
    const textDeltas = events.filter(
      (e) =>
        e.type === "content_block_delta" && (e.delta as { type: string })?.type === "text_delta",
    ) as (SSEEvent & { delta: { text: string } })[];

    const fullText = textDeltas.map((d) => d.delta.text).join("");
    expect(fullText).toBe("The answer is 42.");
  });

  it("no thinking blocks when reasoning is absent", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "plain" }],
      stream: true,
    });

    const events = parseClaudeSSEEvents(res.body);
    const thinkingBlocks = events.filter(
      (e) =>
        e.type === "content_block_start" &&
        (e.content_block as { type: string })?.type === "thinking",
    );
    expect(thinkingBlocks).toHaveLength(0);

    const blockStarts = events.filter((e) => e.type === "content_block_start");
    expect(blockStarts).toHaveLength(1);
    expect((blockStarts[0].content_block as { type: string }).type).toBe("text");
  });
});

describe("POST /v1/messages (thinking blocks non-streaming)", () => {
  it("includes thinking block in non-streaming response", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "think" }],
      stream: false,
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.type).toBe("message");
    expect(body.content).toHaveLength(2);
    expect(body.content[0].type).toBe("thinking");
    expect(body.content[0].thinking).toBe("Let me think step by step about this problem.");
    expect(body.content[1].type).toBe("text");
    expect(body.content[1].text).toBe("The answer is 42.");
  });

  it("no thinking block in non-streaming response when reasoning is absent", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "plain" }],
      stream: false,
    });

    const body = JSON.parse(res.body);
    expect(body.content).toHaveLength(1);
    expect(body.content[0].type).toBe("text");
  });
});
