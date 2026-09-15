/**
 * OpenAI Files API mock for aimock.
 *
 * Implements the subset of `POST /v1/files`, `GET /v1/files`,
 * `GET /v1/files/{id}`, `GET /v1/files/{id}/content` and
 * `DELETE /v1/files/{id}` that test harnesses need to exercise
 * file-upload flows without touching the real API.
 *
 * Storage is in-memory and per-process (like the video job maps):
 * - metadata lives in `fileStore`
 * - raw bytes live in `fileContents` (capped per file so a huge upload
 *   cannot OOM a long-running mock)
 * - `clearFileStore()` wipes both and is wired into the full reset path
 *   (`POST /__aimock/reset` + `LLMock.reset()`)
 *
 * Body handling accepts both shapes real SDKs send:
 * - JSON `{ filename, purpose, content?, bytes? }` (test-friendly)
 * - `multipart/form-data` with `purpose` + `file` fields (OpenAI SDK shape,
 *   parsed with the shared transcription multipart helpers)
 *
 * Every branch journals with `service: "files"` so
 * `GET /__aimock/journal?service=files` selects exactly this traffic,
 * honors the inbound API-key boundary via the server dispatch (no bypass),
 * and runs through the chaos gate so retry/backoff suites can inject
 * 500s at the files surface too.
 */

import type * as http from "node:http";
import { flattenHeaders, generateId, isJsonObject } from "./helpers.js";
import { extractBoundary, extractFormField } from "./transcription.js";
import { applyChaos } from "./chaos.js";
import type { ChaosDefaults } from "./types.js";
import type { Journal } from "./journal.js";
import type { Logger } from "./logger.js";
import type { MetricsRegistry } from "./metrics.js";

export interface FileObject {
  id: string;
  object: "file";
  bytes: number;
  created_at: number;
  filename: string;
  purpose: string;
  status: "uploaded" | "processed" | "pending" | "error";
  status_details?: string;
}

const VALID_PURPOSES = new Set([
  "fine-tune",
  "fine-tune-results",
  "assistants",
  "assistants_output",
  "batch",
  "batch_output",
  "vision",
]);

export const FILES_MAX_BYTES = 10 * 1024 * 1024;

const fileStore = new Map<string, FileObject>();
const fileContents = new Map<string, string>();

export function clearFileStore(): void {
  fileStore.clear();
  fileContents.clear();
}

export function getFileStoreSize(): number {
  return fileStore.size;
}

function journalFiles(
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
    service: "files",
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

function invalidRequest(message: string): { error: { message: string; type: string } } {
  return { error: { message, type: "invalid_request_error" } };
}

interface ParsedUpload {
  filename: string;
  purpose: string;
  content: string;
}

function parseJsonUpload(raw: string): ParsedUpload | { error: string } {
  let body: unknown;
  try {
    body = JSON.parse(raw) as unknown;
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unknown";
    return { error: `Malformed JSON: ${detail}` };
  }
  if (!isJsonObject(body)) {
    return { error: "Request body must be a JSON object" };
  }
  const filename = body["filename"];
  const purpose = body["purpose"];
  const content = body["content"] ?? body["bytes"] ?? "";
  if (typeof filename !== "string" || filename.length === 0) {
    return { error: "Invalid parameter: 'filename' must be a non-empty string" };
  }
  if (typeof purpose !== "string" || purpose.length === 0) {
    return { error: "Invalid parameter: 'purpose' must be a non-empty string" };
  }
  if (!VALID_PURPOSES.has(purpose)) {
    return {
      error: `Invalid purpose '${purpose}'. Expected one of: ${[...VALID_PURPOSES].join(", ")}`,
    };
  }
  const text = typeof content === "string" ? content : String(content ?? "");
  if (Buffer.byteLength(text, "utf8") > FILES_MAX_BYTES) {
    return { error: `File content exceeds ${FILES_MAX_BYTES} byte cap` };
  }
  return { filename, purpose, content: text };
}

function parseMultipartUpload(
  raw: string,
  contentType: string | undefined,
): ParsedUpload | { error: string } {
  const boundary = extractBoundary(contentType);
  // NOTE: we parse parts locally instead of reusing `extractFormField` for
  // the `file` part: that helper's `name="([^"]+)"` match is greedy across
  // the whole Content-Disposition line, so `name="file"; filename="mp.jsonl"`
  // captures `mp.jsonl` (via `filename="`) instead of `file`. Here `name` and
  // `filename` are captured independently.
  const delimiter = boundary ? `--${boundary}` : undefined;
  const chunks = delimiter ? raw.split(delimiter) : [raw];
  let purpose: string | undefined;
  let filename: string | undefined;
  let fileBody = "";
  for (const part of chunks) {
    if (!part || part.trimStart().startsWith("--")) continue;
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;
    const headers = part.slice(0, headerEnd);
    const body = part.slice(headerEnd + 4).replace(/\r\n$/, "");
    const nameMatch = headers.match(/[;\s]name="([^"]+)"/i);
    const fileNameMatch = headers.match(/[;\s]filename="([^"]+)"/i);
    const fieldName = nameMatch?.[1];
    if (fieldName === "purpose") purpose = body.trim();
    if (fieldName === "file" || fieldName === "content") {
      fileBody = body;
      if (fileNameMatch?.[1]) filename = fileNameMatch[1];
    }
  }
  // Fall back to the shared helper for boundary-less bodies (best-effort).
  if (purpose === undefined) {
    purpose = extractFormField(raw, "purpose", boundary)?.trim();
  }
  if (!purpose) {
    return { error: "Invalid parameter: multipart 'purpose' field is required" };
  }
  if (!VALID_PURPOSES.has(purpose)) {
    return {
      error: `Invalid purpose '${purpose}'. Expected one of: ${[...VALID_PURPOSES].join(", ")}`,
    };
  }
  if (!filename) {
    // Fall back to a deterministic name so SDKs that omit filename still work.
    filename = `upload-${Date.now()}.bin`;
  }
  if (Buffer.byteLength(fileBody, "utf8") > FILES_MAX_BYTES) {
    return { error: `File content exceeds ${FILES_MAX_BYTES} byte cap` };
  }
  return { filename, purpose, content: fileBody };
}

