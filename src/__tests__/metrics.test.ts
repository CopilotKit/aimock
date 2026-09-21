import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import * as metricsModule from "../metrics.js";
import { createMetricsRegistry, normalizePathLabel, type MetricsRegistry } from "../metrics.js";
import { createServer, type ServerInstance } from "../server.js";
import { LLMock } from "../llmock.js";
import { MCPMock } from "../mcp-mock.js";
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
  headers?: Record<string, string>,
): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: "GET", headers }, (res) => {
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

  it("normalizes ElevenLabs voice path", () => {
    expect(normalizePathLabel("/v1/voices/preview_captain")).toBe("/v1/voices/{voice_id}");
  });

  it("partial match: /model/foo/unknown-op is not a route and collapses", () => {
    expect(normalizePathLabel("/model/foo/unknown-op")).toBe(metricsModule.UNKNOWN_PATH_LABEL);
  });

  it("empty string (the pre-parse pathname) collapses", () => {
    expect(normalizePathLabel("")).toBe(metricsModule.UNKNOWN_PATH_LABEL);
  });

  it("normalizes Vertex AI streamGenerateContent path", () => {
    expect(
      normalizePathLabel(
        "/v1/projects/my-proj/locations/us-central1/publishers/google/models/gemini:streamGenerateContent",
      ),
    ).toBe("/v1/projects/{p}/locations/{l}/publishers/google/models/{m}:streamGenerateContent");
  });

  it("normalizes OpenRouter video status path", () => {
    expect(normalizePathLabel("/api/v1/videos/0b126396-2b78-4f08-a2a0-0e8de15c1b5a")).toBe(
      "/api/v1/videos/{jobId}",
    );
  });

  it("normalizes OpenRouter video content path", () => {
    expect(normalizePathLabel("/api/v1/videos/0b126396-2b78-4f08-a2a0-0e8de15c1b5a/content")).toBe(
      "/api/v1/videos/{jobId}/content",
    );
  });

  it("leaves the OpenRouter video models listing path unchanged", () => {
    expect(normalizePathLabel("/api/v1/videos/models")).toBe("/api/v1/videos/models");
  });

  it("leaves the OpenRouter video submit path unchanged", () => {
    expect(normalizePathLabel("/api/v1/videos")).toBe("/api/v1/videos");
  });

  it("normalizes OpenAI video status path", () => {
    expect(normalizePathLabel("/v1/videos/video_abc123")).toBe("/v1/videos/{id}");
  });

  // BytePlus Ark task ids (`cgt-<uuid>`) are unbounded, so an un-normalized
  // status path mints one Prometheus label per job. The `/api/v3`-prefixed form
  // is the load-bearing assertion for the submit path: the bare form is already
  // its own label when the branch is absent, so only the prefixed form proves
  // the branch runs.
  it("normalizes BytePlus Ark video status path", () => {
    expect(
      normalizePathLabel(
        "/api/v3/contents/generations/tasks/cgt-2f5f9d1c-0f2a-4f1e-9c7e-1a2b3c4d5e6f",
      ),
    ).toBe("/contents/generations/tasks/{id}");
    expect(
      normalizePathLabel("/contents/generations/tasks/cgt-2f5f9d1c-0f2a-4f1e-9c7e-1a2b3c4d5e6f"),
    ).toBe("/contents/generations/tasks/{id}");
  });

  it("normalizes BytePlus Ark video submit path", () => {
    expect(normalizePathLabel("/api/v3/contents/generations/tasks")).toBe(
      "/contents/generations/tasks",
    );
    expect(normalizePathLabel("/contents/generations/tasks")).toBe("/contents/generations/tasks");
  });

  // Fine-tuning job ids are minted per create, so an un-normalized id-bearing
  // path mints one Prometheus label per job. Two ids per assertion: a single id
  // would still pass against a rule that echoed the path back unchanged for
  // one specific input, and the point is that DIFFERENT ids share one label.
  it("normalizes fine-tuning routes this server implements", () => {
    expect(normalizePathLabel("/v1/fine_tuning/jobs/ftjob-aaa")).toBe("/v1/fine_tuning/jobs/{id}");
    expect(normalizePathLabel("/v1/fine_tuning/jobs/ftjob-bbb")).toBe("/v1/fine_tuning/jobs/{id}");
    expect(normalizePathLabel("/v1/fine_tuning/jobs/ftjob-aaa/cancel")).toBe(
      "/v1/fine_tuning/jobs/{id}/cancel",
    );
    expect(normalizePathLabel("/v1/fine_tuning/jobs/ftjob-bbb/cancel")).toBe(
      "/v1/fine_tuning/jobs/{id}/cancel",
    );
    expect(normalizePathLabel("/v1/fine_tuning/jobs/ftjob-aaa/events")).toBe(
      "/v1/fine_tuning/jobs/{id}/events",
    );
    expect(normalizePathLabel("/v1/fine_tuning/jobs/ftjob-bbb/events")).toBe(
      "/v1/fine_tuning/jobs/{id}/events",
    );
  });

  // pause/resume/checkpoints have no handler and take the generic 404 — but
  // server.ts records metrics from `res.on("finish")` for every response, 404s
  // included, and the `openai` SDK calls all three. Un-normalized, each
  // `jobs.pause()` against a fresh job would mint a new label pair.
  it("normalizes the fine-tuning sub-resources the openai SDK calls but this server 404s", () => {
    for (const action of ["pause", "resume", "checkpoints"]) {
      expect(normalizePathLabel(`/v1/fine_tuning/jobs/ftjob-aaa/${action}`)).toBe(
        `/v1/fine_tuning/jobs/{id}/${action}`,
      );
      expect(normalizePathLabel(`/v1/fine_tuning/jobs/ftjob-bbb/${action}`)).toBe(
        `/v1/fine_tuning/jobs/{id}/${action}`,
      );
    }
  });

  // The action segment is caller-controlled, so an allowlist miss must collapse
  // too: echoing it back would leave the cardinality hole open to anything a
  // typo or a fuzzer sends.
  it("collapses an unknown fine-tuning sub-resource to a single {action} label", () => {
    expect(normalizePathLabel("/v1/fine_tuning/jobs/ftjob-aaa/bogus")).toBe(
      "/v1/fine_tuning/jobs/{id}/{action}",
    );
    expect(normalizePathLabel("/v1/fine_tuning/jobs/ftjob-bbb/also-bogus")).toBe(
      "/v1/fine_tuning/jobs/{id}/{action}",
    );
  });

  // The collection path is static and must not collapse into the {id} bucket.
  // It cannot: the id RE requires a trailing `/<segment>`. This pins that, so
  // the guard deleted from the cascade stays deleted.
  it("leaves the fine-tuning collection path unchanged", () => {
    expect(normalizePathLabel("/v1/fine_tuning/jobs")).toBe("/v1/fine_tuning/jobs");
  });

  // `openai@4.104.0` calls the checkpoint-permission routes from
  // resources/fine-tuning/checkpoints/permissions.js. Checkpoint ids are minted
  // per checkpoint exactly as job ids are per job, so the same label hazard
  // applies — and aimock implements none of these routes, which makes no
  // difference: the 404 is still recorded.
  it("normalizes the checkpoint-permission routes the openai SDK calls", () => {
    expect(normalizePathLabel("/v1/fine_tuning/checkpoints/ftckpt-aaa/permissions")).toBe(
      "/v1/fine_tuning/checkpoints/{ckpt}/permissions",
    );
    expect(normalizePathLabel("/v1/fine_tuning/checkpoints/ftckpt-bbb/permissions")).toBe(
      "/v1/fine_tuning/checkpoints/{ckpt}/permissions",
    );
    expect(normalizePathLabel("/v1/fine_tuning/checkpoints/ftckpt-aaa/permissions/cp-1")).toBe(
      "/v1/fine_tuning/checkpoints/{ckpt}/permissions/{id}",
    );
    expect(normalizePathLabel("/v1/fine_tuning/checkpoints/ftckpt-bbb/permissions/cp-2")).toBe(
      "/v1/fine_tuning/checkpoints/{ckpt}/permissions/{id}",
    );
  });

  // Both checkpoint segments are caller-controlled, so both collapse: an
  // unknown sub-resource to `{action}`, a bare checkpoint id to `{ckpt}`.
  it("collapses a bare checkpoint id and an unknown checkpoint sub-resource", () => {
    expect(normalizePathLabel("/v1/fine_tuning/checkpoints/ftckpt-aaa")).toBe(
      "/v1/fine_tuning/checkpoints/{ckpt}",
    );
    expect(normalizePathLabel("/v1/fine_tuning/checkpoints/ftckpt-bbb")).toBe(
      "/v1/fine_tuning/checkpoints/{ckpt}",
    );
    expect(normalizePathLabel("/v1/fine_tuning/checkpoints/ftckpt-aaa/bogus")).toBe(
      "/v1/fine_tuning/checkpoints/{ckpt}/{action}",
    );
    expect(normalizePathLabel("/v1/fine_tuning/checkpoints/ftckpt-bbb/also-bogus")).toBe(
      "/v1/fine_tuning/checkpoints/{ckpt}/{action}",
    );
  });

  // The alpha grader routes (resources/fine-tuning/alpha/graders.js) carry no
  // ids, so they must survive the namespace catch-all verbatim — collapsing
  // them would throw away the only labels that distinguish them.
  it("keeps the id-free alpha grader routes verbatim", () => {
    expect(normalizePathLabel("/v1/fine_tuning/alpha/graders/run")).toBe(
      "/v1/fine_tuning/alpha/graders/run",
    );
    expect(normalizePathLabel("/v1/fine_tuning/alpha/graders/validate")).toBe(
      "/v1/fine_tuning/alpha/graders/validate",
    );
  });

  // Depth is caller-controlled too. Anything in the namespace that matches no
  // rule lands in one bucket, so the label set is finite for every input — not
  // just for the shapes enumerated above.
  it("collapses any unmatched fine-tuning path into a single bucket", () => {
    expect(normalizePathLabel("/v1/fine_tuning/jobs/ftjob-aaa/checkpoints/ftckpt-1")).toBe(
      "/v1/fine_tuning/{other}",
    );
    expect(normalizePathLabel("/v1/fine_tuning/jobs/ftjob-bbb/checkpoints/ftckpt-2")).toBe(
      "/v1/fine_tuning/{other}",
    );
    expect(normalizePathLabel("/v1/fine_tuning/checkpoints/ftckpt-aaa/permissions/cp-1/deep")).toBe(
      "/v1/fine_tuning/{other}",
    );
    expect(normalizePathLabel("/v1/fine_tuning/whatever-a")).toBe("/v1/fine_tuning/{other}");
    expect(normalizePathLabel("/v1/fine_tuning/whatever-b")).toBe("/v1/fine_tuning/{other}");
  });

  // The cardinality property the rules exist for, asserted directly: a hundred
  // distinct ids across every enumerated shape must not mint a hundred labels.
  it("keeps the fine-tuning label set finite across many distinct ids", () => {
    const labels = new Set<string>();
    for (let i = 0; i < 100; i++) {
      labels.add(normalizePathLabel(`/v1/fine_tuning/jobs/ftjob-${i}`));
      labels.add(normalizePathLabel(`/v1/fine_tuning/jobs/ftjob-${i}/cancel`));
      labels.add(normalizePathLabel(`/v1/fine_tuning/checkpoints/ftckpt-${i}`));
      labels.add(normalizePathLabel(`/v1/fine_tuning/checkpoints/ftckpt-${i}/permissions`));
      labels.add(normalizePathLabel(`/v1/fine_tuning/checkpoints/ftckpt-${i}/permissions/cp-${i}`));
      labels.add(normalizePathLabel(`/v1/fine_tuning/jobs/ftjob-${i}/checkpoints/ftckpt-${i}`));
    }
    expect([...labels].sort()).toEqual([
      "/v1/fine_tuning/checkpoints/{ckpt}",
      "/v1/fine_tuning/checkpoints/{ckpt}/permissions",
      "/v1/fine_tuning/checkpoints/{ckpt}/permissions/{id}",
      "/v1/fine_tuning/jobs/{id}",
      "/v1/fine_tuning/jobs/{id}/cancel",
      "/v1/fine_tuning/{other}",
    ]);
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
  vi.restoreAllMocks();
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

  it("increments chaos counter when chaos triggers (fixture source)", async () => {
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
    // Require both labels: action AND source. The source label is part of the
    // public metric contract (added when chaos was extended to proxy mode) and
    // an unasserted label is a regression hazard — future callers that forget
    // to pass source would produce a series without the source label, which
    // would pass a bare action match but fails this regex.
    expect(res.body).toMatch(
      /aimock_chaos_triggered_total\{[^}]*action="drop"[^}]*source="fixture"[^}]*\} 1/,
    );
  });

  it('chaos counter carries source="proxy" on proxy path', async () => {
    // Counterpart to the fixture-source test: proves the source label flips
    // correctly when the chaos roll belongs to the proxy dispatch branch.
    // Together these two tests pin both label values of the source dimension.
    const upstream = await createServer(
      [{ match: { userMessage: "hi" }, response: { content: "upstream" } }],
      { port: 0 },
    );
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-metrics-proxy-source-"));
    try {
      instance = await createServer([], {
        metrics: true,
        chaos: { dropRate: 1.0 },
        record: {
          providers: { openai: upstream.url },
          fixturePath: fixtureDir,
          proxyOnly: true,
        },
      });

      await httpPost(`${instance.url}/v1/chat/completions`, chatRequest("hi"));

      const res = await httpGet(`${instance.url}/metrics`);
      expect(res.body).toMatch(
        /aimock_chaos_triggered_total\{[^}]*action="drop"[^}]*source="proxy"[^}]*\} 1/,
      );
    } finally {
      await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
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
    expect(res.body).toMatch(
      /aimock_chaos_triggered_total\{[^}]*action="drop"[^}]*source="fixture"[^}]*\} 1/,
    );
  });

  it("OpenRouter video lifecycle paths are templated (no per-job label cardinality)", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "metrics video", endpoint: "video" },
        response: { video: { id: "vid_mx", status: "completed", b64: "AAAA" } },
      },
    ];
    instance = await createServer(fixtures, { metrics: true });

    const submit = await httpPost(`${instance.url}/api/v1/videos`, {
      model: "m/v",
      prompt: "metrics video",
    });
    expect(submit.status).toBe(200);
    const { id } = JSON.parse(submit.body) as { id: string };

    // Default 0/0 progression: the first poll reports completed.
    expect((await httpGet(`${instance.url}/api/v1/videos/${id}`)).status).toBe(200);
    expect(
      (
        await httpGet(`${instance.url}/api/v1/videos/${id}/content?index=0`, {
          Authorization: "Bearer test",
        })
      ).status,
    ).toBe(200);

    const res = await httpGet(`${instance.url}/metrics`);
    // Boundary-aware: a bare toContain would be substring-satisfied by the
    // {jobId} line.
    expect(res.body).toMatch(/path="\/api\/v1\/videos"[,}]/);
    expect(res.body).toContain('path="/api/v1/videos/{jobId}"');
    expect(res.body).toContain('path="/api/v1/videos/{jobId}/content"');
    // The job UUID must never appear as a label value.
    expect(res.body).not.toContain(id);
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

    // Guard against vacuous green: the faulty registry must actually have been
    // exercised. If the spy stopped intercepting createMetricsRegistry, the real
    // registry would serve both requests and callCount would stay 0.
    expect(callCount).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// F3: every response counts, no label is unbounded
