# Request dependency verification

Use `mock.setRequestExpectations(testId, expectations)` on a running `LLMock` to
observe HTTP interactions without changing fixture selection or delaying traffic.
Each `RequestExpectation` has a unique nonblank `id`, a `match` with a `path`
(string or RegExp) and optional nonblank `method`, a nonnegative safe-integer
`count`, and optional `after` and `afterEach` prerequisite IDs. Registration rejects invalid
declarations, unknown prerequisites and cycles atomically. Forward references and
repeated prerequisite IDs are allowed. Registration copies the declarations and
replaces that scope's previous plan and observations. Only subsequent arrivals
count toward the new plan.

String paths match the original URL pathname exactly, before provider rewrites
or mount-prefix removal and without the query string. Regular expressions start
at index zero for every request, including global and sticky expressions, and
never modify the caller's expression. Methods match case-insensitively; omitting
the method accepts any method. Overlapping expectations observe independently:
one HTTP request counts once for each matching expectation, even if its body is
a protocol batch. WebSocket traffic and per-message events within an HTTP stream
are not observed. `/health`, `/ready`, `/metrics`, and paths beginning with
`/__aimock` are excluded. Other requests, including unmatched and rejected
requests, are observed when their headers arrive, before dispatch or body reads.

An `after` prerequisite is satisfied when at least its required count of responses has
finished sending before the dependent request arrives. Normal response completion
counts regardless of HTTP status; headers and partial streaming output do not.
Closing a response before completion counts as an abort, not a completion. A
request arriving before any prerequisite is satisfied increments `premature`
once; later completions never erase that violation. Zero-count prerequisites
are immediately satisfied. Independent branches may overlap. A completed
response still counts toward its own dependents even if its arrival was premature;
the earlier violation remains in the overall result.

Use `afterEach` for pipelined work: every dependent arrival needs one distinct
completed occurrence of each prerequisite, regardless of the declared counts.
The allowance is independent for each downstream expectation, so one producer
can feed two different branches. For a single downstream expectation, however,
the same occurrence cannot support two pending or finished requests. If all
`after` barriers and `afterEach` allowances hold, the arrival reserves all of its
allowances together. Otherwise it records one premature arrival and reserves
nothing. Finishing spends the reservations; aborting returns them for later
arrivals. Premature and excess requests still supply their own downstream
allowances if they finish normally. A zero expected count does not supply an
`afterEach` occurrence without a completed request.

The optional third argument to `setRequestExpectations` is
`RequestVerificationOptions`. Its `correlationHeader` must be a valid HTTP header
name. This restricts `afterEach` allowances to the same incoming header value,
captured before handlers run. Header names are case-insensitive and values exact;
missing and empty values share a pool. Omitting the option uses one pool for all
arrivals. Whole-batch `after` barriers and result counters remain aggregate.

`mock.verifyRequests(testId)` returns a detached `RequestVerificationResult`:
`{ ok, expectations }`. In declaration order, each `RequestExpectationResult`
contains `id`, `expected`, `started`, `completed`, `aborted`, `pending`, `missing`,
`excess`, and `premature`. Here `expected` is the declared count,
`pending = started - completed - aborted`, `missing = max(0, expected - started)`,
and `excess = max(0, started - expected)`. `ok` is true only when every expectation
has zero missing, excess, pending, aborted, and premature occurrences. An empty
or unregistered plan is satisfied. Reads neither consume nor change observations.
All four types are exported from the package root.

Test IDs are nonblank exact strings; request ownership uses `X-Test-Id`, then
`?testId=`, then `DEFAULT_TEST_ID`. State is isolated per server and per test ID.
`mock.resetRequestVerification(testId?)` clears one scope's observations (all
scopes if omitted) while retaining declarations and options. It clears both
observations and allowances. Late completions and reservation releases from before
replacement or reset cannot affect the new observation window. Journal clearing
and eviction do not affect verification. Full reset, including the HTTP reset
routes, removes all plans; stopping the server removes them too. All three
methods require a running server. The registration and verification-reset
methods return the mock for chaining.

`RequestVerificationOptions.causal` enables ancestry-consistent occurrence joins;
it must be boolean and defaults to false. A successful occurrence carries itself
and the transitive history of the `afterEach` occurrences selected at arrival.
Selected histories must agree on every shared expectation; disjoint histories
are compatible. Choose the lexicographically earliest compatible combination of
arrival ordinals in distinct prerequisite declaration order. Selection is fixed
at arrival. Aborts release exactly those occurrences, retaining their age.
Premature completions still contribute to aggregate counters and `after` barriers,
but cannot supply causal evidence. Successful excess completions can. Whole-batch
barriers add no ancestry. Different dependents have independent allowances.
Verification reset keeps this option while clearing histories and reservations.
