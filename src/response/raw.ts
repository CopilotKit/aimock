/**
 * @internal Raw passthrough fixtures (#549): per-wire framing and serving.
 *
 * A raw fixture supplies event objects; aimock adds only the named wire's
 * framing, using exactly the bytes the typed handlers write for that wire:
 *
 * - named SSE (`openai-responses`, `anthropic`, `cohere`):
 *   `event: <type>\ndata: <json>\n\n`
 * - data SSE (`openai-chat`, `gemini`, `gemini-interactions`): `data: <json>\n\n`;
 *   `openai-chat` ends with `data: [DONE]\n\n` unless `raw.done === false`
 * - NDJSON (`ollama`, `ollama-generate`): `<json>\n`
 * - AWS event stream: `bedrock-invoke` wraps each event as a `chunk` frame with
 *   base64 `bytes`; `bedrock-converse` takes the event's single key as the
 *   frame's event type and its value as the payload.
 *
 * The framing functions are pure. `serveRawResponse` checks and journals the
 * fixture. It writes one reply itself: the untimed 500 for a fixture that
 * fails a check, targets another wire or has no body for the request mode.
 * Every other reply goes through the shared delivery layer (`deliverStream`,
 * `deliverJson`), which owns the delay loop, writability checks and abort
 * handling. A reply with a status of 400 or more is never delayed.
 */
import type * as http from "node:http";
import { encodeEventStreamMessage, eventStreamCodec } from "../aws-event-stream.js";
import { rawFixtureContext } from "../fixture-loader.js";
import { flattenHeaders } from "../helpers.js";
import type { Journal } from "../journal.js";
import { recordMisbehaviorOutcome, type MisbehaviorSummary } from "../misbehavior.js";
import { serializeOpenRouterError } from "../openrouter-chat.js";
import { ndjsonCodec } from "../ndjson-writer.js";
import { checkRawResponse } from "../raw-validation.js";
import { sseCodec, writeErrorResponse } from "../sse-writer.js";
import type { Fixture, HandlerDefaults, JournalEntry, RawResponse, RawWireId } from "../types.js";
import { deliverJson, deliverStream } from "./deliver.js";
import { renderError } from "./errors.js";
import type { FrameCodec } from "./frame-loop.js";
import type { ErrorWire } from "./profiles.js";

/** The streaming Content-Type each wire's typed handler sends. */
export function rawContentType(wire: RawWireId): string {
  switch (wire) {
    case "openai-responses":
    case "openai-chat":
    case "anthropic":
    case "gemini":
    case "gemini-interactions":
    case "cohere":
      return "text/event-stream";
    case "ollama":
    case "ollama-generate":
      return "application/x-ndjson";
    case "bedrock-invoke":
    case "bedrock-converse":
      return "application/vnd.amazon.eventstream";
  }
}

/**
 * The default headers of the typed stream on `wire`, read from the typed
 * codec: SSE and NDJSON add `Cache-Control: no-cache` and
 * `Connection: keep-alive`, the AWS event stream `Transfer-Encoding: chunked`.
 */
function rawStreamHeaders(wire: RawWireId): Record<string, string> {
  switch (wire) {
    case "openai-responses":
    case "openai-chat":
    case "anthropic":
    case "gemini":
    case "gemini-interactions":
    case "cohere":
      return sseCodec({ done: false }).headers;
    case "ollama":
    case "ollama-generate":
      return ndjsonCodec().headers;
    case "bedrock-invoke":
    case "bedrock-converse":
      return eventStreamCodec().headers;
  }
}

/** The non-streaming JSON default, as `deliverJson` sends it. */
const JSON_HEADERS: Readonly<Record<string, string>> = { "Content-Type": "application/json" };

/**
 * `defaults` with each `authored` header laid over it. Header names are
 * case-insensitive: an authored header replaces the default of the same name
 * in any letter case and takes the default's spelling, so a later spread over
 * the same defaults (as `deliverJson` does) still has one key per name.
 */
function overrideHeaders(
  defaults: Readonly<Record<string, string>>,
  authored: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const merged: Record<string, string> = { ...defaults };
  const spelling = new Map(Object.keys(defaults).map((name) => [name.toLowerCase(), name]));
  for (const [name, value] of Object.entries(authored ?? {})) {
    merged[spelling.get(name.toLowerCase()) ?? name] = value;
  }
  return merged;
}

