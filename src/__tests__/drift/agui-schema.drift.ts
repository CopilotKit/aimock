/**
 * AG-UI schema drift test.
 *
 * Compares aimock's AGUIEventType union and event interfaces against the
 * canonical Zod schemas in @ag-ui/core (read from disk via static analysis).
 * No runtime dependency on @ag-ui/core: generated validators use TypeScript AST
 * parsing; the legacy layout retains its inheritance-aware source parser.
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  discoverAgUiSources,
  resolveAgUiRepo,
  parseGeneratedAgUi,
} from "../../../scripts/drift-agui-canonical.js";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const canonical = discoverAgUiSources(
  resolveAgUiRepo(path.resolve(import.meta.dirname, "../../../../ag-ui")),
);
const AIMOCK_TYPES_PATH = path.resolve(import.meta.dirname, "../../agui-types.ts");

// ---------------------------------------------------------------------------
// Canonical parser — extract EventType enum values from ag-ui events.ts
// ---------------------------------------------------------------------------

interface FieldInfo {
  name: string;
  optional: boolean;
}

interface SchemaInfo {
  eventType: string;
  fields: FieldInfo[];
}

function parseCanonicalEventTypes(source: string): string[] {
  const enumBlock = source.match(/export enum EventType\s*\{([\s\S]*?)\}/);
  if (!enumBlock) return [];
  const members: string[] = [];
  for (const m of enumBlock[1].matchAll(/(\w+)\s*=\s*"(\w+)"/g)) {
    members.push(m[2]);
  }
  return members;
}

/** Maps an exported schema name to the source text of its definition. */
type SchemaAliases = Map<string, string>;

/**
 * Build a name -> definition map for every `export const X = ...` in the
 * canonical core package.
 *
 * Optionality is otherwise decided by substring-matching `.optional()` in a
 * field's own text, which silently reads a named alias as required — the
 * failure that reported all 33 events as CRITICAL when upstream declared
 * `metadata: OptionalMetadataSchema`.
 */
function buildSchemaAliases(dir: string): SchemaAliases {
  const aliases: SchemaAliases = new Map();
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith(".ts"));
  } catch {
    return aliases; // Absent checkout is reported by the suite's own guard.
  }
  for (const entry of entries) {
    const source = fs.readFileSync(path.join(dir, entry), "utf-8");
    for (const match of source.matchAll(/export const (\w+)\s*=\s*([\s\S]*?);\s*$/gm)) {
      if (!aliases.has(match[1])) aliases.set(match[1], match[2].trim());
    }
  }
  return aliases;
}

// A definition may alias another alias; bound the walk so a circular or
// self-referential export cannot hang the parse.
const MAX_ALIAS_HOPS = 5;

/**
 * Decide whether a field definition is optional, following named aliases.
 */
function isOptionalDef(fieldDef: string, aliases: SchemaAliases, hops = 0): boolean {
  if (fieldDef.includes(".optional()") || fieldDef.includes(".default(")) return true;
  if (hops >= MAX_ALIAS_HOPS) return false;
  // Only a bare identifier is an alias reference; anything else is an inline
  // Zod expression whose own text already settled the question above.
  const bare = fieldDef.match(/^(\w+)$/);
  if (!bare) return false;
  const target = aliases.get(bare[1]);
  if (target === undefined) return false;
  return isOptionalDef(target, aliases, hops + 1);
}

/**
 * Split an object-literal body on its top-level commas.
 *
 * A field definition can span lines — upstream writes `parentMessageId` as a
 * `.string().nullable().optional().transform(...)` chain broken across five of
 * them. Matching line by line sees only `z` and calls the field required, so
 * entries are cut on commas at nesting depth zero instead.
 */
function splitTopLevelEntries(body: string): string[] {
  const entries: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      entries.push(body.slice(start, i));
      start = i + 1;
    }
  }
  entries.push(body.slice(start));
  return entries.filter((e) => e.trim().length > 0);
}

