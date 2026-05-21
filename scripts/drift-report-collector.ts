/// <reference types="node" />

/**
 * Drift Report Collector
 *
 * Runs the drift test suite via subprocess with JSON reporter, parses the
 * structured output, and writes a drift-report.json file that downstream
 * scripts can use to construct auto-fix prompts.
 *
 * Exit codes:
 *   0 — no critical diffs found (or no drift at all)
 *   2 — at least one critical diff exists
 *   1 — script error (unhandled exception)
 *
 * Usage:
 *   npx tsx scripts/drift-report-collector.ts [--out drift-report.json]
 */

import { execSync } from "node:child_process";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { DriftEntry, DriftReport, DriftSeverity, ParsedDiff } from "./drift-types.js";

// ---------------------------------------------------------------------------
// Vitest JSON reporter types (subset we care about)
// ---------------------------------------------------------------------------

interface VitestJsonResult {
  testResults: VitestTestFile[];
}

interface VitestTestFile {
  assertionResults: VitestAssertion[];
}

interface VitestAssertion {
  status: string;
  ancestorTitles: string[];
  title: string;
  failureMessages: string[];
}

// ---------------------------------------------------------------------------
// Provider → file mapping
// ---------------------------------------------------------------------------

interface ProviderMapping {
  builderFile: string;
  builderFunctions: string[];
  typesFile: string | null;
  sdkShapesFile?: string;
}

const OPENAI_CHAT_MAPPING: ProviderMapping = {
  builderFile: "src/helpers.ts",
  builderFunctions: [
    "buildTextCompletion",
    "buildToolCallCompletion",
    "buildTextChunks",
    "buildToolCallChunks",
  ],
  typesFile: "src/types.ts",
};

const OPENAI_RESPONSES_MAPPING: ProviderMapping = {
  builderFile: "src/responses.ts",
  builderFunctions: [
    "buildTextResponse",
    "buildToolCallResponse",
    "buildTextStreamEvents",
    "buildToolCallStreamEvents",
  ],
  typesFile: null,
};

const ANTHROPIC_MAPPING: ProviderMapping = {
  builderFile: "src/messages.ts",
  builderFunctions: [
    "buildClaudeTextResponse",
    "buildClaudeToolCallResponse",
    "buildClaudeTextStreamEvents",
    "buildClaudeToolCallStreamEvents",
  ],
  typesFile: null,
};

const GEMINI_MAPPING: ProviderMapping = {
  builderFile: "src/gemini.ts",
  builderFunctions: [
    "buildGeminiTextResponse",
    "buildGeminiToolCallResponse",
    "buildGeminiTextStreamChunks",
    "buildGeminiToolCallStreamChunks",
  ],
  typesFile: null,
};

const OPENAI_EMBEDDINGS_MAPPING: ProviderMapping = {
  builderFile: "src/helpers.ts",
  builderFunctions: ["buildEmbeddingResponse", "generateDeterministicEmbedding"],
  typesFile: null,
  sdkShapesFile: "src/__tests__/drift/sdk-shapes.ts",
};

/**
 * Maps provider names (from drift test describe blocks) to source files
 * and builder function names. The function names are builder functions for
 * each provider (internal or exported) — they are included so Claude Code
 * can locate them via Read/Grep.
 */
