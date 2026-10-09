/**
 * HC1, unused fake. The test talks to its fake's mount with a hand-built
 * URL but never calls `get_weather`, so the `never-called` entry stays
 * unconsumed. Only the fakes report can catch it (RP7 b).
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { useAimock } from "@copilotkit/aimock/vitest";

const mode = (process.env.AIMOCK_FAKES_REPORT ?? "fail") as "off" | "warn" | "fail";
const mock = useAimock({ fixtures: "./fixtures", fakesReport: mode, patchEnv: false });

describe("weather", () => {
  it("unused", async () => {
    const url = `${mock().url}/mcp?testId=${encodeURIComponent("unused.test.ts › weather › unused")}`;
    const client = new Client({ name: "unused", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("get_weather");
    } finally {
      await client.close();
    }
  });
});
