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
 * - raw bytes live in `fileContents` as `Buffer`s. Bytes are never
 *   round-tripped through a utf8 string, so binary uploads come back
 *   byte-for-byte identical.
 * - `clearFileStore()` wipes both and is wired into the full reset path
 *   (`POST /__aimock/reset` + `LLMock.reset()`)
 *
 * The only memory bound here is per file: {@link FILES_MAX_BYTES} caps one
 * upload. The file COUNT is deliberately unbounded, so total residency grows
 * with the number of uploads until something calls `clearFileStore()` (or the
 * process exits) — a suite that uploads in a loop without resetting will grow
 * this map without limit. That is a real, documented bound, not an OOM defense.
 *
 * The job maps this module otherwise mirrors (fal-audio.ts,
 * openrouter-video.ts, grok-video.ts, byteplus-video.ts) DO cap entry count and
 * FIFO-evict the oldest, and that convention deliberately does NOT apply here.
 * Those hold transient jobs that the real API also expires, so eviction
 * reproduces real behaviour. A file is a durable object: the real API keeps it
 * until the caller deletes it. Silently evicting one would make the mock answer
 * `404 No such file` for a file the caller successfully uploaded and never
 * deleted — an outcome the real API cannot produce, surfacing as an
 * unexplainable flake in the suite under test. Unbounded growth is the honest
 * failure mode; `POST /__aimock/reset` is the lever that reclaims it.
 *
 * Body handling accepts both shapes real SDKs send:
 * - JSON `{ filename, purpose, content }` (test-friendly; `bytes` is an alias
 *   of `content`, and exactly one of the two must be present)
 * - `multipart/form-data` with `purpose` + exactly one payload part named
 *   `file` (or its `content` alias), framed per RFC 2046 §5.1.1 so a payload
 *   containing the boundary token is stored whole rather than truncated at it
 *
 * Both parsers are strict: a malformed body is an OpenAI-shaped
 * `400 invalid_request_error` naming the offending field or part. Nothing is
 * `String()`-coerced and no missing field falls through to a fabricated
 * default, because a mock that quietly stores `"[object Object]"` or a 0-byte
 * file teaches the suite under test that a broken upload succeeded.
 *
 * Every branch journals with `service: "files"` so
 * `GET /__aimock/journal?service=files` selects exactly this traffic, and with
 * `source: "internal"` because — as with fine-tuning — no fixture or proxy
 * ever serves this store. A successful upload journals a SYNTHETIC body
 * describing it (`{ purpose, filename, bytes, content_type, sha256 }`) — never
 * the uploaded octets — exactly as the transcription route journals its
 * multipart audio; a `400` journals the error envelope it answered with, so
 * the reason is readable from the journal; see {@link journalFiles}. Files also
 * honors the inbound API-key boundary via the server dispatch (no bypass),
 * and runs through the chaos gate so retry/backoff suites can inject
 * 500s at the files surface too.
 */

import { createHash } from "node:crypto";
import type * as http from "node:http";
import { flattenHeaders, generateId, isJsonObject, parseStrictIntegerText } from "./helpers.js";
import { applyChaosAsync } from "./chaos.js";
import type { ChaosDefaults, ChatCompletionRequest, JournalBody } from "./types.js";
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

/**
 * Purposes accepted on upload — `CreateFileRequest.purpose` in the official
 * `openai/openai-openapi` spec (and the `FilePurpose` type in the SDK).
 * `user_data` is what Responses-API file inputs use, so rejecting it broke the
 * most current flow.
 */
const CREATE_PURPOSES = new Set([
  "assistants",
  "batch",
  "fine-tune",
  "vision",
  "user_data",
  "evals",
]);

/**
 * Exposed for tests and for callers that want to check a value themselves:
 * the enum this mock enforces on upload.
 */
export const FILE_CREATE_PURPOSES: readonly string[] = [...CREATE_PURPOSES];

function invalidPurpose(purpose: string): string {
  return `Invalid purpose '${purpose}'. Expected one of: ${[...CREATE_PURPOSES].join(", ")}`;
}

/**
 * `Content-Transfer-Encoding` values that are identity transforms (RFC 2045
 * §6.2): the part body already *is* the file's octets, so storing it verbatim
 * is correct. Everything else (`base64`, `quoted-printable`, …) would have to
 * be decoded before storage, and is rejected instead — see
 * {@link unsupportedPartEncoding}.
 */
const IDENTITY_TRANSFER_ENCODINGS = new Set(["7bit", "8bit", "binary", "identity"]);

/**
 * Reject, rather than silently mis-store, a file part that asks for a content
 * encoding this mock does not apply.
 *
 * We deliberately do NOT implement a decoder. RFC 7578 §4.7 deprecates
 * `Content-Transfer-Encoding` in `multipart/form-data` ("Senders SHOULD NOT
 * generate any parts with a Content-Transfer-Encoding header field. Currently,
 * no deployed implementations that send such bodies have been discovered"), and
 * a capture of the clients that actually reach this endpoint — curl `-F`,
 * python `requests`, python `httpx` (the OpenAI Python SDK's transport) and
 * undici `FormData` (the OpenAI Node SDK's transport) — confirms none of them
 * emits one. Storing an encoded body as-is is the harmful outcome: `bytes` and
 * `GET /content` would report the *encoded* form and a hash comparison in a
 * test would fail for a reason the caller cannot see. A loud 400 naming the
 * header is the honest answer for a mock.
 *
 * `identity` counts as a no-op alongside the RFC 2045 §6.2 values: it is the
 * registered `Content-Encoding` for "no transformation", and a client that
 * spells it on `Content-Transfer-Encoding` means the same thing. Rejecting it
 * named a problem that did not exist.
 *
 * Every part is checked, not only the payload part, and the message names the
 * part it came from. While only the payload part was checked, a `base64`
 * `purpose` part slid through to the enum check and 400'd with
 * `Invalid purpose 'YXNzaXN0YW50cw=='`, pointing the caller at the wrong thing.
 */
function unsupportedPartEncoding(
  header: "Content-Transfer-Encoding" | "Content-Encoding",
  value: string,
  partName: string,
): string {
  // The RFC 7578 §4.7 deprecation is specifically about Content-Transfer-
  // Encoding, so only that branch cites it.
  const rationale =
    header === "Content-Transfer-Encoding"
      ? ` RFC 7578 section 4.7 deprecates ${header} in multipart/form-data.`
      : "";
  return (
    `Unsupported ${header}: '${value}' on the multipart '${partName}' part. ` +
    `aimock stores part bodies verbatim and does not decode them.${rationale} ` +
    `Send the raw bytes instead.`
  );
}

/**
 * Content types for the handful of extensions test harnesses actually upload.
 * Anything unrecognised falls back to `application/octet-stream` — the safe
 * default for opaque bytes, and what stops a PNG being served (and re-decoded)
 * as UTF-8 text.
 *
 * This is an allowlist of INERT types on purpose. `text/html` is deliberately
 * absent: the mock serves uploaded bytes back from its own origin, so any
 * active type here would let a stored upload script that origin in a browser.
 * HTML uploads round-trip byte-for-byte, they are just served as opaque bytes.
 */
const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  json: "application/json",
  // UNVERIFIED against the real API, and left alone for that reason.
  // `application/jsonl` is not IANA-registered; the rest of this repo spells
  // line-delimited JSON `application/x-ndjson` (ndjson-writer.ts, recorder.ts,
  // stream-collapse.ts). Neither `openai/openai-openapi` nor the vendored SDK
  // states what `GET /v1/files/{id}/content` returns for a `.jsonl` upload, and
  // no keyless probe of api.openai.com can answer it, so changing this would be
  // swapping one guess for another. Change it only against a real capture.
  jsonl: "application/jsonl",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  wav: "audio/wav",
  mp3: "audio/mpeg",
  zip: "application/zip",
};

function contentTypeForFilename(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot === -1) return "application/octet-stream";
  const ext = filename.slice(dot + 1).toLowerCase();
  return CONTENT_TYPE_BY_EXT[ext] ?? "application/octet-stream";
}

