/**
 * C3 (delete-freewriter-predicate-rewire) — retargeted from `scripts/fix-drift.js`
 * to `scripts/drift-sync.js`.
 *
 * `scripts/fix-drift.ts` (the LLM freewriter invocation + its predicate-gated
 * `createPr`/`createIssue`) and `scripts/drift-success-predicate.ts` (the
 * 916-line anti-cheat predicate) have been DELETED entirely — there is no
 * arbitrary/free-form code generation left in the drift-remediation pipeline to
 * police. The reusable git/branch/commit/PR plumbing C1 originally moved into
 * `drift-sync.ts` (and `fix-drift.ts` re-exported) now lives ONLY in
 * `drift-sync.ts`, so this suite imports from there directly.
 *
 * Dropped in this retarget (no surviving equivalent):
 *   - `buildPrompt`, `invokeClaudeCode`, `killProcessGroup`, `scheduleEscalatingKill`
 *     — the deleted LLM freewriter path.
 *   - `parseMode`, `hasPostFixArgs`, `parsePostFixExit`, `createPr`, `createIssue`,
 *     `PostFixCollectorResult` — the deleted predicate-gated CLI (`fix-drift.ts`'s
 *     own `main()`/`--create-pr`/`--create-issue` modes). The deterministic
 *     model-sync path (`runDriftSyncCli` in drift-sync.ts) commits its own
 *     mechanical edits directly; there is no freeform diff left to gate behind a
 *     verdict, so `sanctionedTargets`/`evaluateDriftResolved`-shaped tests do not
 *     carry over.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolve } from "node:path";

import type {
  DriftReport,
  DriftEntry,
  DriftSeverity,
  ParsedDiff,
} from "../../scripts/drift-types.js";

// We mock fs and child_process before importing the module under test
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    writeFileSync: vi.fn(),
    existsSync: vi.fn(actual.existsSync),
  };
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: vi.fn(),
    execSync: vi.fn(),
  };
});

import {
  todayStamp,
  readDriftReport,
  patchBumpVersion,
  addChangelogEntry,
  parsePorcelainLine,
  readFileIfExists,
  execFileSafe,
  getChangedFiles,
} from "../../scripts/drift-sync.js";

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync, execSync } from "node:child_process";

const mockedReadFileSync = vi.mocked(readFileSync);
const mockedWriteFileSync = vi.mocked(writeFileSync);
const mockedExistsSync = vi.mocked(existsSync);
const mockedExecFileSync = vi.mocked(execFileSync);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDiff(overrides: Partial<ParsedDiff> = {}): ParsedDiff {
  return {
    path: "response.choices[0].message.content",
    severity: "warning",
    issue: "missing field",
    expected: "string",
    real: '"hello"',
    mock: "undefined",
    ...overrides,
  };
}

function makeEntry(overrides: Partial<DriftEntry> = {}): DriftEntry {
  return {
    provider: "openai",
    scenario: "non-streaming text",
    builderFile: "src/builders/openai.ts",
    builderFunctions: ["buildTextResponse"],
    typesFile: "src/types.ts",
    sdkShapesFile: "src/__tests__/drift/sdk-shapes.ts",
    diffs: [makeDiff()],
    ...overrides,
  };
}

function makeReport(overrides: Partial<DriftReport> = {}): DriftReport {
  return {
    timestamp: "2026-03-19T00:00:00.000Z",
    entries: [makeEntry()],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// todayStamp
// ---------------------------------------------------------------------------

describe("todayStamp", () => {
  it("returns a YYYY-MM-DD formatted string", () => {
    const result = todayStamp();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("matches today's date", () => {
    const expected = new Date().toISOString().slice(0, 10);
    expect(todayStamp()).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// readDriftReport
// ---------------------------------------------------------------------------

describe("readDriftReport", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("parses a valid report", () => {
    const report = makeReport();
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify(report));

    const result = readDriftReport("/tmp/report.json");
    expect(result).toEqual(report);
  });

  it("throws when file does not exist", () => {
    mockedExistsSync.mockReturnValue(false);
    expect(() => readDriftReport("/tmp/missing.json")).toThrow("Drift report not found");
  });

  it("throws on invalid JSON", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue("not json {{{");
    expect(() => readDriftReport("/tmp/bad.json")).toThrow("not valid JSON");
  });

  it("throws when entries array is missing", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify({ timestamp: "2026-01-01" }));
    expect(() => readDriftReport("/tmp/no-entries.json")).toThrow("invalid structure");
  });

  it("throws when entries is not an array", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify({ entries: "not-an-array" }));
    expect(() => readDriftReport("/tmp/bad-entries.json")).toThrow("invalid structure");
  });

  it("throws when timestamp is missing", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify({ entries: [] }));
    expect(() => readDriftReport("/tmp/no-timestamp.json")).toThrow('missing "timestamp"');
  });

  it("throws when timestamp is not a string", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify({ entries: [], timestamp: 12345 }));
    expect(() => readDriftReport("/tmp/bad-timestamp.json")).toThrow('missing "timestamp"');
  });

  it("throws when entry is missing provider", () => {
    const report = makeReport();
    (report.entries[0] as Record<string, unknown>).provider = "";
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify(report));

    expect(() => readDriftReport("/tmp/no-provider.json")).toThrow(
      'entry[0] missing required "provider"',
    );
  });

  it("throws when entry has no diffs array", () => {
    const report = makeReport();
    (report.entries[0] as Record<string, unknown>).diffs = "not-array";
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify(report));

    expect(() => readDriftReport("/tmp/no-diffs.json")).toThrow('missing "diffs" array');
  });

  it("throws when a diff has invalid severity", () => {
    const report = makeReport({
      entries: [
        makeEntry({
          diffs: [makeDiff({ severity: "extreme" as DriftSeverity })],
        }),
      ],
    });
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify(report));

    expect(() => readDriftReport("/tmp/bad-severity.json")).toThrow('invalid severity "extreme"');
  });

  it("throws when entry is missing builderFile", () => {
    const report = makeReport();
    (report.entries[0] as Record<string, unknown>).builderFile = "";
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify(report));

    expect(() => readDriftReport("/tmp/no-builder.json")).toThrow('missing "builderFile"');
  });

  it("throws when entry has empty builderFunctions", () => {
    const report = makeReport();
    report.entries[0].builderFunctions = [];
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify(report));

    expect(() => readDriftReport("/tmp/empty-funcs.json")).toThrow(
      '"builderFunctions" must be non-empty string array',
    );
  });

  it("throws when builderFunctions contains non-string elements", () => {
    const report = makeReport();
    (report.entries[0] as Record<string, unknown>).builderFunctions = ["valid", 42];
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify(report));

    expect(() => readDriftReport("/tmp/bad-funcs.json")).toThrow(
      '"builderFunctions" must be non-empty string array',
    );
  });

  it("throws when entry is missing scenario", () => {
    const report = makeReport();
    (report.entries[0] as Record<string, unknown>).scenario = 123;
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify(report));

    expect(() => readDriftReport("/tmp/no-scenario.json")).toThrow('missing "scenario"');
  });

  it("throws when entry is missing sdkShapesFile", () => {
    const report = makeReport();
    (report.entries[0] as Record<string, unknown>).sdkShapesFile = "";
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify(report));

    expect(() => readDriftReport("/tmp/no-shapes.json")).toThrow('missing "sdkShapesFile"');
  });

  it("throws when typesFile is not a string or null", () => {
    const report = makeReport();
    (report.entries[0] as Record<string, unknown>).typesFile = 42;
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify(report));

    expect(() => readDriftReport("/tmp/bad-types.json")).toThrow(
      '"typesFile" must be string or null',
    );
  });

  it("accepts typesFile as null", () => {
    const report = makeReport({ entries: [makeEntry({ typesFile: null })] });
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify(report));

    expect(() => readDriftReport("/tmp/null-types.json")).not.toThrow();
  });

  it("throws when a diff is missing path", () => {
    const report = makeReport({
      entries: [makeEntry({ diffs: [makeDiff({ path: "" })] })],
    });
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify(report));

    expect(() => readDriftReport("/tmp/no-path.json")).toThrow('missing "path"');
  });

  it("throws when a diff is missing issue", () => {
    const report = makeReport({
      entries: [makeEntry({ diffs: [makeDiff({ issue: "" })] })],
    });
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify(report));

    expect(() => readDriftReport("/tmp/no-issue.json")).toThrow('missing "issue"');
  });

  it("throws when a diff is missing expected", () => {
    const report = makeReport({
      entries: [makeEntry({ diffs: [makeDiff({ expected: undefined as unknown as string })] })],
    });
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify(report));

    expect(() => readDriftReport("/tmp/no-expected.json")).toThrow('missing "expected"');
  });

  it("throws when a diff is missing real", () => {
    const report = makeReport({
      entries: [makeEntry({ diffs: [makeDiff({ real: undefined as unknown as string })] })],
    });
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify(report));

    expect(() => readDriftReport("/tmp/no-real.json")).toThrow('missing "real"');
  });

  it("throws when a diff is missing mock", () => {
    const report = makeReport({
      entries: [makeEntry({ diffs: [makeDiff({ mock: undefined as unknown as string })] })],
    });
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify(report));

    expect(() => readDriftReport("/tmp/no-mock.json")).toThrow('missing "mock"');
  });

  it("accepts all valid severities", () => {
    for (const severity of ["critical", "warning", "info"] as const) {
      const report = makeReport({
        entries: [makeEntry({ diffs: [makeDiff({ severity })] })],
      });
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(JSON.stringify(report));

      expect(() => readDriftReport("/tmp/ok.json")).not.toThrow();
    }
  });

  it("validates all entries, not just the first", () => {
    const report = makeReport({
      entries: [makeEntry({ provider: "openai" }), makeEntry({ provider: "" })],
    });
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify(report));

    expect(() => readDriftReport("/tmp/second-bad.json")).toThrow(
      'entry[1] missing required "provider"',
    );
  });
});

// ---------------------------------------------------------------------------
// patchBumpVersion
// ---------------------------------------------------------------------------

describe("patchBumpVersion", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('bumps patch version from "1.2.3" to "1.2.4"', () => {
    const pkg = { name: "@copilotkit/aimock", version: "1.2.3" };
    mockedReadFileSync.mockReturnValue(JSON.stringify(pkg));
    mockedWriteFileSync.mockImplementation(() => {});

    const result = patchBumpVersion();

    expect(result).toBe("1.2.4");
    expect(mockedWriteFileSync).toHaveBeenCalledOnce();
    const written = vi.mocked(writeFileSync).mock.calls[0][1] as string;
    expect(JSON.parse(written.trim()).version).toBe("1.2.4");
  });

  it('bumps "0.0.0" to "0.0.1"', () => {
    const pkg = { version: "0.0.0" };
    mockedReadFileSync.mockReturnValue(JSON.stringify(pkg));
    mockedWriteFileSync.mockImplementation(() => {});

    expect(patchBumpVersion()).toBe("0.0.1");
  });

  it("throws on non-standard version string", () => {
    const pkg = { version: "1.2.3-beta.1" };
    mockedReadFileSync.mockReturnValue(JSON.stringify(pkg));

    expect(() => patchBumpVersion()).toThrow("non-standard version");
  });

  it("throws on version with wrong number of parts", () => {
    const pkg = { version: "1.2" };
    mockedReadFileSync.mockReturnValue(JSON.stringify(pkg));

    expect(() => patchBumpVersion()).toThrow("non-standard version");
  });

  it("writes to the correct path (resolve('package.json'))", () => {
    const pkg = { version: "1.0.0" };
    mockedReadFileSync.mockReturnValue(JSON.stringify(pkg));
    mockedWriteFileSync.mockImplementation(() => {});

    patchBumpVersion();

    const writtenPath = vi.mocked(writeFileSync).mock.calls[0][0] as string;
    expect(writtenPath).toBe(resolve("package.json"));
  });

  it("preserves other fields in package.json", () => {
    const pkg = { name: "test-pkg", version: "2.0.0", license: "MIT" };
    mockedReadFileSync.mockReturnValue(JSON.stringify(pkg));
    mockedWriteFileSync.mockImplementation(() => {});

    patchBumpVersion();

    const written = JSON.parse((vi.mocked(writeFileSync).mock.calls[0][1] as string).trim());
    expect(written.name).toBe("test-pkg");
    expect(written.license).toBe("MIT");
  });
});

// ---------------------------------------------------------------------------
// addChangelogEntry
// ---------------------------------------------------------------------------

describe("addChangelogEntry", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("inserts entry after title line when changelog has title", () => {
    const existing = "# @copilotkit/aimock\n\n## 1.0.0\n\nOld entry\n";
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(existing);
    mockedWriteFileSync.mockImplementation(() => {});

    const report = makeReport();
    addChangelogEntry(report, "1.0.1");

    expect(mockedWriteFileSync).toHaveBeenCalledOnce();
    const written = vi.mocked(writeFileSync).mock.calls[0][1] as string;

    // Title is preserved at the top
    expect(written.startsWith("# @copilotkit/aimock\n")).toBe(true);
    // New version entry comes before old
    expect(written.indexOf("## 1.0.1")).toBeLessThan(written.indexOf("## 1.0.0"));
    // Contains patch changes section
    expect(written).toContain("### Patch Changes");
    expect(written).toContain("Auto-remediate API drift");
    // Contains provider summary
    expect(written).toContain("openai (non-streaming text)");
  });

  it("prepends entry when changelog has no title", () => {
    const existing = "## 1.0.0\n\nOld stuff\n";
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(existing);
    mockedWriteFileSync.mockImplementation(() => {});

    addChangelogEntry(makeReport(), "1.0.1");

    const written = vi.mocked(writeFileSync).mock.calls[0][1] as string;
    expect(written.startsWith("## 1.0.1")).toBe(true);
    expect(written).toContain("## 1.0.0");
  });

  it("handles empty/missing changelog", () => {
    mockedExistsSync.mockReturnValue(false);
    mockedReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    mockedWriteFileSync.mockImplementation(() => {});

    // readFileIfExists returns null when !existsSync, so it won't call readFileSync
    addChangelogEntry(makeReport(), "0.0.1");

    const written = vi.mocked(writeFileSync).mock.calls[0][1] as string;
    expect(written).toContain("## 0.0.1");
    expect(written).toContain("### Patch Changes");
  });

  it("includes diff paths in provider summary", () => {
    const report = makeReport({
      entries: [
        makeEntry({
          diffs: [makeDiff({ path: "a.b" }), makeDiff({ path: "c.d" })],
        }),
      ],
    });
    mockedExistsSync.mockReturnValue(false);
    mockedWriteFileSync.mockImplementation(() => {});

    addChangelogEntry(report, "1.0.0");

    const written = vi.mocked(writeFileSync).mock.calls[0][1] as string;
    expect(written).toContain("a.b, c.d");
  });
});

// ---------------------------------------------------------------------------
// parsePorcelainLine
// ---------------------------------------------------------------------------

describe("parsePorcelainLine", () => {
  it("parses a normal modified file", () => {
    expect(parsePorcelainLine(" M src/foo.ts")).toBe("src/foo.ts");
  });

  it("parses an added file", () => {
    expect(parsePorcelainLine("A  src/new.ts")).toBe("src/new.ts");
  });

  it("parses an untracked file", () => {
    expect(parsePorcelainLine("?? src/unknown.ts")).toBe("src/unknown.ts");
  });

  it("handles quoted paths", () => {
    expect(parsePorcelainLine(' M "src/special chars.ts"')).toBe("src/special chars.ts");
  });

  it("handles rename notation, returning the new path", () => {
    expect(parsePorcelainLine("R  old.ts -> new.ts")).toBe("new.ts");
  });

  it("handles rename with quoted paths", () => {
    expect(parsePorcelainLine('R  "old name.ts" -> "new name.ts"')).toBe("new name.ts");
  });

  it("handles paths with leading/trailing whitespace in the path portion", () => {
    // The trim() in parsePorcelainLine handles extra whitespace
    expect(parsePorcelainLine("MM src/bar.ts  ")).toBe("src/bar.ts");
  });
});

// ---------------------------------------------------------------------------
// readFileIfExists
// ---------------------------------------------------------------------------

describe("readFileIfExists", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns file content when file exists", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue("file content here");

    expect(readFileIfExists("/tmp/exists.txt")).toBe("file content here");
  });

  it("returns null when file does not exist", () => {
    mockedExistsSync.mockReturnValue(false);

    expect(readFileIfExists("/tmp/missing.txt")).toBeNull();
    expect(mockedReadFileSync).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// execFileSafe
// ---------------------------------------------------------------------------

describe("execFileSafe", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("calls execFileSync with the correct arguments", () => {
    mockedExecFileSync.mockReturnValue(Buffer.from(""));

    execFileSafe("git", ["status"]);

    expect(mockedExecFileSync).toHaveBeenCalledWith("git", ["status"], { stdio: "inherit" });
  });

  it("throws a formatted error on failure", () => {
    const err = Object.assign(new Error("fail"), { status: 128, stderr: "fatal: not a repo" });
    mockedExecFileSync.mockImplementation(() => {
      throw err;
    });

    expect(() => execFileSafe("git", ["status"])).toThrow("Command failed: git status");
  });
});

// ---------------------------------------------------------------------------
// getChangedFiles
// ---------------------------------------------------------------------------

describe("getChangedFiles", () => {
  const mockedExecSync = vi.mocked(execSync);

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns parsed file paths from git status output", () => {
    // Note: exec() trims the result, so we use staged-file format (M  not  M)
    // which doesn't have a leading space that trim would strip
    mockedExecSync.mockReturnValue("M  src/helpers.ts\nM  src/server.ts");
    const result = getChangedFiles();
    expect(result).toEqual(["src/helpers.ts", "src/server.ts"]);
  });

  it("returns empty array for empty git status", () => {
    mockedExecSync.mockReturnValue("");
    const result = getChangedFiles();
    expect(result).toEqual([]);
  });

  it("handles renamed files", () => {
    mockedExecSync.mockReturnValue("R  old.ts -> new.ts\n M src/foo.ts\n");
    const result = getChangedFiles();
    expect(result).toEqual(["new.ts", "src/foo.ts"]);
  });
});
