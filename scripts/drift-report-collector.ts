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
 *   5 — at least one failure was quarantined (unparseable/untrusted — needs review).
 *       Covers BOTH legs: an HTTP failure that could not be mapped to a
 *       provider, and an AG-UI failure the collector could not structurally
 *       interpret. An uninterpretable failure is NEVER silently dropped.
 *   6 — at least one live leg timed out having observed ZERO messages: the
 *       surface went silent, so nothing was graded there. Not drift, not a
 *       collector fault, and NOT a clean baseline.
 *   1 — AG-UI drift detection was skipped (infra), or an unhandled script error
 *
 * Usage:
 *   npx tsx scripts/drift-report-collector.ts [--out drift-report.json]
 */

import { discoverAgUiSources, resolveAgUiRepo } from "./drift-agui-canonical.js";
import { execSync, execFileSync, spawnSync } from "node:child_process";
import { existsSync, statSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { resolve, relative, isAbsolute, sep, dirname } from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { fileURLToPath } from "node:url";
import { MAX_EVIDENCE_RECORD_BYTES } from "./drift-evidence-reporter.js";
import type { EvidenceReporterRecord } from "./drift-evidence-reporter.js";

import { SURFACE_REGISTRY, isKnownSurface } from "../src/__tests__/drift/surface-registry.js";
import type { SurfaceMapping } from "../src/__tests__/drift/surface-registry.js";

import type {
  DriftEntry,
  DriftReport,
  DriftSeverity,
  ParsedDiff,
  QuarantineEntry,
  TimeoutEntry,
  UnverifiedSurface,
} from "./drift-types.js";

// ---------------------------------------------------------------------------
// Vitest JSON reporter types (subset we care about)
// ---------------------------------------------------------------------------

interface VitestJsonResult {
  testResults: VitestTestFile[];
}

interface VitestTestFile {
  name?: string;
  assertionResults: VitestAssertion[];
}

interface VitestAssertion {
  status: string;
  ancestorTitles: string[];
  title: string;
  failureMessages: string[];
}

interface AssertionEvidence {
  file: string;
  ancestors: string[];
  title: string;
  status: string;
  failureCount: number;
  source: "native" | "local" | "captured" | "unknown";
  disposition:
    | "TARGET_COMPARED"
    | "NOT_TRIGGERED"
    | "FAILED"
    | "UNATTEMPTED"
    | "SKIPPED"
    | "UNAVAILABLE";
  consoleContext: { availability: "available" | "unavailable"; recordCount: number };
  observations?: (
    | BedrockObservation
    | VertexObservation
    | CohereObservation
    | AnthropicObservation
    | GeminiObservation
    | RealtimeObservation
    | InteractionsObservation
    | OllamaObservation
    | ResponsesWSObservation
  )[];
}

interface BedrockObservation {
  provider: "bedrock";
  cell: { wire: "invoke" | "converse"; fault: "K5" | "K9"; stream: boolean };
  source: "native" | "local";
  disposition: "TARGET_COMPARED" | "NOT_TRIGGERED" | "FAILED";
  sends: number;
  requestedOutputTokens: number;
}

interface VertexObservation {
  provider: "vertex";
  cell: "k5-object" | "k5-stream" | "k9-object" | "k9-stream";
  source: "native";
  disposition: "TARGET_COMPARED" | "NOT_TRIGGERED" | "FAILED" | "UNATTEMPTED" | "SKIPPED";
}

interface CohereObservation {
  provider: "cohere";
  stream: boolean;
  source: "native";
  disposition: "TARGET_COMPARED" | "NOT_TRIGGERED";
}

interface AnthropicObservation {
  provider: "anthropic";
  cell: "object" | "stream";
  source: "native" | "captured";
  disposition: "TARGET_COMPARED" | "NOT_TRIGGERED";
}

interface GeminiObservation {
  provider: "gemini";
  fault: "stop-length-mid-tool" | "reasoning-only";
  stream: boolean;
  source: "native";
  disposition: "TARGET_COMPARED" | "NOT_TRIGGERED";
}

interface RealtimeObservation {
  provider: "realtime";
  source: "native";
  disposition: "TARGET_COMPARED" | "NOT_TRIGGERED";
}

interface InteractionsObservation {
  provider: "interactions";
  cell: "K5 stream";
  source: "native";
  disposition: "TARGET_COMPARED" | "NOT_TRIGGERED";
}

interface OllamaObservation {
  provider: "ollama";
  cell: "native object" | "native stream";
  source: "native";
  disposition: "UNAVAILABLE";
  attempts: number;
}

const responsesWSEventTypes = [
  "response.created",
  "response.in_progress",
  "response.output_item.added",
  "response.function_call_arguments.delta",
  "response.function_call_arguments.done",
  "response.reasoning_summary_part.added",
  "response.reasoning_summary_text.delta",
  "response.reasoning_summary_text.done",
  "response.reasoning_summary_part.done",
  "response.output_item.done",
  "response.incomplete",
  "response.completed",
  "response.done",
  "error",
] as const;
interface ResponsesWSObservation {
  provider: "responses-ws";
  cell: "K5" | "K9";
  source: "native";
  disposition: "UNAVAILABLE";
  eventCount: number;
  unknownEventTypeCount: number;
  omittedEventTypeCount: number;
  eventTypes: (typeof responsesWSEventTypes)[number][];
  terminalStatus?: "incomplete" | "completed" | "failed";
  incompleteReason?: "max_output_tokens" | "content_filter";
}

interface LegEvidence {
  availability: "available" | "unavailable";
  exitCode: number | null;
  assertions: AssertionEvidence[];
  consoleScopes?: {
    entity: "suite" | "module";
    file: string;
    ancestors: string[];
    title: string;
    recordCount: number;
  }[];
  unboundConsoleRecordCount?: number;
}

// Raw content exists only in memory, never as a property serialized into evidence.
const reporterChannels = new WeakMap<LegEvidence, EvidenceReporterRecord[]>();

function parseEvidenceRecord(line: string): EvidenceReporterRecord | null {
  if (Buffer.byteLength(line) > MAX_EVIDENCE_RECORD_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || !("kind" in value)) return null;
  if (value.kind === "complete" || value.kind === "unavailable") return { kind: value.kind };
  if (
    value.kind === "console" &&
    "taskId" in value &&
    typeof value.taskId === "string" &&
    "stream" in value &&
    (value.stream === "stdout" || value.stream === "stderr") &&
    "content" in value &&
    typeof value.content === "string"
  ) {
    return { kind: "console", taskId: value.taskId, stream: value.stream, content: value.content };
  }
  if (
    value.kind === "identity" &&
    "id" in value &&
    typeof value.id === "string" &&
    "entity" in value &&
    (value.entity === "test" || value.entity === "suite" || value.entity === "module") &&
    "file" in value &&
    typeof value.file === "string" &&
    "title" in value &&
    typeof value.title === "string" &&
    "ancestors" in value &&
    Array.isArray(value.ancestors) &&
    value.ancestors.every((name): name is string => typeof name === "string")
  ) {
    return {
      kind: "identity",
      id: value.id,
      entity: value.entity,
      file: value.file,
      title: value.title,
      ancestors: value.ancestors,
    };
  }
  return null;
}

function captureReporterChannel(leg: LegEvidence, stream: string) {
  const lines = stream.split("\n").filter((line) => line.length > 0);
  if (lines.length > 16_384) return;
  const records: EvidenceReporterRecord[] = [];
  for (const line of lines) {
    const record = parseEvidenceRecord(line);
    if (!record || record.kind === "unavailable") return;
    records.push(record);
  }
  if (records.filter((record) => record.kind === "complete").length !== 1) return;
  reporterChannels.set(leg, records);
}

function evidenceFileName(file: string | undefined) {
  const path =
    file === undefined ? null : relative(process.cwd(), resolve(sanitizeEvidenceIdentity(file)));
  return path === null || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)
    ? "[outside-root]"
    : boundedEvidenceIdentity(path.split(sep).join("/"));
}

function bindReporterContext(leg: LegEvidence, result: VitestJsonResult) {
  const records = reporterChannels.get(leg) ?? [];
  const identities = records.filter((record) => record.kind === "identity");
  const logs = records.filter((record) => record.kind === "console");
  const key = (file: string | undefined, ancestors: string[], title: string) =>
    JSON.stringify([file === undefined ? null : resolve(file), ancestors, title]);
  const rows = result.testResults.flatMap((file) =>
    file.assertionResults.map((assertion) => ({
      assertion,
      key: key(file.name, assertion.ancestorTitles, assertion.title),
    })),
  );
  const bound = new Map<VitestAssertion, Extract<EvidenceReporterRecord, { kind: "console" }>[]>();
  const matchedIds = new Set<string>();
  leg.consoleScopes = [];
  for (const identity of identities) {
    if (!identity.id || identities.filter((item) => item.id === identity.id).length !== 1) continue;
    const messages = logs.filter((log) => log.taskId === identity.id);
    if (identity.entity !== "test") {
      matchedIds.add(identity.id);
      if (messages.length)
        leg.consoleScopes.push({
          entity: identity.entity,
          file: evidenceFileName(identity.file),
          ancestors: identity.ancestors.slice(0, 16).map(boundedEvidenceIdentity),
          title: boundedEvidenceIdentity(identity.title),
          recordCount: messages.length,
        });
      continue;
    }
    const identityKey = key(identity.file, identity.ancestors, identity.title);
    const matches = rows.filter((row) => row.key === identityKey);
    if (
      matches.length !== 1 ||
      identities.filter(
        (item) =>
          item.entity === "test" && key(item.file, item.ancestors, item.title) === identityKey,
      ).length !== 1
    )
      continue;
    matchedIds.add(identity.id);
    bound.set(matches[0].assertion, messages);
  }
  leg.unboundConsoleRecordCount = logs.filter((log) => !matchedIds.has(log.taskId)).length;
  return bound;
}

function emptyLegEvidence(): LegEvidence {
  return { availability: "unavailable", exitCode: null, assertions: [] };
}

// Redact COMPLETE fields before clipping, so a boundary cannot retain a secret prefix.
function sanitizeEvidenceIdentity(value: string) {
  for (const [name, secret] of Object.entries(process.env)) {
    if (/(?:key|token|secret|password|credential)/i.test(name) && secret && secret.length >= 4) {
      value = value.replaceAll(secret, "[redacted]");
    }
  }
  return value
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
      "[redacted]",
    )
    .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [redacted]");
}

function boundedEvidenceIdentity(value: string) {
  return stripVTControlCharacters(sanitizeEvidenceIdentity(value))
    .split("")
    .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    .join("")
    .slice(0, 240);
}

function bedrockObservations(
  file: string,
  assertion: VitestAssertion,
  messages: Extract<EvidenceReporterRecord, { kind: "console" }>[],
): BedrockObservation[] {
  if (
    file !== "src/__tests__/drift/bedrock-misbehavior-live.drift.ts" ||
    !["passed", "failed"].includes(assertion.status)
  )
    return [];
  const observations: BedrockObservation[] = [];
  for (const message of messages) {
    if (message.stream !== "stdout") continue;
    for (const line of message.content.split("\n")) {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (!value || typeof value !== "object" || !("nativeComparison" in value)) continue;
      const cell = value.nativeComparison;
      if (
        !cell ||
        typeof cell !== "object" ||
        !("wire" in cell) ||
        (cell.wire !== "invoke" && cell.wire !== "converse") ||
        !("fault" in cell) ||
        (cell.fault !== "K5" && cell.fault !== "K9") ||
        !("stream" in cell) ||
        typeof cell.stream !== "boolean" ||
        !("source" in value) ||
        (value.source !== "native" && value.source !== "local") ||
        !("outcome" in value) ||
        !["TARGET_COMPARED", "NOT_TRIGGERED", "FAILED"].some(
          (outcome) => outcome === value.outcome,
        ) ||
        !("sends" in value) ||
        typeof value.sends !== "number" ||
        !Number.isFinite(value.sends) ||
        value.sends < 0 ||
        !("requestedOutputTokens" in value) ||
        typeof value.requestedOutputTokens !== "number" ||
        !Number.isFinite(value.requestedOutputTokens) ||
        value.requestedOutputTokens < 0
      )
        return [];
      const nativeContext =
        assertion.ancestorTitles.length === 1 &&
        assertion.ancestorTitles[0] === "native AWS misbehavior" &&
        assertion.title === `${cell.wire} ${cell.fault} stream=${cell.stream}`;
      const localContext =
        assertion.ancestorTitles.length === 0 &&
        [
          "coordinator accounts eight cells and blocks a ninth send",
          "coordinator stops after actual SDK response fails classification",
        ].includes(assertion.title);
      if (value.source === "native" ? !nativeContext : !localContext) return [];
      // Explicit enum checks also narrow untrusted JSON without a cast.
      if (
        value.outcome !== "TARGET_COMPARED" &&
        value.outcome !== "NOT_TRIGGERED" &&
        value.outcome !== "FAILED"
      )
        return [];
      observations.push({
        provider: "bedrock",
        cell: { wire: cell.wire, fault: cell.fault, stream: cell.stream },
        source: value.source,
        disposition: value.outcome,
        sends: value.sends,
        requestedOutputTokens: value.requestedOutputTokens,
      });
    }
  }
  // One native assertion owns exactly one cell; duplicate/conflicting markers
  // cannot certify it. The local coordinator legitimately reports eight cells.
  if (observations.some((item) => item.source === "native") && observations.length !== 1) return [];
  return observations;
}

