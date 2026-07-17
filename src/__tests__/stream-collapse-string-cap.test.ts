import { describe, it, expect, afterEach } from "vitest";
import {
  collapseOpenAISSE,
  collapseAnthropicSSE,
  collapseGeminiSSE,
  collapseCohereSSE,
  collapseOllamaNDJSON,
  collapseGeminiInteractionsSSE,
  collapseBedrockEventStream,
  setCollapseStringLimitForTests,
  MAX_COLLAPSE_STRING_LENGTH,
} from "../stream-collapse.js";

// ---------------------------------------------------------------------------
// Accumulated-string cap on the stream collapsers.
//
// Each collapser accumulates per-channel strings (`content`, `reasoning`, a
// tool call's `arguments`, `audioB64`, ...) from stream fragments with `+=`.
// With no cap a large upstream response builds a string past V8's ~512 MiB max
// string length and throws `RangeError: Invalid string length` — the ~1/sec
// prod crash, caught at server.ts:1230. These tests use a tiny test-only limit
// so they exercise the REAL accumulator/guard code without allocating 512 MiB:
// the collapser must NOT throw, must clamp `content` at the ceiling, and must
// stamp `truncated: true` so the recorder skips journaling a partial fixture.
// ---------------------------------------------------------------------------

afterEach(() => {
  setCollapseStringLimitForTests(undefined);
});

/** Build an OpenAI SSE body whose accumulated `content` is `totalChars` long. */
function openAiSseBody(totalChars: number, perFrame: number): string {
  const frames: string[] = [];
  let emitted = 0;
  while (emitted < totalChars) {
    const n = Math.min(perFrame, totalChars - emitted);
    frames.push(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "a".repeat(n) } }] })}\n\n`,
    );
    emitted += n;
  }
  frames.push("data: [DONE]\n\n");
  return frames.join("");
}

describe("stream-collapse accumulated-string cap", () => {
  it("has a real ceiling comfortably below V8's max string length", () => {
    // V8 max string length on 64-bit is 2^29 - 1 (~536.87M). The ceiling must
    // be strictly below it so an accumulator clamped at the ceiling can never
    // reach the throwing boundary.
    expect(MAX_COLLAPSE_STRING_LENGTH).toBeLessThan(2 ** 29 - 1);
    expect(MAX_COLLAPSE_STRING_LENGTH).toBeGreaterThan(0);
  });

  it("clamps OpenAI content at the ceiling, marks truncated, and never throws", () => {
    setCollapseStringLimitForTests(1000);
    // 5000 chars of content across 100-char frames — 5x over the 1000 ceiling.
    const body = openAiSseBody(5000, 100);

    let result: ReturnType<typeof collapseOpenAISSE> | undefined;
    expect(() => {
      result = collapseOpenAISSE(body);
    }).not.toThrow();

    // content clamped at (or below) the ceiling — never past it.
    expect(result!.content!.length).toBeLessThanOrEqual(1000);
    // The over-ceiling input is flagged so the recorder skips journaling.
    expect(result!.truncated).toBe(true);
  });

  it("does not truncate when content stays under the ceiling", () => {
    setCollapseStringLimitForTests(1_000_000);
    const body = openAiSseBody(500, 100);
    const result = collapseOpenAISSE(body);
    expect(result.content).toBe("a".repeat(500));
    expect(result.truncated).toBeUndefined();
  });

  it("caps Anthropic content and marks truncated without throwing", () => {
    setCollapseStringLimitForTests(1000);
    const frames: string[] = [];
    for (let i = 0; i < 50; i++) {
      frames.push(
        `event: content_block_delta\ndata: ${JSON.stringify({
          delta: { type: "text_delta", text: "b".repeat(100) },
        })}\n\n`,
      );
    }
    const body = frames.join("");
    let result: ReturnType<typeof collapseAnthropicSSE> | undefined;
    expect(() => {
      result = collapseAnthropicSSE(body);
    }).not.toThrow();
    expect(result!.content!.length).toBeLessThanOrEqual(1000);
    expect(result!.truncated).toBe(true);
  });

  it("caps Gemini, Cohere, Ollama, and Gemini-Interactions without throwing", () => {
    setCollapseStringLimitForTests(500);

    const gemini = collapseGeminiSSE(
      Array.from(
        { length: 20 },
        () =>
          `data: ${JSON.stringify({
            candidates: [{ content: { parts: [{ text: "g".repeat(100) }] } }],
          })}\n\n`,
      ).join(""),
    );
    expect(gemini.content!.length).toBeLessThanOrEqual(500);
    expect(gemini.truncated).toBe(true);

    const cohere = collapseCohereSSE(
      Array.from(
        { length: 20 },
        () =>
          `event: content-delta\ndata: ${JSON.stringify({
            delta: { message: { content: { text: "c".repeat(100) } } },
          })}\n\n`,
      ).join(""),
    );
    expect(cohere.content!.length).toBeLessThanOrEqual(500);
    expect(cohere.truncated).toBe(true);

    const ollama = collapseOllamaNDJSON(
      Array.from(
        { length: 20 },
        () => `${JSON.stringify({ message: { content: "o".repeat(100) } })}\n`,
      ).join(""),
    );
    expect(ollama.content!.length).toBeLessThanOrEqual(500);
    expect(ollama.truncated).toBe(true);

    const geminiInteractions = collapseGeminiInteractionsSSE(
      Array.from(
        { length: 20 },
        () =>
          `data: ${JSON.stringify({
            event_type: "step.delta",
            index: 0,
            delta: { type: "text", text: "i".repeat(100) },
          })}\n\n`,
      ).join(""),
    );
    expect(geminiInteractions.content!.length).toBeLessThanOrEqual(500);
    expect(geminiInteractions.truncated).toBe(true);
  });

  it("caps Bedrock EventStream input by byte length and marks truncated", () => {
    setCollapseStringLimitForTests(64);
    // A raw buffer over the (byte) ceiling — even garbage bytes must be bounded
    // and flagged truncated rather than fed unbounded into the accumulators.
    const big = Buffer.alloc(4096, 0x41); // 4 KiB of 'A'
    let result: ReturnType<typeof collapseBedrockEventStream> | undefined;
    expect(() => {
      result = collapseBedrockEventStream(big);
    }).not.toThrow();
    expect(result!.truncated).toBe(true);
  });
});
