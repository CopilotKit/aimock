# @copilotkit/llmock [![Unit Tests](https://github.com/CopilotKit/llmock/actions/workflows/test-unit.yml/badge.svg)](https://github.com/CopilotKit/llmock/actions/workflows/test-unit.yml)

Deterministic multi-provider mock LLM server for testing. Streams SSE responses in real OpenAI, Claude, and Gemini API formats, driven entirely by fixtures. Zero runtime dependencies — built on Node.js builtins only.

Supports both streaming (SSE) and non-streaming JSON responses across OpenAI (Chat Completions + Responses), Anthropic Claude (Messages), and Google Gemini (GenerateContent) APIs. Text completions, tool calls, and error injection. Point any process at it via `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, or Gemini base URL and get reproducible, instant responses.

## Install

```bash
npm install @copilotkit/llmock
```

## When to Use This vs MSW

[MSW (Mock Service Worker)](https://mswjs.io/) is a popular API mocking library, but it solves a different problem.

**The key difference is architecture.** llmock runs a real HTTP server on a port. MSW patches `http`/`https`/`fetch` modules inside a single Node.js process. MSW can only intercept requests from the process that calls `server.listen()` — child processes, separate services, and workers are unaffected.

This matters for E2E tests where multiple processes make LLM API calls:

```
Playwright test runner (Node)
  └─ controls browser → Next.js app (separate process)
                            └─ OPENAI_BASE_URL → llmock :5555
                                ├─ Mastra agent workers
                                ├─ LangGraph workers
                                └─ CopilotKit runtime
```

MSW can't intercept any of those calls. llmock can — it's a real server on a real port.

**Use llmock when:**

- Multiple processes need to hit the same mock (E2E tests, agent frameworks, microservices)
- You want multi-provider SSE format out of the box (OpenAI, Claude, Gemini)
- You prefer defining fixtures as JSON files rather than code
- You need a standalone CLI server

**Use MSW when:**

- All API calls originate from a single Node.js process (unit tests, SDK client tests)
- You're mocking many different APIs, not just OpenAI
- You want in-process interception without running a server

| Capability                   | llmock                | MSW                                                                       |
| ---------------------------- | --------------------- | ------------------------------------------------------------------------- |
| Cross-process interception   | **Yes** (real server) | **No** (in-process only)                                                  |
| OpenAI Chat Completions SSE  | **Built-in**          | Manual — build `data: {json}\n\n` + `[DONE]` yourself                     |
| OpenAI Responses API SSE     | **Built-in**          | Manual — MSW's `sse()` sends `data:` events, not OpenAI's `event:` format |
| Claude Messages API SSE      | **Built-in**          | Manual — build `event:`/`data:` SSE yourself                              |
| Gemini streaming             | **Built-in**          | Manual — build `data:` SSE yourself                                       |
| WebSocket APIs               | **Built-in**          | **No**                                                                    |
| Fixture file loading (JSON)  | **Yes**               | **No** — handlers are code-only                                           |
| Request journal / inspection | **Yes**               | **No** — track requests manually                                          |
| Non-streaming responses      | **Yes**               | **Yes**                                                                   |
| Error injection (one-shot)   | **Yes**               | **Yes** (via `server.use()`)                                              |
| CLI for standalone use       | **Yes**               | **No**                                                                    |
| Zero dependencies            | **Yes**               | **No** (~300KB)                                                           |

## Quick Start

```typescript
import { LLMock } from "@copilotkit/llmock";

const mock = new LLMock({ port: 5555 });

mock.onMessage("hello", { content: "Hi there!" });

const url = await mock.start();
// Point your OpenAI client at `url` instead of https://api.openai.com

// ... run your tests ...

await mock.stop();
```

## E2E Test Patterns

Real-world patterns from using llmock in Playwright E2E tests with CopilotKit, Mastra, LangGraph, and Agno agent frameworks.

### Global Setup/Teardown

Start the mock server once for the entire test suite. All child processes (Next.js, agent workers) inherit the URL via environment variable.

```typescript
// e2e/llmock-setup.ts
import { LLMock } from "@copilotkit/llmock";
import * as path from "node:path";

let mockServer: LLMock | null = null;

