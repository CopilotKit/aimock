"""Existing Python controls preserve misbehavior through real local SDK calls."""

import json

import pytest
import requests
from openai import APIStatusError, OpenAI

from aimock_pytest import AIMockServer
from misbehavior_helpers import add_tool_fixture, tool_response


@pytest.fixture
def client(aimock):
    with OpenAI(
        base_url=aimock.url + "/v1", api_key="local", max_retries=0, timeout=5
    ) as sdk:
        yield sdk


def complete(client, headers=None):
    result = client.chat.completions.create(
        model="gpt-4o",
        messages=[{"role": "user", "content": "lookup"}],
        extra_headers=headers,
    )
    print("control SDK", result.model_dump_json())
    return result.choices[0]


def control(server, method, config=None, *, test_id=None, api_key=None):
    headers = {}
    if test_id is not None:
        headers["X-Test-Id"] = test_id
    if api_key is not None:
        headers["Authorization"] = f"Bearer {api_key}"
    response = requests.request(
        method,
        server.url + "/__aimock/misbehavior",
        headers=headers,
        json=config,
        timeout=5,
    )
    print("control HTTP", method, test_id, response.status_code, response.text)
    response.raise_for_status()
    return response.json()["misbehavior"]


@pytest.mark.parametrize("ingress", ["add_fixture", "on_message", "single", "array", "wrapper"])
def test_fixture_options_and_file_forms_reach_sdk_and_journal(aimock, client, tmp_path, ingress):
    fault = {"faults": [{"fault": "tool-unknown-name", "name": "unknown_lookup"}]}
    if ingress == "add_fixture":
        add_tool_fixture(aimock, fault=fault)
    elif ingress == "on_message":
        assert aimock.on_message("lookup", tool_response(), misbehavior=fault) is aimock
    else:
        entry = {
            "match": {"userMessage": "lookup"},
            "response": tool_response(),
            "misbehavior": fault,
        }
        if ingress == "single":
            payload = entry
        elif ingress == "array":
            payload = [entry]
        else:
            payload = {"fixtures": [entry]}
        path = tmp_path / "fixtures.json"
        path.write_text(json.dumps(payload), encoding="utf-8")
        assert aimock.load_fixtures(path) is aimock

    choice = complete(client)
    calls = choice.message.tool_calls
    assert choice.finish_reason == "tool_calls"
    assert len(calls) == 1
    assert calls[0].function.name == "unknown_lookup"
    assert json.loads(calls[0].function.arguments) == {"city": "Paris", "units": "metric"}
    journal = aimock.get_journal()
    print("ingress journal", ingress, json.dumps(journal))
    assert len(journal) == 1
    assert aimock.get_last_request() == journal[0]
    assert journal[0]["response"]["status"] == 200
    summary = journal[0]["response"]["misbehavior"]
    assert summary["applied"] is True
    assert summary["source"] == "fixture"
    assert summary["wire"] == "openai-chat"
    assert summary["evaluations"] == [
        {"entryIndex": 0, "fault": "tool-unknown-name", "outcome": "applied", "ordinal": 0}
    ]
    assert summary["servedToolCalls"] == [
        {
            "id": calls[0].id,
            "name": calls[0].function.name,
            "arguments": calls[0].function.arguments,
        }
    ]


def test_invalid_file_batch_keeps_existing_fixture_and_scope(aimock, client, tmp_path):
    add_tool_fixture(aimock)
    scope = {"faults": [{"fault": "empty-response"}]}
    assert control(aimock, "POST", scope, test_id="python-A") == scope
    path = tmp_path / "invalid.json"
    valid = {"match": {"userMessage": "new"}, "response": tool_response()}
    invalid = {**valid, "misbehavior": {"faults": [], "typo": True}}
    path.write_text(json.dumps({"fixtures": [valid, invalid]}), encoding="utf-8")
    with pytest.raises(requests.HTTPError) as caught:
        aimock.load_fixtures(path)
    response = caught.value.response
    assert response.status_code == 400
    assert response.json()["details"][0]["rule"] == "misbehavior/unknown-key"
    assert "fixtures[1].misbehavior.typo" in str(caught.value)
    print("invalid load", str(caught.value))
    listing = requests.get(aimock.url + "/__aimock/fixtures", timeout=5)
    assert listing.status_code == 200
    assert listing.json() == {"count": 1}
    assert control(aimock, "GET", test_id="python-A") == scope
    assert complete(client, {"X-Test-Id": "python-A"}).message.content == ""
    assert (
        complete(client, {"X-Test-Id": "python-B"}).message.tool_calls[0].function.name
        == "lookup"
    )


