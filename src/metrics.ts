/**
 * Lightweight Prometheus metrics registry for LLMock.
 *
 * Zero external dependencies — implements counters, histograms, and gauges
 * with Prometheus text exposition format serialization.
 */

import {
  AZURE_DEPLOYMENT_RE as AZURE_RE,
  BATCHES_CANCEL_RE,
  BATCHES_ID_RE,
  BYTEPLUS_VIDEO_STATUS_RE,
  BYTEPLUS_VIDEO_SUBMIT_RE,
  ELEVENLABS_TTS_RE,
  ELEVENLABS_VOICE_RE,
  FAL_ROUTE_RE,
  FILES_CONTENT_RE,
  FILES_ID_RE,
  FINE_TUNING_ID_RE,
  GROK_VIDEO_STATUS_RE,
  GROK_VIDEO_SUBMIT_PATH,
  OPENAI_VIDEO_STATUS_RE,
  OPENROUTER_VIDEO_CONTENT_RE,
  OPENROUTER_VIDEO_STATUS_RE,
  VEO_OPERATION_RE,
  VEO_PREDICT_LRO_RE,
} from "./route-registry.js";

// Re-exported so existing importers (route tests) keep resolving these
// against the metrics module. The bindings ARE the registry's — there is
// exactly one pattern object per route family.
export {
  BATCHES_CANCEL_RE,
  BATCHES_ID_RE,
  BYTEPLUS_VIDEO_STATUS_RE,
  BYTEPLUS_VIDEO_SUBMIT_RE,
  FAL_ROUTE_RE,
  FILES_CONTENT_RE,
  FILES_ID_RE,
  GROK_VIDEO_STATUS_RE,
  GROK_VIDEO_SUBMIT_PATH,
  OPENAI_VIDEO_STATUS_RE,
  OPENROUTER_VIDEO_CONTENT_RE,
  OPENROUTER_VIDEO_STATUS_RE,
  VEO_OPERATION_RE,
  VEO_PREDICT_LRO_RE,
};

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface MetricsRegistry {
  incrementCounter(name: string, labels: Record<string, string>): void;
  observeHistogram(name: string, labels: Record<string, string>, value: number): void;
  setGauge(name: string, labels: Record<string, string>, value: number): void;
  serialize(): string;
  reset(): void;
}

// ---------------------------------------------------------------------------
// Histogram bucket boundaries (Prometheus default-ish)
// ---------------------------------------------------------------------------

const HISTOGRAM_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Build a stable label key string for map lookups: `label1="v1",label2="v2"` */
function labelKey(labels: Record<string, string>): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return "";
  return entries.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(",");
}

/** Escape a label value per Prometheus text exposition format. */
function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/** Format labels for Prometheus output: `{label1="v1",label2="v2"}` */
function formatLabels(labels: Record<string, string>): string {
  return `{${labelKey(labels)}}`;
}

// ---------------------------------------------------------------------------
// Internal metric storage types
// ---------------------------------------------------------------------------

interface CounterData {
  type: "counter";
  /** Map from labelKey → value */
  series: Map<string, { labels: Record<string, string>; value: number }>;
}

interface HistogramData {
  type: "histogram";
  /** Map from labelKey → bucket counts, sum, count */
  series: Map<
    string,
    {
      labels: Record<string, string>;
      bucketCounts: number[]; // one per HISTOGRAM_BUCKETS entry
      sum: number;
      count: number;
    }
  >;
}

interface GaugeData {
  type: "gauge";
  /** Map from labelKey → value */
  series: Map<string, { labels: Record<string, string>; value: number }>;
}

type MetricData = CounterData | HistogramData | GaugeData;

// ---------------------------------------------------------------------------
// Registry implementation
// ---------------------------------------------------------------------------

