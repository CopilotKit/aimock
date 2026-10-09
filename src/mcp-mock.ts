import * as http from "node:http";
import type { McpFakeSource, McpRecordConfig, Mountable } from "./types.js";
import type { Journal } from "./journal.js";
import type { MetricsRegistry } from "./metrics.js";
import type { Logger } from "./logger.js";
import type {
  MCPMockOptions,
  MCPToolDefinition,
  MCPResourceDefinition,
  MCPResourceContent,
  MCPPromptDefinition,
  MCPPromptResult,
  MCPContent,
  MCPSession,
} from "./mcp-types.js";
import {
  createMCPRequestHandler,
  describeMcpIdentity,
  newMCPRequestRecord,
  type McpDecodeFallback,
  type McpFakeEvent,
  type MCPMessageRecord,
  type MCPRequestRecord,
  type MCPState,
} from "./mcp-handler.js";
import {
  MCP_FAKES_DEFAULT_TEST_ID,
  McpFakeStore,
  type McpFakeAddOrigin,
  type McpFakeAddResult,
  type McpFakeBlockSnapshot,
  type McpFakeReportEventInput,
  type McpFakeReportPart,
} from "./mcp-fakes.js";
import { build, fixed, msg, plainText, quote } from "./message-text.js";
import { flattenHeaders, readBody } from "./helpers.js";
import { McpRecorder, mcpRecordEnv, type RecorderHost } from "./mcp-recorder.js";
import { validateSecretValues } from "./record-sanitize.js";

export class MCPMock implements Mountable {
  private tools: Map<
    string,
    { def: MCPToolDefinition; handler?: (...args: unknown[]) => unknown }
  > = new Map();
  private resources: Map<string, { def: MCPResourceDefinition; content?: MCPResourceContent }> =
    new Map();
  private prompts: Map<
    string,
    {
      def: MCPPromptDefinition;
      handler?: (...args: unknown[]) => MCPPromptResult | Promise<MCPPromptResult>;
    }
  > = new Map();
  private sessions: Map<string, MCPSession> = new Map();
  /** This mount's fakes; kept across `reset()` so the id counters are never rewound. */
  private fakes = new McpFakeStore();
  /** Fake blocks loaded since the last clear. */
  private fakeBlocks = 0;
  /**
   * Decode fallbacks already reported (L2), per live session: one key per
   * field and source, plus one for undecodable query names. Dropped when the
   * session is deleted.
   */
  private decodeWarned = new Map<string, Set<string>>();
  private server: http.Server | null = null;
  private journal: Journal | null = null;
  private registry: MetricsRegistry | null = null;
  /** Mount logger for L1, L2 and L10; none (lines dropped) until `setLogger`. */
  private logger: Logger | null = null;
  /** T1: recorded timing (`durationMs`, `atMs`) plays at value / speed. */
  private replaySpeed = 1;
  /** MR1: the recorder while recording is on, else null (AM1). */
  private recorder: McpRecorder | null = null;
  private options: MCPMockOptions;
  private requestHandler: ReturnType<typeof createMCPRequestHandler>;

  constructor(options?: MCPMockOptions) {
    this.options = options ?? {};
    this.requestHandler = this.buildHandler();
  }

  // ---- Configuration: Tools ----

  addTool(def: MCPToolDefinition): this {
    this.tools.set(def.name, { def });
    return this;
  }

  onToolCall(
    name: string,
    handler: (args: unknown) => MCPContent[] | string | Promise<MCPContent[] | string>,
  ): this {
    const entry = this.tools.get(name);
    if (entry) {
      entry.handler = handler;
    } else {
      this.tools.set(name, { def: { name }, handler });
    }
    return this;
  }

  // ---- Configuration: Resources ----

  addResource(def: MCPResourceDefinition, content?: MCPResourceContent): this {
    this.resources.set(def.uri, { def, content });
    return this;
  }

  // ---- Configuration: Prompts ----

  addPrompt(
    def: MCPPromptDefinition,
    handler?: (args: unknown) => MCPPromptResult | Promise<MCPPromptResult>,
  ): this {
    this.prompts.set(def.name, { def, handler });
    return this;
  }

  // ---- Configuration: MCP fakes ----

