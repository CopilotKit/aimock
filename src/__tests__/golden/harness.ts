/**
 * Golden byte corpus harness.
 *
 * The corpus pins the exact bytes aimock writes for a request: status, headers
 * and raw body, or the full ordered frame sequence for SSE, NDJSON and AWS
 * event-stream responses. Prep refactors must leave every golden unchanged.
 *
 * ── Adding a case ────────────────────────────────────────────────────────────
 *
 *   // src/__tests__/golden/<area>.golden.test.ts
 *   import { afterAll, beforeAll, it } from "vitest";
 *   import { captureHttp, expectGolden, startGoldenServer, type GoldenServer } from "./harness.js";
 *
 *   let srv: GoldenServer;
 *   beforeAll(async () => { srv = await startGoldenServer([fixtureA, fixtureB]); });
 *   afterAll(async () => { await srv.close(); });
 *
 *   it("messages-stream-no-usage", async () => {
 *     const got = await captureHttp(`${srv.url}/v1/messages`, {
 *       method: "POST",
 *       headers: { "content-type": "application/json" },
 *       body: JSON.stringify({ model: "claude-sonnet-4-5", stream: true, ... }),
 *       frames: "sse",
 *     });
 *     expectGolden("<area>", "messages-stream-no-usage", got);
 *   });
 *
 * Then write the golden once with `pnpm golden:capture` (optionally passing the
 * test file), and read every new file under `__snapshots__/<area>/` by eye for
 * an id or timestamp that escaped normalization. Commit the goldens.
 *
 * ── Rules ────────────────────────────────────────────────────────────────────
 *
 * - Goldens are read-only to the test run. `expectGolden` writes a file only
 *   when ALL of these hold: `GOLDEN_WRITE=1`, `GOLDEN_CAPTURE_RUN=1`, and `CI`
 *   unset or falsy (`""`, `0`, `false`). `pnpm golden:capture`
 *   (`scripts/capture-golden.ts`) is the supported way to set them.
 *   `GOLDEN_WRITE=1` without the other two makes `expectGolden` throw, so a
 *   stray export cannot make `pnpm test` overwrite goldens and pass. A missing
 *   golden fails. `vitest -u` has no effect (no vitest snapshots).
 * - Every golden written is appended, as an absolute path plus `\n`, to the
 *   file named by `GOLDEN_WRITE_LOG` when that variable is set.
 * - Comparison is byte-exact after `serializeGolden` normalization (see below
 *   for placeholder numbering). Only explicitly selected native-parser body
 *   fields may adapt the demonstrated diagnostic suffix. Actual captures,
 *   serialized bytes and golden files remain unchanged.
 * - One file per case: `__snapshots__/<suite>/<case>.json`.
 * - Goldens are excluded from prettier (`.prettierignore`) so a formatter can
 *   never rewrite them.
 *
 * ── What is normalized (and nothing else) ───────────────────────────────────
 *
 * aimock mints random ids and reads the wall clock, so these values differ on
 * every run. `normalize` replaces exactly these, and leaves every other byte:
 *
 *   1. Minted ids: `<prefix>-` or `<prefix>_` followed by exactly 16
 *      base64url characters (what every `randomBytes(12).toString("base64url")`
 *      minter in src produces: `generateId`, `generateMessageId`,
 *      `generateToolUseId`, `generateToolCallId`, batches/vector-stores
 *      `underscoreId`, ws-realtime `realtimeId`, responses
 *      `customToolCallItemId`), for the prefixes in `ID_PREFIXES`. A self-test
 *      derives the prefix set from src and fails when one is missing. The id
 *      may be followed by a suffix that starts with `-` or `_` (`call_<16>_1`);
 *      it must not be followed by a letter or digit. Fixture-authored ids such
 *      as `toolu_fixed_1` are not 16 characters and stay as written.
 *   2. UUIDs (8-4-4-4-12 hex), also behind a dash prefix (`cgt-<uuid>`).
 *      For rules 1 and 2, a JSON escape right before the value (`\n`, `\t`,
 *      `\r`, `\b`, `\f`, `\uXXXX`) does not count as a letter or digit, so an
 *      id at the start of a line is still found.
 *      Rules 1 and 2 share one placeholder sequence: `<prefix><sep><#n>` and
 *      `<uuid#n>`, numbered by first appearance, so "the same id appears
 *      twice" is still pinned and two different ids never share a number.
 *   3. ISO-8601 date-times (`2026-01-02T03:04:05`, optional fraction, optional
 *      zone `Z`, `+hh:mm`, `+hhmm`, `-hh:mm` or `-hhmm`) -> `<iso-date>`.
 *   4. Unix epoch numbers that are the value of a JSON key in `EPOCH_KEYS`
 *      AND read the current wall clock: 10 digits (seconds) or 13 digits (ms)
 *      no more than `EPOCH_PAST_WINDOW_MS` (1 day) before now and no more than
 *      `EPOCH_FUTURE_WINDOW_MS` (400 days) after now -> the string
 *      `"<epoch>"`. The forward window covers expiries aimock computes as
 *      "now + offset" (vector-store `expires_after.days` is at most 365). The
 *      key may be quoted at any JSON-string escape depth (`"k"`, `\"k\"`,
 *      `\\\"k\\\"`, ...). A constant such as the `created: 1686935002` on
 *      default `/v1/models` entries, or a value under any other key, is kept
 *      and pinned. Hazard: a fixture-authored constant that happens to fall
 *      inside the window at capture time is normalized, and its golden fails
 *      once the window has passed; keep fixture timestamps far from "now".
 *      Not covered: epochs with no key (e.g. `mock-song-<Date.now()>`) and
 *      elapsed durations; a case that hits those must mask them itself.
 *
 * Headers: names lowercased and sorted; `date`, `connection`, `keep-alive` and
 * `transfer-encoding` are dropped (transport/timing, not aimock output); a
 * repeated name is joined with `, ` in arrival order; every remaining value
 * goes through `normalize` (so `x-request-id: req-<16>` becomes `req-<#n>`).
 * `content-length` is kept verbatim and pins body size. It is deterministic
 * because the raw values aimock mints for rules 1-4 have a fixed length
 * (16-char ids, UUIDs, `toISOString()`, 10/13-digit epochs); placeholders
 * themselves do not (`<#9>` vs `<#10>`), but content-length counts raw bytes.
 * A case that masks a variable-length value itself (rule 4's "not covered")
 * must also mask `content-length`.
 *
 * Bodies and AWS payloads are decoded as strict UTF-8 (a BOM is kept). Bytes
 * that are not valid UTF-8 are recorded as base64 (`bodyBase64`,
 * `payloadBase64`) instead of lossy text.
 *
 * The clock is NOT frozen: faking `Date` in-process would also freeze the
 * server's own deadline arithmetic. Rules 3 and 4 cover the clock instead.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";
import { expect } from "vitest";
import { createServer, type ServerInstance } from "../../server.js";
import type { Fixture, MockServerOptions } from "../../types.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/** One decoded AWS event-stream frame. */
export interface AwsEventStreamFrame {
  /** Frame headers in wire order (`:event-type`, `:message-type`, ...). */
  headers: Record<string, string>;
  /**
   * The payload bytes as UTF-8 text, normalized; absent when they are not
   * valid UTF-8 (see `payloadBase64`). When the payload is a JSON object with
   * a string `bytes` member (Bedrock `chunk` frames), that value must be
   * lossless base64 of UTF-8 (re-encoding `decodedBytes` gives back the
   * original base64 exactly, else the decoder throws), and it is replaced by
   * the literal `<base64:decodedBytes>`, so nothing is lost.
   */
  payload?: string;
  /** UTF-8 text of the base64 `bytes` member, normalized. */
  decodedBytes?: string;
  /**
   * The payload bytes as base64, in place of `payload`, when they are not
   * valid UTF-8 (lossy text would let different bytes give the same golden).
   */
  payloadBase64?: string;
}

