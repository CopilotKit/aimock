import { createHash } from "node:crypto";
import http from "node:http";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { LLMock } from "../llmock.js";
import {
  clearFileStore,
  getFileStoreSize,
  FILES_BODY_MAX_BYTES,
  FILES_MAX_BYTES,
  FILE_CREATE_PURPOSES,
  FILES_LIST_DEFAULT_LIMIT,
  FILES_LIST_MAX_LIMIT,
  FILES_MAX_FILENAME_BYTES,
  getStoredFileBytes,
  handleFilesContent,
  handleFilesCreate,
  handleFilesRetrieve,
} from "../files.js";
import { Journal } from "../journal.js";
import { Logger } from "../logger.js";
import { normalizePathLabel, FILES_ID_RE, FILES_CONTENT_RE } from "../metrics.js";

/** A real 70-byte 1x1 PNG — invalid UTF-8, so a utf8 round-trip mangles it. */
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

const CRLF_BYTES = Buffer.from("\r\n");

const sha256 = (b: Buffer | Uint8Array): string =>
  createHash("sha256").update(Buffer.from(b)).digest("hex");

/** Build a multipart body as raw bytes so binary content survives the wire. */
function multipartBody(
  purpose: string,
  filename: string,
  content: Buffer,
  partContentType: string,
): { body: Buffer; contentType: string } {
  const boundary = "----aimockfilesboundary";
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\n${purpose}\r\n`,
    ),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: ${partContentType}\r\n\r\n`,
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

/**
 * A JSON-bodied `POST` — the only request shape in this file that carries a
 * JSON `Content-Type`. `GET` and `DELETE` are issued with a bare `fetch` so
 * they stay shaped like what a real SDK sends.
 */
async function postJson(url: string, body?: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
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
    const create = await postJson(`${mock.url}/v1/files`, {
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
      await postJson(`${mock.url}/v1/files`, {
        filename: "a.jsonl",
        purpose: "batch",
        content: "a-content",
      })
    ).json()) as { id: string };
    const b = (await (
      await postJson(`${mock.url}/v1/files`, {
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
    expect((await fetch(`${mock.url}/v1/files/${a.id}/content`)).status).toBe(404);
  });

  it("rejects invalid purpose, missing filename, and malformed JSON with 400", async () => {
    const badPurpose = await postJson(`${mock.url}/v1/files`, {
      filename: "x.jsonl",
      purpose: "nope",
      content: "hi",
    });
    expect(badPurpose.status).toBe(400);

    const missingName = await postJson(`${mock.url}/v1/files`, {
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
    expect(content.status).toBe(200);
    expect(await content.text()).toBe("mp-bytes");
  });

  it("derives a filename-less multipart part's name from its bytes, not the clock", async () => {
    const boundary = "----aimocknofilename";
    // A `file` part with NO `filename=` in its Content-Disposition. The
    // openai-openapi `CreateFileRequest` never requires one, so this is legal
    // input and the mock must synthesize a name — deterministically, because
    // determinism is what tests assert on.
    const upload = async (bytes: string): Promise<string> => {
      const raw =
        `--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nbatch\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="file"\r\nContent-Type: text/plain\r\n\r\n${bytes}\r\n` +
        `--${boundary}--\r\n`;
      const res = await fetch(`${mock.url}/v1/files`, {
        method: "POST",
        headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
        body: raw,
      });
      expect(res.status).toBe(200);
      return ((await res.json()) as { filename: string }).filename;
    };

    const first = await upload("same-bytes");
    const second = await upload("same-bytes");
    // Identical uploads agree. Under the old `Date.now()` fallback these two
    // differed whenever a millisecond elapsed between them.
    expect(second).toBe(first);
    // And the name is a pure function of the content, reproducible out-of-band
    // (not merely self-consistent within one process).
    expect(first).toBe(`upload-${sha256(Buffer.from("same-bytes", "utf8")).slice(0, 24)}.bin`);

    // Different bytes must not collide.
    const other = await upload("other-bytes");
    expect(other).not.toBe(first);

    // The name does not depend on store state, so a reset does not change it.
    clearFileStore();
    expect(await upload("same-bytes")).toBe(first);
  });

  it("journals files traffic under service=files and clears on reset", async () => {
    await postJson(`${mock.url}/v1/files`, {
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
    // Reset clears the journal as well as the store — asserted BEFORE the list
    // call below, which would otherwise journal a fresh entry of its own.
    const clearedJournal = (await (
      await fetch(`${mock.url}/__aimock/journal?service=files`)
    ).json()) as unknown[];
    expect(clearedJournal).toEqual([]);
    const list = (await (await fetch(`${mock.url}/v1/files`)).json()) as { data: unknown[] };
    expect(list.data).toEqual([]);
  });

  // ─── Regression: service tag on chaos-faulted paths ─────────────────────
  //
  // The chaos gate journals its own entry and short-circuits, so every files
  // route used to record its fault WITHOUT `service: "files"` — a faulted
  // request fell out of `?service=files` entirely while the unfiltered journal
  // still showed it.
  it.each(["dropRate", "malformedRate", "rateLimitRate"])(
    "tags every chaos-faulted files route with service=files under %s",
    async (mode) => {
      const testId = `files-journal-${mode}`;
      const headers = { "X-Test-Id": testId };
      const seeded = (await (
        await postJson(`${mock.url}/v1/files`, {
          filename: "seed.txt",
          purpose: "batch",
          content: "seed",
        })
      ).json()) as { id: string };

      await fetch(`${mock.url}/__aimock/chaos`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ [mode]: 1 }),
      });

      const routes: (() => Promise<Response>)[] = [
        () =>
          fetch(`${mock.url}/v1/files`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...headers },
            body: JSON.stringify({ filename: "z.txt", purpose: "batch", content: "z" }),
          }),
        () => fetch(`${mock.url}/v1/files`, { headers }),
        () => fetch(`${mock.url}/v1/files/${seeded.id}`, { headers }),
        () => fetch(`${mock.url}/v1/files/${seeded.id}/content`, { headers }),
        () => fetch(`${mock.url}/v1/files/${seeded.id}`, { method: "DELETE", headers }),
      ];
      for (const call of routes) await call();

      type Entry = { path: string; service?: string; response: { chaosAction?: string } };
      const query = async (qs: string): Promise<Entry[]> =>
        (await (await fetch(`${mock.url}/__aimock/journal?${qs}`)).json()) as Entry[];

      const unfiltered = (await query(`testId=${testId}`)).filter((e) =>
        e.path.includes("/v1/files"),
      );
      const tagged = (await query(`service=files&testId=${testId}`)).filter((e) =>
        e.path.includes("/v1/files"),
      );

      // All five routes faulted...
      expect(unfiltered.length).toBe(5);
      expect(unfiltered.every((e) => e.response.chaosAction !== undefined)).toBe(true);
      // ...and all five are still selectable by the documented service filter.
      expect(tagged.length).toBe(5);
    },
  );

  it("normalizes files paths for metrics labels", () => {
    expect(normalizePathLabel("/v1/files")).toBe("/v1/files");
    expect(normalizePathLabel("/v1/files/file-abc123")).toBe("/v1/files/{id}");
    expect(normalizePathLabel("/v1/files/file-abc123/content")).toBe("/v1/files/{id}/content");
  });

  // ─── Regression: upload purpose allowlist ───────────────────────────────
  //
  // `CreateFileRequest.purpose` in openai/openai-openapi is
  // assistants | batch | fine-tune | vision | user_data | evals. The mock
  // originally used the RESPONSE enum, which rejected `user_data` — the value
  // Responses-API file inputs send — and wrongly accepted the three
  // server-minted output purposes.
  it.each(["user_data", "evals", "assistants", "batch", "fine-tune", "vision"])(
    "accepts create purpose %s on the JSON path",
    async (purpose) => {
      const res = await postJson(`${mock.url}/v1/files`, {
        filename: "p.txt",
        purpose,
        content: "hi",
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { purpose: string }).purpose).toBe(purpose);
    },
  );

  it.each(["user_data", "evals"])(
    "accepts create purpose %s on the multipart path",
    async (purpose) => {
      const { body, contentType } = multipartBody(
        purpose,
        "p.txt",
        Buffer.from("hi"),
        "text/plain",
      );
      const res = await fetch(`${mock.url}/v1/files`, {
        method: "POST",
        headers: { "Content-Type": contentType },
        body: new Uint8Array(body),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { purpose: string }).purpose).toBe(purpose);
    },
  );

  it.each(["assistants_output", "batch_output", "fine-tune-results"])(
    "rejects response-only purpose %s on create",
    async (purpose) => {
      const res = await postJson(`${mock.url}/v1/files`, {
        filename: "p.txt",
        purpose,
        content: "hi",
      });
      expect(res.status).toBe(400);
      const err = (await res.json()) as { error: { message: string } };
      expect(err.error.message).toContain(`Invalid purpose '${purpose}'`);
      // The advertised list is the CREATE enum, not the response enum.
      const advertised = err.error.message.split("Expected one of: ")[1] ?? "";
      expect(advertised.split(", ").sort()).toEqual([...FILE_CREATE_PURPOSES].sort());
    },
  );

  // ─── Regression: the list `purpose` filter is free-form ─────────────────
  //
  // `RESPONSE_PURPOSES` used to advertise that it governed this filter while
  // being enforced nowhere. The real API does not validate the query parameter
  // at all: `listFiles` declares `purpose` as a bare `type: string` with no
  // `enum` in `openai/openai-openapi` (unlike `order`), and openai@4.104.0
  // types it `purpose?: string` on `FileListParams`. So an unrecognised value
  // must return an empty list with a 200, not a 400. These lock that in.
  it("returns an empty list, not a 400, for an unrecognised list purpose", async () => {
    const created = await postJson(`${mock.url}/v1/files`, {
      filename: "t.jsonl",
      purpose: "fine-tune",
      content: "{}",
    });
    expect(created.status).toBe(200);

    const res = await fetch(`${mock.url}/v1/files?purpose=bogus`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      object: "list",
      data: [],
      has_more: false,
      first_id: null,
      last_id: null,
    });
  });

  // The store is seeded first, so the empty `data` is the filter excluding a
  // real file rather than there being nothing to exclude. A filter that were
  // ignored would return the seeded file and fail here.
  it("accepts response-only purposes on the list filter and returns an empty list", async () => {
    const seeded = await postJson(`${mock.url}/v1/files`, {
      filename: "seeded.txt",
      purpose: "user_data",
      content: "hi",
    });
    expect(seeded.status).toBe(200);
    const seededId = ((await seeded.json()) as { id: string }).id;

    // Control: with no filter the seeded file IS listed, so the empty results
    // below are attributable to the filter and not to an empty store.
    const unfiltered = (await (await fetch(`${mock.url}/v1/files`)).json()) as {
      data: { id: string }[];
    };
    expect(unfiltered.data.map((f) => f.id)).toContain(seededId);

    for (const purpose of ["assistants_output", "batch_output", "fine-tune-results"]) {
      const res = await fetch(`${mock.url}/v1/files?purpose=${encodeURIComponent(purpose)}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        object: "list",
        data: [],
        has_more: false,
        first_id: null,
        last_id: null,
      });
    }
  });

  it("still filters correctly for a purpose that does match", async () => {
    await postJson(`${mock.url}/v1/files`, {
      filename: "ft.jsonl",
      purpose: "fine-tune",
      content: "{}",
    });
    await postJson(`${mock.url}/v1/files`, {
      filename: "ud.txt",
      purpose: "user_data",
      content: "hi",
    });
    const res = await fetch(`${mock.url}/v1/files?purpose=fine-tune`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { filename: string; purpose: string }[] };
    expect(body.data.map((f) => f.purpose)).toEqual(["fine-tune"]);
    expect(body.data.map((f) => f.filename)).toEqual(["ft.jsonl"]);
  });

  // ─── Regression: binary round-trip ──────────────────────────────────────
  //
  // The body used to be decoded as utf8 end-to-end, so a PNG came back longer
  // than it went in with every invalid sequence replaced by U+FFFD.
  it("round-trips binary uploads byte-for-byte", async () => {
    const { body, contentType } = multipartBody("user_data", "pixel.png", PNG_BYTES, "image/png");
    const res = await fetch(`${mock.url}/v1/files`, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: new Uint8Array(body),
    });
    expect(res.status).toBe(200);
    const obj = (await res.json()) as { id: string; bytes: number };
    expect(obj.bytes).toBe(PNG_BYTES.length);

    const content = await fetch(`${mock.url}/v1/files/${obj.id}/content`);
    expect(content.status).toBe(200);
    expect(content.headers.get("content-type")).toBe("image/png");
    const got = Buffer.from(await content.arrayBuffer());
    expect(got.length).toBe(PNG_BYTES.length);
    expect(sha256(got)).toBe(sha256(PNG_BYTES));
    expect(got.equals(PNG_BYTES)).toBe(true);
    // The utf8 replacement character is the fingerprint of the old corruption.
    expect(got.includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(false);
  });

  // ─── Regression: part content encodings ─────────────────────────────────
  //
  // The parser never looked at `Content-Transfer-Encoding`, so a part that
  // declared `base64` had its *encoded text* stored as the file's octets:
  // `bytes` reported the encoded length and `GET /content` served base64 back.
  // No mainstream client emits the header (RFC 7578 §4.7 deprecates it), so
  // the contract is "verbatim storage, loud 400 for anything else" rather than
  // a decoder nobody would exercise. These pin both halves.
  describe("multipart part content encodings", () => {
    /** Same shape as `multipartBody`, plus arbitrary extra file-part headers. */
    function bodyWithPartHeaders(
      extraHeaders: string,
      content: Buffer,
    ): { body: Buffer; contentType: string } {
      const boundary = "----aimockctebound";
      const body = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nuser_data\r\n`,
        ),
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="pixel.png"\r\n` +
            `Content-Type: image/png\r\n${extraHeaders}\r\n`,
        ),
        content,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      return { body, contentType: `multipart/form-data; boundary=${boundary}` };
    }

    // `POST /v1/files` answers with exactly one of these two shapes, so the
    // helper says so and the readers below narrow it. Typing the body as an
    // empty record and re-casting at each use site would let a change to the
    // error envelope pass `tsc` unnoticed.
    type UploadResponse =
      | { error: { message: string; type: string } }
      | { id: string; bytes: number };

    const upload = async (
      extraHeaders: string,
      content: Buffer,
    ): Promise<{ status: number; body: UploadResponse }> => {
      const { body, contentType } = bodyWithPartHeaders(extraHeaders, content);
      const res = await fetch(`${mock.url}/v1/files`, {
        method: "POST",
        headers: { "Content-Type": contentType },
        body: new Uint8Array(body),
      });
      return { status: res.status, body: (await res.json()) as UploadResponse };
    };

    const errorIn = (body: UploadResponse): { message: string; type: string } => {
      if (!("error" in body)) throw new Error(`expected an error envelope, got ${body.id}`);
      return body.error;
    };

    const fileIn = (body: UploadResponse): { id: string; bytes: number } => {
      if ("error" in body) throw new Error(`expected a file object, got ${body.error.message}`);
      return body;
    };

    it("rejects a base64 Content-Transfer-Encoding part instead of storing the encoded text", async () => {
      const encoded = Buffer.from(PNG_BYTES.toString("base64"), "ascii");
      // The pre-fix bug: the encoded form is a different length to the file.
      expect(encoded.length).not.toBe(PNG_BYTES.length);

      const { status, body } = await upload("Content-Transfer-Encoding: base64\r\n", encoded);
      expect(status).toBe(400);
      const message = errorIn(body);
      expect(message.type).toBe("invalid_request_error");
      // The error must name the offending header and its value.
      expect(message.message).toContain("Content-Transfer-Encoding");
      expect(message.message).toContain("base64");
    });

    it.each(["quoted-printable", "x-uuencode", "BASE64"])(
      "rejects the non-identity Content-Transfer-Encoding %s",
      async (cte) => {
        const { status, body } = await upload(
          `Content-Transfer-Encoding: ${cte}\r\n`,
          Buffer.from("payload"),
        );
        expect(status).toBe(400);
        expect(errorIn(body).message).toContain("Content-Transfer-Encoding");
      },
    );

    it("rejects a non-identity Content-Encoding on the file part", async () => {
      const { status, body } = await upload("Content-Encoding: gzip\r\n", Buffer.from("payload"));
      expect(status).toBe(400);
      const message = errorIn(body).message;
      expect(message).toContain("Content-Encoding");
      expect(message).toContain("gzip");
      // Only Content-Transfer-Encoding carries the RFC 7578 §4.7 deprecation.
      expect(message).not.toContain("RFC 7578");
    });

    /** Upload the PNG behind `partHeaders` and assert it came back octet-exact. */
    const expectStoredVerbatim = async (partHeaders: string): Promise<void> => {
      const { status, body } = await upload(partHeaders, PNG_BYTES);
      expect(status).toBe(200);
      const obj = fileIn(body);
      expect(obj.bytes).toBe(PNG_BYTES.length);
      const got = Buffer.from(
        await (await fetch(`${mock.url}/v1/files/${obj.id}/content`)).arrayBuffer(),
      );
      expect(sha256(got)).toBe(sha256(PNG_BYTES));
    };

    // Identity encodings are no-ops (RFC 2045 §6.2) — Apache HttpClient's
    // STRICT multipart mode emits `binary`, so these must keep working and
    // must still round-trip the file's octets exactly.
    it.each(["7bit", "8bit", "binary", "Binary"])(
      "stores a part declaring Content-Transfer-Encoding: %s verbatim",
      async (cte) => {
        await expectStoredVerbatim(`Content-Transfer-Encoding: ${cte}\r\n`);
      },
    );

    // A separate header with its own identity value, so a failure names the
    // header under test rather than reading as a Content-Transfer-Encoding.
    it("stores a part declaring Content-Encoding: identity verbatim", async () => {
      await expectStoredVerbatim("Content-Encoding: identity\r\n");
    });

    // Control: no encoding headers at all still round-trips hash-identically.
    it("stores a part with no encoding headers verbatim", async () => {
      await expectStoredVerbatim("");
    });
  });

  it("serves text uploads with a content type derived from the filename", async () => {
    const created = (await (
      await postJson(`${mock.url}/v1/files`, {
        filename: "notes.txt",
        purpose: "user_data",
        content: "plain text",
      })
    ).json()) as { id: string; bytes: number };
    expect(created.bytes).toBe(10);
    const content = await fetch(`${mock.url}/v1/files/${created.id}/content`);
    expect(content.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await content.text()).toBe("plain text");
  });

  // ─── Regression: the client-declared part type must not be echoed back ───
  //
  // The stored part header used to drive the response Content-Type verbatim,
  // so an upload declaring `text/html` was served as `text/html` from the
  // mock's own origin (stored XSS), and a real SDK PNG — whose part header is
  // always `application/octet-stream` — was served as opaque bytes.
  it("ignores the client-declared part Content-Type and uses the filename", async () => {
    const payload = Buffer.from("<script>alert(1)</script>", "utf8");
    const { body, contentType } = multipartBody("user_data", "note.txt", payload, "text/html");
    const res = await fetch(`${mock.url}/v1/files`, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: new Uint8Array(body),
    });
    const obj = (await res.json()) as { id: string };

    const content = await fetch(`${mock.url}/v1/files/${obj.id}/content`);
    expect(content.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(content.headers.get("x-content-type-options")).toBe("nosniff");
    const got = Buffer.from(await content.arrayBuffer());
    expect(sha256(got)).toBe(sha256(payload));
  });

  it("serves an octet-stream-declared PNG upload as image/png", async () => {
    const { body, contentType } = multipartBody(
      "user_data",
      "pixel.png",
      PNG_BYTES,
      "application/octet-stream",
    );
    const res = await fetch(`${mock.url}/v1/files`, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: new Uint8Array(body),
    });
    const obj = (await res.json()) as { id: string };

    const content = await fetch(`${mock.url}/v1/files/${obj.id}/content`);
    expect(content.headers.get("content-type")).toBe("image/png");
    expect(content.headers.get("x-content-type-options")).toBe("nosniff");
    const got = Buffer.from(await content.arrayBuffer());
    expect(sha256(got)).toBe(sha256(PNG_BYTES));
  });

  it("never serves an upload as active content, even for a .html filename", async () => {
    const payload = Buffer.from("<script>alert(1)</script>", "utf8");
    const { body, contentType } = multipartBody("user_data", "page.html", payload, "text/html");
    const res = await fetch(`${mock.url}/v1/files`, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: new Uint8Array(body),
    });
    const obj = (await res.json()) as { id: string };

    const content = await fetch(`${mock.url}/v1/files/${obj.id}/content`);
    expect(content.headers.get("content-type")).toBe("application/octet-stream");
    expect(content.headers.get("x-content-type-options")).toBe("nosniff");
    const got = Buffer.from(await content.arrayBuffer());
    expect(sha256(got)).toBe(sha256(payload));
  });

  // ─── Regression: CORS on chaos-faulted paths ────────────────────────────
  //
  // applyChaos short-circuits the response, so retrieve/content/delete used to
  // emit their fault with zero Access-Control-* headers and a browser saw a
  // CORS error instead of the fault the chaos suite injected.
  //
  // The fault outcome is asserted on every route ALONGSIDE the header, so the
  // test cannot pass on a normal 200: with chaos off, the status/body
  // assertions fail first. The pre-chaos control call below makes that
  // contrast visible inside the test itself.
  it.each([
    ["dropRate", "drop", 500],
    ["malformedRate", "malformed", 200],
  ] as const)(
    "faults every files route under %s and keeps CORS on the fault",
    async (mode, action, faultStatus) => {
      const testId = `files-cors-${mode}`;
      const headers = { "X-Test-Id": testId };
      // Seeded untagged, so the seed itself is never faulted by this scope.
      const seeded = (await (
        await postJson(`${mock.url}/v1/files`, {
          filename: "seed.txt",
          purpose: "batch",
          content: "seed",
        })
      ).json()) as { id: string };

      // Control: chaos off on this same route and testId → the normal status.
      const control = await fetch(`${mock.url}/v1/files/${seeded.id}`, { headers });
      expect(control.status).toBe(200);
      expect(control.headers.get("access-control-allow-origin")).toBe("*");

      await fetch(`${mock.url}/__aimock/chaos`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ [mode]: 1 }),
      });

      const routes: [string, string, string, () => Promise<Response>][] = [
        [
          "create",
          "POST",
          "/v1/files",
          () =>
            fetch(`${mock.url}/v1/files`, {
              method: "POST",
              headers: { "Content-Type": "application/json", ...headers },
              body: JSON.stringify({ filename: "z.txt", purpose: "batch", content: "z" }),
            }),
        ],
        ["list", "GET", "/v1/files", () => fetch(`${mock.url}/v1/files`, { headers })],
        [
          "retrieve",
          "GET",
          `/v1/files/${seeded.id}`,
          () => fetch(`${mock.url}/v1/files/${seeded.id}`, { headers }),
        ],
        [
          "content",
          "GET",
          `/v1/files/${seeded.id}/content`,
          () => fetch(`${mock.url}/v1/files/${seeded.id}/content`, { headers }),
        ],
        [
          "delete",
          "DELETE",
          `/v1/files/${seeded.id}`,
          () => fetch(`${mock.url}/v1/files/${seeded.id}`, { method: "DELETE", headers }),
        ],
      ];

      for (const [name, , , call] of routes) {
        const res = await call();
        // The fault actually fired — the exact wire shape applyChaosAction emits.
        expect({ route: name, status: res.status }, `${name} did not fault under ${mode}`).toEqual({
          route: name,
          status: faultStatus,
        });
        const text = await res.text();
        if (action === "drop") {
          expect(JSON.parse(text), `${name} body is not the drop error`).toMatchObject({
            error: { code: "chaos_drop", type: "server_error" },
          });
        } else {
          expect(text, `${name} body is not the malformed payload`).toBe(
            "{malformed json: <<<chaos>>>",
          );
        }
        // ...and the browser can still read it.
        expect(
          { route: name, origin: res.headers.get("access-control-allow-origin") },
          `${name} lost CORS under ${mode}`,
        ).toEqual({ route: name, origin: "*" });
      }

      // The fault is observable in the journal too, not only in the headers.
      type FaultEntry = { method: string; path: string; response: { chaosAction?: string } };
      const journalled = (
        (await (
          await fetch(`${mock.url}/__aimock/journal?testId=${testId}`)
        ).json()) as FaultEntry[]
      ).filter((e) => e.path.includes("/v1/files"));
      const faulted = journalled.filter((e) => e.response.chaosAction !== undefined);
      expect(faulted.length).toBe(routes.length);
      for (const [name, method, path] of routes) {
        expect(
          faulted.some(
            (e) => e.method === method && e.path === path && e.response.chaosAction === action,
          ),
          `${name} has no ${action} journal entry`,
        ).toBe(true);
      }
    },
  );
  // ─── The over-cap 400, just above the cap ───────────────────────────────
  //
  // An over-cap upload is answered with a 400 envelope and the full CORS
  // header set at every wire size. These pin the near side of that; the far
  // side (escape-heavy JSON, a multipart body megabytes past the cap, and a
  // body past the buffering bound) is pinned in "Files API upload size
  // limits" at the end of this file, which also asserts the buffering bound
  // that makes the guarantee unconditional.
  it("rejects an over-cap JSON upload with a 400 envelope and CORS", async () => {
    const res = await fetch(`${mock.url}/v1/files`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://example.test" },
      body: JSON.stringify({
        filename: "huge.txt",
        purpose: "assistants",
        content: "a".repeat(FILES_MAX_BYTES + 1024),
      }),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await res.json()) as { error: { message: string; type: string } };
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain(`exceeds ${FILES_MAX_BYTES} byte cap`);
  });

  it("rejects an over-cap multipart upload with a 400 envelope and CORS", async () => {
    const { body, contentType } = multipartBody(
      "assistants",
      "huge.bin",
      Buffer.alloc(FILES_MAX_BYTES + 1024, 0x61),
      "application/octet-stream",
    );
    const res = await fetch(`${mock.url}/v1/files`, {
      method: "POST",
      headers: { "Content-Type": contentType, Origin: "http://example.test" },
      body: new Uint8Array(body),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const parsed = (await res.json()) as { error: { message: string; type: string } };
    expect(parsed.error.type).toBe("invalid_request_error");
    expect(parsed.error.message).toContain(`exceeds ${FILES_MAX_BYTES} byte cap`);
  });

  it("accepts an exactly-at-cap multipart upload", async () => {
    const content = Buffer.alloc(FILES_MAX_BYTES, 0x62);
    const { body, contentType } = multipartBody(
      "assistants",
      "at-cap.bin",
      content,
      "application/octet-stream",
    );
    const res = await fetch(`${mock.url}/v1/files`, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: new Uint8Array(body),
    });
    expect(res.status).toBe(200);
    const created = (await res.json()) as { id: string; bytes: number };
    expect(created.bytes).toBe(FILES_MAX_BYTES);
    const back = await fetch(`${mock.url}/v1/files/${created.id}/content`);
    expect(sha256(Buffer.from(await back.arrayBuffer()))).toBe(sha256(content));
  });
  // ─── Regression: malformed uploads must be rejected, never fabricated ───
  //
  // Both parsers used to accept garbage and invent data: a non-string JSON
  // `content` was `String()`-coerced (an object landed as the literal
  // "[object Object]"), a multipart body with no payload part produced a
  // 0-byte file under a `upload-<Date.now()>.bin` name, a multipart
  // Content-Type without a `boundary` silently threw the caller's bytes away,
  // and a body carrying both a `file` and a `content` part paired one part's
  // filename with the other part's bytes. All of them returned 200.

  const B = "----aimockrejectboundary";
  const mpPart = (headers: string, body: string): string =>
    `--${B}\r\n${headers}\r\n\r\n${body}\r\n`;
  const mpClose = `--${B}--\r\n`;
  const mpType = `multipart/form-data; boundary=${B}`;
  const purposePart = mpPart(`Content-Disposition: form-data; name="purpose"`, "batch");

  const postMultipart = (body: string, contentType: string = mpType): Promise<Response> =>
    fetch(`${mock.url}/v1/files`, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body,
    });

  const errorOf = async (res: Response): Promise<{ message: string; type: string }> =>
    ((await res.json()) as { error: { message: string; type: string } }).error;

  it.each([
    ["an object", { a: 1 }],
    ["an array", [1, 2]],
    ["a number", 42],
    ["a boolean", true],
    ["null", null],
  ])("rejects non-string JSON 'content' (%s) instead of coercing it", async (label, value) => {
    const res = await postJson(`${mock.url}/v1/files`, {
      filename: "x.txt",
      purpose: "batch",
      content: value,
    });
    expect(res.status).toBe(400);
    const err = await errorOf(res);
    expect(err.type).toBe("invalid_request_error");
    expect(err.message).toContain("'content'");
    expect(err.message).toContain(label);
    // Nothing was stored, and no coerced string exists to be served back.
    expect(getFileStoreSize()).toBe(0);
  });

  it("rejects a non-string 'bytes' alias and names 'bytes' in the message", async () => {
    const res = await postJson(`${mock.url}/v1/files`, {
      filename: "n.txt",
      purpose: "batch",
      bytes: 42,
    });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).message).toContain("'bytes'");
    expect(getFileStoreSize()).toBe(0);
  });

  it("rejects a body carrying both 'content' and its 'bytes' alias as ambiguous", async () => {
    const res = await postJson(`${mock.url}/v1/files`, {
      filename: "b.txt",
      purpose: "batch",
      content: "one",
      bytes: "two",
    });
    expect(res.status).toBe(400);
    const message = (await errorOf(res)).message;
    expect(message).toContain("'content'");
    expect(message).toContain("'bytes'");
    expect(getFileStoreSize()).toBe(0);
  });

  it("rejects a JSON body with neither 'content' nor 'bytes'", async () => {
    const res = await postJson(`${mock.url}/v1/files`, {
      filename: "e.txt",
      purpose: "batch",
    });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).message).toContain("'content'");
    expect(getFileStoreSize()).toBe(0);
  });

  it("accepts the 'bytes' alias on its own, exactly like 'content'", async () => {
    const res = await postJson(`${mock.url}/v1/files`, {
      filename: "a.txt",
      purpose: "batch",
      bytes: "aliased",
    });
    expect(res.status).toBe(200);
    const obj = (await res.json()) as { id: string; bytes: number };
    expect(obj.bytes).toBe(7);
    expect(await (await fetch(`${mock.url}/v1/files/${obj.id}/content`)).text()).toBe("aliased");
  });

  it("rejects a multipart body with no 'file' or 'content' part", async () => {
    const res = await postMultipart(purposePart + mpClose);
    expect(res.status).toBe(400);
    const err = await errorOf(res);
    expect(err.type).toBe("invalid_request_error");
    expect(err.message).toContain("'file'");
    // No fabricated `upload-<timestamp>.bin` 0-byte file was stored.
    expect(getFileStoreSize()).toBe(0);
  });

  it("rejects a multipart Content-Type with no boundary instead of eating the bytes", async () => {
    const body =
      purposePart +
      mpPart(`Content-Disposition: form-data; name="file"; filename="x.txt"`, "REAL-BYTES") +
      mpClose;
    const res = await postMultipart(body, "multipart/form-data");
    expect(res.status).toBe(400);
    expect((await errorOf(res)).message).toContain("boundary");
    expect(getFileStoreSize()).toBe(0);
  });

  it.each([
    ["a 'file' and a 'content' part", `Content-Disposition: form-data; name="content"`],
    ["two 'file' parts", `Content-Disposition: form-data; name="file"; filename="second.txt"`],
  ])("rejects a multipart body with %s", async (_label, secondPartHeaders) => {
    const body =
      purposePart +
      mpPart(
        `Content-Disposition: form-data; name="file"; filename="from-file.txt"`,
        "FILE-BYTES",
      ) +
      mpPart(secondPartHeaders, "OTHER-BYTES") +
      mpClose;
    const res = await postMultipart(body);
    expect(res.status).toBe(400);
    expect((await errorOf(res)).message).toContain("more than one payload part");
    expect(getFileStoreSize()).toBe(0);
  });

  it("still accepts a single 'content' part and a filename-less 'file' part", async () => {
    const single = await postMultipart(
      purposePart +
        mpPart(`Content-Disposition: form-data; name="content"; filename="c.txt"`, "content-only") +
        mpClose,
    );
    expect(single.status).toBe(200);
    const obj = (await single.json()) as { id: string; filename: string };
    expect(obj.filename).toBe("c.txt");
    expect(await (await fetch(`${mock.url}/v1/files/${obj.id}/content`)).text()).toBe(
      "content-only",
    );

    // A payload part with no `filename=` attribute is still legal, so the
    // deterministic `upload-<sha256-prefix>.bin` fallback stays reachable.
    const noName = await postMultipart(
      purposePart + mpPart(`Content-Disposition: form-data; name="file"`, "no-name") + mpClose,
    );
    expect(noName.status).toBe(200);
    expect(((await noName.json()) as { filename: string }).filename).toBe(
      `upload-${sha256(Buffer.from("no-name", "utf8")).slice(0, 24)}.bin`,
    );
  });

  it("keeps the valid JSON and single-file-part paths byte-identical", async () => {
    const text = "hello world";
    const created = (await (
      await postJson(`${mock.url}/v1/files`, {
        filename: "ok.txt",
        purpose: "batch",
        content: text,
      })
    ).json()) as { id: string; bytes: number };
    expect(created.bytes).toBe(Buffer.byteLength(text));
    const back = Buffer.from(
      await (await fetch(`${mock.url}/v1/files/${created.id}/content`)).arrayBuffer(),
    );
    expect(sha256(back)).toBe(sha256(Buffer.from(text, "utf8")));

    const { body, contentType } = multipartBody("batch", "pixel.png", PNG_BYTES, "image/png");
    const mp = await fetch(`${mock.url}/v1/files`, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: new Uint8Array(body),
    });
    expect(mp.status).toBe(200);
    const mpObj = (await mp.json()) as { id: string; bytes: number };
    expect(mpObj.bytes).toBe(PNG_BYTES.length);
    const mpBack = Buffer.from(
      await (await fetch(`${mock.url}/v1/files/${mpObj.id}/content`)).arrayBuffer(),
    );
    expect(sha256(mpBack)).toBe(sha256(PNG_BYTES));
  });
});

/**
 * `GET /v1/files` cursor paging. Shapes come from the vendored SDK
 * (openai 4.104.0 — `FileListParams extends CursorPageParams` in
 * `resources/files.d.ts` + `pagination.d.ts`) and the defaults from the
 * `openai/openai-openapi` spec's `listFiles`: `order` defaults to `desc`,
 * `limit` ranges 1..10,000 and defaults to 10,000, and `ListFilesResponse`
 * requires `first_id`, `last_id` and `has_more` alongside `data`.
 */
describe("Files API list paging", () => {
  let mock: LLMock;

  interface ListPage {
    object: string;
    data: { id: string; filename: string }[];
    first_id: string | null;
    last_id: string | null;
    has_more: boolean;
  }

  /** Upload in order; `created_at` ties are resolved by creation order. */
  async function seed(count: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 1; i <= count; i++) {
      const res = await postJson(`${mock.url}/v1/files`, {
        filename: `f${i}.jsonl`,
        purpose: "fine-tune",
        content: `f${i}`,
      });
      ids.push(((await res.json()) as { id: string }).id);
    }
    return ids;
  }

  const list = async (query = ""): Promise<ListPage> =>
    (await (await fetch(`${mock.url}/v1/files${query}`)).json()) as ListPage;

  beforeEach(async () => {
    clearFileStore();
    mock = new LLMock({ port: 0 });
    await mock.start();
  });

  afterEach(async () => {
    await mock.stop();
    clearFileStore();
  });

  it("defaults to newest-first and honours order=asc", async () => {
    await seed(4);
    expect((await list()).data.map((f) => f.filename)).toEqual([
      "f4.jsonl",
      "f3.jsonl",
      "f2.jsonl",
      "f1.jsonl",
    ]);
    expect((await list("?order=asc")).data.map((f) => f.filename)).toEqual([
      "f1.jsonl",
      "f2.jsonl",
      "f3.jsonl",
      "f4.jsonl",
    ]);
  });

  it("honours limit and reports has_more, first_id and last_id", async () => {
    const ids = await seed(4);
    const page = await list("?limit=1");
    expect(page.data.map((f) => f.filename)).toEqual(["f4.jsonl"]);
    expect(page.has_more).toBe(true);
    expect(page.first_id).toBe(ids[3]);
    expect(page.last_id).toBe(ids[3]);

    const whole = await list("?limit=4");
    expect(whole.data).toHaveLength(4);
    expect(whole.has_more).toBe(false);
  });

  it("returns has_more:false and null ids for an empty listing", async () => {
    await seed(2);
    const empty = await list("?purpose=vision");
    expect(empty.data).toEqual([]);
    expect(empty.has_more).toBe(false);
    expect(empty.first_id).toBeNull();
    expect(empty.last_id).toBeNull();
  });

  // The default page size is 10000, which no test can reach by uploading. So it
  // is pinned on two sides that together cannot both hold for a wrong default:
  // the constant itself, and the fact that the default does NOT truncate a
  // store an explicit small `limit` does truncate. A smaller default (say 4)
  // fails the first assertion; a default of 0 or a default that silently
  // clamped to the explicit limit fails the second.
  it("defaults limit to the documented maximum, so a small store comes back whole", async () => {
    expect(FILES_LIST_DEFAULT_LIMIT).toBe(FILES_LIST_MAX_LIMIT);
    expect(FILES_LIST_DEFAULT_LIMIT).toBe(10000);

    await seed(3);

    const truncated = await list("?limit=2");
    expect(truncated.data).toHaveLength(2);
    expect(truncated.has_more).toBe(true);

    const page = await list();
    expect(page.data).toHaveLength(3);
    expect(page.has_more).toBe(false);
  });

  it.each(["asc", "desc"] as const)(
    "walks the whole listing exactly once with an %s cursor",
    async (order) => {
      const ids = await seed(5);
      const seen: string[] = [];
      let after: string | null = null;
      let pages = 0;
      for (;;) {
        pages++;
        expect(pages, "cursor walk did not terminate").toBeLessThan(10);
        const page: ListPage = await list(
          `?limit=2&order=${order}` + (after === null ? "" : `&after=${after}`),
        );
        seen.push(...page.data.map((f) => f.id));
        if (!page.has_more) break;
        after = page.last_id;
      }
      expect(pages).toBe(3);
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).toEqual(order === "asc" ? ids : [...ids].reverse());
    },
  );

  it("rejects an unknown after cursor instead of silently restarting", async () => {
    await seed(2);
    const res = await fetch(`${mock.url}/v1/files?after=file-bogus`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain("after");
  });

  it("resolves the cursor against the filtered listing, not the whole store", async () => {
    await postJson(`${mock.url}/v1/files`, {
      filename: "b.jsonl",
      purpose: "batch",
      content: "b",
    });
    const tuned = (await (
      await postJson(`${mock.url}/v1/files`, {
        filename: "t.jsonl",
        purpose: "fine-tune",
        content: "t",
      })
    ).json()) as { id: string };
    const res = await fetch(`${mock.url}/v1/files?purpose=batch&after=${tuned.id}`);
    expect(res.status).toBe(400);
  });

  it.each([
    ["limit=0", "limit"],
    ["limit=abc", "limit"],
    ["limit=1.5", "limit"],
    ["limit=10001", "limit"],
    ["limit=", "limit"],
    ["order=sideways", "order"],
  ])("rejects %s with a 400 naming the parameter", async (query, param) => {
    await seed(1);
    const res = await fetch(`${mock.url}/v1/files?${query}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string; type: string } };
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain(param);
  });

  it("rejects an empty after= instead of treating it as no cursor", async () => {
    await seed(2);
    const res = await fetch(`${mock.url}/v1/files?after=`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("after");
  });
});

