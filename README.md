# @copilotkit/llmock [![Unit Tests](https://github.com/CopilotKit/llmock/actions/workflows/test-unit.yml/badge.svg)](https://github.com/CopilotKit/llmock/actions/workflows/test-unit.yml) [![Drift Tests](https://github.com/CopilotKit/llmock/actions/workflows/test-drift.yml/badge.svg)](https://github.com/CopilotKit/llmock/actions/workflows/test-drift.yml) [![npm version](https://img.shields.io/npm/v/@copilotkit/llmock)](https://www.npmjs.com/package/@copilotkit/llmock)

Deterministic mock LLM server for testing. A real HTTP server on a real port — not an in-process interceptor — so every process in your stack (Playwright, Next.js, agent workers, microservices) can point at it via `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` and get reproducible, instant responses. Streams SSE in real OpenAI, Claude, Gemini, Bedrock, and Azure API formats, driven entirely by fixtures. Zero runtime dependencies.

## Quick Start

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

## Features

- **[Multi-provider support](https://llmock.copilotkit.dev/compatible-providers.html)** — [OpenAI Chat Completions](https://llmock.copilotkit.dev/chat-completions.html), [OpenAI Responses](https://llmock.copilotkit.dev/responses-api.html), [Anthropic Claude](https://llmock.copilotkit.dev/claude-messages.html), [Google Gemini](https://llmock.copilotkit.dev/gemini.html), [AWS Bedrock](https://llmock.copilotkit.dev/aws-bedrock.html), [Azure OpenAI](https://llmock.copilotkit.dev/azure-openai.html)
- **[Embeddings API](https://llmock.copilotkit.dev/embeddings.html)** — OpenAI-compatible embedding responses with configurable dimensions
- **[Structured output / JSON mode](https://llmock.copilotkit.dev/structured-output.html)** — `response_format`, `json_schema`, and function calling
- **[Sequential responses](https://llmock.copilotkit.dev/sequential-responses.html)** — Stateful multi-turn fixtures that return different responses on each call
- **[Streaming physics](https://llmock.copilotkit.dev/streaming-physics.html)** — Configurable `ttft`, `tps`, and `jitter` for realistic timing
- **[WebSocket APIs](https://llmock.copilotkit.dev/websocket.html)** — OpenAI Responses WS, Realtime API, and Gemini Live
- **[Error injection](https://llmock.copilotkit.dev/error-injection.html)** — One-shot errors, rate limiting, and provider-specific error formats
- **[Request journal](https://llmock.copilotkit.dev/docs.html)** — Record, inspect, and assert on every request
- **[Fixture validation](https://llmock.copilotkit.dev/fixtures.html)** — Schema validation at load time with `--validate-on-load`
- **CLI with hot-reload** — Standalone server with `--watch` for live fixture editing
- **[Docker + Helm](https://llmock.copilotkit.dev/docker.html)** — Container image and Helm chart for CI/CD pipelines
- **[Drift detection](https://llmock.copilotkit.dev/drift-detection.html)** — Daily CI runs against real APIs to catch response format changes
- **Claude Code integration** — `/write-fixtures` skill teaches your AI assistant how to write fixtures correctly

## CLI Quick Reference

```bash
llmock [options]
```

| Option               | Short | Default      | Description                               |
| -------------------- | ----- | ------------ | ----------------------------------------- |
| `--port`             | `-p`  | `4010`       | Port to listen on                         |
| `--host`             | `-h`  | `127.0.0.1`  | Host to bind to                           |
| `--fixtures`         | `-f`  | `./fixtures` | Path to fixtures directory or file        |
| `--latency`          | `-l`  | `0`          | Latency between SSE chunks (ms)           |
| `--chunk-size`       | `-c`  | `20`         | Characters per SSE chunk                  |
| `--watch`            | `-w`  |              | Watch fixture path for changes and reload |
| `--log-level`        |       | `info`       | Log verbosity: `silent`, `info`, `debug`  |
| `--validate-on-load` |       |              | Validate fixture schemas at startup       |
| `--help`             |       |              | Show help                                 |

```bash
# Start with bundled example fixtures
llmock

# Custom fixtures on a specific port
llmock -p 8080 -f ./my-fixtures

# Simulate slow responses
llmock --latency 100 --chunk-size 5
```

## Documentation

Full API reference, fixture format, E2E patterns, and provider-specific guides:

**[https://llmock.copilotkit.dev/docs.html](https://llmock.copilotkit.dev/docs.html)**

## Real-World Usage

[CopilotKit](https://github.com/CopilotKit/CopilotKit) uses llmock across its test suite to verify AI agent behavior across multiple LLM providers without hitting real APIs.

## License

MIT