function vertexObservations(
  leg: LegEvidence,
  file: string,
  assertion: VitestAssertion,
): VertexObservation[] {
  const suite = "Vertex native recurring modeled-contract observations";
  if (
    file !== "src/__tests__/drift/vertex-misbehavior.drift.ts" ||
    assertion.ancestorTitles.length !== 1 ||
    assertion.ancestorTitles[0] !== suite ||
    !["passed", "failed"].includes(assertion.status)
  )
    return [];
  const records = reporterChannels.get(leg) ?? [];
  const identities = records.filter((record) => record.kind === "identity");
  const owners = identities.filter(
    (identity) =>
      identity.entity === "suite" &&
      evidenceFileName(identity.file) === file &&
      identity.ancestors.length === 0 &&
      identity.title === suite,
  );
  if (
    owners.length !== 1 ||
    !owners[0].id ||
    identities.filter((identity) => identity.id === owners[0].id).length !== 1
  )
    return [];
  const reports: VertexObservation[][] = [];
  for (const record of records) {
    if (record.kind !== "console" || record.taskId !== owners[0].id || record.stream !== "stdout")
      continue;
    for (const line of record.content.split("\n")) {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        !value ||
        typeof value !== "object" ||
        !("provider" in value) ||
        value.provider !== "vertex"
      )
        continue;
      if (
        "proof" in value ||
        !("results" in value) ||
        !Array.isArray(value.results) ||
        value.results.length !== 4
      )
        return [];
      const observations: VertexObservation[] = [];
      for (const row of value.results) {
        if (
          !row ||
          typeof row !== "object" ||
          !("cell" in row) ||
          (row.cell !== "k5-object" &&
            row.cell !== "k5-stream" &&
            row.cell !== "k9-object" &&
            row.cell !== "k9-stream") ||
          !("classification" in row) ||
          (row.classification !== "TARGET_COMPARED" &&
            row.classification !== "NOT_TRIGGERED" &&
            row.classification !== "FAILURE" &&
            row.classification !== "UNATTEMPTED" &&
            row.classification !== "SKIPPED")
        )
          return [];
        if (observations.some((item) => item.cell === row.cell)) return [];
        observations.push({
          provider: "vertex",
          cell: row.cell,
          source: "native",
          disposition: row.classification === "FAILURE" ? "FAILED" : row.classification,
        });
      }
      reports.push(observations);
    }
  }
  if (reports.length !== 1) return [];
  return reports[0].filter(
    (row) => assertion.title === `${row.cell} records a target comparison or approved non-trigger`,
  );
}

function cohereObservations(
  file: string,
  assertion: VitestAssertion,
  messages: Extract<EvidenceReporterRecord, { kind: "console" }>[],
): CohereObservation[] {
  if (
    file !== "src/__tests__/drift/cohere.drift.ts" ||
    assertion.ancestorTitles.length !== 0 ||
    assertion.title !== "P1 Cohere native K5 object modeled and stream observed comparison" ||
    !["passed", "failed"].includes(assertion.status)
  )
    return [];
  const reports: CohereObservation[][] = [];
  for (const message of messages) {
    if (message.stream !== "stdout") continue;
    for (const line of message.content.split("\n")) {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (!value || typeof value !== "object" || !("cohereK5" in value)) continue;
      if (!Array.isArray(value.cohereK5) || value.cohereK5.length !== 2) return [];
      const observations: CohereObservation[] = [];
      for (const row of value.cohereK5) {
        if (
          !row ||
          typeof row !== "object" ||
          !("stream" in row) ||
          typeof row.stream !== "boolean" ||
          !("classification" in row) ||
          (row.classification !== "TARGET" && row.classification !== "NOT_TRIGGERED") ||
          observations.some((item) => item.stream === row.stream)
        )
          return [];
        observations.push({
          provider: "cohere",
          stream: row.stream,
          source: "native",
          disposition: row.classification === "TARGET" ? "TARGET_COMPARED" : "NOT_TRIGGERED",
        });
      }
      reports.push(observations);
    }
  }
  return reports.length === 1 ? reports[0] : [];
}

function anthropicObservations(
  file: string,
  assertion: VitestAssertion,
  messages: Extract<EvidenceReporterRecord, { kind: "console" }>[],
): AnthropicObservation[] {
  if (
    file !== "src/__tests__/drift/anthropic.drift.ts" ||
    assertion.ancestorTitles.length !== 1 ||
    assertion.ancestorTitles[0] !== "Anthropic K9 modeled exhaustion drift" ||
    !["passed", "failed"].includes(assertion.status)
  )
    return [];
  const cell =
    assertion.title === "object modeled localhost and bounded native trigger"
      ? "object"
      : assertion.title === "stream modeled localhost and bounded native trigger"
        ? "stream"
        : undefined;
  if (!cell) return [];
  let source: "native" | "captured" | undefined;
  let observation: AnthropicObservation | undefined;
  for (const message of messages) {
    if (message.stream !== "stdout") continue;
    for (const line of message.content.split("\n")) {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (!value || typeof value !== "object" || !("k9" in value)) continue;
      if (value.k9 !== cell) return [];
      if (
        "mode" in value &&
        (value.mode === "live paid provider; no retries" ||
          value.mode === "retained native capture")
      ) {
        if (source || observation) return [];
        if (
          value.mode === "live paid provider; no retries" &&
          (!("completed" in value) || value.completed !== true)
        )
          return [];
        source = value.mode === "retained native capture" ? "captured" : "native";
      }
      if ("native" in value) {
        if (
          !source ||
          observation ||
          (value.native !== "TARGET_COMPARED" && value.native !== "NOT_TRIGGERED")
        )
          return [];
        observation = { provider: "anthropic", cell, source, disposition: value.native };
      }
    }
  }
  return observation ? [observation] : [];
}

function geminiObservations(
  file: string,
  assertion: VitestAssertion,
  messages: Extract<EvidenceReporterRecord, { kind: "console" }>[],
): GeminiObservation[] {
  if (
    file !== "src/__tests__/drift/gemini.drift.ts" ||
    assertion.ancestorTitles.length !== 1 ||
    assertion.ancestorTitles[0] !== "Gemini modeled K5/K9 recurring contracts" ||
    !["passed", "failed"].includes(assertion.status)
  )
    return [];
  let acquired = false;
  let observation: GeminiObservation | undefined;
  for (const message of messages) {
    if (message.stream !== "stdout") continue;
    for (const line of message.content.split("\n")) {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (!value || typeof value !== "object") continue;
      const acquisition = "kind" in value && value.kind === "NATIVE_MODELED_COMPARISON";
      if (!acquisition && !("outcome" in value)) continue;
      if (
        !("fault" in value) ||
        (value.fault !== "stop-length-mid-tool" && value.fault !== "reasoning-only") ||
        !("stream" in value) ||
        typeof value.stream !== "boolean" ||
        assertion.title !== `live Developer API bounded ${value.fault} stream=${value.stream}`
      )
        return [];
      if (acquisition) {
        if (
          acquired ||
          observation ||
          !("provider" in value) ||
          value.provider !== "Gemini Developer API" ||
          !("status" in value) ||
          value.status !== 200
        )
          return [];
        acquired = true;
      } else {
        if (
          !acquired ||
          observation ||
          !("outcome" in value) ||
          (value.outcome !== "NATIVE_TARGET_COMPARED" && value.outcome !== "NOT_TRIGGERED")
        )
          return [];
        observation = {
          provider: "gemini",
          fault: value.fault,
          stream: value.stream,
          source: "native",
          disposition:
            value.outcome === "NATIVE_TARGET_COMPARED" ? "TARGET_COMPARED" : "NOT_TRIGGERED",
        };
      }
    }
  }
  return observation ? [observation] : [];
}

function realtimeObservations(
  file: string,
  assertion: VitestAssertion,
  messages: Extract<EvidenceReporterRecord, { kind: "console" }>[],
): RealtimeObservation[] {
  if (
    file !== "src/__tests__/drift/ws-realtime.drift.ts" ||
    assertion.ancestorTitles.length !== 1 ||
    assertion.ancestorTitles[0] !== "Realtime K5 modeled contract" ||
    assertion.title !== "native K5 bounded modeled comparison" ||
    !["passed", "failed"].includes(assertion.status)
  )
    return [];
  const observations: RealtimeObservation[] = [];
  const prefix = "Realtime K5 native ";
  for (const message of messages) {
    if (message.stream !== "stdout") continue;
    for (const line of message.content.split("\n")) {
      if (!line.startsWith(prefix)) continue;
      let value: unknown;
      try {
        value = JSON.parse(line.slice(prefix.length));
      } catch {
        return [];
      }
      if (
        !value ||
        typeof value !== "object" ||
        !("disposition" in value) ||
        (value.disposition !== "MATCH" && value.disposition !== "NOT_TRIGGERED")
      )
        return [];
      observations.push({
        provider: "realtime",
        source: "native",
        disposition: value.disposition === "MATCH" ? "TARGET_COMPARED" : "NOT_TRIGGERED",
      });
    }
  }
  return observations.length === 1 ? observations : [];
}

function interactionsObservations(
  file: string,
  assertion: VitestAssertion,
  messages: Extract<EvidenceReporterRecord, { kind: "console" }>[],
): InteractionsObservation[] {
  if (
    file !== "src/__tests__/drift/gemini-interactions.drift.ts" ||
    assertion.ancestorTitles.length !== 1 ||
    assertion.ancestorTitles[0] !== "Gemini Interactions live modeled K5 stream" ||
    assertion.title !==
      "records genuine non-triggers and rejects contradictory triggered contracts" ||
    !["passed", "failed"].includes(assertion.status)
  )
    return [];
  const observations: InteractionsObservation[] = [];
  for (const message of messages) {
    if (message.stream !== "stdout") continue;
    for (const line of message.content.split("\n")) {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (!value || typeof value !== "object" || !("disposition" in value)) continue;
      if (
        !("case" in value) ||
        value.case !== "K5 stream" ||
        "capture" in value ||
        (value.disposition !== "TRIGGERED_MODELED_CONTRACT_MATCH" &&
          value.disposition !== "NOT_TRIGGERED")
      )
        return [];
      observations.push({
        provider: "interactions",
        cell: "K5 stream",
        source: "native",
        disposition:
          value.disposition === "TRIGGERED_MODELED_CONTRACT_MATCH"
            ? "TARGET_COMPARED"
            : "NOT_TRIGGERED",
      });
    }
  }
  return observations.length === 1 ? observations : [];
}

function ollamaObservations(
  file: string,
  assertion: VitestAssertion,
  messages: Extract<EvidenceReporterRecord, { kind: "console" }>[],
): OllamaObservation[] {
  if (
    file !== "src/__tests__/drift/ollama.drift.ts" ||
    assertion.ancestorTitles.length !== 1 ||
    assertion.ancestorTitles[0] !== "P1 Ollama K9 native" ||
    (assertion.title !== "object" && assertion.title !== "stream") ||
    !["passed", "failed"].includes(assertion.status)
  )
    return [];
  const observations: OllamaObservation[] = [];
  for (const message of messages) {
    if (message.stream !== "stdout") continue;
    for (const line of message.content.split("\n")) {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (!value || typeof value !== "object" || !("cell" in value)) continue;
      if (
        (value.cell !== "native object" && value.cell !== "native stream") ||
        value.cell !== `native ${assertion.title}` ||
        !("attempts" in value) ||
        typeof value.attempts !== "number" ||
        !Number.isSafeInteger(value.attempts) ||
        value.attempts < 0
      )
        return [];
      observations.push({
        provider: "ollama",
        cell: value.cell,
        source: "native",
        disposition: "UNAVAILABLE",
        attempts: value.attempts,
      });
    }
  }
  return observations.length === 1 ? observations : [];
}