/**
 * RFC 5987 §3.2.1 `ext-value` percent-encoding for the `filename*` parameter.
 *
 * `encodeURIComponent` leaves `!'()*-._~` unescaped, but `'`, `(`, `)` and `*`
 * are NOT in RFC 5987's `attr-char` set, so they have to be escaped by hand.
 */
function encodeExtValue(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * `Content-Disposition` for the content route (RFC 6266 §4.1).
 *
 * Always `attachment`. {@link CONTENT_TYPE_BY_EXT} is an allowlist of INERT
 * types precisely so a stored upload cannot execute against the mock's own
 * origin, but `application/pdf` was still being served with no disposition at
 * all, which in every mainstream browser means "render in the built-in PDF
 * viewer" — an active surface on this origin, exactly what the allowlist's
 * comment claims is excluded. `attachment` closes that without touching the
 * allowlist, and it also stops a `.json`/`.txt`/`.csv` body being rendered
 * inline if someone opens a content URL in a tab.
 *
 * What the REAL API sends here is UNVERIFIED: probing
 * `api.openai.com/v1/files/{id}/content` needs a key, and neither
 * `openai/openai-openapi` nor the SDK documents the response headers. So this
 * is chosen for safety, not fidelity — and it is inert for SDK callers: the
 * vendored SDK's `files.content()` (openai@4.104.0,
 * `resources/files.js:82-88`) issues the GET with `Accept: application/binary`
 * and `__binaryResponse: true`, handing back the raw `Response` without ever
 * reading `Content-Disposition`.
 *
 * Both parameters are built from the STORED filename, which is attacker-shaped
 * input: a multipart `filename="..."` can carry CR/LF and would otherwise
 * inject response headers. The ASCII fallback replaces every non-printable and
 * non-ASCII byte with `_` and backslash-escapes `"` and `\` per the
 * quoted-string rule; `filename*` percent-encodes them. Neither can emit a bare
 * CR or LF.
 */
function contentDispositionFor(filename: string): string {
  const asciiFallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/(["\\])/g, "\\$1");
  const base = `attachment; filename="${asciiFallback}"`;
  // Only add the RFC 5987 form when the name actually needs it, so the common
  // ASCII case stays a single plain parameter.
  if (/^[\x20-\x7e]*$/.test(filename)) return base;
  return `${base}; filename*=UTF-8''${encodeExtValue(filename)}`;
}

/**
 * Per-file content cap. An upload whose decoded content is above this gets a
 * `400` with the usual OpenAI-style error envelope, at every wire size a body
 * can have — see {@link FILES_BODY_MAX_BYTES} for how that is kept true
 * without buffering an unbounded body.
 */
export const FILES_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Worst-case wire-to-content expansion of a JSON upload.
 *
 * `content` is a JSON string, so one byte of decoded payload can arrive as as
 * many as six wire bytes: a `\uXXXX` escape is 6 bytes and the cheapest code
 * point one can carry (U+0000–U+007F) is a single UTF-8 byte. Every other
 * code point does better — U+0800–U+FFFF is 3 UTF-8 bytes per 6 wire bytes,
 * a surrogate pair 4 per 12 — and a multipart part is 1:1 plus its envelope.
 * So six is an upper bound on wire → content expansion for both parsers.
 */
const FILES_MAX_WIRE_EXPANSION = 6;

/** Slack for the JSON envelope, or for multipart boundaries and part headers. */
const FILES_ENVELOPE_HEADROOM_BYTES = 64 * 1024;

/**
 * How much of a Files upload body the route will BUFFER — derived, not picked.
 *
 * `readBodyBuffer` enforces a limit by destroying the socket: no status line,
 * no body, no CORS headers, just an `ECONNRESET`. That made the `400 File
 * content exceeds ... byte cap` branches below unreachable when the two caps
 * were equal (both the 10 MB `DEFAULT_MAX_BODY_BYTES`), and a fixed slice of
 * headroom above the cap only moved the cliff: a `\u0001`-heavy JSON body or a
 * multipart body far enough over the cap still died on the socket.
 *
 * So the bound is computed from the widest a within-cap payload can be on the
 * wire ({@link FILES_MAX_WIRE_EXPANSION} × the cap, plus envelope headroom).
 * Two consequences, and they are the contract:
 *
 * - No body that could decode to a payload within the cap is ever refused for
 *   its size — it fits here by construction, and is answered on content.
 * - A body larger than this is not buffered. The route stops retaining bytes
 *   (peak memory stays at this bound), drains the rest, and answers a real
 *   `400` with CORS. It is not a socket drop, and it cannot be a false
 *   rejection either, by the point above.
 *
 * The global `readBodyBuffer` default is deliberately left alone — every other
 * route depends on it.
 */
export const FILES_BODY_MAX_BYTES =
  FILES_MAX_BYTES * FILES_MAX_WIRE_EXPANSION + FILES_ENVELOPE_HEADROOM_BYTES;

/**
 * The one documented socket drop on this route: a DoS backstop.
 *
 * Draining an over-size body is what buys the caller a real `400`, but the
 * draining itself is work an attacker can ask for without limit. Past this
 * the request is simply not worth finishing and the socket is destroyed, the
 * same way every other route treats its own limit. It is deliberately far
 * above {@link FILES_BODY_MAX_BYTES}: a client that lands here is not sending
 * a file that was ever going to be accepted.
 */
export const FILES_BODY_DRAIN_MAX_BYTES = FILES_BODY_MAX_BYTES * 2;

/**
 * Stands in for an upload body that went past {@link FILES_BODY_MAX_BYTES} and
 * was therefore drained instead of buffered. The route hands this to
 * {@link handleFilesCreate} in place of the bytes, so the over-size answer is
 * the same `400` envelope — journalled, CORS-headed, chaos-gated — as every
 * other rejection here, rather than a second error path in the server.
 */
export const FILES_BODY_OVERSIZED = Symbol("files-body-oversized");

/** The `400` for a body too large to be a within-cap upload. */
function oversizedBody(): string {
  return `Request body exceeds the ${FILES_BODY_MAX_BYTES} byte upload limit for this route (the ${FILES_MAX_BYTES} byte content cap plus worst-case wire encoding overhead)`;
}

interface StoredContent {
  bytes: Buffer;
}

const fileStore = new Map<string, FileObject>();
const fileContents = new Map<string, StoredContent>();

export function clearFileStore(): void {
  fileStore.clear();
  fileContents.clear();
}

export function getFileStoreSize(): number {
  return fileStore.size;
}

/**
 * The stored bytes for one file, as the very `Buffer` this module holds — so a
 * test can assert on what it RETAINS (`buffer.byteLength`), not just on what it
 * serves back. `GET /v1/files/{id}/content` copies onto the wire, so it cannot
 * tell an owned buffer from a `subarray` pinning a 60 MB request body.
 */
export function getStoredFileBytes(id: string): Buffer | undefined {
  return fileContents.get(id)?.bytes;
}

/**
 * Register one file in the store and return its wire object. This is the one
 * insert path: `POST /v1/files` uses it, and so do server-side producers of
 * files (the Batches mock minting `output_file_id` / `error_file_id`), so a
 * file minted internally is retrievable through `GET /v1/files/{id}` and
 * `/content` exactly like an upload. `content` must be an OWNED buffer (see
 * {@link ParsedUpload.content}) — it is stored as-is, and it must already be
 * within {@link FILES_MAX_BYTES}: the cap the upload route enforces holds for
 * every file in the store, so a producer that cannot fit under it fails its
 * own operation instead of storing the file.
 */
export function storeFile(file: {
  purpose: string;
  filename: string;
  content: Buffer;
}): FileObject {
  if (file.content.length > FILES_MAX_BYTES) {
    throw new RangeError(`File content exceeds ${FILES_MAX_BYTES} byte cap`);
  }
  const id = generateId("file");
  const obj: FileObject = {
    id,
    object: "file",
    bytes: file.content.length,
    created_at: Math.floor(Date.now() / 1000),
    filename: file.filename,
    purpose: file.purpose,
    status: "processed",
  };
  fileStore.set(id, obj);
  // Stored as-is: an owned buffer of exactly the file's bytes, so residency
  // here is the file's size and nothing more.
  fileContents.set(id, { bytes: file.content });
  return obj;
}

/**
 * Synthetic journal body for an upload — the SAME convention
 * {@link handleTranscription} uses for `multipart/form-data` audio: the entry
 * carries a small object describing the upload that was parsed out of the
 * body, never the body itself. Raw file octets are NEVER journalled, in any
 * encoding: they can be megabytes of binary, they would blow the journal's
 * 64 KB body cap on anything real, and a base64 round-trip of them is not
 * something a test wants to diff. `sha256` is the byte identity a caller
 * asserts on instead.
 *
 * `content_type` is derived from the stored filename via
 * {@link contentTypeForFilename} — the same decision `GET /v1/files/{id}/content`
 * serves the bytes back with — rather than from the client-declared part
 * header, which this mock deliberately ignores everywhere else.
 *
 * `model`/`messages` are the inert `ChatCompletionRequest` floor the journal's
 * body type requires (the same `{ model: "", messages: [] }` the server uses
 * for its own bodyless synthetic entries); `_endpointType` names the surface.
 */
function filesUploadBody(upload: ParsedUpload): ChatCompletionRequest {
  return {
    model: "",
    messages: [],
    _endpointType: "files",
    purpose: upload.purpose,
    filename: upload.filename,
    bytes: upload.content.length,
    content_type: contentTypeForFilename(upload.filename),
    sha256: createHash("sha256").update(upload.content).digest("hex"),
  };
}

/**
 * Journal one files-route request.
 *
 * The rule for `body`: an entry carries the {@link filesUploadBody} descriptor
 * exactly when a request had an upload payload that parsed — i.e. a successful
 * `POST /v1/files` — and the {@link invalidRequest} envelope exactly when the
 * request was rejected with a `400` (see {@link rejectFiles}), so the reason
 * is readable from the journal without the wire response. Every other files
 * entry (GET one, GET content, list, DELETE, a chaos-faulted request, a 404)
 * has no payload to describe and stays `null`, matching the bodyless routes in
 * {@link handleTranscription}. Raw uploaded bytes never appear.
 *
 * `service: "files"` is set on every branch so
 * `GET /__aimock/journal?service=files` selects exactly this traffic, and
 * `source: "internal"` because this store is aimock's own — the same tag every
 * fine-tuning entry carries, success and error alike.
 *
 * Call it AFTER the response has been written: a `writeHead` that throws must
 * not leave behind an entry for a response the client never received.
 */
function journalFiles(
  journal: Journal,
  method: string,
  path: string,
  headers: Record<string, string>,
  status: number,
  body: JournalBody | null = null,
): void {
  journal.add({
    method,
    path,
    headers,
    body,
    service: "files",
    response: { status, fixture: null, source: "internal" },
  });
}

/** Keep the entire warning bounded and on one physical line, including the URL. */
function filesRejectionWarning(message: string): string {
  const maxLength = 1_024;
  let safe = "";
  for (const character of message) {
    const code = character.charCodeAt(0);
    const escaped =
      code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029
        ? `\\u${code.toString(16).padStart(4, "0")}`
        : character;
    // Reserve the truncation marker and never cut through an escape sequence.
    if (safe.length + escaped.length > maxLength - 3) return `${safe}...`;
    safe += escaped;
  }
  return safe;
}

/**
 * Answer a files-route `400`: log it at `warn` (the level the server uses for
 * a request it refused), journal the {@link invalidRequest} envelope as the
 * entry's body so the reason survives in the journal, and write that same
 * envelope to the wire. One helper so the three can never disagree.
 */
function rejectFiles(
  res: http.ServerResponse,
  journal: Journal,
  logger: Logger,
  method: string,
  path: string,
  headers: Record<string, string>,
  message: string,
  setCorsHeaders: (res: http.ServerResponse) => void,
): void {
  const envelope = invalidRequest(message);
  logger.warn(filesRejectionWarning(`Files mock: rejected ${method} ${path} with 400: ${message}`));
  writeJson(res, 400, envelope, setCorsHeaders);
  journalFiles(journal, method, path, headers, 400, envelope);
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

/**
 * Name a rejected value's JSON type for the 400 message. The point is that the
 * caller sees *what* they sent instead of silently getting `String(value)`
 * stored as the file's content.
 *
 * The listed cases are exhaustive for the one caller. `JSON.parse` only ever
 * yields null, boolean, number, string, array or plain object — never
 * `undefined`, `function`, `symbol` or `bigint` — and the caller has already
 * excluded `string` (it is the accepted type) and `undefined` (that is the
 * separate "required" 400). So everything reaching the last line is an object.
 */
function jsonTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "number") return "a number";
  if (typeof value === "boolean") return "a boolean";
  return "an object";
}

interface ParsedUpload {
  filename: string;
  purpose: string;
  /**
   * The upload's bytes, and an OWNED buffer — never a `subarray` of the
   * request body. Both parsers guarantee it (`Buffer.from(content, "utf8")` on
   * the JSON path, an explicit copy on the multipart path) because this is
   * what {@link handleFilesCreate} stores, and a view would keep the entire
   * request body resident for the lifetime of the file.
   */
  content: Buffer;
}

/**
 * A high surrogate not followed by a low one, or a low surrogate not preceded
 * by a high one — i.e. a JS string that is not well-formed UTF-16 and therefore
 * has no UTF-8 encoding.
 *
 * `Buffer.from(s, "utf8")` does not fail on these: it substitutes U+FFFD (EF BF
 * BD), silently and permanently. That breaks the one guarantee an upload mock
 * owes its caller — `GET /v1/files/{id}/content` returns what was uploaded — and
 * it breaks it invisibly, three bytes at a time, in a test whose hash
 * comparison then fails for no visible reason. The byte-for-byte promise this
 * module documents is made for the multipart path (which is scanned as latin1
 * and never decoded); the JSON path carries *text*, so text that cannot be
 * encoded is a 400, not a lossy store.
 */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Longest `filename` this mock will store, in UTF-8 bytes.
 *
 * NOT the real API's limit: `openai/openai-openapi` gives `OpenAIFile.filename`
 * as a bare `type: string` with no `maxLength`, and `CreateFileRequest` has no
 * `filename` property at all. So the bound comes from the one thing here a
 * filename can break: `GET /v1/files/{id}/content` echoes the stored name into
 * `Content-Disposition` twice — quoted ASCII (where `"` and `\` double) and
 * percent-encoded per RFC 5987 (where a byte can triple) — so ~5 bytes of
 * header per byte of name. 1024 bytes of name is ~5 KiB of header, well inside
 * Node's 16 KiB default `--max-http-header-size`.
 *
 * Unbounded, a 20 KB filename uploaded `200` and then made the content route
 * unreadable by undici: `UND_ERR_HEADERS_OVERFLOW`, no status, no envelope, no
 * CORS — the OpenAI SDK could not fetch a file it had just uploaded.
 */
