#!/usr/bin/env tsx
/// <reference types="node" />
/**
 * update-competitive-matrix.ts
 *
 * Fetches competitor READMEs from GitHub, extracts feature signals via keyword
 * matching, and updates the comparison table in docs/index.html when evidence
 * of new capabilities is found.
 *
 * Usage:
 *   npx tsx scripts/update-competitive-matrix.ts                        # update in place
 *   npx tsx scripts/update-competitive-matrix.ts --dry-run               # show changes only
 *   npx tsx scripts/update-competitive-matrix.ts --summary out.md        # write markdown summary
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// ── Types ────────────────────────────────────────────────────────────────────

interface Competitor {
  /** Display name matching the <th> link text in the HTML table */
  name: string;
  /** GitHub owner/repo */
  repo: string;
}

interface FeatureRule {
  /** Row label as it appears in the first <td> of each <tr> */
  rowLabel: string;
  /** Patterns to search for (case-insensitive) */
  keywords: string[];
}

interface DetectedChange {
  competitor: string;
  capability: string;
  from: string;
  to: string;
}

// ── Configuration ────────────────────────────────────────────────────────────

const COMPETITORS: Competitor[] = [
  { name: "VidaiMock", repo: "vidaiUK/VidaiMock" },
  { name: "mock-llm", repo: "dwmkerr/mock-llm" },
  { name: "piyook/llm-mock", repo: "piyook/llm-mock" },
];

const FEATURE_RULES: FeatureRule[] = [
  {
    rowLabel: "Chat Completions SSE",
    keywords: ["chat/completions", "streaming", "SSE", "server-sent", "stream.*true"],
  },
  {
    rowLabel: "Responses API SSE",
    keywords: ["responses", "/v1/responses", "response.create"],
  },
  {
    rowLabel: "Claude Messages API",
    keywords: ["claude", "anthropic", "/v1/messages", "messages API"],
  },
  {
    rowLabel: "Gemini streaming",
    keywords: ["gemini", "generateContent", "google.*ai"],
  },
  {
    rowLabel: "WebSocket APIs",
    keywords: ["websocket", "realtime", "ws://", "wss://"],
  },
  {
    rowLabel: "Embeddings API",
    keywords: ["embedding", "/v1/embeddings", "embed"],
  },
  {
    rowLabel: "Structured output / JSON mode",
    keywords: ["json_object", "json_schema", "structured output", "response_format"],
  },
  {
    rowLabel: "Sequential / stateful responses",
    keywords: ["sequence", "stateful", "sequential", "multi-turn"],
  },
  {
    rowLabel: "Azure OpenAI",
    keywords: ["azure", "deployments", "azure openai"],
  },
  {
    rowLabel: "AWS Bedrock",
    keywords: ["bedrock", "invoke-model", "aws.*bedrock"],
  },
  {
    rowLabel: "Docker image",
    keywords: ["docker", "dockerfile", "container", "docker-compose"],
  },
  {
    rowLabel: "Helm chart",
    keywords: ["helm", "chart", "kubernetes", "k8s"],
  },
  {
    rowLabel: "Fixture files (JSON)",
    keywords: ["fixture", "yaml config", "template", "json fixture"],
  },
  {
    rowLabel: "CLI server",
    keywords: ["cli", "command line", "npx", "command-line"],
  },
  {
    rowLabel: "GET /v1/models",
    keywords: ["/v1/models", "models endpoint", "list models"],
  },
  {
    rowLabel: "Drift detection",
    keywords: ["drift", "conformance", "schema validation"],
  },
  {
    rowLabel: "Request journal",
    keywords: ["journal", "request log", "audit log", "request history"],
  },
  {
    rowLabel: "Error injection (one-shot)",
    keywords: ["error injection", "fault injection", "error simulation", "inject.*error"],
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes("--dry-run");
const DOCS_PATH = resolve(import.meta.dirname ?? __dirname, "../docs/index.html");

const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const HEADERS: Record<string, string> = {
  Accept: "application/vnd.github.v3+json",
  "User-Agent": "llmock-competitive-matrix-updater",
  ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
};

async function fetchReadme(repo: string): Promise<string> {
  const url = `https://api.github.com/repos/${repo}/readme`;
  console.log(`  Fetching README from ${repo}...`);
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    console.warn(`  ⚠ Failed to fetch README for ${repo}: ${res.status} ${res.statusText}`);
    return "";
  }
  const json = (await res.json()) as { content?: string; encoding?: string };
  if (json.content && json.encoding === "base64") {
    return Buffer.from(json.content, "base64").toString("utf-8");
  }
  return "";
}

async function fetchPackageJson(repo: string): Promise<string> {
  const url = `https://api.github.com/repos/${repo}/contents/package.json`;
  console.log(`  Fetching package.json from ${repo}...`);
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) return "";
  const json = (await res.json()) as { content?: string; encoding?: string };
  if (json.content && json.encoding === "base64") {
    return Buffer.from(json.content, "base64").toString("utf-8");
  }
  return "";
}

