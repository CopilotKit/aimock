/**
 * Tests for the drift-report collector's pure functions.
 *
 * These tests import and exercise the REAL exported functions from
 * scripts/drift-report-collector.ts — NOT local reimplementations. Importing
 * the module does NOT run main(): the collector guards its entry point with an
 * `isDirectRun()` check (main() only fires under `tsx scripts/…` invocation),
 * so importing here is side-effect-free.
 *
 * The canary fixtures below are REAL vitest failure-message shapes captured by
 * running the canary / drift / infra assertions under
 * `vitest run … --reporter=json` (see PR #291 RED/GREEN logs under tmp/). They
 * are NOT hand-authored: the single-glyph Unicode ellipsis `…(N)`, the
 * `AssertionError:` prefix, the leading blank line before a formatted drift
 * report, and the stack-frame layout are exactly what vitest emits.
 */

import { describe, it, expect } from "vitest";
import { formatDriftReport } from "./drift/schema.js";
import type { ShapeDiff } from "./drift/schema.js";
import {
  parseDriftBlock,
  extractProviderName,
  extractSurfaceKey,
  extractScenario,
  parseKnownModelsCanary,
  collectDriftEntries,
  computeExitCode,
  conclusionForExitCode,
  classifyUnparseableAsInfra,
  INFRA_INDICATOR_SOURCES,
  infraIndicatorSample,
} from "../../scripts/drift-report-collector.js";
import type { DriftEntry, QuarantineEntry } from "../../scripts/drift-types.js";
import { SURFACE_REGISTRY, KNOWN_SURFACE_SLUGS, isKnownSurface } from "./drift/surface-registry.js";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { isBaseReportReusable } from "../../scripts/drift-delta.js";
import type { DriftReport } from "../../scripts/drift-types.js";

// ---------------------------------------------------------------------------
// Helpers for the A1.3 CollectResult shape ({ entries, quarantine }).
// collectDriftEntries no longer returns a bare array nor throws on unmapped /
// unparseable-not-infra failures — those are quarantined (→ exit 5).
// ---------------------------------------------------------------------------

function entriesOf(result: VitestJsonResult): DriftEntry[] {
  return collectDriftEntries(result).entries;
}

function quarantineOf(result: VitestJsonResult): QuarantineEntry[] {
  return collectDriftEntries(result).quarantine;
}

/** The exit code main() would emit for a given collect result (agUiSkipped=false). */
function exitCodeOf(result: VitestJsonResult): 0 | 1 | 2 | 5 {
  const { entries, quarantine } = collectDriftEntries(result);
  const criticalCount = entries.reduce(
    (sum, e) => sum + e.diffs.filter((d) => d.severity === "critical").length,
    0,
  );
  return computeExitCode(criticalCount, quarantine.length, false);
}

// ---------------------------------------------------------------------------
// Vitest JSON reporter fixture builders
// ---------------------------------------------------------------------------

interface VitestAssertion {
  status: string;
  ancestorTitles: string[];
  title: string;
  failureMessages: string[];
}

interface VitestJsonResult {
  testResults: { assertionResults: VitestAssertion[] }[];
}

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
// REAL captured vitest --reporter=json failure-message fixtures.
// Captured via throwaway `*.drift.ts` capture tests run under the drift config;
// see tmp/canary-fixtures.json + the PR #291 RED/GREEN logs.
// ---------------------------------------------------------------------------

// Canary tripped with FOUR unknown models. The printed array is truncated by
// vitest to `…(3)` (single-glyph Unicode ellipsis), but the custom assertion
// message `UNKNOWN_REALTIME_MODELS=…` carries the full list verbatim.
// NOTE (A4): the ids below are HYPOTHETICAL future models that are NOT in the
// knownModels set in ws-realtime.drift.ts — so the real canary really could
// emit them as unknown. (gpt-realtime-2.1 / -2.1-mini ARE in knownModels and
// therefore can never appear here — the earlier fixture that used them was
// impossible.)
const CANARY_MARKER_MULTI =
  "AssertionError: UNKNOWN_REALTIME_MODELS=gpt-realtime-3,gpt-realtime-3-mini,gpt-realtime-3-preview,gpt-realtime-ultra: expected [ 'gpt-realtime-3', …(3) ] to deeply equal []\n" +
  "    at /repo/src/__tests__/drift/ws-realtime.drift.ts:108:69\n" +
  "    at file:///repo/node_modules/@vitest/runner/dist/chunk-hooks.js:155:11\n" +
  "    at processTicksAndRejections (node:internal/process/task_queues:104:5)";

// A GENUINE drift report carried inside an AssertionError. formatDriftReport
// prepends "\n", so line 0 is just "AssertionError: " and the "API DRIFT
// DETECTED" / "mismatch" markers live on LATER lines. This is a fully-formatted
// report body (parseDriftBlock parses it into one critical diff).
const GENUINE_DRIFT_WITH_STACK =
  "AssertionError: \nAPI DRIFT DETECTED: OpenAI Chat (non-streaming text)\n\n" +
  "  1. [critical] LLMOCK DRIFT — mismatch detected\n" +
  "     Path:    choices[0].message.refusal\n" +
  "     SDK:     null\n" +
  "     Real:    null\n" +
  "     Mock:    <absent>\n" +
  ": expected [ Array(1) ] to deeply equal []\n" +
  "    at /repo/src/__tests__/drift/openai-chat.drift.ts:42:30\n" +
  "    at file:///repo/node_modules/@vitest/runner/dist/chunk-hooks.js:155:11";

// A genuinely-unparseable failure whose ONLY infra token (ECONNREFUSED) sits in
// a STACK FRAME; the assertion body is neutral (no infra token, no drift
// marker). This is the A3 asymmetry surface — a raw scan would see the frame
// token and wrongly swallow the failure; a stack-stripped scan does not.
const INFRA_TOKEN_IN_STACKFRAME_ONLY =
  "AssertionError: expected 1 to be 2 // Object.is equality\n" +
  "    at ECONNREFUSED (/repo/src/__tests__/drift/some.drift.ts:8:13)\n" +
  "    at file:///repo/node_modules/@vitest/runner/dist/chunk-hooks.js:155:11";

// A genuine infra failure whose token is in the BODY (the well-behaved case).
const REAL_INFRA_BODY = "fetch failed\n    at handler (file:///repo/src/x.drift.ts:5:1)";

// CLASS 2 — the canary `hasGA`-false mode. Captured REAL from a throwaway
// `*.drift.ts` capture run under the drift config (see tmp/captured-vitest-shapes.json).
// When OpenAI renames/removes the GA realtime family, the canary emits the
// NO_GA_REALTIME_MODELS= marker (symmetric to UNKNOWN_REALTIME_MODELS=) and the
// assertion fails with "expected false to be true". The collector must map this
// to a CRITICAL OpenAI-Realtime DriftEntry (exit-2), NOT crash to exit-1.
const CANARY_NO_GA_MARKER =
  "AssertionError: NO_GA_REALTIME_MODELS=gpt-foo,gpt-bar | UNKNOWN_REALTIME_MODELS=: expected false to be true // Object.is equality\n" +
  "    at /repo/src/__tests__/drift/ws-realtime.drift.ts:96:44\n" +
  "    at file:///repo/node_modules/@vitest/runner/dist/chunk-hooks.js:155:11\n" +
  "    at processTicksAndRejections (node:internal/process/task_queues:104:5)";

// CLASS 2 combined case — the run is BOTH no-GA AND carries new unknown models.
// The hasGA assertion throws first (short-circuiting the unknown-models
// assertion), so the NO_GA marker carries BOTH lists. The collector must
// preserve the unknown list (no information loss into the auto-fix prompt).
const CANARY_NO_GA_WITH_UNKNOWN =
  "AssertionError: NO_GA_REALTIME_MODELS=gpt-foo,gpt-bar | UNKNOWN_REALTIME_MODELS=gpt-realtime-99,gpt-realtime-99-mini: expected false to be true // Object.is equality\n" +
  "    at /repo/src/__tests__/drift/ws-realtime.drift.ts:96:44\n" +
  "    at file:///repo/node_modules/@vitest/runner/dist/chunk-hooks.js:155:11";

// A NO_GA marker with an empty observed list (key could not see ANY realtime
// models — still a critical signal that the GA family is unreachable/gone).
const CANARY_NO_GA_EMPTY =
  "AssertionError: NO_GA_REALTIME_MODELS= | UNKNOWN_REALTIME_MODELS=: expected false to be true // Object.is equality\n" +
  "    at /repo/src/__tests__/drift/ws-realtime.drift.ts:96:44";

// CLASS 3 — a marker-less truncated canary array. The truncation fact must
// become a boolean flag, never a prose sentinel occupying a model-id slot.
const CANARY_FALLBACK_TRUNCATED =
  "AssertionError: expected [ 'gpt-realtime-9', …(2) ] to deeply equal []\n" +
  "    at /repo/src/__tests__/drift/ws-realtime.drift.ts:108:69";

// ---------------------------------------------------------------------------
// parseDriftBlock
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
// extractProviderName
// ---------------------------------------------------------------------------

