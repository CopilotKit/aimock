import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The script imports writeFileSync from node:fs. Wrap it so a test can make
// one target path fail while every other write goes through to disk. Every
// write that goes through is recorded in order, so a test can check the order.
const failOn = vi.hoisted(() => ({ suffix: null as string | null, writes: [] as string[] }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const writeFileSync: typeof actual.writeFileSync = (file, data, options) => {
    if (failOn.suffix && typeof file === "string" && file.endsWith(failOn.suffix)) {
      const err = new Error(`EACCES: permission denied, open '${file}'`) as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    }
    if (typeof file === "string") failOn.writes.push(file);
    return actual.writeFileSync(file, data, options);
  };
  return { ...actual, writeFileSync };
});

import {
  COMPETITOR_MIGRATION_PAGES,
  runMatrixUpdate,
  type WatchWrite,
} from "../../scripts/update-competitive-matrix.js";
import {
  WATCH_STATE_REL_PATH,
  serializeWatchState,
  type FeatureWatchResult,
} from "../../scripts/competitive-watch.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HOMEPAGE_REL = "docs/index.html";
const MOCK_LLM_PAGE = COMPETITOR_MIGRATION_PAGES["mock-llm"];
const MIGRATION_PAGES = Object.values(COMPETITOR_MIGRATION_PAGES);

// The real homepage's no-cell markup, and the real migration pages' cross cell.
const REAL_NO_CELL = '<td><span class="no" role="img" aria-label="No">&#10007;</span></td>';
const MIGRATION_CROSS = '<td style="color: var(--error)">&#10007;</td>';

/**
 * `html` with mock-llm's "Claude Messages API" cell set to a no-cell. The
 * column index is read from the header. The scan bot flips the live cells over
 * time, so the test sets the state it needs in its copy.
 */
