import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createServer as createHttpServer, type Server } from "node:http";
import {
  existsSync,
  statSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  openSync,
  closeSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AddressInfo } from "node:net";
import { createHash } from "node:crypto";

const CLI_PATH = resolve(__dirname, "../../dist/cli.js");
const CLI_SOURCE = resolve(__dirname, "../cli.ts");
const CLI_AVAILABLE = existsSync(CLI_PATH);

/**
 * These tests exercise the BUILT CLI, and `pnpm test` does not build. A dist older than
 * the source is a different program: a test of behaviour that only exists in the source
 * then reports the very bug it was written to detect, and the report is about the build,
 * not the code. Say so instead, for any test whose verdict depends on that distinction.
 */
function assertBuiltCliIsCurrent(): void {
  const builtAt = statSync(CLI_PATH).mtimeMs;
  const editedAt = statSync(CLI_SOURCE).mtimeMs;
  if (builtAt < editedAt) {
    throw new Error(
      `dist/cli.js was built before src/cli.ts was last edited — run \`pnpm build\`. ` +
        `This test exercises the built artifact, so its result would describe the stale ` +
        `build rather than the current source.`,
    );
  }
}

// CLI integration tests use child processes and file watchers. Give healthy
// children time to be scheduled while the full parallel suite is busy.
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
function spawnCli(args: string[]): {
  cp: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  kill: (signal?: NodeJS.Signals) => void;
  waitForOutput: (match: RegExp, timeoutMs?: number) => Promise<void>;
  waitForExit: () => Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
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

  // Record the exit eagerly, at spawn time. A caller that attaches its own "close"
  // listener after kill() can miss the event and then wait out the whole test timeout,
  // which reports as a timeout rather than as the exit that actually happened.
  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  const exitWaiters: ((r: { code: number | null; signal: NodeJS.Signals | null }) => void)[] = [];
  cp.on("close", (code, signal) => {
    exited = { code, signal };
    for (const w of exitWaiters) w(exited);
    exitWaiters.length = 0;
  });
  const waitForExit = (): Promise<{ code: number | null; signal: NodeJS.Signals | null }> =>
    exited ? Promise.resolve(exited) : new Promise((resolve) => exitWaiters.push(resolve));

  const waitForOutput = (match: RegExp, timeoutMs = 10_000): Promise<void> =>
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
    waitForExit,
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
    expect(stdout).toContain("Usage: aimock");
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

  it("rejects --chaos-drop 0.5abc (trailing garbage, not a full number)", async () => {
    // parseFloat would have accepted this as 0.5. Chaos input is parsed the
    // same reject-never-clamp way at every source — see `ChaosConfig`.
    const { stderr, code } = await runCli(["--chaos-drop", "0.5abc"]);
    expect(stderr).toContain("Invalid chaos-drop");
    expect(code).toBe(1);
  });

  it("rejects --chaos-latency Infinity", async () => {
    const { stderr, code } = await runCli(["--chaos-latency", "Infinity"]);
    expect(stderr).toContain("Invalid chaos-latency");
    expect(code).toBe(1);
  });

  it("rejects --chunk-size 0 (below minimum)", async () => {
    const { stderr, code } = await runCli(["--chunk-size", "0"]);
    expect(stderr).toContain("Invalid chunk-size");
    expect(code).toBe(1);
  });

  it("rejects --journal-max=-5 (negative)", async () => {
    const { stderr, code } = await runCli(["--journal-max=-5"]);
    expect(stderr).toContain("Invalid journal-max");
    expect(stderr).toContain("non-negative");
    expect(code).toBe(1);
  });

  it("rejects --journal-max=-1 (negative)", async () => {
    const { stderr, code } = await runCli(["--journal-max=-1"]);
    expect(stderr).toContain("Invalid journal-max");
    expect(code).toBe(1);
  });

  it("rejects --journal-max 1.5 (non-integer)", async () => {
    const { stderr, code } = await runCli(["--journal-max", "1.5"]);
    expect(stderr).toContain("Invalid journal-max");
    expect(code).toBe(1);
  });

  it("rejects --fixture-counts-max=-1 (negative)", async () => {
    const { stderr, code } = await runCli(["--fixture-counts-max=-1"]);
    expect(stderr).toContain("Invalid fixture-counts-max");
    expect(stderr).toContain("non-negative");
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

    // Assert on the exit OUTSIDE the event callback, and on the signal as well as the
    // code. A bare `expect(code).toBe(0)` inside the callback reports the useless
    // "expected null to be +0" and then also hangs the test until the suite timeout,
    // because the throw prevents the promise from ever resolving. `signal` is the
    // datum that names the cause: SIGTERM means the CLI never ran its own handler.
    await expect(child.waitForExit()).resolves.toEqual({ code: 0, signal: null });
  });

  /*
   * The CLI must not advertise readiness before it can act on the signal that
   * advertisement invites.  Writes to a file are synchronous on POSIX (as are writes to
   * a pipe on Linux, which is what CI uses), so a supervisor polling for the readiness
   * line can deliver SIGTERM while the CLI is still mid-statement.  If the SIGTERM
   * listener is not installed yet, the signal reaches Node's default disposition, which
   * re-raises it: the process dies with code === null / signal === "SIGTERM" and never
   * runs its own shutdown.
   *
   * SIGSTOP pins the child at exactly the instant it announced readiness, which is the
   * same state a preempted process is in on a loaded CI runner — it makes the window
   * observable instead of leaving it to a race.  With the listener registered after the
   * announcement, one attempt catches the bug a little under half the time when measured
   * from inside the running suite (10 of 23 attempts over ten runs), so twelve attempts
   * miss it about once in a thousand runs; with the listener registered first, no attempt
   * can fail, because the write of the line polled for below happens after the
   * registration and stdout is synchronous.
   *
   * Scope: from the announcement onward, which is the only moment a supervisor can act
   * on.  A SIGTERM delivered BEFORE readiness — while the server is still binding — is
   * still fatal (code null / signal SIGTERM, no "Shutting down..."), and nothing here
   * claims otherwise.
   */
  it.skipIf(process.platform === "win32")(
    "handles a SIGTERM delivered at or after the instant readiness is announced",
    async () => {
      assertBuiltCliIsCurrent();
      const fixturePath = writeFixture(tmpDir, "test.json");

      for (let attempt = 0; attempt < 12; attempt++) {
        const outFile = join(tmpDir, `announce-${attempt}.log`);
        writeFileSync(outFile, "");
        const fd = openSync(outFile, "a");
        const cp = spawn("node", [CLI_PATH, "--fixtures", fixturePath, "--port", "0"], {
          stdio: ["ignore", fd, fd],
        });
        closeSync(fd);

        const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (resolve) => cp.on("exit", (code, signal) => resolve({ code, signal })),
        );

        try {
          const deadline = Date.now() + 10_000;
          while (!/listening on/i.test(readFileSync(outFile, "utf-8"))) {
            if (Date.now() > deadline) {
              throw new Error(`CLI never announced readiness: ${readFileSync(outFile, "utf-8")}`);
            }
            await new Promise((r) => setImmediate(r));
          }
          cp.kill("SIGSTOP");
          cp.kill("SIGTERM");
          cp.kill("SIGCONT");
        } catch (e) {
          // Never leave a frozen child behind for the suite to trip over.
          cp.kill("SIGCONT");
          cp.kill("SIGKILL");
          throw e;
        }

        const { code, signal } = await exited;
        const output = readFileSync(outFile, "utf-8");
        expect({ attempt, code, signal }).toEqual({ attempt, code: 0, signal: null });
        expect(output).toContain("Shutting down...");
      }
    },
  );

  it("fails with error when --fixtures points to a non-existent path", async () => {
    const { stderr, code } = await runCli(["--fixtures", "/nonexistent/path/to/fixtures"]);
    expect(stderr).toContain("Fixtures path not found");
    expect(code).toBe(1);
  });
});

