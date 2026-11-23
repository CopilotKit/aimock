/**
 * Characterization goldens for every streaming writer (spec F0, plan T1).
 *
 * Two layers are pinned, and both must stay unchanged by the shared
 * frame-loop / delivery-lifecycle refactor:
 *
 * 1. Bytes and call order. Latency-0 fixtures run through each writer (the
 *    public writers directly, the module-private writers through their
 *    handlers) against a recording fake `res` / fake `ws`. Every
 *    `setHeader` / `writeHead` / `write` / `end` / `destroy` / `send` call is
 *    logged in order, plus the final journal interruption state.
 * 2. Delays at the timer layer. Fixtures carry `recordedTimings` with a
 *    distinct gap at every index, the writer runs under fake timers, and every
 *    scheduled `setTimeout` duration is logged in order, interleaved with the
 *    write log. A refactor that calls `calculateDelay` the same way but sleeps
 *    differently fails here.
 *
 * Volatile values (generated ids, timestamps) are masked before comparison.
 * Fixture-authored ids (`AUTHORED_IDS`) are never masked, so a lost or
 * rewritten authored id fails the comparison.
 *
 * The goldens live in `__snapshots__/frame-codec-golden/*.json`. They are
 * written only when `FRAME_CODEC_GOLDEN_WRITE=1` is set. Write mode merges
 * the captured entries into the existing file (a `-t` filtered run never
 * drops entries it did not run) and drops entries no test declares. In
 * compare mode a missing or different entry fails, and so does a file whose
 * entries are not exactly the declared cases (stale or extra entries).
 */
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type * as http from "node:http";
import { crc32 } from "node:zlib";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeSSEStream } from "../sse-writer.js";
import { writeNDJSONStream } from "../ndjson-writer.js";
import { writeEventStream } from "../aws-event-stream.js";
import { createInterruptionSignal } from "../interruption.js";
import { buildTextChunks, buildToolCallChunks, buildUsageChunk } from "../helpers.js";
import { handleMessages } from "../messages.js";
import { handleResponses } from "../responses.js";
import { handleGemini } from "../gemini.js";
import {
  handleGeminiInteractions,
  resetEventIdCounter,
  resetInteractionCounter,
} from "../gemini-interactions.js";
import { handleCohere } from "../cohere.js";
import { handleBedrockStream } from "../bedrock.js";
import { handleConverseStream } from "../bedrock-converse.js";
import { handleOllama } from "../ollama.js";
import { handleTranscription } from "../transcription.js";
import { handleWebSocketResponses } from "../ws-responses.js";
import { handleWebSocketRealtime } from "../ws-realtime.js";
import { handleWebSocketGeminiLive } from "../ws-gemini-live.js";
import { createServer } from "../server.js";
import type { WebSocketConnection } from "../ws-framing.js";
import { Journal } from "../journal.js";
import { setFixtureMisbehaviorPosition } from "../misbehavior.js";
import { Logger } from "../logger.js";
import type { Fixture, FixtureResponse, HandlerDefaults, RecordedTimings } from "../types.js";

// ─── Recording doubles ─────────────────────────────────────────────────────

type LogEntry = Record<string, unknown>;

