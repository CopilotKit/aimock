/**
 * Shared proof harness for the scenario-scoped MCP tool fakes tests.
 *
 * Every helper here drives a REAL surface: the built CLI as a child process,
 * and real MCP client SDKs (`@modelcontextprotocol/sdk` v1 and
 * `@modelcontextprotocol/client` v2) talking Streamable HTTP over a real TCP
 * port. Nothing here stubs the server or the client.
 *
 * Log streams: `Logger.info`/`debug` go to stdout, `warn`/`error` go to stderr
 * (src/logger.ts). Read the stream that matches the level you assert on.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  Client as ClientV2,
  ProtocolError,
  StreamableHTTPClientTransport as StreamableHTTPClientTransportV2,
} from "@modelcontextprotocol/client";

/** Repository root (this file lives in src/__tests__/). */
export const REPO_ROOT = resolve(__dirname, "../..");

/**
 * The whole "listening on" line, terminator included: a pipe can split the
 * line inside the URL, and a match on the first chunk would be a cut port.
 */
const LISTENING_RE = /aimock server listening on (http:\/\/\S+)\r?\n/;

/** How long `stop()` waits after SIGTERM before it sends SIGKILL. */
const STOP_GRACE_MS = 5_000;

export interface CliHandle {
  /** Base URL of the running server, e.g. `http://127.0.0.1:54321`. */
  url: string;
  /** Everything the CLI wrote to stdout so far (info/debug log lines). */
  stdout(): string;
  /** Everything the CLI wrote to stderr so far (warn/error log lines). */
  stderr(): string;
  /**
   * Send SIGTERM and wait for the process to exit; after `STOP_GRACE_MS`,
   * send SIGKILL and wait again. Safe to call twice.
   */
  stop(): Promise<void>;
  /** Resolves with the exit code (null when killed by a signal). */
  exitCode: Promise<number | null>;
}

/**
 * Spawn `node <bin> --port 0 ...args` and resolve once the CLI prints its
 * "aimock server listening on <url>" line. Rejects (with both streams in the
 * message) if the process exits first or the line does not appear in time.
 */
export function startCli(
  args: string[],
  bin = "dist/cli.js",
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<CliHandle> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const binPath = resolve(REPO_ROOT, bin);
  const fullArgs = args.includes("--port") ? args : ["--port", "0", ...args];
  const cp = spawn(process.execPath, [binPath, ...fullArgs], {
    cwd: REPO_ROOT,
    env: opts.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let out = "";
  let err = "";
  cp.stdout.setEncoding("utf8");
  cp.stderr.setEncoding("utf8");

  let exited = false;
  const exitCode = new Promise<number | null>((res) => {
    cp.on("close", (code) => {
      exited = true;
      res(code);
    });
  });

  const stop = async (): Promise<void> => {
    if (exited) return;
    cp.kill("SIGTERM");
    let grace: NodeJS.Timeout | undefined;
    const graceOver = new Promise<"grace over">((res) => {
      grace = setTimeout(() => res("grace over"), STOP_GRACE_MS);
    });
    const first = await Promise.race([exitCode, graceOver]);
    clearTimeout(grace);
    if (first === "grace over" && !exited) cp.kill("SIGKILL");
    await exitCode;
  };

  return new Promise<CliHandle>((res, rej) => {
    let settled = false;
    const fail = (why: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void stop().finally(() => {
        rej(new Error(`${why}\n--- cli stdout ---\n${out}\n--- cli stderr ---\n${err}`));
      });
    };
    const timer = setTimeout(
      () => fail(`aimock CLI did not report "listening on" within ${timeoutMs}ms`),
      timeoutMs,
    );
    const onData = () => {
      if (settled) return;
      const m = LISTENING_RE.exec(out) ?? LISTENING_RE.exec(err);
      if (!m) return;
      settled = true;
      clearTimeout(timer);
      res({ url: m[1], stdout: () => out, stderr: () => err, stop, exitCode });
    };
    cp.stdout.on("data", (d: string) => {
      out += d;
      onData();
    });
    cp.stderr.on("data", (d: string) => {
      err += d;
      onData();
    });
    cp.on("error", (e) => fail(`failed to spawn aimock CLI: ${e.message}`));
    void exitCode.then((code) => fail(`aimock CLI exited (code ${code}) before listening`));
  });
}

/** Connect a real v1 SDK client (`@modelcontextprotocol/sdk`) over Streamable HTTP. */
export async function connectV1(
  url: string,
  opts: { headers?: Record<string, string> } = {},
): Promise<Client> {
  const client = new Client({ name: "aimock-mcp-fakes-test-v1", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: opts.headers ? { headers: opts.headers } : undefined,
  });
  await client.connect(transport);
  return client;
}

/** Connect a real v2 client (`@modelcontextprotocol/client`) over Streamable HTTP. */
export async function connectV2(
  url: string,
  opts: { headers?: Record<string, string> } = {},
): Promise<ClientV2> {
  const client = new ClientV2({ name: "aimock-mcp-fakes-test-v2", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransportV2(new URL(url), {
    requestInit: opts.headers ? { headers: opts.headers } : undefined,
  });
  await client.connect(transport);
  return client;
}

/** Percent-encode a test id for a `?testId=` query parameter; the server decodes it. */
export function enc(id: string): string {
  return encodeURIComponent(id);
}

function aimockCodeOf(data: unknown): unknown {
  if (typeof data !== "object" || data === null || !("aimock" in data)) return undefined;
  const aimock = data.aimock;
  if (typeof aimock !== "object" || aimock === null || !("code" in aimock)) return undefined;
  return aimock.code;
}

/**
 * Assert that a client call THROWS a JSON-RPC protocol error (v1 `McpError`
 * or v2 `ProtocolError`) carrying `code` and `data.aimock.code`. Returns the
 * error's `data` for further assertions.
 */
export async function expectMcpError(
  promise: Promise<unknown>,
  want: { code: number; aimockCode: string },
): Promise<unknown> {
  let caught: unknown;
  let resolved: unknown;
  let threw = false;
  try {
    resolved = await promise;
  } catch (e) {
    threw = true;
    caught = e;
  }
  if (!threw) {
    throw new Error(
      `expected the MCP client to throw ${want.aimockCode} (${want.code}), but it resolved with ${JSON.stringify(resolved)}`,
    );
  }
  const isProtocolError = caught instanceof McpError || ProtocolError.isInstance(caught);
  expect(isProtocolError, `expected McpError/ProtocolError, got ${String(caught)}`).toBe(true);
  if (!(caught instanceof McpError) && !ProtocolError.isInstance(caught)) return undefined;
  expect(caught.code).toBe(want.code);
  expect(aimockCodeOf(caught.data)).toBe(want.aimockCode);
  return caught.data;
}
