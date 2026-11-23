import net from "node:net";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { LLMock } from "../llmock.js";
import { clearFineTuningStore } from "../fine-tuning.js";
import { normalizePathLabel } from "../metrics.js";

const JSON_HEADERS = { "Content-Type": "application/json" };

/**
 * Send a request and read its body to completion as text.
 *
 * Every request this file makes goes through here, because every request must
 * end in a consumed body: an unread `Response` pins its undici socket until GC,
 * and those sockets outlive `mock.stop()`, so the teardown that is supposed to
 * close the server instead races a live connection. Returning the status
 * alongside the body is what lets a call site assert both without ever holding
 * an undrained `Response`.
 *
 * `headers` is returned as a plain snapshot for the same reason: a test that
 * cares about a response header (CORS, say) would otherwise have to hold the
 * `Response` itself, which is the undrained-socket hazard this helper exists
 * to prevent.
 */
async function send(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; text: string; headers: Record<string, string> }> {
  const res = await fetch(url, init);
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return { status: res.status, text: await res.text(), headers };
}

/** Every `access-control-*` header on a response, lowercased. */
function corsHeadersOf(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([key]) => key.startsWith("access-control-")),
  );
}

type Wire<T> = { status: number; body: T };

/** `send`, with the body parsed as JSON. */
async function call<T = unknown>(url: string, init?: RequestInit): Promise<Wire<T>> {
  const { status, text } = await send(url, init);
  return { status, body: (text.length === 0 ? null : JSON.parse(text)) as T };
}

