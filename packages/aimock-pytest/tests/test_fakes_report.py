"""``fakes_for``, ``fakes_report`` and ``assert_fakes_report`` (spec TI3, RP8).

Real surface: the shipped ``aimock`` fixture starts the built aimock CLI,
``load_fixtures`` posts an ``mcpFakes`` file to the real control API, the fake
is called over raw HTTP JSON-RPC (Streamable HTTP), and the report is read
from the real ``GET /__aimock/mcp/fakes/report``.

The fixture file is scoped to this module's ``test_default_id_served``. Each
test rewrites the scope to its own ``request.node.nodeid`` at run time,
because a pytest node id is relative to the rootdir.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote, urlsplit

import pytest
import requests

from aimock_pytest._node_manager import NodeManager

FIXTURES = Path(__file__).parent / "fixtures"
MCP_HEADERS = {
    "Accept": "application/json, text/event-stream",
    "Content-Type": "application/json",
}


def _rpc_body(response: requests.Response) -> dict[str, Any]:
    """Read one JSON-RPC message from a JSON or SSE response."""
    if response.headers.get("Content-Type", "").startswith("text/event-stream"):
        for line in response.text.splitlines():
            if line.startswith("data:"):
                return json.loads(line[len("data:") :].strip())  # type: ignore[no-any-return]
        raise AssertionError(f"no data line in SSE body: {response.text!r}")
    return response.json()  # type: ignore[no-any-return]


def _call_tool(
    url: str, headers: dict[str, str], name: str, arguments: dict[str, Any] | None
) -> dict[str, Any]:
    """Initialize an MCP session at ``url`` with ``headers``, then call one tool.

    ``arguments=None`` sends the ``tools/call`` with no ``arguments`` key.
    """
    init_headers = {**MCP_HEADERS, **headers}
    r = requests.post(
        url,
        headers=init_headers,
        json={
            "jsonrpc": "2.0",
            "id": 1,
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
    session_headers = {**init_headers, "Mcp-Session-Id": r.headers["Mcp-Session-Id"]}
    r = requests.post(
        url,
        headers=session_headers,
        json={"jsonrpc": "2.0", "method": "notifications/initialized"},
        timeout=5,
    )
    assert r.status_code in (200, 202, 204), r.text
    params: dict[str, Any] = {"name": name}
    if arguments is not None:
        params["arguments"] = arguments
    r = requests.post(
        url,
        headers=session_headers,
        json={"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": params},
        timeout=5,
    )
    assert r.status_code == 200, r.text
    return _rpc_body(r)


def _pct(value: str) -> str:
    return quote(value, safe="")


def _text(result: dict[str, Any]) -> str:
    return "".join(c.get("text", "") for c in result.get("content", []))


def _load_scoped(aimock: Any, tmp_path: Path, test_id: str) -> None:
    """Load ``fakes_report.json`` with its scope set to ``test_id``."""
    data = json.loads((FIXTURES / "fakes_report.json").read_text())
    data["mcpFakes"]["scope"] = {"testId": test_id}
    path = tmp_path / "fakes_report.json"
    path.write_text(json.dumps(data, ensure_ascii=False))
    aimock.load_fixtures(path)


def test_default_id_served(aimock, request, tmp_path):
    """TI3: the default id is the node id, and ``mcp_url`` serves the scoped fake."""
    target = aimock.fakes_for()
    assert target.test_id == request.node.nodeid
    parts = urlsplit(target.mcp_url)
    assert f"{parts.scheme}://{parts.netloc}" == aimock.base_url
    assert parts.path == "/mcp"
    assert parse_qs(parts.query) == {"testId": [request.node.nodeid]}
    _load_scoped(aimock, tmp_path, request.node.nodeid)

    # The URL alone (no headers) carries the identity.
    answer = _call_tool(target.mcp_url, {}, "lookup", {"q": "a"})
    assert not answer["result"].get("isError"), answer
    assert _text(answer["result"]) == "A"

    report = aimock.fakes_report()
    assert report["testId"] == request.node.nodeid
    assert report["context"] is None
    assert [s["entryId"] for s in report["served"]] == ["control-api#1:lookup-a"]
    assert [u["entryId"] for u in report["unconsumed"]] == [
        "control-api#1:never-called"
    ]


def test_headers_alone_carry_the_default_id(aimock, request, tmp_path):
    """TI3: ``headers`` on the bare mount URL select the same scoped fake."""
    target = aimock.fakes_for()
    assert target.headers == {"X-Test-Id": _pct(request.node.nodeid)}
    _load_scoped(aimock, tmp_path, request.node.nodeid)

    answer = _call_tool(f"{aimock.base_url}/mcp", target.headers, "lookup", {"q": "a"})
    assert _text(answer["result"]) == "A"
    served = aimock.fakes_report()["served"]
    assert [s["entryId"] for s in served] == ["control-api#1:lookup-a"]


def test_unused_entry_fails_the_report(aimock, request, tmp_path):
    """RP8: an unused entry makes ``ok`` false and ``assert_fakes_report`` raise."""
    nodeid = request.node.nodeid
    _load_scoped(aimock, tmp_path, nodeid)
    target = aimock.fakes_for()
    _call_tool(target.mcp_url, {}, "lookup", {"q": "a"})

    report = aimock.fakes_report()
    assert report["ok"] is False
    expected = "\n".join(
        [
            f"aimock MCP fakes report failed (testId {json.dumps(nodeid, ensure_ascii=False)}):",
            "  unconsumed: control-api#1:never-called (/mcp lookup)",
        ]
    )
    with pytest.raises(AssertionError) as info:
        aimock.assert_fakes_report(report)
    assert str(info.value) == expected
    assert "unconsumed: control-api#1:never-called" in str(info.value)

    # With no report given, it reads the report for the default id itself.
    with pytest.raises(AssertionError) as info2:
        aimock.assert_fakes_report()
    assert str(info2.value) == expected

    # Consuming the last entry makes the report pass.
    _call_tool(target.mcp_url, {}, "lookup", {"q": "z"})
    report = aimock.fakes_report()
    assert report["ok"] is True
    aimock.assert_fakes_report(report)
    aimock.assert_fakes_report()


def test_call_without_arguments_fails_the_report(aimock, request, tmp_path):
    """RP8: a ``tools/call`` with no ``arguments`` gives a failure row with no
    ``args`` key, and ``assert_fakes_report`` still raises ``AssertionError``
    with aimock's message for it (``with undefined``), not ``KeyError``."""
    nodeid = request.node.nodeid
    _load_scoped(aimock, tmp_path, nodeid)
    target = aimock.fakes_for()
    _call_tool(target.mcp_url, {}, "lookup", None)

    report = aimock.fakes_report()
    assert report["ok"] is False
    assert [f["tool"] for f in report["failures"]] == ["lookup"]
    assert "args" not in report["failures"][0]

    with pytest.raises(AssertionError) as info:
        aimock.assert_fakes_report(report)
    code = report["failures"][0]["code"]
    assert str(info.value) == "\n".join(
        [
            f"aimock MCP fakes report failed (testId {json.dumps(nodeid, ensure_ascii=False)}):",
            f"  failure {code}: tools/call lookup on /mcp with undefined",
            "  unconsumed: control-api#1:lookup-a (/mcp lookup)",
            "  unconsumed: control-api#1:never-called (/mcp lookup)",
        ]
    )
    ts = _ts_message(report, False)
    if ts is not None:
        assert str(info.value) == ts


