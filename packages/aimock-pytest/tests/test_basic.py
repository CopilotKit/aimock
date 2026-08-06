import os
import subprocess
import sys
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


def test_api_key_controls_and_client_requests(_aimock_node_manager):
    """The helper authenticates control traffic without bypassing client auth."""
    from aimock_pytest import AIMockServer

    server = AIMockServer(_aimock_node_manager, api_key="pytest-test-key")
    try:
        server.start()
        server.on_message("hello", {"content": "keyed"})
        body = {
            "model": "gpt-4",
            "messages": [{"role": "user", "content": "hello"}],
        }
        assert requests.post(f"{server.base_url}/v1/chat/completions", json=body).status_code == 401
        response = requests.post(
            f"{server.base_url}/v1/chat/completions",
            json=body,
            headers={"Authorization": "Bearer pytest-test-key"},
        )
        assert response.status_code == 200
        assert requests.post(f"{server.base_url}/__aimock/fixtures", json={"fixtures": []}).status_code == 401
    finally:
        server.stop()


def test_aimock_api_key_option_authenticates_plugin_fixture_in_a_subprocess(tmp_path):
    """The pytest option reaches the child and the fixture's control client."""
    test_file = tmp_path / "test_keyed_fixture.py"
    test_file.write_text(
        """
import requests


def test_keyed_fixture(aimock):
    aimock.on_message("hello", {"content": "keyed fixture"})
    body = {"model": "gpt-4", "messages": [{"role": "user", "content": "hello"}]}
    assert requests.post(f"{aimock.base_url}/v1/chat/completions", json=body).status_code == 401
    response = requests.post(
        f"{aimock.base_url}/v1/chat/completions",
        json=body,
        headers={"Authorization": "Bearer subprocess-key"},
    )
    assert response.status_code == 200
    assert response.json()["choices"][0]["message"]["content"] == "keyed fixture"
""",
        encoding="utf-8",
    )
    child_env = os.environ.copy()
    # The child loads the plugin explicitly so source-tree and installed-package
    # runs exercise the same fixture path without registering it twice.
    child_env["PYTEST_DISABLE_PLUGIN_AUTOLOAD"] = "1"
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "pytest",
            "-q",
            "-p",
            "aimock_pytest.plugin",
            "--aimock-api-key",
            "subprocess-key",
            str(test_file),
        ],
        env=child_env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_ordinary_plugin_fixture_ignores_inherited_api_key_in_a_subprocess(tmp_path):
    """Ambient shell auth must not turn an unconfigured fixture into an auth server."""
    test_file = tmp_path / "test_inherited_key_fixture.py"
    test_file.write_text(
        """
import requests


def test_unconfigured_fixture(aimock):
    aimock.on_message("hello", {"content": "ambient key ignored"})
    response = requests.post(
        f"{aimock.base_url}/v1/chat/completions",
        json={"model": "gpt-4", "messages": [{"role": "user", "content": "hello"}]},
    )
    assert response.status_code == 200
    assert response.json()["choices"][0]["message"]["content"] == "ambient key ignored"
""",
        encoding="utf-8",
    )
    child_env = os.environ.copy()
    child_env["AIMOCK_API_KEYS"] = "ambient-shell-key"
    child_env["PYTEST_DISABLE_PLUGIN_AUTOLOAD"] = "1"
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "pytest",
            "-q",
            "-p",
            "aimock_pytest.plugin",
            str(test_file),
        ],
        env=child_env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stdout + result.stderr


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


def _capture_control_posts(monkeypatch):
    """Spy on requests.post, recording every /__aimock/ control call.

    Returns the list the spy appends ``(url, response)`` to.  The real request
    still goes out, so the recorded response is the SERVER's, not a stub.
    """
    captured = []
    real_post = requests.post

    def spy(url, *args, **kwargs):
        response = real_post(url, *args, **kwargs)
        if "/__aimock/" in url:
            captured.append((url, response))
        return response

    monkeypatch.setattr(requests, "post", spy)
    return captured


