/**
 * drift-sync-check.ts — the trivial, deterministic data-only gate that
 * REPLACES the 916-line LLM anti-cheat predicate (drift-success-predicate.ts).
 *
 * Three gates, tested independently and composed:
 *   1. changed-file allowlist (data surfaces only)
 *   2. checksum-pin re-assert (P0's logic-pin.test.ts must still be green)
 *   1b. logic-pin.test.ts is admitted ONLY for a membership re-pin of a
 *       `(include|exclude)Families.<provider>` DATA_FROZEN key — see
 *       `checkPinFileEdit`. Gate-2 cannot police that file: it IS gate-2's
 *       oracle, so a re-pasted checksum makes gate-2 green by construction.
 *   3. clean re-collect (post-sync report has zero residual critical diffs)
 *
 * No LLM, no model call — every assertion here is a plain data check.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";

import {
  isAllowedSyncFile,
  checkChangedFileAllowlist,
  countCriticalDiffs,
  listCriticalDiffs,
  formatCriticalDiffs,
  reportTrustNote,
  evaluateSyncCheck,
  checkPinFileEdit,
  runPinCheck,
  recollect,
  SyncCheckReason,
  SyncCheckConfigError,
  REASON_EXIT_CODE,
  runCli,
  deprecationOnlyOutcomes,
  recollectSkipReason,
  parseCliArgs,
  type CliDeps,
  type SyncCheckDeps,
  type CommandResult,
} from "../../scripts/drift-sync-check.js";
import { updateDataFrozenPin } from "../../scripts/drift-pin-file.js";
import { addFamilyLiteralInSource } from "../../scripts/drift-sync.js";
import type { DriftReport } from "../../scripts/drift-types.js";

function report(criticalCounts: number[]): DriftReport {
  return {
    timestamp: "2026-07-22T00:00:00.000Z",
    entries: criticalCounts.map((n, i) => ({
      provider: `provider-${i}`,
      scenario: "scenario",
      builderFile: `src/provider-${i}.ts`,
      builderFunctions: [],
      typesFile: null,
      sdkShapesFile: "src/__tests__/drift/sdk-shapes.ts",
      diffs: Array.from({ length: n }, (_, j) => ({
        path: `field-${j}`,
        severity: "critical" as const,
        issue: "missing",
        expected: "x",
        real: "y",
        mock: "z",
      })),
    })),
  };
}

// ---------------------------------------------------------------------------
// Gate 1 — changed-file allowlist
// ---------------------------------------------------------------------------

describe("isAllowedSyncFile / checkChangedFileAllowlist", () => {
  it("allows the model-registry data file", () => {
    expect(isAllowedSyncFile("src/__tests__/drift/model-registry.ts")).toBe(true);
    // drift-sync re-pins the membership checksum in the SAME run that applies a
    // human-approved classification. Without this the edit lands, gate-2 goes
    // red on the stale pin, and the whole run reports gate-failed.
    expect(isAllowedSyncFile("src/__tests__/drift/logic-pin.test.ts")).toBe(true);
  });

  it("allows a drift-proposals note file at any depth", () => {
    expect(isAllowedSyncFile("drift-proposals/anthropic-new-family.md")).toBe(true);
    expect(isAllowedSyncFile("drift-proposals/nested/dir/note.md")).toBe(true);
  });

  it("rejects the SDK-shape fixture (the primary cheat surface)", () => {
    expect(isAllowedSyncFile("src/__tests__/drift/sdk-shapes.ts")).toBe(false);
  });

  it("rejects a *.drift.ts assertion file", () => {
    expect(isAllowedSyncFile("src/__tests__/drift/anthropic.drift.ts")).toBe(false);
  });

  it("rejects detector/predicate/collector source", () => {
    expect(isAllowedSyncFile("scripts/drift-success-predicate.ts")).toBe(false);
    expect(isAllowedSyncFile("scripts/drift-report-collector.ts")).toBe(false);
    expect(isAllowedSyncFile("scripts/drift-sync.ts")).toBe(false);
  });

  it("rejects a mock-builder production file", () => {
    expect(isAllowedSyncFile("src/messages.ts")).toBe(false);
  });

  it("rejects the CI workflow", () => {
    expect(isAllowedSyncFile(".github/workflows/fix-drift.yml")).toBe(false);
  });

  it("checkChangedFileAllowlist returns only the offenders", () => {
    const offenders = checkChangedFileAllowlist([
      "src/__tests__/drift/model-registry.ts",
      "drift-proposals/note.md",
      "scripts/drift-success-predicate.ts",
      "src/__tests__/drift/sdk-shapes.ts",
    ]);
    expect(offenders).toEqual([
      "scripts/drift-success-predicate.ts",
      "src/__tests__/drift/sdk-shapes.ts",
    ]);
  });

  it("checkChangedFileAllowlist returns [] when every file is allowed", () => {
    expect(
      checkChangedFileAllowlist(["src/__tests__/drift/model-registry.ts", "drift-proposals/x.md"]),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Gate 2 — checksum-pin re-assert
// ---------------------------------------------------------------------------

describe("runPinCheck", () => {
  it("reports ok when the injected runner exits 0", () => {
    const runner = vi.fn((): CommandResult => ({ status: 0, output: "5 passed" }));
    const result = runPinCheck(runner);
    expect(result.ok).toBe(true);
    expect(runner).toHaveBeenCalledWith("pnpm", [
      "exec",
      "vitest",
      "run",
      "src/__tests__/drift/logic-pin.test.ts",
    ]);
  });

  it("reports NOT ok when the injected runner exits non-zero (a pinned rule moved)", () => {
    const runner = vi.fn(
      (): CommandResult => ({
        status: 1,
        output: "FAIL logic-pin.test.ts > freezes NON_MODEL_TOKENS",
      }),
    );
    const result = runPinCheck(runner);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("NON_MODEL_TOKENS");
  });
});

// ---------------------------------------------------------------------------
// Gate 3 — clean re-collect
// ---------------------------------------------------------------------------

describe("countCriticalDiffs", () => {
  it("sums critical diffs across every entry", () => {
    expect(countCriticalDiffs(report([0, 2, 1]))).toBe(3);
  });

  it("is zero for an all-clean report", () => {
    expect(countCriticalDiffs(report([0, 0]))).toBe(0);
  });
});

describe("listCriticalDiffs / formatCriticalDiffs", () => {
  it("IDENTIFIES each critical diff, not just a count", () => {
    const refs = listCriticalDiffs(report([0, 2]));
    expect(refs).toEqual([
      { provider: "provider-1", scenario: "scenario", path: "field-0" },
      { provider: "provider-1", scenario: "scenario", path: "field-1" },
    ]);
  });

  it("prefers a stable `id` over the prose-coupled `path` when one exists", () => {
    const r = report([1]);
    r.entries[0].diffs[0].id = "openai-realtime:no-ga-family";
    expect(formatCriticalDiffs(listCriticalDiffs(r))).toBe(
      "provider-0/scenario: openai-realtime:no-ga-family",
    );
  });

  it("ignores non-critical diffs", () => {
    const r = report([1]);
    r.entries[0].diffs[0].severity = "warning";
    expect(listCriticalDiffs(r)).toEqual([]);
  });
});

describe("reportTrustNote — a zero that cannot be believed is not a clean re-collect", () => {
  function withConclusion(conclusion: string | undefined, quarantine?: number): DriftReport {
    const r = report([0]);
    if (conclusion !== undefined) r.conclusion = conclusion;
    if (quarantine !== undefined) {
      r.quarantine = Array.from({ length: quarantine }, (_, i) => ({
        provider: "unknown",
        testName: `t-${i}`,
        rawLocation: "",
        message: "waitUntil timeout after 30000ms",
      }));
    }
    return r;
  }

  it("trusts a positively-clean report", () => {
    expect(reportTrustNote(withConclusion("clean"))).toBeNull();
  });

  it("trusts a report whose criticals ARE the determination", () => {
    expect(reportTrustNote(withConclusion("critical"))).toBeNull();
  });

  it("does NOT trust a quarantined report (the 74f6efa43753f7d0 mornings' shape)", () => {
    expect(reportTrustNote(withConclusion("quarantine", 2))).toContain("quarantined 2 failure(s)");
  });

  it("does NOT trust a report whose AG-UI leg could not run (entries are incomplete)", () => {
    expect(reportTrustNote(withConclusion("skipped"))).toContain("AG-UI");
  });

  it("does NOT trust a report with no `conclusion` at all (UNKNOWN never passes as clean)", () => {
    expect(reportTrustNote(withConclusion(undefined))).toContain("no `conclusion`");
  });
});

describe("recollect", () => {
  it("fails closed (SyncCheckConfigError) when the collector produced no report file", () => {
    const runner = vi.fn((): CommandResult => ({ status: 0, output: "" }));
    expect(() => recollect(runner, "/nonexistent/path/does-not-exist.json")).toThrow(
      SyncCheckConfigError,
    );
  });
});

// ---------------------------------------------------------------------------
// Composition — evaluateSyncCheck
// ---------------------------------------------------------------------------

const REAL_PIN_FILE = readFileSync("src/__tests__/drift/logic-pin.test.ts", "utf-8");

/** The real pin file with ONE DATA_FROZEN key's pin rewritten. */
function repinned(source: string, key: string, pin: string): string {
  const out = updateDataFrozenPin(source, key, pin);
  if (!out.changed) throw new Error(`fixture: could not re-pin ${key}`);
  return out.text;
}

