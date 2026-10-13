import type { IncomingHttpHeaders } from "node:http";

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
