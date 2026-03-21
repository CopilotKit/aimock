/**
 * Lightweight Prometheus metrics registry for LLMock.
 *
 * Zero external dependencies — implements counters, histograms, and gauges
 * with Prometheus text exposition format serialization.
 */

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

// Regex patterns for parametric API routes
const BEDROCK_RE =
  /^\/model\/([^/]+)\/(invoke|invoke-with-response-stream|converse|converse-stream)$/;
const GEMINI_RE = /^\/v1beta\/models\/([^:]+):(generateContent|streamGenerateContent)$/;
const AZURE_RE = /^\/openai\/deployments\/([^/]+)\/(chat\/completions|embeddings)$/;
const VERTEX_RE =
  /^\/v1\/projects\/([^/]+)\/locations\/([^/]+)\/publishers\/google\/models\/([^:]+):(.+)$/;

/**
 * Normalize parametric API paths to route patterns for use as metric labels.
 * Replaces dynamic segments (model IDs, deployment names, etc.) with placeholders.
 */
export function normalizePathLabel(pathname: string): string {
  // Bedrock: /model/{modelId}/{operation}
  const bedrockMatch = pathname.match(BEDROCK_RE);
  if (bedrockMatch) {
    return `/model/{modelId}/${bedrockMatch[2]}`;
  }

  // Gemini: /v1beta/models/{model}:{action}
  const geminiMatch = pathname.match(GEMINI_RE);
  if (geminiMatch) {
    return `/v1beta/models/{model}:${geminiMatch[2]}`;
  }

  // Azure: /openai/deployments/{id}/{operation}
  const azureMatch = pathname.match(AZURE_RE);
  if (azureMatch) {
    return `/openai/deployments/{id}/${azureMatch[2]}`;
  }

  // Vertex AI: /v1/projects/{p}/locations/{l}/publishers/google/models/{m}:{action}
  const vertexMatch = pathname.match(VERTEX_RE);
  if (vertexMatch) {
    return `/v1/projects/{p}/locations/{l}/publishers/google/models/{m}:${vertexMatch[4]}`;
  }

  // Static path — return as-is
  return pathname;
}
