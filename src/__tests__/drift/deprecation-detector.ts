/**
 * Zero-reference cross-check for the C4 deprecation detector (`models.drift.ts`).
 *
 * A model family that a healthy live `/models` listing no longer contains is
 * only SAFE to auto-propose for removal from the frozen registry
 * (`model-registry.ts`) if aimock's own source no longer references it — a
 * still-referenced family must route to a human instead (§4.4), never be
 * silently classified away. This module owns the mechanical, zero-LLM scan
 * that answers that one question: does the family string still appear,
 * as a real token (not a substring artifact of a longer sibling id), anywhere
 * in aimock's own source tree?
 *
 * Deliberately co-located here (NOT in `helpers.ts` — Correction S1): this is
 * drift-detector-specific I/O, not a shared cross-provider live-discovery
 * utility like `providers.ts`'s `resolveLiveModel`/`isInfraSkip`.
 *
 * Scanned root: `src/` EXCLUDING `src/__tests__/drift/` itself. The drift
 * directory is the CLASSIFICATION layer (the registry seeds, this detector,
 * its tests) — every family literal trivially appears there by definition, so
 * including it would make every family look "still referenced" and defeat the
 * entire check. Everywhere else under `src/` (server.ts's `DEFAULT_MODELS`,
 * provider builder files, non-drift test fixtures/conformance suites) is a
 * legitimate signal of real usage.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** `src/` — two levels up from this file (`src/__tests__/drift/`). */
const SRC_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Directory (relative to `SRC_ROOT`) excluded from the ref-scan — see module doc. */
const EXCLUDED_REL_DIR = join("__tests__", "drift");

function isExcludedDir(name: string, relPath: string): boolean {
  if (name === "node_modules" || name === "dist") return true;
  return relPath === EXCLUDED_REL_DIR || relPath.startsWith(EXCLUDED_REL_DIR + "/");
}

/** Recursively collect every `.ts`/`.tsx` file under `root`, skipping excluded dirs. */
function collectSourceFiles(root: string): string[] {
  const files: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        const rel = full.slice(root.length).replace(/^[/\\]+/, "");
        if (isExcludedDir(entry.name, rel)) continue;
        stack.push(full);
      } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
        files.push(full);
      }
    }
  }
  return files;
}

/** Escape a string for safe interpolation into a `RegExp` literal. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Memoized concatenation of every scanned file's source text (computed once, lazily). */
let cachedSourceText: string | null = null;

function allSourceText(): string {
  if (cachedSourceText === null) {
    cachedSourceText = collectSourceFiles(SRC_ROOT)
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
  }
  return cachedSourceText;
}

/** Test-only: drop the memoized source cache (the source tree does not change mid-run). */
export function __resetSourceScanCache(): void {
  cachedSourceText = null;
}

/**
 * True when `family` still appears as a real token (bounded by anything other
 * than a word character, `.`, or `-`) anywhere in aimock's own source outside
 * `src/__tests__/drift/`. Boundary-aware so a shorter family that is a strict
 * prefix of another live id's family (e.g. `gpt-4` vs. `gpt-4o` / `gpt-4-turbo`)
 * is never mistaken for a hit — a naive substring scan would otherwise call
 * `gpt-4` "referenced" merely because `gpt-4o` appears in source, silently
 * blocking a legitimate removal proposal forever.
 *
 * Takes an unused second parameter slot deliberately absent: the scan is not
 * provider-scoped (a family string is checked against the whole non-drift
 * source tree), but its call signature is still assignable to the detector's
 * injectable `(family: string, provider: Provider) => boolean` shape — a
 * function with fewer parameters is always assignable there.
 */
export function isFamilyStillReferenced(family: string): boolean {
  const pattern = new RegExp(`(?<![\\w.-])${escapeRegExp(family)}(?![\\w.-])`);
  return pattern.test(allSourceText());
}

// ---------------------------------------------------------------------------
// Forward-looking families — distinct concern from "still referenced" above.
// ---------------------------------------------------------------------------

type Provider = "openai" | "anthropic" | "gemini";

/**
 * Model families deliberately classified INCLUDE ahead of general
 * availability (see `model-registry.ts`'s inline "forward-looking" comment on
 * `claude-fable-5`). A forward-looking family is, BY CONSTRUCTION, absent
 * from every live `/models` listing until it launches — that is
 * indistinguishable, to a naive `classified − live` diff, from a genuine
 * retirement. It is ALSO indistinguishable via `isFamilyStillReferenced`:
 * aimock legitimately has no builder/fixture reference to a family it has not
 * built yet, so that scan reports zero-reference too, same as a truly
 * retired family would. Without this allowlist, a forward-looking family
 * would be mechanically proposed for removal (or routed to a needs-human
 * note) on EVERY daily drift-sync run — pure noise a human has to
 * reject/dismiss every day, forever, until the family finally goes GA.
 *
 * A family listed here is excluded from `detectDeprecatedFamiliesForSync`'s
 * `missing` candidate set entirely (see `scripts/drift-sync.ts`) — no removal
 * proposal, no needs-human note, nothing. Reversible: delete the entry the
 * same day the family actually appears in a live listing (at that point it is
 * a real, launched family like any other, and ordinary deprecation detection
 * applies to it going forward).
 */
