# Live API Drift Detection

llmock produces responses shaped like real LLM APIs. Providers change their APIs over time. **Drift** means the mock no longer matches reality — your tests pass against llmock but break against the real API.

## Three-Layer Approach

Drift detection compares three independent sources to triangulate the cause of any mismatch:

| SDK types = Real API? | Real API = llmock? | Diagnosis                                                            |
| --------------------- | ------------------ | -------------------------------------------------------------------- |
| Yes                   | No                 | **llmock drift** — response builders need updating                   |
| No                    | No                 | **Provider changed before SDK update** — flag, wait for SDK catch-up |
| Yes                   | Yes                | **No drift** — all clear                                             |
| No                    | Yes                | **SDK drift** — provider deprecated something SDK still references   |

Two-way comparison (mock vs real) can't distinguish between "we need to fix llmock" and "the SDK hasn't caught up yet." Three-way comparison can.

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

- **critical** — Test fails. llmock produces a different shape than the real API for a field that both the SDK and real API agree on. This means llmock needs an update.
- **warning** — Test passes (unless `STRICT_DRIFT=1`). The real API has a field that neither the SDK nor llmock knows about, or the SDK and real API disagree. Usually means a provider added something new.
- **info** — Always passes. Known intentional differences (usage fields are always zero, optional fields llmock omits, etc.).

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

2. **Update the builder** — add or modify the field to match the real API shape.

3. **Run conformance tests** — `pnpm test` to verify existing API conformance tests still pass.

4. **Run drift tests** — `pnpm test:drift` to verify the drift is resolved.

## Model Deprecation

The `models.drift.ts` test scrapes model names referenced in llmock's test files, README, and fixtures, then checks each provider's model listing API to verify they still exist.

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

In addition to the 19 existing drift tests (16 HTTP response-shape + 3 model deprecation), WebSocket drift tests cover llmock's WS protocols:

| Protocol            | Text | Tool Call | Real Endpoint                                                       | Status     |
| ------------------- | ---- | --------- | ------------------------------------------------------------------- | ---------- |
| OpenAI Responses WS | ✓    | ✓         | `wss://api.openai.com/v1/responses`                                 | Verified   |
| OpenAI Realtime     | ✓    | ✓         | `wss://api.openai.com/v1/realtime`                                  | Verified   |
| Gemini Live         | —    | —         | `wss://generativelanguage.googleapis.com/ws/...BidiGenerateContent` | Unverified |

**Models**: `gpt-4o-mini` for Responses WS, `gpt-4o-mini-realtime-preview` for Realtime.

**Auth**: Uses the same `OPENAI_API_KEY` and `GOOGLE_API_KEY` environment variables as HTTP tests. No new secrets needed.

**How it works**: A TLS WebSocket client (`ws-providers.ts`) connects to real provider endpoints using `node:tls` with RFC 6455 framing. Each protocol function handles the setup sequence (e.g., Realtime session negotiation, Gemini Live setup/setupComplete) and collects messages until a terminal event. The mock side uses the existing `ws-test-client.ts` plaintext client against the local llmock server.

### Gemini Live: unverified

llmock's Gemini Live handler implements the text-based `BidiGenerateContent` protocol as documented in Google's [Live API reference](https://ai.google.dev/api/live) — `setup`/`setupComplete` handshake, `clientContent` with turns, `serverContent` with `modelTurn.parts[].text`, and `toolCall` responses. The protocol format is correct per the docs.

However, as of March 2026, the only models that support `bidiGenerateContent` are native-audio models (`gemini-2.5-flash-native-audio-*`), which reject text-only requests. No text-capable model exists for this endpoint yet, so we cannot triangulate llmock's output against a real API response.

A canary test (`ws-gemini-live.drift.ts`) queries the Gemini model listing API on each drift run and checks for a non-audio model that supports `bidiGenerateContent`. When Google ships one, the canary will flag it and the full drift tests can be enabled.

## CI Schedule

Drift tests run on a schedule:

- **Weekly**: Monday 6:00 AM UTC
- **Manual**: Trigger via GitHub Actions UI (`workflow_dispatch`)
- **NOT** on PR or push — these tests hit real APIs and cost money

See `.github/workflows/test-drift.yml`.

## Cost

~25 API calls per run (16 HTTP response-shape + 3 model listing + 4 WS + 2 canaries) using the cheapest available models (`gpt-4o-mini`, `gpt-4o-mini-realtime-preview`, `claude-haiku-4-5-20251001`, `gemini-2.5-flash`) with 10-100 max tokens each. Under $0.02/week. When Gemini Live text-capable models become available, this will increase to 6 WS calls.
