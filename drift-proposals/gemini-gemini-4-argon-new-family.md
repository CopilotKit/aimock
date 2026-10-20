# New / unclassified model family: gemini-4-argon

Provider: gemini
Detected: 2026-10-14
Status: RESOLVED — decision recorded below and applied to the registry

This model family appeared in a live /models listing but matches no classification rule (include, exclude, -preview, gemma). drift-sync never silently classifies a new family.

## Decision
<!-- drift-sync never auto-classifies a new family. A HUMAN decides, by
     changing the line below to either:

       Decision: include   — aimock mocks this family on the chat surface
       Decision: exclude   — wrong modality / retired / preview; not ours

     The NEXT drift-sync run then applies the mechanical registry edit to
     includeFamilies or excludeFamilies respectively, and re-pins that
     set's membership checksum in the same commit (still zero-LLM: this
     is a human-authored decision, not generated code).

     ONE EXCEPTION, and it is the common one for `exclude`: a VOICE/AUDIO
     family (realtime / audio / live / transcribe / whisper / voice / tts)
     is watched by a SECOND canary whose seed set — knownVoiceModelFamilies
     in src/__tests__/drift/voice-models.ts — is a deliberately disjoint
     surface drift-sync does not write. Classifying such a family in the
     registry alone leaves that canary red, so the run would gate-fail and
     revert, nightly, forever. drift-sync therefore does NOT auto-apply it:
     it drops a `-voice-seed-set.md` note and a human makes both edits in
     one reviewed commit. -->
Decision: INCLUDE (applied 2026-10-20 — includeFamilies.gemini in
`src/__tests__/drift/model-registry.ts`, with the `includeFamilies.gemini`
re-pin in `src/__tests__/drift/logic-pin.test.ts`, plus the static Gemini
/models wave in `src/__tests__/drift/models.drift.ts`).

Rationale: GA text chat, classified on the live listing plus a live probe, not
on the name. "argon" is a named variant of a new generation and carries no
modality signal (the `gpt-6-astra` precedent).

- Listing (2026-10-20): `displayName` and `description` both "Gemini 4 Argon",
  with no preview, experimental, confidential or EAP marker.
  `supportedGenerationMethods: [generateContent, countTokens,
  batchGenerateContent]`, `inputTokenLimit: 1048576`, `outputTokenLimit:
  32768`, `thinking: true`. No `bidiGenerateContent` (not a Live / native-audio
  surface), no `embedContent`, no `predict`.
- Probe (2026-10-20): a plain text `generateContent` call returned **HTTP 200**
  with a text part, `finishReason: "STOP"`, `modelVersion: "gemini-4-argon"` and
  `candidatesTokensDetails` `modality: "TEXT"`. The included `gemini-3.8-flash`
  probed the same way in the same run returned the same shape.

It is the text surface aimock mocks. Not a voice/audio family (no realtime /
audio / live / transcribe / whisper / voice / tts token), so no
`knownVoiceModelFamilies` edit is needed.