/**
 * Extract field definitions from a Zod `.extend({...})` block body.
 */
function extractExtendFields(extendBody: string, aliases: SchemaAliases): FieldInfo[] {
  // Strip comments so they don't match as field definitions. Trailing comments
  // must go too, not just whole-line ones: `delta: z.array(z.any()), // JSON
  // Patch (RFC 6902)` splits on its top-level comma, and the comment then
  // leads the NEXT entry, so the field-name match fails and that field is
  // dropped silently. That is how canonical STATE_DELTA.subagentRunId read as
  // absent. Safe to strip unconditionally here: no canonical schema literal
  // contains `//`.
  const cleanBody = extendBody.replace(/\/\/[^\n]*/g, "");
  const fields: FieldInfo[] = [];
  for (const entry of splitTopLevelEntries(cleanBody)) {
    const fieldMatch = entry.match(/^\s*(\w+)\s*:\s*([\s\S]+)$/);
    if (!fieldMatch) continue;
    // Collapse the chain back onto one line so alias detection and the
    // `.optional()` scan see the whole definition.
    const fieldDef = fieldMatch[2].replace(/\s+/g, " ").trim();
    fields.push({ name: fieldMatch[1], optional: isOptionalDef(fieldDef, aliases) });
  }
  return fields;
}

/**
 * Parse Zod `.extend({...})` blocks to extract field names and optionality.
 *
 * Two-pass approach:
 * 1. First pass: collect all schema definitions and their raw extend fields.
 * 2. Second pass: resolve parent schema chains to inherit fields correctly.
 *
 * This handles chains like:
 *   TextMessageContentEventSchema.omit({...}).extend({...})
 * where ThinkingTextMessageContentEventSchema inherits delta from TextMessageContent.
 */

/**
 * Parse base fields from `BaseEventSchema = z.object({...})` in canonical source.
 * Falls back to hardcoded defaults if parsing fails.
 */
function parseCanonicalBaseFields(source: string, aliases: SchemaAliases): FieldInfo[] {
  const baseMatch = source.match(
    /export const BaseEventSchema\s*=\s*z\s*\.\s*object\(\{([\s\S]*?)\}\)/,
  );
  if (!baseMatch) {
    return [
      { name: "type", optional: false },
      { name: "timestamp", optional: true },
      { name: "rawEvent", optional: true },
    ];
  }
  return extractExtendFields(baseMatch[1], aliases);
}