export const FILES_MAX_FILENAME_BYTES = 1024;

/**
 * The filename rules, in one place because both parsers must answer the same.
 *
 * They used to disagree: a name carrying NUL, CR or LF was a `400` as a
 * multipart parameter and a `200` as a JSON field, stored and echoed back
 * verbatim. Returns an error message, or `undefined` if the name is fine.
 */
function filenameError(filename: string): string | undefined {
  // A filename is metadata that is echoed back on every file object, so it must
  // not carry control characters.
  if (CONTROL_CHARS.test(filename)) {
    return "Invalid parameter: 'filename' must not contain control characters";
  }
  // An unpaired surrogate has no UTF-8 encoding, so `encodeURIComponent` throws
  // on it when the content route builds its `filename*` parameter: the name
  // uploaded with a 200 and then made `GET /v1/files/{id}/content` a 500.
  if (LONE_SURROGATE_RE.test(filename)) {
    return "Invalid parameter: 'filename' must not contain an unpaired UTF-16 surrogate";
  }
  const byteLength = Buffer.byteLength(filename, "utf8");
  if (byteLength > FILES_MAX_FILENAME_BYTES) {
    return (
      `Invalid parameter: 'filename' is ${byteLength} UTF-8 bytes, above the ` +
      `${FILES_MAX_FILENAME_BYTES} byte cap (a longer name makes ` +
      `GET /v1/files/{id}/content unfetchable: its Content-Disposition header ` +
      `would exceed the HTTP header limit)`
    );
  }
  return undefined;
}

