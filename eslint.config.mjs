import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    ignores: [
      "dist/",
      "node_modules/",
      "fixtures/",
      ".worktrees/",
      "docs/pixels.js",
      "examples/**/.next/",
      "examples/**/next-env.d.ts",
      "examples/**/node_modules/",
    ],
  },
  {
    files: ["*.config.{js,mjs,ts,cjs}"],
    languageOptions: { globals: { module: "readonly", require: "readonly" } },
  },
);
