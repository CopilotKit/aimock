"""MCP fakes through ``AIMockServer.load_fixtures`` (spec 5.4 F13, 5.2 W6).

Real surface: the shipped ``aimock`` fixture starts the built aimock CLI on an
empty fixtures dir, ``load_fixtures`` posts to the real control API, and the
fake tool is called over raw HTTP JSON-RPC (Streamable HTTP) with
``requests``. This is not an MCP SDK client: the plugin has no ``mcp``
dependency.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import quote

import pytest
import requests

from aimock_pytest._node_manager import NodeManager
from aimock_pytest._server import AIMockServer

FIXTURES = Path(__file__).parent / "fixtures"
RETRY_ID = "tickets › retry on timeout"
MCP_HEADERS = {
    "Accept": "application/json, text/event-stream",
    "Content-Type": "application/json",
}


def _rpc_body(response: requests.Response) -> dict[str, Any]:
    """Read one JSON-RPC message from a JSON or SSE response."""
    if response.headers.get("Content-Type", "").startswith("text/event-stream"):
        for line in response.text.splitlines():
            if line.startswith("data:"):
                return json.loads(line[len("data:"):].strip())  # type: ignore[no-any-return]
        raise AssertionError(f"no data line in SSE body: {response.text!r}")
    return response.json()  # type: ignore[no-any-return]


class RawMcpSession:
    """A minimal raw JSON-RPC client for aimock's Streamable HTTP MCP mount."""

    def __init__(self, url: str, test_id: str) -> None:
        self.url = url
        self.next_id = 1
        r = requests.post(
            f"{url}?testId={quote(test_id)}",
            headers=MCP_HEADERS,
            json={
                "jsonrpc": "2.0",
                "id": self._id(),
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-03-26",
                    "capabilities": {},
                    "clientInfo": {"name": "aimock-pytest-test", "version": "0"},
                },
            },
            timeout=5,
        )
        assert r.status_code == 200, r.text
        assert "result" in _rpc_body(r), r.text
        self.session_id = r.headers["Mcp-Session-Id"]
        r = requests.post(
            url,
            headers=self._headers(),
            json={"jsonrpc": "2.0", "method": "notifications/initialized"},
            timeout=5,
        )
        assert r.status_code in (200, 202, 204), r.text

    def _id(self) -> int:
        self.next_id += 1
        return self.next_id - 1

    def _headers(self) -> dict[str, str]:
        return {**MCP_HEADERS, "Mcp-Session-Id": self.session_id}

    def call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        r = requests.post(
            self.url,
            headers=self._headers(),
            json={
                "jsonrpc": "2.0",
                "id": self._id(),
                "method": "tools/call",
                "params": {"name": name, "arguments": arguments},
            },
            timeout=5,
        )
        assert r.status_code == 200, r.text
        return _rpc_body(r)


def _text(result: dict[str, Any]) -> str:
    return "".join(c.get("text", "") for c in result.get("content", []))


def test_shipped_fixture_serves_fakes_from_load_fixtures(aimock):
    """F13 + W6: a fakes-only file reaches an auto-mounted MCP mock."""
    aimock.load_fixtures(FIXTURES / "mcp_fakes_retry.json")

    session = RawMcpSession(f"{aimock.base_url}/mcp", RETRY_ID)
    first = session.call_tool("create_ticket", {"title": "Refund"})
    assert first["result"]["isError"] is True
    assert "upstream timeout" in _text(first["result"])
    second = session.call_tool("create_ticket", {"title": "Refund"})
    assert not second["result"].get("isError")
    assert _text(second["result"]) == "TICKET-42"


def test_fixtures_and_mcp_fakes_are_posted_together(aimock, tmp_path):
    """F13: ``mcpFakes`` is sent next to ``fixtures``; both are served."""
    data = json.loads((FIXTURES / "mcp_fakes_retry.json").read_text())
    data["fixtures"] = [
        {"match": {"userMessage": "hello"}, "response": {"content": "Hello from aimock!"}}
    ]
    path = tmp_path / "both.json"
    path.write_text(json.dumps(data))

    aimock.load_fixtures(path)

    r = requests.post(
        f"{aimock.base_url}/v1/chat/completions",
        json={"model": "gpt-4", "messages": [{"role": "user", "content": "hello"}]},
        timeout=5,
    )
    assert r.status_code == 200
    assert "Hello from aimock" in r.json()["choices"][0]["message"]["content"]
    session = RawMcpSession(f"{aimock.base_url}/mcp", RETRY_ID)
    first = session.call_tool("create_ticket", {"title": "Refund"})
    assert "upstream timeout" in _text(first["result"])


