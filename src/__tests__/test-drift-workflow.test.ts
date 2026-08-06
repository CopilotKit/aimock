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

import { describe, expect, it } from "vitest";

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
