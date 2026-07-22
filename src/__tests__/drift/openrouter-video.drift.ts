/**
 * OpenRouter video-proxy drift tests (surface: `openrouter-video`).
 *
 * The OpenRouter async video lifecycle proxy (`src/openrouter-video.ts`,
 * `video-proxy-shared.ts`) is SHIPPED on master but had ZERO drift coverage.
 * This leg closes that gap COST-SAFELY — video generation costs real money per
 * job, so NOTHING here submits a paid generation:
 *
 *   1. LIVE canary (FREE) — authenticate with `OPENROUTER_API_KEY` and hit the
 *      public video-models LISTING endpoint (`GET /api/v1/videos/models`),
 *      asserting the video-model FAMILIES aimock's proxy mirrors are still
 *      present. Metadata-only; no generation. Gated on the key (skips in CI
 *      until `OPENROUTER_API_KEY` is mirrored to repo secrets).
 *
 *   2. Envelope shapes (STATIC, no key, no live generation) — drive the aimock
 *      server over HTTP and triangulate the job-lifecycle envelope shapes the
 *      proxy emits (submit response, completed status poll, models listing)
 *      against hand-authored conformant exemplars via the documented static
 *      `triangulate(sdkShape, sdkShape, mockShape)` form. This exercises the
 *      REAL handler + triangulate + collector routing path, not a unit fake.
 *
 * The models listing shape asserts the shape the mock is CONTRACTED to emit
 * (mock-vs-exemplar, mirroring video.drift.ts) — the live canary above is what
 * catches provider-side model drift.
 */

import http from "node:http";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type ServerInstance } from "../../server.js";
import type { Fixture } from "../../types.js";
import { extractShape, triangulate, formatDriftReport } from "./schema.js";
import { httpPost } from "./helpers.js";
import { listOpenRouterVideoModels } from "./providers.js";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// ---------------------------------------------------------------------------
// HTTP GET helper (drift helpers.ts only exports httpPost — mirror video.drift.ts)
// ---------------------------------------------------------------------------

