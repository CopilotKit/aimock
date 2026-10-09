/**
 * WF3 control: the same fixture and assertions as WF2, run by a two-node
 * LangGraph JS `StateGraph`. Each node calls the tool through the MCP SDK
 * `Client` over `StreamableHTTPClientTransport`. No Mastra code, no LLM calls.
 *
 * Node `track` calls `lookup_order {orderId:"A1"}` and loops back to itself
 * until it has two answers. Node `escalate` then calls `{orderId:"B2"}` and
 * keeps a thrown error as its output, as a graph that tolerates a failing
 * order service would.
 */
import { afterAll, describe, expect, it } from "vitest";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { useAimock } from "@copilotkit/aimock/vitest";
import {
  MASTRA_ID,
  SCRIPTED,
  assertIsolated,
  assertScripted,
  caught,
  printMcpJournal,
  reportMode,
  toolText,
} from "./shared.js";

const mock = useAimock({
  fixtures: process.env.WF_FIXTURE ?? "./fixtures/workflow.json",
  fakesReport: reportMode,
  patchEnv: false,
});

const State = Annotation.Root({
  outputs: Annotation<string[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
});

describe("orders", () => {
  let baseUrl = "";
  afterAll(async () => {
    if (baseUrl) await printMcpJournal(baseUrl, "LANGGRAPH");
  });

  it("pipeline", async () => {
    baseUrl = mock().url;
    const { mcpUrl, headers, testId } = mock().fakesFor();
    console.log(`LANGGRAPH_TEST_ID=${testId}`);
    const client = new Client({ name: "wf3-orders", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers } }),
    );
    try {
      const lookup = async (orderId: string): Promise<string> =>
        toolText(await client.callTool({ name: "lookup_order", arguments: { orderId } }));

      const graph = new StateGraph(State)
        .addNode("track", async () => ({ outputs: [await lookup("A1")] }))
        .addNode("escalate", async () => {
          try {
            return { outputs: [await lookup("B2")] };
          } catch (err) {
            return { outputs: [caught(err)] };
          }
        })
        .addEdge(START, "track")
        .addConditionalEdges("track", (s) => (s.outputs.length < 2 ? "track" : "escalate"), [
          "track",
          "escalate",
        ])
        .addEdge("escalate", END)
        .compile();

      let status = "success";
      let outputs: string[] = [];
      try {
        outputs = (await graph.invoke({ outputs: [] })).outputs;
      } catch (err) {
        status = "failed";
        console.log(`LANGGRAPH_RUN_ERROR=${caught(err)}`);
      }
      console.log(`LANGGRAPH_RUN_STATUS=${status}`);
      for (const [i, out] of outputs.entries()) console.log(`LANGGRAPH_STEP_${i + 1}=${out}`);
      const report = await mock().fakesReport();
      console.log(`LANGGRAPH_REPORT=${JSON.stringify(report)}`);
      const other = await mock().fakesReport(MASTRA_ID);
      console.log(
        `LANGGRAPH_OTHER_ID_REPORT served=${other.served.length} unconsumed=${other.unconsumed.length}`,
      );

      if (SCRIPTED) {
        expect(status).toBe("success");
        // The SDK client returns an `isError` result for the `error` entry.
        assertScripted(outputs, "tool error: order service down");
        expect(report.ok).toBe(true);
        assertIsolated(other);
      }
    } finally {
      await client.close();
    }
  });
});
