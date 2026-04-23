#!/usr/bin/env tsx
/// <reference types="node" />
/**
 * update-competitive-matrix.ts
 *
 * Fetches competitor READMEs from GitHub, extracts feature signals via keyword
 * matching, and updates the comparison table in docs/index.html and
 * corresponding migration pages when evidence of new capabilities is found.
 *
 * Usage:
 *   npx tsx scripts/update-competitive-matrix.ts                        # update in place
 *   npx tsx scripts/update-competitive-matrix.ts --dry-run               # show changes only
 *   npx tsx scripts/update-competitive-matrix.ts --summary out.md        # write markdown summary
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
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
  { name: "mokksy/ai-mocks", repo: "mokksy/ai-mocks" },
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
    keywords: ["/v1/embeddings", "embeddings api", "embedding endpoint", "embedding model"],
  },
  {
    rowLabel: "Image generation",
    keywords: ["dall-e", "dalle", "/v1/images", "image generation", "imagen", "generate.*image"],
  },
  {
    rowLabel: "Text-to-Speech",
    keywords: ["text-to-speech", "/v1/audio/speech", "audio generation", "tts endpoint", "tts api"],
  },
  {
    rowLabel: "Audio transcription",
    keywords: [
      "/v1/audio/transcriptions",
      "whisper",
      "speech-to-text",
      "audio transcription",
      "transcription api",
    ],
  },
  {
    rowLabel: "Video generation",
    keywords: ["sora", "/v1/videos", "video generation", "generate.*video"],
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
    keywords: ["dockerfile", "docker image", "docker-compose", "docker compose", "docker run"],
  },
  {
    rowLabel: "Helm chart",
    keywords: ["helm chart", "helm install", "kubernetes.*deploy", "k8s.*deploy"],
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
  {
    rowLabel: "AG-UI event mocking",
    keywords: ["ag-ui", "agui", "agent-ui", "copilotkit.*frontend", "event stream mock"],
  },
  {
    rowLabel: "GitHub Action",
    keywords: ["github.*action", "action.yml", "uses:.*mock", "ci.*action"],
  },
  {
    rowLabel: "Vitest / Jest plugins",
    keywords: [
      "vitest.*plugin",
      "jest.*plugin",
      "useAimock",
      "useMock.*test",
      "test.*framework.*integrat",
    ],
  },
];

/** Maps competitor display names to their migration page paths (relative to docs/) */
const COMPETITOR_MIGRATION_PAGES: Record<string, string> = {
  VidaiMock: "docs/migrate-from-vidaimock.html",
  "mock-llm": "docs/migrate-from-mock-llm.html",
  "piyook/llm-mock": "docs/migrate-from-piyook.html",
  // MSW, Mokksy, Python don't have GitHub repos in COMPETITORS[] yet
};

// ── Helpers ──────────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes("--dry-run");
const DOCS_PATH = resolve(import.meta.dirname ?? __dirname, "../docs/index.html");

