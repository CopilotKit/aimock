import type * as http from "node:http";
import type {
  VectorCollection,
  VectorEntry,
  VectorQuery,
  QueryResult,
  QueryHandler,
} from "./vector-types.js";

export interface VectorState {
  collections: Map<string, VectorCollection>;
  queryHandlers: Map<string, QueryHandler>;
}

interface RouteResult {
  handled: boolean;
}

function jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(payload)),
  });
  res.end(payload);
}

function resolveQuery(
  state: VectorState,
  collectionName: string,
  query: VectorQuery,
): QueryResult[] {
  const handler = state.queryHandlers.get(collectionName);
  if (!handler) return [];
  if (typeof handler === "function") return handler(query);
  return handler;
}

// ---- Pinecone-compatible endpoints ----

function handlePinecone(
  state: VectorState,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  body: Record<string, unknown>,
): RouteResult {
  // POST /query
  if (req.method === "POST" && pathname === "/query") {
    const namespace = (body.namespace as string) ?? "default";
    const collection = state.collections.get(namespace);
    if (!collection) {
      jsonResponse(res, 404, { error: { message: `Collection '${namespace}' not found` } });
      return { handled: true };
    }

    const query: VectorQuery = {
      vector: body.vector as number[] | undefined,
      topK: body.topK as number | undefined,
      filter: body.filter,
      collection: namespace,
    };
    const results = resolveQuery(state, namespace, query);
    const topK = query.topK ?? 10;
    const matches = results.slice(0, topK).map((r) => ({
      id: r.id,
      score: r.score,
      ...(r.metadata !== undefined && { metadata: r.metadata }),
    }));

    jsonResponse(res, 200, { matches });
    return { handled: true };
  }

  // POST /vectors/upsert
  if (req.method === "POST" && pathname === "/vectors/upsert") {
    const vectors = (body.vectors ?? []) as Array<{
      id: string;
      values: number[];
      metadata?: Record<string, unknown>;
    }>;
    const namespace = (body.namespace as string) ?? "default";

    let collection = state.collections.get(namespace);
    if (!collection) {
      const dim = vectors.length > 0 ? vectors[0].values.length : 0;
      collection = { name: namespace, dimension: dim, vectors: new Map() };
      state.collections.set(namespace, collection);
    }

    for (const v of vectors) {
      const entry: VectorEntry = { id: v.id, values: v.values, metadata: v.metadata };
      collection.vectors.set(v.id, entry);
    }

    jsonResponse(res, 200, { upsertedCount: vectors.length });
    return { handled: true };
  }

  // POST /vectors/delete
  if (req.method === "POST" && pathname === "/vectors/delete") {
    const ids = (body.ids ?? []) as string[];
    const namespace = (body.namespace as string) ?? "default";
    const collection = state.collections.get(namespace);
    if (collection) {
      for (const id of ids) {
        collection.vectors.delete(id);
      }
    }
    jsonResponse(res, 200, {});
    return { handled: true };
  }

  // GET /describe-index-stats
  if (req.method === "GET" && pathname === "/describe-index-stats") {
    let totalVectorCount = 0;
    let dimension = 0;
    for (const col of state.collections.values()) {
      totalVectorCount += col.vectors.size;
      if (col.dimension > 0) dimension = col.dimension;
    }
    jsonResponse(res, 200, { dimension, totalVectorCount });
    return { handled: true };
  }

  return { handled: false };
}

// ---- Qdrant-compatible endpoints ----

const QDRANT_SEARCH_RE = /^\/collections\/([^/]+)\/points\/search$/;
const QDRANT_UPSERT_RE = /^\/collections\/([^/]+)\/points$/;
const QDRANT_DELETE_RE = /^\/collections\/([^/]+)\/points\/delete$/;

function handleQdrant(
  state: VectorState,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  body: Record<string, unknown>,
): RouteResult {
  // POST /collections/{name}/points/search
  let match = pathname.match(QDRANT_SEARCH_RE);
  if (match && req.method === "POST") {
    const name = decodeURIComponent(match[1]);
    const collection = state.collections.get(name);
    if (!collection) {
      jsonResponse(res, 404, { status: { error: `Collection '${name}' not found` } });
      return { handled: true };
    }

    const query: VectorQuery = {
      vector: body.vector as number[] | undefined,
      topK: body.limit as number | undefined,
      filter: body.filter,
      collection: name,
    };
    const results = resolveQuery(state, name, query);
    const limit = (body.limit as number) ?? 10;
    const result = results.slice(0, limit).map((r) => ({
      id: r.id,
      score: r.score,
      ...(r.metadata !== undefined && { payload: r.metadata }),
    }));

    jsonResponse(res, 200, { result });
    return { handled: true };
  }

  // PUT /collections/{name}/points
  match = pathname.match(QDRANT_UPSERT_RE);
  if (match && req.method === "PUT") {
    const name = decodeURIComponent(match[1]);
    let collection = state.collections.get(name);
    const points = (body.points ?? []) as Array<{
      id: string;
      vector: number[];
      payload?: Record<string, unknown>;
    }>;

    if (!collection) {
      const dim = points.length > 0 ? points[0].vector.length : 0;
      collection = { name, dimension: dim, vectors: new Map() };
      state.collections.set(name, collection);
    }

    for (const p of points) {
      const entry: VectorEntry = { id: String(p.id), values: p.vector, metadata: p.payload };
      collection.vectors.set(String(p.id), entry);
    }

    jsonResponse(res, 200, { status: "ok" });
    return { handled: true };
  }

  // POST /collections/{name}/points/delete
  match = pathname.match(QDRANT_DELETE_RE);
  if (match && req.method === "POST") {
    const name = decodeURIComponent(match[1]);
    const collection = state.collections.get(name);
    const points = (body.points ?? []) as string[];
    if (collection) {
      for (const id of points) {
        collection.vectors.delete(String(id));
      }
    }
    jsonResponse(res, 200, { status: "ok" });
    return { handled: true };
  }

  return { handled: false };
}

