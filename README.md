# aimock [![Unit Tests](https://github.com/CopilotKit/aimock/actions/workflows/test-unit.yml/badge.svg)](https://github.com/CopilotKit/aimock/actions/workflows/test-unit.yml) [![Drift Tests](https://github.com/CopilotKit/aimock/actions/workflows/test-drift.yml/badge.svg)](https://github.com/CopilotKit/aimock/actions/workflows/test-drift.yml) [![npm version](https://img.shields.io/npm/v/@copilotkit/aimock)](https://www.npmjs.com/package/@copilotkit/aimock)

https://github.com/user-attachments/assets/646bf106-0320-41f2-a9b1-5090454830f3

Mock infrastructure for AI application testing — LLM APIs, image generation, text-to-speech, transcription, video generation, MCP tools, A2A agents, AG-UI event streams, vector databases, search, rerank, and moderation. One package, one port, zero dependencies.

## Quick Start

```bash
npm install @copilotkit/aimock
```

```typescript
// The class is still named `LLMock` for back-compat after the v1.7.0 package
// rename from `@copilotkit/llmock` to `@copilotkit/aimock`.
import { LLMock } from "@copilotkit/aimock";

const mock = new LLMock({ port: 0 });
mock.onMessage("hello", { content: "Hi there!" });
await mock.start();

// Set env BEFORE importing/constructing the OpenAI (or other provider) client.
// Many SDKs cache the base URL at construction time — if the client is built
// before these are set, it will talk to the real API (surprise bills) instead
// of aimock.
process.env.OPENAI_BASE_URL = `${mock.url}/v1`;
process.env.OPENAI_API_KEY = "mock"; // SDK requires a value, even when base URL is mocked

// ... run your tests ...

await mock.stop();
```

## The aimock Suite

aimock mocks everything your AI app talks to:

| Tool           | What it mocks                                                                                           | Docs                                                |
| -------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| **LLMock**     | OpenAI (Chat/Responses/Realtime), Claude, Gemini (REST/Live), Bedrock, Azure, Vertex AI, Ollama, Cohere | [Providers](https://aimock.copilotkit.dev/docs)     |
| **MCPMock**    | MCP tools, resources, prompts with session management                                                   | [MCP](https://aimock.copilotkit.dev/mcp-mock)       |
| **A2AMock**    | Agent-to-agent protocol with SSE streaming                                                              | [A2A](https://aimock.copilotkit.dev/a2a-mock)       |
| **AGUIMock**   | AG-UI agent-to-UI event streams for frontend testing                                                    | [AG-UI](https://aimock.copilotkit.dev/agui-mock)    |
| **VectorMock** | Pinecone, Qdrant, ChromaDB compatible endpoints                                                         | [Vector](https://aimock.copilotkit.dev/vector-mock) |
| **Services**   | Tavily search, Cohere rerank, OpenAI moderation                                                         | [Services](https://aimock.copilotkit.dev/services)  |

Run them all on one port with `npx @copilotkit/aimock --config aimock.json`, or use the programmatic API to compose exactly what you need.

## Features

- **[Record & Replay](https://aimock.copilotkit.dev/record-replay)** — Proxy real APIs, save as fixtures, replay deterministically forever
- **[Multi-turn Conversations](https://aimock.copilotkit.dev/multi-turn)** — Record and replay multi-turn traces with tool rounds; match distinct turns via `toolCallId`, `sequenceIndex`, or custom predicates
- **[11 LLM Providers](https://aimock.copilotkit.dev/docs)** — OpenAI Chat, OpenAI Responses, OpenAI Realtime, Claude, Gemini, Gemini Live, Azure, Bedrock, Vertex AI, Ollama, Cohere — full streaming support
- **Multimedia APIs** — [image generation](https://aimock.copilotkit.dev/images) (DALL-E, Imagen), [text-to-speech](https://aimock.copilotkit.dev/speech), [audio transcription](https://aimock.copilotkit.dev/transcription), [video generation](https://aimock.copilotkit.dev/video)
- **[MCP](https://aimock.copilotkit.dev/mcp-mock) / [A2A](https://aimock.copilotkit.dev/a2a-mock) / [AG-UI](https://aimock.copilotkit.dev/agui-mock) / [Vector](https://aimock.copilotkit.dev/vector-mock)** — Mock every protocol your AI agents use
- **[Chaos Testing](https://aimock.copilotkit.dev/chaos-testing)** — 500 errors, malformed JSON, mid-stream disconnects at any probability
- **[Drift Detection](https://aimock.copilotkit.dev/drift-detection)** — Daily CI validation against real APIs
- **[Streaming Physics](https://aimock.copilotkit.dev/streaming-physics)** — Configurable `ttft`, `tps`, and `jitter`
- **[WebSocket APIs](https://aimock.copilotkit.dev/websocket)** — OpenAI Realtime, Responses WS, Gemini Live
- **[Prometheus Metrics](https://aimock.copilotkit.dev/metrics)** — Request counts, latencies, fixture match rates
- **[Docker + Helm](https://aimock.copilotkit.dev/docker)** — Container image and Helm chart for CI/CD
- **[Vitest & Jest Plugins](https://aimock.copilotkit.dev/test-plugins)** — Zero-config `useAimock()` with auto lifecycle and env patching
- **[Response Overrides](https://aimock.copilotkit.dev/fixtures)** — Control `id`, `model`, `usage`, `finishReason` in fixture responses
- **Zero dependencies** — Everything from Node.js builtins

## GitHub Action

```yaml
- uses: CopilotKit/aimock@v1
  with:
    fixtures: ./test/fixtures

- run: npm test
  env:
    OPENAI_BASE_URL: http://127.0.0.1:4010/v1
```

See the [GitHub Action docs](https://aimock.copilotkit.dev/github-action) for all inputs and examples.

## CLI

```bash
# LLM mocking only
npx -p @copilotkit/aimock llmock -p 4010 -f ./fixtures

# Full suite from config
npx @copilotkit/aimock --config aimock.json

# Record mode: proxy to real APIs, save fixtures
npx -p @copilotkit/aimock llmock --record --provider-openai https://api.openai.com

# Convert fixtures from other tools
npx @copilotkit/aimock convert vidaimock ./templates/ ./fixtures/
npx @copilotkit/aimock convert mockllm ./config.yaml ./fixtures/

# Docker
docker run -d -p 4010:4010 -v "$(pwd)/fixtures:/fixtures" ghcr.io/copilotkit/aimock -f /fixtures -h 0.0.0.0
```

> **Note on `llmock` vs `aimock` CLIs.** The `llmock` bin is retained as a compat alias for users of the pre-1.7.0 `@copilotkit/llmock` package. It runs a narrower flag-driven CLI without `--config` or the `convert` subcommand. New projects should use `aimock` (or `npx @copilotkit/aimock`) for full feature support.

## Framework Guides

Test your AI agents with aimock — no API keys, no network calls: [LangChain](https://aimock.copilotkit.dev/integrate-langchain) · [CrewAI](https://aimock.copilotkit.dev/integrate-crewai) · [PydanticAI](https://aimock.copilotkit.dev/integrate-pydanticai) · [LlamaIndex](https://aimock.copilotkit.dev/integrate-llamaindex) · [Mastra](https://aimock.copilotkit.dev/integrate-mastra) · [Google ADK](https://aimock.copilotkit.dev/integrate-adk) · [Microsoft Agent Framework](https://aimock.copilotkit.dev/integrate-maf)

## Switching from other tools?

Step-by-step migration guides: [MSW](https://aimock.copilotkit.dev/migrate-from-msw) · [VidaiMock](https://aimock.copilotkit.dev/migrate-from-vidaimock) · [mock-llm](https://aimock.copilotkit.dev/migrate-from-mock-llm) · [piyook/llm-mock](https://aimock.copilotkit.dev/migrate-from-piyook) · [Python mocks](https://aimock.copilotkit.dev/migrate-from-python-mocks) · [openai-responses](https://aimock.copilotkit.dev/migrate-from-openai-responses) · [Mokksy](https://aimock.copilotkit.dev/migrate-from-mokksy)

## Documentation

**[https://aimock.copilotkit.dev](https://aimock.copilotkit.dev)** · [Example fixtures](https://aimock.copilotkit.dev/examples)

## Real-World Usage

[AG-UI](https://github.com/ag-ui-protocol/ag-ui) uses aimock for its [end-to-end test suite](https://github.com/ag-ui-protocol/ag-ui/tree/main/apps/dojo/e2e), verifying AI agent behavior across LLM providers with [fixture-driven responses](https://github.com/ag-ui-protocol/ag-ui/tree/main/apps/dojo/e2e/fixtures/openai).

## License

MIT
