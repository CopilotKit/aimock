import * as http from "node:http";
import type { Mountable } from "./types.js";
import type { Journal } from "./journal.js";
import type { MetricsRegistry } from "./metrics.js";
import type {
  AGUIFixture,
  AGUIMockOptions,
  AGUIRecordConfig,
  AGUIEvent,
  AGUIRunAgentInput,
} from "./agui-types.js";
import {
  findFixture,
  buildTextResponse,
  buildToolCallResponse,
  buildStateUpdate,
  buildReasoningResponse,
  writeAGUIEventStream,
  type AGUIBuildOpts,
} from "./agui-handler.js";
import { flattenHeaders, readBody } from "./helpers.js";
import { proxyAndRecordAGUI } from "./agui-recorder.js";
import { Logger, type LogLevel } from "./logger.js";

const generatedEvents = new WeakMap<AGUIFixture, (opts: AGUIBuildOpts) => AGUIEvent[]>();

/** Keep convenience builders lazy so each request gets its own run and content IDs. */
function generatedFixture(
  match: AGUIFixture["match"],
  build: (opts: AGUIBuildOpts) => AGUIEvent[],
  delayMs?: number,
): AGUIFixture {
  const fixture: AGUIFixture = { match, events: [], delayMs };
  generatedEvents.set(fixture, build);
  return fixture;
}

export class AGUIMock implements Mountable {
  private fixtures: AGUIFixture[] = [];
  private server: http.Server | null = null;
  private journal: Journal | null = null;
  private registry: MetricsRegistry | null = null;
  private options: AGUIMockOptions;
  private baseUrl = "";
  private recordConfig: AGUIRecordConfig | undefined;
  private logger: Logger;

  constructor(options?: AGUIMockOptions) {
    this.options = options ?? {};
    this.logger = new Logger((options?.logLevel as LogLevel) ?? "warn");
  }

  // ---- Fluent registration API ----

  addFixture(fixture: AGUIFixture): this {
    this.fixtures.push(fixture);
    return this;
  }

  onMessage(pattern: string | RegExp, text: string, opts?: { delayMs?: number }): this {
    this.fixtures.push(
      generatedFixture({ message: pattern }, (ids) => buildTextResponse(text, ids), opts?.delayMs),
    );
    return this;
  }

  onRun(pattern: string | RegExp, events: AGUIEvent[], delayMs?: number): this {
    this.fixtures.push({
      match: { message: pattern },
      events,
      delayMs,
    });
    return this;
  }

  onToolCall(
    pattern: string | RegExp,
    toolName: string,
    args: string,
    opts?: { result?: string; delayMs?: number },
  ): this {
    const result = opts?.result;
    this.fixtures.push(
      generatedFixture(
        { message: pattern },
        (ids) => buildToolCallResponse(toolName, args, { ...ids, result }),
        opts?.delayMs,
      ),
    );
    return this;
  }

  onStateKey(key: string, snapshot: Record<string, unknown>, delayMs?: number): this {
    this.fixtures.push(
      generatedFixture({ stateKey: key }, (ids) => buildStateUpdate(snapshot, ids), delayMs),
    );
    return this;
  }

  onReasoning(pattern: string | RegExp, text: string, opts?: { delayMs?: number }): this {
    this.fixtures.push(
      generatedFixture(
        { message: pattern },
        (ids) => buildReasoningResponse(text, ids),
        opts?.delayMs,
      ),
    );
    return this;
  }

  onPredicate(
    predicate: (input: AGUIRunAgentInput) => boolean,
    events: AGUIEvent[],
    delayMs?: number,
  ): this {
    this.fixtures.push({
      match: { predicate },
      events,
      delayMs,
    });
    return this;
  }

  onToolResult(toolCallId: string, events: AGUIEvent[], delayMs?: number): this {
    this.fixtures.push({
      match: { toolCallId },
      events,
      delayMs,
    });
    return this;
  }

  enableRecording(config: AGUIRecordConfig): this {
    this.recordConfig = config;
    return this;
  }

  reset(): this {
    this.fixtures = [];
    this.recordConfig = undefined;
    return this;
  }

  // ---- Mountable interface ----

