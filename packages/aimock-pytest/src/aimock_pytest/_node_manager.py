"""Handles Node.js detection and npm tarball caching for aimock."""

from __future__ import annotations

try:
    import fcntl
except ImportError:
    fcntl = None  # Windows — file locking not available

import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

import requests

from aimock_pytest._version import AIMOCK_VERSION


class NodeManager:
    """Manages node binary detection and aimock npm package caching."""

    # Use @copilotkit/aimock since that's the published npm package name.
    _NPM_TARBALL_URL = (
        "https://registry.npmjs.org/@copilotkit/aimock/-/aimock-{version}.tgz"
    )
    _MIN_NODE_MAJOR = 20

    def __init__(
        self,
        version: str = AIMOCK_VERSION,
        cache_dir: str | Path | None = None,
        node_path: str | None = None,
    ) -> None:
        self.version = version
        self._custom_cache_dir = Path(cache_dir) if cache_dir else None
        self._custom_node_path = node_path

    # ── public API ──────────────────────────────────────────────────────

    def ensure_installed(self) -> Path:
        """Return path to the aimock ``dist/cli.js``.  Downloads if needed.

        If ``AIMOCK_CLI_PATH`` is set, returns that path directly (bypassing
        the npm tarball download entirely).  This is used for local development
        and CI where we test against the repo's own build.
        """
        env_cli = os.environ.get("AIMOCK_CLI_PATH")
        if env_cli:
            p = Path(env_cli)
            if not p.is_file():
                raise RuntimeError(
                    f"AIMOCK_CLI_PATH is set to {env_cli!r} but the file does not exist"
                )
            return p

        cli_js = self._package_dir() / "dist" / "cli.js"
        if cli_js.is_file():
            return cli_js

        self._download_tarball()

        if not cli_js.is_file():
            raise RuntimeError(
                f"Expected cli.js at {cli_js} but it was not found after extraction"
            )
        return cli_js

    def find_node(self) -> str:
        """Find the node binary.  Checks ``AIMOCK_NODE_PATH`` env, the
        constructor override, then ``PATH``."""
        # Explicit override from constructor
        if self._custom_node_path:
            self._verify_node(self._custom_node_path)
            return self._custom_node_path

        # Environment variable
        env_path = os.environ.get("AIMOCK_NODE_PATH")
        if env_path:
            self._verify_node(env_path)
            return env_path

        # PATH lookup
        node = shutil.which("node")
        if node is None:
            raise RuntimeError(
                "node is not installed or not on PATH.  "
                "Install Node.js >= 20 or set AIMOCK_NODE_PATH."
            )
        self._verify_node(node)
        return node

    # ── internal ────────────────────────────────────────────────────────

    def _cache_dir(self) -> Path:
        """``~/.cache/aimock/{version}/`` or ``AIMOCK_CACHE_DIR`` env."""
        base: Path
        if self._custom_cache_dir:
            base = self._custom_cache_dir
        else:
            env = os.environ.get("AIMOCK_CACHE_DIR")
            if env:
                base = Path(env)
            else:
                base = Path.home() / ".cache" / "aimock"
        return base / self.version

    def _package_dir(self) -> Path:
        """The extracted package directory inside the cache."""
        return self._cache_dir() / "package"

    def _download_tarball(self) -> None:
        """Download the @copilotkit/aimock tarball from the npm registry and
        extract it into the cache directory.

        Uses file-locking (``fcntl.flock``) so parallel pytest-xdist workers
        don't race.  On Windows where fcntl is unavailable, locking is skipped.
        """
        cache = self._cache_dir()
        cache.mkdir(parents=True, exist_ok=True)

        _fcntl = fcntl  # local binding for type narrowing
        if _fcntl is not None:
            lock_path = cache / ".lock"
            lock_fd = open(lock_path, "w")
            _fcntl.flock(lock_fd, _fcntl.LOCK_EX)
        else:
            lock_fd = None

        try:
            # Double-check after acquiring lock — another worker may have
            # finished the download while we waited.
            if (self._package_dir() / "dist" / "cli.js").is_file():
                return

            url = self._NPM_TARBALL_URL.format(version=self.version)
            resp = requests.get(url, timeout=60, stream=True)
            resp.raise_for_status()

            with tempfile.NamedTemporaryFile(suffix=".tgz", delete=False) as tmp:
                for chunk in resp.iter_content(chunk_size=65536):
                    tmp.write(chunk)
                tmp_path = tmp.name

            try:
                # npm tarballs always contain a top-level ``package/`` dir.
                with tarfile.open(tmp_path, "r:gz") as tar:
                    if sys.version_info >= (3, 12):
                        tar.extractall(path=str(cache), filter="data")  # type: ignore[call-overload]
                    else:
                        tar.extractall(path=str(cache))
            finally:
                os.unlink(tmp_path)
        finally:
            if lock_fd is not None and _fcntl is not None:
                _fcntl.flock(lock_fd, _fcntl.LOCK_UN)
                lock_fd.close()

    def _verify_node(self, node_path: str) -> None:
        """Verify the node binary exists and is >= the minimum version."""
        try:
            result = subprocess.run(
                [node_path, "--version"],
                capture_output=True,
                text=True,
                timeout=10,
            )
        except FileNotFoundError:
            raise RuntimeError(f"node binary not found at {node_path}")
        except subprocess.TimeoutExpired:
            raise RuntimeError(f"node --version timed out for {node_path}")

        version_str = result.stdout.strip()
        match = re.match(r"v(\d+)\.", version_str)
        if not match:
            raise RuntimeError(
                f"Could not parse node version from: {version_str!r}"
            )

        major = int(match.group(1))
        if major < self._MIN_NODE_MAJOR:
            raise RuntimeError(
                f"Node.js >= {self._MIN_NODE_MAJOR} required, "
                f"found {version_str} at {node_path}"
            )