  /**
   * Load MCP fakes from code: one `mcpFakes` value (a block, or an array of
   * blocks), in the fixture-file shape, validated here. One run-time addition
   * (`code#<n>` entry ids). Always appends. Returns the shadowed-entry
   * warnings; on any bad block throws one `McpFakesAddError` and adds nothing.
   */
  loadFakes(blocks: unknown): McpFakeAddResult {
    const sources: McpFakeSource[] = Array.isArray(blocks)
      ? blocks.map((raw: unknown, blockIndex) => ({ source: "code", blockIndex, raw }))
      : [{ source: "code", blockIndex: null, raw: blocks }];
    return this.addMcpFakes(sources, { kind: "code" });
  }

  addMcpFakes(blocks: McpFakeSource[], origin: McpFakeAddOrigin): McpFakeAddResult {
    const result = this.fakes.add(blocks, origin);
    this.fakeBlocks += blocks.length;
    return result;
  }

  /**
   * The blocks on this mount that apply to `testId` and `context` (spec 6.5,
   * I9), with every entry id and its consumed state for that test id. `null`
   * means "none sent". Read-only: the result is deeply frozen.
   */
  fakesSnapshot(
    testId: string | null = null,
    context: string | null = null,
  ): readonly McpFakeBlockSnapshot[] {
    return this.fakes.snapshot(testId, context);
  }

  clearMcpFakes(): void {
    this.fakes.clear();
    this.fakeBlocks = 0;
    this.recorder?.reset();
  }

  resetScenarioState(testId?: string): void {
    this.fakes.resetState(testId);
    this.recorder?.reset(testId);
  }

  // ---- MCP recording (MR1) ----

  /**
   * Record a real upstream MCP server (MR1): from now on every request to
   * this mount is forwarded to `config.upstream` (all paths and methods), a
   * fake that applies still answers locally, and each forwarded `tools/list`
   * and `tools/call` is written to an `mcpFakes` file under
   * `config.fixturePath`. `secretValues` and `upstreamAuth` that are
   * `undefined` come from `AIMOCK_RECORD_SECRET_VALUES` and
   * `AIMOCK_MCP_UPSTREAM_AUTH`, as on the CLI and config paths. Throws on an
   * invalid upstream URL, a malformed `upstreamAuth` (or env auth), or a
   * `secretValues` entry shorter than 8 characters.
   */
  enableRecording(config: McpRecordConfig): this {
    let resolved = config;
    if (config.secretValues === undefined || config.upstreamAuth === undefined) {
      const fromEnv = mcpRecordEnv(process.env);
      resolved = {
        ...config,
        secretValues: config.secretValues ?? fromEnv.secretValues,
        upstreamAuth: config.upstreamAuth ?? fromEnv.upstreamAuth,
      };
    }
    validateSecretValues(resolved.secretValues ?? []);
    const recorder = new McpRecorder(this.recorderHost(), resolved);
    this.recorder?.close();
    this.recorder = recorder;
    return this;
  }

  /** Stop recording: the mount serves exactly as before `enableRecording`. */
  disableRecording(): this {
    this.recorder?.close();
    this.recorder = null;
    return this;
  }

  /** @internal MR13: the recorder's write hashes and write listener, or null when not recording. */
  recorderEvents(): Pick<McpRecorder, "lastWrittenHash" | "onWrite"> | null {
    return this.recorder;
  }

  setLogger(logger: Logger): void {
    this.logger = logger;
  }

  /** T1: the speed recorded fake timing plays at; a non-positive or non-finite value is ignored. */
  setReplaySpeed(speed: number): void {
    if (Number.isFinite(speed) && speed > 0) this.replaySpeed = speed;
  }

  /** @internal RP2 report part for this mount (src/mcp-fakes-report.ts reads it). */
  fakesReportPart(testId: string | null, context: string | null, mount: string): McpFakeReportPart {
    return this.fakes.reportPart(testId, context, mount);
  }

  // ---- Mountable interface ----

