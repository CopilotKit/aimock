# @copilotkit/aimock

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

### Fixed

- `Journal.getFixtureMatchCount()` is now read-only: calling it with an unknown testId no longer inserts an empty map or triggers FIFO eviction of a live testId. Reads never mutate cache state.
- CLI rejects negative values for `--journal-max` and `--fixture-counts-max` with a clear error (previously silently treated as unbounded).

### Changed

- `createServer()` programmatic default: `journalMaxEntries` and `fixtureCountsMaxTestIds` now default to finite caps (1000 / 500) instead of unbounded. Long-running embedders that relied on unbounded retention must now opt in explicitly by passing `0`. Back-compat with test harnesses using `new Journal()` directly is preserved (they still default to unbounded).

### Added

- New `--fixture-counts-max <n>` CLI flag (default 500) to cap the fixture-match-counts map by testId.

## 1.14.1

### Patch Changes

- Cap in-memory journal (and fixture-match-counts map) to prevent heap OOM under sustained load. `Journal.entries` was unbounded, causing heap growth ~3.8MB/sec to 4GB → OOM in ~18 minutes on production Railway deployments. Default cap for CLI (`serve`) is now 1000 entries; programmatic `createServer()` remains unbounded by default (back-compat). See `--journal-max` flag.

## 1.14.0

### Minor Changes

