#!/usr/bin/env bash
#
# ci-merge-gate.sh — the auto-merge green-gate decision, factored out of the
# fix-drift workflow so it can be unit-tested in isolation.
#
# Reads the machine-readable check-state JSON produced by
# `gh pr checks <pr> --json name,state,bucket` (an array of objects) from a
# file argument or stdin, and exits 0 ONLY when the PR is truly green:
#
#   1. at least one check is in the "pass" bucket (>=1), AND
#   2. EVERY present check lands in a recognized bucket and is either in the
#      "pass" bucket or on the explicit, documented IGNORE_CONTEXTS allow-list
#      — an unknown bucket/state, or a non-ignored skipped/neutral/pending/
#      fail/cancel check, fails the gate (we never silently accept), AND
#   3. every REQUIRED context is present AND concluded in the "pass" bucket.
#
# Policy on neutral/skipped: the "skipping" bucket does NOT count toward
# pass>=1, a required context in "skipping" is treated as NOT satisfied, and a
# NON-required skipped/neutral check FAILS the gate unless its exact name is on
# IGNORE_CONTEXTS. This closes the "newly-added gating check resolves skipped/
# neutral and is silently ignored → false-green" hole: to accept a skipped
# check you must name it explicitly.
#
# `gh pr checks --json` buckets (from cli/cli): pass | fail | pending |
# skipping | cancel. `state` is the raw check/status conclusion. We key the
# decision off `bucket` and fall back to `state` when bucket is absent so the
# gate is robust to either shape. Any check whose bucket/state does not map to
# one of the five recognized buckets is treated as NOT-pass (fails the gate);
# the recognized buckets must sum to the total check count or we abort.
#
# Required contexts default to the set a drift-fix PR must pass on this repo
# (Static Quality + Unit Tests matrix + Drift Tests PR legs + Zizmor). Override
# via REQUIRED_CONTEXTS (newline- or comma-separated) when the expected set
# changes. An empty/whitespace-only REQUIRED_CONTEXTS is a configuration error
# (exit 2), never a silent no-op that lets a PR through with zero requirements.
#
# Non-required checks that are legitimately skipped may be allow-listed via
# IGNORE_CONTEXTS (newline- or comma-separated, same parsing as
# REQUIRED_CONTEXTS). Anything not on that list and not passing fails the gate.
#
# Usage:
#   ci-merge-gate.sh [checks.json]        # or pipe JSON on stdin
#   REQUIRED_CONTEXTS="a,b,c" ci-merge-gate.sh checks.json
#   IGNORE_CONTEXTS="notify,drift" ci-merge-gate.sh checks.json
#
# Exit codes:
#   0  true-green — safe to merge
#   1  not green — do NOT merge (reason printed to stderr)
#   2  usage / malformed-input / configuration error. This is a FAIL-CLOSED
#      assertion, not a downstream side effect: a non-array/non-object input, a
#      non-string .bucket/.state, an empty/contradictory required set, or ANY
#      failure of the SINGLE guarded verdict computation (jq parse/runtime
#      error, empty jq output, or a verdict object lacking a boolean .green)
#      exits 2 here rather than reading an emptied jq result as green. The whole
#      pass/fail decision is computed by ONE jq program and validated ONCE
#      before the shell reads any field; the gate never merges on a verdict it
#      could not trust.

set -euo pipefail

DEFAULT_REQUIRED_CONTEXTS='prettier
eslint
exports
commitlint
test (20)
test (22)
test (24)
agui-schema-drift
drift-live-pr
zizmor'

# Non-required checks that legitimately do not run on a drift-fix PR and must
# NOT block the merge when they resolve skipped/neutral. Keep this list tight —
# every name here is an explicit, reviewed decision to tolerate a non-passing
# state for that context.
DEFAULT_IGNORE_CONTEXTS='notify
drift'

REQUIRED_CONTEXTS="${REQUIRED_CONTEXTS:-$DEFAULT_REQUIRED_CONTEXTS}"
IGNORE_CONTEXTS="${IGNORE_CONTEXTS:-$DEFAULT_IGNORE_CONTEXTS}"

# Read the check JSON from the file arg or stdin.
if [ "$#" -ge 1 ] && [ "$1" != "-" ]; then
  if [ ! -f "$1" ]; then
    echo "::error::ci-merge-gate: input file not found: $1" >&2
    exit 2
  fi
  CHECKS_JSON="$(cat "$1")"
else
  CHECKS_JSON="$(cat)"