export async function setupLLMock(): Promise<void> {
  mockServer = new LLMock({ port: 5555 });

  // Load JSON fixtures from a directory
  mockServer.loadFixtureDir(path.join(__dirname, "fixtures", "openai"));

  const url = await mockServer.start();

  // Child processes use this to find the mock
  process.env.LLMOCK_URL = `${url}/v1`;
}

export async function teardownLLMock(): Promise<void> {
  if (mockServer) {
    await mockServer.stop();
    mockServer = null;
  }
}
```

The Next.js app (or any other service) just needs:

```env
OPENAI_BASE_URL=http://localhost:5555/v1
OPENAI_API_KEY=mock-key

# Or for Anthropic Claude:
ANTHROPIC_BASE_URL=http://localhost:5555/v1

# Or for Google Gemini — point at the base URL:
# http://localhost:5555/v1beta
```

### JSON Fixture Files

Define fixtures as JSON — one file per feature, loaded with `loadFixtureFile` or `loadFixtureDir`.

**Text responses** — match on a substring of the last user message:

```json
{
  "fixtures": [
    {
      "match": { "userMessage": "stock price of AAPL" },
      "response": { "content": "The current stock price of Apple Inc. (AAPL) is $150.25." }
    },
    {
      "match": { "userMessage": "capital of France" },
      "response": { "content": "The capital of France is Paris." }
    }
  ]
}
```

**Tool call responses** — the agent framework receives these as tool calls and executes them:

```json
{
  "fixtures": [
    {
      "match": { "userMessage": "one step with eggs" },
      "response": {
        "toolCalls": [
          {
            "name": "generate_task_steps",
            "arguments": "{\"steps\":[{\"description\":\"Crack eggs into bowl\",\"status\":\"enabled\"},{\"description\":\"Preheat oven to 350F\",\"status\":\"enabled\"}]}"
          }
        ]
      }
    },
    {
      "match": { "userMessage": "background color to blue" },
      "response": {
        "toolCalls": [
          {
            "name": "change_background",
            "arguments": "{\"background\":\"blue\"}"
          }
        ]
      }
    }
  ]
}
```

### Fixture Load Order Matters

Fixtures are evaluated first-match-wins. When two fixtures could match the same message, load the more specific one first:

```typescript
// Load HITL fixtures first — "one step with eggs" is more specific than
// "plan to make brownies" which also appears in the HITL user message
mockServer.loadFixtureFile(path.join(FIXTURES_DIR, "human-in-the-loop.json"));

// Then load everything else — earlier matches take priority
mockServer.loadFixtureDir(FIXTURES_DIR);
```

### Predicate-Based Routing

When substring matching isn't enough — for example, when the last user message is the same across multiple requests but the system prompt differs — use predicates:

```typescript
// Supervisor agent: same user message every time, but system prompt
// contains state flags like "Flights found: false"
mockServer.addFixture({
  match: {
    predicate: (req) => {
      const sysMsg = req.messages.find((m) => m.role === "system");
      return sysMsg?.content?.includes("Flights found: false") ?? false;
    },
  },
  response: {
    toolCalls: [
      {
        name: "supervisor_response",
        arguments: '{"answer":"Let me find flights for you!","next_agent":"flights_agent"}',
      },
    ],
  },
});

mockServer.addFixture({
  match: {
    predicate: (req) => {
      const sys = req.messages.find((m) => m.role === "system")?.content ?? "";
      return sys.includes("Flights found: true") && sys.includes("Hotels found: false");
    },
  },
  response: {
    toolCalls: [
      {
        name: "supervisor_response",
        arguments: '{"answer":"Now let me find hotels.","next_agent":"hotels_agent"}',
      },
    ],
  },
});
```

### Tool Result Catch-All

After a tool executes, the next request contains a `role: "tool"` message with the result. Add a catch-all for these so the conversation can continue:

```typescript
const toolResultFixture = {
  match: {
    predicate: (req) => {
      const last = req.messages[req.messages.length - 1];
      return last?.role === "tool";
    },
  },
  response: { content: "Done! I've completed that for you." },
};
mockServer.addFixture(toolResultFixture);

