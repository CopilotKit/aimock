import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
  FEATURE_WATCH,
  runFeatureWatch,
  watchUrl,
  type FeatureWatchResult,
  type WatchSource,
  type WatchState,
} from "../../scripts/competitive-watch.js";
import { COMPETITOR_MIGRATION_PAGES } from "../../scripts/update-competitive-matrix.js";

/** A page body (HTTP 200, text/html), or an explicit status (and optional body). */
export type FixturePage = string | { status: number; body?: string };

export interface WatchFixtureServer {
  /** "http://127.0.0.1:<port>" */
  readonly origin: string;
  /** Absolute fixture URL for a path such as "/lr". */
  url(path: string): string;
  /** Sets or replaces the page at `path`. A path with no page answers 404. */
  set(path: string, page: FixturePage): void;
  /** GET count for `path`, or for all paths when omitted. */
  hits(path?: string): number;
  close(): Promise<void>;
}

/** Starts a real HTTP server on 127.0.0.1 and an ephemeral port. */
export async function startWatchFixtureServer(
  pages: Record<string, FixturePage> = {},
): Promise<WatchFixtureServer> {
  const table = new Map(Object.entries(pages));
  const counts = new Map<string, number>();
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    counts.set(path, (counts.get(path) ?? 0) + 1);
    const page = table.get(path);
    if (page === undefined) {
      res.writeHead(404).end("not found");
      return;
    }
    const { status, body } = typeof page === "string" ? { status: 200, body: page } : page;
    res.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(body ?? "");
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    url: (path) => `${origin}${path}`,
    set: (path, page) => void table.set(path, page),
    hits: (path) =>
      path === undefined
        ? [...counts.values()].reduce((a, b) => a + b, 0)
        : (counts.get(path) ?? 0),
    close: () => new Promise<void>((ok, fail) => server.close((err) => (err ? fail(err) : ok()))),
  };
}

export interface FixtureSection {
  heading: string;
  /** Default 2. */
  level?: 1 | 2 | 3 | 4 | 5 | 6;
  /** Emits id="…" on the heading (for heading-id selectors). */
  id?: string;
  /** Raw HTML placed after the heading. */
  body: string;
}

/** A minimal page: each section as <hN>heading</hN> followed by its body. Heading text is HTML-escaped. */
export function fixtureHtml(sections: readonly FixtureSection[]): string {
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const parts = sections.map((s) => {
    const n = s.level ?? 2;
    return `<h${n}${s.id ? ` id="${s.id}"` : ""}>${esc(s.heading)}</h${n}>\n${s.body}`;
  });
  return `<!doctype html><html><body><main>\n${parts.join("\n")}\n</main></body></html>\n`;
}

/**
 * A page that satisfies every html selector of `sources` with placeholder text.
 * The spawned-script fetch stub serves it for every non-GitHub URL, so a new
 * FEATURE_WATCH entry needs no stub edit.
 */
