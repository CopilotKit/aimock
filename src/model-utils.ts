const DATE_SUFFIX_RE = /[-](\d{8}(-v\d+([:.]\d+)*)?)$|[-]\d{4}-\d{2}-\d{2}$/;

export function normalizeModelName(
  model: string | undefined,
  skipNormalization?: boolean,
): string | undefined {
  if (!model || skipNormalization) return model;
  return model.replace(DATE_SUFFIX_RE, "");
}

// ─── Reasoning-capability map ───────────────────────────────────────────────
//
// `isReasoningModel` answers: "would the REAL provider for this model id emit a
// reasoning/thinking channel?" aimock uses it to gate synthesized reasoning so a
// fixture's `reasoning` field is not replayed for a model that cannot reason
// (the gpt-4.1 false-green described in aimock#254).
//
// Policy (see the #254 spec for the full rationale):
//   - The KNOWN-NON-REASONING list (NONREASONING_FAMILIES) is the load-bearing
//     guard. A match there → false.
//   - The reasoning list (REASONING_FAMILIES) is mostly documentation; because
//     unknown ids default to `true` it is not load-bearing for correctness.
//   - UNKNOWN id → true (assume reasoning-capable). A false negative silently
//     breaks legitimate replays and is hard to notice; a false positive merely
//     fails to catch one mis-wiring class. Failing open keeps the blast radius
//     small and bounds maintenance to the explicit non-reasoning list.
//
// Env overrides let users correct drift without a release:
//   AIMOCK_REASONING_MODELS     — comma-separated ids/prefixes forced capable.
//   AIMOCK_NONREASONING_MODELS  — comma-separated ids/prefixes forced incapable.
// Env entries are normalized IDENTICALLY to the incoming model id (date suffix
// + provider/region prefix stripped, lowercased) so a prefixed entry such as
// `anthropic.claude-opus-4` matches the already-stripped id.
//
// Precedence is BETWEEN lists, enforced by the sequential `if` checks below:
//   env-nonreasoning > env-reasoning > built-in-nonreasoning > built-in-reasoning > unknown(true)
// Within any single list the result is order-INDEPENDENT — `matchesAny` uses
// `Array.some(startsWith)`, so any prefix match yields that list's verdict.

// Known non-reasoning families — the load-bearing denylist. Entries are matched
// as prefixes against the normalized, lowercased, provider-stripped model id.
// Order within this list does not matter (see `matchesAny`): any prefix that
// matches the id produces `false`.
const NONREASONING_FAMILIES = [
  "gpt-4.1", // the exact model from aimock#254 (covers -mini / -nano)
  "gpt-4o", // covers gpt-4o-mini
  "gpt-4-turbo",
  "gpt-4", // plain gpt-4; order-independent, and prefix-safe since longer ids (gpt-4.1/gpt-4o/gpt-4-turbo) are also denylisted
  "gpt-3.5",
  "claude-3-5-", // Sonnet/Haiku 3.5 — no extended thinking
  "claude-3-haiku",
  "claude-3-opus",
  "claude-3-sonnet",
  "gemini-1.5-",
];

// Reasoning-capable families (informational; unknown already defaults to true).
const REASONING_FAMILIES = [
  "o1",
  "o3",
  "o4",
  "gpt-5",
  "deepseek-r1",
  "deepseek-reasoner",
  "claude-3-7-sonnet",
  "claude-opus-4",
  "claude-sonnet-4",
  "claude-haiku-4",
  "gpt-oss",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.0-flash-thinking",
  "qwq",
  "qwen3",
];

/**
 * Strip a leading provider segment that Bedrock (and similar) prepend before
 * the actual family token — e.g. `anthropic.`, `us.anthropic.`, `eu.`. Keeps
 * everything from the recognised family token onward so prefix matching works.
 */
function stripProviderPrefix(id: string): string {
  // Remove leading region/provider segments (dot-separated) until we hit the
  // model token. Provider/region segments never contain a hyphen, whereas
  // model families do (e.g. `claude-3-5-sonnet`, `gpt-4.1`). So drop any
  // leading dot-separated segment that has no hyphen.
  let rest = id;
  while (true) {
    const dot = rest.indexOf(".");
    if (dot === -1) break;
    const head = rest.slice(0, dot);
    if (head.length === 0 || head.includes("-")) break;
    rest = rest.slice(dot + 1);
  }
  return rest;
}

// Normalize each comma-separated env entry IDENTICALLY to the incoming model id
// (date-suffix + provider/region prefix stripped, lowercased) so a prefixed
// entry such as `anthropic.claude-opus-4` matches the already-stripped id.
function parseEnvList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => stripProviderPrefix(normalizeModelName(s.trim())?.toLowerCase() ?? ""))
    .filter((s) => s.length > 0);
}

function matchesAny(id: string, families: readonly string[]): boolean {
  return families.some((fam) => id.startsWith(fam));
}

/**
 * Returns whether the real provider for `model` would emit a reasoning/thinking
 * channel. Absence of a model id, or an unrecognised id, defaults to `true`
 * (assume capable) — see the policy note above.
 */
export function isReasoningModel(model: string | undefined): boolean {
  if (!model) return true;

  const normalized = normalizeModelName(model)?.toLowerCase() ?? "";
  const id = stripProviderPrefix(normalized);

  // Env overrides win, parsed fresh so they remain test-stubbable.
  const envNon = parseEnvList(process.env.AIMOCK_NONREASONING_MODELS);
  if (matchesAny(id, envNon)) return false;
  const envReasoning = parseEnvList(process.env.AIMOCK_REASONING_MODELS);
  if (matchesAny(id, envReasoning)) return true;

  // Built-in denylist is the active guard.
  if (matchesAny(id, NONREASONING_FAMILIES)) return false;
  // Built-in reasoning list short-circuits to capable.
  if (matchesAny(id, REASONING_FAMILIES)) return true;

  // Unknown → assume reasoning-capable (fail open).
  return true;
}
