/**
 * HC1 and TI2, Jest: `fakesFor()` with no test id infers
 * `jest/fakes-for.test.cjs › weather seattle` (the path relative to
 * `testIdRoot`, which defaults to the project directory, then Jest's own
 * space-joined test name).
 */
/* global describe, it, expect, console, require, URL */
/* eslint-disable @typescript-eslint/no-require-imports */
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StreamableHTTPClientTransport,
} = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { useAimock } = require("@copilotkit/aimock/jest");

const mock = useAimock({ fixtures: "./fixtures", fakesReport: "fail", patchEnv: false });

describe("weather", () => {
  it("seattle", async () => {
    const target = mock().fakesFor();
    console.log(`DEFAULT_ID=${target.testId}`);
    const client = new Client({ name: "fakes-for-jest", version: "1.0.0" });
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
