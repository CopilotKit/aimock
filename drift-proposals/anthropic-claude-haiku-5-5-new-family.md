# New / unclassified model family: claude-haiku-5-5

Provider: anthropic
Detected: 2026-10-08
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

Decision: INCLUDE (applied 2026-10-09 — includeFamilies.anthropic in
`src/__tests__/drift/model-registry.ts`, with the `includeFamilies.anthropic`
re-pin in `src/__tests__/drift/logic-pin.test.ts`, plus the static Anthropic
/models wave in `src/__tests__/drift/models.drift.ts`).

Rationale: Claude Haiku 5.5, the next point release of the Haiku line after
the already-included `claude-haiku-4-5`, as `claude-opus-5-5` and
`claude-sonnet-5-5` (both INCLUDE) are of theirs. Text chat on /v1/messages;
not a voice/audio family, so no knownVoiceModelFamilies pairing.

Evidence: classified by lineage + official docs. No live probe was run. Anthropic's
models overview (https://platform.claude.com/docs/en/docs/about-claude/models/overview,
fetched 2026-10-09) lists Claude Haiku 5.5 as a current model: API id and alias
`claude-haiku-5-5`, text and image input, text output, tool use, adaptive
thinking, 1M context, 128K max output, retirement not sooner than 2027-10-07.
drift-sync first saw it in the live Anthropic /models listing on 2026-10-08
(run 37738956337) and again on 2026-10-09 (run 37894774122).
