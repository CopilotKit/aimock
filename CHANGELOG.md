# @copilotkit/llmock

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
