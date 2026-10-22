/// <reference types="node" />

/**
 * Drift Sync — reusable git / branch / commit / PR plumbing, PLUS the
 * deterministic (zero-LLM) model-family sync core.
 *
 * This module holds the provider-agnostic, LLM-agnostic building blocks the
 * drift-remediation pipeline uses to read a report, shape a fix, and (below)
 * mechanically sync model-family churn: shell/exec helpers, drift-report
 * reading/validation, changed-file parsing, and version-bump + CHANGELOG
 * authoring. The workflow (`fix-drift.yml`) builds its own PR body inline
 * and commits exclusively via this module's `commitSyncChanges`, so there is
 * no separate PR-body-construction or gated-commit-file-partition surface
 * here (the C3 re-arch's own inline PR body / commit plumbing superseded the
 * fix-drift.ts-derived versions of both — see git history for the removal).
 *
 * C3 (delete-freewriter-predicate-rewire): these functions were originally
 * extracted VERBATIM from `scripts/fix-drift.ts` by C1 (behavior-preserving
 * move). `fix-drift.ts` and `scripts/drift-success-predicate.ts` — the LLM
 * freewriter invocation and its 916-line anti-cheat predicate — have since been
 * DELETED entirely (there is no arbitrary/free-form code generation left in the
 * drift-remediation pipeline to police), so `readDriftReport` (previously
 * re-exported from `fix-drift.ts`) now lives here permanently as this module's
 * own export.
 */

import { execSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import {
  evaluateSyncCheck,
  runPinCheck,
  recollect,
  readCommittedFile,
} from "./drift-sync-check.js";
import { LOGIC_PIN_REL_PATH, updateDataFrozenPin, verifyPinFileEdit } from "./drift-pin-file.js";
import type { DriftReport, DriftSeverity } from "./drift-types.js";

import { normalizeModelFamily } from "../src/__tests__/drift/model-family.js";
import {
  excludeFamilies,
  includeFamilies,
  isClassifiedFamily,
  isRecordedDeprecation,
  NON_MODEL_TOKENS,
} from "../src/__tests__/drift/model-registry.js";
import {
  MIN_LISTING_SIZE,
  isFamilyStillReferenced,
  isForwardLookingFamily,
} from "../src/__tests__/drift/deprecation-detector.js";
import { isKnownVoiceModelFamily, isVoiceModelId } from "../src/__tests__/drift/voice-models.js";
import {
  InfraError,
  isInfraSkip,
  listOpenAIModels,
  listAnthropicModels,
  listGeminiModels,
} from "../src/__tests__/drift/providers.js";

// ---------------------------------------------------------------------------
// Drift report reading + validation (moved from the deleted fix-drift.ts).
// ---------------------------------------------------------------------------

const VALID_SEVERITIES: ReadonlySet<DriftSeverity> = new Set(["critical", "warning", "info"]);

/**
 * Read + structurally validate a `drift-report.json` (produced by
 * `drift-report-collector.ts`). Still consumed by `drift-slack-summary.ts` (the
 * `test-drift.yml` "Summarize drift for Slack" step), independent of the
 * drift-remediation path.
 */
export function readDriftReport(path: string): DriftReport {
  if (!existsSync(path)) {
    throw new Error(`Drift report not found at ${path}`);
  }
  const raw = readFileSync(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    throw new Error(
      `Drift report at ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as Record<string, unknown>).entries)
  ) {
    throw new Error(`Drift report at ${path} has invalid structure: expected { entries: [...] }`);
  }
  if (typeof (parsed as Record<string, unknown>).timestamp !== "string") {
    throw new Error('Drift report missing "timestamp" field');
  }
  const report = parsed as DriftReport;

  // Validate individual entry fields to catch malformed reports early
  for (let i = 0; i < report.entries.length; i++) {
    const entry = report.entries[i];
    if (!entry || typeof entry.provider !== "string" || !entry.provider) {
      throw new Error(`Drift report entry[${i}] missing required "provider" field`);
    }
    if (!entry.builderFile || typeof entry.builderFile !== "string") {
      throw new Error(`Drift report entry[${i}] (${entry.provider}) missing "builderFile"`);
    }
    if (
      !Array.isArray(entry.builderFunctions) ||
      entry.builderFunctions.length === 0 ||
      !entry.builderFunctions.every((f: unknown) => typeof f === "string")
    ) {
      throw new Error(
        `Drift report entry[${i}] (${entry.provider}) "builderFunctions" must be non-empty string array`,
      );
    }
    if (!entry.scenario || typeof entry.scenario !== "string") {
      throw new Error(`Drift report entry[${i}] (${entry.provider}) missing "scenario"`);
    }
    if (!entry.sdkShapesFile || typeof entry.sdkShapesFile !== "string") {
      throw new Error(`Drift report entry[${i}] (${entry.provider}) missing "sdkShapesFile"`);
    }
    if (entry.typesFile !== null && typeof entry.typesFile !== "string") {
      throw new Error(
        `Drift report entry[${i}] (${entry.provider}) "typesFile" must be string or null`,
      );
    }
    if (!Array.isArray(entry.diffs)) {
      throw new Error(`Drift report entry[${i}] (${entry.provider}) missing "diffs" array`);
    }
    for (let j = 0; j < entry.diffs.length; j++) {
      const diff = entry.diffs[j];
      if (!diff.path || typeof diff.path !== "string") {
        throw new Error(`Drift report entry[${i}].diffs[${j}]: missing "path"`);
      }
      if (!diff.issue || typeof diff.issue !== "string") {
        throw new Error(`Drift report entry[${i}].diffs[${j}]: missing "issue"`);
      }
      if (typeof diff.expected !== "string") {
        throw new Error(`Drift report entry[${i}].diffs[${j}]: missing "expected"`);
      }
      if (typeof diff.real !== "string") {
        throw new Error(`Drift report entry[${i}].diffs[${j}]: missing "real"`);
      }
      if (typeof diff.mock !== "string") {
        throw new Error(`Drift report entry[${i}].diffs[${j}]: missing "mock"`);
      }
      if (!VALID_SEVERITIES.has(diff.severity)) {
        throw new Error(
          `Drift report entry[${i}].diffs[${j}]: invalid severity "${diff.severity}" — expected one of: ${[...VALID_SEVERITIES].join(", ")}`,
        );
      }
    }
  }

  return report;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Format an exec error into a human-readable Error object.
 * Includes exit status, signal, and stderr when available.
 * Logs stderr to console.error as a side effect when present.
 */
function formatExecError(cmd: string, err: unknown): Error {
  const e = err as { status?: number; signal?: string; stderr?: string | Buffer };
  const detail = [
    e.status !== undefined ? `exit ${e.status}` : null,
    e.signal ? `signal ${e.signal}` : null,
    e.stderr ? String(e.stderr).trim() : null,
  ]
    .filter(Boolean)
    .join(", ");
  const msg = `Command failed: ${cmd}${detail ? ` (${detail})` : ""}`;
  if (e.stderr) console.error(msg);
  return new Error(msg);
}

/**
 * Run a shell command and return its trimmed stdout.
 *
 * WARNING: This function passes the command string directly to a shell.
 * NEVER call it with interpolated values — use execFileSafe() for commands
 * with dynamic arguments.
 */
export function exec(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trimEnd();
  } catch (err: unknown) {
    throw formatExecError(cmd, err);
  }
}

/**
 * Run a command safely without shell interpolation.
 * Use this for all commands with dynamic arguments.
 */
export function execFileSafe(file: string, args: string[]): void {
  try {
    execFileSync(file, args, { stdio: "inherit" });
  } catch (err: unknown) {
    throw formatExecError(`${file} ${args.join(" ")}`, err);
  }
}

export function readFileIfExists(path: string): string | null {
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf-8");
}

// ---------------------------------------------------------------------------
// Changed-file parsing
// ---------------------------------------------------------------------------

/**
 * Parse a single line from `git status --porcelain` output into a file path.
 * Handles quoted paths (special characters) and rename notation (old -> new).
 */
export function parsePorcelainLine(line: string): string {
  let path = line.slice(3).trim();
  // Handle renames first: "old -> new" → take the new path
  const arrowIdx = path.indexOf(" -> ");
  if (arrowIdx !== -1) {
    path = path.slice(arrowIdx + 4);
  }
  // Then strip quotes (git quotes paths with special characters)
  if (path.startsWith('"') && path.endsWith('"')) {
    path = path.slice(1, -1);
  }
  return path;
}

/**
 * Return the list of changed files from `git status --porcelain`.
 */
export function getChangedFiles(): string[] {
  return exec("git status --porcelain").split("\n").filter(Boolean).map(parsePorcelainLine);
}

// ---------------------------------------------------------------------------
// Version bump + CHANGELOG
// ---------------------------------------------------------------------------

export function patchBumpVersion(): string {
  const pkgPath = resolve("package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
    version: string;
    description?: string;
    [key: string]: unknown;
  };
  const parts = pkg.version.split(".").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) {
    throw new Error(`Cannot patch-bump non-standard version: ${pkg.version}`);
  }
  parts[2] += 1;
  const newVersion = parts.join(".");
  pkg.version = newVersion;

  // Sync description with README subtitle
  syncDescriptionFromReadme(pkg);

  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
  return newVersion;
}

/** Keep package.json description in sync with the README subtitle. */
function syncDescriptionFromReadme(pkg: { description?: string; [key: string]: unknown }): void {
  const readmePath = resolve("README.md");
  try {
    const readme = readFileSync(readmePath, "utf-8");
    // The description is the first non-empty, non-heading, non-badge, non-video,
    // non-HTML line. The README opens with a raw <div align="center"> wrapper,
    // which is not prose and must not become the published description.
    const lines = readme.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (
        !trimmed ||
        trimmed.startsWith("#") ||
        trimmed.startsWith("[![") ||
        trimmed.startsWith("![") ||
        trimmed.startsWith("[") ||
        trimmed.startsWith("<") ||
        trimmed.startsWith("http")
      ) {
        continue;
      }
      // Found the subtitle — strip markdown formatting
      const clean = trimmed.replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();
      if (clean && clean !== pkg.description) {
        pkg.description = clean;
      }
      break;
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("Could not sync description from README:", err);
    }
  }
}

export function addChangelogEntry(report: DriftReport, version: string): void {
  const changelogPath = resolve("CHANGELOG.md");
  const existing = readFileIfExists(changelogPath) ?? "";

  const providerSummaries = report.entries.map((entry) => {
    const fields = entry.diffs.map((d) => d.path).join(", ");
    return `- ${entry.provider} (${entry.scenario}): ${fields}`;
  });

  const newEntry = [
    `## ${version}`,
    "",
    "### Patch Changes",
    "",
    "- Auto-remediate API drift:",
    ...providerSummaries.map((s) => `  ${s}`),
    "",
  ].join("\n");

  // Insert after the title line (any line starting with "# ")
  const titleMatch = existing.match(/^# .+\n/);
  if (titleMatch) {
    const titleLine = titleMatch[0];
    const rest = existing.slice(titleLine.length);
    writeFileSync(changelogPath, titleLine + "\n" + newEntry + rest, "utf-8");
  } else {
    writeFileSync(changelogPath, newEntry + "\n" + existing, "utf-8");
  }
}

// =============================================================================
// C2: deterministic sync core — the DATA-only, ZERO-LLM replacement for the
// freewriter's DECISION role on the model-churn (add/deprecate) leg.
//
// This mechanically applies live `/models` churn to the frozen registry
// (`src/__tests__/drift/model-registry.ts`) with no model call and no
// free-form code generation:
//
//   - DEPRECATION (classified − live, via a mirror of C4's
//     `detectDeprecatedFamilies`): a family aimock mocks that a healthy live
//     listing no longer contains. A provider-confirmed deprecation is a FACT,
//     not a decision — the provider's own listing already says the family is
//     gone — so it NEVER routes to a human. It is RECORDED, mechanically, as a
//     new literal in `deprecatedFamilies[provider]` (model-registry.ts),
//     comment-marked with the date and whether aimock's own source still
//     references it. The mock is left FUNCTIONING: `includeFamilies` is not
//     touched, so every fixture and builder for that family keeps serving, and
//     `includeFamilies`'s checksum pin stays green. Recording is what stops the
//     same deprecation being re-derived as novel drift every morning.
//     Dropping a retired family from aimock altogether stays a human's job (it
//     needs the `logic-pin.test.ts` re-pin the sync's own changed-file
//     allowlist forbids it from making) — but it is optional cleanup, not an
//     alert, and nothing is broken while it is undone.
//   - ADDITION (a genuinely new, UNCLASSIFIED family — matches no include,
//     exclude, `-preview`, or Gemma rule): NEVER auto-classified. Routed to a
//     human via the same dedup note-file mechanism. Only once a human edits
//     that note's `Decision:` line to `include` does the NEXT sync run
//     mechanically add the family literal — still zero-LLM (a plain text
//     marker a human wrote is not code generation), and still never silent
//     (the registry is never touched without an explicit, reviewed decision
//     recorded in the diff).
//
// Both mechanical edits are gated behind C5's `drift-sync-check` (the
// allowlist + pin re-assert + clean re-collect) before anything is kept; a
// failing gate reverts the edit rather than leaving a broken write behind.
//
// NOTE ON WHY THIS DOES NOT IMPORT `models.drift.ts` DIRECTLY: that module
// (like every `*.drift.ts` file) imports `{ describe, it, expect }` from
// "vitest", and merely EVALUATING that import outside an active vitest worker
// throws ("Vitest failed to access its internal state") — confirmed
// empirically; this is exactly why `drift-report-collector.ts` shells out to
// `npx vitest run` for the `*.drift.ts` suites instead of importing them.
// Since this script runs as a plain CI step (`npx tsx scripts/drift-sync.ts`),
// it cannot import `models.drift.ts`. The two pure predicates below
// (`detectDeprecatedFamiliesForSync`, `unclassifiedFamiliesForSync`) mirror
// C4's `detectDeprecatedFamilies`/`unclassifiedFamilies` byte-for-byte against
// the SAME underlying data/logic modules (`model-registry.ts`,
// `model-family.ts`, `deprecation-detector.ts` — none of which import
// vitest), so the two call sites cannot silently diverge in RESULT even
// though they are textually separate: P0's checksum pin freezes the
// `isClassifiedFamily`/`normalizeModelFamily` primitives both copies compose,
// and `models.drift.ts`'s own vitest suite exercises its copy directly.
// =============================================================================

export type Provider = "openai" | "anthropic" | "gemini";

// ---------------------------------------------------------------------------
// Mirrored classification predicates (see module doc above).
// ---------------------------------------------------------------------------

export interface DeprecationCandidate {
  provider: Provider;
  family: string;
  stillReferenced: boolean;
}

export type DeprecationCheckResult =
  | { status: "skipped"; reason: string }
  | { status: "checked"; candidates: DeprecationCandidate[] };

/** Mirror of `models.drift.ts`'s `detectDeprecatedFamilies` — see module doc. */
export function detectDeprecatedFamiliesForSync(
  liveModelIds: string[],
  provider: Provider,
  opts: {
    isReferenced?: (family: string, provider: Provider) => boolean;
    isRecorded?: (family: string, provider: Provider) => boolean;
    minListingSize?: number;
  } = {},
): DeprecationCheckResult {
  const classified = includeFamilies[provider];
  const floor = opts.minListingSize ?? MIN_LISTING_SIZE[provider];

  if (liveModelIds.length === 0 || liveModelIds.length < floor) {
    return {
      status: "skipped",
      reason:
        `${LISTING_UNTRUSTED_SKIP_MARKER} for ${provider} ` +
        `(${liveModelIds.length} raw id(s), need >= ${floor} — the smallest ` +
        `listing this provider plausibly returns) — never mass-removing off a ` +
        `truncated or empty listing`,
    };
  }

  const liveFamilies = new Set(liveModelIds.map((id) => normalizeModelFamily(id, provider)));
  // Exclude known forward-looking (not-yet-launched) families entirely — never
  // propose removing one merely because it hasn't gone live yet (see
  // `isForwardLookingFamily`'s module doc in deprecation-detector.ts). This is
  // checked BEFORE `isReferenced`: a forward-looking family legitimately has no
  // source reference either (aimock hasn't built its fixture yet), so relying
  // on "still referenced" alone can't distinguish it from a genuine retirement.
  // Drop retirements already RECORDED in `deprecatedFamilies` (model-registry.ts).
  // The provider's listing is not going to start containing them again, so
  // re-deriving them is the same news every morning forever — the ledger exists
  // precisely so the second sighting is silent. Same shape, and the same
  // reasoning, as the forward-looking filter above; the difference is only which
  // direction the family is missing IN.
  const isRecorded = opts.isRecorded ?? isRecordedDeprecation;
  const missing = [...classified]
    .filter((family) => !liveFamilies.has(family))
    .filter((family) => !isForwardLookingFamily(family, provider))
    .filter((family) => !isRecorded(family, provider))
    .sort();
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

/** Mirror of `models.drift.ts`'s `unclassifiedFamilies` — see module doc. */
export function unclassifiedFamiliesForSync(modelIds: string[], provider: Provider): string[] {
  const unclassified = new Set<string>();
  for (const id of modelIds) {
    const family = normalizeModelFamily(id, provider);
    if (isClassifiedFamily(family, provider)) continue;
    if (NON_MODEL_TOKENS.has(family) || NON_MODEL_TOKENS.has(id)) continue;
    unclassified.add(family);
  }
  return [...unclassified].sort();
}

// ---------------------------------------------------------------------------
// Needs-human dedup note files (`drift-proposals/`).
// ---------------------------------------------------------------------------

/** Must match `scripts/drift-sync-check.ts`'s `ALLOWED_PREFIXES`. */
export const DRIFT_PROPOSALS_DIR = "drift-proposals";

/**
 * The two things drift-sync genuinely cannot decide alone. Deprecations are
 * deliberately NOT here: a provider-confirmed retirement is a fact drift-sync
 * records mechanically (see `deprecatedFamilies` in model-registry.ts), so it
 * never produces a note and never pages anyone.
 */
export type ProposalKind =
  | "new-family"
  | "registry-structural-mismatch"
  /**
   * A human's `Decision:` on an OpenAI VOICE/AUDIO family (only
   * {@link VOICE_SEED_SET_PROVIDER} — see {@link needsVoiceSeedSetEdit}).
   * `excludeFamilies` and `knownVoiceModelFamilies` are deliberately disjoint
   * surfaces (see `voice-models.ts`), and the sync writes only the first — so
   * applying such a family's classification alone leaves the realtime canary
   * red, the gate refuses the run, both files revert, and the identical note
   * re-fires the same apply/fail/revert every night forever. Routed to a human
   * instead. A voice-shaped family from any other provider never gets this note.
   */
  | "voice-seed-set"
  /**
   * A classification a human decided that drift-sync could NOT safely re-pin.
   * The registry edit was refused wholesale, so this run wrote nothing but this
   * note — which exists so the refusal has a deduped, human-facing artifact
   * instead of only a red job.
   */
  | "pin-repin-failure";
export type ProposalDecision = "pending" | "include" | "exclude";

/**
 * The one provider whose voice/audio families the realtime canary watches:
 * ws-realtime.drift.ts calls `detectOpenAIVoiceModelDrift` in voice-models.ts,
 * which reads only the OpenAI listing.
 */
export const VOICE_SEED_SET_PROVIDER: Provider = "openai";

/** Family-keyed dedup path — re-firing the same alert always resolves to the SAME path. */
export function proposalNoteRelPath(
  provider: Provider,
  family: string,
  kind: ProposalKind,
): string {
  const slug = family.replace(/[^a-z0-9.-]+/gi, "-");
  const kindSlug =
    kind === "new-family"
      ? "new-family"
      : kind === "registry-structural-mismatch"
        ? "structural-mismatch"
        : kind;
  return `${DRIFT_PROPOSALS_DIR}/${provider}-${slug}-${kindSlug}.md`;
}

/** Parse the note's `Decision:` line. Defaults to "pending" (fail-closed — never infers approval). */
export function parseProposalDecision(noteText: string): ProposalDecision {
  const m = noteText.match(/^Decision:\s*(\S+)/m);
  if (!m) return "pending";
  const word = m[1].toLowerCase();
  // Fail-closed: anything that is not one of the two recognised human verdicts
  // is `pending`. Never infer approval OR rejection from an unrecognised word.
  if (word === "include") return "include";
  if (word === "exclude") return "exclude";
  return "pending";
}

export function renderProposalNote(
  provider: Provider,
  family: string,
  kind: ProposalKind,
  detail: string,
  stamp: string,
): string {
  const title =
    kind === "new-family"
      ? "New / unclassified model family"
      : kind === "registry-structural-mismatch"
        ? "Registry structural mismatch — mechanical edit could not be applied"
        : kind === "voice-seed-set"
          ? "Voice/audio family — classification needs a second, hand-written edit"
          : "Membership re-pin refused — classification not applied";
  const lines = [
    `# ${title}: ${family}`,
    "",
    `Provider: ${provider}`,
    `Detected: ${stamp}`,
    "Status: NEEDS HUMAN REVIEW",
    "",
    detail,
    "",
  ];
  if (kind === "new-family") {
    lines.push(
      "## Decision",
      "<!-- drift-sync never auto-classifies a new family. A HUMAN decides, by",
      "     changing the line below to either:",
      "",
      "       Decision: include   — aimock mocks this family on the chat surface",
      "       Decision: exclude   — wrong modality / retired / preview; not ours",
      "",
      "     The NEXT drift-sync run then applies the mechanical registry edit to",
      "     includeFamilies or excludeFamilies respectively, and re-pins that",
      "     set's membership checksum in the same commit (still zero-LLM: this",
      provider === VOICE_SEED_SET_PROVIDER
        ? "     is a human-authored decision, not generated code)."
        : "     is a human-authored decision, not generated code). -->",
    );
    // The voice seed-set exception applies only where its canary looks: see
    // needsVoiceSeedSetEdit. On any other provider's note it would demand an
    // edit no gate needs.
    if (provider === VOICE_SEED_SET_PROVIDER) {
      lines.push(
        "",
        "     ONE EXCEPTION, and it is the common one for `exclude`: a VOICE/AUDIO",
        "     family (realtime / audio / live / transcribe / whisper / voice / tts)",
        "     is watched by a SECOND canary whose seed set — knownVoiceModelFamilies",
        "     in src/__tests__/drift/voice-models.ts — is a deliberately disjoint",
        "     surface drift-sync does not write. Classifying such a family in the",
        "     registry alone leaves that canary red, so the run would gate-fail and",
        "     revert, nightly, forever. drift-sync therefore does NOT auto-apply it:",
        "     it drops a `-voice-seed-set.md` note and a human makes both edits in",
        "     one reviewed commit. -->",
      );
    }
    lines.push("Decision: pending", "");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Mechanical registry edits — AST-LOCATED (via the real TypeScript parser, not
// a hand-rolled regex/lexer scan) then applied as a single-line text splice.
// The parser is used only to unambiguously find the array literal inside
// `includeFamilies[provider]` / `excludeFamilies[provider]` /
// `deprecatedFamilies[provider]` and the exact line of its closing bracket —
// the mutation itself is a trivial whole-line insert, never a partial-token or
// multi-line reformat, so it cannot silently mangle an adjacent grouping
// comment or a sibling entry.
// ---------------------------------------------------------------------------

export const MODEL_REGISTRY_REL_PATH = "src/__tests__/drift/model-registry.ts";

// ---------------------------------------------------------------------------
// Membership re-pinning (logic-pin.test.ts).
//
// `includeFamilies` / `excludeFamilies` are membership-checksum-pinned in
// logic-pin.test.ts so that NOBODY can quietly add or drop a classified family
// without a human noticing. That guard is why the sync may not invent a
// classification — and it is ALSO why, before this existed, the sync could not
// finish a classification a human HAD already approved: the registry edit
// landed, the pin went stale, gate-2 reds, and the run reported gate-failed.
//
// The review the pin exists to force still happens; it just happens EARLIER, as
// the human-authored `Decision:` line in the drift-proposals/ note. Once that
// verdict exists, moving the pin is bookkeeping, not judgement.
//
// Three things keep this narrow, and only the first two are this module's:
//   1. `updateDataFrozenPin` rewrites the pin of exactly ONE named key, located
//      through the TypeScript AST and replaced span-exactly INSIDE that entry's
//      own string literal, and refuses (locatorMiss) if the key is absent,
//      duplicated, or carries no recognisable digest.
//   2. `verifyPinFileEdit` re-reads the result and refuses the write unless
//      re-applying THIS RUN'S re-pins to the pre-edit file reproduces it byte
//      for byte. "Only `pin:` literals moved" is not that check: every `pin:`
//      literal — the FROZEN LOGIC checksums included — masks to the same token,
//      so both a wrong-key write and a re-pasted logic checksum read as
//      pin-only.
//   3. The EXTERNAL gate. `drift-sync-check` evaluates the same predicate over
//      the git diff, keyed to `SYNC_REPINNABLE_KEYS`. That one is what actually
//      constrains the file, because it does not trust this writer at all.
// ---------------------------------------------------------------------------

// The pin-file locator, rewriter and verifier live in `drift-pin-file.ts` — see
// that module's header for why they are not in here: the CHECKER has to evaluate
// the same predicate over the git diff, and a constraint on the pin file that
// only the writer enforces is not a constraint on the pin file.
export {
  LOGIC_PIN_REL_PATH,
  updateDataFrozenPin,
  onlyPinsChanged,
  diffPinKeys,
  parseDataFrozenPins,
  verifyPinFileEdit,
  SYNC_REPINNABLE_KEYS,
} from "./drift-pin-file.js";

/** The DATA_FROZEN key a `<listName>[<provider>]` membership set is pinned under. */
export function dataFrozenKey(listName: RegistrySetName, provider: Provider): string {
  return `${listName}.${provider}`;
}

/**
 * The pin value logic-pin.test.ts computes for a membership set:
 * `sha256(JSON.stringify(sortedMembers))`. Mirrors that file's own `sha256`
 * helper and its `members()` accessor, which sorts before hashing.
 *
 * DEDUPED, because the real sets are `Set`s built through `familySet`: if an
 * applied family ever normalises onto an existing member, hashing the plain
 * concatenation would pin a duplicated array the pin file can never reproduce —
 * a wrong pin that reds gate-2 and reads like a spurious membership change.
 */
export function computeMembershipPin(members: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify([...new Set(members)].sort()))
    .digest("hex");
}

export type RegistrySetName = "includeFamilies" | "excludeFamilies" | "deprecatedFamilies";

interface FamilySetLocation {
  /** family literal text -> 0-based source line index of that literal's own line. */
  elementLines: Map<string, number>;
  /** 0-based source line index of the array's closing `]` line. */
  arrayEndLine: number;
  /** Indentation captured from an existing element line (fallback for inserts into an empty array). */
  elementIndent: string;
}

/** Locate `exportName[provider]`'s array literal inside `model-registry.ts` source text. */
function locateFamilySetArray(
  sourceText: string,
  exportName: RegistrySetName,
  provider: Provider,
): FamilySetLocation | null {
  const sf = ts.createSourceFile("model-registry.ts", sourceText, ts.ScriptTarget.Latest, true);
  let target: ts.ArrayLiteralExpression | undefined;

  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.name.text !== exportName) continue;
      if (!decl.initializer || !ts.isObjectLiteralExpression(decl.initializer)) continue;
      for (const prop of decl.initializer.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const key = ts.isIdentifier(prop.name)
          ? prop.name.text
          : ts.isStringLiteral(prop.name)
            ? prop.name.text
            : null;
        if (key !== provider) continue;
        const init = prop.initializer;
        if (
          ts.isCallExpression(init) &&
          init.arguments.length >= 2 &&
          ts.isArrayLiteralExpression(init.arguments[1])
        ) {
          target = init.arguments[1];
        }
      }
    }
  }
  if (!target) return null;

  const elementLines = new Map<string, number>();
  let elementIndent: string | null = null;
  for (const el of target.elements) {
    if (ts.isStringLiteral(el)) {
      const { line, character } = sf.getLineAndCharacterOfPosition(el.getStart(sf));
      elementLines.set(el.text, line);
      elementIndent = " ".repeat(character);
    }
  }
  const { line: arrayEndLine } = sf.getLineAndCharacterOfPosition(target.getEnd());
  if (elementIndent === null) {
    // An array with no string element yet — `deprecatedFamilies`'s three
    // comment-seeded arrays on the day the ledger is empty. There is no sibling
    // entry to copy an indent from, so derive it from the array's own opening
    // line (`  <provider>: familySet("<provider>", [`) plus one 2-space level.
    // Cosmetic only: the repo's prettier pre-commit hook normalizes it either
    // way, and the AST locator does not care.
    const { line: arrayStartLine } = sf.getLineAndCharacterOfPosition(target.getStart(sf));
    const openIndent = sourceText.split("\n")[arrayStartLine]?.match(/^(\s*)/)?.[1] ?? "";
    elementIndent = `${openIndent}  `;
  }
  return { elementLines, arrayEndLine, elementIndent };
}

export interface RegistryEditResult {
  changed: boolean;
  text: string;
  detail: string;
  /**
   * True when the AST locator could NOT find the target array literal in
   * `model-registry.ts` (structural mismatch). This is distinct from a benign
   * no-op (the family is already present, so there is nothing to add): a
   * locator miss means a real edit could not be applied and MUST be routed to
   * a human — never collapsed into a silent, clean no-op (G#1).
   */
  locatorMiss?: boolean;
}

/** Mechanical, comment-marked addition of `family` to `exportName[provider]`. */
export function addFamilyLiteralInSource(
  sourceText: string,
  exportName: RegistrySetName,
  provider: Provider,
  family: string,
  reasonComment: string,
): RegistryEditResult {
  const loc = locateFamilySetArray(sourceText, exportName, provider);
  if (!loc) {
    return {
      changed: false,
      text: sourceText,
      detail: `could not locate ${exportName}.${provider} array in model-registry.ts (structural mismatch — routing to human)`,
      locatorMiss: true,
    };
  }
  if (loc.elementLines.has(family)) {
    return {
      changed: false,
      text: sourceText,
      detail: `"${family}" is already present in ${exportName}.${provider}`,
    };
  }
  const lines = sourceText.split("\n");
  const newLine = `${loc.elementIndent}"${family}", // ${reasonComment}`;
  lines.splice(loc.arrayEndLine, 0, newLine);
  return {
    changed: true,
    text: lines.join("\n"),
    detail: `added "${family}" to ${exportName}.${provider} (comment-marked)`,
  };
}

// ---------------------------------------------------------------------------
// Orchestration — pure over injected deps (fully testable with no real fs/git/network I/O).
// ---------------------------------------------------------------------------

export enum SyncCoreReason {
  OK_NO_CHURN = "ok-no-churn",
  OK_APPLIED = "ok-applied",
  NEEDS_HUMAN = "needs-human",
  GATE_FAILED = "gate-failed",
}

export interface ProviderChurnInput {
  provider: Provider;
  /** Live `/models` ids, or `null` if the live check was skipped (no key / infra error). */
  liveModelIds: string[] | null;
  skipReason?: string;
}

export interface SyncCheckResultLike {
  ok: boolean;
  reason: string;
  detail: string;
}

export interface SyncCoreDeps {
  isReferenced?: (family: string, provider: Provider) => boolean;
  /**
   * "Has this retirement already been written down?" Defaults to the real
   * ledger (`isRecordedDeprecation` over `deprecatedFamilies`). Injectable
   * because the real one reads the COMPILED registry module while the core
   * edits registry SOURCE TEXT, so a test cannot otherwise observe a second run
   * seeing the first run's record.
   */
  isRecorded?: (family: string, provider: Provider) => boolean;
  /**
   * "Is this family already in the realtime canary's voice seed set?" Defaults
   * to `isKnownVoiceModelFamily` from voice-models.ts. Injectable for the same
   * reason as `isRecorded`: the seed set is module-private and immutable from
   * outside, so a test cannot otherwise build the "seed-set half already made"
   * case.
   */
  isKnownVoiceFamily?: (family: string) => boolean;
  readRegistrySource: () => string;
  writeRegistrySource: (text: string) => void;
  /**
   * Read/write logic-pin.test.ts, where the membership checksums live. The core
   * re-pins ONLY the key whose set it just edited, and only after
   * `onlyPinsChanged` proves the rewrite touched nothing but `pin:` literals.
   * Optional so an existing caller that never triggers a classification keeps
   * working unchanged; a run that WOULD re-pin without these routes to a human
   * instead of silently leaving a stale pin behind.
   */
  readLogicPinSource?: () => string;
  writeLogicPinSource?: (text: string) => void;
  readProposalNote: (relPath: string) => string | null;
  writeProposalNote: (relPath: string, text: string) => void;
  /**
   * Run C5's drift-sync-check gate. `opts.skipRecollect` runs gate-1
   * (allowlist) + gate-2 (pin) but SKIPS gate-3 (the live re-collect), for the
   * runs where a fresh collector pass cannot answer gate-3's question — see
   * {@link gate3SkipReason} for the two cases and their evidence.
   * `opts.skipRecollectReason` carries WHY into the verdict detail.
   */
  runSyncCheck: (opts?: {
    skipRecollect?: boolean;
    skipRecollectReason?: string;
  }) => SyncCheckResultLike;
  /** Revert every file in `relPaths` (e.g. `git checkout -- <paths>`) after a failed gate. */
  revertFiles: (relPaths: string[]) => void;
  now?: () => Date;
}

/**
 * Would classifying `family` in the registry alone leave the REALTIME CANARY
 * red? Only ever true on {@link VOICE_SEED_SET_PROVIDER} (OpenAI) — see the
 * last paragraph.
 *
 * `ws-realtime.drift.ts` asserts that `detectOpenAIVoiceModelDrift` in
 * `voice-models.ts` reports no unknown voice families, at CRITICAL severity.
 * That check reads the voice seed set, which is deliberately DISJOINT from
 * `includeFamilies`/`excludeFamilies` and which drift-sync does not write. So for
 * a family this returns true for, an auto-applied classification fails gate-3 on
 * any run where gate-3 runs: apply, revert, alert — with the note still saying
 * `Decision: exclude`, so the identical run repeats every night forever. The precedent the
 * exclude affordance was modelled on (936b59c, gpt-transcribe /
 * gpt-live-transcribe) needed BOTH edits by hand and says so.
 *
 * Both verdicts are covered, not just `exclude`: the canary reads the voice seed
 * set, not the classification, so `include` of an unknown voice family leaves it
 * just as red.
 *
 * A voice-shaped family ALREADY in the seed set is not affected — the canary is
 * quiet for it, so the registry edit is the only one outstanding.
 *
 * Scoped to {@link VOICE_SEED_SET_PROVIDER}: the realtime canary reads ONLY the
 * OpenAI `/models` listing (via `detectOpenAIVoiceModelDrift`), so a
 * voice-shaped id from another provider (e.g. `gemini-x-tts`, which
 * `isVoiceModelId` matches on `-tts`) can never turn it red. For such a
 * family no voice seed-set edit is needed, and drift-sync applies the registry
 * edit (other live canaries may still report their own, unrelated drift).
 */
export function needsVoiceSeedSetEdit(
  family: string,
  provider: Provider,
  isKnown: (family: string) => boolean = isKnownVoiceModelFamily,
): boolean {
  return provider === VOICE_SEED_SET_PROVIDER && isVoiceModelId(family) && !isKnown(family);
}

export type FamilyAction =
  | "deprecation-recorded"
  | "added"
  | "excluded"
  | "needs-human-new-family"
  | "needs-human-structural-mismatch"
  | "needs-human-voice-seed-set"
  | "needs-human-repin"
  | "no-op";

export interface FamilyOutcome {
  provider: Provider;
  family: string;
  action: FamilyAction;
  detail: string;
}

export interface SyncCoreOutcome {
  ok: boolean;
  reason: SyncCoreReason;
  detail: string;
  outcomes: FamilyOutcome[];
  skipped: { provider: Provider; reason: string }[];
}

/**
 * WHY gate-3 (the live re-collect) cannot answer this run's question, or `null`
 * when it can. The returned string is quoted verbatim into the gate's verdict.
 *
 * Gate-3 re-runs the WHOLE live drift suite and vetoes on its GLOBAL critical
 * count. That is only a meaningful verdict on THIS run's edit when the suite has
 * a surface that observes the edit. Two runs where it does not:
 *
 *  1. A MIXED RUN (a mechanical edit PLUS a family deferred to a human). A fresh
 *     collector pass still (correctly) reports the deferred family as residual
 *     critical drift, so gate-3 would revert the valid edit alongside it. This is
 *     the long-standing D-M1 case.
 *
 *  2. A DEPRECATION-ONLY RUN. The edit appends a family literal to
 *     `deprecatedFamilies`, and NOTHING in the collector's suite glob
 *     (`src/__tests__/drift/**\/*.drift.ts`, per vitest.config.drift.ts) reads
 *     `deprecatedFamilies`: the only LIVE model-family canary is the
 *     UNCLASSIFIED direction (`unclassifiedFamilies` — live minus classified),
 *     while the deprecation direction (`detectDeprecatedFamilies` — classified
 *     minus live) is exercised only OFFLINE against injected payloads. A recorded
 *     deprecation therefore cannot change a single collector output, so gate-3
 *     can neither confirm nor refute it — it can only veto it on whatever
 *     unrelated drift the live suite happened to see that morning. It did exactly
 *     that: the identical changeset `74f6efa43753f7d0` was refused as
 *     `gate-failed` on 2026-08-11 (run 31465219443, "still reports 1 critical
 *     diff(s)") and applied as `ok-applied` on 2026-08-12 (run 31570802134, PR
 *     #370) — a daily cron reddening at random on a correct edit, and reporting
 *     it as "the mechanical edit was wrong".
 *
 *     That premise is PINNED by `drift-sync-gate-determinism.test.ts`: if a live
 *     deprecation canary is ever added to a `*.drift.ts`, that test reds and
 *     sends whoever added it here.
 *
 * An `added` run is NOT on this list, and must not be: appending to
 * `includeFamilies` makes the unclassified canary stop reporting the family, so
 * gate-3 genuinely observes that edit — including an approved addition that
 * landed in the wrong provider's array, which the canary still reports.
 */
export function gate3SkipReason(outcomes: readonly FamilyOutcome[]): string | null {
  if (outcomes.some((o) => o.action.startsWith("needs-human-"))) {
    return "this run also deferred a family to a human, which a fresh collector pass would still report as residual critical drift";
  }
  if (!outcomes.some((o) => o.action === "added" || o.action === "excluded")) {
    return "this run only RECORDED deprecations, and no live drift surface reads deprecatedFamilies — a re-collect cannot observe this edit";
  }
  return null;
}

/** The registry set a human `Decision:` word writes into. */
function listNameFor(decision: "include" | "exclude"): RegistrySetName {
  return decision === "include" ? "includeFamilies" : "excludeFamilies";
}

/** Read-or-create a dedup note (write only on first sighting — re-fire never spams a duplicate). */
function ensureProposalNote(
  deps: SyncCoreDeps,
  path: string,
  render: () => string,
  touched: Set<string>,
): string | null {
  const existing = deps.readProposalNote(path);
  if (existing !== null) return existing;
  deps.writeProposalNote(path, render());
  touched.add(path);
  return null;
}

/**
 * The C2 sync core. Mechanically applies model churn (deprecation +
 * genuinely-new-family) across every provider input to the frozen registry,
 * gated behind C5's `drift-sync-check` before any edit is kept. NEVER invokes
 * an LLM and NEVER generates free-form code — every mutation is one of the
 * two mechanical text edits above, or a note file.
 */
export function runDriftSyncCore(
  inputs: ProviderChurnInput[],
  deps: SyncCoreDeps,
): SyncCoreOutcome {
  const now = deps.now ?? (() => new Date());
  const stamp = now().toISOString().slice(0, 10);

  const outcomes: FamilyOutcome[] = [];
  const skipped: { provider: Provider; reason: string }[] = [];
  const touchedFiles = new Set<string>();

  let registrySource = deps.readRegistrySource();
  let registryChanged = false;
  /** Pinned membership sets this run moved → the families it added to each. */
  const repins = new Map<
    string,
    { listName: RegistrySetName; provider: Provider; families: Set<string> }
  >();

  for (const input of inputs) {
    if (input.liveModelIds === null) {
      skipped.push({
        provider: input.provider,
        reason: input.skipReason ?? "live listing unavailable",
      });
      continue;
    }

    // --- Deprecation half: classified − live (C4's algorithm, mirrored). ---
    const dep = detectDeprecatedFamiliesForSync(input.liveModelIds, input.provider, {
      isReferenced: deps.isReferenced,
      isRecorded: deps.isRecorded,
    });
    if (dep.status === "skipped") {
      skipped.push({ provider: input.provider, reason: dep.reason });
    } else {
      for (const cand of dep.candidates) {
        // A PROVIDER-CONFIRMED DEPRECATION IS A FACT, NOT A DECISION.
        //
        // The provider's own /models listing already says the family is gone.
        // There is nothing here for a human to weigh, so this must never page
        // one — it used to route BOTH legs (zero-reference and still-referenced)
        // to a needs-human note, which made an unattended cron go red and email
        // the repo owner every morning to "decide" ten retirements Anthropic had
        // already announced by deleting them from its catalog.
        //
        // The mechanical action is to RECORD the retirement in
        // `deprecatedFamilies[provider]`, not to act on it:
        //
        //   * The mock KEEPS SERVING. `includeFamilies` is untouched, so every
        //     builder and fixture for the family still answers. Users pin
        //     retired model ids in their own test suites for years; the upstream
        //     catalog shrinking is not a reason to break them, and a silent
        //     removal would. It also keeps `includeFamilies`'s membership
        //     checksum pin green, so the edit survives gate-2 — a persisted
        //     REMOVAL never could (the pin reds, `revertFiles` wipes the run, no
        //     PR of any class; observed).
        //   * The recording is what makes it stop. `detectDeprecatedFamiliesForSync`
        //     filters recorded families out of its candidate set, so tomorrow's
        //     run is quiet instead of re-deriving the same list forever.
        //
        // `stillReferenced` no longer chooses a ROUTE — both legs record — it
        // only annotates the recorded line, because "nothing references this any
        // more" is the one fact that tells a human the optional cleanup (drop it
        // from `includeFamilies` + re-pin, in one reviewed commit) is safe.
        const referenceNote = cand.stillReferenced
          ? "still referenced in aimock source — mock retained"
          : "no remaining aimock reference — droppable from includeFamilies in a reviewed re-pin";
        const edit = addFamilyLiteralInSource(
          registrySource,
          "deprecatedFamilies",
          cand.provider,
          cand.family,
          `DEPRECATED ${stamp} (drift-sync): absent from live /models; ${referenceNote}`,
        );
        if (edit.changed) {
          registrySource = edit.text;
          registryChanged = true;
          outcomes.push({
            provider: cand.provider,
            family: cand.family,
            action: "deprecation-recorded",
            detail: `"${cand.family}" is absent from the live /models listing — recorded in deprecatedFamilies.${cand.provider} (${referenceNote})`,
          });
        } else if (edit.locatorMiss) {
          // G#1: the AST locator could not find deprecatedFamilies[provider] in
          // model-registry.ts. A real deprecation could not be recorded — this
          // must route to a human, NEVER collapse into a silent clean no-op.
          const smPath = proposalNoteRelPath(
            cand.provider,
            cand.family,
            "registry-structural-mismatch",
          );
          ensureProposalNote(
            deps,
            smPath,
            () =>
              renderProposalNote(
                cand.provider,
                cand.family,
                "registry-structural-mismatch",
                `A deprecation was detected for "${cand.family}" but drift-sync could not locate ` +
                  `the deprecatedFamilies.${cand.provider} array literal in ` +
                  `${MODEL_REGISTRY_REL_PATH} — the registry's structure changed. A human must ` +
                  `record the deprecation (or fix the locator).`,
                stamp,
              ),
            touchedFiles,
          );
          outcomes.push({
            provider: cand.provider,
            family: cand.family,
            action: "needs-human-structural-mismatch",
            detail: `${edit.detail} (${smPath})`,
          });
        } else {
          outcomes.push({
            provider: cand.provider,
            family: cand.family,
            action: "no-op",
            detail: edit.detail,
          });
        }
      }
    }

    // --- Addition half: genuinely new / unclassified family. ---
    for (const family of unclassifiedFamiliesForSync(input.liveModelIds, input.provider)) {
      const notePath = proposalNoteRelPath(input.provider, family, "new-family");
      const existing = ensureProposalNote(
        deps,
        notePath,
        () =>
          renderProposalNote(
            input.provider,
            family,
            "new-family",
            "This model family appeared in a live /models listing but matches no " +
              "classification rule (include, exclude, -preview, gemma). drift-sync never " +
              "silently classifies a new family.",
            stamp,
          ),
        touchedFiles,
      );
      const decision = existing !== null ? parseProposalDecision(existing) : "pending";
      if (
        (decision === "include" || decision === "exclude") &&
        needsVoiceSeedSetEdit(family, input.provider, deps.isKnownVoiceFamily)
      ) {
        // A DECIDED OpenAI voice/audio family (see needsVoiceSeedSetEdit) still
        // needs a second, hand-written edit to the disjoint voice seed set.
        // Applying half of it is worse than applying none: the run gate-fails on
        // the still-red realtime canary and reverts, so the tree ends up
        // identical either way — but the half-apply spends a nightly alert
        // saying the mechanical edit was wrong. Route it.
        const vsPath = proposalNoteRelPath(input.provider, family, "voice-seed-set");
        ensureProposalNote(
          deps,
          vsPath,
          () =>
            renderProposalNote(
              input.provider,
              family,
              "voice-seed-set",
              `A human decided "${family}" (Decision: ${decision}, in ${notePath}), but this is a ` +
                `VOICE/AUDIO family and its normalized family key is not in ` +
                `knownVoiceModelFamilies. Two disjoint surfaces need the entry, and drift-sync ` +
                `writes only one of them:\n\n` +
                `  1. ${listNameFor(decision)}.${input.provider} in ${MODEL_REGISTRY_REL_PATH}\n` +
                `  2. knownVoiceModelFamilies in src/__tests__/drift/voice-models.ts (plus its ` +
                `DATA_FROZEN membership pin in ${LOGIC_PIN_REL_PATH})\n\n` +
                `Applying (1) alone leaves ws-realtime.drift.ts reporting ` +
                `UNKNOWN_REALTIME_MODELS=${family} at critical severity, so drift-sync-check ` +
                `refuses the run and reverts it — nightly, forever. A human must make both ` +
                `edits in one reviewed commit (precedent: 936b59c).`,
              stamp,
            ),
          touchedFiles,
        );
        outcomes.push({
          provider: input.provider,
          family,
          action: "needs-human-voice-seed-set",
          detail:
            `"${family}" was decided (${decision}) but is a voice/audio family absent from ` +
            `knownVoiceModelFamilies — the registry edit alone would leave the realtime canary ` +
            `red and be reverted; routed to human (${vsPath})`,
        });
      } else if (decision === "include" || decision === "exclude") {
        // Both verdicts are the SAME mechanical edit against a different set.
        // `include` = aimock mocks this family on the chat surface; `exclude` =
        // wrong modality / retired / preview. Neither is ever inferred: the word
        // came from a human's hand in the note.
        const listName = listNameFor(decision);
        const verb = decision === "include" ? "ADDED" : "EXCLUDED";
        const edit = addFamilyLiteralInSource(
          registrySource,
          listName,
          input.provider,
          family,
          `${verb} ${stamp} (drift-sync): decided via ${notePath}`,
        );
        if (edit.changed) {
          registrySource = edit.text;
          registryChanged = true;
          // Remember which pinned membership set moved, so the pin is re-pinned
          // in THIS run's commit. A stale pin reds gate-2 and fails the run.
          const key = dataFrozenKey(listName, input.provider);
          const pending = repins.get(key) ?? {
            listName,
            provider: input.provider,
            families: new Set<string>(),
          };
          pending.families.add(family);
          repins.set(key, pending);
          outcomes.push({
            provider: input.provider,
            family,
            action: decision === "include" ? "added" : "excluded",
            detail: edit.detail,
          });
        } else if (edit.locatorMiss) {
          // G#1: a human-approved add could not be applied because the AST
          // locator could not find includeFamilies[provider]. Route to a human
          // rather than reporting a silent clean no-op.
          const smPath = proposalNoteRelPath(
            input.provider,
            family,
            "registry-structural-mismatch",
          );
          ensureProposalNote(
            deps,
            smPath,
            () =>
              renderProposalNote(
                input.provider,
                family,
                "registry-structural-mismatch",
                `An approved classification of "${family}" could not be applied: drift-sync ` +
                  `could not locate the ${listName}.${input.provider} array literal in ` +
                  `${MODEL_REGISTRY_REL_PATH} — the registry's structure changed. A human must ` +
                  `apply the classification (or fix the locator).`,
                stamp,
              ),
            touchedFiles,
          );
          outcomes.push({
            provider: input.provider,
            family,
            action: "needs-human-structural-mismatch",
            detail: `${edit.detail} (${smPath})`,
          });
        } else {
          outcomes.push({
            provider: input.provider,
            family,
            action: "no-op",
            detail: edit.detail,
          });
        }
      } else {
        outcomes.push({
          provider: input.provider,
          family,
          action: "needs-human-new-family",
          detail: `"${family}" is unclassified — routed to human (${notePath})`,
        });
      }
    }
  }

  if (registryChanged) {
    touchedFiles.add(MODEL_REGISTRY_REL_PATH);
  }

  const anyNeedsHuman = outcomes.some((o) => o.action.startsWith("needs-human-"));

  if (touchedFiles.size === 0) {
    return {
      ok: !anyNeedsHuman,
      reason: anyNeedsHuman ? SyncCoreReason.NEEDS_HUMAN : SyncCoreReason.OK_NO_CHURN,
      detail: anyNeedsHuman
        ? "no new mechanical edit this run — one or more families still need human review"
        : "no model churn detected — nothing to sync",
      outcomes,
      skipped,
    };
  }

  // D-M1: a NOTE-ONLY run (a fresh needs-human note, but NO registry edit) must
  // NOT be gated behind the live re-collect. Gate-3 re-runs the collector,
  // which STILL sees the un-actioned family this run just routed to a human as
  // residual critical drift, and would revert the note it just wrote —
  // defeating the whole route-to-human protocol (this is the MOST COMMON case:
  // a genuinely new family). There is no registry mutation to re-verify, so
  // keep the note and report NEEDS_HUMAN directly, without any gate call.
  if (!registryChanged) {
    return {
      ok: false,
      reason: SyncCoreReason.NEEDS_HUMAN,
      detail:
        "needs-human note(s) written this run — routed to human without a live re-collect " +
        "(no registry edit to re-verify)",
      outcomes,
      skipped,
    };
  }

  // A mechanical registry edit WAS applied — persist it and gate it. Gate-1
  // (allowlist) and gate-2 (pin) always apply: they cheaply prove the edit
  // stayed on the data-only surface and left the frozen classification logic
  // intact. Gate-3 (the live re-collect) runs only when the live suite has a
  // surface that can actually observe THIS run's edit — `gate3SkipReason` names
  // the two runs where it does not, with the evidence.
  // Re-pin every membership set this run moved, in the SAME commit as the edit
  // that moved it. Anything unexpected here is a REFUSAL, not a best effort: a
  // half-applied classification (registry edited, pin stale) is precisely the
  // gate-failed state this whole change exists to eliminate.
  let logicPinSource: string | null = null;
  // EVERY refusal below reports the classification as NOT APPLIED, because it
  // is not: the refusals raised before the write never reach
  // `deps.writeRegistrySource`, and the one raised after it reverts both files
  // first, so no path leaves an edit behind. The refusals used
  // to return with the outcomes still reading `action: "added"`, so the run log
  // printed `[added] openai/x`, `buildSyncCommitMessage` wrote `- added
  // openai/x` into a commit containing no registry edit, and
  // `computeChangesetKey` — the workflow's PR de-dup key — was keyed on the
  // same claim. `refuseRepin` re-labels them and leaves a deduped note, so the
  // refusal has a human-facing artifact rather than only a red job.
  const refuseRepin = (detail: string): SyncCoreOutcome => {
    for (const o of outcomes) {
      if (o.action !== "added" && o.action !== "excluded" && o.action !== "deprecation-recorded")
        continue;
      const notePath = proposalNoteRelPath(o.provider, o.family, "pin-repin-failure");
      ensureProposalNote(
        deps,
        notePath,
        () =>
          renderProposalNote(
            o.provider,
            o.family,
            "pin-repin-failure",
            `drift-sync prepared a mechanical registry edit for "${o.family}" and then ` +
              `refused to keep this run at all: ${detail}\n\n` +
              `NOTHING survives in ${MODEL_REGISTRY_REL_PATH} or ${LOGIC_PIN_REL_PATH} — a ` +
              `registry edit with a stale or wrongly-placed membership pin is the exact ` +
              `half-applied state this path exists to prevent. A human must apply the edit ` +
              `and re-pin by hand, or repair the pin file's structure.`,
            stamp,
          ),
        touchedFiles,
      );
      o.action = "needs-human-repin";
      o.detail = `${o.detail} — NOT APPLIED: ${detail} (${notePath})`;
    }
    return { ok: false, reason: SyncCoreReason.NEEDS_HUMAN, detail, outcomes, skipped };
  };

  let readPin: (() => string) | undefined;
  let writePin: ((text: string) => void) | undefined;
  let pinBefore: string | null = null;
  if (repins.size > 0) {
    readPin = deps.readLogicPinSource;
    writePin = deps.writeLogicPinSource;
    if (!readPin || !writePin) {
      return refuseRepin(
        `a classification was approved but this caller cannot re-pin ` +
          `${LOGIC_PIN_REL_PATH} — refusing to leave the registry edited with a stale pin`,
      );
    }
    pinBefore = readPin();
    let next = pinBefore;
    for (const [key, { listName, provider, families }] of repins) {
      const base =
        listName === "includeFamilies" ? includeFamilies[provider] : excludeFamilies[provider];
      // The compiled module holds the PRE-edit membership; the families this run
      // applied are exactly the delta. Each one is already a normalized family
      // key (it came out of the same normalizer the registry's familySet uses),
      // so re-normalizing it is a no-op and this reproduces the post-edit set.
      const members = [...base, ...families];
      const edit = updateDataFrozenPin(next, key, computeMembershipPin(members));
      if (edit.locatorMiss) {
        return refuseRepin(
          `could not locate the DATA_FROZEN pin for "${key}" in ${LOGIC_PIN_REL_PATH} — ` +
            `the pin file's structure changed; a human must re-pin by hand`,
        );
      }
      next = edit.text;
    }
    logicPinSource = next;
  }

  deps.writeRegistrySource(registrySource);
  if (logicPinSource !== null) {
    writePin!(logicPinSource);
    touchedFiles.add(LOGIC_PIN_REL_PATH);
    // THE WRITER'S HALF OF THE PIN-FILE CONTRACT, checked against WHAT LANDED,
    // by reading the file back — not against the text we meant to write. An
    // in-memory check of our own rewrite can only ever agree with itself (the
    // version this replaces could not return false from its one production call
    // site, and mutating that call site to `if (false)` left the suite green);
    // re-reading makes the guard answer a question it could actually fail.
    // `drift-sync-check` gate-1b re-derives the same predicate from the git diff,
    // keyed to SYNC_REPINNABLE_KEYS, so the constraint does not depend on this
    // check being here.
    const landed = readPin!();
    const pinEdit = verifyPinFileEdit(pinBefore!, landed, new Set(repins.keys()));
    if (!pinEdit.ok) {
      deps.revertFiles([...touchedFiles]);
      return refuseRepin(
        `${LOGIC_PIN_REL_PATH} as WRITTEN is not a clean membership re-pin ` +
          `(${pinEdit.detail}) — reverted`,
      );
    }
  }
  const skipReason = gate3SkipReason(outcomes);
  const verdict = deps.runSyncCheck(
    skipReason !== null
      ? { skipRecollect: true, skipRecollectReason: skipReason }
      : { skipRecollect: false },
  );
  if (!verdict.ok) {
    deps.revertFiles([...touchedFiles]);
    return {
      ok: false,
      reason: SyncCoreReason.GATE_FAILED,
      detail: `drift-sync-check rejected the sync [${verdict.reason}]: ${verdict.detail} — reverted`,
      outcomes,
      skipped,
    };
  }

  return {
    ok: !anyNeedsHuman,
    reason: anyNeedsHuman ? SyncCoreReason.NEEDS_HUMAN : SyncCoreReason.OK_APPLIED,
    detail: anyNeedsHuman
      ? "mechanical sync applied (drift-sync-check allowlist + pin passed); one or more " +
        "families still need human review"
      : "mechanical sync applied and drift-sync-check passed",
    outcomes,
    skipped,
  };
}

// ---------------------------------------------------------------------------
// CLI — real deps (live fetch, real fs, real git, C5's real gate). NO LLM,
// no `@anthropic-ai/claude-code` spawn, no free-form code generation anywhere
// in this path.
// ---------------------------------------------------------------------------

const REGISTRY_ABS_PATH = resolve(MODEL_REGISTRY_REL_PATH);
const LOGIC_PIN_ABS_PATH = resolve(LOGIC_PIN_REL_PATH);

const LIVE_MODEL_ENV_KEY: Record<Provider, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GOOGLE_API_KEY",
};

const LIVE_MODEL_LISTERS: Record<Provider, (apiKey: string) => Promise<string[]>> = {
  openai: listOpenAIModels,
  anthropic: listAnthropicModels,
  gemini: listGeminiModels,
};

// ---------------------------------------------------------------------------
// UNUSABLE-CREDENTIAL SKIPS, AND THE MACHINE LINE THAT REPORTS THEM.
//
// An unusable credential is not an error here, it is a SKIP: with every provider
// skipped the core has no live listing to diff, so it reports ok-no-churn and
// exits 0 — byte-for-byte identical to a genuinely quiet day. `fix-drift.yml`
// breaks that encoding collision by reclassifying the run, and it needs to know
// WHICH skips mean "the credential is unusable" (a persistent misconfiguration a
// human must fix) rather than "transient, it will resolve itself".
//
// That classification lives HERE, next to the strings it classifies, and is
// published as a machine line — `unchecked-providers=<csv>` — alongside
// `reason=` and `changeset-key=`. The workflow used to instead grep the
// human-facing `  [skipped] …` log prose, which made a fail-closed safety guard
// depend on an indent, a wording and an em-dash in a `console.log`: rewording
// this file turned that guard silently off. The two prose fragments below are
// each written ONCE and read by both the builder and the classifier, so a
// reword cannot make the emitter and the detector disagree.
// ---------------------------------------------------------------------------

/** The one copy of the "no credential at all" wording. */
const MISSING_KEY_SKIP_MARKER = "not set — skipping live sync for";
/** The one copy of the "the live listing itself faulted" wording (status follows). */
const INFRA_SKIP_MARKER = "infra error (status ";
/**
 * The one copy of the "the listing came back, but too short to believe" wording —
 * read by `detectDeprecatedFamiliesForSync`, which writes the reason.
 */
export const LISTING_UNTRUSTED_SKIP_MARKER = "live /models listing too short to trust";

/** The skip reason a provider with NO credential configured gets. */
export function missingKeySkipReason(envKey: string, provider: Provider): string {
  return `${envKey} ${MISSING_KEY_SKIP_MARKER} ${provider}`;
}

/** The skip reason a provider whose live `/models` fetch faulted gets. */
export function infraSkipReason(status: number, provider: Provider): string {
  return `${INFRA_SKIP_MARKER}${status}) fetching live /models for ${provider} — never mass-removing off a failed listing`;
}

/**
 * Does this skip reason mean the provider had a MOMENT — something that resolves
 * on its own and must never red an unattended daily cron?
 *
 * This is the ONLY tolerated class, and it is an explicit ALLOWLIST: a 429, or a
 * 5xx from the provider's own `/models` endpoint. `isInfraSkip` absorbs exactly
 * those plus 401/402/403.
 */
export function isTransientSkip(reason: string): boolean {
  if (!reason.startsWith(INFRA_SKIP_MARKER)) return false;
  const status = Number.parseInt(reason.slice(INFRA_SKIP_MARKER.length), 10);
  if (!Number.isInteger(status)) return false;
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Does this skip mean the provider's drift was never actually CHECKED, so "no
 * churn" for it means "could not look"?
 *
 * FAIL-CLOSED BY CONSTRUCTION, and that is the whole point. This used to be the
 * other way round — an ALLOWLIST of two recognised faults (a missing key, and an
 * `infra error (status 40[123])`) with `return false` for everything else. So
 * every skip class the allowlist did not name was silently reported as "checked
 * fine", and there was a third one: `detectDeprecatedFamiliesForSync` skips the
 * whole deprecation half when the live listing comes back SHORTER than the number
 * of families aimock mocks for that provider — a provider whose API changed shape,
 * or a partial/truncated response. That skip left `unchecked-providers=` EMPTY, so
 * `fix-drift.yml` read the run as a quiet day: green, no alert, and deprecations
 * for that provider never checked again for as long as the truncation lasted.
 * The `input.skipReason ?? "live listing unavailable"` fallback in the core loop
 * fell through the same hole.
 *
 * Inverted rather than extended by one more case, because extending it leaves the
 * NEXT skip class invisible in exactly the same way. Now a class has to be
 * deliberately named TRANSIENT to be tolerated, and an unrecognised reason —
 * including one added by a future change to this file — reclassifies the run
 * instead of passing silently. An UNKNOWN must not collapse into the answer that
 * passes; that is the same rule the workflow's own absent-line and unreadable-log
 * branches follow.
 */
export function isProviderUncheckedSkip(reason: string): boolean {
  return !isTransientSkip(reason);
}

/** The machine line `fix-drift.yml` greps to tell "nothing changed" from "could not look". */
export const UNCHECKED_PROVIDERS_LINE_PREFIX = "unchecked-providers=";

/**
 * `unchecked-providers=<csv>` for this run — the providers whose drift this run
 * did not actually check, for any reason that is not a transient blip.
 *
 * Emitted UNCONDITIONALLY (empty csv on a healthy run) so that the line's ABSENCE
 * is itself a detectable fault rather than being indistinguishable from "no
 * provider was skipped". The per-provider REASON is not encoded here — the
 * human-facing `  [skipped] <provider>: <reason>` lines in the same log (uploaded
 * as the drift-sync-log artifact) carry it, and keeping this line a bare CSV is
 * what lets the workflow's grep stay pinned and trivial.
 */
export function formatUncheckedProvidersLine(
  skipped: readonly { provider: string; reason: string }[],
): string {
  const unchecked = skipped.filter((s) => isProviderUncheckedSkip(s.reason)).map((s) => s.provider);
  return `${UNCHECKED_PROVIDERS_LINE_PREFIX}${[...new Set(unchecked)].sort().join(",")}`;
}

/** Fetch one provider's live `/models` ids, or an honest skip (no key / infra error). */
export async function fetchProviderChurnInput(provider: Provider): Promise<ProviderChurnInput> {
  const envKey = LIVE_MODEL_ENV_KEY[provider];
  const apiKey = process.env[envKey];
  if (!apiKey) {
    return {
      provider,
      liveModelIds: null,
      skipReason: missingKeySkipReason(envKey, provider),
    };
  }
  try {
    const liveModelIds = await LIVE_MODEL_LISTERS[provider](apiKey);
    return { provider, liveModelIds };
  } catch (err: unknown) {
    if (err instanceof InfraError && isInfraSkip(err.status)) {
      return {
        provider,
        liveModelIds: null,
        skipReason: infraSkipReason(err.status, provider),
      };
    }
    throw err;
  }
}

/** True when `relPath` is tracked by git (`git ls-files --error-unmatch` exits 0). */
function isTrackedByGit(relPath: string): boolean {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", relPath], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Revert every file in `relPaths` to its pre-sync state after a failed gate.
 *
 * D-M2: `git checkout -- <path>` THROWS on a freshly-written UNTRACKED note file
 * ("did not match any file(s) known to git") — and when the set mixes tracked
 * and untracked paths, a single `git checkout --` of all of them reverts
 * NOTHING and throws uncaught, exiting the sync 1. So partition the set:
 * `git checkout --` restores tracked files (e.g. the registry edit), and each
 * untracked file (a note git never knew) is simply deleted — the correct
 * "revert" for a file that did not exist before this run. Never throws on the
 * untracked case.
 */
export function revertSyncFiles(relPaths: string[]): void {
  if (relPaths.length === 0) return;
  const tracked: string[] = [];
  const untracked: string[] = [];
  for (const p of relPaths) {
    (isTrackedByGit(p) ? tracked : untracked).push(p);
  }
  if (tracked.length > 0) {
    execFileSafe("git", ["checkout", "--", ...tracked]);
  }
  for (const p of untracked) {
    rmSync(resolve(p), { force: true });
  }
}

const REAL_SYNC_CORE_DEPS: SyncCoreDeps = {
  readRegistrySource: () => readFileSync(REGISTRY_ABS_PATH, "utf-8"),
  writeRegistrySource: (text: string) => writeFileSync(REGISTRY_ABS_PATH, text, "utf-8"),
  readLogicPinSource: () => readFileSync(LOGIC_PIN_ABS_PATH, "utf-8"),
  writeLogicPinSource: (text: string) => writeFileSync(LOGIC_PIN_ABS_PATH, text, "utf-8"),
  readProposalNote: (relPath: string) => {
    const abs = resolve(relPath);
    return existsSync(abs) ? readFileSync(abs, "utf-8") : null;
  },
  writeProposalNote: (relPath: string, text: string) => {
    const abs = resolve(relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text, "utf-8");
  },
  runSyncCheck: (opts) => {
    const verdict = evaluateSyncCheck(
      {
        getChangedFiles,
        readCommittedPinFile: () => readCommittedFile(LOGIC_PIN_REL_PATH),
        readWorkingPinFile: () => readFileSync(LOGIC_PIN_ABS_PATH, "utf-8"),
        runPinCheck: () => runPinCheck(),
        recollect: () => recollect(),
      },
      {
        skipRecollect: opts?.skipRecollect,
        skipRecollectReason: opts?.skipRecollectReason,
      },
    );
    return { ok: verdict.ok, reason: verdict.reason, detail: verdict.detail };
  },
  revertFiles: revertSyncFiles,
};

/**
 * A stable, date-independent identity of a run's changeset, used by the CI
 * workflow (`fix-drift.yml`) to de-duplicate PRs across daily re-fires in
 * EVERY run shape.
 *
 * The key is derived from the SORTED set of every non-`no-op` family outcome
 * (`<action>:<provider>/<family>`) — the mechanical registry edits AND the
 * families deferred to a human alike — so it is byte-identical on every re-fire
 * of the same underlying drift (same families, same actions), independent of
 * the date-stamped comment text inside the registry edit or the CI run id in
 * the branch name.
 *
 * WHY not key on the committed note-file paths alone (the workflow's older
 * approach): the D-M1 "mixed run" (a mechanical registry edit for family X
 * committed the SAME run a *different* family Y is deferred to a human, Y's
 * note already sitting on `main` from a prior run) commits ONLY the registry
 * edit — no `drift-proposals/*` file — so a note-path key is EMPTY and the
 * dedup is bypassed, re-opening a near-identical PR every daily cron run
 * (unbounded PR-spam). The outcome-derived key is non-empty here (it carries
 * both `deprecation-recorded:anthropic/X` and `needs-human-…:gemini/Y`) and
 * identical on every re-fire, so the workflow can find the already-open PR and
 * skip.
 *
 * A 16-hex-char SHA-256 prefix is used as the marker token: fixed-length, so
 * two distinct changesets can never be substring-confused in the PR-body
 * `contains()` match. Returns `""` when nothing was applied or deferred.
 */
export function computeChangesetKey(outcome: SyncCoreOutcome): string {
  const entries = outcome.outcomes
    .filter((o) => o.action !== "no-op")
    .map((o) => `${o.action}:${o.provider}/${o.family}`)
    .sort();
  if (entries.length === 0) return "";
  return createHash("sha256").update(entries.join("\n")).digest("hex").slice(0, 16);
}

/**
 * commitlint's `header-max-length` (and its `body-max-line-length` companion),
 * both 100 in `@commitlint/config-conventional`, which this repo extends.
 * Mirrored here as a constant because the sync bot's commit is authored by CI
 * with no human in the loop: a header over the limit fails the `commitlint`
 * check on the bot's own PR, which then can NEVER merge without a human
 * rewriting the message — defeating the automation entirely.
 */
export const COMMIT_LINE_MAX_LENGTH = 100;

const SYNC_COMMIT_SUBJECT_PREFIX = "fix(drift-sync): mechanical model-family sync";

/**
 * Hard-wrap `text` to `max` columns, breaking at a space where one exists in
 * range and hard-breaking an over-long unbreakable token otherwise. Lossless —
 * every character survives, only whitespace is re-flowed — so the per-family
 * detail stays greppable in the log while every emitted line satisfies
 * `body-max-line-length`.
 */
function wrapToWidth(text: string, max: number): string[] {
  const out: string[] = [];
  for (const paragraphLine of text.split("\n")) {
    let rest = paragraphLine;
    if (rest.length === 0) {
      out.push("");
      continue;
    }
    while (rest.length > max) {
      const breakAt = rest.lastIndexOf(" ", max);
      const cut = breakAt > 0 ? breakAt : max;
      out.push(rest.slice(0, cut));
      rest = rest.slice(breakAt > 0 ? cut + 1 : cut);
    }
    if (rest.length > 0) out.push(rest);
  }
  return out;
}

/**
 * Build the sync bot's commit message: a subject BOUNDED at
 * `COMMIT_LINE_MAX_LENGTH` for ANY number of changes, plus a body carrying the
 * full per-family detail (the body has no length limit beyond per-line width,
 * so nothing is lost).
 *
 * WHY the subject summarizes rather than enumerates: it used to interpolate
 * every `<action> <provider>/<family>` pair, so it grew without bound with the
 * changeset — a real ten-deprecation run (CI run 31225520102, PR #366) produced
 * a 525-character header and a `commitlint` failure the bot cannot clear on its
 * own. It degrades by COUNT, not by characters: a chopped-off list would sever
 * its own trailing `)` mid-token and read as garbage, whereas "N families:
 * <providers>" stays true and legible at every size. The provider list itself
 * collapses to a count if naming every provider would ever breach the bound, so
 * the guarantee holds structurally, not by slicing.
 */
export function buildSyncCommitMessage(outcome: SyncCoreOutcome): {
  subject: string;
  body: string;
} {
  const applied = outcome.outcomes.filter(
    (o) => o.action === "added" || o.action === "excluded" || o.action === "deprecation-recorded",
  );
  if (applied.length === 0) {
    return { subject: `${SYNC_COMMIT_SUBJECT_PREFIX} (needs-human note file(s))`, body: "" };
  }

  const count = `${applied.length} ${applied.length === 1 ? "family" : "families"}`;
  const providers = [...new Set(applied.map((o) => o.provider))].sort();
  // Widest-first, each fallback strictly shorter than the last. The final form
  // is `<prefix> (<count>)` — 48 characters plus a decimal array length, which
  // cannot approach 100 — so SOME candidate always satisfies the bound.
  const candidates = [
    `${SYNC_COMMIT_SUBJECT_PREFIX} (${count}: ${providers.join(", ")})`,
    `${SYNC_COMMIT_SUBJECT_PREFIX} (${count} across ${providers.length} providers)`,
    `${SYNC_COMMIT_SUBJECT_PREFIX} (${count})`,
  ];
  const subject =
    candidates.find((c) => c.length <= COMMIT_LINE_MAX_LENGTH) ?? candidates[candidates.length - 1];

  const body = applied
    .flatMap((o) => wrapToWidth(`- ${o.action} ${o.provider}/${o.family}`, COMMIT_LINE_MAX_LENGTH))
    .join("\n");
  return { subject, body };
}

/** Stage + commit exactly the sync core's own touched files (never a catch-all `git add`). */
function commitSyncChanges(outcome: SyncCoreOutcome): boolean {
  const changed = getChangedFiles().filter(
    (f) =>
      f === MODEL_REGISTRY_REL_PATH ||
      f === LOGIC_PIN_REL_PATH ||
      f.startsWith(`${DRIFT_PROPOSALS_DIR}/`),
  );
  if (changed.length === 0) return false;
  const { subject, body } = buildSyncCommitMessage(outcome);
  execFileSafe("git", ["add", ...changed]);
  execFileSafe("git", ["commit", ...(body ? ["-m", subject, "-m", body] : ["-m", subject])]);
  return true;
}

/** Run the full CLI: fetch every provider's live listing, sync, commit. Never invokes an LLM. */
export async function runDriftSyncCli(
  providers: Provider[] = ["openai", "anthropic", "gemini"],
): Promise<number> {
  const inputs = await Promise.all(providers.map(fetchProviderChurnInput));
  const outcome = runDriftSyncCore(inputs, REAL_SYNC_CORE_DEPS);

  console.log(outcome.detail);
  for (const o of outcome.outcomes) {
    console.log(`  [${o.action}] ${o.provider}/${o.family}: ${o.detail}`);
  }
  for (const s of outcome.skipped) {
    console.log(`  [skipped] ${s.provider}: ${s.reason}`);
  }

  if (
    outcome.reason === SyncCoreReason.OK_APPLIED ||
    outcome.outcomes.some((o) => o.action.startsWith("needs-human-"))
  ) {
    commitSyncChanges(outcome);
  }

  // MACHINE line, printed unconditionally so its absence is a detectable fault:
  // which providers were never actually checked because their credential is
  // unusable. `fix-drift.yml` keys its stale-key preflight on this instead of on
  // the human-facing `  [skipped] …` prose above.
  console.log(formatUncheckedProvidersLine(outcome.skipped));
  console.log(`reason=${outcome.reason}`);
  // Stable, date-independent identity of this run's changeset — the workflow
  // greps this to de-dup PRs across daily re-fires in EVERY shape (including
  // the mixed run that commits a registry edit but no new note file, where a
  // note-path-only key would be empty). See computeChangesetKey.
  console.log(`changeset-key=${computeChangesetKey(outcome)}`);
  return outcome.ok ? 0 : 1;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === resolve(entry);
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  runDriftSyncCli()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error("drift-sync fatal error:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
