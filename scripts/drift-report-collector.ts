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
import { fileURLToPath } from "node:url";

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

export function parseDriftBlock(text: string): { context: string; diffs: ParsedDiff[] } | null {
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
export function extractProviderName(text: string): string | null {
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
export function extractScenario(context: string): string {
  const parenMatch = context.match(/\(([^)]+)\)/);
  return parenMatch ? parenMatch[1] : context;
}

// ---------------------------------------------------------------------------
// Known-models canary recognizer
// ---------------------------------------------------------------------------

/**
 * Discriminated result of parsing the ws-realtime canary failure.
 *
 * CLASS 3: `ids` holds ONLY genuine model ids (never a prose sentinel). The
 * "some ids were truncated in CI output" fact is a boolean flag, not a fake id,
 * so a non-model annotation can never flow into `DriftEntry.real` downstream.
 *
 * CLASS 2: `noGA` marks the hasGA-false mode — the GA realtime family was
 * renamed/removed or the credential could not see any realtime models. `ids`
 * then carries the OBSERVED realtime models (possibly empty), not "unknown"
 * ones. Either mode is a critical, exit-2 drift signal.
 */
export interface CanaryParseResult {
  ids: string[];
  truncated?: boolean;
  noGA?: boolean;
  /**
   * NO_GA mode only: the unknown-model list observed in the SAME run. Because
   * the hasGA assertion short-circuits the later unknown-models assertion, the
   * NO_GA marker carries both lists (`… | UNKNOWN_REALTIME_MODELS=…`); this
   * field holds the unknown segment so the combined case loses no information.
   */
  unknownIds?: string[];
}

/**
 * Parse the ws-realtime canary assertion failure. Two canary modes exist:
 *
 * 1. UNKNOWN models — `expect(unknown, \`UNKNOWN_REALTIME_MODELS=…\`).toEqual([])`
 *    shape: `AssertionError: UNKNOWN_REALTIME_MODELS=a,b: expected [ 'a', …(1) ]
 *    to deeply equal []`.
 * 2. NO GA models (CLASS 2) — `expect(hasGA, \`NO_GA_REALTIME_MODELS=…\`).toBe(true)`
 *    shape: `AssertionError: NO_GA_REALTIME_MODELS=x,y: expected false to be true`.
 *
 * PRIMARY SOURCE: the `*_REALTIME_MODELS=` marker carries the FULL, non-truncated
 * comma-joined list verbatim (vitest truncates the printed array with `…(N)` /
 * `... (N)`, so ids beyond the first are unrecoverable from the array alone).
 *
 * FALLBACK (unknown-mode only, marker missing/mangled): parse the printed array
 * and set `truncated` when a CI ellipsis is present.
 *
 * Returns a CanaryParseResult, or null if the message is not a canary shape.
 */
export function parseKnownModelsCanary(text: string): CanaryParseResult | null {
  // CLASS 2 PRIMARY: hasGA-false marker. The GA family is gone/unreachable — a
  // critical signal even when the observed list is empty. Recognize it FIRST so
  // the "expected false to be true" shape is a structured entry, not a crash.
  const noGaMatch = text.match(/NO_GA_REALTIME_MODELS=(.*?)(?::\s*expected\b|\n|$)/);
  if (noGaMatch) {
    // The NO_GA marker carries BOTH the observed realtime models AND the
    // unknown-model list observed in the same run, joined as
    // `<observed> | UNKNOWN_REALTIME_MODELS=<unknown>`. Split the two apart so
    // neither list pollutes the other (the combined no-GA + unknown case must
    // not lose the unknown list, since the hasGA assertion short-circuits the
    // later unknown-models assertion). A legacy message without the unknown
    // segment still parses — `split` yields a single element.
    const [observedRaw, unknownRaw] = noGaMatch[1].split(/\s*\|\s*UNKNOWN_REALTIME_MODELS=/);
    const toList = (s: string | undefined): string[] =>
      (s ?? "")
        .split(",")
        .map((v) => v.trim())
        .filter((v) => v.length > 0);
    const ids = toList(observedRaw);
    const unknownIds = toList(unknownRaw);
    return unknownIds.length > 0 ? { ids, noGA: true, unknownIds } : { ids, noGA: true };
  }

  // UNKNOWN-mode PRIMARY: stable marker carrying the full, non-truncated list.
  // Scan the whole message (not just line 0) so a leading blank line cannot hide
  // it. Capture the ENTIRE value up to the vitest boilerplate (`: expected …`)
  // or end-of-line. On a malformed/empty marker we fall THROUGH to the
  // printed-array fallback so a recoverable id in the array is still surfaced.
  const markerMatch = text.match(/UNKNOWN_REALTIME_MODELS=(.*?)(?::\s*expected\b|\n|$)/);
  if (markerMatch) {
    const ids = markerMatch[1]
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (ids.length > 0) return { ids };
  }

  // FALLBACK GATE: the printed-array fallback matches the GENERIC vitest shape
  // `expected [ ... ] to deeply equal []`, which ANY `toEqual([])` assertion in
  // ANY provider's test emits. On its own that shape is NOT a canary signal — a
  // non-canary failure (e.g. a different provider asserting an empty array whose
  // observed value happens to be a secret or an object shape) would otherwise be
  // misclassified as OpenAI-Realtime known-models drift and have its arbitrary
  // array contents relabeled as "unknown model ids". So the fallback fires ONLY
  // when the message is clearly the ws-realtime known-models canary. Two
  // recognizers (either suffices):
  //   1. the realtime-canary marker family (`UNKNOWN_REALTIME_MODELS=` /
  //      `NO_GA_REALTIME_MODELS=`), even mangled/partial — the marker paths
  //      above only fall through here when the marker VALUE was empty/unusable,
  //      but the TOKEN itself still identifies the canary; and
  //   2. the canary's origin file in the stack trace — a real canary failure
  //      ALWAYS carries an `at …/ws-realtime.drift.ts` frame.
  // A generic non-canary `toEqual([])` failure has neither, so it returns null
  // and falls through to the collector's normal unparseable/fail-loud handling.
  const isRealtimeCanaryContext =
    /_REALTIME_MODELS=/.test(text) || /ws-realtime\.drift\.ts/.test(text);
  if (!isRealtimeCanaryContext) return null;

  // FALLBACK: no (usable) marker but a confirmed canary context. Best-effort
  // parse of the printed array on the first line. The canary assertion is always
  // on line 1.
  const firstLine = text.split("\n")[0];

  // Shape: ...: expected [ ... ] to deeply equal []
  const canaryMatch = firstLine.match(/expected\s*\[([^\]]*)\]\s*to deeply equal \[\]/);
  if (!canaryMatch) return null;

  const inner = canaryMatch[1].trim();

  // Extract quoted model ids from the bracket list
  const ids: string[] = [];
  const idPattern = /'([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = idPattern.exec(inner)) !== null) {
    ids.push(m[1]);
  }

  // CI truncation marker in BOTH forms: single-glyph `…(N)` and three-dot ASCII
  // `... (N)`. CLASS 3: this is a BOOLEAN flag — never a synthetic id.
  const truncated = /(?:…|\.{3})\s*\(\d+\)/.test(inner);

  // A genuinely-empty inner list with no truncation (`expected [] to deeply
  // equal []`) means the canary's `unknown` array was empty — no drift to
  // surface. Return null so it is not a spurious entry.
  if (ids.length === 0 && !truncated) return null;

  return truncated ? { ids, truncated: true } : { ids };
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

