# New / unclassified model family: gemini-4-carbon

Provider: gemini
Detected: 2026-11-10
Status: RESOLVED — decision recorded below and applied to the registry

This model family appeared in a live /models listing but matches no classification rule (include, exclude, -preview, gemma). drift-sync never silently classifies a new family.

## Decision

<!-- drift-sync never auto-classifies a new family. A HUMAN decides by
     setting the Decision line. drift-sync reads this note only while the
     family is still unclassified; once the registry classifies it, the
     note is a record, not an instruction. -->

Decision: EXCLUDE (applied — excludeFamilies.gemini in
`src/__tests__/drift/model-registry.ts`, with the `excludeFamilies.gemini`
re-pin in `src/__tests__/drift/logic-pin.test.ts`).

Rationale: access-restricted, not GA. Google announced Gemini 4 Carbon on
2026-10-28 for cyber defenders in the Fairwind Program first, then trusted
partners, with no GA date. aimock does not mock pre-GA surfaces; this follows
`gemini-3.7-flash-video-understanding-eap` (excluded for access status, not
capability). Carbon is a text chat/reasoning model, so at GA flip it to
INCLUDE like its sibling `gemini-4-argon`.

First seen in PR drift-live-pr runs on 2026-11-10 (12:53 PM PST); absent from
the scheduled Drift Tests run 42766538763 (2026-11-09, 10:08 PM PST).
