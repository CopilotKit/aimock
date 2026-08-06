/**
 * Assertions on the Python install sites of `.github/workflows/publish-release.yml`
 * and `.github/workflows/test-pytest.yml`.
 *
 * WHAT THIS GUARDS. `publish-release.yml`'s `publish-pytest` job carries
 * `environment: pypi` and `id-token: write`, and it is the job that publishes
 * `aimock-pytest` to PyPI through OIDC trusted publishing. Anything it executes
 * runs beside that publish identity and can decide what bytes get published
 * under our own name — a downstream-user compromise, not a key rotation.
 *
 * THE TWO HOLES THIS REPLACED, both measured on 2026-08-05 by running the
 * committed step bodies verbatim with the registry serving substituted bytes:
 *
 *  1. `pip install hatch` resolved a NAME at run time. The substituted package
 *     installed (exit 0) and `hatch build` then EXECUTED it (exit 0).
 *  2. Pinning `hatch` would NOT have closed it. `hatch build` builds in an
 *     ISOLATED environment and fetches `build-system.requires` — hatchling —
 *     from PyPI at build time, unpinned. That is the pinned-wrapper /
 *     unpinned-payload shape the Ollama installer had. `test-pytest.yml`'s
 *     `pip install ./packages/aimock-pytest[test]` had the same hole with no
 *     wrapper at all: the substituted `hatchling.build` was imported twice
 *     before pip did anything else.
 *
 * So the backend is hash-pinned in `.github/requirements/hatchling.txt` and both
 * sites build with build isolation DISABLED, which is why the file being a real
 * hash pin and the build not re-fetching are guarded together below — either one
 * alone leaves unpinned bytes executing.
 *
 * WHY THE `--require-hashes` SCOPE IS ASSERTED. `publish-pytest` decides whether
 * to publish with `pip install <pkg>==<ver> --dry-run --no-deps`, where FAILURE
 * means "not published yet, go publish". Hash-gating pip job-wide would make
 * that probe fail for an unrelated reason and turn the gate into an
 * unconditional publish, so the gate steps must stay unhashed and the two
 * publishing steps must stay conditioned on it.
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

const REPO = resolve(__dirname, "../..");
const RELEASE_PATH = join(REPO, ".github/workflows/publish-release.yml");
const PYTEST_PATH = join(REPO, ".github/workflows/test-pytest.yml");
const PINS_REL = ".github/requirements/hatchling.txt";
const PINS_PATH = join(REPO, PINS_REL);

const release = readFileSync(RELEASE_PATH, "utf8");
const pytestWf = readFileSync(PYTEST_PATH, "utf8");

const PUBLISH_JOB = "publish-pytest";
const INSTALL_STEP = "Install build tools";
const GATE_STEP = "Check if pytest version is already published";
const BUILD_STEP = "Build pytest package";
const PUBLISH_STEP = "Publish pytest package to PyPI";

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  if?: string;
  run: string;
}

const indentOf = (l: string): number => l.length - l.trimStart().length;

/**
 * The `steps:` sequence of ONE job.
 *
 * Job-scoped on purpose: publish-release.yml has three jobs, and a whole-file
 * scan would answer every question about `publish-pytest` with `build`'s steps —
 * the first `steps:` key in the file. A locator that cannot find its job THROWS
 * rather than yielding an empty or wrong slice.
 */
function stepsOfJob(job: string, src: string, label: string): Step[] {
  const lines = src.split("\n");
  const jobIdx = lines.findIndex((l) => l === `  ${job}:`);
  if (jobIdx === -1) throw new Error(`${label}: no job \`${job}\``);
  let jobEnd = lines.length;
  for (let i = jobIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() && indentOf(lines[i]) <= 2) {
      jobEnd = i;
      break;
    }
  }
  const body = lines.slice(jobIdx, jobEnd);

  const stepsIdx = body.findIndex((l) => /^\s+steps:\s*$/.test(l));
  if (stepsIdx === -1) throw new Error(`${label}: job \`${job}\` has no \`steps:\``);
  const firstItem = body.findIndex((l, i) => i > stepsIdx && /^\s+- \S/.test(l));
  if (firstItem === -1) throw new Error(`${label}: job \`${job}\` \`steps:\` is empty`);
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

    const step: Step = { run: "" };
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

      if (key === "name") step.name = inline.replace(/^["']|["']$/g, "");
      if (key === "id") step.id = inline.replace(/^["']|["']$/g, "");
      if (key === "uses") step.uses = inline.trim();
      if (key === "if") step.if = inline.trim();
    }
    return step;
  });
}

