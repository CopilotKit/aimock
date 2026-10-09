#!/usr/bin/env bash
# HC3 value checks (rr: 10.4 items 4 and 6) against one @copilotkit/aimock tarball:
#   1. record the REAL server-everything upstream through `llmock --mcp-record`,
#      then stop the upstream (every later step runs with it gone);
#   2. a Mastra Agent (aimock LLM fixtures + MCPClient on fakesFor().mcpUrl)
#      replays the recording: same results, fakes report ok;
#   3. the Python `mcp` SDK replays the recording: same results, OK 5/5, and a
#      changed call is MCP_FAKE_MISMATCH;
#   4. with one recorded `args` value broken ("hi" -> "hello"), both clients
#      fail with MCP_FAKE_MISMATCH (agent: journal and fakes report).
# If the tarball cannot record, steps 2-4 use the checked-in recording in
# fixtures/recorded/. KEEP_RECORDING=1 copies a fresh recording back there.
# Needs pnpm and uv. Usage: ./run.sh <path/to/copilotkit-aimock-*.tgz>
set -euo pipefail

tarball="${1:?usage: run.sh <path/to/copilotkit-aimock-*.tgz>}"
tarball="$(cd "$(dirname "$tarball")" && pwd)/$(basename "$tarball")"
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/aimock-mcp-record-replay-agents.XXXXXX")"
NODE="$(command -v node)"
UP_PORT=3901
REC_PORT=4131
REP_PORT=4132
PIDS=()
cleanup() {
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  rm -rf "$work"
}
trap cleanup EXIT

# wait_for <file> <pattern> <pid>: until the pattern is in the file (30 s at
# most). Returns 1 at once when the process exits first, and prints the file.
wait_for() {
  local _
  for _ in $(seq 1 150); do
    if grep -q "$2" "$1" 2>/dev/null; then return 0; fi
    if ! kill -0 "$3" 2>/dev/null; then
      echo "process $3 exited before '$2' appeared in $(basename "$1"):"
      cat "$1"
      return 1
    fi
    sleep 0.2
  done
  echo "timed out waiting for '$2' in $(basename "$1"):"
  cat "$1"
  return 1
}

stop() {
  kill "$@" 2>/dev/null || true
  wait "$@" 2>/dev/null || true
}

# Proof that a replay is offline: nothing answers on the upstream port.
upstream_gone() {
  if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$UP_PORT/mcp"; then
    echo "UPSTREAM_DOWN=false (something answers on :$UP_PORT)"
    exit 1
  fi
  echo "UPSTREAM_DOWN=true (connection to :$UP_PORT refused)"
}

cp -R "$here"/. "$work"/
rm -rf "$work/node_modules" "$work/run.sh" "$work/.venv"
cd "$work"
# The checked-in dependency links the repo; the run installs the tarball instead.
node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync("package.json","utf8"));delete p.dependencies["@copilotkit/aimock"];fs.writeFileSync("package.json",JSON.stringify(p,null,2)+"\n")'
echo "== tarball: $tarball"
pnpm add "$tarball" >install.log 2>&1 || {
  cat install.log
  exit 1
}
echo "== installed: $(node -p 'require("./node_modules/@copilotkit/aimock/package.json").version')"
CLI="$work/node_modules/@copilotkit/aimock/dist/cli.js"
uv venv --quiet --python 3.12 .venv
uv pip install --quiet --python .venv/bin/python -r python/requirements.txt
echo "== python: $(.venv/bin/python --version), mcp $(.venv/bin/python -c 'import importlib.metadata as m; print(m.version("mcp"))')"
export CI=1 NO_COLOR=1 MASTRA_TELEMETRY_DISABLED=1

echo
echo "== 1. record the real upstream (server-everything) through llmock --mcp-record"
# get-env returns the upstream's whole environment: scrub it (plan rule 0.6).
env -i PATH=/usr/bin:/bin HOME=/var/empty PORT=$UP_PORT AIMOCK_TEST_SECRET=s3cr3t-value-123 \
  "$NODE" node_modules/@modelcontextprotocol/server-everything/dist/index.js streamableHttp \
  >up.log 2>&1 &
UP=$!
PIDS+=("$UP")
wait_for up.log 'listening on port' "$UP"
rm -rf fixtures/recorded # a recording replays existing entries: start empty
AIMOCK_RECORD_SECRET_VALUES=s3cr3t-value-123 \
  node "$CLI" --port $REC_PORT --fixtures fixtures --mcp-record /mcp=http://127.0.0.1:$UP_PORT/mcp \
  >rec.log 2>&1 &
