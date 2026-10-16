import type { IncomingHttpHeaders } from "node:http";

/** Inbound HTTP auth uses only provider-owned paths; shared routes stay legacy. */
export function authErrorDialectForPath(pathname: string): "messages" | "gemini" | "openai" {
  if (pathname === "/v1/messages" || pathname === "/v1/messages/count_tokens") return "messages";
  if (
    pathname.startsWith("/v1beta/") ||
    /^\/v1\/projects\/[^/]+\/locations\/[^/]+\/publishers\/google\//.test(pathname)
  )
    return "gemini";
  return "openai";
}

/** Shared catalog response dialect only; auth retains its pathname-selected dialect. */
export function isAnthropicModelRequest(headers: IncomingHttpHeaders): boolean {
  return (
    headers["anthropic-version"] !== undefined ||
    (headers["x-api-key"] !== undefined && headers.authorization === undefined)
  );
}

/** Static wire facts only. Status selection and transport behavior belong to callers. */
export const errorProfiles = {
  openai: { fixtureType: "server_error", validationType: "invalid_request_error" },
  messages: {
    fixtureType: "api_error",
    validationType: "invalid_request_error",
    requiredHeaders: ["anthropic-version"],
  },
  bedrock: {
    fixtureType: "api_error",
    validationType: "invalid_request_error",
    toolArgumentType: "InternalServerException",
  },
  "bedrock-converse": {
    fixtureType: "api_error",
    validationType: "invalid_request_error",
    toolArgumentType: "InternalServerException",
  },
  ollama: { fixtureType: "server_error", validationType: "invalid_request_error" },
  cohere: { fixtureType: "server_error", validationType: "invalid_request_error" },
  interactions: { fixtureType: "server_error", validationType: "invalid_request_error" },
  gemini: { fixtureType: "server_error", validationType: "invalid_request_error" },
} as const;

export type ErrorWire = keyof typeof errorProfiles;

/** Bedrock's body-level version and other wire families have no header requirement. */
export function missingRequiredHeader(
  wire: ErrorWire,
  headers: IncomingHttpHeaders,
): string | undefined {
  if (wire !== "messages") return;
  return errorProfiles.messages.requiredHeaders.find((name) => headers[name] === undefined);
}
