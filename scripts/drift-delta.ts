/**
 * Delta-gating core for the drift pipeline.
 *
 * A PR-scoped drift run produces a HEAD report; a same-UTC-day cached MAIN run
 * produces a BASE report. The gate must only BLOCK on drift that is attributable
 * to the diff under review — a drift already present on main (environmental /
 * world drift) is the daily job's concern, NOT the PR's. This module reduces the
 * two reports to a per-key delta:
 *
 *   - block    → keys NEW in head (absent from base): diff-attributable, hard fail
 *   - advisory → keys present in BOTH base and head: pre-existing / environmental
 *   - fixed    → keys present in base but GONE in head: informational
 *
 * The block/advisory/fixed decision is driven ENTIRELY by key presence. The
 * coarse `DriftClass` (critical/advisory/quarantine) is annotation only and NEVER
 * enters the routing decision — a new-in-head *critical* still BLOCKS, and a
 * both-present *critical* is still only ADVISORY. This is the #292 invariant: a
 * real-drift/critical finding that is new in head must block regardless of class.
 *
 * Pure and side-effect-free — no filesystem, no network, no process state.
 */

import type { DriftClass, DriftReport } from "./drift-types.js";

/**
 * A single failure identified by the delta layer.
 *
 * A failure is keyed by `provider` + per-item `id` (NOT `path`, which is a
 * generic bucket like `"knownModels"` that would collapse N distinct model
 * drifts into one key). `class` is carried through purely for annotation and
 * never participates in routing.
 */
export interface DeltaKey {
  /** Provider the failing entry belongs to (e.g. "anthropic"). */
  provider: string;
  /** Stable per-item key (e.g. a model id). Falls back to path when absent. */
  id: string;
  /** Coarse classification — annotation only, never routes block vs advisory. */
  class?: DriftClass;
}

/** The delta between a base (main) report and a head (PR) report. */
export interface DeltaResult {
  /** New-in-head failures — diff-attributable, hard fail. */
  block: DeltaKey[];
  /** Failures present in both base and head — pre-existing / environmental. */
  advisory: DeltaKey[];
  /** Failures present in base but gone in head — informational. */
  fixed: DeltaKey[];
}

/**
 * Build the canonical string key for a failure. Keys by provider + per-item id.
 * When a diff has no `id` (legacy diffs), fall back to its `path` so it still
 * participates in the delta rather than being dropped — this is a coarse bucket
 * but preserves the block/advisory distinction across reports.
 */
function keyOf(provider: string, id: string): string {
  return `${provider}::${id}`;
}

/**
 * Flatten a report into a map of `key → DeltaKey`. When multiple diffs collapse
 * to the same key, the last one wins for annotation purposes (the routing
 * decision does not depend on which representative is retained).
 */
function indexReport(report: DriftReport): Map<string, DeltaKey> {
  const index = new Map<string, DeltaKey>();
  for (const entry of report.entries) {
    for (const diff of entry.diffs) {
      // `id` is the stable per-item key; `path` is the legacy fallback bucket.
      const id = diff.id ?? diff.path;
      const key = keyOf(entry.provider, id);
      index.set(key, { provider: entry.provider, id, class: diff.class });
    }
  }
  return index;
}

/**
 * Compute the delta between a base report and a head report.
 *
 * Routing is by KEY PRESENCE only:
 *   - key in head but not base → block (new-in-head, diff-attributable)
 *   - key in both              → advisory (pre-existing / environmental)
 *   - key in base but not head → fixed (informational)
 *
 * `DriftClass` NEVER enters this decision — a new-in-head critical blocks, a
 * both-present critical is advisory. See the module docstring (#292 invariant).
 */
export function computeDelta(baseReport: DriftReport, headReport: DriftReport): DeltaResult {
  const base = indexReport(baseReport);
  const head = indexReport(headReport);

  const block: DeltaKey[] = [];
  const advisory: DeltaKey[] = [];
  const fixed: DeltaKey[] = [];

  for (const [key, headKey] of head) {
    if (base.has(key)) {
      advisory.push(headKey);
    } else {
      block.push(headKey);
    }
  }

  for (const [key, baseKey] of base) {
    if (!head.has(key)) {
      fixed.push(baseKey);
    }
  }

  return { block, advisory, fixed };
}

/**
 * Known-good collector conclusions that make a cached base report trustworthy to
 * reuse. Anything else (crash, quarantine, unknown) means the base is not a
 * reliable baseline and a fresh live base run should be preferred.
 */
const REUSABLE_CONCLUSIONS: ReadonlySet<string> = new Set(["clean", "success"]);

/**
 * Guard (O-2) for reusing a cached same-UTC-day main report as the delta base.
 *
 * A base report is reusable only when ALL of:
 *   1. it has a non-empty `entries[]` (rejects empty / malformed cached JSON),
 *   2. its collector `conclusion` is known-good (rejects crash / quarantine),
 *   3. it was produced on the same UTC day (`sameUtcDay`) — a stale baseline
 *      would misattribute a day's worth of environmental drift to the PR.
 *
 * Anything else → not reusable → caller should run a fresh live base.
 */
export function isBaseReportReusable(
  report: DriftReport | null | undefined,
  conclusion: string | null | undefined,
  sameUtcDay: boolean,
): boolean {
  if (!report || !Array.isArray(report.entries) || report.entries.length === 0) {
    return false;
  }
  if (!conclusion || !REUSABLE_CONCLUSIONS.has(conclusion)) {
    return false;
  }
  return sameUtcDay === true;
}
