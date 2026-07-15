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
});