function deps(overrides: Partial<SyncCheckDeps>): SyncCheckDeps {
  return {
    getChangedFiles: () => ["src/__tests__/drift/model-registry.ts"],
    readCommittedPinFile: () => REAL_PIN_FILE,
    readWorkingPinFile: () => REAL_PIN_FILE,
    runPinCheck: () => ({ ok: true, output: "5 passed" }),
    recollect: () => report([0]),
    ...overrides,
  };
}

function cliDeps(overrides: Partial<CliDeps>): CliDeps {
  return { ...deps({}), recollectSkipReason: () => null, ...overrides };
}

// ---------------------------------------------------------------------------
// Gate-1b — the pin file is allowlisted ONLY for membership re-pins.
// ---------------------------------------------------------------------------

describe("gate-1b: logic-pin.test.ts is on the allowlist only for a membership re-pin", () => {
  const PIN_FILE = "src/__tests__/drift/logic-pin.test.ts";
  const REGISTRY = "src/__tests__/drift/model-registry.ts";

  it("GREEN: a membership re-pin of one (include|exclude)Families.<provider> key PASSES", () => {
    const after = repinned(REAL_PIN_FILE, "excludeFamilies.openai", "a".repeat(64));
    expect(checkPinFileEdit(REAL_PIN_FILE, after).ok).toBe(true);
    const verdict = evaluateSyncCheck(
      deps({
        getChangedFiles: () => [REGISTRY, PIN_FILE],
        readWorkingPinFile: () => after,
      }),
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.reason).toBe(SyncCheckReason.OK);
  });

  // THE BOUNDARY THAT MOVED. `model-registry.ts` is allowlisted too, so a
  // path-level admission of this file is by itself sufficient to silence a
  // frozen surface: widen `isClassifiedFamily` AND re-paste that surface's
  // FROZEN checksum, and gate-1 and gate-2 both pass — gate-2's oracle IS this
  // file. Reproduced end to end against the real tree before this gate existed.
  it("RED: a re-pasted FROZEN logic checksum FAILS, and never reaches the pin test or the re-collect", () => {
    const at = REAL_PIN_FILE.indexOf("  isClassifiedFamily: {");
    const m = /pin: "([0-9a-f]{64})"/.exec(REAL_PIN_FILE.slice(at))!;
    const silenced =
      REAL_PIN_FILE.slice(0, at + m.index) +
      `pin: "${"9".repeat(64)}"` +
      REAL_PIN_FILE.slice(at + m.index + m[0].length);
    const runPinCheckFn = vi.fn(() => ({ ok: true, output: "33 passed" }));
    const recollectFn = vi.fn(() => report([0]));

    const verdict = evaluateSyncCheck(
      deps({
        getChangedFiles: () => [REGISTRY, PIN_FILE],
        readWorkingPinFile: () => silenced,
        runPinCheck: runPinCheckFn,
        recollect: recollectFn,
      }),
    );

    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe(SyncCheckReason.PIN_FILE_NOT_A_MEMBERSHIP_REPIN);
    expect(REASON_EXIT_CODE[verdict.reason]).toBe(23);
    expect(verdict.offendingFiles).toEqual([PIN_FILE]);
    // Gate-2 would have gone GREEN on this tree — that is the whole point.
    expect(runPinCheckFn).not.toHaveBeenCalled();
    expect(recollectFn).not.toHaveBeenCalled();
  });

  it("RED: re-pinning a DATA_FROZEN key the sync may not move (the voice seed set) FAILS", () => {
    const after = repinned(REAL_PIN_FILE, "knownVoiceModelFamilies", "b".repeat(64));
    const verdict = evaluateSyncCheck(
      deps({ getChangedFiles: () => [PIN_FILE], readWorkingPinFile: () => after }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe(SyncCheckReason.PIN_FILE_NOT_A_MEMBERSHIP_REPIN);
    expect(verdict.detail).toContain("knownVoiceModelFamilies");
  });

  it("RED: any edit outside a pin literal FAILS", () => {
    const after = REAL_PIN_FILE.replace(
      "members: () => [...excludeFamilies.openai].sort(),",
      "members: () => [],",
    );
    expect(after).not.toBe(REAL_PIN_FILE);
    const verdict = evaluateSyncCheck(
      deps({ getChangedFiles: () => [PIN_FILE], readWorkingPinFile: () => after }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe(SyncCheckReason.PIN_FILE_NOT_A_MEMBERSHIP_REPIN);
  });

  it("does not consult the pin-file diff at all when the sync did not touch that file", () => {
    const readWorkingPinFile = vi.fn(() => REAL_PIN_FILE);
    const verdict = evaluateSyncCheck(deps({ readWorkingPinFile }));
    expect(verdict.ok).toBe(true);
    expect(readWorkingPinFile).not.toHaveBeenCalled();
  });
});

describe("evaluateSyncCheck — RED/GREEN value-test surface", () => {
  it("GREEN: a data-only excludeFamilies-style change on the allowlist, pins intact, clean re-collect -> PASSES", () => {
    const verdict = evaluateSyncCheck(deps({}));
    expect(verdict.ok).toBe(true);
    expect(verdict.reason).toBe(SyncCheckReason.OK);
    expect(REASON_EXIT_CODE[verdict.reason]).toBe(0);
  });

  it("RED: a change touching a forbidden/source file (the detector) -> FAILS, never reaches pin/recollect", () => {
    const runPinCheck = vi.fn(() => ({ ok: true, output: "" }));
    const recollectFn = vi.fn(() => report([0]));
    const verdict = evaluateSyncCheck(
      deps({
        getChangedFiles: () => [
          "src/__tests__/drift/model-registry.ts",
          "src/__tests__/drift/models.drift.ts", // the detector source (C4)
        ],
        runPinCheck,
        recollect: recollectFn,
      }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe(SyncCheckReason.OFF_ALLOWLIST_CHANGE);
    expect(verdict.offendingFiles).toEqual(["src/__tests__/drift/models.drift.ts"]);
    expect(REASON_EXIT_CODE[verdict.reason]).not.toBe(0);
    // fail-closed and CHEAP: never pays for the pin check or a live re-collect
    // once the allowlist has already refused.
    expect(runPinCheck).not.toHaveBeenCalled();
    expect(recollectFn).not.toHaveBeenCalled();
  });

  it("RED: a change mutating a pinned rule -> FAILS even though the touched file (model-registry.ts) is on the allowlist", () => {
    const recollectFn = vi.fn(() => report([0]));
    const verdict = evaluateSyncCheck(
      deps({
        getChangedFiles: () => ["src/__tests__/drift/model-registry.ts"],
        runPinCheck: () => ({
          ok: false,
          output: "FAIL logic-pin.test.ts > freezes NON_MODEL_TOKENS (rule widened)",
        }),
        recollect: recollectFn,
      }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe(SyncCheckReason.PIN_CHECK_FAILED);
    expect(verdict.detail).toContain("NON_MODEL_TOKENS");
    expect(REASON_EXIT_CODE[verdict.reason]).not.toBe(0);
    // never trusts a live re-collect once a pinned rule has moved
    expect(recollectFn).not.toHaveBeenCalled();
  });

  it("RED: a clean re-collect that still reports residual critical drift -> FAILS", () => {
    const verdict = evaluateSyncCheck(
      deps({
        recollect: () => report([1]),
      }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe(SyncCheckReason.RESIDUAL_CRITICAL_DRIFT);
    expect(verdict.detail).toContain("1 critical");
  });

  it("a refusal NAMES the residual diffs, so the log alone is triageable", () => {
    const r = report([1]);
    r.entries[0].diffs[0].id = "openai-realtime:no-ga-family";
    const verdict = evaluateSyncCheck(deps({ recollect: () => r }));
    expect(verdict.reason).toBe(SyncCheckReason.RESIDUAL_CRITICAL_DRIFT);
    expect(verdict.detail).toContain("provider-0/scenario: openai-realtime:no-ga-family");
  });

  it("a SKIPPED gate-3 says in the verdict what it could not observe", () => {
    const recollectFn = vi.fn(() => report([0]));
    const verdict = evaluateSyncCheck(deps({ recollect: recollectFn }), {
      skipRecollect: true,
      skipRecollectReason: "no live drift surface reads deprecatedFamilies",
    });
    expect(verdict.ok).toBe(true);
    expect(recollectFn).not.toHaveBeenCalled();
    expect(verdict.detail).toContain("live re-collect NOT RUN");
    expect(verdict.detail).toContain("no live drift surface reads deprecatedFamilies");
    // …and never claims the thing it did not do.
    expect(verdict.detail).not.toContain("clean re-collect");
  });

  it("turning gate-3 OFF with no stated reason is a CONFIG ERROR, not a silent pass", () => {
    expect(() => evaluateSyncCheck(deps({}), { skipRecollect: true })).toThrow(
      SyncCheckConfigError,
    );
  });

  it("an UNTRUSTWORTHY zero passes but is reported UNCONFIRMED, never as a clean re-collect", () => {
    const quarantined = report([0]);
    quarantined.conclusion = "quarantine";
    quarantined.quarantine = [
      {
        provider: "unknown",
        testName: "Gemini Live WS drift",
        rawLocation: "",
        message: "timeout",
      },
    ];
    const verdict = evaluateSyncCheck(deps({ recollect: () => quarantined }));
    expect(verdict.ok).toBe(true);
    expect(verdict.reason).toBe(SyncCheckReason.OK);
    expect(verdict.detail).toContain("could NOT CONFIRM");
    expect(verdict.detail).not.toContain("clean re-collect");
  });

  it("a positively-clean re-collect DOES claim a clean re-collect", () => {
    const clean = report([0]);
    clean.conclusion = "clean";
    const verdict = evaluateSyncCheck(deps({ recollect: () => clean }));
    expect(verdict.ok).toBe(true);
    expect(verdict.detail).toContain("clean re-collect");
  });
});

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------

describe("runCli", () => {
  it("returns exit 0 and prints reason=ok on a passing verdict", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = runCli(cliDeps({}));
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(`reason=${SyncCheckReason.OK}`);
    logSpy.mockRestore();
  });

  it("returns a non-zero exit and prints the offending reason on a failing verdict", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = runCli(
      cliDeps({
        getChangedFiles: () => ["scripts/drift-success-predicate.ts"],
      }),
    );
    expect(code).toBe(REASON_EXIT_CODE[SyncCheckReason.OFF_ALLOWLIST_CHANGE]);
    expect(logSpy).toHaveBeenCalledWith(`reason=${SyncCheckReason.OFF_ALLOWLIST_CHANGE}`);
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("fails closed to CONFIG_ERROR when a dep throws (e.g. recollect couldn't produce a report)", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = runCli(
      cliDeps({
        recollect: () => {
          throw new SyncCheckConfigError("no report produced");
        },
      }),
    );
    expect(code).toBe(REASON_EXIT_CODE[SyncCheckReason.CONFIG_ERROR]);
    expect(logSpy).toHaveBeenCalledWith(`reason=${SyncCheckReason.CONFIG_ERROR}`);
    logSpy.mockRestore();
    errSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// The CLI's gate-3 skip — derived from the diff, the same rule drift-sync uses.
// ---------------------------------------------------------------------------

const REGISTRY_PATH = "src/__tests__/drift/model-registry.ts";
const REAL_REGISTRY = readFileSync(REGISTRY_PATH, "utf-8");

/** The 17 `deprecatedFamilies.openai` entries Fix Drift run 42286556743 committed. */
const RUN_42286556743_DEPRECATIONS = [
  "gpt-3.5-turbo",
  "gpt-4",
  "gpt-4-turbo",
  "gpt-4.1-nano",
  "gpt-5-chat-latest",
  "gpt-5-codex",
  "gpt-5.1-chat-latest",
  "gpt-5.1-codex",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5.2-chat-latest",
  "gpt-5.2-codex",
  "gpt-5.3-chat-latest",
  "o1",
  "o1-pro",
  "o3-mini",
  "o4-mini",
];

/** Apply edits through drift-sync's own writer, so the fixture is what the sync commits. */
function registryWith(
  edits: { set: "includeFamilies" | "excludeFamilies" | "deprecatedFamilies"; family: string }[],
): string {
  let text = REAL_REGISTRY;
  for (const { set, family } of edits) {
    const out = addFamilyLiteralInSource(text, set, "openai", family, "fixture");
    if (!out.changed) throw new Error(`fixture: could not add ${family} to ${set}.openai`);
    text = out.text;
  }
  return text;
}

const DEPRECATION_ONLY = registryWith(
  RUN_42286556743_DEPRECATIONS.map((family) => ({ set: "deprecatedFamilies", family })),
);

/** The residual that vetoed run 42286556743: a live leg unrelated to the edit. */
function liveFlakeReport(): DriftReport {
  const r = report([1]);
  r.conclusion = "critical";
  r.entries[0].provider = "OpenAI Live";
  r.entries[0].scenario = "managed lifecycle";
  r.entries[0].diffs[0].path = "Live:managed:modeContinuation";
  return r;
}

function skipFor(changedFiles: string[], after: string): string | null {
  return recollectSkipReason(
    changedFiles,
    () => REAL_REGISTRY,
    () => after,
  );
}

describe("deprecationOnlyOutcomes", () => {
  it("reads run 42286556743's 17 deprecations back out of the diff", () => {
    const outcomes = deprecationOnlyOutcomes(REAL_REGISTRY, DEPRECATION_ONLY);
    expect(outcomes?.map((o) => o.family)).toEqual(RUN_42286556743_DEPRECATIONS);
    expect(new Set(outcomes?.map((o) => o.action))).toEqual(new Set(["deprecation-recorded"]));
  });

  it("is null when the diff also adds to includeFamilies", () => {
    const after = registryWith([
      { set: "deprecatedFamilies", family: "gpt-4" },
      { set: "includeFamilies", family: "gpt-brand-new" },
    ]);
    expect(deprecationOnlyOutcomes(REAL_REGISTRY, after)).toBeNull();
  });

  it("is null when the diff removes a recorded deprecation", () => {
    const after = DEPRECATION_ONLY;
    expect(deprecationOnlyOutcomes(after, REAL_REGISTRY)).toBeNull();
  });
});

describe("recollectSkipReason — the CLI skips gate-3 exactly where drift-sync does", () => {
  it("SKIPS for a deprecation-only change to model-registry.ts, with drift-sync's own reason", () => {
    expect(skipFor([REGISTRY_PATH], DEPRECATION_ONLY)).toContain(
      "no live drift surface reads deprecatedFamilies",
    );
  });

  it("does NOT skip for an includeFamilies change (the unclassified canary observes it)", () => {
    const after = registryWith([{ set: "includeFamilies", family: "gpt-brand-new" }]);
    expect(skipFor([REGISTRY_PATH], after)).toBeNull();
  });

  it("does NOT skip for an excludeFamilies change", () => {
    const after = registryWith([{ set: "excludeFamilies", family: "gpt-brand-new" }]);
    expect(skipFor([REGISTRY_PATH], after)).toBeNull();
  });

  it("does NOT skip when any other file changed too", () => {
    expect(
      skipFor([REGISTRY_PATH, "src/__tests__/drift/logic-pin.test.ts"], DEPRECATION_ONLY),
    ).toBeNull();
    expect(skipFor([REGISTRY_PATH, "drift-proposals/openai-x.md"], DEPRECATION_ONLY)).toBeNull();
  });

  it("does NOT skip when nothing changed (and never reads the registry)", () => {
    const read = vi.fn(() => REAL_REGISTRY);
    expect(recollectSkipReason([], read, read)).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
});

describe("runCli — run 42286556743 (deprecation-only sync, unrelated live flake)", () => {
  it("GREEN: skips the live re-collect and passes on gates 1 + 2", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const recollectFn = vi.fn(liveFlakeReport);
    const runPinCheckFn = vi.fn(() => ({ ok: true, output: "" }));
    const code = runCli(
      cliDeps({
        getChangedFiles: () => [],
        runPinCheck: runPinCheckFn,
        recollect: recollectFn,
        recollectSkipReason: () => skipFor([REGISTRY_PATH], DEPRECATION_ONLY),
      }),
    );
    expect(recollectFn).not.toHaveBeenCalled();
    expect(runPinCheckFn).toHaveBeenCalledOnce();
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("live re-collect NOT RUN"));
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("an includeFamilies change still runs the live re-collect, and its critical still refuses", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const recollectFn = vi.fn(liveFlakeReport);
    const after = registryWith([
      { set: "deprecatedFamilies", family: "gpt-4" },
      { set: "includeFamilies", family: "gpt-brand-new" },
    ]);
    const code = runCli(
      cliDeps({
        recollect: recollectFn,
        recollectSkipReason: () => skipFor([REGISTRY_PATH], after),
      }),
    );
    expect(recollectFn).toHaveBeenCalledOnce();
    expect(code).toBe(REASON_EXIT_CODE[SyncCheckReason.RESIDUAL_CRITICAL_DRIFT]);
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("a bad --base is a CONFIG ERROR, not a silent full run or a silent skip", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const recollectFn = vi.fn(liveFlakeReport);
    const code = runCli(
      cliDeps({
        recollect: recollectFn,
        recollectSkipReason: () => {
          throw new SyncCheckConfigError("Could not diff against --base nope");
        },
      }),
    );
    expect(code).toBe(REASON_EXIT_CODE[SyncCheckReason.CONFIG_ERROR]);
    expect(recollectFn).not.toHaveBeenCalled();
    logSpy.mockRestore();
    errSpy.mockRestore();
  });
});

describe("parseCliArgs", () => {
  it("defaults the base to HEAD and accepts --base <rev>", () => {
    expect(parseCliArgs([])).toEqual({ base: "HEAD" });
    expect(parseCliArgs(["--base", "abc123"])).toEqual({ base: "abc123" });
  });

  it("rejects anything else", () => {
    expect(() => parseCliArgs(["--base"])).toThrow(SyncCheckConfigError);
    expect(() => parseCliArgs(["--skip"])).toThrow(SyncCheckConfigError);
  });
});
