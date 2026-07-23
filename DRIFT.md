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

Two-way comparison (mock vs real) can't distinguish between "we need to fix aimock" and "the SDK hasn't caught up yet." Three-way comparison can.

## Running Drift Tests

```bash
# All providers (requires all three API keys)
OPENAI_API_KEY=sk-... ANTHROPIC_API_KEY=sk-... GOOGLE_API_KEY=... pnpm test:drift

# Single provider (others skip automatically)
OPENAI_API_KEY=sk-... pnpm test:drift

# Strict mode — warnings also fail
STRICT_DRIFT=1 OPENAI_API_KEY=sk-... pnpm test:drift
```

Required environment variables:

- `OPENAI_API_KEY` — OpenAI API key
- `ANTHROPIC_API_KEY` — Anthropic API key
- `GOOGLE_API_KEY` — Google AI API key

Each provider's tests skip independently if its key is not set. You can run drift tests for just one provider.

## Reading Results

### Severity levels

- **critical** — Test fails. aimock produces a different shape than the real API for a field that both the SDK and real API agree on. This means aimock needs an update.
- **warning** — Test passes (unless `STRICT_DRIFT=1`). The real API has a field that neither the SDK nor aimock knows about, or the SDK and real API disagree. Usually means a provider added something new.
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

1. **Identify the response builder** — the report path tells you which provider and field:
   - OpenAI Chat Completions → `src/helpers.ts` (`buildTextCompletion`, `buildToolCallCompletion`, `buildTextChunks`, `buildToolCallChunks`)
   - OpenAI Responses API → `src/responses.ts` (`buildTextResponse`, `buildToolCallResponse`, `buildTextStreamEvents`, `buildToolCallStreamEvents`)
   - Anthropic Claude → `src/messages.ts` (`buildClaudeTextResponse`, `buildClaudeToolCallResponse`, `buildClaudeTextStreamEvents`, `buildClaudeToolCallStreamEvents`)
   - Google Gemini → `src/gemini.ts` (`buildGeminiTextResponse`, `buildGeminiToolCallResponse`, `buildGeminiTextStreamChunks`, `buildGeminiToolCallStreamChunks`)
   - Gemini embedContent → `src/gemini.ts` (embedContent response builder)
   - Gemini Interactions → `src/gemini-interactions.ts` (`buildInteractionsTextResponse`, `buildInteractionsToolCallResponse`, `buildInteractionsTextSSEEvents`, `buildInteractionsToolCallSSEEvents`)
   - OpenAI Image Edit → `src/images.ts` (multipart `/v1/images/edits` handler)
   - OpenAI Audio Translation → `src/transcription.ts` (multipart `/v1/audio/translations` handler)
   - Ollama Embeddings → `src/ollama.ts` (`/api/embed` + legacy `/api/embeddings` response builder)
   - Cohere Embed → `src/cohere.ts` (`/v2/embed` response builder)
   - ElevenLabs TTS → `src/elevenlabs-audio.ts` (`/v1/text-to-speech/{voice_id}` response builder)

2. **Update the builder** — add or modify the field to match the real API shape.

3. **Run conformance tests** — `pnpm test` to verify existing API conformance tests still pass.

4. **Run drift tests** — `pnpm test:drift` to verify the drift is resolved.

## Model Deprecation

The `models.drift.ts` test scrapes model names referenced in aimock's test files, README, and fixtures, then checks each provider's model listing API to verify they still exist.

When a model is deprecated:

1. Update the model name in the affected test files and fixtures
2. Update `src/__tests__/drift/providers.ts` if the cheap test model changed
3. Run `pnpm test` and `pnpm test:drift`

## Adding a New Provider

1. Add the provider's SDK as a devDependency in `package.json`
2. Add shape extraction functions to `src/__tests__/drift/sdk-shapes.ts`
3. Add raw fetch client functions to `src/__tests__/drift/providers.ts`
4. Create `src/__tests__/drift/<provider>.drift.ts` with 4 test scenarios
5. Add model listing function to `providers.ts` and model check to `models.drift.ts`
6. If the provider uses WebSocket, add protocol functions to `ws-providers.ts` and create `ws-<provider>.drift.ts`
7. Update the allowlist in `schema.ts` if needed

## WebSocket Drift Coverage

In addition to the 23 existing drift tests (20 HTTP response-shape + 3 model deprecation), the following new endpoint coverage has been added:

### New Endpoint Drift Coverage

| Endpoint                                 | Provider      | Type              | Status  |
| ---------------------------------------- | ------------- | ----------------- | ------- |
| POST /v1beta/models/{model}:embedContent | Gemini        | HTTP              | Covered |
| POST /v1/images/edits                    | OpenAI        | HTTP (multipart)  | Covered |
| POST /v1/audio/translations              | OpenAI        | HTTP (multipart)  | Covered |
| POST /api/embed, /api/embeddings         | Ollama        | HTTP              | Covered |
| POST /v2/embed                           | Cohere        | HTTP              | Covered |
| POST /v1/text-to-speech/{voice_id}       | ElevenLabs    | HTTP              | Covered |
| stream_options.include_usage             | OpenAI        | Streaming feature | Covered |
| x-ratelimit-\* / Retry-After 429         | All providers | Response headers  | Covered |

WebSocket drift tests cover aimock's WS protocols (6 verified + 2 canary = 8 WS tests):

### Gemini Interactions API (Beta)

The Gemini Interactions API (`/v1beta/interactions`) is covered by 4 drift tests in `gemini-interactions.drift.ts`:

- Non-streaming text shape
- Streaming text event sequence
- Non-streaming tool call shape
- Streaming tool call event sequence

Uses `describe.skipIf(!GOOGLE_API_KEY)` like other Gemini tests. The Interactions API is in Beta — shapes may shift as Google iterates on the endpoint.

| Protocol               | Text | Tool Call | Real Endpoint                                                       | Status     |
| ---------------------- | ---- | --------- | ------------------------------------------------------------------- | ---------- |
| OpenAI Responses WS    | ✓    | ✓         | `wss://api.openai.com/v1/responses`                                 | Verified   |
| OpenAI Realtime (GA)   | ✓    | ✓         | `wss://api.openai.com/v1/realtime`                                  | Verified   |
| OpenAI Realtime (Beta) | ✓    | ✓         | `wss://api.openai.com/v1/realtime` + `OpenAI-Beta: realtime=v1`     | Verified   |
| Gemini Live            | —    | —         | `wss://generativelanguage.googleapis.com/ws/...BidiGenerateContent` | Unverified |

**Models**: `gpt-4o-mini` for Responses WS, `gpt-realtime-2` for Realtime GA (was `gpt-4o-mini-realtime-preview`).

**GA Realtime Drift Tests**:

- **Model canary** — Verifies GA models exist (`gpt-realtime`, `gpt-realtime-2`, `gpt-realtime-1.5`, `gpt-realtime-mini` and dated snapshots) and flags unknown realtime models
- **Protocol probe** — Connects with both GA and Beta protocol, normalizes event sequences, and verifies consistency
- **Event shape validation** — GA event names (`response.output_text.delta`, `conversation.item.added`, `conversation.item.done`) and nested session config (`session.audio.*`, `session.type`, `session.reasoning`)

**Auth**: Uses the same `OPENAI_API_KEY` and `GOOGLE_API_KEY` environment variables as HTTP tests. No new secrets needed.

**How it works**: A TLS WebSocket client (`ws-providers.ts`) connects to real provider endpoints using `node:tls` with RFC 6455 framing. Each protocol function handles the setup sequence (e.g., Realtime session negotiation, Gemini Live setup/setupComplete) and collects messages until a terminal event. The mock side uses the existing `ws-test-client.ts` plaintext client against the local aimock server.

### Gemini Live: unverified

