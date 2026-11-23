# New / unclassified model family: gpt-image-2.6-flare

Provider: openai
Detected: 2026-11-06
Status: RESOLVED — decision recorded below and applied to the registry

This model family appeared in a live /models listing but matches no classification rule (include, exclude, -preview, gemma). drift-sync never silently classifies a new family.

## Decision

<!-- drift-sync never auto-classifies a new family. A HUMAN decides by
     setting the Decision line. drift-sync reads this note only while the
     family is still unclassified; once the registry classifies it, the
     note is a record, not an instruction. -->

Decision: EXCLUDE (applied — excludeFamilies.openai in
`src/__tests__/drift/model-registry.ts`, the static OpenAI /models wave in
`src/__tests__/drift/models.drift.ts`, and the `excludeFamilies.openai`
re-pin in `src/__tests__/drift/logic-pin.test.ts`).

Rationale: wrong modality. `gpt-image-2.6-flare` is the 2.6 point release of the
already-excluded `gpt-image-2.5-flare`, an image-generation model on the
`gpt-image-*` line. It serves /v1/images/generations, not
/v1/chat/completions, so it is not text-generation drift. Not a voice/audio
family, so no knownVoiceModelFamilies edit is needed.
