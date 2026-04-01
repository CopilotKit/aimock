# The aimock plugin is auto-registered via the pytest11 entry point.
# This file exists so pytest recognises this directory as a test root.

import os
import pathlib

# Auto-detect local repo build for development.  If AIMOCK_CLI_PATH is not
# already set and a built cli.js exists at the repo root, use it directly
# so tests run against the local build instead of downloading from npm.
REPO_ROOT = pathlib.Path(__file__).parent.parent.parent.parent
LOCAL_CLI = REPO_ROOT / "dist" / "cli.js"

if LOCAL_CLI.exists() and "AIMOCK_CLI_PATH" not in os.environ:
    os.environ["AIMOCK_CLI_PATH"] = str(LOCAL_CLI)
