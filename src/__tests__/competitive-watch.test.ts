import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import prettier from "prettier";
import {
  FEATURE_WATCH,
  assertValidWatchConfig,
  checkArgs,
  extractSection,
  flagValues,
  formatWatchSection,
  observeSource,
  parseUrlOverrides,
  readWatchState,
  runFeatureWatch,
  serializeWatchState,
  WATCH_STATE_REL_PATH,
  watchNeedsReview,
  watchUrl,
  type FeatureWatchResult,
  type WatchFetch,
  type WatchSource,
  type WatchState,
} from "../../scripts/competitive-watch.js";

// Extra tests for scripts/competitive-watch.ts with an injected fetcher. The
// real-HTTP tests are in competitive-watch-http.test.ts.

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const PAGE_A = "https://example.com/a";
const PAGE_B = "https://example.com/b";

const htmlA: WatchSource = {
  id: "source-a",
  competitor: "Alpha",
  claims: ["C-A1"],
  target: { kind: "html", url: PAGE_A, section: { kind: "heading", text: "Tools" } },
  checks: [{ id: "mcp", question: "Is MCP named?", pattern: "\\bmcp\\b" }],
};
const htmlA2: WatchSource = {
  id: "source-a-two",
  competitor: "Alpha",
  claims: ["C-A2"],
  target: { kind: "html", url: PAGE_A, section: { kind: "heading", text: "Other" } },
  checks: [],
};
const htmlB: WatchSource = {
  id: "source-b",
  competitor: "Beta",
  claims: ["C-B1"],
  target: { kind: "html", url: PAGE_B, section: { kind: "element", tag: "article" } },
  checks: [{ id: "replay", question: "Is replay named?", pattern: "replay" }],
};
const npmC: WatchSource = {
  id: "source-npm",
  competitor: "Gamma",
  claims: ["C-G1"],
  target: { kind: "npm", package: "@scope/pkg" },
  checks: [],
};
const NPM_URL = "https://registry.npmjs.org/@scope%2Fpkg/latest";

const pageA = (tools: string) => `<h2>Tools</h2><p>${tools}</p><h2>Other</h2><p>other words</p>`;
const pageB = (text: string) => `<html><body><article><p>${text}</p></article></body></html>`;
const npmBody = (v: string) => JSON.stringify({ name: "@scope/pkg", version: v });

/** A fetcher over a URL -> body table that counts calls per URL. */
function tableFetch(table: Record<string, string | { ok: false; reason: string }>): {
  fetchText: WatchFetch;
  calls: Map<string, number>;
} {
  const calls = new Map<string, number>();
  const fetchText: WatchFetch = async (url) => {
    calls.set(url, (calls.get(url) ?? 0) + 1);
    const v = table[url];
    if (v === undefined) return { ok: false, reason: "HTTP 404" };
    if (typeof v === "string") return { ok: true, text: v };
    return v;
  };
  return { fetchText, calls };
}

const SOURCES = [htmlA, htmlA2, htmlB, npmC];

async function run(
  table: Record<string, string | { ok: false; reason: string }>,
  previous: WatchState = {},
  today = "2026-01-01",
  sources: readonly WatchSource[] = SOURCES,
): Promise<FeatureWatchResult> {
  const { fetchText } = tableFetch(table);
  return runFeatureWatch({ sources, previous, today, fetchText, log: () => {} });
}

const baseTable = {
  [PAGE_A]: pageA("tool words"),
  [PAGE_B]: pageB("record words"),
  [NPM_URL]: npmBody("1.75.0"),
};