def test_scoped_times_replacement_and_delete_restore_empty_baseline(aimock, client):
    add_tool_fixture(aimock)
    scope = {"faults": [{"fault": "empty-response", "times": 1}]}
    assert control(aimock, "POST", scope, test_id="python-A") == scope
    readback = requests.get(
        aimock.url + "/__aimock/misbehavior", params={"testId": "python-A"}, timeout=5
    )
    assert readback.status_code == 200
    assert readback.json() == {"misbehavior": scope}
    first = complete(client, {"X-Test-Id": "python-A"})
    assert first.message.content == ""
    assert first.message.tool_calls is None
    assert (
        complete(client, {"X-Test-Id": "python-A"}).message.tool_calls[0].function.name
        == "lookup"
    )
    assert (
        complete(client, {"X-Test-Id": "python-B"}).message.tool_calls[0].function.name
        == "lookup"
    )
    replacement = {"faults": [{"fault": "content-filter"}]}
    assert control(aimock, "POST", replacement, test_id="python-A") == replacement
    assert complete(client, {"X-Test-Id": "python-A"}).finish_reason == "content_filter"
    assert control(aimock, "DELETE", test_id="python-A") == {"faults": []}
    assert (
        complete(client, {"X-Test-Id": "python-A"}).message.tool_calls[0].function.name
        == "lookup"
    )
    journal = aimock.get_journal()
    assert len(journal) == 5
    assert journal[0]["response"]["misbehavior"]["source"] == "scope"
    assert journal[1]["response"]["misbehavior"]["reason"] == "times-exhausted"


def test_invalid_scope_and_header_preserve_prior_config_and_budget(aimock, client):
    add_tool_fixture(aimock)
    scope = {"faults": [{"fault": "empty-response", "times": 1}]}
    control(aimock, "POST", scope, test_id="python-A")
    with pytest.raises(requests.HTTPError) as caught:
        control(aimock, "POST", {"faults": [], "typo": True}, test_id="python-A")
    assert caught.value.response.status_code == 400
    assert caught.value.response.json()["rule"] == "misbehavior/unknown-key"
    assert control(aimock, "GET", test_id="python-A") == scope
    with pytest.raises(APIStatusError) as invalid:
        complete(client, {"X-Test-Id": "python-A", "X-AIMock-Misbehavior": "unknown-fault"})
    assert invalid.value.status_code == 400
    assert invalid.value.code == "aimock_misbehavior_invalid"
    print("invalid header", str(invalid.value))
    assert complete(client, {"X-Test-Id": "python-A"}).message.content == ""
    assert (
        complete(client, {"X-Test-Id": "python-A"}).message.tool_calls[0].function.name
        == "lookup"
    )


def test_header_wins_without_spending_fixture_times_and_fixture_beats_scope(aimock, client):
    add_tool_fixture(
        aimock,
        fault={"faults": [{"fault": "tool-unknown-name", "name": "fixture_unknown", "times": 1}]},
    )
    control(aimock, "POST", {"faults": [{"fault": "content-filter"}]}, test_id="python-A")
    header = complete(client, {"X-Test-Id": "python-A", "X-AIMock-Misbehavior": "empty-response"})
    assert header.message.content == ""
    assert header.finish_reason == "stop"
    fixture = complete(client, {"X-Test-Id": "python-A"})
    assert fixture.message.tool_calls[0].function.name == "fixture_unknown"
    exhausted = complete(client, {"X-Test-Id": "python-A"})
    assert exhausted.message.tool_calls[0].function.name == "lookup"
    summaries = [entry["response"]["misbehavior"] for entry in aimock.get_journal()]
    assert len(summaries) == 3
    assert [summary["source"] for summary in summaries] == ["header", "fixture", "fixture"]
    assert summaries[0]["servedToolCalls"] == []
    assert summaries[1]["servedToolCalls"][0]["name"] == "fixture_unknown"
    assert summaries[2]["reason"] == "times-exhausted"