/** What one HTTP exchange produced, normalized and ready for `expectGolden`. */
export interface CapturedExchange {
  status: number;
  /** Lowercased, sorted, filtered and normalized (see file header). */
  headers: Record<string, string>;
  /**
   * Raw body text, normalized. Absent when `frames` is used, and when the
   * body is not valid UTF-8 (see `bodyBase64`).
   */
  body?: string;
  /**
   * The raw body as base64, when it is not valid UTF-8, in place of `body`
   * or SSE/NDJSON `frames`/`tail` (lossy text would let different bytes give
   * the same golden). Never normalized in practice: base64 has no `_`, `:`
   * or `-`, so it cannot hold an id, ISO date or keyed epoch.
   */
  bodyBase64?: string;
  /**
   * Complete frames, in order. SSE: each raw block between `\n\n` separators
   * (e.g. `event: x\ndata: {...}`). NDJSON: each line. AWS: each decoded
   * frame. For SSE/NDJSON, `frames.map((f) => f + sep).join("") + (tail ?? "")`
   * rebuilds the body as normalized inside this capture (also with zero
   * frames). Placeholders are numbered in the capture's one sequence, which
   * starts with `status` and `headers`, so an id that also appears in a
   * header keeps that header's number; the rebuild is not `normalize(body)`
   * on its own. AWS frames are decoded objects, so there is no text formula
   * for them.
   */
  frames?: string[] | AwsEventStreamFrame[];
  /**
   * Bytes after the last complete frame, present only when non-empty (a
   * truncated or unterminated stream). Text for SSE/NDJSON; base64 for AWS.
   */
  tail?: string;
}

export type FrameMode = "sse" | "ndjson" | "aws";

export interface GoldenServer {
  url: string;
  /** The underlying server (journal, defaults, ...). */
  instance: ServerInstance;
  close(): Promise<void>;
}

// ─── Normalization ──────────────────────────────────────────────────────────

/**
 * Every prefix src passes to a 16-char base64url id minter (see rule 1). The
 * self-test "covers every prefix src passes..." re-derives this from src.
 */
export const ID_PREFIXES = [
  "batch",
  "batch_req",
  "call",
  "chatcmpl",
  "cmpl",
  "ctc",
  "ctx",
  "event",
  "fc",
  "file",
  "ftjob",
  "ig",
  "item",
  "modr",
  "msg",
  "req",
  "rerank",
  "resp",
  "rs",
  "sess",
  "task",
  "toolu",
  "vs",
  "vsfb",
  "ws",
] as const;

/** JSON keys whose numeric value is a wall-clock epoch (seconds or ms). */
export const EPOCH_KEYS = [
  "cancelled_at",
  "cancelling_at",
  "completed_at",
  "completedAt",
  "created",
  "created_at",
  "createdAt",
  "expired_at",
  "expires_at",
  "failed_at",
  "finalizing_at",
  "finished_at",
  "in_progress_at",
  "last_active_at",
  "modified_at",
  "started_at",
  "submittedAt",
  "timestamp",
  "updated_at",
  "updatedAt",
] as const;

/**
 * Timestamp-shaped keys src writes that are deliberately NOT epoch keys, with
 * the reason. The self-test fails on a timestamp-shaped key in neither list.
 */
