/**
 * MCP record mode (rr: MR1-MR17, par: AM1-AM9): a pass-through proxy inside
 * `MCPMock` that forwards to a real upstream MCP server, relays its answers,
 * and writes the `tools/list` and `tools/call` exchanges it sees as an
 * `mcpFakes` file (FA1-FA5), sanitized (S1-S7).
 *
 * Every file this module writes goes through `sanitizeRecording` and then
 * `persistServiceFakes`; there is no other filesystem write here.
 */
import * as http from "node:http";
import * as https from "node:https";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import type {
  JournalEntry,
  McpFakeIdentity,
  McpFakeSource,
  McpFakeUndeclaredPolicy,
  McpRecordConfig,
  Mountable,
} from "./types.js";
import { MCP_FAKE_ERROR_CODES } from "./types.js";
import { Logger } from "./logger.js";
import { isAuthenticatedRequest } from "./api-key-auth.js";
import {
  flattenHeaders,
  readBody,
  resolveMcpIdentity,
  resolveStrictMode,
  slugifyContext,
  slugifyTestId,
} from "./helpers.js";
import {
  buildForwardHeaders,
  persistServiceFakes,
  removeForwardHeader,
  sanitizeHeaderValue,
} from "./recorder.js";
import {
  MCP_FAKES_DEFAULT_TEST_ID,
  validateMcpFakes,
  type McpFakeAddOriginInternal,
  type McpFakeAddResult,
  type McpFakeClaim,
  type McpFakeStore,
} from "./mcp-fakes.js";
import { fakeFailure, writeFakeToolAnswer, type McpFakeEvent } from "./mcp-handler.js";
import {
  REDACTED,
  RecordUnsafeError,
  knownSecrets,
  sanitizeRecording,
  scrubUrl,
  validateSecretValues,
} from "./record-sanitize.js";
import { aimockVersion } from "./version.js";
import { build, fixed, msg, plainText } from "./message-text.js";

/** AM4: the protocol versions this recorder writes (legacy era only). */
export const RECORDABLE_VERSIONS = new Set(["2025-03-26", "2025-06-18", "2025-11-25"]);
/** MR2 (d): default bytes of one recordable response that are buffered. */
export const DEFAULT_RECORD_BUFFER_BYTES = 64 * 1024 * 1024;
/** MR2 (d): the ceiling `maxRecordBufferBytes` is clamped to. */
export const MAX_RECORD_BUFFER_BYTES = 256 * 1024 * 1024;

/** The MR14 body of a 502 answered for an upstream auth failure. */
const AUTH_FAILURE_ERROR =
  "aimock MCP recording got an upstream auth failure; OAuth discovery is not supported through the recorder; record with a pre-acquired token via upstreamAuth or the client's Authorization header";

/** Hop-by-hop response headers that are never relayed. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
]);

/** The identity query parameters aimock reads and never forwards (MR2 c). */
const IDENTITY_QUERY = new Set(["testId", "context", "undeclared"]);

/** MR7: `_meta` keys dropped from a recorded result. */
const DROPPED_META = ["traceparent", "tracestate", "baggage", "io.modelcontextprotocol/serverInfo"];

const SERVER_INFO_META = "io.modelcontextprotocol/serverInfo";
const RELATED_TASK_META = "io.modelcontextprotocol/related-task";
const PROTOCOL_VERSION_META = "io.modelcontextprotocol/protocolVersion";
/** The version assumed when nothing names one (MR4 source 4). */
const FALLBACK_VERSION = "2025-03-26";

/** A header token (RFC 9110 `token`). */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** What the recorder needs from its `MCPMock`. */
export interface RecorderHost {
  /** MR4 claims, MR12 registration. */
  readonly fakes: McpFakeStore;
  addMcpFakes(blocks: McpFakeSource[], origin: McpFakeAddOriginInternal): McpFakeAddResult;
  journalEntry(entry: Omit<JournalEntry, "id" | "timestamp">): void;
  logger(): Logger | null;
  replaySpeed(): number;
  /** Reuses the mount's metric and log side channels for a fake outcome. */
  onFakeEvent(evt: McpFakeEvent): void;
}

/** A parsed `Name: value` upstream credential header (MR14, AM6). */
export interface UpstreamAuthHeader {
  name: string;
  value: string;
}

/**
 * MR14 / AM6: parse a `Name: value` header, from `upstreamAuth` or
 * `AIMOCK_MCP_UPSTREAM_AUTH`. `undefined` or an empty string is no header. A
 * malformed value is a start error that names `source`, never the value.
 */
export function parseUpstreamAuth(
  raw: string | undefined,
  source = "AIMOCK_MCP_UPSTREAM_AUTH",
): UpstreamAuthHeader | undefined {
  if (raw === undefined || raw === "") return undefined;
  const colon = raw.indexOf(":");
  const name = colon === -1 ? "" : raw.slice(0, colon).trim();
  const value = colon === -1 ? "" : raw.slice(colon + 1).trim();
  if (!HEADER_NAME.test(name) || value === "") {
    throw new Error(`${source} must be "Name: value" (a header name, a colon, then a value)`);
  }
  return { name, value };
}

/** MR3 / AM9: what an upstream `initialize` bound to its session. Private to the recorder. */
interface RecordSession {
  protocolVersion: string | null;
  /** AM4: false when the negotiated version is not recordable. */
  recordable: boolean;
  serverInfo?: Record<string, unknown>;
  clientCapabilities?: unknown;
  clientInfo?: unknown;
  testId?: string;
  context?: string;
  undeclared?: McpFakeUndeclaredPolicy;
}

/** MR16: a `tools/list` being collected page by page. */
interface PendingList {
  tools: unknown[];
  /** The `nextCursor` the next page must be requested with. */
  next: string;
  testId: string | null;
}

/** What is recorded from one request's response. */
type RecordKind = "initialize" | "tools/list" | "tools/call";

/** One JSON-RPC message of an upstream response, with its arrival (ms after the request arrived). */
interface TimedMessage {
  at: number;
  message: Record<string, unknown>;
}

/** The state of one handled request, for its journal entry. */
interface Exchange {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  mount: string;
  subPath: string;
  arrivedAt: number;
  identity: McpFakeIdentity | null;
  /** The resolution's supplied flags (I3: only supplied values are bound at initialize). */
  supplied: { testId: boolean; context: boolean; undeclared: boolean };
  /** The JSON-RPC request (`null` for a batch, an unparsable body, GET or DELETE). */
  message: Record<string, unknown> | null;
  rpcMethod: string | null;
  /** The JSON-RPC id of the request, when it is a request with a string or number id. */
  rpcId: string | number | undefined;
  /** The request's `params`, when it has an object one. */
  params: Record<string, unknown> | undefined;
  recordSkipped?: string;
  mcpFake?: JournalEntry["response"]["mcpFake"];
  proxied: boolean;
  /** X-AIMock-Record-Error text, when the response is not yet sent. */
  recordError?: string;
}

/**
 * The MCP recorder of one `MCPMock`. `handle` always answers the request:
 * by a fake (MR4), a fake error (MR5), or by forwarding it (MR2).
 */
