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
 *   voice-models.ts   — isVoiceModelId (rule), knownVoiceModelFamilies and
 *                       gaRealtimeModels (data)
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
import { isVoiceModelId, knownVoiceModelFamilies, gaRealtimeModels } from "./voice-models.js";

const famSrc = readFileSync(fileURLToPath(new URL("./model-family.ts", import.meta.url)), "utf8");
const regSrc = readFileSync(fileURLToPath(new URL("./model-registry.ts", import.meta.url)), "utf8");
const voiceSrc = readFileSync(fileURLToPath(new URL("./voice-models.ts", import.meta.url)), "utf8");

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

/**
 * Like `extract`, but requires the pattern to match EXACTLY ONCE. `extract` uses
 * `String.match`, which returns the FIRST hit — so an unanchored pattern can be
 * satisfied by a decoy above the real surface (a commented-out copy, a doc
 * example), pinning the decoy while the real rule moves freely underneath. Pass
 * a `^`-anchored, `m`-flagged pattern here and a second match is a hard error
 * rather than a silently-pinned wrong span.
 */
function extractSole(src: string, re: RegExp, name: string): string {
  const all = [
    ...src.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g")),
  ];
  if (all.length === 0) {
    throw new Error(
      `logic-pin: could not locate frozen surface "${name}". It was renamed, ` +
        `moved, or reshaped — this is itself a classification-logic change that ` +
        `must be reviewed and re-pinned deliberately.`,
    );
  }
  if (all.length > 1) {
    throw new Error(
      `logic-pin: frozen surface "${name}" matched ${all.length} spans. The pin ` +
        `would freeze whichever came first and leave the rest unguarded — make ` +
        `the pattern unambiguous before re-pinning.`,
    );
  }
  return all[0][0];
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
  // The voice/audio matcher decides which live ids the realtime canary even
  // LOOKS at. Widen it and unrelated ids become false-positive voice drift;
  // narrow it and a brand-new voice family (the `gpt-live` case this matcher
  // exists for) silently stops being a candidate — the canary goes quiet with
  // no test failing. Anchored + sole-match: see `extractSole`.
  isVoiceModelId: {
    source: extractSole(
      voiceSrc,
      /^export function isVoiceModelId\([\s\S]*?\n}/m,
      "isVoiceModelId",
    ),
    pin: "f3d7f7324fc29798200c6b87469b50514ab790f14edba851e92e656753e941b9",
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

  it("keeps isVoiceModelId's candidate boundary intact", () => {
    // voice/audio candidates the realtime canary must keep inspecting, including
    // the no-"realtime"-substring families the broadened matcher exists for
    expect(isVoiceModelId("gpt-realtime-2.1")).toBe(true);
    expect(isVoiceModelId("gpt-live-1")).toBe(true);
    expect(isVoiceModelId("gpt-transcribe")).toBe(true);
    expect(isVoiceModelId("whisper-1")).toBe(true);
    expect(isVoiceModelId("tts-1-hd")).toBe(true);
    expect(isVoiceModelId("gpt-audio-mini")).toBe(true);
    // chat/text/image/embedding ids must NOT become false-positive voice drift
    expect(isVoiceModelId("gpt-5.4-mini")).toBe(false);
    expect(isVoiceModelId("dall-e-3")).toBe(false);
    expect(isVoiceModelId("text-embedding-3-large")).toBe(false);
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
    pin: "ab79ff332fadeff93c2678ebe3e0af7a6280ce6f0deb4694228e316944dfeb74",
  },
  "includeFamilies.gemini": {
    members: [...includeFamilies.gemini].sort(),
    pin: "c2e2c56b8f8d5fc56152b4633e7d3782e95b7eeb9bc123da71f00e884a54a743",
  },
  "excludeFamilies.openai": {
    members: [...excludeFamilies.openai].sort(),
    pin: "e4484f780a6a64928a54004a52420969c28d92c861272b10fffbbc7f96625f76",
  },
  "excludeFamilies.anthropic": {
    members: [...excludeFamilies.anthropic].sort(),
    pin: "03ccd17333fe45b1fc01d2dc79c4337930204e178205b896aef7000d4378d79f",
  },
  "excludeFamilies.gemini": {
    members: [...excludeFamilies.gemini].sort(),
    pin: "c95dedab7588212bbba0bf9ab6434bfd43a449adbe7b35f81f48271ee849a9c2",
  },
  // The realtime canary's seed sets, previously pinned NOWHERE. An edit to
  // either one was invisible to every guard in the repo: adding a family to
  // knownVoiceModelFamilies makes a live unknown family stop being reported
  // (the canary's whole job), and adding one to gaRealtimeModels makes the
  // "GA family still exists" assertion satisfiable by a model that does not.
  // Both are one-line silencing edits, which is exactly what this file exists
  // to make impossible.
  knownVoiceModelFamilies: {
    members: [...knownVoiceModelFamilies].sort(),
    pin: "3897b6bd6fc370ef14f080f4717dde653f2ae6029501d55c4cbda89523f9f3c6",
  },
  gaRealtimeModels: {
    members: [...gaRealtimeModels].sort(),
    pin: "deea068b1a4498d811f0b5399fd18db0f4d20561a63325f4daaddccf1e4e9410",
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