/** The deterministic name given to an upload that arrived without one. */
function synthesizedFilename(content: Buffer): string {
  return `upload-${createHash("sha256").update(content).digest("hex").slice(0, 24)}.bin`;
}

function parseJsonUpload(raw: Buffer): ParsedUpload | { error: string } {
  // Decoded FATALLY, like `filename*` on the multipart path: `raw.toString("utf8")`
  // substitutes U+FFFD for an invalid sequence, so a body carrying a raw 0xFF
  // inside `content` was stored (with a 200) as bytes the client never sent.
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    return { error: "Invalid request: body is not valid UTF-8" };
  }
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unknown";
    return { error: `Malformed JSON: ${detail}` };
  }
  if (!isJsonObject(body)) {
    return { error: "Request body must be a JSON object" };
  }
  const rawFilename = body["filename"];
  const purpose = body["purpose"];
  if (typeof rawFilename !== "string") {
    return { error: "Invalid parameter: 'filename' must be a string" };
  }
  const filenameProblem = filenameError(rawFilename);
  if (filenameProblem !== undefined) return { error: filenameProblem };
  // Blank is no filename at all, exactly as on the multipart path; the
  // synthesized name below is the same pure function of the content there.
  const filename = rawFilename.trim() === "" ? undefined : rawFilename;
  if (typeof purpose !== "string" || purpose.length === 0) {
    return { error: "Invalid parameter: 'purpose' must be a non-empty string" };
  }
  if (!CREATE_PURPOSES.has(purpose)) {
    return { error: invalidPurpose(purpose) };
  }
  // `bytes` is a documented alias of `content`, but it is ALSO the name of the
  // numeric byte-count on a returned file object — so a caller that echoes a
  // `FileObject` back at the upload route would otherwise have `42` stored as
  // its content. Both spellings on one body are ambiguous, so they are rejected
  // rather than silently resolved by precedence, and neither is coerced: a
  // non-string payload is a 400, never `String(value)`.
  const hasContent = body["content"] !== undefined;
  const hasBytesAlias = body["bytes"] !== undefined;
  if (hasContent && hasBytesAlias) {
    return {
      error:
        "Invalid parameter: 'content' and its alias 'bytes' are mutually exclusive; send exactly one",
    };
  }
  const field = hasContent ? "content" : "bytes";
  const content = hasContent ? body["content"] : body["bytes"];
  if (content === undefined) {
    return { error: "Invalid parameter: 'content' is required (or its alias 'bytes')" };
  }
  if (typeof content !== "string") {
    return {
      error: `Invalid parameter: '${field}' must be a string, got ${jsonTypeOf(content)}`,
    };
  }
  if (LONE_SURROGATE_RE.test(content)) {
    return {
      error:
        `Invalid parameter: '${field}' contains an unpaired UTF-16 surrogate and is not valid text. ` +
        `aimock would have to store it as U+FFFD, so the bytes served back by ` +
        `GET /v1/files/{id}/content would not be the bytes you sent. Send binary ` +
        `as a multipart/form-data upload, which is stored verbatim.`,
    };
  }
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length > FILES_MAX_BYTES) {
    return { error: `File content exceeds ${FILES_MAX_BYTES} byte cap` };
  }
  return { filename: filename ?? synthesizedFilename(bytes), purpose, content: bytes };
}

/**
 * One parsed `multipart/form-data` body part: its headers (field names
 * lower-cased, values trimmed) and its body as the exact octets that sat
 * between the two boundary delimiter lines.
 */
interface MultipartPart {
  /** The `name` parameter of `Content-Disposition`. Always present. */
  name: string;
  /** The `filename`/`filename*` parameter, or `undefined` when absent. */
  filename?: string;
  headers: Map<string, string>;
  body: Buffer;
}

const HEADER_TERMINATOR = Buffer.from("\r\n\r\n");

/** RFC 9110 `token` characters — the legal set for a header field name. */
const TOKEN_CHAR = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** C0 controls plus DEL — never legitimate in a filename we echo back. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[ -]/;

/**
 * Is this request body `multipart/form-data`?
 *
 * Compares the media type's *essence* (RFC 9110 §8.3.1: everything before the
 * first `;`), not a substring of the whole header. A substring test routed
 * `application/json; note="multipart/form-data"` — and anything else that
 * merely mentions the token in a parameter — into the multipart parser, which
 * then 400'd about a missing `boundary` directive on a perfectly good JSON
 * body.
 */
function isMultipartFormData(contentType: string | undefined): boolean {
  if (contentType === undefined) return false;
  const semi = contentType.indexOf(";");
  const essence = (semi === -1 ? contentType : contentType.slice(0, semi)).trim().toLowerCase();
  return essence === "multipart/form-data";
}

/**
 * Locate the next *boundary delimiter line* at or after `from`.
 *
 * RFC 2046 §5.1.1 defines the delimiter as `CRLF "--" boundary` followed by
 * either transport-padding + CRLF (another part follows) or `--` (the close
 * delimiter). Both halves matter:
 *
 * - The **leading CRLF is part of the delimiter**, not of the preceding body.
 *   The previous implementation split on a bare `--boundary`, so a payload
 *   whose bytes happened to contain that sequence was truncated at it and
 *   stored short — with a 200, silently, which is the worst possible answer
 *   from a module whose contract is byte-for-byte storage.
 * - An occurrence **not followed by** CRLF or `--` is not a delimiter line at
 *   all, so it is ordinary body content and the scan continues past it. That
 *   is what keeps a payload containing `CRLF--boundary` plus arbitrary bytes
 *   byte-exact. (undici's `Response.formData()` rejects such a body outright;
 *   see the note on {@link parseMultipartUpload}.)
 */
function nextDelimiter(
  buf: Buffer,
  delimiter: Buffer,
  from: number,
): { at: number; next: number; closing: boolean } | undefined {
  let at = buf.indexOf(delimiter, from);
  while (at !== -1) {
    const tail = delimiterTail(buf, at + delimiter.length);
    if (tail) return { at, ...tail };
    at = buf.indexOf(delimiter, at + 1);
  }
  return undefined;
}

/**
 * Classify what follows a `CRLF "--" boundary` match: transport-padding + CRLF
 * (another part follows), `--` (the close delimiter), or neither — in which
 * case the match is not a delimiter line at all and the caller keeps scanning.
 * Split out of {@link nextDelimiter} so {@link parseMultipartUpload} can apply
 * the same rule to an opening delimiter whose leading CRLF is not present.
 */
function delimiterTail(buf: Buffer, after: number): { next: number; closing: boolean } | undefined {
  if (buf[after] === 0x2d && buf[after + 1] === 0x2d) return { next: after + 2, closing: true };
  // transport-padding = *LWSP-char
  let j = after;
  while (buf[j] === 0x20 || buf[j] === 0x09) j += 1;
  if (buf[j] === 0x0d && buf[j + 1] === 0x0a) return { next: j + 2, closing: false };
  return undefined;
}

/**
 * Parse a header parameter list (`value; attr=token; attr="quoted"`).
 *
 * Hand-rolled *matching* is what broke the old header handling: `name` and
 * `filename` were matched with regexes against the whole header block, so a
 * `[^"]+` capture ran across a CRLF and swallowed the next header line (an
 * upload whose filename parameter embedded a CRLF plus `X-Evil: y.txt` was
 * accepted with a 200 and the injected header text stored as the filename),
 * and the `\s*` in the encoding regexes did the same. Walking one header's
 * value with a real quoted-string scanner cannot cross a line, because the
 * value it is handed never contains one.
 *
 * A repeated attribute is an error rather than a last-one-wins overwrite.
 * `filename="a.txt"; filename="b.png"` decided both the name echoed on the file
 * object and the `Content-Type` served back by `GET /content` (a text upload
 * came back as `image/png`), and RFC 7578 §4.2 gives no precedence rule to pick
 * a winner by — the same reason duplicate `purpose` and payload parts are
 * refused below. Ambiguity is never resolved by precedence in this module.
 */
