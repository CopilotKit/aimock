import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFile, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runAimockCli, type AimockCliDeps } from "../aimock-cli.js";
import type { AimockConfig } from "../config-loader.js";

const CLI_PATH = resolve(__dirname, "../../dist/aimock-cli.js");
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
  return mkdtempSync(join(tmpdir(), "aimock-cli-test-"));
}

function writeConfig(dir: string, config: object, name = "aimock.json"): string {
  const filePath = join(dir, name);
  writeFileSync(filePath, JSON.stringify(config), "utf-8");
  return filePath;
}

function writeFixtureFile(dir: string, name = "fixtures.json"): string {
  const filePath = join(dir, name);
  writeFileSync(
    filePath,
    JSON.stringify({
      fixtures: [
        {
          match: { userMessage: "hello" },
          response: { content: "Hello from aimock test!" },
        },
      ],
    }),
    "utf-8",
  );
  return filePath;
}

/* ================================================================== */
/* Integration tests (require dist build)                              */
/* ================================================================== */

describe.skipIf(!CLI_AVAILABLE)("aimock CLI: --help", () => {
  it("prints usage text and exits with code 0", async () => {
    const { stdout, code } = await runCli(["--help"]);
    expect(stdout).toContain("Usage: aimock");
    expect(stdout).toContain("--config");
    expect(code).toBe(0);
  });
});

describe.skipIf(!CLI_AVAILABLE)("aimock CLI: argument validation", () => {
  it("exits with error when --config is missing", async () => {
    const { stderr, code } = await runCli([]);
    expect(stderr).toContain("--config is required");
    expect(code).toBe(1);
  });

  it("exits with error for missing config file", async () => {
    const { stderr, code } = await runCli(["--config", "/nonexistent/aimock.json"]);
    expect(stderr).toContain("Failed to load config");
    expect(code).toBe(1);
  });
});

describe.skipIf(!CLI_AVAILABLE)("aimock CLI: server lifecycle", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("starts server with valid config, responds to requests, exits on SIGTERM", async () => {
    const fixturePath = writeFixtureFile(tmpDir);
    const configPath = writeConfig(tmpDir, {
      llm: { fixtures: fixturePath },
    });

    const child = spawnCli(["--config", configPath]);
    await child.waitForOutput(/listening on/i, 5000);

    // Extract the URL from output
    const match = child.stdout().match(/listening on (http:\/\/\S+)/);
    expect(match).not.toBeNull();
    const url = match![1];

    // Verify server responds to a request
    const resp = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    expect(resp.ok).toBe(true);

    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      child.cp.on("close", () => resolve());
    });
  });

  it("applies port override from --port flag", async () => {
    const configPath = writeConfig(tmpDir, {});
    const child = spawnCli(["--config", configPath, "--port", "0"]);
    await child.waitForOutput(/listening on/i, 5000);

    expect(child.stdout()).toContain("listening on");

    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      child.cp.on("close", () => resolve());
    });
  });

  it("exits with error for invalid JSON config", async () => {
    const configPath = join(tmpDir, "bad.json");
    writeFileSync(configPath, "{ not json", "utf-8");

    const { stderr, code } = await runCli(["--config", configPath]);
    expect(stderr).toContain("Failed to load config");
    expect(code).toBe(1);
  });
});

/* ================================================================== */
/* Unit tests (exercise runAimockCli directly for coverage)            */
/* ================================================================== */

/** Helper: call runAimockCli with captured output and a synchronous exit stub. */
function callCli(
  argv: string[],
  overrides: Partial<AimockCliDeps> = {},
): { logs: string[]; errors: string[]; exitCode: number | null } {
  const logs: string[] = [];
  const errors: string[] = [];
  let exitCode: number | null = null;

  runAimockCli({
    argv,
    log: (msg) => logs.push(msg),
    logError: (msg) => errors.push(msg),
    exit: (code) => {
      exitCode = code;
    },
    ...overrides,
  });

  return { logs, errors, exitCode };
}