const PROVIDER_MAP: Record<string, ProviderMapping> = {
  "OpenAI Chat": OPENAI_CHAT_MAPPING,
  "OpenAI Responses": OPENAI_RESPONSES_MAPPING,
  Anthropic: ANTHROPIC_MAPPING,
  "Anthropic Claude": ANTHROPIC_MAPPING,
  "Google Gemini": GEMINI_MAPPING,
  Gemini: GEMINI_MAPPING,
  "OpenAI Realtime": {
    builderFile: "src/ws-realtime.ts",
    builderFunctions: ["handleWebSocketRealtime", "realtimeItemsToMessages"],
    typesFile: null,
  },
  "OpenAI Responses WS": {
    builderFile: "src/ws-responses.ts",
    builderFunctions: ["handleWebSocketResponses"],
    typesFile: null,
  },
  "Gemini Live": {
    builderFile: "src/ws-gemini-live.ts",
    builderFunctions: ["handleWebSocketGeminiLive"],
    typesFile: null,
  },
  "OpenAI Embeddings": OPENAI_EMBEDDINGS_MAPPING,
  "Gemini Interactions": {
    builderFile: "src/gemini-interactions.ts",
    builderFunctions: [
      "buildInteractionsTextResponse",
      "buildInteractionsToolCallResponse",
      "buildInteractionsContentWithToolCallsResponse",
      "buildInteractionsTextSSEEvents",
      "buildInteractionsToolCallSSEEvents",
      "buildInteractionsContentWithToolCallsSSEEvents",
    ],
    typesFile: null,
  },
};

const SDK_SHAPES_FILE = "src/__tests__/drift/sdk-shapes.ts";

// ---------------------------------------------------------------------------
// AG-UI schema drift constants
// ---------------------------------------------------------------------------

const AGUI_TYPES_FILE = "src/agui-types.ts";
const AGUI_DRIFT_TEST = "src/__tests__/drift/agui-schema.drift.ts";

// ---------------------------------------------------------------------------
// Parse the formatted drift report text from a vitest failure message
// ---------------------------------------------------------------------------

/**
 * Parse a drift report block from raw vitest failure message content.
 *
 * The input is a raw vitest failureMessages string that may contain error boilerplate.
 * The function scans for the API DRIFT DETECTED header and numbered entries.
 *
 * Expected format within the message (produced by formatDriftReport):
 * ```
 * API DRIFT DETECTED: OpenAI Chat (non-streaming text)
 *
 *   1. [critical] LLMOCK DRIFT — field in SDK + real API but missing from mock
 *      Path:    choices[0].message.refusal
 *      SDK:     null
 *      Real:    null
 *      Mock:    <absent>
 * ```
 */
const VALID_SEVERITIES = new Set<DriftSeverity>(["critical", "warning", "info"]);

function parseDriftBlock(text: string): { context: string; diffs: ParsedDiff[] } | null {
  const headerMatch = text.match(/API DRIFT DETECTED:\s*(.+)/);
  if (!headerMatch) return null;

  const context = headerMatch[1].trim();
  const diffs: ParsedDiff[] = [];

  // Match numbered entries: "  1. [severity] issue text\n     Path:...\n     SDK:...\n     Real:...\n     Mock:..."
  const entryPattern =
    /\d+\.\s*\[(\w+)\]\s*(.+)\n\s*Path:\s*(.+)\n\s*SDK:\s*(.+)\n\s*Real:\s*(.+)\n\s*Mock:\s*(.+)/g;

  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(text)) !== null) {
    const severity = match[1].trim();
    if (!VALID_SEVERITIES.has(severity as DriftSeverity)) {
      console.warn(
        `parseDriftBlock: unknown severity "${severity}" — skipping entry. ` +
          `Known severities: ${[...VALID_SEVERITIES].join(", ")}`,
      );
      continue;
    }
    diffs.push({
      severity: severity as DriftSeverity,
      issue: match[2].trim(),
      path: match[3].trim(),
      expected: match[4].trim(),
      real: match[5].trim(),
      mock: match[6].trim(),
    });
  }

  const expectedCount = (text.match(/\d+\.\s*\[/g) ?? []).length;
  if (expectedCount > 0 && diffs.length < expectedCount) {
    console.warn(`parseDriftBlock: parsed ${diffs.length} of ${expectedCount} entries`);
  }

  return { context, diffs };
}

/**
 * Extract provider name from the describe block title or the drift report context.
 *
 * Examples:
 *   "OpenAI Chat Completions drift" → "OpenAI Chat"
 *   "OpenAI Chat (non-streaming text)" → "OpenAI Chat"
 *   "Anthropic Claude drift" → "Anthropic Claude"
 */
