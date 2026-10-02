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
import { decodeHTML } from "entities";

// These tests run the scan's parse/compute/apply logic against the REAL
// homepage (docs/index.html), not a hand-written table, so the parser must
// handle the page's real markup, including <th scope="row"> row labels.
//
// The weekly scan bot flips cells in docs/index.html, and people edit it by
// hand. So most tests read each expected value from the page with a separate,
// simple reader below, and the parser under test must agree with it. Tests
// that pin a specific cell first assert that cell's current state as a
// precondition.
import {
  parseCurrentMatrix,
  computeChanges,
  applyChanges,
  findUnmatchedRules,
  assertRulesMatchMatrix,
  findUnmatchedCompetitors,
  FEATURE_RULES,
  MATRIX_ROWLESS_RULES,
  isRowlessRule,
  writeMatrixUpdate,
  COMPETITOR_MIGRATION_PAGES,
  buildMigrationRowPatterns,
  runMatrixUpdate,
  type DetectedChange,
} from "../../scripts/update-competitive-matrix.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HOMEPAGE = readFileSync(resolve(REPO_ROOT, "docs/index.html"), "utf-8");

// ── Independent reader (does not share code with the parser under test) ─────

function tableHtml(): string {
  return HOMEPAGE.match(/<table class="comparison-table">([\s\S]*?)<\/table>/)![1];
}

/** Link text of each <thead> column header, in page order. */
function pageHeaders(): string[] {
  const thead = tableHtml().match(/<thead>([\s\S]*?)<\/thead>/)![1];
  return [...thead.matchAll(/<th[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>\s*<\/th>/g)].map((m) =>
    m[1].trim(),
  );
}

/** Each <tbody> row: its plain-text <th scope="row"> label and its <td> cells, in order. */
function pageBodyRows(): { label: string; cells: string[] }[] {
  const tbody = tableHtml().match(/<tbody>([\s\S]*?)<\/tbody>/)![1];
  return tbody
    .split(/<tr\b[^>]*>/)
    .slice(1)
    .map((tr) => ({
      label: decodeHTML(tr.match(/<th scope="row">([\s\S]*?)<\/th>/)![1]).trim(),
      cells: [...tr.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1].trim()),
    }));
}

/** Columns the scan may change: everything except aimock itself and MSW. */
function competitorColumns(): string[] {
  return pageHeaders().filter((h) => h !== "aimock" && h !== "MSW");
}

const NO_CELL = /class="no"|✗|&#10007;/;
const NO_SPAN = /<span class="no"[^>]*>[\s\S]*?<\/span>/;
const YES_SPAN = /<span class="yes"[^>]*>[\s\S]*?<\/span>/;

/** Every competitor cell in a rule-driven row, split by whether it shows the cross mark. */
function ruleCells(html: string = HOMEPAGE): {
  no: { competitor: string; capability: string }[];
  notNo: { competitor: string; capability: string }[];
} {
  const matrix = parseCurrentMatrix(html);
  const no: { competitor: string; capability: string }[] = [];
  const notNo: { competitor: string; capability: string }[] = [];
  for (const rule of FEATURE_RULES) {
    const row = matrix.rows.get(rule.rowLabel);
    if (!row) continue;
    for (const competitor of competitorColumns()) {
      const cell = row.get(competitor);
      if (cell === undefined) continue;
      (NO_CELL.test(cell) ? no : notNo).push({ competitor, capability: rule.rowLabel });
    }
  }
  return { no, notNo };
}

/** The real homepage's markup for a no-cell and for a yes-cell. */
const REAL_NO_CELL = '<td><span class="no" role="img" aria-label="No">&#10007;</span></td>';
const REAL_YES_CELL = '<td><span class="yes" role="img" aria-label="Yes">&#10003;</span></td>';

/**
 * `html` with `competitor`'s cell in the row whose label HTML is `rowHtml`
 * replaced by `cell`. Tests that need a cell in a given state set it in a copy
 * with this, because the scan bot flips the live cells over time.
 */
function withCell(html: string, rowHtml: string, competitor: string, cell: string): string {
  const col = pageHeaders().indexOf(competitor) + 1; // +1 for the label column
  expect(col, competitor).toBeGreaterThan(0);
  const label = rowHtml.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tr = html.match(
    new RegExp(`<tr\\b[^>]*>\\s*<th scope="row">${label}</th>[\\s\\S]*?</tr>`),
  )?.[0];
  if (tr === undefined) throw new Error(`row not found: ${rowHtml}`);
  let idx = 0;
  const newTr = tr.replace(/<(th|td)\b[^>]*>[\s\S]*?<\/\1>/g, (c) => (idx++ === col ? cell : c));
  expect(idx, rowHtml).toBeGreaterThan(col);
  return html.replace(tr, () => newTr);
}

