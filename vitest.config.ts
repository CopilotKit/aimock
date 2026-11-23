import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    silent: true,
    include: ["src/__tests__/**/*.test.ts"],
    // Pinned, not left to the default: several suites call `process.chdir`
    // (src/__tests__/drift-scripts.test.ts, src/__tests__/drift-sync-core.test.ts),
    // which throws "process.chdir() is not supported in workers" under the
    // `threads` pool. Vitest 3 happens to default to `forks`, so the suite ran
    // only by luck — a default change, or a stray `--pool=threads`, broke it.
    pool: "forks",
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/__tests__/**", "src/index.ts", "src/cli.ts", "src/aimock-cli.ts"],
      thresholds: {
        lines: 90,
        branches: 85,
        functions: 90,
      },
    },
  },
});