const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const HEADERS: Record<string, string> = {
  Accept: "application/vnd.github.v3+json",
  "User-Agent": "aimock-competitive-matrix-updater",
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

/**
 * Counts how many distinct LLM providers a competitor supports based on their
 * README text. De-duplicates overlapping patterns (e.g. "anthropic" and "claude"
 * both map to the same provider).
 */
function countProviders(text: string): number {
  const lower = text.toLowerCase();

  // Group patterns that refer to the same provider
  const providerGroups: string[][] = [
    ["openai"],
    ["claude", "anthropic"],
    ["gemini", "google.*ai"],
    ["bedrock", "aws"],
    ["azure"],
    ["vertex"],
    ["ollama"],
    ["cohere"],
    ["mistral"],
    ["groq"],
    ["together"],
    ["llama"],
  ];

  let count = 0;
  for (const group of providerGroups) {
    const found = group.some((kw) => new RegExp(kw, "i").test(lower));
    if (found) count++;
  }
  return count;
}

// ── Migration Page Updating ─────────────────────────────────────────────────

/**
 * Updates a migration page's comparison table cells from the "no" state
 * (&#10007;) to the "yes" state (&#10003;) when a feature is detected.
 *
 * Migration page tables use a different format than the index.html matrix:
 * - "Yes" cells: <td style="color: var(--accent)">&#10003;</td>
 * - "No" cells:  <td style="color: var(--error)">&#10007;</td>
 *
 * The function also updates numeric provider claims in both table cells and
 * prose text (e.g., "5 providers" -> "8 providers").
 */
function updateMigrationPage(
  html: string,
  competitorName: string,
  features: Record<string, boolean>,
  providerCount: number,
): { html: string; changes: string[] } {
  let result = html;
  const changes: string[] = [];

  // Find the comparison table (class="comparison-table" or class="endpoint-table")
  const tableMatch = result.match(
    /<table class="(?:comparison-table|endpoint-table)">([\s\S]*?)<\/table>/,
  );
  if (!tableMatch) {
    return { html: result, changes };
  }

  // Update feature cells: find rows where the competitor column shows &#10007;
  // and the feature was detected
  for (const rule of FEATURE_RULES) {
    if (!features[rule.rowLabel]) continue;

    // Migration tables have different row labels than the index matrix.
    // We look for rows that conceptually match the feature rule.
    // The competitor column is always the first data column (index 1) after the label.
    const rowPatterns = buildMigrationRowPatterns(rule.rowLabel);
    for (const rowPat of rowPatterns) {
      const rowRegex = new RegExp(
        `(<tr>\\s*<td>${escapeRegex(rowPat)}</td>\\s*)<td style="color: var\\(--error\\)">&#10007;</td>`,
      );
      if (rowRegex.test(result)) {
        result = result.replace(rowRegex, `$1<td style="color: var(--accent)">&#10003;</td>`);
        changes.push(`${competitorName}: ${rowPat} ✗ -> ✓`);
      }
    }
  }

  // Update provider count claims in the competitor column of the table
  // Match patterns like: >N providers<, >N+ providers<
  if (providerCount > 0) {
    result = updateProviderCounts(result, competitorName, providerCount, changes);
  }

  return { html: result, changes };
}

/**
 * Builds possible row label strings that a migration page might use for a given
 * feature rule. Migration pages use more descriptive labels than the index matrix.
 */
function buildMigrationRowPatterns(rowLabel: string): string[] {
  const patterns = [rowLabel];

  // Add common migration-page variants
  const variants: Record<string, string[]> = {
    "Chat Completions SSE": ["OpenAI Chat Completions", "Streaming SSE"],
    "Responses API SSE": ["OpenAI Responses API"],
    "Claude Messages API": ["Anthropic Claude"],
    "Gemini streaming": ["Google Gemini"],
    "WebSocket APIs": ["WebSocket protocols"],
    "Structured output / JSON mode": ["Structured output / JSON mode", "Structured output"],
    "Sequential / stateful responses": ["Sequential responses"],
    "Docker image": ["Docker"],
    "Fixture files (JSON)": ["Fixture files"],
    "CLI server": ["CLI"],
    "Error injection (one-shot)": ["Error injection"],
    "Request journal": ["Request journal"],
    "Drift detection": ["Drift detection"],
    "AG-UI event mocking": ["AG-UI event mocking", "AG-UI mocking", "AG-UI"],
  };

  if (variants[rowLabel]) {
    patterns.push(...variants[rowLabel]);
  }

  return patterns;
}

/**
 * Scans the HTML for numeric provider claims and updates them if the detected
 * count is higher. Only replaces within content scoped to the specific competitor
 * to avoid corrupting aimock's own claims or other competitors' counts.
 *
 * Scoping strategy: only replace inside elements/paragraphs that mention the
 * competitor by name, or within the competitor's column in a table row whose
 * label matches "provider" (case-insensitive).
 */
function updateProviderCounts(
  html: string,
  competitorName: string,
  detectedCount: number,
  changes: string[],
): string {
  let result = html;
  const escapedName = escapeRegex(competitorName);

  // Strategy 1: Replace provider counts in table rows about providers,
  // scoped to the competitor's column. Find rows with "provider" in the label,
  // then find the competitor's column cell by index.
  const tableMatch = result.match(
    /<table class="(?:comparison-table|endpoint-table)">([\s\S]*?)<\/table>/,
  );
  if (tableMatch) {
    const fullTable = tableMatch[0];

    // Find the competitor's column index from headers
    const thRegex = /<th[^>]*>([\s\S]*?)<\/th>/g;
    const thTexts: string[] = [];
    let thM: RegExpExecArray | null;
    while ((thM = thRegex.exec(fullTable)) !== null) {
      thTexts.push(thM[1].trim());
    }
    const compColIdx = thTexts.findIndex((t) => t.includes(competitorName) || t === competitorName);

    if (compColIdx >= 0) {
      // Find provider-related rows and update only the competitor's cell
      const updatedTable = fullTable.replace(
        /<tr>([\s\S]*?)<\/tr>/g,
        (trMatch, trContent: string) => {
          // Check if this row is about providers
          const firstTd = trContent.match(/<td[^>]*>([\s\S]*?)<\/td>/);
          if (!firstTd || !/provider/i.test(firstTd[1])) return trMatch;

          // Replace provider count only in the competitor's column cell
          let cellIdx = 0;
          return trMatch.replace(/<td[^>]*>([\s\S]*?)<\/td>/g, (tdMatch, tdContent: string) => {
            const currentIdx = cellIdx++;
            if (currentIdx !== compColIdx) return tdMatch;

            const updated = replaceProviderCount(tdContent, detectedCount);
            if (updated !== tdContent) {
              const oldCount = tdContent.match(/(\d+)/)?.[1] ?? "?";
              changes.push(
                `${competitorName}: provider count ${oldCount} -> ${detectedCount} (table)`,
              );
              return tdMatch.replace(tdContent, updated);
            }
            return tdMatch;
          });
        },
      );

      result = result.replace(fullTable, updatedTable);
    }
  }

  // Strategy 2: Replace provider counts in prose paragraphs/sentences that
  // explicitly mention the competitor by name.
  const prosePattern = new RegExp(
    `(<[^>]*>[^<]*${escapedName}[^<]*)(\\d+)\\+?\\s*(?:LLM\\s*)?providers?`,
    "gi",
  );
  result = result.replace(prosePattern, (match, prefix, numStr) => {
    const currentCount = parseInt(numStr, 10);
    if (detectedCount > currentCount) {
      changes.push(`${competitorName}: provider count ${currentCount} -> ${detectedCount} (prose)`);
      return match.replace(/(\d+)\+?\s*(?:LLM\s*)?providers?/, `${detectedCount} providers`);
    }
    return match;
  });

  return result;
}

/** Replaces "N providers" or "N+ providers" in a string if detected > current */
function replaceProviderCount(text: string, detectedCount: number): string {
  return text.replace(/(\d+)\+?\s*(?:LLM\s*)?providers?/gi, (match, numStr) => {
    const currentCount = parseInt(numStr, 10);
    if (detectedCount > currentCount) {
      return `${detectedCount} providers`;
    }
    return match;
  });
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
  // headers[0] = "aimock", headers[1] = "MSW", headers[2..] = competitors

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
    // tds[1] = aimock, tds[2] = MSW, tds[3..5] = competitors
    for (let i = 1; i < tds.length && i - 1 < headers.length; i++) {
      rowMap.set(headers[i - 1], tds[i]);
    }
    rows.set(rowLabel, rowMap);
  }

  return { headers, rows };
}

