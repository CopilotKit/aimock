/**
 * HC1, swallowed failure, Jest. The MCP URL is built by hand and the
 * mismatch error is caught, so only the fakes report can fail the test.
 */
/* global describe, it, expect, console, process, require, URL */
/* eslint-disable @typescript-eslint/no-require-imports */
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StreamableHTTPClientTransport,
} = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { useAimock } = require("@copilotkit/aimock/jest");

const mode = process.env.AIMOCK_FAKES_REPORT ?? "fail";
const mock = useAimock({ fixtures: "./fixtures", fakesReport: mode, patchEnv: false });

describe("weather", () => {
  it("seattle", async () => {
    const url = `${mock().url}/mcp?testId=${encodeURIComponent("jest/swallowed.test.cjs › weather seattle")}`;
    const client = new Client({ name: "swallowed-jest", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    let answer = "no answer";
    try {
      const result = await client.callTool({
        name: "get_weather",
        arguments: { city: "Portland" },
      });
      answer = JSON.stringify(result.content);
    } catch (err) {
      answer = `tool error: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      await client.close();
    }
    console.log(`SWALLOWED_ANSWER=${answer}`);
    expect(typeof answer).toBe("string");
  });
});
