#!/usr/bin/env bash
# HC3 proof: record a REAL upstream MCP server (server-everything) through the
# llmock CLI, stop the upstream, and replay the recording offline; then the same
# record-and-replay through a standalone MCPMock.
# Usage: ./proof.sh <path/to/cli.js> <work-dir>
# Run `pnpm install` in this directory first (it links the repo's build).
set -euo pipefail

CLI="$(cd "$(dirname "${1:?usage: proof.sh <cli.js> <work-dir>}")" && pwd)/$(basename "$1")"
W="${2:?usage: proof.sh <cli.js> <work-dir>}"
mkdir -p "$W/fx"
W="$(cd "$W" && pwd)"
cd "$(dirname "$0")"

PIDS=()
cleanup() {
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT

# wait_for <file> <pattern> <pid>: until the pattern is in the file (30 s at
# most). Fails at once, printing the file, when the process exits first.
wait_for() {
  local i
  for i in $(seq 1 150); do
    if grep -q "$2" "$1" 2>/dev/null; then return 0; fi
    if ! kill -0 "$3" 2>/dev/null; then
      echo "process $3 exited before '$2' appeared in $1:" >&2
      cat "$1" >&2
      return 1
    fi
    sleep 0.2
  done
  echo "timed out waiting for '$2' in $1:" >&2
  cat "$1" >&2
  return 1
}

# The upstream's get-env tool returns its whole environment: scrub it (rule 0.6).
start_upstream() {
  env -i PATH="$PATH" HOME="$HOME" PORT=3901 AIMOCK_TEST_SECRET=s3cr3t-value-123 \
    npx -y @modelcontextprotocol/server-everything@2026.8.31 streamableHttp >"$1" 2>&1 &
  UP=$!
  PIDS+=("$UP")
  wait_for "$1" 'listening on port' "$UP"
}

stop() {
  kill "$@" 2>/dev/null || true
  wait "$@" 2>/dev/null || true
}

echo "== CLI: $CLI"
echo "== mounted path: record through --mcp-record"
start_upstream "$W/up.log"
AIMOCK_RECORD_SECRET_VALUES=s3cr3t-value-123 \
  node "$CLI" --port 4124 --fixtures "$W/fx" --mcp-record /mcp=http://127.0.0.1:3901/mcp >"$W/rec.log" 2>&1 &
AM=$!
PIDS+=("$AM")
wait_for "$W/rec.log" 'listening on' "$AM"
AIMOCK_URL=http://127.0.0.1:4124 MODE=record OUT="$W" node record-then-replay.mjs
F="$W/fx/recorded/mcp--record/mcp.json"
ls -l "$F"
echo "SECRET_COUNT=$(grep -c s3cr3t "$F" || true)"
node -e 'const f=require(process.argv[1]);console.log("WARNINGS="+JSON.stringify(f._warnings))' "$F"
stop "$AM" "$UP" # the upstream is GONE from here on

for SPEED in 1 100; do
  node "$CLI" --port 4124 --replay-speed "$SPEED" --fixtures "$W/fx" >"$W/rep$SPEED.log" 2>&1 &
  RP=$!
  PIDS+=("$RP")
  wait_for "$W/rep$SPEED.log" 'listening on' "$RP"
  echo "== replay offline, SPEED=$SPEED"
  AIMOCK_URL=http://127.0.0.1:4124 MODE=replay OUT="$W" FILE="$F" node record-then-replay.mjs
  stop "$RP"
done

echo "== standalone path (AM1 b): record, then replay offline"
start_upstream "$W/up2.log"
mkdir -p "$W/sa"
SECRET=s3cr3t-value-123 UPSTREAM=http://127.0.0.1:3901/mcp FIXTURES="$W/sa" MODE=record \
  node standalone.mjs >"$W/sa.log" 2>&1 &
SA=$!
PIDS+=("$SA")
wait_for "$W/sa.log" STANDALONE_URL "$SA"
SAURL=$(sed -n 's/^STANDALONE_URL=//p' "$W/sa.log")
AIMOCK_URL="$SAURL" MODE=record OUT="$W/sa" node record-then-replay.mjs
SF="$W/sa/mcp--record/mcp.json"
ls -l "$SF"
echo "SECRET_COUNT=$(grep -c s3cr3t "$SF" || true)"
stop "$SA" "$UP"

FILE="$SF" MODE=replay node standalone.mjs >"$W/sa2.log" 2>&1 &
SA=$!
PIDS+=("$SA")
wait_for "$W/sa2.log" STANDALONE_URL "$SA"
SAURL=$(sed -n 's/^STANDALONE_URL=//p' "$W/sa2.log")
echo "== standalone replay offline"
AIMOCK_URL="$SAURL" MODE=replay OUT="$W/sa" FILE="$SF" node record-then-replay.mjs
stop "$SA"
