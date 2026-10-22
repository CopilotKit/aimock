/**
 * C2: deterministic drift-sync CORE — the DATA-only, ZERO-LLM replacement for
 * the freewriter's DECISION role on the model-churn (add/deprecate) leg.
 *
 * Exercises `runDriftSyncCore` and its building blocks (the mirrored
 * classification predicates, the AST-located mechanical registry edits, and
 * the needs-human dedup note-file mechanism) purely over injected deps — no
 * real fs/git/network I/O, so every scenario below is deterministic and fast.
 *
 * RED (observed before this module existed): `scripts/drift-sync.ts` exported
 * only the C1 git/branch/commit/PR plumbing (todayStamp, exec, getChangedFiles,
 * buildPrBody, gatedCommitFiles, ...) — none of `runDriftSyncCore`,
 * `detectDeprecatedFamiliesForSync`, `addFamilyLiteralInSource`, etc. existed,
 * so a live churn scenario (a new classified model, or a retired family) had NO
 * mechanical sync path at all: the only remediation route was the LLM
 * freewriter. Verbatim capture of that RED state (this test file against the
 * pre-C2 module) is in the slot's final report.
 */
import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";

import { includeFamilies, excludeFamilies, deprecatedFamilies } from "./drift/model-registry.js";
import { isKnownVoiceModelFamily, isVoiceModelId } from "./drift/voice-models.js";
import { MIN_LISTING_SIZE, FORWARD_LOOKING_FAMILIES } from "./drift/deprecation-detector.js";
import {
  detectDeprecatedFamiliesForSync,
  unclassifiedFamiliesForSync,
  addFamilyLiteralInSource,
  proposalNoteRelPath,
  parseProposalDecision,
  updateDataFrozenPin,
  onlyPinsChanged,
  verifyPinFileEdit,
  diffPinKeys,
  needsVoiceSeedSetEdit,
  SYNC_REPINNABLE_KEYS,
  computeMembershipPin,
  dataFrozenKey,
  renderProposalNote,
  runDriftSyncCore,
  computeChangesetKey,
  revertSyncFiles,
  buildSyncCommitMessage,
  COMMIT_LINE_MAX_LENGTH,
  SyncCoreReason,
  MODEL_REGISTRY_REL_PATH,
  LOGIC_PIN_REL_PATH,
  DRIFT_PROPOSALS_DIR,
  type SyncCoreDeps,
  type ProviderChurnInput,
  type SyncCheckResultLike,
  type SyncCoreOutcome,
  type Provider,
} from "../../scripts/drift-sync.js";

// ---------------------------------------------------------------------------
// Test fixture: a minimal, synthetic "model-registry.ts"-shaped source text —
// same array-literal-inside-a-2-arg-call-expression shape the real file uses,
// seeded with the REAL openai includeFamilies set (so a removal target like
// "gpt-4o" is guaranteed present, and an addition target like "gpt-zeta" is
// guaranteed absent — mirrors C4's own test fixtures in models.drift.ts).
// ---------------------------------------------------------------------------

function fixtureRegistrySource(): string {
  const openaiFamilies = [...includeFamilies.openai];
  const lines = [
    "export const includeFamilies = {",
    '  openai: set("openai", [',
    ...openaiFamilies.map((f) => `    "${f}",`),
    "  ]),",
    '  anthropic: set("anthropic", [',
    '    "claude-3-5-sonnet",',
    "  ]),",
    '  gemini: set("gemini", [',
    '    "gemini-2.5-flash",',
    "  ]),",
    "};",
    // excludeFamilies — the set a `Decision: exclude` verdict lands in. Present
    // in the fixture because the sync can now edit it; without it the exclude
    // path can only ever report a structural mismatch.
    "export const excludeFamilies = {",
    '  openai: set("openai", [',
    '    "dall-e-3",',
    "  ]),",
    '  anthropic: set("anthropic", [',
    '    "claude-instant",',
    "  ]),",
    '  gemini: set("gemini", [',
    '    "gemini-1.0-pro-vision",',
    "  ]),",
    "};",
    // The recorded-deprecation ledger, in the shape the real file ships it:
    // three EMPTY arrays held open by a comment. Empty is the shape that
    // matters — it is the only one where the insert has no sibling element to
    // copy an indent from, and it is what the real registry looks like on the
    // first morning a provider retires anything.
    "export const deprecatedFamilies = {",
    '  openai: set("openai", [',
    "    // drift-sync appends recorded deprecations here.",
    "  ]),",
    '  anthropic: set("anthropic", [',
    "    // drift-sync appends recorded deprecations here.",
    "  ]),",
    '  gemini: set("gemini", [',
    "    // drift-sync appends recorded deprecations here.",
    "  ]),",
    "};",
  ];
  return lines.join("\n");
}

/**
 * `count` anthropic families that stand in for GENUINELY RETIRED ones: each is
 * classified INCLUDE, not forward-looking, and not already in the recorded
 * deprecation ledger — so the sync mirror's `missing` set really does report it.
 *
 * DERIVED, NEVER HARD-CODED, and that is load-bearing. `deprecatedFamilies`
 * GROWS on its own: drift-sync appends to it unattended the morning a provider
 * retires a family. A fixture pinned to a literal `claude-3-opus` silently
 * stops being a valid stand-in the moment the sync records that family — the
 * mirror then (correctly) drops it, and the fixture asserts on an empty
 * candidate list. Observed: recording anthropic's ten 2026-08-07 retirements
 * broke four tests across this file and the mirror-equivalence guard at once.
 * Throws loudly rather than letting a fixture go quietly vacuous.
 */
function unrecordedAnthropicFamilies(count: number): string[] {
  const usable = [...includeFamilies.anthropic].filter(
    (f) => !deprecatedFamilies.anthropic.has(f) && !FORWARD_LOOKING_FAMILIES.anthropic.has(f),
  );
  if (usable.length < count) {
    throw new Error(
      `need ${count} anthropic families that are neither forward-looking nor already recorded ` +
        `as deprecated, but only ${usable.length} remain (${usable.join(", ")}). These fixtures ` +
        `need a family the deprecation detector will actually report; pick a different provider ` +
        `rather than deleting the assertion.`,
    );
  }
  return usable.slice(0, count);
}

/**
 * Re-parse an edited registry source and read back `exportName[provider]`'s
 * array members, using the TypeScript parser DIRECTLY rather than the sync's own
 * `locateFamilySetArray`. Deliberately independent: an edit that lands in the
 * wrong array — or produces text that no longer parses — has to be visible to
 * something other than the code that made it. `toEqual` on the member list is
 * order-sensitive, so an append that lands in the wrong position shows up too.
 */
function parsedFamilyArray(sourceText: string, exportName: string, provider: string): string[] {
  const sf = ts.createSourceFile("registry.ts", sourceText, ts.ScriptTarget.Latest, true);
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.name.text !== exportName) continue;
      if (!decl.initializer || !ts.isObjectLiteralExpression(decl.initializer)) continue;
      for (const prop of decl.initializer.properties) {
        if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
        if (prop.name.text !== provider) continue;
        const init = prop.initializer;
        if (!ts.isCallExpression(init) || !ts.isArrayLiteralExpression(init.arguments[1])) continue;
        return init.arguments[1].elements
          .filter(ts.isStringLiteral)
          .map((el: ts.StringLiteral) => el.text);
      }
    }
  }
  throw new Error(`could not parse ${exportName}.${provider} out of the edited source`);
}

/** In-memory fake fs + gate for runDriftSyncCore — no real disk/git touched. */
function makeFakeDeps(overrides: Partial<SyncCoreDeps> = {}): {
  deps: SyncCoreDeps;
  registry: { text: string };
  logicPin: { text: string };
  notes: Map<string, string>;
  writeRegistrySource: ReturnType<typeof vi.fn>;
  writeLogicPinSource: ReturnType<typeof vi.fn>;
  writeProposalNote: ReturnType<typeof vi.fn>;
  runSyncCheck: ReturnType<typeof vi.fn>;
  revertFiles: ReturnType<typeof vi.fn>;
} {
  const registry = { text: fixtureRegistrySource() };
  const logicPin = { text: fixtureLogicPinSource() };
  const notes = new Map<string, string>();

  const writeRegistrySource = vi.fn((text: string) => {
    registry.text = text;
  });
  const writeLogicPinSource = vi.fn((text: string) => {
    logicPin.text = text;
  });
  const writeProposalNote = vi.fn((path: string, text: string) => {
    notes.set(path, text);
  });
  const runSyncCheck = vi.fn(
    (): SyncCheckResultLike => ({ ok: true, reason: "ok", detail: "gate passed" }),
  );
  const revertFiles = vi.fn();

  const deps: SyncCoreDeps = {
    readRegistrySource: () => registry.text,
    writeRegistrySource,
    readLogicPinSource: () => logicPin.text,
    writeLogicPinSource,
    readProposalNote: (path: string) => notes.get(path) ?? null,
    writeProposalNote,
    runSyncCheck,
    revertFiles,
    now: () => new Date("2026-07-22T00:00:00Z"),
    ...overrides,
  };

  return {
    deps,
    registry,
    logicPin,
    notes,
    writeRegistrySource,
    writeLogicPinSource,
    writeProposalNote,
    runSyncCheck,
    revertFiles,
  };
}

/**
 * Minimal DATA_FROZEN-shaped stand-in for logic-pin.test.ts. Only the two keys
 * the sync can move are modelled; the pin values are placeholders, since what
 * the tests assert is that the RIGHT key moved and that nothing outside a
 * `pin:` literal was touched — not any particular hash.
 */
