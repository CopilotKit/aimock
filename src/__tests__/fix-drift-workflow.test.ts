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
 *   - the workflow triggers on workflow_dispatch and a SCHEDULED cron (the
 *     deprecation detector fires independently of drift-test failure — a
 *     vanished model family does not, by itself, red the Drift Tests
 *     workflow), and on AT MOST ONE trigger for a given Drift Tests failure
 *     (see the double-fire section below).
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
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, it, expect } from "vitest";

import { SyncCoreReason } from "../../scripts/drift-sync.js";

const WORKFLOW_PATH = resolve(__dirname, "../../.github/workflows/fix-drift.yml");
const wf = readFileSync(WORKFLOW_PATH, "utf-8");

/** Collapse runs of whitespace so multi-line YAML `run:` blocks match linearly. */
const wfFlat = wf.replace(/\s+/g, " ");

/**
 * Read the workflow's top-level `on:` mapping and report which triggers are
 * declared (plus, for `workflow_run`, which upstream workflows it keys off).
 *
 * Scoped deliberately to the trigger block — a top-level key followed by
 * two-space-indented child keys — rather than pulling in a YAML parser the
 * repo does not ship. Comments and blank lines are skipped; the block ends at
 * the next column-0 key.
 */
function parseTriggers(src: string): {
  names: string[];
  workflowRunWorkflows: string[];
} {
  const lines = src.split("\n");
  const onIdx = lines.findIndex((l) => /^on:\s*$/.test(l));
  if (onIdx === -1) throw new Error("fix-drift.yml: no top-level `on:` block found");

  const names: string[] = [];
  const workflowRunWorkflows: string[] = [];
  let inWorkflowRun = false;

  for (let i = onIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    if (/^\S/.test(line)) break; // next column-0 key ends the `on:` block

    const key = /^ {2}([A-Za-z_][A-Za-z0-9_]*):/.exec(line);
    if (key) {
      names.push(key[1]);
      inWorkflowRun = key[1] === "workflow_run";
      continue;
    }
    if (inWorkflowRun) {
      const wfs = /^ {4}workflows:\s*\[(.*)\]\s*$/.exec(line);
      if (wfs) {
        workflowRunWorkflows.push(
          ...wfs[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")),
        );
      }
    }
  }
  return { names, workflowRunWorkflows };
}

/** The `sync` job's `if:` gate, as a single flattened expression string. */
function syncJobIf(src: string): string {
  const idx = src.indexOf("    if: >-");
  if (idx === -1) throw new Error("fix-drift.yml: no `sync` job `if:` gate found");
  return src.slice(idx, src.indexOf("runs-on:", idx)).replace(/\s+/g, " ");
}

// ---------------------------------------------------------------------------
// STEP SLICER.
//
// The two guards at the bottom of this file EXECUTE a step's own `run:` body
// rather than pattern-matching it, so they need that body byte-for-byte. This
// slices the `steps:` sequence by indentation and hands back each step's
// `name`/`id`/`if`, the env keys it declares, and its dedented `run:` block.
//
// It is a READER of the artifact, not a model of anything the runner does: the
// `stepRunBodiesAreVerbatim` guard below re-indents every extracted body and
// requires it to be a literal substring of the file, so a slicer that
// paraphrases cannot pass.
// ---------------------------------------------------------------------------
interface Step {
  name?: string;
  id?: string;
  if?: string;
  /** Keys of the step's `env:` mapping (values are `${{ }}` expressions). */
  envKeys: string[];
  /** The `run:` block scalar, dedented. Empty for `uses:` steps. */
  run: string;
  /** Indent the `run:` block carried in the file, for the verbatim check. */
  runIndent: number;
}

const indentOf = (l: string): number => l.length - l.trimStart().length;

function steps(src: string = wf): Step[] {
  const lines = src.split("\n");
  const stepsIdx = lines.findIndex((l) => /^\s+steps:\s*$/.test(l));
  if (stepsIdx === -1) throw new Error("fix-drift.yml: no `steps:` sequence found");

  const firstItem = lines.findIndex((l, i) => i > stepsIdx && /^\s+- \S/.test(l));
  if (firstItem === -1) throw new Error("fix-drift.yml: `steps:` sequence is empty");
  const itemIndent = indentOf(lines[firstItem]);
  const keyIndent = itemIndent + 2;

  // Item boundaries: a `- ` at exactly itemIndent, ending at the next such line
  // or at the first non-blank line indented LESS than the item.
  const starts: number[] = [];
  let end = lines.length;
  for (let i = firstItem; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    if (indentOf(l) < itemIndent) {
      end = i;
      break;
    }
    if (indentOf(l) === itemIndent && /^\s+- \S/.test(l)) starts.push(i);
  }

  return starts.map((from, n) => {
    const to = n + 1 < starts.length ? starts[n + 1] : end;
    // Normalise `- key: value` to `  key: value` so every key sits at keyIndent.
    const body = lines.slice(from, to).map((l, i) => (i === 0 ? l.replace(/- /, "  ") : l));

    const step: Step = { envKeys: [], run: "", runIndent: 0 };
    for (let i = 0; i < body.length; i++) {
      const l = body[i];
      if (!l.trim() || indentOf(l) !== keyIndent) continue;
      const m = /^\s*([A-Za-z_-]+):\s*(.*)$/.exec(l);
      if (!m) continue;
      const [, key, inline] = m;

      if (key === "run" || key === "if") {
        // Block scalar (`|`, `>-`, …) or an inline value.
        if (!/^[|>]/.test(inline) && inline !== "") {
          if (key === "if") step.if = inline;
          continue;
        }
        const child: string[] = [];
        let blockIndent = -1;
        for (let j = i + 1; j < body.length; j++) {
          if (!body[j].trim()) {
            child.push("");
            continue;
          }
          if (blockIndent === -1) blockIndent = indentOf(body[j]);
          if (indentOf(body[j]) < blockIndent) break;
          child.push(body[j].slice(blockIndent));
        }
        while (child.length && child[child.length - 1] === "") child.pop();
        if (key === "run") {
          step.run = child.join("\n") + "\n";
          step.runIndent = blockIndent;
        } else {
          // `>-` folds: lines join with a space.
          step.if = child.join(" ").replace(/\s+/g, " ").trim();
        }
        continue;
      }

      if (key === "env") {
        for (let j = i + 1; j < body.length; j++) {
          if (!body[j].trim()) continue;
          if (indentOf(body[j]) <= keyIndent) break;
          const em = /^\s*([A-Za-z_][A-Za-z0-9_]*):/.exec(body[j]);
          if (em) step.envKeys.push(em[1]);
        }
        continue;
      }

      if (key === "name") step.name = inline.replace(/^["']|["']$/g, "");
      if (key === "id") step.id = inline.replace(/^["']|["']$/g, "");
    }
    return step;
  });
}

function stepById(id: string, src: string = wf): Step {
  const hits = steps(src).filter((s) => s.id === id);
  if (hits.length !== 1) throw new Error(`fix-drift.yml: ${hits.length} steps with id ${id}`);
  return hits[0];
}

const runOf = (s: Step): string => s.run;

/**
 * EXECUTE the sync step's own `run:` body against a drift-sync that CRASHES
 * before printing any `reason=` line, and report what the runner would see.
 *
 * This is an OBSERVATION, not an assertion about the body's text: the step is
 * run under bash with `npx` replaced by a stub standing in for drift-sync.ts's
 * fatal handler (`drift-sync fatal error: …` on stderr, exit 1 — it fires before
 * the first `console.log`, because runDriftSyncCli awaits every provider's churn
 * input up front). Whatever the step then does with that exit code — swallow it
 * or propagate it — is measured, not guessed.
 */
function observeSyncStepUnderCrash(src: string = wf): {
  stepExit: number;
  outputs: Record<string, string>;
  stdio: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "fix-drift-crash-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "npx"),
      "#!/bin/sh\necho 'drift-sync fatal error: fetch failed' >&2\nexit 1\n",
      { mode: 0o755 },
    );
    const outFile = join(dir, "github_output");
    writeFileSync(outFile, "");
    const script = join(dir, "step.sh");
    writeFileSync(script, runOf(stepById("sync", src)));
    const res = spawnSync("/bin/bash", [script], {
      cwd: dir,
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        SYNC_LOG: join(dir, "drift-sync.log"),
        GITHUB_OUTPUT: outFile,
        RUNNER_TEMP: dir,
      },
    });
    const outputs: Record<string, string> = {};
    for (const line of readFileSync(outFile, "utf-8").split("\n")) {
      const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(line);
      if (m) outputs[m[1]] = m[2];
    }
    return {
      stepExit: res.status ?? -1,
      outputs,
      stdio: `${res.stdout ?? ""}${res.stderr ?? ""}`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * ASSEMBLE a Slack alert's message the way bash will, and return the result.
 *
 * The raw YAML text cannot answer "does this message contain a newline": the
 * literal two characters `\n` (which bash does NOT expand inside double quotes)
 * and a `${NL}` holding a real newline look equally plausible in source. So run
 * the step's own body up to and including its `MSG=` assignment — with every env
 * key it declares filled in — and print what `$MSG` actually holds.
 *
 * `envOverride` selects which branch of a multi-arm message is taken (an alert
 * whose text depends on whether `PR_URL`/`SYNC_REASON` is set has more than one
 * assembled form, and each has to be observed on its own).
 */
function assembleSlackMessage(step: Step, envOverride: Record<string, string> = {}): string {
  const lines = runOf(step).split("\n");
  const last = lines.reduce((acc, l, i) => (/\bMSG=/.test(l) ? i : acc), -1);
  if (last === -1) throw new Error(`${step.name}: no MSG= assignment to assemble`);
  const dir = mkdtempSync(join(tmpdir(), "fix-drift-msg-"));
  try {
    const outFile = join(dir, "msg.txt");
    const script = join(dir, "msg.sh");
    writeFileSync(
      script,
      [...lines.slice(0, last + 1), `printf '%s' "$MSG" > ${JSON.stringify(outFile)}`].join("\n"),
    );
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    // Non-empty placeholders for everything the step declares, so `set -u` is
    // satisfied and each message takes its content-bearing branch.
    for (const key of step.envKeys) env[key] = `<${key}>`;
    Object.assign(env, envOverride);
    const res = spawnSync("/bin/bash", [script], { cwd: dir, encoding: "utf-8", env });
    if (res.status !== 0) {
      throw new Error(`${step.name}: assembling MSG failed (${res.status}): ${res.stderr}`);
    }
    return readFileSync(outFile, "utf-8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("fix-drift.yml — the step slicer reads the artifact verbatim (both guards below depend on it)", () => {
  it("finds the named steps the guards address, by id and by name", () => {
    expect(steps().length).toBeGreaterThan(10);
    for (const id of ["app-token", "gitcfg", "sync", "assert", "pr", "needs_human_pr"]) {
      expect(() => stepById(id), `no unique step with id: ${id}`).not.toThrow();
    }
  });

  it("every extracted `run:` body is a LITERAL substring of the file when re-indented", () => {
    const withRun = steps().filter((s) => s.run !== "");
    expect(withRun.length).toBeGreaterThan(5);
    for (const s of withRun) {
      const reindented = s.run
        .split("\n")
        .map((l) => (l === "" ? "" : " ".repeat(s.runIndent) + l))
        .join("\n")
        .replace(/\n+$/, "");
      expect(
        wf.includes(reindented),
        `${s.name}: the sliced run: body is not literally present in the file — the ` +
          "slicer paraphrased it, so anything executed from it is not the artifact",
      ).toBe(true);
    }
  });

  it("the sync step's shell options are carried across, not normalised away", () => {
    // The recurring defect in this suite's history was a harness that seeded
    // shell flags the real step does not run under. Pin the real prefix.
    expect(runOf(stepById("sync"))).toContain("set -uo pipefail");
  });
});

// ---------------------------------------------------------------------------
// M1 (crash window). drift-sync.ts's fatal handler prints
// `drift-sync fatal error: …` to stderr and exits 1 BEFORE its first
// `console.log`, so a crash emits NO `reason=` line at all. The sync step wraps
// the invocation in `set +e` and captures the code into an output rather than
// re-raising it, so before the fix:
//
//   step exit 0 -> step outcome success -> job GREEN
//   reason ''   -> every reason-keyed alert `if:` false
//   failure()   -> false, so the end-of-job catch-all stays silent too
//
// Net effect on an unattended daily cron: the sync crashes and NOTHING is
// reported. Not hypothetical — an invalid GOOGLE_API_KEY makes Gemini answer
// 400, and isInfraSkip() only absorbs 401/402/403/429/5xx, so a 400 throws
// straight out through that fatal handler.
//
// The guard below does not pattern-match a fix. It EXECUTES the step's own run
// body against a crashing drift-sync (`observeSyncStepUnderCrash`) and takes the
// step's real exit status and real `$GITHUB_OUTPUT` as the finding; the alert
// side is then checked against the artifact's OWN `if:` text, so the reason the
// step publishes must be one an alert step is actually keyed on.
// ---------------------------------------------------------------------------
describe("fix-drift.yml — M1: a drift-sync CRASH cannot end green and silent", () => {
  /** Steps that exist to tell a human something (Slack + `::error::`). */
  const alertSteps = () => steps().filter((s) => /^(Alert|Notify)\b/.test(s.name ?? ""));

  it("the crash is observable in the step's captured outputs at all", () => {
    const obs = observeSyncStepUnderCrash();
    expect(obs.stdio).toContain("drift-sync fatal error");
    // drift-sync's real exit code is captured even though the step may swallow it.
    expect(obs.outputs.exit_code).toBe("1");
  });

  it("the crash makes the STEP itself fail, so the job cannot conclude green", () => {
    const obs = observeSyncStepUnderCrash();
    expect(
      obs.stepExit,
      `drift-sync crashed (exit_code=${obs.outputs.exit_code}) but the sync STEP exited 0 ` +
        `and published reason=${JSON.stringify(obs.outputs.reason ?? "")}. The job then ` +
        "concludes GREEN, every reason-keyed alert `if:` is false, and the end-of-job " +
        "catch-all needs failure() — so the daily unattended sync crashes in silence.",
    ).not.toBe(0);
  });

  it("the reason the crash publishes is one an alert step is KEYED ON", () => {
    const obs = observeSyncStepUnderCrash();
    const reason = obs.outputs.reason ?? "";
    expect(reason, "a crash published no reason= at all").not.toBe("");
    const keyed = alertSteps().filter((s) => (s.if ?? "").includes(`'${reason}'`));
    expect(
      keyed.map((s) => s.name),
      `the sync step publishes reason='${reason}' on a crash, but no alert step's ` +
        "`if:` mentions it — the reason is published into a void",
    ).not.toEqual([]);
  });

  it("the reasons that signal a PROBLEM are keyed on by an alert step", () => {
    for (const reason of [SyncCoreReason.GATE_FAILED, SyncCoreReason.NEEDS_HUMAN]) {
      const keyed = alertSteps().filter((s) => (s.if ?? "").includes(`'${reason}'`));
      expect(
        keyed.map((s) => s.name),
        `reason=${reason} raises no alert`,
      ).not.toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// M2 (Slack message newlines). Each alert builds its payload as
// `MSG="…\nRun: …"` and hands it to `jq -n --arg text "$MSG"`. Inside bash
// double quotes `\n` is a LITERAL backslash followed by `n`; jq then escapes the
// backslash, so Slack receives `\\n` and renders the two characters `\n` in the
// middle of the message instead of a line break. The run link is the part that
// gets mangled, in every alert.
// ---------------------------------------------------------------------------
describe("fix-drift.yml — Slack message bodies use REAL newlines, not a literal backslash-n", () => {
  /** Every step that POSTs a Slack payload built from a `MSG=` assignment. */
  const slackSteps = () =>
    steps().filter((s) => runOf(s).includes("SLACK_WEBHOOK") && /\bMSG=/.test(runOf(s)));

  it("all four Slack-posting steps are found (needs-human, gate-failure, success, catch-all)", () => {
    expect(slackSteps().map((s) => s.name)).toEqual([
      "Alert on needs-human decision",
      "Alert on drift-sync-check gate failure",
      "Notify Slack on sync success",
      "Alert on early-infra failure (catch-all)",
    ]);
  });

  it("each alert's ASSEMBLED message carries a real newline and no literal backslash-n", () => {
    for (const step of slackSteps()) {
      const msg = assembleSlackMessage(step);
      expect(
        msg,
        `${step.name}: the assembled message contains the two characters "\\n". Bash does ` +
          "NOT expand a backslash-n inside double quotes, and jq then escapes the " +
          "backslash, so Slack renders it literally in the middle of the alert " +
          "instead of breaking the line before the run link.",
      ).not.toMatch(/\\n/);
      expect(
        msg,
        `${step.name}: the assembled message has no newline at all — the run link is ` +
          "jammed onto the end of the prose.",
      ).toMatch(/\n/);
    }
  });
});

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

describe("fix-drift.yml — triggers on workflow_dispatch and a SCHEDULED cron", () => {
  it("triggers on workflow_dispatch", () => {
    expect(wf).toMatch(/on:\s*\n\s*workflow_dispatch:/);
  });

  it("has a schedule/cron trigger, independent of the drift-failure gate", () => {
    expect(wf).toMatch(/schedule:\s*\n\s*-\s*cron:/);
  });

  it("the job runs on workflow_dispatch OR the schedule", () => {
    const block = syncJobIf(wf);
    expect(block).toContain("github.event_name == 'workflow_dispatch'");
    expect(block).toContain("github.event_name == 'schedule'");
  });
});

// ---------------------------------------------------------------------------
// DOUBLE-FIRE GUARD. This workflow declared BOTH a `schedule` cron AND
// `workflow_run: ["Drift Tests"]`, and admitted the latter whenever the
// upstream run concluded `failure`. While Drift Tests was green the
// workflow_run leg resolved `skipped`, so the duplication was invisible; the
// moment Drift Tests went red (2026-07-29) EVERY day produced TWO Fix Drift
// runs — one `workflow_run` and one `schedule` — each doing the identical
// work and each firing its own Slack alert. `concurrency: drift-fix`
// serialises the two runs but does NOT dedupe them.
//
// The workflow_run leg bought nothing: test-drift.yml's only main-branch
// trigger is its own 6:00 cron and Fix Drift's cron is 6:10, so the leg's
// entire contribution was ~9 minutes of latency on a daily unattended job.
//
// The guard below is written against the PARSED trigger block (not a
// hand-picked string), so re-adding a `workflow_run` leg on "Drift Tests"
// while the cron is still present fails this suite.
// ---------------------------------------------------------------------------
describe("fix-drift.yml — at most ONE trigger can fire per Drift Tests failure", () => {
  const { names, workflowRunWorkflows } = parseTriggers(wf);

  it("the trigger block parses (guard is not vacuous)", () => {
    expect(names).toContain("workflow_dispatch");
    expect(names).toContain("schedule");
  });

  it("AT MOST ONE declared trigger fires when 'Drift Tests' concludes failure", () => {
    // Triggers that fire on the day/run in which "Drift Tests" goes red:
    //   - schedule                     — the 6:10 cron fires that morning anyway.
    //   - workflow_run(["Drift Tests"]) — fires on that very run's completion.
    // workflow_dispatch is manual and never self-fires, so it does not count.
    const firesOnDriftFailure = [
      names.includes("schedule") ? "schedule" : null,
      workflowRunWorkflows.includes("Drift Tests") ? 'workflow_run(["Drift Tests"])' : null,
    ].filter((t): t is string => t !== null);

    expect(
      firesOnDriftFailure,
      "two triggers both fire on a Drift Tests failure — that is two identical " +
        "Fix Drift runs and two Slack alerts every red day",
    ).toHaveLength(1);
  });

  it("the job `if:` has no dead leg gated on an undeclared event", () => {
    const gate = syncJobIf(wf);

    // Every `github.event_name == 'X'` leg must name a DECLARED trigger,
    // otherwise it is unreachable.
    const compared = [...gate.matchAll(/github\.event_name == '([a-z_]+)'/g)].map((m) => m[1]);
    expect(compared.length).toBeGreaterThan(0);
    for (const ev of compared) expect(names).toContain(ev);

    // `github.event.workflow_run.*` is populated ONLY under the workflow_run
    // trigger; referencing it without that trigger leaves a leg that can
    // never be satisfied (and reads as if the drift-failure gate still exists).
    if (!names.includes("workflow_run")) {
      expect(gate).not.toContain("github.event.workflow_run");
    }
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

  const catchAll = () => {
    const s = steps().find((x) => x.name === "Alert on early-infra failure (catch-all)");
    expect(s, "no catch-all step").toBeDefined();
    return s!;
  };

  it("the catch-all is gated on failure() and NOT on the sync step's reason being unset", () => {
    const gate = catchAll().if ?? "";
    expect(gate).toContain("failure()");
    // A `reason == ''` gate blinds the catch-all to every failure AFTER the sync
    // published a reason (an artifact upload, a push) — the F#1 window. It must
    // instead fire exactly when no specific alert did.
    expect(
      gate,
      "the catch-all is gated on an empty reason, so it cannot cover a failure " +
        "that happens after the sync has already reported one",
    ).not.toContain("steps.sync.outputs.reason == ''");
    expect(gate).toContain("steps.alert_needs_human.outcome == 'skipped'");
    expect(gate).toContain("steps.alert_gate.outcome == 'skipped'");
  });

  it("its ASSEMBLED message names WHICH window failed — infra/setup vs after the sync reported", () => {
    // Executed, not matched: both arms of the WHERE= branch are observed.
    const infra = assembleSlackMessage(catchAll(), { SYNC_REASON: "" });
    expect(infra).toMatch(/INFRA\/SETUP/);

    const after = assembleSlackMessage(catchAll(), { SYNC_REASON: "ok-applied" });
    expect(
      after,
      "a failure after the sync reported ok-applied produces the same message as an " +
        "infra failure — the catch-all cannot say which window it is describing",
    ).not.toEqual(infra);
    expect(after).toContain("ok-applied");
  });

  it("a missing webhook is still annotated in the run log", () => {
    expect(runOf(catchAll())).toContain("SLACK_WEBHOOK is not set");
    expect(runOf(catchAll())).toMatch(/::error::/);
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

// ---------------------------------------------------------------------------
// ALERT CONTENT: every exit path of the needs-human persist step must carry a
// PR reference into the Slack alert.
//
// `PR_URL` for the "Alert on needs-human decision" step comes from
// `steps.needs_human_pr.outputs.url`, which used to be written ONLY at the very
// end of the persist step, after `gh pr create`. That step has THREE early
// `exit 0` returns (no new commit; changeset-key dedup hit; per-note dedup hit)
// and none of them wrote `url=` — so the alert fell through to its contentless
// variant. The dedup path even HAD the PR number in `$DUP` and discarded it.
//
// That is why six consecutive days of "needs a human decision" alerts named no
// PR: run 30429968759 opened #343 and its alert carried the link, and every run
// after it took a dedup path and went contentless.
// ---------------------------------------------------------------------------
describe("fix-drift.yml — the needs-human alert always names a PR", () => {
  const persistStep = () => {
    const s = stepBlocks().find(
      (b) => b.includes("steps.sync.outputs.reason == 'needs-human'") && b.includes("gh pr create"),
    );
    expect(s).toBeDefined();
    return s!;
  };

  it("EVERY early return in the persist step emits the PR immediately before exiting", () => {
    const lines = persistStep().split("\n");
    const exits = lines.flatMap((l, i) => (/^\s*exit 0\s*$/.test(l) ? [i] : []));
    expect(exits.length, "expected the documented early-return paths").toBeGreaterThanOrEqual(3);

    for (const i of exits) {
      // Look back over the guard body (skipping the echo that explains the
      // skip) for the emit_pr that hands the PR to the Slack alert.
      const window = lines.slice(Math.max(0, i - 3), i).join("\n");
      expect(
        window,
        `\`exit 0\` at line ${i + 1} of the persist step returns without emit_pr — ` +
          "the Slack alert is then left with no PR to name",
      ).toMatch(/emit_pr "/);
    }
  });

  it("the PR lookup is hoisted ABOVE the no-new-commit guard, so that path can name a PR too", () => {
    const persist = persistStep();
    const lookupIdx = persist.indexOf("gh pr list");
    const noNewCommitIdx = persist.indexOf('if [ "$HEAD_SHA" = "$BASE_SHA" ]');
    expect(lookupIdx).toBeGreaterThan(-1);
    expect(noNewCommitIdx).toBeGreaterThan(-1);
    expect(lookupIdx).toBeLessThan(noNewCommitIdx);
  });

  it("the persist step exports a PR number alongside the url so the alert can say #N", () => {
    expect(persistStep()).toMatch(/echo "number=/);
  });

  it("the alert step renders the PR number and url when it has them", () => {
    const alert = stepBlocks().find((b) => b.startsWith("Alert on needs-human decision"));
    expect(alert).toBeDefined();
    expect(alert!).toContain("PR_NUMBER: ${{ steps.needs_human_pr.outputs.number }}");
    expect(alert!).toMatch(/#\$\{PR_NUMBER/);
  });

  it("the alert's no-PR fallback no longer claims the note is 'already proposed in an open PR'", () => {
    // With the lookup hoisted, an already-proposed note ALWAYS yields a url —
    // so reaching the fallback means the opposite of what it used to claim.
    const alert = stepBlocks().find((b) => b.startsWith("Alert on needs-human decision"));
    expect(alert).toBeDefined();
    expect(alert!).not.toContain("already proposed in an open PR");
  });

  it("every `gh pr list` used for de-dup or PR matching passes an explicit --limit", () => {
    // `gh pr list` defaults to 30. Once 30 newer PRs exist, an older
    // already-proposed PR falls out of the window, the dedup guards miss it,
    // and the workflow opens a duplicate.
    const calls = wfFlat.match(/gh pr list[^|]*?--json [a-zA-Z,]+/g) || [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toMatch(/--limit \d+/);
  });
});
