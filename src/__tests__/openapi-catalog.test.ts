import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LLMock } from "../llmock.js";
import { CATALOG_ROUTES, buildOpenApiDocument } from "../openapi.js";

describe("OpenAPI route catalog", () => {
  let mock: LLMock;
  beforeEach(async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();
  });
  afterEach(async () => {
    await mock.stop();
  });

  it("lists core surfaces and builds a valid document", () => {
    const paths = new Set(CATALOG_ROUTES.map((r) => `${r.method} ${r.path}`));
    for (const required of [
      "POST /v1/chat/completions",
      "POST /v1/responses",
      "POST /v1/messages",
      "POST /v1/embeddings",
      "GET /v1/models",
      "GET /__aimock/journal",
      "GET /__aimock/openapi.json",
      "GET /__aimock/routes",
    ]) {
      expect(paths.has(required)).toBe(true);
    }
    const doc = buildOpenApiDocument() as {
      openapi: string;
      paths: Record<string, unknown>;
    };
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths).length).toBeGreaterThan(20);
  });

  it("serves /__aimock/openapi.json and /__aimock/routes", async () => {
    const openapi = await fetch(`${mock.url}/__aimock/openapi.json`);
    expect(openapi.status).toBe(200);
    const doc = (await openapi.json()) as {
      openapi: string;
      paths: Record<string, Record<string, unknown>>;
    };
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.paths["/v1/chat/completions"]).toBeDefined();
    expect(doc.paths["/__aimock/journal"]).toBeDefined();

    const routes = await fetch(`${mock.url}/__aimock/routes`);
    expect(routes.status).toBe(200);
    const body = (await routes.json()) as {
      count: number;
      routes: { method: string; path: string }[];
    };
    expect(body.count).toBe(CATALOG_ROUTES.length);
    expect(body.routes.length).toBe(CATALOG_ROUTES.length);
  });
});
