/**
 * Seeded chaos must not fail silently. Three gaps, one test block each:
 *
 * 1. `--chaos-keys-max` takes only a positive DECIMAL integer, spelled as one.
 *    `Number()` read `0x10`, `1e3` and `" 5 "` as valid counts.
 * 2. A seeded verdict rolled outside a server request scope cannot record its
 *    jitter source, so stream pacing stays on `Math.random()`. That is warned
 *    once, not dropped silently. Unseeded verdicts warn nothing.
 * 3. The embedder fallback occurrence registry warns when it evicts at its cap,
 *    once per burst, like a server registry does.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Logger } from "../logger.js";

const CLI_PATH = resolve(__dirname, "../../dist/cli.js");

vi.setConfig({ testTimeout: 20_000 });

/**
 * Run the built CLI. Resolves on exit, or when stdout announces the server is
 * listening (then the child is killed and `listening` is true).
 */
function runCli(
  args: string[],
): Promise<{ code: number | null; stderr: string; stdout: string; listening: boolean }> {
  return new Promise((res, rej) => {
    const cp = spawn(process.execPath, [CLI_PATH, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let listening = false;
    const timer = setTimeout(() => {
      cp.kill("SIGKILL");
      rej(new Error(`CLI neither exited nor listened: ${stdout}\n${stderr}`));
    }, 15_000);
    cp.stdout.on("data", (d) => {
      stdout += d;
      if (!listening && /listening on/i.test(stdout)) {
        listening = true;
        cp.kill("SIGTERM");
      }
    });
    cp.stderr.on("data", (d) => {
      stderr += d;
    });
    cp.on("exit", (code) => {
      clearTimeout(timer);
      res({ code, stderr, stdout, listening });
    });
  });
}

describe("--chaos-keys-max accepts only a positive decimal integer", () => {
  const fixturesDir = mkdtempSync(join(tmpdir(), "aimock-keys-max-"));

  it("dist/cli.js is built", () => {
    expect(existsSync(CLI_PATH)).toBe(true);
  });

  for (const bad of ["0x10", "1e3", " 5 ", "0", "-1", "abc"]) {
    it(`rejects ${JSON.stringify(bad)} with a non-zero exit`, async () => {
      const r = await runCli(["--fixtures", fixturesDir, "--port", "0", `--chaos-keys-max=${bad}`]);
      expect(r.listening).toBe(false);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain(`Invalid chaos-keys-max: ${bad}`);
    });
  }

  it('accepts "5" and starts the server', async () => {
    const r = await runCli(["--fixtures", fixturesDir, "--port", "0", "--chaos-keys-max=5"]);
    expect(r.stderr).not.toContain("Invalid chaos-keys-max");
    expect(r.listening).toBe(true);
    rmSync(fixturesDir, { recursive: true, force: true });
  });

  it("--chaos-seed error names the shared length limit", async () => {
    const { MAX_CHAOS_SEED_LENGTH } = await import("../chaos-random.js");
    const r = await runCli(["--fixtures", fixturesDir, "--port", "0", "--chaos-seed=a b"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain(`must be 1-${MAX_CHAOS_SEED_LENGTH} visible ASCII`);
  });
});

describe("seeded verdict outside a request scope", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("warns once that stream jitter is not seeded", async () => {
    vi.resetModules();
    const { evaluateChaos } = await import("../chaos.js");
    const logger = new Logger("warn");
    const warn = vi.spyOn(logger, "warn");
    evaluateChaos(null, undefined, {}, logger, "/direct", { seed: "s1" });
    evaluateChaos(null, undefined, {}, logger, "/direct", { seed: "s1" });
    const notes = warn.mock.calls.filter((c) => String(c[0]).includes("outside a server request"));
    expect(notes).toHaveLength(1);
    expect(String(notes[0][0])).toContain("Math.random()");
  });

  it("falls back to console.warn when no logger is passed", async () => {
    vi.resetModules();
    const { evaluateChaos } = await import("../chaos.js");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    evaluateChaos(null, undefined, {}, undefined, "/direct", { seed: "s1" });
    const notes = warn.mock.calls.filter((c) =>
      c.map(String).join(" ").includes("outside a server request"),
    );
    expect(notes).toHaveLength(1);
  });

  it("does not warn for an unseeded verdict or inside a request scope", async () => {
    vi.resetModules();
    const { evaluateChaos } = await import("../chaos.js");
    const { runInChaosRequestScope, currentChaosJitter } = await import("../chaos-random.js");
    const logger = new Logger("warn");
    const warn = vi.spyOn(logger, "warn");
    evaluateChaos(null, undefined, {}, logger, "/direct", { dropRate: 0 });
    let jitterSeen = false;
    runInChaosRequestScope(() => {
      evaluateChaos(null, undefined, {}, logger, "/direct", { seed: "s1" });
      jitterSeen = currentChaosJitter() !== undefined;
    });
    expect(jitterSeen).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("fallback occurrence registry eviction", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("warns once per burst when it evicts at its cap", async () => {
    vi.resetModules();
    const { fallbackChaosOccurrences, resetChaosOccurrences } = await import("../chaos-random.js");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const capNotes = () =>
      warn.mock.calls.filter((c) => c.map(String).join(" ").includes("key cap reached"));
    const max = fallbackChaosOccurrences.max;
    for (let i = 0; i < max; i++) fallbackChaosOccurrences.next("t", "s", `k${i}`);
    expect(capNotes()).toHaveLength(0);
    fallbackChaosOccurrences.next("t", "s", "over-1");
    fallbackChaosOccurrences.next("t", "s", "over-2");
    expect(capNotes()).toHaveLength(1);
    resetChaosOccurrences();
    for (let i = 0; i <= max; i++) fallbackChaosOccurrences.next("t", "s", `r${i}`);
    expect(capNotes()).toHaveLength(2);
    resetChaosOccurrences();
  });
});
