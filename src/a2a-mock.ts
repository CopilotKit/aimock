import * as http from "node:http";
import type { Mountable } from "./types.js";
import type { Journal } from "./journal.js";
import type {
  A2AAgentDefinition,
  A2AArtifact,
  A2AMockOptions,
  A2APart,
  A2AStreamEvent,
  A2ATask,
} from "./a2a-types.js";
import type { PatternEntry } from "./a2a-handler.js";
import {
  buildAgentCard,
  createA2AMethods,
  extractText,
  findStreamingMatch,
} from "./a2a-handler.js";
import { createJsonRpcDispatcher } from "./jsonrpc.js";
import { generateId, flattenHeaders, readBody } from "./helpers.js";

export class A2AMock implements Mountable {
  private agents: Map<string, { def: A2AAgentDefinition; patterns: PatternEntry[] }> = new Map();
  private tasks: Map<string, A2ATask> = new Map();
  private server: http.Server | null = null;
  private journal: Journal | null = null;
  private options: A2AMockOptions;
  private baseUrl = "";
  private dispatcher: ReturnType<typeof createJsonRpcDispatcher>;

  constructor(options?: A2AMockOptions) {
    this.options = options ?? {};
    this.dispatcher = this.buildDispatcher();
  }

  private buildDispatcher() {
    const methods = createA2AMethods(this.agents, this.tasks);
    return createJsonRpcDispatcher({ methods });
  }

  // ---- Agent registration ----

  registerAgent(def: A2AAgentDefinition): this {
    this.agents.set(def.name, { def, patterns: [] });
    return this;
  }

  // ---- Pattern registration ----

  onMessage(agentName: string, pattern: string | RegExp, parts: A2APart[]): this {
    const agent = this.agents.get(agentName);
    if (!agent) {
      throw new Error(`Agent "${agentName}" not registered`);
    }
    agent.patterns.push({ kind: "message", pattern, agentName, parts });
    return this;
  }

  onTask(agentName: string, pattern: string | RegExp, artifacts: A2AArtifact[]): this {
    const agent = this.agents.get(agentName);
    if (!agent) {
      throw new Error(`Agent "${agentName}" not registered`);
    }
    agent.patterns.push({ kind: "task", pattern, agentName, artifacts });
    return this;
  }

  onStreamingTask(
    agentName: string,
    pattern: string | RegExp,
    events: A2AStreamEvent[],
    delayMs?: number,
  ): this {
    const agent = this.agents.get(agentName);
    if (!agent) {
      throw new Error(`Agent "${agentName}" not registered`);
    }
    agent.patterns.push({ kind: "streamingTask", pattern, agentName, events, delayMs });
    return this;
  }

  // ---- Mountable interface ----

