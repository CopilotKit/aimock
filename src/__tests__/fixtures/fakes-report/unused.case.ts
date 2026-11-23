/**
 * RP7 (b), unused fake: the test lists tools with a hand-built URL and never
 * calls `get_weather`, so `never-called` stays unconsumed.
 * Run only as a child process by `src/__tests__/fakes-report-plugins.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { FIXTURES, modeFromEnv, pluginUnderTest, withClient } from "./shared.js";

const useAimock = await pluginUnderTest();
const mock = useAimock({ fixtures: FIXTURES, fakesReport: modeFromEnv(), patchEnv: false });

describe("weather", () => {
  it("unused", async () => {
    const url = `${mock().url}/mcp?testId=${encodeURIComponent("unused.case.ts › weather › unused")}`;
    const names = await withClient(url, undefined, async (c) =>
      (await c.listTools()).tools.map((t) => t.name),
    );
    expect(names).toContain("get_weather");
  });

  it("sends nothing to MCP and is not checked", () => {
    expect(mock().url).toMatch(/^http:/);
  });
});
