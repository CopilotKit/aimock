/**
 * CHECKSUM FREEZE for the model-drift CLASSIFICATION logic (Phase-0, spec §6).
 *
 * These surfaces decide which live `/models` families count as drift. They are
 * the exact places a well-meaning bot — or an LLM told to "make the drift job
 * pass" — could SILENCE the canary with a one-line edit: broaden a normalizer
 * regex so unknown families collapse onto known ones, dump a new id into
 * `NON_MODEL_TOKENS`, add an exclude-by-rule pattern, or short-circuit
 * `isClassifiedFamily`. None of that must ever land silently.
 *
 * This test pins the SOURCE of each classification surface by SHA-256. Any edit
 * to a frozen surface flips its checksum and fails `pnpm test`, forcing the
 * change to be a deliberate, reviewed act: whoever legitimately changes a rule
 * must ALSO re-pin the checksum here (and explain why in the diff), which a
 * reviewer sees. A silent widening cannot slip through green CI.
 *
 * DO NOT "fix" a red pin by blindly pasting the new checksum. A red pin means a
 * frozen classification rule moved — confirm the move is intended and reviewed
 * BEFORE updating the pin. Auto-updating the pin to chase green defeats the
 * entire purpose of this file.
 *
 * Frozen surfaces:
 *   model-family.ts   — DATED_SNAPSHOT_SUFFIX, BUILD_TAG_SUFFIX,
 *                       ANTHROPIC_DATE_SUFFIX, normalizeModelFamily
 *   model-registry.ts — PREVIEW_FAMILY, GEMMA_FAMILY, NON_MODEL_TOKENS,
 *                       familySet, isClassifiedFamily
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  PREVIEW_FAMILY,
  GEMMA_FAMILY,
  NON_MODEL_TOKENS,
  isClassifiedFamily,
  includeFamilies,
  excludeFamilies,
} from "./model-registry.js";
import { normalizeModelFamily } from "./model-family.js";

const famSrc = readFileSync(fileURLToPath(new URL("./model-family.ts", import.meta.url)), "utf8");
const regSrc = readFileSync(fileURLToPath(new URL("./model-registry.ts", import.meta.url)), "utf8");

/** Extract the exact source span of a frozen surface, failing loudly if absent. */
function extract(src: string, re: RegExp, name: string): string {
  const m = src.match(re);
  if (!m) {
    throw new Error(
      `logic-pin: could not locate frozen surface "${name}". It was renamed, ` +
        `moved, or reshaped — this is itself a classification-logic change that ` +
        `must be reviewed and re-pinned deliberately.`,
    );
  }
  return m[0];
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Frozen surface → { extract, pin }. The extraction regexes anchor each
 * function body on its column-0 closing brace (`\n}`), so an interior indented
 * `}` never terminates the span early.
 */
const FROZEN: Record<string, { source: string; pin: string }> = {
  DATED_SNAPSHOT_SUFFIX: {
    source: extract(famSrc, /const DATED_SNAPSHOT_SUFFIX = .+;/, "DATED_SNAPSHOT_SUFFIX"),
    pin: "99fcd34c515dfce4954b7c6a2bcf10a35b4f27e76107f96eb6235549225854b4",
  },
  BUILD_TAG_SUFFIX: {
    source: extract(famSrc, /const BUILD_TAG_SUFFIX = .+;/, "BUILD_TAG_SUFFIX"),
    pin: "fe75d743b89f8eae942cd98ac8af56a25f3c86c8d64772f1aec139d1dd4fbddc",
  },
  ANTHROPIC_DATE_SUFFIX: {
    source: extract(famSrc, /const ANTHROPIC_DATE_SUFFIX = .+;/, "ANTHROPIC_DATE_SUFFIX"),
    pin: "c79f8927776a618bb232d8b3d506296b84f9017db9f4ad56b0b20a84b9ce3a28",
  },
  normalizeModelFamily: {
    source: extract(
      famSrc,
      /export function normalizeModelFamily\([\s\S]*?\n}/,
      "normalizeModelFamily",
    ),
    pin: "7c1236d8d644e6ec52879aae910c4b1491e51346f4dde0bb211f484013a33f50",
  },
  PREVIEW_FAMILY: {
    source: extract(regSrc, /export const PREVIEW_FAMILY = .+;/, "PREVIEW_FAMILY"),
    pin: "da2e8a8a66ea8ac150de336429a74cc46fdaf0e3fb065614b810803a0187a3c8",
  },
  GEMMA_FAMILY: {
    source: extract(regSrc, /export const GEMMA_FAMILY = .+;/, "GEMMA_FAMILY"),
    pin: "910e395e685e385bc924ea6900118bd8a3b93b5026513f92ea387409475555e8",
  },
  NON_MODEL_TOKENS: {
    source: extract(
      regSrc,
      /export const NON_MODEL_TOKENS: Set<string> = new Set\(\[[\s\S]*?\]\);/,
      "NON_MODEL_TOKENS",
    ),
    pin: "7531fa32d032016a25b7a95ce0da919bb5add8817c8f3c69c9af8fe732b0d332",
  },
  familySet: {
    source: extract(regSrc, /function familySet\([\s\S]*?\n}/, "familySet"),
    pin: "d4ee5473b09e94a91f58b4acaff698aba00077fb2edf0b635cd8a41b6de2d58f",
  },
  isClassifiedFamily: {
    source: extract(
      regSrc,
      /export function isClassifiedFamily\([\s\S]*?\n}/,
      "isClassifiedFamily",
    ),
    pin: "60d59a5c43f3c3d7788315a19bc0a576bfab0efce3a8e93b82e862cfb8a3d263",
  },
};

describe("classification-logic checksum freeze (Phase-0 anti-silence guard)", () => {
  for (const [name, { source, pin }] of Object.entries(FROZEN)) {
    it(`freezes ${name}`, () => {
      expect(
        sha256(source),
        `Frozen classification surface "${name}" changed. If this edit is a ` +
          `deliberate, reviewed rule change, update its pin here; if not, it is ` +
          `a silent canary-silencing edit and must be reverted.`,
      ).toBe(pin);
    });
  }

  // Runtime-value pins — a second, human-readable lock on the exact rule shapes,
  // independent of source formatting. Widening a regex or adding a routing token
  // trips these as well as the source checksum above.
  it("pins the PREVIEW_FAMILY exclude-by-rule pattern", () => {
    expect(PREVIEW_FAMILY.source).toBe("-preview(-\\d+)?$");
  });

  it("pins the GEMMA_FAMILY exclude-by-rule pattern", () => {
    expect(GEMMA_FAMILY.source).toBe("^gemma(-|$)");
  });

  it("pins NON_MODEL_TOKENS membership exactly", () => {
    expect([...NON_MODEL_TOKENS].sort()).toEqual(["gemini-interactions"]);
  });

  // Behavioral golden anchors — prove the frozen source still MEANS what it
  // should, and catch a regex widen/narrow through observed classification, not
  // just bytes. These are the exact silencing surfaces §1 calls out.
  it("keeps the normalizer stripping only the frozen suffix shapes", () => {
    // dated snapshot + build tag stripped; single-digit tail preserved (canary)
    expect(normalizeModelFamily("gpt-4o-2025-08-28", "openai")).toBe("gpt-4o");
    expect(normalizeModelFamily("tts-1-1106", "openai")).toBe("tts-1");
    expect(normalizeModelFamily("gpt-live-1", "openai")).toBe("gpt-live-1");
    // anthropic-only contiguous 8-digit snapshot
    expect(normalizeModelFamily("claude-3-5-sonnet-20241022", "anthropic")).toBe(
      "claude-3-5-sonnet",
    );
    expect(normalizeModelFamily("gpt-weird-12345678", "openai")).toBe("gpt-weird-12345678");
  });

  it("keeps isClassifiedFamily's known-vs-unknown boundary intact", () => {
    // classified: seeded include, seeded exclude, preview-rule, gemma-rule
    expect(isClassifiedFamily("gpt-4o", "openai")).toBe(true);
    expect(isClassifiedFamily("tts-1", "openai")).toBe(true);
    expect(isClassifiedFamily("gemini-3-pro-preview", "gemini")).toBe(true);
    expect(isClassifiedFamily("gemma-4-31b-it", "gemini")).toBe(true);
    // unknown families must stay flagged (the canary must not be silenced)
    expect(isClassifiedFamily("gpt-live", "openai")).toBe(false);
    expect(isClassifiedFamily("gemini-ultra", "gemini")).toBe(false);
    // interior -preview-<word> is NOT swept by the rule (stays explicit-only)
    expect(PREVIEW_FAMILY.test("gemini-2.5-flash-preview-tts")).toBe(false);
  });
});

/**
 * DATA freeze for the classification SEED sets themselves.
 *
 * The FROZEN block above pins the classification RULES (normalizer,
 * exclude-by-rule patterns, NON_MODEL_TOKENS, familySet, isClassifiedFamily)
 * but never inspected the `includeFamilies` / `excludeFamilies` literal
 * arrays in model-registry.ts — so, in principle, a family could be silenced
 * by adding it straight to `excludeFamilies` (or quietly dropped from
 * `includeFamilies`) without tripping any pin above, since neither literal's
 * source span is one of the extracted FROZEN surfaces.
 *
 * This hashes the normalized, SORTED MEMBERSHIP of each provider's set (not
 * the raw source text — these arrays legitimately grow over time as new
 * model families ship) so ANY membership change — add, remove, or a whole
 * provider added/removed — fails loudly here and must be a deliberate,
 * reviewed re-pin, exactly like the FROZEN surfaces above.
 *
 * DO NOT "fix" a red pin by blindly pasting the new hash. A red pin means the
 * classified-family DATA moved — confirm the move is intended and reviewed
 * BEFORE updating the pin.
 */
const DATA_FROZEN: Record<string, { members: string[]; pin: string }> = {
  "includeFamilies.openai": {
    members: [...includeFamilies.openai].sort(),
    pin: "802989cfefe27838cf7303ac905dbb5fb6641e9fb859924834422b86cce8fb9c",
  },
  "includeFamilies.anthropic": {
    members: [...includeFamilies.anthropic].sort(),
    pin: "dbd8b4ef9afd50057143480d89db373886e7c19abe36ef9b4421456305ca2509",
  },
  "includeFamilies.gemini": {
    members: [...includeFamilies.gemini].sort(),
    pin: "4a9428b64ffcff0fbb79878d88ed993ffac53e43d64e26bcf5d86509626f593d",
  },
  "excludeFamilies.openai": {
    members: [...excludeFamilies.openai].sort(),
    pin: "aa2fc084639c7b4de847e3db2a8d93b8c4a060e66acfa527b7462e5682377ecc",
  },
  "excludeFamilies.anthropic": {
    members: [...excludeFamilies.anthropic].sort(),
    pin: "03ccd17333fe45b1fc01d2dc79c4337930204e178205b896aef7000d4378d79f",
  },
  "excludeFamilies.gemini": {
    members: [...excludeFamilies.gemini].sort(),
    pin: "e3545138234ad782937f66760bef942fca7d4bd0934a87da30bf6e5816ba69b1",
  },
};

describe("classification-data membership freeze (includeFamilies/excludeFamilies)", () => {
  for (const [name, { members, pin }] of Object.entries(DATA_FROZEN)) {
    it(`freezes ${name} membership`, () => {
      expect(
        sha256(JSON.stringify(members)),
        `Frozen data set "${name}" membership changed (now: ${JSON.stringify(members)}). If ` +
          `this is a deliberate, reviewed addition/removal of a classified family, update its ` +
          `pin here; if not, it is a silent canary-silencing edit and must be reverted.`,
      ).toBe(pin);
    });
  }
});
