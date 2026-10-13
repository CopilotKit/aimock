import type { Fixture } from "../../types.js";

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
