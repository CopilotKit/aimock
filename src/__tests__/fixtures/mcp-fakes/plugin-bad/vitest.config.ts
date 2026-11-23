/**
 * Tiny vitest config for the plugin "bad block fails beforeAll" cases (F12).
 * It includes only the `*.case.ts` files in this directory, which the main
 * config (`src/__tests__/**\/*.test.ts`) does not pick up. Spawned as a child
 * process by `src/__tests__/mcp-fakes-plugins.test.ts`.
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: fileURLToPath(new URL(".", import.meta.url)),
    environment: "node",
    globals: true,
    include: ["*.case.ts"],
    pool: "forks",
  },
});
