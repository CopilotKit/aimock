# @copilotkit/aimock

## [Unreleased]

## [1.23.1] - 2026-05-14

### Fixed

- **Gemini functionCall.id preservation** — the Gemini conversation history converter generated new tool call IDs (`call_gemini_*`) instead of preserving the original IDs from `functionCall.id`. This broke `toolCallId`-based fixture matching on follow-up turns: the follow-up fixture couldn't match because the ID was overwritten, so the request fell through to `userMessage` fixtures which returned another tool call — creating an infinite loop for all Gemini/ADK showcase integrations. LangGraph-python (OpenAI format) was unaffected because it preserves IDs natively. ([#196](https://github.com/CopilotKit/aimock/pull/196))

## [1.23.0] - 2026-05-13

### Added

- **Model-aware fixture recording** — recorded fixtures now include the model name in match criteria, preventing collisions when an app makes multiple LLM calls with the same user message but different models. Model names are normalized by stripping date/version suffixes (e.g., `claude-opus-4-20250514` → `claude-opus-4`) so fixtures survive version bumps. Disable with `recordFullModelVersion: true`. ([#185](https://github.com/CopilotKit/aimock/issues/185))
- **Drift detection metadata** — recorded fixtures include `systemHash` and `toolsHash` in a `metadata` block for detecting system prompt or tool definition changes since recording.
- **Prefix model matching** — fixture router uses `startsWith` for string model matching, so `model: "claude-opus-4"` matches any `claude-opus-4-*` version.
- **GA Realtime protocol migration with Beta compatibility shim** — handler emits GA event names natively; `sendEvent()` wrapper translates back for Beta clients detected via `OpenAI-Beta` header. Default model changed to `gpt-realtime-2`.
- **GA Realtime models** — `gpt-realtime`, `gpt-realtime-2`, `gpt-realtime-1.5`, `gpt-realtime-mini` (and dated snapshots). Transcription/translation sessions use `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, or `whisper-1`.
- **Transcription and translation session types** — dedicated session configurations for translation and transcription workloads on the Realtime API.
- **Image input support** — Realtime sessions accept image content parts alongside text and audio.
- **Commentary phase** — Realtime handler supports the GA commentary phase for model-generated annotations.
- **`conversation.item.done` and `response.cancel` events** — new GA Realtime event types for item completion tracking and response cancellation.
- **Endpoint type routing for Realtime** — router distinguishes GA vs Beta Realtime endpoints for fixture matching.
- **Drift detection for GA Realtime** — drift test suite extended with GA protocol shapes, Beta conformance shapes, and three-way triangulation.

### Tests

- **73 GA Realtime integration tests** — comprehensive test coverage for all GA event types, Beta compatibility, session management, model routing, image input, translate/whisper, commentary, and cancellation.
- **GA and Beta Realtime conformance suites** — API conformance tests validating event shapes against both GA and Beta protocol specs.
- **GA Realtime drift detection** — SDK shape tests and provider triangulation for the GA Realtime protocol.

## [1.22.1] - 2026-05-12

### Fixed

- **Strict mode checked before proxy attempt** — in `--proxy-only` mode, the `X-AIMock-Strict` header had no effect because `proxyAndRecord()` returned before the strict check. Now all 17 handlers check strict mode first: when strict + no fixture → 503 immediately, no proxy attempt
- **Helper utilities and error serialization** — hardened helper functions and error serialization paths for correctness and robustness
- **Journal and fixture-loader correctness** — fixed journal entry handling and fixture-loader edge cases
- **WebSocket handler consistency and strict-mode journal** — aligned WebSocket handler behavior and ensured strict-mode journal entries are recorded correctly
- **Provider handler consistency and proxy outcomes** — unified provider handler error paths and proxy outcome reporting
- **Media handler hardening and chaos injection** — strengthened media handler validation and chaos injection reliability

### Tests

- **Bedrock mock consistency and CLI help text** — corrected Bedrock mock test assertions and CLI `--help` output coverage

## [1.22.0] - 2026-05-11

### Added

- **Per-request strict mode via `X-AIMock-Strict` header** — overrides the server-wide `--strict` flag per request (`true`/`1` = strict, `false`/`0` = lenient). When strict: fixture miss returns 503; when lenient: fixture miss proxies to real provider. Follows the `X-AIMock-Chaos-*` precedence pattern. Journal entries record `strictOverride` when the header overrides the server default. Enables the same aimock instance to serve both deterministic test probes and live demo traffic simultaneously.

### Fixed

- **Progressive relay for NDJSON and Bedrock binary event streams** — Ollama NDJSON and Bedrock binary event streams were fully buffered before relay, triggering downstream idle timeouts; now relayed progressively as chunks arrive
- **JSON.parse error detail in bare catch blocks** — capture and surface parse-error detail in all bare catch blocks across 25+ provider/WebSocket/stream-collapse handlers instead of swallowing context
- **Unguarded stream write/end calls** — wrap stream write/end in try/catch (recorder.ts, agui-recorder.ts) to prevent unhandled exceptions on client disconnect
- **Response termination for headers-already-sent paths** — add response termination in error paths where headers were already sent (server.ts, a2a-mock.ts, mcp-mock.ts), preventing connection hangs
- **Vector-mock double body consumption** — fix route passthrough consuming the request body twice, causing empty-body forwarding
- **Drift detection compared only first event per type** — `compareSSESequences` now compares ALL events per type, not just the first, catching previously invisible divergences
- **Ollama drift tests used broken async describe.skipIf** — replaced with synchronous env-var gate so tests are correctly skipped or executed
- **12 unrestored spy/mock leaks and misleading assertions** — fix spy/mock leaks across test files and correct assertions that passed for the wrong reasons
- Proxy relay hardcoded POST method — now forwards the original HTTP method
- Response timeout timer leak — cleared after successful upstream completion
- Client disconnect handler race — checks `writableFinished` before destroying upstream request
- `onHookBypassed` and `beforeWriteResponse` callbacks not wrapped in try/catch
- Audio error relay sent non-2xx responses with audio content-type instead of application/json
- Snapshot-mode fixture writes not atomic — concurrent requests could corrupt the file
- Undefined `toolCall` name/arguments silently dropped during fixture save
- Video detection heuristic false-positives on LLM provider responses with `{id, status}` shape
- One-shot error fixture splice during iteration (deferred via microtask)
- Azure model injection catch swallowed non-SyntaxError exceptions
- fal request body lost on passthrough (double `readBody` consumption)
- fal queue handler dropped PUT request body
- Recorder test: tmpDir leak on strict-mode reassignment, global fetch dependency, fragile fixturePath cleanup, duplicate helpers, spy leak on assertion failure

### Added

- Fixture-level chaos evaluation for non-completions endpoints (ElevenLabs, fal)

### Changed

- **Anti-buffering headers on all progressive stream relay paths** — standard headers (Cache-Control, Connection, X-Accel-Buffering) added to all progressive stream relay paths to prevent intermediate proxy buffering
- **Stream-collapse returns firstDroppedSample** — stream-collapse functions now return the first dropped sample for forensic debugging of collapsed streams

## [1.21.0] - 2026-05-11

### Added

- **`match.systemMessage` accepts `string[]`** — array form requires ALL substrings to be present in the joined system-message text (AND semantics). Use this when the gate must combine multiple non-adjacent tokens that may appear in any order — e.g., a host that serialises agent-context entries into a system message whose entry order is not stable, but where a fixture should only match when every default value is present (`["\"value\": \"Atai\"", "[\"Viewed the pricing page\",\"Watched the product demo video\"]"]`). Single-string and `RegExp` forms continue to work unchanged. JSON form accepts `string | string[]`; programmatic form accepts `string | string[] | RegExp`.

## [1.20.0] - 2026-05-11

### Fixed

- **Drift tests passed vacuously with zero assertions** — the `shouldFail` guard silently skipped all `expect` calls when no critical diffs were found, so broken extraction logic or warning-level drift went completely undetected. Replaced every guarded assertion across all 21 drift test files (89 instances) with unconditional `expect(diffs.filter(...)).toEqual([])`
- **Proxy relay leaked raw upstream HTTP status codes** — 5 recorder relay paths in `recorder.ts` and `agui-recorder.ts` forwarded raw upstream codes (429, 503, 401, 201, etc.) to aimock clients, exposing provider implementation details. Normalized to 200 for success and 502 for errors; fixture recording preserves the original status for fidelity

### Added

- **`match.systemMessage` fixture matcher** — gate a fixture on a substring (or regexp) found inside the concatenated text of every `system` role message in the request. Hosts that plumb dynamic context (persona, agent-context entries, dynamic config) through system messages can now narrow a fixture to a specific context state; when the caller changes that state the fixture stops matching and the request falls through to the next fixture or upstream proxy instead of silently returning a stale baked response. JSON form: `"match": { "userMessage": "Who am I?", "systemMessage": "name=Atai" }`. Programmatic form accepts `string | RegExp`.
- **Status code normalization tests** — 5 tests verifying proxy relay normalization (201→200, 429→502, 503→502, 401→502, SSE 429→502) with fixture preservation assertions; 2 existing tests updated to expect normalized 502

## [1.19.5] - 2026-05-09

### Fixed

- **Responses API request conversion** — forward `max_output_tokens` and `response_format` from Responses requests to the underlying Chat Completions call
- **Gemini request conversion** — forward `maxOutputTokens`, `topP`, `topK` from `generationConfig`; remove synthetic `functionCall.id` that real Gemini does not produce
- **Cohere request conversion** — structured content (images, documents), native tool definitions, `temperature`, `max_tokens`, and `stop_sequences` now forwarded
- **Ollama request conversion** — `tool_calls` on assistant messages, base64 `images` on user messages, `system` parameter on `/api/generate`
- **Chat Completions error responses** — add `param` field per OpenAI error spec
- **Moderation response shape** — correct `categories` and `category_scores` to match the real OpenAI moderation object (boolean flags + float scores)
- **Transcription verbose response** — add `task`, `duration`, `segments`, `words` fields for `verbose_json` format
- **Search response shape** — add `status` field to search results
- **Rerank response shape** — wrap results in `{ results: [...] }` with `relevance_score` per result
- **Realtime WebSocket** — add `previous_item_id` to conversation items, correct event ID prefixes, add missing fields on session and response events
- **Gemini Live WebSocket** — `generationConfig` alias for `generation_config`, `turnComplete` server event, correct gRPC status codes in error events, complete `httpToGrpc` mapper
- **Anthropic thinking blocks** — add `signature` field to `thinking` content blocks and `signature_delta` event type for extended thinking with signatures

### Added

- **Drift tests for 9 multimedia/auxiliary providers** — images, speech/TTS, transcription/STT, moderation, ElevenLabs audio, fal.ai, fal.ai queue lifecycle, video, rerank
- **Error shape drift tests** — OpenAI Chat, Anthropic Claude, Gemini, Cohere error response shapes validated against SDK types
- **Reasoning/thinking drift tests** — OpenAI Chat `reasoning_effort`, OpenAI Responses `reasoning`, Anthropic `thinking` content blocks, Gemini `thinking_config`

## [1.19.4] - 2026-05-08

### Fixed

- **Converse stream: spurious `type` field in contentBlockDelta and contentBlockStart** — `delta` objects contained a Claude Messages API `type` field (`text_delta`, `thinking_delta`) that is not a member of the Converse API's tagged union. botocore's single-member union parser rejected the extra field with `ResponseParserError`. Also fixed reasoning deltas to use `reasoningContent` (Converse format) instead of `thinking` (Claude format). (Issue #165, reported by @KMiya84377)
- **Converse: `inferenceConfig.maxTokens` silently dropped** — `converseToCompletionRequest` now forwards `maxTokens` to `max_tokens`
- **Converse: non-streaming responses missing `metrics`** — Added `metrics: { latencyMs: 0 }` to all 3 non-streaming converse response builders, matching the streaming path and AWS ConverseResponse spec

### Added

- **Bedrock drift test expansion** — invoke-with-response-stream drift test with binary frame parsing and Anthropic-native event shape comparison. Converse-stream SDK shapes for tool call (`toolUse` start/delta) and reasoning (`reasoningContent` start/delta) variants. Three-way triangulate comparisons for all variants.

## [1.19.3] - 2026-05-08

### Fixed

- **Recorder: multi-turn runs collapsed to a single fixture**. `--record` mode wrote only `userMessage` to the saved fixture's `match` block, so two LLM calls in the same agent run that share the user message (the canonical tool-call → tool-result → follow-up shape) collided in the in-memory fixture cache: as soon as turn 0 was recorded, turn 1 matched it on the same `userMessage` substring, the recorder was skipped, and the follow-up text turn was silently lost. Replaying the resulting single fixture against the same run looped on the tool call until the framework's recursion limit fired. Recorder now also writes `turnIndex` (count of `assistant` messages) and `hasToolResult` (any `role:"tool"` present) — the matcher in 1.16.0 already accepts both — so each call in a run produces a distinct, deterministic match key. Existing single-`userMessage` fixtures continue to match unchanged. Surfaced as: CopilotKit's beautiful-chat showcase having to hot-patch `dist/recorder.js` inside its running aimock container to make `--record` produce usable multi-turn recordings.

## [1.19.2] - 2026-05-07

### Fixed

- **Converse stream: double-wrapped Event Stream payloads** — `buildBedrockStreamTextEvents`, `buildBedrockStreamToolCallEvents`, and `buildBedrockStreamContentWithToolCallsEvents` emitted payloads wrapped with the event type name (e.g. `{ messageStart: { role: "assistant" } }`). The `:event-type` header already carries the event name, so AWS SDK (botocore) expected flat payloads (e.g. `{ role: "assistant" }`). The redundant wrapping caused botocore's `BaseEventStreamParser` to silently return empty dicts, producing `KeyError: 'role'` in downstream frameworks like Strands Agents. (Issue #162, reported by @KMiya84377)
- **Responses API: missing item_id on 3 SSE event types** — Added `item_id` to `response.output_text.done`, `response.content_part.added`, and `response.content_part.done` events, matching the real OpenAI Responses API shape. SDK drift shapes updated.
- **Chat Completions: missing logprobs on choices** — Added `logprobs: null` to all streaming chunks and non-streaming choices. Removed `logprobs` from drift allowlist so future omissions are caught.
- **Ollama: missing created_at on /api/chat** — Added `created_at` to all 6 `/api/chat` builder functions (text, tool call, content+tools, and their streaming variants). The `/api/generate` path already had it.
- **Gemini: error fixtures used Anthropic-style error codes** — Test fixtures and the Gemini Live WebSocket handler now use Google canonical gRPC status codes (`RESOURCE_EXHAUSTED`, `INTERNAL`) instead of `rate_limit_error` / `ERROR`.

## [1.19.1] - 2026-05-07

### Fixed

- **Fixture loader: snapshot-style subdirectories skipped on boot** — `loadFixturesFromDir` now recurses one level into subdirectories to load `<testId>/<provider>.json` files written by the snapshot recorder. Previously the loader skipped all subdirectories with a warning, so recorded fixtures could never be replayed. (Issue #161, reported by @jantimon)
- **CLI: immediate exit on npx/bunx** — Entry-point guard now matches the `aimock` bin name (not just `aimock-cli.js`), fixing silent exit when invoked via `npx aimock` or `bunx aimock`. (Issue #160)

## [1.19.0] - 2026-05-06

### Added

- **Async fixture responses** — Fixture responses can now be sync or async functions that receive the request and return the response dynamically. Enables awaiting side effects (database writes, API calls) before constructing the response — eliminating race conditions in complex multi-turn E2E tests. Works with all providers, streaming, and convenience methods (`on()`, `onMessage()`, `onTurn()`, `onToolCall()`, `onToolResult()`). (Feature request by @5ebastianMeier, issue #154)
- **Snapshot-style recording** — When `X-Test-Id` is present, recorded fixtures are saved to `<fixturePath>/<slugified-testId>/<provider>.json` instead of timestamp-based filenames. Multiple fixtures for the same test+provider merge into one file. Stable paths enable meaningful PR diffs and easy test-to-fixture mapping. (Feature request by @jantimon, issue #155)

### Fixed

- **CORS: Firefox preflight blocked by restricted `Allow-Headers`** — Changed `Access-Control-Allow-Headers` from `Content-Type, Authorization` to wildcard `*`, fixing Firefox's strict CORS enforcement when the OpenAI SDK sends `User-Agent` in the preflight. (Issue #158)
- **GitHub Action: cosmetic binary rename** — `action.yml` fixtures branch referenced the legacy `llmock` binary (still functional); updated to `aimock` for consistency
- **GitHub Action: hardcoded URLs in docs examples** — All workflow examples now use `steps.<id>.outputs.url` instead of hardcoded `http://127.0.0.1:4010`

## [1.18.0] - 2026-05-04

### Added

- **Chaos testing in proxy mode** — Pre-flight chaos (drop/disconnect) prevents upstream contact; post-response chaos (malformed) corrupts relay body after recording the real upstream response. SSE bypass tracked via `aimock_chaos_bypassed_total` metric. Explicit `source` label (`fixture`/`proxy`/`internal`) on all chaos Prometheus counters and journal entries.
- **fal.ai as first-class provider** — General fal.ai handler (`src/fal.ts`) supporting arbitrary JSON request/response payloads (image, video, motion, music, etc.) alongside the existing audio-only `fal-audio.ts`. Routes by `x-fal-target-host` header. Queue lifecycle (submit→status→result→cancel), sync run, storage upload stub. `RawJSONResponse` type for verbatim JSON fixture preservation. Convenience methods `onFalQueue()` and `onFalRun()`. Record and replay support. (PR #153, tombeckenham)

### Fixed

- **Fixture validation for RawJSONResponse** — `validateFixtures()` now recognizes `RawJSONResponse`, fixing the record→restart→replay cycle for fal.ai fixtures loaded from disk

## [1.17.0] - 2026-05-04

### Added

- **Gemini Interactions API** — 12th LLM provider. Full record/replay support for Google's Gemini Interactions streaming API (`/v1beta/models/{model}:streamGenerateContent`), including multi-turn conversations, function calling, streaming text, and safety metadata. Drift tests, integration tests, and documentation included. (PR #139)
- **AG-UI interrupt-aware types** — `AGUIInterrupt`, `AGUIResumeEntry`, and `AGUIRunFinishedOutcome` (discriminated union: success | interrupt) from ag-ui PR #1569. `outcome` field on `AGUIRunFinishedEvent`, `resume` field on `AGUIRunAgentInput`.
- **AG-UI convenience builders** — `buildActivityDelta`, `buildToolCallChunk`, `buildRawEvent`, `buildCustomEvent`, `buildReasoningChunk`, `buildReasoningEncryptedValue`.
- **`./agui` subpath export** — `agui-stub.ts` wired into `tsdown.config.ts` and `package.json` exports, matching `./a2a`, `./mcp`, `./vector` pattern.
- **Complete AG-UI type exports** — All event types (reasoning, step, thinking, raw, custom, chunk), `AGUIBuildOpts`, `matchesAGUIFixture`, `AGUIReasoningEncryptedValueSubtype`, `AGUIMessageRole` now exported from package root.
- **`"warn"` log level** — New log level between `"silent"` and `"info"` with proper hierarchy. `AGUIMockOptions.logLevel` option added; AG-UI mock defaults to `"warn"` instead of `"silent"`.
- **Non-speech audio generation** — Mock support for ElevenLabs sound effects (`/v1/sound-generation`) and music (`/v1/music/*`), fal.ai queue-based audio (`/fal/queue/submit/*`, `/fal/queue/requests/*`, `/fal/run/*`), Gemini HTTP audio via `generateContent`/`streamGenerateContent` with `inlineData` audio parts, and Gemini Live WebSocket audio. Convenience methods: `onAudio()`, `onSoundEffect()`, `onMusic()`, `onFalAudio()`. (PR #140, closes #118)
- **AudioResponse broadened** — `audio` field now supports both `string` (base64) and `{ b64Json, contentType }` object form
- **Gemini audio recording** — Record and replay Gemini audio responses (both streaming SSE and non-streaming JSON)
- **Router audio-gen filtering** — Bidirectional endpoint filtering for `audio-gen` and `fal-audio` endpoint types

### Fixed

- **AG-UI type alignment** — `AGUIMessage.id` and `AGUIRunAgentInput.threadId`/`runId` now required (was optional). `AGUIToolDefinition.description` now required, `metadata` field added. `encryptedValue` and `error` fields added to `AGUIMessage`. `AGUIMessageRole` union covers all 7 protocol roles.
- **AG-UI handler hardening** — `writeAGUIEventStream` logs all caught errors (was silently swallowing non-TypeError/RangeError), preserves user-supplied timestamps (was always overwriting with `Date.now()`). `buildCompositeResponse` omits `RUN_FINISHED` when inner events contain `RUN_ERROR` (protocol compliance). `matchesFixture` resets `lastIndex` on regex before `test()`.
- **AG-UI recorder SSE parsing** — Handle `data:` lines without space after colon per SSE spec. Serialize predicate-match fixtures as `__NO_USER_MESSAGE__` sentinel on disk instead of producing catch-all `{}`. Return actual HTTP status from proxy (was always boolean/200). Forward upstream content-type on non-2xx responses instead of SSE headers.
- **AG-UI mock error handling** — `readBody` wrapped in try/catch (was unguarded await producing opaque 500s). JSON parse errors now include detail in 400 response. Proxy status correctly journaled.
- **Drift auto-remediation pipeline** — `drift-report-collector` now clones canonical ag-ui repo and runs AG-UI schema drift test alongside HTTP API drift. `test-drift.yml` Slack notification distinguishes AG-UI schema vs HTTP API drift vs infra error; uses `jq` for safe JSON construction. `fix-drift.yml` clones ag-ui before collection, adds `continue-on-error` on autofix with `success()` guard on PR creation. `fix-drift.ts` corrected `src/agui.ts` references to `src/agui-handler.ts`, added SDK type to drift prompt, flexible changelog title matching, ENOENT-specific catch in `syncDescriptionFromReadme`, exit code 4 for no-changes (was collision with exit 2), version bump wrapped in try/catch.
- **AG-UI schema drift test hardening** — `skipIf` guard checks both source files (was only canonical). Field regex handles multi-arg Zod types. Recursive parent field resolution for multi-level inheritance. Comment lines stripped before field matching. Base fields parsed dynamically from source with hardcoded fallback.

## [1.16.4] - 2026-04-30

### Fixed

- **Router: `toolCallId` matched stale tool messages from history**. The matcher previously used `getLastMessageByRole(messages, "tool")`, so once a conversation contained any prior tool result, every subsequent request still had a "last tool message" buried in history — a `toolCallId` fixture could win and shadow `userMessage` matchers for new user turns. Tightened to require the tool message to be the **last** message in the request (which is the only state in which the LLM is being asked to respond to a tool result). Surfaced as: in CopilotKit's beautiful-chat showcase, clicking a second suggestion replayed the first chart's content fixture instead of producing a new tool call.

## [1.16.3] - 2026-04-29

### Fixed

- **Responses API**: `response.function_call_arguments.done` events now include `item_id` field, matching the real OpenAI Responses API shape. Without this, TanStack AI's OpenAI adapter emits `TOOL_CALL_END` with `toolCallId: undefined`, breaking ag-ui verify middleware.

## [1.16.2] - 2026-04-28

### Fixed

- **Bedrock invoke native stream format** — `invoke-with-response-stream` now emits Anthropic-native snake_case payloads (`content_block_delta`, `input_json_delta`) wrapped in Bedrock EventStream `chunk` frames, instead of Converse-style camelCase events. Converse-stream retains camelCase format. (PR #144, sf-jin-ku)
- **Bedrock invoke false-green test** — Reasoning negative test used wrong event filters, masking a real bug; corrected to match actual stream shape (PR #144)
- **Bedrock invoke/stream hardening** — Set `completionReq.stream = true` in streaming handler; use deterministic `tool_use_${index}` fallback IDs; change `textContent || null` to `?? null` to preserve empty strings; warn on unsupported content block types and unexpected roles; add webSearches warning on tool-call-only responses
- **Converse stream shape alignment** — Wrap `contentBlockStop` and `messageStop` payloads to match real AWS Converse API; remove duplicate top-level `contentBlockIndex` from `contentBlockStart`/`contentBlockDelta`; add trailing `metadata` events (usage + latencyMs) to all stream builders
- **Converse request conversion** — Filter empty-string text blocks in all paths; unwrap `inputSchema` from `{ json: {...} }` Converse API wrapper; set `completionReq.stream = true` in streaming handler; add content-loss warnings for non-text blocks; fix error type `||` to `??`

### Changed

- Extract shared test helpers (`createMockReq`/`createMockRes`/`createDefaults`) into `helpers/mock-res.ts`
- Convert reasoning-all-providers tests to per-test server lifecycle
- Add content+toolCalls streaming integration coverage for both invoke and converse paths (PR #144)

## [1.16.1] - 2026-04-28

### Fixed

- **Responses API: item_reference dropped** — `responsesInputToMessages()` now synthesizes an assistant message with a matching `function_call` when a `function_call_output` has no prior matching call, preventing item_reference loss
- **Responses API: annotations missing** — Added `annotations: []` to all four `output_text` content items (streaming `.added`, `.done`, prefix, and non-streaming) for schema conformance
- **Responses API: item_id missing on reasoning events** — Added `item_id` to `reasoning_summary_part.added`, `reasoning_summary_part.done`, and `reasoning_summary_text.done` events
- **Responses API: web_search_call action missing type** — Changed `action: { query }` to `action: { type: "search", query }` in both streaming events and output prefix
- **Responses API: item_reference for text messages** — Extended item_reference handling to cover assistant text messages, not just function_call_output compensation
- **Responses API: multi-fco assistantCount inflation** — Fixed backward scan in `responsesInputToMessages()` to find and append to existing assistant messages with tool_calls instead of creating duplicates

### Added

- **Debug logging across all LLM handlers** — Added `logger.debug("Fixture matched: ...")` on match and `logger.debug("No fixture matched...")` on no-match to: server.ts, responses.ts, messages.ts, gemini.ts, bedrock.ts, bedrock-converse.ts, cohere.ts, ollama.ts, embeddings.ts, images.ts, speech.ts, transcription.ts, video.ts

## 1.16.0

### Added

- **`turnIndex` match criterion**: Stateless conversation-depth matching — counts `role: "assistant"` messages in the request's message array. Use for multi-turn conversation flows in shared/deployed instances where `sequenceIndex` counters break under concurrency. `turnIndex: 0` matches the first turn (no prior assistant messages), `turnIndex: 1` the second, etc.
- **`hasToolResult` match criterion**: Stateless boolean — `true` when any `role: "tool"` message exists in the request, `false` when none do. Simplest option for 2-step HITL flows (tool call → tool result → follow-up).
- `onTurn(turn, pattern, response, opts)` convenience method on the programmatic API.

## 1.15.1

### Fixed

- **Recorder**: crash hardening (headersSent guards, clientDisconnected tracking),
  preserve content alongside toolCalls, Cohere v2 native detection, tool-call ID
  extraction from 5 providers, reasoning/thinking extraction from 4 providers,
  multi-block text join (filter+join instead of find), thinking-only and empty-content
  response handling, Ollama /api/generate format detection, streaming collapse
  reasoning propagation.
- **Bedrock/Converse**: ContentWithToolCallsResponse support, ResponseOverrides wired
  into all non-streaming and streaming builders, Converse-wrapped stream event format,
  text_delta type field on text deltas, proper error envelope on Converse errors,
  webSearches warnings.
- **Cohere v2**: reasoning in all builders + streaming, webSearches warnings,
  response_format forwarding, assistant tool_calls preservation, full
  ResponseOverrides (finish_reason, usage, id) in non-streaming and streaming paths.
- **Server**: readBody 10MB size limit, control API error detail, one-shot error fixture
  race fix, normalizeCompatPath clarity, fixtures_loaded gauge updates on mutations.
- **Competitive matrix**: HTML pipeline fixed (computeChanges, applyChanges,
  updateProviderCounts, extractFeatures all aligned with actual DOM structure).
- **CI workflows**: --auto merge (respects branch protection), Slack secrets via env
  vars, script injection prevention in notify-pr.yml, portable grep.
- **Router**: RegExp g-flag lastIndex reset prevents alternating match/no-match.
- **Jest/Vitest**: save/restore pre-existing env vars in afterAll, loadFixtures
  console.warn on failure.
- **Gemini**: tool_call_id collision fix (shared callCounter), thought-part filtering.
- **Ollama**: ContentWithToolCallsResponse support, default stream:true, field validation.

## 1.14.9

### Fixed

- Removed the `preinstall: npx only-allow pnpm` script from the published package. That
  hook was intended to guide contributors cloning the monorepo toward pnpm, but it got
  bundled into the published tarball and fired during `npm install -g @copilotkit/aimock`,
  aborting the install with `sh: only-allow: not found` before npm could even resolve the
  binary. The guard belongs on the monorepo root, not inside the shipped package.
  Unblocks CopilotKit's docs CI (and any other consumer installing aimock via npm).

## 1.14.8

### Fixed

- `--proxy-only` mode now accepts URL-only `--fixtures` sources without requiring a local
  filesystem path. Previously the first `--fixtures` value was always checked as a
  record-destination base path, which rejected all-URL invocations even though proxy-only
  mode doesn't write recordings to disk. The check now fires only for `--record` mode
  where a writable destination is actually required. Same fix applied to the parallel
  `--agui-proxy-only` CLI path. Unblocks the showcase-aimock Railway service which runs
  aimock in proxy-only mode with remote GitHub raw fixture URLs and no local fallback.

## 1.14.7

### Added

- `--fixtures` now accepts `https://` and `http://` URLs to JSON fixture files in addition to filesystem paths. Fetches at boot, parses, and registers the remote fixture as if loaded from disk. On-disk cache at `~/.cache/aimock/fixtures/<sha256-of-url>/` (honoring `$XDG_CACHE_HOME`) provides resilience against transient upstream failures: with `--validate-on-load`, a fetch failure with a valid cached copy logs a warning and continues; without a cache, the process exits non-zero. HTTP fetch has a hard-coded 10s timeout and a 50 MB body size cap (enforced incrementally so a lying `Content-Length` cannot bypass it). Only `https://` and `http://` schemes are accepted — `file://`, `ftp://`, etc. are rejected with a clear error. The flag is now repeatable; multiple sources are loaded and concatenated. Tarball (`.tar.gz`) and zip URL support intentionally deferred to a future release.
- Private-address denylist for remote `--fixtures` URLs: fetches to loopback (`127.0.0.0/8`, `::1`), link-local (`169.254.0.0/16`, `fe80::/10`), RFC1918 (`10/8`, `172.16/12`, `192.168/16`), CGNAT (`100.64/10`), cloud-metadata (`169.254.169.254`), ULA (`fc00::/7`), multicast, and other reserved ranges are rejected with a clear fail-loud error. Hostnames are resolved and every returned address is checked. Set `AIMOCK_ALLOW_PRIVATE_URLS=1` to opt out (required for local dev / tests that target `127.0.0.1`).
- HTTP redirects are rejected (fail-loud) for remote `--fixtures` URLs to prevent scheme-bypass (a 3xx `Location:` pointing at `file://` or `javascript:` would otherwise sidestep the scheme gate and SSRF denylist). Configure the upstream to serve the final URL directly — GitHub raw content URLs already do this.

## 1.14.6

### Changed

- README DevX: Quick Start sets `OPENAI_BASE_URL` + `OPENAI_API_KEY` before SDK construction with an inline ordering warning; Docker one-liner uses absolute `$(pwd)/fixtures:/fixtures` path; `LLMock` class name asymmetry after the v1.7.0 package rename is explained inline; Multimedia and Protocol-Mock feature bullets now link to each individual feature page.
- Fixtures page: Vertex AI added to Provider Support Matrix; Ollama Reasoning marked as supported (was incorrectly "—" since v1.8.0); `finishReason` Responses-API mapping fully documented; `toolName` scope clarified; shadowing-warning format matches actual validator output; Azure-inherits-OpenAI override support footnoted.
- Record & Replay page: Docker examples use absolute `$(pwd)` paths; Rust `async-openai` example corrected to `Client::with_config(OpenAIConfig::new().with_api_base(...))` form; `enableRecording({ proxyOnly: true })` disambiguated; pseudocode annotated as simplified; `enableRecording` example includes `mock.stop()` cleanup; stale 2025 timestamp replaced with generic placeholder.
- Sidebar: TOC id-assignment now runs unconditionally (previously skipped on pages with fewer than 4 headings, silently breaking cross-page anchor links to short pages).
- Historical CHANGELOG: v1.14.1 Railway-specific language scrubbed; v1.14.2 `--journal-max=-1` rejection and `createServer()` default flip annotated with BREAKING / BEHAVIOR CHANGE markers; all 15 historical version entries standardized on Keep-a-Changelog categories (Added/Changed/Fixed/Removed) instead of mixed Changesets-style.
- package.json: `engines.node` raised to `>=24.0.0` to match OIDC publish requirement; `preinstall: only-allow pnpm` guard added; deprecated `@google/generative-ai` swapped for `@google/genai`; `files` includes `CHANGELOG.md`; `repository.url` canonicalized; `typesVersions` gains `.d.cts` entries; optional `peerDependencies` for `vitest`/`jest` added; `prepare: husky || true` tightened to `husky`; `release` script gains `pnpm test && pnpm lint` pre-check.

### Removed

- Stray `package-lock.json` — repo is pnpm-only, now enforced via `preinstall`.

## 1.14.5

### Fixed

- Recorder no longer buffers SSE (`text/event-stream`) upstream responses before relaying to the client. `proxyAndRecord` accumulated all upstream chunks and replayed them via a single `res.end()`, collapsing multi-frame streams into one client-visible write and breaking progressive rendering for downstream consumers (notably showcase `--proxy-only` deployments). SSE responses now stream chunk-by-chunk to the client while still being tee'd into the recording buffer; non-SSE behavior is unchanged.

## 1.14.4

### Added

- Multi-turn conversations documentation page covering the tool-round idiom, matching semantics across turns, and how to author/record multi-turn fixtures.
- Matching Semantics section on the Fixtures page documenting last-message-only matching, first-wins file order, substring-vs-exact matching, and shadowing warnings.
- Recording guidance for multi-turn conversations on the Record & Replay page.
- CLI Flags table on the Record & Replay page expanded to cover `-f/--fixtures`, `--journal-max`, `--fixture-counts-max`, `--agui-*`, `--chaos-*`, `--watch`, `-p`, `-h`, `--log-level`, `--validate-on-load`.
- README note clarifying that the `llmock` CLI bin is a legacy alias pointing at a narrower flag-driven CLI without `--config` or `convert` support.

### Fixed

- Docker examples in the Record & Replay guide no longer prefix `npx @copilotkit/aimock` before the image ENTRYPOINT (the four snippets would have failed with strict parseArgs rejecting positional args).
- Auth Header Forwarding documentation now reflects the strip-list behavior that has been in place since v1.6.1 (all headers forwarded except hop-by-hop and client-set).
- `requestTransform` example fixture key no longer carries an undocumented load-bearing trailing space.
- Completed the Claude model-id migration (v1.14.3) for the remaining test fixtures that still referenced `claude-sonnet-4-20250514`.
- README LLM Providers count and migration-page comparisons restored to the "11+" form with accurate enumeration (OpenAI Chat / Responses / Realtime, Claude, Gemini REST / Live WS, Azure, Bedrock, Vertex AI, Ollama, Cohere). The earlier "8" collapse was incorrect: competitors count endpoint/protocol variants separately, and "8" undersold aimock's actual coverage. Provider Support Matrix on the Fixtures page gains a dedicated Vertex AI column.
- Corrected `toolCallId` matching semantics on the Fixtures page to describe the "last `role: "tool"` message" rule from `router.ts` (not "last message being a tool").
- Added `-h 0.0.0.0` to every Docker example in the README and Record & Replay page so the default `127.0.0.1` host bind doesn't silently break `-p` port mapping when user args override the image CMD.
- Extended the Docker host-bind fix across all migration guides, tutorials, and the Docker/aimock-cli/metrics/chaos-testing pages — every Docker example that passes user args now includes `-h 0.0.0.0` so `docker -p` port mapping works.
- Updated `--journal-max` default wording on the Record & Replay page to reflect post-v1.14.2 behavior (finite `1000` cap for both `serve` and `createServer()`; only direct `new Journal()` instantiation remains unbounded).
- Stripped redundant `npx @copilotkit/aimock` / `aimock` prefixes from Docker examples in migration pages (mokksy, vidaimock, mock-llm, piyook, openai-responses); all were silently broken under strict parseArgs because the prefix became a positional arg to the image's `node dist/cli.js` entrypoint.
- Replaced `--config` Docker examples across `docs/aimock-cli`, `docs/metrics`, `docs/chaos-testing`, and migration guides with flag-driven Docker equivalents or explicit npx/local-install notes (the published image's ENTRYPOINT runs the `llmock` CLI which does not support `--config`).
- Synchronized LLM provider counts across all migration pages to the "11+" form with accurate variant-level enumeration, restoring competitor-equivalent counting (e.g. VidaiMock "11+", Mokksy "11 vs 5").
- Corrected the `sequenceIndex` gotcha on `/multi-turn` — `validateFixtures` does not factor `sequenceIndex`, `toolCallId`, `model`, or `predicate` into the duplicate-`userMessage` warning; the warning is advisory when a runtime differentiator is present.
- Fixed the Programmatic Recording example on `/record-replay` to stop contradicting itself by pairing `proxyOnly: true` with `fixturePath`; now shows record mode and proxy-only mode as two distinct examples.
- Reconciled provider-count phrasing across migration pages — mock-llm lead paragraph no longer says "9 more providers", enumerated lists no longer trail the count with "and OpenAI-compatible providers" / "and more". Aligned the `validateFixtures` shadowing wording between the Fixtures and Multi-Turn pages (both now correctly describe the warning as advisory when a runtime differentiator is present).
- Replaced broken `class="cmt"` CSS class with correct `class="cm"` across `docs/cohere`, `docs/test-plugins`, `docs/vertex-ai`, `docs/ollama`, `docs/record-replay`, and `docs/chaos-testing` code blocks (21 occurrences) — `.cmt` is not defined in `docs/style.css`, so these code-block comments were rendering as default text instead of the dimmed comment color.

## 1.14.3

### Added

- Microsoft Agent Framework (MAF) integration guide with Python and .NET examples.
- Generic `.code-tabs` language switcher with cross-section sync and localStorage persistence.

### Changed

- Updated Claude model references from `claude-sonnet-4-20250514` (retiring 2026-06-15) to `claude-sonnet-4-6`.

## 1.14.2

> **BREAKING** — CLI flag parsing: `--journal-max=-1` (and `--fixture-counts-max=-1`) no longer silently maps to "unbounded"; it is now rejected with a clear error. Migration: drop the flag entirely, or pass `--journal-max=0` / `--fixture-counts-max=0` if you intended unbounded retention.
>
> **⚠ BEHAVIOR CHANGE (should have been MINOR per SemVer)** — `createServer()` programmatic defaults for `journalMaxEntries` and `fixtureCountsMaxTestIds` flipped from unbounded to finite caps (1000 / 500). Auto-update consumers on long-running embedders: review your retention assumptions and opt in to unbounded explicitly by passing `0` if that was the prior relied-upon behavior. Released as a PATCH; in retrospect this warranted a MINOR bump.

### Fixed

- `Journal.getFixtureMatchCount()` is now read-only: calling it with an unknown testId no longer inserts an empty map or triggers FIFO eviction of a live testId. Reads never mutate cache state.
- CLI rejects negative values for `--journal-max` and `--fixture-counts-max` with a clear error (previously silently treated as unbounded). **Breaking for anyone passing `-1` expecting unbounded** — see note above.

### Changed

- `createServer()` programmatic default: `journalMaxEntries` and `fixtureCountsMaxTestIds` now default to finite caps (1000 / 500) instead of unbounded. Long-running embedders that relied on unbounded retention must now opt in explicitly by passing `0`. Back-compat with test harnesses using `new Journal()` directly is preserved (they still default to unbounded). **Note:** this is a behavior change that in retrospect warranted a MINOR bump rather than PATCH.

### Added

- New `--fixture-counts-max <n>` CLI flag (default 500) to cap the fixture-match-counts map by testId.

## 1.14.1

### Fixed

- Cap in-memory journal (and fixture-match-counts map) to prevent heap OOM under sustained load. `Journal.entries` was unbounded, causing heap growth ~3.8MB/sec to 4GB → OOM in ~18 minutes on long-running production deployments. Default cap for CLI (`serve`) is now 1000 entries; programmatic `createServer()` remains unbounded by default (back-compat). See `--journal-max` flag.

## 1.14.0

### Added

- Response template merging — override `id`, `created`, `model`, `usage`, `finishReason`, `role`, `systemFingerprint` on fixture responses across all 4 provider formats (OpenAI, Claude, Gemini, Responses API) (#111)
- JSON auto-stringify — fixture `arguments` and `content` fields accept objects that are auto-stringified by the loader, eliminating escaped JSON pain (#111)
- Migration guide from openai-responses-python (#111)
- All fixture examples and docs converted to object syntax (#111)
- `ResponseOverrides` field validation in `validateFixtures` — catches invalid types for `id`, `created`, `model`, `usage`, `finishReason`, `role`, `systemFingerprint`

### Fixed

- `onTranscription` docs now show correct 1-argument signature
- `validateFixtures` now recognizes ContentWithToolCalls and multimedia response types

## 1.13.0

### Added

- GitHub Action for one-line CI setup — `uses: CopilotKit/aimock@v1` with fixtures, config, port, args, and health check (#102)
- Fixture converters wired into the CLI — `npx @copilotkit/aimock convert vidaimock` and `npx @copilotkit/aimock convert mockllm` as first-class subcommands (#102)
- 30 npm keywords for search discoverability (#102)
- Fixture gallery with 11 examples covering all mock types, plus browsable docs page at /examples (#102)
- Vitest and jest plugins for zero-config testing — `import { useAimock } from "@copilotkit/aimock/vitest"` (#102)

### Changed

- Strip video URLs from README for npm publishing (#102)

## 1.12.0

### Added

- Multimedia endpoint support: image generation (OpenAI DALL-E + Gemini Imagen), text-to-speech, audio transcription, and video generation with async polling (#101)
- `match.endpoint` field for fixture isolation — prevents cross-matching between chat, image, speech, transcription, video, and embedding fixtures (#101)
- Bidirectional endpoint filtering — generic fixtures only match compatible endpoint types (#101)
- Convenience methods: `onImage`, `onSpeech`, `onTranscription`, `onVideo` (#101)
- Record & replay for all multimedia endpoints — proxy to real APIs, save fixtures with correct format/type detection (#101)
- `_endpointType` explicit field on `ChatCompletionRequest` for type safety (#101)
- Comparison matrix and drift detection rules updated for multimedia (#101)
- 54 new tests (32 integration, 11 record/replay, 12 type/routing)

## 1.11.0

### Added

- `AGUIMock` — mock the AG-UI (Agent-to-UI) protocol for CopilotKit frontend testing. All 33 event types, 11 convenience builders, fluent registration API, SSE streaming with disconnect handling (#100)
- AG-UI record & replay with tee streaming — proxy to real AG-UI agents, record event streams as fixtures, replay on subsequent requests. Includes `--proxy-only` mode for demos (#100)
- AG-UI schema drift detection — compares aimock event types against canonical `@ag-ui/core` Zod schemas to catch protocol changes (#100)
- `--agui-record`, `--agui-upstream`, `--agui-proxy-only` CLI flags (#100)

### Removed

- Section bar from docs pages (cleanup)

## 1.10.0

### Added

- `--proxy-only` flag — proxy unmatched requests to upstream providers without saving fixtures to disk or caching in memory. Every unmatched request always hits the real provider, preventing stale recorded responses in demo/live environments (#99)

## 1.9.0

### Added

- Per-test sequence isolation via `X-Test-Id` header — each test gets its own fixture match counters, wired through all 12 HTTP handlers and 3 WebSocket handlers. No more test pollution from shared sequential state (#93)
- Combined `content + toolCalls` in fixture responses — new `ContentWithToolCallsResponse` type and type guard, supported across OpenAI Chat, OpenAI Responses, Anthropic Messages, and Gemini, with stream collapse support (#92)
- OpenRouter `reasoning_content` support in chat completions (#88)
- Demo video in README (#91)
- CI: Slack notifications for drift tests, competitive matrix updates, and new PRs (#86)
- Docs: reasoning and webSearches rows in Response Types table

### Fixed

- `web_search_call` items now use `action.query` matching real OpenAI API format (#89)
- Homepage URL cleaned up (remove `/index.html` suffix) (#90)
- Record & Replay section title now centered and terminal panel top-aligned (#87)
- CI: use `pull_request_target` for fork PR Slack alerts

## 1.8.0

### Added

- `requestTransform` option for deterministic matching and recording — normalizes requests before matching (strips timestamps, UUIDs, session IDs) and switches to exact equality when set. Applied across all 15 provider handlers and the recorder. (#79, based on design by @iskhakovt in #63)
- Reasoning/thinking support for OpenAI Chat Completions — `reasoning` field in fixtures generates `reasoning_content` in responses and streaming `reasoning` deltas (#62 by @erezcor)
- Reasoning support for Gemini (`thoughtParts`), AWS Bedrock InvokeModel + Converse (`thinking` blocks), and Ollama (`think` tags) (#81)
- Web search result events for OpenAI Responses API (#62)
- Open Graph image and meta tags for social sharing
- CI: `npm` environment to release workflow for deployment tracking; `workflow_dispatch` added to Python test workflow

### Changed

- Updated all GitHub repo URLs from CopilotKit/llmock to CopilotKit/aimock
- Reframed drift detection docs for users ("your mocks never go stale") with restored drift report output

### Fixed

- Migration page examples: replaced fragile `time.sleep` with health check loops against `/__aimock/health`; fixed Python npx example `stderr=subprocess.PIPE` deadlock (#80)
- Stream collapse now handles reasoning events correctly

## 1.7.0

### Added

- MCPMock — Model Context Protocol mock with tools, resources, prompts, session management
- A2AMock — Agent-to-Agent protocol mock with SSE streaming
- VectorMock — Pinecone, Qdrant, ChromaDB compatible vector DB mock
- Search (Tavily), rerank (Cohere), and moderation (OpenAI) service mocks
- `/__aimock/*` control API for external fixture management
- `aimock` CLI with JSON config file support
- Mount composition for running multiple protocol handlers on one server
- JSON-RPC 2.0 transport with batch and notifications
- `aimock-pytest` pip package for native Python testing
- Converter scripts: `convert-vidaimock` (Tera → JSON) and `convert-mockllm` (YAML → JSON)
- Drift automation skill updates — `fix-drift.ts` now updates `skills/write-fixtures/SKILL.md` alongside source fixes
- Docker: dual-push `ghcr.io/copilotkit/aimock` + `ghcr.io/copilotkit/llmock` (compat)
- 6 migration guides: MSW, VidaiMock, mock-llm, piyook, Python mocks, Mokksy
- Docs: sidebar.js, cli-tabs.js, section bar, competitive matrix with 25 rows

### Changed

- Renamed package from `@copilotkit/llmock` to `@copilotkit/aimock`
- Renamed Prometheus metrics to `aimock_*` with new MCP/A2A/Vector counters
- Rebranded logger `[aimock]`, chaos headers `x-aimock-chaos-*`, CLI startup message
- Helm chart renamed to `charts/aimock/`
- Homepage redesigned (Treatment 3: Progressive Disclosure)

## 1.6.1

### Fixed

- Record proxy now preserves upstream URL path prefixes — base URLs like `https://gateway.company.com/llm` now correctly resolve to `gateway.company.com/llm/v1/chat/completions` instead of losing the `/llm` prefix (PR #57)
- Record proxy now forwards all request headers to upstream, not just `Content-Type` and auth headers. Hop-by-hop headers (`connection`, `keep-alive`, `transfer-encoding`, etc.) and client-set headers (`host`, `content-length`, `cookie`, `accept-encoding`) are still stripped (PR #58)
- Recorder now decodes base64-encoded embeddings when `encoding_format: "base64"` is set in the request. Python's openai SDK uses this by default. Previously these were saved as `proxy_error` fixtures (PR #64)
- Guarded base64 embedding decode against corrupted data (non-float32-aligned buffers fall through gracefully instead of crashing)

### Added

- `--summary` flag on the competitive matrix update script for markdown-formatted change summaries

## 1.6.0

### Added

- Provider-specific endpoints: dedicated routes for Bedrock (`/model/{modelId}/invoke`), Ollama (`/api/chat`, `/api/generate`), Cohere (`/v2/chat`), and Azure OpenAI deployment-based routing (`/openai/deployments/{id}/chat/completions`)
- Chaos injection: `ChaosConfig` type with `drop`, `malformed`, and `disconnect` actions; supports per-fixture chaos via `chaos` config on each fixture and server-wide chaos via `--chaos-drop`, `--chaos-malformed`, and `--chaos-disconnect` CLI flags
- Metrics: `GET /metrics` endpoint exposing Prometheus text format with request counters and latency histograms per provider and route
- Record-and-replay: `--record` flag and `proxyAndRecord` helper that proxies requests to real LLM APIs, collapses streaming responses, and writes fixture JSON to disk for future playback

## 1.5.1

### Fixed

- Documentation URLs now use the correct domain (llmock.copilotkit.dev)

## 1.5.0

### Added

- Embeddings API: `POST /v1/embeddings` endpoint, `onEmbedding()` convenience method, `inputText` match field, `EmbeddingResponse` type, deterministic fallback embeddings from input hash, Azure embedding routing
- Structured output / JSON mode: `responseFormat` match field, `onJsonOutput()` convenience method
- Sequential responses: `sequenceIndex` match field for stateful multi-turn fixtures, per-fixture-group match counting, `resetMatchCounts()` method
- Streaming physics: `StreamingProfile` type with `ttft`, `tps`, `jitter` fields for realistic timing simulation
- AWS Bedrock: `POST /model/{modelId}/invoke` endpoint, Anthropic Messages format translation
- Azure OpenAI: provider routing for `/openai/deployments/{id}/chat/completions` and `/openai/deployments/{id}/embeddings`
- Health & models endpoints: `GET /health`, `GET /ready`, `GET /v1/models` (auto-populated from fixtures)
- Docker & Helm: Dockerfile, Helm chart for Kubernetes deployment
- Documentation website: full docs site at llmock.copilotkit.dev with feature pages and competitive comparison matrix
- Automated drift remediation: `scripts/drift-report-collector.ts` and `scripts/fix-drift.ts` for CI-driven drift fixes
- CI automation: competitive matrix update workflow, drift fix workflow
- `FixtureOpts` and `EmbeddingFixtureOpts` type aliases exported for external consumers
- `.worktrees/` to eslint ignores

### Changed

- Default to non-streaming for Claude Messages API and Responses API (matching real API defaults)
- README rewritten as concise overview with links to docs site
- Write-fixtures skill updated for all v1.5.0 features
- Docs site: Get Started links to docs, comparison above reliability, npm version badge

### Fixed

- Gemini Live handler no longer crashes on malformed `clientContent.turns` and `toolResponse.functionResponses`
- Added `isClosed` guard before WebSocket finalization events (prevents writes to closed connections)
- `streamingProfile` now present on convenience method opts types (`on`, `onMessage`, etc.)
- skills/ symlink direction corrected so `npm pack` includes the write-fixtures skill
- `.claude` removed from package.json files (was dead weight — symlink doesn't ship)
- Watcher cleanup on error (clear debounce timer, null guard)
- Empty-reload guard (keep previous fixtures when reload produces 0)

### Removed

- Dead `@keyframes sseLine` CSS from docs site

## 1.4.0

### Added

- `--watch` (`-w`): File-watching with 500ms debounced reload. Keeps previous fixtures on validation failure.
- `--log-level`: Configurable log verbosity (`silent`, `info`, `debug`). Default `info` for CLI, `silent` for programmatic API.
- `--validate-on-load`: Fixture schema validation at startup — checks response types, tool call JSON, numeric ranges, shadowing, and catch-all positioning.
- `validateFixtures()` exported for programmatic use
- `Logger` class exported for programmatic use

## 1.3.3

### Added

- WebSocket drift detection tests: TLS client for real provider WS endpoints, 4 verified drift tests (Responses WS + Realtime), Gemini Live canary for text-capable model availability
- Realtime model canary: detects when `gpt-4o-mini-realtime-preview` is deprecated and suggests GA replacement
- Gemini Live documented as unverified (no text-capable `bidiGenerateContent` model exists yet)

### Fixed

- Responses WS handler now accepts flat `response.create` format matching the real OpenAI API (previously required a non-standard nested `response: { ... }` envelope)
- README Gemini Live response shape example corrected (`modelTurn.parts`, not `modelTurnComplete`)

## 1.3.2

### Added

- Live API drift detection test suite: three-layer triangulation between SDK types, real API responses, and llmock output across OpenAI (Chat + Responses), Anthropic Claude, and Google Gemini
- Weekly CI workflow for automated drift checks
- `DRIFT.md` documentation for the drift detection system

### Fixed

- Missing `refusal` field on OpenAI Chat Completions responses — both the SDK and real API return `refusal: null` on non-refusal messages, but llmock was omitting it

## 1.3.1

### Added

- Claude Code fixture authoring skill (`/write-fixtures`) — comprehensive guide for match fields, response types, agent loop patterns, gotchas, and debugging
- Claude Code plugin structure for downstream consumers (`--plugin-dir`, `--add-dir`, or manual copy)

### Changed

- README and docs site updated with Claude Code integration instructions

## 1.3.0

### Added

- Mid-stream interruption: `truncateAfterChunks` and `disconnectAfterMs` fixture fields to simulate abrupt server disconnects
- AbortSignal-based cancellation primitives (`createInterruptionSignal`, signal-aware `delay()`)
- Backward-compatible `writeSSEStream` overload with `StreamOptions` returning completion status
- Interruption support across all HTTP SSE and WebSocket streaming paths
- `destroy()` method on `WebSocketConnection` for abrupt disconnect simulation
- Journal records `interrupted` and `interruptReason` on interrupted streams
- LLMock convenience API extended with interruption options (`truncateAfterChunks`, `disconnectAfterMs`)

## 1.2.0

### Added

- Zero-dependency RFC 6455 WebSocket framing layer
- OpenAI Responses API over WebSocket (`/v1/responses`)
- OpenAI Realtime API over WebSocket (`/v1/realtime`) — text + tool calls
- Gemini Live BidiGenerateContent over WebSocket — text + tool calls
- Future Direction section in README

### Fixed

- WebSocket close-frame lifecycle
- Improved error visibility across WebSocket handlers

## 1.1.1

### Added

- Function call IDs on Gemini tool call responses

### Removed

- Changesets (simplified release workflow)

## 1.1.0

### Added

- 9948a8b: `prependFixture()` and `getFixtures()` public API methods

## 1.0.1

### Added

- `getTextContent` for array-format message content handling