/** `call` with a JSON request body. */
async function post<T = unknown>(url: string, body: unknown): Promise<Wire<T>> {
  return call<T>(url, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
}

type WireEvent = { id: string; created_at: number; message: string };

async function createJob(base: string): Promise<string> {
  const res = await post<{ id: string }>(`${base}/v1/fine_tuning/jobs`, {
    training_file: "f",
    model: "gpt-4o-mini",
  });
  expect(res.status).toBe(200);
  return res.body.id;
}

/**
 * The job's event history in append order (oldest first). The wire page is
 * newest-first, so this reverses it; assertions here read as history.
 *
 * The status is asserted here rather than left to the caller: without it a
 * route regression (a 404, or a 400 on the `limit`) reaches the caller as
 * "page.data is not iterable", which names the helper instead of the bug.
 */
async function eventsOf(base: string, id: string): Promise<WireEvent[]> {
  const page = await call<{ data: WireEvent[] }>(
    `${base}/v1/fine_tuning/jobs/${id}/events?limit=100`,
  );
  expect(page.status).toBe(200);
  return [...page.body.data].reverse();
}

describe("Fine-tuning mock", () => {
  let mock: LLMock;
  beforeEach(async () => {
    clearFineTuningStore();
    mock = new LLMock({ port: 0 });
    await mock.start();
  });
  afterEach(async () => {
    await mock.stop();
    clearFineTuningStore();
  });

  it("creates and advances to succeeded with a fine-tuned model", async () => {
    const created = await post<{ id: string; status: string }>(`${mock.url}/v1/fine_tuning/jobs`, {
      training_file: "file-train",
      model: "gpt-4o-mini",
    });
    expect(created.status).toBe(200);
    const id = created.body.id;
    expect(created.body.status).toBe("validating_files");
    expect(await call<{ status: string }>(`${mock.url}/v1/fine_tuning/jobs/${id}`)).toMatchObject({
      status: 200,
      body: { status: "queued" },
    });
    expect(await call<{ status: string }>(`${mock.url}/v1/fine_tuning/jobs/${id}`)).toMatchObject({
      status: 200,
      body: { status: "running" },
    });
    const done = await call<{ status: string; fine_tuned_model: string }>(
      `${mock.url}/v1/fine_tuning/jobs/${id}`,
    );
    expect(done.status).toBe(200);
    expect(done.body.status).toBe("succeeded");
    expect(done.body.fine_tuned_model.startsWith("ft:gpt-4o-mini")).toBe(true);

    const events = await call<{
      object: string;
      has_more: boolean;
      data: Record<string, unknown>[];
    }>(`${mock.url}/v1/fine_tuning/jobs/${id}/events`);
    expect(events.status).toBe(200);
    expect(events.body.object).toBe("list");
    expect(events.body.has_more).toBe(false);
    // The progression is deterministic, so the event log is exactly these four
    // messages in this order. A length floor would let a duplicated or
    // reordered log through, which is the whole failure this pins. The page is
    // served newest-first, so the append order reads out reversed.
    expect([...events.body.data].reverse().map((ev) => ev.message)).toEqual([
      "Job created, validating training file",
      "Training file validated, job queued",
      "Training started",
      `Training complete, model ${done.body.fine_tuned_model}`,
    ]);
    // openai-openapi v2.3.0 FineTuningJobEvent required set; corroborated by
    // openai SDK 4.104.0 resources/fine-tuning/jobs/jobs.d.ts. `type` is
    // optional on the wire but required by our exported FineTuningJobEvent,
    // so every synthesized event has to carry it. The set is exact, not a
    // superset: the wire shape is what drift protects, and an extra key is
    // drift.
    const EVENT_KEYS = ["created_at", "id", "level", "message", "object", "type"];
    for (const ev of events.body.data) {
      expect(Object.keys(ev).sort()).toEqual(EVENT_KEYS);
      expect(ev.object).toBe("fine_tuning.job.event");
      expect(ev.level).toBe("info");
      expect(ev.type).toBe("message");
      expect(typeof ev.id).toBe("string");
      expect(String(ev.id).startsWith("ftevent-")).toBe(true);
      expect(typeof ev.created_at).toBe("number");
    }
    // Event ids are stable across polls of the same job.
    const again = await call<{ data: { id: string }[] }>(
      `${mock.url}/v1/fine_tuning/jobs/${id}/events`,
    );
    expect(again.status).toBe(200);
    expect(again.body.data.map((e) => e.id)).toEqual(events.body.data.map((e) => e.id));
    // has_more is computed, not constant: one page short of the full set.
    const page = await call<{ has_more: boolean; data: { id: string }[] }>(
      `${mock.url}/v1/fine_tuning/jobs/${id}/events?limit=1`,
    );
    expect(page.status).toBe(200);
    expect(page.body.data).toHaveLength(1);
    expect(page.body.has_more).toBe(true);
    const next = await call<{ has_more: boolean; data: { id: string }[] }>(
      `${mock.url}/v1/fine_tuning/jobs/${id}/events?after=${page.body.data[0].id}&limit=99`,
    );
    expect(next.status).toBe(200);
    expect(next.body.data.map((e) => e.id)).toEqual(events.body.data.slice(1).map((e) => e.id));
    expect(next.body.has_more).toBe(false);
  });

  it("treats every terminal status identically on cancel", async () => {
    const cancelledId = await createJob(mock.url);
    const first = await post<{ status: string; created_at: number; finished_at?: number | null }>(
      `${mock.url}/v1/fine_tuning/jobs/${cancelledId}/cancel`,
      {},
    );
    expect(first.status).toBe(200);
    expect(first.body.status).toBe("cancelled");
    // A cancelled job has stopped running, so `finished_at` is a real epoch
    // second rather than absent/null - the same stamp `succeeded` gets.
    // (openai-openapi v2.3.0 and openai SDK 4.104.0 both type `finished_at`
    // as null only while the job is still running.)
    expect(typeof first.body.finished_at).toBe("number");
    expect(first.body.finished_at).toBeGreaterThanOrEqual(first.body.created_at);

    // `cancelled` is terminal, so a repeat cancel is rejected exactly the way a
    // cancel of a `succeeded` job is: one shared terminal set, one behaviour.
    const repeat = await post(`${mock.url}/v1/fine_tuning/jobs/${cancelledId}/cancel`, {});
    expect(repeat.status).toBe(400);
    expect(repeat.body).toEqual({
      error: {
        message: `Job ${cancelledId} is already terminal (cancelled)`,
        type: "invalid_request_error",
      },
    });

    // Control: the `succeeded` arm of the same set still rejects.
    const succeededId = await createJob(mock.url);
    for (let i = 0; i < 3; i++) {
      expect((await call(`${mock.url}/v1/fine_tuning/jobs/${succeededId}`)).status).toBe(200);
    }
    const settled = await call<{ status: string }>(
      `${mock.url}/v1/fine_tuning/jobs/${succeededId}`,
    );
    expect(settled.status).toBe(200);
    expect(settled.body.status).toBe("succeeded");
    const onSucceeded = await post(`${mock.url}/v1/fine_tuning/jobs/${succeededId}/cancel`, {});
    expect(onSucceeded.status).toBe(400);
    expect(onSucceeded.body).toEqual({
      error: {
        message: `Job ${succeededId} is already terminal (succeeded)`,
        type: "invalid_request_error",
      },
    });

    // And a cancelled job stops advancing, so the shared set governs retrieve too.
    const afterCancel = await call<{ status: string }>(
      `${mock.url}/v1/fine_tuning/jobs/${cancelledId}`,
    );
    expect(afterCancel.status).toBe(200);
    expect(afterCancel.body.status).toBe("cancelled");
  });

  it("lists and cursor-paginates jobs", async () => {
    const a = await post<{ id: string }>(`${mock.url}/v1/fine_tuning/jobs`, {
      training_file: "f1",
      model: "gpt-4o",
    });
    expect(a.status).toBe(200);
    const b = await post<{ id: string }>(`${mock.url}/v1/fine_tuning/jobs`, {
      training_file: "f2",
      model: "gpt-4o",
    });
    expect(b.status).toBe(200);
    const list = await call<{ object: string; has_more: boolean; data: { id: string }[] }>(
      `${mock.url}/v1/fine_tuning/jobs`,
    );
    expect(list.status).toBe(200);
    // Exact membership AND order: newest-first, so `b` leads. `arrayContaining`
    // would pass on a reversed list or on one carrying a stray extra job.
    expect(list.body.data.map((d) => d.id)).toEqual([b.body.id, a.body.id]);
    // ListPaginatedFineTuningJobsResponse requires has_more (openai-openapi v2.3.0).
    expect(list.body.object).toBe("list");
    expect(list.body.has_more).toBe(false);
    const firstPage = await call<{ has_more: boolean; data: { id: string }[] }>(
      `${mock.url}/v1/fine_tuning/jobs?limit=1`,
    );
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.data.map((d) => d.id)).toEqual([b.body.id]);
    expect(firstPage.body.has_more).toBe(true);
    const secondPage = await call<{ has_more: boolean; data: { id: string }[] }>(
      `${mock.url}/v1/fine_tuning/jobs?after=${firstPage.body.data[0].id}`,
    );
    expect(secondPage.status).toBe(200);
    // The expected tail, not `list.data.slice(1)` — comparing the response to
    // the response it was derived from asserts nothing about the order.
    expect(secondPage.body.data.map((d) => d.id)).toEqual([a.body.id]);
    expect(secondPage.body.has_more).toBe(false);
  });

  it("rejects creates missing training_file or model and 404s an unknown job", async () => {
    expect((await post(`${mock.url}/v1/fine_tuning/jobs`, { model: "gpt-4o" })).status).toBe(400);
    expect((await post(`${mock.url}/v1/fine_tuning/jobs`, { training_file: "f" })).status).toBe(
      400,
    );
    expect((await call(`${mock.url}/v1/fine_tuning/jobs/ftjob-nope`)).status).toBe(404);
  });

  it("404s cancel and events for a job that does not exist", async () => {
    // Retrieve already 404s; cancel and events are separate handlers with their
    // own lookup, so each needs its own proof rather than inheriting retrieve's.
    for (const res of [
      await post(`${mock.url}/v1/fine_tuning/jobs/ftjob-missing/cancel`, {}),
      await call(`${mock.url}/v1/fine_tuning/jobs/ftjob-missing/events`),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual({
        error: {
          message: "No such fine-tuning job: ftjob-missing",
          type: "invalid_request_error",
        },
      });
    }
  });

  it("keeps a terminal job frozen across further polls", async () => {
    const succeededId = await createJob(mock.url);
    for (let i = 0; i < 3; i++) {
      expect((await call(`${mock.url}/v1/fine_tuning/jobs/${succeededId}`)).status).toBe(200);
    }
    const settled = await call<Record<string, unknown>>(
      `${mock.url}/v1/fine_tuning/jobs/${succeededId}`,
    );
    expect(settled.status).toBe(200);
    expect(settled.body.status).toBe("succeeded");
    // Every later poll returns a byte-identical job: no restamped finished_at,
    // no regenerated fine_tuned_model, no status churn.
    for (let i = 0; i < 3; i++) {
      expect(
        await call<Record<string, unknown>>(`${mock.url}/v1/fine_tuning/jobs/${succeededId}`),
      ).toEqual(settled);
    }

    // A job cancelled mid-run is terminal too: polling must not walk it back
    // onto the queued/running ladder.
    const runningId = await createJob(mock.url);
    expect((await call(`${mock.url}/v1/fine_tuning/jobs/${runningId}`)).status).toBe(200);
    expect((await call(`${mock.url}/v1/fine_tuning/jobs/${runningId}`)).status).toBe(200);
    expect((await post(`${mock.url}/v1/fine_tuning/jobs/${runningId}/cancel`, {})).status).toBe(
      200,
    );
    for (let i = 0; i < 3; i++) {
      const polled = await call<{ status: string }>(`${mock.url}/v1/fine_tuning/jobs/${runningId}`);
      expect(polled.status).toBe(200);
      expect(polled.body.status).toBe("cancelled");
    }
  });

  it("rejects malformed JSON and non-object create bodies", async () => {
    const malformed = await call<{ error: { message: string; type: string } }>(
      `${mock.url}/v1/fine_tuning/jobs`,
      { method: "POST", headers: JSON_HEADERS, body: "{not json" },
    );
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.type).toBe("invalid_request_error");
    expect(malformed.body.error.message.startsWith("Malformed JSON: ")).toBe(true);

    // A parseable body that is not a JSON object gets the repo-wide envelope,
    // not a misleading "'training_file' must be a non-empty string" — an array
    // and a bare string both read as "missing field" without the guard.
    for (const raw of ["[1,2,3]", '"training_file"', "42", "null"]) {
      const res = await call(`${mock.url}/v1/fine_tuning/jobs`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: raw,
      });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: { message: "Request body must be a JSON object", type: "invalid_request_error" },
      });
    }
  });

  it("gates every fine-tuning route on chaos and journals the fault", async () => {
    // Per-request chaos header, so each route is proven to run the gate before
    // its own handler. rateLimit is the cleanest probe: it answers 429 without
    // tearing the socket down, so the body is readable on every route.
    const chaos = { ...JSON_HEADERS, "x-aimock-chaos-ratelimit": "1" };
    // The create body is a VALID one. `{}` would be rejected by the validator
    // anyway, so the "never reached the store" check below would hold with the
    // gate deleted and prove nothing about ordering.
    const validCreate = JSON.stringify({ training_file: "f", model: "gpt-4o-mini" });
    const routes: [string, RequestInit][] = [
      [`${mock.url}/v1/fine_tuning/jobs`, { method: "POST", headers: chaos, body: validCreate }],
      [`${mock.url}/v1/fine_tuning/jobs`, { headers: chaos }],
      [`${mock.url}/v1/fine_tuning/jobs/ftjob-x`, { headers: chaos }],
      [
        `${mock.url}/v1/fine_tuning/jobs/ftjob-x/cancel`,
        { method: "POST", headers: chaos, body: "{}" },
      ],
      [`${mock.url}/v1/fine_tuning/jobs/ftjob-x/events`, { headers: chaos }],
    ];
    for (const [url, init] of routes) {
      const res = await call(url, init);
      expect(res.status).toBe(429);
      expect(res.body).toMatchObject({ error: { code: "chaos_ratelimit" } });
    }

    // The gate fires BEFORE the handler: the faulted create carried a body the
    // handler would have accepted, so the only thing that can have kept it out
    // of the store is the gate running first.
    const listed = await call<{ data: unknown[] }>(`${mock.url}/v1/fine_tuning/jobs`);
    expect(listed.status).toBe(200);
    expect(listed.body.data, "CHAOS_GATE_RAN_AFTER_HANDLER").toEqual([]);

    const journal = await call<
      { path: string; response: { status: number; chaosAction?: string } }[]
    >(`${mock.url}/__aimock/journal`);
    expect(journal.status).toBe(200);
    const faulted = journal.body.filter((e) => e.response.chaosAction !== undefined);
    expect(faulted).toHaveLength(routes.length);
    expect(faulted.every((e) => e.path.includes("/v1/fine_tuning/jobs"))).toBe(true);
    expect(faulted.every((e) => e.response.chaosAction === "rateLimit")).toBe(true);
    expect(faulted.every((e) => e.response.status === 429)).toBe(true);
  });

  it("journals exactly one entry per fine-tuning request", async () => {
    // PR #441 invariant. The expected count is derived from the request list,
    // so inserting or removing a request here cannot leave a stale tally behind.
    const requests: (() => Promise<Wire<unknown>>)[] = [
      () => post(`${mock.url}/v1/fine_tuning/jobs`, { training_file: "f1", model: "gpt-4o" }),
      () => post(`${mock.url}/v1/fine_tuning/jobs`, { training_file: "f2", model: "gpt-4o" }),
      () => call(`${mock.url}/v1/fine_tuning/jobs`),
      () => call(`${mock.url}/v1/fine_tuning/jobs?limit=1`),
      () => post(`${mock.url}/v1/fine_tuning/jobs`, { model: "gpt-4o" }),
      () => post(`${mock.url}/v1/fine_tuning/jobs`, { training_file: "f" }),
      () => call(`${mock.url}/v1/fine_tuning/jobs/ftjob-nope`),
    ];
    for (const sendOne of requests) await sendOne();
    expect(
      (await call<unknown[]>(`${mock.url}/__aimock/journal?service=fine-tuning`)).body,
    ).toHaveLength(requests.length);

    // And exactly one entry for a single isolated request.
    expect((await call(`${mock.url}/__aimock/reset`, { method: "POST" })).status).toBe(200);
    expect((await call(`${mock.url}/v1/fine_tuning/jobs`)).status).toBe(200);
    expect(
      (await call<unknown[]>(`${mock.url}/__aimock/journal?service=fine-tuning`)).body,
    ).toHaveLength(1);
  });

  it("clears the job store on reset", async () => {
    await createJob(mock.url);
    expect((await call(`${mock.url}/__aimock/reset`, { method: "POST" })).status).toBe(200);
    const listed = await call<{ data: unknown[] }>(`${mock.url}/v1/fine_tuning/jobs`);
    expect(listed.status).toBe(200);
    expect(listed.body.data).toEqual([]);
  });

  // Pagination rules sourced from openai/openai-openapi v2.3.0 (`limit` is
  // `type: integer, default: 20` on both list endpoints) plus three rules the
  // spec leaves open and `paginate()` documents as ours: a 1..100 bound on
  // `limit`, a 400 on an `after` that matches nothing, and newest-first order.
  describe("list pagination", () => {
    type ListPage<T> = { object: string; data: T[]; has_more: boolean };

    async function getPage<T>(url: string): Promise<ListPage<T>> {
      const res = await call<ListPage<T>>(url);
      expect(res.status).toBe(200);
      return res.body;
    }

    async function walk(base: string, limit: number): Promise<string[]> {
      const seen: string[] = [];
      let after: string | null = null;
      for (let page = 0; page < 200; page++) {
        const body: ListPage<{ id: string }> = await getPage<{ id: string }>(
          `${base}${base.includes("?") ? "&" : "?"}limit=${limit}${after === null ? "" : `&after=${after}`}`,
        );
        seen.push(...body.data.map((d) => d.id));
        if (!body.has_more) return seen;
        // A page that promises more while handing back nothing has no cursor to
        // resume from. Named here rather than left to crash on `undefined.id`,
        // which reports the walk helper instead of the page that lied.
        const last = body.data[body.data.length - 1];
        if (last === undefined) {
          throw new Error(
            `EMPTY_PAGE_WITH_HAS_MORE: page ${page} of ${base} returned 0 items with has_more=true`,
          );
        }
        after = last.id;
      }
      throw new Error("cursor walk did not terminate");
    }

    it("defaults to 20, orders newest-first and computes has_more over 25 jobs", async () => {
      const ids: string[] = [];
      for (let i = 0; i < 25; i++) {
        const res = await post<{ id: string }>(`${mock.url}/v1/fine_tuning/jobs`, {
          training_file: `f${i}`,
          model: "gpt-4o",
        });
        expect(res.status).toBe(200);
        ids.push(res.body.id);
      }
      const newestFirst = [...ids].reverse();
      // No `limit`: the vendor default of 20 applies, so has_more is true.
      const page = await getPage<{ id: string }>(`${mock.url}/v1/fine_tuning/jobs`);
      expect(page.data).toHaveLength(20);
      expect(page.has_more).toBe(true);
      expect(page.data.map((d) => d.id)).toEqual(newestFirst.slice(0, 20));

      const second = await getPage<{ id: string }>(
        `${mock.url}/v1/fine_tuning/jobs?after=${page.data[19].id}`,
      );
      expect(second.data.map((d) => d.id)).toEqual(newestFirst.slice(20));
      expect(second.has_more).toBe(false);

      // A cursor walk visits every job exactly once and terminates.
      const walked = await walk(`${mock.url}/v1/fine_tuning/jobs`, 2);
      expect(walked).toEqual(newestFirst);
      expect(new Set(walked).size).toBe(25);
    });

    it("rejects an unknown `after` cursor with 400 on both list endpoints", async () => {
      const id = await createJob(mock.url);

      for (const url of [
        `${mock.url}/v1/fine_tuning/jobs?after=ftjob-bogus`,
        `${mock.url}/v1/fine_tuning/jobs/${id}/events?after=ftjob-bogus`,
      ]) {
        const res = await call<{ error: { message: string; type: string } }>(url);
        expect(res.status).toBe(400);
        expect(res.body.error.type).toBe("invalid_request_error");
        expect(res.body.error.message).toContain("after");
        // The rejection names the offending cursor.
        expect(res.body.error.message).toContain("ftjob-bogus");
      }
    });

    it("rejects a non-integer or out-of-range `limit` with 400 on both list endpoints", async () => {
      const id = await createJob(mock.url);
      const bases = [
        `${mock.url}/v1/fine_tuning/jobs`,
        `${mock.url}/v1/fine_tuning/jobs/${id}/events`,
      ];
      for (const base of bases) {
        for (const bad of ["0", "-1", "1.5", "abc", "101", ""]) {
          const res = await call<{ error: { message: string } }>(`${base}?limit=${bad}`);
          expect(res.status, `limit=${bad}`).toBe(400);
          expect(res.body.error.message).toContain("limit");
        }
        // The bounds themselves are accepted.
        for (const ok of ["1", "100"]) {
          expect((await call(`${base}?limit=${ok}`)).status, `limit=${ok}`).toBe(200);
        }
      }
    });

    it("orders events newest-first and walks them exactly once", async () => {
      const id = await createJob(mock.url);
      for (let i = 0; i < 3; i++) {
        expect((await call(`${mock.url}/v1/fine_tuning/jobs/${id}`)).status).toBe(200);
      }
      const events = await getPage<{ id: string; created_at: number; message: string }>(
        `${mock.url}/v1/fine_tuning/jobs/${id}/events`,
      );
      const times = events.data.map((e) => e.created_at);
      // Exactly four: create, queued, running, succeeded. The progression is
      // deterministic, so a floor here would let a duplicated event through.
      expect(times).toHaveLength(4);
      // Newest-first, asserted against the append sequence rather than against
      // `created_at`: all four events are stamped inside the same second, so a
      // comparison on `created_at` holds for every permutation of the page and
      // says nothing about its order. The message text IS the append position.
      // (That the stamps never run backwards is the clock's own guarantee and
      // is pinned with a driven clock in the module-wide clock block below.)
      expect(
        events.data.map((e) => e.message.replace(/, model .*$/, "")),
        "EVENTS_NOT_NEWEST_FIRST",
      ).toEqual([
        "Training complete",
        "Training started",
        "Training file validated, job queued",
        "Job created, validating training file",
      ]);
      expect(events.has_more).toBe(false);

      const walked = await walk(`${mock.url}/v1/fine_tuning/jobs/${id}/events`, 1);
      expect(walked).toEqual(events.data.map((e) => e.id));
      expect(new Set(walked).size).toBe(walked.length);
    });
  });

  // The event list is an append-only log of what actually happened, not a
  // rendering of the job's current status. Three properties pin that.
  it("keeps the real prefix and stable ids when a running job is cancelled", async () => {
    const id = await createJob(mock.url);
    // These retrieves are the test's precondition, not incidental traffic: if
    // either stops answering 200 the job never reaches `running` and the
    // failure would otherwise surface at the message assertion below.
    expect((await call(`${mock.url}/v1/fine_tuning/jobs/${id}`)).status).toBe(200); // -> queued
    expect((await call(`${mock.url}/v1/fine_tuning/jobs/${id}`)).status).toBe(200); // -> running
    const before = await eventsOf(mock.url, id);
    expect(before.map((e) => e.message)).toEqual([
      "Job created, validating training file",
      "Training file validated, job queued",
      "Training started",
    ]);

    expect((await post(`${mock.url}/v1/fine_tuning/jobs/${id}/cancel`, {})).status).toBe(200);
    const after = await eventsOf(mock.url, id);
    // The prefix survives verbatim -- same ids bound to the same messages --
    // and the cancel is appended after it rather than overwriting it.
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after).toHaveLength(before.length + 1);
    expect(after[after.length - 1].message).toBe("Job cancelled by user");
    // No id is ever reused for a different message.
    expect(new Set(after.map((e) => e.id)).size).toBe(after.length);
    // ...and ids are still stable on a re-read after the cancel.
    expect(await eventsOf(mock.url, id)).toEqual(after);
  });

  it("does not fabricate a queued event for a job cancelled while validating", async () => {
    const id = await createJob(mock.url);
    const cancelled = await post<{ status: string }>(
      `${mock.url}/v1/fine_tuning/jobs/${id}/cancel`,
      {},
    );
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe("cancelled");
    const events = await eventsOf(mock.url, id);
    // The job never left validating_files, so the queued transition must not
    // appear in its history.
    expect(events.map((e) => e.message)).toEqual([
      "Job created, validating training file",
      "Job cancelled by user",
    ]);
  });

  it("timestamps events monotonically, never in the future or past finished_at", async () => {
    const id = await createJob(mock.url);
    expect((await call(`${mock.url}/v1/fine_tuning/jobs/${id}`)).status).toBe(200);
    expect((await call(`${mock.url}/v1/fine_tuning/jobs/${id}`)).status).toBe(200);
    const done = await call<{ status: string; created_at: number; finished_at: number }>(
      `${mock.url}/v1/fine_tuning/jobs/${id}`,
    );
    expect(done.status).toBe(200);
    expect(done.body.status).toBe("succeeded");
    const now = Math.floor(Date.now() / 1000);
    const events = await eventsOf(mock.url, id);
    expect(events).toHaveLength(4);
    for (const [i, ev] of events.entries()) {
      expect(ev.created_at).toBeGreaterThanOrEqual(done.body.created_at);
      expect(ev.created_at).toBeLessThanOrEqual(done.body.finished_at);
      expect(ev.created_at).toBeLessThanOrEqual(now);
      if (i > 0) expect(ev.created_at).toBeGreaterThanOrEqual(events[i - 1].created_at);
    }
  });

  // openai-openapi v2.3.0 `FineTuningJob.required`; identical to the non-optional
  // members of openai SDK 4.104.0 resources/fine-tuning/jobs/jobs.d.ts FineTuningJob.
  const JOB_REQUIRED = [
    "created_at",
    "error",
    "fine_tuned_model",
    "finished_at",
    "hyperparameters",
    "id",
    "model",
    "object",
    "organization_id",
    "result_files",
    "seed",
    "status",
    "trained_tokens",
    "training_file",
    "validation_file",
  ];

  it("emits every required job field and validates hyperparameters and validation_file", async () => {
    const created = await post<Record<string, unknown>>(`${mock.url}/v1/fine_tuning/jobs`, {
      training_file: "file-train",
      model: "gpt-4o-mini",
    });
    expect(created.status).toBe(200);
    const id = String(created.body.id);
    expect(Object.keys(created.body).sort()).toEqual(JOB_REQUIRED);
    // Nullable-but-required fields are present as null until the lifecycle fills them.
    expect(created.body.error).toBeNull();
    expect(created.body.fine_tuned_model).toBeNull();
    expect(created.body.finished_at).toBeNull();
    expect(created.body.trained_tokens).toBeNull();
    expect(created.body.validation_file).toBeNull();
    expect(created.body.hyperparameters).toEqual({});
    expect(created.body.result_files).toEqual([]);
    expect(typeof created.body.organization_id).toBe("string");
    expect(Number.isInteger(created.body.seed)).toBe(true);
    // The seed is derived from the job id, so it is stable across reads.
    const reread = await call<Record<string, unknown>>(`${mock.url}/v1/fine_tuning/jobs/${id}`);
    expect(reread.status).toBe(200);
    expect(reread.body.seed).toBe(created.body.seed);
    expect(Object.keys(reread.body).sort()).toEqual(JOB_REQUIRED);

    // Succeeded jobs keep the full key set and fill the success-only fields.
    expect((await call(`${mock.url}/v1/fine_tuning/jobs/${id}`)).status).toBe(200);
    const done = await call<Record<string, unknown>>(`${mock.url}/v1/fine_tuning/jobs/${id}`);
    expect(done.status).toBe(200);
    expect(done.body.status).toBe("succeeded");
    expect(Object.keys(done.body).sort()).toEqual(JOB_REQUIRED);
    expect(done.body.result_files).toHaveLength(1);
    expect(typeof done.body.trained_tokens).toBe("number");

    // "auto" is vendor-legal for every hyperparameter and is echoed back.
    const auto = await post<Record<string, unknown>>(`${mock.url}/v1/fine_tuning/jobs`, {
      training_file: "f",
      model: "m",
      validation_file: "file-valid",
      hyperparameters: { n_epochs: "auto", batch_size: 8, learning_rate_multiplier: 0.5 },
    });
    expect(auto.status).toBe(200);
    expect(auto.body.hyperparameters).toEqual({
      n_epochs: "auto",
      batch_size: 8,
      learning_rate_multiplier: 0.5,
    });
    expect(auto.body.validation_file).toBe("file-valid");

    // Bad input is rejected with a 400 naming the field, never silently dropped.
    const badHyper = await post<{ error: { message: string } }>(`${mock.url}/v1/fine_tuning/jobs`, {
      training_file: "f",
      model: "m",
      hyperparameters: { n_epochs: "abc" },
    });
    expect(badHyper.status).toBe(400);
    expect(badHyper.body.error.message).toContain("hyperparameters.n_epochs");

    const fractionalEpochs = await post(`${mock.url}/v1/fine_tuning/jobs`, {
      training_file: "f",
      model: "m",
      hyperparameters: { n_epochs: 1.5 },
    });
    expect(fractionalEpochs.status).toBe(400);

    const badHyperType = await post(`${mock.url}/v1/fine_tuning/jobs`, {
      training_file: "f",
      model: "m",
      hyperparameters: "auto",
    });
    expect(badHyperType.status).toBe(400);

    const badValidationFile = await post<{ error: { message: string } }>(
      `${mock.url}/v1/fine_tuning/jobs`,
      { training_file: "f", model: "m", validation_file: 42 },
    );
    expect(badValidationFile.status).toBe(400);
    expect(badValidationFile.body.error.message).toContain("validation_file");
  });

  it("journals the create body of an accepted, a rejected and an unparseable create", async () => {
    const sent = {
      training_file: "file-train",
      model: "gpt-4o-mini",
      validation_file: "file-val",
      hyperparameters: { n_epochs: 3 },
    };
    expect((await post(`${mock.url}/v1/fine_tuning/jobs`, sent)).status).toBe(200);
    const entries = await call<{ body: unknown; response: { source?: string } }[]>(
      `${mock.url}/__aimock/journal?service=fine-tuning`,
    );
    expect(entries.status).toBe(200);
    expect(entries.body).toHaveLength(1);
    // The body the caller sent survives into the journal verbatim, so
    // "inspect the request" works against this surface.
    expect(entries.body[0].body).toEqual(sent);
    expect(entries.body[0].response.source).toBe("internal");

    // A rejected create still records what was sent, so the caller can see why.
    expect((await call(`${mock.url}/__aimock/reset`, { method: "POST" })).status).toBe(200);
    expect((await post(`${mock.url}/v1/fine_tuning/jobs`, { model: "gpt-4o" })).status).toBe(400);
    const rejected = await call<{ body: unknown; response: { status: number } }[]>(
      `${mock.url}/__aimock/journal?service=fine-tuning`,
    );
    expect(rejected.status).toBe(200);
    expect(rejected.body[0].response.status).toBe(400);
    expect(rejected.body[0].body).toEqual({ model: "gpt-4o" });

    // A body that never parsed into a JSON object has nothing to record.
    expect((await call(`${mock.url}/__aimock/reset`, { method: "POST" })).status).toBe(200);
    expect(
      (
        await call(`${mock.url}/v1/fine_tuning/jobs`, {
          method: "POST",
          headers: JSON_HEADERS,
          body: "{not json",
        })
      ).status,
    ).toBe(400);
    const malformedEntries = await call<{ body: unknown }[]>(
      `${mock.url}/__aimock/journal?service=fine-tuning`,
    );
    expect(malformedEntries.status).toBe(200);
    expect(malformedEntries.body[0].body).toBeNull();
  });

  // Chaos-faulted requests are journaled by the shared chaos gate, not by this
  // module's own writer — so without an explicit service tag on the chaos
  // context they vanish from `?service=fine-tuning` exactly when a chaos test
  // needs them.
  for (const [label, chaos] of [
    ["drop", { dropRate: 1 }],
    ["malformed", { malformedRate: 1 }],
  ] as const) {
    it(`tags chaos-faulted (${label}) fine-tuning entries with the service`, async () => {
      const testId = `ft-chaos-${label}`;
      const h = { ...JSON_HEADERS, "X-Test-Id": testId };
      expect(
        (
          await call(`${mock.url}/__aimock/chaos`, {
            method: "POST",
            headers: h,
            body: JSON.stringify(chaos),
          })
        ).status,
      ).toBe(200);
      // `drop` answers 500 and `malformed` answers 200 with an unparseable
      // body; neither tears the socket down, so the body is always readable
      // (and must be read) — only the JSON parse has to be skipped.
      const hit = async (url: string, method = "GET"): Promise<void> => {
        await send(url, { method, headers: h, body: method === "POST" ? "{}" : undefined });
      };
      await hit(`${mock.url}/v1/fine_tuning/jobs`, "POST");
      await hit(`${mock.url}/v1/fine_tuning/jobs`);
      await hit(`${mock.url}/v1/fine_tuning/jobs/ftjob-x`);
      await hit(`${mock.url}/v1/fine_tuning/jobs/ftjob-x/events`);
      await hit(`${mock.url}/v1/fine_tuning/jobs/ftjob-x/cancel`, "POST");

      const all = await call<{ path: string }[]>(`${mock.url}/__aimock/journal`);
      expect(all.status).toBe(200);
      expect(all.body.filter((e) => e.path.includes("fine_tuning"))).toHaveLength(5);
      const filtered = await call<{ response: { chaosAction?: string } }[]>(
        `${mock.url}/__aimock/journal?service=fine-tuning`,
      );
      expect(filtered.status).toBe(200);
      expect(filtered.body).toHaveLength(5);
      expect(filtered.body.every((e) => e.response.chaosAction === label)).toBe(true);
    });
  }
});

