/**
 * Mirror-equivalence guard for the sync core's hand-maintained classification
 * mirrors.
 *
 * `scripts/drift-sync.ts` cannot import `src/__tests__/drift/models.drift.ts`
 * directly (see its own "NOTE ON WHY THIS DOES NOT IMPORT `models.drift.ts`
 * DIRECTLY" comment): merely evaluating that module's `import { describe, it,
 * expect } from "vitest"` throws outside an active vitest worker, and
 * `drift-sync.ts` also runs as a plain `npx tsx` CI step. So it instead
 * MIRRORS `models.drift.ts`'s `detectDeprecatedFamilies` / `unclassifiedFamilies`
 * byte-for-byte as `detectDeprecatedFamiliesForSync` / `unclassifiedFamiliesForSync`,
 * composed from the SAME underlying data/logic modules (`model-registry.ts`,
 * `model-family.ts`, `deprecation-detector.ts`).
 *
 * Nothing previously proved the two textually-separate copies stay RESULT-
 * equivalent as either evolves — a hand-edit to one (a sort order tweak, a
 * dropped `NON_MODEL_TOKENS` check, a changed fail-closed floor, ...) could
 * silently diverge from the other with every other test still green, since
 * `drift-sync-core.test.ts` only asserts the mirror's own fixtures/expectations
 * in isolation, never against the source it mirrors.
 *
 * THIS file runs inside vitest, so — unlike `drift-sync.ts` itself — it CAN
 * safely import both copies directly and feed each the SAME representative
 * inputs, asserting identical classification results. A future edit that
 * widens/narrows one copy without mirroring the change into the other now
 * fails CI here.
 */
import { describe, it, expect } from "vitest";

import {
  detectDeprecatedFamiliesForSync,
  unclassifiedFamiliesForSync,
} from "../../scripts/drift-sync.js";
import { detectDeprecatedFamilies, unclassifiedFamilies } from "./drift/models.drift.js";
import { includeFamilies } from "./drift/model-registry.js";

type Provider = "openai" | "anthropic" | "gemini";