fi

if [ -z "${CHECKS_JSON//[[:space:]]/}" ]; then
  echo "::error::ci-merge-gate: empty check JSON — treating as NOT green" >&2
  exit 1
fi

# Validate it parses as a JSON array whose every element is an object. An
# array of non-objects (e.g. [1,2,3] or ["a"]) would pass a bare type=="array"
# guard and then crash jq on `.bucket` indexing (undocumented exit 5); the
# script's contract is 0/1/2 only, so malformed shapes must exit 2 here.
if ! echo "$CHECKS_JSON" | jq -e 'type == "array"' >/dev/null 2>&1; then
  echo "::error::ci-merge-gate: check JSON is not a JSON array" >&2
  exit 2
fi
if ! echo "$CHECKS_JSON" | jq -e 'all(.[]; type == "object")' >/dev/null 2>&1; then
  echo "::error::ci-merge-gate: check JSON array contains a non-object element — malformed input" >&2
  exit 2
fi

# Field-type guard: a valid JSON object can still carry a non-string `.bucket`
# or `.state` (a number/object/array) — that passes the object guard above but
# is malformed check data from `gh` and, without this guard, would throw
# "explode input must be a string" inside `ascii_downcase` (undocumented jq
# exit 5). We validate here and FAIL CLOSED with the documented config-error
# exit 2. Absent/null fields are fine (handled downstream as derive-from-state /
# unknown); only a PRESENT non-string value is rejected.
if ! echo "$CHECKS_JSON" | jq -e \
  'all(.[]; (.bucket | type | . == "string" or . == "null") and (.state | type | . == "string" or . == "null"))' \
  >/dev/null 2>&1; then
  echo "::error::ci-merge-gate: a check has a non-string .bucket or .state — malformed check data, treating as config error" >&2
  exit 2
fi

# Normalize a comma-/newline-separated list into a JSON array so jq can reason
# over it. Trims surrounding whitespace, drops blank entries. Uses `|| true` so
# an all-blank input (grep matches nothing → exit 1) does not abort under
# `set -e`; the caller inspects the resulting array length.
normalize_list() {
  printf '%s' "$1" \
    | tr ',' '\n' \
    | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' \
    | { grep -v '^$' || true; } \
    | jq -R . \
    | jq -s .
}

REQUIRED_JSON="$(normalize_list "$REQUIRED_CONTEXTS")"
IGNORE_JSON="$(normalize_list "$IGNORE_CONTEXTS")"

# An empty required set is a configuration error, not a silent green: a gate
# with zero requirements would merge a PR that ran no gating checks at all.
if [ "$(echo "$REQUIRED_JSON" | jq 'length')" -eq 0 ]; then
  echo "::error::ci-merge-gate: REQUIRED_CONTEXTS is empty or whitespace-only — refusing to run a gate with no required checks (config error)" >&2
  exit 2
fi

# Contradictory config: a name that is BOTH required and ignored is
# self-contradictory (a required context can never be "safe to skip"). Rather
# than silently resolve the ambiguity one way, fail closed as a config error.
CONFLICTING_CONTEXTS="$(
  jq -rn --argjson req "$REQUIRED_JSON" --argjson ign "$IGNORE_JSON" \
    '$req - ($req - $ign) | .[]'
)"
if [ -n "$CONFLICTING_CONTEXTS" ]; then
  echo "::error::ci-merge-gate: context(s) appear in BOTH REQUIRED_CONTEXTS and IGNORE_CONTEXTS — contradictory config, refusing to run:" >&2
  while IFS= read -r line; do
    [ -n "$line" ] && echo "::error::  - $line" >&2
  done <<<"$CONFLICTING_CONTEXTS"
  exit 2
fi

