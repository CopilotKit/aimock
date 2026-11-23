# New / unclassified model family: aurora-red-alpha

Provider: openai
Detected: 2026-10-18
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
Decision: EXCLUDE (applied 2026-10-20 — excludeFamilies.openai in
`src/__tests__/drift/model-registry.ts`, with the `excludeFamilies.openai`
re-pin in `src/__tests__/drift/logic-pin.test.ts`, plus the static OpenAI
/models wave in `src/__tests__/drift/models.drift.ts`).

Rationale: pre-GA codename. The Drift Tests run on 2026-10-18 (run
39103216353) reported `aurora-red-alpha`, together with `aurora-blue-alpha` and `aurora-green-alpha`, as an
unclassified family on the live OpenAI listing. drift-sync did not see it
that day and wrote no note, so this note is written by hand with the
decision. By the next run the id was gone. On 2026-10-20
`GET /v1/models/aurora-red-alpha` returns **404** `model_not_found` ("does not
exist"), and so does `/v1/chat/completions` for `aurora-blue-alpha`. No
capability can be probed.

The id itself declares the pre-GA status (`-alpha`). That is the same
policy PREVIEW_FAMILY applies to `-preview` and the
`gemini-3.7-flash-video-understanding-eap` entry applies to early access:
aimock does not mock pre-GA surfaces. No rule matches `-alpha`, so the id is
enumerated. The entry also keeps the canary quiet if the id is listed
again. If it comes back as a GA id without `-alpha`, that is a new family
and gets its own decision.

Not a voice/audio family (no realtime / audio / live / transcribe / whisper
/ voice / tts token), so no `knownVoiceModelFamilies` edit is needed.