  async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
  ): Promise<boolean> {
    // Agent card endpoint
    if (req.method === "GET" && pathname === "/.well-known/agent-card.json") {
      const card = buildAgentCard(this.agents, this.baseUrl);
      res.writeHead(200, {
        "Content-Type": "application/json",
        "A2A-Version": "1.0",
      });
      res.end(JSON.stringify(card));
      return true;
    }

    // JSON-RPC endpoint
    if (req.method === "POST" && (pathname === "/" || pathname === "")) {
      const body = await readBody(req);

      // Check for SendStreamingMessage before dispatching
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "A2A-Version": "1.0",
        });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error" },
          }),
        );
        return true;
      }

      if (isStreamingRequest(parsed)) {
        await this.handleStreamingMessage(parsed as Record<string, unknown>, req, res);
        return true;
      }

      // Regular JSON-RPC dispatch
      // Add A2A-Version header before dispatching
      res.setHeader("A2A-Version", "1.0");

      await this.dispatcher(req, res, body);

      // Journal the request after the handler completes
      if (this.journal) {
        this.journal.add({
          method: req.method ?? "POST",
          path: pathname,
          headers: flattenHeaders(req.headers),
          body: null,
          service: "a2a",
          response: { status: res.statusCode, fixture: null },
        });
      }

      return true;
    }

    return false;
  }

  health(): { status: string; agents: number; tasks: number } {
    return {
      status: "ok",
      agents: this.agents.size,
      tasks: this.tasks.size,
    };
  }

  setJournal(journal: Journal): void {
    this.journal = journal;
  }

  // ---- Standalone mode ----

  async start(): Promise<string> {
    if (this.server) {
      throw new Error("A2AMock server already started");
    }

    const host = this.options.host ?? "127.0.0.1";
    const port = this.options.port ?? 0;

    return new Promise<string>((resolve, reject) => {
      const srv = http.createServer(async (req, res) => {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        await this.handleRequest(req, res, url.pathname).catch((err) => {
          console.error("A2AMock request error:", err);
          if (!res.headersSent) {
            res.writeHead(500);
            res.end("Internal server error");
          }
        });
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
      throw new Error("A2AMock server not started");
    }
    const srv = this.server;
    await new Promise<void>((resolve, reject) => {
      srv.close((err: Error | undefined) => (err ? reject(err) : resolve()));
    });
    this.server = null;
  }

  get url(): string {
    if (!this.server) {
      throw new Error("A2AMock server not started");
    }
    return this.baseUrl;
  }

  // ---- Reset ----

  reset(): this {
    this.agents.clear();
    this.tasks.clear();
    return this;
  }

  // ---- Internal: set base URL when mounted ----

  setBaseUrl(url: string): void {
    this.baseUrl = url;
  }

  // ---- Private: streaming handler ----

  private async handleStreamingMessage(
    parsed: Record<string, unknown>,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const params = parsed.params as Record<string, unknown> | undefined;
    const id = parsed.id as string | number;
    const text = extractText(params);
    const entry = findStreamingMatch(text, this.agents);

    if (!entry) {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "A2A-Version": "1.0",
      });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: "No matching pattern for message" },
        }),
      );
      return;
    }

    // Create task for the streaming response
    const taskId = generateId("task");
    const contextId = generateId("ctx");
    const userParts: A2APart[] = params?.message
      ? (((params.message as Record<string, unknown>).parts as A2APart[]) ?? [{ text }])
      : [{ text }];

    const task: A2ATask = {
      id: taskId,
      contextId,
      status: { state: "TASK_STATE_WORKING", timestamp: new Date().toISOString() },
      artifacts: [],
      history: [
        {
          messageId: generateId("msg"),
          role: "ROLE_USER",
          parts: userParts,
        },
      ],
    };
    this.tasks.set(taskId, task);

    // Write SSE response
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "A2A-Version": "1.0",
    });

    const delayMs = entry.delayMs ?? 0;

    for (const event of entry.events) {
      if (delayMs > 0) {
        await delay(delayMs);
      }

      let resultPayload: Record<string, unknown>;

      if (event.type === "status") {
        task.status = { state: event.state, timestamp: new Date().toISOString() };
        resultPayload = {
          task: {
            id: task.id,
            contextId: task.contextId,
            status: task.status,
          },
        };
      } else {
        // artifact event
        const artifact = {
          parts: event.parts,
          name: event.name,
          append: event.append,
          lastChunk: event.lastChunk,
        };
        task.artifacts.push({ parts: event.parts, name: event.name });
        resultPayload = {
          task: {
            id: task.id,
            contextId: task.contextId,
            status: task.status,
          },
          artifact,
        };
      }

      const envelope = JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: resultPayload,
      });

      res.write(`data: ${envelope}\n\n`);
    }

    // Final completion — only set COMPLETED if the task is not already in a terminal state
    const TERMINAL_A2A_STATES = new Set([
      "TASK_STATE_COMPLETED",
      "TASK_STATE_FAILED",
      "TASK_STATE_CANCELED",
    ]);
    if (!TERMINAL_A2A_STATES.has(task.status.state)) {
      task.status = { state: "TASK_STATE_COMPLETED", timestamp: new Date().toISOString() };
    }

    res.end();

    // Journal
    if (this.journal) {
      this.journal.add({
        method: "POST",
        path: "/",
        headers: flattenHeaders(req.headers),
        body: null,
        service: "a2a",
        response: { status: res.statusCode, fixture: null },
      });
    }
  }
}

// ---- Helpers ----

function isStreamingRequest(parsed: unknown): boolean {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  const obj = parsed as Record<string, unknown>;
  return obj.method === "SendStreamingMessage";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
