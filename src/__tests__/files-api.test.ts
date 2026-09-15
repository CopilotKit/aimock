import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LLMock } from "../llmock.js";
import { clearFileStore } from "../files.js";
import { normalizePathLabel } from "../metrics.js";

async function httpJson(url: string, method: string, body?: unknown): Promise<Response> {
  return fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("Files API mock", () => {
  let mock: LLMock;

  beforeEach(async () => {
    clearFileStore();
    mock = new LLMock({ port: 0 });
    await mock.start();
  });

  afterEach(async () => {
    await mock.stop();
    clearFileStore();
  });

  it("creates a file via JSON and lists it", async () => {
    const create = await httpJson(`${mock.url}/v1/files`, "POST", {
      filename: "train.jsonl",
      purpose: "fine-tune",
      content: '{"prompt":"hi"}\n',
    });
    expect(create.status).toBe(200);
    const obj = (await create.json()) as {
      id: string;
      object: string;
      filename: string;
      purpose: string;
      status: string;
      bytes: number;
    };
    expect(obj.object).toBe("file");
    expect(obj.id.startsWith("file-")).toBe(true);
    expect(obj.filename).toBe("train.jsonl");
    expect(obj.purpose).toBe("fine-tune");
    expect(obj.bytes).toBeGreaterThan(0);

    const list = await fetch(`${mock.url}/v1/files`);
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { object: string; data: { id: string }[] };
    expect(listed.object).toBe("list");
    expect(listed.data.map((d) => d.id)).toContain(obj.id);
  });

  it("retrieves, serves content, filters by purpose, and deletes", async () => {
    const a = (await (
      await httpJson(`${mock.url}/v1/files`, "POST", {
        filename: "a.jsonl",
        purpose: "batch",
        content: "a-content",
      })
    ).json()) as { id: string };
    const b = (await (
      await httpJson(`${mock.url}/v1/files`, "POST", {
        filename: "b.jsonl",
        purpose: "assistants",
        content: "b-content",
      })
    ).json()) as { id: string };

    const get = await fetch(`${mock.url}/v1/files/${a.id}`);
    expect(get.status).toBe(200);
    expect(((await get.json()) as { filename: string }).filename).toBe("a.jsonl");

    const content = await fetch(`${mock.url}/v1/files/${a.id}/content`);
    expect(content.status).toBe(200);
    expect(await content.text()).toBe("a-content");

    const filtered = (await (await fetch(`${mock.url}/v1/files?purpose=batch`)).json()) as {
      data: { id: string }[];
    };
    expect(filtered.data.map((d) => d.id)).toContain(a.id);
    expect(filtered.data.map((d) => d.id)).not.toContain(b.id);

    const del = await fetch(`${mock.url}/v1/files/${a.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(((await del.json()) as { deleted: boolean }).deleted).toBe(true);

    expect((await fetch(`${mock.url}/v1/files/${a.id}`)).status).toBe(404);
    expect(
      (await fetch(`${mock.url}/v1/files/${a.id}/content`).then((r) => r.status)).valueOf(),
    ).toBe(404);
  });

  it("rejects invalid purpose, missing filename, and malformed JSON with 400", async () => {
    const badPurpose = await httpJson(`${mock.url}/v1/files`, "POST", {
      filename: "x.jsonl",
      purpose: "nope",
      content: "hi",
    });
    expect(badPurpose.status).toBe(400);

    const missingName = await httpJson(`${mock.url}/v1/files`, "POST", {
      purpose: "batch",
      content: "hi",
    });
    expect(missingName.status).toBe(400);

    const malformed = await fetch(`${mock.url}/v1/files`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(malformed.status).toBe(400);

    const missing = await fetch(`${mock.url}/v1/files/file-does-not-exist`);
    expect(missing.status).toBe(404);
  });

  it("accepts multipart uploads with purpose + file fields", async () => {
    const boundary = "----aimocktestboundary";
    const raw =
      `--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nbatch\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="mp.jsonl"\r\nContent-Type: text/plain\r\n\r\nmp-bytes\r\n` +
      `--${boundary}--\r\n`;
    const res = await fetch(`${mock.url}/v1/files`, {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body: raw,
    });
    expect(res.status).toBe(200);
    const obj = (await res.json()) as { filename: string; purpose: string; id: string };
    expect(obj.filename).toBe("mp.jsonl");
    expect(obj.purpose).toBe("batch");

    const content = await fetch(`${mock.url}/v1/files/${obj.id}/content`);
    expect(await content.text()).toBe("mp-bytes");
  });

  it("journals files traffic under service=files and clears on reset", async () => {
    await httpJson(`${mock.url}/v1/files`, "POST", {
      filename: "j.jsonl",
      purpose: "vision",
      content: "j",
    });
    const journal = (await (await fetch(`${mock.url}/__aimock/journal?service=files`)).json()) as {
      path: string;
    }[];
    expect(journal.length).toBeGreaterThan(0);
    expect(journal.every((e) => e.path.includes("/v1/files"))).toBe(true);

    await fetch(`${mock.url}/__aimock/reset`, { method: "POST" });
    const list = (await (await fetch(`${mock.url}/v1/files`)).json()) as { data: unknown[] };
    expect(list.data).toEqual([]);
  });

  it("normalizes files paths for metrics labels", () => {
    expect(normalizePathLabel("/v1/files")).toBe("/v1/files");
    expect(normalizePathLabel("/v1/files/file-abc123")).toBe("/v1/files/{id}");
    expect(normalizePathLabel("/v1/files/file-abc123/content")).toBe("/v1/files/{id}/content");
  });
});
