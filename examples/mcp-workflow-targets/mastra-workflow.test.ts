/**
 * WF2: a real Mastra Workflow whose steps call an MCP tool through Mastra's
 * MCPClient, pointed at `fakesFor().mcpUrl`. There are no LLM calls.
 *
 * Steps 1 and 2 call `lookup_order {orderId:"A1"}` (two ordered answers).
 * Step 3 calls `{orderId:"B2"}`, whose fake is an `error` entry, and keeps
 * the tool error (or a thrown error) as its output, as a workflow that
 * tolerates a failing order service would.
 */
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { MCPClient } from "@mastra/mcp";
import { useAimock } from "@copilotkit/aimock/vitest";
import {
  LANGGRAPH_ID,
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

type LookupTool = { execute?: (input: { orderId: string }, context: object) => Promise<unknown> };

describe("orders", () => {
  let baseUrl = "";
  afterAll(async () => {
    if (baseUrl) await printMcpJournal(baseUrl, "MASTRA");
  });

  it("pipeline", async () => {
    baseUrl = mock().url;
    const { mcpUrl, testId } = mock().fakesFor();
    console.log(`MASTRA_TEST_ID=${testId}`);
    const client = new MCPClient({
      id: "wf2-orders",
      servers: { orders: { url: new URL(mcpUrl) } },
    });
    try {
      const tools = await client.listTools();
      console.log(`MASTRA_TOOLS=${Object.keys(tools).join(",")}`);
      const lookup = tools["orders_lookup_order"] as LookupTool | undefined;
      expect(lookup?.execute).toBeTypeOf("function");
      const call = async (orderId: string): Promise<string> =>
        toolText(await lookup!.execute!({ orderId }, {}));
      // Step 3 tolerates a failing order service: it keeps the error as its output.
      const tolerant = async (orderId: string): Promise<string> => {
        try {
          return await call(orderId);
        } catch (err) {
          return caught(err);
        }
      };

      const stepOut = z.object({ outputs: z.array(z.string()) });
      const step = (
        id: string,
        orderId: string,
        inputSchema: z.ZodTypeAny,
        lookupFn: (orderId: string) => Promise<string> = call,
      ) =>
        createStep({
          id,
          inputSchema,
          outputSchema: stepOut,
          execute: async ({ inputData }) => {
            const before = (inputData as { outputs?: string[] }).outputs ?? [];
            return { outputs: [...before, await lookupFn(orderId)] };
          },
        });

      const workflow = createWorkflow({
        id: "orders",
        inputSchema: z.object({}),
        outputSchema: stepOut,
      })
        .then(step("first-lookup", "A1", z.object({})))
        .then(step("second-lookup", "A1", stepOut))
        .then(step("failing-lookup", "B2", stepOut, tolerant))
        .commit();

      const run = await workflow.createRun();
      const r = await run.start({ inputData: {} });
      console.log(`MASTRA_RUN_STATUS=${r.status}`);
      if (r.status === "success") {
        for (const [i, out] of r.result.outputs.entries())
          console.log(`MASTRA_STEP_${i + 1}=${out}`);
      } else if (r.status === "failed") {
        console.log(`MASTRA_RUN_ERROR=${caught(r.error)}`);
      }
      const report = await mock().fakesReport();
      console.log(`MASTRA_REPORT=${JSON.stringify(report)}`);
      const other = await mock().fakesReport(LANGGRAPH_ID);
      console.log(
        `MASTRA_OTHER_ID_REPORT served=${other.served.length} unconsumed=${other.unconsumed.length}`,
      );

      if (SCRIPTED) {
        expect(r.status).toBe("success");
        // Mastra's MCP tool throws on an `isError` result; step 3 keeps the message.
        assertScripted(
          r.status === "success" ? r.result.outputs : [],
          "caught: order service down",
        );
        expect(report.ok).toBe(true);
        assertIsolated(other);
      }
    } finally {
      await client.disconnect();
    }
  });
});