// ─── Regression: the multipart parser itself ──────────────────────────────
//
// The parser used to be a `raw.split("--" + boundary)` plus a handful of
// regexes run against the whole header block. Every case below was a silent
// wrong answer or a 400 about the wrong thing, observed over real HTTP:
//
// - a payload containing the boundary token was truncated at it and stored
//   short, with a 200 — the byte-for-byte contract broken invisibly
// - a part using bare LF separators was skipped, so a body that did send
//   `purpose` was refused with "multipart 'purpose' field is required"
// - two `purpose` parts silently last-won
// - `filename="…"` was matched across the whole header block, so a CRLF inside
//   the parameter smuggled the next header line into the stored filename
// - an empty `Content-Transfer-Encoding:` captured the following header line,
//   producing "Unsupported Content-Transfer-Encoding: 'content-type: image/png'"
// - `identity` was rejected although it is the no-op value
// - encodings were only checked on the payload part, so an encoded `purpose`
//   part 400'd with `Invalid purpose 'YXNz…'`
// - `filename*=` (RFC 5987) was ignored, and a whitespace-only filename stored
//
// `Response.formData()` (undici) was evaluated as the platform replacement and
// rejected — see the `parseMultipartUpload` doc comment for the three checks it
// fails. The two byte-fidelity ones are pinned here as tests.
describe("Files API multipart parsing", () => {
  let mock: LLMock;
  const BOUNDARY = "----aimockparserbound";
  const CT = `multipart/form-data; boundary=${BOUNDARY}`;

  const cat = (...pieces: (string | Buffer)[]): Buffer =>
    Buffer.concat(pieces.map((p) => (typeof p === "string" ? Buffer.from(p, "latin1") : p)));

  const post = async (body: Buffer, contentType: string = CT): Promise<Response> =>
    fetch(`${mock.url}/v1/files`, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: new Uint8Array(body),
    });

  const upload = async (
    body: Buffer,
    contentType: string = CT,
  ): Promise<{ status: number; json: { id?: string; filename?: string; bytes?: number } }> => {
    const res = await post(body, contentType);
    return { status: res.status, json: (await res.json()) as { id?: string } };
  };

  const errorMessage = async (body: Buffer, contentType: string = CT): Promise<string> => {
    const res = await post(body, contentType);
    expect(res.status).toBe(400);
    return ((await res.json()) as { error: { message: string } }).error.message;
  };

  const fetchContent = async (id: string): Promise<Buffer> =>
    Buffer.from(await (await fetch(`${mock.url}/v1/files/${id}/content`)).arrayBuffer());

  const purposePart = (value = "assistants"): string =>
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\n${value}\r\n`;

  const filePart = (params: string, content: Buffer | string, headers = ""): Buffer =>
    cat(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"${params}\r\n${headers}\r\n`,
      content,
      `\r\n--${BOUNDARY}--\r\n`,
    );

  beforeEach(async () => {
    clearFileStore();
    mock = new LLMock({ port: 0 });
    await mock.start();
  });

  afterEach(async () => {
    await mock.stop();
    clearFileStore();
  });

  // A delimiter is CRLF + "--" + boundary + (CRLF | "--"). A payload that
  // merely *contains* those bytes is still the file's content, so it must come
  // back with the length and the hash it went in with.
  it.each([
    ["the CRLF-prefixed delimiter token", cat(`AA\r\n--${BOUNDARY}BB`)],
    ["a bare --boundary with no preceding CRLF", cat(`AA--${BOUNDARY}BB ÿ`)],
    ["a CRLF-- sequence that is not the boundary", cat("AA\r\n--XYZ\r\nBB ÿ")],
  ])("stores a payload containing %s byte-for-byte", async (_label, payload) => {
    const { status, json } = await upload(
      cat(purposePart(), filePart('; filename="p.bin"', payload)),
    );
    expect(status).toBe(200);
    expect(json.bytes).toBe(payload.length);
    const got = await fetchContent(json.id as string);
    expect(got.length).toBe(payload.length);
    expect(sha256(got)).toBe(sha256(payload));
  });

  // The byte-fidelity half of the undici evaluation: a payload part with no
  // `filename` parameter comes back from `Response.formData()` as a UTF-8
  // *string*, which destroys binary octets. It stays byte-exact here.
  it("keeps a filename-less binary payload part byte-exact and names it deterministically", async () => {
    const payload = Buffer.from([0x00, 0xff, 0xfe, 0x41, 0x80, 0x81, 0xc3, 0x28]);
    const { status, json } = await upload(cat(purposePart(), filePart("", payload)));
    expect(status).toBe(200);
    const got = await fetchContent(json.id as string);
    expect(sha256(got)).toBe(sha256(payload));
    // The utf8 replacement character is the fingerprint of the lossy path.
    expect(got.includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(false);
    expect(json.filename).toMatch(/^upload-[0-9a-f]{24}\.bin$/);
  });

  it("names the malformed part instead of blaming a purpose that was sent", async () => {
    const body = cat(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="purpose"\n\nassistants\r\n`,
      filePart('; filename="a.txt"', "hello"),
    );
    const message = await errorMessage(body);
    expect(message).toContain("malformed multipart part");
    expect(message).not.toContain("'purpose' field is required");
  });

  it.each([
    [
      "duplicate purpose parts",
      cat(purposePart("assistants"), purposePart("batch"), filePart('; filename="a.txt"', "x")),
      "more than one 'purpose' part",
    ],
    [
      "duplicate payload parts",
      cat(
        purposePart(),
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a"\r\n\r\nX\r\n`,
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="content"; filename="b"\r\n\r\nY\r\n`,
        `--${BOUNDARY}--\r\n`,
      ),
      "more than one payload part",
    ],
    [
      "a part with no Content-Disposition",
      cat(
        `--${BOUNDARY}\r\nContent-Type: text/plain\r\n\r\nstray\r\n`,
        purposePart(),
        `--${BOUNDARY}--\r\n`,
      ),
      "no Content-Disposition header",
    ],
    [
      "a part with no name parameter",
      cat(
        `--${BOUNDARY}\r\nContent-Disposition: form-data\r\n\r\nstray\r\n`,
        purposePart(),
        `--${BOUNDARY}--\r\n`,
      ),
      "no 'name' parameter",
    ],
    [
      "a body with no closing delimiter",
      cat(purposePart()),
      "ended before its closing boundary delimiter",
    ],
  ])("rejects %s", async (_label, body, fragment) => {
    expect(await errorMessage(body)).toContain(fragment);
  });

  // The filename parameter is parsed out of the Content-Disposition header
  // alone, so it cannot reach across the CRLF into the next header line.
  it("refuses a filename parameter carrying a CRLF instead of storing the injected header", async () => {
    const body = cat(purposePart(), filePart('; filename="a\r\nX-Evil: y.txt"', "hello"));
    const message = await errorMessage(body);
    expect(message).toContain("malformed Content-Disposition header");
    expect(message).not.toContain("X-Evil");
    expect(getFileStoreSize()).toBe(0);
  });

  it("rejects a filename containing a control character", async () => {
    const body = cat(purposePart(), filePart('; filename="a b.txt"', "hello"));
    expect(await errorMessage(body)).toContain("control characters");
  });

  it("treats a whitespace-only filename as absent and synthesizes one", async () => {
    const { status, json } = await upload(
      cat(purposePart(), filePart('; filename="   "', "hello")),
    );
    expect(status).toBe(200);
    expect(json.filename).toMatch(/^upload-[0-9a-f]{24}\.bin$/);
  });

  it("honours an RFC 5987 filename*= parameter", async () => {
    const { status, json } = await upload(
      cat(purposePart(), filePart("; filename*=UTF-8''na%C3%AFve.txt", "hello")),
    );
    expect(status).toBe(200);
    expect(json.filename).toBe("naïve.txt");
  });

  it("reads name and filename regardless of their order in the header", async () => {
    const body = cat(
      purposePart(),
      `--${BOUNDARY}\r\nContent-Type: text/plain\r\n` +
        `Content-Disposition: form-data; filename="ordered.txt"; name="file"\r\n\r\nhello\r\n`,
      `--${BOUNDARY}--\r\n`,
    );
    const { status, json } = await upload(body);
    expect(status).toBe(200);
    expect(json.filename).toBe("ordered.txt");
  });

  it.each(["Content-Transfer-Encoding:\r\n", "Content-Encoding:  \r\n"])(
    "treats an empty %s header as absent",
    async (header) => {
      const { status, json } = await upload(
        cat(
          purposePart(),
          filePart('; filename="pixel.png"', PNG_BYTES, `${header}Content-Type: image/png\r\n`),
        ),
      );
      expect(status).toBe(200);
      const got = await fetchContent(json.id as string);
      expect(sha256(got)).toBe(sha256(PNG_BYTES));
    },
  );

  it("names the part that declared an unsupported encoding, not the enum it broke", async () => {
    const body = cat(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="purpose"\r\n` +
        `Content-Transfer-Encoding: base64\r\n\r\nYXNzaXN0YW50cw==\r\n`,
      filePart('; filename="a.txt"', "hello"),
    );
    const message = await errorMessage(body);
    expect(message).toContain("Content-Transfer-Encoding");
    expect(message).toContain("'purpose' part");
    expect(message).not.toContain("Invalid purpose");
  });

  it("ignores the preamble and the epilogue", async () => {
    const body = cat(
      "preamble text\r\n",
      purposePart(),
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n\r\nhello\r\n`,
      `--${BOUNDARY}--\r\nepilogue text\r\n`,
    );
    const { status, json } = await upload(body);
    expect(status).toBe(200);
    expect(json.bytes).toBe(5);
  });

  it("tolerates transport padding after the boundary", async () => {
    const body = cat(
      `--${BOUNDARY} \t\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nassistants\r\n`,
      filePart('; filename="a.txt"', "hello"),
    );
    expect((await upload(body)).status).toBe(200);
  });

  // `isMultipartFormData` compares the media type's essence, so a parameter
  // that merely mentions the token no longer misroutes a JSON body into the
  // multipart parser (which answered with a bogus "missing boundary" 400).
  it("routes on the media type essence, not a substring of the header", async () => {
    const res = await fetch(`${mock.url}/v1/files`, {
      method: "POST",
      headers: { "Content-Type": 'application/json; note="multipart/form-data"' },
      body: JSON.stringify({ filename: "j.txt", purpose: "assistants", content: "hi" }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { filename: string }).filename).toBe("j.txt");
  });
});

// ─── Regression (F12): over-size is a 400 at EVERY wire size ──────────────
//
// The over-cap 400 used to hold only inside a fixed slice of headroom above
// the content cap. Outside it the transport limit fired first and destroyed
// the socket: the caller got an ECONNRESET with no status, no envelope and no
// CORS headers — the very failure the cap branches exist to avoid. A JSON body
// reaches that cliff at once, because `content` is escaped on the wire and a
// single escaped character costs up to six bytes; a multipart body reaches it
// as soon as it is further over the cap than the headroom is wide.
describe("Files API upload size limits", () => {
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

  // The bound that makes "over-cap is always a 400" true rather than
  // approximately true: six wire bytes is the most a single byte of decoded
  // content can cost (a `\uXXXX` escape carrying an ASCII code point), so a
  // body that could still decode to a within-cap payload always fits.
  it("buffers enough for any body that could still decode within the cap", () => {
    expect(FILES_BODY_MAX_BYTES).toBeGreaterThanOrEqual(FILES_MAX_BYTES * 6);
  });

  it("answers an escape-heavy over-cap JSON upload with a 400, not a dropped socket", async () => {
    // Every character here escapes to two wire bytes, so the body is twice its
    // content and lands well outside any fixed headroom above the cap.
    const content = "\n".repeat(FILES_MAX_BYTES + 1);
    const res = await fetch(`${mock.url}/v1/files`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://example.test" },
      body: JSON.stringify({ filename: "ctl.jsonl", purpose: "assistants", content }),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await res.json()) as { error: { message: string; type: string } };
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain(`exceeds ${FILES_MAX_BYTES} byte cap`);
  });

  it("answers a multipart body far past the cap with a 400, not a dropped socket", async () => {
    const { body, contentType } = multipartBody(
      "assistants",
      "way-over.bin",
      Buffer.alloc(FILES_MAX_BYTES + 1024 * 1024 + 1, 0x61),
      "application/octet-stream",
    );
    const res = await fetch(`${mock.url}/v1/files`, {
      method: "POST",
      headers: { "Content-Type": contentType, Origin: "http://example.test" },
      body: new Uint8Array(body),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const parsed = (await res.json()) as { error: { message: string; type: string } };
    expect(parsed.error.message).toContain(`exceeds ${FILES_MAX_BYTES} byte cap`);
  });

  // Past the buffering bound the bytes are dropped rather than kept, so peak
  // memory stays at the bound — but the request is still drained to `end` so
  // the caller gets a real status instead of a reset socket.
  it("answers a body past the buffering bound with a 400 naming the limit", async () => {
    const { body, contentType } = multipartBody(
      "assistants",
      "unbufferable.bin",
      Buffer.alloc(FILES_BODY_MAX_BYTES + 1024, 0x61),
      "application/octet-stream",
    );
    const res = await fetch(`${mock.url}/v1/files`, {
      method: "POST",
      headers: { "Content-Type": contentType, Origin: "http://example.test" },
      body: new Uint8Array(body),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const parsed = (await res.json()) as { error: { message: string; type: string } };
    expect(parsed.error.type).toBe("invalid_request_error");
    expect(parsed.error.message).toContain(`${FILES_BODY_MAX_BYTES} byte upload limit`);
  });
});

/**
 * F13: every files journal entry used to hard-code `body: null`, so an upload
 * could not be asserted from the journal at all. Uploads now carry the same
 * kind of SYNTHETIC descriptor the transcription route journals for its
 * multipart audio — metadata only, never the uploaded octets.
 */
describe("Files API journal bodies", () => {
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

  const filesEntries = (): ReturnType<LLMock["getRequests"]> =>
    mock.getRequests().filter((e) => e.service === "files");

  const uploadMultipart = async (
    purpose: string,
    filename: string,
    content: Buffer,
    partContentType = "application/octet-stream",
  ): Promise<Response> => {
    const { body, contentType } = multipartBody(purpose, filename, content, partContentType);
    return fetch(`${mock.url}/v1/files`, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: new Uint8Array(body),
    });
  };

  it("journals a synthetic descriptor for a multipart upload", async () => {
    const res = await uploadMultipart("user_data", "pixel.png", PNG_BYTES, "image/png");
    expect(res.status).toBe(200);

    const entries = filesEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].service).toBe("files");
    expect(entries[0].body).toEqual({
      model: "",
      messages: [],
      _endpointType: "files",
      purpose: "user_data",
      filename: "pixel.png",
      bytes: PNG_BYTES.length,
      content_type: "image/png",
      sha256: sha256(PNG_BYTES),
    });
  });

  it("journals the same descriptor for a JSON upload, with the content replaced", async () => {
    const res = await postJson(`${mock.url}/v1/files`, {
      filename: "notes.jsonl",
      purpose: "batch",
      content: "hello-json",
    });
    expect(res.status).toBe(200);

    const body = filesEntries()[0].body as unknown as Record<string, unknown>;
    expect(body).toEqual({
      model: "",
      messages: [],
      _endpointType: "files",
      purpose: "batch",
      filename: "notes.jsonl",
      bytes: 10,
      content_type: "application/jsonl",
      sha256: sha256(Buffer.from("hello-json", "utf8")),
    });
    expect(body).not.toHaveProperty("content");
  });

  it("never journals the uploaded octets, in any encoding", async () => {
    await uploadMultipart("user_data", "pixel.png", PNG_BYTES, "image/png");
    await postJson(`${mock.url}/v1/files`, {
      filename: "notes.jsonl",
      purpose: "batch",
      content: "hello-json",
    });

    // Assert on the DECODED journal, not on a `JSON.stringify` dump of it: a
    // PNG's octets are control and high bytes, which `JSON.stringify` escapes,
    // so `dump.not.toContain(PNG_BYTES.toString("latin1"))` cannot fail however
    // much of the payload the journal carries. What can fail is the
    // descriptor's key set, and the octets decoded back out of the strings the
    // journal actually holds.
    const entries = filesEntries();
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      const body = entry.body as unknown as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual([
        "_endpointType",
        "bytes",
        "content_type",
        "filename",
        "messages",
        "model",
        "purpose",
        "sha256",
      ]);
      for (const value of Object.values(body)) {
        if (typeof value !== "string") continue;
        for (const encoding of ["latin1", "base64", "utf8"] as const) {
          expect(Buffer.from(value, encoding).includes(PNG_BYTES)).toBe(false);
        }
        expect(value).not.toContain("hello-json");
      }
    }

    const dump = JSON.stringify(entries);
    expect(dump.toLowerCase()).not.toContain(PNG_BYTES.subarray(0, 8).toString("hex"));
    // The descriptor itself IS there — this is not a vacuous "nothing matched".
    expect(dump).toContain(sha256(PNG_BYTES));
  });

  it("keeps body null on the bodyless files routes and on a rejected upload", async () => {
    const created = (await (
      await postJson(`${mock.url}/v1/files`, {
        filename: "a.jsonl",
        purpose: "batch",
        content: "a",
      })
    ).json()) as { id: string };

    await fetch(`${mock.url}/v1/files`);
    await fetch(`${mock.url}/v1/files/${created.id}`);
    await fetch(`${mock.url}/v1/files/${created.id}/content`);
    await fetch(`${mock.url}/v1/files/${created.id}`, { method: "DELETE" });
    // An upload rejected before it parsed has no payload to describe; its
    // entry carries the error envelope instead (F6), never the octets.
    const bad = await postJson(`${mock.url}/v1/files`, {
      filename: "b.jsonl",
      purpose: "nope",
      content: "b",
    });
    expect(bad.status).toBe(400);

    const entries = filesEntries();
    expect(entries).toHaveLength(6);
    // Entry 0 is the upload; the four bodyless routes follow; the rejection is last.
    expect(entries[0].body).not.toBeNull();
    for (const entry of entries.slice(1, 5)) {
      expect(entry.body, `${entry.method} ${entry.path} should journal a null body`).toBeNull();
    }
    expect(entries[5].body).toEqual(await bad.json());
    // F2: service stays on EVERY entry regardless of the body.
    for (const entry of entries) expect(entry.service).toBe("files");
  });
});

describe("Files API surface consistency", () => {
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

  const upload = async (filename: string, content: string, purpose = "batch"): Promise<string> => {
    const res = await postJson(`${mock.url}/v1/files`, { filename, purpose, content });
    expect(res.status).toBe(200);
    return ((await res.json()) as { id: string }).id;
  };

  describe("list limit is a strict decimal integer", () => {
    // Each of these is accepted by Number() as an in-range integer, so each one
    // used to page silently instead of 400ing. `0x10` is the loudest: it paged
    // 16 items.
    it.each(["0x10", "1e3", " 5", "5\n", "+5", "-5", "0b11", "5 ", "1_0", "Infinity", "0o20"])(
      "rejects limit=%j with a 400 that names the parameter",
      async (rawLimit) => {
        await upload("a.jsonl", "a");
        const res = await fetch(`${mock.url}/v1/files?limit=${encodeURIComponent(rawLimit)}`);
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { message: string; type: string } };
        expect(body.error.type).toBe("invalid_request_error");
        expect(body.error.message).toContain("limit");
      },
    );

    it("does not clamp an over-range limit to the maximum", async () => {
      await upload("a.jsonl", "a");
      const res = await fetch(`${mock.url}/v1/files?limit=10001`);
      expect(res.status).toBe(400);
    });

    it("still accepts a plain decimal limit", async () => {
      for (let i = 0; i < 3; i++) await upload(`p${i}.jsonl`, `p${i}`);
      const res = await fetch(`${mock.url}/v1/files?limit=2`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: unknown[]; has_more: boolean };
      expect(body.data).toHaveLength(2);
      expect(body.has_more).toBe(true);
    });

    it("accepts a leading-zero decimal limit", async () => {
      for (let i = 0; i < 3; i++) await upload(`z${i}.jsonl`, `z${i}`);
      const res = await fetch(`${mock.url}/v1/files?limit=02`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { data: unknown[] }).data).toHaveLength(2);
    });
  });

  describe("content route disposition", () => {
    it("serves every file as an attachment naming the stored file", async () => {
      const id = await upload("report.pdf", "%PDF-1.4 stub", "user_data");
      const res = await fetch(`${mock.url}/v1/files/${id}/content`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/pdf");
      expect(res.headers.get("content-disposition")).toBe('attachment; filename="report.pdf"');
      await res.arrayBuffer();
    });

    it("adds an RFC 5987 filename* for a non-ASCII name and never inlines it", async () => {
      const id = await upload("rapport-é.pdf", "%PDF-1.4 stub", "user_data");
      const res = await fetch(`${mock.url}/v1/files/${id}/content`);
      const disposition = res.headers.get("content-disposition") ?? "";
      expect(disposition.startsWith("attachment;")).toBe(true);
      // The ASCII fallback is lossy by design; filename* carries the real name.
      expect(disposition).toContain('filename="rapport-_.pdf"');
      expect(disposition).toContain("filename*=UTF-8''rapport-%C3%A9.pdf");
      await res.arrayBuffer();
    });

    // This used to assert the 200 that F17 was: a CRLF filename went in through
    // the JSON path, was stored verbatim, and the test then checked that the
    // *disposition* had been scrubbed. The scrubbing is real, but the upload
    // should never have been accepted — the multipart path 400s the same name —
    // so the injection payload is now checked at the door, and the escaping of
    // a name that IS legal is checked separately below.
    it("refuses a CRLF filename at upload instead of scrubbing it on the way out", async () => {
      const res = await postJson(`${mock.url}/v1/files`, {
        filename: 'ev"il\r\nX-Injected: yes.txt',
        purpose: "batch",
        content: "x",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string; type: string } };
      expect(body.error.type).toBe("invalid_request_error");
      expect(body.error.message).toContain("control characters");
      expect(getFileStoreSize()).toBe(0);
    });

    it("cannot be used to inject a response header via a filename that IS legal", async () => {
      // `"` and `\` are not control characters, so this name is storable — and
      // it is exactly the shape that would break out of the quoted-string.
      const id = await upload('ev"il\\x.txt', "x");
      const res = await fetch(`${mock.url}/v1/files/${id}/content`);
      const disposition = res.headers.get("content-disposition") ?? "";
      expect(res.headers.get("x-injected")).toBeNull();
      expect(disposition).not.toContain("\r");
      expect(disposition).not.toContain("\n");
      // Both `"` and `\` are backslash-escaped inside the quoted-string.
      expect(disposition).toBe('attachment; filename="ev\\"il\\\\x.txt"');
      await res.arrayBuffer();
    });
  });

  describe("JSON uploads must be encodable text", () => {
    it("rejects a lone surrogate instead of storing U+FFFD", async () => {
      const res = await postJson(`${mock.url}/v1/files`, {
        filename: "lone.txt",
        purpose: "batch",
        content: "a\uD800b",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string; type: string } };
      expect(body.error.type).toBe("invalid_request_error");
      expect(body.error.message).toContain("surrogate");
      expect(getFileStoreSize()).toBe(0);
    });

    it("rejects a lone surrogate sent through the 'bytes' alias too", async () => {
      const res = await postJson(`${mock.url}/v1/files`, {
        filename: "lone.txt",
        purpose: "batch",
        bytes: "\uDC00",
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
        "bytes",
      );
    });

    it("still accepts a well-formed surrogate pair byte-for-byte", async () => {
      const content = "emoji \u{1F600} ok";
      const id = await upload("emoji.txt", content);
      const res = await fetch(`${mock.url}/v1/files/${id}/content`);
      const got = Buffer.from(await res.arrayBuffer());
      expect(sha256(got)).toBe(sha256(Buffer.from(content, "utf8")));
    });

    // `Buffer.toString("utf8")` substitutes U+FFFD for an invalid sequence, so a
    // raw 0xFF inside `content` was stored as EF BF BD with a 200 — 7 bytes
    // served for 5 sent. The body is built from Buffers so the byte is really
    // on the wire rather than being escaped by JSON.stringify.
    it("rejects a body that is not valid UTF-8 instead of storing U+FFFD", async () => {
      const body = Buffer.concat([
        Buffer.from('{"filename":"bad.txt","purpose":"batch","content":"ab'),
        Buffer.from([0xff]),
        Buffer.from('cd"}'),
      ]);
      const res = await fetch(`${mock.url}/v1/files`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      expect(res.status).toBe(400);
      const err = (await res.json()) as { error: { message: string; type: string } };
      expect(err.error.type).toBe("invalid_request_error");
      expect(err.error.message).toContain("not valid UTF-8");
      expect(getFileStoreSize()).toBe(0);
    });

    it("still accepts valid multi-byte UTF-8 sent as raw bytes, byte-for-byte", async () => {
      const content = "h\u00e9llo \u{1F600}";
      const body = Buffer.from(
        JSON.stringify({ filename: "utf8.txt", purpose: "batch", content }),
        "utf8",
      );
      const res = await fetch(`${mock.url}/v1/files`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      expect(res.status).toBe(200);
      const { id, bytes } = (await res.json()) as { id: string; bytes: number };
      const expected = Buffer.from(content, "utf8");
      expect(bytes).toBe(expected.length);
      const got = Buffer.from(
        await (await fetch(`${mock.url}/v1/files/${id}/content`)).arrayBuffer(),
      );
      expect(got.equals(expected)).toBe(true);
    });
  });

  describe("route regexes are single-sourced", () => {
    // server.ts dispatches on the same objects metrics.ts labels with, so a
    // divergence cannot reappear: there is only one of each.
    it("matches the dispatch paths the metrics labeller normalizes", () => {
      const id = "file-abc123";
      expect(FILES_ID_RE.exec(`/v1/files/${id}`)?.[1]).toBe(id);
      expect(FILES_CONTENT_RE.exec(`/v1/files/${id}/content`)?.[1]).toBe(id);
      expect(FILES_ID_RE.test(`/v1/files/${id}/content`)).toBe(false);
      expect(normalizePathLabel(`/v1/files/${id}`)).toBe("/v1/files/{id}");
      expect(normalizePathLabel(`/v1/files/${id}/content`)).toBe("/v1/files/{id}/content");
    });
  });

  describe("method handling follows the server-wide 404 convention", () => {
    // Pinned deliberately: the files routes are method-guarded and everything
    // else 404s, exactly like every other surface in this server. The controls
    // are the point — if a future change introduces 405 + Allow, it has to do
    // it server-wide, and this test is where that decision gets revisited.
    it("404s an unhandled method on a files path, and on the controls too", async () => {
      const id = await upload("a.jsonl", "a");
      const cases: [string, string][] = [
        [`${mock.url}/v1/files`, "HEAD"],
        [`${mock.url}/v1/files/${id}`, "PATCH"],
        [`${mock.url}/health`, "HEAD"],
        [`${mock.url}/v1/models`, "PATCH"],
      ];
      for (const [url, method] of cases) {
        const res = await fetch(url, { method });
        expect(res.status, `${method} ${url}`).toBe(404);
        await res.arrayBuffer();
      }
    });
  });
});

// ─── Regression: ambiguity in a part's headers and header parameters ───────
//
// The parser walked one header value correctly but resolved every *repetition*
// by last-one-wins, which defeats the rejection contracts above rather than
// supporting them. All of these were observed over real HTTP against a live
// server before the fix:
//
// - `Content-Transfer-Encoding: base64` followed by `: 7bit` passed the
//   encoding check and stored the base64 TEXT as the file's octets (200, four
//   bytes of `aGk=`) — the exact mis-storage that check exists to prevent
// - `filename="a.txt"; filename="b.png"` on one header stored `b.png`, so a
//   text upload came back from `GET /content` as `image/png`
// - a decoy `boundary=` inside another Content-Type parameter's quoted string
//   was read as THE boundary, so a valid body 400'd as having no delimiter
// - `Content-Disposition: attachment` — not a form part at all (RFC 7578 §4.2
//   requires `form-data`) — uploaded a file
// - `filename*=UTF-8''%FF%FE.txt` stored U+FFFD with a 200, while every other
//   malformed parameter got a 400
describe("Files API multipart header ambiguity", () => {
  let mock: LLMock;
  const BOUNDARY = "----aimockheaderbound";
  const CT = `multipart/form-data; boundary=${BOUNDARY}`;

  const cat = (...pieces: (string | Buffer)[]): Buffer =>
    Buffer.concat(pieces.map((p) => (typeof p === "string" ? Buffer.from(p, "latin1") : p)));

  const post = async (body: Buffer, contentType: string = CT): Promise<Response> =>
    fetch(`${mock.url}/v1/files`, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: new Uint8Array(body),
    });

  const errorMessage = async (body: Buffer, contentType: string = CT): Promise<string> => {
    const res = await post(body, contentType);
    expect(res.status).toBe(400);
    expect(getFileStoreSize()).toBe(0);
    return ((await res.json()) as { error: { message: string } }).error.message;
  };

  const upload = async (
    body: Buffer,
    contentType: string = CT,
  ): Promise<{ id: string; filename: string; bytes: number }> => {
    const res = await post(body, contentType);
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string; filename: string; bytes: number };
  };

  const purposePart = (value = "assistants"): string =>
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\n${value}\r\n`;

  /** One `file` part with arbitrary Content-Disposition params and extra headers. */
  const filePart = (params: string, content: Buffer | string, headers = ""): Buffer =>
    cat(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"${params}\r\n${headers}\r\n`,
      content,
      `\r\n--${BOUNDARY}--\r\n`,
    );

  beforeEach(async () => {
    clearFileStore();
    mock = new LLMock({ port: 0 });
    await mock.start();
  });

  afterEach(async () => {
    await mock.stop();
    clearFileStore();
  });

  it("rejects a repeated Content-Transfer-Encoding instead of letting the last win", async () => {
    const message = await errorMessage(
      cat(
        purposePart(),
        filePart(
          '; filename="hi.txt"',
          "aGk=",
          "Content-Transfer-Encoding: base64\r\nContent-Transfer-Encoding: 7bit\r\n",
        ),
      ),
    );
    expect(message).toContain("duplicate 'Content-Transfer-Encoding' header");
    expect(message).toContain("multipart part #2");
  });

  it("rejects a repeated Content-Disposition header", async () => {
    const message = await errorMessage(
      cat(
        purposePart(),
        cat(
          `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n` +
            `Content-Disposition: form-data; name="file"; filename="b.png"\r\n\r\n`,
          "plain text",
          `\r\n--${BOUNDARY}--\r\n`,
        ),
      ),
    );
    expect(message).toContain("duplicate 'Content-Disposition' header");
  });

  it("rejects a repeated parameter inside one header value", async () => {
    const message = await errorMessage(
      cat(purposePart(), filePart('; filename="a.txt"; filename="b.png"', "plain text")),
    );
    expect(message).toContain("duplicate 'filename' parameter on the Content-Disposition header");
  });

  it("reads the real boundary past a decoy 'boundary=' in another parameter", async () => {
    const created = await upload(
      cat(purposePart(), filePart('; filename="ok.txt"', "hello")),
      `multipart/form-data; name="x boundary=FAKE"; boundary=${BOUNDARY}`,
    );
    expect(created.filename).toBe("ok.txt");
    expect(created.bytes).toBe(5);
    const served = Buffer.from(
      await (await fetch(`${mock.url}/v1/files/${created.id}/content`)).arrayBuffer(),
    );
    expect(sha256(served)).toBe(sha256(Buffer.from("hello")));
  });

  it("still accepts a quoted boundary containing a space (RFC 2046 bchars)", async () => {
    const spaced = "a b c";
    const body = cat(
      `--${spaced}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nassistants\r\n`,
      `--${spaced}\r\nContent-Disposition: form-data; name="file"; filename="s.txt"\r\n\r\n`,
      "hey",
      `\r\n--${spaced}--\r\n`,
    );
    const created = await upload(body, `multipart/form-data; boundary="${spaced}"`);
    expect(created.filename).toBe("s.txt");
    expect(created.bytes).toBe(3);
  });

  it("rejects a Content-Disposition whose type is not form-data", async () => {
    const message = await errorMessage(
      cat(
        purposePart(),
        cat(
          `--${BOUNDARY}\r\nContent-Disposition: attachment; name="file"; filename="att.txt"\r\n\r\n`,
          "attached",
          `\r\n--${BOUNDARY}--\r\n`,
        ),
      ),
    );
    expect(message).toContain("Content-Disposition type 'attachment'");
    expect(message).toContain("form-data");
  });

  it("ignores a part whose name is not purpose/file/content, as the JSON path ignores unknown keys", async () => {
    const created = await upload(
      cat(
        purposePart(),
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="expires_after"\r\n\r\n3600\r\n`,
        filePart('; filename="ok.txt"', "hello"),
      ),
    );
    expect(created.filename).toBe("ok.txt");
    expect(created.bytes).toBe(5);

    // The parity control: an unknown key on the JSON body is ignored too.
    const json = await postJson(`${mock.url}/v1/files`, {
      filename: "j.txt",
      purpose: "assistants",
      content: "hello",
      expires_after: 3600,
    });
    expect(json.status).toBe(200);
  });

  it("rejects an undecodable filename* instead of storing U+FFFD", async () => {
    const message = await errorMessage(
      cat(purposePart(), filePart("; filename*=UTF-8''%FF%FE.txt", "hello")),
    );
    expect(message).toContain("malformed 'filename*' parameter");
  });

  it("still decodes a well-formed filename* in both charsets", async () => {
    const utf8 = await upload(
      cat(purposePart(), filePart("; filename*=UTF-8''%E2%82%AC.txt", "hello")),
    );
    expect(utf8.filename).toBe("€.txt");

    clearFileStore();
    const latin1 = await upload(
      cat(purposePart(), filePart("; filename*=ISO-8859-1''caf%E9.txt", "hello")),
    );
    expect(latin1.filename).toBe("café.txt");
  });
});

/**
 * One validator, two wire formats.
 *
 * Every case here is run TWICE — once as a JSON body, once as a multipart body
 * — and asserted to give the same answer. That pairing is the point: the bugs
 * these cover were not "the rule is wrong", they were "the rule is only on one
 * path", and a test that exercises a single path cannot see that.
 */
describe("upload field validation is identical on the JSON and multipart paths", () => {
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

  type UploadResult = { status: number; filename?: string; id?: string; message?: string };

  const readResult = async (res: Response): Promise<UploadResult> => {
    const json = (await res.json()) as {
      id?: string;
      filename?: string;
      error?: { message: string };
    };
    return {
      status: res.status,
      id: json.id,
      filename: json.filename,
      message: json.error?.message,
    };
  };

  const viaJson = async (filename: string, purpose = "batch"): Promise<UploadResult> =>
    readResult(await postJson(`${mock.url}/v1/files`, { filename, purpose, content: "hi" }));

  const viaMultipart = async (filename: string, purpose = "batch"): Promise<UploadResult> => {
    const { body, contentType } = multipartBody(
      purpose,
      filename,
      Buffer.from("hi", "utf8"),
      "application/octet-stream",
    );
    return readResult(
      await fetch(`${mock.url}/v1/files`, {
        method: "POST",
        headers: { "Content-Type": contentType },
        body: new Uint8Array(body),
      }),
    );
  };

  const bothPaths: [string, (filename: string, purpose?: string) => Promise<UploadResult>][] = [
    ["json", viaJson],
    ["multipart", viaMultipart],
  ];

  const NUL_NAME = `a${String.fromCharCode(0)}b.txt`;
  const SOH_NAME = `a${String.fromCharCode(1)}b.txt`;

  it.each(bothPaths)("%s rejects a NUL in the filename", async (_label, send) => {
    const got = await send(NUL_NAME);
    expect(got.status).toBe(400);
    expect(got.message).toBe("Invalid parameter: 'filename' must not contain control characters");
    expect(getFileStoreSize()).toBe(0);
  });

  it("gives the same message for a control-character filename on both paths", async () => {
    const fromJson = await viaJson(SOH_NAME);
    const fromMultipart = await viaMultipart(SOH_NAME);
    expect(fromJson.status).toBe(400);
    expect(fromMultipart.status).toBe(fromJson.status);
    expect(fromMultipart.message).toBe(fromJson.message);
  });

  it("rejects a JSON filename holding an unpaired surrogate before it can 500 the content route", async () => {
    // Stored with a 200, "\uD800.txt" made `GET /v1/files/{id}/content` throw
    // `URIError` inside `encodeURIComponent` (the `filename*` parameter) and
    // answer 500 `URI malformed` forever. The multipart path cannot carry one:
    // `filename*=UTF-8''%ED%A0%80.txt` is not valid UTF-8 and is already a 400.
    const got = await viaJson("\uD800.txt");
    expect(got.status).toBe(400);
    expect(got.message).toBe(
      "Invalid parameter: 'filename' must not contain an unpaired UTF-16 surrogate",
    );
    expect(getFileStoreSize()).toBe(0);
    const viaStar = await fetch(`${mock.url}/v1/files`, {
      method: "POST",
      headers: { "Content-Type": "multipart/form-data; boundary=b" },
      body:
        `--b\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nbatch\r\n` +
        `--b\r\nContent-Disposition: form-data; name="file"; filename*=UTF-8''%ED%A0%80.txt\r\n` +
        `\r\nhi\r\n--b--\r\n`,
    });
    expect(viaStar.status).toBe(400);
    expect(getFileStoreSize()).toBe(0);
  });

  it.each(bothPaths)("%s still stores a filename holding a paired surrogate", async (_l, send) => {
    const got = await send("\uD83D\uDE00.txt");
    expect(got.status).toBe(200);
    expect(got.filename).toBe("\uD83D\uDE00.txt");
    const res = await fetch(`${mock.url}/v1/files/${got.id}/content`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("filename*=UTF-8''%F0%9F%98%80.txt");
  });

  it.each(bothPaths)("%s synthesizes a name for a whitespace-only filename", async (_l, send) => {
    const got = await send("   ");
    expect(got.status).toBe(200);
    // The same name the multipart path has always produced: a pure function of
    // the content, so both paths agree byte for byte, not just in shape.
    expect(got.filename).toBe(`upload-${sha256(Buffer.from("hi", "utf8")).slice(0, 24)}.bin`);
  });

  it.each(bothPaths)("%s rejects a purpose padded with whitespace", async (_l, send) => {
    const got = await send("a.txt", "  batch  ");
    expect(got.status).toBe(400);
    expect(got.message).toContain("Invalid purpose '  batch  '");
  });

  it("gives the same answer for a padded purpose on both paths", async () => {
    const fromJson = await viaJson("a.txt", " batch ");
    const fromMultipart = await viaMultipart("a.txt", " batch ");
    expect(fromJson.status).toBe(400);
    expect(fromMultipart.status).toBe(fromJson.status);
    expect(fromMultipart.message).toBe(fromJson.message);
  });

  it.each(bothPaths)("%s accepts a filename exactly at the cap", async (_l, send) => {
    const atCap = "m".repeat(FILES_MAX_FILENAME_BYTES - 4) + ".txt";
    expect(Buffer.byteLength(atCap, "utf8")).toBe(FILES_MAX_FILENAME_BYTES);
    const got = await send(atCap);
    expect(got.status).toBe(200);
    expect(got.filename).toBe(atCap);
  });

  it.each(bothPaths)("%s rejects a filename one byte over the cap", async (_l, send) => {
    const got = await send("z".repeat(FILES_MAX_FILENAME_BYTES + 1));
    expect(got.status).toBe(400);
    expect(got.message).toContain(`${FILES_MAX_FILENAME_BYTES} byte cap`);
    expect(got.message).toContain(`${FILES_MAX_FILENAME_BYTES + 1} UTF-8 bytes`);
    expect(getFileStoreSize()).toBe(0);
  });

  // The cap is in BYTES because the header it protects is measured in bytes: a
  // name of 600 two-byte characters is 1200 bytes of `filename*`.
  it("measures the cap in UTF-8 bytes, not UTF-16 code units", async () => {
    const name = "é".repeat(FILES_MAX_FILENAME_BYTES / 2 + 1);
    expect(name.length).toBeLessThan(FILES_MAX_FILENAME_BYTES);
    const got = await viaJson(name);
    expect(got.status).toBe(400);
    expect(got.message).toContain("UTF-8 bytes");
  });

  // The regression the cap exists for: unbounded, this uploaded 200 and then
  // made the content route unreadable by undici — `UND_ERR_HEADERS_OVERFLOW`,
  // no status, no envelope. So the cap is only correct if a name AT the cap
  // still round-trips through a real HTTP client.
  it("serves the content of a file named at the cap instead of overflowing the headers", async () => {
    const atCap = "m".repeat(FILES_MAX_FILENAME_BYTES - 4) + ".txt";
    const created = await viaJson(atCap);
    expect(created.status).toBe(200);
    const res = await fetch(`${mock.url}/v1/files/${created.id}/content`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain(atCap);
    expect(await res.text()).toBe("hi");
  });

  it("rejects a non-string filename on the JSON path before any of the above", async () => {
    const res = await postJson(`${mock.url}/v1/files`, {
      filename: 42,
      purpose: "batch",
      content: "hi",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("Invalid parameter: 'filename' must be a string");
  });
});

/**
 * What a stored file RETAINS, which is not the same question as what it serves
 * back. Every multipart part body is a `subarray` of the request buffer, and a
 * `subarray` keeps its whole backing `ArrayBuffer` alive — so storing one made
 * a 2-byte file pin its entire request body (up to `FILES_BODY_MAX_BYTES`,
 * ~62.9 MB) for as long as the file existed, silently falsifying the per-file
 * memory bound this module documents at the top.
 *
 * These assert on `buffer.byteLength` — the size of the backing store, i.e.
 * exactly the `process.memoryUsage().arrayBuffers` the file is responsible for
 * — rather than forcing a GC and reading `arrayBuffers`, because the suite does
 * not run under `--expose-gc` and an un-forced heap reading is garbage-dominated
 * and flaky. The forced-GC measurement over 20 uploads lives in the red-green
 * probe for this fix; this is its deterministic, per-upload equivalent.
 */
describe("stored bytes are owned, not a view of the request body", () => {
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

  /** A multipart body padded with a legal RFC 2046 §5.1.1 preamble. */
  function paddedMultipart(
    preambleBytes: number,
    content: Buffer,
  ): { body: Buffer; contentType: string } {
    const { body, contentType } = multipartBody(
      "assistants",
      "tiny.bin",
      content,
      "application/octet-stream",
    );
    return {
      body: Buffer.concat([Buffer.alloc(preambleBytes, 0x41), CRLF_BYTES, body]),
      contentType,
    };
  }

  async function uploadRaw(body: Buffer, contentType: string): Promise<string> {
    const res = await fetch(`${mock.url}/v1/files`, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: new Uint8Array(body),
    });
    const json = (await res.json()) as { id: string };
    expect(res.status).toBe(200);
    return json.id;
  }

  it("stores a multipart upload in a buffer that backs nothing else", async () => {
    const { body, contentType } = multipartBody("assistants", "pixel.png", PNG_BYTES, "image/png");
    const id = await uploadRaw(body, contentType);

    const stored = getStoredFileBytes(id);
    expect(stored).toBeDefined();
    if (!stored) return;
    expect(stored.byteLength).toBe(PNG_BYTES.length);
    // The whole point: an owned buffer, so its backing store is its own size.
    expect(stored.buffer.byteLength).toBe(stored.byteLength);
    expect(stored.byteOffset).toBe(0);
    expect(Buffer.compare(stored, PNG_BYTES)).toBe(0);
  });

  it("retains the file's own bytes, not the 4 MB request they arrived in", async () => {
    const PREAMBLE = 4 * 1024 * 1024;
    const { body, contentType } = paddedMultipart(PREAMBLE, Buffer.from("hi"));
    expect(body.length).toBeGreaterThan(PREAMBLE);

    const id = await uploadRaw(body, contentType);
    const stored = getStoredFileBytes(id);
    expect(stored).toBeDefined();
    if (!stored) return;
    expect(stored.toString("utf8")).toBe("hi");

    // Bytes this one file keeps resident. A `subarray` of the request buffer
    // reported ~4 MB here; an owned copy reports 2.
    expect(stored.buffer.byteLength).toBe(2);
  });

  it("keeps the JSON path's retention off the request body too", async () => {
    // `Buffer.from(content, "utf8")` already allocates fresh, so this path was
    // never the bug — but it draws small allocations from the shared `Buffer`
    // pool, so the assertion is a BOUND rather than exact ownership. What
    // matters is the same property: retention does not scale with the request.
    const create = await postJson(`${mock.url}/v1/files`, {
      filename: "a.jsonl",
      purpose: "fine-tune",
      content: "hi",
      // An unknown key the parser ignores — 1 MB of request the file must not
      // keep alive.
      note: "A".repeat(1024 * 1024),
    });
    const { id } = (await create.json()) as { id: string };
    const stored = getStoredFileBytes(id);
    expect(stored).toBeDefined();
    if (!stored) return;
    expect(stored.toString("utf8")).toBe("hi");
    expect(stored.buffer.byteLength).toBeLessThan(256 * 1024);
  });

  it("parses a body whose opening delimiter has no preamble at all", async () => {
    // The no-preamble case is the one the removed `Buffer.concat([CRLF, raw])`
    // existed to serve, so it is pinned here explicitly.
    const { body, contentType } = multipartBody(
      "assistants",
      "bare.bin",
      Buffer.from([0x00, 0xff, 0xfe]),
      "application/octet-stream",
    );
    expect(body.subarray(0, 2).toString("latin1")).toBe("--");
    const id = await uploadRaw(body, contentType);
    const stored = getStoredFileBytes(id);
    expect(stored).toBeDefined();
    if (!stored) return;
    expect([...stored]).toEqual([0x00, 0xff, 0xfe]);
  });
});

// ─── Regression: one rule for every list query parameter ───────────────────
//
// `GET /v1/files` used to read its four query parameters three different ways,
// so the same malformed URL got three different answers. Each line below was
// observed over real HTTP against the pre-fix build:
//
//   ?limit=1&limit=abc  → 200, paged at 1, `abc` never looked at
//   ?purpose=           → 200 with the WHOLE store, the opposite of a filter
//   ?after=             → 200 with the whole store ("no cursor")
//   ?order=             → 400 — the only one of the four that got it right
//
// The rule now: a repeated parameter is a 400 naming it and the count, and a
// present-but-empty one is a 400 naming it, for all four alike.
describe("Files API list query parameters obey one rule", () => {
  let mock: LLMock;

  beforeEach(async () => {
    clearFileStore();
    mock = new LLMock({ port: 0 });
    await mock.start();
    for (const [filename, purpose] of [
      ["a.jsonl", "fine-tune"],
      ["b.jsonl", "batch"],
      ["c.jsonl", "batch"],
    ] as const) {
      const res = await postJson(`${mock.url}/v1/files`, { filename, purpose, content: "x" });
      expect(res.status).toBe(200);
    }
  });

  afterEach(async () => {
    await mock.stop();
    clearFileStore();
  });

  /** A GET whose request target reaches the wire verbatim — `fetch` sanitizes. */
  const rawGet = (port: number, target: string): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, method: "GET", path: target }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on("error", reject);
      req.end();
    });

  const errorOf = async (query: string): Promise<{ status: number; message: string }> => {
    const res = await fetch(`${mock.url}/v1/files${query}`);
    const body = (await res.json()) as { error?: { message: string; type: string } };
    return { status: res.status, message: body.error?.message ?? "" };
  };

  it.each([
    ["limit", "?limit=1&limit=abc"],
    ["order", "?order=asc&order=desc"],
    ["after", "?after=x&after=y"],
    ["purpose", "?purpose=batch&purpose=fine-tune"],
  ])("rejects a repeated %s with a 400 naming it", async (param, query) => {
    const { status, message } = await errorOf(query);
    expect(status).toBe(400);
    // The count is part of the message: a caller that built its URL twice over
    // needs to see that a second value existed at all, not just that the first
    // one parsed.
    expect(message).toBe(
      `Invalid parameter: '${param}' was given 2 times; it takes a single value`,
    );
  });

  it.each(["limit", "order", "after", "purpose"])(
    "rejects a present-but-empty %s= with the same 400",
    async (param) => {
      const { status, message } = await errorOf(`?${param}=`);
      expect(status).toBe(400);
      expect(message).toBe(
        `Invalid parameter: '${param}' was given an empty value; omit it instead`,
      );
    },
  );

  it("does not hand the whole store back for ?purpose=", async () => {
    // The pre-fix failure this suite exists for: `if (purposeFilter)` is a
    // truthiness test, so an empty purpose skipped the filter and answered with
    // every file in the store — the exact opposite of the narrowing asked for.
    const res = await fetch(`${mock.url}/v1/files?purpose=`);
    const body = (await res.json()) as { data?: unknown[] };
    expect(body.data).toBeUndefined();
  });

  it("still answers 200 with an empty list for a purpose no file carries", async () => {
    // The 400 above is about the EMPTY value, not about validating `purpose`
    // against an enum: `listFiles` declares it `type: string` with no `enum`
    // (contrast `order` in the same parameter list), so an unrecognised purpose
    // stays a 200 that matches nothing.
    const res = await fetch(`${mock.url}/v1/files?purpose=assistants`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown[] }).data).toHaveLength(0);
  });

  it("leaves a well-formed single-valued query working", async () => {
    const res = await fetch(`${mock.url}/v1/files?purpose=batch&limit=5&order=asc`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { filename: string }[] };
    expect(body.data.map((f) => f.filename)).toEqual(["b.jsonl", "c.jsonl"]);
  });

  it("reads a '#' in a parameter value as part of the value, not as a fragment", async () => {
    // A request target has no fragment component (RFC 9112 section 3.2), so
    // `?purpose=batch#frag` asks for the purpose `batch#frag` — which no file
    // carries. Parsing the target with `new URL` applied the fragment rule and
    // answered with the two `batch` files instead, silently narrowing on a
    // value the caller never sent. `fetch` strips a fragment before it reaches
    // the wire, so this has to go out over raw `node:http`.
    const { status, body } = await rawGet(mock.port, "/v1/files?purpose=batch#frag");
    expect(status).toBe(200);
    expect((JSON.parse(body) as { data: unknown[] }).data).toHaveLength(0);
  });
});