  async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
  ): Promise<boolean> {
    // AM1 (a): in record mode every path and method under the mount is the
    // recorder's, before the off-root check and the B1 GET answer.
    if (this.recorder) {
      await this.recorder.handle(req, res, mountPathOf(req.url, pathname), pathname);
      return true;
    }
    // Off the mount root: not this mount's request (fall through).
    if (pathname !== "/" && pathname !== "") {
      return false;
    }
    // B1: a GET on the mount root is 405. Any other method but POST and
    // DELETE falls through to the next route, as on origin/main.
    if (req.method === "GET") {
      this.answerMethodNotAllowed(req, res);
      return true;
    }
    if (!isServedMethod(req.method)) {
      return false;
    }
    await this.serve(req, res, mountPathOf(req.url, pathname), false);
    return true;
  }

  /**
   * Serve one request, in both modes (mounted: a POST or DELETE on the mount
   * root; standalone: any method but GET on any path): count it, run the
   * handler, journal it. A throw from the mount's own code is logged with the
   * identity resolved so far, answered 500 and journaled with its message,
   * never left to a generic catch.
   */
  private async serve(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    mount: string,
    standalone: boolean,
  ): Promise<void> {
    const record = newMCPRequestRecord();
    try {
      const body = await readBody(req);
      this.countRequest(req, body);
      await this.requestHandler(req, res, body, mount, record);
      this.journalRequest(req, res, record);
    } catch (err) {
      const thrown = err instanceof Error ? err.message : String(err);
      const who = record.identity
        ? describeMcpIdentity(record.identity)
        : msg`no identity resolved`;
      const line = build(
        msg`MCPMock request error (${who}, mount ${plainText(mount)}): ${plainText(thrown)}`,
      );
      // W5: the standalone server always prints the error, as on origin/main,
      // even when the mount also has a server's (possibly silent) logger.
      // Mounted, it goes to the server's logger, as origin/main's route error did.
      if (standalone || !this.logger) console.error(line);
      else this.logger.error(line);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end("Internal server error");
      } else if (!res.writableEnded) {
        res.end();
      }
      this.journalRequest(req, res, record, thrown);
    }
  }

  /** `aimock_mcp_requests_total` by JSON-RPC method (`session/delete` for DELETE). */
  private countRequest(req: http.IncomingMessage, body: string): void {
    if (this.registry) {
      if (req.method === "DELETE") {
        this.registry.incrementCounter("aimock_mcp_requests_total", { method: "session/delete" });
      } else {
        try {
          const parsed = JSON.parse(body);
          const method =
            typeof parsed === "object" && parsed !== null && "method" in parsed
              ? String(parsed.method)
              : "unknown";
          this.registry.incrementCounter("aimock_mcp_requests_total", { method });
        } catch {
          this.registry.incrementCounter("aimock_mcp_requests_total", { method: "unknown" });
        }
      }
    }
  }

  /**
   * B1: answer 405 (`Allow: POST, DELETE`), journaled. Mounted, this is a GET
   * on the mount root; standalone, a GET on any path.
   */
  private answerMethodNotAllowed(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(405, { "Content-Type": "application/json", Allow: "POST, DELETE" });
    res.end(JSON.stringify({ error: build(msg`Method not allowed: use POST or DELETE`) }));
    req.resume();
    this.journalRequest(req, res, null);
  }

  health(): { status: string; [key: string]: unknown } {
    return {
      status: "ok",
      tools: this.tools.size,
      resources: this.resources.size,
      prompts: this.prompts.size,
      sessions: this.sessions.size,
    };
  }

  setJournal(journal: Journal): void {
    this.journal = journal;
    // I5: the fakes' test-id cap follows the journal's (`0` = unbounded).
    this.fakes.setMaxTestIds(journal.fixtureCountsMaxTestIdsCap);
  }

  setRegistry(registry: MetricsRegistry): void {
    this.registry = registry;
  }

  // ---- Standalone mode ----

  async start(): Promise<string> {
    if (this.server) {
      throw new Error("Server already started");
    }

    const host = this.options.host ?? "127.0.0.1";
    const port = this.options.port ?? 0;

    return new Promise((resolve, reject) => {
      // The standalone server serves every path, as it always has: every
      // method but GET goes to the MCP handler on any path. B1: a GET on any
      // path is 405 (`Allow: POST, DELETE`) and journaled, so the SDK's
      // optional GET SSE stream is declined, not mishandled.
      const srv = http.createServer((req, res) => {
        // AM1 (b): in record mode the recorder takes every request first. A
        // standalone server serves every path as its root, so every request
        // maps to the upstream endpoint itself (review r2 N3).
        if (this.recorder) {
          this.recorder.handle(req, res, "/", "/").catch((err: unknown) => {
            console.error("MCPMock request error:", err);
            if (!res.writableEnded) res.end();
          });
          return;
        }
        if (req.method === "GET") {
          this.answerMethodNotAllowed(req, res);
          return;
        }
        // serve() catches the request's own errors; this is only a logger
        // that threw while reporting one.
        this.serve(req, res, "/", true).catch((err: unknown) => {
          console.error("MCPMock request error:", err);
          if (!res.writableEnded) res.end();
        });
      });

      srv.listen(port, host, () => {
        this.server = srv;
        const addr = srv.address();
        if (typeof addr === "object" && addr !== null) {
          resolve(`http://${host}:${addr.port}`);
        } else {
          resolve(`http://${host}:${port}`);
        }
      });

      srv.on("error", reject);
    });
  }

  async stop(): Promise<void> {
    if (!this.server) {
      throw new Error("Server not started");
    }
    const srv = this.server;
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      srv.close((err) => (err ? reject(err) : resolve()));
    });
  }

  // ---- Inspection ----

  getRequests(): unknown[] {
    if (!this.journal) return [];
    return this.journal.getAll().filter((e) => e.service === "mcp");
  }

  getSessions(): Map<string, MCPSession> {
    return new Map(this.sessions);
  }

  reset(): this {
    this.tools.clear();
    this.resources.clear();
    this.prompts.clear();
    this.sessions.clear();
    this.decodeWarned.clear();
    // R8: fakes and their consumption state go; the id counters stay.
    this.clearMcpFakes();
    this.requestHandler = this.buildHandler();
    return this;
  }

  // ---- Internal ----

  /**
   * The journal entries of one handled request (B2, B3): one per JSON-RPC
   * message (each element of a batch), or one with no body when the request
   * carried none that was read; none without a journal (W5). `error` is what
   * the mount's own code threw while serving it.
   */
  private journalRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    record: MCPRequestRecord | null,
    error?: string,
  ): void {
    if (!this.journal) return;
    const messages: MCPMessageRecord[] = record?.messages.length
      ? record.messages
      : [{ body: null, mcpFake: null, error: null }];
    for (const message of messages) {
      const failed = message.error ?? error;
      this.journal.add({
        method: req.method ?? "POST",
        path: req.url ?? "/",
        headers: flattenHeaders(req.headers),
        body: message.body,
        service: "mcp",
        ...(record?.identity
          ? {
              testId: record.identity.testId ?? MCP_FAKES_DEFAULT_TEST_ID,
              context: record.identity.context,
            }
          : {}),
        response: {
          status: res.statusCode,
          fixture: null,
          ...(message.mcpFake ? { mcpFake: message.mcpFake } : {}),
          ...(failed !== undefined && failed !== null ? { error: failed } : {}),
        },
      });
    }
  }

  /**
   * Side channels of a fake outcome (9.3): the failure metric and the L1 /
   * L10 line. A claim that threw (`internal_error`) is counted and logged
   * like a failure, under `MCP_FAKE_INTERNAL_ERROR`.
   */
  private onFakeEvent(evt: McpFakeEvent): void {
    // RP2, C9: every fake outcome goes to the event log.
    this.fakes.logEvent(evt.identity, toReportEvent(evt));
    if (evt.kind === "answered") return;
    this.registry?.incrementCounter("aimock_mcp_fake_failures_total", { code: evt.code });
    if (!this.logger) return;
    const where = msg`mount ${plainText(evt.mount)}`;
    // "not declared", "internal error"; the other kinds are one word.
    const kind = evt.kind.replace("_", " ");
    const line =
      evt.kind === "evicted"
        ? msg`MCP-FAKE: evicted testId ${quote(evt.testId)} (cap ${evt.cap}) for tools/call ${plainText(evt.tool)} (${where})`
        : msg`MCP-FAKE: ${fixed(kind)} for tools/call ${plainText(evt.tool)} (${describeMcpIdentity(evt.identity)}, ${where}): ${plainText(evt.message)}`;
    this.logger.error(build(line));
  }

  /** RP2, C9: a tools/call no fake applied to is always logged, with who answered it. */
  private logUnfaked(evt: Parameters<MCPState["onUnfaked"]>[0]): void {
    this.fakes.logEvent(evt.identity, {
      outcome: "unfaked",
      answeredBy: evt.answeredBy,
      tool: evt.tool,
      args: evt.args,
      context: evt.identity.context,
      mount: evt.mount,
    });
  }

  /**
   * L2: one warning per session for each identity field and source whose
   * value is not valid percent-encoding (H1), naming that source and value,
   * and one for query names that are not valid percent-encoding.
   */
  private onDecodeFallback(sessionId: string, fallback: McpDecodeFallback): void {
    let warned = this.decodeWarned.get(sessionId);
    if (!warned) {
      warned = new Set();
      this.decodeWarned.set(sessionId, warned);
    }
    const key = fallback.kind === "names" ? "names" : `${fallback.field}:${fallback.source}`;
    if (warned.has(key)) return;
    warned.add(key);
    const session = quote(sessionId);
    if (fallback.kind === "names") {
      const one = fallback.count === 1;
      this.logger?.warn(
        build(
          msg`MCP-FAKE: ${fallback.count} query parameter ${fixed(one ? "name" : "names")} on session ${session} ${fixed(one ? "is" : "are")} not valid percent-encoding; ${fixed(one ? "it matches" : "they match")} no identity field`,
        ),
      );
      return;
    }
    const label = DECODE_LABELS[fallback.field][fallback.source];
    const fate = fallback.used ? "it is used as sent" : "it is ignored (the header value is used)";
    this.logger?.warn(
      build(
        msg`MCP-FAKE: ${fixed(label)} value ${quote(fallback.raw)} on session ${session} is not valid percent-encoding; ${fixed(fate)}`,
      ),
    );
  }

  /** The recorder's view of this mount (fakes, journal, logger, replay speed, side channels). */
  private recorderHost(): RecorderHost {
    const fakes = this.fakes;
    return {
      fakes,
      addMcpFakes: (blocks, origin) => this.addMcpFakes(blocks, origin),
      journalEntry: (entry) => void this.journal?.add(entry),
      logger: () => this.logger,
      replaySpeed: () => this.replaySpeed,
      onFakeEvent: (evt) => this.onFakeEvent(evt),
    };
  }

  private buildHandler() {
    const state: MCPState = {
      serverInfo: this.options.serverInfo ?? { name: "mcp-mock", version: "1.0.0" },
      tools: this.tools,
      resources: this.resources,
      prompts: this.prompts,
      sessions: this.sessions,
      fakes: this.fakes,
      hasFakes: () => this.fakeBlocks > 0,
      onFakeEvent: (evt) => this.onFakeEvent(evt),
      onDecodeFallback: (sessionId, fallback) => this.onDecodeFallback(sessionId, fallback),
      onSessionClosed: (sessionId) => void this.decodeWarned.delete(sessionId),
      onUnfaked: (evt) => this.logUnfaked(evt),
      replaySpeed: () => this.replaySpeed,
    };
    return createMCPRequestHandler(state);
  }
}