type HeaderParams = { value: string; params: Map<string, string> };
type HeaderParamsError = { error: "malformed" } | { error: "duplicate"; param: string };

function parseHeaderParams(value: string): HeaderParams | HeaderParamsError {
  const params = new Map<string, string>();
  const semi = value.indexOf(";");
  const head = (semi === -1 ? value : value.slice(0, semi)).trim();
  let i = semi === -1 ? value.length : semi;
  while (i < value.length) {
    i += 1; // consume the ';'
    while (value[i] === " " || value[i] === "\t") i += 1;
    if (i >= value.length) break; // trailing ';'
    const eq = value.indexOf("=", i);
    if (eq === -1) return MALFORMED_HEADER; // a parameter with no value
    const attr = value.slice(i, eq).trim().toLowerCase();
    if (!TOKEN_CHAR.test(attr)) return MALFORMED_HEADER;
    if (params.has(attr)) return { error: "duplicate", param: attr };
    i = eq + 1;
    if (value[i] === '"') {
      i += 1;
      let out = "";
      for (;;) {
        if (i >= value.length) return MALFORMED_HEADER; // unterminated quoted-string
        const ch = value[i];
        if (ch === "\\" && i + 1 < value.length) {
          out += value[i + 1];
          i += 2;
          continue;
        }
        if (ch === '"') {
          i += 1;
          break;
        }
        out += ch;
        i += 1;
      }
      params.set(attr, out);
      while (value[i] === " " || value[i] === "\t") i += 1;
      if (i < value.length && value[i] !== ";") return MALFORMED_HEADER;
    } else {
      const end = value.indexOf(";", i);
      params.set(attr, (end === -1 ? value.slice(i) : value.slice(i, end)).trim());
      i = end === -1 ? value.length : end;
    }
  }
  return { value: head, params };
}

const MALFORMED_HEADER: HeaderParamsError = { error: "malformed" };

/** Render a {@link parseHeaderParams} failure as a 400 message naming the header. */
function headerParamError(err: HeaderParamsError, header: string, where: string): string {
  return err.error === "duplicate"
    ? `Invalid request: duplicate '${err.param}' parameter on the ${header} header in ${where}`
    : `Invalid request: malformed ${header} header in ${where}`;
}

/**
 * Decode an RFC 5987 `ext-value` (`charset'language'pct-encoded`), the form a
 * `filename*` parameter takes. RFC 6266 §4.3 says a recipient that understands
 * it SHOULD prefer it over the plain `filename`, so {@link parsePart} does.
 * A client that sends only `filename*=` therefore keeps the name it sent
 * instead of receiving a synthesized one.
 */
