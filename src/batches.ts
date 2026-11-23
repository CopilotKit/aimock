/**
 * OpenAI Batches API mock.
 *
 * Covers `POST /v1/batches`, `GET /v1/batches`, `GET /v1/batches/{id}` and
 * `POST /v1/batches/{id}/cancel` with a deterministic poll progression so
 * batch flows can be tested without waiting 24h:
 *
 *   validating → in_progress → completed | failed | expired | cancelled
 *
 * The first retrieve after create advances to `in_progress`, the second (and
 * later) to the batch's outcome. Terminal batches are stable. On `completed`
 * the mock registers a REAL file in the Files store (`output_file_id`, purpose
 * `batch_output`, filename `<batch-id>_output.jsonl`) holding one JSONL line
 * per input request, so `GET /v1/files/{id}/content` serves it back and the
 * upload → create → poll → download flow closes. When `input_file_id` names a
 * file in the store, its JSONL lines drive the `custom_id`s and
 * `request_counts.total`; when it does not (the id was never uploaded here),
 * the mock synthesizes ONE request (`custom_id: "request-1"`, `total: 1`) so
 * the output file is still downloadable.
 *
 * Outcome control: the real API only ever completes a healthy batch, so a
 * suite that has to exercise its failure handling needs a lever. Send
 * `X-AIMock-Batch-Outcome: completed | failed | expired | cancelled` on
 * `POST /v1/batches` (default `completed`, unknown values 400). `failed`
 * populates a one-entry `errors` list and a real `error_file_id` (one JSONL
 * error line per request) and stamps `failed_at`; `expired` stamps `expired_at`; `cancelled`
 * lands the batch on `cancelled` without a cancel call. Same `X-AIMock-*`
 * family as `X-AIMock-Strict` and the chaos headers.
 *
 * `cancel` on a non-terminal batch answers `cancelling` (stamping
 * `cancelling_at`); the next retrieve shows `cancelled` with `cancelled_at`.
 * Cancelling a terminal batch is 400 `Cannot cancel a batch with status
 * <status>.` (the SDK's `Batch.status` union, openai@4.104.0
 * `resources/batches.d.ts`, is the source for the status set and the `*_at`
 * stamps; the exact 400 message text is UNVERIFIED against the live API).
 *
 * Output-line shape (`{id: "batch_req_…", custom_id, response: {status_code,
 * request_id, body}, error}` / error lines with `response: null` and
 * `error: {code, message}`) follows the OpenAI Batch guide's documented
 * result-file format; neither the vendored SDK nor `openai/openai-openapi`
 * types the file's lines, so that shape is UNVERIFIED against a live capture.
 *
 * State is in-memory per process and cleared by the full reset path.
 * Every branch journals with `service: "batches"` and runs through the
 * chaos gate so fault-injection suites can target the batch surface.
 */

import type * as http from "node:http";
import { randomBytes } from "node:crypto";
import { flattenHeaders, generateId, isJsonObject } from "./helpers.js";
import { applyChaosAsync, type ChaosAsyncOutcome } from "./chaos.js";
import { paginate, readMetadata } from "./fine-tuning.js";
import { FILES_MAX_BYTES, getStoredFileBytes, storeFile } from "./files.js";
import { buildTextResponse } from "./responses.js";
import type { ChaosDefaults } from "./types.js";
import type { Journal } from "./journal.js";
import type { Logger } from "./logger.js";
import type { MetricsRegistry } from "./metrics.js";
import { buildOpenAIError } from "./response/errors.js";

export interface BatchObject {
  id: string;
  object: "batch";
  endpoint: string;
  input_file_id: string;
  completion_window: string;
  status: BatchStatus;
  created_at: number;
  metadata?: Record<string, string>;
  in_progress_at?: number;
  completed_at?: number;
  failed_at?: number;
  expired_at?: number;
  cancelling_at?: number;
  cancelled_at?: number;
  output_file_id?: string;
  error_file_id?: string;
  errors?: { object: "list"; data: BatchError[] };
  request_counts?: { total: number; completed: number; failed: number };
}

/** `Batch.status` minus `finalizing`, which this mock never lingers in. */
export type BatchStatus =
  | "validating"
  | "in_progress"
  | "completed"
  | "failed"
  | "expired"
  | "cancelling"
  | "cancelled";

/** `BatchError` from the SDK (`openai@4.104.0` `resources/batches.d.ts`). */
export interface BatchError {
  code?: string;
  line?: number | null;
  message?: string;
  param?: string | null;
}

