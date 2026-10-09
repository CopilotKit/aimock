/**
 * RP2 / C8 / C9: every `tools/call` is logged to the mount's fake event log,
 * fakes or not. A call no fake applied to is an `unfaked` event that names
 * who answered it: a registered handler (`handler`), a config `mcp.tools[]`
 * result (`config`), a tool registered with no handler (`empty`), or nothing
 * (`unknown-tool`).
 *
 * Real surface: an `LLMock` on a real TCP port and a real v1 MCP SDK client
 * over Streamable HTTP. The report route arrives with S4, so the event log is
 * read through the `MCPMock` mount handle (`fakesReportPart`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { LLMock } from "../llmock.js";
import { MCPMock } from "../mcp-mock.js";
import { startFromConfig } from "../config-loader.js";
import type { Mountable } from "../types.js";
import { connectV1, enc, expectMcpError } from "./mcp-fakes-harness.js";

const T1 = "unfaked › t1";
const T2 = "unfaked › t2";

const mocks: LLMock[] = [];
const clients: Client[] = [];

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  for (const m of mocks.splice(0)) await m.stop().catch(() => {});
  vi.restoreAllMocks();
});

async function connect(url: string, testId: string): Promise<Client> {
  const client = await connectV1(url, { headers: { "X-Test-Id": enc(testId) } });
  clients.push(client);
  return client;
}

/** An LLMock with one MCPMock at /mcp: one fake block plus plain, handler and unknown tools. */
async function startMixed(): Promise<{ llm: LLMock; mcp: MCPMock; url: string }> {
  const llm = new LLMock({ port: 0 });
  mocks.push(llm);
  const mcp = new MCPMock();
  mcp.addTool({ name: "plain" });
  mcp.onToolCall("h", () => "from handler");
  mcp.loadFakes({
    scope: "shared",
    tools: [{ name: "faked", calls: [{ args: { q: 1 }, result: "fake answer" }] }],
  });
  llm.mount("/mcp", mcp);
  const url = await llm.start();
  return { llm, mcp, url };
}

describe("RP2: unfaked tools/call events", () => {
  it("names who answered each call no fake applied to (empty, handler, unknown-tool)", async () => {
    const { mcp, url } = await startMixed();
    const client = await connect(url + "/mcp", T1);

    await client.callTool({ name: "faked", arguments: { q: 1 } });
    await client.callTool({ name: "plain", arguments: { a: 1 } });
    await client.callTool({ name: "h", arguments: { b: 2 } });
    await expect(client.callTool({ name: "nope", arguments: {} })).rejects.toThrow(
      /Unknown tool: nope/,
    );

    const part = mcp.fakesReportPart(T1, null, "/mcp");
    expect(part.served).toEqual([
      {
        entryId: expect.any(String),
        mount: "/mcp",
        tool: "faked",
        args: { q: 1 },
        seq: expect.any(Number),
      },
    ]);
    expect(part.unfaked).toEqual([
      { mount: "/mcp", tool: "plain", args: { a: 1 }, answeredBy: "empty" },
      { mount: "/mcp", tool: "h", args: { b: 2 }, answeredBy: "handler" },
      { mount: "/mcp", tool: "nope", args: {}, answeredBy: "unknown-tool" },
    ]);
    expect(part.failures).toEqual([]);
  });

  it("logs fake failures with their code and arguments", async () => {
    const { mcp, url } = await startMixed();
    const client = await connect(url + "/mcp", T1);
    await expectMcpError(client.callTool({ name: "faked", arguments: { q: 2 } }), {
      code: -32602,
      aimockCode: "MCP_FAKE_MISMATCH",
    });
    const part = mcp.fakesReportPart(T1, null, "/mcp");
    expect(part.failures).toEqual([
      {
        code: "MCP_FAKE_MISMATCH",
        mount: "/mcp",
        tool: "faked",
        args: { q: 2 },
        seq: expect.any(Number),
      },
    ]);
    // RP4: a shared block's unused entry is reported in the shared tier.
    expect(part.sharedUnconsumed.map((u) => u.tool)).toEqual(["faked"]);
  });

  it("C9: a mount with no fake blocks still logs every call", async () => {
    const llm = new LLMock({ port: 0 });
    mocks.push(llm);
    const mcp = new MCPMock();
    mcp.onToolCall("h", () => "x");
    llm.mount("/mcp", mcp);
    const url = await llm.start();
    const client = await connect(url + "/mcp", T1);
    await client.callTool({ name: "h", arguments: { n: 1 } });
    expect(mcp.fakesReportPart(T1, null, "/mcp").unfaked).toEqual([
      { mount: "/mcp", tool: "h", args: { n: 1 }, answeredBy: "handler" },
    ]);
  });

  it("C8: a config mcp.tools[].result answers as `config`", async () => {
    const mounted: Mountable[] = [];
    const realMount = LLMock.prototype.mount;
    vi.spyOn(LLMock.prototype, "mount").mockImplementation(function (
      this: LLMock,
      path: string,
      handler: Mountable,
    ) {
      mounted.push(handler);
      return realMount.call(this, path, handler);
    });
    const { llmock, url } = await startFromConfig({
      port: 0,
      mcp: { tools: [{ name: "cfg", result: "configured" }] },
    });
    mocks.push(llmock);
    const mcp = mounted.find((h): h is MCPMock => h instanceof MCPMock);
    if (!mcp) throw new Error("startFromConfig mounted no MCPMock");

    const client = await connect(url + "/mcp", T1);
    const result = await client.callTool({ name: "cfg", arguments: {} });
    expect(result.content).toEqual([{ type: "text", text: "configured" }]);
    expect(mcp.fakesReportPart(T1, null, "/mcp").unfaked).toEqual([
      { mount: "/mcp", tool: "cfg", args: {}, answeredBy: "config" },
    ]);
  });

  it("RP2 reset: resetMatchCounts(t1) clears t1's events and keeps t2's", async () => {
    const { llm, mcp, url } = await startMixed();
    const c1 = await connect(url + "/mcp", T1);
    const c2 = await connect(url + "/mcp", T2);
    await c1.callTool({ name: "plain", arguments: {} });
    await c2.callTool({ name: "plain", arguments: {} });

    llm.resetMatchCounts(T1);

    const p1 = mcp.fakesReportPart(T1, null, "/mcp");
    expect(p1.unfaked).toEqual([]);
    expect(p1.served).toEqual([]);
    expect(mcp.fakesReportPart(T2, null, "/mcp").unfaked).toHaveLength(1);
  });
});
