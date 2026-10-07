/**
 * OpenAI Vector Stores API mock.
 *
 * Covers vector-store lifecycle and direct search for uploaded `Files`:
 *
 *   - `POST /v1/vector_stores` (create)
 *   - `GET /v1/vector_stores` (list)
 *   - `GET /v1/vector_stores/{id}` (retrieve)
 *   - `POST /v1/vector_stores/{id}` (modify)
 *   - `DELETE /v1/vector_stores/{id}` (delete)
 *   - `POST /v1/vector_stores/{id}/files` (attach a file)
 *   - `GET /v1/vector_stores/{id}/files` (list attached files)
 *   - `GET /v1/vector_stores/{id}/files/{file_id}` (retrieve an attached file)
 *   - `DELETE /v1/vector_stores/{id}/files/{file_id}` (detach a file)
 *   - `POST /v1/vector_stores/{id}/file_batches` (create a file batch)
 *   - `GET /v1/vector_stores/{id}/file_batches/{batch_id}` (retrieve a batch)
 *   - `POST /v1/vector_stores/{id}/file_batches/{batch_id}/cancel` (cancel)
 *   - `GET /v1/vector_stores/{id}/file_batches/{batch_id}/files` (batch files)
 *   - `POST /v1/vector_stores/{id}/search` (deterministic file search)
 *
 * Supports offline upload → vector-store → direct search tests. Attach a
 * `file-…` id, poll it to `completed`, then call the search endpoint.
 * This mock does not execute hosted `file_search` tools in Responses or
 * Assistants. Responses requests need separate matching fixtures; vector-store
 * contents do not automatically produce model responses.
 *
 * Lifecycle (deterministic poll progression, like the batches mock):
 *
 *   store:  in_progress → completed (completed at once when no file is
 *           pending; `expired` once `expires_at` passes)
 *   file:   in_progress → completed | failed | cancelled (first retrieve after
 *           attach shows `in_progress`, the second lands the outcome)
 *   batch:  in_progress → completed | failed | cancelled (same two-poll rule;
 *           `cancel` on a live batch answers `cancelling`, next retrieve is
 *           `cancelled`)
 *
 * Outcome control: send `X-AIMock-Vector-Outcome: completed | failed |
 * cancelled` on `POST …/files` or `POST …/file_batches` (default
 * `completed`, unknown values 400). Same header family as
 * `X-AIMock-Batch-Outcome`.
 *
 * Files must exist in the Files store (`GET /v1/files/{id}` would 200 for
 * them): attaching an unknown `file_id` is a 404 naming the file, so a suite
 * that forgets the upload step fails loudly instead of indexing a ghost.
 * `usage_bytes` is the real byte length from the Files store; a file the
 * store has no bytes for reports `0`.
 *
 * Search is deterministic, not semantic: only `completed` files are searched,
 * results are ordered by a stable hash of `query + file_id` so the same query
 * always ranks the same way, and every result carries its file's name plus a
 * canned text snippet quoting the query. Direct search supports tests of top-k,
 * score thresholds, and empty-store behaviour. It does not measure semantic
 * relevance.
 *
 * State is in-memory per process and cleared by the full reset path.
 * Every branch journals with `service: "vector-stores"` and runs through the
 * chaos gate so fault-injection suites can target this surface.
 *
 * Wire shapes follow the vendored `openai` SDK 4.x
 * (`resources/vector-stores/…`) and the `openai/openai-openapi` spec where
 * they agree (`id`, `object`, `created_at`, `name`, `usage_bytes`,
 * `file_counts`, `status`, `metadata`, `expires_after`/`expires_at`,
 * `last_active_at`, list envelopes with `object: "list"`, `data`,
 * `first_id`, `last_id`, `has_more`). Timestamps are Unix seconds. Anything
 * the sources leave unspecified (poll counts, the exact 400 texts, the
 * `cancelled` landing without a cancel call, search scoring) is this mock's
 * own contract and documented as such.
 */

import type * as http from "node:http";
import { randomBytes } from "node:crypto";
import { flattenHeaders, isJsonObject, parseStrictIntegerText } from "./helpers.js";
import { applyChaosAsync, type ChaosAsyncOutcome } from "./chaos.js";
import { readMetadata } from "./fine-tuning.js";
import { getStoredFileBytes, getStoredFileName } from "./files.js";
import type { ChaosDefaults } from "./types.js";
import type { Journal } from "./journal.js";
import type { Logger } from "./logger.js";
import type { MetricsRegistry } from "./metrics.js";

export type VectorStoreStatus = "expired" | "in_progress" | "completed";
export type VectorStoreFileStatus = "in_progress" | "completed" | "failed" | "cancelled";
export type VectorFileBatchStatus =
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled"
  | "cancelling";

export interface VectorStoreObject {
  id: string;
  object: "vector_store";
  created_at: number;
  name: string;
  usage_bytes: number;
  file_counts: {
    in_progress: number;
    completed: number;
    failed: number;
    cancelled: number;
    total: number;
  };
  status: VectorStoreStatus;
  metadata: Record<string, string> | null;
  expires_after?: { anchor: "last_active_at"; days: number };
  expires_at?: number | null;
  last_active_at?: number | null;
  chunking_strategy?: { type: "auto" } | { type: "static"; static: Record<string, number> };
}

type FileAttributes = Record<string, string | number | boolean>;

type AttributeFilter =
  | {
      type: "eq" | "ne" | "gt" | "gte" | "lt" | "lte";
      key: string;
      value: string | number | boolean;
    }
  | { type: "and" | "or"; filters: AttributeFilter[] };

export interface VectorStoreFileObject {
  id: string;
  object: "vector_store.file";
  attributes: FileAttributes | null;
  created_at: number;
  vector_store_id: string;
  status: VectorStoreFileStatus;
  usage_bytes: number;
  chunking_strategy?: { type: "static"; static: Record<string, number> };
  last_error?: { code: string; message: string } | null;
}

export interface VectorFileBatchObject {
  id: string;
  object: "vector_store.file_batch";
  created_at: number;
  vector_store_id: string;
  status: VectorFileBatchStatus;
  file_counts: {
    in_progress: number;
    completed: number;
    failed: number;
    cancelled: number;
    total: number;
  };
}

export interface VectorSearchResult {
  attributes: FileAttributes | null;
  file_id: string;
  filename: string;
  score: number;
  content: { type: "text"; text: string }[];
}

