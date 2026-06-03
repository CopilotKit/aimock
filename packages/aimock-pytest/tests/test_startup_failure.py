"""Startup-failure-path tests for AIMockServer.start / _wait_for_ready.

These exercise the failure branches (health-check failure, readiness timeout)
to verify the half-started subprocess is reaped and the child's captured
stdout is surfaced in the error — not the happy path.
"""

import pytest
import requests

from aimock_pytest import AIMockServer, NodeManager
from aimock_pytest import _server as server_module


def _node_manager() -> NodeManager:
    return NodeManager(version=None, node_path=None)


def test_health_check_failure_reaps_process_and_surfaces_output(monkeypatch):
    """When the child starts (prints 'listening on') but the health check
    never succeeds, start() raises, the subprocess is terminated (no leak),
    and the captured stdout is included in the error message."""
    server = AIMockServer(_node_manager(), port=0)

    # Force every health-check probe to fail so the "listening on" branch
    # falls through to the health-check-failure RuntimeError.
    def _always_fail(*args, **kwargs):
        raise requests.ConnectionError("forced health-check failure")

    monkeypatch.setattr(requests, "get", _always_fail)

    try:
        with pytest.raises(RuntimeError) as excinfo:
            server.start()

        msg = str(excinfo.value)
        assert "health check failed" in msg
        # The child logs a "listening on http://..." line on startup; that
        # captured stdout must be surfaced in the error.
        assert "listening on" in msg
        # The half-started subprocess must have been reaped.
        assert server._proc is None
    finally:
        server.stop()


def test_readiness_timeout_reaps_process(monkeypatch):
    """When the child never prints a recognizable 'listening on' line within
    the timeout, start() raises a readiness-timeout RuntimeError and the
    subprocess is reaped rather than leaked."""
    server = AIMockServer(_node_manager(), port=0)

    # Make the listening-line matcher never match and shorten the readiness
    # window so the loop expires while the (real) child is still running.
    monkeypatch.setattr(server_module.re, "search", lambda *a, **k: None)
    real_start = AIMockServer.start

    def _short_start(self):
        # Mirror start()'s readiness timeout but make it tiny.
        original_wait = self._wait_for_ready
        self._wait_for_ready = lambda timeout=15: original_wait(timeout=0.2)
        return real_start(self)

    monkeypatch.setattr(AIMockServer, "start", _short_start)

    try:
        with pytest.raises(RuntimeError) as excinfo:
            server.start()

        msg = str(excinfo.value)
        assert "did not start within" in msg
        # The half-started subprocess must have been reaped.
        assert server._proc is None
    finally:
        server.stop()
