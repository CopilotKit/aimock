import type { Fixture } from "../../types.js";
import { stripProviderPrefix } from "../../model-utils.js";

export type ModelProvider = "anthropic" | "openai" | "google";

const MODEL_PREFIXES: readonly { provider: ModelProvider; pattern: RegExp }[] = [
  { provider: "anthropic", pattern: /^claude-/ },
  { provider: "google", pattern: /^gemini-/ },
  {
    provider: "openai",
    pattern: /^(?:gpt-|chatgpt-|o[134](?:$|-)|text-embedding-|dall-e-|whisper-|tts-)/,
  },
];

/** Explicit provider segments win; unknown families remain visible everywhere. */
export function providerOf(id: string): ModelProvider | undefined {
  const normalized = id.toLowerCase();
  const provider = normalized.split("/", 1)[0];
  if (
    normalized.includes("/") &&
    (provider === "anthropic" || provider === "openai" || provider === "google")
  )
    return provider;
  const family = stripProviderPrefix(normalized);
  return MODEL_PREFIXES.find(({ pattern }) => pattern.test(family))?.provider;
}

export function idsFor(ids: readonly string[], provider: "anthropic" | "google"): string[] {
  return ids.filter((id) => {
    const actual = providerOf(id);
    return actual === undefined || actual === provider;
  });
}

export type CatalogSelection = "all" | "chat" | "video-active";

/** Models that the existing OpenRouter video surface cannot serve. */
export const OPENROUTER_VIDEO_SUNSET_MODELS: ReadonlySet<string> = new Set(["openai/sora-2"]);

/** Ordered fixture IDs; callers own warnings and transport decisions. */
export function collect(fixtures: readonly Fixture[], selection: CatalogSelection) {
  const ids: string[] = [];
  const seen = new Set<string>();
  let sawVideoFixture = false;
  for (const fixture of fixtures) {
    const { endpoint, model } = fixture.match;
    if (selection === "chat" && endpoint !== undefined && endpoint !== "chat") continue;
    if (selection === "video-active") {
      if (endpoint !== "video") continue;
      sawVideoFixture = true;
      if (typeof model === "string" && OPENROUTER_VIDEO_SUNSET_MODELS.has(model)) continue;
    }
    if (typeof model !== "string" || model.length === 0 || seen.has(model)) continue;
    seen.add(model);
    ids.push(model);
  }
  return { ids, diagnostics: { sawVideoFixture } };
}