/** One raw event, framed for `wire`. Events are checked before framing (raw-validation.ts). */
export function encodeRawFrame(wire: RawWireId, event: Record<string, unknown>): string | Buffer {
  const json = JSON.stringify(event);
  switch (wire) {
    case "openai-responses":
    case "anthropic":
    case "cohere":
      return `event: ${String(event.type)}\ndata: ${json}\n\n`;
    case "openai-chat":
    case "gemini":
    case "gemini-interactions":
      return `data: ${json}\n\n`;
    case "ollama":
    case "ollama-generate":
      return `${json}\n`;
    case "bedrock-invoke":
      return encodeEventStreamMessage("chunk", {
        bytes: Buffer.from(json, "utf8").toString("base64"),
      });
    case "bedrock-converse": {
      // The checker guarantees exactly one key whose value is a JSON object.
      const [eventType] = Object.keys(event);
      const payload = event[eventType];
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error(
          `raw framing internal error: bedrock-converse event "${eventType}" has no object payload`,
        );
      }
      return encodeEventStreamMessage(eventType, payload);
    }
  }
}

/**
 * Bytes written after the last frame, if any. Only `openai-chat` has a
 * terminal (`data: [DONE]`), sent unless `raw.done === false` and never after
 * an interrupted stream.
 */
export function rawTrailer(
  wire: RawWireId,
  raw: RawResponse["raw"],
  aborted: boolean,
): string | undefined {
  if (wire === "openai-chat" && !aborted && raw.done !== false) return "data: [DONE]\n\n";
  return undefined;
}

// ─── Serving ──────────────────────────────────────────────────────────────────

/** The error code for a request the raw fixture has no body for. */
export const RAW_MODE_UNAVAILABLE = "aimock_raw_mode_unavailable";
/** The error code for a raw fixture that fails its checks or targets another wire. */
export const RAW_FIXTURE_INVALID = "aimock_raw_fixture_invalid";

/** Everything {@link serveRawResponse} needs from the calling handler. */
export interface RawServeContext {
  wire: RawWireId;
  /** Whether the request asked for a stream, as the handler decides it. */
  stream: boolean;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  fixture: Fixture;
  response: RawResponse;
  /** The journaled request body, as the handler journals it. */
  body: JournalEntry["body"];
  journal: Journal;
  defaults: HandlerDefaults;
  testId: string;
  misbehaviorSummary?: MisbehaviorSummary;
  /** The dialect of the handler's own `renderError(…, "misbehavior", …)` call. */
  errorWire: ErrorWire;
  /** OpenAI chat requests that arrived on the OpenRouter route. */
  openRouter?: boolean;
}

/**
 * The raw events as a frame codec for the shared frame loop. Its headers are
 * the typed stream's defaults for `wire` with `raw.headers` laid over them.
 */
export function rawCodec(
  wire: RawWireId,
  raw: RawResponse["raw"],
): FrameCodec<Record<string, unknown>> {
  return {
    headers: overrideHeaders(rawStreamHeaders(wire), raw.headers),
    encode: (event) => encodeRawFrame(wire, event),
    trailer: (aborted) => {
      const trailer = rawTrailer(wire, raw, aborted);
      return trailer === undefined ? [] : [trailer];
    },
  };
}

/**
 * The error body for a raw 500, in the dialect of the handler's misbehavior
 * errors. Dialects with no code slot (Gemini, Ollama, OpenRouter) carry the
 * code as a message prefix.
 */
function renderRawError(
  ctx: RawServeContext,
  code: string,
  message: string,
): { body: string; headers?: Record<string, string> } {
  if (ctx.openRouter) return { body: serializeOpenRouterError(500, `${code}: ${message}`) };
  switch (ctx.errorWire) {
    case "openai":
      return renderError("openai", "misbehavior", {
        message,
        type: "server_error",
        ...(ctx.wire === "openai-chat" ? { param: null, includeParam: true as const } : {}),
        code,
      });
    case "messages":
      return renderError("messages", "misbehavior", { type: "api_error", code, message });
    case "gemini":
      return renderError("gemini", "misbehavior", {
        bodyCode: 500,
        message: `${code}: ${message}`,
        status: "INTERNAL",
      });
    case "bedrock":
    case "bedrock-converse":
      return renderError(ctx.errorWire, "misbehavior", {
        type: "InternalServerException",
        code,
        message,
      });
    default:
      return renderError(ctx.errorWire, "misbehavior", { code, message });
  }
}