// ---------------------------------------------------------------------------

describe("normalizePathLabel: closed namespaces (F3)", () => {
  it("collapses every Gemini model action, not just generate/streamGenerate", () => {
    expect(normalizePathLabel("/v1beta/models/gemini-embedding-001:embedContent")).toBe(
      "/v1beta/models/{model}:embedContent",
    );
    expect(normalizePathLabel("/v1beta/models/imagen-3.0-generate-002:predict")).toBe(
      "/v1beta/models/{model}:predict",
    );
    expect(normalizePathLabel("/v1beta/models/gemini-2.0-flash:countTokens")).toBe(
      "/v1beta/models/{model}:countTokens",
    );
    // Unknown action segment is caller text — bounded, not verbatim.
    expect(normalizePathLabel("/v1beta/models/gemini-2.0-flash:fuzz9a8b")).toBe(
      "/v1beta/models/{model}:{action}",
    );
    // Bare model lookup collapses too; the bare listing path is not a route
    // server.ts serves, so it takes the unrouted bucket like any other.
    expect(normalizePathLabel("/v1beta/models/gemini-2.0-flash")).toBe("/v1beta/models/{model}");
    expect(normalizePathLabel("/v1beta/models")).toBe(metricsModule.UNKNOWN_PATH_LABEL);
    // The Veo submit label is byte-identical to before the RE widened.
    expect(normalizePathLabel("/v1beta/models/veo-3.0:predictLongRunning")).toBe(
      "/v1beta/models/{model}:predictLongRunning",
    );
  });

  it("collapses fal request ids and model ids", () => {
    expect(normalizePathLabel("/fal/queue/requests/req-8f2a9c")).toBe("/fal/queue/requests/{id}");
    expect(normalizePathLabel("/fal/queue/requests/req-8f2a9c/status")).toBe(
      "/fal/queue/requests/{id}/status",
    );
    expect(normalizePathLabel("/fal/queue/requests/req-8f2a9c/bogus")).toBe(
      "/fal/queue/requests/{id}/{other}",
    );
    expect(normalizePathLabel("/fal/fal-ai/flux/dev/requests/req-8f2a9c")).toBe(
      "/fal/{model}/requests/{id}",
    );
    expect(normalizePathLabel("/fal/fal-ai/flux/dev/requests/req-8f2a9c/cancel")).toBe(
      "/fal/{model}/requests/{id}/cancel",
    );
    expect(normalizePathLabel("/fal/queue/submit/fal-ai/flux/dev")).toBe(
      "/fal/queue/submit/{model}",
    );
    expect(normalizePathLabel("/fal/run/fal-ai/flux/dev")).toBe("/fal/run/{model}");
    expect(normalizePathLabel("/fal/storage/upload/initiate")).toBe("/fal/{other}");
  });

  it("closes the music, files and batches namespaces", () => {
    expect(normalizePathLabel("/v1/music/generation")).toBe("/v1/music/generation");
    expect(normalizePathLabel("/v1/music/zzz-random")).toBe("/v1/music/{other}");
    expect(normalizePathLabel("/v1/files/file-abc/zz")).toBe("/v1/files/{other}");
    expect(normalizePathLabel("/v1/files/file-abc/content")).toBe("/v1/files/{id}/content");
    expect(normalizePathLabel("/v1/batches/batch_abc/y")).toBe("/v1/batches/{other}");
    expect(normalizePathLabel("/v1/batches/batch_abc/cancel")).toBe("/v1/batches/{id}/cancel");
    expect(normalizePathLabel("/v1/batches")).toBe("/v1/batches");
  });

  it("buckets an unrouted path instead of echoing it", () => {
    expect(normalizePathLabel("/nonexistent/random-9a8b7c")).toBe(metricsModule.UNKNOWN_PATH_LABEL);
    // A served static path is always its own label.
    expect(normalizePathLabel("/v1/chat/completions")).toBe("/v1/chat/completions");
    // A routed id path that legitimately 404s keeps its placeholder label.
    expect(normalizePathLabel("/v1/files/file-missing")).toBe("/v1/files/{id}");
  });
});

