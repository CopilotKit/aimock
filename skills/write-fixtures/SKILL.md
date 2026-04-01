---
name: write-fixtures
description: Use when writing test fixtures for @copilotkit/aimock — mock LLM responses, tool call sequences, error injection, multi-turn agent loops, embeddings, structured output, sequential responses, or debugging fixture mismatches
---

# Writing aimock Test Fixtures

## What aimock Is

aimock is a zero-dependency mock LLM server. Fixture-driven. Multi-provider (OpenAI, Anthropic, Gemini, AWS Bedrock, Azure OpenAI, Vertex AI, Ollama, Cohere). Runs a real HTTP server on a real port — works across processes, unlike MSW-style interceptors. WebSocket support for OpenAI Responses/Realtime and Gemini Live APIs. Chaos testing and Prometheus metrics.

## Core Mental Model

- **Fixtures** = match criteria + response
- **First-match-wins** — order matters
- All providers share one fixture pool (provider adapters normalize to `ChatCompletionRequest`)
- Fixtures are live — mutations after `start()` take effect immediately
- Sequential responses are supported via `sequenceIndex` (match count tracked per fixture)

## Match Field Reference

| Field            | Type                                      | Matches Against                                                               |
| ---------------- | ----------------------------------------- | ----------------------------------------------------------------------------- |
| `userMessage`    | `string`                                  | Substring of last `role: "user"` message text                                 |
| `userMessage`    | `RegExp`                                  | Pattern test on last `role: "user"` message text                              |
| `inputText`      | `string`                                  | Substring of embedding input text (concatenated if multiple inputs)           |
| `inputText`      | `RegExp`                                  | Pattern test on embedding input text                                          |
| `toolName`       | `string`                                  | Exact match on any tool in request's `tools[]` array (by `function.name`)     |
| `toolCallId`     | `string`                                  | Exact match on `tool_call_id` of last `role: "tool"` message                  |
| `model`          | `string`                                  | Exact match on `req.model`                                                    |
| `model`          | `RegExp`                                  | Pattern test on `req.model`                                                   |
| `responseFormat` | `string`                                  | Exact match on `req.response_format.type` (`"json_object"`, `"json_schema"`)  |
| `sequenceIndex`  | `number`                                  | Matches only when this fixture's match count equals the given index (0-based) |
| `predicate`      | `(req: ChatCompletionRequest) => boolean` | Custom function — full access to request                                      |

**AND logic**: all specified fields must match. Empty match `{}` = catch-all.

Multi-part content (e.g., `[{type: "text", text: "hello"}]`) is automatically extracted — `userMessage` matching works regardless of content format.

## Response Types

### Text

```typescript
{
  content: "Hello!";
}
```

### Tool Calls

```typescript
{
  toolCalls: [{ name: "get_weather", arguments: '{"city":"SF"}' }];
}
```

**`arguments` MUST be a JSON string**, not an object. This is the #1 mistake.

### Embedding

```typescript
{
  embedding: [0.1, 0.2, 0.3, -0.5, 0.8];
}
```

The embedding vector is returned for each input in the request. If no embedding fixture matches, deterministic embeddings are auto-generated from the input text hash — you only need fixtures when you want specific vectors.

### Error

```typescript
{ error: { message: "Rate limited", type: "rate_limit_error" }, status: 429 }
```

### Chaos (Failure Injection)

The optional `chaos` field on a fixture enables probabilistic failure injection:

```typescript
{
  chaos?: {
    dropRate?: number;      // Probability (0-1) of returning a 500 error
    malformedRate?: number; // Probability (0-1) of returning malformed JSON
    disconnectRate?: number; // Probability (0-1) of disconnecting mid-stream
  }
}
```

Rates are evaluated per-request. When triggered, the chaos failure replaces the normal response.

## Common Patterns

### Basic text fixture

```typescript
mock.onMessage("hello", { content: "Hi there!" });
```

### Tool call → tool result → final response (3-step agent loop)

The most common pattern. Fixture 1 triggers the tool call, fixture 2 handles the tool result.