/**
 * Distinguish genuine infrastructure errors from genuine-but-unparseable drift
 * reports. Returns true when the whole batch of unparseable messages should be
 * SWALLOWED as benign infra (collector exits 0); false means genuine drift is
 * present and the collector must throw.
 *
 * A false "infra" classification here is dangerous: it makes the collector exit
 * 0 and silently drop real drift.
 *
 * F2: `/AssertionError/i` is DELIBERATELY NOT an infra indicator. Every vitest
 * drift failure is an AssertionError, so treating it as benign infra masks real
 * drift. Infra failures announce themselves with network/HTTP/parse markers
 * below; a bare AssertionError is drift until proven infra.
 *
 * A3: BOTH the infra-indicator scan and the drift-like scan run against the
 * SAME normalized text (stack-trace `  at …` frames stripped). An earlier
 * version scanned the RAW message for infra indicators but the stack-stripped
 * message for drift indicators; that asymmetry could tip the benign-infra gate
 * true and silently drop genuine drift. Normalizing both identically keeps the
 * two scans from ever disagreeing on the same input.
 */
// Infra indicators. IMPORTANT (CLASS 1 / uniform anchoring): every infra
// indicator is defined here as a BARE phrase (the source string only, no `^`,
// no flags, no anchoring-defeating `(?:.*:\s*)?` prefix). The line-anchor is
// applied UNIFORMLY by `anchorInfraIndicator` below, so no single indicator can
// be individually mis-anchored and a phrase added to this list later is
// automatically anchored the same way as its siblings.
//
// The anchor requires the phrase to BE the failure reason at the START of a
// line (optional leading whitespace, an optional `HTTP ` prefix for the numeric
// ones), followed by a word boundary. This means a genuine infra REASON like
// `empty response`, `fetch failed`, or `API returned 503` at line start still
// classifies as infra, while a labelled drift-body VALUE like
// `     Real: API returned 503` / `     Real:    empty response` can NEVER trip
// the gate (the phrase is not at the line start, it follows a `Field:` label).
//
// Each entry is a bare `source` phrase plus a `boundary` flag: `true` appends a
// trailing `\b` (word-like phrases such as `empty response` / `ECONNREFUSED`),
// `false` omits it for phrases whose next char is punctuation (`INFRA_ERROR:`)
// or a tag (`<!DOCTYPE`, `<html`) where `\b` would misfire.
interface InfraIndicatorSpec {
  /** Bare regex source for the phrase — no anchor, no flags. */
  source: string;
  /** Append a trailing `\b` word boundary (default true). */
  boundary?: boolean;
}

