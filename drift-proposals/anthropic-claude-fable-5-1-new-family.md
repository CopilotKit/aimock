# New / unclassified model family: claude-fable-5-1

Provider: anthropic
Detected: 2026-09-05
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

Decision: INCLUDE (applied 2026-09-08 — includeFamilies.anthropic in
`src/__tests__/drift/model-registry.ts`, with the `includeFamilies.anthropic`
re-pin in `src/__tests__/drift/logic-pin.test.ts`).

Rationale: GA text chat, measured. When this was classified (2026-09-08),
Anthropic's `/v1/models` carried no capability field (`id` / `display_name` /
`created_at` only), so the `supportedGenerationMethods` evidence used for the
Gemini entries had no equivalent here. (Re-checked live 2026-10-05:
`GET /v1/models/claude-fable-5-1` returns HTTP 200 and the entry now carries a
`capabilities` object — `batch`, `citations`, `code_execution`,
`context_management`, `effort`, `image_input`, `pdf_input`,
`structured_outputs`, `thinking` — plus `line`, `max_input_tokens` and
`max_tokens`. None of those keys is a generation-method list, so the
classification still rests on `/v1/messages`.) `/v1/messages` answers the
question directly: a minimal call
(`max_tokens: 16`, one user turn) returns **HTTP 200** with
`stop_reason: "end_turn"`, `model: "claude-fable-5-1"` and a real assistant
turn. Its listing entry is `display_name: "Claude Fable 5.1"`,
`created_at: 2026-08-28`, i.e. the point release of the already-included
`claude-fable-5` ("Claude Fable 5", 2026-06-07) — the same relationship
`claude-opus-4-1` has to `claude-opus-4`.

Corroborating: all 11 ids on the live listing (2026-09-08) are text-chat Claude families
(`claude-fable-5-1`, `claude-opus-5`, `claude-sonnet-5`, `claude-fable-5`,
`claude-opus-4-8`, `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-opus-4-6`,
`claude-opus-4-5`, `claude-haiku-4-5`, `claude-sonnet-4-5`), and the canary
reported exactly ONE unclassified anthropic family — so every other live id
already normalized into `includeFamilies`.
