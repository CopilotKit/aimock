# MCP record-and-replay proof (HC3)

This project proves that aimock records a real MCP server into an `mcpFakes`
file and replays that file offline.

- `proof.sh <cli.js> <work-dir>` starts the real `server-everything` upstream
  (with a scrubbed environment, because its `get-env` tool returns the whole
  process environment). It records through
  `llmock --fixtures <work-dir>/fx --mcp-record /mcp=<upstream>` with
  `AIMOCK_RECORD_SECRET_VALUES` set, then stops the upstream. Then it replays
  the recording offline at `--replay-speed 1` and `100`.
- It then does the same through a standalone `MCPMock` (`standalone.mjs`):
  `enableRecording` to record, and `loadFakes` to replay.
- `record-then-replay.mjs` is the client. It uses the MCP SDK and calls
  `listTools`, `echo`, `get-sum`, `get-structured-content`, the long-running
  tool (with progress) and `get-env`.

Run it against a build of this repository:

```bash
pnpm install
./proof.sh ../../dist/cli.js "$(mktemp -d)"
```

Expected output:

- `SECRET_COUNT=0`, and `WARNINGS` names the `get-env` result pointer;
- for every replay: `REPLAY_EQUALS_RECORDING=true` (equal to the recorded
  file), `REPLAY_EQUALS_LIVE_NONSECRET=true`, `GET_ENV_REDACTED=true`, and
  `MISMATCH_CODE=MCP_FAKE_MISMATCH` for a call that was never recorded;
- `PROGRESS=[1,2]`.

With a release that has no MCP recording, the CLI exits at once with
`Unknown option '--mcp-record'`.

A standalone recording writes `"mount": "/"`. Replay it with `loadFakes` on a
standalone `MCPMock`, as `standalone.mjs` does.
