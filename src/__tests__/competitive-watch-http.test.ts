import { describe, it, expect, afterEach } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  FEATURE_WATCH,
  MOCKSERVER_LR_URL,
  extractSection,
  formatWatchSection,
  watchNeedsReview,
} from "../../scripts/competitive-watch.js";
import {
  COMPETITOR_MIGRATION_PAGES,
  parseCurrentMatrix,
  runMatrixUpdate,
} from "../../scripts/update-competitive-matrix.js";
import {
  cannedWatchHtml,
  fixtureHtml,
  runWatchAgainstFixture,
  startWatchFixtureServer,
  type WatchFixtureServer,
} from "./competitive-watch-fixture.js";

// Real-runner tests: the real runFeatureWatch, the real HTTP fetcher and the
// real section checker, against a local node:http server. No network.

const ID = "mockserver-lr-sessions";
const CHAOS_ID = "mockserver-lr-chaos";

const lr = (session: string, chaos = "<p>malformedSse Inject a broken-JSON SSE chunk</p>") =>
  fixtureHtml([
    { heading: "Session Isolation", body: session },
    { heading: "Chaos / Fault Injection", body: chaos },
  ]);

const SESSION = "<p>Use isolateBy to keep each test's expectations apart.</p>";
const pages = { [MOCKSERVER_LR_URL]: "/lr" };