export const NON_EPOCH_KEYS: Readonly<Record<string, string>> = {
  acceptedAt: "live-fixture position object, not a number",
  arrivedAt: "internal performance.now() bookkeeping, never on the wire",
  deprecated_at: "Anthropic model optional metadata, always null in synthetic catalogs",
  expiresAt: "AG-UI ISO string (rule 3)",
  observedAt: "ISO string (rule 3)",
  retires_at: "Anthropic model optional metadata, always null in synthetic catalogs",
};

/** Longest first, so `batch_req` wins over `batch` and `vsfb` over `vs`. */
const PREFIX_ALT = [...ID_PREFIXES].sort((a, b) => b.length - a.length).join("|");
/**
 * Right after a JSON escape (`\n`, `\t`, `\r`, `\b`, `\f`, `\uXXXX`): the
 * escape letter or hex digit is not part of the text, so it must not block a
 * match. The backslash before it is the odd one of its run (`\\n` is an
 * escaped backslash and a real `n`).
 */
const AFTER_ESCAPE = String.raw`(?<=(?<!\\)(?:\\\\)*\\(?:[bfnrt]|u[0-9a-fA-F]{4}))`;
const ID_SRC = `(?:(?<![A-Za-z0-9])|${AFTER_ESCAPE})(${PREFIX_ALT})([-_])[A-Za-z0-9_-]{16}(?![A-Za-z0-9])`;
const UUID_SRC = `(?:(?<![0-9a-fA-F])|${AFTER_ESCAPE})[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![0-9a-fA-F])`;
/** Ids and UUIDs in one pass, so numbering follows first appearance. */
const ID_OR_UUID_RE = new RegExp(`${ID_SRC}|${UUID_SRC}`, "g");
const ISO_RE =
  /(?<!\d)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?(?![\d:])/g;
/** `(\\*")` is the key's opening quote at any escape depth; `\1` closes it. */
const EPOCH_RE = new RegExp(
  `(?<!\\\\)(\\\\*")(${EPOCH_KEYS.join("|")})\\1(\\s*:\\s*)(\\d{13}|\\d{10})(?![\\d.])`,
  "g",
);

/** How far before now a keyed epoch may be and still count as "read the clock". */
export const EPOCH_PAST_WINDOW_MS = 24 * 60 * 60 * 1000;
/** How far after now a keyed epoch may be (expiries computed as now + offset). */
export const EPOCH_FUTURE_WINDOW_MS = 400 * 24 * 60 * 60 * 1000;

function isNow(digits: string): boolean {
  const ms = digits.length === 13 ? Number(digits) : Number(digits) * 1000;
  const now = Date.now();
  return ms >= now - EPOCH_PAST_WINDOW_MS && ms <= now + EPOCH_FUTURE_WINDOW_MS;
}

/**
 * Placeholder numbering shared by every string normalized through one
 * context. Numbers follow first appearance across all of them.
 */
export class NormalizeContext {
  private readonly ids = new Map<string, string>();
  /** @param startAt first placeholder number (to continue past existing ones). */
  constructor(private readonly startAt = 0) {}
  placeholder(value: string, render: (n: number) => string): string {
    let got = this.ids.get(value);
    if (got === undefined) {
      got = render(this.startAt + this.ids.size);
      this.ids.set(value, got);
    }
    return got;
  }
}

/**
 * Replace minted ids, UUIDs, ISO date-times and epoch values with stable
 * placeholders (rules 1-4 in the file header). Idempotent. Pass one
 * `NormalizeContext` for every string that must share numbering; without
 * one, numbering starts at 0 for this call.
 */
export function normalize(text: string, ctx: NormalizeContext = new NormalizeContext()): string {
  return text
    .replace(ID_OR_UUID_RE, (m: string, prefix?: string, sep?: string) =>
      prefix === undefined
        ? ctx.placeholder(m, (n) => `<uuid#${n}>`)
        : ctx.placeholder(m, (n) => `${prefix}${sep}<#${n}>`),
    )
    .replace(ISO_RE, "<iso-date>")
    .replace(EPOCH_RE, (m: string, q: string, key: string, colon: string, digits: string) =>
      isNow(digits) ? `${q}${key}${q}${colon}${q}<epoch>${q}` : m,
    );
}

const DROPPED_HEADERS = new Set(["date", "connection", "keep-alive", "transfer-encoding"]);

/** Lowercase, drop transport/timing headers, sort, join repeats, normalize values. */
export function normalizeHeaders(
  entries: Iterable<[string, string]>,
  ctx: NormalizeContext = new NormalizeContext(),
): Record<string, string> {
  return normalizeTree(rawHeaders(entries), ctx);
}

function rawHeaders(entries: Iterable<[string, string]>): Record<string, string> {
  const kept: Array<[string, string]> = [];
  for (const [name, value] of entries) {
    const lower = name.toLowerCase();
    if (DROPPED_HEADERS.has(lower)) continue;
    kept.push([lower, value]);
  }
  // Stable sort: repeated names keep their arrival order.
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  // Null prototype: `constructor` and `__proto__` are plain header names here.
  const out = Object.create(null) as Record<string, string>;
  for (const [name, value] of kept) {
    out[name] = Object.hasOwn(out, name) ? `${out[name]}, ${value}` : value;
  }
  return out;
}

/**
 * Normalize every string in a JSON-safe value in one pass over its JSON text,
 * so numbering follows serialization order (the order `serializeGolden` sees).
 */
function normalizeTree<T>(value: T, ctx: NormalizeContext = new NormalizeContext()): T {
  return JSON.parse(normalize(JSON.stringify(value), ctx)) as T;
}

// ─── Raw captures ───────────────────────────────────────────────────────────

