import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { execFile, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runAimockCli, type AimockCliDeps } from "../aimock-cli.js";
import type { AimockConfig, AimockRecordConfig } from "../config-loader.js";
import { connectV1 } from "./mcp-fakes-harness.js";
import { startUpstream, type UpstreamHandle } from "./mcp-upstream-harness.js";

const CLI_PATH = resolve(__dirname, "../../dist/aimock-cli.js");
const CLI_AVAILABLE = existsSync(CLI_PATH);

// These integration tests spawn an additional Node process. Under the full
// parallel suite the default 5s runner deadline can expire before a healthy
// child gets CPU time to print its immediate startup/error result.
vi.setConfig({ testTimeout: 15_000 });

/** Spawn the CLI and collect stdout/stderr/exit code. */
function runCli(
  args: string[],
  opts: { timeout?: number } = {},
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const timeout = opts.timeout ?? 10_000;
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
function spawnCli(
  args: string[],
  envOverrides: NodeJS.ProcessEnv = {},
): {
  cp: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  kill: (signal?: NodeJS.Signals) => void;
  waitForOutput: (match: RegExp, timeoutMs?: number) => Promise<void>;
} {
  let out = "";
  let err = "";
  const env = { ...process.env, ...envOverrides };
  if (!("AIMOCK_API_KEYS" in envOverrides)) delete env.AIMOCK_API_KEYS;
  const cp = execFile("node", [CLI_PATH, ...args], { env });
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

  it("applies config auth and lets AIMOCK_API_KEYS override it", async () => {
    const fixturePath = writeFixtureFile(tmpDir);
    const configPath = writeConfig(tmpDir, {
      llm: { fixtures: fixturePath },
      auth: { apiKeys: ["config-key"] },
    });
    const body = JSON.stringify({
      model: "gpt-4",
      messages: [{ role: "user", content: "hello" }],
    });
    const requestWith = (url: string, key: string): Promise<Response> =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body,
      });

    const configured = spawnCli(["--config", configPath]);
    await configured.waitForOutput(/listening on/i);
    const configuredUrl = configured.stdout().match(/listening on (http:\/\/\S+)/)?.[1];
    expect(configuredUrl).toBeTruthy();
    try {
      expect((await requestWith(configuredUrl!, "wrong-key")).status).toBe(401);
      expect((await requestWith(configuredUrl!, "config-key")).status).toBe(200);
    } finally {
      configured.kill();
      await new Promise<void>((resolve) => configured.cp.on("close", () => resolve()));
    }

    const overridden = spawnCli(["--config", configPath], { AIMOCK_API_KEYS: "environment-key" });
    await overridden.waitForOutput(/listening on/i);
    const overriddenUrl = overridden.stdout().match(/listening on (http:\/\/\S+)/)?.[1];
    expect(overriddenUrl).toBeTruthy();
    try {
      expect((await requestWith(overriddenUrl!, "config-key")).status).toBe(401);
      expect((await requestWith(overriddenUrl!, "environment-key")).status).toBe(200);
    } finally {
      overridden.kill();
      await new Promise<void>((resolve) => overridden.cp.on("close", () => resolve()));
    }
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

describe.skipIf(!CLI_AVAILABLE)("aimock CLI: llm.record.mcp defaults logLevel to warn", () => {
  let tmpDir: string;
  // Fixtures in a subdirectory, so the loader does not read aimock.json as a fixture file.
  let fx: string;
  let up: UpstreamHandle;

  beforeAll(async () => {
    up = await startUpstream();
  }, 60_000);

  afterAll(async () => {
    await up?.stop();
  });

  beforeEach(() => {
    tmpDir = makeTmpDir();
    fx = join(tmpDir, "fixtures");
    mkdirSync(fx);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * The `llm` block as written to the config file. `llm.record` here is MCP-only, as in the
   * documented sample: `AimockRecordConfig` requires `providers`, but the loader accepts a
   * record block without it (no LLM recording). `providers: {}` is not the same at runtime:
   * any LLM `record` object passes the server's `defaults.record` gates (record-mode
   * matching, the fixture-miss record branch).
   */
  type McpRecordOnlyLlm = Omit<NonNullable<AimockConfig["llm"]>, "record"> & {
    record?: Pick<AimockRecordConfig, "mcp">;
  };

  /** Start `aimock --config`, send MCP calls with no testId, and return all output. */
  async function outputAfterUnscopedCalls(llm: McpRecordOnlyLlm): Promise<string> {
    const child = spawnCli(["--config", writeConfig(tmpDir, { llm })]);
    try {
      await child.waitForOutput(/listening on/i, 10_000);
      const url = child.stdout().match(/listening on (http:\/\/\S+)/)?.[1];
      expect(url).toBeTruthy();
      const client = await connectV1(`${url}/mcp`);
      await client.listTools();
      await client.callTool({ name: "echo", arguments: { message: "hi" } });
      await client.close();
      if (llm?.record?.mcp && llm.logLevel === undefined) {
        await child.waitForOutput(/MCP-RECORD:/, 5000);
      } else {
        // Give a warning the same time to appear before asserting it did not.
        await new Promise((r) => setTimeout(r, 500));
      }
      return child.stdout() + child.stderr();
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        if (child.cp.exitCode !== null) return resolve();
        child.cp.on("close", () => resolve());
      });
    }
  }

  it("prints the MCP-RECORD warning at the default log level", async () => {
    const out = await outputAfterUnscopedCalls({
      fixtures: fx,
      record: { mcp: { "/mcp": up.url } },
    });
    expect(out).toContain("MCP-RECORD: forwarded, not recorded");
  });

  it("an explicit logLevel silent wins: only the listening line", async () => {
    const out = await outputAfterUnscopedCalls({
      fixtures: fx,
      logLevel: "silent",
      record: { mcp: { "/mcp": up.url } },
    });
    expect(out).not.toContain("MCP-RECORD");
    expect(out.trim().split("\n")).toEqual([expect.stringMatching(/listening on/)]);
  });

  /** Start `aimock --config`, call a deprecated route that warns, and return all output. */
  async function outputAfterDeprecatedRoute(llm: McpRecordOnlyLlm): Promise<string> {
    const child = spawnCli(["--config", writeConfig(tmpDir, { llm })]);
    try {
      await child.waitForOutput(/listening on/i, 10_000);
      const url = child.stdout().match(/listening on (http:\/\/\S+)/)?.[1];
      expect(url).toBeTruthy();
      // This deprecated route logs a warning, which "warn" would print.
      const res = await fetch(`${url}/__aimock/reset/fixtures`, { method: "POST" });
      expect(res.ok).toBe(true);
      await new Promise((r) => setTimeout(r, 500));
      return child.stdout() + child.stderr();
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        if (child.cp.exitCode !== null) return resolve();
        child.cp.on("close", () => resolve());
      });
    }
  }

  it("a config without llm.record.mcp still starts silent", async () => {
    const out = await outputAfterDeprecatedRoute({ fixtures: fx });
    expect(out.trim().split("\n")).toEqual([expect.stringMatching(/listening on/)]);
  });

  it("R2 (C3): an empty llm.record.mcp {} records nothing and still starts silent", async () => {
    const out = await outputAfterDeprecatedRoute({ fixtures: fx, record: { mcp: {} } });
    expect(out.trim().split("\n")).toEqual([expect.stringMatching(/listening on/)]);
  });

  it("positive control: llm.record.mcp with a mount prints the deprecated-route warning", async () => {
    const out = await outputAfterDeprecatedRoute({
      fixtures: fx,
      record: { mcp: { "/mcp": up.url } },
    });
    expect(out).toContain("deprecated");
  });
});