// A pure-function label test: no server, so it must not sit inside a describe
// whose beforeEach starts and stops one.
describe("Fine-tuning metrics path labels", () => {
  it("normalizes fine-tuning path labels for metrics", () => {
    expect(normalizePathLabel("/v1/fine_tuning/jobs")).toBe("/v1/fine_tuning/jobs");
    expect(normalizePathLabel("/v1/fine_tuning/jobs/ftjob-1")).toBe("/v1/fine_tuning/jobs/{id}");
    expect(normalizePathLabel("/v1/fine_tuning/jobs/ftjob-1/cancel")).toBe(
      "/v1/fine_tuning/jobs/{id}/cancel",
    );
    expect(normalizePathLabel("/v1/fine_tuning/jobs/ftjob-1/events")).toBe(
      "/v1/fine_tuning/jobs/{id}/events",
    );
  });
});

/**
 * The job store is process-wide, not per-`LLMock` — the same scoping the
 * fal.ai job/queue maps and the Gemini id counters already use, and the same
 * one `LLMock.reset()`'s doc comment describes. These pin the behaviour: a
 * second instance is NOT a clean slate, and only a reset is. They assert
 * against the running server, not against any prose, so they constrain the
 * code alone — the matching paragraph in `docs/fine-tuning/index.html` and the
 * paging snippet that resets before it counts are not read by anything here.
 */