function extractProviderName(text: string): string | null {
  // Try matching against known provider keys (longest first to avoid partial matches)
  const sorted = Object.keys(PROVIDER_MAP).sort((a, b) => b.length - a.length);
  for (const key of sorted) {
    if (text.includes(key)) return key;
  }
  return null;
}

/**
 * Extract scenario from the context string.
 *
 * "OpenAI Chat (non-streaming text)" → "non-streaming text"
 * "Anthropic Claude (streaming tool call)" → "streaming tool call"
 */
function extractScenario(context: string): string {
  const parenMatch = context.match(/\(([^)]+)\)/);
  return parenMatch ? parenMatch[1] : context;
}

// ---------------------------------------------------------------------------
// Run drift tests and collect results
// ---------------------------------------------------------------------------

function extractJsonFromString(text: string): VitestJsonResult | null {
  const jsonStart = text.indexOf("{");
  const jsonEnd = text.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1) return null;
  try {
    const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray((parsed as Record<string, unknown>).testResults)
    ) {
      console.error(
        "extractJsonFromString: parsed JSON does not have testResults array, likely wrong fragment",
      );
      return null;
    }
    return parsed as VitestJsonResult;
  } catch (err: unknown) {
    console.error(
      "extractJsonFromString: failed to parse.",
      `Range: [${jsonStart}..${jsonEnd}], length: ${text.length}`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

function hasStdout(err: unknown): err is { stdout: string; stderr?: string } {
  return (
    typeof err === "object" &&
    err !== null &&
    "stdout" in err &&
    typeof (err as { stdout: unknown }).stdout === "string"
  );
}

function parseVitestOutput(stdout: string, context: string): VitestJsonResult | null {
  try {
    return JSON.parse(stdout) as VitestJsonResult;
  } catch (parseErr: unknown) {
    console.error(
      `${context}:`,
      parseErr instanceof Error ? parseErr.message : String(parseErr),
      `stdout length: ${stdout.length}`,
    );
    return extractJsonFromString(stdout);
  }
}

function runDriftTests(): VitestJsonResult {
  try {
    const stdout = execSync("npx vitest run --config vitest.config.drift.ts --reporter=json", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 50 * 1024 * 1024,
    });
    const result = parseVitestOutput(stdout, "JSON parse of successful vitest run failed");
    if (result) return result;
    throw new Error("Drift tests passed but produced unparseable output");
  } catch (err: unknown) {
    // execSync throws on non-zero exit — vitest exits 1 when tests fail
    if (hasStdout(err)) {
      const result = parseVitestOutput(err.stdout, "Primary JSON parse of vitest stdout failed");
      if (result) return result;
      console.error(
        "Failed to parse JSON from drift test stdout. Original error:",
        err instanceof Error ? err.message : String(err),
      );
      if (err.stderr) console.error("stderr:", err.stderr);
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to run drift tests: ${msg}`);
  }
}

function collectDriftEntries(results: VitestJsonResult): DriftEntry[] {
  const entries: DriftEntry[] = [];
  const unmapped: string[] = [];
  let unparseable = 0;

  for (const file of results.testResults) {
    for (const assertion of file.assertionResults) {
      if (assertion.status !== "failed") continue;
      if (assertion.failureMessages.length === 0) continue;

      const fullMessage = assertion.failureMessages.join("\n");
      const parsed = parseDriftBlock(fullMessage);
      if (!parsed || parsed.diffs.length === 0) {
        unparseable++;
        continue;
      }

      // Determine provider from ancestor titles (describe block) or context
      const ancestorText = assertion.ancestorTitles.join(" ");
      const provider = extractProviderName(ancestorText) ?? extractProviderName(parsed.context);
      if (!provider) {
        unmapped.push(`${ancestorText} > ${assertion.title}`);
        continue;
      }

      const mapping = PROVIDER_MAP[provider];
      if (!mapping) {
        unmapped.push(`${ancestorText} > ${assertion.title} (provider: ${provider})`);
        continue;
      }

      entries.push({
        provider,
        scenario: extractScenario(parsed.context),
        builderFile: mapping.builderFile,
        builderFunctions: mapping.builderFunctions,
        typesFile: mapping.typesFile,
        sdkShapesFile: SDK_SHAPES_FILE,
        diffs: parsed.diffs,
      });
    }
  }

  if (unmapped.length > 0) {
    console.error(`ERROR: ${unmapped.length} drift failure(s) could not be mapped to a provider:`);
    for (const u of unmapped) console.error(`  - ${u}`);
    throw new Error(`${unmapped.length} unmapped drift entries — update PROVIDER_MAP`);
  }

  if (unparseable > 0 && entries.length === 0) {
    // Collect the unparseable failure messages to classify them
    const unparseableMessages: string[] = [];
    for (const file of results.testResults) {
      for (const assertion of file.assertionResults) {
        if (assertion.status !== "failed" || assertion.failureMessages.length === 0) continue;
        const fullMessage = assertion.failureMessages.join("\n");
        const parsed = parseDriftBlock(fullMessage);
        if (!parsed || parsed.diffs.length === 0) {
          unparseableMessages.push(fullMessage);
        }
      }
    }

    for (const msg of unparseableMessages) {
      console.warn(`  Unparseable failure message (first 300 chars): ${msg.slice(0, 300)}`);
    }

    // Distinguish infrastructure errors from broken drift report formats
    const infraIndicators = [
      /API returned \d{3}/i,
      /status \d{3}/i,
      /<!DOCTYPE/i,
      /<html/i,
      /failed to parse JSON/i,
      /empty response/i,
      /fetch failed/i,
      /ECONNREFUSED/i,
      /ETIMEDOUT/i,
      /ENOTFOUND/i,
      /network error/i,
      /API unavailable/i,
      /returned no SSE events/i,
      /returned empty body/i,
      /waitUntil timeout/i,
      /AssertionError/i,
      /^Error:/m,
      /at\s+\S+\s+\(file:/,
      /STACK_TRACE_ERROR/,
    ];
    const driftLikeIndicators = [/drift/i, /mismatch/i, /expected.*but/i, /LLMOCK DRIFT/i];

    const allInfraErrors = unparseableMessages.every((msg) =>
      infraIndicators.some((re) => re.test(msg)),
    );
    const anyDriftLike = unparseableMessages.some((msg) =>
      driftLikeIndicators.some((re) => re.test(msg)),
    );

    if (allInfraErrors && !anyDriftLike) {
      console.warn(
        `WARNING: ${unparseable} test failure(s) appear to be API/infrastructure errors ` +
          `(not drift reports). Continuing with 0 drift entries.`,
      );
    } else {
      console.error(
        `ERROR: ${unparseable} test failure(s) could not be parsed as drift reports.`,
        "This may indicate broken test infrastructure or a changed report format.",
      );
      throw new Error(
        `${unparseable} unparseable test failures with 0 drift entries — investigate`,
      );
    }
  } else if (unparseable > 0) {
    console.warn(
      `WARNING: ${unparseable} test failure(s) did not contain parseable drift data (${entries.length} drift entries collected).`,
    );
  }

  return entries;
}

// ---------------------------------------------------------------------------
// AG-UI schema drift: run and collect
// ---------------------------------------------------------------------------

/**
 * Attempt to run the AG-UI schema drift test and collect results.
 *
 * The ag-ui schema drift test requires the canonical ag-ui repo to be
 * cloned at `../ag-ui` relative to the project root. If it isn't present,
 * we clone it (shallow, depth=1) before running the test.
 *
 * Returns drift entries in the same DriftEntry format as HTTP API drift,
 * or an empty array if the canonical repo is unavailable or tests pass.
 */
function ensureAgUiRepo(): boolean {
  const agUiPath = resolve("..", "ag-ui");
  try {
    if (existsSync(agUiPath) && statSync(agUiPath).isDirectory()) {
      return true;
    }
  } catch (statErr: unknown) {
    const msg = statErr instanceof Error ? statErr.message : String(statErr);
    console.warn(`Could not stat AG-UI repo path: ${msg}`);
  }
  {
    // Not present — try to clone
    console.log("AG-UI canonical repo not found. Cloning...");
    try {
      execSync("git clone --depth 1 https://github.com/ag-ui-protocol/ag-ui.git ../ag-ui", {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 60_000,
      });
      console.log("AG-UI repo cloned successfully.");
      return true;
    } catch (cloneErr: unknown) {
      const msg = cloneErr instanceof Error ? cloneErr.message : String(cloneErr);
      console.warn(`Could not clone AG-UI repo: ${msg}`);
      console.warn("AG-UI schema drift detection will be skipped.");
      return false;
    }
  }
}

function runAgUiDriftTests(): VitestJsonResult | null {
  if (!ensureAgUiRepo()) return null;

  try {
    const stdout = execSync(
      `npx vitest run ${AGUI_DRIFT_TEST} --config vitest.config.drift.ts --reporter=json`,
      {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        maxBuffer: 50 * 1024 * 1024,
      },
    );
    const result = parseVitestOutput(stdout, "AG-UI drift JSON parse of successful run failed");
    if (result) return result;
    // Tests passed, no failures — return empty result
    return { testResults: [] };
  } catch (err: unknown) {
    if (hasStdout(err)) {
      const result = parseVitestOutput(err.stdout, "AG-UI drift JSON parse of failed run");
      if (result) return result;
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`AG-UI schema drift tests failed to run: ${msg}`);
    return null;
  }
}

/**
 * Parse AG-UI schema drift failures into DriftEntry objects.
 *
 * The ag-ui schema drift test produces failure messages like:
 *   - `[CRITICAL] Event type "X" exists in canonical but missing from aimock`
 *   - `[CRITICAL] EventType: field "fieldName" (...) exists in canonical but missing from aimock`
 *   - `[WARNING] EventType: field "fieldName" optionality mismatch`
 *
 * These are converted to DriftEntry objects that point at `src/agui-types.ts`
 * as the builder file (the file that needs fixing).
 */
function collectAgUiDriftEntries(results: VitestJsonResult): DriftEntry[] {
  const entries: DriftEntry[] = [];

  // Accumulate all diffs across assertions into a single entry per scenario
  const missingTypesDiffs: ParsedDiff[] = [];
  const fieldDriftDiffs: ParsedDiff[] = [];

  for (const file of results.testResults) {
    for (const assertion of file.assertionResults) {
      if (assertion.status !== "failed") continue;
      if (assertion.failureMessages.length === 0) continue;

      const fullMessage = assertion.failureMessages.join("\n");
      const testName = assertion.title || assertion.ancestorTitles.join(" > ");

      // Track whether THIS assertion extracted any structured data
      const missingTypesBefore = missingTypesDiffs.length;
      const fieldDriftBefore = fieldDriftDiffs.length;

      // Parse missing event types: [CRITICAL] Event type "X" exists in canonical...
      const missingTypePattern =
        /\[CRITICAL\]\s*Event type "(\w+)" exists in canonical @ag-ui\/core but is missing from aimock/g;
      let match: RegExpExecArray | null;
      while ((match = missingTypePattern.exec(fullMessage)) !== null) {
        missingTypesDiffs.push({
          severity: "critical",
          issue: `AG-UI event type missing from aimock AGUIEventType union`,
          path: `AGUIEventType.${match[1]}`,
          expected: match[1],
          real: match[1],
          mock: "<absent>",
        });
      }

      // Parse missing fields: [CRITICAL] EventType: field "fieldName" (...) exists in canonical but missing
      const missingFieldPattern =
        /\[CRITICAL\]\s*(\w+):\s*field "(\w+)"\s*\(([^)]*)\)\s*exists in canonical but missing from aimock/g;
      while ((match = missingFieldPattern.exec(fullMessage)) !== null) {
        fieldDriftDiffs.push({
          severity: "critical",
          issue: `AG-UI event field missing from aimock interface`,
          path: `AGUI${match[1]}Event.${match[2]}`,
          expected: `${match[2]} (${match[3]})`,
          real: `${match[2]} (${match[3]})`,
          mock: "<absent>",
        });
      }

      // TODO: Optionality drift is not currently collected because the drift
      // test only emits optionality mismatches via console.warn(), not via
      // failing assertions. If the drift test is updated to include
      // optionality in assertion failure messages, add parsing here.

      // If THIS assertion did not extract any structured data, try a generic fallback
      const thisAssertionExtracted =
        missingTypesDiffs.length > missingTypesBefore || fieldDriftDiffs.length > fieldDriftBefore;
      if (
        !thisAssertionExtracted &&
        (fullMessage.includes("Missing event types") ||
          fullMessage.includes("Critical field drift"))
      ) {
        // Generic critical failure from the ag-ui schema drift test
        missingTypesDiffs.push({
          severity: "critical",
          issue: `AG-UI schema drift detected in test: ${testName}`,
          path: "AGUIEventType",
          expected: "(see test output)",
          real: "(see test output)",
          mock: "(see test output)",
        });
      }
    }
  }

  if (missingTypesDiffs.length > 0) {
    entries.push({
      provider: "AG-UI",
      scenario: "missing event types",
      builderFile: AGUI_TYPES_FILE,
      builderFunctions: ["AGUIEventType"],
      typesFile: AGUI_TYPES_FILE,
      sdkShapesFile: AGUI_DRIFT_TEST,
      diffs: missingTypesDiffs,
    });
  }

  if (fieldDriftDiffs.length > 0) {
    entries.push({
      provider: "AG-UI",
      scenario: "event field shapes",
      builderFile: AGUI_TYPES_FILE,
      builderFunctions: ["AGUI*Event interfaces"],
      typesFile: AGUI_TYPES_FILE,
      sdkShapesFile: AGUI_DRIFT_TEST,
      diffs: fieldDriftDiffs,
    });
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const outPath = resolve(
    outIndex !== -1 && args[outIndex + 1] ? args[outIndex + 1] : "drift-report.json",
  );

  // Collect HTTP API drift entries
  console.log("Running HTTP API drift tests...");
  const httpResults = runDriftTests();
  console.log("Collecting HTTP API drift entries...");
  const httpEntries = collectDriftEntries(httpResults);

  // Collect AG-UI schema drift entries
  console.log("Running AG-UI schema drift tests...");
  const agUiResults = runAgUiDriftTests();
  const agUiSkipped = agUiResults === null;
  let agUiEntries: DriftEntry[] = [];
  if (agUiResults) {
    console.log("Collecting AG-UI schema drift entries...");
    agUiEntries = collectAgUiDriftEntries(agUiResults);
  } else {
    console.warn("WARNING: AG-UI schema drift tests could not run — results will be incomplete.");
  }

  const entries = [...httpEntries, ...agUiEntries];

  const report: DriftReport = {
    timestamp: new Date().toISOString(),
    entries,
  };

  try {
    writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n", "utf-8");
  } catch (err) {
    console.error(`Failed to write drift report to ${outPath}:`, err);
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }
  console.log(`Drift report written to ${outPath}`);
  console.log(`  HTTP API entries: ${httpEntries.length}`);
  if (agUiSkipped) {
    console.log(`  AG-UI schema entries: SKIPPED (could not run tests)`);
  } else {
    console.log(`  AG-UI schema entries: ${agUiEntries.length}`);
  }
  console.log(`  Total entries: ${entries.length}`);

  const criticalCount = entries.reduce(
    (sum, e) => sum + e.diffs.filter((d) => d.severity === "critical").length,
    0,
  );
  console.log(`  Critical diffs: ${criticalCount}`);

  if (criticalCount > 0) {
    console.log("Exiting with code 2 (critical diffs found).");
    process.exit(2);
  }

  if (agUiSkipped) {
    console.warn("Exiting with code 1 (AG-UI drift detection was skipped — infra failure).");
    process.exit(1);
  }

  console.log("No critical diffs found.");
}

try {
  main();
} catch (err: unknown) {
  console.error("Fatal error:", err);
  process.exit(1);
}
