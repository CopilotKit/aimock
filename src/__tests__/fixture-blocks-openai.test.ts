import { describe, it, expect, afterEach } from "vitest";
import { LLMock } from "../llmock.js";
import type { SSEChunk } from "../types.js";

function parseSSEChunks(body: string): SSEChunk[] {
  return body
    .split("\n\n")
    .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
    .map((line) => JSON.parse(line.slice(6)) as SSEChunk);
}

describe("OpenAI Chat Completions — fixture block ordering (#274)", () => {
  let mock: LLMock | null = null;

  afterEach(async () => {
    if (mock) {
      await mock.stop();
      mock = null;
    }
  });

  it("emits tool_call delta chunks before content delta chunks for a tool-first blocks fixture", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "test blocks tool-first" },
      response: {
        // Legacy fields preserved for the guard; blocks drives emission order.
        content: "After the call.",
        toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
        blocks: [
          { type: "toolCall", name: "get_weather", arguments: '{"city":"NYC"}' },
          { type: "text", text: "After the call." },
        ],
      },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "test blocks tool-first" }],
        stream: true,
      }),
    });

    const chunks = parseSSEChunks(await res.text());
    const contentChunks = chunks.filter((c) => c.choices?.[0]?.delta?.content);
    const toolChunks = chunks.filter((c) => c.choices?.[0]?.delta?.tool_calls);
    const finishChunk = chunks.find((c) => c.choices?.[0]?.finish_reason);

    expect(contentChunks.length).toBeGreaterThan(0);
    expect(toolChunks.length).toBeGreaterThan(0);

    // The block array is [toolCall, text], so the emitted SSE chunk SEQUENCE
    // must place the tool_call delta chunk(s) BEFORE the content delta chunk(s).
    const firstToolIdx = chunks.indexOf(toolChunks[0]);
    const firstContentIdx = chunks.indexOf(contentChunks[0]);
    expect(firstToolIdx).toBeLessThan(firstContentIdx);

    // Content + finish_reason preserved exactly as the legacy path.
    const fullContent = contentChunks.map((c) => c.choices[0].delta.content).join("");
    expect(fullContent).toBe("After the call.");
    expect(finishChunk!.choices[0].finish_reason).toBe("tool_calls");

    // Tool call assembled correctly with index 0.
    expect(toolChunks[0].choices[0].delta.tool_calls![0].index).toBe(0);
    expect(toolChunks[0].choices[0].delta.tool_calls![0].function!.name).toBe("get_weather");
  });

  it("assigns tool_call index in block encounter order for interleaved blocks", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "test blocks interleave" },
      response: {
        content: "A B",
        toolCalls: [
          { name: "fn_a", arguments: '{"a":1}' },
          { name: "fn_b", arguments: '{"b":2}' },
        ],
        blocks: [
          { type: "toolCall", name: "fn_a", arguments: '{"a":1}' },
          { type: "text", text: "A " },
          { type: "toolCall", name: "fn_b", arguments: '{"b":2}' },
          { type: "text", text: "B" },
        ],
      },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "test blocks interleave" }],
        stream: true,
      }),
    });

    const chunks = parseSSEChunks(await res.text());

    // Encounter-order index assignment: fn_a -> 0, fn_b -> 1.
    const initialToolChunks = chunks.filter(
      (c) => c.choices?.[0]?.delta?.tool_calls?.[0]?.function?.name,
    );
    expect(initialToolChunks.map((c) => c.choices[0].delta.tool_calls![0].index)).toEqual([0, 1]);
    expect(initialToolChunks[0].choices[0].delta.tool_calls![0].function!.name).toBe("fn_a");
    expect(initialToolChunks[1].choices[0].delta.tool_calls![0].function!.name).toBe("fn_b");

    // Wire sequence reflects block order: first tool chunk precedes first content chunk.
    const firstToolIdx = chunks.indexOf(initialToolChunks[0]);
    const firstContentIdx = chunks.findIndex((c) => c.choices?.[0]?.delta?.content);
    expect(firstToolIdx).toBeLessThan(firstContentIdx);

    const fullContent = chunks
      .filter((c) => c.choices?.[0]?.delta?.content)
      .map((c) => c.choices[0].delta.content)
      .join("");
    expect(fullContent).toBe("A B");
  });

  it("back-compat: a fixture WITHOUT blocks streams content-first (legacy path untouched)", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "test no blocks legacy" },
      response: {
        content: "Let me check.",
        toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
      },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "test no blocks legacy" }],
        stream: true,
      }),
    });

    const chunks = parseSSEChunks(await res.text());
    const contentChunks = chunks.filter((c) => c.choices?.[0]?.delta?.content);
    const toolChunks = chunks.filter((c) => c.choices?.[0]?.delta?.tool_calls);
    const finishChunk = chunks.find((c) => c.choices?.[0]?.finish_reason);

    // Legacy: content strictly before tool calls.
    const lastContentIdx = chunks.lastIndexOf(contentChunks.at(-1)!);
    const firstToolIdx = chunks.indexOf(toolChunks[0]);
    expect(lastContentIdx).toBeLessThan(firstToolIdx);

    const fullContent = contentChunks.map((c) => c.choices[0].delta.content).join("");
    expect(fullContent).toBe("Let me check.");
    expect(finishChunk!.choices[0].finish_reason).toBe("tool_calls");
  });
});