function decodeExtValue(raw: string): string | undefined {
  const first = raw.indexOf("'");
  const second = raw.indexOf("'", first + 1);
  if (first === -1 || second === -1) return undefined;
  const charset = raw.slice(0, first).toLowerCase();
  if (charset !== "utf-8" && charset !== "iso-8859-1") return undefined;
  const octets: number[] = [];
  const pct = raw.slice(second + 1);
  for (let i = 0; i < pct.length; i += 1) {
    if (pct[i] === "%") {
      const hex = pct.slice(i + 1, i + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return undefined;
      octets.push(parseInt(hex, 16));
      i += 2;
    } else {
      const code = pct.charCodeAt(i);
      if (code > 0x7f) return undefined;
      octets.push(code);
    }
  }
  const bytes = Buffer.from(octets);
  // latin1 maps every octet, so only the utf-8 branch can fail — and it must
  // fail LOUDLY. `Buffer.toString("utf8")` substitutes U+FFFD for an invalid
  // sequence, so `filename*=UTF-8''%FF%FE.txt` was stored (with a 200) under a
  // name the client never sent, while the neighbouring malformed-parameter
  // cases got a 400. A name that cannot be decoded is a malformed parameter.
  if (charset === "iso-8859-1") return bytes.toString("latin1");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** Turn one part's raw octets into headers + body, or name why it is malformed. */
function parsePart(partBytes: Buffer, index: number): MultipartPart | { error: string } {
  const where = `multipart part #${index + 1}`;
  let headerText: string;
  let bodyStart: number;
  if (partBytes[0] === 0x0d && partBytes[1] === 0x0a) {
    // `body-part = MIME-part-headers CRLF *OCTET` with an empty header block.
    headerText = "";
    bodyStart = 2;
  } else {
    const end = partBytes.indexOf(HEADER_TERMINATOR);
    if (end === -1) {
      // Skipping such a part would report the NEXT missing thing instead: a
      // body whose parts use bare LF separators would be answered "multipart
      // 'purpose' field is required" even though `purpose` was sent. The 400
      // names the part that is actually malformed.
      return {
        error: `Invalid request: malformed ${where} — its headers are not terminated by a blank line`,
      };
    }
    headerText = partBytes.subarray(0, end).toString("utf8");
    bodyStart = end + 4;
  }

  const headers = new Map<string, string>();
  if (headerText !== "") {
    for (const line of headerText.split("\r\n")) {
      const colon = line.indexOf(":");
      const fieldName = colon === -1 ? "" : line.slice(0, colon);
      if (!TOKEN_CHAR.test(fieldName)) {
        return { error: `Invalid request: malformed header line in ${where}` };
      }
      const field = fieldName.toLowerCase();
      // Last-one-wins on a repeated header defeated the very contracts this
      // parser exists to enforce: `Content-Transfer-Encoding: base64` followed
      // by `Content-Transfer-Encoding: 7bit` sailed past the encoding check
      // and stored the literal base64 TEXT as the file's octets (a 200, four
      // bytes of `aGk=`), and a repeated `Content-Disposition` could pair one
      // part's filename with another's rule. RFC 9110 §5.3 only permits a
      // repeated field for a list-valued one, which none of these are, so
      // there is nothing to combine and no defensible precedence.
      if (headers.has(field)) {
        return { error: `Invalid request: duplicate '${fieldName.trim()}' header in ${where}` };
      }
      headers.set(field, line.slice(colon + 1).trim());
    }
  }

  const disposition = headers.get("content-disposition");
  if (disposition === undefined) {
    return { error: `Invalid request: ${where} has no Content-Disposition header` };
  }
  const parsed = parseHeaderParams(disposition);
  if ("error" in parsed) {
    return { error: headerParamError(parsed, "Content-Disposition", where) };
  }
  // RFC 7578 §4.2: "Each part MUST contain a Content-Disposition header field
  // where the disposition type is 'form-data'." Any other type was accepted
  // unchecked, so `Content-Disposition: attachment; name="file"` — which is a
  // response-side disposition, not a form part — uploaded a file.
  const dispositionType = parsed.value.toLowerCase();
  if (dispositionType !== "form-data") {
    return {
      error:
        `Invalid request: ${where} has Content-Disposition type '${parsed.value}'; ` +
        `RFC 7578 section 4.2 requires 'form-data'`,
    };
  }
  const name = parsed.params.get("name");
  if (name === undefined) {
    // RFC 7578 §4.2 makes `name` mandatory on every form-data part.
    return {
      error: `Invalid request: ${where} has no 'name' parameter on its Content-Disposition header`,
    };
  }

  const star = parsed.params.get("filename*");
  const filename = star !== undefined ? decodeExtValue(star) : parsed.params.get("filename");
  if (star !== undefined && filename === undefined) {
    return { error: `Invalid request: malformed 'filename*' parameter in ${where}` };
  }

  return { name, filename, headers, body: partBytes.subarray(bodyStart) };
}

/**
 * Read a part's content encoding header. An empty value reads as absent: the
 * old regex used `\s*` after the colon, which matches a CRLF, so an empty
 * `Content-Transfer-Encoding:` captured the *next* header line and 400'd
 * naming `content-type: image/png` as the unsupported encoding.
 */
function partEncoding(part: MultipartPart, header: string): string | undefined {
  const value = part.headers.get(header)?.trim().toLowerCase();
  return value === undefined || value === "" ? undefined : value;
}

/**
 * Parse a `multipart/form-data` upload body.
 *
 * ## Why this is not `Response.formData()`
 *
 * Node's built-in (undici) `Response.formData()` is a spec-compliant multipart
 * parser and was evaluated first, per the "use the platform, do not hand-roll
 * a codec" rule. It fails three of this module's requirements:
 *
 * 1. **Byte fidelity.** It throws `expected CRLF` on any body whose payload
 *    contains the boundary token, including the RFC-legal bare `--boundary`
 *    with no preceding CRLF. Those bytes are storable and this module promises
 *    to store them.
 * 2. **Filename-less payload parts.** A part with no `filename` parameter comes
 *    back as a *string*, decoded as UTF-8, so binary octets are destroyed
 *    (`00 ff fe ...` becomes `00 efbfbd efbfbd ...`). Such a part is legal
 *    input here and already round-tripped byte-exact.
 * 3. **Part headers.** `File` exposes only `name`, `type` and `size`. There is
 *    no way to see a part's `Content-Transfer-Encoding`, so the "reject an
 *    encoding we do not apply" contract above could not be implemented at all
 *    and a `base64` part would be stored in its encoded form — the exact bug
 *    that contract exists to prevent.
 *
 * So the framing stays local, but it is written to RFC 2046 §5.1.1 and
 * RFC 7578 rather than to a `split()`: see {@link nextDelimiter} for the
 * delimiter rule and {@link parsePart} for the header rule.
 *
 * Bytes never round-trip through a string. Part bodies are `subarray`s of the
 * request buffer, so what is parsed is literally what arrived on the wire — but
 * the payload part is COPIED out of that view before it is returned, because a
 * `subarray` retains its whole backing buffer (see the copy below). The scan
 * itself never copies the body either, so peak residency during a parse is one
 * request body, not two.
 */
function parseMultipartUpload(
  rawBytes: Buffer,
  contentType: string | undefined,
): ParsedUpload | { error: string } {
  // Parsed as a real parameter list rather than with a first-match regex: the
  // regex read `boundary=` out of ANOTHER parameter's quoted string, so
  // `multipart/form-data; name="x boundary=FAKE"; boundary=REAL` searched for
  // the decoy and 400'd a perfectly good body as having "no boundary
  // delimiter". `extractBoundary` (transcription.ts) keeps its regex: its
  // callers hand it whole request bodies scanned as text, not this one header.
  const parsedType = parseHeaderParams(contentType ?? "");
  if ("error" in parsedType) {
    return { error: headerParamError(parsedType, "Content-Type", "the request") };
  }
  const boundary = parsedType.params.get("boundary");
  if (!boundary) {
    // Without a boundary there is no way to find the part edges, so every
    // earlier best-effort path here silently stored a 0-byte file and threw
    // the caller's bytes away. A multipart body that cannot be parsed is a
    // client error, not an empty upload.
    return {
      error: "Invalid request: multipart/form-data Content-Type is missing a 'boundary' directive",
    };
  }

  // Everything before the opening delimiter is the preamble. That delimiter
  // alone has no preceding CRLF when the preamble is empty; matching it used
  // to mean parsing `Buffer.concat([CRLF, rawBytes])`, a second copy of the
  // whole request body for the sake of two octets. So it is special-cased and
  // the scan runs over the request buffer in place.
  const buf = rawBytes;
  const delimiter = Buffer.from(`\r\n--${boundary}`, "latin1");
  const dashBoundary = Buffer.from(`--${boundary}`, "latin1");
  const opening = buf.subarray(0, dashBoundary.length).equals(dashBoundary)
    ? delimiterTail(buf, dashBoundary.length)
    : undefined;
  // `at` is only ever read as the END of the preceding part's body, which the
  // opening delimiter has none of, so 0 stands in for it.
  let delim = opening ? { at: 0, ...opening } : nextDelimiter(buf, delimiter, 0);
  if (!delim) {
    return { error: "Invalid request: multipart body contains no boundary delimiter" };
  }

  const parts: MultipartPart[] = [];
  while (!delim.closing) {
    const start = delim.next;
    const following = nextDelimiter(buf, delimiter, start);
    if (!following) {
      return {
        error: "Invalid request: multipart body ended before its closing boundary delimiter",
      };
    }
    const part = parsePart(buf.subarray(start, following.at), parts.length);
    if ("error" in part) return part;
    parts.push(part);
    delim = following;
  }

  // Encoding first, and across every part: the message must name the part that
  // actually declared the encoding, rather than let an encoded value fall
  // through to a downstream check that reports something else entirely.
  for (const part of parts) {
    const transfer = partEncoding(part, "content-transfer-encoding");
    if (transfer !== undefined && !IDENTITY_TRANSFER_ENCODINGS.has(transfer)) {
      return { error: unsupportedPartEncoding("Content-Transfer-Encoding", transfer, part.name) };
    }
    const encoding = partEncoding(part, "content-encoding");
    if (encoding !== undefined && encoding !== "identity") {
      return { error: unsupportedPartEncoding("Content-Encoding", encoding, part.name) };
    }
  }

  // A part whose `name` is none of `purpose`/`file`/`content` is IGNORED, not
  // rejected. That is deliberate, and it is the JSON path's rule too: an
  // unknown key on a JSON upload body is ignored there (only `filename`,
  // `purpose` and `content`/`bytes` are read), so the two body shapes answer
  // the same request the same way. The vendored spec surface gives no reason to
  // be stricter either — `FileCreateParams` in openai 4.104.0
  // (`resources/files.d.ts`) declares exactly `file` and `purpose` and says
  // nothing about rejecting extras, so a 400 here would be this mock inventing
  // a rejection it cannot show the real API makes. Every part is still parsed
  // and still encoding-checked above, so an ignored part cannot smuggle
  // anything past a contract — it only fails to contribute.
  const purposeParts = parts.filter((p) => p.name === "purpose");
  if (purposeParts.length > 1) {
    // Last-one-wins silently picked a purpose the caller never meant to send.
    // There is no defensible precedence, so this gets the same answer that
    // duplicate payload parts already got.
    return {
      error: "Invalid request: multipart body has more than one 'purpose' part; send exactly one",
    };
  }
  const payloadParts = parts.filter((p) => p.name === "file" || p.name === "content");
  if (payloadParts.length > 1) {
    // Two payload parts means the filename from one can be paired with the
    // bytes of the other. There is no defensible precedence, so reject.
    const [first, second] = payloadParts;
    return {
      error: `Invalid request: multipart body has more than one payload part ('${first.name}' and '${second.name}'); send exactly one 'file' or 'content' part`,
    };
  }

  // NOT trimmed: `" batch "` is a `400` here exactly as it is on the JSON path.
  const purpose = purposeParts[0]?.body.toString("utf8");
  if (!purpose) {
    return { error: "Invalid parameter: multipart 'purpose' field is required" };
  }
  if (!CREATE_PURPOSES.has(purpose)) {
    return { error: invalidPurpose(purpose) };
  }
  const payload = payloadParts[0];
  if (payload === undefined) {
    return {
      error: "Invalid request: multipart body must include a 'file' part (or its 'content' alias)",
    };
  }

  // The payload part's own Content-Type header is intentionally ignored: it is
  // client-controlled and must never decide what we serve back. Real SDKs send
  // `application/octet-stream` for every binary part anyway, so the filename is
  // both the safer and the more accurate signal.
  if (payload.body.length > FILES_MAX_BYTES) {
    return { error: `File content exceeds ${FILES_MAX_BYTES} byte cap` };
  }
  // Copy, do not hand out the view. Every part body above is a `subarray` of
  // the request buffer, and a `subarray` keeps its whole backing `ArrayBuffer`
  // alive — so storing one made a 2-byte file pin its entire request body, up
  // to `FILES_BODY_MAX_BYTES` (~62.9 MB), for as long as the file existed.
  // That silently falsified the per-file memory bound this module documents at
  // the top. `Buffer.alloc` + `copy` rather than `Buffer.from(view)` because
  // the latter draws small allocations from the shared `Buffer` pool,
  // which is a smaller version of the same aliasing. The copy is bounded by
  // the cap just checked, and it is the only copy of the payload made here.
  const content = Buffer.alloc(payload.body.length);
  payload.body.copy(content);

  // CR and LF can no longer reach the filename here (a header value cannot span
  // a line), but NUL and friends still can — and the JSON path has no such
  // structural protection, which is why the check is shared.
  let filename = payload.filename;
  if (filename !== undefined) {
    const problem = filenameError(filename);
    if (problem !== undefined) return { error: problem };
  }
  // A blank or whitespace-only filename is no filename at all: `"   "` is
  // neither a usable name nor worth a 400, so it falls through to the
  // synthesized name below.
  if (filename !== undefined && filename.trim() === "") filename = undefined;

  if (filename === undefined) {
    // A filename-less `file` part is legal input: `CreateFileRequest` in the
    // `openai/openai-openapi` spec declares `file` as `type: string, format:
    // binary` with no `filename` property at all — the name only ever rides in
    // `Content-Disposition`, and the spec never requires it. The *response*
    // schema (`OpenAIFile`) does require `filename`, so the faithful answer is
    // to synthesize one rather than reject with a 400.
    //
    // Deterministic means a pure function of the uploaded bytes: the same
    // upload always yields the same name (so a test can assert on it, across
    // processes and across `clearFileStore()`), and different bytes yield
    // different names (a 96-bit SHA-256 prefix, so collisions are not a
    // practical concern). It is deliberately NOT a clock or a counter — both
    // would make two identical uploads disagree.
    filename = synthesizedFilename(content);
  }
  return { filename, purpose, content };
}

export async function handleFilesCreate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  raw: Buffer | typeof FILES_BODY_OVERSIZED,
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
    await applyChaosAsync(
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
        service: "files",
      },
      "internal",
      defaults.registry,
      defaults.logger,
    )
  ) {
    return;
  }

  // After the chaos gate on purpose: an over-size body is still a request the
  // fault injector is entitled to answer for.
  if (raw === FILES_BODY_OVERSIZED) {
    rejectFiles(
      res,
      journal,
      defaults.logger,
      method,
      path,
      flattenHeaders(req.headers),
      oversizedBody(),
      setCorsHeaders,
    );
    return;
  }

  const contentType = Array.isArray(req.headers["content-type"])
    ? req.headers["content-type"][0]
    : req.headers["content-type"];
  const parsed = isMultipartFormData(contentType)
    ? parseMultipartUpload(raw, contentType)
    : // Non-multipart bodies are JSON, which is utf8 by definition (RFC 8259).
      parseJsonUpload(raw);

  if ("error" in parsed) {
    rejectFiles(
      res,
      journal,
      defaults.logger,
      method,
      path,
      flattenHeaders(req.headers),
      parsed.error,
      setCorsHeaders,
    );
    return;
  }

  const obj = storeFile(parsed);
  const { id, bytes } = obj;

  defaults.logger.debug(`Files mock: stored ${id} (${parsed.filename}, ${bytes} bytes)`);
  writeJson(res, 200, obj, setCorsHeaders);
  journalFiles(journal, method, path, flattenHeaders(req.headers), 200, filesUploadBody(parsed));
}