function extractFeatures(text: string): Record<string, boolean> {
  const lower = text.toLowerCase();
  const result: Record<string, boolean> = {};
  for (const rule of FEATURE_RULES) {
    const found = rule.keywords.some((kw) => {
      const pattern = new RegExp(kw.toLowerCase(), "i");
      return pattern.test(lower);
    });
    result[rule.rowLabel] = found;
  }
  return result;
}

// ── HTML Matrix Parsing & Updating ───────────────────────────────────────────

/**
 * Parses the comparison table from docs/index.html.
 * Returns a map: competitorName -> { rowLabel -> cellText }
 */
function parseCurrentMatrix(html: string): {
  headers: string[];
  rows: Map<string, Map<string, string>>;
} {
  // Extract the table between <table class="comparison-table"> and </table>
  const tableMatch = html.match(/<table class="comparison-table">([\s\S]*?)<\/table>/);
  if (!tableMatch) {
    throw new Error("Could not find comparison-table in HTML");
  }
  const tableHtml = tableMatch[1];

  // Extract header names (the link text inside each <th>)
  const thRegex = /<th[^>]*>[\s\S]*?<a[^>]*>(.*?)<\/a[\s\S]*?<\/th>/g;
  const headers: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = thRegex.exec(tableHtml)) !== null) {
    headers.push(m[1].trim());
  }
  // headers[0] = "llmock", headers[1] = "MSW", headers[2..] = competitors

  // Extract rows
  const rows = new Map<string, Map<string, string>>();
  const tbody = tableHtml.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? "";
  let tr: RegExpExecArray | null;
  const trIter = new RegExp(/<tr>([\s\S]*?)<\/tr>/g);

  while ((tr = trIter.exec(tbody)) !== null) {
    const tds: string[] = [];
    const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
    let td: RegExpExecArray | null;
    while ((td = tdRegex.exec(tr[1])) !== null) {
      tds.push(td[1].trim());
    }
    if (tds.length < 2) continue;

    const rowLabel = tds[0];
    const rowMap = new Map<string, string>();
    // tds[1] = llmock, tds[2] = MSW, tds[3..5] = competitors
    for (let i = 1; i < tds.length && i - 1 < headers.length; i++) {
      rowMap.set(headers[i - 1], tds[i]);
    }
    rows.set(rowLabel, rowMap);
  }

  return { headers, rows };
}

/**
 * Updates only competitor cells (not llmock or MSW) where:
 * - The current value indicates "No" (class="no">No</td>)
 * - The feature was detected in the competitor's README
 *
 * Only upgrades "No" -> "Yes", never downgrades.
 */
function computeChanges(
  html: string,
  matrix: { headers: string[]; rows: Map<string, Map<string, string>> },
  competitorFeatures: Map<string, Record<string, boolean>>,
): DetectedChange[] {
  const changes: DetectedChange[] = [];

  for (const [compName, features] of competitorFeatures) {
    for (const [rowLabel, detected] of Object.entries(features)) {
      if (!detected) continue;

      const row = matrix.rows.get(rowLabel);
      if (!row) continue;

      const currentCell = row.get(compName);
      if (!currentCell) continue;

      // Only upgrade "No" cells — leave "Yes", "Partial", "Manual", etc. alone
      if (currentCell === "No") {
        changes.push({
          competitor: compName,
          capability: rowLabel,
          from: "No",
          to: "Yes",
        });
      }
    }
  }

  return changes;
}

/**
 * Applies detected changes to the HTML string by finding the exact table cells
 * and replacing them.
 */
