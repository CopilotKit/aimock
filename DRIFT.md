# Live API Drift Detection

aimock produces responses shaped like real LLM APIs. Providers change their APIs over time. **Drift** means the mock no longer matches reality — your tests pass against aimock but break against the real API.

## Three-Layer Approach

Drift detection compares three independent sources to triangulate the cause of any mismatch:

| SDK types = Real API? | Real API = aimock? | Diagnosis                                                            |
| --------------------- | ------------------ | -------------------------------------------------------------------- |
| Yes                   | No                 | **aimock drift** — response builders need updating                   |
| No                    | No                 | **Provider changed before SDK update** — flag, wait for SDK catch-up |
| Yes                   | Yes                | **No drift** — all clear                                             |
| No                    | Yes                | **SDK drift** — provider deprecated something SDK still references   |

Two-way comparison (mock vs real) can't distinguish between "we need to fix aimock" and "the SDK hasn't caught up yet." Three-way comparison can. OpenAI Live is an explicit exception: its installed SDK has no Live types, so its canary compares supported invariants against frozen provider descriptors and real traffic.

## Running Drift Tests

```bash
# Several providers (each key enables only its own legs)
OPENAI_API_KEY=sk-... ANTHROPIC_API_KEY=sk-... GOOGLE_API_KEY=... pnpm test:drift

# Single provider (others skip automatically)
OPENAI_API_KEY=sk-... pnpm test:drift
```

Environment variables the drift legs read (each one gates only the legs listed; an unset variable skips those legs — reported as skipped, never as a failure):

- `OPENAI_API_KEY` — OpenAI Chat Completions, Responses, Embeddings, Transcription, Realtime WS, Responses WS and OpenAI Live WS legs, plus the OpenAI model check in `models.drift.ts`
- `OPENAI_REALTIME_KEY` — optional; used instead of `OPENAI_API_KEY` for the Realtime WS session probes only
- `ANTHROPIC_API_KEY` — Anthropic Claude Messages legs and capability canaries, plus the Anthropic model check
- `GOOGLE_API_KEY` — Google Gemini, Gemini Embeddings canary, Gemini Interactions and Gemini Live WS legs, plus the Gemini model check
- `COHERE_API_KEY` — Cohere Chat and Cohere Rerank legs
- `OPENROUTER_API_KEY` — OpenRouter chat catalog and video model-family availability legs
- `FAL_KEY` — fal.ai queue lifecycle canary
- `ELEVENLABS_API_KEY` — ElevenLabs API key (the one live `/v1/sound-generation` case; every other ElevenLabs case is offline conformance and runs without it)
- `ARK_API_KEY` — BytePlus Ark authenticated unknown-task canary (the keyless auth-envelope canary runs on every run without it)
- `ARK_BASE_URL` — optional; regional BytePlus Ark base URL (default `https://ark.ap-southeast.bytepluses.com`)
- `OLLAMA_HOST` — URL of a running Ollama daemon; gates the Ollama live leg
- `OLLAMA_MODEL` — optional; model the Ollama leg requests (default `llama3.2`)

Each provider's tests skip independently if its key is not set. You can run drift tests for just one provider.

## Reading Results

### Live coverage vs offline conformance — a green run is NOT "everything checked"

Every surface in `src/__tests__/drift/surface-registry.ts` declares `liveCoverage`, and there is deliberately no default:

- **`"live"`** — at least one `*.drift.ts` leg issues a request to the real vendor (directly, or through `providers.ts` / `ws-providers.ts`). A vendor-side change turns that leg red. This is drift detection.
- **`"none"`** — every emitting leg only drives the LOCAL aimock server and grades its output against a hand-written SDK-shape fixture in this repo. That catches an aimock builder regression; it can **not** catch the vendor changing its wire format. This is offline conformance, not drift detection, and the surface must say why in `coverageNote`.

`drift-report.json` carries an **`unverifiedSurfaces`** array on every run listing the `"none"` surfaces, and the collector prints them. For OpenAI Live, it also includes runtime coverage: missing, skipped, failed or incomplete lifecycle cases leave the surface unverified. Both client and managed lifecycle cases must pass, with no other failed or skipped Live assertions, to remove it from this list. It is written even when empty, so a missing field means "an old report", never "everything was verified". Read a clean run as _"no drift on the surfaces that were actually checked"_ — the `unverifiedSurfaces` list is the rest.

