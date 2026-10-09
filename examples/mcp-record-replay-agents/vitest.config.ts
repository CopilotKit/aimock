/** The Mastra agent replay test in this directory, nothing else, with no external network. */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["*.test.ts"],
    exclude: ["node_modules/**"],
    setupFiles: ["./no-network.ts"],
    env: { MASTRA_TELEMETRY_DISABLED: "1" },
    testTimeout: 30_000,
  },
});
