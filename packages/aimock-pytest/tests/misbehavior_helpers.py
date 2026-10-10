"""Shared real-server fixtures for the Python model-misbehavior SDK proofs.

These helpers only create fresh test inputs and use the public fixture API.
They do not emulate an LLM, interpret faults, or hide SDK response handling.
"""

from collections.abc import Iterator
from typing import Any, Literal

import pytest

from aimock_pytest import AIMockServer


def misbehavior_server(request: pytest.FixtureRequest, node_manager: Any) -> Iterator[AIMockServer]:
    """The plugin's function-scoped ``aimock`` server, started with the
    ``--misbehavior`` opt-in. Misbehavior is off by default (as in 1.44.0), so
    every misbehavior proof module overrides ``aimock`` with this."""
    server = AIMockServer(
        node_manager,
        port=0,
        api_key=request.config.getoption("--aimock-api-key"),
        enable_misbehavior=True,
    )
    server.start()
    server._default_test_id = request.node.nodeid
    yield server
    server.stop()


def tool_response(
    *,
    shape: Literal["tool", "mixed", "blocks"] = "tool",
    name: str = "lookup",
    call_id: str = "call_lookup",
) -> dict[str, Any]:
    """Return independent input dictionaries, including ordered-block coverage."""
    tool = {"id": call_id, "name": name, "arguments": {"city": "Paris", "units": "metric"}}
    if shape == "blocks":
        return {"blocks": [{"type": "text", "text": "Checking."}, {"type": "toolCall", **tool}]}
    response: dict[str, Any] = {"toolCalls": [tool]}
    if shape == "mixed":
        response["content"] = "Checking."
    return response


def tool_schema() -> dict[str, Any]:
    """Fresh direct schema usable by each SDK's native tool declaration."""
    return {
        "type": "object",
        "properties": {"city": {"type": "string"}, "units": {"type": "string"}},
        "required": ["city", "units"],
        "additionalProperties": False,
    }


def add_tool_fixture(
    server: AIMockServer,
    *,
    fault: str | dict[str, Any] | None = None,
    shape: Literal["tool", "mixed", "blocks"] = "tool",
    prompt: str = "lookup",
) -> None:
    """Register through the real control API; None is an unfaulted control."""
    options = {} if fault is None else {"misbehavior": fault}
    server.add_fixture({"userMessage": prompt}, tool_response(shape=shape), **options)
