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
 * Two suffix shapes are stripped, repeatedly, from the END of the id for ALL
 * providers (the SHARED CORE):
 *   - a dated snapshot `-YYYY-MM-DD`  (e.g. `-2025-08-28`)
 *   - a build/version tag `-NNN` or `-NNNN`  (3–4 digits, e.g. `-1106`)
 *
 * Both are anchored to the end and applied in a loop so a trailing dated
 * snapshot that itself follows a build tag is fully reduced. A short numeric
 * suffix like `gpt-live-1`'s trailing `-1` is a SINGLE digit and is deliberately
 * NOT stripped, so `gpt-live-1` normalizes to `gpt-live-1` — an unknown family —
 * and stays flagged (the whole point of the canary).
 *
 * The `provider` argument selects a per-provider EXTRA rule on top of the shared
 * core:
 *   - `anthropic` additionally strips a CONTIGUOUS 8-digit snapshot `-YYYYMMDD`
 *     (e.g. `claude-3-5-sonnet-20241022` → `claude-3-5-sonnet`). Anthropic dates
 *     its ids with an undelimited `-YYYYMMDD` suffix rather than the dashed
 *     `-YYYY-MM-DD` form, so without this every dated Claude id would
 *     false-positive as drift (the incident-2 class, for Anthropic).
 *   - `openai` / `gemini` keep ONLY the shared core — the 8-digit strip is NOT
 *     applied to them, so a non-date 8-digit tail is never over-stripped, and
 *     `normalizeModelFamily(id, "openai")` stays byte-identical to the historical
 *     `normalizeVoiceModelFamily(id)`.
 *
 * The per-provider rule runs inside the SAME reduction loop as the shared core,
 * so it stays idempotent: a dated snapshot following a build tag still fully
 * reduces.
 */
const DATED_SNAPSHOT_SUFFIX = /-\d{4}-\d{2}-\d{2}$/;
const BUILD_TAG_SUFFIX = /-\d{3,4}$/;
/** Anthropic contiguous `-YYYYMMDD` snapshot suffix (undelimited date). */
const ANTHROPIC_DATE_SUFFIX = /-\d{8}$/;

export function normalizeModelFamily(
  id: string,
  provider: "openai" | "anthropic" | "gemini",
): string {
  let family = id;
  for (;;) {
    let stripped = family.replace(DATED_SNAPSHOT_SUFFIX, "").replace(BUILD_TAG_SUFFIX, "");
    if (provider === "anthropic") {
      stripped = stripped.replace(ANTHROPIC_DATE_SUFFIX, "");
    }
    if (stripped === family) break;
    family = stripped;
  }
  return family;
}
