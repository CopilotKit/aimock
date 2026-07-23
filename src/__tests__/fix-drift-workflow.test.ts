/**
 * Static (text-level) assertions on .github/workflows/fix-drift.yml.
 *
 * C3 (delete-freewriter-predicate-rewire): this workflow used to invoke an
 * autonomous coding-agent subprocess to freewrite a fix for whatever drift the
 * collector found, then gate the resulting diff behind a 916-line anti-cheat
 * verdict function (`scripts/drift-success-predicate.ts`) before opening a PR.
 * Both have been DELETED entirely. This suite (retargeted from the deleted
 * predicate-era assertions) pins the NEW, load-bearing wiring instead:
 *
 *   - the workflow triggers on workflow_dispatch, a SCHEDULED cron (the
 *     deprecation detector fires independently of drift-test failure — a
 *     vanished model family does not, by itself, red the Drift Tests
 *     workflow), and workflow_run(Drift Tests, failure).
 *   - the "Auto-fix drift" step is replaced by `scripts/drift-sync.ts` (the
 *     deterministic, zero-LLM model-family sync core).
 *   - the "Assert drift truly resolved" step is replaced by
 *     `scripts/drift-sync-check.ts` (the trivial allowlist + pin + re-collect
 *     gate).
 *   - the PR-open path is gated on `reason == 'ok-applied'`, never on a
 *     verdict function.
 *   - the NO-AUTO-MERGE human-approval backstop is preserved verbatim (Phase
 *     0/1 — auto-merge is an explicit, opt-in Phase-4 exception, out of scope
 *     here).
 *   - there is NO remaining reference to the deleted predicate/LLM machinery.
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

describe("fix-drift.yml — the LLM freewriter + anti-cheat predicate are GONE", () => {
  it("never references the deleted invokeClaudeCode / Claude Code CLI spawn", () => {
    expect(wf).not.toMatch(/invokeClaudeCode/i);
    expect(wf).not.toMatch(/@anthropic-ai\/claude-code/);
    expect(wf).not.toContain("Claude Code");
  });

  it("never references the deleted drift-success-predicate.ts", () => {
    expect(wf).not.toContain("drift-success-predicate");
  });

  it("never invokes the deleted scripts/fix-drift.ts", () => {
    expect(wf).not.toMatch(/scripts\/fix-drift\.ts/);
  });

  it("has no step named 'Auto-fix drift' or 'Assert drift truly resolved' (the old predicate-era step names)", () => {
    expect(wf).not.toContain("name: Auto-fix drift");
    expect(wf).not.toContain("name: Assert drift truly resolved");
  });

  it("carries no now-unused agent/predicate-only secrets or env beyond the legitimate provider keys", () => {
    // ANTHROPIC_API_KEY legitimately remains — drift-sync.ts uses it to list
    // live Anthropic models, and the collector's Anthropic drift leg uses it
    // too. Neither is the deleted agent invocation.
    expect(wf).toContain("ANTHROPIC_API_KEY");
    expect(wf).not.toMatch(/claude-code-output/);
  });
});

// ---------------------------------------------------------------------------
// FF2 (dead-permission trim): the `sync` job's `permissions:` block (and the
// app-token mint step) granted `checks: read` / `statuses: read`
// (`permission-checks` / `permission-statuses`) with a comment claiming they
// let "the merge gate assert the PR is truly green before merging". No step
// in this workflow ever queries check-runs or commit statuses (there is no
// `gh api .../check-runs`, no `gh pr checks`, no status lookup anywhere —
// the workflow explicitly does NO auto-merge; see the NO-AUTO-MERGE block
// above), so both the permissions and the stale comment are dead and must be
// removed.
// ---------------------------------------------------------------------------
describe("fix-drift.yml — FF2: dead checks/statuses permissions are removed", () => {
  it("the sync job's permissions block does not grant checks: read", () => {
    const idx = wf.indexOf("permissions:");
    expect(idx).toBeGreaterThan(-1);
    const block = wf.slice(idx, wf.indexOf("steps:", idx));
    expect(block).not.toMatch(/^\s*checks:\s*read\s*$/m);
  });

  it("the sync job's permissions block does not grant statuses: read", () => {
    const idx = wf.indexOf("permissions:");
    expect(idx).toBeGreaterThan(-1);
    const block = wf.slice(idx, wf.indexOf("steps:", idx));
    expect(block).not.toMatch(/^\s*statuses:\s*read\s*$/m);
  });

  it("the app-token mint step does not request permission-checks or permission-statuses", () => {
    expect(wf).not.toContain("permission-checks");
    expect(wf).not.toContain("permission-statuses");
  });

  it("no step actually consumes check-runs or commit statuses (confirms the perms were dead, not just unlabeled)", () => {
    expect(wf).not.toMatch(/check-runs/);
    expect(wf).not.toMatch(/gh pr checks/);
    expect(wf).not.toMatch(/\bstatuses\b/);
  });
});

describe("fix-drift.yml — triggers on workflow_dispatch, a SCHEDULED cron, and drift-test failure", () => {
  it("triggers on workflow_dispatch", () => {
    expect(wf).toMatch(/on:\s*\n\s*workflow_dispatch:/);
  });

  it("has a schedule/cron trigger, independent of the drift-failure gate", () => {
    expect(wf).toMatch(/schedule:\s*\n\s*-\s*cron:/);
  });

  it("still triggers on workflow_run of the Drift Tests workflow completing", () => {
    expect(wf).toContain('workflows: ["Drift Tests"]');
    expect(wf).toContain("types: [completed]");
  });

  it("the job runs on workflow_dispatch, schedule, OR a failed Drift Tests run", () => {
    const idx = wf.indexOf("if: >-");
    expect(idx).toBeGreaterThan(-1);
    const block = wf.slice(idx, wf.indexOf("runs-on:", idx));
    expect(block).toContain("github.event_name == 'workflow_dispatch'");
    expect(block).toContain("github.event_name == 'schedule'");
    expect(block).toContain("github.event.workflow_run.conclusion == 'failure'");
  });
});

describe("fix-drift.yml — deterministic sync + sync-check replace the fixer + predicate", () => {
  it("runs scripts/drift-sync.ts as the remediation step", () => {
    expect(wfFlat).toContain("npx tsx scripts/drift-sync.ts");
  });

  it("captures drift-sync's reason= output as a step output", () => {
    expect(wfFlat).toContain("id: sync");
    expect(wfFlat).toMatch(/grep '\^reason=' "\$\{SYNC_LOG\}"/);
    expect(wfFlat).toContain('echo "reason=${REASON}" >> "$GITHUB_OUTPUT"');
  });

  it("runs scripts/drift-sync-check.ts as a defense-in-depth re-assertion, gated on reason == 'ok-applied'", () => {
    expect(wf).toContain("name: Assert drift-sync-check (defense-in-depth)");
    expect(wf).toContain("if: steps.sync.outputs.reason == 'ok-applied'");
    expect(wfFlat).toContain("npx tsx scripts/drift-sync-check.ts");
  });

  it("the PR-open step is gated on reason == 'ok-applied', not on a verdict function", () => {
    const idx = wf.indexOf("name: Push branch + create PR");
    expect(idx).toBeGreaterThan(-1);
    const nextStep = wf.indexOf("\n      - name:", idx + 1);
    const stepBlock = wf.slice(idx, nextStep === -1 ? undefined : nextStep);
    expect(stepBlock).toContain("if: steps.sync.outputs.reason == 'ok-applied' && success()");
    expect(stepBlock).toContain("gh pr create");
  });
});

describe("fix-drift.yml — needs-human vs gate-failure are DISTINCT alerts", () => {
  it("alerts distinctly when the sync routes to a human decision (new family / still-referenced deprecation)", () => {
    expect(wf).toContain("name: Alert on needs-human decision");
    expect(wf).toContain("steps.sync.outputs.reason == 'needs-human'");
  });

  it("alerts distinctly (and separately) when drift-sync-check refuses the gate — a tooling fault, not a product decision", () => {
    expect(wf).toContain("name: Alert on drift-sync-check gate failure");
    expect(wf).toContain("steps.sync.outputs.reason == 'gate-failed'");
  });

  it("both needs-human and gate-failure alerts fail the job (non-green), so a human sees it in CI status too", () => {
    const needsHumanIdx = wf.indexOf("name: Alert on needs-human decision");
    const needsHumanBlock = wf.slice(
      needsHumanIdx,
      wf.indexOf("\n      - name:", needsHumanIdx + 1),
    );
    expect(needsHumanBlock).toMatch(/\n\s*exit 1\b/);

    const gateFailedIdx = wf.indexOf("name: Alert on drift-sync-check gate failure");
    const gateFailedBlock = wf.slice(
      gateFailedIdx,
      wf.indexOf("\n      - name:", gateFailedIdx + 1),
    );
    expect(gateFailedBlock).toMatch(/\n\s*exit 1\b/);
  });

  it("re-fires never spam a duplicate PR for an already-proposed family (documented: dedup note file + open-PR marker check)", () => {
    expect(wf).toContain("no PR spam");
  });
});

// ---------------------------------------------------------------------------
// Human-approval backstop — preserved verbatim from the pre-C3 workflow.
// ---------------------------------------------------------------------------
describe("fix-drift.yml — human-approval backstop: no unattended auto-merge", () => {
  it("has NO auto-merge step and never runs `gh pr merge`", () => {
    expect(wf).not.toContain("Auto-merge PR");
    expect(wf).not.toMatch(/gh pr merge/);
  });

  it("documents WHY the drift-sync path is human-gated (drift-sync-check is a filter, not a merge gate)", () => {
    expect(wf).toContain("NO AUTO-MERGE");
    expect(wfFlat).toMatch(/AUTO-FILTER, NOT a provable merge (# )?gate/i);
  });

  it("the success Slack message says the PR needs human review + merge, NOT merged to main", () => {
    expect(wf).not.toContain("merged to main");
    expect(wf).toContain("Drift-sync PR opened — needs human review + merge");
  });
});

// ---------------------------------------------------------------------------
// Early-infra catch-all — preserved (adapted to the new step id `sync`).
// ---------------------------------------------------------------------------
describe("fix-drift.yml — early-infra catch-all failure alert", () => {
  it("has an end-of-job catch-all alert step", () => {
    expect(wf).toContain("Alert on early-infra failure (catch-all)");
  });

  it("the catch-all is gated on failure() and is UNCONDITIONAL on the sync step's REASON output being unset", () => {
    const idx = wf.indexOf("Alert on early-infra failure (catch-all)");
    expect(idx).toBeGreaterThan(-1);
    const stepBlock = wf.slice(idx, idx + 400);
    expect(stepBlock).toContain("if: failure() && steps.sync.outputs.reason == ''");
  });

  it("distinguishes an INFRA/SETUP failure from a sync-gate failure in its message", () => {
    const idx = wf.indexOf("Alert on early-infra failure (catch-all)");
    const stepBlock = wf.slice(idx, idx + 1400);
    expect(stepBlock).toMatch(/INFRA\/SETUP failure/);
    expect(stepBlock).toContain("SLACK_WEBHOOK is not set");
    expect(stepBlock).toMatch(/::error::/);
  });
});

// ---------------------------------------------------------------------------
// F#1 (mandatory): the "Push branch + create PR" step can itself fail (branch
// push rejected, `gh pr create` error, or the head-SHA PR-match polling loop
// exhausting its attempts) AFTER the defense-in-depth Assert step already
// SUCCEEDED. In that window: reason stays 'ok-applied', steps.assert.outcome
// stays 'success', and reason is non-empty — so none of needs-human,
// gate-failure (assert.outcome-only check), or the early-infra catch-all
// (reason=='') fire. The job goes red with ZERO Slack signal on an unattended
// daily cron. The gate-failure alert must widen to also catch this window.
// ---------------------------------------------------------------------------
describe("fix-drift.yml — gate-failure alert also covers a later step failing after an ok-applied sync + successful assert", () => {
  it("the gate-failure alert fires on ok-applied + failure(), not only on steps.assert.outcome == 'failure' (so a Push/PR-create failure is caught too)", () => {
    const idx = wf.indexOf("name: Alert on drift-sync-check gate failure");
    expect(idx).toBeGreaterThan(-1);
    const nextStep = wf.indexOf("\n      - name:", idx + 1);
    const stepBlock = wf.slice(idx, nextStep === -1 ? undefined : nextStep);
    // Must be gated on general failure() in the ok-applied branch, not
    // narrowly on steps.assert.outcome == 'failure' — otherwise a failure in
    // a step AFTER assert (Push branch + create PR) is invisible to this
    // condition.
    expect(stepBlock).toMatch(/steps\.sync\.outputs\.reason == 'ok-applied' && failure\(\)/);
  });

  it("the gate-failure alert message names which step actually failed", () => {
    const idx = wf.indexOf("name: Alert on drift-sync-check gate failure");
    const nextStep = wf.indexOf("\n      - name:", idx + 1);
    const stepBlock = wf.slice(idx, nextStep === -1 ? undefined : nextStep);
    // The step must reference the outcomes of both the assert step and the PR
    // step so its message can distinguish "assert refused" from "push/PR
    // creation failed" rather than a single generic message.
    expect(stepBlock).toContain("steps.assert.outcome");
    expect(stepBlock).toContain("steps.pr.outcome");
  });
});

// ---------------------------------------------------------------------------
// G#2 (mandatory): a needs-human run WRITES a `drift-proposals/` note (the
// Bucket-B human touchpoint) into CI's working tree, but the workflow only ever
// pushed a branch + opened a PR on reason == 'ok-applied'. On a needs-human run
// the registry is unchanged, so NOTHING was pushed — the note was discarded
// with the runner. The self-service human-decision path (human sets
// `Decision: include`, the NEXT run reads the approved note and applies it) was
// therefore unreachable: the note never landed in the repo. The workflow must
// persist the note on needs-human by pushing a branch + opening a (distinct,
// never auto-merged) PR.
// ---------------------------------------------------------------------------
/** Split the workflow into per-step blocks (text after each `- name:` header). */
function stepBlocks(): string[] {
  return wf.split(/\n {6}- name: /).slice(1);
}

