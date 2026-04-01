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
