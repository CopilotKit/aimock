import { createHash } from "node:crypto";
import { MAX_EVIDENCE_RECORD_BYTES } from "../../../scripts/drift-evidence-reporter.js";

// Vitest task ids are short; 64 characters leaves a margin for the envelope.
const TASK_ID_ALLOWANCE = "x".repeat(64);

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// Without this, JSON.stringify writes a Uint8Array as {"0":123,"1":34,...},
// which is about ten times the size of its base64 form.
const bytesAsBase64 = (_key: string, value: unknown) =>
  value instanceof Uint8Array && !Buffer.isBuffer(value)
    ? { encoding: "base64", bytes: Buffer.from(value).toString("base64") }
    : value;

/** Mirrors the evidence reporter's console record encoding and size check. */
export function fitsEvidenceRecord(line: string, taskId = TASK_ID_ALLOWANCE): boolean {
  const encoded = JSON.stringify({
    kind: "console",
    taskId,
    stream: "stdout",
    content: line + "\n",
  });
  return Buffer.byteLength(encoded) <= MAX_EVIDENCE_RECORD_BYTES;
}

const digest = (value: unknown) => {
  const bytes = Buffer.from(JSON.stringify(value, bytesAsBase64) ?? "null");
  return { omitted: true, byteLength: bytes.length, sha256: sha256(bytes) };
};

/**
 * Serialize one AWS drift diagnostic console line so the evidence reporter can
 * still bind it to its test.
 *
 * The reporter replaces any console record over MAX_EVIDENCE_RECORD_BYTES with
 * `console-unavailable`. That taints the owning test, and one tainted live
 * assertion makes the collector withhold the whole observation artifact, so
 * the native drift gate cannot grade the run.
 *
 * SDK event bytes are written as base64. While the line is still too large,
 * the raw wire bytes, then the SDK events, then the decoded events are
 * replaced by their size and SHA-256. If it still does not fit, the line keeps
 * only the cell, the names of the omitted fields, and the size and SHA-256 of
 * the complete line. Every returned line fits the reporter limit.
 */
export function boundedDiagnosticLine(
  record: Record<string, unknown> & { sdkEvents: unknown[] },
  wire: Buffer,
): string {
  const rawWire = { encoding: "base64", bytes: wire.toString("base64") };
  const wireDigest = { omitted: true, byteLength: wire.length, sha256: sha256(wire) };
  const eventsDigest = { count: record.sdkEvents.length, ...digest(record.sdkEvents) };
  const decodedDigests = Object.fromEntries(
    (["decoded", "decodedEvents"] as const)
      .filter((key) => key in record)
      .map((key) => [key, digest(record[key])]),
  );
  const full = JSON.stringify({ ...record, rawWire }, bytesAsBase64);
  const candidates = [
    () => full,
    () => ({ ...record, rawWire: wireDigest }),
    () => ({ ...record, sdkEvents: eventsDigest, rawWire: wireDigest }),
    () => ({
      ...record,
      sdkEvents: eventsDigest,
      ...decodedDigests,
      rawWire: wireDigest,
    }),
  ];
  for (const candidate of candidates) {
    const value = candidate();
    const line = typeof value === "string" ? value : JSON.stringify(value, bytesAsBase64);
    if (fitsEvidenceRecord(line)) return line;
  }
  const fullBytes = Buffer.from(full);
  const summary = {
    omitted: [...Object.keys(record).filter((key) => key !== "cell"), "rawWire"],
    byteLength: fullBytes.length,
    sha256: sha256(fullBytes),
  };
  const minimal = JSON.stringify({ cell: record.cell, ...summary }, bytesAsBase64);
  // `cell` is a short fixed tuple; drop it too rather than ever exceed the limit.
  return fitsEvidenceRecord(minimal)
    ? minimal
    : JSON.stringify({ ...summary, omitted: [...summary.omitted, "cell"] });
}
