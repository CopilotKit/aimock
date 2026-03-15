/**
 * Shape extraction, three-way comparison, severity classification, and reporting
 * for drift detection between SDK types, real API responses, and llmock output.
 */

// ---------------------------------------------------------------------------
// Shape types
// ---------------------------------------------------------------------------

export type ShapeNode =
  | { kind: "null" }
  | { kind: "string" }
  | { kind: "number" }
  | { kind: "boolean" }
  | { kind: "array"; element: ShapeNode | null }
  | { kind: "object"; fields: Record<string, ShapeNode> };

export type DriftSeverity = "critical" | "warning" | "info";

export interface ShapeDiff {
  path: string;
  severity: DriftSeverity;
  issue: string;
  expected: string; // from SDK types
  real: string; // from real API
  mock: string; // from llmock
}

export interface SSEEventShape {
  type: string;
  dataShape: ShapeNode;
}

// ---------------------------------------------------------------------------
// Shape extraction
// ---------------------------------------------------------------------------

export function extractShape(value: unknown): ShapeNode {
  if (value === null || value === undefined) {
    return { kind: "null" };
  }
  if (typeof value === "string") return { kind: "string" };
  if (typeof value === "number") return { kind: "number" };
  if (typeof value === "boolean") return { kind: "boolean" };
  if (Array.isArray(value)) {
    if (value.length === 0) return { kind: "array", element: null };
    // Merge shapes of all elements into a unified shape
    return { kind: "array", element: mergeShapes(value.map(extractShape)) };
  }
  if (typeof value === "object") {
    const fields: Record<string, ShapeNode> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      fields[k] = extractShape(v);
    }
    return { kind: "object", fields };
  }
  return { kind: "null" };
}

function mergeShapes(shapes: ShapeNode[]): ShapeNode {
  if (shapes.length === 0) return { kind: "null" };
  if (shapes.length === 1) return shapes[0];

  // If all same kind, merge recursively
  const kinds = new Set(shapes.map((s) => s.kind));
  if (kinds.size === 1) {
    const kind = shapes[0].kind;
    if (kind === "object") {
      const allFields = new Set<string>();
      for (const s of shapes) {
        if (s.kind === "object") {
          for (const k of Object.keys(s.fields)) allFields.add(k);
        }
      }
      const merged: Record<string, ShapeNode> = {};
      for (const field of allFields) {
        const fieldShapes = shapes
          .filter((s) => s.kind === "object" && field in s.fields)
          .map((s) => (s as { kind: "object"; fields: Record<string, ShapeNode> }).fields[field]);
        merged[field] = fieldShapes.length > 0 ? mergeShapes(fieldShapes) : { kind: "null" };
      }
      return { kind: "object", fields: merged };
    }
    if (kind === "array") {
      const elements = shapes
        .filter((s) => s.kind === "array" && s.element !== null)
        .map((s) => (s as { kind: "array"; element: ShapeNode | null }).element!);
      return { kind: "array", element: elements.length > 0 ? mergeShapes(elements) : null };
    }
    return shapes[0];
  }

  // Mixed kinds — return the first non-null shape
  return shapes.find((s) => s.kind !== "null") ?? { kind: "null" };
}

// ---------------------------------------------------------------------------
// Shape description (for reports)
// ---------------------------------------------------------------------------

export function describeShape(shape: ShapeNode | null): string {
  if (shape === null) return "<absent>";
  switch (shape.kind) {
    case "null":
      return "null";
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      return `array<${describeShape(shape.element)}>`;
    case "object": {
      const entries = Object.entries(shape.fields);
      if (entries.length === 0) return "object {}";
      if (entries.length <= 3) {
        const inner = entries.map(([k, v]) => `${k}: ${describeShape(v)}`).join(", ");
        return `object { ${inner} }`;
      }
      const first3 = entries
        .slice(0, 3)
        .map(([k, v]) => `${k}: ${describeShape(v)}`)
        .join(", ");
      return `object { ${first3}, ... +${entries.length - 3} }`;
    }
  }
}

// ---------------------------------------------------------------------------
// Two-way comparison
// ---------------------------------------------------------------------------

export function compareShapes(a: ShapeNode, b: ShapeNode, path = ""): ShapeDiff[] {
  const diffs: ShapeDiff[] = [];

  if (a.kind !== b.kind) {
    diffs.push({
      path: path || "(root)",
      severity: "critical",
      issue: `Type mismatch: ${a.kind} vs ${b.kind}`,
      expected: describeShape(a),
      real: describeShape(b),
      mock: "",
    });
    return diffs;
  }

  if (a.kind === "object" && b.kind === "object") {
    const allKeys = new Set([...Object.keys(a.fields), ...Object.keys(b.fields)]);
    for (const key of allKeys) {
      const childPath = path ? `${path}.${key}` : key;
      const inA = key in a.fields;
      const inB = key in b.fields;

      if (inA && !inB) {
        diffs.push({
          path: childPath,
          severity: "warning",
          issue: "Field in first but not second",
          expected: describeShape(a.fields[key]),
          real: "<absent>",
          mock: "",
        });
      } else if (!inA && inB) {
        diffs.push({
          path: childPath,
          severity: "warning",
          issue: "Field in second but not first",
          expected: "<absent>",
          real: describeShape(b.fields[key]),
          mock: "",
        });
      } else {
        diffs.push(...compareShapes(a.fields[key], b.fields[key], childPath));
      }
    }
  }

  if (a.kind === "array" && b.kind === "array") {
    if (a.element && b.element) {
      diffs.push(...compareShapes(a.element, b.element, `${path || "(root)"}[]`));
    }
  }

  return diffs;
}

