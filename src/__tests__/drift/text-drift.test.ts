/**
 * OFFLINE specs for the TEXT-lane drift primitives in `text-drift.ts`.
 *
 * These live in a `*.test.ts` (the default `pnpm test` suite) rather than in
 * `models.drift.ts` (the `pnpm test:drift` spec) on purpose: they need no
 * provider key, and the classification they pin gates every PR that touches
 * `model-registry.ts`. Importing `text-drift.ts` — which registers no
 * `describe`s — is what makes that possible without dragging the three LIVE
 * provider canaries into the offline suite.
 */

import { describe, it, expect } from "vitest";

import { isClassifiedFamily, excludeFamilies } from "./model-registry.js";
import { normalizeModelFamily } from "./model-family.js";
import { unclassifiedFamilies } from "./text-drift.js";

// ---------------------------------------------------------------------------
// The 2026-07-28 OpenAI transcription line — BEHAVIOURAL coverage of the
// classification this PR exists to make.
//
// `gpt-transcribe` / `gpt-live-transcribe` were classified EXCLUDE in
// model-registry.ts. Without the assertions below, the only thing that would
// redden if either entry were dropped is the `excludeFamilies.openai` membership
// CHECKSUM in logic-pin.test.ts — which says "the data moved" and nothing about
// what the classification MEANS. These pin the meaning through the real
// enumerate→normalize→subtract pipeline, with `/models`-shaped payloads
// (bare family + the dated snapshot form OpenAI actually lists).
//
// The `gpt-live` boundary is asserted in BOTH directions on purpose.
// `gpt-live` and `gpt-live-transcribe` are DIFFERENT families — the first is a
// genuinely unclassified family the canary must keep reporting (it is the
// canonical new-family example throughout this module), the second is an
// excluded transcription surface whose key has the first as a strict PREFIX.
// A substring/prefix-shaped classification bug would silently swallow the one
// family the canary exists to catch, and that exact shape has already been
// found in this codebase (a provider-label fallback where "Gemini Live
// Transcription session" resolved to `Transcription`), so it is not
// hypothetical.
// ---------------------------------------------------------------------------

