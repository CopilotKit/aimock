# New / unclassified model family: gpt-live-1.1

Provider: openai
Detected: 2026-11-19
Status: RESOLVED — decision recorded below and applied to the registry

This model family appeared in a live /models listing but matches no classification rule (include, exclude, -preview, gemma). drift-sync never silently classifies a new family.

## Decision

<!-- drift-sync never auto-classifies a new family. A HUMAN decides by
     setting the Decision line. drift-sync reads this note only while the
     family is still unclassified; once the registry classifies it, the
     note is a record, not an instruction. -->

Decision: EXCLUDE (applied 2026-11-20 — excludeFamilies.openai in
`src/__tests__/drift/model-registry.ts` AND knownVoiceModelFamilies in
`src/__tests__/drift/voice-models.ts`, in the same commit, with the
`excludeFamilies.openai` and `knownVoiceModelFamilies` re-pins in
`src/__tests__/drift/logic-pin.test.ts`, plus the static OpenAI /models wave
in `src/__tests__/drift/models.drift.ts`).

Rationale: a point release of the full-duplex voice line, so it follows
`gpt-live-1` (EXCLUDE). The normalizer keeps the `.1` version token, so it
does not collapse onto `gpt-live-1` and must be enumerated. It is a VOICE
family, so both disjoint sets need the entry: `excludeFamilies.openai`
silences the `/models` family canary, and `knownVoiceModelFamilies` silences
the realtime known-models canary. Membership is a classification of the
listing only; it does not claim aimock mocks it. `src/ws-live.ts` is
unchanged.

- Listing (2026-11-20, 11:11 AM PST, drift-live-pr run 44799305557 on PR #627,
  a temporary diagnostic since reverted): `GET /v1/models/gpt-live-1.1`
  returned 200 with `id`, `object: "model"`, `created: 1794980943`
  (2026-11-17), `owned_by: "system"`, `shutdown_date: null`.

First flagged by the scheduled Drift Tests run 44685766665 (2026-11-19,
10:09 PM PST), both as a `/models` family critical and as an OpenAI Realtime
known-models canary critical (`knownVoiceModelFamilies`), and routed to
needs-human PR #625.
