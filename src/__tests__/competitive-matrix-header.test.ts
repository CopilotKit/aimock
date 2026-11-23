import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Header parsing of the homepage comparison table (docs/index.html). Every
// case starts from a copy of the real page and changes one <thead> cell, so the
// tests follow the page as it is edited.
import { parseCurrentMatrix, applyChanges } from "../../scripts/update-competitive-matrix.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HOMEPAGE = readFileSync(resolve(REPO_ROOT, "docs/index.html"), "utf-8");

const VIDAIMOCK_HEADER =
  '<th scope="col"><a href="https://github.com/vidaiUK/VidaiMock">VidaiMock</a></th>';
const NO_CELL = /class="no"|✗|&#10007;/;
const YES_SPAN = /<span class="yes"[^>]*>[\s\S]*?<\/span>/;

/** The homepage with the VidaiMock header cell replaced by `header`. */
function withVidaiMockHeader(header: string): string {
  expect(HOMEPAGE.split(VIDAIMOCK_HEADER)).toHaveLength(2);
  return HOMEPAGE.replace(VIDAIMOCK_HEADER, () => header);
}

/** A row label whose VidaiMock cell shows the cross mark on the real page. */
function vidaiMockCrossRow(): string {
  const { rows } = parseCurrentMatrix(HOMEPAGE);
  const label = [...rows].find(([, row]) => NO_CELL.test(row.get("VidaiMock") ?? ""))?.[0];
  expect(label).toBeDefined();
  return label!;
}

describe("homepage header with an encoded character reference", () => {
  const ENCODED = withVidaiMockHeader(
    '<th scope="col"><a href="https://github.com/vidaiUK/VidaiMock">Search &amp; Co</a></th>',
  );

  it("decodes the header name like a row label", () => {
    const { headers, rows } = parseCurrentMatrix(ENCODED);
    expect(headers).toContain("Search & Co");
    expect(headers).not.toContain("Search &amp; Co");
    for (const [label, row] of rows) {
      expect(row.has("Search & Co"), label).toBe(true);
    }
  });

  it("applyChanges flips the decoded competitor's column", () => {
    const capability = vidaiMockCrossRow();
    const change = { competitor: "Search & Co", capability, from: "No", to: "Yes" };
    const result = applyChanges(ENCODED, [change]);
    expect(result.applied).toEqual([change]);
    expect(result.unapplied).toEqual([]);
    expect(parseCurrentMatrix(result.html).rows.get(capability)!.get("Search & Co")).toMatch(
      YES_SPAN,
    );
  });

  it("treats an encoded and a plain header with the same text as duplicates", () => {
    const dup = HOMEPAGE.replace(
      '<th scope="col"><a href="https://github.com/dwmkerr/mock-llm">mock-llm</a></th>',
      '<th scope="col"><a href="https://example.com/a">A &amp; B</a></th>',
    ).replace(VIDAIMOCK_HEADER, '<th scope="col"><a href="https://example.com/b">A & B</a></th>');
    expect(() => parseCurrentMatrix(dup)).toThrow(
      /Duplicate competitor column in the homepage matrix: "A & B"/,
    );
  });
});

describe("homepage header with an <abbr> in the cell", () => {
  const WITH_ABBR = withVidaiMockHeader(
    '<th scope="col"><abbr title="Vidai">V</abbr> ' +
      '<a href="https://github.com/vidaiUK/VidaiMock">VidaiMock</a></th>',
  );

  it("reads the link text, not the <abbr>", () => {
    const { headers } = parseCurrentMatrix(WITH_ABBR);
    expect(headers).toEqual(parseCurrentMatrix(HOMEPAGE).headers);
  });

  it("applyChanges flips the VidaiMock column", () => {
    const capability = vidaiMockCrossRow();
    const change = { competitor: "VidaiMock", capability, from: "No", to: "Yes" };
    const result = applyChanges(WITH_ABBR, [change]);
    expect(result.applied).toEqual([change]);
    expect(parseCurrentMatrix(result.html).rows.get(capability)!.get("VidaiMock")).toMatch(
      YES_SPAN,
    );
  });

  it("an <abbr> alone is not a link", () => {
    const abbrOnly = withVidaiMockHeader(
      '<th scope="col"><abbr title="VidaiMock">VidaiMock</abbr></th>',
    );
    expect(parseCurrentMatrix(abbrOnly).headers).not.toContain("VidaiMock");
  });
});

describe("homepage header with a colspan cell", () => {
  it("fails loudly instead of misaligning the columns", () => {
    const spanned = withVidaiMockHeader(
      '<th scope="col" colspan="2"><a href="https://github.com/vidaiUK/VidaiMock">VidaiMock</a></th>',
    );
    expect(() => parseCurrentMatrix(spanned)).toThrow(
      /The homepage matrix header has a colspan cell/,
    );
  });

  it("applyChanges fails loudly too", () => {
    const spanned = withVidaiMockHeader(
      '<th scope="col" colspan="2"><a href="https://github.com/vidaiUK/VidaiMock">VidaiMock</a></th>',
    );
    const change = {
      competitor: "VidaiMock",
      capability: vidaiMockCrossRow(),
      from: "No",
      to: "Yes",
    };
    expect(() => applyChanges(spanned, [change])).toThrow(
      /The homepage matrix header has a colspan cell/,
    );
  });
});
