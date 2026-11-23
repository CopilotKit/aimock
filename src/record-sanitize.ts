/**
 * Shared record sanitizer (D10, S1-S7).
 *
 * The credential-key and URL rules were moved here from `live-sanitize.ts`,
 * which imports them back unchanged. `sanitizeRecording` applies the generic
 * record rules to any JSON value (for example an `mcpFakes` recording).
 */

export const CREDENTIAL_KEY =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret|token|sec-websocket-protocol)$/i;
export const REDACTED = "[REDACTED]";
export const MIN_SECRET_LENGTH = 8;

/** Thrown when a recording cannot be made safe (S6). Never carries a value. */
export class RecordUnsafeError extends Error {
  constructor(readonly reason: "secret-in-path" | "secret-remains") {
    super(`unsafe recording: ${reason}`);
    this.name = "RecordUnsafeError";
  }
}

export function decodeUrlComponent(value: string): string {
  // Tolerate malformed escapes while exposing encoded secrets. Protect literal
  // form separators so the entire component remains one value.
  return new URLSearchParams(`value=${value.replace(/\+/g, "%2B").replace(/&/g, "%26")}`).get(
    "value",
  )!;
}

/**
 * S3: scrub one absolute URL string; non-URLs unchanged. `onPathSecret` is
 * called (and must throw) when the decoded path contains a secret.
 */
export function scrubUrl(
  value: string,
  hasSecret: (s: string) => boolean,
  onPathSecret: () => never,
): string {
  // Leave non-URLs and clean URLs byte-for-byte intact.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  // A path identifies the resource; changing it could change replay semantics.
  if (hasSecret(decodeUrlComponent(url.pathname))) onPathSecret();
  let changed = false;
  if (url.username || url.password) {
    url.username = "";
    url.password = "";
    changed = true;
  }
  for (const [key, val] of [...url.searchParams]) {
    if (CREDENTIAL_KEY.test(key) || hasSecret(key) || hasSecret(val)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }
  const decodedHash = decodeUrlComponent(url.hash);
  if (
    url.hash &&
    (hasSecret(decodedHash) || /(?:token|secret|password|api[_-]?key)=/i.test(decodedHash))
  ) {
    url.hash = "";
    changed = true;
  }
  return changed ? url.href : value;
}

/** S2 (d) start check: throws a plain Error naming the rule, never the value. */
export function validateSecretValues(values: readonly string[]): void {
  for (const value of values) {
    if (typeof value !== "string") throw new Error("record.secretValues entries must be strings");
    if (value.length < MIN_SECRET_LENGTH) {
      throw new Error(`record.secretValues entry shorter than ${MIN_SECRET_LENGTH} characters`);
    }
  }
}

// Recognized API-key header names beyond the credential-key regex
// (for example `x-goog-api-key`).
const API_KEY_HEADER = /(?:^|[-_])api[-_]?key$/i;

/** The value, the token after the scheme, and for `Basic` the decoded user and password. */
function credentialParts(value: string): string[] {
  const parts = [value];
  const match = /^(\S+)\s+(\S.*)$/.exec(value.trim());
  if (match) {
    const token = match[2].trim();
    parts.push(token);
    if (match[1].toLowerCase() === "basic") {
      const decoded = Buffer.from(token, "base64").toString("utf8");
      const colon = decoded.indexOf(":");
      if (colon >= 0) parts.push(decoded.slice(0, colon), decoded.slice(colon + 1));
    }
  }
  return parts;
}

function urlParts(value: string): string[] {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return [];
  }
  const parts: string[] = [];
  if (url.username) parts.push(url.username, decodeUrlComponent(url.username));
  if (url.password) parts.push(url.password, decodeUrlComponent(url.password));
  // Every query value; path segments are names, so they are not included (S2 c).
  for (const val of url.searchParams.values()) parts.push(val);
  return parts;
}

/** S2 (a)-(c): secrets from forwarded headers, upstreamAuth and the upstream URL; min length 8. */
export function knownSecrets(input: {
  headers: Record<string, string>;
  upstreamAuth?: { name: string; value: string };
  upstreamUrl: string;
  secretValues: readonly string[];
}): string[] {
  const derived: string[] = [];
  for (const [name, value] of Object.entries(input.headers)) {
    if (typeof value !== "string") continue;
    if (CREDENTIAL_KEY.test(name) || API_KEY_HEADER.test(name)) {
      derived.push(...credentialParts(value));
    }
  }
  if (input.upstreamAuth) derived.push(...credentialParts(input.upstreamAuth.value));
  derived.push(...urlParts(input.upstreamUrl));
  const secrets = new Set(derived.filter((s) => s.length >= MIN_SECRET_LENGTH));
  // (d) is validated at start (`validateSecretValues`); keep every non-empty entry.
  for (const value of input.secretValues) if (value.length) secrets.add(value);
  return [...secrets].sort((a, b) => b.length - a.length);
}

/** `%2b` for `%2B`: some encoders write lowercase hex. */
function lowerHex(value: string): string {
  return value.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
}

