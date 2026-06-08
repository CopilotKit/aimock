import { describe, it, expect, afterEach, vi } from "vitest";
import { normalizeModelName, isReasoningModel } from "../model-utils.js";

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

describe("isReasoningModel", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("classifies reasoning-capable families as true", () => {
    expect(isReasoningModel("o1")).toBe(true);
    expect(isReasoningModel("o1-mini")).toBe(true);
    expect(isReasoningModel("o3-mini")).toBe(true);
    expect(isReasoningModel("o4-mini")).toBe(true);
    expect(isReasoningModel("gpt-5")).toBe(true);
    expect(isReasoningModel("gpt-5-mini")).toBe(true);
    expect(isReasoningModel("deepseek-r1")).toBe(true);
    expect(isReasoningModel("deepseek-reasoner")).toBe(true);
    expect(isReasoningModel("claude-3-7-sonnet")).toBe(true);
    expect(isReasoningModel("claude-opus-4-20250514")).toBe(true); // date-suffixed
    expect(isReasoningModel("claude-sonnet-4")).toBe(true);
    expect(isReasoningModel("gemini-2.5-pro")).toBe(true);
    expect(isReasoningModel("gemini-2.0-flash-thinking-exp")).toBe(true);
    expect(isReasoningModel("qwq-32b")).toBe(true);
  });

  it("classifies known non-reasoning families as false", () => {
    expect(isReasoningModel("gpt-4.1")).toBe(false);
    expect(isReasoningModel("gpt-4.1-mini")).toBe(false);
    expect(isReasoningModel("gpt-4.1-nano")).toBe(false);
    expect(isReasoningModel("gpt-4o")).toBe(false);
    expect(isReasoningModel("gpt-4o-mini")).toBe(false);
    expect(isReasoningModel("gpt-4o-2024-11-20")).toBe(false); // date-suffixed
    expect(isReasoningModel("gpt-4")).toBe(false);
    expect(isReasoningModel("gpt-4-turbo")).toBe(false);
    expect(isReasoningModel("gpt-3.5-turbo")).toBe(false);
    expect(isReasoningModel("claude-3-5-sonnet-20241022")).toBe(false);
    expect(isReasoningModel("claude-3-haiku")).toBe(false);
    expect(isReasoningModel("claude-3-opus")).toBe(false);
    expect(isReasoningModel("gemini-1.5-pro")).toBe(false);
    expect(isReasoningModel("gemini-1.5-flash")).toBe(false);
  });

  it("strips a Bedrock provider prefix before matching", () => {
    expect(isReasoningModel("anthropic.claude-3-5-sonnet-20241022-v2:0")).toBe(false);
    expect(isReasoningModel("us.anthropic.claude-3-5-sonnet-20241022-v2:0")).toBe(false);
    expect(isReasoningModel("anthropic.claude-opus-4-20250514-v1:0")).toBe(true);
  });

  it("defaults unknown models to true (reasoning-capable)", () => {
    expect(isReasoningModel("some-future-model")).toBe(true);
    expect(isReasoningModel("llama3.1")).toBe(true);
    expect(isReasoningModel("mistral")).toBe(true);
  });

  it("defaults undefined/empty to true (no model id is not evidence of incapability)", () => {
    expect(isReasoningModel(undefined)).toBe(true);
    expect(isReasoningModel("")).toBe(true);
  });

  it("env override AIMOCK_NONREASONING_MODELS forces a model to false", () => {
    vi.stubEnv("AIMOCK_NONREASONING_MODELS", "my-model,another-one");
    expect(isReasoningModel("my-model")).toBe(false);
    expect(isReasoningModel("another-one")).toBe(false);
    // unrelated model unaffected
    expect(isReasoningModel("o3-mini")).toBe(true);
  });

  it("env override AIMOCK_REASONING_MODELS forces a built-in non-reasoning model to true", () => {
    vi.stubEnv("AIMOCK_REASONING_MODELS", "gpt-4.1");
    expect(isReasoningModel("gpt-4.1")).toBe(true);
  });

  it("env-nonreasoning wins over env-reasoning (documented precedence)", () => {
    vi.stubEnv("AIMOCK_REASONING_MODELS", "shared-model");
    vi.stubEnv("AIMOCK_NONREASONING_MODELS", "shared-model");
    expect(isReasoningModel("shared-model")).toBe(false);
  });

  it("env-nonreasoning entry with a provider prefix matches the stripped id", () => {
    vi.stubEnv("AIMOCK_NONREASONING_MODELS", "anthropic.claude-opus-4");
    expect(isReasoningModel("anthropic.claude-opus-4-20250514-v1:0")).toBe(false);
  });

  it("env-reasoning entry with a provider prefix fires for the stripped id", () => {
    // Without the override the stripped id `gpt-4.1` hits the built-in
    // non-reasoning denylist (→ false); the prefixed env-reasoning entry must
    // match the stripped id and force it back to true.
    vi.stubEnv("AIMOCK_REASONING_MODELS", "anthropic.gpt-4.1");
    expect(isReasoningModel("anthropic.gpt-4.1-mini")).toBe(true);
  });
});