const VOLATILE_KEY =
  /"(id|[A-Za-z]*_id|[a-z]+Id|created|created_at|createdAt|signature)":("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?)/g;
// A whole id token, never a JSON key (`"call_id":` stays as written).
const GENERATED_ID =
  /\b(chatcmpl|msg|toolu|resp|call|fc|rs|aimock-int|aimock-evt|item|req|evt|event|sess|gen|conv|ws)[-_][A-Za-z0-9_-]+(?![A-Za-z0-9_-]|"\s*:)/g;

/** Tool-call ids the fixtures author. Output must carry them verbatim. */
const AUTHORED_IDS = {
  g1: "call_g1",
  g2: "call_g2",
  g3: "call_g3",
  m1: "call_m1",
  m2: "call_m2",
} as const;
const AUTHORED_ID = new RegExp(`(?:${Object.values(AUTHORED_IDS).join("|")})(?![A-Za-z0-9_-])`);

// V8's `JSON.parse` message carries a " (line N column M)" suffix on Node 22+
// but not on Node 20; drop it so a writer that echoes the parse error compares the same everywhere.
const V8_PARSE_LOCATION = /( in JSON at position \d+) \(line \d+ column \d+\)/g;

/** Mask generated ids and timestamps; keep any value that carries an authored id. */
function mask(text: string): string {
  return text
    .replace(V8_PARSE_LOCATION, "$1")
    .replace(VOLATILE_KEY, (whole: string, key: string, value: string) =>
      AUTHORED_ID.test(value) ? whole : `"${key}":"<masked>"`,
    )
    .replace(GENERATED_ID, (id: string) => (AUTHORED_ID.test(id) ? id : "<id>"));
}

/** Decode concatenated AWS event-stream frames, checking both CRCs. */
function decodeEventStream(buf: Buffer): LogEntry[] {
  const frames: LogEntry[] = [];
  let off = 0;
  while (off + 12 <= buf.length) {
    const total = buf.readUInt32BE(off);
    const headersLength = buf.readUInt32BE(off + 4);
    const preludeOk = crc32(buf.subarray(off, off + 8)) >>> 0 === buf.readUInt32BE(off + 8);
    const messageOk =
      crc32(buf.subarray(off, off + total - 4)) >>> 0 === buf.readUInt32BE(off + total - 4);
    const headers: Record<string, string> = {};
    let h = off + 12;
    const headersEnd = h + headersLength;
    while (h < headersEnd) {
      const nameLength = buf.readUInt8(h);
      const name = buf.subarray(h + 1, h + 1 + nameLength).toString("utf8");
      h += 1 + nameLength + 1;
      const valueLength = buf.readUInt16BE(h);
      headers[name] = buf.subarray(h + 2, h + 2 + valueLength).toString("utf8");
      h += 2 + valueLength;
    }
    let payload = buf.subarray(headersEnd, off + total - 4).toString("utf8");
    const parsed: unknown = JSON.parse(payload);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { bytes?: unknown }).bytes === "string"
    ) {
      const inner = Buffer.from((parsed as { bytes: string }).bytes, "base64").toString("utf8");
      payload = JSON.stringify({ bytes: `<base64>${mask(inner)}` });
    } else {
      payload = mask(payload);
    }
    frames.push({ total, headersLength, preludeOk, messageOk, headers, payload });
    off += total;
  }
  if (off !== buf.length) frames.push({ trailingBytes: buf.length - off });
  return frames;
}

class RecordingRes extends EventEmitter {
  writableEnded = false;
  writableFinished = false;
  destroyed = false;
  headersSent = false;
  statusCode = 200;
  /** Called once the response ends or is destroyed (not logged). */
  onDone: (() => void) | null = null;
  private readonly headers: Record<string, string | number | string[]> = {};
  constructor(private readonly log: LogEntry[]) {
    super();
  }
  setHeader(name: string, value: string | number | string[]): this {
    // The server sets a generated `X-Request-Id`; every other header is kept verbatim.
    this.log.push({
      op: "setHeader",
      name,
      value: name.toLowerCase() === "x-request-id" ? "<masked>" : value,
    });
    this.headers[name.toLowerCase()] = value;
    return this;
  }
  getHeader(name: string): string | number | string[] | undefined {
    return this.headers[name.toLowerCase()];
  }
  writeHead(status: number, headers?: Record<string, string>): this {
    this.log.push({ op: "writeHead", status, headers: headers ?? null });
    this.statusCode = status;
    this.headersSent = true;
    return this;
  }
  write(chunk: string | Buffer): boolean {
    if (Buffer.isBuffer(chunk)) {
      this.log.push({ op: "write", frames: decodeEventStream(chunk) });
    } else {
      this.log.push({ op: "write", data: mask(chunk) });
    }
    this.headersSent = true;
    return true;
  }
  end(chunk?: string | Buffer): this {
    if (chunk !== undefined) this.write(chunk);
    this.log.push({ op: "end" });
    this.writableEnded = true;
    this.writableFinished = true;
    this.headersSent = true;
    this.onDone?.();
    return this;
  }
  destroy(): this {
    this.log.push({ op: "destroy" });
    this.destroyed = true;
    this.onDone?.();
    return this;
  }
}

class RecordingWs extends EventEmitter {
  private closed = false;
  constructor(private readonly log: LogEntry[]) {
    super();
  }
  send(data: string): void {
    this.log.push({ op: "send", data: mask(data) });
  }
  close(code?: number, reason?: string): void {
    this.log.push({ op: "close", code: code ?? null, reason: reason ?? null });
    this.closed = true;
  }
  destroy(): void {
    this.log.push({ op: "destroy" });
    this.closed = true;
  }
  get isClosed(): boolean {
    return this.closed;
  }
}

