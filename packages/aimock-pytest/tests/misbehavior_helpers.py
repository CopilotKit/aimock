"""Shared real-server fixtures for the Python model-misbehavior SDK proofs.

These helpers only create fresh test inputs and use the public fixture API.
They do not emulate an LLM, interpret faults, or hide SDK response handling.
"""

from typing import Any, Literal

from aimock_pytest import AIMockServer


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