describe("integration: destroyed responses are counted (F3)", () => {
  it("counts a chaos-disconnected response under status=destroyed", async () => {
    const fixtures: Fixture[] = [{ match: { userMessage: "hello" }, response: { content: "hi" } }];
    instance = await createServer(fixtures, { metrics: true, chaos: { disconnectRate: 1 } });

    // The socket is destroyed before any status line — the client sees an error.
    await expect(
      httpPost(`${instance.url}/v1/chat/completions`, chatRequest("hello")),
    ).rejects.toThrow();

    const res = await httpGet(`${instance.url}/metrics`);
    expect(res.body).toMatch(
      new RegExp(
        `aimock_requests_total\\{method="POST",path="/v1/chat/completions",status="${metricsModule.DESTROYED_STATUS_LABEL}"\\} 1`,
      ),
    );
    // Counted exactly once: `close` follows `finish` on a normal response and
    // must not double-count, and a destroyed one has no `finish` to pair with.
    const completionLines = res.body
      .split("\n")
      .filter((l) => l.startsWith("aimock_requests_total{") && l.includes("/v1/chat/completions"));
    expect(completionLines).toHaveLength(1);
  });

  it("labels an unrouted 404 as {unknown} on the live counter", async () => {
    instance = await createServer([], { metrics: true });
    const probe = await httpGet(`${instance.url}/nonexistent/random-9a8b7c`);
    expect(probe.status).toBe(404);
    const res = await httpGet(`${instance.url}/metrics`);
    expect(res.body).toContain(
      `aimock_requests_total{method="GET",path="${metricsModule.UNKNOWN_PATH_LABEL}",status="404"} 1`,
    );
    expect(res.body).not.toContain("random-9a8b7c");
  });
});