This exists because an omitted declaration used to read as coverage. Four Bedrock surfaces and Vertex AI sat behind `describe.skipIf(!AWS_ACCESS_KEY_ID …)` / `describe.skipIf(!GOOGLE_APPLICATION_CREDENTIALS …)` gates on bodies that make no vendor call at all, and no drift workflow sets those variables — so the cases had never executed while the four surfaces reported as covered and green. The gates are gone (those cases now run unconditionally as offline conformance, and two of them failed the first time they were allowed to run), and `drift-collector.test.ts` re-derives live-capability from the emitting sources, so a `liveCoverage` claim that contradicts the code fails CI in both directions.

Currently offline-only: `bedrock-invoke`, `bedrock-invoke-stream`, `bedrock-converse`, `bedrock-converse-stream`, `vertex-ai`, `images`, `video`, `moderation`, `fal-sync`, `elevenlabs-voice`.

### Severity levels

- **critical** — Test fails. aimock produces a different shape than the real API for a field that both the SDK and real API agree on. This means aimock needs an update.
- **warning** — Test passes. The real API has a field that neither the SDK nor aimock knows about, or the SDK and real API disagree. Usually means a provider added something new.
- **info** — Always passes. Known intentional differences (usage fields are always zero, optional fields aimock omits, etc.).

### Example report output

```
API DRIFT DETECTED: OpenAI Chat Completions (non-streaming text)

  1. [critical] LLMOCK DRIFT — field in SDK + real API but missing from mock
     Path:    usage.completion_tokens_details
     SDK:     object { reasoning_tokens: number }
     Real:    object { reasoning_tokens: number, accepted_prediction_tokens: number }
     Mock:    <absent>

  2. [warning] PROVIDER ADDED FIELD — in real API but not in SDK or mock
     Path:    system_fingerprint
     SDK:     <absent>
     Real:    string
     Mock:    <absent>

  3. [info] MOCK EXTRA FIELD — in mock but not in real API
     Path:    choices[0].logprobs
     SDK:     null | object
     Real:    <absent>
     Mock:    null
```

## Fixing Detected Drift

When a `critical` drift is detected:

1. **Identify the response builder** — the report's `Surface:` line is a slug keyed in `SURFACE_REGISTRY` (`src/__tests__/drift/surface-registry.ts`); that entry's `builderFile` and `builderFunctions` name the file and functions to edit, and the report path tells you which field.

2. **Update the builder** — add or modify the field to match the real API shape.

3. **Run conformance tests** — `pnpm test` to verify existing API conformance tests still pass.

4. **Run drift tests** — `pnpm test:drift` to verify the drift is resolved.

## Model Deprecation

`models.drift.ts` normalizes each provider's live `GET /models` listing to family keys and subtracts the frozen classification in `model-registry.ts`. Two directions fall out of that subtraction: a live family we do not classify (**new family** — see the automated sync below), and a classified family the listing no longer contains (**deprecation**).

**A deprecation needs nothing from you.** The daily sync records it in `deprecatedFamilies` and aimock keeps mocking the family, so clients pinned to a retired model id keep working. The only thing worth doing by hand is the cheap live test model: if `src/__tests__/drift/providers.ts` names a model that no longer exists, the live drift legs cannot run at all, so point them at a current one and re-run `pnpm test:drift`.

**A retired probe model is caught before the run.** Every model a live drift probe pins is listed in `src/__tests__/drift/probe-models.ts`. Before the daily `drift` job runs the suite, `scripts/drift-model-preflight.ts` asks each provider about each one: OpenAI `GET /v1/models/{id}` (`shutdown_date`), Anthropic `GET /v1/models/{id}` (`lifecycle`, `retires_at`), Gemini `GET /v1beta/models/{id}` (404 when gone; no date published), Cohere `GET /v1/models/{id}` (`is_deprecated`) and the OpenRouter listing (`expiration_date`). A model that is gone or past its shutdown date fails the step with `probe model X retired on DATE — update <constant>`, and Slack says "probe model retired", not "API drift". A shutdown date within 30 days (`DRIFT_PREFLIGHT_WARN_DAYS`) is a warning in the job summary and in Slack. Bedrock, Vertex, Ollama and fal models are listed but skipped: the step has no retirement API it can ask for them. Legs that pick their model from the live listing (`resolveLiveModel`) are not listed; they move on their own.

## Adding a New Provider

