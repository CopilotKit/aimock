/**
 * Model-family drift check — verify that each provider's LIVE `GET /models`
 * list contains no UNCLASSIFIED text-generation family.
 *
 * How it works (no source scraping — that path caused incident 5):
 *   1. Fetch the provider's live model list (`list*Models`).
 *   2. Normalize every id to its FAMILY key (`normalizeModelFamily`), so dated
 *      snapshots and build tags collapse onto their family
 *      (`gpt-4o-2024-08-06` → `gpt-4o`, `tts-1-1106` → `tts-1`).
 *   3. Subtract the already-classified space: `includeFamilies[provider] ∪
 *      excludeFamilies[provider]`, and drop the provider-agnostic
 *      `NON_MODEL_TOKENS` allowlist.
 *   4. Whatever remains is an UNCLASSIFIED family — the drift signal. It is
 *      surfaced as a FAILING assertion wrapped in a `formatDriftReport` block so
 *      the collector (`scripts/drift-report-collector.ts`) routes it: the
 *      `API DRIFT DETECTED` block parses into critical entries (exit-2 auto-fix
 *      lane); anything it cannot map falls to exit-5 quarantine.
 *
 * Comparing NORMALIZED families (not raw ids) is what makes this converge:
 * appending every new dated snapshot to a known-id set never stabilizes and
 * turns the daily job permanently red on false positives (incident 2). Only a
 * genuinely NEW family (e.g. `gpt-live`) is ever flagged.
 *
 * Because nothing is scraped from source, an aimock "provider mode" prose token
 * (e.g. `gemini-interactions`) can never enter the pipeline as a candidate id —
 * the only inputs are the provider's own `/models` payload.
 *
 * This file is the SPEC — the env gate and the `it()`, nothing more. The
 * pipeline itself (`unclassifiedFamilies`), its live assertion wrapper
 * (`assertNoUnclassifiedFamilies`), the leg body the canaries below call
 * (`runUnclassifiedFamilyCanary`) and the C4 deprecation detector all live in
 * `text-drift.ts`, which registers no suites — so another spec, or the offline
 * fetch-stubbed guard in `live-canary-silence.test.ts`, can import and drive
 * them without also adopting the LIVE canaries below (see that module's header).
 */

import { createServer } from "node:http";
import { execFile } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { DriftReport } from "../../../scripts/drift-types.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startGoldenServer, type GoldenServer } from "../golden/harness.js";
import { formatDriftReport } from "./schema.js";
import { nativeResponseDiffs } from "./sdk-shapes.js";
import {
  emitLiveObservation,
  type LiveObservation,
  type ObservedResponse,
} from "./live-observations.js";
import { InfraError, isInfraSkip } from "./providers.js";
import { includeFamilies, excludeFamilies } from "./model-registry.js";
import { isFamilyStillReferenced } from "./deprecation-detector.js";
import {
  unclassifiedFamilies,
  runUnclassifiedFamilyCanary,
  detectDeprecatedFamilies,
  checkDeprecatedFamiliesLive,
} from "./text-drift.js";

// Verified docs: platform.claude.com/docs/en/api/models/list and
// ai.google.dev/api/models (2026-10-13). Bounds and lifecycle enums are
// documented; exact error text, unknown cursors and mock offset tokens are not.
const emptyAnthropicPage = { data: [], has_more: false, first_id: null, last_id: null };
const anthropicCatalogCases = [
  {
    id: "anthropic-limit-zero",
    query: "limit=0",
    expected: {
      status: 400,
      body: {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "limit must be an integer between 1 and 1000",
        },
      },
    },
  },
  {
    id: "anthropic-limit-large",
    query: "limit=1001",
    expected: {
      status: 400,
      body: {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "limit must be an integer between 1 and 1000",
        },
      },
    },
  },
  {
    id: "anthropic-limit-fractional",
    query: "limit=1.5",
    expected: {
      status: 400,
      body: {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "limit must be an integer between 1 and 1000",
        },
      },
    },
  },
  {
    id: "anthropic-after-unknown",
    query: "after_id=aimock-nonexistent-model",
    expected: {
      status: 400,
      body: {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "Model with id aimock-nonexistent-model not found",
        },
      },
    },
  },
  {
    id: "anthropic-before-unknown",
    query: "before_id=aimock-nonexistent-model",
    expected: {
      status: 400,
      body: {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "Model with id aimock-nonexistent-model not found",
        },
      },
    },
  },
  {
    id: "anthropic-lifecycle-invalid",
    query: "lifecycle=unknown",
    expected: {
      status: 400,
      body: {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "lifecycle must contain active, deprecated, or retired",
        },
      },
    },
  },
  {
    id: "anthropic-lifecycle-retired",
    query: "lifecycle=retired",
    expected: { status: 200, body: emptyAnthropicPage },
  },
] satisfies { id: string; query: string; expected: ObservedResponse }[];
const geminiCatalogCases = [
  {
    id: "gemini-page-size-negative",
    query: "pageSize=-1",
    expected: {
      status: 400,
      body: {
        error: {
          code: 400,
          message: "pageSize must be a nonnegative integer",
          status: "INVALID_ARGUMENT",
        },
      },
    },
  },
  {
    id: "gemini-page-size-fractional",
    query: "pageSize=1.5",
    expected: {
      status: 400,
      body: {
        error: {
          code: 400,
          message: "pageSize must be a nonnegative integer",
          status: "INVALID_ARGUMENT",
        },
      },
    },
  },
  {
    id: "gemini-page-token-invalid",
    query: "pageToken=not-a-token",
    expected: {
      status: 400,
      body: {
        error: {
          code: 400,
          message: "pageToken must be a valid catalog offset token",
          status: "INVALID_ARGUMENT",
        },
      },
    },
  },
] satisfies { id: string; query: string; expected: ObservedResponse }[];
let nativeCatalogServer: GoldenServer;
let nativeVersionServer: GoldenServer;
const nativeVersionCases = [
  { path: "/v1/models", caseId: "anthropic-models-missing-version-enforce" },
  {
    path: "/v1/models/claude-sonnet-4-5",
    caseId: "anthropic-model-detail-missing-version-enforce",
  },
] as const;
const nativeVersionExpected: ObservedResponse = {
  status: 400,
  body: {
    type: "error",
    error: { type: "invalid_request_error", message: "anthropic-version: header is required" },
    request_id: "req_f6b_required_version",
  },
};
beforeAll(async () => {
  nativeCatalogServer = await startGoldenServer([]);
  nativeVersionServer = await startGoldenServer([], {
    auth: { apiKeys: ["local-native-auth"] },
    policy: { requiredHeaders: "enforce" },
  });
});
afterAll(async () => {
  await nativeCatalogServer.close();
  await nativeVersionServer.close();
});

