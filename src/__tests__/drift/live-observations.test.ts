import { execFile } from "node:child_process";
import {
  existsSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createServer } from "../../server.js";
import { formatDriftReport } from "./schema.js";
import {
  emitLiveObservation,
  parseLiveObservation,
  LIVE_OBSERVATION_PREFIX,
  type ObservationBody,
  type LiveObservation,
} from "./live-observations.js";

const child = process.env.AIMOCK_OBSERVATION_CHILD === "1";
const root = fileURLToPath(new URL("../../..", import.meta.url));
const credentialCases: { name: string; body: ObservationBody; canary: string }[] = [
  {
    name: "x-api-key",
    body: { nested: { "x-api-key": "synthetic-canary-x-api-key" } },
    canary: "synthetic-canary-x-api-key",
  },
  {
    name: "x-goog-api-key",
    body: { nested: { "x-goog-api-key": "synthetic-canary-x-goog-api-key" } },
    canary: "synthetic-canary-x-goog-api-key",
  },
  {
    name: "client_secret",
    body: { nested: { client_secret: "synthetic-canary-client-secret" } },
    canary: "synthetic-canary-client-secret",
  },
  {
    name: "lowercase-bearer",
    body: { error: { message: "bearer synthetic-canary-bearer" } },
    canary: "synthetic-canary-bearer",
  },
];
const credential = credentialCases.find(
  (item) => item.name === process.env.AIMOCK_OBSERVATION_CREDENTIAL,
);
const credentialInput = (body: ObservationBody) => ({
  surface: "anthropic",
  caseId: "collector:credential",
  expected: { status: 401, body: null },
  actual: { status: 401, body },
});
const normalizationCases: { name: string; expected: ObservationBody; actual: ObservationBody }[] = [
  { name: "negative-zero", expected: -0, actual: 0 },
  { name: "sparse-array", expected: new Array<ObservationBody>(1), actual: [null] },
];
const normalization = normalizationCases.find(
  (item) => item.name === process.env.AIMOCK_OBSERVATION_NORMALIZATION,
);
const rejection = process.env.AIMOCK_OBSERVATION_REJECTION;
const sizeCount = [1, 6].find(
  (count) => String(count) === process.env.AIMOCK_OBSERVATION_SIZE_COUNT,
);

describe.skipIf(!child)("actual collector observation producer", () => {
  it.skipIf(sizeCount === undefined)("ordinary emitter calls at reporter size boundary", () => {
    if (!sizeCount) throw new Error("Missing size count");
    const records: LiveObservation[] = [];
    for (let index = 0; index < sizeCount; index++) {
      records.push(
        emitLiveObservation({
          surface: "anthropic",
          caseId: `size:${index}`,
          expected: { status: 200, body: "x".repeat(28_000) },
          actual: { status: 200, body: "x".repeat(28_000) },
        }),
      );
    }
    expect(records).toHaveLength(sizeCount);
    expect(records.every((record) => Buffer.byteLength(JSON.stringify(record)) < 65_536)).toBe(
      true,
    );
  });
  it.skipIf(!["malformed", "secret-marked"].includes(rejection ?? ""))(
    "emits the selected rejected marked observation",
    () => {
      console.log(
        LIVE_OBSERVATION_PREFIX +
          (rejection === "malformed"
            ? "{"
            : JSON.stringify({
                ...credentialInput({ password: "synthetic-canary-password" }),
                matched: false,
              })),
      );
    },
  );
  it.skipIf(!normalization)("emits values normalized by the JSON transport", () => {
    if (!normalization) throw new Error("Missing normalization case");
    emitLiveObservation({
      surface: "anthropic",
      caseId: `collector:${normalization.name}`,
      expected: { status: 200, body: normalization.expected },
      actual: { status: 200, body: normalization.actual },
    });
  });
  it.skipIf(!credential)("rejects credential evidence at the selected boundary", () => {
    if (!credential) throw new Error("Missing credential case");
    const input = credentialInput(credential.body);
    if (process.env.AIMOCK_OBSERVATION_BOUNDARY === "marked") {
      console.log(LIVE_OBSERVATION_PREFIX + JSON.stringify({ ...input, matched: false }));
    } else {
      expect(() => emitLiveObservation(input)).toThrow("Invalid or unsafe live observation");
    }
  });
  it.skipIf(sizeCount !== undefined)(
    "emits status and body captured from the source server",
    async () => {
      const server = await createServer([], {
        port: 0,
        host: "127.0.0.1",
        latency: 0,
        chunkSize: 20,
        logLevel: "silent",
      });
      try {
        const response = await fetch(`${server.url}/f4a-collector-proof`, {
          method: "GET",
          headers: { "accept-encoding": "identity" },
          redirect: "manual",
          signal: AbortSignal.timeout(2000),
        });
        const encoding = response.headers.get("content-encoding");
        if (encoding !== null && encoding.toLowerCase() !== "identity") {
          await response.body?.cancel();
          throw new Error(`Unexpected content-encoding "${encoding}"`);
        }
        const actual = { status: response.status, body: JSON.parse(await response.text()) };
        for (const matched of [true, false]) {
          emitLiveObservation({
            surface: "anthropic",
            caseId: matched ? "collector:matched" : "collector:mismatch",
            expected: {
              ...actual,
              status: matched ? actual.status : 400,
              body: matched
                ? actual.body
                : { error: { message: "Expected mismatch control", type: "expected_error" } },
            },
            actual,
          });
        }
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.server.close((error) => (error ? reject(error) : resolve()));
          server.server.closeAllConnections();
        });
      }
    },
  );

  it("retains the independent ShapeDiff report control", () => {
    throw new Error(
      formatDriftReport(
        "Collector ShapeDiff control",
        [
          {
            path: "collector.control",
            severity: "critical",
            issue: "transport control",
            expected: "string",
            real: "string",
            mock: "number",
          },
        ],
        "anthropic",
      ),
    );
  });
});

