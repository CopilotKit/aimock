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

EVIDENCE LIMIT, stated plainly: no live `/v1/messages` probe was run for this
one (no Anthropic key was available), and Anthropic's `/v1/models` carries no
capability field (`id` / `display_name` / `created_at` only). The argument is
the one used for `claude-opus-5` (72f85f8) and `claude-fable-5-1`: the family is
on the live listing (drift run 35827604040), its base `claude-opus-5` is
already included, and the canary reported exactly ONE unclassified anthropic
family that run, so every other live id already normalized into
`includeFamilies`.