function withMockLlmClaudeNo(html: string): string {
  const thead = html.match(
    /<table class="comparison-table">[\s\S]*?<thead>([\s\S]*?)<\/thead>/,
  )![1];
  const headers = [...thead.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map((m) => m[1]);
  const col = headers.findIndex((h) => /<a\b[^>]*>\s*mock-llm\s*<\/a>/.test(h));
  expect(col).toBeGreaterThan(0);
  const tr = html.match(
    /<tr\b[^>]*>\s*<th scope="row">Claude Messages API<\/th>[\s\S]*?<\/tr>/,
  )![0];
  let idx = 0;
  const newTr = tr.replace(/<(th|td)\b[^>]*>[\s\S]*?<\/\1>/g, (c) =>
    idx++ === col ? REAL_NO_CELL : c,
  );
  expect(idx).toBeGreaterThan(col);
  return html.replace(tr, () => newTr);
}

/** `html` (the mock-llm migration page) with its Anthropic Claude cell set to a cross. */
function withAnthropicClaudeCross(html: string): string {
  const re = /(<td>Anthropic Claude<\/td>\s*)<td[^>]*>[\s\S]*?<\/td>/;
  expect(html).toMatch(re);
  return html.replace(re, (_m, pre: string) => pre + MIGRATION_CROSS);
}

// With mock-llm's homepage "Claude Messages API" cell set to no and its
// migration page's Anthropic Claude cell set to a cross (in the copies), this
// one detection changes both the homepage and one migration page.
const FEATURES = new Map<string, Record<string, boolean>>([
  ["mock-llm", { "Claude Messages API": true }],
]);

describe("competitive-matrix run when a docs write fails partway", () => {
  let root: string;
  let summaryPath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(join(tmpdir(), "cm-write-fail-"));
    for (const rel of [HOMEPAGE_REL, ...MIGRATION_PAGES]) {
      fs.mkdirSync(dirname(join(root, rel)), { recursive: true });
      fs.copyFileSync(resolve(REPO_ROOT, rel), join(root, rel));
    }
    fs.writeFileSync(join(root, HOMEPAGE_REL), withMockLlmClaudeNo(read(HOMEPAGE_REL)));
    fs.writeFileSync(join(root, MOCK_LLM_PAGE), withAnthropicClaudeCross(read(MOCK_LLM_PAGE)));
    summaryPath = join(root, "summary.md");
    vi.spyOn(console, "log").mockImplementation(() => {});
    failOn.writes = [];
  });

  afterEach(() => {
    failOn.suffix = null;
    failOn.writes = [];
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const read = (rel: string) => fs.readFileSync(join(root, rel), "utf-8");
  const run = (
    watch?: WatchWrite,
    opts: { features?: Map<string, Record<string, boolean>>; dryRun?: boolean } = {},
  ) =>
    runMatrixUpdate({
      repoRoot: root,
      competitorFeatures: opts.features ?? FEATURES,
      competitorProviderCounts: new Map(),
      dryRun: opts.dryRun ?? false,
      summaryPath,
      watch,
    });

  it("the fixture changes the homepage and the mock-llm migration page", () => {
    const homepageBefore = read(HOMEPAGE_REL);
    const pageBefore = read(MOCK_LLM_PAGE);
    run();
    expect(read(HOMEPAGE_REL)).not.toBe(homepageBefore);
    expect(read(MOCK_LLM_PAGE)).not.toBe(pageBefore);
    const summary = read("summary.md");
    expect(summary).toContain("| mock-llm | Claude Messages API | No -> Yes |");
    expect(summary).toContain(`\`${MOCK_LLM_PAGE}\`: mock-llm: Anthropic Claude`);
  });

  it("names the files already written and writes no summary when a migration page write fails", () => {
    const pageBefore = read(MOCK_LLM_PAGE);
    failOn.suffix = MOCK_LLM_PAGE;

    expect(run).toThrow(
      new RegExp(
        `Failed to write ${MOCK_LLM_PAGE}[\\s\\S]*Files already written: ${HOMEPAGE_REL}\\.`,
      ),
    );

    expect(read(MOCK_LLM_PAGE)).toBe(pageBefore);
    // No summary may claim the migration change that never reached the page.
    expect(fs.existsSync(summaryPath)).toBe(false);
  });

  it("names every docs file already written when the summary write fails", () => {
    failOn.suffix = "summary.md";

    expect(run).toThrow(
      new RegExp(
        `Failed to write ${summaryPath}[\\s\\S]*` +
          `Files already written: ${HOMEPAGE_REL}, ${MOCK_LLM_PAGE}\\.`,
      ),
    );
    expect(fs.existsSync(summaryPath)).toBe(false);
  });

  it("reports no files written and writes no summary when the homepage write fails", () => {
    const homepageBefore = read(HOMEPAGE_REL);
    const pageBefore = read(MOCK_LLM_PAGE);
    failOn.suffix = HOMEPAGE_REL;

    expect(run).toThrow(
      new RegExp(`Failed to write ${HOMEPAGE_REL}[\\s\\S]*Files already written: none\\.`),
    );

    expect(read(HOMEPAGE_REL)).toBe(homepageBefore);
    expect(read(MOCK_LLM_PAGE)).toBe(pageBefore);
    expect(fs.existsSync(summaryPath)).toBe(false);
  });

  // ── Feature watch state (spec D10) ────────────────────────────────────

  const WATCH_RESULT: FeatureWatchResult = {
    reports: [
      {
        id: "mockserver-lr-sessions",
        competitor: "MockServer",
        claims: ["C-S4", "C-S13"],
        url: "https://www.mock-server.com/mock_server/llm_response_mocking.html",
        status: "baseline",
        details: [],
        evidence: {},
      },
    ],
    state: {
      "mockserver-lr-sessions": {
        url: "https://www.mock-server.com/mock_server/llm_response_mocking.html",
        hash: "sha256:" + "0".repeat(64),
        checks: { "per-session-sequence": false },
        lastChanged: "2026-01-01",
      },
    },
    stateChanged: true,
  };
  const statePath = () => join(root, WATCH_STATE_REL_PATH);
  const watchWrite = (result: FeatureWatchResult = WATCH_RESULT): WatchWrite => {
    fs.mkdirSync(dirname(statePath()), { recursive: true });
    return { result, statePath: statePath(), stateRelPath: WATCH_STATE_REL_PATH };
  };

  it("writes the watch state after the migration pages and before the summary", () => {
    run(watchWrite());
    expect(read(WATCH_STATE_REL_PATH)).toBe(serializeWatchState(WATCH_RESULT.state));
    expect(failOn.writes).toEqual([
      join(root, HOMEPAGE_REL),
      join(root, MOCK_LLM_PAGE),
      statePath(),
      summaryPath,
    ]);
    expect(read("summary.md")).toContain("## Feature watch");
  });

  it("names the watch state in the files already written when the summary write fails", () => {
    failOn.suffix = "summary.md";
    expect(() => run(watchWrite())).toThrow(
      new RegExp(
        `Failed to write ${summaryPath}[\\s\\S]*` +
          `Files already written: ${HOMEPAGE_REL}, ${MOCK_LLM_PAGE}, ${WATCH_STATE_REL_PATH}\\.`,
      ),
    );
    expect(fs.existsSync(summaryPath)).toBe(false);
  });

  it("names the docs already written and writes no summary when the state write fails", () => {
    failOn.suffix = "competitive-watch-state.json";
    expect(() => run(watchWrite())).toThrow(
      new RegExp(
        `Failed to write ${WATCH_STATE_REL_PATH}[\\s\\S]*` +
          `Files already written: ${HOMEPAGE_REL}, ${MOCK_LLM_PAGE}\\.`,
      ),
    );
    expect(fs.existsSync(statePath())).toBe(false);
    expect(fs.existsSync(summaryPath)).toBe(false);
  });

  it("does not write the state file when the state did not change", () => {
    run(watchWrite({ ...WATCH_RESULT, stateChanged: false }));
    expect(fs.existsSync(statePath())).toBe(false);
    expect(failOn.writes).not.toContain(statePath());
    expect(read("summary.md")).toContain("## Feature watch");
  });

  it("never changes a docs page from a watch report alone", () => {
    const docsBefore = new Map(
      [HOMEPAGE_REL, ...MIGRATION_PAGES].map((rel) => [rel, read(rel)] as const),
    );
    const changed: FeatureWatchResult = {
      ...WATCH_RESULT,
      reports: [
        {
          id: "mockserver-lr-chaos",
          competitor: "MockServer",
          claims: ["C-S40"],
          url: "https://www.mock-server.com/mock_server/llm_response_mocking.html",
          status: "changed",
          details: ['check "tool-argument-fault" false -> true'],
          evidence: { "tool-argument-fault": "toolCallArgumentFault" },
        },
      ],
    };
    run(watchWrite(changed), { features: new Map() });
    for (const [rel, before] of docsBefore) expect(read(rel)).toBe(before);
    expect(failOn.writes).toEqual([statePath(), summaryPath]);
    expect(read("summary.md")).toContain("| changed |");
  });

  it("writes no state on a dry run but still reports the watch", () => {
    run(watchWrite(), { dryRun: true });
    expect(fs.existsSync(statePath())).toBe(false);
    expect(failOn.writes).toEqual([summaryPath]);
    expect(read("summary.md")).toContain("## Feature watch");
  });
});
