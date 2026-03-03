import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI_PATH = resolve(__dirname, "../../dist/cli.js");
const CLI_AVAILABLE = existsSync(CLI_PATH);

/** Spawn the CLI and collect stdout/stderr/exit code. */
function runCli(
  args: string[],
  opts: { timeout?: number } = {},
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const timeout = opts.timeout ?? 5000;
  return new Promise((res) => {
    const cp = execFile("node", [CLI_PATH, ...args], { timeout }, (err, stdout, stderr) => {
      const code = cp.exitCode ?? (err && "code" in err ? (err as { code: number }).code : null);
      res({ stdout, stderr, code });
    });
  });
}

/**
 * Spawn the CLI expecting a long-running server.  Returns the child
 * process plus helpers to read accumulated output and send signals.
 */
function spawnCli(args: string[]): {
  cp: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  kill: (signal?: NodeJS.Signals) => void;
  waitForOutput: (match: RegExp, timeoutMs?: number) => Promise<void>;
} {
  let out = "";
  let err = "";
  const cp = execFile("node", [CLI_PATH, ...args]);
  cp.stdout?.on("data", (d) => {
    out += d;
  });
  cp.stderr?.on("data", (d) => {
    err += d;
  });

  const waitForOutput = (match: RegExp, timeoutMs = 5000): Promise<void> =>
    new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        reject(new Error(`Timed out waiting for ${match} — stdout: ${out}, stderr: ${err}`));
      }, timeoutMs);

      const check = () => {
        if (match.test(out) || match.test(err)) {
          clearTimeout(deadline);
          resolve();
          return;
        }
        setTimeout(check, 50);
      };
      check();
    });

  return {
    cp,
    stdout: () => out,
    stderr: () => err,
    kill: (signal: NodeJS.Signals = "SIGTERM") => cp.kill(signal),
    waitForOutput,
  };
}

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "cli-test-"));
}

function writeFixture(dir: string, name: string): string {
  const filePath = join(dir, name);
  writeFileSync(
    filePath,
    JSON.stringify({
      fixtures: [
        {
          match: { userMessage: "hello" },
          response: { content: "Hello from test fixture!" },
        },
      ],
    }),
    "utf-8",
  );
  return filePath;
}

/* ================================================================== */

describe.skipIf(!CLI_AVAILABLE)("CLI: --help", () => {
  it("prints usage text and exits with code 0", async () => {
    const { stdout, code } = await runCli(["--help"]);
    expect(stdout).toContain("Usage: mock-openai");
    expect(stdout).toContain("--port");
    expect(stdout).toContain("--fixtures");
    expect(code).toBe(0);
  });
});

describe.skipIf(!CLI_AVAILABLE)("CLI: argument validation", () => {
  it("rejects --port 99999 (out of range)", async () => {
    const { stderr, code } = await runCli(["--port", "99999"]);
    expect(stderr).toContain("Invalid port");
    expect(code).toBe(1);
  });

  it("rejects --port=-1 (negative)", async () => {
    const { stderr, code } = await runCli(["--port=-1"]);
    expect(stderr).toContain("Invalid port");
    expect(code).toBe(1);
  });

  it("rejects --latency=-5 (negative)", async () => {
    const { stderr, code } = await runCli(["--latency=-5"]);
    expect(stderr).toContain("Invalid latency");
    expect(code).toBe(1);
  });

  it("rejects --chunk-size 0 (below minimum)", async () => {
    const { stderr, code } = await runCli(["--chunk-size", "0"]);
    expect(stderr).toContain("Invalid chunk-size");
    expect(code).toBe(1);
  });
});

describe.skipIf(!CLI_AVAILABLE)("CLI: fixture loading", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("starts server with a valid fixture file, then exits cleanly on SIGTERM", async () => {
    const fixturePath = writeFixture(tmpDir, "test.json");
    const child = spawnCli(["--fixtures", fixturePath, "--port", "0"]);

    await child.waitForOutput(/listening on/i, 5000);
    expect(child.stdout()).toContain("Loaded 1 fixture(s)");

    child.kill("SIGTERM");

    await new Promise<void>((resolve) => {
      child.cp.on("close", (code) => {
        expect(code).toBe(0);
        resolve();
      });
    });
  });

  it("fails with error when --fixtures points to a non-existent path", async () => {
    const { stderr, code } = await runCli(["--fixtures", "/nonexistent/path/to/fixtures"]);
    expect(stderr).toContain("Fixtures path not found");
    expect(code).toBe(1);
  });
});
