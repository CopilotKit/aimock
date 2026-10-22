import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Every competitive comparison table on the docs site (the homepage matrices
// and the migration-page tables) carries a one-line legend directly beneath
// it, listing only the marks that table uses. "Not documented" cells are
// abbreviated to ND so the competitor columns stay narrow.

const DOCS = resolve(dirname(fileURLToPath(import.meta.url)), "../../docs");

const ND = '<abbr title="Not documented">ND</abbr>';

const PAGES = [
  "index.html",
  ...readdirSync(DOCS)
    .filter((d) => d.startsWith("migrate-from-"))
    .map((d) => join(d, "index.html")),
];

/** A mark a table can use, and how to spot it in table or legend HTML. */
const MARKS: { name: string; re: RegExp }[] = [
  { name: "check", re: /&#10003;|✓/ },
  { name: "cross", re: /&#10007;|✗/ },
  { name: "partial", re: /class="partial"/ },
  { name: "manual", re: /class="manual"/ },
  { name: "ND", re: /<abbr title="Not documented">ND<\/abbr>/ },
];

interface FoundTable {
  page: string;
  html: string;
  /** The legend <p> right after the table (or its wrapper), if any. */
  legend: string | null;
}

function tablesWithMarks(): FoundTable[] {
  const found: FoundTable[] = [];
  for (const page of PAGES) {
    const src = readFileSync(join(DOCS, page), "utf-8");
    const re = /<table\b[\s\S]*?<\/table>/g;
    for (const m of src.matchAll(re)) {
      const html = m[0];
      // Only tables that use a mark are comparison tables (others,
      // such as the python-mocks library list, are plain prose tables).
      if (!MARKS.some((k) => k.re.test(html)) && !html.includes("Not documented")) continue;
      const after = src.slice((m.index ?? 0) + html.length);
      const legend =
        after.match(/^\s*(?:<\/div>\s*)?(<p class="matrix-legend">[\s\S]*?<\/p>)/)?.[1] ?? null;
      found.push({ page, html, legend });
    }
  }
  return found;
}

describe("docs comparison-table legends", () => {
  const tables = tablesWithMarks();

  it("finds the homepage matrices and the migration-page tables", () => {
    expect(tables.filter((t) => t.page === "index.html")).toHaveLength(2);
    expect(tables.length).toBeGreaterThanOrEqual(8);
  });

  it.each(tables.map((t, i) => [`${t.page} #${i}`, t] as const))(
    "%s is followed by a legend listing exactly its marks",
    (_label, t) => {
      expect(t.legend, `${t.page}: no <p class="matrix-legend"> under the table`).not.toBeNull();
      for (const mark of MARKS) {
        expect(mark.re.test(t.legend!), `${t.page}: legend vs table for ${mark.name}`).toBe(
          mark.re.test(t.html),
        );
      }
    },
  );
});

describe("docs Not documented cells", () => {
  it.each(PAGES)("%s has no 'Not documented' cell text", (page) => {
    const src = readFileSync(join(DOCS, page), "utf-8");
    const cellText = src.replace(/<abbr title="Not documented">/g, "");
    expect(cellText).not.toMatch(/>\s*Not documented\s*</);
  });

  it("renders the homepage's Not documented cells as ND abbreviations", () => {
    const src = readFileSync(join(DOCS, "index.html"), "utf-8");
    const tablesOnly = [...src.matchAll(/<table\b[\s\S]*?<\/table>/g)].map((m) => m[0]).join("");
    expect(tablesOnly.split(ND).length - 1).toBe(47);
  });

  it("styles the legend with one shared class on each stylesheet", () => {
    const home = readFileSync(join(DOCS, "index.html"), "utf-8");
    const css = readFileSync(join(DOCS, "style.css"), "utf-8");
    expect(home).toMatch(/\.matrix-legend\s*\{/);
    expect(css).toMatch(/\.matrix-legend\s*\{/);
  });
});
