/** One-time AG-UI generated-schema reader overlay for an older main baseline. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const READER_FILES = [
  "scripts/drift-agui-canonical.ts",
  "src/__tests__/drift/agui-schema.drift.ts",
] as const;
const COLLECTOR = "scripts/drift-report-collector.ts";
const LEGACY_CLASSIFIER_SHA = "483f8e353319e8acafee35e5cc34f7916eaae14c6313e684cf5eb06bb6da33b4";
const digest = (source: string): string => createHash("sha256").update(source).digest("hex");
const read = (root: string, file: string): string => readFileSync(resolve(root, file), "utf8");
const git = (root: string, ...args: string[]): string =>
  execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

export function adaptLegacyCollector(source: string): string {
  const matches = [
    ...source.matchAll(
      /export function classifyAgUiCheckout\(agUiPath: string\): AgUiCheckoutStatus \{[\s\S]*?\n\}/g,
    ),
  ];
  if (matches.length !== 1 || digest(matches[0][0]) !== LEGACY_CLASSIFIER_SHA) {
    throw new Error("unsupported or ambiguous BASE AG-UI classifier; refusing collector overlay");
  }
  const original = matches[0][0];
  const adapted = original
    .replace(
      "  let isDir = false;",
      "  agUiPath = resolveAgUiRepo(agUiPath);\n  let isDir = false;",
    )
    .replace(
      "!existsSync(resolve(agUiPath, AGUI_CANONICAL_TYPES_RELPATH))",
      "!discoverAgUiSources(agUiPath)",
    )
    .replace(
      "`${agUiPath} exists but ${AGUI_CANONICAL_TYPES_RELPATH} is missing — the canonical `",
      "`${agUiPath} lacks a complete supported canonical source pair — the canonical `",
    );
  return (
    'import { discoverAgUiSources, resolveAgUiRepo } from "./drift-agui-canonical.js";\n' +
    source.replace(original, adapted)
  );
}

export function readerDiffers(head: string, base: string): boolean {
  return READER_FILES.some(
    (file) => !existsSync(resolve(base, file)) || read(head, file) !== read(base, file),
  );
}

export function overlayReader(head: string, base: string): void {
  // Validate every input before writing. Never transfer the HEAD collector.
  const source = read(base, COLLECTOR);
  const adapted = adaptLegacyCollector(source);
  const tooling = READER_FILES.map((file) => ({ file, source: read(head, file) }));
  for (const { file, source: tool } of tooling) {
    mkdirSync(dirname(resolve(base, file)), { recursive: true });
    writeFileSync(resolve(base, file), tool);
  }
  writeFileSync(resolve(base, COLLECTOR), adapted);
}

function productHash(root: string): string {
  return digest(
    git(root, "ls-files", "src")
      .split("\n")
      .filter((file) => file !== READER_FILES[1])
      .map((file) => `${file}\0${digest(read(root, file))}`)
      .join("\n"),
  );
}

function main(): void {
  const [command, base, upstream] = process.argv.slice(2);
  const head = process.cwd();
  if (!base || !["check", "apply"].includes(command)) {
    throw new Error(
      "usage: drift-agui-baseline.ts check <base-dir> | apply <base-dir> <upstream-dir>",
    );
  }
  if (command === "check") {
    console.log(readerDiffers(head, base) ? "true" : "false");
    return;
  }
  if (!upstream || git(upstream, "status", "--porcelain"))
    throw new Error("canonical checkout must exist and be clean");
  const upstreamSha = git(upstream, "rev-parse", "HEAD");
  if (upstreamSha !== process.env.AGUI_UPSTREAM_SHA)
    throw new Error("canonical checkout SHA does not match pinned AGUI_UPSTREAM_SHA");
  const before = productHash(base);
  const collectorBefore = digest(read(base, COLLECTOR));
  const overlaid = readerDiffers(head, base);
  if (overlaid) overlayReader(head, base);
  const after = productHash(base);
  if (before !== after) throw new Error("BASE product sources changed during reader bootstrap");
  const tooling = READER_FILES.map((file) => {
    const sha = digest(read(head, file));
    if (sha !== digest(read(base, file))) throw new Error(`BASE/HEAD reader mismatch: ${file}`);
    return { file, sha256: sha };
  });
  console.log(
    JSON.stringify(
      {
        overlaid,
        upstreamSha,
        baseSha: git(base, "rev-parse", "HEAD"),
        toolingSha: git(head, "rev-parse", "HEAD"),
        tooling,
        collectorBefore,
        collectorAfter: digest(read(base, COLLECTOR)),
        baseProductHash: after,
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