describe.skipIf(!CLI_AVAILABLE)("CLI: --log-level", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("--log-level silent suppresses startup output", async () => {
    const fixturePath = writeFixture(tmpDir, "test.json");
    const child = spawnCli(["--fixtures", fixturePath, "--port", "0", "--log-level", "silent"]);

    // Wait for the server to be ready (listen on port)
    // With silent, there should be no [aimock] output
    await new Promise((r) => setTimeout(r, 1500));

    const stdout = child.stdout();
    expect(stdout).not.toContain("[aimock]");

    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      child.cp.on("close", () => resolve());
    });
  });

  it("--log-level info shows startup messages", async () => {
    const fixturePath = writeFixture(tmpDir, "test.json");
    const child = spawnCli(["--fixtures", fixturePath, "--port", "0", "--log-level", "info"]);

    await child.waitForOutput(/listening on/i, 5000);
    expect(child.stdout()).toContain("[aimock]");
    expect(child.stdout()).toContain("Loaded 1 fixture(s)");

    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      child.cp.on("close", () => resolve());
    });
  });

  it("--log-level debug starts successfully", async () => {
    const fixturePath = writeFixture(tmpDir, "test.json");
    const child = spawnCli(["--fixtures", fixturePath, "--port", "0", "--log-level", "debug"]);

    await child.waitForOutput(/listening on/i, 5000);
    expect(child.stdout()).toContain("[aimock]");

    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      child.cp.on("close", () => resolve());
    });
  });

  it("rejects invalid --log-level value", async () => {
    const { stderr, code } = await runCli(["--log-level", "verbose"]);
    expect(stderr).toContain("Invalid log-level");
    expect(code).toBe(1);
  });
});

