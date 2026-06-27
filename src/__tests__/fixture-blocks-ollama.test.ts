import { describe, it, expect, afterEach } from "vitest";
import { LLMock } from "../llmock.js";

interface OllamaChunk {
  model?: string;
  created_at?: string;
  message?: {
    role?: string;
    content?: string;
    reasoning_content?: string;
    tool_calls?: Array<{ function: { name: string; arguments: unknown } }>;
  };
  done?: boolean;
  [key: string]: unknown;
}

function parseNDJSON(body: string): OllamaChunk[] {
  return body
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as OllamaChunk);
}

async function ollamaChatStream(mock: LLMock, userMessage: string): Promise<OllamaChunk[]> {
  const res = await fetch(`${mock.url}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "llama3.1",
      messages: [{ role: "user", content: userMessage }],
      stream: true,
    }),
  });
  return parseNDJSON(await res.text());
}

describe("Ollama — fixture block ordering (tool-first)", () => {
  let mock: LLMock | null = null;

  afterEach(async () => {
    if (mock) {
      await mock.stop();
      mock = null;
    }
  });

  it("emits the tool_calls chunk before the content chunk when blocks are tool-first", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "test ollama blocks tool-first" },
      response: {
        content: "Here you go.",
        toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
        blocks: [
          { type: "toolCall", name: "get_weather", arguments: '{"city":"NYC"}' },
          { type: "text", text: "Here you go." },
        ],
      },
    });
    await mock.start();

    const chunks = await ollamaChatStream(mock, "test ollama blocks tool-first");

    const toolChunkIdx = chunks.findIndex((c) => c.message?.tool_calls?.length);
    const contentChunkIdx = chunks.findIndex((c) => c.message?.content);

    expect(toolChunkIdx).toBeGreaterThanOrEqual(0);
    expect(contentChunkIdx).toBeGreaterThanOrEqual(0);
    // Tool-first block order: the tool_calls-bearing chunk precedes the content chunk.
    expect(toolChunkIdx).toBeLessThan(contentChunkIdx);

    // Tool call payload is preserved.
    const toolChunk = chunks[toolChunkIdx];
    expect(toolChunk.message!.tool_calls![0].function.name).toBe("get_weather");
    expect(toolChunk.message!.tool_calls![0].function.arguments).toEqual({ city: "NYC" });

    // Content is preserved across content chunks, in order, after the tool call.
    const fullContent = chunks.map((c) => c.message?.content ?? "").join("");
    expect(fullContent).toBe("Here you go.");

    // Final/done chunk preserved exactly as legacy (done:true + timing fields).
    const doneChunk = chunks.at(-1)!;
    expect(doneChunk.done).toBe(true);
    expect(doneChunk).toHaveProperty("total_duration");
  });

  it("back-compat: a no-blocks fixture is byte-identical to the legacy text-first stream", async () => {
    // Legacy fixture (no blocks) drives the untouched else branch.
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "test ollama legacy" },
      response: {
        content: "Let me check.",
        toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
      },
    });
    await mock.start();
    const legacyChunks = await ollamaChatStream(mock, "test ollama legacy");
    await mock.stop();
    mock = null;

    // Same content+toolCalls expressed as text-first blocks should produce the
    // SAME wire order as the legacy path (content chunks first, then tool_calls).
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "test ollama blocks text-first" },
      response: {
        content: "Let me check.",
        toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
        blocks: [
          { type: "text", text: "Let me check." },
          { type: "toolCall", name: "get_weather", arguments: '{"city":"NYC"}' },
        ],
      },
    });
    await mock.start();
    const blockChunks = await ollamaChatStream(mock, "test ollama blocks text-first");

    // Normalize out per-request timestamps that legitimately differ.
    const normalize = (chunks: OllamaChunk[]) =>
      chunks.map((c) => {
        const { created_at, ...rest } = c;
        void created_at;
        return rest;
      });

    const legacyContentIdx = legacyChunks.findIndex((c) => c.message?.content);
    const legacyToolIdx = legacyChunks.findIndex((c) => c.message?.tool_calls?.length);
    const blockContentIdx = blockChunks.findIndex((c) => c.message?.content);
    const blockToolIdx = blockChunks.findIndex((c) => c.message?.tool_calls?.length);

    // Legacy is text-first; text-first blocks must match that ordering.
    expect(legacyContentIdx).toBeLessThan(legacyToolIdx);
    expect(blockContentIdx).toBeLessThan(blockToolIdx);
    expect(normalize(blockChunks)).toEqual(normalize(legacyChunks));
  });
});
