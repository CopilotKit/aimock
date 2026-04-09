# @copilotkit/aimock

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
