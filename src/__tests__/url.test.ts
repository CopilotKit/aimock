import { describe, it, expect } from "vitest";
import { resolveUpstreamUrl } from "../url.js";

describe("resolveUpstreamUrl", () => {
  it("preserves base path prefix", () => {
    expect(resolveUpstreamUrl("https://openrouter.ai/api", "/v1/chat/completions").href).toBe(
      "https://openrouter.ai/api/v1/chat/completions",
    );
  });

  it("works with root-path providers", () => {
    expect(resolveUpstreamUrl("https://api.openai.com", "/v1/chat/completions").href).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
  });

  it("handles trailing slash on base", () => {
    expect(resolveUpstreamUrl("https://openrouter.ai/api/", "/v1/messages").href).toBe(
      "https://openrouter.ai/api/v1/messages",
    );
  });

  it("handles no leading slash on pathname", () => {
    expect(resolveUpstreamUrl("https://api.anthropic.com", "v1/messages").href).toBe(
      "https://api.anthropic.com/v1/messages",
    );
  });

  it("handles both trailing and no leading slash", () => {
    expect(resolveUpstreamUrl("https://openrouter.ai/api/", "v1/embeddings").href).toBe(
      "https://openrouter.ai/api/v1/embeddings",
    );
  });
});
