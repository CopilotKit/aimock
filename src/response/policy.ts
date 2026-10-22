import type { IncomingHttpHeaders } from "node:http";
import type { AimockPolicy, HandlerDefaults } from "../types.js";

/** Entry points choose whether a failed parse warns or becomes a CLI usage error. */
export function parsePolicyEntry(
  key: string,
  value: unknown,
):
  | { ok: true; key: "requiredHeaders"; value: "off" | "enforce" }
  | { ok: true; key: "authErrors" | "modelCatalog"; value: "legacy" | "native" }
  | { ok: false; reason: string } {
  if (key === "requiredHeaders") {
    const normalized = typeof value === "string" ? value.toLowerCase() : undefined;
    if (normalized === "off" || normalized === "enforce") {
      return { ok: true, key, value: normalized };
    }
    return { ok: false, reason: 'expected "off" or "enforce".' };
  }
  if (key === "authErrors" || key === "modelCatalog") {
    const normalized = typeof value === "string" ? value.toLowerCase() : undefined;
    if (normalized === "legacy" || normalized === "native") {
      return { ok: true, key, value: normalized };
    }
    return { ok: false, reason: 'expected "legacy" or "native".' };
  }
  return { ok: false, reason: "unknown policy key." };
}

/** Store one parsed entry without widening either key's value type. */
export function assignPolicyEntry(
  target: AimockPolicy,
  entry: Exclude<ReturnType<typeof parsePolicyEntry>, { ok: false }>,
): void {
  if (entry.key === "requiredHeaders") target.requiredHeaders = entry.value;
  else target[entry.key] = entry.value;
}

/** Parse each programmatic entry independently without changing the caller's object. */
export function parsePolicy(value: unknown, warn: (message: string) => void): AimockPolicy {
  const result: AimockPolicy = {};
  if (value === undefined) return result;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    warn("Ignoring policy: expected an object.");
    return result;
  }
  for (const [key, entry] of Object.entries(value)) {
    const parsed = parsePolicyEntry(key, entry);
    if (parsed.ok) assignPolicyEntry(result, parsed);
    else warn(`Ignoring policy.${key}: ${parsed.reason}`);
  }
  return result;
}

/** A bad header entry does not erase a prior valid entry or other policy keys. */
export function parsePolicyHeader(
  rawHeaders: IncomingHttpHeaders | undefined,
  warn: (message: string) => void,
): AimockPolicy {
  const result: AimockPolicy = {};
  const header = rawHeaders?.["x-aimock-policy"];
  if (header === undefined) return result;
  const text = Array.isArray(header) ? header.join(",") : header;
  for (const rawEntry of text.split(",")) {
    const entry = rawEntry.trim();
    const separator = entry.indexOf("=");
    if (separator < 0) {
      warn(`Ignoring policy entry ${JSON.stringify(entry)}: expected key=value.`);
      continue;
    }
    const key = entry.slice(0, separator);
    const parsed = parsePolicyEntry(key, entry.slice(separator + 1));
    if (parsed.ok) assignPolicyEntry(result, parsed);
    else warn(`Ignoring policy.${key}: ${parsed.reason}`);
  }
  return result;
}

/** Resolve from the direct-handler input, preserving the independent legacy strict bit. */
export function resolvePolicy(
  defaults: HandlerDefaults,
  rawHeaders?: IncomingHttpHeaders,
  warn: (message: string) => void = (message) => defaults.logger.warn(message),
) {
  const strict = resolveStrictMode(defaults.strict, rawHeaders);
  const server = parsePolicy(defaults.policy, warn);
  const request = parsePolicyHeader(rawHeaders, warn);
  return Object.freeze({
    strict,
    requiredHeaders: request.requiredHeaders ?? server.requiredHeaders ?? "off",
    authErrors: request.authErrors ?? server.authErrors ?? "legacy",
    modelCatalog: request.modelCatalog ?? server.modelCatalog ?? "legacy",
  });
}

/** Preserve the legacy request strict header grammar and server fallback. */
export function resolveStrictMode(
  serverDefault: boolean | undefined,
  rawHeaders?: IncomingHttpHeaders,
): boolean {
  if (rawHeaders) {
    const header = rawHeaders["x-aimock-strict"];
    const rawVal =
      typeof header === "string" ? header : Array.isArray(header) ? header[0] : undefined;
    if (typeof rawVal === "string") {
      const val = rawVal.trim().toLowerCase();
      if (val === "true" || val === "1") return true;
      if (val === "false" || val === "0") return false;
    }
  }
  return serverDefault ?? false;
}

/** Journal fields retain their existing omitted-versus-overridden shape. */
export function strictOverrideField(
  serverDefault: boolean | undefined,
  rawHeaders?: IncomingHttpHeaders,
): { strictOverride?: boolean } {
  const effective = resolveStrictMode(serverDefault, rawHeaders);
  if (effective !== (serverDefault ?? false)) {
    return { strictOverride: effective };
  }
  return {};
}

/** Named legacy decisions share one header read at the caller's existing site. */
export function resolveRequestDecisions(
  serverDefault: boolean | undefined,
  rawHeaders?: IncomingHttpHeaders,
) {
  const strict = resolveStrictMode(serverDefault, rawHeaders);
  return Object.freeze({
    strict,
    fixtureMiss: strict,
    upstream: !strict,
    reasoningSuppression: strict,
    thinkingRejection: strict,
    mcpRecordingStrict: strict,
    strictOverride: strict !== (serverDefault ?? false) ? strict : undefined,
  });
}