/**
 * `GET /v1/files` paging bounds, taken from the `openai/openai-openapi` spec
 * (`operationId: listFiles`): "Limit can range between 1 and 10,000, and the
 * default is 10,000." Files is the odd one out among the list surfaces — most
 * default to 20 — so the default is spelled out here rather than shared.
 */
export const FILES_LIST_MAX_LIMIT = 10000;
export const FILES_LIST_DEFAULT_LIMIT = FILES_LIST_MAX_LIMIT;

/**
 * An unsigned decimal integer literal and nothing else — no sign, no exponent,
 * no radix prefix, no surrounding whitespace. See {@link parseListQuery} for
 * what each of those would otherwise be silently accepted as.
 *
 * A long digit run is still safe to hand to `Number()`: it stays finite and
 * integral, so it fails the range check below rather than the type check.
 * Grammar shared with the fine-tuning and chaos surfaces via
 * {@link parseStrictIntegerText} (helpers.ts) — one digit-run rule, with each
 * surface keeping its own range check and error text.
 */

interface FilesListQuery {
  limit: number;
  order: "asc" | "desc";
  after?: string;
  purpose?: string;
}

/**
 * The single non-empty value of a list query parameter, or the 400 it earns.
 *
 * ONE rule for all four of `limit`, `order`, `after` and `purpose`, because the
 * three ways of reading them used to disagree on the same URL:
 *
 *   - REPEATED is a 400. `URLSearchParams.get` answers with the FIRST of a
 *     repeated parameter and launders the rest, so `?limit=1&limit=abc` paged
 *     at 1 and never looked at `abc` — a caller that built its URL twice over
 *     got a silent success for a value it never meant. `listFiles` declares
 *     each of the four as a single scalar and gives no combining rule for a
 *     repeat, so a repeat is a caller error. Matches the multipart body, where
 *     two `purpose` parts are already a 400 rather than a last-one-wins.
 *   - PRESENT-BUT-EMPTY is a 400. `?order=` was already one (no member of the
 *     enum is ""), but `?after=` meant "no cursor" and `?purpose=` meant "no
 *     filter" and handed back the WHOLE store — the exact opposite of the
 *     narrowing the caller asked for. An empty string is not an object id and
 *     not a purpose any stored file can carry, and `?x=` is what building a
 *     URL from a partly-undefined params object emits, which is a bug worth
 *     showing. Omitting the parameter is how you say "no filter".
 *   - ABSENT is `null`, and each caller applies its own default.
 *
 * Both 400s are OURS, not the vendor's: the spec states neither. They are the
 * mock's standing bias towards failing loudly over answering a question the
 * caller did not ask.
 */
function singleParam(
  params: URLSearchParams,
  name: string,
): { ok: true; value: string | null } | { ok: false; error: string } {
  const all = params.getAll(name);
  if (all.length > 1) {
    return {
      ok: false,
      error: `Invalid parameter: '${name}' was given ${all.length} times; it takes a single value`,
    };
  }
  if (all.length === 0) return { ok: true, value: null };
  if (all[0] === "") {
    return {
      ok: false,
      error: `Invalid parameter: '${name}' was given an empty value; omit it instead`,
    };
  }
  return { ok: true, value: all[0] };
}

/**
 * Parse the `limit` / `order` / `after` / `purpose` parameters off a list URL.
 *
 * Shapes come from `operationId: listFiles` in `openai/openai-openapi` and from
 * `FileListParams extends CursorPageParams` in the vendored SDK (openai
 * 4.104.0 — `resources/files.d.ts` gives `order?: 'asc' | 'desc'` and
 * `purpose?: string`; `pagination.d.ts` gives `after?: string` and
 * `limit?: number`). `order` defaults to `desc`, so the newest file comes back
 * first.
 *
 * All four are read here, through {@link singleParam}, so there is exactly one
 * place that decides what a repeated or empty list parameter means. `purpose`
 * used to be read separately in `src/server.ts` and passed in already parsed,
 * which is how it ended up with neither rule.
 */
