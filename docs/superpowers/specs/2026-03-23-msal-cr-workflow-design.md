# Module-Scoped Agent Loops (MSAL): CR & Test Workflow for llmock 1.7.0

## Problem Statement

After completing large feature work, the code review and test coverage process follows a pattern that scales poorly:

1. **CR round** — 7 agents review the entire diff (~9,000 lines), each finding scattered issues
2. **Fix round** — fixes land across unrelated modules, sometimes introducing new issues
3. **Repeat** — 5-10 rounds until clean
4. **Test coverage analysis** — reveals gaps, new tests are written
5. **CR round on new tests** — another 5-10 rounds

This is an O(n^2) convergence problem. More code means more rounds, and each round's context grows as fixes accumulate. Agents reviewing 9,000 lines per round reliably miss issues that surface in later rounds — not because the agents are bad, but because the context is too large for thorough review.

The v1.7.0 release adds +8,874 lines across 66 files. The current approach would require an estimated 50-70 agent-rounds to converge (7 agents x 7-10 rounds x 2 phases). Each round loads the full diff into every agent's context, which is wasteful when MCP mock bugs have nothing to do with Vector mock code.

## v1.7.0 Scope

The v1.7.0 branch (`feat/v1.7.0-subproject1`) implements three sub-projects:

- **Sub-project 1: Core Infrastructure** — Mountable composition, JSON-RPC transport, config loader, suite runner, aimock CLI, subpath exports
- **Sub-project 2: Protocol Mocking** — MCPMock (Model Context Protocol) and A2AMock (Agent-to-Agent)
- **Sub-project 3: AI Service Mocking** — VectorMock (Pinecone/Qdrant/Chroma), search, rerank, moderation

All sub-projects are feature-complete on the branch. The remaining work is test coverage and code review.

## Module Manifest

The v1.7.0 changes decompose cleanly into 9 independent modules plus cross-cutting glue:

| #   | Module         | Source Files                                                       | Lines | Test File             | Test Lines |
| --- | -------------- | ------------------------------------------------------------------ | ----- | --------------------- | ---------- |
| 1   | MCP Mock       | mcp-handler.ts, mcp-mock.ts, mcp-stub.ts, mcp-types.ts             | ~540  | mcp-mock.test.ts      | ~639       |
| 2   | A2A Mock       | a2a-handler.ts, a2a-mock.ts, a2a-stub.ts, a2a-types.ts             | ~761  | a2a-mock.test.ts      | ~546       |
| 3   | Vector Mock    | vector-handler.ts, vector-mock.ts, vector-stub.ts, vector-types.ts | ~605  | vector-mock.test.ts   | ~441       |
| 4   | JSON-RPC       | jsonrpc.ts                                                         | ~142  | jsonrpc.test.ts       | ~313       |
| 5   | Config Loader  | config-loader.ts                                                   | ~243  | config-loader.test.ts | ~350       |
| 6   | Suite          | suite.ts                                                           | ~66   | suite.test.ts         | ~151       |
| 7   | Services       | moderation.ts, rerank.ts, search.ts                                | ~391  | services.test.ts      | ~270       |
| 8   | Mount / Server | server.ts (changes)                                                | ~278  | mount.test.ts         | ~320       |
| 9   | AIMock CLI     | aimock-cli.ts                                                      | ~63   | aimock-cli.test.ts    | ~186       |
| X   | Cross-cutting  | index.ts, llmock.ts, types.ts, tsdown.config.ts                    | ~127  | —                     | —          |

**Key property:** No module's source depends on another module's internals. MCP Mock doesn't import A2A Mock. Vector Mock doesn't import JSON-RPC internals. They compose through the shared mount/server infrastructure and export through index.ts. This independence is what makes module-scoped review viable.

## Approach Comparison

### Approach A: Module-Scoped Agent Loops (MSAL) — Recommended

Partition the 9,000-line diff into 9 independent modules. Assign each module to a dedicated agent that runs its own CR + test coverage loop in isolation. Only after all modules report clean does a cross-cutting integration review run.

**Strengths:**

- Context per agent: ~1,500 lines (source + test + shared types) — 6x smaller than full-diff review
- Agents find issues reliably on first pass because there's nowhere for bugs to hide in 500 lines of source
- Loops converge in 2-3 rounds per module (vs 5-10 for full-diff review)
- Test writing is integrated into each module's loop — no separate phase
- 9-way parallelism means wall-clock time is determined by the slowest module, not the sum
- Cross-module bugs are caught in a dedicated phase after module-level noise is eliminated

