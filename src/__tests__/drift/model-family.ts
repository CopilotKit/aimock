/**
 * Shared, side-effect-free `normalizeModelFamily` primitive (no
 * `describe`/`beforeAll`) reducing a model id to its FAMILY KEY by stripping the
 * trailing version/snapshot suffixes that providers append to already-known
 * families.
 *
 * New dated snapshots of an existing family land constantly (`tts-1-1106`,
 * `gpt-audio-2025-08-28`, `gpt-4o-mini-tts-2025-12-15`, …); appending every one
 * to a known-ID set never converges and turns the daily drift job permanently
 * red on false positives. Comparing the NORMALIZED family instead means only a
 * genuinely new family (e.g. `gpt-live`) is ever flagged.
 *
 * Two suffix shapes are stripped, repeatedly, from the END of the id:
 *   - a dated snapshot `-YYYY-MM-DD`  (e.g. `-2025-08-28`)
 *   - a build/version tag `-NNN` or `-NNNN`  (3–4 digits, e.g. `-1106`)
 *
 * Both are anchored to the end and applied in a loop so a trailing dated
 * snapshot that itself follows a build tag is fully reduced. A short numeric
 * suffix like `gpt-live-1`'s trailing `-1` is a SINGLE digit and is deliberately
 * NOT stripped, so `gpt-live-1` normalizes to `gpt-live-1` — an unknown family —
 * and stays flagged (the whole point of the canary).
 *
 * The `provider` argument is a forward hook: the dated-snapshot/build-tag strip
 * below is the SHARED CORE applied identically for all three providers today, so
 * `normalizeModelFamily(id, "openai")` is byte-identical to the historical
 * `normalizeVoiceModelFamily(id)`. Provider-specific normalization can branch off
 * `provider` later without touching call sites.
 */
const DATED_SNAPSHOT_SUFFIX = /-\d{4}-\d{2}-\d{2}$/;
const BUILD_TAG_SUFFIX = /-\d{3,4}$/;

export function normalizeModelFamily(
  id: string,
  provider: "openai" | "anthropic" | "gemini",
): string {
  void provider;
  let family = id;
  for (;;) {
    const stripped = family.replace(DATED_SNAPSHOT_SUFFIX, "").replace(BUILD_TAG_SUFFIX, "");
    if (stripped === family) break;
    family = stripped;
  }
  return family;
}
