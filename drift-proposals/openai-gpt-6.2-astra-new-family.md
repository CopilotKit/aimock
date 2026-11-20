# New / unclassified model family: gpt-6.2-astra

Provider: openai
Detected: 2026-11-17
Status: RESOLVED — decision recorded below and applied to the registry

This model family appeared in a live /models listing but matches no classification rule (include, exclude, -preview, gemma). drift-sync never silently classifies a new family.

## Decision

<!-- drift-sync never auto-classifies a new family. A HUMAN decides by
     setting the Decision line. drift-sync reads this note only while the
     family is still unclassified; once the registry classifies it, the
     note is a record, not an instruction. -->

Decision: INCLUDE (applied 2026-11-20 — includeFamilies.openai in
`src/__tests__/drift/model-registry.ts`, with the `includeFamilies.openai`
re-pin in `src/__tests__/drift/logic-pin.test.ts`, plus the static OpenAI
/models wave in `src/__tests__/drift/models.drift.ts` and behavioural coverage
in `src/__tests__/drift/text-drift.test.ts`).

Rationale: gpt-6.2 point release of the included `gpt-6-astra` line, classified on a
live probe, not on the name. The normalizer keeps the `.2` version token, so
it is its own family and must be enumerated.

- Listing (2026-11-20, 11:11 AM PST): `GET /v1/models/gpt-6.2-astra` returned 200
  with `id`, `object: "model"`, `created: 1793430042 (2026-10-31)`,
  `owned_by: "system"`, `shutdown_date: null`, with no capability field: the
  same shape as `gpt-6.1-sol`.
- Probe (2026-11-20, 11:11 AM PST, drift-live-pr run 44799305557 on PR #627, a
  temporary diagnostic since reverted): a minimal `POST /v1/chat/completions`
  returned **HTTP 200**, `object: "chat.completion"`, `finish_reason: "stop"`
  and an assistant text turn ("pong"). `POST /v1/responses` returned **HTTP
  200**, `status: "completed"`, one `message` output with an `output_text`
  part ("pong"). The included `gpt-6.1-sol` probed the same way in the same
  run returned the same shape.

It is the text surface aimock mocks. Not a voice/audio family (no realtime /
audio / live / transcribe / whisper / voice / tts token), so no
`knownVoiceModelFamilies` edit is needed.

First flagged by the scheduled Drift Tests run 44249205468 (2026-11-17,
10:09 PM PST) and routed to needs-human PR #625.
