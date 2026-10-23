import { describe, expect, test } from "vitest";
import {
  buildContentWithToolCallsChunks,
  buildContentWithToolCallsCompletion,
  buildOpenAIContentFilterChunks,
  buildOpenAIContentFilterCompletion,
  buildOpenAIReasoningChunks,
  buildOpenAIReasoningCompletion,
  buildOpenAIRefusalChunks,
  buildOpenAIRefusalCompletion,
} from "../helpers.js";
import type { FixtureBlock, ResponseOverrides } from "../types.js";

/**
 * Every exported Chat Completions builder validates and emits `citations`
 * against the exact text it serves, and the fault builders drop `citations`
 * in both the streaming and the non-streaming form.
 */

const CITED_URL = "https://example.com/cited";

// Served block text: "Sunny skies today. More." (24 UTF-16 units). The
// citation covers " More." at 18..24, which is outside the 5-unit `content`.
const blocks: FixtureBlock[] = [
  { type: "text", text: "Sunny skies today." },
  { type: "toolCall", id: "call_weather", name: "weather", arguments: '{"city":"Paris"}' },
  { type: "text", text: " More." },
];
const staleContent = "Stale";
const citedOverrides: ResponseOverrides = {
  citations: [{ url: CITED_URL, title: "Forecast", startIndex: 18, endIndex: 24 }],
};
const expectedAnnotations = [
  {
    type: "url_citation",
    url_citation: { url: CITED_URL, title: "Forecast", start_index: 18, end_index: 24 },
  },
];

describe("content-plus-tool-calls builders cite the text they serve", () => {
  test("streaming: blocks text, not the content argument, bounds the citations", () => {
    const chunks = buildContentWithToolCallsChunks(
      staleContent,
      [],
      "gpt-4o",
      4,
      undefined,
      citedOverrides,
      blocks,
    );
    const streamed = chunks
      .map((c) => c.choices[0]?.delta.content)
      .filter((s): s is string => typeof s === "string")
      .join("");
    expect(streamed).toBe("Sunny skies today. More.");
    const annotations = chunks.flatMap((c) => c.choices[0]?.delta.annotations ?? []);
    expect(annotations).toEqual(expectedAnnotations);
  });

  test("non-streaming: the served content bounds the citations", () => {
    const served = "Sunny skies today. More.";
    const completion = buildContentWithToolCallsCompletion(
      served,
      [{ name: "weather", arguments: '{"city":"Paris"}' }],
      "gpt-4o",
      undefined,
      citedOverrides,
    );
    expect(completion.choices[0].message.content).toBe(served);
    expect(completion.choices[0].message.annotations).toEqual(expectedAnnotations);
  });
});

describe("non-streaming fault builders drop citations like the streaming ones", () => {
  // Valid for the fixture's own reply text, which the fault replaces.
  const overrides: ResponseOverrides = {
    citations: [{ url: CITED_URL, startIndex: 0, endIndex: 20 }],
  };

  test("refusal", () => {
    expect(() => buildOpenAIRefusalChunks("No.", "gpt-4o", 4, overrides)).not.toThrow();
    const completion = buildOpenAIRefusalCompletion("No.", "gpt-4o", overrides);
    expect(completion.choices[0].message).toEqual({
      role: "assistant",
      content: null,
      refusal: "No.",
    });
  });

  test("content filter", () => {
    expect(() => buildOpenAIContentFilterChunks("gpt-4o", overrides)).not.toThrow();
    const completion = buildOpenAIContentFilterCompletion("gpt-4o", overrides);
    expect(completion.choices[0].finish_reason).toBe("content_filter");
    expect(completion.choices[0].message).toEqual({
      role: "assistant",
      content: null,
      refusal: null,
    });
  });

  test("reasoning, hidden and exposed", () => {
    for (const expose of [false, true]) {
      expect(() =>
        buildOpenAIReasoningChunks("Think.", "gpt-4o", 4, expose, overrides),
      ).not.toThrow();
      const completion = buildOpenAIReasoningCompletion("Think.", "gpt-4o", expose, overrides);
      expect(completion.choices[0].finish_reason).toBe("length");
      expect(completion.choices[0].message.content).toBeNull();
    }
  });
});