describe("drift-sync mirror ≡ models.drift.ts source (classification equivalence)", () => {
  const provider: Provider = "openai";

  it("unclassifiedFamilies: retired/new/empty/mixed live-listing fixtures classify identically", () => {
    const fixtures: string[][] = [
      // A genuinely new/unclassified family.
      ["gpt-live"],
      // A still-classified family via a dated snapshot (zero drift).
      ["gpt-4o-2024-08-06"],
      // An empty live listing.
      [],
      // A mixed listing: every known family plus two brand-new ones.
      [...includeFamilies.openai, "gpt-live", "gpt-super-new-2077"],
    ];
    for (const modelIds of fixtures) {
      expect(unclassifiedFamiliesForSync(modelIds, provider)).toEqual(
        unclassifiedFamilies(modelIds, provider),
      );
    }
  });

  it("detectDeprecatedFamilies: fail-closed empty/short live listings classify identically", () => {
    expect(detectDeprecatedFamiliesForSync([], provider)).toEqual(
      detectDeprecatedFamilies([], provider),
    );
    expect(detectDeprecatedFamiliesForSync(["gpt-4o"], provider)).toEqual(
      detectDeprecatedFamilies(["gpt-4o"], provider),
    );
  });

  it("detectDeprecatedFamilies: a retired-but-still-referenced family classifies identically", () => {
    const allButGpt4o = [...includeFamilies.openai].filter((f) => f !== "gpt-4o");
    const liveIds = [...allButGpt4o, ...allButGpt4o.map((f) => `${f}-2025-01-01`)];
    expect(
      detectDeprecatedFamiliesForSync(liveIds, provider, { isReferenced: () => true }),
    ).toEqual(detectDeprecatedFamilies(liveIds, provider, { isReferenced: () => true }));
  });

  it("detectDeprecatedFamilies: a healthy listing missing nothing classifies identically (real isFamilyStillReferenced)", () => {
    const allFamilies = [...includeFamilies.openai];
    const liveIds = [...allFamilies, ...allFamilies.map((f) => `${f}-2025-01-01`)];
    expect(detectDeprecatedFamiliesForSync(liveIds, provider)).toEqual(
      detectDeprecatedFamilies(liveIds, provider),
    );
  });

  it("detectDeprecatedFamilies (anthropic): a non-forward-looking retirement classifies identically to the canonical mirror", () => {
    // Strengthens the shared-logic mirror-fidelity guard above (which only
    // exercised `provider: "openai"`, a provider with zero forward-looking
    // families) by running the same "faithfully mirrored" assertion against
    // `anthropic`, a provider that DOES have a forward-looking family
    // (`claude-fable-5` — see `FORWARD_LOOKING_FAMILIES` in
    // deprecation-detector.ts). This fixture keeps that forward-looking
    // family present in the live listing (i.e. NOT missing), so it never
    // enters the one lane where the two are meant to diverge (see the
    // dedicated divergence test below) — it only proves the mirror is
    // faithful for an ordinary retirement.
    const anthropicProvider: Provider = "anthropic";
    const allAnthropic = [...includeFamilies.anthropic];
    const genuinelyRetired = "claude-3-opus";
    const liveFamiliesList = allAnthropic.filter((f) => f !== genuinelyRetired);
    const liveIds = [...liveFamiliesList, ...liveFamiliesList.map((f) => `${f}-2025-01-01`)];

    expect(detectDeprecatedFamiliesForSync(liveIds, anthropicProvider)).toEqual(
      detectDeprecatedFamilies(liveIds, anthropicProvider),
    );
  });

  it("detectDeprecatedFamilies: the sync mirror's forward-looking-family exclusion is an INTENTIONAL, bounded divergence from the canonical detector", () => {
    // `scripts/drift-sync.ts`'s `detectDeprecatedFamiliesForSync` applies an
    // extra `.filter((family) => !isForwardLookingFamily(family, provider))`
    // that the canonical `detectDeprecatedFamilies` (this file's import from
    // `./drift/models.drift.js`) does NOT apply. This is DELIBERATE layering,
    // not drift to reconcile: the canonical detector's job is DETECTION —
    // report every classified family missing from the live listing. The sync
    // mirror's job additionally applies a removal POLICY on top of that
    // detection — never propose removing a family merely because it hasn't
    // launched yet — scoped ONLY to the small allowlist in
    // `FORWARD_LOOKING_FAMILIES` (deprecation-detector.ts). So for a live
    // listing missing a forward-looking family, the two are EXPECTED to
    // disagree, and this test guards that the disagreement exists and stays
    // bounded to forward-looking families only (a genuine retirement in the
    // same listing must still be reported by both).
    //
    // Do NOT "fix" a future failure here by deleting the forward-looking
    // filter from drift-sync.ts to make the two identical again — that would
    // reintroduce false-positive removal proposals for families that simply
    // haven't shipped yet. If this test fails after touching drift-sync.ts,
    // check whether that filter was accidentally removed.
    const anthropicProvider: Provider = "anthropic";
    const allAnthropic = [...includeFamilies.anthropic];
    const genuinelyRetired = "claude-3-opus";
    const forwardLooking = "claude-fable-5";
    const liveFamiliesList = allAnthropic.filter(
      (f) => f !== genuinelyRetired && f !== forwardLooking,
    );
    const liveIds = [...liveFamiliesList, ...liveFamiliesList.map((f) => `${f}-2025-01-01`)];

    const syncResult = detectDeprecatedFamiliesForSync(liveIds, anthropicProvider);
    const canonicalResult = detectDeprecatedFamilies(liveIds, anthropicProvider);

    expect(syncResult.status).toBe("checked");
    expect(canonicalResult.status).toBe("checked");
    if (syncResult.status !== "checked" || canonicalResult.status !== "checked") {
      throw new Error("expected both results to be 'checked' for this fixture");
    }

    const syncFamilies = syncResult.candidates.map((c) => c.family);
    const canonicalFamilies = canonicalResult.candidates.map((c) => c.family);

    // The one intended divergence: the sync mirror excludes the
    // forward-looking family; the canonical detector still reports it.
    expect(syncFamilies).not.toContain(forwardLooking);
    expect(canonicalFamilies).toContain(forwardLooking);

    // Bounded: both still agree on the genuine retirement in the same
    // listing — this is not a general drift between the two detectors.
    expect(syncFamilies).toContain(genuinelyRetired);
    expect(canonicalFamilies).toContain(genuinelyRetired);
  });
});