describe.skipIf(!CLI_AVAILABLE)("aimock CLI: npx/bunx symlink invocation (#160)", () => {
  let tmpDir: string;
  let symlinkPath: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    symlinkPath = join(tmpDir, "aimock");
    symlinkSync(CLI_PATH, symlinkPath);
  });

  afterEach(() => {
    try {
      unlinkSync(symlinkPath);
    } catch {
      /* already cleaned up */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("starts when invoked as 'aimock' symlink (npx/bunx scenario)", async () => {
    const fixturePath = writeFixtureFile(tmpDir);
    const configPath = writeConfig(tmpDir, {
      llm: { fixtures: fixturePath },
    });

    let out = "";
    let err = "";
    const cp = execFile("node", [symlinkPath, "--config", configPath]);
    cp.stdout?.on("data", (d: string) => {
      out += d;
    });
    cp.stderr?.on("data", (d: string) => {
      err += d;
    });

    // Wait for "listening" output — proves the entry-point guard fired
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => {
        reject(new Error(`Timed out — stdout: ${out}, stderr: ${err}`));
      }, 5000);
      const check = () => {
        if (/listening on/i.test(out) || /listening on/i.test(err)) {
          clearTimeout(deadline);
          resolve();
          return;
        }
        setTimeout(check, 50);
      };
      check();
    });

    expect(out).toContain("listening on");

    cp.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      cp.on("close", () => resolve());
    });
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

  // `-h` is NOT in this list any more: on the `aimock` bin it means `--help`,
  // matching `aimock convert -h` and `aimock validate -h`. The host override
  // is long-form only, and is covered by the short-flag tests at the end of
  // this file.
  it("passes short flags correctly (-c, -p) with a long --host", async () => {
    const startFromConfigFn = vi.fn().mockResolvedValue({
      llmock: { stop: vi.fn().mockResolvedValue(undefined) },
      url: "http://localhost:5555",
    });
    const loadConfigFn = vi.fn().mockReturnValue({} as AimockConfig);
    const logs: string[] = [];

    runAimockCli({
      argv: ["-c", "/c.json", "-p", "5555", "--host", "localhost"],
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

  it("shutdown calls aimock.stop()", async () => {
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

  it("shutdown logs error and exits 1 when aimock.stop() rejects", async () => {
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

describe("aimock top-level help — validate synopsis", () => {
  /** Capture the HELP text the top-level `--help` prints. */
  function topLevelHelp(): string {
    const lines: string[] = [];
    runAimockCli({
      argv: ["--help"],
      log: (m) => lines.push(m),
      logError: (m) => lines.push(m),
      exit: () => {},
    });
    return lines.join("\n");
  }

  it("shows the `--` terminator, so the first help a user hits is not missing the only escape hatch for a path starting with `-`", () => {
    const synopsis = topLevelHelp()
      .split("\n")
      .find((l) => l.trim().startsWith("aimock validate"));
    expect(synopsis).toBeDefined();
    expect(synopsis!.trim()).toBe(
      "aimock validate [--strict] [--json] [--] <path> [more paths ...]",
    );
  });

  it("matches the synopsis README documents verbatim", () => {
    const readme = readFileSync(resolve(__dirname, "../../README.md"), "utf8");
    const documented = "aimock validate [--strict] [--json] [--] <path> [more paths ...]";
    // Guard against the README line being reworded out from under this test.
    expect(readme).toContain("`" + documented + "`");
    expect(topLevelHelp()).toContain(documented);
  });
});

// ---------------------------------------------------------------------------
// CLI surface consistency on the `aimock` bin.
// ---------------------------------------------------------------------------

/**
 * Collect everything one `runAimockCli` call writes, without letting it reach a
 * server: `loadConfigFn` is never needed on the paths tested here, and any that
 * does reach it gets a config that starts nothing.
 */
function surface(argv: string[]): {
  logs: string[];
  errors: string[];
  code: number | null;
  started: ReturnType<typeof vi.fn>;
} {
  const logs: string[] = [];
  const errors: string[] = [];
  let code: number | null = null;
  const started = vi.fn().mockResolvedValue({
    llmock: { stop: vi.fn().mockResolvedValue(undefined) },
    url: "http://127.0.0.1:0",
  });
  runAimockCli({
    argv,
    log: (m) => logs.push(m),
    logError: (m) => errors.push(m),
    exit: (c) => {
      code = c;
    },
    loadConfigFn: vi.fn().mockReturnValue({} as AimockConfig),
    startFromConfigFn: started,
    // Any path that does reach a "server" tears it straight back down, so the
    // SIGINT/SIGTERM listeners it registers do not accumulate across tests.
    onReady: (ctx) => ctx.shutdown(),
  });
  return { logs, errors, code, started };
}

describe("aimock short-flag rule: -h is --help on every surface", () => {
  // The rule: within the `aimock` bin a short flag means the same thing at the
  // top level and in every subcommand. `-h` was bound to `--host` at the top
  // level while `convert` and `validate` both read it as `--help`, so `aimock
  // -h` failed with "Option '-h, --host <value>' argument missing" while
  // `aimock validate -h` printed help. (`llmock`, src/cli.ts, is a separate
  // bin with its own documented set and keeps `-h` = `--host`.)
  it("prints the top-level help for -h, exactly as for --help", () => {
    const short = surface(["-h"]);
    const long = surface(["--help"]);
    expect(short.code).toBe(0);
    expect(short.errors).toEqual([]);
    expect(short.logs.join("\n")).toContain("Usage: aimock [options]");
    expect(short.logs).toEqual(long.logs);
    expect(short.started).not.toHaveBeenCalled();
  });

  it("reads -h the same way in the top level, convert and validate", () => {
    const top = surface(["-h"]);
    const convert = surface(["convert", "-h"]);
    const validate = surface(["validate", "-h"]);
    for (const r of [top, convert, validate]) {
      expect(r.code).toBe(0);
      expect(r.logs.join("\n")).toContain("Usage: aimock");
    }
    // Each prints ITS OWN help, which is the point of agreeing on the flag.
    expect(convert.logs.join("\n")).toContain("aimock convert");
    expect(validate.logs.join("\n")).toContain("aimock validate");
  });

  it("documents --host without a short alias and -h as help", () => {
    const help = surface(["--help"]).logs.join("\n");
    expect(help).toContain("      --host <string>");
    expect(help).toContain("  -h, --help");
    expect(help).not.toContain("-h, --host");
  });

  it("no longer takes a host value after -h, instead of binding it silently", () => {
    // Someone carrying `-h 0.0.0.0` over from the llmock bin gets a usage
    // error, not a server quietly bound to every interface.
    const r = surface(["--config", "/c.json", "-h", "0.0.0.0"]);
    expect(r.code).toBe(1);
    expect(r.started).not.toHaveBeenCalled();
  });

  it("still accepts the long --host", () => {
    const r = surface(["--config", "/c.json", "--host", "0.0.0.0"]);
    expect(r.code).toBe(null);
    expect(r.errors).toEqual([]);
  });
});

describe("aimock: an option GIVEN an empty value is a usage error", () => {
  // Truthiness testing made `--port ""` and `--host ""` indistinguishable from
  // "not given": the port was dropped (the server took its default) and the
  // empty host reached the bind as "", which listens on EVERY interface rather
  // than the documented 127.0.0.1.
  const emptyValueCases: { name: string; argv: string[] }[] = [
    { name: "port", argv: ["--config", "/c.json", "--port", ""] },
    { name: "host", argv: ["--config", "/c.json", "--host", ""] },
    { name: "config", argv: ["--config", ""] },
  ];
  for (const { name, argv } of emptyValueCases) {
    it(`rejects --${name} with an empty value, naming the option`, () => {
      const r = surface(argv);
      expect(r.code).toBe(1);
      expect(r.errors.join("\n")).toContain(`Error: --${name} requires a non-empty value.`);
      expect(r.started).not.toHaveBeenCalled();
    });
  }

  it("rejects a whitespace-only value too", () => {
    const r = surface(["--config", "/c.json", "--port", "  "]);
    expect(r.code).toBe(1);
    expect(r.errors.join("\n")).toContain("Error: --port requires a non-empty value.");
    expect(r.started).not.toHaveBeenCalled();
  });

  it("still treats an ABSENT option as absent", () => {
    const r = surface(["--config", "/c.json"]);
    expect(r.errors).toEqual([]);
    expect(r.code).toBe(null);
  });
});

const CJS_CLI_PATH = resolve(__dirname, "../../dist/aimock-cli.cjs");

describe.skipIf(!existsSync(CJS_CLI_PATH))("aimock: the compiled CJS entry runs itself", () => {
  // tsdown builds src/aimock-cli.ts in both "esm" and "cjs" format, so the
  // package ships dist/aimock-cli.js AND dist/aimock-cli.cjs, both with a
  // shebang and the exec bit. The entry guard listed only the .js, so running
  // the .cjs loaded the module, matched nothing, and exited 0 in silence.
  it("prints help from dist/aimock-cli.cjs, as dist/aimock-cli.js does", async () => {
    const cjs = await new Promise<{ stdout: string; code: number | null }>((res) => {
      const cp = execFile("node", [CJS_CLI_PATH, "--help"], { timeout: 10_000 }, (_e, stdout) => {
        res({ stdout, code: cp.exitCode });
      });
    });
    expect(cjs.code).toBe(0);
    expect(cjs.stdout).toContain("Usage: aimock [options]");

    const esm = await runCli(["--help"]);
    expect(esm.stdout).toBe(cjs.stdout);
  });
});
