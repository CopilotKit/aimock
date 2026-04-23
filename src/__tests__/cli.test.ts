import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile, type ChildProcess } from "node:child_process";
import { createServer as createHttpServer, type Server } from "node:http";
import { existsSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AddressInfo } from "node:net";
import { createHash } from "node:crypto";

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

    await child.waitForOutput(/listening on/i, 5000);
    expect(child.stdout()).toContain("Watching");

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