function fixtureLogicPinSource(): string {
  return [
    "const DATA_FROZEN: Record<string, { members: () => string[]; pin: string }> = {",
    '  "includeFamilies.openai": {',
    "    members: () => [...includeFamilies.openai].sort(),",
    '    pin: "' + "0".repeat(64) + '",',
    "  },",
    '  "excludeFamilies.openai": {',
    "    members: () => [...excludeFamilies.openai].sort(),",
    '    pin: "' + "1".repeat(64) + '",',
    "  },",
    "};",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Mirrored classification predicates — parity with C4's models.drift.ts
// (same fixtures/expectations as models.drift.ts's own C4 suite).
// ---------------------------------------------------------------------------

describe("detectDeprecatedFamiliesForSync (mirrors C4's detectDeprecatedFamilies)", () => {
  it("FAIL-CLOSED: an empty live listing never proposes removal", () => {
    expect(detectDeprecatedFamiliesForSync([], "openai").status).toBe("skipped");
  });

  it("FAIL-CLOSED: a short/truncated live listing never proposes removal", () => {
    expect(detectDeprecatedFamiliesForSync(["gpt-4o"], "openai").status).toBe("skipped");
  });

  it("a healthy listing omitting a classified family flags EXACTLY that family", () => {
    const allButGpt4o = [...includeFamilies.openai].filter((f) => f !== "gpt-4o");
    const liveIds = [...allButGpt4o, ...allButGpt4o.map((f) => `${f}-2025-01-01`)];
    const result = detectDeprecatedFamiliesForSync(liveIds, "openai", {
      isReferenced: () => false,
    });
    expect(result).toEqual({
      status: "checked",
      candidates: [{ provider: "openai", family: "gpt-4o", stillReferenced: false }],
    });
  });

  it("a still-referenced deprecated family is flagged with stillReferenced: true", () => {
    const allButGpt4o = [...includeFamilies.openai].filter((f) => f !== "gpt-4o");
    const liveIds = [...allButGpt4o, ...allButGpt4o.map((f) => `${f}-2025-01-01`)];
    const result = detectDeprecatedFamiliesForSync(liveIds, "openai", { isReferenced: () => true });
    expect(result).toEqual({
      status: "checked",
      candidates: [{ provider: "openai", family: "gpt-4o", stillReferenced: true }],
    });
  });

  // FF1 item B: `claude-fable-5` is a deliberately forward-looking INCLUDE entry
  // (see model-registry.ts's inline comment) — it is absent from every live
  // `/models` listing until it launches, which is indistinguishable from a
  // genuine retirement to a naive classified-minus-live diff. Without a guard,
  // this family is proposed for removal on EVERY daily sync run (noisy —
  // human has to reject/dismiss it every day). A genuinely-retired sibling
  // missing from the same listing must still be proposed normally.
  it("a forward-looking family (claude-fable-5) absent from live is NEVER proposed for removal, while a genuinely-retired sibling still is", () => {
    const allAnthropic = [...includeFamilies.anthropic];
    const [retired] = unrecordedAnthropicFamilies(1);
    // Live listing omits BOTH claude-fable-5 (forward-looking, not launched)
    // AND a genuinely-retired stand-in.
    const liveFamilies = allAnthropic.filter((f) => f !== "claude-fable-5" && f !== retired);
    const liveIds = [...liveFamilies, ...liveFamilies.map((f) => `${f}-20250101`)];
    const result = detectDeprecatedFamiliesForSync(liveIds, "anthropic", {
      isReferenced: () => false,
    });
    expect(result.status).toBe("checked");
    if (result.status !== "checked") return;
    const families = result.candidates.map((c) => c.family).sort();
    expect(families).toEqual([retired]);
  });
});

// ---------------------------------------------------------------------------
// The fail-closed floor is a LISTING-PLAUSIBILITY floor, not a coverage floor.
// ---------------------------------------------------------------------------

describe("the deprecation floor is a plausibility check on the LISTING, not on our coverage", () => {
  /**
   * The size of the repo's own frozen healthy anthropic `/models` wave, captured
   * 2026-07-16 and living inline in `models.drift.ts`'s "Anthropic: every live
   * family is classified" case. SIXTEEN raw ids: that is what a healthy anthropic
   * listing looks like by this repo's own record, and it was already under the
   * old floor of 20.
   *
   * The SIZE, not the ids. This file sits inside the tree
   * `isFamilyStillReferenced` scans (`src/`, minus `src/__tests__/drift/`), so a
   * real family literal written here would count as aimock still USING that
   * family and quietly route its deprecation to a human note instead of a
   * mechanical removal. Verified: pasting the sixteen real ids in moved all nine
   * currently zero-referenced anthropic families into "still referenced". Every
   * listing built below therefore uses ids that match no family.
   */
  const FROZEN_HEALTHY_ANTHROPIC_WAVE_SIZE = 16;
  const listingOfSize = (n: number, tag: string): string[] =>
    Array.from({ length: n }, (_, i) => `${tag}-live-${i}`);

  /**
   * The smallest live `/models` listing each provider is KNOWN to return when
   * healthy — the evidence every floor is set below. openai: cleared the old
   * floor of 40 on 12 of 12 retained runs. anthropic: 11 raw ids on those same
   * runs. gemini: cleared the old floor of 9, which is the only direct
   * production evidence there is (its frozen wave is 52, but a floor derived
   * from a fixture is the mistake this whole invariant exists to prevent).
   *
   * These are facts about the PROVIDERS. They do not move when aimock
   * classifies or retires a family, which is exactly the property the floor
   * needs its yardstick to have.
   */
  const SMALLEST_EVIDENCED_HEALTHY_LISTING = { openai: 40, anthropic: 11, gemini: 9 } as const;

  it("no provider's floor can ratchet with the number of families aimock mocks", () => {
    // THE DEFECT, stated as an invariant, and asserted BEHAVIOURALLY rather than
    // by reading the constant — the failure mode is a consumer that goes back to
    // `classified.size` while `MIN_LISTING_SIZE` still sits there looking right.
    //
    // `floor = includeFamilies[provider].size` compares a count of RAW IDS against
    // a count of DISTINCT FAMILIES, so every family classified raised the bar the
    // live listing had to clear. anthropic's went 19 -> 20 in a single ordinary
    // classify-one-more-family commit while its live listing only shrank, and its
    // deprecation half was skipped on 12 of 12 daily runs with surviving
    // artifacts — every one green and silent.
    //
    // The probe is the smallest listing each provider is EVIDENCED to return,
    // never `includeFamilies[provider].size - 1`. Probing one under the family
    // count re-introduces the very coupling this test forbids, just pointing the
    // other way: gemini mocks 9 families against a floor of 8, so removing a
    // single retired gemini family — the outcome the deprecation half exists to
    // produce — would drop the probe to 7, red this test, and blame a
    // coverage-tracking floor that is in fact a constant. A test whose failure
    // message misidentifies the cause is worse than no test.
    for (const provider of ["openai", "anthropic", "gemini"] as const) {
      const evidenced = SMALLEST_EVIDENCED_HEALTHY_LISTING[provider];
      expect(
        detectDeprecatedFamiliesForSync(listingOfSize(evidenced, provider), provider).status,
        `a live ${provider} listing of ${evidenced} raw ids — the smallest healthy listing ` +
          `${provider} is known to return — was refused as too short to trust, so ${provider}'s ` +
          `deprecation half is off on a perfectly ordinary day`,
      ).toBe("checked");
      // …and the constant itself agrees, so the two cannot drift apart silently.
      // `<=`, against provider evidence rather than against our own family count:
      // "never set a floor above what is proven to clear" is the whole rule.
      expect(
        MIN_LISTING_SIZE[provider],
        `${provider}'s floor is above the smallest listing it is known to return`,
      ).toBeLessThanOrEqual(evidenced);
    }
  });

  it("no floor is merely `includeFamilies[provider].size` wearing a constant's clothes", () => {
    // The evidence bound above cannot catch every revert to the old
    // `classified.size` default: openai's family count (40) is exactly its
    // evidenced clearance, and gemini's (9) is exactly its evidenced clearance
    // plus nothing, so `floor = size` would satisfy `floor <= evidence` for both.
    // This closes that gap directly.
    //
    // If this reds, the fix is to LOWER the offending provider's floor (and
    // re-pin MIN_LISTING_SIZE in logic-pin.test.ts) — never to raise it or to
    // re-classify a family to make the arithmetic work. The likely trigger is
    // benign and expected: retiring a classified family shrinks the count toward
    // the floor. gemini is the tight one — 9 families against a floor of 8, so
    // the FIRST gemini retirement lands here. That is the message to act on;
    // nothing about the floor "tracking coverage" is implied by this failure.
    for (const provider of ["openai", "anthropic", "gemini"] as const) {
      expect(
        MIN_LISTING_SIZE[provider],
        `${provider}'s floor (${MIN_LISTING_SIZE[provider]}) is no longer below the ` +
          `${includeFamilies[provider].size} families aimock classifies for it, so it is ` +
          `indistinguishable from the retired \`floor = classified.size\` default. Lower ` +
          `${provider}'s floor in deprecation-detector.ts and re-pin MIN_LISTING_SIZE.`,
      ).toBeLessThan(includeFamilies[provider].size);
    }
  });

  it("anthropic's floor is clearable by the listing PRODUCTION actually returns", () => {
    // OBSERVED, from the drift-sync-log artifacts of 12 of 12 `Fix Drift` runs
    // (2026-07-24 -> 2026-08-05): anthropic's live listing carried ELEVEN raw ids
    // (ten on the first). Any floor above that number switches the entire
    // deprecation half off, forever, on a green run. Asserted by RUNNING the
    // detector on an eleven-id listing, not by comparing numbers — the production
    // symptom was a `status: "skipped"`, so that is what has to stop happening.
    const PRODUCTION_ANTHROPIC_LISTING_SIZE = 11;
    const productionSizedListing = listingOfSize(PRODUCTION_ANTHROPIC_LISTING_SIZE, "anthropic");
    const result = detectDeprecatedFamiliesForSync(productionSizedListing, "anthropic", {
      isReferenced: () => true,
    });
    expect(
      result.status,
      "an eleven-id anthropic listing — the size OBSERVED on every retained production run — " +
        "is still refused as too short to trust, so the deprecation half is skipped every " +
        "morning and the run still reports a quiet day",
    ).toBe("checked");
  });

  it("the repo's OWN frozen healthy /models wave clears the floor, for every provider", () => {
    // The structural proof that the old floor was unreachable rather than
    // unlucky: the healthiest anthropic listing this repo has ever recorded is 16
    // ids and the floor was 20, so even a perfect day skipped. A floor a captured
    // HEALTHY listing cannot clear is not a truncation guard, it is an off switch.
    const wave = listingOfSize(FROZEN_HEALTHY_ANTHROPIC_WAVE_SIZE, "anthropic");
    const result = detectDeprecatedFamiliesForSync(wave, "anthropic", {
      isReferenced: () => true,
    });
    expect(
      result.status,
      `the frozen healthy anthropic wave (${wave.length} raw ids) is still under anthropic's ` +
        `floor of ${MIN_LISTING_SIZE.anthropic}`,
    ).toBe("checked");
  });

  it("and it is still FAIL-CLOSED: empty, and one-below-floor, both still skip", () => {
    // The negative control. Every assertion above is satisfiable by deleting the
    // floor outright, which is the destructive failure the guard exists for — a
    // truncated listing looking like "every family disappeared" and cascading
    // into a proposal to nuke the registry.
    for (const provider of ["openai", "anthropic", "gemini"] as const) {
      expect(detectDeprecatedFamiliesForSync([], provider).status).toBe("skipped");
      const oneShort = listingOfSize(MIN_LISTING_SIZE[provider] - 1, provider);
      expect(
        detectDeprecatedFamiliesForSync(oneShort, provider).status,
        `a listing of ${oneShort.length} ids cleared ${provider}'s floor of ` +
          `${MIN_LISTING_SIZE[provider]} — the fail-closed guard is off`,
      ).toBe("skipped");
    }
  });

  it("the skip REASON no longer claims the floor is the family count", () => {
    // The prose was the only place the unit mismatch was written down, and it
    // stated the wrong thing confidently: a reader of the production log was told
    // "need >= 20 — the number of families aimock mocks for this provider", which
    // reads as a coverage statement and hides that a raw-id count is on the other
    // side of the comparison.
    const skip = detectDeprecatedFamiliesForSync([], "anthropic");
    expect(skip.status).toBe("skipped");
    if (skip.status !== "skipped") return;
    expect(skip.reason).not.toContain("the number of families aimock mocks");
    expect(skip.reason).toContain(`need >= ${MIN_LISTING_SIZE.anthropic}`);
  });
});

describe("unclassifiedFamiliesForSync (mirrors C4's unclassifiedFamilies)", () => {
  it("a genuinely new family is flagged", () => {
    expect(unclassifiedFamiliesForSync(["gpt-zeta"], "openai")).toEqual(["gpt-zeta"]);
  });

  it("a dated snapshot of a known family produces zero drift", () => {
    expect(unclassifiedFamiliesForSync(["gpt-4o-2024-08-06"], "openai")).toEqual([]);
  });

  it("a -preview family auto-classifies with zero registry edits", () => {
    expect(unclassifiedFamiliesForSync(["gpt-9-search-preview"], "openai")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Mechanical registry edits — AST-located, single-line surgery.
// ---------------------------------------------------------------------------

describe("addFamilyLiteralInSource", () => {
  it("adds a new family literal, comment-marked", () => {
    const src = fixtureRegistrySource();
    const result = addFamilyLiteralInSource(
      src,
      "includeFamilies",
      "openai",
      "gpt-zeta",
      "TEST-ADD",
    );
    expect(result.changed).toBe(true);
    expect(result.text).toContain('"gpt-zeta", // TEST-ADD');
    // Every seeded family is untouched.
    for (const f of includeFamilies.openai) {
      expect(result.text).toContain(`"${f}"`);
    }
  });

  it("no-ops when the family is already present (never duplicates)", () => {
    const src = fixtureRegistrySource();
    const result = addFamilyLiteralInSource(src, "includeFamilies", "openai", "gpt-4o", "x");
    expect(result.changed).toBe(false);
  });

  it("writes into an EMPTY, comment-only array — the ledger's day-one shape", () => {
    // The empty array is the case with no sibling element to copy an indent
    // from, and it is exactly the shape `deprecatedFamilies` ships in. An
    // insert that lands one line early here would splice ABOVE the
    // `provider: set(...)` line and produce a file that does not parse.
    const src = fixtureRegistrySource();
    const result = addFamilyLiteralInSource(
      src,
      "deprecatedFamilies",
      "anthropic",
      "claude-3-5-sonnet",
      "DEPRECATED",
    );
    expect(result.changed).toBe(true);
    expect(result.text).toContain('    "claude-3-5-sonnet", // DEPRECATED');
    // It landed INSIDE deprecatedFamilies.anthropic, not in includeFamilies and
    // not in a sibling provider: the array it went into must now parse with the
    // family as a member.
    expect(parsedFamilyArray(result.text, "deprecatedFamilies", "anthropic")).toEqual([
      "claude-3-5-sonnet",
    ]);
    expect(parsedFamilyArray(result.text, "deprecatedFamilies", "openai")).toEqual([]);
    expect(parsedFamilyArray(result.text, "deprecatedFamilies", "gemini")).toEqual([]);
    expect(parsedFamilyArray(result.text, "includeFamilies", "anthropic")).toEqual([
      "claude-3-5-sonnet",
    ]);
  });

  it("the edited text is still syntactically valid TypeScript (parser round-trip)", () => {
    const src = fixtureRegistrySource();
    const added = addFamilyLiteralInSource(src, "includeFamilies", "openai", "gpt-zeta", "a");
    // A further edit against the already-edited text must still locate the
    // array correctly — proves the AST-based locator survives a prior edit.
    const secondAdd = addFamilyLiteralInSource(
      added.text,
      "includeFamilies",
      "openai",
      "gpt-zeta-2",
      "b",
    );
    expect(secondAdd.changed).toBe(true);
    expect(secondAdd.text).toContain('"gpt-zeta-2"');
    // Two successive appends into the SAME empty array must both land, and the
    // second must not be fooled by the first's trailing comment.
    const one = addFamilyLiteralInSource(src, "deprecatedFamilies", "openai", "gpt-4o", "d1");
    const two = addFamilyLiteralInSource(one.text, "deprecatedFamilies", "openai", "gpt-4", "d2");
    expect(two.changed).toBe(true);
    expect(parsedFamilyArray(two.text, "deprecatedFamilies", "openai")).toEqual([
      "gpt-4o",
      "gpt-4",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Proposal note files — dedup + decision parsing.
// ---------------------------------------------------------------------------

describe("proposal notes", () => {
  it("proposalNoteRelPath is family-keyed and stable (dedup key)", () => {
    expect(proposalNoteRelPath("openai", "gpt-zeta", "new-family")).toBe(
      `${DRIFT_PROPOSALS_DIR}/openai-gpt-zeta-new-family.md`,
    );
    expect(proposalNoteRelPath("openai", "gpt-zeta", "new-family")).toBe(
      proposalNoteRelPath("openai", "gpt-zeta", "new-family"),
    );
  });

  it("parseProposalDecision defaults to pending (fail-closed, never infers approval)", () => {
    expect(parseProposalDecision("Status: NEEDS HUMAN REVIEW\n")).toBe("pending");
    expect(parseProposalDecision("Decision: pending")).toBe("pending");
    expect(parseProposalDecision("garbage with no Decision line")).toBe("pending");
  });

  it("parseProposalDecision recognizes an explicit human-authored REJECTION (exclude)", () => {
    // The exclude path exists because a rejection is just as mechanical as an
    // approval: it writes excludeFamilies instead of includeFamilies. Before
    // this existed, `Decision: exclude` silently parsed as `pending` and the
    // family was re-routed to a human every single run, forever.
    expect(parseProposalDecision("Decision: exclude")).toBe("exclude");
    expect(parseProposalDecision("Decision: EXCLUDE")).toBe("exclude");
    expect(parseProposalDecision("Decision: Exclude\n")).toBe("exclude");
  });

  it("parseProposalDecision recognizes an explicit human-authored approval", () => {
    expect(parseProposalDecision("Decision: include")).toBe("include");
  });

  it("renderProposalNote never generates a Decision line for a structural mismatch", () => {
    // `Decision: include` is the new-family approval marker the NEXT run acts
    // on. A structural mismatch has nothing to approve — the registry's shape
    // moved and a human has to look — so offering the marker there would invite
    // an "approval" that authorises nothing.
    const note = renderProposalNote(
      "openai",
      "gpt-4o",
      "registry-structural-mismatch",
      "detail",
      "2026-07-22",
    );
    expect(note).not.toContain("## Decision");
  });
});

// ---------------------------------------------------------------------------
// runDriftSyncCore — the full orchestration, over injected deps.
// ---------------------------------------------------------------------------

describe("runDriftSyncCore", () => {
  it("RED->GREEN (empty/short listing): fail-closed no-op — no edit, no gate run", () => {
    const { deps, runSyncCheck, writeRegistrySource } = makeFakeDeps();
    const inputs: ProviderChurnInput[] = [{ provider: "openai", liveModelIds: [] }];
    const outcome = runDriftSyncCore(inputs, deps);

    expect(outcome.ok).toBe(true);
    expect(outcome.reason).toBe(SyncCoreReason.OK_NO_CHURN);
    expect(outcome.outcomes).toEqual([]);
    expect(outcome.skipped).toHaveLength(1);
    expect(outcome.skipped[0].reason).toMatch(/too short to trust/);
    expect(writeRegistrySource).not.toHaveBeenCalled();
    expect(runSyncCheck).not.toHaveBeenCalled();
  });

  /** A healthy openai listing that is missing exactly `absent`. */
  function listingMissing(absent: string[]): string[] {
    const live = [...includeFamilies.openai].filter((f) => !absent.includes(f));
    return [...live, ...live.map((f) => `${f}-2025-01-01`)];
  }

  it("RED->GREEN (deprecation, zero-reference): RECORDED mechanically, no human paged", () => {
    const { deps, registry, notes, runSyncCheck, writeProposalNote } = makeFakeDeps({
      isReferenced: () => false,
    });
    const inputs: ProviderChurnInput[] = [
      { provider: "openai", liveModelIds: listingMissing(["gpt-4o"]) },
    ];

    const outcome = runDriftSyncCore(inputs, deps);

    // RED (observed, production run 31218975992 on 2026-08-07): a deprecation
    // — of EITHER reference class — produced a `needs-human-*` outcome, so the
    // run reported `reason=needs-human`, exited 1, opened a
    // `drift-needs-human/*` PR and Slack-alerted the repo owner to "decide" a
    // retirement the provider had already published. Ten of them in one
    // morning, every morning.
    expect(outcome.outcomes).toContainEqual(
      expect.objectContaining({
        provider: "openai",
        family: "gpt-4o",
        action: "deprecation-recorded",
      }),
    );
    expect(outcome.outcomes.some((o) => o.action.startsWith("needs-human-"))).toBe(false);
    expect(outcome.ok).toBe(true);
    expect(outcome.reason).toBe(SyncCoreReason.OK_APPLIED);
    // Nobody was paged and nothing was proposed: no note file of any kind.
    expect(writeProposalNote).not.toHaveBeenCalled();
    expect(notes.size).toBe(0);

    // THE MOCK SURVIVES. `includeFamilies` is byte-identical — the family is
    // still classified, still mocked, still served. Only the ledger grew.
    expect(parsedFamilyArray(registry.text, "includeFamilies", "openai")).toEqual([
      ...includeFamilies.openai,
    ]);
    expect(parsedFamilyArray(registry.text, "deprecatedFamilies", "openai")).toEqual(["gpt-4o"]);
    // Zero-reference is recorded in the COMMENT, where it tells a human the
    // optional cleanup is safe — it no longer selects a different route.
    expect(registry.text).toContain("no remaining aimock reference");

    // A real registry edit was made, so the real gate DOES run — gate-1
    // (allowlist) and gate-2 (pin), with gate-3's live re-collect OFF and the
    // reason recorded. A recorded deprecation is invisible to every live drift
    // surface (nothing in the collector's `*.drift.ts` glob reads
    // `deprecatedFamilies`), so a re-collect can only veto this edit on
    // unrelated drift — which is how the identical changeset 74f6efa43753f7d0
    // was refused on 2026-08-11 and applied on 2026-08-12. See
    // `gate3SkipReason` and drift-sync-gate-determinism.test.ts.
    expect(runSyncCheck).toHaveBeenCalledTimes(1);
    expect(runSyncCheck).toHaveBeenCalledWith({
      skipRecollect: true,
      skipRecollectReason: expect.stringContaining(
        "no live drift surface reads deprecatedFamilies",
      ),
    });
  });

  it("RED->GREEN (deprecation, STILL-REFERENCED): also recorded, and the mock is NOT removed", () => {
    const { deps, registry, writeProposalNote } = makeFakeDeps({ isReferenced: () => true });
    const inputs: ProviderChurnInput[] = [
      { provider: "openai", liveModelIds: listingMissing(["gpt-4o"]) },
    ];

    const outcome = runDriftSyncCore(inputs, deps);

    expect(outcome.outcomes).toContainEqual(
      expect.objectContaining({
        provider: "openai",
        family: "gpt-4o",
        action: "deprecation-recorded",
      }),
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.reason).toBe(SyncCoreReason.OK_APPLIED);
    expect(writeProposalNote).not.toHaveBeenCalled();
    // The whole point of the still-referenced class: users' suites still call
    // this model. It stays in includeFamilies, so aimock keeps answering.
    expect(parsedFamilyArray(registry.text, "includeFamilies", "openai")).toContain("gpt-4o");
    expect(parsedFamilyArray(registry.text, "deprecatedFamilies", "openai")).toEqual(["gpt-4o"]);
    expect(registry.text).toContain("still referenced in aimock source — mock retained");
  });

  it("a recorded deprecation goes QUIET on the next run — the daily cron stops re-deriving it", () => {
    // The reason the ledger exists at all. Detection is a pure
    // `includeFamilies − live` diff, so without a written record the same
    // retirement is rediscovered every morning for ever.
    const { deps, registry } = makeFakeDeps({
      isReferenced: () => true,
      // Model the ledger the FIRST run wrote: the core reads the registry text
      // it edited, but `isRecordedDeprecation` reads the compiled module, so the
      // second run's silence has to come from a source the core can see.
      isRecorded: (family) => registry.text.includes(`"${family}", // DEPRECATED`),
    });
    const inputs: ProviderChurnInput[] = [
      { provider: "openai", liveModelIds: listingMissing(["gpt-4o"]) },
    ];

    const first = runDriftSyncCore(inputs, deps);
    expect(first.reason).toBe(SyncCoreReason.OK_APPLIED);
    expect(first.outcomes).toHaveLength(1);

    const second = runDriftSyncCore(inputs, deps);
    expect(second.reason).toBe(SyncCoreReason.OK_NO_CHURN);
    expect(second.ok).toBe(true);
    expect(second.outcomes).toEqual([]);
    // And it was not recorded twice.
    expect(parsedFamilyArray(registry.text, "deprecatedFamilies", "openai")).toEqual(["gpt-4o"]);
  });

  it("a whole morning's worth of deprecations records in ONE run, still zero escalations", () => {
    // The production shape: Anthropic retired ten families at once. Every one
    // must land in the same mechanical run — not nine plus one escalation.
    const absent = [...includeFamilies.openai].slice(0, 10);
    const { deps, registry } = makeFakeDeps({ isReferenced: (f) => f !== absent[0] });
    const outcome = runDriftSyncCore(
      [{ provider: "openai", liveModelIds: listingMissing(absent) }],
      deps,
    );

    expect(outcome.reason).toBe(SyncCoreReason.OK_APPLIED);
    expect(outcome.ok).toBe(true);
    expect(outcome.outcomes.filter((o) => o.action === "deprecation-recorded")).toHaveLength(10);
    expect(outcome.outcomes.some((o) => o.action.startsWith("needs-human-"))).toBe(false);
    expect(parsedFamilyArray(registry.text, "deprecatedFamilies", "openai").sort()).toEqual(
      [...absent].sort(),
    );
    // Not one of the ten left includeFamilies.
    expect(parsedFamilyArray(registry.text, "includeFamilies", "openai")).toEqual([
      ...includeFamilies.openai,
    ]);
  });

  it("RED->GREEN (genuinely new family, no prior decision): RED alert + single deduped note, no auto-classify", () => {
    const { deps, registry, writeProposalNote, notes } = makeFakeDeps();
    const inputs: ProviderChurnInput[] = [{ provider: "openai", liveModelIds: ["gpt-zeta"] }];
    // NOTE: a single unclassified live id also fails the deprecation floor
    // check (too short) — that is an independent, correctly-skipped signal;
    // this test only asserts the ADDITION half's behavior.

    const outcome = runDriftSyncCore(inputs, deps);

    expect(outcome.outcomes).toContainEqual(
      expect.objectContaining({
        provider: "openai",
        family: "gpt-zeta",
        action: "needs-human-new-family",
      }),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe(SyncCoreReason.NEEDS_HUMAN);
    // NEVER auto-classified: no registry edit occurred.
    expect(registry.text).not.toContain("gpt-zeta");
    expect(writeProposalNote).toHaveBeenCalledTimes(1);
    const [path, noteText] = writeProposalNote.mock.calls[0] as [string, string];
    expect(path).toBe(`${DRIFT_PROPOSALS_DIR}/openai-gpt-zeta-new-family.md`);
    expect(noteText).toContain("Decision: pending");
    expect(notes.size).toBe(1);

    // Re-fire: same alert, same run again — must NOT spam a second note/PR.
    writeProposalNote.mockClear();
    const outcome2 = runDriftSyncCore(inputs, deps);
    expect(writeProposalNote).not.toHaveBeenCalled();
    expect(outcome2.reason).toBe(SyncCoreReason.NEEDS_HUMAN);
    expect(outcome2.ok).toBe(false);
  });

  it("ADDITION (human-decided via note Decision: include): mechanical registry edit + gate passes", () => {
    const { deps, registry, notes, runSyncCheck } = makeFakeDeps();
    // Simulate a human having already reviewed the RED alert and flipped the
    // note's Decision line to `include` (the only path that can ever add a
    // genuinely-new family — never automatic, never LLM-authored).
    const notePath = proposalNoteRelPath("openai", "gpt-zeta", "new-family");
    notes.set(
      notePath,
      renderProposalNote("openai", "gpt-zeta", "new-family", "detail", "2026-07-20").replace(
        "Decision: pending",
        "Decision: include",
      ),
    );

    const inputs: ProviderChurnInput[] = [{ provider: "openai", liveModelIds: ["gpt-zeta"] }];
    const outcome = runDriftSyncCore(inputs, deps);

    expect(outcome.outcomes).toContainEqual(
      expect.objectContaining({ provider: "openai", family: "gpt-zeta", action: "added" }),
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.reason).toBe(SyncCoreReason.OK_APPLIED);
    expect(registry.text).toContain('"gpt-zeta"');
    expect(registry.text).toContain(`decided via ${notePath}`);
    expect(runSyncCheck).toHaveBeenCalledTimes(1);
  });

  it("REJECTION (human-authored Decision: exclude): writes excludeFamilies, not includeFamilies", () => {
    const { deps, registry, logicPin } = makeFakeDeps();
    const notePath = proposalNoteRelPath("openai", "gpt-zeta", "new-family");
    notes_set(deps, notePath, "exclude");

    const inputs: ProviderChurnInput[] = [{ provider: "openai", liveModelIds: ["gpt-zeta"] }];
    const before = logicPin.text;
    const outcome = runDriftSyncCore(inputs, deps);

    expect(outcome.outcomes).toContainEqual(
      expect.objectContaining({ provider: "openai", family: "gpt-zeta", action: "excluded" }),
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.reason).toBe(SyncCoreReason.OK_APPLIED);
    // The family landed in excludeFamilies. Asserting the SECTION, not just the
    // string: a bare `toContain('"gpt-zeta"')` would also pass if the edit had
    // gone into includeFamilies, which is the exact bug this path prevents.
    const excludeSection = registry.text.slice(registry.text.indexOf("excludeFamilies"));
    expect(excludeSection).toContain('"gpt-zeta"');
    expect(registry.text.slice(0, registry.text.indexOf("excludeFamilies"))).not.toContain(
      '"gpt-zeta"',
    );
    // ...and the EXCLUDE pin moved, while the include pin did not.
    expect(logicPin.text).not.toBe(before);
    expect(pinFor(logicPin.text, "excludeFamilies.openai")).not.toBe(
      pinFor(before, "excludeFamilies.openai"),
    );
    expect(pinFor(logicPin.text, "includeFamilies.openai")).toBe(
      pinFor(before, "includeFamilies.openai"),
    );
  });

  it("an APPROVED classification re-pins in the SAME run (the edit is never left with a stale pin)", () => {
    const { deps, logicPin } = makeFakeDeps();
    notes_set(deps, proposalNoteRelPath("openai", "gpt-zeta", "new-family"), "include");
    const before = logicPin.text;

    const outcome = runDriftSyncCore([{ provider: "openai", liveModelIds: ["gpt-zeta"] }], deps);

    expect(outcome.reason).toBe(SyncCoreReason.OK_APPLIED);
    expect(pinFor(logicPin.text, "includeFamilies.openai")).not.toBe(
      pinFor(before, "includeFamilies.openai"),
    );
    // And the rewrite stayed inside pin literals — nothing else in the file moved.
    expect(onlyPinsChanged(before, logicPin.text)).toBe(true);
  });

  it("REFUSES to apply a classification it cannot re-pin (no half-applied edit)", () => {
    const { deps, registry, writeRegistrySource } = makeFakeDeps({
      readLogicPinSource: undefined,
      writeLogicPinSource: undefined,
    });
    notes_set(deps, proposalNoteRelPath("openai", "gpt-zeta", "new-family"), "include");
    const registryBefore = registry.text;

    const outcome = runDriftSyncCore([{ provider: "openai", liveModelIds: ["gpt-zeta"] }], deps);

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe(SyncCoreReason.NEEDS_HUMAN);
    expect(outcome.detail).toContain("cannot re-pin");
    // The registry was NOT written: a stale-pin half-apply is the failure mode
    // this whole path exists to remove, so it must not be reachable.
    expect(writeRegistrySource).not.toHaveBeenCalled();
    expect(registry.text).toBe(registryBefore);
  });

  // HONEST REPORTING ON A REFUSAL. Before this, the three re-pin refusals
  // returned with the outcomes still reading `action: "added"` for an edit that
  // was never written: the run log printed `[added] openai/gpt-zeta`,
  // `buildSyncCommitMessage` wrote `- added openai/gpt-zeta` into a commit
  // containing no registry edit at all, and `computeChangesetKey` — the
  // workflow's PR de-dup key — was keyed on the same claim.
  it("a re-pin refusal reports the classification as NOT APPLIED, and leaves a deduped note", () => {
    const { deps, notes } = makeFakeDeps({
      readLogicPinSource: undefined,
      writeLogicPinSource: undefined,
    });
    notes_set(deps, proposalNoteRelPath("openai", "gpt-zeta", "new-family"), "include");

    const outcome = runDriftSyncCore([{ provider: "openai", liveModelIds: ["gpt-zeta"] }], deps);

    expect(outcome.outcomes).toEqual([
      expect.objectContaining({ family: "gpt-zeta", action: "needs-human-repin" }),
    ]);
    expect(outcome.outcomes.some((o) => o.action === "added")).toBe(false);
    // The commit message may not claim an edit that is not in the commit.
    expect(buildSyncCommitMessage(outcome).body).toBe("");
    expect(buildSyncCommitMessage(outcome).subject).toContain("needs-human note file(s)");
    // ...and the refusal has a human-facing artifact, not just a red job.
    const notePath = proposalNoteRelPath("openai", "gpt-zeta", "pin-repin-failure");
    expect(notes.get(notePath)).toContain("Membership re-pin refused");
    expect(outcome.outcomes[0].detail).toContain("NOT APPLIED");
  });

  // The writer's own pin-file guard, checked against WHAT LANDED. The version
  // this replaces verified its own in-memory rewrite, so it could not return
  // false from its only production call site — mutating that call site to
  // `if (false)` left the whole suite green. Re-reading the written file makes
  // the guard answer a question it can actually fail: here a writer that mangles
  // the file on the way to disk.
  it("REFUSES and REVERTS when the pin file as WRITTEN is not a clean membership re-pin", () => {
    const { deps, logicPin, revertFiles, notes } = makeFakeDeps({
      writeLogicPinSource: vi.fn((text: string) => {
        // A writer that also re-pastes a neighbouring (non-repinnable) pin.
        logicPin.text = text.replace(`pin: "${"0".repeat(64)}"`, `pin: "${"f".repeat(64)}"`);
      }),
    });
    notes_set(deps, proposalNoteRelPath("openai", "gpt-zeta", "new-family"), "exclude");

    const outcome = runDriftSyncCore([{ provider: "openai", liveModelIds: ["gpt-zeta"] }], deps);

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe(SyncCoreReason.NEEDS_HUMAN);
    expect(outcome.detail).toContain("not a clean membership re-pin");
    expect(revertFiles).toHaveBeenCalledWith([MODEL_REGISTRY_REL_PATH, LOGIC_PIN_REL_PATH]);
    expect(outcome.outcomes).toEqual([
      expect.objectContaining({ family: "gpt-zeta", action: "needs-human-repin" }),
    ]);
    expect(notes.get(proposalNoteRelPath("openai", "gpt-zeta", "pin-repin-failure"))).toContain(
      "Membership re-pin refused",
    );
  });

  // THE VOICE HALF-CLASSIFICATION. `excludeFamilies` and
  // `knownVoiceModelFamilies` are deliberately disjoint surfaces and the sync
  // writes only the first, so auto-applying an OpenAI voice family's decision
  // leaves ws-realtime.drift.ts reporting UNKNOWN_REALTIME_MODELS at critical
  // severity: gate-3 refuses, both files revert, the note still says `Decision: exclude`,
  // and the identical apply/fail/revert/alert repeats every night forever.
  it("a DECIDED voice family is routed to a human instead of being half-applied", () => {
    for (const verdict of ["include", "exclude"] as const) {
      const { deps, registry, writeRegistrySource, runSyncCheck, notes } = makeFakeDeps();
      const registryBefore = registry.text;
      notes_set(deps, proposalNoteRelPath("openai", "gpt-live", "new-family"), verdict);

      const outcome = runDriftSyncCore([{ provider: "openai", liveModelIds: ["gpt-live"] }], deps);

      expect(needsVoiceSeedSetEdit("gpt-live", "openai")).toBe(true);
      expect(outcome.outcomes).toEqual([
        expect.objectContaining({ family: "gpt-live", action: "needs-human-voice-seed-set" }),
      ]);
      // Nothing was applied, so nothing gate-fails and nothing reverts: the
      // half-apply/revert loop cannot start.
      expect(writeRegistrySource).not.toHaveBeenCalled();
      expect(registry.text).toBe(registryBefore);
      expect(runSyncCheck).not.toHaveBeenCalled();
      const notePath = proposalNoteRelPath("openai", "gpt-live", "voice-seed-set");
      expect(notes.get(notePath)).toContain("knownVoiceModelFamilies");
      expect(notes.get(notePath)).toContain("voice-models.ts");
    }
  });

  it("a decided family the realtime canary already knows about IS applied (the guard is not a blanket refusal)", () => {
    // The predicate keys on the voice SEED SET, not on the id's shape. Every
    // seeded family is already classified in the registry, so the case is
    // constructed the way it arises in life: the human made the voice-models.ts
    // half of the two-edit commit, and the registry half is what is left. The
    // seed set is private to voice-models.ts, so that half is modelled through
    // the `isKnownVoiceFamily` seam (the same shape as `isRecorded`).
    const seedSetWithGptLive = (family: string): boolean =>
      family === "gpt-live" || isKnownVoiceModelFamily(family);
    expect(isVoiceModelId("gpt-live")).toBe(true);
    expect(isKnownVoiceModelFamily("gpt-live")).toBe(false);
    expect(needsVoiceSeedSetEdit("gpt-live", "openai", seedSetWithGptLive)).toBe(false);

    const { deps, registry } = makeFakeDeps({ isKnownVoiceFamily: seedSetWithGptLive });
    notes_set(deps, proposalNoteRelPath("openai", "gpt-live", "new-family"), "exclude");
    const outcome = runDriftSyncCore([{ provider: "openai", liveModelIds: ["gpt-live"] }], deps);

    expect(outcome.reason).toBe(SyncCoreReason.OK_APPLIED);
    expect(outcome.outcomes).toEqual([
      expect.objectContaining({ family: "gpt-live", action: "excluded" }),
    ]);
    const excludeSection = registry.text.slice(registry.text.indexOf("excludeFamilies"));
    expect(excludeSection).toContain('"gpt-live"');
  });

  // The voice seed set is read by ONE canary: ws-realtime.drift.ts, against the
  // OpenAI /models listing only. A voice-SHAPED family from another provider
  // (a gemini *-flash-tts id matches isVoiceModelId on `-tts`) is invisible to that
  // canary, so its registry edit is the whole job — routing it to a
  // `-voice-seed-set` note demands an edit no gate needs, and the decided family
  // is never applied.
  it("a DECIDED voice-shaped family from a non-OpenAI provider IS applied (the seed set is OpenAI-only)", () => {
    // gemini-3.8-flash-tts itself is classified now (by hand, in the commit that
    // also excluded its -lite sibling), so a same-shape successor stands in.
    expect(isVoiceModelId("gemini-4.1-flash-tts")).toBe(true);
    expect(needsVoiceSeedSetEdit("gemini-4.1-flash-tts", "gemini")).toBe(false);
    expect(needsVoiceSeedSetEdit("gemini-4.1-flash-tts", "openai")).toBe(true);

    const { deps, registry, logicPin, notes } = makeFakeDeps();
    logicPin.text = logicPin.text.replace(
      "};\n",
      [
        '  "excludeFamilies.gemini": {',
        "    members: () => [...excludeFamilies.gemini].sort(),",
        '    pin: "' + "2".repeat(64) + '",',
        "  },",
        "};",
        "",
      ].join("\n"),
    );
    notes_set(
      deps,
      proposalNoteRelPath("gemini", "gemini-4.1-flash-tts", "new-family"),
      "exclude",
      {
        provider: "gemini",
        family: "gemini-4.1-flash-tts",
      },
    );

    const sets = ["includeFamilies", "excludeFamilies", "deprecatedFamilies"] as const;
    const providers = ["openai", "anthropic", "gemini"] as const;
    const arraysOf = (text: string) =>
      Object.fromEntries(
        sets.flatMap((set) =>
          providers.map((p) => [`${set}.${p}`, parsedFamilyArray(text, set, p)]),
        ),
      );
    const arraysBefore = arraysOf(registry.text);
    const pinBefore = logicPin.text;

    const outcome = runDriftSyncCore(
      [{ provider: "gemini", liveModelIds: ["gemini-4.1-flash-tts"] }],
      deps,
    );

    expect(outcome.reason).toBe(SyncCoreReason.OK_APPLIED);
    expect(outcome.outcomes).toEqual([
      expect.objectContaining({ family: "gemini-4.1-flash-tts", action: "excluded" }),
    ]);
    // The family landed in excludeFamilies.gemini — appended, nothing else in
    // that array moved — and every OTHER array (other providers' excludes,
    // includeFamilies, the deprecation ledger) is exactly as it was.
    const arraysAfter = arraysOf(registry.text);
    expect(arraysAfter["excludeFamilies.gemini"]).toEqual([
      ...arraysBefore["excludeFamilies.gemini"],
      "gemini-4.1-flash-tts",
    ]);
    for (const key of Object.keys(arraysBefore)) {
      if (key === "excludeFamilies.gemini") continue;
      expect(arraysAfter[key], key).toEqual(arraysBefore[key]);
      expect(arraysAfter[key], key).not.toContain("gemini-4.1-flash-tts");
    }
    // The gemini exclude pin was re-pinned in the same run; the OpenAI pins
    // were not touched.
    expect(pinFor(logicPin.text, "excludeFamilies.gemini")).not.toBe(
      pinFor(pinBefore, "excludeFamilies.gemini"),
    );
    expect(pinFor(logicPin.text, "excludeFamilies.gemini")).toMatch(/^[0-9a-f]{64}$/);
    for (const key of ["includeFamilies.openai", "excludeFamilies.openai"]) {
      expect(pinFor(logicPin.text, key), key).toBe(pinFor(pinBefore, key));
    }
    expect(notes.has(proposalNoteRelPath("gemini", "gemini-4.1-flash-tts", "voice-seed-set"))).toBe(
      false,
    );
  });

  it("only an OpenAI new-family note carries the voice seed-set exception", () => {
    const render = (provider: "openai" | "anthropic" | "gemini") =>
      renderProposalNote(provider, "x-tts", "new-family", "detail", "2026-10-05");
    expect(render("openai")).toContain("knownVoiceModelFamilies");
    expect(render("openai")).toContain("-voice-seed-set.md");
    for (const provider of ["gemini", "anthropic"] as const) {
      const note = render(provider);
      expect(note).not.toContain("knownVoiceModelFamilies");
      expect(note).not.toContain("voice-seed-set");
      // The decision block itself is intact: the comment closes and the
      // fail-closed `pending` line follows it.
      expect(note).toMatch(
        /is a human-authored decision, not generated code\)\. -->\nDecision: pending\n/,
      );
    }
    // Every provider's note — the OpenAI one included, whose comment runs on
    // through the seed-set paragraph — closes its HTML comment before the
    // `Decision: pending` line. An unclosed comment would hide that line from
    // a rendered view and from any comment-aware parser.
    for (const provider of ["openai", "gemini", "anthropic"] as const) {
      const note = render(provider);
      const opens = note.split("<!--").length - 1;
      const closes = note.split("-->").length - 1;
      expect(opens).toBe(1);
      expect(closes).toBe(opens);
      expect(note.indexOf("-->")).toBeGreaterThan(note.indexOf("<!--"));
      const uncommented = note.replace(/<!--[\s\S]*?-->/g, "");
      expect(uncommented).not.toContain("<!--");
      expect(uncommented).toMatch(/^Decision: pending$/m);
    }
  });

  it("a FAILING drift-sync-check gate reverts every touched file and reports GATE_FAILED", () => {
    const { deps, notes, revertFiles } = makeFakeDeps({
      runSyncCheck: vi.fn(
        (): SyncCheckResultLike => ({
          ok: false,
          reason: "pin-check-failed",
          detail: "a pinned rule moved",
        }),
      ),
    });
    // The one remaining path that mutates the registry: an addition a human
    // already approved on a prior run by setting the note's `Decision: include`.
    notes.set(
      proposalNoteRelPath("openai", "gpt-zeta", "new-family"),
      renderProposalNote("openai", "gpt-zeta", "new-family", "detail", "2026-07-20").replace(
        "Decision: pending",
        "Decision: include",
      ),
    );
    const liveIds = [...includeFamilies.openai, "gpt-zeta"];
    const inputs: ProviderChurnInput[] = [{ provider: "openai", liveModelIds: liveIds }];

    const outcome = runDriftSyncCore(inputs, deps);

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe(SyncCoreReason.GATE_FAILED);
    expect(outcome.detail).toContain("pin-check-failed");
    // BOTH mutated files revert together. A gate failure that reverted the
    // registry but kept the re-pin would leave the pin describing a membership
    // that no longer exists — a silently-wrong canary, which is worse than the
    // failure it was reverting.
    expect(revertFiles).toHaveBeenCalledWith([MODEL_REGISTRY_REL_PATH, LOGIC_PIN_REL_PATH]);
  });

  it("recording a deprecation leaves the includeFamilies checksum pin GREEN", () => {
    // THE CONSTRAINT THE LEDGER EXISTS TO SATISFY. `includeFamilies`'s
    // membership is checksum-pinned in logic-pin.test.ts and gate-2 re-runs that
    // file over the edited tree, so any edit that touches that set fails the
    // sync's own gate, reverts, and delivers nothing. This gate models the pin
    // faithfully: it refuses precisely when includeFamilies moved.
    //
    // RED (the shape this replaced): the sync's answer to a zero-reference
    // deprecation was to remove the family from includeFamilies, which reddened
    // exactly this gate — `revertFiles` wiped the edit and every note written
    // alongside it, `reason=gate-failed`, no PR of any class. Which is why the
    // pre-fix code did not apply the removal at all and paged a human instead.
    const runSyncCheck = vi.fn((): SyncCheckResultLike => {
      const included = parsedFamilyArray(registry.text, "includeFamilies", "openai");
      return included.length === includeFamilies.openai.size
        ? { ok: true, reason: "ok", detail: "allowlist + pin ok" }
        : {
            ok: false,
            reason: "pin-check-failed",
            detail: 'Frozen data set "includeFamilies.openai" membership changed',
          };
    });
    const { deps, notes, registry, revertFiles } = makeFakeDeps({
      isReferenced: (family) => family !== "gpt-4o",
      runSyncCheck,
    });
    const dropped = ["gpt-4o", "gpt-4", "gpt-4-turbo"].filter((f) => includeFamilies.openai.has(f));
    const survivors = [...includeFamilies.openai].filter((f) => !dropped.includes(f));
    const liveIds = [...survivors, ...survivors.map((f) => `${f}-2025-01-01`)];

    const outcome = runDriftSyncCore([{ provider: "openai", liveModelIds: liveIds }], deps);

    // GREEN: the pin-modelling gate PASSES, so the edit is kept and delivered.
    expect(outcome.reason).toBe(SyncCoreReason.OK_APPLIED);
    expect(outcome.ok).toBe(true);
    expect(runSyncCheck).toHaveBeenCalledTimes(1);
    expect(revertFiles).not.toHaveBeenCalled();
    expect(notes.size).toBe(0);
    expect(parsedFamilyArray(registry.text, "deprecatedFamilies", "openai").sort()).toEqual(
      [...dropped].sort(),
    );
  });

  it("a provider whose live listing was skipped (no key / infra error) is recorded, not treated as churn", () => {
    const { deps } = makeFakeDeps();
    const inputs: ProviderChurnInput[] = [
      { provider: "anthropic", liveModelIds: null, skipReason: "ANTHROPIC_API_KEY not set" },
    ];
    const outcome = runDriftSyncCore(inputs, deps);
    expect(outcome.ok).toBe(true);
    expect(outcome.reason).toBe(SyncCoreReason.OK_NO_CHURN);
    expect(outcome.skipped).toEqual([
      { provider: "anthropic", reason: "ANTHROPIC_API_KEY not set" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// D-M1: the recollect gate must NOT destroy the route-to-human invariant.
//
// De-masks the default `makeFakeDeps` gate (which returned {ok:true}
// unconditionally and hid this bug): these gates model the REAL drift-sync-check
// — gate-1 (allowlist) + gate-2 (pin) pass for a data-only change, but gate-3
// (the live re-collect) STILL reports the un-actioned family this run routed to
// a human as residual critical drift, so a `skipRecollect:false` call fails.
// ---------------------------------------------------------------------------

/** A faithful drift-sync-check: passes with recollect skipped, FAILS with it on. */
function faithfulRecollectGate(): ReturnType<typeof vi.fn> {
  return vi.fn(
    (opts?: { skipRecollect?: boolean }): SyncCheckResultLike =>
      opts?.skipRecollect
        ? { ok: true, reason: "ok", detail: "allowlist + pin ok; live re-collect skipped" }
        : {
            ok: false,
            reason: "residual-critical-drift",
            detail: "1 critical diff — un-actioned family the collector still sees",
          },
  );
}

describe("D-M1: recollect gate vs route-to-human invariant", () => {
  it("RED->GREEN (note-only new family): faithful gate does NOT revert the note; NEEDS_HUMAN", () => {
    const runSyncCheck = faithfulRecollectGate();
    const { deps, revertFiles } = makeFakeDeps({ runSyncCheck });
    const inputs: ProviderChurnInput[] = [{ provider: "openai", liveModelIds: ["gpt-zeta"] }];

    const outcome = runDriftSyncCore(inputs, deps);

    // GREEN: the genuinely-new family persists its note and reaches the
    // human-approval protocol. RED (pre-fix): the core ran the recollect gate,
    // which failed, so the note was reverted and the run reported GATE_FAILED.
    expect(outcome.reason).toBe(SyncCoreReason.NEEDS_HUMAN);
    expect(outcome.ok).toBe(false);
    expect(revertFiles).not.toHaveBeenCalled();
    // A note-only run has no registry edit to re-verify → the recollect-bearing
    // gate is never even consulted.
    expect(runSyncCheck).not.toHaveBeenCalled();
  });

  it("RED->GREEN (mixed: approved addition + new-family note): addition kept, gate-3 skipped, NEEDS_HUMAN", () => {
    const runSyncCheck = faithfulRecollectGate();
    const { deps, registry, notes, revertFiles } = makeFakeDeps({ runSyncCheck });
    // A human approved `gpt-zeta` on a prior run; `gpt-other` is a fresh
    // unclassified family this run defers. The addition is the registry edit;
    // the deferral is what a re-collect would still (correctly) see as drift.
    notes.set(
      proposalNoteRelPath("openai", "gpt-zeta", "new-family"),
      renderProposalNote("openai", "gpt-zeta", "new-family", "detail", "2026-07-20").replace(
        "Decision: pending",
        "Decision: include",
      ),
    );
    const liveIds = [...includeFamilies.openai, "gpt-zeta", "gpt-other"];
    const inputs: ProviderChurnInput[] = [{ provider: "openai", liveModelIds: liveIds }];

    const outcome = runDriftSyncCore(inputs, deps);

    // GREEN: the approved addition is applied AND kept; the new family is
    // deferred to a human. RED (pre-fix): the recollect gate saw the deferred
    // new family as residual drift and reverted the valid addition too.
    expect(outcome.reason).toBe(SyncCoreReason.NEEDS_HUMAN);
    expect(outcome.ok).toBe(false);
    expect(outcome.outcomes).toContainEqual(
      expect.objectContaining({ family: "gpt-zeta", action: "added" }),
    );
    expect(outcome.outcomes).toContainEqual(
      expect.objectContaining({ family: "gpt-other", action: "needs-human-new-family" }),
    );
    expect(revertFiles).not.toHaveBeenCalled();
    // The gate ran (a registry edit WAS applied) but with the live re-collect
    // skipped, because a family was simultaneously deferred to a human — and the
    // verdict records that as the reason, not just the fact of the skip.
    expect(runSyncCheck).toHaveBeenCalledTimes(1);
    expect(runSyncCheck).toHaveBeenCalledWith({
      skipRecollect: true,
      skipRecollectReason: expect.stringContaining("deferred a family to a human"),
    });
    // The registry edit was persisted (writeRegistrySource ran with the addition).
    expect(registry.text).toContain('"gpt-zeta"');
  });
});

// ---------------------------------------------------------------------------
// G#1: a registry structural mismatch (AST locator miss) must route-to-human,
// never collapse into a silent benign no-op.
// ---------------------------------------------------------------------------

describe("G#1: locator miss routes to human", () => {
  it("RED->GREEN (deprecation locator miss): writes a note + NEEDS_HUMAN, never a silent no-op", () => {
    // A registry source the AST locator cannot parse into deprecatedFamilies —
    // models the real file's structure changing out from under the editor. A
    // deprecation that cannot be RECORDED would otherwise be re-derived and
    // re-dropped every morning in silence, which is the one deprecation shape a
    // human genuinely has to see.
    const brokenSource = "export const somethingElse = { openai: [] };\n";
    const brokenRegistry = { text: brokenSource };
    const { deps, notes } = makeFakeDeps({
      isReferenced: () => false,
      readRegistrySource: () => brokenRegistry.text,
      writeRegistrySource: (t: string) => {
        brokenRegistry.text = t;
      },
    });
    const allButGpt4o = [...includeFamilies.openai].filter((f) => f !== "gpt-4o");
    const liveIds = [...allButGpt4o, ...allButGpt4o.map((f) => `${f}-2025-01-01`)];
    const inputs: ProviderChurnInput[] = [{ provider: "openai", liveModelIds: liveIds }];

    const outcome = runDriftSyncCore(inputs, deps);

    // GREEN: routed to a human. RED (pre-fix): a silent `no-op` action, no note,
    // ok-no-churn, exit 0 — a real deprecation vanishing silently.
    expect(outcome.reason).toBe(SyncCoreReason.NEEDS_HUMAN);
    expect(outcome.ok).toBe(false);
    expect(outcome.outcomes).toContainEqual(
      expect.objectContaining({ family: "gpt-4o", action: "needs-human-structural-mismatch" }),
    );
    // A note actually alerts a human.
    expect(notes.has(`${DRIFT_PROPOSALS_DIR}/openai-gpt-4o-structural-mismatch.md`)).toBe(true);
    // The unparseable registry was never mutated.
    expect(brokenRegistry.text).toBe(brokenSource);
  });
});

// ---------------------------------------------------------------------------
// D-M2: revertSyncFiles must handle untracked note files without throwing.
// Exercises the REAL revert surface (real git, real untracked file).
// ---------------------------------------------------------------------------

describe("revertSyncFiles (D-M2: revert must not throw on untracked notes)", () => {
  it("RED->GREEN: reverts a tracked edit AND deletes an untracked note without throwing", () => {
    const repo = mkdtempSync(join(tmpdir(), "drift-sync-revert-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    git("init");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");

    // A TRACKED file with committed content, then locally modified by the sync.
    const trackedRel = "src/__tests__/drift/model-registry.ts";
    mkdirSync(join(repo, "src/__tests__/drift"), { recursive: true });
    writeFileSync(join(repo, trackedRel), "ORIGINAL\n");
    git("add", trackedRel);
    git("commit", "-m", "seed");
    writeFileSync(join(repo, trackedRel), "MODIFIED BY SYNC\n");

    // An UNTRACKED note git has never seen (the D-M2 trigger).
    const noteRel = "drift-proposals/openai-gpt-zeta-new-family.md";
    mkdirSync(join(repo, "drift-proposals"), { recursive: true });
    writeFileSync(join(repo, noteRel), "note body\n");

    const prevCwd = process.cwd();
    process.chdir(repo);
    try {
      // GREEN: partitions tracked vs untracked and never throws. RED (pre-fix):
      // `git checkout -- <tracked> <untracked>` errors on the untracked note,
      // reverts NOTHING, and throws uncaught.
      expect(() => revertSyncFiles([trackedRel, noteRel])).not.toThrow();
    } finally {
      process.chdir(prevCwd);
    }

    // Tracked file restored to its committed content; untracked note removed.
    expect(readFileSync(join(repo, trackedRel), "utf-8")).toBe("ORIGINAL\n");
    expect(existsSync(join(repo, noteRel))).toBe(false);

    rmSync(repo, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Zero-LLM guarantee — static sanity check on the module's own source.
// ---------------------------------------------------------------------------

describe("the sync core never invokes an LLM", () => {
  it("scripts/drift-sync.ts contains no Claude Code invocation / free-form generation call", () => {
    const src = readFileSync(new URL("../../scripts/drift-sync.ts", import.meta.url), "utf-8");
    // Check for actual invocation syntax, not the module's own explanatory
    // prose (which legitimately names these as what this file does NOT do).
    expect(src).not.toMatch(/invokeClaudeCode\(/);
    expect(src).not.toMatch(/from ["']@anthropic-ai\/claude-code["']/);
    expect(src).not.toMatch(/\bbuildPrompt\(/);
    expect(src).not.toMatch(/\bspawn\(/);
  });
});

// ---------------------------------------------------------------------------
// G#3: computeChangesetKey — the STABLE, date-independent dedup key the CI
// workflow uses to keep BOTH PR-open paths idempotent across daily re-fires.
//
// The bug it exists to fix: the workflow's needs-human persist step deduped
// SOLELY on the committed `drift-proposals/*` note paths. In the D-M1 "mixed
// run" (a mechanical registry removal committed the SAME run a *different*
// family is deferred to a human whose note ALREADY sits on main), the diff
// carries ONLY the registry edit and NO note file — so a note-path key was
// EMPTY, the dedup was bypassed, and a brand-new near-identical PR opened on
// every daily cron run (unbounded PR-spam). The changeset key is non-empty in
// that shape (it carries the removal AND the deferred family) and identical on
// every re-fire, so the workflow can find the already-open PR and skip.
// ---------------------------------------------------------------------------

describe("computeChangesetKey (G#3: stable, date-independent PR-dedup key)", () => {
  // The D-M1 mixed run: gpt-zeta added (registry edit) + gpt-other deferred
  // (needs-human) — the exact shape whose committed diff has a registry edit
  // but no NEW note file, where a note-path-only dedup key is empty. Both notes
  // are pre-seeded (already on `main` from prior runs), so this run writes none.
  function seedMixedRunNotes(notes: Map<string, string>): void {
    notes.set(
      proposalNoteRelPath("openai", "gpt-zeta", "new-family"),
      renderProposalNote("openai", "gpt-zeta", "new-family", "detail", "2026-07-20").replace(
        "Decision: pending",
        "Decision: include",
      ),
    );
    notes.set(
      proposalNoteRelPath("openai", "gpt-other", "new-family"),
      renderProposalNote("openai", "gpt-other", "new-family", "detail", "2026-07-20"),
    );
  }

  function mixedRunInputs(): ProviderChurnInput[] {
    return [
      { provider: "openai", liveModelIds: [...includeFamilies.openai, "gpt-zeta", "gpt-other"] },
    ];
  }

  it("is NON-EMPTY for a mixed run (registry edit + deferred family) — the shape a note-path-only key misses", () => {
    const { deps, notes, writeProposalNote } = makeFakeDeps();
    seedMixedRunNotes(notes);
    const outcome = runDriftSyncCore(mixedRunInputs(), deps);
    expect(outcome.reason).toBe(SyncCoreReason.NEEDS_HUMAN);
    // The mixed-run committed diff carries NO new note file, yet the key is set
    // — this is precisely what makes the workflow dedup fire on this shape.
    expect(writeProposalNote).not.toHaveBeenCalled();
    expect(computeChangesetKey(outcome)).not.toBe("");
    // Carries BOTH the applied addition and the deferred family in its identity.
    expect(outcome.outcomes).toContainEqual(
      expect.objectContaining({ family: "gpt-zeta", action: "added" }),
    );
    expect(outcome.outcomes).toContainEqual(
      expect.objectContaining({ family: "gpt-other", action: "needs-human-new-family" }),
    );
  });

  it("is IDENTICAL across re-fires of the same drift on DIFFERENT dates (date-independent — so daily re-fires dedup)", () => {
    const day1 = makeFakeDeps({ now: () => new Date("2026-07-22") });
    const day2 = makeFakeDeps({ now: () => new Date("2026-08-15") });
    seedMixedRunNotes(day1.notes);
    seedMixedRunNotes(day2.notes);
    const key1 = computeChangesetKey(runDriftSyncCore(mixedRunInputs(), day1.deps));
    const key2 = computeChangesetKey(runDriftSyncCore(mixedRunInputs(), day2.deps));
    expect(key1).toBe(key2);
  });

  it("is EMPTY for a no-churn run (nothing applied or deferred — no PR to dedup)", () => {
    const { deps } = makeFakeDeps();
    const outcome = runDriftSyncCore([{ provider: "openai", liveModelIds: [] }], deps);
    expect(outcome.reason).toBe(SyncCoreReason.OK_NO_CHURN);
    expect(computeChangesetKey(outcome)).toBe("");
  });

  it("DIFFERS for a different changeset (a pure deferral vs a mixed run) — distinct drifts get distinct PRs", () => {
    const pure = makeFakeDeps();
    const pureOutcome = runDriftSyncCore(
      [{ provider: "openai", liveModelIds: ["gpt-zeta"] }],
      pure.deps,
    );
    const mixed = makeFakeDeps();
    seedMixedRunNotes(mixed.notes);
    const mixedOutcome = runDriftSyncCore(mixedRunInputs(), mixed.deps);
    const pureKey = computeChangesetKey(pureOutcome);
    const mixedKey = computeChangesetKey(mixedOutcome);
    expect(pureKey).not.toBe("");
    expect(mixedKey).not.toBe("");
    expect(pureKey).not.toBe(mixedKey);
  });

  it("is a fixed-length 16-hex-char token (no substring collision between distinct keys in the PR-body marker match)", () => {
    const { deps } = makeFakeDeps({ isReferenced: () => false });
    const key = computeChangesetKey(runDriftSyncCore(mixedRunInputs(), deps));
    expect(key).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ---------------------------------------------------------------------------
// Commit-message bound (the bot's PR must be able to merge unattended).
//
// The sync bot's commit is authored by CI with no human in the loop. Its
// subject used to enumerate every changed family, so it grew without bound:
// production run 31225520102 (PR #366) emitted a 525-character header, which
// `commitlint`'s `header-max-length` (100, via @commitlint/config-conventional)
// rejects — permanently blocking the bot's own PR until a human rewrites the
// message. These pin the bound at the sizes that matter.
// ---------------------------------------------------------------------------

function appliedOutcome(n: number, provider: Provider = "anthropic"): SyncCoreOutcome {
  return {
    ok: true,
    reason: SyncCoreReason.OK_APPLIED,
    detail: "applied",
    outcomes: Array.from({ length: n }, (_, i) => ({
      provider,
      family: `claude-family-${i}`,
      action: "deprecation-recorded" as const,
      detail: "recorded",
    })),
    skipped: [],
  };
}

describe("buildSyncCommitMessage", () => {
  it.each([1, 2, 10, 50, 500])("keeps the subject within the commitlint bound (n=%i)", (n) => {
    const { subject } = buildSyncCommitMessage(appliedOutcome(n));
    expect(subject.length).toBeLessThanOrEqual(COMMIT_LINE_MAX_LENGTH);
  });

  it("keeps the subject bounded when every provider changed at once", () => {
    const outcome = appliedOutcome(0);
    const providers: Provider[] = ["anthropic", "gemini", "openai"];
    outcome.outcomes = providers.flatMap((provider) =>
      Array.from({ length: 30 }, (_, i) => ({
        provider,
        family: `family-${i}`,
        action: "deprecation-recorded" as const,
        detail: "recorded",
      })),
    );
    const { subject } = buildSyncCommitMessage(outcome);
    expect(subject.length).toBeLessThanOrEqual(COMMIT_LINE_MAX_LENGTH);
    expect(subject).toContain("90 families");
  });

  it("stays bounded even when a single family name is pathologically long", () => {
    const outcome = appliedOutcome(1);
    outcome.outcomes[0].family = "x".repeat(400);
    const { subject, body } = buildSyncCommitMessage(outcome);
    expect(subject.length).toBeLessThanOrEqual(COMMIT_LINE_MAX_LENGTH);
    for (const line of body.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(COMMIT_LINE_MAX_LENGTH);
    }
  });

  it("reads naturally for a single change (never '1 changes')", () => {
    const { subject } = buildSyncCommitMessage(appliedOutcome(1));
    expect(subject).toContain("1 family:");
    expect(subject).not.toContain("1 families");
  });

  it("moves the full per-family detail into the body, one bounded line each", () => {
    const { body } = buildSyncCommitMessage(appliedOutcome(10));
    const lines = body.split("\n");
    expect(lines).toHaveLength(10);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(COMMIT_LINE_MAX_LENGTH);
    }
    expect(body).toContain("- deprecation-recorded anthropic/claude-family-0");
    expect(body).toContain("- deprecation-recorded anthropic/claude-family-9");
  });

  it("keeps the needs-human-only subject unchanged and bodyless", () => {
    const { subject, body } = buildSyncCommitMessage(appliedOutcome(0));
    expect(subject).toBe(
      "fix(drift-sync): mechanical model-family sync (needs-human note file(s))",
    );
    expect(subject.length).toBeLessThanOrEqual(COMMIT_LINE_MAX_LENGTH);
    expect(body).toBe("");
  });
});

/**
 * Set a note's Decision line to a human verdict. The body is the REAL
 * renderProposalNote output for `subject` (default openai/gpt-zeta), not
 * necessarily for the note at `notePath`.
 */
function notes_set(
  deps: SyncCoreDeps,
  notePath: string,
  verdict: "include" | "exclude",
  subject: { provider: Provider; family: string } = { provider: "openai", family: "gpt-zeta" },
): void {
  deps.writeProposalNote(
    notePath,
    renderProposalNote(
      subject.provider,
      subject.family,
      "new-family",
      "detail",
      "2026-07-20",
    ).replace("Decision: pending", `Decision: ${verdict}`),
  );
}

/** A parseable DATA_FROZEN table with the given (key literal, pin) entries. */
function dataFrozenSource(entries: [string, string][]): string {
  return [
    "const DATA_FROZEN: Record<string, { members: () => string[]; pin: string }> = {",
    ...entries.flatMap(([key, pin]) => [`  ${key}: {`, `    pin: "${pin}",`, "  },"]),
    "};",
    "",
  ].join("\n");
}

/** The pin literal recorded for one UNQUOTED DATA_FROZEN key. */
function pinForUnquoted(source: string, key: string): string {
  const at = source.indexOf(`\n  ${key}: {`);
  const m = /pin:\s*"([0-9a-f]{64})"/.exec(source.slice(at));
  return m ? m[1] : "";
}

/** The pin literal currently recorded for one DATA_FROZEN key. */
function pinFor(source: string, key: string): string {
  const at = source.indexOf(`"${key}":`);
  const m = /pin:\s*"([0-9a-f]{64})"/.exec(source.slice(at));
  return m ? m[1] : "";
}

describe("membership re-pinning primitives", () => {
  it("updateDataFrozenPin rewrites ONLY the named key's pin", () => {
    const src = dataFrozenSource([
      ['"includeFamilies.openai"', "a".repeat(64)],
      ['"excludeFamilies.openai"', "b".repeat(64)],
    ]);
    const out = updateDataFrozenPin(src, "excludeFamilies.openai", "c".repeat(64));
    expect(out.changed).toBe(true);
    expect(out.locatorMiss).toBe(false);
    expect(pinFor(out.text, "includeFamilies.openai")).toBe("a".repeat(64));
    expect(pinFor(out.text, "excludeFamilies.openai")).toBe("c".repeat(64));
  });

  it("updateDataFrozenPin REFUSES an absent or duplicated key rather than guessing", () => {
    const src = dataFrozenSource([['"includeFamilies.openai"', "a".repeat(64)]]);
    expect(updateDataFrozenPin(src, "excludeFamilies.gemini", "c".repeat(64))).toMatchObject({
      changed: false,
      locatorMiss: true,
    });
    const dup = dataFrozenSource([
      ['"includeFamilies.openai"', "a".repeat(64)],
      ['"includeFamilies.openai"', "b".repeat(64)],
    ]);
    expect(updateDataFrozenPin(dup, "includeFamilies.openai", "c".repeat(64))).toMatchObject({
      changed: false,
      locatorMiss: true,
    });
  });

  // THE WRONG-KEY REWRITE. Reproduced against the REAL pin file before the fix:
  // `"excludeFamilies.gemini"` is followed by the UNQUOTED `knownVoiceModelFamilies`
  // entry, and the old forward scan only refused when a QUOTED key intervened —
  // so a target entry whose own pin was not a recognisable digest landed the
  // write on the realtime canary's seed-set pin, reported `locatorMiss: false`,
  // and passed the pin-only guard. The entry-scoped AST locator cannot express
  // that failure; this test is what says so.
  it("updateDataFrozenPin REFUSES an unrecognisable pin instead of walking into the next (UNQUOTED) entry", () => {
    const real = readFileSync(LOGIC_PIN_REL_PATH, "utf-8");
    const voicePinBefore = pinForUnquoted(real, "knownVoiceModelFamilies");
    expect(voicePinBefore).toMatch(/^[0-9a-f]{64}$/);
    // The precondition: the target entry's own pin is not a recognisable digest
    // (a mid-edit or hand-repaired state).
    const corrupted = real.replace(
      /("excludeFamilies\.gemini": \{\n {4}members: \(\) => \[\.\.\.excludeFamilies\.gemini\]\.sort\(\),\n {4}pin: )"[0-9a-f]{64}"/,
      '$1"TBD"',
    );
    expect(corrupted).not.toBe(real);

    const out = updateDataFrozenPin(corrupted, "excludeFamilies.gemini", "e".repeat(64));

    expect(out).toMatchObject({ changed: false, locatorMiss: true });
    expect(out.text).toBe(corrupted);
    expect(pinForUnquoted(out.text, "knownVoiceModelFamilies")).toBe(voicePinBefore);
  });

  it("updateDataFrozenPin locates UNQUOTED DATA_FROZEN keys too, and rewrites only that entry", () => {
    const real = readFileSync(LOGIC_PIN_REL_PATH, "utf-8");
    const out = updateDataFrozenPin(real, "knownVoiceModelFamilies", "d".repeat(64));
    expect(out).toMatchObject({ changed: true, locatorMiss: false });
    expect(pinForUnquoted(out.text, "knownVoiceModelFamilies")).toBe("d".repeat(64));
    expect(pinFor(out.text, "excludeFamilies.gemini")).toBe(pinFor(real, "excludeFamilies.gemini"));
    const diff = diffPinKeys(real, out.text);
    expect(diff.ok && diff.changedKeys).toEqual(["knownVoiceModelFamilies"]);
  });

  // THE BOUNDARY THE CHECKER ENFORCES. Reproduced end to end before the fix:
  // widening `isClassifiedFamily` in model-registry.ts and re-pasting that
  // surface's FROZEN checksum here passed gate-1 (both files allowlisted) and
  // gate-2 (the pin test, whose oracle IS this file) — the exact "bot told to
  // make the drift job pass" the pin file's own header names.
  it("verifyPinFileEdit REFUSES a re-pasted FROZEN logic checksum, and ACCEPTS a membership re-pin", () => {
    const real = readFileSync(LOGIC_PIN_REL_PATH, "utf-8");

    const at = real.indexOf("  isClassifiedFamily: {");
    expect(at).toBeGreaterThan(-1);
    const m = /pin: "([0-9a-f]{64})"/.exec(real.slice(at))!;
    const silenced =
      real.slice(0, at + m.index) +
      `pin: "${"9".repeat(64)}"` +
      real.slice(at + m.index + m[0].length);
    // It looks pin-only — which is precisely why "only pin literals moved" is
    // not the boundary.
    expect(onlyPinsChanged(real, silenced)).toBe(true);
    const refused = verifyPinFileEdit(real, silenced, SYNC_REPINNABLE_KEYS);
    expect(refused.ok).toBe(false);
    expect(refused.detail).toContain("FROZEN logic checksum");
    // ...and an edit that is not even pin-shaped says so instead.
    const gutted = real.replace(
      "members: () => [...excludeFamilies.openai].sort(),",
      "members: () => [],",
    );
    expect(gutted).not.toBe(real);
    expect(verifyPinFileEdit(real, gutted, SYNC_REPINNABLE_KEYS)).toMatchObject({
      ok: false,
      detail: expect.stringContaining("outside a `pin:` string literal"),
    });

    const repinned = updateDataFrozenPin(real, "excludeFamilies.openai", "7".repeat(64));
    expect(repinned.changed).toBe(true);
    expect(verifyPinFileEdit(real, repinned.text, SYNC_REPINNABLE_KEYS).ok).toBe(true);
    // ...and a re-pin of a key the sync may NOT move is refused just as hard.
    const voice = updateDataFrozenPin(real, "gaRealtimeModels", "7".repeat(64));
    expect(voice.changed).toBe(true);
    expect(verifyPinFileEdit(real, voice.text, SYNC_REPINNABLE_KEYS)).toMatchObject({ ok: false });
  });

  it("onlyPinsChanged is the guard that keeps the sync off everything but pins", () => {
    const a = 'pin: "' + "a".repeat(64) + '",\nconst FROZEN_LOGIC = 1;';
    const pinOnly = 'pin: "' + "b".repeat(64) + '",\nconst FROZEN_LOGIC = 1;';
    const logicToo = 'pin: "' + "b".repeat(64) + '",\nconst FROZEN_LOGIC = 2;';
    expect(onlyPinsChanged(a, pinOnly)).toBe(true);
    // Mutation proof: move one byte outside a pin literal and the guard refuses.
    expect(onlyPinsChanged(a, logicToo)).toBe(false);
  });

  it("computeMembershipPin reproduces the REAL logic-pin.test.ts pins (no silent divergence)", () => {
    // drift-sync writes these pins, logic-pin.test.ts verifies them. If the two
    // ever compute the hash differently, every auto-re-pin would write a value
    // that immediately reds gate-2 — and the failure would look like a spurious
    // membership change rather than an algorithm mismatch. Pin the parity here,
    // against the real file and the real registry, so divergence fails loudly.
    const real = readFileSync("src/__tests__/drift/logic-pin.test.ts", "utf-8");
    for (const [key, members] of [
      ["includeFamilies.openai", [...includeFamilies.openai]],
      ["excludeFamilies.openai", [...excludeFamilies.openai]],
    ] as const) {
      expect(pinFor(real, key), `no pin found for ${key}`).toMatch(/^[0-9a-f]{64}$/);
      expect(computeMembershipPin(members), key).toBe(pinFor(real, key));
    }
  });

  it("dataFrozenKey matches the key format logic-pin.test.ts actually uses", () => {
    expect(dataFrozenKey("excludeFamilies", "openai")).toBe("excludeFamilies.openai");
    expect(dataFrozenKey("includeFamilies", "anthropic")).toBe("includeFamilies.anthropic");
  });
});
