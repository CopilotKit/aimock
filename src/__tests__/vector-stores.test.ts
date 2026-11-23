import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import OpenAI, { toFile } from "openai";
import type { FileBatchCreateParams } from "openai/resources/vector-stores/file-batches.js";
import type { ComparisonFilter, CompoundFilter } from "openai/resources/shared.js";
import type { FileChunkingStrategy } from "openai/resources/vector-stores/vector-stores";
import { LLMock } from "../llmock.js";
import { clearFileStore } from "../files.js";
import { clearVectorStoreStore, type VectorStoreObject } from "../vector-stores.js";
import { normalizePathLabel } from "../metrics.js";

async function postJson(
  url: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(headers ?? {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function uploadFile(mockUrl: string, filename: string, content: string): Promise<string> {
  const res = await postJson(`${mockUrl}/v1/files`, {
    filename,
    purpose: "assistants",
    content,
  });
  expect(res.status).toBe(200);
  const obj = (await res.json()) as { id: string };
  return obj.id;
}

describe("Vector Stores API mock", () => {
  let mock: LLMock;

  beforeEach(async () => {
    clearFileStore();
    clearVectorStoreStore();
    mock = new LLMock({ port: 0 });
    await mock.start();
  });

  afterEach(async () => {
    await mock.stop();
    clearFileStore();
    clearVectorStoreStore();
  });

  it("source file deletion removes all vector memberships and active batch accounting", async () => {
    const client = new OpenAI({ apiKey: "mock", baseURL: `${mock.url}/v1`, maxRetries: 0 });
    const deleted = await uploadFile(mock.url, "removed.txt", "removed content");
    const survivor = await uploadFile(mock.url, "kept.txt", "kept");
    const first = await client.vectorStores.create({ file_ids: [deleted, survivor] });
    const second = await client.vectorStores.create({});
    const batch = await client.vectorStores.fileBatches.create(second.id, { file_ids: [deleted] });
    for (const fileId of [deleted, survivor]) {
      await client.vectorStores.files.retrieve(first.id, fileId);
      await client.vectorStores.files.retrieve(first.id, fileId);
    }
    expect((await client.vectorStores.search(first.id, { query: "content" })).data).toHaveLength(2);
    expect((await client.vectorStores.retrieve(first.id)).usage_bytes).toBe(19);
    expect(
      (await client.vectorStores.fileBatches.retrieve(second.id, batch.id)).file_counts.in_progress,
    ).toBe(1);

    expect((await client.files.del(deleted)).deleted).toBe(true);
    for (const store of [first, second]) {
      await expect(client.vectorStores.files.retrieve(store.id, deleted)).rejects.toMatchObject({
        status: 404,
      });
      expect((await client.vectorStores.files.list(store.id)).data.map((file) => file.id)).toEqual(
        store.id === first.id ? [survivor] : [],
      );
    }
    expect(
      (await client.vectorStores.search(first.id, { query: "content" })).data.map(
        (row) => row.file_id,
      ),
    ).toEqual([survivor]);
    expect(await client.vectorStores.retrieve(first.id)).toMatchObject({
      usage_bytes: 4,
      file_counts: { total: 1, completed: 1 },
    });
    expect(await client.vectorStores.retrieve(second.id)).toMatchObject({
      usage_bytes: 0,
      status: "completed",
      file_counts: { total: 0, in_progress: 0 },
    });
    for (let poll = 0; poll < 3; poll++) {
      expect(await client.vectorStores.fileBatches.retrieve(second.id, batch.id)).toMatchObject({
        status: "completed",
        file_counts: { total: 0, in_progress: 0 },
      });
      expect((await client.vectorStores.fileBatches.listFiles(second.id, batch.id)).data).toEqual(
        [],
      );
    }
    await expect(client.files.del(deleted)).rejects.toMatchObject({ status: 404 });
    expect((await client.files.retrieve(survivor)).id).toBe(survivor);
  });

  it("source file deletion preserves remaining pending batch members", async () => {
    const client = new OpenAI({ apiKey: "mock", baseURL: `${mock.url}/v1`, maxRetries: 0 });
    const deleted = await uploadFile(mock.url, "removed.txt", "removed");
    const survivor = await uploadFile(mock.url, "kept.txt", "kept");
    const store = await client.vectorStores.create({});
    const batch = await client.vectorStores.fileBatches.create(store.id, {
      file_ids: [deleted, survivor],
    });
    await client.files.del(deleted);
    expect(await client.vectorStores.fileBatches.retrieve(store.id, batch.id)).toMatchObject({
      status: "in_progress",
      file_counts: { total: 1, in_progress: 1 },
    });
    expect(await client.vectorStores.fileBatches.retrieve(store.id, batch.id)).toMatchObject({
      status: "completed",
      file_counts: { total: 1, completed: 1 },
    });
    expect(
      (await client.vectorStores.fileBatches.listFiles(store.id, batch.id)).data.map(
        (file) => file.id,
      ),
    ).toEqual([survivor]);
    expect(await client.vectorStores.retrieve(store.id)).toMatchObject({
      usage_bytes: 4,
      file_counts: { total: 1, completed: 1 },
    });
  });

  it("source file deletion updates expired store accounting without reviving it", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    try {
      const client = new OpenAI({ apiKey: "mock", baseURL: `${mock.url}/v1`, maxRetries: 0 });
      const deleted = await uploadFile(mock.url, "removed.txt", "removed");
      const store = await client.vectorStores.create({
        file_ids: [deleted],
        expires_after: { anchor: "last_active_at", days: 1 },
      });
      await client.vectorStores.files.retrieve(store.id, deleted);
      await client.vectorStores.files.retrieve(store.id, deleted);
      expect((await client.vectorStores.retrieve(store.id)).usage_bytes).toBe(7);
      clock.mockReturnValue(1_800_086_401_000);
      expect((await client.vectorStores.retrieve(store.id)).status).toBe("expired");
      await client.files.del(deleted);
      expect(await client.vectorStores.retrieve(store.id)).toMatchObject({
        status: "expired",
        usage_bytes: 0,
        file_counts: { total: 0, completed: 0 },
        last_active_at: store.last_active_at,
        expires_at: store.expires_at,
      });
    } finally {
      clock.mockRestore();
    }
  });

  async function attributeFixture() {
    const client = new OpenAI({ apiKey: "mock", baseURL: `${mock.url}/v1`, maxRetries: 0 });
    const store = await client.vectorStores.create({ name: "attributes" });
    const attributes = { category: "guide", revision: 2, published: true };
    const uploaded = await client.files.create({
      purpose: "assistants",
      file: await toFile(Buffer.from("real uploaded document"), "attributes.txt"),
    });
    await client.vectorStores.files.create(store.id, { file_id: uploaded.id, attributes });
    await client.vectorStores.files.retrieve(store.id, uploaded.id);
    await client.vectorStores.files.retrieve(store.id, uploaded.id);
    return { client, store, uploaded, attributes };
  }

  const attributeFilters: [string, ComparisonFilter | CompoundFilter, boolean][] = [
    ["string eq", { type: "eq", key: "category", value: "guide" }, true],
    ["string mismatch", { type: "eq", key: "category", value: "other" }, false],
    ["number eq", { type: "eq", key: "revision", value: 2 }, true],
    ["boolean eq", { type: "eq", key: "published", value: true }, true],
    ["boolean mismatch", { type: "eq", key: "published", value: false }, false],
    ["ne", { type: "ne", key: "category", value: "other" }, true],
    ["ne mismatch", { type: "ne", key: "category", value: "guide" }, false],
    ["gt", { type: "gt", key: "revision", value: 1 }, true],
    ["gt mismatch", { type: "gt", key: "revision", value: 2 }, false],
    ["gte", { type: "gte", key: "revision", value: 2 }, true],
    ["gte mismatch", { type: "gte", key: "revision", value: 3 }, false],
    ["lt", { type: "lt", key: "revision", value: 3 }, true],
    ["lt mismatch", { type: "lt", key: "revision", value: 2 }, false],
    ["lte", { type: "lte", key: "revision", value: 2 }, true],
    ["lte mismatch", { type: "lte", key: "revision", value: 1 }, false],
    ["missing key", { type: "eq", key: "absent", value: "x" }, false],
    ["missing ne key", { type: "ne", key: "absent", value: "x" }, false],
    ["type mismatch", { type: "eq", key: "revision", value: "2" }, false],
    [
      "nested and/or",
      {
        type: "and",
        filters: [
          { type: "eq", key: "published", value: true },
          {
            type: "or",
            filters: [
              { type: "gt", key: "revision", value: 10 },
              { type: "eq", key: "category", value: "guide" },
            ],
          },
        ],
      },
      true,
    ],
    [
      "nested rejection",
      {
        type: "or",
        filters: [
          { type: "eq", key: "published", value: false },
          {
            type: "and",
            filters: [
              { type: "eq", key: "category", value: "guide" },
              { type: "gt", key: "revision", value: 10 },
            ],
          },
        ],
      },
      false,
    ],
  ];

  it.each(attributeFilters)("attribute filters: %s", async (_label, filters, matches) => {
    const { client, store, uploaded } = await attributeFixture();
    const result = await client.vectorStores.search(store.id, { query: "document", filters });
    expect(result.data.map((row) => row.file_id)).toEqual(matches ? [uploaded.id] : []);
  });

  it("attribute roundtrip survives SDK attachment, polling and search", async () => {
    const { client, store, uploaded, attributes } = await attributeFixture();
    expect((await client.vectorStores.files.retrieve(store.id, uploaded.id)).attributes).toEqual(
      attributes,
    );
    expect(
      (await client.vectorStores.search(store.id, { query: "document" })).data[0].attributes,
    ).toEqual(attributes);
  });

  const batchAttributes: FileBatchCreateParams["attributes"][] = [
    undefined,
    null,
    {},
    { category: "batch", revision: 3, published: false },
  ];
  it.each(batchAttributes)("attribute batch shape roundtrips %j", async (attributes) => {
    const { client, uploaded } = await attributeFixture();
    const store = await client.vectorStores.create({ name: "batch attributes" });
    const batch = await client.vectorStores.fileBatches.create(store.id, {
      file_ids: [uploaded.id],
      attributes,
    });
    await client.vectorStores.fileBatches.retrieve(store.id, batch.id);
    await client.vectorStores.fileBatches.retrieve(store.id, batch.id);
    expect((await client.vectorStores.files.retrieve(store.id, uploaded.id)).attributes).toEqual(
      attributes ?? null,
    );
    expect(
      (await client.vectorStores.search(store.id, { query: "document" })).data[0].attributes,
    ).toEqual(attributes ?? null);
  });

  describe.each(["files", "file_batches"] as const)("%s Unicode attributes", (endpoint) => {
    it.each([
      ["key", 33, 200],
      ["key", 64, 200],
      ["key", 65, 400],
      ["value", 257, 200],
      ["value", 512, 200],
      ["value", 513, 400],
    ] as const)("counts code points for %s length %i", async (kind, length, status) => {
      const client = new OpenAI({ apiKey: "mock", baseURL: `${mock.url}/v1`, maxRetries: 0 });
      const store = await client.vectorStores.create({});
      const fileId = await uploadFile(mock.url, "unicode.txt", "Unicode attributes");
      const text = "😀".repeat(length);
      const attributes = kind === "key" ? { [text]: "ok" } : { key: text };
      const body =
        endpoint === "files" ? { file_id: fileId, attributes } : { file_ids: [fileId], attributes };
      const response = await postJson(`${mock.url}/v1/vector_stores/${store.id}/${endpoint}`, body);
      expect(response.status).toBe(status);
      if (status === 200) {
        expect((await client.vectorStores.files.retrieve(store.id, fileId)).attributes).toEqual(
          attributes,
        );
      } else {
        expect((await client.vectorStores.files.list(store.id)).data).toEqual([]);
      }
    });
  });

  it.each([
    [],
    { nested: {} },
    { nil: null },
    { list: [] },
    { ["k".repeat(65)]: "value" },
    { key: "v".repeat(513) },
    Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`key${i}`, i])),
  ])("attribute malformed input returns 400 atomically: %j", async (attributes) => {
    const { client, uploaded } = await attributeFixture();
    const store = await client.vectorStores.create({ name: "bad attributes" });
    for (const [endpoint, body] of [
      ["files", { file_id: uploaded.id, attributes }],
      ["file_batches", { file_ids: [uploaded.id], attributes }],
    ] as const) {
      expect(
        (await postJson(`${mock.url}/v1/vector_stores/${store.id}/${endpoint}`, body)).status,
      ).toBe(400);
      expect((await client.vectorStores.files.list(store.id)).data).toEqual([]);
    }
  });

  it.each([
    null,
    {},
    [],
    { type: "eq", key: "category" },
    { type: "invalid", key: "category", value: "guide" },
    { type: "eq", key: 1, value: true },
    { type: "eq", key: "category", value: [] },
    { type: "and", filters: {} },
    { type: "or", filters: [{ type: "eq" }] },
  ])("attribute malformed filter returns 400: %j", async (filters) => {
    const { store } = await attributeFixture();
    expect(
      (
        await postJson(`${mock.url}/v1/vector_stores/${store.id}/search`, {
          query: "document",
          filters,
        })
      ).status,
    ).toBe(400);
  });

  it("rejects excessive attribute filter nesting with a controlled 400", async () => {
    const { store } = await attributeFixture();
    // Construct the wire payload directly: JSON.stringify itself cannot serialize this depth.
    const filters =
      '{"type":"and","filters":['.repeat(10_000) +
      '{"type":"eq","key":"category","value":"guide"}' +
      "]}".repeat(10_000);
    const response = await fetch(`${mock.url}/v1/vector_stores/${store.id}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: `{"query":"document","filters":${filters}}`,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { type: "invalid_request_error", message: expect.stringContaining("nesting") },
    });
  });

  it("creates, retrieves, modifies and deletes a store", async () => {
    const created = (await (
      await postJson(`${mock.url}/v1/vector_stores`, { name: "rag-docs" })
    ).json()) as {
      id: string;
      object: string;
      name: string;
      status: string;
      usage_bytes: number;
      file_counts: { total: number; completed: number };
      metadata: null;
    };
    expect(created.id.startsWith("vs_")).toBe(true);
    expect(created.object).toBe("vector_store");
    expect(created.name).toBe("rag-docs");
    expect(created.status).toBe("completed");
    expect(created.usage_bytes).toBe(0);
    expect(created.file_counts.total).toBe(0);

    const got = (await (await fetch(`${mock.url}/v1/vector_stores/${created.id}`)).json()) as {
      id: string;
      name: string;
    };
    expect(got.id).toBe(created.id);

    const modified = (await (
      await postJson(`${mock.url}/v1/vector_stores/${created.id}`, {
        name: "renamed",
        metadata: { team: "search" },
      })
    ).json()) as { name: string; metadata: Record<string, string> };
    expect(modified.name).toBe("renamed");
    expect(modified.metadata).toEqual({ team: "search" });

    const del = (await (
      await fetch(`${mock.url}/v1/vector_stores/${created.id}`, { method: "DELETE" })
    ).json()) as { object: string; deleted: boolean };
    expect(del.object).toBe("vector_store.deleted");
    expect(del.deleted).toBe(true);
    expect((await fetch(`${mock.url}/v1/vector_stores/${created.id}`)).status).toBe(404);
  });

  it("resets a nullable SDK update name to an empty string and accepts later renames", async () => {
    const client = new OpenAI({ apiKey: "mock", baseURL: `${mock.url}/v1`, maxRetries: 0 });
    const created = await client.vectorStores.create({ name: "original" });
    const reset = await client.vectorStores.update(created.id, { name: null });
    expect(reset.name).toBe("");
    expect((await client.vectorStores.retrieve(created.id)).name).toBe("");
    expect(
      (await client.vectorStores.update(created.id, { metadata: { team: "search" } })).name,
    ).toBe("");
    expect((await client.vectorStores.update(created.id, { name: "renamed" })).name).toBe(
      "renamed",
    );
    expect((await client.vectorStores.retrieve(created.id)).name).toBe("renamed");
  });

  it.each([
    { name: null, metadata: { invalid: 42 } },
    { name: null, metadata: { team: "changed" }, expires_after: { days: -1 } },
    { name: "changed", metadata: { invalid: 42 } },
    { name: "changed", metadata: { team: "changed" }, expires_after: { days: -1 } },
  ])("preserves store state after rejected mixed-field modification: %j", async (body) => {
    const initial = {
      name: "original",
      metadata: { team: "original" },
      expires_after: { anchor: "last_active_at", days: 7 },
    };
    const createdResponse = await postJson(`${mock.url}/v1/vector_stores`, initial);
    expect(createdResponse.status).toBe(200);
    const created = (await createdResponse.json()) as { id: string };
    const response = await postJson(`${mock.url}/v1/vector_stores/${created.id}`, body);
    expect(response.status).toBe(400);
    // Listing does not touch the store, so it also detects unintended timestamp changes.
    const listed = (await (await fetch(`${mock.url}/v1/vector_stores`)).json()) as {
      data: { id: string }[];
    };
    expect(listed.data).toEqual([created]);
    const retrieved = await fetch(`${mock.url}/v1/vector_stores/${created.id}`);
    expect(retrieved.status).toBe(200);
    expect(await retrieved.json()).toMatchObject(initial);
  });

  it("commits a valid multi-field modification and clears expiration", async () => {
    const created = (await (await postJson(`${mock.url}/v1/vector_stores`, {})).json()) as {
      id: string;
    };
    const update = {
      name: "updated",
      metadata: { team: "search" },
      expires_after: { anchor: "last_active_at", days: 3 },
    };
    const response = await postJson(`${mock.url}/v1/vector_stores/${created.id}`, update);
    expect(response.status).toBe(200);
    const modified = (await response.json()) as { last_active_at: number; expires_at: number };
    expect(modified).toMatchObject(update);
    expect(modified.expires_at).toBe(modified.last_active_at + 3 * 86400);
    expect(await (await fetch(`${mock.url}/v1/vector_stores/${created.id}`)).json()).toMatchObject(
      update,
    );
    const cleared = await postJson(`${mock.url}/v1/vector_stores/${created.id}`, {
      name: "cleared",
      metadata: null,
      expires_after: null,
    });
    expect(cleared.status).toBe(200);
    const result = await cleared.json();
    expect(result).toMatchObject({ name: "cleared", metadata: null, expires_at: null });
    expect(result).not.toHaveProperty("expires_after");
  });

  it("creates a store with file_ids and completes file ingestion on poll", async () => {
    const fileId = await uploadFile(mock.url, "doc.txt", "hello world");
    const created = (await (
      await postJson(`${mock.url}/v1/vector_stores`, { name: "with-files", file_ids: [fileId] })
    ).json()) as {
      id: string;
      status: string;
      file_counts: { total: number; in_progress: number };
    };
    expect(created.file_counts.total).toBe(1);

    const first = (await (
      await fetch(`${mock.url}/v1/vector_stores/${created.id}/files/${fileId}`)
    ).json()) as { status: string };
    expect(first.status).toBe("in_progress");

    const second = (await (
      await fetch(`${mock.url}/v1/vector_stores/${created.id}/files/${fileId}`)
    ).json()) as { status: string; usage_bytes: number };
    expect(second.status).toBe("completed");
    expect(second.usage_bytes).toBeGreaterThan(0);

    // Terminal file reads are stable.
    const third = (await (
      await fetch(`${mock.url}/v1/vector_stores/${created.id}/files/${fileId}`)
    ).json()) as { status: string };
    expect(third.status).toBe("completed");

    const store = (await (await fetch(`${mock.url}/v1/vector_stores/${created.id}`)).json()) as {
      status: string;
      usage_bytes: number;
    };
    expect(store.status).toBe("completed");
    expect(store.usage_bytes).toBeGreaterThan(0);
  });

  it("attaches, lists, filters and detaches files", async () => {
    const store = (await (
      await postJson(`${mock.url}/v1/vector_stores`, { name: "s" })
    ).json()) as { id: string };
    const a = await uploadFile(mock.url, "a.txt", "aaa");
    const b = await uploadFile(mock.url, "b.txt", "bbb");

    for (const fileId of [a, b]) {
      const res = await postJson(`${mock.url}/v1/vector_stores/${store.id}/files`, {
        file_id: fileId,
      });
      expect(res.status).toBe(200);
    }

    // Complete one file so the filter has something to split on.
    await fetch(`${mock.url}/v1/vector_stores/${store.id}/files/${a}`);
    await fetch(`${mock.url}/v1/vector_stores/${store.id}/files/${a}`);

    const all = (await (await fetch(`${mock.url}/v1/vector_stores/${store.id}/files`)).json()) as {
      object: string;
      data: { id: string }[];
      has_more: boolean;
    };
    expect(all.object).toBe("list");
    expect(all.data.map((d) => d.id)).toEqual(expect.arrayContaining([a, b]));

    const done = (await (
      await fetch(`${mock.url}/v1/vector_stores/${store.id}/files?filter=completed`)
    ).json()) as { data: { id: string }[] };
    expect(done.data.map((d) => d.id)).toContain(a);
    expect(done.data.map((d) => d.id)).not.toContain(b);

    const pending = (await (
      await fetch(`${mock.url}/v1/vector_stores/${store.id}/files?filter=in_progress`)
    ).json()) as { data: { id: string }[] };
    expect(pending.data.map((d) => d.id)).toContain(b);

    const detached = (await (
      await fetch(`${mock.url}/v1/vector_stores/${store.id}/files/${b}`, { method: "DELETE" })
    ).json()) as { object: string; deleted: boolean };
    expect(detached.object).toBe("vector_store.file.deleted");
    expect(detached.deleted).toBe(true);
    expect((await fetch(`${mock.url}/v1/vector_stores/${store.id}/files/${b}`)).status).toBe(404);
  });

  it("rejects duplicate attaches, unknown files and unknown stores", async () => {
    const store = (await (await postJson(`${mock.url}/v1/vector_stores`, {})).json()) as {
      id: string;
    };
    const fileId = await uploadFile(mock.url, "d.txt", "ddd");
    expect(
      (await postJson(`${mock.url}/v1/vector_stores/${store.id}/files`, { file_id: fileId }))
        .status,
    ).toBe(200);
    expect(
      (await postJson(`${mock.url}/v1/vector_stores/${store.id}/files`, { file_id: fileId }))
        .status,
    ).toBe(400);
    expect(
      (await postJson(`${mock.url}/v1/vector_stores/${store.id}/files`, { file_id: "file-nope" }))
        .status,
    ).toBe(404);
    expect(
      (await postJson(`${mock.url}/v1/vector_stores/vs_nope/files`, { file_id: fileId })).status,
    ).toBe(404);
    expect((await fetch(`${mock.url}/v1/vector_stores/vs_nope`)).status).toBe(404);
    expect((await fetch(`${mock.url}/v1/vector_stores/vs_nope`, { method: "DELETE" })).status).toBe(
      404,
    );
  });

  it("rejects duplicate batch IDs atomically and preserves unique cursor progress", async () => {
    const store = await (await postJson(`${mock.url}/v1/vector_stores`, {})).json();
    const a = await uploadFile(mock.url, "a.txt", "aaa");
    const b = await uploadFile(mock.url, "b.txt", "bbb");
    const path = `${mock.url}/v1/vector_stores/${store.id}`;
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    try {
      const before = await (await fetch(path)).json();

      clock.mockReturnValue(1_800_000_001_000);
      const rejected = await postJson(`${path}/file_batches`, { file_ids: [a, a, a] });
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toMatchObject({
        error: { message: expect.stringContaining("duplicate") },
      });
      // Listing does not update last_active_at, unlike retrieving the store.
      const after: { data: VectorStoreObject[] } = await (
        await fetch(`${mock.url}/v1/vector_stores`)
      ).json();
      expect(after.data).toEqual([before]);
      expect(await (await fetch(`${path}/files`)).json()).toMatchObject({ data: [] });
    } finally {
      clock.mockRestore();
    }

    // Existing attachments remain valid batch members alongside new files.
    expect((await postJson(`${path}/files`, { file_id: a })).status).toBe(200);
    const response = await postJson(`${path}/file_batches`, { file_ids: [a, b] });
    expect(response.status).toBe(200);
    const batch = await response.json();
    expect(batch.file_counts.total).toBe(2);
    const seen: string[] = [];
    let after = "";
    let hasMore = true;
    for (let pageNumber = 0; pageNumber < 3 && hasMore; pageNumber++) {
      const page = await (
        await fetch(
          `${path}/file_batches/${batch.id}/files?limit=1${after ? `&after=${after}` : ""}`,
        )
      ).json();
      expect(page.data).toHaveLength(1);
      expect(seen).not.toContain(page.last_id);
      seen.push(page.last_id);
      after = page.last_id;
      hasMore = page.has_more;
    }
    expect(hasMore).toBe(false);
    expect(seen.sort()).toEqual([a, b].sort());
    await fetch(`${path}/file_batches/${batch.id}`);
    const completed = await (await fetch(`${path}/file_batches/${batch.id}`)).json();
    expect(completed.file_counts).toMatchObject({ total: 2, completed: 2 });
    expect(await (await fetch(path)).json()).toMatchObject({
      file_counts: { total: 2, completed: 2 },
    });
  });

  it.each(["terminal", "cancel", "complete"] as const)(
    "isolates reattached files from an old batch: %s",
    async (operation) => {
      const fileId = await uploadFile(mock.url, "reattach.txt", "original content");
      const store = await (await postJson(`${mock.url}/v1/vector_stores`, {})).json();
      const storeUrl = `${mock.url}/v1/vector_stores/${store.id}`;
      const batch = await (
        await postJson(`${storeUrl}/file_batches`, { file_ids: [fileId] })
      ).json();
      const batchUrl = `${storeUrl}/file_batches/${batch.id}`;
      if (operation === "terminal") {
        await fetch(batchUrl);
        expect(await (await fetch(batchUrl)).json()).toMatchObject({ status: "completed" });
      }
      expect((await fetch(`${storeUrl}/files/${fileId}`, { method: "DELETE" })).status).toBe(200);
      const replacement = await postJson(
        `${storeUrl}/files`,
        { file_id: fileId },
        { "X-AIMock-Vector-Outcome": "failed" },
      );
      expect(replacement.status).toBe(200);
      if (operation === "cancel") {
        expect((await postJson(`${batchUrl}/cancel`, {})).status).toBe(200);
      }
      await fetch(batchUrl);
      const historical = await (await fetch(batchUrl)).json();
      const status = operation === "cancel" ? "cancelled" : "completed";
      expect.soft(historical).toMatchObject({
        status,
        file_counts: {
          in_progress: 0,
          completed: status === "completed" ? 1 : 0,
          failed: 0,
          cancelled: status === "cancelled" ? 1 : 0,
          total: 1,
        },
      });
      expect.soft(await (await fetch(`${batchUrl}/files`)).json()).toMatchObject({
        data: [{ id: fileId, status }],
      });
      expect.soft(await (await fetch(`${storeUrl}/files/${fileId}`)).json()).toMatchObject({
        status: "in_progress",
      });
      expect.soft(await (await fetch(`${storeUrl}/files/${fileId}`)).json()).toMatchObject({
        status: "failed",
        last_error: { code: "mock_ingest_failed" },
      });
      expect(await (await fetch(storeUrl)).json()).toMatchObject({
        file_counts: { total: 1, failed: 1, completed: 0, cancelled: 0, in_progress: 0 },
      });
    },
  );

  it("drives file batches through poll progression and cancel", async () => {
    const store = (await (await postJson(`${mock.url}/v1/vector_stores`, {})).json()) as {
      id: string;
    };
    const a = await uploadFile(mock.url, "a.txt", "aaa");
    const b = await uploadFile(mock.url, "b.txt", "bbb");

    const batch = (await (
      await postJson(`${mock.url}/v1/vector_stores/${store.id}/file_batches`, { file_ids: [a, b] })
    ).json()) as { id: string; status: string; file_counts: { total: number } };
    expect(batch.id.startsWith("vsfb_")).toBe(true);
    expect(batch.status).toBe("in_progress");
    expect(batch.file_counts.total).toBe(2);

    const first = (await (
      await fetch(`${mock.url}/v1/vector_stores/${store.id}/file_batches/${batch.id}`)
    ).json()) as { status: string };
    expect(first.status).toBe("in_progress");

    const second = (await (
      await fetch(`${mock.url}/v1/vector_stores/${store.id}/file_batches/${batch.id}`)
    ).json()) as { status: string; file_counts: { completed: number } };
    expect(second.status).toBe("completed");
    expect(second.file_counts.completed).toBe(2);

    const members = (await (
      await fetch(`${mock.url}/v1/vector_stores/${store.id}/file_batches/${batch.id}/files`)
    ).json()) as { data: { id: string }[] };
    expect(members.data.map((d) => d.id)).toEqual(expect.arrayContaining([a, b]));

    // Cancel a live batch, then watch it land on cancelled.
    const c = await uploadFile(mock.url, "c.txt", "ccc");
    const live = (await (
      await postJson(`${mock.url}/v1/vector_stores/${store.id}/file_batches`, { file_ids: [c] })
    ).json()) as { id: string };
    const cancelling = (await (
      await postJson(`${mock.url}/v1/vector_stores/${store.id}/file_batches/${live.id}/cancel`, {})
    ).json()) as { status: string };
    expect(cancelling.status).toBe("cancelling");
    const cancelled = (await (
      await fetch(`${mock.url}/v1/vector_stores/${store.id}/file_batches/${live.id}`)
    ).json()) as { status: string };
    expect(cancelled.status).toBe("cancelled");

    // Cancelling a terminal batch is a 400.
    expect(
      (
        await postJson(
          `${mock.url}/v1/vector_stores/${store.id}/file_batches/${batch.id}/cancel`,
          {},
        )
      ).status,
    ).toBe(400);
    expect(
      (await fetch(`${mock.url}/v1/vector_stores/vs_nope/file_batches/${batch.id}`)).status,
    ).toBe(404);
    expect(
      (await fetch(`${mock.url}/v1/vector_stores/${store.id}/file_batches/vsfb_nope`)).status,
    ).toBe(404);
  });

  async function createFilterBatch(outcome = "completed") {
    const store = await (await postJson(`${mock.url}/v1/vector_stores`, {})).json();
    const fileIds = [];
    for (let i = 0; i < 4; i++) {
      fileIds.push(await uploadFile(mock.url, `filter-${i}.txt`, `document ${i}`));
    }
    const response = await postJson(
      `${mock.url}/v1/vector_stores/${store.id}/file_batches`,
      { file_ids: fileIds },
      { "X-AIMock-Vector-Outcome": outcome },
    );
    expect(response.status).toBe(200);
    const batch = await response.json();
    const filesUrl = `${mock.url}/v1/vector_stores/${store.id}/files`;
    const batchFilesUrl = `${mock.url}/v1/vector_stores/${store.id}/file_batches/${batch.id}/files`;
    const responseAll = await fetch(batchFilesUrl);
    expect(responseAll.status).toBe(200);
    const all: { data: { id: string }[] } = await responseAll.json();
    const orderedIds = all.data.map((file) => file.id);
    for (const id of [orderedIds[1], orderedIds[3]]) {
      await fetch(`${filesUrl}/${id}`);
      const terminal = await fetch(`${filesUrl}/${id}`);
      expect((await terminal.json()).status).toBe(outcome);
    }
    return { batchFilesUrl, orderedIds };
  }

  it.each(["completed", "failed", "cancelled"])(
    "filters batch files by %s before pagination and preserves cursor ordering",
    async (outcome) => {
      const { batchFilesUrl, orderedIds } = await createFilterBatch(outcome);
      for (const filter of [outcome, "in_progress"]) {
        const expected =
          filter === outcome ? [orderedIds[1], orderedIds[3]] : [orderedIds[0], orderedIds[2]];
        for (const order of ["desc", "asc"]) {
          const ids = order === "desc" ? expected : [...expected].reverse();
          const url = `${batchFilesUrl}?filter=${filter}&order=${order}&limit=1`;
          const first = await fetch(url);
          expect(first.status).toBe(200);
          expect(await first.json()).toMatchObject({
            data: [{ id: ids[0], status: filter }],
            first_id: ids[0],
            last_id: ids[0],
            has_more: true,
          });
          const second = await fetch(`${url}&after=${ids[0]}`);
          expect(second.status).toBe(200);
          expect(await second.json()).toMatchObject({
            data: [{ id: ids[1], status: filter }],
            first_id: ids[1],
            last_id: ids[1],
            has_more: false,
          });
          const previous = await fetch(`${url}&before=${ids[1]}`);
          expect(previous.status).toBe(200);
          expect(await previous.json()).toMatchObject({
            data: [{ id: ids[0], status: filter }],
            has_more: false,
          });
        }
      }
      const absent = outcome === "failed" ? "completed" : "failed";
      const empty = await fetch(`${batchFilesUrl}?filter=${absent}`);
      expect(empty.status).toBe(200);
      expect(await empty.json()).toMatchObject({
        data: [],
        first_id: null,
        last_id: null,
        has_more: false,
      });
    },
  );

  it.each(["filter=unknown", "filter=", "filter=completed&filter=failed"])(
    "rejects invalid batch file filter query %s",
    async (query) => {
      const { batchFilesUrl } = await createFilterBatch();
      const response = await fetch(`${batchFilesUrl}?${query}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { message: expect.stringContaining("'filter'") },
      });
    },
  );

  it("honors the outcome header and rejects unknown outcomes", async () => {
    const store = (await (await postJson(`${mock.url}/v1/vector_stores`, {})).json()) as {
      id: string;
    };
    const bad = await postJson(
      `${mock.url}/v1/vector_stores/${store.id}/files`,
      { file_id: await uploadFile(mock.url, "x.txt", "xxx") },
      { "X-AIMock-Vector-Outcome": "bogus" },
    );
    expect(bad.status).toBe(400);

    const failedId = await uploadFile(mock.url, "f.txt", "fff");
    const failed = (await (
      await postJson(
        `${mock.url}/v1/vector_stores/${store.id}/files`,
        { file_id: failedId },
        { "X-AIMock-Vector-Outcome": "failed" },
      )
    ).json()) as { status: string };
    expect(failed.status).toBe("in_progress");
    await fetch(`${mock.url}/v1/vector_stores/${store.id}/files/${failedId}`);
    const landed = (await (
      await fetch(`${mock.url}/v1/vector_stores/${store.id}/files/${failedId}`)
    ).json()) as { status: string; last_error: { code: string } | null };
    expect(landed.status).toBe("failed");
    expect(landed.last_error?.code).toBe("mock_ingest_failed");

    const batchFailed = (await (
      await postJson(
        `${mock.url}/v1/vector_stores/${store.id}/file_batches`,
        { file_ids: [await uploadFile(mock.url, "g.txt", "ggg")] },
        { "X-AIMock-Vector-Outcome": "cancelled" },
      )
    ).json()) as { id: string; status: string };
    await fetch(`${mock.url}/v1/vector_stores/${store.id}/file_batches/${batchFailed.id}`);
    const batchLanded = (await (
      await fetch(`${mock.url}/v1/vector_stores/${store.id}/file_batches/${batchFailed.id}`)
    ).json()) as { status: string };
    expect(batchLanded.status).toBe("cancelled");
  });

  it("preserves the uploaded filename in SDK vector search results", async () => {
    const client = new OpenAI({ apiKey: "mock", baseURL: `${mock.url}/v1` });
    const uploaded = await client.files.create({
      file: await toFile(Buffer.from("original document"), "original-name.txt"),
      purpose: "assistants",
    });
    expect(uploaded.filename).toBe("original-name.txt");
    const store = await client.vectorStores.create({});
    const attached = await client.vectorStores.files.createAndPoll(
      store.id,
      {
        file_id: uploaded.id,
      },
      { pollIntervalMs: 1 },
    );
    expect(attached.status).toBe("completed");
    const results = await client.vectorStores.search(store.id, { query: "original" });
    expect(results.data).toHaveLength(1);
    expect(results.data[0].file_id).toBe(uploaded.id);
    expect(results.data[0].filename).toBe("original-name.txt");
  });

  it("searches completed files deterministically with top-k and thresholds", async () => {
    const store = (await (await postJson(`${mock.url}/v1/vector_stores`, {})).json()) as {
      id: string;
    };
    // Empty store searches cleanly with no results.
    const empty = (await (
      await postJson(`${mock.url}/v1/vector_stores/${store.id}/search`, { query: "hello" })
    ).json()) as { object: string; data: unknown[] };
    expect(empty.object).toBe("vector_store.search_results_page");
    expect(empty.data).toEqual([]);

    const a = await uploadFile(mock.url, "a.txt", "aaa");
    const b = await uploadFile(mock.url, "b.txt", "bbb");
    await postJson(`${mock.url}/v1/vector_stores/${store.id}/files`, { file_id: a });
    await postJson(`${mock.url}/v1/vector_stores/${store.id}/files`, { file_id: b });
    for (const fileId of [a, b]) {
      await fetch(`${mock.url}/v1/vector_stores/${store.id}/files/${fileId}`);
      await fetch(`${mock.url}/v1/vector_stores/${store.id}/files/${fileId}`);
    }

    const first = (await (
      await postJson(`${mock.url}/v1/vector_stores/${store.id}/search`, { query: "pricing" })
    ).json()) as { data: { file_id: string; score: number; content: { text: string }[] }[] };
    expect(first.data).toHaveLength(2);
    const second = (await (
      await postJson(`${mock.url}/v1/vector_stores/${store.id}/search`, { query: "pricing" })
    ).json()) as { data: { file_id: string }[] };
    // Deterministic ranking: same query, same order.
    expect(second.data.map((d) => d.file_id)).toEqual(first.data.map((d) => d.file_id));
    expect(first.data[0].content[0].text).toContain("pricing");

    const topOne = (await (
      await postJson(`${mock.url}/v1/vector_stores/${store.id}/search`, {
        query: "pricing",
        max_num_results: 1,
      })
    ).json()) as { data: unknown[] };
    expect(topOne.data).toHaveLength(1);

    // Choose a cutoff above the lowest observed score so ignoring it must fail.
    const threshold = (Math.min(...first.data.map((d) => d.score)) + 1) / 2;
    const eligible = first.data
      .filter((d) => d.score >= threshold)
      .map(({ file_id, score }) => ({ file_id, score }));
    expect(eligible.length).toBeLessThan(first.data.length);
    const strict = (await (
      await postJson(`${mock.url}/v1/vector_stores/${store.id}/search`, {
        query: "pricing",
        ranking_options: { score_threshold: threshold },
      })
    ).json()) as { data: { file_id: string; score: number }[] };
    expect(strict.data.map(({ file_id, score }) => ({ file_id, score }))).toEqual(eligible);

    expect((await postJson(`${mock.url}/v1/vector_stores/${store.id}/search`, {})).status).toBe(
      400,
    );
    expect(
      (
        await postJson(`${mock.url}/v1/vector_stores/${store.id}/search`, {
          query: "x",
          max_num_results: 99,
        })
      ).status,
    ).toBe(400);
    expect(
      (await postJson(`${mock.url}/v1/vector_stores/vs_nope/search`, { query: "x" })).status,
    ).toBe(404);
  });

  it.each(["store-create", "file-attach", "batch-create"])(
    "%s resolves auto chunking to the SDK response union",
    async (endpoint) => {
      const client = new OpenAI({ apiKey: "test", baseURL: `${mock.url}/v1` });
      const file = await client.files.create({
        file: await toFile(Buffer.from("auto chunking content"), "auto.txt"),
        purpose: "assistants",
      });
      const chunking_strategy = { type: "auto" } as const;
      const expected = {
        type: "static",
        static: { max_chunk_size_tokens: 800, chunk_overlap_tokens: 400 },
      } satisfies FileChunkingStrategy;
      const store = await client.vectorStores.create(
        endpoint === "store-create" ? { file_ids: [file.id], chunking_strategy } : {},
      );
      if (endpoint === "file-attach") {
        const response = await client.vectorStores.files
          .create(store.id, { file_id: file.id, chunking_strategy })
          .asResponse();
        const wire = await response.json();
        expect(wire.chunking_strategy).toEqual(expected);
      } else if (endpoint === "batch-create") {
        const batch = await client.vectorStores.fileBatches.create(store.id, {
          file_ids: [file.id],
          chunking_strategy,
        });
        const batchFiles = await client.vectorStores.fileBatches.listFiles(store.id, batch.id);
        expect(batchFiles.data[0].chunking_strategy).toEqual(expected);
      }
      const retrieved = await client.vectorStores.files.retrieve(store.id, file.id);
      expect(retrieved.chunking_strategy).toEqual(expected);
      const listed = await client.vectorStores.files.list(store.id);
      expect(listed.data[0].chunking_strategy).toEqual(expected);
    },
  );

  describe.each(["store-create", "file-attach", "batch-create"])(
    "%s static chunking boundaries",
    (endpoint) => {
      it.each([
        [800, 399, 200],
        [800, 400, 200],
        [4096, 2048, 200],
        [800, 401, 400],
        [4096, 2049, 400],
      ])("chunk size %i with overlap %i returns %i", async (size, overlap, status) => {
        const fileId = await uploadFile(mock.url, "chunk-boundary.txt", "file content");
        const chunking_strategy = {
          type: "static",
          static: { max_chunk_size_tokens: size, chunk_overlap_tokens: overlap },
        };
        let response: Response;
        if (endpoint === "store-create") {
          response = await postJson(`${mock.url}/v1/vector_stores`, {
            file_ids: [fileId],
            chunking_strategy,
          });
        } else {
          const created = await postJson(`${mock.url}/v1/vector_stores`, {});
          expect(created.status).toBe(200);
          const store = (await created.json()) as { id: string };
          response = await postJson(
            `${mock.url}/v1/vector_stores/${store.id}/${endpoint === "file-attach" ? "files" : "file_batches"}`,
            {
              ...(endpoint === "file-attach" ? { file_id: fileId } : { file_ids: [fileId] }),
              chunking_strategy,
            },
          );
        }
        expect(response.status).toBe(status);
      });
    },
  );

  it("accepts SDK query arrays with deterministic normalization and preserves string queries", async () => {
    const sdk = new OpenAI({ apiKey: "local", baseURL: `${mock.url}/v1`, maxRetries: 0 });
    const file = await sdk.files.create({
      file: await OpenAI.toFile(Buffer.from("one two"), "queries.txt"),
      purpose: "assistants",
    });
    const store = await sdk.vectorStores.create({ file_ids: [file.id] });
    await sdk.vectorStores.files.retrieve(store.id, file.id);
    expect((await sdk.vectorStores.files.retrieve(store.id, file.id)).status).toBe("completed");

    const query = ["one", "two"];
    const first = await sdk.vectorStores.search(store.id, { query });
    expect(first.data.map((hit) => hit.file_id)).toEqual([file.id]);
    const repeated = await sdk.vectorStores.search(store.id, { query });
    expect(repeated.data).toEqual(first.data);
    const normalized = await sdk.vectorStores.search(store.id, { query: "one\ntwo" });
    expect(normalized.data).toEqual(first.data);
    expect(first.data[0].content[0].text).toContain("one\ntwo");

    for (const query of ["one", ["one"], ["one", "two"]]) {
      const response = await postJson(`${mock.url}/v1/vector_stores/${store.id}/search`, { query });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ search_query: query });
    }
    const string = await sdk.vectorStores.search(store.id, { query: "one" });
    const singleton = await sdk.vectorStores.search(store.id, { query: ["one"] });
    expect(singleton.data).toEqual(string.data);

    for (const query of [[], [""], ["one", 1], null, ""]) {
      const response = await postJson(`${mock.url}/v1/vector_stores/${store.id}/search`, { query });
      expect(response.status).toBe(400);
    }
  });

  it("validates bodies, metadata, expires_after, chunking and pagination", async () => {
    expect((await postJson(`${mock.url}/v1/vector_stores`, "nope")).status).toBe(400);
    expect((await postJson(`${mock.url}/v1/vector_stores`, { name: 42 })).status).toBe(400);
    expect(
      (
        await postJson(`${mock.url}/v1/vector_stores`, {
          metadata: { ["k".repeat(65)]: "v" },
        })
      ).status,
    ).toBe(400);
    expect(
      (await postJson(`${mock.url}/v1/vector_stores`, { expires_after: { anchor: "x", days: 7 } }))
        .status,
    ).toBe(400);
    expect(
      (
        await postJson(`${mock.url}/v1/vector_stores`, {
          expires_after: { anchor: "last_active_at", days: 0 },
        })
      ).status,
    ).toBe(400);
    expect(
      (await postJson(`${mock.url}/v1/vector_stores`, { chunking_strategy: { type: "weird" } }))
        .status,
    ).toBe(400);
    expect(
      (
        await postJson(`${mock.url}/v1/vector_stores`, {
          chunking_strategy: {
            type: "static",
            static: { max_chunk_size_tokens: 50, chunk_overlap_tokens: 10 },
          },
        })
      ).status,
    ).toBe(400);

    const ok = (await (await postJson(`${mock.url}/v1/vector_stores`, {})).json()) as {
      id: string;
    };
    expect((await postJson(`${mock.url}/v1/vector_stores/${ok.id}`, { name: 42 })).status).toBe(
      400,
    );

    expect((await fetch(`${mock.url}/v1/vector_stores?limit=0`)).status).toBe(400);
    expect((await fetch(`${mock.url}/v1/vector_stores?limit=101`)).status).toBe(400);
    expect((await fetch(`${mock.url}/v1/vector_stores?order=sideways`)).status).toBe(400);
    expect((await fetch(`${mock.url}/v1/vector_stores?after=nope`)).status).toBe(400);
    expect(
      (await fetch(`${mock.url}/v1/vector_stores?after=${ok.id}&before=${ok.id}`)).status,
    ).toBe(400);
    expect((await fetch(`${mock.url}/v1/vector_stores/${ok.id}/files?filter=bogus`)).status).toBe(
      400,
    );

    // Pagination walks newest-first with cursors.
    const second = (await (await postJson(`${mock.url}/v1/vector_stores`, {})).json()) as {
      id: string;
    };
    const page = (await (await fetch(`${mock.url}/v1/vector_stores?limit=1`)).json()) as {
      data: { id: string }[];
      first_id: string;
      last_id: string;
      has_more: boolean;
    };
    expect(page.data).toHaveLength(1);
    expect(page.data[0].id).toBe(second.id);
    expect(page.has_more).toBe(true);
    const next = (await (
      await fetch(`${mock.url}/v1/vector_stores?limit=1&after=${page.last_id}`)
    ).json()) as { data: { id: string }[] };
    expect(next.data.map((d) => d.id)).toContain(ok.id);
    const asc = (await (await fetch(`${mock.url}/v1/vector_stores?order=asc`)).json()) as {
      data: { id: string }[];
    };
    expect(asc.data[0].id).toBe(ok.id);
  });

  it.each([
    ["retrieve", 0],
    ["search", 1],
    ["attach", 1],
  ] as const)("does not revive an expired store through %s", async (operation, secondsPast) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    try {
      const fileId = await uploadFile(mock.url, "expiry.txt", "expiry proof");
      const created: VectorStoreObject = await (
        await postJson(`${mock.url}/v1/vector_stores`, {
          expires_after: { anchor: "last_active_at", days: 1 },
        })
      ).json();
      expect(created.expires_at).toBe(1_800_086_400);
      clock.mockReturnValue((1_800_086_400 + secondsPast) * 1000);
      const before: { data: VectorStoreObject[] } = await (
        await fetch(`${mock.url}/v1/vector_stores`)
      ).json();
      expect(before.data[0].status).toBe("expired");
      const url = `${mock.url}/v1/vector_stores/${created.id}`;
      const response =
        operation === "retrieve"
          ? await fetch(url)
          : operation === "search"
            ? await postJson(`${url}/search`, { query: "expiry" })
            : await postJson(`${url}/files`, { file_id: fileId });
      expect(response.status).toBe(200);
      const after: { data: VectorStoreObject[] } = await (
        await fetch(`${mock.url}/v1/vector_stores`)
      ).json();
      expect(after.data[0]).toMatchObject({
        status: "expired",
        expires_at: created.expires_at,
        last_active_at: created.last_active_at,
      });
    } finally {
      clock.mockRestore();
    }
  });

  it.each(["detach", "attach", "poll"] as const)(
    "refreshes expired store summaries after %s",
    async (operation) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
      try {
        const client = new OpenAI({ apiKey: "mock", baseURL: `${mock.url}/v1`, maxRetries: 0 });
        const fileId = await uploadFile(mock.url, "expired-summary.txt", "hello");
        const store = await client.vectorStores.create({
          expires_after: { anchor: "last_active_at", days: 1 },
        });
        if (operation !== "attach") {
          await client.vectorStores.files.create(store.id, { file_id: fileId });
          if (operation === "detach") {
            await client.vectorStores.files.retrieve(store.id, fileId);
            await client.vectorStores.files.retrieve(store.id, fileId);
          }
        }
        const before = await client.vectorStores.retrieve(store.id);
        clock.mockReturnValue(1_800_086_401_000);
        expect((await client.vectorStores.retrieve(store.id)).status).toBe("expired");

        if (operation === "detach") {
          expect((await client.vectorStores.files.del(store.id, fileId)).deleted).toBe(true);
        } else if (operation === "attach") {
          expect(
            (await client.vectorStores.files.create(store.id, { file_id: fileId })).status,
          ).toBe("in_progress");
        } else {
          await client.vectorStores.files.retrieve(store.id, fileId);
          expect((await client.vectorStores.files.retrieve(store.id, fileId)).status).toBe(
            "completed",
          );
        }
        const after = await client.vectorStores.retrieve(store.id);
        expect(after).toMatchObject({
          status: "expired",
          expires_at: before.expires_at,
          last_active_at: before.last_active_at,
          usage_bytes: operation === "poll" ? 5 : 0,
          file_counts: {
            in_progress: operation === "attach" ? 1 : 0,
            completed: operation === "poll" ? 1 : 0,
            failed: 0,
            cancelled: 0,
            total: operation === "detach" ? 0 : 1,
          },
        });
        const files = await client.vectorStores.files.list(store.id);
        expect(files.data).toHaveLength(after.file_counts.total);
      } finally {
        clock.mockRestore();
      }
    },
  );

  it("renews active stores and applies explicit expiry policy changes", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    try {
      const created: VectorStoreObject = await (
        await postJson(`${mock.url}/v1/vector_stores`, {
          expires_after: { anchor: "last_active_at", days: 1 },
        })
      ).json();
      const url = `${mock.url}/v1/vector_stores/${created.id}`;
      clock.mockReturnValue(1_800_003_600_000);
      const touched: VectorStoreObject = await (await fetch(url)).json();
      expect(touched).toMatchObject({
        status: "completed",
        last_active_at: 1_800_003_600,
        expires_at: 1_800_090_000,
      });
      const modified: VectorStoreObject = await (
        await postJson(url, { expires_after: { anchor: "last_active_at", days: 2 } })
      ).json();
      expect(modified.expires_at).toBe(1_800_176_400);
      const cleared: VectorStoreObject = await (
        await postJson(url, { expires_after: null })
      ).json();
      expect(cleared.expires_at).toBeNull();
      expect(cleared.status).toBe("completed");
    } finally {
      clock.mockRestore();
    }
  });

  it("supports expires_after stamping and clearing", async () => {
    const created = (await (
      await postJson(`${mock.url}/v1/vector_stores`, {
        expires_after: { anchor: "last_active_at", days: 7 },
      })
    ).json()) as { id: string; expires_at: number; created_at: number };
    expect(created.expires_at).toBeGreaterThan(created.created_at);
    const cleared = (await (
      await postJson(`${mock.url}/v1/vector_stores/${created.id}`, { expires_after: null })
    ).json()) as { expires_at: null };
    expect(cleared.expires_at).toBeNull();
  });

  it("journals vector-stores traffic and resets clean", async () => {
    const created = (await (await postJson(`${mock.url}/v1/vector_stores`, {})).json()) as {
      id: string;
    };
    const journal = (await (
      await fetch(`${mock.url}/__aimock/journal?service=vector-stores`)
    ).json()) as { service: string; response: { status: number } }[];
    expect(journal.length).toBeGreaterThan(0);
    expect(journal.every((e) => e.service === "vector-stores")).toBe(true);

    const reset = await fetch(`${mock.url}/__aimock/reset`, { method: "POST" });
    expect(reset.status).toBe(200);
    expect((await fetch(`${mock.url}/v1/vector_stores/${created.id}`)).status).toBe(404);
    const list = (await (await fetch(`${mock.url}/v1/vector_stores`)).json()) as {
      data: unknown[];
    };
    expect(list.data).toEqual([]);
  });

  it("reports bounded canonical metrics for vector-store subcollections over HTTP", async () => {
    await mock.stop();
    mock = new LLMock({ port: 0, metrics: true });
    await mock.start();
    const fileId = await uploadFile(mock.url, "metrics.txt", "metrics content");
    const created = (await (await postJson(`${mock.url}/v1/vector_stores`, {})).json()) as {
      id: string;
    };
    const storePath = `/v1/vector_stores/${created.id}`;
    const cells = [
      { method: "GET", suffix: "files", body: undefined },
      { method: "POST", suffix: "files", body: { file_id: fileId } },
      { method: "POST", suffix: "file_batches", body: { file_ids: [fileId] } },
    ];
    for (const cell of cells) {
      const url = `${mock.url}${storePath}/${cell.suffix}`;
      const response = cell.method === "GET" ? await fetch(url) : await postJson(url, cell.body);
      expect(response.status).toBe(200);
      await response.text();
    }
    const malformed = await fetch(`${mock.url}${storePath}/files/extra/depth`);
    expect(malformed.status).toBe(404);
    await malformed.text();
    const metrics = await (await fetch(`${mock.url}/metrics`)).text();
    for (const { method, suffix } of cells) {
      expect
        .soft(metrics)
        .toContain(
          `aimock_requests_total{method="${method}",path="/v1/vector_stores/{id}/${suffix}",status="200"} 1`,
        );
    }
    expect(metrics).toContain(
      'aimock_requests_total{method="GET",path="/v1/vector_stores/{other}",status="404"} 1',
    );
    expect(metrics).not.toContain(created.id);
    expect(metrics).not.toContain(fileId);
  });

  it("labels vector-stores paths for metrics without cardinality leaks", () => {
    expect(normalizePathLabel("/v1/vector_stores")).toBe("/v1/vector_stores");
    expect(normalizePathLabel("/v1/vector_stores/vs_abc")).toBe("/v1/vector_stores/{id}");
    expect(normalizePathLabel("/v1/vector_stores/vs_abc/files/vsf_xyz")).toBe(
      "/v1/vector_stores/{id}/files/{fileId}",
    );
    expect(normalizePathLabel("/v1/vector_stores/vs_abc/file_batches/vsfb_xyz")).toBe(
      "/v1/vector_stores/{id}/file_batches/{batchId}",
    );
    expect(normalizePathLabel("/v1/vector_stores/vs_abc/file_batches/vsfb_xyz/cancel")).toBe(
      "/v1/vector_stores/{id}/file_batches/{batchId}/cancel",
    );
    expect(normalizePathLabel("/v1/vector_stores/vs_abc/file_batches/vsfb_xyz/files")).toBe(
      "/v1/vector_stores/{id}/file_batches/{batchId}/files",
    );
    expect(normalizePathLabel("/v1/vector_stores/vs_abc/search")).toBe(
      "/v1/vector_stores/{id}/search",
    );
  });
});
