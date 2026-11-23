/**
 * HC1, swallowed failure. The MCP URL is built by hand (the only way on
 * main). The call does not match the fake (Portland, not Seattle), and the
 * test catches the error the way an agent framework would, so nothing in the
 * test body fails. Only the fakes report can catch it (RP7 b).
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { useAimock } from "@copilotkit/aimock/vitest";

const mode = (process.env.AIMOCK_FAKES_REPORT ?? "fail") as "off" | "warn" | "fail";
const mock = useAimock({ fixtures: "./fixtures", fakesReport: mode, patchEnv: false });

describe("weather", () => {
  it("seattle", async () => {
    const url = `${mock().url}/mcp?testId=${encodeURIComponent("swallowed.test.ts › weather › seattle")}`;
    const client = new Client({ name: "swallowed", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    let answer = "no answer";
    try {
      const result = await client.callTool({
        name: "get_weather",
        arguments: { city: "Portland" },
      });
      answer = JSON.stringify(result.content);
    } catch (err) {
      // An agent framework turns the tool error into a message and moves on.
      answer = `tool error: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      await client.close();
    }
    console.log(`SWALLOWED_ANSWER=${answer}`);
    expect(answer).toBeTypeOf("string");
  });
});
