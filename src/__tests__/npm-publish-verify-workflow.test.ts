/**
 * Assertions on the "Verify pinned npm release is published" step of
 * .github/workflows/publish-release.yml.
 *
 * That step is the gate that stops aimock-pytest shipping a pin to an npm
 * version that was never published. It used to ask npm exactly once, so it
 * raced the registry: on the v1.41.0 release (run 34546620094) the publish job
 * landed 1.41.0 at 00:30:31 and this step asked for it at 00:30:49 — 18
 * seconds later — and npm answered E404. The version existed. Re-running the
 * job unchanged passed, publishing nothing.
 *
 * These guards EXECUTE the step's own `run:` body under bash against a stub
 * `npm`, because the only claim worth pinning is behavioural. The important
 * half is NOT that a propagating publish now survives — it is the negative
 * controls: a retry loop that swallowed a genuinely-missing version would be a
 * strictly worse bug than the race it fixed.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

// Every observation runs the real retry loop, but on a VIRTUAL clock: `date`
// and `sleep` are stubbed on PATH alongside `npm`, so the loop's own timing is
// driven by the test rather than by the runner. Nothing here waits on wall
// clock, and nothing here asserts on it. The budget is still stated rather
// than inherited, because a guard whose RED cannot be told apart from a
// timeout proves nothing.
vi.setConfig({ testTimeout: 60_000 });

/** The shipped defaults of the step, which the observations below exercise. */
const DEFAULT_DEADLINE = 300;
const DEFAULT_INITIAL_DELAY = 5;
const DEFAULT_MAX_DELAY = 30;

const WORKFLOW_PATH = resolve(__dirname, "../../.github/workflows/publish-release.yml");
const wf = readFileSync(WORKFLOW_PATH, "utf-8");
const STEP = "Verify pinned npm release is published";
const PKG = "@copilotkit/aimock";

/**
 * The step's `run:` block scalar, dedented.
 *
 * `runBodyIsVerbatim` below re-indents the result and requires it to be a
 * literal substring of the file, so an extractor that paraphrases — and
 * therefore an observation that tests something other than what CI runs —
 * cannot pass.
 */
function runBody(): { body: string; indent: number } {
  const lines = wf.split("\n");
  const at = lines.findIndex((l) => l.includes(`- name: ${STEP}`));
  if (at === -1) throw new Error(`publish-release.yml: no step named ${STEP}`);
  let i = at + 1;
  while (i < lines.length && !/^\s*run: \|\s*$/.test(lines[i])) {
    if (/^\s*- name: /.test(lines[i]))
      throw new Error(`${STEP}: no \`run: |\` before the next step`);
    i++;
  }
  if (i >= lines.length) throw new Error(`${STEP}: no \`run: |\` block found`);
  const indent = lines[i].length - lines[i].trimStart().length + 2;
  const out: string[] = [];
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j];
    if (!l.trim()) {
      out.push("");
      continue;
    }
    if (l.length - l.trimStart().length < indent) break;
    out.push(l.slice(indent));
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return { body: out.join("\n") + "\n", indent };
}

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

interface Registry {
  /** How many per-version queries answer E404 before the version appears. */
  notFoundTimes: number;
  /** false: the version NEVER appears, however long we wait. */
  eventually: boolean;
  /** false: `npm view <pkg> versions` itself 404s — the package does not exist. */
  packageExists: boolean;
  /** true: the package-level version list already carries the wanted version. */
  listHasVersion: boolean;
  /** true: the package-level query fails with something other than a 404. */
  registryUnreachable: boolean;
}

interface Observation {
  stdout: string;
  exit: number;
  /** How many times the body actually asked npm for the pinned version. */
  attempts: number;
  /**
   * Every `sleep <n>` the body issued, in order. This is the backoff schedule
   * as the loop actually performed it — the observable that the old
   * `elapsedMs` assertions were a lossy, load-dependent proxy for.
   */
  sleeps: number[];
  /**
   * Seconds the body's own clock advanced: purely the sum of `sleeps`, since
   * the stubbed `date` only moves when the stubbed `sleep` moves it. A slow or
   * fast runner cannot change this number.
   */
  virtualElapsedSeconds: number;
}