describe("feature watch over real HTTP", () => {
  let server: WatchFixtureServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("H1. first run is baseline with one request", async () => {
    server = await startWatchFixtureServer({ "/lr": lr(SESSION) });
    const run1 = await runWatchAgainstFixture({ server, pages });
    expect(run1.reports.find((r) => r.id === ID)?.status).toBe("baseline");
    expect(server.hits("/lr")).toBe(1);
  });

  it("H2. second run on the same page is no change, one request per run", async () => {
    server = await startWatchFixtureServer({ "/lr": lr(SESSION) });
    const run1 = await runWatchAgainstFixture({ server, pages });
    const run2 = await runWatchAgainstFixture({ server, pages, previous: run1.state });
    expect(run2.reports.find((r) => r.id === ID)?.status).toBe("no change");
    expect(run2.stateChanged).toBe(false);
    expect(server.hits("/lr")).toBe(2);
  });

  it("H3. a markup-only edit inside the section is no change", async () => {
    server = await startWatchFixtureServer({ "/lr": lr(SESSION) });
    const run1 = await runWatchAgainstFixture({ server, pages });
    server.set(
      "/lr",
      lr(
        '<p class="lead">Use   <b>isolateBy</b>\n to keep <!-- note --> each <span class="x">test\'s</span> expectations apart.</p>',
      ),
    );
    const run2 = await runWatchAgainstFixture({ server, pages, previous: run1.state });
    expect(run2.reports.find((r) => r.id === ID)?.status).toBe("no change");
  });

  it("H4. a text edit in another section is no change", async () => {
    server = await startWatchFixtureServer({ "/lr": lr(SESSION) });
    const run1 = await runWatchAgainstFixture({ server, pages });
    server.set("/lr", lr(SESSION, "<p>truncateAtFraction cuts the stream short</p>"));
    const run2 = await runWatchAgainstFixture({ server, pages, previous: run1.state });
    expect(run2.reports.find((r) => r.id === ID)?.status).toBe("no change");
  });

  it("H5. a text edit that flips a check is changed, with evidence and the fetched URL", async () => {
    server = await startWatchFixtureServer({ "/lr": lr(SESSION) });
    const run1 = await runWatchAgainstFixture({ server, pages });
    server.set("/lr", lr(`${SESSION}<p>An MCP tool mock can now be scoped to one session.</p>`));
    const run2 = await runWatchAgainstFixture({ server, pages, previous: run1.state });
    const r = run2.reports.find((x) => x.id === ID);
    expect(r?.status).toBe("changed");
    expect(
      r?.details.some((d) =>
        /^check "mcp-tools-per-session" \(.*\) false -> true: ".*session/.test(d),
      ),
    ).toBe(true);
    expect(r?.evidence["mcp-tools-per-session"]).toContain("MCP tool mock can now be scoped");
    expect(r?.claims).toEqual(["C-S4", "C-S13"]);
    expect(r?.url).toBe(server.url("/lr"));
    expect(formatWatchSection(run2)).toContain(`[${ID}](${server.url("/lr")})`);
    expect(run1.state[ID].url).toBe(MOCKSERVER_LR_URL);
    expect(run2.state[ID].url).toBe(MOCKSERVER_LR_URL);
  });

  it("H6. HTTP 503 fails the run through the D8 path", async () => {
    server = await startWatchFixtureServer({ "/lr": { status: 503 } });
    await expect(runWatchAgainstFixture({ server, pages })).rejects.toThrow(
      `Feature watch incomplete: 2 of 2 source(s) could not be checked:\n  - ${ID} (${server.url("/lr")}): HTTP 503\n  - ${CHAOS_ID} (${server.url("/lr")}): HTTP 503`,
    );
    expect(server.hits("/lr")).toBe(1);
  });

  it("H7. an unmapped page throws before any request", async () => {
    server = await startWatchFixtureServer({ "/lr": lr(SESSION) });
    const wiremock = FEATURE_WATCH.filter((s) => s.id === "wiremock-rp-recording");
    await expect(runWatchAgainstFixture({ server, pages, sources: wiremock })).rejects.toThrow(
      "Fixture pages not mapped for: wiremock-rp-recording",
    );
    expect(server.hits()).toBe(0);
  });

  it("H8. cannedWatchHtml satisfies every FEATURE_WATCH html selector", () => {
    const html = cannedWatchHtml();
    for (const s of FEATURE_WATCH) {
      if (s.target.kind !== "html") continue;
      const section = s.target.section;
      expect(() => extractSection(html, section), s.id).not.toThrow();
    }
  });

  it("C-S40 reports tool-argument evidence through the real dry-run without promoting Partial", async () => {
    server = await startWatchFixtureServer({ "/lr": lr(SESSION) });
    const baseline = await runWatchAgainstFixture({ server, pages });
    expect(baseline.reports.find((r) => r.id === CHAOS_ID)?.status).toBe("baseline");
    expect(baseline.state[CHAOS_ID].checks["tool-argument-fault"]).toBe(false);
    expect(server.hits("/lr")).toBe(1);
    server.set(
      "/lr",
      lr(SESSION, "<p>toolCallArgumentFault Send tool-call arguments that are invalid JSON</p>"),
    );
    const changed = await runWatchAgainstFixture({ server, pages, previous: baseline.state });
    const report = changed.reports.find((r) => r.id === CHAOS_ID);
    expect(report?.status).toBe("changed");
    expect(report?.claims).toEqual(["C-S40"]);
    expect(report?.evidence["tool-argument-fault"]).toContain("toolCallArgumentFault");
    expect(report?.details.some((d) => d.includes("false -> true"))).toBe(true);
    expect(report?.url).toBe(server.url("/lr"));
    expect(changed.state[CHAOS_ID].url).toBe(MOCKSERVER_LR_URL);
    expect(changed.reports.find((r) => r.id === ID)?.status).toBe("no change");
    expect(watchNeedsReview(changed)).toBe(true);
    expect(server.hits("/lr")).toBe(2);

    const root = mkdtempSync(join(tmpdir(), "c-s40-watch-"));
    try {
      const paths = [
        "docs/index.html",
        ...Object.values(COMPETITOR_MIGRATION_PAGES),
        "scripts/competitive-watch-state.json",
      ];
      for (const path of paths) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        copyFileSync(resolve(__dirname, "../..", path), join(root, path));
      }
      const before = paths.map((path) => readFileSync(join(root, path), "utf8"));
      const row = "Model misbehavior faults (tool-call JSON, schema, unknown tool, stop reasons)";
      expect(parseCurrentMatrix(before[0]).rows.get(row)?.get("MockServer")).toContain(
        '<span class="partial">Partial</span>',
      );
      const summaryPath = join(root, "summary.md");
      runMatrixUpdate({
        repoRoot: root,
        competitorFeatures: new Map(),
        competitorProviderCounts: new Map(),
        dryRun: true,
        summaryPath,
        watch: {
          result: changed,
          statePath: join(root, "scripts/competitive-watch-state.json"),
          stateRelPath: "scripts/competitive-watch-state.json",
        },
      });
      expect(paths.map((path) => readFileSync(join(root, path), "utf8"))).toEqual(before);
      const summary = readFileSync(summaryPath, "utf8");
      expect(summary).toContain("Feature watch changes need a review.");
      expect(summary).toContain("C-S40");
      expect(summary).toContain(`[${CHAOS_ID}](${server.url("/lr")})`);
      expect(summary).toContain(report?.evidence["tool-argument-fault"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("C-S40 ignores markup-only edits and does not infer tool faults from bare chaos", async () => {
    server = await startWatchFixtureServer({
      "/lr": lr(SESSION, "<p>Chaos testing delays streams</p>"),
    });
    const baseline = await runWatchAgainstFixture({ server, pages });
    const unchanged = await runWatchAgainstFixture({ server, pages, previous: baseline.state });
    expect(unchanged.reports.find((r) => r.id === CHAOS_ID)?.status).toBe("no change");
    server.set("/lr", lr(SESSION, "<p><b>Chaos</b> testing   delays streams</p>"));
    const markup = await runWatchAgainstFixture({ server, pages, previous: unchanged.state });
    expect(markup.reports.find((r) => r.id === CHAOS_ID)?.status).toBe("no change");
    expect(markup.state[CHAOS_ID].checks["tool-argument-fault"]).toBe(false);
    expect(watchNeedsReview(markup)).toBe(false);
    expect(server.hits("/lr")).toBe(3);
  });
});