/** The label (as row HTML) of the first rule-driven row on the real homepage. */
function firstRuleRowHtml(): string {
  const labels = new Set(pageBodyRows().map((r) => r.label));
  const rule = FEATURE_RULES.find((r) => labels.has(r.rowLabel))!;
  return rule.rowLabel.replace(/&/g, "&amp;");
}

describe("parseCurrentMatrix on the real homepage", () => {
  it("has one row per <tbody> row, keyed by its <th scope=row> label", () => {
    const { rows } = parseCurrentMatrix(HOMEPAGE);
    const body = pageBodyRows();
    expect(body.length).toBeGreaterThan(0);
    expect(rows.size).toBe(body.length);
    expect([...rows.keys()]).toEqual(body.map((r) => r.label));
  });

  it("reads the column headers from <thead>", () => {
    const { headers } = parseCurrentMatrix(HOMEPAGE);
    const expected = pageHeaders();
    expect(expected.length).toBeGreaterThan(0);
    expect(headers).toEqual(expected);
  });

  it("aligns each cell with its own column (no off-by-one)", () => {
    const { headers, rows } = parseCurrentMatrix(HOMEPAGE);
    for (const { label, cells } of pageBodyRows()) {
      expect(cells.length, label).toBe(headers.length);
      const row = rows.get(label)!;
      expect(row.size, label).toBe(headers.length);
      headers.forEach((header, i) => {
        expect(row.get(header), `${label} / ${header}`).toBe(cells[i]);
      });
    }
  });
});

describe("tracked competitors vs. the real homepage columns", () => {
  const VIDAIMOCK_LINK = '<a href="https://github.com/vidaiUK/VidaiMock">VidaiMock</a>';

  it("every tracked competitor resolves to a column", () => {
    expect(HOMEPAGE).toContain(VIDAIMOCK_LINK);
    expect(findUnmatchedCompetitors(parseCurrentMatrix(HOMEPAGE))).toEqual([]);
  });

  it("reports a competitor whose header was renamed", () => {
    const renamed = HOMEPAGE.replace(
      VIDAIMOCK_LINK,
      '<a href="https://github.com/vidaiUK/VidaiMock">Vidai Mock</a>',
    );
    expect(renamed).not.toBe(HOMEPAGE);
    expect(findUnmatchedCompetitors(parseCurrentMatrix(renamed))).toEqual(["VidaiMock"]);
  });

  it("reports a competitor whose header has no link", () => {
    const unlinked = HOMEPAGE.replace(VIDAIMOCK_LINK, "VidaiMock");
    expect(unlinked).not.toBe(HOMEPAGE);
    expect(findUnmatchedCompetitors(parseCurrentMatrix(unlinked))).toEqual(["VidaiMock"]);
  });
});

describe("duplicate competitor columns on the real homepage", () => {
  const VIDAIMOCK_HEADER =
    '<th scope="col"><a href="https://github.com/vidaiUK/VidaiMock">VidaiMock</a></th>';

  /**
   * Returns the homepage with the VidaiMock column repeated: its header cell is
   * followed by `extraHeader`, and each body row's VidaiMock cell is repeated
   * right after it, so every row keeps one cell per header.
   */
  function withDuplicatedVidaiMockColumn(extraHeader: string): string {
    const table = HOMEPAGE.match(/<table class="comparison-table">[\s\S]*?<\/table>/)![0];
    const headerIdx = pageHeaders().indexOf("VidaiMock") + 1; // +1 for the label column
    const dupTable = table
      .replace(VIDAIMOCK_HEADER, () => `${VIDAIMOCK_HEADER}\n${extraHeader}`)
      .replace(
        /(<tbody>)([\s\S]*?)(<\/tbody>)/,
        (_m, open: string, inner: string, close: string) => {
          const rows = inner.replace(
            /(<tr\b[^>]*>)([\s\S]*?)(<\/tr>)/g,
            (_t, o: string, tr: string, c: string) => {
              let i = 0;
              const cells = tr.replace(/<(th|td)\b[^>]*>[\s\S]*?<\/\1>/g, (cell) =>
                i++ === headerIdx ? `${cell}\n${cell}` : cell,
              );
              return o + cells + c;
            },
          );
          return open + rows + close;
        },
      );
    expect(dupTable).not.toBe(table);
    return HOMEPAGE.replace(table, () => dupTable);
  }

  it("the real homepage has no duplicate competitor columns", () => {
    const headers = pageHeaders();
    expect(new Set(headers).size).toBe(headers.length);
  });

  it("fails loudly, naming the competitor, when a column name repeats", () => {
    const dup = withDuplicatedVidaiMockColumn(VIDAIMOCK_HEADER);
    expect(dup.split(VIDAIMOCK_HEADER)).toHaveLength(3);
    expect(() => parseCurrentMatrix(dup)).toThrow(
      /Duplicate competitor column in the homepage matrix: "VidaiMock"/,
    );
  });

  it("fails loudly, naming the competitor, when a column link repeats", () => {
    const dup = withDuplicatedVidaiMockColumn(
      '<th scope="col"><a href="https://github.com/vidaiUK/VidaiMock">VidaiMock (fork)</a></th>',
    );
    expect(() => parseCurrentMatrix(dup)).toThrow(
      /Duplicate competitor column in the homepage matrix: "VidaiMock"/,
    );
  });
});

