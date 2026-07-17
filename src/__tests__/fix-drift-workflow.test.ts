/**
 * Static (text-level) assertions on .github/workflows/fix-drift.yml.
 *
 * These pin the LOAD-BEARING wiring that the drift-success predicate/guard now
 * REQUIRE (CR round-3):
 *
 *   F1 — the workflow must (a) re-collect drift AUTHORITATIVELY after the autofix
 *        to a distinct post-fix path, capturing its exit code, and (b) pass BOTH
 *        --post-fix-report and --post-fix-exit into the `--create-pr` invocation.
 *        Without these, the mandatory-post-fix guard fails closed and NO PR is
 *        ever opened (the gate would be inert).
 *
 *   F-A — the PRE-fix report the allowlist's sanctioned-target set is derived
 *        from must be PINNED outside the LLM-writable repo checkout BEFORE the
 *        autofix runs, and both the Assert and Create-PR steps must read
 *        --report from that pinned copy — NEVER the in-repo drift-report.json
 *        the autofix LLM could overwrite.
 *
 * No YAML dependency is added; the repo ships none. These are deliberately
 * text-shape assertions on the committed workflow — an actionlint run in CI
 * covers structural validity separately.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, it, expect } from "vitest";

const WORKFLOW_PATH = resolve(__dirname, "../../.github/workflows/fix-drift.yml");
const wf = readFileSync(WORKFLOW_PATH, "utf-8");

/** Collapse runs of whitespace so multi-line YAML `run:` blocks match linearly. */
const wfFlat = wf.replace(/\s+/g, " ");

describe("fix-drift.yml — F1: post-fix re-collect + args wired into --create-pr", () => {
  it("has an authoritative post-fix re-collect step writing a DISTINCT report path OUTSIDE the repo (FIX #F3)", () => {
    expect(wf).toContain("Re-collect drift (authoritative)");
    // FIX #F3 — the re-collect writes to $RUNNER_TEMP (via the POST_FIX_REPORT
    // env), NOT the repo cwd, so it is never scored by the predicate's git scan.
    expect(wf).toContain('npx tsx scripts/drift-report-collector.ts --out "$POST_FIX_REPORT"');
    expect(wf).toContain("POST_FIX_REPORT: ${{ runner.temp }}/drift-report.post-fix.json");
  });

  it("captures the post-fix collector exit code as a step output", () => {
    expect(wfFlat).toContain('POST_FIX_EXIT=$? set -e echo "post_fix_exit=$POST_FIX_EXIT"');
  });

  it("passes BOTH --post-fix-report and --post-fix-exit into `fix-drift.ts --create-pr`", () => {
    expect(wfFlat).toContain("npx tsx scripts/fix-drift.ts --create-pr");
    expect(wfFlat).toMatch(
      /fix-drift\.ts --create-pr[^]*?--post-fix-report "\$\{POST_FIX_REPORT\}"[^]*?--post-fix-exit "\$\{POST_FIX_EXIT\}"/,
    );
  });

  it("the Assert step runs the predicate with post-fix args (the happy-path gate)", () => {
    expect(wf).toContain("Assert drift truly resolved");
    expect(wfFlat).toMatch(
      /drift-success-predicate\.ts[^]*?--post-fix-report "\$\{POST_FIX_REPORT\}"[^]*?--post-fix-exit "\$\{POST_FIX_EXIT\}"/,
    );
  });
});

describe("fix-drift.yml — F-A: PRE-fix report pinned outside the LLM-writable checkout", () => {
  it("has a pin step that copies the pre-fix report into runner.temp before autofix", () => {
    expect(wf).toContain("Pin pre-fix drift report (integrity)");
    // FIX #F3 — the pre-fix report is itself collected into $RUNNER_TEMP
    // (PRE_FIX_REPORT), so the pin copies from that out-of-repo path, never the
    // repo cwd. Both source and destination are outside the LLM-writable checkout.
    expect(wf).toContain('cp "$PRE_FIX_REPORT" "$PINNED_REPORT"');
    expect(wf).toContain("PINNED_REPORT: ${{ runner.temp }}/drift-report.pinned.json");
  });

  it("the pin step runs BEFORE the Auto-fix step (so the LLM cannot pre-tamper the pin)", () => {
    const pinIdx = wf.indexOf("Pin pre-fix drift report");
    const autofixIdx = wf.indexOf("name: Auto-fix drift");
    expect(pinIdx).toBeGreaterThan(-1);
    expect(autofixIdx).toBeGreaterThan(-1);
    expect(pinIdx).toBeLessThan(autofixIdx);
  });

  it("the Assert step reads --report from the PINNED copy, not the in-repo file", () => {
    // The YAML line-continuation `\` survives whitespace-flattening, so match
    // tolerantly across it.
    expect(wfFlat).toMatch(/drift-success-predicate\.ts \\? *--report "\$\{PINNED_REPORT\}"/);
  });

  it("the Create PR step reads --report from the PINNED copy, not the in-repo file", () => {
    expect(wfFlat).toMatch(
      /scripts\/fix-drift\.ts --create-pr \\? *--report "\$\{PINNED_REPORT\}"/,
    );
  });

  it("neither the Assert nor Create-PR predicate invocation reads --report drift-report.json (the LLM-writable file)", () => {
    // The in-repo drift-report.json is still uploaded as an artifact + copied by
    // the pin step, but must NEVER be the --report source for the gate.
    expect(wfFlat).not.toMatch(/drift-success-predicate\.ts \\? *--report drift-report\.json/);
    expect(wfFlat).not.toMatch(/fix-drift\.ts --create-pr \\? *--report drift-report\.json/);
  });
});

// ---------------------------------------------------------------------------
// FIX (round-4, user-approved) — HUMAN-APPROVAL BACKSTOP. The drift path opens a
// PR but must NEVER auto-merge: the predicate is a strong AUTO-FILTER, not a
// provable merge gate (the re-collect is not independent of the fix — WS-2b), so
// a human reviews CI + the diff + the verdict and merges. These lock that the
// unattended in-workflow merge is GONE and the Slack copy no longer claims
// "merged to main".
// ---------------------------------------------------------------------------
describe("fix-drift.yml — human-approval backstop: no unattended auto-merge", () => {
  it("has NO auto-merge step and never runs `gh pr merge`", () => {
    expect(wf).not.toContain("Auto-merge PR");
    expect(wf).not.toMatch(/gh pr merge/);
  });

  it("documents WHY the drift path is human-gated (predicate is a filter, not a merge gate)", () => {
    expect(wf).toContain("NO AUTO-MERGE");
    // The rationale wraps across comment lines (a `#` marker survives flattening),
    // so match tolerantly across the wrap.
    expect(wfFlat).toMatch(/AUTO-FILTER, NOT a provable merge (# )?gate/i);
  });

  it("the success Slack message says the PR needs human review + merge, NOT merged to main", () => {
    expect(wf).not.toContain("Drift auto-fix merged to main");
    expect(wf).toContain("Drift-fix PR opened — needs human review + merge");
  });

  it("the fix-failure Slack step no longer references the removed merge step outputs", () => {
    expect(wf).not.toContain("steps.merge.outputs");
    expect(wf).not.toContain("MERGE_REASON");
  });
});
