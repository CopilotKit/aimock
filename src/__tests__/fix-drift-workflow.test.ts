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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, describe, it, expect, vi } from "vitest";

import {
  SyncCoreReason,
  UNCHECKED_PROVIDERS_LINE_PREFIX,
  formatUncheckedProvidersLine,
  infraSkipReason,
  isCredentialUnusableSkip,
  missingKeySkipReason,
} from "../../scripts/drift-sync.js";

// Most guards here match text, but the load-bearing ones EXECUTE a workflow
// body under bash — which is orders of magnitude slower than a substring test.
// `vitest.config.ts` sets no `testTimeout`, so the default 5000ms applied, and
// the alert-delivery guard measured 4109ms of it on an IDLE 18-core machine and
// exceeded it under load. A guard whose RED cannot be told apart from a timeout
// proves nothing — worse, it teaches people to re-run CI, which is the alert
// fatigue this whole workflow is being fixed for, relocated into CI. So the
// budget for THIS file is stated, generously, rather than inherited by
// accident. The observations' own cost is cut separately (see `delegatingBin`).
vi.setConfig({ testTimeout: 30_000 });

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

/**
 * The `sync` JOB's own `permissions:` mapping, scope -> level.
 *
 * Read from the JOB's node (a `permissions:` at four-space indent), NOT from the
 * first `indexOf("permissions:")` — that one is the WORKFLOW-level block, and a
 * guard that slices from it reports the workflow's grants while claiming to
 * describe the job's. Comments are skipped so a hand-re-widening under one
 * cannot hide.
 */