/** RP2: a fake outcome as an event-log entry (the store assigns `seq`). */
function toReportEvent(evt: McpFakeEvent): McpFakeReportEventInput {
  const base = { tool: evt.tool, args: evt.args, context: evt.identity.context, mount: evt.mount };
  return evt.kind === "answered"
    ? { ...base, outcome: "answered", entryId: evt.entryId }
    : { ...base, outcome: evt.kind, code: evt.code };
}

/** B1: the only methods the mounted mount root serves; every other one is 405. */
function isServedMethod(method: string | undefined): boolean {
  return method === "POST" || method === "DELETE";
}

/** The L2 label of each identity field's header and query source. */
const DECODE_LABELS = {
  testId: { header: "X-Test-Id header", query: "?testId= query parameter" },
  context: { header: "X-AIMock-Context header", query: "?context= query parameter" },
} as const;

/**
 * The path a mount is served at (I9): the request path without the
 * sub-path the server handed the mount (`/mcp` for `/mcp` or `/mcp/`), `/`
 * at the root.
 */
function mountPathOf(url: string | undefined, subPath: string): string {
  const full = new URL(url ?? "/", "http://mount.invalid").pathname;
  const sub = subPath === "" ? "/" : subPath;
  const mount = full.endsWith(sub) ? full.slice(0, full.length - sub.length) : full;
  return mount === "" ? "/" : mount;
}