def test_400_surfaces_error_and_details(aimock, tmp_path):
    """F13: a rejected load raises with the response's ``error`` and ``details``."""
    path = tmp_path / "bad.json"
    path.write_text(json.dumps({"mcpFakes": [{"scope": "shared", "tools": "not-a-list"}]}))

    with pytest.raises(requests.HTTPError) as info:
        aimock.load_fixtures(path)

    body = info.value.response.json()
    assert info.value.response.status_code == 400
    assert body["details"], body
    detail = body["details"][0]
    for field in ("rule", "file", "blockId", "entryId", "message"):
        assert field in detail, detail
    text = str(info.value)
    assert body["error"] in text
    assert detail["rule"] in text
    assert detail["blockId"] is not None
    assert detail["blockId"] in text


@pytest.fixture
def old_server() -> Iterator[str]:
    """A stub of an aimock that predates ``mcpFakes``: it ignores the key."""

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802
            self.rfile.read(int(self.headers.get("Content-Length", "0")))
            body = json.dumps({"added": 0}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args: Any) -> None:
            pass

    httpd = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{httpd.server_address[1]}"
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_old_server_without_mcp_fakes_added_raises_too_old(old_server):
    """F13: a 200 with no ``mcpFakesAdded`` to a request with ``mcpFakes`` fails loud."""
    server = AIMockServer(NodeManager())
    server._base_url = old_server

    with pytest.raises(RuntimeError, match="aimock server too old for mcpFakes"):
        server.load_fixtures(FIXTURES / "mcp_fakes_retry.json")


def test_old_server_plain_fixtures_still_load(old_server):
    """Positive control: a file with no ``mcpFakes`` does not need ``mcpFakesAdded``."""
    server = AIMockServer(NodeManager())
    server._base_url = old_server

    server.load_fixtures(FIXTURES / "hello.json")


class _StubAimock:
    """A local stub of the control API, for answers the real server cannot give.

    ``answer`` maps a parsed ``POST /__aimock/fixtures`` body to
    ``(status, payload)``. ``posts`` records every posted body, and
    ``fixtures`` holds what the stub accepted, so a test can see what a load
    left behind.
    """

    def __init__(self, answer: Any) -> None:
        self.posts: list[Any] = []
        self.fixtures: list[Any] = []
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def _send(self, status: int, payload: Any) -> None:
                body = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self) -> None:  # noqa: N802
                raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                parsed = json.loads(raw)
                stub.posts.append(parsed)
                self._send(*answer(stub, parsed))

            def do_GET(self) -> None:  # noqa: N802
                self._send(200, {"count": len(stub.fixtures)})

            def log_message(self, *args: Any) -> None:
                pass

        self.httpd = HTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def server(self) -> AIMockServer:
        server = AIMockServer(NodeManager())
        server._base_url = self.url
        return server

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


def _pre_mcp_fakes_answer(stub: _StubAimock, body: Any) -> tuple[int, Any]:
    """How an aimock from before ``mcpFakes`` answers ``POST /fixtures``.

    It needs a ``fixtures`` array, ignores ``mcpFakes`` and adds the fixtures
    (origin/main src/server.ts, the ``POST /__aimock/fixtures`` route).
    """
    if not isinstance(body, dict) or not isinstance(body.get("fixtures"), list):
        return 400, {"error": 'Missing or invalid "fixtures" array'}
    stub.fixtures.extend(body["fixtures"])
    return 200, {"added": len(body["fixtures"])}


@pytest.fixture
def pre_mcp_fakes_server() -> Iterator[_StubAimock]:
    stub = _StubAimock(_pre_mcp_fakes_answer)
    try:
        yield stub
    finally:
        stub.close()


def test_old_server_fakes_only_file_raises_too_old(pre_mcp_fakes_server):
    """E1: a fakes-only file on a server too old for fakes gets the too-old error.

    That server answers 400 'Missing or invalid "fixtures" array'; the file is
    not bad, so the error must name the server, not reject the file.
    """
    server = pre_mcp_fakes_server.server()

    with pytest.raises(RuntimeError, match="aimock server too old for mcpFakes"):
        server.load_fixtures(FIXTURES / "mcp_fakes_retry.json")
    assert pre_mcp_fakes_server.fixtures == []


