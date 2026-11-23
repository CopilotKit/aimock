/**
 * The per-test MCP fake report in the Vitest and Jest plugins (record-replay
 * RP7) and the default test id (TI1, TI4, TI5).
 *
 * Real surface: child vitest runs of `fixtures/fakes-report/*.case.ts` (a
 * failing `afterEach` must fail a run, which this suite cannot host), each
 * with a real `LLMock` on a real port and a real v1 MCP SDK client. The RP7 (b)
 * journal-marker cases drive `FakesPluginState` against a real `LLMock` too.
 * The Jest plugin runs under vitest globals here, as in
 * `mcp-fakes-plugins.test.ts`; its TI2 default id is proved in
 * `examples/mcp-fakes-report-proof` under real Jest.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LLMock } from "../llmock.js";
import { FakesPluginState, fakesReportMode } from "../fakes-plugin.js";
import { AimockFakesReportError } from "../mcp-fakes-report.js";
import { REPO_ROOT, connectV1, enc } from "./mcp-fakes-harness.js";

const CASE_DIR = resolve(__dirname, "fixtures/fakes-report");
const CASE_CONFIG = resolve(CASE_DIR, "vitest.config.ts");
const WEATHER = resolve(CASE_DIR, "fixtures/weather.json");
const UNUSED_ID = "unused.case.ts › weather › unused";

function runCase(
  caseFile: string,
  env: Record<string, string> = {},
): Promise<{ code: number | null; output: string }> {
  const vitestBin = resolve(REPO_ROOT, "node_modules/vitest/vitest.mjs");
  return new Promise((res, rej) => {
    const cp = spawn(process.execPath, [vitestBin, "run", "--config", CASE_CONFIG, caseFile], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env, CI: "1", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    cp.stdout.setEncoding("utf8");
    cp.stderr.setEncoding("utf8");
    cp.stdout.on("data", (d: string) => (output += d));
    cp.stderr.on("data", (d: string) => (output += d));
    cp.on("error", rej);
    cp.on("close", (code) => res({ code, output }));
  });
}

const MISMATCH_LINE =
  'failure MCP_FAKE_MISMATCH: tools/call get_weather on /mcp with {"city":"Portland"}';

for (const plugin of ["vitest", "jest"] as const) {
  describe(`RP7: ${plugin} plugin fakesReport (child vitest run)`, () => {
    const env = { AIMOCK_CASE_PLUGIN: plugin };

    it('"fail": a swallowed mismatch fails the test in afterEach', async () => {
      const { code, output } = await runCase("swallowed.case.ts", env);
      expect(code, output).toBe(1);
      expect(output).toContain("AimockFakesReportError: aimock MCP fakes report failed");
      expect(output).toContain(MISMATCH_LINE);
      expect(output).toMatch(/Tests\s+1 failed \(1\)/);
    }, 60_000);

    it('"off": the same test passes', async () => {
      const { code, output } = await runCase("swallowed.case.ts", {
        ...env,
        AIMOCK_CASE_FAKES_REPORT: "off",
      });
      expect(code, output).toBe(0);
      expect(output).not.toContain("MCP_FAKE_MISMATCH: tools/call");
    }, 60_000);

    it('"warn": the test passes and the report text is printed', async () => {
      const { code, output } = await runCase("swallowed.case.ts", {
        ...env,
        AIMOCK_CASE_FAKES_REPORT: "warn",
      });
      expect(code, output).toBe(0);
      expect(output).toContain(
        'aimock MCP fakes report failed (testId "swallowed.case.ts › weather › seattle")',
      );
      expect(output).toContain(MISMATCH_LINE);
    }, 60_000);

    it('"fail": an unused fake fails the test, naming the entry; a test with no MCP traffic is not checked', async () => {
      const { code, output } = await runCase("unused.case.ts", env);
      expect(code, output).toBe(1);
      expect(output).toContain("unconsumed: weather.json[1]:never-called (/mcp get_weather)");
      expect(output).toMatch(/Tests\s+1 failed \| 1 passed \(2\)/);
    }, 60_000);
  });
}

describe("TI1/TI4: Vitest default test id (child vitest run)", () => {
  it("is <file> › <describe…> › <test>, reaches the scoped fake, and never tags LLM traffic", async () => {
    const { code, output } = await runCase("default-id.case.ts");
    expect(code, output).toBe(0);
    expect(output).toContain("DEFAULT_ID=default-id.case.ts › outer › inner › case");
    expect(output).toContain("DEFAULT_ID=default-id.case.ts › top");
    expect(output).toMatch(/Tests\s+4 passed \(4\)/);
  }, 60_000);
});

describe("TI5: Vitest default-id collisions (child vitest run)", () => {
  it("a duplicate title throws, a retry reuses its id, a concurrent test throws", async () => {
    const { code, output } = await runCase("collision.case.ts");
    expect(code, output).toBe(0);
    expect(output).toContain("RETRY_ATTEMPT=1 ID=collision.case.ts › retried");
    expect(output).toContain("RETRY_ATTEMPT=2 ID=collision.case.ts › retried");
    expect(output).toMatch(/Tests\s+4 passed \(4\)/);
  }, 60_000);
});

describe("RP7: Vitest fakesReport refuses concurrent tests (child vitest run)", () => {
  it('"fail": each concurrent test fails in beforeEach instead of reading a shared report', async () => {
    const { code, output } = await runCase("concurrent.case.ts");
    expect(code, output).toBe(1);
    expect(output).toContain(
      'useAimock(): fakesReport is not supported in concurrent tests; set fakesReport: "off" for this suite or run it sequentially',
    );
    expect(output).not.toContain("AimockFakesReportError");
    expect(output).toMatch(/Tests\s+2 failed \(2\)/);
  }, 60_000);

  it('"off": the same concurrent tests pass with explicit ids', async () => {
    const { code, output } = await runCase("concurrent.case.ts", {
      AIMOCK_CASE_FAKES_REPORT: "off",
    });
    expect(code, output).toBe(0);
    expect(output).toMatch(/Tests\s+2 passed \(2\)/);
  }, 60_000);
});

describe("RP7 (b): FakesPluginState against a real LLMock", () => {
  let llm: LLMock | null = null;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (llm) await llm.stop();
    llm = null;
  });

  async function start(opts: { journalMaxEntries?: number } = {}): Promise<{
    llm: LLMock;
    url: string;
  }> {
    llm = new LLMock({ ...opts, logLevel: "silent" });
    llm.loadFixtureFile(WEATHER);
    const url = await llm.start();
    return { llm, url };
  }

  async function listToolsAs(url: string, headers: Record<string, string>): Promise<void> {
    const c = await connectV1(`${url}/mcp`, { headers });
    try {
      await c.listTools();
    } finally {
      await c.close().catch(() => {});
    }
  }

  async function llmRequests(url: string, n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      await fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "m", messages: [{ role: "user", content: `r${i}` }] }),
      });
    }
  }

  it("checks a test id sent by hand, with no fakesFor", async () => {
    const { llm, url } = await start();
    const state = new FakesPluginState("fail");
    state.beforeEach(llm);
    await listToolsAs(url, { "X-Test-Id": enc(UNUSED_ID) });
    expect(state.identities(llm)).toEqual([{ testId: UNUSED_ID, context: null }]);
    const err = await state.afterEach(llm, url).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AimockFakesReportError);
    expect((err as AimockFakesReportError).message).toContain("never-called");
    expect((err as AimockFakesReportError).report.testId).toBe(UNUSED_ID);
  });

  it("does not check a test that sent nothing to MCP, nor traffic before the marker", async () => {
    const { llm, url } = await start();
    await listToolsAs(url, { "X-Test-Id": enc(UNUSED_ID) }); // an earlier test's traffic
    const state = new FakesPluginState("fail");
    state.beforeEach(llm);
    await llmRequests(url, 1);
    expect(state.identities(llm)).toEqual([]);
    await expect(state.afterEach(llm, url)).resolves.toBeUndefined();
  });

  it("still works when the journal cap evicts the marker entry (C2)", async () => {
    const { llm, url } = await start({ journalMaxEntries: 5 });
    await llmRequests(url, 10);
    const state = new FakesPluginState("fail");
    state.beforeEach(llm);
    const marker = llm.getLastRequest()?.id;
    await listToolsAs(url, { "X-Test-Id": enc(UNUSED_ID) });
    await llmRequests(url, 5); // pushes the marker (and the MCP entries' elders) out
    await listToolsAs(url, { "X-Test-Id": enc(UNUSED_ID) });
    expect(llm.getRequests().some((e) => e.id === marker)).toBe(false);
    expect(state.identities(llm)).toEqual([{ testId: UNUSED_ID, context: null }]);
    await expect(state.afterEach(llm, url)).rejects.toThrow("never-called");
  });

  it("lists an unconsumed entry two identities share once (registered (T, null), wire (T, X))", async () => {
    const { llm, url } = await start();
    const state = new FakesPluginState("fail");
    state.beforeEach(llm);
    state.register(UNUSED_ID, null);
    await listToolsAs(url, { "X-Test-Id": enc(UNUSED_ID), "X-AIMock-Context": enc("ctx x") });
    expect(state.identities(llm)).toEqual([
      { testId: UNUSED_ID, context: null },
      { testId: UNUSED_ID, context: "ctx x" },
    ]);
    const err = await state.afterEach(llm, url).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AimockFakesReportError);
    const message = (err as AimockFakesReportError).message;
    expect(message.match(/never-called/g)).toHaveLength(1);
    expect(message).toContain('context "ctx x"');
  });

  it('"warn" prints the report text instead of throwing; "off" reads nothing', async () => {
    const { llm, url } = await start();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const warnState = new FakesPluginState("warn");
    warnState.beforeEach(llm);
    await listToolsAs(url, { "X-Test-Id": enc(UNUSED_ID) });
    await expect(warnState.afterEach(llm, url)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/unconsumed: \S*weather\.json\[1\]:never-called/);

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const offState = new FakesPluginState("off");
    offState.beforeEach(llm);
    await listToolsAs(url, { "X-Test-Id": enc(UNUSED_ID) });
    fetchSpy.mockClear();
    await expect(offState.afterEach(llm, url)).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects an unknown fakesReport mode", () => {
    expect(fakesReportMode(undefined)).toBe("off");
    expect(() => fakesReportMode("loud" as "off")).toThrow(
      'useAimock(): fakesReport must be one of "off", "warn", "fail"; got "loud"',
    );
  });
});
