# Resolved model family: gemini-nano-banana-2.1

Provider: gemini
Detected: 2026-10-07
Status: RESOLVED — registry exclusion applied

Decision: exclude

Google identifies this stable model as image generation and conversational editing,
succeeding Gemini 3.1 Flash Image. It outputs **Image and Text**; exclusion follows
the existing image-generation family policy, not an assertion that it cannot emit
text. Function calling, structured outputs, and Live API are unsupported.

Source: [official model card](https://ai.google.dev/gemini-api/docs/models/gemini-nano-banana-2.1?hl=en),
updated 2026-10-06, checked 2026-10-07.

Applied on 2026-10-07: added the exact family to `excludeFamilies.gemini` in
`src/__tests__/drift/model-registry.ts`, updated only its membership checksum in
`logic-pin.test.ts`, and added the provider-reported ID to the recorded Gemini
wave in `models.drift.ts`. The wave asserts exclusion and absence from inclusion.

The source listing was reported by [drift-sync run 37582645525](https://github.com/CopilotKit/aimock/actions/runs/37582645525).
A local replay of its reported candidate through the real drift-sync selector and
the recorded Gemini wave both failed before classification and passed afterward.
This replay does not claim a fresh live HTTP listing or generation request.