```typescript
// Step 1: User asks about weather → LLM calls tool
mock.onMessage("weather", {
  toolCalls: [{ name: "get_weather", arguments: '{"city":"SF"}' }],
});

// Step 2: Tool result comes back → LLM responds with text
mock.addFixture({
  match: { predicate: (req) => req.messages.at(-1)?.role === "tool" },
  response: { content: "It's 72°F in San Francisco." },
});
```

**Why predicate, not userMessage?** After a tool call, the client replays the same conversation with the tool result appended. The user message hasn't changed — `userMessage: "weather"` would match the SAME fixture again, creating an infinite loop.

### Embedding fixture

```typescript
// Match specific input text
mock.onEmbedding("search query", {
  embedding: [0.1, 0.2, 0.3, 0.4, 0.5],
});

// Match with regex
mock.onEmbedding(/product.*description/, {
  embedding: [0.9, -0.1, 0.5, 0.3, 0.2],
});
```

### Structured output / JSON mode

```typescript
// onJsonOutput auto-sets responseFormat: "json_object" and stringifies objects
mock.onJsonOutput("extract entities", {
  entities: [
    { name: "Acme Corp", type: "company" },
    { name: "Jane Doe", type: "person" },
  ],
});

// Equivalent manual form:
mock.addFixture({
  match: { userMessage: "extract entities", responseFormat: "json_object" },
  response: { content: '{"entities":[...]}' },
});
```

### Sequential responses (same match, different responses)

```typescript
// First call returns tool call, second returns text
mock.on(
  { userMessage: "status", sequenceIndex: 0 },
  { toolCalls: [{ name: "check_status", arguments: "{}" }] },
);
mock.on({ userMessage: "status", sequenceIndex: 1 }, { content: "All systems operational." });
```

Match counts are tracked per fixture group and reset with `reset()` or `resetMatchCounts()`.

### Streaming physics (realistic timing)

```typescript
mock.onMessage(
  "tell me a story",
  { content: "Once upon a time..." },
  {
    streamingProfile: {
      ttft: 200, // 200ms before first token
      tps: 30, // 30 tokens per second after that
      jitter: 0.1, // ±10% random variance
    },
  },
);
```

### Predicate-based routing (same user message, different context)

Common in supervisor/orchestrator patterns where the system prompt changes:

```typescript
mock.addFixture({
  match: {
    predicate: (req) => {
      const sys = req.messages.find((m) => m.role === "system")?.content ?? "";
      return typeof sys === "string" && sys.includes("Flights found: false");
    },
  },
  response: { toolCalls: [{ name: "search_flights", arguments: "{}" }] },
});
```

### Catch-all (always add one)

Prevents unmatched requests from returning 404 and crashing the test:

```typescript
mock.addFixture({
  match: { predicate: () => true },
  response: { content: "I understand. How can I help?" },
});
```

### Tool result catch-all with prependFixture

Must go at the front so it matches before substring-based fixtures:

```typescript
mock.prependFixture({
  match: { predicate: (req) => req.messages.at(-1)?.role === "tool" },
  response: { content: "Done!" },
});
```

### Stream interruption simulation (v1.3.0+)

```typescript
mock.onMessage(
  "long response",
  { content: "This will be cut short..." },
  {
    truncateAfterChunks: 3, // Stop after 3 SSE chunks
    disconnectAfterMs: 500, // Or disconnect after 500ms
  },
);
```

### Chaos testing (probabilistic failures)

```typescript
mock.addFixture({
  match: { userMessage: "flaky" },
  response: { content: "Sometimes works!" },
  chaos: { dropRate: 0.3 },
});
```

30% of requests matching this fixture will get a 500 error instead of the response. Can also use `malformedRate` (garbled JSON) or `disconnectRate` (connection dropped mid-stream).

Server-level chaos applies to ALL requests:

```typescript
mock.setChaos({ dropRate: 0.1 }); // 10% of all requests fail
mock.clearChaos(); // Remove server-level chaos
```

### Error injection (one-shot)

```typescript
mock.nextRequestError(429, { message: "Rate limited", type: "rate_limit_error" });
// Next request gets 429, then fixture auto-removes itself
```

### JSON fixture files

```json
{
  "fixtures": [
    {
      "match": { "userMessage": "hello" },
      "response": { "content": "Hi!" }
    },
    {
      "match": { "inputText": "search query" },
      "response": { "embedding": [0.1, 0.2, 0.3] }
    },
    {
      "match": { "userMessage": "status", "sequenceIndex": 0 },
      "response": { "content": "First response" }
    }
  ]
}
```