- Response template merging — override `id`, `created`, `model`, `usage`, `finishReason`, `role`, `systemFingerprint` on fixture responses across all 4 provider formats (OpenAI, Claude, Gemini, Responses API) (#111)
- JSON auto-stringify — fixture `arguments` and `content` fields accept objects that are auto-stringified by the loader, eliminating escaped JSON pain (#111)
- Migration guide from openai-responses-python (#111)
- All fixture examples and docs converted to object syntax (#111)

### Patch Changes

- Fix `onTranscription` docs to show correct 1-argument signature
- Fix `validateFixtures` to recognize ContentWithToolCalls and multimedia response types
- Add `ResponseOverrides` field validation in `validateFixtures` — catches invalid types for `id`, `created`, `model`, `usage`, `finishReason`, `role`, `systemFingerprint`

## 1.13.0

### Minor Changes

- Add GitHub Action for one-line CI setup — `uses: CopilotKit/aimock@v1` with fixtures, config, port, args, and health check (#102)
- Wire fixture converters into CLI — `npx @copilotkit/aimock convert vidaimock` and `npx @copilotkit/aimock convert mockllm` as first-class subcommands (#102)
- Add 30 npm keywords for search discoverability (#102)
- Add fixture gallery with 11 examples covering all mock types, plus browsable docs page at /examples (#102)
- Add vitest and jest plugins for zero-config testing — `import { useAimock } from "@copilotkit/aimock/vitest"` (#102)
- Strip video URLs from README for npm publishing (#102)

## 1.12.0

### Minor Changes

- Multimedia endpoint support: image generation (OpenAI DALL-E + Gemini Imagen), text-to-speech, audio transcription, and video generation with async polling (#101)
- `match.endpoint` field for fixture isolation — prevents cross-matching between chat, image, speech, transcription, video, and embedding fixtures (#101)
- Bidirectional endpoint filtering — generic fixtures only match compatible endpoint types (#101)
- Convenience methods: `onImage`, `onSpeech`, `onTranscription`, `onVideo` (#101)
- Record & replay for all multimedia endpoints — proxy to real APIs, save fixtures with correct format/type detection (#101)
- `_endpointType` explicit field on `ChatCompletionRequest` for type safety (#101)
- Comparison matrix and drift detection rules updated for multimedia (#101)
- 54 new tests (32 integration, 11 record/replay, 12 type/routing)

## 1.11.0

### Minor Changes

- Add `AGUIMock` — mock the AG-UI (Agent-to-UI) protocol for CopilotKit frontend testing. All 33 event types, 11 convenience builders, fluent registration API, SSE streaming with disconnect handling (#100)
- Add AG-UI record & replay with tee streaming — proxy to real AG-UI agents, record event streams as fixtures, replay on subsequent requests. Includes `--proxy-only` mode for demos (#100)
- Add AG-UI schema drift detection — compares aimock event types against canonical `@ag-ui/core` Zod schemas to catch protocol changes (#100)
- Add `--agui-record`, `--agui-upstream`, `--agui-proxy-only` CLI flags (#100)
- Remove section bar from docs pages (cleanup)

## 1.10.0

### Minor Changes

- Add `--proxy-only` flag — proxy unmatched requests to upstream providers without saving fixtures to disk or caching in memory. Every unmatched request always hits the real provider, preventing stale recorded responses in demo/live environments (#99)

## 1.9.0

### Minor Changes

- Per-test sequence isolation via `X-Test-Id` header — each test gets its own fixture match counters, wired through all 12 HTTP handlers and 3 WebSocket handlers. No more test pollution from shared sequential state (#93)
- Combined `content + toolCalls` in fixture responses — new `ContentWithToolCallsResponse` type and type guard, supported across OpenAI Chat, OpenAI Responses, Anthropic Messages, and Gemini, with stream collapse support (#92)
- OpenRouter `reasoning_content` support in chat completions (#88)

### Patch Changes

- Fix `web_search_call` items to use `action.query` matching real OpenAI API format (#89)
- Clean up homepage URL (remove `/index.html` suffix) (#90)
- Center Record & Replay section title and top-align terminal panel (#87)
- Add demo video to README (#91)
- CI: Slack notifications for drift tests, competitive matrix updates, and new PRs (#86)
- CI: use `pull_request_target` for fork PR Slack alerts
- Docs: add reasoning and webSearches to Response Types table

## 1.8.0

### Minor Changes

- Add `requestTransform` option for deterministic matching and recording — normalizes requests before matching (strips timestamps, UUIDs, session IDs) and switches to exact equality when set. Applied across all 15 provider handlers and the recorder. (#79, based on design by @iskhakovt in #63)
- Add reasoning/thinking support for OpenAI Chat Completions — `reasoning` field in fixtures generates `reasoning_content` in responses and streaming `reasoning` deltas (#62 by @erezcor)
- Add reasoning support for Gemini (`thoughtParts`), AWS Bedrock InvokeModel + Converse (`thinking` blocks), and Ollama (`think` tags) (#81)
- Add web search result events for OpenAI Responses API (#62)

### Patch Changes

- Fix migration page examples: replace fragile `time.sleep` with health check loops against `/__aimock/health`; fix Python npx example `stderr=subprocess.PIPE` deadlock (#80)
- Fix stream collapse to handle reasoning events correctly
- Update all GitHub repo URLs from CopilotKit/llmock to CopilotKit/aimock
- Add Open Graph image and meta tags for social sharing
- Reframe drift detection docs for users ("your mocks never go stale") with restored drift report output
- CI: add `npm` environment to release workflow for deployment tracking; add `workflow_dispatch` to Python test workflow

## 1.7.0

### Minor Changes

- Rename package from `@copilotkit/llmock` to `@copilotkit/aimock`
- Add MCPMock — Model Context Protocol mock with tools, resources, prompts, session management
- Add A2AMock — Agent-to-Agent protocol mock with SSE streaming
- Add VectorMock — Pinecone, Qdrant, ChromaDB compatible vector DB mock
- Add search (Tavily), rerank (Cohere), and moderation (OpenAI) service mocks
- Add `/__aimock/*` control API for external fixture management
- Add `aimock` CLI with JSON config file support
- Add mount composition for running multiple protocol handlers on one server
- Add JSON-RPC 2.0 transport with batch and notifications
- Add `aimock-pytest` pip package for native Python testing
- Add converter scripts: `convert-vidaimock` (Tera → JSON) and `convert-mockllm` (YAML → JSON)
- Add drift automation skill updates — `fix-drift.ts` now updates `skills/write-fixtures/SKILL.md` alongside source fixes
- Rename Prometheus metrics to `aimock_*` with new MCP/A2A/Vector counters
- Rebrand logger `[aimock]`, chaos headers `x-aimock-chaos-*`, CLI startup message
- Docker: dual-push `ghcr.io/copilotkit/aimock` + `ghcr.io/copilotkit/llmock` (compat)
- Helm chart renamed to `charts/aimock/`
- 6 migration guides: MSW, VidaiMock, mock-llm, piyook, Python mocks, Mokksy
- Homepage redesigned (Treatment 3: Progressive Disclosure)
- Docs: sidebar.js, cli-tabs.js, section bar, competitive matrix with 25 rows

## 1.6.1

### Patch Changes

- Fix record proxy to preserve upstream URL path prefixes — base URLs like `https://gateway.company.com/llm` now correctly resolve to `gateway.company.com/llm/v1/chat/completions` instead of losing the `/llm` prefix (PR #57)
- Fix record proxy to forward all request headers to upstream, not just `Content-Type` and auth headers. Hop-by-hop headers (`connection`, `keep-alive`, `transfer-encoding`, etc.) and client-set headers (`host`, `content-length`, `cookie`, `accept-encoding`) are still stripped (PR #58)
- Fix recorder to decode base64-encoded embeddings when `encoding_format: "base64"` is set in the request. Python's openai SDK uses this by default. Previously these were saved as `proxy_error` fixtures (PR #64)
- Guard base64 embedding decode against corrupted data (non-float32-aligned buffers fall through gracefully instead of crashing)
- Add `--summary` flag to competitive matrix update script for markdown-formatted change summaries

## 1.6.0

### Minor Changes

- Provider-specific endpoints: dedicated routes for Bedrock (`/model/{modelId}/invoke`), Ollama (`/api/chat`, `/api/generate`), Cohere (`/v2/chat`), and Azure OpenAI deployment-based routing (`/openai/deployments/{id}/chat/completions`)
- Chaos injection: `ChaosConfig` type with `drop`, `malformed`, and `disconnect` actions; supports per-fixture chaos via `chaos` config on each fixture and server-wide chaos via `--chaos-drop`, `--chaos-malformed`, and `--chaos-disconnect` CLI flags
- Metrics: `GET /metrics` endpoint exposing Prometheus text format with request counters and latency histograms per provider and route
- Record-and-replay: `--record` flag and `proxyAndRecord` helper that proxies requests to real LLM APIs, collapses streaming responses, and writes fixture JSON to disk for future playback

## 1.5.1

### Patch Changes

- Fix documentation URLs to use correct domain (llmock.copilotkit.dev)

## 1.5.0

### Minor Changes

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

### Patch Changes

- Fix Gemini Live handler crash on malformed `clientContent.turns` and `toolResponse.functionResponses`
- Add `isClosed` guard before WebSocket finalization events (prevents writes to closed connections)
- Default to non-streaming for Claude Messages API and Responses API (matching real API defaults)
- Fix `streamingProfile` missing from convenience method opts types (`on`, `onMessage`, etc.)
- Fix skills/ symlink direction so npm pack includes the write-fixtures skill
- Fix `.claude` removed from package.json files (was dead weight — symlink doesn't ship)
- Add `.worktrees/` to eslint ignores
- Remove dead `@keyframes sseLine` CSS from docs site
- Fix watcher cleanup on error (clear debounce timer, null guard)
- Fix empty-reload guard (keep previous fixtures when reload produces 0)
- README rewritten as concise overview with links to docs site
- Write-fixtures skill updated for all v1.5.0 features
- Docs site: Get Started links to docs, comparison above reliability, npm version badge

## 1.4.0

### Minor Changes

- `--watch` (`-w`): File-watching with 500ms debounced reload. Keeps previous fixtures on validation failure.
- `--log-level`: Configurable log verbosity (`silent`, `info`, `debug`). Default `info` for CLI, `silent` for programmatic API.
- `--validate-on-load`: Fixture schema validation at startup — checks response types, tool call JSON, numeric ranges, shadowing, and catch-all positioning.
- `validateFixtures()` exported for programmatic use
- `Logger` class exported for programmatic use

## 1.3.3

### Patch Changes

- Fix Responses WS handler to accept flat `response.create` format matching the real OpenAI API (previously required a non-standard nested `response: { ... }` envelope)
- WebSocket drift detection tests: TLS client for real provider WS endpoints, 4 verified drift tests (Responses WS + Realtime), Gemini Live canary for text-capable model availability
- Realtime model canary: detects when `gpt-4o-mini-realtime-preview` is deprecated and suggests GA replacement
- Gemini Live documented as unverified (no text-capable `bidiGenerateContent` model exists yet)
- Fix README Gemini Live response shape example (`modelTurn.parts`, not `modelTurnComplete`)

## 1.3.2

### Patch Changes

- Fix missing `refusal` field on OpenAI Chat Completions responses — both the SDK and real API return `refusal: null` on non-refusal messages, but llmock was omitting it
- Live API drift detection test suite: three-layer triangulation between SDK types, real API responses, and llmock output across OpenAI (Chat + Responses), Anthropic Claude, and Google Gemini
- Weekly CI workflow for automated drift checks
- `DRIFT.md` documentation for the drift detection system

## 1.3.1

### Patch Changes

- Claude Code fixture authoring skill (`/write-fixtures`) — comprehensive guide for match fields, response types, agent loop patterns, gotchas, and debugging
- Claude Code plugin structure for downstream consumers (`--plugin-dir`, `--add-dir`, or manual copy)
- README and docs site updated with Claude Code integration instructions

## 1.3.0

### Minor Changes

- Mid-stream interruption: `truncateAfterChunks` and `disconnectAfterMs` fixture fields to simulate abrupt server disconnects
- AbortSignal-based cancellation primitives (`createInterruptionSignal`, signal-aware `delay()`)
- Backward-compatible `writeSSEStream` overload with `StreamOptions` returning completion status
- Interruption support across all HTTP SSE and WebSocket streaming paths
- `destroy()` method on `WebSocketConnection` for abrupt disconnect simulation
- Journal records `interrupted` and `interruptReason` on interrupted streams
- LLMock convenience API extended with interruption options (`truncateAfterChunks`, `disconnectAfterMs`)

## 1.2.0

### Minor Changes

- Zero-dependency RFC 6455 WebSocket framing layer
- OpenAI Responses API over WebSocket (`/v1/responses`)
- OpenAI Realtime API over WebSocket (`/v1/realtime`) — text + tool calls
- Gemini Live BidiGenerateContent over WebSocket — text + tool calls

### Patch Changes

- WebSocket close-frame lifecycle fixes
- Improved error visibility across WebSocket handlers
- Future Direction section in README

## 1.1.1

### Patch Changes

- Add function call IDs to Gemini tool call responses
- Remove changesets, simplify release workflow

## 1.1.0

### Minor Changes

- 9948a8b: Add `prependFixture()` and `getFixtures()` public API methods

## 1.0.1

### Patch Changes

- Add `getTextContent` for array-format message content handling
