/// <reference types="node" />

/**
 * Drift Slack Summary
 *
 * Reads the `drift-report.json` produced by `drift-report-collector.ts` and
 * distills it into a short, scannable Slack mrkdwn summary describing WHICH
 * providers drifted and a brief sense of WHAT changed (severity counts +
 * a few example field paths). The full detail still lives in the uploaded
 * `drift-report` artifact and the "View run" link in the Slack message.
 *
 * The summary is intentionally compact: it lists each drifted provider on its
 * own line with a severity tally and up to a few representative changed paths,
 * capped so the message stays readable in Slack. It is NOT a full dump.
 *
 * CLI usage (in CI):
 *   npx tsx scripts/drift-slack-summary.ts [--in drift-report.json]
 *
 * When `GITHUB_OUTPUT` is set, the summary is emitted as a multiline step
 * output named `drift_summary` (using a randomized heredoc delimiter so the
 * value's own newlines survive). Otherwise it is printed to stdout.
 */

import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readDriftReport } from "./drift-sync.js";
import type { DriftEntry, DriftReport, DriftSeverity } from "./drift-types.js";

// ---------------------------------------------------------------------------
// Headline classification
// ---------------------------------------------------------------------------

/**
 * Closed headline-class enum for a drift run.
 *
 * Derivation priority (highest wins):
 *   stale-key        — InfraError status 401 or 403
 *   infra-transient  — InfraError status 429 or ≥500
 *   quarantine       — report.quarantine[] is non-empty (exit 5)
 *   real-drift       — at least one entry has a critical diff (exit 2)
 *   test-infra-false-positive — everything else (exit 0 / advisory only)
 */
export type HeadlineClass =
  | "real-drift"
  | "test-infra-false-positive"
  | "infra-transient"
  | "stale-key"
  | "quarantine";

/** Optional context the caller may supply to sharpen classification. */
export interface SummarizeOptions {
  /** HTTP status from an InfraError that aborted the run, if any. */
  infraErrorStatus?: number;
  /** Process exit code produced by the collector/retry wrapper, if known. */
  exitCode?: number;
}

function computeHeadlineClass(report: DriftReport, opts: SummarizeOptions): HeadlineClass {
  const { infraErrorStatus } = opts;

  if (infraErrorStatus === 401 || infraErrorStatus === 403) return "stale-key";
  if (infraErrorStatus === 429 || (infraErrorStatus !== undefined && infraErrorStatus >= 500))
    return "infra-transient";

  // Critical drift wins over quarantine — a confirmed critical finding is the
  // actionable signal even when some failures were also quarantined (mirrors the
  // computeExitCode contract: crit→2 wins over quarantine→5).
  const hasCritical = report.entries.some((e) => e.diffs.some((d) => d.severity === "critical"));
  if (hasCritical) return "real-drift";

  const hasQuarantine = (report.quarantine?.length ?? 0) > 0;
  if (hasQuarantine) return "quarantine";

  return "test-infra-false-positive";
}

// Keep the message scannable: cap how many example paths we list per provider
// and how many total providers we enumerate before collapsing to a count.
const MAX_PATHS_PER_PROVIDER = 3;
const MAX_PROVIDERS_LISTED = 8;

const SEVERITY_ORDER: DriftSeverity[] = ["critical", "warning", "info"];

interface ProviderSummary {
  provider: string;
  counts: Record<DriftSeverity, number>;
  /** Ordered list of changed path strings (de-duplicated). */
  paths: string[];
  /** Ordered list of per-diff ids (de-duplicated), when present. */
  ids: string[];
  /** The builderFile from the first matching entry, for the file reference. */
  builderFile: string;
  /** The issue text from the first diff, for one-line context. */
  firstIssue: string;
}

/**
 * Group drift entries by provider, tallying severities and collecting a small,
 * de-duplicated set of representative changed paths and ids.
 */
function summarizeByProvider(entries: DriftEntry[]): ProviderSummary[] {
  const byProvider = new Map<string, ProviderSummary>();

  for (const entry of entries) {
    let summary = byProvider.get(entry.provider);
    if (!summary) {
      summary = {
        provider: entry.provider,
        counts: { critical: 0, warning: 0, info: 0 },
        paths: [],
        ids: [],
        builderFile: entry.builderFile,
        firstIssue: "",
      };
      byProvider.set(entry.provider, summary);
    }
    for (const diff of entry.diffs) {
      summary.counts[diff.severity]++;
      if (diff.id && !summary.ids.includes(diff.id)) {
        summary.ids.push(diff.id);
      }
      if (diff.path && !summary.paths.includes(diff.path)) {
        summary.paths.push(diff.path);
      }
      if (!summary.firstIssue && diff.issue) {
        summary.firstIssue = diff.issue;
      }
    }
  }

  // Stable, deterministic order: most-severe providers first, then by name.
  return [...byProvider.values()].sort((a, b) => {
    if (b.counts.critical !== a.counts.critical) return b.counts.critical - a.counts.critical;
    if (b.counts.warning !== a.counts.warning) return b.counts.warning - a.counts.warning;
    return a.provider.localeCompare(b.provider);
  });
}

/**
 * For a provider summary, return the ordered list of identifiers to use as
 * per-item references in the Slack bullet.
 *
 * When any diff carries a stable `id` (e.g. a model id), prefer those over
 * raw paths — they're more human-readable in a Slack alert. Fall back to paths
 * when no ids are present.
 */
function buildIdOrPaths(s: ProviderSummary): string[] {
  return s.ids.length > 0 ? s.ids : s.paths;
}