1. Add the provider's SDK as a devDependency in `package.json`
2. Add shape extraction functions to `src/__tests__/drift/sdk-shapes.ts`
3. Add raw fetch client functions to `src/__tests__/drift/providers.ts`
4. Create `src/__tests__/drift/<provider>.drift.ts` with 4 test scenarios
5. Add model listing function to `providers.ts` and model check to `models.drift.ts`
6. If the provider uses WebSocket, add protocol functions to `ws-providers.ts` and create `ws-<provider>.drift.ts`
7. Register the surface in `SURFACE_REGISTRY` (`src/__tests__/drift/surface-registry.ts`) with `provider`, `builderFile`, `builderFunctions`, `typesFile` and a `liveCoverage` of `"live"` or `"none"` (`"none"` requires a `coverageNote`), and pass that slug as the third argument of every `formatDriftReport` call in the new leg — `formatDriftReport` throws on an unregistered slug, and `drift-collector.test.ts` fails on an emitted slug missing from the registry
8. Update the allowlist in `schema.ts` if needed

## Additional Drift Coverage

`surface-registry.ts` declares 29 surfaces: 19 `liveCoverage: "live"` and 10 `"none"`. Beyond the per-provider chat/completion cases, these endpoints are covered too:

### Additional Endpoint Drift Coverage

| Endpoint                                 | Provider      | Type              | Status                |
| ---------------------------------------- | ------------- | ----------------- | --------------------- |
| POST /v1beta/models/{model}:embedContent | Gemini        | HTTP              | Covered (live canary) |
| POST /v1/images/edits                    | OpenAI        | HTTP (multipart)  | None⁶                 |
| POST /v1/audio/translations              | OpenAI        | HTTP (multipart)  | None⁶                 |
| POST /v1/images/variations               | OpenAI        | HTTP (multipart)  | Excluded²             |
| POST /api/embed, /api/embeddings         | Ollama        | HTTP              | None⁶                 |
| POST /v2/embed                           | Cohere        | HTTP              | None⁶                 |
| POST /v1/sound-generation                | ElevenLabs    | HTTP              | Covered               |
| POST /v1/music                           | ElevenLabs    | HTTP              | Offline (mock only)   |
| POST /v1/music/stream                    | ElevenLabs    | HTTP              | Offline (mock only)   |
| POST /v1/music/plan                      | ElevenLabs    | HTTP              | Offline (mock only)   |
| POST /v1/text-to-speech/{voice_id}       | ElevenLabs    | HTTP              | None³                 |
| POST /v1/text-to-voice/design            | ElevenLabs    | HTTP              | Offline⁴              |
| POST /v1/text-to-voice                   | ElevenLabs    | HTTP              | Offline⁴              |
| GET /v1/voices/{id}                      | ElevenLabs    | HTTP              | None⁵                 |
| DELETE /v1/voices/{id}                   | ElevenLabs    | HTTP              | None⁵                 |
| stream_options.include_usage             | OpenAI        | Streaming feature | None⁶                 |
| x-ratelimit-\* / Retry-After 429         | All providers | Response headers  | None⁶                 |