# Effective bucket for a check: prefer `.bucket`; else derive from `.state`.
# gh buckets: pass | fail | pending | skipping | cancel. Anything we cannot map
# to one of those five becomes the sentinel "unknown" so it is counted, never
# silently dropped.
#
# `.bucket`/`.state` are coerced to strings BEFORE `ascii_downcase`: a valid
# JSON object can carry a non-string `.bucket` (e.g. a number or object) that
# passes the array-of-objects guard above but throws "explode input must be a
# string" inside `ascii_downcase` (undocumented jq exit 5). A non-string field
# is not a recognized bucket/state, so `coerce_str` maps it to "" which then
# resolves to the "unknown" sentinel — counted, never dropped, never a crash.
# shellcheck disable=SC2016  # jq program; $-vars are jq's, must NOT be shell-expanded
JQ_BUCKET='
  def known: ["pass","fail","pending","skipping","cancel"];
  def coerce_str: if type == "string" then . else "" end;
  def eff_bucket:
    ( if ((.bucket | coerce_str)) != "" then (.bucket | coerce_str | ascii_downcase)
      else
        (.state | coerce_str | ascii_downcase) as $s
        | if   ($s == "success") then "pass"
          elif ($s | test("^(neutral|skipped)$")) then "skipping"
          elif ($s | test("^(failure|error|action_required|startup_failure|timed_out)$")) then "fail"
          elif ($s | test("^(cancelled|canceled|stale)$")) then "cancel"
          elif ($s == "") then "unknown"
          else "pending"
          end
      end ) as $b
    | if (known | index($b)) != null then $b else "unknown" end;
'

# ---------------------------------------------------------------------------
# SINGLE GUARDED VERDICT (the structural fix that kills the recurring
# "bare-jq-assignment defaults to empty → green-signal" class).
#
# INVARIANT: there is EXACTLY ONE jq computation over the check data, and its
# output is validated ONCE before the shell reads any field from it. The old
# gate scored the checks through ~9 separate `VAR="$(echo "$CHECKS_JSON" | jq
# ...)"` command-substitutions. `set -e` does NOT guard a command-substitution
# RHS, so a jq crash in any of them produced an EMPTY string — and for several
# (notably UNACCEPTED_CHECKS and MISSING_REQUIRED, whose emptiness means "no
# unaccepted checks" / "no missing required") that empty read as the GREEN
# signal. Consolidating into one call + one assertion means ANY jq/parse
# failure is caught HERE as exit 2 (fail-closed), and it is structurally
# impossible for an unguarded empty jq result to be interpreted as green.
#
# The jq program computes the ENTIRE decision — the green/not-green boolean AND
# the human reason AND every scalar — inside jq, so the shell only consumes the
# already-validated object. It emits ONE JSON object:
#   { green: bool, reason: string, total, pass, pending, fail, cancel, skip,
#     unknown, unaccepted: [string], missing_required: [string] }
# The shell then asserts jq exited 0 AND produced non-empty valid JSON with a
# boolean `.green`; otherwise `::error::` + exit 2. There is NO bare
# `VAR=$(jq)` whose emptiness can be read as green anywhere below.
# ---------------------------------------------------------------------------

# shellcheck disable=SC2016  # jq program; $-vars are jq's, must NOT be shell-expanded
JQ_VERDICT="$JQ_BUCKET"'
  ('"$REQUIRED_JSON"') as $required
  | ('"$IGNORE_JSON"') as $ignored
  | . as $checks
  # Per-check effective bucket, computed once.
  | [ $checks[] | { name: .name, b: (. | eff_bucket) } ] as $scored
  | ($scored | length) as $total
  | ([ $scored[] | select(.b == "pass")     ] | length) as $pass
  | ([ $scored[] | select(.b == "pending")  ] | length) as $pending
  | ([ $scored[] | select(.b == "fail")     ] | length) as $fail
  | ([ $scored[] | select(.b == "cancel")   ] | length) as $cancel
  | ([ $scored[] | select(.b == "skipping") ] | length) as $skip
  | ([ $scored[] | select(.b == "unknown")  ] | length) as $unknown
  | ($pass + $pending + $fail + $cancel + $skip) as $recognized_sum
  # Non-passing checks that are neither required nor on the ignore allow-list.
  # Capture the element into $c first: inside `$required | index(...)` the pipe
  # rebinds `.` to $required (the array), so `.name` there would index the array
  # (jq error) — reference the captured $c.name instead.
  | [ $scored[]
      | . as $c
      | select($c.b != "pass")
      | select( ($required | index($c.name)) == null )
      | select( ($ignored  | index($c.name)) == null )
      | "\($c.name) [\($c.b)]"
    ] as $unaccepted
  # Required contexts that are NOT present-and-passing. Only STRING names of
  # pass-bucket checks can satisfy a requirement: a pass check with a
  # null/absent/non-string name counts toward pass>=1 but must NOT resolve a
  # named requirement.
  | ( [ $scored[] | select(.b == "pass") | .name | select(type == "string") ] ) as $passing
  | ( $required | map(. as $name | select( ($passing | index($name)) == null )) ) as $missing_required
  # ALL triggered reasons, in the same order the old sequence of `if` blocks
  # emitted them (a single check can trip more than one, e.g. a required
  # context in the cancel bucket trips BOTH "cancelled/stale" AND
  # "required context missing"). We collect every applicable reason rather than
  # short-circuiting on the first so the human-facing diagnostics — and the
  # tests that assert on specific reasons — see exactly the same messages as
  # before. An empty reasons array == green.
  | ( [ (if ($recognized_sum != $total) then "bucket sum mismatch — recognized=\($recognized_sum) total=\($total) (unknown-bucket check(s) present) — NOT green" else empty end),
        (if ($unknown > 0)              then "\($unknown) check(s) in an unrecognized bucket/state — NOT green" else empty end),
        (if ($pass < 1)                 then "no checks in '"'"'pass'"'"' bucket (pass=\($pass)) — NOT green" else empty end),
        (if ($pending > 0)              then "\($pending) check(s) still pending/queued/in_progress — NOT green" else empty end),
        (if ($fail > 0)                 then "\($fail) check(s) failed/errored — NOT green" else empty end),
        (if ($cancel > 0)               then "\($cancel) check(s) cancelled/stale — NOT green" else empty end),
        (if (($unaccepted | length) > 0) then "non-passing check(s) not required and not on IGNORE_CONTEXTS allow-list — NOT green" else empty end),
        (if (($missing_required | length) > 0) then "required context(s) missing or not passing" else empty end)
      ] ) as $reasons
  | {
      green: (($reasons | length) == 0),
      reasons: $reasons,
      total: $total,
      pass: $pass,
      pending: $pending,
      fail: $fail,
      cancel: $cancel,
      skip: $skip,
      unknown: $unknown,
      unaccepted: $unaccepted,
      missing_required: $missing_required
    }
