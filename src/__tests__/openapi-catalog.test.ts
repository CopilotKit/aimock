import { describe, it, expect, beforeEach, afterEach } from "vitest";
import OpenAI, { toFile } from "openai";
import type { SSEChunk, ChatCompletion, ChatCompletionRequest } from "../types.js";
import { LLMock } from "../llmock.js";
import { CATALOG_ROUTES, buildOpenApiDocument } from "../openapi.js";
import { ROUTE_DEFINITIONS, matchRouteDefinition, templateToRegExp } from "../route-registry.js";
import * as registry from "../route-registry.js";

// Only the catalog fields used by the live streaming contract probes.
interface StreamCatalogSchema {
  type?: string;
  description?: string;
  required?: string[];
  enum?: string[];
  properties?: { [name: string]: StreamCatalogSchema };
  items?: StreamCatalogSchema;
  "x-sse-data-schema"?: { $ref: string };
}
interface StreamCatalog {
  components: { schemas: { [name: string]: StreamCatalogSchema } };
  paths: {
    [path: string]: {
      post: {
        responses: { "200": { content: { [media: string]: { schema: { $ref: string } } } } };
      };
    };
  };
}

// Keep framing separate from JSON decoding: [DONE] is not a JSON value.
function sseDataFrames(text: string) {
  expect(text.endsWith("\n\n")).toBe(true);
  return text
    .trimEnd()
    .split("\n\n")
    .map((frame) => {
      expect(frame.startsWith("data: ")).toBe(true);
      return frame.slice(6);
    });
}

// Walk the entire emitted catalog, including references nested in component schemas.
function expectCatalogReferencesResolve(doc: unknown): void {
  const refs = new Set<string>();
  const collect = (node: unknown): void => {
    if (node !== null && typeof node === "object") {
      for (const [key, entry] of Object.entries(node)) {
        if (key === "$ref" && typeof entry === "string") refs.add(entry);
        else collect(entry);
      }
    }
  };
  collect(doc);
  expect(refs.size).toBeGreaterThan(20);
  for (const ref of refs) {
    // The catalog uses local JSON pointers; resolve against the same document.
    expect(ref.startsWith("#/"), `non-local $ref ${ref}`).toBe(true);
    let target: unknown = doc;
    for (const token of ref.slice(2).split("/")) {
      const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
      target =
        target !== null && typeof target === "object"
          ? Object.entries(target).find(([name]) => name === key)?.[1]
          : undefined;
    }
    expect(target !== undefined, `unresolved $ref ${ref}`).toBe(true);
  }
}

