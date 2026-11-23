"""Official Anthropic Python SDK proof against the explicit local CLI build."""

import json

import pytest
from anthropic import Anthropic, APIStatusError

from misbehavior_helpers import add_tool_fixture, misbehavior_server, tool_response, tool_schema


@pytest.fixture
def aimock(request, _aimock_node_manager):
    yield from misbehavior_server(request, _aimock_node_manager)


SHAPES = ["tool", "mixed", "blocks"]
STYLES = ["truncated", "trailing-comma", "single-quotes"]
VIOLATIONS = ["missing-required", "wrong-type", "extra-property", "enum-mismatch", "not-object"]
ORIGINAL_INPUT = {"city": "Paris", "units": "metric"}
ORIGINAL_JSON = json.dumps(ORIGINAL_INPUT, separators=(",", ":"))
K1_ARGUMENTS = {
    "truncated": '{"city":"Paris",',
    "trailing-comma": '{"city":"Paris","units":"metric",}',
    "single-quotes": "{'city':'Paris','units':'metric'}",
}


def request_options():
    schema = tool_schema()
    schema["properties"]["city"]["enum"] = ["Paris"]
    return {
        "model": "claude-sonnet-4-20250514",
        "max_tokens": 128,
        "messages": [{"role": "user", "content": "lookup"}],
        "tools": [{"name": "lookup", "input_schema": schema}],
    }


def read_message(client, streaming):
    """Keep native SDK events and reconstruct tool strings by block index."""
    if not streaming:
        message = client.messages.create(**request_options())
        body = message.model_dump()
        calls = [block for block in body["content"] if block["type"] == "tool_use"]
        return {
            "body": body,
            "events": [],
            "blocks": body["content"],
            "calls": calls,
            "arguments": [json.dumps(call["input"], separators=(",", ":")) for call in calls],
            "stop": body["stop_reason"],
            "details": body.get("stop_details"),
        }
    with client.messages.create(**request_options(), stream=True) as stream:
        events = [event.model_dump() for event in stream]
    starts = [event for event in events if event["type"] == "content_block_start"]
    tool_starts = [event for event in starts if event["content_block"]["type"] == "tool_use"]
    terminal = next(event for event in events if event["type"] == "message_delta")
    assert events[-1]["type"] == "message_stop"
    return {
        "body": None,
        "events": events,
        "blocks": [event["content_block"] for event in starts],
        "calls": [event["content_block"] for event in tool_starts],
        "arguments": [
            "".join(
                event["delta"]["partial_json"]
                for event in events
                if event["type"] == "content_block_delta"
                and event["index"] == start["index"]
                and event["delta"]["type"] == "input_json_delta"
            )
            for start in tool_starts
        ],
        "stop": terminal["delta"]["stop_reason"],
        "details": terminal["delta"].get("stop_details"),
    }


def observe(aimock, streaming):
    with Anthropic(base_url=aimock.url, api_key="local", max_retries=0, timeout=5) as client:
        result = read_message(client, streaming)
    journal = aimock.get_journal()
    print(json.dumps({"stream": streaming, "result": result, "journal": journal}))
    assert len(journal) == 1
    assert journal[0]["response"]["status"] == 200
    return result, journal[0]["response"].get("misbehavior")


def assert_applied(summary, fault):
    assert summary is not None
    assert summary["applied"] is True
    assert summary["fault"] == fault
    assert summary["wire"] == "anthropic"
    assert summary["source"] == "fixture"
    assert summary["evaluations"] == [
        {"entryIndex": 0, "fault": fault, "outcome": "applied", "ordinal": 0}
    ]


def assert_served_calls(result, summary):
    assert summary["servedToolCalls"] == [
        {"name": call["name"], "id": call["id"], "arguments": arguments}
        for call, arguments in zip(result["calls"], result["arguments"], strict=True)
    ]