  async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
  ): Promise<boolean> {
    if (req.method !== "POST" || (pathname !== "/" && pathname !== "")) {
      return false;
    }

    if (this.registry) {
      this.registry.incrementCounter("aimock_agui_requests_total", { method: "POST" });
    }

    let body: string;
    try {
      body = await readBody(req);
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      const detail = err instanceof Error ? err.message : "body read failed";
      res.end(JSON.stringify({ error: `Failed to read request body: ${detail}` }));
      this.journalRequest(req, pathname, 400);
      return true;
    }

    let input: AGUIRunAgentInput;
    try {
      input = JSON.parse(body) as AGUIRunAgentInput;
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      const detail = err instanceof Error ? err.message : "unknown parse error";
      res.end(JSON.stringify({ error: `Invalid JSON body: ${detail}` }));
      this.journalRequest(req, pathname, 400);
      return true;
    }

    if (input.messages !== undefined && !Array.isArray(input.messages)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Invalid input: 'messages' must be an array when provided",
        }),
      );
      this.journalRequest(req, pathname, 400);
      return true;
    }

    const fixture = findFixture(input, this.fixtures);

    if (fixture) {
      const build = generatedEvents.get(fixture);
      const events = build
        ? build({ threadId: input.threadId, runId: input.runId, parentRunId: input.parentRunId })
        : fixture.events;
      await writeAGUIEventStream(res, events, { delayMs: fixture.delayMs });
      this.journalRequest(req, pathname, 200);
      return true;
    }

    // No match — if recording is enabled, proxy to upstream
    if (this.recordConfig) {
      const result = await proxyAndRecordAGUI(
        req,
        res,
        input,
        this.fixtures,
        this.recordConfig,
        this.logger,
        body,
      );
      if (result !== false) {
        this.journalRequest(req, pathname, result);
        return true;
      }
    }

    // No match, no recorder — 404
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "No matching AG-UI fixture" }));
    this.journalRequest(req, pathname, 404);
    return true;
  }

  health(): { status: string; fixtures: number } {
    return {
      status: "ok",
      fixtures: this.fixtures.length,
    };
  }

  setJournal(journal: Journal): void {
    this.journal = journal;
  }

  setBaseUrl(url: string): void {
    this.baseUrl = url;
  }

  setRegistry(registry: MetricsRegistry): void {
    this.registry = registry;
  }

  // ---- Standalone mode ----

  async start(): Promise<string> {
    if (this.server) {
      throw new Error("AGUIMock server already started");
    }

    const host = this.options.host ?? "127.0.0.1";
    const port = this.options.port ?? 0;

    return new Promise<string>((resolve, reject) => {
      const srv = http.createServer(async (req, res) => {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        const handled = await this.handleRequest(req, res, url.pathname).catch((err) => {
          this.logger.error(`AGUIMock request error: ${err instanceof Error ? err.message : err}`);
          if (!res.headersSent) {
            res.writeHead(500);
            res.end("Internal server error");
          } else if (!res.writableEnded) {
            res.end();
          }
          this.journalRequest(req, url.pathname, res.statusCode);
          return true;
        });
        if (!handled && !res.headersSent) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Not found" }));
          this.journalRequest(req, url.pathname, 404);
        }
      });

      srv.on("error", reject);

      srv.listen(port, host, () => {
        const addr = srv.address();
        if (typeof addr === "object" && addr !== null) {
          this.baseUrl = `http://${host}:${addr.port}`;
        }
        this.server = srv;
        resolve(this.baseUrl);
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) {
      throw new Error("AGUIMock server not started");
    }
    const srv = this.server;
    await new Promise<void>((resolve, reject) => {
      srv.close((err: Error | undefined) => (err ? reject(err) : resolve()));
    });
    this.server = null;
  }

  get url(): string {
    if (!this.server) {
      throw new Error("AGUIMock server not started");
    }
    return this.baseUrl;
  }

  // ---- Private helpers ----

  private journalRequest(req: http.IncomingMessage, pathname: string, status: number): void {
    if (this.journal) {
      this.journal.add({
        method: req.method ?? "POST",
        path: req.url ?? pathname,
        headers: flattenHeaders(req.headers),
        body: null,
        service: "agui",
        response: { status, fixture: null },
      });
    }
  }
}
