# aimock [![Unit Tests](https://github.com/CopilotKit/llmock/actions/workflows/test-unit.yml/badge.svg)](https://github.com/CopilotKit/llmock/actions/workflows/test-unit.yml) [![Drift Tests](https://github.com/CopilotKit/llmock/actions/workflows/test-drift.yml/badge.svg)](https://github.com/CopilotKit/llmock/actions/workflows/test-drift.yml) [![npm version](https://img.shields.io/npm/v/@copilotkit/aimock)](https://www.npmjs.com/package/@copilotkit/aimock)

Mock infrastructure for AI application testing — LLM APIs, MCP tools, A2A agents, vector databases, search, rerank, and moderation. One package, one port, zero dependencies.

## Quick Start

```bash
npm install @copilotkit/aimock
```

```typescript
import { LLMock } from "@copilotkit/aimock";

const mock = new LLMock({ port: 0 });
mock.onMessage("hello", { content: "Hi there!" });
await mock.start();

process.env.OPENAI_BASE_URL = `${mock.url}/v1`;

// ... run your tests ...

await mock.stop();
```

## The aimock Suite

aimock mocks everything your AI app talks to:

| Tool           | What it mocks                                                     | Docs                                                     |
| -------------- | ----------------------------------------------------------------- | -------------------------------------------------------- |
| **LLMock**     | OpenAI, Claude, Gemini, Bedrock, Azure, Vertex AI, Ollama, Cohere | [Providers](https://aimock.copilotkit.dev/docs.html)     |
| **MCPMock**    | MCP tools, resources, prompts with session management             | [MCP](https://aimock.copilotkit.dev/mcp-mock.html)       |
| **A2AMock**    | Agent-to-agent protocol with SSE streaming                        | [A2A](https://aimock.copilotkit.dev/a2a-mock.html)       |
| **VectorMock** | Pinecone, Qdrant, ChromaDB compatible endpoints                   | [Vector](https://aimock.copilotkit.dev/vector-mock.html) |
| **Services**   | Tavily search, Cohere rerank, OpenAI moderation                   | [Services](https://aimock.copilotkit.dev/services.html)  |

Run them all on one port with `npx aimock --config aimock.json`, or use the programmatic API to compose exactly what you need.

## Features

- **[Record & Replay](https://aimock.copilotkit.dev/record-replay.html)** — Proxy real APIs, save as fixtures, replay deterministically forever
- **[11 LLM Providers](https://aimock.copilotkit.dev/docs.html)** — OpenAI, Claude, Gemini, Bedrock, Azure, Vertex AI, Ollama, Cohere — full streaming support
- **[MCP / A2A / Vector](https://aimock.copilotkit.dev/mcp-mock.html)** — Mock every protocol your AI agents use
- **[Chaos Testing](https://aimock.copilotkit.dev/chaos-testing.html)** — 500 errors, malformed JSON, mid-stream disconnects at any probability
- **[Drift Detection](https://aimock.copilotkit.dev/drift-detection.html)** — Daily CI validation against real APIs
- **[Streaming Physics](https://aimock.copilotkit.dev/streaming-physics.html)** — Configurable `ttft`, `tps`, and `jitter`
- **[WebSocket APIs](https://aimock.copilotkit.dev/websocket.html)** — OpenAI Realtime, Responses WS, Gemini Live
- **[Prometheus Metrics](https://aimock.copilotkit.dev/metrics.html)** — Request counts, latencies, fixture match rates
- **[Docker + Helm](https://aimock.copilotkit.dev/docker.html)** — Container image and Helm chart for CI/CD
- **Zero dependencies** — Everything from Node.js builtins

## CLI

```bash
# LLM mocking only
npx aimock -p 4010 -f ./fixtures

# Full suite from config
npx aimock --config aimock.json

# Record mode: proxy to real APIs, save fixtures
npx aimock --record --provider-openai https://api.openai.com

# Docker
docker run -d -p 4010:4010 -v ./fixtures:/fixtures ghcr.io/copilotkit/aimock -f /fixtures
```

## Switching from other tools?

Step-by-step migration guides: [MSW](https://aimock.copilotkit.dev/migrate-from-msw.html) · [VidaiMock](https://aimock.copilotkit.dev/migrate-from-vidaimock.html) · [mock-llm](https://aimock.copilotkit.dev/migrate-from-mock-llm.html) · [Python mocks](https://aimock.copilotkit.dev/migrate-from-python-mocks.html) · [Mokksy](https://aimock.copilotkit.dev/migrate-from-mokksy.html)

## Documentation

**[https://aimock.copilotkit.dev](https://aimock.copilotkit.dev)**

## Real-World Usage

[AG-UI](https://github.com/ag-ui-protocol/ag-ui) uses aimock for its [end-to-end test suite](https://github.com/ag-ui-protocol/ag-ui/tree/main/apps/dojo/e2e), verifying AI agent behavior across LLM providers with [fixture-driven responses](https://github.com/ag-ui-protocol/ag-ui/tree/main/apps/dojo/e2e/fixtures/openai).

## License

MIT
