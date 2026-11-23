import { afterEach, describe, expect, it } from "vitest";
import { LLMock } from "../llmock.js";
import type { FixtureResponse } from "../types.js";

const text = { type: "text", text: "hello blocks" } as const;
const empty = { type: "text", text: "" } as const;
const tool = {
  type: "toolCall",
  name: "weather",
  arguments: '{"city":"SF"}',
  id: "call_authored",
} as const;
const legacy = { content: text.text, toolCalls: [tool] };
const cases: {
  name: string;
  response: FixtureResponse;
  content: string;
  order: string[];
  terminal: "normal" | "tool" | "length";
}[] = [
  {
    name: "text only",
    response: { blocks: [text] },
    content: text.text,
    order: ["text"],
    terminal: "normal",
  },
  {
    name: "tool only",
    response: { blocks: [tool] },
    content: "",
    order: ["tool"],
    terminal: "tool",
  },
  {
    name: "tool first",
    response: { blocks: [tool, text] },
    content: text.text,
    order: ["tool", "text"],
    terminal: "tool",
  },
  {
    name: "text first",
    response: { blocks: [text, tool] },
    content: text.text,
    order: ["text", "tool"],
    terminal: "tool",
  },
  {
    name: "trailing empty text",
    response: { blocks: [tool, empty] },
    content: "",
    order: ["tool", "text"],
    terminal: "tool",
  },
  {
    name: "empty text only",
    response: { blocks: [empty] },
    content: "",
    order: ["text"],
    terminal: "normal",
  },
  {
    name: "authoritative text blocks",
    response: { ...legacy, blocks: [text] },
    content: text.text,
    order: ["text"],
    terminal: "normal",
  },
  {
    name: "explicit length override",
    response: { blocks: [text], finishReason: "length" },
    content: text.text,
    order: ["text"],
    terminal: "length",
  },
  {
    name: "explicit normal override on tools",
    response: { blocks: [tool], finishReason: "stop" },
    content: "",
    order: ["tool"],
    terminal: "normal",
  },
  {
    name: "explicit tool override on text",
    response: { blocks: [text], finishReason: "tool_calls" },
    content: text.text,
    order: ["text"],
    terminal: "tool",
  },
  {
    name: "absent blocks legacy",
    response: legacy,
    content: text.text,
    order: ["text", "tool"],
    terminal: "tool",
  },
  {
    name: "empty blocks legacy",
    response: { ...legacy, blocks: [] },
    content: text.text,
    order: ["text", "tool"],
    terminal: "tool",
  },
  {
    name: "legacy empty tools",
    response: { content: text.text, toolCalls: [], blocks: [] },
    content: text.text,
    order: ["text"],
    terminal: "tool",
  },
];

interface ClaudeBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}
interface ClaudeWire {
  type?: string;
  content?: ClaudeBlock[];
  content_block?: ClaudeBlock;
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
  stop_reason?: string;
}
interface GeminiWire {
  candidates: {
    content: {
      parts: {
        text?: string;
        thought?: boolean;
        functionCall?: { id?: string; name: string; args: unknown };
      }[];
    };
    finishReason?: string;
  }[];
}
let mock: LLMock | undefined;
afterEach(async () => {
  await mock?.stop();
  mock = undefined;
});

