import { timingSafeEqual } from "node:crypto";
import type * as http from "node:http";
import type * as net from "node:net";
import type { ApiKeyAuthConfig } from "./types.js";

export const INBOUND_API_KEY_HEADERS = [
  "authorization",
  "x-api-key",
  "x-goog-api-key",
  "api-key",
  "xi-api-key",
] as const;

const RECOGNIZED_HEADERS = new Set<string>(INBOUND_API_KEY_HEADERS);

export const API_KEY_ERROR_BODY = JSON.stringify({
  error: {
    message: "Invalid API key",
    type: "authentication_error",
    code: "invalid_api_key",
  },
});

/** @internal */
export interface ApiKeyPolicy {
  readonly enabled: boolean;
  readonly keys: readonly Buffer[];
}

/** @internal */
export interface ResolvedInboundAuth {
  readonly publicConfig?: ApiKeyAuthConfig;
  readonly policy: ApiKeyPolicy;
}

export interface AuthResult {
  readonly ok: boolean;
  readonly reason?: "missing" | "invalid" | "conflict";
}

const DISABLED_POLICY: ApiKeyPolicy = { enabled: false, keys: [] };
const authenticatedRequests = new WeakSet<http.IncomingMessage>();
const OWS_EDGES = /^[ \t]+|[ \t]+$/g;

function fail(label: string, suffix: string): never {
  throw new Error(`${label}${suffix}`);
}

function hasControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function normalizeKey(value: unknown, label: string): string {
  if (typeof value !== "string") fail(label, " must be a string");
  const normalized = value.replace(OWS_EDGES, "");
  if (normalized.length === 0) fail(label, " must not be empty");
  if (hasControl(normalized)) fail(label, " must not contain control characters");
  return normalized;
}

/** Parse a public auth source once and construct its private server policy. */
export function resolveInboundAuth(source: { value: unknown; label: string }): ResolvedInboundAuth {
  if (source.value === undefined) return { policy: DISABLED_POLICY };
  if (source.value === null || typeof source.value !== "object" || Array.isArray(source.value)) {
    fail(source.label, " must be an object");
  }
  const apiKeys = (source.value as { apiKeys?: unknown }).apiKeys;
  if (!Array.isArray(apiKeys)) fail(`${source.label}.apiKeys`, " must be an array");
  if (apiKeys.length === 0) fail(`${source.label}.apiKeys`, " must not be empty");
  const keys = apiKeys.map((value, index) =>
    normalizeKey(value, `${source.label}.apiKeys[${index}]`),
  );
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) fail(source.label, " must not contain duplicate API keys");
    seen.add(key);
  }
  return {
    publicConfig: { apiKeys: keys },
    policy: { enabled: true, keys: keys.map((key) => Buffer.from(key, "utf8")) },
  };
}

/** Select configuration without parsing it, so an environment override bypasses malformed JSON auth. */
export function selectInboundAuthSource(
  configAuth: unknown,
  env: NodeJS.ProcessEnv = process.env,
): { value: unknown; label: string } {
  if (Object.prototype.hasOwnProperty.call(env, "AIMOCK_API_KEYS")) {
    return { value: { apiKeys: (env.AIMOCK_API_KEYS ?? "").split(",") }, label: "AIMOCK_API_KEYS" };
  }
  return { value: configAuth, label: "aimock.json.auth" };
}

export function isRecognizedApiKeyHeader(name: string): boolean {
  return RECOGNIZED_HEADERS.has(name.toLowerCase());
}

function rawCandidates(req: http.IncomingMessage): {
  candidates?: string[];
  reason?: "missing" | "invalid";
} {
  const candidates: string[] = [];
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    const name = req.rawHeaders[index];
    const value = req.rawHeaders[index + 1] ?? "";
    const lower = name.toLowerCase();
    if (!isRecognizedApiKeyHeader(lower)) continue;
    if (hasControl(value)) return { reason: "invalid" };
    if (lower === "authorization") {
      const match = /^(?:Bearer|Key)[ \t]+(.+)$/i.exec(value.replace(OWS_EDGES, ""));
      if (!match) return { reason: "invalid" };
      const candidate = match[1].replace(OWS_EDGES, "");
      if (candidate.length === 0 || hasControl(candidate)) return { reason: "invalid" };
      candidates.push(candidate);
    } else {
      const candidate = value.replace(OWS_EDGES, "");
      if (candidate.length === 0) return { reason: "invalid" };
      candidates.push(candidate);
    }
  }
  return candidates.length > 0 ? { candidates } : { reason: "missing" };
}

function matchingIndex(candidate: string, keys: readonly Buffer[]): number | undefined {
  const encoded = Buffer.from(candidate, "utf8");
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (encoded.length === key.length && timingSafeEqual(encoded, key)) return index;
  }
  return undefined;
}

export function validateRequestApiKey(req: http.IncomingMessage, policy: ApiKeyPolicy): AuthResult {
  if (!policy.enabled) return { ok: true };
  const extracted = rawCandidates(req);
  if (!extracted.candidates) return { ok: false, reason: extracted.reason };
  let resolved: number | undefined;
  for (const candidate of extracted.candidates) {
    const index = matchingIndex(candidate, policy.keys);
    if (index === undefined) return { ok: false, reason: "invalid" };
    if (resolved !== undefined && resolved !== index) return { ok: false, reason: "conflict" };
    resolved = index;
  }
  return { ok: true };
}

/** @internal Opaque egress marker; it deliberately carries no key material. */
export function markAuthenticatedRequest(req: http.IncomingMessage, policy: ApiKeyPolicy): void {
  if (policy.enabled) authenticatedRequests.add(req);
}

/** @internal Used by egress paths to select safe credential handling. */
export function isAuthenticatedRequest(req: http.IncomingMessage): boolean {
  return authenticatedRequests.has(req);
}

export function writeApiKeyHttpRejection(
  res: http.ServerResponse,
  setCorsHeaders: (res: http.ServerResponse) => void,
): void {
  setCorsHeaders(res);
  res.writeHead(401, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(API_KEY_ERROR_BODY),
    "WWW-Authenticate": 'Bearer realm="aimock"',
  });
  res.end(API_KEY_ERROR_BODY);
}

export function writeApiKeyUpgradeRejection(socket: net.Socket): void {
  socket.write(
    [
      "HTTP/1.1 401 Unauthorized",
      "Content-Type: application/json",
      `Content-Length: ${Buffer.byteLength(API_KEY_ERROR_BODY)}`,
      'WWW-Authenticate: Bearer realm="aimock"',
      "Connection: close",
      "",
      API_KEY_ERROR_BODY,
    ].join("\r\n"),
  );
  socket.destroy();
}
