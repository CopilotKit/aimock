import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// drift-sync.ts exports under test (C3: retargeted from the deleted
// scripts/fix-drift.ts — the LLM freewriter path, including buildPrompt and
// the predicate-gated CLI's parseMode, has been removed entirely).
// ---------------------------------------------------------------------------
import {
  readDriftReport,
  patchBumpVersion,
  addChangelogEntry,
  parsePorcelainLine,
  todayStamp,
} from "../../scripts/drift-sync.js";

import { summarizeDriftReport } from "../../scripts/drift-slack-summary.js";

import type { DriftEntry, DriftReport, QuarantineEntry } from "../../scripts/drift-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReport(overrides?: Partial<DriftReport>): DriftReport {
  return {
    timestamp: "2024-01-01T00:00:00.000Z",
    entries: [
      {
        provider: "OpenAI Chat",
        scenario: "non-streaming text",
        builderFile: "src/helpers.ts",
        builderFunctions: ["buildTextCompletion"],
        typesFile: "src/types.ts",
        sdkShapesFile: "src/__tests__/drift/sdk-shapes.ts",
        diffs: [
          {
            severity: "critical",
            issue: "LLMOCK DRIFT — field in SDK + real API but missing from mock",
            path: "choices[0].message.refusal",
            expected: "null",
            real: "null",
            mock: "<absent>",
          },
        ],
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// readDriftReport
// ---------------------------------------------------------------------------

describe("readDriftReport", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "drift-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("throws when file does not exist", () => {
    expect(() => readDriftReport(join(tmpDir, "nonexistent.json"))).toThrow(
      /Drift report not found/,
    );
  });

  it("throws when file contains invalid JSON", () => {
    const path = join(tmpDir, "bad.json");
    writeFileSync(path, "{ not valid json ]", "utf-8");
    expect(() => readDriftReport(path)).toThrow(/is not valid JSON/);
  });

  it("throws when top-level structure lacks entries array", () => {
    const path = join(tmpDir, "missing-entries.json");
    writeFileSync(path, JSON.stringify({ timestamp: "2024-01-01", foo: "bar" }), "utf-8");
    expect(() => readDriftReport(path)).toThrow(/invalid structure.*entries/);
  });

  it("throws when an entry is missing provider", () => {
    const path = join(tmpDir, "bad-entry.json");
    writeFileSync(
      path,
      JSON.stringify({
        timestamp: "2024-01-01T00:00:00Z",
        entries: [{ scenario: "x", diffs: [] }],
      }),
      "utf-8",
    );
    expect(() => readDriftReport(path)).toThrow(/missing required "provider"/);
  });

  it("throws when an entry has invalid severity", () => {
    const path = join(tmpDir, "bad-severity.json");
    const report = makeReport();
    report.entries[0].diffs[0].severity = "banana" as never;
    writeFileSync(path, JSON.stringify(report), "utf-8");
    expect(() => readDriftReport(path)).toThrow(/invalid severity "banana"/);
  });

  it("returns a valid report", () => {
    const path = join(tmpDir, "valid.json");
    const report = makeReport();
    writeFileSync(path, JSON.stringify(report), "utf-8");
    const result = readDriftReport(path);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].provider).toBe("OpenAI Chat");
  });
});

// ---------------------------------------------------------------------------
// patchBumpVersion
// ---------------------------------------------------------------------------

describe("patchBumpVersion", () => {
  let tmpDir: string;
  let origCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "drift-test-"));
    origCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("increments the patch version", () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ version: "1.2.3" }), "utf-8");
    const newVersion = patchBumpVersion();
    expect(newVersion).toBe("1.2.4");
  });

  it("writes the new version to package.json", () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ version: "2.0.0" }), "utf-8");
    patchBumpVersion();
    const pkg = JSON.parse(readFileSync(join(tmpDir, "package.json"), "utf-8")) as {
      version: string;
    };
    expect(pkg.version).toBe("2.0.1");
  });

  it("throws for non-semver version", () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ version: "bad" }), "utf-8");
    expect(() => patchBumpVersion()).toThrow(/Cannot patch-bump non-standard version/);
  });
});

// ---------------------------------------------------------------------------
// addChangelogEntry
// ---------------------------------------------------------------------------

describe("addChangelogEntry", () => {
  let tmpDir: string;
  let origCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "drift-test-"));
    origCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("inserts entry after title line in existing changelog", () => {
    const existing = "# @copilotkit/aimock\n\n## 1.0.0\n\nOld entry\n";
    writeFileSync(join(tmpDir, "CHANGELOG.md"), existing, "utf-8");
    addChangelogEntry(makeReport(), "1.2.4");
    const content = readFileSync(join(tmpDir, "CHANGELOG.md"), "utf-8");
    expect(content).toContain("## 1.2.4");
    expect(content.indexOf("## 1.2.4")).toBeLessThan(content.indexOf("## 1.0.0"));
  });

  it("creates entry even when changelog is missing", () => {
    addChangelogEntry(makeReport(), "1.0.1");
    const content = readFileSync(join(tmpDir, "CHANGELOG.md"), "utf-8");
    expect(content).toContain("## 1.0.1");
  });

  it("includes provider summaries", () => {
    writeFileSync(join(tmpDir, "CHANGELOG.md"), "# @copilotkit/aimock\n", "utf-8");
    addChangelogEntry(makeReport(), "1.2.4");
    const content = readFileSync(join(tmpDir, "CHANGELOG.md"), "utf-8");
    expect(content).toContain("OpenAI Chat (non-streaming text)");
    expect(content).toContain("choices[0].message.refusal");
  });
});