describe("FEATURE_WATCH config", () => {
  it("1. FEATURE_WATCH is valid", () => {
    expect(() => assertValidWatchConfig(FEATURE_WATCH)).not.toThrow();
    const ids = FEATURE_WATCH.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of FEATURE_WATCH) {
      expect(s.claims.length).toBeGreaterThan(0);
      for (const c of s.claims) expect(c).toMatch(/^C-[A-Z]+\d+$/);
    }
  });

  it("2. assertValidWatchConfig lists every problem", () => {
    const bad: WatchSource[] = [
      htmlA,
      { ...htmlA, claims: ["C-A1"] },
      { ...htmlB, id: "Not_Kebab" },
      { ...htmlB, id: "no-claims", claims: [] },
      { ...htmlB, id: "bad-claim", claims: ["CS4"] },
      {
        ...htmlB,
        id: "bad-pattern",
        checks: [{ id: "broken", question: "?", pattern: "(unclosed" }],
      },
      { ...npmC, id: "npm-checks", checks: [{ id: "x", question: "?", pattern: "x" }] },
    ];
    let message = "";
    try {
      assertValidWatchConfig(bad);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("FEATURE_WATCH is invalid:");
    expect(message).toContain("source-a: duplicate id");
    expect(message).toContain("Not_Kebab: id must be kebab-case");
    expect(message).toContain("no-claims: no claims");
    expect(message).toContain('bad-claim: bad claim id "CS4"');
    expect(message).toContain("bad-pattern/broken: pattern does not compile");
    expect(message).toContain("npm-checks: npm sources take no checks");
  });
});

describe("extractSection", () => {
  it("3. heading section runs to the next heading of the same level", () => {
    const html = "<h2>A</h2><p>x</p><h3>A.1</h3><p>y</p><h2>B</h2><p>z</p>";
    expect(extractSection(html, { kind: "heading", text: "A" })).toBe("x A.1 y");
  });

  it("4. heading ignores a commented-out heading", () => {
    const html = "<!-- <h1>A</h1> --><h1>A</h1><p>x</p>";
    expect(extractSection(html, { kind: "heading", text: "A" })).toBe("x");
  });

  it("5. heading text decodes entities and drops zero-width characters", () => {
    const html = "<h2>AI &amp; MCP​</h2><p>x</p>";
    expect(extractSection(html, { kind: "heading", text: "AI & MCP" })).toBe("x");
  });

  it("5b. section text drops C0/C1 control characters and keeps whitespace collapsing", () => {
    // `&#1;`/`&#2;` decode to U+0001/U+0002; U+0085 and U+009B are raw C1.
    const html = "<h2>T&#1;ools</h2><p>a&#1;b&#2;c\u0085d\u009Be&#127;f\tg\nh\r\ni</p>";
    const text = extractSection(html, { kind: "heading", text: "Tools" });
    expect(text).toBe("abcdef g h i");
    expect(text).not.toMatch(/\p{Cc}/u);
  });

  it("6. heading-id handles Docusaurus hash-link markup", () => {
    const html =
      "<h2 id=tool-mocks>Tool mocks<a class=hash-link><div class=sr-only>Direct link to Tool mocks</div></a></h2>" +
      "<p>x</p><h2 id=next>N</h2>";
    expect(extractSection(html, { kind: "heading-id", id: "tool-mocks" })).toBe("x");
  });

  it("7. element takes the first <article>", () => {
    const html = "<nav>menu</nav><article><h1>T</h1><p>body</p></article><article>second</article>";
    expect(extractSection(html, { kind: "element", tag: "article" })).toBe("T body");
  });

  it("6b. heading-id reads only the real id attribute", () => {
    const tail = "<h2 id=next>N</h2>";
    expect(
      extractSection(`<h2 data-id="x" id="tool-mocks">T</h2><p>right</p>${tail}`, {
        kind: "heading-id",
        id: "tool-mocks",
      }),
    ).toBe("right");
    for (const h2 of [
      '<h2 data-id="tool-mocks">',
      '<h2 aria-labelledby-id="tool-mocks">',
      '<h2 title="a id=tool-mocks">',
    ]) {
      expect(() =>
        extractSection(`${h2}T</h2><p>wrong</p>${tail}`, { kind: "heading-id", id: "tool-mocks" }),
      ).toThrow('heading id "tool-mocks" not found');
    }
  });

  it("6c. a custom element named like a heading is not a heading", () => {
    const html = "<h2-x>Fake</h2-x><h2>A</h2><p>x</p><h2>B</h2>";
    expect(extractSection(html, { kind: "heading", text: "A" })).toBe("x");
  });

  it("7b. element skips custom elements that start with the tag name", () => {
    expect(
      extractSection("<main-nav>menu</main-nav><main>body</main>", {
        kind: "element",
        tag: "main",
      }),
    ).toBe("body");
    expect(
      extractSection("<article-card>card</article-card><article>real</article>", {
        kind: "element",
        tag: "article",
      }),
    ).toBe("real");
  });

  it("7c. element runs to its matching close tag, past nested elements of the same tag", () => {
    const html = "<article>a<article>x</article>LATER</article><p>after</p>";
    expect(extractSection(html, { kind: "element", tag: "article" })).toBe("a x LATER");
  });

  it("7d. an unclosed element runs to the end of the page", () => {
    const html = "<main>a<main>b</main>c";
    expect(extractSection(html, { kind: "element", tag: "main" })).toBe("a b c");
  });

  it("7e. only real script/style elements are stripped", () => {
    const html = "<script-foo>keep</script-foo><main>m</main><script>s</script>";
    expect(extractSection(html, { kind: "element", tag: "main" })).toBe("m");
  });

  it("7f. the last heading section stops before the site footer", () => {
    const html =
      "<article><h2>Last</h2><p>x</p></article>" +
      '<footer class="site-footer"><p>© MockServer 2026</p></footer><footer-x>keep</footer-x>';
    expect(extractSection(html, { kind: "heading", text: "Last" })).toBe("x keep");
  });

  it("7g. a > inside a quoted heading attribute does not hide the heading", () => {
    expect(
      extractSection(`<h2 title="a>b" id="tool-mocks">T</h2><p>x</p><h2 id=next>N</h2>`, {
        kind: "heading-id",
        id: "tool-mocks",
      }),
    ).toBe("x");
  });

  it("7h. a > inside a quoted attribute leaks no attribute text into the section", () => {
    expect(
      extractSection(
        `<h2>Recording</h2><button data-code='a > b' onclick="stop();">Copy</button><p>x</p><h2>Next</h2>`,
        { kind: "heading", text: "Recording" },
      ),
    ).toBe("Copy x");
  });

  it("7i. a > inside a quoted attribute of an element open tag ends nothing", () => {
    expect(
      extractSection(`<article data-x="1>2" title='<article>'>body</article>`, {
        kind: "element",
        tag: "article",
      }),
    ).toBe("body");
  });

  it("8. missing, ambiguous and empty sections throw with the reason", () => {
    expect(() => extractSection("<h2>B</h2><p>x</p>", { kind: "heading", text: "A" })).toThrow(
      'heading "A" not found',
    );
    expect(() =>
      extractSection("<h2>A</h2><p>x</p><h2>A</h2><p>y</p>", { kind: "heading", text: "A" }),
    ).toThrow('heading "A" is ambiguous (2 matches)');
    expect(() =>
      extractSection("<h2>A</h2><p> </p><h2>B</h2>", { kind: "heading", text: "A" }),
    ).toThrow("section is empty");
    expect(() => extractSection("<p>x</p>", { kind: "element", tag: "main" })).toThrow(
      "no <main> element",
    );
  });
});

