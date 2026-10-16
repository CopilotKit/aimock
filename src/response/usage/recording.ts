import type { RecordProviderKey, ResponseOverrides } from "../../types.js";
import { capture as captureAnthropicUsage } from "./codecs/anthropic.js";
import { sanitizeUsage } from "./fields.js";

type BodyFamily =
  | "openai"
  | "anthropic"
  | "gemini"
  | "ollama"
  | "cohere"
  | "bedrock-invoke"
  | "bedrock-converse"
  | "interactions"
  | "transcription"
  | "stream-dispatch"
  | "final";
interface CaptureContext {
  provider?: RecordProviderKey;
  contentType?: string;
  /** Recognition remains with content readers; operation does not override their family. */
  operation?: string;
  family: BodyFamily;
  previous?: Record<string, unknown>;
  observation: unknown;
}
type CaptureMode =
  | "last-nonempty"
  | "transcription-object"
  | "sanitize"
  | "anthropic-merge"
  | "omit";

/** Content-type precedence matches the content dispatcher, including its SSE fallback. */
function selectedFamily(context: CaptureContext): BodyFamily | undefined {
  if (context.family !== "stream-dispatch") return context.family;
  const ct = context.contentType?.toLowerCase() ?? "";
  if (ct.includes("application/vnd.amazon.eventstream")) return "bedrock-invoke";
  if (ct.includes("application/x-ndjson")) return "ollama";
  if (!ct.includes("text/event-stream")) return undefined;
  switch (context.provider) {
    case "anthropic":
    case "bedrock":
      return "anthropic";
    case "gemini":
    case "vertexai":
      return "gemini";
    case "gemini-interactions":
      return "interactions";
    case "cohere":
      return "cohere";
    default:
      return "openai";
  }
}

function mode(
  context: CaptureContext,
  stage: "stream" | "nonstream" | "collapsed" | "final",
): CaptureMode {
  if (stage === "final") return "sanitize";
  switch (selectedFamily(context)) {
    case "openai":
      return stage === "nonstream" ? "sanitize" : "last-nonempty";
    case "transcription":
      return stage === "nonstream" ? "transcription-object" : "last-nonempty";
    case "anthropic":
    case "bedrock-invoke":
      return "anthropic-merge";
    // These families intentionally do not acquire usage during extraction.
    case "gemini":
    case "ollama":
    case "cohere":
    case "bedrock-converse":
    case "interactions":
    default:
      return "omit";
  }
}

/** @internal Capture preserves the recognized wire's existing recording contract. */
export function captureUsage(
  context: CaptureContext & { family: "transcription"; stage: "nonstream" },
): Record<string, unknown> | undefined;
export function captureUsage(
  context: CaptureContext & { stage: "final" | "nonstream" },
): ResponseOverrides["usage"] | undefined;
export function captureUsage(
  context: CaptureContext & { stage: "stream" | "collapsed" },
): Record<string, unknown> | undefined;
export function captureUsage(
  context: CaptureContext & { stage: "stream" | "nonstream" | "collapsed" | "final" },
): Record<string, unknown> | undefined {
  const { observation, previous, stage } = context;
  // Final fixture sanitation receives raw usage; other stages receive the
  // recognized envelope/event, leaving body recognition with the content reader.
  const raw = stage === "final" ? observation : (observation as { usage?: unknown } | null)?.usage;
  switch (mode(context, stage)) {
    case "sanitize":
      return sanitizeUsage(raw);
    case "last-nonempty":
      return raw && typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw).length > 0
        ? (raw as Record<string, unknown>)
        : previous;
    case "transcription-object":
      // Nonstream transcription historically retains arrays and empty objects;
      // its discriminator contract is separate from chat fixture sanitation.
      return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
    case "anthropic-merge": {
      if (stage !== "stream") return captureAnthropicUsage(previous, raw);
      const event = observation as { type?: unknown; message?: { usage?: unknown } } | null;
      if (event?.type === "message_start")
        return captureAnthropicUsage(previous, event.message?.usage, "start");
      if (event?.type === "message_delta") return captureAnthropicUsage(previous, raw, "delta");
      return previous;
    }
    case "omit":
      return undefined;
  }
}
