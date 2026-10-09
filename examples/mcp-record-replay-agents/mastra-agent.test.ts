/**
 * `rr:` 10.4 item 4: a real Mastra `Agent` replays a recorded MCP server.
 *
 * - The model is OpenAI-compatible, pointed at aimock (`fixtures/llm/agent.json`):
 *   the first turn asks for `everything_echo {message:"hi"}`, the second turn is
 *   matched on that tool's result and gives the final text.
 * - The tools come from Mastra's `MCPClient`, pointed at
 *   `fakesFor("mcp › record").mcpUrl`, which serves the recorded `mcpFakes`
 *   (`<REPLAY_FIXTURES>/recorded/mcp--record/mcp.json`). No upstream runs.
 * - The test then calls the four other recorded tools through the same Mastra
 *   tools, so every recorded entry is consumed and `fakesReport().ok` is true.
 * - Every result must equal the recorded entry. With `REPLAY_LIVE` (the record
 *   client's `results-record.json`), the tools that carry no secret must also
 *   equal what the live upstream answered.
 *
 * With one recorded `args` value broken, the echo call is `MCP_FAKE_MISMATCH`:
 * the journal shows it, and the `afterEach` fakes report fails the test.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { Agent } from "@mastra/core/agent";
import { MCPClient, getMcpCallToolContent } from "@mastra/mcp";
import { useAimock } from "@copilotkit/aimock/vitest";
import { CALLS, TEST_ID } from "./calls.mjs";

const FIXTURES = resolve(process.env.REPLAY_FIXTURES ?? "./fixtures");
const RECORDING = join(FIXTURES, "recorded", "mcp--record", "mcp.json");
const LIVE = process.env.REPLAY_LIVE;
/** Tools whose live answer has no secret in it (get-env is redacted on disk). */
const NON_SECRET = ["echo", "get-sum", "get-structured-content", "trigger-long-running-operation"];

const mock = useAimock({ fixtures: FIXTURES, fakesReport: "fail", patchEnv: false });

type RecordedCall = { args?: unknown; result?: unknown; error?: string };
type ToolExecute = (input: unknown, context: object) => Promise<unknown>;
type RecordedBlock = { list?: unknown; tools: { name: string; calls: RecordedCall[] }[] };

/** The recorded result for `name` with `args`, as the fakes engine serves it. */
function recorded(block: RecordedBlock, name: string, args: unknown): unknown {
  const entry = block.tools
    .find((t) => t.name === name)
    ?.calls.find((c) => isDeepStrictEqual(c.args ?? {}, args));
  if (!entry) return undefined;
  if (entry.error !== undefined)
    return { content: [{ type: "text", text: entry.error }], isError: true };
  return entry.result;
}

/** A tool result as compared: plain JSON, no class instances or undefined keys. */
const plain = (v: unknown): unknown => JSON.parse(JSON.stringify(v ?? null));

/**
 * The MCP `CallToolResult` behind what a Mastra tool returned. For a tool with
 * an `outputSchema`, Mastra returns `structuredContent` and keeps `content`
 * on a symbol; rebuild the envelope so the whole wire result is compared.
 */
function envelope(value: unknown): unknown {
  const content = value && typeof value === "object" ? getMcpCallToolContent(value) : undefined;
  return plain(content === undefined ? value : { content, structuredContent: value });
}

describe("mcp record replay", () => {
  let baseUrl = "";
  afterAll(async () => {
    if (!baseUrl) return;
    const entries = (await (await fetch(`${baseUrl}/__aimock/journal`)).json()) as {
      method: string;
      path: string;
      response: { mcpFake?: unknown };
    }[];
    for (const e of entries) {
      if (e.response.mcpFake)
        console.log(
          `AGENT_JOURNAL ${e.method} ${e.path} mcpFake=${JSON.stringify(e.response.mcpFake)}`,
        );
    }
  });

  it("a Mastra agent replays the recorded MCP server", async () => {
    baseUrl = mock().url;
    const { mcpUrl, testId } = mock().fakesFor(TEST_ID);
    console.log(`AGENT_TEST_ID=${testId}`);
    const doc = JSON.parse(readFileSync(RECORDING, "utf8")) as {
      mcpFakes: RecordedBlock | RecordedBlock[];
    };
    const block = Array.isArray(doc.mcpFakes) ? doc.mcpFakes[0] : doc.mcpFakes;
    const live = LIVE
      ? (JSON.parse(readFileSync(LIVE, "utf8")) as { calls: Record<string, unknown> })
      : undefined;

    const client = new MCPClient({
      id: "replay-agent",
      servers: { everything: { url: new URL(mcpUrl) } },
    });
    try {
      const tools = await client.listTools();
      console.log(`AGENT_TOOLS=${Object.keys(tools).length}`);

      const agent = new Agent({
        id: "replay-agent",
        name: "replay-agent",
        instructions: "Answer with the tools you have.",
        model: {
          providerId: "openai",
          modelId: "gpt-4o-mini",
          url: `${baseUrl}/v1`,
          apiKey: "aimock-fixture-no-key",
        },
        tools: { everything_echo: tools["everything_echo"]! },
      });
      const out = await agent.generate("Say hi through the echo tool", { maxSteps: 3 });
      console.log(`AGENT_TEXT=${out.text}`);

      const got: Record<string, unknown> = {};
      const echo = out.toolResults.find((r) => r.payload.toolName === "everything_echo");
      got["echo"] = envelope(echo?.payload.result);
      for (const [name, args] of CALLS) {
        if (name === "echo") continue;
        // Called the way the S9 workflow steps call a Mastra MCP tool: no agent context.
        const execute = tools[`everything_${name}`]?.execute as ToolExecute | undefined;
        got[name] = envelope(await execute?.(args, {}));
      }

      let same = 0;
      for (const [name, args] of CALLS) {
        const fileOk = isDeepStrictEqual(got[name], plain(recorded(block, name, args)));
        const liveOk =
          !live ||
          !NON_SECRET.includes(name) ||
          isDeepStrictEqual(got[name], plain(live.calls[name]));
        if (fileOk && liveOk) same++;
        else console.log(`AGENT_DIFF ${name} got=${JSON.stringify(got[name])}`);
      }
      const report = await mock().fakesReport(TEST_ID);
      console.log(
        `AGENT_REPORT ok=${report.ok} served=${report.served.length} unconsumed=${report.unconsumed.length} failures=${report.failures.length}`,
      );
      console.log(`AGENT_EQUAL ${same}/${CALLS.length}${live ? " (file + live)" : " (file)"}`);

      expect(out.text).toBe("The echo tool answered: Echo: hi");
      expect(same).toBe(CALLS.length);
      expect(report.ok).toBe(true);
    } finally {
      await client.disconnect();
    }
  });
});
