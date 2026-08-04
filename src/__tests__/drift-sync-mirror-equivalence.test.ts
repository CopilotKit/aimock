/**
 * Mirror-equivalence guard for the sync core's hand-maintained classification
 * mirrors.
 *
 * `scripts/drift-sync.ts` cannot import the canonical detectors directly (see
 * its own "NOTE ON WHY THIS DOES NOT IMPORT `models.drift.ts` DIRECTLY"
 * comment): merely evaluating a module that imports from `"vitest"` throws
 * outside an active vitest worker, and `drift-sync.ts` also runs as a plain
 * `npx tsx` CI step. That still holds for their present home,
 * `src/__tests__/drift/text-drift.ts`, which imports vitest's `expect` for
 * `assertNoUnclassifiedFamilies`. So `drift-sync.ts` instead MIRRORS
 * `detectDeprecatedFamilies` / `unclassifiedFamilies` byte-for-byte as
 * `detectDeprecatedFamiliesForSync` / `unclassifiedFamiliesForSync`,
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
 *
 * THE FIXTURES ARE LOAD-BEARING, not illustrative. Each of the three
 * divergences named above is only actually caught if some fixture DISTINGUISHES
 * the two behaviours, and originally only the fail-closed floor did: no fixture
 * contained a `NON_MODEL_TOKENS` member, and every fixture's output happened to
 * already be in insertion order, so dropping the mirror's token check or its
 * `.sort()` left all of these tests green. Do not "simplify" the fixture list by
 * removing cases that look like near-duplicates of each other — verify first
 * that the mutation each one exists to catch still reddens without it.
 *
 * NOTE THAT THERE ARE TWO `.sort()`s, one per mirrored function, and each needs
 * its OWN order-distinguishing fixture. Covering `unclassifiedFamiliesForSync`'s
 * sort did not cover `detectDeprecatedFamiliesForSync`'s: every deprecation
 * fixture here produced at most ONE candidate, and the sole two-candidate case
 * asserted with order-INSENSITIVE `toContain`, so dropping the deprecation
 * copy's `.sort()` left this whole guard (and `drift-sync-core.test.ts`) green.
 * Each mutation below was re-run against this file after the fixture was added:
 * dropping either `.sort()`, the `NON_MODEL_TOKENS` check, or the fail-closed
 * floor now reddens.
 */
import { describe, it, expect } from "vitest";

import {
  detectDeprecatedFamiliesForSync,
  unclassifiedFamiliesForSync,
  type Provider,
} from "../../scripts/drift-sync.js";
import { detectDeprecatedFamilies, unclassifiedFamilies } from "./drift/text-drift.js";
import { includeFamilies } from "./drift/model-registry.js";

/**
 * The two families to drop from a live listing so the resulting `missing` set
 * distinguishes a SORTED copy from an unsorted one: the first pair, in
 * `includeFamilies[provider]`'s insertion order, that is NOT already in
 * alphabetical order. Derived rather than hard-coded so a future reordering of
 * the registry cannot quietly turn the fixture that uses it into a no-op.
 *
 * Throws if the registry happens to be fully sorted, because then no
 * two-family removal can tell the two orders apart and the fixture would be
 * vacuous — a loud failure is the point (`String.sort()`'s default comparator
 * and `>` on strings both order by UTF-16 code unit, so this pair really does
 * invert under `.sort()`).
 */
function firstUnsortedPair(provider: Provider): [string, string] {
  const insertionOrder = [...includeFamilies[provider]];
  for (let i = 0; i < insertionOrder.length; i++) {
    for (let j = i + 1; j < insertionOrder.length; j++) {
      if (insertionOrder[i] > insertionOrder[j]) return [insertionOrder[i], insertionOrder[j]];
    }
  }
  throw new Error(
    `includeFamilies.${provider} is in strict alphabetical order, so removing two of its ` +
      `families can no longer distinguish a sorted candidate list from an unsorted one. ` +
      `This fixture would silently stop guarding the mirror's \`.sort()\` — add an ` +
      `explicitly out-of-order case instead of deleting it.`,
  );
}

