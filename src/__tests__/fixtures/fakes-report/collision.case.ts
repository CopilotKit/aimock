/**
 * TI5 (Vitest plugin): a duplicate title throws, a retry reuses its id, and a
 * concurrent test throws. Each assertion runs in the child; the parent
 * checks the child passed.
 * Run only as a child process by `src/__tests__/fakes-report-plugins.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { useAimock } from "../../../vitest.js";
import { AimockTestIdCollisionError } from "../../../mcp-fakes-report.js";

// "off": the report refuses concurrent tests, and this file has one.
const mock = useAimock({ fakesReport: "off", patchEnv: false });

describe("dup", () => {
  it("same title", () => {
    expect(mock().fakesFor().testId).toBe("collision.case.ts › dup › same title");
  });

  it("same title", () => {
    expect(() => mock().fakesFor()).toThrow(AimockTestIdCollisionError);
    expect(() => mock().fakesFor()).toThrow(
      'two tests share the default test id "collision.case.ts › dup › same title"; pass an explicit testId',
    );
    // An explicit id is still fine.
    expect(mock().fakesFor("dup explicit").testId).toBe("dup explicit");
  });
});

let attempts = 0;
it("retried", { retry: 2 }, () => {
  attempts += 1;
  const id = mock().fakesFor().testId;
  expect(id).toBe("collision.case.ts › retried");
  console.log(`RETRY_ATTEMPT=${attempts} ID=${id}`);
  if (attempts === 1) throw new Error("first attempt fails on purpose");
});

it.concurrent("concurrent", () => {
  expect(() => mock().fakesFor()).toThrow(
    "default test ids are not supported in concurrent tests; pass an explicit testId",
  );
});