/** Where the loop's virtual clock starts. Any fixed integer will do. */
const CLOCK_EPOCH = 1_700_000_000;

/**
 * Attempts after which the npm stub jumps the virtual clock past any plausible
 * deadline. A body that lost its `sleep` would otherwise spin forever against a
 * clock that never advances; this converts that hang into a legible RED.
 */
const RUNAWAY_ATTEMPTS = 40;

/**
 * Write a fixture repo holding `version` in _version.py, put a stub `npm` (and
 * a `python` that is just python3) on PATH, and run the step's own body in it.
 */
function observe(
  version: string,
  registry: Partial<Registry>,
  env: Record<string, string> = {},
): Observation {
  const r: Registry = {
    notFoundTimes: 0,
    eventually: true,
    packageExists: true,
    listHasVersion: false,
    registryUnreachable: false,
    ...registry,
  };
  const dir = mkdtempSync(join(tmpdir(), "npm-publish-verify-"));
  tmpDirs.push(dir);
  const pkgDir = join(dir, "packages/aimock-pytest/src/aimock_pytest");
  mkdirSync(pkgDir, { recursive: true });
  // The real file the step reads with runpy, in the real location.
  writeFileSync(join(pkgDir, "_version.py"), `AIMOCK_VERSION = "${version}"\n`);

  const bin = join(dir, "bin");
  mkdirSync(bin);
  const counter = join(dir, "attempts");
  writeFileSync(counter, "0\n");

  // The virtual clock. `date +%s` reads it; `sleep N` advances it by N and
  // records N. The body is unmodified — it still calls `date` and `sleep` — but
  // its notion of elapsed time is now the test's to decide, so the deadline
  // arithmetic is exercised exactly and no observation depends on wall clock.
  const clock = join(dir, "clock");
  writeFileSync(clock, `${CLOCK_EPOCH}\n`);
  const sleepLog = join(dir, "sleeps");
  writeFileSync(sleepLog, "");

  writeFileSync(
    join(bin, "date"),
    [
      "#!/usr/bin/env bash",
      `if [ "$1" = "+%s" ]; then cat ${JSON.stringify(clock)}; exit 0; fi`,
      'exec /bin/date "$@"',
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "date"), 0o755);

  writeFileSync(
    join(bin, "sleep"),
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$1" >> ${JSON.stringify(sleepLog)}`,
      `now=$(cat ${JSON.stringify(clock)})`,
      `printf '%s\\n' "$((now + $1))" > ${JSON.stringify(clock)}`,
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "sleep"), 0o755);

  // GitHub's setup-python provides `python`; developer machines and the ubuntu
  // runner provide `python3`. The body genuinely executes runpy either way.
  writeFileSync(join(bin, "python"), '#!/usr/bin/env bash\nexec python3 "$@"\n');
  chmodSync(join(bin, "python"), 0o755);

  const versionList = r.listHasVersion ? ["1.0.0", version] : ["1.0.0"];
  writeFileSync(
    join(bin, "npm"),
    [
      "#!/usr/bin/env bash",
      '[ "$1" = view ] || { echo "stub npm: unsupported $*" >&2; exit 2; }',
      'if [ "$3" = versions ]; then',
      r.registryUnreachable
        ? '  echo "npm error network request to https://registry.npmjs.org/ failed, reason: ETIMEDOUT" >&2; exit 1'
        : r.packageExists
          ? `  echo '${JSON.stringify(versionList)}'; exit 0`
          : `  echo "npm error code E404" >&2; echo "npm error 404 Not Found - GET https://registry.npmjs.org/${PKG} - Not found" >&2; exit 1`,
      "fi",
      `n=$(cat ${JSON.stringify(counter)})`,
      "n=$((n + 1))",
      `echo "$n" > ${JSON.stringify(counter)}`,
      // Runaway fuse: a body that stopped sleeping would never move the
      // virtual clock and would loop forever. Jump the clock so it exits and
      // the attempt-count assertions go RED instead of the suite hanging.
      `if [ "$n" -gt ${RUNAWAY_ATTEMPTS} ]; then`,
      `  printf '%s\\n' "$(( $(cat ${JSON.stringify(clock)}) + 1000000 ))" > ${JSON.stringify(clock)}`,
      "fi",
      r.eventually ? `if [ "$n" -gt ${r.notFoundTimes} ]; then echo "${version}"; exit 0; fi` : "",
      'echo "npm error code E404" >&2',
      `echo "npm error 404 No match found for version ${version}" >&2`,
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "npm"), 0o755);

  const proc = spawnSync("bash", ["-e", "-c", runBody().body], {
    cwd: dir,
    encoding: "utf-8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      // No window shrinking. The observations below run the SHIPPED 300s/5s/30s
      // defaults, because on a virtual clock a five-minute window costs
      // nothing, and a body tested at its real settings cannot pass here while
      // behaving differently in CI.
      ...env,
    },
  });
  const sleeps = readFileSync(sleepLog, "utf-8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map(Number);
  return {
    stdout: (proc.stdout ?? "") + (proc.stderr ?? ""),
    exit: proc.status ?? -1,
    attempts: Number(readFileSync(counter, "utf-8").trim()),
    sleeps,
    virtualElapsedSeconds: Number(readFileSync(clock, "utf-8").trim()) - CLOCK_EPOCH,
  };
}