export class McpRecorder {
  private readonly target: URL;
  private readonly auth: UpstreamAuthHeader | undefined;
  private readonly maxBuffer: number;
  private readonly fixturePath: string;
  private readonly secretValues: readonly string[];
  private readonly fallbackLogger = new Logger("warn");
  /** MR3: upstream `Mcp-Session-Id` → what its `initialize` bound. */
  private readonly sessions = new Map<string, RecordSession>();
  /** MR16: pending lists per `${mount}\0${scope}`. */
  private readonly pendingLists = new Map<string, PendingList>();
  /** MR16: completed lists waiting for their block's first call entry. */
  private readonly completedLists = new Map<string, { tools: unknown[]; testId: string | null }>();
  /** MR13: resolved path → sha256 of the last write. */
  private readonly hashes = new Map<string, string>();
  private readonly listeners = new Set<(filepath: string, mcpFakes: unknown) => void>();
  /** RL3: mounts already warned about a request with no scope. */
  private readonly warnedNoScope = new Set<string>();

  constructor(
    private readonly host: RecorderHost,
    private readonly config: McpRecordConfig,
  ) {
    let target: URL;
    try {
      target = new URL(config.upstream);
    } catch {
      // Never echo the value: it can carry credentials (S2 c).
      throw new Error("MCP record upstream is not a valid URL");
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      throw new Error("MCP record upstream must be an http: or https: URL");
    }
    this.target = target;
    this.secretValues = config.secretValues ?? [];
    validateSecretValues(this.secretValues);
    this.auth = parseUpstreamAuth(config.upstreamAuth, "upstreamAuth");
    const max = config.maxRecordBufferBytes;
    this.maxBuffer =
      typeof max === "number" && Number.isFinite(max) && max > 0
        ? Math.min(Math.floor(max), MAX_RECORD_BUFFER_BYTES)
        : DEFAULT_RECORD_BUFFER_BYTES;
    this.fixturePath = config.fixturePath ?? "./fixtures/recorded";
    if (!config.proxyOnly) checkMcpRecordDestination(this.fixturePath);
  }