const INFRA_INDICATOR_SPECS: InfraIndicatorSpec[] = [
  { source: "INFRA_ERROR:", boundary: false },
  { source: "API returned \\d{3}" },
  { source: "status\\s*:?\\s*\\d{3}" },
  { source: "<!DOCTYPE", boundary: false },
  { source: "<html", boundary: false },
  { source: "failed to parse JSON" },
  { source: "empty response" },
  { source: "fetch failed" },
  { source: "ECONNREFUSED" },
  { source: "ETIMEDOUT" },
  { source: "ENOTFOUND" },
  { source: "network error" },
  { source: "API unavailable" },
  { source: "returned no SSE events" },
  { source: "returned empty body" },
  { source: "waitUntil timeout" },
  { source: "STACK_TRACE_ERROR" },
];

/**
 * Wrap a bare infra phrase into a uniformly line-anchored, case-insensitive,
 * multiline regex. The anchor is IDENTICAL for every indicator:
 *
 *   ^\s*(?:HTTP\s+)?<phrase>[\b]
 *
 * so the phrase must be the failure reason at the start of a line. A labelled
 * drift-body value (`Real: <phrase>`) is preceded by a `Field:` label and thus
 * never matches. This is the single choke point that makes anchoring uniform —
 * there is no per-indicator anchoring to get wrong.
 */
function anchorInfraIndicator(spec: InfraIndicatorSpec): RegExp {
  const boundary = spec.boundary === false ? "" : "\\b";
  return new RegExp(`^\\s*(?:HTTP\\s+)?${spec.source}${boundary}`, "im");
}

/**
 * The bare infra phrase sources, exported so tests can iterate the REAL list
 * (property-based test in drift-collector.test.ts) rather than a hand-copied
 * subset. A future indicator added to INFRA_INDICATOR_SPECS is automatically
 * covered — if it were somehow mis-anchored the property test would fail.
 */