describe("Fine-tuning store scope", () => {
  let a: LLMock;
  let b: LLMock;
  beforeEach(async () => {
    clearFineTuningStore();
    a = new LLMock({ port: 0 });
    b = new LLMock({ port: 0 });
    await a.start();
    await b.start();
  });
  afterEach(async () => {
    await a.stop();
    await b.stop();
    clearFineTuningStore();
  });

  it("shares jobs and poll position across instances; only a reset clears them", async () => {
    const createdId = await createJob(a.url);

    // Constructing (and starting) a second LLMock does NOT start empty.
    const listedOnB = await call<{ data: { id: string }[] }>(`${b.url}/v1/fine_tuning/jobs`);
    expect(listedOnB.status).toBe(200);
    expect(listedOnB.body.data.map((d) => d.id)).toContain(createdId);

    // The poll counter is shared too: one retrieve per instance advances the
    // one job twice, rather than each instance advancing its own copy once.
    expect(
      await call<{ status: string }>(`${a.url}/v1/fine_tuning/jobs/${createdId}`),
    ).toMatchObject({ status: 200, body: { status: "queued" } });
    expect(
      await call<{ status: string }>(`${b.url}/v1/fine_tuning/jobs/${createdId}`),
    ).toMatchObject({ status: 200, body: { status: "running" } });

    // Reset on either instance clears the store for both.
    expect((await call(`${b.url}/__aimock/reset`, { method: "POST" })).status).toBe(200);
    const listedOnA = await call<{ data: unknown[] }>(`${a.url}/v1/fine_tuning/jobs`);
    expect(listedOnA.status).toBe(200);
    expect(listedOnA.body.data).toEqual([]);
    expect((await call(`${a.url}/v1/fine_tuning/jobs/${createdId}`)).status).toBe(404);
    expect((await call(`${b.url}/v1/fine_tuning/jobs/${createdId}/events`)).status).toBe(404);

    // And so does calling clearFineTuningStore() directly.
    const secondId = await createJob(a.url);
    clearFineTuningStore();
    expect((await call(`${b.url}/v1/fine_tuning/jobs/${secondId}`)).status).toBe(404);
  });
});

/**
 * The journal's own contract, pinned on the paths the earlier suite left open:
 * every create that parsed into a JSON object carries its body — not just the
 * two rejections that happen to sit above `validation_file` — and the journaled
 * `path` keeps its query string, which is what makes `?testId=` scoping work.
 */
describe("fine-tuning journal correctness", () => {
  let mock: LLMock;
  beforeEach(async () => {
    clearFineTuningStore();
    mock = new LLMock({ port: 0 });
    await mock.start();
  });
  afterEach(async () => {
    await mock.stop();
    clearFineTuningStore();
  });

  async function ftJournal(query = ""): Promise<{ path: string; body: unknown }[]> {
    const page = await call<{ path: string; body: unknown }[]>(
      `${mock.url}/__aimock/journal?service=fine-tuning${query}`,
    );
    expect(page.status).toBe(200);
    return page.body;
  }

  // Each of these passes the training_file/model gate and is then rejected, so
  // the documented "carries the request body you sent" applies to all of them.
  for (const [label, sent] of [
    ["validation_file", { training_file: "f", model: "m", validation_file: 42 }],
    ["hyperparameters not an object", { training_file: "f", model: "m", hyperparameters: 42 }],
    [
      "bad hyperparameter member",
      { training_file: "f", model: "m", hyperparameters: { n_epochs: "abc" } },
    ],
  ] as const) {
    it(`journals the body of a create rejected on ${label}`, async () => {
      expect((await post(`${mock.url}/v1/fine_tuning/jobs`, sent)).status).toBe(400);
      const entries = await ftJournal();
      expect(entries).toHaveLength(1);
      expect(entries[0].body).toEqual(sent);
    });
  }

  it("keeps the query string on the journaled path, so ?testId= stays filterable", async () => {
    // Tagged by query param only — no X-Test-Id header. `entry.path` is the
    // sole carrier of that tag, so stripping the query here would drop this
    // request out of its own test's slice of the journal.
    expect((await send(`${mock.url}/v1/fine_tuning/jobs?testId=t1&limit=2`)).status).toBe(200);
    expect((await send(`${mock.url}/v1/fine_tuning/jobs?limit=5`)).status).toBe(200);

    const all = await ftJournal();
    expect(all.map((e) => e.path)).toEqual([
      "/v1/fine_tuning/jobs?testId=t1&limit=2",
      "/v1/fine_tuning/jobs?limit=5",
    ]);

    const scoped = await ftJournal("&testId=t1");
    expect(scoped.map((e) => e.path)).toEqual(["/v1/fine_tuning/jobs?testId=t1&limit=2"]);
  });
});

/**
 * Request validation, checked against openai/openai-openapi `openapi.yaml`
 * v2.3.0 (`master`, fetched 2026-09-15) schema `CreateFineTuningJobRequest` and
 * the `listPaginatedFineTuningJobs`/`listFineTuningEvents` query parameters.
 *
 * The spec's own numbers, quoted:
 *   - `hyperparameters.n_epochs`: `type: integer, minimum: 1, maximum: 50`.
 *   - `hyperparameters.batch_size`: `type: integer, minimum: 1, maximum: 256`.
 *   - `hyperparameters.learning_rate_multiplier`: `type: number, minimum: 0,
 *     exclusiveMinimum: true` — strictly greater than zero.
 *   - `hyperparameters` itself is `type: object` and, unlike its siblings
 *     `suffix`, `validation_file` and `integrations`, carries no
 *     `nullable: true`, so `null` is not a legal value on the wire.
 *   - `limit` is `type: integer, default: 20` on both list endpoints.
 *
 * Two rules here are this mock's, not the vendor's, and are marked as such:
 * the upper bound of 100 on `limit`, and rejecting `validation_file: ""` (the
 * spec sets no `minLength` on either file id, but `training_file: ""` is
 * already a 400 here and the two should not disagree).
 */
describe("Fine-tuning request validation", () => {
  let mock: LLMock;
  beforeEach(async () => {
    clearFineTuningStore();
    mock = new LLMock({ port: 0 });
    await mock.start();
  });
  afterEach(async () => {
    await mock.stop();
    clearFineTuningStore();
  });

  async function listBases(): Promise<string[]> {
    const id = await createJob(mock.url);
    return [`${mock.url}/v1/fine_tuning/jobs`, `${mock.url}/v1/fine_tuning/jobs/${id}/events`];
  }

  type WireError = Wire<{ error: { message: string } }>;

  function errorOf(res: WireError): string {
    return res.body.error.message;
  }

  it("rejects every `limit` spelling that is not a plain decimal integer", async () => {
    // `Number()` coerces all of these; none is the "integer from 1 to 100" the
    // docs and the spec describe, and `0x10` used to page silently as 16.
    const bad = ["0x10", "1e2", "%2B5", "%20%205%20", "20.0", "1_0", "Infinity", "-0"];
    for (const base of await listBases()) {
      for (const raw of bad) {
        const res = await call<{ error: { message: string } }>(`${base}?limit=${raw}`);
        expect(res.status, `limit=${raw}`).toBe(400);
        expect(errorOf(res), `limit=${raw}`).toContain("limit");
      }
      // The legal spellings — including the vendor default — still page.
      for (const ok of ["1", "20", "100"]) {
        expect((await send(`${base}?limit=${ok}`)).status, `limit=${ok}`).toBe(200);
      }
    }
  });

  it("names the offending cursor even when `after` is empty", async () => {
    for (const base of await listBases()) {
      const res = await call<{ error: { message: string } }>(`${base}?after=`);
      expect(res.status).toBe(400);
      // The old message trailed off after the colon and named nothing.
      expect(errorOf(res)).toContain("'after' is not a known cursor: ''");
    }
  });

  it("parses the whole query string, not just up to a second `?`", async () => {
    const id = await createJob(mock.url);
    // A second `?` is a literal in the query, so `limit` is still a parameter.
    const seen = await call<{ error: { message: string } }>(
      `${mock.url}/v1/fine_tuning/jobs?a=1?b=2&limit=0x10`,
    );
    expect(seen.status).toBe(400);
    expect(errorOf(seen)).toContain("limit");

    const events = await send(`${mock.url}/v1/fine_tuning/jobs/${id}/events?a=1?b=2&limit=0x10`);
    expect(events.status).toBe(400);

    // And a valid one past the second `?` is honoured rather than dropped.
    const paged = await call<{ data: unknown[] }>(
      `${mock.url}/v1/fine_tuning/jobs/${id}/events?a=1?b=2&limit=1`,
    );
    expect(paged.status).toBe(200);
    expect(paged.body.data).toHaveLength(1);
  });

  it("rejects hyperparameters outside the ranges the spec declares", async () => {
    const outOfRange: [string, unknown][] = [
      ["n_epochs", 0],
      ["n_epochs", -5],
      ["n_epochs", 51],
      ["batch_size", 0],
      ["batch_size", -5],
      ["batch_size", 257],
      ["learning_rate_multiplier", 0],
      ["learning_rate_multiplier", -1],
    ];
    for (const [key, value] of outOfRange) {
      const res = await post<{ error: { message: string } }>(`${mock.url}/v1/fine_tuning/jobs`, {
        training_file: "f",
        model: "m",
        hyperparameters: { [key]: value },
      });
      expect(res.status, `${key}=${String(value)}`).toBe(400);
      expect(errorOf(res), `${key}=${String(value)}`).toContain(`hyperparameters.${key}`);
    }

    // The spec's own bounds, and "auto", are all still accepted.
    for (const hyper of [
      { n_epochs: "auto", batch_size: "auto", learning_rate_multiplier: "auto" },
      { n_epochs: 3 },
      { n_epochs: 1, batch_size: 1, learning_rate_multiplier: 0.000001 },
      { n_epochs: 50, batch_size: 256, learning_rate_multiplier: 0.5 },
    ]) {
      const res = await post<{ hyperparameters: unknown }>(`${mock.url}/v1/fine_tuning/jobs`, {
        training_file: "f",
        model: "m",
        hyperparameters: hyper,
      });
      expect(res.status, JSON.stringify(hyper)).toBe(200);
      expect(res.body.hyperparameters).toEqual(hyper);
    }
  });

  it("rejects `hyperparameters: null`, which the spec does not mark nullable", async () => {
    const res = await post<{ error: { message: string } }>(`${mock.url}/v1/fine_tuning/jobs`, {
      training_file: "f",
      model: "m",
      hyperparameters: null,
    });
    expect(res.status).toBe(400);
    expect(errorOf(res)).toContain("hyperparameters");
  });

  it("treats an empty `validation_file` the same way as an empty `training_file`", async () => {
    const empty = await post<{ error: { message: string } }>(`${mock.url}/v1/fine_tuning/jobs`, {
      training_file: "f",
      model: "m",
      validation_file: "",
    });
    expect(empty.status).toBe(400);
    expect(errorOf(empty)).toContain("validation_file");

    // `null` stays legal — the spec marks `validation_file` nullable.
    const nulled = await post<{ validation_file: unknown }>(`${mock.url}/v1/fine_tuning/jobs`, {
      training_file: "f",
      model: "m",
      validation_file: null,
    });
    expect(nulled.status).toBe(200);
    expect(nulled.body.validation_file).toBeNull();

    const named = await post(`${mock.url}/v1/fine_tuning/jobs`, {
      training_file: "f",
      model: "m",
      validation_file: "file-valid",
    });
    expect(named.status).toBe(200);
  });
});

