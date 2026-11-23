/// <reference types="node" />

/**
 * Drift probe-model retirement preflight
 *
 * Before the nightly drift run, asks each provider whether every model the
 * drift probes pin (`src/__tests__/drift/probe-models.ts`) is still served, so
 * a retirement is caught weeks ahead and named plainly instead of surfacing as
 * a confusing drift failure.
 *
 *   - gone, or past its shutdown date → `::error::` and exit 1
 *   - shutdown date within the warning window (default 30 days), or marked
 *     deprecated → `::warning::`, step summary, and the `retirement_alert`
 *     step output the `notify` job posts to Slack
 *   - no key, no retirement API, auth or transient error → informational skip
 *
 * Retirement fields used, each verified with a live request on 2026-10-26:
 *   OpenAI      GET /v1/models/{id}       `shutdown_date` (YYYY-MM-DD | null); 404 when gone
 *   Anthropic   GET /v1/models/{id}       `lifecycle`, `retires_at`; 404 when retired
 *   Gemini      GET /v1beta/models/{id}   no date field; 404 when gone
 *   Cohere      GET /v1/models/{id}       `is_deprecated` (absent when active); 404 when gone
 *   OpenRouter  GET /api/v1/models        `expiration_date` (YYYY-MM-DD | null); absent when gone
 * Bedrock's GetFoundationModel reports only `modelLifecycle.status`
 * (ACTIVE | LEGACY) and needs AWS credentials this step does not hold; Vertex,
 * Ollama and fal expose nothing usable. Those are skipped with a note.
 *
 * CLI usage (in CI):
 *   npx tsx scripts/drift-model-preflight.ts
 * Env: OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY, COHERE_API_KEY,
 * OPENROUTER_API_KEY; DRIFT_PREFLIGHT_WARN_DAYS overrides the 30-day window.
 */

import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DRIFT_PROBE_MODELS, type DriftProbeModel } from "../src/__tests__/drift/probe-models.js";

export const DEFAULT_WARN_DAYS = 30;
const REGISTRY_PATH = "src/__tests__/drift/probe-models.ts";
const DAY_MS = 86_400_000;
const REQUEST_TIMEOUT_MS = 15_000;

/** What a provider said about one model. */
export type ModelStatus =
  /** Served. `retiresOn` is the published shutdown date, if any. */
  | { kind: "served"; retiresOn?: string; deprecated?: boolean; note?: string }
  /** The provider no longer serves it. */
  | { kind: "gone"; detail: string }
  /** No answer usable for a retirement decision. Never fails the run. */
  | { kind: "unknown"; detail: string };

export type Verdict = "ok" | "warn" | "retired" | "skip";

export interface ProbeResult {
  probe: DriftProbeModel;
  verdict: Verdict;
  message: string;
}

// ---------------------------------------------------------------------------
// Date logic
// ---------------------------------------------------------------------------

/** Whole UTC days from `now` until `date` (negative once it has passed). */
export function daysUntil(date: string, now: Date): number {
  const target = Date.parse(date.length === 10 ? `${date}T00:00:00Z` : date);
  if (Number.isNaN(target)) throw new Error(`unparseable retirement date: ${date}`);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const t = new Date(target);
  const day = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
  return Math.round((day - today) / DAY_MS);
}

/** A model is retired ON its shutdown date, and warned about inside the window. */
export function classifyRetirement(
  retiresOn: string | undefined,
  now: Date,
  warnDays: number,
): "ok" | "warn" | "retired" {
  if (!retiresOn) return "ok";
  const days = daysUntil(retiresOn, now);
  if (days <= 0) return "retired";
  return days <= warnDays ? "warn" : "ok";
}

/** Where to fix a probe model: its constant when it has one, else its pin. */
export function fixHint(probe: DriftProbeModel): string {
  if (probe.constant) return `update ${probe.constant} in ${probe.source}`;
  if (probe.source === REGISTRY_PATH) return `update ${REGISTRY_PATH}`;
  return `update the pin in ${probe.source} and its entry in ${REGISTRY_PATH}`;
}