JSON files cannot use `RegExp` or `predicate` — those are code-only features. `streamingProfile` is supported in JSON fixture files.

Load with `mock.loadFixtureFile("./fixtures/greetings.json")` or `mock.loadFixtureDir("./fixtures/")`.

## API Endpoints

All providers share the same fixture pool — write fixtures once, they work for any endpoint.

| Endpoint                                                                                 | Provider      | Protocol  |
| ---------------------------------------------------------------------------------------- | ------------- | --------- |
| `POST /v1/chat/completions`                                                              | OpenAI        | HTTP      |
| `POST /v1/responses`                                                                     | OpenAI        | HTTP + WS |
| `POST /v1/messages`                                                                      | Anthropic     | HTTP      |
| `POST /v1/embeddings`                                                                    | OpenAI        | HTTP      |
| `POST /v1beta/models/{model}:{method}`                                                   | Google Gemini | HTTP      |
| `POST /model/{modelId}/invoke`                                                           | AWS Bedrock   | HTTP      |
| `POST /openai/deployments/{id}/chat/completions`                                         | Azure OpenAI  | HTTP      |
| `POST /openai/deployments/{id}/embeddings`                                               | Azure OpenAI  | HTTP      |
| `GET /health`                                                                            | —             | HTTP      |
| `GET /ready`                                                                             | —             | HTTP      |
| `POST /model/{modelId}/invoke-with-response-stream`                                      | AWS Bedrock   | HTTP      |
| `POST /model/{modelId}/converse`                                                         | AWS Bedrock   | HTTP      |
| `POST /model/{modelId}/converse-stream`                                                  | AWS Bedrock   | HTTP      |
| `POST /v1/projects/{p}/locations/{l}/publishers/google/models/{m}:generateContent`       | Vertex AI     | HTTP      |
| `POST /v1/projects/{p}/locations/{l}/publishers/google/models/{m}:streamGenerateContent` | Vertex AI     | HTTP      |
| `POST /api/chat`                                                                         | Ollama        | HTTP      |
| `POST /api/generate`                                                                     | Ollama        | HTTP      |
| `GET /api/tags`                                                                          | Ollama        | HTTP      |
| `POST /v2/chat`                                                                          | Cohere        | HTTP      |
| `GET /metrics`                                                                           | —             | HTTP      |
| `GET /v1/models`                                                                         | OpenAI-compat | HTTP      |
| `WS /v1/responses`                                                                       | OpenAI        | WebSocket |
| `WS /v1/realtime`                                                                        | OpenAI        | WebSocket |
| `WS /ws/google.ai...BidiGenerateContent`                                                 | Gemini Live   | WebSocket |

## Critical Gotchas

1. **Order matters** — first match wins. Specific fixtures before general ones. Use `prependFixture()` to force priority.

2. **`arguments` must be a JSON string** — `"arguments": "{\"key\":\"value\"}"` not `"arguments": {"key":"value"}`. The type system enforces this but JSON fixtures can get it wrong silently.

3. **Latency is per-chunk, not total** — `latency: 100` means 100ms between each SSE chunk, not 100ms total response time. Similarly, `truncateAfterChunks` and `disconnectAfterMs` are for simulating stream interruptions (added in v1.3.0).

4. **`streamingProfile` takes precedence over `latency`** — when both are set on a fixture, `streamingProfile` controls timing. Use one or the other.

5. **Tool result messages don't change the user message** — after a tool call, the client sends the same conversation + tool result. Matching on `userMessage` will hit the SAME fixture again → infinite loop. Always use `predicate` checking `role === "tool"` for tool results.

6. **`clearFixtures()` preserves the array reference** — uses `.length = 0`, not reassignment. The running server reads the same array object.

7. **Journal records everything** — including 404 "no match" responses. Use `mock.getLastRequest()` to debug mismatches.

8. **All providers share fixtures** — a fixture matching "hello" works whether the request comes via `/v1/chat/completions` (OpenAI), `/v1/messages` (Anthropic), Gemini, Bedrock, or Azure endpoints.