  /** AM1 entry point. Reads the body itself. Always handles the request. */
  async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    mount: string,
    subPath: string,
  ): Promise<void> {
    const x: Exchange = {
      req,
      res,
      mount,
      subPath,
      arrivedAt: performance.now(),
      identity: null,
      supplied: { testId: false, context: false, undeclared: false },
      message: null,
      rpcMethod: null,
      rpcId: undefined,
      params: undefined,
      proxied: false,
    };
    try {
      const body = await readBody(req);
      const sessionId = headerOf(req, "mcp-session-id");
      const session = sessionId ? this.sessions.get(sessionId) : undefined;
      const resolution = resolveMcpIdentity(req, session);
      if (!resolution.ok) {
        res.writeHead(resolution.error.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: resolution.error.message, code: resolution.error.code }));
        return;
      }
      x.identity = resolution.identity;
      x.supplied = resolution.supplied;

      let parsed: unknown;
      let parsedOk = false;
      if (body !== "") {
        try {
          parsed = JSON.parse(body);
          parsedOk = true;
        } catch {
          /* forwarded as is */
        }
      }
      if (parsedOk && Array.isArray(parsed)) {
        this.skip(x, "batch", "batch");
        await this.forward(x, body, null);
        return;
      }
      if (parsedOk && isObject(parsed) && typeof parsed.method === "string") {
        x.rpcMethod = parsed.method;
        const isRequest = "id" in parsed;
        if (typeof parsed.id === "string" || typeof parsed.id === "number") x.rpcId = parsed.id;
        if (isObject(parsed.params)) x.params = parsed.params;
        if (parsed.method === "tools/call") x.message = parsed;
        if (parsed.method === "initialize" && isRequest) {
          await this.forward(x, body, "initialize");
          return;
        }
        if (parsed.method === "tools/list" && isRequest) {
          await this.forward(x, body, "tools/list");
          return;
        }
        if (parsed.method === "tools/call" && isRequest) {
          if (await this.answerByFake(x, parsed)) return;
          this.logForwardedCall(x);
          await this.forward(x, body, "tools/call");
          return;
        }
        // MR8: every other request is forwarded and not recorded. A
        // notification has no response to record, so it is not reported.
        if (isRequest) this.skip(x, "not-tools", parsed.method);
        await this.forward(x, body, null);
        return;
      }
      if (body !== "" && req.method === "POST") this.skip(x, "not-tools", "(no method)");
      await this.forward(x, body, null);
    } catch (err) {
      const thrown = err instanceof Error ? err.message : String(err);
      this.log().error(
        build(msg`MCP-RECORD: request error on mount ${plainText(mount)}: ${plainText(thrown)}`),
      );
      if (!res.headersSent) {
        res.writeHead(500);
        res.end("Internal server error");
      } else if (!res.writableEnded) {
        res.end();
      }
    } finally {
      this.journal(x);
    }
  }

  /** MR3 / MR16 reset doors (fakes:R1-R5, R8): one test id, or everything. */
  reset(testId?: string): void {
    for (const [id, session] of this.sessions) {
      if (testId === undefined || session.testId === testId) this.sessions.delete(id);
    }
    for (const lists of [this.pendingLists, this.completedLists]) {
      for (const [key, list] of lists) {
        if (testId !== undefined && list.testId !== testId) continue;
        lists.delete(key);
        this.log().warn(
          build(
            msg`MCP-RECORD: forwarded, not recorded (list-incomplete): tools/list on mount ${plainText(mountOfKey(key))}`,
          ),
        );
      }
    }
  }

  /** MR13: the sha256 of the last write to `filepath`, if this recorder wrote it. */
  lastWrittenHash(filepath: string): string | undefined {
    return this.hashes.get(path.resolve(filepath));
  }

  /** MR13: called after each write with the resolved path and the `mcpFakes` written. */
  onWrite(listener: (filepath: string, mcpFakes: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** @internal MR3: whether the record-session map holds `sessionId` (tests). */
  hasRecordSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** MR16: drop pending lists (RL2 list-incomplete) and clear the session map. */
  close(): void {
    this.reset();
    this.listeners.clear();
  }

  // ---- MR4 / MR5 ----

  /**
   * MR4 / MR5 for one `tools/call` request: answer it by a fake, or by a fake
   * error (deny, strict, eviction), and return true; false to forward it.
   */
  private async answerByFake(x: Exchange, message: Record<string, unknown>): Promise<boolean> {
    const params = message.params;
    const name = isObject(params) ? params.name : undefined;
    const id = message.id;
    if (
      typeof name !== "string" ||
      name === "" ||
      (typeof id !== "string" && typeof id !== "number")
    ) {
      return false;
    }
    const identity = x.identity!;
    const args = isObject(params) ? params.arguments : undefined;
    const event = { identity, tool: name, mount: x.mount, args };
    let claim: McpFakeClaim;
    try {
      claim = this.host.fakes.claim(name, args, identity);
    } catch {
      // A claim that throws is an aimock defect: forward, never guess.
      return false;
    }
    if (claim.kind === "answer") {
      x.mcpFake = { id: claim.entry.id, outcome: "answered" };
      this.host.onFakeEvent({ ...event, kind: "answered", entryId: claim.entry.id });
      await writeFakeToolAnswer(
        x.req,
        x.res,
        id,
        claim.result,
        this.host.fakes.replayOf(claim.entry.id),
        params,
        this.host.replaySpeed(),
        null,
        x.arrivedAt,
      );
      return true;
    }
    const strict = resolveStrictMode(this.config.strict, x.req.headers);
    const ctx = { identity, mount: x.mount, notifications: [], calls: [] };
    let failure: ReturnType<typeof fakeFailure> | null = null;
    if (claim.kind === "none") {
      if (this.host.fakes.policy(identity) === "deny" || strict) {
        failure = fakeFailure({ kind: "not_declared" }, name, ctx, () =>
          this.host.fakes.declaredTools(identity),
        );
      }
    } else if (claim.kind === "evicted" || strict) {
      failure = fakeFailure(claim, name, ctx, () => []);
    }
    if (!failure) return false;
    x.mcpFake = { id: null, outcome: failure.outcome };
    this.host.onFakeEvent(
      failure.outcome === "evicted"
        ? {
            ...event,
            kind: "evicted",
            code: failure.code,
            message: failure.message,
            ...failure.evicted,
          }
        : { ...event, kind: failure.outcome, code: failure.code, message: failure.message },
    );
    x.res.writeHead(200, { "Content-Type": "application/json" });
    x.res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: {
          code: MCP_FAKE_ERROR_CODES[failure.code],
          message: failure.message,
          data: { aimock: failure.aimock },
        },
      }),
    );
    return true;
  }

  /** RP2: a forwarded `tools/call` is logged as unfaked, answered by the upstream. */
  private logForwardedCall(x: Exchange): void {
    const name = x.params?.name;
    if (typeof name !== "string" || x.identity === null) return;
    this.host.fakes.logEvent(x.identity, {
      outcome: "unfaked",
      answeredBy: "upstream",
      tool: name,
      args: x.params?.arguments,
      context: x.identity.context,
      mount: x.mount,
    });
  }

  // ---- MR2: forwarding ----

  /** Forward one request to the upstream and relay its answer; record it when `kind` says so. */
  private forward(x: Exchange, body: string, kind: RecordKind | null): Promise<void> {
    const { req, res } = x;
    x.proxied = true;
    if (isAuthenticatedRequest(req) && !this.auth) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "No configured upstream credential" }));
      return Promise.resolve();
    }
    const headers = buildForwardHeaders(req);
    removeForwardHeader(headers, "x-aimock-mcp-undeclared");
    if (this.auth) {
      removeForwardHeader(headers, this.auth.name);
      headers[this.auth.name] = this.auth.value;
    }
    if (body !== "") headers["content-length"] = String(Buffer.byteLength(body));
    const url = this.upstreamUrl(req, x.subPath);
    const transport = url.protocol === "https:" ? https : http;

    return new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        resolve();
      };
      const upstreamReq = transport.request(url, { method: req.method ?? "POST", headers });
      // MR2: a client that goes away aborts the upstream request.
      res.on("close", () => {
        if (!upstreamReq.destroyed) upstreamReq.destroy();
        finish();
      });
      upstreamReq.on("error", (err) => {
        if (done) return;
        this.log().error(
          build(
            msg`MCP-RECORD: upstream request failed for ${plainText(x.rpcMethod ?? req.method ?? "?")} on mount ${plainText(x.mount)}: ${plainText(err.message)}`,
          ),
        );
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "aimock MCP recorder could not reach the upstream" }));
        } else if (!res.writableEnded) {
          res.end();
        }
        finish();
      });
      upstreamReq.on("response", (up) => {
        this.relay(x, up, kind, finish);
      });
      upstreamReq.end(body === "" ? undefined : body);
    });
  }

  /** The upstream URL of a request: the endpoint plus the sub-path, the query minus identity params. */
  private upstreamUrl(req: http.IncomingMessage, subPath: string): URL {
    const url = new URL(this.target.href);
    if (subPath !== "" && subPath !== "/") {
      url.pathname = url.pathname.replace(/\/+$/, "") + subPath;
    }
    // MR2 (c): the client's query pairs are forwarded byte for byte (never
    // re-serialized, which would change their encoding), minus the identity
    // parameters aimock reads.
    const raw = (req.url ?? "").split("#")[0];
    const q = raw.indexOf("?");
    const kept =
      q === -1
        ? []
        : raw
            .slice(q + 1)
            .split("&")
            .filter((pair) => pair !== "" && !IDENTITY_QUERY.has(queryName(pair)));
    if (kept.length > 0) {
      const own = url.search.replace(/^\?/, "");
      url.search = [own, ...kept].filter((part) => part !== "").join("&");
    }
    return url;
  }

  /** MR2 (d), MR14: relay one upstream response, buffering a recordable one. */
  private relay(
    x: Exchange,
    up: http.IncomingMessage,
    kind: RecordKind | null,
    finish: () => void,
  ): void {
    const { req, res } = x;
    const status = up.statusCode ?? 502;
    const sessionId = headerOf(req, "mcp-session-id");
    up.on("error", () => {
      if (!res.writableEnded) res.end();
      finish();
    });

    // MR14: a 401, or a 403 with insufficient_scope, is never relayed.
    const challenge = String(up.headers["www-authenticate"] ?? "");
    if (status === 401 || (status === 403 && /insufficient_scope/i.test(challenge))) {
      up.resume();
      x.recordSkipped = "upstream-auth";
      this.log().error(
        build(
          msg`MCP-RECORD: recording refused (upstream-auth): the upstream answered ${status} for ${plainText(x.rpcMethod ?? req.method ?? "?")} on mount ${plainText(x.mount)}`,
        ),
      );
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: AUTH_FAILURE_ERROR, upstreamStatus: status }));
      finish();
      return;
    }
    // MR3: the session map entry goes with an upstream 404 or a deleted session.
    if (
      sessionId &&
      (status === 404 || (req.method === "DELETE" && status >= 200 && status < 300))
    ) {
      this.sessions.delete(sessionId);
    }

    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(up.headers)) {
      if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue;
      headers[name] = value;
    }
    const ok = status >= 200 && status < 300;
    if (kind === "tools/call" && !ok) this.skip(x, "upstream-status", "tools/call");
    if (kind === "tools/list" && !ok) this.skip(x, "upstream-status", "tools/list");

    if (kind === null || !ok) {
      res.writeHead(status, headers);
      up.pipe(res);
      up.on("end", finish);
      return;
    }

    const isSse = String(up.headers["content-type"] ?? "").includes("text/event-stream");
    const rpcId = x.rpcId;
    const messages: TimedMessage[] = [];
    let processed = false;
    let size = 0;
    let overflow = false;
    const process = (): void => {
      if (processed) return;
      processed = true;
      if (overflow) {
        this.skip(x, "buffer-cap", kind);
        return;
      }
      // This runs in a stream event handler, outside handle()'s try: a throw
      // here must never reach the process (G2b A1).
      try {
        this.onRecordable(x, kind, messages, up);
      } catch (err) {
        // RL1 never carries values: an unexpected error is named, not quoted.
        this.fail(x, "record-error", err instanceof Error ? err.name : typeof err);
      }
    };

    if (isSse) {
      res.writeHead(status, headers);
      res.flushHeaders();
      const decoder = new StringDecoder("utf8");
      let pending = "";
      up.on("data", (chunk: Buffer) => {
        if (!processed && !overflow) {
          size += chunk.length;
          if (size > this.maxBuffer) {
            overflow = true;
            process();
          } else {
            pending += decoder.write(chunk);
            const events = pending.split(/\r?\n\r?\n/);
            pending = events.pop() ?? "";
            for (const event of events) {
              for (const message of sseMessages(event)) {
                messages.push({ at: performance.now() - x.arrivedAt, message });
              }
            }
            // The response is recorded before the client sees it, so a
            // client that reads the file right after its call sees the write.
            if (messages.some((m) => isResponseTo(m.message, rpcId))) process();
          }
        }
        res.write(chunk);
      });
      up.on("end", () => {
        if (!processed && !overflow) {
          for (const message of sseMessages(pending + decoder.end())) {
            messages.push({ at: performance.now() - x.arrivedAt, message });
          }
        }
        process();
        res.end();
        finish();
      });
      return;
    }

    // JSON: buffered whole, so a record error can still be sent as a header.
    const chunks: Buffer[] = [];
    up.on("data", (chunk: Buffer) => {
      if (overflow) {
        res.write(chunk);
        return;
      }
      size += chunk.length;
      if (size > this.maxBuffer) {
        overflow = true;
        process();
        res.writeHead(status, headers);
        for (const c of chunks) res.write(c);
        res.write(chunk);
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    up.on("end", () => {
      if (!overflow) {
        const text = Buffer.concat(chunks).toString("utf8");
        try {
          const parsed: unknown = JSON.parse(text);
          for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
            if (isObject(message)) messages.push({ at: performance.now() - x.arrivedAt, message });
          }
        } catch {
          /* not JSON: nothing to record */
        }
        process();
        if (x.recordError !== undefined) {
          headers["X-AIMock-Record-Error"] = sanitizeHeaderValue(x.recordError);
        }
        res.writeHead(status, headers);
        res.end(text === "" ? undefined : Buffer.concat(chunks));
      } else {
        res.end();
      }
      finish();
    });
  }

  // ---- MR3, MR6-MR10, MR16 ----

  /** A recordable response, once its JSON-RPC response arrived (or its stream ended). */
  private onRecordable(
    x: Exchange,
    kind: RecordKind,
    messages: TimedMessage[],
    up: http.IncomingMessage,
  ): void {
    const response = messages.find((m) => isResponseTo(m.message, x.rpcId));
    if (kind === "initialize") {
      this.onInitialize(x, response?.message, up);
      return;
    }
    if (!response) {
      this.skip(x, "upstream-error", kind);
      return;
    }
    const reason =
      kind === "tools/call"
        ? callSkipReason(response.message, messages)
        : isObject(response.message.result)
          ? null
          : "upstream-error";
    if (reason !== null) {
      this.skip(x, reason, kind);
      return;
    }
    if (!this.versionRecordable(x)) {
      this.skip(x, "unsupported-version", kind);
      return;
    }
    const identity = x.identity!;
    if (identity.testId === null && identity.context === null) {
      // MR9 / RL3: forwarded, not written, warned once per mount.
      x.recordSkipped = "no-scope";
      if (!this.warnedNoScope.has(x.mount)) {
        this.warnedNoScope.add(x.mount);
        this.log().warn(
          build(
            msg`MCP-RECORD: forwarded, not recorded: a request on mount ${plainText(x.mount)} has no testId or context, so it has no recording scope (logged once per mount)`,
          ),
        );
      }
      return;
    }
    if (this.config.proxyOnly) return;
    if (kind === "tools/list") this.onToolsList(x, response.message);
    else this.recordCall(x, response, messages);
  }

  /** MR3 / AM4: bind what an upstream `initialize` negotiated to its session. */
  private onInitialize(
    x: Exchange,
    response: Record<string, unknown> | undefined,
    up: http.IncomingMessage,
  ): void {
    const result = response?.result;
    if (!isObject(result)) return;
    const version = typeof result.protocolVersion === "string" ? result.protocolVersion : null;
    const recordable = version !== null && RECORDABLE_VERSIONS.has(version);
    if (!recordable) this.skip(x, "unsupported-version", "initialize");
    const sessionId = headerOf(up, "mcp-session-id");
    if (!sessionId) return;
    const identity = x.identity!;
    this.sessions.set(sessionId, {
      protocolVersion: version,
      recordable,
      ...(isObject(result.serverInfo) ? { serverInfo: result.serverInfo } : {}),
      clientCapabilities: x.params?.capabilities,
      clientInfo: x.params?.clientInfo,
      // I3: only the values the initialize request itself supplied are bound.
      ...(x.supplied.testId && identity.testId !== null ? { testId: identity.testId } : {}),
      ...(x.supplied.context && identity.context !== null ? { context: identity.context } : {}),
      ...(x.supplied.undeclared && identity.undeclared !== null
        ? { undeclared: identity.undeclared }
        : {}),
    });
  }

  /** AM4: false when the session negotiated, or the request names, a version not recorded. */
  private versionRecordable(x: Exchange): boolean {
    const sessionId = headerOf(x.req, "mcp-session-id");
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (session && !session.recordable) return false;
    const header = headerOf(x.req, "mcp-protocol-version");
    return header === undefined || RECORDABLE_VERSIONS.has(header);
  }

  /** MR16: collect a `tools/list` page; write the list when it completes. */
  private onToolsList(x: Exchange, response: Record<string, unknown>): void {
    const result = response.result as Record<string, unknown>;
    if (!Array.isArray(result.tools)) {
      this.skip(x, "upstream-error", "tools/list");
      return;
    }
    const identity = x.identity!;
    const key = listKey(x.mount, identity);
    const cursor = x.params?.cursor;
    const next = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
    let tools: unknown[];
    if (cursor === undefined) {
      if (this.pendingLists.has(key)) {
        this.log().warn(
          build(
            msg`MCP-RECORD: forwarded, not recorded (list-incomplete): tools/list on mount ${plainText(x.mount)}`,
          ),
        );
      }
      tools = [...result.tools];
    } else {
      const pending = this.pendingLists.get(key);
      if (!pending || pending.next !== cursor) {
        this.skip(x, "list-orphan-page", "tools/list");
        return;
      }
      tools = [...pending.tools, ...result.tools];
    }
    this.pendingLists.delete(key);
    if (next !== undefined) {
      this.pendingLists.set(key, { tools, next, testId: identity.testId });
      return;
    }
    const filepath = this.targetFile(identity);
    const scope = scopeOf(identity);
    if (!fileHasBlock(filepath, scope, x.mount)) {
      // A block needs a call entry; the list waits for the block's first one.
      this.completedLists.set(key, { tools, testId: identity.testId });
      return;
    }
    let list: { value: unknown[]; warnings: string[] };
    try {
      list = sanitizeRecording(tools, this.secrets(x), isMetaBranch);
    } catch (err) {
      this.failUnsafe(x, err);
      return;
    }
    this.persist(x, filepath, scope, (block) => ({
      block: withList(block ?? {}, list.value),
      warnings: (prefix) => list.warnings.map((w) => `${prefix}/list${w}`),
    }));
  }

  /** MR6 / MR7 / MR10-MR12: record one forwarded `tools/call`. */
  private recordCall(x: Exchange, response: TimedMessage, messages: TimedMessage[]): void {
    const identity = x.identity!;
    const name = String(x.params?.name ?? "");
    const result = cleanResult(response.message.result as Record<string, unknown>);
    const entry: Record<string, unknown> = { args: x.params?.arguments ?? {} };
    const errorText = errorTextOf(result);
    if (errorText !== null) entry.error = errorText;
    else entry.result = result;
    const notifications = messages
      .filter(
        (m) =>
          m !== response &&
          m.at <= response.at &&
          !("id" in m.message) &&
          typeof m.message.method === "string" &&
          m.message.method.startsWith("notifications/"),
      )
      .map((m) => ({
        atMs: Math.round(m.at),
        method: m.message.method as string,
        params: isObject(m.message.params) ? m.message.params : {},
      }));
    if (notifications.length > 0) entry.notifications = notifications;
    entry.durationMs = Math.round(response.at);

    const filepath = this.targetFile(identity);
    const scope = scopeOf(identity);
    const key = listKey(x.mount, identity);
    const waitingList = this.completedLists.get(key);
    const secrets = this.secrets(x);
    let clean: { value: Record<string, unknown>; warnings: string[] };
    let recorded: { value: Record<string, unknown>; warnings: string[] };
    let list: { value: unknown[]; warnings: string[] } | null = null;
    try {
      clean = sanitizeRecording(entry, secrets, isMetaBranch);
      recorded = sanitizeRecording(this.provenance(x, response.message), secrets, () => true);
      if (waitingList) list = sanitizeRecording(waitingList.tools, secrets, isMetaBranch);
    } catch (err) {
      this.failUnsafe(x, err);
      return;
    }
    const written = this.persist(x, filepath, scope, (block) => {
      if (!block) {
        return {
          block: {
            scope,
            mount: x.mount,
            ...(list ? { list: list.value } : {}),
            recorded: recorded.value,
            tools: [{ name, calls: [clean.value] }],
          },
          warnings: (prefix) => [
            ...(list ? list.warnings.map((w) => `${prefix}/list${w}`) : []),
            ...recorded.warnings.map((w) => `${prefix}/recorded${w}`),
            ...clean.warnings.map((w) => `${prefix}/tools/0/calls/0${w}`),
          ],
        };
      }
      const tools = Array.isArray(block.tools) ? [...(block.tools as unknown[])] : [];
      let t = tools.findIndex((tool) => isObject(tool) && tool.name === name);
      let c = 0;
      if (t === -1) {
        tools.push({ name, calls: [clean.value] });
        t = tools.length - 1;
      } else {
        const tool = tools[t] as Record<string, unknown>;
        const calls = Array.isArray(tool.calls) ? [...(tool.calls as unknown[])] : [];
        calls.push(clean.value);
        c = calls.length - 1;
        tools[t] = { ...tool, calls };
      }
      // A list that completed before this block appeared (G2b A2) replaces its list.
      const updated = list ? withList({ ...block, tools }, list.value) : { ...block, tools };
      return {
        block: updated,
        warnings: (prefix) => [
          ...(list ? list.warnings.map((w) => `${prefix}/list${w}`) : []),
          ...clean.warnings.map((w) => `${prefix}/tools/${t}/calls/${c}${w}`),
        ],
      };
    });
    if (!written) return;
    if (waitingList) this.completedLists.delete(key);

    // MR12: the new entry is served from memory as `record#<n>`, consumed
    // for the recording test id, so an identical call misses and is recorded.
    const before = new Set(this.host.fakes.allEntryIds());
    try {
      this.host.addMcpFakes(
        [
          {
            source: "record",
            blockIndex: null,
            raw: { scope, mount: x.mount, tools: [{ name, calls: [clean.value] }] },
          },
        ],
        { kind: "record" },
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.log().error(
        build(
          msg`MCP-RECORD: the recorded entry was written but not registered on mount ${plainText(x.mount)}: ${plainText(detail)}`,
        ),
      );
      return;
    }
    const added = this.host.fakes.allEntryIds().filter((id) => !before.has(id));
    this.host.fakes.markConsumed(identity.testId, added);
  }

  /** FA2 `recorded` for a new block (MR6 3). */
  private provenance(x: Exchange, response: Record<string, unknown>): Record<string, unknown> {
    const sessionId = headerOf(x.req, "mcp-session-id");
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    const meta = isObject(x.params?._meta) ? x.params._meta : undefined;
    const result = isObject(response.result) ? response.result : undefined;
    const resultMeta = isObject(result?._meta) ? result._meta : undefined;
    const protocolVersion =
      session?.protocolVersion ??
      (typeof meta?.[PROTOCOL_VERSION_META] === "string"
        ? meta[PROTOCOL_VERSION_META]
        : undefined) ??
      headerOf(x.req, "mcp-protocol-version") ??
      FALLBACK_VERSION;
    const serverInfo =
      session?.serverInfo ??
      (isObject(resultMeta?.[SERVER_INFO_META]) ? resultMeta[SERVER_INFO_META] : undefined);
    return {
      upstream: this.target.origin,
      protocolVersion,
      ...(serverInfo ? { serverInfo } : {}),
      aimockVersion: aimockVersion((m) => this.log().warn(m)),
      at: new Date().toISOString(),
    };
  }

  /** S2 (a)-(d): the known secrets of one request. */
  private secrets(x: Exchange): string[] {
    // The raw values: `flattenHeaders` masks API-key headers for the
    // journal, which would hide the very values S2 (a) must redact.
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(x.req.headers)) {
      if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(", ") : value;
    }
    return knownSecrets({
      headers,
      ...(this.auth ? { upstreamAuth: this.auth } : {}),
      // G2b B1: the URL really sent upstream, so a credential in the
      // client's query string (forwarded per MR2 c) is a known secret (S2 c).
      upstreamUrl: this.upstreamUrl(x.req, x.subPath).href,
      secretValues: this.secretValues,
    });
  }

  /** S6 / RL1: an unsafe recording is not written. */
  private failUnsafe(x: Exchange, err: unknown): void {
    if (!(err instanceof RecordUnsafeError)) throw err;
    this.fail(x, "unsafe", err.reason);
  }

  /** RL1: a recording that was not written, with its reason (never a value). */
  private fail(x: Exchange, reason: string, detail: string): void {
    x.recordSkipped = reason;
    x.recordError = `${reason}: ${detail}`;
    this.log().error(
      build(
        msg`MCP-RECORD: recording failed (${fixed(reason)}) for ${plainText(x.rpcMethod ?? "?")} on mount ${plainText(x.mount)}: ${plainText(detail)}`,
      ),
    );
  }

  /**
   * MR10 / MR11: merge one change into the block of `scope` and this mount
   * (appending a block when none matches), validate the whole file, and write
   * it. `apply` gets that block (`undefined` when it is new) and returns the
   * new block and its sanitizer warnings under the block's pointer.
   */
  private persist(
    x: Exchange,
    filepath: string,
    scope: Record<string, string>,
    apply: (block: Record<string, unknown> | undefined) => {
      block: Record<string, unknown>;
      warnings: (blockPointer: string) => string[];
    },
  ): boolean {
    const result = persistServiceFakes({
      filepath,
      logger: this.log(),
      merge: (existing) => mergeBlock(existing, scope, x.mount, apply),
      validate: (content) => {
        const first = validateMcpFakes(content.mcpFakes, filepath).errors[0];
        if (!first) return null;
        const where = first.entryId ?? first.blockId;
        return where ? `${first.rule} (${where})` : first.rule;
      },
    });
    if (result.kind === "failed") {
      this.fail(x, result.stage === "write" ? "write-failed" : "invalid-merge", result.error);
      return false;
    }
    const resolved = path.resolve(result.filepath);
    this.hashes.set(resolved, result.sha256);
    for (const listener of this.listeners) {
      try {
        listener(resolved, result.content.mcpFakes);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        this.log().error(
          build(
            msg`MCP-RECORD: a write listener failed for ${plainText(resolved)} on mount ${plainText(x.mount)}: ${plainText(detail)}`,
          ),
        );
      }
    }
    return true;
  }

  /** MR10: the file a recording of `identity` goes to. */
  private targetFile(identity: McpFakeIdentity): string {
    const slug =
      identity.testId !== null
        ? slugifyTestId(identity.testId)
        : identity.context !== null
          ? slugifyContext(identity.context)
          : "";
    if (slug) return path.join(this.fixturePath, slug, "mcp.json");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    return path.join(this.fixturePath, `mcp-${timestamp}-${crypto.randomUUID().slice(0, 8)}.json`);
  }

  /** MR8 / RL2: mark the request forwarded-not-recorded and warn. */
  private skip(x: Exchange, reason: string, method: string): void {
    x.recordSkipped = reason;
    this.log().warn(
      build(
        msg`MCP-RECORD: forwarded, not recorded (${fixed(reason)}): ${plainText(method)} on mount ${plainText(x.mount)}`,
      ),
    );
  }

  private log(): Logger {
    return this.host.logger() ?? this.fallbackLogger;
  }

  /** AM8: one journal entry per request. */
  private journal(x: Exchange): void {
    const { req, res } = x;
    this.host.journalEntry({
      method: req.method ?? "POST",
      path: req.url ?? "/",
      headers: flattenHeaders(req.headers),
      body: x.message,
      service: "mcp",
      ...(x.identity
        ? {
            testId: x.identity.testId ?? MCP_FAKES_DEFAULT_TEST_ID,
            context: x.identity.context,
          }
        : {}),
      response: {
        status: res.statusCode,
        fixture: null,
        ...(x.proxied ? { source: "proxy" as const } : {}),
        ...(x.recordSkipped !== undefined ? { recordSkipped: x.recordSkipped } : {}),
        ...(x.mcpFake ? { mcpFake: x.mcpFake } : {}),
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One header's value (the first, when repeated), or undefined. */
function headerOf(req: http.IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** The JSON-RPC messages of one SSE event (its `data:` lines). */
function sseMessages(event: string): Record<string, unknown>[] {
  const data = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");
  if (data === "") return [];
  try {
    const parsed: unknown = JSON.parse(data);
    return (Array.isArray(parsed) ? parsed : [parsed]).filter(isObject);
  } catch {
    return [];
  }
}

/** Whether `message` is the JSON-RPC response to request `id`. */
function isResponseTo(message: Record<string, unknown>, id: string | number | undefined): boolean {
  return id !== undefined && message.id === id && ("result" in message || "error" in message);
}

/** The decoded name of one raw `name=value` query pair (form rules: `+` is a space). */
function queryName(pair: string): string {
  const eq = pair.indexOf("=");
  const name = (eq === -1 ? pair : pair.slice(0, eq)).replace(/\+/g, " ");
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

function mountOfKey(key: string): string {
  return key.slice(0, key.indexOf("\u0000"));
}

/** MR8: why a forwarded `tools/call` response is not recorded, or null. */
function callSkipReason(
  response: Record<string, unknown>,
  messages: TimedMessage[],
): string | null {
  if ("error" in response) return "upstream-error";
  const result = response.result;
  if (!isObject(result)) return "upstream-error";
  if (result.resultType === "input_required") return "input-required";
  if (result.task !== undefined || (isObject(result._meta) && RELATED_TASK_META in result._meta)) {
    return "task-handle";
  }
  if (messages.some((m) => typeof m.message.method === "string" && "id" in m.message)) {
    return "server-request";
  }
  return null;
}

/** MR7: a recorded result without trace `_meta` keys, serverInfo and `resultType: "complete"`. */
function cleanResult(result: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...result };
  if (out.resultType === "complete") delete out.resultType;
  if (isObject(out._meta)) {
    const meta: Record<string, unknown> = { ...out._meta };
    for (const key of DROPPED_META) delete meta[key];
    if (Object.keys(meta).length > 0) out._meta = meta;
    else delete out._meta;
  }
  return out;
}

/** MR6: the `error` text of an `isError` result that is exactly one text block, else null. */
function errorTextOf(result: Record<string, unknown>): string | null {
  if (result.isError !== true) return null;
  if (!Object.keys(result).every((k) => k === "content" || k === "isError")) return null;
  const content = result.content;
  if (!Array.isArray(content) || content.length !== 1) return null;
  const block: unknown = content[0];
  if (!isObject(block) || block.type !== "text" || typeof block.text !== "string") return null;
  return Object.keys(block).length === 2 ? block.text : null;
}

/** S4: credential-shaped keys are removed only inside `_meta`. */
function isMetaBranch(pointer: string): boolean {
  return /(?:^|\/)_meta(?:\/|$)/.test(pointer);
}

/** MR10 block scope: the test id, plus the context when there is one. */
function scopeOf(identity: McpFakeIdentity): Record<string, string> {
  if (identity.testId === null) return { context: identity.context ?? "" };
  return identity.context === null
    ? { testId: identity.testId }
    : { testId: identity.testId, context: identity.context };
}

/** MR10: a block scope exactly equal to `scope`. */
function sameScope(raw: unknown, scope: Record<string, string>): boolean {
  if (!isObject(raw)) return false;
  const keys = Object.keys(scope);
  return Object.keys(raw).length === keys.length && keys.every((k) => raw[k] === scope[k]);
}

/** MR16 pending-list key: mount and scope. */
function listKey(mount: string, identity: McpFakeIdentity): string {
  return `${mount}\u0000${JSON.stringify([identity.testId, identity.context])}`;
}

/** Whether the file at `filepath` already has the block of `scope` and `mount`. */
function fileHasBlock(filepath: string, scope: Record<string, string>, mount: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filepath, "utf-8"));
  } catch {
    return false;
  }
  if (!isObject(parsed)) return false;
  const raw = parsed.mcpFakes;
  const blocks: unknown[] = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  return blocks.some((b) => isObject(b) && sameScope(b.scope, scope) && b.mount === mount);
}

/** MR10 exception: a block with `list` replaced (or inserted after `mount`), key order kept. */
function withList(block: Record<string, unknown>, list: unknown[]): Record<string, unknown> {
  if ("list" in block) return { ...block, list };
  const out: Record<string, unknown> = {};
  let placed = false;
  for (const [key, value] of Object.entries(block)) {
    out[key] = value;
    if (key === "mount") {
      out.list = list;
      placed = true;
    }
  }
  if (!placed) out.list = list;
  return out;
}

/**
 * MR10 append rule over a whole file: the first block whose scope and mount
 * are exactly equal is changed by `apply`; otherwise a block is appended.
 * Object form becomes array form only when a second block is needed. Other
 * top-level keys are kept (fakes:F9); `_warnings` gains the new pointers.
 */
function mergeBlock(
  existing: Record<string, unknown> | null,
  scope: Record<string, string>,
  mount: string,
  apply: (block: Record<string, unknown> | undefined) => {
    block: Record<string, unknown>;
    warnings: (blockPointer: string) => string[];
  },
): Record<string, unknown> {
  const content: Record<string, unknown> = existing ? { ...existing } : {};
  const raw = content.mcpFakes;
  const blocks: unknown[] = Array.isArray(raw) ? [...raw] : raw === undefined ? [] : [raw];
  let index = blocks.findIndex(
    (b) => isObject(b) && sameScope(b.scope, scope) && b.mount === mount,
  );
  const applied = apply(index === -1 ? undefined : (blocks[index] as Record<string, unknown>));
  if (index === -1) {
    blocks.push(applied.block);
    index = blocks.length - 1;
  } else {
    blocks[index] = applied.block;
  }
  const arrayForm = Array.isArray(raw) || blocks.length > 1;
  content.mcpFakes = arrayForm ? blocks : blocks[0];
  let warnings = Array.isArray(content._warnings)
    ? content._warnings.filter((w): w is string => typeof w === "string")
    : [];
  if (isObject(raw) && arrayForm) {
    // The file's only block moved from /mcpFakes to /mcpFakes/0.
    warnings = warnings.map((w) =>
      /^\/mcpFakes(?=[/:])/.test(w) ? `/mcpFakes/0${w.slice("/mcpFakes".length)}` : w,
    );
  }
  const added = applied.warnings(arrayForm ? `/mcpFakes/${index}` : "/mcpFakes");
  if (warnings.length > 0 || added.length > 0)
    content._warnings = [...new Set([...warnings, ...added])];
  return content;
}

// ---- Wiring: the `llmock` flags and `llm.record.mcp` (MR1, AM6) ----

/** One `--mcp-record` / `--mcp-proxy-only` value: `<mount>=<url>`. */
export interface McpRecordFlag {
  mount: string;
  upstream: string;
}

/**
 * A mount key as an error message may show it: JSON-quoted, with any
 * credential (URL userinfo, a credential query parameter, a secret-looking
 * fragment) removed by the record sanitizer's URL rule (S2 c) and marked as
 * removed. A key with an `@` that the URL rule cannot parse is not shown.
 */
export function redactMountForError(mount: string): string {
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(mount);
  const prefix = absolute ? "" : mount.startsWith("/") ? "http://localhost" : "http://";
  const scrubbed = scrubUrl(
    prefix + mount,
    () => false,
    () => {
      throw new Error("unreachable: no value is a secret here");
    },
  );
  if (scrubbed !== prefix + mount) {
    const shown = scrubbed.startsWith(prefix) ? scrubbed.slice(prefix.length) : REDACTED;
    return `${JSON.stringify(shown)} (credentials removed)`;
  }
  return mount.includes("@") && !URL.canParse(prefix + mount)
    ? JSON.stringify(REDACTED)
    : JSON.stringify(mount);
}

/**
 * Why a mount path can never be reached, or `undefined` when it can. The
 * server matches a request's URL pathname against the mount exactly or as a
 * `<mount>/` prefix, so a mount must be a plain, normalized URL path: it
 * starts with one `/`, has no trailing `/` (except the root `/`), and has no
 * query, fragment, whitespace, dot segment or character the URL parser escapes.
 */
export function unreachableMountReason(mount: string): string | undefined {
  if (!mount.startsWith("/")) return 'it must start with "/"';
  if (mount.startsWith("//")) return 'it must not start with "//"';
  if (mount.length > 1 && mount.endsWith("/")) return 'it must not end with "/"';
  if (new URL(mount, "http://localhost").pathname !== mount) {
    return "it must be a plain URL path, with no query, fragment, whitespace, dot segment or escaped character";
  }
  return undefined;
}

/**
 * Why an upstream URL is unusable, or `undefined` when it is a valid http(s)
 * URL. Never includes the value: it can carry credentials (S2 c).
 */
function badUpstreamReason(upstream: string): string | undefined {
  let url: URL;
  try {
    url = new URL(upstream);
  } catch {
    return "is not a valid URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "must be an http: or https: URL";
  }
  return undefined;
}

/**
 * F2: fail at start, not at every write, when the recording destination can
 * never be written. The deepest path component that exists must be a
 * directory this process can write to and enter. A path that does not exist
 * yet is created on the first write, but not through a broken symbolic link.
 * `label` prefixes the error (for example the mount it belongs to).
 */
export function checkMcpRecordDestination(fixturePath: string, label?: string): void {
  const destination = path.resolve(fixturePath);
  const fail = (problem: string): never => {
    const text = `MCP record destination ${destination} ${problem}`;
    throw new Error(label ? `${label}: ${text}` : text);
  };
  const code = (err: unknown): string => (err as NodeJS.ErrnoException | null)?.code ?? String(err);
  let probe = destination;
  for (;;) {
    let stat: fs.Stats | undefined;
    let broken = false;
    try {
      const entry = fs.lstatSync(probe, { throwIfNoEntry: false });
      stat = entry?.isSymbolicLink() ? fs.statSync(probe, { throwIfNoEntry: false }) : entry;
      broken = entry !== undefined && stat === undefined;
    } catch (err) {
      // ENOTDIR: an ancestor is a file; the walk up finds it.
      if (code(err) !== "ENOTDIR") fail(`cannot be checked (${code(err)} at ${probe})`);
    }
    if (broken) fail(`goes through a broken symbolic link at ${probe}`);
    if (stat !== undefined) {
      if (!stat.isDirectory()) fail("is not a directory");
      try {
        fs.accessSync(probe, fs.constants.W_OK | fs.constants.X_OK);
      } catch (err) {
        fail(`is not writable (${code(err)} at ${probe})`);
      }
      return;
    }
    const parent = path.dirname(probe);
    if (parent === probe) return;
    probe = parent;
  }
}

/**
 * Parse a `--mcp-record` / `--mcp-proxy-only` value at its first `=`. The
 * mount must be a reachable path and the upstream an http(s) URL. A bad value
 * throws an error that names `flag`, never the URL (it can carry credentials).
 */
export function parseMcpRecordFlag(value: string, flag = "--mcp-record"): McpRecordFlag {
  const eq = value.indexOf("=");
  const mount = eq === -1 ? "" : value.slice(0, eq);
  const upstream = eq === -1 ? "" : value.slice(eq + 1);
  if (!mount.startsWith("/")) {
    throw new Error(`${flag} must be <mount>=<url>, with a mount that starts with "/"`);
  }
  const unreachable = unreachableMountReason(mount);
  if (unreachable !== undefined) {
    throw new Error(
      `${flag} mount ${redactMountForError(mount)} can never be reached: ${unreachable}`,
    );
  }
  const badUpstream = badUpstreamReason(upstream);
  if (badUpstream !== undefined) {
    throw new Error(`${flag} ${mount}: the upstream ${badUpstream}`);
  }
  return { mount, upstream };
}

/**
 * AM6 / S2 (d): the recorder settings that come from the environment.
 * `AIMOCK_RECORD_SECRET_VALUES` is newline-separated (LF or CRLF); empty
 * entries are dropped and nothing else is trimmed. A malformed
 * `AIMOCK_MCP_UPSTREAM_AUTH` throws an error that names the variable.
 */
export function mcpRecordEnv(env: NodeJS.ProcessEnv): {
  secretValues: string[];
  upstreamAuth: string | undefined;
} {
  const upstreamAuth = env.AIMOCK_MCP_UPSTREAM_AUTH;
  parseUpstreamAuth(upstreamAuth);
  return {
    secretValues: (env.AIMOCK_RECORD_SECRET_VALUES ?? "").split(/\r?\n/).filter(Boolean),
    upstreamAuth: upstreamAuth === "" ? undefined : upstreamAuth,
  };
}

/** A mount that records MCP: an `MCPMock`. */
export interface RecordableMcpMount extends Mountable {
  enableRecording(config: McpRecordConfig): unknown;
}

export interface WireMcpRecordingOptions {
  /** What the caller already mounted, by path. */
  mounted: ReadonlyMap<string, Mountable>;
  /**
   * The `MCPMock` class. It is passed in, because mcp-mock.ts imports this
   * module: a mounted instance of it records, and a free path gets a new one.
   */
  mcpMock: new () => RecordableMcpMount;
  /** `llm.fixtures`: the recording destination is `<fixtures>/recorded`. */
  fixtures?: string;
  /** `llm.record.fixturePath`: overrides the destination. */
  fixturePath?: string;
  strict?: boolean;
  env: NodeJS.ProcessEnv;
}

/**
 * MR1: `llm.record.mcp` — record each mount path. A path the caller mounted
 * with an `MCPMock` records through it; a path held by another kind of mount
 * is a start error; a free path gets a new `MCPMock`, mounted on `llmock`.
 * A string value is `{ upstream }`. `secretValues` and `upstreamAuth` come
 * from the value, else from the environment, as on the `llmock` CLI.
 */
export function wireMcpRecording(
  llmock: { mount(path: string, handler: Mountable): unknown },
  record: Record<string, string | McpRecordConfig>,
  opts: WireMcpRecordingOptions,
): void {
  // F1: the config file is untyped JSON. Before anything is mounted, check
  // every mount's path, settings, upstream URL, holder and destination. The
  // McpRecorder constructor still checks secretValues and upstreamAuth while
  // mounting, so a failure there can leave earlier mounts mounted.
  // Errors name the mount and key, never a value (S2 c).
  const where = "llm.record.mcp";
  const plain = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  const keyTypes: Record<keyof McpRecordConfig, string> = {
    upstream: "a string",
    fixturePath: "a non-empty string",
    proxyOnly: "a boolean",
    maxRecordBufferBytes: `a finite number greater than 0 and at most ${MAX_RECORD_BUFFER_BYTES}`,
    upstreamAuth: "a string",
    secretValues: "an array of strings",
    strict: "a boolean",
  };
  const hasType = (key: keyof McpRecordConfig, v: unknown): boolean => {
    switch (key) {
      case "proxyOnly":
      case "strict":
        return typeof v === "boolean";
      case "maxRecordBufferBytes":
        return typeof v === "number" && Number.isFinite(v) && v > 0 && v <= MAX_RECORD_BUFFER_BYTES;
      case "secretValues":
        return Array.isArray(v) && v.every((s) => typeof s === "string");
      case "fixturePath":
        return typeof v === "string" && v.length > 0;
      default:
        return typeof v === "string";
    }
  };
  const isConfigKey = (key: string): key is keyof McpRecordConfig =>
    Object.prototype.hasOwnProperty.call(keyTypes, key);
  const unknownRecord: unknown = record;
  if (!plain(unknownRecord)) {
    throw new Error(`${where} must be an object of <mount>: <url or record settings>`);
  }
  const sharedFixturePath: unknown = opts.fixturePath;
  if (
    sharedFixturePath !== undefined &&
    !(typeof sharedFixturePath === "string" && sharedFixturePath.length > 0)
  ) {
    throw new Error("llm.record.fixturePath must be a non-empty string");
  }
  const wired: {
    mountPath: string;
    config: McpRecordConfig;
    fixturePath: string | undefined;
    held: RecordableMcpMount | undefined;
  }[] = [];
  for (const [mountPath, value] of Object.entries(unknownRecord)) {
    const mount = redactMountForError(mountPath);
    if (!mountPath.startsWith("/")) {
      throw new Error(
        `${where} must be <mount>: <url or object>, with a mount that starts with "/"; got ${mount}`,
      );
    }
    const unreachable = unreachableMountReason(mountPath);
    if (unreachable !== undefined) {
      throw new Error(`${where} mount ${mount} can never be reached: ${unreachable}`);
    }
    if (typeof value !== "string" && !plain(value)) {
      throw new Error(`${where} mount ${mount} must be an upstream URL string or an object`);
    }
    if (typeof value !== "string") {
      for (const [key, v] of Object.entries(value)) {
        if (!isConfigKey(key)) {
          throw new Error(
            `${where} mount ${mount} has an unknown key ${JSON.stringify(key)} (expected one of ${Object.keys(keyTypes).join(", ")})`,
          );
        }
        if (!hasType(key, v)) {
          throw new Error(`${where} mount ${mount} key ${key} must be ${keyTypes[key]}`);
        }
      }
      if (!("upstream" in value)) {
        throw new Error(`${where} mount ${mount} key upstream is required`);
      }
    }
    // Every key now has its declared type.
    const typed = record[mountPath];
    const config: McpRecordConfig = typeof typed === "string" ? { upstream: typed } : typed;
    const badUpstream = badUpstreamReason(config.upstream);
    if (badUpstream !== undefined) {
      throw new Error(`${where} mount ${mount}: the upstream ${badUpstream}`);
    }
    const held = opts.mounted.get(mountPath);
    if (held !== undefined && !(held instanceof opts.mcpMock)) {
      throw new Error(
        `llm.record.mcp mount ${mountPath} is held by a mount that is not an MCP mock`,
      );
    }
    const fixturePath =
      config.fixturePath ??
      opts.fixturePath ??
      (opts.fixtures ? path.resolve(opts.fixtures, "recorded") : undefined);
    if (!config.proxyOnly) {
      if (fixturePath === undefined) {
        throw new Error(
          "llm.record.mcp requires llm.fixtures or llm.record.fixturePath for the recording destination",
        );
      }
      checkMcpRecordDestination(fixturePath, `${where} mount ${mount}`);
    }
    wired.push({ mountPath, config, fixturePath, held });
  }

  const fromEnv = mcpRecordEnv(opts.env);
  for (const { mountPath, config, fixturePath, held } of wired) {
    const mcp = held ?? new opts.mcpMock();
    mcp.enableRecording({
      ...config,
      fixturePath,
      secretValues: config.secretValues ?? fromEnv.secretValues,
      upstreamAuth: config.upstreamAuth ?? fromEnv.upstreamAuth,
      strict: config.strict ?? opts.strict,
    });
    if (held === undefined) llmock.mount(mountPath, mcp);
  }
}
