import { validateLiveTranscript } from "./live-fixture.js";
import { CREDENTIAL_KEY as credentialKey, scrubUrl } from "./record-sanitize.js";
import type { LiveJson, LiveObject, LiveOptions, LiveTranscript } from "./live-types.js";

/** Exact transcript-rooted pointer to an observed removable credential metadata field. */
export interface LiveCredentialField {
  readonly pointer: string;
}

export class LiveUnsafeExportError extends Error {
  readonly category = "unsafe-export";
  constructor() {
    // Never reflect untrusted values, keys, pointers, or validation errors.
    super("unsafe-export: Live transcript cannot be retained safely");
    this.name = "LiveUnsafeExportError";
  }
}

// These branches carry conversation, tool schema, or PCM semantics. A key named
// "authorization" inside tool parameters is a schema property, not a header.
const semanticKey = new Set([
  "instructions",
  "content",
  "delta",
  "audio",
  "arguments",
  "output",
  "input",
  "tools",
  "parameters",
  "client",
  "text",
  "thinking",
]);
const metadataKey = new Set(["metadata", "headers", "diagnostics"]);
const unsafeKey = new Set(["__proto__", "constructor", "prototype"]);
const redacted = "[REDACTED]";
function fail(): never {
  throw new LiveUnsafeExportError();
}
function escapePointer(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}
function parts(pointer: string): string[] {
  if (!pointer.startsWith("/") || /~(?![01])/u.test(pointer)) fail();
  const keys = pointer
    .slice(1)
    .split("/")
    .map((key) => key.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (keys.some((key) => unsafeKey.has(key))) fail();
  return keys;
}
function child(value: LiveJson, key: string): LiveJson {
  if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) fail();
  if (Array.isArray(value)) {
    if (!/^(0|[1-9]\d*)$/.test(key)) fail();
    return value[Number(key)];
  }
  return value[key];
}
function setIdentifier(event: LiveObject, pointer: string, value: string): void {
  const keys = parts(pointer);
  const last = keys.pop();
  if (last === undefined) fail();
  let parent: LiveJson = event;
  for (const key of keys) parent = child(parent, key);
  if (typeof child(parent, last) !== "string" || !parent || typeof parent !== "object") fail();
  if (Array.isArray(parent)) parent[Number(last)] = value;
  else parent[last] = value;
}

/**
 * Sanitize a separately retained successful capture; never mutate the relay.
 * Validation supplies the reviewed identifier descriptors and causal checks.
 * Credential descriptors supplement the built-in policy, not permission to
 * delete arbitrary protocol operands. Ambiguous secret-bearing data fails closed.
 */
export function sanitizeLiveTranscript(
  transcript: LiveTranscript,
  secretValues: readonly string[] = [],
  credentialFields: readonly LiveCredentialField[] = [],
  validationOptions: Omit<LiveOptions, "secretValues"> = {},
): LiveTranscript {
  try {
    const result = validateLiveTranscript(transcript, validationOptions);
    if (!Array.isArray(secretValues) || secretValues.some((s) => typeof s !== "string")) fail();
    const secrets = [...new Set(secretValues.filter((s) => s.length))].sort(
      (a, b) => b.length - a.length,
    );
    const hasSecret = (value: string) => secrets.some((secret) => value.includes(secret));
    const replaceSecrets = (value: string) => {
      for (const secret of secrets) value = value.split(secret).join(redacted);
      return value;
    };
    const descriptors = new Set(
      credentialFields.map((field) => {
        parts(field.pointer);
        return field.pointer;
      }),
    );
    const handled = new Set<string>();
    // Names themselves may have been derived from provider IDs. Replace both
    // the annotation names and only their explicitly annotated operand values.
    const originalIds = new Set<string>();
    for (const binding of result.bindings) {
      let value: LiveJson = result.entries[binding.entry].event;
      for (const key of parts(binding.pointer)) value = child(value, key);
      if (typeof value !== "string") fail();
      originalIds.add(value);
    }
    let nextId = 1;
    const identities = new Map<string, { name: string; value: string }>();
    for (const binding of result.bindings) {
      let identity = identities.get(binding.name);
      if (!identity) {
        const index = identities.size + 1;
        while (originalIds.has(`live-id-${nextId}`)) nextId++;
        identity = { name: `binding-${index}`, value: `live-id-${nextId++}` };
        identities.set(binding.name, identity);
      }
      setIdentifier(result.entries[binding.entry].event, binding.pointer, identity.value);
      binding.name = identity.name;
    }
    const sanitizeUrl = (v: string) => scrubUrl(v, hasSecret, fail);
    function providerMetadata(pointer: string): boolean {
      const match =
        /^\/entries\/(\d+)\/event\/event\/(?:response\/(?:user|prompt_cache_key|safety_identifier)|item\/encrypted_content)$/.exec(
          pointer,
        );
      if (!match) return false;
      const event = result.entries[Number(match[1])].event;
      const nested = event.event;
      if (
        event.type !== "response.event" ||
        !nested ||
        typeof nested !== "object" ||
        Array.isArray(nested)
      )
        return false;
      if (!pointer.endsWith("/item/encrypted_content")) {
        return ["response.created", "response.in_progress", "response.completed"].includes(
          String(nested.type),
        );
      }
      const item = nested.item;
      return (
        ["response.output_item.added", "response.output_item.done"].includes(String(nested.type)) &&
        !!item &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        item.type === "reasoning"
      );
    }
    function visit(value: LiveJson, path: string, metadata = false, semantic = false): LiveJson {
      if (typeof value === "string") {
        const url = sanitizeUrl(value);
        if ((hasSecret(value) || url !== value) && (!metadata || semantic)) fail();
        return metadata && !semantic ? replaceSecrets(url) : value;
      }
      if (Array.isArray(value))
        return value.map((item, i) => visit(item, `${path}/${i}`, metadata, semantic));
      if (!value || typeof value !== "object") return value;
      const output: LiveObject = {};
      for (const [key, item] of Object.entries(value)) {
        const pointer = `${path}/${escapePointer(key)}`;
        // Exact retained metadata sites from the reviewed v3 sanitation
        // evidence. Never infer these by equal values or similar field names.
        if (providerMetadata(pointer) && (typeof item === "string" || item === null)) {
          if (descriptors.has(pointer)) handled.add(pointer);
          else output[key] = typeof item === "string" ? redacted : item;
          continue;
        }
        const protectedBranch = semantic || semanticKey.has(key);
        const removable = !protectedBranch && (metadata || credentialKey.test(key));
        if (descriptors.has(pointer)) {
          if (!removable) fail();
          handled.add(pointer);
          continue;
        }
        if (!semantic && credentialKey.test(key)) continue;
        if (hasSecret(key)) {
          if (!metadata || protectedBranch) fail();
          continue;
        }
        output[key] = visit(item, pointer, metadata || metadataKey.has(key), protectedBranch);
      }
      return output;
    }
    // Validation clones all bounded JSON, including unknown metadata. Preserve
    // those fields, then validate again to catch any semantic deletion.
    const cleaned = visit(result as LiveTranscript & LiveObject, "");
    if (handled.size !== descriptors.size || hasSecret(JSON.stringify(cleaned))) fail();
    return validateLiveTranscript(cleaned, validationOptions);
  } catch {
    fail();
  }
}
