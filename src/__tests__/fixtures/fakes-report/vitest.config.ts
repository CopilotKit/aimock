/**
 * Tiny vitest config for the fakes-report plugin cases (RP7, TI1, TI5). The
 * root is this directory, so `task.file.name` is the bare case file name. It
 * includes only the `*.case.ts` files here, which the main config does not
 * pick up. Spawned as a child process by
 * `src/__tests__/fakes-report-plugins.test.ts`.
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
