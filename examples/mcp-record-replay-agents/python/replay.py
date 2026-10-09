"""rr: 10.4 item 6: the Python `mcp` SDK replays a recorded MCP server.

Connects with `streamablehttp_client` to `<AIMOCK_URL>/mcp?testId=mcp › record`
(an aimock that serves the recording; the upstream is not running), then:

- prints the negotiated protocolVersion and the Mcp-Session-Id (the pre-check:
  this is a session-era client);
- lists the tools and makes the five recorded calls;
- checks each result equals the recorded entry and, with --live, that the tools
  with no secret also equal what the live upstream answered (ids are not part
  of a result);
- calls echo with arguments that were never recorded, and checks that aimock
  reports MCP_FAKE_MISMATCH instead of answering;
- prints the fakes report for the test id (the changed call is a failure there).

Prints `OK 5/5` and exits 0 only when all of that holds.

Usage: python replay.py <aimock-url> <recorded mcp.json> [--live results-record.json]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from typing import Any
from urllib.parse import quote
from urllib.request import urlopen

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client
from mcp.shared.exceptions import McpError

TEST_ID = "mcp › record"
# The same list as calls.mjs (the record client and the Mastra agent test).
CALLS: list[tuple[str, dict[str, Any]]] = [
    ("echo", {"message": "hi"}),
    ("get-sum", {"a": 1, "b": 2}),
    ("get-structured-content", {"location": "New York"}),
    ("trigger-long-running-operation", {"duration": 2, "steps": 2}),
    ("get-env", {}),
]
NON_SECRET = {
    "echo",
    "get-sum",
    "get-structured-content",
    "trigger-long-running-operation",
}


def as_wire(model: Any) -> Any:
    """A pydantic result as the JSON the server sent (no defaults added)."""
    return model.model_dump(mode="json", by_alias=True, exclude_unset=True)


def aimock_code(err: McpError) -> str:
    """The aimock error code a JSON-RPC error carries."""
    data = err.error.data if isinstance(err.error.data, dict) else {}
    return str(data.get("aimock", {}).get("code", f"no aimock code ({err})"))


def recorded(block: dict[str, Any], name: str, args: dict[str, Any]) -> Any:
    """The recorded result for `name` with `args`, as the fakes engine serves it."""
    for tool in block["tools"]:
        if tool["name"] != name:
            continue
        for call in tool["calls"]:
            if call.get("args", {}) == args:
                if "error" in call:
                    return {
                        "content": [{"type": "text", "text": call["error"]}],
                        "isError": True,
                    }
                return call["result"]
    return None


def load_json(path: str) -> Any:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


async def replay(url: str, block: dict[str, Any], live: Any) -> tuple[int, bool, str]:
    """One MCP session: returns (results equal, list equal, changed-call code)."""
    endpoint = f"{url}/mcp?testId={quote(TEST_ID, safe='')}"
    async with (
        streamablehttp_client(endpoint) as (read, write, get_session_id),
        ClientSession(read, write) as session,
    ):
        init = await session.initialize()
        print(f"PY_PROTOCOL_VERSION={init.protocolVersion}")
        print(f"PY_SESSION_ID={get_session_id()}")

        tools = [as_wire(t) for t in (await session.list_tools()).tools]
        list_ok = tools == block.get("list")
        print(f"PY_TOOLS={len(tools)} LIST_EQUALS_RECORDING={list_ok}")

        progress: list[float] = []

        async def on_progress(p: float, _total: float | None, _msg: str | None) -> None:
            progress.append(p)

        same = 0
        for name, args in CALLS:
            cb = on_progress if name == "trigger-long-running-operation" else None
            try:
                got = as_wire(await session.call_tool(name, args, progress_callback=cb))
            except McpError as err:
                got = {"error": aimock_code(err)}
            file_ok = got == recorded(block, name, args)
            live_ok = (
                live is None or name not in NON_SECRET or got == live["calls"][name]
            )
            if file_ok and live_ok:
                same += 1
            else:
                print(f"PY_DIFF {name} got={json.dumps(got)}")
        print(f"PY_PROGRESS={progress}")

        # A changed call must be reported, never swallowed.
        code = "none (the call resolved)"
        try:
            await session.call_tool("echo", {"message": "hello"})
        except McpError as err:
            code = aimock_code(err)
        print(f"PY_CHANGED_CALL_CODE={code}")
    return same, list_ok, code


def print_report(url: str) -> None:
    """The aimock fakes report for the test id (RP6)."""
    query = quote(TEST_ID, safe="")
    with urlopen(f"{url}/__aimock/mcp/fakes/report?testId={query}") as res:
        report = json.load(res)
    codes = [row.get("code") for row in report["failures"]]
    print(
        f"PY_REPORT ok={report['ok']} served={len(report['served'])}"
        f" unconsumed={len(report['unconsumed'])} failures={codes}"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("url")
    parser.add_argument("recording")
    parser.add_argument("--live")
    a = parser.parse_args()
    url = a.url.rstrip("/")
    doc = load_json(a.recording)
    block = doc["mcpFakes"][0] if isinstance(doc["mcpFakes"], list) else doc["mcpFakes"]
    live = load_json(a.live) if a.live else None

    same, list_ok, code = asyncio.run(replay(url, block, live))
    print_report(url)
    src = "file + live" if live is not None else "file"
    print(f"{'OK' if same == len(CALLS) else 'FAIL'} {same}/{len(CALLS)} ({src})")
    sys.exit(0 if same == len(CALLS) and list_ok and code == "MCP_FAKE_MISMATCH" else 1)


if __name__ == "__main__":
    main()
