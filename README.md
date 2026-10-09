<div align="center">

# aimock

**Mock infrastructure for AI application testing — point your SDK at one local port and every provider, protocol, and service answers deterministically.**

[**Quick start**](#quick-start) · [**The suite**](#the-aimock-suite) · [**Record & replay**](https://aimock.copilotkit.dev/record-replay) · [**Docs**](https://aimock.copilotkit.dev/docs)

[![npm](https://img.shields.io/npm/v/@copilotkit/aimock.svg?label=%40copilotkit%2Faimock)](https://www.npmjs.com/package/@copilotkit/aimock)
[![Unit Tests](https://github.com/CopilotKit/aimock/actions/workflows/test-unit.yml/badge.svg)](https://github.com/CopilotKit/aimock/actions/workflows/test-unit.yml)
[![Drift Tests](https://github.com/CopilotKit/aimock/actions/workflows/test-drift.yml/badge.svg)](https://github.com/CopilotKit/aimock/actions/workflows/test-drift.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

</div>

https://github.com/user-attachments/assets/76815122-574a-48e1-b275-edae0a014667

<div align="center">

One package, one port, zero dependencies. LLM APIs, image generation and
editing, text-to-speech, transcription, audio translation and generation, video
generation, embeddings, MCP tools, A2A agents, AG-UI event streams, vector
databases, search, rerank, and moderation — no keys, no network, no surprise
bills.

</div>

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

| Tool           | What it mocks                                                                                                                                                                                                                                                                                                  | Docs                                                |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| **LLMock**     | OpenAI (Chat/Responses/Realtime GA/GPT-Live), Claude, Gemini (REST/Live/Interactions/Embeddings), Bedrock, Azure, Vertex AI, Ollama (chat/embeddings), Cohere (chat/embed), OpenRouter (chat/router/video), BytePlus Ark (chat/images/video), Grok (video), Veo (video), fal.ai, ElevenLabs (TTS/Voice Design) | [Providers](https://aimock.copilotkit.dev/docs)     |
| **MCPMock**    | MCP tools, resources, prompts with session management                                                                                                                                                                                                                                                          | [MCP](https://aimock.copilotkit.dev/mcp-mock)       |
| **A2AMock**    | Agent-to-agent protocol with SSE streaming                                                                                                                                                                                                                                                                     | [A2A](https://aimock.copilotkit.dev/a2a-mock)       |
| **AGUIMock**   | AG-UI agent-to-UI event streams for frontend testing                                                                                                                                                                                                                                                           | [AG-UI](https://aimock.copilotkit.dev/agui-mock)    |
| **VectorMock** | Pinecone, Qdrant, ChromaDB compatible endpoints                                                                                                                                                                                                                                                                | [Vector](https://aimock.copilotkit.dev/vector-mock) |
| **Services**   | Tavily search, Cohere rerank, OpenAI moderation                                                                                                                                                                                                                                                                | [Services](https://aimock.copilotkit.dev/services)  |

Run them all on one port with `npx @copilotkit/aimock --config aimock.json`, or use the programmatic API to compose exactly what you need.

## Features

- **[Record & Replay](https://aimock.copilotkit.dev/record-replay)** — Proxy real APIs, save as fixtures, replay deterministically forever
- **Timing-aware recording and replay** — Recorded fixtures capture per-frame arrival timestamps; replay uses recorded timings for approximate timing reproduction based on recorded TTFT and inter-frame cadence (replay chunk count may differ from recording — TTFT and average pace are preserved, not per-token fidelity) with configurable `--replay-speed` multiplier
- **[Recorded token usage and cost](https://aimock.copilotkit.dev/record-replay)** — Recording captures the final usage frame of a streaming completion, so replayed fixtures serve real `prompt_tokens` / `completion_tokens` instead of a length estimate; OpenRouter's provider-reported `usage.cost` and its `cost_details` / `*_tokens_details` breakdowns are captured too, so an app that bills from real provider cost can e2e-test its wallet path from a tape
- **[Multi-turn Conversations](https://aimock.copilotkit.dev/multi-turn)** — Record and replay multi-turn traces with tool rounds; match distinct turns via `turnIndex`, `hasToolResult`, `toolCallId`, `toolResultContains` (gate on the tool-result payload), `sequenceIndex`, `systemMessage` (gate on host-supplied agent context), or custom predicates
- **[11 providers across 22 API surfaces](https://aimock.copilotkit.dev/docs)** — OpenAI Chat, OpenAI Responses, OpenAI Realtime (GA; an `OpenAI-Beta: realtime=v1` request gets the real sunset rejection), GPT-Live, Claude, Gemini REST, Gemini embedContent, Gemini Live, Gemini Interactions, Azure, Bedrock, Vertex AI, Ollama (chat + embeddings), Cohere (chat + embed), OpenRouter (chat + router failover), BytePlus Ark (OpenAI-compatible chat + images under `/api/v3`), ElevenLabs TTS and Voice Design — full streaming support
- **Multimedia APIs** — [image generation](https://aimock.copilotkit.dev/images) (`gpt-image-1` default, Imagen; `/v1/images/variations` replays OpenAI's removal 404), [image editing](https://aimock.copilotkit.dev/images) (/v1/images/edits), [text-to-speech](https://aimock.copilotkit.dev/speech) (OpenAI + ElevenLabs TTS and Voice Design), [audio transcription](https://aimock.copilotkit.dev/transcription), [audio translation](https://aimock.copilotkit.dev/transcription) (/v1/audio/translations), [video generation](https://aimock.copilotkit.dev/video), [OpenRouter video generation](https://aimock.copilotkit.dev/openrouter-video) (/api/v1/videos with async job lifecycle), [Google Veo video generation](https://aimock.copilotkit.dev/veo-video) (:predictLongRunning + /v1beta/operations async lifecycle), [Grok Imagine video generation](https://aimock.copilotkit.dev/grok-video) (/v1/videos/generations with async job lifecycle), [BytePlus Ark video generation](https://aimock.copilotkit.dev/byteplus-video) (Seedance, /api/v3/contents/generations/tasks with async task lifecycle), [fal.ai](https://aimock.copilotkit.dev/fal-ai) (image / video / audio with queue lifecycle)
- **OpenAI platform APIs** — [Files](https://aimock.copilotkit.dev/files) (byte-exact uploads, purpose validation), [Vector Stores](https://aimock.copilotkit.dev/vector-stores) (CRUD, file attach with deterministic poll progression, file batches, deterministic direct search; hosted `file_search` execution is not supported), [fine-tuning jobs](https://aimock.copilotkit.dev/fine-tuning) (deterministic lifecycle, events, cursor pages) and Batches (`/v1/batches` create/list/retrieve/cancel with deterministic poll progression and real output files)
- **[MCP](https://aimock.copilotkit.dev/mcp-mock) / [A2A](https://aimock.copilotkit.dev/a2a-mock) / [AG-UI](https://aimock.copilotkit.dev/agui-mock) / [Vector](https://aimock.copilotkit.dev/vector-mock)** — Mock every protocol your AI agents use
- **[MCP Scenario Fakes](https://aimock.copilotkit.dev/mcp-mock#scenario-fakes)** — An `mcpFakes` block in a fixture file scripts each test's MCP tool answers next to its LLM turns: ordered answers, exact or any-argument matching, scripted tool errors, and a closed-world mode that fails on any undeclared tool. Works with any MCP client over Streamable HTTP
- **[MCP Recording](https://aimock.copilotkit.dev/record-replay#mcp-recording)** — Record a live MCP server into `mcpFakes` files (`--mcp-record /mcp=<url>`, or `llm.record.mcp` in a config) and replay them offline, with the recorded tool list, progress notifications and timing; known secrets are redacted before anything is written
- **[MCP Fake Reports](https://aimock.copilotkit.dev/mcp-mock#fakes-report)** — `GET /__aimock/mcp/fakes/report` lists each test's served, unused and failed fakes; with `useAimock({ fakesReport: "fail" })` a swallowed fake error or an unused fake fails the test, and `fakesFor()` gives the MCP URL and headers for the current test. Works for agents, workflows and pipelines alike
- **[Chaos Testing](https://aimock.copilotkit.dev/chaos-testing)** — 500 errors, malformed JSON, mid-stream disconnects and 429 rate limits (`--chaos-ratelimit`, with `Retry-After`) at any probability, plus a fixed pre-handling delay (`--chaos-latency <ms>`); read, set and clear the rates at runtime via `GET` / `POST` / `DELETE /__aimock/chaos`, scoped to the caller's `X-Test-Id` so one test cannot destabilise the suite running beside it
- **[Model Misbehavior](https://aimock.copilotkit.dev/model-misbehavior)** — Test invalid tool arguments, schema violations, unknown tools, duplicate IDs, length stops, empty responses, refusals, content filtering, and reasoning-only responses. Supported wires include OpenAI Chat, Responses, Realtime GA, Anthropic, Bedrock InvokeModel and Converse, Gemini generateContent (including the Vertex wrapper), Gemini Live, Gemini Interactions, Cohere, and Ollama chat. Fault and mode support varies by wire. Azure and OpenRouter use the Chat wire. Seeded rates, per-test limits, and journal evidence apply across supported wires. See the reference for the support matrix, SDK behavior, and modeled contracts whose native occurrence remains unverified.
- **Request journal** — `GET /__aimock/journal` returns every recorded request, filterable by `path`, `method`, `status`, `service`, `testId` and `requestId` with `limit` / `offset` paging and an `X-Total-Count` header carrying the pre-pagination total
- **HTTP route catalog** — `GET /__aimock/openapi.json` returns OpenAPI 3.1; `GET /__aimock/routes` returns `{ count, routes }`. For programmatic inspection, import `buildOpenApiDocument`, `CATALOG_ROUTES` and `ROUTE_DEFINITIONS` (with `CatalogRoute`/`RouteDefinition` types) from `@copilotkit/aimock`. The catalog describes HTTP operations; streaming responses include media and framing metadata, not a complete-stream JSON body.
- **Request IDs** — every response carries `X-Request-Id`, echoing the caller's header or minting one; the journal stores it on each entry and `GET /__aimock/journal?requestId=<id>` returns that request. A minted id is never forwarded upstream in record/proxy mode
- **Per-Request Strict Mode** — `X-AIMock-Strict` header overrides the server-level `--strict` flag per request (`true`/`1` = strict, `false`/`0` = lenient)
- **Context-Based Fixture Routing** — `X-AIMock-Context` header scopes fixtures per integration; fixtures with `match.context` only match requests carrying that context, fixtures without it remain shared
- **[Drift Detection](https://aimock.copilotkit.dev/drift-detection)** — Daily CI validation against real APIs
- **[Streaming Physics](https://aimock.copilotkit.dev/streaming-physics)** — Configurable `ttft`, `tps`, and `jitter`
- **[WebSocket APIs](https://aimock.copilotkit.dev/websocket)** — OpenAI Realtime (GA protocol with models: gpt-realtime, gpt-realtime-2, gpt-realtime-1.5, gpt-realtime-mini; transcription/translation via gpt-4o-transcribe, gpt-4o-mini-transcribe, whisper-1; image input; commentary phase), Responses WS, Gemini Live
- **[GPT-Live](https://aimock.copilotkit.dev/websocket#openai-live)** — Mock, record, and replay primary WebSocket sessions at `/v1/live/sessions` in client and managed modes, with fixture-backed audio and backend tool continuation. Saved fixtures replay offline; aimock does not synthesize speech. This voice surface is separate from OpenAI text-model family support; WebRTC/SDP and sideband connections are outside this scope.
- **[Prometheus Metrics](https://aimock.copilotkit.dev/metrics)** — Request counts, latencies, fixture match rates
- **[Docker + Helm](https://aimock.copilotkit.dev/docker)** — Container image and Helm chart for CI/CD
- **[Vitest & Jest Plugins](https://aimock.copilotkit.dev/test-plugins)** — Zero-config `useAimock()` with auto lifecycle and env patching
- **[Response Overrides](https://aimock.copilotkit.dev/fixtures)** — Control `id`, `model`, `usage`, `finishReason` in fixture responses
- **[Ordered Blocks](https://aimock.copilotkit.dev/fixtures#ordered-blocks)** — A `blocks` array streams text and tool calls in any order (tool-first or interleaved); blocks-only fixtures are first-class, and the recorder captures order from genuinely tool-first/interleaved streams
- **[Streaming Usage Chunks](https://aimock.copilotkit.dev/streaming-physics)** — `stream_options.include_usage` support emits a final chunk with token counts, matching OpenAI's streaming usage protocol
- **[Rate Limiting Headers](https://aimock.copilotkit.dev/chaos-testing)** — `x-ratelimit-*` headers on every response and `Retry-After` on 429 errors for testing retry/backoff logic
- **Zero dependencies** — Everything from Node.js builtins

Model misbehavior requires a build that includes this Unreleased feature. Older versions silently ignore the fixture's `misbehavior` field and serve its original response. Invalid configurations now fail during fixture loading or programmatic addition. See the [model misbehavior reference](https://aimock.copilotkit.dev/model-misbehavior) for supported parameters and compatibility details.

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

# Remote fixtures — load JSON from an HTTPS URL (repeatable)
npx -p @copilotkit/aimock llmock -p 4010 \
  -f https://raw.githubusercontent.com/acme/mocks/main/openai.json \
  -f ./fixtures/local-overrides.json

# Full suite from config
npx @copilotkit/aimock --config aimock.json

# Record mode: proxy to real APIs, save fixtures
npx -p @copilotkit/aimock llmock --record --provider-openai https://api.openai.com

# Record with extended timeout for reasoning models
npx -p @copilotkit/aimock llmock --record --provider-openai https://api.openai.com \
  --body-timeout-ms 180000

# Replay recorded fixtures at 2× speed
npx -p @copilotkit/aimock llmock -p 4010 -f ./fixtures --replay-speed 2

# Convert fixtures from other tools
npx @copilotkit/aimock convert vidaimock ./templates/ ./fixtures/vidaimock.json
npx @copilotkit/aimock convert mockllm ./config.yaml ./fixtures/mockllm.json

# Validate fixtures offline (file or directory, recursive)
npx @copilotkit/aimock validate ./fixtures/
# --strict on the whole shipped tree exits 1 (adk/mastra repeat a userMessage across files)
npx @copilotkit/aimock validate --strict --json ./fixtures/examples/llm/blocks-tool-first.json

# Docker
docker run -d -p 4010:4010 -v "$(pwd)/fixtures:/fixtures" ghcr.io/copilotkit/aimock -f /fixtures -h 0.0.0.0
```

> **Note on `llmock` vs `aimock` CLIs.** The `llmock` bin is retained as a compat alias for users of the pre-1.7.0 `@copilotkit/llmock` package. It runs a narrower flag-driven CLI without `--config` or the `convert` and `validate` subcommands. New projects should use `aimock` (or `npx @copilotkit/aimock`) for full feature support.

### Offline fixture validation

`aimock validate [--strict] [--json] [--] <path> [more paths ...]` lints fixtures without starting a server. Each path is a fixture file or a directory of them (walked recursively for `*.json`, like `--fixtures <dir>`). `--strict` treats warnings as errors; `--json` emits a machine-readable report for CI; `--` stops option parsing so a path beginning with `-` is still reachable. A path given twice is validated twice, because the server loads one set of fixtures per `--fixtures` it is given; the duplicate fixtures that produces are reported as the server reports them, one finding per fixture and rule. Such a path is printed as `<path>[<n>]`, numbering its mentions from 1, so each load — and every cross-file reference to its fixtures — names one of them. `--json` carries that number as `mention` on every file, whether or not the path repeats.

Files are checked one at a time and then again as one combined set in load order, so the rules that span files — a `userMessage` duplicated across two files, an empty catch-all `match` that is last in its own file but not last overall — fire here as they do on the server. Cross-file findings are prefixed `cross-file:`, attributed to the file owning the fixture, and name the other file. One the per-file pass already made against the same fixture never prints a second line: naming the same fixtures it is dropped, and naming others — a shadow that reaches into another load — it replaces the per-file wording in place, at the same position.

Against the server's `--validate-on-load` it is stricter in one direction and weaker in another. **Stricter:** there an unreadable, unparseable, or wrong-shape file only warns on stderr and contributes zero fixtures, and startup continues as long as the run loaded at least one fixture from somewhere, whereas `validate` fails the run on every such file. The one exception, which matches the loader: a `*.json` file found by **walking** a directory and having no top-level `"fixtures"` key at all is not a fixture file (an aimock config, say), so it is passed over with a `skipped (...)` line instead of failing the run — a file you name on the command line is still validated, and still fails on the wrong shape. Two walk hazards the server does not survive are refused outright rather than mirrored: a `*.json` path that is not a regular file (a FIFO, a socket, a device) is a per-file error here, where the server's `readFileSync` blocks on it forever; and a directory symlink pointing back at a directory already being walked is reported once as a cycle, where the server recurses through it until the kernel returns `ELOOP` and loads those levels' fixtures over and over. **Equal:** the fixture rules themselves, and the zero-fixture rule — a run whose inputs yield no fixtures at all is an error, matching the server's startup abort, while a single `{"fixtures": []}` file alongside files that do load fixtures is fine in both. Equal too in what the inputs expand to: a path named twice, and a directory reached both directly and through an acyclic symlink to it, are validated once per mention, exactly as the server loads one `--fixtures` source per mention, and each fixture-and-rule pair is reported once — the count the server logs. **Weaker:** it is a static lint that starts no server and reads local paths only, so it says nothing about binding, remote `--fixtures <url>` sources, `--watch` reloads, or any runtime behaviour. An `http://` or `https://` path is refused by name — `Remote fixture source: this lint reads local paths only (the server's --fixtures accepts a URL; validate does not) — download the file and validate the local copy` — rather than reported as a missing file. "The server" there is the `llmock` bin (`dist/cli.js`, the Docker entrypoint), whose `-f, --fixtures` takes a filesystem path or an `https://`/`http://` URL to a `.json` fixture file; the `aimock` bin has no `--fixtures` flag, and the `llm.fixtures` in its `--config` file is resolved as a filesystem path only.

Anything the filesystem or a fixture entry can throw is contained in the report instead of crashing the run: a malformed entry, an unreadable file or directory, a stat failure, or a symlink cycle each becomes a per-file `[error]` line and exits 1. One stat failure is deliberately silent: a directory entry that vanishes between the `readdir` and the `stat` (`ENOENT` — a dangling symlink, or a file deleted mid-walk) is skipped without a finding, exactly as the server's loader skips it; every other stat failure is surfaced. A directory argument that walks cleanly but holds no `*.json` files is likewise a per-path `[error]` and exits 1. A crash inside the validator itself is contained too: a per-file one becomes a file-level `[error]` naming no entry, and one in the combined pass becomes a run-level `[error]` printed after the per-file output.

A file may also hold an [`mcpFakes`](https://aimock.copilotkit.dev/mcp-mock#scenario-fakes) key. `validate` checks its blocks by the server's load rules (a bad block is an error that names its rule, such as `[mcp-fakes/bad-block:a]`; an `args` entry after an `anyArgs` entry is a warning) and checks entry ids across all files. Mount conflicts depend on the running server and are not checked. A file with only `mcpFakes` is validated, not skipped, and a run of fakes-only files does not fail the zero-fixture rule. The `OK` line counts blocks: `account/read-only.json: OK (0 fixture(s), 1 mcpFakes block(s))`.

Errors go to stderr while `OK` and summary lines go to stdout; warnings follow the exit they produce — stdout by default, stderr under `--strict`. Every file gets exactly one stdout line — including a file that failed fatally, and a file the walk skipped (`<file>: skipped (...)`) — so a reader tallying stdout never loses a file. `OK` is withheld in one case: on a run that failed because it loaded no fixtures at all, the file that loaded none reads `<file>: 0 fixture(s), loaded nothing — see the run-level error`. With `--json`, stdout carries the report alone and the one-line failure reason goes to stderr; a usage error is reported the same way, as a document with `files: []` and the reason in `run.errors`. Exit codes: `0` clean; `1` everything else — validation errors, a malformed fixture entry, unreadable/unparseable files, a NAMED path of the wrong shape (a walked one is skipped instead), a remote `http(s)://` path, a stat failure or symlink cycle while walking a directory, a `*.json` path that is not a regular file, a directory holding no `*.json` files, no fixtures loaded at all, `--strict` warnings, or a usage error (no paths given, or an unknown option). There is no exit code 2; every other CLI in this package reports a usage error as 1 too.

`--json` emits one document on stdout, and only that document — a usage error included. Validating a directory holding a file with invalid JSON and a file with one bad entry and a duplicate `userMessage`:

```json
{
  "strict": false,
  "failed": true,
  "files": [
    {
      "file": "fixtures/badjson.json",
      "mention": 1,
      "fixtures": 0,
      "errors": [
        {
          "message": "Invalid JSON: Expected property name or '}' in JSON at position 1 (line 1 column 2)"
        }
      ],
      "warnings": [],
      "fatal": "Invalid JSON: Expected property name or '}' in JSON at position 1 (line 1 column 2)"
    },
    {
      "file": "fixtures/mixed.json",
      "mention": 1,
      "fixtures": 2,
      "errors": [
        {
          "index": 0,
          "message": "Invalid fixture entry #0: missing or non-object \"match\" and \"response\" — every entry needs { \"match\": { ... }, \"response\": { ... } }"
        }
      ],
      "warnings": [
        {
          "index": 2,
          "message": "duplicate userMessage 'hi' — shadows fixture 1"
        }
      ]
    }
  ],
  "run": {
    "fixtures": 2,
    "mcpFakeBlocks": 0,
    "errors": []
  }
}
```

A usage error carries the reason in `run.errors` (`aimock validate --json`, exit 1):

```json
{
  "strict": false,
  "failed": true,
  "files": [],
  "run": {
    "fixtures": 0,
    "mcpFakeBlocks": 0,
    "errors": ["no fixture paths given."]
  }
}
```

`failed` is the boolean the exit code follows, and `strict` echoes the flag it was computed under. `files` has one entry per path the run touched, in argv/walk order: `mention` is which load of that path this is (1-based, always present); `fixtures` is how many entries converted; `skipped` (present only when set) is why a walked non-fixture file was passed over; `fatal` (present only when set) is the reason the file produced no report at all, and that same reason also appears in `errors`, so a tally of `files[].errors` matches the error count on the file's stdout line; and `errors`/`warnings` hold findings; a file with an `mcpFakes` key also has `mcpFakeBlocks`, the number of blocks it adds. A finding always has `message`; `index` is the entry it belongs to and is **absent** on a file-level finding; `detail` carries the raw thrown text when `message` is a rephrasing of it. `run` covers the combined pass: `fixtures` is the total fixture count across every file, `mcpFakeBlocks` (always present, `0` when no file has `mcpFakes`) is the total number of `mcpFakes` blocks, and `errors` holds run-level strings such as `"Cross-file validation failed: ..."`, the `"No fixtures loaded from any input — the server aborts startup on this under --validate-on-load/--strict"` line, or the reason a usage error failed.

### Remote fixture URLs

`--fixtures` accepts `https://` and `http://` URLs pointing at JSON fixture files in addition to filesystem paths, and the flag is repeatable so you can layer remote and local sources in argv order. Fetched fixtures are cached on disk at `~/.cache/aimock/fixtures/<sha256-of-url>/` (honors `$XDG_CACHE_HOME`); when paired with `--validate-on-load`, a fetch failure with a valid cached copy logs a warning and continues — without a cache, the process exits non-zero. HTTP fetches have a 10s timeout and a 50 MB body cap; redirects are rejected fail-loud, so configure your upstream to serve the final URL directly (GitHub raw content URLs already do).

Private and link-local addresses (loopback, RFC1918, CGNAT, cloud metadata, ULA, multicast) are rejected by default to prevent SSRF. For local development or tests that need to hit `127.0.0.1`, opt out with `AIMOCK_ALLOW_PRIVATE_URLS=1`. Tarball and zip URL support is intentionally deferred.

### Replay matching & `AIMOCK_STRICT_TURN_INDEX`

On replay, `turnIndex` is a non-fatal disambiguator, not a hard reject gate: a content-matching fixture is served even when its scripted `turnIndex` differs from the request's assistant-message count. This kills false "no fixture matched" misses for multi-bubble agent runs (multi-step agents emit several assistant bubbles per logical turn). When a served fixture diverges from its scripted `turnIndex`, the match diagnostic carries `turnIndexRelaxed: true` and aimock logs a one-shot warning (at the `warn` log level, so it is silent under the programmatic default, which is `silent`, and printed by the `llmock` CLI, which defaults `--log-level` to `info`). To restore the legacy strict behavior where a defined `turnIndex` must equal the assistant count exactly, set `AIMOCK_STRICT_TURN_INDEX=1`. The record path is always strict regardless of this flag.

## API-key validation

By default aimock accepts all requests. Opt into inbound test-client validation with a programmatic option, top-level `aimock.json` field, or environment-only key list:

```ts
await createServer(fixtures, { auth: { apiKeys: ["test-key"] } });
```

```json
{ "auth": { "apiKeys": ["test-key"] } }
```

```bash
AIMOCK_API_KEYS=test-key,rotated-key npx @copilotkit/aimock --config aimock.json
```

Use `Authorization: Bearer <key>`, `Authorization: Key <key>`, `x-api-key`, `x-goog-api-key`, `api-key`, or `xi-api-key`. Every supplied credential must resolve to one configured key; mismatches return `401` with an OpenAI-compatible authentication error. HTTP routes, control APIs, mounts, and WebSocket upgrades are protected. Genuine CORS preflights plus `GET /health`, `GET /ready`, and `GET /metrics` remain public. This is inbound test access control, distinct from `record.providerKeys`; when enabled, proxying strips test credentials and requires a configured static provider credential before egress.

### aimock-owned upstream keys — `AIMOCK_PROVIDER_*_KEY`

In record or `--proxy-only` mode, aimock forwards the caller's auth header to the real provider unchanged. If your tests can only send a dummy placeholder key (e.g. an SDK that refuses to start without a non-empty API key), aimock can inject its own configured upstream key on a fixture-miss passthrough so the proxied call actually authenticates. Each provider has an independent env var, and the key is applied with the provider-correct wire scheme:

| Env var                          | Provider                         | Injected header               |
| -------------------------------- | -------------------------------- | ----------------------------- |
| `AIMOCK_PROVIDER_OPENAI_KEY`     | OpenAI                           | `Authorization: Bearer <key>` |
| `AIMOCK_PROVIDER_OPENROUTER_KEY` | OpenRouter                       | `Authorization: Bearer <key>` |
| `AIMOCK_PROVIDER_COHERE_KEY`     | Cohere                           | `Authorization: Bearer <key>` |
| `AIMOCK_PROVIDER_GROK_KEY`       | Grok (xAI)                       | `Authorization: Bearer <key>` |
| `AIMOCK_PROVIDER_BYTEPLUS_KEY`   | BytePlus Ark (ModelArk)          | `Authorization: Bearer <key>` |
| `AIMOCK_PROVIDER_OLLAMA_KEY`     | Ollama (Cloud / bearer-gated)    | `Authorization: Bearer <key>` |
| `AIMOCK_PROVIDER_ANTHROPIC_KEY`  | Anthropic                        | `x-api-key: <key>`            |
| `AIMOCK_PROVIDER_GEMINI_KEY`     | Gemini (and Gemini Interactions) | `x-goog-api-key: <key>`       |
| `AIMOCK_PROVIDER_VEO_KEY`        | Veo                              | `x-goog-api-key: <key>`       |
| `AIMOCK_PROVIDER_AZURE_KEY`      | Azure OpenAI                     | `api-key: <key>`              |
| `AIMOCK_PROVIDER_ELEVENLABS_KEY` | ElevenLabs                       | `xi-api-key: <key>`           |
| `AIMOCK_PROVIDER_FAL_KEY`        | fal.ai                           | `Authorization: Key <key>`    |

The Gemini interactions provider mode reuses `AIMOCK_PROVIDER_GEMINI_KEY` (same upstream API as Gemini). An empty-string value is treated as unset.

> **Which binary reads them.** Only the `llmock` bin reads `AIMOCK_PROVIDER_*_KEY` from the environment (it fills `record.providerKeys` at startup). `aimock --config` does not read these variables: the config loader passes `llm.record` through verbatim, so under `aimock --config` set `llm.record.providerKeys` in the JSON instead. The programmatic API likewise takes `record.providerKeys` in `LLMock` options.

This is opt-in and backward-compatible: with no key configured the feature is inert and the caller's header passes through as-is. Injection fires only when the caller sent no credential **or** a dummy credential prefixed with `sk-aimock-` (overridable via `AIMOCK_DUMMY_KEY_MARKER`); a real caller key never starting with that marker is always forwarded verbatim, so the caller overrides aimock. Signed and exchanged credentials — AWS Bedrock (SigV4) and Vertex AI (OAuth) — are never rewritten and always forwarded unchanged. (Azure's static `api-key` is injected; a real Microsoft Entra ID `Authorization: Bearer` token from the caller is never dummy-prefixed, so it too passes through verbatim.)

## Framework Guides

Test your AI agents with aimock — no API keys, no network calls: [LangChain](https://aimock.copilotkit.dev/integrate-langchain) · [CrewAI](https://aimock.copilotkit.dev/integrate-crewai) · [PydanticAI](https://aimock.copilotkit.dev/integrate-pydanticai) · [LlamaIndex](https://aimock.copilotkit.dev/integrate-llamaindex) · [Mastra](https://aimock.copilotkit.dev/integrate-mastra) · [Google ADK](https://aimock.copilotkit.dev/integrate-adk) · [Microsoft Agent Framework](https://aimock.copilotkit.dev/integrate-maf)

## Switching from other tools?

Step-by-step migration guides: [MSW](https://aimock.copilotkit.dev/migrate-from-msw) · [VidaiMock](https://aimock.copilotkit.dev/migrate-from-vidaimock) · [mock-llm](https://aimock.copilotkit.dev/migrate-from-mock-llm) · [piyook/llm-mock](https://aimock.copilotkit.dev/migrate-from-piyook) · [Python mocks](https://aimock.copilotkit.dev/migrate-from-python-mocks) · [openai-responses](https://aimock.copilotkit.dev/migrate-from-openai-responses) · [Mokksy](https://aimock.copilotkit.dev/migrate-from-mokksy)

## Documentation

**[https://aimock.copilotkit.dev](https://aimock.copilotkit.dev)** · [Example fixtures](https://aimock.copilotkit.dev/examples)

## Real-World Usage

[AG-UI](https://github.com/ag-ui-protocol/ag-ui) uses aimock for its [end-to-end test suite](https://github.com/ag-ui-protocol/ag-ui/tree/main/apps/dojo/e2e), verifying AI agent behavior across LLM providers with [fixture-driven responses](https://github.com/ag-ui-protocol/ag-ui/tree/main/apps/dojo/e2e/fixtures/openai).

## Deprecated & removed APIs

aimock keeps mocking provider surfaces that upstream has deprecated — that is when test scaffolding matters most, since your code still calls them while you migrate. It declines to mock the success path of APIs that have actually been removed: a mock that answers `200` where the real endpoint is gone manufactures a passing test for code that cannot work. Full policy: [Deprecated & Removed APIs](https://aimock.copilotkit.dev/deprecation-policy).

## License

MIT
