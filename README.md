# @copilotkit/llmock [![Unit Tests](https://github.com/CopilotKit/llmock/actions/workflows/test-unit.yml/badge.svg)](https://github.com/CopilotKit/llmock/actions/workflows/test-unit.yml) [![Drift Tests](https://github.com/CopilotKit/llmock/actions/workflows/test-drift.yml/badge.svg)](https://github.com/CopilotKit/llmock/actions/workflows/test-drift.yml) [![npm version](https://img.shields.io/npm/v/@copilotkit/llmock)](https://www.npmjs.com/package/@copilotkit/llmock)

https://github.com/user-attachments/assets/1aa9f81d-7efb-4bd2-8e81-51f466f8a8e3

Deterministic multi-provider mock LLM server for testing. Streams SSE and WebSocket responses in real OpenAI, Claude, and Gemini API formats, driven entirely by fixtures. Zero runtime dependencies — built on Node.js builtins only.

Supports streaming (SSE), non-streaming JSON, and WebSocket responses across OpenAI (Chat Completions + Responses + Realtime), Anthropic Claude (Messages), and Google Gemini (GenerateContent + Live) APIs. Text completions, tool calls, and error injection. Point any process at it via `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, or Gemini base URL and get reproducible, instant responses.

## Install

```bash
npm install @copilotkit/llmock
```

```typescript
import { LLMock } from "@copilotkit/llmock";

const mock = new LLMock({ port: 5555 });

mock.onMessage("hello", { content: "Hi there!" });

const url = await mock.start();
// Point your OpenAI client at `url` instead of https://api.openai.com

// ... run your tests ...

await mock.stop();
```

## Features

- **[Multi-provider support](https://llmock.copilotkit.dev/compatible-providers.html)** — [OpenAI Chat Completions](https://llmock.copilotkit.dev/chat-completions.html), [OpenAI Responses](https://llmock.copilotkit.dev/responses-api.html), [Anthropic Claude](https://llmock.copilotkit.dev/claude-messages.html), [Google Gemini](https://llmock.copilotkit.dev/gemini.html), [AWS Bedrock](https://llmock.copilotkit.dev/aws-bedrock.html) (streaming + Converse), [Azure OpenAI](https://llmock.copilotkit.dev/azure-openai.html), [Vertex AI](https://llmock.copilotkit.dev/vertex-ai.html), [Ollama](https://llmock.copilotkit.dev/ollama.html), [Cohere](https://llmock.copilotkit.dev/cohere.html)
- **[Embeddings API](https://llmock.copilotkit.dev/embeddings.html)** — OpenAI-compatible embedding responses with configurable dimensions
- **[Structured output / JSON mode](https://llmock.copilotkit.dev/structured-output.html)** — `response_format`, `json_schema`, and function calling
- **[Sequential responses](https://llmock.copilotkit.dev/sequential-responses.html)** — Stateful multi-turn fixtures that return different responses on each call
- **[Streaming physics](https://llmock.copilotkit.dev/streaming-physics.html)** — Configurable `ttft`, `tps`, and `jitter` for realistic timing
- **[WebSocket APIs](https://llmock.copilotkit.dev/websocket.html)** — OpenAI Responses WS, Realtime API, and Gemini Live
- **[Error injection](https://llmock.copilotkit.dev/error-injection.html)** — One-shot errors, rate limiting, and provider-specific error formats
- **[Chaos testing](https://llmock.copilotkit.dev/chaos-testing.html)** — Probabilistic failure injection: 500 errors, malformed JSON, mid-stream disconnects
- **[Prometheus metrics](https://llmock.copilotkit.dev/metrics.html)** — Request counts, latencies, and fixture match rates at `/metrics`
- **[Request journal](https://llmock.copilotkit.dev/docs.html)** — Record, inspect, and assert on every request
- **[Fixture validation](https://llmock.copilotkit.dev/fixtures.html)** — Schema validation at load time with `--validate-on-load`
- **CLI with hot-reload** — Standalone server with `--watch` for live fixture editing
- **[Docker + Helm](https://llmock.copilotkit.dev/docker.html)** — Container image and Helm chart for CI/CD pipelines
- **Record-and-replay** — VCR-style proxy-on-miss records real API responses as fixtures for deterministic replay
- **[Drift detection](https://llmock.copilotkit.dev/drift-detection.html)** — Daily CI runs against real APIs to catch response format changes
- **Claude Code integration** — `/write-fixtures` skill teaches your AI assistant how to write fixtures correctly

### Error Injection

#### `nextRequestError(status, errorBody?)`

Queue a one-shot error for the very next request. The error fires once, then auto-removes itself.

```typescript
mock.nextRequestError(429, {
  message: "Rate limited",
  type: "rate_limit_error",
});