@pytest.mark.parametrize("shape", SHAPES)
@pytest.mark.parametrize("streaming", [False, True])
def test_no_fault_control(aimock, shape, streaming):
    add_tool_fixture(aimock, shape=shape)
    result, summary = observe(aimock, streaming)
    assert result["stop"] == "tool_use"
    assert [call["name"] for call in result["calls"]] == ["lookup"]
    assert [json.loads(value) for value in result["arguments"]] == [ORIGINAL_INPUT]
    assert summary is None
    assert [block["type"] for block in result["blocks"]] == (
        ["tool_use"] if shape == "tool" else ["text", "tool_use"]
    )


@pytest.mark.parametrize("shape", SHAPES)
def test_no_fault_high_level_control(aimock, shape):
    add_tool_fixture(aimock, shape=shape)
    with Anthropic(base_url=aimock.url, api_key="local", max_retries=0, timeout=5) as client:
        with client.messages.stream(**request_options()) as stream:
            final = stream.get_final_message()
    journal = aimock.get_journal()
    print(json.dumps({"final": final.model_dump(), "journal": journal}))
    assert final.stop_reason == "tool_use"
    calls = [block for block in final.content if block.type == "tool_use"]
    assert len(calls) == 1
    assert calls[0].input == ORIGINAL_INPUT
    assert len(journal) == 1
    assert journal[0]["response"].get("misbehavior") is None


@pytest.mark.parametrize("shape", SHAPES)
@pytest.mark.parametrize("style", STYLES)
def test_k1_raw_stream(aimock, shape, style):
    response = tool_response(shape=shape)
    tool = response["blocks"][-1] if shape == "blocks" else response["toolCalls"][0]
    del tool["id"]  # Exercise native generated IDs, then compare wire and journal identity.
    aimock.add_fixture(
        {"userMessage": "lookup"}, response,
        misbehavior={"faults": [{"fault": "tool-args-invalid-json", "style": style}]},
    )
    result, summary = observe(aimock, True)
    assert len(result["calls"]) == 1
    assert result["calls"][0]["id"]
    assert result["arguments"] == [K1_ARGUMENTS[style]]
    assert result["stop"] == "tool_use"
    with pytest.raises(json.JSONDecodeError):
        json.loads(result["arguments"][0])
    assert_applied(summary, "tool-args-invalid-json")
    assert_served_calls(result, summary)


@pytest.mark.parametrize("shape", SHAPES)
@pytest.mark.parametrize("style", STYLES)
def test_k1_high_level_accumulation(aimock, shape, style):
    add_tool_fixture(aimock, shape=shape, fault={"faults": [{"fault": "tool-args-invalid-json", "style": style}]})
    final = None
    error = None
    with Anthropic(base_url=aimock.url, api_key="local", max_retries=0, timeout=5) as client:
        try:
            with client.messages.stream(**request_options()) as stream:
                final = stream.get_final_message()
        except ValueError as caught:
            error = caught
    journal = aimock.get_journal()
    print(json.dumps({"style": style, "final": final.model_dump() if final else None, "error": str(error), "journal": journal}))
    if style == "truncated":
        assert error is None
        assert final is not None
        assert final.stop_reason == "tool_use"
        calls = [block for block in final.content if block.type == "tool_use"]
        assert len(calls) == 1
        assert calls[0].input == {"city": "Paris"}
    else:
        assert isinstance(error, ValueError)
        assert "Unable to parse tool parameter JSON" in str(error)
        assert ("trailing comma" if style == "trailing-comma" else "key must be a string") in str(error)
        assert final is None
    assert len(journal) == 1
    assert journal[0]["response"]["status"] == 200
    assert_applied(journal[0]["response"]["misbehavior"], "tool-args-invalid-json")