describe("publish-release.yml — the run body under test is the committed one", () => {
  it("the extracted `run:` body is a LITERAL substring of the file when re-indented", () => {
    const { body, indent } = runBody();
    const pad = " ".repeat(indent);
    const reindented = body
      .replace(/\n$/, "")
      .split("\n")
      .map((l) => (l === "" ? "" : pad + l))
      .join("\n");
    expect(wf).toContain(reindented);
  });

  it("still reads the pin with runpy rather than importing the package", () => {
    expect(runBody().body).toContain("runpy.run_path");
    expect(runBody().body).toContain("packages/aimock-pytest/src/aimock_pytest/_version.py");
  });

  it("ships a 300s default window, not whatever the tests happen to set", () => {
    // A five-minute ceiling: ~16x the 18s lag that broke the v1.41.0 release,
    // past npm's replication tail, still small beside the job's own setup.
    // The observations below run AT these defaults, so the exact attempt
    // counts and backoff schedules they assert are the shipped ones.
    expect(runBody().body).toContain(`NPM_VIEW_DEADLINE_SECONDS:-${DEFAULT_DEADLINE}}`);
    expect(runBody().body).toContain(`NPM_VIEW_INITIAL_DELAY_SECONDS:-${DEFAULT_INITIAL_DELAY}}`);
    expect(runBody().body).toContain(`NPM_VIEW_MAX_DELAY_SECONDS:-${DEFAULT_MAX_DELAY}}`);
  });
});

describe("publish-release.yml — the race it used to lose", () => {
  it("EXECUTED: a version that 404s twice and then appears is accepted", () => {
    const o = observe("1.41.0", { notFoundTimes: 1 });
    expect(o.exit).toBe(0);
    expect(o.attempts).toBe(2);
    // It backed off once, by the shipped initial delay, before asking again.
    expect(o.sleeps).toEqual([DEFAULT_INITIAL_DELAY]);
    expect(o.stdout).toContain(`${PKG}@1.41.0 is published`);
  });

  it("EXECUTED: a per-version 404 is overruled by the package's own version list", () => {
    // The registry has already proven the version exists; nothing is gained by
    // sitting out the rest of the window, so it must not sleep at all.
    const o = observe("1.41.0", { eventually: false, listHasVersion: true });
    expect(o.exit).toBe(0);
    expect(o.attempts).toBe(1);
    expect(o.sleeps).toEqual([]);
    expect(o.stdout).toContain("IS in the registry version list");
  });

  it("EXECUTED: every attempt is logged, so a future failure is diagnosable", () => {
    const o = observe("1.41.0", { notFoundTimes: 2 });
    expect(o.attempts).toBe(3);
    expect(o.stdout).toContain("attempt 1 (t+");
    expect(o.stdout).toContain("attempt 2 (t+");
    expect(o.stdout).toContain("attempt 3");
    expect(o.stdout).toContain("No match found for version 1.41.0");
    expect(o.stdout).toContain("retrying in");
  });
});