// Move it to the front so it matches before substring-based fixtures
// (the last user message hasn't changed, so substring fixtures would
// match the same fixture again otherwise)
const fixtures = (mockServer as any).fixtures;
const idx = fixtures.indexOf(toolResultFixture);
if (idx > 0) {
  fixtures.splice(idx, 1);
  fixtures.unshift(toolResultFixture);
}
```

### Universal Catch-All

Append a catch-all last to handle any request that doesn't match a specific fixture, preventing 404s from crashing the test:

```typescript
mockServer.addFixture({
  match: { predicate: () => true },
  response: { content: "I understand. How can I help you with that?" },
});
```

## Programmatic API

### `new LLMock(options?)`

Create a new mock server instance.

| Option      | Type     | Default       | Description                         |
| ----------- | -------- | ------------- | ----------------------------------- |
| `port`      | `number` | `0` (random)  | Port to listen on                   |
| `host`      | `string` | `"127.0.0.1"` | Host to bind to                     |
| `latency`   | `number` | `0`           | Default ms delay between SSE chunks |
| `chunkSize` | `number` | `20`          | Default characters per SSE chunk    |

### `LLMock.create(options?)`

Static factory — creates an instance and starts it in one call. Returns `Promise<LLMock>`.

### Server Lifecycle

| Method    | Returns           | Description                            |
| --------- | ----------------- | -------------------------------------- |
| `start()` | `Promise<string>` | Start the server, returns the base URL |
| `stop()`  | `Promise<void>`   | Stop the server                        |
| `url`     | `string`          | Base URL (throws if not started)       |
| `baseUrl` | `string`          | Alias for `url`                        |
| `port`    | `number`          | Listening port (throws if not started) |

### Fixture Registration

All registration methods return `this` for chaining.

#### `on(match, response, opts?)`

Register a fixture with full control over match criteria.

```typescript
mock.on({ userMessage: /weather/i, model: "gpt-4" }, { content: "It's sunny!" }, { latency: 50 });
```

#### `onMessage(pattern, response, opts?)`

Shorthand — matches on the last user message.

```typescript
mock.onMessage("hello", { content: "Hi!" });
mock.onMessage(/greet/i, { content: "Hey there!" });
```

#### `onToolCall(name, response, opts?)`

Shorthand — matches when the request contains a tool with the given name.

```typescript
mock.onToolCall("get_weather", {
  toolCalls: [{ name: "get_weather", arguments: '{"location":"SF"}' }],
});
```

#### `onToolResult(id, response, opts?)`

Shorthand — matches when a tool result message has the given `tool_call_id`.

```typescript
mock.onToolResult("call_abc123", { content: "Temperature is 72F" });
```

#### `addFixture(fixture)` / `addFixtures(fixtures)`

Add raw `Fixture` objects directly (appended to the end of the list).

#### `prependFixture(fixture)`

Insert a fixture at the **front** of the list so it matches before all existing fixtures.
Useful for catch-all predicates that must fire before substring-based fixtures.

```typescript
mock.prependFixture({
  match: { predicate: (req) => req.messages.at(-1)?.role === "tool" },
  response: { content: "Done!" },
});
```

#### `getFixtures()`

Returns a `readonly Fixture[]` view of all registered fixtures. Useful for
debugging and logging fixture statistics without accessing private internals.

```typescript
const fixtures = mock.getFixtures();
console.log(`${fixtures.length} fixtures loaded`);
```

#### `loadFixtureFile(path)` / `loadFixtureDir(path)`

Load fixtures from JSON files on disk. See [Fixture Files](#json-fixture-files) above.

#### `clearFixtures()`

Remove all registered fixtures.

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

Every request to all API endpoints (`/v1/chat/completions`, `/v1/responses`, `/v1/messages`, and Gemini endpoints) is recorded in a journal.

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

| Option         | Short | Default      | Description                        |
| -------------- | ----- | ------------ | ---------------------------------- |
| `--port`       | `-p`  | `4010`       | Port to listen on                  |
| `--host`       | `-h`  | `127.0.0.1`  | Host to bind to                    |
| `--fixtures`   | `-f`  | `./fixtures` | Path to fixtures directory or file |
| `--latency`    | `-l`  | `0`          | Latency between SSE chunks (ms)    |
| `--chunk-size` | `-c`  | `20`         | Characters per SSE chunk           |
| `--help`       |       |              | Show help                          |

```bash
# Start with bundled example fixtures
llmock

