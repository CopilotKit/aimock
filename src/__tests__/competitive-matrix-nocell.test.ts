import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseCurrentMatrix,
  computeChanges,
  applyChanges,
  classifyNoCell,
  runMatrixUpdate,
  COMPETITOR_MIGRATION_PAGES,
  type DetectedChange,
} from "../../scripts/update-competitive-matrix.js";

// Recognition (computeChanges) and flipping (applyChanges) must agree on which
// "no" cells exist and which of them can be flipped. A cell that shows "no"
// in a shape the flip does not support is detected and reported as unapplied,
// never silently dropped and never half-flipped.

const YES = '<span class="yes" role="img" aria-label="Yes">&#10003;</span>';
/** The exact no-cell markup the real homepage uses. */
const REAL_NO_CELL = '<td><span class="no" role="img" aria-label="No">&#10007;</span></td>';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HOMEPAGE = readFileSync(resolve(REPO_ROOT, "docs/index.html"), "utf-8");

const matrixWith = (cell: string) => `
<table class="comparison-table">
  <thead>
    <tr>
      <th scope="col">Capability</th>
      <th scope="col" class="col-aimock"><a href="https://github.com/CopilotKit/aimock">aimock</a></th>
      <th scope="col"><a href="https://github.com/mswjs/msw">MSW</a></th>
      <th scope="col"><a href="https://github.com/vidaiUK/VidaiMock">VidaiMock</a></th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <th scope="row">WebSocket APIs</th>
      <td class="col-aimock"><span class="yes">Built-in &#10003;</span></td>
      ${REAL_NO_CELL}
      ${cell}
    </tr>
  </tbody>
</table>`;

const CHANGE: DetectedChange = {
  competitor: "VidaiMock",
  capability: "WebSocket APIs",
  from: "No",
  to: "Yes",
};

function detect(html: string): DetectedChange[] {
  return computeChanges(
    html,
    parseCurrentMatrix(html),
    new Map([["VidaiMock", { "WebSocket APIs": true }]]),
  );
}

interface Case {
  name: string;
  cell: string;
  /** The flipped cell markup, or null when the shape is unsupported. */
  flipped: string | null;
}

const CASES: Case[] = [
  { name: "real-page shape", cell: REAL_NO_CELL, flipped: `<td>${YES}</td>` },
  {
    name: "real-page shape with text around the span",
    cell: '<td>(v1) <span class="no" role="img" aria-label="No">&#10007;</span> planned</td>',
    flipped: `<td>(v1) ${YES} planned</td>`,
  },
  {
    name: "(d) single-quoted attributes on the no span",
    cell: "<td><span class='no' role='img' aria-label='No'>&#10007;</span></td>",
    flipped: `<td>${YES}</td>`,
  },
  {
    name: "bare cross in a cell with a no class",
    cell: '<td class="no">&#10007; (planned v2)</td>',
    flipped: `<td class="yes">${YES} (planned v2)</td>`,
  },
  { name: "(a) no class on the cell, text No", cell: '<td class="no">No</td>', flipped: null },
  { name: "(b) void no element", cell: '<td><img class="no" alt="No"></td>', flipped: null },
  {
    name: "(b) self-closing no element",
    cell: '<td><img class="no" alt="No" /> partial</td>',
    flipped: null,
  },
  {
    name: "(c) nested same-name tag inside the no span",
    cell: '<td><span class="no"><span>&#10007;</span> no</span></td>',
    flipped: null,
  },
  {
    name: "(d) no span with extra classes",
    cell: '<td><span class="no muted">&#10007;</span></td>',
    flipped: null,
  },
  {
    name: "two cross marks",
    cell: "<td>&#10007; / ✗</td>",
    flipped: null,
  },
  // An empty or whitespace-only cell is stored as "" by parseCurrentMatrix;
  // its no class must still make it detected, never skipped as missing.
  { name: "empty cell with a no class", cell: '<td class="no"></td>', flipped: null },
  {
    name: "whitespace-only cell with a no class",
    cell: '<td class="no">  \n </td>',
    flipped: null,
  },
];