/**
 * F6: the files journal used to be incomplete in three ways. A 400 entry
 * carried `body: null` and no log line, so a caller reading the journal could
 * see that an upload was rejected but not why; no entry carried
 * `source: "internal"` although every files response is synthesized by this
 * process exactly as fine-tuning's are; and every 200 was journaled BEFORE
 * the response was written, so a `writeHead` that threw left a phantom 200
 * entry for a response the client never received.
 */
describe("Files API journal completeness", () => {
  let mock: LLMock;

  beforeEach(async () => {
    clearFileStore();
    mock = new LLMock({ port: 0, logLevel: "warn" });
    await mock.start();
  });

  afterEach(async () => {
    await mock.stop();
    clearFileStore();
  });

  const filesEntries = (): ReturnType<LLMock["getRequests"]> =>
    mock.getRequests().filter((e) => e.service === "files");

  it("journals the rejection reason and logs a 400", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const bad = await postJson(`${mock.url}/v1/files`, {
        filename: "b.jsonl",
        purpose: "nope",
        content: "b",
      });
      expect(bad.status).toBe(400);
      const wire = (await bad.json()) as { error: { message: string; type: string } };

      const entries = filesEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].response.status).toBe(400);
      // The entry carries the SAME envelope the wire got, so the reason a
      // request was rejected is readable from the journal alone.
      expect(entries[0].body).toEqual(wire);
      expect(wire.error.message).toContain("purpose");

      const lines = warnSpy.mock.calls.map((c) => c.map(String).join(" "));
      expect(
        lines.some((l) => l.includes("POST /v1/files") && l.includes(wire.error.message)),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it.each([
    {
      label: "purpose controls",
      field: "purpose",
      value: "x\nFORGED\r\t\0\x1b\x7f\x85\u2028\u2029",
    },
    {
      label: "decoded cursor controls",
      field: "after",
      value: "x\nFORGED\r\t\0\x1b\x7f\x85\u2028\u2029",
    },
    { label: "200 KB purpose", field: "purpose", value: "Z".repeat(200_000) },
    { label: "long request path", field: "after", value: "Z".repeat(4_000) },
  ])("bounds and escapes the full rejection warning for $label", async ({ field, value }) => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res =
        field === "purpose"
          ? await postJson(`${mock.url}/v1/files`, {
              filename: "x.txt",
              content: "x",
              purpose: value,
            })
          : await fetch(`${mock.url}/v1/files?after=${encodeURIComponent(value)}`);
      expect(res.status).toBe(400);
      const wire = await res.json();
      expect(wire.error.message).toContain(value);
      const [entry] = filesEntries();
      expect(entry.response).toMatchObject({ status: 400, source: "internal" });
      // The journal's existing body cap still applies to oversized envelopes.
      if (value.length < 200_000) expect(entry.body).toEqual(wire);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const line = warnSpy.mock.calls[0].map(String).join(" ");
      expect(line).toContain("[aimock] Files mock: rejected");
      expect(line.length).toBeLessThanOrEqual(1_033); // 1,024 + Logger's fixed prefix
      for (const character of line) {
        const code = character.charCodeAt(0);
        expect(
          code >= 32 && !(code >= 127 && code <= 159) && code !== 0x2028 && code !== 0x2029,
        ).toBe(true);
      }
      if (value.length < 100) {
        expect(line).toContain(
          "\\u000aFORGED\\u000d\\u0009\\u0000\\u001b\\u007f\\u0085\\u2028\\u2029",
        );
      } else {
        expect(line.endsWith("...")).toBe(true);
      }
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("journals a list 400 with its reason too", async () => {
    const res = await fetch(`${mock.url}/v1/files?limit=0`);
    expect(res.status).toBe(400);
    const wire = await res.json();
    const [entry] = filesEntries();
    expect(entry.response.status).toBe(400);
    expect(entry.body).toEqual(wire);
  });

  it("marks every files entry source=internal, success and error alike", async () => {
    const created = (await (
      await postJson(`${mock.url}/v1/files`, {
        filename: "a.jsonl",
        purpose: "batch",
        content: "a",
      })
    ).json()) as { id: string };
    await fetch(`${mock.url}/v1/files`);
    await fetch(`${mock.url}/v1/files/${created.id}`);
    await fetch(`${mock.url}/v1/files/${created.id}/content`);
    await fetch(`${mock.url}/v1/files/${created.id}`, { method: "DELETE" });
    await fetch(`${mock.url}/v1/files/${created.id}`);
    await postJson(`${mock.url}/v1/files`, { filename: "b.jsonl", purpose: "nope", content: "b" });

    const entries = filesEntries();
    expect(entries.map((e) => e.response.status)).toEqual([200, 200, 200, 200, 200, 404, 400]);
    for (const entry of entries) {
      expect(entry.response.source, `${entry.method} ${entry.path}`).toBe("internal");
    }
  });

  it("does not journal a 200 whose response write threw", async () => {
    const created = (await (
      await postJson(`${mock.url}/v1/files`, {
        filename: "a.jsonl",
        purpose: "batch",
        content: "a",
      })
    ).json()) as { id: string };

    const journal = new Journal();
    const req = {
      url: `/v1/files/${created.id}/content`,
      method: "GET",
      headers: {},
    } as unknown as http.IncomingMessage;
    const res = {
      setHeader(): void {},
      writeHead(): never {
        throw new Error("writeHead refused");
      },
      end(): void {},
    } as unknown as http.ServerResponse;

    await expect(
      handleFilesContent(req, res, created.id, journal, { logger: new Logger("silent") }, () => {}),
    ).rejects.toThrow("writeHead refused");
    // Nothing reached the client, so nothing is journaled as served.
    expect(journal.getAll()).toEqual([]);
  });

  it("does not journal a 400 whose response write threw", async () => {
    const journal = new Journal();
    const req = {
      url: "/v1/files",
      method: "POST",
      headers: { "content-type": "application/json" },
    } as unknown as http.IncomingMessage;
    const res = {
      setHeader(): void {},
      writeHead(): never {
        throw new Error("writeHead refused");
      },
      end(): void {},
    } as unknown as http.ServerResponse;
    const raw = Buffer.from(JSON.stringify({ filename: "a.jsonl", purpose: "nope", content: "a" }));

    await expect(
      handleFilesCreate(req, res, raw, journal, { logger: new Logger("silent") }, () => {}),
    ).rejects.toThrow("writeHead refused");
    expect(journal.getAll()).toEqual([]);
  });

  it("does not journal a 404 whose response write threw", async () => {
    const journal = new Journal();
    const req = {
      url: "/v1/files/file-missing",
      method: "GET",
      headers: {},
    } as unknown as http.IncomingMessage;
    const res = {
      setHeader(): void {},
      writeHead(): never {
        throw new Error("writeHead refused");
      },
      end(): void {},
    } as unknown as http.ServerResponse;

    await expect(
      handleFilesRetrieve(
        req,
        res,
        "file-missing",
        journal,
        { logger: new Logger("silent") },
        () => {},
      ),
    ).rejects.toThrow("writeHead refused");
    expect(journal.getAll()).toEqual([]);
  });

  it("still journals a normal 400 and 404 exactly once each", async () => {
    await postJson(`${mock.url}/v1/files`, { filename: "b.jsonl", purpose: "nope", content: "b" });
    await fetch(`${mock.url}/v1/files/file-missing`);
    const entries = filesEntries();
    expect(entries.map((e) => e.response.status)).toEqual([400, 404]);
    expect(entries[0].body).toMatchObject({
      error: { message: expect.stringContaining("purpose") },
    });
    expect(entries[1].body).toBeNull();
    for (const entry of entries) {
      expect(entry.service).toBe("files");
      expect(entry.response.source).toBe("internal");
    }
  });
});
