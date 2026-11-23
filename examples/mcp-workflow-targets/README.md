# MCP workflow / pipeline targets (WF2, WF3, HC4)

This project proves that MCP fakes work for any caller that reaches an MCP
mount over HTTP, not only for an agent driven by an LLM. Two real multi-step
pipelines call the tool `lookup_order` on aimock's MCP mount through
`fakesFor().mcpUrl`. There are no LLM calls.

- `mastra-workflow.test.ts` (WF2): a Mastra Workflow (`createWorkflow`, three
  `createStep` steps, `createRun()` and `run.start()`). Each step calls the
  tool through Mastra's `MCPClient`.
- `langgraph-control.test.ts` (WF3, the control): a two-node LangGraph JS
  `StateGraph`. Each node calls the tool through the MCP SDK `Client` over
  `StreamableHTTPClientTransport`. There is no Mastra code.

Both pipelines make the same three calls: `{orderId:"A1"}` twice, then
`{orderId:"B2"}`. The last step keeps a tool error as its output, like a
pipeline that tolerates a failing order service.

## Fixtures

Each fixture has one block per test id, with `undeclaredTools: "deny"`.

- `fixtures/workflow.json`: `A1` answers `"pending"`, then `"shipped"`. `B2`
  is an `error` entry, `"order service down"`.
- `fixtures/workflow-mismatch.json`: the `B2` entry's `args` are changed to
  `{orderId:"B9"}`, so the `B2` call matches no fake (`MCP_FAKE_MISMATCH`).
- `fixtures/workflow-undeclared.json`: the `lookup_order` declaration is
  dropped. The block keeps the tool in its recorded `list`, so the client still
  discovers the tool, but each call is `MCP_FAKE_NOT_DECLARED`.

## Run

```bash
./run.sh path/to/copilotkit-aimock-<version>.tgz fixtures/workflow.json
./run.sh path/to/copilotkit-aimock-<version>.tgz fixtures/workflow-mismatch.json
./run.sh path/to/copilotkit-aimock-<version>.tgz fixtures/workflow-undeclared.json
AIMOCK_FAKES_REPORT=off ./run.sh path/to/copilotkit-aimock-<version>.tgz fixtures/workflow-mismatch.json
```

`run.sh` copies the project to a temporary directory, installs the tarball,
and runs `vitest run`. With `fixtures/workflow.json` it sets
`WF_EXPECT=scripted`, and each test asserts every step's scripted answer. With
the other fixtures, the test body only runs the pipeline and prints what each
step got. Then the fakes report in `afterEach` is the only thing that can fail
the test.

## What the output shows

With `fixtures/workflow.json`, both tests pass:

- every step gets its scripted answer (`pending`, `shipped`, and the error
  text), and the report is `ok: true`;
- test-id isolation: the other test's block is loaded on the same server with
  the same `args`, and its report shows nothing served and three entries
  unconsumed.

With `fixtures/workflow-mismatch.json`, both tests fail in `afterEach` with
`AimockFakesReportError` naming `failure MCP_FAKE_MISMATCH`:

- the journal printed in `afterAll` has `mcpFake.outcome: "mismatch"`;
- the step output carries the JSON-RPC error `data.aimock.code`
  `MCP_FAKE_MISMATCH`;
- the run status is `success` for both Mastra and LangGraph, because the last
  step swallows the error. With `AIMOCK_FAKES_REPORT=off`, the same tests pass.

With `fixtures/workflow-undeclared.json`, both tests fail the same way with
`MCP_FAKE_NOT_DECLARED` (journal outcome `not_declared`). Here the first step
does not catch the error, so the Mastra run status is `failed`.

Mastra's MCP tool throws on an `isError` result, so the Mastra error step's
output is `caught: order service down`. The SDK client returns the result, so
the LangGraph output is `tool error: order service down`.

With a release that has no `fakesFor`, both tests fail with
`TypeError: mock(...).fakesFor is not a function`.