/**
 * The lifecycle stamps `created_at`, every event and `finished_at` from the
 * wall clock, which can step backwards (NTP correction, a VM resume, a test
 * harness driving `Date.now`). These drive the real handlers through a real
 * server with only `Date.now` replaced, because the invariant belongs to the
 * running store, not to any one function.
 */
describe("T11-CLOCK-MONOTONIC: fine-tuning timestamps never go backwards", () => {
  let mock: LLMock;
  let nowMs = 0;

  beforeEach(async () => {
    clearFineTuningStore();
    nowMs = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    mock = new LLMock({ port: 0 });
    await mock.start();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await mock.stop();
    clearFineTuningStore();
  });

  /**
   * One lifecycle step. A retrieve is what advances the job, so the status is
   * asserted here: a 404 or a 400 would otherwise leave the job un-advanced and
   * surface as a confusing timestamp assertion instead of the route failure.
   */
  async function advance(base: string, id: string): Promise<void> {
    expect((await send(`${base}/v1/fine_tuning/jobs/${id}`)).status).toBe(200);
  }

  /**
   * Every timestamp the job exposes, in the order the lifecycle produced them.
   *
   * A terminal job must carry a `finished_at`, so a null one is a failure, not
   * a value to skip: `-Infinity` is smaller than every real stamp, which makes
   * `assertNonDecreasing` fail and print the null in the stamp list. Reading it
   * as "no finish yet, carry on" would let a dropped `finished_at` pass.
   */
  async function timeline(base: string, id: string): Promise<number[]> {
    const job = await call<{ created_at: number; finished_at: number | null }>(
      `${base}/v1/fine_tuning/jobs/${id}`,
    );
    expect(job.status).toBe(200);
    const events = await eventsOf(base, id);
    return [
      job.body.created_at,
      ...events.map((e) => e.created_at),
      job.body.finished_at ?? -Infinity,
    ];
  }

  function assertNonDecreasing(stamps: number[], label: string): void {
    for (let i = 1; i < stamps.length; i++) {
      expect(
        stamps[i] >= stamps[i - 1],
        `T11-CLOCK-MONOTONIC ${label}: stamp[${i}]=${stamps[i]} < stamp[${i - 1}]=${stamps[i - 1]} in ${JSON.stringify(stamps)}`,
      ).toBe(true);
    }
  }

  it("holds when the clock steps backwards across a cancel", async () => {
    const id = await createJob(mock.url);
    nowMs -= 5_000;
    await advance(mock.url, id); // -> queued
    nowMs -= 5_000;
    await advance(mock.url, id); // -> running
    nowMs -= 5_000;
    const cancelled = await call<{ finished_at: number | null }>(
      `${mock.url}/v1/fine_tuning/jobs/${id}/cancel`,
      { method: "POST" },
    );
    expect(cancelled.status).toBe(200);

    const stamps = await timeline(mock.url, id);
    assertNonDecreasing(stamps, "backward/cancel");
    // `finished_at` is the last thing that happened, so nothing may follow it.
    expect(cancelled.body.finished_at).toBe(stamps[stamps.length - 1]);
    expect(cancelled.body.finished_at).toBeGreaterThanOrEqual(stamps[0]);
  });

  it("holds when the clock steps backwards across a succeeded terminal", async () => {
    const id = await createJob(mock.url);
    for (const step of [3_000, 3_000, 30_000]) {
      nowMs -= step;
      await advance(mock.url, id);
    }
    const job = await call<{ status: string; finished_at: number | null }>(
      `${mock.url}/v1/fine_tuning/jobs/${id}`,
    );
    expect(job.status).toBe(200);
    expect(job.body.status).toBe("succeeded");
    const stamps = await timeline(mock.url, id);
    assertNonDecreasing(stamps, "backward/succeeded");
    expect(job.body.finished_at).toBe(stamps[stamps.length - 1]);
  });

  it("holds when the clock runs forward, and tracks it", async () => {
    const id = await createJob(mock.url);
    nowMs += 4_000;
    await advance(mock.url, id);
    nowMs += 4_000;
    await advance(mock.url, id);
    nowMs += 4_000;
    const cancelled = await call<{ created_at: number; finished_at: number | null }>(
      `${mock.url}/v1/fine_tuning/jobs/${id}/cancel`,
      { method: "POST" },
    );
    expect(cancelled.status).toBe(200);

    const stamps = await timeline(mock.url, id);
    assertNonDecreasing(stamps, "forward");
    // A forward clock must not be flattened: 12s of movement is real.
    expect((cancelled.body.finished_at ?? 0) - cancelled.body.created_at).toBe(12);
  });

  it("holds when the clock never moves", async () => {
    const id = await createJob(mock.url);
    await advance(mock.url, id);
    await advance(mock.url, id);
    expect(
      (await send(`${mock.url}/v1/fine_tuning/jobs/${id}/cancel`, { method: "POST" })).status,
    ).toBe(200);

    const stamps = await timeline(mock.url, id);
    assertNonDecreasing(stamps, "equal");
    expect(new Set(stamps).size).toBe(1);
  });
});

/**
 * A chaos-injected fault is written by the chaos gate itself, not by this
 * mock's `writeJson`, so it is the one response shape that can leave the
 * handler without the CORS headers every other response carries. A browser
 * client would then see an opaque CORS failure instead of the 429 (or 500, or
 * malformed body) the chaos config asked it to exercise — the injected fault
 * hidden behind a transport error, which is the opposite of what chaos mode is
 * for.
 *
 * These cases assert the FULL `access-control-*` set against the same route's
 * non-chaos response rather than `access-control-allow-origin` alone: a
 * partial set still breaks a browser that needs `expose-headers` to read
 * `X-Total-Count` off a paginated list.
 */
describe("fine-tuning chaos responses carry CORS headers", () => {
  let mock: LLMock;
  beforeEach(async () => {
    clearFineTuningStore();
    mock = new LLMock({ port: 0 });
    await mock.start();
  });
  afterEach(async () => {
    await mock.stop();
    clearFineTuningStore();
  });

  /** Chaos is forced per-request by header, so no server-wide config is needed. */
  const chaos = (kind: "ratelimit" | "drop" | "malformed"): Record<string, string> => ({
    [`x-aimock-chaos-${kind}`]: "1",
    Origin: "http://example.test",
  });

  /**
   * The five fine-tuning routes, each as a request builder. `id` is a job the
   * caller seeded, so retrieve/cancel/events address a real job and their
   * non-chaos control is a 200 rather than a 404.
   */
  const routesFor = (base: string, id: string): [string, string, RequestInit][] => [
    [
      "create",
      `${base}/v1/fine_tuning/jobs`,
      {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ training_file: "file-train", model: "gpt-4o-mini" }),
      },
    ],
    ["list", `${base}/v1/fine_tuning/jobs`, { method: "GET" }],
    ["retrieve", `${base}/v1/fine_tuning/jobs/${id}`, { method: "GET" }],
    ["cancel", `${base}/v1/fine_tuning/jobs/${id}/cancel`, { method: "POST" }],
    ["events", `${base}/v1/fine_tuning/jobs/${id}/events`, { method: "GET" }],
  ];

  /** Re-issue `init` with the chaos headers merged over its own. */
  const withHeaders = (init: RequestInit, extra: Record<string, string>): RequestInit => ({
    ...init,
    headers: { ...((init.headers as Record<string, string>) ?? {}), ...extra },
  });

  /**
   * Collect the whole five-route sweep before asserting, so a regression
   * reports every route it broke instead of short-circuiting on the first.
   * Each entry pairs the faulted response's status and `access-control-*` set
   * with the control's set, so one `toEqual` covers both.
   */
  async function sweep(
    id: string,
    kind: "ratelimit" | "drop" | "malformed",
    faultStatus: number,
  ): Promise<{
    actual: Record<string, { status: number; cors: Record<string, string> }>;
    expected: Record<string, { status: number; cors: Record<string, string> }>;
  }> {
    const actual: Record<string, { status: number; cors: Record<string, string> }> = {};
    const expected: Record<string, { status: number; cors: Record<string, string> }> = {};

    for (const [name, url, init] of routesFor(mock.url, id)) {
      // The control runs first and its header set is read off the live server
      // rather than hardcoded, so this can never drift away from the
      // `CORS_HEADERS` table in server.ts.
      const control = await send(url, withHeaders(init, { Origin: "http://example.test" }));
      expect(control.status, `${name} control status`).toBe(200);
      const controlCors = corsHeadersOf(control.headers);
      expect(Object.keys(controlCors).length, `${name} control CORS set`).toBeGreaterThan(0);

      const faulted = await send(url, withHeaders(init, chaos(kind)));
      if (kind === "malformed") {
        expect(faulted.text, `${name} malformed body`).toContain("<<<chaos>>>");
      }
      actual[name] = { status: faulted.status, cors: corsHeadersOf(faulted.headers) };
      expected[name] = { status: faultStatus, cors: controlCors };
    }
    return { actual, expected };
  }

  it("serves a chaos 429 with the same CORS headers as the non-chaos response", async () => {
    const { actual, expected } = await sweep(await createJob(mock.url), "ratelimit", 429);
    expect(actual, "CORS_HEADERS_MISSING_ON_CHAOS: rateLimit").toEqual(expected);
  });

  it("serves a chaos 500 drop with the same CORS headers as the non-chaos response", async () => {
    const { actual, expected } = await sweep(await createJob(mock.url), "drop", 500);
    expect(actual, "CORS_HEADERS_MISSING_ON_CHAOS: drop").toEqual(expected);
  });

  it("serves a chaos malformed 200 with the same CORS headers as the non-chaos response", async () => {
    const { actual, expected } = await sweep(await createJob(mock.url), "malformed", 200);
    expect(actual, "CORS_HEADERS_MISSING_ON_CHAOS: malformed").toEqual(expected);
  });
});

/**
 * The clamp T11 installed was per job, so it said nothing about two different
 * jobs. The list endpoint's order rests on exactly that cross-job comparison:
 * it pages insertion order reversed and calls the result newest-first, which is
 * only true if a later-created job never carries an earlier `created_at`. A
 * backwards wall-clock step between two creates used to break it, and the
 * "newest-first" page led with the older job. These drive the real handlers
 * through a real server with only `Date.now` replaced.
 */
