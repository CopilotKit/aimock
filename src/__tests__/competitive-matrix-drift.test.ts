import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMPETITOR_MIGRATION_PAGES,
  FEATURE_RULES,
  isRowlessRule,
  runMatrixUpdate,
} from "../../scripts/update-competitive-matrix.js";

// Drift scenarios driven through the REAL runMatrixUpdate. Each case starts
// from the real docs/index.html (read at test time), applies one homepage
// drift, feeds stubbed scan results, and checks that the detection is not
// lost: the run either throws and names the drifted entity, or reports the
// detection in its own summary section. A guard that is deleted from
// runMatrixUpdate while its helper stays tested makes a case here fail.

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HOMEPAGE_REL = "docs/index.html";
const SUMMARY = "summary.md";
const MIGRATION_PAGES = Object.values(COMPETITOR_MIGRATION_PAGES);

const VIDAIMOCK_LINK = '<a href="https://github.com/vidaiUK/VidaiMock">VidaiMock</a>';
const EMBEDDINGS_LABEL = '<th scope="row">Embeddings API</th>';
// A real cross-mark cell for VidaiMock: its detection is a placeable change.
const VIDAIMOCK_NO_RULE = "OpenRouter router / fallback simulation";

/** Replaces exactly one occurrence of `from`; fails the test if there is not exactly one. */
function replaceOnce(html: string, from: string, to: string): string {
  expect(html.split(from), `drift anchor: ${from}`).toHaveLength(2);
  return html.replace(from, () => to);
}

type Outcome =
  /** runMatrixUpdate throws, its message names `entity`, and no docs file changes. */
  | { kind: "throw"; entity: string }
  /** runMatrixUpdate returns, and the summary section under `heading` names the detection. */
  | { kind: "report"; heading: string; row: string };

interface DriftCase {
  name: string;
  /** One homepage drift; the identity function for a detection-shape case. */
  drift: (html: string) => string;
  /** Stubbed scan results: competitor -> FEATURE_RULES label -> detected. */
  features: [string, Record<string, boolean>][];
  outcome: Outcome;
}

const ROWLESS_HEADING = "## Row-Less Detections (Manual Follow-Up)";

const CASES: DriftCase[] = [
  {
    name: "rule row renamed",
    drift: (html) =>
      replaceOnce(html, EMBEDDINGS_LABEL, '<th scope="row">Embeddings API (renamed)</th>'),
    features: [["VidaiMock", { "Embeddings API": true }]],
    outcome: { kind: "throw", entity: "Embeddings API" },
  },
  {
    name: "rule row label wrapped in markup",
    drift: (html) =>
      replaceOnce(html, EMBEDDINGS_LABEL, '<th scope="row"><b>Embeddings API</b></th>'),
    features: [["VidaiMock", { "Embeddings API": true }]],
    outcome: { kind: "throw", entity: "Embeddings API" },
  },
  {
    name: "competitor header renamed",
    drift: (html) =>
      replaceOnce(
        html,
        VIDAIMOCK_LINK,
        '<a href="https://github.com/vidaiUK/VidaiMock">Vidai Mock</a>',
      ),
    features: [["VidaiMock", { [VIDAIMOCK_NO_RULE]: true }]],
    outcome: { kind: "throw", entity: "VidaiMock" },
  },
  {
    name: "competitor header unlinked",
    drift: (html) => replaceOnce(html, VIDAIMOCK_LINK, "VidaiMock"),
    features: [["VidaiMock", { [VIDAIMOCK_NO_RULE]: true }]],
    outcome: { kind: "throw", entity: "VidaiMock" },
  },
  {
    name: "competitor header link text wrapped in markup",
    drift: (html) =>
      replaceOnce(
        html,
        VIDAIMOCK_LINK,
        '<a href="https://github.com/vidaiUK/VidaiMock"><code>VidaiMock</code></a>',
      ),
    features: [["VidaiMock", { [VIDAIMOCK_NO_RULE]: true }]],
    outcome: { kind: "throw", entity: "VidaiMock" },
  },
  {
    // VidaiMock's migration page has no AWS Bedrock row, so no page changes
    // whatever the live cells show.
    name: "row-less-only detection",
    drift: (html) => html,
    features: [["VidaiMock", { "AWS Bedrock": true }]],
    outcome: {
      kind: "report",
      heading: ROWLESS_HEADING,
      row: "| VidaiMock | AWS Bedrock | no row |",
    },
  },
  {
    name: "row-less-only detection for a competitor with no migration-page row",
    drift: (html) => html,
    features: [["VidaiMock", { "Realtime GA protocol": true }]],
    outcome: {
      kind: "report",
      heading: ROWLESS_HEADING,
      row: "| VidaiMock | Realtime GA protocol |",
    },
  },
];

