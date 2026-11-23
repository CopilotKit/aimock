/**
 * The fakes report in concurrent tests (Vitest plugin). Two concurrent tests
 * use explicit ids: "a" registers the `never-called` scope and never calls it;
 * "b" consumes its own Seattle entry. The report keeps one state per
 * `useAimock`, so it cannot tell the two tests apart: under "warn" or "fail"
 * `beforeEach` must throw; under "off" both tests run as before.
 * Run only as a child process by `src/__tests__/fakes-report-plugins.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { useAimock } from "../../../vitest.js";
import { FIXTURES, modeFromEnv, weather, withClient } from "./shared.js";

const mock = useAimock({ fixtures: FIXTURES, fakesReport: modeFromEnv(), patchEnv: false });

describe.concurrent("concurrent", () => {
  it("a", async () => {
    const t = mock().fakesFor("unused.case.ts › weather › unused");
    await withClient(t.mcpUrl, t.headers, async (c) => (await c.listTools()).tools);
    await new Promise((r) => setTimeout(r, 200));
  });

  it("b", async () => {
    const t = mock().fakesFor("swallowed.case.ts › weather › seattle");
    expect(await withClient(t.mcpUrl, t.headers, (c) => weather(c, "Seattle"))).toBe("rain");
    await new Promise((r) => setTimeout(r, 400));
  });
});