describe("runAimockCli: --help flag", () => {
  it("prints help and exits 0", () => {
    const { logs, exitCode } = callCli(["--help"]);
    expect(exitCode).toBe(0);
    expect(logs.join("\n")).toContain("Usage: aimock");
    expect(logs.join("\n")).toContain("--config");
    expect(logs.join("\n")).toContain("--port");
    expect(logs.join("\n")).toContain("--host");
  });
});

describe("runAimockCli: missing --config", () => {
  it("prints error and exits 1 when no args given", () => {
    const { errors, exitCode } = callCli([]);
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("--config is required");
  });
});

describe("runAimockCli: unknown flag (strict parsing)", () => {
  it("prints error and exits 1 for unknown flags", () => {
    const { errors, exitCode } = callCli(["--unknown-flag"]);
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("Error:");
  });
});

describe("runAimockCli: config loading failure", () => {
  it("prints error and exits 1 when loadConfig throws an Error", () => {
    const { errors, exitCode } = callCli(["--config", "/fake/path.json"], {
      loadConfigFn: () => {
        throw new Error("ENOENT: no such file");
      },
    });
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("Failed to load config");
    expect(errors.join("\n")).toContain("ENOENT: no such file");
  });

  it("handles non-Error throws from loadConfig", () => {
    const { errors, exitCode } = callCli(["--config", "/fake/path.json"], {
      loadConfigFn: () => {
        throw "string error";
      },
    });
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("string error");
  });
});

describe("runAimockCli: successful server start", () => {
  // Track shutdown functions so we can clean up signal handlers after each test
  let cleanupFn: (() => void) | null = null;

  afterEach(() => {
    if (cleanupFn) {
      cleanupFn();
      cleanupFn = null;
    }
  });

  it("calls startFromConfig with correct args and logs the URL", async () => {
    const mockStop = vi.fn().mockResolvedValue(undefined);
    const mockLlmock = { stop: mockStop };
    const startFromConfigFn = vi.fn().mockResolvedValue({
      llmock: mockLlmock,
      url: "http://127.0.0.1:9876",
    });
    const loadConfigFn = vi.fn().mockReturnValue({ port: 3000 } as AimockConfig);
    const logs: string[] = [];
    const errors: string[] = [];
    let exitCode: number | null = null;

    runAimockCli({
      argv: ["--config", "/some/config.json"],
      log: (msg) => logs.push(msg),
      logError: (msg) => errors.push(msg),
      exit: (code) => {
        exitCode = code;
      },
      loadConfigFn,
      startFromConfigFn,
      onReady: (ctx) => {
        cleanupFn = ctx.shutdown;
      },
    });

    // Wait for the async main() to complete
    await vi.waitFor(() => {
      expect(logs).toContain("aimock server listening on http://127.0.0.1:9876");
    });

    expect(loadConfigFn).toHaveBeenCalledWith(resolve("/some/config.json"));
    expect(startFromConfigFn).toHaveBeenCalledWith(
      { port: 3000 },
      { port: undefined, host: undefined },
    );
    expect(exitCode).toBeNull(); // no exit — server stays running
    expect(errors).toHaveLength(0);
  });

  it("passes port and host overrides to startFromConfig", async () => {
    const startFromConfigFn = vi.fn().mockResolvedValue({
      llmock: { stop: vi.fn().mockResolvedValue(undefined) },
      url: "http://0.0.0.0:8080",
    });
    const loadConfigFn = vi.fn().mockReturnValue({} as AimockConfig);
    const logs: string[] = [];

    runAimockCli({
      argv: ["--config", "/c.json", "--port", "8080", "--host", "0.0.0.0"],
      log: (msg) => logs.push(msg),
      logError: () => {},
      exit: () => {},
      loadConfigFn,
      startFromConfigFn,
      onReady: (ctx) => {
        cleanupFn = ctx.shutdown;
      },
    });

    await vi.waitFor(() => {
      expect(startFromConfigFn).toHaveBeenCalled();
    });

    expect(startFromConfigFn).toHaveBeenCalledWith({}, { port: 8080, host: "0.0.0.0" });
  });

  it("passes short flags correctly (-c, -p, -h)", async () => {
    const startFromConfigFn = vi.fn().mockResolvedValue({
      llmock: { stop: vi.fn().mockResolvedValue(undefined) },
      url: "http://localhost:5555",
    });
    const loadConfigFn = vi.fn().mockReturnValue({} as AimockConfig);
    const logs: string[] = [];

    runAimockCli({
      argv: ["-c", "/c.json", "-p", "5555", "-h", "localhost"],
      log: (msg) => logs.push(msg),
      logError: () => {},
      exit: () => {},
      loadConfigFn,
      startFromConfigFn,
      onReady: (ctx) => {
        cleanupFn = ctx.shutdown;
      },
    });

    await vi.waitFor(() => {
      expect(startFromConfigFn).toHaveBeenCalled();
    });

    expect(startFromConfigFn).toHaveBeenCalledWith({}, { port: 5555, host: "localhost" });
  });
});

