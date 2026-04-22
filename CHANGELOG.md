# @copilotkit/aimock

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