describe("OpenAPI route catalog", () => {
  let mock: LLMock;
  const post = (path: string, body: object) =>
    fetch(`${mock.url}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  beforeEach(async () => {
    // metrics:true so GET /metrics is served (otherwise it 404s by design).
    mock = new LLMock({ port: 0, metrics: true });
    await mock.start();
  });
  afterEach(async () => {
    await mock.stop();
  });

  it.each(["omitted", "auto", "static"] as const)(
    "describes emitted vector resource configuration over HTTP: %s",
    async (kind) => {
      const chunking =
        kind === "omitted"
          ? undefined
          : kind === "auto"
            ? { type: "auto" }
            : { type: "static", static: { max_chunk_size_tokens: 100, chunk_overlap_tokens: 50 } };
      const expires = kind === "omitted" ? undefined : { anchor: "last_active_at", days: 1 };
      const attributes =
        kind === "omitted" ? null : { topic: "catalog", enabled: true, year: 2026 };
      const created = await post("/v1/vector_stores", {
        expires_after: expires,
        chunking_strategy: chunking,
      });
      expect(created.status).toBe(200);
      const store = await created.json();
      const client = new OpenAI({ apiKey: "test", baseURL: `${mock.url}/v1` });
      const upload = await client.files.create({
        purpose: "assistants",
        file: await toFile(Buffer.from("resource catalog proof"), "resource.txt"),
      });
      const attached = await post(`/v1/vector_stores/${store.id}/files`, {
        file_id: upload.id,
        attributes,
        chunking_strategy: chunking,
      });
      expect(attached.status).toBe(200);
      const file = await attached.json();
      await client.vectorStores.del(store.id);
      await client.files.del(upload.id);
      expect(store.expires_after).toEqual(expires);
      expect(store.chunking_strategy).toEqual(chunking);
      expect(file.attributes).toEqual(attributes);
      expect(file.chunking_strategy).toEqual(
        kind === "auto"
          ? { type: "static", static: { max_chunk_size_tokens: 800, chunk_overlap_tokens: 400 } }
          : chunking,
      );
      const doc = await (await fetch(`${mock.url}/__aimock/openapi.json`)).json();
      const schemas = doc.components.schemas;
      console.log(
        JSON.stringify({
          kind,
          store,
          file,
          storeSchema: schemas.VectorStore,
          fileSchema: schemas.VectorStoreFile,
        }),
      );
      expect.soft(schemas.VectorStore.properties.expires_after).toEqual({
        $ref: "#/components/schemas/VectorStoreExpiresAfter",
      });
      expect.soft(schemas.VectorStore.properties.chunking_strategy).toEqual({
        $ref: "#/components/schemas/VectorStoreChunkingStrategyRequest",
      });
      expect.soft(schemas.VectorStore.required).not.toContain("expires_after");
      expect.soft(schemas.VectorStore.required).not.toContain("chunking_strategy");
      expect.soft(schemas.VectorStoreFile.properties.attributes).toEqual({
        $ref: "#/components/schemas/VectorStoreAttributes",
      });
      expect.soft(schemas.VectorStoreFile.required).toContain("attributes");
      expect.soft(schemas.VectorStoreFile.required).not.toContain("chunking_strategy");
      expect.soft(schemas.VectorStoreFile.properties.chunking_strategy).toEqual({
        $ref: "#/components/schemas/VectorStoreFileChunkingStrategy",
      });
      expect
        .soft(schemas.VectorStoreFileChunkingStrategy)
        .toEqual(schemas.VectorStoreChunkingStrategyRequest.oneOf[1]);
    },
  );

  it.each(["stores", "files", "batch files"] as const)(
    "describes supported vector list query parameters for %s over HTTP",
    async (kind) => {
      const client = new OpenAI({ apiKey: "test", baseURL: `${mock.url}/v1` });
      const store = await client.vectorStores.create({});
      await client.vectorStores.create({});
      await client.vectorStores.create({});
      const fileIds: string[] = [];
      for (let i = 0; i < 3; i++) {
        const file = await client.files.create({
          purpose: "assistants",
          file: await toFile(Buffer.from("catalog pagination proof"), `page-${i}.txt`),
        });
        fileIds.push(file.id);
      }
      const batch = await client.vectorStores.fileBatches.create(store.id, { file_ids: fileIds });
      const suffix =
        kind === "stores" ? "" : kind === "files" ? "/files" : `/file_batches/${batch.id}/files`;
      const path =
        kind === "stores" ? "/v1/vector_stores" : `/v1/vector_stores/${store.id}${suffix}`;
      const template =
        kind === "stores"
          ? path
          : kind === "files"
            ? "/v1/vector_stores/{vector_store_id}/files"
            : "/v1/vector_stores/{vector_store_id}/file_batches/{batch_id}/files";
      const getPage = async (query: string) => {
        const response = await fetch(`${mock.url}${path}?${query}`);
        expect(response.status).toBe(200);
        const page: { data: { id: string }[]; has_more: boolean } = await response.json();
        return page;
      };
      const all = await getPage("order=asc&limit=100");
      expect(all.data).toHaveLength(3);
      const first = await getPage("order=asc&limit=1");
      expect(first.data).toEqual(all.data.slice(0, 1));
      expect(first.has_more).toBe(true);
      expect((await getPage(`order=asc&limit=1&after=${all.data[0].id}`)).data).toEqual(
        all.data.slice(1, 2),
      );
      expect((await getPage(`order=asc&limit=1&before=${all.data[2].id}`)).data).toEqual(
        all.data.slice(1, 2),
      );
      expect((await getPage("order=desc&limit=1")).data).toEqual(all.data.slice(2));
      for (const invalid of [
        "limit=0",
        "limit=101",
        "order=wrong",
        `after=${all.data[0].id}&before=${all.data[2].id}`,
      ]) {
        expect((await fetch(`${mock.url}${path}?${invalid}`)).status).toBe(400);
      }
      if (kind !== "stores") {
        expect((await getPage("filter=failed")).data).toEqual([]);
        for (const filter of ["in_progress", "completed", "failed", "cancelled"])
          await getPage(`filter=${filter}`);
        expect((await fetch(`${mock.url}${path}?filter=wrong`)).status).toBe(400);
      }
      const doc: {
        paths: {
          [path: string]: {
            get: {
              parameters: {
                name: string;
                in: string;
                required: boolean;
                schema: {
                  type: string;
                  minimum?: number;
                  maximum?: number;
                  default?: string | number;
                  enum?: string[];
                };
              }[];
            };
          };
        };
      } = await (await fetch(`${mock.url}/__aimock/openapi.json`)).json();
      const parameters = doc.paths[template].get.parameters;
      console.log(
        JSON.stringify({
          template,
          livePagination: "passed",
          liveFilter: kind !== "stores",
          parameters,
        }),
      );
      const expected = [
        { name: "limit", schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
        { name: "order", schema: { type: "string", enum: ["asc", "desc"], default: "desc" } },
        { name: "after", schema: { type: "string" } },
        { name: "before", schema: { type: "string" } },
        ...(kind === "stores"
          ? []
          : [
              {
                name: "filter",
                schema: {
                  type: "string",
                  enum: ["in_progress", "completed", "failed", "cancelled"],
                },
              },
            ]),
      ];
      for (const parameter of expected) {
        expect
          .soft(parameters)
          .toEqual(
            expect.arrayContaining([
              expect.objectContaining({ ...parameter, in: "query", required: false }),
            ]),
          );
      }
    },
  );

  it.each([
    { suffix: "/search", field: "query", schemaName: "VectorStoreSearchRequest" },
    { suffix: "/files", field: "file_id", schemaName: "VectorStoreFileCreateRequest" },
    { suffix: "/file_batches", field: "file_ids", schemaName: "VectorStoreFileBatchCreateRequest" },
  ])(
    "describes the real vector request contract for $suffix",
    async ({ suffix, field, schemaName }) => {
      const doc = await (await fetch(`${mock.url}/__aimock/openapi.json`)).json();
      const store = await (await post("/v1/vector_stores", {})).json();
      const upload = new FormData();
      upload.set("purpose", "assistants");
      upload.set("file", new Blob(["catalog request proof"]), "catalog.txt");
      const file = await (
        await fetch(`${mock.url}/v1/files`, { method: "POST", body: upload })
      ).json();
      const path = `/v1/vector_stores/${store.id}${suffix}`;
      const template = `/v1/vector_stores/{vector_store_id}${suffix}`;
      const valid =
        suffix === "/search"
          ? { query: ["catalog", "proof"] }
          : suffix === "/files"
            ? {
                file_id: file.id,
                attributes: { topic: "catalog", enabled: true, year: 2026 },
                chunking_strategy: { type: "auto" },
              }
            : {
                file_ids: [file.id],
                attributes: null,
                chunking_strategy: {
                  type: "static",
                  static: { max_chunk_size_tokens: 100, chunk_overlap_tokens: 50 },
                },
              };
      const missing = await post(path, {});
      const empty = await post(path, { [field]: field === "file_id" ? "" : [] });
      const accepted = await post(path, valid);
      expect([missing.status, empty.status, accepted.status]).toEqual([400, 400, 200]);
      const ref = doc.paths[template].post.requestBody.content["application/json"].schema.$ref;
      const schema = doc.components.schemas[ref.split("/").at(-1)];
      console.log(
        JSON.stringify({
          template,
          statuses: [missing.status, empty.status, accepted.status],
          ref,
          schema,
        }),
      );
      expect.soft(ref).toBe(`#/components/schemas/${schemaName}`);
      expect.soft(schema.required).toContain(field);
      if (field === "file_id")
        expect.soft(schema.properties.file_id).toEqual({ type: "string", minLength: 1 });
      if (field === "file_ids")
        expect.soft(schema.properties.file_ids).toMatchObject({
          type: "array",
          minItems: 1,
          maxItems: 2000,
          uniqueItems: true,
          items: { type: "string", minLength: 1 },
        });
      if (field === "query")
        expect.soft(schema.properties.query).toEqual({
          oneOf: [
            { type: "string", minLength: 1 },
            { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
          ],
        });
    },
  );

  it("describes vector create/update and nested request forms accepted over HTTP", async () => {
    const doc = await (await fetch(`${mock.url}/__aimock/openapi.json`)).json();
    const schemas = doc.components.schemas;
    const created = await post("/v1/vector_stores", {
      name: "catalog",
      file_ids: [],
      metadata: { source: "test" },
      expires_after: { anchor: "last_active_at", days: 1 },
      chunking_strategy: { type: "auto" },
    });
    expect(created.status).toBe(200);
    const store = await created.json();
    const updated = await post(`/v1/vector_stores/${store.id}`, {
      name: null,
      metadata: null,
      expires_after: null,
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ name: "", metadata: null, expires_at: null });
    const filter = {
      type: "and",
      filters: [
        { type: "eq", key: "topic", value: "catalog" },
        { type: "or", filters: [{ type: "gte", key: "year", value: 2026 }] },
      ],
    };
    expect(
      (
        await post(`/v1/vector_stores/${store.id}/search`, {
          query: "catalog",
          filters: filter,
          max_num_results: 50,
          ranking_options: { score_threshold: 0.5 },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post(`/v1/vector_stores/${store.id}/search`, {
          query: "catalog",
          filters: { type: "eq", key: "topic" },
        })
      ).status,
    ).toBe(400);
    expect(
      doc.paths["/v1/vector_stores/{vector_store_id}"].post.requestBody.content["application/json"]
        .schema.$ref,
    ).toBe("#/components/schemas/VectorStoreUpdateRequest");
    expect(schemas.VectorStoreUpdateRequest.properties.name.type).toEqual(["string", "null"]);
    expect(schemas.VectorStoreUpdateRequest.properties.expires_after.oneOf).toContainEqual({
      type: "null",
    });
    expect(schemas.VectorStoreCreateRequest.properties.file_ids).toMatchObject({
      maxItems: 2000,
      items: { minLength: 1 },
    });
    expect(schemas.VectorStoreCreateRequest.properties.file_ids.minItems).toBeUndefined();
    expect(schemas.VectorStoreMetadata).toMatchObject({
      type: ["object", "null"],
      maxProperties: 16,
      propertyNames: { maxLength: 64 },
      additionalProperties: { type: "string", maxLength: 512 },
    });
    expect(schemas.VectorStoreAttributes).toMatchObject({
      type: ["object", "null"],
      maxProperties: 16,
      propertyNames: { maxLength: 64 },
      additionalProperties: {
        oneOf: [{ type: "string", maxLength: 512 }, { type: "number" }, { type: "boolean" }],
      },
    });
    for (const name of ["VectorStoreFileCreateRequest", "VectorStoreFileBatchCreateRequest"]) {
      expect(schemas[name].properties.attributes.$ref).toBe(
        "#/components/schemas/VectorStoreAttributes",
      );
      expect(schemas[name].properties.chunking_strategy.$ref).toBe(
        "#/components/schemas/VectorStoreChunkingStrategyRequest",
      );
    }
    expect(schemas.VectorStoreChunkingStrategyRequest.oneOf[0]).toMatchObject({
      required: ["type"],
      properties: { type: { enum: ["auto"] } },
    });
    expect(schemas.VectorStoreChunkingStrategyRequest.oneOf[1].properties.static).toMatchObject({
      required: ["max_chunk_size_tokens", "chunk_overlap_tokens"],
      properties: {
        max_chunk_size_tokens: { minimum: 100, maximum: 4096 },
        chunk_overlap_tokens: { minimum: 0, maximum: 2048 },
      },
    });
    expect(schemas.VectorStoreSearchRequest.properties.filters.$ref).toBe(
      "#/components/schemas/VectorStoreAttributeFilter",
    );
    expect(schemas.VectorStoreAttributeFilter.oneOf[0]).toMatchObject({
      required: ["type", "key", "value"],
      properties: {
        type: { enum: ["eq", "ne", "gt", "gte", "lt", "lte"] },
        value: { type: ["string", "number", "boolean"] },
      },
    });
    expect(schemas.VectorStoreAttributeFilter.oneOf[1]).toMatchObject({
      required: ["type", "filters"],
      properties: {
        type: { enum: ["and", "or"] },
        filters: { items: { $ref: "#/components/schemas/VectorStoreAttributeFilter" } },
      },
    });
  });

  it.each([
    { label: "empty string query", query: "catalog", populated: false, attributes: null },
    { label: "populated string query", query: "catalog", populated: true, attributes: null },
    {
      label: "populated array query with attributes",
      query: ["catalog", "proof"],
      populated: true,
      attributes: { category: "guide", revision: 2, published: true },
    },
  ])(
    "describes the real vector search response: $label",
    async ({ query, populated, attributes }) => {
      const client = new OpenAI({ apiKey: "mock", baseURL: `${mock.url}/v1`, maxRetries: 0 });
      const store = await client.vectorStores.create({ name: "catalog search" });
      if (populated) {
        const file = await client.files.create({
          purpose: "assistants",
          file: await toFile(Buffer.from("catalog proof"), "catalog.txt"),
        });
        await client.vectorStores.files.create(store.id, { file_id: file.id, attributes });
        await client.vectorStores.files.retrieve(store.id, file.id);
        await client.vectorStores.files.retrieve(store.id, file.id);
      }
      const response = await client.vectorStores.search(store.id, { query }).asResponse();
      expect(response.status).toBe(200);
      const body = await response.json();
      const doc = await (await fetch(`${mock.url}/__aimock/openapi.json`)).json();
      const ref =
        doc.paths["/v1/vector_stores/{vector_store_id}/search"].post.responses["200"].content[
          "application/json"
        ].schema;
      const schema = doc.components.schemas[ref.$ref.split("/").at(-1)];
      expect(body.object).toBe("vector_store.search_results_page");
      expect(body.search_query).toEqual(query);
      expect(body.data).toHaveLength(populated ? 1 : 0);
      expect(body.has_more).toBe(false);
      expect
        .soft(schema.required)
        .toEqual(expect.arrayContaining(["object", "search_query", "data", "has_more"]));
      expect.soft(schema.properties.object.enum).toEqual([body.object]);
      expect.soft(schema.properties.search_query).toEqual({
        oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
      });
      expect.soft(schema.properties.has_more.type).toBe(typeof body.has_more);
      const result = schema.properties.data.items;
      expect
        .soft(result.required)
        .toEqual(expect.arrayContaining(["file_id", "filename", "score", "content", "attributes"]));
      expect.soft(result.properties.attributes).toEqual({
        type: ["object", "null"],
        additionalProperties: { type: ["string", "number", "boolean"] },
      });
      for (const item of body.data) {
        expect(item.attributes).toEqual(attributes);
        expect(item.filename).toBe("catalog.txt");
        expect(result.properties.file_id.type).toBe(typeof item.file_id);
        expect(result.properties.filename.type).toBe(typeof item.filename);
        expect(result.properties.score.type).toBe(typeof item.score);
        expect(Array.isArray(item.content)).toBe(true);
        expect(result.properties.content.type).toBe("array");
        expect(item.content.length).toBeGreaterThan(0);
        for (const chunk of item.content) {
          expect(chunk).not.toBeNull();
          expect(Array.isArray(chunk)).toBe(false);
          expect(result.properties.content.items.type).toBe(typeof chunk);
          expect(chunk).toMatchObject({ type: "text", text: expect.any(String) });
          expect(chunk.text.length).toBeGreaterThan(0);
        }
      }
    },
  );

  it.each([
    { resource: "store", object: "vector_store.deleted" },
    { resource: "file", object: "vector_store.file.deleted" },
  ])("describes the real vector $resource deletion envelope", async ({ resource, object }) => {
    const doc = await (await fetch(`${mock.url}/__aimock/openapi.json`)).json();
    const storeResponse = await fetch(`${mock.url}/v1/vector_stores`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "catalog deletion" }),
    });
    expect(storeResponse.status).toBe(200);
    const store = await storeResponse.json();
    const upload = new FormData();
    upload.set("purpose", "assistants");
    upload.set("file", new Blob(["catalog deletion proof"]), "catalog.txt");
    const uploadResponse = await fetch(`${mock.url}/v1/files`, { method: "POST", body: upload });
    expect(uploadResponse.status).toBe(200);
    const file = await uploadResponse.json();
    const storePath = `/v1/vector_stores/${store.id}`;
    const attachment = await fetch(`${mock.url}${storePath}/files`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: file.id }),
    });
    expect(attachment.status).toBe(200);

    const suffix = resource === "file" ? `/files/${file.id}` : "";
    const response = await fetch(`${mock.url}${storePath}${suffix}`, { method: "DELETE" });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ id: resource === "file" ? file.id : store.id, deleted: true, object });
    const template =
      "/v1/vector_stores/{vector_store_id}" + (resource === "file" ? "/files/{file_id}" : "");
    const ref = doc.paths[template].delete.responses["200"].content["application/json"].schema;
    const schema = doc.components.schemas[ref.$ref.split("/").at(-1)];
    console.log(JSON.stringify({ template, status: response.status, body, schema }));
    for (const key of schema.required) expect.soft(body).toHaveProperty(key);
    expect.soft(schema.required).toEqual(expect.arrayContaining(["id", "deleted", "object"]));
    expect.soft(schema.properties.id).toEqual({ type: "string" });
    expect.soft(schema.properties.deleted).toEqual({ type: "boolean", enum: [true] });
    expect.soft(schema.properties.object).toEqual({ type: "string", enum: [body.object] });

    if (resource === "file") {
      expect((await fetch(`${mock.url}${storePath}`, { method: "DELETE" })).status).toBe(200);
    }
    expect((await fetch(`${mock.url}/v1/files/${file.id}`, { method: "DELETE" })).status).toBe(200);
  });

  it.each([
    {
      path: "/__aimock/journal",
      method: "get",
      query: "?limit=-1",
      body: undefined,
      blankScope: false,
    },
    {
      path: "/__aimock/fixtures",
      method: "get",
      query: "?include=invalid",
      body: undefined,
      blankScope: false,
    },
    {
      path: "/__aimock/fixtures",
      method: "post",
      query: "",
      body: { fixtures: [{ match: { userMessage: "x" }, response: {} }] },
      blankScope: false,
    },
    {
      path: "/__aimock/chaos",
      method: "post",
      query: "",
      body: { dropRate: 2 },
      blankScope: false,
    },
    { path: "/__aimock/chaos", method: "get", query: "", body: undefined, blankScope: true },
    { path: "/__aimock/chaos", method: "delete", query: "", body: undefined, blankScope: true },
    { path: "/__aimock/error", method: "post", query: "", body: { status: 99 }, blankScope: false },
  ])(
    "describes real control validation errors for $method $path",
    async ({ path, method, query, body: input, blankScope }) => {
      const doc = await (await fetch(`${mock.url}/__aimock/openapi.json`)).json();
      const response = await fetch(`${mock.url}${path}${query}`, {
        method: method.toUpperCase(),
        headers: { "Content-Type": "application/json", ...(blankScope ? { "X-Test-Id": "" } : {}) },
        body: input === undefined ? undefined : JSON.stringify(input),
      });
      const body = await response.json();
      expect(response.status).toBe(400);
      expect(typeof body.error).toBe("string");
      expect(body.error.length).toBeGreaterThan(0);
      const ref = doc.paths[path][method].responses["400"].content["application/json"].schema;
      const schema = doc.components.schemas[ref.$ref.split("/").at(-1)];
      console.log(JSON.stringify({ method, path, status: response.status, body, schema }));
      expect.soft(schema.properties.error.type).toBe(typeof body.error);
      expect.soft(schema.required).toContain("error");
      if (path === "/__aimock/fixtures" && method === "post") {
        expect(body.error).toBe("Validation failed");
        expect(body.details.length).toBeGreaterThan(0);
        for (const detail of body.details) expect(typeof detail).toBe("object");
        expect
          .soft(schema.properties.details)
          .toMatchObject({ type: "array", items: { type: "object" } });
      }
    },
  );

  it("describes null assistant content in real tool-call history", async () => {
    mock.addFixture({
      match: { userMessage: "catalog tool history" },
      response: { content: "The weather is sunny." },
    });
    const request: ChatCompletionRequest = {
      model: "test",
      messages: [
        { role: "user", content: [{ type: "text", text: "catalog tool history" }] },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_weather",
              type: "function",
              function: { name: "get_weather", arguments: "{}" },
            },
          ],
        },
        { role: "tool", content: "sunny", tool_call_id: "call_weather" },
      ],
      stream: false,
    };
    const doc = await (await fetch(`${mock.url}/__aimock/openapi.json`)).json();
    const response = await fetch(`${mock.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    expect(response.status).toBe(200);
    const body: ChatCompletion = await response.json();
    expect(body.choices[0].message.content).toBe("The weather is sunny.");

    const ref =
      doc.paths["/v1/chat/completions"].post.requestBody.content["application/json"].schema;
    expect(ref).toEqual({ $ref: "#/components/schemas/ChatCompletionRequest" });
    const messageSchema = doc.components.schemas.ChatCompletionRequest.properties.messages.items;
    expect(messageSchema.required).toEqual(["role", "content"]);
    const alternatives: StreamCatalogSchema[] = messageSchema.properties.content.oneOf;
    console.log(JSON.stringify({ request, status: response.status, body, alternatives }));
    expect(alternatives).toContainEqual({ type: "null" });
    expect(alternatives).toContainEqual({ type: "string" });
    expect(alternatives.map((branch) => branch.type).sort()).toEqual(["array", "null", "string"]);
    expect(alternatives.find((branch) => branch.type === "array")).toMatchObject({
      items: {
        type: "object",
        required: ["type"],
        properties: {
          type: { type: "string", enum: ["text", "image_url", "input_audio", "file"] },
          text: { type: "string" },
        },
      },
    });
  });

  it("preserves real provider object errors and their catalog schema", async () => {
    const doc = await (await fetch(`${mock.url}/__aimock/openapi.json`)).json();
    const response = await fetch(`${mock.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "test" }),
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(typeof body.error).toBe("object");
    expect(typeof body.error.message).toBe("string");
    const operation = doc.paths["/v1/chat/completions"].post;
    for (const status of ["400", "404"]) {
      expect(operation.responses[status].content["application/json"].schema).toEqual({
        $ref: "#/components/schemas/ErrorResponse",
      });
    }
    expect(doc.components.schemas.ErrorResponse.properties.error.type).toBe("object");
  });

  it.each([
    { path: "/ready", status: "ready", schemaName: "ReadyResponse" },
    { path: "/health", status: "ok", schemaName: "HealthResponse" },
    { path: "/__aimock/health", status: "ok", schemaName: "HealthResponse" },
  ])("describes the real $path status response", async ({ path, status, schemaName }) => {
    const doc = await (await fetch(`${mock.url}/__aimock/openapi.json`)).json();
    const response = await fetch(`${mock.url}${path}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ status });

    const ref = doc.paths[path].get.responses["200"].content["application/json"].schema;
    const schema = doc.components.schemas[ref.$ref.split("/").at(-1)];
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["status"]);
    expect(schema.properties.status.type).toBe(typeof body.status);
    expect(schema.properties.status.enum).toEqual([body.status]);
    expect(ref).toEqual({ $ref: `#/components/schemas/${schemaName}` });
    expect(schema.properties).toEqual({
      status: { type: "string", enum: [status] },
      ...(status === "ok" ? { services: { type: "object" } } : {}),
    });
  });

  it("describes the real voice deletion status without changing voice schemas", async () => {
    const doc = await (await fetch(`${mock.url}/__aimock/openapi.json`)).json();
    const response = await fetch(`${mock.url}/v1/voices/catalog-delete-proof`, {
      method: "DELETE",
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ status: "ok" });

    const voiceOperations = doc.paths["/v1/voices/{voice_id}"];
    const ref = voiceOperations.delete.responses["200"].content["application/json"].schema;
    const schema = doc.components.schemas[ref.$ref.split("/").at(-1)];
    for (const key of schema.required) expect(body).toHaveProperty(key);
    expect(schema).toEqual({
      type: "object",
      required: ["status"],
      properties: { status: { type: "string", enum: ["ok"] } },
    });
    expect(voiceOperations.get.responses["200"].content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/ElevenLabsVoice",
    });
    expect(
      doc.paths["/v1/text-to-voice"].post.responses["200"].content["application/json"].schema,
    ).toEqual({ $ref: "#/components/schemas/VoiceCreateResponse" });
    for (const name of ["ElevenLabsVoice", "VoiceCreateResponse"]) {
      expect(doc.components.schemas[name].required).toContain("voice_id");
      expect(doc.components.schemas[name].properties.voice_id).toEqual({ type: "string" });
    }
  });

  const ollamaEmbeddingInputs = [
    { label: "legacy prompt", fields: { prompt: "hello" } },
    { label: "text input", fields: { input: "hello" } },
    { label: "text array", fields: { input: ["hello", "world"] } },
    { label: "numeric array", fields: { input: [1, 2] } },
    { label: "numeric matrix", fields: { input: [[1, 2], [3]] } },
    { label: "both fields", fields: { prompt: "hello", input: "world" } },
    { label: "null prompt fallback", fields: { prompt: null, input: "hello" } },
    { label: "null input fallback", fields: { prompt: "hello", input: null } },
  ];

  it.each(
    ["/api/embeddings", "/api/embed"].flatMap((path) =>
      ollamaEmbeddingInputs.map((input) => ({ path, ...input })),
    ),
  )("describes real Ollama embeddings for $path with $label", async ({ path, fields }) => {
    const doc = await (await fetch(`${mock.url}/__aimock/openapi.json`)).json();
    const response = await fetch(`${mock.url}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "nomic-embed-text", ...fields }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(["embedding", "model"]);
    expect(body.model).toBe("nomic-embed-text");
    expect(Array.isArray(body.embedding)).toBe(true);
    expect(body.embedding.length).toBeGreaterThan(0);
    for (const value of body.embedding) expect(typeof value).toBe("number");

    const operation = doc.paths[path].post;
    expect(operation.requestBody.content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/OllamaEmbedRequest",
    });
    expect(operation.responses["200"].content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/OllamaEmbedResponse",
    });
    expect.soft(doc.components.schemas.OllamaEmbedRequest).toEqual({
      type: "object",
      required: ["model"],
      anyOf: [
        { required: ["prompt"], properties: { prompt: { not: { type: "null" } } } },
        { required: ["input"], properties: { input: { not: { type: "null" } } } },
      ],
      properties: {
        model: { type: "string" },
        prompt: { type: ["string", "null"] },
        input: {
          anyOf: [
            { type: "null" },
            { type: "string" },
            { type: "array", items: { type: "string" } },
            { type: "array", items: { type: "number" } },
            { type: "array", items: { type: "array", items: { type: "number" } } },
          ],
        },
      },
    });
    expect.soft(doc.components.schemas.OllamaEmbedResponse).toEqual({
      type: "object",
      required: ["model", "embedding"],
      properties: {
        model: { type: "string" },
        embedding: { type: "array", items: { type: "number" } },
      },
    });
  });

  it.each(["/api/embeddings", "/api/embed"])(
    "does not advertise absent or all-null Ollama input for %s",
    async (path) => {
      const doc = await (await fetch(`${mock.url}/__aimock/openapi.json`)).json();
      // Nullable properties alone must not make either null a valid alternative.
      expect(doc.components.schemas.OllamaEmbedRequest.anyOf).toEqual([
        { required: ["prompt"], properties: { prompt: { not: { type: "null" } } } },
        { required: ["input"], properties: { input: { not: { type: "null" } } } },
      ]);
      for (const fields of [{}, { prompt: null }, { input: null }, { prompt: null, input: null }]) {
        const response = await fetch(`${mock.url}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "test", ...fields }),
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          error: { message: "Invalid request: prompt or input field is required" },
        });
      }
    },
  );

  it.each(["completed", "failed"] as const)(
    "describes real Grok video submit and %s polling responses",
    async (status) => {
      mock.addFixture({
        match: { userMessage: "catalog Grok clip", endpoint: "video" },
        response: {
          video: {
            id: "video_catalog_grok",
            status,
            url: "https://example.com/v.mp4",
            duration: 6,
            cost: 0.05,
            error: "generation failed",
          },
        },
      });
      const doc = await (await fetch(`${mock.url}/__aimock/openapi.json`)).json();
      const submit = await fetch(`${mock.url}/v1/videos/generations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "catalog Grok clip" }),
      });
      expect(submit.status).toBe(200);
      const created = await submit.json();
      expect(created).toEqual({ request_id: expect.any(String) });
      const poll = await fetch(`${mock.url}/v1/videos/${created.request_id}`);
      expect(poll.status).toBe(200);
      const body = await poll.json();
      expect(body).toMatchObject({
        request_id: created.request_id,
        status: status === "completed" ? "done" : "failed",
        progress: expect.any(Number),
      });
      if (status === "completed") {
        expect(body.video).toEqual({ url: "https://example.com/v.mp4", duration: 6 });
        expect(body.usage).toEqual({ cost_in_usd_ticks: 500_000_000 });
      } else {
        expect(body).toMatchObject({ code: "generation_failed", error: "generation failed" });
      }
      expect(
        doc.paths["/v1/videos/generations"].post.responses["200"].content["application/json"]
          .schema,
      ).toEqual({ $ref: "#/components/schemas/GrokVideoSubmitResponse" });
      expect(doc.components.schemas.GrokVideoSubmitResponse).toEqual({
        type: "object",
        required: ["request_id"],
        properties: { request_id: { type: "string" } },
      });
      expect(
        doc.paths["/v1/videos/{id}"].get.responses["200"].content["application/json"].schema,
      ).toEqual({ $ref: "#/components/schemas/VideoStatusResponse" });
      expect(doc.components.schemas.VideoStatusResponse).toEqual({
        oneOf: [
          { $ref: "#/components/schemas/VideoJob" },
          { $ref: "#/components/schemas/GrokVideoJob" },
        ],
      });
      const grok = doc.components.schemas.GrokVideoJob;
      expect(grok.required).toEqual(["request_id", "status"]);
      expect(grok.properties).toEqual({
        request_id: { type: "string" },
        status: { type: "string", enum: ["pending", "in_progress", "done", "failed", "expired"] },
        progress: { type: "number" },
        video: {
          type: "object",
          properties: { url: { type: "string" }, duration: { type: "number" } },
        },
        usage: {
          type: "object",
          properties: { cost_in_usd_ticks: { type: "number" } },
        },
        code: { type: "string" },
        error: { type: "string" },
      });
      expect(grok.properties.status.enum).toContain(body.status);
    },
  );

  it("preserves Sora video submit and shared polling contracts", async () => {
    mock.addFixture({
      match: { userMessage: "catalog Sora clip", endpoint: "video" },
      response: { video: { id: "video_catalog_sora", status: "completed" } },
    });
    const doc = await (await fetch(`${mock.url}/__aimock/openapi.json`)).json();
    const submit = await fetch(`${mock.url}/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "catalog Sora clip" }),
    });
    expect(submit.status).toBe(200);
    const created = await submit.json();
    const poll = await fetch(`${mock.url}/v1/videos/${created.id}`);
    expect(poll.status).toBe(200);
    const body = await poll.json();
    expect(created).toMatchObject({ id: "video_catalog_sora", status: "completed" });
    expect(body).toMatchObject({ id: created.id, status: created.status });
    expect(
      doc.paths["/v1/videos"].post.responses["200"].content["application/json"].schema,
    ).toEqual({ $ref: "#/components/schemas/VideoJob" });
    expect(doc.components.schemas.VideoStatusResponse.oneOf).toContainEqual({
      $ref: "#/components/schemas/VideoJob",
    });
    expect(doc.components.schemas.VideoJob.required).toEqual(["id", "status"]);
    expect(doc.components.schemas.VideoJob.properties.id).toEqual({ type: "string" });
    expect(doc.components.schemas.VideoJob.properties.status.enum).toContain(body.status);
  });

  it("derives the catalog from the router registry (no hand-maintained copy)", () => {
    expect(CATALOG_ROUTES.length).toBe(ROUTE_DEFINITIONS.length);
    const registryKeys = new Set(ROUTE_DEFINITIONS.map((r) => `${r.method} ${r.path}`));
    for (const r of CATALOG_ROUTES) {
      expect(registryKeys.has(`${r.method} ${r.path}`)).toBe(true);
    }
  });

  it("covers the previously-missing surfaces", () => {
    const paths = new Set(CATALOG_ROUTES.map((r) => `${r.method} ${r.path}`));
    for (const required of [
      // Core OpenAI-shaped routes carry real schemas (asserted below).
      "POST /v1/chat/completions",
      "POST /v1/responses",
      "POST /v1/messages",
      "POST /v1/embeddings",
      "GET /v1/models",
      // Previously missing (review): ollama current path, legacy journal,
      // azure, gemini predict/embed/interactions, vertex, bedrock x4,
      // grok/veo/openrouter/byteplus video, openrouter discovery, elevenlabs,
      // fal families, control reset aliases.
      "POST /api/embed",
      "GET /v1/_requests",
      "DELETE /v1/_requests",
      "POST /openai/deployments/{deploymentId}/chat/completions",
      "POST /openai/deployments/{deploymentId}/embeddings",
      "POST /v1beta/models/{model}:predict",
      "POST /v1beta/models/{model}:embedContent",
      "POST /v1beta/interactions",
      "POST /v1beta/models/{model}:predictLongRunning",
      "GET /v1beta/operations/{name}",
      "POST /v1/projects/{project}/locations/{location}/publishers/google/models/{model}:generateContent",
      "POST /model/{modelId}/invoke",
      "POST /model/{modelId}/invoke-with-response-stream",
      "POST /model/{modelId}/converse",
      "POST /model/{modelId}/converse-stream",
      "POST /v1/videos/generations",
      "GET /v1/videos/{id}",
      "POST /api/v1/videos",
      "GET /api/v1/videos/models",
      "GET /api/v1/videos/{jobId}",
      "GET /api/v1/videos/{jobId}/content",
      "GET /api/v1/models",
      "GET /api/v1/key",
      "GET /api/v1/credits",
      "POST /v1/sound-generation",
      "POST /v1/text-to-speech/{voice_id}",
      "POST /fal/queue/submit/{model}",
      "GET /fal/queue/requests/{requestId}",
      "POST /fal/run/{model}",
      // New on main after the PR opened: Files API, fine-tuning jobs,
      // ElevenLabs Voice Design slots, Batches API.
      "GET /v1/files",
      "POST /v1/files",
      "GET /v1/files/{file_id}",
      "DELETE /v1/files/{file_id}",
      "GET /v1/files/{file_id}/content",
      "POST /v1/fine_tuning/jobs",
      "GET /v1/fine_tuning/jobs",
      "GET /v1/fine_tuning/jobs/{job_id}",
      "POST /v1/fine_tuning/jobs/{job_id}/cancel",
      "GET /v1/fine_tuning/jobs/{job_id}/events",
      "POST /v1/text-to-voice/design",
      "POST /v1/text-to-voice",
      "GET /v1/voices/{voice_id}",
      "DELETE /v1/voices/{voice_id}",
      "POST /v1/batches",
      "GET /v1/batches",
      "GET /v1/batches/{batch_id}",
      "POST /v1/batches/{batch_id}/cancel",
      "POST /__aimock/reset/journal",
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

  it("emits real request/response schemas for OpenAI-shaped routes", async () => {
    const res = await fetch(`${mock.url}/__aimock/openapi.json`);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      openapi: string;
      components: { schemas: Record<string, unknown> };
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    expect(doc.openapi).toBe("3.1.0");
    const chat = doc.paths["/v1/chat/completions"]?.post as Record<string, unknown>;
    expect(chat).toBeDefined();
    const requestBody = chat.requestBody as {
      content: { "application/json": { schema: { $ref: string } } };
    };
    expect(requestBody.content["application/json"].schema.$ref).toBe(
      "#/components/schemas/ChatCompletionRequest",
    );
    const ok = (chat.responses as Record<string, { content?: Record<string, unknown> }>)["200"];
    expect(ok.content?.["application/json"]).toBeDefined();
    expect(doc.components.schemas.ChatCompletionRequest).toBeDefined();
    expect(doc.components.schemas.ChatCompletionResponse).toBeDefined();
    expect(doc.components.schemas.EmbeddingRequest).toBeDefined();
  });

  it.each([
    { label: "string", input: "catalog interactions", stream: false },
    {
      label: "turns",
      input: [{ role: "user", content: [{ type: "text", text: "catalog interactions" }] }],
      stream: false,
    },
    {
      label: "steps",
      input: [{ type: "user_input", content: [{ type: "text", text: "catalog interactions" }] }],
      stream: false,
    },
    { label: "explicit stream", input: "catalog interactions", stream: true },
    { label: "default stream", input: "catalog interactions", stream: undefined },
  ])("describes live Interactions $label", async ({ input, stream }) => {
    mock.addFixture({
      match: { userMessage: "catalog interactions" },
      response: { content: "hello interaction" },
      chunkSize: 3,
    });
    const doc = await (await fetch(`${mock.url}/__aimock/openapi.json`)).json();
    const request = {
      model: "gemini-test",
      input,
      generation_config: { temperature: 0, max_output_tokens: 20 },
      stream,
    };
    const response = await fetch(`${mock.url}/v1beta/interactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    const wire = await response.text();
    expect(response.status).toBe(200);
    const operation = doc.paths["/v1beta/interactions"].post;
    const requestRef = operation.requestBody.content["application/json"].schema.$ref;
    const requestSchema = doc.components.schemas[requestRef.split("/").at(-1)];
    const content = operation.responses["200"].content;
    console.log(JSON.stringify({ request, wire, requestSchema, content }));
    expect.soft(requestSchema.properties.input).toEqual({
      description: "Text, turns, steps, or content blocks normalized for fixture matching.",
      oneOf: [{ type: "string" }, { type: "array", items: { type: "object" } }],
    });
    expect.soft(requestSchema.properties.generation_config).toMatchObject({
      type: "object",
      properties: { temperature: { type: "number" }, max_output_tokens: { type: "integer" } },
    });
    expect.soft(requestSchema.properties.stream).toMatchObject({ type: "boolean", default: true });
    expect.soft(requestSchema.properties).not.toHaveProperty("contents");
    expect.soft(requestSchema.properties).not.toHaveProperty("generationConfig");
    const schema = doc.components.schemas.InteractionsResponse;
    expect
      .soft(content["application/json"].schema.$ref)
      .toBe("#/components/schemas/InteractionsResponse");
    expect.soft(schema.properties).not.toHaveProperty("candidates");
    expect.soft(schema.properties).not.toHaveProperty("usageMetadata");
    if (stream === false) {
      expect(response.headers.get("content-type")).toContain("application/json");
      const body = JSON.parse(wire);
      expect(body.output_text).toBe("hello interaction");
      expect(body.steps).toEqual([
        { type: "model_output", content: [{ type: "text", text: "hello interaction" }] },
      ]);
      expect(body.usage).toEqual({
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_tokens: 0,
      });
      expect.soft(schema.properties.output_text?.type).toBe(typeof body.output_text);
      expect
        .soft(schema.properties.steps)
        .toMatchObject({ type: "array", items: { type: "object" } });
      expect.soft(schema.properties.usage).toMatchObject({ type: "object" });
    } else {
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const frames = sseDataFrames(wire);
      expect(frames).not.toContain("[DONE]");
      const events: {
        event_type: string;
        event_id: string;
        delta?: { type: string; text: string };
        interaction?: { status: string };
      }[] = frames.map((frame) => JSON.parse(frame));
      expect(events[0].event_type).toBe("interaction.created");
      expect(events.at(-1)?.event_type).toBe("interaction.completed");
      expect(events.at(-1)?.interaction?.status).toBe("completed");
      expect(events.map((event) => event.delta?.text ?? "").join("")).toBe("hello interaction");
      expect(content["text/event-stream"]).toBeDefined();
      const streamSchema =
        doc.components.schemas[content["text/event-stream"].schema.$ref.split("/").at(-1)];
      expect(streamSchema.type).toBe("string");
      expect(streamSchema.description).toContain("data:");
      expect(streamSchema.description).toContain("blank line");
      expect(streamSchema.description).toContain("no event: prefix or [DONE]");
      const eventSchema =
        doc.components.schemas[streamSchema["x-sse-data-schema"].$ref.split("/").at(-1)];
      expect(eventSchema.required).toEqual(["event_type", "event_id"]);
      for (const event of events) {
        expect(eventSchema.properties.event_type.enum).toContain(event.event_type);
        expect(typeof event.event_id).toBe(eventSchema.properties.event_id.type);
      }
      expect(eventSchema.properties.delta.type).toBe("object");
      expect(eventSchema.properties.interaction.type).toBe("object");
    }
  });

  it.each([false, true])("describes tool-only Interactions with stream=%s", async (stream) => {
    mock.addFixture({
      match: { userMessage: "catalog interaction tool" },
      response: {
        toolCalls: [{ id: "call_catalog", name: "weather", arguments: '{"city":"Paris"}' }],
      },
    });
    const doc = await (await fetch(`${mock.url}/__aimock/openapi.json`)).json();
    const response = await fetch(`${mock.url}/v1beta/interactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gemini-test", input: "catalog interaction tool", stream }),
    });
    expect(response.status).toBe(200);
    const wire = await response.text();
    console.log(JSON.stringify({ stream, wire }));
    if (!stream) {
      const body = JSON.parse(wire);
      const schema = doc.components.schemas.InteractionsResponse;
      expect(body.status).toBe("requires_action");
      expect(body).not.toHaveProperty("output_text");
      expect(schema.required).not.toContain("output_text");
      for (const field of schema.required) expect(body).toHaveProperty(field);
      expect(schema.properties.status.enum).toContain(body.status);
      expect(body.steps).toEqual([
        {
          type: "function_call",
          id: "call_catalog",
          name: "weather",
          arguments: { city: "Paris" },
        },
      ]);
      expect(schema.properties.steps.items.properties.type.enum).toContain(body.steps[0].type);
      for (const [field, value] of Object.entries(body.usage)) {
        expect(schema.properties.usage.properties[field].type).toBe(typeof value);
      }
    } else {
      const events: {
        event_type: string;
        delta?: { type: string; arguments: string };
        interaction?: { status: string };
      }[] = sseDataFrames(wire).map((frame) => JSON.parse(frame));
      const delta = events.find((event) => event.event_type === "step.delta")?.delta;
      expect(delta).toEqual({ type: "arguments_delta", arguments: '{"city":"Paris"}' });
      expect(events.at(-1)?.interaction?.status).toBe("requires_action");
      const schema = doc.components.schemas.InteractionsSSEEvent;
      expect(schema.properties.delta.properties.type.enum).toContain(delta?.type);
      expect(schema.properties.delta.properties.arguments.type).toBe(typeof delta?.arguments);
      expect(schema.properties.interaction.properties.status.enum).toContain("requires_action");
    }
  });

  const streamRoutes = [
    { family: "chat", path: "/v1/chat/completions", actual: "/v1/chat/completions" },
    {
      family: "chat",
      path: "/openai/deployments/{deploymentId}/chat/completions",
      actual: "/openai/deployments/test/chat/completions",
    },
    {
      family: "gemini",
      path: "/v1beta/models/{model}:streamGenerateContent",
      actual: "/v1beta/models/gemini-test:streamGenerateContent",
    },
    {
      family: "gemini",
      path: "/v1/projects/{project}/locations/{location}/publishers/google/models/{model}:streamGenerateContent",
      actual:
        "/v1/projects/test/locations/us/publishers/google/models/gemini-test:streamGenerateContent",
    },
  ] as const;

  it.each(streamRoutes)(
    "advertises live SSE framing and chunks for $path",
    async ({ family, path, actual }) => {
      mock.addFixture({
        match: { userMessage: "catalog stream" },
        response: { content: "hello stream" },
        chunkSize: 3,
      });
      const doc: StreamCatalog = await (await fetch(`${mock.url}/__aimock/openapi.json`)).json();
      const response = await fetch(`${mock.url}${actual}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          family === "chat"
            ? {
                model: "test",
                messages: [{ role: "user", content: "catalog stream" }],
                stream: true,
              }
            : { contents: [{ role: "user", parts: [{ text: "catalog stream" }] }] },
        ),
      });
      const wire = await response.text();
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const frames = sseDataFrames(wire);
      const content = doc.paths[path].post.responses["200"].content;
      console.log(
        JSON.stringify({
          path,
          observedMedia: response.headers.get("content-type"),
          advertisedMedia: Object.keys(content),
          wire,
        }),
      );
      expect(content["text/event-stream"]).toBeDefined();
      const schema =
        doc.components.schemas[content["text/event-stream"].schema.$ref.split("/").at(-1)!];
      expect(schema.type).toBe("string");
      expect(schema.description).toContain("data:");
      expect(schema.description).toContain("blank line");
      const chunkRef = schema["x-sse-data-schema"]?.$ref;
      expect(chunkRef).toBeDefined();
      const chunkSchema = doc.components.schemas[chunkRef!.split("/").at(-1)!];
      expect(chunkSchema.type).toBe("object");
      if (family === "chat") {
        expect(content["application/json"].schema.$ref).toBe(
          "#/components/schemas/ChatCompletionResponse",
        );
        expect(schema.description).toContain("[DONE]");
        expect(frames.pop()).toBe("[DONE]");
        const chunks: SSEChunk[] = frames.map((frame) => JSON.parse(frame));
        expect(chunks.length).toBeGreaterThan(1);
        for (const chunk of chunks) {
          expect(chunk.object).toBe("chat.completion.chunk");
          expect(chunk.choices[0].delta).toBeDefined();
          expect(chunk.choices[0]).not.toHaveProperty("message");
        }
        expect(chunks.map((chunk) => chunk.choices[0].delta.content ?? "").join("")).toBe(
          "hello stream",
        );
        expect(chunkSchema.properties?.object.enum).toEqual(["chat.completion.chunk"]);
        expect(chunkSchema.properties?.choices.items?.required).toContain("delta");
        expect(chunkSchema.properties?.choices.items?.required).not.toContain("message");
      } else {
        expect(content["application/json"]).toBeUndefined();
        expect(frames).not.toContain("[DONE]");
        expect(chunkRef).toBe("#/components/schemas/GeminiGenerateResponse");
        const chunks: {
          candidates: { content: { parts: { text: string }[] }; finishReason?: string }[];
        }[] = frames.map((frame) => JSON.parse(frame));
        expect(chunks.map((chunk) => chunk.candidates[0].content.parts[0].text).join("")).toBe(
          "hello stream",
        );
        expect(chunks.at(-1)?.candidates[0].finishReason).toBe("STOP");
        expect(
          chunkSchema.properties?.candidates.items?.properties?.content.properties?.parts.type,
        ).toBe("array");
      }
    },
  );

  it.each(streamRoutes)(
    "preserves nonstreaming JSON for $path",
    async ({ family, path, actual }) => {
      mock.addFixture({
        match: { userMessage: "catalog json" },
        response: { content: "hello json" },
      });
      const doc: StreamCatalog = await (await fetch(`${mock.url}/__aimock/openapi.json`)).json();
      const jsonPath = path.replace("streamGenerateContent", "generateContent");
      const response = await fetch(
        `${mock.url}${actual.replace("streamGenerateContent", "generateContent")}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            family === "chat"
              ? {
                  model: "test",
                  messages: [{ role: "user", content: "catalog json" }],
                  stream: false,
                }
              : { contents: [{ role: "user", parts: [{ text: "catalog json" }] }] },
          ),
        },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(
        doc.paths[jsonPath].post.responses["200"].content["application/json"].schema.$ref,
      ).toBe(
        `#/components/schemas/${family === "chat" ? "ChatCompletionResponse" : "GeminiGenerateResponse"}`,
      );
      if (family === "chat") {
        const body: ChatCompletion = await response.json();
        expect(body.object).toBe("chat.completion");
        expect(body.choices[0].message.content).toBe("hello json");
      } else {
        const body = await response.json();
        expect(body.candidates[0].content.parts[0].text).toBe("hello json");
      }
    },
  );

  it("serves /__aimock/openapi.json and /__aimock/routes consistently", async () => {
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
    // Served catalog matches the derived registry (not a second copy).
    expect(body.count).toBe(ROUTE_DEFINITIONS.length);
    expect(body.routes.length).toBe(ROUTE_DEFINITIONS.length);
    const servedKeys = new Set(body.routes.map((r) => `${r.method} ${r.path}`));
    for (const r of ROUTE_DEFINITIONS) {
      expect(servedKeys.has(`${r.method} ${r.path}`)).toBe(true);
    }
    // Every openapi path is backed by a routes entry.
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const method of Object.keys(item)) {
        expect(servedKeys.has(`${method.toUpperCase()} ${path}`)).toBe(true);
      }
    }
  });

  it("every catalog entry is mounted on the live router (no drift)", async () => {
    for (const r of ROUTE_DEFINITIONS) {
      const probePath = r.examplePath ?? r.path;
      const url = `${mock.url}${probePath}`;
      const res =
        r.method === "GET" || r.method === "DELETE"
          ? await fetch(url, { method: r.method })
          : await fetch(url, {
              method: r.method,
              headers: { "Content-Type": "application/json" },
              body: "{}",
            });
      // Drain the body so the socket can be reused.
      const text = await res.text();
      // POST /v1/images/variations was removed upstream (dall-e-2,
      // 2026-05-12) and aimock replays the removal: a 404 with a zero-byte
      // body and no JSON envelope (see images.ts + the deprecation policy).
      // The route is still registered and journaled — assert the replay
      // itself instead of the generic routed check below.
      if (r.method === "POST" && r.path === "/v1/images/variations") {
        expect(res.status).toBe(404);
        expect(text).toBe("");
        continue;
      }
      // A routed-but-empty result (e.g. unknown video job id) still proves the
      // route is mounted; only the dispatcher's generic miss means drift.
      let message: string | undefined;
      try {
        const parsed = JSON.parse(text) as { error?: { message?: unknown } };
        if (typeof parsed?.error?.message === "string") message = parsed.error.message;
      } catch {
        // Non-JSON (204/200-text) is always a routed response.
      }
      const genericMiss =
        res.status === 404 &&
        (message === "Not found" ||
          (typeof message === "string" && message.startsWith("Unknown control endpoint")));
      expect(
        genericMiss,
        `${r.method} ${probePath} hit the generic 404 — catalog drifted from router`,
      ).toBe(false);
    }
  }, 60000);

  it("every dispatch pattern has a catalog entry (router → catalog, no drift)", () => {
    // Independently enumerate server.ts method guards and semantic regex
    // alternatives. One matching example cannot prove that a sibling operation
    // (e.g. Gemini streaming, or DELETE on a shared path) is cataloged.
    // Keep this table current when adding an operation to an existing binding;
    // the binding-set assertion also catches newly exported dispatch patterns.
    // Exclude WebSocket-only upgrades, CONTROL_PREFIX (not a route), and
    // FAL_ROUTE_RE (a header-gated dynamic upstream mirror).
    const excluded = new Set([
      "REALTIME_PATH",
      "GEMINI_LIVE_PATH",
      "LIVE_PATH",
      "CONTROL_PREFIX",
      "FAL_ROUTE_RE",
    ]);
    const expectedOperations: { [binding: string]: readonly string[] } = {
      AZURE_DEPLOYMENT_RE: [
        "POST /openai/deployments/{deploymentId}/chat/completions",
        "POST /openai/deployments/{deploymentId}/embeddings",
      ],
      BATCHES_CANCEL_RE: ["POST /v1/batches/{batch_id}/cancel"],
      BATCHES_ID_RE: ["GET /v1/batches/{batch_id}"],
      BATCHES_PATH: ["GET /v1/batches", "POST /v1/batches"],
      BEDROCK_CONVERSE_RE: ["POST /model/{modelId}/converse"],
      BEDROCK_CONVERSE_STREAM_RE: ["POST /model/{modelId}/converse-stream"],
      BEDROCK_INVOKE_RE: ["POST /model/{modelId}/invoke"],
      BEDROCK_STREAM_RE: ["POST /model/{modelId}/invoke-with-response-stream"],
      BYTEPLUS_VIDEO_STATUS_RE: [
        "GET /contents/generations/tasks/{id}",
        "GET /api/v3/contents/generations/tasks/{id}",
      ],
      BYTEPLUS_VIDEO_SUBMIT_RE: [
        "POST /contents/generations/tasks",
        "POST /api/v3/contents/generations/tasks",
      ],
      COHERE_CHAT_PATH: ["POST /v2/chat"],
      COHERE_EMBED_PATH: ["POST /v2/embed"],
      COMPLETIONS_PATH: ["POST /v1/chat/completions"],
      ELEVENLABS_MUSIC_RE: ["POST /v1/music", "POST /v1/music/{subtype}"],
      ELEVENLABS_SOUND_GENERATION_PATH: ["POST /v1/sound-generation"],
      ELEVENLABS_TTS_RE: ["POST /v1/text-to-speech/{voice_id}"],
      ELEVENLABS_VOICE_CREATE_PATH: ["POST /v1/text-to-voice"],
      ELEVENLABS_VOICE_DESIGN_PATH: ["POST /v1/text-to-voice/design"],
      ELEVENLABS_VOICE_RE: ["GET /v1/voices/{voice_id}", "DELETE /v1/voices/{voice_id}"],
      EMBEDDINGS_PATH: ["POST /v1/embeddings"],
      FAL_QUEUE_REQUESTS_RE: [
        "GET /fal/queue/requests/{requestId}",
        "POST /fal/queue/requests/{requestId}",
        "PUT /fal/queue/requests/{requestId}",
      ],
      FAL_QUEUE_SUBMIT_RE: ["POST /fal/queue/submit/{model}"],
      FAL_RUN_RE: ["POST /fal/run/{model}"],
      FILES_CONTENT_RE: ["GET /v1/files/{file_id}/content"],
      FILES_ID_RE: ["GET /v1/files/{file_id}", "DELETE /v1/files/{file_id}"],
      FILES_PATH: ["GET /v1/files", "POST /v1/files"],
      FINE_TUNING_CANCEL_RE: ["POST /v1/fine_tuning/jobs/{job_id}/cancel"],
      FINE_TUNING_EVENTS_RE: ["GET /v1/fine_tuning/jobs/{job_id}/events"],
      FINE_TUNING_ID_RE: ["GET /v1/fine_tuning/jobs/{job_id}"],
      FINE_TUNING_JOBS_PATH: ["GET /v1/fine_tuning/jobs", "POST /v1/fine_tuning/jobs"],
      GEMINI_EMBED_RE: ["POST /v1beta/models/{model}:embedContent"],
      GEMINI_INTERACTIONS_PATH: ["POST /v1beta/interactions"],
      GEMINI_PATH_RE: [
        "POST /v1beta/models/{model}:generateContent",
        "POST /v1beta/models/{model}:streamGenerateContent",
      ],
      GEMINI_PREDICT_RE: ["POST /v1beta/models/{model}:predict"],
      GROK_VIDEO_STATUS_RE: ["GET /v1/videos/{id}"],
      GROK_VIDEO_SUBMIT_PATH: ["POST /v1/videos/generations"],
      HEALTH_PATH: ["GET /health"],
      IMAGES_EDIT_PATH: ["POST /v1/images/edits"],
      IMAGES_PATH: ["POST /v1/images/generations"],
      IMAGES_VARIATIONS_PATH: ["POST /v1/images/variations"],
      MESSAGES_PATH: ["POST /v1/messages"],
      METRICS_PATH: ["GET /metrics"],
      MODELS_PATH: ["GET /v1/models"],
      MODERATIONS_PATH: ["POST /v1/moderations"],
      OLLAMA_CHAT_PATH: ["POST /api/chat"],
      OLLAMA_EMBEDDINGS_PATH: ["POST /api/embeddings"],
      OLLAMA_EMBED_PATH: ["POST /api/embed"],
      OLLAMA_GENERATE_PATH: ["POST /api/generate"],
      OLLAMA_TAGS_PATH: ["GET /api/tags"],
      OPENAI_VIDEO_STATUS_RE: ["GET /v1/videos/{id}"],
      OPENROUTER_CREDITS_PATH: ["GET /api/v1/credits"],
      OPENROUTER_KEY_PATH: ["GET /api/v1/key"],
      OPENROUTER_MODELS_PATH: ["GET /api/v1/models"],
      OPENROUTER_VIDEOS_PATH: ["POST /api/v1/videos"],
      OPENROUTER_VIDEO_CONTENT_RE: ["GET /api/v1/videos/{jobId}/content"],
      OPENROUTER_VIDEO_MODELS_PATH: ["GET /api/v1/videos/models"],
      OPENROUTER_VIDEO_STATUS_RE: ["GET /api/v1/videos/{jobId}"],
      READY_PATH: ["GET /ready"],
      REQUESTS_PATH: ["GET /v1/_requests", "DELETE /v1/_requests"],
      RERANK_PATH: ["POST /v2/rerank"],
      RESPONSES_PATH: ["POST /v1/responses"],
      SEARCH_PATH: ["POST /search"],
      SPEECH_PATH: ["POST /v1/audio/speech"],
      TRANSCRIPTIONS_PATH: ["POST /v1/audio/transcriptions"],
      TRANSLATIONS_PATH: ["POST /v1/audio/translations"],
      VEO_OPERATION_RE: ["GET /v1beta/operations/{name}"],
      VEO_PREDICT_LRO_RE: ["POST /v1beta/models/{model}:predictLongRunning"],
      VECTOR_STORES_BATCH_CANCEL_RE: [
        "POST /v1/vector_stores/{vector_store_id}/file_batches/{batch_id}/cancel",
      ],
      VECTOR_STORES_BATCH_FILES_RE: [
        "GET /v1/vector_stores/{vector_store_id}/file_batches/{batch_id}/files",
      ],
      VECTOR_STORES_BATCH_RE: ["GET /v1/vector_stores/{vector_store_id}/file_batches/{batch_id}"],
      VECTOR_STORES_FILE_BATCHES_RE: ["POST /v1/vector_stores/{vector_store_id}/file_batches"],
      VECTOR_STORES_FILE_RE: [
        "GET /v1/vector_stores/{vector_store_id}/files/{file_id}",
        "DELETE /v1/vector_stores/{vector_store_id}/files/{file_id}",
      ],
      VECTOR_STORES_FILES_RE: [
        "POST /v1/vector_stores/{vector_store_id}/files",
        "GET /v1/vector_stores/{vector_store_id}/files",
      ],
      VECTOR_STORES_ID_RE: [
        "GET /v1/vector_stores/{vector_store_id}",
        "POST /v1/vector_stores/{vector_store_id}",
        "DELETE /v1/vector_stores/{vector_store_id}",
      ],
      VECTOR_STORES_PATH: ["GET /v1/vector_stores", "POST /v1/vector_stores"],
      VECTOR_STORES_SEARCH_RE: ["POST /v1/vector_stores/{vector_store_id}/search"],
      VERTEX_AI_RE: [
        "POST /v1/projects/{project}/locations/{location}/publishers/google/models/{model}:generateContent",
        "POST /v1/projects/{project}/locations/{location}/publishers/google/models/{model}:streamGenerateContent",
      ],
      VIDEOS_PATH: ["POST /v1/videos"],
    };
    const dispatchBindings = Object.entries(registry).filter(
      ([name, value]) =>
        !excluded.has(name) &&
        ((typeof value === "string" && name.endsWith("_PATH")) ||
          (value instanceof RegExp && name.endsWith("_RE"))),
    );
    expect(dispatchBindings.map(([name]) => name).sort()).toEqual(
      Object.keys(expectedOperations).sort(),
    );
    const catalogOperations = new Map(ROUTE_DEFINITIONS.map((r) => [`${r.method} ${r.path}`, r]));
    expect(catalogOperations.size).toBe(ROUTE_DEFINITIONS.length);
    for (const [name, matcher] of dispatchBindings) {
      for (const identity of expectedOperations[name]) {
        const route = catalogOperations.get(identity);
        expect(route, `dispatch operation ${name}: ${identity} has no catalog entry`).toBeDefined();
        if (!route) continue;
        const probe = route.examplePath ?? route.path;
        expect(
          typeof matcher === "string"
            ? route.path === matcher
            : matcher instanceof RegExp && matcher.test(probe),
          `catalog operation ${identity} does not match dispatch binding ${name}`,
        ).toBe(true);
      }
    }
  });

  it("detects a dangling reference nested in a real catalog component", async () => {
    const res = await fetch(`${mock.url}/__aimock/openapi.json`);
    expect(res.status).toBe(200);
    const doc: { components: { schemas: { [name: string]: unknown } } } = await res.json();
    expectCatalogReferencesResolve(doc);

    const mutated = structuredClone(doc);
    expect(mutated.components.schemas.FineTuningJobEvent).toBeDefined();
    expect(mutated.components.schemas.FineTuningJobEventListResponse).toMatchObject({
      properties: { data: { items: { $ref: "#/components/schemas/FineTuningJobEvent" } } },
    });
    delete mutated.components.schemas.FineTuningJobEvent;
    expect(() => expectCatalogReferencesResolve(mutated)).toThrow(
      "unresolved $ref #/components/schemas/FineTuningJobEvent",
    );
    expectCatalogReferencesResolve(doc);
  });

  it("every catalog operation carries a real schema (no bare paths)", async () => {
    const res = await fetch(`${mock.url}/__aimock/openapi.json`);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      components: { schemas: Record<string, unknown> };
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    expectCatalogReferencesResolve(doc);

    // No operation is a bare path: each has a requestBody, a success body, or
    // an explicit non-200 success status (replayed removals, 204 clears).
    // In particular the review-flagged families must have real schemas.
    const mustHaveSchemas = [
      "POST /v1/messages",
      "GET /v1/batches",
      "POST /v1/batches",
      "GET /v1/batches/{batch_id}",
      "POST /v1/batches/{batch_id}/cancel",
      "GET /v1/files",
      "POST /v1/files",
      "GET /v1/files/{file_id}",
      "DELETE /v1/files/{file_id}",
      "GET /v1/files/{file_id}/content",
      "POST /v1/fine_tuning/jobs",
      "GET /v1/fine_tuning/jobs",
      "GET /v1/fine_tuning/jobs/{job_id}",
      "POST /v1/fine_tuning/jobs/{job_id}/cancel",
      "GET /v1/fine_tuning/jobs/{job_id}/events",
    ];
    for (const r of ROUTE_DEFINITIONS) {
      const operation = doc.paths[r.path]?.[r.method.toLowerCase()] as
        | Record<string, unknown>
        | undefined;
      if (operation === undefined) throw new Error(`missing operation ${r.method} ${r.path}`);
      const responses = operation.responses as Record<string, unknown>;
      // 400 is always the validation error; anything else (200, 204, or the
      // documented 404 replay of a removed route) is the success outcome.
      const successKey = Object.keys(responses).find((s) => s !== "400");
      expect(successKey !== undefined, `no success response for ${r.method} ${r.path}`).toBe(true);
      const hasRequest = operation.requestBody !== undefined;
      const success = responses[successKey!] as { content?: unknown };
      const hasSuccessBody = success.content !== undefined;
      const nonJsonSuccess = successKey !== "200";
      expect(
        hasRequest || hasSuccessBody || nonJsonSuccess,
        `${r.method} ${r.path} is a bare path with no schema`,
      ).toBe(true);
      if (mustHaveSchemas.includes(`${r.method} ${r.path}`)) {
        expect(hasRequest || hasSuccessBody).toBe(true);
      }
    }
  });

  it("matchRouteDefinition agrees with the registry table", () => {
    // Exact paths resolve.
    expect(matchRouteDefinition("POST", "/v1/chat/completions")?.service).toBe("openai");
    expect(matchRouteDefinition("get", "/health")?.service).toBe("ops");
    // Templates resolve their example paths.
    expect(matchRouteDefinition("POST", "/v1/text-to-speech/test-voice")?.service).toBe(
      "elevenlabs",
    );
    expect(matchRouteDefinition("GET", "/v1/fine_tuning/jobs/ftjob-test123/events")?.service).toBe(
      "fine-tuning",
    );
    // Method mismatches and unknown paths miss.
    expect(matchRouteDefinition("GET", "/v1/chat/completions")).toBeUndefined();
    expect(matchRouteDefinition("POST", "/v1/_requests")).toBeUndefined();
    expect(matchRouteDefinition("GET", "/nope/not-a-route")).toBeUndefined();
    // Self-consistency: every entry's probe path resolves to an entry.
    for (const r of ROUTE_DEFINITIONS) {
      const hit = matchRouteDefinition(r.method, r.examplePath ?? r.path);
      expect(hit !== undefined, `${r.method} ${r.examplePath ?? r.path} misses`).toBe(true);
    }
    // templateToRegExp compiles single-segment params and literal actions.
    expect(
      templateToRegExp("/v1beta/models/{model}:predict").test("/v1beta/models/a:predict"),
    ).toBe(true);
    expect(
      templateToRegExp("/v1beta/models/{model}:predict").test("/v1beta/models/a/b:predict"),
    ).toBe(false);
  });
});
