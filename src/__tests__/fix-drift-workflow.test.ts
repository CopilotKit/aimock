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
  it("has an authoritative post-fix re-collect step writing a DISTINCT report path", () => {
    expect(wf).toContain("Re-collect drift (authoritative)");
    expect(wf).toContain(
      "npx tsx scripts/drift-report-collector.ts --out drift-report.post-fix.json",
    );
  });

  it("captures the post-fix collector exit code as a step output", () => {
    expect(wfFlat).toContain('POST_FIX_EXIT=$? set -e echo "post_fix_exit=$POST_FIX_EXIT"');
  });

  it("passes BOTH --post-fix-report and --post-fix-exit into `fix-drift.ts --create-pr`", () => {
    expect(wfFlat).toContain("npx tsx scripts/fix-drift.ts --create-pr");
    expect(wfFlat).toMatch(
      /fix-drift\.ts --create-pr[^]*?--post-fix-report drift-report\.post-fix\.json[^]*?--post-fix-exit "\$\{POST_FIX_EXIT\}"/,
    );
  });

  it("the Assert step runs the predicate with post-fix args (the happy-path gate)", () => {
    expect(wf).toContain("Assert drift truly resolved");
    expect(wfFlat).toMatch(
      /drift-success-predicate\.ts[^]*?--post-fix-report drift-report\.post-fix\.json[^]*?--post-fix-exit "\$\{POST_FIX_EXIT\}"/,
    );
  });
});

describe("fix-drift.yml — F-A: PRE-fix report pinned outside the LLM-writable checkout", () => {
  it("has a pin step that copies the pre-fix report into runner.temp before autofix", () => {
    expect(wf).toContain("Pin pre-fix drift report (integrity)");
    expect(wf).toContain('cp drift-report.json "$PINNED_REPORT"');
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