function asRes(res: RecordingRes): http.ServerResponse {
  return res as unknown as http.ServerResponse;
}
function asWs(ws: RecordingWs): WebSocketConnection {
  return ws as unknown as WebSocketConnection;
}
function fakeReq(url: string, headers: Record<string, string> = {}): http.IncomingMessage {
  return { method: "POST", url, headers } as unknown as http.IncomingMessage;
}

// ─── Fixtures ──────────────────────────────────────────────────────────────

const MATCH = "golden probe";
const PRIMES = [
  11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97, 101, 103, 107,
  109, 113, 127, 131, 137, 139, 149, 151, 157, 163, 167, 173, 179, 181, 191, 193, 197, 199, 211,
  223, 227, 229, 233, 239, 241, 251, 257, 263, 269, 271, 277, 281, 283, 293, 307, 311,
];
const RECORDED: RecordedTimings = { ttftMs: 7, interChunkDelaysMs: PRIMES, totalDurationMs: 0 };

const RESPONSES: Record<string, FixtureResponse> = {
  text: { content: "Hello golden world, this is a characterization run." },
  tool: { toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}', id: AUTHORED_IDS.g1 }] },
  combined: {
    content: "Checking now.",
    toolCalls: [{ name: "get_weather", arguments: '{"city":"SF"}', id: AUTHORED_IDS.g2 }],
  },
  blocks: {
    blocks: [
      { type: "text", text: "Lead text." },
      { type: "toolCall", name: "get_time", arguments: "{}", id: AUTHORED_IDS.g3 },
      { type: "text", text: "Tail text." },
    ],
  },
};

type CaseName =
  | "text"
  | "tool"
  | "combined"
  | "blocks"
  | "misbehavior"
  | "truncate2"
  | "delay-text"
  | "delay-combined"
  | "delay-replay2";

const BYTE_CASES: CaseName[] = ["text", "tool", "combined", "blocks", "misbehavior", "truncate2"];
const DELAY_CASES: CaseName[] = ["delay-text", "delay-combined", "delay-replay2"];

function fixtureFor(
  name: CaseName,
  match: Fixture["match"],
  misbehaviorFault: string,
  textResponse: FixtureResponse = RESPONSES.text,
): Fixture {
  const base = { match, chunkSize: 7 };
  switch (name) {
    case "text":
    case "tool":
    case "combined":
    case "blocks":
      return { ...base, latency: 0, response: name === "text" ? textResponse : RESPONSES[name] };
    case "misbehavior": {
      const fixture: Fixture = {
        ...base,
        latency: 0,
        response: {
          toolCalls: [
            { name: "get_weather", arguments: '{"city":"NYC"}', id: AUTHORED_IDS.m1 },
            { name: "get_time", arguments: '{"zone":"UTC"}', id: AUTHORED_IDS.m2 },
          ],
        },
        misbehavior: misbehaviorFault as Fixture["misbehavior"],
      };
      setFixtureMisbehaviorPosition(fixture, "golden#0");
      return fixture;
    }
    case "truncate2":
      return { ...base, latency: 0, response: textResponse, truncateAfterChunks: 2 };
    case "delay-text":
      return { ...base, response: textResponse, recordedTimings: RECORDED };
    case "delay-combined":
      return { ...base, response: RESPONSES.combined, recordedTimings: RECORDED };
    case "delay-replay2":
      return { ...base, response: textResponse, recordedTimings: RECORDED, replaySpeed: 2 };
  }
}

function makeDefaults(journal: Journal): HandlerDefaults {
  return {
    latency: 0,
    chunkSize: 7,
    replaySpeed: 1,
    logger: new Logger("silent"),
    misbehavior: { byTestId: new Map() },
    misbehaviorCounters: journal,
  };
}

// ─── Runner ────────────────────────────────────────────────────────────────

interface Capture {
  log: LogEntry[];
  journal: LogEntry | null;
}

interface CaptureOptions {
  /** Read the journal state from this journal (a server's) instead of a fresh one. */
  journal?: Journal;
  /**
   * Keep running timers until `body` settles. For bodies that wait on I/O
   * (a request body stream) before they schedule their first timer.
   */
  untilSettled?: boolean;
}

/**
 * Run `body` under fake timers, logging every scheduled setTimeout duration
 * into the same ordered log the doubles write to.
 */