/**
 * Updates only competitor cells (not aimock or MSW) where:
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

      // Only upgrade "No" cells — leave "Yes", "Partial", "Manual", etc. alone.
      // Cells contain inner HTML like '<span class="no">&#10007;</span>',
      // not bare "No" text, so check for the no-class span or cross-mark entity.
      if (
        currentCell.includes('class="no"') ||
        currentCell.includes("\u2717") ||
        currentCell.includes("&#10007;")
      ) {
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
  // Column indices: "Capability" = 0 (no header link), then aimock=1, MSW=2,
  // VidaiMock=3, mock-llm=4, piyook/llm-mock=5
  // In the <td> array: index 0 = capability, 1 = aimock, 2 = MSW, 3+ = competitors
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

    // Find the Nth <td> in cellsHtml (colIdx - 1 because the first <td> is already in prefix).
    // Actual cells use <td><span class="no">&#10007;</span></td> (class is on span, not td),
    // so we match all <td>...</td> and check inner content for no-class spans.
    const targetTdIdx = colIdx - 1; // 0-based within the remaining cells
    let tdCount = 0;
    const tdReplace = cellsHtml.replace(/<td[^>]*>([\s\S]*?)<\/td>/g, (fullMatch, content) => {
      const currentIdx = tdCount++;
      if (
        currentIdx === targetTdIdx &&
        (content.includes('class="no"') ||
          content.includes("\u2717") ||
          content.includes("&#10007;"))
      ) {
        return `<td><span class="yes">&#10003;</span></td>`;
      }
      return fullMatch;
    });

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
  const competitorProviderCounts = new Map<string, number>();
  const competitorReadmes = new Map<string, string>();

  for (const comp of COMPETITORS) {
    console.log(`\n--- ${comp.name} (${comp.repo}) ---`);
    const [readme, pkg] = await Promise.all([fetchReadme(comp.repo), fetchPackageJson(comp.repo)]);

    if (!readme && !pkg) {
      console.log(`  No data fetched, skipping.`);
      continue;
    }

    const combined = `${readme}\n${pkg}`;
    competitorReadmes.set(comp.name, combined);
    const features = extractFeatures(combined);
    competitorFeatures.set(comp.name, features);

    // Count providers
    const provCount = countProviders(combined);
    competitorProviderCounts.set(comp.name, provCount);

    // Log detected features
    const detected = Object.entries(features)
      .filter(([, v]) => v)
      .map(([k]) => k);
    if (detected.length > 0) {
      console.log(`  Detected features: ${detected.join(", ")}`);
    } else {
      console.log(`  No features detected from keywords.`);
    }
    if (provCount > 0) {
      console.log(`  Detected ${provCount} LLM provider(s).`);
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
    console.log("[DRY RUN] Would also update migration pages for changed competitors.");
    return;
  }

  // 5. Apply changes to index.html
  const updated = applyChanges(html, changes);
  writeFileSync(DOCS_PATH, updated, "utf-8");
  console.log("\nUpdated docs/index.html successfully.");

  // 6. Update migration pages for competitors with changes
  const docsDir = resolve(import.meta.dirname ?? __dirname, "..");
  const updatedCompetitors = new Set(changes.map((ch) => ch.competitor));

  for (const compName of updatedCompetitors) {
    const migrationPageRelPath = COMPETITOR_MIGRATION_PAGES[compName];
    if (!migrationPageRelPath) {
      console.log(`  No migration page mapped for ${compName}, skipping.`);
      continue;
    }

    const migrationPagePath = resolve(docsDir, migrationPageRelPath);
    if (!existsSync(migrationPagePath)) {
      console.log(`  Migration page not found: ${migrationPagePath}, skipping.`);
      continue;
    }

    const migrationHtml = readFileSync(migrationPagePath, "utf-8");
    const features = competitorFeatures.get(compName) ?? {};
    const provCount = competitorProviderCounts.get(compName) ?? 0;

    const { html: updatedMigration, changes: migrationChanges } = updateMigrationPage(
      migrationHtml,
      compName,
      features,
      provCount,
    );

    if (migrationChanges.length > 0) {
      writeFileSync(migrationPagePath, updatedMigration, "utf-8");
      console.log(`\nUpdated ${migrationPageRelPath}:`);
      for (const ch of migrationChanges) {
        console.log(`  ${ch}`);
      }
    } else {
      console.log(`\n${migrationPageRelPath}: no migration page changes needed.`);
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