function parseCanonicalSchemas(source: string, aliases: SchemaAliases): Map<string, SchemaInfo> {
  const schemas = new Map<string, SchemaInfo>();

  // Parse base event fields dynamically from BaseEventSchema
  const baseFields = parseCanonicalBaseFields(source, aliases);

  // Pass 1: collect raw schema definitions keyed by schema name
  interface RawSchema {
    schemaName: string;
    body: string;
    eventType: string;
    parentSchemaName: string | null; // null = BaseEventSchema
  }

  const rawSchemas = new Map<string, RawSchema>();
  // Also store fields per schema name (not event type) for parent resolution
  const fieldsBySchemaName = new Map<string, FieldInfo[]>();

  const schemaPattern =
    /export const (\w+EventSchema)\s*=\s*([\s\S]*?)(?=\nexport const |\nexport type |\nexport enum |\n\/\/ |$)/g;

  for (const match of source.matchAll(schemaPattern)) {
    const schemaName = match[1];
    const body = match[2];

    if (schemaName === "BaseEventSchema" || schemaName === "EventSchemas") continue;
    if (schemaName === "ReasoningEncryptedValueSubtypeSchema") continue;

    const typeMatch = body.match(/z\.literal\(EventType\.(\w+)\)/);
    if (!typeMatch) continue;
    const eventType = typeMatch[1];

    // Detect parent schema: anything before .omit() or .extend()
    // e.g. "TextMessageContentEventSchema.omit({...}).extend({...})"
    const parentMatch = body.match(/^(\w+EventSchema)(?:\.omit|\.extend)/);
    const parentSchemaName =
      parentMatch && parentMatch[1] !== "BaseEventSchema" ? parentMatch[1] : null;

    rawSchemas.set(schemaName, { schemaName, body, eventType, parentSchemaName });

    // Collect this schema's own extend fields
    const ownFields: FieldInfo[] = [];
    const extendPattern = /\.extend\(\{([\s\S]*?)\}\)/g;
    for (const extendMatch of body.matchAll(extendPattern)) {
      ownFields.push(...extractExtendFields(extendMatch[1], aliases));
    }
    fieldsBySchemaName.set(schemaName, ownFields);
  }

  // Recursive parent field resolver for multi-level inheritance chains
  function resolveParentFields(schemaName: string): FieldInfo[] {
    const entry = rawSchemas.get(schemaName);
    if (!entry) return [];
    const parentFields = entry.parentSchemaName ? resolveParentFields(entry.parentSchemaName) : [];
    return [...parentFields, ...(fieldsBySchemaName.get(schemaName) || [])];
  }

  // Pass 2: resolve full field sets with parent inheritance
  for (const [, raw] of rawSchemas) {
    const fields = new Map<string, FieldInfo>();

    // Start with base fields
    for (const f of baseFields) {
      fields.set(f.name, { ...f });
    }

    // Resolve full parent chain (handles multi-level inheritance)
    if (raw.parentSchemaName) {
      for (const f of resolveParentFields(raw.parentSchemaName)) {
        fields.set(f.name, { ...f });
      }
    }

    // Apply .omit() — removes fields
    const omitMatch = raw.body.match(/\.omit\(\{([\s\S]*?)\}\)/);
    if (omitMatch) {
      for (const omitField of omitMatch[1].matchAll(/(\w+)\s*:\s*true/g)) {
        fields.delete(omitField[1]);
      }
    }

    // Apply this schema's own extend fields (overrides parent)
    const ownFields = fieldsBySchemaName.get(raw.schemaName) || [];
    for (const f of ownFields) {
      fields.set(f.name, { ...f });
    }

    schemas.set(raw.eventType, {
      eventType: raw.eventType,
      fields: Array.from(fields.values()),
    });
  }

  return schemas;
}

// ---------------------------------------------------------------------------
// Aimock parser — extract AGUIEventType members and interface fields
// ---------------------------------------------------------------------------

function parseAimockEventTypes(source: string): string[] {
  const unionBlock = source.match(/export type AGUIEventType\s*=([\s\S]*?);/);
  if (!unionBlock) return [];
  const members: string[] = [];
  for (const m of unionBlock[1].matchAll(/"(\w+)"/g)) {
    members.push(m[1]);
  }
  return members;
}

/**
 * Parse base fields from `AGUIBaseEvent` interface in aimock source.
 * Falls back to hardcoded defaults if parsing fails.
 */
function parseAimockBaseFields(source: string): FieldInfo[] {
  const baseMatch = source.match(/export interface AGUIBaseEvent\s*\{([\s\S]*?)\}/);
  if (!baseMatch) {
    return [
      { name: "type", optional: false },
      { name: "timestamp", optional: true },
      { name: "rawEvent", optional: true },
    ];
  }
  const fields: FieldInfo[] = [];
  for (const fieldMatch of baseMatch[1].matchAll(/(\w+)(\??)\s*:\s*([^;]+);/g)) {
    const fieldName = fieldMatch[1];
    const optional = fieldMatch[2] === "?";
    fields.push({ name: fieldName, optional });
  }
  return fields;
}

