# New / unclassified model family: gpt-transcribe

Provider: openai
Detected: 2026-07-29
Status: RESOLVED — decision recorded below and applied to the registry

This model family appeared in a live /models listing but matches no classification rule (include, exclude, -preview, gemma). drift-sync never silently classifies a new family.

## Decision

<!-- drift-sync never auto-classifies a new family. To approve adding it to
     the registry, change the line below to `Decision: include` — the NEXT
     drift-sync run will then apply the mechanical registry edit (still
     zero-LLM: this is a human-authored decision, not generated code). -->

<!-- NOTE: the `Decision: include` marker documented below is drift-sync's
     AUTOMATED path, and it writes EXCLUSIVELY into `includeFamilies`
     (scripts/drift-sync.ts: addFamilyLiteralInSource(..., "includeFamilies", ...)).
     There is no automated exclude path, so an EXCLUDE decision is recorded here
     in prose and applied by hand — writing `include` would misclassify. -->

Decision: EXCLUDE (applied 2026-08-03 — excludeFamilies.openai in
`src/__tests__/drift/model-registry.ts`, plus knownVoiceModelFamilies in
`src/__tests__/drift/voice-models.ts`).

Rationale: wrong modality — `gpt-transcribe` is audio->text only
(/v1/audio/transcriptions + realtime transcription sessions) and never answers
on /v1/chat/completions, so it is not text-generation drift. Mirrors the
existing gpt-4o-transcribe / whisper-1 / gpt-realtime-\* entries.
