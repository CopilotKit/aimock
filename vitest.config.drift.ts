import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["src/__tests__/drift/**/*.drift.ts"],
    testTimeout: 30000,
  },
});
