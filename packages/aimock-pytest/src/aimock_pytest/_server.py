"""Manages the aimock subprocess and communicates via the /__aimock/* control API."""

from __future__ import annotations

import atexit
import json
import os
import re
import subprocess
import time
from pathlib import Path
from typing import Any

import requests

from aimock_pytest._node_manager import NodeManager


class AIMockServer:
    """Wraps a running aimock Node.js process and exposes the control API as
    Python methods."""

    def __init__(
        self,
        node_manager: NodeManager,
        port: int = 0,
        fixtures_path: str | Path | None = None,
    ) -> None:
        self.node_manager = node_manager
        self.port = port
        self.fixtures_path = fixtures_path
        self._proc: subprocess.Popen[str] | None = None
        self._base_url: str | None = None

    # ── lifecycle ───────────────────────────────────────────────────────

    def start(self) -> str:
        """Start the aimock subprocess, wait for it to be ready, and return
        the base URL (e.g. ``http://127.0.0.1:54321``)."""
        env_cli = os.environ.get("AIMOCK_CLI_PATH")
        if env_cli:
            cli_path = Path(env_cli)
            if not cli_path.is_file():
                raise RuntimeError(
                    f"AIMOCK_CLI_PATH is set to {env_cli!r} but the file does not exist"
                )
        else:
            cli_path = self.node_manager.ensure_installed()
        node = self.node_manager.find_node()

        # The CLI requires a valid fixtures path (exits 1 if not found).
        # Use the provided path, or create an empty temp directory.
        if self.fixtures_path:
            fixtures_arg = str(self.fixtures_path)
        else:
            import tempfile

            self._tmp_fixtures = tempfile.mkdtemp(prefix="aimock-fixtures-")
            fixtures_arg = self._tmp_fixtures

        cmd = [
            node,
            str(cli_path),
            "--port",
            str(self.port),
            "--log-level",
            "info",
            "--fixtures",
            fixtures_arg,
        ]

        self._proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        atexit.register(self.stop)

        self._base_url = self._wait_for_ready(timeout=15)
        return self._base_url

    def stop(self) -> None:
        """Terminate the aimock subprocess."""
        if self._proc is not None:
            try:
                self._proc.terminate()
                self._proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._proc.kill()
                self._proc.wait()
            except Exception:
                try:
                    self._proc.kill()
                except Exception:
                    pass
            finally:
                self._proc = None
        # Clean up temp fixtures directory if we created one
        if hasattr(self, "_tmp_fixtures") and self._tmp_fixtures:
            import shutil

            shutil.rmtree(self._tmp_fixtures, ignore_errors=True)
            self._tmp_fixtures = None
        atexit.unregister(self.stop)

    @property
    def base_url(self) -> str:
        """The base URL of the running aimock server."""
        if self._base_url is None:
            raise RuntimeError("Server has not been started yet")
        return self._base_url

    @property
    def url(self) -> str:
        """Alias for :attr:`base_url`."""
        return self.base_url

    # ── control API methods ─────────────────────────────────────────────

    def add_fixture(
        self,
        match: dict[str, Any],
        response: dict[str, Any],
        **opts: Any,
    ) -> None:
        """Add a single fixture via ``POST /__aimock/fixtures``."""
        fixture: dict[str, Any] = {"match": match, "response": response}
        if opts:
            fixture["opts"] = opts
        r = requests.post(
            f"{self.base_url}/__aimock/fixtures",
            json={"fixtures": [fixture]},
            timeout=5,
        )
        r.raise_for_status()

    def on_message(
        self,
        pattern: str,
        response: dict[str, Any],
        **opts: Any,
    ) -> AIMockServer:
        """Convenience: add a fixture matching ``userMessage``."""
        self.add_fixture({"userMessage": pattern}, response, **opts)
        return self

    def on_embedding(
        self,
        pattern: str,
        response: dict[str, Any],
    ) -> AIMockServer:
        """Convenience: add a fixture matching ``inputText``."""
        self.add_fixture({"inputText": pattern}, response)
        return self

    def load_fixtures(self, path: str | Path) -> AIMockServer:
        """Read a JSON fixture file and POST its contents to the control API.

        The file must contain either:
        - A JSON object with a ``"fixtures"`` key (list of fixtures)
        - A JSON array of fixture objects
        - A single fixture object (wrapped into a list automatically)

        Raises :class:`ValueError` if the parsed JSON is not a dict or list.
        """
        with open(path) as f:
            data = json.load(f)

        if isinstance(data, list):
            fixtures = data
        elif isinstance(data, dict) and "fixtures" in data:
            fixtures = data["fixtures"]
        elif isinstance(data, dict):
            fixtures = [data]
        else:
            raise ValueError(
                f"Invalid fixture file {path}: expected a JSON object or array, "
                f"got {type(data).__name__}"
            )

        r = requests.post(
            f"{self.base_url}/__aimock/fixtures",
            json={"fixtures": fixtures},
            timeout=5,
        )
        r.raise_for_status()
        return self

    def clear_fixtures(self) -> AIMockServer:
        """Delete all fixtures via ``DELETE /__aimock/fixtures``."""
        requests.delete(
            f"{self.base_url}/__aimock/fixtures", timeout=5
        ).raise_for_status()
        return self

    def reset(self) -> AIMockServer:
        """Clear fixtures, journal, and match counts via ``POST /__aimock/reset``."""
        requests.post(
            f"{self.base_url}/__aimock/reset", timeout=5
        ).raise_for_status()
        return self

    def get_journal(self) -> list[dict[str, Any]]:
        """Return all recorded journal entries."""
        r = requests.get(f"{self.base_url}/__aimock/journal", timeout=5)
        r.raise_for_status()
        return r.json()  # type: ignore[no-any-return]

    def get_last_request(self) -> dict[str, Any] | None:
        """Return the most recent journal entry, or ``None``."""
        journal = self.get_journal()
        return journal[-1] if journal else None

    def next_error(
        self,
        status: int,
        body: dict[str, Any] | None = None,
    ) -> AIMockServer:
        """Queue a one-shot error via ``POST /__aimock/error``."""
        requests.post(
            f"{self.base_url}/__aimock/error",
            json={"status": status, "body": body or {}},
            timeout=5,
        ).raise_for_status()
        return self

    # ── internal ────────────────────────────────────────────────────────

    def _wait_for_ready(self, timeout: int = 15) -> str:
        """Read stdout lines until we see the listening URL, then verify via
        health check."""
        assert self._proc is not None
        assert self._proc.stdout is not None

        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            # Check if process exited
            if self._proc.poll() is not None:
                remaining = ""
                if self._proc.stdout:
                    remaining = self._proc.stdout.read()
                raise RuntimeError(
                    f"aimock process exited with code {self._proc.returncode}"
                    f"{': ' + remaining if remaining else ''}"
                )

            line = self._proc.stdout.readline()
            if not line:
                continue

            m = re.search(r"listening on (http://\S+)", line)
            if m:
                url = m.group(1).rstrip("/")
                # Verify health endpoint is reachable
                for _ in range(30):
                    try:
                        r = requests.get(
                            f"{url}/__aimock/health", timeout=0.5
                        )
                        if r.status_code == 200:
                            return url
                        time.sleep(0.1)
                    except requests.RequestException:
                        time.sleep(0.1)
                raise RuntimeError(
                    "aimock started but health check failed after 3 seconds"
                )

        raise RuntimeError(f"aimock did not start within {timeout}s")