const stores = new Map<string, VectorStoreObject>();
const storeFiles = new Map<string, VectorStoreFileObject>();
const storePolls = new Map<string, number>();
const fileOutcomes = new Map<string, VectorStoreFileStatus>();
const fileBatches = new Map<string, VectorFileBatchObject>();
const batchPolls = new Map<string, number>();
const batchOutcomes = new Map<string, VectorStoreFileStatus>();
// Keep attachment identity: a detached file ID may later be attached again.
const batchMembers = new Map<string, VectorStoreFileObject[]>();
let lastStamp = 0;

export function clearVectorStoreStore(): void {
  stores.clear();
  storeFiles.clear();
  storePolls.clear();
  fileOutcomes.clear();
  fileBatches.clear();
  batchPolls.clear();
  batchOutcomes.clear();
  batchMembers.clear();
  lastStamp = 0;
}

/** Remove every vector attachment when its underlying uploaded File is deleted. */
export function removeVectorStoreFile(fileId: string): void {
  const affectedStores = new Set<string>();
  for (const [key, entry] of storeFiles) {
    if (entry.id !== fileId) continue;
    storeFiles.delete(key);
    storePolls.delete(key);
    fileOutcomes.delete(key);
    affectedStores.add(entry.vector_store_id);
  }
  for (const [batchId, members] of batchMembers) {
    const remaining = members.filter((entry) => entry.id !== fileId);
    if (remaining.length === members.length) continue;
    batchMembers.set(batchId, remaining);
    const batch = fileBatches.get(batchId);
    if (!batch) continue;
    batch.file_counts = batchCounts(batchId);
    if (remaining.length === 0 && !TERMINAL_BATCH_STATUSES.has(batch.status)) {
      batch.status = batch.status === "cancelling" ? "cancelled" : "completed";
      batchPolls.delete(batchId);
      batchOutcomes.delete(batchId);
    }
    affectedStores.add(batch.vector_store_id);
  }
  for (const storeId of affectedStores) {
    const store = stores.get(storeId);
    if (store) refreshStoreStatus(store);
  }
}

const TERMINAL_FILE_STATUSES = new Set<VectorStoreFileStatus>(["completed", "failed", "cancelled"]);
const TERMINAL_BATCH_STATUSES = new Set<VectorFileBatchStatus>([
  "completed",
  "failed",
  "cancelled",
]);
const OUTCOMES = new Set(["completed", "failed", "cancelled"]);
const OUTCOME_HEADER = "x-aimock-vector-outcome";
const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 100;

function stamp(): number {
  lastStamp = Math.max(Math.floor(Date.now() / 1000), lastStamp);
  return lastStamp;
}