/** Format a severity tally like "2 critical, 1 warning" (omitting zeroes). */
function formatCounts(counts: Record<DriftSeverity, number>): string {
  const parts: string[] = [];
  for (const sev of SEVERITY_ORDER) {
    if (counts[sev] > 0) parts.push(`${counts[sev]} ${sev}`);
  }
  return parts.length > 0 ? parts.join(", ") : "0 changes";
}

/**
 * Build the Slack mrkdwn summary lines for the drifted providers.
 *
 * Returns a single string with real `\n` line breaks. The first line is a
 * headline classification (`*Classification:* <class>`), followed by per-item
 * bullets in one of two forms depending on the class:
 *
 *   Real-drift/advisory:
 *     `• *Provider* — 2 critical: \`path.a\`, \`path.b\` (src/helpers.ts)`
 *
 *   Quarantine:
 *     `• [quarantine] Provider — testName (file:line): truncated message`
 *
 * Returns an empty string only when no entries, no quarantine, no InfraError
 * context, and no exitCode hint are present (i.e. caller has nothing to say).
 *
 * The `drift_summary` GITHUB_OUTPUT key is the full return value of this
 * function — callers write it verbatim to `GITHUB_OUTPUT` via writeGithubOutput.
 * Existing consumers that read `steps.summary.outputs.drift_summary` receive
 * the augmented text; they pattern-match on its content (not on internal
 * structure), so the addition of the classification line is backward-compatible.
 */
export function summarizeDriftReport(report: DriftReport, opts: SummarizeOptions = {}): string {
  const headlineClass = computeHeadlineClass(report, opts);

  const summaries = summarizeByProvider(report.entries);
  const quarantine = report.quarantine ?? [];

  // Nothing to say at all — preserve historical empty-string behaviour for a
  // clean run with no context supplied.
  if (
    summaries.length === 0 &&
    quarantine.length === 0 &&
    headlineClass === "test-infra-false-positive" &&
    opts.infraErrorStatus === undefined &&
    opts.exitCode === undefined
  ) {
    return "";
  }

  const lines: string[] = [];

  // ── Headline classification ────────────────────────────────────────────────
  lines.push(`*Classification:* ${headlineClass}`);

  // ── Per-entry drift bullets (real-drift / advisory) ───────────────────────
  if (summaries.length > 0) {
    const shown = summaries.slice(0, MAX_PROVIDERS_LISTED);

    for (const s of shown) {
      // Per-item: prefer id over path when present on the first diff that has one.
      const idOrPaths = buildIdOrPaths(s);
      const exampleRefs = idOrPaths.slice(0, MAX_PATHS_PER_PROVIDER).map((r) => `\`${r}\``);
      const extraRefs = idOrPaths.length - exampleRefs.length;
      let refStr = exampleRefs.join(", ");
      if (extraRefs > 0) refStr += `, +${extraRefs} more`;

      // Per-item: file reference from the entry's builderFile.
      const fileRef = s.builderFile ? ` (${s.builderFile})` : "";

      // Per-item: first one-line issue text.
      const issueStr = s.firstIssue ? ` — _${s.firstIssue}_` : "";

      const counts = formatCounts(s.counts);
      lines.push(
        refStr
          ? `• *${s.provider}* — ${counts}: ${refStr}${issueStr}${fileRef}`
          : `• *${s.provider}* — ${counts}${issueStr}${fileRef}`,
      );
    }

    const hiddenProviders = summaries.length - shown.length;
    if (hiddenProviders > 0) {
      lines.push(`• …and ${hiddenProviders} more provider${hiddenProviders === 1 ? "" : "s"}`);
    }
  }

  // ── Quarantine entries ─────────────────────────────────────────────────────
  if (quarantine.length > 0) {
    lines.push(
      `*Quarantined* (${quarantine.length} failure${quarantine.length === 1 ? "" : "s"} need human review):`,
    );
    for (const q of quarantine) {
      const loc = q.rawLocation ? ` (${q.rawLocation})` : "";
      const msg = q.message.slice(0, 120);
      lines.push(`• [quarantine] *${q.provider}* — ${q.testName}${loc}: ${msg}`);
    }
  }

  return lines.join("\n");
}

/**
 * Emit a (possibly multiline) value as a step output via GITHUB_OUTPUT using a
 * randomized heredoc delimiter, per the GitHub Actions multiline-output spec.
 */
function writeGithubOutput(name: string, value: string): void {
  const outPath = process.env.GITHUB_OUTPUT;
  if (!outPath) return;
  const delimiter = `EOF_${randomBytes(16).toString("hex")}`;
  // Guard against the (astronomically unlikely) delimiter colliding with content.
  if (value.includes(delimiter)) {
    throw new Error("GITHUB_OUTPUT delimiter collision — refusing to write");
  }
  appendFileSync(outPath, `${name}<<${delimiter}\n${value}\n${delimiter}\n`, "utf-8");
}

function main(): void {
  const args = process.argv.slice(2);
  const inIndex = args.indexOf("--in");
  const inPath = resolve(
    inIndex !== -1 && args[inIndex + 1] ? args[inIndex + 1] : "drift-report.json",
  );

  let summary = "";
  if (existsSync(inPath)) {
    try {
      const report = readDriftReport(inPath);
      summary = summarizeDriftReport(report);
    } catch (err: unknown) {
      // Never let a malformed/missing report break the notify step — the
      // generic Slack message + "View run" link is the safe fallback.
      console.warn(
        `drift-slack-summary: could not summarize ${inPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    console.warn(`drift-slack-summary: ${inPath} not found — emitting empty summary`);
  }

  writeGithubOutput("drift_summary", summary);
  if (summary) {
    console.log(summary);
  } else {
    console.log("(no drift detail available)");
  }
}

// Only run as a CLI — guard so importing this module (e.g. from tests) does
// not execute main().
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
