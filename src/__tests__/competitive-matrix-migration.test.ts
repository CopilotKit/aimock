import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The migration-page path of the weekly competitive-matrix scan. These tests
// run on copies of the REAL migration pages and homepage. Every test that
// needs a cell in a given state sets that cell in its copy first, because the
// scan bot flips the live cells over time.
import {
  COMPETITORS,
  COMPETITOR_MIGRATION_PAGES,
  FEATURE_RULES,
  extractFeatures,
  runMatrixUpdate,
  updateMigrationPage,
  updateProviderCounts,
} from "../../scripts/update-competitive-matrix.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HOMEPAGE_REL = "docs/index.html";
const HOMEPAGE = readFileSync(resolve(REPO_ROOT, HOMEPAGE_REL), "utf-8");
const MIGRATION_PAGES = Object.values(COMPETITOR_MIGRATION_PAGES);

const CROSS = '<td style="color: var(--error)">&#10007;</td>';
const CHECK = '<td style="color: var(--accent)">&#10003;</td>';
const HOME_NO = '<td><span class="no" role="img" aria-label="No">&#10007;</span></td>';
const HOME_YES = '<td><span class="yes" role="img" aria-label="Yes">&#10003;</span></td>';

const MIGRATION_HEADING = "## Migration Page Changes";
const ROWLESS_HEADING = "## Row-Less Detections (Manual Follow-Up)";
const MANUAL_HEADING = "## Migration Page Rows To Check By Hand";

// ── Independent readers (do not share code with the script under test) ─────

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const toHtml = (label: string) => label.replace(/&/g, "&amp;");

