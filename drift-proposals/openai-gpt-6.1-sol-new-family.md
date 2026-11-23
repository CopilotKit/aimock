# New / unclassified model family: gpt-6.1-sol

Provider: openai
Detected: 2026-09-30
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

Decision: INCLUDE (applied 2026-10-02 — includeFamilies.openai in
`src/__tests__/drift/model-registry.ts`, with the `includeFamilies.openai`
re-pin in `src/__tests__/drift/logic-pin.test.ts`, plus the static OpenAI
/models wave in `src/__tests__/drift/models.drift.ts`).

Rationale: gpt-6.1 point release of the included `gpt-6-sol`. The normalizer
keeps the `.1` version token, so it is its own family and must be enumerated.

Evidence (live, 2026-10-02): `GET /v1/models/gpt-6.1-sol` returned 200 with
`id`, `object`, `created: 1790552874`, `owned_by: "system"`,
`shutdown_date: null` — no capability field. A minimal
`POST /v1/chat/completions` with `model: "gpt-6.1-sol"` returned 200,
`object: "chat.completion"`, `finish_reason: "stop"`, and a real assistant text
turn. It is text chat on the surface aimock mocks.
