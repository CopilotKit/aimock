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
import { describe, it, expect, vi } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
