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
  | "authentication"
  | "legacy-auth";

export interface ErrorDetails {
  message: string;
  type?: string | null;
  param?: string | null;
  /** Explicitly retain the native OpenAI param slot; omitted preserves legacy templates. */
  includeParam?: true;
  /** Normalized correlation metadata explicitly supplied by native header-policy rejects. */
  requestId?: string;
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

type OpenAIInnerDetails = Pick<
  ErrorDetails,
  "message" | "type" | "param" | "code" | "includeParam"
>;
type OpenAIInnerBody = {
  message: string;
  type?: string | null;
  param?: string | null;
  code?: string | null;
};
type ServiceValidationBody = { error: { message: string; type: string } };
type OpenRouterErrorBody = {
  error: { code: number; message: string; metadata?: Record<string, unknown> };
};

/** Common error owner; fixed native forms preserve caller signatures and ordering. */
export function buildOpenAIError(details: OpenAIInnerDetails): OpenAIInnerBody;
export function buildOpenAIError(
  purpose: "service-validation",
  details: { message: string },
): ServiceValidationBody;
export function buildOpenAIError(
  purpose: "openrouter-error",
  details: { code: number; message: string; metadata?: Record<string, unknown> },
): OpenRouterErrorBody;
export function buildOpenAIError(
  input: OpenAIInnerDetails | "service-validation" | "openrouter-error",
  details?: { message: string; code?: number; metadata?: Record<string, unknown> },
): OpenAIInnerBody | ServiceValidationBody | OpenRouterErrorBody {
  if (input === "service-validation") {
    if (!details) throw new TypeError("Missing service validation error details");
    return {
      error: { message: details.message, type: errorProfiles.openai.validationType },
    };
  }
  if (input === "openrouter-error") {
    if (!details || typeof details.code !== "number")
      throw new TypeError("Missing OpenRouter numeric error details");
    return {
      error: {
        code: details.code,
        message: details.message,
        ...(details.metadata !== undefined && { metadata: details.metadata }),
      },
    };
  }
  return {
    message: input.message,
    type: input.type,
    ...(input.includeParam === true ? { param: input.param ?? null } : {}),
    code: input.code,
  };
}

/** Native purpose templates preserve field presence and insertion order. No status or I/O. */
export function renderError(
  wire: ErrorWire,
  purpose: ErrorPurpose,
  details: ErrorDetails,
): { body: string; headers?: Record<string, string> } {
  if (wire === "ollama-embed") {
    return { body: JSON.stringify({ error: details.message }) };
  }
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
    case "authentication":
      if (wire === "messages") {
        return {
          body: JSON.stringify({
            type: "error",
            error: { type: "authentication_error", message: details.message },
          }),
        };
      }
      if (wire === "gemini") {
        return {
          body: JSON.stringify({
            error: { code: 401, message: details.message, status: "UNAUTHENTICATED" },
          }),
        };
      }
      return renderError(wire, "legacy-auth", details);
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
          ...(wire === "messages" && details.requestId !== undefined
            ? { request_id: details.requestId }
            : {}),
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