describe.skipIf(!CLI_AVAILABLE)("CLI: --strict-tool-arguments", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Invalid JSON tool arguments on Gemini (an object-arguments wire).
  async function geminiStatus(flags: string[]): Promise<{ status: number; body: string }> {
    assertBuiltCliIsCurrent();
    const fixturePath = join(tmpDir, "bad-args.json");
    writeFileSync(
      fixturePath,
      JSON.stringify({
        fixtures: [
          {
            match: { userMessage: "hello" },
            response: { toolCalls: [{ name: "lookup", arguments: '{"city":' }] },
          },
        ],
      }),
    );
    const child = spawnCli(["--fixtures", fixturePath, "--port", "0", ...flags]);
    try {
      await child.waitForOutput(/listening on/i, 5000);
      const url = /listening on (http:\/\/\S+)/i.exec(child.stdout())![1];
      const res = await fetch(`${url}/v1beta/models/gemini-2.0-flash:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hello" }] }] }),
      });
      return { status: res.status, body: await res.text() };
    } finally {
      child.kill("SIGTERM");
      await child.waitForExit();
    }
  }

  it("serves invalid JSON tool arguments as {} without the flag", async () => {
    const { status, body } = await geminiStatus([]);
    expect(status).toBe(200);
    expect(JSON.parse(body).candidates[0].content.parts[0].functionCall.args).toEqual({});
  });

  it("rejects invalid JSON tool arguments with the flag", async () => {
    const { status, body } = await geminiStatus(["--strict-tool-arguments"]);
    expect(status).toBe(500);
    expect(body).toContain("invalid JSON arguments");
  });
});

describe.skipIf(!CLI_AVAILABLE)("CLI: --validate-on-load", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("passes validation for valid fixtures", async () => {
    const fixturePath = writeFixture(tmpDir, "test.json");
    const child = spawnCli(["--fixtures", fixturePath, "--port", "0", "--validate-on-load"]);

    await child.waitForOutput(/listening on/i, 5000);
    expect(child.stderr()).not.toContain("Validation failed");

    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      child.cp.on("close", () => resolve());
    });
  });

  it("exits 1 on invalid fixture (empty content)", async () => {
    const filePath = join(tmpDir, "bad.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        fixtures: [
          {
            match: { userMessage: "hello" },
            response: { content: "" },
          },
        ],
      }),
      "utf-8",
    );

    const { stderr, code } = await runCli(["--fixtures", filePath, "--validate-on-load"]);
    expect(stderr).toContain("Validation failed");
    expect(code).toBe(1);
  });

  it("exits 1 on invalid fixture (unparseable toolCalls arguments)", async () => {
    const filePath = join(tmpDir, "bad-tool.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        fixtures: [
          {
            match: { userMessage: "weather" },
            response: {
              toolCalls: [{ name: "get_weather", arguments: "not json" }],
            },
          },
        ],
      }),
      "utf-8",
    );

    const { stderr, code } = await runCli(["--fixtures", filePath, "--validate-on-load"]);
    expect(stderr).toContain("Validation failed");
    expect(code).toBe(1);
  });
});

describe.skipIf(!CLI_AVAILABLE)("CLI: --watch", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("survives invalid JSON during reload", async () => {
    const fixturePath = writeFixture(tmpDir, "test.json");
    const child = spawnCli(["--fixtures", fixturePath, "--port", "0", "--watch"]);

    await child.waitForOutput(/listening on/i, 5000);

    // Write invalid JSON
    writeFileSync(fixturePath, "{ not valid json", "utf-8");

    // Wait for the reload attempt — server should stay up
    await new Promise((r) => setTimeout(r, 1500));

    // Server should still be running (not crashed)
    expect(child.cp.exitCode).toBeNull();

    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      child.cp.on("close", () => resolve());
    });
  });

  it("reloads fixtures when file changes", async () => {
    const fixturePath = writeFixture(tmpDir, "test.json");
    const child = spawnCli(["--fixtures", fixturePath, "--port", "0", "--watch"]);

    // The watcher is started AFTER the readiness line is logged, so waiting for
    // "listening on" and then asserting "Watching" is already present races the child.
    // Wait for the line that actually marks the watcher as up.
    await child.waitForOutput(/Watching/i, 5000);

    // Modify the fixture file
    writeFileSync(
      fixturePath,
      JSON.stringify({
        fixtures: [
          {
            match: { userMessage: "goodbye" },
            response: { content: "Bye!" },
          },
        ],
      }),
      "utf-8",
    );

    // Wait for reload
    await child.waitForOutput(/Reloaded/i, 5000);
    expect(child.stdout()).toContain("Reloaded 1 fixture(s)");

    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      child.cp.on("close", () => resolve());
    });
  });
});

/* ================================================================== */
/* Remote --fixtures URL support                                       */
/* ================================================================== */

interface HttpHandle {
  server: Server;
  url: string;
  close: () => Promise<void>;
}

function startHttpServer(
  handler: (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ) => void,
): Promise<HttpHandle> {
  return new Promise((res) => {
    const server = createHttpServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      res({
        server,
        url: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

const REMOTE_FIXTURE_BODY = JSON.stringify({
  fixtures: [
    {
      match: { userMessage: "hello-remote" },
      response: { content: "Hello from remote fixture" },
    },
  ],
});

describe.skipIf(!CLI_AVAILABLE)("CLI: remote --fixtures URLs", () => {
  let cacheDir: string;
  let envBackup: string | undefined;
  let allowPrivateBackup: string | undefined;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "aimock-cli-remote-cache-"));
    envBackup = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = cacheDir;
    // The remote-fixture SSRF denylist rejects 127.0.0.1 by default; these
    // tests fetch from local http servers, so opt in for the subprocess.
    allowPrivateBackup = process.env.AIMOCK_ALLOW_PRIVATE_URLS;
    process.env.AIMOCK_ALLOW_PRIVATE_URLS = "1";
  });

  afterEach(() => {
    if (envBackup === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = envBackup;
    if (allowPrivateBackup === undefined) delete process.env.AIMOCK_ALLOW_PRIVATE_URLS;
    else process.env.AIMOCK_ALLOW_PRIVATE_URLS = allowPrivateBackup;
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("loads fixtures from an https-style URL served by a local HTTP server", async () => {
    const server = await startHttpServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(REMOTE_FIXTURE_BODY);
      }, 50);
    });
    try {
      const child = spawnCli(["--fixtures", `${server.url}/fx.json`, "--port", "0"]);
      await child.waitForOutput(/listening on/i, 8000);
      expect(child.stdout()).toContain("Loaded 1 fixture(s)");
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        child.cp.on("close", () => resolve());
      });
    } finally {
      await server.close();
    }
  });

  it("exits non-zero when upstream returns 500 and no cache exists under --validate-on-load", async () => {
    const server = await startHttpServer((_req, res) => {
      res.writeHead(500);
      res.end("nope");
    });
    try {
      const { stderr, code } = await runCli(
        ["--fixtures", `${server.url}/fx.json`, "--port", "0", "--validate-on-load"],
        { timeout: 10000 },
      );
      expect(stderr).toMatch(/Failed to resolve --fixtures value/);
      expect(stderr).toMatch(/HTTP 500/);
      expect(code).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("falls back to cached copy and warns when upstream returns 500 under --validate-on-load", async () => {
    const server = await startHttpServer((_req, res) => {
      res.writeHead(500);
      res.end("nope");
    });
    try {
      const url = `${server.url}/fx.json`;
      // Pre-seed the cache using the same sha256(url) layout as the helper.
      const digest = createHash("sha256").update(url).digest("hex");
      const cachedDir = join(cacheDir, "aimock", "fixtures", digest);
      mkdirSync(cachedDir, { recursive: true });
      writeFileSync(join(cachedDir, "fixtures.json"), REMOTE_FIXTURE_BODY, "utf-8");

      const child = spawnCli(["--fixtures", url, "--port", "0", "--validate-on-load"]);
      await child.waitForOutput(/listening on/i, 8000);
      expect(child.stdout() + child.stderr()).toMatch(/using cached copy/);
      expect(child.stdout()).toContain("Loaded 1 fixture(s)");
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        child.cp.on("close", () => resolve());
      });
    } finally {
      await server.close();
    }
  });

  it("rejects non-http(s) schemes (e.g. file://) with a clear error", async () => {
    const { stderr, code } = await runCli(
      ["--fixtures", "file:///tmp/does-not-matter.json", "--port", "0"],
      { timeout: 5000 },
    );
    expect(stderr).toMatch(/Unsupported --fixtures URL scheme "file"/);
    expect(code).toBe(1);
  });

  it("still supports a plain filesystem path (regression guard)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "cli-path-regression-"));
    try {
      const fp = join(tmp, "local.json");
      writeFileSync(fp, REMOTE_FIXTURE_BODY, "utf-8");
      const child = spawnCli(["--fixtures", fp, "--port", "0"]);
      await child.waitForOutput(/listening on/i, 5000);
      expect(child.stdout()).toContain("Loaded 1 fixture(s)");
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        child.cp.on("close", () => resolve());
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("loads multiple --fixtures URLs and preserves argv load order", async () => {
    // Fixture A responds to userMessage "alpha"; fixture B responds to "beta".
    // Both are passed via repeatable --fixtures; both should be loaded and
    // the count should reflect argv order (2 fixtures, A first then B).
    const bodyA = JSON.stringify({
      fixtures: [
        {
          match: { userMessage: "alpha" },
          response: { content: "from A" },
        },
      ],
    });
    const bodyB = JSON.stringify({
      fixtures: [
        {
          match: { userMessage: "beta" },
          response: { content: "from B" },
        },
      ],
    });
    const serverA = await startHttpServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(bodyA);
    });
    const serverB = await startHttpServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(bodyB);
    });
    try {
      const urlA = `${serverA.url}/a.json`;
      const urlB = `${serverB.url}/b.json`;
      const child = spawnCli([
        "--fixtures",
        urlA,
        "--fixtures",
        urlB,
        "--port",
        "0",
        "--log-level",
        "info",
      ]);
      await child.waitForOutput(/listening on/i, 8000);
      // Both fixtures loaded and counted.
      expect(child.stdout()).toContain("Loaded 2 fixture(s)");
      // Both source URLs appear in the "Loaded N fixture(s) from ..." log line —
      // verifying argv order: A listed before B.
      const loadedLine = child
        .stdout()
        .split("\n")
        .find((l) => l.includes("Loaded 2 fixture(s)"));
      expect(loadedLine).toBeDefined();
      const idxA = loadedLine!.indexOf(urlA);
      const idxB = loadedLine!.indexOf(urlB);
      expect(idxA).toBeGreaterThan(-1);
      expect(idxB).toBeGreaterThan(idxA);
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        child.cp.on("close", () => resolve());
      });
    } finally {
      await serverA.close();
      await serverB.close();
    }
  });
});

/* ================================================================== */
/* --proxy-only with URL-only --fixtures (v1.14.8 regression)          */
/* ================================================================== */

describe.skipIf(!CLI_AVAILABLE)("CLI: --proxy-only with URL-only --fixtures", () => {
  let cacheDir: string;
  let envBackup: string | undefined;
  let allowPrivateBackup: string | undefined;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "aimock-cli-proxy-url-cache-"));
    envBackup = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = cacheDir;
    // Remote-fixture SSRF denylist rejects 127.0.0.1 by default.
    allowPrivateBackup = process.env.AIMOCK_ALLOW_PRIVATE_URLS;
    process.env.AIMOCK_ALLOW_PRIVATE_URLS = "1";
  });

  afterEach(() => {
    if (envBackup === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = envBackup;
    if (allowPrivateBackup === undefined) delete process.env.AIMOCK_ALLOW_PRIVATE_URLS;
    else process.env.AIMOCK_ALLOW_PRIVATE_URLS = allowPrivateBackup;
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("starts successfully with --proxy-only and a URL-only --fixtures source", async () => {
    const fixtureServer = await startHttpServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(REMOTE_FIXTURE_BODY);
    });
    // Dummy upstream provider target — proxy-only never proxies unmatched reqs in this test,
    // but --provider-openai must be set so the recordConfig gate accepts the invocation.
    const upstream = await startHttpServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    try {
      const child = spawnCli([
        "--proxy-only",
        "--provider-openai",
        upstream.url,
        "--fixtures",
        `${fixtureServer.url}/fx.json`,
        "--port",
        "0",
      ]);
      await child.waitForOutput(/listening on/i, 8000);
      // Must load the remote fixture and NOT error with the recordBase URL message.
      expect(child.stdout()).toContain("Loaded 1 fixture(s)");
      expect(child.stderr()).not.toMatch(
        /requires a local --fixtures path for the recording destination/,
      );
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        child.cp.on("close", () => resolve());
      });
    } finally {
      await fixtureServer.close();
      await upstream.close();
    }
  });

  it("preserves --record rejection of URL-only --fixtures (regression guard)", async () => {
    // --record writes to disk, so a URL source is genuinely unsupported. Must still error.
    const { stderr, code } = await runCli(
      [
        "--record",
        "--provider-openai",
        "http://127.0.0.1:59999",
        "--fixtures",
        "http://127.0.0.1:59998/fx.json",
        "--port",
        "0",
      ],
      { timeout: 5000 },
    );
    expect(stderr).toMatch(/requires a local --fixtures path for the recording destination/);
    expect(code).toBe(1);
  });

  it("accepts --proxy-only with mixed local + URL --fixtures", async () => {
    const fixtureServer = await startHttpServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(REMOTE_FIXTURE_BODY);
    });
    const upstream = await startHttpServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    const tmp = mkdtempSync(join(tmpdir(), "cli-mixed-fixtures-"));
    try {
      const localPath = join(tmp, "local.json");
      writeFileSync(
        localPath,
        JSON.stringify({
          fixtures: [{ match: { userMessage: "local" }, response: { content: "local response" } }],
        }),
        "utf-8",
      );
      const child = spawnCli([
        "--proxy-only",
        "--provider-openai",
        upstream.url,
        "--fixtures",
        localPath,
        "--fixtures",
        `${fixtureServer.url}/fx.json`,
        "--port",
        "0",
      ]);
      await child.waitForOutput(/listening on/i, 8000);
      expect(child.stdout()).toContain("Loaded 2 fixture(s)");
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        child.cp.on("close", () => resolve());
      });
    } finally {
      await fixtureServer.close();
      await upstream.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("starts successfully with --agui-proxy-only and URL-only --fixtures", async () => {
    const fixtureServer = await startHttpServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(REMOTE_FIXTURE_BODY);
    });
    const aguiUpstream = await startHttpServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    try {
      const child = spawnCli([
        "--agui-proxy-only",
        "--agui-upstream",
        aguiUpstream.url,
        "--fixtures",
        `${fixtureServer.url}/fx.json`,
        "--port",
        "0",
      ]);
      await child.waitForOutput(/listening on/i, 8000);
      expect(child.stdout()).toContain("Loaded 1 fixture(s)");
      expect(child.stderr()).not.toMatch(
        /requires a local --fixtures path for the recording destination/,
      );
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        child.cp.on("close", () => resolve());
      });
    } finally {
      await fixtureServer.close();
      await aguiUpstream.close();
    }
  });
});

/* ================================================================== */
/* --provider-openrouter (OpenRouter video record upstream)            */
/* ================================================================== */

describe.skipIf(!CLI_AVAILABLE)("CLI: --provider-openrouter", () => {
  it("--help lists --provider-openrouter", async () => {
    const { stdout, code } = await runCli(["--help"]);
    expect(stdout).toContain("--provider-openrouter");
    expect(code).toBe(0);
  });

  it("--record --provider-openrouter satisfies the provider gate and boots", async () => {
    const tmp = makeTmpDir();
    try {
      writeFixture(tmp, "fx.json");
      const child = spawnCli([
        "--record",
        "--provider-openrouter",
        "http://127.0.0.1:59997",
        "--fixtures",
        tmp,
        "--port",
        "0",
      ]);
      await child.waitForOutput(/listening on/i, 8000);
      expect(child.stderr()).not.toMatch(/requires at least one --provider-\* flag/);
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        child.cp.on("close", () => resolve());
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!CLI_AVAILABLE)("CLI: timeout flags without record/proxy-only", () => {
  it("warns when --upstream-timeout-ms is passed without --record/--proxy-only", async () => {
    const tmp = makeTmpDir();
    try {
      writeFixture(tmp, "fx.json");
      const child = spawnCli(["--upstream-timeout-ms", "5000", "--fixtures", tmp, "--port", "0"]);
      await child.waitForOutput(/upstream-timeout-ms.*--record/i, 8000);
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        child.cp.on("close", () => resolve());
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("warns when --body-timeout-ms is passed without --record/--proxy-only", async () => {
    const tmp = makeTmpDir();
    try {
      writeFixture(tmp, "fx.json");
      const child = spawnCli(["--body-timeout-ms", "5000", "--fixtures", tmp, "--port", "0"]);
      await child.waitForOutput(/body-timeout-ms.*--record/i, 8000);
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        child.cp.on("close", () => resolve());
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("warns when a --provider-* flag is passed without --record/--proxy-only", async () => {
    const tmp = makeTmpDir();
    try {
      writeFixture(tmp, "fx.json");
      // Same parsed-then-dropped class as the timeout flags: a provider URL
      // without --record/--proxy-only configures nothing.
      const child = spawnCli([
        "--provider-openrouter",
        "http://127.0.0.1:59995",
        "--fixtures",
        tmp,
        "--port",
        "0",
      ]);
      await child.waitForOutput(/provider-openrouter.*--record/i, 8000);
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        child.cp.on("close", () => resolve());
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not warn when a --provider-* flag accompanies --record", async () => {
    const tmp = makeTmpDir();
    try {
      writeFixture(tmp, "fx.json");
      const child = spawnCli([
        "--record",
        "--provider-openrouter",
        "http://127.0.0.1:59994",
        "--fixtures",
        tmp,
        "--port",
        "0",
      ]);
      await child.waitForOutput(/listening on/i, 8000);
      // Absence asserted with the SAME pattern the positive test uses.
      expect(child.stderr() + child.stdout()).not.toMatch(/provider-openrouter.*--record/i);
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        child.cp.on("close", () => resolve());
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not warn when the timeout flags accompany --record", async () => {
    const tmp = makeTmpDir();
    try {
      writeFixture(tmp, "fx.json");
      const child = spawnCli([
        "--record",
        "--provider-openrouter",
        "http://127.0.0.1:59996",
        "--upstream-timeout-ms",
        "5000",
        "--fixtures",
        tmp,
        "--port",
        "0",
      ]);
      await child.waitForOutput(/listening on/i, 8000);
      // Absence asserted with the SAME pattern family the positive tests
      // use, so a reworded warn cannot silently pass this negative check.
      expect(child.stderr() + child.stdout()).not.toMatch(/upstream-timeout-ms.*--record/i);
      expect(child.stderr() + child.stdout()).not.toMatch(/body-timeout-ms.*--record/i);
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        child.cp.on("close", () => resolve());
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
