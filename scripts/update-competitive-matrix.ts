#!/usr/bin/env tsx
/// <reference types="node" />
/**
 * update-competitive-matrix.ts
 *
 * Fetches competitor READMEs and package.json files from GitHub, extracts
 * feature signals via keyword matching, and updates the comparison table in
 * docs/index.html when evidence of new capabilities is found. Every scanned
 * competitor's migration page is updated from the same detections, and the
 * detections that no page can hold are listed in the summary.
 *
 * Usage:
 *   npx tsx scripts/update-competitive-matrix.ts                        # update in place
 *   npx tsx scripts/update-competitive-matrix.ts --dry-run               # show changes only
 *   npx tsx scripts/update-competitive-matrix.ts --summary out.md        # write markdown summary
 *   npx tsx scripts/update-competitive-matrix.ts --watch-state <path>   # feature-watch state file (default scripts/competitive-watch-state.json)
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { decodeHTML } from "entities";
import {
  FEATURE_WATCH,
  WATCH_STATE_REL_PATH,
  checkArgs,
  flagValues,
  formatWatchSection,
  parseUrlOverrides,
  readWatchState,
  runFeatureWatch,
  serializeWatchState,
  todayUtc,
  watchNeedsReview,
  type FeatureWatchResult,
} from "./competitive-watch.js";

// ── Types ────────────────────────────────────────────────────────────────────

interface Competitor {
  /** Display name matching the <th> link text in the HTML table */
  name: string;
  /** GitHub owner/repo */
  repo: string;
}

interface FeatureRule {
  /**
   * Row label of the homepage matrix (the <th scope="row"> of each body <tr>),
   * written as plain text: "Search & rerank", not "Search &amp; rerank".
   * Rules with no homepage row must be listed in MATRIX_ROWLESS_RULES.
   */
  rowLabel: string;
  /** Patterns to search for (case-insensitive) */
  keywords: readonly string[];
}

export interface DetectedChange {
  competitor: string;
  capability: string;
  from: string;
  to: string;
}

// ── Configuration ────────────────────────────────────────────────────────────

export const COMPETITORS: readonly Competitor[] = [
  { name: "VidaiMock", repo: "vidaiUK/VidaiMock" },
  { name: "mock-llm", repo: "dwmkerr/mock-llm" },
  { name: "piyook/llm-mock", repo: "piyook/llm-mock" },
  { name: "mokksy/ai-mocks", repo: "mokksy/ai-mocks" },
];

