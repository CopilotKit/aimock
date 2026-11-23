import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LLMock } from "../llmock.js";
import { clearBatchStore } from "../batches.js";
import { clearFileStore, FILES_MAX_BYTES } from "../files.js";
import { normalizePathLabel } from "../metrics.js";

async function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Batches API mock", () => {
  let mock: LLMock;

  beforeEach(async () => {
    clearBatchStore();
    mock = new LLMock({ port: 0 });
    await mock.start();
  });

  afterEach(async () => {
    await mock.stop();
    clearBatchStore();
  });

  it("creates a batch and progresses validating -> in_progress -> completed", async () => {
    const created = (await (
      await post(`${mock.url}/v1/batches`, {
        input_file_id: "file-abc",
        endpoint: "/v1/chat/completions",
        completion_window: "24h",
      })
    ).json()) as { id: string; status: string };
    expect(created.id.startsWith("batch-")).toBe(true);
    expect(created.status).toBe("validating");

    const first = (await (await fetch(`${mock.url}/v1/batches/${created.id}`)).json()) as {
      status: string;
    };
    expect(first.status).toBe("in_progress");

    const second = (await (await fetch(`${mock.url}/v1/batches/${created.id}`)).json()) as {
      status: string;
      output_file_id: string;
      request_counts: { total: number; completed: number };
    };
    expect(second.status).toBe("completed");
    expect(second.output_file_id.startsWith("file-")).toBe(true);
    expect(second.request_counts.completed).toBe(1);

    const third = (await (await fetch(`${mock.url}/v1/batches/${created.id}`)).json()) as {
      status: string;
    };
    expect(third.status).toBe("completed");
  });

  it("lists batches, cancels pending ones, and rejects terminal cancel", async () => {
    const one = (await (
      await post(`${mock.url}/v1/batches`, {
        input_file_id: "file-1",
        endpoint: "/v1/embeddings",
        completion_window: "24h",
      })
    ).json()) as { id: string };
    const two = (await (
      await post(`${mock.url}/v1/batches`, {
        input_file_id: "file-2",
        endpoint: "/v1/chat/completions",
        completion_window: "24h",
      })
    ).json()) as { id: string };

    const list = (await (await fetch(`${mock.url}/v1/batches`)).json()) as {
      object: string;
      data: { id: string }[];
    };
    expect(list.object).toBe("list");
    expect(list.data.map((d) => d.id)).toEqual(expect.arrayContaining([one.id, two.id]));

    const cancelled = (await (
      await post(`${mock.url}/v1/batches/${one.id}/cancel`, {})
    ).json()) as { status: string };
    expect(cancelled.status).toBe("cancelling");

    // Drive `two` to completed, then cancel must 400.
    await fetch(`${mock.url}/v1/batches/${two.id}`);
    await fetch(`${mock.url}/v1/batches/${two.id}`);
    const badCancel = await post(`${mock.url}/v1/batches/${two.id}/cancel`, {});
    expect(badCancel.status).toBe(400);
  });

  it("validates endpoint, window, file id, and unknown ids", async () => {
    expect(
      (
        await post(`${mock.url}/v1/batches`, {
          input_file_id: "file-x",
          endpoint: "/v1/nope",
          completion_window: "24h",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post(`${mock.url}/v1/batches`, {
          input_file_id: "file-x",
          endpoint: "/v1/chat/completions",
          completion_window: "1h",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post(`${mock.url}/v1/batches`, {
          endpoint: "/v1/chat/completions",
          completion_window: "24h",
        })
      ).status,
    ).toBe(400);
    expect((await fetch(`${mock.url}/v1/batches/batch-nope`)).status).toBe(404);

    const malformed = await fetch(`${mock.url}/v1/batches`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{bad",
    });
    expect(malformed.status).toBe(400);
  });

  it("journals under service=batches, clears on reset, normalizes metrics", async () => {
    await post(`${mock.url}/v1/batches`, {
      input_file_id: "file-j",
      endpoint: "/v1/chat/completions",
      completion_window: "24h",
    });
    const journal = (await (
      await fetch(`${mock.url}/__aimock/journal?service=batches`)
    ).json()) as { path: string }[];
    expect(journal.length).toBeGreaterThan(0);

    await fetch(`${mock.url}/__aimock/reset`, { method: "POST" });
    const list = (await (await fetch(`${mock.url}/v1/batches`)).json()) as { data: unknown[] };
    expect(list.data).toEqual([]);

    expect(normalizePathLabel("/v1/batches")).toBe("/v1/batches");
    expect(normalizePathLabel("/v1/batches/batch-123")).toBe("/v1/batches/{id}");
    expect(normalizePathLabel("/v1/batches/batch-123/cancel")).toBe("/v1/batches/{id}/cancel");
  });
});

// The chaos gate is shared with every other job surface (files, fine-tuning),
// so it has to behave the same way here: async so `latencyMs` actually
// delays, CORS set before the roll so a faulted 429/500 is readable from a
// browser, and `service: "batches"` on the journal context so faulted
// requests show up under `?service=batches`.
describe("Batches API chaos gate", () => {
  let mock: LLMock;
  const create = {
    input_file_id: "file-chaos",
    endpoint: "/v1/chat/completions",
    completion_window: "24h",
  };

  beforeEach(async () => {
    clearBatchStore();
    mock = new LLMock({ port: 0 });
    await mock.start();
  });

  afterEach(async () => {
    await mock.stop();
    clearBatchStore();
  });

  it("honours chaos latencyMs on create", async () => {
    const t0 = Date.now();
    const res = await fetch(`${mock.url}/v1/batches`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-aimock-chaos-latency": "400" },
      body: JSON.stringify(create),
    });
    await res.text();
    expect(res.status).toBe(200);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400);
  });

  it("sets CORS on a chaos-faulted response and journals it under service=batches", async () => {
    const chaos = { "Content-Type": "application/json", "x-aimock-chaos-ratelimit": "1" };
    const routes: [string, RequestInit][] = [
      [`${mock.url}/v1/batches`, { method: "POST", headers: chaos, body: JSON.stringify(create) }],
      [`${mock.url}/v1/batches`, { headers: chaos }],
      [`${mock.url}/v1/batches/batch-x`, { headers: chaos }],
      [`${mock.url}/v1/batches/batch-x/cancel`, { method: "POST", headers: chaos, body: "{}" }],
    ];
    for (const [url, init] of routes) {
      const res = await fetch(url, init);
      await res.text();
      expect(res.status).toBe(429);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    }
    const journal = (await (
      await fetch(`${mock.url}/__aimock/journal?service=batches`)
    ).json()) as { response: { chaosAction?: string } }[];
    expect(journal).toHaveLength(4);
    expect(journal.every((e) => e.response.chaosAction === "rateLimit")).toBe(true);
  });
});

