/**
 * TEXT-lane drift primitives: the enumerate→normalize→subtract pipeline
 * (`unclassifiedFamilies`), the live assertion wrapper that turns its result
 * into a routable drift report (`assertNoUnclassifiedFamilies`), and the C4
 * deprecation detector (`detectDeprecatedFamilies` /
 * `checkDeprecatedFamiliesLive`).
 *
 * WHY THIS MODULE EXISTS — it registers NO suites (no `describe`/`it`), in the
 * style of `model-registry.ts` / `voice-models.ts`. These functions need to be
 * importable by more than one spec, and their previous home
 * (`models.drift.ts`) is a SPEC file whose top-level `describe`s include the
 * three LIVE provider canaries. Importing a spec executes its `describe`s, so
 * every importer silently adopted them: the live canaries ran inside the
 * OFFLINE `pnpm test` suite, and with a key exported that suite made a real
 * network round-trip to the providers. Keeping the primitives here and the
 * suites in `models.drift.ts` means importing the primitives can never drag a
 * live canary (or a duplicated offline test) along with it.
 *
 * `assertNoUnclassifiedFamilies` reports through vitest's `expect` (the exact
 * failure shape `scripts/drift-report-collector.ts` parses), so this module —
 * like `models.drift.ts` before it — is still not importable from a plain
 * `npx tsx` process. That is why `scripts/drift-sync.ts` continues to carry
 * hand-maintained mirrors of the two pure predicates rather than importing
 * them; `drift-sync-mirror-equivalence.test.ts` guards the two copies stay
 * result-equivalent.
 */

import { expect } from "vitest";

import {
  InfraError,
  isInfraSkip,
  listOpenAIModels,
  listAnthropicModels,
  listGeminiModels,
} from "./providers.js";
import { normalizeModelFamily } from "./model-family.js";
import { NON_MODEL_TOKENS, isClassifiedFamily, includeFamilies } from "./model-registry.js";
import { formatDriftReport } from "./schema.js";
import { MIN_LISTING_SIZE, isFamilyStillReferenced } from "./deprecation-detector.js";

export type Provider = "openai" | "anthropic" | "gemini";

/**
 * Reduce a live `/models` list to the UNCLASSIFIED families: normalize each id,
 * then drop everything already classified (`include ∪ exclude`, the
 * preview/gemma exclude-by-rule patterns — see `isClassifiedFamily` in
 * model-registry.ts) or on the non-model allowlist. The returned list (sorted,
 * de-duplicated) is the drift signal.
 *
 * Exported so the co-located regression suite can exercise the EXACT
 * enumerate→normalize→subtract pipeline the live check relies on, with an
 * injected payload — no reimplementation.
 */
export function unclassifiedFamilies(modelIds: string[], provider: Provider): string[] {
  const unclassified = new Set<string>();
  for (const id of modelIds) {
    const family = normalizeModelFamily(id, provider);
    if (isClassifiedFamily(family, provider)) continue;
    if (NON_MODEL_TOKENS.has(family) || NON_MODEL_TOKENS.has(id)) continue;
    unclassified.add(family);
  }
  return [...unclassified].sort();
}

/**
 * Assert that a live `/models` list has zero unclassified families. On failure,
 * emit one critical drift diff per unclassified family inside a
 * `formatDriftReport` block so the collector routes it to the exit-2 auto-fix
 * lane (provider names match `PROVIDER_MAP` keys in the collector).
 *
 * COVERAGE STATUS — GUARDED, behaviourally, by
 * `src/__tests__/drift/live-canary-silence.test.ts`. That harness stubs the HTTP
 * layer and drives the whole chain (fetcher → `runUnclassifiedFamilyCanary` →
 * this wrapper → `formatDriftReport` → the collector's real `parseDriftBlock`),
 * so neutering this function's computed `unclassified` to `[]`, or replacing its
 * `report` with an unformatted string, reddens that harness. Text pins on this
 * function do NOT close that class (see the harness header); observing the
 * chain's OUTPUT does.
 *
 * Exported because the three live legs of `models.drift.ts` reach it through
 * {@link runUnclassifiedFamilyCanary}.
 */
export function assertNoUnclassifiedFamilies(
  modelIds: string[],
  provider: Provider,
  context: string,
): void {
  const unclassified = unclassifiedFamilies(modelIds, provider);
  const report =
    unclassified.length > 0
      ? formatDriftReport(
          context,
          unclassified.map((family) => ({
            path: `models/${family}`,
            severity: "critical" as const,
            issue:
              `Unclassified model family "${family}" in ${provider} /models — ` +
              `add it to includeFamilies (aimock mocks it) or excludeFamilies ` +
              `(non-text / retired / preview) in model-registry.ts`,
            expected: "(family in includeFamilies ∪ excludeFamilies)",
            real: family,
            mock: "<no mock leg — live /models family canary>",
          })),
        )
      : `No drift detected: ${context}`;
  expect(unclassified, report).toEqual([]);
}

/**
 * The live TEXT-lane canary LEG itself: fetch one provider's live `/models`
 * listing and assert it carries no unclassified family.
 *
 * WHY THIS IS A FUNCTION and not inlined in each `models.drift.ts` leg — the
 * CALL SITE (which list the fetcher's result is handed to) is one of the frames
 * a silencing edit can hit, and `models.drift.ts` is a spec file whose top-level
 * `describe`s are the LIVE canaries, so no offline test may import it to drive
 * that frame. Hoisting the leg body here makes the call site reachable from the
 * offline, fetch-stubbed harness in `live-canary-silence.test.ts` while the spec
 * keeps only the env gate and the `it()`.
 */