describe("T18-CLOCK-MODULE-WIDE: list order is newest-first across jobs", () => {
  let mock: LLMock;
  let nowMs = 0;

  beforeEach(async () => {
    clearFineTuningStore();
    nowMs = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    mock = new LLMock({ port: 0 });
    await mock.start();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await mock.stop();
    clearFineTuningStore();
  });

  type WireJob = { id: string; created_at: number; finished_at: number | null };

  async function listJobs(base: string): Promise<WireJob[]> {
    const page = await call<{ data: WireJob[] }>(`${base}/v1/fine_tuning/jobs?limit=100`);
    expect(page.status).toBe(200);
    return page.body.data;
  }

  /** Assert the page is newest-first: `created_at` non-increasing down the page. */
  function assertNewestFirst(page: WireJob[], label: string): void {
    const triples = page.map((j) => [j.id, j.created_at]);
    for (let i = 1; i < page.length; i++) {
      expect(
        page[i].created_at <= page[i - 1].created_at,
        `T18 ${label}: page[${i}].created_at=${page[i].created_at} > page[${i - 1}].created_at=${page[i - 1].created_at} in ${JSON.stringify(triples)}`,
      ).toBe(true);
    }
  }

  it("leads with the later-created job when the clock steps backwards between creates", async () => {
    const a = await createJob(mock.url);
    nowMs -= 30_000;
    const b = await createJob(mock.url);

    const page = await listJobs(mock.url);
    expect(page.map((j) => j.id)).toEqual([b, a]);
    const [jobB, jobA] = page;
    expect(
      jobB.created_at >= jobA.created_at,
      `T18 backward: later-created ${b}.created_at=${jobB.created_at} < earlier ${a}.created_at=${jobA.created_at}`,
    ).toBe(true);
    assertNewestFirst(page, "backward");
  });

  it("keeps every later timestamp at or after an earlier job's, through a terminal", async () => {
    await createJob(mock.url);
    const createdA = (await listJobs(mock.url))[0].created_at;
    nowMs -= 30_000;
    const b = await createJob(mock.url);
    for (let i = 0; i < 3; i++) {
      nowMs -= 5_000;
      expect((await send(`${mock.url}/v1/fine_tuning/jobs/${b}`)).status).toBe(200);
    }
    const jobB = await call<WireJob & { status: string }>(`${mock.url}/v1/fine_tuning/jobs/${b}`);
    expect(jobB.status).toBe(200);
    expect(jobB.body.status).toBe("succeeded");

    const eventsB = (await eventsOf(mock.url, b)).map((e) => e.created_at);
    const stamps = [createdA, jobB.body.created_at, ...eventsB, jobB.body.finished_at ?? -Infinity];
    for (let i = 1; i < stamps.length; i++) {
      expect(
        stamps[i] >= stamps[i - 1],
        `T18 across-jobs: stamp[${i}]=${stamps[i]} < stamp[${i - 1}]=${stamps[i - 1]} in ${JSON.stringify(stamps)}`,
      ).toBe(true);
    }
  });

  it("is newest-first when the clock runs forward between creates", async () => {
    const a = await createJob(mock.url);
    nowMs += 7_000;
    const b = await createJob(mock.url);
    nowMs += 7_000;
    const c = await createJob(mock.url);

    const page = await listJobs(mock.url);
    expect(page.map((j) => j.id)).toEqual([c, b, a]);
    assertNewestFirst(page, "forward");
    // A forward clock must not be flattened: 14s of movement across a, c is real.
    expect(page[0].created_at - page[2].created_at).toBe(14);
  });

  it("is newest-first when the clock never moves between creates", async () => {
    const a = await createJob(mock.url);
    const b = await createJob(mock.url);
    const c = await createJob(mock.url);

    const page = await listJobs(mock.url);
    expect(page.map((j) => j.id)).toEqual([c, b, a]);
    assertNewestFirst(page, "equal");
    expect(new Set(page.map((j) => j.created_at)).size).toBe(1);
  });
});

/**
 * Request validation on the create body and on the list routes' query.
 *
 * The rule the whole block pins: a create parameter or query parameter this
 * surface reads is either honoured or rejected with a 400 that names it.
 * Nothing is accepted and dropped, because a 200 that ignored what the caller
 * wrote is the one answer a mock must never give.
 */
describe("Fine-tuning parameters are honoured or rejected, never dropped", () => {
  let mock: LLMock;
  beforeEach(async () => {
    clearFineTuningStore();
    mock = new LLMock({ port: 0 });
    await mock.start();
  });
  afterEach(async () => {
    await mock.stop();
    clearFineTuningStore();
  });

  const create = (body: Record<string, unknown>) =>
    post<{ id: string; error: { message: string } }>(`${mock.url}/v1/fine_tuning/jobs`, {
      training_file: "file-train",
      model: "gpt-4o-mini",
      ...body,
    });

  /** The message of a 400, asserted to BE a 400 first so a 200 names itself. */
  async function rejection(body: Record<string, unknown>): Promise<string> {
    const res = await create(body);
    expect({ status: res.status, body: res.body }).toMatchObject({ status: 400 });
    return res.body.error.message;
  }

  /**
   * A raw HTTP request, because `fetch` strips a `#` and everything after it
   * before the bytes reach the wire — which is exactly the truncation under
   * test. Resolves on close, so nothing is left undrained.
   */
  function rawGet(target: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const port = Number(new URL(mock.url).port);
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
      });
      let raw = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => (raw += chunk));
      socket.on("error", reject);
      socket.on("close", () => {
        const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(raw)?.[1] ?? 0);
        resolve({ status, body: raw.slice(raw.indexOf("\r\n\r\n") + 4) });
      });
    });
  }

  // The parity basis for the `validation_file: ""` rejection above: both file
  // ids and `model` reject the empty string, and the message names the one
  // that was empty rather than the first field the handler happens to read.
  it("rejects an empty training_file, model or validation_file by name", async () => {
    expect(await rejection({ training_file: "" })).toContain("'training_file'");
    expect(await rejection({ model: "" })).toContain("'model'");
    expect(await rejection({ validation_file: "" })).toContain("'validation_file'");
  });

  it("rejects an unrecognized top-level create parameter instead of dropping it", async () => {
    const message = await rejection({ nonsense: 1 });
    expect(message).toContain("'nonsense'");
    // The message teaches the caller the parameter set it could have used.
    for (const key of ["model", "training_file", "hyperparameters", "suffix", "method"]) {
      expect(message).toContain(key);
    }
  });

  it("rejects an unrecognized hyperparameters member and points at the members it takes", async () => {
    // `beta` is real, but it is a DPO hyperparameter: it belongs under
    // `method.dpo.hyperparameters`, not in the deprecated top-level object.
    // This used to answer 200 echoing `{"n_epochs": 3}` with `beta` dropped.
    const message = await rejection({ hyperparameters: { n_epochs: 3, beta: 0.5 } });
    expect(message).toContain("'hyperparameters.beta'");
    expect(message).toContain("n_epochs, batch_size, learning_rate_multiplier");
  });

  it("keeps accepting the hyperparameters the spec does declare", async () => {
    const ok = await create({
      hyperparameters: { n_epochs: "auto", batch_size: 8, learning_rate_multiplier: 0.5 },
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      hyperparameters: { n_epochs: "auto", batch_size: 8, learning_rate_multiplier: 0.5 },
    });
  });

  it("puts an accepted suffix into the fine-tuned model name", async () => {
    const created = await create({ suffix: "custom-model-name" });
    expect(created.status).toBe(200);
    // Not on the job object: `suffix` is a member of the create request and
    // not of `fine_tuning.job`, so it must not ride out on the wire.
    expect(Object.keys(created.body)).not.toContain("suffix");
    const id = created.body.id;
    for (let poll = 0; poll < 3; poll += 1) {
      expect((await send(`${mock.url}/v1/fine_tuning/jobs/${id}`)).status).toBe(200);
    }
    const done = await call<{ status: string; fine_tuned_model: string }>(
      `${mock.url}/v1/fine_tuning/jobs/${id}`,
    );
    expect(done.body.status).toBe("succeeded");
    // `ft:<model>:<org>:<suffix>:<id>`, the shape the spec's `suffix`
    // description spells out.
    expect(done.body.fine_tuned_model).toBe(
      `ft:gpt-4o-mini:aimock:custom-model-name:${id.slice(-6)}`,
    );
  });

  it("leaves the model name alone when no suffix was asked for", async () => {
    const id = await createJob(mock.url);
    for (let poll = 0; poll < 3; poll += 1) {
      expect((await send(`${mock.url}/v1/fine_tuning/jobs/${id}`)).status).toBe(200);
    }
    const done = await call<{ fine_tuned_model: string }>(`${mock.url}/v1/fine_tuning/jobs/${id}`);
    expect(done.body.fine_tuned_model).toBe(`ft:gpt-4o-mini:aimock:${id.slice(-6)}`);
  });

  it("rejects a suffix that is not a 1-to-64 character string, and accepts null", async () => {
    expect(await rejection({ suffix: "" })).toContain("'suffix'");
    expect(await rejection({ suffix: "x".repeat(65) })).toContain("'suffix'");
    expect(await rejection({ suffix: 42 })).toContain("'suffix'");
    expect((await create({ suffix: null })).status).toBe(200);
    expect((await create({ suffix: "x".repeat(64) })).status).toBe(200);
  });

  it("honours a requested seed and still derives one when none is sent", async () => {
    const seeded = await call<{ seed: number }>(`${mock.url}/v1/fine_tuning/jobs`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ training_file: "f", model: "m", seed: 42 }),
    });
    expect(seeded.status).toBe(200);
    expect(seeded.body.seed).toBe(42);
    const derived = await create({});
    expect(derived.status).toBe(200);
    expect(Number.isInteger((derived.body as unknown as { seed: number }).seed)).toBe(true);
    expect(await rejection({ seed: -1 })).toContain("'seed'");
    expect(await rejection({ seed: 2147483648 })).toContain("'seed'");
    expect(await rejection({ seed: 1.5 })).toContain("'seed'");
    expect((await create({ seed: null })).status).toBe(200);
  });

  it("echoes an accepted method and validates that method's own hyperparameters", async () => {
    const method = { type: "dpo", dpo: { hyperparameters: { beta: 0.5, n_epochs: 3 } } };
    const ok = await create({ method });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ method });
    // `beta` is `0 < beta <= 2` per `FineTuneDPOHyperparameters`.
    expect(
      await rejection({ method: { type: "dpo", dpo: { hyperparameters: { beta: 2.5 } } } }),
    ).toContain("'method.dpo.hyperparameters.beta'");
    // ...and it is a DPO member only: supervised does not take it.
    expect(
      await rejection({
        method: { type: "supervised", supervised: { hyperparameters: { beta: 0.5 } } },
      }),
    ).toContain("'method.supervised.hyperparameters.beta'");
    expect(await rejection({ method: { type: "sft" } })).toContain("'method.type'");
    expect(await rejection({ method: { type: "dpo", dpo: 42 } })).toContain("'method.dpo'");
    expect(await rejection({ method: { type: "dpo", nonsense: {} } })).toContain(
      "'method.nonsense'",
    );
  });

  it("requires a reinforcement grader and reads the reinforcement-only knobs", async () => {
    expect(await rejection({ method: { type: "reinforcement", reinforcement: {} } })).toContain(
      "'method.reinforcement.grader'",
    );
    const method = {
      type: "reinforcement",
      reinforcement: {
        grader: { type: "string_check", name: "g" },
        // `eval_interval` has a minimum and no declared maximum; a rule table
        // that inferred integrality from the presence of bounds could not say
        // that, so this is also the pin on the explicit `kind` tag.
        hyperparameters: { reasoning_effort: "high", eval_interval: 10_000, compute_multiplier: 2 },
      },
    };
    const ok = await create({ method });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ method });
    // `reasoning_effort` is a plain string enum with no `"auto"` member.
    expect(
      await rejection({
        method: {
          type: "reinforcement",
          reinforcement: { grader: {}, hyperparameters: { reasoning_effort: "auto" } },
        },
      }),
    ).toContain("'method.reinforcement.hyperparameters.reasoning_effort'");
  });

  it("echoes accepted metadata and rejects what the Metadata schema forbids", async () => {
    const ok = await create({ metadata: { run: "nightly" } });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ metadata: { run: "nightly" } });
    const seventeen = Object.fromEntries(
      Array.from({ length: 17 }, (_unused, index) => [`k${index}`, "v"]),
    );
    expect(await rejection({ metadata: seventeen })).toContain("'metadata'");
    expect(await rejection({ metadata: { k: 1 } })).toContain("'metadata.k'");
    expect(await rejection({ metadata: { ["k".repeat(65)]: "v" } })).toContain("'metadata'");
    expect(await rejection({ metadata: { k: "v".repeat(513) } })).toContain("'metadata.k'");
    expect((await create({ metadata: null })).status).toBe(200);
  });

  it("echoes accepted integrations and rejects a malformed or oversized list", async () => {
    const integrations = [{ type: "wandb", wandb: { project: "p", tags: ["t"] } }];
    const ok = await create({ integrations });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ integrations });
    expect(await rejection({ integrations: [{ type: "wandb" }] })).toContain(
      "'integrations[0].wandb'",
    );
    expect(
      await rejection({ integrations: [{ type: "mlflow", wandb: { project: "p" } }] }),
    ).toContain("'integrations[0].type'");
    expect(
      await rejection({ integrations: [{ type: "wandb", wandb: { project: "p", nope: 1 } }] }),
    ).toContain("'integrations[0].wandb.nope'");
    const six = Array.from({ length: 6 }, () => ({ type: "wandb", wandb: { project: "p" } }));
    expect(await rejection({ integrations: six })).toContain("'integrations'");
    expect((await create({ integrations: null })).status).toBe(200);
  });

  it("omits the optional job members the create body did not carry", async () => {
    const plain = await create({});
    expect(plain.status).toBe(200);
    const keys = Object.keys(plain.body);
    for (const optional of ["integrations", "method", "metadata"]) {
      expect(keys).not.toContain(optional);
    }
  });

  // `params.get` answers with the FIRST of a repeated parameter, so the rest
  // used to be laundered: `?limit=1&limit=abc` paged at 1 and answered 200.
  it("rejects a repeated limit or after on both list routes", async () => {
    const id = await createJob(mock.url);
    for (const route of [`/v1/fine_tuning/jobs`, `/v1/fine_tuning/jobs/${id}/events`]) {
      const limit = await call<{ error: { message: string } }>(
        `${mock.url}${route}?limit=1&limit=abc`,
      );
      expect(limit.status).toBe(400);
      expect(limit.body.error.message).toContain("'limit'");
      // A repeat whose FIRST value is perfectly valid is still a repeat.
      const after = await call<{ error: { message: string } }>(
        `${mock.url}${route}?after=${id}&after=abc`,
      );
      expect(after.status).toBe(400);
      expect(after.body.error.message).toContain("'after'");
    }
  });

  it("still pages on a single limit and after", async () => {
    const first = await createJob(mock.url);
    await createJob(mock.url);
    const page = await call<{ data: { id: string }[]; has_more: boolean }>(
      `${mock.url}/v1/fine_tuning/jobs?limit=20`,
    );
    expect(page.status).toBe(200);
    expect(page.body.data).toHaveLength(2);
    const rest = await call<{ data: { id: string }[] }>(
      `${mock.url}/v1/fine_tuning/jobs?after=${page.body.data[0].id}`,
    );
    expect(rest.status).toBe(200);
    expect(rest.body.data.map((job) => job.id)).toEqual([first]);
  });

  // A request target has no fragment (RFC 9112), so everything after the first
  // `?` is query — including a literal `#`. Reading the query through
  // `new URL` truncated there, turning `after=abc#def` into the cursor `abc`
  // and `limit=5#frag` into a silent page of five.
  it("reads a literal # in the query as query, not as a fragment", async () => {
    const id = await createJob(mock.url);
    const limit = await rawGet("/v1/fine_tuning/jobs?limit=5#frag");
    expect(limit.status).toBe(400);
    expect(limit.body).toContain("5#frag");
    const after = await rawGet(`/v1/fine_tuning/jobs?after=${id}#def`);
    expect(after.status).toBe(400);
    expect(after.body).toContain(`${id}#def`);
    // The percent-encoded spelling is the same value and earns the same 400.
    // The message quotes the raw query text, so it names the spelling the
    // caller actually wrote rather than its decoding.
    const encoded = await rawGet("/v1/fine_tuning/jobs?limit=5%23frag");
    expect(encoded.status).toBe(400);
    expect(encoded.body).toContain("5%23frag");
  });

  // The regression the `?`-truncation fix bought: a second literal `?` is
  // legal inside a query, and the parameters after it must survive.
  it("keeps the parameters after a second literal ? in the target", async () => {
    await createJob(mock.url);
    await createJob(mock.url);
    const page = await rawGet("/v1/fine_tuning/jobs?a=1?b=2&limit=1");
    expect(page.status).toBe(200);
    expect(page.body).toContain('"has_more":true');
  });
});