export function evaluate(
  probe: DriftProbeModel,
  status: ModelStatus,
  now: Date,
  warnDays: number,
): ProbeResult {
  const name = `probe model ${probe.model} (${probe.provider})`;
  if (status.kind === "unknown") {
    return { probe, verdict: "skip", message: `${name}: skipped — ${status.detail}` };
  }
  if (status.kind === "gone") {
    return {
      probe,
      verdict: "retired",
      message: `${name} is retired (${status.detail}) — ${fixHint(probe)}`,
    };
  }
  const date = status.retiresOn?.slice(0, 10);
  const level = classifyRetirement(date, now, warnDays);
  if (level === "retired") {
    return {
      probe,
      verdict: "retired",
      message: `${name} retired on ${date} — ${fixHint(probe)}`,
    };
  }
  if (level === "warn") {
    const days = daysUntil(date!, now);
    return {
      probe,
      verdict: "warn",
      message: `${name} retires on ${date} (in ${days} day${days === 1 ? "" : "s"}) — ${fixHint(probe)}`,
    };
  }
  if (status.deprecated) {
    return {
      probe,
      verdict: "warn",
      message: `${name} is deprecated with no retirement date published — ${fixHint(probe)}`,
    };
  }
  const when = date ? `shutdown ${date}` : (status.note ?? "no shutdown date");
  return { probe, verdict: "ok", message: `${name}: served (${when})` };
}

// ---------------------------------------------------------------------------
// Provider lookups
// ---------------------------------------------------------------------------

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface LookupContext {
  fetch: FetchLike;
  env: Record<string, string | undefined>;
  /** Memo for listing-based providers, so a listing is fetched once per run. */
  cache: Map<string, Promise<unknown>>;
}

const KEY_ENV: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GOOGLE_API_KEY",
  cohere: "COHERE_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

const NO_API_NOTE: Record<string, string> = {
  bedrock:
    "no retirement API reachable here (GetFoundationModel gives only ACTIVE/LEGACY and needs AWS credentials)",
  vertex: "no retirement API reachable here",
  ollama: "local daemon model; nothing to retire upstream",
  fal: "fal exposes no model retirement API",
};

/** Turn a non-2xx answer into a status. 404 is the only "gone" signal. */
async function nonOk(res: Response): Promise<ModelStatus> {
  const body = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
  if (res.status === 404) return { kind: "gone", detail: `HTTP 404: ${body}` };
  return { kind: "unknown", detail: `HTTP ${res.status} from the models API` };
}