9. **WebSocket uses the same fixture pool** — no special setup needed for WebSocket-based APIs (OpenAI Responses WS, Realtime, Gemini Live).

10. **Embeddings auto-generate if no fixture matches** — deterministic vectors are generated from the input text hash. You don't need a catch-all for embedding requests.

11. **Sequential response counts are tracked per fixture** — counts reset with `reset()` or `resetMatchCounts()`. The count increments after each match of that fixture group (all fixtures sharing the same non-`sequenceIndex` match fields).

12. **Bedrock uses Anthropic Messages format internally** — the adapter normalizes Bedrock requests to `ChatCompletionRequest`, so the same fixtures work. Bedrock supports both non-streaming (`/invoke`, `/converse`) and streaming (`/invoke-with-response-stream`, `/converse-stream`) endpoints.

13. **Azure OpenAI routes through the same handlers** — `/openai/deployments/{id}/chat/completions` maps to the completions handler, `/openai/deployments/{id}/embeddings` maps to the embeddings handler. Fixtures work unchanged.

14. **Ollama defaults to streaming** — opposite of OpenAI. Set `stream: false` explicitly in the request for non-streaming responses.

15. **Ollama tool call `arguments` is an object, not a JSON string** — unlike OpenAI where `arguments` is a JSON string, Ollama sends and expects a plain object.

16. **Bedrock streaming uses binary Event Stream format** — not SSE. The `invoke-with-response-stream` and `converse-stream` endpoints use AWS Event Stream binary encoding.

17. **Vertex AI routes to the same handler as consumer Gemini** — the same fixtures work for both Vertex AI (`/v1/projects/.../models/{m}:generateContent`) and consumer Gemini (`/v1beta/models/{model}:generateContent`).

18. **Cohere requires `model` field** — returns 400 if `model` is missing from the request body.

## Mount & Composition

### mount() API

Mount additional mock services onto a running LLMock server. All services share one port, one health endpoint, and one request journal.

```typescript
const llm = new LLMock({ port: 5555 });
llm.mount("/mcp", mcpMock); // MCP tools at /mcp
llm.mount("/a2a", a2aMock); // A2A agents at /a2a
llm.mount("/vector", vectorMock); // Vector DB at /vector
await llm.start();
```

Any object implementing the `Mountable` interface (a `handleRequest` method that returns `boolean`) can be mounted. Path prefixes are stripped before the service sees the request — `/mcp/tools/list` arrives as `/tools/list`.

### createMockSuite()

Unified lifecycle for LLMock + mounted services:

```typescript
import { createMockSuite } from "@copilotkit/aimock";

const suite = createMockSuite({
  port: 0,
  fixtures: "./fixtures",
  services: { "/mcp": mcpMock, "/a2a": a2aMock },
});

await suite.start();
// suite.llm — the LLMock instance
// suite.url — base URL

afterEach(() => suite.reset()); // resets everything
afterAll(() => suite.stop());
```

### aimock CLI config file

The `aimock` CLI reads a JSON config and serves all services on one port:

```bash
aimock --config aimock.json --port 4010
```

Config format:

```json
{
  "llm": {
    "fixtures": "./fixtures",
    "latency": 0,
    "metrics": true
  },
  "services": {
    "/mcp": { "type": "mcp", "tools": "./mcp-tools.json" },
    "/a2a": { "type": "a2a", "agents": "./a2a-agents.json" }
  }
}
```

## VectorMock

Mock vector database server for testing RAG pipelines. Supports Pinecone, Qdrant, and ChromaDB API formats.

```typescript
import { VectorMock } from "@copilotkit/aimock";

const vector = new VectorMock();

// Create a collection and register query results
vector.addCollection("docs", { dimension: 1536 });
vector.onQuery("docs", [
  { id: "doc-1", score: 0.95, metadata: { title: "Getting Started" } },
  { id: "doc-2", score: 0.87, metadata: { title: "API Reference" } },
]);

// Upsert vectors
vector.upsert("docs", [
  { id: "v1", values: [0.1, 0.2, ...], metadata: { title: "Intro" } },
]);

// Dynamic query handler
vector.onQuery("docs", (query) => {
  return [{ id: "result", score: 1.0, metadata: { topK: query.topK } }];
});

// Standalone or mounted
const url = await vector.start();
// Or: llm.mount("/vector", vector);
```

