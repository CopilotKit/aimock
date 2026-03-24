# @copilotkit/llmock [![Unit Tests](https://github.com/CopilotKit/llmock/actions/workflows/test-unit.yml/badge.svg)](https://github.com/CopilotKit/llmock/actions/workflows/test-unit.yml) [![Drift Tests](https://github.com/CopilotKit/llmock/actions/workflows/test-drift.yml/badge.svg)](https://github.com/CopilotKit/llmock/actions/workflows/test-drift.yml) [![npm version](https://img.shields.io/npm/v/@copilotkit/llmock)](https://www.npmjs.com/package/@copilotkit/llmock)

Mock infrastructure for AI application testing — LLM APIs, MCP tools, A2A agents, vector databases, search, and more. Real HTTP server on a real port, fixture-driven, zero runtime dependencies.

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

## Usage Scenarios

### In-process testing

Use the programmatic API to start and stop the mock server in your test setup. Every test framework works — Vitest, Jest, Playwright, Mocha, anything.

```typescript
import { LLMock } from "@copilotkit/llmock";

const mock = new LLMock({ port: 5555 });
mock.loadFixtureDir("./fixtures");
const url = await mock.start();
process.env.OPENAI_BASE_URL = `${url}/v1`;

// ... run tests ...

await mock.stop();
```

### Running locally

Use the CLI with `--watch` to hot-reload fixtures as you edit them. Point your app at the mock and iterate without touching real APIs.

```bash
llmock -p 4010 -f ./fixtures --watch
```

### CI pipelines

Use the Docker image with `--strict` mode and record-and-replay for deterministic, zero-cost CI runs.

```yaml
# GitHub Actions example
- name: Start aimock
  run: |
    docker run -d --name aimock \
      -v ./fixtures:/fixtures \
      -p 4010:4010 \
      ghcr.io/copilotkit/aimock \
      llmock --strict -f /fixtures

- name: Run tests
  env:
    OPENAI_BASE_URL: http://localhost:4010/v1
  run: pnpm test

- name: Stop aimock
  run: docker stop aimock
```

### Cross-language testing

The Docker image runs as a standalone HTTP server — any language that speaks HTTP can use it. Python, Go, Rust, Ruby, Java, anything.

```bash
docker run -d -p 4010:4010 ghcr.io/copilotkit/aimock llmock -f /fixtures

# Python
client = openai.OpenAI(base_url="http://localhost:4010/v1", api_key="mock")

# Go
client := openai.NewClient(option.WithBaseURL("http://localhost:4010/v1"))

# Rust
let client = Client::new().with_base_url("http://localhost:4010/v1");
```

## Features

- **[Record-and-replay](https://llmock.copilotkit.dev/record-replay.html)** — VCR-style proxy records real API responses as fixtures for deterministic replay
- **[Multi-provider support](https://llmock.copilotkit.dev/compatible-providers.html)** — [OpenAI Chat Completions](https://llmock.copilotkit.dev/chat-completions.html), [Responses API](https://llmock.copilotkit.dev/responses-api.html), [Anthropic Claude](https://llmock.copilotkit.dev/claude-messages.html), [Google Gemini](https://llmock.copilotkit.dev/gemini.html), [AWS Bedrock](https://llmock.copilotkit.dev/aws-bedrock.html), [Azure OpenAI](https://llmock.copilotkit.dev/azure-openai.html), [Vertex AI](https://llmock.copilotkit.dev/vertex-ai.html), [Ollama](https://llmock.copilotkit.dev/ollama.html), [Cohere](https://llmock.copilotkit.dev/cohere.html)
- **[MCPMock](https://llmock.copilotkit.dev/mcp-mock.html)** — Mock MCP server with tools, resources, prompts, and session management
- **[A2AMock](https://llmock.copilotkit.dev/a2a-mock.html)** — Mock A2A protocol server with agent cards, message routing, and streaming
- **[VectorMock](https://llmock.copilotkit.dev/vector-mock.html)** — Mock vector database with Pinecone, Qdrant, and ChromaDB endpoints
- **[Services](https://llmock.copilotkit.dev/services.html)** — Built-in search (Tavily), rerank (Cohere), and moderation (OpenAI) mocks
- **[Chaos testing](https://llmock.copilotkit.dev/chaos-testing.html)** — Probabilistic failure injection: 500 errors, malformed JSON, mid-stream disconnects
- **[Prometheus metrics](https://llmock.copilotkit.dev/metrics.html)** — Request counts, latencies, and fixture match rates at `/metrics`
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

## aimock CLI (Full-Stack Mock)

For projects that need more than LLM mocking, the `aimock` CLI reads a JSON config file and serves all mock services on one port:

```bash
aimock --config aimock.json --port 4010
```

See the [aimock documentation](https://llmock.copilotkit.dev/aimock-cli.html) for config file format and Docker usage.

## CLI Quick Reference

```bash
llmock [options]
```

| Option               | Short | Default      | Description                                 |
| -------------------- | ----- | ------------ | ------------------------------------------- |
| `--config`           |       |              | Config file for aimock CLI                  |
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

## llmock vs MSW

[MSW (Mock Service Worker)](https://mswjs.io/) patches `http`/`https`/`fetch` inside a single Node.js process. llmock runs a real HTTP server on a real port that any process can reach — child processes, microservices, agent workers, Docker containers. MSW can't intercept any of those; llmock can. For a detailed comparison including other tools, see the [full comparison on the docs site](https://llmock.copilotkit.dev/#comparison).

| Capability                 | llmock                       | MSW                    |
| -------------------------- | ---------------------------- | ---------------------- |
| Cross-process interception | **Yes** (real server)        | No (in-process only)   |
| LLM SSE streaming          | **Built-in** (13+ providers) | Manual for each format |
| Fixture files (JSON)       | **Yes**                      | No (code-only)         |
| Record & replay            | **Yes**                      | No                     |
| WebSocket APIs             | **Yes**                      | No                     |
| Zero dependencies          | **Yes**                      | No (~300KB)            |

## Real-World Usage

[CopilotKit](https://github.com/CopilotKit/CopilotKit) uses llmock across its test suite to verify AI agent behavior across multiple LLM providers without hitting real APIs.

## License

MIT