describe("fix-drift.yml — needs-human notes are PERSISTED (pushed + PR'd), not discarded", () => {
  it("has a step gated on reason == 'needs-human' that pushes a branch AND opens a PR (so the note reaches the repo)", () => {
    // Concept-level: SOME step must both be conditioned on the needs-human
    // outcome and perform a git push + `gh pr create`. Pre-fix, the only
    // `gh pr create` lives in the ok-applied "Push branch + create PR" step,
    // so this finds nothing and FAILS (RED).
    const persistSteps = stepBlocks().filter(
      (b) =>
        b.includes("steps.sync.outputs.reason == 'needs-human'") &&
        /git push\b/.test(b) &&
        b.includes("gh pr create"),
    );
    expect(persistSteps.length).toBeGreaterThan(0);
  });

  it("the needs-human persist step uses a DISTINCT branch (not colliding with the ok-applied fix/drift-* branch)", () => {
    const persist = stepBlocks().find(
      (b) => b.includes("steps.sync.outputs.reason == 'needs-human'") && b.includes("gh pr create"),
    );
    expect(persist).toBeDefined();
    // A dedicated needs-human branch prefix keeps the two PR classes separate.
    expect(persist!).toMatch(/drift-needs-human/);
  });

  it("the needs-human persist step de-dups: it skips opening a second PR when one is already open for the same note", () => {
    const persist = stepBlocks().find(
      (b) => b.includes("steps.sync.outputs.reason == 'needs-human'") && b.includes("gh pr create"),
    );
    expect(persist).toBeDefined();
    // Must consult already-open PRs before creating a new one.
    expect(persist!).toContain("gh pr list");
  });

  it("the needs-human persist step's PR body tells a human to set Decision: include and merge (closing the two-run loop), never auto-merged", () => {
    const persist = stepBlocks().find(
      (b) => b.includes("steps.sync.outputs.reason == 'needs-human'") && b.includes("gh pr create"),
    );
    expect(persist).toBeDefined();
    expect(persist!).toContain("Decision: include");
    // No `gh pr merge` anywhere (asserted globally too) — human merges.
    expect(persist!).not.toMatch(/gh pr merge/);
  });

  it("the needs-human persist step's OWN failure is alerted (gate-failure alert references its outcome)", () => {
    const gateAlert = stepBlocks().find((b) =>
      b.startsWith("Alert on drift-sync-check gate failure"),
    );
    expect(gateAlert).toBeDefined();
    expect(gateAlert!).toContain("steps.needs_human_pr.outcome");
  });
});