/**
 * B4: `POST /v1/batches/{id}/cancel` reads (and discards) its body before the
 * handler runs, so `readBody`'s 10 MB ceiling applies to it exactly as it does
 * to the create route beside it. A route that never touches the stream lets
 * node dump whatever the client sends and answers 200 to a 12 MB upload.
 */
describe("Batches cancel bounds its request body like create", () => {
  let mock: LLMock;

  beforeEach(async () => {
    clearBatchStore();
    mock = new LLMock({ port: 0 });
    await mock.start();
  });

  afterEach(async () => {
    await mock.stop();
    clearBatchStore();
  });

  async function createBatch(): Promise<string> {
    const created = (await (
      await post(`${mock.url}/v1/batches`, {
        input_file_id: "file-b4",
        endpoint: "/v1/chat/completions",
        completion_window: "24h",
      })
    ).json()) as { id: string };
    return created.id;
  }

  it("rejects an over-cap cancel body the same way create does and leaves the batch untouched", async () => {
    const id = await createBatch();
    // readBody's ceiling is 10 MB; over it the request is destroyed, which
    // surfaces to fetch as a transport failure rather than a status.
    const overCap = Buffer.alloc(12 * 1024 * 1024, 0x78);
    const overCapPost = (path: string): Promise<Response> =>
      fetch(`${mock.url}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: overCap,
      });

    await expect(overCapPost("/v1/batches")).rejects.toThrow();
    await expect(overCapPost(`/v1/batches/${id}/cancel`)).rejects.toThrow();

    const after = (await (await fetch(`${mock.url}/v1/batches/${id}`)).json()) as {
      status: string;
    };
    expect(after.status).not.toBe("cancelled");
  });

  it("still cancels with an empty body and with a small JSON body", async () => {
    const empty = await fetch(`${mock.url}/v1/batches/${await createBatch()}/cancel`, {
      method: "POST",
    });
    expect(empty.status).toBe(200);
    expect(((await empty.json()) as { status: string }).status).toBe("cancelling");

    const small = await post(`${mock.url}/v1/batches/${await createBatch()}/cancel`, {
      reason: "changed my mind",
    });
    expect(small.status).toBe(200);
    expect(((await small.json()) as { status: string }).status).toBe("cancelling");
  });
});

/**
 * Create/list wire shape against the vendored `openai` SDK 4.104.0
 * `resources/batches.d.ts`: `BatchCreateParams.endpoint` is the union
 * `'/v1/responses' | '/v1/chat/completions' | '/v1/embeddings' | '/v1/completions'`,
 * `Batch` carries `metadata` and `request_counts`, and `list` is a `CursorPage`
 * (`after`/`limit`, `has_more`) whose response also names `first_id`/`last_id`.
 */
describe("Batches API mock: create/list wire shape", () => {
  let mock: LLMock;

  type Created = {
    id: string;
    endpoint: string;
    metadata?: Record<string, string>;
    request_counts?: { total: number; completed: number; failed: number };
  };
  type Page = {
    object: string;
    data: { id: string }[];
    has_more: boolean;
    first_id: string | null;
    last_id: string | null;
  };

  async function create(body: Record<string, unknown>): Promise<Response> {
    return post(`${mock.url}/v1/batches`, {
      input_file_id: "file-shape",
      endpoint: "/v1/chat/completions",
      completion_window: "24h",
      ...body,
    });
  }

  async function list(query: string): Promise<Response> {
    return fetch(`${mock.url}/v1/batches${query}`);
  }

  beforeEach(async () => {
    clearBatchStore();
    mock = new LLMock({ port: 0 });
    await mock.start();
  });

  afterEach(async () => {
    await mock.stop();
    clearBatchStore();
  });

  it("echoes metadata and starts request_counts at zero", async () => {
    const res = await create({ metadata: { a: "b" } });
    expect(res.status).toBe(200);
    const created = (await res.json()) as Created;
    expect(created.metadata).toEqual({ a: "b" });
    expect(created.request_counts).toEqual({ total: 0, completed: 0, failed: 0 });

    const bare = (await (await create({})).json()) as Created;
    expect(bare.request_counts).toEqual({ total: 0, completed: 0, failed: 0 });
    expect("metadata" in bare).toBe(false);
  });

  it("rejects metadata that is not an object of strings", async () => {
    expect((await create({ metadata: { a: 1 } })).status).toBe(400);
    expect((await create({ metadata: "nope" })).status).toBe(400);
  });

  it("accepts /v1/responses as an endpoint", async () => {
    const res = await create({ endpoint: "/v1/responses" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Created).endpoint).toBe("/v1/responses");
  });

  it("pages the list newest-first with limit/after and reports has_more, first_id, last_id", async () => {
    // Created in order A, B, C; listed C, B, A, mirroring the fine-tuning list
    // and the newest-first input `paginate()` documents.
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(((await (await create({})).json()) as Created).id);
    }
    const [a, b, c] = ids;

    const whole = (await (await list("")).json()) as Page;
    expect(whole.data.map((x) => x.id)).toEqual([c, b, a]);
    expect(whole.has_more).toBe(false);
    expect(whole.first_id).toBe(c);
    expect(whole.last_id).toBe(a);

    const first = (await (await list("?limit=2")).json()) as Page;
    expect(first.data.map((x) => x.id)).toEqual([c, b]);
    expect(first.has_more).toBe(true);
    expect(first.first_id).toBe(c);
    expect(first.last_id).toBe(b);

    const next = (await (await list(`?after=${first.last_id}&limit=2`)).json()) as Page;
    expect(next.data.map((x) => x.id)).toEqual([a]);
    expect(next.has_more).toBe(false);
    expect(next.first_id).toBe(a);
    expect(next.last_id).toBe(a);

    const middle = (await (await list(`?after=${c}&limit=1`)).json()) as Page;
    expect(middle.data.map((x) => x.id)).toEqual([b]);
    expect(middle.has_more).toBe(true);
  });

  it("returns null first_id/last_id on an empty page", async () => {
    const empty = (await (await list("")).json()) as Page;
    expect(empty.data).toEqual([]);
    expect(empty.has_more).toBe(false);
    expect(empty.first_id).toBeNull();
    expect(empty.last_id).toBeNull();
  });

  it("returns 400 for a bad limit or an unknown after cursor", async () => {
    expect((await list("?limit=abc")).status).toBe(400);
    expect((await list("?limit=0")).status).toBe(400);
    expect((await list("?after=batch-nope")).status).toBe(400);
  });
});

describe("Batches API lifecycle fidelity", () => {
  let mock: LLMock;

  const INPUT_LINES = [
    {
      custom_id: "req-1",
      method: "POST",
      url: "/v1/chat/completions",
      body: { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] },
    },
    {
      custom_id: "req-2",
      method: "POST",
      url: "/v1/chat/completions",
      body: { model: "gpt-4o-mini", messages: [{ role: "user", content: "yo" }] },
    },
  ];

  beforeEach(async () => {
    clearBatchStore();
    clearFileStore();
    mock = new LLMock({ port: 0 });
    await mock.start();
  });

  afterEach(async () => {
    await mock.stop();
    clearBatchStore();
    clearFileStore();
  });

  async function uploadInput(): Promise<string> {
    const file = (await (
      await post(`${mock.url}/v1/files`, {
        purpose: "batch",
        filename: "input.jsonl",
        content: INPUT_LINES.map((l) => JSON.stringify(l)).join("\n") + "\n",
      })
    ).json()) as { id: string };
    return file.id;
  }

  async function createBatch(
    inputFileId: string,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return fetch(`${mock.url}/v1/batches`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({
        input_file_id: inputFileId,
        endpoint: "/v1/chat/completions",
        completion_window: "24h",
      }),
    });
  }

  async function retrieve(id: string): Promise<Record<string, unknown>> {
    return (await (await fetch(`${mock.url}/v1/batches/${id}`)).json()) as Record<string, unknown>;
  }

  async function fileLines(fileId: string): Promise<Record<string, unknown>[]> {
    const res = await fetch(`${mock.url}/v1/files/${fileId}/content`);
    expect(res.status).toBe(200);
    const text = await res.text();
    return text
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  it("mints a real, downloadable output file with one line per input request", async () => {
    const inputId = await uploadInput();
    const created = (await (await createBatch(inputId)).json()) as { id: string };
    await retrieve(created.id);
    const done = await retrieve(created.id);
    expect(done["status"]).toBe("completed");
    expect(typeof done["completed_at"]).toBe("number");
    expect(done["request_counts"]).toEqual({ total: 2, completed: 2, failed: 0 });

    const outputId = done["output_file_id"] as string;
    const meta = (await (await fetch(`${mock.url}/v1/files/${outputId}`)).json()) as {
      purpose: string;
      filename: string;
    };
    expect(meta.purpose).toBe("batch_output");
    expect(meta.filename).toBe(`${created.id}_output.jsonl`);

    const lines = await fileLines(outputId);
    expect(lines.map((l) => l["custom_id"])).toEqual(["req-1", "req-2"]);
    for (const line of lines) {
      expect(String(line["id"]).startsWith("batch_req_")).toBe(true);
      expect(line["error"]).toBeNull();
      const response = line["response"] as {
        status_code: number;
        request_id: string;
        body: unknown;
      };
      expect(response.status_code).toBe(200);
      expect(typeof response.request_id).toBe("string");
      expect(response.body).toBeTruthy();
    }
  });

  it("falls back to a single synthesized request when the input file is unknown", async () => {
    const created = (await (await createBatch("file-not-uploaded")).json()) as { id: string };
    await retrieve(created.id);
    const done = await retrieve(created.id);
    expect(done["request_counts"]).toEqual({ total: 1, completed: 1, failed: 0 });
    const lines = await fileLines(done["output_file_id"] as string);
    expect(lines).toHaveLength(1);
  });

  it("X-AIMock-Batch-Outcome: failed lands on failed with a readable error file", async () => {
    const inputId = await uploadInput();
    const created = (await (
      await createBatch(inputId, { "X-AIMock-Batch-Outcome": "failed" })
    ).json()) as { id: string };
    expect((await retrieve(created.id))["status"]).toBe("in_progress");
    const done = await retrieve(created.id);
    expect(done["status"]).toBe("failed");
    expect(typeof done["failed_at"]).toBe("number");
    expect(done["output_file_id"]).toBeUndefined();
    expect(done["request_counts"]).toEqual({ total: 2, completed: 0, failed: 2 });
    const errors = done["errors"] as { object: string; data: { code: string; message: string }[] };
    expect(errors.object).toBe("list");
    expect(errors.data.length).toBeGreaterThan(0);

    const lines = await fileLines(done["error_file_id"] as string);
    expect(lines.map((l) => l["custom_id"])).toEqual(["req-1", "req-2"]);
    for (const line of lines) {
      expect(line["response"]).toBeNull();
      const error = line["error"] as { code: string; message: string };
      expect(typeof error.code).toBe("string");
      expect(typeof error.message).toBe("string");
    }
  });

  it("X-AIMock-Batch-Outcome: expired lands on expired with expired_at", async () => {
    const inputId = await uploadInput();
    const created = (await (
      await createBatch(inputId, { "X-AIMock-Batch-Outcome": "expired" })
    ).json()) as { id: string };
    await retrieve(created.id);
    const done = await retrieve(created.id);
    expect(done["status"]).toBe("expired");
    expect(typeof done["expired_at"]).toBe("number");
    expect((await retrieve(created.id))["status"]).toBe("expired");
  });

  it("rejects an unknown X-AIMock-Batch-Outcome value", async () => {
    const inputId = await uploadInput();
    const res = await createBatch(inputId, { "X-AIMock-Batch-Outcome": "exploded" });
    expect(res.status).toBe(400);
  });

  it("cancel returns cancelling, the next retrieve shows cancelled, and terminal cancel is 400", async () => {
    const inputId = await uploadInput();
    const created = (await (await createBatch(inputId)).json()) as { id: string };

    const cancelRes = await post(`${mock.url}/v1/batches/${created.id}/cancel`, {});
    expect(cancelRes.status).toBe(200);
    const cancelling = (await cancelRes.json()) as Record<string, unknown>;
    expect(cancelling["status"]).toBe("cancelling");
    expect(typeof cancelling["cancelling_at"]).toBe("number");

    const cancelled = await retrieve(created.id);
    expect(cancelled["status"]).toBe("cancelled");
    expect(typeof cancelled["cancelled_at"]).toBe("number");
    expect(cancelled["output_file_id"]).toBeUndefined();

    const again = await post(`${mock.url}/v1/batches/${created.id}/cancel`, {});
    expect(again.status).toBe(400);
    const body = (await again.json()) as { error: { message: string } };
    expect(body.error.message).toBe("Cannot cancel a batch with status cancelled.");

    for (const outcome of ["completed", "failed", "expired"]) {
      const other = (await (
        await createBatch(inputId, { "X-AIMock-Batch-Outcome": outcome })
      ).json()) as { id: string };
      await retrieve(other.id);
      expect((await retrieve(other.id))["status"]).toBe(outcome);
      const res = await post(`${mock.url}/v1/batches/${other.id}/cancel`, {});
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { message: string } }).error.message).toBe(
        `Cannot cancel a batch with status ${outcome}.`,
      );
    }
  });
});

describe("Batches API request_counts consistency", () => {
  let mock: LLMock;

  const INPUT_LINES = [
    {
      custom_id: "req-1",
      method: "POST",
      url: "/v1/chat/completions",
      body: { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] },
    },
    {
      custom_id: "req-2",
      method: "POST",
      url: "/v1/chat/completions",
      body: { model: "gpt-4o-mini", messages: [{ role: "user", content: "yo" }] },
    },
  ];

  beforeEach(async () => {
    clearBatchStore();
    clearFileStore();
    mock = new LLMock({ port: 0 });
    await mock.start();
  });

  afterEach(async () => {
    await mock.stop();
    clearBatchStore();
    clearFileStore();
  });

  async function uploadInput(): Promise<string> {
    const file = (await (
      await post(`${mock.url}/v1/files`, {
        purpose: "batch",
        filename: "input.jsonl",
        content: INPUT_LINES.map((l) => JSON.stringify(l)).join("\n") + "\n",
      })
    ).json()) as { id: string };
    return file.id;
  }

  async function createBatch(headers: Record<string, string> = {}): Promise<string> {
    const inputId = await uploadInput();
    const res = await fetch(`${mock.url}/v1/batches`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({
        input_file_id: inputId,
        endpoint: "/v1/chat/completions",
        completion_window: "24h",
      }),
    });
    return ((await res.json()) as { id: string }).id;
  }

  async function retrieve(id: string): Promise<Record<string, unknown>> {
    return (await (await fetch(`${mock.url}/v1/batches/${id}`)).json()) as Record<string, unknown>;
  }

  it("stamps request_counts.total from the input file when the batch enters in_progress", async () => {
    const id = await createBatch();
    const first = await retrieve(id);
    expect(first["status"]).toBe("in_progress");
    expect(first["request_counts"]).toEqual({ total: 2, completed: 0, failed: 0 });
  });

  it("route-cancelled batches report the same request_counts as header-cancelled ones", async () => {
    const routeId = await createBatch();
    await retrieve(routeId);
    const cancelRes = await post(`${mock.url}/v1/batches/${routeId}/cancel`, {});
    expect(cancelRes.status).toBe(200);
    const routeCancelled = await retrieve(routeId);
    expect(routeCancelled["status"]).toBe("cancelled");
    expect(routeCancelled["request_counts"]).toEqual({ total: 2, completed: 0, failed: 0 });

    const headerId = await createBatch({ "X-AIMock-Batch-Outcome": "cancelled" });
    await retrieve(headerId);
    const headerCancelled = await retrieve(headerId);
    expect(headerCancelled["status"]).toBe("cancelled");
    expect(headerCancelled["request_counts"]).toEqual(routeCancelled["request_counts"]);
  });

  it("cancelling straight from validating still reports the input total", async () => {
    const id = await createBatch();
    await post(`${mock.url}/v1/batches/${id}/cancel`, {});
    const cancelled = await retrieve(id);
    expect(cancelled["status"]).toBe("cancelled");
    expect(cancelled["request_counts"]).toEqual({ total: 2, completed: 0, failed: 0 });
  });

  it("leaves the completed path's request_counts unchanged", async () => {
    const id = await createBatch();
    await retrieve(id);
    const done = await retrieve(id);
    expect(done["status"]).toBe("completed");
    expect(done["request_counts"]).toEqual({ total: 2, completed: 2, failed: 0 });
  });
});

describe("Batches API output-line body per endpoint", () => {
  let mock: LLMock;

  beforeEach(async () => {
    clearBatchStore();
    clearFileStore();
    mock = new LLMock({ port: 0 });
    await mock.start();
  });

  afterEach(async () => {
    await mock.stop();
    clearBatchStore();
    clearFileStore();
  });

  async function firstOutputBody(
    endpoint: string,
    line: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const file = (await (
      await post(`${mock.url}/v1/files`, {
        purpose: "batch",
        filename: "input.jsonl",
        content: JSON.stringify(line) + "\n",
      })
    ).json()) as { id: string };
    const created = (await (
      await post(`${mock.url}/v1/batches`, {
        input_file_id: file.id,
        endpoint,
        completion_window: "24h",
      })
    ).json()) as { id: string };
    await fetch(`${mock.url}/v1/batches/${created.id}`);
    const done = (await (await fetch(`${mock.url}/v1/batches/${created.id}`)).json()) as {
      status: string;
      output_file_id: string;
    };
    expect(done.status).toBe("completed");
    const text = await (await fetch(`${mock.url}/v1/files/${done.output_file_id}/content`)).text();
    const first = JSON.parse(text.split("\n")[0]!) as {
      response: { body: Record<string, unknown> };
    };
    return first.response.body;
  }

  it("writes Response objects, not chat completions, for a /v1/responses batch", async () => {
    // Shape: `Response` in openai@4.104.0 `resources/responses/responses.d.ts`
    // (`object: "response"`, `status`, `output: ResponseOutputMessage[]` with
    // `content: ResponseOutputText[]`, `usage: ResponseUsage`).
    const body = await firstOutputBody("/v1/responses", {
      custom_id: "r-1",
      method: "POST",
      url: "/v1/responses",
      body: { model: "gpt-4o-mini", input: "hi" },
    });
    expect(body["object"]).toBe("response");
    expect(body["id"]).toMatch(/^resp/);
    expect(body["status"]).toBe("completed");
    expect(body["model"]).toBe("gpt-4o-mini");
    expect(body).not.toHaveProperty("choices");
    const output = body["output"] as Record<string, unknown>[];
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({ type: "message", role: "assistant", status: "completed" });
    expect(output[0]!["content"]).toEqual([
      { type: "output_text", text: expect.any(String), annotations: [] },
    ]);
    expect(body["usage"]).toMatchObject({
      input_tokens: expect.any(Number),
      output_tokens: expect.any(Number),
      total_tokens: expect.any(Number),
    });
  });

  it("keeps chat.completion bodies for a /v1/chat/completions batch", async () => {
    const body = await firstOutputBody("/v1/chat/completions", {
      custom_id: "c-1",
      method: "POST",
      url: "/v1/chat/completions",
      body: { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] },
    });
    expect(body["object"]).toBe("chat.completion");
    expect(body["id"]).toMatch(/^chatcmpl/);
    expect(Array.isArray(body["choices"])).toBe(true);
    expect(body).not.toHaveProperty("output");
  });
});

describe("Batches output files honour the Files store byte cap", () => {
  let mock: LLMock;

  beforeEach(async () => {
    clearBatchStore();
    clearFileStore();
    mock = new LLMock({ port: 0 });
    await mock.start();
  });

  afterEach(async () => {
    await mock.stop();
    clearBatchStore();
    clearFileStore();
  });

  async function upload(content: string): Promise<{ id: string; bytes: number }> {
    return (await (
      await post(`${mock.url}/v1/files`, { purpose: "batch", filename: "input.jsonl", content })
    ).json()) as { id: string; bytes: number };
  }

  async function runBatch(
    inputFileId: string,
    headers: Record<string, string> = {},
  ): Promise<Record<string, unknown>> {
    const created = (await (
      await fetch(`${mock.url}/v1/batches`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({
          input_file_id: inputFileId,
          endpoint: "/v1/chat/completions",
          completion_window: "24h",
        }),
      })
    ).json()) as { id: string };
    await fetch(`${mock.url}/v1/batches/${created.id}`);
    return (await (await fetch(`${mock.url}/v1/batches/${created.id}`)).json()) as Record<
      string,
      unknown
    >;
  }

  async function fileBytes(fileId: string): Promise<number> {
    const res = await fetch(`${mock.url}/v1/files/${fileId}`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { bytes: number }).bytes;
  }

  // 30,000 three-byte `{}` lines is a 90 KB input — far under the upload cap —
  // but every line mints a ~430-byte canned response line, so the output
  // would be ~13 MB: over FILES_MAX_BYTES by itself.
  const OVER_CAP_INPUT = "{}\n".repeat(30_000);

  it("fails a batch whose output would exceed FILES_MAX_BYTES instead of storing it", async () => {
    const input = await upload(OVER_CAP_INPUT);
    expect(input.bytes).toBeLessThan(FILES_MAX_BYTES);

    const done = await runBatch(input.id);
    expect(done["status"]).toBe("failed");
    expect(done["output_file_id"]).toBeUndefined();
    expect(typeof done["failed_at"]).toBe("number");
    expect(done["request_counts"]).toEqual({ total: 30_000, completed: 0, failed: 30_000 });
    const errors = done["errors"] as { object: string; data: Record<string, unknown>[] };
    expect(errors.object).toBe("list");
    expect(errors.data).toHaveLength(1);
    expect(errors.data[0]!["code"]).toBe("output_file_too_large");
    expect(errors.data[0]!["message"]).toContain(`${FILES_MAX_BYTES}`);
  });

  it("applies the same cap to the error file of a header-failed batch", async () => {
    // An error line is ~160 bytes, so it takes 100,000 lines (a 300 KB input)
    // to push the error file over the cap.
    const input = await upload("{}\n".repeat(100_000));
    expect(input.bytes).toBeLessThan(FILES_MAX_BYTES);
    const done = await runBatch(input.id, { "X-AIMock-Batch-Outcome": "failed" });
    expect(done["status"]).toBe("failed");
    expect(done["error_file_id"]).toBeUndefined();
    const errors = done["errors"] as { data: Record<string, unknown>[] };
    expect(errors.data).toHaveLength(1);
    expect(errors.data[0]!["code"]).toBe("output_file_too_large");
  });

  it("never leaves a file over FILES_MAX_BYTES in the store", async () => {
    const input = await upload(OVER_CAP_INPUT);
    await runBatch(input.id);
    await runBatch(input.id, { "X-AIMock-Batch-Outcome": "failed" });
    const list = (await (await fetch(`${mock.url}/v1/files`)).json()) as {
      data: { id: string; bytes: number }[];
    };
    expect(list.data.length).toBeGreaterThan(0);
    for (const f of list.data) {
      expect(f.bytes).toBeLessThanOrEqual(FILES_MAX_BYTES);
    }
  });

  it("leaves a small batch unchanged: two output lines whose custom_ids match", async () => {
    const lines = ["a-1", "a-2"].map((custom_id) =>
      JSON.stringify({
        custom_id,
        method: "POST",
        url: "/v1/chat/completions",
        body: { model: "gpt-4o-mini", messages: [] },
      }),
    );
    const input = await upload(lines.join("\n") + "\n");
    const done = await runBatch(input.id);
    expect(done["status"]).toBe("completed");
    expect(done["request_counts"]).toEqual({ total: 2, completed: 2, failed: 0 });
    const outId = done["output_file_id"] as string;
    const bytes = await fileBytes(outId);
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThanOrEqual(FILES_MAX_BYTES);
    const text = await (await fetch(`${mock.url}/v1/files/${outId}/content`)).text();
    const out = text
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { custom_id: string });
    expect(out.map((l) => l.custom_id)).toEqual(["a-1", "a-2"]);
  });
});

describe("Batches failed outcome keeps `errors` small and bounded", () => {
  let mock: LLMock;

  beforeEach(async () => {
    clearBatchStore();
    clearFileStore();
    mock = new LLMock({ port: 0 });
    await mock.start();
  });

  afterEach(async () => {
    await mock.stop();
    clearBatchStore();
    clearFileStore();
  });

  const N = 2000;
  const INPUT =
    Array.from({ length: N }, (_, i) =>
      JSON.stringify({
        custom_id: `r-${i}`,
        method: "POST",
        url: "/v1/chat/completions",
        body: { model: "gpt-4o-mini", messages: [] },
      }),
    ).join("\n") + "\n";

  async function failedBatch(): Promise<{ id: string; text: string }> {
    const file = (await (
      await post(`${mock.url}/v1/files`, {
        purpose: "batch",
        filename: "input.jsonl",
        content: INPUT,
      })
    ).json()) as { id: string };
    const created = (await (
      await fetch(`${mock.url}/v1/batches`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-AIMock-Batch-Outcome": "failed" },
        body: JSON.stringify({
          input_file_id: file.id,
          endpoint: "/v1/chat/completions",
          completion_window: "24h",
        }),
      })
    ).json()) as { id: string };
    await fetch(`${mock.url}/v1/batches/${created.id}`);
    const text = await (await fetch(`${mock.url}/v1/batches/${created.id}`)).text();
    return { id: created.id, text };
  }

  it("does not put one `errors` entry per input request on the batch object", async () => {
    const { text } = await failedBatch();
    const done = JSON.parse(text) as {
      status: string;
      errors: { object: string; data: { code: string; message: string; line: unknown }[] };
      request_counts: { total: number; completed: number; failed: number };
    };
    expect(done.status).toBe("failed");
    // Retrieve body stays well under 10 KB no matter how many lines the input had.
    expect(Buffer.byteLength(text)).toBeLessThan(10_000);
    expect(done.errors.object).toBe("list");
    expect(done.errors.data).toHaveLength(1);
    expect(done.errors.data[0].code).toBe("mock_failure");
    expect(done.errors.data[0].message).toContain("error_file_id");
    expect(done.errors.data[0].line).toBeNull();
    // The per-request count and the per-request error file are untouched.
    expect(done.request_counts).toEqual({ total: N, completed: 0, failed: N });
  });

  it("still writes one error-file line per request", async () => {
    const { text } = await failedBatch();
    const done = JSON.parse(text) as { error_file_id: string };
    const body = await (await fetch(`${mock.url}/v1/files/${done.error_file_id}/content`)).text();
    expect(body.split("\n").filter((l) => l.length > 0)).toHaveLength(N);
  });

  it("keeps a list page small after a large failed batch", async () => {
    await failedBatch();
    const page = await (await fetch(`${mock.url}/v1/batches`)).text();
    expect(Buffer.byteLength(page)).toBeLessThan(10_000);
    const parsed = JSON.parse(page) as { data: { errors: { data: unknown[] } }[] };
    expect(parsed.data).toHaveLength(1);
    expect(parsed.data[0].errors.data).toHaveLength(1);
  });
});
