/**
 * OpenAI Fine-tuning jobs mock.
 *
 * Implements `POST /v1/fine_tuning/jobs`, `GET /v1/fine_tuning/jobs`,
 * `GET /v1/fine_tuning/jobs/{id}`, `POST .../cancel` and
 * `GET .../events` with a deterministic progression:
 *
 *   validating_files → queued → running → succeeded
 *
 * Retrieve advances the job (first → queued, second → running,
 * third+ → succeeded with a fine-tuned model name). Cancel moves a
 * non-terminal job to `cancelled`. Events are synthesized from the
 * current status so polling UIs have something to render.
 *
 * In-memory per process, cleared by the full reset path, journaled as
 * `service: "fine-tuning"` and chaos-gated like the other job surfaces.
 */

import type * as http from "node:http";
import { flattenHeaders, generateId, isJsonObject } from "./helpers.js";
import { applyChaos } from "./chaos.js";
import type { ChaosDefaults } from "./types.js";
import type { Journal } from "./journal.js";
import type { Logger } from "./logger.js";
import type { MetricsRegistry } from "./metrics.js";

export interface FineTuningJob {
  id: string;
  object: "fine_tuning.job";
  model: string;
  training_file: string;
  validation_file?: string;
  status: "validating_files" | "queued" | "running" | "succeeded" | "cancelled" | "failed";
  created_at: number;
  finished_at?: number;
  fine_tuned_model?: string;
  hyperparameters?: { n_epochs?: number; batch_size?: number; learning_rate_multiplier?: number };
}

const jobs = new Map<string, FineTuningJob>();
const polls = new Map<string, number>();

export function clearFineTuningStore(): void {
  jobs.clear();
  polls.clear();
}

type Defaults = { logger: Logger; chaos?: ChaosDefaults; registry?: MetricsRegistry };

function journalFt(
  journal: Journal,
  method: string,
  path: string,
  headers: Record<string, string>,
  status: number,
): void {
  journal.add({
    method,
    path,
    headers,
    body: null,
    service: "fine-tuning",
    response: { status, fixture: null },
  });
}

