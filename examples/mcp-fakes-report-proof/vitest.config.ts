/**
 * The Vitest half of the HC1 proof. Vitest's default include also matches
 * `jest/*.test.cjs`, so only the top-level `*.test.ts` files run here.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["*.test.ts"],
    exclude: ["jest/**", "node_modules/**"],
  },
});