describe("homepage drift through the real runMatrixUpdate", () => {
  let root: string;
  let homepage: string;

  /** Copies the real homepage and every mapped migration page into a temp repo root. */
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cm-drift-"));
    for (const rel of [HOMEPAGE_REL, ...MIGRATION_PAGES]) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), readFileSync(resolve(REPO_ROOT, rel), "utf-8"), "utf-8");
    }
    homepage = readFileSync(join(root, HOMEPAGE_REL), "utf-8");
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  const read = (rel: string) => readFileSync(join(root, rel), "utf-8");
  const readDocs = () => new Map([HOMEPAGE_REL, ...MIGRATION_PAGES].map((rel) => [rel, read(rel)]));

  /** The body of the summary section under `heading`, up to the next "## " heading. */
  function summarySection(md: string, heading: string): string | undefined {
    const at = md.indexOf(`${heading}\n`);
    if (at < 0) return undefined;
    const rest = md.slice(at + heading.length + 1);
    const next = rest.search(/^## /m);
    return next < 0 ? rest : rest.slice(0, next);
  }

  it("every case's detections name real rules", () => {
    const labels = new Set<string>(FEATURE_RULES.map((r) => r.rowLabel));
    for (const c of CASES) {
      for (const [, features] of c.features) {
        for (const label of Object.keys(features)) expect(labels.has(label), label).toBe(true);
      }
    }
    expect(isRowlessRule("AWS Bedrock")).toBe(true);
    expect(isRowlessRule("Realtime GA protocol")).toBe(true);
  });

  it.each(CASES)("$name", ({ drift, features, outcome }) => {
    writeFileSync(join(root, HOMEPAGE_REL), drift(homepage), "utf-8");
    const before = readDocs();

    let thrown: unknown;
    try {
      runMatrixUpdate({
        repoRoot: root,
        competitorFeatures: new Map(features),
        competitorProviderCounts: new Map(),
        dryRun: false,
        summaryPath: join(root, SUMMARY),
      });
    } catch (err) {
      thrown = err;
    }

    // No drift may change a docs file: a throw writes nothing, and a report
    // case has nothing it can place.
    expect(readDocs()).toEqual(before);

    if (outcome.kind === "throw") {
      expect(thrown, "runMatrixUpdate must throw on this drift").toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain(outcome.entity);
      expect(existsSync(join(root, SUMMARY))).toBe(false);
    } else {
      expect(thrown).toBeUndefined();
      expect(summarySection(read(SUMMARY), outcome.heading)).toContain(outcome.row);
    }
  });
});

// Row-less membership must check MATRIX_ROWLESS_RULES's own keys only. An `in`
// check also matches names inherited from Object.prototype, so a detection
// keyed "constructor" or "toString" would be listed as a row-less rule.
describe("row-less membership ignores Object.prototype names", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cm-rowless-proto-"));
    for (const rel of [HOMEPAGE_REL, ...MIGRATION_PAGES]) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), readFileSync(resolve(REPO_ROOT, rel), "utf-8"), "utf-8");
    }
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it("does not list a prototype-named detection as row-less", () => {
    runMatrixUpdate({
      repoRoot: root,
      competitorFeatures: new Map([
        ["mock-llm", { "AWS Bedrock": true, constructor: true, toString: true }],
      ]),
      competitorProviderCounts: new Map(),
      dryRun: false,
      summaryPath: join(root, SUMMARY),
    });

    const summary = readFileSync(join(root, SUMMARY), "utf-8");
    expect(summary).toContain("| mock-llm | AWS Bedrock |");
    expect(summary).not.toContain("| mock-llm | constructor |");
    expect(summary).not.toContain("| mock-llm | toString |");
  });
});
