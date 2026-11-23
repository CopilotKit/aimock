import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { writeSSEStream } from "../sse-writer.js";
import { writeNDJSONStream } from "../ndjson-writer.js";
import { writeEventStream } from "../aws-event-stream.js";
import {
  MATRIX_CASES,
  caseId,
  runCase,
  type ExportedWriters,
  type WriterObservation,
} from "./helpers/exported-writer-matrix.js";

// No breaking changes: the PUBLIC exported writers must behave exactly like
// base 508dd9b9 for every edge case: same bytes, same headers, same return
// value, same end-of-response behavior. The expected observations were
// captured by running this matrix against the 508dd9b9 build; they are data,
// not a snapshot, so they never update themselves.
const BASE = JSON.parse(
  readFileSync(new URL("./fixtures/exported-writers-base-508dd9b9.json", import.meta.url), "utf8"),
) as Record<string, WriterObservation>;

const writers: ExportedWriters = { writeSSEStream, writeNDJSONStream, writeEventStream };

describe("exported writers keep the 508dd9b9 contract", () => {
  it("has a base observation for every matrix case", () => {
    expect(Object.keys(BASE).sort()).toEqual(MATRIX_CASES.map(caseId).sort());
  });

  for (const c of MATRIX_CASES) {
    it(caseId(c), async () => {
      expect(await runCase(writers, c)).toEqual(BASE[caseId(c)]);
    });
  }
});