async function capture(
  body: (log: LogEntry[], journal: Journal) => Promise<unknown> | unknown,
  options: CaptureOptions = {},
): Promise<Capture> {
  const log: LogEntry[] = [];
  const journal = options.journal ?? new Journal();
  const fakeSetTimeout = globalThis.setTimeout;
  const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    fn: () => void,
    ms?: number,
    ...args: unknown[]
  ) => {
    log.push({ op: "timer", ms: ms ?? 0 });
    return fakeSetTimeout(fn, ms, ...args);
  }) as unknown as typeof setTimeout);
  try {
    const pending = Promise.resolve().then(() => body(log, journal));
    // Observed now so a rejection is not reported as unhandled while timers run.
    pending.catch(() => undefined);
    if (options.untilSettled) {
      let settled = false;
      pending.then(
        () => (settled = true),
        () => (settled = true),
      );
      // Each pass yields one real macrotask, so stream I/O makes progress.
      for (let pass = 0; !settled; pass++) {
        if (pass >= 1000) throw new Error("capture: body did not settle");
        await vi.runAllTimersAsync();
      }
    } else {
      await vi.runAllTimersAsync();
    }
    await pending;
    await vi.runAllTimersAsync();
  } finally {
    spy.mockRestore();
  }
  const entries = journal.getAll();
  const last = entries.at(-1);
  return {
    log,
    journal: last
      ? {
          status: last.response.status,
          interrupted: last.response.interrupted ?? null,
          interruptReason: last.response.interruptReason ?? null,
        }
      : null,
  };
}

const GOLDEN_DIR = fileURLToPath(new URL("./__snapshots__/frame-codec-golden/", import.meta.url));
const WRITE = process.env.FRAME_CODEC_GOLDEN_WRITE === "1";
const pendingWrites = new Map<string, Record<string, unknown>>();
const loaded = new Map<string, Record<string, unknown>>();
/**
 * Every golden entry a test declares, in declaration order. Filled while the
 * suite is collected, so it is complete even when `-t` runs only some tests.
 */
const declared = new Map<string, string[]>();

function goldenPath(file: string): string {
  return `${GOLDEN_DIR}${file}.json`;
}

function readGolden(file: string): Record<string, unknown> | null {
  const path = goldenPath(file);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/** Declare the golden entry `name` in `<file>.json`. Call at collection time. */
function declare(file: string, name: string): void {
  const names = declared.get(file) ?? [];
  if (names.includes(name)) throw new Error(`golden entry declared twice: ${file} › ${name}`);
  names.push(name);
  declared.set(file, names);
}

/**
 * Compare one capture with its entry in `<file>.json`. In write mode the
 * captures are collected and merged into the file after the suite runs.
 */
function record(file: string, name: string, value: Capture): void {
  expect(declared.get(file)?.includes(name), `golden entry not declared: ${file} › ${name}`).toBe(
    true,
  );
  const normalized: unknown = JSON.parse(JSON.stringify(value));
  if (WRITE) {
    const group = pendingWrites.get(file) ?? {};
    group[name] = normalized;
    pendingWrites.set(file, group);
    return;
  }
  let golden = loaded.get(file);
  if (!golden) {
    const read = readGolden(file);
    expect(read, `golden file missing: ${goldenPath(file)}`).not.toBeNull();
    golden = read ?? {};
    loaded.set(file, golden);
  }
  expect(Object.hasOwn(golden, name), `golden entry missing: ${file} › ${name}`).toBe(true);
  expect(normalized).toEqual(golden[name]);
}

/**
 * Compare mode: the file exists and its entries are exactly the declared
 * cases, so a stale entry (a case that was renamed or removed) or an extra
 * one fails. Write mode checks nothing here; the merge runs in `afterAll`.
 */
function finishGolden(file: string): void {
  if (WRITE) return;
  const golden = readGolden(file);
  expect(golden, `golden file missing: ${goldenPath(file)}`).not.toBeNull();
  const expected = declared.get(file) ?? [];
  const actual = Object.keys(golden ?? {});
  const stale = actual.filter((name) => !expected.includes(name));
  const missing = expected.filter((name) => !actual.includes(name));
  expect({ stale, missing }, `golden entries out of date: ${file}`).toEqual({
    stale: [],
    missing: [],
  });
}

/**
 * Write mode: merge the captured entries into each file. Entries this run did
 * not capture keep their stored value, entries no test declares are dropped,
 * and the declared order is kept. A file with no captures is not touched.
 */
afterAll(() => {
  if (!WRITE) return;
  mkdirSync(GOLDEN_DIR, { recursive: true });
  for (const [file, captured] of pendingWrites) {
    const existing = readGolden(file) ?? {};
    const merged: Record<string, unknown> = {};
    for (const name of declared.get(file) ?? []) {
      if (Object.hasOwn(captured, name)) merged[name] = captured[name];
      else if (Object.hasOwn(existing, name)) merged[name] = existing[name];
    }
    writeFileSync(goldenPath(file), JSON.stringify(merged, null, 2) + "\n");
  }
});

function installFakeClock(): void {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-02T03:04:05.000Z"));
}

beforeEach(() => {
  installFakeClock();
  resetInteractionCounter();
  resetEventIdCounter();
});
afterEach(() => {
  vi.useRealTimers();
});

// ─── HTTP handler rows ─────────────────────────────────────────────────────

const noCors = (): void => {};

interface HandlerRow {
  file: string;
  url: string;
  body: Record<string, unknown>;
  misbehaviorFault: string;
  run: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    raw: string,
    fixtures: Fixture[],
    journal: Journal,
    defaults: HandlerDefaults,
  ) => Promise<void>;
}

