import os

import requests


def test_load_fixture_file(aimock):
    """Load fixtures from a JSON file."""
    fixture_path = os.path.join(os.path.dirname(__file__), "fixtures", "hello.json")
    aimock.load_fixtures(fixture_path)

    r = requests.post(
        f"{aimock.base_url}/v1/chat/completions",
        json={
            "model": "gpt-4",
            "messages": [{"role": "user", "content": "hello"}],
        },
    )
    assert r.status_code == 200
    assert "Hello from aimock" in r.json()["choices"][0]["message"]["content"]


def test_journal_records_requests(aimock):
    """Journal captures all requests."""
    aimock.on_message("journal-test", {"content": "ok"})

    requests.post(
        f"{aimock.base_url}/v1/chat/completions",
        json={
            "model": "gpt-4",
            "messages": [{"role": "user", "content": "journal-test"}],
        },
    )

    journal = aimock.get_journal()
    assert len(journal) >= 1


def test_one_shot_error(aimock):
    """Queue a one-shot error."""
    aimock.on_message("error-test", {"content": "ok"})
    aimock.next_error(429, {"message": "Rate limited", "type": "rate_limit_error"})

    r1 = requests.post(
        f"{aimock.base_url}/v1/chat/completions",
        json={
            "model": "gpt-4",
            "messages": [{"role": "user", "content": "error-test"}],
        },
    )
    assert r1.status_code == 429

    # Second request should succeed
    r2 = requests.post(
        f"{aimock.base_url}/v1/chat/completions",
        json={
            "model": "gpt-4",
            "messages": [{"role": "user", "content": "error-test"}],
        },
    )
    assert r2.status_code == 200
