/**
 * Pure helpers for the Cohere live drift leg: chat-model selection and
 * infra-status classification.
 *
 * Extracted from cohere.drift.ts so the selection/classification logic is
 * unit-testable WITHOUT live credentials (the live describe block is
 * credential-gated and cannot run locally).
 */

/** Cohere REST base URL. */
export const COHERE_BASE_URL = "https://api.cohere.com";

/**
 * Environmental HTTP statuses that indicate a provider-side condition
 * (auth / out-of-credit / rate-limit / upstream outage) rather than a real
 * API-envelope drift. Mirrors the providers.ts InfraError classification:
 * 401|403 → stale-key, 429 → rate-limited, 5xx → infra-transient; 402 →
 * out-of-credit.
 *
 * The live leg converts these to an HONEST SKIP so a transient provider-side
 * condition never quarantines the drift collector and reds the PR. A real
 * shape drift (a 200 response with an unexpected envelope) is NEVER skipped.
 */
export function isInfraStatus(status: number): boolean {
  return status === 401 || status === 402 || status === 403 || status === 429 || status >= 500;
}

/** Minimal shape of a /v1/models listing entry we depend on. */
export interface CohereModelEntry {
  name?: string;
  is_deprecated?: boolean;
  endpoints?: string[];
}

/**
 * Select a currently-valid, non-deprecated Cohere chat model from a
 * `/v1/models?endpoint=chat` listing.
 *
 * Cohere retires model IDs on a schedule (e.g. `command-r-plus` was removed
 * 2026-04-04), so a hardcoded model name is a standing 404 / quarantine risk.
 * Self-selecting from the live listing makes the leg resilient to future
 * deprecations. Prefers a stable, widely-available default when present, else
 * falls back to the first non-deprecated chat model. Returns null when the
 * listing exposes no usable chat model.
 */
export function selectCohereChatModel(models: CohereModelEntry[]): string | null {
  const names = models
    .filter((m) => typeof m.name === "string" && m.is_deprecated !== true)
    .map((m) => m.name as string);
  const preferred = ["command-a-03-2025", "command-r-08-2024", "command-r7b-12-2024"];
  return preferred.find((p) => names.includes(p)) ?? names[0] ?? null;
}

/**
 * Cohere's documented "the model generated nothing usable" error types. Live
 * probes (2026-10-11) observed both as an HTTP 422 envelope with exactly
 * `{error_type, id, message}`: NO_VALID_RESPONSE_GENERATED for a plain
 * `Say hello` chat request, NO_TOOL_CALL_OR_RESPONSE_GENERATED for a
 * `tool_choice: REQUIRED` request. The same tool-request condition also
 * arrives mid-stream as a 200 SSE whose `message-end` carries
 * `finish_reason: "ERROR"`, `usage: {}` and that error type.
 */
export const COHERE_NO_GENERATION_ERROR_TYPES = [
  "NO_VALID_RESPONSE_GENERATED",
  "NO_TOOL_CALL_OR_RESPONSE_GENERATED",
] as const;
export type CohereNoGenerationErrorType = (typeof COHERE_NO_GENERATION_ERROR_TYPES)[number];

function isNoGenerationErrorType(value: unknown): value is CohereNoGenerationErrorType {
  return (COHERE_NO_GENERATION_ERROR_TYPES as readonly unknown[]).includes(value);
}

/** Codes the no-tools `Say hello` shape legs can receive. */
export const COHERE_SHAPE_LEG_NO_GENERATION = ["NO_VALID_RESPONSE_GENERATED"] as const;
/** Codes the K5 `tool_choice: REQUIRED` request can receive. */
export const COHERE_K5_NO_GENERATION = ["NO_TOOL_CALL_OR_RESPONSE_GENERATED"] as const;

/** An exact upstream no-generation 422 envelope, with the fields a skip reason cites. */
export interface CohereNoGeneration {
  errorType: CohereNoGenerationErrorType;
  id: string;
}

/**
 * Classify a live Cohere response as the exact upstream no-generation 422
 * envelope. Returns `{ errorType, id }` only for status 422 with a JSON object
 * body whose keys are exactly `error_type`, `id` and `message` (both strings
 * non-empty) and whose `error_type` is in `allowed`. Anything else — another
 * status, an extra or missing key, a non-string field, another error type, a
 * non-JSON or `null` body — returns null, so the caller keeps failing on it.
 *
 * `allowed` must name only the codes the request can produce: a request with
 * no tools passes `["NO_VALID_RESPONSE_GENERATED"]`; a tool request passes
 * `["NO_TOOL_CALL_OR_RESPONSE_GENERATED"]`.
 *
 * This is upstream model nondeterminism, not envelope drift: the same request
 * succeeds on the next send. Only the live leg may use it; the aimock leg
 * stays strict.
 */
export function cohereNoGenerationError(
  status: number,
  body: string,
  allowed: readonly CohereNoGenerationErrorType[],
): CohereNoGeneration | null {
  if (status !== 422) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "error_type,id,message") return null;
  if (typeof record.id !== "string" || record.id.length === 0) return null;
  if (typeof record.message !== "string" || record.message.length === 0) return null;
  if (!isNoGenerationErrorType(record.error_type)) return null;
  if (!allowed.includes(record.error_type)) return null;
  return { errorType: record.error_type, id: record.id };
}

/** Skip reason that cites the upstream code and response id. */
export function cohereNoGenerationSkipReason(outcomes: CohereNoGeneration[]): string {
  return `Cohere upstream generated nothing (${outcomes
    .map(({ errorType, id }) => `${errorType} id=${id}`)
    .join("; ")}); no success envelope to compare`;
}

/**
 * Classify a live Cohere SSE `message-end` delta as the exact mid-stream
 * no-generation terminal: keys exactly `finish_reason`, `usage`, `error`,
 * `error_type`, with `finish_reason === "ERROR"`, `usage` an empty object,
 * `error` a non-empty string and `error_type` in `allowed`. Returns false for
 * every other terminal.
 *
 * As with `cohereNoGenerationError`, `allowed` names only the codes the
 * request can produce (K5 passes `COHERE_K5_NO_GENERATION`, the no-tools
 * shape legs pass `COHERE_SHAPE_LEG_NO_GENERATION`).
 */
export function isCohereNoGenerationStreamEnd(
  delta: Record<string, unknown>,
  allowed: readonly CohereNoGenerationErrorType[],
): boolean {
  const keys = Object.keys(delta).sort();
  if (keys.join(",") !== "error,error_type,finish_reason,usage") return false;
  if (delta.finish_reason !== "ERROR") return false;
  if (!isNoGenerationErrorType(delta.error_type)) return false;
  if (!allowed.includes(delta.error_type)) return false;
  if (typeof delta.error !== "string" || delta.error.length === 0) return false;
  const usage = delta.usage;
  return (
    usage !== null &&
    typeof usage === "object" &&
    !Array.isArray(usage) &&
    Object.keys(usage).length === 0
  );
}