def test_session_fixture_has_no_default_id(aimock_session):
    """TI3: ``aimock_session`` has no current test, so an id must be explicit."""
    with pytest.raises(ValueError, match="explicit test_id"):
        aimock_session.fakes_for()
    with pytest.raises(ValueError, match="explicit test_id"):
        aimock_session.fakes_report()
    with pytest.raises(ValueError, match="explicit test_id"):
        aimock_session.assert_fakes_report()

    target = aimock_session.fakes_for(test_id="session › explicit")
    assert target.test_id == "session › explicit"
    assert (
        aimock_session.fakes_report(test_id="session › explicit")["testId"]
        == "session › explicit"
    )


def test_explicit_test_id_wins(aimock, request, tmp_path):
    """TI4: an explicit id wins over the default, for the URL, headers and report."""
    explicit = "weather › seattle & co"
    _load_scoped(aimock, tmp_path, explicit)
    target = aimock.fakes_for(test_id=explicit, context="ctx one")
    assert target.test_id == explicit
    assert explicit != request.node.nodeid
    assert parse_qs(urlsplit(target.mcp_url).query) == {
        "testId": [explicit],
        "context": ["ctx one"],
    }
    assert target.headers == {
        "X-Test-Id": _pct(explicit),
        "X-AIMock-Context": _pct("ctx one"),
    }

    # The fixture is scoped to the explicit id only (no context in the scope),
    # so a contextless target is used to call it.
    plain = aimock.fakes_for(test_id=explicit)
    answer = _call_tool(plain.mcp_url, {}, "lookup", {"q": "a"})
    assert _text(answer["result"]) == "A"

    report = aimock.fakes_report(test_id=explicit)
    assert report["testId"] == explicit
    assert [s["entryId"] for s in report["served"]] == ["control-api#1:lookup-a"]
    with_ctx = aimock.fakes_report(test_id=explicit, context="ctx one")
    assert with_ctx["context"] == "ctx one"
    # The default id saw none of this.
    assert aimock.fakes_report()["served"] == []