async function httpGet(
  url: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode!,
          headers: res.headers,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Fixtures — a completed OpenRouter video job. `endpoint: "video"` +
// `model` scopes the match to the submit's synthetic request. Default
// progression (0/0) seeds the job terminal at submit, so the first status
// poll reports "completed" without a paid generation ever happening.
// ---------------------------------------------------------------------------

const OPENROUTER_VIDEO_MODEL = "bytedance/seedance-2.0";

const VIDEO_COMPLETED_FIXTURE: Fixture = {
  match: {
    userMessage: "a serene beach at sunset",
    endpoint: "video",
    model: OPENROUTER_VIDEO_MODEL,
  },
  response: {
    // "AAAA" is valid base64 (decodes to 3 bytes) — the content endpoint is
    // not exercised here; the bytes just have to be a well-formed payload.
    video: { id: "vid_or_completed", status: "completed", b64: "AAAA", cost: 0.12 },
  },
};

// ---------------------------------------------------------------------------
// Expected envelope shapes (hand-authored conformant exemplars — mirrors the
// sdk-shapes.ts "minimal conformant instance" philosophy). These describe the
// shape openrouter-video.ts is CONTRACTED to emit on each lifecycle step.
// ---------------------------------------------------------------------------

/** POST /api/v1/videos submit response: `{ id, polling_url, status }`. */
function submitEnvelopeShape() {
  return extractShape({
    id: "vid_or_completed",
    polling_url: "http://localhost/api/v1/videos/vid_or_completed",
    status: "pending",
  });
}

/**
 * GET /api/v1/videos/{jobId} completed status:
 * `{ id, status, unsigned_urls: string[], usage: { cost } }`.
 */
function completedStatusShape() {
  return extractShape({
    id: "vid_or_completed",
    status: "completed",
    unsigned_urls: ["http://localhost/api/v1/videos/vid_or_completed/content?index=0"],
    usage: { cost: 0.12 },
  });
}

/**
 * GET /api/v1/videos/models per-model entry shape (the mock's synthesized
 * `modelEntry` — see handleOpenRouterVideoModels). Wrapped in `{ data: [...] }`.
 */
function modelsListingShape() {
  return extractShape({
    data: [
      {
        id: OPENROUTER_VIDEO_MODEL,
        name: OPENROUTER_VIDEO_MODEL,
        supported_durations: [4, 8],
        supported_resolutions: ["720p", "1080p"],
        supported_aspect_ratios: ["16:9", "9:16", "1:1"],
        supported_frame_images: [],
        supported_sizes: [],
        generate_audio: false,
        seed: true,
        pricing_skus: [],
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let instance: ServerInstance;

beforeAll(async () => {
  instance = await createServer([VIDEO_COMPLETED_FIXTURE], { port: 0 });
});

afterAll(async () => {
  await new Promise<void>((r) => instance.server.close(() => r()));
});

// ---------------------------------------------------------------------------
// Envelope-shape drift (STATIC — no key, runs in CI)
// ---------------------------------------------------------------------------

describe("OpenRouter video-proxy envelope shapes", () => {
  it("submit returns { id, polling_url, status }", async () => {
    const res = await httpPost(`${instance.url}/api/v1/videos`, {
      model: OPENROUTER_VIDEO_MODEL,
      prompt: "a serene beach at sunset",
    });

    expect(res.status, res.body).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.id).toBeDefined();
    expect(body.status).toBe("pending");
    expect(typeof body.polling_url).toBe("string");

    const sdkShape = submitEnvelopeShape();
    const mockShape = extractShape(body);
    const diffs = triangulate(sdkShape, sdkShape, mockShape);
    const report = formatDriftReport("OpenRouter video submit", diffs, "openrouter-video");

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("completed status poll returns { id, status, unsigned_urls, usage }", async () => {
    // Submit, then poll the returned polling_url. Default 0/0 progression seeds
    // the job terminal at submit, so the first poll is already "completed".
    const submitRes = await httpPost(`${instance.url}/api/v1/videos`, {
      model: OPENROUTER_VIDEO_MODEL,
      prompt: "a serene beach at sunset",
    });
    expect(submitRes.status, submitRes.body).toBe(200);
    const { polling_url } = JSON.parse(submitRes.body);

    const poll = await httpGet(polling_url);
    expect(poll.status, poll.body).toBe(200);
    const body = JSON.parse(poll.body);
    expect(body.status).toBe("completed");
    expect(Array.isArray(body.unsigned_urls)).toBe(true);
    expect(body.unsigned_urls.length).toBeGreaterThan(0);

    const sdkShape = completedStatusShape();
    const mockShape = extractShape(body);
    const diffs = triangulate(sdkShape, sdkShape, mockShape);
    const report = formatDriftReport(
      "OpenRouter video completed status",
      diffs,
      "openrouter-video",
    );

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("models listing returns { data: [ { id, name, supported_* , ... } ] }", async () => {
    const res = await httpGet(`${instance.url}/api/v1/videos/models`);

    expect(res.status, res.body).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);

    const sdkShape = modelsListingShape();
    const mockShape = extractShape(body);
    const diffs = triangulate(sdkShape, sdkShape, mockShape);
    const report = formatDriftReport("OpenRouter video models listing", diffs, "openrouter-video");

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// LIVE models-listing canary (FREE — metadata only, NO generation).
// Gated on OPENROUTER_API_KEY: skips in CI until the secret is mirrored.
// ---------------------------------------------------------------------------

/**
 * Reduce an OpenRouter video-model slug to its FAMILY key: drop the provider
 * prefix (`bytedance/seedance-2.0` → `seedance-2.0`) then take the leading
 * alpha token before the version (`seedance-2.0` → `seedance`, `sora-2` →
 * `sora`, `veo-3.1` → `veo`). Comparing normalized families (not raw dated
 * slugs) is what keeps the canary from false-positiving on every new version.
 */
export function openRouterVideoFamily(id: string): string {
  const afterProvider = id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
  const leading = afterProvider.match(/^[a-zA-Z]+/);
  return (leading ? leading[0] : afterProvider).toLowerCase();
}

// The families aimock's OpenRouter video proxy hardcodes as its default set
// (DEFAULT_OPENROUTER_VIDEO_MODELS = ["bytedance/seedance-2.0", "openai/sora-2"]
// in src/openrouter-video.ts) — the ground truth of "what the proxy mirrors".
// A missing family means aimock is mirroring a model the provider retired (or
// the endpoint contract moved), which is exactly the drift signal.
const REQUIRED_VIDEO_FAMILIES = ["seedance", "sora"] as const;

describe.skipIf(!OPENROUTER_API_KEY)("OpenRouter video model-family availability (live)", () => {
  it("live /api/v1/videos/models contains the families aimock mirrors", async () => {
    const ids = await listOpenRouterVideoModels(OPENROUTER_API_KEY!);
    expect(ids.length, "OpenRouter returned an empty video-model listing").toBeGreaterThan(0);

    const families = new Set(ids.map(openRouterVideoFamily));
    const missing = REQUIRED_VIDEO_FAMILIES.filter((f) => !families.has(f));

    const report =
      missing.length > 0
        ? formatDriftReport(
            "OpenRouter video (live /api/v1/videos/models family canary)",
            missing.map((family) => ({
              path: `videos/models/${family}`,
              severity: "critical" as const,
              issue:
                `aimock's OpenRouter video proxy mirrors the "${family}" family, but the live ` +
                `/api/v1/videos/models listing no longer contains it — update ` +
                `DEFAULT_OPENROUTER_VIDEO_MODELS in src/openrouter-video.ts`,
              expected: `(family "${family}" present in live listing)`,
              real: [...families].sort().join(", "),
              mock: family,
            })),
            "openrouter-video",
          )
        : "No drift detected: OpenRouter video family canary";

    expect(missing, report).toEqual([]);
  });
});