describe("no-cell recognition and flipping agree", () => {
  for (const c of CASES) {
    it(`${c.name}: detected by computeChanges`, () => {
      expect(detect(matrixWith(c.cell))).toEqual([CHANGE]);
    });

    if (c.flipped !== null) {
      const flipped = c.flipped;
      it(`${c.name}: applied, and the cell becomes exactly one yes mark`, () => {
        const html = matrixWith(c.cell);
        const result = applyChanges(html, detect(html));
        expect(result.unapplied).toEqual([]);
        expect(result.applied).toEqual([CHANGE]);
        // The target is the row's last cell; the MSW cell before it may be
        // the same markup, so replace the last occurrence only.
        const at = html.lastIndexOf(c.cell);
        expect(result.html).toBe(html.slice(0, at) + flipped + html.slice(at + c.cell.length));
        const cell = parseCurrentMatrix(result.html).rows.get("WebSocket APIs")!.get("VidaiMock")!;
        expect(cell).not.toMatch(/class=["']?no\b|✗|&#10007;/);
        expect(cell.split(YES)).toHaveLength(2);
        expect(cell.match(/✓|&#10003;/g)).toHaveLength(1);
      });
    } else {
      it(`${c.name}: reported unapplied as unsupported, page unchanged`, () => {
        const html = matrixWith(c.cell);
        const result = applyChanges(html, [CHANGE]);
        expect(result.applied).toEqual([]);
        expect(result.unapplied).toEqual([{ change: CHANGE, reason: "unsupported-no-cell" }]);
        expect(result.html).toBe(html);
      });
    }
  }

  it("a flip whose result fails the post-flip check is reported unapplied", () => {
    // A supported shape whose text already has a check mark: the flip would
    // leave two yes marks, so the check rejects it.
    const cell = '<td>&#10003; partial <span class="no">&#10007;</span></td>';
    const html = matrixWith(cell);
    expect(detect(html)).toEqual([CHANGE]);
    const result = applyChanges(html, [CHANGE]);
    expect(result.applied).toEqual([]);
    expect(result.unapplied).toEqual([{ change: CHANGE, reason: "flip-check-failed" }]);
    expect(result.html).toBe(html);
  });

  it("a cell with no no-marker is neither detected nor flipped", () => {
    const html = matrixWith(`<td>${YES}</td>`);
    expect(detect(html)).toEqual([]);
    expect(applyChanges(html, [CHANGE]).unapplied).toEqual([
      { change: CHANGE, reason: "cell-not-no" },
    ]);
  });
});

/** Every <tbody> cell (<th> or <td>) of `html`'s comparison table, in page order. */
function bodyCells(html: string): { open: string; inner: string; markup: string }[] {
  const table = html.match(/<table class="comparison-table">([\s\S]*?)<\/table>/)![1];
  const tbody = table.match(/<tbody>([\s\S]*?)<\/tbody>/)![1];
  return [...tbody.matchAll(/(<(th|td)\b[^>]*>)([\s\S]*?)<\/\2>/g)].map((m) => ({
    open: m[1],
    inner: m[3],
    markup: m[0],
  }));
}

/**
 * The comparison-table cells of `html` that break the rule "every no-cell is
 * in the real-page shape and flips to exactly one yes mark". A cell is a
 * no-cell when the scan's own detector (classifyNoCell) says so, so this
 * check sees every form the scan sees. A cell in the real-page markup that the
 * detector does not call "no" is listed too.
 */
function noCellShapeProblems(html: string): string[] {
  return bodyCells(html)
    .filter((cell) => {
      const shape = classifyNoCell(cell.open, cell.inner);
      if (shape.kind === "not-no") return cell.markup === REAL_NO_CELL;
      return (
        cell.markup !== REAL_NO_CELL ||
        shape.kind !== "flippable" ||
        shape.open !== "<td>" ||
        shape.inner !== YES
      );
    })
    .map((cell) => cell.markup);
}

/** The cell index of the competitor column `name` in `html`'s comparison table header. */
function columnIndex(html: string, name: string): number {
  const thead = html.match(
    /<table class="comparison-table">[\s\S]*?<thead>([\s\S]*?)<\/thead>/,
  )![1];
  const headers = [...thead.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map((m) => m[1]);
  const idx = headers.findIndex((h) => new RegExp(`<a\\b[^>]*>\\s*${name}\\s*</a>`).test(h));
  if (idx < 0) throw new Error(`column not found: ${name}`);
  return idx;
}

/** `html` with the `column` cell of the row labelled `row` (label HTML) replaced by `cell`. */
function withCell(html: string, row: string, column: string, cell: string): string {
  const col = columnIndex(html, column);
  const rowRe = new RegExp(`<tr\\b[^>]*>\\s*<th scope="row">${row}</th>[\\s\\S]*?</tr>`);
  const tr = html.match(rowRe)?.[0];
  if (tr === undefined) throw new Error(`row not found: ${row}`);
  let idx = 0;
  const newTr = tr.replace(/<(th|td)\b[^>]*>[\s\S]*?<\/\1>/g, (c) => (idx++ === col ? cell : c));
  expect(idx).toBeGreaterThan(col);
  return html.replace(tr, () => newTr);
}

// The weekly scan flips no-cells on the real homepage to yes, so which cells
// are "no", and how many, changes over time. These checks hold for any set of
// no-cells, including none.
describe("the real homepage uses only the supported no-cell shape", () => {
  it("every no-cell is in the real-page shape and flips to exactly one yes mark", () => {
    expect(bodyCells(HOMEPAGE).length).toBeGreaterThan(0);
    expect(noCellShapeProblems(HOMEPAGE)).toEqual([]);
  });

  // Forms the scan's detector calls "no" but that are not the real-page shape:
  // each must be reported when it appears on the page.
  it.each([
    ["a hex cross", "<td>&#x2717;</td>"],
    ["a no class that is not the first class", '<td><span class="muted no">No</span></td>'],
    ["spaces around = in the class attribute", '<td class = "no">No</td>'],
    ["a <th> body cell", '<th class="no">No</th>'],
  ])("reports a no-cell written with %s", (_name, cell) => {
    const html = withCell(HOMEPAGE, "Claude Messages API", "mock-llm", cell);
    expect(noCellShapeProblems(html)).toEqual([cell]);
  });

  it("does not report a cell whose class only starts with no", () => {
    const html = withCell(
      HOMEPAGE,
      "Claude Messages API",
      "mock-llm",
      '<td class="no-wrap">x</td>',
    );
    expect(noCellShapeProblems(html)).toEqual([]);
  });
});

// The no-cell reasons must fail a real run: runMatrixUpdate computes the
// changes, writeMatrixUpdate gets them back unapplied from applyChanges and
// throws before any write, so neither reason can be dropped silently. The
// three mock-llm cells are set in a copy of the real homepage, so the test
// does not depend on their live state.
describe("a no-cell the flip cannot place fails the whole run", () => {
  let root: string;
  let summaryPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cm-nocell-run-"));
    mkdirSync(join(root, "docs"), { recursive: true });
    // The run reads every scanned competitor's migration page.
    for (const rel of Object.values(COMPETITOR_MIGRATION_PAGES)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      copyFileSync(resolve(REPO_ROOT, rel), join(root, rel));
    }
    let html = withCell(HOMEPAGE, "Claude Messages API", "mock-llm", '<td class="no">No</td>');
    html = withCell(
      html,
      "Gemini streaming",
      "mock-llm",
      '<td>&#10003; partial <span class="no">&#10007;</span></td>',
    );
    html = withCell(html, "Embeddings API", "mock-llm", REAL_NO_CELL);
    writeFileSync(join(root, "docs/index.html"), html);
    summaryPath = join(root, "summary.md");
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it.each([false, true])("throws with both reasons and writes nothing (dryRun: %s)", (dryRun) => {
    const before = readFileSync(join(root, "docs/index.html"), "utf-8");
    expect(() =>
      runMatrixUpdate({
        repoRoot: root,
        competitorFeatures: new Map([
          [
            "mock-llm",
            { "Claude Messages API": true, "Gemini streaming": true, "Embeddings API": true },
          ],
        ]),
        competitorProviderCounts: new Map(),
        dryRun,
        summaryPath,
      }),
    ).toThrow(
      "2 of 3 computed change(s) could not be placed in docs/index.html: " +
        "mock-llm / Claude Messages API (unsupported-no-cell), " +
        "mock-llm / Gemini streaming (flip-check-failed).",
    );
    expect(readFileSync(join(root, "docs/index.html"), "utf-8")).toBe(before);
    expect(existsSync(summaryPath)).toBe(false);
  });

  it.each([false, true])(
    "throws for an emptied real no-cell instead of dropping it (dryRun: %s)",
    (dryRun) => {
      const html = withCell(HOMEPAGE, "Embeddings API", "mock-llm", '<td class="no"></td>');
      writeFileSync(join(root, "docs/index.html"), html);
      expect(() =>
        runMatrixUpdate({
          repoRoot: root,
          competitorFeatures: new Map([["mock-llm", { "Embeddings API": true }]]),
          competitorProviderCounts: new Map(),
          dryRun,
          summaryPath,
        }),
      ).toThrow(
        "1 of 1 computed change(s) could not be placed in docs/index.html: " +
          "mock-llm / Embeddings API (unsupported-no-cell).",
      );
      expect(readFileSync(join(root, "docs/index.html"), "utf-8")).toBe(html);
      expect(existsSync(summaryPath)).toBe(false);
    },
  );
});
