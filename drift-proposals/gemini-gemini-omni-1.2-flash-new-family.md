# New / unclassified model family: gemini-omni-1.2-flash

Provider: gemini
Detected: 2026-11-06
Status: RESOLVED — decision recorded below and applied to the registry

This model family appeared in a live /models listing but matches no classification rule (include, exclude, -preview, gemma). drift-sync never silently classifies a new family.

## Decision

<!-- drift-sync never auto-classifies a new family. A HUMAN decides by
     setting the Decision line. drift-sync reads this note only while the
     family is still unclassified; once the registry classifies it, the
     note is a record, not an instruction. -->

Decision: EXCLUDE (applied — excludeFamilies.gemini in
`src/__tests__/drift/model-registry.ts`, the static Gemini /models wave in
`src/__tests__/drift/models.drift.ts`, and the `excludeFamilies.gemini`
re-pin in `src/__tests__/drift/logic-pin.test.ts`).

Rationale: non-text generative media, the same decision as
`gemini-omni-1.1-flash`. Google's model card for the Gemini Omni Flash line
(`/docs/models/gemini-omni-flash`) lists `gemini-omni-1.2-flash` as the stable
current version and says `gemini-omni-1.1-flash` routes to it on 2026-12-03.
It is a video generation and editing model: input text, image and video;
output video with native audio, plus text.

The text output is new in 1.2 (1.1 output video only). It comes with a video
turn, not a chat turn, so it does not make the family a text-generation
surface. `gemini-nano-banana-2.1` (output image AND text) was excluded on the
same grounds.
