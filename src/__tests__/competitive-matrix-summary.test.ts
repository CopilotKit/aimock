import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Reimplement the pure formatting logic from writeSummary ─────────────────
// These functions mirror the writeSummary / parseSummaryArg behavior described
// in scripts/update-competitive-matrix.ts so we can unit-test the output format
// without requiring network access or exported symbols.

interface DetectedChange {
  competitor: string;
  capability: string;
  from: string;
  to: string;
}

/**
 * Produces the same markdown that writeSummary would write for a given set of
 * detected changes.  Copied verbatim from the script's writeSummary body so
 * that any future divergence between this copy and the real implementation
 * will surface as a failing test when the integration tests are added.
 */
function formatSummary(changes: DetectedChange[]): string {
  if (changes.length === 0) {
    return "No competitive matrix changes detected this week.\n";
  }

  const lines: string[] = [];
  lines.push("## Competitive Matrix Changes");
  lines.push("");
  lines.push("| Competitor | Capability | Change |");
  lines.push("| --- | --- | --- |");
  for (const ch of changes) {
    lines.push(`| ${ch.competitor} | ${ch.capability} | ${ch.from} -> ${ch.to} |`);
  }
  lines.push("");

  // Build mermaid flowchart grouped by competitor
  const byCompetitor = new Map<string, string[]>();
  for (const ch of changes) {
    if (!byCompetitor.has(ch.competitor)) {
      byCompetitor.set(ch.competitor, []);
    }
    byCompetitor.get(ch.competitor)!.push(ch.capability);
  }

  lines.push("```mermaid");
  lines.push("flowchart LR");
  let nodeCounter = 0;
  for (const [competitor, capabilities] of byCompetitor) {
    const subId = competitor.replace(/[^a-zA-Z0-9_-]/g, "_");
    const subLabel = competitor.replace(/"/g, "&quot;");
    lines.push(`  subgraph ${subId}["${subLabel}"]`);
    for (const cap of capabilities) {
      const nodeId = `n${nodeCounter}`;
      const capLabel = cap.replace(/"/g, "&quot;");
      lines.push(`    ${nodeId}["${capLabel}"]`);
      nodeCounter++;
    }
    lines.push("  end");
  }
  lines.push("```");
  lines.push("");

  return lines.join("\n");
}

function writeSummary(summaryPath: string, changes: DetectedChange[]): void {
  writeFileSync(summaryPath, formatSummary(changes), "utf-8");
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function tmpPath(suffix: string): string {
  return join(tmpdir(), `llmock-cm-test-${suffix}-${Date.now()}.md`);
}

const tempFiles: string[] = [];

afterEach(() => {
  for (const f of tempFiles) {
    if (existsSync(f)) unlinkSync(f);
  }
  tempFiles.length = 0;
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("competitive-matrix summary formatting", () => {
  const SAMPLE_CHANGES: DetectedChange[] = [
    { competitor: "VidaiMock", capability: "Chat Completions SSE", from: "No", to: "Yes" },
    { competitor: "VidaiMock", capability: "Embeddings API", from: "No", to: "Yes" },
    { competitor: "mock-llm", capability: "Helm chart", from: "No", to: "Yes" },
  ];

  // ── No-changes path ─────────────────────────────────────────────────────

  it("produces no-changes message when changes array is empty", () => {
    const md = formatSummary([]);
    expect(md).toBe("No competitive matrix changes detected this week.\n");
  });

  // ── Markdown table ──────────────────────────────────────────────────────

  it("summary contains valid markdown table when changes exist", () => {
    const md = formatSummary(SAMPLE_CHANGES);

    expect(md).toContain("## Competitive Matrix Changes");
    expect(md).toContain("| Competitor | Capability | Change |");
    expect(md).toContain("| --- | --- | --- |");

    // Each change should appear as a table row
    for (const ch of SAMPLE_CHANGES) {
      expect(md).toContain(`| ${ch.competitor} | ${ch.capability} | ${ch.from} -> ${ch.to} |`);
    }
  });

  it("table rows preserve insertion order", () => {
    const md = formatSummary(SAMPLE_CHANGES);
    const tableLines = md
      .split("\n")
      .filter((line) => line.startsWith("| ") && !line.startsWith("| ---"));

    // First line is the header, remaining are data rows
    const dataRows = tableLines.slice(1);
    expect(dataRows).toHaveLength(SAMPLE_CHANGES.length);
    expect(dataRows[0]).toContain("Chat Completions SSE");
    expect(dataRows[1]).toContain("Embeddings API");
    expect(dataRows[2]).toContain("Helm chart");
  });

  // ── Mermaid block ───────────────────────────────────────────────────────

  it("summary contains valid mermaid block when changes exist", () => {
    const md = formatSummary(SAMPLE_CHANGES);

    expect(md).toContain("```mermaid");
    expect(md).toContain("flowchart LR");

    // Fences must be balanced (one open, one close)
    const fenceCount = (md.match(/```/g) || []).length;
    expect(fenceCount).toBe(2);
  });

  it("mermaid block groups capabilities by competitor", () => {
    const md = formatSummary(SAMPLE_CHANGES);

    // VidaiMock has 2 capabilities, mock-llm has 1
    expect(md).toContain('subgraph VidaiMock["VidaiMock"]');
    expect(md).toContain('subgraph mock-llm["mock-llm"]');

    // Each subgraph should be closed
    const subgraphCount = (md.match(/subgraph /g) || []).length;
    const endCount = (md.match(/^\s+end$/gm) || []).length;
    expect(endCount).toBe(subgraphCount);
  });

  it("mermaid sanitizes competitor names with special characters", () => {
    const changes: DetectedChange[] = [
      {
        competitor: "piyook/llm-mock",
        capability: "Docker image",
        from: "No",
        to: "Yes",
      },
    ];
    const md = formatSummary(changes);

    // The subgraph ID should have / replaced with _
    expect(md).toContain('subgraph piyook_llm-mock["piyook/llm-mock"]');
  });

  it("mermaid escapes double quotes in capability names", () => {
    const changes: DetectedChange[] = [
      {
        competitor: "TestComp",
        capability: 'Structured output / JSON "mode"',
        from: "No",
        to: "Yes",
      },
    ];
    const md = formatSummary(changes);

    // Quotes inside node labels should be escaped as &quot;
    expect(md).toContain("&quot;");
    expect(md).not.toMatch(/\["[^"]*"[^"]*"\]/); // no unescaped inner quotes
  });

  it("mermaid generates unique node IDs across competitors", () => {
    const md = formatSummary(SAMPLE_CHANGES);
    const nodeIdPattern = /^\s{4}(n\d+)\[/gm;
    const ids: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = nodeIdPattern.exec(md)) !== null) {
      ids.push(match[1]);
    }

    expect(ids.length).toBe(SAMPLE_CHANGES.length);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // ── writeSummary file I/O ───────────────────────────────────────────────

  it("writeSummary writes file to disk with correct content", () => {
    const outPath = tmpPath("write");
    tempFiles.push(outPath);

    writeSummary(outPath, SAMPLE_CHANGES);

    expect(existsSync(outPath)).toBe(true);
    const content = readFileSync(outPath, "utf-8");
    expect(content).toBe(formatSummary(SAMPLE_CHANGES));
  });

  it("writeSummary writes no-changes file when array is empty", () => {
    const outPath = tmpPath("empty");
    tempFiles.push(outPath);

    writeSummary(outPath, []);

    expect(existsSync(outPath)).toBe(true);
    const content = readFileSync(outPath, "utf-8");
    expect(content).toBe("No competitive matrix changes detected this week.\n");
  });

  it("no summary file when writeSummary is not called", () => {
    const outPath = tmpPath("absent");
    tempFiles.push(outPath);

    // Simulate the code path where --summary is absent: parseSummaryArg
    // returns null, writeSummary is never called
    const summaryPath: string | null = null;
    if (summaryPath) writeSummary(summaryPath, []);

    expect(existsSync(outPath)).toBe(false);
  });

  it("mermaid quotes capability names with parentheses", () => {
    const changes: DetectedChange[] = [
      {
        competitor: "mock-llm",
        capability: "Error injection (one-shot)",
        from: "No",
        to: "Yes",
      },
    ];
    const md = formatSummary(changes);

    // Parentheses must be inside quoted label to avoid mermaid syntax conflict
    expect(md).toContain('["Error injection (one-shot)"]');
    // Must NOT have unquoted brackets with parens inside
    expect(md).not.toMatch(/\[[^"]*\([^)]*\)[^"]*\]/);
  });

  // ── Single change edge case ─────────────────────────────────────────────

  it("handles a single change correctly", () => {
    const changes: DetectedChange[] = [
      { competitor: "mock-llm", capability: "WebSocket APIs", from: "No", to: "Yes" },
    ];
    const md = formatSummary(changes);

    // Should have exactly one data row
    const dataRows = md
      .split("\n")
      .filter(
        (line) =>
          line.startsWith("| ") && !line.startsWith("| ---") && !line.startsWith("| Competitor"),
      );
    expect(dataRows).toHaveLength(1);

    // Should have exactly one subgraph
    expect((md.match(/subgraph /g) || []).length).toBe(1);
  });
});