'

# THE one guarded jq computation. Capture and IMMEDIATELY assert: jq exited 0
# AND emitted a non-empty object with a boolean `.green`. Any failure (parse
# error, runtime crash, empty output, missing/non-boolean `.green`) is a hard
# config error — exit 2, NEVER green. This assertion is what makes it
# impossible for an emptied jq result to be read as a pass.
set +e
VERDICT="$(echo "$CHECKS_JSON" | jq -c "$JQ_VERDICT")"
verdict_rc=$?
set -e
if [ "$verdict_rc" -ne 0 ] || [ -z "${VERDICT//[[:space:]]/}" ] \
  || ! printf '%s' "$VERDICT" | jq -e 'type == "object" and (.green | type == "boolean")' >/dev/null 2>&1; then
  echo "::error::ci-merge-gate: jq failed to compute a valid verdict over the input (parse/runtime error, empty output, or missing boolean .green) — cannot score checks, treating as config error" >&2
  exit 2
fi

# Extract scalars from the ALREADY-VALIDATED verdict object. These reads are
# safe: the object was asserted to be valid JSON with a boolean .green above,
# so a jq extraction here cannot silently produce a green-reading empty.
GREEN="$(printf '%s' "$VERDICT" | jq -r '.green')"
PASS_COUNT="$(printf '%s' "$VERDICT" | jq -r '.pass')"
SKIP_COUNT="$(printf '%s' "$VERDICT" | jq -r '.skip')"

if [ "$GREEN" != "true" ]; then
  # Emit every triggered reason, and — right after the unaccepted-checks reason
  # and the missing-required reason — the per-line `- <name>` detail so the
  # human-facing diagnostics match the previous multi-if output exactly.
  while IFS= read -r reason; do
    [ -z "$reason" ] && continue
    echo "::error::ci-merge-gate: $reason" >&2
    case "$reason" in
      "non-passing check(s) not required and not on IGNORE_CONTEXTS allow-list"*)
        printf '%s' "$VERDICT" | jq -r '.unaccepted[]?' | while IFS= read -r line; do
          [ -n "$line" ] && echo "::error::  - $line" >&2
        done
        ;;
      "required context(s) missing or not passing"*)
        printf '%s' "$VERDICT" | jq -r '.missing_required[]?' | while IFS= read -r line; do
          [ -n "$line" ] && echo "::error::  - $line" >&2
        done
        ;;
    esac
  done < <(printf '%s' "$VERDICT" | jq -r '.reasons[]?')
  exit 1
fi

echo "ci-merge-gate: GREEN — pass=$PASS_COUNT, pending=0, fail=0, cancel=0, skipping=$SKIP_COUNT (all allow-listed), all required contexts present and passing"
exit 0
