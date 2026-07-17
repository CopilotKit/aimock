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
    // Specific pending reason — not any stray occurrence of "pending".
    expect(r.stderr).toMatch(/check\(s\) still pending\/queued\/in_progress — NOT green/);
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
    expect(r.stderr).toMatch(/check\(s\) still pending\/queued\/in_progress — NOT green/);
    // A required context that is pending is ALSO missing-required (not passing).
    expect(r.stderr).toMatch(/required context\(s\) missing or not passing/);
    expect(r.stderr).toMatch(/- test \(24\)$/m);
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

  // Exercise each derived-state leg INDIVIDUALLY (bucket field absent, so
  // eff_bucket derives the bucket from raw .state). Each state maps to a
  // specific effective bucket with a specific refusal reason; a single lumped
  // assertion could pass on the wrong mapping, so we pin each leg to its exact
  // reason. The single required "only-check" is present-and-passing, so the
  // ONLY reason to refuse is the extra check's derived bucket.
  const DERIVED_STATE_LEGS: Array<{ state: string; reason: RegExp }> = [
    { state: "ERROR", reason: /check\(s\) failed\/errored — NOT green/ },
    { state: "STARTUP_FAILURE", reason: /check\(s\) failed\/errored — NOT green/ },
    { state: "TIMED_OUT", reason: /check\(s\) failed\/errored — NOT green/ },
    { state: "CANCELED", reason: /check\(s\) cancelled\/stale — NOT green/ },
    { state: "NEUTRAL", reason: /not required and not on IGNORE_CONTEXTS/ },
  ];
  for (const { state, reason } of DERIVED_STATE_LEGS) {
    it(`derived-state leg '${state}' (no bucket field) maps to its bucket and REFUSES (exit 1)`, () => {
      const r = runGate(
        [
          { name: "only-check", state: "SUCCESS", bucket: "pass" },
          { name: "extra", state },
        ],
        { REQUIRED_CONTEXTS: "only-check" },
      );
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(reason);
    });
  }

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
    // An unknown-bucket check trips BOTH the unknown-count reason AND the sum
    // mismatch (it does not land in any recognized bucket). Assert both specific
    // reasons rather than an either-or match.
    expect(r.stderr).toMatch(/check\(s\) in an unrecognized bucket\/state — NOT green/);
    expect(r.stderr).toMatch(/bucket sum mismatch — recognized=\d+ total=\d+/);
  });

  it("malformed JSON (array of non-objects [1,2,3]) — exit 2, SPECIFICALLY the object-guard branch", () => {
    // Guards finding #4: this used to slip past the type=="array" guard and
    // crash jq with an undocumented exit 5. Assert the SPECIFIC object-guard
    // message so this cannot pass on the field-type guard's "non-string .bucket
    // or .state" message instead — the two guards catch different malformations
    // and a test that matched either would not lock the object-guard branch.
    const r = runGate("[1,2,3]");
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/check JSON array contains a non-object element/);
    // NOT the field-type guard: [1,2,3] fails the object guard first.
    expect(r.stderr).not.toMatch(/non-string \.bucket or \.state/);
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
    expect(r.stderr).toMatch(/check\(s\) in an unrecognized bucket\/state — NOT green/);
    expect(r.stderr).toMatch(/bucket sum mismatch — recognized=\d+ total=\d+/);
  });

  it("non-string .bucket (object) with state SUCCESS — exit 2 config error (closes a false-GREEN, not a jq crash)", () => {
    // CORRECTED RATIONALE: the coerce_str helper already maps a non-string
    // .bucket to "" (no ascii_downcase crash / exit 5). The REAL hole this
    // field-type guard closes is a FALSE-GREEN via the state fallback: a check
    // with a non-string .bucket but state="SUCCESS" would, absent the guard,
    // fall through coerce_str ("") into the state branch and resolve to the
    // "pass" bucket — a malformed check silently scored as passing. The guard
    // rejects it as the documented config error (exit 2) instead. The
    // ISOLATED-VECTOR test below proves that flip directly.
    const r = runGate('[{"name":"x","state":"SUCCESS","bucket":{"weird":true}}]', {
      REQUIRED_CONTEXTS: "x",
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/non-string \.bucket or \.state/);
  });

  it("ISOLATED VECTOR: non-string .bucket→state-fallback false-green (guard removed → GREEN; present → refused)", () => {
    // Prove the guard's VALUE, not just its presence: the same malformed input
    // (non-string .bucket, state SUCCESS) flips from a false-GREEN to a refusal
    // when the field-type guard is present. Mutating the guard out demonstrates
    // the exact false-green the guard closes.
    const payload = '[{"name":"x","state":"SUCCESS","bucket":{"weird":true}}]';
    // Guard REMOVED: the non-string bucket coerces to "" → state fallback →
    // "pass" bucket → the gate would MERGE this malformed check (false-green).
    const withoutGuard = runMutatedGate(
      (src) =>
        src.replace(
          /# Field-type guard:[\s\S]*?exit 2\nfi\n/,
          "# field-type guard removed for this test\n",
        ),
      payload,
      { REQUIRED_CONTEXTS: "x" },
    );
    expect(withoutGuard.code).toBe(0);
    expect(withoutGuard.stdout).toMatch(/GREEN/);
    // Guard PRESENT (real gate): the malformed check is refused as exit 2.
    const withGuard = runGate(payload, { REQUIRED_CONTEXTS: "x" });
    expect(withGuard.code).toBe(2);
    expect(withGuard.stderr).toMatch(/non-string \.bucket or \.state/);
  });

  it("non-string .state (number) — exit 2 config error (malformed check data, not a jq crash)", () => {
    // Same field-type guard on .state: a numeric state is malformed check data
    // from gh and must fail closed as the documented config error, not be
    // coerced and scored.
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
    expect(r.stderr).toMatch(/check\(s\) still pending\/queued\/in_progress — NOT green/);
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
    expect(r.stderr).toMatch(/check\(s\) still pending\/queued\/in_progress — NOT green/);
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

  it("CONSOLIDATED-VERDICT GUARD: a runtime jq failure in the verdict program exits 2, never masks to green", () => {
    // Structural fix (single guarded verdict): the entire decision is computed
    // by ONE jq program whose output is validated ONCE before the shell reads
    // any field. Mutate a shared helper (coerce_str) so eff_bucket — and thus
    // the whole verdict program — throws at runtime, and assert the gate fails
    // CLOSED with the documented config-error exit 2 (the verdict validity
    // assertion), NOT a scored 0/1 decision, not a false-green, not exit 5.
    const r = runMutatedGate(
      (src) => src.replace(/def coerce_str:[^\n]*\n/, "def coerce_str: (undefined_fn);\n"),
      [{ name: "x", state: "SUCCESS", bucket: "pass" }],
      { REQUIRED_CONTEXTS: "x" },
    );
    expect(r.code).toBe(2);
    // The SPECIFIC consolidated-verdict assertion message — not a generic match.
    expect(r.stderr).toMatch(/jq failed to compute a valid verdict over the input/);
  });

  it("CONSOLIDATED-VERDICT GUARD: an EMPTY verdict (jq emits nothing) exits 2, never reads as green", () => {
    // This is the crux of the recurring class: `set -e` does NOT guard a
    // command-substitution RHS, so a crashed jq yields an EMPTY VERDICT. The
    // old scattered `UNACCEPTED_CHECKS`/`MISSING_REQUIRED` assignments read that
    // empty as "no unaccepted / no missing" = GREEN. Force the single verdict
    // capture to emit nothing and confirm the validity assertion rejects it as
    // exit 2 — an empty verdict can NEVER be interpreted as a pass.
    const r = runMutatedGate(
      (src) =>
        src.replace(
          /VERDICT="\$\(echo "\$CHECKS_JSON" \| jq -c "\$JQ_VERDICT"\)"/,
          'VERDICT="$(printf %s "")"',
        ),
      [{ name: "x", state: "SUCCESS", bucket: "pass" }],
      { REQUIRED_CONTEXTS: "x" },
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/jq failed to compute a valid verdict over the input/);
  });

  it("CONSOLIDATED-VERDICT GUARD: a verdict object with a non-boolean .green exits 2, never green", () => {
    // The validity assertion requires .green to be a BOOLEAN. A verdict whose
    // .green somehow becomes a non-boolean (e.g. a string) must fail closed as
    // exit 2 rather than let `[ "$GREEN" != "true" ]` misfire. Mutate the
    // verdict program to emit green as a string and confirm exit 2.
    const r = runMutatedGate(
      (src) => src.replace(/green: \(\(\$reasons \| length\) == 0\),/, 'green: "yes",'),
      [{ name: "x", state: "SUCCESS", bucket: "pass" }],
      { REQUIRED_CONTEXTS: "x" },
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/jq failed to compute a valid verdict over the input/);
  });

  it("STRUCTURAL INVARIANT: no bare `VAR=$(jq ...)` whose emptiness could read as green", () => {
    // The recurring bug class is a scattered `VAR="$(echo "$CHECKS_JSON" | jq
    // ...)"` whose crash-emptied output is later interpreted as a green signal.
    // Lock the invariant structurally: the ONLY jq invocation that consumes
    // $CHECKS_JSON to score checks is the single guarded $JQ_VERDICT capture.
    // No `$CHECKS_JSON | jq` assignment may exist outside that one line.
    const src = readFileSync(GATE, "utf8");
    const checksJsonJqAssignments = src
      .split("\n")
      .filter((l) => !/^\s*#/.test(l)) // ignore comment lines
      .filter((l) => /=\s*"?\$\(\s*echo "\$CHECKS_JSON" \| jq/.test(l));
    // Exactly one: the guarded VERDICT capture.
    expect(checksJsonJqAssignments.length).toBe(1);
    expect(checksJsonJqAssignments[0]).toMatch(
      /VERDICT="\$\(echo "\$CHECKS_JSON" \| jq -c "\$JQ_VERDICT"\)"/,
    );
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