describe("extractProviderName", () => {
  it("matches exact provider names", () => {
    expect(extractProviderName("OpenAI Chat")).toBe("OpenAI Chat");
    expect(extractProviderName("Gemini")).toBe("Gemini");
    expect(extractProviderName("OpenAI Realtime")).toBe("OpenAI Realtime");
  });

  it("uses longest match — Anthropic Claude over Anthropic", () => {
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
// extractScenario
// ---------------------------------------------------------------------------

describe("extractScenario", () => {
  it("extracts the parenthetical scenario", () => {
    expect(extractScenario("OpenAI Chat (non-streaming text)")).toBe("non-streaming text");
    expect(extractScenario("Anthropic Claude (streaming tool call)")).toBe("streaming tool call");
  });

  it("returns the whole context when there is no parenthetical", () => {
    expect(extractScenario("OpenAI Chat")).toBe("OpenAI Chat");
  });
});

// ---------------------------------------------------------------------------
// collectDriftEntries (HTTP drift path)
// ---------------------------------------------------------------------------

describe("collectDriftEntries", () => {
  it("returns empty entries+quarantine when no failed tests", () => {
    const result = makeResult([
      makeAssertion({ status: "passed" }),
      makeAssertion({ status: "pending" }),
    ]);
    expect(entriesOf(result)).toEqual([]);
    expect(quarantineOf(result)).toEqual([]);
    expect(exitCodeOf(result)).toBe(0);
  });

  it("returns empty entries+quarantine when there are no test files at all", () => {
    const result: VitestJsonResult = { testResults: [] };
    expect(entriesOf(result)).toEqual([]);
    expect(quarantineOf(result)).toEqual([]);
  });

  it("QUARANTINES (does NOT throw) an unmapped provider found in a drift report → exit 5", () => {
    // A1.3: an unmapped provider is untrusted, not a collector crash. It is held
    // for review (exit 5) instead of throwing (was exit 1).
    const driftText = formatDriftReport("UnknownProvider (non-streaming text)", [SAMPLE_DIFF]);
    const result = makeResult([
      makeAssertion({
        status: "failed",
        ancestorTitles: ["UnknownProvider drift"],
        failureMessages: [driftText],
      }),
    ]);
    expect(() => collectDriftEntries(result)).not.toThrow();
    const q = quarantineOf(result);
    expect(q).toHaveLength(1);
    expect(entriesOf(result)).toEqual([]);
    expect(exitCodeOf(result)).toBe(5);
  });

  it("QUARANTINES (does NOT throw) all-unparseable-not-infra failures → exit 5 (incident-5)", () => {
    // A1.3: the incident-5 surface. Genuine-but-unparseable failures are no
    // longer a fail-loud crash (exit 1) — they are quarantined (exit 5) so they
    // surface for review without being swallowed.
    const result = makeResult([
      makeAssertion({
        status: "failed",
        ancestorTitles: ["Some Suite"],
        title: "a",
        failureMessages: [
          "AssertionError: expected 1 to be 2 // Object.is equality\n    at foo (/repo/src/__tests__/drift/some.drift.ts:8:13)",
        ],
      }),
      makeAssertion({
        status: "failed",
        ancestorTitles: ["Other Suite"],
        title: "b",
        failureMessages: [
          "TypeError: Cannot read property 'foo' of undefined\n    at bar (/repo/src/__tests__/drift/other.drift.ts:3:1)",
        ],
      }),
    ]);
    expect(() => collectDriftEntries(result)).not.toThrow();
    const q = quarantineOf(result);
    expect(q).toHaveLength(2);
    // O-1: raw file:line captured from the stack frame BEFORE stripping.
    expect(q[0].rawLocation).toBe("/repo/src/__tests__/drift/some.drift.ts:8:13");
    expect(q[1].rawLocation).toBe("/repo/src/__tests__/drift/other.drift.ts:3:1");
    expect(entriesOf(result)).toEqual([]);
    expect(exitCodeOf(result)).toBe(5);
  });

  it("recognizes an OpenAI Realtime WS handshake failure as a critical DriftEntry (exit 2), NOT an opaque exit-5 quarantine", () => {
    // REAL vitest failure-message shape captured from the drift-live-pr CI run
    // that surfaced the GA session.type protocol change: the socket upgraded,
    // the live API returned ONE `error` event, then the probe timed out waiting
    // for session.updated. Before the WS-handshake recognizer this fell through
    // to exit-5 quarantine (opaque red); now it is a parseable critical drift.
    const wsHandshakeFailure =
      "Error: waitUntil timeout after 30000ms. Collected 1 messages: [error] " +
      'bodies=[{"type":"error","event_id":"event_E4b9BfUiVmC9qkIgQZSni",' +
      '"error":{"type":"invalid_request_error","code":"missing_required_parameter",' +
      '"message":"Missing required parameter: \'session.type\'.","param":"session.type"}}]\n' +
      "    at openaiRealtimeWS (/repo/src/__tests__/drift/ws-providers.ts:214:23)\n" +
      "    at /repo/src/__tests__/drift/ws-realtime.drift.ts:138:26";
    const result = makeResult([
      makeAssertion({
        status: "failed",
        ancestorTitles: ["OpenAI Realtime API drift"],
        title: "WS text event sequence and shapes match (GA)",
        failureMessages: [wsHandshakeFailure],
      }),
    ]);

    // GREEN: one attributed critical entry, no quarantine, exit 2.
    expect(quarantineOf(result)).toEqual([]);
    const entries = entriesOf(result);
    expect(entries).toHaveLength(1);
    expect(entries[0].provider).toBe("OpenAI Realtime");
    expect(entries[0].builderFile).toBe("src/ws-realtime.ts");
    expect(entries[0].diffs).toHaveLength(1);
    expect(entries[0].diffs[0].severity).toBe("critical");
    // The surfaced error payload (type/code/message) is carried into the entry.
    expect(entries[0].diffs[0].real).toContain("invalid_request_error");
    expect(entries[0].diffs[0].issue).toContain("missing_required_parameter");
    expect(entries[0].diffs[0].issue).toContain("session.type");
    expect(exitCodeOf(result)).toBe(2);
  });

  it("does NOT recognize a bare WS network timeout (zero messages, no error body) as handshake drift → stays quarantined (exit 5)", () => {
    // A genuine transient network flake times out having collected ZERO
    // messages and carries no provider `error` body. It must NOT be reclassified
    // as protocol drift — it stays in the quarantine lane for human review.
    const bareTimeout =
      "Error: waitUntil timeout after 30000ms. Collected 0 messages: []\n" +
      "    at openaiRealtimeWS (/repo/src/__tests__/drift/ws-providers.ts:372:20)\n" +
      "    at /repo/src/__tests__/drift/ws-realtime.drift.ts:138:26";
    const result = makeResult([
      makeAssertion({
        status: "failed",
        ancestorTitles: ["OpenAI Realtime API drift"],
        title: "WS text event sequence and shapes match (GA)",
        failureMessages: [bareTimeout],
      }),
    ]);
    expect(entriesOf(result)).toEqual([]);
    expect(quarantineOf(result)).toHaveLength(1);
    expect(exitCodeOf(result)).toBe(5);
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

    const entries = entriesOf(result);
    expect(entries).toHaveLength(1);
    expect(entries[0].provider).toBe("OpenAI Chat");
    expect(entries[0].scenario).toBe("non-streaming text");
    expect(entries[0].builderFile).toBe("src/helpers.ts");
    expect(entries[0].diffs).toHaveLength(1);
    expect(entries[0].diffs[0].severity).toBe("critical");
    // When real drift entries ARE present, a mixed-in unparseable sibling stays
    // TOLERATED (warn-only) rather than quarantined — the quarantine path only
    // fires for the all-unparseable, zero-entries case (former throw site).
    expect(quarantineOf(result)).toEqual([]);
    // A critical entry present → exit 2 (dominates any tolerated sibling).
    expect(exitCodeOf(result)).toBe(2);
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

    const entries = entriesOf(result);
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

    const entries = entriesOf(results);
    expect(entries).toHaveLength(2);
    expect(entries[0].provider).toBe("OpenAI Chat");
    expect(entries[1].provider).toBe("Google Gemini");
  });

  // -------------------------------------------------------------------------
  // INTEGRATION: the canary → critical → exit-2 contract, end to end through
  // the REAL collectDriftEntries. This is the whole reason PR #291 exists.
  // -------------------------------------------------------------------------

  it("emits ONE critical DriftEntry carrying the FULL unknown-model list from a real canary failure (RED without the marker fix)", () => {
    const result = makeResult([
      makeAssertion({
        status: "failed",
        ancestorTitles: ["OpenAI Realtime API drift"],
        title: "canary: GA realtime models available",
        failureMessages: [CANARY_MARKER_MULTI],
      }),
    ]);

    const entries = entriesOf(result);
    expect(entries).toHaveLength(1);

    const entry = entries[0];
    expect(entry.provider).toBe("OpenAI Realtime");
    expect(entry.scenario).toBe("known-models canary");
    expect(entry.builderFile).toBe("src/ws-realtime.ts");

    // FULL list recovered from the marker (NOT truncated to just the first id).
    const reals = entry.diffs.map((d) => d.real);
    expect(reals).toEqual([
      "gpt-realtime-3",
      "gpt-realtime-3-mini",
      "gpt-realtime-3-preview",
      "gpt-realtime-ultra",
    ]);

    // Every diff is critical so the collector exits 2 and the Fix Drift
    // workflow reaches the auto-fix step.
    expect(entry.diffs.every((d) => d.severity === "critical")).toBe(true);
    // Real-API-only canary: the model id must NOT be mislabeled as a mock value.
    for (const d of entry.diffs) {
      expect(d.mock).not.toBe(d.real);
      expect(d.mock).toContain("no mock leg");
    }

    // The exit-2 gate condition (criticalCount > 0) that main() checks.
    const criticalCount = entries.reduce(
      (sum, e) => sum + e.diffs.filter((d) => d.severity === "critical").length,
      0,
    );
    expect(criticalCount).toBe(4);
  });

  it("does NOT misattribute a non-canary toEqual([]) failure from another provider as OpenAI-Realtime drift → quarantine (exit 5)", () => {
    // A different provider's test failed with the generic vitest shape
    // `expected [ 'sk-leaked' ] to deeply equal []`. Pre-fix, the unguarded
    // canary fallback matched this and emitted a CRITICAL "OpenAI Realtime
    // known-models canary" entry with `real: 'sk-leaked'`, pointing the auto-fix
    // at src/ws-realtime.ts and relabeling arbitrary array contents as a model
    // id. It must NOT be claimed as a canary. A1.3: because the message is
    // neither a parseable drift block, a canary, nor infra, it is QUARANTINED
    // (exit 5) — never fabricated into a false entry, never silently dropped,
    // and (A1.3) no longer a fail-loud crash.
    const NON_CANARY_TOEQUAL_EMPTY =
      "AssertionError: expected [ 'sk-leaked' ] to deeply equal []\n" +
      "    at /repo/src/__tests__/drift/openai-chat.drift.ts:42:30\n" +
      "    at file:///repo/node_modules/@vitest/runner/dist/chunk-hooks.js:155:11";
    const result = makeResult([
      makeAssertion({
        status: "failed",
        ancestorTitles: ["OpenAI Chat Completions drift"],
        title: "non-streaming text matches real API",
        failureMessages: [NON_CANARY_TOEQUAL_EMPTY],
      }),
    ]);

    expect(() => collectDriftEntries(result)).not.toThrow();
    // No OpenAI-Realtime (nor any) entry may be produced.
    expect(entriesOf(result)).toEqual([]);
    expect(quarantineOf(result)).toHaveLength(1);
    // The arbitrary array content is NOT relabeled as a model id anywhere.
    expect(quarantineOf(result)[0].message).toContain("sk-leaked");
    expect(exitCodeOf(result)).toBe(5);
  });

  it("surfaces a genuine drift report carried in an AssertionError with a leading blank line (does not swallow)", () => {
    const result = makeResult([
      makeAssertion({
        status: "failed",
        ancestorTitles: ["OpenAI Chat Completions drift"],
        title: "non-streaming text matches real API",
        failureMessages: [GENUINE_DRIFT_WITH_STACK],
      }),
    ]);

    const entries = entriesOf(result);
    expect(entries).toHaveLength(1);
    expect(entries[0].provider).toBe("OpenAI Chat");
    expect(entries[0].diffs).toHaveLength(1);
    expect(entries[0].diffs[0].severity).toBe("critical");
  });

  it("does NOT exit 0 (quarantines → exit 5) when the only failure has an infra token confined to a stack frame (A3)", () => {
    // The raw-vs-stripped asymmetry classified this as benign infra and swallowed
    // it (returned []). The fix normalizes both scans, so an infra token that
    // survives ONLY in a stripped-away stack frame no longer flips the gate — the
    // failure is surfaced. A1.3: surfaced now means QUARANTINE (exit 5), not a
    // crash; the invariant that matters is it is NEVER a green (exit 0).
    const result = makeResult([
      makeAssertion({
        status: "failed",
        ancestorTitles: ["OpenAI Realtime API drift"],
        title: "canary: GA realtime models available",
        failureMessages: [INFRA_TOKEN_IN_STACKFRAME_ONLY],
      }),
    ]);
    expect(() => collectDriftEntries(result)).not.toThrow();
    expect(quarantineOf(result)).toHaveLength(1);
    expect(exitCodeOf(result)).toBe(5);
    expect(exitCodeOf(result)).not.toBe(0);
  });

  // -------------------------------------------------------------------------
  // CLASS 2 — hasGA-false canary maps to a CRITICAL OpenAI-Realtime entry
  // (exit-2 path) instead of crashing to exit-1.
  // -------------------------------------------------------------------------
  it("maps a NO_GA_REALTIME_MODELS canary failure to a CRITICAL OpenAI-Realtime entry (exit-2, not a throw)", () => {
    const result = makeResult([
      makeAssertion({
        status: "failed",
        ancestorTitles: ["OpenAI Realtime API drift"],
        title: "canary: GA realtime models available",
        failureMessages: [CANARY_NO_GA_MARKER],
      }),
    ]);

    const entries = entriesOf(result);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.provider).toBe("OpenAI Realtime");
    expect(entry.builderFile).toBe("src/ws-realtime.ts");
    expect(entry.diffs.length).toBeGreaterThan(0);
    expect(entry.diffs.every((d) => d.severity === "critical")).toBe(true);

    const criticalCount = entries.reduce(
      (sum, e) => sum + e.diffs.filter((d) => d.severity === "critical").length,
      0,
    );
    expect(criticalCount).toBeGreaterThan(0);
  });

  it("preserves the unknown-model list in the NO_GA entry (no info loss when both fire)", () => {
    // A run that is BOTH no-GA AND has new unknown models must surface the
    // unknown ids as critical diffs, not lose them to the short-circuited
    // unknown-models assertion.
    const result = makeResult([
      makeAssertion({
        status: "failed",
        ancestorTitles: ["OpenAI Realtime API drift"],
        title: "canary: GA realtime models available",
        failureMessages: [CANARY_NO_GA_WITH_UNKNOWN],
      }),
    ]);
    const entries = entriesOf(result);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.provider).toBe("OpenAI Realtime");
    expect(entry.diffs.every((d) => d.severity === "critical")).toBe(true);
    // The unknown model ids survive as `real` values on knownModels diffs.
    const knownModelReals = entry.diffs.filter((d) => d.path === "knownModels").map((d) => d.real);
    expect(knownModelReals).toEqual(["gpt-realtime-99", "gpt-realtime-99-mini"]);
    // The GA-family diff is still present.
    expect(entry.diffs.some((d) => d.path === "gaModels")).toBe(true);
  });

  it("maps an EMPTY NO_GA marker (no realtime models observed) to a CRITICAL entry too", () => {
    const result = makeResult([
      makeAssertion({
        status: "failed",
        ancestorTitles: ["OpenAI Realtime API drift"],
        title: "canary: GA realtime models available",
        failureMessages: [CANARY_NO_GA_EMPTY],
      }),
    ]);
    const entries = entriesOf(result);
    expect(entries).toHaveLength(1);
    expect(entries[0].provider).toBe("OpenAI Realtime");
    expect(entries[0].diffs.every((d) => d.severity === "critical")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // CLASS 3 — no DriftEntry.real is a non-model prose sentinel, even when the
  // canary array was truncated in CI output.
  // -------------------------------------------------------------------------
  it("never lands a prose sentinel in DriftEntry.real when the canary array is truncated (CLASS 3)", () => {
    const result = makeResult([
      makeAssertion({
        status: "failed",
        ancestorTitles: ["OpenAI Realtime API drift"],
        title: "canary: GA realtime models available",
        failureMessages: [CANARY_FALLBACK_TRUNCATED],
      }),
    ]);
    const entries = entriesOf(result);
    expect(entries).toHaveLength(1);
    for (const d of entries[0].diffs) {
      // No `real` value may be a prose annotation (e.g. "(additional models…)").
      expect(d.real.startsWith("(")).toBe(false);
    }
  });

  // -------------------------------------------------------------------------
  // CLASS 1 — corpus/table test asserting the SAFE outcome for the recurring
  // classifier failure shapes. A1.3 replaces the old binary throws/no-throw
  // with a three-way `outcome`:
  //   "entry"      → surfaced as a structured drift entry (exit 2), NEVER a
  //                  silent exit-0;
  //   "quarantine" → held for human review (exit 5), NEVER a crash and NEVER a
  //                  silent exit-0 (was: fail-loud throw / exit 1);
  //   "infra"      → benign infra, collector returns [] (exit 0).
  // The invariant the corpus protects: an untrusted failure is never a green.
  // -------------------------------------------------------------------------
  describe("CLASS 1 safe-outcome corpus", () => {
    const DRIFT_VALUE_WITH_STATUS_200 = formatDriftReport("OpenAI Chat (non-streaming text)", [
      {
        path: "choices[0].message.content",
        severity: "critical",
        issue: "LLMOCK DRIFT — value mismatch",
        expected: "status 200",
        real: "status 200",
        mock: "<absent>",
      },
    ]);

    const rows: {
      name: string;
      messages: string[];
      outcome: "entry" | "quarantine" | "infra";
    }[] = [
      {
        name: "a drift body containing the substring 'status 200' is surfaced as an entry, NOT swallowed as infra",
        messages: [DRIFT_VALUE_WITH_STATUS_200],
        outcome: "entry",
      },
      {
        name: "a genuine drift report with a leading blank line is surfaced as an entry",
        messages: [GENUINE_DRIFT_WITH_STACK],
        outcome: "entry",
      },
      {
        name: "an 'expected false to be true' hasGA shape is surfaced as a (canary) entry, not swallowed",
        messages: [CANARY_NO_GA_MARKER],
        outcome: "entry",
      },
      {
        name: "an 'expected […] to deeply equal []' canary shape is surfaced as an entry, not swallowed",
        messages: [CANARY_MARKER_MULTI],
        outcome: "entry",
      },
      {
        name: "a bare AssertionError with no infra token and no drift marker is quarantined (exit 5), not swallowed",
        messages: ["AssertionError: expected 1 to be 2 // Object.is equality\n    at foo (x:1:1)"],
        outcome: "quarantine",
      },
      {
        name: "an infra token confined to a stack frame is quarantined (exit 5) (A3)",
        messages: [INFRA_TOKEN_IN_STACKFRAME_ONLY],
        outcome: "quarantine",
      },
    ];

    for (const row of rows) {
      it(row.name, () => {
        const result = makeResult(
          row.messages.map((m) =>
            makeAssertion({
              status: "failed",
              ancestorTitles: ["OpenAI Realtime API drift"],
              title: "canary: GA realtime models available",
              failureMessages: [m],
            }),
          ),
        );
        expect(() => collectDriftEntries(result)).not.toThrow();
        const { entries, quarantine } = collectDriftEntries(result);
        if (row.outcome === "entry") {
          expect(entries.length).toBeGreaterThan(0);
          expect(exitCodeOf(result)).toBe(2);
        } else if (row.outcome === "quarantine") {
          expect(entries).toEqual([]);
          expect(quarantine.length).toBeGreaterThan(0);
          expect(exitCodeOf(result)).toBe(5);
          expect(exitCodeOf(result)).not.toBe(0);
        } else {
          expect(entries).toEqual([]);
          expect(quarantine).toEqual([]);
          expect(exitCodeOf(result)).toBe(0);
        }
      });
    }

    it("still classifies genuine infra (body token) as benign — collector returns [] entries+quarantine (exit 0)", () => {
      const result = makeResult([
        makeAssertion({
          status: "failed",
          ancestorTitles: ["OpenAI Chat Completions drift"],
          title: "non-streaming text matches real API",
          failureMessages: [REAL_INFRA_BODY],
        }),
      ]);
      expect(entriesOf(result)).toEqual([]);
      expect(quarantineOf(result)).toEqual([]);
      expect(exitCodeOf(result)).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // A1.4 TAXONOMY — the exit-code taxonomy end-to-end through the REAL collector
  // + computeExitCode. Each row asserts the full path from a vitest failure
  // shape to the process exit code main() would emit.
  // -------------------------------------------------------------------------
  describe("exit-code taxonomy (collector → computeExitCode)", () => {
    it("critical drift → exit 2", () => {
      const driftText = formatDriftReport("OpenAI Chat (non-streaming text)", [SAMPLE_DIFF]);
      const result = makeResult([
        makeAssertion({
          status: "failed",
          ancestorTitles: ["OpenAI Chat Completions drift"],
          failureMessages: [driftText],
        }),
      ]);
      expect(entriesOf(result)).toHaveLength(1);
      expect(quarantineOf(result)).toEqual([]);
      expect(exitCodeOf(result)).toBe(2);
    });

    it("incident-5 unparseable failure → quarantine + exit 5 (NOT a throw)", () => {
      const result = makeResult([
        makeAssertion({
          status: "failed",
          ancestorTitles: ["Broken Suite"],
          title: "a",
          failureMessages: [
            "AssertionError: expected 1 to be 2 // Object.is equality\n    at foo (/repo/src/__tests__/drift/x.drift.ts:8:13)",
          ],
        }),
      ]);
      expect(() => collectDriftEntries(result)).not.toThrow();
      expect(entriesOf(result)).toEqual([]);
      expect(quarantineOf(result)).toHaveLength(1);
      expect(exitCodeOf(result)).toBe(5);
    });

    it("all-infra failures → exit 0 (benign, collector returns nothing)", () => {
      const result = makeResult([
        makeAssertion({
          status: "failed",
          ancestorTitles: ["OpenAI Chat Completions drift"],
          failureMessages: [REAL_INFRA_BODY],
        }),
        makeAssertion({
          status: "failed",
          ancestorTitles: ["OpenAI Responses drift"],
          failureMessages: [
            "INFRA_ERROR: upstream down\n    at h (file:///repo/src/y.drift.ts:1:1)",
          ],
        }),
      ]);
      expect(entriesOf(result)).toEqual([]);
      expect(quarantineOf(result)).toEqual([]);
      expect(exitCodeOf(result)).toBe(0);
    });

    it("canary (unknown-model) failure → critical entry + exit 2", () => {
      const result = makeResult([
        makeAssertion({
          status: "failed",
          ancestorTitles: ["OpenAI Realtime API drift"],
          title: "canary: GA realtime models available",
          failureMessages: [CANARY_MARKER_MULTI],
        }),
      ]);
      const entries = entriesOf(result);
      expect(entries).toHaveLength(1);
      expect(entries[0].diffs.every((d) => d.severity === "critical")).toBe(true);
      expect(exitCodeOf(result)).toBe(2);
    });

    it("empty → fail-loud invariant: an all-unparseable batch is NEVER classified as a benign all-clear", () => {
      // CLASS 1 root invariant surfaced at the collector: an empty evidence set
      // (no positive infra evidence) must NOT be treated as infra. The batch is
      // quarantined (exit 5), never a silent exit 0.
      expect(classifyUnparseableAsInfra([])).toBe(false);
      const result = makeResult([
        makeAssertion({
          status: "failed",
          ancestorTitles: ["Broken Suite"],
          title: "unrecognized",
          failureMessages: [
            "AssertionError: expected 1 to be 2\n    at foo (/repo/src/z.drift.ts:1:1)",
          ],
        }),
      ]);
      expect(exitCodeOf(result)).not.toBe(0);
      expect(exitCodeOf(result)).toBe(5);
    });

    it("critical + quarantine together → exit 2 (critical dominates quarantine)", () => {
      const driftText = formatDriftReport("OpenAI Chat (non-streaming text)", [SAMPLE_DIFF]);
      const result = makeResult([
        makeAssertion({
          status: "failed",
          ancestorTitles: ["OpenAI Chat Completions drift"],
          title: "non-streaming text matches real API",
          failureMessages: [driftText],
        }),
        // An unmapped-provider drift block → quarantined (never dropped) even
        // though a real critical entry is also present.
        makeAssertion({
          status: "failed",
          ancestorTitles: ["UnknownProvider drift"],
          title: "some scenario",
          failureMessages: [formatDriftReport("UnknownProvider (streaming text)", [SAMPLE_DIFF])],
        }),
      ]);
      const { entries, quarantine } = collectDriftEntries(result);
      expect(entries).toHaveLength(1);
      expect(entries[0].provider).toBe("OpenAI Chat");
      expect(quarantine).toHaveLength(1);
      // Critical dominates: exit 2, not 5.
      expect(exitCodeOf(result)).toBe(2);
    });
  });
});

// ---------------------------------------------------------------------------
// parseKnownModelsCanary
// ---------------------------------------------------------------------------

describe("parseKnownModelsCanary", () => {
  it("recovers the FULL unknown-model list from the UNKNOWN_REALTIME_MODELS marker (not truncated)", () => {
    // The printed array is truncated to `…(3)` but the marker carries all four.
    const result = parseKnownModelsCanary(CANARY_MARKER_MULTI);
    expect(result).not.toBeNull();
    expect(result!.ids).toEqual([
      "gpt-realtime-3",
      "gpt-realtime-3-mini",
      "gpt-realtime-3-preview",
      "gpt-realtime-ultra",
    ]);
    // CLASS 3: the marker carries the full list, so nothing is truncated and no
    // prose sentinel may ever occupy an id slot.
    expect(result!.truncated).toBeFalsy();
    expect(result!.ids.every((id) => !id.startsWith("("))).toBe(true);
  });

  it("returns null when the marker is present but the unknown list was empty", () => {
    // Empty unknown list = no drift to surface.
    const msg = "AssertionError: UNKNOWN_REALTIME_MODELS=: expected [] to deeply equal []";
    expect(parseKnownModelsCanary(msg)).toBeNull();
  });

  it("falls through to the printed-array fallback when the marker value is mangled/empty (A2)", () => {
    // A2: an empty/mangled marker must NOT short-circuit to null; it must fall
    // through so a recoverable id in the printed array is still surfaced.
    const msg =
      "AssertionError: UNKNOWN_REALTIME_MODELS=: expected [ 'gpt-realtime-3', …(1) ] to deeply equal []";
    const result = parseKnownModelsCanary(msg);
    expect(result).not.toBeNull();
    expect(result!.ids[0]).toBe("gpt-realtime-3");
    // CLASS 3: truncation is a boolean flag, NOT a prose id in the list.
    expect(result!.truncated).toBe(true);
    expect(result!.ids.every((id) => !id.startsWith("("))).toBe(true);
  });

  it("returns null for a non-canary message", () => {
    expect(parseKnownModelsCanary("TypeError: something unrelated")).toBeNull();
    expect(parseKnownModelsCanary("")).toBeNull();
  });

  describe("fallback (no marker — legacy message shape)", () => {
    // NOTE: the fallback fires ONLY in a confirmed ws-realtime canary context.
    // A REAL marker-less canary failure ALWAYS carries the canary's origin frame
    // (`at …/ws-realtime.drift.ts`), which these fixtures include — that frame
    // is the recognizer that distinguishes a genuine canary from a generic
    // non-canary `toEqual([])` failure in some other provider's test.
    const CANARY_ORIGIN = "\n    at /repo/src/__tests__/drift/ws-realtime.drift.ts:108:69";

    it("detects the single-glyph Unicode ellipsis `…(1)` truncation (as a flag, not a sentinel id)", () => {
      const msg =
        "AssertionError: expected [ 'gpt-realtime-3', …(1) ] to deeply equal []" + CANARY_ORIGIN;
      const result = parseKnownModelsCanary(msg);
      expect(result).not.toBeNull();
      expect(result!.ids[0]).toBe("gpt-realtime-3");
      // CLASS 3: no prose sentinel in the id list; truncation is a boolean.
      expect(result!.truncated).toBe(true);
      expect(result!.ids.every((id) => !id.startsWith("("))).toBe(true);
    });

    it("also detects the three-dot ASCII ellipsis `... (1)` truncation", () => {
      const msg =
        "AssertionError: expected [ 'gpt-realtime-3', ... (1) ] to deeply equal []" + CANARY_ORIGIN;
      const result = parseKnownModelsCanary(msg);
      expect(result!.truncated).toBe(true);
      expect(result!.ids.every((id) => !id.startsWith("("))).toBe(true);
    });

    it("parses a small untruncated printed array", () => {
      const msg =
        "AssertionError: expected [ 'gpt-realtime-3', 'gpt-realtime-3-mini' ] to deeply equal []" +
        CANARY_ORIGIN;
      const result = parseKnownModelsCanary(msg);
      expect(result!.ids).toEqual(["gpt-realtime-3", "gpt-realtime-3-mini"]);
      expect(result!.truncated).toBeFalsy();
    });

    it("returns null for an empty printed array (genuinely no unknown models)", () => {
      const msg = "AssertionError: expected [] to deeply equal []";
      expect(parseKnownModelsCanary(msg)).toBeNull();
    });

    it("flags truncation-only content (glyph present, no extractable id) without inventing a prose id", () => {
      // Inner had a truncation glyph but no quoted ids we could extract. Carries
      // the ws-realtime canary origin path so the fallback gate recognizes it as
      // a genuine canary failure (a real canary failure ALWAYS carries this
      // frame). Without a canary-origin token the fallback must NOT fire.
      const msg =
        "AssertionError: expected [ …(4) ] to deeply equal []\n" +
        "    at /repo/src/__tests__/drift/ws-realtime.drift.ts:108:69";
      const result = parseKnownModelsCanary(msg);
      expect(result).not.toBeNull();
      // CLASS 3: no non-model prose id — the fact lives entirely in `truncated`.
      expect(result!.ids.every((id) => !id.startsWith("("))).toBe(true);
      expect(result!.truncated).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // MISATTRIBUTION GUARD (bucket (a) finding): the printed-array fallback must
  // fire ONLY for a genuine ws-realtime known-models canary failure. A generic
  // `expected [...] to deeply equal []` from ANY OTHER provider/test (no
  // realtime-canary marker AND not originating from ws-realtime.drift.ts) must
  // NOT be claimed as OpenAI-Realtime known-models drift — its arbitrary array
  // contents (which could be a leaked secret, an object shape, anything) must
  // never be relabeled as "unknown model ids".
  // -------------------------------------------------------------------------
  describe("fallback gating — non-canary toEqual([]) is NOT misattributed", () => {
    it("returns null for a non-canary toEqual([]) failure carrying arbitrary array contents (RED before gate)", () => {
      // A DIFFERENT provider's test asserted `toEqual([])` and the array held an
      // arbitrary value — here a leaked-looking secret. NO realtime-canary marker
      // and NO ws-realtime.drift.ts origin: this is not the canary and must not
      // be parsed as one.
      const msg =
        "AssertionError: expected [ 'sk-leaked' ] to deeply equal []\n" +
        "    at /repo/src/__tests__/drift/openai-chat.drift.ts:42:30";
      expect(parseKnownModelsCanary(msg)).toBeNull();
    });

    it("returns null for a bare non-canary toEqual([]) failure with no origin frame at all", () => {
      const msg = "AssertionError: expected [ 'sk-leaked' ] to deeply equal []";
      expect(parseKnownModelsCanary(msg)).toBeNull();
    });

    it("still parses a genuine marker-less canary failure that carries the ws-realtime.drift.ts origin", () => {
      // No structured marker (mangled/stripped), but the stack frame identifies
      // the canary — the fallback SHOULD still recover the id.
      const result = parseKnownModelsCanary(CANARY_FALLBACK_TRUNCATED);
      expect(result).not.toBeNull();
      expect(result!.ids[0]).toBe("gpt-realtime-9");
      expect(result!.truncated).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // CLASS 2 — the NO_GA_REALTIME_MODELS marker (hasGA-false mode)
  // -------------------------------------------------------------------------
  describe("NO_GA_REALTIME_MODELS marker (hasGA-false)", () => {
    it("recognizes the marker and returns the observed model ids with noGA=true", () => {
      const result = parseKnownModelsCanary(CANARY_NO_GA_MARKER);
      expect(result).not.toBeNull();
      expect(result!.noGA).toBe(true);
      expect(result!.ids).toEqual(["gpt-foo", "gpt-bar"]);
    });

    it("recognizes an EMPTY NO_GA marker (no realtime models observed at all) as noGA=true", () => {
      const result = parseKnownModelsCanary(CANARY_NO_GA_EMPTY);
      expect(result).not.toBeNull();
      expect(result!.noGA).toBe(true);
      expect(result!.ids).toEqual([]);
      expect(result!.unknownIds ?? []).toEqual([]);
    });

    it("preserves the unknown-model list carried alongside the NO_GA marker (info-loss fix)", () => {
      // Combined case: no-GA AND new unknown models. The hasGA assertion
      // short-circuits the unknown-models assertion, so the NO_GA marker carries
      // BOTH lists. The observed and unknown lists must be split cleanly.
      const result = parseKnownModelsCanary(CANARY_NO_GA_WITH_UNKNOWN);
      expect(result).not.toBeNull();
      expect(result!.noGA).toBe(true);
      expect(result!.ids).toEqual(["gpt-foo", "gpt-bar"]);
      expect(result!.unknownIds).toEqual(["gpt-realtime-99", "gpt-realtime-99-mini"]);
    });
  });
});

// ---------------------------------------------------------------------------
// classifyUnparseableAsInfra (A3 — symmetric normalization safety net)
// ---------------------------------------------------------------------------

describe("classifyUnparseableAsInfra", () => {
  it("returns false for an EMPTY evidence array — no evidence is NOT proof of infra (CLASS 1)", () => {
    // Vacuous `.every` on [] returns true; the fix must NOT treat "no evidence"
    // as "all clear". Unrecognized ⇒ fail loud, never a false all-clear.
    expect(classifyUnparseableAsInfra([])).toBe(false);
  });

  it("does NOT swallow a failure whose only infra token is confined to a stack frame (A3)", () => {
    // Pre-fix: the raw scan saw ECONNREFUSED in the frame → allInfraErrors true
    // → swallowed. The fix strips frames for BOTH scans, so the token is gone
    // and the failure is not classified as infra.
    expect(classifyUnparseableAsInfra([INFRA_TOKEN_IN_STACKFRAME_ONLY])).toBe(false);
  });

  it("does NOT swallow genuine drift carried in an AssertionError with a leading blank line", () => {
    expect(classifyUnparseableAsInfra([GENUINE_DRIFT_WITH_STACK])).toBe(false);
  });

  it("does NOT treat a bare AssertionError as benign infra", () => {
    const msg = "AssertionError: expected [ 'x' ] to deeply equal []\n    at foo (file:///x)";
    expect(classifyUnparseableAsInfra([msg])).toBe(false);
  });

  it("still classifies genuine infra errors (token in the body) as infra", () => {
    expect(classifyUnparseableAsInfra([REAL_INFRA_BODY])).toBe(true);
    expect(classifyUnparseableAsInfra(["INFRA_ERROR: upstream down\n    at foo (file:///x)"])).toBe(
      true,
    );
    expect(classifyUnparseableAsInfra(["API returned 503 Service Unavailable"])).toBe(true);
  });

  it("does NOT classify a drift body whose VALUE contains 'status 200' as infra (CLASS 1 anchoring)", () => {
    // A real drift value like "status 200" appearing anywhere in the body must
    // not trip the infra gate. The infra 'status \\d{3}' indicator must anchor
    // to the failure reason/line, not a bare substring inside a drift value.
    const msg =
      "AssertionError: \nAPI DRIFT DETECTED: OpenAI Chat (non-streaming text)\n\n" +
      "  1. [critical] LLMOCK DRIFT — mismatch detected\n" +
      "     Path:    choices[0].message.content\n" +
      "     SDK:     status 200\n" +
      "     Real:    status 200\n" +
      "     Mock:    <absent>\n";
    expect(classifyUnparseableAsInfra([msg])).toBe(false);
  });

  it("does NOT classify a labelled 'Real: API returned 503' drift VALUE as infra (CLASS 1 anchoring)", () => {
    // Symmetric to the 'status 200' anchoring case above, and to the already-
    // anchored 'status \\d{3}' sibling. A drift *value* like "API returned 503"
    // appearing AFTER a `Field:` label must NOT trip the infra gate. The
    // 'API returned \\d{3}' indicator must anchor to the failure reason/line
    // (line start, optional `HTTP ` prefix) exactly like 'status \\d{3}' does —
    // an anchoring-defeating `(?:.*:\\s*)?` prefix lets a labelled value match
    // and silently swallow genuine drift. This message is deliberately NOT
    // drift-like (no "drift"/"mismatch"/"expected…to" markers) so the
    // anchoring of the infra indicator is the SOLE determinant of the outcome.
    const msg =
      "     Path:    choices[0].message.content\n" +
      "     SDK:     n/a\n" +
      "     Real: API returned 503\n" +
      "     Mock:    <absent>\n";
    expect(classifyUnparseableAsInfra([msg])).toBe(false);
  });

  it("still classifies a bare line-start 'API returned 503' reason as infra (anchoring preserved)", () => {
    // The anchoring fix must NOT break the genuine infra case: a line whose
    // reason IS "API returned <status>" (optionally `HTTP `-prefixed, at line
    // start) is still infra. Guards against over-tightening the anchor.
    expect(classifyUnparseableAsInfra(["API returned 503 Service Unavailable"])).toBe(true);
    expect(classifyUnparseableAsInfra(["  HTTP API returned 500"])).toBe(true);
  });

  it("does not false-positive drift from a stack-trace filename like ws-realtime.drift.ts", () => {
    // A recognized infra error (token in BODY) whose stack frame mentions
    // "ws-realtime.drift.ts" stays infra — the frame filename is stripped.
    const msg = "fetch failed\n    at handler (file:///repo/src/ws-realtime.drift.ts:5:1)";
    expect(classifyUnparseableAsInfra([msg])).toBe(true);
  });

  // -------------------------------------------------------------------------
  // PROPERTY-BASED uniform-anchoring test — the NON-RECURRING deliverable.
  //
  // Iterates the REAL exported infra-indicator list (INFRA_INDICATOR_SOURCES),
  // NOT a hand-copied subset. For EVERY indicator it asserts through the REAL
  // exported classifyUnparseableAsInfra that:
  //   (a) a labelled drift-body line `Real:    <sample>` (no drift marker) is
  //       NOT classified as infra — genuine drift is surfaced/fail-loud; and
  //   (b) a bare line-start `<sample>` failure reason IS classified as infra.
  //
  // This is what makes the class non-recurring: if a future indicator is added
  // to INFRA_INDICATOR_SPECS but individually mis-anchored (e.g. with the
  // old `(?:.*:\s*)?` prefix or an unanchored `/i`), row (a) fails automatically
  // for that indicator — no one has to remember to add a bespoke test.
  //
  // RED before the uniform-anchoring fix: at minimum the `empty response`,
  // `returned no SSE events`, and `returned empty body` rows fail case (a)
  // (they were `(?:.*:\s*)?`-prefixed or unanchored, so a labelled value matched
  // and swallowed genuine drift). GREEN after: all rows pass both cases.
  // -------------------------------------------------------------------------
  describe("uniform anchoring across the REAL infra-indicator list (property)", () => {
    it("exports a non-empty indicator list to iterate", () => {
      expect(INFRA_INDICATOR_SOURCES.length).toBeGreaterThan(0);
    });

    for (const source of INFRA_INDICATOR_SOURCES) {
      const sample = infraIndicatorSample(source);

      it(`[${source}] a labelled drift-body value "Real: ${sample}" is NOT swallowed as infra (a)`, () => {
        // A labelled body line carrying the phrase as a drift VALUE. No drift
        // marker present, so the infra-indicator anchoring is the SOLE
        // determinant: if the indicator is properly line-anchored it does NOT
        // match here (the phrase follows a `Real:` label), so the batch is not
        // all-infra and the failure is surfaced (classify → false).
        const msg =
          "     Path:    choices[0].message.content\n" +
          "     SDK:     n/a\n" +
          `     Real:    ${sample}\n` +
          "     Mock:    <absent>\n";
        expect(classifyUnparseableAsInfra([msg])).toBe(false);
      });

      it(`[${source}] a bare line-start "${sample}" failure reason IS classified as infra (b)`, () => {
        // The phrase AS the failure reason at line start must still be infra —
        // the anchoring fix must not over-tighten and break genuine infra.
        expect(classifyUnparseableAsInfra([sample])).toBe(true);
      });

      it(`[${source}] taxonomy (c): a bare "${sample}" reason → collector exit 0 (benign, no quarantine)`, () => {
        // A1.4 extension: tie the infra classification to the exit-code taxonomy
        // at the REAL collector surface. A bare infra-reason failure must be a
        // benign exit 0 — NOT quarantined (exit 5) and NOT a crash.
        const result = makeResult([
          makeAssertion({
            status: "failed",
            ancestorTitles: ["OpenAI Chat Completions drift"],
            title: "non-streaming text matches real API",
            failureMessages: [sample],
          }),
        ]);
        expect(() => collectDriftEntries(result)).not.toThrow();
        expect(entriesOf(result)).toEqual([]);
        expect(quarantineOf(result)).toEqual([]);
        expect(exitCodeOf(result)).toBe(0);
      });

      it(`[${source}] taxonomy (c'): a labelled "Real: ${sample}" drift value → NOT exit 0 (quarantined, exit 5)`, () => {
        // Symmetric to (a) at the collector surface: a labelled body value that
        // merely CONTAINS the infra phrase must never be swallowed as a green.
        // It is not a full parseable drift block, so it is quarantined (exit 5).
        const msg =
          "     Path:    choices[0].message.content\n" +
          "     SDK:     n/a\n" +
          `     Real:    ${sample}\n` +
          "     Mock:    <absent>\n";
        const result = makeResult([
          makeAssertion({
            status: "failed",
            ancestorTitles: ["OpenAI Chat Completions drift"],
            title: "non-streaming text matches real API",
            failureMessages: [msg],
          }),
        ]);
        expect(exitCodeOf(result)).not.toBe(0);
        expect(exitCodeOf(result)).toBe(5);
      });
    }
  });
});

// ---------------------------------------------------------------------------
// D6.2 — per-item `id` field on ParsedDiff
//
// The delta layer (D6.1) keys findings by `provider+id`. For N distinct unknown
// model ids, the collector must produce N DISTINCT per-item `id` values so that
// a downstream `provider+id` keying yields N distinct keys — not 1 collapsed
// key under `path:"knownModels"` (pre-fix behaviour when `id` was absent/undefined).
//
// RED (pre-fix): `id` is unset on every ParsedDiff produced by the canary path,
//   so all 3 diffs have `id === undefined` → only 1 distinct key.
// GREEN (post-fix): each diff carries `id` = the model id stored in `diff.real`,
//   so 3 distinct unknown ids → 3 distinct `id` values → 3 distinct keys.
// ---------------------------------------------------------------------------

describe("D6.2 — per-item id on ParsedDiff", () => {
  // Three distinct hypothetical unknown model ids (not in the knownModels set
  // in ws-realtime.drift.ts — A4 note: use future/hypothetical ids only).
  const THREE_UNKNOWN_IDS_CANARY =
    "AssertionError: UNKNOWN_REALTIME_MODELS=gpt-realtime-x1,gpt-realtime-x2,gpt-realtime-x3: " +
    "expected [ 'gpt-realtime-x1', …(2) ] to deeply equal []\n" +
    "    at /repo/src/__tests__/drift/ws-realtime.drift.ts:108:69";

  it("D6.2 RED→GREEN: 3 distinct canary model ids produce 3 DISTINCT per-item id fields (not collapsed under undefined)", () => {
    const result = makeResult([
      makeAssertion({
        status: "failed",
        ancestorTitles: ["OpenAI Realtime API drift"],
        title: "canary: GA realtime models available",
        failureMessages: [THREE_UNKNOWN_IDS_CANARY],
      }),
    ]);

    const entries = entriesOf(result);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.provider).toBe("OpenAI Realtime");

    // There should be exactly 3 diffs — one per unknown model id.
    expect(entry.diffs).toHaveLength(3);

    // D6.2 core assertion: each diff must carry a populated `id` field equal to
    // the model id in `diff.real`, and all three must be distinct.
    const ids = entry.diffs.map((d) => d.id);
    expect(ids).toEqual(["gpt-realtime-x1", "gpt-realtime-x2", "gpt-realtime-x3"]);

    // All three ids are defined (not undefined).
    expect(ids.every((id) => id !== undefined)).toBe(true);

    // All three ids are DISTINCT — a downstream provider+id key would yield 3
    // different keys, not 1 collapsed key under undefined/absent id.
    const distinctIds = new Set(ids);
    expect(distinctIds.size).toBe(3);

    // The model ids must match what's in `diff.real` (the source of truth).
    for (const diff of entry.diffs) {
      expect(diff.id).toBe(diff.real);
    }
  });

  it("D6.2: parseDriftBlock-path diffs carry a stable id derived from path", () => {
    // For regular drift-block diffs (not canary), `id` is derived from
    // the `path` field so different paths → different ids.
    const formatted = formatDriftReport("OpenAI Chat (non-streaming text)", [
      { ...SAMPLE_DIFF, path: "choices[0].message.refusal" },
      { ...SAMPLE_DIFF, path: "choices[0].message.content", severity: "warning" as const },
    ]);
    const parsed = parseDriftBlock(formatted);
    expect(parsed).not.toBeNull();
    expect(parsed!.diffs).toHaveLength(2);

    const ids = parsed!.diffs.map((d) => d.id);
    // Both diffs must have a non-empty id.
    expect(ids.every((id) => id !== undefined && id !== "")).toBe(true);
    // The two paths are different → two distinct ids.
    expect(new Set(ids).size).toBe(2);
    // Each id must be derived from (or equal to) the path.
    for (const diff of parsed!.diffs) {
      expect(diff.id).toBe(diff.path);
    }
  });
});

// ===========================================================================
// WS-5 — structural surface keying via SURFACE_REGISTRY
// ===========================================================================

describe("WS-5 extractSurfaceKey", () => {
  it("reads the Surface: marker line emitted by formatDriftReport(surface)", () => {
    const block = formatDriftReport(
      "Cohere /v2/chat (non-streaming)",
      [SAMPLE_DIFF],
      "cohere-chat",
    );
    expect(extractSurfaceKey(block)).toBe("cohere-chat");
  });

  it("returns null for a legacy block with no Surface: marker", () => {
    const block = formatDriftReport("Cohere /v2/chat (non-streaming)", [SAMPLE_DIFF]);
    expect(extractSurfaceKey(block)).toBeNull();
  });
});

describe("WS-5 — previously-quarantined surfaces now route to exit-2 entries", () => {
  // A drift block for a surface that today is NOT a PROVIDER_MAP key. On old
  // code these route to a quarantine (exit 5) because extractProviderName
  // returns null. With the surface marker + registry they become auto-fixable
  // exit-2 entries.
  //
  // CRITICAL — each title below is NEUTRAL PROSE that contains NO registry
  // provider label (nor a legacy alias) as a substring, in either the ancestor
  // title OR the emitted context. That is deliberate: it means the legacy
  // `extractProviderName` fallback returns null for every one of these, so the
  // ONLY thing that can route them to an entry is the `Surface:` marker seam. If
  // the WS-5 seam is reverted, ALL of these go RED (verified). This closes the
  // F1 gap where fal/elevenlabs stayed green on revert because their titles
  // happened to contain the legacy label substring. (≥3 cells; 4 for margin.)
  const CASES: { surface: string; title: string; provider: string; builderFile: string }[] = [
    {
      surface: "moderation",
      title: "content-safety endpoint 400 payload",
      provider: "OpenAI Moderations",
      builderFile: "src/moderation.ts",
    },
    {
      surface: "video",
      title: "async media generation status poll",
      provider: "OpenAI Video",
      builderFile: "src/video.ts",
    },
    {
      surface: "transcription",
      title: "audio-to-text multipart upload",
      provider: "Transcription",
      builderFile: "src/transcription.ts",
    },
    {
      surface: "rerank",
      title: "document relevance scoring endpoint",
      provider: "Cohere Rerank",
      builderFile: "src/rerank.ts",
    },
  ];

  for (const c of CASES) {
    it(`RED→GREEN: "${c.surface}" drift → exit-2 entry (marker-only, legacy label CANNOT rescue)`, () => {
      const block = formatDriftReport(c.title, [SAMPLE_DIFF], c.surface);
      const result = makeResult([
        makeAssertion({
          ancestorTitles: [`${c.title} drift`],
          title: "shape matches SDK",
          failureMessages: [`AssertionError: ${block}`],
        }),
      ]);

      // Guard the guard: the neutral prose title must NOT be resolvable via the
      // legacy provider-label path, so the marker seam is genuinely required. If
      // this ever starts returning non-null, the RED→GREEN below is a false lock.
      expect(extractProviderName(`${c.title} drift`)).toBeNull();
      expect(extractProviderName(c.title)).toBeNull();

      const { entries, quarantine } = collectDriftEntries(result);
      // The fix: routed to a trustworthy entry, NOT quarantined.
      expect(quarantine).toHaveLength(0);
      expect(entries).toHaveLength(1);

      const entry = entries[0];
      expect(entry.provider).toBe(c.provider);
      expect(entry.builderFile).toBe(c.builderFile);
      expect(entry.builderFunctions.length).toBeGreaterThan(0);
      expect(entry.sdkShapesFile.length).toBeGreaterThan(0);

      // Exit code: 2 (auto-fixable), not 5 (quarantine).
      expect(exitCodeOf(result)).toBe(2);
    });
  }

  it("legacy no-marker fallback: a truly un-keyable block still quarantines (exit 5)", () => {
    // A marker-less block whose prose title matches NO registry provider label
    // routes to quarantine exactly as before WS-5 — the defensive legacy net is
    // preserved for genuinely un-attributable output.
    const block = formatDriftReport("SomeBrandNewProvider /v9/widgets", [SAMPLE_DIFF]);
    const result = makeResult([
      makeAssertion({
        ancestorTitles: ["SomeBrandNewProvider drift"],
        title: "shape matches SDK",
        failureMessages: [`AssertionError: ${block}`],
      }),
    ]);
    const { entries, quarantine } = collectDriftEntries(result);
    expect(entries).toHaveLength(0);
    expect(quarantine).toHaveLength(1);
    expect(exitCodeOf(result)).toBe(5);
  });

  it("legacy no-marker fallback still resolves a known provider LABEL to an entry", () => {
    // Back-compat: an unmigrated block that carries no Surface: marker but whose
    // prose title contains a registered provider label still routes to an entry.
    const block = formatDriftReport("Cohere Chat completions", [SAMPLE_DIFF]);
    const result = makeResult([
      makeAssertion({
        ancestorTitles: ["Cohere Chat drift"],
        title: "shape matches SDK",
        failureMessages: [`AssertionError: ${block}`],
      }),
    ]);
    const { entries, quarantine } = collectDriftEntries(result);
    expect(quarantine).toHaveLength(0);
    expect(entries).toHaveLength(1);
    expect(entries[0].builderFile).toBe("src/cohere.ts");
  });
});

describe("WS-5 — unknown surface slug fails LOUD (throws), never silent quarantine", () => {
  it("collectDriftEntries throws on a marker with a slug not in the registry", () => {
    // Build the block manually — formatDriftReport(surface) would itself throw
    // on an unknown slug, so synthesize the marker directly to exercise the
    // COLLECTOR's runtime throw.
    const block =
      "\nAPI DRIFT DETECTED: Totally New Surface\n" +
      "  Surface: totally-new-surface\n\n" +
      "  1. [critical] LLMOCK DRIFT — mismatch detected\n" +
      "     Path:    a.b.c\n" +
      "     SDK:     null\n" +
      "     Real:    null\n" +
      "     Mock:    <absent>\n";
    const result = makeResult([
      makeAssertion({
        ancestorTitles: ["Totally New Surface drift"],
        title: "shape matches SDK",
        failureMessages: [`AssertionError: ${block}`],
      }),
    ]);

    expect(() => collectDriftEntries(result)).toThrow(
      /Unknown drift surface "totally-new-surface"/,
    );
  });

  it("formatDriftReport throws at emit time on an unknown slug", () => {
    expect(() => formatDriftReport("X", [SAMPLE_DIFF], "not-a-real-surface")).toThrow(
      /unknown drift surface "not-a-real-surface"/,
    );
  });

  it.each(["constructor", "__proto__", "hasOwnProperty", "toString", "valueOf"])(
    "throws (not garbage entry) when the marker slug is the Object.prototype member %s",
    (protoSlug) => {
      // A prototype-chain bracket lookup (SURFACE_REGISTRY[slug]) would resolve
      // these to a truthy INHERITED member and skip the throw, emitting a
      // DriftEntry with builderFile: undefined. The Object.hasOwn / isKnownSurface
      // guard must treat them as unknown and THROW loudly.
      const block =
        `\nAPI DRIFT DETECTED: Prototype Slug\n` +
        `  Surface: ${protoSlug}\n\n` +
        "  1. [critical] LLMOCK DRIFT — mismatch detected\n" +
        "     Path:    a.b.c\n" +
        "     SDK:     null\n" +
        "     Real:    null\n" +
        "     Mock:    <absent>\n";
      const result = makeResult([
        makeAssertion({
          ancestorTitles: ["Prototype Slug drift"],
          title: "shape matches SDK",
          failureMessages: [`AssertionError: ${block}`],
        }),
      ]);

      expect(() => collectDriftEntries(result)).toThrow(
        new RegExp(`Unknown drift surface "${protoSlug.replace(/[$]/g, "\\$&")}"`),
      );
    },
  );
});

describe("WS-5 — base-report reuse contract (generatedAt + conclusion)", () => {
  it("conclusionForExitCode maps exit codes to coarse conclusions", () => {
    expect(conclusionForExitCode(0)).toBe("clean");
    expect(conclusionForExitCode(2)).toBe("critical");
    expect(conclusionForExitCode(5)).toBe("quarantine");
    expect(conclusionForExitCode(1)).toBe("skipped");
  });

  it("isBaseReportReusable accepts a written clean report (reuse works)", () => {
    // A report shaped like what main() now writes for a clean run.
    const timestamp = new Date().toISOString();
    const report: DriftReport = {
      timestamp,
      generatedAt: timestamp,
      conclusion: conclusionForExitCode(0),
      entries: [
        {
          provider: "OpenAI Chat",
          scenario: "non-streaming text",
          builderFile: "src/helpers.ts",
          builderFunctions: ["buildTextCompletion"],
          typesFile: "src/types.ts",
          sdkShapesFile: "src/__tests__/drift/sdk-shapes.ts",
          diffs: [],
        },
      ],
    };
    // Same-UTC-day + known-good conclusion + non-empty entries → reusable.
    expect(isBaseReportReusable(report, report.conclusion, true)).toBe(true);
  });

  it("a report WITHOUT conclusion is not reusable (documents the pre-fix gap)", () => {
    const timestamp = new Date().toISOString();
    const legacy: DriftReport = {
      timestamp,
      entries: [
        {
          provider: "OpenAI Chat",
          scenario: "non-streaming text",
          builderFile: "src/helpers.ts",
          builderFunctions: ["buildTextCompletion"],
          typesFile: "src/types.ts",
          sdkShapesFile: "src/__tests__/drift/sdk-shapes.ts",
          diffs: [],
        },
      ],
    };
    // No conclusion field → falls back to undefined → not reusable.
    expect(isBaseReportReusable(legacy, legacy.conclusion, true)).toBe(false);
  });

  it("generatedAt drives sameUtcDay staleness: same-day report reuses, prior-day does not", () => {
    // Mirrors the sameUtcDay derivation the drift workflow computes from
    // report.generatedAt (.github/workflows/test-drift.yml). This locks the
    // *semantics* of generatedAt (a stale-day base is rejected), not merely that
    // the field is written. A clean report identical in every way EXCEPT its
    // generatedAt day must flip reusability.
    const sameUtcDay = (generatedAt: string, now: Date): boolean => {
      const g = new Date(generatedAt);
      return (
        g.getUTCFullYear() === now.getUTCFullYear() &&
        g.getUTCMonth() === now.getUTCMonth() &&
        g.getUTCDate() === now.getUTCDate()
      );
    };

    const now = new Date("2026-07-15T12:00:00.000Z");
    const cleanReport = (generatedAt: string): DriftReport => ({
      timestamp: generatedAt,
      generatedAt,
      conclusion: conclusionForExitCode(0),
      entries: [
        {
          provider: "OpenAI Chat",
          scenario: "non-streaming text",
          builderFile: "src/helpers.ts",
          builderFunctions: ["buildTextCompletion"],
          typesFile: "src/types.ts",
          sdkShapesFile: "src/__tests__/drift/sdk-shapes.ts",
          diffs: [],
        },
      ],
    });

    // Same UTC day (later hour, same date) → derivation true → reusable.
    const today = cleanReport("2026-07-15T03:00:00.000Z");
    expect(sameUtcDay(today.generatedAt!, now)).toBe(true);
    expect(isBaseReportReusable(today, today.conclusion, sameUtcDay(today.generatedAt!, now))).toBe(
      true,
    );

    // Prior UTC day → derivation false → NOT reusable, despite an otherwise
    // identical clean report. generatedAt is what makes the difference.
    const yesterday = cleanReport("2026-07-14T23:59:59.000Z");
    expect(sameUtcDay(yesterday.generatedAt!, now)).toBe(false);
    expect(
      isBaseReportReusable(
        yesterday,
        yesterday.conclusion,
        sameUtcDay(yesterday.generatedAt!, now),
      ),
    ).toBe(false);
  });
});

/**
 * Statically extract every `surface` slug that a `*.drift.ts` emitter passes as
 * the THIRD argument of `formatDriftReport(context, diffs, surface)`.
 *
 * This scans the real source via the TypeScript AST (NOT regex/text lexing — a
 * text scan would mis-hit `formatDriftReport` inside strings/comments and cannot
 * reliably pick the 3rd argument across multiline calls). Only string-literal
 * 3rd args are collected: a 2-arg call (legacy, no marker — e.g. models.drift.ts)
 * or a non-literal arg contributes no slug and is intentionally skipped.
 */
function collectEmittedSurfaceSlugs(): { slugs: Set<string>; scannedFiles: string[] } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ts = require("typescript") as typeof import("typescript");
  const driftDir = resolve(__dirname, "drift");
  const files = readdirSync(driftDir).filter((f) => f.endsWith(".drift.ts"));
  const slugs = new Set<string>();

  for (const file of files) {
    const abs = resolve(driftDir, file);
    const source = readFileSync(abs, "utf8");
    const sf = ts.createSourceFile(abs, source, ts.ScriptTarget.Latest, true);

    const visit = (node: import("typescript").Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "formatDriftReport" &&
        node.arguments.length >= 3
      ) {
        const third = node.arguments[2];
        if (ts.isStringLiteral(third) || ts.isNoSubstitutionTemplateLiteral(third)) {
          slugs.add(third.text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { slugs, scannedFiles: files };
}

describe("WS-5 — SURFACE_REGISTRY coverage & integrity", () => {
  it("every slug an emitter passes to formatDriftReport is a registered surface", () => {
    // Independent derivation (F2/F3): scan the ACTUAL emitter call sites rather
    // than iterating the registry's own keys (which is a tautology). This locks
    // the "every emitter is registered" invariant at TEST time, so a new
    // unregistered emitter fails CI even on a credential-less run where no drift
    // is ever emitted and the collector's runtime throw is never reached.
    const { slugs, scannedFiles } = collectEmittedSurfaceSlugs();
    expect(scannedFiles.length, "found *.drift.ts files to scan").toBeGreaterThan(0);
    expect(slugs.size, "found at least one emitted surface slug").toBeGreaterThan(0);

    const unregistered = [...slugs].filter((slug) => !isKnownSurface(slug));
    expect(
      unregistered,
      `emitter slug(s) missing from SURFACE_REGISTRY: ${unregistered.join(", ")}`,
    ).toEqual([]);
  });

  it("SURFACE_REGISTRY has no orphan slugs (every registered surface is emitted)", () => {
    // Reverse direction: an entry no emitter uses is dead weight. Kept as a
    // separate assertion so a future intentional pre-registration is easy to see.
    const { slugs } = collectEmittedSurfaceSlugs();
    const orphans = KNOWN_SURFACE_SLUGS.filter((slug) => !slugs.has(slug));
    expect(orphans, `registered but never emitted: ${orphans.join(", ")}`).toEqual([]);
  });

  it("every registry entry resolves to an existing builderFile with non-empty builderFunctions", () => {
    // Mirrors the fix-drift.ts validation so a bad entry fails locally, not in CI.
    const repoRoot = resolve(__dirname, "..", "..");
    for (const [slug, mapping] of Object.entries(SURFACE_REGISTRY)) {
      expect(mapping.provider.length, `${slug} provider`).toBeGreaterThan(0);
      expect(mapping.builderFunctions.length, `${slug} builderFunctions`).toBeGreaterThan(0);
      expect(
        mapping.builderFunctions.every((f) => typeof f === "string" && f.length > 0),
        `${slug} builderFunctions all non-empty strings`,
      ).toBe(true);
      const abs = resolve(repoRoot, mapping.builderFile);
      expect(existsSync(abs), `${slug} builderFile exists: ${mapping.builderFile}`).toBe(true);
      if (mapping.typesFile !== null) {
        expect(
          existsSync(resolve(repoRoot, mapping.typesFile)),
          `${slug} typesFile exists: ${mapping.typesFile}`,
        ).toBe(true);
      }
    }
  });

  it("provider labels are unique (legacy fallback reverse-index has no collisions)", () => {
    const labels = Object.values(SURFACE_REGISTRY).map((m) => m.provider);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
