# New / unclassified model family: claude-sonnet-5-5

Provider: anthropic
Detected: 2026-09-29
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

Decision: INCLUDE (applied 2026-10-02 — includeFamilies.anthropic in
`src/__tests__/drift/model-registry.ts`, with the `includeFamilies.anthropic`
re-pin in `src/__tests__/drift/logic-pin.test.ts`, plus the static Anthropic
/models wave in `src/__tests__/drift/models.drift.ts`).

Rationale: Claude Sonnet 5.5, a point release of the already-included
`claude-sonnet-5`, exactly as `claude-sonnet-4-5` is of `claude-sonnet-4`.

Evidence (live, 2026-10-02): `GET /v1/models/claude-sonnet-5-5` returned 200
with `display_name: "Claude Sonnet 5.5"`, `line: "sonnet"`,
`created_at: 2026-09-28T00:00:00Z`, and a `capabilities` object declaring
image_input, pdf_input, structured_outputs, thinking (adaptive), batch and
citations as supported. A minimal `POST /v1/messages` returned 200,
`stop_reason: "end_turn"`, and a text content block.
