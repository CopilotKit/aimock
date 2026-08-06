import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "../..");
const workflowDir = resolve(repoRoot, ".github/workflows");
const read = (p: string) => readFileSync(resolve(repoRoot, p), "utf8");

const publishCommit = read(".github/workflows/publish-commit.yml");
const manifest = JSON.parse(read("package.json")) as {
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
};
const lockfile = read("pnpm-lock.yaml");

/**
 * Guards the ONE class of unpinned executable that survived the `uses:`-by-SHA
 * sweep: a `run:` step that hands a package name to a runner which resolves it
 * from the registry AT RUN TIME.
 *
 * `npx <pkg>` with `<pkg>` absent from the manifest downloads whatever the
 * registry currently serves for the `latest` dist-tag and executes it, with no
 * integrity check. `npx <pkg>` with `<pkg>` present as a dependency resolves
 * from node_modules, whose bytes `pnpm install --frozen-lockfile` has already
 * verified against the sha512 committed in pnpm-lock.yaml.
 *
 * So the invariant is NOT "never say npx" — it is "every package name a
 * workflow executes must be governed by the lockfile".
 */
describe("no workflow executes a package the lockfile does not govern", () => {
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ]);

  const workflows = readdirSync(workflowDir).filter(
    (f) => f.endsWith(".yml") || f.endsWith(".yaml"),
  );

  it("finds workflows to check (guards against a silently empty sweep)", () => {
    expect(workflows.length).toBeGreaterThan(5);
  });

  it.each(workflows)("%s runs no unpinned registry executable", (file) => {
    const body = readFileSync(resolve(workflowDir, file), "utf8");
    const offenders: string[] = [];

    for (const raw of body.split("\n")) {
      // Ignore comment-only lines: prose about npx is not an invocation.
      const line = raw.replace(/^\s*#.*$/, "");
      // `npx foo` / `pnpm dlx foo` / `npm exec foo` — the run-time resolvers.
      // `pnpm exec` is deliberately NOT here: it only ever resolves from
      // node_modules and fails loudly when the binary is absent.
      const m = line.match(
        /(?:^|[;&|(]\s*|\s)(?:npx|npm exec|pnpm dlx)\s+((?:@[\w.-]+\/)?[\w.-]+)/,
      );
      if (!m) continue;
      const pkg = m[1];
      if (pkg.startsWith("-")) continue; // a flag, not a package name
      if (!declared.has(pkg)) offenders.push(`${pkg} (in: ${line.trim()})`);
    }

    expect(
      offenders,
      `${file} executes package(s) that are in neither package.json nor pnpm-lock.yaml, so the registry decides at run time what code runs: ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});

describe("pkg-pr-new is byte-pinned, not resolved at run time", () => {
  it("is an EXACT-version devDependency (no range for the registry to move)", () => {
    const spec = manifest.devDependencies?.["pkg-pr-new"];
    expect(spec).toBeDefined();
    // No ^ ~ > < * x || - : an exact version is the only thing that keeps the
    // reviewed integrity hash below authoritative.
    expect(spec).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("carries a real sha512 integrity hash in the lockfile", () => {
    const spec = manifest.devDependencies?.["pkg-pr-new"];
    const entry = lockfile.match(
      new RegExp(
        `\\n  pkg-pr-new@${spec?.replace(/\./g, "\\.")}:\\n\\s+resolution: \\{integrity: (sha512-[A-Za-z0-9+/=]+)\\}`,
      ),
    );
    expect(
      entry,
      "pnpm-lock.yaml has no integrity-bearing entry for the pinned pkg-pr-new",
    ).not.toBeNull();
    // sha512, base64: 64 raw bytes -> 88 chars with padding.
    expect(entry?.[1].slice("sha512-".length)).toHaveLength(88);
  });

  it("the publish step runs the installed bytes, and does so AFTER the verifying install", () => {
    expect(publishCommit).toContain("pnpm exec pkg-pr-new publish");
    expect(publishCommit).not.toMatch(/^\s*-?\s*run:\s*npx pkg-pr-new/m);

    const install = publishCommit.indexOf("pnpm install --frozen-lockfile");
    const publish = publishCommit.indexOf("pnpm exec pkg-pr-new publish");
    expect(install).toBeGreaterThan(-1);
    expect(publish).toBeGreaterThan(install);
  });
});

/**
 * NOT A PIN, AND DELIBERATELY RECORDED AS SUCH.
 *
 * package.json's `packageManager` field names `pnpm@10.28.2` — a version with
 * no integrity hash. The corepack spec allows `pnpm@<version>+sha512.<hash>`,
 * and corepack DOES enforce that hash (a wrong one hard-fails with "Mismatch
 * hashes"). `pnpm/action-setup`, which is what actually installs pnpm in CI,
 * does NOT: its shipped dist/index.js at the SHA this repo pins evaluates
 * `packageManager.startsWith("pnpm@") ? i.slice(5).split("+")[0] : void 0`,
 * discarding the suffix before anything is fetched. Running that exact action
 * bundle with a 128-zero hash installs pnpm 10.28.2 and exits 0, identically
 * to running it with the genuine hash.
 *
 * This test therefore asserts the field stays HONEST — a bare version, with no
 * integrity suffix implying a verification that nothing performs. If the pnpm
 * toolchain is ever byte-pinned for real (switch to corepack, or fetch the
 * tarball and sha256-check it the way test-drift.yml provisions Ollama), this
 * test is the thing to update, along with the comment above.
 */
describe("the pnpm toolchain pin claims no more than it delivers", () => {
  it("packageManager carries no integrity suffix that pnpm/action-setup would ignore", () => {
    const pm = (JSON.parse(read("package.json")) as { packageManager?: string }).packageManager;
    expect(pm).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
  });

  it("every pnpm/action-setup use is itself pinned to a commit SHA", () => {
    for (const file of readdirSync(workflowDir).filter((f) => f.endsWith(".yml"))) {
      const body = readFileSync(resolve(workflowDir, file), "utf8");
      for (const line of body.split("\n")) {
        if (!/^\s*-?\s*uses:\s*pnpm\/action-setup@/.test(line)) continue;
        expect(line, `${file}: pnpm/action-setup must be pinned by 40-char commit SHA`).toMatch(
          /pnpm\/action-setup@[0-9a-f]{40}/,
        );
      }
    }
  });
});
