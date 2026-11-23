import type { ResponseOverrides } from "../../types.js";

type UsageFieldDefinition =
  | { readonly kind: "number" }
  | { readonly kind: "boolean" }
  | { readonly kind: "object" | "number-or-object"; readonly numericMembers: readonly string[] };

/** Shared classification; validation checks only the documented inner members. */
const USAGE_FIELD_DEFINITIONS = {
  cache_creation: {
    kind: "number-or-object",
    numericMembers: ["ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"],
  },
  cost_details: {
    kind: "object",
    numericMembers: [
      "upstream_inference_cost",
      "upstream_inference_prompt_cost",
      "upstream_inference_completions_cost",
    ],
  },
  prompt_tokens_details: {
    kind: "object",
    numericMembers: ["cached_tokens", "cache_write_tokens", "audio_tokens"],
  },
  completion_tokens_details: { kind: "object", numericMembers: ["reasoning_tokens"] },
  is_byok: { kind: "boolean" },
} as const satisfies Readonly<Record<string, UsageFieldDefinition>>;

const NUMERIC_FIELD: UsageFieldDefinition = { kind: "number" };

/** Unknown keys, including prototype names, retain numeric-scalar classification. */
export function getUsageFieldDefinition(key: string): UsageFieldDefinition {
  return Object.hasOwn(USAGE_FIELD_DEFINITIONS, key)
    ? USAGE_FIELD_DEFINITIONS[key as keyof typeof USAGE_FIELD_DEFINITIONS]
    : NUMERIC_FIELD;
}

/** Recording retains finite numbers, including members of recognized usage objects. */
export function sanitizeUsage(raw: unknown): ResponseOverrides["usage"] | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (val === undefined || val === null) continue;
    const definition = getUsageFieldDefinition(key);
    if (definition.kind === "number-or-object" && typeof val === "number") {
      if (Number.isFinite(val)) out[key] = val;
      continue;
    }
    if (definition.kind === "object" || definition.kind === "number-or-object") {
      if (typeof val !== "object" || val === null || Array.isArray(val)) continue;
      const inner: Record<string, unknown> = {};
      for (const [innerKey, innerVal] of Object.entries(val as Record<string, unknown>)) {
        if (typeof innerVal === "number" && Number.isFinite(innerVal)) {
          if (key === "cache_creation") {
            // Cache members parsed from JSON include own names such as __proto__.
            Object.defineProperty(inner, innerKey, {
              value: innerVal,
              enumerable: true,
              configurable: true,
              writable: true,
            });
          } else inner[innerKey] = innerVal;
        }
      }
      if (Object.keys(inner).length > 0) out[key] = inner;
      continue;
    }
    if (definition.kind === "boolean") {
      if (typeof val === "boolean") out[key] = val;
      continue;
    }
    if (typeof val === "number" && Number.isFinite(val)) out[key] = val;
  }
  return Object.keys(out).length > 0 ? (out as ResponseOverrides["usage"]) : undefined;
}