// ---------------------------------------------------------------------------
// Route-aware collapse: the label is decided by route shape, never by status
// ---------------------------------------------------------------------------

describe("normalizePathLabel: route-aware collapse", () => {
  it("collapses an unrouted path whatever the caller would have seen", () => {
    // The status-gated collapse only fired on 404; a CORS preflight (204) and
    // a destroyed response (no status) minted one label per fuzzed path.
    for (const p of ["/zz-random-1", "/zz-random-2", "/nope-random"]) {
      expect(normalizePathLabel(p)).toBe(metricsModule.UNKNOWN_PATH_LABEL);
    }
  });

  it("keeps a routed static path verbatim even when it 404s (fixture miss)", () => {
    for (const p of ["/v1/chat/completions", "/api/chat", "/v1/messages", "/v1/music"]) {
      expect(normalizePathLabel(p)).toBe(p);
    }
  });

  it("collapses a caller-controlled Vertex action like Gemini does", () => {
    const base = "/v1/projects/p/locations/l/publishers/google/models/m";
    expect(normalizePathLabel(`${base}:generateContent`)).toBe(
      "/v1/projects/{p}/locations/{l}/publishers/google/models/{m}:generateContent",
    );
    expect(normalizePathLabel(`${base}:streamGenerateContent`)).toBe(
      "/v1/projects/{p}/locations/{l}/publishers/google/models/{m}:streamGenerateContent",
    );
    expect(normalizePathLabel(`${base}:bogusAction`)).toBe(
      "/v1/projects/{p}/locations/{l}/publishers/google/models/{m}:{action}",
    );
    expect(normalizePathLabel(`${base}:alsoBogus`)).toBe(
      "/v1/projects/{p}/locations/{l}/publishers/google/models/{m}:{action}",
    );
  });

  it("gives the routed music sub-paths their own label", () => {
    expect(normalizePathLabel("/v1/music/plan")).toBe("/v1/music/plan");
    expect(normalizePathLabel("/v1/music/detailed")).toBe("/v1/music/detailed");
    expect(normalizePathLabel("/v1/music/stream")).toBe("/v1/music/stream");
    expect(normalizePathLabel("/v1/music/bogus")).toBe("/v1/music/{other}");
  });

  it("bounds the control API and mounted-service namespaces", () => {
    expect(normalizePathLabel("/__aimock/journal")).toBe("/__aimock/journal");
    expect(normalizePathLabel("/__aimock/nope-1")).toBe("/__aimock/{other}");
    expect(normalizePathLabel("/mcp", ["/mcp", "/a2a"])).toBe("/mcp");
    expect(normalizePathLabel("/a2a/.well-known/agent-card.json", ["/mcp", "/a2a"])).toBe(
      "/a2a/.well-known/agent-card.json",
    );
    expect(normalizePathLabel("/a2a/random-1", ["/mcp", "/a2a"])).toBe("/a2a/{other}");
    expect(normalizePathLabel("/mcp")).toBe(metricsModule.UNKNOWN_PATH_LABEL);
  });
});