describe("native provider catalog local contracts", () => {
  it.each(nativeVersionCases)("local enforced missing-version $path", async ({ path, caseId }) => {
    const response = await fetch(`${nativeVersionServer.url}${path}`, {
      headers: { "x-api-key": "local-native-auth", "x-request-id": "req_f6b_required_version" },
    });
    const actual: ObservedResponse = { status: response.status, body: await response.json() };
    emitLiveObservation({
      surface: "anthropic-catalog",
      caseId: `local:${caseId}`,
      expected: nativeVersionExpected,
      actual,
    });
    const diffs = nativeResponseDiffs(nativeVersionExpected, actual, true);
    expect(
      diffs,
      formatDriftReport(
        `Anthropic catalog enforced missing-version ${path}`,
        diffs,
        "anthropic-catalog",
      ),
    ).toEqual([]);
  });
  it.each(["different-error-envelope", "error"])(
    "compares the top-level native discriminator %s from a real response",
    async (type) => {
      const response = await fetch(`${nativeCatalogServer.url}/v1/models?limit=0`, {
        headers: { "anthropic-version": "2023-06-01" },
      });
      const actual: ObservedResponse = { status: response.status, body: await response.json() };
      expect(actual).toEqual(anthropicCatalogCases[0].expected);
      const expected = {
        ...actual,
        body: { ...anthropicCatalogCases[0].expected.body, type },
      };
      const diffs = nativeResponseDiffs(expected, actual);
      expect(diffs).toEqual(
        type === "error"
          ? []
          : [
              {
                path: "type",
                severity: "critical",
                issue: "Native response value differs",
                expected: '"different-error-envelope"',
                real: '"different-error-envelope"',
                mock: '"error"',
              },
            ],
      );
      expect(
        formatDriftReport("Anthropic native type control", diffs, "anthropic-catalog"),
      ).toContain(type === "error" ? "No drift detected" : "Surface: anthropic-catalog");
      const diagnostic = (message: string, request_id: string) => ({
        ...actual,
        body: {
          type: "error",
          error: { type: "invalid_request_error", message },
          request_id,
        },
      });
      expect(
        nativeResponseDiffs(
          diagnostic("expected diagnostic", "expected-request"),
          diagnostic("actual diagnostic", "actual-request"),
        ),
      ).toEqual([]);
    },
  );
  it("reports value-only drift from a real native response through ShapeDiff", async () => {
    const response = await fetch(`${nativeCatalogServer.url}/v1/models?limit=0`, {
      headers: { "anthropic-version": "2023-06-01" },
    });
    const actual: ObservedResponse = { status: response.status, body: await response.json() };
    const diffs = nativeResponseDiffs({ ...actual, status: 401 }, actual);
    expect(diffs).toEqual([
      {
        path: "status",
        severity: "critical",
        issue: "Native response value differs",
        expected: "401",
        real: "401",
        mock: "400",
      },
    ]);
    expect(
      formatDriftReport("Anthropic native status control", diffs, "anthropic-catalog"),
    ).toContain("Surface: anthropic-catalog");
  });
  it.each(anthropicCatalogCases)("$id", async ({ id, query, expected }) => {
    const response = await fetch(`${nativeCatalogServer.url}/v1/models?${query}`, {
      headers: { "anthropic-version": "2023-06-01" },
    });
    const actual: ObservedResponse = { status: response.status, body: await response.json() };
    emitLiveObservation({ surface: "anthropic-catalog", caseId: `local:${id}`, expected, actual });
    const diffs = nativeResponseDiffs(expected, actual, true);
    expect(
      diffs,
      formatDriftReport(`Anthropic catalog local contract ${id}`, diffs, "anthropic-catalog"),
    ).toEqual([]);
  });
  it.each(geminiCatalogCases)("$id", async ({ id, query, expected }) => {
    const response = await fetch(`${nativeCatalogServer.url}/v1beta/models?${query}`);
    const actual: ObservedResponse = { status: response.status, body: await response.json() };
    emitLiveObservation({ surface: "gemini-catalog", caseId: `local:${id}`, expected, actual });
    const diffs = nativeResponseDiffs(expected, actual, true);
    expect(
      diffs,
      formatDriftReport(`Gemini catalog local contract ${id}`, diffs, "gemini-catalog"),
    ).toEqual([]);
  });
});

function registerNativeCatalogObservation(
  id: string,
  surface: string,
  caseId: string,
  capture: () => Promise<{ expected: ObservedResponse; actual: ObservedResponse }>,
  allDiffs = false,
  assertionTitle = id,
) {
  let captured: ReturnType<typeof capture> | undefined;
  const receive = () => (captured ??= capture());
  // Received evidence needs an eligible owner even when comparison is skipped.
  it(`${assertionTitle} received status/body (evidence only)`, async () => {
    const observation = await receive();
    emitLiveObservation({ surface, caseId, ...observation });
  });
  it(`${assertionTitle} comparison`, async (context) => {
    const observation = await receive();
    if ([401, 403, 429].includes(observation.expected.status) || observation.expected.status >= 500)
      context.skip(
        "Comparison UNAVAILABLE: access/rate/service error; vendor conformance unverified",
      );
    const diffs = nativeResponseDiffs(observation.expected, observation.actual);
    expect(
      allDiffs ? diffs : diffs.filter((diff) => diff.severity === "critical"),
      formatDriftReport(`Native catalog comparison ${id}`, diffs, surface),
    ).toEqual([]);
  });
}