describe("publish-release.yml — NEGATIVE CONTROLS: the guard still bites", () => {
  /**
   * The schedule the shipped defaults produce, worked out by hand from
   * 5s doubling to a 30s ceiling until the loop's own clock reaches 300s:
   *
   *   attempt  1   2   3   4   5   6    7    8    9   10   11   12   13
   *   at t+    0   5  15  35  65  95  125  155  185  215  245  275  305
   *   slept     5  10  20  30  30  30   30   30   30   30   30   30
   *
   * Attempt 13 sees t+305 >= 300 and fails. These are exact because the loop
   * runs on the test's clock; there is no runner-dependent quantity left in
   * any of them.
   */
  const DEFAULT_SLEEPS = [5, 10, 20, 30, 30, 30, 30, 30, 30, 30, 30, 30];
  const DEFAULT_TOTAL = 305;

  it("EXECUTED: a version that never appears FAILS, after waiting out the window", () => {
    const o = observe("99.99.99", { eventually: false });
    expect(o.exit).toBe(1);
    // It must have actually waited — a body that failed on the first attempt
    // would be the original bug wearing a retry loop's clothes.
    expect(o.attempts).toBe(DEFAULT_SLEEPS.length + 1);
    expect(o.sleeps).toEqual(DEFAULT_SLEEPS);
    expect(o.virtualElapsedSeconds).toBe(DEFAULT_TOTAL);
    expect(o.stdout).toContain("::error::");
    expect(o.stdout).toContain(`over ${DEFAULT_TOTAL}s (deadline ${DEFAULT_DEADLINE}s)`);
    expect(o.stdout).toContain("still not published after");
    expect(o.stdout).toContain("refusing to publish a pin to a version npm does not have");
  });

  it("EXECUTED: the retry window is honoured, not multiplied by a longer deadline", () => {
    // A SHORTER deadline must stop the loop sooner, and the overshoot past any
    // deadline is bounded by one backoff step — the loop may not notice it is
    // out of time only after another full round. Both are properties of the
    // body's arithmetic, not of how fast this machine happens to be.
    const shortDeadline = 100;
    const short = observe(
      "99.99.99",
      { eventually: false },
      {
        NPM_VIEW_DEADLINE_SECONDS: String(shortDeadline),
      },
    );
    expect(short.exit).toBe(1);
    expect(short.sleeps).toEqual([5, 10, 20, 30, 30, 30]);
    expect(short.attempts).toBe(7);
    expect(short.virtualElapsedSeconds).toBe(125);

    for (const [o, deadline] of [
      [short, shortDeadline],
      [observe("99.99.99", { eventually: false }), DEFAULT_DEADLINE],
    ] as const) {
      expect(o.virtualElapsedSeconds).toBeGreaterThanOrEqual(deadline);
      expect(o.virtualElapsedSeconds).toBeLessThan(deadline + DEFAULT_MAX_DELAY);
    }

    // And the longer deadline really did buy more attempts, so the window is
    // the thing steering the loop.
    expect(short.attempts).toBeLessThan(DEFAULT_SLEEPS.length + 1);
  });

  it("EXECUTED: a pin to a package that does not exist FAILS FAST, without waiting", () => {
    const o = observe("1.41.0", { eventually: false, packageExists: false });
    expect(o.exit).toBe(1);
    expect(o.attempts).toBe(1);
    expect(o.sleeps).toEqual([]);
    expect(o.virtualElapsedSeconds).toBe(0);
    expect(o.stdout).toContain(`npm has no package named ${PKG} at all`);
  });

  it("EXECUTED: an unreachable registry is transient, NOT a missing-package verdict", () => {
    const o = observe("1.41.0", { eventually: false, registryUnreachable: true });
    expect(o.exit).toBe(1);
    // Transient means it keeps the full window, exactly as a lagging publish
    // would — not the one-attempt verdict a missing package earns.
    expect(o.attempts).toBe(DEFAULT_SLEEPS.length + 1);
    expect(o.sleeps).toEqual(DEFAULT_SLEEPS);
    expect(o.stdout).toContain("registry unreachable, treating as transient");
    expect(o.stdout).not.toContain("has no package named");
  });
});
