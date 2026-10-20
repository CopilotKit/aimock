import * as http from "node:http";
import { buildOpenAIError } from "./response/errors.js";
import type { Mountable, JournalEntry } from "./types.js";
import type { Journal } from "./journal.js";
import type { MetricsRegistry } from "./metrics.js";
import type {
  VectorMockOptions,
  VectorCollection,
  VectorEntry,
  QueryResult,
  VectorQuery,
  QueryHandler,
} from "./vector-types.js";
import { createVectorRequestHandler, type VectorState } from "./vector-handler.js";
import { flattenHeaders, isJsonObject, readBody } from "./helpers.js";

export class VectorMock implements Mountable {
  private collections: Map<string, VectorCollection> = new Map();
  private queryHandlers: Map<string, QueryHandler> = new Map();
  private server: http.Server | null = null;
  private journal: Journal | null = null;
  private registry: MetricsRegistry | null = null;
  private options: VectorMockOptions;
  private requestHandler: ReturnType<typeof createVectorRequestHandler>;

  constructor(options?: VectorMockOptions) {
    this.options = options ?? {};
    this.requestHandler = this.buildHandler();
  }

  // ---- Configuration ----

  addCollection(name: string, opts: { dimension: number }): this {
    const collection: VectorCollection = {
      name,
      dimension: opts.dimension,
      vectors: new Map(),
    };
    this.collections.set(name, collection);
    this.requestHandler = this.buildHandler();
    return this;
  }

  upsert(collection: string, vectors: VectorEntry[]): this {
    let col = this.collections.get(collection);
    if (!col) {
      const dim = vectors.length > 0 ? vectors[0].values.length : 0;
      col = { name: collection, dimension: dim, vectors: new Map() };
      this.collections.set(collection, col);
    }
    for (const v of vectors) {
      col.vectors.set(v.id, v);
    }
    this.requestHandler = this.buildHandler();
    return this;
  }

  onQuery(
    collection: string,
    results: QueryResult[] | ((query: VectorQuery) => QueryResult[]),
  ): this {
    this.queryHandlers.set(collection, results);
    this.requestHandler = this.buildHandler();
    return this;
  }

  deleteCollection(name: string): this {
    this.collections.delete(name);
    this.queryHandlers.delete(name);
    this.requestHandler = this.buildHandler();
    return this;
  }

  // ---- Mountable interface ----