describe("observeSource", () => {
  it("9. npm reads the version and rejects bad registry answers", () => {
    const obs = observeSource(npmC, NPM_URL, npmBody("1.75.0"));
    expect(obs.version).toBe("1.75.0");
    expect(obs.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(() => observeSource(npmC, NPM_URL, "<html>")).toThrow("registry answer is not JSON");
    expect(() => observeSource(npmC, NPM_URL, "{}")).toThrow("registry answer has no version");
    expect(watchUrl(npmC.target)).toBe(NPM_URL);
  });
});

describe("runFeatureWatch", () => {
  it("10. empty previous state: every source is baseline", async () => {
    const r = await run(baseTable, {}, "2026-02-03");
    expect(r.reports.map((x) => x.status)).toEqual([
      "baseline",
      "baseline",
      "baseline",
      "baseline",
    ]);
    expect(r.stateChanged).toBe(true);
    for (const e of Object.values(r.state)) expect(e.lastChanged).toBe("2026-02-03");
    expect(r.state["source-npm"].version).toBe("1.75.0");
  });

  it("11. second run with the same bodies: no change, identical state", async () => {
    const first = await run(baseTable, {}, "2026-02-03");
    const second = await run(baseTable, first.state, "2026-02-10");
    expect(second.reports.map((x) => x.status)).toEqual([
      "no change",
      "no change",
      "no change",
      "no change",
    ]);
    expect(second.stateChanged).toBe(false);
    expect(serializeWatchState(second.state)).toBe(serializeWatchState(first.state));
    expect(watchNeedsReview(second)).toBe(false);
  });

  it("12. a changed section reports text and check changes; only it gets the new date", async () => {
    const first = await run(baseTable, {}, "2026-02-03");
    const second = await run(
      { ...baseTable, [PAGE_A]: pageA("now with MCP support") },
      first.state,
      "2026-02-10",
    );
    const a = second.reports.find((x) => x.id === "source-a");
    expect(a?.status).toBe("changed");
    expect(a?.details).toContain("section text changed");
    expect(
      a?.details.some((d) => d.startsWith('check "mcp" (Is MCP named?) false -> true: "')),
    ).toBe(true);
    expect(a?.evidence.mcp).toContain("MCP support");
    expect(second.state["source-a"].lastChanged).toBe("2026-02-10");
    expect(second.state["source-a-two"].lastChanged).toBe("2026-02-03");
    expect(second.state["source-b"].lastChanged).toBe("2026-02-03");
    expect(second.stateChanged).toBe(true);
  });

  it("13. npm version change", async () => {
    const first = await run(baseTable, {}, "2026-02-03");
    const second = await run({ ...baseTable, [NPM_URL]: npmBody("1.76.0") }, first.state);
    const n = second.reports.find((x) => x.id === "source-npm");
    expect(n?.status).toBe("changed");
    expect(n?.details).toEqual(["version 1.75.0 -> 1.76.0"]);
  });

  it("14. a state id not in the sources is removed and dropped", async () => {
    const first = await run(baseTable, {}, "2026-02-03");
    const previous: WatchState = {
      ...first.state,
      "old-source": {
        url: "https://example.com/old",
        hash: "sha256:00",
        checks: {},
        lastChanged: "2025-01-01",
      },
    };
    const second = await run(baseTable, previous);
    const last = second.reports.at(-1);
    expect(last?.id).toBe("old-source");
    expect(last?.status).toBe("removed");
    expect(second.state).not.toHaveProperty("old-source");
    expect(second.stateChanged).toBe(true);
  });

  it("15. one fetch per URL", async () => {
    const { fetchText, calls } = tableFetch(baseTable);
    await runFeatureWatch({
      sources: SOURCES,
      previous: {},
      today: "2026-01-01",
      fetchText,
      log: () => {},
    });
    expect(calls.get(PAGE_A)).toBe(1);
    expect(calls.get(PAGE_B)).toBe(1);
    expect(calls.get(NPM_URL)).toBe(1);
  });

  it("16. failures fail the run and name every source", async () => {
    await expect(
      run({ ...baseTable, [PAGE_A]: { ok: false, reason: "HTTP 503" } }),
    ).rejects.toThrow(
      "Feature watch incomplete: 2 of 4 source(s) could not be checked:\n" +
        `  - source-a (${PAGE_A}): HTTP 503\n` +
        `  - source-a-two (${PAGE_A}): HTTP 503`,
    );
    await expect(run({ ...baseTable, [PAGE_B]: "<html><p>no article</p></html>" })).rejects.toThrow(
      `Feature watch incomplete: 1 of 4 source(s) could not be checked:\n  - source-b (${PAGE_B}): no <article> element`,
    );
  });

  it("17. parseUrlOverrides is keyed by source URL", async () => {
    expect(parseUrlOverrides(undefined, SOURCES).size).toBe(0);
    const map = parseUrlOverrides(JSON.stringify({ [PAGE_A]: "http://127.0.0.1:1/a" }), SOURCES);
    expect(map.get(PAGE_A)).toBe("http://127.0.0.1:1/a");
    expect(() =>
      parseUrlOverrides(JSON.stringify({ "https://nope.example/": "http://x/" }), SOURCES),
    ).toThrow("names a URL no source watches: https://nope.example/");
    expect(() => parseUrlOverrides("[]", SOURCES)).toThrow("must be a JSON object");
    expect(() =>
      parseUrlOverrides(JSON.stringify({ [PAGE_A]: "file:///etc/passwd" }), SOURCES),
    ).toThrow("not an http(s) URL");

    const { fetchText, calls } = tableFetch({
      ...baseTable,
      "http://fixture/a": pageA("tool words"),
    });
    const r = await runFeatureWatch({
      sources: SOURCES,
      previous: {},
      today: "2026-01-01",
      fetchText,
      urlOverrides: new Map([[PAGE_A, "http://fixture/a"]]),
      log: () => {},
    });
    expect(calls.get("http://fixture/a")).toBe(1);
    expect(calls.has(PAGE_A)).toBe(false);
    expect(r.reports.find((x) => x.id === "source-a")?.url).toBe("http://fixture/a");
    expect(r.reports.find((x) => x.id === "source-a-two")?.url).toBe("http://fixture/a");
    // The state keeps the source URL, so a later run without the override is no change.
    expect(r.state["source-a"].url).toBe(PAGE_A);
    expect(r.state["source-a-two"].url).toBe(PAGE_A);
    const next = await run(baseTable, r.state);
    expect(next.reports.map((x) => [x.id, x.status, x.details])).toEqual([
      ["source-a", "no change", []],
      ["source-a-two", "no change", []],
      ["source-b", "no change", []],
      ["source-npm", "no change", []],
    ]);
  });

  it("17b. a URL change, an added check and a removed check are each reported", async () => {
    const first = await run(baseTable, {}, "2026-02-03");
    const previous: WatchState = {
      ...first.state,
      "source-a": {
        ...first.state["source-a"],
        url: "https://example.com/old-a",
        checks: { gone: true },
      },
    };
    const second = await run(baseTable, previous, "2026-02-10");
    const a = second.reports.find((x) => x.id === "source-a");
    expect(a?.status).toBe("changed");
    expect(a?.details).toEqual([
      `URL https://example.com/old-a -> ${PAGE_A}`,
      'check "mcp" added: false',
      'check "gone" removed',
    ]);
    expect(second.state["source-a"]).toEqual({
      ...first.state["source-a"],
      lastChanged: "2026-02-10",
    });
    expect(second.reports.filter((x) => x.id !== "source-a").map((x) => x.status)).toEqual([
      "no change",
      "no change",
      "no change",
    ]);
  });
});

describe("state file", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  it("18. serializeWatchState sorts keys and is prettier-stable", async () => {
    const state: WatchState = {
      zeta: {
        url: "https://z",
        hash: "sha256:1",
        checks: { b: true, a: false },
        lastChanged: "2026-01-01",
      },
      alpha: {
        url: "https://a",
        hash: "sha256:2",
        checks: {},
        version: "1.0.0",
        lastChanged: "2026-01-02",
      },
    };
    const s = serializeWatchState(state);
    expect(Object.keys(JSON.parse(s))).toEqual(["alpha", "zeta"]);
    expect(Object.keys(JSON.parse(s).zeta.checks)).toEqual(["a", "b"]);
    expect(Object.keys(JSON.parse(s).alpha)).toEqual([
      "url",
      "hash",
      "checks",
      "version",
      "lastChanged",
    ]);
    expect(await prettier.format(s, { parser: "json" })).toBe(s);
  });

  it("19. readWatchState validates the file", () => {
    dir = mkdtempSync(join(tmpdir(), "watch-state-"));
    const empty = join(dir, "empty.json");
    writeFileSync(empty, "{}\n");
    expect(readWatchState(empty)).toEqual({});
    const missing = join(dir, "missing.json");
    expect(() => readWatchState(missing)).toThrow(`Feature-watch state file not found: ${missing}`);
    const noHash = join(dir, "nohash.json");
    writeFileSync(
      noHash,
      JSON.stringify({ "some-id": { url: "https://x", checks: {}, lastChanged: "2026-01-01" } }),
    );
    expect(() => readWatchState(noHash)).toThrow('"some-id": hash is missing');
  });

  it("19b. readWatchState rejects every malformed shape", () => {
    dir = mkdtempSync(join(tmpdir(), "watch-state-"));
    const good = {
      url: "https://x",
      hash: "sha256:0",
      checks: { a: true },
      lastChanged: "2026-01-01",
    };
    const cases: [string, string][] = [
      ["{", "state file is not JSON"],
      ["[]", "state file must hold an object"],
      ["null", "state file must hold an object"],
      [JSON.stringify({ e: 1 }), '"e": entry is not an object'],
      [JSON.stringify({ e: [good] }), '"e": entry is not an object'],
      [JSON.stringify({ e: { ...good, url: 1 } }), '"e": url is missing'],
      [JSON.stringify({ e: { ...good, hash: undefined } }), '"e": hash is missing'],
      [JSON.stringify({ e: { ...good, lastChanged: 5 } }), '"e": lastChanged is missing'],
      [JSON.stringify({ e: { ...good, version: 2 } }), '"e": version is not a string'],
      [JSON.stringify({ e: { ...good, checks: null } }), '"e": checks is missing'],
      [JSON.stringify({ e: { ...good, checks: [true] } }), '"e": checks is missing'],
      [JSON.stringify({ e: { ...good, checks: { a: "yes" } } }), '"e": check "a" is not a boolean'],
      [`{"__proto__": ${JSON.stringify(good)}}`, '"__proto__": is not a valid id'],
      [
        '{"e": {"url": "https://x", "hash": "sha256:0", "checks": {"__proto__": true}, "lastChanged": "2026-01-01"}}',
        '"e": check "__proto__" is not a valid id',
      ],
    ];
    cases.forEach(([text, message], i) => {
      const file = join(dir, `bad-${i}.json`);
      writeFileSync(file, text);
      expect(() => readWatchState(file), text).toThrow(message);
    });
    const ok = join(dir, "ok.json");
    writeFileSync(ok, JSON.stringify({ e: { ...good, version: "1.0.0" } }));
    expect(readWatchState(ok)).toEqual({ e: { ...good, version: "1.0.0" } });
  });

  it("21. the committed state file is valid, canonical and only names FEATURE_WATCH ids", () => {
    // The seed is {} (D7); the weekly report PR commits a filled one. Both must pass.
    const path = resolve(REPO_ROOT, WATCH_STATE_REL_PATH);
    const state = readWatchState(path);
    expect(readFileSync(path, "utf8")).toBe(serializeWatchState(state));
    const ids = new Set(FEATURE_WATCH.map((s) => s.id));
    expect(Object.keys(state).filter((id) => !ids.has(id))).toEqual([]);
  });
});

