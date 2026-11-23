/**
 * MCP fakes through the test plugins (spec F12, W2, W3, R6):
 * `useAimock({ fixtures })` from `src/vitest.ts` and `src/jest.ts`.
 *
 * Real surface: each plugin starts a real `LLMock` on a real TCP port, and a
 * real v1 MCP SDK client (`@modelcontextprotocol/sdk`) talks Streamable HTTP
 * to `${url}/mcp`. The "bad block fails beforeAll" checks spawn a real child
 * vitest run (a failing `beforeAll` in this suite would fail this suite).
 *
 * The jest plugin uses the `beforeAll`/`beforeEach` globals; this repo runs
 * vitest with `globals: true`, so it is called directly here.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { useAimock as useVitestAimock } from "../vitest.js";
import { useAimock as useJestAimock } from "../jest.js";
import { REPO_ROOT, connectV1, enc, expectMcpError } from "./mcp-fakes-harness.js";

const FIXTURE_DIR = resolve(__dirname, "fixtures/mcp-fakes");
const RETRY_FILE = resolve(FIXTURE_DIR, "tickets/retry.json");
const RETRY_DIR = resolve(FIXTURE_DIR, "tickets");
const RETRY_ID = "tickets › retry on timeout";
const REFUND = { title: "Refund" };
const BAD_CASE_DIR = resolve(FIXTURE_DIR, "plugin-bad");
const BAD_CASE_CONFIG = resolve(BAD_CASE_DIR, "vitest.config.ts");

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? "").join("");
}

async function expectRetrySequence(c: Client): Promise<void> {
  const first = await c.callTool({ name: "create_ticket", arguments: REFUND });
  expect(first.isError).toBe(true);
  expect(textOf(first)).toContain("upstream timeout");
  const second = await c.callTool({ name: "create_ticket", arguments: REFUND });
  expect(textOf(second)).toBe("TICKET-42");
}

const PLUGINS = [
  { name: "vitest", useAimock: useVitestAimock, caseFile: "vitest-plugin.case.ts" },
  { name: "jest", useAimock: useJestAimock, caseFile: "jest-plugin.case.ts" },
] as const;

for (const plugin of PLUGINS) {
  describe(`F12: ${plugin.name} plugin useAimock({ fixtures: <file> })`, () => {
    const mock = plugin.useAimock({ fixtures: RETRY_FILE, patchEnv: false });
    const clients: Client[] = [];

    async function client(): Promise<Client> {
      const c = await connectV1(`${mock().url}/mcp`, { headers: { "X-Test-Id": enc(RETRY_ID) } });
      clients.push(c);
      return c;
    }

    afterEach(async () => {
      for (const c of clients.splice(0)) await c.close().catch(() => {});
    });

    it("serves the file's fakes at /mcp to a v1 client and loads its LLM fixtures", async () => {
      expect(mock().llm.getFixtures()).toHaveLength(1);
      const c = await client();
      await expectRetrySequence(c);
      await expectMcpError(c.callTool({ name: "create_ticket", arguments: REFUND }), {
        code: -31010,
        aimockCode: "MCP_FAKE_EXHAUSTED",
      });
    });

    it("a second test sees the sequence restart (beforeEach resetMatchCounts, R6)", async () => {
      const c = await client();
      await expectRetrySequence(c);
    });
  });

  describe(`F12: ${plugin.name} plugin useAimock({ fixtures: <directory> })`, () => {
    const mock = plugin.useAimock({ fixtures: RETRY_DIR, patchEnv: false });

    it("serves the directory's fakes at /mcp", async () => {
      const c = await connectV1(`${mock().url}/mcp`, { headers: { "X-Test-Id": enc(RETRY_ID) } });
      try {
        await expectRetrySequence(c);
      } finally {
        await c.close().catch(() => {});
      }
    });
  });
}

describe("F12: a bad mcpFakes block fails the plugin's beforeAll (child vitest run)", () => {
  let tmpDir: string;
  let badFile: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "aimock-mcp-fakes-plugins-"));
    badFile = join(tmpDir, "bad.json");
    // A call entry with neither `result` nor `error`: bad-block case d.
    writeFileSync(
      badFile,
      JSON.stringify({
        fixtures: [],
        mcpFakes: { scope: "shared", tools: [{ name: "t", calls: [{ anyArgs: true }] }] },
      }),
    );
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function runCase(caseFile: string): Promise<{ code: number | null; output: string }> {
    const vitestBin = resolve(REPO_ROOT, "node_modules/vitest/vitest.mjs");
    return new Promise((res, rej) => {
      const cp = spawn(
        process.execPath,
        [vitestBin, "run", "--config", BAD_CASE_CONFIG, caseFile],
        {
          cwd: REPO_ROOT,
          env: { ...process.env, AIMOCK_PLUGIN_BAD_FIXTURE: badFile, CI: "1", NO_COLOR: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      cp.stdout.setEncoding("utf8");
      cp.stderr.setEncoding("utf8");
      cp.stdout.on("data", (d: string) => (output += d));
      cp.stderr.on("data", (d: string) => (output += d));
      cp.on("error", rej);
      cp.on("close", (code) => res({ code, output }));
    });
  }

  for (const plugin of PLUGINS) {
    it(`${plugin.name}: the child run exits non-zero and shows the FixtureLoadError`, async () => {
      const { code, output } = await runCase(plugin.caseFile);
      expect(code, output).not.toBe(0);
      // The error's name, its rule and its file, as vitest prints a failed `beforeAll`.
      expect(output).toContain("FixtureLoadError: ");
      expect(output).toContain("[mcp-fakes/bad-block:d]");
      expect(output).toContain(badFile);
      // The suite failed in its hook: the case file was collected, its one test skipped.
      expect(output).toContain(`FAIL  ${plugin.caseFile}`);
      expect(output).toMatch(/Tests\s+1 skipped \(1\)/);
    }, 60_000);
  }
});
