/**
 * T1e — OpenAI Responses API: ordered `blocks` streaming.
 *
 * When a combined content+toolCalls fixture sets the optional `blocks` field,
 * the Responses builder must assign `output_index` and assemble
 * `response.completed.output` in the blocks' ARRAY ORDER. A `toolCall` block
 * placed before a `text` block therefore yields a `function_call` output item
 * at the LOWER `output_index`, appearing FIRST in the final `output` array —
 * the opposite of the legacy (message-always-first) hardcoding.
 *
 * Real mock-server surface (mirrors content-with-toolcalls.test.ts): an actual
 * `LLMock` listens, a real HTTP request streams SSE, and assertions read the
 * wire bytes.
 */
import { describe, it, expect, afterEach } from "vitest";
import { LLMock } from "../llmock.js";
import type { FixtureBlock } from "../types.js";

function parseResponsesSSEEvents(body: string): Array<{ type: string; [key: string]: unknown }> {
  return body
    .split("\n\n")
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
      if (!dataLine) return null;
      return JSON.parse(dataLine.slice(6)) as { type: string; [key: string]: unknown };
    })
    .filter(Boolean) as Array<{ type: string; [key: string]: unknown }>;
}

describe("OpenAI Responses API — fixture block ordering (#274)", () => {
  let mock: LLMock | null = null;

  afterEach(async () => {
    if (mock) {
      await mock.stop();
      mock = null;
    }
  });

  it("tool-first blocks: function_call takes output_index 0 and leads response.output", async () => {
    mock = new LLMock({ port: 0 });
    const blocks: FixtureBlock[] = [
      { type: "toolCall", name: "get_weather", arguments: '{"city":"NYC"}' },
      { type: "text", text: "Here you go." },
    ];
    mock.addFixture({
      match: { userMessage: "responses blocks tool-first" },
      response: {
        content: "Here you go.",
        toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
        blocks,
      },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({
        model: "gpt-4o",
        input: [{ role: "user", content: "responses blocks tool-first" }],
        stream: true,
      }),
    });

    const events = parseResponsesSSEEvents(await res.text());

    // The function_call output item must be added at output_index 0 (before the
    // message item), proving block-order output-index assignment.
    const fcAdded = events.find(
      (e) =>
        e.type === "response.output_item.added" &&
        (e.item as { type: string })?.type === "function_call",
    );
    const msgAdded = events.find(
      (e) =>
        e.type === "response.output_item.added" && (e.item as { type: string })?.type === "message",
    );
    expect(fcAdded).toBeDefined();
    expect(msgAdded).toBeDefined();
    expect((fcAdded as { output_index: number }).output_index).toBe(0);
    expect((msgAdded as { output_index: number }).output_index).toBe(1);

    // The final completed.output array must lead with the function_call item.
    const completed = events.find((e) => e.type === "response.completed");
    const output = (completed!.response as { output: Array<{ type: string }> }).output;
    const types = output.map((o) => o.type);
    expect(types.indexOf("function_call")).toBeLessThan(types.indexOf("message"));
    expect(types[0]).toBe("function_call");

    // Content + arguments still stream fully.
    const allTextDeltas = events
      .filter((e) => e.type === "response.output_text.delta")
      .map((e) => (e as unknown as { delta: string }).delta)
      .join("");
    expect(allTextDeltas).toBe("Here you go.");
    const allArgDeltas = events
      .filter((e) => e.type === "response.function_call_arguments.delta")
      .map((e) => (e as unknown as { delta: string }).delta)
      .join("");
    expect(allArgDeltas).toBe('{"city":"NYC"}');
  });

  it("back-compat: a fixture WITHOUT blocks keeps the legacy message-first ordering", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "responses no blocks legacy" },
      response: {
        content: "Sure.",
        toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
      },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({
        model: "gpt-4o",
        input: [{ role: "user", content: "responses no blocks legacy" }],
        stream: true,
      }),
    });

    const events = parseResponsesSSEEvents(await res.text());

    const msgAdded = events.find(
      (e) =>
        e.type === "response.output_item.added" && (e.item as { type: string })?.type === "message",
    );
    const fcAdded = events.find(
      (e) =>
        e.type === "response.output_item.added" &&
        (e.item as { type: string })?.type === "function_call",
    );
    // Legacy hardcoding: message at index 0, function_call at index 1.
    expect((msgAdded as { output_index: number }).output_index).toBe(0);
    expect((fcAdded as { output_index: number }).output_index).toBe(1);

    const completed = events.find((e) => e.type === "response.completed");
    const output = (completed!.response as { output: Array<{ type: string }> }).output;
    const types = output.map((o) => o.type);
    expect(types.indexOf("message")).toBeLessThan(types.indexOf("function_call"));
  });

  it("empty blocks array falls back to the legacy path (content/toolCalls + terminal completed)", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "responses empty blocks" },
      response: {
        content: "Sure.",
        toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
        blocks: [],
      },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({
        model: "gpt-4o",
        input: [{ role: "user", content: "responses empty blocks" }],
        stream: true,
      }),
    });

    const events = parseResponsesSSEEvents(await res.text());

    // Empty blocks must fall back to legacy: both a message and a function_call item.
    const msgAdded = events.find(
      (e) =>
        e.type === "response.output_item.added" && (e.item as { type: string })?.type === "message",
    );
    const fcAdded = events.find(
      (e) =>
        e.type === "response.output_item.added" &&
        (e.item as { type: string })?.type === "function_call",
    );
    expect(msgAdded).toBeDefined();
    expect(fcAdded).toBeDefined();

    // Content + arguments still stream fully (not silently dropped).
    const allTextDeltas = events
      .filter((e) => e.type === "response.output_text.delta")
      .map((e) => (e as unknown as { delta: string }).delta)
      .join("");
    expect(allTextDeltas).toBe("Sure.");
    const allArgDeltas = events
      .filter((e) => e.type === "response.function_call_arguments.delta")
      .map((e) => (e as unknown as { delta: string }).delta)
      .join("");
    expect(allArgDeltas).toBe('{"city":"NYC"}');

    // Terminal completed event with usage is present (not a role+finish-only stream).
    const completed = events.find((e) => e.type === "response.completed");
    expect(completed).toBeDefined();
    expect((completed!.response as { usage?: unknown }).usage).toBeDefined();
  });
});