// ---------------------------------------------------------------------------
// Three-way triangulation
// ---------------------------------------------------------------------------

/** Known intentional differences that should never trigger failures */
const ALLOWLISTED_PATHS = new Set([
  "usage",
  "usage.prompt_tokens",
  "usage.completion_tokens",
  "usage.total_tokens",
  "usage.input_tokens",
  "usage.output_tokens",
  "usage.completion_tokens_details",
  "usage.prompt_tokens_details",
  "usage.cache_creation_input_tokens",
  "usage.cache_read_input_tokens",
  "usageMetadata",
  "usageMetadata.promptTokenCount",
  "usageMetadata.candidatesTokenCount",
  "usageMetadata.totalTokenCount",
  "usageMetadata.cachedContentTokenCount",
  "system_fingerprint",
  "logprobs",
  "choices[].logprobs",
  "service_tier",
  "x_groq",
  // Gemini streaming metadata fields vary
  "modelVersion",
  "avgLogprobs",
]);

function isAllowlisted(path: string): boolean {
  if (ALLOWLISTED_PATHS.has(path)) return true;
  // Normalize array indices: choices[0].x → choices[].x
  const normalized = path.replace(/\[\d+\]/g, "[]");
  return ALLOWLISTED_PATHS.has(normalized);
}

export function triangulate(
  sdk: ShapeNode | null,
  real: ShapeNode | null,
  mock: ShapeNode | null,
): ShapeDiff[] {
  return triangulateAt("", sdk, real, mock);
}

function triangulateAt(
  path: string,
  sdk: ShapeNode | null,
  real: ShapeNode | null,
  mock: ShapeNode | null,
): ShapeDiff[] {
  const diffs: ShapeDiff[] = [];
  const displayPath = path || "(root)";

  const sdkKind = sdk?.kind ?? null;
  const realKind = real?.kind ?? null;
  const mockKind = mock?.kind ?? null;

  // All absent — nothing to compare
  if (!sdk && !real && !mock) return diffs;

  // Field in SDK + real but not mock → llmock drift (critical)
  if (sdk && real && !mock) {
    diffs.push({
      path: displayPath,
      severity: isAllowlisted(path) ? "info" : "critical",
      issue: "LLMOCK DRIFT — field in SDK + real API but missing from mock",
      expected: describeShape(sdk),
      real: describeShape(real),
      mock: "<absent>",
    });
    return diffs;
  }

  // Field in real but not SDK or mock → provider added something new
  if (!sdk && real && !mock) {
    diffs.push({
      path: displayPath,
      severity: isAllowlisted(path) ? "info" : "warning",
      issue: "PROVIDER ADDED FIELD — in real API but not in SDK or mock",
      expected: "<absent>",
      real: describeShape(real),
      mock: "<absent>",
    });
    return diffs;
  }

  // Field in SDK but not real → possibly deprecated/optional
  if (sdk && !real) {
    diffs.push({
      path: displayPath,
      severity: "info",
      issue: "SDK EXTRA — field in SDK but not in real API response (optional or deprecated)",
      expected: describeShape(sdk),
      real: "<absent>",
      mock: describeShape(mock),
    });
    return diffs;
  }

  // Field in mock but not real → mock has extra field
  if (!sdk && !real && mock) {
    diffs.push({
      path: displayPath,
      severity: "info",
      issue: "MOCK EXTRA FIELD — in mock but not in real API",
      expected: "<absent>",
      real: "<absent>",
      mock: describeShape(mock),
    });
    return diffs;
  }

  // All three present — check type mismatches
  if (real && mock && realKind !== mockKind) {
    // Allow null vs other type (optional fields)
    if (realKind !== "null" && mockKind !== "null") {
      diffs.push({
        path: displayPath,
        severity: isAllowlisted(path) ? "info" : "critical",
        issue: `TYPE MISMATCH between real API and mock: ${realKind} vs ${mockKind}`,
        expected: describeShape(sdk),
        real: describeShape(real),
        mock: describeShape(mock),
      });
      return diffs;
    }
  }

  if (sdk && real && sdkKind !== realKind) {
    if (sdkKind !== "null" && realKind !== "null") {
      diffs.push({
        path: displayPath,
        severity: isAllowlisted(path) ? "info" : "warning",
        issue: `SDK STALE — type mismatch between SDK and real API: ${sdkKind} vs ${realKind}`,
        expected: describeShape(sdk),
        real: describeShape(real),
        mock: describeShape(mock),
      });
    }
  }

  // Recurse into object fields
  if (realKind === "object" || sdkKind === "object" || mockKind === "object") {
    const sdkFields = sdk?.kind === "object" ? sdk.fields : {};
    const realFields = real?.kind === "object" ? real.fields : {};
    const mockFields = mock?.kind === "object" ? mock.fields : {};

    const allKeys = new Set([
      ...Object.keys(sdkFields),
      ...Object.keys(realFields),
      ...Object.keys(mockFields),
    ]);

    for (const key of allKeys) {
      const childPath = path ? `${path}.${key}` : key;
      diffs.push(
        ...triangulateAt(
          childPath,
          sdkFields[key] ?? null,
          realFields[key] ?? null,
          mockFields[key] ?? null,
        ),
      );
    }
  }

  // Recurse into array elements
  if (realKind === "array" || sdkKind === "array" || mockKind === "array") {
    const sdkElem = sdk?.kind === "array" ? sdk.element : null;
    const realElem = real?.kind === "array" ? real.element : null;
    const mockElem = mock?.kind === "array" ? mock.element : null;

    if (sdkElem || realElem || mockElem) {
      diffs.push(...triangulateAt(`${path || "(root)"}[]`, sdkElem, realElem, mockElem));
    }
  }

  return diffs;
}

