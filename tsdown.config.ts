import { defineConfig } from "tsdown";
export default defineConfig({
  entry: [
    "src/index.ts",
    "src/cli.ts",
    "src/aimock-cli.ts",
    "src/mcp-stub.ts",
    "src/a2a-stub.ts",
    "src/vector-stub.ts",
  ],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  target: "es2022",
  clean: true,
  unbundle: true,
});