function responsesWSObservations(
  file: string,
  assertion: VitestAssertion,
  messages: Extract<EvidenceReporterRecord, { kind: "console" }>[],
): ResponsesWSObservation[] {
  if (
    file !== "src/__tests__/drift/ws-responses.drift.ts" ||
    assertion.ancestorTitles.length !== 1 ||
    assertion.ancestorTitles[0] !== "OpenAI Responses WS exhaustion live drift" ||
    !["passed", "failed"].includes(assertion.status)
  )
    return [];
  const observations: ResponsesWSObservation[] = [];
  for (const message of messages) {
    if (message.stream !== "stdout") continue;
    for (const line of message.content.split("\n")) {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        !value ||
        typeof value !== "object" ||
        !("mode" in value) ||
        value.mode !== "live WS decoded native events; not raw frames"
      )
        continue;
      if (
        !("kind" in value) ||
        (value.kind !== "K5" && value.kind !== "K9") ||
        assertion.title !== `WS ${value.kind} native comparison` ||
        !("events" in value) ||
        !Array.isArray(value.events)
      )
        return [];
      const observation: ResponsesWSObservation = {
        provider: "responses-ws",
        cell: value.kind,
        source: "native",
        disposition: "UNAVAILABLE",
        // Exact counts are bounded by the existing 256KiB reporter record limit.
        eventCount: value.events.length,
        unknownEventTypeCount: 0,
        omittedEventTypeCount: 0,
        eventTypes: [],
      };
      for (const event of value.events) {
        const type =
          event && typeof event === "object" && "type" in event
            ? responsesWSEventTypes.find((known) => known === event.type)
            : undefined;
        if (!type) observation.unknownEventTypeCount++;
        else if (observation.eventTypes.length < 128) observation.eventTypes.push(type);
        else observation.omittedEventTypeCount++;
      }
      const terminal = value.events.at(-1);
      if (
        terminal &&
        typeof terminal === "object" &&
        "type" in terminal &&
        ["response.incomplete", "response.completed", "response.done"].includes(terminal.type) &&
        "response" in terminal &&
        terminal.response &&
        typeof terminal.response === "object"
      ) {
        const response = terminal.response;
        if (
          response.status === "incomplete" ||
          response.status === "completed" ||
          response.status === "failed"
        )
          observation.terminalStatus = response.status;
        const details = response.incomplete_details;
        if (
          details &&
          typeof details === "object" &&
          (details.reason === "max_output_tokens" || details.reason === "content_filter")
        )
          observation.incompleteReason = details.reason;
      }
      observations.push(observation);
    }
  }
  return observations.length === 1 ? observations : [];
}

function captureAssertionEvidence(leg: LegEvidence | undefined, result: VitestJsonResult) {
  if (!leg) return;
  const contexts = bindReporterContext(leg, result);
  leg.assertions = result.testResults.flatMap((file) => {
    const name = evidenceFileName(file.name);
    return file.assertionResults.map((assertion): AssertionEvidence => {
      const observations: (
        | BedrockObservation
        | VertexObservation
        | CohereObservation
        | AnthropicObservation
        | GeminiObservation
        | RealtimeObservation
        | InteractionsObservation
        | OllamaObservation
        | ResponsesWSObservation
      )[] = [
        ...bedrockObservations(name, assertion, contexts.get(assertion) ?? []),
        ...cohereObservations(name, assertion, contexts.get(assertion) ?? []),
        ...anthropicObservations(name, assertion, contexts.get(assertion) ?? []),
        ...geminiObservations(name, assertion, contexts.get(assertion) ?? []),
        ...realtimeObservations(name, assertion, contexts.get(assertion) ?? []),
        ...interactionsObservations(name, assertion, contexts.get(assertion) ?? []),
        ...ollamaObservations(name, assertion, contexts.get(assertion) ?? []),
        ...responsesWSObservations(name, assertion, contexts.get(assertion) ?? []),
        ...(contexts.has(assertion) ? vertexObservations(leg, name, assertion) : []),
      ];
      const first = observations[0];
      const agreement =
        first &&
        observations.every(
          (item) => item.source === first.source && item.disposition === first.disposition,
        );
      return {
        file: name,
        ancestors: assertion.ancestorTitles.slice(0, 16).map(boundedEvidenceIdentity),
        title: boundedEvidenceIdentity(assertion.title),
        status: boundedEvidenceIdentity(assertion.status),
        failureCount: assertion.failureMessages.length,
        consoleContext: {
          availability: contexts.has(assertion) ? "available" : "unavailable",
          recordCount: contexts.get(assertion)?.length ?? 0,
        },
        ...(observations.length ? { observations } : {}),
        source:
          first && observations.every((item) => item.source === first.source)
            ? first.source
            : "unknown",
        disposition:
          assertion.status === "failed"
            ? "FAILED"
            : ["pending", "skipped", "todo", "disabled"].includes(assertion.status)
              ? "SKIPPED"
              : agreement
                ? first.disposition
                : "UNAVAILABLE",
      };
    });
  });
  leg.availability = "available";
}

// npx closes extra descriptors. Launch the candidate's installed CLI directly,
// preserving test arguments and buffer limits while keeping fd3 private/in memory.
function executeEvidenceVitest(command: string, leg: LegEvidence) {
  const reporter = fileURLToPath(new URL("./drift-evidence-reporter.ts", import.meta.url));
  const packagePath = createRequire(resolve(process.cwd(), "package.json")).resolve(
    "vitest/package.json",
  );
  const manifest: unknown = JSON.parse(readFileSync(packagePath, "utf8"));
  if (!manifest || typeof manifest !== "object" || !("bin" in manifest)) {
    throw new Error("Installed Vitest package has no CLI entry");
  }
  const bin =
    typeof manifest.bin === "string"
      ? manifest.bin
      : manifest.bin &&
          typeof manifest.bin === "object" &&
          "vitest" in manifest.bin &&
          typeof manifest.bin.vitest === "string"
        ? manifest.bin.vitest
        : null;
  if (!bin || !command.startsWith("npx vitest "))
    throw new Error("Installed Vitest CLI is unavailable");
  const cli = resolve(dirname(packagePath), bin);
  if (!existsSync(cli) || !statSync(cli).isFile())
    throw new Error("Installed Vitest CLI is unavailable");
  const child = spawnSync(
    process.execPath,
    [cli, ...command.slice("npx vitest ".length).split(" "), "--reporter", reporter],
    {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      maxBuffer: 50 * 1024 * 1024,
    },
  );
  leg.exitCode = child.status;
  captureReporterChannel(leg, child.output[3] ?? "");
  if (child.error || child.status !== 0) {
    throw Object.assign(child.error ?? new Error(`Command failed: ${command}\n${child.stderr}`), {
      stdout: child.stdout ?? "",
      stderr: child.stderr ?? "",
      status: child.status,
    });
  }
  return child.stdout;
}

function withInvocationEvidence(run: (legs: { drift: LegEvidence; agui: LegEvidence }) => number) {
  const invocationId = randomUUID();
  const timestamp = new Date().toISOString();
  const legs = { drift: emptyLegEvidence(), agui: emptyLegEvidence() };
  const numericId = (value: string | undefined) =>
    value && /^\d{1,20}$/.test(value) ? value : undefined;
  const persist = () => {
    try {
      mkdirSync("drift-evidence", { recursive: true });
      writeFileSync(
        resolve("drift-evidence", `${timestamp.replaceAll(":", "-")}-${invocationId}.json`),
        JSON.stringify(
          {
            schemaVersion: 1,
            invocationId,
            timestamp,
            githubRunId: numericId(process.env.GITHUB_RUN_ID),
            githubRunAttempt: numericId(process.env.GITHUB_RUN_ATTEMPT),
            ...legs,
          },
          null,
          2,
        ) + "\n",
        { flag: "wx", mode: 0o600 },
      );
    } catch {
      // Never include filesystem paths or raw streams in this new diagnostic.
      throw new Error("Failed to write collector invocation evidence");
    }
  };
  try {
    return run(legs);
  } finally {
    persist();
  }
}

// ---------------------------------------------------------------------------
// Surface → file mapping (single source of truth in surface-registry.ts)
// ---------------------------------------------------------------------------

/**
 * A resolved surface mapping. Structurally identical to the registry's
 * `SurfaceMapping` (kept as a local alias so the rest of this module reads
 * unchanged from the pre-registry `ProviderMapping`).
 */
type ProviderMapping = SurfaceMapping;

const SDK_SHAPES_FILE = "src/__tests__/drift/sdk-shapes.ts";

/**
 * Legacy label aliases → registry slug. The pre-WS-5 `PROVIDER_MAP` keyed some
 * surfaces by SHORTER titles than the registry's canonical `provider` label
 * (e.g. a bare `"Gemini"`/`"Anthropic"` describe-block title, or `"Bedrock
 * Invoke"` prose without a colon suffix). These map onto the canonical slug so
 * the LEGACY no-marker fallback keeps recognizing an unmigrated block whose
 * prose title uses the shorter form. Newer blocks resolve structurally via the
 * `Surface:` marker and never touch this table.
 */
const LEGACY_LABEL_ALIASES: Record<string, keyof typeof SURFACE_REGISTRY> = {
  Gemini: "gemini",
  Anthropic: "anthropic",
};

/**
 * Reverse index from a human provider label to its mapping, for the LEGACY
 * no-marker fallback (`extractProviderName`). Built from the registry's
 * canonical `provider` labels PLUS the legacy aliases above. Newer emitters
 * declare a `Surface:` slug marker (resolved structurally); this table only
 * serves blocks that predate the marker or a path not yet migrated.
 */
const PROVIDER_LABEL_MAP: Record<string, ProviderMapping> = {
  ...Object.fromEntries(Object.values(SURFACE_REGISTRY).map((m) => [m.provider, m])),
  ...Object.fromEntries(
    Object.entries(LEGACY_LABEL_ALIASES).map(([label, slug]) => [label, SURFACE_REGISTRY[slug]]),
  ),
};

// ---------------------------------------------------------------------------
// AG-UI schema drift constants
// ---------------------------------------------------------------------------

const AGUI_TYPES_FILE = "src/agui-types.ts";

/**
 * Vitest FILENAME FILTER (substring match on the test file path) selecting the
 * whole AG-UI drift surface, not one hardcoded file. Keep this in lockstep with
 * the `agui-schema-drift` job in `.github/workflows/test-drift.yml`, which runs
 * the same filter.
 *
 * NAMING CONTRACT: an AG-UI drift guard MUST be named
 * `src/__tests__/drift/agui-<something>.drift.ts` so both consumers pick it up
 * automatically; a differently-named file would silently never run.
 * `vitest.config.drift.ts` scopes `include` to the drift-suffixed files, so the
 * filter cannot pull in plain `.test.ts` helpers from the same directory. No
 * provider API keys are required — these files compare `src/agui-types.ts` against the
 * cloned canonical ag-ui repo only.
 */
const AGUI_DRIFT_TEST_FILTER = "src/__tests__/drift/agui-";

