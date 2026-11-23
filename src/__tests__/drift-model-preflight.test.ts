import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  alertText,
  classifyRetirement,
  daysUntil,
  evaluate,
  parseWarnDays,
  runPreflight,
  stepSummary,
  type FetchLike,
} from "../../scripts/drift-model-preflight.js";
import { DRIFT_PROBE_MODELS, type DriftProbeModel } from "./drift/probe-models.js";

const NOW = new Date("2026-10-26T18:00:00Z");
const k9: DriftProbeModel = {
  provider: "openai",
  model: "o4-mini",
  source: "src/__tests__/drift/probe-models.ts",
  constant: "OPENAI_K9_PROBE_MODEL",
};

describe("date logic (fixed dates)", () => {
  it("counts whole UTC days, whatever the time of day", () => {
    expect(daysUntil("2026-10-26", NOW)).toBe(0);
    expect(daysUntil("2026-10-27", NOW)).toBe(1);
    expect(daysUntil("2026-10-23", NOW)).toBe(-3);
    expect(daysUntil("2026-11-25T23:59:59Z", NOW)).toBe(30);
  });

  it("is retired ON the shutdown date and after it", () => {
    expect(classifyRetirement("2026-10-23", NOW, 30)).toBe("retired");
    expect(classifyRetirement("2026-10-26", NOW, 30)).toBe("retired");
  });

  it("warns inside the window, inclusive, and not outside it", () => {
    expect(classifyRetirement("2026-10-27", NOW, 30)).toBe("warn");
    expect(classifyRetirement("2026-11-25", NOW, 30)).toBe("warn");
    expect(classifyRetirement("2026-11-26", NOW, 30)).toBe("ok");
    expect(classifyRetirement("2026-12-11", NOW, 30)).toBe("ok");
    expect(classifyRetirement("2026-12-11", NOW, 46)).toBe("warn");
  });

  it("has nothing to say without a date", () => {
    expect(classifyRetirement(undefined, NOW, 30)).toBe("ok");
  });

  it("refuses a date it cannot read instead of passing it", () => {
    expect(() => daysUntil("soon", NOW)).toThrow(/unparseable/);
  });

  it("reads the warning window from the environment", () => {
    expect(parseWarnDays(undefined)).toBe(30);
    expect(parseWarnDays("")).toBe(30);
    expect(parseWarnDays("60")).toBe(60);
    expect(() => parseWarnDays("-1")).toThrow();
    expect(() => parseWarnDays("ten")).toThrow();
  });
});

describe("evaluate", () => {
  it("names the model, the date and the constant to change when it is retired", () => {
    const r = evaluate(k9, { kind: "served", retiresOn: "2026-10-23" }, NOW, 30);
    expect(r.verdict).toBe("retired");
    expect(r.message).toBe(
      "probe model o4-mini (openai) retired on 2026-10-23 — update OPENAI_K9_PROBE_MODEL in src/__tests__/drift/probe-models.ts",
    );
  });

  it("treats a gone model as retired and points at the pin", () => {
    const pinned: DriftProbeModel = {
      provider: "gemini",
      model: "text-embedding-004",
      source: "src/__tests__/drift/gemini.drift.ts",
    };
    const r = evaluate(pinned, { kind: "gone", detail: "HTTP 404: not found" }, NOW, 30);
    expect(r.verdict).toBe("retired");
    expect(r.message).toContain("text-embedding-004 (gemini) is retired (HTTP 404");
    expect(r.message).toContain(
      "update the pin in src/__tests__/drift/gemini.drift.ts and its entry in src/__tests__/drift/probe-models.ts",
    );
  });

  it("warns with the days left", () => {
    const r = evaluate(
      { ...k9, model: "gpt-5-mini" },
      { kind: "served", retiresOn: "2026-11-01" },
      NOW,
      30,
    );
    expect(r.verdict).toBe("warn");
    expect(r.message).toContain("gpt-5-mini (openai) retires on 2026-11-01 (in 6 days)");
  });

  it("uses only the date part of an ISO timestamp", () => {
    const r = evaluate(k9, { kind: "served", retiresOn: "2026-11-02T00:00:00Z" }, NOW, 30);
    expect(r.message).toContain("retires on 2026-11-02 (in 7 days)");
  });

  it("warns on a deprecation that has no date", () => {
    const r = evaluate(k9, { kind: "served", deprecated: true }, NOW, 30);
    expect(r.verdict).toBe("warn");
    expect(r.message).toContain("deprecated with no retirement date published");
  });

  it("skips, never fails, when the provider gave no usable answer", () => {
    const r = evaluate(k9, { kind: "unknown", detail: "HTTP 503 from the models API" }, NOW, 30);
    expect(r.verdict).toBe("skip");
  });
});