export const INFRA_INDICATOR_SOURCES: readonly string[] = INFRA_INDICATOR_SPECS.map(
  (s) => s.source,
);

/**
 * A concrete failure-reason sample for a given bare infra phrase source, used
 * by the property-based test to synthesize both a bare (line-start, infra) and
 * a labelled (`Real: …`, drift) line. Regex metacharacters in the source
 * (`\d{3}`, `\s*:?`, tag `<`) are replaced with literal, matching sample text.
 */
export function infraIndicatorSample(source: string): string {
  return source
    .replace(/\\s\*:\?\\s\*/g, ": ") // status\s*:?\s* → "status: "
    .replace(/\\s\*/g, " ")
    .replace(/\\d\{3\}/g, "503")
    .replace(/\\d\+/g, "503")
    .replace(/\\b/g, "");
}

const INFRA_INDICATORS: RegExp[] = INFRA_INDICATOR_SPECS.map(anchorInfraIndicator);

// Drift-like indicators. A genuine drift failure is drift until proven infra.
// The `expected … to be/equal/deeply equal …` shape is the canonical vitest
// assertion body for our drift/canary assertions — the OLD `/expected.*but/i`
// guard was DEAD (vitest never emits "expected … but …"), so it never fired and
// left bare assertion failures indistinguishable from infra. This repaired
// guard fires on the shapes vitest actually emits, so an unrecognized assertion
// failure counts as drift-like and forces a fail-loud (throw → exit 1).
const DRIFT_LIKE_INDICATORS = [
  /drift/i,
  /mismatch/i,
  /\bexpected\b.*\bto\s+(?:be|equal|deeply equal|contain|match|have)\b/i,
  /LLMOCK DRIFT/i,
  /API DRIFT/i,
];

/** Strip vitest stack-trace frames (`  at …`) so filenames like
 * "ws-realtime.drift.ts" cannot influence content-based classification. */
function stripStackFrames(msg: string): string {
  return msg
    .split("\n")
    .filter((line) => !/^\s*at\s/.test(line))
    .join("\n");
}

export function classifyUnparseableAsInfra(unparseableMessages: string[]): boolean {
  // CLASS 1 — fail-loud on absent evidence. No messages means NO positive infra
  // evidence, so this is NOT a benign "all clear". `[].every(...)` is vacuously
  // true, which would have wrongly classified an empty batch as infra and made
  // the collector exit 0. Root invariant: unrecognized ⇒ fail loud, never a
  // false all-clear.
  if (unparseableMessages.length === 0) return false;

  // Normalize ONCE per message; both scans consume the identical normalized
  // text (A3 — the two scans must never disagree due to differing inputs).
  const normalized = unparseableMessages.map(stripStackFrames);

  // Infra requires POSITIVE evidence on EVERY message AND zero drift signal on
  // ALL of them. If any message lacks an infra indicator, or any message looks
  // drift-like, we do NOT swallow — the caller throws (exit 1, investigate).
  const allInfraErrors = normalized.every((msg) => INFRA_INDICATORS.some((re) => re.test(msg)));
  const anyDriftLike = normalized.some((msg) => DRIFT_LIKE_INDICATORS.some((re) => re.test(msg)));

  return allInfraErrors && !anyDriftLike;
}