@pytest.mark.parametrize("shape", SHAPES)
@pytest.mark.parametrize("streaming,violation", [(streaming, violation) for streaming in [False, True] for violation in VIOLATIONS if streaming or violation != "not-object"])
def test_k2_schema_values(aimock, shape, streaming, violation):
    fault = {"fault": "tool-args-schema-violation", "violation": violation}
    add_tool_fixture(aimock, shape=shape, fault={"faults": [fault]})
    result, summary = observe(aimock, streaming)
    assert len(result["calls"]) == 1
    value = json.loads(result["arguments"][0])
    if violation == "missing-required":
        assert "city" not in value
    elif violation == "wrong-type":
        assert not isinstance(value["city"], str)
    elif violation == "extra-property":
        assert set(value) - set(ORIGINAL_INPUT)
    elif violation == "enum-mismatch":
        assert value["city"] != "Paris"
    else:
        assert not isinstance(value, dict)
    assert result["stop"] == "tool_use"
    assert_applied(summary, "tool-args-schema-violation")
    assert_served_calls(result, summary)


@pytest.mark.parametrize("shape", SHAPES)
@pytest.mark.parametrize("streaming", [False, True])
def test_k3_unknown_name(aimock, shape, streaming):
    add_tool_fixture(aimock, shape=shape, fault={"faults": [{"fault": "tool-unknown-name", "name": "undeclared_lookup"}]})
    result, summary = observe(aimock, streaming)
    assert [call["name"] for call in result["calls"]] == ["undeclared_lookup"]
    assert [json.loads(value) for value in result["arguments"]] == [ORIGINAL_INPUT]
    assert_applied(summary, "tool-unknown-name")
    assert_served_calls(result, summary)


@pytest.mark.parametrize("shape", SHAPES)
@pytest.mark.parametrize("streaming", [False, True])
@pytest.mark.parametrize("selector", ["single", "non-first"])
def test_k4_duplicate_ids(aimock, shape, streaming, selector):
    response = tool_response(shape=shape)
    fault = {"fault": "tool-call-id-duplicate"}
    if selector == "non-first":
        second = {"name": "second", "id": "call_second", "arguments": {"city": "Rome"}}
        if shape == "blocks":
            response["blocks"].append({"type": "toolCall", **second})
        else:
            response["toolCalls"].append(second)
        fault["tool"] = "second"
    aimock.add_fixture({"userMessage": "lookup"}, response, misbehavior={"faults": [fault]})
    result, summary = observe(aimock, streaming)
    assert len(result["calls"]) == 2
    first, second = result["calls"]
    assert first["id"] == second["id"] == ("call_lookup" if selector == "single" else "call_second")
    assert [call["name"] for call in result["calls"]] == (["lookup", "lookup"] if selector == "single" else ["lookup", "second"])
    assert_applied(summary, "tool-call-id-duplicate")
    assert_served_calls(result, summary)


@pytest.mark.parametrize("shape", SHAPES)
@pytest.mark.parametrize("streaming", [False, True])
def test_k5_raw_length(aimock, shape, streaming):
    add_tool_fixture(aimock, shape=shape, fault={"faults": [{"fault": "stop-length-mid-tool", "at": 0.8}]})
    result, summary = observe(aimock, streaming)
    assert result["stop"] == "max_tokens"
    assert len(result["calls"]) == 1
    if streaming:
        arguments = result["arguments"][0]
        assert 0 < len(arguments) < len(ORIGINAL_JSON)
        assert ORIGINAL_JSON.startswith(arguments)
        with pytest.raises(json.JSONDecodeError):
            json.loads(arguments)
        tool_index = next(event["index"] for event in result["events"] if event["type"] == "content_block_start" and event["content_block"]["type"] == "tool_use")
        assert not any(event["type"] == "content_block_stop" and event["index"] == tool_index for event in result["events"])
    else:
        assert result["calls"][0]["input"] == {}
    assert_applied(summary, "stop-length-mid-tool")
    assert_served_calls(result, summary)


