# New / unclassified model family: gemini-4-hydrogen

Provider: gemini
Detected: 2026-11-13
Status: RESOLVED — decision recorded below and applied to the registry

This model family appeared in a live /models listing but matches no classification rule (include, exclude, -preview, gemma). drift-sync never silently classifies a new family.

## Decision

<!-- drift-sync never auto-classifies a new family. A HUMAN decides by
     setting the Decision line. drift-sync reads this note only while the
     family is still unclassified; once the registry classifies it, the
     note is a record, not an instruction. -->

Decision: INCLUDE (applied 2026-11-13 — includeFamilies.gemini in
`src/__tests__/drift/model-registry.ts`, with the `includeFamilies.gemini`
re-pin in `src/__tests__/drift/logic-pin.test.ts`, plus the static Gemini
/models wave in `src/__tests__/drift/models.drift.ts` and behavioural coverage
in `src/__tests__/drift/text-drift.test.ts`).

Rationale: GA text chat, classified on the live listing plus a live probe, not
on the name; this follows its sibling `gemini-4-argon`. Google's Cloud guide
calls Gemini 4 Hydrogen a "short-term generally available (GA) release", with
no allowlist, unlike the access-restricted `gemini-4-carbon` (EXCLUDE).

- Listing (2026-11-13, 9:27 AM PST): `displayName` and `description` both
  "Gemini 4 Hydrogen", with no preview, experimental, confidential or EAP
  marker. `supportedGenerationMethods: [generateContent, countTokens,
  batchGenerateContent]`, `inputTokenLimit: 1048576`, `outputTokenLimit:
  65536`, `thinking: true`. No `bidiGenerateContent` (not a Live / native-audio
  surface), no `embedContent`, no `predict`. Present in the paged /models list
  beside `gemini-4-argon` and `gemini-4-carbon`.
- Probe (2026-11-13, 9:27 AM PST, drift-live-pr run 43472488931 on PR #617, a
  temporary diagnostic since reverted): a plain text `generateContent` call
  returned **HTTP 200** with a text part, `finishReason: "STOP"`,
  `modelVersion: "gemini-4-hydrogen"` and `candidatesTokensDetails` `modality:
  "TEXT"`. The included `gemini-4-argon` probed the same way in the same run
  returned the same shape.

It is the text surface aimock mocks. Not a voice/audio family (no realtime /
audio / live / transcribe / whisper / voice / tts token), so no
`knownVoiceModelFamilies` edit is needed.

First flagged by the scheduled Drift Tests run 43376684576 (2026-11-12,
10:09 PM PST) and routed to needs-human PR #616.