/**
 * Report metadata only: the file a human should open when AG-UI drift is
 * reported. Not a run target — see `AGUI_DRIFT_TEST_FILTER` for that.
 */
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
  //
  // EVERY separator here is `[ \t]*` and every value is `(.*)`, NOT `\s*` and
  // `(.+)`. `\s` matches newlines, and `compareShapes` sets `mock: ""` on every
  // diff it produces, so `Mock:\s*(.+)` on an empty value used to run past the end
  // of its own line: greedy `\s*` swallowed the trailing spaces, the newline and
  // the blank separator line, and `(.+)` then matched the NEXT ENTRY'S header.
  // That consumed the successor whole — `lastIndex` advanced past its `N. [sev]`
  // line, so nothing could match it — and if that successor was the critical diff,
  // `criticalCount` fell to 0 and the run reported `conclusion: "clean"`.
  //
  // The trigger is a single empty-`mock` entry that HAS a successor; it is not
  // limited to consecutive empty values, and it does not need the block to be
  // malformed. `fal-queue.drift.ts` and `video.drift.ts` both emit
  // compareShapes-derived blocks, where the value is empty on 100% of diffs.
  //
  // A newline can no longer be crossed inside an entry, and an empty value is
  // captured as empty instead of forcing the match to look for content elsewhere.
  // `^` (with `m`) additionally requires the entry number to START a line, so a
  // numbered list inside prose cannot be read as an entry.
  const entryPattern =
    /^[ \t]*\d+\.[ \t]*\[(\w+)\][ \t]*(.*)\n[ \t]*Path:[ \t]*(.*)\n[ \t]*SDK:[ \t]*(.*)\n[ \t]*Real:[ \t]*(.*)\n[ \t]*Mock:[ \t]*(.*)/gm;

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
    const path = match[3].trim();
    diffs.push({
      severity: severity as DriftSeverity,
      issue: match[2].trim(),
      path,
      expected: match[4].trim(),
      real: match[5].trim(),
      mock: match[6].trim(),
      // Stable per-item key derived from the offending path so different paths
      // yield different delta keys (provider+id) in the D6.1 delta layer.
      id: path,
    });
  }

  const expectedCount = (text.match(/\d+\.\s*\[/g) ?? []).length;
  if (expectedCount > 0 && diffs.length < expectedCount) {
    console.warn(`parseDriftBlock: parsed ${diffs.length} of ${expectedCount} entries`);
  }

  return { context, diffs };
}

/**
 * Extract the machine-readable surface slug from a drift block's `Surface:`
 * marker line (emitted by `formatDriftReport(context, diffs, surface)`), if
 * present. Returns null when no marker line exists (a legacy/unmigrated block).
 *
 * The marker sits between the `API DRIFT DETECTED:` header and the numbered
 * entries, e.g.:
 *
 *   API DRIFT DETECTED: Cohere /v2/chat (non-streaming)
 *     Surface: cohere-chat
 *     1. [critical] …
 */
export function extractSurfaceKey(text: string): string | null {
  const match = text.match(/^\s*Surface:\s*(\S+)\s*$/m);
  return match ? match[1] : null;
}

/**
 * LEGACY provider-name fallback for a drift block that carries NO `Surface:`
 * marker (predates the slug marker, or a path not yet migrated). Newer blocks
 * resolve structurally via `extractSurfaceKey`; this exists only as a defensive
 * back-compat net.
 *
 * ANCHORED AT THE START, longest label first. It used to accept a label found
 * ANYWHERE in the text and rank candidates by length alone, so a qualifier later
 * in the title could outrank the surface the title is about: "Gemini Live
 * Transcription session" resolved to `Transcription` (13 chars) over `Gemini
 * Live` (11) and routed a Gemini Live drift at `src/transcription.ts`. That
 * failed OPEN — a confident wrong owner, no error, and the entry then drives
 * remediation. Both inputs this is called with lead with the provider label:
 * `parsed.context` is `formatDriftReport`'s "<Provider> (<scenario>)", and a drift
 * describe title reads "<Provider> <rest>". So an unanchored occurrence is not
 * evidence of ownership, and a text that does not START with a known label is
 * unattributable → null → the caller quarantines it for human review (exit 5)
 * rather than inventing an owner.
 *
 * Longest-first still resolves genuinely nested labels at the same anchor
 * ("Google Gemini" over "Gemini", "Bedrock ConverseStream" over "Bedrock
 * Converse", "OpenAI Responses WS" over "OpenAI Responses").
 *
 * Examples:
 *   "OpenAI Chat Completions drift"      → "OpenAI Chat"
 *   "Anthropic Claude drift"             → "Anthropic Claude"
 *   "Gemini Live Transcription session"  → "Gemini Live"  (not "Transcription")
 *   "drift detected in OpenAI Chat"      → null           (not anchored)
 */
export function extractProviderName(text: string): string | null {
  const sorted = Object.keys(PROVIDER_LABEL_MAP).sort((a, b) => b.length - a.length);
  for (const key of sorted) {
    if (text.startsWith(key)) return key;
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
// WS handshake-failure recognizer
// ---------------------------------------------------------------------------

/**
 * Which WS drift probe a failure came from, and therefore which surface owns it.
 *
 * The recognizer below used to test for a `ws-realtime.drift.ts` frame and then
 * hardcode the `openai-realtime` surface, which made it useful for exactly one of
 * the three WS surfaces this repo probes. A `gemini-live` handshake that the
 * provider REJECTED with an error body — the surface most likely to hit this,
 * since it is the one that actually goes quiet in production — resolved to no
 * surface and fell through to the exit-5 quarantine, i.e. straight back into the
 * hard human-triage stop this whole lane exists to avoid.
 *
 * Attribution is by the probe's own stack frame OR by the failing test's name,
 * and BOTH keys read the same CLOSED table on purpose. A failure that matches
 * neither key yields null and stays quarantined — an unknown WS surface must not
 * be guessed at, because a confident wrong owner routes remediation at the wrong
 * file and fails OPEN.
 */
const WS_HANDSHAKE_PROBES: readonly {
  /** The drift probe's filename as it appears in a stack frame. */
  file: string;
  /** The registered surface whose failures that probe reports. */
  surface: keyof typeof SURFACE_REGISTRY;
}[] = [
  { file: "ws-realtime.drift.ts", surface: "openai-realtime" },
  { file: "ws-live.drift.ts", surface: "openai-live" },
  { file: "ws-gemini-live.drift.ts", surface: "gemini-live" },
  { file: "ws-responses.drift.ts", surface: "openai-responses-ws" },
];

/** The registered surface a WS failure's stack frames attribute it to, or null. */
function resolveWSProbeSurface(text: string): keyof typeof SURFACE_REGISTRY | null {
  return WS_HANDSHAKE_PROBES.find((p) => text.includes(p.file))?.surface ?? null;
}

/**
 * The SAME closed set of WS probes, indexed by the registry provider LABEL that
 * opens their describe-block titles ("Gemini Live WS drift", "OpenAI Realtime API
 * drift", "OpenAI Responses WS drift").
 *
 * NO longest-label-first ordering: match order cannot matter, because no
 * registered WS label is a prefix of another, so at most one can anchor a title.
 * That property is asserted by a test (drift-collector.test.ts, "no registered WS
 * probe label is a prefix of another") rather than papered over here — an
 * ordering rule that no input can distinguish is coverage that does not exist,
 * whereas registering a prefix-colliding probe (say `openai-responses`, "OpenAI
 * Responses", alongside "OpenAI Responses WS") turns that test RED and makes the
 * ambiguity the author's decision instead of a silent pick.
 */
export const WS_PROBE_LABELS: readonly {
  label: string;
  surface: keyof typeof SURFACE_REGISTRY;
}[] = WS_HANDSHAKE_PROBES.map((p) => ({
  label: SURFACE_REGISTRY[p.surface].provider,
  surface: p.surface,
}));

/**
 * The registered surface the failing TEST'S NAME attributes a WS failure to.
 *
 * This key exists because the stack frame key cannot answer for the failures that
 * actually happen. The client that raises a WS failure is SHARED
 * (`ws-providers.ts`), and it raises from a socket callback — an async boundary
 * the probe's own frame does not survive. Verbatim from the run this fixed
 * (CopilotKit/aimock 31571018005): every frame is the shared client or a node
 * internal, and `ws-gemini-live.drift.ts` appears NOWHERE in the stack:
 *
 *     at rejectClosed (…/src/__tests__/drift/ws-providers.ts:377:21)
 *     at check (…/src/__tests__/drift/ws-providers.ts:467:21)
 *     at TLSSocket.<anonymous> (…/src/__tests__/drift/ws-providers.ts:525:47)
 *     at TLSSocket.emit (node:events:509:28)
 *     …
 *
 * So the probe frame is not merely DEEPER in the stack — it is absent, and no
 * frame-scanning pattern can recover it. The vitest reporter still knows which
 * suite failed, and the ancestor title leads with the surface's registry provider
 * label, so the test name carries the answer the stack lost.
 *
 * ANCHORED AT THE START, for the same reason `extractProviderName` is: a label
 * mentioned later in a title is a qualifier, not the owner, and attributing on an
 * unanchored occurrence is how a confidently-wrong owner gets invented. A title
 * that does not START with a registered WS label is unattributable → null → the
 * caller quarantines it.
 */
function resolveWSProbeSurfaceByName(testName: string): keyof typeof SURFACE_REGISTRY | null {
  return WS_PROBE_LABELS.find((p) => testName.startsWith(p.label))?.surface ?? null;
}

/**
 * The registered surface a WS failure is attributed to, from both keys that can
 * carry the answer: the stack frame FIRST (a probe frame is unambiguous
 * provenance when it survives), then the failing test's name. Both consult the
 * same closed WS_HANDSHAKE_PROBES table, so an unregistered surface is still
 * refused by both.
 */
function resolveWSSurface(text: string, testName: string): keyof typeof SURFACE_REGISTRY | null {
  return resolveWSProbeSurface(text) ?? resolveWSProbeSurfaceByName(testName);
}

/**
 * A parsed WS handshake failure. The socket UPGRADED (101) and the live API sent
 * back an `error` event, but the expected session-lifecycle event never arrived,
 * so the probe's `waitUntil(...)` timed out. That shape is a genuine, actionable
 * protocol drift (e.g. a session-config field the probe/mock stopped sending) —
 * NOT a benign network flake, and NOT the zero-observation timeout lane (a silent
 * surface collects ZERO messages and carries no `error` body; see
 * `parseLiveTimeout`, which this recognizer deliberately runs ahead of).
 *
 * Recognizing it here diverts it from the opaque exit-5 quarantine into a
 * parseable, attributed critical DriftEntry (exit 2), so the failing handshake
 * and its error payload are visible and route to a builder for remediation.
 * Gated on a KNOWN probe origin plus a surfaced `error` event body, so it can
 * neither reclassify an unrelated failure nor claim a bare network timeout.
 */
export interface WSHandshakeFailure {
  /** The registered surface slug the failure is attributed to. */
  surface: keyof typeof SURFACE_REGISTRY;
  errorType: string;
  errorCode: string;
  errorMessage: string;
}

export function parseWSHandshakeFailure(
  text: string,
  /**
   * The failing test's `<ancestors> > <title>` name. REQUIRED, not defaulted: the
   * stack frame alone cannot attribute a failure raised from the shared client's
   * socket callback, and a caller that silently omitted the name would reproduce
   * exactly the unattributable quarantine this parameter exists to prevent.
   */
  testName: string,
): WSHandshakeFailure | null {
  // Gate 1: the probe timed out waiting for a lifecycle event (handshake never
  // completed). Gate 2: the failure came from a KNOWN WS drift probe, which also
  // resolves WHICH surface owns it (by its stack frame, else by the failing
  // test's name; the surfaced `error` body comes from the ws-providers helper).
  // Gate 3: an `error` event body was surfaced — this is the "connect succeeded
  // but handshake didn't complete WITH a protocol error" case. A pure network
  // flake or a silent surface carries no error body, fails Gate 3, and is left to
  // the timeout/quarantine lanes.
  if (!/waitUntil timeout/.test(text)) return null;
  const surface = resolveWSSurface(text, testName);
  if (surface === null) return null;
  if (!/"type"\s*:\s*"error"/.test(text)) return null;

  const errorType = text.match(/"error"\s*:\s*\{[^}]*?"type"\s*:\s*"([^"]+)"/)?.[1] ?? "unknown";
  const errorCode = text.match(/"code"\s*:\s*"([^"]+)"/)?.[1] ?? "unknown";
  const errorMessage = text.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1] ?? "unknown";
  return { surface, errorType, errorCode, errorMessage };
}

// ---------------------------------------------------------------------------
// Server-initiated CLOSE recognizer (provider refusal vs provider hang-up)
// ---------------------------------------------------------------------------

/**
 * A server-initiated WebSocket CLOSE observed while a probe was waiting.
 *
 * This is a THIRD failure channel, distinct from both lanes around it. The socket
 * upgrades, and the provider then ends the session out-of-band with an RFC 6455
 * CLOSE frame instead of an in-band `error` event. Until the drift probe was
 * taught to preserve the frame, the code and reason were dropped and this arrived
 * as an ordinary zero-message timeout — byte-identical to a provider that simply
 * said nothing. Now the frame states its own cause, and a stated cause is the most
 * actionable signal this system can produce, so it must not be flattened back into
 * either neighbouring lane.
 */
export interface WSServerClose {
  /** RFC 6455 status code (1005 when the frame carried no code). */
  code: number;
  /** The frame's reason text, decoded. Empty when the frame carried none. */
  reason: string;
}

