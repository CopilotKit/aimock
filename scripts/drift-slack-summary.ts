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

import { readDriftReport } from "./fix-drift.js";
import type { DriftEntry, DriftReport, DriftSeverity } from "./drift-types.js";

// Keep the message scannable: cap how many example paths we list per provider
// and how many total providers we enumerate before collapsing to a count.
const MAX_PATHS_PER_PROVIDER = 3;
const MAX_PROVIDERS_LISTED = 8;

const SEVERITY_ORDER: DriftSeverity[] = ["critical", "warning", "info"];

interface ProviderSummary {
  provider: string;
  counts: Record<DriftSeverity, number>;
  paths: string[];
}

/**
 * Group drift entries by provider, tallying severities and collecting a small,
 * de-duplicated set of representative changed paths.
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
      };
      byProvider.set(entry.provider, summary);
    }
    for (const diff of entry.diffs) {
      summary.counts[diff.severity]++;
      if (diff.path && !summary.paths.includes(diff.path)) {
        summary.paths.push(diff.path);
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
 * Returns a single string with real `\n` line breaks. Each provider gets a
 * bullet line: `• *Provider* — 2 critical: \`path.a\`, \`path.b\``.
 * Returns an empty string when there are no entries (caller decides fallback).
 */
export function summarizeDriftReport(report: DriftReport): string {
  const summaries = summarizeByProvider(report.entries);
  if (summaries.length === 0) return "";

  const shown = summaries.slice(0, MAX_PROVIDERS_LISTED);
  const lines: string[] = [];

  for (const s of shown) {
    const examplePaths = s.paths.slice(0, MAX_PATHS_PER_PROVIDER).map((p) => `\`${p}\``);
    const extraPaths = s.paths.length - examplePaths.length;
    let pathStr = examplePaths.join(", ");
    if (extraPaths > 0) pathStr += `, +${extraPaths} more`;

    const counts = formatCounts(s.counts);
    lines.push(
      pathStr ? `• *${s.provider}* — ${counts}: ${pathStr}` : `• *${s.provider}* — ${counts}`,
    );
  }

  const hiddenProviders = summaries.length - shown.length;
  if (hiddenProviders > 0) {
    lines.push(`• …and ${hiddenProviders} more provider${hiddenProviders === 1 ? "" : "s"}`);
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