describe("integration: route-aware labels on the live counter", () => {
  it("labels a fixture-miss 404 on a routed path with the route, not {unknown}", async () => {
    instance = await createServer(
      [{ match: { userMessage: "hello" }, response: { content: "hi" } }],
      { metrics: true },
    );
    const miss = await httpPost(`${instance.url}/v1/chat/completions`, chatRequest("no-match"));
    expect(miss.status).toBe(404);
    const res = await httpGet(`${instance.url}/metrics`);
    expect(res.body).toContain(
      'aimock_requests_total{method="POST",path="/v1/chat/completions",status="404"} 1',
    );
  });

  it("collapses CORS preflights to unrouted paths into one {unknown} series", async () => {
    instance = await createServer([], { metrics: true });
    const base = instance.url;
    for (const p of ["/zz-random-1", "/zz-random-2", "/zz-random-3"]) {
      const r = await new Promise<number>((resolve, reject) => {
        const req = http.request(`${base}${p}`, { method: "OPTIONS" }, (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode!));
        });
        req.on("error", reject);
        req.end();
      });
      expect(r).toBe(204);
    }
    const res = await httpGet(`${instance.url}/metrics`);
    expect(res.body).toContain(
      `aimock_requests_total{method="OPTIONS",path="${metricsModule.UNKNOWN_PATH_LABEL}",status="204"} 3`,
    );
    expect(res.body).not.toContain("zz-random");
  });

  it("counts a request rejected before routing (unparseable Host) as {unknown}", async () => {
    instance = await createServer([], { metrics: true });
    const base = instance.url;
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        `${base}/v1/chat/completions`,
        { method: "GET", headers: { Host: "bad host" } },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode!));
        },
      );
      req.on("error", reject);
      req.end();
    });
    // URL-construction failures are client errors, still counted before routing.
    expect(status).toBe(400);
    const res = await httpGet(`${instance.url}/metrics`);
    expect(res.status).toBe(200);
    expect(res.body).toContain(
      `aimock_requests_total{method="GET",path="${metricsModule.UNKNOWN_PATH_LABEL}",status="400"} 1`,
    );
  });
});