function parseAimockInterfaces(source: string): Map<string, SchemaInfo> {
  const interfaces = new Map<string, SchemaInfo>();

  // Parse base fields dynamically from AGUIBaseEvent interface
  const baseFields = parseAimockBaseFields(source);

  // Match interface blocks
  const interfacePattern = /export interface AGUI(\w+Event)\s+extends\s+\w+\s*\{([\s\S]*?)\}/g;

  for (const match of source.matchAll(interfacePattern)) {
    const body = match[2];

    // Extract the event type from the `type: "XXX"` field
    const typeMatch = body.match(/type:\s*"(\w+)"/);
    if (!typeMatch) continue;
    const eventType = typeMatch[1];

    // Start with dynamically-parsed base fields
    const fields: FieldInfo[] = baseFields.map((f) => ({ ...f }));

    // Parse fields from the interface body
    for (const fieldMatch of body.matchAll(/(\w+)(\??)\s*:\s*([^;]+);/g)) {
      const fieldName = fieldMatch[1];
      if (fieldName === "type") continue; // already added from base
      const optional = fieldMatch[2] === "?";
      fields.push({ name: fieldName, optional });
    }

    interfaces.set(eventType, {
      eventType,
      fields,
    });
  }

  return interfaces;
}

// ---------------------------------------------------------------------------
// Drift reporting
// ---------------------------------------------------------------------------

type Severity = "CRITICAL" | "WARNING" | "OK";