/**
 * Each `CapturedExchange` keeps its un-normalized twin under this
 * (non-enumerable) key, so `serializeGolden` can number every part of one
 * golden in one sequence. A spread copy (`{ ...got }`) does not carry it.
 */
const RAW = Symbol("golden.raw");

function finalize(raw: CapturedExchange): CapturedExchange {
  const out = normalizeTree(raw);
  Object.defineProperty(out, RAW, { value: raw, enumerable: false });
  return out;
}

// ─── Frame splitting ────────────────────────────────────────────────────────

function splitText(text: string, sep: string): { frames: string[]; tail?: string } {
  const frames = text.split(sep);
  const rest = frames.pop() ?? "";
  return rest === "" ? { frames } : { frames, tail: rest };
}

/** Strict UTF-8: invalid bytes throw instead of becoming U+FFFD; a BOM is kept. */
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** `buf` as text when it is valid UTF-8, else undefined. */
function utf8(buf: Uint8Array): string | undefined {
  try {
    return UTF8.decode(buf);
  } catch {
    return undefined;
  }
}

/**
 * Decode AWS event-stream frames (the layout in `src/aws-event-stream.ts`).
 * Throws on a CRC mismatch, a non-string header, a repeated header name, a
 * header name or value that is not UTF-8, a total length under 16 (checked
 * first, even when fewer bytes remain), a length that overruns its frame or
 * block, a `bytes` member that is not lossless base64 of UTF-8, and a `bytes`
 * value that does not appear exactly once in the payload text. Every message
 * starts with `event-stream frame at byte <offset>`. A trailing partial frame
 * (fewer than 4 bytes left, or fewer than its declared total) is returned as
 * `tail` (base64), not thrown, so a deliberately truncated stream can still be
 * pinned. A payload that is not UTF-8 is returned as `payloadBase64`.
 */
export function decodeAwsEventStream(
  buf: Buffer,
  ctx: NormalizeContext = new NormalizeContext(),
): { frames: AwsEventStreamFrame[]; tail?: string } {
  return normalizeTree(decodeAwsEventStreamRaw(buf), ctx);
}

function decodeAwsEventStreamRaw(buf: Buffer): { frames: AwsEventStreamFrame[]; tail?: string } {
  const frames: AwsEventStreamFrame[] = [];
  let offset = 0;
  while (buf.length - offset >= 4) {
    const total = buf.readUInt32BE(offset);
    const where = `event-stream frame at byte ${offset}`;
    // Before the truncation check: a corrupt length must not pass as a tail.
    if (total < 16) throw new Error(`${where}: total length ${total} is under the 16-byte minimum`);
    if (offset + total > buf.length) break; // truncated: becomes the tail
    const frame = buf.subarray(offset, offset + total);
    if (crc32(frame.subarray(0, 8)) >>> 0 !== frame.readUInt32BE(8)) {
      throw new Error(`${where}: prelude CRC mismatch`);
    }
    if (crc32(frame.subarray(0, total - 4)) >>> 0 !== frame.readUInt32BE(total - 4)) {
      throw new Error(`${where}: message CRC mismatch`);
    }
    const headersLength = frame.readUInt32BE(4);
    const headersEnd = 12 + headersLength;
    if (headersEnd > total - 4) {
      throw new Error(`${where}: headers length ${headersLength} runs past the frame`);
    }
    // Null prototype: a `__proto__` header is kept like any other name.
    const headers = Object.create(null) as Record<string, string>;
    let h = 12;
    const take = (n: number, what: string): number => {
      if (h + n > headersEnd) throw new Error(`${where}: ${what} overruns the headers block`);
      const at = h;
      h += n;
      return at;
    };
    while (h < headersEnd) {
      const nameLen = frame.readUInt8(take(1, "header name length"));
      const nameAt = take(nameLen, "header name");
      const name = utf8(frame.subarray(nameAt, nameAt + nameLen));
      if (name === undefined) throw new Error(`${where}: header name is not valid UTF-8`);
      const type = frame.readUInt8(take(1, `header "${name}" type`));
      if (type !== 7) {
        throw new Error(`${where}: header "${name}": type ${type} not supported (string only)`);
      }
      const valueLen = frame.readUInt16BE(take(2, `header "${name}" value length`));
      const valueAt = take(valueLen, `header "${name}" value`);
      if (Object.hasOwn(headers, name)) throw new Error(`${where}: duplicate header "${name}"`);
      const value = utf8(frame.subarray(valueAt, valueAt + valueLen));
      if (value === undefined)
        throw new Error(`${where}: header "${name}" value is not valid UTF-8`);
      headers[name] = value;
    }
    const payloadBytes = frame.subarray(headersEnd, total - 4);
    const payloadText = utf8(payloadBytes);
    frames.push(
      payloadText === undefined
        ? { headers, payloadBase64: payloadBytes.toString("base64") }
        : decodePayload(headers, payloadText, where),
    );
    offset += total;
  }
  return offset < buf.length
    ? { frames, tail: buf.subarray(offset).toString("base64") }
    : { frames };
}

function decodePayload(
  headers: Record<string, string>,
  payloadText: string,
  where: string,
): AwsEventStreamFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadText);
  } catch {
    return { headers, payload: payloadText };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { headers, payload: payloadText };
  }
  const b64 = (parsed as Record<string, unknown>).bytes;
  if (typeof b64 !== "string") return { headers, payload: payloadText };
  const decoded = Buffer.from(b64, "base64").toString("utf8");
  if (Buffer.from(decoded, "utf8").toString("base64") !== b64) {
    throw new Error(`${where}: payload "bytes" is not lossless base64 of UTF-8: ${b64}`);
  }
  // Replace the one base64 string in the raw text; the rest stays byte-exact.
  const quoted = JSON.stringify(b64);
  const at = payloadText.indexOf(quoted);
  if (at < 0 || payloadText.indexOf(quoted, at + 1) >= 0) {
    throw new Error(`${where}: payload: cannot locate "bytes" value uniquely: ${payloadText}`);
  }
  const payload =
    payloadText.slice(0, at) + '"<base64:decodedBytes>"' + payloadText.slice(at + quoted.length);
  return { headers, payload, decodedBytes: decoded };
}

