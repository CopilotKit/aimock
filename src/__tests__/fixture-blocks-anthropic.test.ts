import { describe, it, expect, afterEach } from "vitest";
import { LLMock } from "../llmock.js";

interface AnthropicSSEEvent {
  type: string;
  index?: number;
  content_block?: { type: string; name?: string; input?: unknown };
  delta?: Record<string, unknown>;
  [key: string]: unknown;
}

function parseAnthropicSSEEvents(body: string): AnthropicSSEEvent[] {
  return body
    .split("\n\n")
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
      if (!dataLine) return null;
      return JSON.parse(dataLine.slice(6)) as AnthropicSSEEvent;
    })
    .filter(Boolean) as AnthropicSSEEvent[];
}

async function postAnthropicStream(
  mock: LLMock,
  userMessage: string,
): Promise<AnthropicSSEEvent[]> {
  const res = await fetch(`${mock.url}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": "test-key",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [{ role: "user", content: userMessage }],
      stream: true,
    }),
  });
  return parseAnthropicSSEEvents(await res.text());
}

describe("Anthropic Messages — ordered fixture blocks (tool-first)", () => {
  let mock: LLMock | null = null;

  afterEach(async () => {
    if (mock) {
      await mock.stop();
      mock = null;
    }
  });

  it("emits tool_use content block at index 0 and text block at index 1 for [toolCall, text]", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "test anthropic blocks tool-first" },
      response: {
        content: "Checking.",
        toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
        blocks: [
          { type: "toolCall", name: "get_weather", arguments: '{"city":"NYC"}' },
          { type: "text", text: "Here you go." },
        ],
      },
    });
    await mock.start();

    const events = await postAnthropicStream(mock, "test anthropic blocks tool-first");

    const starts = events.filter((e) => e.type === "content_block_start");
    // First content block must be the tool_use (index 0), then text (index 1).
    expect(starts.length).toBe(2);
    expect(starts[0].index).toBe(0);
    expect(starts[0].content_block?.type).toBe("tool_use");
    expect(starts[0].content_block?.name).toBe("get_weather");
    expect(starts[1].index).toBe(1);
    expect(starts[1].content_block?.type).toBe("text");

    // The tool_use start must precede the text start on the wire.
    const toolIdx = events.findIndex(
      (e) => e.type === "content_block_start" && e.content_block?.type === "tool_use",
    );
    const textIdx = events.findIndex(
      (e) => e.type === "content_block_start" && e.content_block?.type === "text",
    );
    expect(toolIdx).toBeLessThan(textIdx);

    // The tool_use input arrives via input_json_delta on index 0.
    const toolDelta = events.find(
      (e) =>
        e.type === "content_block_delta" && e.index === 0 && e.delta?.type === "input_json_delta",
    );
    expect(toolDelta).toBeDefined();
    expect(toolDelta!.delta!.partial_json).toBe('{"city":"NYC"}');

    // The text arrives via text_delta on index 1.
    const textDelta = events.find(
      (e) => e.type === "content_block_delta" && e.index === 1 && e.delta?.type === "text_delta",
    );
    expect(textDelta).toBeDefined();
    expect(textDelta!.delta!.text).toBe("Here you go.");

    // message envelope preserved.
    const messageStart = events.find((e) => e.type === "message_start");
    const messageDelta = events.find((e) => e.type === "message_delta");
    const messageStop = events.find((e) => e.type === "message_stop");
    expect(messageStart).toBeDefined();
    expect(messageStop).toBeDefined();
    expect((messageDelta!.delta as { stop_reason: string }).stop_reason).toBe("tool_use");
  });

  it("back-compat: a fixture without blocks emits the legacy text-first block at index 0", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "test anthropic blocks legacy" },
      response: {
        content: "Checking.",
        toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
      },
    });
    await mock.start();

    const events = await postAnthropicStream(mock, "test anthropic blocks legacy");

    const starts = events.filter((e) => e.type === "content_block_start");
    // Legacy always emits the text block first (index 0) then tool_use (index 1).
    expect(starts.length).toBe(2);
    expect(starts[0].index).toBe(0);
    expect(starts[0].content_block?.type).toBe("text");
    expect(starts[1].index).toBe(1);
    expect(starts[1].content_block?.type).toBe("tool_use");
  });
});
