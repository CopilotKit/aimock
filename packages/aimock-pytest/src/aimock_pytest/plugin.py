"""pytest plugin — registers ``aimock`` and ``aimock_session`` fixtures.

Auto-discovered by pytest via the ``pytest11`` entry point in pyproject.toml.
"""

from __future__ import annotations

import pytest

from aimock_pytest._version import AIMOCK_VERSION
from aimock_pytest._node_manager import NodeManager
from aimock_pytest._server import AIMockServer


def pytest_addoption(parser: pytest.Parser) -> None:
    group = parser.getgroup("aimock", "aimock mock server options")
    group.addoption(
        "--aimock-node",
        default=None,
        help="Path to node binary (default: auto-detect from PATH)",
    )
    group.addoption(
        "--aimock-version",
        default=AIMOCK_VERSION,
        help=f"aimock npm package version to use (default: {AIMOCK_VERSION})",
    )


@pytest.fixture(scope="session")
def _aimock_node_manager(request: pytest.FixtureRequest) -> NodeManager:
    """Session-scoped :class:`NodeManager` — shared across all fixtures."""
    return NodeManager(
        version=request.config.getoption("--aimock-version"),
        node_path=request.config.getoption("--aimock-node"),
    )


@pytest.fixture
def aimock(_aimock_node_manager: NodeManager) -> AIMockServer:
    """Function-scoped aimock server.  A fresh server is started for every
    test that requests this fixture, and torn down afterwards."""
    server = AIMockServer(_aimock_node_manager, port=0)
    server.start()
    yield server  # type: ignore[misc]
    server.stop()


@pytest.fixture(scope="session")
def aimock_session(_aimock_node_manager: NodeManager) -> AIMockServer:
    """Session-scoped aimock server.  One server is shared across all tests
    that request this fixture."""
    server = AIMockServer(_aimock_node_manager, port=0)
    server.start()
    yield server  # type: ignore[misc]
    server.stop()