describe("FEATURE_RULES vs. the real homepage rows", () => {
  it("every rule targets a real row unless it is listed as row-less with a reason", () => {
    const matrix = parseCurrentMatrix(HOMEPAGE);
    expect(findUnmatchedRules(matrix)).toEqual([]);
    expect(() => assertRulesMatchMatrix(matrix)).not.toThrow();
    // The scan must drive at least one homepage row, or it does nothing.
    expect(FEATURE_RULES.some((r) => matrix.rows.has(r.rowLabel))).toBe(true);
  });

  it("row-less rules really have no row, each has a reason, and each is a real rule", () => {
    const { rows } = parseCurrentMatrix(HOMEPAGE);
    const ruleLabels = new Set<string>(FEATURE_RULES.map((r) => r.rowLabel));
    for (const [label, reason] of Object.entries(MATRIX_ROWLESS_RULES)) {
      expect(ruleLabels.has(label), label).toBe(true);
      expect(rows.has(label), label).toBe(false);
      expect(reason.length).toBeGreaterThan(10);
    }
  });

  it("row-less membership checks own keys: every key is a real rule, prototype names are not", () => {
    const ruleLabels = new Set<string>(FEATURE_RULES.map((r) => r.rowLabel));
    for (const label of Object.keys(MATRIX_ROWLESS_RULES)) {
      expect(ruleLabels.has(label), label).toBe(true);
      expect(isRowlessRule(label), label).toBe(true);
    }
    for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) {
      expect(isRowlessRule(name), name).toBe(false);
    }
    // A real rule with a homepage row is not row-less.
    expect(isRowlessRule("Embeddings API")).toBe(false);
  });
});

describe("missing-row guard on the real homepage", () => {
  const TARGET = "Embeddings API";
  const RENAMED = "Embeddings API (renamed)";

  // The real page with one real row label renamed, as a homepage edit would.
  function homepageWithRenamedRow(): string {
    const cell = `<th scope="row">${TARGET}</th>`;
    expect(HOMEPAGE.split(cell)).toHaveLength(2);
    return HOMEPAGE.replace(cell, `<th scope="row">${RENAMED}</th>`);
  }

  it("the target row exists and a rule drives it", () => {
    expect(parseCurrentMatrix(HOMEPAGE).rows.has(TARGET)).toBe(true);
    expect(FEATURE_RULES.some((r) => r.rowLabel === TARGET)).toBe(true);
    expect(isRowlessRule(TARGET)).toBe(false);
  });

  it("findUnmatchedRules reports exactly the renamed row's rule", () => {
    const matrix = parseCurrentMatrix(homepageWithRenamedRow());
    expect(matrix.rows.has(RENAMED)).toBe(true);
    expect(matrix.rows.has(TARGET)).toBe(false);
    expect(findUnmatchedRules(matrix)).toEqual([TARGET]);
  });

  it("the guard main() runs throws and names the renamed row", () => {
    const matrix = parseCurrentMatrix(homepageWithRenamedRow());
    expect(() => assertRulesMatchMatrix(matrix)).toThrow(
      `FEATURE_RULES name rows missing from the homepage matrix: ${TARGET}.`,
    );
  });
});

