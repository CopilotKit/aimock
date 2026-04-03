import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// fix-drift.ts exports under test
// ---------------------------------------------------------------------------
import {
  readDriftReport,
  buildPrompt,
  buildPrBody,
  patchBumpVersion,
  addChangelogEntry,
  parsePorcelainLine,
  parseMode,
  todayStamp,
} from "../../scripts/fix-drift.js";

import type { DriftReport } from "../../scripts/drift-types.js";

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
// parseMode
// ---------------------------------------------------------------------------

describe("parseMode", () => {
  it("returns 'pr' for --create-pr", () => {
    expect(parseMode(["--create-pr"])).toBe("pr");
  });

  it("returns 'issue' for --create-issue", () => {
    expect(parseMode(["--create-issue"])).toBe("issue");
  });

  it("returns 'default' when no flag", () => {
    expect(parseMode([])).toBe("default");
    expect(parseMode(["--report", "foo.json"])).toBe("default");
  });

  it("prefers --create-pr over --create-issue when both present", () => {
    expect(parseMode(["--create-pr", "--create-issue"])).toBe("pr");
  });
});

// ---------------------------------------------------------------------------
// buildPrompt
// ---------------------------------------------------------------------------

describe("buildPrompt", () => {
  it("includes all drift entry details", () => {
    const report = makeReport();
    const prompt = buildPrompt(report);
    expect(prompt).toContain("DRIFT 1: OpenAI Chat — non-streaming text");
    expect(prompt).toContain("File: src/helpers.ts");
    expect(prompt).toContain("Functions: buildTextCompletion");
    expect(prompt).toContain("[critical] LLMOCK DRIFT");
    expect(prompt).toContain("Path: choices[0].message.refusal");
  });

  it("includes workflow instructions", () => {
    const prompt = buildPrompt(makeReport());
    expect(prompt).toContain("RED:");
    expect(prompt).toContain("GREEN:");
    expect(prompt).toContain("pnpm test");
    expect(prompt).toContain("pnpm test:drift");
  });

  it("numbers multiple drift entries", () => {
    const report = makeReport({
      entries: [
        { ...makeReport().entries[0], provider: "OpenAI Chat", scenario: "streaming" },
        {
          ...makeReport().entries[0],
          provider: "Anthropic",
          scenario: "non-streaming text",
          builderFile: "src/messages.ts",
          builderFunctions: ["buildClaudeTextResponse"],
          typesFile: null,
        },
      ],
    });
    const prompt = buildPrompt(report);
    expect(prompt).toContain("DRIFT 1:");
    expect(prompt).toContain("DRIFT 2:");
  });
});

// ---------------------------------------------------------------------------
// buildPrBody
// ---------------------------------------------------------------------------

describe("buildPrBody", () => {
  it("includes provider info", () => {
    const body = buildPrBody(makeReport());
    expect(body).toContain("OpenAI Chat: non-streaming text");
  });

  it("includes diff paths", () => {
    const body = buildPrBody(makeReport());
    expect(body).toContain("`choices[0].message.refusal`");
  });

  it("embeds the full drift report JSON", () => {
    const report = makeReport();
    const body = buildPrBody(report);
    expect(body).toContain('"OpenAI Chat"');
    expect(body).toContain("```json");
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
