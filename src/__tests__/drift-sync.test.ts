/**
 * Characterization tests for the C1 plumbing MOVE (fix-drift.ts → drift-sync.ts).
 *
 * The reusable git / branch / commit / PR plumbing was extracted VERBATIM into
 * scripts/drift-sync.ts so the deterministic model-sync path can reuse it.
 *
 * C3 (delete-freewriter-predicate-rewire): `scripts/fix-drift.ts` — the LLM
 * freewriter invocation + its predicate-gated CLI, which used to re-export
 * this plumbing as a pass-through so its own tests kept working unchanged —
 * has been DELETED entirely. The re-export-identity half of this suite (which
 * asserted `fix-drift.js`'s bindings were identical to `drift-sync.js`'s own)
 * no longer has a module to compare against and is dropped. What remains locks
 * that the moved pure functions behave correctly at drift-sync.ts's own module
 * boundary (now the only boundary).
 */
import { describe, it, expect } from "vitest";

import * as sync from "../../scripts/drift-sync.js";

// ---------------------------------------------------------------------------
// Behavior at the drift-sync.ts module boundary (pure functions only).
// ---------------------------------------------------------------------------

describe("drift-sync pure plumbing behaves the same at the new boundary", () => {
  it("todayStamp returns a YYYY-MM-DD stamp", () => {
    expect(sync.todayStamp()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("parsePorcelainLine handles quoted + rename notation", () => {
    expect(sync.parsePorcelainLine(" M src/foo.ts")).toBe("src/foo.ts");
    expect(sync.parsePorcelainLine("R  old.ts -> new.ts")).toBe("new.ts");
    expect(sync.parsePorcelainLine(' M "src/special chars.ts"')).toBe("src/special chars.ts");
  });
});