function writeJson(
  res: http.ServerResponse,
  status: number,
  payload: unknown,
  setCorsHeaders: (res: http.ServerResponse) => void,
): void {
  setCorsHeaders(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function invalid(message: string): { error: { message: string; type: string } } {
  return { error: { message, type: "invalid_request_error" } };
}

function chaosHit(
  req: http.IncomingMessage,
  journal: Journal,
  defaults: Defaults,
  method: string,
  path: string,
  res: http.ServerResponse,
): boolean {
  return applyChaos(
    res,
    null,
    defaults.chaos,
    req.headers,
    req.url,
    journal,
    { method, path, headers: flattenHeaders(req.headers), body: null },
    "internal",
    defaults.registry,
    defaults.logger,
  );
}

function advance(job: FineTuningJob): FineTuningJob {
  if (job.status === "succeeded" || job.status === "cancelled" || job.status === "failed") {
    return job;
  }
  const n = (polls.get(job.id) ?? 0) + 1;
  polls.set(job.id, n);
  if (n === 1) job.status = "queued";
  else if (n === 2) job.status = "running";
  else {
    job.status = "succeeded";
    job.finished_at = Math.floor(Date.now() / 1000);
    job.fine_tuned_model = `ft:${job.model}:aimock:${job.id.slice(-6)}`;
  }
  return job;
}

function eventsFor(job: FineTuningJob): {
  object: string;
  data: { message: string; created_at: number }[];
} {
  const base = job.created_at;
  const msgs: string[] = [];
  msgs.push("Job created, validating training file");
  if (job.status !== "validating_files") msgs.push("Training file validated, job queued");
  if (job.status === "running" || job.status === "succeeded") msgs.push("Training started");
  if (job.status === "succeeded") msgs.push(`Training complete, model ${job.fine_tuned_model}`);
  if (job.status === "cancelled") msgs.push("Job cancelled by user");
  return {
    object: "list",
    data: msgs.map((message, i) => ({ message, created_at: base + i * 5 })),
  };
}

export async function handleFineTuningCreate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  raw: string,
  journal: Journal,
  defaults: Defaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  const path = req.url ?? "/v1/fine_tuning/jobs";
  const method = req.method ?? "POST";
  if (chaosHit(req, journal, defaults, method, path, res)) return;
  let body: unknown;
  try {
    body = JSON.parse(raw) as unknown;
  } catch (err) {
    journalFt(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(
      res,
      400,
      invalid(`Malformed JSON: ${err instanceof Error ? err.message : "unknown"}`),
      setCorsHeaders,
    );
    return;
  }
  if (!isJsonObject(body)) {
    journalFt(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(res, 400, invalid("Request body must be a JSON object"), setCorsHeaders);
    return;
  }
  const trainingFile = body["training_file"];
  const model = body["model"];
  if (typeof trainingFile !== "string" || trainingFile.length === 0) {
    journalFt(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(
      res,
      400,
      invalid("Invalid parameter: 'training_file' must be a non-empty string"),
      setCorsHeaders,
    );
    return;
  }
  if (typeof model !== "string" || model.length === 0) {
    journalFt(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(
      res,
      400,
      invalid("Invalid parameter: 'model' must be a non-empty string"),
      setCorsHeaders,
    );
    return;
  }
  const hyper = body["hyperparameters"];
  const job: FineTuningJob = {
    id: generateId("ftjob"),
    object: "fine_tuning.job",
    model,
    training_file: trainingFile,
    status: "validating_files",
    created_at: Math.floor(Date.now() / 1000),
  };
  if (typeof body["validation_file"] === "string") job.validation_file = body["validation_file"];
  if (hyper !== undefined && typeof hyper === "object" && hyper !== null) {
    const h = hyper as Record<string, unknown>;
    job.hyperparameters = {};
    for (const k of ["n_epochs", "batch_size", "learning_rate_multiplier"] as const) {
      if (typeof h[k] === "number") job.hyperparameters[k] = h[k] as number;
    }
  }
  jobs.set(job.id, job);
  polls.set(job.id, 0);
  journalFt(journal, method, path, flattenHeaders(req.headers), 200);
  writeJson(res, 200, job, setCorsHeaders);
}

export async function handleFineTuningList(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  journal: Journal,
  defaults: Defaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  const path = req.url ?? "/v1/fine_tuning/jobs";
  const method = req.method ?? "GET";
  if (chaosHit(req, journal, defaults, method, path, res)) return;
  const data = [...jobs.values()].sort((a, b) => a.created_at - b.created_at);
  journalFt(journal, method, path, flattenHeaders(req.headers), 200);
  writeJson(res, 200, { object: "list", data }, setCorsHeaders);
}

export async function handleFineTuningRetrieve(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string,
  journal: Journal,
  defaults: Defaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  const path = req.url ?? `/v1/fine_tuning/jobs/${id}`;
  const method = req.method ?? "GET";
  if (chaosHit(req, journal, defaults, method, path, res)) return;
  const job = jobs.get(id);
  if (!job) {
    journalFt(journal, method, path, flattenHeaders(req.headers), 404);
    writeJson(res, 404, invalid(`No such fine-tuning job: ${id}`), setCorsHeaders);
    return;
  }
  journalFt(journal, method, path, flattenHeaders(req.headers), 200);
  writeJson(res, 200, advance(job), setCorsHeaders);
}

export async function handleFineTuningCancel(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string,
  journal: Journal,
  defaults: Defaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  const path = req.url ?? `/v1/fine_tuning/jobs/${id}/cancel`;
  const method = req.method ?? "POST";
  if (chaosHit(req, journal, defaults, method, path, res)) return;
  const job = jobs.get(id);
  if (!job) {
    journalFt(journal, method, path, flattenHeaders(req.headers), 404);
    writeJson(res, 404, invalid(`No such fine-tuning job: ${id}`), setCorsHeaders);
    return;
  }
  if (job.status === "succeeded" || job.status === "failed") {
    journalFt(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(res, 400, invalid(`Job ${id} is already terminal (${job.status})`), setCorsHeaders);
    return;
  }
  job.status = "cancelled";
  journalFt(journal, method, path, flattenHeaders(req.headers), 200);
  writeJson(res, 200, job, setCorsHeaders);
}

export async function handleFineTuningEvents(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string,
  journal: Journal,
  defaults: Defaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  const path = req.url ?? `/v1/fine_tuning/jobs/${id}/events`;
  const method = req.method ?? "GET";
  if (chaosHit(req, journal, defaults, method, path, res)) return;
  const job = jobs.get(id);
  if (!job) {
    journalFt(journal, method, path, flattenHeaders(req.headers), 404);
    writeJson(res, 404, invalid(`No such fine-tuning job: ${id}`), setCorsHeaders);
    return;
  }
  journalFt(journal, method, path, flattenHeaders(req.headers), 200);
  writeJson(res, 200, eventsFor(job), setCorsHeaders);
}