export function collectDriftEntries(results: VitestJsonResult): DriftEntry[] {
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
        // Check for the ws-realtime canary assertion shapes BEFORE classifying
        // as unparseable — both the unknown-models mode and the hasGA-false mode
        // (CLASS 2) are genuine, critical drift and must be surfaced (exit 2),
        // never crashed as unparseable (exit 1).
        const canary = parseKnownModelsCanary(fullMessage);
        if (canary !== null) {
          const mapping = PROVIDER_MAP["OpenAI Realtime"];

          // Build the critical diffs. F4: severity MUST be "critical" — the Fix
          // Drift workflow (.github/workflows/fix-drift.yml) gates remediation
          // entirely on exit code 2, which main() emits only when
          // criticalCount > 0. F5: this canary is real-API-only — there is no
          // mock leg, so we never mislabel a model id as a mock value.
          const NO_MOCK_LEG = "<no mock leg — real-API-only canary>";
          const diffs: ParsedDiff[] = canary.noGA
            ? [
                // CLASS 2: the GA realtime family is renamed/removed or the
                // credential cannot see it. Surface the observed models (may be
                // empty) so the auto-fix prompt knows what IS present.
                {
                  severity: "critical" as const,
                  issue:
                    "GA realtime family unavailable — no known GA model in the OpenAI realtime list. " +
                    "OpenAI may have renamed/removed the GA family, or the realtime credential cannot see it. " +
                    "Update the gaModels list in ws-realtime.drift.ts.",
                  path: "gaModels",
                  expected: "(at least one GA realtime model present)",
                  real:
                    canary.ids.length > 0
                      ? `observed realtime models: ${canary.ids.join(", ")}`
                      : "no realtime models observed",
                  mock: NO_MOCK_LEG,
                },
                // The hasGA assertion short-circuits the later unknown-models
                // assertion, so surface any unknown models observed in the SAME
                // run here (carried by the NO_GA marker). Without this, a run
                // that is BOTH no-GA AND has new unknown models would lose the
                // unknown list from the auto-fix prompt. One diff per id — each
                // is a genuine model id (never a prose sentinel).
                ...(canary.unknownIds ?? []).map((id) => ({
                  severity: "critical" as const,
                  issue:
                    "Unknown realtime model detected (observed in the same run as the missing GA " +
                    "family) — add to knownModels in ws-realtime.drift.ts",
                  path: "knownModels",
                  expected: "(not in knownModels set)",
                  real: id,
                  mock: NO_MOCK_LEG,
                })),
              ]
            : // CLASS 3: only genuine model ids become `real` diffs. The
              // truncation fact is carried as a SEPARATE diff whose `real` is a
              // count note, never a fake model id in a per-model slot.
              [
                ...canary.ids.map((id) => ({
                  severity: "critical" as const,
                  issue:
                    "Unknown realtime model detected — add to knownModels in ws-realtime.drift.ts",
                  path: "knownModels",
                  expected: "(not in knownModels set)",
                  real: id,
                  mock: NO_MOCK_LEG,
                })),
                ...(canary.truncated
                  ? [
                      {
                        severity: "critical" as const,
                        issue:
                          "Additional unknown realtime models were truncated in CI output — " +
                          "the full list is unrecoverable without the UNKNOWN_REALTIME_MODELS= marker. " +
                          "Re-run with the marker to enumerate them.",
                        path: "knownModels[truncated]",
                        // CLASS 3: `real`/`expected` NEVER carry a prose sentinel.
                        // The truncation fact lives entirely in `issue`/`path`;
                        // there is no observed model value to report here.
                        expected: "<unavailable>",
                        real: "<unavailable>",
                        mock: NO_MOCK_LEG,
                      },
                    ]
                  : []),
              ];

          entries.push({
            provider: "OpenAI Realtime",
            scenario: "known-models canary",
            builderFile: mapping.builderFile,
            builderFunctions: mapping.builderFunctions,
            typesFile: mapping.typesFile ?? null,
            sdkShapesFile: SDK_SHAPES_FILE,
            diffs,
          });
          continue;
        }
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

    if (classifyUnparseableAsInfra(unparseableMessages)) {
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

/**
 * Entry-point guard: only run main() when this module is executed directly
 * (e.g. `npx tsx scripts/drift-report-collector.ts` from the Fix Drift
 * workflow), NOT when it is imported (e.g. by the vitest suite that exercises
 * the exported pure functions). Without this guard, importing the module for
 * tests would spawn the whole drift suite via execSync and call process.exit.
 */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === resolve(entry);
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  try {
    main();
  } catch (err: unknown) {
    console.error("Fatal error:", err);
    process.exit(1);
  }
}