const releaseSteps = (): Step[] => stepsOfJob(PUBLISH_JOB, release, "publish-release.yml");
const pytestSteps = (): Step[] => stepsOfJob("test", pytestWf, "test-pytest.yml");

function stepByName(name: string, steps: Step[], label: string): Step {
  const hits = steps.filter((s) => s.name === name);
  if (hits.length !== 1) throw new Error(`${label}: ${hits.length} steps named \`${name}\``);
  return hits[0];
}

/**
 * A step's run body with shell COMMENT lines removed.
 *
 * Every "does this step do X" question has to be asked of the code, not the
 * prose: these steps' rationale comments name `hatch`, `hatch build` and
 * `pip install hatch` as the things they replaced, so a guard that greps the
 * whole body answers about the comment.
 */
const stripComments = (src: string): string =>
  src
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

const codeOf = (s: Step): string => stripComments(s.run);

/**
 * The whole workflow with full-line comments removed.
 *
 * Whole-line only, which is all this file needs and all it claims: every
 * question asked of the file below is about a `key: value` line, and the
 * rationale comments beside those keys deliberately NAME the settings they warn
 * against — a guard that greps the raw file answers about the warning.
 */
const releaseCode = stripComments(release);

interface Pin {
  name: string;
  version: string;
  hashes: string[];
  marker?: string;
}

/** Parse the pinned requirements file into one entry per requirement. */
function parsePins(src: string): Pin[] {
  const pins: Pin[] = [];
  for (const raw of src.split("\n")) {
    const line = raw.trim().replace(/\s*\\$/, "");
    if (!line || line.startsWith("#")) continue;
    const req = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(==)?\s*([^\s;]*)\s*(?:;\s*(.*))?$/.exec(line);
    if (req && !line.startsWith("--")) {
      pins.push({
        name: req[1],
        version: req[2] === "==" ? req[3] : "",
        hashes: [],
        marker: req[4],
      });
      continue;
    }
    const h = /^--hash=sha256:([0-9a-fA-F]+)$/.exec(line);
    if (h && pins.length) pins[pins.length - 1].hashes.push(h[1]);
  }
  return pins;
}

/** A python interpreter that has pip, or `null`. */
function findPython(): string | null {
  for (const cand of ["python3", "python"]) {
    const r = spawnSync(cand, ["-m", "pip", "--version"], { encoding: "utf-8" });
    if (r.status === 0) return cand;
  }
  return null;
}

const PYTHON = findPython();

interface PipObservation {
  exit: number;
  /** pip's own tamper refusal, verbatim-matched. */
  refused: boolean;
  stdio: string;
}

/**
 * Run REAL pip against the repo's REAL pin file, with a local directory standing
 * in for the registry.
 *
 * `--no-index -f <dir>` is the whole network: pip can only see the bytes in
 * `dir`. That makes this the pip analogue of stubbing `curl` — the command and
 * the pin file are the repo's own, only what the registry serves is substituted.
 * `pip download` rather than `pip install` because hash checking happens BEFORE
 * a wheel is opened, so the refusal is observable without a real, installable
 * artifact; `refused` matches pip's tamper message rather than the exit code,
 * since a non-zero exit alone cannot tell a hash refusal from any other error.
 */
