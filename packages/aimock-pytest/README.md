# aimock-pytest

pytest fixtures for [aimock](https://github.com/CopilotKit/aimock) — mock LLM APIs, MCP tools, A2A agents, vector databases, and more.

## Install

```bash
# From PyPI (once published):
pip install aimock-pytest

# Local install from a repo checkout:
pip install ./packages/aimock-pytest
```

**Requires:** Node.js >= 20 on `PATH` (or set `AIMOCK_NODE_PATH`).

## Quick Start

The plugin auto-registers two fixtures: `aimock` (function-scoped) and `aimock_session` (session-scoped).

```python
def test_hello(aimock):
    import requests

    # Set up a fixture
    aimock.on_message("hello", {"content": "Hi there!"})

    # Point your SDK at aimock
    r = requests.post(
        f"{aimock.base_url}/v1/chat/completions",
        json={
            "model": "gpt-4",
            "messages": [{"role": "user", "content": "hello"}],
        },
    )
    assert r.json()["choices"][0]["message"]["content"] == "Hi there!"
```

## Fixtures

| Fixture          | Scope    | Description                    |
| ---------------- | -------- | ------------------------------ |
| `aimock`         | function | Fresh server per test          |
| `aimock_session` | session  | Shared server across all tests |

## Server API

```python
# Add fixtures
aimock.on_message("pattern", {"content": "response"})
aimock.on_embedding("pattern", {"embedding": [0.1, 0.2]})
aimock.on_system_message("name=Atai", {"content": "..."}, user_message="who am I")
# Array form: all substrings must appear in the joined system text (AND)
aimock.on_system_message(["name=Atai", "tz=PST"], {"content": "..."})
aimock.add_fixture(match={...}, response={...}, chunkSize=10, latency=50)
# Ordered blocks: stream a tool call before text (tool-first / interleaved).
# A blocks-only response is first-class — see /fixtures#ordered-blocks
aimock.add_fixture(match={...}, response={"blocks": [
    {"type": "toolCall", "name": "get_weather", "arguments": {"city": "SF"}},
    {"type": "text", "text": "Here is the weather."},
]})
aimock.load_fixtures("path/to/fixtures.json")  # also loads the file's mcpFakes

# Inspect
aimock.get_journal()       # list of all recorded requests
aimock.get_last_request()  # most recent request or None

# Error injection
aimock.next_error(429, {"message": "Rate limited"})

# Reset
aimock.clear_fixtures()    # remove all fixtures, nothing else
aimock.reset()             # full reset: fixtures, journal entries + match-counts,
                           # video/fal job state, Gemini counters
aimock.reset_journal()     # clear only the request journal (fixtures preserved)
aimock.reset_fixtures()    # alias for reset() — a full reset, despite the name
```

## MCP fakes

`load_fixtures` posts a file's `mcpFakes` key (see [MCP scenario fakes](https://aimock.copilotkit.dev/mcp-mock#scenario-fakes)) next to its `fixtures`. A file may hold only `mcpFakes`. `reset()`, `reset_fixtures()` and `clear_fixtures()` also unload the fakes.

When the server rejects a file with HTTP 400, `load_fixtures` raises `requests.HTTPError` with the message `aimock rejected fixtures from <path>: <error>`, followed by one line for each item of `details`. When the file has `mcpFakes` and the aimock server is a release without MCP fakes, `load_fixtures` raises `RuntimeError` (`aimock server too old for mcpFakes: ...`) and adds nothing from the file.

## CLI Options

```
--aimock-node PATH       Path to node binary
--aimock-version VER     aimock npm version (default: 1.44.0)
--aimock-api-key KEY     Inbound API key for the aimock child process
```

## API-key validation

Pass `pytest --aimock-api-key test-key` to protect the aimock child. The helper sends this key on all control API calls, and the child receives it through `AIMOCK_API_KEYS`, never through process arguments. Direct client calls must use `Authorization: Bearer test-key`. For direct construction, use `AIMockServer(node_manager, api_key="test-key")`.

## Environment Variables

| Variable           | Description                                           |
| ------------------ | ----------------------------------------------------- |
| `AIMOCK_NODE_PATH` | Path to node binary                                   |
| `AIMOCK_CACHE_DIR` | Override cache directory (default: `~/.cache/aimock`) |

## Development

### Prerequisites

- Node.js >= 20
- Python >= 3.10
- pnpm

### Running tests locally

Run these commands from the repository root with Python 3.10 or later and
Node.js 20.15.0 or later. The example uses Python 3.12.

Build the local CLI and install the Python test dependencies in a virtual environment:

```bash
pnpm install --frozen-lockfile
pnpm run build
python3.12 -m venv .venv
. .venv/bin/activate
python -m pip install --require-hashes -r .github/requirements/hatchling.txt
python -m pip install --no-build-isolation -e "./packages/aimock-pytest[test]"
export AIMOCK_CLI_PATH="$PWD/dist/cli.js"
python -m pytest packages/aimock-pytest/tests/ -v
```

The `test` extra installs pytest and the OpenAI and Anthropic Python SDKs.
`AIMOCK_CLI_PATH` selects the local build and bypasses the npm package download.
Keep the complete `dist/` directory from that build, because the CLI imports other
build files. Rebuild after changes to the TypeScript source.

The test `conftest.py` also detects the repository's `dist/cli.js` when
`AIMOCK_CLI_PATH` is unset. An explicit absolute path selects the intended candidate
even when another build exists. To use a different checkout, set this variable to
that checkout's built `dist/cli.js` before running pytest.

To run only the model-misbehavior SDK and control tests:

```bash
python -m pytest \
  packages/aimock-pytest/tests/test_misbehavior_openai.py \
  packages/aimock-pytest/tests/test_misbehavior_anthropic.py \
  packages/aimock-pytest/tests/test_misbehavior_controls.py -v
```

These tests send real SDK requests to the local aimock server. They use local test
API keys and disable SDK retries. No live provider credentials are required.
The tests check SDK parsing, streamed events, and control behavior against the
selected CLI build. A test failure can expose a provider implementation gap in
that candidate.

### How CI works

The `test-pytest.yml` workflow:

1. Checks out the repo
2. Builds the TypeScript package (`pnpm run build`)
3. Sets `AIMOCK_CLI_PATH` to the local `dist/cli.js`
4. Installs `aimock-pytest[test]` and runs `pytest`

Tests run across a matrix of Python 3.10--3.13 and Node 20/22.

The Release workflow publishes `aimock-pytest` to PyPI after its npm publish
job succeeds. Its PyPI job verifies that the `AIMOCK_VERSION` pin exists on
npm before building a wheel, so npm publication completes before the
corresponding `aimock-pytest` release.

## License

MIT
