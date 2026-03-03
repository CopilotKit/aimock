# @copilotkit/mock-openai

Deterministic mock OpenAI server for testing. Streams SSE responses in real OpenAI chat completion format, driven entirely by fixtures. Zero runtime dependencies — built on Node.js builtins only.

## Install

```bash
npm install @copilotkit/mock-openai
```

## Quick Start

```typescript
import { MockOpenAI } from "@copilotkit/mock-openai";

const mock = new MockOpenAI();

mock.onMessage("hello", { content: "Hi there!" });

const url = await mock.start();
// Point your OpenAI client at `url` instead of https://api.openai.com

// ... run your tests ...

await mock.stop();
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

Shorthand — matches when the request contains a tool call with the given name.

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

Load fixtures from JSON files on disk. See [Fixture Files](#fixture-files) below.

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

Every request to `/v1/chat/completions` is recorded in a journal.

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

Streams as SSE chunks, splitting `content` by `chunkSize`.

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

## Fixture Files

Fixtures can be defined in JSON files for use with the CLI or `loadFixtureFile`/`loadFixtureDir`.

```json
{
  "fixtures": [
    {
      "match": { "userMessage": "hello" },
      "response": { "content": "Hello! How can I help you today?" }
    },
    {
      "match": { "toolName": "get_weather" },
      "response": {
        "toolCalls": [
          {
            "name": "get_weather",
            "arguments": "{\"location\":\"San Francisco\"}"
          }
        ]
      }
    }
  ]
}
```

Each entry can also include `latency` and `chunkSize` overrides.

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

### Custom Matching with Predicates

```typescript
mock.on(
  {
    predicate: (req) => req.messages.length > 5 && req.model.startsWith("gpt-4"),
  },
  { content: "You've been chatting a while!" },
);
```

### Per-Fixture Timing

```typescript
mock.on({ userMessage: "slow" }, { content: "Finally..." }, { latency: 200, chunkSize: 5 });
```

## License

MIT
