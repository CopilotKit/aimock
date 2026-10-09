import { describe, it, expect, vi, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FEATURE_RULES,
  MATRIX_ROWLESS_RULES,
  isRowlessRule,
  formatSummary,
  writeMatrixUpdate,
  type DetectedChange,
  type FetchFailure,
  type MigrationManualCheck,
  type MigrationPageChange,
  type RowlessDetection,
} from "../../scripts/update-competitive-matrix.js";
import type { FeatureWatchResult, WatchSourceReport } from "../../scripts/competitive-watch.js";

// These tests call the exported formatSummary from the script, so a change to
// the real summary output fails them. They check the sections and their rows;
// the "formatSummary headline" block also checks the exact headline sentences.

const APPLIED_HEADING = "## Competitive Matrix Changes";
const MIGRATION_HEADING = "## Migration Page Changes";
const ROWLESS_HEADING = "## Row-Less Detections (Manual Follow-Up)";

/** Labels of rules that have a homepage row (the only labels a scan can apply). */
const ROW_LABELS = FEATURE_RULES.map((r) => r.rowLabel).filter((label) => !isRowlessRule(label));
/** Labels of rules that have no homepage row. */
const ROWLESS_LABELS = Object.keys(MATRIX_ROWLESS_RULES);

/** Returns the "## " headings of the markdown, in order. */
function headings(md: string): string[] {
  return md.split("\n").filter((line) => line.startsWith("## "));
}

/** Returns the lines from a heading up to the next heading (or the end). */
function section(md: string, heading: string): string[] {
  const lines = md.split("\n");
  const start = lines.indexOf(heading);
  if (start === -1) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return end === -1 ? rest : rest.slice(0, end);
}

/** Returns the table data rows of a section (no header or separator rows). */
function dataRows(lines: string[]): string[] {
  const rows = lines.filter((line) => line.startsWith("| ") && !line.startsWith("| ---"));
  return rows.slice(1);
}

const APPLIED: DetectedChange[] = [
  { competitor: "VidaiMock", capability: "Chat Completions SSE", from: "No", to: "Yes" },
  { competitor: "VidaiMock", capability: "Embeddings API", from: "No", to: "Yes" },
  { competitor: "mock-llm", capability: "Error injection", from: "No", to: "Yes" },
];

const MIGRATION: MigrationPageChange[] = [
  { page: "docs/migrate-from-vidaimock/index.html", change: "Embeddings API: No -> Yes" },
];

const ROWLESS: RowlessDetection[] = [
  { competitor: "mock-llm", capability: "Helm chart", migrationPage: '"Kubernetes / Helm" ✗ -> ✓' },
  { competitor: "VidaiMock", capability: "CLI server", migrationPage: "no row" },
];

describe("competitive-matrix summary fixtures", () => {
  it("use real rule labels", () => {
    for (const ch of APPLIED) expect(ROW_LABELS).toContain(ch.capability);
    for (const r of ROWLESS) expect(ROWLESS_LABELS).toContain(r.capability);
  });
});