describe("drift-sync mirror ≡ text-drift.ts source (classification equivalence)", () => {
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
      // Exercises the NON_MODEL_TOKENS suppression specifically. Every fixture
      // above is token-free, so dropping the mirror's
      // `NON_MODEL_TOKENS.has(...)` line left this whole guard green even though
      // its docstring claims to protect that check. `gemini-interactions` is the
      // sole token and is NOT otherwise classified for openai, so with the check
      // this listing yields [] and without it yields ["gemini-interactions"].
      //
      // Scope, precisely: this covers dropping the token check as a WHOLE. It
      // does NOT distinguish the line's two clauses — `gemini-interactions`
      // normalizes to itself, so `has(family)` alone suppresses it and the
      // `|| NON_MODEL_TOKENS.has(id)` half is unexercised (verified: reducing the
      // mirror's line to `has(family)` keeps this file green). That half only
      // becomes reachable if a future token normalizes to something OTHER than
      // itself, at which point a fixture carrying that raw id belongs here too.
      ["gpt-4o", "gemini-interactions"],
      // Exercises the `.sort()` specifically. Every fixture above happens to
      // produce output that is ALREADY in insertion order, so dropping the
      // mirror's `.sort()` was likewise invisible. These two unclassified
      // families are supplied in reverse-alphabetical order, so insertion order
      // (["gpt-omega", "gpt-alpha"]) and sorted order (["gpt-alpha",
      // "gpt-omega"]) differ — and `toEqual` on arrays is order-sensitive, so
      // only one copy sorting is a mismatch.
      ["gpt-omega", "gpt-alpha"],
    ];
    for (const modelIds of fixtures) {
      // Name the fixture in the message: seven listings share this one `it`, and
      // a bare array-mismatch diff does not say WHICH one diverged.
      expect(
        unclassifiedFamiliesForSync(modelIds, provider),
        `mirror/source disagreed on fixture ${JSON.stringify(modelIds)}`,
      ).toEqual(unclassifiedFamilies(modelIds, provider));
    }
  });

  it("unclassifiedFamilies (gemini): the exclude-by-RULE lanes classify identically", () => {
    // The `provider` const above is `openai`, whose classification never reaches
    // the PREVIEW_FAMILY / GEMMA_FAMILY exclude-by-rule patterns in practice —
    // so nothing here exercised the two rule lanes, on either copy. Gemini is
    // the provider those rules exist for.
    const geminiProvider: Provider = "gemini";
    const fixtures: string[][] = [
      ["gemini-9-pro-preview"], // PREVIEW_FAMILY exclude-by-rule
      ["gemma-4-31b-it"], // GEMMA_FAMILY exclude-by-rule
      ["gemini-interactions"], // the sole NON_MODEL_TOKEN, under its own provider
      [...includeFamilies.gemini, "gemini-omega", "gemini-alpha"], // reverse-alphabetical unknowns
    ];
    for (const modelIds of fixtures) {
      expect(
        unclassifiedFamiliesForSync(modelIds, geminiProvider),
        `mirror/source disagreed on gemini fixture ${JSON.stringify(modelIds)}`,
      ).toEqual(unclassifiedFamilies(modelIds, geminiProvider));
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

  it("detectDeprecatedFamilies: a healthy listing missing nothing classifies identically, with zero candidates", () => {
    const allFamilies = [...includeFamilies.openai];
    const liveIds = [...allFamilies, ...allFamilies.map((f) => `${f}-2025-01-01`)];
    const syncResult = detectDeprecatedFamiliesForSync(liveIds, provider);
    expect(syncResult).toEqual(detectDeprecatedFamilies(liveIds, provider));
    // Pin what "healthy" means here, so the equivalence above cannot be
    // satisfied by both copies going equally wrong (e.g. both skipping). This
    // fixture's `missing` set is EMPTY, so it does not reach
    // `isFamilyStillReferenced` at all — the real reference scan is exercised by
    // the two-missing-families fixture below, which passes no `isReferenced`.
    expect(syncResult).toEqual({ status: "checked", candidates: [] });
  });

  it("detectDeprecatedFamilies: two families missing in a non-alphabetical registry order classify identically (pins the mirror's `.sort()`)", () => {
    // The deprecation lane's own `.sort()` guard. Every other fixture in this
    // file yields at most ONE missing family — and one candidate is trivially
    // "in order" — while the forward-looking divergence test below yields two
    // but asserts with order-INSENSITIVE `toContain`. So dropping
    // `detectDeprecatedFamiliesForSync`'s `.sort()` left every test here green,
    // even though this file's docstring claimed the sort was covered (the
    // fixture that covers it guards `unclassifiedFamiliesForSync`'s sort, a
    // DIFFERENT `.sort()` in a different function).
    //
    // Both copies build `missing` from `[...includeFamilies[provider]]`, i.e. in
    // registry INSERTION order, then sort. Removing a pair whose insertion order
    // is not alphabetical therefore makes sorted and unsorted output differ, and
    // `toEqual` on the result object is order-sensitive.
    const [insertedFirst, alphabeticallyFirst] = firstUnsortedPair(provider);
    const liveFamilies = [...includeFamilies[provider]].filter(
      (f) => f !== insertedFirst && f !== alphabeticallyFirst,
    );
    const liveIds = [...liveFamilies, ...liveFamilies.map((f) => `${f}-2025-01-01`)];

    const syncResult = detectDeprecatedFamiliesForSync(liveIds, provider);
    const canonicalResult = detectDeprecatedFamilies(liveIds, provider);

    // Order-sensitive: a mismatch in candidate ORDER alone fails here.
    expect(syncResult).toEqual(canonicalResult);

    // …and pin the order absolutely, not just relatively, so dropping the
    // `.sort()` from BOTH copies at once (which keeps them equivalent) still
    // reddens. Sorted order is the reverse of the insertion order of this pair,
    // by construction of `firstUnsortedPair`.
    expect(syncResult.status).toBe("checked");
    if (syncResult.status !== "checked") {
      throw new Error("expected 'checked' for a listing well above the fail-closed floor");
    }
    expect(syncResult.candidates.map((c) => c.family)).toEqual([
      alphabeticallyFirst,
      insertedFirst,
    ]);
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
    // `./drift/text-drift.js`) does NOT apply. This is DELIBERATE layering,
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
