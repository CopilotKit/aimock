# New / unclassified model family: gemini-3.8-flash-lite-tts

Provider: gemini
Detected: 2026-09-24
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

Decision: EXCLUDE (applied 2026-10-02 — excludeFamilies.gemini in
`src/__tests__/drift/model-registry.ts`, with the `excludeFamilies.gemini`
re-pin in `src/__tests__/drift/logic-pin.test.ts`, plus the static Gemini
/models wave in `src/__tests__/drift/models.drift.ts`).

Rationale: text-to-speech, the same category as the enumerated
`gemini-2.5-flash-preview-tts` / `gemini-2.5-pro-preview-tts` excludes and the
pattern-excluded `gemini-3.1-flash-tts-preview`. The id ends in `-tts`, not
`-preview`, so PREVIEW_FAMILY cannot reach it and it must be enumerated.

Evidence (live probe of this exact id, 2026-10-02):
`GET v1beta/models/gemini-3.8-flash-lite-tts` returned 200 with
`displayName: "Gemini 3.8 Flash Lite TTS"`, `inputTokenLimit: 8192` (the text
tier `gemini-3.8-flash` declares 1048576; `gemini-2.5-flash-preview-tts`
declares 8192), `outputTokenLimit: 16384`, and `supportedGenerationMethods:
[generateContent, countTokens, batchGenerateContent]`. The list includes
`generateContent` (it is the text tier's list minus `createCachedContent`), so a
methods-only rule would argue INCLUDE, and the methods list is not the deciding
fact (same trap as `lyria-3.5`). A plain text `generateContent` call to
`gemini-3.8-flash-lite-tts` returned 200 with one `inlineData` part,
`mimeType: "audio/wav"`, no text part, and `candidatesTokensDetails`
`modality: "AUDIO"`. It emits audio, not a text turn.

No `knownVoiceModelFamilies` pairing is needed: that seed set is watched only by
the OpenAI realtime canary (ws-realtime.drift.ts reads `listOpenAIModels`), and
the id does not declare `bidiGenerateContent`, so the Gemini Live leg does not
select it.