const BEDROCK_MODEL = "anthropic.claude-3-5-sonnet-20241022-v2:0";

const HANDLER_ROWS: HandlerRow[] = [
  {
    file: "claude-sse",
    url: "/v1/messages",
    body: {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 256,
      stream: true,
      messages: [{ role: "user", content: MATCH }],
    },
    misbehaviorFault: "tool-args-invalid-json",
    run: (req, res, raw, f, j, d) => handleMessages(req, res, raw, f, j, d, noCors),
  },
  {
    file: "responses-sse",
    url: "/v1/responses",
    body: { model: "gpt-4o", stream: true, input: [{ role: "user", content: MATCH }] },
    misbehaviorFault: "tool-args-invalid-json",
    run: (req, res, raw, f, j, d) => handleResponses(req, res, raw, f, j, d, noCors),
  },
  {
    file: "gemini-sse",
    url: "/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse",
    body: { contents: [{ role: "user", parts: [{ text: MATCH }] }] },
    misbehaviorFault: "tool-args-invalid-json",
    run: (req, res, raw, f, j, d) =>
      handleGemini(req, res, raw, "gemini-2.0-flash", true, f, j, d, noCors),
  },
  {
    file: "gemini-interactions-sse",
    url: "/v1beta/interactions",
    body: { model: "gemini-2.5-flash", input: MATCH, stream: true },
    misbehaviorFault: "tool-args-invalid-json",
    run: (req, res, raw, f, j, d) => handleGeminiInteractions(req, res, raw, f, j, d, noCors),
  },
  {
    file: "cohere-sse",
    url: "/v2/chat",
    body: { model: "command-r-plus", stream: true, messages: [{ role: "user", content: MATCH }] },
    // stop-length-mid-tool is the only path that turns on terminalSentinel.
    misbehaviorFault: "stop-length-mid-tool",
    run: (req, res, raw, f, j, d) => handleCohere(req, res, raw, f, j, d, noCors),
  },
  {
    file: "bedrock-invoke-eventstream",
    url: `/model/${BEDROCK_MODEL}/invoke-with-response-stream`,
    body: {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 256,
      messages: [{ role: "user", content: MATCH }],
    },
    misbehaviorFault: "tool-args-invalid-json",
    run: (req, res, raw, f, j, d) =>
      handleBedrockStream(req, res, raw, BEDROCK_MODEL, f, j, d, noCors),
  },
  {
    file: "bedrock-converse-eventstream",
    url: `/model/${BEDROCK_MODEL}/converse-stream`,
    body: { messages: [{ role: "user", content: [{ text: MATCH }] }] },
    misbehaviorFault: "tool-args-invalid-json",
    run: (req, res, raw, f, j, d) =>
      handleConverseStream(req, res, raw, BEDROCK_MODEL, f, j, d, noCors),
  },
  {
    file: "ollama-ndjson",
    url: "/api/chat",
    body: { model: "llama3", stream: true, messages: [{ role: "user", content: MATCH }] },
    misbehaviorFault: "tool-args-invalid-json",
    run: (req, res, raw, f, j, d) => handleOllama(req, res, raw, f, j, d, noCors),
  },
];

describe("frame codec goldens: handler-driven writers", () => {
  for (const row of HANDLER_ROWS) {
    describe(row.file, () => {
      const cases = [...BYTE_CASES, ...DELAY_CASES];
      for (const name of cases) {
        declare(row.file, name);
        it(name, async () => {
          const fixture = fixtureFor(name, { userMessage: MATCH }, row.misbehaviorFault);
          const raw = JSON.stringify(row.body);
          const result = await capture(async (log, journal) => {
            const res = new RecordingRes(log);
            await row.run(
              fakeReq(row.url),
              asRes(res),
              raw,
              [fixture],
              journal,
              makeDefaults(journal),
            );
          });
          record(row.file, name, result);
        });
      }
      it("has its golden file", () => {
        finishGolden(row.file);
      });
    });
  }
});

