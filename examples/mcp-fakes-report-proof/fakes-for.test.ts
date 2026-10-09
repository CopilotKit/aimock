/**
 * HC1 and TI1: `fakesFor()` with no test id infers
 * `fakes-for.test.ts › weather › seattle`, and its URL and headers reach the
 * fake scoped to that id. The report is then `ok: true`.
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { useAimock } from "@copilotkit/aimock/vitest";

const mock = useAimock({ fixtures: "./fixtures", fakesReport: "fail", patchEnv: false });

describe("weather", () => {
  it("seattle", async () => {
    const target = mock().fakesFor();
    console.log(`DEFAULT_ID=${target.testId}`);
    const client = new Client({ name: "fakes-for", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(target.mcpUrl), {
        requestInit: { headers: target.headers },
      }),
    );
    try {
      const result = await client.callTool({ name: "get_weather", arguments: { city: "Seattle" } });
      expect(result.content).toEqual([{ type: "text", text: "rain" }]);
    } finally {
      await client.close();
    }
    const report = await mock().fakesReport();
    console.log(`REPORT_OK=${report.ok}`);
    expect(report.ok).toBe(true);
  });
});