def test_explicit_empty_fixture_disables_lower_runtime_scope(aimock, client):
    add_tool_fixture(aimock, fault={"faults": []})
    control(aimock, "POST", {"faults": [{"fault": "empty-response"}]})
    assert complete(client).message.tool_calls[0].function.name == "lookup"
    summary = aimock.get_last_request()["response"]["misbehavior"]
    assert summary["source"] == "fixture"
    assert summary["applied"] is False
    assert summary["evaluations"] == []


def test_journal_clear_preserves_scope_times_and_full_reset_clears_scope(aimock, client):
    add_tool_fixture(aimock)
    scope = {"faults": [{"fault": "empty-response", "times": 1}]}
    control(aimock, "POST", scope, test_id="python-A")
    assert complete(client, {"X-Test-Id": "python-A"}).message.content == ""
    assert aimock.reset_journal() is aimock
    assert aimock.get_journal() == []
    assert control(aimock, "GET", test_id="python-A") == scope
    assert (
        complete(client, {"X-Test-Id": "python-A"}).message.tool_calls[0].function.name
        == "lookup"
    )
    assert aimock.get_last_request()["response"]["misbehavior"]["reason"] == "times-exhausted"
    assert aimock.reset() is aimock
    assert aimock.get_journal() == []
    assert control(aimock, "GET", test_id="python-A") == {"faults": []}
    assert requests.get(aimock.url + "/__aimock/fixtures", timeout=5).json() == {"count": 0}
    add_tool_fixture(aimock)
    assert (
        complete(client, {"X-Test-Id": "python-A"}).message.tool_calls[0].function.name
        == "lookup"
    )
    control(aimock, "POST", scope, test_id="python-A")
    assert complete(client, {"X-Test-Id": "python-A"}).message.content == ""


@pytest.mark.parametrize("reset", ["clear_fixtures", "reset"])
def test_same_file_readded_after_reset_fires_again(aimock, client, tmp_path, reset):
    entry = {
        "match": {"userMessage": "lookup"},
        "response": tool_response(),
        "misbehavior": {"faults": [{"fault": "empty-response", "times": 1}]},
    }
    path = tmp_path / "times.json"
    path.write_text(json.dumps(entry), encoding="utf-8")
    aimock.load_fixtures(path)
    assert complete(client).message.content == ""
    assert complete(client).message.tool_calls[0].function.name == "lookup"
    if reset == "clear_fixtures":
        assert aimock.clear_fixtures() is aimock
        assert len(aimock.get_journal()) == 2
    else:
        assert aimock.reset() is aimock
        assert aimock.get_journal() == []
    aimock.load_fixtures(path)
    assert complete(client).message.content == ""
    assert aimock.get_last_request()["response"]["misbehavior"]["evaluations"][0]["ordinal"] == 0


def test_authenticated_fixture_load_journal_and_direct_control(_aimock_node_manager, tmp_path):
    server = AIMockServer(_aimock_node_manager, api_key="python-control-key")
    try:
        server.start()
        path = tmp_path / "keyed.json"
        entry = {"match": {"userMessage": "lookup"}, "response": tool_response()}
        path.write_text(json.dumps(entry), encoding="utf-8")
        assert server.load_fixtures(path) is server
        denied = requests.post(server.url + "/__aimock/misbehavior", json={"faults": []}, timeout=5)
        assert denied.status_code == 401
        control(
            server, "POST", {"faults": [{"fault": "empty-response"}]}, api_key="python-control-key"
        )
        with OpenAI(
            base_url=server.url + "/v1",
            api_key="python-control-key",
            max_retries=0,
            timeout=5,
        ) as sdk:
            assert complete(sdk).message.content == ""
        journal = server.get_journal()
        assert len(journal) == 1
        assert journal[0]["response"]["misbehavior"]["applied"] is True
        assert control(server, "DELETE", api_key="python-control-key") == {"faults": []}
    finally:
        server.stop()
