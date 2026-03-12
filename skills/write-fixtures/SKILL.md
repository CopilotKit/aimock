---
name: write-fixtures
description: Use when writing test fixtures for @copilotkit/llmock — mock LLM responses, tool call sequences, error injection, multi-turn agent loops, or debugging fixture mismatches
---

# Writing llmock Test Fixtures

## What llmock Is

Zero-dependency mock LLM server. Fixture-driven. Multi-provider (OpenAI, Anthropic, Gemini). Runs a real HTTP server on a real port — works across processes, unlike MSW-style interceptors. WebSocket support for OpenAI Responses/Realtime and Gemini Live APIs.

## Core Mental Model

- **Fixtures** = match criteria + response
- **First-match-wins** — order matters
- All providers share one fixture pool (provider adapters normalize to `ChatCompletionRequest`)
- Fixtures are stateless — no built-in multi-turn sequencing
- Fixtures are live — mutations after `start()` take effect immediately

## Match Field Reference

| Field         | Type                                      | Matches Against                                                           |
| ------------- | ----------------------------------------- | ------------------------------------------------------------------------- |
| `userMessage` | `string`                                  | Substring of last `role: "user"` message text                             |
| `userMessage` | `RegExp`                                  | Pattern test on last `role: "user"` message text                          |
| `toolName`    | `string`                                  | Exact match on any tool in request's `tools[]` array (by `function.name`) |
| `toolCallId`  | `string`                                  | Exact match on `tool_call_id` of last `role: "tool"` message              |
| `model`       | `string`                                  | Exact match on `req.model`                                                |
| `model`       | `RegExp`                                  | Pattern test on `req.model`                                               |
| `predicate`   | `(req: ChatCompletionRequest) => boolean` | Custom function — full access to request                                  |

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

### Error

```typescript
{ error: { message: "Rate limited", type: "rate_limit_error" }, status: 429 }
```

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
    }
  ]
}
```

JSON files cannot use `RegExp` or `predicate` — those are code-only features.

Load with `mock.loadFixtureFile("./fixtures/greetings.json")` or `mock.loadFixtureDir("./fixtures/")`.

## Critical Gotchas

1. **Order matters** — first match wins. Specific fixtures before general ones. Use `prependFixture()` to force priority.

2. **`arguments` must be a JSON string** — `"arguments": "{\"key\":\"value\"}"` not `"arguments": {"key":"value"}`. The type system enforces this but JSON fixtures can get it wrong silently.

3. **Latency is per-chunk, not total** — `latency: 100` means 100ms between each SSE chunk, not 100ms total response time. Similarly, `truncateAfterChunks` and `disconnectAfterMs` are for simulating stream interruptions (added in v1.3.0).

4. **Tool result messages don't change the user message** — after a tool call, the client sends the same conversation + tool result. Matching on `userMessage` will hit the SAME fixture again → infinite loop. Always use `predicate` checking `role === "tool"` for tool results.

5. **`clearFixtures()` preserves the array reference** — uses `.length = 0`, not reassignment. The running server reads the same array object.

6. **Journal records everything** — including 404 "no match" responses. Use `mock.getLastRequest()` to debug mismatches.

7. **All providers share fixtures** — a fixture matching "hello" works whether the request comes via `/v1/chat/completions` (OpenAI), `/v1/messages` (Anthropic), or Gemini endpoints.

8. **WebSocket uses the same fixture pool** — no special setup needed for WebSocket-based APIs (OpenAI Responses WS, Realtime, Gemini Live).

## Debugging Fixture Mismatches

When a fixture doesn't match:

1. **Inspect what the server received**: `mock.getLastRequest()` → check `body.messages` array
2. **Check fixture order**: `mock.getFixtures()` returns fixtures in registration order
3. **For `userMessage`**: match is against the LAST `role: "user"` message only, substring match (not exact)
4. **Check the journal**: `mock.getRequests()` shows all requests including which fixture matched (or `null` for 404)

## E2E Test Setup Pattern

```typescript
import { LLMock } from "@copilotkit/llmock";

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

| Method                                | Purpose                            |
| ------------------------------------- | ---------------------------------- |
| `addFixture(f)`                       | Append fixture (last priority)     |
| `addFixtures(f[])`                    | Append multiple                    |
| `prependFixture(f)`                   | Insert at front (highest priority) |
| `clearFixtures()`                     | Remove all fixtures                |
| `getFixtures()`                       | Read current fixture list          |
| `on(match, response, opts?)`          | Shorthand for `addFixture`         |
| `onMessage(pattern, response, opts?)` | Match by user message              |
| `onToolCall(name, response, opts?)`   | Match by tool name in `tools[]`    |
| `onToolResult(id, response, opts?)`   | Match by `tool_call_id`            |
| `nextRequestError(status, body?)`     | One-shot error, auto-removes       |
| `loadFixtureFile(path)`               | Load JSON fixture file             |
| `loadFixtureDir(path)`                | Load all JSON files in directory   |
| `start()`                             | Start server, returns URL          |
| `stop()`                              | Stop server                        |
| `reset()`                             | Clear fixtures + journal           |
| `getRequests()`                       | All journal entries                |
| `getLastRequest()`                    | Most recent journal entry          |
| `clearRequests()`                     | Clear journal only                 |
| `url` / `baseUrl`                     | Server URL (throws if not started) |
| `port`                                | Server port number                 |
