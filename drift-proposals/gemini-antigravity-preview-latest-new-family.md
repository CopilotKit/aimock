# New / unclassified model family: antigravity-preview-latest

Provider: gemini
Detected: 2026-09-23
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

Decision: EXCLUDE (applied 2026-09-23 — excludeFamilies.gemini in
`src/__tests__/drift/model-registry.ts`, with the `excludeFamilies.gemini`
re-pin in `src/__tests__/drift/logic-pin.test.ts`, plus the static Gemini
/models wave in `src/__tests__/drift/models.drift.ts`).

Rationale: pre-GA moving alias. The id says both things itself: `-preview`
(aimock does not mock preview surfaces; see PREVIEW_FAMILY) and `-latest` (a
moving alias, not a stable family; same policy as the already-excluded
`gemini-flash-latest` / `gemini-flash-lite-latest` / `gemini-pro-latest`). Its
pinned sibling `antigravity-preview-05` is already auto-excluded by
PREVIEW_FAMILY. This id ends in `-latest`, not `-preview` or
`-preview-<digits>`, so that rule cannot reach it and it must be enumerated.

Not a voice/audio family (no realtime / audio / live / transcribe / whisper /
voice / tts token), so no `knownVoiceModelFamilies` edit is needed.

Also proposed by the earlier needs-human PR #475 (2026-09-22), which carried
only this note.
