"""Official OpenAI SDK proof against an explicitly selected local aimock CLI."""

import json

import pytest
from openai import ContentFilterFinishReasonError, LengthFinishReasonError, OpenAI

from misbehavior_helpers import add_tool_fixture, misbehavior_server, tool_response, tool_schema


@pytest.fixture
def aimock(request, _aimock_node_manager):
    yield from misbehavior_server(request, _aimock_node_manager)


MESSAGES = [{"role": "user", "content": "lookup"}]
CANONICAL = '{"city":"Paris","units":"metric"}'


def tools(schema=None):
    return [{"type": "function", "function": {
        "name": "lookup", "strict": True,
        "parameters": tool_schema() if schema is None else schema,
    }}]


def observe(client, stream, *, schema=None, model="gpt-4o"):
    """Read real SDK objects; no fixture emulation or fault interpretation."""
    params = {"model": model, "messages": MESSAGES, "tools": tools(schema)}
    if not stream:
        completion = client.chat.completions.create(**params)
        print(json.dumps({"mode": "create", "response": completion.model_dump()}))
        choice = completion.choices[0]
        message = choice.message.model_dump()
        return {
            "calls": [{"id": call.id, "name": call.function.name,
                       "arguments": call.function.arguments}
                      for call in choice.message.tool_calls or []],
            "content": choice.message.content,
            "refusal": choice.message.refusal or "",
            "reasoning": message.get("reasoning", "") or "",
            "message": message,
            "finish": choice.finish_reason,
            "usage": completion.usage.model_dump(),
        }
    calls = {}
    content = None
    refusal = ""
    reasoning = ""
    finish = None
    usage = None
    frames = []
    with client.chat.completions.create(
        **params, stream=True, stream_options={"include_usage": True},
    ) as response:
        for chunk in response:
            frame = chunk.model_dump()
            frames.append(frame)
            if chunk.usage is not None:
                usage = chunk.usage.model_dump()
            for choice in chunk.choices:
                delta = choice.delta.model_dump()
                if choice.delta.content is not None:
                    content = (content or "") + choice.delta.content
                refusal += choice.delta.refusal or ""
                reasoning += delta.get("reasoning", "") or ""
                if choice.finish_reason is not None:
                    finish = choice.finish_reason
                for part in choice.delta.tool_calls or []:
                    call = calls.setdefault(part.index, {"id": "", "name": "", "arguments": ""})
                    call["id"] += part.id or ""
                    if part.function is not None:
                        call["name"] += part.function.name or ""
                        call["arguments"] += part.function.arguments or ""
    print(json.dumps({"mode": "stream", "frames": frames}))
    assert frames[-1]["choices"] == []
    assert usage is not None
    return {"calls": [calls[index] for index in sorted(calls)], "content": content,
            "refusal": refusal, "reasoning": reasoning, "frames": frames,
            "finish": finish, "usage": usage}


def journal_output(aimock, observed, fault):
    entries = aimock.get_journal()
    print(json.dumps({"journal": entries}))
    assert len(entries) == 1
    assert entries[0]["response"]["status"] == 200
    summary = entries[0]["response"]["misbehavior"]
    assert summary["applied"] is True
    assert summary["fault"] == fault
    assert summary["wire"] == "openai-chat"
    assert summary["servedToolCalls"] == observed["calls"]
    return summary


