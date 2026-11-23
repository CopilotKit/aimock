# New / unclassified model family: gpt-6-sol

Provider: openai
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

Decision: INCLUDE (applied 2026-09-23 — includeFamilies.openai in
`src/__tests__/drift/model-registry.ts`, with the `includeFamilies.openai`
re-pin in `src/__tests__/drift/logic-pin.test.ts`, plus the static OpenAI
/models wave in `src/__tests__/drift/models.drift.ts`).

Rationale: gpt-6 named variant (text chat). It is the gpt-6 generation of the
already-included `gpt-5.6-sol`, and a sibling of the already-included
`gpt-6-astra`. Listed on the same day as `gpt-6-luna`.

First classified by lineage on 2026-09-23: no probe was run then, and the
drift-sync run that surfaced it (35827604040) records only the family key. The
same named-variant scheme is already included one generation back
(`gpt-5.6-luna` / `gpt-5.6-sol` / `gpt-5.6-terra`), and the first gpt-6 named
variant, `gpt-6-astra`, was probe-verified as plain text chat.

Evidence (live, 2026-10-05), which confirms the lineage call:
`GET /v1/models/gpt-6-sol` returned 200 with `id: "gpt-6-sol"`, `object: "model"`,
`created: 1789405937`, `owned_by: "system"`, `shutdown_date: null`. There is
no capability field, so the listing cannot decide this. A minimal
`POST /v1/chat/completions` with `model: "gpt-6-sol"` returned 200,
`object: "chat.completion"`, `finish_reason: "stop"`, and a real assistant text
turn. That is the same shape `gpt-6-astra` returned. The name carries no image /
audio / realtime / transcribe / tts / search token that would put it in
an excluded cluster.