/**
 * Cancel is the one fine-tuning POST whose payload the handler has no use for.
 * That is exactly why the route has to read it anyway: a POST route that never
 * touches the request stream inherits node's own dumping behavior, which has no
 * ceiling, so the route would silently accept an upload of any size while the
 * create route beside it rejects the same bytes. These pin both halves — the
 * body is tolerated, and it is bounded.
 */
describe("Fine-tuning cancel request body", () => {
  let mock: LLMock;
  beforeEach(async () => {
    clearFineTuningStore();
    mock = new LLMock({ port: 0 });
    await mock.start();
  });
  afterEach(async () => {
    await mock.stop();
    clearFineTuningStore();
  });

  it("cancels normally when the caller sends a body anyway", async () => {
    const id = await createJob(mock.url);
    const cancelled = await post<{ status: string }>(
      `${mock.url}/v1/fine_tuning/jobs/${id}/cancel`,
      { reason: "changed my mind", note: "x".repeat(64 * 1024) },
    );
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe("cancelled");
  });

  it("does not journal the discarded cancel body", async () => {
    const id = await createJob(mock.url);
    expect(
      (await post(`${mock.url}/v1/fine_tuning/jobs/${id}/cancel`, { reason: "discard me" })).status,
    ).toBe(200);

    const entries = await call<Array<{ path: string; body: unknown }>>(
      `${mock.url}/__aimock/journal?service=fine-tuning`,
    );
    expect(entries.status).toBe(200);
    const cancels = entries.body.filter((e) => e.path.endsWith("/cancel"));
    expect(cancels).toHaveLength(1);
    expect(cancels[0].body).toBeNull();
  });

  it("bounds a cancel body by the same ceiling as a create body", async () => {
    const id = await createJob(mock.url);
    // readBody's ceiling is 10 MB; over it the request is destroyed, which
    // surfaces to fetch as a transport failure rather than a status.
    const overCap = Buffer.alloc(11 * 1024 * 1024, 0x78);
    const overCapPost = (path: string): Promise<Response> =>
      fetch(`${mock.url}${path}`, { method: "POST", headers: JSON_HEADERS, body: overCap });

    await expect(overCapPost("/v1/fine_tuning/jobs")).rejects.toThrow();
    await expect(overCapPost(`/v1/fine_tuning/jobs/${id}/cancel`)).rejects.toThrow();

    // The job is untouched: the oversized cancel never reached the handler.
    const job = await call<{ status: string }>(`${mock.url}/v1/fine_tuning/jobs/${id}`);
    expect(job.status).toBe(200);
    expect(job.body.status).not.toBe("cancelled");
  });
});

/**
 * T21-PROTO-KEYS: a member name that lives on `Object.prototype` is not a
 * hyperparameter, and `__proto__` is an ordinary metadata key.
 *
 * Both halves used to break the module's one contract - never answer 200
 * having ignored what the caller wrote. `key in table` / `table[key]` walked
 * the prototype chain, so `{"toString":"auto"}` cleared the unknown-member
 * gate and was then dropped (or echoed under `method`), and a numeric value on
 * such a name earned a 400 quoting a domain of `undefined`. Separately,
 * `out[key] = entry` on an object literal sent a `__proto__` metadata pair
 * into `Object.prototype`'s setter, which ignores a string silently: 200, pair
 * gone, and a pair count that no longer matched what read back.
 */