// ─── Public writers driven directly ────────────────────────────────────────

function openAIChunks(name: CaseName) {
  if (name === "tool" || name === "misbehavior") {
    return buildToolCallChunks(
      [{ name: "get_weather", arguments: '{"city":"NYC"}', id: AUTHORED_IDS.g1 }],
      "gpt-4o",
      7,
    );
  }
  return buildTextChunks("Hello golden world, this is a characterization run.", "gpt-4o", 7);
}

function writerTiming(name: CaseName): { recordedTimings?: RecordedTimings; replaySpeed?: number } {
  if (name === "delay-text" || name === "delay-combined") return { recordedTimings: RECORDED };
  if (name === "delay-replay2") return { recordedTimings: RECORDED, replaySpeed: 2 };
  return {};
}

const DIRECT_CASES: CaseName[] = ["text", "tool", "truncate2", "delay-text", "delay-replay2"];

describe("frame codec goldens: writeSSEStream", () => {
  const variants = ["plain", "usageChunk", "openRouterProcessing"] as const;
  for (const variant of variants) {
    for (const name of DIRECT_CASES) {
      declare("openai-sse", `${variant} ${name}`);
      it(`${variant} ${name}`, async () => {
        const result = await capture(async (log) => {
          const res = new RecordingRes(log);
          const chunks = openAIChunks(name);
          const interruption =
            name === "truncate2"
              ? createInterruptionSignal({
                  match: {},
                  response: { content: "" },
                  truncateAfterChunks: 2,
                })
              : null;
          const completed = await writeSSEStream(asRes(res), chunks, {
            latency: 0,
            ...writerTiming(name),
            signal: interruption?.signal,
            onChunkSent: interruption?.tick,
            usageChunk:
              variant === "usageChunk"
                ? buildUsageChunk(chunks[0].id, "gpt-4o", chunks[0].created, {
                    prompt_tokens: 3,
                    completion_tokens: 5,
                    total_tokens: 8,
                  })
                : undefined,
            openRouterProcessing: variant === "openRouterProcessing",
          });
          interruption?.cleanup();
          log.push({ op: "return", completed });
        });
        record("openai-sse", `${variant} ${name}`, result);
      });
    }
  }
  declare("openai-sse", "already-ended");
  it("returns true and writes nothing when the response already ended", async () => {
    const result = await capture(async (log) => {
      const res = new RecordingRes(log);
      res.writableEnded = true;
      log.push({ op: "return", completed: await writeSSEStream(asRes(res), openAIChunks("text")) });
    });
    record("openai-sse", "already-ended", result);
  });
  it("has its golden file", () => {
    finishGolden("openai-sse");
  });
});

describe("frame codec goldens: writeNDJSONStream", () => {
  for (const name of DIRECT_CASES) {
    declare("ndjson", name);
    it(name, async () => {
      const result = await capture(async (log) => {
        const res = new RecordingRes(log);
        const chunks = [
          { model: "llama3", message: { role: "assistant", content: "Hello " }, done: false },
          { model: "llama3", message: { role: "assistant", content: "golden " }, done: false },
          { model: "llama3", message: { role: "assistant", content: "world." }, done: false },
          { model: "llama3", message: { role: "assistant", content: "" }, done: true },
        ];
        const interruption =
          name === "truncate2"
            ? createInterruptionSignal({
                match: {},
                response: { content: "" },
                truncateAfterChunks: 2,
              })
            : null;
        const completed = await writeNDJSONStream(asRes(res), chunks, {
          latency: 0,
          ...writerTiming(name),
          signal: interruption?.signal,
          onChunkSent: interruption?.tick,
        });
        interruption?.cleanup();
        log.push({ op: "return", completed });
      });
      record("ndjson", name, result);
    });
  }
  it("has its golden file", () => {
    finishGolden("ndjson");
  });
});

