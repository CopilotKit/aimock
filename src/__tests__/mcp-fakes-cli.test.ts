/**
 * MCP fakes through the real CLI process (`node dist/cli.js`): spec F3, F5,
 * F11, L3, L7, L8, L9, R9, B12, W3 from the CLI.
 *
 * Every test spawns the built CLI and, where a server comes up, talks to it
 * with a real `@modelcontextprotocol/sdk` v1 client over a real TCP port.
 * `pnpm test` does not build: these tests are skipped when `dist/cli.js` is
 * missing, and fail when it is older than `src/cli.ts`.
 *
 * Log streams: info lines are on stdout; warn and error lines are on stderr.
 *
 * Mount conflict (rule `mcp-fakes/mount-conflict`) is not tested here: on the
 * CLI path the only non-MCPMock mount is the AG-UI mount at `/agui`, which
 * exists only with `--agui-record`; without AG-UI the CLI passes no mounts, so
 * every `mcpFakes` mount path is free and is auto-mounted.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { loadFixturesFromDirWithServices } from "../fixture-loader-services.js";
import { FixtureLoadError } from "../fixture-loader.js";
import { McpFakesAddError } from "../mcp-fakes.js";
import { type CliHandle, REPO_ROOT, connectV1, startCli } from "./mcp-fakes-harness.js";

const CLI_PATH = resolve(REPO_ROOT, "dist/cli.js");
const CLI_SOURCE = resolve(REPO_ROOT, "src/cli.ts");
const CLI_AVAILABLE = existsSync(CLI_PATH);

function assertBuiltCliIsCurrent(): void {
  if (statSync(CLI_PATH).mtimeMs < statSync(CLI_SOURCE).mtimeMs) {
    throw new Error("dist/cli.js was built before src/cli.ts was last edited — run `pnpm build`.");
  }
}

const LLM_FIXTURE = {
  match: { userMessage: "hello" },
  response: { content: "Hi!" },
};

function sharedBlock(tool: string, results: string[]): Record<string, unknown> {
  return {
    scope: "shared",
    tools: [{ name: tool, calls: results.map((r) => ({ anyArgs: true, result: r })) }],
  };
}

/** Run the CLI to exit; for the cases where it must not start. */
function runToExit(
  args: string[],
  timeoutMs = 10_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((res, rej) => {
    const cp = spawn(process.execPath, [CLI_PATH, "--port", "0", ...args], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    cp.stdout.setEncoding("utf8");
    cp.stderr.setEncoding("utf8");
    cp.stdout.on("data", (d: string) => (stdout += d));
    cp.stderr.on("data", (d: string) => (stderr += d));
    const timer = setTimeout(() => {
      cp.kill("SIGKILL");
      rej(
        new Error(`CLI did not exit within ${timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`),
      );
    }, timeoutMs);
    cp.on("close", (code) => {
      clearTimeout(timer);
      res({ code, stdout, stderr });
    });
  });
}

function firstText(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null || !("content" in result)) return undefined;
  const content = result.content;
  if (!Array.isArray(content)) return undefined;
  const first: unknown = content[0];
  if (typeof first !== "object" || first === null || !("text" in first)) return undefined;
  return typeof first.text === "string" ? first.text : undefined;
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe.skipIf(!CLI_AVAILABLE)("CLI: MCP fakes", () => {
  let tmpDir: string;
  let cli: CliHandle | undefined;
  let client: Client | undefined;

  beforeEach(() => {
    assertBuiltCliIsCurrent();
    tmpDir = mkdtempSync(join(tmpdir(), "aimock-mcp-fakes-cli-"));
  });

  afterEach(async () => {
    await client?.close().catch(() => undefined);
    client = undefined;
    await cli?.stop();
    cli = undefined;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function write(name: string, body: unknown): string {
    const path = join(tmpDir, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body), "utf-8");
    return path;
  }

  it("W3: auto-mounts /mcp for --fixtures with mcpFakes and logs L4 on stdout", async () => {
    write("fakes/lookup.json", {
      fixtures: [LLM_FIXTURE],
      mcpFakes: sharedBlock("lookup", ["found it"]),
    });
    cli = await startCli(["--fixtures", join(tmpDir, "fakes")]);
    client = await connectV1(`${cli.url}/mcp`);
    const result = await client.callTool({ name: "lookup", arguments: {} });
    expect(firstText(result)).toBe("found it");
    expect(cli.stdout()).toContain('MCP fakes: auto-mounted an MCP mock at "/mcp"');
  }, 20_000);

  it("F3: a remote --fixtures URL carries mcpFakes, with the URL as the entry-id source", async () => {
    const body = JSON.stringify({ mcpFakes: sharedBlock("remote_tool", ["from remote"]) });
    const server: Server = createHttpServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/fakes.json`;
    try {
      cli = await startCli(["--fixtures", url], "dist/cli.js", {
        // The local server is on 127.0.0.1, which the SSRF guard rejects unless opted in.
        env: {
          ...process.env,
          XDG_CACHE_HOME: join(tmpDir, "cache"),
          AIMOCK_ALLOW_PRIVATE_URLS: "1",
        },
      });
      client = await connectV1(`${cli.url}/mcp`);
      const result = await client.callTool({ name: "remote_tool", arguments: {} });
      expect(firstText(result)).toBe("from remote");

      const res = await fetch(`${cli.url}/__aimock/journal`);
      const json: unknown = await res.json();
      const entries: unknown[] = Array.isArray(json)
        ? json
        : typeof json === "object" &&
            json !== null &&
            "entries" in json &&
            Array.isArray(json.entries)
          ? json.entries
          : [];
      const ids = entries
        .map((e) => JSON.stringify(e))
        .filter((s) => s.includes("mcpFake"))
        .join("\n");
      expect(ids).toContain(`${url}:remote_tool#0`);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 20_000);

  it("F5 + L9: a fakes-only start is not 'No fixtures loaded', even under --strict", async () => {
    write("only-fakes.json", { mcpFakes: sharedBlock("lookup", ["ok"]) });
    cli = await startCli(["--fixtures", join(tmpDir, "only-fakes.json"), "--strict"]);
    await waitFor(() => cli!.stderr().includes("No LLM fixtures"), "L9 warning");
    expect(cli.stderr()).toContain("No LLM fixtures loaded; LLM requests will return 404");
    expect(cli.stderr()).not.toContain("No fixtures loaded");
    client = await connectV1(`${cli.url}/mcp`);
    expect(firstText(await client.callTool({ name: "lookup", arguments: {} }))).toBe("ok");
  }, 20_000);

  it("F5 (positive control): with neither fixtures nor fakes the old message stays", async () => {
    write("empty/README.txt", "not a fixture");
    cli = await startCli(["--fixtures", join(tmpDir, "empty")]);
    await waitFor(() => cli!.stderr().includes("No fixtures loaded"), "old warning");
    expect(cli.stderr()).not.toContain("No LLM fixtures loaded");
  }, 20_000);

  it("L3/B12: a bad block exits non-zero under default flags and names file, block and rule", async () => {
    const path = write("bad.json", {
      fixtures: [LLM_FIXTURE],
      mcpFakes: { scope: "shared", tools: "not-a-list" },
    });
    const { code, stderr } = await runToExit(["--fixtures", path]);
    expect(code).not.toBe(0);
    expect(code).not.toBeNull();
    expect(stderr).toContain(path);
    expect(stderr).toMatch(/\[mcp-fakes\/bad-block:[a-j]\]/);
    expect(stderr).toContain("block");
    expect(stderr).not.toContain("listening on");
  });

  it("5.4 fail-loud under --log-level silent: a bad block still prints its error and exits non-zero", async () => {
    const path = write("bad-silent.json", {
      fixtures: [LLM_FIXTURE],
      mcpFakes: { tools: [{ name: "t", calls: [{ anyArgs: true, result: "r" }] }] },
    });
    const { code, stderr } = await runToExit(["--log-level", "silent", "--fixtures", path]);
    expect(code).not.toBe(0);
    expect(code).not.toBeNull();
    expect(stderr).toContain(path);
    expect(stderr).toContain("[mcp-fakes/bad-block:a]");
    expect(stderr).not.toContain("listening on");
  });

  it("L3: a directory with two bad blocks prints both errors, one line each, and exits non-zero", async () => {
    const dir = join(tmpDir, "two-bad");
    write("two-bad/blocks.json", {
      mcpFakes: [
        { scope: "shared", tools: "not-a-list" },
        { scope: "nope", tools: [{ name: "t", calls: [{ anyArgs: true, result: "r" }] }] },
      ],
    });
    let expected: readonly FixtureLoadError[] = [];
    try {
      loadFixturesFromDirWithServices(dir);
    } catch (err) {
      if (err instanceof McpFakesAddError) expected = err.errors;
    }
    expect(expected).toHaveLength(2);

    const { code, stderr } = await runToExit(["--fixtures", dir]);
    expect(code).not.toBe(0);
    expect(code).not.toBeNull();
    const lines = stderr.split("\n");
    for (const e of expected) expect(lines).toContain(e.message);
  });

  it("L8/C3: the shadowed-entry warning is printed once, with or without --validate-on-load", async () => {
    const block = {
      scope: "shared",
      tools: [
        {
          name: "pick",
          calls: [
            { anyArgs: true, result: "any" },
            { args: { x: 1 }, result: "one" },
          ],
        },
      ],
    };
    write("l8/shadow.json", { fixtures: [LLM_FIXTURE], mcpFakes: block });
    const needle = "is shadowed until the preceding anyArgs entry";

    // C3: printed once, by the hand-off, with or without --validate-on-load.
    for (const extra of [["--validate-on-load"], []]) {
      cli = await startCli(["--fixtures", join(tmpDir, "l8"), ...extra]);
      await waitFor(() => count(cli!.stderr(), needle) >= 1, "the L8 line");
      await waitFor(() => cli!.stdout().includes("listening on"), "readiness");
      expect(count(cli.stderr(), needle)).toBe(1);
      await cli.stop();
      cli = undefined;
    }
  }, 30_000);

  it("R9/L7: a --watch edit of mcpFakes is rejected, the old fakes keep answering; an LLM-only edit reloads", async () => {
    const original = { fixtures: [LLM_FIXTURE], mcpFakes: sharedBlock("seq", ["one", "two"]) };
    const path = write("watch.json", original);
    cli = await startCli(["--fixtures", path, "--watch"]);
    await waitFor(() => cli!.stdout().includes("Watching"), "watcher start");
    client = await connectV1(`${cli.url}/mcp`);
    expect(firstText(await client.callTool({ name: "seq", arguments: {} }))).toBe("one");

    write("watch.json", { ...original, mcpFakes: sharedBlock("seq", ["ONE", "TWO"]) });
    await waitFor(() => cli!.stderr().includes("mcp-fakes/watch-reload-changed"), "L7 error");
    expect(cli.stderr()).toContain(path);
    expect(cli.stdout()).not.toContain("Reloaded");
    expect(firstText(await client.callTool({ name: "seq", arguments: {} }))).toBe("two");

    write("watch.json", {
      fixtures: [LLM_FIXTURE, { match: { userMessage: "bye" }, response: { content: "Bye" } }],
      mcpFakes: original.mcpFakes,
    });
    await waitFor(() => cli!.stdout().includes("Reloaded 2 fixture(s)"), "LLM-only reload");
  }, 30_000);
  it("C4: a directory with a bad block in each of two files prints both errors and exits non-zero", async () => {
    const dir = join(tmpDir, "two-bad-files");
    write("two-bad-files/a.json", { mcpFakes: { scope: "shared", tools: "not-a-list" } });
    write("two-bad-files/b.json", {
      mcpFakes: { scope: "nope", tools: [{ name: "t", calls: [{ anyArgs: true, result: "r" }] }] },
    });
    const { code, stderr } = await runToExit(["--fixtures", dir]);
    expect(code).not.toBe(0);
    expect(code).not.toBeNull();
    expect(stderr).toContain('"a.json", block "a.json"');
    expect(stderr).toContain('"b.json", block "b.json"');
    expect(stderr).not.toContain("listening on");
  });

  it("C5: a file with exactly one error still prints its L8 warning", async () => {
    const path = write("one-error.json", {
      mcpFakes: [
        {
          scope: "shared",
          tools: [
            {
              name: "pick",
              calls: [
                { anyArgs: true, result: "any" },
                { args: { x: 1 }, result: "one" },
              ],
            },
          ],
        },
        { scope: "shared", tools: "not-a-list" },
      ],
    });
    const { code, stderr } = await runToExit(["--fixtures", path]);
    expect(code).not.toBe(0);
    expect(code).not.toBeNull();
    expect(stderr).toContain("[mcp-fakes/bad-block:g]");
    expect(stderr).toContain("is shadowed until the preceding anyArgs entry");
  });

  it("C1: a --watch reload that is not valid JSON reports the parse error, not changed mcpFakes", async () => {
    const original = { fixtures: [LLM_FIXTURE], mcpFakes: sharedBlock("seq", ["one"]) };
    const path = write("watch-parse.json", original);
    cli = await startCli(["--fixtures", path, "--watch"]);
    await waitFor(() => cli!.stdout().includes("Watching"), "watcher start");

    write("watch-parse.json", "{ not json");
    await waitFor(() => cli!.stderr().includes("Invalid JSON"), "parse error");
    await waitFor(
      () => /keeping previous fixtures|Previous fixtures remain active/.test(cli!.stderr()),
      "reload outcome",
    );
    expect(cli.stderr()).not.toContain("mcp-fakes/watch-reload-changed");
    expect(cli.stderr()).not.toContain("mcpFakes changed");
    client = await connectV1(`${cli.url}/mcp`);
    expect(firstText(await client.callTool({ name: "seq", arguments: {} }))).toBe("one");
  }, 30_000);

  it("C2: the L7 rejection is printed exactly once", async () => {
    const original = { fixtures: [LLM_FIXTURE], mcpFakes: sharedBlock("seq", ["one"]) };
    const path = write("watch-once.json", original);
    cli = await startCli(["--fixtures", path, "--watch"]);
    await waitFor(() => cli!.stdout().includes("Watching"), "watcher start");

    write("watch-once.json", { ...original, mcpFakes: sharedBlock("seq", ["ONE"]) });
    await waitFor(() => cli!.stderr().includes("Previous fixtures remain active"), "reload end");
    expect(count(cli.stderr(), "mcp-fakes/watch-reload-changed")).toBe(1);
    expect(count(cli.stderr(), "mcpFakes changed on --watch reload")).toBe(1);
  }, 30_000);

  it("C2: under --log-level silent the L7 rejection and a reload's bad block are each printed once", async () => {
    const original = { fixtures: [LLM_FIXTURE], mcpFakes: sharedBlock("seq", ["one"]) };
    const path = write("watch-silent.json", original);
    // Silent prints no readiness line, so startCli cannot be used: spawn, then
    // give the server and the watcher time to come up.
    const cp = spawn(
      process.execPath,
      [CLI_PATH, "--port", "0", "--log-level", "silent", "--fixtures", path, "--watch"],
      { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    cp.stderr.setEncoding("utf8");
    cp.stderr.on("data", (d: string) => (stderr += d));
    const exitCode = new Promise<number | null>((r) => cp.on("close", r));
    cli = {
      url: "",
      stdout: () => "",
      stderr: () => stderr,
      stop: async () => {
        if (cp.exitCode === null && cp.signalCode === null) cp.kill("SIGTERM");
        await exitCode;
      },
      exitCode,
    };
    await new Promise((r) => setTimeout(r, 2_000));

    write("watch-silent.json", { ...original, mcpFakes: sharedBlock("seq", ["ONE"]) });
    await waitFor(() => cli!.stderr().includes("mcp-fakes/watch-reload-changed"), "L7 error");

    write("watch-silent.json", { ...original, mcpFakes: { scope: "shared", tools: "x" } });
    await waitFor(() => cli!.stderr().includes("[mcp-fakes/bad-block:g]"), "reload bad block");
    await new Promise((r) => setTimeout(r, 1_000));
    expect(count(cli.stderr(), "mcp-fakes/watch-reload-changed")).toBe(1);
    expect(count(cli.stderr(), "[mcp-fakes/bad-block:g]")).toBe(1);
  }, 30_000);
});