describe("simulated capability change on the real homepage", () => {
  it("flips exactly the one target cell, on one line, for every cross-mark cell", () => {
    // The scan can only ever change a cross-mark cell. The bot flips them
    // over time; when the live page has none left, check a copy with one set.
    const page =
      ruleCells().no.length > 0
        ? HOMEPAGE
        : withCell(HOMEPAGE, firstRuleRowHtml(), competitorColumns()[0], REAL_NO_CELL);
    const { no } = ruleCells(page);
    expect(no.length).toBeGreaterThan(0);
    const before = page.split("\n");
    for (const { competitor, capability } of no) {
      const where = `${competitor} / ${capability}`;
      const matrix = parseCurrentMatrix(page);
      const changes = computeChanges(page, matrix, new Map([[competitor, { [capability]: true }]]));
      expect(changes, where).toEqual([{ competitor, capability, from: "No", to: "Yes" }]);

      const result = applyChanges(page, changes);
      expect(result.applied, where).toEqual(changes);
      expect(result.unapplied, where).toEqual([]);
      const updated = result.html;
      const after = updated.split("\n");
      expect(after.length, where).toBe(before.length);
      const changedLines = before
        .map((line, i) => (line !== after[i] ? i : -1))
        .filter((i) => i >= 0);
      expect(changedLines, where).toHaveLength(1);
      const i = changedLines[0];
      // Only the no-mark changed, into a yes-mark; the rest of the line is kept.
      const noSpan = before[i].match(NO_SPAN)?.[0];
      expect(noSpan, where).toBeDefined();
      const [prefix, suffix] = before[i].split(noSpan!);
      expect(after[i].startsWith(prefix), where).toBe(true);
      expect(after[i].endsWith(suffix), where).toBe(true);
      expect(after[i].slice(prefix.length, after[i].length - suffix.length), where).toMatch(
        new RegExp(`^${YES_SPAN.source}$`),
      );

      // Re-parse: only the target cell differs.
      const reparsed = parseCurrentMatrix(updated);
      for (const [label, row] of matrix.rows) {
        for (const [col, cell] of row) {
          const now = reparsed.rows.get(label)!.get(col);
          if (label === capability && col === competitor) {
            expect(now, where).toMatch(YES_SPAN);
            expect(now, where).not.toMatch(NO_CELL);
          } else {
            expect(now, `${label} / ${col}`).toBe(cell);
          }
        }
      }
    }
  });

  it("does not touch the page when the detected feature is already yes or free text", () => {
    const { notNo } = ruleCells();
    expect(notNo.length).toBeGreaterThan(0);
    const features = new Map<string, Record<string, boolean>>();
    for (const { competitor, capability } of notNo) {
      features.set(competitor, { ...features.get(competitor), [capability]: true });
    }
    const changes = computeChanges(HOMEPAGE, parseCurrentMatrix(HOMEPAGE), features);
    expect(changes).toEqual([]);
    expect(applyChanges(HOMEPAGE, changes).html).toBe(HOMEPAGE);
  });
});