describe("frame codec goldens: writeEventStream", () => {
  for (const name of DIRECT_CASES) {
    declare("aws-eventstream", name);
    it(name, async () => {
      const result = await capture(async (log) => {
        const res = new RecordingRes(log);
        const events = [
          { eventType: "messageStart", payload: { role: "assistant" } },
          {
            eventType: "contentBlockDelta",
            payload: { contentBlockIndex: 0, delta: { text: "Hello " } },
          },
          {
            eventType: "contentBlockDelta",
            payload: { contentBlockIndex: 0, delta: { text: "world" } },
          },
          { eventType: "contentBlockStop", payload: { contentBlockIndex: 0 } },
          { eventType: "messageStop", payload: { stopReason: "end_turn" } },
        ];
        const interruption =
          name === "truncate2"
            ? createInterruptionSignal({
                match: {},
                response: { content: "" },
                truncateAfterChunks: 2,
              })
            : null;
        const completed = await writeEventStream(asRes(res), events, {
          latency: 0,
          ...writerTiming(name),
          signal: interruption?.signal,
          onChunkSent: interruption?.tick,
        });
        interruption?.cleanup();
        log.push({ op: "return", completed });
      });
      record("aws-eventstream", name, result);
    });
  }
  it("has its golden file", () => {
    finishGolden("aws-eventstream");
  });
});

// ─── Transcription (multipart, writeHead up front) ─────────────────────────

describe("frame codec goldens: transcription stream", () => {
  const boundary = "----goldenboundary";
  const raw = [
    `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\ngpt-4o-transcribe\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="stream"\r\n\r\ntrue\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\nRIFF\r\n`,
    `--${boundary}--\r\n`,
  ].join("");
  const transcript: FixtureResponse = {
    transcription: {
      text: "Hello golden world, this is a transcription.",
      languages: [{ code: "en" }],
    },
  };
  for (const name of ["text", "truncate2", "delay-text", "delay-replay2"] as CaseName[]) {
    declare("transcription-sse", name);
    it(name, async () => {
      const fixture = fixtureFor(name, { endpoint: "transcription" }, "", transcript);
      const result = await capture(async (log, journal) => {
        const res = new RecordingRes(log);
        await handleTranscription(
          fakeReq("/v1/audio/transcriptions", {
            "content-type": `multipart/form-data; boundary=${boundary}`,
          }),
          asRes(res),
          raw,
          [fixture],
          journal,
          makeDefaults(journal),
          noCors,
        );
      });
      record("transcription-sse", name, result);
    });
  }
  it("has its golden file", () => {
    finishGolden("transcription-sse");
  });
});

// ─── WebSocket transports ──────────────────────────────────────────────────

describe("frame codec goldens: WS Responses sendEvents", () => {
  for (const name of [...BYTE_CASES, ...DELAY_CASES]) {
    declare("ws-responses", name);
    it(name, async () => {
      const fixture = fixtureFor(name, { userMessage: MATCH }, "tool-args-invalid-json");
      const result = await capture(async (log, journal) => {
        const ws = new RecordingWs(log);
        handleWebSocketResponses(asWs(ws), [fixture], journal, {
          ...makeDefaults(journal),
          model: "gpt-4o",
        });
        ws.emit(
          "message",
          JSON.stringify({
            type: "response.create",
            model: "gpt-4o",
            input: [{ role: "user", content: MATCH }],
          }),
        );
      });
      record("ws-responses", name, result);
    });
  }
  it("has its golden file", () => {
    finishGolden("ws-responses");
  });
});

describe("frame codec goldens: WS Realtime", () => {
  const rows: Array<[string, Partial<Fixture>]> = [
    ["text", { latency: 0 }],
    ["delay-text", { recordedTimings: RECORDED }],
    ["profile", { streamingProfile: { ttft: 5, tps: 50 } }],
    ["truncate2", { latency: 0, truncateAfterChunks: 2 }],
  ];
  for (const [name, extra] of rows) {
    declare("ws-realtime", name);
    it(name, async () => {
      const fixture: Fixture = {
        match: { userMessage: MATCH },
        response: RESPONSES.text,
        chunkSize: 7,
        ...extra,
      };
      const result = await capture(async (log, journal) => {
        const ws = new RecordingWs(log);
        handleWebSocketRealtime(asWs(ws), [fixture], journal, {
          ...makeDefaults(journal),
          model: "gpt-4o-realtime-preview",
        });
        ws.emit(
          "message",
          JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: MATCH }],
            },
          }),
        );
        ws.emit("message", JSON.stringify({ type: "response.create" }));
      });
      record("ws-realtime", name, result);
    });
  }
  // The live-transcription delta loop is the Realtime path that passes the
  // fixture's streamingProfile to calculateDelay; the text-response loops pass
  // `undefined` (the "profile" row above pins that they ignore it).
  const transcriptionRows: Array<[string, Partial<Fixture>]> = [
    ["transcription profile", { streamingProfile: { ttft: 5, tps: 50 } }],
    ["transcription delay-text", { recordedTimings: RECORDED }],
    ["transcription truncate2", { latency: 0, truncateAfterChunks: 2 }],
  ];
  for (const [name, extra] of transcriptionRows) {
    declare("ws-realtime", name);
    it(name, async () => {
      const fixture: Fixture = {
        match: { endpoint: "realtime-transcription" },
        response: { transcription: { text: "Live golden caption for the profile path." } },
        chunkSize: 7,
        ...extra,
      };
      const result = await capture(async (log, journal) => {
        const ws = new RecordingWs(log);
        handleWebSocketRealtime(asWs(ws), [fixture], journal, {
          ...makeDefaults(journal),
          model: "gpt-realtime",
          transcriptionIntent: true,
        });
        ws.emit(
          "message",
          JSON.stringify({
            type: "transcription_session.update",
            session: { input_audio_transcription: { model: "gpt-live-transcribe-2026-07-01" } },
          }),
        );
        ws.emit("message", JSON.stringify({ type: "input_audio_buffer.commit" }));
      });
      record("ws-realtime", name, result);
    });
  }
  it("has its golden file", () => {
    finishGolden("ws-realtime");
  });
});

