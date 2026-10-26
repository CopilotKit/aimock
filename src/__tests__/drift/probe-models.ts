/**
 * Every provider model the live drift probes PIN, in one place.
 *
 * `scripts/drift-model-preflight.ts` reads this list before the nightly drift
 * run and asks each provider whether the model is still served. A retired probe
 * model otherwise surfaces as a confusing drift failure (`o4-mini` hit its
 * `shutdown_date` on 2026-10-23 and the K9 probe then failed for three nights
 * as "drift").
 *
 * Side-effect-free data module (no `describe`/`beforeAll`), so the preflight
 * script and the unit test import it without registering a drift suite.
 *
 * NOT LISTED: legs that choose their model from the provider's live listing at
 * run time (`resolveLiveModel` / `resolveLiveModelCandidates` in providers.ts —
 * the OpenAI chat and Responses tool legs, the Anthropic text leg, Cohere chat,
 * Gemini Live). They move to a served model on their own. Mock-only legs that
 * never send their model upstream are not listed either.
 *
 * WHEN YOU PIN A NEW PROBE MODEL, add it here. `probe-models.test.ts` checks
 * that each entry still appears in the `source` file it names, so an entry
 * cannot outlive its pin unnoticed.
 */

/** Providers whose model APIs report retirement, so the preflight can ask. */
export type RetirementCheckedProvider = "openai" | "anthropic" | "gemini" | "cohere" | "openrouter";

/** Providers with no retirement API reachable from the preflight. */
export type UncheckedProvider = "bedrock" | "vertex" | "ollama" | "fal";

export interface DriftProbeModel {
  provider: RetirementCheckedProvider | UncheckedProvider;
  /** The exact id the probe sends upstream. */
  model: string;
  /** Repo-relative file that pins the id: the place to edit when it retires. */
  source: string;
  /** The exported constant to change, when the pin is one. */
  constant?: string;
}

/**
 * The OpenAI model the live K9 exhaustion probes (HTTP and WS) request.
 * `o4-mini` hit its `/v1/models` `shutdown_date` of 2026-10-23.
 */
export const OPENAI_K9_PROBE_MODEL = "o4-mini";

export const DRIFT_PROBE_MODELS: readonly DriftProbeModel[] = [
  // OpenAI
  { provider: "openai", model: "gpt-4o-mini", source: "src/__tests__/drift/providers.ts" },
  {
    provider: "openai",
    model: "text-embedding-3-small",
    source: "src/__tests__/drift/providers.ts",
  },
  { provider: "openai", model: "whisper-1", source: "src/__tests__/drift/transcription.drift.ts" },
  { provider: "openai", model: "gpt-realtime-mini", source: "src/__tests__/drift/ws-providers.ts" },
  {
    provider: "openai",
    model: "gpt-4.1-mini",
    source: "src/__tests__/drift/openai-responses.drift.ts",
  },
  {
    provider: "openai",
    model: OPENAI_K9_PROBE_MODEL,
    source: "src/__tests__/drift/probe-models.ts",
    constant: "OPENAI_K9_PROBE_MODEL",
  },
  // Anthropic
  {
    provider: "anthropic",
    model: "claude-haiku-4-5-20251001",
    source: "src/__tests__/drift/providers.ts",
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-4-5-20250929",
    source: "src/__tests__/drift/anthropic.drift.ts",
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    source: "src/__tests__/drift/anthropic.drift.ts",
  },
  // Gemini Developer API
  { provider: "gemini", model: "gemini-2.5-flash", source: "src/__tests__/drift/providers.ts" },
  {
    provider: "gemini",
    model: "gemini-embedding-001",
    source: "src/__tests__/drift/gemini.drift.ts",
  },
  // Cohere
  { provider: "cohere", model: "rerank-v3.5", source: "src/__tests__/drift/rerank.drift.ts" },
  // OpenRouter
  {
    provider: "openrouter",
    model: "qwen/qwen3-32b",
    source: "src/__tests__/drift/openrouter-chat.drift.ts",
  },
  // No retirement API the preflight can reach (listed so the run says so).
  {
    provider: "bedrock",
    model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    source: ".github/workflows/test-drift.yml",
  },
  { provider: "vertex", model: "gemini-2.5-flash", source: ".github/workflows/test-drift.yml" },
  { provider: "ollama", model: "qwen2:0.5b", source: ".github/workflows/test-drift.yml" },
  { provider: "ollama", model: "qwen3:0.6b", source: ".github/workflows/test-drift.yml" },
  {
    provider: "fal",
    model: "fal-ai/flux/schnell",
    source: "src/__tests__/drift/fal-queue.drift.ts",
  },
];