// ---- ChromaDB-compatible endpoints ----

const CHROMA_QUERY_RE = /^\/api\/v1\/collections\/([^/]+)\/query$/;
const CHROMA_ADD_RE = /^\/api\/v1\/collections\/([^/]+)\/add$/;
const CHROMA_COLLECTION_RE = /^\/api\/v1\/collections\/([^/]+)$/;
const CHROMA_COLLECTIONS = "/api/v1/collections";

function handleChromaDB(
  state: VectorState,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  body: Record<string, unknown>,
): RouteResult {
  // POST /api/v1/collections/{id}/query
  let match = pathname.match(CHROMA_QUERY_RE);
  if (match && req.method === "POST") {
    const name = decodeURIComponent(match[1]);
    const collection = state.collections.get(name);
    if (!collection) {
      jsonResponse(res, 404, { error: `Collection '${name}' not found` });
      return { handled: true };
    }

    const queryEmbeddings = (body.query_embeddings ?? []) as number[][];
    const nResults = (body.n_results as number) ?? 10;

    // Process each query embedding
    const allIds: string[][] = [];
    const allDistances: number[][] = [];
    const allMetadatas: Array<Array<Record<string, unknown> | null>> = [];

    for (const embedding of queryEmbeddings) {
      const query: VectorQuery = {
        vector: embedding,
        topK: nResults,
        filter: body.where,
        collection: name,
      };
      const results = resolveQuery(state, name, query).slice(0, nResults);

      allIds.push(results.map((r) => r.id));
      allDistances.push(results.map((r) => r.score));
      allMetadatas.push(results.map((r) => r.metadata ?? null));
    }

    jsonResponse(res, 200, {
      ids: allIds,
      distances: allDistances,
      metadatas: allMetadatas,
    });
    return { handled: true };
  }

  // POST /api/v1/collections/{id}/add
  match = pathname.match(CHROMA_ADD_RE);
  if (match && req.method === "POST") {
    const name = decodeURIComponent(match[1]);
    let collection = state.collections.get(name);

    const ids = (body.ids ?? []) as string[];
    const embeddings = (body.embeddings ?? []) as number[][];
    const metadatas = (body.metadatas ?? []) as Array<Record<string, unknown> | undefined>;

    if (!collection) {
      const dim = embeddings.length > 0 ? embeddings[0].length : 0;
      collection = { name, dimension: dim, vectors: new Map() };
      state.collections.set(name, collection);
    }

    for (let i = 0; i < ids.length; i++) {
      const entry: VectorEntry = {
        id: ids[i],
        values: embeddings[i] ?? [],
        metadata: metadatas[i],
      };
      collection.vectors.set(ids[i], entry);
    }

    jsonResponse(res, 200, true);
    return { handled: true };
  }

  // GET /api/v1/collections — list collections
  if (req.method === "GET" && pathname === CHROMA_COLLECTIONS) {
    const collections = Array.from(state.collections.values()).map((c) => ({
      id: c.name,
      name: c.name,
      metadata: null,
    }));
    jsonResponse(res, 200, collections);
    return { handled: true };
  }

  // DELETE /api/v1/collections/{id}
  match = pathname.match(CHROMA_COLLECTION_RE);
  if (match && req.method === "DELETE") {
    const name = decodeURIComponent(match[1]);
    if (!state.collections.has(name)) {
      jsonResponse(res, 404, { error: `Collection '${name}' not found` });
      return { handled: true };
    }
    state.collections.delete(name);
    state.queryHandlers.delete(name);
    jsonResponse(res, 200, { status: "ok" });
    return { handled: true };
  }

  return { handled: false };
}

// ---- Main dispatch ----

export function createVectorRequestHandler(state: VectorState) {
  return (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
    body: Record<string, unknown>,
  ): boolean => {
    const pinecone = handlePinecone(state, req, res, pathname, body);
    if (pinecone.handled) return true;

    const qdrant = handleQdrant(state, req, res, pathname, body);
    if (qdrant.handled) return true;

    const chroma = handleChromaDB(state, req, res, pathname, body);
    if (chroma.handled) return true;

    return false;
  };
}