// `as const` keeps each rowLabel as a string literal, so RuleLabel below is the
// exact set of rule labels and MATRIX_ROWLESS_RULES cannot name a missing rule.
export const FEATURE_RULES = [
  {
    rowLabel: "Chat Completions SSE",
    keywords: ["chat/completions", "streaming", "SSE", "server-sent", "stream.*true"],
  },
  {
    rowLabel: "Responses API SSE",
    // Evidence of the Responses API itself. The plain word "responses" is
    // ordinary English, and the Realtime event "response.create" is not the
    // Responses API. "v1/responses" has no leading slash so it also matches
    // inside a URL such as localhost:8100/v1/responses.
    keywords: ["v1/responses", "responses api", "responses\\.create"],
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
    rowLabel: "OpenRouter router / fallback simulation",
    keywords: [
      "openrouter",
      "fallback.*model",
      "model.*fallback",
      "provider routing",
      "failover",
      "models.*array",
      "allow_fallbacks",
    ],
  },
  {
    rowLabel: "WebSocket APIs",
    keywords: ["websocket", "realtime", "ws://", "wss://"],
  },
  {
    rowLabel: "Realtime GA protocol",
    keywords: [
      "gpt-realtime-2",
      "realtime.*ga",
      "ga.*protocol",
      "output_text\\.delta",
      "conversation\\.item\\.added",
    ],
  },
  {
    rowLabel: "Realtime Beta compatibility",
    keywords: [
      "openai-beta.*realtime",
      "realtime=v1",
      "beta.*shim",
      "beta.*compat",
      "response\\.text\\.delta",
    ],
  },
  {
    rowLabel: "Realtime transcription/translation",
    keywords: [
      "gpt-4o-transcribe",
      "gpt-4o-mini-transcribe",
      "whisper-1",
      "realtime.*transcription",
      "realtime.*translation",
    ],
  },
  {
    rowLabel: "Realtime image input",
    keywords: ["input_image.*realtime", "realtime.*image", "realtime.*vision"],
  },
  {
    rowLabel: "Realtime commentary phase",
    keywords: ["commentary.*phase", "phase.*commentary", "final_answer.*commentary"],
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
    rowLabel: "Image editing",
    keywords: ["/v1/images/edits", "image edit", "image editing", "inpainting", "edit.*image"],
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
    rowLabel: "Audio translation",
    keywords: [
      "/v1/audio/translations",
      "audio translation",
      "translate.*audio",
      "audio.*translate",
    ],
  },
  {
    rowLabel: "Non-speech audio",
    keywords: [
      "sound-generation",
      "sound effect",
      "music generation",
      "elevenlabs",
      "fal.ai",
      "audio generation",
      "non-speech audio",
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
    rowLabel: "Fixture files",
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
    keywords: [
      "drift detection",
      "drift test",
      "api drift",
      "conformance test",
      "schema validation",
    ],
  },
  {
    rowLabel: "Request journal",
    keywords: ["journal", "request log", "audit log", "request history"],
  },
  {
    rowLabel: "Error injection",
    keywords: ["error injection", "fault injection", "error simulation", "inject.*error"],
  },
  {
    rowLabel: "AG-UI event mocking",
    keywords: ["ag-ui", "agui", "agent-ui", "copilotkit.*frontend", "event stream mock"],
  },
  {
    rowLabel: "MCP tool mocking",
    // Mocking MCP servers or tools. Two orders match:
    // - "mock", "mocks", "mocked" or "mocking" directly before "MCP", as in
    //   "mock MCP tools". No word may come between them, so "mock server MCP
    //   endpoint" (a mock HTTP server that also has an MCP endpoint) and
    //   "mockserver MCP" do not match.
    // - "MCP", then optionally a parenthetical of at most 40 characters and
    //   "tool(s)" or "server(s)", then a mock word, as in "MCP tool mocking" or
    //   "MCP (Model Context Protocol) Mocking".
    // A bare "MCP server" is not mocking: many READMEs only say the product
    // ships an MCP server, sometimes next to an unrelated mock server.
    keywords: [
      "mock(?:s|ed|ing)?[\\s-]+mcp",
      "mcp[\\s-]+(?:\\([^)]{1,40}\\)[\\s-]+)?(?:(?:tools?|servers?)[\\s-]+)?mock(?:s|ed|ing)?",
    ],
  },
  {
    rowLabel: "Scenario-scoped MCP tool fakes",
    // An MCP or tools/call fixture, fake or mock, then at most four more words
    // in the same clause, then a scoping word: "sequence(s)", "scenario(s)",
    // "per test" or "argument(s)". Words are letters, digits and "/", so
    // punctuation such as ".", ";" or ":" ends the match. Plain "mock MCP
    // tools" is the row above, not scenario scoping.
    keywords: [
      "mcp[\\s-]+(?:(?:tools?|servers?)[\\s-]+)?(?:fixtures?|fakes?|mock(?:s|ed|ing)?)(?:[\\s-]+[a-z0-9/]+){0,4}?[\\s-]+(?:sequences?|scenarios?|per[- ]test|arguments?)",
      "tools/call[\\s-]+fixtures?(?:[\\s-]+[a-z0-9/]+){0,4}?[\\s-]+(?:sequences?|scenarios?)",
    ],
  },
  {
    rowLabel: "Fail on undeclared MCP tool",
    // A bare "undeclared tool" matches on its own: it names the closed-world
    // behavior. "unmocked" must name a tool ("unmocked tool", "unmocked MCP
    // tools") and have a whole deny/fail word within three more words, or come
    // directly after "deny", "denies" or "denied". Unmocked requests or HTTP
    // calls are plain HTTP mocking, not MCP tools, so they do not match.
    keywords: [
      "undeclared[\\s-]+(?:mcp[\\s-]+)?tools?",
      "unmocked[\\s-]+(?:mcp[\\s-]+)?tools?(?:[\\s-]+[a-z0-9]+){0,3}?[\\s-]+(?:deny|denies|denied|fail|fails|failed)",
      "(?:deny|denies|denied)[\\s-]+unmocked[\\s-]+(?:mcp[\\s-]+)?tools?",
    ],
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
  {
    rowLabel: "Streaming usage chunks",
    keywords: [
      "stream_options",
      "include_usage",
      "streaming.*usage",
      "usage.*chunk",
      "usage.*stream",
    ],
  },
  {
    rowLabel: "Rate limiting headers",
    keywords: ["x-ratelimit", "rate.limit.*header", "retry-after", "429.*retry", "rate.limiting"],
  },
] as const satisfies readonly FeatureRule[];

/** The label of a FEATURE_RULES rule. */
export type RuleLabel = (typeof FEATURE_RULES)[number]["rowLabel"];

/**
 * Rules that intentionally have no row in the docs/index.html matrix, with the
 * reason. A detection of one of these rules never changes the homepage:
 * runMatrixUpdate() lists every row-less detection for manual follow-up.
 * The log identifies the competitor and capability. The summary also includes
 * what the competitor's migration page did with it (the page is updated when
 * it has a row for the rule). Every other rule must name a real homepage row;
 * the run fails if one does not, so a renamed row cannot silently stop the scan.
 */
export const MATRIX_ROWLESS_RULES: Partial<Record<RuleLabel, string>> = {
  "Realtime GA protocol": "The homepage folds Realtime into the WebSocket APIs row.",
  "Realtime Beta compatibility": "The homepage folds Realtime into the WebSocket APIs row.",
  "Realtime transcription/translation": "The homepage folds Realtime into the WebSocket APIs row.",
  "Realtime image input": "The homepage folds Realtime into the WebSocket APIs row.",
  "Realtime commentary phase": "The homepage folds Realtime into the WebSocket APIs row.",
  "Azure OpenAI": "The homepage counts providers in the free-text Multi-provider support row.",
  "AWS Bedrock": "The homepage counts providers in the free-text Multi-provider support row.",
  "Docker image":
    'The homepage row is the combined "Docker + Helm"; one signal must not mark both as supported.',
  "Helm chart":
    'The homepage row is the combined "Docker + Helm"; one signal must not mark both as supported.',
  "CLI server": "The homepage matrix has no CLI row.",
  "GET /v1/models": "The homepage matrix has no models-endpoint row.",
};

/**
 * True when `label` is an own key of MATRIX_ROWLESS_RULES. An `in` check would
 * also match names inherited from Object.prototype, such as "constructor".
 */
export function isRowlessRule(label: string): boolean {
  return Object.hasOwn(MATRIX_ROWLESS_RULES, label);
}

/**
 * Maps each competitor display name to its migration page path, relative to
 * the repository root. Every competitor in COMPETITORS must have one: the run
 * fails when a scanned competitor has no page, or its page is missing.
 */
export const COMPETITOR_MIGRATION_PAGES: Record<string, string> = {
  VidaiMock: "docs/migrate-from-vidaimock/index.html",
  "mock-llm": "docs/migrate-from-mock-llm/index.html",
  "piyook/llm-mock": "docs/migrate-from-piyook/index.html",
  "mokksy/ai-mocks": "docs/migrate-from-mokksy/index.html",
  // MSW and Python don't have GitHub repos in COMPETITORS[] yet
};

// ── Helpers ──────────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes("--dry-run");

const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const HEADERS: Record<string, string> = {
  Accept: "application/vnd.github.v3+json",
  "User-Agent": "aimock-competitive-matrix-updater",
  ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
};

/**
 * Result of fetching one file from a competitor repo. "missing" (HTTP 404) is
 * a real answer: the file is not in the repo. "failed" means we could not see
 * the file at all (network error, auth, rate limit, 5xx, malformed response),
 * so the scan must not treat it as "nothing changed".
 */
export type FetchResult =
  | { status: "ok"; text: string }
  | { status: "missing" }
  | { status: "failed"; reason: string };

/** A source that could not be fetched, recorded per competitor and file. */
export interface FetchFailure {
  competitor: string;
  repo: string;
  source: string;
  reason: string;
}

async function fetchRepoFile(repo: string, source: string, path: string): Promise<FetchResult> {
  const url = `https://api.github.com/repos/${repo}/${path}`;
  console.log(`  Fetching ${source} from ${repo}...`);
  try {
    const res = await fetch(url, { headers: HEADERS });
    if (res.status === 404) return { status: "missing" };
    if (!res.ok) {
      return { status: "failed", reason: `HTTP ${res.status} ${res.statusText}`.trim() };
    }
    const json = (await res.json()) as { content?: string; encoding?: string; size?: number };
    if (typeof json.content === "string" && json.encoding === "base64") {
      return { status: "ok", text: Buffer.from(json.content, "base64").toString("utf-8") };
    }
    // Files over 1 MB come back with empty content and encoding "none"; GitHub
    // serves their contents only with the raw media type.
    if (json.encoding === "none") {
      const raw = await fetch(url, {
        headers: { ...HEADERS, Accept: "application/vnd.github.raw" },
      });
      if (raw.ok) return { status: "ok", text: await raw.text() };
      return {
        status: "failed",
        reason:
          `file too large for the JSON response (${json.size ?? "unknown"} bytes); ` +
          `raw fetch failed: ${`HTTP ${raw.status} ${raw.statusText}`.trim()}`,
      };
    }
    return { status: "failed", reason: "response had no base64 content" };
  } catch (err) {
    return { status: "failed", reason: err instanceof Error ? err.message : String(err) };
  }
}

/** The README is the primary source: every competitor repo is expected to have one. */
function fetchReadme(repo: string): Promise<FetchResult> {
  return fetchRepoFile(repo, "README", "readme");
}

/** package.json is optional: non-JS competitors (Rust, Kotlin) do not have one. */
function fetchPackageJson(repo: string): Promise<FetchResult> {
  return fetchRepoFile(repo, "package.json", "contents/package.json");
}

/**
 * Why a competitor's README cannot be scanned, or null when it can. The README
 * must be found and non-empty. A 404 also states the package.json outcome when
 * that leaves the competitor with no source to scan at all.
 */
function describeReadmeFailure(readme: FetchResult, pkg: FetchResult): string | null {
  switch (readme.status) {
    case "failed":
      return readme.reason;
    case "missing":
      return pkg.status === "missing"
        ? "not found (HTTP 404), and package.json not found (HTTP 404): no source to scan"
        : "not found (HTTP 404)";
    case "ok":
      return readme.text.trim() === "" ? "README is empty" : null;
  }
}

/**
 * Builds a case-insensitive regex for a keyword that will only match when the
 * pattern is bounded by non-alphanumeric characters (or string edges). This
 * prevents short tokens from matching as substrings of larger words — e.g.
 * "cli" must not match "client"/"click", "sse" must not match "assess". The
 * boundary lookarounds constrain the surrounding text only, so keywords that
 * are themselves regexes (`stream.*true`, `output_text\.delta`) keep working.
 * The lookarounds apply to every keyword, including ones that begin or end
 * with non-word characters: `/v1/models` matches only when the character
 * before the `/` is not a letter or digit, so it does not match inside a URL
 * such as `localhost:4010/v1/models`.
 */
function keywordRegex(kw: string): RegExp {
  return new RegExp(`(?<![a-z0-9])(?:${kw.toLowerCase()})(?![a-z0-9])`, "i");
}

export function extractFeatures(text: string): Record<string, boolean> {
  const lower = text.toLowerCase();
  const result: Record<string, boolean> = {};
  for (const rule of FEATURE_RULES) {
    const found = rule.keywords.some((kw) => keywordRegex(kw).test(lower));
    result[rule.rowLabel] = found;
  }
  return result;
}

/**
 * Counts how many distinct LLM providers a competitor supports based on their
 * README text. De-duplicates overlapping patterns (e.g. "anthropic" and "claude"
 * both map to the same provider).
 */
export function countProviders(text: string): number {
  const lower = text.toLowerCase();

  // Group patterns that refer to the same provider. Each provider appears in
  // exactly ONE group so it is counted at most once (e.g. "gemini interactions"
  // is still just Gemini, not a separate provider).
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
    ["elevenlabs"],
  ];

  // Word-boundary matching so "cohere" does not match "coherent", "aws" does
  // not match "flaws", etc.
  let count = 0;
  for (const group of providerGroups) {
    const found = group.some((kw) => keywordRegex(kw).test(lower));
    if (found) count++;
  }
  return count;
}

// ── Migration Page Updating ─────────────────────────────────────────────────
//
// Migration page tables use a different format than the index.html matrix:
// - "Yes" cells: <td style="color: var(--accent)">&#10003;</td>
// - "No" cells:  <td style="color: var(--error)">&#10007;</td>
// Their row labels are more descriptive than the homepage's, so each rule
// names its migration-page labels in buildMigrationRowPatterns, and a row that
// combines several capabilities is listed in MIGRATION_COMBINED_ROWS.

/** The comparison table of a migration page (both class names are in use). */
const MIGRATION_TABLE_RE = /<table class="(?:comparison-table|endpoint-table)">([\s\S]*?)<\/table>/;

/** The migration-page markup for a "yes" cell. */
const MIGRATION_YES_CELL = '<td style="color: var(--accent)">&#10003;</td>';

/**
 * Migration-page rows that combine several capabilities, with the rules each
 * one covers. One detection must not mark the whole row as supported, so such
 * a row is never flipped: a detection whose cell there shows "no" is listed
 * for a manual check instead.
 */
export const MIGRATION_COMBINED_ROWS: Readonly<Record<string, readonly RuleLabel[]>> = {
  "Azure OpenAI / Vertex AI / Ollama / Cohere": ["Azure OpenAI"],
  "AWS Bedrock / Azure / Vertex AI / Ollama / Cohere": ["AWS Bedrock", "Azure OpenAI"],
  "Docker / Helm": ["Docker image", "Helm chart"],
  "MCP / A2A / AG-UI / Vector": ["AG-UI event mocking", "MCP tool mocking"],
  "MCP / A2A / AG-UI / Vector mocking": ["AG-UI event mocking", "MCP tool mocking"],
};

/** What updateMigrationPage did with one detected rule on one row. */
export type MigrationRowStatus =
  /** The competitor's cell showed "no" and now shows "yes". */
  | "flipped"
  /** The competitor's cell does not show "no"; nothing to change. */
  | "not-no"
  /** The row combines several capabilities and the cell shows "no": check by hand. */
  | "combined-row"
  /** The cell shows "no" in a shape the scan cannot flip: check by hand. */
  | "unsupported-no-cell"
  /** The page has no row for the rule. */
  | "no-row";

export interface MigrationRowOutcome {
  /** The FEATURE_RULES label of the detection. */
  rule: string;
  /** The plain-text row label, or null when the page has no row for the rule. */
  row: string | null;
  /** True when the row is in MIGRATION_COMBINED_ROWS. */
  combined: boolean;
  status: MigrationRowStatus;
}

/** One body row of a migration-page table. */
interface MigrationRow {
  /** Plain-text label (the first cell, character references decoded). */
  label: string;
  cells: RowCell[];
}

/** A migration page's comparison table, checked and read. */
interface MigrationTable {
  /** The whole <table>...</table> HTML. */
  full: string;
  /** The competitor's cell index within each row. */
  colIdx: number;
  rows: MigrationRow[];
}

/** Plain text of a cell: tags removed, character references decoded. */
function cellText(inner: string): string {
  return decodeHTML(inner.replace(/<[^>]*>/g, "")).trim();
}

/**
 * Finds the 0-based cell index of a competitor's column in a migration-page
 * table by matching the <thead> header cell text to the competitor name.
 * Header cells are the <th> and <td> cells inside <thead>; the leading
 * "Capability" header (or an empty corner cell) is index 0 and aligns with
 * the label cell of each body row, so the returned index can be used directly
 * against a row's cells. Matching is case-insensitive and token-aware: header
 * text "Mokksy" matches the competitor key "mokksy/ai-mocks" by its leading
 * token, while the "aimock" header does not match "VidaiMock" (a plain
 * substring test would). Returns -1 when no column matches, and -2 when more
 * than one does.
 */
function findMigrationCompetitorColumn(tableHtml: string, competitorName: string): number {
  const thead = tableHtml.match(/<thead\b[^>]*>([\s\S]*?)<\/thead>/)?.[1] ?? "";
  const headers = splitRowCells(thead).map((cell) => cellText(cell.inner).toLowerCase());
  const comp = competitorName.toLowerCase();
  const compToken = comp.split("/")[0]; // "mokksy/ai-mocks" -> "mokksy"
  const matches = headers
    .map((h, i) => (h.length > 0 && (h === comp || h === compToken || h.includes(comp)) ? i : -1))
    .filter((i) => i >= 0);
  if (matches.length > 1) return -2;
  return matches[0] ?? -1;
}

/**
 * Reads a migration page's comparison table. Throws when the page has no
 * table, no <thead> or <tbody>, no column (or more than one) for the
 * competitor, a colspan cell, a body row whose cell count does not match the
 * header, or two rows with the same label: the scan would otherwise skip the
 * page, or change the wrong cell, without a report.
 */
function readMigrationTable(html: string, competitorName: string): MigrationTable {
  const tableMatch = html.match(MIGRATION_TABLE_RE);
  if (!tableMatch) {
    throw new Error(
      'The migration page has no <table class="comparison-table"> or "endpoint-table".',
    );
  }
  const [full, inner] = tableMatch;
  const thead = inner.match(/<thead\b[^>]*>([\s\S]*?)<\/thead>/)?.[1];
  const tbody = inner.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/)?.[1];
  if (thead === undefined || tbody === undefined) {
    throw new Error("The migration page table has no <thead> or no <tbody>.");
  }
  const headerCells = splitRowCells(thead);
  if (headerCells.some((cell) => COLSPAN_RE.test(cell.open))) {
    throw new Error(
      "The migration page table header has a colspan cell. colspan is not supported: " +
        "give each column its own header cell.",
    );
  }
  const colIdx = findMigrationCompetitorColumn(full, competitorName);
  if (colIdx === -2) {
    throw new Error(`The migration page table has more than one column for ${competitorName}.`);
  }
  if (colIdx <= 0) {
    throw new Error(`The migration page table has no column for ${competitorName}.`);
  }

  const rows: MigrationRow[] = [];
  const labels = new Set<string>();
  for (const tr of tbody.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = splitRowCells(tr[1]);
    if (cells.length === 0) continue;
    const label = rowLabelText(cells[0]);
    assertRowMatchesHeader(label, cells, headerCells.length, "Migration page table");
    if (labels.has(label)) {
      throw new Error(`Duplicate row label in the migration page table: "${label}".`);
    }
    labels.add(label);
    rows.push({ label, cells });
  }
  return { full, colIdx, rows };
}