/**
 * The RFC 6455 §7.4.1 close codes that mean "what this end sent was
 * unacceptable" — the peer is describing OUR payload, protocol or policy. These
 * are genuine, attributable drift.
 *
 * Enumerated rather than expressed as a range, because the numeric span is not
 * semantically contiguous: 1004 is reserved, and 1005/1006 are codes that are
 * NEVER sent on the wire (they are local placeholders for "no status received"
 * and "closed abnormally"). A `1002..1010` range silently swept those three in
 * and would have reported "the provider refused us" for a connection that
 * dropped without any code at all.
 */
const WS_REFUSAL_CLOSE_CODES: ReadonlySet<number> = new Set([
  1002, // protocol error
  1003, // unsupported data
  1007, // invalid frame payload data
  1008, // policy violation
  1009, // message too big
  1010, // mandatory extension missing
]);

/**
 * Does this close code mean the provider REFUSED what this end sent?
 *
 * True for the §7.4.1 rejection codes above and for the 4000-4999
 * application-defined range, which is where a provider puts its own refusal
 * semantics.
 *
 * False for everything else — the connection ending for the peer's or the
 * transport's own reasons: 1000 normal, 1001 going away, 1004 reserved, 1005 no
 * code, 1006 abnormal, 1011 internal error, 1012/1013 restarting / try again
 * later, 1014/1015 gateway and TLS failures. Calling any of those "drift" would
 * page the team about a provider's own hiccup and hand it to the auto-fixer,
 * which is the false-drift alarm `drift-retry.ts` exists to suppress. They are
 * real and worth seeing, but they are not findings about us.
 */
export function isRefusalCloseCode(code: number): boolean {
  return WS_REFUSAL_CLOSE_CODES.has(code) || (code >= 4000 && code <= 4999);
}

/**
 * Recognize the drift probe's server-close failure message and recover the
 * frame's code and reason.
 *
 * The reason is emitted `JSON.stringify`-quoted, so it is decoded with `JSON.parse`
 * rather than by hand — a reason containing a quote, a backslash or a newline is
 * exactly the input a hand-rolled unquoter gets wrong, and provider reason text is
 * not under our control.
 */
export function parseWSServerClose(text: string): WSServerClose | null {
  const match = text.match(
    /WebSocket closed by server during waitUntil:\s*code=(\d+)\s*reason=("(?:[^"\\]|\\.)*")/,
  );
  if (!match) return null;
  let reason: string;
  try {
    // The pattern captures a COMPLETE JSON string literal — the surrounding
    // quotes are part of the match — so a successful parse always yields a
    // string. `String()` is an identity here; it types the result without a cast
    // and without an unreachable `typeof` branch. (A branch for "parsed to a
    // non-string" was here and could not be made to fail under mutation, which
    // is the definition of coverage that does not exist, so it is gone.)
    reason = String(JSON.parse(match[2]));
  } catch {
    // A reason we cannot decode is not a reason. Returning null leaves the
    // failure to the quarantine lane rather than reporting a mangled cause —
    // an undecodable payload must never become a confident diagnosis.
    return null;
  }
  return { code: Number(match[1]), reason };
}

// ---------------------------------------------------------------------------
// Zero-observation live-timeout recognizer
// ---------------------------------------------------------------------------

/**
 * A live leg that hit its wait budget having observed NOTHING.
 *
 * This is the single most common way a live drift leg fails, and it has its own
 * meaning, distinct from both lanes around it:
 *
 *   - It is NOT a drift finding. Zero messages were observed, so there is no
 *     shape to compare and nothing to attribute to a builder file. (A timeout
 *     that DID observe messages including a provider `error` body is protocol
 *     drift, and `parseWSHandshakeFailure` — which runs first — claims it.)
 *   - It is NOT unparseable output. The message states exactly what happened:
 *     the wait budget, and that zero messages arrived. Routing it to the
 *     quarantine lane reported an unreachable live surface as "unparseable —
 *     manual triage required" (exit 5), which is both wrong and, because exit 5
 *     hard-fails the base leg, a human-gated stop on every drift PR for as long
 *     as the surface stays silent.
 *
 * So it gets its own lane: recorded as a `TimeoutEntry`, reported as exit 6 /
 * conclusion "live-timeout".
 *
 * DELIBERATELY NARROW. The recognizer requires the probe's own structured
 * "Collected <n> messages" tail with n === 0, and refuses any message carrying a
 * drift marker. Anything else — a timeout with messages but no error body, a
 * bare `AssertionError` with no timeout tail, truncated garbage — is unchanged
 * and still quarantines. The failure mode to avoid here is the opposite of the
 * one being fixed: a recognizer loose enough to swallow real output would trade
 * a loud stop for a silent pass.
 */
export interface LiveTimeout {
  /** The wait budget that expired, in milliseconds. */
  timeoutMs: number;
}

/** A drift marker anywhere in the text disqualifies the timeout lane. */
const DRIFT_MARKERS = [/API DRIFT DETECTED/i, /LLMOCK DRIFT/i];