@pytest.mark.parametrize("shape", SHAPES)
def test_k5_high_level_partial_input(aimock, shape):
    add_tool_fixture(aimock, shape=shape, fault={"faults": [{"fault": "stop-length-mid-tool", "at": 0.8}]})
    with Anthropic(base_url=aimock.url, api_key="local", max_retries=0, timeout=5) as client:
        with client.messages.stream(**request_options()) as stream:
            final = stream.get_final_message()
    journal = aimock.get_journal()
    print(json.dumps({"final": final.model_dump(), "journal": journal}))
    assert final.stop_reason == "max_tokens"
    calls = [block for block in final.content if block.type == "tool_use"]
    assert len(calls) == 1
    assert calls[0].input == {"city": "Paris"}
    assert len(journal) == 1
    summary = journal[0]["response"]["misbehavior"]
    assert_applied(summary, "stop-length-mid-tool")
    assert summary["servedToolCalls"][0]["id"] == calls[0].id
    assert ORIGINAL_JSON.startswith(summary["servedToolCalls"][0]["arguments"])


@pytest.mark.parametrize("shape", SHAPES)
@pytest.mark.parametrize("streaming", [False, True])
@pytest.mark.parametrize("fault", ["empty-response", "refusal"])
def test_k6_k7_terminal(aimock, shape, streaming, fault):
    selected = {"fault": fault}
    if fault == "refusal":
        selected.update(message="No.", category="policy")
    add_tool_fixture(aimock, shape=shape, fault={"faults": [selected]})
    result, summary = observe(aimock, streaming)
    assert result["blocks"] == []
    assert result["calls"] == []
    assert result["stop"] == ("refusal" if fault == "refusal" else "end_turn")
    if fault == "refusal":
        assert result["details"] == {"type": "refusal", "category": "policy", "explanation": "No."}
    assert_applied(summary, fault)
    assert summary["servedToolCalls"] == []


@pytest.mark.parametrize("streaming,fault", [(False, {"fault": "tool-args-invalid-json"}), (False, {"fault": "tool-args-schema-violation", "violation": "not-object"}), (False, {"fault": "content-filter"}), (True, {"fault": "content-filter"})])
def test_permanently_unsupported(aimock, streaming, fault):
    # Header selects the actual wire/mode, avoiding an earlier fixture-load rejection.
    add_tool_fixture(aimock)
    value = fault["fault"]
    if "violation" in fault:
        value += "; violation=" + fault["violation"]
    with Anthropic(base_url=aimock.url, api_key="local", max_retries=0, timeout=5) as client:
        with pytest.raises(APIStatusError) as caught:
            client.messages.create(**request_options(), stream=streaming, extra_headers={"X-AIMock-Misbehavior": value})
    print(json.dumps({"fault": fault, "status": caught.value.status_code, "body": caught.value.body, "journal": aimock.get_journal()}))
    assert caught.value.status_code == 501
    assert "aimock_misbehavior_unsupported" in json.dumps(caught.value.body)


@pytest.mark.parametrize("shape", SHAPES)
@pytest.mark.parametrize("streaming", [False, True])
def test_k9_thinking_only_pending_provider_implementation(aimock, shape, streaming):
    """Required cell remains a real failing test until the provider implements K9."""
    add_tool_fixture(aimock, shape=shape, fault={"faults": [{"fault": "reasoning-only", "reasoning": "Thinking only."}]})
    result, summary = observe(aimock, streaming)
    assert result["stop"] == "max_tokens"
    assert [block["type"] for block in result["blocks"]] == ["thinking"]
    assert result["calls"] == []
    if streaming:
        thinking = "".join(event["delta"]["thinking"] for event in result["events"] if event["type"] == "content_block_delta" and event["delta"]["type"] == "thinking_delta")
    else:
        thinking = result["blocks"][0]["thinking"]
    assert thinking == "Thinking only."
    assert_applied(summary, "reasoning-only")
    assert summary["servedToolCalls"] == []
