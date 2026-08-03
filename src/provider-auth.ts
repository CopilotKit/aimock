import type { RecordProviderKey } from "./types.js";

/**
 * Default marker prefix identifying a "dummy" credential that a caller sends
 * only to satisfy an SDK's non-empty API-key requirement (e.g. `sk-aimock-...`).
 * A caller credential that is absent OR begins with this prefix is treated as a
 * placeholder that aimock is free to override with its own built-in upstream key.
 * A caller credential that does NOT begin with this prefix is treated as a real
 * key and forwarded verbatim (the caller overrides aimock).
 *
 * Overridable via the `AIMOCK_DUMMY_KEY_MARKER` env var for setups that mint
 * placeholder keys under a different prefix.
 */
export const DEFAULT_DUMMY_KEY_MARKER = "sk-aimock-";

/** Resolve the active dummy-key marker, honoring the env override. */
export function getDummyKeyMarker(): string {
  const override = process.env.AIMOCK_DUMMY_KEY_MARKER;
  return override && override.length > 0 ? override : DEFAULT_DUMMY_KEY_MARKER;
}

/**
 * How a given provider carries its API credential on the wire. aimock injects
 * its built-in key using the provider's native scheme so the upstream accepts
 * it. Providers whose auth is a signed/exchanged credential (Bedrock SigV4,
 * Vertex AI OAuth) are deliberately absent — those are NOT simple static-key
 * schemes, so aimock never rewrites their auth and always forwards the caller's
 * credential unchanged.
 *
 * Scheme kinds (all static long-lived keys):
 *   - bearer          `Authorization: Bearer <key>`  (OpenAI, OpenRouter, Cohere, Grok/xAI, Ollama)
 *   - fal-key         `Authorization: Key <key>`     (fal.ai — note the `Key ` prefix, NOT `Bearer`)
 *   - x-api-key       `x-api-key: <key>`             (Anthropic)
 *   - x-goog-api-key  `x-goog-api-key: <key>`        (Gemini, Gemini Interactions, Veo)
 *   - api-key         `api-key: <key>`               (Azure OpenAI static-key auth)
 *   - xi-api-key      `xi-api-key: <key>`            (ElevenLabs)
 *
 * Note on Azure: Azure OpenAI also supports Microsoft Entra ID `Authorization:
 * Bearer <token>` OAuth. aimock only ever injects the static `api-key` header,
 * and a real Entra bearer token from the caller is never dummy-prefixed, so it
 * is always forwarded verbatim (the caller overrides aimock).
 */
export type AuthScheme =
  | { kind: "bearer" } // Authorization: Bearer <key>
  | { kind: "fal-key" } // Authorization: Key <key>
  | { kind: "x-api-key" } // x-api-key: <key>
  | { kind: "x-goog-api-key" } // x-goog-api-key: <key>
  | { kind: "api-key" } // api-key: <key>
  | { kind: "xi-api-key" }; // xi-api-key: <key>

const PROVIDER_AUTH_SCHEMES: Partial<Record<RecordProviderKey, AuthScheme>> = {
  // Bearer-token providers.
  openai: { kind: "bearer" },
  openrouter: { kind: "bearer" },
  cohere: { kind: "bearer" },
  grok: { kind: "bearer" }, // xAI
  ollama: { kind: "bearer" }, // Ollama Cloud / bearer-gated Ollama servers
  // Anthropic.
  anthropic: { kind: "x-api-key" },
  // Google (Gemini + Veo) use the x-goog-api-key header scheme.
  gemini: { kind: "x-goog-api-key" },
  "gemini-interactions": { kind: "x-goog-api-key" },
  veo: { kind: "x-goog-api-key" },
  // Azure OpenAI static-key auth.
  azure: { kind: "api-key" },
  // ElevenLabs.
  elevenlabs: { kind: "xi-api-key" },
  // fal.ai — uses the `Key ` prefix on Authorization, NOT `Bearer `.
  fal: { kind: "fal-key" },
};

export function hasStaticProviderAuthScheme(providerKey: RecordProviderKey): boolean {
  return PROVIDER_AUTH_SCHEMES[providerKey] !== undefined;
}