describe("runAimockCli: startFromConfig failure", () => {
  it("logs error and exits 1 when startFromConfig rejects", async () => {
    const startFromConfigFn = vi.fn().mockRejectedValue(new Error("bind EADDRINUSE"));
    const loadConfigFn = vi.fn().mockReturnValue({} as AimockConfig);
    const errors: string[] = [];
    let exitCode: number | null = null;

    runAimockCli({
      argv: ["--config", "/c.json"],
      log: () => {},
      logError: (msg) => errors.push(msg),
      exit: (code) => {
        exitCode = code;
      },
      loadConfigFn,
      startFromConfigFn,
    });

    await vi.waitFor(() => {
      expect(exitCode).toBe(1);
    });

    expect(errors.join("\n")).toContain("bind EADDRINUSE");
  });

  it("handles non-Error rejection from startFromConfig", async () => {
    const startFromConfigFn = vi.fn().mockRejectedValue("raw string rejection");
    const loadConfigFn = vi.fn().mockReturnValue({} as AimockConfig);
    const errors: string[] = [];
    let exitCode: number | null = null;

    runAimockCli({
      argv: ["--config", "/c.json"],
      log: () => {},
      logError: (msg) => errors.push(msg),
      exit: (code) => {
        exitCode = code;
      },
      loadConfigFn,
      startFromConfigFn,
    });

    await vi.waitFor(() => {
      expect(exitCode).toBe(1);
    });

    expect(errors.join("\n")).toContain("raw string rejection");
  });
});

describe("runAimockCli: onReady and shutdown", () => {
  let cleanupFn: (() => void) | null = null;

  afterEach(() => {
    if (cleanupFn) {
      cleanupFn();
      cleanupFn = null;
    }
  });

  it("invokes onReady callback after server starts", async () => {
    const mockStop = vi.fn().mockResolvedValue(undefined);
    const startFromConfigFn = vi.fn().mockResolvedValue({
      llmock: { stop: mockStop },
      url: "http://127.0.0.1:0",
    });
    const loadConfigFn = vi.fn().mockReturnValue({} as AimockConfig);

    runAimockCli({
      argv: ["--config", "/c.json"],
      log: () => {},
      logError: () => {},
      exit: () => {},
      loadConfigFn,
      startFromConfigFn,
      onReady: (ctx) => {
        cleanupFn = ctx.shutdown;
      },
    });

    await vi.waitFor(() => {
      expect(cleanupFn).not.toBeNull();
    });
  });

  it("shutdown calls llmock.stop()", async () => {
    const mockStop = vi.fn().mockResolvedValue(undefined);
    const startFromConfigFn = vi.fn().mockResolvedValue({
      llmock: { stop: mockStop },
      url: "http://127.0.0.1:0",
    });
    const loadConfigFn = vi.fn().mockReturnValue({} as AimockConfig);
    const logs: string[] = [];
    let shutdownFn: (() => void) | null = null;
    let exitCode: number | null = null;

    runAimockCli({
      argv: ["--config", "/c.json"],
      log: (msg) => logs.push(msg),
      logError: () => {},
      exit: (code) => {
        exitCode = code;
      },
      loadConfigFn,
      startFromConfigFn,
      onReady: (ctx) => {
        shutdownFn = ctx.shutdown;
      },
    });

    await vi.waitFor(() => {
      expect(shutdownFn).not.toBeNull();
    });

    // Calling shutdown removes signal handlers and stops the server
    shutdownFn!();
    cleanupFn = null; // Already cleaned up by shutdown
    expect(logs).toContain("Shutting down...");
    expect(mockStop).toHaveBeenCalled();

    await vi.waitFor(() => {
      expect(exitCode).toBe(0);
    });
  });

  it("shutdown logs error and exits 1 when llmock.stop() rejects", async () => {
    const mockStop = vi.fn().mockRejectedValue(new Error("close ENOTCONN"));
    const startFromConfigFn = vi.fn().mockResolvedValue({
      llmock: { stop: mockStop },
      url: "http://127.0.0.1:0",
    });
    const loadConfigFn = vi.fn().mockReturnValue({} as AimockConfig);
    const errors: string[] = [];
    let shutdownFn: (() => void) | null = null;
    let exitCode: number | null = null;

    runAimockCli({
      argv: ["--config", "/c.json"],
      log: () => {},
      logError: (msg) => errors.push(msg),
      exit: (code) => {
        exitCode = code;
      },
      loadConfigFn,
      startFromConfigFn,
      onReady: (ctx) => {
        shutdownFn = ctx.shutdown;
      },
    });

    await vi.waitFor(() => {
      expect(shutdownFn).not.toBeNull();
    });

    shutdownFn!();
    cleanupFn = null;

    await vi.waitFor(() => {
      expect(exitCode).toBe(1);
    });

    expect(errors.join("\n")).toContain("Shutdown error");
    expect(errors.join("\n")).toContain("close ENOTCONN");
  });
});