function observePip(reqFile: string, servedBytes: string, wheelName: string): PipObservation {
  const dir = mkdtempSync(join(tmpdir(), "aimock-pin-"));
  try {
    const links = join(dir, "links");
    mkdirSync(links);
    writeFileSync(join(links, wheelName), servedBytes);
    const res = spawnSync(
      PYTHON as string,
      [
        "-m",
        "pip",
        "download",
        "--no-deps",
        "--no-index",
        "--disable-pip-version-check",
        "-f",
        links,
        "-d",
        join(dir, "out"),
        "--require-hashes",
        "-r",
        reqFile,
      ],
      { encoding: "utf-8", cwd: dir },
    );
    const stdio = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    return {
      exit: res.status ?? -1,
      refused: stdio.includes("DO NOT MATCH THE HASHES FROM THE REQUIREMENTS FILE"),
      stdio,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the PyPI publish path runs no Python bytes it has not pinned", () => {
  it("installs its build backend from a hash-pinned requirements file", () => {
    const step = stepByName(INSTALL_STEP, releaseSteps(), "publish-release.yml");
    const code = codeOf(step);
    expect(code, "the install step no longer passes --require-hashes").toContain(
      "--require-hashes",
    );
    expect(code, `the install step no longer reads ${PINS_REL}`).toContain(`-r ${PINS_REL}`);
    // A bare `pip install <name>` anywhere in this job resolves a name from PyPI
    // at run time, which is exactly what was replaced.
    for (const s of releaseSteps()) {
      const bare = /(?:^|\s)(?:python -m )?pip install\s+(?!-)(?!\.)(\S+)/m.exec(codeOf(s));
      const isGate = s.name === GATE_STEP;
      if (bare && !isGate)
        throw new Error(
          `step \`${s.name}\` runs \`pip install ${bare[1]}\` — an unpinned name resolved from ` +
            "PyPI at run time, in the job that holds `environment: pypi` and `id-token: write`",
        );
    }
  });

  it("the pin file is a real hash pin: every requirement `==`-pinned and sha256-hashed", () => {
    expect(existsSync(PINS_PATH), `${PINS_REL} does not exist`).toBe(true);
    const pins = parsePins(readFileSync(PINS_PATH, "utf8"));
    expect(pins.length, `${PINS_REL} lists no requirements at all`).toBeGreaterThan(0);
    for (const pin of pins) {
      expect(pin.version, `\`${pin.name}\` is not pinned to an exact version with \`==\``).toMatch(
        /^[0-9]/,
      );
      expect(
        pin.hashes.length,
        `\`${pin.name}==${pin.version}\` carries no --hash, so pip would accept any bytes ` +
          "published under that name and version",
      ).toBeGreaterThan(0);
      for (const h of pin.hashes)
        expect(h, `\`${pin.name}\` has a --hash that is not a sha256 digest`).toMatch(
          /^[0-9a-f]{64}$/,
        );
    }
    // The backend itself is the executable that matters; a file that pinned
    // only its dependencies would satisfy every assertion above.
    expect(
      pins.map((p) => p.name),
      "hatchling — the backend that actually executes — is not in the pin file",
    ).toContain("hatchling");
  });

  it("the build re-fetches nothing: no build-isolating builder, backend invoked directly", () => {
    const step = stepByName(BUILD_STEP, releaseSteps(), "publish-release.yml");
    const code = codeOf(step);
    expect(
      code,
      "`hatch build` is back — it resolves `build-system.requires` from PyPI into an isolated " +
        "env at build time, so pinning the wrapper leaves the backend unpinned",
    ).not.toMatch(/(^|\s)hatch\s+build/);
    expect(code, "the build no longer invokes the pinned backend directly").toContain(
      "hatchling build",
    );
  });

  it("hash checking is scoped to the install, so the already-published gate still decides", () => {
    // PIP_REQUIRE_HASHES anywhere job- or workflow-wide would also hit the gate's
    // unhashed `--dry-run` probe. That probe's FAILURE means "not published yet",
    // so breaking it does not fail the job — it publishes unconditionally.
    expect(
      releaseCode,
      "PIP_REQUIRE_HASHES is set somewhere in this workflow; it would make the already-published " +
        "probe fail for an unrelated reason, and that probe fails OPEN into publishing",
    ).not.toContain("PIP_REQUIRE_HASHES");
    const gate = stepByName(GATE_STEP, releaseSteps(), "publish-release.yml");
    expect(codeOf(gate), "the already-published probe is itself hash-gated").not.toContain(
      "--require-hashes",
    );
    expect(gate.id, "the gate step lost its `id`, so nothing can depend on its output").toBe(
      "check",
    );
    expect(codeOf(gate)).toContain('echo "published=');
  });

  it("both publishing steps stay conditioned on that gate", () => {
    const steps = releaseSteps();
    const gateIdx = steps.findIndex((s) => s.name === GATE_STEP);
    expect(gateIdx, `no \`${GATE_STEP}\` step`).toBeGreaterThan(-1);
    for (const name of [BUILD_STEP, PUBLISH_STEP]) {
      const idx = steps.findIndex((s) => s.name === name);
      expect(idx, `no \`${name}\` step`).toBeGreaterThan(-1);
      expect(
        idx,
        `\`${name}\` no longer follows the gate that is supposed to guard it`,
      ).toBeGreaterThan(gateIdx);
      expect(
        steps[idx].if,
        `\`${name}\` is no longer gated on the already-published check — an unchanged version ` +
          "would republish on every push to main",
      ).toBe("steps.check.outputs.published == 'false'");
    }
    // The publish itself is the step that spends the OIDC identity; it must stay
    // the pinned action, not something the job installs.
    const publish = steps[steps.findIndex((s) => s.name === PUBLISH_STEP)];
    expect(publish.uses, "the PyPI publish step is no longer a SHA-pinned action").toMatch(
      /^pypa\/gh-action-pypi-publish@[0-9a-f]{40}\b/,
    );
  });

  it("the Python test matrix installs from the same pin and disables build isolation", () => {
    // Same file on purpose: the backend that builds a release is then the one
    // exercised across the 3.10–3.13 matrix before a release is ever cut.
    const step = stepByName("Install aimock-pytest", pytestSteps(), "test-pytest.yml");
    const code = codeOf(step);
    expect(code, "the test matrix no longer installs the hash-pinned backend").toContain(
      `--require-hashes -r ${PINS_REL}`,
    );
    expect(
      code,
      "build isolation is back on, so pip resolves `build-system.requires` from PyPI and " +
        "executes it here regardless of what was pinned",
    ).toContain("--no-build-isolation");
  });

  describe("EXECUTED against real pip", () => {
    it("finds a python with pip (a skipped guard here is a guard that proves nothing)", () => {
      if (PYTHON === null && process.env.CI)
        throw new Error(
          "no `python3 -m pip` on this runner, so the executed pin guards below cannot run; " +
            "they must not be silently skipped in CI",
        );
      expect(true).toBe(true);
    });

    it.skipIf(PYTHON === null)(
      "SUBSTITUTED backend bytes are REFUSED by the repo's own pin",
      () => {
        const pins = parsePins(readFileSync(PINS_PATH, "utf8"));
        const hatchling = pins.find((p) => p.name === "hatchling");
        expect(hatchling, "no hatchling entry to test").toBeDefined();
        const wheel = `hatchling-${hatchling!.version}-py3-none-any.whl`;
        const obs = observePip(PINS_PATH, "SUBSTITUTED BACKEND BYTES\n", wheel);
        expect(
          obs.refused,
          "pip did NOT refuse bytes served under the pinned backend's own name and version — " +
            `they would be imported as the PEP 517 backend in the job that publishes to PyPI. ${obs.stdio}`,
        ).toBe(true);
        expect(obs.exit, "the install concluded successfully on substituted bytes").not.toBe(0);
      },
    );

    it.skipIf(PYTHON === null)(
      "POSITIVE CONTROL: bytes whose sha256 IS listed clear the hash gate",
      () => {
        // Without this, "refuse everything" — an empty or malformed pin file —
        // satisfies the refusal above. Same served bytes, same command; the only
        // difference is that the requirements file names THEIR digest, so
        // clearing the gate isolates the hash as the reason for the refusal.
        const served = "SUBSTITUTED BACKEND BYTES\n";
        const sha = createHash("sha256").update(served).digest("hex");
        const dir = mkdtempSync(join(tmpdir(), "aimock-pin-pos-"));
        try {
          const req = join(dir, "req.txt");
          writeFileSync(req, `hatchling==1.31.0 --hash=sha256:${sha}\n`);
          const obs = observePip(req, served, "hatchling-1.31.0-py3-none-any.whl");
          expect(
            obs.refused,
            `pip refused bytes that match their listed digest, so the refusal above proves ` +
              `nothing about hashes. ${obs.stdio}`,
          ).toBe(false);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );
  });
});
