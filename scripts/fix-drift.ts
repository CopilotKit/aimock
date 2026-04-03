/// <reference types="node" />

/**
 * Drift Fix Orchestrator
 *
 * Reads a drift-report.json (produced by drift-report-collector.ts), constructs
 * a structured prompt, and invokes Claude Code CLI to auto-fix the drift.
 *
 * Modes:
 *   Default:       npx tsx scripts/fix-drift.ts
 *   PR mode:       npx tsx scripts/fix-drift.ts --create-pr
 *   Issue mode:    npx tsx scripts/fix-drift.ts --create-issue
 *
 * Exit codes:
 *   0 — success (or issue created successfully in --create-issue mode)
 *   1 — failure
 *   2 — no source files changed (--create-pr mode, nothing to commit)
 *   3 — unhandled error (e.g. bad arguments, missing report, git/gh command failure)
 *   124 — Claude Code timed out (default mode)
 *   In default mode, the exit code is passed through from Claude Code.
 */

import { spawn, execSync, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { DriftReport, DriftSeverity } from "./drift-types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 30-minute hard ceiling for the Claude Code subprocess */
const CLAUDE_TIMEOUT_MS = 30 * 60 * 1000;

/** Grace period between SIGTERM and SIGKILL */
const KILL_GRACE_MS = 10_000;

const VALID_SEVERITIES: ReadonlySet<DriftSeverity> = new Set(["critical", "warning", "info"]);

const SKILL_FILE = "skills/write-fixtures/SKILL.md";

/**
 * Map builder source files to the corresponding section names in the
 * write-fixtures skill documentation.  Used to flag which skill sections
 * may need updating when a drift fix changes a builder's output format.
 */
export const BUILDER_TO_SKILL_SECTION: Record<string, string> = {
  "src/responses.ts": "Responses API",
  "src/messages.ts": "Claude Messages",
  "src/gemini.ts": "Gemini",
  "src/bedrock.ts": "Bedrock",
  "src/bedrock-converse.ts": "Bedrock",
  "src/embeddings.ts": "Embeddings",
  "src/ollama.ts": "Ollama",
  "src/cohere.ts": "Cohere",
  "src/ws-realtime.ts": "OpenAI Realtime WebSocket",
  "src/ws-responses.ts": "OpenAI Responses WebSocket",
  "src/ws-gemini-live.ts": "Gemini Live WebSocket",
  "src/helpers.ts": "OpenAI Chat Completions",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Format an exec error into a human-readable Error object.
 * Includes exit status, signal, and stderr when available.
 * Logs stderr to console.error as a side effect when present.
 */
function formatExecError(cmd: string, err: unknown): Error {
  const e = err as { status?: number; signal?: string; stderr?: string | Buffer };
  const detail = [
    e.status !== undefined ? `exit ${e.status}` : null,
    e.signal ? `signal ${e.signal}` : null,
    e.stderr ? String(e.stderr).trim() : null,
  ]
    .filter(Boolean)
    .join(", ");
  const msg = `Command failed: ${cmd}${detail ? ` (${detail})` : ""}`;
  if (e.stderr) console.error(msg);
  return new Error(msg);
}

/**
 * Run a shell command and return its trimmed stdout.
 *
 * WARNING: This function passes the command string directly to a shell.
 * NEVER call it with interpolated values — use execFileSafe() for commands
 * with dynamic arguments.
 */
function exec(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch (err: unknown) {
    throw formatExecError(cmd, err);
  }
}

/**
 * Run a command safely without shell interpolation.
 * Use this for all commands with dynamic arguments.
 */
export function execFileSafe(file: string, args: string[]): void {
  try {
    execFileSync(file, args, { stdio: "inherit" });
  } catch (err: unknown) {
    throw formatExecError(`${file} ${args.join(" ")}`, err);
  }
}

/**
 * Given a list of changed file paths, return the unique skill section names
 * that correspond to modified builder files.  Returns an empty array when
 * no builder files map to a known skill section.
 */
export function affectedSkillSections(changedFiles: string[]): string[] {
  const sections = new Set<string>();
  for (const file of changedFiles) {
    const section = BUILDER_TO_SKILL_SECTION[file];
    if (section) sections.add(section);
  }
  return [...sections].sort();
}

export function readFileIfExists(path: string): string | null {
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf-8");
}

export function readDriftReport(path: string): DriftReport {
  if (!existsSync(path)) {
    throw new Error(`Drift report not found at ${path}`);
  }
  const raw = readFileSync(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    throw new Error(
      `Drift report at ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as Record<string, unknown>).entries)
  ) {
    throw new Error(`Drift report at ${path} has invalid structure: expected { entries: [...] }`);
  }
  if (typeof (parsed as Record<string, unknown>).timestamp !== "string") {
    throw new Error('Drift report missing "timestamp" field');
  }
  const report = parsed as DriftReport;

  // Validate individual entry fields to catch malformed reports early
  for (let i = 0; i < report.entries.length; i++) {
    const entry = report.entries[i];
    if (!entry || typeof entry.provider !== "string" || !entry.provider) {
      throw new Error(`Drift report entry[${i}] missing required "provider" field`);
    }
    if (!entry.builderFile || typeof entry.builderFile !== "string") {
      throw new Error(`Drift report entry[${i}] (${entry.provider}) missing "builderFile"`);
    }
    if (
      !Array.isArray(entry.builderFunctions) ||
      entry.builderFunctions.length === 0 ||
      !entry.builderFunctions.every((f: unknown) => typeof f === "string")
    ) {
      throw new Error(
        `Drift report entry[${i}] (${entry.provider}) "builderFunctions" must be non-empty string array`,
      );
    }
    if (!entry.scenario || typeof entry.scenario !== "string") {
      throw new Error(`Drift report entry[${i}] (${entry.provider}) missing "scenario"`);
    }
    if (!entry.sdkShapesFile || typeof entry.sdkShapesFile !== "string") {
      throw new Error(`Drift report entry[${i}] (${entry.provider}) missing "sdkShapesFile"`);
    }
    if (entry.typesFile !== null && typeof entry.typesFile !== "string") {
      throw new Error(
        `Drift report entry[${i}] (${entry.provider}) "typesFile" must be string or null`,
      );
    }
    if (!Array.isArray(entry.diffs)) {
      throw new Error(`Drift report entry[${i}] (${entry.provider}) missing "diffs" array`);
    }
    for (let j = 0; j < entry.diffs.length; j++) {
      const diff = entry.diffs[j];
      if (!diff.path || typeof diff.path !== "string") {
        throw new Error(`Drift report entry[${i}].diffs[${j}]: missing "path"`);
      }
      if (!diff.issue || typeof diff.issue !== "string") {
        throw new Error(`Drift report entry[${i}].diffs[${j}]: missing "issue"`);
      }
      if (typeof diff.expected !== "string") {
        throw new Error(`Drift report entry[${i}].diffs[${j}]: missing "expected"`);
      }
      if (typeof diff.real !== "string") {
        throw new Error(`Drift report entry[${i}].diffs[${j}]: missing "real"`);
      }
      if (typeof diff.mock !== "string") {
        throw new Error(`Drift report entry[${i}].diffs[${j}]: missing "mock"`);
      }
      if (!VALID_SEVERITIES.has(diff.severity)) {
        throw new Error(
          `Drift report entry[${i}].diffs[${j}]: invalid severity "${diff.severity}" — expected one of: ${[...VALID_SEVERITIES].join(", ")}`,
        );
      }
    }
  }

  return report;
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

export function buildPrompt(report: DriftReport): string {
  const lines: string[] = [];

  lines.push("You are fixing API drift in the aimock mock server.");
  lines.push("");
  lines.push("## Workflow");
  lines.push("");
  lines.push("Follow this exact workflow for each drift fix:");
  lines.push("");
  lines.push("1. RED: Confirm the drift test currently fails by running:");
  lines.push('   pnpm test:drift 2>&1 | grep -A5 "DRIFT"');
  lines.push("");
  lines.push("2. Fix the builder function to add/modify the field matching the real API shape.");
  lines.push("   Also fix the corresponding builder for the same provider (e.g., if non-streaming");
  lines.push("   text drifted, also fix non-streaming tool call since they share the same message");
  lines.push("   structure).");
  lines.push("");
  lines.push("3. If the builder file uses TypeScript interfaces from src/types.ts, update those.");
  lines.push("");
  lines.push("4. Update the SDK shape in src/__tests__/drift/sdk-shapes.ts if the corresponding");
  lines.push("   shape function doesn't include the new field.");
  lines.push("");
  lines.push("5. GREEN: Run pnpm test to verify conformance tests pass.");
  lines.push("");
  lines.push("6. Run pnpm test:drift to verify drift is resolved.");
  lines.push("");
  lines.push("7. Run npx prettier --write on all changed files.");
  lines.push("");
  lines.push("8. REFACTOR: Review your changes for unnecessary complexity.");
  lines.push("");
  lines.push("## Drift Entries");
  lines.push("");

  for (let i = 0; i < report.entries.length; i++) {
    const entry = report.entries[i];
    lines.push(`DRIFT ${i + 1}: ${entry.provider} — ${entry.scenario}`);
    lines.push(`  File: ${entry.builderFile}`);
    lines.push(`  Functions: ${entry.builderFunctions.join(", ")}`);
    lines.push(`  Types file: ${entry.typesFile ?? "N/A"}`);
    lines.push(`  SDK shapes: ${entry.sdkShapesFile}`);
    lines.push("  Diffs:");
    for (const diff of entry.diffs) {
      lines.push(`    - [${diff.severity}] ${diff.issue}`);
      lines.push(`      Path: ${diff.path}`);
      lines.push(`      Real API: ${diff.real}`);
      lines.push(`      Mock: ${diff.mock}`);
    }
    lines.push("");
  }

  lines.push("## Skill file update");
  lines.push("");
  lines.push("If any builder's output format changed (new fields, renamed fields, changed event");
  lines.push("types), update the write-fixtures skill documentation to match:");
  lines.push(`  File: ${SKILL_FILE}`);
  lines.push("Only update the Response Types and API Endpoints sections that correspond to the");
  lines.push("changed builders. Do not rewrite unrelated sections.");
  lines.push("");
  lines.push("## After all fixes");
  lines.push("");
  lines.push("1. Run the full test suite: pnpm test");
  lines.push("2. Run drift verification: pnpm test:drift");
  lines.push("3. Format: npx prettier --write src/ src/__tests__/");
  lines.push("4. Lint: npx eslint src/ src/__tests__/ --fix");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Claude Code invocation (default mode)
// ---------------------------------------------------------------------------

function invokeClaudeCode(prompt: string): Promise<number> {
  return new Promise((done, reject) => {
    const args = [
      "@anthropic-ai/claude-code",
      "--print",
      "--verbose",
      "-p",
      prompt,
      "--allowedTools",
      [
        "Read",
        "Edit",
        "Write",
        "Glob",
        "Grep",
        "Bash(pnpm test)",
        "Bash(pnpm test:drift)",
        "Bash(pnpm test:drift *)",
        "Bash(npx prettier *)",
        "Bash(npx eslint *)",
        "Bash(git diff *)",
        "Bash(git status *)",
        "Bash(git log *)",
      ].join(","),
      "--max-turns",
      "50",
    ];

    const child = spawn("npx", args, {
      stdio: ["inherit", "pipe", "pipe"],
    });

    const logChunks: Buffer[] = [];
    let killGraceTimer: NodeJS.Timeout | undefined;
    let timedOut = false;

    const killTimer = setTimeout(() => {
      timedOut = true;
      console.error(
        `Claude Code timed out after ${CLAUDE_TIMEOUT_MS / 60000} minutes. Sending SIGTERM...`,
      );
      child.kill("SIGTERM");
      killGraceTimer = setTimeout(() => {
        if (!child.killed) {
          console.error("Process did not exit after SIGTERM. Sending SIGKILL...");
          child.kill("SIGKILL");
        }
      }, KILL_GRACE_MS);
    }, CLAUDE_TIMEOUT_MS);

    child.on("error", (err) => {
      clearTimeout(killTimer);
      console.error("Failed to spawn Claude Code process:", err.message);
      try {
        writeFileSync("claude-code-output.log", `Spawn error: ${err.message}\n`, "utf-8");
      } catch (writeErr) {
        console.error(
          "Failed to write claude-code-output.log:",
          writeErr instanceof Error ? writeErr.message : writeErr,
        );
      }
      reject(err);
    });

    child.stdout.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
      logChunks.push(chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      logChunks.push(chunk);
    });

    child.on("close", (code, signal) => {
      clearTimeout(killTimer);
      if (killGraceTimer) clearTimeout(killGraceTimer);
      const logContent = Buffer.concat(logChunks).toString("utf-8");
      try {
        writeFileSync("claude-code-output.log", logContent, "utf-8");
      } catch (writeErr) {
        console.error(
          "Failed to write claude-code-output.log:",
          writeErr instanceof Error ? writeErr.message : writeErr,
        );
      }
      if (code === null && signal) {
        console.error(`Claude Code process killed by signal: ${signal}`);
      }
      done(timedOut ? 124 : (code ?? 1));
    });
  });
}

// ---------------------------------------------------------------------------
// PR mode (--create-pr)
// ---------------------------------------------------------------------------

export function patchBumpVersion(): string {
  const pkgPath = resolve("package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
    version: string;
    [key: string]: unknown;
  };
  const parts = pkg.version.split(".").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) {
    throw new Error(`Cannot patch-bump non-standard version: ${pkg.version}`);
  }
  parts[2] += 1;
  const newVersion = parts.join(".");
  pkg.version = newVersion;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
  return newVersion;
}

export function addChangelogEntry(report: DriftReport, version: string): void {
  const changelogPath = resolve("CHANGELOG.md");
  const existing = readFileIfExists(changelogPath) ?? "";

  const providerSummaries = report.entries.map((entry) => {
    const fields = entry.diffs.map((d) => d.path).join(", ");
    return `- ${entry.provider} (${entry.scenario}): ${fields}`;
  });

  const newEntry = [
    `## ${version}`,
    "",
    "### Patch Changes",
    "",
    "- Auto-remediate API drift:",
    ...providerSummaries.map((s) => `  ${s}`),
    "",
  ].join("\n");

  // Insert after the first line (the title)
  const titleLine = "# @copilotkit/aimock\n";
  if (existing.startsWith(titleLine)) {
    const rest = existing.slice(titleLine.length);
    writeFileSync(changelogPath, titleLine + "\n" + newEntry + rest, "utf-8");
  } else {
    writeFileSync(changelogPath, newEntry + "\n" + existing, "utf-8");
  }
}

export function buildPrBody(report: DriftReport, changedFiles?: string[]): string {
  const providers: string[] = [];
  const diffs: string[] = [];

  for (const entry of report.entries) {
    providers.push(`- ${entry.provider}: ${entry.scenario}`);
    for (const diff of entry.diffs) {
      diffs.push(`- \`${diff.path}\`: ${diff.issue}`);
    }
  }

  const reportJson = JSON.stringify(report, null, 2);

  const sections: string[] = [
    "## Summary",
    "",
    "Auto-generated drift remediation.",
    "",
    "### Providers affected",
    ...providers,
    "",
    "### Diffs fixed",
    ...diffs,
    "",
  ];

  // Flag skill sections that may need review based on which builders changed
  const skillSections = changedFiles ? affectedSkillSections(changedFiles) : [];
  if (skillSections.length > 0) {
    sections.push(
      "### Skill documentation",
      "",
      `The following write-fixtures skill sections may need review after these builder changes:`,
      ...skillSections.map((s) => `- ${s}`),
      "",
    );
  }

  sections.push(
    "## Drift Report",
    "",
    "<details>",
    "<summary>Full drift report JSON</summary>",
    "",
    "```json",
    reportJson,
    "```",
    "",
    "</details>",
  );

  return sections.join("\n");
}

/**
 * Parse a single line from `git status --porcelain` output into a file path.
 * Handles quoted paths (special characters) and rename notation (old -> new).
 */
export function parsePorcelainLine(line: string): string {
  let path = line.slice(3).trim();
  // Handle renames first: "old -> new" → take the new path
  const arrowIdx = path.indexOf(" -> ");
  if (arrowIdx !== -1) {
    path = path.slice(arrowIdx + 4);
  }
  // Then strip quotes (git quotes paths with special characters)
  if (path.startsWith('"') && path.endsWith('"')) {
    path = path.slice(1, -1);
  }
  return path;
}

/**
 * Return the list of changed files from `git status --porcelain`.
 */
export function getChangedFiles(): string[] {
  return exec("git status --porcelain").split("\n").filter(Boolean).map(parsePorcelainLine);
}

function createPr(report: DriftReport): void {
  const stamp = todayStamp();

  // Determine branch name
  let currentBranch: string;
  try {
    currentBranch = exec("git rev-parse --abbrev-ref HEAD");
  } catch (err: unknown) {
    throw new Error(`Cannot determine current branch for PR creation: ${(err as Error).message}`);
  }

  const branchName =
    currentBranch === "master" || currentBranch === "main" || currentBranch === "HEAD"
      ? `fix/drift-${stamp}`
      : currentBranch;

  if (branchName !== currentBranch) {
    execFileSafe("git", ["checkout", "-b", branchName]);
    console.log(`Created branch ${branchName}`);
  }

  // Stage and commit in groups — detect uncommitted changes (staged + unstaged)
  const changedFiles = getChangedFiles();

  const builderFiles = changedFiles.filter(
    (f) => f.startsWith("src/") && !f.startsWith("src/__tests__/"),
  );
  const testFiles = changedFiles.filter((f) => f.startsWith("src/__tests__/"));
  const skillFiles = changedFiles.filter((f) => f.startsWith("skills/"));

  // Abort if no source files were changed — a version-bump-only PR would be misleading
  if (builderFiles.length === 0 && testFiles.length === 0) {
    console.error(
      "ERROR: No source files changed. Claude Code may not have made any fixes, " +
        "or all changes were reverted during verification. Aborting PR creation.",
    );
    process.exit(2);
  }

  if (builderFiles.length > 0) {
    execFileSafe("git", ["add", ...builderFiles]);
    execFileSafe("git", ["commit", "-m", "fix: auto-remediate API drift in builder functions"]);
  }

  if (testFiles.length > 0) {
    execFileSafe("git", ["add", ...testFiles]);
    execFileSafe("git", ["commit", "-m", "test: update SDK shapes for drift remediation"]);
  }

  if (skillFiles.length > 0) {
    execFileSafe("git", ["add", ...skillFiles]);
    execFileSafe("git", [
      "commit",
      "-m",
      "docs: update write-fixtures skill for builder format changes",
    ]);
  }

  const newVersion = patchBumpVersion();
  console.log(`Bumped version to ${newVersion}`);

  addChangelogEntry(report, newVersion);
  console.log("Added CHANGELOG.md entry");

  // Always commit version bump + changelog
  execFileSafe("git", ["add", "package.json", "CHANGELOG.md"]);
  execFileSafe("git", ["commit", "-m", `chore: bump version to ${newVersion}`, "--allow-empty"]);

  // Catch any remaining files
  const remaining = getChangedFiles();
  if (remaining.length > 0) {
    execFileSafe("git", ["add", ...remaining]);
    execFileSafe("git", ["commit", "-m", "fix: remaining drift remediation changes"]);
  }

  execFileSafe("git", ["push", "-u", "origin", branchName]);
  console.log(`Pushed branch ${branchName}`);

  const prBody = buildPrBody(report, changedFiles);
  const prTitle = `fix: auto-remediate API drift (${stamp})`;

  const prBodyFile = `/tmp/aimock-drift-${process.pid}-pr-body.md`;
  writeFileSync(prBodyFile, prBody, "utf-8");
  try {
    execFileSafe("gh", [
      "pr",
      "create",
      "--title",
      prTitle,
      "--assignee",
      "jpr5",
      "--body-file",
      prBodyFile,
    ]);
  } finally {
    try {
      unlinkSync(prBodyFile);
    } catch (cleanupErr) {
      console.warn(
        `Could not clean up temp file:`,
        cleanupErr instanceof Error ? cleanupErr.message : cleanupErr,
      );
    }
  }

  console.log("PR created successfully.");
}

// ---------------------------------------------------------------------------
// Issue mode (--create-issue)
// ---------------------------------------------------------------------------

function createIssue(report: DriftReport | null): void {
  const stamp = todayStamp();
  const reportJson = report
    ? JSON.stringify(report, null, 2)
    : "(drift report was not generated — collector may have crashed)";
  const claudeOutput =
    readFileIfExists(resolve("claude-code-output.log")) ?? "(no output captured)";

  const issueBody = [
    "## Drift detected but auto-fix failed",
    "",
    "The automated drift remediation pipeline detected API drift but was unable",
    "to fix it automatically. Manual intervention is required.",
    "",
    "### Drift Report",
    "",
    "```json",
    reportJson,
    "```",
    "",
    "### Claude Code Output",
    "",
    "<details>",
    "<summary>Full output</summary>",
    "",
    "```",
    claudeOutput,
    "```",
    "",
    "</details>",
  ].join("\n");

  const issueTitle = `Drift detected — auto-fix failed (${stamp})`;

  const issueBodyFile = `/tmp/aimock-drift-${process.pid}-issue-body.md`;
  writeFileSync(issueBodyFile, issueBody, "utf-8");
  try {
    execFileSafe("gh", [
      "issue",
      "create",
      "--title",
      issueTitle,
      "--body-file",
      issueBodyFile,
      "--label",
      "drift",
    ]);
  } finally {
    try {
      unlinkSync(issueBodyFile);
    } catch (cleanupErr) {
      console.warn(
        `Could not clean up temp file:`,
        cleanupErr instanceof Error ? cleanupErr.message : cleanupErr,
      );
    }
  }

  console.log("Issue created successfully.");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function parseMode(args: string[]): "pr" | "issue" | "default" {
  if (args.includes("--create-pr")) return "pr";
  if (args.includes("--create-issue")) return "issue";
  return "default";
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mode = parseMode(args);

  const reportIndex = args.indexOf("--report");
  const reportPath = resolve(
    reportIndex !== -1 && args[reportIndex + 1] ? args[reportIndex + 1] : "drift-report.json",
  );

  // Issue mode handles missing reports gracefully (the safety net shouldn't crash)
  if (mode === "issue") {
    let report: DriftReport | null = null;
    try {
      report = readDriftReport(reportPath);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`Could not read drift report (${msg}), creating issue with available info`);
    }
    createIssue(report);
    return;
  }

  const report = readDriftReport(reportPath);

  if (report.entries.length === 0) {
    console.log("No drift entries found. Nothing to do.");
    process.exit(0);
  }

  console.log(`Loaded drift report: ${report.entries.length} entries from ${report.timestamp}`);

  if (mode === "pr") {
    createPr(report);
  } else {
    const prompt = buildPrompt(report);
    console.log("Invoking Claude Code CLI...");
    const exitCode = await invokeClaudeCode(prompt);
    console.log(`Claude Code exited with code ${exitCode}`);
    process.exit(exitCode);
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err: unknown) => {
    console.error("Fatal error:", err);
    process.exit(3);
  });
}
