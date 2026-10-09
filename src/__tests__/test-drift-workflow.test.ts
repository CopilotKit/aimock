/**
 * Assertions on the Ollama provisioning step of .github/workflows/test-drift.yml.
 *
 * WHAT THIS GUARDS. The `drift` job provisions a local Ollama daemon so the
 * OLLAMA_HOST-gated live leg runs. That provisioning is the only place in the
 * job that fetches third-party BYTES over the network and executes them. Every
 * other executable in the job is already pinned: each `uses:` by commit SHA, and
 * `pnpm install --frozen-lockfile` by the lockfile's own integrity hashes.
 *
 * WHY IT MATTERS HERE. The step holds no provider key of its own, and that is
 * NOT the property that protects the keys. It runs BEFORE `Preflight — provider
 * key freshness`'s successor steps and before `Run drift tests`, which is handed
 * OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY, OPENROUTER_API_KEY, FAL_KEY,
 * COHERE_API_KEY and ELEVENLABS_API_KEY. Unverified bytes unpacked as root into
 * /usr/local plant a `node`/`npx`/`git` earlier on PATH (or a shell rc) that the
 * later, key-holding steps then execute. Ordering cannot fix that; only refusing
 * to unpack unverified bytes can.
 *
 * WHY THE QUESTION IS ABOUT `tar` AND `sh`, NOT ABOUT `curl`. A step that
 * "fails" AFTER handing a payload to an executor has refused nothing. The
 * harness below stubs both executors this step could reach — `sh` (the old
 * install-script path) and `tar` (the extractor) — and records WHAT each was
 * handed, so a refusal is the demonstrated ABSENCE of a payload at an executor
 * rather than an inference from an exit code.
 *
 * PINNING `ollama.com/install.sh` WOULD NOT BE SUFFICIENT, and this file
 * deliberately does not ask for it. That script streams an unversioned,
 * undigested `ollama-linux-<arch>.tar.zst` through `zstd -d` into `sudo tar -x`;
 * run verbatim out of the script's own reviewed bytes on 2026-08-05, attacker-
 * supplied content reached `sudo tar -xf - -C <dest>` and the script exited 0.
 * It cannot be fixed in place either — the script never holds the file, so it
 * has nothing to verify. So the release artifact is fetched directly from an
 * immutable release tag and digest-checked before anything unpacks it.
 *
 * The repo ships no YAML dependency and this suite adds none; the parser below
 * is scoped to one job's `steps:` sequence, and actionlint covers structural
 * validity separately in CI.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

// The `EXECUTED` guards below run the workflow's own `run:` bodies under bash,
// shelling out many times per observation — orders of magnitude slower than the
// substring guards beside them. On an IDLE 18-core machine the slowest,
// `EXECUTED POSITIVE CONTROL: base exits 0 and 2 stay non-fatal`, measured
// 3039ms of the inherited 5000ms default; re-measured with the suite running
// concurrently it reached 5490ms and timed out. A guard whose RED cannot be
// told apart from a timeout proves nothing, so the budget for this file is
// stated — matching fix-drift-workflow and unreleased-check-workflow, which run
// the same harness and already state theirs.
vi.setConfig({ testTimeout: 30_000 });

const WORKFLOW = resolve(__dirname, "../../.github/workflows/test-drift.yml");
const wf = readFileSync(WORKFLOW, "utf8");

const OLLAMA_STEP = "Provision Ollama daemon (live drift leg)";
const DRIFT_JOB = "drift";
const KEY_STEP = "Run drift tests";

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  run: string;
  env: Record<string, string>;
}

const indentOf = (l: string): number => l.length - l.trimStart().length;

/**
 * The `steps:` sequence of ONE job.
 *
 * Job-scoped on purpose: test-drift.yml has four jobs, and a whole-file scan
 * would silently answer with `agui-schema-drift`'s steps — the first `steps:`
 * key in the file — for every question asked about `drift`. A locator that
 * cannot find its job THROWS rather than yielding an empty or wrong slice.
 */
