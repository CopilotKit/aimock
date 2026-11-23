/**
 * Spec 13.1 red-green proof for scenario-scoped MCP tool fakes.
 *
 * Real surface only: the built CLI (`node dist/cli.js`) loads a fixture
 * directory whose file declares `mcpFakes`, and a real
 * `@modelcontextprotocol/sdk` v1 client talks Streamable HTTP to it over a
 * real TCP port.
 *
 * The proof command (the env var is kept so RED and GREEN ran the same
 * command; the suite no longer reads it and runs under plain `pnpm test`):
 *
 *   pnpm build && AIMOCK_MCP_FAKES_13_1=1 pnpm vitest run src/__tests__/mcp-fakes-redgreen.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { type CliHandle, connectV1, enc, expectMcpError, startCli } from "./mcp-fakes-harness.js";

const FIXTURE_DIR = "src/__tests__/fixtures/mcp-fakes/tickets";
const TEST_ID = "tickets › retry on timeout";

function firstText(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null || !("content" in result)) return undefined;
  const content = result.content;
  if (!Array.isArray(content)) return undefined;
  const first: unknown = content[0];
  if (typeof first !== "object" || first === null || !("text" in first)) return undefined;
  return typeof first.text === "string" ? first.text : undefined;
}

describe("13.1 red-green", () => {
  let cli: CliHandle | undefined;
  let client: Client | undefined;

  beforeAll(async () => {
    cli = await startCli(["--fixtures", FIXTURE_DIR]);
  }, 20_000);

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    await cli?.stop();
  });

  it("serves the scripted retry sequence, then fails loud when exhausted", async () => {
    if (!cli) throw new Error("CLI did not start");
    const c = await connectV1(`${cli.url}/mcp?testId=${enc(TEST_ID)}`);
    client = c;

    const call = () => c.callTool({ name: "create_ticket", arguments: { title: "Refund" } });

    const first = await call();
    expect(first.isError).toBe(true);
    expect(firstText(first)).toBe("upstream timeout");

    const second = await call();
    expect(second.isError).toBeFalsy();
    expect(firstText(second)).toBe("TICKET-42");

    await expectMcpError(call(), { code: -31010, aimockCode: "MCP_FAKE_EXHAUSTED" });
  }, 20_000);
});