export function cannedWatchHtml(sources: readonly WatchSource[] = FEATURE_WATCH): string {
  const seen = new Set<string>();
  const sections: FixtureSection[] = [];
  let article = false;
  for (const s of sources) {
    if (s.target.kind !== "html") continue;
    const sel = s.target.section;
    if (sel.kind === "element") {
      article = true;
      continue;
    }
    const key = sel.kind === "heading" ? `t:${sel.text}` : `i:${sel.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sections.push(
      sel.kind === "heading"
        ? { heading: sel.text, body: "<p>stub</p>" }
        : { heading: sel.id, id: sel.id, body: "<p>stub</p>" },
    );
  }
  const page = fixtureHtml(sections);
  return article ? page.replace("<main>", "<main><article><p>stub</p></article>") : page;
}

export interface RunWatchAgainstFixtureOptions {
  server: WatchFixtureServer;
  /** Real source URL (e.g. MOCKSERVER_LR_URL) -> fixture path (e.g. "/lr"). */
  pages: Record<string, string>;
  /** Default: every FEATURE_WATCH entry whose page is in `pages`. Each one's page must be mapped. */
  sources?: readonly WatchSource[];
  /** Default {}. Pass a previous result's `state` for a second run. */
  previous?: WatchState;
  /** Default "2026-01-01". */
  today?: string;
}

/**
 * Runs the real runFeatureWatch with the real HTTP fetcher, redirecting each
 * mapped page to the fixture server. Throws before any request when a source's
 * page is not mapped, so a test can never reach the network.
 */
export async function runWatchAgainstFixture(
  opts: RunWatchAgainstFixtureOptions,
): Promise<FeatureWatchResult> {
  const mapped = new Set(Object.keys(opts.pages));
  const sources = opts.sources ?? FEATURE_WATCH.filter((s) => mapped.has(watchUrl(s.target)));
  const unmapped = sources.filter((s) => !mapped.has(watchUrl(s.target))).map((s) => s.id);
  if (unmapped.length > 0) throw new Error(`Fixture pages not mapped for: ${unmapped.join(", ")}`);
  if (sources.length === 0) throw new Error("No FEATURE_WATCH source watches the mapped pages");
  const urlOverrides = new Map(
    Object.entries(opts.pages).map(([real, path]) => [real, opts.server.url(path)] as const),
  );
  return runFeatureWatch({
    sources,
    previous: opts.previous ?? {},
    today: opts.today ?? "2026-01-01",
    urlOverrides,
    log: () => {},
  });
}

// ── Docs-copy cell seeding ──────────────────────────────────────────────────
//
// RULE: a test that runs the matrix scan on a copy of the real docs seeds
// every cell it asserts on, through these helpers, before it runs. The scan
// bot flips the live cells over time, so a test that reads an unseeded cell
// breaks when the bot's own PR merges.
//
// These readers locate the competitor's cell by its COLUMN, found through the
// table header, so a seed never lands in another competitor's cell. They do
// not share code with the script under test.

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const toHtml = (label: string) => label.replace(/&/g, "&amp;");
/** Every <th>/<td> element of a row, with its markup (nested spans included). */
const rowCells = (tr: string) => [...tr.matchAll(/<(th|td)\b[^>]*>[\s\S]*?<\/\1>/g)];
const stripTags = (s: string) => s.replace(/<[^>]*>/g, "").trim();

/** The migration-page header text for each competitor. */
export const MIGRATION_HEADER: Readonly<Record<string, string>> = {
  VidaiMock: "VidaiMock",
  "mock-llm": "mock-llm",
  "piyook/llm-mock": "piyook/llm-mock",
  "mokksy/ai-mocks": "Mokksy",
};

/** The competitor's 0-based cell index in each row of a migration-page table. */
export function migrationColumn(html: string, header: string): number {
  const thead = html.match(/<thead>([\s\S]*?)<\/thead>/)?.[1];
  if (thead === undefined) throw new Error("migration page has no <thead>");
  const idx = rowCells(thead)
    .map((m) => stripTags(m[0]))
    .indexOf(header);
  if (idx < 1) throw new Error(`migration header not found: ${header}`);
  return idx;
}

/** The migration-page row labeled `rowLabel`, or undefined. */
export function migrationRow(html: string, rowLabel: string): string | undefined {
  return html.match(
    new RegExp(`<tr>\\s*<td>${escapeRe(toHtml(rowLabel))}</td>[\\s\\S]*?</tr>`),
  )?.[0];
}

/** The competitor's cell in the row labeled `rowLabel` on a migration page. */
export function migrationCell(
  html: string,
  competitor: string,
  rowLabel: string,
): string | undefined {
  const tr = migrationRow(html, rowLabel);
  if (tr === undefined) return undefined;
  return rowCells(tr)[migrationColumn(html, MIGRATION_HEADER[competitor])]?.[0];
}

/** `html` (a migration page) with the competitor's cell in row `rowLabel` set to `cell`. */
export function withMigrationCell(
  html: string,
  competitor: string,
  rowLabel: string,
  cell: string,
): string {
  const tr = migrationRow(html, rowLabel);
  if (tr === undefined) throw new Error(`migration row not found: ${rowLabel}`);
  const col = migrationColumn(html, MIGRATION_HEADER[competitor]);
  return html.replace(tr, () => replaceCell(tr, col, cell));
}

/** The homepage comparison table's row labeled `rowLabel`, or undefined. */
function homeRow(html: string, rowLabel: string): string | undefined {
  return html.match(
    new RegExp(`<tr\\b[^>]*>\\s*<th scope="row">${escapeRe(toHtml(rowLabel))}</th>[\\s\\S]*?</tr>`),
  )?.[0];
}

/** The competitor's 0-based cell index in each row of the homepage comparison table. */
export function homeColumn(html: string, competitor: string): number {
  const table = html.match(/<table class="comparison-table">([\s\S]*?)<\/table>/)?.[1];
  const thead = table?.match(/<thead>([\s\S]*?)<\/thead>/)?.[1];
  if (thead === undefined) throw new Error("homepage has no comparison-table <thead>");
  const col = rowCells(thead)
    .map((m) => stripTags(m[0]))
    .indexOf(competitor);
  if (col < 1) throw new Error(`homepage header not found: ${competitor}`);
  return col;
}

/** The competitor's cell in the homepage row labeled `rowLabel`. */
export function homeCell(html: string, competitor: string, rowLabel: string): string | undefined {
  const tr = homeRow(html, rowLabel);
  if (tr === undefined) return undefined;
  return rowCells(tr)[homeColumn(html, competitor)]?.[0];
}

/** `html` (the homepage) with the competitor's cell in row `rowLabel` set to `cell`. */
export function withHomeCell(
  html: string,
  competitor: string,
  rowLabel: string,
  cell: string,
): string {
  const tr = homeRow(html, rowLabel);
  if (tr === undefined) throw new Error(`homepage row not found: ${rowLabel}`);
  const col = homeColumn(html, competitor);
  return html.replace(tr, () => replaceCell(tr, col, cell));
}

function replaceCell(tr: string, col: number, cell: string): string {
  let idx = 0;
  return tr.replace(/<(th|td)\b[^>]*>[\s\S]*?<\/\1>/g, (c) => (idx++ === col ? cell : c));
}

/** One cell to seed in a docs copy. */
export interface CellSeed {
  /** "home" is docs/index.html; "migration" is the competitor's migration page. */
  page: "home" | "migration";
  competitor: string;
  row: string;
  /** The full cell markup, e.g. `<td style="color: var(--error)">&#10007;</td>`. */
  cell: string;
}

/** The repo-relative path of the page a seed targets. */
export function seedPath(seed: Pick<CellSeed, "page" | "competitor">): string {
  if (seed.page === "home") return "docs/index.html";
  if (!Object.hasOwn(COMPETITOR_MIGRATION_PAGES, seed.competitor)) {
    throw new Error(`no migration page is mapped for ${seed.competitor}`);
  }
  return COMPETITOR_MIGRATION_PAGES[seed.competitor];
}

/** Reads the seed's cell from `html` (the page `seedPath(seed)` names). */
export function readSeedCell(html: string, seed: Omit<CellSeed, "cell">): string | undefined {
  return seed.page === "home"
    ? homeCell(html, seed.competitor, seed.row)
    : migrationCell(html, seed.competitor, seed.row);
}

/**
 * Writes each seed into the docs copy under `root`, then reads the file back
 * and throws, naming the seed, unless its cell now holds the seeded markup.
 * A seed that silently missed would let the test read the live cell.
 */
export function seedCells(root: string, seeds: readonly CellSeed[]): void {
  for (const seed of seeds) {
    const file = join(root, seedPath(seed));
    const html = readFileSync(file, "utf-8");
    const next =
      seed.page === "home"
        ? withHomeCell(html, seed.competitor, seed.row, seed.cell)
        : withMigrationCell(html, seed.competitor, seed.row, seed.cell);
    writeFileSync(file, next);
    const got = readSeedCell(readFileSync(file, "utf-8"), seed);
    if (got !== seed.cell) {
      throw new Error(
        `seed did not take effect: ${seed.page} ${seed.competitor} / ${seed.row}: ` +
          `expected ${seed.cell}, found ${got ?? "no cell"}`,
      );
    }
  }
}
