# Deprecated zero-reference model family — removal PROPOSED, not applied: claude-opus-4-1

Provider: anthropic
Detected: 2026-08-07
Status: NEEDS HUMAN REVIEW

"claude-opus-4-1" no longer appears in the live /models listing and nothing in aimock's own source still references it, so removing it from includeFamilies.anthropic is mechanically safe. drift-sync does not apply it: that set's membership is checksum-pinned, and re-pinning is a reviewed human decision the sync's own changed-file allowlist forbids it from making.

## How to apply

1. Delete the `"claude-opus-4-1"` entry from `includeFamilies.anthropic` in
   `src/__tests__/drift/model-registry.ts`.
2. Re-pin `DATA_FROZEN["includeFamilies.anthropic"]` in
   `src/__tests__/drift/logic-pin.test.ts` with the new membership checksum.
3. Delete this note file.

All three belong in ONE reviewed commit: step 1 without step 2 leaves the
membership pin red, and step 2 without step 1 is a silent canary-silencing edit.
That deliberate, reviewed re-pin is a decision the pin reserves for a human, which
is exactly why drift-sync proposes this removal instead of applying it.
