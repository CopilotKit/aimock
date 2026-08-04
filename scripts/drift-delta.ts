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

// `DriftClass` is imported as a VALUE (not `import type`): CLASS_RANK is keyed by
// its members so a new member is a compile error until it is given a rank.
import { DriftClass } from "./drift-types.js";
import type { DriftReport } from "./drift-types.js";

/**
 * A single failure identified by the delta layer.
 *
 * A failure is keyed by `provider` + `scenario` + per-item `id` (NOT `path`,
 * which is a generic bucket like `"knownVoiceModelFamilies"` that would collapse
 * N distinct model drifts into one key). `class` is carried through purely for
 * annotation and never participates in routing.
 *
 * `scenario` is load-bearing: a `DriftEntry` is one provider+scenario pair, and
 * distinct scenarios of the same provider assert overlapping wire shapes — both
 * `openaiChatCompletionShape` (non-streaming text) and the tool-call shape carry
 * `usage.prompt_tokens` (src/__tests__/drift/sdk-shapes.ts). Without it, drift
 * already on main in one scenario ABSORBS a genuinely new drift on the same field
 * in another, and the gate passes silently. See `keyOf`.
 */
export interface DeltaKey {
  /** Provider the failing entry belongs to (e.g. "anthropic"). */
  provider: string;
  /** Scenario within the provider (e.g. "non-streaming tool call"). */
  scenario: string;
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
 * Build the canonical string key for a failure: provider + scenario + per-item id.
 *
 * When a diff has no `id` (legacy diffs), the caller falls back to its `path` so
 * it still participates in the delta rather than being dropped — this is a coarse
 * bucket but preserves the block/advisory distinction across reports.
 *
 * SCENARIO IS PART OF THE KEY. It used to be `provider::id` only, which was
 * fail-SILENT: `id` defaults to the diff's wire `path`, and the same wire path is
 * asserted by several scenarios of one provider. So a base report already drifting
 * on `OpenAI Chat` / `usage.prompt_tokens` in the non-streaming-text scenario made
 * a NEW critical drift on the same field in the tool-call scenario key-identical to
 * it — both-present → `advisory` → the required check PASSED on drift the diff
 * introduced. (Bound: it only bit when the base already carried that exact
 * provider+path; a brand-new field or model id always keyed new and blocked.)
 *
 * JSON-encoded rather than `::`-joined so no separator can appear inside a
 * component: a scenario or id containing the separator would otherwise let two
 * different tuples produce one key — re-creating the collapse this fixes.
 */
function keyOf(provider: string, scenario: string, id: string): string {
  return JSON.stringify([provider, scenario, id]);
}

/**
 * Severity rank for collision resolution. Higher wins. Absent `class` (legacy
 * diffs) ranks lowest so any classified diff is preferred as the representative.
 */
const CLASS_RANK: Readonly<Record<DriftClass, number>> = {
  [DriftClass.Critical]: 4,
  [DriftClass.Quarantine]: 3,
  [DriftClass.Advisory]: 2,
  [DriftClass.None]: 1,
};

function classRank(cls: DriftClass | undefined): number {
  return cls === undefined ? 0 : CLASS_RANK[cls];
}

/**
 * Flatten a report into a map of `key → DeltaKey`.
 *
 * Two diffs can still collide on one key (two assertions in the SAME scenario
 * reporting the same path). That used to be resolved LAST-WINS, which made the
 * retained `class` depend on report order — `[Critical, Advisory]` annotated the
 * key `advisory` and the reversed order annotated it `critical`. Routing never
 * depended on it, but the annotation printed on a blocking key did. The MOST
 * SEVERE class now wins, so the representative is deterministic.
 */
function indexReport(report: DriftReport): Map<string, DeltaKey> {
  const index = new Map<string, DeltaKey>();
  for (const entry of report.entries) {
    for (const diff of entry.diffs) {
      // `id` is the stable per-item key; `path` is the legacy fallback bucket.
      // Changing how a diff keys re-keys it against the origin/main base while the
      // change is unmerged — see the transition note on isBaseReportReusable.
      const id = diff.id ?? diff.path;
      const key = keyOf(entry.provider, entry.scenario, id);
      const existing = index.get(key);
      if (existing !== undefined && classRank(existing.class) >= classRank(diff.class)) {
        continue;
      }
      index.set(key, {
        provider: entry.provider,
        scenario: entry.scenario,
        id,
        class: diff.class,
      });
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
 *
 * There is deliberately NO check that the base report was produced by the SAME
 * collector code as the head report — the base comes from `origin/main`. So while
 * a PR that changes how a diff is keyed is unmerged, base and head key the same
 * drift differently: the base key shows up as `fixed` and the head key as `block`,
 * and a non-empty `block` exits 1 (a hard required-check failure). That is
 * EXPECTED during such a transition, it only fires if real drift appears while the
 * PR is open, and it clears the moment the change reaches main and the next base is
 * collected by the new code.
 *
 * That hazard is specific to changing how the COLLECTOR assigns `diff.id`, because
 * the id is baked into the base report's JSON. It does NOT apply to changing
 * `keyOf`/`indexReport` here: the delta gate imports this module from the PR
 * checkout and indexes BOTH reports with it, so a key-shape change is applied
 * symmetrically and a cached base report stays valid. What must hold is that every
 * key COMPONENT is present in the persisted report — `scenario` is a required
 * `DriftEntry` field the collector always populates (`extractScenario` falls back
 * to the whole context string), so scenario-scoped keys are computable from any
 * base report the reuse guard accepts.
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