function parseListQuery(rawUrl: string): FilesListQuery | { error: string } {
  // Everything after the first `?` is query data, read as-is. `new URL(target,
  // base).searchParams` cannot be used here: it applies the fragment rule, and
  // a request target has no fragment component (RFC 9112 section 3.2), so an
  // origin server sees `?purpose=batch#frag` as the purpose `batch#frag` — not
  // as `batch` plus a fragment nobody sent. Truncating at the `#` turns a value
  // that matches nothing into a plausible-looking one that matches files.
  // `new URLSearchParams(string)` cannot throw, so no parse failure is hidden.
  const queryStart = rawUrl.indexOf("?");
  const params = new URLSearchParams(queryStart === -1 ? "" : rawUrl.slice(queryStart + 1));

  const rawOrder = singleParam(params, "order");
  if (!rawOrder.ok) return { error: rawOrder.error };
  const orderRaw = rawOrder.value;
  if (orderRaw !== null && orderRaw !== "asc" && orderRaw !== "desc") {
    return { error: "Invalid parameter: 'order' must be one of: asc, desc" };
  }

  const rawLimit = singleParam(params, "limit");
  if (!rawLimit.ok) return { error: rawLimit.error };
  let limit = FILES_LIST_DEFAULT_LIMIT;
  if (rawLimit.value !== null) {
    // The digit gate runs BEFORE Number(), because Number() is far wider than
    // the "integer between 1 and 10,000" this branch's own error message
    // promises: it reads `0x10` as 16, `1e3` as 1000, and strips whitespace and
    // a leading sign, so `" 5"`, `"5\n"` and `"+5"` are all 5. Every one of
    // those is `Number.isInteger` and inside the range, so without the gate
    // `?limit=0x10` would page silently at 16 items. A caller sending any of
    // them has a bug, and a mock's job is to show it.
    //
    // Reject, never clamp: an out-of-range limit gets the same 400 as a
    // malformed one, so a suite asserting on page size is never quietly handed
    // a different size. (`?limit=` no longer reaches here — the empty value is
    // already a 400 in singleParam, with the same message every parameter
    // gets.)
    const parsed = parseStrictIntegerText(rawLimit.value);
    if (parsed === null || parsed < 1 || parsed > FILES_LIST_MAX_LIMIT) {
      return {
        error: `Invalid parameter: 'limit' must be an integer between 1 and ${FILES_LIST_MAX_LIMIT}`,
      };
    }
    limit = parsed;
  }

  const rawAfter = singleParam(params, "after");
  if (!rawAfter.ok) return { error: rawAfter.error };

  const rawPurpose = singleParam(params, "purpose");
  if (!rawPurpose.ok) return { error: rawPurpose.error };

  return {
    limit,
    order: orderRaw ?? "desc",
    after: rawAfter.value ?? undefined,
    purpose: rawPurpose.value ?? undefined,
  };
}

export async function handleFilesList(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  journal: Journal,
  defaults: { logger: Logger; chaos?: ChaosDefaults; registry?: MetricsRegistry },
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  const path = req.url ?? "/v1/files";
  const method = req.method ?? "GET";
  setCorsHeaders(res);

  if (
    await applyChaosAsync(
      res,
      null,
      defaults.chaos,
      req.headers,
      req.url,
      journal,
      { method, path, headers: flattenHeaders(req.headers), body: null, service: "files" },
      "internal",
      defaults.registry,
      defaults.logger,
    )
  ) {
    return;
  }

  const query = parseListQuery(path);
  if ("error" in query) {
    rejectFiles(
      res,
      journal,
      defaults.logger,
      method,
      path,
      flattenHeaders(req.headers),
      query.error,
      setCorsHeaders,
    );
    return;
  }

  let data = [...fileStore.values()];
  if (query.purpose !== undefined) {
    // `purpose` is an UNVALIDATED free-form string here, on purpose. The real
    // API does not constrain it: `listFiles` declares the query parameter as a
    // bare `type: string` with no `enum` in `openai/openai-openapi` (contrast
    // `order`, which carries `enum: [asc, desc]` in the very same parameter
    // list), and the SDK types it `purpose?: string` on `FileListParams` while
    // typing create as `purpose: FilePurpose` (openai@4.104.0,
    // resources/files.d.ts). So an unknown or server-side-only purpose is not a
    // 400: it simply matches no stored file and yields `{object: "list", data:
    // []}` with a 200, which is what this filter does.
    // {@link CREATE_PURPOSES} is not consulted.
    //
    // The one shape that is NOT a 200-with-an-empty-list is `?purpose=` with no
    // value: an empty string is not a purpose any stored file can carry, so
    // {@link singleParam} has already turned it into a 400 above, under the
    // same rule the other three list parameters get. Before that, its falsiness
    // skipped this filter entirely and the caller got the whole store back.
    data = data.filter((f) => f.purpose === query.purpose);
  }
  // `fileStore` iterates in creation order and `Array.prototype.sort` is stable,
  // so sorting on `created_at` alone still yields a *total* ascending order even
  // though the second-granularity timestamps tie constantly in a fast test. The
  // `desc` view is that exact order reversed — not a flipped comparator, which
  // would leave tied files in ascending order inside the descending page and
  // break the "every file exactly once" property of a cursor walk.
  data.sort((a, b) => a.created_at - b.created_at);
  if (query.order === "desc") data.reverse();

  let start = 0;
  if (query.after !== undefined) {
    const idx = data.findIndex((f) => f.id === query.after);
    if (idx === -1) {
      // The spec is silent on unknown cursors, so the mock fails loudly:
      // silently restarting at page 1 turns a caller's paging bug into an
      // infinite loop instead of a test failure. Note a cursor is resolved
      // against *this* listing, so a file excluded by `purpose` is unknown here.
      rejectFiles(
        res,
        journal,
        defaults.logger,
        method,
        path,
        flattenHeaders(req.headers),
        `Invalid parameter: 'after' cursor '${query.after}' does not match any file in this listing`,
        setCorsHeaders,
      );
      return;
    }
    start = idx + 1;
  }

  const page = data.slice(start, start + query.limit);
  writeJson(
    res,
    200,
    {
      object: "list",
      data: page,
      first_id: page[0]?.id ?? null,
      last_id: page[page.length - 1]?.id ?? null,
      has_more: start + page.length < data.length,
    },
    setCorsHeaders,
  );
  journalFiles(journal, method, path, flattenHeaders(req.headers), 200);
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
  // CORS before the chaos gate: applyChaosAsync short-circuits the response, so a
  // faulted retrieve would otherwise reach the browser with zero
  // Access-Control-* headers and be swallowed as a CORS error instead of the
  // 500 the chaos suite is trying to exercise. Create/list already did this.
  setCorsHeaders(res);

  if (
    await applyChaosAsync(
      res,
      null,
      defaults.chaos,
      req.headers,
      req.url,
      journal,
      { method, path, headers: flattenHeaders(req.headers), body: null, service: "files" },
      "internal",
      defaults.registry,
      defaults.logger,
    )
  ) {
    return;
  }

  const found = fileStore.get(fileId);
  if (!found) {
    writeJson(res, 404, invalidRequest(`No such file: ${fileId}`), setCorsHeaders);
    journalFiles(journal, method, path, flattenHeaders(req.headers), 404);
    return;
  }
  writeJson(res, 200, found, setCorsHeaders);
  journalFiles(journal, method, path, flattenHeaders(req.headers), 200);
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
  // CORS before the chaos gate — see handleFilesRetrieve.
  setCorsHeaders(res);

  if (
    await applyChaosAsync(
      res,
      null,
      defaults.chaos,
      req.headers,
      req.url,
      journal,
      { method, path, headers: flattenHeaders(req.headers), body: null, service: "files" },
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
    writeJson(res, 404, invalidRequest(`No such file: ${fileId}`), setCorsHeaders);
    journalFiles(journal, method, path, flattenHeaders(req.headers), 404);
    return;
  }
  res.writeHead(200, {
    // Derived from the STORED filename, never from the client-declared part
    // header — see CONTENT_TYPE_BY_EXT. nosniff stops a browser second-
    // guessing that decision and rendering opaque bytes as active content.
    "Content-Type": contentTypeForFilename(found.filename),
    "Content-Length": String(content.bytes.length),
    "X-Content-Type-Options": "nosniff",
    // Served as a download, never rendered inline — see contentDispositionFor.
    "Content-Disposition": contentDispositionFor(found.filename),
  });
  res.end(content.bytes);
  journalFiles(journal, method, path, flattenHeaders(req.headers), 200);
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
  // CORS before the chaos gate — see handleFilesRetrieve.
  setCorsHeaders(res);

  if (
    await applyChaosAsync(
      res,
      null,
      defaults.chaos,
      req.headers,
      req.url,
      journal,
      { method, path, headers: flattenHeaders(req.headers), body: null, service: "files" },
      "internal",
      defaults.registry,
      defaults.logger,
    )
  ) {
    return;
  }

  const found = fileStore.get(fileId);
  if (!found) {
    writeJson(res, 404, invalidRequest(`No such file: ${fileId}`), setCorsHeaders);
    journalFiles(journal, method, path, flattenHeaders(req.headers), 404);
    return;
  }
  fileStore.delete(fileId);
  fileContents.delete(fileId);
  writeJson(res, 200, { id: fileId, object: "file", deleted: true }, setCorsHeaders);
  journalFiles(journal, method, path, flattenHeaders(req.headers), 200);
}