AM=$!
PIDS+=("$AM")
LIVE=""
if wait_for rec.log 'listening on' "$AM"; then
  AIMOCK_URL=http://127.0.0.1:$REC_PORT OUT="$work" node record.mjs
  LIVE="$work/results-record.json"
  RECORD=ok
else
  RECORD=failed
fi
stop "$AM" "$UP" # the upstream is GONE from here on
REC_FILE=fixtures/recorded/mcp--record/mcp.json
if [ "$RECORD" = ok ] && [ -f "$REC_FILE" ]; then
  echo "RECORDED_FILE=$REC_FILE SECRET_COUNT=$(grep -c s3cr3t "$REC_FILE" || true)"
  if [ "${KEEP_RECORDING:-}" = 1 ]; then
    rm -rf "$here/fixtures/recorded"
    cp -R fixtures/recorded "$here/fixtures/recorded"
    echo "KEEP_RECORDING: copied to $here/fixtures/recorded"
  fi
else
  RECORD=failed
  echo "RECORD=failed; steps 2-4 use the checked-in fixtures/recorded/"
  rm -rf fixtures/recorded
  cp -R "$here/fixtures/recorded" fixtures/recorded
fi

# replay_python <fixtures dir> <label>: an aimock serving the fixtures, then replay.py.
replay_python() {
  node "$CLI" --port $REP_PORT --fixtures "$1" >"rep-$2.log" 2>&1 &
  local rp=$!
  PIDS+=("$rp")
  local code=0
  if wait_for "rep-$2.log" 'listening on' "$rp"; then
    .venv/bin/python python/replay.py "http://127.0.0.1:$REP_PORT" "$1/recorded/mcp--record/mcp.json" \
      ${LIVE:+--live "$LIVE"} || code=$?
  else
    code=1
  fi
  stop "$rp"
  return "$code"
}

echo
echo "== 2. Mastra agent replays the recording (offline)"
upstream_gone
set +e
REPLAY_FIXTURES="$work/fixtures" REPLAY_LIVE="$LIVE" pnpm exec vitest run 2>&1
AGENT=$?
set -e
echo "== exit $AGENT: Mastra agent replay"

echo
echo "== 3. Python mcp SDK replays the recording (offline)"
upstream_gone
set +e
replay_python "$work/fixtures" good
PY=$?
set -e
echo "== exit $PY: Python mcp replay"

echo
echo "== 4. one recorded args value broken (echo \"hi\" -> \"hello\")"
cp -R fixtures fixtures-broken
node -e '
const fs = require("fs");
const f = process.argv[1];
const doc = JSON.parse(fs.readFileSync(f, "utf8"));
const block = Array.isArray(doc.mcpFakes) ? doc.mcpFakes[0] : doc.mcpFakes;
block.tools.find((t) => t.name === "echo").calls[0].args.message = "hello";
fs.writeFileSync(f, JSON.stringify(doc, null, 2) + "\n");
' fixtures-broken/recorded/mcp--record/mcp.json
upstream_gone
set +e
REPLAY_FIXTURES="$work/fixtures-broken" REPLAY_LIVE="$LIVE" pnpm exec vitest run >agent-broken.log 2>&1
AGENT_BROKEN=$?
set -e
cat agent-broken.log
echo "== exit $AGENT_BROKEN: Mastra agent replay, args broken"
JOURNAL_MISMATCH=$(grep -c 'AGENT_JOURNAL .*"outcome":"mismatch"' agent-broken.log || true)
REPORT_MISMATCH=$(grep -c 'failure MCP_FAKE_MISMATCH: tools/call echo' agent-broken.log || true)
echo "AGENT_BROKEN journal mismatch lines=$JOURNAL_MISMATCH, report MCP_FAKE_MISMATCH lines=$REPORT_MISMATCH"
set +e
replay_python "$work/fixtures-broken" broken
PY_BROKEN=$?
set -e
echo "== exit $PY_BROKEN: Python mcp replay, args broken"

echo
echo "== verdict"
echo "record=$RECORD agent=$AGENT python=$PY agent_broken=$AGENT_BROKEN python_broken=$PY_BROKEN"
if [ "$RECORD" = ok ] && [ "$AGENT" = 0 ] && [ "$PY" = 0 ] && [ "$AGENT_BROKEN" != 0 ] \
  && [ "$JOURNAL_MISMATCH" -gt 0 ] && [ "$REPORT_MISMATCH" -gt 0 ] && [ "$PY_BROKEN" != 0 ]; then
  echo "VERDICT=PASS"
  exit 0
fi
echo "VERDICT=FAIL"
exit 1