describe("T21-PROTO-KEYS: inherited names are not members, `__proto__` is a metadata key", () => {
  let mock: LLMock;
  beforeEach(async () => {
    clearFineTuningStore();
    mock = new LLMock({ port: 0 });
    await mock.start();
  });
  afterEach(async () => {
    await mock.stop();
    clearFineTuningStore();
  });

  type ErrorBody = { error: { message: string } };

  const create = (body: Record<string, unknown>): Promise<Wire<ErrorBody>> =>
    post<ErrorBody>(`${mock.url}/v1/fine_tuning/jobs`, {
      model: "gpt-4o-mini",
      training_file: "file-1",
      ...body,
    });

  // The message a genuinely unknown member earns, for shape comparison.
  const unknownTopLevel = (key: string): string =>
    `Invalid parameter: 'hyperparameters.${key}' is not a recognized member of ` +
    `'hyperparameters'; it accepts n_epochs, batch_size, learning_rate_multiplier`;

  it.each(["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"])(
    "rejects the inherited name %s in the deprecated top-level hyperparameters",
    async (key) => {
      const res = await create({ hyperparameters: { [key]: "auto", n_epochs: 3 } });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe(unknownTopLevel(key));
    },
  );

  it("names the same domain for an inherited name as for a real unknown member", async () => {
    const beta = await create({ hyperparameters: { beta: 0.5 } });
    expect(beta.status).toBe(400);
    expect(beta.body.error.message).toBe(unknownTopLevel("beta"));
  });

  it("never quotes an undefined domain for a numeric value on an inherited name", async () => {
    const res = await create({ hyperparameters: { constructor: 3 } });
    expect(res.status).toBe(400);
    expect(res.body.error.message).not.toContain("undefined");
    expect(res.body.error.message).toBe(unknownTopLevel("constructor"));
  });

  it("rejects an inherited name inside method.dpo.hyperparameters", async () => {
    const res = await create({
      method: { type: "dpo", dpo: { hyperparameters: { toString: "auto" } } },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe(
      "Invalid parameter: 'method.dpo.hyperparameters.toString' is not a recognized member of " +
        "'method.dpo.hyperparameters'; it accepts n_epochs, batch_size, learning_rate_multiplier, beta",
    );
  });

  it("rejects an inherited name inside method.supervised.hyperparameters", async () => {
    const res = await create({
      method: { type: "supervised", supervised: { hyperparameters: { valueOf: "auto" } } },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain(
      "'method.supervised.hyperparameters.valueOf' is not a recognized member of",
    );
  });

  it("keeps a __proto__ metadata pair as an own key and echoes it back", async () => {
    const created = await post<{ id: string; metadata: Record<string, string> }>(
      `${mock.url}/v1/fine_tuning/jobs`,
      {
        model: "gpt-4o-mini",
        training_file: "file-1",
        // A computed key, because `__proto__: "x"` in a literal is the
        // prototype setter and would never reach the wire at all.
        metadata: { ["__proto__"]: "x", k: "v" },
      },
    );
    expect(created.status).toBe(200);
    // `Object.entries` reads own enumerable keys, which is the only reading
    // under which a swallowed `__proto__` is distinguishable from a kept one.
    expect(Object.entries(created.body.metadata)).toEqual([
      ["__proto__", "x"],
      ["k", "v"],
    ]);

    const fetched = await call<{ metadata: Record<string, string> }>(
      `${mock.url}/v1/fine_tuning/jobs/${created.body.id}`,
    );
    expect(fetched.status).toBe(200);
    expect(Object.entries(fetched.body.metadata)).toEqual([
      ["__proto__", "x"],
      ["k", "v"],
    ]);
  });

  it("does not let a metadata key escape onto Object.prototype", async () => {
    const res = await send(`${mock.url}/v1/fine_tuning/jobs`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        model: "gpt-4o-mini",
        training_file: "file-1",
        metadata: { ["__proto__"]: "polluted" },
      }),
    });
    expect(res.status).toBe(200);
    expect(res.text).toContain('"__proto__":"polluted"');
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  it("still accepts the members these objects really do take", async () => {
    const res = await post<{ hyperparameters: Record<string, unknown> }>(
      `${mock.url}/v1/fine_tuning/jobs`,
      {
        model: "gpt-4o-mini",
        training_file: "file-1",
        hyperparameters: { n_epochs: "auto", batch_size: 4 },
      },
    );
    expect(res.status).toBe(200);
    expect(res.body.hyperparameters).toEqual({ n_epochs: "auto", batch_size: 4 });
  });

  it("still accepts a full 16-pair metadata object", async () => {
    const metadata = Object.fromEntries(
      Array.from({ length: 16 }, (_, i) => [`k${i}`, `v${i}`] as const),
    );
    const res = await post<{ metadata: Record<string, string> }>(
      `${mock.url}/v1/fine_tuning/jobs`,
      { model: "gpt-4o-mini", training_file: "file-1", metadata },
    );
    expect(res.status).toBe(200);
    expect(res.body.metadata).toEqual(metadata);
  });
});

/**
 * `method` is keyed on its own `type`, not on which sub-objects happen to be
 * present: `type: "reinforcement"` requires a `grader` even with no
 * `reinforcement` object at all, and a configuration belonging to a type that
 * was not chosen is rejected rather than validated, echoed, or dropped.
 */
describe("Fine-tuning method type keying", () => {
  let mock: LLMock;
  beforeEach(async () => {
    clearFineTuningStore();
    mock = new LLMock({ port: 0 });
    await mock.start();
  });
  afterEach(async () => {
    await mock.stop();
    clearFineTuningStore();
  });

  const createWithMethod = (method: unknown) =>
    post<{ method: unknown; error: { message: string } }>(`${mock.url}/v1/fine_tuning/jobs`, {
      training_file: "file-train",
      model: "gpt-4o-mini",
      method,
    });

  /** The message of a 400, asserted to BE a 400 first so a 200 names itself. */
  async function methodRejection(method: unknown): Promise<string> {
    const res = await createWithMethod(method);
    expect({ status: res.status, body: res.body }).toMatchObject({ status: 400 });
    return res.body.error.message;
  }

  it("requires a grader for a reinforcement type carrying no reinforcement object", async () => {
    expect(await methodRejection({ type: "reinforcement" })).toContain(
      "'method.reinforcement.grader' is required",
    );
    // An explicitly empty object is the same missing grader, not a different one.
    expect(await methodRejection({ type: "reinforcement", reinforcement: {} })).toContain(
      "'method.reinforcement.grader' is required",
    );
    expect(
      await methodRejection({ type: "reinforcement", reinforcement: { grader: 42 } }),
    ).toContain("'method.reinforcement.grader' is required");
  });

  it("rejects a configuration belonging to a type that was not chosen", async () => {
    // A reinforcement object under a supervised type is a stray configuration,
    // NOT a missing grader: the message must name the stray member.
    const stray = await methodRejection({ type: "supervised", reinforcement: {} });
    expect(stray).toContain("'method.reinforcement'");
    expect(stray).toContain(`'method.type' is "supervised"`);
    expect(stray).not.toContain("grader");

    // A well-formed config for a non-selected variant is not validated-and-echoed.
    expect(
      await methodRejection({ type: "supervised", dpo: { hyperparameters: { beta: 0.5 } } }),
    ).toContain("'method.dpo'");
    expect(
      await methodRejection({ type: "dpo", supervised: { hyperparameters: { n_epochs: 3 } } }),
    ).toContain("'method.supervised'");
  });

  it("accepts and echoes the chosen type's own configuration", async () => {
    for (const method of [
      { type: "supervised" },
      { type: "supervised", supervised: { hyperparameters: { n_epochs: 3 } } },
      { type: "dpo", dpo: { hyperparameters: { beta: 0.5 } } },
      { type: "reinforcement", reinforcement: { grader: { type: "string_check", name: "g" } } },
    ]) {
      const ok = await createWithMethod(method);
      expect({ status: ok.status, method: ok.body.method }).toEqual({ status: 200, method });
    }
  });

  it("still enforces the chosen type's own hyperparameter table", async () => {
    expect(
      await methodRejection({ type: "dpo", dpo: { hyperparameters: { beta: 2.5 } } }),
    ).toContain("'method.dpo.hyperparameters.beta'");
    // `beta` is a DPO knob; under a supervised method it is an unknown member.
    expect(
      await methodRejection({ type: "supervised", supervised: { hyperparameters: { beta: 0.5 } } }),
    ).toContain("'method.supervised.hyperparameters.beta'");
    expect(await methodRejection({ type: "dpo", dpo: 42 })).toContain("'method.dpo'");
  });
});

/**
 * Two ways a limit can be counted in the wrong unit, and one way an error can
 * quote a value nobody sent.
 *
 * Every `maxLength` this module enforces is a pydantic `max_length` on the
 * vendor's side, which counts Unicode code points; `String.prototype.length`
 * counts UTF-16 code units and agrees only while the string stays inside the
 * BMP. So the boundary cases below are all built the same way — the limit in
 * characters, with the last one astral — because that is precisely the string
 * the two units disagree about, and a mock that refused it would teach a
 * caller to shorten a name the real API accepts.
 *
 * The `after` cases are the mirror image on the way out: the rejection quotes
 * the offending cursor, and a caller matching that against its own request
 * needs the text it wrote, not the text `URLSearchParams` decoded it into.
 */
describe("Fine-tuning string limits are counted in code points", () => {
  let mock: LLMock;
  beforeEach(async () => {
    clearFineTuningStore();
    mock = new LLMock({ port: 0 });
    await mock.start();
  });
  afterEach(async () => {
    await mock.stop();
    clearFineTuningStore();
  });

  /** A string of exactly `points` code points whose last one is astral. */
  function astralOf(points: number, fill: string): string {
    const value = fill.repeat(points - 1) + "\u{1F600}";
    // The fixture is the whole point: if these two ever agree, the string has
    // stopped exercising the disagreement and the test below proves nothing.
    expect([...value].length).toBe(points);
    expect(value.length).toBe(points + 1);
    return value;
  }

  const create = (body: Record<string, unknown>) =>
    post<{ id: string; fine_tuned_model: string | null; error: { message: string } }>(
      `${mock.url}/v1/fine_tuning/jobs`,
      { training_file: "file-train", model: "gpt-4o-mini", ...body },
    );

  it("accepts a 64-code-point suffix and carries it into fine_tuned_model", async () => {
    const suffix = astralOf(64, "a");
    const created = await create({ suffix });
    expect({ status: created.status, body: created.body }).toMatchObject({ status: 200 });

    // Retrieve three times to reach `succeeded`, which is where the suffix
    // surfaces: accepting the value and then dropping it would be its own bug.
    let job: { status: string; fine_tuned_model: string | null } = {
      status: "validating_files",
      fine_tuned_model: null,
    };
    for (let i = 0; i < 3; i++) {
      const read = await call<{ status: string; fine_tuned_model: string | null }>(
        `${mock.url}/v1/fine_tuning/jobs/${created.body.id}`,
      );
      expect(read.status).toBe(200);
      job = read.body;
    }
    expect(job).toMatchObject({ status: "succeeded" });
    expect(job.fine_tuned_model).toContain(suffix);
  });

  it("rejects a 65-code-point suffix", async () => {
    const res = await create({ suffix: astralOf(65, "a") });
    expect({ status: res.status, body: res.body }).toMatchObject({ status: 400 });
    expect(res.body.error.message).toContain("'suffix'");
  });

  it("accepts a 64-code-point metadata key and rejects a 65-code-point one", async () => {
    const ok = await create({ metadata: { [astralOf(64, "k")]: "v" } });
    expect({ status: ok.status, body: ok.body }).toMatchObject({ status: 200 });

    const bad = await create({ metadata: { [astralOf(65, "k")]: "v" } });
    expect({ status: bad.status, body: bad.body }).toMatchObject({ status: 400 });
    // The count in the message is in the same unit as the limit it names —
    // "at most 64 ... got 66" for a 65-code-point key is the UTF-16 count
    // leaking out, and is what this pins against.
    expect(bad.body.error.message).toContain("at most 64 characters, got 65");
  });

  it("accepts a 512-code-point metadata value and rejects a 513-code-point one", async () => {
    const ok = await create({ metadata: { note: astralOf(512, "v") } });
    expect({ status: ok.status, body: ok.body }).toMatchObject({ status: 200 });

    const bad = await create({ metadata: { note: astralOf(513, "v") } });
    expect({ status: bad.status, body: bad.body }).toMatchObject({ status: 400 });
    expect(bad.body.error.message).toContain("'metadata.note'");
  });

  it("echoes an accepted astral metadata pair back unchanged", async () => {
    const key = astralOf(64, "k");
    const value = astralOf(512, "v");
    const created = await create({ metadata: { [key]: value } });
    expect({ status: created.status, body: created.body }).toMatchObject({ status: 200 });
    const read = await call<{ metadata: Record<string, string> }>(
      `${mock.url}/v1/fine_tuning/jobs/${created.body.id}`,
    );
    expect(read.status).toBe(200);
    expect(read.body.metadata).toEqual({ [key]: value });
  });

  it("quotes the raw query text of an unknown after, not its decoding", async () => {
    // `a%2Bb` decodes to `a+b` and a bare `a+b` decodes to `a b`, so a message
    // built from the decoded value names a string the caller never wrote.
    for (const sent of ["a%2Bb", "a+b", "%20x", "ftjob-nope"]) {
      const res = await call<{ error: { message: string } }>(
        `${mock.url}/v1/fine_tuning/jobs?after=${sent}`,
      );
      expect({ status: res.status, sent, body: res.body }).toMatchObject({ status: 400 });
      expect(res.body.error.message).toContain(`'${sent}'`);
    }
  });

  it("still names an empty after, and still resumes from a real cursor", async () => {
    const id = await createJob(mock.url);
    const empty = await call<{ error: { message: string } }>(
      `${mock.url}/v1/fine_tuning/jobs?after=`,
    );
    expect({ status: empty.status, body: empty.body }).toMatchObject({ status: 400 });
    expect(empty.body.error.message).toContain("''");

    // The raw-text quoting must not have disturbed the success path.
    const page = await call<{ data: { id: string }[]; has_more: boolean }>(
      `${mock.url}/v1/fine_tuning/jobs?after=${id}`,
    );
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ data: [], has_more: false });
  });

  it("quotes the raw query text of a bad limit, not its decoding", async () => {
    // The docs promise one rule for both list params: a 400 quotes what you
    // sent. `?limit=%2B5` used to come back naming `'+5'`, a spelling that
    // appears nowhere in the request the caller is staring at.
    for (const sent of ["%2B5", "%200x10", "%2020%20", "0x10", "1e2"]) {
      const res = await call<{ error: { message: string } }>(
        `${mock.url}/v1/fine_tuning/jobs?limit=${sent}`,
      );
      expect({ status: res.status, sent, body: res.body }).toMatchObject({ status: 400 });
      expect(res.body.error.message).toContain(`'${sent}'`);
    }

    // The raw-text quoting must not have disturbed the success path.
    const page = await call<{ data: unknown[] }>(`${mock.url}/v1/fine_tuning/jobs?limit=5`);
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ data: [] });
  });
});
