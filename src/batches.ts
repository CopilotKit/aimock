/**
 * OpenAI Batches API mock.
 *
 * Covers `POST /v1/batches`, `GET /v1/batches`, `GET /v1/batches/{id}` and
 * `POST /v1/batches/{id}/cancel` with a deterministic poll progression so
 * batch flows can be tested without waiting 24h:
 *
 *   validating → in_progress → completed
 *
 * The first retrieve after create advances to `in_progress`, the second (and
 * later) to `completed` with a synthesized `output_file_id`. `cancel` moves
 * a non-terminal batch to `cancelled`. Terminal batches are stable.
 *
 * State is in-memory per process and cleared by the full reset path.
 * Every branch journals with `service: "batches"` and runs through the
 * chaos gate so fault-injection suites can target the batch surface.
 */

import type * as http from "node:http";
import { flattenHeaders, generateId, isJsonObject } from "./helpers.js";
import { applyChaos } from "./chaos.js";
import type { ChaosDefaults } from "./types.js";
import type { Journal } from "./journal.js";
import type { Logger } from "./logger.js";
import type { MetricsRegistry } from "./metrics.js";

export interface BatchObject {
  id: string;
  object: "batch";
  endpoint: string;
  input_file_id: string;
  completion_window: string;
  status: "validating" | "in_progress" | "completed" | "cancelled" | "failed";
  created_at: number;
  output_file_id?: string;
  error_file_id?: string;
  request_counts?: { total: number; completed: number; failed: number };
}

const VALID_ENDPOINTS = new Set(["/v1/chat/completions", "/v1/embeddings", "/v1/completions"]);

const batches = new Map<string, BatchObject>();
const batchPolls = new Map<string, number>();

export function clearBatchStore(): void {
  batches.clear();
  batchPolls.clear();
}

function journalBatches(
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
    service: "batches",
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

type Defaults = { logger: Logger; chaos?: ChaosDefaults; registry?: MetricsRegistry };

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

function advance(batch: BatchObject): BatchObject {
  if (batch.status === "completed" || batch.status === "cancelled" || batch.status === "failed") {
    return batch;
  }
  const polls = (batchPolls.get(batch.id) ?? 0) + 1;
  batchPolls.set(batch.id, polls);
  if (polls === 1) {
    batch.status = "in_progress";
  } else {
    batch.status = "completed";
    batch.output_file_id = `file-${batch.id.slice("batch-".length)}-output`;
    batch.request_counts = { total: 1, completed: 1, failed: 0 };
  }
  return batch;
}

export async function handleBatchesCreate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  raw: string,
  journal: Journal,
  defaults: Defaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  const path = req.url ?? "/v1/batches";
  const method = req.method ?? "POST";
  if (chaosHit(req, journal, defaults, method, path, res)) return;

  let body: unknown;
  try {
    body = JSON.parse(raw) as unknown;
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unknown";
    journalBatches(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(res, 400, invalid(`Malformed JSON: ${detail}`), setCorsHeaders);
    return;
  }
  if (!isJsonObject(body)) {
    journalBatches(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(res, 400, invalid("Request body must be a JSON object"), setCorsHeaders);
    return;
  }
  const inputFileId = body["input_file_id"];
  const endpoint = body["endpoint"];
  const window = body["completion_window"];
  if (typeof inputFileId !== "string" || inputFileId.length === 0) {
    journalBatches(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(
      res,
      400,
      invalid("Invalid parameter: 'input_file_id' must be a non-empty string"),
      setCorsHeaders,
    );
    return;
  }
  if (typeof endpoint !== "string" || !VALID_ENDPOINTS.has(endpoint)) {
    journalBatches(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(
      res,
      400,
      invalid(
        `Invalid endpoint '${String(endpoint)}'. Expected one of: ${[...VALID_ENDPOINTS].join(", ")}`,
      ),
      setCorsHeaders,
    );
    return;
  }
  if (window !== "24h") {
    journalBatches(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(
      res,
      400,
      invalid("Invalid parameter: 'completion_window' must be '24h'"),
      setCorsHeaders,
    );
    return;
  }

  const id = generateId("batch");
  const batch: BatchObject = {
    id,
    object: "batch",
    endpoint,
    input_file_id: inputFileId,
    completion_window: "24h",
    status: "validating",
    created_at: Math.floor(Date.now() / 1000),
  };
  batches.set(id, batch);
  batchPolls.set(id, 0);
  defaults.logger.debug(`Batches mock: created ${id}`);
  journalBatches(journal, method, path, flattenHeaders(req.headers), 200);
  writeJson(res, 200, batch, setCorsHeaders);
}

export async function handleBatchesList(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  journal: Journal,
  defaults: Defaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  const path = req.url ?? "/v1/batches";
  const method = req.method ?? "GET";
  if (chaosHit(req, journal, defaults, method, path, res)) return;
  const data = [...batches.values()].sort((a, b) => a.created_at - b.created_at);
  journalBatches(journal, method, path, flattenHeaders(req.headers), 200);
  writeJson(res, 200, { object: "list", data }, setCorsHeaders);
}

export async function handleBatchesRetrieve(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  batchId: string,
  journal: Journal,
  defaults: Defaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  const path = req.url ?? `/v1/batches/${batchId}`;
  const method = req.method ?? "GET";
  if (chaosHit(req, journal, defaults, method, path, res)) return;
  const batch = batches.get(batchId);
  if (!batch) {
    journalBatches(journal, method, path, flattenHeaders(req.headers), 404);
    writeJson(res, 404, invalid(`No such batch: ${batchId}`), setCorsHeaders);
    return;
  }
  journalBatches(journal, method, path, flattenHeaders(req.headers), 200);
  writeJson(res, 200, advance(batch), setCorsHeaders);
}

export async function handleBatchesCancel(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  batchId: string,
  journal: Journal,
  defaults: Defaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  const path = req.url ?? `/v1/batches/${batchId}/cancel`;
  const method = req.method ?? "POST";
  if (chaosHit(req, journal, defaults, method, path, res)) return;
  const batch = batches.get(batchId);
  if (!batch) {
    journalBatches(journal, method, path, flattenHeaders(req.headers), 404);
    writeJson(res, 404, invalid(`No such batch: ${batchId}`), setCorsHeaders);
    return;
  }
  if (batch.status === "completed" || batch.status === "failed") {
    journalBatches(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(
      res,
      400,
      invalid(`Batch ${batchId} is already terminal (${batch.status})`),
      setCorsHeaders,
    );
    return;
  }
  batch.status = "cancelled";
  journalBatches(journal, method, path, flattenHeaders(req.headers), 200);
  writeJson(res, 200, batch, setCorsHeaders);
}