describe("runAimockCli: port parsing edge case", () => {
  let cleanupFn: (() => void) | null = null;

  afterEach(() => {
    if (cleanupFn) {
      cleanupFn();
      cleanupFn = null;
    }
  });

  it("passes undefined port when --port is not provided", async () => {
    const startFromConfigFn = vi.fn().mockResolvedValue({
      llmock: { stop: vi.fn().mockResolvedValue(undefined) },
      url: "http://127.0.0.1:0",
    });
    const loadConfigFn = vi.fn().mockReturnValue({} as AimockConfig);

    runAimockCli({
      argv: ["--config", "/c.json"],
      log: () => {},
      logError: () => {},
      exit: () => {},
      loadConfigFn,
      startFromConfigFn,
      onReady: (ctx) => {
        cleanupFn = ctx.shutdown;
      },
    });

    await vi.waitFor(() => {
      expect(startFromConfigFn).toHaveBeenCalled();
    });

    expect(startFromConfigFn).toHaveBeenCalledWith({}, { port: undefined, host: undefined });
  });

  it("rejects non-numeric port (NaN)", () => {
    const loadConfigFn = vi.fn().mockReturnValue({} as AimockConfig);
    const { errors, exitCode } = callCli(["--config", "/c.json", "--port", "abc"], {
      loadConfigFn,
    });
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("invalid port");
  });

  it("rejects negative port", () => {
    const loadConfigFn = vi.fn().mockReturnValue({} as AimockConfig);
    const { errors, exitCode } = callCli(["--config", "/c.json", "--port=-1"], { loadConfigFn });
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("invalid port");
  });

  it("rejects port above 65535", () => {
    const loadConfigFn = vi.fn().mockReturnValue({} as AimockConfig);
    const { errors, exitCode } = callCli(["--config", "/c.json", "--port", "99999"], {
      loadConfigFn,
    });
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("invalid port");
  });

  it("converts string port to number", async () => {
    const startFromConfigFn = vi.fn().mockResolvedValue({
      llmock: { stop: vi.fn().mockResolvedValue(undefined) },
      url: "http://127.0.0.1:4242",
    });
    const loadConfigFn = vi.fn().mockReturnValue({} as AimockConfig);

    runAimockCli({
      argv: ["--config", "/c.json", "--port", "4242"],
      log: () => {},
      logError: () => {},
      exit: () => {},
      loadConfigFn,
      startFromConfigFn,
      onReady: (ctx) => {
        cleanupFn = ctx.shutdown;
      },
    });

    await vi.waitFor(() => {
      expect(startFromConfigFn).toHaveBeenCalled();
    });

    expect(startFromConfigFn).toHaveBeenCalledWith({}, { port: 4242, host: undefined });
  });
});