export function parseLiveTimeout(text: string): LiveTimeout | null {
  // Gate 1: the probe's own timeout tail, WITH its collected-message count. The
  // count is what makes this classifiable rather than a guess — `Collected 0`
  // is the probe stating, structurally, that it observed nothing.
  const match = text.match(/waitUntil timeout after (\d+)ms\.\s*Collected (\d+) messages\s*:/);
  if (!match) return null;
  // Gate 2: ZERO observations. A timeout that collected messages saw SOMETHING;
  // that output is evidence and must not be discarded as "surface was silent".
  if (Number(match[2]) !== 0) return null;
  // Gate 3: no drift marker. A message that carries a drift report is drift,
  // whatever else it also says.
  if (DRIFT_MARKERS.some((re) => re.test(text))) return null;
  return { timeoutMs: Number(match[1]) };
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

function runDriftTests(evidence?: LegEvidence): VitestJsonResult {
  try {
    const command = "npx vitest run --config vitest.config.drift.ts --reporter=json";
    const stdout = evidence
      ? executeEvidenceVitest(command, evidence)
      : execSync(command, {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          maxBuffer: 50 * 1024 * 1024,
        });
    const result = parseVitestOutput(stdout, "JSON parse of successful vitest run failed");
    if (result) {
      captureAssertionEvidence(evidence, result);
      return result;
    }
    throw new Error("Drift tests passed but produced unparseable output");
  } catch (err: unknown) {
    // execSync throws on non-zero exit — vitest exits 1 when tests fail
    if (hasStdout(err)) {
      const result = parseVitestOutput(err.stdout, "Primary JSON parse of vitest stdout failed");
      if (result) {
        captureAssertionEvidence(evidence, result);
        return result;
      }
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

/**
 * O-1: capture the raw `file:line` (or `file:line:col`) from the FIRST usable
 * stack frame BEFORE `stripStackFrames` removes it, so a quarantined failure
 * carries a pointer the human reviewer can jump to. Prefers a project-source
 * frame (`src/…`) over node_modules/internal frames; falls back to the first
 * frame with any `path:line` shape. Returns "" when no frame is present.
 */
export function extractRawLocation(msg: string): string {
  const frames = msg.split("\n").filter((line) => /^\s*at\s/.test(line));
  // Match `path:line` or `path:line:col`, with an optional trailing `)`.
  const locRe = /((?:\/|\.\/|[A-Za-z]:\\|file:\/\/)?[^\s()]+?:\d+(?::\d+)?)\)?\s*$/;
  const pick = (predicate: (f: string) => boolean): string | null => {
    for (const frame of frames) {
      if (!predicate(frame)) continue;
      const m = frame.match(locRe);
      if (m) return m[1];
    }
    return null;
  };
  // Prefer a project-source frame, skipping node internals / node_modules.
  return (
    pick((f) => /src\//.test(f) && !/node_modules/.test(f) && !/node:internal/.test(f)) ??
    pick((f) => !/node_modules/.test(f) && !/node:internal/.test(f)) ??
    pick(() => true) ??
    ""
  );
}

/**
 * F1 — PER-LEG (single-message) infra classification. This is the primitive
 * that keeps ONE leg's failure from batch-poisoning its siblings: each
 * unparseable failure is judged ALONE, so an unparseable leg can never flip a
 * genuine infra leg into the quarantine lane (nor a benign infra leg mask a
 * genuinely-unparseable sibling).
 *
 * A message is benign infra iff it carries POSITIVE infra evidence AND shows no
 * drift-like signal, both judged on the SAME stack-stripped text (A3 — the two
 * scans must never disagree because they saw different inputs). A bare
 * AssertionError with no infra token is NOT infra (returns false → the caller
 * quarantines it for review), preserving the CLASS 1 "unrecognized ⇒ never a
 * false all-clear" invariant at the per-leg grain.
 */
export function classifySingleUnparseableAsInfra(message: string): boolean {
  // Normalize ONCE; both scans consume the identical normalized text (A3).
  const normalized = stripStackFrames(message);
  const hasInfraEvidence = INFRA_INDICATORS.some((re) => re.test(normalized));
  const isDriftLike = DRIFT_LIKE_INDICATORS.some((re) => re.test(normalized));
  return hasInfraEvidence && !isDriftLike;
}

export function classifyUnparseableAsInfra(unparseableMessages: string[]): boolean {
  // CLASS 1 — fail-loud on absent evidence. No messages means NO positive infra
  // evidence, so this is NOT a benign "all clear". `[].every(...)` is vacuously
  // true, which would have wrongly classified an empty batch as infra and made
  // the collector exit 0. Root invariant: unrecognized ⇒ fail loud, never a
  // false all-clear.
  if (unparseableMessages.length === 0) return false;

  // Batch semantics are exactly the conjunction of the per-leg predicate: the
  // whole set is benign infra iff EVERY message is individually benign infra
  // (every message has an infra indicator AND none is drift-like). Kept for the
  // back-compat batch callers/tests; the collector's swallow-vs-quarantine
  // decision below is now made PER LEG via classifySingleUnparseableAsInfra so a
  // mixed batch no longer drags benign infra legs into quarantine.
  return unparseableMessages.every(classifySingleUnparseableAsInfra);
}

/**
 * The result of collecting drift entries. In addition to the trustworthy drift
 * `entries`, `quarantine` holds failures that could not be parsed/mapped into a
 * trustworthy finding AND were not positively classified as benign infra (A1.3).
 * These no longer crash the collector (exit 1) nor get silently dropped (exit
 * 0): the caller routes a non-empty `quarantine` to exit 5. Exit 1 is now
 * reserved for genuine collector bugs (unhandled exceptions).
 */
export interface CollectResult {
  entries: DriftEntry[];
  quarantine: QuarantineEntry[];
  /**
   * Live legs that timed out having observed nothing (see `parseLiveTimeout`).
   * A recognized outcome in its own right — neither a drift finding nor
   * unparseable output.
   */
  timeouts: TimeoutEntry[];
}

/**
 * Stable delta keys for the two realtime-canary diffs that have no per-model id.
 *
 * drift-delta keys a failure by `provider + (diff.id ?? diff.path)`. Both diffs
 * below used to carry no `id`, so their delta key WAS their `path` — which is
 * also the human-facing "Path:" line of the alert. That coupling means renaming
 * the alert prose silently MOVES the key: drift already recorded in the cached
 * same-UTC-day BASE report is re-classified as new-in-head (BLOCK) and the base
 * key is reported as spuriously "fixed". It bit us once already, when these two
 * `path` values were corrected to name the symbols that actually exist
 * (`gaRealtimeModels` / `knownVoiceModelFamilies`) instead of the retired ones.
 *
 * Freezing the display string is the wrong fix — a `Path:` naming a nonexistent
 * symbol is exactly what drift-remediation-strings.test.ts exists to prevent. So
 * the key is instead an explicit SEMANTIC id that never appears in prose: the
 * display text is now free to change without moving any key.
 *
 * These values are the wire contract of the delta layer. Renaming one shifts the
 * key exactly as the old path rename did — don't, unless that is the intent.
 */
export const NO_GA_DELTA_ID = "openai-realtime:no-ga-family";
export const TRUNCATED_DELTA_ID = "openai-realtime:unknown-models-truncated";

export function collectDriftEntries(results: VitestJsonResult): CollectResult {
  const entries: DriftEntry[] = [];
  const quarantine: QuarantineEntry[] = [];
  const timeouts: TimeoutEntry[] = [];
  let unparseable = 0;

  for (const file of results.testResults) {
    for (const assertion of file.assertionResults) {
      if (assertion.status !== "failed") continue;
      if (assertion.failureMessages.length === 0) continue;

      const fullMessage = assertion.failureMessages.join("\n");
      // Hoisted above every lane: the WS lanes attribute by the failing test's
      // name when the shared client's stack has no probe frame to key off.
      const ancestorText = assertion.ancestorTitles.join(" ");
      const testName = `${ancestorText} > ${assertion.title}`;
      const parsed = parseDriftBlock(fullMessage);
      if (!parsed || parsed.diffs.length === 0) {
        // Check for the ws-realtime canary assertion shapes BEFORE classifying
        // as unparseable — both the unknown-models mode and the hasGA-false mode
        // (CLASS 2) are genuine, critical drift and must be surfaced (exit 2),
        // never crashed as unparseable (exit 1).
        const canary = parseKnownModelsCanary(fullMessage);
        if (canary !== null) {
          const mapping = SURFACE_REGISTRY["openai-realtime"];

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
                    "Update gaRealtimeModels in src/__tests__/drift/voice-models.ts.",
                  path: "gaRealtimeModels",
                  expected: "(at least one GA realtime model present)",
                  real:
                    canary.ids.length > 0
                      ? `observed realtime models: ${canary.ids.join(", ")}`
                      : "no realtime models observed",
                  mock: NO_MOCK_LEG,
                  // There is no per-model id for this diff (it reports the
                  // ABSENCE of a family), so without an explicit id the delta
                  // layer would key it by `path` — coupling the key to the alert
                  // prose. See NO_GA_DELTA_ID.
                  id: NO_GA_DELTA_ID,
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
                    "family) — add to knownVoiceModelFamilies in src/__tests__/drift/voice-models.ts",
                  path: "knownVoiceModelFamilies",
                  expected: "(not in knownVoiceModelFamilies)",
                  real: id,
                  mock: NO_MOCK_LEG,
                  // D6.2: set `id` to the model id so the delta layer (D6.1)
                  // can key by provider+id, yielding one distinct key per model
                  // rather than collapsing all entries under one path bucket.
                  id,
                })),
              ]
            : // CLASS 3: only genuine model ids become `real` diffs. The
              // truncation fact is carried as a SEPARATE diff whose `real` is a
              // count note, never a fake model id in a per-model slot.
              [
                ...canary.ids.map((id) => ({
                  severity: "critical" as const,
                  issue:
                    "Unknown realtime model detected — add to knownVoiceModelFamilies in " +
                    "src/__tests__/drift/voice-models.ts",
                  path: "knownVoiceModelFamilies",
                  expected: "(not in knownVoiceModelFamilies)",
                  real: id,
                  mock: NO_MOCK_LEG,
                  // D6.2: set `id` to the model id so the delta layer (D6.1)
                  // can key by provider+id, yielding one distinct key per model
                  // rather than collapsing all entries under one path bucket.
                  id,
                })),
                ...(canary.truncated
                  ? [
                      {
                        severity: "critical" as const,
                        issue:
                          "Additional unknown realtime models were truncated in CI output — " +
                          "the full list is unrecoverable without the UNKNOWN_REALTIME_MODELS= marker. " +
                          "Re-run with the marker to enumerate them.",
                        path: "knownVoiceModelFamilies[truncated]",
                        // CLASS 3: `real`/`expected` NEVER carry a prose sentinel.
                        // The truncation fact lives entirely in `issue`/`path`;
                        // there is no observed model value to report here.
                        expected: "<unavailable>",
                        real: "<unavailable>",
                        mock: NO_MOCK_LEG,
                        // No per-model id exists here either (the ids are the
                        // thing that was truncated away), so the key must be
                        // explicit. See TRUNCATED_DELTA_ID.
                        id: TRUNCATED_DELTA_ID,
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

        // A WS handshake that upgraded but never completed, carrying a surfaced
        // provider `error` event, is a parseable critical drift (exit 2) — not
        // an opaque exit-5 quarantine. Recognized narrowly so a bare network
        // timeout (no error body) still falls through to the quarantine lane.
        const wsFailure = parseWSHandshakeFailure(fullMessage, testName);
        if (wsFailure !== null) {
          // Attribution follows the probe that reported the failure, resolved in
          // parseWSHandshakeFailure. Hardcoding openai-realtime here is what made
          // a rejected gemini-live handshake quarantine instead of routing to
          // src/ws-gemini-live.ts.
          const mapping = SURFACE_REGISTRY[wsFailure.surface];
          entries.push({
            provider: mapping.provider,
            scenario: "WS handshake",
            builderFile: mapping.builderFile,
            builderFunctions: mapping.builderFunctions,
            typesFile: mapping.typesFile ?? null,
            sdkShapesFile: mapping.sdkShapesFile ?? SDK_SHAPES_FILE,
            diffs: [
              {
                severity: "critical" as const,
                issue:
                  `${mapping.provider} WS handshake did not complete — the live API returned an ` +
                  `error event (${wsFailure.errorType}/${wsFailure.errorCode}) and the expected ` +
                  "session lifecycle event never arrived. The session config sent by the " +
                  `probe/mock likely drifted from the live protocol. Error: ${wsFailure.errorMessage}`,
                // Display only — the delta key is the explicit `id` below, so this
                // string is free to be provider-neutral without moving any key.
                path: `handshake.${wsFailure.errorCode}`,
                expected: "(handshake completes: the session lifecycle event is received)",
                real: `error ${wsFailure.errorType}: ${wsFailure.errorMessage}`,
                mock: "<no mock leg — live handshake probe>",
                id: `ws-handshake:${wsFailure.errorCode}`,
              },
            ],
          });
          continue;
        }

        // A session the provider ENDED. Split by what the CLOSE frame actually
        // says, because the two halves are different evidence:
        //   - a REFUSAL code names something WE sent as unacceptable → genuine,
        //     attributable critical drift, exactly like an in-band error event;
        //   - any other code says only that the peer left → a hang-up, which is
        //     real and worth seeing but is not a finding about our payload.
        // Neither half may fall through to the unparseable lane: this message
        // states its own cause, and a stated cause routed to "manual triage" is
        // the failure that blocked every drift PR in the first place.
        const closed = parseWSServerClose(fullMessage);
        if (closed !== null) {
          const rawLocation = extractRawLocation(fullMessage);
          const surface = resolveWSSurface(fullMessage, testName);
          if (isRefusalCloseCode(closed.code)) {
            if (surface === null) {
              // A refusal we cannot attribute. Held for review rather than guessed
              // at — the same rule the handshake lane follows, and the message says
              // what is missing so the human is not left reading a stack trace.
              quarantine.push({
                provider: "unknown",
                testName,
                rawLocation,
                message:
                  `Provider REFUSED the WS session (close code ${closed.code}` +
                  `${closed.reason ? `: ${closed.reason}` : ""}) but neither the stack frame nor ` +
                  `the test name "${testName}" names a probe registered in WS_HANDSHAKE_PROBES, ` +
                  `so the owning surface is unknown. Register the probe (its file, and a suite ` +
                  `title that leads with its registry provider label) to attribute this ` +
                  `automatically.\n${fullMessage}`,
              });
              continue;
            }
            const mapping = SURFACE_REGISTRY[surface];
            entries.push({
              provider: mapping.provider,
              scenario: "WS session refused",
              builderFile: mapping.builderFile,
              builderFunctions: mapping.builderFunctions,
              typesFile: mapping.typesFile ?? null,
              sdkShapesFile: mapping.sdkShapesFile ?? SDK_SHAPES_FILE,
              diffs: [
                {
                  severity: "critical" as const,
                  issue:
                    `${mapping.provider} REFUSED the WS session — the provider closed the ` +
                    `connection with RFC 6455 code ${closed.code} instead of completing the ` +
                    `exchange. The stated reason is the diagnosis: ` +
                    `${closed.reason || "(the frame carried no reason text)"}`,
                  // Display only; the delta key is the explicit `id` below.
                  path: `ws-close.${closed.code}`,
                  expected: "(the session proceeds: the awaited message is received)",
                  real: `close ${closed.code}${closed.reason ? `: ${closed.reason}` : ""}`,
                  mock: "<no mock leg — live session probe>",
                  // Keyed by close CODE, not by the reason prose: providers reword
                  // reason text freely, and a key that moves on a reword would
                  // re-report the same refusal as new-in-head on every PR.
                  id: `ws-close:${closed.code}`,
                },
              ],
            });
            continue;
          }
          // Not a refusal — the peer hung up for its own reasons. Nothing was
          // graded, so this shares the exit-6 lane: visible, alerted, and never a
          // clean baseline, but not a finding and not a hard stop.
          timeouts.push({ testName, rawLocation, message: fullMessage, serverClose: closed });
          continue;
        }

        // A live leg that reached its wait budget having observed NOTHING. A
        // recognized outcome with its own lane (exit 6) — see parseLiveTimeout
        // for why it is neither drift nor unparseable. Checked AFTER the two
        // recognizers above so a timeout that DID surface a provider error body
        // stays the critical drift they classify it as.
        const liveTimeout = parseLiveTimeout(fullMessage);
        if (liveTimeout !== null) {
          timeouts.push({
            testName: `${assertion.ancestorTitles.join(" ")} > ${assertion.title}`,
            rawLocation: extractRawLocation(fullMessage),
            timeoutMs: liveTimeout.timeoutMs,
            message: fullMessage,
          });
          continue;
        }

        // Live refusals, access failures and inconclusive probes are visible
        // failures, never compatibility findings or benign skipped infra. Keep
        // them here even when a sibling already produced a trusted drift entry.
        if (resolveWSSurface(fullMessage, testName) === "openai-live") {
          quarantine.push({
            provider: SURFACE_REGISTRY["openai-live"].provider,
            testName,
            rawLocation: extractRawLocation(fullMessage),
            message: fullMessage,
          });
          continue;
        }

        unparseable++;
        continue;
      }

      // Resolution order (see WS-5 spec §3c):
      //
      //   1. `Surface:` marker present → structural lookup in SURFACE_REGISTRY.
      //      - hit  → auto-fixable DriftEntry (exit-2 lane). THIS IS THE FIX.
      //      - miss → a NEW surface whose author forgot the registry entry.
      //               Do NOT silently quarantine — THROW (collector-fault, exit
      //               1) so it is loud, distinct and actionable. fix-drift.yml
      //               treats a non-{2,5} collector exit as a "collector crashed"
      //               alert, so this cannot be ignored.
      //   2. No marker (legacy/unmigrated block) → fall back to the human
      //      provider-label match. Hit → entry; miss → quarantine (exit 5),
      //      exactly as before this change.
      const surfaceKey = extractSurfaceKey(fullMessage) ?? extractSurfaceKey(parsed.context);
      let provider: string;
      let mapping: ProviderMapping;
      if (surfaceKey !== null) {
        // `surfaceKey` is untrusted text (extractSurfaceKey → `\S+`). Guard with
        // own-property check BEFORE indexing: a plain-object bracket lookup walks
        // the prototype chain, so a slug like `constructor`/`toString`/`__proto__`
        // would otherwise resolve to a truthy inherited member and skip the throw,
        // emitting a garbage entry (`builderFile: undefined`). isKnownSurface uses
        // Object.prototype.hasOwnProperty.call — the same guard the emit side uses.
        if (!isKnownSurface(surfaceKey)) {
          throw new Error(
            `Unknown drift surface "${surfaceKey}" — add it to SURFACE_REGISTRY ` +
              `in src/__tests__/drift/surface-registry.ts (test: ${testName})`,
          );
        }
        const registered = SURFACE_REGISTRY[surfaceKey];
        provider = registered.provider;
        mapping = registered;
      } else {
        // Legacy no-marker fallback: match the human provider label.
        const label = extractProviderName(ancestorText) ?? extractProviderName(parsed.context);
        // Own-property guard for parity with the marker-path lookup above: even
        // though extractProviderName only returns real PROVIDER_LABEL_MAP keys
        // today, indexing without hasOwn would resolve prototype members
        // (`constructor`, etc.) to a truthy value if such a label were ever added.
        const legacyMapping =
          label && Object.hasOwn(PROVIDER_LABEL_MAP, label) ? PROVIDER_LABEL_MAP[label] : undefined;
        if (!label || !legacyMapping) {
          // Parseable drift block we cannot route to a source file. Held for
          // review (exit 5) rather than crashing the whole run. O-1: capture the
          // raw frame location BEFORE any stack stripping.
          quarantine.push({
            provider: label || parsed.context || ancestorText || "unknown",
            testName,
            rawLocation: extractRawLocation(fullMessage),
            message: fullMessage,
          });
          continue;
        }
        provider = label;
        mapping = legacyMapping;
      }

      entries.push({
        provider,
        scenario: extractScenario(parsed.context),
        builderFile: mapping.builderFile,
        builderFunctions: mapping.builderFunctions,
        typesFile: mapping.typesFile,
        sdkShapesFile: mapping.sdkShapesFile ?? SDK_SHAPES_FILE,
        diffs: parsed.diffs,
      });
    }
  }

  if (quarantine.length > 0) {
    console.warn(
      `WARNING: ${quarantine.length} drift failure(s) could not be mapped to a provider — ` +
        `quarantined for review (exit 5), not crashed:`,
    );
    for (const q of quarantine)
      console.warn(`  - ${q.testName} @ ${q.rawLocation || "<no frame>"}`);
  }

  if (unparseable > 0 && entries.length === 0) {
    // Collect the unparseable failure messages (with their raw pre-strip
    // locations) to classify them. O-1: capture file:line BEFORE stripping.
    const unparseableFailures: { message: string; testName: string; rawLocation: string }[] = [];
    for (const file of results.testResults) {
      for (const assertion of file.assertionResults) {
        if (assertion.status !== "failed" || assertion.failureMessages.length === 0) continue;
        const fullMessage = assertion.failureMessages.join("\n");
        const testName = `${assertion.ancestorTitles.join(" ")} > ${assertion.title}`;
        const parsed = parseDriftBlock(fullMessage);
        if (!parsed || parsed.diffs.length === 0) {
          // Canary and WS-handshake shapes are handled above (they became
          // entries) — only truly unparseable messages reach here. The handshake
          // check is given the SAME `testName` the first pass used so the two
          // passes cannot reach different verdicts on the same input. (This pass
          // only runs when there are zero entries, which already implies the
          // handshake recognizer claimed nothing, so no input distinguishes the
          // two arguments today; passing the real name keeps that a property of
          // the precondition rather than of a value chosen here.)
          if (parseKnownModelsCanary(fullMessage) !== null) continue;
          if (parseWSHandshakeFailure(fullMessage, testName) !== null) continue;
          // Recognized zero-observation live timeouts were claimed by the
          // timeout lane in the pass above; they are not unparseable.
          if (parseLiveTimeout(fullMessage) !== null) continue;
          // A recognized server close was claimed above too — either as an
          // attributed refusal, an explicit quarantine entry, or the exit-6 lane.
          if (parseWSServerClose(fullMessage) !== null) continue;
          unparseableFailures.push({
            message: fullMessage,
            testName,
            rawLocation: extractRawLocation(fullMessage),
          });
        }
      }
    }

    const unparseableMessages = unparseableFailures.map((f) => f.message);
    for (const msg of unparseableMessages) {
      console.warn(`  Unparseable failure message (first 300 chars): ${msg.slice(0, 300)}`);
    }

    // F1: classify EACH unparseable failure on its own so one leg's genuinely-
    // unparseable output never batch-poisons a sibling that failed on benign
    // infra. Previously a single all-or-nothing classifyUnparseableAsInfra call
    // over the whole batch meant one non-infra leg flipped the ENTIRE batch to
    // "not infra" and dragged every benign infra sibling into quarantine (exit
    // 5) — poisoning the shared base report for every downstream PR. Now an infra
    // leg is swallowed on its own merits and only the genuinely-unparseable
    // leg(s) are quarantined for review. A1.3: quarantine (exit 5), never a
    // fail-loud crash (exit 1) — exit 1 is reserved for genuine collector bugs.
    const infraCount = unparseableFailures.filter((f) =>
      classifySingleUnparseableAsInfra(f.message),
    ).length;
    const quarantinedLegs = unparseableFailures.filter(
      (f) => !classifySingleUnparseableAsInfra(f.message),
    );
    if (infraCount > 0) {
      console.warn(
        `WARNING: ${infraCount} test failure(s) appear to be API/infrastructure errors ` +
          `(not drift reports) — swallowed as benign infra.`,
      );
    }
    if (quarantinedLegs.length > 0) {
      console.warn(
        `WARNING: ${quarantinedLegs.length} test failure(s) could not be parsed as drift reports — ` +
          `quarantined for review (exit 5).`,
      );
      for (const f of quarantinedLegs) {
        quarantine.push({
          provider: "unknown",
          testName: f.testName,
          rawLocation: f.rawLocation,
          message: f.message,
        });
      }
    }
  } else if (unparseable > 0) {
    console.warn(
      `WARNING: ${unparseable} test failure(s) did not contain parseable drift data (${entries.length} drift entries collected).`,
    );
  }

  if (timeouts.length > 0) {
    // Reported as what it is, with the one thing a reader needs to act on: the
    // surface that went quiet. Explicitly NOT the quarantine wording — nothing
    // here needs collector triage, so nobody should be sent looking for it.
    console.warn(
      `WARNING: ${timeouts.length} live drift leg(s) timed out having observed ZERO messages — ` +
        `the live surface accepted the connection and then sent nothing. This is neither drift ` +
        `nor unparseable output (exit 6, conclusion "live-timeout"): there is no collector fault ` +
        `to triage. Check the surface below for an outage, a retired model, or a rejected session.`,
    );
    for (const t of timeouts) {
      const why = t.serverClose
        ? `session closed by the server (code ${t.serverClose.code}` +
          `${t.serverClose.reason ? `: ${t.serverClose.reason}` : ", no reason given"})`
        : `no messages in ${t.timeoutMs}ms`;
      console.warn(`  - ${t.testName} — ${why} @ ${t.rawLocation || "<no frame>"}`);
    }
    console.warn(
      `  If this persists across runs it is not a flake. A leg that reports NO close code and no ` +
        `messages was met with genuine silence; one that reports a close code was hung up on, and ` +
        `the code names who ended it. A close code in the refusal range is reported separately, as ` +
        `attributed critical drift, not here.`,
    );
  }

  return { entries, quarantine, timeouts };
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
/**
 * Legacy source name retained for diagnostics and existing callers. Checkout
 * validity is decided by the shared resolver: both generated source files or
 * both legacy source files must exist before the canonical comparison runs.
 */
export const AGUI_CANONICAL_TYPES_RELPATH = "sdks/typescript/packages/core/src/types.ts";

/**
 * What a candidate `../ag-ui` directory actually is.
 *
 *   - `ok`         — a usable canonical checkout (the canonical types file is there).
 *   - `absent`     — no such directory; cloning is the correct next step.
 *   - `incomplete` — a directory named `ag-ui` EXISTS but does not contain the
 *                    canonical sources. This is a stale/wrong/partial checkout,
 *                    NOT a git or network failure, and must be reported as such:
 *                    misreporting it sends the reader hunting a network problem
 *                    that isn't there while the drift leg grades nothing.
 */
export type AgUiCheckoutStatus =
  | { kind: "ok" }
  | { kind: "absent" }
  | { kind: "incomplete"; reason: string };

/**
 * Classify a candidate canonical AG-UI checkout. Pure w.r.t. the filesystem it
 * is handed (no cloning, no mutation) so it is unit-testable against a temp dir.
 */
export function classifyAgUiCheckout(agUiPath: string): AgUiCheckoutStatus {
  let isDir = false;
  try {
    isDir = existsSync(agUiPath) && statSync(agUiPath).isDirectory();
  } catch (statErr: unknown) {
    const msg = statErr instanceof Error ? statErr.message : String(statErr);
    return {
      kind: "incomplete",
      reason: `could not stat AG-UI repo path ${agUiPath}: ${msg}`,
    };
  }
  if (!isDir) return { kind: "absent" };
  if (!discoverAgUiSources(agUiPath)) {
    return {
      kind: "incomplete",
      reason:
        `${agUiPath} lacks a complete generated types.ts/schemas.ts or legacy events.ts/types.ts pair (${AGUI_CANONICAL_TYPES_RELPATH}) — the canonical ` +
        `AG-UI checkout is STALE or INCOMPLETE. This is not a git/network failure: remove the ` +
        `directory and re-clone (git clone --depth 1 https://github.com/ag-ui-protocol/ag-ui.git).`,
    };
  }
  return { kind: "ok" };
}

function ensureAgUiRepo(): boolean {
  const agUiPath = resolveAgUiRepo(resolve("..", "ag-ui"));
  const status = classifyAgUiCheckout(agUiPath);
  if (status.kind === "ok") return true;
  if (status.kind === "incomplete") {
    // N5: do NOT proceed. Running the drift suites against an unusable checkout
    // cannot establish compatibility; never certify an ungraded checkout as clean.
    console.warn(`AG-UI canonical checkout unusable: ${status.reason}`);
    console.warn("AG-UI schema drift detection will be skipped.");
    return false;
  }

  // Not present — try to clone
  console.log("AG-UI canonical repo not found. Cloning...");
  try {
    execFileSync(
      "git",
      ["clone", "--depth", "1", "https://github.com/ag-ui-protocol/ag-ui.git", agUiPath],
      {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 60_000,
      },
    );
  } catch (cloneErr: unknown) {
    const msg = cloneErr instanceof Error ? cloneErr.message : String(cloneErr);
    console.warn(`Could not clone AG-UI repo: ${msg}`);
    console.warn("AG-UI schema drift detection will be skipped.");
    return false;
  }
  // A clone that "succeeded" but still lacks the canonical sources is the same
  // unusable checkout as above — re-verify rather than assume.
  const afterClone = classifyAgUiCheckout(agUiPath);
  if (afterClone.kind !== "ok") {
    console.warn(
      `AG-UI repo cloned but the checkout is still unusable: ` +
        `${afterClone.kind === "incomplete" ? afterClone.reason : `${agUiPath} is absent`}`,
    );
    console.warn("AG-UI schema drift detection will be skipped.");
    return false;
  }
  console.log("AG-UI repo cloned successfully.");
  return true;
}

/** How the AG-UI leg shells out. Injectable so the parse contract is testable. */
export type VitestExec = (command: string) => string;

const defaultAgUiExec: VitestExec = (command) =>
  execSync(command, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 50 * 1024 * 1024,
  });

/**
 * Run the AG-UI drift lane and return its vitest JSON.
 *
 * `null` means the leg could not run at all (infra) — the caller maps that to
 * the collector's exit-1 "skipped" lane.
 *
 * FAIL-CLOSED (twin symmetry): a ZERO-exit run whose stdout cannot be parsed as
 * vitest JSON THROWS, exactly as the HTTP twin `runDriftTests()` does. It used
 * to `return { testResults: [] }` — an empty result the collector reads as "no
 * failures", i.e. exit 0 / `conclusion: "clean"` — so a lane that produced
 * garbage instead of a report certified AG-UI as drift-free. The two legs face
 * the same condition and must not disagree about whether it is clean.
 */
export function runAgUiVitest(
  exec: VitestExec = defaultAgUiExec,
  evidence?: LegEvidence,
): VitestJsonResult | null {
  let stdout: string;
  try {
    stdout = exec(
      `npx vitest run ${AGUI_DRIFT_TEST_FILTER} --config vitest.config.drift.ts --reporter=json`,
    );
  } catch (err: unknown) {
    if (hasStdout(err)) {
      const result = parseVitestOutput(err.stdout, "AG-UI drift JSON parse of failed run");
      if (result) {
        captureAssertionEvidence(evidence, result);
        return result;
      }
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`AG-UI schema drift tests failed to run: ${msg}`);
    return null;
  }
  const result = parseVitestOutput(stdout, "AG-UI drift JSON parse of successful run failed");
  if (result) {
    captureAssertionEvidence(evidence, result);
    return result;
  }
  throw new Error("AG-UI drift tests passed but produced unparseable output");
}

function runAgUiDriftTests(evidence: LegEvidence): VitestJsonResult | null {
  if (!ensureAgUiRepo()) return null;
  return runAgUiVitest((command) => executeEvidenceVitest(command, evidence), evidence);
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
 *
 * FAIL-CLOSED INVARIANT (W5/N1): a FAILED AG-UI assertion this function cannot
 * structurally interpret MUST NOT vanish. Previously any failure that matched
 * none of the recognizers above was dropped — no entry, no counter, no warning —
 * so a genuinely failing assertion in `agui-schema.drift.ts` (e.g. `should parse
 * aimock event types`, whose bare `expect` message matches none of the three
 * shapes) produced zero entries, exit 0 and `conclusion: "clean"`. The same went
 * for a FAILED assertion carrying no message at all. Every such failure is now returned
 * as a `QuarantineEntry`, reusing the collector's EXISTING quarantine/exit-5
 * lane — the same "held for review, never silently swallowed" contract the HTTP
 * leg already uses. Note this is per-assertion and UNCONDITIONAL: unlike the
 * HTTP leg's `entries.length === 0`-gated rescue, an unrecognized AG-UI failure
 * survives a mixed run in which other failures DID parse.
 */
export function collectAgUiDriftEntries(results: VitestJsonResult): {
  entries: DriftEntry[];
  quarantine: QuarantineEntry[];
} {
  const entries: DriftEntry[] = [];
  const quarantine: QuarantineEntry[] = [];

  // Accumulate all diffs across assertions into a single entry per scenario
  const missingTypesDiffs: ParsedDiff[] = [];
  const fieldDriftDiffs: ParsedDiff[] = [];

  for (const file of results.testResults) {
    for (const assertion of file.assertionResults) {
      if (assertion.status !== "failed") continue;

      const testNameForQuarantine =
        `${assertion.ancestorTitles.join(" ")} > ${assertion.title}`.trim();

      if (assertion.failureMessages.length === 0) {
        // A FAILED assertion carrying no message is the least interpretable
        // failure there is — the collector cannot even see what broke. Skipping
        // it read as exit 0 / "clean", which is the same fail-open the
        // quarantine lane below exists to close, so it takes the same lane.
        quarantine.push({
          provider: "AG-UI",
          testName: testNameForQuarantine,
          rawLocation: "",
          message: "AG-UI drift assertion failed with no failure message reported by vitest.",
        });
        continue;
      }

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
      const genericCritical =
        !thisAssertionExtracted &&
        (fullMessage.includes("Missing event types") ||
          fullMessage.includes("Critical field drift"));
      if (genericCritical) {
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

      if (!thisAssertionExtracted && !genericCritical) {
        // The fail-closed lane. This assertion FAILED and none of the shapes
        // above claimed it, so the collector cannot say what drifted — but it
        // absolutely must not say "clean". Held for review (exit 5), with the
        // raw pre-strip frame so a human can find the assertion, exactly as the
        // HTTP leg quarantines its unmappable failures.
        quarantine.push({
          provider: "AG-UI",
          testName: testNameForQuarantine,
          rawLocation: extractRawLocation(fullMessage),
          message: fullMessage,
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

  if (quarantine.length > 0) {
    console.warn(
      `WARNING: ${quarantine.length} AG-UI drift failure(s) could not be interpreted by the ` +
        `collector — quarantined for review (exit 5), NOT reported as clean:`,
    );
    for (const q of quarantine)
      console.warn(`  - ${q.testName} @ ${q.rawLocation || "<no frame>"}`);
  }

  return { entries, quarantine };
}

// ---------------------------------------------------------------------------
// Exit-code policy
// ---------------------------------------------------------------------------

/**
 * Map the three terminal signals a drift run can produce onto the collector's
 * process exit code. Pure and side-effect-free so the mapping is unit-testable
 * without spawning the drift suite.
 *
 * Precedence (highest first):
 *   - `criticalCount > 0`  → 2  — at least one trustworthy critical drift.
 *   - `quarantineCount > 0`→ 5  — a failure could not be parsed/mapped into a
 *                                 trustworthy finding and was held for review;
 *                                 distinct from a critical (2) and from a clean
 *                                 pass (0) so it is never silently swallowed.
 *   - `agUiSkipped`        → 1  — AG-UI drift detection could not run (infra).
 *                                 O2: AG-UI-skipped stays exit 1 (unchanged).
 *   - otherwise            → 0  — no drift.
 *
 * Critical wins over quarantine: if the run found a genuine critical drift, that
 * is the actionable signal even if some other failure was also quarantined.
 */
export function computeExitCode(
  criticalCount: number,
  quarantineCount: number,
  agUiSkipped: boolean,
  timeoutCount: number = 0,
): 0 | 1 | 2 | 5 | 6 {
  if (criticalCount > 0) return 2;
  if (quarantineCount > 0) return 5;
  if (agUiSkipped) return 1;
  // 6 — every leg that failed did so by observing nothing at all. Distinct from
  // 5 so a silent live surface is never reported as a collector fault needing
  // manual triage, and distinct from 0 so it is never a clean baseline: the legs
  // that timed out graded NOTHING, and a run that graded nothing must not be
  // able to certify that surface as drift-free.
  if (timeoutCount > 0) return 6;
  return 0;
}

/**
 * Map a collector exit code to the coarse `conclusion` written into the drift
 * report, so the base-report reuse guard (`isBaseReportReusable`) can read
 * `report.conclusion` directly. Only exit 0 ("clean") is a reusable baseline;
 * "critical"/"quarantine" (and the exit-1 "skipped" case) are not.
 */
export function conclusionForExitCode(exitCode: 0 | 1 | 2 | 5 | 6): string {
  switch (exitCode) {
    case 0:
      return "clean";
    case 2:
      return "critical";
    case 5:
      return "quarantine";
    case 6:
      // NOT in drift-delta's REUSABLE_CONCLUSIONS, deliberately: a run whose
      // legs observed nothing cannot serve as a baseline that says they were
      // clean.
      return "live-timeout";
    default:
      return "skipped";
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Every registry surface that NO live provider leg grades.
 *
 * The source-only view reads `SURFACE_REGISTRY`: whether a surface has
 * a live leg is a property of the SOURCE, not of what happened to execute, so
 * this is the same answer on a credential-less run as on a fully-keyed one —
 * which is exactly the point. A surface with no live leg is never "verified and
 * clean", it is "not looked at", and the report now says so out loud instead of
 * letting its absence from `entries` read as a pass.
 */
export function collectUnverifiedSurfaces(results?: VitestJsonResult): UnverifiedSurface[] {
  const surfaces = Object.entries(SURFACE_REGISTRY)
    .filter(([, mapping]) => mapping.liveCoverage === "none")
    .map(([surface, mapping]) => ({
      surface,
      provider: mapping.provider,
      // Narrowed by the filter above: `liveCoverage: "none"` makes
      // `coverageNote` required in the SurfaceMapping union.
      note: mapping.coverageNote as string,
    }))
    .sort((a, b) => a.surface.localeCompare(b.surface));

  // Source capability is not runtime coverage. The Live provider suite has
  // separate client/managed assertions; every selected assertion must pass.
  // Keep the no-argument form for source-only callers that have no run report.
  if (results) {
    const assertions = results.testResults
      .flatMap((file) => file.assertionResults)
      .filter(
        (assertion) =>
          resolveWSProbeSurfaceByName(assertion.ancestorTitles.join(" ")) === "openai-live",
      );
    const passed = assertions.filter((a) => a.status === "passed").length;
    const bothModesPassed = ["client lifecycle", "managed lifecycle"].every((title) =>
      assertions.some((a) => a.title === title && a.status === "passed"),
    );
    if (!bothModesPassed || passed !== assertions.length) {
      const failed = assertions.filter((a) => a.status === "failed").length;
      const skipped = assertions.filter((a) =>
        ["pending", "skipped", "todo", "disabled"].includes(a.status),
      ).length;
      surfaces.push({
        surface: "openai-live",
        provider: SURFACE_REGISTRY["openai-live"].provider,
        note:
          assertions.length === 0
            ? "No Live assertions executed in this run. Live compatibility was not verified."
            : `This run: ${passed} passed, ${failed} failed, ${skipped} skipped, ${assertions.length - passed - failed - skipped} other Live assertions. Live compatibility was not fully verified.`,
      });
    }
  }
  return surfaces.sort((a, b) => a.surface.localeCompare(b.surface));
}

function collectMain(evidence: { drift: LegEvidence; agui: LegEvidence }): number {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const outPath = resolve(
    outIndex !== -1 && args[outIndex + 1] ? args[outIndex + 1] : "drift-report.json",
  );

  // Collect HTTP API drift entries
  console.log("Running HTTP API drift tests...");
  const httpResults = runDriftTests(evidence.drift);
  console.log("Collecting HTTP API drift entries...");
  const httpResult = collectDriftEntries(httpResults);
  const httpEntries = httpResult.entries;

  // Collect AG-UI schema drift entries
  console.log("Running AG-UI schema drift tests...");
  const agUiResults = runAgUiDriftTests(evidence.agui);
  const agUiSkipped = agUiResults === null;
  let agUiEntries: DriftEntry[] = [];
  let agUiQuarantine: QuarantineEntry[] = [];
  if (agUiResults) {
    console.log("Collecting AG-UI schema drift entries...");
    const agUiResult = collectAgUiDriftEntries(agUiResults);
    agUiEntries = agUiResult.entries;
    agUiQuarantine = agUiResult.quarantine;
  } else {
    console.warn("WARNING: AG-UI schema drift tests could not run — results will be incomplete.");
  }

  const entries = [...httpEntries, ...agUiEntries];
  const quarantine = [...httpResult.quarantine, ...agUiQuarantine];
  const timeouts = httpResult.timeouts;

  const criticalCount = entries.reduce(
    (sum, e) => sum + e.diffs.filter((d) => d.severity === "critical").length,
    0,
  );
  const quarantineCount = quarantine.length;
  const timeoutCount = timeouts.length;

  // Compute the exit code BEFORE writing so the report can carry the coarse
  // `conclusion` derived from it (base-report reuse contract).
  const exitCode = computeExitCode(criticalCount, quarantineCount, agUiSkipped, timeoutCount);

  const unverifiedSurfaces = collectUnverifiedSurfaces(httpResults);

  const timestamp = new Date().toISOString();
  const report: DriftReport = {
    timestamp,
    // Alias of `timestamp` read by the reuse guard; `timestamp` kept for
    // back-compat with existing consumers.
    generatedAt: timestamp,
    conclusion: conclusionForExitCode(exitCode),
    entries,
    ...(quarantine.length > 0 ? { quarantine } : {}),
    ...(timeouts.length > 0 ? { timeouts } : {}),
    // Written unconditionally (even when empty): an absent field must mean "an
    // old report", never "every surface was verified".
    unverifiedSurfaces,
  };

  try {
    writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n", "utf-8");
  } catch (err) {
    console.error(`Failed to write drift report to ${outPath}:`, err);
    console.log(JSON.stringify(report, null, 2));
    return 1;
  }
  console.log(`Drift report written to ${outPath}`);
  console.log(`  HTTP API entries: ${httpEntries.length}`);
  if (agUiSkipped) {
    console.log(`  AG-UI schema entries: SKIPPED (could not run tests)`);
  } else {
    console.log(`  AG-UI schema entries: ${agUiEntries.length}`);
    console.log(`  AG-UI uninterpretable failures (quarantined): ${agUiQuarantine.length}`);
  }
  console.log(`  Total entries: ${entries.length}`);
  console.log(`  Critical diffs: ${criticalCount}`);
  console.log(`  Quarantined failures: ${quarantineCount}`);
  console.log(`  Live timeouts (zero observations): ${timeoutCount}`);
  if (unverifiedSurfaces.length > 0) {
    console.log(
      `  Surfaces with NO live drift coverage (offline conformance only, not verified ` +
        `against the vendor): ${unverifiedSurfaces.length}`,
    );
    for (const entry of unverifiedSurfaces) {
      console.log(`    - ${entry.surface} (${entry.provider})`);
    }
  }

  switch (exitCode) {
    case 2:
      console.log("Exiting with code 2 (critical diffs found).");
      return 2;
    case 5:
      console.warn(`Exiting with code 5 (${quarantineCount} failure(s) quarantined for review).`);
      return 5;
    case 6:
      console.warn(
        `Exiting with code 6 (${timeoutCount} live leg(s) timed out with zero observations — ` +
          `no drift graded on those surfaces; NOT a collector fault).`,
      );
      return 6;
    case 1:
      console.warn("Exiting with code 1 (AG-UI drift detection was skipped — infra failure).");
      return 1;
    default:
      console.log(
        unverifiedSurfaces.length > 0
          ? `No critical diffs found (on the surfaces that were actually checked — ` +
              `${unverifiedSurfaces.length} surface(s) have no live coverage at all).`
          : "No critical diffs found.",
      );
      return 0;
  }
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
    process.exitCode = withInvocationEvidence(collectMain);
  } catch (err: unknown) {
    console.error("Fatal error:", err);
    process.exit(1);
  }
}
