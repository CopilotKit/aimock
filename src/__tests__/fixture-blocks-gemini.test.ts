import { describe, it, expect, afterEach } from "vitest";
import { LLMock } from "../llmock.js";

type GeminiStreamChunk = {
  candidates: Array<{
    content: { parts: Array<{ text?: string; functionCall?: { name: string } }> };
    finishReason?: string;
  }>;
};

function parseGeminiSSE(body: string): GeminiStreamChunk[] {
  return body
    .split("\n\n")
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
      return dataLine ? (JSON.parse(dataLine.slice(6)) as GeminiStreamChunk) : null;
    })
    .filter(Boolean) as GeminiStreamChunk[];
}

async function streamGemini(mock: LLMock, userMessage: string): Promise<GeminiStreamChunk[]> {
  const res = await fetch(
    `${mock.url}/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: userMessage }] }],
      }),
    },
  );
  return parseGeminiSSE(await res.text());
}

describe("Gemini — fixture block ordering (tool-first)", () => {
  let mock: LLMock | null = null;

  afterEach(async () => {
    if (mock) {
      await mock.stop();
      mock = null;
    }
  });

  it("emits the functionCall part BEFORE the text part when blocks lead with a toolCall", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "gemini tool-first blocks" },
      response: {
        content: "Here you go",
        toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
        blocks: [
          { type: "toolCall", name: "get_weather", arguments: '{"city":"NYC"}' },
          { type: "text", text: "Here you go" },
        ],
      },
    });
    await mock.start();

    const chunks = await streamGemini(mock, "gemini tool-first blocks");

    const fcChunks = chunks.filter((c) =>
      c.candidates[0].content.parts.some((p) => p.functionCall !== undefined),
    );
    const textChunks = chunks.filter((c) =>
      c.candidates[0].content.parts.some((p) => p.text !== undefined),
    );

    expect(fcChunks.length).toBeGreaterThan(0);
    expect(textChunks.length).toBeGreaterThan(0);

    // The functionCall part must be emitted before the text part (tool-first order).
    const firstFcIdx = chunks.indexOf(fcChunks[0]);
    const firstTextIdx = chunks.indexOf(textChunks[0]);
    expect(firstFcIdx).toBeLessThan(firstTextIdx);

    // finishReason still lands on the terminal chunk regardless of last block type.
    const lastChunk = chunks[chunks.length - 1];
    expect(lastChunk.candidates[0].finishReason).toBe("FUNCTION_CALL");

    const fcPart = fcChunks[0].candidates[0].content.parts.find((p) => p.functionCall);
    expect(fcPart!.functionCall!.name).toBe("get_weather");
  });

  it("back-compat: a fixture with no blocks streams identically to the legacy text-first path", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "gemini no blocks" },
      response: {
        content: "Sure.",
        toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
      },
    });
    await mock.start();

    const chunks = await streamGemini(mock, "gemini no blocks");

    const textChunks = chunks.filter((c) =>
      c.candidates[0].content.parts.some((p) => p.text !== undefined),
    );
    const fcChunks = chunks.filter((c) =>
      c.candidates[0].content.parts.some((p) => p.functionCall !== undefined),
    );

    expect(textChunks.length).toBeGreaterThan(0);
    expect(fcChunks.length).toBeGreaterThan(0);

    // Legacy: text-first, functionCall last, FUNCTION_CALL on terminal chunk.
    const lastTextIdx = chunks.lastIndexOf(textChunks.at(-1)!);
    const firstFcIdx = chunks.indexOf(fcChunks[0]);
    expect(lastTextIdx).toBeLessThan(firstFcIdx);

    const lastChunk = chunks[chunks.length - 1];
    expect(lastChunk.candidates[0].finishReason).toBe("FUNCTION_CALL");

    const fullText = textChunks
      .flatMap((c) => c.candidates[0].content.parts.map((p) => p.text ?? ""))
      .join("");
    expect(fullText).toBe("Sure.");
  });

  it("empty blocks array falls back to the legacy path (does not drop content/toolCalls)", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "gemini empty blocks" },
      response: {
        content: "Sure.",
        toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
        blocks: [],
      },
    });
    await mock.start();

    const chunks = await streamGemini(mock, "gemini empty blocks");

    const textChunks = chunks.filter((c) =>
      c.candidates[0].content.parts.some((p) => p.text !== undefined),
    );
    const fcChunks = chunks.filter((c) =>
      c.candidates[0].content.parts.some((p) => p.functionCall !== undefined),
    );

    // Empty blocks must NOT silently drop content/toolCalls — legacy output emits both.
    expect(textChunks.length).toBeGreaterThan(0);
    expect(fcChunks.length).toBeGreaterThan(0);

    const fullText = textChunks
      .flatMap((c) => c.candidates[0].content.parts.map((p) => p.text ?? ""))
      .join("");
    expect(fullText).toBe("Sure.");

    // Terminal finishReason still present (not a malformed, finish-less stream).
    const lastChunk = chunks[chunks.length - 1];
    expect(lastChunk.candidates[0].finishReason).toBe("FUNCTION_CALL");
  });
});
