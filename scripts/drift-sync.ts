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

import { evaluateSyncCheck, runPinCheck, recollect } from "./drift-sync-check.js";
import type { DriftReport, DriftSeverity } from "./drift-types.js";

import { normalizeModelFamily } from "../src/__tests__/drift/model-family.js";
import {
  includeFamilies,
  isClassifiedFamily,
  NON_MODEL_TOKENS,
} from "../src/__tests__/drift/model-registry.js";
import {
  isFamilyStillReferenced,
  isForwardLookingFamily,
} from "../src/__tests__/drift/deprecation-detector.js";
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
    // The description is the first non-empty, non-heading, non-badge, non-video line
    const lines = readme.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (
        !trimmed ||
        trimmed.startsWith("#") ||
        trimmed.startsWith("[![") ||
        trimmed.startsWith("![") ||
        trimmed.startsWith("[") ||
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
//     listing no longer contains.
//       * zero-reference (nothing in aimock's own source still names it) →
//         mechanical, comment-marked removal from `includeFamilies`.
//       * still-referenced → NEVER auto-removed. Routed to a human via a
//         family-keyed dedup note file under `drift-proposals/`.
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
    minListingSize?: number;
  } = {},
): DeprecationCheckResult {
  const classified = includeFamilies[provider];
  const floor = opts.minListingSize ?? classified.size;

  if (liveModelIds.length === 0 || liveModelIds.length < floor) {
    return {
      status: "skipped",
      reason:
        `live /models listing too short to trust for ${provider} ` +
        `(${liveModelIds.length} raw id(s), need >= ${floor} — the number of ` +
        `families aimock mocks for this provider) — never mass-removing off a ` +
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
  const missing = [...classified]
    .filter((family) => !liveFamilies.has(family))
    .filter((family) => !isForwardLookingFamily(family, provider))
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

export type ProposalKind =
  | "new-family"
  | "still-referenced-deprecation"
  | "registry-structural-mismatch";
export type ProposalDecision = "pending" | "include";

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
        : "deprecated-referenced";
  return `${DRIFT_PROPOSALS_DIR}/${provider}-${slug}-${kindSlug}.md`;
}

/** Parse the note's `Decision:` line. Defaults to "pending" (fail-closed — never infers approval). */
export function parseProposalDecision(noteText: string): ProposalDecision {
  const m = noteText.match(/^Decision:\s*(\S+)/m);
  return m && m[1].toLowerCase() === "include" ? "include" : "pending";
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
        : "Deprecated-but-still-referenced model family";
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
      "<!-- drift-sync never auto-classifies a new family. To approve adding it to",
      "     the registry, change the line below to `Decision: include` — the NEXT",
      "     drift-sync run will then apply the mechanical registry edit (still",
      "     zero-LLM: this is a human-authored decision, not generated code). -->",
      "Decision: pending",
      "",
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Mechanical registry edits — AST-LOCATED (via the real TypeScript parser, not
// a hand-rolled regex/lexer scan) then applied as a single-line text splice.
// The parser is used only to unambiguously find the exact line of the exact
// string-literal element inside `includeFamilies[provider]` /
// `excludeFamilies[provider]`'s array literal (or the array's closing-bracket
// line, for an insert) — the mutation itself is a trivial whole-line
// replace/insert, never a partial-token or multi-line reformat, so it cannot
// silently mangle an adjacent grouping comment or a sibling entry.
// ---------------------------------------------------------------------------

export const MODEL_REGISTRY_REL_PATH = "src/__tests__/drift/model-registry.ts";

type RegistrySetName = "includeFamilies" | "excludeFamilies";

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
  let elementIndent = "    ";
  for (const el of target.elements) {
    if (ts.isStringLiteral(el)) {
      const { line, character } = sf.getLineAndCharacterOfPosition(el.getStart(sf));
      elementLines.set(el.text, line);
      elementIndent = " ".repeat(character);
    }
  }
  const { line: arrayEndLine } = sf.getLineAndCharacterOfPosition(target.getEnd());
  return { elementLines, arrayEndLine, elementIndent };
}

export interface RegistryEditResult {
  changed: boolean;
  text: string;
  detail: string;
  /**
   * True when the AST locator could NOT find the target array literal in
   * `model-registry.ts` (structural mismatch). This is distinct from a benign
   * no-op (family already-absent for a remove / already-present for an add):
   * a locator miss means a real add/remove could not be applied and MUST be
   * routed to a human — never collapsed into a silent, clean no-op (G#1).
   */
  locatorMiss?: boolean;
}

/** Comment-marked removal of `family` from `exportName[provider]`. Never touches any other line. */
export function removeFamilyLiteralInSource(
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
  const lineIdx = loc.elementLines.get(family);
  if (lineIdx === undefined) {
    return {
      changed: false,
      text: sourceText,
      detail: `"${family}" is not present in ${exportName}.${provider} — nothing to remove`,
    };
  }
  const lines = sourceText.split("\n");
  const indentMatch = lines[lineIdx].match(/^(\s*)/);
  const indent = indentMatch ? indentMatch[1] : loc.elementIndent;
  lines[lineIdx] = `${indent}// ${reasonComment}`;
  return {
    changed: true,
    text: lines.join("\n"),
    detail: `removed "${family}" from ${exportName}.${provider} (comment-marked)`,
  };
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
  readRegistrySource: () => string;
  writeRegistrySource: (text: string) => void;
  readProposalNote: (relPath: string) => string | null;
  writeProposalNote: (relPath: string, text: string) => void;
  /**
   * Run C5's drift-sync-check gate. `opts.skipRecollect` runs gate-1
   * (allowlist) + gate-2 (pin) but SKIPS gate-3 (the live re-collect) — used
   * when this run applied a mechanical edit AND also deferred a family to a
   * human, so a fresh collector run would still (correctly) see that deferred
   * family as residual critical drift.
   */
  runSyncCheck: (opts?: { skipRecollect?: boolean }) => SyncCheckResultLike;
  /** Revert every file in `relPaths` (e.g. `git checkout -- <paths>`) after a failed gate. */
  revertFiles: (relPaths: string[]) => void;
  now?: () => Date;
}

export type FamilyAction =
  | "removed"
  | "added"
  | "needs-human-new-family"
  | "needs-human-still-referenced"
  | "needs-human-structural-mismatch"
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
    });
    if (dep.status === "skipped") {
      skipped.push({ provider: input.provider, reason: dep.reason });
    } else {
      for (const cand of dep.candidates) {
        if (!cand.stillReferenced) {
          const edit = removeFamilyLiteralInSource(
            registrySource,
            "includeFamilies",
            cand.provider,
            cand.family,
            `REMOVED ${stamp} (drift-sync): "${cand.family}" no longer in live /models, zero-reference`,
          );
          if (edit.changed) {
            registrySource = edit.text;
            registryChanged = true;
            outcomes.push({
              provider: cand.provider,
              family: cand.family,
              action: "removed",
              detail: edit.detail,
            });
          } else if (edit.locatorMiss) {
            // G#1: the AST locator could not find includeFamilies[provider] in
            // model-registry.ts. A real deprecation could not be applied — this
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
                  `A zero-reference deprecation was detected for "${cand.family}" but drift-sync ` +
                    `could not locate the includeFamilies.${cand.provider} array literal in ` +
                    `${MODEL_REGISTRY_REL_PATH} — the registry's structure changed. A human must ` +
                    `apply the removal (or fix the locator).`,
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
        } else {
          const notePath = proposalNoteRelPath(
            cand.provider,
            cand.family,
            "still-referenced-deprecation",
          );
          ensureProposalNote(
            deps,
            notePath,
            () =>
              renderProposalNote(
                cand.provider,
                cand.family,
                "still-referenced-deprecation",
                "This family no longer appears in the live /models listing, but aimock's " +
                  "own source still references it (builders, DEFAULT_MODELS, or fixtures). " +
                  "drift-sync never silently removes a still-referenced family.",
                stamp,
              ),
            touchedFiles,
          );
          outcomes.push({
            provider: cand.provider,
            family: cand.family,
            action: "needs-human-still-referenced",
            detail: `"${cand.family}" is deprecated but still referenced in source — routed to human (${notePath})`,
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
      if (decision === "include") {
        const edit = addFamilyLiteralInSource(
          registrySource,
          "includeFamilies",
          input.provider,
          family,
          `ADDED ${stamp} (drift-sync): approved via ${notePath}`,
        );
        if (edit.changed) {
          registrySource = edit.text;
          registryChanged = true;
          outcomes.push({
            provider: input.provider,
            family,
            action: "added",
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
                `An approved addition of "${family}" could not be applied: drift-sync could not ` +
                  `locate the includeFamilies.${input.provider} array literal in ` +
                  `${MODEL_REGISTRY_REL_PATH} — the registry's structure changed. A human must ` +
                  `apply the addition (or fix the locator).`,
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
  // intact. Gate-3 (the live re-collect) only makes sense when this run CLAIMS
  // to have fully resolved the drift — i.e. no family was simultaneously
  // deferred to a human. In a mixed run (a valid removal PLUS a family routed
  // to a human), the re-collect would (correctly) still see that deferred
  // family as residual drift and would wrongly revert the valid edit (D-M1,
  // mixed-run leg), so skip gate-3 and report NEEDS_HUMAN with the edit kept.
  deps.writeRegistrySource(registrySource);
  const verdict = deps.runSyncCheck({ skipRecollect: anyNeedsHuman });
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

/** Fetch one provider's live `/models` ids, or an honest skip (no key / infra error). */
export async function fetchProviderChurnInput(provider: Provider): Promise<ProviderChurnInput> {
  const envKey = LIVE_MODEL_ENV_KEY[provider];
  const apiKey = process.env[envKey];
  if (!apiKey) {
    return {
      provider,
      liveModelIds: null,
      skipReason: `${envKey} not set — skipping live sync for ${provider}`,
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
        skipReason: `infra error (status ${err.status}) fetching live /models for ${provider} — never mass-removing off a failed listing`,
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
        runPinCheck: () => runPinCheck(),
        recollect: () => recollect(),
      },
      { skipRecollect: opts?.skipRecollect },
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
 * approach): the D-M1 "mixed run" (a mechanical registry removal of family X
 * committed the SAME run a *different* family Y is deferred to a human, Y's
 * note already sitting on `main` from a prior run) commits ONLY the registry
 * edit — no `drift-proposals/*` file — so a note-path key is EMPTY and the
 * dedup is bypassed, re-opening a near-identical PR every daily cron run
 * (unbounded PR-spam). The outcome-derived key is non-empty here (it carries
 * both `removed:openai/X` and `needs-human-…:gemini/Y`) and identical on every
 * re-fire, so the workflow can find the already-open PR and skip.
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

/** Stage + commit exactly the sync core's own touched files (never a catch-all `git add`). */
function commitSyncChanges(outcome: SyncCoreOutcome): boolean {
  const changed = getChangedFiles().filter(
    (f) => f === MODEL_REGISTRY_REL_PATH || f.startsWith(`${DRIFT_PROPOSALS_DIR}/`),
  );
  if (changed.length === 0) return false;
  const applied = outcome.outcomes.filter((o) => o.action === "removed" || o.action === "added");
  const summary =
    applied.length > 0
      ? applied.map((o) => `${o.action} ${o.provider}/${o.family}`).join(", ")
      : "needs-human note file(s)";
  execFileSafe("git", ["add", ...changed]);
  execFileSafe("git", [
    "commit",
    "-m",
    `fix(drift-sync): mechanical model-family sync (${summary})`,
  ]);
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
