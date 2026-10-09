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
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlencode

import requests

from aimock_pytest._node_manager import NodeManager


@dataclass(frozen=True)
class FakesTarget:
    """Where an MCP client reaches the fakes for one test (spec RP8).

    ``mcp_url`` carries the identity in its query string; ``headers`` carry
    the same identity for a client that connects to the bare mount URL.
    """

    test_id: str
    mcp_url: str
    headers: dict[str, str] = field(default_factory=dict)


class AIMockServer:
    """Wraps a running aimock Node.js process and exposes the control API as
    Python methods."""

    def __init__(
        self,
        node_manager: NodeManager,
        port: int = 0,
        fixtures_path: str | Path | None = None,
        api_key: str | None = None,
    ) -> None:
        self.node_manager = node_manager
        self.port = port
        self.fixtures_path = fixtures_path
        self.api_key = api_key
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
        # The current test's id (spec TI3). The function-scoped ``aimock``
        # fixture sets it to ``request.node.nodeid``; it stays ``None`` for
        # ``aimock_session``. Only the fakes helpers below read it (TI4).
        self._default_test_id: str | None = None

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

        child_env = os.environ.copy()
        # The plugin option owns child auth. Do not inherit a developer's or
        # CI runner's ambient key into ordinary unconfigured fixtures.
        child_env.pop("AIMOCK_API_KEYS", None)
        if self.api_key is not None:
            child_env["AIMOCK_API_KEYS"] = self.api_key
        self._proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            env=child_env,
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

    def _control_headers(self) -> dict[str, str]:
        api_key = getattr(self, "api_key", None)
        return {"Authorization": f"Bearer {api_key}"} if api_key else {}

    def _control_request(self, method: str, path: str, **kwargs: Any) -> requests.Response:
        headers = dict(kwargs.pop("headers", {}))
        headers.update(self._control_headers())
        request_fn = getattr(requests, method.lower())
        return request_fn(f"{self.base_url}/__aimock{path}", headers=headers, **kwargs)

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
        r = self._control_request("POST", "/fixtures",
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

        An object with an ``"mcpFakes"`` key has that value posted next to
        ``"fixtures"`` (an object with ``"mcpFakes"`` and no ``"fixtures"``
        is posted as ``{"mcpFakes": ...}`` alone).

        Raises :class:`ValueError` if the parsed JSON is not a dict or list.
        Raises :class:`requests.HTTPError` carrying the server's ``error``
        and ``details`` when the server rejects the load with a 400, and
        :class:`RuntimeError` when the file has ``mcpFakes`` and the server
        is too old to serve fakes. In that case nothing from the file is
        added: a file with both ``fixtures`` and ``mcpFakes`` is preceded by
        a probe that adds nothing, because an old server would add the
        fixtures and ignore ``mcpFakes``.
        """
        with open(path) as f:
            data = json.load(f)

        body: dict[str, Any]
        if isinstance(data, list):
            body = {"fixtures": data}
        elif isinstance(data, dict) and ("fixtures" in data or "mcpFakes" in data):
            body = {key: data[key] for key in ("fixtures", "mcpFakes") if key in data}
        elif isinstance(data, dict):
            body = {"fixtures": [data]}
        else:
            raise ValueError(
                f"Invalid fixture file {path}: expected a JSON object or array, "
                f"got {type(data).__name__}"
            )

        if "mcpFakes" in body and isinstance(body.get("fixtures"), list) and body["fixtures"]:
            # An old server adds the fixtures and ignores mcpFakes, so a
            # mixed file is checked first with a body that adds nothing on
            # any server: an empty mcpFakes array is a bad block to a server
            # that serves fakes, and has no fixtures array for an old one.
            probe = self._control_request("POST", "/fixtures",
                json={"mcpFakes": []},
                timeout=5,
            )
            if self._rejects_missing_fixtures(probe):
                raise RuntimeError(
                    f"aimock server too old for mcpFakes: {path} has mcpFakes, but "
                    f"the server needs a fixtures array ({probe.text})"
                )
            if probe.status_code != 400:
                probe.raise_for_status()

        r = self._control_request("POST", "/fixtures",
            json=body,
            timeout=5,
        )
        if "fixtures" not in body and self._rejects_missing_fixtures(r):
            # A fakes-only body needs no fixtures array on a server that
            # serves fakes, so this answer comes from an older server.
            raise RuntimeError(
                f"aimock server too old for mcpFakes: {path} has mcpFakes, but "
                f"the server needs a fixtures array ({r.text})"
            )
        if r.status_code == 400:
            payload = self._json_or_none(r)
            if isinstance(payload, dict):
                lines = [f"aimock rejected fixtures from {path}: {payload.get('error')}"]
                details = payload.get("details")
                if isinstance(details, list):
                    for item in details:
                        lines.append(f"  - {json.dumps(item, ensure_ascii=False)}")
                elif details is not None:
                    lines.append(f"  - {json.dumps(details, ensure_ascii=False)}")
                raise requests.HTTPError("\n".join(lines), response=r)
        r.raise_for_status()
        if "mcpFakes" in body:
            payload = self._json_or_none(r)
            if not isinstance(payload, dict) or "mcpFakesAdded" not in payload:
                raise RuntimeError(
                    f"aimock server too old for mcpFakes: {path} has mcpFakes, but "
                    f"the server's answer has no mcpFakesAdded ({r.text})"
                )
        return self

    @staticmethod
    def _json_or_none(r: requests.Response) -> Any:
        try:
            return r.json()
        except ValueError:
            return None

    @classmethod
    def _rejects_missing_fixtures(cls, r: requests.Response) -> bool:
        """True for the 400 an aimock gives a body with no ``fixtures`` array."""
        if r.status_code != 400:
            return False
        payload = cls._json_or_none(r)
        return (
            isinstance(payload, dict)
            and payload.get("error") == 'Missing or invalid "fixtures" array'
            and not payload.get("details")
        )

    def clear_fixtures(self) -> AIMockServer:
        """Delete all fixtures via ``DELETE /__aimock/fixtures``."""
        self._control_request("DELETE", "/fixtures", timeout=5).raise_for_status()
        return self

    def reset(self) -> AIMockServer:
        """Full reset via ``POST /__aimock/reset``: clears fixtures, journal
        entries and fixture match-counts, video/fal job state, and the Gemini
        counters."""
        self._control_request("POST", "/reset", timeout=5).raise_for_status()
        return self

    def reset_fixtures(self) -> AIMockServer:
        """Alias for :meth:`reset` — a full reset, not a fixtures-only one.

        The name is kept for compatibility; ``DELETE /__aimock/fixtures``
        (:meth:`clear_fixtures`) is the fixtures-only call.
        """
        return self.reset()

    def reset_journal(self) -> AIMockServer:
        """Clear ONLY the request journal, leaving fixtures intact, via
        ``POST /__aimock/reset/journal``."""
        self._control_request("POST", "/reset/journal", timeout=5).raise_for_status()
        return self

    def get_journal(self) -> list[dict[str, Any]]:
        """Return all recorded journal entries."""
        r = self._control_request("GET", "/journal", timeout=5)
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
        self._control_request("POST", "/error",
            json={"status": status, "body": body or {}},
            timeout=5,
        ).raise_for_status()
        return self

    # ── MCP fakes (spec RP6-RP8, TI3, TI4) ──────────────────────────────

    def _resolve_test_id(self, test_id: str | None) -> str:
        """An explicit ``test_id`` wins; ``None`` uses the current test's id."""
        if test_id is not None:
            return test_id
        if self._default_test_id is None:
            raise ValueError(
                "no default test id here (aimock_session or outside a test); "
                "pass an explicit test_id"
            )
        return self._default_test_id

    def fakes_for(
        self,
        test_id: str | None = None,
        context: str | None = None,
        mount: str = "/mcp",
    ) -> FakesTarget:
        """The MCP URL and headers that select the fakes for one test.

        A ``None`` ``test_id`` uses the current test's
        ``request.node.nodeid`` (the function-scoped ``aimock`` fixture
        only). The default id is used by the fakes helpers only; LLM and
        control traffic is not tagged.
        """
        tid = self._resolve_test_id(test_id)
        query = {"testId": tid, **({"context": context} if context else {})}
        headers = {"X-Test-Id": quote(tid, safe="")}
        if context:
            headers["X-AIMock-Context"] = quote(context, safe="")
        return FakesTarget(tid, f"{self.base_url}{mount}?{urlencode(query)}", headers)

    def fakes_report(
        self,
        test_id: str | None = None,
        context: str | None = None,
    ) -> dict[str, Any]:
        """Read the MCP fake report via ``GET /__aimock/mcp/fakes/report``.

        A ``None`` ``test_id`` uses the current test's id, as in
        :meth:`fakes_for`.
        """
        tid = self._resolve_test_id(test_id)
        params = {"testId": tid, **({"context": context} if context else {})}
        r = self._control_request("GET", "/mcp/fakes/report", params=params, timeout=5)
        r.raise_for_status()
        return r.json()  # type: ignore[no-any-return]

    def assert_fakes_report(
        self,
        report: dict[str, Any] | None = None,
        *,
        test_id: str | None = None,
        context: str | None = None,
        fail_on_unfaked: bool = False,
    ) -> None:
        """Raise :class:`AssertionError` when the MCP fake report fails.

        A report fails when it is not ``ok`` (a failure, an unconsumed
        entry, or evicted state) or, with ``fail_on_unfaked``, when a call
        was answered without a fake. With no ``report``, it is read with
        :meth:`fakes_report`. The message has the same lines, in the same
        order, as aimock's ``formatFakesReport``.
        """
        if report is None:
            report = self.fakes_report(test_id, context)
        unfaked_fails = fail_on_unfaked and bool(report.get("unfaked"))
        if report.get("ok") is True and not unfaked_fails:
            return
        raise AssertionError(format_fakes_report(report, fail_on_unfaked=fail_on_unfaked))

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
                        headers = self._control_headers()
                        r = requests.get(f"{url}/__aimock/health", headers=headers, timeout=0.5)
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



def _json_text(value: Any) -> str:
    """``value`` as one line of JSON, as ``JSON.stringify`` writes it."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def format_fakes_report(report: dict[str, Any], *, fail_on_unfaked: bool = False) -> str:
    """The report failure message: aimock's ``formatFakesReport``, line for line.

    A header naming the test id (and context), then one line per failure,
    one per unconsumed entry, the evicted line, and, with
    ``fail_on_unfaked``, one line per unfaked call.
    """
    test_id = report.get("testId")
    context = report.get("context")
    who = "no test id" if test_id is None else f"testId {_json_text(test_id)}"
    ctx = "" if context is None else f", context {_json_text(context)}"
    lines = [f"aimock MCP fakes report failed ({who}{ctx}):"]
    for f in report.get("failures", []):
        # A call sent with no ``arguments`` has no ``args`` key; aimock writes
        # ``undefined`` for it.
        args = _json_text(f["args"]) if "args" in f else "undefined"
        lines.append(
            f"  failure {f['code']}: tools/call {f['tool']} on {f['mount']} with {args}"
        )
    for u in report.get("unconsumed", []):
        lines.append(f"  unconsumed: {u['entryId']} ({u['mount']} {u['tool']})")
    if report.get("evicted"):
        lines.append(
            "  evicted: this test id's fake state was evicted by the per-mount test-id cap, "
            "or its event log overflowed (1000 events); the report is incomplete"
        )
    if fail_on_unfaked:
        for u in report.get("unfaked", []):
            lines.append(f"  unfaked: tools/call {u['tool']} on {u['mount']} answered by {u['answeredBy']}")
    return "\n".join(lines)