/**
 * The statuses a batch never leaves. Single source of truth: `advance()`
 * refuses to move a terminal batch and the cancel handler rejects one, so the
 * two cannot drift apart.
 */
const TERMINAL_STATUSES = new Set<BatchStatus>(["completed", "failed", "expired", "cancelled"]);

function isTerminal(status: BatchStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** Values accepted on `X-AIMock-Batch-Outcome`; where a batch lands on its 2nd retrieve. */
const OUTCOMES = new Set(["completed", "failed", "expired", "cancelled"]);
type BatchOutcome = "completed" | "failed" | "expired" | "cancelled";
const OUTCOME_HEADER = "x-aimock-batch-outcome";

// The `BatchCreateParams.endpoint` union in the vendored `openai` SDK 4.104.0
// (`resources/batches.d.ts`): `/v1/responses`, `/v1/chat/completions`,
// `/v1/embeddings`, `/v1/completions`.
const VALID_ENDPOINTS = new Set([
  "/v1/responses",
  "/v1/chat/completions",
  "/v1/embeddings",
  "/v1/completions",
]);

const batches = new Map<string, BatchObject>();
const batchPolls = new Map<string, number>();
const batchOutcomes = new Map<string, BatchOutcome>();

export function clearBatchStore(): void {
  batches.clear();
  batchPolls.clear();
  batchOutcomes.clear();
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
  return buildOpenAIError("service-validation", { message });
}

type Defaults = { logger: Logger; chaos?: ChaosDefaults; registry?: MetricsRegistry };

/**
 * Roll the chaos dice for one batches request. Returns true when a fault
 * fired and the response is already written, so the caller returns early.
 *
 * CORS headers go on BEFORE the roll, because a fault writes the response
 * itself and never reaches `writeJson`. `service: "batches"` on the journal
 * context keeps faulted requests visible under `?service=batches`. Mirrors
 * the `chaosHit` in `src/fine-tuning.ts`.
 */
async function chaosHit(
  req: http.IncomingMessage,
  journal: Journal,
  defaults: Defaults,
  method: string,
  path: string,
  res: http.ServerResponse,
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<ChaosAsyncOutcome> {
  setCorsHeaders(res);
  return await applyChaosAsync(
    res,
    null,
    defaults.chaos,
    req.headers,
    req.url,
    journal,
    {
      method,
      path,
      headers: flattenHeaders(req.headers),
      body: null,
      service: "batches",
    },
    "internal",
    defaults.registry,
    defaults.logger,
  );
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * The input file's requests, as `{ custom_id, model }` per JSONL line. Lines
 * that are not JSON objects still count as requests (the real API reports
 * them as errors by line; here they get a positional `custom_id`). An
 * `input_file_id` that was never uploaded to this mock yields one synthesized
 * request — see the module docblock.
 */
function inputRequests(batch: BatchObject): { custom_id: string; model: string }[] {
  const bytes = getStoredFileBytes(batch.input_file_id);
  const lines =
    bytes === undefined
      ? []
      : bytes
          .toString("utf8")
          .split("\n")
          .filter((l) => l.trim() !== "");
  const requests = lines.map((line, i) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      parsed = undefined;
    }
    const obj = isJsonObject(parsed) ? parsed : {};
    const body = isJsonObject(obj["body"]) ? obj["body"] : {};
    return {
      custom_id: typeof obj["custom_id"] === "string" ? obj["custom_id"] : `request-${i + 1}`,
      model: typeof body["model"] === "string" ? body["model"] : "aimock",
    };
  });
  return requests.length > 0 ? requests : [{ custom_id: "request-1", model: "aimock" }];
}

/** A minimal per-endpoint success body for one output line. */
function outputBody(endpoint: string, model: string): Record<string, unknown> {
  const created = now();
  if (endpoint === "/v1/responses") {
    // The same `Response` envelope the live `/v1/responses` mock writes
    // (`object: "response"`, `status`, `output[]` message with `output_text`,
    // `usage`), per openai@4.104.0 `resources/responses/responses.d.ts`.
    return buildTextResponse("Mock batch completion", model) as Record<string, unknown>;
  }
  if (endpoint === "/v1/embeddings") {
    return {
      object: "list",
      model,
      data: [{ object: "embedding", index: 0, embedding: [0, 0, 0] }],
      usage: { prompt_tokens: 1, total_tokens: 1 },
    };
  }
  if (endpoint === "/v1/completions") {
    return {
      id: generateId("cmpl"),
      object: "text_completion",
      created,
      model,
      choices: [{ index: 0, text: "Mock batch completion", finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
  }
  return {
    id: generateId("chatcmpl"),
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Mock batch completion" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

/** `batch_req_…` / `req_…` — underscore-joined like the real ids, unlike `generateId`. */
function underscoreId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("base64url")}`;
}

/**
 * Serialise one JSONL line per request, stopping the moment the running byte
 * count passes the Files store's per-file cap. Every output line is a fixed
 * ~430-byte canned body regardless of how small the input line was (a 3-byte
 * `{}` line amplifies ~143x), so an input file that is itself under the
 * upload cap can describe an output far over it; building the lines eagerly
 * would hold that whole over-cap buffer before anything could refuse it.
 * Returns `undefined` when the cap is exceeded, with at most `FILES_MAX_BYTES`
 * ever materialised.
 */
function jsonlUnderCap<T>(items: T[], line: (item: T) => unknown): Buffer | undefined {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for (const item of items) {
    const chunk = Buffer.from(JSON.stringify(line(item)) + "\n", "utf8");
    bytes += chunk.length;
    if (bytes > FILES_MAX_BYTES) {
      return undefined;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

/**
 * The batch could not mint its result file under {@link FILES_MAX_BYTES}: it
 * fails with one `errors` entry naming the cap. `BatchError.code` is an open
 * `string` in the SDK types and the real API has no equivalent condition, so
 * the code value is UNVERIFIED against a live capture.
 */
function failOverCap(batch: BatchObject, total: number, kind: "output" | "error"): void {
  batch.status = "failed";
  batch.errors = {
    object: "list",
    data: [
      {
        code: "output_file_too_large",
        message: `Batch ${kind} file would exceed the ${FILES_MAX_BYTES} byte per-file cap`,
        line: null,
        param: null,
      },
    ],
  };
  batch.request_counts = { total, completed: 0, failed: total };
  batch.failed_at = now();
}

function finish(batch: BatchObject, outcome: BatchOutcome): void {
  const requests = inputRequests(batch);
  const total = requests.length;
  batch.status = outcome;
  if (outcome === "completed") {
    const content = jsonlUnderCap(requests, (r) => ({
      id: underscoreId("batch_req"),
      custom_id: r.custom_id,
      response: {
        status_code: 200,
        request_id: underscoreId("req"),
        body: outputBody(batch.endpoint, r.model),
      },
      error: null,
    }));
    if (content === undefined) {
      failOverCap(batch, total, "output");
      return;
    }
    batch.output_file_id = storeFile({
      purpose: "batch_output",
      filename: `${batch.id}_output.jsonl`,
      content,
    }).id;
    batch.request_counts = { total, completed: total, failed: 0 };
    batch.completed_at = now();
  } else if (outcome === "failed") {
    const message = "Mock batch failure (X-AIMock-Batch-Outcome: failed)";
    const content = jsonlUnderCap(requests, (r) => ({
      id: underscoreId("batch_req"),
      custom_id: r.custom_id,
      response: null,
      error: { code: "mock_failure", message },
    }));
    if (content === undefined) {
      failOverCap(batch, total, "error");
      return;
    }
    batch.error_file_id = storeFile({
      purpose: "batch_output",
      filename: `${batch.id}_error.jsonl`,
      content,
    }).id;
    // One file-level entry, not one per request: `errors` rides inline on
    // every retrieve and every list page, so a per-line list scales the batch
    // object with the input (2000 lines -> ~225 KB per GET). The per-request
    // detail lives in the error file. (The live API's `Batch.Errors` is typed
    // as a plain `BatchError[]` in openai@4.104.0 `resources/batches.d.ts`;
    // that it stays small is UNVERIFIED there but matches its purpose of
    // reporting input-file validation errors, not per-request outcomes.)
    batch.errors = {
      object: "list",
      data: [
        { code: "mock_failure", message: `${message}: see error_file_id`, line: null, param: null },
      ],
    };
    batch.request_counts = { total, completed: 0, failed: total };
    batch.failed_at = now();
  } else if (outcome === "expired") {
    batch.request_counts = { total, completed: 0, failed: 0 };
    batch.expired_at = now();
  } else {
    batch.request_counts = { total, completed: 0, failed: 0 };
    batch.cancelled_at = now();
  }
}

function advance(batch: BatchObject): BatchObject {
  if (isTerminal(batch.status)) {
    return batch;
  }
  if (batch.status === "cancelling") {
    // Same arm the `X-AIMock-Batch-Outcome: cancelled` path lands on, so a
    // route-cancelled batch reports the same `request_counts`.
    finish(batch, "cancelled");
    return batch;
  }
  const polls = (batchPolls.get(batch.id) ?? 0) + 1;
  batchPolls.set(batch.id, polls);
  if (polls === 1) {
    batch.status = "in_progress";
    batch.in_progress_at = now();
    // `total` is known once the input has been read; the terminal arms in
    // `finish()` fill in `completed` / `failed`. (Whether the live API stamps
    // `total` exactly at `in_progress` is UNVERIFIED: openai@4.104.0
    // `resources/batches.d.ts` types `BatchRequestCounts` but not its timing.)
    batch.request_counts = { total: inputRequests(batch).length, completed: 0, failed: 0 };
  } else {
    finish(batch, batchOutcomes.get(batch.id) ?? "completed");
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
  if (await chaosHit(req, journal, defaults, method, path, res, setCorsHeaders)) return;

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
  // Same shared `Metadata` schema the fine-tuning mock validates and echoes.
  const metadata = readMetadata(body["metadata"]);
  if (!metadata.ok) {
    journalBatches(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(res, 400, invalid(metadata.message), setCorsHeaders);
    return;
  }

  const outcomeHeader = req.headers[OUTCOME_HEADER];
  const outcomeRaw = (Array.isArray(outcomeHeader) ? outcomeHeader[0] : outcomeHeader)
    ?.trim()
    .toLowerCase();
  if (outcomeRaw !== undefined && !OUTCOMES.has(outcomeRaw)) {
    journalBatches(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(
      res,
      400,
      invalid(
        `Invalid X-AIMock-Batch-Outcome '${outcomeRaw}'. Expected one of: ${[...OUTCOMES].join(", ")}`,
      ),
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
    request_counts: { total: 0, completed: 0, failed: 0 },
  };
  if (metadata.value !== null) batch.metadata = metadata.value;
  batches.set(id, batch);
  batchPolls.set(id, 0);
  if (outcomeRaw !== undefined) batchOutcomes.set(id, outcomeRaw as BatchOutcome);
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
  if (await chaosHit(req, journal, defaults, method, path, res, setCorsHeaders)) return;
  // Newest-first, mirroring `handleFineTuningList`: `paginate()` documents a
  // newest-first input, and reversing insertion order is the stable total
  // order a cursor walk needs (`created_at` has one-second resolution, so a
  // sort on it cannot order the ties that are the normal case).
  const data = [...batches.values()].reverse();
  // `after`/`limit` cursor paging shared with the fine-tuning mock; the real
  // list response also carries `first_id`/`last_id` (null on an empty page).
  const result = paginate(data, req.url);
  if (!result.ok) {
    journalBatches(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(res, 400, invalid(result.message), setCorsHeaders);
    return;
  }
  const page = result.page.data;
  journalBatches(journal, method, path, flattenHeaders(req.headers), 200);
  writeJson(
    res,
    200,
    {
      ...result.page,
      first_id: page[0]?.id ?? null,
      last_id: page[page.length - 1]?.id ?? null,
    },
    setCorsHeaders,
  );
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
  if (await chaosHit(req, journal, defaults, method, path, res, setCorsHeaders)) return;
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
  if (await chaosHit(req, journal, defaults, method, path, res, setCorsHeaders)) return;
  const batch = batches.get(batchId);
  if (!batch) {
    journalBatches(journal, method, path, flattenHeaders(req.headers), 404);
    writeJson(res, 404, invalid(`No such batch: ${batchId}`), setCorsHeaders);
    return;
  }
  if (isTerminal(batch.status)) {
    journalBatches(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(
      res,
      400,
      invalid(`Cannot cancel a batch with status ${batch.status}.`),
      setCorsHeaders,
    );
    return;
  }
  // Idempotent on an already-cancelling batch: no second stamp.
  if (batch.status !== "cancelling") {
    batch.status = "cancelling";
    batch.cancelling_at = now();
  }
  journalBatches(journal, method, path, flattenHeaders(req.headers), 200);
  writeJson(res, 200, batch, setCorsHeaders);
}