function stepsOfJob(job: string, src: string = wf): Step[] {
  const lines = src.split("\n");
  const jobIdx = lines.findIndex((l) => l === `  ${job}:`);
  if (jobIdx === -1) throw new Error(`test-drift.yml: no job \`${job}\``);
  let jobEnd = lines.length;
  for (let i = jobIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() && indentOf(lines[i]) <= 2) {
      jobEnd = i;
      break;
    }
  }
  const body = lines.slice(jobIdx, jobEnd);

  const stepsIdx = body.findIndex((l) => /^\s+steps:\s*$/.test(l));
  if (stepsIdx === -1) throw new Error(`test-drift.yml: job \`${job}\` has no \`steps:\``);
  const firstItem = body.findIndex((l, i) => i > stepsIdx && /^\s+- \S/.test(l));
  if (firstItem === -1) throw new Error(`test-drift.yml: job \`${job}\` \`steps:\` is empty`);
  const itemIndent = indentOf(body[firstItem]);
  const keyIndent = itemIndent + 2;

  const starts: number[] = [];
  let end = body.length;
  for (let i = firstItem; i < body.length; i++) {
    const l = body[i];
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
    const item = body.slice(from, to).map((l, i) => (i === 0 ? l.replace(/- /, "  ") : l));

    const step: Step = { env: {}, run: "" };
    for (let i = 0; i < item.length; i++) {
      const l = item[i];
      if (!l.trim() || indentOf(l) !== keyIndent) continue;
      const m = /^\s*([A-Za-z_-]+):\s*(.*)$/.exec(l);
      if (!m) continue;
      const [, key, inline] = m;

      if (key === "run") {
        // An INLINE `run:` is a run body too — dropping it would make a
        // one-liner step invisible to every guard that reads step bodies.
        if (!/^[|>]/.test(inline) && inline !== "") {
          step.run = `${inline}\n`;
          continue;
        }
        const child: string[] = [];
        let blockIndent = -1;
        for (let j = i + 1; j < item.length; j++) {
          if (!item[j].trim()) {
            child.push("");
            continue;
          }
          if (blockIndent === -1) blockIndent = indentOf(item[j]);
          if (indentOf(item[j]) < blockIndent) break;
          child.push(item[j].slice(blockIndent));
        }
        while (child.length && child[child.length - 1] === "") child.pop();
        step.run = `${child.join("\n")}\n`;
        continue;
      }

      if (key === "env") {
        for (let j = i + 1; j < item.length; j++) {
          if (!item[j].trim()) continue;
          if (indentOf(item[j]) <= keyIndent) break;
          const em = /^\s*([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(item[j]);
          if (em) step.env[em[1]] = em[2];
        }
        continue;
      }

      if (key === "name") step.name = inline.replace(/^["']|["']$/g, "");
      if (key === "id") step.id = inline.replace(/^["']|["']$/g, "");
      if (key === "uses") step.uses = inline.trim();
    }
    return step;
  });
}

function stepByName(name: string, job: string = DRIFT_JOB): Step {
  const hits = stepsOfJob(job).filter((s) => s.name === name);
  if (hits.length !== 1)
    throw new Error(`test-drift.yml: ${hits.length} steps named \`${name}\` in job \`${job}\``);
  return hits[0];
}

it("uploads every invocation sidecar with the final drift report", () => {
  const step = stepByName("Upload drift report");
  expect(step.uses).toBe(
    "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2",
  );
  expect(wf).toContain(`      - name: Upload drift report
        if: always()
        uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
        with:
          name: drift-report
          path: |
            drift-report.json
            drift-evidence/*.json
          if-no-files-found: warn
          retention-days: 30`);
});

/**
 * A step's run body with shell COMMENT lines removed.
 *
 * Every "does this step do X" question has to be asked of the code, not the
 * prose: this step's rationale comment names both `install.sh` and `tar`, so a
 * guard that greps the whole body answers about the comment.
 */
const codeOf = (s: Step): string =>
  s.run
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

interface Provisioned {
  stepExit: number;
  executorRan: boolean;
  /** Exactly the bytes the executor was handed. */
  executorSaw: string;
  /** Which executor was reached — `sh` or `tar`. */
  executor: string;
  stdio: string;
}

/**
 * EXECUTE the provisioning step's own `run:` body with `curl` serving `served`.
 *
 * Only the network and the executors are stubbed. The verification itself —
 * `sha256sum`, the comparison, the exit — is the workflow's code, run as
 * written. BOTH executors this step could reach are stubbed and both write the
 * same marker, so the question "did unverified bytes reach something that runs
 * them" is answered the same way whether the step shells a script or unpacks an
 * archive.
 */
const observeProvision = (served: string, expectedSha256?: string): Provisioned => {
  const dir = mkdtempSync(join(tmpdir(), "test-drift-ollama-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const servedFile = join(dir, "served");
    writeFileSync(servedFile, served);
    const sawFile = join(dir, "executor-saw");
    const whichFile = join(dir, "executor-which");

    // `-o <path>` is the only curl form this step uses for a download; the
    // readiness poll (`curl -sf http://127.0.0.1:11434/...`) has no `-o` and
    // must simply fail so the wait loop falls through.
    writeFileSync(
      join(bin, "curl"),
      [
        "#!/bin/sh",
        'out=""',
        'while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift;; esac; shift; done',
        '[ -n "$out" ] || exit 7',
        `cat ${JSON.stringify(servedFile)} > "$out"`,
      ].join("\n"),
      { mode: 0o755 },
    );
    // `sh <script>` — the install-script executor. Records the FILE's bytes.
    writeFileSync(
      join(bin, "sh"),
      [
        "#!/bin/sh",
        `printf sh > ${JSON.stringify(whichFile)}`,
        `cat "$1" > ${JSON.stringify(sawFile)}`,
      ].join("\n"),
      { mode: 0o755 },
    );
    // `tar` — the root-privileged extractor. Records STDIN.
    writeFileSync(
      join(bin, "tar"),
      [
        "#!/bin/sh",
        `printf tar > ${JSON.stringify(whichFile)}`,
        `cat > ${JSON.stringify(sawFile)}`,
      ].join("\n"),
      { mode: 0o755 },
    );
    // `sudo` passes through, or a refusal would be indistinguishable from
    // "sudo is not installed on the machine running this suite".
    writeFileSync(join(bin, "sudo"), '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
    // `zstd` decompresses; the served bytes stand in for the archive verbatim.
    writeFileSync(join(bin, "zstd"), '#!/bin/sh\ncat "${3:--}"\n', { mode: 0o755 });
    for (const noop of ["ollama", "sleep"])
      writeFileSync(join(bin, noop), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const step = stepByName(OLLAMA_STEP);
    const script = join(dir, "step.sh");
    writeFileSync(script, step.run);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(step.env)) env[k] = v;
    if (expectedSha256 !== undefined) env.OLLAMA_TARBALL_SHA256 = expectedSha256;
    const res = spawnSync("/bin/bash", [script], {
      cwd: dir,
      encoding: "utf-8",
      env: { ...process.env, ...env, PATH: `${bin}:${process.env.PATH ?? ""}`, RUNNER_TEMP: dir },
    });
    return {
      stepExit: res.status ?? -1,
      executorRan: existsSync(sawFile),
      executorSaw: existsSync(sawFile) ? readFileSync(sawFile, "utf-8") : "",
      executor: existsSync(whichFile) ? readFileSync(whichFile, "utf-8") : "",
      stdio: `${res.stdout ?? ""}${res.stderr ?? ""}`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe("test-drift.yml — the drift job unpacks no bytes it has not pinned", () => {
  it("the pin is a real sha256 the step actually compares the download against", () => {
    const step = stepByName(OLLAMA_STEP);
    expect(
      step.env.OLLAMA_TARBALL_SHA256 ?? "",
      "the step declares no pinned digest, so there is nothing to verify against",
    ).toMatch(/^[0-9a-f]{64}$/);
    // …and the comparison must be against the DOWNLOAD, not against a constant
    // recomputed from itself.
    expect(codeOf(step)).toMatch(/sha256sum "\$TARBALL"/);
  });

  it("NOTHING in the step is fetched from a mutable, unversioned URL", () => {
    // Pinning a wrapper while it fetches an unpinned payload is the failure
    // mode this replaced, so every URL the step names must carry the version,
    // and the script that carried none must not come back.
    const code = codeOf(stepByName(OLLAMA_STEP));
    const urls = code.match(/https?:\/\/[^\s"')]+/g) ?? [];
    expect(urls.length, "the step fetches nothing at all").toBeGreaterThan(0);
    for (const url of urls) {
      if (url.startsWith("http://127.0.0.1")) continue; // the local readiness poll
      expect(
        url,
        `\`${url}\` is not pinned to a release version, so its bytes can change under the ` +
          "digest that is supposed to describe them",
      ).toContain("${OLLAMA_VERSION}");
    }
    expect(
      code,
      "ollama.com/install.sh is back — it streams an unversioned, undigested tarball into " +
        "`sudo tar -x`, so pinning the script's own bytes leaves a second unpinned payload " +
        "planting root-owned binaries on PATH",
    ).not.toContain("ollama.com/install.sh");
  });

  it("TAMPERED bytes are REFUSED before any executor sees them (EXECUTED)", () => {
    const obs = observeProvision("ATTACKER-SUBSTITUTED ARCHIVE\n");
    expect(
      obs.executorRan,
      `the workflow handed bytes that do NOT match any pin to \`${obs.executor}\` — that is ` +
        "arbitrary third-party code running in the drift job, and the later steps it precedes " +
        "hold OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY, OPENROUTER_API_KEY, FAL_KEY, " +
        "COHERE_API_KEY and ELEVENLABS_API_KEY, all reachable through PATH. " +
        `${obs.executor} was handed: ${JSON.stringify(obs.executorSaw)}`,
    ).toBe(false);
    expect(obs.stepExit, "the step concluded successfully on a tampered download").not.toBe(0);
    expect(obs.stdio).toContain("does not match its pinned sha256");
  });

  it("POSITIVE CONTROL: bytes that DO match the pin are unpacked (the gate is not just 'always refuse')", () => {
    // The digest is computed from the served bytes rather than shipping a 1.4GB
    // copy of the real archive: the property under test is that a MATCH
    // proceeds, and without this the refusal above is satisfied by a step that
    // never unpacks anything at all.
    const good = "the reviewed upstream archive\n";
    const sha = createHash("sha256").update(good).digest("hex");
    const obs = observeProvision(good, sha);
    expect(
      obs.executorRan,
      "a download matching its pin was refused, so provisioning can never run",
    ).toBe(true);
    expect(obs.executor, "the verified bytes went somewhere other than the extractor").toBe("tar");
    expect(
      obs.executorSaw,
      "tar was reached but handed something other than the verified bytes",
    ).toBe(good);
    expect(obs.stepExit, obs.stdio).toBe(0);
  });

  it("provisioning holds no credential itself, and the steps it precedes hold the live keys", () => {
    // Both halves are the blast-radius claim the comment above makes, and each
    // can rot independently. The first is a ratchet: nothing may start handing
    // this step a secret. The second is the reason the pin is load-bearing — if
    // no later step held a key, the comment would be describing a job that no
    // longer exists.
    const order = stepsOfJob(DRIFT_JOB);
    const ollamaIdx = order.findIndex((s) => s.name === OLLAMA_STEP);
    expect(ollamaIdx, `no \`${OLLAMA_STEP}\` step found`).toBeGreaterThan(-1);
    expect(
      Object.values(order[ollamaIdx].env).filter((v) => v.includes("secrets.")),
      "the provisioning step is handed a repository secret of its own",
    ).toEqual([]);

    const keyIdx = order.findIndex((s) => s.name === KEY_STEP);
    expect(keyIdx, `no \`${KEY_STEP}\` step found`).toBeGreaterThan(-1);
    expect(keyIdx, `\`${KEY_STEP}\` no longer follows provisioning`).toBeGreaterThan(ollamaIdx);
    const keys = Object.entries(order[keyIdx].env)
      .filter(([, v]) => v.includes("secrets."))
      .map(([k]) => k)
      .sort();
    expect(keys, "the step this provisioning precedes no longer holds any provider key").toEqual([
      "ANTHROPIC_API_KEY",
      "COHERE_API_KEY",
      "ELEVENLABS_API_KEY",
      "FAL_KEY",
      "GOOGLE_API_KEY",
      "OPENAI_API_KEY",
      "OPENROUTER_API_KEY",
    ]);
  });
});

// ---------------------------------------------------------------------------
// A silent live surface must not read as a broken collector.
//
// The failure this guards (CopilotKit/aimock run 31571018005, PR #370): the
// Gemini Live WS legs observed nothing for 30s, the collector called that
// "unparseable output" and exited 5, and exit 5 hard-fails the base leg — so
// every bot-opened drift PR was blocked behind a manual-triage stop for a
// condition no human could triage in this repo.
//
// The collector side is fixed in scripts/drift-report-collector.ts (exit 6). What
// is asserted HERE is the half that decides whether a PR merges: the workflow's
// own routing of that exit code. Each case EXECUTES the step's real `run:` body
// with the collector stubbed to a chosen exit code, so the answer is the step's
// observed exit status, not a reading of its YAML.
//
// Both directions are pinned. Exit 6 must not fail a leg (the fix), and exit 5
// must STILL fail it (the thing the fix must not trade away) — a routing that
// tolerates everything would turn the loud stop into a silent pass, which is the
// worse defect.
// ---------------------------------------------------------------------------

interface LegRun {
  stepExit: number;
  stdio: string;
  /** Whatever the step appended to GITHUB_OUTPUT. */
  output: string;
}

/**
 * EXECUTE one collector-running step's `run:` body with the collector stubbed.
 *
 * Only `npx` is stubbed: it writes the report the step's own `jq` then reads and
 * exits with `collectorExit`. Every branch, comparison and exit in between is the
 * workflow's code run as written.
 */
const observeCollectorLeg = (
  stepName: string,
  job: string,
  reportPath: string,
  collectorExit: number,
  timeouts: {
    testName: string;
    timeoutMs?: number;
    serverClose?: { code: number; reason: string };
  }[] = [],
): LegRun => {
  const dir = mkdtempSync(join(tmpdir(), "test-drift-leg-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const report = JSON.stringify({
      timestamp: "2026-08-12T06:42:00.000Z",
      entries: [],
      ...(timeouts.length > 0
        ? { timeouts: timeouts.map((t) => ({ ...t, rawLocation: "", message: "" })) }
        : {}),
    });
    writeFileSync(
      join(bin, "npx"),
      [
        "#!/bin/sh",
        `cat > ${JSON.stringify(join(dir, reportPath))} <<'REPORT'`,
        report,
        "REPORT",
        `exit ${collectorExit}`,
      ].join("\n"),
      { mode: 0o755 },
    );
    writeFileSync(
      join(bin, "git"),
      '#!/bin/sh\ncase "$*" in *rev-parse*) echo pinned-agui;; esac\n',
      { mode: 0o755 },
    );
    const step = stepByName(stepName, job);
    const script = join(dir, "step.sh");
    writeFileSync(script, step.run);
    const outFile = join(dir, "gh-output");
    writeFileSync(outFile, "");
    const res = spawnSync("/bin/bash", [script], {
      cwd: dir,
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        GITHUB_WORKSPACE: dir,
        GITHUB_OUTPUT: outFile,
        LIVE_LEGS_RAN: "true",
        AGUI_REPO_PATH: dir,
        AGUI_UPSTREAM_SHA: "pinned-agui",
      },
    });
    return {
      stepExit: res.status ?? -1,
      stdio: `${res.stdout ?? ""}${res.stderr ?? ""}`,
      output: readFileSync(outFile, "utf-8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const HEAD_STEP = "Head drift report — run live on PR ref";
const SCHEDULED_STEP = "Run drift tests";

describe("test-drift.yml — a silent live surface does not block a PR, and is still said out loud", () => {
  it("EXECUTED: collector exit 6 does NOT fail the head leg", () => {
    const run = observeCollectorLeg(HEAD_STEP, "drift-live-pr", "drift-report-head.json", 6, [
      {
        testName: "Gemini Live WS drift > WS text event sequence and shapes match",
        timeoutMs: 30000,
      },
    ]);
    expect(run.stepExit, `head leg failed on exit 6:\n${run.stdio}`).toBe(0);
  });

  it("EXECUTED: exit 6 names the surface that went silent, as a warning", () => {
    const run = observeCollectorLeg(HEAD_STEP, "drift-live-pr", "drift-report-head.json", 6, [
      { testName: "Gemini Live WS drift > WS tool call event sequence matches", timeoutMs: 30000 },
    ]);
    // Non-blocking is only acceptable if it is also not silent: the reader must
    // learn WHICH surface stopped being graded, without opening the artifact.
    expect(run.stdio).toContain("::warning title=live-timeout (head)::");
    expect(run.stdio).toContain("Gemini Live WS drift > WS tool call event sequence matches");
    expect(run.stdio).toContain("30000ms");
  });

  it("EXECUTED NEGATIVE CONTROL: exit 5 STILL fails the head leg with the triage error", () => {
    const run = observeCollectorLeg(HEAD_STEP, "drift-live-pr", "drift-report-head.json", 5);
    expect(run.stepExit).toBe(5);
    expect(run.stdio).toContain("quarantined unparseable output");
  });

  it("EXECUTED NEGATIVE CONTROL: an unrecognized collector exit STILL fails the head leg", () => {
    const run = observeCollectorLeg(HEAD_STEP, "drift-live-pr", "drift-report-head.json", 1);
    expect(run.stepExit).toBe(1);
    expect(run.stdio).toContain("Head collector faulted");
  });

  it("EXECUTED POSITIVE CONTROL: exits 0 and 2 remain non-fatal (the routing is not 'always pass')", () => {
    expect(
      observeCollectorLeg(HEAD_STEP, "drift-live-pr", "drift-report-head.json", 0).stepExit,
    ).toBe(0);
    expect(
      observeCollectorLeg(HEAD_STEP, "drift-live-pr", "drift-report-head.json", 2).stepExit,
    ).toBe(0);
  });

  it("EXECUTED: the daily job survives exit 6, records it, and warns", () => {
    const run = observeCollectorLeg(SCHEDULED_STEP, DRIFT_JOB, "drift-report.json", 6, [
      {
        testName: "Gemini Live WS drift > WS text event sequence and shapes match",
        timeoutMs: 30000,
      },
    ]);
    expect(run.stepExit, `daily drift step failed on exit 6:\n${run.stdio}`).toBe(0);
    expect(run.stdio).toContain("::warning title=live-timeout::");
    // The exit code has to reach `notify` as job-output DATA, or the Slack branch
    // that makes this loud can never fire.
    expect(run.output).toContain("exit_code=6");
  });

  it("EXECUTED NEGATIVE CONTROL: the daily job still fails on exit 5", () => {
    const run = observeCollectorLeg(SCHEDULED_STEP, DRIFT_JOB, "drift-report.json", 5);
    expect(run.stepExit).toBe(5);
    expect(run.stdio).toContain("manual triage required");
  });
});

/**
 * EXECUTE the `Notify Slack` step with `curl` stubbed, and return the Slack text
 * it would have posted (empty string when it posts nothing).
 *
 * This is the only place that answers "does a human find out". A silent surface
 * that neither fails CI nor alerts is the fail-silent outcome this whole change
 * has to avoid, and the exit-6 branch is the thing that prevents it — so it is
 * asserted by observing the payload, not by reading the branch.
 */
const observeNotify = (env: Record<string, string>): { posted: string; stepExit: number } => {
  const dir = mkdtempSync(join(tmpdir(), "test-drift-notify-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const postFile = join(dir, "posted");
    writeFileSync(
      join(bin, "curl"),
      [
        "#!/bin/sh",
        'body=""',
        'while [ $# -gt 0 ]; do case "$1" in -d) body="$2"; shift;; esac; shift; done',
        `printf '%s' "$body" > ${JSON.stringify(postFile)}`,
      ].join("\n"),
      { mode: 0o755 },
    );
    const step = stepByName("Notify Slack", "notify");
    const script = join(dir, "step.sh");
    writeFileSync(script, step.run);
    const res = spawnSync("/bin/bash", [script], {
      cwd: dir,
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        SLACK_WEBHOOK: "https://example.invalid/hook",
        AGUI_RESULT: "success",
        DRIFT_SUMMARY: "",
        DRIFT_RUNS: "",
        REPO: "CopilotKit/aimock",
        RUN_ID: "31571018005",
        ...env,
      },
    });
    return {
      posted: existsSync(postFile) ? readFileSync(postFile, "utf-8") : "",
      stepExit: res.status ?? -1,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe("test-drift.yml — a surface that stopped being graded reaches a human", () => {
  it("EXECUTED: exit 6 on a green drift job still posts to Slack", () => {
    // The job PASSES on exit 6, which is precisely why the alert matters: without
    // its own branch this run is good→good and the step exits without posting.
    const { posted } = observeNotify({
      DRIFT_EXIT_CODE: "6",
      DRIFT_RESULT: "success",
      PREV: "success",
    });
    expect(posted, "a silent live surface produced NO Slack message").not.toBe("");
    expect(posted).toContain("Live drift surface went silent");
    // Never as drift — nobody should go looking for a provider format change.
    expect(posted).not.toContain("HTTP API drift detected");
    expect(posted).not.toContain("quarantined");
  });

  it("EXECUTED NEGATIVE CONTROL: a genuinely quiet day still posts nothing", () => {
    // If this posted, the branch above would be indistinguishable from "always
    // alert", and the exit-6 assertion would prove nothing.
    const { posted } = observeNotify({
      DRIFT_EXIT_CODE: "0",
      DRIFT_RESULT: "success",
      PREV: "success",
    });
    expect(posted).toBe("");
  });

  it("EXECUTED NEGATIVE CONTROL: exit 5 still alerts as a quarantine, not as a timeout", () => {
    const { posted } = observeNotify({
      DRIFT_EXIT_CODE: "5",
      DRIFT_RESULT: "failure",
      PREV: "success",
    });
    expect(posted).toContain("quarantined unparseable output");
    expect(posted).not.toContain("went silent");
  });

  it("EXECUTED NEGATIVE CONTROL: real drift still alerts as real drift", () => {
    const { posted } = observeNotify({
      DRIFT_EXIT_CODE: "2",
      DRIFT_RESULT: "failure",
      PREV: "success",
    });
    expect(posted).toContain("HTTP API drift detected");
    expect(posted).not.toContain("went silent");
  });
});

/**
 * EXECUTE the BASE leg's own `run:` body on its fresh-live-base path.
 *
 * This is the step that actually failed (run 31571018005, step 7), so it gets its
 * own execution rather than inheriting confidence from the head leg. Its reuse
 * lookup, worktree checkout and install are stubbed; the exit-code routing is the
 * workflow's code run as written.
 *
 * The reuse path is deliberately made to MISS, because that is the live
 * situation: reuse requires a same-UTC-day `main` report with non-empty entries,
 * and while main's own scheduled run is failing there is no such report — which is
 * exactly why every PR ends up running a fresh live base and meeting this routing.
 */
const observeBaseLeg = (
  collectorExit: number,
  timeoutTestName?: string,
  serverClose?: { code: number; reason: string },
): LegRun => {
  const parent = mkdtempSync(join(tmpdir(), "test-drift-base-"));
  try {
    const ws = join(parent, "workspace");
    mkdirSync(ws);
    const bin = join(parent, "bin");
    mkdirSync(bin);
    const report = JSON.stringify({
      timestamp: "2026-08-12T06:42:00.000Z",
      entries: [],
      ...(timeoutTestName || serverClose
        ? {
            timeouts: [
              {
                testName: timeoutTestName ?? "Gemini Live WS drift > WS text event sequence",
                rawLocation: "",
                message: "",
                ...(serverClose ? { serverClose } : { timeoutMs: 30000 }),
              },
            ],
          }
        : {}),
    });
    // No same-UTC-day main report exists → empty run id → reuse is skipped.
    writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(bin, "git"), '#!/bin/sh\nmkdir -p "$3"\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(bin, "pnpm"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(
      join(bin, "npx"),
      [
        "#!/bin/sh",
        'case "$*" in *drift-agui-baseline.ts*) echo true; exit 0;; esac',
        `cat > ${JSON.stringify(join(ws, "drift-report-base.json"))} <<'REPORT'`,
        report,
        "REPORT",
        `exit ${collectorExit}`,
      ].join("\n"),
      { mode: 0o755 },
    );
    const step = stepByName(
      "Base drift report — reuse same-UTC-day main run, else run live",
      "drift-live-pr",
    );
    const script = join(parent, "step.sh");
    writeFileSync(script, step.run);
    const outFile = join(parent, "gh-output");
    writeFileSync(outFile, "");
    const res = spawnSync("/bin/bash", [script], {
      cwd: ws,
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        GITHUB_WORKSPACE: ws,
        GITHUB_OUTPUT: outFile,
        LIVE_LEGS_RAN: "true",
        AGUI_REPO_PATH: parent,
        REPO: "CopilotKit/aimock",
        GH_TOKEN: "stub",
      },
    });
    return {
      stepExit: res.status ?? -1,
      stdio: `${res.stdout ?? ""}${res.stderr ?? ""}`,
      output: readFileSync(outFile, "utf-8"),
    };
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
};

describe("test-drift.yml — the base leg that blocked every drift PR", () => {
  it("EXECUTED RED→GREEN: a silent live surface on main no longer fails the base leg", () => {
    // Before the fix this exact condition arrived as exit 5 and the step died on
    // "Base collector quarantined unparseable output — manual triage required".
    const run = observeBaseLeg(6, "Gemini Live WS drift > WS text event sequence and shapes match");
    expect(run.stepExit, `base leg failed on exit 6:\n${run.stdio}`).toBe(0);
    expect(run.stdio).toContain("::warning title=live-timeout (base)::");
    expect(run.stdio).toContain("Gemini Live WS drift > WS text event sequence and shapes match");
    // The leg still reports how the base was obtained, so the delta step is wired.
    expect(run.output).toContain("reused=false");
  });

  it("EXECUTED NEGATIVE CONTROL: genuinely unparseable base output STILL stops the leg", () => {
    const run = observeBaseLeg(5);
    expect(run.stepExit).toBe(5);
    expect(run.stdio).toContain("manual triage required");
  });

  it("EXECUTED NEGATIVE CONTROL: an unrecognized base exit STILL stops the leg", () => {
    const run = observeBaseLeg(1);
    expect(run.stepExit).toBe(1);
    expect(run.stdio).toContain("Base collector faulted");
  });

  it("EXECUTED POSITIVE CONTROL: base exits 0 and 2 stay non-fatal", () => {
    expect(observeBaseLeg(0).stepExit).toBe(0);
    expect(observeBaseLeg(2).stepExit).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// A hang-up and a silence are both exit 6, so the ANNOTATION is the only place a
// reader can tell them apart. `fix/ws-preserve-close-code` makes a server close
// report its code, and a run that says "no messages in nullms" would be worse
// than the silence it replaced — so the rendering is executed, not read.
// ---------------------------------------------------------------------------

describe("test-drift.yml — a hang-up is annotated as a close, not as a timeout", () => {
  it("EXECUTED: a serverClose entry names the close code, and never renders null", () => {
    const run = observeCollectorLeg(HEAD_STEP, "drift-live-pr", "drift-report-head.json", 6, [
      {
        testName: "Gemini Live WS drift > WS text event sequence and shapes match",
        serverClose: { code: 1011, reason: "internal error" },
      },
    ]);
    expect(run.stepExit, `head leg failed on a hang-up:\n${run.stdio}`).toBe(0);
    expect(run.stdio).toContain("session closed by the server (code 1011)");
    // The failure mode of a naive template: `\(.timeoutMs)` on an absent field.
    expect(run.stdio).not.toContain("nullms");
    expect(run.stdio).not.toContain("no messages in null");
  });

  it("EXECUTED: a silence entry still renders its wait budget", () => {
    // The other branch of the same template must not regress.
    const run = observeCollectorLeg(HEAD_STEP, "drift-live-pr", "drift-report-head.json", 6, [
      { testName: "Gemini Live WS drift > WS tool call event sequence matches", timeoutMs: 30000 },
    ]);
    expect(run.stepExit).toBe(0);
    expect(run.stdio).toContain("no messages in 30000ms");
    expect(run.stdio).not.toContain("session closed by the server");
  });

  it("EXECUTED: the daily job renders a hang-up the same way", () => {
    const run = observeCollectorLeg(SCHEDULED_STEP, DRIFT_JOB, "drift-report.json", 6, [
      {
        testName: "Gemini Live WS drift > WS text event sequence and shapes match",
        serverClose: { code: 1012, reason: "restarting" },
      },
    ]);
    expect(run.stepExit).toBe(0);
    expect(run.stdio).toContain("session closed by the server (code 1012)");
    expect(run.stdio).not.toContain("nullms");
    expect(run.output).toContain("exit_code=6");
  });

  it("EXECUTED: the base leg renders a hang-up the same way", () => {
    const run = observeBaseLeg(6, undefined, { code: 1011, reason: "internal error" });
    expect(run.stepExit, `base leg failed on a hang-up:\n${run.stdio}`).toBe(0);
    expect(run.stdio).toContain("session closed by the server (code 1011)");
    expect(run.stdio).not.toContain("nullms");
  });
});