describe("report", () => {
  it("20. formatWatchSection and watchNeedsReview", async () => {
    const first = await run({ ...baseTable, [PAGE_A]: pageA("MCP | piped") }, {}, "2026-02-03");
    const text = formatWatchSection(first);
    expect(text.startsWith("## Feature watch")).toBe(true);
    const rows = text.split("\n").filter((l) => l.startsWith("| ["));
    expect(rows).toHaveLength(first.reports.length);
    expect(rows[0]).toContain(`[source-a](${PAGE_A})`);
    expect(rows[0]).toContain("C-A1");
    expect(rows[0]).toContain('mcp: "MCP \\| piped"');
    expect(watchNeedsReview(first)).toBe(true);
  });

  it("23. formatWatchSection escapes a backslash before escaping a pipe", async () => {
    // GFM drops one backslash before a pipe when it splits a row, so "C:\|x"
    // must leave the formatter as "C:\\\|x" to render as "C:\|x".
    const first = await run({ ...baseTable, [PAGE_A]: pageA("MCP C:\\|x") }, {}, "2026-02-03");
    const rows = formatWatchSection(first)
      .split("\n")
      .filter((l) => l.startsWith("| ["));
    expect(rows[0]).toContain('mcp: "MCP C:\\\\\\|x"');
  });

  it("23b. formatWatchSection renders every competitor- or state-derived value literally", () => {
    const hostile =
      "@octocat @mastra/core@1.56.0, PR #1 <img src=x> &amp; `code` *b* _i_ ~s~ [x](https://evil)\r\nnext";
    const result: FeatureWatchResult = {
      reports: [
        {
          id: `id ${hostile}`,
          competitor: `competitor ${hostile}`,
          claims: [`claim ${hostile}`],
          url: PAGE_A,
          status: "changed",
          details: [`detail ${hostile}`],
          evidence: { [`check ${hostile}`]: `evidence ${hostile}` },
        },
      ],
      state: {},
      stateChanged: false,
    };
    const row = formatWatchSection(result)
      .split("\n")
      .filter((l) => l.startsWith("| ["))[0];
    const wj = "\u2060";
    const lit =
      `@${wj}octocat @${wj}mastra/core@${wj}1.56.0, PR #${wj}1 &lt;img src=x&gt; &amp;amp; ` +
      "\\`code\\` \\*b\\* \\_i\\_ \\~s\\~ \\[x\\](https://evil) next";
    expect(row).toBe(
      `| [id ${lit}](${PAGE_A}) | competitor ${lit} | claim ${lit} | changed | detail ${lit} | ` +
        `check ${lit}: "evidence ${lit}" |`,
    );
    // No raw HTML, no bare @ or #, and no unescaped formatting or link
    // character outside the row's own [id](url).
    const values = row.replace("| [", "").replace(`](${PAGE_A})`, "");
    expect(values).not.toMatch(/[<>]|@(?!\u2060)|#(?!\u2060)|(?<!\\)[`*_~[\]]/);
  });

  it("23c. formatWatchSection keeps 6 cells and an intact link for a hostile removed row", async () => {
    const previous: WatchState = {
      "old|id_<b>": {
        url: "https://a.example/p|q (x) <y>`\\",
        hash: "sha256:" + "0".repeat(64),
        checks: {},
        lastChanged: "2026-01-01",
      },
    };
    const first = await run(baseTable, previous, "2026-02-03");
    const row = formatWatchSection(first)
      .split("\n")
      .filter((l) => l.startsWith("| [old"))[0];
    expect(row).toBe(
      "| [old\\|id\\_&lt;b&gt;](https://a.example/p%7Cq%20%28x%29%20%3Cy%3E%60%5C) | - | - | removed | " +
        "no longer in FEATURE\\_WATCH; dropped from the state file | - |",
    );
    // Unescaped pipes split cells: exactly 7 (6 cells).
    expect(row.match(/(?<!\\)\|/g)).toHaveLength(7);
    // A plain http(s) URL is unchanged.
    expect(formatWatchSection(first)).toContain(`[source-a](${PAGE_A})`);
  });

  it("23e. control-character entities and `$…$` math from a page render as literal text", async () => {
    // `&#1;`/`&#2;` decode to C0 bytes. GitHub renders `$x$` as inline math
    // even as `\$x\$` or `&#36;x&#36;`; a U+2060 before each `$` stops it.
    const first = await run(
      { [PAGE_A]: pageA("MCP a&#1;b&#2;c use $client $x$ and $y$ end") },
      {},
      "2026-02-03",
      [htmlA],
    );
    const row = formatWatchSection(first)
      .split("\n")
      .filter((l) => l.startsWith("| ["))[0];
    expect(row).toBe(
      `| [source-a](${PAGE_A}) | Alpha | C-A1 | baseline | - | ` +
        'mcp: "MCP abc use \u2060$client \u2060$x\u2060$ and \u2060$y\u2060$ end" |',
    );
    expect(row).not.toMatch(/\p{Cc}|(?<!\u2060)\$/u);
  });

  it("23d. a 160-unit evidence cut through an emoji leaves no lone surrogate in the section", async () => {
    // The evidence window is 60 units before the match, the match, and 60
    // after, cut to 160: an 80-unit match puts the cut at unit 20 after it.
    const match = "MCP" + "x".repeat(77);
    const tools = "a".repeat(60) + match + "b".repeat(19) + "\u{1F600}" + "c".repeat(40);
    const long: WatchSource = {
      ...htmlA,
      checks: [{ id: "mcp", question: "Long match?", pattern: "mcpx{77}" }],
    };
    const first = await run({ [PAGE_A]: pageA(tools) }, {}, "2026-02-03", [long]);
    const ev = first.reports[0].evidence.mcp;
    expect(ev.charCodeAt(ev.length - 1)).toBe(0xd83d);
    const text = formatWatchSection(first);
    expect(text).not.toMatch(/[\uD800-\uDFFF]/);
    expect(text).toContain(`${match}${"b".repeat(19)}"`);
  });
});

describe("flagValues", () => {
  it("24. returns every value in order and rejects a missing value or a following flag", () => {
    expect(flagValues(["--only", "a", "--state", "s", "--only", "b"], "--only")).toEqual([
      "a",
      "b",
    ]);
    expect(flagValues(["--dry-run"], "--state")).toEqual([]);
    expect(() => flagValues(["--state"], "--state")).toThrow("--state needs a value");
    expect(() => flagValues(["--state", "--only", "x"], "--state")).toThrow(
      "--state needs a value",
    );
    expect(() => flagValues(["--state", "a", "--state"], "--state")).toThrow(
      "--state needs a value",
    );
  });

  it("25. a repeated single-value flag keeps every value in order; a flag never fills one", () => {
    // flagValues returns all values; each script takes the last one. That
    // resolution is driven through the real script in
    // competitive-matrix-fetch-failure.test.ts ("--summary A --summary B").
    expect(flagValues(["--watch-state", "A", "--watch-state", "B"], "--watch-state")).toEqual([
      "A",
      "B",
    ]);
    expect(() => flagValues(["--summary", "--dry-run"], "--summary")).toThrow(
      "--summary needs a value",
    );
  });

  it("26. rejects the --flag=value form instead of ignoring it", () => {
    expect(() => flagValues(["--watch-state=/tmp/x"], "--watch-state")).toThrow(
      "--watch-state=/tmp/x is not supported; use --watch-state /tmp/x",
    );
    expect(() => flagValues(["--summary=out.md"], "--summary")).toThrow(
      "--summary=out.md is not supported; use --summary out.md",
    );
    expect(() => flagValues(["--only=a"], "--only")).toThrow(
      "--only=a is not supported; use --only a",
    );
    // A longer flag that shares the prefix is not the same flag.
    expect(flagValues(["--states", "x"], "--state")).toEqual([]);
  });
});

describe("checkArgs", () => {
  const VALUES = ["--state", "--only"];

  it("27. accepts every valid command line", () => {
    expect(() => checkArgs([], VALUES)).not.toThrow();
    expect(() => checkArgs(["--only", "a", "--only", "b", "--state", "s"], VALUES)).not.toThrow();
    expect(() =>
      checkArgs(["--dry-run", "--summary", "x"], ["--summary"], ["--dry-run"]),
    ).not.toThrow();
  });

  it("28. rejects --flag=value, unknown options, stray arguments and missing values", () => {
    expect(() => checkArgs(["--state=x"], VALUES)).toThrow(
      "--state=x is not supported; use --state x",
    );
    expect(() => checkArgs(["--only", "a", "b"], VALUES)).toThrow(
      "unexpected argument b: --only takes one value; repeat it (--only a --only b)",
    );
    expect(() => checkArgs(["bogus"], VALUES)).toThrow("unexpected argument bogus");
    expect(() => checkArgs(["--bogus"], VALUES)).toThrow("unknown option --bogus");
    expect(() => checkArgs(["--summary=x"], VALUES)).toThrow("unknown option --summary=x");
    expect(() => checkArgs(["--dry-run=1"], ["--summary"], ["--dry-run"])).toThrow(
      "unknown option --dry-run=1",
    );
    expect(() => checkArgs(["--state"], VALUES)).toThrow("--state needs a value");
  });

  it("29. the direct run rejects a bad command line before any fetch", () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-args-"));
    try {
      // Any fetch fails the run with a marker, so a run that reached the
      // network cannot pass as a flag error.
      const stub = join(dir, "no-fetch.mjs");
      writeFileSync(
        stub,
        'globalThis.fetch = async () => { throw new Error("FETCH-ATTEMPTED"); };\n',
        "utf-8",
      );
      const script = resolve(REPO_ROOT, "scripts/competitive-watch.ts");
      const id = FEATURE_WATCH[0].id;
      const cases: [string[], string][] = [
        [["--state=x"], "--state=x is not supported; use --state x"],
        [["--only", id, "b"], `unexpected argument b: --only takes one value`],
        [["bogus"], "unexpected argument bogus"],
        [["--summary", "x"], "unknown option --summary"],
        [["--state"], "--state needs a value"],
      ];
      for (const [args, message] of cases) {
        const res = spawnSync(
          process.execPath,
          ["--import", "tsx", "--import", pathToFileURL(stub).href, script, ...args],
          { cwd: REPO_ROOT, encoding: "utf-8", timeout: 60_000 },
        );
        expect(res.error).toBeUndefined();
        const out = `${res.stdout}\n${res.stderr}`;
        expect(res.status, args.join(" ")).toBe(1);
        expect(out).toContain(message);
        expect(out).not.toContain("FETCH-ATTEMPTED");
        expect(out).not.toContain("=== Feature watch");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