describe("openai transcription line is classified as EXCLUDED (PR #343)", () => {
  it("gpt-transcribe is EXCLUDED in a /models-shaped payload", () => {
    expect(isClassifiedFamily("gpt-transcribe", "openai")).toBe(true);
    expect(
      unclassifiedFamilies(
        [
          "gpt-4o", // include, for a realistic mixed listing
          "gpt-transcribe",
          "gpt-transcribe-2026-07-28", // dated snapshot collapses onto the family
          "whisper-1", // the pre-existing transcription surface
        ],
        "openai",
      ),
    ).toEqual([]);
  });

  it("gpt-live-transcribe is EXCLUDED in a /models-shaped payload", () => {
    expect(isClassifiedFamily("gpt-live-transcribe", "openai")).toBe(true);
    expect(
      unclassifiedFamilies(
        ["gpt-4o", "gpt-live-transcribe", "gpt-live-transcribe-2026-07-28", "gpt-realtime"],
        "openai",
      ),
    ).toEqual([]);
  });

  it("gpt-live is NOT swept up by the gpt-live-transcribe exclude entry", () => {
    // Forward direction: the longer excluded key must not classify the shorter
    // family it contains. `gpt-live` stays UNCLASSIFIED — the canary's job.
    expect(isClassifiedFamily("gpt-live", "openai")).toBe(false);
    expect(unclassifiedFamilies(["gpt-live"], "openai")).toEqual(["gpt-live"]);
    // Both in one payload: the transcription surface is accounted for and the
    // full-duplex family is still reported, from the same listing.
    expect(unclassifiedFamilies(["gpt-live-transcribe", "gpt-live"], "openai")).toEqual([
      "gpt-live",
    ]);
    // Reverse direction: the excluded key must not classify families that merely
    // EXTEND it either — a `startsWith`-shaped bug would swallow these.
    expect(unclassifiedFamilies(["gpt-live-transcribe-mini"], "openai")).toEqual([
      "gpt-live-transcribe-mini",
    ]);
    // Single-digit trailing suffix is NOT a build tag, so a family carrying one
    // is normalized to itself and stays unknown. `gpt-live-1` itself is now an
    // EXCLUDE key (2026-09-10, /v1/live/sessions — see model-registry.ts), so the
    // unknown-side exemplar is an unclassified sibling; `gpt-live-1-mini` also
    // proves the new exclude key does not swallow families that EXTEND it.
    expect(unclassifiedFamilies(["gpt-live-9"], "openai")).toEqual(["gpt-live-9"]);
    expect(unclassifiedFamilies(["gpt-live-1-mini"], "openai")).toEqual(["gpt-live-1-mini"]);
    expect(unclassifiedFamilies(["gpt-live-1"], "openai")).toEqual([]);
  });

  it("every enumerated openai exclude family survives normalization from a dated id", () => {
    // Closes the coverage gap the two entries above are one instance of: most
    // `excludeFamilies.openai` entries appear in no payload in this suite, so
    // nothing proved a DATED snapshot of them (the form the live listing
    // actually carries) collapses back onto the excluded key instead of
    // false-positiving as a new family.
    //
    // Only the DATED ids are fed in. Including the bare keys added nothing: they
    // ARE `excludeFamilies.openai`, so `isClassifiedFamily` returns true for them
    // by definition and that half of the payload could never contribute a
    // result.
    const bare = [...excludeFamilies.openai];
    const dated = bare.map((family) => `${family}-2026-07-28`);
    expect(unclassifiedFamilies(dated, "openai")).toEqual([]);

    // NEGATIVE CONTROL, in the same test. `toEqual([])` on its own is exactly
    // what a neutered `unclassifiedFamilies` (`return []`) also produces, so the
    // assertion above is only meaningful alongside a payload of the same shape
    // that MUST report. A dated id on an unclassified family reports its family.
    expect(unclassifiedFamilies(["gpt-nonexistent-family-2026-07-28"], "openai")).toEqual([
      "gpt-nonexistent-family",
    ]);
  });

  it("the real text-embedding-ada-002 id form is excluded, bare and dated", () => {
    // The loop above derives its ids from the REGISTRY KEYS, which are seeded
    // through `normalizeModelFamily` — so the `text-embedding-ada-002` entry is
    // stored as `text-embedding-ada` (the `-002` reads as a build tag) and the id
    // the loop generates for it is `text-embedding-ada-2026-07-28`, a string
    // OpenAI never lists. The real id, and its dated form, were exercised
    // nowhere: the two normalization steps (`-002` build tag, then the date) have
    // to compose for the live listing's actual shape to classify.
    expect(normalizeModelFamily("text-embedding-ada-002", "openai")).toBe("text-embedding-ada");
    expect(normalizeModelFamily("text-embedding-ada-002-2026-07-28", "openai")).toBe(
      "text-embedding-ada",
    );
    expect(
      unclassifiedFamilies(
        ["text-embedding-ada-002", "text-embedding-ada-002-2026-07-28"],
        "openai",
      ),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The 2026-08-26/27 Gemini transcription + omni-video line — BEHAVIOURAL
// coverage of the classification, in the same shape as the OpenAI block above.
//
// `gemini-3.5-transcribe`, `gemini-3.5-transcribe-live` and
// `gemini-omni-1.1-flash` were classified EXCLUDE in model-registry.ts on the
// provider's own DECLARED capabilities (see the rationale comment beside the
// entries, and drift-proposals/). Without the assertions below the only thing
// that would redden if an entry were dropped is the `excludeFamilies.gemini`
// membership CHECKSUM in logic-pin.test.ts — which says "the data moved" and
// nothing about what the classification MEANS.
//
// The `gemini-3.5-transcribe` / `gemini-3.5-transcribe-live` pair is asserted
// in BOTH directions on purpose: the first key is a strict PREFIX of the
// second, the same substring/prefix hazard the OpenAI `gpt-live` block exists
// for. They are DIFFERENT families and both must be classified on their own
// entry, not by one swallowing the other.
// ---------------------------------------------------------------------------

describe("gemini transcription + omni-video line is classified as EXCLUDED", () => {
  it("gemini-3.5-transcribe is EXCLUDED in a /models-shaped payload", () => {
    expect(isClassifiedFamily("gemini-3.5-transcribe", "gemini")).toBe(true);
    expect(
      unclassifiedFamilies(
        [
          "gemini-3.5-flash", // include, for a realistic mixed listing
          "gemini-3.5-transcribe",
          "gemini-3.5-transcribe-2026-08-26", // dated snapshot collapses onto the family
        ],
        "gemini",
      ),
    ).toEqual([]);
  });

  it("gemini-3.5-transcribe-live is EXCLUDED in a /models-shaped payload", () => {
    expect(isClassifiedFamily("gemini-3.5-transcribe-live", "gemini")).toBe(true);
    expect(
      unclassifiedFamilies(
        [
          "gemini-3.5-flash",
          "gemini-3.5-transcribe-live",
          "gemini-3.5-transcribe-live-2026-08-26",
          "gemini-live", // the pre-existing full-duplex Live surface
        ],
        "gemini",
      ),
    ).toEqual([]);
  });

  it("gemini-omni-1.1-flash is EXCLUDED in a /models-shaped payload", () => {
    expect(isClassifiedFamily("gemini-omni-1.1-flash", "gemini")).toBe(true);
    expect(
      unclassifiedFamilies(
        [
          "gemini-3.5-flash",
          "gemini-omni-1.1-flash",
          "gemini-omni-1.1-flash-2026-08-27",
          "gemini-omni-flash-preview", // sibling preview tier, excluded by pattern
        ],
        "gemini",
      ),
    ).toEqual([]);
  });

  it("neither transcribe key classifies the other, nor an unrelated extension", () => {
    // The two entries are distinct families; a `startsWith`-shaped classification
    // bug would let the shorter key classify the longer one (or vice versa) and
    // silently swallow a family the canary exists to report.
    expect(normalizeModelFamily("gemini-3.5-transcribe-live", "gemini")).toBe(
      "gemini-3.5-transcribe-live",
    );
    // NEGATIVE CONTROL: an id that merely EXTENDS an excluded key is still a new
    // family and must be reported. Without this, `toEqual([])` above is also
    // what a neutered `unclassifiedFamilies` would produce.
    expect(unclassifiedFamilies(["gemini-3.5-transcribe-diarize"], "gemini")).toEqual([
      "gemini-3.5-transcribe-diarize",
    ]);
    expect(unclassifiedFamilies(["gemini-omni-1.1-pro"], "gemini")).toEqual([
      "gemini-omni-1.1-pro",
    ]);
  });
});

// ---------------------------------------------------------------------------
// The 2026-09-05 wave — BEHAVIOURAL coverage of the four classifications made
// in this change, in the same shape as the two blocks above.
//
// `gpt-6-astra`, `claude-fable-5-1` and `gemini-3.8-flash` were classified
// INCLUDE and `lyria-3.5` EXCLUDE in model-registry.ts, each on the provider's
// own declared capability (see the rationale comment beside each entry, and
// drift-proposals/). Without the assertions below the only thing that would
// redden if an entry were dropped is that set's membership CHECKSUM in
// logic-pin.test.ts — which says "the data moved" and nothing about what the
// classification MEANS.
//
// `claude-fable-5-1` is the prefix case in this wave, and it is asserted in both
// directions: the already-included `claude-fable-5` is a strict PREFIX of it, so
// a `startsWith`-shaped classification bug would let the shorter key classify
// the longer one — and the negative control below proves a FURTHER point release
// is still reported rather than swallowed by either.
//
// `lyria-3.5` is the one entry a methods-only rule would have got backwards: its
// live /models entry declares `generateContent`, so only the model card
// (`description: "Music Generation model"`) distinguishes it from a text tier.
// It is asserted beside its `-preview` sibling, which reaches the same verdict
// by the PREVIEW_FAMILY rule rather than by enumeration.
// ---------------------------------------------------------------------------

describe("the 2026-09-05 model-family wave is classified", () => {
  it("gpt-6-astra is INCLUDED in a /models-shaped payload", () => {
    expect(isClassifiedFamily("gpt-6-astra", "openai")).toBe(true);
    expect(
      unclassifiedFamilies(
        [
          "gpt-5.6-luna", // the sibling named variant it was probed against
          "gpt-6-astra",
          "gpt-6-astra-2026-08-27", // dated snapshot collapses onto the family
          "whisper-1", // the negative control from that probe, excluded
        ],
        "openai",
      ),
    ).toEqual([]);
  });

  it("claude-fable-5-1 is INCLUDED in a /models-shaped payload", () => {
    expect(isClassifiedFamily("claude-fable-5-1", "anthropic")).toBe(true);
    expect(
      unclassifiedFamilies(
        [
          "claude-fable-5", // the prefix sibling, already included
          "claude-fable-5-1",
          "claude-fable-5-1-20260901", // dated snapshot collapses onto the family
          "claude-opus-5",
        ],
        "anthropic",
      ),
    ).toEqual([]);
  });

  it("gemini-3.8-flash is INCLUDED in a /models-shaped payload", () => {
    expect(isClassifiedFamily("gemini-3.8-flash", "gemini")).toBe(true);
    expect(
      unclassifiedFamilies(
        [
          "gemini-3.7-flash", // the tier whose method set it matches exactly
          "gemini-3.8-flash",
          "gemini-3.8-flash-2026-09-05", // dated snapshot collapses onto the family
        ],
        "gemini",
      ),
    ).toEqual([]);
  });

  it("lyria-3.5 is EXCLUDED in a /models-shaped payload", () => {
    expect(isClassifiedFamily("lyria-3.5", "gemini")).toBe(true);
    expect(excludeFamilies.gemini.has("lyria-3.5")).toBe(true);
    expect(
      unclassifiedFamilies(
        [
          "gemini-3.8-flash",
          "lyria-3.5",
          "lyria-3.5-2026-09-05", // dated snapshot collapses onto the family
          "lyria-3-pro-preview", // sibling preview tier, excluded by pattern
        ],
        "gemini",
      ),
    ).toEqual([]);
  });

  it("no key in this wave classifies a neighbouring family", () => {
    // Each entry is its own family. NEGATIVE CONTROLS: without these,
    // `toEqual([])` above is also what a neutered `unclassifiedFamilies` would
    // produce, and a prefix-shaped bug would look identical to a correct pass.
    expect(normalizeModelFamily("claude-fable-5-1", "anthropic")).toBe("claude-fable-5-1");
    expect(unclassifiedFamilies(["claude-fable-5-2"], "anthropic")).toEqual(["claude-fable-5-2"]);
    expect(unclassifiedFamilies(["gpt-6"], "openai")).toEqual(["gpt-6"]);
    expect(unclassifiedFamilies(["gpt-6-astra-pro"], "openai")).toEqual(["gpt-6-astra-pro"]);
    expect(unclassifiedFamilies(["gemini-3.8-pro"], "gemini")).toEqual(["gemini-3.8-pro"]);
    expect(unclassifiedFamilies(["lyria-4"], "gemini")).toEqual(["lyria-4"]);
  });
});

// ---------------------------------------------------------------------------
// The 2026-09-23 wave — BEHAVIOURAL coverage of the four classifications made
// for drift PR #477, in the same shape as the block above.
//
// `gpt-6-luna`, `gpt-6-sol` and `claude-opus-5-5` were classified INCLUDE and
// `antigravity-preview-latest` EXCLUDE in model-registry.ts (rationale beside
// each entry and in drift-proposals/). Without these assertions, the only thing
// that would redden if an entry were dropped is a membership CHECKSUM in
// logic-pin.test.ts.
//
// `claude-opus-5-5` is the prefix case: the already-included `claude-opus-5` is
// a strict PREFIX of it, so it is asserted in both directions.
//
// `antigravity-preview-latest` is the rule-gap case: its sibling
// `antigravity-preview-05` is excluded by PREVIEW_FAMILY, but this id ends in
// `-latest`, so only the enumerated entry classifies it.
// ---------------------------------------------------------------------------

describe("the 2026-09-23 model-family wave is classified", () => {
  it("gpt-6-luna and gpt-6-sol are INCLUDED in a /models-shaped payload", () => {
    expect(isClassifiedFamily("gpt-6-luna", "openai")).toBe(true);
    expect(isClassifiedFamily("gpt-6-sol", "openai")).toBe(true);
    expect(
      unclassifiedFamilies(
        [
          "gpt-5.6-luna", // the previous-generation siblings, already included
          "gpt-5.6-sol",
          "gpt-6-astra", // the probe-verified gpt-6 sibling
          "gpt-6-luna",
          "gpt-6-luna-2026-09-22", // dated snapshot collapses onto the family
          "gpt-6-sol",
          "gpt-6-sol-2026-09-22",
        ],
        "openai",
      ),
    ).toEqual([]);
  });

  it("claude-opus-5-5 is INCLUDED in a /models-shaped payload", () => {
    expect(isClassifiedFamily("claude-opus-5-5", "anthropic")).toBe(true);
    expect(
      unclassifiedFamilies(
        [
          "claude-opus-5", // the prefix sibling, already included
          "claude-opus-5-5",
          "claude-opus-5-5-20260922", // dated snapshot collapses onto the family
        ],
        "anthropic",
      ),
    ).toEqual([]);
  });

  it("antigravity-preview-latest is EXCLUDED in a /models-shaped payload", () => {
    expect(isClassifiedFamily("antigravity-preview-latest", "gemini")).toBe(true);
    expect(excludeFamilies.gemini.has("antigravity-preview-latest")).toBe(true);
    expect(
      unclassifiedFamilies(
        [
          "antigravity-preview-05", // sibling preview tier, excluded by pattern
          "antigravity-preview-latest",
        ],
        "gemini",
      ),
    ).toEqual([]);
  });

  it("no key in this wave classifies a neighbouring family", () => {
    // NEGATIVE CONTROLS: without these, `toEqual([])` above is also what a
    // neutered `unclassifiedFamilies` would produce.
    expect(normalizeModelFamily("claude-opus-5-5", "anthropic")).toBe("claude-opus-5-5");
    expect(unclassifiedFamilies(["claude-opus-5-6"], "anthropic")).toEqual(["claude-opus-5-6"]);
    expect(unclassifiedFamilies(["gpt-6-terra"], "openai")).toEqual(["gpt-6-terra"]);
    expect(unclassifiedFamilies(["gpt-6-luna-pro"], "openai")).toEqual(["gpt-6-luna-pro"]);
    expect(unclassifiedFamilies(["antigravity-latest"], "gemini")).toEqual(["antigravity-latest"]);
  });
});
