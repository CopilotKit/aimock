/**
 * Unit test for the ws-realtime known-voice-models drift canary.
 *
 * This drives the SAME entry the live canary runs (`detectOpenAIVoiceModelDrift`)
 * against a representative `GET /v1/models` id list, served by a stubbed `fetch`
 * — no network call, but NOT a reimplemented fake: the detector is module-private
 * and this reaches it exactly the way ws-realtime.drift.ts does.
 *
 * Regression guard for the voice-model-family blind spot: the canary used to
 * filter the model list with `models.filter((m) => m.includes("realtime"))`, so
 * a NEW full-duplex voice family whose id lacks the "realtime" substring (e.g.
 * OpenAI's gpt-live-1 / gpt-live-1-mini) never entered the unknown-model
 * computation and slipped past the canary silently. The broadened voice/audio
 * matcher closes that blind spot generally.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  detectOpenAIVoiceModelDrift,
  isKnownVoiceModelFamily,
  isVoiceModelId,
  listKnownVoiceModelFamilies,
  type VoiceModelDriftResult,
} from "./drift/voice-models.js";
import { normalizeModelFamily } from "./drift/model-family.js";

// Dated-snapshot / build-tag variants of families that are ALREADY known. These
// are the exact ids the live Drift Tests run (28968203340) flagged as false
// positives before family normalization: each normalizes onto a known family
// (tts-1, tts-1-hd, gpt-audio, gpt-4o-mini-transcribe, gpt-4o-mini-tts) and so
// MUST NOT be flagged.
const KNOWN_FAMILY_SNAPSHOTS = [
  "tts-1-1106",
  "tts-1-hd-1106",
  "gpt-audio-2025-08-28",
  "gpt-4o-mini-transcribe-2025-12-15",
  "gpt-4o-mini-transcribe-2025-03-20",
  "gpt-4o-mini-tts-2025-03-20",
  "gpt-4o-mini-tts-2025-12-15",
];

// A representative GET /v1/models id list: the known GA realtime family, some
// known audio/transcribe/tts models (incl. dated snapshots of known families
// that MUST normalize onto their family), a batch of non-voice
// chat/image/embedding models that MUST NOT be flagged, and the newly-shipped
// gpt-live-* full-duplex voice family that is a genuinely new family.
const REPRESENTATIVE_MODELS = [
  // --- known voice/audio family (should stay green) ---
  "gpt-realtime",
  "gpt-realtime-2.1",
  "gpt-realtime-mini",
  "gpt-audio-mini",
  "gpt-4o-transcribe",
  "whisper-1",
  "gpt-4o-realtime-preview",
  "tts-1",
  // --- dated-snapshot / build-tag variants of KNOWN families (stay green) ---
  ...KNOWN_FAMILY_SNAPSHOTS,
  // --- non-voice models (must NOT be flagged as voice drift) ---
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-5",
  "gpt-5-mini",
  "o1",
  "o3-mini",
  "chatgpt-4o-latest",
  "dall-e-3",
  "text-embedding-3-large",
  "text-embedding-3-small",
  "omni-moderation-latest",
  // --- voice family with no "realtime" substring (the blind spot) ---
  // `gpt-live-1` was classified EXCLUDE on 2026-09-10 and is now in
  // knownVoiceModelFamilies, so it is the KNOWN half of this pair. The
  // unclassified `gpt-live-1-mini` is the NEW-family negative control: it keeps
  // proving the matcher reaches a voice id lacking "realtime", and that the
  // `gpt-live-1` key does not swallow families that merely EXTEND it.
  "gpt-live-1",
  "gpt-live-1-mini",
];

/** Run the canary's entry with `fetch` serving REPRESENTATIVE_MODELS as the listing. */
async function detectRepresentative(): Promise<VoiceModelDriftResult> {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ data: REPRESENTATIVE_MODELS.map((id) => ({ id })) })),
    ),
  );
  return detectOpenAIVoiceModelDrift("test-key");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ws-realtime known-voice-models canary detection", () => {
  it("flags a new voice family whose id lacks the 'realtime' substring (gpt-live-*)", async () => {
    const { unknown } = await detectRepresentative();

    // The whole point: an UNCLASSIFIED gpt-live-* family is surfaced as unknown
    // drift even though its id carries no "realtime" substring.
    expect(unknown).toContain("gpt-live-1-mini");
    // ...and the classified sibling does NOT false-positive.
    expect(unknown).not.toContain("gpt-live-1");
  });

  it("does not flag legitimately-known voice/audio models (no false positives)", async () => {
    const { unknown } = await detectRepresentative();

    // Every known-voice model in the payload stays green.
    for (const known of [
      "gpt-realtime",
      "gpt-realtime-2.1",
      "gpt-realtime-mini",
      "gpt-audio-mini",
      "gpt-4o-transcribe",
      "whisper-1",
      "gpt-4o-realtime-preview",
      "tts-1",
    ]) {
      expect(isKnownVoiceModelFamily(known)).toBe(true);
      expect(unknown).not.toContain(known);
    }
  });

  it("does not flag dated-snapshot / build-tag variants of known families", async () => {
    // Regression guard for live Drift Tests run 28968203340: these 7 real ids
    // were flagged as critical drift by the pre-normalization id-set matcher.
    // Family normalization collapses each onto an already-known family, so none
    // may appear in `unknown`.
    const { unknown } = await detectRepresentative();
    for (const snapshot of KNOWN_FAMILY_SNAPSHOTS) {
      expect(unknown).not.toContain(snapshot);
    }
  });

  it("normalizes dated snapshots and build tags onto their family", () => {
    // Dated snapshot `-YYYY-MM-DD` and build tag `-NNN`/`-NNNN` are stripped.
    // normalizeVoiceModelFamily is module-private; it is exactly this primitive
    // (pinned in logic-pin.test.ts), and isKnownVoiceModelFamily applies it.
    expect(normalizeModelFamily("tts-1-1106", "openai")).toBe("tts-1");
    expect(normalizeModelFamily("tts-1-hd-1106", "openai")).toBe("tts-1-hd");
    expect(normalizeModelFamily("gpt-audio-2025-08-28", "openai")).toBe("gpt-audio");
    expect(normalizeModelFamily("gpt-4o-mini-transcribe-2025-12-15", "openai")).toBe(
      "gpt-4o-mini-transcribe",
    );
    expect(normalizeModelFamily("gpt-4o-mini-tts-2025-03-20", "openai")).toBe("gpt-4o-mini-tts");
    for (const snapshot of KNOWN_FAMILY_SNAPSHOTS) {
      expect(isKnownVoiceModelFamily(snapshot)).toBe(true);
    }
    // A single-digit trailing tag is NOT a build tag, so neither id collapses
    // onto a shorter key. `gpt-live-1` is a classified family as of 2026-09-10;
    // `gpt-live-1-mini` is not, and must remain flaggable — over-stripping it
    // onto `gpt-live-1` would silence it.
    expect(normalizeModelFamily("gpt-live-1", "openai")).toBe("gpt-live-1");
    expect(normalizeModelFamily("gpt-live-1-mini", "openai")).toBe("gpt-live-1-mini");
    expect(isKnownVoiceModelFamily("gpt-live-1")).toBe(true);
    expect(isKnownVoiceModelFamily("gpt-live-1-mini")).toBe(false);
  });

  it("is byte-identical to the shared normalizeModelFamily(id, 'openai') primitive", async () => {
    // Characterization guard for the A3.2 equivalence refactor: normalizeVoiceModelFamily
    // is a thin (now module-private) wrapper over normalizeModelFamily(id, "openai").
    // Observed through its consumers: detection must flag exactly the voice ids whose
    // PRIMITIVE-normalized family is outside the seed set, and the seed set must be
    // identical to re-seeding it through the shared primitive.
    const known = listKnownVoiceModelFamilies();
    const { unknown } = await detectRepresentative();
    expect(unknown).toEqual(
      REPRESENTATIVE_MODELS.filter(isVoiceModelId).filter(
        (id) => !known.includes(normalizeModelFamily(id, "openai")),
      ),
    );
    const reseeded = new Set(known.map((f) => normalizeModelFamily(f, "openai")));
    expect(known).toEqual([...reseeded].sort());
  });

  it("does not flag non-voice chat/image/embedding models as voice drift", async () => {
    const { candidateModels, unknown } = await detectRepresentative();

    for (const nonVoice of [
      "gpt-4o",
      "gpt-4o-mini",
      "gpt-5",
      "gpt-5-mini",
      "o1",
      "o3-mini",
      "chatgpt-4o-latest",
      "dall-e-3",
      "text-embedding-3-large",
      "text-embedding-3-small",
      "omni-moderation-latest",
    ]) {
      expect(isVoiceModelId(nonVoice)).toBe(false);
      expect(candidateModels).not.toContain(nonVoice);
      expect(unknown).not.toContain(nonVoice);
    }
  });

  it("reports GA realtime presence when a GA model exists", async () => {
    const { hasGA } = await detectRepresentative();
    expect(hasGA).toBe(true);
  });

  it("the unclassified gpt-live-* is the ONLY unknown in the representative payload", async () => {
    // Confirms the matcher is neither too narrow (misses gpt-live-*) nor too
    // broad (drags in non-voice models). The unknown set is exactly the one
    // family that is still unclassified.
    const { unknown } = await detectRepresentative();
    expect([...unknown].sort()).toEqual(["gpt-live-1-mini"]);
  });
});
