"""Default `@copilotkit/aimock` npm version that aimock-pytest downloads and runs.

This is NOT the version of this Python package (see pyproject.toml for that) and
is NOT auto-synced — it is a hard pin to a published npm release. NodeManager
downloads exactly this version when AIMOCK_CLI_PATH is not set, so it must point
at a published `@copilotkit/aimock` release and be bumped to the release that
contains any new server routes/features the client calls (e.g. the reset-split
control routes ship in the next release). Keep it tracking npm releases.
"""

AIMOCK_VERSION = "1.35.1"