def test_old_server_mixed_file_raises_too_old_and_loads_nothing(pre_mcp_fakes_server, tmp_path):
    """E1: a file with fixtures and fakes on a too-old server adds no fixtures."""
    data = json.loads((FIXTURES / "mcp_fakes_retry.json").read_text())
    data["fixtures"] = [
        {"match": {"userMessage": "hello"}, "response": {"content": "Hello from aimock!"}}
    ]
    path = tmp_path / "both.json"
    path.write_text(json.dumps(data))
    server = pre_mcp_fakes_server.server()

    with pytest.raises(RuntimeError, match="aimock server too old for mcpFakes"):
        server.load_fixtures(path)
    assert pre_mcp_fakes_server.fixtures == []


def test_old_server_genuinely_bad_fixtures_value_is_not_called_too_old(
    pre_mcp_fakes_server, tmp_path
):
    """E1 negative control: a bad ``fixtures`` value is the file's fault."""
    path = tmp_path / "bad-fixtures.json"
    path.write_text(json.dumps({"fixtures": "not-a-list", "mcpFakes": []}))
    server = pre_mcp_fakes_server.server()

    with pytest.raises(requests.HTTPError, match='Missing or invalid "fixtures" array'):
        server.load_fixtures(path)


def test_fakes_only_load_is_one_request():
    """E1: on a server that serves fakes, a fakes-only file is one POST."""

    def answer(stub: _StubAimock, body: Any) -> tuple[int, Any]:
        return 200, {"added": 0, "mcpFakesAdded": 1}

    stub = _StubAimock(answer)
    try:
        stub.server().load_fixtures(FIXTURES / "mcp_fakes_retry.json")
        assert len(stub.posts) == 1
        assert set(stub.posts[0]) == {"mcpFakes"}
    finally:
        stub.close()


def test_mixed_load_on_real_server_adds_fixtures_once(aimock, tmp_path):
    """E1: whatever detection a mixed load does, the real server gets each fixture once."""
    data = json.loads((FIXTURES / "mcp_fakes_retry.json").read_text())
    data["fixtures"] = [
        {"match": {"userMessage": "hello"}, "response": {"content": "Hello from aimock!"}}
    ]
    path = tmp_path / "both.json"
    path.write_text(json.dumps(data))

    aimock.load_fixtures(path)

    r = requests.get(f"{aimock.base_url}/__aimock/fixtures", timeout=5)
    assert r.json()["count"] == 1
    session = RawMcpSession(f"{aimock.base_url}/mcp", RETRY_ID)
    assert "upstream timeout" in _text(session.call_tool("create_ticket", {"title": "Refund"})["result"])


@pytest.mark.parametrize(
    "details",
    ["bad block at mcpFakes[0]", 7, True, {"rule": "mcp-fakes/bad-block"}],
)
def test_400_with_non_list_details_keeps_the_server_error(details, tmp_path):
    """E2: a non-list ``details`` is shown whole, and the server error is kept."""

    def answer(stub: _StubAimock, body: Any) -> tuple[int, Any]:
        return 400, {"error": "Validation failed", "details": details}

    stub = _StubAimock(answer)
    try:
        path = tmp_path / "f.json"
        path.write_text(json.dumps({"fixtures": [{"match": {}, "response": {"content": "x"}}]}))
        with pytest.raises(requests.HTTPError) as info:
            stub.server().load_fixtures(path)
    finally:
        stub.close()

    text = str(info.value)
    assert "Validation failed" in text
    assert json.dumps(details) in text
    # One detail line, not one line per character of a string.
    assert len(text.splitlines()) == 2, text


def test_real_server_answers_the_probe_without_adding_anything(aimock):
    """E1: the mixed-file probe (``{"mcpFakes": []}``) is a 400 that adds nothing.

    ``load_fixtures`` depends on this answer to tell a server that serves
    fakes from one that needs a fixtures array.
    """
    r = requests.post(f"{aimock.base_url}/__aimock/fixtures", json={"mcpFakes": []}, timeout=5)

    assert r.status_code == 400, r.text
    assert r.json()["error"] != 'Missing or invalid "fixtures" array'
    assert r.json()["details"], r.text
    count = requests.get(f"{aimock.base_url}/__aimock/fixtures", timeout=5).json()["count"]
    assert count == 0
    mcp = requests.post(
        f"{aimock.base_url}/mcp",
        headers=MCP_HEADERS,
        json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
        timeout=5,
    )
    assert mcp.status_code == 404, mcp.text
