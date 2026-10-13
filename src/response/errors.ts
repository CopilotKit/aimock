import { errorProfiles, type ErrorWire } from "./profiles.js";

export type ErrorPurpose =
  | "validation"
  | "strict-miss"
  | "fixture-miss"
  | "thinking"
  | "fixture"
  | "tool-argument"
  | "misbehavior"
  | "unknown-response"
  | "transport-failure"
  | "route-failure"
  | "stream-failure"
  | "invalid-misbehavior-header"
  | "legacy-auth";

export interface ErrorDetails {
  message: string;
  type?: string | null;
  param?: string | null;
  code?: string | null;
  bodyCode?: number;
  status?: string | null;
  googleDetails?: {
    "@type": string;
    reason: string;
    domain: string;
    metadata: { code: string };
  }[];
}

/** Common inner OpenAI error; callers retain native event wrappers and defaults. */
export function buildOpenAIError(details: Pick<ErrorDetails, "message" | "type" | "code">): {
  message: string;
  type?: string | null;
  code?: string | null;
} {
  return { message: details.message, type: details.type, code: details.code };
}

/** Native purpose templates preserve field presence and insertion order. No status or I/O. */
export function renderError(
  wire: ErrorWire,
  purpose: ErrorPurpose,
  details: ErrorDetails,
): { body: string; headers?: Record<string, string> } {
  const profile = errorProfiles[wire];
  if (
    wire === "interactions" &&
    (purpose === "validation" ||
      purpose === "strict-miss" ||
      purpose === "fixture-miss" ||
      purpose === "fixture" ||
      purpose === "misbehavior" ||
      purpose === "unknown-response")
  ) {
    return {
      body: JSON.stringify({
        error: { code: details.code ?? "INVALID_ARGUMENT", message: details.message },
      }),
    };
  }
  switch (purpose) {
    case "legacy-auth":
      return {
        body: JSON.stringify({
          error: {
            message: details.message,
            type: "authentication_error",
            code: "invalid_api_key",
          },
        }),
      };
    case "stream-failure":
      return { body: JSON.stringify({ error: { message: details.message } }) };
    case "route-failure":
      return {
        body: JSON.stringify({ error: { message: details.message, type: details.type } }),
      };
    case "invalid-misbehavior-header":
      if (wire === "ollama") return { body: JSON.stringify({ error: details.message }) };
      if (wire === "cohere") return { body: JSON.stringify({ message: details.message }) };
      if (wire === "interactions") {
        return {
          body: JSON.stringify({ error: { code: details.code, message: details.message } }),
        };
      }
      if (wire === "gemini") {
        return {
          body: JSON.stringify({
            error: { code: 400, message: details.message, status: "INVALID_ARGUMENT" },
          }),
        };
      }
      if (wire === "messages") {
        return {
          body: JSON.stringify({
            type: "error",
            error: { type: profile.validationType, code: details.code, message: details.message },
          }),
        };
      }
      if (wire === "bedrock" || wire === "bedrock-converse") {
        return {
          body: JSON.stringify({ __type: "ValidationException", message: details.message }),
        };
      }
      return {
        body: JSON.stringify({
          error: { message: details.message, type: profile.validationType, code: details.code },
        }),
      };
    case "validation":
    case "strict-miss":
    case "fixture-miss":
      if (wire === "gemini") {
        return {
          body: JSON.stringify({
            error: { message: details.message, code: details.bodyCode, status: details.status },
          }),
        };
      }
      if (wire === "openai") {
        return {
          body: JSON.stringify({
            error: buildOpenAIError({
              ...details,
              type: details.type ?? profile.validationType,
            }),
          }),
        };
      }
      return {
        body: JSON.stringify({
          error: { message: details.message, type: details.type ?? profile.validationType },
        }),
      };
    case "thinking":
      return {
        body: JSON.stringify({
          type: "error",
          error: { type: details.type ?? profile.validationType, message: details.message },
        }),
      };
    case "fixture":
      if (wire === "gemini") {
        return {
          body: JSON.stringify({
            error: { code: details.bodyCode, message: details.message, status: details.status },
          }),
        };
      }
      if (wire === "openai") {
        return {
          body: JSON.stringify({
            error: {
              message: details.message,
              type: details.type ?? profile.fixtureType,
              param: details.param ?? null,
              code: details.code ?? null,
            },
          }),
        };
      }
      return {
        body: JSON.stringify({
          type: "error",
          error: { type: details.type ?? profile.fixtureType, message: details.message },
        }),
      };
    case "tool-argument":
      if (wire === "ollama") {
        return { body: JSON.stringify({ error: details.message, code: details.code }) };
      }
      if (wire === "interactions") {
        return {
          body: JSON.stringify({ error: { code: details.code, message: details.message } }),
        };
      }
      if (wire === "gemini") {
        return {
          body: JSON.stringify({
            error: {
              code: 500,
              message: details.message,
              status: "INTERNAL",
              details: details.googleDetails,
            },
          }),
        };
      }
      if (wire === "bedrock" || wire === "bedrock-converse") {
        return {
          body: JSON.stringify({
            __type: details.type ?? errorProfiles.bedrock.toolArgumentType,
            message: details.message,
            reason: details.code,
          }),
        };
      }
      if (wire === "messages") {
        return {
          body: JSON.stringify({
            type: "error",
            error: {
              type: details.type ?? profile.fixtureType,
              code: details.code,
              message: details.message,
            },
          }),
        };
      }
      return {
        body: JSON.stringify({
          error: {
            message: details.message,
            type: details.type ?? profile.fixtureType,
            code: details.code,
          },
        }),
      };
    case "misbehavior":
      if (wire === "openai") {
        return { body: JSON.stringify({ error: buildOpenAIError(details) }) };
      }
      if (wire === "gemini") {
        return {
          body: JSON.stringify({
            error: { code: details.bodyCode, message: details.message, status: details.status },
          }),
        };
      }
      if (wire === "cohere") {
        return { body: JSON.stringify({ message: details.message, code: details.code }) };
      }
      if (wire === "ollama") {
        return { body: JSON.stringify({ error: `${details.code}: ${details.message}` }) };
      }
      if (wire === "bedrock-converse") {
        return {
          body: JSON.stringify({
            __type: details.type,
            message: details.message,
            code: details.code,
          }),
          headers:
            details.type === undefined || details.type === null
              ? undefined
              : { "x-amzn-errortype": details.type },
        };
      }
      if (wire === "bedrock") {
        return {
          body: JSON.stringify({
            __type: details.type,
            code: details.code,
            message: details.message,
          }),
          headers:
            details.type === undefined || details.type === null
              ? undefined
              : { "x-amzn-errortype": details.type },
        };
      }
      return {
        body: JSON.stringify({
          type: "error",
          error: { type: details.type, code: details.code, message: details.message },
        }),
      };
    case "unknown-response":
      if (wire === "gemini") {
        return {
          body: JSON.stringify({
            error: { message: details.message, code: details.bodyCode, status: details.status },
          }),
        };
      }
      if (wire === "openai") {
        return {
          body: JSON.stringify({
            error: buildOpenAIError({ ...details, type: details.type ?? "server_error" }),
          }),
        };
      }
      return {
        body: JSON.stringify({
          error: { message: details.message, type: details.type ?? "server_error" },
        }),
      };
    case "transport-failure":
      return {
        body: JSON.stringify({
          error: { message: details.message, type: details.type ?? "proxy_error" },
        }),
      };
  }
}