### VectorMock endpoints

| Provider | Endpoints                                                                                                                                |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Pinecone | `POST /query`, `POST /vectors/upsert`, `POST /vectors/delete`, `GET /describe-index-stats`                                               |
| Qdrant   | `POST /collections/{name}/points/search`, `PUT /collections/{name}/points`, `POST /collections/{name}/points/delete`                     |
| ChromaDB | `POST /api/v1/collections/{id}/query`, `POST /api/v1/collections/{id}/add`, `GET /api/v1/collections`, `DELETE /api/v1/collections/{id}` |

## Service Mocks (Search / Rerank / Moderation)

Built-in mocks for common AI-adjacent services. Registered on the LLMock instance directly — no separate server needed.

### Search (Tavily-compatible)

```typescript
// POST /search — matches request `query` field
mock.onSearch("weather", [
  { title: "Weather Report", url: "https://example.com", content: "Sunny today" },
]);
mock.onSearch(/stock\s+price/i, [
  { title: "ACME Stock", url: "https://example.com", content: "$42", score: 0.95 },
]);
```

### Rerank (Cohere-compatible)

```typescript
// POST /v2/rerank — matches request `query` field
mock.onRerank("machine learning", [
  { index: 0, relevance_score: 0.99 },
  { index: 2, relevance_score: 0.85 },
]);
```

### Moderation (OpenAI-compatible)

```typescript
// POST /v1/moderations — matches request `input` field
mock.onModerate("violent", {
  flagged: true,
  categories: { violence: true, hate: false },
  category_scores: { violence: 0.95, hate: 0.01 },
});

// Catch-all — everything passes
mock.onModerate(/.*/, { flagged: false, categories: {} });
```

### Pattern matching

All three services use the same matching logic:

- **String patterns** — case-insensitive substring match
- **RegExp patterns** — full regex test
- **First match wins** — register specific patterns before catch-alls

## Debugging Fixture Mismatches

When a fixture doesn't match:

1. **Inspect what the server received**: `mock.getLastRequest()` → check `body.messages` array
2. **Check fixture order**: `mock.getFixtures()` returns fixtures in registration order
3. **For `userMessage`**: match is against the LAST `role: "user"` message only, substring match (not exact)
4. **Check the journal**: `mock.getRequests()` shows all requests including which fixture matched (or `null` for 404)

## E2E Test Setup Pattern

```typescript
import { LLMock } from "@copilotkit/aimock";

// Setup — port: 0 picks a random available port
const mock = new LLMock({ port: 0 });
mock.loadFixtureDir("./fixtures");
await mock.start();
process.env.OPENAI_BASE_URL = `${mock.url}/v1`;

// Per-test cleanup
afterEach(() => mock.reset()); // clears fixtures AND journal

// Teardown
afterAll(async () => await mock.stop());
```

### Static factory shorthand

```typescript
const mock = await LLMock.create({ port: 0 }); // creates + starts in one call
```

## API Quick Reference

| Method                                  | Purpose                                     |
| --------------------------------------- | ------------------------------------------- |
| `addFixture(f)`                         | Append fixture (last priority)              |
| `addFixtures(f[])`                      | Append multiple                             |
| `prependFixture(f)`                     | Insert at front (highest priority)          |
| `clearFixtures()`                       | Remove all fixtures                         |
| `getFixtures()`                         | Read current fixture list                   |
| `on(match, response, opts?)`            | Shorthand for `addFixture`                  |
| `onMessage(pattern, response, opts?)`   | Match by user message                       |
| `onEmbedding(pattern, response, opts?)` | Match by embedding input text               |
| `onJsonOutput(pattern, json, opts?)`    | Match by user message with `responseFormat` |
| `onToolCall(name, response, opts?)`     | Match by tool name in `tools[]`             |
| `onToolResult(id, response, opts?)`     | Match by `tool_call_id`                     |
| `nextRequestError(status, body?)`       | One-shot error, auto-removes                |
| `loadFixtureFile(path)`                 | Load JSON fixture file                      |
| `loadFixtureDir(path)`                  | Load all JSON files in directory            |
| `start()`                               | Start server, returns URL                   |
| `stop()`                                | Stop server                                 |
| `reset()`                               | Clear fixtures + journal + match counts     |
| `resetMatchCounts()`                    | Clear sequence match counts only            |
| `getRequests()`                         | All journal entries                         |
| `getLastRequest()`                      | Most recent journal entry                   |
| `clearRequests()`                       | Clear journal only                          |
| `setChaos(opts)`                        | Set server-level chaos rates                |
| `clearChaos()`                          | Remove server-level chaos                   |
| `onSearch(pattern, results)`            | Match search requests by query              |
| `onRerank(pattern, results)`            | Match rerank requests by query              |
| `onModerate(pattern, result)`           | Match moderation requests by input          |
| `mount(path, handler)`                  | Mount a Mountable (VectorMock, etc.)        |
| `url` / `baseUrl`                       | Server URL (throws if not started)          |
| `port`                                  | Server port number                          |