/** Force a known provider credential onto an already-scrubbed outbound map. */
export function applyConfiguredProviderAuth(
  forwardHeaders: Record<string, string>,
  target: URL,
  providerKey: RecordProviderKey,
  providerCredential: string,
): boolean {
  void target;
  const scheme = PROVIDER_AUTH_SCHEMES[providerKey];
  if (!scheme) return false;
  switch (scheme.kind) {
    case "bearer":
      takeHeader(forwardHeaders, "authorization");
      forwardHeaders.Authorization = `Bearer ${providerCredential}`;
      break;
    case "fal-key":
      takeHeader(forwardHeaders, "authorization");
      forwardHeaders.Authorization = `Key ${providerCredential}`;
      break;
    default:
      takeHeader(forwardHeaders, authHeaderName(scheme));
      forwardHeaders[authHeaderName(scheme)] = providerCredential;
  }
  return true;
}

/**
 * Case-insensitively delete a header from a forward-header map, returning the
 * value that was present (if any). Header maps preserve the original casing of
 * incoming headers, so we can't assume a canonical key.
 */
function takeHeader(headers: Record<string, string>, name: string): string | undefined {
  const lowerName = name.toLowerCase();
  let found: string | undefined;
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowerName) {
      found = headers[key];
      delete headers[key];
    }
  }
  return found;
}

/**
 * Extract the caller's credential value for a given auth scheme from the
 * forwarded headers, if present. For bearer, strips the `Bearer ` prefix.
 */
function readCallerCredential(
  headers: Record<string, string>,
  scheme: AuthScheme,
): string | undefined {
  if (scheme.kind === "bearer" || scheme.kind === "fal-key") {
    const raw = scanHeader(headers, "authorization");
    if (raw === undefined) return undefined;
    // Strip the scheme prefix (`Bearer ` for bearer, `Key ` for fal) if present,
    // otherwise treat the whole value as the credential.
    const prefix = scheme.kind === "fal-key" ? "Key" : "Bearer";
    const match = new RegExp(`^\\s*${prefix}\\s+(.+)$`, "i").exec(raw);
    return match ? match[1].trim() : raw.trim();
  }
  return scanHeader(headers, authHeaderName(scheme));
}

/**
 * The wire header name a non-Authorization scheme carries its credential in.
 * (bearer/fal-key both use `Authorization` and are handled separately.)
 */
function authHeaderName(scheme: AuthScheme): string {
  switch (scheme.kind) {
    case "x-api-key":
      return "x-api-key";
    case "x-goog-api-key":
      return "x-goog-api-key";
    case "api-key":
      return "api-key";
    case "xi-api-key":
      return "xi-api-key";
    case "bearer":
    case "fal-key":
      return "authorization";
  }
}

/** Case-insensitive header lookup that does not mutate the map. */
function scanHeader(headers: Record<string, string>, name: string): string | undefined {
  const lowerName = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowerName) return headers[key];
  }
  return undefined;
}

/**
 * Decide whether aimock should override the caller's credential with its own
 * built-in key. Override when the caller sent no credential OR sent a dummy
 * placeholder (prefixed with the active marker). A real caller key is left
 * untouched so the caller can always override aimock.
 */
function shouldOverride(callerCredential: string | undefined, marker: string): boolean {
  if (callerCredential === undefined || callerCredential.length === 0) return true;
  return callerCredential.startsWith(marker);
}

/**
 * Inject aimock's built-in upstream credential into the forwarded headers when
 * appropriate (opt-in, backward-compatible). Mutates `forwardHeaders` in place
 * and may mutate `target` (query-param schemes; none currently).
 *
 * Precedence:
 *   - No built-in key configured for this provider    → no-op (forward verbatim).
 *   - Provider not a static-key scheme                → no-op (Bedrock SigV4 / Vertex AI OAuth).
 *   - Caller credential absent or dummy-prefixed      → inject built-in key.
 *   - Caller credential is a real key                 → forward it unchanged.
 *
 * @param forwardHeaders headers already built by buildForwardHeaders(req)
 * @param target upstream URL (reserved for query-param auth schemes)
 * @param providerKey which provider this request is routed to
 * @param builtinKey aimock's configured key for this provider (if any)
 */
