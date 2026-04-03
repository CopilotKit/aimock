export interface VectorMockOptions {
  port?: number;
  host?: string;
}

export interface VectorCollection {
  name: string;
  dimension: number;
  vectors: Map<string, VectorEntry>;
}

export interface VectorEntry {
  id: string;
  values: number[];
  metadata?: Record<string, unknown>;
}

export interface QueryResult {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
  values?: number[];
}

export interface VectorQuery {
  vector?: number[];
  topK?: number;
  filter?: unknown;
  collection: string;
}

export type QueryHandler = QueryResult[] | ((query: VectorQuery) => QueryResult[]);