// ---------------------------------------------------------------------------
// SSE event sequence comparison
// ---------------------------------------------------------------------------

export function compareSSESequences(
  sdk: SSEEventShape[],
  real: SSEEventShape[],
  mock: SSEEventShape[],
): ShapeDiff[] {
  const diffs: ShapeDiff[] = [];

  // Compare event type sequences
  const realTypes = real.map((e) => e.type);
  const mockTypes = mock.map((e) => e.type);

  // Check for event types in real but not mock
  const realTypeSet = new Set(realTypes);
  const mockTypeSet = new Set(mockTypes);

  // Transport-level SSE events that are not part of the response shape
  const SSE_TRANSPORT_EVENTS = new Set(["ping"]);

  for (const type of realTypeSet) {
    if (!mockTypeSet.has(type)) {
      diffs.push({
        path: `SSE:${type}`,
        severity: SSE_TRANSPORT_EVENTS.has(type) ? "info" : "critical",
        issue: SSE_TRANSPORT_EVENTS.has(type)
          ? `TRANSPORT EVENT — real API emits "${type}" (keepalive), mock does not`
          : `LLMOCK DRIFT — real API emits event type "${type}" but mock does not`,
        expected: type,
        real: type,
        mock: "<absent>",
      });
    }
  }

  for (const type of mockTypeSet) {
    if (!realTypeSet.has(type)) {
      diffs.push({
        path: `SSE:${type}`,
        severity: "info",
        issue: `MOCK EXTRA EVENT — mock emits event type "${type}" but real API does not`,
        expected: "<absent>",
        real: "<absent>",
        mock: type,
      });
    }
  }

  // Compare shapes of matching event types
  for (const type of realTypeSet) {
    if (!mockTypeSet.has(type)) continue;
    const realEvent = real.find((e) => e.type === type);
    const mockEvent = mock.find((e) => e.type === type);
    const sdkEvent = sdk.find((e) => e.type === type);

    if (realEvent && mockEvent) {
      const eventDiffs = triangulate(
        sdkEvent?.dataShape ?? null,
        realEvent.dataShape,
        mockEvent.dataShape,
      );
      for (const d of eventDiffs) {
        diffs.push({
          ...d,
          path: `SSE:${type}.${d.path}`,
        });
      }
    }
  }

  return diffs;
}

// ---------------------------------------------------------------------------
// Report formatting
// ---------------------------------------------------------------------------

export function formatDriftReport(context: string, diffs: ShapeDiff[]): string {
  if (diffs.length === 0) return `No drift detected: ${context}`;

  const lines: string[] = [];
  lines.push(`\nAPI DRIFT DETECTED: ${context}\n`);

  for (let i = 0; i < diffs.length; i++) {
    const d = diffs[i];
    lines.push(`  ${i + 1}. [${d.severity}] ${d.issue}`);
    lines.push(`     Path:    ${d.path}`);
    lines.push(`     SDK:     ${d.expected}`);
    lines.push(`     Real:    ${d.real}`);
    lines.push(`     Mock:    ${d.mock}`);
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Strict mode check
// ---------------------------------------------------------------------------

export function shouldFail(diffs: ShapeDiff[]): boolean {
  const strict = process.env.STRICT_DRIFT === "1";
  return diffs.some((d) => d.severity === "critical" || (strict && d.severity === "warning"));
}
