import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import http from "node:http";
import * as metricsModule from "../metrics.js";
import { createMetricsRegistry, normalizePathLabel, type MetricsRegistry } from "../metrics.js";
import { createServer, type ServerInstance } from "../server.js";
import type { Fixture, ChatCompletionRequest } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function httpPost(
  url: string,
  body: object,
  headers?: Record<string, string>,
): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
            headers: Object.fromEntries(
              Object.entries(res.headers).map(([k, v]) => [
                k,
                Array.isArray(v) ? v.join(", ") : (v ?? ""),
              ]),
            ),
          }),
        );
      },
    );
    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

async function httpGet(
  url: string,
): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode!,
          body: Buffer.concat(chunks).toString(),
          headers: Object.fromEntries(
            Object.entries(res.headers).map(([k, v]) => [
              k,
              Array.isArray(v) ? v.join(", ") : (v ?? ""),
            ]),
          ),
        }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

function chatRequest(userContent: string): ChatCompletionRequest {
  return {
    model: "gpt-4",
    messages: [{ role: "user", content: userContent }],
  };
}

// ---------------------------------------------------------------------------
// Unit tests: MetricsRegistry
// ---------------------------------------------------------------------------

describe("MetricsRegistry", () => {
  let registry: MetricsRegistry;

  beforeEach(() => {
    registry = createMetricsRegistry();
  });

  describe("Counter", () => {
    it("increments and serializes correct value", () => {
      registry.incrementCounter("http_requests_total", { method: "POST" });
      registry.incrementCounter("http_requests_total", { method: "POST" });
      registry.incrementCounter("http_requests_total", { method: "POST" });
      const output = registry.serialize();
      expect(output).toContain('http_requests_total{method="POST"} 3');
    });

    it("tracks different label combos separately", () => {
      registry.incrementCounter("http_requests_total", { method: "POST", path: "/a" });
      registry.incrementCounter("http_requests_total", { method: "POST", path: "/a" });
      registry.incrementCounter("http_requests_total", { method: "GET", path: "/b" });
      const output = registry.serialize();
      expect(output).toContain('http_requests_total{method="POST",path="/a"} 2');
      expect(output).toContain('http_requests_total{method="GET",path="/b"} 1');
    });
  });

  describe("Histogram", () => {
    it("observes values with cumulative buckets, +Inf = count", () => {
      // Observe values: 0.003, 0.05, 1.5
      registry.observeHistogram("request_duration_seconds", {}, 0.003);
      registry.observeHistogram("request_duration_seconds", {}, 0.05);
      registry.observeHistogram("request_duration_seconds", {}, 1.5);
      const output = registry.serialize();

      // Bucket 0.005: 1 observation (0.003)
      expect(output).toContain('request_duration_seconds_bucket{le="0.005"} 1');
      // Bucket 0.01: 1 observation (cumulative, still just 0.003)
      expect(output).toContain('request_duration_seconds_bucket{le="0.01"} 1');
      // Bucket 0.05: 2 observations (0.003, 0.05)
      expect(output).toContain('request_duration_seconds_bucket{le="0.05"} 2');
      // Bucket 0.1: 2 observations
      expect(output).toContain('request_duration_seconds_bucket{le="0.1"} 2');
      // Bucket 2.5: 3 observations (all)
      expect(output).toContain('request_duration_seconds_bucket{le="2.5"} 3');
      // +Inf = count = 3
      expect(output).toContain('request_duration_seconds_bucket{le="+Inf"} 3');
    });

    it("has correct _sum and _count suffixes", () => {
      registry.observeHistogram("request_duration_seconds", {}, 0.5);
      registry.observeHistogram("request_duration_seconds", {}, 1.5);
      const output = registry.serialize();
      expect(output).toContain("request_duration_seconds_sum{} 2");
      expect(output).toContain("request_duration_seconds_count{} 2");
    });

    it("tracks labels separately in histograms", () => {
      registry.observeHistogram("req_dur", { method: "POST" }, 0.01);
      registry.observeHistogram("req_dur", { method: "GET" }, 5.0);
      const output = registry.serialize();
      // POST: bucket le=0.01 should have 1
      expect(output).toContain('req_dur_bucket{method="POST",le="0.01"} 1');
      // POST: +Inf should have 1
      expect(output).toContain('req_dur_bucket{method="POST",le="+Inf"} 1');
      // GET: bucket le=0.01 should have 0
      expect(output).toContain('req_dur_bucket{method="GET",le="0.01"} 0');
      // GET: bucket le=5 should have 1
      expect(output).toContain('req_dur_bucket{method="GET",le="5"} 1');
      // GET: +Inf should have 1
      expect(output).toContain('req_dur_bucket{method="GET",le="+Inf"} 1');
    });
  });

  describe("Histogram edge: value > all buckets", () => {
    it("28. only +Inf increments when value exceeds all bucket bounds", () => {
      registry.observeHistogram("big_value_hist", {}, 100);
      const output = registry.serialize();

      // All finite buckets should have 0
      for (const b of [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]) {
        expect(output).toContain(`big_value_hist_bucket{le="${b}"} 0`);
      }
      // Only +Inf should have 1
      expect(output).toContain('big_value_hist_bucket{le="+Inf"} 1');
      expect(output).toContain("big_value_hist_count{} 1");
      expect(output).toContain("big_value_hist_sum{} 100");
    });
  });

  describe("Empty registry serialization", () => {
    it("29. returns empty string from fresh registry", () => {
      const freshRegistry = createMetricsRegistry();
      expect(freshRegistry.serialize()).toBe("");
    });
  });

  describe("Type mismatch errors", () => {
    it("throws when observing histogram on a counter name", () => {
      registry.incrementCounter("foo", {});
      expect(() => registry.observeHistogram("foo", {}, 0.5)).toThrow(
        "Metric foo is not a histogram",
      );
    });

    it("throws when incrementing counter on a histogram name", () => {
      registry.observeHistogram("bar", {}, 0.5);
      expect(() => registry.incrementCounter("bar", {})).toThrow("Metric bar is not a counter");
    });
  });

  describe("Gauge type mismatch errors", () => {
    it("throws when incrementing counter on a gauge name", () => {
      registry.setGauge("x", {}, 1);
      expect(() => registry.incrementCounter("x", {})).toThrow("Metric x is not a counter");
    });

    it("throws when observing histogram on a gauge name", () => {
      registry.setGauge("y", {}, 1);
      expect(() => registry.observeHistogram("y", {}, 0.5)).toThrow("Metric y is not a histogram");
    });

    it("throws when setting gauge on a counter name", () => {
      registry.incrementCounter("z", {});
      expect(() => registry.setGauge("z", {}, 1)).toThrow("Metric z is not a gauge");
    });
  });

  describe("Histogram value exactly 0", () => {
    it("observe 0, verify it lands in 0.005 bucket", () => {
      registry.observeHistogram("zero_hist", {}, 0);
      const output = registry.serialize();
      // 0 <= 0.005, so the 0.005 bucket should have 1
      expect(output).toContain('zero_hist_bucket{le="0.005"} 1');
      expect(output).toContain('zero_hist_bucket{le="+Inf"} 1');
      expect(output).toContain("zero_hist_sum{} 0");
      expect(output).toContain("zero_hist_count{} 1");
    });
  });

  describe("Histogram negative value", () => {
    it("observe -1, verify it lands in ALL finite buckets (cumulative), +Inf/count/sum correct", () => {
      registry.observeHistogram("neg_hist", {}, -1);
      const output = registry.serialize();
      // -1 <= every positive bucket boundary, so all finite buckets should have 1
      for (const b of [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]) {
        expect(output).toContain(`neg_hist_bucket{le="${b}"} 1`);
      }
      expect(output).toContain('neg_hist_bucket{le="+Inf"} 1');
      expect(output).toContain("neg_hist_count{} 1");
      expect(output).toContain("neg_hist_sum{} -1");
    });
  });

  describe("Counter with empty labels serialization format", () => {
    it("serializes counter with empty labels as name{} value", () => {
      registry.incrementCounter("empty_label_counter", {});
      const output = registry.serialize();
      expect(output).toContain("empty_label_counter{} 1");
    });
  });

  describe("Label value escaping", () => {
    it("escapes backslash, double-quote, and newline in label values", () => {
      registry.incrementCounter("escaped_metric", { val: 'back\\slash "quoted" new\nline' });
      const output = registry.serialize();
      expect(output).toContain('val="back\\\\slash \\"quoted\\" new\\nline"');
    });
  });

  describe("Label sort order stability", () => {
    it("maps {b:2,a:1} and {a:1,b:2} to the same series", () => {
      registry.incrementCounter("sorted_counter", { b: "2", a: "1" });
      registry.incrementCounter("sorted_counter", { a: "1", b: "2" });
      const output = registry.serialize();
      // Should be one series with value 2, not two series with value 1
      expect(output).toContain('sorted_counter{a="1",b="2"} 2');
      // Should not contain a separate series with value 1
      expect(output).not.toMatch(/sorted_counter\{[^}]*\} 1/);
    });
  });

  describe("Gauge", () => {
    it("sets and updates value", () => {
      registry.setGauge("fixtures_loaded", {}, 5);
      let output = registry.serialize();
      expect(output).toContain("fixtures_loaded{} 5");

      registry.setGauge("fixtures_loaded", {}, 10);
      output = registry.serialize();
      expect(output).toContain("fixtures_loaded{} 10");
      // Old value should not be present
      expect(output).not.toMatch(/fixtures_loaded\{\} 5/);
    });
  });

  describe("serialize()", () => {
    it("produces valid Prometheus text exposition format", () => {
      registry.incrementCounter("my_counter", { env: "test" });
      registry.setGauge("my_gauge", {}, 42);
      const output = registry.serialize();

      // Should contain TYPE lines
      expect(output).toMatch(/^# TYPE my_counter counter$/m);
      expect(output).toMatch(/^# TYPE my_gauge gauge$/m);
      // Metric lines
      expect(output).toContain('my_counter{env="test"} 1');
      expect(output).toContain("my_gauge{} 42");
    });
  });

  describe("reset()", () => {
    it("clears all metrics", () => {
      registry.incrementCounter("c", {});
      registry.observeHistogram("h", {}, 0.5);
      registry.setGauge("g", {}, 1);
      registry.reset();
      const output = registry.serialize();
      expect(output).toBe("");
    });
  });

  describe("histogram→gauge type mismatch", () => {
    it("throws when setting gauge on a histogram name", () => {
      registry.observeHistogram("x", {}, 0.5);
      expect(() => registry.setGauge("x", {}, 1)).toThrow("Metric x is not a gauge");
    });
  });

  describe("Gauge with non-empty labels", () => {
    it("serializes gauge with labels correctly", () => {
      registry.setGauge("g", { region: "us" }, 42);
      const output = registry.serialize();
      expect(output).toContain('g{region="us"} 42');
    });
  });

  describe("Gauge multi-series", () => {
    it("tracks multiple label combos independently", () => {
      registry.setGauge("g", { region: "us" }, 10);
      registry.setGauge("g", { region: "eu" }, 20);
      const output = registry.serialize();
      expect(output).toContain('g{region="us"} 10');
      expect(output).toContain('g{region="eu"} 20');
    });
  });

  describe("reset then re-accumulate", () => {
    it("counter restarts from zero after reset", () => {
      registry.incrementCounter("c", {});
      registry.reset();
      registry.incrementCounter("c", {});
      const output = registry.serialize();
      expect(output).toContain("c{} 1");
      expect(output).not.toMatch(/c\{\} 2/);
    });
  });
});

// ---------------------------------------------------------------------------
// Unit tests: normalizePathLabel
// ---------------------------------------------------------------------------

describe("normalizePathLabel", () => {
  it("normalizes Bedrock invoke path", () => {
    expect(normalizePathLabel("/model/anthropic.claude-3-haiku/invoke")).toBe(
      "/model/{modelId}/invoke",
    );
  });

  it("normalizes Bedrock invoke-with-response-stream", () => {
    expect(normalizePathLabel("/model/anthropic.claude-3-haiku/invoke-with-response-stream")).toBe(
      "/model/{modelId}/invoke-with-response-stream",
    );
  });

  it("normalizes Bedrock converse", () => {
    expect(normalizePathLabel("/model/anthropic.claude-3-haiku/converse")).toBe(
      "/model/{modelId}/converse",
    );
  });

  it("normalizes Bedrock converse-stream", () => {
    expect(normalizePathLabel("/model/anthropic.claude-3-haiku/converse-stream")).toBe(
      "/model/{modelId}/converse-stream",
    );
  });

  it("normalizes Gemini generateContent path", () => {
    expect(normalizePathLabel("/v1beta/models/gemini-2.0-flash:generateContent")).toBe(
      "/v1beta/models/{model}:generateContent",
    );
  });

  it("normalizes Gemini streamGenerateContent path", () => {
    expect(normalizePathLabel("/v1beta/models/gemini-2.0-flash:streamGenerateContent")).toBe(
      "/v1beta/models/{model}:streamGenerateContent",
    );
  });

  it("normalizes Azure deployment path", () => {
    expect(normalizePathLabel("/openai/deployments/my-gpt4/chat/completions")).toBe(
      "/openai/deployments/{id}/chat/completions",
    );
  });

  it("normalizes Azure deployment embeddings path", () => {
    expect(normalizePathLabel("/openai/deployments/my-gpt4/embeddings")).toBe(
      "/openai/deployments/{id}/embeddings",
    );
  });

  it("normalizes Vertex AI path", () => {
    expect(
      normalizePathLabel(
        "/v1/projects/my-proj/locations/us-central1/publishers/google/models/gemini:generateContent",
      ),
    ).toBe("/v1/projects/{p}/locations/{l}/publishers/google/models/{m}:generateContent");
  });

  it("leaves static /api/chat unchanged", () => {
    expect(normalizePathLabel("/api/chat")).toBe("/api/chat");
  });

  it("leaves static /v1/chat/completions unchanged", () => {
    expect(normalizePathLabel("/v1/chat/completions")).toBe("/v1/chat/completions");
  });

  it("leaves static /v1/messages unchanged", () => {
    expect(normalizePathLabel("/v1/messages")).toBe("/v1/messages");
  });

  it("leaves static /v1/embeddings unchanged", () => {
    expect(normalizePathLabel("/v1/embeddings")).toBe("/v1/embeddings");
  });

  it("partial match: /model/foo/unknown-op returns as-is", () => {
    expect(normalizePathLabel("/model/foo/unknown-op")).toBe("/model/foo/unknown-op");
  });

  it("empty string returns empty string", () => {
    expect(normalizePathLabel("")).toBe("");
  });

  it("normalizes Vertex AI streamGenerateContent path", () => {
    expect(
      normalizePathLabel(
        "/v1/projects/my-proj/locations/us-central1/publishers/google/models/gemini:streamGenerateContent",
      ),
    ).toBe("/v1/projects/{p}/locations/{l}/publishers/google/models/{m}:streamGenerateContent");
  });
});

describe("MetricsRegistry: all three types serialized together", () => {
  it("counter + histogram + gauge all appear in serialize output", () => {
    const reg = createMetricsRegistry();
    reg.incrementCounter("c_total", { env: "test" });
    reg.observeHistogram("h_seconds", { op: "read" }, 0.05);
    reg.setGauge("g_loaded", {}, 7);

    const output = reg.serialize();
    expect(output).toContain("# TYPE c_total counter");
    expect(output).toContain('c_total{env="test"} 1');
    expect(output).toContain("# TYPE h_seconds histogram");
    expect(output).toContain('h_seconds_bucket{op="read",le="0.05"} 1');
    expect(output).toContain("# TYPE g_loaded gauge");
    expect(output).toContain("g_loaded{} 7");
  });
});

describe("MetricsRegistry: status label in counter output", () => {
  it("status label appears correctly in serialized counter", () => {
    const reg = createMetricsRegistry();
    reg.incrementCounter("aimock_requests_total", { status: "200", path: "/v1/chat/completions" });
    reg.incrementCounter("aimock_requests_total", { status: "200", path: "/v1/chat/completions" });
    reg.incrementCounter("aimock_requests_total", { status: "404", path: "/v1/chat/completions" });

    const output = reg.serialize();
    expect(output).toContain('aimock_requests_total{path="/v1/chat/completions",status="200"} 2');
    expect(output).toContain('aimock_requests_total{path="/v1/chat/completions",status="404"} 1');
  });
});

// ---------------------------------------------------------------------------
// Integration tests: /metrics endpoint through the server
// ---------------------------------------------------------------------------

let instance: ServerInstance | null = null;

afterEach(async () => {
  if (instance) {
    await new Promise<void>((resolve) => instance!.server.close(() => resolve()));
    instance = null;
  }
});

describe("integration: /metrics endpoint", () => {
  it("returns 404 when metrics disabled (default)", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: { content: "hi" },
      },
    ];
    instance = await createServer(fixtures);
    const res = await httpGet(`${instance.url}/metrics`);
    expect(res.status).toBe(404);
  });

  it("returns 200 with correct content-type when metrics enabled", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: { content: "hi" },
      },
    ];
    instance = await createServer(fixtures, { metrics: true });
    const res = await httpGet(`${instance.url}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/plain; version=0.0.4; charset=utf-8");
  });

  it("increments counters after sending requests", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: { content: "hi" },
      },
    ];
    instance = await createServer(fixtures, { metrics: true });

    // Send two requests
    await httpPost(`${instance.url}/v1/chat/completions`, chatRequest("hello"));
    await httpPost(`${instance.url}/v1/chat/completions`, chatRequest("hello"));

    const res = await httpGet(`${instance.url}/metrics`);
    expect(res.body).toContain("aimock_requests_total");
    // Should have count of 2 for the completions path
    expect(res.body).toMatch(/aimock_requests_total\{[^}]*path="\/v1\/chat\/completions"[^}]*\} 2/);
  });

  it("records histogram bucket distribution after a request", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: { content: "hi" },
      },
    ];
    instance = await createServer(fixtures, { metrics: true });

    await httpPost(`${instance.url}/v1/chat/completions`, chatRequest("hello"));

    const res = await httpGet(`${instance.url}/metrics`);
    // Should have histogram buckets
    expect(res.body).toContain("aimock_request_duration_seconds_bucket");
    expect(res.body).toContain("aimock_request_duration_seconds_count");
    expect(res.body).toContain("aimock_request_duration_seconds_sum");
    // +Inf bucket should equal count
    const infMatch = res.body.match(
      /aimock_request_duration_seconds_bucket\{[^}]*le="\+Inf"\} (\d+)/,
    );
    const countMatch = res.body.match(/aimock_request_duration_seconds_count\{[^}]*\} (\d+)/);
    expect(infMatch).not.toBeNull();
    expect(countMatch).not.toBeNull();
    expect(infMatch![1]).toBe(countMatch![1]);
  });

  it("increments chaos counter when chaos triggers", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: { content: "hi" },
      },
    ];
    instance = await createServer(fixtures, {
      metrics: true,
      chaos: { dropRate: 1.0 }, // 100% drop
    });

    await httpPost(`${instance.url}/v1/chat/completions`, chatRequest("hello"));

    const res = await httpGet(`${instance.url}/metrics`);
    expect(res.body).toContain("aimock_chaos_triggered_total");
    expect(res.body).toMatch(/aimock_chaos_triggered_total\{[^}]*action="drop"[^}]*\} 1/);
  });

  it("increments chaos counter on Anthropic /v1/messages endpoint", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: { content: "hi from claude" },
      },
    ];
    instance = await createServer(fixtures, {
      metrics: true,
      chaos: { dropRate: 1.0 },
    });

    await httpPost(`${instance.url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hello" }],
    });

    const res = await httpGet(`${instance.url}/metrics`);
    expect(res.body).toContain("aimock_chaos_triggered_total");
    expect(res.body).toMatch(/aimock_chaos_triggered_total\{[^}]*action="drop"[^}]*\} 1/);
  });

  it("tracks fixtures loaded gauge", async () => {
    const fixtures: Fixture[] = [
      { match: { userMessage: "a" }, response: { content: "1" } },
      { match: { userMessage: "b" }, response: { content: "2" } },
    ];
    instance = await createServer(fixtures, { metrics: true });
    const res = await httpGet(`${instance.url}/metrics`);
    expect(res.body).toContain("aimock_fixtures_loaded{} 2");
  });

  it("metrics endpoint remains responsive after normal requests", async () => {
    // Baseline: verify normal request flow with metrics enabled continues to succeed.
    // The res.on("finish") callback is wrapped in try-catch so that any exception
    // thrown by registry operations is swallowed rather than propagated as an unhandled
    // EventEmitter error that would crash the process.
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: { content: "hi" },
      },
    ];
    instance = await createServer(fixtures, { metrics: true });

    const res = await httpPost(`${instance.url}/v1/chat/completions`, chatRequest("hello"));
    expect(res.status).toBe(200);

    // Server remains reachable and metrics endpoint still responds after the request
    const metricsRes = await httpGet(`${instance.url}/metrics`);
    expect(metricsRes.status).toBe(200);
    expect(metricsRes.body).toContain("aimock_requests_total");
  });

  it("continues serving requests when metrics registry throws (try-catch guards EventEmitter crash)", async () => {
    // Exercise the catch path in the res.on("finish") callback by making the registry's
    // incrementCounter throw on the second call. The server must still respond 200 to the
    // second request — the exception must be swallowed, not propagated.
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: { content: "hi" },
      },
    ];

    // Spy on createMetricsRegistry so we can inject a faulty registry.
    const realRegistry = createMetricsRegistry();
    let callCount = 0;
    const faultyRegistry: MetricsRegistry = {
      ...realRegistry,
      incrementCounter(name, labels) {
        callCount += 1;
        if (callCount >= 2) {
          throw new Error("simulated registry failure");
        }
        realRegistry.incrementCounter(name, labels);
      },
    };

    const spy = vi
      .spyOn(metricsModule, "createMetricsRegistry")
      .mockReturnValueOnce(faultyRegistry);

    instance = await createServer(fixtures, { metrics: true });
    spy.mockRestore();

    // First request: metrics work normally (callCount becomes 1, no throw)
    const res1 = await httpPost(`${instance.url}/v1/chat/completions`, chatRequest("hello"));
    expect(res1.status).toBe(200);

    // Second request: incrementCounter throws (callCount becomes 2+). The server must
    // still return 200 — proof that the catch block in res.on("finish") swallows the error.
    const res2 = await httpPost(`${instance.url}/v1/chat/completions`, chatRequest("hello"));
    expect(res2.status).toBe(200);
  });
});