// ---------------------------------------------------------------------------
// F#2 / G#2 (should-fix): DRIFT.md (and the workflow's own PR-body fallback
// text) claim a `drift-sync-check-log` artifact exists, but historically the
// workflow only uploaded `drift-sync-log`. Assert the claim matches reality.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// G#3 (mandatory): the needs-human persist step's de-dup was keyed SOLELY on
// the committed `drift-proposals/*` note paths. In the D-M1 "mixed run" (a
// mechanical registry edit committed the SAME run a *different* family is
// deferred to a human, whose note already sits on main), the committed diff is
// ONLY the registry edit and NO new note file — so the note-path list is
// EMPTY, the per-note dedup for-loop runs zero times, and the step falls
// straight through to an unconditional `git push` + `gh pr create`. Because the
// edit is never auto-merged and the unrelated deprecation is re-detected every
// daily cron run, this opens a brand-new near-identical PR every single day
// (unbounded PR-spam). Both PR-open paths must instead de-dup on a STABLE,
// date-independent changeset key that exists for EVERY committed changeset.
// ---------------------------------------------------------------------------
describe("fix-drift.yml — G#3: PR-open paths de-dup on a STABLE changeset key (idempotent in EVERY run shape, incl. the mixed run with NO new note file)", () => {
  it("the sync step emits a stable changeset_key step output (grepped from drift-sync.ts's changeset-key= line)", () => {
    // RED (pre-fix): drift-sync.ts printed no changeset-key line and the sync
    // step captured no such output — nothing existed to dedup a note-less
    // mixed run on.
    expect(wfFlat).toMatch(/grep '\^changeset-key=' "\$\{SYNC_LOG\}"/);
    expect(wf).toContain('echo "changeset_key=${CHANGESET_KEY}"');
    // Written to the step's outputs (block-redirected to $GITHUB_OUTPUT).
    expect(wfFlat).toContain('echo "changeset_key=${CHANGESET_KEY}" } >> "$GITHUB_OUTPUT"');
  });

  it("the needs-human persist step's PRIMARY de-dup is keyed on the changeset key and runs BEFORE the note-file scan (so it fires even when the committed diff carries NO drift-proposals/* note)", () => {
    const persist = stepBlocks().find(
      (b) => b.includes("steps.sync.outputs.reason == 'needs-human'") && b.includes("gh pr create"),
    );
    expect(persist).toBeDefined();
    // Keyed on the changeset key wired from the sync step.
    expect(persist!).toContain("CHANGESET_KEY: ${{ steps.sync.outputs.changeset_key }}");
    expect(persist!).toContain("drift-changeset: ${CHANGESET_KEY}");
    // CRITICAL: the changeset-key dedup guard must appear BEFORE the
    // `mapfile ... NOTES` scan. Pre-fix, the ONLY dedup lived inside the
    // per-note for-loop, reachable only when a note file was in the diff —
    // exactly what the empty-NOTES mixed run bypasses.
    const guardIdx = persist!.indexOf("drift-changeset: ${CHANGESET_KEY}");
    const mapfileIdx = persist!.indexOf("mapfile -t COMMITTED");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(mapfileIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(mapfileIdx);
  });

  it("the ok-applied Push+PR step ALSO de-dups on the changeset key (a never-auto-merged applied edit deserves exactly ONE open PR, re-findable across daily re-fires)", () => {
    const okApplied = stepBlocks().find(
      (b) =>
        b.includes("steps.sync.outputs.reason == 'ok-applied' && success()") &&
        b.includes("gh pr create"),
    );
    expect(okApplied).toBeDefined();
    expect(okApplied!).toContain("CHANGESET_KEY: ${{ steps.sync.outputs.changeset_key }}");
    expect(okApplied!).toContain("drift-changeset: ${CHANGESET_KEY}");
    expect(okApplied!).toContain("gh pr list");
    // The dedup skip must precede the push (skip a duplicate BEFORE pushing).
    const guardIdx = okApplied!.indexOf("not opening a duplicate");
    const pushIdx = okApplied!.indexOf("git push -u origin");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(pushIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(pushIdx);
  });

  it("the needs-human persist step RETAINS the per-note body marker as a secondary guard (note-path de-dup not regressed)", () => {
    const persist = stepBlocks().find(
      (b) => b.includes("steps.sync.outputs.reason == 'needs-human'") && b.includes("gh pr create"),
    );
    expect(persist).toBeDefined();
    expect(persist!).toContain("drift-proposal-note: ${note}");
  });

  it("BOTH PR bodies embed the stable drift-changeset marker the dedup guards match on", () => {
    const markerCount = (wf.match(/<!-- drift-changeset: \$\{CHANGESET_KEY\} -->/g) || []).length;
    expect(markerCount).toBeGreaterThanOrEqual(2);
  });
});

describe("fix-drift.yml — drift-sync-check-log artifact matches DRIFT.md's claim", () => {
  it("DRIFT.md claims a drift-sync-check-log artifact exists", () => {
    const driftMd = readFileSync(resolve(__dirname, "../../DRIFT.md"), "utf-8");
    expect(driftMd).toContain("drift-sync-check-log");
  });

  it("the workflow actually uploads a drift-sync-check-log artifact (matching the drift-sync-log sibling's retention)", () => {
    expect(wf).toContain("name: drift-sync-check-log");
    expect(wfFlat).toContain("path: ${{ runner.temp }}/drift-sync-check.log");
    expect(wfFlat).toContain("retention-days: 30");
  });
});
