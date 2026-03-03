# @copilotkit/mock-openai [![Unit Tests](https://github.com/CopilotKit/mock-openai/actions/workflows/test-unit.yml/badge.svg)](https://github.com/CopilotKit/mock-openai/actions/workflows/test-unit.yml)

Deterministic mock OpenAI server for testing. Streams SSE responses in real OpenAI Chat Completions and Responses API format, driven entirely by fixtures. Zero runtime dependencies — built on Node.js builtins only.

Supports both streaming (SSE) and non-streaming JSON responses, text completions, tool calls, and error injection. Point any process at it via `OPENAI_BASE_URL` and get reproducible, instant responses.

## Install

```bash
npm install @copilotkit/mock-openai
```

## When to Use This vs MSW

[MSW (Mock Service Worker)](https://mswjs.io/) is a popular API mocking library, but it solves a different problem.

**The key difference is architecture.** mock-openai runs a real HTTP server on a port. MSW patches `http`/`https`/`fetch` modules inside a single Node.js process. MSW can only intercept requests from the process that calls `server.listen()` — child processes, separate services, and workers are unaffected.

This matters for E2E tests where multiple processes make OpenAI calls:

```
Playwright test runner (Node)
  └─ controls browser → Next.js app (separate process)
                            └─ OPENAI_BASE_URL → mock-openai :5555
                                ├─ Mastra agent workers
                                ├─ LangGraph workers
                                └─ CopilotKit runtime
```

MSW can't intercept any of those calls. mock-openai can — it's a real server on a real port.

**Use mock-openai when:**

- Multiple processes need to hit the same mock (E2E tests, agent frameworks, microservices)
- You want OpenAI-specific SSE format out of the box (Chat Completions + Responses API)
- You prefer defining fixtures as JSON files rather than code
- You need a standalone CLI server

**Use MSW when:**

- All API calls originate from a single Node.js process (unit tests, SDK client tests)
- You're mocking many different APIs, not just OpenAI
- You want in-process interception without running a server

| Capability                   | mock-openai           | MSW                                                                       |
| ---------------------------- | --------------------- | ------------------------------------------------------------------------- |
| Cross-process interception   | **Yes** (real server) | **No** (in-process only)                                                  |
| OpenAI Chat Completions SSE  | **Built-in**          | Manual — build `data: {json}\n\n` + `[DONE]` yourself                     |
| OpenAI Responses API SSE     | **Built-in**          | Manual — MSW's `sse()` sends `data:` events, not OpenAI's `event:` format |
| Fixture file loading (JSON)  | **Yes**               | **No** — handlers are code-only                                           |
| Request journal / inspection | **Yes**               | **No** — track requests manually                                          |
| Non-streaming responses      | **Yes**               | **Yes**                                                                   |
| Error injection (one-shot)   | **Yes**               | **Yes** (via `server.use()`)                                              |
| CLI for standalone use       | **Yes**               | **No**                                                                    |
| Zero dependencies            | **Yes**               | **No** (~300KB)                                                           |

## Quick Start

```typescript
import { MockOpenAI } from "@copilotkit/mock-openai";

const mock = new MockOpenAI({ port: 5555 });

mock.onMessage("hello", { content: "Hi there!" });

const url = await mock.start();
// Point your OpenAI client at `url` instead of https://api.openai.com

// ... run your tests ...

await mock.stop();
```

## E2E Test Patterns

Real-world patterns from using mock-openai in Playwright E2E tests with CopilotKit, Mastra, LangGraph, and Agno agent frameworks.

### Global Setup/Teardown

Start the mock server once for the entire test suite. All child processes (Next.js, agent workers) inherit the URL via environment variable.

```typescript
// e2e/mock-openai-setup.ts
import { MockOpenAI } from "@copilotkit/mock-openai";
import * as path from "node:path";

let mockServer: MockOpenAI | null = null;

export async function setupMockOpenAI(): Promise<void> {
  mockServer = new MockOpenAI({ port: 5555 });

  // Load JSON fixtures from a directory
  mockServer.loadFixtureDir(path.join(__dirname, "fixtures", "openai"));

  const url = await mockServer.start();

  // Child processes use this to find the mock
  process.env.MOCK_OPENAI_URL = `${url}/v1`;
}

export async function teardownMockOpenAI(): Promise<void> {
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

### `new MockOpenAI(options?)`

Create a new mock server instance.

| Option      | Type     | Default       | Description                         |
| ----------- | -------- | ------------- | ----------------------------------- |
| `port`      | `number` | `0` (random)  | Port to listen on                   |
| `host`      | `string` | `"127.0.0.1"` | Host to bind to                     |
| `latency`   | `number` | `0`           | Default ms delay between SSE chunks |
| `chunkSize` | `number` | `20`          | Default characters per SSE chunk    |

### `MockOpenAI.create(options?)`

Static factory — creates an instance and starts it in one call. Returns `Promise<MockOpenAI>`.

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

Add raw `Fixture` objects directly.

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

Every request to `/v1/chat/completions` and `/v1/responses` is recorded in a journal.

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
- **POST `/v1/responses`** — OpenAI Responses API (streaming and non-streaming). Requests are translated to the Chat Completions fixture format internally, so the same fixtures work for both endpoints.

## CLI

The package includes a standalone server binary:

```bash
mock-openai [options]
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
mock-openai

# Custom fixtures on a specific port
mock-openai -p 8080 -f ./my-fixtures

# Simulate slow responses
mock-openai --latency 100 --chunk-size 5
```

## Advanced Usage

### Low-level Server

If you need the raw HTTP server without the `MockOpenAI` wrapper:

```typescript
import { createServer } from "@copilotkit/mock-openai";

const fixtures = [{ match: { userMessage: "hi" }, response: { content: "Hello!" } }];

const { server, journal, url } = await createServer(fixtures, { port: 0 });
// ... use it ...
server.close();
```

### Per-Fixture Timing

```typescript
mock.on({ userMessage: "slow" }, { content: "Finally..." }, { latency: 200, chunkSize: 5 });
```

## License

MIT