async function getJson(
  ctx: LookupContext,
  url: string,
  headers: Record<string, string>,
): Promise<Response> {
  return ctx.fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

type Lookup = (model: string, key: string, ctx: LookupContext) => Promise<ModelStatus>;

const LOOKUPS: Record<string, Lookup> = {
  async openai(model, key, ctx) {
    const res = await getJson(
      ctx,
      `https://api.openai.com/v1/models/${encodeURIComponent(model)}`,
      {
        Authorization: `Bearer ${key}`,
      },
    );
    if (!res.ok) return nonOk(res);
    const body = (await res.json()) as { shutdown_date?: string | null };
    if (!("shutdown_date" in body)) {
      return { kind: "unknown", detail: "response has no shutdown_date field" };
    }
    return { kind: "served", retiresOn: body.shutdown_date ?? undefined };
  },

  async anthropic(model, key, ctx) {
    const res = await getJson(
      ctx,
      `https://api.anthropic.com/v1/models/${encodeURIComponent(model)}`,
      {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
    );
    if (!res.ok) return nonOk(res);
    const body = (await res.json()) as { lifecycle?: string; retires_at?: string | null };
    if (body.lifecycle === "retired") return { kind: "gone", detail: "lifecycle: retired" };
    if (!("lifecycle" in body) && !("retires_at" in body)) {
      return { kind: "unknown", detail: "response has no lifecycle or retires_at field" };
    }
    return {
      kind: "served",
      retiresOn: body.retires_at ?? undefined,
      deprecated: body.lifecycle === "deprecated",
    };
  },

  async gemini(model, key, ctx) {
    const res = await getJson(
      ctx,
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}`,
      { "x-goog-api-key": key },
    );
    if (!res.ok) return nonOk(res);
    return { kind: "served", note: "Gemini publishes no shutdown date" };
  },

  async cohere(model, key, ctx) {
    const res = await getJson(
      ctx,
      `https://api.cohere.com/v1/models/${encodeURIComponent(model)}`,
      {
        Authorization: `Bearer ${key}`,
      },
    );
    if (!res.ok) return nonOk(res);
    const body = (await res.json()) as { is_deprecated?: boolean };
    return {
      kind: "served",
      deprecated: body.is_deprecated === true,
      note: "Cohere publishes no shutdown date",
    };
  },

  async openrouter(model, key, ctx) {
    let listing = ctx.cache.get("openrouter") as
      | Promise<Response | { id: string; expiration_date?: string | null }[]>
      | undefined;
    if (!listing) {
      listing = getJson(ctx, "https://openrouter.ai/api/v1/models", {
        Authorization: `Bearer ${key}`,
      }).then(async (res) => {
        if (!res.ok) return res;
        return ((await res.json()) as { data: { id: string; expiration_date?: string | null }[] })
          .data;
      });
      ctx.cache.set("openrouter", listing);
    }
    const models = await listing;
    if (!Array.isArray(models)) {
      return { kind: "unknown", detail: `HTTP ${models.status} from the models API` };
    }
    const entry = models.find((m) => m.id === model);
    if (!entry) return { kind: "gone", detail: "not in the /api/v1/models listing" };
    return { kind: "served", retiresOn: entry.expiration_date ?? undefined };
  },
};

export async function lookup(probe: DriftProbeModel, ctx: LookupContext): Promise<ModelStatus> {
  const check = LOOKUPS[probe.provider];
  if (!check) return { kind: "unknown", detail: NO_API_NOTE[probe.provider] ?? "no API" };
  const keyEnv = KEY_ENV[probe.provider];
  const key = ctx.env[keyEnv];
  if (!key) return { kind: "unknown", detail: `${keyEnv} is not set` };
  try {
    return await check(probe.model, key, ctx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: "unknown", detail: `request failed: ${msg}` };
  }
}

export async function runPreflight(
  probes: readonly DriftProbeModel[],
  opts: { fetch: FetchLike; env: Record<string, string | undefined>; now: Date; warnDays: number },
): Promise<ProbeResult[]> {
  const ctx: LookupContext = { fetch: opts.fetch, env: opts.env, cache: new Map() };
  return Promise.all(
    probes.map(async (probe) => evaluate(probe, await lookup(probe, ctx), opts.now, opts.warnDays)),
  );
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const ICON: Record<Verdict, string> = { ok: "✅", warn: "⚠️", retired: "❌", skip: "➖" };

export function stepSummary(results: ProbeResult[], warnDays: number): string {
  const rows = results.map(
    (r) => `| ${ICON[r.verdict]} | ${r.probe.provider} | \`${r.probe.model}\` | ${r.message} |`,
  );
  return [
    `### Drift probe-model retirement preflight (warning window: ${warnDays} days)`,
    "",
    "| | Provider | Model | Result |",
    "|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

/** Slack mrkdwn lines for the `notify` job: retirements first, then warnings. */
export function alertText(results: ProbeResult[]): string {
  const pick = (verdict: Verdict) => results.filter((r) => r.verdict === verdict);
  return [...pick("retired"), ...pick("warn")].map((r) => `• ${r.message}`).join("\n");
}

function writeGithubOutput(name: string, value: string): void {
  const outPath = process.env.GITHUB_OUTPUT;
  if (!outPath) return;
  let delimiter = `EOF_${randomBytes(8).toString("hex")}`;
  while (value.includes(delimiter)) {
    delimiter = `EOF_${randomBytes(8).toString("hex")}`;
  }
  appendFileSync(outPath, `${name}<<${delimiter}\n${value}\n${delimiter}\n`, "utf-8");
}

export function parseWarnDays(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_WARN_DAYS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`DRIFT_PREFLIGHT_WARN_DAYS must be a whole number of days, got "${raw}"`);
  }
  return n;
}

async function main(): Promise<void> {
  const warnDays = parseWarnDays(process.env.DRIFT_PREFLIGHT_WARN_DAYS);
  const results = await runPreflight(DRIFT_PROBE_MODELS, {
    fetch: (url, init) => fetch(url, init),
    env: process.env,
    now: new Date(),
    warnDays,
  });

  for (const r of results) {
    if (r.verdict === "retired") console.log(`::error title=probe-model-retired::${r.message}`);
    else if (r.verdict === "warn")
      console.log(`::warning title=probe-model-retiring::${r.message}`);
    else console.log(`preflight: ${r.message}`);
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, stepSummary(results, warnDays), "utf-8");
  }
  const retired = results.some((r) => r.verdict === "retired");
  writeGithubOutput("retirement_alert", alertText(results));
  writeGithubOutput("retired", String(retired));

  if (retired) {
    console.log(
      "::error::Probe-model preflight failed: a drift probe model is retired. Drift was not run — this is not API drift.",
    );
    process.exit(1);
  }
  console.log("preflight: no drift probe model is retired");
}

// Only run as a CLI — importing this module (e.g. from tests) does not run main().
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
