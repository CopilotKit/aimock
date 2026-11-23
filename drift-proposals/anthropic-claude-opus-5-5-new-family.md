# New / unclassified model family: claude-opus-5-5

Provider: anthropic
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

Decision: INCLUDE (applied 2026-09-23 — includeFamilies.anthropic in
`src/__tests__/drift/model-registry.ts`, with the `includeFamilies.anthropic`
re-pin in `src/__tests__/drift/logic-pin.test.ts`, plus the static Anthropic
/models wave in `src/__tests__/drift/models.drift.ts`).

Rationale: Claude Opus 5.5, a point release of the already-included
`claude-opus-5`, exactly as `claude-opus-4-5` is of `claude-opus-4` and
`claude-fable-5-1` is of `claude-fable-5`. Anthropic ships no non-text model
line on `/v1/models`: every Claude family in the registry is text chat on
`/v1/messages`, and the only anthropic excludes are retired ids.

First classified by lineage on 2026-09-23: no probe was run then.

Evidence (live, 2026-10-05), which confirms the lineage call:
`GET /v1/models/claude-opus-5-5` returned 200 with `type: "model"`,
`display_name: "Claude Opus 5.5"`, `line: "opus"`,
`created_at: 2026-09-21T16:24:00Z`, `max_input_tokens: 1000000`,
`max_tokens: 128000`, and a `capabilities` object declaring batch, citations,
code_execution, context_management, effort, image_input, pdf_input,
structured_outputs and thinking (adaptive) as supported. A minimal
`POST /v1/messages` (`max_tokens: 16`, one user turn) returned 200,
`type: "message"`, `stop_reason: "end_turn"`, and one text content block.