def test_fakes_target_is_exported_from_the_package(aimock):
    """RP8: ``FakesTarget`` is public: users can import it from ``aimock_pytest``."""
    import aimock_pytest
    from aimock_pytest import FakesTarget

    assert "FakesTarget" in aimock_pytest.__all__
    assert isinstance(aimock.fakes_for(test_id="t"), FakesTarget)


def test_mount_argument_sets_the_url_path(aimock):
    """RP8: ``mount`` picks the MCP mount path in the returned URL."""
    target = aimock.fakes_for(test_id="t", mount="/tools")
    assert urlsplit(target.mcp_url).path == "/tools"


SYNTHETIC_REPORT: dict[str, Any] = {
    "testId": 'a › b "q" é',
    "context": "ctx ✓",
    "ok": False,
    "evicted": True,
    "served": [],
    "unconsumed": [
        {"entryId": "f.json:one", "mount": "/mcp", "tool": "t1", "args": {"a": 1}},
        {"entryId": "f.json:two", "mount": "/mcp2", "tool": "t2", "args": {}},
    ],
    "unfaked": [
        {"mount": "/mcp", "tool": "real", "args": {}, "answeredBy": "handler"},
    ],
    "failures": [
        {
            "code": "MCP_FAKE_MISMATCH",
            "mount": "/mcp",
            "tool": "t1",
            "args": {"a": [1, "x", None], "é": True},
        },
        {
            "code": "MCP_FAKE_NOT_DECLARED",
            "mount": "/mcp2",
            "tool": "nope",
            "args": None,
        },
    ],
    "sharedUnconsumed": [],
}


def _ts_message(report: dict[str, Any], fail_on_unfaked: bool) -> str | None:
    """The message aimock's ``assertFakesReport`` throws for ``report``.

    It is read from the built aimock next to ``AIMOCK_CLI_PATH``; ``None``
    when that build is not available (the npm-download path).
    """
    cli = os.environ.get("AIMOCK_CLI_PATH")
    if not cli:
        return None
    module = Path(cli).resolve().parent / "mcp-fakes-report.js"
    if not module.is_file():
        return None
    script = (
        f"import {{ assertFakesReport }} from {json.dumps(module.as_uri())};"
        "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{"
        "const {report,failOnUnfaked}=JSON.parse(s);"
        "try{assertFakesReport(report,{failOnUnfaked});process.stdout.write('NO THROW');}"
        "catch(e){process.stdout.write(e.message);}});"
    )
    out = subprocess.run(
        [NodeManager().find_node(), "--input-type=module", "-e", script],
        input=json.dumps({"report": report, "failOnUnfaked": fail_on_unfaked}),
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=30,
        check=False,
    )
    assert out.returncode == 0, out.stderr
    return out.stdout


@pytest.mark.parametrize("fail_on_unfaked", [False, True])
def test_message_matches_format_fakes_report(aimock, fail_on_unfaked):
    """RP8: the ``AssertionError`` text is aimock's report message, line for line."""
    with pytest.raises(AssertionError) as info:
        aimock.assert_fakes_report(SYNTHETIC_REPORT, fail_on_unfaked=fail_on_unfaked)
    lines = [
        'aimock MCP fakes report failed (testId "a › b \\"q\\" é", context "ctx ✓"):',
        '  failure MCP_FAKE_MISMATCH: tools/call t1 on /mcp with {"a":[1,"x",null],"é":true}',
        "  failure MCP_FAKE_NOT_DECLARED: tools/call nope on /mcp2 with null",
        "  unconsumed: f.json:one (/mcp t1)",
        "  unconsumed: f.json:two (/mcp2 t2)",
        (
            "  evicted: this test id's fake state was evicted by the per-mount test-id cap,"
            " or its event log overflowed (1000 events); the report is incomplete"
        ),
    ]
    if fail_on_unfaked:
        lines.append("  unfaked: tools/call real on /mcp answered by handler")
    assert str(info.value) == "\n".join(lines)

    ts = _ts_message(SYNTHETIC_REPORT, fail_on_unfaked)
    if ts is not None:
        assert str(info.value) == ts


def test_unfaked_fails_only_with_fail_on_unfaked(aimock):
    """RP8: an ``ok`` report with unfaked calls passes unless ``fail_on_unfaked``."""
    report = {
        "testId": None,
        "context": None,
        "ok": True,
        "evicted": False,
        "served": [],
        "unconsumed": [],
        "unfaked": [
            {"mount": "/mcp", "tool": "real", "args": {}, "answeredBy": "config"}
        ],
        "failures": [],
        "sharedUnconsumed": [],
    }
    aimock.assert_fakes_report(report)
    with pytest.raises(AssertionError) as info:
        aimock.assert_fakes_report(report, fail_on_unfaked=True)
    assert str(info.value) == (
        "aimock MCP fakes report failed (no test id):\n"
        "  unfaked: tools/call real on /mcp answered by config"
    )
    ts = _ts_message(report, True)
    if ts is not None:
        assert str(info.value) == ts
