import { describe, it, expect } from "vitest";
import { normalizeModelName } from "../model-utils.js";

describe("normalizeModelName", () => {
  it("strips 8-digit date suffix", () => {
    expect(normalizeModelName("claude-opus-4-20250514")).toBe("claude-opus-4");
    expect(normalizeModelName("claude-3-5-sonnet-20241022")).toBe("claude-3-5-sonnet");
    expect(normalizeModelName("gpt-4o-mini-20240718")).toBe("gpt-4o-mini");
  });

  it("strips YYYY-MM-DD date suffix", () => {
    expect(normalizeModelName("gpt-4o-2024-08-06")).toBe("gpt-4o");
    expect(normalizeModelName("gpt-4-turbo-2024-04-09")).toBe("gpt-4-turbo");
  });

  it("strips Bedrock version suffix after date", () => {
    expect(normalizeModelName("anthropic.claude-3-5-sonnet-20241022-v2:0")).toBe(
      "anthropic.claude-3-5-sonnet",
    );
  });

  it("leaves models without date suffix unchanged", () => {
    expect(normalizeModelName("gpt-4o")).toBe("gpt-4o");
    expect(normalizeModelName("gpt-4o-mini")).toBe("gpt-4o-mini");
    expect(normalizeModelName("llama3.1")).toBe("llama3.1");
    expect(normalizeModelName("gemini-2.5-pro")).toBe("gemini-2.5-pro");
    expect(normalizeModelName("fal-ai/flux/dev")).toBe("fal-ai/flux/dev");
  });

  it("leaves undefined/empty unchanged", () => {
    expect(normalizeModelName(undefined)).toBeUndefined();
    expect(normalizeModelName("")).toBe("");
  });

  it("respects skip flag", () => {
    expect(normalizeModelName("claude-opus-4-20250514", true)).toBe("claude-opus-4-20250514");
  });
});
