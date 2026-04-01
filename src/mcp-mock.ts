import * as http from "node:http";
import type { Mountable } from "./types.js";
import type { Journal } from "./journal.js";
import type { MetricsRegistry } from "./metrics.js";
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
import { createMCPRequestHandler, type MCPState } from "./mcp-handler.js";
import { flattenHeaders, readBody } from "./helpers.js";

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
  private server: http.Server | null = null;
  private journal: Journal | null = null;
  private registry: MetricsRegistry | null = null;
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

  // ---- Mountable interface ----

  async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
  ): Promise<boolean> {
    // Only handle POST and DELETE to the root of the mount
    if (pathname !== "/" && pathname !== "") {
      return false;
    }
    if (req.method !== "POST" && req.method !== "DELETE") {
      return false;
    }

    const body = await readBody(req);

    // Extract JSON-RPC method for metrics (skip for DELETE — no JSON-RPC body)
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

    await this.requestHandler(req, res, body);

    // Journal the request after the handler completes
    if (this.journal) {
      this.journal.add({
        method: req.method ?? "POST",
        path: req.url ?? "/",
        headers: flattenHeaders(req.headers),
        body: null,
        service: "mcp",
        response: { status: res.statusCode, fixture: null },
      });
    }

    return true;
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
      const srv = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          const body = Buffer.concat(chunks).toString();

          this.requestHandler(req, res, body)
            .then(() => {
              if (this.journal) {
                this.journal.add({
                  method: req.method ?? "POST",
                  path: req.url ?? "/",
                  headers: flattenHeaders(req.headers),
                  body: null,
                  service: "mcp",
                  response: { status: res.statusCode, fixture: null },
                });
              }
            })
            .catch((err) => {
              console.error("MCPMock request error:", err);
              if (!res.headersSent) {
                res.writeHead(500);
                res.end("Internal server error");
              }
            });
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
    this.requestHandler = this.buildHandler();
    return this;
  }

  // ---- Internal ----

  private buildHandler() {
    const state: MCPState = {
      serverInfo: this.options.serverInfo ?? { name: "mcp-mock", version: "1.0.0" },
      tools: this.tools,
      resources: this.resources,
      prompts: this.prompts,
      sessions: this.sessions,
    };
    return createMCPRequestHandler(state);
  }
}
