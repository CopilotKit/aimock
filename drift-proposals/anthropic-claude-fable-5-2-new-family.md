# New / unclassified model family: claude-fable-5-2

Provider: anthropic
Detected: 2026-11-10
Status: RESOLVED — decision recorded below and applied to the registry

This model family appeared in a live /models listing but matches no classification rule (include, exclude, -preview, gemma). drift-sync never silently classifies a new family.

## Decision

<!-- drift-sync never auto-classifies a new family. A HUMAN decides by
     setting the Decision line. drift-sync reads this note only while the
     family is still unclassified; once the registry classifies it, the
     note is a record, not an instruction. -->

Decision: include (applied 2026-11-10 — includeFamilies.anthropic in
`src/__tests__/drift/model-registry.ts`, the static Anthropic /models wave in
`src/__tests__/drift/models.drift.ts`, and the `includeFamilies.anthropic`
re-pin in `src/__tests__/drift/logic-pin.test.ts`).

Rationale: aimock mocks this family on the chat surface. Claude Fable 5.2 is
the next point release of the already-included `claude-fable-5`, as
`claude-fable-5-1` (INCLUDE) is. Text chat on /v1/messages; not a voice/audio
family, so no knownVoiceModelFamilies pairing.

Evidence: classified by lineage and a maintainer decision. No live probe was
run. drift-sync first saw it in the live Anthropic /models listing on
2026-11-10 (Fix Drift run 42768106181) and routed it to needs-human PR #602.