/**
 * Serve a raw passthrough fixture on the handler's wire: check it, journal it,
 * and send its events or JSON through the shared delivery layer. A fixture
 * that fails a check, targets another wire, or has no body for the requested
 * mode gets a 500 in the handler's misbehavior error dialect, and an error log
 * line. A reply with status 400 or more is never delayed, streaming or not,
 * and one with `json` answers in JSON even to a streaming request.
 */
export async function serveRawResponse(ctx: RawServeContext): Promise<void> {
  const { wire, stream, req, res, fixture, journal, defaults, testId } = ctx;
  const raw = ctx.response.raw;
  const journalBase = {
    method: req.method ?? "POST",
    path: req.url ?? "/",
    headers: flattenHeaders(req.headers),
    body: ctx.body,
  };
  const record = (entry: JournalEntry): void =>
    recordMisbehaviorOutcome({ entry, summary: ctx.misbehaviorSummary, defaults, testId });

  const status = raw.status ?? 200;
  // An error reply (status >= 400) is never delayed, streaming or not, as
  // typed error replies are not. Fixture interruptions still apply.
  const errorReply = status >= 400;
  // An error status with a JSON body answers in JSON even to a streaming
  // request, as provider APIs do; the JSON wins over any events.
  const servesStream = stream && !(errorReply && raw.json !== undefined);

  let failure: { code: string; message: string } | undefined;
  const problems = checkRawResponse(raw, rawFixtureContext(fixture, ctx.response)).filter(
    (finding) => finding.severity === "error",
  );
  if (problems.length > 0) {
    failure = {
      code: RAW_FIXTURE_INVALID,
      message: `invalid raw fixture: ${problems.map((p) => p.message).join("; ")}`,
    };
  } else if (raw.wire !== wire) {
    failure = { code: RAW_FIXTURE_INVALID, message: `raw fixture is for ${raw.wire}, not ${wire}` };
  } else if (servesStream ? raw.events === undefined : raw.json === undefined) {
    failure = {
      code: RAW_MODE_UNAVAILABLE,
      message: `raw fixture has no "${servesStream ? "events" : "json"}" body for a ${
        servesStream ? "streaming" : "non-streaming"
      } request on ${wire}`,
    };
  }
  if (failure) {
    defaults.logger.error(`${journalBase.method} ${journalBase.path}: ${failure.message}`);
    const entry = journal.add({ ...journalBase, response: { status: 500, fixture } });
    entry.response.error = failure.message;
    record(entry);
    const rendered = renderRawError(ctx, failure.code, failure.message);
    for (const [name, value] of Object.entries(rendered.headers ?? {})) res.setHeader(name, value);
    writeErrorResponse(res, 500, rendered.body);
    return;
  }

  const entry = journal.add({ ...journalBase, response: { status, fixture } });
  record(entry);

  if (servesStream) {
    const events = raw.events;
    if (events === undefined) {
      throw new Error(`raw serve internal error: a streamed reply on ${wire} has no events`);
    }
    await deliverStream(
      res,
      entry,
      fixture,
      rawCodec(wire, raw),
      events,
      errorReply
        ? { latency: 0 }
        : {
            latency: fixture.latency ?? defaults.latency,
            streamingProfile: fixture.streamingProfile,
            recordedTimings: fixture.recordedTimings,
            replaySpeed: fixture.replaySpeed ?? defaults.replaySpeed,
          },
      // The codec already carries raw.headers over its defaults.
      { status: raw.status },
    );
    return;
  }

  // The wait is sized from the served JSON, as typed replies size theirs from
  // the served content, in chunks of the fixture's or server's chunk size.
  const json = raw.json;
  if (json === undefined) {
    throw new Error(`raw serve internal error: a JSON reply on ${wire} has no json`);
  }
  const servedLength = JSON.stringify(json).length;
  // deliverJson reads the timing opt-ins from the fixture. With them off, an
  // error reply still gets its writability check and journaling, but no wait.
  await deliverJson(
    res,
    entry,
    errorReply
      ? { ...fixture, nonStreamingTiming: false, nonStreamingTimingAllProviders: false }
      : fixture,
    () => json,
    {
      surface: wire === "openai-chat" ? "openai-chat" : "other",
      status: raw.status,
      payloadLength: servedLength,
      chunkSize: Math.max(1, fixture.chunkSize ?? defaults.chunkSize),
      recordedTimings: fixture.recordedTimings,
      replaySpeed: fixture.replaySpeed ?? defaults.replaySpeed,
      headers: overrideHeaders(JSON_HEADERS, raw.headers),
    },
  );
}