interface DriftItem {
  severity: Severity;
  message: string;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const canonicalExists = canonical !== null;
const aimockExists = fs.existsSync(AIMOCK_TYPES_PATH);

describe("AG-UI schema drift", () => {
  beforeAll(() => {
    if (!canonical || !aimockExists)
      throw new Error(
        "AG-UI canonical comparison unavailable: expected a complete generated or legacy source layout and aimock types",
      );
  });
  let parsingError: unknown;
  let canonicalSource: string;
  let aimockSource: string;
  let canonicalTypes: string[];
  let aimockTypes: string[];
  let canonicalSchemas: Map<string, SchemaInfo>;
  let aimockInterfaces: Map<string, SchemaInfo>;

  // Parse after test registration so unsupported upstream schemas fail assertions
  // and remain visible to the collector instead of aborting suite collection.
  beforeAll(() => {
    if (!canonical || !aimockExists) return;
    try {
      canonicalSource = fs.readFileSync(canonical.types, "utf-8");
      aimockSource = fs.readFileSync(AIMOCK_TYPES_PATH, "utf-8");
      aimockTypes = parseAimockEventTypes(aimockSource);
      if (canonical.layout === "generated") {
        const parsed = parseGeneratedAgUi(
          canonicalSource,
          fs.readFileSync(canonical.schemas, "utf-8"),
        );
        canonicalTypes = parsed.types;
        canonicalSchemas = parsed.schemas;
      } else {
        canonicalTypes = parseCanonicalEventTypes(canonicalSource);
        canonicalSchemas = parseCanonicalSchemas(
          canonicalSource,
          buildSchemaAliases(canonical.directory),
        );
      }
      aimockInterfaces = parseAimockInterfaces(aimockSource);
    } catch (error) {
      parsingError = error;
    }
  });

  it("should have complete canonical sources available", () => {
    expect(parsingError).toBeUndefined();
    expect(canonicalExists).toBe(true);
    expect(aimockExists).toBe(true);
  });

  it("should parse canonical event types", () => {
    expect(canonicalTypes.length).toBeGreaterThan(0);
    expect(canonicalTypes).toContain("RUN_STARTED");
    expect(canonicalTypes).toContain("TEXT_MESSAGE_START");
  });

  it("should parse aimock event types", () => {
    expect(aimockTypes.length).toBeGreaterThan(0);
    expect(aimockTypes).toContain("RUN_STARTED");
    expect(aimockTypes).toContain("TEXT_MESSAGE_START");
  });

  it("all canonical event types are present in aimock", () => {
    const aimockSet = new Set(aimockTypes);
    const missing: DriftItem[] = [];

    for (const eventType of canonicalTypes) {
      if (!aimockSet.has(eventType)) {
        missing.push({
          severity: "CRITICAL",
          message: `Event type "${eventType}" exists in canonical @ag-ui/core but is missing from aimock AGUIEventType`,
        });
      }
    }

    if (missing.length > 0) {
      const report = missing.map((d) => `[${d.severity}] ${d.message}`).join("\n");
      expect(missing, `Missing event types:\n${report}`).toEqual([]);
    }
  });

  it("no unknown event types in aimock", () => {
    const canonicalSet = new Set(canonicalTypes);
    const extras: DriftItem[] = [];

    for (const eventType of aimockTypes) {
      if (!canonicalSet.has(eventType)) {
        extras.push({
          severity: "WARNING",
          message: `Event type "${eventType}" exists in aimock but not in canonical @ag-ui/core (extra or deprecated?)`,
        });
      }
    }

    if (extras.length > 0) {
      const report = extras.map((d) => `[${d.severity}] ${d.message}`).join("\n");
      // Warnings don't fail the test, just log
      console.warn(`Extra event types in aimock:\n${report}`);
    }

    // This test always passes — extras are warnings, not failures
    expect(true).toBe(true);
  });

  it("event field shapes match canonical schemas", () => {
    const drifts: DriftItem[] = [];

    for (const [eventType, canonical] of canonicalSchemas) {
      const aimock = aimockInterfaces.get(eventType);
      if (!aimock) {
        // Missing event type is already caught by the event types test
        continue;
      }

      const canonicalFieldMap = new Map(canonical.fields.map((f) => [f.name, f]));
      const aimockFieldMap = new Map(aimock.fields.map((f) => [f.name, f]));

      // Fields in canonical but missing from aimock
      for (const [fieldName, fieldInfo] of canonicalFieldMap) {
        const aimockField = aimockFieldMap.get(fieldName);
        if (!aimockField) {
          drifts.push({
            severity: "CRITICAL",
            message: `${eventType}: field "${fieldName}" (${fieldInfo.optional ? "optional" : "required"}) exists in canonical but missing from aimock`,
          });
        }
      }

      // Fields in aimock but not in canonical
      for (const [fieldName] of aimockFieldMap) {
        if (!canonicalFieldMap.has(fieldName)) {
          drifts.push({
            severity: "WARNING",
            message: `${eventType}: field "${fieldName}" exists in aimock but not in canonical`,
          });
        }
      }

      // Optionality mismatches
      for (const [fieldName, canonicalField] of canonicalFieldMap) {
        const aimockField = aimockFieldMap.get(fieldName);
        if (aimockField && canonicalField.optional !== aimockField.optional) {
          drifts.push({
            severity: "WARNING",
            message: `${eventType}: field "${fieldName}" optionality mismatch — canonical: ${canonicalField.optional ? "optional" : "required"}, aimock: ${aimockField.optional ? "optional" : "required"}`,
          });
        }
      }
    }

    const criticals = drifts.filter((d) => d.severity === "CRITICAL");
    const warnings = drifts.filter((d) => d.severity === "WARNING");

    if (warnings.length > 0) {
      console.warn(
        `Field warnings:\n${warnings.map((d) => `  [${d.severity}] ${d.message}`).join("\n")}`,
      );
    }

    if (criticals.length > 0) {
      const report = criticals.map((d) => `  [${d.severity}] ${d.message}`).join("\n");
      expect(criticals, `Critical field drift:\n${report}`).toEqual([]);
    }
  });

  it("canonical schemas were parsed successfully", () => {
    // Sanity check: we should have parsed schemas for most event types
    expect(canonicalSchemas.size).toBeGreaterThan(20);

    // Spot-check a few known schemas
    const runStarted = canonicalSchemas.get("RUN_STARTED");
    expect(runStarted).toBeDefined();
    expect(runStarted!.fields.map((f) => f.name)).toContain("threadId");
    expect(runStarted!.fields.map((f) => f.name)).toContain("runId");

    const toolCallStart = canonicalSchemas.get("TOOL_CALL_START");
    expect(toolCallStart).toBeDefined();
    expect(toolCallStart!.fields.map((f) => f.name)).toContain("toolCallId");
    expect(toolCallStart!.fields.map((f) => f.name)).toContain("toolCallName");
  });

  it("aimock interfaces were parsed successfully", () => {
    expect(aimockInterfaces.size).toBeGreaterThan(20);

    const runStarted = aimockInterfaces.get("RUN_STARTED");
    expect(runStarted).toBeDefined();
    expect(runStarted!.fields.map((f) => f.name)).toContain("threadId");
    expect(runStarted!.fields.map((f) => f.name)).toContain("runId");
  });
});

// ---------------------------------------------------------------------------
// Parser regression guards — run without the ag-ui checkout, since they only
// exercise the parser against synthetic source.
// ---------------------------------------------------------------------------

describe("canonical field optionality", () => {
  it("reads optionality through a named schema alias", () => {
    // Upstream declares `metadata: OptionalMetadataSchema`, which carries no
    // literal `.optional()`. Reading the field text alone reported it as
    // required and marked every event type CRITICAL.
    const aliases = new Map([["OptionalMetadataSchema", "MetadataSchema.optional()"]]);
    const [field] = extractExtendFields("  metadata: OptionalMetadataSchema,", aliases);

    expect(field.name).toBe("metadata");
    expect(field.optional).toBe(true);
  });

  it("follows a chain of aliases", () => {
    const aliases = new Map([
      ["OuterSchema", "MiddleSchema"],
      ["MiddleSchema", "InnerSchema.optional()"],
    ]);
    const [field] = extractExtendFields("  nested: OuterSchema,", aliases);

    expect(field.optional).toBe(true);
  });

  it("keeps a required alias required", () => {
    // The resolver must not assume every alias is optional — a field aliased
    // to a non-optional schema is still genuine critical drift.
    const aliases = new Map([["MetadataSchema", "z.record(z.any())"]]);
    const [field] = extractExtendFields("  metadata: MetadataSchema,", aliases);

    expect(field.optional).toBe(false);
  });

  it("terminates on a self-referential alias", () => {
    const aliases = new Map([["LoopSchema", "LoopSchema"]]);
    const [field] = extractExtendFields("  looped: LoopSchema,", aliases);

    expect(field.optional).toBe(false);
  });

  it("reads optionality off a field definition split across lines", () => {
    // Upstream's `parentMessageId` chain. Matching line by line saw only `z`
    // and reported the field as required.
    const body = [
      "  toolCallId: z.string(),",
      "  parentMessageId: z",
      "    .string()",
      "    .nullable()",
      "    .optional()",
      "    .transform((v) => v ?? undefined),",
    ].join("\n");
    const fields = extractExtendFields(body, new Map());

    expect(fields.map((f) => f.name)).toEqual(["toolCallId", "parentMessageId"]);
    expect(fields.find((f) => f.name === "parentMessageId")!.optional).toBe(true);
    expect(fields.find((f) => f.name === "toolCallId")!.optional).toBe(false);
  });

  it("does not split on commas nested inside a field definition", () => {
    const fields = extractExtendFields('  role: z.enum(["user", "assistant"]),', new Map());

    expect(fields.map((f) => f.name)).toEqual(["role"]);
  });

  it("reads a field that follows a trailing comment", () => {
    // Upstream's STATE_DELTA. The comment trails the previous field, so after
    // the top-level comma split it heads the `subagentRunId` entry and hid the
    // field entirely — reported as aimock-only rather than canonical.
    const body = [
      "  delta: z.array(z.any()), // JSON Patch (RFC 6902)",
      "  subagentRunId: z.string().optional(),",
    ].join("\n");
    const fields = extractExtendFields(body, new Map());

    expect(fields.map((f) => f.name)).toEqual(["delta", "subagentRunId"]);
    expect(fields.find((f) => f.name === "subagentRunId")!.optional).toBe(true);
  });

  it("still reads inline optionality with no aliases in play", () => {
    const [optional] = extractExtendFields("  name: z.string().optional(),", new Map());
    const [required] = extractExtendFields("  messageId: z.string(),", new Map());

    expect(optional.optional).toBe(true);
    expect(required.optional).toBe(false);
  });
});