/**
 * Classifies a migration-page cell. "flippable" is the page's "no" cell (a
 * lone cross in an error-colored cell). A cell with any other "no" sign (a
 * cross, an error color, a `no` class, or text that starts with "No") is
 * "unsupported", so it is reported rather than taken as "yes".
 */
function classifyMigrationCell(cell: RowCell): "flippable" | "not-no" | "unsupported" {
  const isError = /var\(--error\)/.test(cell.open);
  const saysNo =
    isError ||
    countMatches(cell.inner, CROSS_RE) > 0 ||
    NO_CLASS_RE.test(cell.open) ||
    NO_CLASS_RE.test(cell.inner) ||
    /^no\b/i.test(cellText(cell.inner));
  if (!saysNo) return "not-no";
  const loneCross = new RegExp(String.raw`^\s*${CROSS_SRC}\s*$`, "i").test(cell.inner);
  return isError && loneCross ? "flippable" : "unsupported";
}

/**
 * Updates a competitor's migration page from its detections: each detected
 * rule's row (see buildMigrationRowPatterns) whose competitor cell shows the
 * page's "no" cell is flipped to "yes". Rows in MIGRATION_COMBINED_ROWS are
 * never flipped. Also raises numeric provider claims (see
 * updateProviderCounts).
 *
 * Returns the updated HTML, one change line per flipped row or provider
 * claim, and one outcome per detected rule and matching row (or one "no-row"
 * outcome when the page has no row for the rule), in FEATURE_RULES order.
 * Throws when the page's table cannot be read (see readMigrationTable).
 */
export function updateMigrationPage(
  html: string,
  competitorName: string,
  features: Record<string, boolean>,
  providerCount: number,
): { html: string; changes: string[]; outcomes: MigrationRowOutcome[] } {
  const table = readMigrationTable(html, competitorName);
  const changes: string[] = [];
  const outcomes: MigrationRowOutcome[] = [];
  const flips = new Set<string>(); // row labels to flip

  for (const rule of FEATURE_RULES) {
    if (!features[rule.rowLabel]) continue;
    const labels = buildMigrationRowPatterns(rule.rowLabel);
    let found = false;
    for (const row of table.rows) {
      const combined =
        Object.hasOwn(MIGRATION_COMBINED_ROWS, row.label) &&
        MIGRATION_COMBINED_ROWS[row.label].includes(rule.rowLabel);
      if (!combined && !labels.includes(row.label)) continue;
      found = true;
      const shape = classifyMigrationCell(row.cells[table.colIdx]);
      let status: MigrationRowStatus;
      if (shape === "not-no") status = "not-no";
      else if (combined) status = "combined-row";
      else if (shape === "unsupported") status = "unsupported-no-cell";
      else {
        status = "flipped";
        flips.add(row.label);
      }
      outcomes.push({ rule: rule.rowLabel, row: row.label, combined, status });
    }
    if (!found)
      outcomes.push({ rule: rule.rowLabel, row: null, combined: false, status: "no-row" });
  }

  let result = html;
  if (flips.size > 0) {
    const newTable = table.full.replace(
      /(<tbody\b[^>]*>)([\s\S]*?)(<\/tbody>)/,
      (_m, tbodyOpen: string, tbodyInner: string, tbodyClose: string) =>
        tbodyOpen +
        tbodyInner.replace(
          /(<tr\b[^>]*>)([\s\S]*?)(<\/tr>)/g,
          (trMatch, trOpen: string, trInner: string, trClose: string) => {
            const cells = splitRowCells(trInner);
            if (cells.length === 0) return trMatch;
            const label = rowLabelText(cells[0]);
            if (!flips.has(label)) return trMatch;
            let idx = 0;
            const newInner = trInner.replace(/<(th|td)\b[^>]*>[\s\S]*?<\/\1>/g, (cell) =>
              idx++ === table.colIdx ? MIGRATION_YES_CELL : cell,
            );
            changes.push(`${competitorName}: ${label} ✗ -> ✓`);
            return trOpen + newInner + trClose;
          },
        ) +
        tbodyClose,
    );
    // Function-form replacement keeps the HTML literal (a $ / $& / $1 in the
    // table must not be interpreted by String.replace).
    result = html.replace(table.full, () => newTable);
  }

  // Update provider count claims in the competitor column of the table
  // Match patterns like: >N providers<, >N+ providers<
  if (providerCount > 0) {
    result = updateProviderCounts(result, competitorName, providerCount, changes);
  }

  return { html: result, changes, outcomes };
}

/**
 * Builds possible row label strings that a migration page might use for a given
 * feature rule. Migration pages use more descriptive labels than the index matrix.
 * Rows that combine several capabilities are in MIGRATION_COMBINED_ROWS instead.
 */
