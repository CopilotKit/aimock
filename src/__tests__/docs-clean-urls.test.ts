import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DOCS_DIR = path.resolve(import.meta.dirname, "../../docs");

/** Recursively collect all HTML files under a directory. */
function collectHtmlFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectHtmlFiles(full));
    } else if (entry.name.endsWith(".html")) {
      results.push(full);
    }
  }
  return results;
}

/** Extract all href values from an HTML string (excludes external links and anchors). */
function extractInternalHrefs(html: string): string[] {
  const hrefRegex = /href="([^"]+)"/g;
  const hrefs: string[] = [];
  let match;
  while ((match = hrefRegex.exec(html)) !== null) {
    const href = match[1];
    // Skip external links, anchors, and protocol-relative URLs
    if (href.startsWith("http") || href.startsWith("#") || href.startsWith("//")) continue;
    hrefs.push(href);
  }
  return hrefs;
}

const allHtmlFiles = collectHtmlFiles(DOCS_DIR);
const SKIP_FILES = ["index.html", "og-image.html"];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("docs clean URLs", () => {
  it("docs directory exists and contains HTML files", () => {
    expect(fs.existsSync(DOCS_DIR)).toBe(true);
    expect(allHtmlFiles.length).toBeGreaterThan(0);
  });

  describe("file structure", () => {
    it("only index.html and og-image.html exist at root level", () => {
      const rootHtmlFiles = fs
        .readdirSync(DOCS_DIR, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(".html"))
        .map((e) => e.name);

      for (const file of rootHtmlFiles) {
        expect(SKIP_FILES).toContain(file);
      }
    });

    it("each doc page lives in its own directory as index.html", () => {
      // Non-page directories (specs, assets, etc.) are excluded
      const NON_PAGE_DIRS = new Set(["superpowers"]);
      const subdirs = fs
        .readdirSync(DOCS_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !NON_PAGE_DIRS.has(e.name));

      expect(subdirs.length).toBeGreaterThan(0);

      for (const dir of subdirs) {
        const indexPath = path.join(DOCS_DIR, dir.name, "index.html");
        expect(fs.existsSync(indexPath), `${dir.name}/index.html should exist`).toBe(true);
      }
    });

    it("no stale .html files remain at the docs root (besides allowed ones)", () => {
      const rootHtmlFiles = fs
        .readdirSync(DOCS_DIR, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(".html"))
        .map((e) => e.name);

      const unexpected = rootHtmlFiles.filter((f) => !SKIP_FILES.includes(f));
      expect(unexpected, `Unexpected root-level HTML files: ${unexpected.join(", ")}`).toEqual([]);
    });
  });

  describe("internal links have no .html extension", () => {
    for (const filePath of allHtmlFiles) {
      const relative = path.relative(DOCS_DIR, filePath);

      it(`${relative} — no .html in internal hrefs`, () => {
        const html = fs.readFileSync(filePath, "utf-8");
        const hrefs = extractInternalHrefs(html);

        const badHrefs = hrefs.filter((h) => /\.html/.test(h));
        expect(badHrefs, `Found .html hrefs in ${relative}: ${badHrefs.join(", ")}`).toEqual([]);
      });
    }
  });

  describe("sidebar.js links have no .html extension", () => {
    it("no .html in sidebar href values", () => {
      const sidebarPath = path.join(DOCS_DIR, "sidebar.js");
      const content = fs.readFileSync(sidebarPath, "utf-8");

      // Extract all href: "..." values
      const hrefRegex = /href:\s*"([^"]+)"/g;
      const hrefs: string[] = [];
      let match;
      while ((match = hrefRegex.exec(content)) !== null) {
        hrefs.push(match[1]);
      }

      const badHrefs = hrefs.filter((h) => /\.html/.test(h));
      expect(badHrefs, `Found .html hrefs in sidebar.js: ${badHrefs.join(", ")}`).toEqual([]);
    });
  });

  describe("homepage replaceState redirect exists", () => {
    it("index.html contains history.replaceState for /index.html cleanup", () => {
      const indexPath = path.join(DOCS_DIR, "index.html");
      const html = fs.readFileSync(indexPath, "utf-8");

      expect(html).toContain("replaceState");
      expect(html).toContain("index.html");
    });
  });

  describe("all internal link targets resolve to existing pages", () => {
    const knownPages = new Set<string>();

    // Build set of known page slugs from directory names
    const subdirs = fs
      .readdirSync(DOCS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);

    for (const dir of subdirs) {
      knownPages.add(`/${dir}`);
    }

    for (const filePath of allHtmlFiles) {
      const relative = path.relative(DOCS_DIR, filePath);

      it(`${relative} — all internal links point to existing pages`, () => {
        const html = fs.readFileSync(filePath, "utf-8");
        const hrefs = extractInternalHrefs(html);

        for (const href of hrefs) {
          // Strip anchor
          const base = href.split("#")[0];
          if (base === "" || base === "/") continue; // root or anchor-only
          if (base.startsWith("/")) {
            expect(
              knownPages.has(base),
              `${relative} links to ${href} but no page directory exists for "${base}"`,
            ).toBe(true);
          }
        }
      });
    }
  });
});
