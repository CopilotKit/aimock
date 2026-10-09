/**
 * TI1 and TI4 (Vitest plugin). The root is this directory, so the default id
 * starts with the bare file name. Each assertion runs in the child; the
 * parent checks the child passed.
 * Run only as a child process by `src/__tests__/fakes-report-plugins.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { useAimock } from "../../../vitest.js";
import { FIXTURES, weather, withClient } from "./shared.js";

const mock = useAimock({ fixtures: FIXTURES, fakesReport: "fail", patchEnv: false });

describe("outer", () => {
  describe("inner", () => {
    it("case", async () => {
      const target = mock().fakesFor();
      console.log(`DEFAULT_ID=${target.testId}`);
      expect(target.testId).toBe("default-id.case.ts › outer › inner › case");
      expect(target.headers).toEqual({ "X-Test-Id": encodeURIComponent(target.testId) });
      const answer = await withClient(target.mcpUrl, target.headers, (c) => weather(c, "Seattle"));
      expect(answer).toBe("rain");
      const report = await mock().fakesReport();
      expect(report.testId).toBe(target.testId);
      expect(report.ok).toBe(true);
      expect(report.served.map((s) => s.tool)).toEqual(["get_weather"]);
    });

    it("TI4: the default id does not tag LLM traffic", async () => {
      const target = mock().fakesFor();
      expect(target.testId).toBe(
        "default-id.case.ts › outer › inner › TI4: the default id does not tag LLM traffic",
      );
      const url = mock().url;
      await fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "ti4 probe" }] }),
      });
      const llm = (await (
        await fetch(`${url}/__aimock/journal?path=/v1/chat/completions&testId=__default__`)
      ).json()) as Array<{ headers: Record<string, string> }>;
      expect(llm).toHaveLength(1);
      expect(llm[0].headers["x-test-id"]).toBeUndefined();
      const tagged = (await (
        await fetch(
          `${url}/__aimock/journal?path=/v1/chat/completions&testId=${encodeURIComponent(target.testId)}`,
        )
      ).json()) as unknown[];
      expect(tagged).toHaveLength(0);
    });

    it("an explicit test id wins over the default", () => {
      expect(mock().fakesFor("explicit id").testId).toBe("explicit id");
      expect(mock().fakesFor("explicit id", { context: "a b", mount: "/tools" })).toEqual({
        testId: "explicit id",
        mcpUrl: `${mock().url}/tools?testId=explicit+id&context=a+b`,
        headers: { "X-Test-Id": "explicit%20id", "X-AIMock-Context": "a%20b" },
      });
    });
  });
});

it("top", () => {
  const id = mock().fakesFor().testId;
  console.log(`DEFAULT_ID=${id}`);
  expect(id).toBe("default-id.case.ts › top");
});