describe("duplicate row labels in the real homepage table", () => {
  // Duplicates one real <tr> right after itself. A repeated label must fail:
  // a map keyed by label would keep one copy while applyChanges flips both.
  function withDuplicatedRow(label: string): string {
    const tr = HOMEPAGE.match(
      new RegExp(`<tr\\b[^>]*>\\s*<th scope="row">${label}</th>[\\s\\S]*?</tr>`),
    )![0];
    return HOMEPAGE.replace(tr, () => `${tr}\n${tr}`);
  }

  it("the real homepage has no duplicate row labels", () => {
    const labels = pageBodyRows().map((r) => r.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("fails loudly, naming the label, when a row label repeats", () => {
    const dup = withDuplicatedRow("MCP tool mocking");
    expect(dup.split('<th scope="row">MCP tool mocking</th>')).toHaveLength(3);
    expect(() => parseCurrentMatrix(dup)).toThrow(
      /Duplicate row label in the homepage matrix: "MCP tool mocking"/,
    );
  });
});

describe("changes that cannot be placed on the real homepage", () => {
  // A cross-mark cell: placeable.
  const PLACEABLE: DetectedChange = {
    competitor: "VidaiMock",
    capability: "OpenRouter router / fallback simulation",
    from: "No",
    to: "Yes",
  };
  // A check-mark cell: not in the "no" state.
  const CELL_NOT_NO: DetectedChange = {
    competitor: "VidaiMock",
    capability: "Chat Completions SSE",
    from: "No",
    to: "Yes",
  };
  // No such row on the homepage.
  const NO_ROW: DetectedChange = {
    competitor: "VidaiMock",
    capability: "Teleportation API",
    from: "No",
    to: "Yes",
  };
  // No such column on the homepage.
  const NO_COLUMN: DetectedChange = {
    competitor: "nonexistent-mock",
    capability: "OpenRouter router / fallback simulation",
    from: "No",
    to: "Yes",
  };

  // The real homepage with the PLACEABLE cell set to "no" and the CELL_NOT_NO
  // cell set to "yes", so the tests hold whatever the live cells show.
  const PAGE = withCell(
    withCell(HOMEPAGE, PLACEABLE.capability, PLACEABLE.competitor, REAL_NO_CELL),
    CELL_NOT_NO.capability,
    CELL_NOT_NO.competitor,
    REAL_YES_CELL,
  );

  let dir: string | undefined;
  afterEach(() => {
    vi.restoreAllMocks();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function setup(): { docsPath: string; summaryPath: string; logs: string[] } {
    dir = mkdtempSync(join(tmpdir(), "aimock-cm-unplaced-"));
    const docsPath = join(dir, "index.html");
    writeFileSync(docsPath, PAGE, "utf-8");
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.join(" "));
    });
    return { docsPath, summaryPath: join(dir, "summary.md"), logs };
  }

  it("the placeable fixture is a cross-mark cell and the other is not", () => {
    const row = parseCurrentMatrix(PAGE).rows.get(PLACEABLE.capability)!;
    expect(row.get(PLACEABLE.competitor)).toMatch(NO_CELL);
    const chat = parseCurrentMatrix(PAGE).rows.get(CELL_NOT_NO.capability)!;
    expect(chat.get(CELL_NOT_NO.competitor)).not.toMatch(NO_CELL);
  });

  it("applyChanges reports which changes it applied and which it could not place", () => {
    const result = applyChanges(PAGE, [PLACEABLE, CELL_NOT_NO, NO_ROW, NO_COLUMN]);
    expect(result.applied).toEqual([PLACEABLE]);
    expect(result.unapplied).toEqual([
      { change: CELL_NOT_NO, reason: "cell-not-no" },
      { change: NO_ROW, reason: "row-not-found" },
      { change: NO_COLUMN, reason: "unknown-competitor" },
    ]);
    const after = parseCurrentMatrix(result.html);
    expect(after.rows.get(PLACEABLE.capability)!.get(PLACEABLE.competitor)).toContain(
      'class="yes"',
    );
  });

  it("applyChanges reports every change applied when all are placeable", () => {
    const result = applyChanges(PAGE, [PLACEABLE]);
    expect(result.applied).toEqual([PLACEABLE]);
    expect(result.unapplied).toEqual([]);
  });

  it("writeMatrixUpdate fails loudly, writes no page, and logs no success when a change is unplaced", () => {
    const { docsPath, summaryPath, logs } = setup();
    expect(() =>
      writeMatrixUpdate({
        html: PAGE,
        changes: [PLACEABLE, CELL_NOT_NO],
        docsPath,
        summaryPath,
        dryRun: false,
      }),
    ).toThrow(/1 of 2 computed change\(s\) could not be placed/);
    expect(logs.join("\n")).not.toMatch(/Updated docs\/index\.html successfully/);
    expect(readFileSync(docsPath, "utf-8")).toBe(PAGE);

    // Nothing was written, so no summary may claim a change: the run's error
    // names the unplaced change instead.
    expect(existsSync(summaryPath)).toBe(false);
  });

  it("writeMatrixUpdate writes no migration page and no summary when a change is unplaced", () => {
    const { docsPath, summaryPath } = setup();
    const pagePath = join(dir!, "migration.html");
    writeFileSync(pagePath, "before", "utf-8");
    expect(() =>
      writeMatrixUpdate({
        html: PAGE,
        changes: [PLACEABLE, CELL_NOT_NO],
        docsPath,
        summaryPath,
        dryRun: false,
        migrationUpdates: [
          {
            path: pagePath,
            relPath: "docs/migration.html",
            html: "after",
            changes: ["VidaiMock: OpenRouter ✗ -> ✓"],
          },
        ],
      }),
    ).toThrow(/could not be placed/);
    expect(readFileSync(docsPath, "utf-8")).toBe(PAGE);
    expect(readFileSync(pagePath, "utf-8")).toBe("before");
    expect(existsSync(summaryPath)).toBe(false);
  });

  it("writeMatrixUpdate fails loudly on a dry run too", () => {
    const { docsPath, summaryPath } = setup();
    expect(() =>
      writeMatrixUpdate({
        html: PAGE,
        changes: [PLACEABLE, NO_ROW],
        docsPath,
        summaryPath,
        dryRun: true,
      }),
    ).toThrow(/could not be placed/);
    expect(readFileSync(docsPath, "utf-8")).toBe(PAGE);
    expect(existsSync(summaryPath)).toBe(false);
  });

  it("writeMatrixUpdate logs success and summarises the applied changes when all are placed", () => {
    const { docsPath, summaryPath, logs } = setup();
    const written = writeMatrixUpdate({
      html: PAGE,
      changes: [PLACEABLE],
      docsPath,
      summaryPath,
      dryRun: false,
    });
    expect(written).toEqual([PLACEABLE]);
    expect(logs.join("\n")).toMatch(/Updated docs\/index\.html successfully/);
    expect(readFileSync(docsPath, "utf-8")).not.toBe(PAGE);
    expect(existsSync(summaryPath)).toBe(true);
    const summary = readFileSync(summaryPath, "utf-8");
    expect(summary).toContain(
      "| VidaiMock | OpenRouter router / fallback simulation | No -> Yes |",
    );
    expect(summary).not.toMatch(/Not applied/);
  });
});

describe("row labels are plain text, not raw HTML", () => {
  // The homepage writes "Search &amp; rerank". A rule author writes the plain
  // text "Search & rerank", and that must match the row.
  it("the real homepage encodes the label (precondition)", () => {
    expect(HOMEPAGE).toContain('<th scope="row">Search &amp; rerank</th>');
  });

  it("parseCurrentMatrix keys the row by its decoded label", () => {
    const { rows } = parseCurrentMatrix(HOMEPAGE);
    expect(rows.has("Search & rerank")).toBe(true);
    expect(rows.has("Search &amp; rerank")).toBe(false);
  });

  it("a plain-text label flips the target cell on the real homepage", () => {
    // Both cells are set to "no" in a copy, so the test holds whatever their
    // live state is.
    let page = withCell(HOMEPAGE, "Search &amp; rerank", "mock-llm", REAL_NO_CELL);
    page = withCell(page, "Search &amp; rerank", "VidaiMock", REAL_NO_CELL);
    const matrix = parseCurrentMatrix(page);
    const changes = computeChanges(
      page,
      matrix,
      new Map([["mock-llm", { "Search & rerank": true }]]),
    );
    expect(changes).toEqual([
      { competitor: "mock-llm", capability: "Search & rerank", from: "No", to: "Yes" },
    ]);
    const result = applyChanges(page, changes);
    expect(result.unapplied).toEqual([]);
    expect(result.applied).toEqual(changes);
    const updated = result.html;
    expect(updated).not.toBe(page);
    const row = parseCurrentMatrix(updated).rows.get("Search & rerank")!;
    expect(row.get("mock-llm")).toContain('class="yes"');
    expect(`<td>${row.get("VidaiMock")}</td>`).toBe(REAL_NO_CELL);
  });
});

// Rules with no homepage row (MATRIX_ROWLESS_RULES) never produce a homepage
// change. Their detections are reported for manual follow-up, and they still
// update the competitor's migration page when it has a row for them. These
// tests run the apply step on copies of the real homepage and the real
// migration pages.
describe("row-less detections on the real homepage and migration pages", () => {
  let root: string;
  let logged: string[];

  const MIGRATION_PAGES = Object.values(COMPETITOR_MIGRATION_PAGES);

  /** Copies docs/index.html and every mapped migration page into a temp repo root. */
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cm-rowless-"));
    for (const rel of ["docs/index.html", ...MIGRATION_PAGES]) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      copyFileSync(resolve(REPO_ROOT, rel), join(root, rel));
    }
    logged = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.join(" "));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  const read = (rel: string) => readFileSync(join(root, rel), "utf-8");
  const readAllPages = () => new Map(MIGRATION_PAGES.map((rel) => [rel, read(rel)]));
  const MOCK_LLM_PAGE = COMPETITOR_MIGRATION_PAGES["mock-llm"];
  /** The first competitor-column cell of a row on a real migration page. */
  const migrationCell = (html: string, rowLabel: string) =>
    html.match(new RegExp(`<td>${rowLabel}</td>\\s*(<td[^>]*>[\\s\\S]*?</td>)`))?.[1];
  const CROSS = '<td style="color: var(--error)">&#10007;</td>';
  const CHECK = '<td style="color: var(--accent)">&#10003;</td>';
  /**
   * Sets the first competitor-column cell of a row on the mock-llm migration
   * page copy, so a test does not depend on the live cell. A bot run that
   * applies a mock-llm homepage change also rewrites the live page.
   */
  function setMockLlmCell(rowLabel: string, cell: string): void {
    expect(migrationCell(read(MOCK_LLM_PAGE), rowLabel)).toBeDefined();
    writeFileSync(
      join(root, MOCK_LLM_PAGE),
      read(MOCK_LLM_PAGE).replace(
        new RegExp(`(<td>${rowLabel}</td>\\s*)<td[^>]*>[\\s\\S]*?</td>`),
        (_m, pre: string) => pre + cell,
      ),
    );
    expect(migrationCell(read(MOCK_LLM_PAGE), rowLabel)).toBe(cell);
  }

  /** The body of the summary section under `heading`, up to the next "## " heading. */
  function summarySection(md: string, heading: string): string | undefined {
    const at = md.indexOf(`${heading}\n`);
    if (at < 0) return undefined;
    const rest = md.slice(at + heading.length + 1);
    const next = rest.search(/^## /m);
    return next < 0 ? rest : rest.slice(0, next);
  }
  const ROWLESS_HEADING = "## Row-Less Detections (Manual Follow-Up)";

  /** The indented log lines under the row-less log header. */
  function rowlessLogLines(): string[] {
    const lines = logged.join("\n").split("\n");
    const at = lines.findIndex((l) => /row-less detection\(s\) to check by hand/.test(l));
    if (at < 0) return [];
    const out: string[] = [];
    for (const l of lines.slice(at + 1)) {
      if (!l.startsWith("  ")) break;
      out.push(l.trim());
    }
    return out;
  }

  function run(features: Map<string, Record<string, boolean>>, dryRun = false) {
    runMatrixUpdate({
      repoRoot: root,
      competitorFeatures: features,
      competitorProviderCounts: new Map(),
      dryRun,
      summaryPath: join(root, "summary.md"),
    });
  }

  it("flips the migration page for a row-less detection and still reports it", () => {
    // No homepage row for the rule. The migration page copy gets a cross, so
    // the flip shows whatever the live cell shows.
    expect(isRowlessRule("AWS Bedrock")).toBe(true);
    expect(parseCurrentMatrix(HOMEPAGE).rows.has("AWS Bedrock")).toBe(false);
    setMockLlmCell("AWS Bedrock", CROSS);
    const before = readAllPages();

    run(new Map([["mock-llm", { "AWS Bedrock": true }]]));

    expect(read("docs/index.html")).toBe(HOMEPAGE);
    expect(migrationCell(read(MOCK_LLM_PAGE), "AWS Bedrock")).toBe(CHECK);
    for (const [rel, html] of before) if (rel !== MOCK_LLM_PAGE) expect(read(rel), rel).toBe(html);
    const md = read("summary.md");
    expect(summarySection(md, "## Migration Page Changes")).toContain(
      "mock-llm: AWS Bedrock ✗ -> ✓",
    );
    expect(summarySection(md, ROWLESS_HEADING)).toContain("| mock-llm | AWS Bedrock |");
    expect(rowlessLogLines()).toEqual(["mock-llm / AWS Bedrock"]);
  });

  it("reports a row-less detection that no page has a row for", () => {
    // VidaiMock's real migration page has no Realtime row.
    const vidaiPage = COMPETITOR_MIGRATION_PAGES.VidaiMock;
    const vidaiBefore = read(vidaiPage);
    for (const label of buildMigrationRowPatterns("Realtime GA protocol")) {
      expect(vidaiBefore).not.toContain(`<td>${label}</td>`);
    }

    run(new Map([["VidaiMock", { "Realtime GA protocol": true }]]));

    expect(read("docs/index.html")).toBe(HOMEPAGE);
    expect(read(vidaiPage)).toBe(vidaiBefore);
    expect(summarySection(read("summary.md"), ROWLESS_HEADING)).toContain(
      "| VidaiMock | Realtime GA protocol |",
    );
    expect(rowlessLogLines()).toEqual(["VidaiMock / Realtime GA protocol"]);
  });

  it("still updates the migration page of a competitor with an applied homepage change", () => {
    // mock-llm's Claude cell is set to no on the homepage copy and to a cross
    // on the migration page copy, so the test holds whatever the live cells show.
    writeFileSync(
      join(root, "docs/index.html"),
      withCell(HOMEPAGE, "Claude Messages API", "mock-llm", REAL_NO_CELL),
    );
    setMockLlmCell("Anthropic Claude", CROSS);
    const vidaiBefore = read(COMPETITOR_MIGRATION_PAGES.VidaiMock);

    run(
      new Map<string, Record<string, boolean>>([
        ["mock-llm", { "Claude Messages API": true }],
        ["VidaiMock", { "AWS Bedrock": true }],
      ]),
    );

    expect(
      parseCurrentMatrix(read("docs/index.html")).rows.get("Claude Messages API")!.get("mock-llm"),
    ).toContain('class="yes"');
    expect(migrationCell(read(MOCK_LLM_PAGE), "Anthropic Claude")).toBe(CHECK);
    // VidaiMock has only a row-less detection: its page is untouched.
    expect(read(COMPETITOR_MIGRATION_PAGES.VidaiMock)).toBe(vidaiBefore);
    const md = read("summary.md");
    expect(summarySection(md, "## Migration Page Changes")).toContain(
      "mock-llm: Anthropic Claude ✗ -> ✓",
    );
    expect(summarySection(md, ROWLESS_HEADING)).toContain("| VidaiMock | AWS Bedrock |");
  });

  it("dry run reports the row-less detection and writes no docs", () => {
    setMockLlmCell("AWS Bedrock", CROSS);
    const before = readAllPages();
    run(new Map([["mock-llm", { "AWS Bedrock": true }]]), true);

    expect(readAllPages()).toEqual(before);
    expect(read("docs/index.html")).toBe(HOMEPAGE);
    expect(logged.join("\n")).toContain(`${MOCK_LLM_PAGE}: mock-llm: AWS Bedrock ✗ -> ✓`);
    expect(rowlessLogLines()).toEqual(["mock-llm / AWS Bedrock"]);
  });
});

describe("body rows whose cell count does not match the header", () => {
  // A row with fewer cells than the header leaves the competitors in the
  // columns it does not reach with no cell, so computeChanges would silently
  // drop every detection for those competitors. Such a row must fail. colspan is rejected, not expanded: one homepage cell
  // must belong to exactly one column, so a flip changes one competitor only.

  // The real homepage with the last column's cell of the first rule-driven
  // row set to a cross mark, so the fixture does not depend on live cells.
  const LAST = pageHeaders()[pageHeaders().length - 1];
  const BASE = withCell(HOMEPAGE, firstRuleRowHtml(), LAST, REAL_NO_CELL);

  /** The rule-driven row of BASE whose LAST column holds a cross-mark cell. */
  function trailingNoTarget(): { label: string; competitor: string; tr: string } {
    const label = decodeHTML(firstRuleRowHtml());
    const tr = [...BASE.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/g)]
      .map((m) => m[0])
      .find(
        (t) => decodeHTML(t.match(/<th scope="row">([\s\S]*?)<\/th>/)?.[1] ?? "").trim() === label,
      )!;
    const cells = [...tr.matchAll(/<td\b[^>]*>[\s\S]*?<\/td>/g)].map((m) => m[0]);
    expect(cells[cells.length - 1]).toBe(REAL_NO_CELL);
    return { label, competitor: LAST, tr };
  }

  /** BASE with the target row's trailing <td> removed. */
  function withShortRow(): { html: string; label: string; competitor: string } {
    const { label, competitor, tr } = trailingNoTarget();
    const lastTd = [...tr.matchAll(/\s*<td\b[^>]*>[\s\S]*?<\/td>/g)].pop()!;
    const shortTr = tr.slice(0, lastTd.index) + tr.slice(lastTd.index! + lastTd[0].length);
    return { html: BASE.replace(tr, () => shortTr), label, competitor };
  }

  /** BASE with the target row's last two <td>s merged into one colspan="2" cell. */
  function withColspanRow(): { html: string; label: string } {
    const { label, tr } = trailingNoTarget();
    const tds = [...tr.matchAll(/<td\b[^>]*>[\s\S]*?<\/td>/g)];
    const a = tds[tds.length - 2];
    const b = tds[tds.length - 1];
    const merged =
      tr.slice(0, a.index) +
      '<td colspan="2"><span class="no">&#10007;</span></td>' +
      tr.slice(b.index! + b[0].length);
    return { html: BASE.replace(tr, () => merged), label };
  }

  it("the fixture really shortens one rule-driven row with a cross-mark trailing cell", () => {
    const { html, label, competitor } = withShortRow();
    expect(html).not.toBe(BASE);
    expect(competitorColumns()).toContain(competitor);
    expect(FEATURE_RULES.some((r) => r.rowLabel === label)).toBe(true);
  });

  it("parseCurrentMatrix fails loudly, naming the row, when a row has fewer cells than the header", () => {
    const { html, label } = withShortRow();
    expect(() => parseCurrentMatrix(html)).toThrow(label);
    // Columns = the "Capability" label column plus one per linked header.
    const columns = pageHeaders().length + 1;
    expect(() => parseCurrentMatrix(html)).toThrow(
      `has ${columns - 1} cells but the header has ${columns} columns`,
    );
  });

  it("parseCurrentMatrix rejects a colspan cell, naming the row", () => {
    const { html, label } = withColspanRow();
    expect(() => parseCurrentMatrix(html)).toThrow(label);
    expect(() => parseCurrentMatrix(html)).toThrow(/colspan/);
  });

  it("applyChanges fails loudly on the same short row instead of placing nothing", () => {
    const { html, label, competitor } = withShortRow();
    const change: DetectedChange = { competitor, capability: label, from: "No", to: "Yes" };
    expect(() => applyChanges(html, [change])).toThrow(label);
  });

  it("applyChanges rejects a colspan cell too", () => {
    const { html, label } = withColspanRow();
    const change: DetectedChange = {
      competitor: competitorColumns()[0],
      capability: label,
      from: "No",
      to: "Yes",
    };
    expect(() => applyChanges(html, [change])).toThrow(/colspan/);
  });

  it("the unshortened page still parses, and the detection for that cell is kept", () => {
    const { label, competitor } = trailingNoTarget();
    const matrix = parseCurrentMatrix(BASE);
    const changes = computeChanges(BASE, matrix, new Map([[competitor, { [label]: true }]]));
    expect(changes).toEqual([{ competitor, capability: label, from: "No", to: "Yes" }]);
  });
});