export async function handleFilesCreate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  raw: string,
  journal: Journal,
  defaults: {
    logger: Logger;
    chaos?: ChaosDefaults;
    registry?: MetricsRegistry;
  },
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  const path = req.url ?? "/v1/files";
  const method = req.method ?? "POST";
  setCorsHeaders(res);

  if (
    applyChaos(
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
      },
      "internal",
      defaults.registry,
      defaults.logger,
    )
  ) {
    return;
  }

  const contentType = Array.isArray(req.headers["content-type"])
    ? req.headers["content-type"][0]
    : req.headers["content-type"];
  const isMultipart = (contentType ?? "").toLowerCase().includes("multipart/form-data");

  const parsed = isMultipart ? parseMultipartUpload(raw, contentType) : parseJsonUpload(raw);

  if ("error" in parsed) {
    journalFiles(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(res, 400, invalidRequest(parsed.error), setCorsHeaders);
    return;
  }

  const id = generateId("file");
  const bytes = Buffer.byteLength(parsed.content, "utf8");
  const obj: FileObject = {
    id,
    object: "file",
    bytes,
    created_at: Math.floor(Date.now() / 1000),
    filename: parsed.filename,
    purpose: parsed.purpose,
    status: "processed",
  };
  fileStore.set(id, obj);
  fileContents.set(id, parsed.content);

  defaults.logger.debug(`Files mock: stored ${id} (${parsed.filename}, ${bytes} bytes)`);
  journalFiles(journal, method, path, flattenHeaders(req.headers), 200);
  writeJson(res, 200, obj, setCorsHeaders);
}

export async function handleFilesList(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  journal: Journal,
  defaults: { logger: Logger; chaos?: ChaosDefaults; registry?: MetricsRegistry },
  setCorsHeaders: (res: http.ServerResponse) => void,
  purposeFilter?: string,
): Promise<void> {
  const path = req.url ?? "/v1/files";
  const method = req.method ?? "GET";
  setCorsHeaders(res);

  if (
    applyChaos(
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
    )
  ) {
    return;
  }

  let data = [...fileStore.values()];
  if (purposeFilter) {
    data = data.filter((f) => f.purpose === purposeFilter);
  }
  data.sort((a, b) => a.created_at - b.created_at);
  journalFiles(journal, method, path, flattenHeaders(req.headers), 200);
  writeJson(res, 200, { object: "list", data }, setCorsHeaders);
}

export async function handleFilesRetrieve(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  fileId: string,
  journal: Journal,
  defaults: { logger: Logger; chaos?: ChaosDefaults; registry?: MetricsRegistry },
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  const path = req.url ?? `/v1/files/${fileId}`;
  const method = req.method ?? "GET";

  if (
    applyChaos(
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
    )
  ) {
    return;
  }

  const found = fileStore.get(fileId);
  if (!found) {
    journalFiles(journal, method, path, flattenHeaders(req.headers), 404);
    writeJson(res, 404, invalidRequest(`No such file: ${fileId}`), setCorsHeaders);
    return;
  }
  journalFiles(journal, method, path, flattenHeaders(req.headers), 200);
  writeJson(res, 200, found, setCorsHeaders);
}

export async function handleFilesContent(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  fileId: string,
  journal: Journal,
  defaults: { logger: Logger; chaos?: ChaosDefaults; registry?: MetricsRegistry },
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  const path = req.url ?? `/v1/files/${fileId}/content`;
  const method = req.method ?? "GET";

  if (
    applyChaos(
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
    )
  ) {
    return;
  }

  const found = fileStore.get(fileId);
  const content = fileContents.get(fileId);
  if (!found || content === undefined) {
    journalFiles(journal, method, path, flattenHeaders(req.headers), 404);
    writeJson(res, 404, invalidRequest(`No such file: ${fileId}`), setCorsHeaders);
    return;
  }
  journalFiles(journal, method, path, flattenHeaders(req.headers), 200);
  setCorsHeaders(res);
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(content);
}

export async function handleFilesDelete(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  fileId: string,
  journal: Journal,
  defaults: { logger: Logger; chaos?: ChaosDefaults; registry?: MetricsRegistry },
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  const path = req.url ?? `/v1/files/${fileId}`;
  const method = req.method ?? "DELETE";

  if (
    applyChaos(
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
    )
  ) {
    return;
  }

  const found = fileStore.get(fileId);
  if (!found) {
    journalFiles(journal, method, path, flattenHeaders(req.headers), 404);
    writeJson(res, 404, invalidRequest(`No such file: ${fileId}`), setCorsHeaders);
    return;
  }
  fileStore.delete(fileId);
  fileContents.delete(fileId);
  journalFiles(journal, method, path, flattenHeaders(req.headers), 200);
  writeJson(res, 200, { id: fileId, object: "file", deleted: true }, setCorsHeaders);
}
