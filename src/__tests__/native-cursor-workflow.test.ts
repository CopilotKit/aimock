import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import fixture from "./fixtures/native-cursor-policy.json" with { type: "json" };

type Evidence = typeof fixture;
const root = resolve(__dirname, "../..");
const tsx = pathToFileURL(createRequire(join(root, "package.json")).resolve("tsx")).href;
const workflow = readFileSync(join(root, ".github/workflows/test-drift.yml"), "utf8");
const gateBody = workflow.match(
  /cat > "\$DELTA_FILE" <<'DELTAGATE'\n([\s\S]*?)^\s*DELTAGATE\s*$/m,
)?.[1];
if (!gateBody) throw new Error("Native workflow gate is missing");
const gate = gateBody.replace(/^ {10}/gm, "");
const cursorError = {
  status: 400,
  body: {
    type: "error",
    error: {
      type: "invalid_request_error",
      message: "Model with id aimock-nonexistent-model not found",
    },
  },
};

/** Historical receipts remain the base control; head gets the new local response. */
function evidence(legacy = false): Evidence {
  const data = structuredClone(fixture);
  if (legacy) return data;
  for (const direction of ["after", "before"]) {
    const id = `anthropic-${direction}-unknown`;
    const vendor = data.observations.observations.find((row) => row.caseId === `vendor:${id}`)!;
    vendor.actual = structuredClone(cursorError);
    const local = data.observations.observations.find((row) => row.caseId === `local:${id}`)!;
    local.actual = structuredClone(cursorError);
    local.expected = structuredClone(cursorError);
    const comparison = data.invocation.drift.assertions.find(
      (row) => row.title === `${id} comparison`,
    )!;
    comparison.status = "passed";
    // Passing vendor comparisons emit no report entry, even though the full
    // receipt comparison retains the one missing-request_id warning.
    data.report.entries = data.report.entries.filter(
      (row) => row.scenario !== `Native catalog comparison ${id}`,
    );
  }
  return data;
}