def test_reset_targets_the_canonical_route_not_the_deprecated_alias(aimock, monkeypatch):
    """reset() must POST /__aimock/reset, which carries no deprecation signal.

    Both routes perform the same full reset, so a functional assertion cannot
    tell them apart.  The deprecation signal can: the alias returns
    ``deprecated``/``deprecation`` in the body and a ``Deprecation`` header,
    the canonical route returns neither.
    """
    captured = _capture_control_posts(monkeypatch)
    aimock.reset()

    assert len(captured) == 1
    url, response = captured[0]
    assert url.endswith("/__aimock/reset")
    assert response.status_code == 200

    body = response.json()
    assert body == {"reset": True}
    assert "deprecated" not in body
    assert "deprecation" not in body
    assert "Deprecation" not in response.headers

    # Anchor the discriminator: the alias DOES signal deprecation, so the
    # assertions above genuinely distinguish the two routes rather than
    # passing for both.
    alias = requests.post(f"{aimock.base_url}/__aimock/reset/fixtures", timeout=5)
    assert alias.status_code == 200
    alias_body = alias.json()
    assert alias_body["deprecated"] is True
    assert "POST /__aimock/reset" in alias_body["deprecation"]
    assert alias.headers["Deprecation"] == "true"


def test_reset_fixtures_is_a_deprecation_free_alias_for_reset(aimock, monkeypatch):
    """reset_fixtures() delegates to reset(), so it too uses /__aimock/reset."""
    aimock.on_message("test", {"content": "response"})

    captured = _capture_control_posts(monkeypatch)
    aimock.reset_fixtures()

    assert len(captured) == 1
    url, response = captured[0]
    assert url.endswith("/__aimock/reset")
    assert response.json() == {"reset": True}
    assert "Deprecation" not in response.headers

    # ...and it still performs the full reset its name promises.
    r = requests.post(
        f"{aimock.base_url}/v1/chat/completions",
        json={"model": "gpt-4", "messages": [{"role": "user", "content": "test"}]},
    )
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


def test_match_level_opt_keys_match_server_schema():
    """Drift guard: ``_MATCH_LEVEL_OPT_KEYS`` must cover every match-level
    field the server reads from ``entry.match`` in ``entryToFixture``.

    The server (``src/fixture-loader.ts``) reads each match-level constraint as
    ``entry.match.<key>``. If a new such field is added server-side but not to
    ``_MATCH_LEVEL_OPT_KEYS``, the Python client silently spreads it to the top
    level of the entry — where the server ignores it — so the constraint is
    dropped and matching becomes over-broad. This test fails loudly when that
    happens.

    The guard is repo/CI-only: when the TypeScript source is unavailable (e.g.
    the package is installed standalone), it skips rather than fails.
    """
    import re
    from pathlib import Path

    import pytest

    from aimock_pytest._server import AIMockServer

    # test file: <repo>/packages/aimock-pytest/tests/test_basic.py
    #   parents[0] = tests, [1] = aimock-pytest, [2] = packages, [3] = <repo>
    fixture_loader = (
        Path(__file__).resolve().parents[3] / "src" / "fixture-loader.ts"
    )
    if not fixture_loader.exists():
        pytest.skip("fixture-loader.ts not available outside the repo")

    source = fixture_loader.read_text(encoding="utf-8")

    # Isolate the body of entryToFixture so we only collect the match-key reads
    # from inside that function (and not any unrelated entry.match.X references
    # elsewhere in the file, e.g. in validateFixtures which uses f.match.X).
    start = source.index("export function entryToFixture")
    rest = source[start + len("export function entryToFixture") :]
    next_export = rest.find("\nexport function ")
    body = rest if next_export == -1 else rest[:next_export]

    server_match_keys = set(re.findall(r"entry\.match\.(\w+)", body))
    assert server_match_keys, (
        "no entry.match.<key> references found in entryToFixture — "
        "the regex or function-body isolation is broken"
    )

    missing = server_match_keys - set(AIMockServer._MATCH_LEVEL_OPT_KEYS)
    assert not missing, (
        f"_MATCH_LEVEL_OPT_KEYS is missing server match keys: {sorted(missing)}. "
        "Update it in _server.py to match entryToFixture in src/fixture-loader.ts."
    )
