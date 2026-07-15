/**
 * Unit test for the shared `normalizeModelFamily` primitive.
 */
import { describe, it, expect } from "vitest";
import { normalizeModelFamily } from "./model-family.js";

describe("normalizeModelFamily", () => {
  it("strips a trailing dated snapshot suffix", () => {
    expect(normalizeModelFamily("gpt-audio-2025-08-28", "openai")).toBe("gpt-audio");
  });

  it("strips a trailing build-tag suffix", () => {
    expect(normalizeModelFamily("tts-1-1106", "openai")).toBe("tts-1");
  });

  it("does not strip a single-digit suffix", () => {
    expect(normalizeModelFamily("gpt-live-1", "openai")).toBe("gpt-live-1");
  });

  it("strips a trailing Anthropic contiguous 8-digit snapshot for anthropic", () => {
    expect(normalizeModelFamily("claude-3-5-sonnet-20241022", "anthropic")).toBe(
      "claude-3-5-sonnet",
    );
    expect(normalizeModelFamily("claude-3-7-sonnet-20250219", "anthropic")).toBe(
      "claude-3-7-sonnet",
    );
  });

  it("does NOT strip a contiguous 8-digit tail for openai/gemini", () => {
    // The 8-digit rule is Anthropic-only; a non-date 8-digit tail on another
    // provider must survive so it is not silently over-stripped.
    expect(normalizeModelFamily("gpt-weird-12345678", "openai")).toBe("gpt-weird-12345678");
    expect(normalizeModelFamily("gemini-weird-12345678", "gemini")).toBe("gemini-weird-12345678");
  });
});