export function buildMigrationRowPatterns(rowLabel: string): string[] {
  const patterns = [rowLabel];

  // Add common migration-page variants
  const variants: Record<string, string[]> = {
    "Chat Completions SSE": ["OpenAI Chat Completions", "Streaming SSE"],
    "Responses API SSE": ["OpenAI Responses API"],
    "Claude Messages API": ["Anthropic Claude"],
    "Gemini streaming": ["Google Gemini"],
    "OpenRouter router / fallback simulation": ["OpenRouter routing", "Model fallback/failover"],
    "WebSocket APIs": ["WebSocket protocols"],
    "Structured output / JSON mode": ["Structured output / JSON mode", "Structured output"],
    "Sequential / stateful responses": ["Sequential responses"],
    "Docker image": ["Docker"],
    "Helm chart": ["Kubernetes / Helm"],
    "CLI server": ["CLI"],
    "Request journal": ["Request journal"],
    "Drift detection": ["Drift detection"],
    "AG-UI event mocking": ["AG-UI event mocking", "AG-UI mocking", "AG-UI"],
    "MCP tool mocking": ["MCP protocol mocking", "MCP mock"],
    "Realtime GA protocol": ["Realtime GA protocol", "GA Realtime"],
    "Realtime Beta compatibility": ["Realtime Beta compatibility", "Beta Realtime"],
    "Realtime transcription/translation": [
      "Realtime transcription/translation",
      "Realtime translate/whisper",
      "Translate/Whisper",
    ],
    "Realtime image input": ["Realtime image input"],
    "Realtime commentary phase": ["Realtime commentary phase", "Commentary phase"],
    "Image editing": ["Image editing", "Image edit"],
    "Audio translation": ["Audio translation", "Audio translations"],
    "Streaming usage chunks": ["Streaming usage chunks", "Streaming usage"],
    "Rate limiting headers": ["Rate limiting headers", "Rate limiting"],
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
export function updateProviderCounts(
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

    // Find the competitor's column index by header name (shared with the
    // feature-cell updater so both locate the same column).
    const compColIdx = findMigrationCompetitorColumn(fullTable, competitorName);

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
              // Function-form replacement keeps `updated` literal.
              return tdMatch.replace(tdContent, () => updated);
            }
            return tdMatch;
          });
        },
      );

      // Function-form replacement keeps `updatedTable` literal so any $-sequence
      // in the HTML is not interpreted by String.replace.
      result = result.replace(fullTable, () => updatedTable);
    }
  }

  // Strategy 2: Replace provider counts in prose paragraphs/sentences that
  // explicitly mention the competitor by name.
  // The text before the number is lazy and the number may not follow a digit,
  // so the whole number is read: a greedy prefix would leave only the last
  // digit ("12 providers" read as 2). The count is only ever raised.
  const prosePattern = new RegExp(
    `(<[^>]*>[^<]*?${escapedName}[^<]*?)(?<!\\d)(\\d+)\\+?\\s*(?:LLM\\s*)?providers?`,
    "gi",
  );
  result = result.replace(prosePattern, (match, prefix: string, numStr: string) => {
    const currentCount = parseInt(numStr, 10);
    if (detectedCount > currentCount) {
      changes.push(`${competitorName}: provider count ${currentCount} -> ${detectedCount} (prose)`);
      return `${prefix}${detectedCount} providers`;
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

/** The page's markup for a "yes" mark in a competitor cell. */
const YES_MARK = '<span class="yes" role="img" aria-label="Yes">&#10003;</span>';

/** One cell (<th> or <td>) of a table row. */
interface RowCell {
  /** The cell's opening tag, e.g. `<td class="col-aimock">` */
  open: string;
  /** The cell's inner HTML, untrimmed */
  inner: string;
}

/**
 * Splits a <tr>'s inner HTML into its cells in order. The homepage labels
 * each row with a <th scope="row"> and uses <td> for the data cells, so both
 * tags count as cells.
 */
function splitRowCells(trInner: string): RowCell[] {
  const cells: RowCell[] = [];
  const cellRe = /(<(th|td)\b[^>]*>)([\s\S]*?)<\/\2>/g;
  let m: RegExpExecArray | null;
  while ((m = cellRe.exec(trInner)) !== null) {
    cells.push({ open: m[1], inner: m[3] });
  }
  return cells;
}

/** Matches a colspan attribute on a cell's opening tag. */
const COLSPAN_RE = /\scolspan\s*=/i;

interface HeaderLink {
  /**
   * The link text with character references decoded, like a row label. Markup
   * inside the link text is kept, so such a header matches no competitor and
   * the scan reports it instead of guessing.
   */
  name: string;
  /** The link's href attribute, raw, or undefined when it has none. */
  href: string | undefined;
}

/**
 * Returns the first <a> link in a header cell, or null when the cell has none.
 * `<a\b` with a following space or `>` matches only an <a> tag, never <abbr>
 * or another tag that starts with "a". The name is decoded with the same
 * decoder as row labels, so a header such as "Search &amp; Co" matches the
 * competitor name "Search & Co".
 */
function headerCellLink(cell: RowCell): HeaderLink | null {
  const link = cell.inner.match(/<a(?=[\s>])([^>]*)>([\s\S]*?)<\/a>/);
  if (!link) return null;
  return {
    name: decodeHTML(link[2]).trim(),
    href: link[1].match(/\bhref="([^"]*)"/)?.[1],
  };
}

/**
 * Returns the <thead> header cells' links in page order (null for a cell with
 * no link, such as the "Capability" column). The array index is the cell index
 * within every body row. Throws on a colspan header cell.
 */
function parseHeaderLinks(tableHtml: string): (HeaderLink | null)[] {
  const thead = tableHtml.match(/<thead>([\s\S]*?)<\/thead>/)?.[1] ?? "";
  const cells = splitRowCells(thead);
  if (cells.some((cell) => COLSPAN_RE.test(cell.open))) {
    throw new Error(
      "The homepage matrix header has a colspan cell. colspan is not supported: " +
        "give each column its own header cell.",
    );
  }
  return cells.map(headerCellLink);
}

/**
 * Reads the column names from the table's <thead>: the decoded link text of
 * each header cell, or null for a header with no link (the "Capability"
 * column). The array index is the cell index within every body row.
 */
function parseHeaderColumns(tableHtml: string): (string | null)[] {
  return parseHeaderLinks(tableHtml).map((link) => link?.name ?? null);
}

/**
 * Throws, naming the row, unless the body row has exactly one cell per header
 * column. A row with fewer cells leaves the competitors in the columns it does
 * not reach with no cell, so their detections would be dropped without a
 * report; a row with more cells has cells that belong to no column.
 *
 * colspan is rejected, not expanded: each cell must belong to exactly one
 * column, so a flip changes the mark of one competitor only. parse and apply
 * both call this, so they agree on which rows they accept. Migration pages use
 * it too, with `table` naming the page's table in the message.
 */
function assertRowMatchesHeader(
  rowLabel: string,
  cells: RowCell[],
  columnCount: number,
  table = "Homepage matrix",
): void {
  if (cells.some((cell) => COLSPAN_RE.test(cell.open))) {
    throw new Error(
      `${table} row "${rowLabel}" has a colspan cell. colspan is not supported: ` +
        "give each column its own cell.",
    );
  }
  if (cells.length !== columnCount) {
    throw new Error(
      `${table} row "${rowLabel}" has ${cells.length} cells but the header has ` +
        `${columnCount} columns. Give the row one cell per column.`,
    );
  }
}

/**
 * Throws when two <thead> columns share a link text or a link target. The
 * parsed row map would keep only the last such column while applyChanges flips
 * only the first, so a detection would land in one column and be read back
 * from the other.
 */
function assertUniqueHeaderColumns(tableHtml: string): void {
  const nameByHref = new Map<string, string>();
  const names = new Set<string>();
  for (const link of parseHeaderLinks(tableHtml)) {
    if (!link) continue;
    const { name, href } = link;
    const duplicateOf = names.has(name) ? name : href ? nameByHref.get(href) : undefined;
    if (duplicateOf !== undefined) {
      throw new Error(
        `Duplicate competitor column in the homepage matrix: "${duplicateOf}". ` +
          "Give each comparison-table column a unique name and link.",
      );
    }
    names.add(name);
    if (href) nameByHref.set(href, name);
  }
}

/**
 * Returns a row's label (its first cell) as plain text, with HTML character
 * references decoded, so rules and lookups use the text a reader sees.
 */
function rowLabelText(cell: RowCell): string {
  return decodeHTML(cell.inner).trim();
}

/**
 * Parses the comparison table from docs/index.html.
 * Returns the competitor headers and a map: plain-text rowLabel -> { header -> cell inner HTML }
 */
export function parseCurrentMatrix(html: string): {
  headers: string[];
  rows: Map<string, Map<string, string>>;
} {
  // Extract the table between <table class="comparison-table"> and </table>
  const tableMatch = html.match(/<table class="comparison-table">([\s\S]*?)<\/table>/);
  if (!tableMatch) {
    throw new Error("Could not find comparison-table in HTML");
  }
  const tableHtml = tableMatch[1];

  const columns = parseHeaderColumns(tableHtml);
  // headers = ["aimock", "MSW", ...competitors]
  const headers = columns.filter((c): c is string => c !== null);
  assertUniqueHeaderColumns(tableHtml);

  const rows = new Map<string, Map<string, string>>();
  const tbody = tableHtml.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? "";
  const trIter = /<tr\b[^>]*>([\s\S]*?)<\/tr>/g;
  let tr: RegExpExecArray | null;

  while ((tr = trIter.exec(tbody)) !== null) {
    const cells = splitRowCells(tr[1]);
    if (cells.length === 0) continue;

    // The first cell (<th scope="row"> on the homepage) is the row label.
    const rowLabel = rowLabelText(cells[0]);
    // A repeated label would silently overwrite the earlier row here, and
    // applyChanges would then flip the cell in every row with that label.
    if (rows.has(rowLabel)) {
      throw new Error(
        `Duplicate row label in the homepage matrix: "${rowLabel}". ` +
          "Give each comparison-table row a unique label.",
      );
    }
    assertRowMatchesHeader(rowLabel, cells, columns.length);
    const rowMap = new Map<string, string>();
    for (let i = 1; i < cells.length; i++) {
      const name = columns[i];
      if (name !== null) rowMap.set(name, cells[i].inner.trim());
    }
    rows.set(rowLabel, rowMap);
  }

  return { headers, rows };
}

/**
 * Returns the labels of rules that name no row in the parsed matrix and are
 * not listed in MATRIX_ROWLESS_RULES. A non-empty result means the homepage
 * and FEATURE_RULES have drifted apart.
 */
export function findUnmatchedRules(matrix: { rows: Map<string, Map<string, string>> }): string[] {
  return FEATURE_RULES.map((r) => r.rowLabel).filter(
    (label) => !matrix.rows.has(label) && !isRowlessRule(label),
  );
}

/**
 * Throws when findUnmatchedRules reports any rule. main() calls this before it
 * computes changes, so homepage/rule drift stops the scan.
 */
export function assertRulesMatchMatrix(matrix: { rows: Map<string, Map<string, string>> }): void {
  const unmatched = findUnmatchedRules(matrix);
  if (unmatched.length > 0) {
    throw new Error(
      `FEATURE_RULES name rows missing from the homepage matrix: ${unmatched.join(", ")}. ` +
        "Rename the rule to the real row label or list it in MATRIX_ROWLESS_RULES.",
    );
  }
}

/**
 * Returns the names of tracked competitors that have no column in the parsed
 * matrix. A header that was renamed, or that lost its link, leaves its
 * competitor here. A non-empty result means the homepage and COMPETITORS have
 * drifted apart, and that competitor's detected changes would be dropped.
 */
export function findUnmatchedCompetitors(matrix: { headers: string[] }): string[] {
  return COMPETITORS.map((c) => c.name).filter((name) => !matrix.headers.includes(name));
}

// ── "No" cells: one definition for recognition and flipping ─────────────────
//
// A cell shows "no" when it has any no-marker: a `no` class token on the cell
// tag or on any element inside it, or a cross mark. computeChanges reports a
// change for every such cell. applyChanges flips only the supported shapes
// below and reports every other no-cell as unapplied, so a cell is never
// half-flipped and never dropped without a report.
//
// Supported shapes (cell inner HTML, after the cell's open tag):
//   1. Text, one `<span class="no" ...>` that holds only a cross mark, text.
//      The span's class must be exactly `no`; other attributes and either
//      quote style are allowed. The cell tag must not have a `no` class.
//      The span becomes YES_MARK. The real homepage uses only this shape:
//      `<td><span class="no" role="img" aria-label="No">&#10007;</span></td>`.
//   2. Text only, with exactly one cross mark. The cross becomes YES_MARK,
//      and a `no` class token on the cell tag becomes `yes`.
// In both shapes the surrounding text must have no tags and no other cross.
//
// After a flip, checkFlippedCell must find no no-marker and exactly one yes
// mark in the result, or the change is reported unapplied.

/** A cross mark: the glyph, or its decimal or hex character reference. */
const CROSS_SRC = String.raw`(?:✗|&#10007;|&#x2717;)`;
const CROSS_RE = new RegExp(CROSS_SRC, "gi");
/** A check mark: the glyph, or its decimal or hex character reference. */
const CHECK_RE = /✓|&#10003;|&#x2713;/gi;
/**
 * A `no` token in any class attribute, quoted or not. It is deliberately
 * loose: it also finds the token in a tag the shape patterns cannot read, so
 * such a cell is still recognized (and then reported as unsupported).
 */
const NO_CLASS_RE = /\sclass\s*=\s*["']?(?:[^"'<>]*\s)?no(?![\w-])/i;
/** One start-tag attribute: name, then an optional double/single/un-quoted value. */
const ATTR_SRC = String.raw`\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>\x60]+))?`;
const ATTR_RE = /\s+([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>\x60]+)))?/g;
/** Supported shape 1, anchored to the whole inner HTML. */
const NO_SPAN_CELL_RE = new RegExp(
  String.raw`^([^<]*)<span((?:${ATTR_SRC})*)\s*>\s*${CROSS_SRC}\s*</span>([^<]*)$`,
  "i",
);
/** The attribute part of a cell's open tag, e.g. ` class="no"` of `<td class="no">`. */
const OPEN_TAG_ATTRS_RE = /^<[a-z][\w-]*((?:\s+[^>]*)?)>$/i;

function countMatches(text: string, re: RegExp): number {
  return text.match(re)?.length ?? 0;
}

/** The class tokens of a start tag's attribute string; empty when it has none. */
function classTokens(attrs: string): string[] {
  for (const m of attrs.matchAll(ATTR_RE)) {
    if (m[1].toLowerCase() === "class") {
      return (m[2] ?? m[3] ?? m[4] ?? "").split(/\s+/).filter(Boolean);
    }
  }
  return [];
}

/** True when the cell (its open tag or inner HTML) has any no-marker. */
function hasNoMarker(open: string, inner: string): boolean {
  return NO_CLASS_RE.test(open) || NO_CLASS_RE.test(inner) || countMatches(inner, CROSS_RE) > 0;
}

export type NoCellShape =
  /** The cell has no no-marker. */
  | { kind: "not-no" }
  /** The cell shows "no" in a shape the flip does not support. */
  | { kind: "unsupported" }
  /** The cell shows "no" in a supported shape; `open`/`inner` are the flip result. */
  | { kind: "flippable"; open: string; inner: string };

/**
 * Classifies a cell against the supported no-cell shapes (see above) and,
 * for a supported shape, returns the flipped cell. computeChanges and
 * applyChanges both use this, so they agree on which cells are "no".
 */
export function classifyNoCell(open: string, inner: string): NoCellShape {
  if (!hasNoMarker(open, inner)) return { kind: "not-no" };
  const cellAttrs = open.match(OPEN_TAG_ATTRS_RE)?.[1] ?? "";
  const cellIsNo = classTokens(cellAttrs).includes("no");
  const textOk = (text: string): boolean => countMatches(text, CROSS_RE) === 0;

  const span = inner.match(NO_SPAN_CELL_RE);
  if (span) {
    const [, before, spanAttrs, after] = span;
    const spanClasses = classTokens(spanAttrs);
    if (
      !cellIsNo &&
      spanClasses.length === 1 &&
      spanClasses[0] === "no" &&
      textOk(before) &&
      textOk(after)
    ) {
      return { kind: "flippable", open, inner: before + YES_MARK + after };
    }
    return { kind: "unsupported" };
  }

  if (!inner.includes("<") && countMatches(inner, CROSS_RE) === 1) {
    // Function-form replacement keeps YES_MARK literal for String.replace.
    const flipped = inner.replace(new RegExp(CROSS_SRC, "i"), () => YES_MARK);
    return { kind: "flippable", open: cellIsNo ? flipCellOpenTag(open) : open, inner: flipped };
  }
  return { kind: "unsupported" };
}

/** True when a flipped cell has no no-marker and exactly one yes mark. */
function checkFlippedCell(open: string, inner: string): boolean {
  return (
    !hasNoMarker(open, inner) &&
    inner.split(YES_MARK).length === 2 &&
    countMatches(inner, CHECK_RE) === 1
  );
}

/**
 * Reads every body row of the comparison table as its cells, keyed by the
 * row's plain-text label, with the header columns. Null when the page has no
 * comparison table.
 */
function readTableCells(
  html: string,
): { columns: (string | null)[]; rows: Map<string, RowCell[]> } | null {
  const tableHtml = html.match(/<table class="comparison-table">([\s\S]*?)<\/table>/)?.[1];
  if (tableHtml === undefined) return null;
  const columns = parseHeaderColumns(tableHtml);
  const rows = new Map<string, RowCell[]>();
  const tbody = tableHtml.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? "";
  for (const tr of tbody.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = splitRowCells(tr[1]);
    if (cells.length > 0) rows.set(rowLabelText(cells[0]), cells);
  }
  return { columns, rows };
}

/**
 * Computes the "No" -> "Yes" changes for the competitors in
 * competitorFeatures (not aimock or MSW): one change for each detected feature
 * whose matrix row exists and whose current cell shows "no". A cell shows
 * "no" when it has a no-marker (a `no` class token on the cell tag or on an
 * element inside it, or a cross mark). The cell's open tag is read from
 * `html`, so a `<td class="no">` with no inner marker counts.
 *
 * Every "no" cell is reported, whether or not its shape is one applyChanges
 * can flip; applyChanges reports an unsupported shape as unapplied.
 * It does not modify the HTML; applyChanges does that. Never downgrades.
 */
export function computeChanges(
  html: string,
  matrix: { headers: string[]; rows: Map<string, Map<string, string>> },
  competitorFeatures: Map<string, Record<string, boolean>>,
): DetectedChange[] {
  const changes: DetectedChange[] = [];
  const table = readTableCells(html);

  for (const [compName, features] of competitorFeatures) {
    for (const [rowLabel, detected] of Object.entries(features)) {
      if (!detected) continue;

      const row = matrix.rows.get(rowLabel);
      if (!row) continue;

      // An empty cell is stored as "", so test for a missing column only.
      const currentCell = row.get(compName);
      if (currentCell === undefined) continue;

      // Only upgrade "No" cells — leave "Yes", "Partial", "Manual", etc. alone.
      // The open tag comes from the page itself, since the matrix holds only
      // each cell's inner HTML.
      const colIdx = table?.columns.indexOf(compName) ?? -1;
      const open = (colIdx > 0 && table?.rows.get(rowLabel)?.[colIdx]?.open) || "";
      if (classifyNoCell(open, currentCell).kind !== "not-no") {
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

/** Why applyChanges could not place a change in the homepage table. */
export type UnappliedReason =
  /** No <thead> column has the competitor's name. */
  | "unknown-competitor"
  /** No body row has the capability as its label. */
  | "row-not-found"
  /** The row exists but the competitor's cell is not in the "no" state. */
  | "cell-not-no"
  /** The cell shows "no", but not in a shape applyChanges can flip. */
  | "unsupported-no-cell"
  /** The flipped cell still had a no-marker or not exactly one yes mark. */
  | "flip-check-failed";

export interface UnappliedChange {
  change: DetectedChange;
  reason: UnappliedReason;
}

export interface ApplyChangesResult {
  html: string;
  /** Changes whose cell was flipped, in input order. */
  applied: DetectedChange[];
  /** Changes that could not be placed, in input order, with the reason. */
  unapplied: UnappliedChange[];
}

/**
 * Applies detected changes to the HTML string. Each target cell is located by
 * its row label (the row's first cell) and its column (the <thead> header
 * with the competitor's name). Only cells in a supported no-cell shape are
 * flipped (see classifyNoCell): the cell's one "no" mark becomes the page's
 * "yes" mark, and any other text in the cell is kept. A "no" cell in any
 * other shape is left unchanged and reported as "unsupported-no-cell". Each
 * flip is then checked (checkFlippedCell); a result that still shows "no", or
 * does not have exactly one yes mark, is discarded and reported as
 * "flip-check-failed".
 *
 * Returns the updated HTML together with the changes that were applied and
 * the changes that could not be placed, so the caller never reports a change
 * the page does not show. Throws, naming the row, when a body row's cell count
 * does not match the header or a cell has colspan (see assertRowMatchesHeader),
 * and when a header cell has colspan (see parseHeaderLinks).
 */
export function applyChanges(html: string, changes: DetectedChange[]): ApplyChangesResult {
  if (changes.length === 0) return { html, applied: [], unapplied: [] };

  const tableMatch = html.match(/<table class="comparison-table">([\s\S]*?)<\/table>/);
  if (!tableMatch) {
    return {
      html,
      applied: [],
      unapplied: changes.map((change) => ({ change, reason: "row-not-found" as const })),
    };
  }
  const fullTable = tableMatch[0];
  const columns = parseHeaderColumns(tableMatch[1]);

  // rowLabel -> cell indices to flip
  const targets = new Map<string, Set<number>>();
  const colIdxByChange = changes.map((change) => {
    const colIdx = columns.indexOf(change.competitor);
    if (colIdx <= 0) return -1; // unknown competitor, or the label column
    if (!targets.has(change.capability)) targets.set(change.capability, new Set());
    targets.get(change.capability)!.add(colIdx);
    return colIdx;
  });

  // What the table walk actually found and flipped.
  const rowsSeen = new Set<string>();
  const flipped = new Set<string>(); // `${rowLabel}\0${cellIdx}`
  const refused = new Map<string, UnappliedReason>(); // no-cells left unflipped
  const cellKey = (rowLabel: string, idx: number): string => `${rowLabel}\0${idx}`;

  const updatedTable =
    targets.size === 0
      ? fullTable
      : fullTable.replace(
          /(<tbody>)([\s\S]*?)(<\/tbody>)/,
          (_tbodyMatch, tbodyOpen: string, tbodyInner: string, tbodyClose: string) => {
            const newInner = tbodyInner.replace(
              /(<tr\b[^>]*>)([\s\S]*?)(<\/tr>)/g,
              (trMatch, trOpen: string, trInner: string, trClose: string) => {
                const cells = splitRowCells(trInner);
                if (cells.length === 0) return trMatch;
                const rowLabel = rowLabelText(cells[0]);
                // Same check as parseCurrentMatrix, on every body row: a cell
                // index is only a column index when the row matches the header.
                assertRowMatchesHeader(rowLabel, cells, columns.length);
                const cols = targets.get(rowLabel);
                if (!cols) return trMatch;
                rowsSeen.add(rowLabel);

                let cellIdx = 0;
                const newTrInner = trInner.replace(
                  /(<(th|td)\b[^>]*>)([\s\S]*?)(<\/\2>)/g,
                  (cellMatch, open: string, _tag: string, content: string, close: string) => {
                    const idx = cellIdx++;
                    if (!cols.has(idx)) return cellMatch;
                    const shape = classifyNoCell(open, content);
                    if (shape.kind === "not-no") return cellMatch;
                    if (shape.kind === "unsupported") {
                      refused.set(cellKey(rowLabel, idx), "unsupported-no-cell");
                      return cellMatch;
                    }
                    if (!checkFlippedCell(shape.open, shape.inner)) {
                      refused.set(cellKey(rowLabel, idx), "flip-check-failed");
                      return cellMatch;
                    }
                    flipped.add(cellKey(rowLabel, idx));
                    return shape.open + shape.inner + close;
                  },
                );
                return trOpen + newTrInner + trClose;
              },
            );
            return tbodyOpen + newInner + tbodyClose;
          },
        );

  const applied: DetectedChange[] = [];
  const unapplied: UnappliedChange[] = [];
  changes.forEach((change, i) => {
    const colIdx = colIdxByChange[i];
    if (colIdx < 0) unapplied.push({ change, reason: "unknown-competitor" });
    else if (!rowsSeen.has(change.capability)) unapplied.push({ change, reason: "row-not-found" });
    else if (!flipped.has(cellKey(change.capability, colIdx))) {
      const reason = refused.get(cellKey(change.capability, colIdx)) ?? "cell-not-no";
      unapplied.push({ change, reason });
    } else applied.push(change);
  });

  // Function-form replacement keeps the HTML-derived text literal so any
  // $ / $& / $1 in the table is not interpreted by String.replace.
  return { html: html.replace(fullTable, () => updatedTable), applied, unapplied };
}

/** Changes a `no` token in the cell tag's class attribute to `yes`. */
function flipCellOpenTag(open: string): string {
  return open.replace(
    /(\sclass\s*=\s*)(["'])([^"']*)\2/i,
    (_m, pre: string, quote: string, classes: string) =>
      pre + quote + classes.replace(/(^|\s)no(?=\s|$)/, "$1yes") + quote,
  );
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

// ── Summary Writing ──────────────────────────────────────────────────────────

/** The `--summary` path, or null. Repeated flags: the last one wins (see flagValues). */
function parseSummaryArg(): string | null {
  const value = flagValues(process.argv, "--summary").at(-1);
  return value === undefined ? null : resolve(value);
}

/** The `--watch-state` path, or null. Repeated flags: the last one wins (see flagValues). */
function parseWatchStateArg(): string | null {
  const value = flagValues(process.argv, "--watch-state").at(-1);
  return value === undefined ? null : resolve(value);
}

/** A migration-page cell or provider claim the run changed. */
export interface MigrationPageChange {
  /** Migration page path relative to the repo root */
  page: string;
  /** Change description from updateMigrationPage */
  change: string;
}

/**
 * A detection of a MATRIX_ROWLESS_RULES rule. No homepage row can hold it, so
 * the run reports it for manual follow-up.
 */
export interface RowlessDetection {
  competitor: string;
  capability: string;
  /** What the competitor's migration page did with it (see migrationStatusText). */
  migrationPage?: string;
}

/**
 * A detection whose migration-page cell shows "no" but that the run does not
 * flip: the row combines several capabilities, or the cell is in a shape the
 * scan cannot flip. The summary lists it for a manual check.
 */
export interface MigrationManualCheck {
  /** Migration page path relative to the repo root */
  page: string;
  competitor: string;
  capability: string;
  /** The plain-text row label on the migration page, or "none" when it has no row. */
  row: string;
  /**
   * "no-row": the homepage cell flips to "yes" but the migration page has no
   * row for the capability, so the two pages would disagree without a report.
   */
  reason: "combined-row" | "unsupported-no-cell" | "no-row";
}

/** One outcome as summary text, e.g. `"AWS Bedrock" ✗ -> ✓` or `no row`. */
export function migrationStatusText(outcome: MigrationRowOutcome): string {
  switch (outcome.status) {
    case "no-row":
      return "no row";
    case "flipped":
      return `"${outcome.row}" ✗ -> ✓`;
    case "not-no":
      return `"${outcome.row}" does not show no`;
    case "combined-row":
      return `"${outcome.row}" combines several capabilities: check by hand`;
    case "unsupported-no-cell":
      return `"${outcome.row}" shows no in a cell the scan cannot flip: check by hand`;
  }
}

/**
 * Builds the markdown summary. The homepage section lists the changes that
 * were applied; the migration-page, manual-check, row-less and fetch warning
 * sections follow it when non-empty. Unplaced changes never reach the summary:
 * writeMatrixUpdate throws before writing one.
 *
 * fetchWarnings are optional-source fetches that failed while the run went
 * on (a package.json fetch that failed when the README was found). The scan
 * of those competitors is incomplete, so the headline names them and never
 * says "no changes".
 *
 * The feature-watch section, when given, comes last.
 */
export function formatSummary(
  changes: DetectedChange[],
  migrationChanges: MigrationPageChange[] = [],
  rowless: RowlessDetection[] = [],
  fetchWarnings: FetchFailure[] = [],
  manualChecks: MigrationManualCheck[] = [],
  watch: FeatureWatchResult | null = null,
): string {
  let md: string;

  const incompleteRepos = [...new Set(fetchWarnings.map((w) => w.repo))];
  const incompleteHeadline =
    incompleteRepos.length > 0
      ? `Competitor scan results are incomplete for ${incompleteRepos.join(", ")}. ` +
        'See "Fetch Warnings" below.\n'
      : "";
  const watchReview = watch !== null && watchNeedsReview(watch);
  // A watch review is named in every headline, not only the watch-only one:
  // merging a docs PR also commits the watch state, which consumes the signal.
  const watchReviewLine = watchReview
    ? "Feature watch changes need a review; see the Feature watch section.\n"
    : "";

  if (changes.length === 0) {
    // No homepage change was computed. The headline must still say whether
    // anything below needs attention.
    if (incompleteHeadline !== "") {
      md = incompleteHeadline + watchReviewLine;
    } else if (migrationChanges.length === 0 && rowless.length === 0 && manualChecks.length === 0) {
      md = watchReview
        ? "No homepage competitive matrix changes this week. Feature watch changes need a review.\n"
        : "No competitive matrix changes detected this week.\n";
    } else if (rowless.length > 0 || manualChecks.length > 0) {
      md =
        "No homepage competitive matrix changes this week. Detections below need a manual check.\n" +
        watchReviewLine;
    } else {
      md = "No homepage competitive matrix changes this week.\n" + watchReviewLine;
    }
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

    const headline = incompleteHeadline + watchReviewLine;
    md = headline + (headline !== "" ? "\n" : "") + lines.join("\n");
  }

  if (migrationChanges.length > 0) {
    const lines = ["## Migration Page Changes", ""];
    for (const mc of migrationChanges) lines.push(`- \`${mc.page}\`: ${mc.change}`);
    lines.push("");
    md += "\n" + lines.join("\n");
  }

  if (manualChecks.length > 0) {
    const lines = [
      "## Migration Page Rows To Check By Hand",
      "",
      "The competitor's cell in these rows shows no, but the scan does not flip it: " +
        "a combined row covers several capabilities, and an unsupported cell is not in the page's usual cross shape. " +
        "A no-row entry is a homepage change whose migration page has no row for the capability: " +
        "add the row or map it in buildMigrationRowPatterns.",
      "",
      "| Page | Competitor | Capability | Row | Reason |",
      "| --- | --- | --- | --- | --- |",
    ];
    for (const m of manualChecks) {
      lines.push(`| \`${m.page}\` | ${m.competitor} | ${m.capability} | ${m.row} | ${m.reason} |`);
    }
    lines.push("");
    md += "\n" + lines.join("\n");
  }

  if (rowless.length > 0) {
    const lines = [
      "## Row-Less Detections (Manual Follow-Up)",
      "",
      "These rules have no homepage row. The last column says what the competitor's migration page did with each. Check them by hand.",
      "",
      "| Competitor | Capability | Migration page |",
      "| --- | --- | --- |",
    ];
    for (const r of rowless) {
      lines.push(`| ${r.competitor} | ${r.capability} | ${r.migrationPage ?? "not checked"} |`);
    }
    lines.push("");
    md += "\n" + lines.join("\n");
  }

  if (fetchWarnings.length > 0) {
    const lines = [
      "## Fetch Warnings",
      "",
      "These fetches failed. The run went on without them, so the results for these competitors are incomplete.",
      "",
    ];
    for (const w of fetchWarnings) lines.push(`- ${w.repo} ${w.source}: ${w.reason}`);
    lines.push("");
    md += "\n" + lines.join("\n");
  }

  if (watch !== null) {
    md += "\n" + formatWatchSection(watch);
  }

  return md;
}

/**
 * Writes one file. When the write fails, throws an error that names the file
 * (as `label`) and every docs file already written, so a run that stops
 * partway says which pages it changed.
 */
function writeOrReport(path: string, label: string, content: string, written: string[]): void {
  try {
    writeFileSync(path, content, "utf-8");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to write ${label}: ${reason}. ` +
        `Files already written: ${written.length > 0 ? written.join(", ") : "none"}.`,
      { cause: err },
    );
  }
}

/**
 * Writes the summary. `written` lists the docs files this run already wrote,
 * so a failed summary write names them.
 */
function writeSummary(
  summaryPath: string,
  changes: DetectedChange[],
  migrationChanges: MigrationPageChange[],
  rowless: RowlessDetection[],
  fetchWarnings: FetchFailure[],
  manualChecks: MigrationManualCheck[],
  written: string[],
  watch: FeatureWatchResult | null = null,
): void {
  writeOrReport(
    summaryPath,
    summaryPath,
    formatSummary(changes, migrationChanges, rowless, fetchWarnings, manualChecks, watch),
    written,
  );
  console.log(`\nSummary written to ${summaryPath}`);
}

/** Writes one docs file and adds relPath to `written` (see writeOrReport). */
function writeDocsFile(path: string, relPath: string, content: string, written: string[]): void {
  writeOrReport(path, relPath, content, written);
  written.push(relPath);
}

// ── Matrix Write ─────────────────────────────────────────────────────────────

/** A migration page to rewrite, with the changes the rewrite makes. */
export interface MigrationPageUpdate {
  /** Absolute path of the page. */
  path: string;
  /** Repository-relative path, for the log and the summary. */
  relPath: string;
  /** The updated page HTML. */
  html: string;
  /** What changed on the page, one entry per changed cell or provider claim. */
  changes: string[];
}

/** The feature-watch result and where its state file goes (spec D7, D10). */
export interface WatchWrite {
  result: FeatureWatchResult;
  /** Absolute path of the state file. */
  statePath: string;
  /** Path shown in logs and in "Files already written". */
  stateRelPath: string;
}

export interface MatrixUpdateOptions {
  /** Current homepage HTML. */
  html: string;
  /** Changes computed from the competitor scan. */
  changes: DetectedChange[];
  /** Where to write the updated homepage. */
  docsPath: string;
  /** Where to write the markdown summary, or null for none. */
  summaryPath: string | null;
  dryRun: boolean;
  /** Migration pages to write after the homepage. */
  migrationUpdates?: MigrationPageUpdate[];
  /** Row-less detections to list in the summary for manual follow-up. */
  rowless?: RowlessDetection[];
  /** Failed optional-source fetches; the summary lists them as warnings. */
  fetchWarnings?: FetchFailure[];
  /** Migration-page detections to list in the summary for a manual check. */
  manualChecks?: MigrationManualCheck[];
  /** Feature watch: its section goes in the summary; its state file is written before the summary. */
  watch?: WatchWrite;
}

/**
 * Applies the changes to the homepage, writes the homepage, then each
 * migration page, then the feature-watch state file (when it changed), and
 * last writes the summary of what was written.
 *
 * Throws before any write, and writes no summary, when any computed change
 * could not be placed: a scan that reports changes the page does not show
 * must fail the run. Throws, and writes no summary, when a docs write fails.
 * A failed docs or summary write throws an error that names the docs files
 * already written. A dry run writes no docs
 * file and no state file; its summary lists the changes the run would write.
 * Returns the homepage changes that were written (empty on a dry run).
 */
export function writeMatrixUpdate(opts: MatrixUpdateOptions): DetectedChange[] {
  const { html, changes, docsPath, summaryPath, dryRun } = opts;
  const migrationUpdates = opts.migrationUpdates ?? [];
  const rowless = opts.rowless ?? [];
  const fetchWarnings = opts.fetchWarnings ?? [];
  const manualChecks = opts.manualChecks ?? [];
  const watch = opts.watch ?? null;
  const pageChanges = (mu: MigrationPageUpdate): MigrationPageChange[] =>
    mu.changes.map((change) => ({ page: mu.relPath, change }));

  // Apply changes to index.html
  const { html: updated, applied, unapplied } = applyChanges(html, changes);

  if (unapplied.length > 0) {
    console.log(`\n${unapplied.length} change(s) could not be placed in docs/index.html:`);
    for (const { change: ch, reason } of unapplied) {
      console.log(`  ${ch.competitor} / ${ch.capability}: ${ch.from} -> ${ch.to} (${reason})`);
    }
    throw new Error(
      `${unapplied.length} of ${changes.length} computed change(s) could not be placed in ` +
        `docs/index.html: ${unapplied
          .map(({ change: ch, reason }) => `${ch.competitor} / ${ch.capability} (${reason})`)
          .join(", ")}.`,
    );
  }

  if (dryRun) {
    if (applied.length > 0) {
      console.log("\n[DRY RUN] Would update docs/index.html with the above changes.");
    }
    if (migrationUpdates.length > 0) {
      console.log("[DRY RUN] Would update the migration pages above.");
    }
    if (watch?.result.stateChanged) console.log(`[DRY RUN] Would update ${watch.stateRelPath}.`);
    if (summaryPath) {
      writeSummary(
        summaryPath,
        applied,
        migrationUpdates.flatMap(pageChanges),
        rowless,
        fetchWarnings,
        manualChecks,
        [],
        watch?.result ?? null,
      );
    }
    return [];
  }

  // Write the docs, homepage first. A failed write throws before the summary,
  // so no summary claims a change that was not written.
  const written: string[] = [];
  if (applied.length > 0) {
    writeDocsFile(docsPath, "docs/index.html", updated, written);
    console.log("\nUpdated docs/index.html successfully.");
  }
  const writtenMigrationChanges: MigrationPageChange[] = [];
  for (const mu of migrationUpdates) {
    writeDocsFile(mu.path, mu.relPath, mu.html, written);
    console.log(`Updated ${mu.relPath}.`);
    writtenMigrationChanges.push(...pageChanges(mu));
  }

  // The state file goes with the docs files, before the summary (D10), so a
  // failed summary write names it in "Files already written".
  if (watch !== null && watch.result.stateChanged) {
    writeDocsFile(
      watch.statePath,
      watch.stateRelPath,
      serializeWatchState(watch.result.state),
      written,
    );
    console.log(`Updated ${watch.stateRelPath}.`);
  }

  if (summaryPath) {
    writeSummary(
      summaryPath,
      applied,
      writtenMigrationChanges,
      rowless,
      fetchWarnings,
      manualChecks,
      written,
      watch?.result ?? null,
    );
  }
  return applied;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Every flag is checked before any fetch: a bad command line fails at once
  // and never runs a scan that writes to the wrong file.
  checkArgs(process.argv.slice(2), ["--summary", "--watch-state"], ["--dry-run"]);
  const summaryPath = parseSummaryArg();
  const repoRoot = resolve(import.meta.dirname ?? __dirname, "..");
  const watchStatePath = parseWatchStateArg() ?? resolve(repoRoot, WATCH_STATE_REL_PATH);

  console.log("=== Competitive Matrix Updater ===\n");

  if (DRY_RUN) {
    console.log("  [DRY RUN] No files will be modified.\n");
  }

  // Fetch competitor data
  const competitorFeatures = new Map<string, Record<string, boolean>>();
  const competitorProviderCounts = new Map<string, number>();
  const competitorReadmes = new Map<string, string>();
  // README failures fail the run. A package.json failure is listed with them
  // when the README also failed. When the README was scanned, it does not fail
  // the run: it is a fetch warning, logged and listed in the summary.
  const fatalFailures: FetchFailure[] = [];
  const fetchWarnings: FetchFailure[] = [];

  for (const comp of COMPETITORS) {
    console.log(`\n--- ${comp.name} (${comp.repo}) ---`);
    const [readmeRes, pkgRes] = await Promise.all([
      fetchReadme(comp.repo),
      fetchPackageJson(comp.repo),
    ]);

    // README x package.json outcomes (pinned by competitive-matrix-fetch-failure.test.ts):
    //   README found (non-empty): proceed; a failed package.json fetch only
    //     warns (logged, and listed under the summary's "Fetch Warnings"),
    //     because the primary source was scanned.
    //   README not found, empty, or failed: fail the run. Every competitor repo
    //     is expected to have a README, so a scan without one is incomplete.
    //     README 404 + package.json 404 is a competitor with no source at all,
    //     which can contribute no detection; it fails like any other scan that
    //     came back with nothing. A failed package.json fetch is reported too.
    const readmeFailure = describeReadmeFailure(readmeRes, pkgRes);
    if (readmeFailure !== null) {
      console.warn(`  ⚠ README unusable for ${comp.repo}: ${readmeFailure}`);
      fatalFailures.push({
        competitor: comp.name,
        repo: comp.repo,
        source: "README",
        reason: readmeFailure,
      });
    }
    if (pkgRes.status === "failed") {
      console.warn(`  ⚠ Failed to fetch package.json for ${comp.repo}: ${pkgRes.reason}`);
      const failure: FetchFailure = {
        competitor: comp.name,
        repo: comp.repo,
        source: "package.json",
        reason: pkgRes.reason,
      };
      if (readmeFailure !== null) {
        fatalFailures.push(failure);
      } else {
        fetchWarnings.push(failure);
      }
    }
    if (readmeFailure !== null || readmeRes.status !== "ok") continue;

    const readme = readmeRes.text;
    const pkg = pkgRes.status === "ok" ? pkgRes.text : "";
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

  // A competitor we could not see must not be reported as "no changes".
  if (fatalFailures.length > 0) {
    const lines = fatalFailures.map((f) => `  - ${f.repo} ${f.source}: ${f.reason}`);
    const failedCompetitors = new Set(fatalFailures.map((f) => f.competitor)).size;
    throw new Error(
      `Competitor scan incomplete: ${failedCompetitors} of ${COMPETITORS.length} ` +
        `competitor(s) could not be scanned from GitHub:\n${lines.join("\n")}`,
    );
  }

  // Feature watch (spec D6-D8). It runs after the competitor scan and before
  // any write: a source we could not check fails the run, so the summary never
  // reports a page we did not see as "no change".
  const urlOverrides = parseUrlOverrides(
    process.env.COMPETITIVE_WATCH_URL_OVERRIDES,
    FEATURE_WATCH,
  );
  if (urlOverrides.size > 0) {
    console.warn(
      `  ⚠ COMPETITIVE_WATCH_URL_OVERRIDES redirects: ${[...urlOverrides.keys()].join(", ")}`,
    );
  }
  console.log(`\n--- Feature watch (${FEATURE_WATCH.length} sources) ---`);
  const watchResult = await runFeatureWatch({
    sources: FEATURE_WATCH,
    previous: readWatchState(watchStatePath),
    today: todayUtc(),
    urlOverrides,
  });
  const relState = relative(repoRoot, watchStatePath);

  runMatrixUpdate({
    repoRoot,
    competitorFeatures,
    competitorProviderCounts,
    dryRun: DRY_RUN,
    summaryPath,
    fetchWarnings,
    watch: {
      result: watchResult,
      statePath: watchStatePath,
      stateRelPath: relState.startsWith("..") || isAbsolute(relState) ? watchStatePath : relState,
    },
  });
}

/** Inputs to runMatrixUpdate: the scan results plus where to read and write. */
export interface RunMatrixUpdateOptions {
  /** Repository root; docs/index.html and the migration pages live under it. */
  repoRoot: string;
  /** Competitor name -> FEATURE_RULES label -> detected. */
  competitorFeatures: Map<string, Record<string, boolean>>;
  /** Competitor name -> detected LLM provider count. */
  competitorProviderCounts: Map<string, number>;
  /** When true, report the changes but write no docs files. */
  dryRun: boolean;
  /** Where to write the markdown summary, or null for no summary. */
  summaryPath: string | null;
  /** Failed optional-source fetches; the summary lists them as warnings. */
  fetchWarnings?: FetchFailure[];
  /** Feature-watch result, passed through to writeMatrixUpdate. */
  watch?: WatchWrite;
}

/**
 * Applies the scan results to docs/index.html and the migration pages under
 * opts.repoRoot. Split from main() so tests can run it against copies of the
 * real pages without network access.
 */
export function runMatrixUpdate(opts: RunMatrixUpdateOptions): void {
  const { repoRoot, competitorFeatures, competitorProviderCounts, dryRun, summaryPath } = opts;
  const fetchWarnings = opts.fetchWarnings ?? [];
  const docsPath = resolve(repoRoot, "docs/index.html");

  // 1. Read current HTML
  console.log(`\nReading ${docsPath}...`);
  const html = readFileSync(docsPath, "utf-8");

  // 2. Parse current matrix
  const matrix = parseCurrentMatrix(html);
  console.log(
    `Parsed ${matrix.rows.size} capability rows, ${matrix.headers.length} competitor columns.`,
  );

  // Fail loudly if a rule names a row the homepage does not have: otherwise
  // the scan reports "no changes" forever without anyone noticing.
  assertRulesMatchMatrix(matrix);

  // Fail loudly if a competitor has no column (header renamed or unlinked):
  // otherwise its detected changes are dropped and the scan reports "no changes".
  const unmatchedCompetitors = findUnmatchedCompetitors(matrix);
  if (unmatchedCompetitors.length > 0) {
    throw new Error(
      `COMPETITORS name columns missing from the homepage matrix: ${unmatchedCompetitors.join(", ")}. ` +
        "Rename the competitor to the real <thead> link text, or restore the header's link.",
    );
  }

  // 3. Compute homepage changes
  const changes = computeChanges(html, matrix, competitorFeatures);

  // 4. Compute the migration-page updates for every scanned competitor, from
  // all of its detections. A page the run cannot read fails the run here,
  // before any file is written.
  const migrationUpdates: MigrationPageUpdate[] = [];
  const migrationChanges: MigrationPageChange[] = [];
  const manualChecks: MigrationManualCheck[] = [];
  const outcomesByCompetitor = new Map<string, MigrationRowOutcome[]>();

  for (const [compName, features] of competitorFeatures) {
    const migrationPageRelPath = Object.hasOwn(COMPETITOR_MIGRATION_PAGES, compName)
      ? COMPETITOR_MIGRATION_PAGES[compName]
      : undefined;
    if (!migrationPageRelPath) {
      throw new Error(
        `No migration page is mapped for ${compName}. Add it to COMPETITOR_MIGRATION_PAGES.`,
      );
    }
    const migrationPagePath = resolve(repoRoot, migrationPageRelPath);
    if (!existsSync(migrationPagePath)) {
      throw new Error(`Migration page for ${compName} not found: ${migrationPageRelPath}.`);
    }
    let result: ReturnType<typeof updateMigrationPage>;
    try {
      result = updateMigrationPage(
        readFileSync(migrationPagePath, "utf-8"),
        compName,
        features,
        competitorProviderCounts.get(compName) ?? 0,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Cannot update ${migrationPageRelPath} for ${compName}: ${reason}`, {
        cause: err,
      });
    }
    outcomesByCompetitor.set(compName, result.outcomes);
    for (const o of result.outcomes) {
      if (o.row !== null && (o.status === "combined-row" || o.status === "unsupported-no-cell")) {
        manualChecks.push({
          page: migrationPageRelPath,
          competitor: compName,
          capability: o.rule,
          row: o.row,
          reason: o.status,
        });
      }
    }
    if (result.changes.length > 0) {
      migrationUpdates.push({
        path: migrationPagePath,
        relPath: migrationPageRelPath,
        html: result.html,
        changes: result.changes,
      });
      for (const change of result.changes) {
        migrationChanges.push({ page: migrationPageRelPath, change });
      }
    }
  }

  // A homepage change whose migration page has no row for the capability
  // would leave the two pages disagreeing. List it for a manual check.
  for (const ch of changes) {
    const outcomes = (outcomesByCompetitor.get(ch.competitor) ?? []).filter(
      (o) => o.rule === ch.capability,
    );
    if (outcomes.length > 0 && outcomes.every((o) => o.status === "no-row")) {
      manualChecks.push({
        page: COMPETITOR_MIGRATION_PAGES[ch.competitor],
        competitor: ch.competitor,
        capability: ch.capability,
        row: "none",
        reason: "no-row",
      });
    }
  }

  // 5. Collect the row-less detections, with what the migration page did
  // with each. They never change the homepage; the summary and the log list
  // them for manual follow-up.
  const rowless: RowlessDetection[] = [];
  for (const [compName, features] of competitorFeatures) {
    for (const label of Object.keys(features)) {
      if (features[label] && isRowlessRule(label)) {
        const outcomes = (outcomesByCompetitor.get(compName) ?? []).filter((o) => o.rule === label);
        rowless.push({
          competitor: compName,
          capability: label,
          migrationPage: outcomes.map(migrationStatusText).join("; ") || "no row",
        });
      }
    }
  }

  // 6. Report
  if (
    changes.length === 0 &&
    migrationChanges.length === 0 &&
    rowless.length === 0 &&
    manualChecks.length === 0
  ) {
    console.log("\nNo changes detected. Competitive matrix is up to date.");
  } else if (changes.length === 0) {
    console.log("\nNo homepage matrix changes detected.");
  } else {
    console.log(`\n${changes.length} homepage change(s) detected:`);
    for (const ch of changes) {
      console.log(`  ${ch.competitor} / ${ch.capability}: ${ch.from} -> ${ch.to}`);
    }
  }
  if (migrationChanges.length > 0) {
    console.log(`${migrationChanges.length} migration page change(s) detected:`);
    for (const mc of migrationChanges) console.log(`  ${mc.page}: ${mc.change}`);
  }
  if (manualChecks.length > 0) {
    console.log(`${manualChecks.length} migration page row(s) to check by hand:`);
    for (const m of manualChecks) {
      console.log(`  ${m.page}: ${m.competitor} / ${m.capability}: "${m.row}" (${m.reason})`);
    }
  }
  if (rowless.length > 0) {
    console.log(`${rowless.length} row-less detection(s) to check by hand (no homepage row):`);
    for (const r of rowless) console.log(`  ${r.competitor} / ${r.capability}`);
  }

  // 7. Write the homepage, then the migration pages, then the summary of what
  // was written. This throws before any docs file is written when a computed
  // homepage change cannot be placed, and names the files already written
  // when a write fails partway.
  writeMatrixUpdate({
    html,
    changes,
    docsPath,
    summaryPath,
    dryRun,
    migrationUpdates,
    rowless,
    fetchWarnings,
    manualChecks,
    watch: opts.watch,
  });
}

// Only run when executed directly as a script (not when imported by tests).
const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