function jobPermissions(src: string = wf): Record<string, string> {
  const lines = src.split("\n");
  const at = lines.findIndex((l) => /^ {4}permissions:/.test(l));
  if (at === -1) throw new Error("fix-drift.yml: the sync job declares no `permissions:`");
  const out: Record<string, string> = {};
  for (let i = at + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    if (indentOf(lines[i]) <= 4) break;
    if (/^\s*#/.test(lines[i])) continue;
    const m = /^\s*["']?([A-Za-z-]+)["']?:\s*["']?([A-Za-z-]+)["']?\s*$/.exec(lines[i]);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** The `sync` job's `if:` gate, as a single flattened expression string. */
function syncJobIf(src: string): string {
  const idx = src.indexOf("    if: >-");
  if (idx === -1) throw new Error("fix-drift.yml: no `sync` job `if:` gate found");
  return src.slice(idx, locate(src, "runs-on:", "syncJobIf", idx)).replace(/\s+/g, " ");
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
  /** The action a `uses:` step invokes, as written — so job ORDER can name it. */
  uses?: string;
  /** Indent the `run:` block carried in the file, for the verbatim check. */
  runIndent: number;
  /**
   * `continue-on-error:`, as written.
   *
   * Read because it is the ONLY mechanism in Actions that decouples a step's
   * `outcome` from the job's status: with it, a step can exit non-zero (so
   * `outcome == 'failure'`) while the job still concludes SUCCESS, making
   * `failure()` false. Three of this workflow's claims — a sync crash cannot end
   * green, a post-assert failure still alerts, an alert's `exit 1` reds the run —
   * rest on that not being true, and a simulation that does not parse the key
   * cannot see it being added.
   */
  continueOnError?: string;
}

const indentOf = (l: string): number => l.length - l.trimStart().length;

/**
 * `src.indexOf(needle, from)` where a MISSING needle THROWS instead of yielding -1.
 *
 * Every locator in this file that feeds a slice bound or an ordering comparison
 * goes through here. `String.prototype.indexOf` returning -1 is the root cause of
 * the vacuous-guard class this suite was rebuilt to kill: `slice(at, -1)` spans
 * everything but the last character (one guard thereby swallowed 6197 of the 6198
 * remaining characters of the `pr` step and was satisfied by 7 unrelated
 * `exit 1`s), and an ordering comparison against -1 silently inverts the very
 * fact it asserts. A guard whose locator fails OPEN proves nothing.
 *
 * Boolean "is it present" tests are a different thing and are written as an
 * explicit `=== -1` / `>= 0` check at the call site; this is only for the cases
 * where -1 would change the guard's MEANING rather than answer its question.
 */
function locate(src: string, needle: string, label: string, from = 0): number {
  const at = src.indexOf(needle, from);
  if (at < 0)
    throw new Error(
      `${label}: cannot locate \`${needle}\` — refusing to derive a bound from a ` +
        "locator that did not find its needle",
    );
  return at;
}

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
          // An INLINE `run:` is a run body too. Dropping it made the git-push
          // credential injection (a one-liner) invisible to every guard that
          // reads step bodies — including the one asserting no push depends on
          // the ambient GITHUB_TOKEN.
          if (key === "run") step.run = inline + "\n";
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
      if (key === "uses") step.uses = inline.trim();
      if (key === "continue-on-error") step.continueOnError = inline.trim();
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

// ---------------------------------------------------------------------------
// SHELL-BLOCK SLICERS.
//
// Every guard that asks "does THIS branch fail closed" needs the branch, not the
// rest of the step. The previous versions derived a slice bound from an
// UNCHECKED `code.indexOf(…)`: when the needle was absent `indexOf` returned -1,
// `slice(at, -1)` spanned the whole remainder of the step, and an assertion for
// `exit 1` was then satisfied by any of the 7 (ok-applied) / 14 (needs-human)
// unrelated `exit 1`s further down. The refusal could be deleted outright and
// the guard still passed.
//
// So these slicers close on the block's OWN indentation and THROW when the
// closer is missing — a bound that cannot silently widen. The MODEL guards at
// the bottom of this file pin that throwing behaviour.
// ---------------------------------------------------------------------------

/** The `if … then … fi` block opened by `needle`, closed at the `if`'s own indent. */
function ifBlock(code: string, needle: string, label: string): string {
  const at = code.indexOf(needle);
  if (at === -1) throw new Error(`${label}: no \`${needle}\` to slice`);
  // `lastIndexOf` is the ONE locator here whose -1 is correct rather than
  // dangerous: the needle sitting on the first line yields -1, and `+1` makes
  // that slice from 0 — exactly the intended start.
  const lines = code.slice(code.lastIndexOf("\n", at) + 1).split("\n");
  const closer = new RegExp(`^ {${indentOf(lines[0])}}fi\\s*$`);
  const end = lines.findIndex((l, i) => i > 0 && closer.test(l));
  if (end === -1)
    throw new Error(
      `${label}: the block opened by \`${needle}\` has no closing \`fi\` at its own ` +
        `indent — slicing to an unchecked indexOf() here swallows the whole rest of the step`,
    );
  return lines.slice(0, end + 1).join("\n");
}

/** The `while … done < <(…)` loop opened by `needle`, up to its process-substitution `done`. */
function whileLoop(code: string, needle: string, label: string): string {
  const at = code.indexOf(needle);
  if (at === -1) throw new Error(`${label}: no \`${needle}\` to slice`);
  // `lastIndexOf` is the ONE locator here whose -1 is correct rather than
  // dangerous: the needle sitting on the first line yields -1, and `+1` makes
  // that slice from 0 — exactly the intended start.
  const lines = code.slice(code.lastIndexOf("\n", at) + 1).split("\n");
  const end = lines.findIndex((l, i) => i > 0 && /^\s*done < <\(/.test(l));
  if (end === -1)
    throw new Error(`${label}: the loop opened by \`${needle}\` has no \`done < <(…)\``);
  return lines.slice(0, end + 1).join("\n");
}

/** The `{ … } > <redirect>` command group, matched on the closing brace's indent. */
function braceGroup(code: string, redirect: string, label: string): string {
  const lines = code.split("\n");
  const close = lines.findIndex((l) => l.trim() === `} > ${redirect}`);
  if (close === -1) throw new Error(`${label}: no \`} > ${redirect}\` command group`);
  const indent = indentOf(lines[close]);
  for (let i = close - 1; i >= 0; i--) {
    if (indentOf(lines[i]) === indent && lines[i].trim() === "{") {
      return lines.slice(i, close + 1).join("\n");
    }
  }
  throw new Error(
    `${label}: the \`} > ${redirect}\` group has no opening \`{\` at indent ${indent}`,
  );
}

/** The whole `curl` invocation (its continuation lines included) in `code`. */
function curlOf(code: string, label: string): string {
  const lines = code.split("\n");
  const start = lines.findIndex((l) => /^\s*curl\b/.test(l));
  if (start === -1) throw new Error(`${label}: no \`curl\` invocation`);
  let end = start;
  while (end < lines.length && /\\\s*$/.test(lines[end])) end++;
  return lines.slice(start, end + 1).join("\n");
}

/**
 * The INTEGER value curl is handed for `flag`, so a bound can be checked for
 * what it MEANS rather than for its shape. `--max-time 0` and `--retry 0` are
 * curl's own spellings of "no limit" and "no retries", and both satisfy a
 * `\d+` match — so a syntactic assertion accepts precisely the values that
 * delete the bound it was written to require.
 *
 * Throws when the flag is absent or its value is not a whole number of seconds:
 * a bound that cannot be read is not a bound.
 */
function curlFlagValue(cmd: string, flag: string, label: string): number {
  const m = new RegExp(`(?:^|\\s)${flag}[= ]+(\\S+)`).exec(cmd);
  if (m === null) throw new Error(`${label}: the POST carries no \`${flag}\``);
  if (!/^\d+$/.test(m[1]))
    throw new Error(`${label}: \`${flag} ${m[1]}\` is not a whole number of seconds`);
  return Number(m[1]);
}

/** The full `gh pr list` command whose output is assigned to `name`. */
function ghListFor(code: string, name: string, label: string): string {
  const at = code.indexOf(`${name}="$(gh pr list`);
  if (at === -1) throw new Error(`${label}: no \`${name}="$(gh pr list …)"\` assignment`);
  const end = code.indexOf(`2>&1)"`, at);
  if (end === -1) throw new Error(`${label}: the \`${name}\` gh listing does not end \`2>&1)"\``);
  return code.slice(at, end + 6);
}

/**
 * The shell variable a `NAME="$(printf '%s' "$SRC" | jq … '<program>')"` reads,
 * and the jq program it applies — so a guard can check the WIRING (which listing
 * a selector actually consults) and then EXECUTE the selector's real semantics.
 *
 * Asserting the selector's literals exist proves neither: `.state == "CLOSED"`
 * reading a listing pre-filtered to OPEN can never match, and both mutations
 * passed a guard that only checked the tokens were present.
 */
function jqAssignment(
  code: string,
  name: string,
  label: string,
): { reads: string; program: string } {
  const m = new RegExp(
    `${name}="\\$\\(printf '%s' "\\$([A-Za-z_][A-Za-z0-9_]*)" \\| jq [^']*'([^']*)'\\)"`,
  ).exec(code);
  if (!m) throw new Error(`${label}: no \`${name}="$(printf … | jq … '…')"\` assignment`);
  return { reads: m[1], program: m[2] };
}

/** Run a jq program for real, and return its (parsed) output — `undefined` for `empty`. */
function jqEval(program: string, input: unknown, args: Record<string, string> = {}): unknown {
  const argv = ["-c", ...Object.entries(args).flatMap(([k, v]) => ["--arg", k, v]), program];
  const res = spawnSync("jq", argv, { input: JSON.stringify(input), encoding: "utf-8" });
  if (res.status !== 0) throw new Error(`jq failed (${res.status}): ${res.stderr}`);
  const out = res.stdout.trim();
  return out === "" ? undefined : JSON.parse(out);
}

/** Run a sliced shell fragment with the given environment, and read a variable back. */
function runFragment(
  fragment: string,
  env: Record<string, string>,
  read: string,
): { value: string; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "fix-drift-frag-"));
  try {
    const outFile = join(dir, "value");
    const script = join(dir, "frag.sh");
    writeFileSync(
      script,
      ["set -euo pipefail", fragment, `printf '%s' "$${read}" > ${JSON.stringify(outFile)}`].join(
        "\n",
      ),
    );
    const res = spawnSync("/bin/bash", [script], {
      cwd: dir,
      encoding: "utf-8",
      env: { ...process.env, ...env },
    });
    return {
      value: readFileSync(outFile, "utf-8"),
      out: `${res.stdout ?? ""}${res.stderr ?? ""}`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The named step, or a failed expectation naming what was looked for. */
function stepByName(name: string, src: string = wf): Step {
  const hits = steps(src).filter((s) => s.name === name);
  if (hits.length !== 1) throw new Error(`fix-drift.yml: ${hits.length} steps named ${name}`);
  return hits[0];
}

/** The environment variable naming the script `bin/<name>` delegates to. */
const stubVar = (name: string): string => `STUB_${name.toUpperCase()}`;

const stubBins = new Map<string, string>();

/**
 * A `bin/` directory of stub executables, created ONCE per process.
 *
 * Each stub is a DELEGATOR: it `exec`s a plain, NON-executable script whose path
 * arrives in an environment variable, so a caller varies what a stub does
 * without creating a new executable file.
 *
 * That indirection is not tidiness, it is the guards' time budget. Creating a
 * fresh executable and running it costs ~200ms here (measured: 18 runs of an
 * identical body took 3801ms with a per-run stub and 214ms with one reused
 * stub), and the alert-delivery guard below runs six alert bodies against
 * several curl outcomes each. At one stub per observation it took 4109ms of
 * vitest's 5000ms default on an IDLE 18-core machine and exceeded it under load
 * — during review it false-RED'd twice and both times looked like a real catch.
 * A delegating stub is written once and reused by every observation in the file.
 */
function delegatingBin(names: string[]): string {
  const key = names.join(",");
  const cached = stubBins.get(key);
  if (cached !== undefined) return cached;
  const dir = mkdtempSync(join(tmpdir(), "fix-drift-bin-"));
  for (const name of names) {
    writeFileSync(join(dir, name), `#!/bin/sh\nexec /bin/sh "$${stubVar(name)}" "$@"\n`, {
      mode: 0o755,
    });
  }
  stubBins.set(key, dir);
  return dir;
}

afterAll(() => {
  for (const dir of stubBins.values()) rmSync(dir, { recursive: true, force: true });
  stubBins.clear();
});

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
    const bin = delegatingBin(["npx"]);
    const npxFile = join(dir, "npx-stub.sh");
    writeFileSync(npxFile, npxStub);
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
        [stubVar("npx")]: npxFile,
        SYNC_LOG: join(dir, "drift-sync.log"),
        GITHUB_OUTPUT: outFile,
        RUNNER_TEMP: dir,
      },
    });
    if (res.error) throw res.error;
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
 * The one alert `env:` value that has to be REAL rather than a placeholder: the
 * webhook is the one key whose emptiness the bodies legitimately treat as a hard
 * stop, so it gets a URL and every other key gets `<KEY>` (see below).
 */
const ALERT_ENV_STUB: Record<string, string> = { SLACK_WEBHOOK: "https://hooks.slack.test/T/B/x" };

/**
 * EXECUTE an alert step's own `run:` body against a `curl` that returns
 * `curlExit`, and report what the runner would see: the step's exit status, its
 * `$GITHUB_OUTPUT`, and EVERY POST curl was actually asked to make.
 *
 * `posted=true` is the catch-all's stand-down signal, so a step that publishes it
 * having delivered NOTHING is byte-identical to a delivered alert and the backstop
 * stands down. Whether that can happen is a question about the body's control
 * flow, not about the order of two lines of text — so run it. `errexit: false`
 * strips `-e` from the body's own `set` line, which is how any dependence on that
 * option is MEASURED rather than assumed: `set -e` is a shell option no guard
 * here reads, and a one-token edit to it must not be able to fake a delivery.
 *
 * `posts` is what makes the observation about DELIVERY rather than about an
 * output: an early `echo "posted=true"; exit 1` publishes the stand-down signal
 * while curl is never reached at all, and reading `$GITHUB_OUTPUT` alone cannot
 * tell that apart from a POST that succeeded.
 *
 * Every declared key defaults to a NON-EMPTY `<KEY>`, the same discipline
 * `assembleSlackMessage` uses. Feeding `""` everywhere put this harness in the
 * impossible-fixture class the workflow itself was just fixed for
 * (`NEEDS_HUMAN_PR_OUTCOME: ""` is a state the runner cannot produce): the
 * runner's values are non-empty, so a body branching on an equality test against
 * a real value was invisible here. `env` selects a specific state to observe —
 * see `envStatesFrom`, which drives the whole reachable domain rather than one
 * fixture.
 */
function observeAlertPost(
  step: Step,
  {
    curlExit,
    errexit = true,
    env: envOverride = {},
  }: { curlExit: number; errexit?: boolean; env?: Record<string, string> },
): { stepExit: number; outputs: Record<string, string>; posts: string[] } {
  let body = runOf(step);
  if (!errexit) {
    const stripped = body.replace(/^(\s*set -)([a-z]*)e([a-z]*\b)/m, "$1$2$3");
    if (stripped === body)
      throw new Error(
        `${step.name}: declares no errexit (\`set -…e…\`), so every later command in the body ` +
          "runs on regardless of what failed before it",
      );
    body = stripped;
  }
  const dir = mkdtempSync(join(tmpdir(), "fix-drift-post-"));
  try {
    const bin = delegatingBin(["curl"]);
    const postLog = join(dir, "posts");
    writeFileSync(postLog, "");
    const curlFile = join(dir, "curl-stub.sh");
    // ONE line per invocation: the payload carries real newlines (that is the
    // point of `${NL}`), so a raw `printf "$*"` would log a single POST as
    // several lines and "how many POSTs happened" would read off by two.
    writeFileSync(
      curlFile,
      `{ printf '%s' "$*" | tr '\\n' ' '; printf '\\n'; } >> ${JSON.stringify(postLog)}\n` +
        `exit ${curlExit}\n`,
    );
    const outFile = join(dir, "github_output");
    writeFileSync(outFile, "");
    const script = join(dir, "step.sh");
    writeFileSync(script, body);
    const env: Record<string, string> = {};
    for (const key of Object.keys(step.env)) env[key] = ALERT_ENV_STUB[key] ?? `<${key}>`;
    Object.assign(env, envOverride);
    const res = spawnSync("/bin/bash", [script], {
      cwd: dir,
      encoding: "utf-8",
      env: {
        ...process.env,
        ...env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        [stubVar("curl")]: curlFile,
        GITHUB_OUTPUT: outFile,
        RUNNER_TEMP: dir,
      },
    });
    // A spawn that never ran (EAGAIN, ENOMEM, ETXTBSY) reports status null, and
    // `-1` with no outputs SATISFIES every safety assertion below — the
    // observation would become vacuous in exactly the direction that passes.
    if (res.error) throw res.error;
    const outputs: Record<string, string> = {};
    for (const line of readFileSync(outFile, "utf-8").split("\n")) {
      const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(line);
      if (m) outputs[m[1]] = m[2];
    }
    return {
      stepExit: res.status ?? -1,
      outputs,
      posts: readFileSync(postLog, "utf-8").split("\n").filter(Boolean),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Every (env var, value) state the step's OWN body distinguishes, read out of
 * the artifact.
 *
 * A body that branches on `[ "${SYNC_REASON}" = "provider-unchecked" ]` has a
 * reachable state a single fixture cannot reach, and that is how a zero-Slack
 * path hid: an early `posted=true; exit 1` gated on a real `SYNC_REASON` value
 * stood the catch-all down with nothing delivered, and both harnesses fed a
 * value (`""`, `<SYNC_REASON>`) that no comparison in the body matches.
 *
 * So the domain comes from the comparisons the body itself makes: every literal
 * an `env:`-declared variable is compared against, plus the empty string for
 * every variable tested with `-z`/`-n`. A branch added later extends the swept
 * domain by existing, which is what a fixture list cannot do.
 *
 * `SLACK_WEBHOOK` is excluded: an empty webhook is the ONE state in which these
 * bodies are entitled not to POST, and it has its own guard.
 */
function envStatesFrom(step: Step): Array<{ label: string; env: Record<string, string> }> {
  const body = runOf(step);
  const declared = new Set(Object.keys(step.env));
  const states = new Map<string, Record<string, string>>();
  const add = (name: string, value: string): void => {
    if (!declared.has(name) || name === "SLACK_WEBHOOK") return;
    states.set(`${name}=${JSON.stringify(value)}`, { [name]: value });
  };
  for (const m of body.matchAll(
    /\[\s+"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-)?\}"\s+(?:=|!=)\s+"([^"]*)"\s+\]/g,
  )) {
    add(m[1], m[2]);
  }
  for (const m of body.matchAll(/\[\s+-[zn]\s+"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-)?\}"\s+\]/g)) {
    add(m[1], "");
  }
  return [
    { label: "every declared value present", env: {} },
    ...[...states].map(([label, env]) => ({ label, env })),
  ];
}

/**
 * `mapfile` is a bash-4 builtin and macOS still ships bash 3.2, where the persist
 * body would abort on a `command not found` that has nothing to do with the
 * property under test. Defined ONLY when the running shell lacks it, so on the
 * ubuntu runner the real builtin executes and this prologue is inert — and the
 * MODEL guard below runs it against the builtin's contract, because a harness
 * that mis-fills an array is a harness reporting a different program's answers.
 */
const MAPFILE_SHIM = [
  "if ! type mapfile >/dev/null 2>&1; then",
  "  mapfile() {",
  '    [ "$1" = "-t" ] && shift',
  '    eval "$1=()"',
  '    while IFS= read -r __mf_line; do eval "$1+=(\\"\\$__mf_line\\")"; done',
  "  }",
  "fi",
].join("\n");

/**
 * EXECUTE a persist step's own `run:` body against stubbed `git` and `gh`, and
 * report what the runner would see in `$GITHUB_OUTPUT`.
 *
 * These two steps decide, in a FIXED ORDER, whether today's changeset is already
 * proposed (an open PR carries its marker), already rejected (only a closed one
 * does), or new — and that order IS the mechanism. It used to be guarded by
 * comparing the text positions of two selectors and by enumerating the `exit 0`
 * lines that precede one of them, and every version of that was defeated without
 * touching behaviour: `exit 0 # comment` and a bare `exit` are invisible to the
 * enumeration, and leaving the selector where it is while moving the block that
 * ACTS on it satisfies both. Each restores the same bug: the no-new-commit gate
 * returning in front of the closed-rejection test, so a rejection is never
 * detected, `rejected` is never published, the suppression notice cannot fire and
 * the needs-human alert reds the job every morning instead.
 *
 * So run the decision rather than reading it. `git` answers `rev-parse` and
 * `diff --name-only` from `headSha`/`diffFiles`; `gh pr list` answers the
 * `--state open` self-heal listing and the `--state all --search` dedup listing
 * separately, because pointing one selector at the other listing is itself a
 * defect this file guards.
 */
function observePersistStep(
  step: Step,
  {
    openPrs = [],
    searchPrs = [],
    headSha = "1111111111111111111111111111111111111111",
    baseSha = "2222222222222222222222222222222222222222",
    diffFiles = ["drift-proposals/2026-08-04-1-drift.md"],
    changesetKey = "eaa8db65f5647493",
  }: {
    openPrs?: unknown[];
    searchPrs?: unknown[];
    headSha?: string;
    baseSha?: string;
    diffFiles?: string[];
    changesetKey?: string;
  },
): { stepExit: number; outputs: Record<string, string>; stdio: string; ghLog: string } {
  const dir = mkdtempSync(join(tmpdir(), "fix-drift-persist-"));
  try {
    const bin = delegatingBin(["git", "gh"]);
    const write = (name: string, content: string): string => {
      const p = join(dir, name);
      writeFileSync(p, content);
      return p;
    };
    const gitFile = write(
      "git-stub.sh",
      [
        'case "$1 $2" in',
        '  "rev-parse HEAD") printf \'%s\\n\' "$GIT_HEAD_SHA" ;;',
        '  "rev-parse --abbrev-ref") printf \'%s\\n\' "fix/drift-2026-08-04-1" ;;',
        '  "diff --name-only") cat "$GIT_DIFF_FILES" ;;',
        "esac",
        "exit 0",
      ].join("\n"),
    );
    const logFile = write("gh.log", "");
    const ghFile = write(
      "gh-stub.sh",
      [
        `printf '%s\\n' "$*" >> ${JSON.stringify(logFile)}`,
        'case "$*" in',
        '  "pr list --state open"*) cat "$GH_OPEN_JSON" ;;',
        '  "pr list --state all"*) cat "$GH_ALL_JSON" ;;',
        "esac",
        "exit 0",
      ].join("\n"),
    );
    const outFile = write("github_output", "");
    const script = write("step.sh", `${MAPFILE_SHIM}\n${runOf(step)}`);
    const res = spawnSync("/bin/bash", [script], {
      cwd: dir,
      encoding: "utf-8",
      env: {
        ...process.env,
        GH_TOKEN: "<GH_TOKEN>",
        RUN_ID: "<RUN_ID>",
        CHANGESET_KEY: changesetKey,
        BASE_SHA: baseSha,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        [stubVar("git")]: gitFile,
        [stubVar("gh")]: ghFile,
        GIT_HEAD_SHA: headSha,
        GIT_DIFF_FILES: write("diff", `${diffFiles.join("\n")}\n`),
        GH_OPEN_JSON: write("open.json", JSON.stringify(openPrs)),
        GH_ALL_JSON: write("all.json", JSON.stringify(searchPrs)),
        GITHUB_OUTPUT: outFile,
        RUNNER_TEMP: dir,
      },
    });
    if (res.error) throw res.error;
    const outputs: Record<string, string> = {};
    for (const line of readFileSync(outFile, "utf-8").split("\n")) {
      const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(line);
      if (m) outputs[m[1]] = m[2];
    }
    return {
      stepExit: res.status ?? -1,
      outputs,
      stdio: `${res.stdout ?? ""}${res.stderr ?? ""}`,
      ghLog: readFileSync(logFile, "utf-8"),
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

// ---------------------------------------------------------------------------
// GitHub-Actions `if:` EXPRESSION EVALUATOR.
//
// Several claims in this suite are about REACHABILITY — "on this failure the
// job cannot end green with no alert". That is a question about how the runner
// SELECTS steps, and no substring match can answer it. This evaluates the
// subset of the expression language the workflow uses (status functions,
// `github.*` / `steps.*` contexts, `==`/`!=`, `&&`/`||`/`!`, parentheses) so
// the guards can OBSERVE which steps a given scenario selects.
// ---------------------------------------------------------------------------
/**
 * GitHub's real step-outcome domain, plus the one state the runner has not
 * produced yet.
 *
 * `cancelled` is a FOURTH outcome, not a spelling of failure — a step the job's
 * cancellation cut short reports it, and a condition keyed on `== 'skipped'` or
 * `== 'failure'` is false for it. Modelling it explicitly is what lets the
 * guards below ask "is any consumer treating a cancelled step as some OTHER
 * outcome".
 */
type StepOutcome = "success" | "failure" | "cancelled" | "skipped" | "";

interface StepState {
  outcome: StepOutcome;
  outputs: Record<string, string>;
}
interface EvalCtx {
  event_name: string;
  /** Has any earlier step failed? Drives failure()/success(). */
  jobFailed: boolean;
  /**
   * Has the job been CANCELLED (manual cancel, or the job's `timeout-minutes`
   * firing)? Drives cancelled(), and suppresses success().
   *
   * This is a THIRD job state, not a flavour of failure: GitHub's `failure()` is
   * false for a cancelled job, so an alert keyed on `failure()` alone stays
   * silent through a timeout. Modelling it as `jobFailed` would hide exactly the
   * defect this exists to catch.
   */
  jobCancelled: boolean;
  steps: Record<string, StepState>;
}

type Tok = { t: "op" | "str" | "num" | "id" | "lparen" | "rparen"; v: string };

function lexExpr(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      let v = "";
      while (j < src.length) {
        if (src[j] === "'" && src[j + 1] === "'") {
          v += "'";
          j += 2;
          continue;
        }
        if (src[j] === "'") break;
        v += src[j++];
      }
      out.push({ t: "str", v });
      i = j + 1;
      continue;
    }
    if (["==", "!=", "&&", "||"].includes(src.slice(i, i + 2))) {
      out.push({ t: "op", v: src.slice(i, i + 2) });
      i += 2;
      continue;
    }
    if (c === "(") {
      out.push({ t: "lparen", v: c });
      i++;
      continue;
    }
    if (c === ")") {
      out.push({ t: "rparen", v: c });
      i++;
      continue;
    }
    if (c === "!") {
      out.push({ t: "op", v: "!" });
      i++;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_.\-*]*/.exec(src.slice(i));
    if (id) {
      out.push({ t: "id", v: id[0] });
      i += id[0].length;
      continue;
    }
    const num = /^-?\d+/.exec(src.slice(i));
    if (num) {
      out.push({ t: "num", v: num[0] });
      i += num[0].length;
      continue;
    }
    throw new Error(`if-expression: cannot lex ${JSON.stringify(src.slice(i, i + 20))}`);
  }
  return out;
}

const STATUS_FN = /\b(success|failure|cancelled|always)\s*\(\s*\)/;

function evaluateIf(exprIn: string, ctx: EvalCtx): boolean {
  let src = exprIn.trim();
  if (src.startsWith("${{") && src.endsWith("}}")) src = src.slice(3, -2).trim();
  // A step `if:` with NO status-check function carries an implicit `success()`:
  // the runner skips it once an earlier step has failed. Modelling that is
  // load-bearing — the `assert` step relies on exactly this.
  if (!STATUS_FN.test(src)) src = `success() && (${src})`;

  const toks = lexExpr(src);
  let p = 0;
  const peek = (): Tok | undefined => toks[p];

  const truthy = (v: string | boolean): boolean => (typeof v === "boolean" ? v : v !== "");

  const resolve = (path: string): string => {
    if (path === "github.event_name") return ctx.event_name;
    const st = /^steps\.([A-Za-z0-9_-]+)\.(.+)$/.exec(path);
    if (st) {
      const state = ctx.steps[st[1]] ?? { outcome: "" as const, outputs: {} };
      if (st[2] === "outcome" || st[2] === "conclusion") return state.outcome;
      const out = /^outputs\.(.+)$/.exec(st[2]);
      if (out) return state.outputs[out[1]] ?? "";
      return "";
    }
    // Any other context resolves to the empty string, exactly as an absent
    // context does on the runner.
    return "";
  };

  function primary(): string | boolean {
    const t = peek();
    if (!t) throw new Error(`if-expression: unexpected end of input in ${JSON.stringify(src)}`);
    if (t.t === "lparen") {
      p++;
      const v = or();
      if (peek()?.t !== "rparen") throw new Error("if-expression: missing `)`");
      p++;
      return v;
    }
    if (t.t === "str" || t.t === "num") {
      p++;
      return t.v;
    }
    if (t.t === "id") {
      p++;
      if (peek()?.t === "lparen") {
        p++;
        if (peek()?.t !== "rparen") throw new Error(`if-expression: ${t.v}() takes no arguments`);
        p++;
        switch (t.v) {
          case "always":
            return true;
          case "success":
            return !ctx.jobFailed && !ctx.jobCancelled;
          case "failure":
            // Deliberately NOT `|| jobCancelled`: on the runner a cancelled job
            // does NOT satisfy failure(). That asymmetry is the whole point.
            return ctx.jobFailed;
          case "cancelled":
            return ctx.jobCancelled;
          default:
            throw new Error(`if-expression: unmodelled function ${t.v}()`);
        }
      }
      if (t.v === "true" || t.v === "false") return t.v === "true";
      return resolve(t.v);
    }
    throw new Error(`if-expression: unexpected token ${t.v}`);
  }

  function unary(): string | boolean {
    if (peek()?.t === "op" && peek()!.v === "!") {
      p++;
      return !truthy(unary());
    }
    return primary();
  }

  function cmp(): string | boolean {
    const a = unary();
    const t = peek();
    if (t?.t === "op" && (t.v === "==" || t.v === "!=")) {
      p++;
      const b = unary();
      const eq = String(a) === String(b);
      return t.v === "==" ? eq : !eq;
    }
    return a;
  }

  function and(): boolean {
    let v = truthy(cmp());
    while (peek()?.t === "op" && peek()!.v === "&&") {
      p++;
      v = truthy(cmp()) && v;
    }
    return v;
  }

  function or(): boolean {
    let v = and();
    while (peek()?.t === "op" && peek()!.v === "||") {
      p++;
      v = and() || v;
    }
    return v;
  }

  const result = truthy(or());
  if (p !== toks.length)
    throw new Error(`if-expression: trailing tokens in ${JSON.stringify(src)}`);
  return result;
}

/** Steps that exist to tell a human something (Slack + `::error::`). */
const isAlertStep = (s: Step): boolean => /^(Alert|Notify)\b/.test(s.name ?? "");

/** Every step that POSTs a Slack payload built from a `MSG=` assignment. */
const slackSteps = (): Step[] =>
  steps().filter((s) => runOf(s).includes("SLACK_WEBHOOK") && /\bMSG=/.test(runOf(s)));

// ---------------------------------------------------------------------------
// JOB SIMULATION. `evaluateIf` answers "would THIS step run"; several claims
// here are about the job as a whole ("this failure reaches a human", "exactly
// one alert fires"), and those depend on step ORDER: a step's `outcome` is
// `skipped` once the runner has evaluated it, and empty before that. So walk the
// steps in order, carrying the accumulated state forward.
// ---------------------------------------------------------------------------
interface Scenario {
  event_name?: string;
  /**
   * Step ids or names that FAIL when the runner selects them.
   *
   * For an ALERT step this means its `curl` failed — a rotated webhook answering
   * 404, a 5xx, a TLS timeout — so it ran and delivered NOTHING. That is the
   * distinction the `posted=true` output exists to make, and modelling it is what
   * lets a guard ask whether the backstop still covers a dead webhook.
   */
  failing?: string[];
  /** Step outputs, by step id, published when that step is selected. */
  outputs?: Record<string, Record<string, string>>;
  /**
   * Step id or name DURING which the job is cancelled — a manual cancel, or the
   * job's `timeout-minutes` firing. That step's outcome becomes 'cancelled' and
   * every later step is skipped unless its `if:` names always() or cancelled().
   */
  cancelledAt?: string;
}

/**
 * Does this step END in a deliberate non-zero exit, so that COMPLETING it always
 * means `outcome == 'failure'`?
 *
 * Read off the step's OWN `run:` body — its last code line — rather than from a
 * list of step names kept here: both alert steps deliberately `exit 1` so a
 * human sees the run RED in CI too (pinned separately), while the success
 * notification deliberately does not, and which is which must not be transcribed
 * into this suite. A simulation that modelled every selected step it was not
 * TOLD to fail as 'success' would model a workflow in which the alert steps exit
 * 0 — nothing that exists — and that fiction is what makes an `outcome ==
 * 'skipped'` clause look like it is holding an "exactly one alert" invariant.
 */
function completesNonZero(s: Step): boolean {
  const code = codeOf(s)
    .split("\n")
    .filter((l) => l.trim() !== "");
  return /^\s*exit [1-9][0-9]*\s*$/.test(code[code.length - 1] ?? "");
}

function simulateJob(
  sc: Scenario,
  src: string = wf,
): {
  selected: Step[];
  alerts: string[];
  jobFailed: boolean;
  jobCancelled: boolean;
  /** Per-step outcome, so a guard can name the outcome it means. */
  outcomes: Record<string, StepOutcome>;
} {
  const ctx: EvalCtx = {
    event_name: sc.event_name ?? "schedule",
    jobFailed: false,
    jobCancelled: false,
    steps: {},
  };
  const failing = new Set(sc.failing ?? []);
  const named = (s: Step): boolean =>
    (s.id !== undefined && failing.has(s.id)) || (s.name !== undefined && failing.has(s.name));
  const selected: Step[] = [];
  /** Alert steps that ran AND whose `curl` returned 0 — the only ones that told anyone. */
  const delivered = new Set<Step>();
  for (const s of steps(src)) {
    const runs = s.if === undefined ? !ctx.jobFailed && !ctx.jobCancelled : evaluateIf(s.if, ctx);
    const cancels =
      runs &&
      sc.cancelledAt !== undefined &&
      (s.id === sc.cancelledAt || s.name === sc.cancelledAt);
    const fails =
      runs &&
      !cancels &&
      (named(s) ||
        // A step that RAN TO COMPLETION and whose only exit path is `exit 1`
        // reports 'failure' — the scenario does not get to say otherwise.
        completesNonZero(s));
    // DELIVERY, modelled separately from the step's outcome, because the two are
    // NOT the same fact: an alert step ends in a deliberate `exit 1` (so a
    // delivered alert reports 'failure'), and it ALSO reports 'failure' when its
    // `curl` died against a rotated webhook and nothing was delivered at all. A
    // model that reads delivery off the outcome cannot distinguish them, which is
    // exactly why an `outcome`-keyed backstop looked load-bearing.
    if (runs && !cancels && isAlertStep(s) && !named(s)) delivered.add(s);
    if (s.id) {
      ctx.steps[s.id] = {
        outcome: runs ? (cancels ? "cancelled" : fails ? "failure" : "success") : "skipped",
        // Outputs are published by a step that RAN, even if it then failed (the
        // sync step writes $GITHUB_OUTPUT before exiting non-zero, and so does
        // every alert's `posted=true`). A step cut short by a cancellation
        // published nothing.
        outputs:
          runs && !cancels
            ? { ...(sc.outputs?.[s.id] ?? {}), ...(delivered.has(s) ? { posted: "true" } : {}) }
            : {},
      };
    }
    if (runs) selected.push(s);
    // `continue-on-error: true` leaves the step's OUTCOME 'failure' while the
    // job's status is computed from its CONCLUSION, which becomes success — so
    // `failure()` is false and every alert gated on it goes silent. Modelled so
    // that adding the key to any step is visible to these guards instead of
    // silently defeating three of them.
    if (fails && s.continueOnError === undefined) ctx.jobFailed = true;
    if (cancels) ctx.jobCancelled = true;
  }
  return {
    selected,
    // DELIVERED alerts only. A step the cancellation killed mid-`curl`, or whose
    // POST was rejected, told nobody anything — counting either as an alert is
    // the same class of fiction as modelling `exit 1` as success, and it is the
    // fiction that made a genuinely silent window look like it "alerted once".
    alerts: selected.filter((s) => delivered.has(s)).map((s) => s.name!),
    jobFailed: ctx.jobFailed,
    jobCancelled: ctx.jobCancelled,
    outcomes: Object.fromEntries(
      Object.entries(ctx.steps).map(([id, st]) => [id, st.outcome] as const),
    ),
  };
}

/**
 * An alert step's `env:`, filled from a SIMULATED run instead of from
 * hand-written outcome strings.
 *
 * `NEEDS_HUMAN_PR_OUTCOME: ""` is a state the runner cannot produce: it
 * evaluates every step's `if:`, so a step it did not select reports 'skipped',
 * never ''. A fixture in that impossible class is what made three arms of the
 * gate alert's `FAILING_STEP` ladder look reachable — on a real ok-applied run
 * the persist step is ALWAYS 'skipped', the arm testing that sat first, and so
 * every ok-applied failure got the needs-human wording while no arm ever named
 * the step that actually broke.
 *
 * Derived from the step's OWN `env:` declarations, so an outcome the step starts
 * reading is filled from the simulation rather than defaulting to an unreachable
 * empty string, and an env pointing at a step id that does not exist THROWS.
 */
function alertEnvFrom(step: Step, sc: Scenario): Record<string, string> {
  const res = simulateJob(sc);
  const env: Record<string, string> = {};
  for (const [key, expr] of Object.entries(step.env)) {
    const outcome = /^\$\{\{\s*steps\.([A-Za-z0-9_-]+)\.(?:outcome|conclusion)\s*\}\}$/.exec(expr);
    if (outcome) {
      if (!(outcome[1] in res.outcomes))
        throw new Error(
          `${step.name}: \`${key}\` reads steps.${outcome[1]}.outcome, and no step has that ` +
            "id — the alert can never see it",
        );
      env[key] = res.outcomes[outcome[1]];
      continue;
    }
    const output = /^\$\{\{\s*steps\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)\s*\}\}$/.exec(
      expr,
    );
    if (output) env[key] = sc.outputs?.[output[1]]?.[output[2]] ?? "";
  }
  return env;
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

  /**
   * A drift-sync that printed a CLEAN, classifiable, quiet-day log and then
   * exited non-zero. Reachable from any Node-level failure after the log lines —
   * an unhandled rejection on a dangling promise, an OOM on the way out.
   */
  const quietThenDied = (exit: number, reason = SyncCoreReason.OK_NO_CHURN): string =>
    [
      "#!/bin/sh",
      "echo 'unchecked-providers='",
      "echo 'changeset-key=eaa8db65f5647493'",
      `echo 'reason=${reason}'`,
      `exit ${exit}`,
      "",
    ].join("\n");

  it("a clean reason followed by a NON-ZERO exit is not a quiet day either", () => {
    // `exit_code` was captured, published, and gated on by NOTHING: the step's
    // only exit test read `REASON`, so "the process said it was fine and then
    // died" exited 0, concluded green, and selected none of the six Slack posts.
    // The same fail-open encoding as the `provider-unchecked` window one layer
    // down — an UNKNOWN collapsing into the answer that passes.
    //
    // Over BOTH reasons that claim the run was fine and over the exit codes a
    // death actually arrives with, because one scenario left two one-token
    // narrowings green: `-ne 0` → `-eq 1` still catches the only code a single
    // fixture used while letting 137 (OOM — the mechanism's own cited motivating
    // case) and 139 (SIGSEGV) through, and `ok-*)` → `ok-no-churn)` lets an
    // ok-applied run report clean, die, and stay green and silent.
    for (const reason of [SyncCoreReason.OK_NO_CHURN, SyncCoreReason.OK_APPLIED]) {
      for (const exit of [1, 2, 137]) {
        const obs = observeSyncStep(wf, quietThenDied(exit, reason));
        expect(
          obs.outputs.exit_code,
          `the scenario did not actually make drift-sync exit ${exit}`,
        ).toBe(String(exit));
        expect(
          obs.stepExit,
          `drift-sync printed reason=${reason} and then exited ${exit}, but the sync STEP ` +
            `exited 0 and published reason=${JSON.stringify(obs.outputs.reason ?? "")} — the ` +
            "job concludes GREEN, every reason-keyed alert `if:` is false, and the catch-all " +
            "needs failure(), so a dying sync is byte-identical to a quiet day",
        ).not.toBe(0);
        const published = obs.outputs.reason ?? "";
        const keyed = alertSteps().filter((s) => (s.if ?? "").includes(`'${published}'`));
        expect(
          keyed.map((s) => s.name),
          `the step publishes reason='${published}' for a ${reason} run that died with ` +
            `${exit}, but no alert step's \`if:\` mentions it — the fault is published into a void`,
        ).not.toEqual([]);
      }
    }
  });

  it("KNOWN-NEGATIVE: the same clean log with a ZERO exit is still a quiet day", () => {
    // Without this the guard above is satisfied by a step that reds on every
    // ok-no-churn run, which would alert 364 days a year and teach a human to
    // ignore the channel — silence by another route.
    const obs = observeSyncStep(wf, quietThenDied(0));
    expect(obs.outputs.reason, "a genuinely quiet day was reclassified as a fault").toBe(
      SyncCoreReason.OK_NO_CHURN,
    );
    expect(obs.stepExit, "a genuinely quiet day fails the step").toBe(0);
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
  it("every Slack-posting step is found, in job order (a new one must be added here deliberately)", () => {
    expect(slackSteps().map((s) => s.name)).toEqual([
      "Alert on job CANCELLATION (posts ahead of the artifact uploads)",
      "Notify Slack on a SUPPRESSED (human-rejected) changeset",
      "Alert on needs-human decision",
      "Alert on drift-sync-check gate failure",
      "Notify Slack on sync success",
      "Alert on early-infra failure (catch-all)",
    ]);
  });

  it("the cancellation POST is FIRST among the steps a cancelled job still runs", () => {
    // The whole value of hoisting this step is POSITIONAL: a cancelled job has one
    // bounded budget (GitHub's documented 5 minutes) and the runner works through
    // the remaining steps IN ORDER, so an `upload-artifact` retrying against a
    // degraded artifact service can eat the budget and the cheap POST after it
    // never runs. Nothing here modelled position — `simulateJob` walks every step
    // and never truncates a cancelled job — so the step could be demoted below
    // both uploads and stay green, which is the state it was hoisted OUT of.
    const all = steps();
    const cancelAt = all.findIndex((s) => s.id === "alert_cancelled");
    expect(cancelAt, "no step with id `alert_cancelled` to check the position of").toBeGreaterThan(
      -1,
    );
    // Every step a cancelled job still reaches is one whose `if:` survives
    // cancellation — i.e. carries `always()` or `cancelled()`. None may precede it.
    const ahead = all
      .slice(0, cancelAt)
      .filter((s) => /\b(always|cancelled)\s*\(\s*\)/.test(s.if ?? ""));
    expect(
      ahead.map((s) => s.name ?? s.uses),
      "a step that a cancelled job also runs sits AHEAD of the cancellation POST, so it " +
        "spends the cancellation budget first and the alert can be killed before it posts",
    ).toEqual([]);
    // Named explicitly, because these two are the reason for the hoist and an
    // `if:` rewritten to any other cancellation-surviving spelling must still fail.
    const uploads = all
      .map((s, i) => ({ i, name: s.name ?? s.uses }))
      .filter(({ i }) => /actions\/upload-artifact/.test(all[i].uses ?? ""));
    expect(uploads.length, "no `upload-artifact` step — the hoist has nothing to be ahead of").toBe(
      2,
    );
    for (const u of uploads) {
      expect(
        cancelAt,
        `the cancellation POST sits BELOW \`${u.name}\`, so a slow artifact service can burn ` +
          "the cancellation budget before the alert is ever attempted",
      ).toBeLessThan(u.i);
    }
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
  it("no permissions block, at either scope, grants checks: read or statuses: read", () => {
    // Deliberately spans from the WORKFLOW-level `permissions:` through to
    // `steps:`, so it covers the job's block too — widening either scope reds
    // this. Both bounds are located through `locate`, because a slice that
    // silently ran to the end of the file (or started at 0) would still "pass"
    // these negative assertions for the wrong reason.
    const from = locate(wf, "permissions:", "permissions block");
    const block = wf.slice(from, locate(wf, "steps:", "permissions block", from));
    expect(block, "a permissions block grants `checks: read`").not.toMatch(
      /^\s*checks:\s*read\s*$/m,
    );
    expect(block, "a permissions block grants `statuses: read`").not.toMatch(
      /^\s*statuses:\s*read\s*$/m,
    );
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

  // -------------------------------------------------------------------------
  // The same trim, one scope further in. `permissions:` governs the AMBIENT
  // GITHUB_TOKEN, and this job never uses it: `persist-credentials: false`
  // keeps GITHUB_TOKEN out of the git config, every `gh` call reads a GH_TOKEN
  // set from the minted app token, and the push goes through an `insteadOf`
  // credential built from that same token. So `contents: write` +
  // `pull-requests: write` granted nothing to anything — they only widened the
  // token handed to every `run:` block in a job that clones a third-party repo
  // and shells out to provider SDKs.
  //
  // The premise is checked BEFORE the ceiling, and from the artifact rather
  // than from a list kept here: narrowing to `contents: read` is only safe
  // while no write actually depends on the ambient token, so the guard that
  // says "no write depends on it" is the load-bearing one.
  // -------------------------------------------------------------------------
  const APP_TOKEN = "${{ steps.app-token.outputs.token }}";

  it("PREMISE: no step anywhere consumes the ambient GITHUB_TOKEN", () => {
    expect(
      wf,
      "a step reads secrets.GITHUB_TOKEN, so the job's `permissions:` are live and " +
        "narrowing them breaks that step",
    ).not.toMatch(/secrets\.GITHUB_TOKEN/);
    expect(wf).not.toMatch(/github\.token/);
    // …and checkout must not leave it behind in the git config either, which is
    // the non-obvious way a `git push` can depend on GITHUB_TOKEN without ever
    // naming it.
    expect(wf).toMatch(/uses: actions\/checkout@[^\n]*\n\s*with:\n\s*persist-credentials: false/);
  });

  it("PREMISE: every `gh` call is authenticated by the MINTED APP TOKEN, not the ambient one", () => {
    // `gh` at a COMMAND position (line start, or inside `$(…)`). A looser match
    // also hits the gate alert's `FAILING_STEP="… gh pr create error …"` prose,
    // which would demand a token on a step that calls nothing.
    const ghSteps = steps().filter((s) => /(^\s*|\$\()gh\s/m.test(codeOf(s)));
    expect(
      ghSteps.map((s) => s.id).sort(),
      "the `gh`-calling steps are not the two PR-open steps plus the suppression-ack " +
        "receipt — the guard is looking at the wrong steps, or a new step started calling `gh`",
    ).toEqual(["needs_human_pr", "pr", "rejected_ack"]);
    for (const s of ghSteps) {
      expect(
        s.env.GH_TOKEN,
        `${s.name}: calls \`gh\` without GH_TOKEN set from the minted app token, so it ` +
          "falls back to the ambient GITHUB_TOKEN and the narrowed permissions break it",
      ).toBe(APP_TOKEN);
    }
  });

  it("PREMISE: every `git push` runs behind the app-token `insteadOf` credential", () => {
    // ONE `steps()` call, and the positions come from `findIndex` on it. This used
    // to call `steps()` twice and then `order.indexOf(inject)` — and `steps()`
    // re-parses, so the two arrays hold DIFFERENT objects and `indexOf` returned
    // -1 for the injector. Every real push index is greater than -1, so the
    // ordering claim was trivially true and a push moved AHEAD of the credential
    // injection would still have passed.
    const order = steps();
    const injectAt = order.findIndex((s) => /insteadOf/.test(codeOf(s)));
    expect(injectAt, "no step injects a git push credential at all").toBeGreaterThanOrEqual(0);
    const inject = order[injectAt];
    expect(codeOf(inject)).toContain("x-access-token:${TOKEN}");
    expect(inject.env.TOKEN).toBe(APP_TOKEN);
    const pushes = order.map((s, i) => ({ s, i })).filter(({ s }) => /git push/.test(codeOf(s)));
    expect(pushes.length, "no step pushes at all, so this guard proves nothing").toBeGreaterThan(0);
    for (const { s, i } of pushes) {
      expect(
        i,
        `${s.name}: pushes BEFORE the app-token credential is injected, so it would ` +
          "push with whatever ambient credential checkout left behind",
      ).toBeGreaterThan(injectAt);
    }
  });

  it("the sync JOB declares its own per-scope permissions mapping, not a blanket scalar", () => {
    const line = wf.split("\n").find((l) => /^ {4}permissions:/.test(l));
    expect(line, "the sync job declares no `permissions:` of its own").toBeDefined();
    expect(
      line!.slice(locate(line!, ":", "the sync job `permissions:` line") + 1).trim(),
      "`permissions:` carries an inline value (`read-all`, `write-all`, or a flow " +
        "mapping) — a blanket grant, not a per-scope mapping",
    ).toBe("");
    expect(Object.keys(jobPermissions()).length).toBeGreaterThan(0);
  });

  it("the sync JOB grants NO write scope — `contents: read` is the whole ceiling", () => {
    const perms = jobPermissions();
    const widenings = Object.entries(perms).filter(
      ([scope, level]) => !(level === "none" || (scope === "contents" && level === "read")),
    );
    expect(
      widenings,
      "the sync job's `permissions:` grant more than `contents: read`, yet no step " +
        "consumes the ambient GITHUB_TOKEN at all (see the PREMISE guards above) — " +
        "the extra grants widen the token every `run:` block in the job receives " +
        "while buying nothing",
    ).toEqual([]);
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
    // Which step-level predicate it uses is settled over the WHOLE step-outcome
    // domain in "every outcome reaches a human EXACTLY once" below, not by
    // matching one literal here.
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
    // Asked of the step's OWN `if:`, via the slicer. This used to slice
    // `wf.indexOf("name: Alert …")` to `wf.indexOf("\n      - name:", …)` and fall
    // back to the END OF FILE when the second locator returned -1, so a renamed
    // or moved step widened the window to every later step at once — and any
    // other step's `if:` could then satisfy the positive assertion below.
    const gate = stepByName("Alert on drift-sync-check gate failure").if ?? "";
    // Must be gated on general failure() in the ok-applied branch, not
    // narrowly on steps.assert.outcome == 'failure' — otherwise a failure in
    // a step AFTER assert (Push branch + create PR) is invisible to this
    // condition.
    expect(gate).toMatch(/steps\.sync\.outputs\.reason == 'ok-applied' && failure\(\)/);
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
    // …and its ASSEMBLED message must NAME the failing one, over the windows the
    // RUNNER can actually produce (each is a scenario; the outcomes are read back
    // out of the simulation, never hand-written). Executed, because a substring
    // check on `FAILING_STEP` passes on a body where every arm sets the same text.
    const OK_APPLIED = { reason: SyncCoreReason.OK_APPLIED, exit_code: "0" };
    const windows: Record<string, { scenario: Scenario; names: RegExp; fallback?: true }> = {
      "drift-sync crashed": {
        scenario: {
          failing: ["sync"],
          // A WORKFLOW-level reason: the sync step synthesises it, so there is no
          // SyncCoreReason member to name it by.
          outputs: { sync: { reason: "sync-crashed", exit_code: "1" } },
        },
        names: /Run deterministic drift sync/,
      },
      // The two arms with no window of their own could each be made DEAD by a
      // one-character edit to the value they compare against — after which a
      // revoked credential, or the internal gate reverting the edit, fell through
      // to the "unidentified step" fallback and this guard stayed green.
      "a provider was never actually checked (revoked/expired credential)": {
        scenario: {
          failing: ["sync"],
          outputs: { sync: { reason: "provider-unchecked", exit_code: "1" } },
        },
        names: /Run deterministic drift sync/,
      },
      "drift-sync's own internal gate reverted the edit": {
        scenario: {
          failing: ["sync"],
          outputs: { sync: { reason: SyncCoreReason.GATE_FAILED, exit_code: "1" } },
        },
        names: /Run deterministic drift sync/,
      },
      "assert refused": {
        scenario: { failing: ["assert"], outputs: { sync: OK_APPLIED } },
        names: /Assert drift-sync-check/,
      },
      "the git config for the push failed": {
        scenario: { failing: ["Configure git for push"], outputs: { sync: OK_APPLIED } },
        names: /Configure git for push/,
      },
      "push/PR-create failed": {
        scenario: { failing: ["pr"], outputs: { sync: OK_APPLIED } },
        names: /Push branch \+ create PR/,
      },
      "an artifact upload failed after the sync": {
        scenario: { failing: ["Upload drift-sync log"], outputs: { sync: OK_APPLIED } },
        // No `id:`, so it cannot be named — but the message must at least report
        // the state it observed instead of inventing a different one.
        names: /assert=skipped/,
        fallback: true,
      },
    };
    const assembled = Object.fromEntries(
      Object.entries(windows).map(([label, { scenario }]) => [
        label,
        assembleSlackMessage(gate, alertEnvFrom(gate, scenario)),
      ]),
    );
    /**
     * The step names this workflow actually HAS — the only vocabulary a
     * "failing step: …" line may draw a name from. The fallback wording is
     * admitted because two real steps (the artifact uploads) carry no `id:` and
     * genuinely cannot be named; inventing a third name is what this rejects.
     */
    const namesARealStep = (msg: string): boolean =>
      msg.includes("an unidentified step") ||
      steps().some((s) => s.name !== undefined && msg.includes(s.name));
    for (const [label, { names, fallback }] of Object.entries(windows)) {
      expect(
        assembled[label],
        `the gate alert does not name what failed when ${label}: ${JSON.stringify(assembled[label])}`,
      ).toMatch(names);
      // …and the name it gives is a step that EXISTS. "Verify registry
      // checksums" reads exactly as plausibly as the real thing and sends a human
      // to a step that is not in the file — the defect class this ladder was
      // written to close, reachable on any arm no window covered.
      expect(
        namesARealStep(assembled[label]),
        `when ${label}, the gate alert names a step this workflow does not have: ` +
          JSON.stringify(assembled[label]),
      ).toBe(true);
      if (fallback !== true) {
        // An arm made DEAD (one character in the value it compares against) falls
        // through to the fallback, which is true but useless: the run has a step
        // to name and this says nobody knows which.
        expect(
          assembled[label],
          `when ${label}, the gate alert falls through to "an unidentified step" — the arm ` +
            "that covers this window is dead, so a human is told the workflow cannot tell " +
            "them what broke",
        ).not.toMatch(/an unidentified step/);
      }
      // The ladder's needs-human arms must not claim an ok-applied run lost a
      // needs-human note. That run has no note; the claim sends a human hunting
      // for a file that does not exist and never names the step that broke.
      expect(
        assembled[label],
        `when ${label}, the gate alert blames the needs-human note instead of the step ` +
          "that actually failed",
      ).not.toMatch(/needs-human note/);
    }
    const distinct = new Set(Object.values(assembled));
    expect(
      distinct.size,
      "the gate-failure alert sends the same message for different failing steps:\n" +
        JSON.stringify(assembled, null, 2),
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
    // Anchored on the git-diff invocation that PRODUCES the note list, not on
    // the bash construct that consumes it: keyed on `mapfile` this went red on a
    // behaviour-preserving swap to a portable `read` loop, which is a test
    // measuring an implementation choice instead of the fact it cares about.
    const scanIdx = body.search(/git diff --name-only "\$BASE_SHA" HEAD/);
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
    // The step also imports that outcome as env, so a whole-block grep stays
    // green with the gate removed. Asked of the `if:` by EVALUATING it, not by
    // matching a literal: which comparison it uses is settled over the whole
    // outcome domain in "every outcome reaches a human EXACTLY once" below.
    const gateAlert = stepByName("Alert on drift-sync-check gate failure");
    expect(gateAlert.env.NEEDS_HUMAN_PR_OUTCOME).toBe("${{ steps.needs_human_pr.outcome }}");
    expect(
      evaluateIf(gateAlert.if!, {
        event_name: "schedule",
        jobFailed: true,
        jobCancelled: false,
        steps: {
          sync: { outcome: "success", outputs: { reason: SyncCoreReason.NEEDS_HUMAN } },
          needs_human_pr: { outcome: "failure", outputs: {} },
        },
      }),
      "a failure of the needs-human persist step is not covered by any alert",
    ).toBe(true);
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
    // CRITICAL: the changeset-key dedup guard must appear BEFORE the committed-
    // note scan. Pre-fix, the ONLY dedup lived inside the per-note for-loop,
    // reachable only when a note file was in the diff — exactly what the
    // empty-NOTES mixed run bypasses. Anchored on the git-diff invocation that
    // produces the note list rather than on the bash builtin that reads it.
    const guardIdx = body.indexOf("drift-changeset: ${CHANGESET_KEY}");
    const noteScanIdx = body.search(/git diff --name-only "\$BASE_SHA" HEAD/);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(noteScanIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(noteScanIdx);
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

  it("DRIFT.md documents the ONLY way out of a rejection-suppressed changeset", () => {
    // Closing a drift-sync PR suppresses that changeset permanently, and the
    // self-heal lists `--state open` only so it never touches the closed PR. The
    // Slack notice names the escape hatch, but a maintainer reading the docs must
    // find it too — this is the one instruction whose absence leaves a drifted
    // registry with no discoverable recovery.
    const driftMd = readFileSync(resolve(__dirname, "../../DRIFT.md"), "utf-8");
    expect(driftMd, "DRIFT.md does not say that closing a PR rejects the changeset").toMatch(
      /CLOSED[\s\S]{0,200}reject/i,
    );
    expect(
      driftMd,
      "DRIFT.md documents no way to un-suppress a rejected changeset, so the registry " +
        "stays drifted with no discoverable recovery",
    ).toMatch(/REOPEN/);
    // The notice is ONE-SHOT (an ack marker on the closed PR), so a doc promising a
    // line every morning teaches a maintainer to read the silence as the
    // suppression having broken — and to go closing PRs again to re-arm it.
    expect(
      driftMd,
      "DRIFT.md still says EVERY suppressed run posts a Slack line, which it does not — " +
        "the suppression is reported once, on the first run after the closure",
    ).not.toMatch(/every suppressed run posts/i);
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
  /**
   * A stand-in drift-sync whose machine line is BUILT from drift-sync.ts's own
   * emitter, never transcribed.
   *
   * The previous fixture hand-copied the human-facing `  [skipped] …` log prose
   * the workflow used to grep — and had already drifted from it, naming a
   * provider `google` where the real enum emits `gemini`. Rewording that
   * `console.log` therefore left this suite green while turning detection off.
   */
  const syncStub = (skipped: { provider: string; reason: string }[], withLine = true): string =>
    [
      "#!/bin/sh",
      ...skipped.map((s) => `echo '  [skipped] ${s.provider}: ${s.reason}'`),
      ...(withLine ? [`echo '${formatUncheckedProvidersLine(skipped)}'`] : []),
      "echo 'reason=ok-no-churn'",
      "echo 'changeset-key='",
      "exit 0",
    ].join("\n");

  const REVOKED = { provider: "gemini", reason: infraSkipReason(401, "gemini") };
  const TRANSIENT = { provider: "openai", reason: infraSkipReason(429, "openai") };

  it("the workflow keys on the MACHINE line drift-sync emits, not on its log prose", () => {
    expect(
      codeOf(stepById("sync")),
      "the stale-key preflight does not grep the machine line drift-sync actually prints, " +
        "so the emitter and the detector can silently disagree",
    ).toContain(`grep '^${UNCHECKED_PROVIDERS_LINE_PREFIX}'`);
  });

  it("the machine line's EMISSION is unconditional in drift-sync.ts, not just its FORMAT", () => {
    // The stub above builds the line from the real emitter, so its FORMAT cannot
    // drift — but nothing exercised the CALL SITE, and the whole value of the line
    // is that its ABSENCE is itself a detectable fault. Wrapping the emission in
    // `if (outcome.skipped.length > 0)` left every guard green while turning a
    // healthy quiet day into a `provider-unchecked` reclassify that reds and
    // alerts every morning — and a line that can legitimately be missing can no
    // longer prove anything by being missing.
    //
    // Pinned on the statement's FORM rather than by running it: runDriftSyncCli
    // awaits a live listing from every provider, so there is nothing to observe
    // here without the network.
    const src = readFileSync(resolve(__dirname, "../../scripts/drift-sync.ts"), "utf-8");
    const calls = [...src.matchAll(/^(.*)console\.log\(formatUncheckedProvidersLine\(/gm)];
    expect(
      calls.length,
      "drift-sync.ts emits the machine line from no single place, so the workflow's stale-key " +
        "preflight has nothing dependable to grep",
    ).toBe(1);
    expect(
      calls[0][1],
      "the machine line is emitted CONDITIONALLY — a healthy quiet day then prints no line " +
        "at all, the workflow reclassifies it `provider-unchecked`, and the cron alerts " +
        "every morning about providers that were checked fine",
    ).toBe("  ");
  });

  it("the skip CLASSIFIER agrees with the reason builders, and still tolerates transient classes", () => {
    // Both sides of this read the same two prose constants inside drift-sync.ts,
    // so a reword cannot make the builder and the classifier disagree.
    expect(isCredentialUnusableSkip(missingKeySkipReason("GOOGLE_API_KEY", "gemini"))).toBe(true);
    for (const status of [401, 402, 403]) {
      expect(isCredentialUnusableSkip(infraSkipReason(status, "gemini"))).toBe(true);
    }
    // 429 and 5xx resolve on their own and must never red an unattended cron.
    for (const status of [429, 500, 503]) {
      expect(isCredentialUnusableSkip(infraSkipReason(status, "openai"))).toBe(false);
    }
    expect(isCredentialUnusableSkip("live listing unavailable")).toBe(false);
  });

  it("a revoked key reported as ok-no-churn fails the step and raises an alert", () => {
    const obs = observeSyncStep(wf, syncStub([REVOKED]));
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
      .filter(isAlertStep)
      .filter((s) => (s.if ?? "").includes(`'${reason}'`));
    expect(
      keyed.map((s) => s.name),
      `the step publishes reason='${reason}' for an unchecked provider, but no alert ` +
        "step's `if:` mentions it — the reason is published into a void",
    ).not.toEqual([]);
  });

  it("KNOWN-NEGATIVE: a genuinely quiet day (and a TRANSIENT skip) stays quiet", () => {
    // Without this the guard above is satisfiable by a preflight that reds every
    // single run, which is a different way of telling a human nothing.
    for (const skipped of [[], [TRANSIENT]]) {
      const obs = observeSyncStep(wf, syncStub(skipped));
      expect(
        obs.outputs.reason,
        `a run whose only skip was transient (${JSON.stringify(skipped)}) was reclassified — ` +
          "a daily cron that reds on a 429 gets muted by the humans reading it",
      ).toBe(SyncCoreReason.OK_NO_CHURN);
      expect(obs.stepExit, "a quiet day failed the step").toBe(0);
    }
  });

  it("an ABSENT machine line is a FAULT, not proof that every provider was checked", () => {
    // "The line is missing" means the log could not be read, or drift-sync never
    // got that far. An UNKNOWN must not resolve to the answer that passes.
    const obs = observeSyncStep(wf, syncStub([REVOKED], false));
    expect(
      obs.outputs.reason,
      "drift-sync printed no unchecked-providers= line at all and the step still published " +
        "ok-no-churn — so an unprovable run is indistinguishable from a quiet one",
    ).not.toBe(SyncCoreReason.OK_NO_CHURN);
    expect(obs.stepExit, "an unprovable run left the step green").not.toBe(0);
  });

  it("an UNREADABLE sync log is a FAULT too — grep exit 2 is not grep exit 1", () => {
    // OBSERVED, by running the preflight's own shell with a log path that does not
    // exist (the `tee` failed): grep exits 2, not 1. `|| true` collapsed both into
    // "" = "every provider was checked", so an unreadable log read as proof of the
    // answer that passes.
    const preflight = ifBlock(
      codeOf(stepById("sync")),
      'if [ "${REASON}" = "ok-no-churn" ]; then',
      "sync",
    );
    const dir = mkdtempSync(join(tmpdir(), "fix-drift-log-"));
    try {
      const good = join(dir, "sync.log");
      writeFileSync(good, `${formatUncheckedProvidersLine([REVOKED])}\nreason=ok-no-churn\n`);
      const clean = join(dir, "clean.log");
      writeFileSync(clean, `${formatUncheckedProvidersLine([])}\nreason=ok-no-churn\n`);
      const cases: Array<[string, string, string]> = [
        [good, "provider-unchecked", "a named unchecked provider did not reclassify the run"],
        [clean, "ok-no-churn", "an empty unchecked-provider list reclassified a quiet day"],
        [
          join(dir, "never-written.log"),
          "provider-unchecked",
          "an UNREADABLE log (grep exit 2) read as 'every provider was checked' — the " +
            "answer that passes",
        ],
      ];
      for (const [logPath, want, why] of cases) {
        const res = runFragment(
          preflight,
          { REASON: SyncCoreReason.OK_NO_CHURN, SYNC_LOG: logPath },
          "REASON",
        );
        expect(res.value, `${why} (log=${logPath}, stdio=${res.out.trim()})`).toBe(want);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// `bot_managed` — the predicate that decides WHICH open PRs the marker self-heal
// is allowed to touch. It had NO test anywhere, while the workflow comment
// asserted "A test pins this pattern against BOTH branch-construction sites".
// A comment claiming a guard that does not exist is worse than no comment: the
// widening the whole self-heal rests on was unfalsifiable, and reverting
// `bot_managed` to key-only (or typo-ing the bot login) left the suite green.
//
// Every case below RUNS the workflow's own jq definitions.
// ---------------------------------------------------------------------------
describe("fix-drift.yml — bot_managed decides candidacy, and is pinned to both branch builders", () => {
  const jqLib = (): string => {
    const m = /JQ_LIB='([\s\S]*?)'/.exec(codeOf(stepById("needs_human_pr")));
    if (!m) throw new Error("needs_human_pr: no JQ_LIB definition block");
    return m[1];
  };
  const def = (name: string, prJson: unknown): unknown => jqEval(`${jqLib()} ${name}`, prJson);

  /** The drift bot's own login, as GitHub reports it for a GitHub App. */
  const BOT = "app/copilotkit-devops-bot";
  const RUN_ID = "30885817052";
  const KEY = "eaa8db65f5647493";

  /**
   * The branch strings the workflow's TWO branch builders actually produce, by
   * RUNNING their own `BRANCH=` assignments under bash (with `git rev-parse
   * --abbrev-ref HEAD` standing in for the branch the `Configure git` step
   * created). Pinning `keyed_branch` against a hand-written branch string instead
   * would let either builder change shape while the pattern stayed green — and
   * then the self-heal silently selects nothing.
   */
  const builtBranches = (): { okApplied: string; needsHuman: string } => {
    const checkout = /git checkout -B "([^"]+)"/.exec(codeOf(stepById("gitcfg")))?.[1];
    const prBranch = /BRANCH="([^"]+)"/.exec(codeOf(stepById("pr")))?.[1];
    const nhBranch = /BRANCH="([^"]+)"/.exec(codeOf(stepById("needs_human_pr")))?.[1];
    if (!checkout || !prBranch || !nhBranch) throw new Error("a BRANCH= builder moved");
    const res = runFragment(
      [
        `RUN_ID=${JSON.stringify(RUN_ID)}`,
        `CHANGESET_KEY=${JSON.stringify(KEY)}`,
        `HEAD_BRANCH="${checkout}"`,
        "git() { printf '%s\\n' \"$HEAD_BRANCH\"; }",
        `OK_APPLIED="${prBranch}"`,
        `NEEDS_HUMAN="${nhBranch}"`,
        // A branch name cannot contain a space, so this separator is unambiguous.
        'BOTH="${OK_APPLIED} ${NEEDS_HUMAN}"',
      ].join("\n"),
      {},
      "BOTH",
    );
    const [okApplied, needsHuman] = res.value.split(" ");
    return { okApplied, needsHuman };
  };

  it("keyed_branch accepts what BOTH branch builders actually produce", () => {
    const { okApplied, needsHuman } = builtBranches();
    for (const branch of [okApplied, needsHuman]) {
      expect(branch, "a branch builder produced nothing").toBeTruthy();
      expect(
        def("keyed_branch", { headRefName: branch }),
        `keyed_branch does not match the branch this workflow actually pushes (${branch}), so ` +
          "the marker self-heal will not recognise its own PR and silently selects nothing",
      ).toBe(true);
    }
    // Both must therefore be bot-managed without needing the author signal.
    for (const branch of [okApplied, needsHuman]) {
      expect(def("bot_managed", { headRefName: branch, author: { login: "jpr5" } })).toBe(true);
    }
  });

  it("a bot PR on a PRE-KEY-ERA drift branch is still a candidate (that is what bot_author is for)", () => {
    // #350/#343/#337 are all `drift-needs-human/<date>-<run id>` with no key
    // suffix — the trailing key arrived with the self-heal itself. Keyed on the
    // branch shape alone, the self-heal selected NOTHING on exactly the PRs that
    // motivated it.
    const legacy = { headRefName: `drift-needs-human/2026-08-04-${RUN_ID}` };
    expect(def("keyed_branch", legacy), "the legacy branch is not key-anchored (premise)").toBe(
      false,
    );
    expect(
      def("bot_managed", { ...legacy, author: { login: BOT } }),
      "a bot-authored PR on a pre-key-era drift branch is not a candidate, so its lost " +
        "markers can never be repaired — verbatim the #343 -> #350 mechanism",
    ).toBe(true);
    // Case-insensitively, since GitHub's login casing is not guaranteed.
    expect(def("bot_managed", { ...legacy, author: { login: BOT.toUpperCase() } })).toBe(true);
  });

  it("a HUMAN's drift branch and an unrelated bot PR are NOT candidates", () => {
    // `^fix/drift-` alone is not a bot marker: humans use `fix/drift-<slug>` for
    // drift work (the needs-human PR body asks them to), and matching one lets
    // this step append machine markers to a human's PR body and fold that PR into
    // the bot's dedup set — suppressing a genuine needs-human PR indefinitely.
    expect(
      def("bot_managed", { headRefName: "fix/drift-alert-signal", author: { login: "jpr5" } }),
      "a HUMAN's fix/drift-<slug> PR is treated as bot-managed",
    ).toBe(false);
    // …and widening on the author must not drag in a bot PR from another workflow.
    expect(
      def("bot_managed", { headRefName: "renovate/vitest-3.x", author: { login: BOT } }),
      "an unrelated bot PR is treated as bot-managed, so it enters this step's " +
        "fail-closed changed-file audit and can wedge the daily cron",
    ).toBe(false);
    // A missing author must not throw (a deleted account is not a payload fault).
    expect(def("bot_managed", { headRefName: "fix/drift-alert-signal" })).toBe(false);
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

  const HEAL_LOOP = "while IFS= read -r pr; do";

  it("each PR-open step's marker self-healer can actually REPAIR — on the artifact it repairs with", () => {
    for (const st of prSteps()) {
      const code = codeOf(st);
      // (a) The candidate listing must be index-FREE. `--search`'s index is
      // body-keyed AND lags an edit by minutes, so it cannot see the very body
      // being repaired. Asked of the listing ITSELF: the previous guard sliced
      // `code.slice(0, code.indexOf("gh pr edit"))` and then applied a
      // `(?![\s\S]*gh pr edit)` lookahead to it — a slice that by construction
      // contains no `gh pr edit`, so the lookahead could never match and the
      // prohibition was structurally unable to fail.
      const listing = ghListFor(code, "MANAGED", st.name!);
      expect(
        listing,
        `${st.name}: the marker-repair candidate listing is not a plain --state open query`,
      ).toContain("--state open");
      expect(
        listing,
        `${st.name}: the candidate listing for the marker repair uses --search, whose ` +
          "body-keyed index cannot see the very body being repaired",
      ).not.toContain("--search");

      // (b) The repair LOOP must iterate the selected candidates. Redirecting its
      // `done` from anything else (`printf ''`) leaves the self-healer entirely
      // dead while every text assertion about its body still passes.
      const loop = whileLoop(code, HEAL_LOOP, st.name!);
      expect(
        loop.split("\n").at(-1)?.trim(),
        `${st.name}: the marker-repair loop does not read the selected candidates, so ` +
          "it iterates nothing and the self-healer is dead",
      ).toBe(`done < <(printf '%s' "$MINE" | jq -c '.[]')`);

      // (c) ONE missing marker is enough to repair — the #343 -> #350 incident
      // shape exactly. `-gt 1` leaves a PR that lost a single marker unrepaired.
      expect(
        loop,
        `${st.name}: the repair needs more than one missing marker, so a PR that lost ` +
          "exactly one (the #343 -> #350 incident shape) is never repaired",
      ).toContain(`[ "\${#MISSING[@]}" -gt 0 ] || continue`);

      // (d) The WRITER must write the `<!-- … -->` form, checked against the
      // WRITER and nothing else. The previous guard asserted this over the whole
      // step, where the unrelated PR-BODY writer's `echo "<!-- ${m} -->"` satisfied
      // it independently — so the repair could be changed to append bare markers
      // (which its own detector then never matches: an appending ratchet, every
      // run, forever) with the guard still green. Wrong artifact.
      const writer = braceGroup(loop, '"$HEAL_FILE"', st.name!);
      expect(
        writer,
        `${st.name}: the marker repair does not restore the "<!-- … -->" marker form its ` +
          "own detector matches, so every later run re-edits the body",
      ).toContain(`printf '<!-- %s -->\\n' "$m"`);
      // …and the DETECTOR must match that same form, or an intact body reads as missing.
      expect(
        loop,
        `${st.name}: the repair's own missing-marker detector does not match the form the ` +
          "writer writes",
      ).toContain(`case "$HEAL_BODY" in *"<!-- \${m} -->"*`);

      // (e) The repair is written with `--body-file` (a `--body "$(cat …)"` form
      // re-expands `${…}` in a human's prose).
      expect(
        loop,
        `${st.name}: never re-writes a PR body, so a human deleting a marker leaves ` +
          "dedup blind and the next run opens a duplicate",
      ).toMatch(/gh pr edit .*--body-file/);

      // (f) Identity is body-INDEPENDENT: the pushed branch carries the key.
      expect(
        code,
        `${st.name}: the pushed branch does not end in the changeset key, so the marker ` +
          "repair has no body-independent anchor to recognise its own PR by",
      ).toMatch(/BRANCH="[^"\n]*\$\{CHANGESET_KEY\}"/);
    }
  });

  // The live payload this dedup is evaluated against today, read off
  // `gh pr list --state all --search "eaa8db65f5647493 in:body"` on 2026-08-04:
  // a CLOSED spam duplicate and the MERGED original, with the changeset marker in
  // both bodies.
  const KEY = "eaa8db65f5647493";
  const MARKER = `drift-changeset: ${KEY}`;
  const pr = (number: number, state: string) => ({
    number,
    url: `https://github.test/pr/${number}`,
    state,
    body: `prose\n<!-- ${MARKER} -->\nmore prose`,
  });
  const CLOSED_DUPLICATE = pr(350, "CLOSED");
  const MERGED_ORIGINAL = pr(343, "MERGED");
  const OPEN_PENDING = pr(351, "OPEN");
  /** The ack marker the suppression notice's one-shot is keyed on. */
  const ACK_MARKER = `drift-suppression-reported: ${KEY}`;
  const CLOSED_AND_ACKED = {
    ...CLOSED_DUPLICATE,
    body: `${CLOSED_DUPLICATE.body}\n<!-- ${ACK_MARKER} -->`,
  };
  /** A re-fire whose note is already committed: `git rev-parse HEAD` == `BASE_SHA`. */
  const NO_NEW_COMMIT = "3333333333333333333333333333333333333333";

  /**
   * Evaluate a step's dedup selectors against a payload IN THE ORDER THE STEP
   * EVALUATES THEM (the order is read off the artifact, not assumed), and report
   * which decision fires first.
   */
  function firstDecision(st: Step, allPrs: unknown[]): { name: string; number?: number } {
    const code = codeOf(st);
    const env: Record<string, unknown> = { ALL_PRS: allPrs };
    // The needs-human path narrows to OPEN first; the ok-applied path selects
    // `.state == "OPEN"` inline. Resolve whichever exists.
    const openPrs = code.includes('OPEN_PRS="') ? jqAssignment(code, "OPEN_PRS", st.name!) : null;
    if (openPrs) env.OPEN_PRS = jqEval(openPrs.program, env[openPrs.reads]);
    const decisions = (["DUP", "REJECTED_PR"] as const)
      .map((name) => ({
        name,
        // Through `locate`: a -1 here would silently INVERT the evaluation order
        // this function exists to report.
        at: locate(code, `${name}="`, st.name!),
        ...jqAssignment(code, name, st.name!),
      }))
      .sort((a, b) => a.at - b.at);
    for (const d of decisions) {
      const hit = jqEval(d.program, env[d.reads], { m: MARKER }) as { number: number } | undefined;
      if (hit !== undefined) return { name: d.name, number: hit.number };
    }
    return { name: "none" };
  }

  it("a CLOSED duplicate cannot outrank a still-OPEN proposal (the #350/#343 shape, live-observed)", () => {
    for (const st of prSteps()) {
      const code = codeOf(st);
      // TEXT ORDER: the open-duplicate path must RETURN before the rejection test
      // is even reached, or a closed PR still wins.
      const dupAt = code.indexOf("already proposed in open PR");
      const rejAt = code.indexOf('REJECTED_PR="');
      expect(dupAt, `${st.name}: no open-duplicate path to order`).toBeGreaterThanOrEqual(0);
      expect(rejAt, `${st.name}: no closed-rejection test to order`).toBeGreaterThanOrEqual(0);
      expect(
        dupAt,
        `${st.name}: the closed-rejection test runs BEFORE the open-duplicate test, so a ` +
          "human closing the spam DUPLICATE reads as rejecting the changeset itself and " +
          "suppresses a decision still pending in an open PR",
      ).toBeLessThan(rejAt);
      expect(
        code.slice(dupAt, rejAt),
        `${st.name}: the open-duplicate path does not exit before the rejection test`,
      ).toMatch(/^\s*exit 0$/m);

      // …and the rejection is REACHED, and ACTED ON, on the path where an
      // unrelated gate used to return in front of it: a daily re-fire whose note
      // is already in the repo, so there is no new commit to push. RUN, because
      // every text-shaped version of this claim was defeated without touching
      // behaviour — enumerating the `exit 0` lines before the selector missed
      // `exit 0 # nothing to push` and a bare `exit`, and both that and the
      // position compare above are satisfied by leaving the selector where it is
      // and moving the block that ACTS on it below the gate. Each of those
      // restores the same bug: no `rejected` published, so the suppression notice
      // cannot fire and the needs-human alert reds the job every morning.
      const refire = observePersistStep(st, {
        searchPrs: [CLOSED_DUPLICATE, MERGED_ORIGINAL],
        headSha: NO_NEW_COMMIT,
        baseSha: NO_NEW_COMMIT,
      });
      expect(
        refire.stepExit,
        `${st.name}: respecting a human rejection FAILS the step: ${refire.stdio}`,
      ).toBe(0);
      expect(
        refire.outputs.rejected,
        `${st.name}: on a re-fire with NO new commit to push, the human rejection is never ` +
          "detected — nothing publishes `rejected`, so the suppression notice cannot fire and " +
          `the needs-human alert reds the job every morning instead: ${refire.stdio}`,
      ).toBe("350");
      expect(
        refire.outputs.rejected_url,
        `${st.name}: the rejection is detected but publishes no url, so the notice cannot ` +
          "link the closing PR a human has to reopen",
      ).toBe("https://github.test/pr/350");

      // …and the selectors, RUN for real, behave that way on the live payload.
      expect(
        firstDecision(st, [CLOSED_DUPLICATE, MERGED_ORIGINAL, OPEN_PENDING]),
        `${st.name}: with a pending OPEN proposal present, the first decision is not the ` +
          "duplicate one",
      ).toEqual({ name: "DUP", number: 351 });
      expect(
        firstDecision(st, [CLOSED_DUPLICATE, MERGED_ORIGINAL]),
        `${st.name}: with the proposal closed and nothing open, the rejection is not respected`,
      ).toEqual({ name: "REJECTED_PR", number: 350 });
      // A MERGED PR is an ACCEPTED decision. It must read as neither.
      expect(
        firstDecision(st, [MERGED_ORIGINAL]),
        `${st.name}: a MERGED proposal reads as a rejection or a pending duplicate`,
      ).toEqual({ name: "none" });
    }
  });

  it("an already-proposed changeset still NAMES its open PR, so the run is not green and silent", () => {
    // The dedup return used to throw $DUP away and publish nothing but the fact
    // that it deduped. `notify_success` is gated on `steps.pr.outputs.url != ''`,
    // so that run said nothing at all about a proposal still sitting open and
    // unmerged — green, and silent about a pending human decision.
    const dup = observePersistStep(stepById("pr"), { searchPrs: [OPEN_PENDING] });
    expect(dup.stepExit, `the open-duplicate path fails the step: ${dup.stdio}`).toBe(0);
    expect(dup.outputs.deduped, "the run did not actually take the dedup path").toBe("true");
    expect(
      [dup.outputs.url, dup.outputs.number],
      "the dedup path publishes no url/number for the open PR it found, so `notify_success` " +
        "(gated on `steps.pr.outputs.url`) is skipped and the run is green and silent about a " +
        "proposal a human still has to merge",
    ).toEqual(["https://github.test/pr/351", "351"]);
  });

  it("each dedup listing sees CLOSED PRs, and the CLOSED selector reads THAT listing", () => {
    for (const st of prSteps()) {
      const code = codeOf(st);
      const listing = ghListFor(code, "ALL_PRS", st.name!);
      expect(
        listing,
        `${st.name}: the dedup listing is scoped to open PRs, so the moment a human ` +
          "CLOSES a proposal to reject it the next cron run stops seeing it and opens a " +
          "fresh one — daily, forever",
      ).toContain("--state all");
      expect(listing, `${st.name}: the dedup listing is not narrowed on the key`).toContain(
        '--search "${CHANGESET_KEY} in:body"',
      );
      expect(listing, `${st.name}: the dedup listing has no explicit --limit`).toContain(
        "--limit 200",
      );
      // `state` must be REQUESTED, or `.state` is null on every entry and both the
      // CLOSED and the OPEN selectors are dead for every PR at once.
      expect(
        /--json ([A-Za-z,]+)/.exec(listing)?.[1].split(","),
        `${st.name}: the dedup listing does not request the \`state\` field, so \`.state\` ` +
          "is null everywhere and the rejection path can never match",
      ).toContain("state");
      // WIRING, not token presence: the CLOSED selector must consult the
      // all-states listing. Pointed at the OPEN-narrowed view it can never match,
      // and a human rejection is re-proposed every morning.
      expect(
        jqAssignment(code, "REJECTED_PR", st.name!).reads,
        `${st.name}: the CLOSED-PR selector reads a listing that cannot contain closed PRs`,
      ).toBe("ALL_PRS");
    }
    expect(
      stepByName("Alert on needs-human decision").if ?? "",
      "the needs-human alert still fires for a changeset a human already rejected — " +
        "re-alerting every morning is the spam that made following the instruction a " +
        "punishment",
    ).toContain("steps.needs_human_pr.outputs.rejected == ''");
  });

  it("a suppressed changeset is still REPORTED — the re-proposal is suppressed, not the telling", () => {
    // Quiet used to mean silent: `exit 0`, no PR, the needs-human alert gated on
    // `rejected == ''`, and on the ok-applied path a `rejected` output that NO
    // step read. A run in that state was byte-identical to a quiet day, and the
    // only way out was reopening the closed PR — which nobody knew to do.
    for (const st of prSteps()) {
      const code = codeOf(st);
      const block = ifBlock(code, 'if [ -n "$REJECTED_PR" ]; then', st.name!);
      expect(
        block,
        `${st.name}: the suppression does not publish the closing PR, so nothing can name it`,
      ).toMatch(/echo "rejected=\$\{REJECTED\}"/);
      expect(
        block,
        `${st.name}: the suppression publishes no url, so an alert cannot link the closing PR`,
      ).toMatch(/rejected_url=/);
    }
    const notice = stepByName("Notify Slack on a SUPPRESSED (human-rejected) changeset");
    // Both paths' outputs must be READ, or one of them suppresses in silence.
    for (const output of ["steps.pr.outputs.rejected", "steps.needs_human_pr.outputs.rejected"]) {
      expect(
        notice.if ?? "",
        `a changeset suppressed on one path is never reported: ${output} is not read`,
      ).toContain(`${output} != ''`);
    }
    const msg = assembleSlackMessage(notice, {
      PR_REJECTED: "350",
      PR_REJECTED_URL: "https://github.test/pr/350",
    });
    expect(msg, "the suppression notice does not name the closing PR").toContain("#350");
    expect(msg, "the suppression notice does not link the closing PR").toContain(
      "https://github.test/pr/350",
    );
    expect(
      msg,
      "the suppression notice names no way back out, so a human who finds it cannot act",
    ).toMatch(/REOPEN/);
  });

  /** Would the suppression notice be selected, given these persist-step outputs? */
  const noticeFires = (outputs: Record<string, string>, job = { failed: false }): boolean =>
    evaluateIf(stepByName("Notify Slack on a SUPPRESSED (human-rejected) changeset").if!, {
      event_name: "schedule",
      jobFailed: job.failed,
      jobCancelled: false,
      steps: {
        sync: { outcome: "success", outputs: { reason: SyncCoreReason.NEEDS_HUMAN } },
        needs_human_pr: { outcome: "success", outputs },
      },
    });

  it("a PERMANENT suppression is reported ONCE, not byte-identically every morning", () => {
    // A closed PR stays closed and the changeset key is deliberately
    // date-independent, so `rejected` alone made this notice re-post the same
    // line every daily run, for ever — on the same channel as the real alerts.
    // That is the fatigue this workflow is being fixed for wearing a new hat, and
    // a channel people learn to ignore is silence by another route. So the notice
    // is keyed on a state that CHANGES: an ack marker on the closed PR's own
    // body, which outlives the run.
    // EXECUTED, over both states of the closed PR's body. Which branch publishes
    // `rejected_ack` is not a question a regex can answer, and it is the state
    // that silences the notice for ever: dropping `jq -e` (jq then exits 0
    // whatever the boolean says), inverting `contains`, or publishing
    // `rejected_ack=true` before the check each takes the "already reported"
    // branch on EVERY run, so the suppression is never narrated to anyone — while
    // a marker that is not byte-stable (a date folded into it, say) re-posts a
    // near-identical line every morning, which is the fatigue it exists to stop.
    for (const st of prSteps()) {
      const first = observePersistStep(st, { searchPrs: [CLOSED_DUPLICATE] });
      expect(
        first.outputs.rejected,
        `${st.name}: the suppression publishes no \`rejected\`, so the needs-human alert ` +
          `fires again for a decision a human already refused: ${first.stdio}`,
      ).toBe("350");
      expect(
        first.outputs.rejected_ack,
        `${st.name}: the FIRST run after the closure already reads as reported, so the notice ` +
          "stands down and the suppression is never narrated to anyone",
      ).toBeUndefined();

      const again = observePersistStep(st, { searchPrs: [CLOSED_AND_ACKED] });
      expect(
        again.outputs.rejected_ack,
        `${st.name}: a closed PR that CARRIES the ack marker is not recognised, so the notice ` +
          "re-posts the same suppression line every morning for ever",
      ).toBe("true");
      expect(
        again.outputs.rejected,
        `${st.name}: an already-reported suppression stops publishing \`rejected\`, so the ` +
          "needs-human alert starts firing again for a refused decision",
      ).toBe("350");
    }
    for (const id of ["pr", "needs_human_pr"]) {
      expect(
        stepByName("Notify Slack on a SUPPRESSED (human-rejected) changeset").if ?? "",
        `the notice does not read steps.${id}.outputs.rejected_ack, so that path re-posts ` +
          "the same suppression line every morning",
      ).toContain(`steps.${id}.outputs.rejected_ack != 'true'`);
    }
    // EXECUTED against the real `if:`: fires on the first run, stands down after.
    expect(
      noticeFires({ rejected: "350", rejected_url: "https://github.test/pr/350" }),
      "the suppression is never reported at all",
    ).toBe(true);
    expect(
      noticeFires({ rejected: "350", rejected_ack: "true" }),
      "an already-reported suppression re-posts the same line",
    ).toBe(false);
    // FAIL OPEN: an ack that could not be recorded must cost a repeat ping, never
    // a suppression nobody was ever told about.
    expect(
      noticeFires({ rejected: "350", rejected_ack: "" }),
      "an unrecorded ack silences the notice — the failure direction that loses the telling",
    ).toBe(true);
  });

  it("the suppression notice is not gated on the JOB's status — a respected rejection is neither", () => {
    // `always()` is load-bearing twice over: keyed on `failure()` the notice
    // vanishes on the green run that is its normal shape, and with no status
    // function at all the implicit `success()` drops it in exactly the window the
    // needs-human alert was just fixed for (any later step failing).
    for (const failed of [false, true]) {
      expect(
        noticeFires({ rejected: "350" }, { failed }),
        `a suppressed changeset goes unreported when the job ${failed ? "FAILS" : "is GREEN"}`,
      ).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // THE RECEIPT MUST FOLLOW THE DELIVERY.
  //
  // `rejected_ack` is the state that silences the notice for ever, so the only
  // thing entitled to write it is a DELIVERED notice. Written inside the persist
  // step — which runs several steps BEFORE the POST — it recorded the telling in
  // advance: the marker landed, the POST then failed, and every run after it read
  // `rejected_ack=true`, stood the notice down and exited GREEN and silent, with
  // the suppression permanently un-narrated. Reached with CERTAINTY, not by
  // chance, whenever the webhook has been rotated — which kills the catch-all's
  // POST the same day, so nothing is delivered at all and the run leaves behind
  // only a red cron job.
  //
  // These guards are about ORDER and GATING, not about a string having moved. The
  // writer is located from the artifact (whichever step builds the ack body file),
  // its position is compared against the notice's, and whether it can run without
  // a delivered POST is settled by SIMULATING the job with that POST failing.
  // -------------------------------------------------------------------------

  const NOTICE = "Notify Slack on a SUPPRESSED (human-rejected) changeset";
  const ACK_KEY = "eaa8db65f5647493";

  /** Every step that WRITES the ack into a PR body, i.e. builds the ack body file. */
  const ackWriters = (): Step[] => steps().filter((s) => /\bACK_FILE=/.test(codeOf(s)));

  /**
   * The one step that writes it — a receipt with two issuers is not a receipt —
   * together with its position in the job.
   *
   * Both come out of a SINGLE `steps()` call: that function re-parses on every
   * invocation, so `steps().indexOf(otherCall()[n])` compares objects from two
   * different arrays and yields -1, which every real step index beats. That is the
   * shape that made an earlier ordering claim in this file trivially true.
   */
  const ackWriter = (): { step: Step; at: number; order: Step[] } => {
    const order = steps();
    const found = order
      .map((s, at) => ({ s, at }))
      .filter(({ s }) => /\bACK_FILE=/.test(codeOf(s)));
    expect(
      found.map(({ s }) => s.id ?? s.name),
      "the suppression ack is written by a number of steps other than one, so `rejected_ack` " +
        "cannot mean 'the telling was delivered' — exactly one step may issue the receipt",
    ).toHaveLength(1);
    return { step: found[0].s, at: found[0].at, order };
  };

  /** A closed bot PR as `gh pr view --json body,headRefName,author` returns it. */
  const closedBotPr = (body: string): unknown => ({
    body,
    headRefName: `drift-needs-human/2026-08-04-9876543210`,
    author: { login: "app/copilotkit-devops-bot" },
  });

  /**
   * EXECUTE the ack step's own `run:` body against a stubbed `gh`, and report what
   * it did to the closed PR.
   *
   * An OBSERVATION, not a text assertion: "does the receipt land on the PR the
   * human was told about, append-only, once, and never on a body this workflow
   * does not own" are questions about control flow. `gh pr view` answers with
   * `prJson`; `gh pr edit` records its argv and the body file it was handed.
   */
  const observeAckWrite = (
    step: Step,
    {
      prJson,
      viewExit = 0,
      editExit = 0,
      env: envOverride = {},
    }: {
      prJson: unknown;
      viewExit?: number;
      editExit?: number;
      env?: Record<string, string>;
    },
  ): { stepExit: number; ghLog: string; written: string; stdio: string } => {
    const dir = mkdtempSync(join(tmpdir(), "fix-drift-ack-"));
    try {
      const bin = delegatingBin(["gh"]);
      const prFile = join(dir, "pr.json");
      const logFile = join(dir, "gh.log");
      const bodyFile = join(dir, "written");
      writeFileSync(prFile, JSON.stringify(prJson));
      writeFileSync(logFile, "");
      writeFileSync(bodyFile, "");
      const ghFile = join(dir, "gh-stub.sh");
      writeFileSync(
        ghFile,
        [
          `printf '%s\\n' "$*" >> ${JSON.stringify(logFile)}`,
          'if [ "$1 $2" = "pr view" ]; then',
          `  cat ${JSON.stringify(prFile)}`,
          `  exit ${viewExit}`,
          "fi",
          'if [ "$1 $2" = "pr edit" ]; then',
          "  while [ $# -gt 0 ]; do",
          `    [ "$1" = "--body-file" ] && cp "$2" ${JSON.stringify(bodyFile)}`,
          "    shift",
          "  done",
          `  exit ${editExit}`,
          "fi",
          "exit 0",
        ].join("\n"),
      );
      // Every declared `env:` key gets a value, so `set -u` is never what stops
      // the body — the same discipline as ALERT_ENV_STUB.
      const env: Record<string, string> = {};
      for (const key of Object.keys(step.env)) env[key] = "";
      const script = join(dir, "step.sh");
      writeFileSync(script, runOf(step));
      const res = spawnSync("/bin/bash", [script], {
        cwd: dir,
        encoding: "utf-8",
        env: {
          ...process.env,
          ...env,
          ...envOverride,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          [stubVar("gh")]: ghFile,
          GITHUB_OUTPUT: join(dir, "github_output"),
          RUNNER_TEMP: dir,
        },
      });
      if (res.error) throw res.error;
      return {
        stepExit: res.status ?? -1,
        ghLog: readFileSync(logFile, "utf-8"),
        written: readFileSync(bodyFile, "utf-8"),
        stdio: `${res.stdout ?? ""}${res.stderr ?? ""}`,
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("the ack that silences the notice is written AFTER it, by exactly one step, gated on delivery", () => {
    const { step: writer, at: writeAt, order } = ackWriter();
    const noticeAt = order.findIndex((s) => s.id === "alert_rejected");
    expect(
      noticeAt,
      "there is no `alert_rejected` step for the ack to acknowledge",
    ).toBeGreaterThan(-1);
    expect(
      writeAt,
      `${writer.name}: records the "already told" ack at step ${writeAt + 1}, BEFORE the notice ` +
        `that does the telling at step ${noticeAt + 1}. A dropped POST then leaves the receipt ` +
        "filed for a telling that never happened, and every later run is green and silent",
    ).toBeGreaterThan(noticeAt);
    expect(
      writer.if ?? "",
      `${writer.name}: is not gated on the notice's POSITIVE proof of delivery, so the receipt ` +
        "can be filed for an undelivered telling — a step OUTCOME will not do, a dead webhook " +
        "produces the same one a delivered POST does",
    ).toContain("steps.alert_rejected.outputs.posted == 'true'");
    // …and it is `always()`, or the receipt is skipped on exactly the runs where
    // a later step failed — re-posting the line every morning after one bad day.
    expect(
      writer.if ?? "",
      `${writer.name}: carries no always(), so the implicit success() drops the receipt ` +
        "whenever anything later in the job fails",
    ).toContain("always()");
  });

  it("a DROPPED suppression POST records NO ack — the next run tells someone again", () => {
    const rejection = (failing: string[] = []): Scenario => ({
      failing,
      outputs: {
        sync: { reason: SyncCoreReason.NEEDS_HUMAN, exit_code: "1" },
        needs_human_pr: { rejected: "350", rejected_url: "https://github.test/pr/350" },
      },
    });
    const delivered = simulateJob(rejection());
    expect(
      delivered.alerts,
      "the suppression notice was never delivered in this scenario, so it proves nothing",
    ).toContain(NOTICE);
    expect(
      delivered.selected.map((s) => s.name),
      "the notice was DELIVERED and no step recorded the ack, so the identical line re-posts " +
        "every morning for ever",
    ).toContain(ackWriter().step.name);

    const dropped = simulateJob(rejection(["alert_rejected"]));
    expect(dropped.alerts, "the scenario did not actually drop the suppression POST").not.toContain(
      NOTICE,
    );
    expect(
      dropped.selected.map((s) => s.name),
      "the suppression notice was never even selected on the dropped-POST run",
    ).toContain(NOTICE);
    for (const w of ackWriters()) {
      expect(
        dropped.selected.map((s) => s.name),
        `${w.name}: records the "already told" ack on a run whose POST was REJECTED and which ` +
          "reached Slack with NOTHING. `rejected_ack` then stands the notice down on every " +
          "subsequent run, so the suppression is never narrated to anyone — the fail-silent " +
          "shape this workflow exists to eliminate, and a rotated webhook reaches it with " +
          "certainty rather than by chance",
      ).not.toContain(w.name);
    }
  });

  it("the ack lands on the closing PR the notice named, append-only, and never twice", () => {
    const { step } = ackWriter();
    const body = `human prose a maintainer owns\n<!-- drift-changeset: ${ACK_KEY} -->`;
    const marker = `<!-- drift-suppression-reported: ${ACK_KEY} -->`;

    const nh = observeAckWrite(step, {
      prJson: closedBotPr(body),
      env: { CHANGESET_KEY: ACK_KEY, NH_REJECTED: "350" },
    });
    expect(nh.stepExit, `${step.name}: a successful ack write fails the step`).toBe(0);
    expect(
      nh.ghLog,
      "the ack was not written to the closing PR the needs-human path named",
    ).toContain("pr edit 350");
    expect(nh.written, "the body written carries no ack marker at all").toContain(marker);
    // APPEND-ONLY, BYTE-FOR-BYTE. Asserting the prose and the changeset marker are
    // merely PRESENT accepted a body the ack had mangled: reading it with `jq`
    // instead of `jq -r` writes back the JSON ENCODING of the body — one quoted
    // line whose newlines have become the two characters `\n` — and both
    // substrings survive that intact. What a human owns has to come through
    // unchanged, not just recognisably.
    expect(
      nh.written.slice(0, body.length),
      "the existing body was not copied through VERBATIM — the ack rewrote prose a human " +
        "owns instead of appending after it",
    ).toBe(body);

    // The ok-applied path's closure must be acknowledged too, and it WINS, so the
    // receipt lands on the same PR the notice named.
    const both = observeAckWrite(step, {
      prJson: closedBotPr(body),
      env: { CHANGESET_KEY: ACK_KEY, PR_REJECTED: "351", NH_REJECTED: "350" },
    });
    expect(
      both.ghLog,
      "the receipt does not follow the notice's own precedence (ok-applied closure first), so " +
        "it is filed against a PR other than the one the human was told about",
    ).toContain("pr edit 351");

    // Idempotent: an intact ack is left BYTE-IDENTICAL — no API write, no
    // appending ratchet on a body a human owns.
    const already = observeAckWrite(step, {
      prJson: closedBotPr(`${body}\n${marker}`),
      env: { CHANGESET_KEY: ACK_KEY, NH_REJECTED: "350" },
    });
    expect(
      already.ghLog,
      "a PR that already carries the ack is edited again — an appending ratchet on a human's " +
        "PR body, and the same marker duplicated every run",
    ).not.toContain("pr edit");
    expect(already.stepExit, "an already-acked PR fails the step").toBe(0);
  });

  it("the ack WRITE is scoped to PRs this workflow opened — a human's body is never rewritten", () => {
    // Unlike the marker self-healer, this write had NO ownership filter. Rejection
    // detection is body-keyed and state-blind, so a human PR that quotes or
    // inherits the changeset marker is a candidate — and DRIFT.md asks humans to
    // do drift work on `fix/drift-<slug>` branches, which is exactly the shape
    // that becomes a write target.
    const { step } = ackWriter();
    const unowned: Array<{ label: string; pr: unknown }> = [
      {
        label: "a HUMAN's drift PR (the branch shape DRIFT.md asks humans to use)",
        pr: { body: "my notes", headRefName: "fix/drift-typo", author: { login: "jpr5" } },
      },
      {
        label: "a bot PR from some other workflow entirely",
        pr: {
          body: "chore(deps)",
          headRefName: "renovate/vitest",
          author: { login: "app/copilotkit-devops-bot" },
        },
      },
      {
        label: "a PR whose author gh could not report",
        pr: { body: "x", headRefName: "fix/drift-2026-08-04-1-eaa8db65f5647493", author: null },
      },
    ];
    for (const { label, pr } of unowned) {
      const res = observeAckWrite(step, {
        prJson: pr,
        env: { CHANGESET_KEY: ACK_KEY, NH_REJECTED: "350" },
      });
      expect(
        res.ghLog,
        `${step.name}: rewrites the whole body of ${label} — machine markers appended to prose ` +
          "this workflow does not own, from a copy of the body it read moments earlier",
      ).not.toContain("pr edit");
      expect(res.stepExit, `${step.name}: declining an unowned PR fails the step`).toBe(0);
    }
    // …and the ownership predicate is the SELF-HEALER's, not a second hand-written
    // one that can drift away from it.
    const botLogin = /ascii_downcase\) == "(app\/[a-z0-9-]+)"/.exec(wf)?.[1];
    expect(
      botLogin,
      "the self-healer no longer pins a bot-author login, so nothing anchors the ack write's " +
        "ownership test to it",
    ).toBeTruthy();
    expect(
      codeOf(step),
      "the ack write tests a DIFFERENT bot author than the self-healer's `bot_author`, so one " +
        "of the two is looking for a login that does not exist",
    ).toContain(botLogin!);
    for (const prefix of ["fix/drift-", "drift-needs-human/"]) {
      expect(
        codeOf(step),
        `the ack write does not recognise the \`${prefix}\` branch prefix this workflow opens ` +
          "PRs on, so every suppression on that path re-posts its notice every morning",
      ).toContain(prefix);
    }
  });

  it("every way the ack write can fail costs a REPEATED ping, never the telling", () => {
    // FAIL OPEN, on every path. A receipt that cannot be filed must leave
    // `rejected_ack` unset so tomorrow's run tells someone again — and must not
    // red a run whose telling was DELIVERED, which would report a working alert
    // as a fault and hand the catch-all a cause it would misname.
    const { step } = ackWriter();
    const cases: Array<{ label: string; opts: Parameters<typeof observeAckWrite>[1] }> = [
      {
        label: "`gh pr edit` is rejected (a 403, a locked PR, a token hiccup)",
        opts: {
          prJson: closedBotPr("prose"),
          editExit: 1,
          env: { CHANGESET_KEY: ACK_KEY, NH_REJECTED: "350" },
        },
      },
      {
        label: "`gh pr view` cannot read the closed PR back",
        opts: {
          prJson: { message: "Not Found" },
          viewExit: 1,
          env: { CHANGESET_KEY: ACK_KEY, NH_REJECTED: "350" },
        },
      },
      {
        label: "the changeset key did not reach this step, so no marker can be composed",
        opts: {
          prJson: closedBotPr("prose"),
          env: { CHANGESET_KEY: "", NH_REJECTED: "350" },
        },
      },
      {
        label: "neither path published a closing PR number",
        opts: {
          prJson: closedBotPr("prose"),
          env: { CHANGESET_KEY: ACK_KEY, PR_REJECTED: "", NH_REJECTED: "" },
        },
      },
    ];
    for (const { label, opts } of cases) {
      const res = observeAckWrite(step, opts);
      expect(
        res.stepExit,
        `${step.name}: ${label} — the step exits non-zero, so a run whose suppression notice ` +
          "WAS delivered still reds and the catch-all reports it as an uncovered failure it " +
          "cannot name",
      ).toBe(0);
      expect(
        res.stdio,
        `${step.name}: ${label} — nothing is logged, so the ack silently went unrecorded`,
      ).toContain("::warning::");
    }
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

  it("a DROPPED Slack notification is never mistaken for a delivered one", () => {
    expect(slackSteps().length, "no Slack-posting step found").toBeGreaterThan(0);
    for (const st of slackSteps()) {
      const code = codeOf(st);
      // (a) A missing webhook is a hard stop. Scoped to the branch by its own
      // `fi`, so the assertion cannot be satisfied by an `exit 1` elsewhere.
      const branch = ifBlock(code, 'if [ -z "${SLACK_WEBHOOK:-}" ]; then', st.name!);
      expect(
        branch,
        `${st.name}: a missing webhook means the notification was DROPPED, and exiting 0 ` +
          "leaves the job green while nobody is told",
      ).toMatch(/^\s*exit 1$/m);

      // (b) The POST ITSELF — the likelier way a notification is dropped, and the
      // window the previous guard did not look at, since it only inspected the
      // missing-webhook branch. Without `-f`, Slack answering 404 to a rotated
      // webhook exits 0 and the drop is invisible; with `|| true`, so does
      // everything else.
      const post = curlOf(code, st.name!);
      expect(
        post,
        `${st.name}: the POST drops the -f flag, so a 404 (rotated webhook), 403, 429 or ` +
          "5xx exits 0 and the notification is lost with the job still green",
      ).toMatch(/curl -[a-zA-Z]*f/);
      expect(
        post,
        `${st.name}: the POST's failure is swallowed, so a dropped notification cannot be ` +
          "distinguished from a delivered one",
      ).not.toContain("||");
      // (c) BOUNDED, BY VALUE. No `--max-time` let a hung POST burn the job's
      // whole remaining budget (and a cancellation's 5-minute one); no `--retry`
      // lost the day's only alert to a single Slack 429/5xx. Asserting the flags
      // are merely PRESENT (`/--max-time \d+/`) accepted `0` for both, which is
      // curl's own spelling of "no limit" and "no retries" — so the two defects
      // this check exists to prevent were reachable with it green. Observed
      // against a real socket: `--max-time 0` was still running at 8s where `2`
      // gave rc=28 at 3s; `--retry 0` made one attempt where `2` made three. A
      // third spelling kills the retries without touching `--retry` at all:
      // `--retry-max-time 1` expires the budget before the first `--retry-delay`
      // elapses. So read the numbers and check the relationships between them.
      const maxTime = curlFlagValue(post, "--max-time", st.name!);
      const retry = curlFlagValue(post, "--retry", st.name!);
      const retryDelay = curlFlagValue(post, "--retry-delay", st.name!);
      const retryMaxTime = curlFlagValue(post, "--retry-max-time", st.name!);
      expect(
        maxTime,
        `${st.name}: \`--max-time ${maxTime}\` is curl's "no limit" — a hung Slack can hang ` +
          "the job for its whole remaining budget",
      ).toBeGreaterThan(0);
      expect(
        retry,
        `${st.name}: \`--retry ${retry}\` means NO retries — a single transient Slack ` +
          "failure loses the notification outright",
      ).toBeGreaterThan(0);
      expect(
        retryDelay,
        `${st.name}: \`--retry-delay ${retryDelay}\` retries with no pause, so every attempt ` +
          "lands inside the same transient outage and the retries buy nothing",
      ).toBeGreaterThan(0);
      expect(
        retryMaxTime,
        `${st.name}: \`--retry-max-time ${retryMaxTime}\` expires before ${retry} retries at ` +
          `\`--retry-delay ${retryDelay}\` can even happen — the retries are dead on arrival`,
      ).toBeGreaterThanOrEqual(retry * retryDelay);
      // Bounded ABOVE as well: the whole POST, retries included, has to finish
      // inside a cancellation's 5-minute grace window — the tightest budget any
      // of these steps runs under — and one attempt cannot outlive them all.
      expect(
        retryMaxTime,
        `${st.name}: \`--retry-max-time ${retryMaxTime}\`s can outlive a cancellation's ` +
          "5-minute grace window, so the alert is killed before it posts",
      ).toBeLessThanOrEqual(240);
      expect(
        maxTime,
        `${st.name}: one attempt (\`--max-time ${maxTime}\`) may outlast the entire retry ` +
          `budget (\`--retry-max-time ${retryMaxTime}\`), so the bound that loses is unclear`,
      ).toBeLessThanOrEqual(retryMaxTime);

      // (d) DELIVERY IS PROVEN POSITIVELY, AND the proof does not rest on a shell
      // option nothing checks. OBSERVED by running the body, because asserting
      // that `echo "posted=true"` merely sits AFTER the `curl` in the text did not
      // cover the real hazard: with the echo on its own following line, the only
      // thing keeping it unreached on a failed POST was `set -e` aborting the
      // step — and the shell-options guard is scoped to the sync step, so dropping
      // `-e` from an alert was invisible here. That published `posted=true` with
      // nothing delivered, byte-identical to a real alert, standing the catch-all
      // down: the total-silence window this mechanism exists to close.
      //
      // Asked of EVERY STATE THE BODY DISTINGUISHES (`envStatesFrom`), not of one
      // fixture. With a webhook present these bodies have no other path that
      // declines to post, so "a POST happened and `posted` proves it" has to hold
      // across the whole reachable domain — otherwise an early `posted=true;
      // exit 1` gated on a real `SYNC_REASON` value publishes the stand-down
      // signal having reached Slack with nothing, and the day is a RED job with
      // ZERO messages: the total-silence window, re-opened one `if` at a time.
      for (const { label, env } of envStatesFrom(st)) {
        const posted = observeAlertPost(st, { curlExit: 0, env });
        expect(
          posted.posts.length,
          `${st.name}: with ${label} the body reaches Slack ${posted.posts.length} times ` +
            "instead of once — a state the runner can produce short-circuits the POST, and " +
            `it published posted=${JSON.stringify(posted.outputs.posted ?? "")}`,
        ).toBe(1);
        expect(
          posted.outputs.posted,
          `${st.name}: with ${label} a DELIVERED alert publishes no positive proof, so ` +
            "anything downstream can only key on a step OUTCOME — which a failed POST also " +
            "produces",
        ).toBe("true");
      }
      for (const errexit of [true, false]) {
        const dropped = observeAlertPost(st, { curlExit: 22, errexit });
        const how = errexit ? "ON" : "OFF";
        expect(
          dropped.outputs.posted,
          `${st.name}: a REJECTED POST still reads as delivered with errexit ${how} — the ` +
            "catch-all stands down and a dead webhook means total silence on every red day",
        ).toBeUndefined();
        // And the step still has to FAIL, or the day is green with nobody told.
        expect(
          dropped.stepExit,
          `${st.name}: a REJECTED POST leaves the step GREEN with errexit ${how}`,
        ).not.toBe(0);
      }
    }
  });

  it("MODEL: the swept alert states include the values the BODIES branch on", () => {
    // Without this the sweep above can go vacuous silently — a regex that stops
    // matching yields one state, the guard still passes, and the impossible-
    // fixture window is back with every assertion green.
    const gate = envStatesFrom(stepById("alert_gate")).map((s) => s.label);
    for (const want of [
      'SYNC_REASON="sync-crashed"',
      'SYNC_REASON="provider-unchecked"',
      'SYNC_REASON="gate-failed"',
      'NEEDS_HUMAN_PR_OUTCOME="failure"',
      'NEEDS_HUMAN_PR_OUTCOME="skipped"',
      'ASSERT_OUTCOME="failure"',
      'PR_OUTCOME="failure"',
    ]) {
      expect(
        gate,
        `the alert-state sweep does not read ${want} out of the gate alert's own body, so ` +
          "that branch is never executed and an early stand-down hiding behind it is invisible",
      ).toContain(want);
    }
    // …and it reaches the empty-string states a `-z`/`-n` test distinguishes,
    // without ever emptying the webhook (whose own guard owns that state).
    expect(envStatesFrom(stepById("alert_catchall")).map((s) => s.label)).toContain(
      'SYNC_REASON=""',
    );
    for (const st of slackSteps()) {
      expect(
        envStatesFrom(st).map((s) => s.label),
        `${st.name}: the sweep empties SLACK_WEBHOOK, which is the one state these bodies ` +
          "are entitled not to POST in",
      ).not.toContain('SLACK_WEBHOOK=""');
    }
  });

  it("both PR-open paths REFUSE to run dedup-blind on an empty changeset key", () => {
    for (const st of [stepById("pr"), stepById("needs_human_pr")]) {
      const code = codeOf(st);
      const NEEDLE = 'if [ -z "${CHANGESET_KEY:-}" ]; then';
      const at = code.indexOf(NEEDLE);
      expect(
        at,
        `${st.name}: an EMPTY changeset key silently switches the PRIMARY dedup guard ` +
          "off (`if [ -n … ]`) and falls through to an unconditional push + PR",
      ).toBeGreaterThanOrEqual(0);
      // Sliced on the `if`'s OWN indent. The previous bound came from
      // `code.indexOf("\n          fi", at)` — a `fi` at 20 spaces of file indent,
      // which exists NOWHERE in this workflow — so `indexOf` returned -1,
      // `slice(at, -1)` spanned the whole rest of the step, and the assertion was
      // satisfied by 7 (ok-applied) / 14 (needs-human) unrelated `exit 1`s. The
      // refusal could be replaced by `echo "continuing dedup-blind"` and this
      // guard stayed green.
      const guard = ifBlock(code, NEEDLE, st.name!);
      expect(
        guard.split("\n").length,
        `${st.name}: the refusal slice spans more than the refusal, so an \`exit 1\` ` +
          "elsewhere in the step can satisfy the assertion below",
      ).toBeLessThanOrEqual(5);
      expect(
        guard,
        `${st.name}: the empty-changeset-key branch does not fail the step, so the run ` +
          "still pushes with no dedup",
      ).toMatch(/^\s*exit 1$/m);
      expect(
        guard,
        `${st.name}: the empty-changeset-key branch returns SUCCESSFULLY, so the run is ` +
          "green and silent on a sync that misbehaved",
      ).not.toMatch(/^\s*exit 0$/m);
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

  it("MODEL: every locator and slicer THROWS on a miss instead of widening to the whole step", () => {
    // The known-negative for every slicer above. A bound derived from an
    // unchecked `indexOf` is the defect that made three guards vacuous at once,
    // so the slicers must be unable to return a silently-widened slice.
    const code = codeOf(stepById("pr"));
    expect(() => locate(code, "no such needle anywhere", "model")).toThrow(/cannot locate/);
    expect(locate(code, "exit 1", "model"), "locate does not find a needle that IS there").toBe(
      code.indexOf("exit 1"),
    );
    expect(() => ifBlock(code, 'if [ -z "${NOT_A_REAL_GUARD:-}" ]; then', "pr")).toThrow(
      /no .* to slice/,
    );
    // An `if` line whose block is not closed at its own indent: an over-indented
    // `fi` must not be accepted as the closer.
    expect(() =>
      ifBlock('  if [ -z "$X" ]; then\n    echo hi\n    fi\n', 'if [ -z "$X" ]', "t"),
    ).toThrow(/no closing `fi` at its own\s+indent/);
    expect(() => whileLoop(code, "while never_written; do", "pr")).toThrow(/no .* to slice/);
    expect(() => braceGroup(code, '"$NO_SUCH_FILE"', "pr")).toThrow(/no .* command group/);
  });

  it("MODEL: the persist harness's `mapfile` prologue fills the array the builtin would", () => {
    // The persist observations run the real body, and on a shell without the
    // bash-4 builtin that body's note list comes from this prologue. A prologue
    // that mis-fills the array reports another program's answers — and it would
    // do so QUIETLY, since an empty note list is a legal state.
    const probe = join(mkdtempSync(join(tmpdir(), "fix-drift-mapfile-")), "probe.sh");
    writeFileSync(
      probe,
      [
        MAPFILE_SHIM,
        "mapfile -t GOT < <(printf '%s\\n' 'a b' 'c')",
        'printf \'%s|\' "${#GOT[@]}" "${GOT[0]}" "${GOT[1]}"',
      ].join("\n"),
    );
    const res = spawnSync("/bin/bash", [probe], { encoding: "utf-8" });
    expect(res.stderr, "the mapfile prologue does not run under this shell").toBe("");
    expect(
      res.stdout,
      "the prologue does not reproduce `mapfile -t`: the persist body's committed-note list " +
        "would be wrong, and an empty one is a legal state so nothing would notice",
    ).toBe("2|a b|c|");
  });
});

// ---------------------------------------------------------------------------
// EVERY OUTCOME REACHES A HUMAN EXACTLY ONCE.
//
// The reachability question the text-shape guards above cannot answer: walk the
// step list in order under a named scenario and read off which alerts the runner
// would actually SELECT (and, for a cancellation, which of them were cut short
// before their `curl` could deliver anything).
//
// The two MODEL guards come first: an alert step whose only exit path is
// `exit 1` must be modelled as FAILING. A simulation that models it as
// succeeding answers questions about a workflow that does not exist, and is
// exactly what makes an `outcome == 'skipped'` clause look load-bearing.
// ---------------------------------------------------------------------------
describe("fix-drift.yml — every outcome reaches a human EXACTLY once", () => {
  const CATCH_ALL = "Alert on early-infra failure (catch-all)";
  const GATE_ALERT = "Alert on drift-sync-check gate failure";
  const NEEDS_HUMAN_ALERT = "Alert on needs-human decision";
  const REJECTED_ALERT = "Notify Slack on a SUPPRESSED (human-rejected) changeset";
  const OK = { url: "https://example.test/pr/1", number: "1" };

  it("MODEL: an alert step whose only exit path is `exit 1` is modelled as FAILING, so an alerting run is modelled RED", () => {
    const sim = simulateJob({
      outputs: { sync: { reason: SyncCoreReason.GATE_FAILED, exit_code: "1" } },
    });
    expect(sim.alerts, "the gate alert did not fire on a gate-failed run").toEqual([GATE_ALERT]);
    expect(
      sim.jobFailed,
      "the gate alert fired and ends in `exit 1`, yet the run is modelled GREEN — " +
        "every claim this table makes about alert-step outcomes is then fiction",
    ).toBe(true);
  });

  // -------------------------------------------------------------------------
  // `continue-on-error` IS THE ONE KEY THAT DECOUPLES A STEP'S OUTCOME FROM THE
  // JOB'S STATUS, and it appeared nowhere in this workflow OR this suite. With
  // it, a step exits non-zero (so `outcome == 'failure'`) while the job concludes
  // SUCCESS and `failure()` is false — which defeats, from one added line: "a
  // drift-sync CRASH cannot end green and silent" (on `sync`), "a Push/PR-create
  // failure after a passing assert still alerts" (on `pr`), and "both alerts fail
  // the job so a human sees it in CI status" (on `alert_gate`).
  //
  // The MODEL guard proves the simulation can SEE the key, so the ban below is
  // load-bearing rather than decoration.
  // -------------------------------------------------------------------------
  it("MODEL: `continue-on-error` is parsed and modelled — with it, a failing step stops failing the JOB", () => {
    const ANCHOR = "      - name: Run deterministic drift sync\n        id: sync\n";
    const mutated = wf.replace(ANCHOR, `${ANCHOR}        continue-on-error: true\n`);
    expect(mutated, "the injection anchor moved — this guard is testing nothing").not.toBe(wf);
    expect(
      stepById("sync", mutated).continueOnError,
      "the step slicer does not read `continue-on-error` at all, so no guard here can see it",
    ).toBe("true");
    const scenario: Scenario = {
      failing: ["sync"],
      outputs: { sync: { reason: SyncCoreReason.OK_NO_CHURN, exit_code: "1" } },
    };
    expect(
      simulateJob(scenario, wf).alerts,
      "KNOWN-POSITIVE: a failing sync step must reach the catch-all as the workflow stands",
    ).toEqual([CATCH_ALL]);
    expect(
      simulateJob(scenario, mutated).alerts,
      "the simulation cannot see `continue-on-error`: with it the job concludes SUCCESS, " +
        "`failure()` is false and every alert goes silent — so the ban below is the only " +
        "thing standing between one added YAML line and a green, silent crash",
    ).toEqual([]);
  });

  it("neither a step NOR the job decouples its outcome from the status above it", () => {
    expect(
      steps()
        .filter((s) => s.continueOnError !== undefined)
        .map((s) => `${s.id ?? s.name} (continue-on-error: ${s.continueOnError})`),
      "a step sets `continue-on-error`, which leaves its outcome 'failure' while the job " +
        "concludes SUCCESS — every `failure()`-gated alert in this job then stays silent",
    ).toEqual([]);
    // …and the same key one level up, which the step-scoped check above cannot
    // see. On the JOB it decouples the job from the RUN: the alerts still fire
    // (they key on `failure()` INSIDE the job), but the Actions UI and the
    // workflow-failure notification both go green, so the red cron job — the one
    // signal left when a webhook has been rotated — disappears too. Read as the
    // job mapping's own KEYS, so no indentation or quoting spelling slips past.
    const jobKeys = [
      ...wf
        .slice(locate(wf, "  sync:", "the sync job"), locate(wf, "    steps:", "the sync job"))
        .matchAll(/^ {4}([A-Za-z][A-Za-z0-9-]*):/gm),
    ].map((m) => m[1]);
    expect(
      jobKeys,
      "the sync job's key list came out empty — this guard is reading nothing",
    ).toContain("runs-on");
    expect(
      jobKeys,
      "the JOB sets `continue-on-error`, so a failed job stops failing the workflow RUN: the " +
        "Actions UI goes green and the workflow-failure notification never fires",
    ).not.toContain("continue-on-error");
  });

  it("MODEL: the notification that does NOT end in `exit 1` is still modelled as SUCCEEDING", () => {
    // Known-negative for the rule above: it must key on the step's own exit
    // path, not on "is this an alert step".
    const sim = simulateJob({
      outputs: { sync: { reason: SyncCoreReason.OK_APPLIED, exit_code: "0" }, pr: OK },
    });
    expect(sim.alerts).toEqual(["Notify Slack on sync success"]);
    expect(sim.jobFailed, "a successful run was modelled RED by the success notification").toBe(
      false,
    );
  });

  const SCENARIOS: Array<{ label: string; scenario: Scenario; expect: string[] }> = [
    {
      label: "infra/setup failure before the sync step ever runs",
      scenario: { failing: ["Clone ag-ui repo"] },
      expect: [CATCH_ALL],
    },
    {
      label: "drift-sync's own internal gate reverted the edit (gate-failed)",
      scenario: { outputs: { sync: { reason: SyncCoreReason.GATE_FAILED, exit_code: "1" } } },
      expect: [GATE_ALERT],
    },
    {
      label: "ok-applied, then the defense-in-depth assert REFUSES",
      scenario: {
        failing: ["assert"],
        outputs: { sync: { reason: SyncCoreReason.OK_APPLIED, exit_code: "0" } },
      },
      expect: [GATE_ALERT],
    },
    {
      // F#1: the window that used to be silent — assert SUCCEEDED, a later step
      // failed, reason is non-empty so the catch-all stands down.
      label: "ok-applied, assert PASSES, then Push/PR-create fails (F#1)",
      scenario: {
        failing: ["pr"],
        outputs: { sync: { reason: SyncCoreReason.OK_APPLIED, exit_code: "0" } },
      },
      expect: [GATE_ALERT],
    },
    {
      label: "needs-human, note persisted fine",
      scenario: {
        outputs: {
          sync: { reason: SyncCoreReason.NEEDS_HUMAN, exit_code: "1" },
          needs_human_pr: OK,
        },
      },
      expect: [NEEDS_HUMAN_ALERT],
    },
    {
      // G#2: a persist failure is a TOOLING fault, so the gate alert owns it and
      // the needs-human alert must stand down — otherwise both fire at once.
      label: "needs-human, but the persist step itself FAILS",
      scenario: {
        failing: ["needs_human_pr"],
        outputs: { sync: { reason: SyncCoreReason.NEEDS_HUMAN, exit_code: "1" } },
      },
      expect: [GATE_ALERT],
    },
    {
      // The window a `reason == ''` catch-all leaves open. Nothing drifted, so
      // no reason-keyed alert exists — but the job can still fail (an artifact
      // upload, a runner hiccup) with a NON-empty reason.
      label: "ok-no-churn, then a later step fails (non-empty reason, no reason-keyed alert)",
      scenario: {
        failing: ["Upload drift-sync-check log"],
        outputs: { sync: { reason: SyncCoreReason.OK_NO_CHURN, exit_code: "0" } },
      },
      expect: [CATCH_ALL],
    },
    {
      // The suppression window, which no scenario reached before: a human closed
      // the proposal, so the RE-PROPOSAL is suppressed and the day must still be
      // reported — on the first run after the closure, and on a GREEN job.
      label: "needs-human, but a human REJECTED the changeset (closure not reported yet)",
      scenario: {
        outputs: {
          sync: { reason: SyncCoreReason.NEEDS_HUMAN, exit_code: "1" },
          needs_human_pr: { ...OK, rejected: "350", rejected_url: "https://example.test/pr/350" },
        },
      },
      expect: [REJECTED_ALERT],
    },
    {
      // …and on every later run: still suppressed, already reported, so silent.
      // Told once beats told every morning; the state is permanent by design.
      label: "the same rejection once it has been reported (the ack is on the closed PR)",
      scenario: {
        outputs: {
          sync: { reason: SyncCoreReason.NEEDS_HUMAN, exit_code: "1" },
          needs_human_pr: {
            ...OK,
            rejected: "350",
            rejected_url: "https://example.test/pr/350",
            rejected_ack: "true",
          },
        },
      },
      expect: [],
    },
    {
      // The same window on the ok-applied path. It emits no `url`, so the success
      // notification correctly stands down and does not claim a PR was opened.
      label: "ok-applied, but a human REJECTED the changeset",
      scenario: {
        outputs: {
          sync: { reason: SyncCoreReason.OK_APPLIED, exit_code: "0" },
          pr: { rejected: "350", rejected_url: "https://example.test/pr/350" },
        },
      },
      expect: [REJECTED_ALERT],
    },
    {
      label: "ok-applied all the way through — the success notification, not an alert",
      scenario: {
        outputs: { sync: { reason: SyncCoreReason.OK_APPLIED, exit_code: "0" }, pr: OK },
      },
      expect: ["Notify Slack on sync success"],
    },
  ];

  for (const { label, scenario, expect: wanted } of SCENARIOS) {
    it(`${label} -> exactly: ${wanted.join(", ")}`, () => {
      expect(simulateJob(scenario).alerts).toEqual(wanted);
    });
  }

  it("no churn at all is silent (nothing happened; nothing to report)", () => {
    const sim = simulateJob({
      outputs: { sync: { reason: SyncCoreReason.OK_NO_CHURN, exit_code: "0" } },
    });
    expect(sim.jobFailed).toBe(false);
    expect(sim.alerts).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // A CANCELLED job — a manual cancel, or this job's own `timeout-minutes: 30`
  // firing — is a THIRD job outcome, not a flavour of failure. GitHub's
  // `failure()` is FALSE for it, so the catch-all (the only alert covering a
  // window no reason-keyed alert owns) stood down and the job ended with ZERO
  // Slack on an unattended daily cron. Same defect family as the crash window:
  // `failure()` is not the same predicate as "did not succeed".
  // -------------------------------------------------------------------------
  const CANCEL_SCENARIOS: Array<{ label: string; scenario: Scenario }> = [
    {
      label: "the 30-minute job timeout fires while drift-sync is still running",
      scenario: { cancelledAt: "sync" },
    },
    {
      label: "a human cancels the run during infra/setup, before drift-sync starts",
      scenario: { cancelledAt: "Provision Ollama daemon (drift-sync-check re-collect gate)" },
    },
    {
      label: "the timeout fires during the ok-applied Push/PR step, after a reason was published",
      scenario: {
        cancelledAt: "pr",
        outputs: { sync: { reason: SyncCoreReason.OK_APPLIED, exit_code: "0" } },
      },
    },
    {
      label: "the timeout fires during the needs-human persist step",
      scenario: {
        cancelledAt: "needs_human_pr",
        outputs: { sync: { reason: SyncCoreReason.NEEDS_HUMAN, exit_code: "1" } },
      },
    },
  ];

  for (const { label, scenario } of CANCEL_SCENARIOS) {
    it(`CANCELLED: ${label} -> exactly one alert fires (never silence)`, () => {
      const res = simulateJob(scenario);
      expect(res.jobCancelled, "the scenario did not actually cancel the job").toBe(true);
      // A cancellation is not a flavour of failure — stated where it is actually
      // load-bearing: the CUT-SHORT STEP reports 'cancelled', never 'failure'.
      expect(res.outcomes[scenario.cancelledAt!] ?? "cancelled").toBe("cancelled");
      expect(
        res.alerts.length,
        "a cancelled/timed-out job ended with ZERO Slack — nobody is told anything",
      ).toBeGreaterThan(0);
      // Still exactly one: widening the catch-all must not double-fire.
      expect(res.alerts.length, `more than one alert fired: ${res.alerts.join(", ")}`).toBe(1);
    });
  }

  it("the catch-all's predicate covers cancellation as well as failure (failure() alone is silent through a timeout)", () => {
    const gate = stepByName(CATCH_ALL).if ?? "";
    expect(
      gate,
      "the catch-all does not name cancelled(), so `failure()` is false through a " +
        "timeout AND the runner skips the step outright once the job is cancelling",
    ).toMatch(/cancelled\(\)/);
  });

  it("the job HAS the timeout that produces the cancelled outcome this covers", () => {
    // A human can cancel regardless, but this pins the documented 30-minute
    // trigger the catch-all's wording names.
    expect(wf).toMatch(/^ {4}timeout-minutes: 30$/m);
  });

  it("the catch-all NAMES the cancellation instead of blaming a step that never failed", () => {
    const step = stepByName(CATCH_ALL);
    // `cancelled()` is not available in `env:`, so the wording branch has to read
    // the job's own status — and it can only do that if the step imports it.
    expect(
      step.env.JOB_STATUS,
      "the catch-all cannot see that the job was cancelled, so its message can only " +
        "say the job FAILED — sending a human hunting for a broken step that does " +
        "not exist",
    ).toBe("${{ job.status }}");
    const cancelled = assembleSlackMessage(step, { JOB_STATUS: "cancelled", SYNC_REASON: "" });
    const failed = assembleSlackMessage(step, { JOB_STATUS: "failure", SYNC_REASON: "" });
    expect(
      cancelled,
      "a cancelled/timed-out job gets the same message as a failed one — it did not " +
        '"fail" anywhere, and saying so misdirects the human reading it',
    ).not.toEqual(failed);
    expect(cancelled).toMatch(/CANCELLED|TIMED OUT/);
    expect(cancelled).toMatch(/timeout-minutes/);
    expect(cancelled, "the cancelled message still claims the job failed").not.toMatch(
      /\bfailed\b/,
    );
    // …and the failure wording must not regress into cancellation wording.
    expect(failed).toMatch(/\bfailed\b/);
  });

  // -------------------------------------------------------------------------
  // DELIVERY IS PROVEN POSITIVELY, NEVER INFERRED FROM AN EXIT CODE.
  //
  // The catch-all used to stand down on `steps.alert_*.outcome != 'failure'`,
  // on the stated premise that an alert step's only exit path is its deliberate
  // `exit 1`, so 'failure' means "ran to completion and posted". Under
  // `set -euo pipefail` that is false: a `curl -fsS` dying against a rotated
  // webhook (404), a 5xx or a TLS timeout ALSO exits the step non-zero, with
  // nothing delivered — so the likeliest way for alerting to break was also the
  // thing that disabled the backstop covering it.
  //
  // The only honest discriminator is a positive one written AFTER the curl
  // returns 0. Both enumerations below are over the real `if:` text: the
  // catch-all must stand down for exactly one value of `posted`, and for NO
  // value of `outcome`.
  // -------------------------------------------------------------------------
  // The alerts the model believes the catch-all stands down for. Pinned against
  // the workflow's own `if:` below, because both enumerations feed every step id
  // the SAME `posted`: a FOURTH clause naming a step this list omits reads as
  // unset, `'' != 'true'` holds, and every enumeration here stays green while the
  // backstop has acquired a new way to be silenced.
  const STAND_DOWN_IDS = ["alert_cancelled", "alert_needs_human", "alert_gate"];

  /** The step ids whose `posted` output the catch-all's `if:` actually reads. */
  const standDownIds = (): string[] => [
    ...new Set(
      [...stepByName(CATCH_ALL).if!.matchAll(/steps\.([A-Za-z0-9_-]+)\.outputs\.posted/g)].map(
        (m) => m[1],
      ),
    ),
  ];

  const catchAllSelected = (alert: { outcome?: StepOutcome; posted?: string }): boolean =>
    evaluateIf(stepByName(CATCH_ALL).if!, {
      event_name: "schedule",
      jobFailed: false,
      jobCancelled: true,
      steps: {
        sync: { outcome: "cancelled", outputs: {} },
        ...Object.fromEntries(
          STAND_DOWN_IDS.map((id) => [
            id,
            {
              outcome: alert.outcome ?? "success",
              outputs: alert.posted === undefined ? {} : { posted: alert.posted },
            },
          ]),
        ),
      },
    });

  it("the catch-all's stand-down set is EXACTLY the alerts enumerated here", () => {
    expect(
      standDownIds().sort(),
      "the catch-all reads a `posted` output this file does not enumerate, so the " +
        "enumerations below feed that step nothing and cannot see what it silences. " +
        "`alert_rejected` is the live hazard: it delivers on GREEN days, so a clause " +
        "naming it would stand the backstop down on any day a changeset was suppressed — " +
        "including one where an unrelated tooling fault is the only thing left unreported.",
    ).toEqual([...STAND_DOWN_IDS].sort());
    // Every id named must be a real step, or the clause is dead text.
    for (const id of standDownIds())
      expect(
        () => stepById(id),
        `the catch-all reads steps.${id}, which does not exist`,
      ).not.toThrow();
  });

  it("the catch-all stands down ONLY on POSITIVE proof of delivery — over the whole `posted` domain", () => {
    const answers = (["true", "false", "", "1", "TRUE"] as const).map((posted) => ({
      posted,
      selected: catchAllSelected({ posted }),
    }));
    expect(
      answers.filter((a) => !a.selected).map((a) => a.posted),
      "the catch-all stands down on a `posted` value that is not the one an alert " +
        "writes ONLY after its curl returned 0 — so it can be silenced by an alert " +
        "that ran and delivered nothing",
    ).toEqual(["true"]);
  });

  it("NO alert step OUTCOME can silence the catch-all — an exit code is not evidence of delivery", () => {
    // The whole step-outcome domain, with `posted` unset: 'failure' in particular
    // must NOT stand the catch-all down, because a dead webhook produces it.
    const answers = (["skipped", "cancelled", "", "success", "failure"] as const).map(
      (outcome) => ({ outcome, selected: catchAllSelected({ outcome }) }),
    );
    expect(
      answers.filter((a) => !a.selected).map((a) => a.outcome),
      "the catch-all is keyed on a step OUTCOME again — an alert whose POST was " +
        "rejected reports 'failure' having delivered nothing, and would silence the " +
        "very backstop that covers a rotated webhook",
    ).toEqual([]);
  });

  it("a dead webhook does NOT silence the backstop (the alert ran, delivered nothing, catch-all still fires)", () => {
    // The Z1 window, simulated rather than asserted: the gate alert is selected
    // and its curl fails. It delivered nothing, so the run must not end silent.
    const res = simulateJob({
      failing: ["alert_gate"],
      outputs: { sync: { reason: SyncCoreReason.GATE_FAILED, exit_code: "1" } },
    });
    expect(
      res.selected.map((s) => s.name),
      "the gate alert was never even selected, so this scenario proves nothing",
    ).toContain(GATE_ALERT);
    expect(
      res.alerts,
      "the gate alert's POST failed — nothing reached Slack — yet the catch-all stood " +
        "down anyway, so a rotated or revoked webhook means total silence on every red day",
    ).toEqual([CATCH_ALL]);
  });

  const CANCELLED_ALERT_SCENARIOS: Array<{ label: string; scenario: Scenario }> = [
    {
      label: "the 30-minute timeout fires while the needs-human alert is POSTing to Slack",
      scenario: {
        cancelledAt: "alert_needs_human",
        outputs: {
          sync: { reason: SyncCoreReason.NEEDS_HUMAN, exit_code: "1" },
          needs_human_pr: OK,
        },
      },
    },
    {
      label: "the timeout fires while the gate-failure alert is POSTing to Slack",
      scenario: {
        cancelledAt: "alert_gate",
        outputs: { sync: { reason: SyncCoreReason.GATE_FAILED, exit_code: "1" } },
      },
    },
  ];

  for (const { label, scenario } of CANCELLED_ALERT_SCENARIOS) {
    it(`CANCELLED MID-ALERT: ${label} -> the catch-all covers it, exactly once`, () => {
      const res = simulateJob(scenario);
      expect(res.jobCancelled, "the scenario did not actually cancel the job").toBe(true);
      // The cut-short alert step delivered NOTHING, so it is not an alert.
      expect(
        res.alerts,
        "a job cancelled mid-alert ended with ZERO delivered Slack — the alert step's " +
          "curl was killed and the catch-all stood down because 'cancelled' is not 'skipped'",
      ).toEqual([CATCH_ALL]);
      // …and still EXACTLY one: the widening must not double-fire.
      expect(res.alerts.length, `more than one alert fired: ${res.alerts.join(", ")}`).toBe(1);
    });
  }

  // -------------------------------------------------------------------------
  // The needs-human PRODUCT-DECISION alert says a human decision is waiting in
  // a PR. That claim is only true if the persist step SUCCEEDED. It was keyed on
  // `outcome != 'failure'`, which also admits 'skipped' — and the persist step is
  // gated on `success()`, so ANY earlier failure skips it. In that window the
  // note was never pushed, yet the alert fired anyway and told a human to go
  // review a decision that does not exist in the repo.
  //
  // Its counterpart, the gate-failure alert, was keyed on `== 'failure'`, so it
  // stood down in the same window. The two predicates left the skipped window
  // owned by NEITHER the right alert: the wrong one fired, and the tooling fault
  // that actually happened was never named.
  //
  // Enumerated over the persist step's whole outcome domain, with the outcome
  // each scenario actually produced read back from the simulation — so a
  // scenario that stops producing the outcome it is named for cannot quietly
  // pass.
  // -------------------------------------------------------------------------
  const PERSIST_WINDOWS: Array<{
    outcome: StepOutcome;
    label: string;
    scenario: Scenario;
    expect: string[];
  }> = [
    {
      outcome: "success",
      label: "the note was pushed and a PR names it — a real product decision",
      scenario: {
        outputs: {
          sync: { reason: SyncCoreReason.NEEDS_HUMAN, exit_code: "1" },
          needs_human_pr: OK,
        },
      },
      expect: [NEEDS_HUMAN_ALERT],
    },
    {
      outcome: "failure",
      label: "the push was rejected / `gh pr create` errored — a tooling fault",
      scenario: {
        failing: ["needs_human_pr"],
        outputs: { sync: { reason: SyncCoreReason.NEEDS_HUMAN, exit_code: "1" } },
      },
      expect: [GATE_ALERT],
    },
    {
      outcome: "skipped",
      label: "an EARLIER step failed, so the success()-gated persist never ran at all",
      scenario: {
        failing: ["Configure git for push"],
        outputs: { sync: { reason: SyncCoreReason.NEEDS_HUMAN, exit_code: "1" } },
      },
      expect: [GATE_ALERT],
    },
  ];

  for (const { outcome, label, scenario, expect: wanted } of PERSIST_WINDOWS) {
    it(`needs-human persist ${outcome}: ${label} -> exactly: ${wanted.join(", ")}`, () => {
      const res = simulateJob(scenario);
      expect(
        res.outcomes.needs_human_pr,
        `the scenario did not actually leave the persist step '${outcome}'`,
      ).toBe(outcome);
      expect(
        res.alerts,
        outcome === "success"
          ? "a persisted note did not produce the product-decision alert"
          : "the persist step did not SUCCEED, so the note is not in the repo — a " +
              "product-decision alert here tells a human to review a decision that " +
              "does not exist, and zero alerts tells them nothing at all",
      ).toEqual(wanted);
    });
  }

  it("the product-decision alert fires ONLY on a provably persisted note, over the whole outcome domain", () => {
    const answers = (["success", "failure", "cancelled", "skipped", ""] as const).map(
      (outcome) => ({
        outcome,
        selected: evaluateIf(stepByName(NEEDS_HUMAN_ALERT).if!, {
          event_name: "schedule",
          jobFailed: true,
          jobCancelled: false,
          steps: {
            sync: { outcome: "success", outputs: { reason: SyncCoreReason.NEEDS_HUMAN } },
            needs_human_pr: { outcome, outputs: {} },
          },
        }),
      }),
    );
    expect(
      answers.filter((a) => a.selected).map((a) => a.outcome),
      "the needs-human alert fires on a persist outcome that does NOT prove the note " +
        "reached the repo",
    ).toEqual(["success"]);
  });

  it("the gate-failure alert owns every persist outcome the product alert does not", () => {
    const answers = (["success", "failure", "cancelled", "skipped", ""] as const).map(
      (outcome) => ({
        outcome,
        selected: evaluateIf(stepByName(GATE_ALERT).if!, {
          event_name: "schedule",
          jobFailed: true,
          jobCancelled: false,
          steps: {
            sync: { outcome: "success", outputs: { reason: SyncCoreReason.NEEDS_HUMAN } },
            needs_human_pr: { outcome, outputs: {} },
          },
        }),
      }),
    );
    expect(
      answers.filter((a) => !a.selected).map((a) => a.outcome),
      "an unpersisted note reaches neither alert — the window is owned by nobody",
    ).toEqual(["success"]);
  });

  it("the gate-failure alert's message NAMES the skipped persist, not just the failed one", () => {
    const gate = stepByName(GATE_ALERT);
    // Both windows come from the SIMULATION, so every outcome in the assembled
    // message is one the runner can actually produce (a hand-written `""` is not:
    // an unselected step reports 'skipped').
    const nh = { reason: SyncCoreReason.NEEDS_HUMAN, exit_code: "1" };
    const failed = assembleSlackMessage(
      gate,
      alertEnvFrom(gate, { failing: ["needs_human_pr"], outputs: { sync: nh } }),
    );
    const skipped = assembleSlackMessage(
      gate,
      alertEnvFrom(gate, { failing: ["Configure git for push"], outputs: { sync: nh } }),
    );
    expect(
      skipped,
      "a SKIPPED persist gets the same wording as a FAILED one, so the message blames " +
        "a push that was never attempted instead of naming the earlier step that failed",
    ).not.toEqual(failed);
    expect(skipped).toMatch(/SKIPPED/);
  });
});