² **POST /v1/images/variations — excluded from drift, not covered by it.** The endpoint is REMOVED
upstream. It only ever served `dall-e-2`, which OpenAI removed on 2026-05-12, and the path went with
it: `POST https://api.openai.com/v1/images/variations` returns a bare `404` with a zero-byte body and
no `content-type`, keyless and authenticated alike — the 404 lands at the CDN edge before auth, byte
for byte what a made-up path returns, while `/v1/images/generations` and `/v1/images/edits` still
reach the API (observed 2026-09-15). There is no live endpoint left to drift against, so this row
must never read "Covered". aimock still answers the path — with that same removal 404, not an image
envelope — per the [deprecation policy](https://aimock.copilotkit.dev/deprecation-policy/); it is
pinned by `image-edits.test.ts`, not by drift.

³ **POST /v1/text-to-speech/{voice_id} — no drift test at all.** This row read "Covered" while no
case in `src/__tests__/drift/` ever requests the route, live or offline. The `elevenlabs` surface's
live leg is `/v1/sound-generation`; it does not touch text-to-speech. `src/elevenlabs-audio.ts` is
exercised by the unit suite only. Adding a case belongs in `elevenlabs.drift.ts`.

⁴ **Voice Design — offline conformance, NOT drift.** `elevenlabs-voice.drift.ts` drives only the
local aimock server and grades it against shapes read off `@elevenlabs/elevenlabs-js@2.68.0`
serialization types. `test-drift.yml` and `fix-drift.yml` do hand `ELEVENLABS_API_KEY` to the drift
run, but `elevenlabs-voice.drift.ts` never reads it and never contacts `api.elevenlabs.io`, so no
successful response from either route has ever been observed here and nothing in the loop can see
the vendor. The surface is
declared `liveCoverage: "none"` and appears in `unverifiedSurfaces` on every run. A funded key plus
one recorded design + create round-trip is what would move it to "Covered".

⁵ **GET / DELETE /v1/voices/{id} — no drift or conformance case at all.** Both routes are
implemented in `src/elevenlabs-voice.ts` (record, replay, strict and chaos all reach them) and both
are part of the `elevenlabs-voice` surface, which is declared `liveCoverage: "none"`. Unlike the two
`Offline⁴` rows, they are not covered offline either: no case in `src/__tests__/drift/` requests
either path — `grep -rn "/v1/voices" src/__tests__/drift/` returns nothing. They are exercised by
the unit suite (`src/__tests__/elevenlabs-voice.test.ts`) only. This is the ³ situation, recorded
before a row can claim otherwise: the honest first step is an offline conformance case in
`elevenlabs-voice.drift.ts` graded against the same SDK-derived shapes the two `Offline⁴` rows use,
which moves these rows to `Offline⁴`; a funded key is what would move the whole surface to
"Covered".

⁶ **No drift case drives these.** No case in `src/__tests__/drift/` requests `/v1/images/edits`,
`/v1/audio/translations`, `/api/embed`, `/api/embeddings` or `/v2/embed`, and none asserts on
`x-ratelimit-*` or `Retry-After`. `stream_options.include_usage` appears only in
`openrouter-chat.drift.ts`, a mock-only OpenRouter case, not an OpenAI one. All of these are pinned
by the unit suite only.

WebSocket drift tests cover four protocol files: 6 live three-way comparisons (Responses WS text + tool call, Realtime GA text + tool call, Gemini Live audio + tool call), 2 OpenAI Live lifecycle cases, 1 live model canary (Realtime) and 4 offline unit cases (Gemini Live model resolution). OpenAI Live uses frozen provider descriptors rather than SDK types. See the table under "WebSocket Protocols" below.

### Gemini Interactions API (Beta)

The Gemini Interactions API (`/v1beta/interactions`) is covered by 5 drift tests in `gemini-interactions.drift.ts`:

- Non-streaming text shape
- Non-streaming text shape (`Step[]` input)
- Streaming text event sequence
- Non-streaming tool call shape
- Streaming tool call event sequence

Uses `describe.skipIf(!GOOGLE_API_KEY)` like other Gemini tests. The Interactions API is in Beta — shapes may shift as Google iterates on the endpoint.

### WebSocket Protocols

| Protocol               | Text        | Tool Call | Real Endpoint                                                       | Status    |
| ---------------------- | ----------- | --------- | ------------------------------------------------------------------- | --------- |
| OpenAI Live            | Transcripts | Managed ✓ | `wss://api.openai.com/v1/live/sessions`                             | Verified  |
| OpenAI Responses WS    | ✓           | ✓         | `wss://api.openai.com/v1/responses`                                 | Verified  |
| OpenAI Realtime (GA)   | ✓           | ✓         | `wss://api.openai.com/v1/realtime`                                  | Verified  |
| OpenAI Realtime (Beta) | —           | —         | `wss://api.openai.com/v1/realtime` + `OpenAI-Beta: realtime=v1`     | Excluded¹ |
| Gemini Live            | — (AUDIO ✓) | ✓         | `wss://generativelanguage.googleapis.com/ws/...BidiGenerateContent` | Verified  |

¹ **OpenAI Realtime (Beta) — excluded from drift, not covered by it.** OpenAI removed the
Beta shape: a live Beta handshake returns
`{"code":"beta_api_shape_disabled","message":"The Realtime Beta API is no longer supported. Please
use /v1/realtime for the GA API."}` and closes with `4000
invalid_request_error.beta_api_shape_disabled`. There is no live Beta endpoint to compare against,
so the probe is GA-only (see `ab8db68`) and this row must never read "Verified" again. aimock still
answers the Beta shape — with that same sunset rejection, not a handshake — per the
[deprecation policy](https://aimock.copilotkit.dev/deprecation-policy/); it is pinned by
`ws-realtime.test.ts` and `ws-api-conformance.test.ts`, not by drift.

**Models**: `gpt-4o-mini` for Responses WS, `gpt-realtime-mini` for Realtime GA, `gpt-live-1` for OpenAI Live.

**GA Realtime Drift Tests**:

- **Model canary** — Verifies GA models exist (`gpt-realtime`, `gpt-realtime-2`, `gpt-realtime-2.1`, `gpt-realtime-2.1-mini`, `gpt-realtime-1.5`, `gpt-realtime-mini` and dated snapshots — `gaRealtimeModels` in `voice-models.ts`) and flags unknown realtime models
- **Protocol probe** — Connects with the GA protocol only (the Beta shape is retired upstream) and grades the event sequence
- **Event shape validation** — GA event names (`response.output_text.delta`, `conversation.item.added`, `conversation.item.done`) and nested session config (`session.audio.*`, `session.type`, `session.reasoning`)

**Auth**: Uses the same `OPENAI_API_KEY` and `GOOGLE_API_KEY` environment variables as HTTP tests. No new secrets needed.

**How it works**: Responses WS, Realtime and Gemini Live use a TLS WebSocket client (`ws-providers.ts`) that connects to real provider endpoints using `node:tls` with RFC 6455 framing. Each protocol function handles the setup sequence (e.g., Realtime session negotiation, Gemini Live setup/setupComplete) and collects messages until a terminal event. The mock side uses the existing `ws-test-client.ts` plaintext client against the local aimock server.

### OpenAI Live: client and managed delegation

`ws-live.drift.ts` runs two cases against `gpt-live-1`: `client lifecycle` and `managed lifecycle`. Each connects to the primary `wss://api.openai.com/v1/live/sessions` endpoint through the raw TLS WebSocket connector. Each also replays a reviewed capture through a real local aimock WebSocket. The installed OpenAI 4.x SDK has no Live types.

Supply `OPENAI_API_KEY` through your environment, then run only these cases:

```bash
pnpm run test:drift src/__tests__/drift/ws-live.drift.ts --maxWorkers=1 --minWorkers=1

# Check the missing-key result without contacting the provider: two skipped cases.
env -u OPENAI_API_KEY pnpm run test:drift src/__tests__/drift/ws-live.drift.ts --maxWorkers=1 --minWorkers=1
```

Each run opens at most two provider connections, one per mode, without automatic retries. Each attempt has a 45-second deadline, including a 15-second upgrade deadline. Input is at most 10 seconds of owned PCM (480,000 bytes). The combined client/server capture is limited to 8 MiB and 5,000 events. Each attempt aborts and destroys its socket on exit. A provider error or HTTP 401, 403 or 429 prevents the next mode from opening another connection.

The cases check required event shapes, session model/mode/identity, successful closure, audio output, input/output transcripts, cumulative usage and delegation after input. Client mode checks thinking and commentary. Managed mode checks two named tool calls, both results before explicit `response.create`, and continuation linked to the original backend response. They compare these supported invariants, not exact wording, latency or audio chunk counts. Unknown extra top-level server events remain diagnostic observations rather than critical drift.

Provenance comes from the reviewed [frozen contract](src/__tests__/fixtures/live/contract.json), [client capture](src/__tests__/fixtures/live/client.json) and [managed capture](src/__tests__/fixtures/live/managed.json). The [scenario helper](src/__tests__/drift/live-scenarios.ts) exposes their provider-reference descriptors. These are observed/reference contracts, not SDK verification. The registry routes `openai-live` findings to `src/ws-live.ts` and `handleLiveSession`.

Read run status before interpreting coverage:

- **Missing key:** two skips; OpenAI Live stays in `unverifiedSurfaces`. A successful test-process exit does not establish compatibility.
- **Both modes pass:** actual provider and local replay invariants passed. A filtered single-mode run or a partially skipped run does not establish full coverage.
- **Access, authentication or quota refusal:** a failed, unverified run. The collector retains the diagnostic under OpenAI Live in quarantine (exit **5**), including the subsequent refusal-latched case. It is neither a skip nor protocol drift.
- **Supported invariant failure:** a trusted critical finding uses exit **2**.
- **Timeout with zero observed messages:** no protocol evidence was collected; the collector uses exit **6** when no higher-priority condition applies. Other inconclusive failures remain quarantined.

These are collector exit codes, not Vitest exit codes. Mixed collector results keep the existing precedence: critical (**2**), quarantine (**5**), AG-UI unavailable (**1**), zero-message timeout (**6**), then clean (**0**). Coverage metadata does not introduce an exit code. A refusal remains in the report even when a separate critical finding determines exit 2.

The canary logs elapsed milliseconds, server-event count, input bytes and the last reported usage. Missing usage means unknown, not zero. Live session billing and backend model/tool billing are separate; elapsed time is not an invoice. Budget for up to two 45-second provider attempts per invocation. Review a failed attempt before rerunning it.

This canary does not test mutable backend updates, acoustic playback or interruption quality. It does not prove speaker output stopped. Local aimock replays captured audio; it does not synthesize speech. POST SDP, WebRTC, sideband connections, fork/download and cancellation are outside this surface. See the [WebSocket guide](docs/websocket/index.html#openai-live) for mock and replay setup.

`gpt-live-1` remains a known voice family excluded from text-only model probes. That text exclusion does not disable this dedicated Live canary. `gpt-live-1-mini` remains unclassified and can still trigger new-family detection.

### Gemini Live: graded on the AUDIO modality

aimock's Gemini Live handler implements the `BidiGenerateContent` protocol as documented in Google's [Live API reference](https://ai.google.dev/api/live) — `setup`/`setupComplete` handshake, `clientContent` with turns, `serverContent` with `modelTurn.parts[]`, and `toolCall` responses.

A Live session carries exactly ONE response modality, and the native-audio models exposing `bidiGenerateContent` support only `AUDIO` — Google's [capabilities guide](https://ai.google.dev/gemini-api/docs/live-api/capabilities) states the native audio models "only support `AUDIO` response modality". `bidiGenerateContent` does not imply `AUDIO`, though: `gemini-3.5-transcribe-live` declares it and emits only `TEXT`, refusing `AUDIO` with the mirror-image 1007 close. On a native-audio model a session requesting `TEXT` is refused with an RFC 6455 CLOSE frame (`code=1007`, "The requested combination of response modalities (TEXT) is not supported by the model"), so `ws-gemini-live.drift.ts` drives `responseModalities: ["AUDIO"]` and grades the audio event sequence — `inlineData` parts plus `turnComplete` — along with the modality-independent `toolCall`. The mock side is driven by an audio fixture so both sides of the comparison see the same modality.

Model selection keys ONLY on the listing's declared `bidiGenerateContent` support; since the listing cannot express response modality, `driveGeminiLiveAudio` walks the candidates in listing order and a 1007 modality refusal advances to the next one (all candidates refusing `AUDIO` is an honest skip, not drift). It must never re-derive a capability from the model name: `gemini-3.1-flash-live-preview` is a native-audio model whose name lacks any `"native-audio"` substring, so a name-based filter would classify it as text-capable and request an unsupported modality.

aimock's TEXT `serverContent` path is exercised mock-only by `ws-gemini-live.test.ts`; it cannot be triangulated against a live endpoint while no Live model serves text. `ws-gemini-live-modality.test.ts` runs the whole three-way comparison locally against a fake provider that enforces Google's modality rule, so the mock side is verified without live credentials.

## CI Schedule

Two workflows run the drift suite. Neither runs on `push`.

`.github/workflows/test-drift.yml` (**Drift Tests**) triggers on a daily cron (`0 6 * * *`, 6:00 UTC), on `workflow_dispatch`, and on `pull_request` — but a PR only triggers it when the diff touches drift-grading code (`paths:` = `src/agui-types.ts`, `scripts/drift-*.ts`, `src/__tests__/drift/**`, `.github/workflows/*drift*`). Its jobs:

- **`agui-schema-drift`** — runs on every trigger, including PRs. Clones the canonical `ag-ui` repo and runs `src/__tests__/drift/agui-*.drift.ts` (today `agui-schema.drift.ts`) against `src/agui-types.ts`. Needs no provider keys; **costs nothing**.
- **`drift`** — schedule and `workflow_dispatch` only (`if: github.event_name != 'pull_request'`). Runs the full live collector (`scripts/drift-retry.ts`) against the real providers, plus a locally provisioned Ollama daemon. **Spends real API credits** on every run.
- **`notify`** — schedule and `workflow_dispatch` only; Slack summary of the two jobs above. Free.
- **`drift-live-pr`** — `pull_request` only (`if: github.event_name == 'pull_request'`). Runs the live collector on the PR head, and on the `main` base too unless a same-UTC-day scheduled `main` report can be reused — so **one or two full live runs per PR push**, real credits each. Fork PRs get no secrets, so their live legs skip (neutral) and a maintainer runs the delta by hand.

`.github/workflows/fix-drift.yml` (**Fix Drift**) triggers on a daily cron (`10 6 * * *`, 6:10 UTC — offset from the 6:00 run) and on `workflow_dispatch`; its single `sync` job is gated to exactly those two events. It fetches each provider's live `/models` listing, and its clean-re-collect gate then runs the **full live collector** (every leg, Ollama daemon included), so it **also spends real API credits** once a day. See "Automated Drift Remediation" below.

## Automated Drift Remediation

There is no LLM/agent in the remediation loop. General (non-model-churn) drift
is **not** auto-fixed by anything — it is caught by the daily drift test (which
alerts on its own; see above) and fixed by a human like any other bug. The only
automated remediation is the deterministic, zero-LLM **model-family sync**,
which handles exactly one class of drift: a provider adding or retiring a
model family. The `fix-drift.yml` workflow runs it on `workflow_dispatch` and a
daily **scheduled cron** (independent of drift-test failure — a retired model
family does not, by itself, fail the drift tests):

1. **Sync** — `scripts/drift-sync.ts` fetches each provider's live `/models` listing directly and diffs it against the frozen classification in `src/__tests__/drift/model-registry.ts`:
   - a classified family a healthy live listing no longer contains → **a provider-confirmed deprecation is a fact, not a decision**, so it never routes to a human. drift-sync RECORDS it, mechanically, as a comment-marked entry in `deprecatedFamilies[provider]` (`model-registry.ts`), stamped with the date and with whether aimock's own source still references it. **The mock keeps serving**: `includeFamilies` is untouched, so every builder and fixture for that family still answers — users pin retired model ids in their own suites for years, and the upstream catalog shrinking is not a reason to break them. Recording it is also what makes it stop: the detector filters recorded families out of its candidate set, so the same retirement is not re-derived every morning for ever. Dropping a retired family from aimock altogether stays optional human cleanup (delete it from `includeFamilies` **and** `deprecatedFamilies`, then re-pin `DATA_FROZEN["includeFamilies.<provider>"]` in `logic-pin.test.ts`, all in one reviewed commit) — the re-pin is the reviewed decision the pin exists to force, which the sync's own changed-file allowlist forbids it from making. Nothing is broken while it is undone.
   - a genuinely new/unclassified family, or a registry structural mismatch (the AST locator could not find the array it had to edit) → **not** auto-applied: the decision itself is a human's. A family-keyed dedup note file is written under `drift-proposals/` and the run is routed to a human (no PR spam on re-fire)
2. **Gate** — `scripts/drift-sync-check.ts` re-verifies any mechanical edit before (inside `drift-sync.ts`) and after (workflow defense-in-depth) it is kept: a changed-file allowlist (only `model-registry.ts` data literals + `drift-proposals/` notes), a checksum-pin re-assert over the frozen classification logic, and a clean re-collect. `deprecatedFamilies` is the one registry set deliberately **not** membership-pinned — a pin on the ledger the sync appends to would red on the sync's own append and revert it, every morning, forever. It gates no alert a human sees (`isClassifiedFamily` does not consult it), so there is nothing for a pin to defend; its invariants are asserted behaviourally in `model-registry.test.ts` instead.
3. **PR** — the workflow opens a pull request for a human to review + merge (never auto-merged), unless an open PR already proposes the same changeset or a human has already rejected it. There are two distinct PR classes:
   - **`ok-applied`** — a successful mechanical registry edit: a recorded **deprecation**, or an **addition** a human already approved on a prior run. Pushed onto the `fix/drift-*` branch `drift-sync.ts` committed onto; a human reviews CI + the diff and merges. No alert, no red run — it is data-only bookkeeping.
   - **`needs-human`** — a routed decision, and now only a genuinely new/unclassified family or a registry structural mismatch. `drift-sync.ts` commits the `drift-proposals/` note file(s), and the workflow pushes a **distinct `drift-needs-human/*` branch** and opens a PR so the note lands in the repo (the job also goes RED + Slack-alerts so the decision is seen). The PR is **never auto-merged**. To approve a _new-family_ note, set its `Decision: include` line and **merge the PR**; the **next** drift-sync run reads the approved note from `main` and applies the mechanical registry edit (an `ok-applied` PR). That two-run hand-off is how the loop closes.

   **Closing a drift-sync PR REJECTS that changeset, permanently.** A CLOSED-but-never-merged PR carrying the `<!-- drift-changeset: <key> -->` marker tells the workflow a human decided against that exact changeset, so it stops re-proposing it (a genuinely different drift hashes to a different key and is unaffected; a **merged** PR is an accepted decision and is never read as a rejection). A still-**open** PR carrying the marker always wins over a closed one, so closing a duplicate does not reject the changeset the surviving PR is still proposing. The suppression is **not silent, and not repetitive** — the first run after the closure posts a Slack line naming the closing PR, then records an ack marker in that PR's body so the identical line is not re-posted every morning for as long as the rejection stands (which is for ever: the closure is permanent and the changeset key is date-independent). Delete that ack marker and the next run reports the suppression again. **To un-suppress: REOPEN that PR** — it becomes the pending proposal again, and the registry stays drifted until you do. Deleting the `<!-- drift-changeset: … -->` marker from the closed PR's body does **not** un-suppress: the marker self-heal now covers closed PRs and puts it back, because that marker going missing is far more often a human rewriting the body (to write down _why_ they declined) than a deliberate un-suppression — and losing it that way used to resurrect the rejected changeset every morning, permanently. Reopening is the deliberate act; a body edit is not.

   Editing markers out of a drift-sync PR does nothing, on the other hand: the workflow restores the markers it owns on the PRs it can recognise as its own, warns in the run log, and dedups normally. That repair reaches a **closed** PR's changeset marker too — which is what makes closing one a durable rejection, since a later body edit can no longer erase the record of it. A **merged** PR is left alone: an accepted decision is neither a pending proposal nor a rejection, so nothing there is read and nothing is written.

   **"No churn" is not the same as "could not look".** Several things make `drift-sync.ts` SKIP a provider rather than fail: an unusable credential (a missing key, or a 401/402/403), and a live `/models` listing that comes back with fewer raw ids than `MIN_LISTING_SIZE[provider]` (a partial response, or an API that changed shape — the deprecation half then refuses to mass-remove off it). That floor is an explicit per-provider number, set below the smallest healthy listing there is evidence for. It is deliberately NOT the number of families aimock mocks: comparing raw ids against a family count is a unit mismatch, and it ratcheted anthropic's floor to 20 against a live listing of 11, abandoning that provider's deprecation half on every run for weeks while each one reported a quiet day. With nothing to diff the run reports `ok-no-churn` and exits 0, indistinguishable from a genuinely quiet day. So the sync prints a machine line, `unchecked-providers=<csv>`, and the workflow reclassifies such a run to `provider-unchecked`: the job goes RED and Slack points at the `[skipped] <provider>: <reason>` lines of the drift-sync-log artifact. Only **transient** classes (a 429 or a 5xx) are tolerated, and that is an allowlist of the tolerated class — not of the faults — so a skip class added later counts as unchecked by default instead of silently reading as "checked fine". An unreadable log, or a missing `unchecked-providers=` line, is treated as a fault too — an unprovable run must not pass as a quiet one.

   **Re-fires never spam a second PR — idempotent in every run shape.** Because a drift-sync PR is never auto-merged, an un-merged drift is re-detected on every daily cron run. Both PR classes therefore dedup on a **stable changeset key**: `drift-sync.ts` emits a date-independent `changeset-key` (a hash of the sorted set of applied + deferred family outcomes, independent of the date-stamped comment text and the run-id branch name), and each PR body carries a `<!-- drift-changeset: <key> -->` marker. Before opening a PR, the workflow skips if an open PR already carries that marker. This covers the **mixed run** — a mechanical removal of one family committed the same run a _different_ family is deferred to a human (its note already on `main`) — whose committed diff is a registry edit with **no new note file**: a note-path-only key would be empty there and let a new PR open every day. A run that produces no new commit at all (note already on `main`, nothing applied) pushes nothing. The older per-note `drift-proposal-note: <path>` body marker is retained, but as a **notice, not a guard**: it used to skip the whole run on the first note some open PR already proposed, which silently discarded the _rest_ of that run (a mixed run's registry edit, or a second note added since). Control only reaches it once the changeset key has found nothing, so the run's content is by then known to be un-proposed and standing down could only lose it. So the overlap is now logged as a warning — two open PRs carrying one note is worth explaining — and the run proceeds.

### Artifacts

- `drift-report.json` (test-drift.yml) / `drift-sync-log`, `drift-sync-check-log` (fix-drift.yml) — structured/plaintext run output (retained 30 days)

## Cost

A live collector run exercises the enabled `liveCoverage: "live"` surfaces in `src/__tests__/drift/surface-registry.ts` (19 of the 29 registered surfaces at the time of writing; the other 10 are mock-only conformance checks that make no vendor call), using low-cost models for the text legs (`gpt-4o-mini`, `gpt-realtime-mini`, `claude-haiku-4-5-20251001`, `gemini-2.5-flash`) with 10-100 max tokens each. Per day that is two scheduled live runs (`test-drift.yml`'s `drift` job and `fix-drift.yml`'s re-collect gate) plus one or two per push on a drift-code PR. The Realtime probe opens two GA WS connections per run (one text turn, one tool call) and no Beta connection (the Beta shape is retired upstream). The 2 Gemini Live legs each open a real WS session and generate a short audio turn.

The OpenAI Live canary adds up to two `gpt-live-1` sessions per run, with owned audio and backend delegation. Its finite limits and usage reporting are described above; the text-token estimates do not apply to these sessions.
