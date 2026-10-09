# Record an MCP server once, replay it to real agent clients

This project checks that an MCP recording made by aimock works for real agent
clients, not only for the CLI proof in `examples/mcp-record-proof`:

- a **Mastra `Agent`** (`mastra-agent.test.ts`). Its model is an
  OpenAI-compatible model pointed at aimock LLM fixtures
  (`fixtures/llm/agent.json`). Its tools come from Mastra's `MCPClient`,
  pointed at `fakesFor("mcp › record").mcpUrl`.
- the **Python `mcp` SDK** (`python/replay.py`, `mcp==1.30.0`, a session-era
  client), through `streamablehttp_client`.

No real model key and no external network are used. The Vitest setup
(`no-network.ts`) blocks any `fetch` to a host that is not loopback.

## Run it

`run.sh` needs `pnpm` and `uv`. Give it a packed aimock:

```bash
pnpm build && pnpm pack --pack-destination /tmp/aimock-pr   # at the repo root
./run.sh /tmp/aimock-pr/copilotkit-aimock-*.tgz
```

It does four steps:

1. It starts the real `server-everything` upstream with a scrubbed
   environment, because its `get-env` tool returns the whole process
   environment. It records the upstream through
   `llmock --fixtures fixtures --mcp-record /mcp=<upstream>`, with
   `AIMOCK_RECORD_SECRET_VALUES` set. `record.mjs` makes the calls: the tool
   list, `echo`, `get-sum`, `get-structured-content`, the long-running tool
   (with progress) and `get-env`. Then it **stops the upstream**. Before each
   replay, the script checks that nothing answers on the upstream port.
2. The Mastra agent calls `echo {message:"hi"}` because the LLM fixture tells
   it to. The second LLM fixture matches the tool result and gives the final
   text. The test then calls the other four recorded tools. Every result must
   equal the recorded entry. The tools with no secret must also equal the
   live answers. `fakesReport().ok` must be true.
3. `replay.py` prints the negotiated protocol version and the session id. It
   makes the same calls and prints `OK 5/5`. A call with new arguments must
   give `MCP_FAKE_MISMATCH`.
4. In a copy of the recording, the script changes the recorded `echo` args
   from `"hi"` to `"hello"`. Both clients must then fail. The agent journal
   shows a `mismatch` outcome, and the fakes report fails the test with
   `MCP_FAKE_MISMATCH`. The Python replay prints `FAIL 4/5`.

The run ends with `VERDICT=PASS` (exit 0) only if all four steps behave as
described. With a release that has no MCP recording, step 1 fails with
`Unknown option '--mcp-record'`. Steps 2 to 4 then use the checked-in
recording, and the agent test fails because the plugin has no `fakesFor`.

`fixtures/recorded/mcp--record/mcp.json` is a recording made by `run.sh`
with `KEEP_RECORDING=1`. With it, `pnpm install && pnpm test` replays to the
Mastra agent against this repository's build, with no upstream.