export function applyProviderAuth(
  forwardHeaders: Record<string, string>,
  target: URL,
  providerKey: RecordProviderKey,
  builtinKey: string | undefined,
): void {
  void target; // reserved for future query-param schemes (e.g. Gemini ?key=)
  if (!builtinKey) return; // feature inert for this provider

  const scheme = PROVIDER_AUTH_SCHEMES[providerKey];
  if (!scheme) return; // signed/OAuth provider — never rewrite auth

  const marker = getDummyKeyMarker();
  const callerCredential = readCallerCredential(forwardHeaders, scheme);
  if (!shouldOverride(callerCredential, marker)) return; // caller sent a real key

  // Strip any existing auth headers for this scheme (across casings) before
  // setting aimock's key, so a dummy caller key can't linger alongside ours.
  switch (scheme.kind) {
    case "bearer":
      takeHeader(forwardHeaders, "authorization");
      forwardHeaders["Authorization"] = `Bearer ${builtinKey}`;
      break;
    case "fal-key":
      takeHeader(forwardHeaders, "authorization");
      forwardHeaders["Authorization"] = `Key ${builtinKey}`;
      break;
    case "x-api-key":
      takeHeader(forwardHeaders, "x-api-key");
      forwardHeaders["x-api-key"] = builtinKey;
      break;
    case "x-goog-api-key":
      takeHeader(forwardHeaders, "x-goog-api-key");
      forwardHeaders["x-goog-api-key"] = builtinKey;
      break;
    case "api-key":
      takeHeader(forwardHeaders, "api-key");
      forwardHeaders["api-key"] = builtinKey;
      break;
    case "xi-api-key":
      takeHeader(forwardHeaders, "xi-api-key");
      forwardHeaders["xi-api-key"] = builtinKey;
      break;
  }
}

/**
 * Read per-provider built-in keys from the environment. Returns undefined when
 * no provider key is configured so the feature stays fully inert by default.
 *
 * Each wired static-key provider reads `AIMOCK_PROVIDER_<PROVIDER>_KEY`. An
 * empty-string value is treated as unset (existing truthiness pattern), keeping
 * the feature inert. `gemini-interactions` is not read here: it reuses the
 * Gemini key via the lookup-key remap in `proxyAndRecord`. Signed/OAuth
 * providers (`bedrock`, `vertexai`) have no env var — aimock never rewrites
 * their auth.
 */
export function readProviderKeysFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Partial<Record<RecordProviderKey, string>> | undefined {
  const keys: Partial<Record<RecordProviderKey, string>> = {};
  if (env.AIMOCK_PROVIDER_OPENAI_KEY) keys.openai = env.AIMOCK_PROVIDER_OPENAI_KEY;
  if (env.AIMOCK_PROVIDER_ANTHROPIC_KEY) keys.anthropic = env.AIMOCK_PROVIDER_ANTHROPIC_KEY;
  if (env.AIMOCK_PROVIDER_GEMINI_KEY) keys.gemini = env.AIMOCK_PROVIDER_GEMINI_KEY;
  if (env.AIMOCK_PROVIDER_OPENROUTER_KEY) keys.openrouter = env.AIMOCK_PROVIDER_OPENROUTER_KEY;
  if (env.AIMOCK_PROVIDER_COHERE_KEY) keys.cohere = env.AIMOCK_PROVIDER_COHERE_KEY;
  if (env.AIMOCK_PROVIDER_GROK_KEY) keys.grok = env.AIMOCK_PROVIDER_GROK_KEY;
  if (env.AIMOCK_PROVIDER_OLLAMA_KEY) keys.ollama = env.AIMOCK_PROVIDER_OLLAMA_KEY;
  if (env.AIMOCK_PROVIDER_VEO_KEY) keys.veo = env.AIMOCK_PROVIDER_VEO_KEY;
  if (env.AIMOCK_PROVIDER_AZURE_KEY) keys.azure = env.AIMOCK_PROVIDER_AZURE_KEY;
  if (env.AIMOCK_PROVIDER_ELEVENLABS_KEY) keys.elevenlabs = env.AIMOCK_PROVIDER_ELEVENLABS_KEY;
  if (env.AIMOCK_PROVIDER_FAL_KEY) keys.fal = env.AIMOCK_PROVIDER_FAL_KEY;
  return Object.keys(keys).length > 0 ? keys : undefined;
}