async function receiveNativeCatalogResponse(response: Response): Promise<ObservedResponse> {
  // Keep literal empty/non-JSON bodies; comparison owns unavailable status policy.
  return {
    status: response.status,
    body: await response
      .clone()
      .json()
      .catch(() => response.text()),
  };
}

// Opt-in, read-only vendor requests; no inference/token spend, retries or fake
// vendor responses. Full status/body records precede comparison/infra handling.
const nativeProviderDrift = process.env.AIMOCK_NATIVE_PROVIDER_DRIFT === "1";
describe.skipIf(!nativeProviderDrift || !process.env.ANTHROPIC_API_KEY)(
  "native provider Anthropic catalog vendor observations",
  () => {
    for (const { path, caseId } of nativeVersionCases) {
      registerNativeCatalogObservation(
        `Anthropic catalog vendor enforced missing-version ${path}`,
        "anthropic-catalog",
        `vendor:${caseId}`,
        async () => {
          const response = await fetch(`https://api.anthropic.com${path}`, {
            headers: { "x-api-key": process.env.ANTHROPIC_API_KEY ?? "" },
            signal: AbortSignal.timeout(15000),
          });
          const expected = await receiveNativeCatalogResponse(response);
          const local = await fetch(`${nativeVersionServer.url}${path}`, {
            headers: {
              "x-api-key": "local-native-auth",
              "x-request-id": "req_f6b_required_version",
            },
          });
          const actual: ObservedResponse = { status: local.status, body: await local.json() };
          return { expected, actual };
        },
        true,
        `Anthropic catalog vendor enforced missing-version ${path.startsWith("/v1/models/") ? "/v1/models/:model" : path}`,
      );
    }
    for (const { id, query } of anthropicCatalogCases.filter(
      (item) => item.id !== "anthropic-lifecycle-retired",
    )) {
      registerNativeCatalogObservation(id, "anthropic-catalog", `vendor:${id}`, async () => {
        const response = await fetch(`https://api.anthropic.com/v1/models?${query}`, {
          headers: {
            "anthropic-version": "2023-06-01",
            "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
          },
          signal: AbortSignal.timeout(15000),
        });
        const vendor = await receiveNativeCatalogResponse(response);
        const local = await fetch(`${nativeCatalogServer.url}/v1/models?${query}`, {
          headers: { "anthropic-version": "2023-06-01" },
        });
        const actual: ObservedResponse = { status: local.status, body: await local.json() };
        return { expected: vendor, actual };
      });
    }
  },
);
describe.skipIf(!nativeProviderDrift || !process.env.GOOGLE_API_KEY)(
  "native provider Gemini catalog vendor observations",
  () => {
    for (const { id, query } of geminiCatalogCases) {
      registerNativeCatalogObservation(id, "gemini-catalog", `vendor:${id}`, async () => {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?${query}`,
          {
            headers: { "x-goog-api-key": process.env.GOOGLE_API_KEY ?? "" },
            signal: AbortSignal.timeout(15000),
          },
        );
        const vendor = await receiveNativeCatalogResponse(response);
        const local = await fetch(`${nativeCatalogServer.url}/v1beta/models?${query}`);
        const actual: ObservedResponse = { status: local.status, body: await local.json() };
        return { expected: vendor, actual };
      });
    }
  },
);

// These are controlled localhost responses, never vendor evidence. The child
// collector selects only this suite, exercising the same catalog producer.
const nativeRawResponseCases = [
  { id: "empty-unavailable", status: 429, body: "" },
  { id: "html-unavailable", status: 503, body: "<html>controlled unavailable</html>\r\n" },
  { id: "html-unexpected", status: 418, body: "<html>controlled unexpected</html>" },
] as const;
const nativeBodyControls = [
  {
    id: "nested-discriminator",
    error: { type: "controlled_expected_error" },
    exactBody: false,
    path: "error.type",
    expected: '"controlled_expected_error"',
    actual: '"invalid_request_error"',
  },
  {
    id: "exact-body",
    error: { message: "controlled expected diagnostic" },
    exactBody: true,
    path: "body",
    expected:
      '{"type":"error","error":{"type":"invalid_request_error","message":"controlled expected diagnostic"}}',
    actual:
      '{"type":"error","error":{"type":"invalid_request_error","message":"limit must be an integer between 1 and 1000"}}',
  },
] as const;
describe.skipIf(process.env.AIMOCK_NATIVE_LIFECYCLE_CHILD !== "1")(
  "native provider controlled response lifecycle",
  () => {
    const server = createServer((request, response) => {
      const rawCase = nativeRawResponseCases.find((item) => request.url === `/${item.id}`);
      if (rawCase) {
        response.writeHead(rawCase.status, { "content-type": "text/html" });
        response.end(rawCase.body);
        return;
      }
      response.writeHead(Number(request.url?.slice(1)), { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          Number(request.url?.slice(1)) === 400
            ? anthropicCatalogCases[0].expected.body
            : {
                type: "error",
                error: { type: "invalid_request_error", message: "controlled localhost response" },
              },
        ),
      );
    });
    let url: string;
    beforeAll(async () => {
      await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No controlled HTTP address");
      url = `http://127.0.0.1:${address.port}`;
    });
    afterAll(async () => {
      await new Promise<void>((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
      );
    });
    const capture = async (status: number | string) => {
      const response = await fetch(`${url}/${status}`);
      const expected = await receiveNativeCatalogResponse(response);
      const local = await fetch(`${nativeCatalogServer.url}/v1/models?limit=0`, {
        headers: { "anthropic-version": "2023-06-01" },
      });
      const actual: ObservedResponse = { status: local.status, body: await local.json() };
      return { expected, actual };
    };
    for (const [id, status] of [
      ["unavailable", 429],
      ["eligible-pass", 400],
      ["eligible-fail", 418],
    ] as const) {
      registerNativeCatalogObservation(id, "anthropic-catalog", `local:a3-${id}`, () =>
        capture(status),
      );
    }
    for (const { id } of nativeRawResponseCases)
      registerNativeCatalogObservation(id, "anthropic-catalog", `local:a1-${id}`, () =>
        capture(id),
      );
    it.each(nativeBodyControls)("$id comparison control", async (control) => {
      const response = await fetch(`${nativeCatalogServer.url}/v1/models?limit=0`, {
        headers: { "anthropic-version": "2023-06-01" },
      });
      const actual: ObservedResponse = { status: response.status, body: await response.json() };
      expect(actual).toEqual(anthropicCatalogCases[0].expected);
      const body = anthropicCatalogCases[0].expected.body;
      if (!("error" in body)) throw new Error("Expected native catalog error fixture");
      const expected = {
        ...actual,
        body: { ...body, error: { ...body.error, ...control.error } },
      };
      const diffs = nativeResponseDiffs(expected, actual, control.exactBody);
      // Deliberately fail so the real formatter/reporter/collector must deliver this difference.
      expect(
        diffs,
        formatDriftReport(`Native catalog body control ${control.id}`, diffs, "anthropic-catalog"),
      ).toEqual([]);
    });
    it("eligible failed owner", async () => {
      const observation = await capture(418);
      emitLiveObservation({
        surface: "anthropic-catalog",
        caseId: "local:a3-failed-owner",
        ...observation,
      });
      const diffs = nativeResponseDiffs(observation.expected, observation.actual);
      expect(
        diffs,
        formatDriftReport("Native catalog failed-owner control", diffs, "anthropic-catalog"),
      ).toEqual([]);
    });
    it.skip("no-request skip", () => {
      throw new Error("Skipped request must never run");
    });
  },
);

describe("native provider response evidence delivery", () => {
  it("persists received responses while unavailable comparison remains unverified", async () => {
    const directory = mkdtempSync(join(tmpdir(), "aimock-native-lifecycle-"));
    const root = resolve(import.meta.dirname, "../../..");
    try {
      symlinkSync(join(root, "node_modules"), join(directory, "node_modules"));
      mkdirSync(join(directory, "unavailable-agui"));
      writeFileSync(join(directory, "package.json"), '{"type":"module"}');
      writeFileSync(
        join(directory, "vitest.config.drift.ts"),
        `export default {test:{include:[${JSON.stringify(join(root, "src/__tests__/drift/models.drift.ts"))}],testNamePattern:'native provider controlled response lifecycle',pool:'forks',maxWorkers:1,fileParallelism:false}};`,
      );
      const environment: NodeJS.ProcessEnv = {};
      for (const name of ["PATH", "HOME", "TMPDIR", "SystemRoot", "WINDIR"])
        environment[name] = process.env[name];
      environment.AIMOCK_NATIVE_LIFECYCLE_CHILD = "1";
      environment.AGUI_REPO_PATH = join(directory, "unavailable-agui");
      const child = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
        (resolveChild) => {
          execFile(
            process.execPath,
            [
              join(root, "node_modules/tsx/dist/cli.mjs"),
              join(root, "scripts/drift-report-collector.ts"),
            ],
            { cwd: directory, env: environment, timeout: 30000, maxBuffer: 10 * 1024 * 1024 },
            (error, stdout, stderr) => {
              resolveChild({
                status: error ? (typeof error.code === "number" ? error.code : null) : 0,
                stdout,
                stderr,
              });
            },
          );
        },
      );
      expect(child.status, child.stdout + child.stderr).toBe(2); // Deliberate eligible-fail control.
      const artifact: { observations: LiveObservation[] } = JSON.parse(
        readFileSync(join(directory, "drift-observations.json"), "utf8"),
      );
      const actual = anthropicCatalogCases[0].expected;
      expect(artifact.observations).toEqual([
        ...[429, 400, 418].map((status, index) => ({
          surface: "anthropic-catalog",
          caseId: `local:a3-${["unavailable", "eligible-pass", "eligible-fail"][index]}`,
          expected: {
            status,
            body:
              status === 400
                ? actual.body
                : {
                    type: "error",
                    error: {
                      type: "invalid_request_error",
                      message: "controlled localhost response",
                    },
                  },
          },
          actual,
          matched: status === 400,
        })),
        ...nativeRawResponseCases.map(({ id, status, body }) => ({
          surface: "anthropic-catalog",
          caseId: `local:a1-${id}`,
          expected: { status, body },
          actual,
          matched: false,
        })),
        {
          surface: "anthropic-catalog",
          caseId: "local:a3-failed-owner",
          expected: {
            status: 418,
            body: {
              type: "error",
              error: { type: "invalid_request_error", message: "controlled localhost response" },
            },
          },
          actual,
          matched: false,
        },
      ]);
      const report: DriftReport = JSON.parse(
        readFileSync(join(directory, "drift-report.json"), "utf8"),
      );
      expect(report.quarantine ?? []).toEqual([]);
      expect(
        report.entries.filter((entry) => entry.scenario.startsWith("Native catalog body control ")),
      ).toEqual(
        nativeBodyControls.map((control) => ({
          provider: "Anthropic native catalog",
          scenario: `Native catalog body control ${control.id}`,
          builderFile: "src/response/catalog/anthropic-page.ts",
          builderFunctions: ["anthropicPage", "renderAnthropicModels"],
          typesFile: null,
          sdkShapesFile: "src/__tests__/drift/sdk-shapes.ts",
          diffs: [
            {
              path: control.path,
              id: control.path,
              severity: "critical",
              issue: "Native response value differs",
              expected: control.expected,
              real: control.expected,
              mock: control.actual,
            },
          ],
        })),
      );
      expect(
        report.entries.find(
          (entry) => entry.scenario === "Native catalog comparison html-unexpected",
        ),
      ).toMatchObject({
        builderFile: "src/response/catalog/anthropic-page.ts",
        builderFunctions: ["anthropicPage", "renderAnthropicModels"],
        diffs: expect.arrayContaining([
          expect.objectContaining({ path: "(root)", severity: "critical", real: "string" }),
        ]),
      });
      const evidence: {
        drift: {
          assertions: {
            title: string;
            status: string;
            disposition: string;
            consoleContext: { recordCount: number };
          }[];
        };
      } = JSON.parse(
        readFileSync(
          join(directory, "drift-evidence", readdirSync(join(directory, "drift-evidence"))[0]),
          "utf8",
        ),
      );
      expect(evidence.drift.assertions).toEqual(
        expect.arrayContaining([
          ...nativeRawResponseCases.flatMap(({ id }) => [
            expect.objectContaining({
              title: `${id} received status/body (evidence only)`,
              status: "passed",
              disposition: "UNAVAILABLE",
              consoleContext: { availability: "available", recordCount: 1 },
            }),
            expect.objectContaining({
              title: `${id} comparison`,
              status: id === "html-unexpected" ? "failed" : "skipped",
              disposition: id === "html-unexpected" ? "FAILED" : "SKIPPED",
            }),
          ]),
          expect.objectContaining({
            title: "eligible-pass received status/body (evidence only)",
            status: "passed",
          }),
          expect.objectContaining({
            title: "eligible-pass comparison",
            status: "passed",
          }),
          expect.objectContaining({
            title: "eligible-fail comparison",
            status: "failed",
            disposition: "FAILED",
          }),
          expect.objectContaining({
            title: "eligible failed owner",
            status: "failed",
            disposition: "FAILED",
            consoleContext: { availability: "available", recordCount: 1 },
          }),
          expect.objectContaining({
            title: "unavailable comparison",
            status: "skipped",
            disposition: "SKIPPED",
          }),
          expect.objectContaining({
            title: "unavailable received status/body (evidence only)",
            status: "passed",
            disposition: "UNAVAILABLE",
          }),
          expect.objectContaining({
            title: "no-request skip",
            status: "skipped",
            consoleContext: { availability: "available", recordCount: 0 },
          }),
        ]),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("C4: detectDeprecatedFamilies (classified − live, fail-closed)", () => {
  it("FAIL-CLOSED: an empty live listing never proposes removal", () => {
    const result = detectDeprecatedFamilies([], "openai");
    expect(result.status).toBe("skipped");
  });

  it("FAIL-CLOSED: a short/truncated live listing never proposes removal", () => {
    // Far fewer raw ids than openai's include-family count — a truncated
    // listing, not a genuinely tiny provider catalog.
    const result = detectDeprecatedFamilies(["gpt-4o"], "openai");
    expect(result.status).toBe("skipped");
  });

  it("a healthy listing omitting a classified family flags EXACTLY that family", () => {
    // A healthy-sized live listing (>= the fail-closed floor) covering every
    // include family EXCEPT gpt-4o, whose family is genuinely missing.
    const allButGpt4o = [...includeFamilies.openai].filter((f) => f !== "gpt-4o");
    const liveIds = [...allButGpt4o, ...allButGpt4o.map((f) => `${f}-2025-01-01`)];
    const result = detectDeprecatedFamilies(liveIds, "openai", { isReferenced: () => false });
    expect(result.status).toBe("checked");
    if (result.status !== "checked") return;
    expect(result.candidates).toEqual([
      { provider: "openai", family: "gpt-4o", stillReferenced: false },
    ]);
  });

  it("a still-referenced deprecated family routes to human (stillReferenced: true)", () => {
    const allButGpt4o = [...includeFamilies.openai].filter((f) => f !== "gpt-4o");
    const liveIds = [...allButGpt4o, ...allButGpt4o.map((f) => `${f}-2025-01-01`)];
    const result = detectDeprecatedFamilies(liveIds, "openai", { isReferenced: () => true });
    expect(result.status).toBe("checked");
    if (result.status !== "checked") return;
    expect(result.candidates).toEqual([
      { provider: "openai", family: "gpt-4o", stillReferenced: true },
    ]);
  });

  it("a healthy listing missing nothing reports zero candidates", () => {
    const allFamilies = [...includeFamilies.openai];
    const liveIds = [...allFamilies, ...allFamilies.map((f) => `${f}-2025-01-01`)];
    const result = detectDeprecatedFamilies(liveIds, "openai");
    expect(result.status).toBe("checked");
    if (result.status !== "checked") return;
    expect(result.candidates).toEqual([]);
  });
});

describe("C4: checkDeprecatedFamiliesLive (infra-error short-circuit via isInfraSkip)", () => {
  it("an infra error (401/402/403/429/5xx) is an honest SKIP, never a removal signal", async () => {
    for (const status of [401, 402, 403, 429, 503]) {
      expect(isInfraSkip(status)).toBe(true); // R0 classification consumed directly below
      const result = await checkDeprecatedFamiliesLive(
        () => Promise.reject(new InfraError("boom", status)),
        "openai",
      );
      expect(result.status).toBe("skipped");
    }
  });

  it("a genuine non-infra error propagates (never silently swallowed as a skip)", async () => {
    await expect(
      checkDeprecatedFamiliesLive(() => Promise.reject(new Error("boom, not infra")), "openai"),
    ).rejects.toThrow("boom, not infra");
  });

  it("an InfraError with a non-skip status (e.g. 404) still propagates", async () => {
    expect(isInfraSkip(200)).toBe(false);
    expect(isInfraSkip(404)).toBe(false);
    // …and the wrapper really does re-throw it. Asserting `isInfraSkip` alone
    // left the `err instanceof InfraError && !isInfraSkip(status)` branch — an
    // InfraError that must NOT become a silent skip — never executed.
    await expect(
      checkDeprecatedFamiliesLive(
        () => Promise.reject(new InfraError("404 not an infra skip", 404)),
        "openai",
      ),
    ).rejects.toThrow("404 not an infra skip");
  });

  it("a healthy fetch flows through to the deterministic diff", async () => {
    const allButGpt4o = [...includeFamilies.openai].filter((f) => f !== "gpt-4o");
    const liveIds = [...allButGpt4o, ...allButGpt4o.map((f) => `${f}-2025-01-01`)];
    const result = await checkDeprecatedFamiliesLive(() => Promise.resolve(liveIds), "openai", {
      isReferenced: () => false,
    });
    expect(result.status).toBe("checked");
    if (result.status !== "checked") return;
    expect(result.candidates).toEqual([
      { provider: "openai", family: "gpt-4o", stillReferenced: false },
    ]);
  });
});

describe("C4: isFamilyStillReferenced (real source-tree ref-scan, zero-LLM)", () => {
  it("finds a real reference (gpt-4 and gpt-4o are both referenced in src/server.ts)", () => {
    expect(isFamilyStillReferenced("gpt-4")).toBe(true);
    expect(isFamilyStillReferenced("gpt-4o")).toBe(true);
  });

  it("reports zero-reference for a synthetic family that appears nowhere in src/", () => {
    expect(isFamilyStillReferenced("zzz-totally-fictional-family-not-real")).toBe(false);
  });

  it("does not false-positive from being a strict substring of a longer live id", () => {
    // A naive substring scan would call "gpt-4" referenced merely because
    // "gpt-4-turbo"/"gpt-4o" appear in source; the boundary-aware scan must
    // not confuse the two. gpt-4 IS separately, exactly referenced in
    // DEFAULT_MODELS (asserted above) — this confirms the match is a real
    // boundary hit, not a substring artifact.
    expect(isFamilyStillReferenced("gpt-4-turbo-nonexistent-suffix")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Regression suite (no live keys) — exercises the REAL pipeline with injected
// `/models` payloads. Runs unconditionally so the drift job proves the
// enumerate→normalize→subtract behavior even when live keys are absent.
// ---------------------------------------------------------------------------

describe("model-family pipeline (injected /models)", () => {
  it("incident 2: dated snapshots of included families produce ZERO drift", () => {
    // Payload of dated/build-tag snapshots whose FAMILIES are all in
    // includeFamilies/excludeFamilies. The old scrape+substring path would have
    // flagged these dated ids as unknown; the normalize+subtract path collapses
    // each onto its known family, so the unclassified delta must be empty.
    const openaiPayload = [
      "gpt-4o-2024-08-06", // → gpt-4o (include)
      "gpt-4o-mini-2024-07-18", // → gpt-4o-mini (include)
      "gpt-4.1-2025-04-14", // → gpt-4.1 (include)
      "gpt-audio-2025-08-28", // → gpt-audio (exclude)
      "tts-1-1106", // → tts-1 (exclude)
      "gpt-4o-mini-tts-2025-12-15", // → gpt-4o-mini-tts (exclude)
    ];
    expect(unclassifiedFamilies(openaiPayload, "openai")).toEqual([]);

    // Gemini dated variants collapse via the same dated-snapshot strip.
    const geminiPayload = [
      "gemini-2.5-flash", // include
      "gemini-2.0-flash", // include
      "gemini-1.5-pro-2024-05-14", // → gemini-1.5-pro (exclude)
    ];
    expect(unclassifiedFamilies(geminiPayload, "gemini")).toEqual([]);

    // Anthropic uses a CONTIGUOUS 8-digit snapshot suffix (`-YYYYMMDD`), not the
    // dashed `-YYYY-MM-DD` form. These must collapse onto their included family
    // via the anthropic-specific strip, or every dated Claude id false-positives
    // as drift (the incident-2 class, for Anthropic).
    const anthropicPayload = [
      "claude-3-5-sonnet-20241022", // → claude-3-5-sonnet (include)
      "claude-3-7-sonnet-20250219", // → claude-3-7-sonnet (include)
      "claude-3-5-haiku-20241022", // → claude-3-5-haiku (include)
    ];
    expect(unclassifiedFamilies(anthropicPayload, "anthropic")).toEqual([]);
  });

  it("a prose provider-mode token can never enter as a candidate", () => {
    // Nothing is scraped from source, so a `gemini-interactions`-style token can
    // only appear if a provider's own /models returned it — and even then it is
    // on NON_MODEL_TOKENS and never becomes drift.
    expect(unclassifiedFamilies(["gemini-interactions"], "gemini")).toEqual([]);
  });

  it("a genuinely new family IS flagged as unclassified drift", () => {
    // Guard the other side: the canary must still fire for a real new family.
    expect(unclassifiedFamilies(["gpt-live"], "openai")).toEqual(["gpt-live"]);
    // Single-digit trailing suffix is NOT a build tag, so it stays unknown.
    // (`gpt-live-1` itself is an EXCLUDE key as of 2026-09-10 — the full-duplex
    // /v1/live/sessions voice family — so the exemplar here is an unclassified
    // sibling, and `gpt-live-1-mini` guards against the new key swallowing
    // families that merely EXTEND it.)
    expect(unclassifiedFamilies(["gpt-live-9"], "openai")).toEqual(["gpt-live-9"]);
    expect(unclassifiedFamilies(["gpt-live-1-mini"], "openai")).toEqual(["gpt-live-1-mini"]);
  });
});

// ---------------------------------------------------------------------------
// PREVIEW_FAMILY exclude-by-rule predicate (the durable hardening).
// ---------------------------------------------------------------------------

describe("preview families are excluded by rule", () => {
  it("a brand-new -preview family auto-excludes with zero registry edits", () => {
    // Not in include or exclude — classified purely by the trailing-preview rule.
    expect(unclassifiedFamilies(["gemini-9-pro-preview"], "gemini")).toEqual([]);
    expect(unclassifiedFamilies(["gpt-9-search-preview"], "openai")).toEqual([]);
  });

  it("matches a trailing short numeric preview build tag (-preview-NN)", () => {
    // The normalizer leaves 2-digit tails intact, so the rule must cover them.
    expect(unclassifiedFamilies(["antigravity-preview-05"], "gemini")).toEqual([]);
    expect(unclassifiedFamilies(["deep-research-pro-preview-12"], "gemini")).toEqual([]);
  });

  it("does NOT match interior -preview-<word> suffixes (they stay enumerated)", () => {
    // `-preview-tts` / `-preview-customtools` are non-text specialty surfaces
    // enumerated explicitly; a hypothetical UNLISTED interior-suffix family must
    // still fire as drift so its category is not silently swallowed.
    expect(unclassifiedFamilies(["gemini-x-flash-preview-widgets"], "gemini")).toEqual([
      "gemini-x-flash-preview-widgets",
    ]);
  });
});

// ---------------------------------------------------------------------------
// GEMMA_FAMILY exclude-by-rule predicate (open-weight, out of scope).
// ---------------------------------------------------------------------------

describe("gemma families are excluded by rule", () => {
  it("a future Gemma variant auto-excludes with zero registry edits", () => {
    // `gemma-9-foo` has no numeric-only build tag to strip, so it normalizes to
    // itself and is on NEITHER include nor exclude — classified purely by the
    // gemma rule. Red against the old literal-names-only exclude set; green with
    // the pattern.
    expect(unclassifiedFamilies(["gemma-9-foo"], "gemini")).toEqual([]);
    // The two originally-enumerated literals still classify (now via the rule).
    expect(unclassifiedFamilies(["gemma-4-26b-a4b-it", "gemma-4-31b-it"], "gemini")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Regression: the live /models family wave, seeded from run 29478043559
// (2026-07-16; OpenAI 48 / Anthropic 10 / Gemini 45 unclassified families then)
// and extended with families classified in some later waves. This suite
// injects representative raw ids into the REAL enumerate→normalize→subtract
// pipeline and asserts the registry classifies all of them — zero drift. It
// exercises the same `unclassifiedFamilies` surface the live canary uses, so it is a true
// regression against the classification (not a fake against a private copy).
// ---------------------------------------------------------------------------

describe("recorded /models family waves are classified", () => {
  it("OpenAI: every live family is classified (zero unclassified)", () => {
    const openaiLive = [
      // Existing include families (dated snapshots collapse onto them)
      "gpt-3.5-turbo",
      "gpt-4",
      "gpt-4-turbo",
      "gpt-4o-2024-08-06",
      "gpt-4o-mini",
      "gpt-4.1",
      "gpt-4.1-mini",
      "gpt-4.1-nano",
      "gpt-5",
      "gpt-5-mini",
      // Newly-classified INCLUDE: gpt-5.x tiers + chat surfaces
      "gpt-5-chat-latest",
      "gpt-5.1-chat-latest",
      "gpt-5.2-chat-latest",
      "gpt-5.3-chat-latest",
      "gpt-5-nano",
      "gpt-5-pro",
      "gpt-5.1",
      "gpt-5.2",
      "gpt-5.2-pro",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.4-nano",
      "gpt-5.4-pro",
      "gpt-5.5",
      "gpt-5.5-pro",
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      // gpt-6 named variants (2026-09-23 wave)
      "gpt-6-luna",
      "gpt-6-sol",
      // gpt-6.1 point release (2026-09-24..30 wave, first listed 09-30; its own
      // normalized family)
      "gpt-6.1-sol",
      // o-series reasoning
      "o1",
      "o1-pro",
      "o3",
      "o3-mini",
      "o3-pro",
      "o4-mini",
      // Codex line
      "gpt-5-codex",
      "gpt-5.1-codex",
      "gpt-5.1-codex-max",
      "gpt-5.1-codex-mini",
      "gpt-5.2-codex",
      "gpt-5.3-codex",
      // Newly-classified EXCLUDE: retired base
      "babbage-002",
      "davinci-002",
      "gpt-3.5-turbo-16k",
      "gpt-3.5-turbo-instruct",
      // deep-research / search / computer-use surfaces
      "o3-deep-research",
      "o4-mini-deep-research",
      "gpt-5-search-api",
      "gpt-4o-search-preview", // preview pattern
      "gpt-4o-mini-search-preview", // preview pattern
      "computer-use-preview", // preview pattern
      // image / video / moderation
      "chatgpt-image-latest",
      "gpt-image-1-mini",
      "gpt-image-1.5",
      "gpt-image-2",
      "gpt-image-2.5-flare",
      "gpt-image-2.5-sunburst",
      "sora-2",
      "sora-2-pro",
      // voice / full-duplex live (realtime-canary domain, excluded here)
      "gpt-live-1",
      "omni-moderation",
      "omni-moderation-latest",
      // bare chat alias (fixture-vs-live gap: present in live /models, was absent
      // from the static wave — this is the 2026-07-18 canary residual)
      "chat-latest",
      // 2026-10-18 wave (Drift Tests run 39103216353): pre-GA `-alpha` codenames,
      // listed for one run and 404 (`model_not_found`) since — explicit excludes
      "aurora-blue-alpha",
      "aurora-green-alpha",
      "aurora-red-alpha",
    ];
    expect(unclassifiedFamilies(openaiLive, "openai")).toEqual([]);
  });

  it("Anthropic: every live family is classified (zero unclassified)", () => {
    const anthropicLive = [
      // Existing include (dated snapshots collapse)
      "claude-3-opus-20240229",
      "claude-3-5-sonnet-20241022",
      "claude-3-7-sonnet-20250219",
      "claude-opus-4-20250514",
      "claude-sonnet-4",
      "claude-haiku-4",
      // Newly-classified INCLUDE: 4.x/5 point releases + fable
      "claude-haiku-4-5",
      "claude-opus-4-1",
      "claude-opus-4-5",
      "claude-opus-4-6",
      "claude-opus-4-7",
      "claude-opus-4-8",
      "claude-sonnet-4-5",
      "claude-sonnet-4-6",
      "claude-sonnet-5",
      "claude-fable-5",
      // 2026-09-23 wave: Opus 5.5 point release
      "claude-opus-5-5",
      // 2026-09-24..30 wave (first listed 09-29): Sonnet 5.5 point release
      "claude-sonnet-5-5",
      // 2026-10-08 wave: Haiku 5.5 point release
      "claude-haiku-5-5",
    ];
    expect(unclassifiedFamilies(anthropicLive, "anthropic")).toEqual([]);
  });

  it("Gemini: every recorded family is classified (zero unclassified)", () => {
    const geminiLive = [
      // Existing exclude (Gemini 1.5, retired upstream)
      "gemini-1.5-pro",
      "gemini-1.5-flash",
      // Existing include
      "gemini-2.0-flash",
      "gemini-2.5-flash",
      "gemini-2.5-pro",
      // Newly-classified INCLUDE: stable flash/pro tiers
      "gemini-2.0-flash-lite",
      "gemini-2.5-flash-lite",
      "gemini-3.1-flash-lite",
      "gemini-3.5-flash",
      "gemini-3.5-flash-lite",
      "gemini-3.6-flash",
      "gemini-3.7-flash",
      // 2026-10-14 wave (run 38523200980): Gemini 4 Argon, probe-verified text chat
      "gemini-4-argon",
      // Restricted EAP surface — explicit exclude (text-capable, but pre-GA)
      "gemini-3.7-flash-video-understanding-eap",
      // Preview text tiers — auto-excluded by the -preview pattern rule
      "gemini-3-flash-preview",
      "gemini-3-pro-preview",
      "gemini-3.1-pro-preview",
      "gemini-3.1-flash-lite-preview",
      // Preview specialty surfaces (pattern OR explicit)
      "gemini-3.1-pro-preview-customtools", // explicit exclude (not -preview$)
      "antigravity-preview-05", // pattern
      "antigravity-preview-latest", // explicit exclude (-preview-latest alias, not -preview$)
      "aqa", // explicit exclude (retired specialty)
      "deep-research-max-preview-04", // pattern
      "deep-research-preview-04", // pattern
      "deep-research-pro-preview-12", // pattern
      "gemini-2.5-computer-use-preview-10", // pattern
      "gemini-omni-flash-preview", // pattern
      // image / audio / tts / video / music / robotics / embeddings
      "gemini-2.5-flash-image",
      "gemini-2.5-flash-native-audio-latest",
      // 2026-08-26/27 GA line (run 33296393200): speech-to-text pair + the
      // conversational video-generation tier — all explicit excludes
      "gemini-3.5-transcribe",
      "gemini-3.5-transcribe-live",
      "gemini-omni-1.1-flash",
      "gemini-2.5-flash-preview-tts", // explicit exclude (-preview-tts)
      "gemini-2.5-pro-preview-tts", // explicit exclude (-preview-tts)
      "gemini-3-pro-image",
      "gemini-3-pro-image-preview", // pattern
      "gemini-3.1-flash-image",
      "gemini-3.1-flash-image-preview", // pattern
      "gemini-3.1-flash-lite-image",
      "gemini-nano-banana-2.1", // image-generation successor, recorded 2026-10-07
      "gemini-3.1-flash-tts-preview", // pattern
      "gemini-3.8-flash-tts", // explicit exclude (non-preview -tts, 2026-09-24..30 wave)
      "gemini-3.8-flash-lite-tts", // explicit exclude (non-preview -tts, 2026-09-24..30 wave)
      "gemini-embedding",
      "gemini-embedding-2",
      "gemini-embedding-2-preview", // pattern
      "gemini-robotics-er-1.5-preview", // pattern
      "gemini-robotics-er-1.6-preview", // pattern
      "imagen-4.0-fast-generate",
      "imagen-4.0-generate",
      "imagen-4.0-ultra-generate",
      "lyria-3-clip-preview", // pattern
      "lyria-3-pro-preview", // pattern
      "nano-banana-pro-preview", // pattern
      "veo-3.1-fast-generate-preview", // pattern
      "veo-3.1-generate-preview", // pattern
      "veo-3.1-lite-generate-preview", // pattern
      // Gemma open-weight — aimock does NOT mock; auto-excluded by GEMMA_FAMILY rule
      "gemma-4-26b-a4b-it",
      "gemma-4-31b-it",
      // Moving aliases
      "gemini-flash-latest",
      "gemini-flash-lite-latest",
      "gemini-pro-latest",
    ];
    expect(unclassifiedFamilies(geminiLive, "gemini")).toEqual([]);
    expect(excludeFamilies.gemini.has("gemini-nano-banana-2.1")).toBe(true);
    expect(includeFamilies.gemini.has("gemini-nano-banana-2.1")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Chat model-family availability", () => {
  it("live /models contains no unclassified family", async () => {
    await runUnclassifiedFamilyCanary(
      "openai",
      process.env.OPENAI_API_KEY!,
      "OpenAI Chat (live /models family canary)",
    );
  });
});

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.ANTHROPIC_API_KEY)(
  "Anthropic Claude model-family availability",
  () => {
    it("live /models contains no unclassified family", async () => {
      await runUnclassifiedFamilyCanary(
        "anthropic",
        process.env.ANTHROPIC_API_KEY!,
        "Anthropic Claude (live /models family canary)",
      );
    });
  },
);

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.GOOGLE_API_KEY)("Google Gemini model-family availability", () => {
  it("live /models contains no unclassified family", async () => {
    await runUnclassifiedFamilyCanary(
      "gemini",
      process.env.GOOGLE_API_KEY!,
      "Google Gemini (live /models family canary)",
    );
  });
});