/** `f(value)`, or nothing when it throws (a lone surrogate, a bad escape). */
function attempt(f: (value: string) => string, value: string): string[] {
  try {
    return [f(value)];
  } catch {
    return [];
  }
}

/**
 * Every textual form a known secret can take in a recording (G2b B1-r2): the
 * value as registered, its percent-decoded forms (it may have been
 * registered encoded, as a URL query value is), and for each of those the
 * `encodeURIComponent`, form (`URLSearchParams`, `+` for space) and
 * `encodeURI` encodings, with uppercase or lowercase hex. A derived form
 * shorter than `MIN_SECRET_LENGTH` is dropped; the value itself never is.
 */
export function secretForms(secret: string): string[] {
  const bases = [
    secret,
    ...attempt(decodeURIComponent, secret),
    ...attempt((v) => decodeURIComponent(v.replace(/\+/g, " ")), secret),
  ];
  const forms = new Set<string>();
  for (const base of bases) {
    forms.add(base);
    const encoded = [
      ...attempt(encodeURIComponent, base),
      ...attempt((v) => new URLSearchParams([["v", v]]).toString().slice(2), base),
      ...attempt(encodeURI, base),
      ...attempt((v) => encodeURIComponent(v).replace(/%20/g, "+"), base),
    ];
    for (const form of encoded) {
      forms.add(form);
      forms.add(lowerHex(form));
    }
  }
  return [...forms].filter((form) => form === secret || form.length >= MIN_SECRET_LENGTH);
}

export interface SanitizeResult<T> {
  value: T;
  /** `_warnings` text: "<pointer>: redacted a known secret" / "<pointer>: looks like a <kind> token" */
  warnings: string[];
}

// S7: token-shaped strings are reported, never redacted. Order matters:
// `sk-ant-` is checked before the generic `sk-`.
const TOKEN_PATTERNS: readonly { kind: string; pattern: RegExp }[] = [
  { kind: "Anthropic API key", pattern: /\bsk-ant-[A-Za-z0-9_-]{8,}/ },
  { kind: "OpenAI API key", pattern: /\bsk-(?!ant-)[A-Za-z0-9_-]{16,}/ },
  { kind: "GitHub token", pattern: /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/ },
  { kind: "Slack token", pattern: /\bxox[abp]-[A-Za-z0-9-]{10,}/ },
  { kind: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: "JWT", pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/ },
];

function escapePointer(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * S2-S7 over one JSON value. `isCredentialBranch(pointer)` is called with the
 * pointer of each object and says whether credential-shaped keys directly
 * under it are removed (S4: `/recorded…`, any `…/_meta…`).
 * Throws RecordUnsafeError (S6). The input is never mutated.
 */
export function sanitizeRecording<T>(
  value: T,
  secrets: readonly string[],
  isCredentialBranch: (pointer: string) => boolean,
): SanitizeResult<T> {
  // G2b B1-r2: every form a secret can take (encoded, decoded) is matched.
  const ordered = [...new Set(secrets.filter((s) => s.length).flatMap(secretForms))].sort(
    (a, b) => b.length - a.length,
  );
  const hasSecret = (s: string) => ordered.some((secret) => s.includes(secret));
  // S6 runs over JSON text, where `"`, `\` and control characters are escaped.
  const jsonForms = ordered.map((secret) => JSON.stringify(secret).slice(1, -1));
  const hasSecretInJson = (s: string) =>
    hasSecret(s) || jsonForms.some((secret) => s.includes(secret));
  const onPathSecret = (): never => {
    throw new RecordUnsafeError("secret-in-path");
  };
  const warnings: string[] = [];

  function visitString(input: string, pointer: string): string {
    const url = scrubUrl(input, hasSecret, onPathSecret);
    if (url !== input) warnings.push(`${pointer}: removed credentials from a URL`);
    let out = url;
    for (const secret of ordered) out = out.split(secret).join(REDACTED);
    if (out !== url) warnings.push(`${pointer}: redacted a known secret`);
    for (const { kind, pattern } of TOKEN_PATTERNS) {
      if (pattern.test(out)) warnings.push(`${pointer}: looks like a ${kind} token`);
    }
    return out;
  }

  function visit(node: unknown, pointer: string): unknown {
    if (typeof node === "string") return visitString(node, pointer);
    if (Array.isArray(node)) return node.map((item, i) => visit(item, `${pointer}/${i}`));
    if (!node || typeof node !== "object") return node;
    const removeCredentials = isCredentialBranch(pointer);
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(node)) {
      if (removeCredentials && CREDENTIAL_KEY.test(key)) continue;
      // Own data property, so a `__proto__` key never rewires the prototype.
      Object.defineProperty(output, key, {
        value: visit(item, `${pointer}/${escapePointer(key)}`),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return output;
  }

  const cleaned = visit(value, "") as T;
  // S6: fail closed if any known secret remains (for example in a key name).
  if (hasSecretInJson(JSON.stringify(cleaned) ?? "")) {
    throw new RecordUnsafeError("secret-remains");
  }
  return { value: cleaned, warnings };
}