@pytest.mark.parametrize("stream", [False, True])
@pytest.mark.parametrize("shape", ["tool", "blocks"])
@pytest.mark.parametrize("style", ["truncated", "trailing-comma", "single-quotes"])
def test_k1_raw_invalid_arguments(aimock, stream, shape, style):
    add_tool_fixture(aimock, fault={"faults": [{"fault": "tool-args-invalid-json", "style": style}]}, shape=shape)
    expected = {"truncated": CANONICAL[:len(CANONICAL) // 2],
                "trailing-comma": CANONICAL[:-1] + ",}",
                "single-quotes": CANONICAL.replace('"', "'")}[style]
    with OpenAI(base_url=aimock.url + "/v1", api_key="local", max_retries=0, timeout=5) as client:
        result = observe(client, stream)
    assert result["calls"] == [{"id": "call_lookup", "name": "lookup", "arguments": expected}]
    assert result["finish"] == "tool_calls"
    with pytest.raises(json.JSONDecodeError):
        json.loads(result["calls"][0]["arguments"])
    journal_output(aimock, result, "tool-args-invalid-json")


@pytest.mark.parametrize("high_stream", [False, True])
@pytest.mark.parametrize("style", ["truncated", "trailing-comma", "single-quotes"])
def test_k1_strict_parser_reaction(aimock, high_stream, style):
    add_tool_fixture(aimock, fault={"faults": [{"fault": "tool-args-invalid-json", "style": style}]})
    with OpenAI(base_url=aimock.url + "/v1", api_key="local", max_retries=0, timeout=5) as client:
        expected_exception = ValueError if high_stream and style != "truncated" else json.JSONDecodeError
        with pytest.raises(expected_exception) as raised:
            if high_stream:
                with client.chat.completions.stream(model="gpt-4o", messages=MESSAGES, tools=tools()) as response:
                    response.get_final_completion()
            else:
                client.chat.completions.parse(model="gpt-4o", messages=MESSAGES, tools=tools())
        assert type(raised.value) is expected_exception
        print(json.dumps({"style": style, "high_stream": high_stream,
                          "exception": type(raised.value).__name__, "message": str(raised.value)}))
    entries = aimock.get_journal()
    print(json.dumps({"journal": entries}))
    assert len(entries) == 1
    call = entries[0]["response"]["misbehavior"]["servedToolCalls"][0]
    with pytest.raises(json.JSONDecodeError):
        json.loads(call["arguments"])


@pytest.mark.parametrize("stream", [False, True])
@pytest.mark.parametrize("shape", ["tool", "blocks"])
@pytest.mark.parametrize("violation", ["missing-required", "wrong-type", "extra-property", "enum-mismatch", "not-object"])
def test_k2_schema_violation(aimock, stream, shape, violation):
    schema = tool_schema()
    schema["properties"]["city"]["enum"] = ["Paris", "Rome"]
    fault = {"fault": "tool-args-schema-violation", "violation": violation}
    if violation in ["missing-required", "wrong-type", "enum-mismatch"]:
        fault["property"] = "city"
    add_tool_fixture(aimock, fault={"faults": [fault]}, shape=shape)
    with OpenAI(base_url=aimock.url + "/v1", api_key="local", max_retries=0, timeout=5) as client:
        result = observe(client, stream, schema=schema)
    value = json.loads(result["calls"][0]["arguments"])
    if violation == "missing-required":
        assert "city" not in value
    elif violation == "wrong-type":
        assert isinstance(value["city"], (int, float)) and not isinstance(value["city"], bool)
    elif violation == "extra-property":
        assert value["__aimock_extra"] is True
    elif violation == "enum-mismatch":
        assert value["city"] not in ["Paris", "Rome"]
    else:
        assert isinstance(value, str)
    assert result["finish"] == "tool_calls"
    journal_output(aimock, result, "tool-args-schema-violation")


@pytest.mark.parametrize("stream", [False, True])
@pytest.mark.parametrize("shape", ["tool", "blocks"])
def test_k3_chosen_undeclared_name(aimock, stream, shape):
    add_tool_fixture(aimock, fault={"faults": [{"fault": "tool-unknown-name", "name": "undeclared_lookup"}]}, shape=shape)
    with OpenAI(base_url=aimock.url + "/v1", api_key="local", max_retries=0, timeout=5) as client:
        result = observe(client, stream)
    assert [call["name"] for call in result["calls"]] == ["undeclared_lookup"]
    assert result["calls"][0]["arguments"] == CANONICAL
    journal_output(aimock, result, "tool-unknown-name")


@pytest.mark.parametrize("stream", [False, True])
@pytest.mark.parametrize("shape", ["tool", "blocks"])
@pytest.mark.parametrize("selection", ["single", "nonfirst"])
def test_k4_duplicate_identity(aimock, stream, shape, selection):
    response = tool_response(shape=shape)
    if selection == "nonfirst":
        second = {"name": "second", "id": "call_second", "arguments": {"value": 2}}
        third = {"name": "third", "id": "call_third", "arguments": {"value": 3}}
        if shape == "blocks":
            response["blocks"].extend([{"type": "toolCall", **second}, {"type": "toolCall", **third}])
        else:
            response["toolCalls"].extend([second, third])
    original = json.loads(json.dumps(response))
    fault = {"fault": "tool-call-id-duplicate"}
    if selection == "nonfirst":
        fault["tool"] = "second"
    aimock.add_fixture({"userMessage": "lookup"}, response, misbehavior={"faults": [fault]})
    with OpenAI(base_url=aimock.url + "/v1", api_key="local", max_retries=0, timeout=5) as client:
        result = observe(client, stream)
    calls = result["calls"]
    if selection == "single":
        assert len(calls) == 2 and calls[0] == calls[1]
    else:
        assert [call["name"] for call in calls] == ["lookup", "second", "third"]
        assert [call["arguments"] for call in calls] == [CANONICAL, '{"value":2}', '{"value":3}']
        assert calls[0]["id"] == "call_lookup"
        assert calls[1]["id"] == calls[2]["id"] == "call_second"
    assert calls[-1]["id"]
    assert response == original
    journal_output(aimock, result, "tool-call-id-duplicate")


@pytest.mark.parametrize("stream", [False, True])
@pytest.mark.parametrize("shape", ["tool", "blocks"])
def test_k5_raw_length_cut(aimock, stream, shape):
    add_tool_fixture(aimock, fault="stop-length-mid-tool", shape=shape)
    with OpenAI(base_url=aimock.url + "/v1", api_key="local", max_retries=0, timeout=5) as client:
        result = observe(client, stream)
    assert result["finish"] == "length"
    assert result["calls"][0]["arguments"] == CANONICAL[:len(CANONICAL) // 2]
    journal_output(aimock, result, "stop-length-mid-tool")


@pytest.mark.parametrize("high_stream", [False, True])
@pytest.mark.parametrize("fault,error", [("stop-length-mid-tool", LengthFinishReasonError), ("content-filter", ContentFilterFinishReasonError)])
def test_native_strict_terminal_errors(aimock, high_stream, fault, error):
    add_tool_fixture(aimock, fault=fault)
    with OpenAI(base_url=aimock.url + "/v1", api_key="local", max_retries=0, timeout=5) as client:
        with pytest.raises(error) as raised:
            if high_stream:
                with client.chat.completions.stream(model="gpt-4o", messages=MESSAGES, tools=tools()) as response:
                    response.get_final_completion()
            else:
                client.chat.completions.parse(model="gpt-4o", messages=MESSAGES, tools=tools())
        print(json.dumps({"fault": fault, "high_stream": high_stream, "exception": type(raised.value).__name__}))
    print(json.dumps({"journal": aimock.get_journal()}))
    assert len(aimock.get_journal()) == 1


@pytest.mark.parametrize("stream", [False, True])
@pytest.mark.parametrize("shape", ["tool", "blocks"])
@pytest.mark.parametrize("fault,finish", [("empty-response", "stop"), ("refusal", "stop"), ("content-filter", "content_filter")])
def test_k6_k7_k8_replacement(aimock, stream, shape, fault, finish):
    add_tool_fixture(aimock, fault=fault, shape=shape)
    with OpenAI(base_url=aimock.url + "/v1", api_key="local", max_retries=0, timeout=5) as client:
        result = observe(client, stream)
    assert result["calls"] == []
    assert result["content"] in [None, ""]
    assert result["reasoning"] == ""
    assert result["finish"] == finish
    assert result["refusal"] == ("I can't help with that." if fault == "refusal" else "")
    journal_output(aimock, result, fault)


@pytest.mark.parametrize("high_stream", [False, True])
@pytest.mark.parametrize("fault", [None, "refusal"])
def test_strict_control_and_refusal(aimock, high_stream, fault):
    add_tool_fixture(aimock, fault=fault)
    with OpenAI(base_url=aimock.url + "/v1", api_key="local", max_retries=0, timeout=5) as client:
        if high_stream:
            with client.chat.completions.stream(model="gpt-4o", messages=MESSAGES, tools=tools()) as response:
                result = response.get_final_completion()
        else:
            result = client.chat.completions.parse(model="gpt-4o", messages=MESSAGES, tools=tools())
        print(json.dumps(result.model_dump()))
    message = result.choices[0].message
    if fault is None:
        assert message.tool_calls[0].function.parsed_arguments == {"city": "Paris", "units": "metric"}
    else:
        assert message.parsed is None and message.refusal == "I can't help with that."
        assert not message.tool_calls and message.content is None
    assert len(aimock.get_journal()) == 1


@pytest.mark.parametrize("stream", [False, True])
@pytest.mark.parametrize("shape", ["tool", "blocks"])
@pytest.mark.parametrize("exposed", [False, True])
def test_k9_provider_reasoning(aimock, stream, shape, exposed):
    reasoning = "Thinking through the lookup."
    add_tool_fixture(aimock, fault={"faults": [{"fault": "reasoning-only", "reasoning": reasoning}]}, shape=shape)
    path = "/api/v1" if exposed else "/v1"
    model = "deepseek/deepseek-r1" if exposed else "o3"
    with OpenAI(base_url=aimock.url + path, api_key="local", max_retries=0, timeout=5) as client:
        result = observe(client, stream, model=model)
    assert not result["calls"] and result["content"] in [None, ""]
    assert result["finish"] == "length"
    assert result["reasoning"] == (reasoning if exposed else "")
    payloads = ([frame["choices"][0]["delta"] for frame in result["frames"] if frame["choices"]]
                if stream else [result["message"]])
    for payload in payloads:
        assert "reasoning_content" not in payload
        if exposed and "reasoning" in payload:
            assert payload["reasoning_details"] == [{"type": "reasoning.text", "text": payload["reasoning"], "format": "unknown", "index": 0}]
        if not exposed:
            assert "reasoning" not in payload and "reasoning_details" not in payload
    completion = max(1, (len(reasoning) + 3) // 4) if exposed else 1
    assert result["usage"]["completion_tokens"] == completion
    journal_output(aimock, result, "reasoning-only")