describe("formatSummary", () => {
  // ── Nothing to report ─────────────────────────────────────────────────

  it("emits a single headline and no sections when nothing changed", () => {
    const md = formatSummary([]);
    expect(md.trim()).not.toBe("");
    expect(md.trim().split("\n")).toHaveLength(1);
    expect(headings(md)).toEqual([]);
    expect(md).not.toContain("|");
  });

  // ── Applied changes ───────────────────────────────────────────────────

  it("lists applied changes in a table, in order", () => {
    const md = formatSummary(APPLIED);
    expect(headings(md)).toEqual([APPLIED_HEADING]);

    const lines = section(md, APPLIED_HEADING);
    expect(lines).toContain("| Competitor | Capability | Change |");
    expect(dataRows(lines)).toEqual(
      APPLIED.map((ch) => `| ${ch.competitor} | ${ch.capability} | ${ch.from} -> ${ch.to} |`),
    );
  });

  it("draws a mermaid flowchart grouped by competitor", () => {
    const md = formatSummary(APPLIED);

    expect(md).toContain("```mermaid\nflowchart LR");
    expect((md.match(/```/g) || []).length).toBe(2);

    expect(md).toContain('subgraph VidaiMock["VidaiMock"]');
    expect(md).toContain('subgraph mock-llm["mock-llm"]');
    const subgraphCount = (md.match(/subgraph /g) || []).length;
    expect(subgraphCount).toBe(2);
    expect((md.match(/^\s+end$/gm) || []).length).toBe(subgraphCount);

    expect(md).toContain('n0["Chat Completions SSE"]');
    expect(md).toContain('n1["Embeddings API"]');
    expect(md).toContain('n2["Error injection"]');
  });

  it("gives every mermaid node a unique ID", () => {
    const md = formatSummary(APPLIED);
    const ids = [...md.matchAll(/^\s{4}(n\d+)\[/gm)].map((m) => m[1]);
    expect(ids).toHaveLength(APPLIED.length);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("sanitizes mermaid subgraph IDs and quotes labels", () => {
    const md = formatSummary([
      {
        competitor: "piyook/llm-mock",
        capability: "Structured output / JSON mode",
        from: "No",
        to: "Yes",
      },
    ]);
    expect(md).toContain('subgraph piyook_llm-mock["piyook/llm-mock"]');
    expect(md).toContain('n0["Structured output / JSON mode"]');
  });

  it("escapes double quotes in mermaid labels", () => {
    const md = formatSummary([
      { competitor: 'Comp "X"', capability: 'JSON "mode"', from: "No", to: "Yes" },
    ]);
    expect(md).toContain('["Comp &quot;X&quot;"]');
    expect(md).toContain('n0["JSON &quot;mode&quot;"]');
  });

  // ── Migration page changes ────────────────────────────────────────────

  it("lists migration page changes after the homepage table", () => {
    const md = formatSummary(APPLIED, MIGRATION);
    expect(headings(md)).toEqual([APPLIED_HEADING, MIGRATION_HEADING]);

    const lines = section(md, MIGRATION_HEADING);
    for (const mc of MIGRATION) expect(lines).toContain(`- \`${mc.page}\`: ${mc.change}`);
  });

  it("emits only the migration section when only migration pages changed", () => {
    const md = formatSummary([], MIGRATION);
    expect(headings(md)).toEqual([MIGRATION_HEADING]);
    expect(md).not.toContain("```mermaid");
  });

  // ── Row-less detections ───────────────────────────────────────────────

  it("lists row-less detections last", () => {
    const md = formatSummary(APPLIED, MIGRATION, ROWLESS);
    expect(headings(md)).toEqual([APPLIED_HEADING, MIGRATION_HEADING, ROWLESS_HEADING]);

    const lines = section(md, ROWLESS_HEADING);
    expect(lines).toContain("| Competitor | Capability | Migration page |");
    expect(dataRows(lines)).toEqual(
      ROWLESS.map((r) => `| ${r.competitor} | ${r.capability} | ${r.migrationPage} |`),
    );

    // Row-less detections never appear in the applied table
    const applied = section(md, APPLIED_HEADING).join("\n");
    for (const r of ROWLESS) expect(applied).not.toContain(r.capability);
  });

  it("reports row-less detections even when nothing else changed", () => {
    const md = formatSummary([], [], ROWLESS);
    expect(headings(md)).toEqual([ROWLESS_HEADING]);
    expect(dataRows(section(md, ROWLESS_HEADING))).toHaveLength(ROWLESS.length);
  });
});

describe("no summary reports unplaced changes", () => {
  // writeMatrixUpdate is the only caller of formatSummary (through
  // writeSummary). It throws before any summary is written when a computed
  // change cannot be placed, so the run's error, not the summary, reports
  // unplaced changes.
  const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const HOMEPAGE = readFileSync(resolve(REPO_ROOT, "docs/index.html"), "utf-8");
  const UNPLACEABLE: DetectedChange[] = [
    { competitor: "Unknown", capability: "Request journal", from: "No", to: "Yes" },
    { competitor: "mock-llm", capability: "No such row", from: "No", to: "Yes" },
  ];

  let dir: string | undefined;
  afterEach(() => {
    vi.restoreAllMocks();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  for (const dryRun of [false, true]) {
    it(`throws and writes no summary when no change can be placed (dryRun: ${dryRun})`, () => {
      dir = mkdtempSync(join(tmpdir(), "aimock-cm-summary-"));
      const docsPath = join(dir, "index.html");
      const summaryPath = join(dir, "summary.md");
      writeFileSync(docsPath, HOMEPAGE, "utf-8");
      vi.spyOn(console, "log").mockImplementation(() => {});

      expect(() =>
        writeMatrixUpdate({
          html: HOMEPAGE,
          changes: UNPLACEABLE,
          docsPath,
          summaryPath,
          dryRun,
          rowless: [{ competitor: "mock-llm", capability: "Helm chart", migrationPage: "no row" }],
        }),
      ).toThrow(/2 of 2 computed change\(s\) could not be placed/);
      expect(existsSync(summaryPath)).toBe(false);
      expect(readFileSync(docsPath, "utf-8")).toBe(HOMEPAGE);
    });
  }
});

describe("formatSummary headline", () => {
  // The headline is the first line a reader sees. It must not say that
  // nothing was detected when a section below needs attention.
  const NO_CHANGES = "No competitive matrix changes detected this week.";
  const firstLine = (md: string): string => md.split("\n")[0];

  it("row-less-only input does not claim that nothing was detected", () => {
    const md = formatSummary([], [], ROWLESS);

    expect(md).not.toContain(NO_CHANGES);
    expect(firstLine(md)).toBe(
      "No homepage competitive matrix changes this week. Detections below need a manual check.",
    );
    expect(dataRows(section(md, ROWLESS_HEADING))).toHaveLength(ROWLESS.length);
  });

  it("migration-only input headlines no homepage change, not no change", () => {
    const md = formatSummary([], MIGRATION, []);

    expect(md).not.toContain(NO_CHANGES);
    expect(firstLine(md)).toBe("No homepage competitive matrix changes this week.");
    expect(headings(md)).toEqual([MIGRATION_HEADING]);
  });

  it("homepage changes headline the change table even with row-less detections", () => {
    const md = formatSummary(APPLIED, [], ROWLESS);

    expect(md).not.toContain(NO_CHANGES);
    expect(firstLine(md)).toBe(APPLIED_HEADING);
  });

  it("uses the no-changes headline only when every input is empty", () => {
    expect(formatSummary([], [], [])).toBe(`${NO_CHANGES}\n`);
  });

  // ── Fetch warnings ────────────────────────────────────────────────────

  const WARNINGS: FetchFailure[] = [
    {
      competitor: "Mock LLM",
      repo: "dwmkerr/mock-llm",
      source: "package.json",
      reason: "HTTP 500",
    },
  ];
  const INCOMPLETE =
    'Competitor scan results are incomplete for dwmkerr/mock-llm. See "Fetch Warnings" below.';

  it("names the incomplete repos instead of the no-changes headline", () => {
    const md = formatSummary([], [], [], WARNINGS);
    expect(md).not.toContain(NO_CHANGES);
    expect(md.split("\n")[0]).toBe(INCOMPLETE);
    expect(headings(md)).toEqual(["## Fetch Warnings"]);
    expect(md).toContain("- dwmkerr/mock-llm package.json: HTTP 500");
  });

  it("puts the incomplete headline above applied changes", () => {
    const md = formatSummary(APPLIED, [], [], WARNINGS);
    expect(md.split("\n")[0]).toBe(INCOMPLETE);
    expect(headings(md)).toEqual([APPLIED_HEADING, "## Fetch Warnings"]);
  });
});

describe("feature watch section (D9)", () => {
  const NO_CHANGES = "No competitive matrix changes detected this week.";
  const WATCH_REVIEW =
    "No homepage competitive matrix changes this week. Feature watch changes need a review.";
  const WATCH_HEADING = "## Feature watch";
  const firstLine = (md: string): string => md.split("\n")[0];

  const report = (status: WatchSourceReport["status"]): WatchSourceReport => ({
    id: "mockserver-lr-sessions",
    competitor: "MockServer",
    claims: ["C-S4"],
    url: "https://www.mock-server.com/mock_server/llm_response_mocking.html",
    status,
    details: status === "no change" ? [] : ["section text changed"],
    evidence: {},
  });
  const watchOf = (...statuses: WatchSourceReport["status"][]): FeatureWatchResult => ({
    reports: statuses.map(report),
    state: {},
    stateChanged: statuses.some((s) => s !== "no change"),
  });

  it("headlines a watch that needs review when nothing else changed", () => {
    const md = formatSummary([], [], [], [], [], watchOf("baseline"));
    expect(firstLine(md)).toBe(WATCH_REVIEW);
    expect(md).not.toContain(NO_CHANGES);
    expect(headings(md).at(-1)).toBe(WATCH_HEADING);
    expect(md).toContain("| baseline |");
  });

  it("keeps the no-changes headline when every watch source is unchanged", () => {
    const md = formatSummary([], [], [], [], [], watchOf("no change", "no change"));
    expect(firstLine(md)).toBe(NO_CHANGES);
    expect(headings(md)).toEqual([WATCH_HEADING]);
  });

  it("puts the feature watch section after Fetch Warnings, last", () => {
    const warnings: FetchFailure[] = [
      {
        competitor: "Mock LLM",
        repo: "dwmkerr/mock-llm",
        source: "package.json",
        reason: "HTTP 500",
      },
    ];
    const md = formatSummary(APPLIED, MIGRATION, ROWLESS, warnings, [], watchOf("changed"));
    expect(headings(md)).toEqual([
      APPLIED_HEADING,
      MIGRATION_HEADING,
      ROWLESS_HEADING,
      "## Fetch Warnings",
      WATCH_HEADING,
    ]);
  });

  it("is byte-identical to the old output when no watch is given", () => {
    // The literal is formatSummary's output before the watch parameter existed
    // (scripts/update-competitive-matrix.ts at the PR's merge base).
    const OLD_OUTPUT = [
      APPLIED_HEADING,
      "",
      "| Competitor | Capability | Change |",
      "| --- | --- | --- |",
      "| VidaiMock | Chat Completions SSE | No -> Yes |",
      "| VidaiMock | Embeddings API | No -> Yes |",
      "| mock-llm | Error injection | No -> Yes |",
      "",
      "```mermaid",
      "flowchart LR",
      '  subgraph VidaiMock["VidaiMock"]',
      '    n0["Chat Completions SSE"]',
      '    n1["Embeddings API"]',
      "  end",
      '  subgraph mock-llm["mock-llm"]',
      '    n2["Error injection"]',
      "  end",
      "```",
      "",
      MIGRATION_HEADING,
      "",
      "- `docs/migrate-from-vidaimock/index.html`: Embeddings API: No -> Yes",
      "",
      ROWLESS_HEADING,
      "",
      "These rules have no homepage row. The last column says what the competitor's migration page did with each. Check them by hand.",
      "",
      "| Competitor | Capability | Migration page |",
      "| --- | --- | --- |",
      '| mock-llm | Helm chart | "Kubernetes / Helm" ✗ -> ✓ |',
      "| VidaiMock | CLI server | no row |",
      "",
    ].join("\n");
    expect(formatSummary(APPLIED, MIGRATION, ROWLESS)).toBe(OLD_OUTPUT);
    expect(formatSummary(APPLIED, MIGRATION, ROWLESS, [], [], null)).toBe(OLD_OUTPUT);
    expect(formatSummary([], [], [], [], [])).toBe(`${NO_CHANGES}\n`);
    expect(formatSummary([], [], [])).toBe(`${NO_CHANGES}\n`);
  });

  // F13: in every other headline branch the watch review is an added line, so
  // merging a docs PR (which also commits the watch state) never hides it.
  const REVIEW_LINE = "Feature watch changes need a review; see the Feature watch section.";
  const MANUAL: MigrationManualCheck[] = [
    {
      page: "docs/migrate-from-mokksy/index.html",
      competitor: "mokksy/ai-mocks",
      capability: "Docker image",
      row: "Docker / Helm",
      reason: "combined-row",
    },
  ];
  const WARNINGS: FetchFailure[] = [
    {
      competitor: "Mock LLM",
      repo: "dwmkerr/mock-llm",
      source: "package.json",
      reason: "HTTP 500",
    },
  ];
  const INCOMPLETE =
    'Competitor scan results are incomplete for dwmkerr/mock-llm. See "Fetch Warnings" below.';
  const MANUAL_HEADLINE =
    "No homepage competitive matrix changes this week. Detections below need a manual check.";
  const headline = (md: string): string[] => md.slice(0, md.search(/^## /m)).trimEnd().split("\n");

  it("adds the review line under the migration-only headline", () => {
    const md = formatSummary([], MIGRATION, [], [], [], watchOf("changed"));
    expect(headline(md)).toEqual([
      "No homepage competitive matrix changes this week.",
      REVIEW_LINE,
    ]);
    expect(headings(md)).toEqual([MIGRATION_HEADING, WATCH_HEADING]);
  });

  it("adds the review line under the row-less headline", () => {
    const md = formatSummary([], [], ROWLESS, [], [], watchOf("baseline"));
    expect(headline(md)).toEqual([MANUAL_HEADLINE, REVIEW_LINE]);
    expect(headings(md)).toEqual([ROWLESS_HEADING, WATCH_HEADING]);
  });

  it("adds the review line under the manual-check headline", () => {
    const md = formatSummary([], [], [], [], MANUAL, watchOf("changed"));
    expect(headline(md)).toEqual([MANUAL_HEADLINE, REVIEW_LINE]);
    expect(headings(md).at(-1)).toBe(WATCH_HEADING);
  });

  it("keeps the incomplete-scan headline first and adds the review line", () => {
    const md = formatSummary([], [], [], WARNINGS, [], watchOf("changed"));
    expect(headline(md)).toEqual([INCOMPLETE, REVIEW_LINE]);
    const applied = formatSummary(APPLIED, [], [], WARNINGS, [], watchOf("baseline"));
    expect(headline(applied)).toEqual([INCOMPLETE, REVIEW_LINE]);
    expect(headings(applied)[0]).toBe(APPLIED_HEADING);
  });

  it("puts the review line above the applied-changes table", () => {
    const md = formatSummary(APPLIED, MIGRATION, ROWLESS, [], [], watchOf("changed"));
    expect(headline(md)).toEqual([REVIEW_LINE]);
    expect(md.startsWith(`${REVIEW_LINE}\n\n${APPLIED_HEADING}\n`)).toBe(true);
  });

  it("leaves every headline unchanged when the watch needs no review", () => {
    const quiet = watchOf("no change", "no change");
    const cases: Parameters<typeof formatSummary>[] = [
      [[], MIGRATION, []],
      [[], [], ROWLESS],
      [[], [], [], [], MANUAL],
      [[], [], [], WARNINGS],
      [APPLIED, MIGRATION, ROWLESS],
      [APPLIED, [], [], WARNINGS],
    ];
    for (const [c, m, r, w = [], mc = []] of cases) {
      const without = formatSummary(c, m, r, w, mc);
      const withQuiet = formatSummary(c, m, r, w, mc, quiet);
      expect(withQuiet.startsWith(without)).toBe(true);
      expect(withQuiet).not.toContain(REVIEW_LINE);
    }
  });

  it("keeps the watch-only headline as the single D9 sentence", () => {
    const md = formatSummary([], [], [], [], [], watchOf("changed"));
    expect(headline(md)).toEqual([WATCH_REVIEW]);
    expect(md).not.toContain(REVIEW_LINE);
  });
});