/** The competitor's 0-based cell index in each row of a migration-page table. */
function migrationColumn(html: string, header: string): number {
  const thead = html.match(/<thead>([\s\S]*?)<\/thead>/)![1];
  const cells = [...thead.matchAll(/<(th|td)\b[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => m[2].trim());
  const idx = cells.indexOf(header);
  expect(idx, `header ${header}`).toBeGreaterThan(0);
  return idx;
}

/** The migration-page header text for each competitor. */
const HEADER: Record<string, string> = {
  VidaiMock: "VidaiMock",
  "mock-llm": "mock-llm",
  "piyook/llm-mock": "piyook/llm-mock",
  "mokksy/ai-mocks": "Mokksy",
};

function migrationRow(html: string, rowLabel: string): string | undefined {
  return html.match(
    new RegExp(`<tr>\\s*<td>${escapeRe(toHtml(rowLabel))}</td>[\\s\\S]*?</tr>`),
  )?.[0];
}

/** The competitor's cell in the row labeled `rowLabel` on a migration page. */
function migrationCell(html: string, competitor: string, rowLabel: string): string | undefined {
  const tr = migrationRow(html, rowLabel);
  if (tr === undefined) return undefined;
  const col = migrationColumn(html, HEADER[competitor]);
  return [...tr.matchAll(/<td\b[^>]*>[\s\S]*?<\/td>/g)][col]?.[0];
}

/** `html` with the competitor's cell in row `rowLabel` replaced by `cell`. */
function withMigrationCell(html: string, competitor: string, rowLabel: string, cell: string) {
  const tr = migrationRow(html, rowLabel);
  if (tr === undefined) throw new Error(`migration row not found: ${rowLabel}`);
  const col = migrationColumn(html, HEADER[competitor]);
  let idx = 0;
  const newTr = tr.replace(/<td\b[^>]*>[\s\S]*?<\/td>/g, (c) => (idx++ === col ? cell : c));
  const out = html.replace(tr, () => newTr);
  expect(migrationCell(out, competitor, rowLabel)).toBe(cell);
  return out;
}

/** `html` (the homepage) with the competitor's cell in row `rowLabel` replaced by `cell`. */
function withHomeCell(html: string, competitor: string, rowLabel: string, cell: string): string {
  const table = html.match(/<table class="comparison-table">([\s\S]*?)<\/table>/)![1];
  const thead = table.match(/<thead>([\s\S]*?)<\/thead>/)![1];
  const headers = [...thead.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map((m) =>
    m[1].replace(/<[^>]*>/g, "").trim(),
  );
  const col = headers.indexOf(competitor);
  expect(col, competitor).toBeGreaterThan(0);
  const tr = html.match(
    new RegExp(`<tr\\b[^>]*>\\s*<th scope="row">${escapeRe(toHtml(rowLabel))}</th>[\\s\\S]*?</tr>`),
  )?.[0];
  if (tr === undefined) throw new Error(`homepage row not found: ${rowLabel}`);
  let idx = 0;
  const newTr = tr.replace(/<(th|td)\b[^>]*>[\s\S]*?<\/\1>/g, (c) => (idx++ === col ? cell : c));
  return html.replace(tr, () => newTr);
}

/** The body of the summary section under `heading`, up to the next "## " heading. */
function summarySection(md: string, heading: string): string | undefined {
  const at = md.indexOf(`${heading}\n`);
  if (at < 0) return undefined;
  const rest = md.slice(at + heading.length + 1);
  const next = rest.search(/^## /m);
  return next < 0 ? rest : rest.slice(0, next);
}

/** A temp repo root holding copies of the homepage and every mapped migration page. */
function useTempRoot() {
  const ctx = { root: "", logged: [] as string[] };
  beforeEach(() => {
    ctx.root = mkdtempSync(join(tmpdir(), "cm-migration-"));
    for (const rel of [HOMEPAGE_REL, ...MIGRATION_PAGES]) {
      mkdirSync(dirname(join(ctx.root, rel)), { recursive: true });
      copyFileSync(resolve(REPO_ROOT, rel), join(ctx.root, rel));
    }
    ctx.logged = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      ctx.logged.push(args.join(" "));
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(ctx.root, { recursive: true, force: true });
  });
  return ctx;
}

// ── 1. Every competitor with a detection gets its migration page updated ────

describe("migration pages are updated for every competitor with a detection", () => {
  const ctx = useTempRoot();
  const read = (rel: string) => readFileSync(join(ctx.root, rel), "utf-8");
  const write = (rel: string, html: string) => writeFileSync(join(ctx.root, rel), html);
  const MOCK_LLM = COMPETITOR_MIGRATION_PAGES["mock-llm"];
  const VIDAI = COMPETITOR_MIGRATION_PAGES.VidaiMock;

  function run(features: [string, Record<string, boolean>][], dryRun = false) {
    runMatrixUpdate({
      repoRoot: ctx.root,
      competitorFeatures: new Map(features),
      competitorProviderCounts: new Map(),
      dryRun,
      summaryPath: join(ctx.root, "summary.md"),
    });
  }

  it("flips a migration cell when the homepage cell is already yes", () => {
    write(HOMEPAGE_REL, withHomeCell(HOMEPAGE, "mock-llm", "Claude Messages API", HOME_YES));
    write(MOCK_LLM, withMigrationCell(read(MOCK_LLM), "mock-llm", "Anthropic Claude", CROSS));
    const homeBefore = read(HOMEPAGE_REL);

    run([["mock-llm", { "Claude Messages API": true }]]);

    expect(read(HOMEPAGE_REL)).toBe(homeBefore);
    expect(migrationCell(read(MOCK_LLM), "mock-llm", "Anthropic Claude")).toBe(CHECK);
    expect(summarySection(read("summary.md"), MIGRATION_HEADING)).toContain(
      "mock-llm: Anthropic Claude ✗ -> ✓",
    );
  });

  it("flips a migration cell for a row-less detection and still lists the detection", () => {
    write(MOCK_LLM, withMigrationCell(read(MOCK_LLM), "mock-llm", "AWS Bedrock", CROSS));

    run([["mock-llm", { "AWS Bedrock": true }]]);

    expect(migrationCell(read(MOCK_LLM), "mock-llm", "AWS Bedrock")).toBe(CHECK);
    const md = read("summary.md");
    expect(summarySection(md, MIGRATION_HEADING)).toContain("mock-llm: AWS Bedrock ✗ -> ✓");
    expect(summarySection(md, ROWLESS_HEADING)).toContain(
      '| mock-llm | AWS Bedrock | "AWS Bedrock" ✗ -> ✓ |',
    );
  });

  it("lists a row-less detection that the page has no row for as 'no row'", () => {
    const before = read(VIDAI);

    run([["VidaiMock", { "Realtime GA protocol": true }]]);

    expect(read(VIDAI)).toBe(before);
    expect(summarySection(read("summary.md"), ROWLESS_HEADING)).toContain(
      "| VidaiMock | Realtime GA protocol | no row |",
    );
  });

  it("dry run reports the migration flip and writes no docs file", () => {
    write(MOCK_LLM, withMigrationCell(read(MOCK_LLM), "mock-llm", "AWS Bedrock", CROSS));
    const before = new Map(MIGRATION_PAGES.map((rel) => [rel, read(rel)]));

    run([["mock-llm", { "AWS Bedrock": true }]], true);

    for (const [rel, html] of before) expect(read(rel), rel).toBe(html);
    expect(ctx.logged.join("\n")).toContain(`${MOCK_LLM}: mock-llm: AWS Bedrock ✗ -> ✓`);
    expect(summarySection(read("summary.md"), MIGRATION_HEADING)).toContain(
      "mock-llm: AWS Bedrock ✗ -> ✓",
    );
  });
});

// ── 2. Provider counts parse the whole number and never go down ──────────────

describe("provider-count prose update", () => {
  it("reads every digit: 12 providers is not rewritten to a lower count", () => {
    const html = "<p>TestComp supports 12 providers today.</p>";
    const changes: string[] = [];

    const result = updateProviderCounts(html, "TestComp", 5, changes);

    expect(result).toBe(html);
    expect(changes).toEqual([]);
  });

  it("raises a multi-digit count and reports the real old value", () => {
    const html = "<p>TestComp supports 12 providers today.</p>";
    const changes: string[] = [];

    const result = updateProviderCounts(html, "TestComp", 15, changes);

    expect(result).toBe("<p>TestComp supports 15 providers today.</p>");
    expect(changes).toEqual(["TestComp: provider count 12 -> 15 (prose)"]);
  });
});

// ── 3. A missing page, table or column fails the run ─────────────────────────

describe("a migration page the scan cannot read fails loudly", () => {
  const ctx = useTempRoot();
  const read = (rel: string) => readFileSync(join(ctx.root, rel), "utf-8");
  const write = (rel: string, html: string) => writeFileSync(join(ctx.root, rel), html);
  const MOCK_LLM = COMPETITOR_MIGRATION_PAGES["mock-llm"];

  /** Runs with a mock-llm detection that has an applied homepage change. */
  function runWithHomepageChange() {
    write(HOMEPAGE_REL, withHomeCell(HOMEPAGE, "mock-llm", "Claude Messages API", HOME_NO));
    runMatrixUpdate({
      repoRoot: ctx.root,
      competitorFeatures: new Map([["mock-llm", { "Claude Messages API": true }]]),
      competitorProviderCounts: new Map(),
      dryRun: false,
      summaryPath: join(ctx.root, "summary.md"),
    });
  }

  it("updateMigrationPage throws when the page has no comparison table", () => {
    expect(() =>
      updateMigrationPage("<p>No table here</p>", "TestComp", { "WebSocket APIs": true }, 0),
    ).toThrow(/table/i);
  });

  it("updateMigrationPage throws when no header names the competitor", () => {
    const html = read(MOCK_LLM).replace("<th>mock-llm</th>", "<th>Mock LLM</th>");
    expect(() => updateMigrationPage(html, "mock-llm", { "WebSocket APIs": true }, 0)).toThrow(
      /mock-llm/,
    );
  });

  it("the run throws, writing nothing, when a mapped migration page is missing", () => {
    rmSync(join(ctx.root, MOCK_LLM));
    expect(() => runWithHomepageChange()).toThrow(/migrate-from-mock-llm/);
    expect(read(HOMEPAGE_REL)).toBe(
      withHomeCell(HOMEPAGE, "mock-llm", "Claude Messages API", HOME_NO),
    );
    expect(existsSync(join(ctx.root, "summary.md"))).toBe(false);
  });

  it("the run throws, writing nothing, when the page lost the competitor column", () => {
    write(MOCK_LLM, read(MOCK_LLM).replace("<th>mock-llm</th>", "<th>Mock LLM</th>"));
    expect(() => runWithHomepageChange()).toThrow(/migrate-from-mock-llm/);
    expect(existsSync(join(ctx.root, "summary.md"))).toBe(false);
  });

  it("the run throws when a scanned competitor has no mapped migration page", () => {
    const saved = COMPETITOR_MIGRATION_PAGES["mock-llm"];
    delete COMPETITOR_MIGRATION_PAGES["mock-llm"];
    try {
      expect(() => runWithHomepageChange()).toThrow(/mock-llm/);
    } finally {
      COMPETITOR_MIGRATION_PAGES["mock-llm"] = saved;
    }
    expect(existsSync(join(ctx.root, "summary.md"))).toBe(false);
  });
});

// ── 4. Header cells and body rows are read as table cells ────────────────────

describe("migration table header and row shapes", () => {
  const table = (thead: string, rows: string) =>
    `<table class="comparison-table"><thead>${thead}</thead><tbody>${rows}</tbody></table>`;
  const ROW_CROSS = `<tr><td>WebSocket protocols</td>${CROSS}${CHECK}</tr>`;

  it("finds the column when the header row starts with an empty <td> corner cell", () => {
    const html = table("<tr><td></td><th>TestComp</th><th>aimock</th></tr>", ROW_CROSS);

    const { html: out, changes } = updateMigrationPage(
      html,
      "TestComp",
      { "WebSocket APIs": true },
      0,
    );

    expect(changes).toEqual(["TestComp: WebSocket protocols ✗ -> ✓"]);
    expect(out).toContain(`<td>WebSocket protocols</td>${CHECK}${CHECK}`);
  });

  it("throws, naming the row, on a body row with fewer cells than the header", () => {
    const html = table(
      "<tr><th>Capability</th><th>aimock</th><th>TestComp</th></tr>",
      `<tr><td>WebSocket protocols</td>${CHECK}</tr>`,
    );
    expect(() => updateMigrationPage(html, "TestComp", { "WebSocket APIs": true }, 0)).toThrow(
      /WebSocket protocols/,
    );
  });

  it("throws, naming the row, on a colspan body cell", () => {
    const html = table(
      "<tr><th>Capability</th><th>TestComp</th><th>aimock</th></tr>",
      '<tr><td>WebSocket protocols</td><td colspan="2" style="color: var(--error)">&#10007;</td></tr>',
    );
    expect(() => updateMigrationPage(html, "TestComp", { "WebSocket APIs": true }, 0)).toThrow(
      /WebSocket protocols/,
    );
  });
});

// ── 5. Real migration-page labels match their rules ──────────────────────────

describe("rules match the real migration-page row labels", () => {
  const page = (competitor: string) =>
    readFileSync(resolve(REPO_ROOT, COMPETITOR_MIGRATION_PAGES[competitor]), "utf-8");

  it('mock-llm "Helm chart" flips the "Kubernetes / Helm" row', () => {
    const html = withMigrationCell(page("mock-llm"), "mock-llm", "Kubernetes / Helm", CROSS);

    const res = updateMigrationPage(html, "mock-llm", { "Helm chart": true }, 0);

    expect(migrationCell(res.html, "mock-llm", "Kubernetes / Helm")).toBe(CHECK);
    expect(res.outcomes).toEqual([
      { rule: "Helm chart", row: "Kubernetes / Helm", combined: false, status: "flipped" },
    ]);
  });

  it('mock-llm "Azure OpenAI" finds the combined Azure row and leaves it for a manual check', () => {
    const ROW = "Azure OpenAI / Vertex AI / Ollama / Cohere";
    const html = withMigrationCell(page("mock-llm"), "mock-llm", ROW, CROSS);

    const res = updateMigrationPage(html, "mock-llm", { "Azure OpenAI": true }, 0);

    expect(res.html).toBe(html);
    expect(res.changes).toEqual([]);
    expect(res.outcomes).toEqual([
      { rule: "Azure OpenAI", row: ROW, combined: true, status: "combined-row" },
    ]);
  });

  it('mokksy "Docker image" and "Helm chart" find the combined "Docker / Helm" row', () => {
    const html = withMigrationCell(
      page("mokksy/ai-mocks"),
      "mokksy/ai-mocks",
      "Docker / Helm",
      CROSS,
    );

    const res = updateMigrationPage(
      html,
      "mokksy/ai-mocks",
      { "Docker image": true, "Helm chart": true },
      0,
    );

    expect(res.html).toBe(html);
    expect(res.outcomes).toEqual([
      { rule: "Docker image", row: "Docker / Helm", combined: true, status: "combined-row" },
      { rule: "Helm chart", row: "Docker / Helm", combined: true, status: "combined-row" },
    ]);
  });

  describe("through the real run", () => {
    const ctx = useTempRoot();
    const read = (rel: string) => readFileSync(join(ctx.root, rel), "utf-8");
    const MOCK_LLM = COMPETITOR_MIGRATION_PAGES["mock-llm"];

    it("lists a combined-row detection for a manual check, not as 'no row'", () => {
      const ROW = "Azure OpenAI / Vertex AI / Ollama / Cohere";
      writeFileSync(
        join(ctx.root, MOCK_LLM),
        withMigrationCell(read(MOCK_LLM), "mock-llm", ROW, CROSS),
      );

      runMatrixUpdate({
        repoRoot: ctx.root,
        competitorFeatures: new Map([["mock-llm", { "Azure OpenAI": true }]]),
        competitorProviderCounts: new Map(),
        dryRun: false,
        summaryPath: join(ctx.root, "summary.md"),
      });

      const md = read("summary.md");
      expect(summarySection(md, MANUAL_HEADING)).toContain(
        `| \`${MOCK_LLM}\` | mock-llm | Azure OpenAI | ${ROW} |`,
      );
      expect(summarySection(md, ROWLESS_HEADING)).not.toContain(
        "| mock-llm | Azure OpenAI | no row |",
      );
      expect(migrationCell(read(MOCK_LLM), "mock-llm", ROW)).toBe(CROSS);
    });
  });
});

// ── 6. "Responses API SSE" needs evidence of the Responses API ───────────────

describe('"Responses API SSE" rule precision', () => {
  const RULE = "Responses API SSE";

  it.each([
    // mock-llm README tagline and roadmap sentence
    "Mock common AI protocols such as OpenAI completions, responses, MCP, A2A.",
    "could be extended to mock the list models APIs, responses APIs, A2A apis and so on in the future.",
    // piyook README
    "Free and fast — no API costs, instant responses for rapid prototyping",
    "predictable, repeatable responses for testing UI logic",
    // the Realtime event, not the Responses API
    'send a {"type": "response.create"} event over the socket',
  ])("does not match plain text: %s", (text) => {
    expect(extractFeatures(text)[RULE]).toBe(false);
  });

  it.each([
    "curl http://localhost:8100/v1/responses",
    "OpenAI Responses API (streaming with typed SSE events)",
    "const r = await client.responses.create({ model })",
  ])("matches Responses API evidence: %s", (text) => {
    expect(extractFeatures(text)[RULE]).toBe(true);
  });
});

// ── 8. Contract: each mapped page exists and holds every row its rules target ─

/**
 * The rows each competitor's migration page must have, by rule. `combined`
 * rows cover several capabilities, so one detection never flips them.
 */
const EXPECTED_ROWS: Record<string, { rule: string; row: string; combined: boolean }[]> = {
  VidaiMock: [
    { rule: "WebSocket APIs", row: "WebSocket APIs", combined: false },
    { rule: "Drift detection", row: "Drift detection", combined: false },
    { rule: "Request journal", row: "Request journal", combined: false },
    { rule: "AG-UI event mocking", row: "MCP / A2A / AG-UI / Vector", combined: true },
    { rule: "Docker image", row: "Docker", combined: false },
  ],
  "mock-llm": [
    { rule: "Chat Completions SSE", row: "OpenAI Chat Completions", combined: false },
    { rule: "Chat Completions SSE", row: "Streaming SSE", combined: false },
    { rule: "Responses API SSE", row: "OpenAI Responses API", combined: false },
    { rule: "Claude Messages API", row: "Anthropic Claude", combined: false },
    { rule: "Gemini streaming", row: "Google Gemini", combined: false },
    { rule: "WebSocket APIs", row: "WebSocket protocols", combined: false },
    { rule: "Drift detection", row: "Drift detection", combined: false },
    {
      rule: "Azure OpenAI",
      row: "Azure OpenAI / Vertex AI / Ollama / Cohere",
      combined: true,
    },
    { rule: "AWS Bedrock", row: "AWS Bedrock", combined: false },
    { rule: "Docker image", row: "Docker image", combined: false },
    { rule: "Helm chart", row: "Kubernetes / Helm", combined: false },
  ],
  "piyook/llm-mock": [
    { rule: "Chat Completions SSE", row: "OpenAI Chat Completions", combined: false },
    { rule: "Chat Completions SSE", row: "Streaming SSE", combined: false },
    { rule: "Responses API SSE", row: "OpenAI Responses API", combined: false },
    { rule: "Claude Messages API", row: "Anthropic Claude", combined: false },
    { rule: "Gemini streaming", row: "Google Gemini", combined: false },
    { rule: "WebSocket APIs", row: "WebSocket protocols", combined: false },
    {
      rule: "Structured output / JSON mode",
      row: "Structured output / JSON mode",
      combined: false,
    },
    { rule: "Sequential / stateful responses", row: "Sequential responses", combined: false },
    {
      rule: "Azure OpenAI",
      row: "AWS Bedrock / Azure / Vertex AI / Ollama / Cohere",
      combined: true,
    },
    {
      rule: "AWS Bedrock",
      row: "AWS Bedrock / Azure / Vertex AI / Ollama / Cohere",
      combined: true,
    },
    { rule: "Docker image", row: "Docker image", combined: false },
    { rule: "Drift detection", row: "Drift detection", combined: false },
    { rule: "Request journal", row: "Request journal", combined: false },
    { rule: "AG-UI event mocking", row: "MCP / A2A / AG-UI / Vector mocking", combined: true },
  ],
  "mokksy/ai-mocks": [
    { rule: "Chat Completions SSE", row: "Streaming SSE", combined: false },
    { rule: "WebSocket APIs", row: "WebSocket APIs", combined: false },
    { rule: "Drift detection", row: "Drift detection", combined: false },
    { rule: "Docker image", row: "Docker / Helm", combined: true },
    { rule: "Helm chart", row: "Docker / Helm", combined: true },
  ],
};

describe("migration-page contract", () => {
  const ALL_DETECTED = Object.fromEntries(FEATURE_RULES.map((r) => [r.rowLabel, true]));
  const key = (o: { rule: string; row: string | null; combined: boolean }) =>
    `${o.rule} => ${o.row} (${o.combined ? "combined" : "single"})`;

  it("maps every tracked competitor to a migration page", () => {
    for (const c of COMPETITORS) expect(COMPETITOR_MIGRATION_PAGES, c.name).toHaveProperty(c.name);
    expect(Object.keys(EXPECTED_ROWS).sort()).toEqual(
      Object.keys(COMPETITOR_MIGRATION_PAGES).sort(),
    );
  });

  for (const [competitor, rel] of Object.entries(COMPETITOR_MIGRATION_PAGES)) {
    describe(rel, () => {
      it("exists, with a comparison table and the competitor's column", () => {
        const path = resolve(REPO_ROOT, rel);
        expect(existsSync(path)).toBe(true);
        const html = readFileSync(path, "utf-8");
        expect(html).toMatch(/<table class="(?:comparison-table|endpoint-table)">/);
        migrationColumn(html, HEADER[competitor]);
        expect(() => updateMigrationPage(html, competitor, {}, 0)).not.toThrow();
      });

      it("has a row for every rule that targets it", () => {
        const html = readFileSync(resolve(REPO_ROOT, rel), "utf-8");
        for (const e of EXPECTED_ROWS[competitor]) {
          expect(migrationRow(html, e.row), `${rel}: row "${e.row}"`).toBeDefined();
        }
        const { outcomes } = updateMigrationPage(html, competitor, ALL_DETECTED, 0);
        const matched = outcomes.filter((o) => o.row !== null).map(key);
        expect(matched.sort()).toEqual(EXPECTED_ROWS[competitor].map(key).sort());
      });
    });
  }
});