**Weaknesses:**

- Cross-module interface bugs aren't caught until Phase 3 (mitigated by the integration review)
- Requires clear module boundaries (which v1.7.0 has — this wouldn't work for a monolithic refactor)
- More total agents spawned (9 + 3 + 1 = 13 across phases) though fewer total agent-rounds

**Estimated agent-rounds:** ~25-30 (9 modules x 2-3 rounds + 3 cross-cutting x 2 rounds + 1 final)

### Approach B: Rotating Specialist Panels

Keep the current 7-agent model but rotate file assignments per round. Round 1: agents 1-3 review modules A-C, agents 4-6 review D-F, agent 7 reviews G-J. Round 2: rotate so each module gets a fresh reviewer.

**Strengths:**

- Every module eventually gets reviewed by multiple distinct agents
- Catches issues that a single reviewer might have blind spots for

**Weaknesses:**

- Each agent still loads 2-3 modules per round (~3,000 lines) — better than 9,000 but not tight
- Coordination overhead is high — orchestrator must track which agent reviewed which module and manage rotation
- No clear convergence signal per module — hard to know when a module is "done"
- Test writing still happens as a separate phase
- Cross-module bugs can still be missed because no single agent sees the full picture

**Estimated agent-rounds:** ~35-50 (7 agents x 5-7 rounds)

### Approach C: Two-Phase Sequential

Phase 1: Test coverage analysis and test writing (dedicated pass, no CR). Phase 2: CR-fix loop on the fully-tested codebase.

**Strengths:**

- Clean separation of concerns — tests first, review second
- Phase 2 reviews code that already has tests, so agents can check test quality alongside source

**Weaknesses:**

- Does not solve the context bloat problem — Phase 2 still runs 7 agents across the full 9,000-line diff
- Phase 1 test writing may introduce bugs that Phase 2 must then catch and fix
- Total wall-clock time is strictly sequential — no parallelism between testing and review
- This is essentially the current workflow with a more explicit phase gate

**Estimated agent-rounds:** ~45-60 (test phase ~15 rounds + CR phase ~30-45 rounds)

### Comparison Summary

| Metric                       | A: MSAL                   | B: Rotating Panels       | C: Two-Phase              |
| ---------------------------- | ------------------------- | ------------------------ | ------------------------- |
| Context per agent per round  | ~1,500 lines              | ~3,000 lines             | ~9,000 lines              |
| Estimated total agent-rounds | 25-30                     | 35-50                    | 45-60                     |
| Parallelism                  | 9-way (Phase 1)           | 7-way                    | 1-way (sequential phases) |
| Test writing                 | Integrated per module     | Separate phase           | Separate phase            |
| Cross-module bug detection   | Phase 3 (dedicated)       | Incidental               | Incidental                |
| Module convergence tracking  | Explicit per module       | Unclear                  | Unclear                   |
| Orchestrator complexity      | Medium (partition + gate) | High (rotation tracking) | Low                       |

## Recommended Design: MSAL

### Phase 0: Setup (Orchestrator, One-Time)

**0.1 Install coverage tooling**

Add `@vitest/coverage-v8` as a dev dependency. Configure `vitest.config.ts`:

```typescript
coverage: {
    provider: 'v8',
    reporter: ['text', 'json-summary'],
    include: ['src/**/*.ts'],
    exclude: ['src/__tests__/**', 'src/index.ts', 'src/cli.ts'],
    thresholds: {
        lines: 90,
        branches: 85,
        functions: 90,
    },
}
```

**0.2 Run baseline coverage**

Execute `vitest run --coverage` on the v1.7.0 branch. Record per-file coverage as the starting point. This tells each module agent exactly where the gaps are.

**0.3 Build the module manifest**

Produce the file-to-module mapping (the table above) and confirm each module's test file exists and runs independently.

### Phase 1: Module-Scoped Loops (9 Agents, Parallel)

Each agent receives a prompt containing:

- The module manifest entry (which files are theirs)
- The baseline coverage numbers for their files
- Shared context: types.ts, relevant parts of server.ts (for mount-based modules)
- Instructions to read FULL files, not diffs

**Shared file boundary rule:** Module agents MUST NOT edit files outside their module manifest entry. If a module agent identifies a bug in a shared file (server.ts, types.ts, index.ts, etc.), it reports the finding to the orchestrator instead of fixing it. Shared-file fixes are handled between phases or by Phase 2 agents.

Each agent executes this loop:

```
LOOP:
    1. READ all source files in the module (full content)
    2. READ the test file (full content)
    3. RUN tests: vitest run <test-file> --coverage
    4. ANALYZE coverage gaps:
       - Which lines/branches are untested?
       - Which error paths lack coverage?
       - Which edge cases are missing?
    5. WRITE missing tests (red-green verified):
       a. Write the test (expect it to pass for existing behavior)
       b. Break the source code to confirm the test catches the breakage (RED)
       c. Restore the source code, confirm the test passes (GREEN)
    6. CODE REVIEW the module's source:
       - Trace every public method: inputs -> processing -> outputs -> consumers
       - Check error handling: are errors surfaced or swallowed?
       - Check type correctness: do types match runtime behavior?
       - Check edge cases: empty inputs, missing fields, malformed data
       - Check protocol conformance: does the mock match the real protocol?
    7. FIX any findings from step 6
    7a. If a fix changed observable behavior, write or update tests covering
        the changed behavior using the same red-green protocol from step 5
    8. RUN tests again — all must pass
    9. SELF-ASSESS:
       - "Are there test cases I haven't written?"
       - "Are there code paths I haven't reviewed?"
       - "Did my fixes introduce anything that needs re-review?"
       If YES to any -> LOOP
       If NO to all -> REPORT CLEAN
```

**Exit criteria per agent (ALL must be true):**

- All tests pass
- Coverage >= 90% lines, >= 85% branches for the module's files
- Zero CR findings on the most recent pass
- Agent has explicitly confirmed "no more tests to write, no more findings"

**Agent configuration:**

- Model: Opus (mandatory for all agents, per standing instructions)
- Isolation: worktree (each agent gets its own copy to avoid conflicts)
- Max concurrent: 4 worktree agents at a time (OOM prevention per prior learnings), batch remaining
- Each agent's prompt includes ONLY its module's files — never the full diff

**Batching strategy (OOM prevention):**

With 9 modules and a max of 4 concurrent worktree agents, execution uses a priority queue with backfill:

**Priority queue (dispatched in order):**

1. MCP Mock
2. A2A Mock
3. Vector Mock
4. JSON-RPC
5. Config Loader
6. Suite
7. Services
8. Mount / Server
9. AIMock CLI

The first 4 modules are dispatched immediately. As each agent completes and frees a slot, the next module in the queue is dispatched. At no point are more than 4 agents running concurrently. Larger/more complex modules are prioritized first so they start early and smaller modules backfill as slots open.

### Phase 2: Cross-Cutting Review (3 Agents, Parallel)

Triggered ONLY after all 9 module agents report CLEAN. The orchestrator first merges all module agent changes into a single branch, resolving any conflicts.

**Agent A: Integration Testing**

Focus: Do the modules compose correctly when mounted together?

Files: server.ts, suite.ts, config-loader.ts, llmock.ts, index.ts, plus all \*-mock.ts files (public API only)

Tasks:

- Write integration tests that mount multiple mocks on a single server
- Test config loader with multi-mock configurations
- Test suite runner with heterogeneous mock types
- Verify health endpoint aggregates across mocks
- Verify journal captures across mock types

**Agent B: API Surface & Type Consistency**

Focus: Is the public API correct, consistent, and well-typed?

Files: index.ts, types.ts, all _-stub.ts, all _-types.ts, all \*-mock.ts (constructor/public method signatures only)

Tasks:

- Verify all public classes/types/functions are exported from index.ts
- Verify stub files match their corresponding mock's API
- Verify type definitions are consistent across modules (e.g., common option patterns)
- Verify subpath exports in package.json match actual file structure
- Check for any `as any` typecasts that can be eliminated

**Agent C: Docs, Packaging & Build**

Focus: Does everything build, package, and document correctly?

Files: docs/\*.html, package.json, tsdown.config.ts, README.md

Tasks:

- Verify docs pages match actual API signatures (method names, parameters, return types)
- Verify package.json exports/bin entries are correct
- Run full build (`pnpm run build`) and verify output
- Verify tsdown config includes all new entry points
- Check that fixture examples in docs work with current code

Same loop structure as Phase 1: review -> fix -> loop until clean. Phase 2 agents are capped at 5 rounds. If not clean by round 5, escalate to the orchestrator for human review.

### Phase 3: Final Gate (1 Agent)

Triggered after all Phase 2 agents report CLEAN.

Checklist:

1. `vitest run --coverage` — all tests pass, coverage thresholds met
2. `pnpm run build` — clean build, no type errors
3. `pnpm run lint` — no lint violations
4. `pnpm run check-prettier` — formatting clean
5. Full-diff CR pass (the entire v1.7.0 diff vs main) — this should find effectively nothing since every module was reviewed in isolation and cross-cutting was verified in Phase 2. If it DOES find something, that's a signal the module partitioning missed a dependency.
6. Generate final coverage report for the record

**If findings surface in the final gate:** Spawn a NEW scoped fix agent with the appropriate module's file set, operating on the merged branch (not in a worktree), with instructions to fix the specific finding. Then re-run the final gate. This should be rare — 0-1 iterations. Note: the original Phase 1/2 agents and their worktrees no longer exist at this point; "routing back" always means spawning a fresh targeted agent.

### Phase Transitions

```
Phase 0 (Setup)
    |
    v
Phase 1 (9 Module Agents) ──[all CLEAN]──> Phase 2 (3 Cross-Cutting Agents)
                                                |
                                                v
                                           [all CLEAN]
                                                |
                                                v
                                      Phase 3 (Final Gate) <──┐
                                                |              |
                                           [findings?]         |
                                            /        \         |
                                   [yes]   /          \  [no]  |
                                          v            v       |
                          spawn scoped fix agent      DONE     |
                                          |                    |
                                          +────────────────────┘
```

### Orchestrator Responsibilities

The orchestrator (main conversation context) does NOT do substantive review or fix work. Its role:

1. **Phase 0:** Install tooling, run baseline, build manifest
2. **Phase 1:** Dispatch module agents in batches of 4, monitor for completion, collect CLEAN reports
3. **Merge gate:** After Phase 1, merge all worktree branches, resolve conflicts
4. **Phase 2:** Dispatch cross-cutting agents, monitor for completion
5. **Merge gate:** After Phase 2, merge cross-cutting changes
6. **Phase 3:** Dispatch final gate agent, report results
7. **Routing:** If final gate finds issues, spawn a scoped fix agent on the merged branch targeting the specific finding, then re-run the final gate

The orchestrator's context stays small because it never loads source code — only agent reports and status.

### Commit Strategy

Each module agent commits its work using conventional commit prefixes (enforced by commitlint):

- `test: add coverage for MCP Mock — tool/resource/prompt handlers`
- `fix: MCP handler error path for malformed JSON-RPC requests`

After all phases complete, the orchestrator regroups commits by area of concern:

- All test additions in one commit per module
- All bug fixes grouped by module
- Cross-cutting fixes (exports, types, packaging) in their own commit
- Docs updates in their own commit

### Expected Outcome

| Metric                      | Before MSAL                                | After MSAL                                                        |
| --------------------------- | ------------------------------------------ | ----------------------------------------------------------------- |
| Total agent-rounds          | 50-70                                      | 25-30                                                             |
| Wall-clock time (estimated) | Dominated by 7-10 sequential CR rounds     | Dominated by slowest module (2-3 rounds) + 2 cross-cutting rounds |
| Context per agent           | ~9,000 lines                               | ~1,500 lines                                                      |
| Coverage                    | Unknown (no tooling)                       | >= 90% lines, >= 85% branches                                     |
| Confidence in "clean"       | Low (agents miss things in large contexts) | High (exhaustive review of small contexts)                        |

### Risks and Mitigations

| Risk                                                                         | Mitigation                                                                                                                                                   |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Module agents make conflicting changes to shared files (server.ts, types.ts) | Module agents are prohibited from editing files outside their manifest; shared-file bugs are reported to orchestrator and fixed between phases or in Phase 2 |
| Cross-module bugs missed until Phase 3                                       | Phase 2 integration agent specifically tests composition; Phase 3 full-diff review is the safety net                                                         |
| OOM from too many concurrent worktree agents                                 | Batching: max 4 concurrent agents, backfill as slots free                                                                                                    |
| Module agent loops don't converge (infinite loop)                            | Cap at 5 rounds per module — if not clean by round 5, surface to orchestrator for human review                                                               |
| Coverage tooling setup takes significant time                                | Phase 0 is a one-time cost; vitest coverage-v8 is well-documented and fast to configure                                                                      |
