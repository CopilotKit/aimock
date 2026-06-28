import { describe, it, expect, afterEach } from "vitest";
import { LLMock } from "../llmock.js";

interface CohereSSEEvent {
  type: string;
  index?: number;
  delta?: {
    message?: {
      content?: { type?: string; text?: string };
      tool_calls?: {
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      };
      tool_plan?: string;
    };
    finish_reason?: string;
    usage?: unknown;
  };
  [key: string]: unknown;
}

function parseCohereSSEEvents(body: string): CohereSSEEvent[] {
  return body
    .split("\n\n")
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
      if (!dataLine) return null;
      return JSON.parse(dataLine.slice(6)) as CohereSSEEvent;
    })
    .filter(Boolean) as CohereSSEEvent[];
}

async function postCohereStream(mock: LLMock, userMessage: string): Promise<CohereSSEEvent[]> {
  const res = await fetch(`${mock.url}/v2/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-key",
    },
    body: JSON.stringify({
      model: "command-r-plus",
      messages: [{ role: "user", content: userMessage }],
      stream: true,
    }),
  });
  return parseCohereSSEEvents(await res.text());
}

describe("Cohere v2 Chat — ordered fixture blocks (tool-first)", () => {
  let mock: LLMock | null = null;

  afterEach(async () => {
    if (mock) {
      await mock.stop();
      mock = null;
    }
  });

  it("streams the tool call before the text for blocks [toolCall, text]", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "test cohere blocks tool-first" },
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

    const events = await postCohereStream(mock, "test cohere blocks tool-first");

    // The tool-call-start must precede the text content-start on the wire.
    const toolIdx = events.findIndex((e) => e.type === "tool-call-start");
    const textIdx = events.findIndex((e) => e.type === "content-start");
    expect(toolIdx).toBeGreaterThanOrEqual(0);
    expect(textIdx).toBeGreaterThanOrEqual(0);
    expect(toolIdx).toBeLessThan(textIdx);

    // The tool-call-start carries the function name.
    const toolStart = events.find((e) => e.type === "tool-call-start");
    expect(toolStart!.delta!.message!.tool_calls!.function!.name).toBe("get_weather");

    // tool-call-delta args reassemble to the fixture arguments.
    const args = events
      .filter((e) => e.type === "tool-call-delta")
      .map((e) => e.delta!.message!.tool_calls!.function!.arguments ?? "")
      .join("");
    expect(args).toBe('{"city":"NYC"}');

    // The text arrives via content-delta.
    const text = events
      .filter((e) => e.type === "content-delta")
      .map((e) => e.delta!.message!.content!.text ?? "")
      .join("");
    expect(text).toBe("Here you go.");

    // Message envelope preserved with TOOL_CALL finish reason.
    expect(events.find((e) => e.type === "message-start")).toBeDefined();
    const messageEnd = events.find((e) => e.type === "message-end");
    expect(messageEnd).toBeDefined();
    expect(messageEnd!.delta!.finish_reason).toBe("TOOL_CALL");
  });

  it("blocks-only fixture (no content/toolCalls) streams tool-first purely from blocks", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "test cohere blocks-only" },
      response: {
        blocks: [
          { type: "toolCall", name: "get_weather", arguments: '{"city":"NYC"}' },
          { type: "text", text: "Here you go." },
        ],
      },
    });
    await mock.start();

    const events = await postCohereStream(mock, "test cohere blocks-only");

    const toolIdx = events.findIndex((e) => e.type === "tool-call-start");
    const textIdx = events.findIndex((e) => e.type === "content-start");
    expect(toolIdx).toBeGreaterThanOrEqual(0);
    expect(textIdx).toBeGreaterThanOrEqual(0);
    expect(toolIdx).toBeLessThan(textIdx);

    const toolStart = events.find((e) => e.type === "tool-call-start");
    expect(toolStart!.delta!.message!.tool_calls!.function!.name).toBe("get_weather");

    const args = events
      .filter((e) => e.type === "tool-call-delta")
      .map((e) => e.delta!.message!.tool_calls!.function!.arguments ?? "")
      .join("");
    expect(args).toBe('{"city":"NYC"}');

    const text = events
      .filter((e) => e.type === "content-delta")
      .map((e) => e.delta!.message!.content!.text ?? "")
      .join("");
    expect(text).toBe("Here you go.");
  });

  it("back-compat: a fixture without blocks emits the legacy text-first order", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "test cohere blocks legacy" },
      response: {
        content: "Hello there.",
        toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
      },
    });
    await mock.start();

    const events = await postCohereStream(mock, "test cohere blocks legacy");

    // Legacy: text content-start appears BEFORE the first tool-call-start.
    const toolIdx = events.findIndex((e) => e.type === "tool-call-start");
    const textIdx = events.findIndex((e) => e.type === "content-start");
    expect(textIdx).toBeGreaterThanOrEqual(0);
    expect(toolIdx).toBeGreaterThanOrEqual(0);
    expect(textIdx).toBeLessThan(toolIdx);

    const text = events
      .filter((e) => e.type === "content-delta")
      .map((e) => e.delta!.message!.content!.text ?? "")
      .join("");
    expect(text).toBe("Hello there.");

    const toolStart = events.find((e) => e.type === "tool-call-start");
    expect(toolStart!.delta!.message!.tool_calls!.function!.name).toBe("get_weather");

    const messageEnd = events.find((e) => e.type === "message-end");
    expect(messageEnd!.delta!.finish_reason).toBe("TOOL_CALL");
  });
});
