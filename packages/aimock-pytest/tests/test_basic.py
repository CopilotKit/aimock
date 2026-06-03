from unittest import mock

import requests

# ── Session-scoped fixture tests ──────────────────────────────────────────
# These two tests share a single aimock_session instance, verifying that the
# session-scoped fixture persists state across test functions.

_session_url: str | None = None


def test_session_fixture_starts(aimock_session):
    """aimock_session starts and its URL persists across tests."""
    global _session_url
    r = requests.get(f"{aimock_session.base_url}/__aimock/health")
    assert r.status_code == 200
    _session_url = aimock_session.base_url


def test_session_fixture_persists(aimock_session):
    """aimock_session is the same server instance as the previous test."""
    # The base_url should be identical — same process, same port.
    assert aimock_session.base_url == _session_url

    # Fixtures added in a previous test would still be present (session scope
    # does NOT auto-reset between tests).  Verify the server is still alive.
    r = requests.get(f"{aimock_session.base_url}/__aimock/health")
    assert r.status_code == 200


# ── Function-scoped fixture tests ────────────────────────────────────────


def test_server_starts(aimock):
    """Server starts and health check works."""
    r = requests.get(f"{aimock.base_url}/__aimock/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_add_fixture_and_match(aimock):
    """Add a fixture via control API, then hit it."""
    aimock.on_message("hello", {"content": "Hi there!"})

    r = requests.post(
        f"{aimock.base_url}/v1/chat/completions",
        json={
            "model": "gpt-4",
            "messages": [{"role": "user", "content": "hello"}],
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["choices"][0]["message"]["content"] == "Hi there!"


def test_reset_clears_fixtures(aimock):
    """Reset clears fixtures and journal."""
    aimock.on_message("test", {"content": "response"})
    aimock.reset()

    r = requests.post(
        f"{aimock.base_url}/v1/chat/completions",
        json={
            "model": "gpt-4",
            "messages": [{"role": "user", "content": "test"}],
        },
    )
    # aimock returns 404 when no fixture matches the request, confirming
    # that the previously-registered fixture was cleared by reset().
    assert r.status_code == 404


def test_reset_journal_preserves_fixtures(aimock):
    """reset_journal() clears the journal but leaves fixtures intact."""
    aimock.on_message("hello", {"content": "Hi there!"})

    # Make a matching request so the journal records an entry.
    r = requests.post(
        f"{aimock.base_url}/v1/chat/completions",
        json={
            "model": "gpt-4",
            "messages": [{"role": "user", "content": "hello"}],
        },
    )
    assert r.status_code == 200
    assert len(aimock.get_journal()) > 0

    aimock.reset_journal()

    # Journal cleared...
    assert aimock.get_journal() == []

    # ...but the fixture is preserved: the same matching request still hits it.
    r = requests.post(
        f"{aimock.base_url}/v1/chat/completions",
        json={
            "model": "gpt-4",
            "messages": [{"role": "user", "content": "hello"}],
        },
    )
    assert r.status_code == 200
    assert r.json()["choices"][0]["message"]["content"] == "Hi there!"


def test_on_system_message_string(aimock):
    """on_system_message with a single-substring pattern gates on the system text."""
    aimock.on_system_message(
        "name=Atai",
        {"content": "default-state response"},
        user_message="who am I",
    )

    # Matching system + user → fixture hit.
    r = requests.post(
        f"{aimock.base_url}/v1/chat/completions",
        json={
            "model": "gpt-4",
            "messages": [
                {"role": "system", "content": "ctx: name=Atai"},
                {"role": "user", "content": "who am I"},
            ],
        },
    )
    assert r.status_code == 200
    assert r.json()["choices"][0]["message"]["content"] == "default-state response"

    # System mismatch → fixture misses, no other fixture registered → 404.
    r = requests.post(
        f"{aimock.base_url}/v1/chat/completions",
        json={
            "model": "gpt-4",
            "messages": [
                {"role": "system", "content": "ctx: name=Alem"},
                {"role": "user", "content": "who am I"},
            ],
        },
    )
    assert r.status_code == 404


def test_on_system_message_array_requires_all(aimock):
    """on_system_message with a list[str] pattern AND-combines substrings."""
    aimock.on_system_message(
        ["name=Atai", "tz=PST"],
        {"content": "exact-defaults"},
        user_message="plan my morning",
    )

    # Both substrings present → fixture hits.
    r = requests.post(
        f"{aimock.base_url}/v1/chat/completions",
        json={
            "model": "gpt-4",
            "messages": [
                {"role": "system", "content": "name=Atai\ntz=PST"},
                {"role": "user", "content": "plan my morning"},
            ],
        },
    )
    assert r.status_code == 200
    assert r.json()["choices"][0]["message"]["content"] == "exact-defaults"

    # Only one substring present → fixture misses → 404.
    r = requests.post(
        f"{aimock.base_url}/v1/chat/completions",
        json={
            "model": "gpt-4",
            "messages": [
                {"role": "system", "content": "name=Atai\ntz=EST"},
                {"role": "user", "content": "plan my morning"},
            ],
        },
    )
    assert r.status_code == 404


# ── Fixture-option forwarding tests ──────────────────────────────────────
# These prove that per-fixture options passed via **opts reach the server's
# fixture schema at the correct wire location instead of being silently
# dropped under an unrecognized top-level "opts" key.


def test_match_level_opt_routed_under_match(aimock):
    """A match-level option (``sequenceIndex``) must be routed under ``match``
    so the server's per-occurrence sequencing actually takes effect.

    Two sibling fixtures share the same matcher but differ by
    ``sequenceIndex``: the 0th occurrence must serve ``first-hit`` and the
    1st occurrence ``second-hit``. Under the old nested-``opts`` shape the
    server never sees ``sequenceIndex`` (both fixtures look identical), so the
    first fixture shadows the second and BOTH requests return ``first-hit`` —
    failing the second assertion.
    """
    aimock.on_message("seqtest", {"content": "first-hit"}, sequenceIndex=0)
    aimock.on_message("seqtest", {"content": "second-hit"}, sequenceIndex=1)

    payload = {
        "model": "gpt-4",
        "messages": [{"role": "user", "content": "seqtest"}],
    }

    r1 = requests.post(f"{aimock.base_url}/v1/chat/completions", json=payload)
    assert r1.status_code == 200
    assert r1.json()["choices"][0]["message"]["content"] == "first-hit"

    r2 = requests.post(f"{aimock.base_url}/v1/chat/completions", json=payload)
    assert r2.status_code == 200
    assert r2.json()["choices"][0]["message"]["content"] == "second-hit"


def test_opts_emitted_at_correct_wire_level():
    """Per-fixture options land at the correct wire location and NO ``opts``
    wrapper key is emitted.

    Fixture-level options (e.g. ``latency``, ``chunkSize``) belong at the top
    level of the entry; match-level options (``sequenceIndex``) belong under
    ``match``. The pre-fix code nested everything under ``fixture["opts"]``.
    """
    from aimock_pytest._server import AIMockServer

    server = AIMockServer.__new__(AIMockServer)
    server._base_url = "http://127.0.0.1:9999"

    with mock.patch("aimock_pytest._server.requests.post") as post:
        post.return_value.raise_for_status.return_value = None
        server.add_fixture(
            {"userMessage": "hi"},
            {"content": "yo"},
            latency=42,
            chunkSize=7,
            sequenceIndex=2,
        )

    assert post.call_count == 1
    entry = post.call_args.kwargs["json"]["fixtures"][0]

    # No legacy wrapper key.
    assert "opts" not in entry

    # Fixture-level options at the top level of the entry.
    assert entry["latency"] == 42
    assert entry["chunkSize"] == 7

    # Match-level option under match (alongside the original matcher).
    assert entry["match"]["userMessage"] == "hi"
    assert entry["match"]["sequenceIndex"] == 2

    # Match-level keys must NOT leak to the top level.
    assert "sequenceIndex" not in entry


def test_match_level_kwarg_opt_routed_under_match():
    """Every key the server reads from ``entry.match`` must be routed under
    ``match`` when passed as a kwarg opt — not just the original three.

    ``model`` is a match-level constraint (the server reads
    ``entry.match.model`` in ``entryToFixture``). If it is spread to the top
    level the constraint is silently dropped, so the fixture matches requests
    for ANY model (over-broad matching). This guards the completeness of
    ``_MATCH_LEVEL_OPT_KEYS``.
    """
    from aimock_pytest._server import AIMockServer

    server = AIMockServer.__new__(AIMockServer)
    server._base_url = "http://127.0.0.1:9999"

    with mock.patch("aimock_pytest._server.requests.post") as post:
        post.return_value.raise_for_status.return_value = None
        server.add_fixture(
            {"userMessage": "x"},
            {"content": "yo"},
            model="gpt-4",
        )

    entry = post.call_args.kwargs["json"]["fixtures"][0]

    # ``model`` belongs under match, alongside the original matcher.
    assert entry["match"]["userMessage"] == "x"
    assert entry["match"]["model"] == "gpt-4"

    # ...and must NOT leak to the top level where the server ignores it.
    assert "model" not in entry