function underscoreId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("base64url")}`;
}

function invalid(message: string): { error: { message: string; type: string } } {
  return { error: { message, type: "invalid_request_error" } };
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

type Defaults = { logger: Logger; chaos?: ChaosDefaults; registry?: MetricsRegistry };

function journalVs(
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
    service: "vector-stores",
    response: { status, fixture: null, source: "internal" },
  });
}

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
      service: "vector-stores",
    },
    "internal",
    defaults.registry,
    defaults.logger,
  );
}

function fileKey(storeId: string, fileId: string): string {
  return `${storeId}:${fileId}`;
}

function touch(store: VectorStoreObject): void {
  refreshStoreStatus(store);
  if (store.status === "expired") return;
  const now = stamp();
  store.last_active_at = now;
  if (store.expires_after) {
    store.expires_at = now + store.expires_after.days * 86400;
  }
  refreshStoreStatus(store);
}

function refreshStoreStatus(store: VectorStoreObject): void {
  const now = Math.floor(Date.now() / 1000);
  const expired =
    store.expires_at !== undefined && store.expires_at !== null && now >= store.expires_at;
  const files = [...storeFiles.values()].filter((f) => f.vector_store_id === store.id);
  const pending = files.filter((f) => f.status === "in_progress").length;
  const batchesLive = [...fileBatches.values()].filter(
    (b) =>
      b.vector_store_id === store.id && (b.status === "in_progress" || b.status === "cancelling"),
  ).length;
  store.status = expired ? "expired" : pending + batchesLive > 0 ? "in_progress" : "completed";
  let usage = 0;
  let inProgress = 0;
  let completed = 0;
  let failed = 0;
  let cancelled = 0;
  for (const f of files) {
    if (f.status === "completed") usage += f.usage_bytes;
    if (f.status === "in_progress") inProgress += 1;
    else if (f.status === "completed") completed += 1;
    else if (f.status === "failed") failed += 1;
    else cancelled += 1;
  }
  store.usage_bytes = usage;
  store.file_counts = {
    in_progress: inProgress,
    completed,
    failed,
    cancelled,
    total: files.length,
  };
}

function readExpiresAfter(
  value: unknown,
):
  | { ok: true; value: { anchor: "last_active_at"; days: number } | null }
  | { ok: false; message: string } {
  if (value === undefined) return { ok: true, value: null };
  if (!isJsonObject(value)) {
    return { ok: false, message: "Invalid parameter: 'expires_after' must be an object" };
  }
  if (value["anchor"] !== "last_active_at") {
    return {
      ok: false,
      message: "Invalid parameter: 'expires_after.anchor' must be 'last_active_at'",
    };
  }
  const days = value["days"];
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 365) {
    return {
      ok: false,
      message: "Invalid parameter: 'expires_after.days' must be an integer between 1 and 365",
    };
  }
  return { ok: true, value: { anchor: "last_active_at", days } };
}

function readChunkingStrategy(
  value: unknown,
):
  | { ok: true; value: VectorStoreObject["chunking_strategy"] | null }
  | { ok: false; message: string } {
  if (value === undefined) return { ok: true, value: null };
  if (!isJsonObject(value)) {
    return { ok: false, message: "Invalid parameter: 'chunking_strategy' must be an object" };
  }
  if (value["type"] === "auto") return { ok: true, value: { type: "auto" } };
  if (value["type"] === "static") {
    const inner = value["static"];
    if (!isJsonObject(inner)) {
      return {
        ok: false,
        message: "Invalid parameter: 'chunking_strategy.static' must be an object",
      };
    }
    const maxTokens = inner["max_chunk_size_tokens"];
    const overlap = inner["chunk_overlap_tokens"];
    if (
      typeof maxTokens !== "number" ||
      !Number.isInteger(maxTokens) ||
      maxTokens < 100 ||
      maxTokens > 4096
    ) {
      return {
        ok: false,
        message:
          "Invalid parameter: 'chunking_strategy.static.max_chunk_size_tokens' must be an integer between 100 and 4096",
      };
    }
    if (
      typeof overlap !== "number" ||
      !Number.isInteger(overlap) ||
      overlap < 0 ||
      overlap > 2048 ||
      overlap * 2 > maxTokens
    ) {
      return {
        ok: false,
        message:
          "Invalid parameter: 'chunking_strategy.static.chunk_overlap_tokens' must be an integer between 0 and 2048 and at most half of max_chunk_size_tokens",
      };
    }
    return {
      ok: true,
      value: {
        type: "static",
        static: { max_chunk_size_tokens: maxTokens, chunk_overlap_tokens: overlap },
      },
    };
  }
  return {
    ok: false,
    message: "Invalid parameter: 'chunking_strategy.type' must be 'auto' or 'static'",
  };
}

function isAttributeValue(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function readAttributes(
  value: unknown,
): { ok: true; value: FileAttributes | null } | { ok: false; message: string } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (!isJsonObject(value) || Object.keys(value).length > 16) {
    return {
      ok: false,
      message: "Invalid parameter: 'attributes' must be an object with at most 16 pairs or null",
    };
  }
  const entries: [string, string | number | boolean][] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (
      [...key].length > 64 ||
      !isAttributeValue(entry) ||
      (typeof entry === "string" && [...entry].length > 512)
    ) {
      return {
        ok: false,
        message:
          "Invalid parameter: 'attributes' keys must be at most 64 characters and values must be strings of at most 512 characters, finite numbers or booleans",
      };
    }
    entries.push([key, entry]);
  }
  return { ok: true, value: Object.fromEntries(entries) };
}

// Bound parsing and the later matching traversal of the validated filter tree.
const MAX_ATTRIBUTE_FILTER_DEPTH = 64;

function readAttributeFilter(
  value: unknown,
  depth = 0,
): { ok: true; value: AttributeFilter | null } | { ok: false; message: string } {
  if (depth > MAX_ATTRIBUTE_FILTER_DEPTH) {
    return {
      ok: false,
      message: `Invalid parameter: 'filters' nesting must not exceed ${MAX_ATTRIBUTE_FILTER_DEPTH} levels`,
    };
  }
  if (value === undefined) return { ok: true, value: null };
  const error = {
    ok: false,
    message:
      "Invalid parameter: 'filters' must be a comparison (eq, ne, gt, gte, lt, lte) with key and scalar value, or an and/or filter with an array of filters",
  } as const;
  if (!isJsonObject(value)) return error;
  const type = value["type"];
  if (type === "and" || type === "or") {
    if (!Array.isArray(value["filters"])) return error;
    const filters: AttributeFilter[] = [];
    for (const item of value["filters"]) {
      const child = readAttributeFilter(item, depth + 1);
      if (!child.ok) return child;
      if (child.value === null) return error;
      filters.push(child.value);
    }
    return { ok: true, value: { type, filters } };
  }
  const key = value["key"];
  const operand = value["value"];
  if (
    (type === "eq" ||
      type === "ne" ||
      type === "gt" ||
      type === "gte" ||
      type === "lt" ||
      type === "lte") &&
    typeof key === "string" &&
    isAttributeValue(operand)
  ) {
    return { ok: true, value: { type, key, value: operand } };
  }
  return error;
}

function matchesAttributeFilter(
  attributes: FileAttributes | null,
  filter: AttributeFilter,
): boolean {
  if (filter.type === "and")
    return filter.filters.every((child) => matchesAttributeFilter(attributes, child));
  if (filter.type === "or")
    return filter.filters.some((child) => matchesAttributeFilter(attributes, child));
  if (!("key" in filter) || attributes === null || !Object.hasOwn(attributes, filter.key))
    return false;
  const actual = attributes[filter.key];
  if (typeof actual !== typeof filter.value) return false;
  switch (filter.type) {
    case "eq":
      return actual === filter.value;
    case "ne":
      return actual !== filter.value;
    case "gt":
      return actual > filter.value;
    case "gte":
      return actual >= filter.value;
    case "lt":
      return actual < filter.value;
    case "lte":
      return actual <= filter.value;
  }
}

function readFileIds(
  value: unknown,
): { ok: true; value: string[] } | { ok: false; message: string } {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) {
    return { ok: false, message: "Invalid parameter: 'file_ids' must be an array of strings" };
  }
  if (value.length > 2000) {
    return { ok: false, message: "Invalid parameter: 'file_ids' must contain at most 2000 files" };
  }
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) {
      return { ok: false, message: "Invalid parameter: 'file_ids' must be an array of strings" };
    }
  }
  return { ok: true, value: value as string[] };
}

function readOutcome(
  req: http.IncomingMessage,
): { ok: true; value: VectorStoreFileStatus } | { ok: false; message: string } {
  const raw = req.headers[OUTCOME_HEADER];
  const text = (Array.isArray(raw) ? raw[0] : raw)?.trim().toLowerCase();
  if (text === undefined || text === "") return { ok: true, value: "completed" };
  if (!OUTCOMES.has(text)) {
    return {
      ok: false,
      message: `Invalid ${OUTCOME_HEADER} '${text}'. Expected one of: ${[...OUTCOMES].join(", ")}`,
    };
  }
  return { ok: true, value: text as VectorStoreFileStatus };
}

function queryParams(url: string | undefined): URLSearchParams {
  const target = url ?? "/";
  const start = target.indexOf("?");
  return new URLSearchParams(start === -1 ? "" : target.slice(start + 1));
}

function singleParam(
  params: URLSearchParams,
  name: string,
): { ok: true; value: string | null } | { ok: false; message: string } {
  const all = params.getAll(name);
  if (all.length > 1) {
    return {
      ok: false,
      message: `Invalid parameter: '${name}' was given ${all.length} times; it takes a single value`,
    };
  }
  return { ok: true, value: all.length === 0 ? null : all[0] };
}

export interface PageResult<T> {
  ok: boolean;
  page?: {
    object: "list";
    data: T[];
    first_id: string | null;
    last_id: string | null;
    has_more: boolean;
  };
  message?: string;
}

function paginateOrdered<T extends { id: string; created_at: number }>(
  itemsNewestFirst: T[],
  url: string | undefined,
): PageResult<T> {
  const params = queryParams(url);
  const readLimit = singleParam(params, "limit");
  if (!readLimit.ok) return { ok: false, message: readLimit.message };
  const readOrder = singleParam(params, "order");
  if (!readOrder.ok) return { ok: false, message: readOrder.message };
  const readAfter = singleParam(params, "after");
  if (!readAfter.ok) return { ok: false, message: readAfter.message };
  const readBefore = singleParam(params, "before");
  if (!readBefore.ok) return { ok: false, message: readBefore.message };
  let limit = DEFAULT_PAGE_LIMIT;
  if (readLimit.value !== null) {
    const n = parseStrictIntegerText(readLimit.value);
    if (n === null || n < 1 || n > MAX_PAGE_LIMIT) {
      return {
        ok: false,
        message: `Invalid parameter: 'limit' must be an integer between 1 and ${MAX_PAGE_LIMIT}, got '${readLimit.value}'`,
      };
    }
    limit = n;
  }
  const order = readOrder.value ?? "desc";
  if (order !== "asc" && order !== "desc") {
    return { ok: false, message: "Invalid parameter: 'order' must be 'asc' or 'desc'" };
  }
  if (readAfter.value !== null && readBefore.value !== null) {
    return { ok: false, message: "Invalid parameter: 'after' and 'before' are mutually exclusive" };
  }
  const ordered = order === "desc" ? itemsNewestFirst : [...itemsNewestFirst].reverse();
  let start = 0;
  if (readAfter.value !== null) {
    const idx = ordered.findIndex((it) => it.id === readAfter.value);
    if (idx === -1) {
      return {
        ok: false,
        message: `Invalid parameter: 'after' is not a known cursor: '${readAfter.value}'`,
      };
    }
    start = idx + 1;
  } else if (readBefore.value !== null) {
    const idx = ordered.findIndex((it) => it.id === readBefore.value);
    if (idx === -1) {
      return {
        ok: false,
        message: `Invalid parameter: 'before' is not a known cursor: '${readBefore.value}'`,
      };
    }
    start = Math.max(0, idx - limit);
    const data = ordered.slice(start, idx);
    return {
      ok: true,
      page: {
        object: "list",
        data,
        first_id: data[0]?.id ?? null,
        last_id: data[data.length - 1]?.id ?? null,
        has_more: start > 0,
      },
    };
  }
  const rest = ordered.slice(start);
  const data = rest.slice(0, limit);
  return {
    ok: true,
    page: {
      object: "list",
      data,
      first_id: data[0]?.id ?? null,
      last_id: data[data.length - 1]?.id ?? null,
      has_more: rest.length > limit,
    },
  };
}

function parseJsonBody(raw: string): { ok: true; value: unknown } | { ok: false; message: string } {
  if (raw.trim() === "") return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch (err) {
    return {
      ok: false,
      message: `Malformed JSON: ${err instanceof Error ? err.message : "unknown"}`,
    };
  }
}

function attachFile(
  store: VectorStoreObject,
  fileId: string,
  chunking: VectorStoreObject["chunking_strategy"],
  outcome: VectorStoreFileStatus,
  attributes: FileAttributes | null = null,
): VectorStoreFileObject {
  const bytes = getStoredFileBytes(fileId);
  const now = stamp();
  const entry: VectorStoreFileObject = {
    id: fileId,
    object: "vector_store.file",
    attributes,
    created_at: now,
    vector_store_id: store.id,
    status: "in_progress",
    usage_bytes: bytes?.length ?? 0,
    last_error: null,
  };
  if (chunking) {
    entry.chunking_strategy =
      chunking.type === "auto"
        ? {
            type: "static",
            static: { max_chunk_size_tokens: 800, chunk_overlap_tokens: 400 },
          }
        : chunking;
  }
  storeFiles.set(fileKey(store.id, fileId), entry);
  storePolls.set(fileKey(store.id, fileId), 0);
  fileOutcomes.set(fileKey(store.id, fileId), outcome);
  touch(store);
  return entry;
}

function advanceFile(entry: VectorStoreFileObject): VectorStoreFileObject {
  if (TERMINAL_FILE_STATUSES.has(entry.status)) return entry;
  const key = fileKey(entry.vector_store_id, entry.id);
  const polls = (storePolls.get(key) ?? 0) + 1;
  storePolls.set(key, polls);
  if (polls >= 2) {
    const outcome = fileOutcomes.get(key) ?? "completed";
    entry.status = outcome;
    if (outcome === "failed") {
      entry.last_error = {
        code: "mock_ingest_failed",
        message: "Mock ingestion failed for this file",
      };
    } else {
      entry.last_error = null;
    }
  }
  const store = stores.get(entry.vector_store_id);
  if (store) refreshStoreStatus(store);
  return entry;
}

function batchCounts(batchId: string): VectorFileBatchObject["file_counts"] {
  const members = batchMembers.get(batchId) ?? [];
  let inProgress = 0;
  let completed = 0;
  let failed = 0;
  let cancelled = 0;
  for (const entry of members) {
    if (entry.status === "in_progress") inProgress += 1;
    else if (entry.status === "completed") completed += 1;
    else if (entry.status === "failed") failed += 1;
    else cancelled += 1;
  }
  return { in_progress: inProgress, completed, failed, cancelled, total: members.length };
}

function advanceBatch(batch: VectorFileBatchObject): VectorFileBatchObject {
  if (TERMINAL_BATCH_STATUSES.has(batch.status)) {
    batch.file_counts = batchCounts(batch.id);
    return batch;
  }
  if (batch.status === "cancelling") {
    batch.status = "cancelled";
    for (const entry of batchMembers.get(batch.id) ?? []) {
      if (entry.status === "in_progress") entry.status = "cancelled";
    }
    batch.file_counts = batchCounts(batch.id);
    const store = stores.get(batch.vector_store_id);
    if (store) refreshStoreStatus(store);
    return batch;
  }
  const polls = (batchPolls.get(batch.id) ?? 0) + 1;
  batchPolls.set(batch.id, polls);
  if (polls === 1) {
    batch.status = "in_progress";
  } else {
    const outcome = batchOutcomes.get(batch.id) ?? "completed";
    batch.status = outcome;
    for (const entry of batchMembers.get(batch.id) ?? []) {
      if (entry.status === "in_progress") {
        entry.status = outcome === "completed" ? "completed" : outcome;
        if (outcome === "failed") {
          entry.last_error = {
            code: "mock_ingest_failed",
            message: "Mock ingestion failed for this file",
          };
        }
      }
    }
  }
  batch.file_counts = batchCounts(batch.id);
  const store = stores.get(batch.vector_store_id);
  if (store) refreshStoreStatus(store);
  return batch;
}

function scoreFor(query: string, fileId: string): number {
  let h = 2166136261;
  const text = `${query}::${fileId}`;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

export async function handleVectorStoresCreate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  raw: string,
  journal: Journal,
  defaults: Defaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  const path = req.url ?? "/v1/vector_stores";
  const method = req.method ?? "POST";
  if (await chaosHit(req, journal, defaults, method, path, res, setCorsHeaders)) return;
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) {
    journalVs(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(res, 400, invalid(parsed.message), setCorsHeaders);
    return;
  }
  if (!isJsonObject(parsed.value)) {
    journalVs(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(res, 400, invalid("Request body must be a JSON object"), setCorsHeaders);
    return;
  }
  const body = parsed.value;
  if (body["name"] !== undefined && typeof body["name"] !== "string") {
    journalVs(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(res, 400, invalid("Invalid parameter: 'name' must be a string"), setCorsHeaders);
    return;
  }
  const metadata = readMetadata(body["metadata"]);
  if (!metadata.ok) {
    journalVs(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(res, 400, invalid(metadata.message), setCorsHeaders);
    return;
  }
  const expires = readExpiresAfter(body["expires_after"]);
  if (!expires.ok) {
    journalVs(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(res, 400, invalid(expires.message), setCorsHeaders);
    return;
  }
  const chunking = readChunkingStrategy(body["chunking_strategy"]);
  if (!chunking.ok) {
    journalVs(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(res, 400, invalid(chunking.message), setCorsHeaders);
    return;
  }
  const fileIds = readFileIds(body["file_ids"]);
  if (!fileIds.ok) {
    journalVs(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(res, 400, invalid(fileIds.message), setCorsHeaders);
    return;
  }
  for (const fileId of fileIds.value) {
    if (getStoredFileBytes(fileId) === undefined) {
      journalVs(journal, method, path, flattenHeaders(req.headers), 404);
      writeJson(res, 404, invalid(`No such file: ${fileId}`), setCorsHeaders);
      return;
    }
  }
  const outcome = readOutcome(req);
  if (!outcome.ok) {
    journalVs(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(res, 400, invalid(outcome.message), setCorsHeaders);
    return;
  }
  const now = stamp();
  const id = underscoreId("vs");
  const store: VectorStoreObject = {
    id,
    object: "vector_store",
    created_at: now,
    name: typeof body["name"] === "string" ? body["name"] : `vector-store-${id.slice(3, 9)}`,
    usage_bytes: 0,
    file_counts: { in_progress: 0, completed: 0, failed: 0, cancelled: 0, total: 0 },
    status: "completed",
    metadata: metadata.value,
    last_active_at: now,
    expires_at: null,
  };
  if (expires.value) {
    store.expires_after = expires.value;
    store.expires_at = now + expires.value.days * 86400;
  }
  if (chunking.value) store.chunking_strategy = chunking.value;
  stores.set(id, store);
  for (const fileId of fileIds.value) {
    attachFile(store, fileId, chunking.value ?? undefined, outcome.value);
  }
  refreshStoreStatus(store);
  defaults.logger.debug(`Vector stores mock: created ${id}`);
  journalVs(journal, method, path, flattenHeaders(req.headers), 200);
  writeJson(res, 200, store, setCorsHeaders);
}

export async function handleVectorStoresList(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  journal: Journal,
  defaults: Defaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  const path = req.url ?? "/v1/vector_stores";
  const method = req.method ?? "GET";
  if (await chaosHit(req, journal, defaults, method, path, res, setCorsHeaders)) return;
  for (const store of stores.values()) refreshStoreStatus(store);
  const data = [...stores.values()].reverse();
  const result = paginateOrdered(data, req.url);
  if (!result.ok || !result.page) {
    journalVs(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(res, 400, invalid(result.message ?? "Invalid pagination"), setCorsHeaders);
    return;
  }
  journalVs(journal, method, path, flattenHeaders(req.headers), 200);
  writeJson(res, 200, result.page, setCorsHeaders);
}

export async function handleVectorStoresRetrieve(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  storeId: string,
  journal: Journal,
  defaults: Defaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  const path = req.url ?? `/v1/vector_stores/${storeId}`;
  const method = req.method ?? "GET";
  if (await chaosHit(req, journal, defaults, method, path, res, setCorsHeaders)) return;
  const store = stores.get(storeId);
  if (!store) {
    journalVs(journal, method, path, flattenHeaders(req.headers), 404);
    writeJson(res, 404, invalid(`No such vector store: ${storeId}`), setCorsHeaders);
    return;
  }
  touch(store);
  journalVs(journal, method, path, flattenHeaders(req.headers), 200);
  writeJson(res, 200, store, setCorsHeaders);
}

export async function handleVectorStoresModify(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  storeId: string,
  raw: string,
  journal: Journal,
  defaults: Defaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  const path = req.url ?? `/v1/vector_stores/${storeId}`;
  const method = req.method ?? "POST";
  if (await chaosHit(req, journal, defaults, method, path, res, setCorsHeaders)) return;
  const store = stores.get(storeId);
  if (!store) {
    journalVs(journal, method, path, flattenHeaders(req.headers), 404);
    writeJson(res, 404, invalid(`No such vector store: ${storeId}`), setCorsHeaders);
    return;
  }
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) {
    journalVs(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(res, 400, invalid(parsed.message), setCorsHeaders);
    return;
  }
  if (!isJsonObject(parsed.value)) {
    journalVs(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(res, 400, invalid("Request body must be a JSON object"), setCorsHeaders);
    return;
  }
  const body = parsed.value;
  let name = store.name;
  let metadata = store.metadata;
  let expiresAfter = store.expires_after;
  if (body["name"] !== undefined) {
    if (body["name"] !== null && typeof body["name"] !== "string") {
      journalVs(journal, method, path, flattenHeaders(req.headers), 400);
      writeJson(
        res,
        400,
        invalid("Invalid parameter: 'name' must be a string or null"),
        setCorsHeaders,
      );
      return;
    }
    name = body["name"] ?? "";
  }
  if (body["metadata"] !== undefined) {
    const parsedMetadata = readMetadata(body["metadata"]);
    if (!parsedMetadata.ok) {
      journalVs(journal, method, path, flattenHeaders(req.headers), 400);
      writeJson(res, 400, invalid(parsedMetadata.message), setCorsHeaders);
      return;
    }
    metadata = parsedMetadata.value;
  }
  if (body["expires_after"] !== undefined) {
    if (body["expires_after"] === null) {
      expiresAfter = undefined;
    } else {
      const expires = readExpiresAfter(body["expires_after"]);
      if (!expires.ok) {
        journalVs(journal, method, path, flattenHeaders(req.headers), 400);
        writeJson(res, 400, invalid(expires.message), setCorsHeaders);
        return;
      }
      if (expires.value) {
        expiresAfter = expires.value;
      }
    }
  }
  // Commit only after every supplied field has passed validation.
  store.name = name;
  store.metadata = metadata;
  if (body["expires_after"] !== undefined) {
    if (expiresAfter) {
      store.expires_after = expiresAfter;
      store.expires_at = stamp() + expiresAfter.days * 86400;
    } else {
      delete store.expires_after;
      store.expires_at = null;
    }
  }
  touch(store);
  journalVs(journal, method, path, flattenHeaders(req.headers), 200);
  writeJson(res, 200, store, setCorsHeaders);
}

export async function handleVectorStoresDelete(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  storeId: string,
  journal: Journal,
  defaults: Defaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  const path = req.url ?? `/v1/vector_stores/${storeId}`;
  const method = req.method ?? "DELETE";
  if (await chaosHit(req, journal, defaults, method, path, res, setCorsHeaders)) return;
  const store = stores.get(storeId);
  if (!store) {
    journalVs(journal, method, path, flattenHeaders(req.headers), 404);
    writeJson(res, 404, invalid(`No such vector store: ${storeId}`), setCorsHeaders);
    return;
  }
  stores.delete(storeId);
  for (const key of [...storeFiles.keys()]) {
    if (key.startsWith(`${storeId}:`)) {
      storeFiles.delete(key);
      storePolls.delete(key);
      fileOutcomes.delete(key);
    }
  }
  for (const [batchId, batch] of [...fileBatches.entries()]) {
    if (batch.vector_store_id === storeId) {
      fileBatches.delete(batchId);
      batchPolls.delete(batchId);
      batchOutcomes.delete(batchId);
      batchMembers.delete(batchId);
    }
  }
  journalVs(journal, method, path, flattenHeaders(req.headers), 200);
  writeJson(
    res,
    200,
    { id: storeId, object: "vector_store.deleted", deleted: true },
    setCorsHeaders,
  );
}

export async function handleVectorStoreFilesCreate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  storeId: string,
  raw: string,
  journal: Journal,
  defaults: Defaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  const path = req.url ?? `/v1/vector_stores/${storeId}/files`;
  const method = req.method ?? "POST";
  if (await chaosHit(req, journal, defaults, method, path, res, setCorsHeaders)) return;
  const store = stores.get(storeId);
  if (!store) {
    journalVs(journal, method, path, flattenHeaders(req.headers), 404);
    writeJson(res, 404, invalid(`No such vector store: ${storeId}`), setCorsHeaders);
    return;
  }
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) {
    journalVs(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(res, 400, invalid(parsed.message), setCorsHeaders);
    return;
  }
  if (!isJsonObject(parsed.value)) {
    journalVs(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(res, 400, invalid("Request body must be a JSON object"), setCorsHeaders);
    return;
  }
  const fileId = parsed.value["file_id"];
  if (typeof fileId !== "string" || fileId.length === 0) {
    journalVs(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(
      res,
      400,
      invalid("Invalid parameter: 'file_id' must be a non-empty string"),
      setCorsHeaders,
    );
    return;
  }
  if (getStoredFileBytes(fileId) === undefined) {
    journalVs(journal, method, path, flattenHeaders(req.headers), 404);
    writeJson(res, 404, invalid(`No such file: ${fileId}`), setCorsHeaders);
    return;
  }
  if (storeFiles.has(fileKey(storeId, fileId))) {
    journalVs(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(
      res,
      400,
      invalid(`File ${fileId} is already attached to vector store ${storeId}`),
      setCorsHeaders,
    );
    return;
  }
  const chunking = readChunkingStrategy(parsed.value["chunking_strategy"]);
  if (!chunking.ok) {
    journalVs(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(res, 400, invalid(chunking.message), setCorsHeaders);
    return;
  }
  const attributes = readAttributes(parsed.value["attributes"]);
  if (!attributes.ok) {
    journalVs(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(res, 400, invalid(attributes.message), setCorsHeaders);
    return;
  }
  const outcome = readOutcome(req);
  if (!outcome.ok) {
    journalVs(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(res, 400, invalid(outcome.message), setCorsHeaders);
    return;
  }
  const entry = attachFile(
    store,
    fileId,
    chunking.value ?? undefined,
    outcome.value,
    attributes.value,
  );
  journalVs(journal, method, path, flattenHeaders(req.headers), 200);
  writeJson(res, 200, entry, setCorsHeaders);
}

export async function handleVectorStoreFilesList(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  storeId: string,
  journal: Journal,
  defaults: Defaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  const path = req.url ?? `/v1/vector_stores/${storeId}/files`;
  const method = req.method ?? "GET";
  if (await chaosHit(req, journal, defaults, method, path, res, setCorsHeaders)) return;
  const store = stores.get(storeId);
  if (!store) {
    journalVs(journal, method, path, flattenHeaders(req.headers), 404);
    writeJson(res, 404, invalid(`No such vector store: ${storeId}`), setCorsHeaders);
    return;
  }
  const params = queryParams(req.url);
  const readFilter = singleParam(params, "filter");
  if (!readFilter.ok) {
    journalVs(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(res, 400, invalid(readFilter.message), setCorsHeaders);
    return;
  }
  if (
    readFilter.value !== null &&
    !TERMINAL_FILE_STATUSES.has(readFilter.value as VectorStoreFileStatus) &&
    readFilter.value !== "in_progress"
  ) {
    journalVs(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(
      res,
      400,
      invalid(
        "Invalid parameter: 'filter' must be 'in_progress', 'completed', 'failed' or 'cancelled'",
      ),
      setCorsHeaders,
    );
    return;
  }
  let data = [...storeFiles.values()]
    .filter((f) => f.vector_store_id === storeId)
    .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1));
  if (readFilter.value !== null) data = data.filter((f) => f.status === readFilter.value);
  const result = paginateOrdered(data, req.url);
  if (!result.ok || !result.page) {
    journalVs(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(res, 400, invalid(result.message ?? "Invalid pagination"), setCorsHeaders);
    return;
  }
  journalVs(journal, method, path, flattenHeaders(req.headers), 200);
  writeJson(res, 200, result.page, setCorsHeaders);
}

export async function handleVectorStoreFilesRetrieve(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  storeId: string,
  fileId: string,
  journal: Journal,
  defaults: Defaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  const path = req.url ?? `/v1/vector_stores/${storeId}/files/${fileId}`;
  const method = req.method ?? "GET";
  if (await chaosHit(req, journal, defaults, method, path, res, setCorsHeaders)) return;
  if (!stores.has(storeId)) {
    journalVs(journal, method, path, flattenHeaders(req.headers), 404);
    writeJson(res, 404, invalid(`No such vector store: ${storeId}`), setCorsHeaders);
    return;
  }
  const entry = storeFiles.get(fileKey(storeId, fileId));
  if (!entry) {
    journalVs(journal, method, path, flattenHeaders(req.headers), 404);
    writeJson(res, 404, invalid(`No such vector store file: ${fileId}`), setCorsHeaders);
    return;
  }
  journalVs(journal, method, path, flattenHeaders(req.headers), 200);
  writeJson(res, 200, advanceFile(entry), setCorsHeaders);
}

export async function handleVectorStoreFilesDelete(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  storeId: string,
  fileId: string,
  journal: Journal,
  defaults: Defaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  const path = req.url ?? `/v1/vector_stores/${storeId}/files/${fileId}`;
  const method = req.method ?? "DELETE";
  if (await chaosHit(req, journal, defaults, method, path, res, setCorsHeaders)) return;
  const store = stores.get(storeId);
  if (!store) {
    journalVs(journal, method, path, flattenHeaders(req.headers), 404);
    writeJson(res, 404, invalid(`No such vector store: ${storeId}`), setCorsHeaders);
    return;
  }
  const key = fileKey(storeId, fileId);
  if (!storeFiles.has(key)) {
    journalVs(journal, method, path, flattenHeaders(req.headers), 404);
    writeJson(res, 404, invalid(`No such vector store file: ${fileId}`), setCorsHeaders);
    return;
  }
  storeFiles.delete(key);
  storePolls.delete(key);
  fileOutcomes.delete(key);
  touch(store);
  journalVs(journal, method, path, flattenHeaders(req.headers), 200);
  writeJson(
    res,
    200,
    { id: fileId, object: "vector_store.file.deleted", deleted: true },
    setCorsHeaders,
  );
}

export async function handleVectorFileBatchesCreate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  storeId: string,
  raw: string,
  journal: Journal,
  defaults: Defaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  const path = req.url ?? `/v1/vector_stores/${storeId}/file_batches`;
  const method = req.method ?? "POST";
  if (await chaosHit(req, journal, defaults, method, path, res, setCorsHeaders)) return;
  const store = stores.get(storeId);
  if (!store) {
    journalVs(journal, method, path, flattenHeaders(req.headers), 404);
    writeJson(res, 404, invalid(`No such vector store: ${storeId}`), setCorsHeaders);
    return;
  }
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) {
    journalVs(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(res, 400, invalid(parsed.message), setCorsHeaders);
    return;
  }
  if (!isJsonObject(parsed.value)) {
    journalVs(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(res, 400, invalid("Request body must be a JSON object"), setCorsHeaders);
    return;
  }
  const fileIds = readFileIds(parsed.value["file_ids"]);
  if (!fileIds.ok) {
    journalVs(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(res, 400, invalid(fileIds.message), setCorsHeaders);
    return;
  }
  if (fileIds.value.length === 0) {
    journalVs(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(
      res,
      400,
      invalid("Invalid parameter: 'file_ids' must contain at least one file"),
      setCorsHeaders,
    );
    return;
  }
  if (new Set(fileIds.value).size !== fileIds.value.length) {
    journalVs(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(
      res,
      400,
      invalid("Invalid parameter: 'file_ids' must not contain duplicate file IDs"),
      setCorsHeaders,
    );
    return;
  }
  const chunking = readChunkingStrategy(parsed.value["chunking_strategy"]);
  if (!chunking.ok) {
    journalVs(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(res, 400, invalid(chunking.message), setCorsHeaders);
    return;
  }
  for (const fileId of fileIds.value) {
    if (getStoredFileBytes(fileId) === undefined) {
      journalVs(journal, method, path, flattenHeaders(req.headers), 404);
      writeJson(res, 404, invalid(`No such file: ${fileId}`), setCorsHeaders);
      return;
    }
  }
  const attributes = readAttributes(parsed.value["attributes"]);
  if (!attributes.ok) {
    journalVs(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(res, 400, invalid(attributes.message), setCorsHeaders);
    return;
  }
  const outcome = readOutcome(req);
  if (!outcome.ok) {
    journalVs(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(res, 400, invalid(outcome.message), setCorsHeaders);
    return;
  }
  const id = underscoreId("vsfb");
  const batch: VectorFileBatchObject = {
    id,
    object: "vector_store.file_batch",
    created_at: stamp(),
    vector_store_id: storeId,
    status: "in_progress",
    file_counts: {
      in_progress: fileIds.value.length,
      completed: 0,
      failed: 0,
      cancelled: 0,
      total: fileIds.value.length,
    },
  };
  fileBatches.set(id, batch);
  batchPolls.set(id, 0);
  batchOutcomes.set(id, outcome.value);
  const members: VectorStoreFileObject[] = [];
  for (const fileId of fileIds.value) {
    const entry =
      storeFiles.get(fileKey(storeId, fileId)) ??
      attachFile(store, fileId, chunking.value ?? undefined, outcome.value, attributes.value);
    members.push(entry);
  }
  batchMembers.set(id, members);
  batch.file_counts = batchCounts(id);
  refreshStoreStatus(store);
  journalVs(journal, method, path, flattenHeaders(req.headers), 200);
  writeJson(res, 200, batch, setCorsHeaders);
}

export async function handleVectorFileBatchesRetrieve(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  storeId: string,
  batchId: string,
  journal: Journal,
  defaults: Defaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  const path = req.url ?? `/v1/vector_stores/${storeId}/file_batches/${batchId}`;
  const method = req.method ?? "GET";
  if (await chaosHit(req, journal, defaults, method, path, res, setCorsHeaders)) return;
  if (!stores.has(storeId)) {
    journalVs(journal, method, path, flattenHeaders(req.headers), 404);
    writeJson(res, 404, invalid(`No such vector store: ${storeId}`), setCorsHeaders);
    return;
  }
  const batch = fileBatches.get(batchId);
  if (!batch || batch.vector_store_id !== storeId) {
    journalVs(journal, method, path, flattenHeaders(req.headers), 404);
    writeJson(res, 404, invalid(`No such file batch: ${batchId}`), setCorsHeaders);
    return;
  }
  journalVs(journal, method, path, flattenHeaders(req.headers), 200);
  writeJson(res, 200, advanceBatch(batch), setCorsHeaders);
}

export async function handleVectorFileBatchesCancel(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  storeId: string,
  batchId: string,
  journal: Journal,
  defaults: Defaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  const path = req.url ?? `/v1/vector_stores/${storeId}/file_batches/${batchId}/cancel`;
  const method = req.method ?? "POST";
  if (await chaosHit(req, journal, defaults, method, path, res, setCorsHeaders)) return;
  if (!stores.has(storeId)) {
    journalVs(journal, method, path, flattenHeaders(req.headers), 404);
    writeJson(res, 404, invalid(`No such vector store: ${storeId}`), setCorsHeaders);
    return;
  }
  const batch = fileBatches.get(batchId);
  if (!batch || batch.vector_store_id !== storeId) {
    journalVs(journal, method, path, flattenHeaders(req.headers), 404);
    writeJson(res, 404, invalid(`No such file batch: ${batchId}`), setCorsHeaders);
    return;
  }
  if (TERMINAL_BATCH_STATUSES.has(batch.status)) {
    journalVs(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(
      res,
      400,
      invalid(`Cannot cancel a file batch with status ${batch.status}.`),
      setCorsHeaders,
    );
    return;
  }
  if (batch.status !== "cancelling") batch.status = "cancelling";
  batch.file_counts = batchCounts(batch.id);
  journalVs(journal, method, path, flattenHeaders(req.headers), 200);
  writeJson(res, 200, batch, setCorsHeaders);
}

export async function handleVectorFileBatchesFiles(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  storeId: string,
  batchId: string,
  journal: Journal,
  defaults: Defaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  const path = req.url ?? `/v1/vector_stores/${storeId}/file_batches/${batchId}/files`;
  const method = req.method ?? "GET";
  if (await chaosHit(req, journal, defaults, method, path, res, setCorsHeaders)) return;
  if (!stores.has(storeId)) {
    journalVs(journal, method, path, flattenHeaders(req.headers), 404);
    writeJson(res, 404, invalid(`No such vector store: ${storeId}`), setCorsHeaders);
    return;
  }
  const batch = fileBatches.get(batchId);
  if (!batch || batch.vector_store_id !== storeId) {
    journalVs(journal, method, path, flattenHeaders(req.headers), 404);
    writeJson(res, 404, invalid(`No such file batch: ${batchId}`), setCorsHeaders);
    return;
  }
  const params = queryParams(req.url);
  const readFilter = singleParam(params, "filter");
  if (!readFilter.ok) {
    journalVs(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(res, 400, invalid(readFilter.message), setCorsHeaders);
    return;
  }
  if (
    readFilter.value !== null &&
    !TERMINAL_FILE_STATUSES.has(readFilter.value as VectorStoreFileStatus) &&
    readFilter.value !== "in_progress"
  ) {
    journalVs(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(
      res,
      400,
      invalid(
        "Invalid parameter: 'filter' must be 'in_progress', 'completed', 'failed' or 'cancelled'",
      ),
      setCorsHeaders,
    );
    return;
  }
  const members = batchMembers.get(batchId) ?? [];
  let data = [...members].sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1));
  if (readFilter.value !== null) data = data.filter((f) => f.status === readFilter.value);
  const result = paginateOrdered(data, req.url);
  if (!result.ok || !result.page) {
    journalVs(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(res, 400, invalid(result.message ?? "Invalid pagination"), setCorsHeaders);
    return;
  }
  journalVs(journal, method, path, flattenHeaders(req.headers), 200);
  writeJson(res, 200, result.page, setCorsHeaders);
}

export async function handleVectorStoresSearch(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  storeId: string,
  raw: string,
  journal: Journal,
  defaults: Defaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  const path = req.url ?? `/v1/vector_stores/${storeId}/search`;
  const method = req.method ?? "POST";
  if (await chaosHit(req, journal, defaults, method, path, res, setCorsHeaders)) return;
  const store = stores.get(storeId);
  if (!store) {
    journalVs(journal, method, path, flattenHeaders(req.headers), 404);
    writeJson(res, 404, invalid(`No such vector store: ${storeId}`), setCorsHeaders);
    return;
  }
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) {
    journalVs(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(res, 400, invalid(parsed.message), setCorsHeaders);
    return;
  }
  if (!isJsonObject(parsed.value)) {
    journalVs(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(res, 400, invalid("Request body must be a JSON object"), setCorsHeaders);
    return;
  }
  const body = parsed.value;
  const query = body["query"];
  const queries = typeof query === "string" ? [query] : query;
  if (
    !Array.isArray(queries) ||
    queries.length === 0 ||
    !queries.every((entry) => typeof entry === "string" && entry.length > 0)
  ) {
    journalVs(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(
      res,
      400,
      invalid(
        "Invalid parameter: 'query' must be a non-empty string or a non-empty array of non-empty strings",
      ),
      setCorsHeaders,
    );
    return;
  }
  // Preserve string ranking; arrays use their entries joined in request order.
  const normalizedQuery = queries.join("\n");
  let maxResults = 10;
  if (body["max_num_results"] !== undefined) {
    const n = body["max_num_results"];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 50) {
      journalVs(journal, method, path, flattenHeaders(req.headers), 400);
      writeJson(
        res,
        400,
        invalid("Invalid parameter: 'max_num_results' must be an integer between 1 and 50"),
        setCorsHeaders,
      );
      return;
    }
    maxResults = n;
  }
  let threshold = 0;
  if (body["ranking_options"] !== undefined) {
    if (!isJsonObject(body["ranking_options"])) {
      journalVs(journal, method, path, flattenHeaders(req.headers), 400);
      writeJson(
        res,
        400,
        invalid("Invalid parameter: 'ranking_options' must be an object"),
        setCorsHeaders,
      );
      return;
    }
    const score = body["ranking_options"]["score_threshold"];
    if (score !== undefined) {
      if (typeof score !== "number" || score < 0 || score > 1) {
        journalVs(journal, method, path, flattenHeaders(req.headers), 400);
        writeJson(
          res,
          400,
          invalid(
            "Invalid parameter: 'ranking_options.score_threshold' must be a number between 0 and 1",
          ),
          setCorsHeaders,
        );
        return;
      }
      threshold = score;
    }
  }
  const filters = readAttributeFilter(body["filters"]);
  if (!filters.ok) {
    journalVs(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(res, 400, invalid(filters.message), setCorsHeaders);
    return;
  }
  const completed = [...storeFiles.values()].filter(
    (f) =>
      f.vector_store_id === storeId &&
      f.status === "completed" &&
      (filters.value === null || matchesAttributeFilter(f.attributes, filters.value)),
  );
  const ranked: VectorSearchResult[] = completed
    .map((f) => ({ file: f, score: scoreFor(normalizedQuery, f.id) }))
    .filter((entry) => entry.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map((entry) => ({
      file_id: entry.file.id,
      attributes: entry.file.attributes,
      filename: getStoredFileName(entry.file.id) ?? `file-${entry.file.id.slice(0, 8)}.txt`,
      score: Math.round(entry.score * 10000) / 10000,
      content: [
        {
          type: "text" as const,
          text: `Mock chunk from ${entry.file.id} answering "${normalizedQuery.slice(0, 120)}"`,
        },
      ],
    }));
  touch(store);
  journalVs(journal, method, path, flattenHeaders(req.headers), 200);
  writeJson(
    res,
    200,
    {
      object: "vector_store.search_results_page",
      search_query: query,
      data: ranked,
      has_more: false,
    },
    setCorsHeaders,
  );
}
