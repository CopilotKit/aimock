import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Tests for scripts/ci-merge-gate.sh — the auto-merge green-gate decision.
//
// EVERY case here INVOKES THE REAL scripts/ci-merge-gate.sh with fixture JSON
// and asserts its exit code / stderr. Nothing is asserted against a JS replica
// of the gate — so if the gate script were deleted or reverted to the old
// row-count logic, this suite FAILS (see the "reverting the gate" guard test).
//
// Exit-code contract of the gate: 0 = true-green (merge), 1 = not green
// (do not merge), 2 = usage / malformed-input / config error.
// ---------------------------------------------------------------------------

const GATE = resolve(__dirname, "../../scripts/ci-merge-gate.sh");

type Check = { name: string; state: string; bucket?: string };

/** Run the real gate with a check array (or raw string) on stdin. */
function runGate(
  input: Check[] | string,
  env: Record<string, string> = {},
): { code: number; stdout: string; stderr: string } {
  const payload = typeof input === "string" ? input : JSON.stringify(input);
  const r = spawnSync("bash", [GATE], {
    input: payload,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Run the real gate passing the JSON via a FILE ARGUMENT (not stdin). */
function runGateWithFile(
  input: Check[] | string,
  env: Record<string, string> = {},
): { code: number; stdout: string; stderr: string } {
  const payload = typeof input === "string" ? input : JSON.stringify(input);
  const dir = mkdtempSync(join(tmpdir(), "gate-file-"));
  try {
    const file = join(dir, "checks.json");
    writeFileSync(file, payload);
    const r = spawnSync("bash", [GATE, file], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Run a COPY of the gate whose source has been mutated, from a temp dir. */
function runMutatedGate(
  mutate: (src: string) => string,
  input: Check[] | string,
  env: Record<string, string> = {},
): { code: number; stdout: string; stderr: string } {
  const payload = typeof input === "string" ? input : JSON.stringify(input);
  const dir = mkdtempSync(join(tmpdir(), "gate-mut-"));
  try {
    const mutated = mutate(readFileSync(GATE, "utf8"));
    const script = join(dir, "ci-merge-gate.sh");
    writeFileSync(script, mutated);
    const r = spawnSync("bash", [script], {
      input: payload,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The canonical required-context set a drift-fix PR must pass on this repo.
// This mirrors the branch's real gating checks. The regression test below
// asserts the gate script's DEFAULT_REQUIRED_CONTEXTS matches this list, so if
// the two drift (a gating check is added/removed in one place only) CI fails
// loudly here instead of silently merging an unverified PR in prod.
const CANONICAL_REQUIRED = [
  "prettier",
  "eslint",
  "exports",
  "commitlint",
  "test (20)",
  "test (22)",
  "test (24)",
  "agui-schema-drift",
  "drift-live-pr",
  "zizmor",
];

// All-required-green shape (mirrors PR #305's passing checks). notify/drift are
// non-required extras that legitimately skip; they are on the gate's default
// IGNORE_CONTEXTS allow-list so they must not block.
const ALL_GREEN: Check[] = [
  ...CANONICAL_REQUIRED.map((name) => ({ name, state: "SUCCESS", bucket: "pass" })),
  { name: "notify", state: "SKIPPED", bucket: "skipping" },
  { name: "drift", state: "SKIPPED", bucket: "skipping" },
];

describe("ci-merge-gate.sh — refuses every false-green shape (real gate invoked)", () => {
  it("empty array [] — REFUSES (exit 1)", () => {
    const r = runGate([]);
    expect(r.code).toBe(1);
    // Tight reason: an empty array specifically has zero pass-bucket checks.
    expect(r.stderr).toMatch(/no checks in 'pass' bucket/);
  });

  it("historical no-rows / empty-string input — REFUSES (exit 1)", () => {
    // The old gate counted a "no checks reported" stdout LINE as a row and
    // sailed through. The real gate treats empty/whitespace input as NOT green.
    const r = runGate("   \n  ");
    expect(r.code).toBe(1);
    // Tight reason: whitespace-only input is the empty-JSON path specifically.
    expect(r.stderr).toMatch(/empty check JSON/);
  });

  it("pending-only — REFUSES (exit 1)", () => {
    const r = runGate([{ name: "test (20)", state: "IN_PROGRESS", bucket: "pending" }]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/pending/);
  });

  it("skipped/neutral-only — REFUSES (exit 1), skips never count as pass", () => {
    const r = runGate([
      { name: "prettier", state: "SKIPPED", bucket: "skipping" },
      { name: "eslint", state: "NEUTRAL", bucket: "skipping" },
    ]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/no checks in 'pass' bucket/);
  });

  it("one unrelated pass, a required context missing — REFUSES (exit 1)", () => {
    const r = runGate([{ name: "Continuous Releases", state: "SUCCESS", bucket: "pass" }]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/required context\(s\) missing/);
  });

  it("a required context in the fail bucket — REFUSES (exit 1)", () => {
    const checks = ALL_GREEN.map((c) =>
      c.name === "eslint" ? { ...c, state: "FAILURE", bucket: "fail" } : c,
    );
    const r = runGate(checks);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/failed\/errored/);
  });

  it("a required context in the pending bucket — REFUSES (exit 1)", () => {
    const checks = ALL_GREEN.map((c) =>
      c.name === "test (24)" ? { ...c, state: "IN_PROGRESS", bucket: "pending" } : c,
    );
    const r = runGate(checks);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/pending/);
  });

  it("a check in the cancel/stale bucket — REFUSES (exit 1)", () => {
    const checks = [...ALL_GREEN, { name: "extra", state: "STALE", bucket: "cancel" }];
    const r = runGate(checks);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/cancelled\/stale/);
  });

  it("action_required (derived from state, no bucket field) — REFUSES (exit 1)", () => {
    const r = runGate([{ name: "only-check", state: "ACTION_REQUIRED" }], {
      REQUIRED_CONTEXTS: "only-check",
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/failed\/errored/);
  });

  it("a non-required skipped check NOT on the ignore-list — REFUSES (exit 1)", () => {
    // Guards finding #1: a newly-added gating check that resolves skipped must
    // NOT be silently ignored just because it is not (yet) in REQUIRED_CONTEXTS.
    const r = runGate([
      { name: "only-check", state: "SUCCESS", bucket: "pass" },
      { name: "new-gating-check", state: "SKIPPED", bucket: "skipping" },
    ]);
    // only-check is not in the default REQUIRED set → required missing too,
    // but the salient assertion is the unaccepted-check refusal.
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/not required and not on IGNORE_CONTEXTS/);
  });

  it("an unknown-bucket check — REFUSES (exit 1), never silently dropped", () => {
    // Guards finding #2: a check whose bucket/state spelling is unrecognized
    // must be treated as NOT-pass and fail the gate.
    const r = runGate(
      [
        { name: "only-check", state: "SUCCESS", bucket: "pass" },
        { name: "weird", state: "WHAT", bucket: "mystery" },
      ],
      { REQUIRED_CONTEXTS: "only-check" },
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/unrecognized bucket|bucket sum mismatch/);
  });

  it("malformed JSON (array of non-objects [1,2,3]) — exit 2 per contract", () => {
    // Guards finding #4: this used to slip past the type=="array" guard and
    // crash jq with an undocumented exit 5.
    const r = runGate("[1,2,3]");
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/non-object element|malformed/);
  });

  it("malformed JSON (not an array) — exit 2 per contract", () => {
    const r = runGate('{"name":"x"}');
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/not a JSON array/);
  });

  it("empty/whitespace REQUIRED_CONTEXTS — exit 2 config error, never a no-op green", () => {
    // Guards finding #7: a gate with zero requirements must NOT merge.
    const r = runGate([{ name: "x", state: "SUCCESS", bucket: "pass" }], {
      REQUIRED_CONTEXTS: "   ",
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/REQUIRED_CONTEXTS is empty/);
  });

  it("a REQUIRED context resolved to skipping — REFUSES (exit 1), skip never satisfies a requirement", () => {
    const checks = ALL_GREEN.map((c) =>
      c.name === "zizmor" ? { ...c, state: "SKIPPED", bucket: "skipping" } : c,
    );
    const r = runGate(checks);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/required context\(s\) missing or not passing/);
    // The salient reason is the missing-required refusal, NOT a generic skip.
    expect(r.stderr).toMatch(/- zizmor$/m);
  });

  it("a REQUIRED context in the cancel bucket — REFUSES (exit 1)", () => {
    const checks = ALL_GREEN.map((c) =>
      c.name === "commitlint" ? { ...c, state: "CANCELLED", bucket: "cancel" } : c,
    );
    const r = runGate(checks);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/cancelled\/stale/);
    expect(r.stderr).toMatch(/required context\(s\) missing or not passing/);
  });

  it("duplicate same-name REQUIRED where one leg FAILS — REFUSES (exit 1)", () => {
    // A required context with a passing leg AND a failing leg is NOT green: the
    // failing leg must sink the gate even though the name is technically present
    // in a pass bucket.
    const checks = [...ALL_GREEN, { name: "eslint", state: "FAILURE", bucket: "fail" }];
    const r = runGate(checks);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/failed\/errored/);
  });

  it("empty-string state AND bucket → unknown (exit 1), never silently pass", () => {
    // A blank state+bucket must resolve to the "unknown" sentinel and fail —
    // never be dropped or defaulted to pass.
    const r = runGate([{ name: "only-check", state: "", bucket: "" }], {
      REQUIRED_CONTEXTS: "only-check",
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/unrecognized bucket|bucket sum mismatch/);
  });

  it("non-string .bucket (object) — exit 2 config error, never a jq crash (exit 5)", () => {
    // Guards the new field-type guard: a valid object with a non-string .bucket
    // used to throw "explode input must be a string" inside ascii_downcase and
    // exit 5 (outside the 0/1/2 contract). It must now fail closed as exit 2.
    const r = runGate('[{"name":"x","state":"SUCCESS","bucket":{"weird":true}}]', {
      REQUIRED_CONTEXTS: "x",
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/non-string \.bucket or \.state/);
  });

  it("non-string .state (number) — exit 2 config error, never a jq crash (exit 5)", () => {
    const r = runGate('[{"name":"x","state":123}]', { REQUIRED_CONTEXTS: "x" });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/non-string \.bucket or \.state/);
  });

  it("contradictory config: a name in BOTH required and ignore — exit 2 config error", () => {
    // Guards finding #5: a required context can never be "safe to skip". The
    // gate fails closed rather than silently resolving the contradiction.
    const r = runGate([{ name: "x", state: "SUCCESS", bucket: "pass" }], {
      REQUIRED_CONTEXTS: "x,dup",
      IGNORE_CONTEXTS: "dup",
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/BOTH REQUIRED_CONTEXTS and IGNORE_CONTEXTS/);
  });

  it("null .name in the pass bucket does NOT satisfy a required context — REFUSES (exit 1)", () => {
    // Guards finding #5: a nameless pass check counts toward pass>=1 but must
    // not be able to resolve a named required context.
    const r = runGate('[{"name":null,"state":"SUCCESS","bucket":"pass"}]', {
      REQUIRED_CONTEXTS: "realreq",
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/required context\(s\) missing or not passing/);
    expect(r.stderr).toMatch(/- realreq$/m);
  });
});

describe("ci-merge-gate.sh — accepts genuine true-green (real gate invoked)", () => {
  it("all-required-green (extras skipped + allow-listed) — ACCEPTS (exit 0)", () => {
    const r = runGate(ALL_GREEN);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/GREEN/);
  });

  it("duplicate/mixed same-name required context (one pass) — ACCEPTS (exit 0)", () => {
    // A required context appearing twice (e.g. re-run) where at least one leg
    // passes and none fail/pend is satisfied.
    const checks = [
      ...ALL_GREEN,
      { name: "eslint", state: "SUCCESS", bucket: "pass" }, // duplicate pass
    ];
    const r = runGate(checks);
    expect(r.code).toBe(0);
  });

  it("duplicate same-name required with one leg still pending — REFUSES (exit 1)", () => {
    const checks = [
      ...ALL_GREEN,
      { name: "eslint", state: "IN_PROGRESS", bucket: "pending" }, // duplicate pending
    ];
    const r = runGate(checks);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/pending/);
  });

  it("honors REQUIRED_CONTEXTS override (comma-separated)", () => {
    const r = runGate([{ name: "only-check", state: "SUCCESS", bucket: "pass" }], {
      REQUIRED_CONTEXTS: "only-check",
    });
    expect(r.code).toBe(0);
  });

  it("honors IGNORE_CONTEXTS override for a non-required skipped check", () => {
    const r = runGate(
      [
        { name: "only-check", state: "SUCCESS", bucket: "pass" },
        { name: "optional-skip", state: "SKIPPED", bucket: "skipping" },
      ],
      { REQUIRED_CONTEXTS: "only-check", IGNORE_CONTEXTS: "optional-skip" },
    );
    expect(r.code).toBe(0);
  });

  it("derives bucket from raw state when the bucket field is absent", () => {
    const checks = ALL_GREEN.filter((c) => c.bucket === "pass").map(({ name, state }) => ({
      name,
      state,
    }));
    const r = runGate(checks as Check[]);
    expect(r.code).toBe(0);
  });
});

describe("ci-merge-gate.sh — file-argument input path (real gate invoked)", () => {
  it("reads JSON from a FILE ARG and accepts true-green (exit 0)", () => {
    const r = runGateWithFile(ALL_GREEN);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/GREEN/);
  });

  it("reads JSON from a FILE ARG and refuses a false-green (exit 1)", () => {
    const r = runGateWithFile([{ name: "test (20)", state: "IN_PROGRESS", bucket: "pending" }]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/pending/);
  });

  it("file-not-found → exit 2 config error", () => {
    const r = spawnSync("bash", [GATE, "/nonexistent/path/does-not-exist.json"], {
      encoding: "utf8",
      env: { ...process.env },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/input file not found/);
  });
});

describe("ci-merge-gate.sh — drift + revert guards", () => {
  it("gate script's DEFAULT_REQUIRED_CONTEXTS matches the canonical required set", () => {
    // Finding #1(b): catch REQUIRED_CONTEXTS drifting from the repo's real
    // required checks in CI, not in prod. If a gating check is added/removed in
    // only one place, this fails loudly.
    const src = readFileSync(GATE, "utf8");
    const m = src.match(/DEFAULT_REQUIRED_CONTEXTS='([^']*)'/);
    expect(m, "DEFAULT_REQUIRED_CONTEXTS assignment not found in gate script").toBeTruthy();
    const scriptList = m![1]
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(scriptList).toEqual(CANONICAL_REQUIRED);
  });

  it("gate script's DEFAULT_IGNORE_CONTEXTS is exactly the tight reviewed set (widening fails here)", () => {
    // Drift-guard on the DANGEROUS direction: widening IGNORE_CONTEXTS silently
    // tolerates more non-passing checks. Pin it to the exact reviewed set so any
    // addition to the allow-list must be a conscious, test-updating change.
    const src = readFileSync(GATE, "utf8");
    const m = src.match(/DEFAULT_IGNORE_CONTEXTS='([^']*)'/);
    expect(m, "DEFAULT_IGNORE_CONTEXTS assignment not found in gate script").toBeTruthy();
    const scriptList = m![1]
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(scriptList).toEqual(["notify", "drift"]);
  });

  it("EXPLICIT-ASSERTION GUARD: a count-jq failure exits 2, never masks to 0", () => {
    // Guards finding #1: with the old `${VAR:-0}` masking, a jq failure while
    // computing a count silently became 0 and the gate proceeded to score on a
    // false count. Mutate the bucket program so eff_bucket throws at runtime and
    // assert the gate now fails CLOSED with the documented config-error exit 2
    // (the jq preflight / assert_count), NOT a scored 0/1 decision or exit 5.
    const r = runMutatedGate(
      (src) => src.replace(/def coerce_str:[^\n]*\n/, "def coerce_str: (undefined_fn);\n"),
      [{ name: "x", state: "SUCCESS", bucket: "pass" }],
      { REQUIRED_CONTEXTS: "x" },
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(
      /jq failed to evaluate the bucket program|is not a non-negative integer/,
    );
  });

  it("EXPLICIT-ASSERTION GUARD: an empty count (assert_count) exits 2, never defaults to 0", () => {
    // Belt-to-the-preflight's-suspenders: even if a count command emitted empty
    // output, assert_count must reject it as a config error rather than let
    // `${VAR:-0}` turn it into a false-green 0. Mutate PASS_COUNT's assignment to
    // emit nothing and confirm the assertion fires (exit 2).
    const r = runMutatedGate(
      (src) =>
        src.replace(
          /PASS_COUNT="\$\(echo "\$CHECKS_JSON" \| jq [^\n]*\)"/,
          'PASS_COUNT="$(printf %s "")"',
        ),
      [{ name: "x", state: "SUCCESS", bucket: "pass" }],
      { REQUIRED_CONTEXTS: "x" },
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/PASS_COUNT is not a non-negative integer/);
  });

  it("REVERT GUARD: the old row-count logic would NOT pass this suite", () => {
    // Prove the suite is anchored to the real gate, not a replica: model the
    // OLD gate (merge iff row-count>0 AND nothing in fail/cancel) and assert it
    // gives the WRONG answer on false-green shapes the real gate refuses. If
    // someone reverted ci-merge-gate.sh to the old logic, the false-green cases
    // above would flip to exit 0 and this expectation documents why they fail.
    const oldGateWouldMerge = (checks: Check[]): boolean => {
      const rowCount = checks.length === 0 ? 1 : checks.length;
      if (rowCount === 0) return false;
      const watchFails = checks.some((c) => c.bucket === "fail" || c.bucket === "cancel");
      return !watchFails;
    };
    // Empty, pending-only, skipped-only, unrelated-pass, skipped-required: old
    // logic MERGES (bug) on all of these.
    expect(oldGateWouldMerge([])).toBe(true);
    expect(oldGateWouldMerge([{ name: "t", state: "IN_PROGRESS", bucket: "pending" }])).toBe(true);
    expect(oldGateWouldMerge([{ name: "t", state: "SKIPPED", bucket: "skipping" }])).toBe(true);
    // An UNRELATED pass with a required missing: old row-count logic sees >0 rows
    // and no fail/cancel → MERGES (bug); the real gate refuses (required missing).
    const unrelatedPass = [{ name: "Continuous Releases", state: "SUCCESS", bucket: "pass" }];
    expect(oldGateWouldMerge(unrelatedPass)).toBe(true);
    // A skipped-ONLY (no pass at all) set: old logic MERGES (bug); real gate
    // refuses (no pass bucket).
    const skippedOnly = [{ name: "t", state: "SKIPPED", bucket: "skipping" }];
    expect(oldGateWouldMerge(skippedOnly)).toBe(true);
    // The REAL gate refuses ALL of those, so a revert to old logic flips these
    // exit codes from 1 → 0 and breaks CI on the broadened cases too.
    expect(runGate([]).code).toBe(1);
    expect(runGate([{ name: "t", state: "IN_PROGRESS", bucket: "pending" }]).code).toBe(1);
    expect(runGate(unrelatedPass).code).toBe(1);
    expect(runGate(skippedOnly).code).toBe(1);
  });
});
