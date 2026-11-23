/**
 * A REAL upstream MCP server for recorder tests: server-everything
 * (Streamable HTTP, sessions, SSE answers) as a child process on a free port.
 * Its environment is scrubbed: `get-env` returns the whole process env.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { REPO_ROOT } from "./mcp-fakes-harness.js";

export const TEST_SECRET = "s3cr3t-value-123";

export interface UpstreamHandle {
  /** Endpoint URL, e.g. http://127.0.0.1:53111/mcp */
  url: string;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      s.close(() => (typeof a === "object" && a ? res(a.port) : rej(new Error("no port"))));
    });
  });
}

export async function startUpstream(timeoutMs = 30_000): Promise<UpstreamHandle> {
  const port = await freePort();
  const bin = resolve(
    REPO_ROOT,
    "node_modules/@modelcontextprotocol/server-everything/dist/index.js",
  );
  const cp: ChildProcess = spawn(process.execPath, [bin, "streamableHttp"], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      PORT: String(port),
      AIMOCK_TEST_SECRET: TEST_SECRET,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  cp.stdout?.setEncoding("utf8").on("data", (d: string) => (out += d));
  cp.stderr?.setEncoding("utf8").on("data", (d: string) => (out += d));
  await new Promise<void>((res, rej) => {
    const fail = (e: Error): void => {
      clearTimeout(t);
      clearInterval(check);
      if (cp.exitCode === null) cp.kill("SIGKILL");
      rej(e);
    };
    const t = setTimeout(() => fail(new Error(`upstream not ready:\n${out}`)), timeoutMs);
    const check = setInterval(() => {
      if (/listening on port/i.test(out)) {
        clearTimeout(t);
        clearInterval(check);
        res();
      }
    }, 50);
    cp.once("exit", (c) => fail(new Error(`upstream exited ${c}:\n${out}`)));
    cp.once("error", (e) => fail(new Error(`failed to spawn upstream: ${e.message}`)));
  });
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    stop: () =>
      new Promise((res) => {
        if (cp.exitCode !== null) return res();
        cp.once("exit", () => res());
        cp.kill("SIGTERM");
      }),
  };
}
