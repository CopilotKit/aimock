/**
 * Tests for key functions in scripts/drift-report-collector.ts
 *
 * Since scripts/ is outside the rootDir for the main tsconfig (and vitest
 * only covers src/__tests__), these functions are duplicated here as local
 * test helpers to keep the test runner config intact. Any changes to the
 * originals must be reflected here.
 */

import { describe, it, expect } from "vitest";
import { formatDriftReport } from "./drift/schema.js";
import type { ShapeDiff } from "./drift/schema.js";

// ---------------------------------------------------------------------------
// Local copies of the types and functions under test
// (mirrors scripts/drift-report-collector.ts — keep in sync)
// ---------------------------------------------------------------------------

type DriftSeverity = "critical" | "warning" | "info";

interface ParsedDiff {
  path: string;
  severity: DriftSeverity;
  issue: string;
  expected: string;
  real: string;
  mock: string;
}

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

interface ProviderMapping {
  builderFile: string;
  builderFunctions: string[];
  typesFile: string | null;
  sdkShapesFile?: string;
}

const PROVIDER_MAP: Record<string, ProviderMapping> = {
  "OpenAI Chat": {
    builderFile: "src/helpers.ts",
    builderFunctions: [
      "buildTextCompletion",
      "buildToolCallCompletion",
      "buildTextChunks",
      "buildToolCallChunks",
    ],
    typesFile: "src/types.ts",
  },
  "OpenAI Responses": {
    builderFile: "src/responses.ts",
    builderFunctions: [
      "buildTextResponse",
      "buildToolCallResponse",
      "buildTextStreamEvents",
      "buildToolCallStreamEvents",
    ],
    typesFile: null,
  },
  Anthropic: {
    builderFile: "src/messages.ts",
    builderFunctions: [
      "buildClaudeTextResponse",
      "buildClaudeToolCallResponse",
      "buildClaudeTextStreamEvents",
      "buildClaudeToolCallStreamEvents",
    ],
    typesFile: null,
  },
  "Anthropic Claude": {
    builderFile: "src/messages.ts",
    builderFunctions: [
      "buildClaudeTextResponse",
      "buildClaudeToolCallResponse",
      "buildClaudeTextStreamEvents",
      "buildClaudeToolCallStreamEvents",
    ],
    typesFile: null,
  },
  "Google Gemini": {
    builderFile: "src/gemini.ts",
    builderFunctions: [
      "buildGeminiTextResponse",
      "buildGeminiToolCallResponse",
      "buildGeminiTextStreamChunks",
      "buildGeminiToolCallStreamChunks",
    ],
    typesFile: null,
  },
  Gemini: {
    builderFile: "src/gemini.ts",
    builderFunctions: [
      "buildGeminiTextResponse",
      "buildGeminiToolCallResponse",
      "buildGeminiTextStreamChunks",
      "buildGeminiToolCallStreamChunks",
    ],
    typesFile: null,
  },
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
  "OpenAI Embeddings": {
    builderFile: "src/helpers.ts",
    builderFunctions: ["buildEmbeddingResponse", "generateDeterministicEmbedding"],
    typesFile: null,
    sdkShapesFile: "src/__tests__/drift/sdk-shapes.ts",
  },
};

const SDK_SHAPES_FILE = "src/__tests__/drift/sdk-shapes.ts";

const VALID_SEVERITIES = new Set<DriftSeverity>(["critical", "warning", "info"]);

function parseDriftBlock(text: string): { context: string; diffs: ParsedDiff[] } | null {
  const headerMatch = text.match(/API DRIFT DETECTED:\s*(.+)/);
  if (!headerMatch) return null;

  const context = headerMatch[1].trim();
  const diffs: ParsedDiff[] = [];

  const entryPattern =
    /\d+\.\s*\[(\w+)\]\s*(.+)\n\s*Path:\s*(.+)\n\s*SDK:\s*(.+)\n\s*Real:\s*(.+)\n\s*Mock:\s*(.+)/g;

  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(text)) !== null) {
    const severity = match[1].trim();
    if (!VALID_SEVERITIES.has(severity as DriftSeverity)) continue;
    diffs.push({
      severity: severity as DriftSeverity,
      issue: match[2].trim(),
      path: match[3].trim(),
      expected: match[4].trim(),
      real: match[5].trim(),
      mock: match[6].trim(),
    });
  }

  return { context, diffs };
}