# Custom fixtures on a specific port
llmock -p 8080 -f ./my-fixtures

# Simulate slow responses
llmock --latency 100 --chunk-size 5
```

## Advanced Usage

### Low-level Server

If you need the raw HTTP server without the `LLMock` wrapper:

```typescript
import { createServer } from "@copilotkit/llmock";

const fixtures = [{ match: { userMessage: "hi" }, response: { content: "Hello!" } }];

const { server, journal, url } = await createServer(fixtures, { port: 0 });
// ... use it ...
server.close();
```

### Per-Fixture Timing

```typescript
mock.on({ userMessage: "slow" }, { content: "Finally..." }, { latency: 200, chunkSize: 5 });
```

## Claude Code Integration

llmock ships with a [Claude Code](https://docs.anthropic.com/en/docs/claude-code) skill that teaches your AI assistant how to write fixtures correctly — match fields, response types, agent loop patterns, gotchas, and debugging techniques. Available as the `/write-fixtures` slash command.

### Option 1: Plugin install (recommended)

```bash
# Add the marketplace (one time)
/plugin marketplace add CopilotKit/llmock

# Install the plugin
/plugin install llmock@copilotkit-tools
```

The skill appears as `/llmock:write-fixtures`.

### Option 2: Local plugin from node_modules

```bash
claude --plugin-dir ./node_modules/@copilotkit/llmock
```

Same result, no marketplace needed. Good for trying it out.

### Option 3: Add directory

```bash
claude --add-dir ./node_modules/@copilotkit/llmock
```

The skill appears as `/write-fixtures` for the session.

### Option 4: Copy to your project

```bash
mkdir -p .claude/commands
cp node_modules/@copilotkit/llmock/.claude/commands/write-fixtures.md .claude/commands/
```

Permanently available as `/write-fixtures` in your project. Commit to share with your team.

## Future Direction

Areas where llmock could grow, and explicit non-goals for the current scope.

### WebSocket APIs

- **Audio and multimodal**: OpenAI Realtime API audio buffers, voice activity detection, and audio transcription are not implemented. Gemini Live audio/video input and output are similarly out of scope. Only text and tool call paths are supported over WebSocket.
- **Binary WebSocket frames**: Only text frames are processed; binary frames are silently ignored.
- **WebSocket compression**: `permessage-deflate` is not supported.
- **Session persistence**: Realtime and Gemini Live sessions exist only for the lifetime of a single WebSocket connection. There is no cross-connection session resumption.

### Fixtures

- **Request metadata in predicates**: Predicate functions receive only the `ChatCompletionRequest`, not HTTP headers, method, or URL.
- **Multi-turn conversation state**: Fixtures are stateless — there is no built-in way to sequence responses across multiple requests in a conversation.
- **Validation on load**: Fixture files are not schema-validated at load time; malformed fixtures surface as runtime errors.
- **Inheritance and aliasing**: No `$ref` or `extends` mechanism for fixture reuse across files.

### Testing

- **Live API conformance**: The `api-conformance` tests validate response format structure but do not run against real LLM APIs. A subset of tests that hit actual OpenAI/Anthropic/Gemini endpoints (gated behind API keys) would catch format drift as providers evolve their APIs.
- **Token counts**: Usage fields are always zero across all providers.
- **Vision/image content**: Image content parts are not handled by any provider.

### CLI

- **`--watch` mode**: No file-watching to auto-reload fixtures on change.
- **`--log-level`**: No configurable log verbosity.
- **`--validate-on-load`**: No flag to validate fixture schemas at startup.

## Real-World Usage

[CopilotKit](https://github.com/CopilotKit/CopilotKit) uses llmock across its test suite to verify AI agent behavior across multiple LLM providers without hitting real APIs. The tests cover streaming text, tool calls, and multi-turn conversations across both v1 and v2 runtimes.

See the [CopilotKit test suite](https://github.com/CopilotKit/CopilotKit/search?q=llmock&type=code) for real-world examples of llmock in action.

## License

MIT
