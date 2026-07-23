/**
 * Shared types for the drift remediation pipeline.
 *
 * Used by both drift-report-collector.ts and drift-sync.ts.
 */

/**
 * NOTE: DriftSeverity is intentionally defined in multiple places:
 *   1. Here (drift-types.ts) — canonical source, used by the pipeline scripts
 *   2. src/__tests__/drift/schema.ts — used by the drift test framework (ShapeDiff)
 *   3. src/__tests__/drift-collector.test.ts — local copy for the test helper
 *
 * Deduplication would require importing across component boundaries.
 * If you add a new severity level, update all three locations.
 */
export type DriftSeverity = "critical" | "warning" | "info";

/**
 * Coarse drift-classification enum used by the delta/summary layers to route a
 * report to the right terminal outcome (block vs advisory vs quarantine). It is
 * orthogonal to per-diff `DriftSeverity`: a report is `Quarantine` when its
 * findings could not be trusted (unparseable / unmapped surface), independent of
 * whether individual diffs were `critical`. Purely additive — existing consumers
 * that never read `class` are unaffected.
 */
export enum DriftClass {
  /** At least one critical, trustworthy drift finding — hard failure. */
  Critical = "critical",
  /** Non-critical, informational drift — advisory only. */
  Advisory = "advisory",
  /**
   * A failure that could not be parsed/mapped into a trustworthy drift finding.
   * Neither a clean pass nor a confirmed critical — held aside for human review
   * so it is never silently swallowed as a green.
   */
  Quarantine = "quarantine",
  /** No drift detected. */
  None = "none",
}

export interface ParsedDiff {
  path: string;
  severity: DriftSeverity;
  issue: string;
  expected: string;
  real: string;
  mock: string;
  /**
   * Optional stable per-item key (e.g. a model id) used by the delta layer to
   * key findings by provider+id. Absent on legacy diffs.
   */
  id?: string;
  /** Optional coarse classification for this diff. Absent on legacy diffs. */
  class?: DriftClass;
}

/**
 * A test failure that could not be parsed into a trustworthy drift finding and
 * was NOT positively classified as benign infrastructure. Rather than crash the
 * collector (exit 1) or silently drop the failure (exit 0), the failure is
 * captured here so it can surface as a distinct quarantine outcome (exit 5) for
 * human review.
 */
export interface QuarantineEntry {
  /** Provider inferred from the failing assertion, or a best-effort label. */
  provider: string;
  /** The failing test's name (ancestor titles + title). */
  testName: string;
  /**
   * Raw `file:line` captured from the original stack frame BEFORE stack-frame
   * stripping, so the human reviewer can locate the failing assertion. Empty
   * string when no frame was available.
   */
  rawLocation: string;
  /** The (possibly truncated) failure message that could not be parsed. */
  message: string;
}

export interface DriftEntry {
  provider: string;
  scenario: string;
  builderFile: string;
  builderFunctions: string[];
  typesFile: string | null;
  sdkShapesFile: string;
  diffs: ParsedDiff[];
}

export interface DriftReport {
  timestamp: string;
  /**
   * ISO-8601 alias of `timestamp`, written so the base-report reuse guard
   * (`isBaseReportReusable` via `test-drift.yml`) can read `report.generatedAt`.
   * `timestamp` is retained for back-compat with existing consumers
   * (drift-slack-summary.ts, etc.). Absent on legacy reports.
   */
  generatedAt?: string;
  /**
   * Coarse run outcome derived from the collector exit code
   * (0→"clean", 2→"critical", 5→"quarantine"), written so the reuse guard can
   * read `report.conclusion` instead of relying solely on the CI run
   * conclusion. Absent on legacy reports.
   */
  conclusion?: string;
  entries: DriftEntry[];
  /**
   * Optional list of failures held aside for human review (see QuarantineEntry).
   * Absent/empty when there was nothing to quarantine — legacy consumers that
   * ignore this field are unaffected.
   */
  quarantine?: QuarantineEntry[];
}
