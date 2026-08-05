/**
 * Assertions on .github/workflows/fix-drift.yml.
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
 *   - a drift-sync CRASH is audible, and every Slack alert renders a real line
 *     break rather than the two characters `\n`.
 *
 * Most guards here are text-shape assertions on the committed workflow. The two
 * behavioural ones EXECUTE the step's own `run:` body under bash and read the
 * result, because no amount of pattern-matching can distinguish a literal `\n`
 * from a `${NL}` holding a newline, or tell whether a crashing sync leaves the
 * step green. The repo ships no YAML dependency and this suite adds none; an
 * actionlint run in CI covers structural validity separately.
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
      // FLOW sequence: `workflows: ["Drift Tests"]`.
      const flow = /^ {4}workflows:\s*\[(.*)\]\s*$/.exec(line);
      if (flow) {
        workflowRunWorkflows.push(
          ...flow[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")),
        );
        continue;
      }
      // BLOCK sequence, the equally-valid spelling this guard used to be blind
      // to (re-adding the double-fire trigger as `workflows:` + `- Drift Tests`
      // kept the double-fire guard GREEN):
      //
      //   workflow_run:
      //     workflows:
      //       - Drift Tests
      if (/^ {4}workflows:\s*$/.test(line)) {
        for (let j = i + 1; j < lines.length; j++) {
          const item = /^ {6,}- (.*)$/.exec(lines[j]);
          if (!item) break;
          workflowRunWorkflows.push(item[1].trim().replace(/^["']|["']$/g, ""));
        }
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
  /** The step's `env:` mapping, values unexpanded (`${{ … }}` as written). */
  env: Record<string, string>;
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

    const step: Step = { env: {}, run: "", runIndent: 0 };
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
          const em = /^\s*([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(body[j]);
          if (em) step.env[em[1]] = em[2];
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
 * A step's run body with shell COMMENT lines removed.
 *
 * Every "does this step do X" question has to be asked of the code, not the
 * prose: the persist step's rationale comment mentions `gh pr create`, so a
 * guard that greps the whole body stays green with the actual call deleted.
 */
const codeOf = (s: Step): string =>
  runOf(s)
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

/** The named step, or a failed expectation naming what was looked for. */
function stepByName(name: string, src: string = wf): Step {
  const hits = steps(src).filter((s) => s.name === name);
  if (hits.length !== 1) throw new Error(`fix-drift.yml: ${hits.length} steps named ${name}`);
  return hits[0];
}

/**
 * EXECUTE the sync step's own `run:` body against a stand-in drift-sync, and
 * report what the runner would see.
 *
 * This is an OBSERVATION, not an assertion about the body's text: the step is run
 * under bash with `npx` replaced by `npxStub`. The default stub stands in for
 * drift-sync.ts's fatal handler (`drift-sync fatal error: …` on stderr, exit 1 —
 * it fires before the first `console.log`, because runDriftSyncCli awaits every
 * provider's churn input up front), so a CRASH prints no `reason=` line at all.
 * Whatever the step then does with that output — swallow it or propagate it — is
 * measured, not guessed.
 */
function observeSyncStep(
  src: string = wf,
  npxStub = "#!/bin/sh\necho 'drift-sync fatal error: fetch failed' >&2\nexit 1\n",
): {
  stepExit: number;
  outputs: Record<string, string>;
  stdio: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "fix-drift-crash-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "npx"), npxStub, { mode: 0o755 });
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
  const last = lines.findIndex((l) => /\bPAYLOAD=/.test(l)) - 1;
  if (last < 0) throw new Error(`${step.name}: no PAYLOAD= assembly to slice at`);
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
    for (const key of Object.keys(step.env)) env[key] = `<${key}>`;
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
    // The bare `- uses:` steps (checkout, pnpm, setup-node) have no `name:`. A
    // slicer that only breaks on `- name:` silently MERGES them into the step
    // above, which would hand a neighbouring step's body to the executors.
    expect(
      steps().filter((s) => s.name === undefined).length,
      "the slicer sees no unnamed `- uses:` step — it is merging steps together",
    ).toBeGreaterThan(0);
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
// body against a crashing drift-sync (`observeSyncStep`) and takes the
// step's real exit status and real `$GITHUB_OUTPUT` as the finding; the alert
// side is then checked against the artifact's OWN `if:` text, so the reason the
// step publishes must be one an alert step is actually keyed on.
// ---------------------------------------------------------------------------
describe("fix-drift.yml — M1: a drift-sync CRASH cannot end green and silent", () => {
  /** Steps that exist to tell a human something (Slack + `::error::`). */
  const alertSteps = () => steps().filter((s) => /^(Alert|Notify)\b/.test(s.name ?? ""));

  it("the crash is observable in the step's captured outputs at all", () => {
    const obs = observeSyncStep();
    expect(obs.stdio).toContain("drift-sync fatal error");
    // drift-sync's real exit code is captured even though the step may swallow it.
    expect(obs.outputs.exit_code).toBe("1");
  });

  it("the crash makes the STEP itself fail, so the job cannot conclude green", () => {
    const obs = observeSyncStep();
    expect(
      obs.stepExit,
      `drift-sync crashed (exit_code=${obs.outputs.exit_code}) but the sync STEP exited 0 ` +
        `and published reason=${JSON.stringify(obs.outputs.reason ?? "")}. The job then ` +
        "concludes GREEN, every reason-keyed alert `if:` is false, and the end-of-job " +
        "catch-all needs failure() — so the daily unattended sync crashes in silence.",
    ).not.toBe(0);
  });

  it("the reason the crash publishes is one an alert step is KEYED ON", () => {
    const obs = observeSyncStep();
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
    // An `on.workflow_run` with NO `workflows:` list keys off EVERY workflow, so
    // an unreadable or absent list counts as covering Drift Tests. Fail closed:
    // the only way this leg does NOT count is a list that names other workflows
    // and not this one.
    const workflowRunFires =
      names.includes("workflow_run") &&
      (workflowRunWorkflows.length === 0 || workflowRunWorkflows.includes("Drift Tests"));

    const firesOnDriftFailure = [
      names.includes("schedule") ? "schedule" : null,
      workflowRunFires ? `workflow_run(${JSON.stringify(workflowRunWorkflows)})` : null,
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
    // The SYNC step's own body. This used to be matched against the whole
    // flattened file, where the ASSERT step's `echo "reason=…" >> $GITHUB_OUTPUT`
    // satisfied it — so the sync step could stop publishing a reason entirely and
    // the guard stayed green.
    const body = codeOf(stepById("sync"));
    expect(body).toMatch(/grep '\^reason=' "\$\{SYNC_LOG\}"/);
    expect(body, "the sync step publishes no reason= output").toMatch(/echo "reason=\$\{REASON\}"/);
    expect(body, "the sync step's outputs never reach $GITHUB_OUTPUT").toContain(
      '>> "$GITHUB_OUTPUT"',
    );
  });

  it("runs scripts/drift-sync-check.ts as a defense-in-depth re-assertion, gated on reason == 'ok-applied'", () => {
    const assertStep = stepById("assert");
    expect(assertStep.name).toBe("Assert drift-sync-check (defense-in-depth)");
    expect(
      assertStep.if,
      "the defense-in-depth re-assert is not gated on an ok-applied sync, so it " +
        "runs (and can fail the job) on runs that applied nothing",
    ).toBe("steps.sync.outputs.reason == 'ok-applied'");
    expect(codeOf(assertStep)).toContain("npx tsx scripts/drift-sync-check.ts");
  });

  it("the PR-open step is gated on reason == 'ok-applied', not on a verdict function", () => {
    const pr = stepByName("Push branch + create PR");
    expect(pr.if).toBe("steps.sync.outputs.reason == 'ok-applied' && success()");
    expect(codeOf(pr), "the PR-open step does not open a PR").toMatch(/^\s*gh pr create\b/m);
  });
});

describe("fix-drift.yml — needs-human vs gate-failure are DISTINCT alerts", () => {
  it("alerts distinctly when the sync routes to a human decision (new family / still-referenced deprecation)", () => {
    expect(
      stepByName("Alert on needs-human decision").if,
      "the needs-human alert is not keyed on the needs-human reason",
    ).toContain("steps.sync.outputs.reason == 'needs-human'");
  });

  it("alerts distinctly (and separately) when drift-sync-check refuses the gate — a tooling fault, not a product decision", () => {
    expect(
      stepByName("Alert on drift-sync-check gate failure").if,
      "the gate-failure alert is not keyed on the gate-failed reason",
    ).toContain("steps.sync.outputs.reason == 'gate-failed'");
  });

  it("both needs-human and gate-failure alerts fail the job (non-green), so a human sees it in CI status too", () => {
    // The LAST statement, not merely an `exit 1` somewhere: both bodies already
    // carry a conditional `exit 1` in their missing-webhook branch, so a guard
    // that only looks for one stays green on a step that posts and then exits 0.
    for (const name of [
      "Alert on needs-human decision",
      "Alert on drift-sync-check gate failure",
    ]) {
      const last = codeOf(stepByName(name))
        .split("\n")
        .filter((l) => l.trim() !== "")
        .pop();
      expect(
        last,
        `${name}: does not END in \`exit 1\`, so the alert posts to Slack and the job ` +
          "still concludes green — the decision is invisible in CI status",
      ).toBe("exit 1");
    }
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
    // The step must import the outcomes of both the assert step and the PR step
    // so its message can distinguish "assert refused" from "push/PR creation
    // failed" rather than sending a single generic message.
    const gate = stepByName("Alert on drift-sync-check gate failure");
    const env = Object.values(gate.env);
    expect(env, "the gate alert cannot see the assert step's outcome").toContain(
      "${{ steps.assert.outcome }}",
    );
    expect(env, "the gate alert cannot see the PR step's outcome").toContain(
      "${{ steps.pr.outcome }}",
    );
    // …and its ASSEMBLED message must NAME the failing one. Executed, because a
    // substring check on `FAILING_STEP` passes on a body where every arm sets the
    // same text (or where one arm has been renamed out of use).
    const windows = {
      "drift-sync crashed": { SYNC_REASON: "sync-crashed", ASSERT_OUTCOME: "", PR_OUTCOME: "" },
      "assert refused": {
        SYNC_REASON: "ok-applied",
        ASSERT_OUTCOME: "failure",
        PR_OUTCOME: "",
        NEEDS_HUMAN_PR_OUTCOME: "",
      },
      "push/PR-create failed": {
        SYNC_REASON: "ok-applied",
        ASSERT_OUTCOME: "success",
        PR_OUTCOME: "failure",
        NEEDS_HUMAN_PR_OUTCOME: "",
      },
    };
    const assembled = Object.fromEntries(
      Object.entries(windows).map(([label, env]) => [label, assembleSlackMessage(gate, env)]),
    );
    const distinct = new Set(Object.values(assembled));
    expect(
      distinct.size,
      "the gate-failure alert sends the same message for a sync crash, a refused " +
        `assert and a failed push:\n${JSON.stringify(assembled, null, 2)}`,
    ).toBe(Object.keys(windows).length);
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
/**
 * The needs-human persist step and the ok-applied push+PR step, addressed by id
 * and read on their CODE surface.
 *
 * These used to be found by grepping every step's whole text for `gh pr create`.
 * The persist step's rationale comment says `gh pr create`, so replacing the
 * actual call with `true` left every one of those guards green.
 */
const persistStep = () => stepById("needs_human_pr");
const okAppliedStep = () => stepById("pr");

describe("fix-drift.yml — needs-human notes are PERSISTED (pushed + PR'd), not discarded", () => {
  it("has a step gated on reason == 'needs-human' that pushes a branch AND opens a PR (so the note reaches the repo)", () => {
    // Concept-level: SOME step must both be conditioned on the needs-human
    // outcome and perform a git push + `gh pr create`. Pre-fix, the only
    // `gh pr create` lives in the ok-applied "Push branch + create PR" step,
    // so this finds nothing and FAILS (RED).
    const persistSteps = steps().filter(
      (st) =>
        (st.if ?? "").includes("steps.sync.outputs.reason == 'needs-human'") &&
        /^\s*git push\b/m.test(codeOf(st)) &&
        /^\s*gh pr create\b/m.test(codeOf(st)),
    );
    expect(
      persistSteps.map((st) => st.name),
      "no step both keys off the needs-human reason and actually pushes a branch " +
        "and opens a PR — the note never reaches the repo",
    ).not.toEqual([]);
  });

  it("the needs-human persist step uses a DISTINCT branch (not colliding with the ok-applied fix/drift-* branch)", () => {
    // The BRANCH= assignment itself, not "the string appears somewhere in the
    // step": the temp PR-body filename also contains `drift-needs-human`, so a
    // whole-block match stayed green with the branch renamed to `fix/drift-*`.
    const assigns = codeOf(persistStep())
      .split("\n")
      .filter((l) => /^\s*BRANCH=/.test(l));
    expect(assigns, "the persist step assigns no BRANCH").not.toEqual([]);
    for (const a of assigns) {
      expect(
        a,
        `the needs-human branch is ${a.trim()} — it must not share the ok-applied ` +
          "step's `fix/drift-*` namespace, or the two PR classes collide",
      ).toMatch(/BRANCH="drift-needs-human\//);
    }
  });

  it("the needs-human persist step de-dups: it skips opening a second PR when one is already open for the same note", () => {
    const body = codeOf(persistStep());
    // Must consult already-open PRs before creating a new one…
    expect(body).toMatch(/^\s*if ! ALL_PRS="\$\(gh pr list --state all /m);
    // …and the per-note scan must iterate the notes this run committed, not an
    // empty list. Scoped to the DEDUP region (between the git-diff scan and the
    // branch it pushes): the PR-body writer further down loops over the same
    // variable, so a whole-body match stayed green with the dedup loop gutted.
    const scanIdx = body.search(/^\s*mapfile -t COMMITTED < <\(git diff --name-only /m);
    const branchIdx = body.search(/^\s*BRANCH="/m);
    expect(scanIdx, "the persist step never lists the notes this run committed").toBeGreaterThan(
      -1,
    );
    expect(branchIdx, "the persist step pushes no branch").toBeGreaterThan(scanIdx);
    const dedupRegion = body.slice(scanIdx, branchIdx);
    expect(
      dedupRegion,
      "the per-note dedup loop does not iterate the committed notes, so a note a " +
        "still-open PR already proposes gets a second PR",
    ).toMatch(/for i in "\$\{!NOTES\[@\]\}"; do/);
    expect(dedupRegion, "the per-note dedup does not match on the note-path marker").toContain(
      "${NOTE_MARKERS[$i]}",
    );
    // …and the jq filter must match on that marker, not on some other literal.
    expect(dedupRegion, "the per-note dedup query does not test the marker it was given").toContain(
      "contains($m)",
    );
  });

  it("the needs-human persist step's PR body tells a human to set Decision: include and merge (closing the two-run loop), never auto-merged", () => {
    const body = codeOf(persistStep());
    expect(body).toContain("Decision: include");
    // No `gh pr merge` anywhere (asserted globally too) — human merges.
    expect(body).not.toMatch(/gh pr merge/);
  });

  it("the needs-human persist step's OWN failure is alerted (gate-failure alert references its outcome)", () => {
    // In the `if:`, not merely somewhere in the step: the step also imports that
    // outcome as env, so a whole-block grep stays green with the gate removed.
    expect(
      stepByName("Alert on drift-sync-check gate failure").if,
      "a failure of the needs-human persist step is not covered by any alert",
    ).toContain("steps.needs_human_pr.outcome == 'failure'");
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
    const persist = persistStep();
    // Keyed on the changeset key wired from the sync step.
    expect(persist.env.CHANGESET_KEY).toBe("${{ steps.sync.outputs.changeset_key }}");
    const body = codeOf(persist);
    expect(body).toContain("drift-changeset: ${CHANGESET_KEY}");
    // CRITICAL: the changeset-key dedup guard must appear BEFORE the
    // `mapfile ... NOTES` scan. Pre-fix, the ONLY dedup lived inside the
    // per-note for-loop, reachable only when a note file was in the diff —
    // exactly what the empty-NOTES mixed run bypasses.
    const guardIdx = body.indexOf("drift-changeset: ${CHANGESET_KEY}");
    const mapfileIdx = body.indexOf("mapfile -t COMMITTED");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(mapfileIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(mapfileIdx);
  });

  it("the ok-applied Push+PR step ALSO de-dups on the changeset key (a never-auto-merged applied edit deserves exactly ONE open PR, re-findable across daily re-fires)", () => {
    const okApplied = okAppliedStep();
    expect(okApplied.if).toContain("steps.sync.outputs.reason == 'ok-applied'");
    expect(okApplied.env.CHANGESET_KEY).toBe("${{ steps.sync.outputs.changeset_key }}");
    const body = codeOf(okApplied);
    // The DUP candidate has to be computed from the open-PR payload. `DUP=""`
    // left the skip branch standing but permanently dead, and every
    // string-shaped guard here stayed green.
    expect(body, "the ok-applied dedup does not query PRs").toMatch(
      /^\s*if ! ALL_PRS="\$\(gh pr list --state all /m,
    );
    expect(body, "the ok-applied dedup never derives a duplicate from them").toMatch(
      /DUP="\$\(printf '%s' "\$ALL_PRS"[\s\S]*--arg m "\$MARKER"/,
    );
    // The dedup skip must precede the push (skip a duplicate BEFORE pushing).
    const guardIdx = body.indexOf("not opening a duplicate");
    const pushIdx = body.indexOf("git push -u origin");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(pushIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(pushIdx);
  });

  it("the needs-human persist step RETAINS the per-note body marker as a secondary guard (note-path de-dup not regressed)", () => {
    const body = codeOf(persistStep());
    // The marker text has ONE source (NOTE_MARKERS), so the guard is that the
    // dedup query still reads it. Gutting the dedup loop leaves only the source.
    expect(body, "the per-note marker is no longer built from the committed notes").toContain(
      'NOTE_MARKERS+=("drift-proposal-note: ${note}")',
    );
    expect(
      body,
      "the per-note marker is built but never matched — the secondary note-path " +
        "dedup has regressed",
    ).toContain('--arg m "${NOTE_MARKERS[$i]}"');
  });

  it("BOTH PR bodies embed the stable drift-changeset marker the dedup guards match on", () => {
    // Each step builds the marker once and emits its MARKERS array into the body,
    // so both halves have to be present in both steps.
    expect((wf.match(/MARKER="drift-changeset: \$\{CHANGESET_KEY\}"/g) || []).length).toBe(2);
    expect((wf.match(/echo "<!-- \$\{m\} -->"/g) || []).length).toBe(2);
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

  it("DRIFT.md does not tell a maintainer that Fix Drift runs on a failed Drift Tests run", () => {
    // The doc described the `workflow_run` leg for as long as it existed. A
    // maintainer following a doc that still describes it re-adds the trigger and
    // with it the second run — and the second Slack alert — every red morning.
    const driftMd = readFileSync(resolve(__dirname, "../../DRIFT.md"), "utf-8");
    const declared = parseTriggers(wf).names;
    if (!declared.includes("workflow_run")) {
      expect(
        driftMd,
        "DRIFT.md still describes a `Drift Tests`-failure trigger the workflow no " +
          "longer declares — following the doc re-creates the double-fire",
      ).not.toMatch(/on a failed `?Drift\s+Tests`? run/);
    }
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
  const alertStep = () => stepByName("Alert on needs-human decision");

  it("EVERY early return in the persist step emits the PR immediately before exiting", () => {
    const lines = codeOf(persistStep()).split("\n");
    const exits = lines.flatMap((l, i) => (/^\s*exit 0\s*$/.test(l) ? [i] : []));
    expect(exits.length, "expected the documented early-return paths").toBeGreaterThanOrEqual(3);

    for (const i of exits) {
      // Look back over the guard body (skipping the echo that explains the
      // skip) for the emit_pr that hands the PR to the Slack alert.
      const window = lines.slice(Math.max(0, i - 2), i).join("\n");
      expect(
        window,
        `\`exit 0\` at line ${i + 1} of the persist step returns without emit_pr — ` +
          "the Slack alert is then left with no PR to name",
      ).toMatch(/emit_pr "/);
    }
  });

  it("the PR lookup is hoisted ABOVE the no-new-commit guard, so that path can name a PR too", () => {
    const body = codeOf(persistStep());
    const lookupIdx = body.indexOf("gh pr list");
    const noNewCommitIdx = body.indexOf('if [ "$HEAD_SHA" = "$BASE_SHA" ]');
    expect(lookupIdx, "the persist step never queries open PRs").toBeGreaterThan(-1);
    expect(noNewCommitIdx, "the no-new-commit guard is gone").toBeGreaterThan(-1);
    expect(
      lookupIdx,
      "the open-PR lookup happens AFTER the no-new-commit early return, so the " +
        "daily re-fire of an already-persisted note exits with no PR to name and " +
        "the Slack alert goes out contentless",
    ).toBeLessThan(noNewCommitIdx);
  });

  it("the persist step exports a PR number alongside the url so the alert can say #N", () => {
    expect(codeOf(persistStep()), "the persist step publishes no PR number").toMatch(
      /^\s*echo "number=/m,
    );
  });

  it("the alert step renders the PR number and url when it has them", () => {
    const alert = alertStep();
    expect(alert.env.PR_NUMBER).toBe("${{ steps.needs_human_pr.outputs.number }}");
    expect(alert.env.PR_URL).toBe("${{ steps.needs_human_pr.outputs.url }}");
    expect(codeOf(alert)).toMatch(/#\$\{PR_NUMBER/);
  });

  it("the alert's no-PR fallback no longer claims the note is 'already proposed in an open PR'", () => {
    // With the lookup hoisted, an already-proposed note ALWAYS yields a url —
    // so reaching the fallback means the opposite of what it used to claim.
    expect(codeOf(alertStep())).not.toContain("already proposed in an open PR");
  });

  it("every `gh pr list` used for de-dup or PR matching passes an explicit --limit", () => {
    // `gh pr list` defaults to 30. Once 30 newer PRs exist, an older
    // already-proposed PR falls out of the window, the dedup guards miss it,
    // and the workflow opens a duplicate.
    // Per invocation, from each step's own code surface with backslash line
    // continuations joined. The old form matched `gh pr list[^|]*?--json …`
    // against the whole flattened file, so an invocation whose `--json` came
    // after a `|` — or that had none — was never examined at all.
    const calls = steps().flatMap((st) =>
      (
        codeOf(st)
          .replace(/\\\n\s*/g, " ")
          // An INVOCATION: command substitution, or the first word of a line.
          // `gh pr list` also appears inside `::error::` prose, which is not a
          // call and must not be examined as one.
          .match(/(?:\$\(|^\s*)gh pr list[^\n|;)]*/gm) || []
      ).map((c) => ({ step: st.name, call: c.replace(/^\$\(/, "").trim() })),
    );
    expect(calls.length, "no `gh pr list` invocation found at all").toBeGreaterThan(0);
    for (const { step, call } of calls) {
      expect(
        call,
        `${step}: \`${call}\` has no --limit. gh pr list defaults to 30, so once 30 ` +
          "newer PRs exist an already-proposed PR falls out of the window, the dedup " +
          "misses it, and the workflow opens a duplicate",
      ).toMatch(/--limit \d+/);
    }
  });
});

// ---------------------------------------------------------------------------
// A provider whose credential is UNUSABLE is not evidence that nothing drifted.
//
// fetchProviderChurnInput turns an unusable key into a SKIP, not an error: a
// missing key becomes "<ENV> not set", and isInfraSkip() absorbs 401/402/403, so
// a revoked key becomes an "infra error (status 401)" skip. With every provider
// skipped the core has no live listing to diff, reports ok-no-churn and exits 0
// — byte-for-byte identical to a genuinely quiet day. This EXECUTES the sync
// step against that output and reads what the runner would see.
// ---------------------------------------------------------------------------
describe("fix-drift.yml — an unusable provider credential cannot read as 'no drift'", () => {
  /** drift-sync's real skip line (scripts/drift-sync.ts) for a revoked key. */
  const REVOKED_KEY_SYNC = [
    "#!/bin/sh",
    "echo '  [skipped] google: infra error (status 401) fetching live /models for google — never mass-removing off a failed listing'",
    "echo 'reason=ok-no-churn'",
    "echo 'changeset-key='",
    "exit 0",
  ].join("\n");

  it("a revoked key reported as ok-no-churn fails the step and raises an alert", () => {
    const obs = observeSyncStep(wf, REVOKED_KEY_SYNC);
    const reason = obs.outputs.reason ?? "";
    expect(
      reason,
      "drift-sync skipped a provider on a 401 and reported ok-no-churn, and the step " +
        "republished ok-no-churn unchanged — 'nothing changed' here means 'could not " +
        "look', so a revoked key silently disables the sync for good.",
    ).not.toBe(SyncCoreReason.OK_NO_CHURN);
    expect(
      obs.stepExit,
      `the step exited 0 having published reason=${JSON.stringify(reason)}, so the job ` +
        "concludes GREEN on a sync that never actually checked the provider",
    ).not.toBe(0);
    const keyed = steps()
      .filter((s) => /^(Alert|Notify)\b/.test(s.name ?? ""))
      .filter((s) => (s.if ?? "").includes(`'${reason}'`));
    expect(
      keyed.map((s) => s.name),
      `the step publishes reason='${reason}' for an unchecked provider, but no alert ` +
        "step's `if:` mentions it — the reason is published into a void",
    ).not.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Both dedup guards match an HTML comment this workflow wrote into a PR BODY —
// machine state parked inside prose a HUMAN owns. On 2026-08-03 a wholesale
// rewrite of PR #343's body deleted its markers and ~14h later the scheduled run
// opened duplicate PR #350 for the same changeset. And a CLOSED PR carrying the
// marker is a human REJECTION that an `--state open` listing cannot see, so
// rejecting a proposal used to guarantee an identical one the next morning.
// ---------------------------------------------------------------------------
describe("fix-drift.yml — dedup survives a human body edit and a CLOSED PR", () => {
  const prSteps = () => [stepById("pr"), stepById("needs_human_pr")];

  it("each PR-open step RE-ASSERTS its own body markers, keyed on state a body edit cannot touch", () => {
    for (const st of prSteps()) {
      const code = codeOf(st);
      expect(
        code,
        `${st.name}: never re-writes a PR body, so a human deleting a marker leaves ` +
          "dedup blind and the next run opens a duplicate",
      ).toMatch(/gh pr edit .*--body-file/);
      expect(
        code,
        `${st.name}: the marker repair does not restore the "<!-- … -->" marker form ` +
          "the dedup guards match on",
      ).toMatch(/<!-- \$\{m\} -->/);
      // The self-heal's own listing must NOT be `--search`: that index is
      // body-keyed AND lags an edit by minutes, so it cannot see the body being
      // repaired. Identity comes from the head branch instead, which a PR cannot
      // rename — so the branch this step pushes must CARRY the changeset key.
      const heal = code.slice(0, code.indexOf("gh pr edit"));
      expect(
        heal,
        `${st.name}: the candidate listing for the marker repair uses --search, whose ` +
          "body-keyed index cannot see the very body being repaired",
      ).toMatch(/gh pr list --state open(?![\s\S]*--search[\s\S]*gh pr edit)/);
      expect(
        code,
        `${st.name}: the pushed branch does not end in the changeset key, so the marker ` +
          "repair has no body-independent anchor to recognise its own PR by",
      ).toMatch(/BRANCH="[^"\n]*\$\{CHANGESET_KEY\}"/);
    }
  });

  it("each dedup listing sees CLOSED PRs, and a closed marker-carrying PR is not re-proposed", () => {
    for (const st of prSteps()) {
      const code = codeOf(st);
      const dedup = code.slice(code.indexOf("gh pr edit"));
      expect(
        dedup,
        `${st.name}: the dedup listing is scoped to open PRs, so the moment a human ` +
          "CLOSES a proposal to reject it the next cron run stops seeing it and opens a " +
          "fresh one — daily, forever",
      ).toMatch(/gh pr list --state all[\s\S]*--search "\$\{CHANGESET_KEY\} in:body"/);
      expect(
        dedup,
        `${st.name}: never selects a CLOSED marker-carrying PR, so a human rejection is ` +
          "not respected",
      ).toMatch(/\.state == "CLOSED"/);
      expect(
        dedup,
        `${st.name}: finds a human-rejected changeset but does not stop before pushing`,
      ).toMatch(/rejected=\$\{REJECTED\}/);
    }
    expect(
      stepByName("Alert on needs-human decision").if ?? "",
      "the needs-human alert still fires for a changeset a human already rejected — " +
        "re-alerting every morning is the spam that made following the instruction a " +
        "punishment",
    ).toContain("steps.needs_human_pr.outputs.rejected == ''");
  });
});

// ---------------------------------------------------------------------------
// Three fail-silent repairs this suite could not previously detect: reverting
// any of them passed the whole suite.
// ---------------------------------------------------------------------------
describe("fix-drift.yml — fail-silent repairs a revert must not be able to pass", () => {
  it("every jq read of a PR body defaults a NULL body to the empty string", () => {
    // `.body | contains($m)` THROWS on `body: null`, which GitHub returns for a
    // PR with an empty description — one such PR anywhere in the listing killed
    // every dedup query at once (jq error, step exit 5).
    const reads = [...wf.matchAll(/\.body\b(?!\s*(?:=[^=]|\/\/ ""))/g)];
    expect(
      reads.map((m) => wf.slice(m.index, m.index + 60)),
      'a jq program reads `.body` without a `// ""` default, so a single PR with an ' +
        "empty description takes the whole dedup query down",
    ).toEqual([]);
  });

  it("a DROPPED Slack notification fails its step rather than ending the job green", () => {
    const slack = steps().filter(
      (s) => runOf(s).includes("SLACK_WEBHOOK") && /\bMSG=/.test(runOf(s)),
    );
    expect(slack.length, "no Slack-posting step found").toBeGreaterThan(0);
    for (const st of slack) {
      const branch = /if \[ -z "\$\{SLACK_WEBHOOK:-\}" \]; then\n([\s\S]*?)\n *fi/.exec(codeOf(st));
      expect(branch, `${st.name}: no missing-webhook branch to check`).not.toBeNull();
      expect(
        branch![1],
        `${st.name}: a missing webhook means the notification was DROPPED, and exiting 0 ` +
          "leaves the job green while nobody is told",
      ).toMatch(/^\s*exit 1$/m);
    }
  });

  it("both PR-open paths REFUSE to run dedup-blind on an empty changeset key", () => {
    for (const st of [stepById("pr"), stepById("needs_human_pr")]) {
      const code = codeOf(st);
      const at = code.indexOf('if [ -z "${CHANGESET_KEY:-}" ]; then');
      expect(
        at,
        `${st.name}: an EMPTY changeset key silently switches the PRIMARY dedup guard ` +
          "off (`if [ -n … ]`) and falls through to an unconditional push + PR",
      ).toBeGreaterThanOrEqual(0);
      const guard = code.slice(at, code.indexOf("\n          fi", at));
      expect(
        guard,
        `${st.name}: the empty-changeset-key branch does not fail the step, so the run ` +
          "still pushes with no dedup",
      ).toMatch(/^\s*exit 1$/m);
      for (const call of ["git push", "gh pr create"]) {
        const c = code.indexOf(call);
        if (c === -1) continue;
        expect(
          at,
          `${st.name}: the empty-changeset-key refusal comes AFTER \`${call}\`, so the ` +
            "duplicate is already open by the time it fires",
        ).toBeLessThan(c);
      }
    }
  });
});