// ─── OpenAI Chat Completions handler (through the server dispatcher) ──────

/**
 * `handleCompletions` is module-private, so these rows drive the server's own
 * request listener with a body stream and a recording response. The server is
 * created before the timer spy starts, so only the request's timers are
 * logged; the journal state is read from the server's journal.
 */
async function captureChat(fixture: Fixture, body: Record<string, unknown>): Promise<Capture> {
  // Real timers while the server starts: its sweep intervals would make
  // `runAllTimersAsync` loop forever under the fake clock.
  vi.useRealTimers();
  const instance = await createServer([fixture], { port: 0, logLevel: "silent" });
  installFakeClock();
  try {
    const [listener] = instance.server.listeners("request") as Array<
      (req: http.IncomingMessage, res: http.ServerResponse) => void
    >;
    return await capture(
      (log) =>
        new Promise<void>((resolve) => {
          const res = new RecordingRes(log);
          res.onDone = resolve;
          const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
            method: "POST",
            url: "/v1/chat/completions",
            headers: { "content-type": "application/json", host: "127.0.0.1" },
          });
          listener(req as unknown as http.IncomingMessage, asRes(res));
        }),
      { journal: instance.journal, untilSettled: true },
    );
  } finally {
    await new Promise<void>((resolve) => instance.server.close(() => resolve()));
  }
}

describe("frame codec goldens: OpenAI chat completions handler", () => {
  const file = "openai-chat-handler";
  const request = (stream: boolean) => ({
    model: "gpt-4o",
    stream,
    messages: [{ role: "user", content: MATCH }],
  });
  const streamCases: CaseName[] = [...BYTE_CASES, ...DELAY_CASES];
  const nonStreamCases: CaseName[] = ["text", "tool", "combined", "blocks", "delay-text"];
  for (const [mode, cases] of [
    ["stream", streamCases],
    ["non-stream", nonStreamCases],
  ] as const) {
    for (const name of cases) {
      declare(file, `${mode} ${name}`);
      it(`${mode} ${name}`, async () => {
        const fixture = fixtureFor(name, { userMessage: MATCH }, "tool-args-invalid-json");
        const result = await captureChat(fixture, request(mode === "stream"));
        record(file, `${mode} ${name}`, result);
      });
    }
  }
  it("has its golden file", () => {
    finishGolden(file);
  });
});

// ─── Gemini Live (WebSocket) ───────────────────────────────────────────────

describe("frame codec goldens: Gemini Live", () => {
  const file = "ws-gemini-live";
  for (const name of [...BYTE_CASES, ...DELAY_CASES]) {
    declare(file, name);
    it(name, async () => {
      const fixture = fixtureFor(name, { userMessage: MATCH }, "tool-args-invalid-json");
      const result = await capture(async (log, journal) => {
        const ws = new RecordingWs(log);
        handleWebSocketGeminiLive(asWs(ws), [fixture], journal, {
          ...makeDefaults(journal),
          model: "gemini-2.0-flash-live-001",
        });
        ws.emit(
          "message",
          JSON.stringify({ setup: { model: "models/gemini-2.0-flash-live-001" } }),
        );
        ws.emit(
          "message",
          JSON.stringify({
            clientContent: {
              turns: [{ role: "user", parts: [{ text: MATCH }] }],
              turnComplete: true,
            },
          }),
        );
      });
      record(file, name, result);
    });
  }
  it("has its golden file", () => {
    finishGolden(file);
  });
});