// Next request → 429 error
// Subsequent requests → normal fixture matching
```

### Request Journal

Every request to all API endpoints (`/v1/chat/completions`, `/v1/responses`, `/v1/messages`, Gemini endpoints, and all WebSocket endpoints) is recorded in a journal.

#### Programmatic Access

| Method             | Returns                | Description                           |
| ------------------ | ---------------------- | ------------------------------------- |
| `getRequests()`    | `JournalEntry[]`       | All recorded requests                 |
| `getLastRequest()` | `JournalEntry \| null` | Most recent request                   |
| `clearRequests()`  | `void`                 | Clear the journal                     |
| `journal`          | `Journal`              | Direct access to the journal instance |

```typescript
await fetch(mock.url + "/v1/chat/completions", { ... });

const last = mock.getLastRequest();
expect(last?.body.messages).toContainEqual({
  role: "user",
  content: "hello",
});
```

#### HTTP Endpoints

The server also exposes journal data over HTTP (useful in CLI mode):

- `GET /v1/_requests` — returns all journal entries as JSON. Supports `?limit=N`.
- `DELETE /v1/_requests` — clears the journal. Returns 204.

### Reset

#### `reset()`

Clear all fixtures **and** the journal in one call. Works before or after the server is started.

```typescript
afterEach(() => {
  mock.reset();
});
```

## Fixture Matching

Fixtures are evaluated in registration order (first match wins). A fixture matches when **all** specified fields match the incoming request (AND logic).

| Field         | Type               | Matches on                                    |
| ------------- | ------------------ | --------------------------------------------- |
| `userMessage` | `string \| RegExp` | Content of the last `role: "user"` message    |
| `toolName`    | `string`           | Name of a tool in the request's `tools` array |
| `toolCallId`  | `string`           | `tool_call_id` on a `role: "tool"` message    |
| `model`       | `string \| RegExp` | The `model` field in the request              |
| `predicate`   | `(req) => boolean` | Arbitrary matching function                   |

## Fixture Responses

### Text

```typescript
{
  content: "Hello world";
}
```

Streams as SSE chunks, splitting `content` by `chunkSize`. With `stream: false`, returns a standard `chat.completion` JSON object.

### Tool Calls

```typescript
{
  toolCalls: [{ name: "get_weather", arguments: '{"location":"SF"}' }];
}
```

### Errors

```typescript
{
  error: { message: "Rate limited", type: "rate_limit_error" },
  status: 429
}
```

## API Endpoints

The server handles:

- **POST `/v1/chat/completions`** — OpenAI Chat Completions API (streaming and non-streaming)
- **POST `/v1/responses`** — OpenAI Responses API (streaming and non-streaming)
- **POST `/v1/messages`** — Anthropic Claude Messages API (streaming and non-streaming)
- **POST `/v1beta/models/{model}:generateContent`** — Google Gemini (non-streaming)
- **POST `/v1beta/models/{model}:streamGenerateContent`** — Google Gemini (streaming)

WebSocket endpoints:

- **WS `/v1/responses`** — OpenAI Responses API over WebSocket
- **WS `/v1/realtime`** — OpenAI Realtime API (text + tool calls)
- **WS `/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`** — Gemini Live

All endpoints share the same fixture pool — the same fixtures work across all providers. Requests are translated to a common format internally for fixture matching.

## WebSocket APIs

The same fixtures that drive HTTP responses also work over WebSocket transport. llmock implements RFC 6455 WebSocket framing with zero external dependencies — connect, send events, and receive streaming responses in real provider formats.

Only text and tool call paths are supported over WebSocket. Audio, video, and binary frames are not implemented.

### OpenAI Responses API (WebSocket)

Connect to `ws://localhost:5555/v1/responses` and send a `response.create` event. The server streams back the same events as OpenAI's real WebSocket Responses API:

```jsonc
// → Client sends:
{
  "type": "response.create",
  "response": {
    "modalities": ["text"],
    "instructions": "You are a helpful assistant.",
    "input": [
      { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "Hello" }] },
    ],
  },
}

// ← Server streams:
// {"type": "response.created", ...}
// {"type": "response.output_item.added", ...}
// {"type": "response.content_part.added", ...}
// {"type": "response.output_item.done", ...}
// {"type": "response.done", ...}
```

### OpenAI Realtime API

Connect to `ws://localhost:5555/v1/realtime`. The Realtime API uses a session-based protocol — configure the session, add conversation items, then request a response:

```jsonc
// → Configure session:
{ "type": "session.update", "session": { "modalities": ["text"], "model": "gpt-4o-realtime" } }

// → Add a user message:
{
  "type": "conversation.item.create",
  "item": {
    "type": "message",
    "role": "user",
    "content": [{ "type": "input_text", "text": "What is the capital of France?" }]
  }
}

// → Request a response:
{ "type": "response.create" }

// ← Server streams:
// {"type": "response.created", ...}
// {"type": "response.text.delta", "delta": "The"}
// {"type": "response.text.delta", "delta": " capital"}
// ...
// {"type": "response.text.done", ...}
// {"type": "response.done", ...}
```

### Gemini Live (BidiGenerateContent)

Connect to `ws://localhost:5555/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`. Gemini Live uses a setup/content/response flow:

```jsonc
// → Setup message (must be first):
{ "setup": { "model": "models/gemini-2.0-flash-live", "generationConfig": { "responseModalities": ["TEXT"] } } }

// → Send user content:
{ "clientContent": { "turns": [{ "role": "user", "parts": [{ "text": "Hello" }] }], "turnComplete": true } }

// ← Server streams:
// {"setupComplete": {}}
// {"serverContent": {"modelTurnComplete": false, "parts": [{"text": "Hello"}]}}
// {"serverContent": {"modelTurnComplete": true}}
```

## CLI

The package includes a standalone server binary:

```bash
llmock [options]
```

| Option               | Short | Default      | Description                                 |
| -------------------- | ----- | ------------ | ------------------------------------------- |
| `--port`             | `-p`  | `4010`       | Port to listen on                           |
| `--host`             | `-h`  | `127.0.0.1`  | Host to bind to                             |
| `--fixtures`         | `-f`  | `./fixtures` | Path to fixtures directory or file          |
| `--latency`          | `-l`  | `0`          | Latency between SSE chunks (ms)             |
| `--chunk-size`       | `-c`  | `20`         | Characters per SSE chunk                    |
| `--watch`            | `-w`  |              | Watch fixture path for changes and reload   |
| `--log-level`        |       | `info`       | Log verbosity: `silent`, `info`, `debug`    |
| `--validate-on-load` |       |              | Validate fixture schemas at startup         |
| `--chaos-drop`       |       | `0`          | Chaos: probability of 500 errors (0-1)      |
| `--chaos-malformed`  |       | `0`          | Chaos: probability of malformed JSON (0-1)  |
| `--chaos-disconnect` |       | `0`          | Chaos: probability of disconnect (0-1)      |
| `--metrics`          |       |              | Enable Prometheus metrics at /metrics       |
| `--record`           |       |              | Record mode: proxy unmatched to real APIs   |
| `--strict`           |       |              | Strict mode: fail on unmatched requests     |
| `--provider-*`       |       |              | Upstream URL per provider (with `--record`) |
| `--help`             |       |              | Show help                                   |

```bash
# Start with bundled example fixtures
llmock

# Custom fixtures on a specific port
llmock -p 8080 -f ./my-fixtures

# Simulate slow responses
llmock --latency 100 --chunk-size 5

# Record mode: proxy unmatched requests to real APIs and save as fixtures
llmock --record --provider-openai https://api.openai.com --provider-anthropic https://api.anthropic.com

# Strict mode in CI: fail if any request doesn't match a fixture
llmock --strict -f ./fixtures
```

## Documentation

Full API reference, fixture format, E2E patterns, and provider-specific guides:

**[https://llmock.copilotkit.dev/docs.html](https://llmock.copilotkit.dev/docs.html)**

## Real-World Usage

[CopilotKit](https://github.com/CopilotKit/CopilotKit) uses llmock across its test suite to verify AI agent behavior across multiple LLM providers without hitting real APIs.

## License

MIT