/** A fake provider API answering by URL. */
function fakeFetch(routes: Record<string, [number, unknown]>): FetchLike {
  return async (url) => {
    const route = routes[url];
    if (!route) throw new Error(`unexpected request: ${url}`);
    const [status, body] = route;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
}

const ALL_KEYS = {
  OPENAI_API_KEY: "k",
  ANTHROPIC_API_KEY: "k",
  GOOGLE_API_KEY: "k",
  COHERE_API_KEY: "k",
  OPENROUTER_API_KEY: "k",
};

describe("provider lookups", () => {
  const probes: DriftProbeModel[] = [
    { provider: "openai", model: "o4-mini", source: "a.ts" },
    { provider: "openai", model: "gpt-5-mini", source: "a.ts" },
    { provider: "openai", model: "gpt-4o-mini", source: "a.ts" },
    { provider: "anthropic", model: "claude-3-haiku-20240307", source: "b.ts" },
    { provider: "anthropic", model: "claude-old", source: "b.ts" },
    { provider: "gemini", model: "gemini-2.5-flash", source: "c.ts" },
    { provider: "cohere", model: "rerank-v3.5", source: "d.ts" },
    { provider: "openrouter", model: "qwen/qwen3-32b", source: "e.ts" },
    { provider: "openrouter", model: "gone/model", source: "e.ts" },
    { provider: "ollama", model: "qwen2:0.5b", source: "f.yml" },
  ];
  const routes: Record<string, [number, unknown]> = {
    "https://api.openai.com/v1/models/o4-mini": [
      200,
      { id: "o4-mini", shutdown_date: "2026-10-23" },
    ],
    "https://api.openai.com/v1/models/gpt-5-mini": [200, { shutdown_date: "2026-11-20" }],
    "https://api.openai.com/v1/models/gpt-4o-mini": [200, { shutdown_date: null }],
    "https://api.anthropic.com/v1/models/claude-3-haiku-20240307": [
      404,
      { type: "error", error: { type: "not_found_error" } },
    ],
    "https://api.anthropic.com/v1/models/claude-old": [
      200,
      { lifecycle: "deprecated", retires_at: "2026-11-05T00:00:00Z" },
    ],
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash": [200, {}],
    "https://api.cohere.com/v1/models/rerank-v3.5": [200, { name: "rerank-v3.5" }],
    "https://openrouter.ai/api/v1/models": [
      200,
      { data: [{ id: "qwen/qwen3-32b", expiration_date: null }] },
    ],
  };

  it("maps each provider's real retirement field to a verdict", async () => {
    const results = await runPreflight(probes, {
      fetch: fakeFetch(routes),
      env: ALL_KEYS,
      now: NOW,
      warnDays: 30,
    });
    expect(results.map((r) => [r.probe.model, r.verdict])).toEqual([
      ["o4-mini", "retired"],
      ["gpt-5-mini", "warn"],
      ["gpt-4o-mini", "ok"],
      ["claude-3-haiku-20240307", "retired"],
      ["claude-old", "warn"],
      ["gemini-2.5-flash", "ok"],
      ["rerank-v3.5", "ok"],
      ["qwen/qwen3-32b", "ok"],
      ["gone/model", "retired"],
      ["qwen2:0.5b", "skip"],
    ]);
  });

  it("fetches the OpenRouter listing once for any number of models", async () => {
    let calls = 0;
    const counting: FetchLike = async (url, init) => {
      if (url.startsWith("https://openrouter.ai")) calls++;
      return fakeFetch(routes)(url, init);
    };
    await runPreflight(
      probes.filter((p) => p.provider === "openrouter"),
      { fetch: counting, env: ALL_KEYS, now: NOW, warnDays: 30 },
    );
    expect(calls).toBe(1);
  });

  it("skips on a missing key, an auth error, a 5xx or a network error", async () => {
    const url = "https://api.openai.com/v1/models/gpt-4o-mini";
    const one = (status: number): FetchLike => fakeFetch({ [url]: [status, "nope"] });
    const probe = [probes[2]];
    const run = (fetch: FetchLike, env: Record<string, string> = ALL_KEYS) =>
      runPreflight(probe, { fetch, env, now: NOW, warnDays: 30 }).then((r) => r[0]);

    expect((await run(one(200), {})).message).toContain("OPENAI_API_KEY is not set");
    expect((await run(one(401))).verdict).toBe("skip");
    expect((await run(one(429))).verdict).toBe("skip");
    expect((await run(one(503))).verdict).toBe("skip");
    const down: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    expect((await run(down)).message).toContain("request failed: fetch failed");
  });

  it("skips when the response lacks the retirement field instead of calling it served", async () => {
    const r = await runPreflight([probes[2]], {
      fetch: fakeFetch({ "https://api.openai.com/v1/models/gpt-4o-mini": [200, { id: "x" }] }),
      env: ALL_KEYS,
      now: NOW,
      warnDays: 30,
    });
    expect(r[0].verdict).toBe("skip");
  });
});

describe("reporting", () => {
  const results = [
    evaluate(k9, { kind: "served", retiresOn: "2026-11-10" }, NOW, 30),
    evaluate(k9, { kind: "served", retiresOn: "2026-10-23" }, NOW, 30),
    evaluate(k9, { kind: "served" }, NOW, 30),
    evaluate(k9, { kind: "unknown", detail: "x" }, NOW, 30),
  ];

  it("alerts on retirements first, then warnings, and nothing else", () => {
    const lines = alertText(results).split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^• probe model o4-mini \(openai\) retired on 2026-10-23/);
    expect(lines[1]).toMatch(/^• probe model o4-mini \(openai\) retires on 2026-11-10/);
  });

  it("alert text is empty on a clean run", () => {
    expect(alertText([results[2], results[3]])).toBe("");
  });

  it("writes one summary row per model", () => {
    const summary = stepSummary(results, 30);
    expect(summary).toContain("warning window: 30 days");
    expect(
      summary.split("\n").filter((l) => l.startsWith("| ") && l.includes("`o4-mini`")),
    ).toHaveLength(4);
  });
});

describe("probe-models.ts stays honest", () => {
  const root = resolve(__dirname, "../..");

  it("every entry is still pinned in the source file it names", () => {
    for (const p of DRIFT_PROBE_MODELS) {
      const text = readFileSync(resolve(root, p.source), "utf8");
      expect(text, `${p.model} is no longer in ${p.source}`).toContain(p.model);
    }
  });

  it("lists each provider/model pair once", () => {
    const keys = DRIFT_PROBE_MODELS.map((p) => `${p.provider}/${p.model}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
