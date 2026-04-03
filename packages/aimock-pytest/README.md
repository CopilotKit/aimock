# aimock-pytest

pytest fixtures for [aimock](https://github.com/CopilotKit/llmock) — mock LLM APIs, MCP tools, A2A agents, vector databases, and more.

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
aimock.add_fixture(match={...}, response={...}, chunkSize=10, latency=50)
aimock.load_fixtures("path/to/fixtures.json")

# Inspect
aimock.get_journal()       # list of all recorded requests
aimock.get_last_request()  # most recent request or None

# Error injection
aimock.next_error(429, {"message": "Rate limited"})

# Reset
aimock.clear_fixtures()    # remove all fixtures
aimock.reset()             # clear fixtures + journal
```

## CLI Options

```
--aimock-node PATH       Path to node binary
--aimock-version VER     aimock npm version (default: 1.7.0)
```

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

Build the npm package first, then point `AIMOCK_CLI_PATH` at the local build:

```bash
pnpm install && pnpm run build
AIMOCK_CLI_PATH=../../dist/cli.js pytest tests/ -v
```

If you install the test dependencies and run from the `packages/aimock-pytest/`
directory, `conftest.py` will auto-detect the local build so you can omit the
env var:

```bash
pip install ./packages/aimock-pytest[test]
cd packages/aimock-pytest
pytest tests/ -v
```

### How CI works

The `test-pytest.yml` workflow:

1. Checks out the repo
2. Builds the TypeScript package (`pnpm run build`)
3. Sets `AIMOCK_CLI_PATH` to the local `dist/cli.js`
4. Installs `aimock-pytest[test]` and runs `pytest`

Tests run across a matrix of Python 3.10--3.13 and Node 20/22.

The `publish-pytest.yml` workflow publishes to PyPI on pushes to `main` when
the version in `pyproject.toml` has not already been published.

## License

MIT