function extractProviderName(text: string): string | null {
  const sorted = Object.keys(PROVIDER_MAP).sort((a, b) => b.length - a.length);
  for (const key of sorted) {
    if (text.includes(key)) return key;
  }
  return null;
}

function extractScenario(context: string): string {
  const parenMatch = context.match(/\(([^)]+)\)/);
  return parenMatch ? parenMatch[1] : context;
}

function collectDriftEntries(results: VitestJsonResult): Array<{
  provider: string;
  scenario: string;
  builderFile: string;
  builderFunctions: string[];
  typesFile: string | null;
  sdkShapesFile: string;
  diffs: ParsedDiff[];
}> {
  const entries: Array<{
    provider: string;
    scenario: string;
    builderFile: string;
    builderFunctions: string[];
    typesFile: string | null;
    sdkShapesFile: string;
    diffs: ParsedDiff[];
  }> = [];
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
    throw new Error(`${unmapped.length} unmapped drift entries — update PROVIDER_MAP`);
  }

  if (unparseable > 0 && entries.length === 0) {
    throw new Error(`${unparseable} unparseable test failures with 0 drift entries — investigate`);
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Helpers for building test fixtures
// ---------------------------------------------------------------------------

function makeResult(assertions: VitestAssertion[]): VitestJsonResult {
  return { testResults: [{ assertionResults: assertions }] };
}

function makeAssertion(overrides: Partial<VitestAssertion> = {}): VitestAssertion {
  return {
    status: "failed",
    ancestorTitles: [],
    title: "test title",
    failureMessages: [],
    ...overrides,
  };
}

const SAMPLE_DIFF: ShapeDiff = {
  path: "choices[0].message.refusal",
  severity: "critical",
  issue: "LLMOCK DRIFT — field in SDK + real API but missing from mock",
  expected: "null",
  real: "null",
  mock: "<absent>",
};

const SAMPLE_DIFF_WARNING: ShapeDiff = {
  path: "choices[0].message.extra",
  severity: "warning",
  issue: "PROVIDER ADDED FIELD — in real API but not in SDK or mock",
  expected: "<absent>",
  real: "string",
  mock: "<absent>",
};

// ---------------------------------------------------------------------------
// parseDriftBlock tests
// ---------------------------------------------------------------------------

describe("parseDriftBlock", () => {
  it("returns null for text with no API DRIFT DETECTED header", () => {
    expect(parseDriftBlock("")).toBeNull();
    expect(parseDriftBlock("Error: AssertionError: expected true to be false")).toBeNull();
    expect(parseDriftBlock("No drift detected: OpenAI Chat (non-streaming text)")).toBeNull();
  });

  it("parses a single drift entry correctly", () => {
    const formatted = formatDriftReport("OpenAI Chat (non-streaming text)", [SAMPLE_DIFF]);
    const result = parseDriftBlock(formatted);

    expect(result).not.toBeNull();
    expect(result!.context).toBe("OpenAI Chat (non-streaming text)");
    expect(result!.diffs).toHaveLength(1);

    const diff = result!.diffs[0];
    expect(diff.severity).toBe("critical");
    expect(diff.path).toBe("choices[0].message.refusal");
    expect(diff.issue).toBe("LLMOCK DRIFT — field in SDK + real API but missing from mock");
    expect(diff.expected).toBe("null");
    expect(diff.real).toBe("null");
    expect(diff.mock).toBe("<absent>");
  });

  it("parses multiple drift entries", () => {
    const formatted = formatDriftReport("OpenAI Chat (non-streaming text)", [
      SAMPLE_DIFF,
      SAMPLE_DIFF_WARNING,
    ]);
    const result = parseDriftBlock(formatted);

    expect(result).not.toBeNull();
    expect(result!.diffs).toHaveLength(2);
    expect(result!.diffs[0].severity).toBe("critical");
    expect(result!.diffs[1].severity).toBe("warning");
    expect(result!.diffs[1].path).toBe("choices[0].message.extra");
  });

  it("skips entries with unknown severity", () => {
    // Manually construct a report with a bad severity
    const text = `
API DRIFT DETECTED: OpenAI Chat (test)

  1. [unknown] Some issue
     Path:    foo.bar
     SDK:     string
     Real:    string
     Mock:    <absent>

  2. [critical] Real issue
     Path:    baz.qux
     SDK:     null
     Real:    null
     Mock:    <absent>
`;
    const result = parseDriftBlock(text);
    expect(result).not.toBeNull();
    // Only the critical entry should be in diffs
    expect(result!.diffs).toHaveLength(1);
    expect(result!.diffs[0].severity).toBe("critical");
    expect(result!.diffs[0].path).toBe("baz.qux");
  });

  it("handles context strings with parenthetical scenario", () => {
    const formatted = formatDriftReport("Anthropic Claude (streaming tool call)", [SAMPLE_DIFF]);
    const result = parseDriftBlock(formatted);

    expect(result).not.toBeNull();
    expect(result!.context).toBe("Anthropic Claude (streaming tool call)");
  });

  it("round-trips through formatDriftReport for all severity levels", () => {
    const diffs: ShapeDiff[] = [
      { ...SAMPLE_DIFF, severity: "critical" },
      { ...SAMPLE_DIFF_WARNING, severity: "warning" },
      {
        path: "model",
        severity: "info",
        issue: "SDK EXTRA — field in SDK but not in real API response",
        expected: "string",
        real: "<absent>",
        mock: "string",
      },
    ];
    const formatted = formatDriftReport("Google Gemini (non-streaming text)", diffs);
    const result = parseDriftBlock(formatted);

    expect(result).not.toBeNull();
    expect(result!.context).toBe("Google Gemini (non-streaming text)");
    expect(result!.diffs).toHaveLength(3);

    for (let i = 0; i < diffs.length; i++) {
      expect(result!.diffs[i].severity).toBe(diffs[i].severity);
      expect(result!.diffs[i].path).toBe(diffs[i].path);
      expect(result!.diffs[i].issue).toBe(diffs[i].issue);
      expect(result!.diffs[i].expected).toBe(diffs[i].expected);
      expect(result!.diffs[i].real).toBe(diffs[i].real);
      expect(result!.diffs[i].mock).toBe(diffs[i].mock);
    }
  });
});

// ---------------------------------------------------------------------------
// extractProviderName tests
// ---------------------------------------------------------------------------

describe("extractProviderName", () => {
  it("matches exact provider names", () => {
    expect(extractProviderName("OpenAI Chat")).toBe("OpenAI Chat");
    expect(extractProviderName("Gemini")).toBe("Gemini");
    expect(extractProviderName("OpenAI Realtime")).toBe("OpenAI Realtime");
  });

  it("uses longest match — Anthropic Claude over Anthropic", () => {
    // "Anthropic Claude" is longer and should win over "Anthropic"
    expect(extractProviderName("Anthropic Claude drift")).toBe("Anthropic Claude");
    expect(extractProviderName("Anthropic Claude (streaming tool call)")).toBe("Anthropic Claude");
  });

  it("uses longest match — Google Gemini over Gemini", () => {
    expect(extractProviderName("Google Gemini drift")).toBe("Google Gemini");
    expect(extractProviderName("Google Gemini (non-streaming text)")).toBe("Google Gemini");
  });

  it("returns null for unknown provider", () => {
    expect(extractProviderName("")).toBeNull();
    expect(extractProviderName("Unknown Provider drift")).toBeNull();
    expect(extractProviderName("Cohere drift")).toBeNull();
  });

  it("matches provider in drift test describe block format", () => {
    expect(extractProviderName("OpenAI Chat Completions drift")).toBe("OpenAI Chat");
    expect(extractProviderName("OpenAI Responses API drift")).toBe("OpenAI Responses");
    expect(extractProviderName("Gemini Live WebSocket drift")).toBe("Gemini Live");
  });

  it("matches provider from context string (parenthetical format)", () => {
    expect(extractProviderName("OpenAI Chat (non-streaming text)")).toBe("OpenAI Chat");
    expect(extractProviderName("Anthropic (streaming text)")).toBe("Anthropic");
  });
});

// ---------------------------------------------------------------------------
// collectDriftEntries tests
// ---------------------------------------------------------------------------

describe("collectDriftEntries", () => {
  it("returns empty array when no failed tests", () => {
    const result = makeResult([
      makeAssertion({ status: "passed" }),
      makeAssertion({ status: "pending" }),
    ]);
    expect(collectDriftEntries(result)).toEqual([]);
  });

  it("returns empty array when there are no test files at all", () => {
    expect(collectDriftEntries({ testResults: [] })).toEqual([]);
  });

  it("throws when an unmapped provider is found in drift report", () => {
    const driftText = formatDriftReport("UnknownProvider (non-streaming text)", [SAMPLE_DIFF]);
    const result = makeResult([
      makeAssertion({
        status: "failed",
        ancestorTitles: ["UnknownProvider drift"],
        failureMessages: [driftText],
      }),
    ]);
    expect(() => collectDriftEntries(result)).toThrow(/unmapped drift entries/);
  });

  it("throws when all failures are unparseable and no drift entries collected", () => {
    const result = makeResult([
      makeAssertion({
        status: "failed",
        failureMessages: ["Error: expected true to equal false\n  at Object.<anonymous>"],
      }),
      makeAssertion({
        status: "failed",
        failureMessages: ["TypeError: Cannot read property 'foo' of undefined"],
      }),
    ]);
    expect(() => collectDriftEntries(result)).toThrow(/unparseable test failures/);
  });

  it("returns valid entries and tolerates unparseable failures mixed in", () => {
    const driftText = formatDriftReport("OpenAI Chat (non-streaming text)", [SAMPLE_DIFF]);
    const result = makeResult([
      makeAssertion({
        status: "failed",
        ancestorTitles: ["OpenAI Chat Completions drift"],
        title: "non-streaming text matches real API",
        failureMessages: [driftText],
      }),
      makeAssertion({
        status: "failed",
        ancestorTitles: ["unrelated suite"],
        title: "some other failure",
        failureMessages: ["Error: plain error with no drift header"],
      }),
    ]);

    const entries = collectDriftEntries(result);
    expect(entries).toHaveLength(1);
    expect(entries[0].provider).toBe("OpenAI Chat");
    expect(entries[0].scenario).toBe("non-streaming text");
    expect(entries[0].builderFile).toBe("src/helpers.ts");
    expect(entries[0].diffs).toHaveLength(1);
    expect(entries[0].diffs[0].severity).toBe("critical");
  });

  it("ignores passed assertions in a mixed result set", () => {
    const driftText = formatDriftReport("OpenAI Chat (non-streaming text)", [SAMPLE_DIFF]);
    const result = makeResult([
      makeAssertion({ status: "passed", failureMessages: [] }),
      makeAssertion({
        status: "failed",
        ancestorTitles: ["OpenAI Chat Completions drift"],
        title: "non-streaming text matches real API",
        failureMessages: [driftText],
      }),
    ]);

    const entries = collectDriftEntries(result);
    expect(entries).toHaveLength(1);
    expect(entries[0].provider).toBe("OpenAI Chat");
  });

  it("collects entries from multiple test files", () => {
    const openAiDrift = formatDriftReport("OpenAI Chat (non-streaming text)", [SAMPLE_DIFF]);
    const geminiDrift = formatDriftReport("Google Gemini (non-streaming text)", [
      SAMPLE_DIFF_WARNING,
    ]);

    const results: VitestJsonResult = {
      testResults: [
        {
          assertionResults: [
            makeAssertion({
              status: "failed",
              ancestorTitles: ["OpenAI Chat Completions drift"],
              failureMessages: [openAiDrift],
            }),
          ],
        },
        {
          assertionResults: [
            makeAssertion({
              status: "failed",
              ancestorTitles: ["Google Gemini drift"],
              failureMessages: [geminiDrift],
            }),
          ],
        },
      ],
    };

    const entries = collectDriftEntries(results);
    expect(entries).toHaveLength(2);
    expect(entries[0].provider).toBe("OpenAI Chat");
    expect(entries[1].provider).toBe("Google Gemini");
  });
});