async function request(provider: "claude" | "gemini", stream: boolean, response: FixtureResponse) {
  mock = new LLMock({ port: 0, latency: 0, chunkSize: 100 });
  mock.addFixture({ match: {}, response });
  await mock.start();
  const path =
    provider === "claude"
      ? "/v1/messages"
      : `/v1beta/models/gemini-2.0-flash:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
  const body =
    provider === "claude"
      ? {
          model: "claude-sonnet-4-6",
          max_tokens: 1024,
          messages: [{ role: "user", content: "outcome" }],
          stream,
        }
      : { contents: [{ role: "user", parts: [{ text: "outcome" }] }] };
  const res = await fetch(mock.url + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  const wire = await res.text();
  return stream
    ? wire
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
    : [wire];
}

function decodeClaude(raw: string[], stream: boolean) {
  const events: ClaudeWire[] = raw.map((line) => JSON.parse(line));
  const blocks = stream
    ? events.flatMap((event) => (event.content_block ? [event.content_block] : []))
    : events.flatMap((event) => event.content ?? []);
  return {
    terminal: events.flatMap((event) =>
      event.stop_reason
        ? [event.stop_reason]
        : event.delta?.stop_reason
          ? [event.delta.stop_reason]
          : [],
    ),
    order: blocks.map((block) => (block.type === "tool_use" ? "tool" : block.type)),
    content: stream
      ? events.map((event) => event.delta?.text ?? "").join("")
      : blocks.map((block) => block.text ?? "").join(""),
    tools: blocks
      .filter((block) => block.type === "tool_use")
      .map((block) => ({ id: block.id, name: block.name })),
    arguments: stream
      ? events.map((event) => event.delta?.partial_json ?? "").join("")
      : blocks
          .filter((block) => block.type === "tool_use")
          .map((block) => JSON.stringify(block.input))
          .join(""),
  };
}
function decodeGemini(raw: string[]) {
  const events: GeminiWire[] = raw.map((line) => JSON.parse(line));
  const candidates = events.flatMap((event) => event.candidates);
  const parts = candidates.flatMap((candidate) => candidate.content.parts);
  return {
    terminal: candidates.flatMap((candidate) =>
      candidate.finishReason ? [candidate.finishReason] : [],
    ),
    order: parts.map((part) => (part.functionCall ? "tool" : "text")),
    content: parts.map((part) => part.text ?? "").join(""),
    tools: parts.flatMap((part) =>
      part.functionCall ? [{ id: part.functionCall.id, name: part.functionCall.name }] : [],
    ),
    arguments: parts
      .flatMap((part) => (part.functionCall ? [JSON.stringify(part.functionCall.args)] : []))
      .join(""),
  };
}
for (const provider of ["claude", "gemini"] as const) {
  for (const stream of [false, true]) {
    describe(`${provider} block outcomes (${stream ? "stream" : "JSON"})`, () => {
      it("preserves reasoning before ordered blocks", async () => {
        const raw = await request(provider, stream, {
          blocks: [tool, text],
          reasoning: "consider carefully",
        });
        const result = provider === "claude" ? decodeClaude(raw, stream) : decodeGemini(raw);
        expect(result.terminal).toEqual([provider === "claude" ? "tool_use" : "FUNCTION_CALL"]);
        expect(result.tools).toEqual([{ id: tool.id, name: tool.name }]);
        expect(result.arguments).toBe(tool.arguments);
        if (provider === "claude") {
          expect(result.order).toEqual(["thinking", "tool", "text"]);
          expect(result.content).toBe(text.text);
        } else {
          expect(result.order).toEqual(["text", "tool", "text"]);
          expect(result.content).toBe("consider carefully" + text.text);
          const first: GeminiWire = JSON.parse(raw[0]);
          expect(first.candidates[0].content.parts[0].thought).toBe(true);
        }
        expect(raw.join("\n")).toContain("consider carefully");
      });
      it.each(cases)("$name", async ({ response, content, order, terminal }) => {
        const raw = await request(provider, stream, response);
        const result = provider === "claude" ? decodeClaude(raw, stream) : decodeGemini(raw);
        const reasons =
          provider === "claude"
            ? { normal: "end_turn", tool: "tool_use", length: "max_tokens" }
            : { normal: "STOP", tool: "FUNCTION_CALL", length: "MAX_TOKENS" };
        expect(result.terminal).toEqual([reasons[terminal]]);
        expect(result.content).toBe(content);
        expect(result.order).toEqual(order);
        expect(result.tools).toEqual(
          order.includes("tool") ? [{ id: tool.id, name: tool.name }] : [],
        );
        expect(result.arguments).toBe(order.includes("tool") ? tool.arguments : "");
      });
    });
  }
}