export async function runUnclassifiedFamilyCanary(
  provider: Provider,
  apiKey: string,
  context: string,
): Promise<void> {
  const fetchLiveModels = {
    openai: listOpenAIModels,
    anthropic: listAnthropicModels,
    gemini: listGeminiModels,
  }[provider];
  const models = await fetchLiveModels(apiKey);
  assertNoUnclassifiedFamilies(models, provider, context);
}

// ---------------------------------------------------------------------------
// C4: deterministic DEPRECATION detector — `classified − live` (net-new).
//
// The mirror image of `unclassifiedFamilies`: instead of a live family with no
// classification (drift = a new family), this flags a CLASSIFIED family
// (one aimock actively mocks, i.e. `includeFamilies[provider]`) that a
// healthy live `/models` listing no longer contains — a mechanical, zero-LLM
// signal the provider retired it.
//
// FAIL-CLOSED (safety-critical — a net-new DESTRUCTIVE path): never emit a
// removal signal off a listing that is empty, short/truncated, or that the
// caller could not fetch at all (infra error). A transient truncated or
// failed `/models` response must never look like "every family disappeared"
// and cascade into proposing to nuke the registry. The floor defaults to
// `MIN_LISTING_SIZE[provider]` (deprecation-detector.ts): an explicit
// per-provider count of RAW IDS, set below the smallest healthy listing there
// is evidence for. It is deliberately NOT the number of families aimock mocks
// — comparing raw ids against a family count is a unit mismatch that silently
// switched anthropic's deprecation half off for weeks; the rationale for that
// default is documented, with the numbers, on `MIN_LISTING_SIZE` itself.
//
// A family that clears the fail-closed floor and is genuinely missing from
// the live listing is still not auto-proposed for removal if it is STILL
// REFERENCED elsewhere in aimock's own source (DEFAULT_MODELS, builders,
// fixtures — see `isFamilyStillReferenced` in `deprecation-detector.ts`):
// that case routes to a human instead (§4.4 — no silent auto-classify).
// ---------------------------------------------------------------------------

/** One `classified − live` candidate, tagged with whether aimock's own source
 * still references it (in which case it must route to a human, not be
 * auto-proposed for removal — see module doc above). */
export interface DeprecationCandidate {
  provider: Provider;
  family: string;
  stillReferenced: boolean;
}

export type DeprecationCheckResult =
  | { status: "skipped"; reason: string }
  | { status: "checked"; candidates: DeprecationCandidate[] };

/**
 * Pure `classified − live` diff for one provider, given an already-fetched
 * live `/models` id list. Fail-closed on an empty/short listing (see module
 * doc). `opts.isReferenced` defaults to the real source-tree ref-scan
 * (`isFamilyStillReferenced`) but is injectable so callers/tests can supply a
 * deterministic stub without touching the filesystem.
 */
export function detectDeprecatedFamilies(
  liveModelIds: string[],
  provider: Provider,
  opts: {
    isReferenced?: (family: string, provider: Provider) => boolean;
    minListingSize?: number;
  } = {},
): DeprecationCheckResult {
  const classified = includeFamilies[provider];
  const floor = opts.minListingSize ?? MIN_LISTING_SIZE[provider];

  if (liveModelIds.length === 0 || liveModelIds.length < floor) {
    return {
      status: "skipped",
      reason:
        `live /models listing too short to trust for ${provider} ` +
        `(${liveModelIds.length} raw id(s), need >= ${floor} — the smallest ` +
        `listing this provider plausibly returns) — never mass-removing off a ` +
        `truncated or empty listing`,
    };
  }

  const liveFamilies = new Set(liveModelIds.map((id) => normalizeModelFamily(id, provider)));
  const missing = [...classified].filter((family) => !liveFamilies.has(family)).sort();
  const isReferenced = opts.isReferenced ?? isFamilyStillReferenced;

  return {
    status: "checked",
    candidates: missing.map((family) => ({
      provider,
      family,
      stillReferenced: isReferenced(family, provider),
    })),
  };
}

/**
 * Async wrapper around {@link detectDeprecatedFamilies} for a real live-fetch
 * function: classifies a thrown {@link InfraError} via `isInfraSkip` (R0) as
 * an honest SKIP — the same auth/credit/rate-limit/5xx conditions the other
 * live legs treat as a transient provider-side outage, never a drift/removal
 * finding. A non-infra error still propagates (never silently swallowed).
 */
export async function checkDeprecatedFamiliesLive(
  fetchLiveModels: () => Promise<string[]>,
  provider: Provider,
  opts: {
    isReferenced?: (family: string, provider: Provider) => boolean;
    minListingSize?: number;
  } = {},
): Promise<DeprecationCheckResult> {
  try {
    const liveModelIds = await fetchLiveModels();
    return detectDeprecatedFamilies(liveModelIds, provider, opts);
  } catch (err) {
    if (err instanceof InfraError && isInfraSkip(err.status)) {
      return {
        status: "skipped",
        reason:
          `infra error (status ${err.status}) fetching live /models for ` +
          `${provider} — never mass-removing off a failed listing`,
      };
    }
    throw err;
  }
}