// ─── Server and capture ─────────────────────────────────────────────────────

/**
 * Start aimock on 127.0.0.1, port 0, `latency: 0`, `chunkSize: 20`, logging
 * silent. `opts` is spread last; override the fixed values only when a case
 * is about them.
 */
export async function startGoldenServer(
  fixtures: Fixture[],
  opts?: Partial<MockServerOptions>,
): Promise<GoldenServer> {
  const instance = await createServer(fixtures, {
    port: 0,
    host: "127.0.0.1",
    latency: 0,
    chunkSize: 20,
    logLevel: "silent",
    ...opts,
  });
  return {
    url: instance.url,
    instance,
    close: () => closeServer(instance.server),
  };
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
    server.closeAllConnections();
  });
}

/**
 * Send one request with `fetch` and capture the response. `frames` picks how
 * the body is split; without it the body is kept as one normalized string.
 *
 * Captures what the server sent: redirects are not followed (`redirect:
 * "manual"`), and `accept-encoding: identity` is sent unless the caller sets
 * one. `fetch` always decodes a `content-encoding`, so a response that has one
 * throws instead of pinning decoded bytes. A body cut short (reset, abort,
 * short `content-length`) makes `fetch` reject, which fails the capture.
 *
 * A response that has not ended within `timeoutMs` (default
 * `CAPTURE_HTTP_TIMEOUT_MS`) is aborted and fails with the status and the
 * body bytes received so far. A caller `signal` still applies as well.
 */
