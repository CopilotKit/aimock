#!/usr/bin/env bash
# HC1 proof: run the Vitest and Jest tests in this directory against one
# @copilotkit/aimock tarball (the base release, or the PR's `pnpm pack`).
# Usage: ./run.sh <path/to/copilotkit-aimock-*.tgz>
set -euo pipefail

tarball="${1:?usage: run.sh <path/to/copilotkit-aimock-*.tgz>}"
tarball="$(cd "$(dirname "$tarball")" && pwd)/$(basename "$tarball")"
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/aimock-fakes-report-proof.XXXXXX")"
trap 'rm -rf "$work"' EXIT

cp -R "$here"/. "$work"/
rm -rf "$work/node_modules" "$work/run.sh"
cd "$work"
# The checked-in dependency links the repo; the proof installs the tarball instead.
node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync("package.json","utf8"));delete p.dependencies["@copilotkit/aimock"];fs.writeFileSync("package.json",JSON.stringify(p,null,2)+"\n")'
echo "== tarball: $tarball"
pnpm add "$tarball" >install.log 2>&1 || { cat install.log; exit 1; }
echo "== installed: $(node -p "require(\"./node_modules/@copilotkit/aimock/package.json\").version")"

run() {
  echo
  echo "== $*"
  set +e
  "$@" 2>&1
  local code=$?
  set -e
  echo "== exit $code: $*"
}

export CI=1 NO_COLOR=1
run pnpm exec vitest run
run env AIMOCK_FAKES_REPORT=off pnpm exec vitest run swallowed.test.ts unused.test.ts
run pnpm exec jest
run env AIMOCK_FAKES_REPORT=off pnpm exec jest jest/swallowed.test.cjs
