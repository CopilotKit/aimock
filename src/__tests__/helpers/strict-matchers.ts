import { strictNoMatchMessage } from "../../helpers.js";

/**
 * Shared matcher for the strict-mode 503 "skipped by sequence/turn state"
 * message built by `strictNoMatchMessage` (src/helpers.ts). Import this
 * instead of re-encoding the message text in individual test files.
 */
export const SKIPPED_BY_STATE_RE = /candidate fixture\(s\) skipped by sequence\/turn state/;

// Drift guard: fail loudly at import time if the matcher no longer matches the
// message actually produced by the source of truth.
if (!SKIPPED_BY_STATE_RE.test(strictNoMatchMessage(1))) {
  throw new Error(
    `SKIPPED_BY_STATE_RE is out of sync with strictNoMatchMessage(): ${strictNoMatchMessage(1)}`,
  );
}