Sequential responses use `on()` with `sequenceIndex` in the match — there is no dedicated convenience method.

## Record-and-Replay (VCR Mode)

llmock supports a VCR-style record-and-replay workflow: unmatched requests are proxied to real provider APIs, and the responses are saved as standard llmock fixture files for deterministic replay.

### CLI usage

```bash
# Record mode: proxy unmatched requests to real OpenAI and Anthropic APIs
llmock --record \
  --provider-openai https://api.openai.com \
  --provider-anthropic https://api.anthropic.com \
  -f ./fixtures

# Strict mode: fail on unmatched requests (no proxying, no catch-all 404)
llmock --strict -f ./fixtures
```

- `--record` enables proxy-on-miss. Requires at least one `--provider-*` flag.
- `--strict` returns a 503 error when no fixture matches AND no proxy is configured (or the proxy attempt fails), instead of silently returning a 404. The proxy is still tried first when `--record` is set. Use this in CI to prevent unmatched requests from slipping through as silent 404s.
- Provider flags: `--provider-openai`, `--provider-anthropic`, `--provider-gemini`, `--provider-vertexai`, `--provider-bedrock`, `--provider-azure`, `--provider-ollama`, `--provider-cohere`.

### How it works

1. **Existing fixtures are served first** — the router checks all loaded fixtures before considering the proxy.
2. **Misses are proxied** — if no fixture matches and recording is enabled, the request is forwarded to the real provider API. Upstream URL path prefixes are preserved (e.g., `https://gateway.company.com/llm/v1` correctly proxies to `/llm/v1/chat/completions`).
3. **All request headers are forwarded (auth headers NOT saved)** — all client request headers are passed through to the upstream provider, except hop-by-hop headers and `host`/`content-length`/`cookie`/`accept-encoding`. Auth headers (`Authorization`, `x-api-key`, `api-key`) are forwarded but stripped from the recorded fixture.
4. **Responses are saved as standard fixtures** — recorded files land in `{fixturePath}/recorded/` and use the same JSON format as hand-written fixtures. Nothing special about them.
5. **Streaming responses are collapsed** — SSE streams are collapsed into a single text or tool-call response for the fixture. The original streaming format is preserved in the live proxy response.
6. **Base64 embedding decoding** — when the upstream returns base64-encoded embeddings (the default `encoding_format` in Python's openai SDK), the recorder decodes them into float arrays so fixtures contain readable numeric data instead of opaque base64 strings.
7. **Loud logging** — every proxy hit logs at `warn` level so you can see exactly which requests are being forwarded.

### Programmatic API

```typescript
const mock = new LLMock({ port: 0 });
await mock.start();

// Enable recording at runtime
mock.enableRecording({
  providers: {
    openai: "https://api.openai.com",
    anthropic: "https://api.anthropic.com",
  },
  fixturePath: "./fixtures/recorded",
});

// ... run tests that hit real APIs for uncovered cases ...

// Disable recording (back to fixture-only mode)
mock.disableRecording();
```

### Workflow

1. **Bootstrap**: Run your test suite with `--record` and provider URLs. All requests that don't match existing fixtures are proxied and recorded.
2. **Review**: Check the recorded fixtures in `{fixturePath}/recorded/`. Edit or reorganize as needed.
3. **Lock down**: Run your test suite with `--strict` to ensure every request hits a fixture. No network calls escape.
4. **Maintain**: When APIs change, delete stale fixtures and re-record.