aimock's Gemini Live handler implements the text-based `BidiGenerateContent` protocol as documented in Google's [Live API reference](https://ai.google.dev/api/live) — `setup`/`setupComplete` handshake, `clientContent` with turns, `serverContent` with `modelTurn.parts[].text`, and `toolCall` responses. The protocol format is correct per the docs.

However, as of March 2026, the only models that support `bidiGenerateContent` are native-audio models (`gemini-2.5-flash-native-audio-*`), which reject text-only requests. No text-capable model exists for this endpoint yet, so we cannot triangulate aimock's output against a real API response.

A canary test (`ws-gemini-live.drift.ts`) queries the Gemini model listing API on each drift run and checks for a non-audio model that supports `bidiGenerateContent`. When Google ships one, the canary will flag it and the full drift tests can be enabled.

## CI Schedule

Drift tests run on a schedule:

- **Daily**: 6:00 AM UTC
- **Manual**: Trigger via GitHub Actions UI (`workflow_dispatch`)
- **NOT** on PR or push — these tests hit real APIs and cost money

See `.github/workflows/test-drift.yml`.

## Automated Drift Remediation

There is no LLM/agent in the remediation loop. General (non-model-churn) drift
is **not** auto-fixed by anything — it is caught by the daily drift test (which
alerts on its own; see above) and fixed by a human like any other bug. The only
automated remediation is the deterministic, zero-LLM **model-family sync**,
which handles exactly one class of drift: a provider adding or retiring a
model family. The `fix-drift.yml` workflow runs it on `workflow_dispatch`, a
daily **scheduled cron** (independent of drift-test failure — a retired model
family does not, by itself, fail the drift tests), and on a failed `Drift
Tests` run (an opportunistic attempt in case the failure was model churn):

1. **Sync** — `scripts/drift-sync.ts` fetches each provider's live `/models` listing directly and diffs it against the frozen classification in `src/__tests__/drift/model-registry.ts`:
   - a classified family absent from live listings with **zero remaining aimock references** → a mechanical, comment-marked removal
   - a still-referenced deprecated family, or a genuinely new/unclassified family → **never** auto-edited; a family-keyed dedup note file is written under `drift-proposals/` and the run is routed to a human (no PR spam on re-fire)
2. **Gate** — `scripts/drift-sync-check.ts` re-verifies any mechanical edit before (inside `drift-sync.ts`) and after (workflow defense-in-depth) it is kept: a changed-file allowlist (only `model-registry.ts` data literals + `drift-proposals/` notes), a checksum-pin re-assert over the frozen classification logic, and a clean re-collect
3. **PR** — the workflow always opens a pull request that a human reviews + merges (no auto-merge). There are two distinct PR classes:
   - **`ok-applied`** — a successful mechanical registry edit. Pushed onto the `fix/drift-*` branch `drift-sync.ts` committed onto; a human reviews CI + the diff and merges.
   - **`needs-human`** — a routed decision. `drift-sync.ts` commits the `drift-proposals/` note file(s), and the workflow pushes a **distinct `drift-needs-human/*` branch** and opens a PR so the note lands in the repo (the job also goes RED + Slack-alerts so the decision is seen). The PR is **never auto-merged**. To approve a _new-family_ note, set its `Decision: include` line and **merge the PR**; the **next** drift-sync run reads the approved note from `main` and applies the mechanical registry edit (an `ok-applied` PR). That two-run hand-off is how the loop closes.

   **Re-fires never spam a second PR — idempotent in every run shape.** Because a drift-sync PR is never auto-merged, an un-merged drift is re-detected on every daily cron run. Both PR classes therefore dedup on a **stable changeset key**: `drift-sync.ts` emits a date-independent `changeset-key` (a hash of the sorted set of applied + deferred family outcomes, independent of the date-stamped comment text and the run-id branch name), and each PR body carries a `<!-- drift-changeset: <key> -->` marker. Before opening a PR, the workflow skips if an open PR already carries that marker. This covers the **mixed run** — a mechanical removal of one family committed the same run a _different_ family is deferred to a human (its note already on `main`) — whose committed diff is a registry edit with **no new note file**: a note-path-only key would be empty there and let a new PR open every day. A run that produces no new commit at all (note already on `main`, nothing applied) pushes nothing; and the older per-note `drift-proposal-note: <path>` body marker is retained as a secondary guard.

### Artifacts

- `drift-report.json` (test-drift.yml) / `drift-sync-log`, `drift-sync-check-log` (fix-drift.yml) — structured/plaintext run output (retained 30 days)

### Manual trigger

The sync workflow also supports `workflow_dispatch` for manual runs.

## Cost

~31 API calls per run (20 HTTP response-shape + 3 model listing + 8 WS including canaries) using the cheapest available models (`gpt-4o-mini`, `gpt-realtime-2`, `claude-haiku-4-5-20251001`, `gemini-2.5-flash`) with 10-100 max tokens each. Under $0.25/week at daily cadence. The GA protocol probe adds a second Realtime WS connection (one GA, one Beta) per run. When Gemini Live text-capable models become available, the 2 canary tests will become full drift tests, increasing real WS connections from 6 to 8.