function applyChanges(html: string, changes: DetectedChange[]): string {
  if (changes.length === 0) return html;

  // We need to find each specific cell. The approach: locate each <tr> by its
  // first <td> content, then find the Nth <td> matching the competitor column.

  // First, determine column indices for competitors
  const tableMatch = html.match(/<table class="comparison-table">([\s\S]*?)<\/table>/);
  if (!tableMatch) return html;

  // Re-parse headers to get column positions
  const theadMatch = tableMatch[1].match(/<thead>([\s\S]*?)<\/thead>/);
  if (!theadMatch) return html;

  const thRegex = /<th[^>]*>[\s\S]*?<a[^>]*>(.*?)<\/a[\s\S]*?<\/th>/g;
  const headers: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = thRegex.exec(theadMatch[1])) !== null) {
    headers.push(m[1].trim());
  }
  // Column indices: "Capability" = 0 (no header link), then llmock=1, MSW=2,
  // VidaiMock=3, mock-llm=4, piyook/llm-mock=5
  // In the <td> array: index 0 = capability, 1 = llmock, 2 = MSW, 3+ = competitors
  const compColumnIndex = (name: string): number => {
    const idx = headers.indexOf(name);
    return idx === -1 ? -1 : idx + 1; // +1 because first <td> is the row label
  };

  let result = html;

  for (const change of changes) {
    const colIdx = compColumnIndex(change.competitor);
    if (colIdx === -1) continue;

    // Find the <tr> containing this capability row
    // We search for the row by its label in the first <td>
    const rowPattern = new RegExp(
      `(<tr>\\s*<td>\\s*${escapeRegex(change.capability)}\\s*</td>)([\\s\\S]*?)(</tr>)`,
    );
    const rowMatch = result.match(rowPattern);
    if (!rowMatch) continue;

    const prefix = rowMatch[1];
    const cellsHtml = rowMatch[2];
    const suffix = rowMatch[3];

    // Find the Nth <td> in cellsHtml (colIdx - 1 because the first <td> is already in prefix)
    const targetTdIdx = colIdx - 1; // 0-based within the remaining cells
    let tdCount = 0;
    const tdReplace = cellsHtml.replace(
      /<td class="(no|yes|manual)">([\s\S]*?)<\/td>/g,
      (fullMatch, cls, content) => {
        const currentIdx = tdCount++;
        if (currentIdx === targetTdIdx && content.trim() === "No") {
          return `<td class="yes">Yes</td>`;
        }
        return fullMatch;
      },
    );

    result = result.replace(rowPattern, prefix + tdReplace + suffix);
  }

  return result;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

// ── Summary Writing ──────────────────────────────────────────────────────────

function parseSummaryArg(): string | null {
  const idx = process.argv.indexOf("--summary");
  if (idx === -1 || idx + 1 >= process.argv.length) return null;
  return resolve(process.argv[idx + 1]);
}

function writeSummary(summaryPath: string, changes: DetectedChange[]): void {
  let md: string;

  if (changes.length === 0) {
    md = "No competitive matrix changes detected this week.\n";
  } else {
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

    md = lines.join("\n");
  }

  writeFileSync(summaryPath, md, "utf-8");
  console.log(`\nSummary written to ${summaryPath}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("=== Competitive Matrix Updater ===\n");

  if (DRY_RUN) {
    console.log("  [DRY RUN] No files will be modified.\n");
  }

  // 1. Fetch competitor data
  const competitorFeatures = new Map<string, Record<string, boolean>>();

  for (const comp of COMPETITORS) {
    console.log(`\n--- ${comp.name} (${comp.repo}) ---`);
    const [readme, pkg] = await Promise.all([fetchReadme(comp.repo), fetchPackageJson(comp.repo)]);

    if (!readme && !pkg) {
      console.log(`  No data fetched, skipping.`);
      continue;
    }

    const combined = `${readme}\n${pkg}`;
    const features = extractFeatures(combined);
    competitorFeatures.set(comp.name, features);

    // Log detected features
    const detected = Object.entries(features)
      .filter(([, v]) => v)
      .map(([k]) => k);
    if (detected.length > 0) {
      console.log(`  Detected features: ${detected.join(", ")}`);
    } else {
      console.log(`  No features detected from keywords.`);
    }
  }

  // 2. Read current HTML
  console.log(`\nReading ${DOCS_PATH}...`);
  const html = readFileSync(DOCS_PATH, "utf-8");

  // 3. Parse current matrix
  const matrix = parseCurrentMatrix(html);
  console.log(
    `Parsed ${matrix.rows.size} capability rows, ${matrix.headers.length} competitor columns.`,
  );

  // 4. Compute changes
  const changes = computeChanges(html, matrix, competitorFeatures);

  const summaryPath = parseSummaryArg();

  if (changes.length === 0) {
    console.log("\nNo changes detected. Competitive matrix is up to date.");
    if (summaryPath) writeSummary(summaryPath, changes);
    return;
  }

  console.log(`\n${changes.length} change(s) detected:`);
  for (const ch of changes) {
    console.log(`  ${ch.competitor} / ${ch.capability}: ${ch.from} -> ${ch.to}`);
  }

  if (summaryPath) writeSummary(summaryPath, changes);

  if (DRY_RUN) {
    console.log("\n[DRY RUN] Would update docs/index.html with the above changes.");
    return;
  }

  // 5. Apply changes
  const updated = applyChanges(html, changes);
  writeFileSync(DOCS_PATH, updated, "utf-8");
  console.log("\nUpdated docs/index.html successfully.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