/** Execute the actual workflow CLI with receipts, report, and collector sidecar. */
function runGate(data: Evidence, mode = "scheduled") {
  const dir = mkdtempSync(join(tmpdir(), "aimock-cursor-gate-"));
  const script = join(root, `.native-cursor-gate-${randomUUID()}.mts`);
  try {
    mkdirSync(join(dir, "evidence"));
    writeFileSync(join(dir, "report.json"), JSON.stringify(data.report));
    writeFileSync(join(dir, "observations.json"), JSON.stringify(data.observations));
    writeFileSync(join(dir, "evidence", "invocation.json"), JSON.stringify(data.invocation));
    writeFileSync(join(dir, "drift-report-base.json"), JSON.stringify(evidence(true).report));
    writeFileSync(join(dir, "drift-report-head.json"), JSON.stringify(data.report));
    writeFileSync(join(dir, "drift-observations-head.json"), JSON.stringify(data.observations));
    writeFileSync(script, gate);
    const env = { ...process.env };
    for (const key of ["ANTHROPIC_API_KEY", "BASE_RUN_ID", "NATIVE_ALLOW_LEGACY_CURSOR_POLICY"])
      delete env[key];
    const result = spawnSync(process.execPath, ["--import", tsx, script], {
      cwd: dir,
      encoding: "utf8",
      timeout: 15_000,
      env: {
        ...env,
        ...(mode === "delta" ? { ANTHROPIC_API_KEY: "local-gate-selection-only" } : {}),
        NATIVE_DISPOSITION_MODE: mode,
        NATIVE_RAW_EXIT_CODE: "2",
        NATIVE_REPORT_PATH: join(dir, "report.json"),
        NATIVE_OBSERVATIONS_PATH: join(dir, "observations.json"),
        NATIVE_EVIDENCE_DIR: join(dir, "evidence"),
      },
    });
    expect(result.error).toBeUndefined();
    return {
      status: result.status,
      disposition:
        mode !== "delta" && result.stdout
          ? (JSON.parse(result.stdout) as { effectiveExit: number })
          : undefined,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } finally {
    rmSync(script, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
}

it("accepts native 400 cursor behavior and the exact bound request_id warning at head", () => {
  const result = runGate(evidence());
  expect(result.stderr).toBe("");
  expect(result.disposition?.effectiveExit).toBe(0);
});

it("accepts exact historical empty-page cursor policy only when grading cached base evidence", () => {
  const result = runGate(evidence(true), "cache");
  expect(result.status, result.stderr).toBe(0);
  expect(result.disposition?.effectiveExit).toBe(0);
});

it("rejects historical empty-page policy at scheduled head", () => {
  const result = runGate(evidence(true));
  expect(result.disposition?.effectiveExit).toBe(1);
});

it("accepts current cursor behavior in cached base evidence too", () => {
  const result = runGate(evidence(), "cache");
  expect(result.status, result.stderr).toBe(0);
  expect(result.disposition?.effectiveExit).toBe(0);
});

it.each(["after", "before"])(
  "rejects mutated %s cursor receipts, assertions, and complete diffs",
  (direction) => {
    const id = `anthropic-${direction}-unknown`;
    const mutations: Array<[string, (data: Evidence) => void]> = [
      [
        "wrong status",
        (data) => {
          data.observations.observations.find(
            (row) => row.caseId === `vendor:${id}`,
          )!.actual.status = 200;
        },
      ],
      [
        "wrong local body",
        (data) => {
          const row = data.observations.observations.find((row) => row.caseId === `vendor:${id}`)!;
          row.actual = {
            status: 400,
            body: {
              type: "error",
              error: { type: "invalid_request_error", message: "wrong message" },
            },
          };
        },
      ],
      [
        "wrong vendor body",
        (data) => {
          const row = data.observations.observations.find((row) => row.caseId === `vendor:${id}`)!;
          row.expected.status = 401;
        },
      ],
      [
        "local contract mismatch",
        (data) => {
          data.observations.observations.find(
            (row) => row.caseId === `local:${id}`,
          )!.actual.status = 200;
        },
      ],
      [
        "failed comparison",
        (data) => {
          data.invocation.drift.assertions.find((row) => row.title === `${id} comparison`)!.status =
            "failed";
        },
      ],
      [
        "missing comparison",
        (data) => {
          data.invocation.drift.assertions = data.invocation.drift.assertions.filter(
            (row) => row.title !== `${id} comparison`,
          );
        },
      ],
      [
        "duplicate receipt",
        (data) => {
          data.observations.observations.push(
            structuredClone(
              data.observations.observations.find((row) => row.caseId === `vendor:${id}`)!,
            ),
          );
        },
      ],
      [
        "wrong severity",
        (data) => {
          data.report.entries.find(
            (row) => row.scenario === `Native catalog comparison ${id}`,
          )!.diffs[0].severity = "critical";
        },
      ],
      [
        "wrong path",
        (data) => {
          data.report.entries.find(
            (row) => row.scenario === `Native catalog comparison ${id}`,
          )!.diffs[0].path = "error.type";
        },
      ],
      [
        "missing diff",
        (data) => {
          data.report.entries.find(
            (row) => row.scenario === `Native catalog comparison ${id}`,
          )!.diffs = [];
        },
      ],
      [
        "extra diff",
        (data) => {
          const entry = data.report.entries.find(
            (row) => row.scenario === `Native catalog comparison ${id}`,
          )!;
          entry.diffs.push(structuredClone(entry.diffs[0]));
        },
      ],
      [
        "extra diff metadata",
        (data) => {
          Object.assign(
            data.report.entries.find((row) => row.scenario === `Native catalog comparison ${id}`)!
              .diffs[0],
            { ignored: true },
          );
        },
      ],
    ];
    for (const [name, mutate] of mutations) {
      const data = evidence();
      if (
        [
          "wrong severity",
          "wrong path",
          "missing diff",
          "extra diff",
          "extra diff metadata",
        ].includes(name)
      ) {
        const entry = structuredClone(
          fixture.report.entries.find((row) => row.scenario === `Native catalog comparison ${id}`)!,
        );
        entry.diffs = [entry.diffs[2]];
        data.report.entries.push(entry);
      }
      mutate(data);
      const result = runGate(data);
      expect(result.disposition?.effectiveExit, name).toBe(1);
    }
  },
  30_000,
);

it("accepts current head against historical base in the actual PR delta CLI", () => {
  const result = runGate(evidence(), "delta");
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("Drift gate PASSED");
});

it("rejects legacy empty pages in the actual PR head delta CLI", () => {
  const result = runGate(evidence(true), "delta");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Unbound retained-policy assertion");
});

it.each(["report timestamp", "invocation binding", "AG-UI failure", "auth diff omission"])(
  "retains unrelated evidence guard: %s",
  (name) => {
    const data = evidence();
    if (name === "report timestamp") data.observations.generatedAt = "2020-01-01T00:00:00.000Z";
    if (name === "invocation binding")
      data.invocation.drift.assertions.find(
        (row) => row.title === "anthropic-after-unknown comparison",
      )!.consoleContext.availability = "unavailable";
    if (name === "AG-UI failure") data.invocation.agui.exitCode = 1;
    if (name === "auth diff omission")
      data.report.entries.find((entry) => entry.scenario === "Anthropic vendor auth")!.diffs = [];
    const result = runGate(data);
    expect(result.disposition?.effectiveExit).toBe(1);
  },
);

it.each(["changed empty page", "changed comparison", "missing report diff", "extra report diff"])(
  "rejects changed historical base evidence: %s",
  (name) => {
    const data = evidence(true);
    if (name === "changed empty page") {
      data.observations.observations.find(
        (row) => row.caseId === "vendor:anthropic-after-unknown",
      )!.actual.status = 201;
    }
    if (name === "changed comparison") {
      data.invocation.drift.assertions.find(
        (row) => row.title === "anthropic-after-unknown comparison",
      )!.status = "passed";
    }
    const entry = data.report.entries.find(
      (row) => row.scenario === "Native catalog comparison anthropic-after-unknown",
    )!;
    if (name === "missing report diff") entry.diffs.pop();
    if (name === "extra report diff") entry.diffs.push(structuredClone(entry.diffs[0]));
    const result = runGate(data, "cache");
    expect(result.status).toBe(1);
  },
);
