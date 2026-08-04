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
    expect(unclassifiedFamilies(["gpt-live-1"], "openai")).toEqual(["gpt-live-1"]);
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
