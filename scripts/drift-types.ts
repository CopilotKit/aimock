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

/**
 * A drift leg that graded nothing. Two kinds share this entry:
 *
 *   - SILENT: a live leg that reached its wait timeout having collected ZERO
 *     messages (`timeoutMs`), or whose session the server closed with a
 *     non-refusal code (`serverClose`). Described below.
 *   - OUT OF CREDIT: `providerQuotaExhausted` is set. The provider said the
 *     account has no credit (an HTTP 429 body, an in-band `error` event, a
 *     quota close reason or a refused Live session). Such a leg may be an HTTP
 *     leg, may have observed messages, and may carry neither `timeoutMs` nor
 *     `serverClose`. It is NOT silence: read `providerQuotaExhausted` first.
 *
 * For a SILENT leg:
 *
 * This is a RECOGNIZED failure shape, not unparseable garbage: the probe opened
 * the connection, sent its request, and the live surface then sent nothing back
 * before the wait expired. There is no drift finding to attribute (nothing was
 * observed to compare) and there is nothing about the collector to triage — so it
 * belongs in neither the drift lane nor the quarantine lane.
 *
 * Recorded here so the outcome is REPORTED as what it is (exit 6, conclusion
 * "live-timeout") instead of being funnelled into "unparseable output — manual
 * triage required", which is what made an unreachable live surface a hard,
 * human-gated stop on every drift PR.
 */
export interface TimeoutEntry {
  /** The failing test's name (ancestor titles + title). */
  testName: string;
  /**
   * Raw `file:line` captured from the original stack frame BEFORE stack-frame
   * stripping. Empty string when no frame was available.
   */
  rawLocation: string;
  /**
   * The wait budget that expired, in milliseconds, as reported by the probe.
   * Absent when the leg produced nothing because the server CLOSED the session
   * rather than because a wait ran out — in that case `serverClose` explains it.
   * Absent on an out-of-credit leg (`providerQuotaExhausted`), which did not
   * wait out a budget.
   */
  timeoutMs?: number;
  /**
   * Set when the provider ended the session with an RFC 6455 CLOSE frame whose
   * code does NOT indicate a refusal (see `isRefusalCloseCode`): 1000 normal,
   * 1001 going away, 1011 internal error, 1012/1013 restarting, and so on. The
   * peer stated that it left, not that anything we sent was wrong — so this is a
   * hang-up, not a finding, and it shares the timeout lane's outcome. A REFUSAL
   * code is not recorded here; it becomes an attributed critical drift entry.
   * An out-of-credit leg keeps a non-refusal close here (Realtime's 1013); a
   * refusal close whose reason names a quota code is never recorded here.
   */
  serverClose?: { code: number; reason: string };
  /**
   * Set when the leg failed because the provider account is out of credit
   * (OpenAI `insufficient_quota` / `credit_balance_exhausted`). Infra, like a
   * rate limit or a dead key: nothing was graded and it is never drift. The
   * fix is to top up credit, so the report names the code that said so.
   */
  providerQuotaExhausted?: { code: string };
  /** The full failure message, retained verbatim for the reader. */
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

/**
 * A registry surface that NO live provider leg grades.
 *
 * Emitted so a reader of `drift-report.json` can tell "this surface was checked
 * against the vendor and matched" apart from "this surface was never put in
 * front of the vendor at all". A clean run used to be indistinguishable between
 * the two, which is how the four Bedrock surfaces and Vertex AI read as green
 * while nothing had ever called AWS or Google from this repo.
 *
 * Mirrors `liveCoverage: "none"` entries in `src/__tests__/drift/surface-registry.ts`.
 */
export interface UnverifiedSurface {
  /** Stable surface slug, e.g. `"bedrock-converse"`. */
  surface: string;
  /** Human-readable label, e.g. `"Bedrock Converse"`. */
  provider: string;
  /** Why there is no live leg, and what it would take to get one. */
  note: string;
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
   * (0→"clean", 2→"critical", 5→"quarantine", 6→"live-timeout", or
   * 6→"provider-quota-exhausted" when every ungraded leg was out of credit and
   * none went silent), written so the
   * reuse guard can read `report.conclusion` instead of relying solely on the CI
   * run conclusion. Absent on legacy reports.
   */
  conclusion?: string;
  entries: DriftEntry[];
  /**
   * Optional list of failures held aside for human review (see QuarantineEntry).
   * Absent/empty when there was nothing to quarantine — legacy consumers that
   * ignore this field are unaffected.
   */
  quarantine?: QuarantineEntry[];
  /**
   * Optional list of legs that graded nothing (see TimeoutEntry): live legs
   * that went silent, and legs whose provider account is out of credit
   * (`providerQuotaExhausted` set). Absent/empty on a run where every leg
   * produced output — legacy consumers that ignore this field are unaffected.
   */
  timeouts?: TimeoutEntry[];
  /**
   * Surfaces the run did NOT verify against a live provider (see
   * `UnverifiedSurface`). Always written, including when empty, so "the field
   * is missing" means "an old report", never "everything was verified".
   * Absent on legacy reports.
   */
  unverifiedSurfaces?: UnverifiedSurface[];
}