describe("route-aware labels track the live route table (round 2)", () => {
  it("labels a bare /fal like the fal route, not {unknown}", () => {
    // server.ts routes `/^\/fal(?:\/.*)?$/`, so `/fal` is routed; its label
    // must come from the fal namespace rule, not fall through to unknown.
    expect(normalizePathLabel("/fal")).toBe("/fal/{other}");
  });

  it("labels a service mounted AFTER start() with its mount path on the live counter", async () => {
    const llm = new LLMock({ metrics: true });
    await llm.start();
    try {
      llm.mount("/mcp", new MCPMock());
      const r = await httpPost(`${llm.url}/mcp`, { jsonrpc: "2.0", id: 1, method: "ping" });
      expect(r.status).not.toBe(404);
      const res = await httpGet(`${llm.url}/metrics`);
      expect(res.body).toContain('aimock_requests_total{method="POST",path="/mcp",status="');
      expect(res.body).not.toContain(`path="${metricsModule.UNKNOWN_PATH_LABEL}"`);
    } finally {
      await llm.stop();
    }
  });
});

describe("mounted service metric precedence", () => {
  it.each(["/fal/custom", "/v1/files/custom", "/v1/music/custom", "/custom"])(
    "keeps bounded live labels for a late mount at %s",
    async (mountPath) => {
      const llm = new LLMock({ metrics: true });
      await llm.start();
      try {
        llm.mount(mountPath, {
          async handleRequest(_req, res, subPath) {
            res.end(subPath);
            return true;
          },
        });
        for (const suffix of ["", "/.well-known/agent-card.json", "/random-1", "/random-2"]) {
          const response = await httpGet(`${llm.url}${mountPath}${suffix}`);
          expect(response.status).toBe(200);
          expect(response.body).toBe(suffix || "/");
        }
        const metrics = await httpGet(`${llm.url}/metrics`);
        for (const [suffix, count] of [
          ["", 1],
          ["/.well-known/agent-card.json", 1],
          ["/{other}", 2],
        ] as const) {
          expect(metrics.body).toContain(
            `aimock_requests_total{method="GET",path="${mountPath}${suffix}",status="200"} ${count}`,
          );
        }
        expect(metrics.body).not.toContain("random-");
      } finally {
        await llm.stop();
      }
    },
  );

  it("keeps control API precedence and first registered mount matching", async () => {
    const llm = new LLMock({ metrics: true });
    for (const mountPath of ["/fal", "/fal/custom", "/__aimock"]) {
      llm.mount(mountPath, {
        async handleRequest(_req, res) {
          res.end(mountPath);
          return true;
        },
      });
    }
    await llm.start();
    try {
      const mounted = await httpGet(`${llm.url}/fal/custom`);
      expect(mounted.status).toBe(200);
      expect(mounted.body).toBe("/fal");
      const control = await httpGet(`${llm.url}/__aimock/health`);
      expect(control.status).toBe(200);
      expect(control.body).not.toBe("/__aimock");
      expect((await httpGet(`${llm.url}/__aimock/random-1`)).status).toBe(404);
      const metrics = await httpGet(`${llm.url}/metrics`);
      for (const [label, status] of [
        ["/fal/{other}", 200],
        ["/__aimock/health", 200],
        ["/__aimock/{other}", 404],
      ] as const) {
        expect(metrics.body).toContain(
          `aimock_requests_total{method="GET",path="${label}",status="${status}"} 1`,
        );
      }
    } finally {
      await llm.stop();
    }
  });

  it("keeps provider labels outside mount boundaries", () => {
    const mounts = ["/fal/custom", "/v1/files/custom", "/v1/music/custom"];
    expect(normalizePathLabel("/fal/run/model", mounts)).toBe("/fal/run/{model}");
    expect(normalizePathLabel("/v1/files/file-123/content", mounts)).toBe("/v1/files/{id}/content");
    expect(normalizePathLabel("/v1/music/generation", mounts)).toBe("/v1/music/generation");
    expect(normalizePathLabel("/fal/customized", mounts)).toBe("/fal/{other}");
    expect(normalizePathLabel("/fal/custom", ["/fal/custom", "/fal"])).toBe("/fal/custom");
  });
});