// ---------------------------------------------------------------------------
// parsePorcelainLine
// ---------------------------------------------------------------------------

describe("parsePorcelainLine", () => {
  it("parses a plain modified file", () => {
    expect(parsePorcelainLine(" M src/helpers.ts")).toBe("src/helpers.ts");
  });

  it("unquotes paths with special characters", () => {
    expect(parsePorcelainLine(' M "src/path with spaces.ts"')).toBe("src/path with spaces.ts");
  });

  it("handles rename notation by returning the new path", () => {
    expect(parsePorcelainLine(" R src/old.ts -> src/new.ts")).toBe("src/new.ts");
  });

  it("handles added files", () => {
    expect(parsePorcelainLine("?? src/new-file.ts")).toBe("src/new-file.ts");
  });
});

// ---------------------------------------------------------------------------
// todayStamp
// ---------------------------------------------------------------------------

describe("todayStamp", () => {
  it("returns an ISO date string", () => {
    expect(todayStamp()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ---------------------------------------------------------------------------
// summarizeDriftReport (Slack detail)
// ---------------------------------------------------------------------------

function makeEntry(overrides?: Partial<DriftEntry>): DriftEntry {
  return {
    provider: "OpenAI Chat",
    scenario: "non-streaming text",
    builderFile: "src/helpers.ts",
    builderFunctions: ["buildTextCompletion"],
    typesFile: "src/types.ts",
    sdkShapesFile: "src/__tests__/drift/sdk-shapes.ts",
    diffs: [
      {
        severity: "critical",
        issue: "field missing from mock",
        path: "choices[0].message.refusal",
        expected: "null",
        real: "null",
        mock: "<absent>",
      },
    ],
    ...overrides,
  };
}

describe("summarizeDriftReport", () => {
  it("returns an empty string when there are no entries", () => {
    expect(summarizeDriftReport({ timestamp: "t", entries: [] })).toBe("");
  });

  it("names the drifted provider, severity tally, and a changed path", () => {
    const summary = summarizeDriftReport({ timestamp: "t", entries: [makeEntry()] });
    expect(summary).toContain("*OpenAI Chat*");
    expect(summary).toContain("1 critical");
    expect(summary).toContain("`choices[0].message.refusal`");
    // The first line is now the classification header; bullet lines follow.
    const bulletLines = summary.split("\n").filter((l) => l.startsWith("•"));
    expect(bulletLines.length).toBeGreaterThan(0);
  });

  it("merges multiple entries for the same provider into one line with combined counts", () => {
    const summary = summarizeDriftReport({
      timestamp: "t",
      entries: [
        makeEntry(),
        makeEntry({
          scenario: "streaming text",
          diffs: [
            {
              severity: "warning",
              issue: "type changed",
              path: "choices[0].delta.role",
              expected: "string",
              real: "string",
              mock: "number",
            },
          ],
        }),
      ],
    });
    // One bullet line for the single provider
    expect(summary.split("\n").filter((l) => l.startsWith("• *OpenAI Chat*"))).toHaveLength(1);
    expect(summary).toContain("1 critical, 1 warning");
  });

  it("lists multiple providers on separate lines, critical-first", () => {
    const summary = summarizeDriftReport({
      timestamp: "t",
      entries: [
        makeEntry({
          provider: "Anthropic",
          diffs: [
            {
              severity: "warning",
              issue: "x",
              path: "content[0].type",
              expected: "a",
              real: "a",
              mock: "b",
            },
          ],
        }),
        makeEntry(), // OpenAI Chat with a critical
      ],
    });
    // First line is the classification header; provider bullets follow.
    const bulletLines = summary.split("\n").filter((l) => l.startsWith("•"));
    expect(bulletLines).toHaveLength(2);
    // Provider with a critical diff sorts before the warning-only provider
    expect(bulletLines[0]).toContain("*OpenAI Chat*");
    expect(bulletLines[1]).toContain("*Anthropic*");
  });

  it("caps example paths per provider and reports the remainder", () => {
    const manyPaths = Array.from({ length: 6 }, (_, i) => ({
      severity: "critical" as const,
      issue: "x",
      path: `field.${i}`,
      expected: "a",
      real: "a",
      mock: "b",
    }));
    const summary = summarizeDriftReport({
      timestamp: "t",
      entries: [makeEntry({ diffs: manyPaths })],
    });
    expect(summary).toContain("`field.0`");
    expect(summary).toContain("`field.2`");
    expect(summary).not.toContain("`field.3`");
    expect(summary).toContain("+3 more");
  });

  it("uses real newlines (not literal backslash-n) between providers", () => {
    const summary = summarizeDriftReport({
      timestamp: "t",
      entries: [makeEntry(), makeEntry({ provider: "Anthropic" })],
    });
    expect(summary).toContain("\n");
    expect(summary).not.toContain("\\n");
  });
});

// ---------------------------------------------------------------------------
// summarizeDriftReport — headline class + per-item detail (C5.2)
// ---------------------------------------------------------------------------

function makeQuarantineEntry(overrides?: Partial<QuarantineEntry>): QuarantineEntry {
  return {
    provider: "OpenAI Chat",
    testName: "OpenAI Chat > non-streaming text > response shape",
    rawLocation: "src/__tests__/drift/openai-chat.drift.ts:42",
    message: "Cannot read properties of undefined (reading 'choices')",
    ...overrides,
  };
}

describe("summarizeDriftReport — headline class", () => {
  it("class: real-drift — report has entries with critical diffs", () => {
    const report: DriftReport = {
      timestamp: "t",
      entries: [
        makeEntry({
          diffs: [
            {
              severity: "critical",
              issue: "field missing from mock",
              path: "choices[0].message.refusal",
              expected: "null",
              real: "null",
              mock: "<absent>",
            },
          ],
        }),
      ],
    };
    const summary = summarizeDriftReport(report);
    expect(summary).toContain("real-drift");
    // per-item: provider name present
    expect(summary).toContain("OpenAI Chat");
    // per-item: offending path or id
    expect(summary).toContain("choices[0].message.refusal");
    // per-item: one-line issue
    expect(summary).toContain("field missing from mock");
    // per-item: file reference (builderFile)
    expect(summary).toContain("src/helpers.ts");
  });

  it("class: quarantine — report has quarantine[] entries", () => {
    const report: DriftReport = {
      timestamp: "t",
      entries: [],
      quarantine: [makeQuarantineEntry()],
    };
    const summary = summarizeDriftReport(report);
    expect(summary).toContain("quarantine");
    // quarantine: provider
    expect(summary).toContain("OpenAI Chat");
    // quarantine: rawLocation (file:line)
    expect(summary).toContain("src/__tests__/drift/openai-chat.drift.ts:42");
    // quarantine: one-line message
    expect(summary).toContain("Cannot read properties of undefined");
  });

  it("class: stale-key — InfraError status 401", () => {
    const report: DriftReport = { timestamp: "t", entries: [] };
    const summary = summarizeDriftReport(report, { infraErrorStatus: 401 });
    expect(summary).toContain("stale-key");
  });

  it("class: stale-key — InfraError status 403", () => {
    const report: DriftReport = { timestamp: "t", entries: [] };
    const summary = summarizeDriftReport(report, { infraErrorStatus: 403 });
    expect(summary).toContain("stale-key");
  });

  it("class: infra-transient — InfraError status 429", () => {
    const report: DriftReport = { timestamp: "t", entries: [] };
    const summary = summarizeDriftReport(report, { infraErrorStatus: 429 });
    expect(summary).toContain("infra-transient");
  });

  it("class: infra-transient — InfraError status 503", () => {
    const report: DriftReport = { timestamp: "t", entries: [] };
    const summary = summarizeDriftReport(report, { infraErrorStatus: 503 });
    expect(summary).toContain("infra-transient");
  });

  it("class: test-infra-false-positive — exit 0, empty entries, no infraError", () => {
    const report: DriftReport = { timestamp: "t", entries: [] };
    const summary = summarizeDriftReport(report, { exitCode: 0 });
    expect(summary).toContain("test-infra-false-positive");
  });

  it("quarantine entries appear on their own distinct line with testName", () => {
    const report: DriftReport = {
      timestamp: "t",
      entries: [],
      quarantine: [
        makeQuarantineEntry({ provider: "Anthropic", testName: "Anthropic > streaming > shape" }),
      ],
    };
    const summary = summarizeDriftReport(report);
    const lines = summary.split("\n");
    const quarantineLine = lines.find((l) => l.includes("Anthropic"));
    expect(quarantineLine).toBeDefined();
    expect(quarantineLine).toContain("Anthropic > streaming > shape");
  });

  it("mixed: real-drift entries + quarantine both appear in summary", () => {
    const report: DriftReport = {
      timestamp: "t",
      entries: [makeEntry()],
      quarantine: [makeQuarantineEntry({ provider: "Gemini" })],
    };
    const summary = summarizeDriftReport(report);
    // Class is real-drift when entries have critical diffs (quarantine is secondary)
    expect(summary).toContain("real-drift");
    // Quarantine section still present
    expect(summary).toContain("Gemini");
    expect(summary).toContain("quarantine");
  });

  it("per-item id is used over path when present", () => {
    const report: DriftReport = {
      timestamp: "t",
      entries: [
        makeEntry({
          diffs: [
            {
              severity: "critical",
              issue: "model removed from mock",
              path: "knownModels",
              id: "gpt-4o-mini",
              expected: "present",
              real: "present",
              mock: "<absent>",
            },
          ],
        }),
      ],
    };
    const summary = summarizeDriftReport(report);
    expect(summary).toContain("gpt-4o-mini");
  });
});