describe.skipIf(child)("live observation collector transport", () => {
  it("persists all native enforced-version observations from the real producers", async () => {
    const directory = mkdtempSync(join(tmpdir(), "aimock-native-version-collector-"));
    try {
      symlinkSync(join(root, "node_modules"), join(directory, "node_modules"), "dir");
      writeFileSync(join(directory, "package.json"), '{"type":"module"}');
      const producers = [
        join(root, "src/__tests__/drift/anthropic.drift.ts"),
        join(root, "src/__tests__/drift/models.drift.ts"),
      ];
      writeFileSync(
        join(directory, "vitest.config.drift.ts"),
        `export default { test: { include: ${JSON.stringify(producers)}, testNamePattern: "native provider (catalog|Anthropic auth and missing-version) local contracts", pool: "forks", maxWorkers: 1, minWorkers: 1, fileParallelism: false, testTimeout: 30000 } };`,
      );
      const agUiRepo = join(directory, "unavailable-agui");
      mkdirSync(agUiRepo);
      const report = join(directory, "drift-report.json");
      const observations = join(directory, "drift-observations.json");
      const result = await new Promise<{ status: number; stdout: string; stderr: string }>(
        (resolve, reject) => {
          execFile(
            process.execPath,
            [
              join(root, "node_modules/tsx/dist/cli.mjs"),
              join(root, "scripts/drift-report-collector.ts"),
              "--out",
              report,
              "--observations-out",
              observations,
            ],
            {
              cwd: directory,
              encoding: "utf8",
              timeout: 60_000,
              env: {
                ...process.env,
                ANTHROPIC_API_KEY: "",
                GOOGLE_API_KEY: "",
                AIMOCK_NATIVE_PROVIDER_DRIFT: "",
                AGUI_REPO_PATH: agUiRepo,
              },
            },
            (error, stdout, stderr) => {
              if (!error) resolve({ status: 0, stdout, stderr });
              else if (typeof error.code === "number" && !error.killed)
                resolve({ status: error.code, stdout, stderr });
              else reject(error);
            },
          );
        },
      );
      const invocationPath = join(
        directory,
        "drift-evidence",
        readdirSync(join(directory, "drift-evidence"))[0],
      );
      const invocation: { drift: { exitCode: number | null } } = JSON.parse(
        readFileSync(invocationPath, "utf8"),
      );
      const shapeReport = JSON.parse(readFileSync(report, "utf8"));
      const artifact: { observations: LiveObservation[] } = JSON.parse(
        readFileSync(observations, "utf8"),
      );
      const destination = process.env.AIMOCK_F6B_EMIT_PROOF_DIR;
      if (destination) {
        mkdirSync(destination, { recursive: true });
        copyFileSync(report, join(destination, "drift-report.json"));
        copyFileSync(observations, join(destination, "drift-observations.json"));
        copyFileSync(invocationPath, join(destination, "invocation.json"));
      }
      console.log(
        `native enforcement persistence: collector exit=${result.status}; native exit=${invocation.drift.exitCode}; records=${artifact.observations.length}`,
      );
      // The outer exit reflects the deliberately unavailable AG-UI checkout, not native failure.
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("AG-UI drift detection was skipped");
      expect(invocation.drift.exitCode).toBe(0);
      expect(shapeReport.entries).toEqual([]);
      expect(shapeReport.quarantine).toBeUndefined();
      const native = {
        status: 400,
        body: {
          type: "error",
          error: {
            type: "invalid_request_error",
            message: "anthropic-version: header is required",
          },
          request_id: "req_f6b_required_version",
        },
      };
      for (const [caseId, surface] of [
        ["local:anthropic-messages-missing-version-enforce", "anthropic-native-errors"],
        ["local:anthropic-count-missing-version-enforce", "anthropic-native-errors"],
        ["local:anthropic-models-missing-version-enforce", "anthropic-catalog"],
        ["local:anthropic-model-detail-missing-version-enforce", "anthropic-catalog"],
      ]) {
        const records = artifact.observations.filter((record) => record.caseId === caseId);
        expect(records, caseId).toEqual([
          { surface, caseId, expected: native, actual: native, matched: true },
        ]);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 90_000);

  it.each([
    { name: "safe control", boundary: "emitter", canary: "" },
    ...credentialCases.flatMap(({ name, canary }) => [
      { name, boundary: "emitter", canary },
      { name, boundary: "marked", canary },
    ]),
    ...normalizationCases.map(({ name }) => ({ name, boundary: "emitter", canary: "" })),
    { name: "malformed", boundary: "marked", canary: "" },
    { name: "secret-marked", boundary: "marked", canary: "synthetic-canary-password" },
    { name: "native-size-1", boundary: "emitter", canary: "" },
    { name: "native-size-6", boundary: "emitter", canary: "" },
    { name: "native-size-clean-6", boundary: "emitter", canary: "" },
  ])(
    "writes safe evidence and excludes $name through $boundary",
    async ({ name, boundary, canary }) => {
      const directory = mkdtempSync(join(tmpdir(), "aimock-observation-collector-"));
      try {
        const clean = name === "native-size-clean-6";
        symlinkSync(join(root, "node_modules"), join(directory, "node_modules"), "dir");
        writeFileSync(join(directory, "package.json"), '{"type":"module"}');
        // Exercise the existing collector subprocess using only this real-source producer.
        writeFileSync(
          join(directory, "vitest.config.drift.ts"),
          `export default { test: { include: [${JSON.stringify(fileURLToPath(import.meta.url))}${clean ? ', "src/__tests__/drift/agui-transport.test.ts"' : ""}], ${clean ? 'testNamePattern: "ordinary emitter calls|portable schema transport control",' : ""} pool: "forks", maxWorkers: 1, fileParallelism: false } };`,
        );
        const agUiRepo = join(directory, clean ? "agui-transport" : "unavailable-agui");
        mkdirSync(agUiRepo);
        if (clean) {
          // A readable local source pair enables the real AG-UI leg; no vendor parity is claimed.
          const source = join(agUiRepo, "sdks/typescript/packages/core/src/generated");
          mkdirSync(source, { recursive: true });
          writeFileSync(
            join(source, "types.ts"),
            'export type TransportControl = { type: "control" };',
          );
          writeFileSync(
            join(source, "schemas.ts"),
            'export const TransportControlSchema = { type: "control" };',
          );
          const tests = join(directory, "src/__tests__/drift");
          mkdirSync(tests, { recursive: true });
          writeFileSync(
            join(tests, "agui-transport.test.ts"),
            `
            import { it, expect } from "vitest";
            import { readFileSync } from "node:fs";
            import { join } from "node:path";
            it("portable schema transport control", () => {
              const root = process.env.AGUI_REPO_PATH;
              if (!root) throw new Error("Missing transport source");
              expect(readFileSync(join(root, "sdks/typescript/packages/core/src/generated/types.ts"), "utf8")).toBe('export type TransportControl = { type: "control" };');
              expect(readFileSync(join(root, "sdks/typescript/packages/core/src/generated/schemas.ts"), "utf8")).toBe('export const TransportControlSchema = { type: "control" };');
            });
          `,
          );
        }
        const report = join(directory, "drift-report-head.json");
        const observations = join(directory, "drift-observations-head.json");
        const count =
          name === "native-size-1" ? 1 : name === "native-size-6" || clean ? 6 : undefined;
        if (count)
          writeFileSync(
            observations,
            '{"schemaVersion":1,"generatedAt":"stale","observations":[]}',
          );
        const result = await new Promise<{ status: number; stdout: string; stderr: string }>(
          (resolve, reject) => {
            execFile(
              process.execPath,
              [
                join(root, "node_modules/tsx/dist/cli.mjs"),
                join(root, "scripts/drift-report-collector.ts"),
                "--out",
                report,
                "--observations-out",
                observations,
              ],
              {
                cwd: directory,
                encoding: "utf8",
                timeout: 60_000,
                env: {
                  ...process.env,
                  AIMOCK_OBSERVATION_CHILD: "1",
                  AIMOCK_OBSERVATION_CREDENTIAL: name,
                  AIMOCK_OBSERVATION_BOUNDARY: boundary,
                  AIMOCK_OBSERVATION_NORMALIZATION: name,
                  AIMOCK_OBSERVATION_REJECTION: name,
                  AIMOCK_OBSERVATION_SIZE_COUNT: count ? String(count) : "",
                  AGUI_REPO_PATH: agUiRepo,
                },
              },
              (error, stdout, stderr) => {
                if (!error) resolve({ status: 0, stdout, stderr });
                else if (typeof error.code === "number" && !error.killed)
                  resolve({ status: error.code, stdout, stderr });
                else reject(error);
              },
            );
          },
        );
        console.log(result.stdout + result.stderr);
        if (count) {
          const invocationPath = join(
            directory,
            "drift-evidence",
            readdirSync(join(directory, "drift-evidence"))[0],
          );
          const invocation = JSON.parse(readFileSync(invocationPath, "utf8"));
          const owner = invocation.drift.assertions.find(
            (row: { title: string }) =>
              row.title === "ordinary emitter calls at reporter size boundary",
          );
          const artifact = existsSync(observations)
            ? JSON.parse(readFileSync(observations, "utf8"))
            : null;
          const shapeReport = JSON.parse(readFileSync(report, "utf8"));
          const destination = process.env.AIMOCK_F4A_B1_PROOF_DIR;
          if (destination) {
            const output = join(destination, name);
            mkdirSync(output, { recursive: true });
            copyFileSync(report, join(output, "drift-report.json"));
            copyFileSync(invocationPath, join(output, "invocation.json"));
            if (existsSync(observations))
              copyFileSync(observations, join(output, "drift-observations.json"));
          }
          console.log(
            `native size: emitted=${count}; persisted=${artifact?.observations.length ?? "invalidated"}; reporter=${owner?.consoleContext.availability}; reporter records=${owner?.consoleContext.recordCount}; collector exit=${result.status}`,
          );
          expect(owner.status).toBe("passed");
          if (clean) {
            console.log(
              `clean native size: drift exit=${invocation.drift.exitCode}; agui exit=${invocation.agui.exitCode}; ShapeDiff entries=${shapeReport.entries.length}; conclusion=${shapeReport.conclusion}; reporter=${owner.consoleContext.availability}; reporter records=${owner.consoleContext.recordCount}; collector exit=${result.status}; stale artifact=${existsSync(observations) ? "present" : "absent"}`,
            );
            expect(invocation.drift.exitCode).toBe(0);
            expect(invocation.agui.exitCode).toBe(0);
            expect(shapeReport.entries).toEqual([]);
            expect(shapeReport.conclusion).toBe("clean");
            expect(shapeReport.quarantine).toBeUndefined();
            expect(owner.consoleContext).toEqual({ availability: "unavailable", recordCount: 0 });
            expect(result.stderr).toContain(
              "Live observation evidence unavailable; observation artifact was not written.",
            );
            expect(existsSync(observations)).toBe(false);
            expect(result.status).toBe(1);
            return;
          }
          expect(shapeReport.entries).toHaveLength(1);
          expect(shapeReport.entries[0].provider).toBe("Anthropic Claude");
          expect(shapeReport.entries[0].diffs).toEqual([
            {
              id: "collector.control",
              path: "collector.control",
              severity: "critical",
              issue: "transport control",
              expected: "string",
              real: "string",
              mock: "number",
            },
          ]);
          expect(shapeReport.quarantine).toBeUndefined();
          if (count === 1) {
            expect(owner.consoleContext).toEqual({ availability: "available", recordCount: 1 });
            expect(result.stderr).not.toContain("Live observation evidence unavailable");
            expect(artifact.observations).toEqual([
              {
                surface: "anthropic",
                caseId: "size:0",
                matched: true,
                expected: { status: 200, body: "x".repeat(28_000) },
                actual: { status: 200, body: "x".repeat(28_000) },
              },
            ]);
            expect(artifact.generatedAt).toBe(shapeReport.timestamp);
          } else {
            expect(owner.consoleContext).toEqual({ availability: "unavailable", recordCount: 0 });
            expect(result.stderr).toContain(
              "Live observation evidence unavailable; observation artifact was not written.",
            );
            expect(existsSync(observations)).toBe(false);
          }
          expect(result.status).not.toBe(0);
          return;
        }
        const persisted = [report, observations]
          .filter(existsSync)
          .map((path) => readFileSync(path, "utf8"));
        const containsCanary = canary !== "" && persisted.some((value) => value.includes(canary));
        console.log(
          `credential boundary: ${name}/${boundary}; exit=${result.status}; persisted canary=${containsCanary}`,
        );
        const normalizes = normalizationCases.some((item) => item.name === name);
        if (normalizes)
          console.log(
            `JSON normalization: ${name}; exit=${result.status}; observation artifact=${existsSync(observations) ? "present" : "missing"}`,
          );
        expect(containsCanary).toBe(false);
        if (boundary === "marked") {
          expect(result.status).toBe(1);
          expect(result.stderr).toContain("Invalid or unsafe live observation");
          if (canary) expect(result.stdout + result.stderr).not.toContain(canary);
          console.log(
            `rejected observation: ${name}; report=${existsSync(report)}; artifact=${existsSync(observations)}; exit=${result.status}`,
          );
          expect(existsSync(report)).toBe(true);
          const shapeReport = JSON.parse(readFileSync(report, "utf8"));
          expect(shapeReport.entries).toHaveLength(1);
          expect(shapeReport.entries[0].provider).toBe("Anthropic Claude");
          expect(shapeReport.entries[0].diffs).toEqual([
            {
              id: "collector.control",
              path: "collector.control",
              severity: "critical",
              issue: "transport control",
              expected: "string",
              real: "string",
              mock: "number",
            },
          ]);
          expect(shapeReport.quarantine).toBeUndefined();
          expect(existsSync(observations)).toBe(false);
          console.log(
            `rejection preserved: ${name}; provider=Anthropic Claude; id=collector.control; severity=critical; expected=string; real=string; mock=number; unsafe artifact absent`,
          );
          return;
        }
        expect(result.status).toBe(2);
        if (canary) expect(result.stdout + result.stderr).not.toContain(canary);
        const shapeReport = JSON.parse(readFileSync(report, "utf8"));
        expect(shapeReport.entries).toHaveLength(1);
        expect(shapeReport.entries[0].diffs[0].path).toBe("collector.control");
        expect(shapeReport.quarantine).toBeUndefined();
        console.log(
          `actual collector: ShapeDiff entries=1; quarantine=0; observation artifact=${existsSync(observations) ? "present" : "missing"}`,
        );
        expect(existsSync(observations)).toBe(true);
        const artifact = JSON.parse(readFileSync(observations, "utf8"));
        console.log("observation artifact: " + JSON.stringify(artifact));
        expect(artifact.schemaVersion).toBe(1);
        expect(artifact.observations).toHaveLength(normalizes ? 3 : 2);
        expect(artifact.observations.map((item: { matched: boolean }) => item.matched)).toEqual([
          ...(normalizes ? [true] : []),
          true,
          false,
        ]);
        if (normalizes) {
          // The oracle is the explicit JSON contract, independent of emitter/parser calculations.
          const body = name === "negative-zero" ? 0 : [null];
          expect(artifact.observations.shift()).toEqual({
            surface: "anthropic",
            caseId: `collector:${name}`,
            expected: { status: 200, body },
            actual: { status: 200, body },
            matched: true,
          });
          console.log(
            `JSON normalization: ${name}; persisted body=${JSON.stringify(body)}; matched=true`,
          );
        }
        expect(artifact.generatedAt).toBe(shapeReport.timestamp);
        expect(artifact.observations[0]).toMatchObject({
          surface: "anthropic",
          caseId: "collector:matched",
          actual: { status: 404 },
        });
        expect(artifact.observations[0].expected).toEqual(artifact.observations[0].actual);
        // Independent literal HTTP contract; never derive these oracles from captured/artifact values.
        const nativeBody = { error: { message: "Not found", type: "not_found" } };
        expect(artifact.observations[0].expected.body).toEqual(nativeBody);
        expect(artifact.observations[0].actual.body).toEqual(nativeBody);
        expect(artifact.observations[1]).toMatchObject({
          expected: { status: 400 },
          actual: { status: 404 },
        });
        expect(artifact.observations[1].expected.body).toEqual({
          error: { message: "Expected mismatch control", type: "expected_error" },
        });
        expect(artifact.observations[1].actual.body).toEqual(nativeBody);
        console.log(
          `actual collector: observations=${artifact.observations.length}; matched=true,false; actual status=404; expected mismatch status=400; bodies preserved`,
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    90_000,
  );

  const valid = {
    surface: "anthropic",
    caseId: "auth:missing-key",
    expected: {
      status: 401,
      body: { type: "error", error: { type: "authentication_error", message: "Invalid API key" } },
    },
    actual: {
      status: 401,
      body: { type: "error", error: { type: "authentication_error", message: "Invalid API key" } },
    },
    matched: true,
  };
  const line = (value: unknown) => LIVE_OBSERVATION_PREFIX + JSON.stringify(value);

  it.each(credentialCases)("independently rejects marked $name credential evidence", ({ body }) => {
    expect(() => parseLiveObservation(line({ ...credentialInput(body), matched: false }))).toThrow(
      "Invalid or unsafe live observation",
    );
  });

  it("parses recognized surface IDs and exact native status/body values", () => {
    expect(parseLiveObservation(line(valid))).toEqual(valid);
    expect(parseLiveObservation("ordinary console output")).toBeNull();
    expect(parseLiveObservation(line({ ...valid, surface: "gemini" }))).toEqual({
      ...valid,
      surface: "gemini",
    });
  });

  it("preserves missing-version local acceptance and vendor diagnostic differences offline", () => {
    const local = {
      status: 400,
      body: {
        type: "error",
        error: { type: "invalid_request_error", message: "anthropic-version: header is required" },
      },
    };
    const vendor = {
      status: 400,
      body: {
        type: "error",
        error: { type: "invalid_request_error", message: "offline provider diagnostic" },
        request_id: "offline-request-id",
      },
    };
    for (const surface of ["anthropic-native-errors", "anthropic-catalog"]) {
      const accepted: LiveObservation = {
        surface,
        caseId: "local:missing-version-enforce",
        expected: local,
        actual: local,
        matched: true,
      };
      const mismatch: LiveObservation = {
        surface,
        caseId: "vendor:missing-version-enforce",
        expected: vendor,
        actual: local,
        matched: false,
      };
      expect(parseLiveObservation(line(accepted))).toEqual(accepted);
      expect(parseLiveObservation(line(mismatch))).toEqual(mismatch);
      const unavailable: LiveObservation = {
        ...mismatch,
        expected: { status: 503, body: "<html>offline unavailable</html>\r\n" },
      };
      expect(parseLiveObservation(line(unavailable))).toEqual(unavailable);
    }
  });

  it.each([
    { ...valid, surface: "unregistered-surface" },
    { ...valid, matched: false },
    { ...valid, actual: { ...valid.actual, status: 99 } },
    { ...valid, requestHeaders: { authorization: "excluded" } },
    { ...valid, actual: { status: 401, body: { nested: { api_key: "excluded" } } } },
    { ...valid, actual: { status: 401, body: { error: { message: "Bearer excluded" } } } },
  ])("rejects unsafe or inconsistent marked evidence without echoing it: %#", (value) => {
    expect(() => parseLiveObservation(line(value))).toThrow("Invalid or unsafe live observation");
  });

  it("rejects malformed and oversized marked evidence", () => {
    expect(() => parseLiveObservation(LIVE_OBSERVATION_PREFIX + "{")).toThrow(
      "Invalid or unsafe live observation",
    );
    expect(() => parseLiveObservation(line({ ...valid, caseId: "a".repeat(70_000) }))).toThrow(
      "Invalid or unsafe live observation",
    );
  });

  it("emitter rejects secret-bearing fields before writing any observation", () => {
    expect(() =>
      emitLiveObservation({
        surface: "anthropic",
        caseId: "unsafe",
        expected: { status: 401, body: null },
        actual: { status: 401, body: { password: "excluded" } },
      }),
    ).toThrow("Invalid or unsafe live observation");
  });
});