export async function captureHttp(
  url: string,
  init: RequestInit & { frames?: FrameMode; timeoutMs?: number } = {},
): Promise<CapturedExchange> {
  const { frames: mode, timeoutMs = CAPTURE_HTTP_TIMEOUT_MS, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (!headers.has("accept-encoding")) headers.set("accept-encoding", "identity");
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  const signal = rest.signal ? AbortSignal.any([rest.signal, timeout.signal]) : timeout.signal;
  const chunks: Buffer[] = [];
  let res: Response | undefined;
  try {
    res = await fetch(url, { ...rest, headers, redirect: "manual", signal });
    const encoding = res.headers.get("content-encoding");
    if (encoding !== null && encoding.toLowerCase() !== "identity") {
      await res.body?.cancel();
      throw new Error(
        `captureHttp: response has content-encoding "${encoding}"; fetch would decode it, ` +
          `so the bytes the server sent cannot be pinned`,
      );
    }
    // Read incrementally, so a timeout can report what arrived.
    const reader = res.body?.getReader();
    for (;;) {
      const next = await reader?.read();
      if (next === undefined || next.done) break;
      chunks.push(Buffer.from(next.value));
    }
  } catch (err) {
    if (!timeout.signal.aborted) throw err;
    throw new Error(
      `captureHttp: no end within ${timeoutMs}ms; status ${res?.status ?? "<none>"}; ` +
        `got: ${Buffer.concat(chunks).toString()}`,
    );
  } finally {
    clearTimeout(timer);
  }
  const raw = Buffer.concat(chunks);
  return finalize({
    status: res.status,
    headers: rawHeaders(res.headers.entries()),
    ...splitBody(raw, mode),
  });
}

function splitBody(
  raw: Buffer,
  mode: FrameMode | undefined,
): Pick<CapturedExchange, "body" | "bodyBase64" | "frames" | "tail"> {
  if (mode === "aws") return decodeAwsEventStreamRaw(raw);
  const text = utf8(raw);
  if (text === undefined) return { bodyBase64: raw.toString("base64") };
  if (mode === "sse") return splitText(text, "\n\n");
  if (mode === "ndjson") return splitText(text, "\n");
  return { body: text };
}

/**
 * Default `captureRawHttp` timeout: well under vitest's 5000 ms test timeout,
 * so its descriptive error (with the bytes received) is what a hang reports.
 */
export const RAW_HTTP_TIMEOUT_MS = 2000;

/** Default `captureHttp` timeout, for the same reason as `RAW_HTTP_TIMEOUT_MS`. */
export const CAPTURE_HTTP_TIMEOUT_MS = 2000;

interface RawHead {
  status: number;
  entries: Array<[string, string]>;
  body: Buffer;
}

/**
 * The final response head. Interim 1xx heads (100 Continue, 103 Early Hints,
 * ...) are checked and skipped; 101 Switching Protocols is final.
 */
function parseRawHead(data: Buffer): RawHead | undefined {
  let at = 0;
  for (;;) {
    const headEnd = data.indexOf("\r\n\r\n", at);
    if (headEnd < 0) return undefined;
    const lines = data.subarray(at, headEnd).toString("utf8").split("\r\n");
    const [statusLine, ...headerLines] = lines;
    const m = /^HTTP\/1\.[01] (\d{3})/.exec(statusLine ?? "");
    if (!m) throw new Error(`captureRawHttp: bad status line: ${statusLine}`);
    const entries = headerLines.map((line): [string, string] => {
      const colon = line.indexOf(":");
      if (colon <= 0) throw new Error(`captureRawHttp: header line without ":" name: ${line}`);
      return [line.slice(0, colon), line.slice(colon + 1).trim()];
    });
    const status = Number(m[1]);
    at = headEnd + 4;
    if (status >= 100 && status < 200 && status !== 101) continue;
    return { status, entries, body: data.subarray(at) };
  }
}

/** The request method (first token of `rawRequest`), uppercased. */
function requestMethod(rawRequest: string): string {
  return (/^\S+/.exec(rawRequest)?.[0] ?? "").toUpperCase();
}

/**
 * The response body, or an error string when the bytes do not hold a
 * complete response. `cleanClose`: the server ended the connection normally,
 * which completes a body that has neither `content-length` nor chunking.
 * A response to HEAD, a 204 and a 304 have no body whatever their headers
 * say (RFC 9112 6.3), so any byte after their head is an error.
 */
function rawBody(head: RawHead, cleanClose: boolean, method: string): Buffer | string {
  if (method === "HEAD" || head.status === 204 || head.status === 304) {
    if (head.body.length === 0) return head.body;
    const what = method === "HEAD" ? "HEAD" : String(head.status);
    return `captureRawHttp: ${head.body.length} bytes after a bodyless ${what} response`;
  }
  const header = (n: string) => head.entries.find(([k]) => k.toLowerCase() === n)?.[1];
  if (/\bchunked\b/i.test(header("transfer-encoding") ?? "")) {
    try {
      return dechunk(head.body);
    } catch (err) {
      return (err as Error).message;
    }
  }
  const length = header("content-length");
  if (length !== undefined) {
    const want = Number(length);
    if (head.body.length !== want) {
      return `captureRawHttp: body has ${head.body.length} of ${want} content-length bytes`;
    }
    return head.body;
  }
  return cleanClose ? head.body : "captureRawHttp: close-delimited body ended by an error";
}

/**
 * Write `rawRequest` (a complete HTTP/1.1 request, CRLF line endings) to a raw
 * TCP socket and capture whatever the server writes back until it closes the
 * connection. For responses `fetch` cannot see, e.g. a rejected WebSocket
 * upgrade written straight to the socket. Interim 1xx responses are skipped;
 * the final response is captured. Fails when the response is incomplete: no
 * header terminator, fewer body bytes than `content-length`, malformed or
 * unterminated chunking, bytes after a bodyless (HEAD/204/304) response, or a
 * socket error before a body with no declared length ended. A socket error
 * AFTER a complete response is ignored; one before it reports why the bytes
 * so far are incomplete. A body that is not valid UTF-8 is recorded as
 * `bodyBase64`.
 */
export async function captureRawHttp(
  url: string,
  rawRequest: string,
  timeoutMs = RAW_HTTP_TIMEOUT_MS,
): Promise<CapturedExchange> {
  const { hostname, port } = new URL(url);
  const method = requestMethod(rawRequest);
  const { data, cleanClose } = await new Promise<{ data: Buffer; cleanClose: boolean }>(
    (resolve, reject) => {
      const chunks: Buffer[] = [];
      const sock = net.connect(Number(port), hostname, () => sock.write(rawRequest));
      const timer = setTimeout(() => {
        sock.destroy();
        reject(
          new Error(
            `captureRawHttp: no close within ${timeoutMs}ms; got: ${Buffer.concat(chunks).toString()}`,
          ),
        );
      }, timeoutMs);
      sock.on("data", (c: Buffer) => chunks.push(c));
      sock.on("error", (err) => {
        clearTimeout(timer);
        const data = Buffer.concat(chunks);
        // Why the bytes so far are not a complete response ("" when they are).
        let incomplete: string;
        try {
          const head = parseRawHead(data);
          const body = head && rawBody(head, false, method);
          incomplete =
            body === undefined
              ? "captureRawHttp: no header terminator"
              : typeof body === "string"
                ? body
                : "";
        } catch (parseErr) {
          incomplete = (parseErr as Error).message;
        }
        if (incomplete === "") resolve({ data, cleanClose: false });
        else {
          reject(
            new Error(
              `captureRawHttp: ${err.message} before the response was complete ` +
                `(incomplete: ${incomplete}); got: ${data.toString()}`,
            ),
          );
        }
      });
      sock.on("close", (hadError) => {
        if (hadError) return; // settled by the error listener
        clearTimeout(timer);
        resolve({ data: Buffer.concat(chunks), cleanClose: true });
      });
    },
  );
  const head = parseRawHead(data);
  if (head === undefined) {
    throw new Error(`captureRawHttp: no header terminator in: ${data.toString()}`);
  }
  const body = rawBody(head, cleanClose, method);
  if (typeof body === "string") throw new Error(`${body}; got: ${data.toString()}`);
  // The body is de-chunked so it matches what `captureHttp` records for the
  // same response (`transfer-encoding` is dropped from headers in both).
  const text = utf8(body);
  return finalize({
    status: head.status,
    headers: rawHeaders(head.entries),
    ...(text === undefined ? { bodyBase64: body.toString("base64") } : { body: text }),
  });
}

/**
 * Decode an HTTP/1.1 chunked body. Throws on a size line that is not pure hex
 * (an optional `;extension` is allowed, after optional spaces or tabs, as RFC
 * 9112 BWS permits; whitespace with no extension is not), a missing CRLF after chunk data, a
 * missing terminating chunk or final CRLF (truncation), and bytes after the
 * end of the body. Trailers are checked for framing and dropped.
 */
export function dechunk(buf: Buffer): Buffer {
  const parts: Buffer[] = [];
  let at = 0;
  for (;;) {
    const lineEnd = buf.indexOf("\r\n", at);
    if (lineEnd < 0) throw new Error("captureRawHttp: truncated chunked body (no size line)");
    const line = buf.subarray(at, lineEnd).toString("latin1");
    // RFC 9112 7.1.1: chunk-size [ BWS ";" chunk-ext ]. Whitespace is legal
    // only before an extension, never around a bare size.
    const sizeMatch = /^([0-9a-fA-F]+)(?:[ \t]*;.*)?$/.exec(line);
    if (!sizeMatch) throw new Error(`captureRawHttp: bad chunk size line "${line}"`);
    const size = parseInt(sizeMatch[1]!, 16);
    const dataAt = lineEnd + 2;
    if (size === 0) {
      let t = dataAt;
      for (;;) {
        const end = buf.indexOf("\r\n", t);
        if (end < 0) throw new Error("captureRawHttp: truncated chunked body (no final CRLF)");
        if (end === t) {
          if (end + 2 !== buf.length) {
            throw new Error(`captureRawHttp: ${buf.length - end - 2} bytes after the chunked body`);
          }
          return Buffer.concat(parts);
        }
        t = end + 2;
      }
    }
    if (dataAt + size + 2 > buf.length) {
      throw new Error(`captureRawHttp: truncated chunked body (chunk of ${size} bytes)`);
    }
    if (buf[dataAt + size] !== 0x0d || buf[dataAt + size + 1] !== 0x0a) {
      throw new Error(`captureRawHttp: no CRLF after chunk of ${size} bytes at byte ${dataAt}`);
    }
    parts.push(buf.subarray(dataAt, dataAt + size));
    at = dataAt + size + 2;
  }
}

// ─── Stub upstream (record-mode cases) ─────────────────────────────────────

export interface StubRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface StubUpstream {
  url: string;
  /** Every request the stub received, in order (e.g. to pin "was it hit"). */
  requests: StubRequest[];
  /**
   * Every error a handler threw (sync or async), and every request stream
   * error (e.g. the client reset mid-body), in order.
   */
  errors: unknown[];
  /**
   * Stops the stub. Rejects with every error in `errors` that the
   * `expectGolden` check has not already reported.
   */
  close(): Promise<void>;
}

/**
 * The not-yet-reported error messages of each open stub. `expectGolden`
 * drains them all; `close()` drains its own and removes its queue, so an
 * error is reported exactly once and never leaks into a later test.
 */
const openStubQueues = new Set<string[]>();

/**
 * A canned upstream on 127.0.0.1, port 0, for record-mode cases.
 *
 * A handler that throws (sync or async) is a test bug, not upstream
 * behavior, so it must never become a pinned response: the connection is
 * destroyed (no 500 is written) and the error is recorded in `errors`. A
 * request stream error is recorded the same way. Each error is then reported
 * once, by whichever comes first: the next `expectGolden` call (which throws
 * it before comparing or writing) or this stub's `close()` (which rejects
 * with it). Messages say which kind it was: `stub upstream handler threw: ...`
 * or `stub upstream request stream failed: ...`. An error raised after
 * `close()` (a handler still running) is kept in `errors` only.
 */
export async function startStubUpstream(
  handler: (req: StubRequest, res: http.ServerResponse) => void | Promise<void>,
): Promise<StubUpstream> {
  const requests: StubRequest[] = [];
  const errors: unknown[] = [];
  const unreported: string[] = [];
  openStubQueues.add(unreported);
  const fail = (label: string, err: unknown, res?: http.ServerResponse) => {
    errors.push(err);
    unreported.push(`stub upstream ${label}: ${String(err)}`);
    res?.destroy();
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("error", (err) => fail("request stream failed", err, res));
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const stubReq: StubRequest = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(stubReq);
      Promise.resolve()
        .then(() => handler(stubReq, res))
        .catch((err: unknown) => fail("handler threw", err, res));
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (err) {
    openStubQueues.delete(unreported);
    throw err;
  }
  const addr = server.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    requests,
    errors,
    close: async () => {
      let closeError: unknown;
      try {
        await closeServer(server);
      } catch (err) {
        closeError = err;
      }
      openStubQueues.delete(unreported);
      const messages = unreported.splice(0);
      if (closeError !== undefined)
        messages.push(`stub upstream close failed: ${String(closeError)}`);
      if (messages.length > 0) throw new Error(messages.join("; "));
    },
  };
}

// ─── Golden files ───────────────────────────────────────────────────────────

const SNAPSHOT_ROOT = fileURLToPath(new URL("./__snapshots__/", import.meta.url));
const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
let snapshotRoot = SNAPSHOT_ROOT;

/**
 * Harness self-tests only: make `goldenPath` (and so `expectGolden`) use
 * `dir` instead of `__snapshots__/`, so self-test writes never land in the
 * corpus. `undefined` restores the real root.
 */
export function setGoldenRootForSelfTest(dir: string | undefined): void {
  snapshotRoot = dir ?? SNAPSHOT_ROOT;
}

/** Absolute path of the golden for `suite`/`caseName`. */
export function goldenPath(suite: string, caseName: string): string {
  for (const [label, v] of [
    ["suite", suite],
    ["case", caseName],
  ] as const) {
    if (!NAME_RE.test(v) || v.includes("..")) {
      throw new Error(`golden ${label} name "${v}" must match ${NAME_RE} (lowercase, no "..")`);
    }
  }
  return join(snapshotRoot, suite, `${caseName}.json`);
}

/**
 * The exact text a golden file holds for `got`: `JSON.stringify(got, null, 2)`
 * normalized as one text, plus `\n`.
 *
 * Every `CapturedExchange` inside `got` is serialized from its raw twin, so
 * all of them and any raw values next to them share ONE placeholder
 * sequence: two different ids never get the same placeholder, and the same
 * id gets the same placeholder in every part. A value that was already
 * normalized some other way (e.g. a spread copy of a capture, or text passed
 * through `normalize` by the caller) keeps its placeholders; new ones are
 * numbered after the highest existing one, so they cannot collide, but they
 * are not linked to the raw ids they came from.
 */
export function serializeGolden(got: unknown): string {
  const text = JSON.stringify(
    got,
    function (this: unknown, _key: string, value: unknown) {
      if (value !== null && typeof value === "object" && RAW in value) {
        return (value as { [RAW]: unknown })[RAW];
      }
      return value;
    },
    2,
  );
  let next = 0;
  for (const m of text.matchAll(/<(?:uuid)?#(\d+)>/g)) next = Math.max(next, Number(m[1]) + 1);
  return normalize(text, new NormalizeContext(next)) + "\n";
}

/** `CI` counts as set unless it is empty, `0` or `false`. */
function ciIsSet(): boolean {
  const ci = process.env.CI;
  return ci !== undefined && !/^(?:|0|false)$/i.test(ci.trim());
}

/** True when this run may write goldens; throws on a half-configured write. */
function goldenWriteEnabled(): boolean {
  if (process.env.GOLDEN_WRITE !== "1") return false;
  if (process.env.GOLDEN_CAPTURE_RUN === "1" && !ciIsSet()) return true;
  throw new Error(
    "GOLDEN_WRITE=1 is set, but goldens are written only by `pnpm golden:capture` " +
      "(which also sets GOLDEN_CAPTURE_RUN=1) and never when CI is set " +
      `(GOLDEN_CAPTURE_RUN=${process.env.GOLDEN_CAPTURE_RUN ?? "<unset>"}, ` +
      `CI=${process.env.CI ?? "<unset>"}). Unset GOLDEN_WRITE to compare instead.`,
  );
}

/** Probe the local parser without changing captured diagnostics. */
function currentMalformedJsonDiagnostic() {
  try {
    JSON.parse("{");
  } catch (error) {
    if (error instanceof SyntaxError) return error.message;
    throw error;
  }
}

const malformedJsonDiagnostic = currentMalformedJsonDiagnostic();

/** Adapt only explicitly selected native error bodies, preserving strict bytes elsewhere. */
function expectedForCurrentJsonParser(
  expected: string,
  bodyPaths: readonly (readonly (string | number)[])[],
): string {
  if (
    bodyPaths.length === 0 ||
    malformedJsonDiagnostic !== "Expected property name or '}' in JSON at position 1"
  )
    return expected;
  const parsed: unknown = JSON.parse(expected);
  if (`${JSON.stringify(parsed, null, 2)}\n` !== expected) return expected;
  for (const path of bodyPaths) {
    let parent: unknown = parsed;
    for (const key of path.slice(0, -1)) {
      if (parent === null || typeof parent !== "object") return expected;
      parent = Object.getOwnPropertyDescriptor(parent, key)?.value;
    }
    const key = path.at(-1);
    if (key === undefined || parent === null || typeof parent !== "object") return expected;
    const descriptor = Object.getOwnPropertyDescriptor(parent, key);
    const body: unknown = descriptor?.value;
    if (typeof body !== "string") return expected;
    const errorBody: unknown = JSON.parse(body);
    if (
      JSON.stringify(errorBody) !== body ||
      errorBody === null ||
      typeof errorBody !== "object" ||
      !("error" in errorBody) ||
      errorBody.error === null ||
      typeof errorBody.error !== "object" ||
      !("message" in errorBody.error)
    )
      return expected;
    const message = errorBody.error.message;
    if (
      message === "Malformed JSON: Expected property name or '}' in JSON at position 1" ||
      message === "Malformed JSON body: Expected property name or '}' in JSON at position 1"
    )
      continue;
    if (
      message !==
        "Malformed JSON: Expected property name or '}' in JSON at position 1 (line 1 column 2)" &&
      message !==
        "Malformed JSON body: Expected property name or '}' in JSON at position 1 (line 1 column 2)"
    )
      return expected;
    errorBody.error.message = message.replace(" (line 1 column 2)", "");
    Object.defineProperty(parent, key, { ...descriptor, value: JSON.stringify(errorBody) });
  }
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

/**
 * Compare `got` with `__snapshots__/<suite>/<caseName>.json`, byte for byte.
 * `nativeJsonBodies` opts in only body paths from known malformed requests;
 * it adapts their exact root error.message diagnostic on the demonstrated runtime.
 * Fails when the file is missing. Writes the file instead of comparing only
 * under a capture run (see "Rules" in the file header), and then appends its
 * absolute path to `GOLDEN_WRITE_LOG` when set. Throws first if an open stub
 * upstream has an error not yet reported (see `startStubUpstream`).
 */
export function expectGolden(
  suite: string,
  caseName: string,
  got: unknown,
  options?: { nativeJsonBodies: readonly (readonly (string | number)[])[] },
): void {
  const stubErrors = [...openStubQueues].flatMap((queue) => queue.splice(0));
  if (stubErrors.length > 0) throw new Error(stubErrors.join("; "));
  const file = goldenPath(suite, caseName);
  const actual = serializeGolden(got);
  if (goldenWriteEnabled()) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, actual);
    const log = process.env.GOLDEN_WRITE_LOG;
    if (log) appendFileSync(log, `${file}\n`);
    return;
  }
  if (!existsSync(file)) {
    throw new Error(
      `golden missing: ${file}\nWrite it with \`pnpm golden:capture\`, then review and commit it.`,
    );
  }
  expect(actual, `golden mismatch: ${file}`).toBe(
    expectedForCurrentJsonParser(readFileSync(file, "utf8"), options?.nativeJsonBodies ?? []),
  );
}
