"""Manages the aimock subprocess and communicates via the /__aimock/* control API."""

from __future__ import annotations

import atexit
import json
import os
import queue
import re
import subprocess
import threading
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
        # Background stdout drainer state. The reader thread continuously
        # consumes the child's stdout so (a) readiness detection can enforce
        # a real timeout instead of blocking on readline(), and (b) a long
        # run never deadlocks on a full stdout pipe buffer.
        self._stdout_queue: queue.Queue[str | None] = queue.Queue()
        self._reader_thread: threading.Thread | None = None
        # Path to a temp fixtures dir we create when no fixtures_path is
        # supplied; ``None`` until ``start()`` creates one. Always defined so
        # ``stop()`` can clean up without a ``hasattr`` guard.
        self._tmp_fixtures: str | None = None

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

        # Start draining stdout immediately so the pipe never fills and the
        # readiness wait can poll lines with a real deadline.
        self._reader_thread = threading.Thread(
            target=self._drain_stdout,
            args=(self._proc.stdout,),
            daemon=True,
        )
        self._reader_thread.start()

        self._base_url = self._wait_for_ready(timeout=15)
        return self._base_url

    def _drain_stdout(self, stream: Any) -> None:
        """Continuously read the child's stdout, forwarding each line to the
        queue. Runs for the whole process lifetime so the stdout pipe buffer
        never fills (which would otherwise deadlock the child). Pushes a
        sentinel ``None`` when the stream closes (process exit)."""
        try:
            for line in iter(stream.readline, ""):
                self._stdout_queue.put(line)
        except (ValueError, OSError):
            # Stream closed underneath us during shutdown.
            pass
        finally:
            self._stdout_queue.put(None)

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
        # The reader thread is a daemon and exits on its own once the stdout
        # stream closes; give it a brief moment to wind down.
        if self._reader_thread is not None:
            self._reader_thread.join(timeout=1)
            self._reader_thread = None
        # Clean up temp fixtures directory if we created one
        if self._tmp_fixtures:
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

    # Seconds to wait for the health check to pass once the child logs its
    # listening URL. Used both to compute the health deadline and in the
    # failure message, so the window is named in a single place.
    _HEALTH_TIMEOUT_S = 3.0

    # ── control API methods ─────────────────────────────────────────────

    # Match-level option keys. These belong under the fixture's ``match``
    # block: the server reads exactly these fields from ``entry.match`` in
    # ``entryToFixture`` (src/fixture-loader.ts). This set MUST track that
    # function's match keys — if the server starts reading another field from
    # ``entry.match``, add it here, or a kwarg opt with that name will be
    # spread to the top level and silently dropped (over-broad matching).
    #
    # The list below is illustrative-but-must-stay-complete, NOT a validated
    # or closed allow-list: any kwarg whose key is NOT in this set still
    # spreads onto the top-level entry (that is how fixture-level options such
    # as ``latency``, ``chunkSize``, ``truncateAfterChunks``,
    # ``disconnectAfterMs``, ``streamingProfile``, ``recordedTimings``,
    # ``replaySpeed``, ``chaos`` and ``metadata`` reach the server).
    _MATCH_LEVEL_OPT_KEYS = frozenset(
        {
            "userMessage",
            "systemMessage",
            "inputText",
            "toolCallId",
            "toolResultContains",
            "toolName",
            "model",
            "responseFormat",
            "endpoint",
            "sequenceIndex",
            "turnIndex",
            "hasToolResult",
            "context",
        }
    )

    def add_fixture(
        self,
        match: dict[str, Any],
        response: dict[str, Any],
        **opts: Any,
    ) -> None:
        """Add a single fixture via ``POST /__aimock/fixtures``.

        ``**opts`` are routed to the wire shape the server actually reads:
        fixture-level options (e.g. ``latency``, ``chunkSize``, ``chaos``,
        ``streamingProfile``) are spread onto the top-level entry, while
        match-level options (any key the server reads from ``entry.match`` —
        e.g. ``model``, ``toolName``, ``sequenceIndex``, ``turnIndex``,
        ``hasToolResult``; see :data:`_MATCH_LEVEL_OPT_KEYS`) are merged into
        the ``match`` block. There is no ``opts`` wrapper key in the server's
        fixture schema.
        """
        fixture_match = dict(match)
        fixture: dict[str, Any] = {"match": fixture_match, "response": response}
        for key, value in opts.items():
            if key in self._MATCH_LEVEL_OPT_KEYS:
                fixture_match[key] = value
            else:
                fixture[key] = value
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
        **opts: Any,
    ) -> AIMockServer:
        """Convenience: add a fixture matching ``inputText``."""
        self.add_fixture({"inputText": pattern}, response, **opts)
        return self

    def on_system_message(
        self,
        pattern: str | list[str],
        response: dict[str, Any],
        *,
        user_message: str | None = None,
        **opts: Any,
    ) -> AIMockServer:
        """Convenience: add a fixture matching ``systemMessage``.

        ``pattern`` may be a single substring or a list of substrings; the
        list form requires ALL substrings to appear in the joined text of
        every ``role: "system"`` message (AND semantics). Pass
        ``user_message=`` to ALSO gate on the user prompt — the two
        matchers are AND-combined inside the same fixture's ``match``
        block, mirroring the on-the-wire fixture shape.
        """
        match: dict[str, Any] = {"systemMessage": pattern}
        if user_message is not None:
            match["userMessage"] = user_message
        self.add_fixture(match, response, **opts)
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
        """Full reset: clear fixtures + generation state + journal (alias for
        :meth:`reset_fixtures`)."""
        return self.reset_fixtures()

    def reset_fixtures(self) -> AIMockServer:
        """Clear fixtures + generation state (and journal) via
        ``POST /__aimock/reset/fixtures``."""
        requests.post(
            f"{self.base_url}/__aimock/reset/fixtures", timeout=5
        ).raise_for_status()
        return self

    def reset_journal(self) -> AIMockServer:
        """Clear ONLY the request journal, leaving fixtures intact, via
        ``POST /__aimock/reset/journal``."""
        requests.post(
            f"{self.base_url}/__aimock/reset/journal", timeout=5
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

    def _drain_collected(self) -> str:
        """Non-blocking drain of whatever stdout lines are currently queued.

        Used when building a startup-failure error message so the child's
        captured output is surfaced. Does not block waiting for more output —
        it only consumes what the reader thread has already enqueued. A
        sentinel ``None`` (stream closed) is left intact for callers that
        still need to observe process exit; only string lines are returned."""
        lines: list[str] = []
        while True:
            try:
                item = self._stdout_queue.get_nowait()
            except queue.Empty:
                break
            if item is None:
                # Preserve the exit sentinel; we don't consume it here.
                self._stdout_queue.put(None)
                break
            lines.append(item)
        return "".join(lines)

    def _wait_for_ready(self, timeout: int = 15) -> str:
        """Poll the background-drained stdout lines until we see the listening
        URL, then verify via health check. Honors ``timeout`` strictly: the
        deadline loop never blocks indefinitely because lines arrive via the
        reader thread's queue rather than a blocking ``readline()``.

        On any startup failure (process exit, health-check failure, or
        readiness timeout) the subprocess is torn down via :meth:`stop`
        before the ``RuntimeError`` propagates, so a half-started child and
        its bound port never leak when ``start()`` raises (the pytest fixture
        teardown never runs in that case)."""
        try:
            return self._wait_for_ready_inner(timeout)
        except Exception:
            # Tear down the half-started child so it (and its bound port) do
            # not leak for the rest of the session. ``stop`` is idempotent
            # and guards against a missing/already-reaped process.
            self.stop()
            raise

    def _wait_for_ready_inner(self, timeout: int) -> str:
        assert self._proc is not None

        deadline = time.monotonic() + timeout
        collected: list[str] = []
        while time.monotonic() < deadline:
            # Drain whatever startup output the reader thread has captured,
            # bounded by the remaining time so we never block past the
            # deadline.
            try:
                line = self._stdout_queue.get(
                    timeout=max(0.0, deadline - time.monotonic())
                )
            except queue.Empty:
                break

            if line is None:
                # Sentinel: stdout closed → the process exited.
                self._proc.wait()
                output = "".join(collected)
                raise RuntimeError(
                    f"aimock process exited with code {self._proc.returncode}"
                    f"{': ' + output if output else ''}"
                )

            collected.append(line)

            m = re.search(r"listening on (http://\S+)", line)
            if m:
                url = m.group(1).rstrip("/")
                start = time.monotonic()
                health_deadline = start + self._HEALTH_TIMEOUT_S
                attempts = 0
                while time.monotonic() < health_deadline:
                    attempts += 1
                    try:
                        r = requests.get(
                            f"{url}/__aimock/health", timeout=0.5
                        )
                        if r.status_code == 200:
                            return url
                    except requests.RequestException:
                        pass
                    # Don't sleep past the health window: only back off if the
                    # next attempt would still fall inside the deadline.
                    if time.monotonic() + 0.1 < health_deadline:
                        time.sleep(0.1)
                    else:
                        break
                elapsed = time.monotonic() - start
                # Surface any further stdout the child emitted after the
                # "listening on" line (e.g. a crash trace) to aid diagnosis.
                collected.append(self._drain_collected())
                output = "".join(collected)
                raise RuntimeError(
                    f"aimock started but health check failed after "
                    f"{attempts} attempt(s) over {elapsed:.1f}s"
                    f"{': ' + output if output else ''}"
                )

        # Readiness timeout: include whatever startup output was captured so
        # a silent/slow child isn't an opaque failure.
        collected.append(self._drain_collected())
        output = "".join(collected)
        raise RuntimeError(
            f"aimock did not start within {timeout}s"
            f"{': ' + output if output else ''}"
        )