  async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
  ): Promise<boolean> {
    // Only consume the request body for methods that carry a body,
    // avoiding double-consumption when the route doesn't match.
    let parsed: Record<string, unknown> = {};
    if (req.method !== "GET" && req.method !== "DELETE" && req.method !== "HEAD") {
      const body = await readBody(req);
      try {
        if (body) parsed = JSON.parse(body);
      } catch (parseErr) {
        const detail = parseErr instanceof Error ? parseErr.message : "unknown";
        if (this.journal) {
          this.journal.add({
            method: req.method ?? "GET",
            path: req.url ?? "/",
            headers: flattenHeaders(req.headers),
            body: null,
            service: "vector",
            response: { status: 400, fixture: null },
          });
        }
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Malformed JSON body: ${detail}` }));
        return true;
      }

      // Reject bodies that parsed but are not a JSON object (e.g. `null`)
      // before the route handlers touch fields — `body.ids`, `body.vectors`,
      // `body.points` and friends throw a TypeError on `null` that nothing
      // catches, killing the process rather than answering the request.
      // Arrays and scalars are rejected for the same reason the JSON handlers
      // reject them: every field reads as `undefined` and the handler answers
      // a misleading `200` on a degenerate empty result.
      if (!isJsonObject(parsed)) {
        if (this.journal) {
          this.journal.add({
            method: req.method ?? "GET",
            path: req.url ?? "/",
            headers: flattenHeaders(req.headers),
            body: null,
            service: "vector",
            response: { status: 400, fixture: null },
          });
        }
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify(
            buildOpenAIError("service-validation", {
              message: "Request body must be a JSON object",
            }),
          ),
        );
        return true;
      }
    }

    const handled = this.requestHandler(req, res, pathname, parsed);

    // Record vector operation metric
    if (handled && this.registry) {
      const { operation, provider } = classifyVectorRequest(req.method ?? "GET", pathname);
      this.registry.incrementCounter("aimock_vector_requests_total", { operation, provider });
    }

    // Journal the request after the handler completes
    if (handled && this.journal) {
      this.journal.add({
        method: req.method ?? "GET",
        path: req.url ?? "/",
        headers: flattenHeaders(req.headers),
        body: null,
        service: "vector",
        response: { status: res.statusCode, fixture: null },
      });
    }

    // When mounted, an unmatched path is answered by the parent server, not
    // here, so journal it once the response is out and only if it really was
    // a 404 — otherwise a path this wrapper declines but the server rewrites
    // and serves would be journaled twice. Keeps mounted mode in step with
    // the standalone 404 journaling below.
    if (!handled && this.journal) {
      const journal = this.journal;
      res.once("finish", () => {
        if (res.statusCode !== 404) return;
        journal.add({
          method: req.method ?? "GET",
          path: req.url ?? "/",
          headers: flattenHeaders(req.headers),
          body: null,
          service: "vector",
          response: { status: 404, fixture: null },
        });
      });
    }

    return handled;
  }

  health(): { status: string; collections: number } {
    return {
      status: "ok",
      collections: this.collections.size,
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
          let parsed: Record<string, unknown> = {};
          try {
            if (body) parsed = JSON.parse(body);
          } catch (parseErr) {
            if (req.method !== "GET") {
              const detail = parseErr instanceof Error ? parseErr.message : "unknown";
              if (this.journal) {
                this.journal.add({
                  method: req.method ?? "GET",
                  path: req.url ?? "/",
                  headers: flattenHeaders(req.headers),
                  body: null,
                  service: "vector",
                  response: { status: 400, fixture: null },
                });
              }
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: `Malformed JSON body: ${detail}` }));
              return;
            }
          }

          // Same non-object rejection as the mounted path above — a `null`
          // body otherwise reaches the route handlers and throws an uncaught
          // TypeError that takes the standalone server's process down.
          if (req.method !== "GET" && !isJsonObject(parsed)) {
            if (this.journal) {
              this.journal.add({
                method: req.method ?? "GET",
                path: req.url ?? "/",
                headers: flattenHeaders(req.headers),
                body: null,
                service: "vector",
                response: { status: 400, fixture: null },
              });
            }
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify(
                buildOpenAIError("service-validation", {
                  message: "Request body must be a JSON object",
                }),
              ),
            );
            return;
          }

          const url = new URL(req.url ?? "/", `http://${host}`);

          const handled = this.requestHandler(req, res, url.pathname, parsed);

          if (handled && this.journal) {
            this.journal.add({
              method: req.method ?? "GET",
              path: req.url ?? "/",
              headers: flattenHeaders(req.headers),
              body: null,
              service: "vector",
              response: { status: res.statusCode, fixture: null },
            });
          }
          if (!handled) {
            if (this.journal) {
              this.journal.add({
                method: req.method ?? "GET",
                path: req.url ?? "/",
                headers: flattenHeaders(req.headers),
                body: null,
                service: "vector",
                response: { status: 404, fixture: null },
              });
            }
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Not found" }));
          }
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

  getRequests(): JournalEntry[] {
    if (!this.journal) return [];
    return this.journal.getAll().filter((e) => e.service === "vector");
  }

  reset(): this {
    this.collections.clear();
    this.queryHandlers.clear();
    this.requestHandler = this.buildHandler();
    return this;
  }

  // ---- Internal ----

  private buildHandler() {
    const state: VectorState = {
      collections: this.collections,
      queryHandlers: this.queryHandlers,
    };
    return createVectorRequestHandler(state);
  }
}

// ---- Helpers ----

/**
 * Classify a vector request by operation and provider based on HTTP method and pathname.
 */
function classifyVectorRequest(
  method: string,
  pathname: string,
): { operation: string; provider: string } {
  // Pinecone paths
  if (pathname === "/query" && method === "POST") {
    return { operation: "query", provider: "pinecone" };
  }
  if (pathname === "/vectors/upsert" && method === "POST") {
    return { operation: "upsert", provider: "pinecone" };
  }
  if (pathname === "/vectors/delete" && method === "POST") {
    return { operation: "delete", provider: "pinecone" };
  }
  if (pathname === "/describe-index-stats" && method === "GET") {
    return { operation: "describe", provider: "pinecone" };
  }

  // Qdrant paths
  if (/^\/collections\/[^/]+\/points\/search$/.test(pathname) && method === "POST") {
    return { operation: "query", provider: "qdrant" };
  }
  if (/^\/collections\/[^/]+\/points$/.test(pathname) && method === "PUT") {
    return { operation: "upsert", provider: "qdrant" };
  }
  if (/^\/collections\/[^/]+\/points\/delete$/.test(pathname) && method === "POST") {
    return { operation: "delete", provider: "qdrant" };
  }

  // ChromaDB paths
  if (/^\/api\/v1\/collections\/[^/]+\/query$/.test(pathname) && method === "POST") {
    return { operation: "query", provider: "chromadb" };
  }
  if (/^\/api\/v1\/collections\/[^/]+\/add$/.test(pathname) && method === "POST") {
    return { operation: "upsert", provider: "chromadb" };
  }
  if (pathname === "/api/v1/collections" && method === "GET") {
    return { operation: "list", provider: "chromadb" };
  }
  if (/^\/api\/v1\/collections\/[^/]+$/.test(pathname) && method === "DELETE") {
    return { operation: "delete", provider: "chromadb" };
  }

  return { operation: "unknown", provider: "unknown" };
}
