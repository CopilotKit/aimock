/**
 * Known voice/audio model FAMILIES + drift detection for the OpenAI realtime
 * canary. Detection compares each candidate's NORMALIZED family (trailing dated
 * snapshot / build-tag suffixes stripped) against a known-family set, so dated
 * snapshots of a known family don't churn as false-positive drift.
 *
 * Extracted into its own side-effect-free module (no `describe`/`beforeAll`) so
 * both the live canary in ws-realtime.drift.ts AND its unit test can import the
 * SAME detection code path without the unit test transitively registering the
 * drift suite (which would spin up the drift server).
 */

/**
 * The GA realtime model FAMILIES. At least one voice/audio model whose
 * normalized family (see `normalizeVoiceModelFamily`) is one of these MUST
 * appear in the account's model list, otherwise the family was renamed/removed
 * (NO_GA drift). Entries are already normalized family keys — dated snapshots
 * such as `gpt-realtime-2025-08-28` collapse onto `gpt-realtime` and so match
 * here without being listed separately.
 */
export const gaRealtimeModels = [
  "gpt-realtime",
  "gpt-realtime-2",
  "gpt-realtime-2.1",
  "gpt-realtime-2.1-mini",
  "gpt-realtime-1.5",
  "gpt-realtime-mini",
];

/**
 * Normalize a model id to its FAMILY KEY by stripping trailing version/snapshot
 * suffixes that OpenAI appends to already-known families. New dated snapshots of
 * an existing family land constantly (`tts-1-1106`, `gpt-audio-2025-08-28`,
 * `gpt-4o-mini-tts-2025-12-15`, …); appending every one to a known-ID set never
 * converges and turns the daily drift job permanently red on false positives.
 * Comparing the NORMALIZED family instead means only a genuinely new family
 * (e.g. `gpt-live`) is ever flagged.
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
 */
const DATED_SNAPSHOT_SUFFIX = /-\d{4}-\d{2}-\d{2}$/;
const BUILD_TAG_SUFFIX = /-\d{3,4}$/;

export function normalizeVoiceModelFamily(id: string): string {
  let family = id;
  for (;;) {
    const stripped = family.replace(DATED_SNAPSHOT_SUFFIX, "").replace(BUILD_TAG_SUFFIX, "");
    if (stripped === family) break;
    family = stripped;
  }
  return family;
}

/**
 * The set of voice/audio model FAMILIES we already know about, keyed by the
 * normalized family (see `normalizeVoiceModelFamily`). A voice/audio model whose
 * NORMALIZED family is not in this set is surfaced as new/unknown drift, so a
 * newly-shipped family (e.g. `gpt-live`) is flagged the first time it appears —
 * while dated snapshots of a known family (e.g. `gpt-audio-2025-08-28`) collapse
 * onto their family and stay green.
 *
 * The listed ids are the family keys; the seed values are already normalized
 * (they carry no dated/build suffix), so building the set through
 * `normalizeVoiceModelFamily` is idempotent and keeps the two in lockstep.
 */
export const knownVoiceModelFamilies = new Set(
  [
    // GA realtime family (dated/versioned variants normalize onto these).
    "gpt-realtime",
    "gpt-realtime-2",
    "gpt-realtime-2.1",
    "gpt-realtime-2.1-mini",
    "gpt-realtime-1.5",
    "gpt-realtime-mini",
    // Translate/whisper realtime variants
    "gpt-realtime-translate",
    "gpt-realtime-whisper",
    // Audio models also valid in realtime sessions
    "gpt-audio",
    "gpt-audio-1.5",
    "gpt-audio-mini",
    // Transcription/translation models
    "gpt-4o-transcribe",
    "gpt-4o-mini-transcribe",
    "gpt-4o-transcribe-diarize",
    "whisper-1",
    // Legacy preview models (may still appear)
    "gpt-4o-realtime-preview",
    "gpt-4o-mini-realtime-preview",
    // TTS / speech-out models (voice family, no "realtime" substring)
    "gpt-4o-mini-tts",
    "tts-1",
    "tts-1-hd",
  ].map(normalizeVoiceModelFamily),
);

/**
 * Match a model id that belongs to the voice/audio family the realtime canary
 * is responsible for. This is DELIBERATELY broader than the old
 * `id.includes("realtime")` filter: a new full-duplex voice family whose id
 * lacks the "realtime" substring (e.g. OpenAI's `gpt-live-1` / `gpt-live-1-mini`)
 * would previously never enter the unknown-model computation and so slip past
 * the canary silently. Matching on the broader voice/audio vocabulary closes
 * that blind spot generally — the point is "a new audio/voice model family the
 * account hasn't seen before gets flagged", not a one-off hardcode of gpt-live.
 *
 * Chat/text/image/embedding models (gpt-4o, gpt-5, dall-e, text-embedding-*,
 * etc.) do NOT match, so they never become false-positive "unknown voice" drift.
 */
export function isVoiceModelId(id: string): boolean {
  return /(?:realtime|audio|\blive\b|-live|transcribe|whisper|voice|\btts\b|-tts)/i.test(id);
}

/**
 * Result of running the known-voice-models drift detection over a model list.
 */
export interface VoiceModelDriftResult {
  /** Every model id that matched the voice/audio family matcher. */
  candidateModels: string[];
  /**
   * Voice/audio ids whose NORMALIZED family is not in knownVoiceModelFamilies —
   * new/unknown drift. Dated snapshots of a known family (e.g.
   * `gpt-audio-2025-08-28`) collapse onto their family and are NOT listed.
   */
  unknown: string[];
  /** Whether at least one GA realtime model (by family) is present. */
  hasGA: boolean;
}

/**
 * The single detection code path shared by the live canary AND its unit test.
 * Given a raw `GET /v1/models` id list, compute the voice/audio candidates, the
 * unknown (new-family) subset, and GA presence. Keeping this pure lets the unit
 * test drive the EXACT logic the live canary runs against a representative
 * payload without a network call.
 */
export function detectVoiceModelDrift(models: string[]): VoiceModelDriftResult {
  const candidateModels = models.filter(isVoiceModelId);
  const unknown = candidateModels.filter(
    (m) => !knownVoiceModelFamilies.has(normalizeVoiceModelFamily(m)),
  );
  const hasGA = candidateModels.some((m) =>
    gaRealtimeModels.includes(normalizeVoiceModelFamily(m)),
  );
  return { candidateModels, unknown, hasGA };
}