export const FORWARD_LOOKING_FAMILIES: Record<Provider, ReadonlySet<string>> = {
  openai: new Set(),
  anthropic: new Set(["claude-fable-5"]),
  gemini: new Set(),
};

/** True when `family` is a known forward-looking (not-yet-launched) INCLUDE entry. */
export function isForwardLookingFamily(family: string, provider: Provider): boolean {
  return FORWARD_LOOKING_FAMILIES[provider].has(family);
}

// ---------------------------------------------------------------------------
// The fail-closed floor on the RAW live `/models` id count.
// ---------------------------------------------------------------------------

/**
 * The smallest live `/models` listing the deprecation half will diff against,
 * per provider — below this the listing is treated as truncated/empty/reshaped
 * and the whole deprecation half is abandoned for that provider rather than
 * risk mass-removing the registry off a bad response.
 *
 * WHY THIS IS AN EXPLICIT NUMBER AND NOT `includeFamilies[provider].size`.
 * It used to default to the family count, and that is a UNIT MISMATCH: a count
 * of RAW IDS compared against a count of DISTINCT FAMILIES. The rationale for
 * it ("a healthy listing returns many more raw ids than distinct families,
 * because every dated snapshot multiplies one family into several ids") holds
 * only for a provider whose listing is inflated by ids we exclude — openai
 * (44 excluded families plus every `-preview`) and gemini (24). It is FALSE
 * for anthropic, which excludes 3 legacy tokens and serves roughly one id per
 * family.
 *
 * The consequence was not theoretical. Anthropic's live listing returned 11
 * raw ids against a floor of 20, so its deprecation half was skipped on 12 of
 * 12 `Fix Drift` runs with surviving artifacts (2026-07-24 → 2026-08-05) —
 * every one of them green and silent. It was never reachable: this repo's own
 * frozen healthy `/models` wave (`models.drift.ts`, captured 2026-07-16) is 16
 * ids, already under 20, and the floor RATCHETED UP by one with every family
 * added to `includeFamilies` while the supply side could only shrink as
 * Anthropic retired models. A coverage floor conflates "the listing is broken"
 * with "we mock more families than the provider still serves" — and the second
 * is EXACTLY the condition this detector exists to report.
 *
 * HOW EACH NUMBER WAS CHOSEN. The floor's only job is "never mass-remove off a
 * truncated or empty listing", so each is set well below the smallest healthy
 * listing there is direct evidence for, and is NEVER raised above evidence —
 * raising a floor past what has been proven to clear is precisely how the
 * anthropic blind spot was created.
 *
 *  - `openai` 20 — the live listing cleared the old floor of 40 on 12/12 runs
 *    (so >= 40), and the frozen healthy wave is 59 ids. Half of the smallest
 *    directly-observed clearance. openai is not currently failing but was
 *    NEXT: 1.48x headroom on the frozen wave, shrinking by one every time a
 *    family is classified. 20 is 2x headroom that retirement cannot erode.
 *  - `anthropic` 8 — the live listing was 11 raw ids on 12/12 runs (10 once),
 *    and the frozen healthy wave is 16. 8 is half the frozen wave and 0.73x
 *    the observed live count, so the deprecation half actually runs; a genuine
 *    Anthropic listing falling to 7 or fewer would mean a third of the served
 *    catalog vanished at once, which is a real fault worth fail-closing on.
 *  - `gemini` 8 — the frozen healthy wave is 52 ids, but the only DIRECT
 *    evidence from production is that it cleared the old floor of 9 (so >= 9).
 *    The floor is therefore kept at or below 9 rather than at half of 52: a
 *    floor set from a fixture instead of from what is known to clear is the
 *    same mistake in a different provider.
 *
 * INVARIANT, enforced by `drift-sync-core.test.ts`: every floor here is
 * strictly LESS than `includeFamilies[provider].size`, so the floor can never
 * again ratchet with the number of families aimock mocks.
 *
 * Membership is checksum-pinned in `logic-pin.test.ts`: raising a number here
 * silently switches a provider's deprecation detection off, which is the same
 * one-line silencing edit `FORWARD_LOOKING_FAMILIES` is pinned against.
 */
export const MIN_LISTING_SIZE: Record<Provider, number> = {
  openai: 20,
  anthropic: 8,
  gemini: 8,
};
