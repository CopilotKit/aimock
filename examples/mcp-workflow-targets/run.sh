#!/usr/bin/env bash
# HC4 proof (WF2 + WF3): run the Mastra Workflow and LangGraph pipeline tests
# in this directory against one @copilotkit/aimock tarball and one fixture.
# Usage: ./run.sh <path/to/copilotkit-aimock-*.tgz> <fixture.json>
# Set AIMOCK_FAKES_REPORT=off to see what the same tests do without the report.
set -euo pipefail

tarball="${1:?usage: run.sh <path/to/copilotkit-aimock-*.tgz> <fixture.json>}"
fixture="${2:?usage: run.sh <path/to/copilotkit-aimock-*.tgz> <fixture.json>}"
tarball="$(cd "$(dirname "$tarball")" && pwd)/$(basename "$tarball")"
here="$(cd "$(dirname "$0")" && pwd)"
fixture="$(cd "$(dirname "$fixture")" && pwd)/$(basename "$fixture")"
work="$(mktemp -d "${TMPDIR:-/tmp}/aimock-mcp-workflow-targets.XXXXXX")"
trap 'rm -rf "$work"' EXIT

cp -R "$here"/. "$work"/
rm -rf "$work/node_modules" "$work/run.sh"
cd "$work"
# The checked-in dependency links the repo; the proof installs the tarball instead.
node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync("package.json","utf8"));delete p.dependencies["@copilotkit/aimock"];fs.writeFileSync("package.json",JSON.stringify(p,null,2)+"\n")'
echo "== tarball: $tarball"
pnpm add "$tarball" >install.log 2>&1 || { cat install.log; exit 1; }
echo "== installed: $(node -p "require(\"./node_modules/@copilotkit/aimock/package.json\").version")"

# Only the correct fixture asserts each step's scripted answer; with a broken
# fixture the test body just runs the pipeline, and the fakes report decides.
expect=any
[ "$(basename "$fixture")" = "workflow.json" ] && expect=scripted
echo "== fixture: $(basename "$fixture")  WF_EXPECT=$expect  AIMOCK_FAKES_REPORT=${AIMOCK_FAKES_REPORT:-fail}"

export CI=1 NO_COLOR=1 WF_FIXTURE="$fixture" WF_EXPECT="$expect"
set +e
pnpm exec vitest run 2>&1
code=$?
set -e
echo "== exit $code: vitest run ($(basename "$fixture"))"
exit "$code"
