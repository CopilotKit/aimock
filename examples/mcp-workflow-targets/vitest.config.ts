/** WF2 and WF3: the two pipeline tests in this directory, nothing else. */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["*.test.ts"],
    exclude: ["node_modules/**"],
    testTimeout: 30_000,
  },
});
