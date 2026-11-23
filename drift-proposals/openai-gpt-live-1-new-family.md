# Model family coverage: gpt-live-1

Provider: openai
Detected: 2026-09-10
Status: IMPLEMENTED — primary Live WebSocket coverage added; text-generation classification unchanged

The original note resolved a new family found in the live `/models` listing.
The implementation now covers the primary `GET /v1/live/sessions` WebSocket
surface. This status describes the implementation in this change, not a merged
PR or a published release.

## Classification remains separate from endpoint coverage

The 2026-09-10 classification was applied by hand to both listing surfaces:

- `excludeFamilies.openai` in `src/__tests__/drift/model-registry.ts` excludes
  `gpt-live-1` from text-generation model drift.
- `knownVoiceModelFamilies` in `src/__tests__/drift/voice-models.ts` accounts for
  the family in voice-model discovery.
- `src/__tests__/drift/logic-pin.test.ts` pins both memberships, and
  `src/__tests__/drift/models.drift.ts` includes the model in its static listing.

These entries stay in place. Live voice support does not make `gpt-live-1` a
Chat Completions model or route it through the Realtime API. Membership in these
sets classifies discovery results; it does not describe which endpoints aimock
implements.

This note deliberately has no machine-readable decision line. The
`parseProposalDecision` parser in `scripts/drift-sync.ts` therefore returns
`pending`; that is the automation verdict, not an unresolved coverage decision.
Do not add an inclusion verdict to enable Live coverage: it would classify the
family for the wrong surface.

## Primary WebSocket coverage

`src/ws-live.ts` implements the primary `/v1/live/sessions` WebSocket upgrade.
The implementation includes:

- `onLive` fixture registration and fixture-file loading for client and managed
  backend modes, with validated startup configuration and the supported
  instructions update.
- Full-duplex PCM audio and event replay, client-event barriers, fresh connection
  IDs, and preserved references. Managed tool results and explicit continuation
  follow the recorded event sequence.
- Provider forwarding and sanitized transcript recording for offline replay,
  with bounded sessions and test-scoped cleanup. Audio and transcript content
  remain in exported recordings; unsafe exports fail instead of silently
  deleting semantic content.
- A dedicated `openai-live` drift surface and separate client and managed
  lifecycle canaries in `src/__tests__/drift/ws-live.drift.ts`, with scenario
  definitions in `src/__tests__/drift/live-scenarios.ts`. Collector attribution
  is independent of Realtime.

The canaries exercise provider sessions and local fixture replay. Missing
credentials produce an explicit skip; configured authentication or access
failures do not count as successful coverage. Passing a run establishes the
checked schema and lifecycle invariants, not identical generated speech,
wording, chunk boundaries, or latency. Replay uses authored or captured audio;
aimock does not synthesize speech.

Supported examples are in `fixtures/openai-live-client.json` and
`fixtures/openai-live-managed.json`. This coverage excludes POST SDP/WebRTC,
sideband connections, session fork/download operations, and explicit backend
cancellation. Recorded conversational interruption does not establish acoustic
playback behavior on a physical device.

## `gpt-live-1-mini` remains unclassified

Only `gpt-live-1` was classified. `gpt-live-1-mini` remains the deliberately
unknown family used by `src/__tests__/ws-realtime-canary.test.ts` and
`src/__tests__/drift/logic-pin.test.ts`. It checks that discovery recognizes a
voice ID without the word “realtime” and that the known family does not absorb
longer family names. A real listing of this family still requires its own
classification decision; Live endpoint coverage does not approve it implicitly.

## Historical automation constraint

The original note warned that a registry-only edit for a new voice family could
leave the voice canary failing. Current `scripts/drift-sync.ts` guards that case
with `needsVoiceSeedSetEdit`: an unknown voice family requires the voice seed
update before automation can apply its classification. The two sets still need
coordinated updates; this coverage change does not alter that policy.
