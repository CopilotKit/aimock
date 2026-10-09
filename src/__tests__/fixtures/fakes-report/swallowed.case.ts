/**
 * RP7 (b), swallowed failure: the MCP URL is built by hand, the call does not
 * match the fake, and the test catches the error. Only the report fails it.
 * Run only as a child process by `src/__tests__/fakes-report-plugins.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { FIXTURES, modeFromEnv, pluginUnderTest, weather, withClient } from "./shared.js";

const useAimock = await pluginUnderTest();
const mock = useAimock({ fixtures: FIXTURES, fakesReport: modeFromEnv(), patchEnv: false });

describe("weather", () => {
  it("seattle", async () => {
    const url = `${mock().url}/mcp?testId=${encodeURIComponent("swallowed.case.ts › weather › seattle")}`;
    const answer = await withClient(url, undefined, (c) => weather(c, "Portland"));
    expect(answer).toContain("tool error");
  });
});