export function createMetricsRegistry(): MetricsRegistry {
  /** Ordered map: metric name → data. Insertion order preserved for stable output. */
  const metrics = new Map<string, MetricData>();

  function getOrCreateCounter(name: string): CounterData {
    let data = metrics.get(name);
    if (!data) {
      data = { type: "counter", series: new Map() };
      metrics.set(name, data);
    }
    if (data.type !== "counter") throw new Error(`Metric ${name} is not a counter`);
    return data as CounterData;
  }

  function getOrCreateHistogram(name: string): HistogramData {
    let data = metrics.get(name);
    if (!data) {
      data = { type: "histogram", series: new Map() };
      metrics.set(name, data);
    }
    if (data.type !== "histogram") throw new Error(`Metric ${name} is not a histogram`);
    return data as HistogramData;
  }

  function getOrCreateGauge(name: string): GaugeData {
    let data = metrics.get(name);
    if (!data) {
      data = { type: "gauge", series: new Map() };
      metrics.set(name, data);
    }
    if (data.type !== "gauge") throw new Error(`Metric ${name} is not a gauge`);
    return data as GaugeData;
  }

  return {
    incrementCounter(name: string, labels: Record<string, string>): void {
      const counter = getOrCreateCounter(name);
      const key = labelKey(labels);
      const existing = counter.series.get(key);
      if (existing) {
        existing.value += 1;
      } else {
        counter.series.set(key, { labels, value: 1 });
      }
    },

    observeHistogram(name: string, labels: Record<string, string>, value: number): void {
      const histogram = getOrCreateHistogram(name);
      const key = labelKey(labels);
      let existing = histogram.series.get(key);
      if (!existing) {
        existing = {
          labels,
          bucketCounts: new Array(HISTOGRAM_BUCKETS.length).fill(0) as number[],
          sum: 0,
          count: 0,
        };
        histogram.series.set(key, existing);
      }
      // Update cumulative bucket counts
      for (let i = 0; i < HISTOGRAM_BUCKETS.length; i++) {
        if (value <= HISTOGRAM_BUCKETS[i]) {
          existing.bucketCounts[i] += 1;
        }
      }
      existing.sum += value;
      existing.count += 1;
    },

    setGauge(name: string, labels: Record<string, string>, value: number): void {
      const gauge = getOrCreateGauge(name);
      const key = labelKey(labels);
      const existing = gauge.series.get(key);
      if (existing) {
        existing.value = value;
      } else {
        gauge.series.set(key, { labels, value });
      }
    },

    serialize(): string {
      const lines: string[] = [];

      for (const [name, data] of metrics) {
        switch (data.type) {
          case "counter": {
            lines.push(`# TYPE ${name} counter`);
            for (const series of data.series.values()) {
              lines.push(`${name}${formatLabels(series.labels)} ${series.value}`);
            }
            break;
          }
          case "histogram": {
            lines.push(`# TYPE ${name} histogram`);
            for (const series of data.series.values()) {
              const lblStr = labelKey(series.labels);
              const lblPrefix = lblStr ? `${lblStr},` : "";
              // Bucket lines
              for (let i = 0; i < HISTOGRAM_BUCKETS.length; i++) {
                lines.push(
                  `${name}_bucket{${lblPrefix}le="${HISTOGRAM_BUCKETS[i]}"} ${series.bucketCounts[i]}`,
                );
              }
              // +Inf bucket
              lines.push(`${name}_bucket{${lblPrefix}le="+Inf"} ${series.count}`);
              // Sum and count
              lines.push(`${name}_sum${formatLabels(series.labels)} ${series.sum}`);
              lines.push(`${name}_count${formatLabels(series.labels)} ${series.count}`);
            }
            break;
          }
          case "gauge": {
            lines.push(`# TYPE ${name} gauge`);
            for (const series of data.series.values()) {
              lines.push(`${name}${formatLabels(series.labels)} ${series.value}`);
            }
            break;
          }
        }
      }

      return lines.length > 0 ? lines.join("\n") + "\n" : "";
    },

    reset(): void {
      metrics.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Path normalization for metric labels
// ---------------------------------------------------------------------------

// Regex patterns for parametric API routes. The dispatch+labeling patterns
// shared with server.ts dispatch and the machine-readable catalog are defined
// in route-registry.ts (single source of truth) and imported above; only
// labeling-specific patterns are declared here: the Bedrock union, the Looser
// Vertex shape, the widened Gemini action bucket (+ its allowlists), and the
// served-or-not namespace cascades below.
const BEDROCK_RE =
  /^\/model\/([^/]+)\/(invoke|invoke-with-response-stream|converse|converse-stream)$/;
const VERTEX_RE =
  /^\/v1\/projects\/([^/]+)\/locations\/([^/]+)\/publishers\/google\/models\/([^:]+):(.+)$/;
// Gemini `/v1beta/models/{model}:{action}`. The action segment is caller
// controlled, so only the actions the server routes stay verbatim; anything
// else collapses to `{action}`. `predictLongRunning` is listed so the Veo
// submit label below stays byte-identical to what it was before this RE
// widened past generate/streamGenerate — the two rules must agree.
const GEMINI_RE = /^\/v1beta\/models\/([^:]+):([^/]+)$/;
const GEMINI_ACTIONS = new Set([
  "generateContent",
  "streamGenerateContent",
  "embedContent",
  "batchEmbedContents",
  "countTokens",
  "predict",
  "predictLongRunning",
]);
const GEMINI_MODEL_RE = /^\/v1beta\/models\/([^:/]+)$/;
// The Vertex `:action` segment is caller controlled exactly as Gemini's is;
// server.ts routes only these two, so anything else collapses to `{action}`.
const VERTEX_ACTIONS = new Set(["generateContent", "streamGenerateContent"]);

/**
 * Closed namespaces beyond fine-tuning. Each prefix below is entered by prefix
 * and always returns, so no id-bearing or unknown-depth path under it can
 * reach the verbatim return at the bottom of `normalizePathLabel`:
 *
 * - fal: `/fal/queue/requests/{id}[/status|/cancel|/stream]` (aimock's own
 *   queue layout), `/fal/{model}/requests/{id}[/…]` (the `x-fal-target-host`
 *   path-mirror of `queue.fal.run`), `/fal/queue/submit/{model}`,
 *   `/fal/run/{model}`. Request ids are minted per submit and model ids are
 *   caller-controlled multi-segment paths, so both collapse.
 * - music: `/v1/music/{generation|variation|remix|extend|plan|detailed|stream}`
 *   are the ElevenLabs routes (`plan`/`stream` take their own response shape
 *   in elevenlabs-audio.ts); the server RE accepts any suffix, so an unknown
 *   one collapses.
 * - files / batches: the id and sub-resource rules above cover the routed
 *   shapes; any other depth collapses to the namespace's `{other}`.
 */
/**
 * The fal.ai route shape (`FAL_ROUTE_RE`, imported from route-registry.ts so
 * the label rule cannot drift from the route rule): a bare `/fal` is routed,
 * so it is labelled here rather than falling through to `{unknown}`.
 */
const FAL_QUEUE_REQUEST_RE = /^\/fal\/queue\/requests\/[^/]+(?:\/([^/]+))?$/;
const FAL_MIRROR_REQUEST_RE = /^\/fal\/.+\/requests\/[^/]+(?:\/([^/]+))?$/;
const FAL_REQUEST_SUBRESOURCES = new Set(["status", "cancel", "stream"]);
const FAL_QUEUE_SUBMIT_RE = /^\/fal\/queue\/submit\/.+$/;
const FAL_RUN_RE = /^\/fal\/run\/.+$/;
const FAL_OTHER_LABEL = "/fal/{other}";
const MUSIC_PREFIX = "/v1/music/";
const MUSIC_ACTIONS = new Set([
  "generation",
  "variation",
  "remix",
  "extend",
  "plan",
  "detailed",
  "stream",
]);
const MUSIC_OTHER_LABEL = "/v1/music/{other}";
const FILES_PREFIX = "/v1/files/";
const FILES_OTHER_LABEL = "/v1/files/{other}";
const BATCHES_PREFIX = "/v1/batches/";
const BATCHES_OTHER_LABEL = "/v1/batches/{other}";

/**
 * Label for a path no route claimed. Metrics are recorded for EVERY response,
 * the generic 404 included, so an unrouted path is caller-controlled text and
 * a fuzzer (or a typo'd SDK base URL) would mint one label per request.
 *
 * The collapse is decided by ROUTE SHAPE, never by status: a 404 is not the
 * only way an unrouted path gets answered (a CORS preflight is 204 for any
 * path, a torn-down response has no status at all), and a routed path can
 * legitimately 404 (a fixture miss, a missing file) without becoming
 * unknown. Every path that is not claimed by a placeholder rule above must
 * therefore be listed here to keep its verbatim label.
 */
export const UNKNOWN_PATH_LABEL = "{unknown}";

/**
 * Static paths server.ts dispatches by exact match (after
 * `normalizeCompatPath`, so the canonical `/v1/...` spelling). A path absent
 * from this table that no placeholder rule claims is labelled `{unknown}`
 * whatever its status — so a new static route needs an entry here or its
 * traffic is counted but not named.
 */
const STATIC_ROUTE_PATHS = new Set([
  "/health",
  "/ready",
  "/metrics",
  "/search",
  "/v1/chat/completions",
  "/v1/responses",
  "/v1/realtime",
  "/v1/messages",
  "/v1/embeddings",
  "/v1/moderations",
  "/v1/models",
  "/v1/_requests",
  "/v1/images/generations",
  "/v1/images/edits",
  "/v1/images/variations",
  "/v1/audio/speech",
  "/v1/audio/transcriptions",
  "/v1/audio/translations",
  "/v1/videos",
  "/v1/batches",
  "/v1/files",
  "/v1/sound-generation",
  "/v1/music",
  "/v1/text-to-voice",
  "/v1/text-to-voice/design",
  "/v1beta/interactions",
  "/v2/chat",
  "/v2/embed",
  "/v2/rerank",
  "/api/chat",
  "/api/generate",
  "/api/embeddings",
  "/api/embed",
  "/api/tags",
  "/api/v1/videos",
  "/api/v1/videos/models",
  "/api/v1/credits",
  "/api/v1/key",
  "/api/v1/models",
  "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent",
]);

/**
 * Control API (`/__aimock/...`): a closed set of sub-paths, matched exactly
 * in `handleControlAPI`; anything else under the prefix collapses.
 */
const CONTROL_PREFIX = "/__aimock/";
const CONTROL_PATHS = new Set([
  "/__aimock/health",
  "/__aimock/journal",
  "/__aimock/fixtures",
  "/__aimock/chaos",
  "/__aimock/reset",
  "/__aimock/reset/journal",
  "/__aimock/reset/fixtures",
  "/__aimock/error",
  "/__aimock/openapi.json",
  "/__aimock/routes",
]);
const CONTROL_OTHER_LABEL = "/__aimock/{other}";

/**
 * Sub-paths a mounted service (`createServer(..., mounts)`) answers below its
 * mount root. The mount roots themselves are runtime configuration, so the
 * caller passes them in; the JSON-RPC handlers (MCP, A2A, AG-UI, vector) take
 * the root only, and A2A additionally serves its agent card.
 */
const MOUNT_SUBPATHS = new Set(["/.well-known/agent-card.json"]);

/**
 * Status label for a response that was destroyed before its body ended: no
 * status line reached the client as a completed response, so no HTTP code
 * describes the outcome truthfully. Distinct from every numeric status so
 * `sum(aimock_requests_total)` equals requests served.
 */
export const DESTROYED_STATUS_LABEL = "destroyed";

/**
 * Fine-tuning routes. Both id families (`ftjob-…` per create, `ftckpt-…` per
 * checkpoint) are minted per resource, so every id-bearing path has to collapse
 * or each job and each checkpoint mints its own label pair.
 *
 * The label hazard is NOT limited to the routes this server implements: metrics
 * are recorded on `res.on("finish")` for EVERY response, the generic 404
 * included, and `openai@4.104.0` calls a good deal more of the namespace than
 * aimock handles. Enumerated from that SDK:
 *
 *   - `resources/fine-tuning/jobs/jobs.js` — `/fine_tuning/jobs`,
 *     `…/jobs/{id}`, `…/jobs/{id}/cancel`, `…/jobs/{id}/pause`,
 *     `…/jobs/{id}/resume`
 *   - `resources/fine-tuning/jobs/checkpoints.js` — `…/jobs/{id}/checkpoints`
 *   - `resources/fine-tuning/checkpoints/permissions.js` —
 *     `…/checkpoints/{ckpt}/permissions` (create/list) and
 *     `…/checkpoints/{ckpt}/permissions/{id}` (delete)
 *   - `resources/fine-tuning/alpha/graders.js` —
 *     `/fine_tuning/alpha/graders/run`, `/fine_tuning/alpha/graders/validate`
 *
 * The grader routes carry no ids, so they need no placeholder — but they DO
 * need naming here, because the namespace cascade below ends in a catch-all
 * and a static route must not be swallowed by it.
 *
 * Every segment after `/v1/fine_tuning/` is caller-controlled, so the rule is:
 * known action names are kept verbatim, ids collapse to `{id}`/`{ckpt}`, and
 * anything else — an unknown action, an unknown depth — collapses to a single
 * bucket. That is what actually keeps the fine-tuning label set finite no
 * matter what is requested; an un-collapsed tail would leave the hole open to
 * a typo or a fuzzer.
 *
 * Not exported: server.ts dispatches fine-tuning jobs from the same
 * route-registry.ts bindings (`FINE_TUNING_JOBS_PATH`, `FINE_TUNING_ID_RE`,
 * `FINE_TUNING_CANCEL_RE`, `FINE_TUNING_EVENTS_RE`).
 */
const FINE_TUNING_PREFIX = "/v1/fine_tuning/";
const FINE_TUNING_STATIC_PATHS = new Set([
  "/v1/fine_tuning/jobs",
  "/v1/fine_tuning/alpha/graders/run",
  "/v1/fine_tuning/alpha/graders/validate",
]);
const FINE_TUNING_SUBRESOURCE_RE = /^\/v1\/fine_tuning\/jobs\/[^/]+\/([^/]+)$/;
const FINE_TUNING_SUBRESOURCES = new Set(["cancel", "events", "pause", "resume", "checkpoints"]);
const FINE_TUNING_PERMISSION_ID_RE = /^\/v1\/fine_tuning\/checkpoints\/[^/]+\/permissions\/[^/]+$/;
const FINE_TUNING_CHECKPOINT_SUBRESOURCE_RE = /^\/v1\/fine_tuning\/checkpoints\/[^/]+\/([^/]+)$/;
const FINE_TUNING_CHECKPOINT_SUBRESOURCES = new Set(["permissions"]);
const FINE_TUNING_CHECKPOINT_ID_RE = /^\/v1\/fine_tuning\/checkpoints\/([^/]+)$/;
const FINE_TUNING_OTHER_LABEL = "/v1/fine_tuning/{other}";

/**
 * Normalize parametric API paths to route patterns for use as metric labels.
 * Replaces dynamic segments (model IDs, deployment names, etc.) with placeholders.
 * `mountPaths` are the roots of the mounted services, so their traffic keeps a
 * bounded label instead of collapsing to `{unknown}`.
 */
export function normalizePathLabel(pathname: string, mountPaths: readonly string[] = []): string {
  // Match server dispatch precedence: controls, mounts in registration order,
  // then provider routes. A mount may overlap any provider namespace.
  // Control API: exact sub-paths verbatim, anything else under the prefix
  // collapses.
  if (pathname.startsWith(CONTROL_PREFIX)) {
    return CONTROL_PATHS.has(pathname) ? pathname : CONTROL_OTHER_LABEL;
  }

  // Mounted services: the root and the known sub-paths verbatim, anything
  // deeper collapses under the mount.
  for (const mountPath of mountPaths) {
    if (pathname === mountPath) return pathname;
    if (pathname.startsWith(mountPath + "/")) {
      return MOUNT_SUBPATHS.has(pathname.slice(mountPath.length))
        ? pathname
        : `${mountPath}/{other}`;
    }
  }

  // Bedrock: /model/{modelId}/{operation}
  const bedrockMatch = pathname.match(BEDROCK_RE);
  if (bedrockMatch) {
    return `/model/{modelId}/${bedrockMatch[2]}`;
  }

  // Gemini: /v1beta/models/{model}:{action}, plus the bare GET model lookup.
  const geminiMatch = pathname.match(GEMINI_RE);
  if (geminiMatch) {
    const action = GEMINI_ACTIONS.has(geminiMatch[2]) ? geminiMatch[2] : "{action}";
    return `/v1beta/models/{model}:${action}`;
  }
  if (GEMINI_MODEL_RE.test(pathname)) {
    return "/v1beta/models/{model}";
  }

  // Azure: /openai/deployments/{id}/{operation}
  const azureMatch = pathname.match(AZURE_RE);
  if (azureMatch) {
    return `/openai/deployments/{id}/${azureMatch[2]}`;
  }

  // Vertex AI: /v1/projects/{p}/locations/{l}/publishers/google/models/{m}:{action}
  const vertexMatch = pathname.match(VERTEX_RE);
  if (vertexMatch) {
    const action = VERTEX_ACTIONS.has(vertexMatch[4]) ? vertexMatch[4] : "{action}";
    return `/v1/projects/{p}/locations/{l}/publishers/google/models/{m}:${action}`;
  }

  // ElevenLabs TTS: /v1/text-to-speech/{voice_id}
  if (ELEVENLABS_TTS_RE.test(pathname)) {
    return "/v1/text-to-speech/{voice_id}";
  }

  // ElevenLabs voices: /v1/voices/{voice_id}
  if (ELEVENLABS_VOICE_RE.test(pathname)) {
    return "/v1/voices/{voice_id}";
  }

  // OpenRouter video: /api/v1/videos/{jobId}[/content] — jobIds are random
  // UUIDs, so raw paths would mint unbounded label cardinality. The static
  // /api/v1/videos/models listing route must not collapse into {jobId}.
  if (OPENROUTER_VIDEO_CONTENT_RE.test(pathname)) {
    return "/api/v1/videos/{jobId}/content";
  }
  if (pathname !== "/api/v1/videos/models" && OPENROUTER_VIDEO_STATUS_RE.test(pathname)) {
    return "/api/v1/videos/{jobId}";
  }

  // Google Veo video: submit `:predictLongRunning` + poll `/v1beta/operations/{name}`.
  // Operation names are random UUIDs, so the raw path would mint unbounded
  // label cardinality.
  if (VEO_PREDICT_LRO_RE.test(pathname)) {
    return "/v1beta/models/{model}:predictLongRunning";
  }
  if (VEO_OPERATION_RE.test(pathname)) {
    return "/v1beta/operations/{name}";
  }

  // xAI Grok Imagine submit is a static literal path — keep it distinct from
  // the `/v1/videos/{id}` status label below (which it would otherwise collapse
  // into), exactly as `/api/v1/videos/models` is kept out of the jobId bucket.
  if (pathname === GROK_VIDEO_SUBMIT_PATH) {
    return GROK_VIDEO_SUBMIT_PATH;
  }

  // OpenAI/Grok video status: /v1/videos/{id}
  if (OPENAI_VIDEO_STATUS_RE.test(pathname)) {
    return "/v1/videos/{id}";
  }

  // BytePlus Ark video: /[api/v3/]contents/generations/tasks[/{id}] — task ids
  // (`cgt-…`) are unbounded cardinality. Status before submit: the status RE is
  // the more specific of the two and the submit RE cannot match a trailing id
  // segment, so the order is belt-and-braces. Appended at the end of the
  // cascade because the anchored REs above cannot match any path an earlier
  // entry claims.
  if (BYTEPLUS_VIDEO_STATUS_RE.test(pathname)) {
    return "/contents/generations/tasks/{id}";
  }
  if (BYTEPLUS_VIDEO_SUBMIT_RE.test(pathname)) {
    return "/contents/generations/tasks";
  }

  if (BATCHES_CANCEL_RE.test(pathname)) {
    return "/v1/batches/{id}/cancel";
  }
  if (pathname !== "/v1/batches" && BATCHES_ID_RE.test(pathname)) {
    return "/v1/batches/{id}";
  }
  if (pathname.startsWith(BATCHES_PREFIX)) {
    return BATCHES_OTHER_LABEL;
  }

  // Files API: /v1/files/{id} and /v1/files/{id}/content carry random
  // `file-…` ids — raw paths would mint unbounded label cardinality.
  // Content before id: the id RE would otherwise swallow the content suffix.
  if (FILES_CONTENT_RE.test(pathname)) {
    return "/v1/files/{id}/content";
  }
  if (pathname !== "/v1/files" && FILES_ID_RE.test(pathname)) {
    return "/v1/files/{id}";
  }
  if (pathname.startsWith(FILES_PREFIX)) {
    return FILES_OTHER_LABEL;
  }

  // fal.ai: see the namespace note above. Queue-request rules read before the
  // path-mirror rule because `/fal/queue/requests/…` also matches the mirror
  // RE's `.+/requests/` shape; both would label correctly, but the specific
  // rule reading first keeps the cascade legible.
  if (FAL_ROUTE_RE.test(pathname)) {
    const queueRequest = pathname.match(FAL_QUEUE_REQUEST_RE);
    if (queueRequest) {
      return `/fal/queue/requests/{id}${falRequestSuffix(queueRequest[1])}`;
    }
    if (FAL_QUEUE_SUBMIT_RE.test(pathname)) return "/fal/queue/submit/{model}";
    if (FAL_RUN_RE.test(pathname)) return "/fal/run/{model}";
    const mirrorRequest = pathname.match(FAL_MIRROR_REQUEST_RE);
    if (mirrorRequest) {
      return `/fal/{model}/requests/{id}${falRequestSuffix(mirrorRequest[1])}`;
    }
    return FAL_OTHER_LABEL;
  }

  // ElevenLabs Music: known actions verbatim, anything else collapses.
  if (pathname.startsWith(MUSIC_PREFIX)) {
    return MUSIC_ACTIONS.has(pathname.slice(MUSIC_PREFIX.length)) ? pathname : MUSIC_OTHER_LABEL;
  }

  // Fine-tuning. Handled as one closed namespace rather than a few loose REs:
  // the cascade is entered by prefix and always returns, so no fine-tuning path
  // can reach the verbatim return at the bottom of this function.
  //
  // Order matters twice. The id-bearing permission rule reads before the
  // checkpoint sub-resource rule, because `…/permissions/{id}` would otherwise
  // never be reached (its own second segment is the id). Within each family the
  // sub-resource rule reads before the id rule; the id REs are anchored to a
  // single trailing segment so the two cannot both match, but the more specific
  // path reading first is what makes the cascade legible.
  if (pathname.startsWith(FINE_TUNING_PREFIX)) {
    if (FINE_TUNING_STATIC_PATHS.has(pathname)) return pathname;

    const ftSubresource = pathname.match(FINE_TUNING_SUBRESOURCE_RE);
    if (ftSubresource) {
      const action = FINE_TUNING_SUBRESOURCES.has(ftSubresource[1]) ? ftSubresource[1] : "{action}";
      return `/v1/fine_tuning/jobs/{id}/${action}`;
    }
    if (FINE_TUNING_ID_RE.test(pathname)) return "/v1/fine_tuning/jobs/{id}";

    if (FINE_TUNING_PERMISSION_ID_RE.test(pathname)) {
      return "/v1/fine_tuning/checkpoints/{ckpt}/permissions/{id}";
    }
    const ckptSubresource = pathname.match(FINE_TUNING_CHECKPOINT_SUBRESOURCE_RE);
    if (ckptSubresource) {
      const action = FINE_TUNING_CHECKPOINT_SUBRESOURCES.has(ckptSubresource[1])
        ? ckptSubresource[1]
        : "{action}";
      return `/v1/fine_tuning/checkpoints/{ckpt}/${action}`;
    }
    if (FINE_TUNING_CHECKPOINT_ID_RE.test(pathname)) {
      return "/v1/fine_tuning/checkpoints/{ckpt}";
    }

    return FINE_TUNING_OTHER_LABEL;
  }

  // Static path — verbatim only if server.ts routes it. Anything else is, as
  // far as metrics can tell, caller-controlled text, whatever status it got
  // (404, a 204 preflight, a destroyed response); every routed id path that
  // can legitimately 404 has already returned its placeholder label above.
  return STATIC_ROUTE_PATHS.has(pathname) ? pathname : UNKNOWN_PATH_LABEL;
}

function falRequestSuffix(sub: string | undefined): string {
  if (sub === undefined) return "";
  return FAL_REQUEST_SUBRESOURCES.has(sub) ? `/${sub}` : "/{other}";
}
