/**
 * FIX #F5 (round-4) — createPr's STRAGGLER fail-closed guard, in isolation.
 *
 * On a RESOLVED verdict every changed file MUST fall into a gated commit group
 * (production builder, report-named fixture target, or skills/). A "straggler"
 * (a changed file in none of those groups) means the predicate verdict and the
 * staging partition have DIVERGED — staging would silently drop it and ship an
 * incomplete fix behind a green verdict. createPr must exit UNSANCTIONED_CHANGE
 * and stage NOTHING.
 *
 * By construction with the CURRENT predicate + gatedCommitFiles there is no file
 * that both PASSES the predicate and becomes a straggler (the allowlist blocks
 * everything gatedCommitFiles would not classify). This guard is therefore
 * defense-in-depth against a FUTURE predicate change. To lock it load-bearingly
 * we mock `evaluateDriftResolved` to force a RESOLVED verdict while git reports a
 * straggler in the working tree, then assert createPr fail-closes before any
 * `git add`. This is a pure-function/mock test — it never runs the autofix
 * subprocess.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { DriftReport } from "../../scripts/drift-types.js";

// Mock git so gitChangedFiles()/exec() are controllable, and force the predicate
// to RESOLVED so the straggler guard (which runs AFTER the verdict) is reached.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, readFileSync: vi.fn(actual.readFileSync), writeFileSync: vi.fn() };
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFileSync: vi.fn(), execSync: vi.fn() };
});

vi.mock("../../scripts/drift-success-predicate.js", async () => {
  const actual = await vi.importActual<typeof import("../../scripts/drift-success-predicate.js")>(
    "../../scripts/drift-success-predicate.js",
  );
  return {
    ...actual,
    // Force RESOLVED regardless of inputs so the guard downstream is exercised.
    evaluateDriftResolved: vi.fn(() => ({
      resolved: true,
      reason: actual.PredicateReason.RESOLVED,
      detail: "forced resolved for the straggler-guard test",
      offendingFiles: [],
    })),
    // gitChangedFiles is used by createPr — return a production file PLUS a
    // straggler (a root file gatedCommitFiles cannot classify).
    gitChangedFiles: vi.fn(() => ["src/helpers.ts", "weird-root-file.txt"]),
  };
});

import { execSync, execFileSync } from "node:child_process";

import { createPr } from "../../scripts/fix-drift.js";

const mockedExecSync = vi.mocked(execSync);
const mockedExecFileSync = vi.mocked(execFileSync);

describe("createPr straggler guard fail-closed (fix #F5, isolated)", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit__${code}`);
    }) as never);
    // Default git calls return empty (branch lookups etc.).
    mockedExecSync.mockReturnValue("fix/drift-2026-07-16\n" as unknown as string);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  const rep: DriftReport = {
    timestamp: "2026-07-16T00:00:00.000Z",
    entries: [
      {
        provider: "OpenAI",
        scenario: "chat completion",
        builderFile: "src/helpers.ts",
        builderFunctions: ["buildChatCompletion"],
        typesFile: null,
        sdkShapesFile: "src/__tests__/drift/sdk-shapes.ts",
        diffs: [
          {
            path: "x",
            severity: "critical",
            issue: "missing",
            expected: "string",
            real: "string",
            mock: "<missing>",
          },
        ],
      },
    ],
  };

  it("exits UNSANCTIONED_CHANGE (17) and NEVER stages the straggler even on a RESOLVED verdict", () => {
    expect(() => createPr(rep, { report: { timestamp: "t", entries: [] }, exitCode: 0 })).toThrow(
      /__exit__17/,
    );

    const staged = mockedExecFileSync.mock.calls.some(
      (c) =>
        c[0] === "git" && Array.isArray(c[1]) && (c[1] as string[]).includes("weird-root-file.txt"),
    );
    expect(staged).toBe(false);

    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    expect(lines).toContain("reason=unsanctioned-change");
  });
});
