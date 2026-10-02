import { describe, it, expect, afterEach, vi } from "vitest";
import * as http from "node:http";
import type { Fixture, ChatCompletionRequest } from "../types.js";
import { createServer, type ServerInstance } from "../server.js";
import { LLMock } from "../llmock.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function request(
  url: string,
  method: string,
  opts?: { body?: unknown; headers?: Record<string, string | string[]> },
): Promise<{
  status: number;
  body: string;
  json: unknown;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = opts?.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method,
        headers: {
          ...(data
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
            : {}),
          ...opts?.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          let json: unknown = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({
            status: res.statusCode ?? 0,
            body: text,
            json,
            headers: res.headers,
          });
        });
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function chatRequest(content: string): ChatCompletionRequest {
  return { model: "gpt-4", stream: false, messages: [{ role: "user", content }] };
}

let instance: ServerInstance | null = null;

afterEach(async () => {
  if (instance) {
    await new Promise<void>((resolve) => {
      instance!.server.close(() => resolve());
    });
    instance = null;
  }
});

async function seedTraffic(): Promise<void> {
  const fixtures: Fixture[] = [{ match: { userMessage: "hello" }, response: { content: "Hi" } }];
  instance = await createServer(fixtures);
  await request(`${instance.url}/v1/chat/completions`, "POST", { body: chatRequest("hello") });
  await request(`${instance.url}/v1/chat/completions`, "POST", {
    body: chatRequest("unmatched prompt"),
    headers: { "X-Test-Id": "t1" },
  });
  await request(`${instance.url}/search`, "POST", { body: { query: "cats" } });
}

// ---------------------------------------------------------------------------
// GET /__aimock/journal filtering & pagination
// ---------------------------------------------------------------------------

describe("GET /__aimock/journal filters", () => {
  it("returns the full array when no params are given (back-compat)", async () => {
    await seedTraffic();
    const res = await request(`${instance!.url}/__aimock/journal`, "GET");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json)).toBe(true);
    expect((res.json as unknown[]).length).toBe(3);
  });

  it("paginates with limit and offset", async () => {
    await seedTraffic();
    const limited = await request(`${instance!.url}/__aimock/journal?limit=2`, "GET");
    expect(limited.status).toBe(200);
    expect((limited.json as unknown[]).length).toBe(2);

    const offset = await request(`${instance!.url}/__aimock/journal?offset=2`, "GET");
    expect(offset.status).toBe(200);
    expect((offset.json as unknown[]).length).toBe(1);

    const page = await request(`${instance!.url}/__aimock/journal?offset=1&limit=1`, "GET");
    expect(page.status).toBe(200);
    const entries = page.json as { path: string }[];
    expect(entries.length).toBe(1);

    const zero = await request(`${instance!.url}/__aimock/journal?limit=0`, "GET");
    expect(zero.status).toBe(200);
    expect(zero.json).toEqual([]);
  });

  it("filters by path substring, method, status, and service", async () => {
    await seedTraffic();
    const byPath = await request(`${instance!.url}/__aimock/journal?path=/search`, "GET");
    expect(byPath.status).toBe(200);
    const pathEntries = byPath.json as { path: string }[];
    expect(pathEntries.length).toBe(1);
    expect(pathEntries[0].path).toBe("/search");

    const byMethod = await request(`${instance!.url}/__aimock/journal?method=post`, "GET");
    expect(byMethod.status).toBe(200);
    // Filter is case-insensitive: all three seeded entries are POSTs
    expect((byMethod.json as unknown[]).length).toBe(3);
    const byMethodGet = await request(`${instance!.url}/__aimock/journal?method=GET`, "GET");
    expect(byMethodGet.status).toBe(200);
    expect(byMethodGet.json).toEqual([]);

    // `path` is a SUBSTRING match — an exact comparison would find nothing.
    const byPathPart = await request(`${instance!.url}/__aimock/journal?path=chat`, "GET");
    expect((byPathPart.json as unknown[]).length).toBe(2);

    const byService = await request(`${instance!.url}/__aimock/journal?service=search`, "GET");
    expect(byService.status).toBe(200);
    expect((byService.json as unknown[]).length).toBe(1);
    // ...while `service` is EXACT — a substring match would find "search".
    const byServicePart = await request(`${instance!.url}/__aimock/journal?service=sear`, "GET");
    expect(byServicePart.json).toEqual([]);

    const byStatus = await request(`${instance!.url}/__aimock/journal?status=200`, "GET");
    expect(byStatus.status).toBe(200);
    // Matched chat + search are 200; the unmatched chat records 404
    expect((byStatus.json as unknown[]).length).toBe(2);

    const by404 = await request(`${instance!.url}/__aimock/journal?status=404`, "GET");
    expect(by404.status).toBe(200);
    expect((by404.json as unknown[]).length).toBe(1);

    const missing = await request(`${instance!.url}/__aimock/journal?status=429`, "GET");
    expect(missing.status).toBe(200);
    expect(missing.json).toEqual([]);
  });

  it("filters by testId via the X-Test-Id header", async () => {
    await seedTraffic();
    const res = await request(`${instance!.url}/__aimock/journal?testId=t1`, "GET");
    expect(res.status).toBe(200);
    const entries = res.json as { headers: Record<string, string> }[];
    expect(entries.length).toBe(1);
    expect(entries[0].headers["x-test-id"]).toBe("t1");
  });

  it("rejects invalid limit/offset/status with 400", async () => {
    await seedTraffic();
    for (const qs of [
      "limit=-1",
      "limit=abc",
      "limit=1.5",
      "offset=-2",
      "offset=nope",
      "status=ok",
    ]) {
      const res = await request(`${instance!.url}/__aimock/journal?${qs}`, "GET");
      expect(res.status).toBe(400);
    }
    // Journal itself is untouched by the rejected reads
    const full = await request(`${instance!.url}/__aimock/journal`, "GET");
    expect((full.json as unknown[]).length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// GET /__aimock/fixtures dump
// ---------------------------------------------------------------------------

describe("GET /__aimock/fixtures dump", () => {
  it("returns only the count by default (back-compat)", async () => {
    instance = await createServer([
      { match: { userMessage: "hello" }, response: { content: "Hi" } },
    ]);
    const res = await request(`${instance.url}/__aimock/fixtures`, "GET");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ count: 1 });
  });

  it("dumps redacted fixtures with ?include=fixtures", async () => {
    instance = await createServer([
      { match: { userMessage: "hello" }, response: { content: "Hi" } },
      {
        match: { userMessage: /bye.*/i, predicate: () => true },
        response: { error: { message: "nope" }, status: 400 },
      },
    ]);
    const res = await request(`${instance.url}/__aimock/fixtures?include=fixtures`, "GET");
    expect(res.status).toBe(200);
    const body = res.json as {
      count: number;
      fixtures: { index: number; match: Record<string, unknown>; responseKind: string }[];
    };
    expect(body.count).toBe(2);
    expect(body.fixtures.length).toBe(2);
    expect(body.fixtures[0]).toMatchObject({ index: 0, responseKind: "text" });
    expect(body.fixtures[0].match).toEqual({ userMessage: "hello" });
    // RegExp stringified, predicate redacted — both JSON-safe
    expect(body.fixtures[1].match).toEqual({ userMessage: "/bye.*/i", predicate: "[function]" });
    expect(body.fixtures[1].responseKind).toBe("error");
    // Round-trips through JSON (no functions survive)
    expect(() => JSON.stringify(body)).not.toThrow();
  });

  it("rejects unknown include values with 400", async () => {
    instance = await createServer([]);
    const res = await request(`${instance.url}/__aimock/fixtures?include=bogus`, "GET");
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET/POST/DELETE /__aimock/chaos runtime control
// ---------------------------------------------------------------------------

describe("GET/POST/DELETE /__aimock/chaos", () => {
  it("reads the construction chaos config", async () => {
    instance = await createServer([], { chaos: { dropRate: 0 } });
    const res = await request(`${instance.url}/__aimock/chaos`, "GET");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ chaos: { dropRate: 0 } });
  });

  it("reads empty chaos by default", async () => {
    instance = await createServer([]);
    const res = await request(`${instance.url}/__aimock/chaos`, "GET");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ chaos: {} });
  });

  it("applies dropRate at runtime without a restart", async () => {
    instance = await createServer([
      { match: { userMessage: "hello" }, response: { content: "Hi" } },
    ]);
    const put = await request(`${instance.url}/__aimock/chaos`, "POST", {
      body: { dropRate: 1 },
    });
    expect(put.status).toBe(200);
    expect(put.json).toEqual({ chaos: { dropRate: 1 } });

    const dropped = await request(`${instance.url}/v1/chat/completions`, "POST", {
      body: chatRequest("hello"),
    });
    expect(dropped.status).toBe(500);

    // Clearing restores normal traffic
    const cleared = await request(`${instance.url}/__aimock/chaos`, "POST", { body: {} });
    expect(cleared.status).toBe(200);
    expect(cleared.json).toEqual({ chaos: {} });
    const ok = await request(`${instance.url}/v1/chat/completions`, "POST", {
      body: chatRequest("hello"),
    });
    expect(ok.status).toBe(200);
  });

  it("rejects out-of-range, non-numeric, and unknown fields with 400", async () => {
    instance = await createServer([]);
    const badBodies: unknown[] = [
      { dropRate: 2 },
      { dropRate: -0.5 },
      { malformedRate: "1" },
      { disconnectRate: Number.NaN },
      { drop_rate: 1 },
      { dropRate: 1, bogus: true },
      [1],
      "chaos",
      [],
    ];
    for (const body of badBodies) {
      const res = await request(`${instance.url}/__aimock/chaos`, "POST", { body });
      expect(res.status).toBe(400);
    }
    // Nothing was applied
    const current = await request(`${instance.url}/__aimock/chaos`, "GET");
    expect(current.json).toEqual({ chaos: {} });
  });

  // Reset is the isolation barrier a parallel harness leans on; chaos escaping
  // it poisons later tests with 500s that look like application bugs.
  it("POST /__aimock/reset clears the runtime chaos override", async () => {
    instance = await createServer([
      { match: { userMessage: "hello" }, response: { content: "Hi" } },
    ]);
    const set = await request(`${instance.url}/__aimock/chaos`, "POST", { body: { dropRate: 1 } });
    expect(set.status).toBe(200);
    expect(
      (await request(`${instance.url}/v1/chat/completions`, "POST", { body: chatRequest("hello") }))
        .status,
    ).toBe(500);

    expect((await request(`${instance.url}/__aimock/reset`, "POST")).status).toBe(200);
    expect((await request(`${instance.url}/__aimock/chaos`, "GET")).json).toEqual({ chaos: {} });

    await request(`${instance.url}/__aimock/fixtures`, "POST", {
      body: { fixtures: [{ match: { userMessage: "hello" }, response: { content: "Hi" } }] },
    });
    const ok = await request(`${instance.url}/v1/chat/completions`, "POST", {
      body: chatRequest("hello"),
    });
    expect(ok.status).toBe(200);
  });

  // The override must not latch: a server started with --chaos-drop has to be
  // recoverable after any test does PUT {}.
  it("does not permanently destroy the construction chaos config", async () => {
    instance = await createServer([], { chaos: { dropRate: 1 } });
    expect((await request(`${instance.url}/__aimock/chaos`, "POST", { body: {} })).json).toEqual({
      chaos: {},
    });
    await request(`${instance.url}/__aimock/reset`, "POST");
    expect((await request(`${instance.url}/__aimock/chaos`, "GET")).json).toEqual({
      chaos: { dropRate: 1 },
    });
  });

  // Node tests never issue a preflight, so a browser harness is the only thing
  // that notices a verb the control API does not advertise.
  it("only uses verbs the CORS preflight advertises", async () => {
    instance = await createServer([]);
    const preflight = await request(`${instance.url}/__aimock/chaos`, "OPTIONS", {
      headers: {
        Origin: "http://localhost:3000",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    expect(preflight.status).toBe(204);
    const allowed = String(preflight.headers["access-control-allow-methods"])
      .split(",")
      .map((m) => m.trim());
    expect(allowed).toEqual(expect.arrayContaining(["GET", "POST", "PUT", "DELETE"]));
    // PUT is unused on the control surface itself (still 404s there) but IS
    // dispatched for `/fal/queue/requests/{requestId}`, and the preflight
    // headers are server-wide — omitting it makes browsers refuse that call.
    expect((await request(`${instance.url}/__aimock/chaos`, "PUT", { body: {} })).status).toBe(404);
    // The fal surface's PUT must survive a browser preflight too.
    const falPreflight = await request(`${instance.url}/fal/queue/requests/r1`, "OPTIONS", {
      headers: {
        Origin: "http://localhost:3000",
        "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    expect(falPreflight.status).toBe(204);
    expect(
      String(falPreflight.headers["access-control-allow-methods"])
        .split(",")
        .map((m) => m.trim()),
    ).toEqual(expect.arrayContaining(["PUT"]));
    // The journal total is a response header, so it must be readable too.
    expect(String(preflight.headers["access-control-expose-headers"])).toContain("X-Total-Count");
  });

  it("DELETE drops the override without waiting for a full reset", async () => {
    instance = await createServer([], { chaos: { dropRate: 1 } });
    await request(`${instance.url}/__aimock/chaos`, "POST", { body: {} });
    expect((await request(`${instance.url}/__aimock/chaos`, "GET")).json).toEqual({ chaos: {} });
    const del = await request(`${instance.url}/__aimock/chaos`, "DELETE");
    expect(del.status).toBe(200);
    expect(del.json).toEqual({ chaos: { dropRate: 1 } });
  });

  // Chaos is per-testId like every other mutable axis: one test turning it on
  // must not fail the tests running beside it on a shared server.
  it("scopes an override to the caller's testId", async () => {
    instance = await createServer([
      { match: { userMessage: "hello" }, response: { content: "Hi" } },
    ]);
    const put = await request(`${instance.url}/__aimock/chaos`, "POST", {
      body: { dropRate: 1 },
      headers: { "X-Test-Id": "t1" },
    });
    expect(put.json).toEqual({ chaos: { dropRate: 1 } });

    // t1's traffic is chaotic...
    const t1 = await request(`${instance.url}/v1/chat/completions`, "POST", {
      body: chatRequest("hello"),
      headers: { "X-Test-Id": "t1" },
    });
    expect(t1.status).toBe(500);

    // ...while a concurrent test and untagged traffic are untouched.
    const t2 = await request(`${instance.url}/v1/chat/completions`, "POST", {
      body: chatRequest("hello"),
      headers: { "X-Test-Id": "t2" },
    });
    expect(t2.status).toBe(200);
    const untagged = await request(`${instance.url}/v1/chat/completions`, "POST", {
      body: chatRequest("hello"),
    });
    expect(untagged.status).toBe(200);

    // GET reports per-testId too.
    const readT1 = await request(`${instance.url}/__aimock/chaos`, "GET", {
      headers: { "X-Test-Id": "t1" },
    });
    expect(readT1.json).toEqual({ chaos: { dropRate: 1 } });
    expect((await request(`${instance.url}/__aimock/chaos`, "GET")).json).toEqual({ chaos: {} });

    // ...and DELETE scoped to t1 restores it.
    await request(`${instance.url}/__aimock/chaos`, "DELETE", { headers: { "X-Test-Id": "t1" } });
    const after = await request(`${instance.url}/v1/chat/completions`, "POST", {
      body: chatRequest("hello"),
      headers: { "X-Test-Id": "t1" },
    });
    expect(after.status).toBe(200);
  });

  // The scope lookup is a SELECTION, not a field-wise merge: a scoped override
  // stands in for the baseline entirely. Pinned because the alternative reading
  // — layering the override over the baseline — is the intuitive one, and it is
  // wrong here.
  it("a scoped override replaces the baseline wholesale instead of merging into it", async () => {
    instance = await createServer(
      [{ match: { userMessage: "hello" }, response: { content: "Hi" } }],
      {
        chaos: { latencyMs: 2000 },
      },
    );
    const put = await request(`${instance.url}/__aimock/chaos`, "POST", {
      body: { dropRate: 1 },
      headers: { "X-Test-Id": "t1" },
    });
    // The baseline latency is GONE for t1 — not merged in — and the 200 body
    // says so, so the readback is the contract, not a summary of it.
    expect(put.json).toEqual({ chaos: { dropRate: 1 } });
    expect(
      (await request(`${instance.url}/__aimock/chaos`, "GET", { headers: { "X-Test-Id": "t1" } }))
        .json,
    ).toEqual({ chaos: { dropRate: 1 } });
    // ...while the untagged baseline still has it.
    expect((await request(`${instance.url}/__aimock/chaos`, "GET")).json).toEqual({
      chaos: { latencyMs: 2000 },
    });

    // And on the wire: t1's drop fires without waiting out the baseline's 2s.
    // The bound is deliberately loose (a merge would take >= 2000ms).
    const started = Date.now();
    const t1 = await request(`${instance.url}/v1/chat/completions`, "POST", {
      body: chatRequest("hello"),
      headers: { "X-Test-Id": "t1" },
    });
    expect(t1.status).toBe(500);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  // `POST {}` and `DELETE` are different operations — "explicitly no chaos for
  // my test" vs "forget I said anything". A field-wise merge would make
  // `POST {}` a no-op and collapse the two, so this pins the difference.
  it("a scoped POST {} means no chaos for that test, not 'inherit the baseline'", async () => {
    instance = await createServer(
      [{ match: { userMessage: "hello" }, response: { content: "Hi" } }],
      {
        chaos: { dropRate: 1 },
      },
    );
    expect(
      (
        await request(`${instance.url}/__aimock/chaos`, "POST", {
          body: {},
          headers: { "X-Test-Id": "t1" },
        })
      ).json,
    ).toEqual({ chaos: {} });

    const t1 = await request(`${instance.url}/v1/chat/completions`, "POST", {
      body: chatRequest("hello"),
      headers: { "X-Test-Id": "t1" },
    });
    expect(t1.status).toBe(200);
    // The baseline is untouched for everyone else.
    const untagged = await request(`${instance.url}/v1/chat/completions`, "POST", {
      body: chatRequest("hello"),
    });
    expect(untagged.status).toBe(500);
  });

  // Replacement is the contract, but losing a baseline rate silently is not:
  // the install names every field it drops.
  it("warns when a scoped install drops a field the baseline had set", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      instance = await createServer([], { chaos: { latencyMs: 500 }, logLevel: "warn" });
      await request(`${instance.url}/__aimock/chaos`, "POST", {
        body: { dropRate: 1 },
        headers: { "X-Test-Id": "t1" },
      });
      const lines = warn.mock.calls.map((args) => args.join(" "));
      const dropWarning = lines.find((line) => line.includes("latencyMs=500"));
      expect(dropWarning).toBeDefined();
      expect(dropWarning).toContain("t1");
      expect(dropWarning).toContain("wholesale");

      // A restated field is not reported as lost.
      warn.mockClear();
      await request(`${instance.url}/__aimock/chaos`, "POST", {
        body: { dropRate: 1, latencyMs: 500 },
        headers: { "X-Test-Id": "t2" },
      });
      expect(warn.mock.calls.map((args) => args.join(" ")).join("\n")).not.toContain("latencyMs=");
    } finally {
      warn.mockRestore();
    }
  });

  it("POST /__aimock/reset clears per-testId overrides too", async () => {
    instance = await createServer([
      { match: { userMessage: "hello" }, response: { content: "Hi" } },
    ]);
    const set = await request(`${instance.url}/__aimock/chaos`, "POST", {
      body: { dropRate: 1 },
      headers: { "X-Test-Id": "t1" },
    });
    expect(set.status).toBe(200);
    expect(
      (
        await request(`${instance.url}/v1/chat/completions`, "POST", {
          body: chatRequest("hello"),
          headers: { "X-Test-Id": "t1" },
        })
      ).status,
    ).toBe(500);
    await request(`${instance.url}/__aimock/reset`, "POST");
    await request(`${instance.url}/__aimock/fixtures`, "POST", {
      body: { fixtures: [{ match: { userMessage: "hello" }, response: { content: "Hi" } }] },
    });
    const ok = await request(`${instance.url}/v1/chat/completions`, "POST", {
      body: chatRequest("hello"),
      headers: { "X-Test-Id": "t1" },
    });
    expect(ok.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Journal: unknown params, testId resolution, pagination total
// ---------------------------------------------------------------------------

async function seedSharpTraffic(): Promise<void> {
  instance = await createServer([{ match: { userMessage: "hello" }, response: { content: "Hi" } }]);
  await request(`${instance.url}/search?testId=t10`, "POST", { body: { query: "mice" } });
  await request(`${instance.url}/search`, "POST", {
    body: { query: "cats" },
    headers: { "X-Test-Id": "t1" },
  });
  await request(`${instance.url}/search?testId=t2`, "POST", { body: { query: "dogs" } });
}

describe("journal param handling", () => {
  it("rejects unknown query parameters with 400", async () => {
    await seedSharpTraffic();
    for (const qs of ["pathh=/search", "statusCode=404", "test_id=t1"]) {
      const res = await request(`${instance!.url}/__aimock/journal?${qs}`, "GET");
      expect(res.status).toBe(400);
      expect((res.json as { error: string }).error).toContain("Unknown query parameter");
    }
  });

  it("resolves testId exactly, so t1 does not collide with t10", async () => {
    await seedSharpTraffic();
    const t1 = await request(`${instance!.url}/__aimock/journal?testId=t1`, "GET");
    const t1Entries = t1.json as { path: string }[];
    expect(t1Entries.length).toBe(1);
    expect(t1Entries[0].path).toBe("/search");

    // ...and a testId carried in the query string still resolves.
    const t2 = await request(`${instance!.url}/__aimock/journal?testId=t2`, "GET");
    const t2Entries = t2.json as { path: string }[];
    expect(t2Entries.length).toBe(1);
    expect(t2Entries[0].path).toBe("/search?testId=t2");
  });

  it("reports the pre-pagination match total in X-Total-Count", async () => {
    await seedSharpTraffic();
    const all = await request(`${instance!.url}/__aimock/journal`, "GET");
    expect(all.headers["x-total-count"]).toBe("3");
    const paged = await request(`${instance!.url}/__aimock/journal?limit=1&offset=1`, "GET");
    expect((paged.json as unknown[]).length).toBe(1);
    expect(paged.headers["x-total-count"]).toBe("3");
  });
});

// ---------------------------------------------------------------------------
// Fixture dump: response-kind discrimination
// ---------------------------------------------------------------------------

describe("fixture dump responseKind", () => {
  it("discriminates by response shape, not by key order", async () => {
    instance = await createServer([
      // Recorded shape: ResponseOverrides fields come FIRST in the literal, so
      // Object.keys()[0] would report "id".
      {
        match: { userMessage: "a", systemMessage: ["alpha", "beta"] },
        response: { id: "chatcmpl-1", model: "gpt-4", usage: {}, content: "Hi" },
        latency: 25,
        chaos: { dropRate: 0.5 },
      },
      { match: { userMessage: "b" }, response: { status: 400, error: { message: "nope" } } },
      // ORDERING CONTRACT: audio wins over the content/toolCalls guards.
      {
        match: { userMessage: "c" },
        response: { content: "spoken", toolCalls: [], audio: "AAAA", format: "mp3" },
      },
      { match: { userMessage: "d" }, response: { embedding: [0.1, 0.2] } },
      { match: { userMessage: "e" }, response: { image: { b64Json: "AAAA" } } },
      { match: { userMessage: "f" }, response: { json: { ok: true } } },
      {
        match: { userMessage: "g" },
        response: { video: { id: "v1", status: "completed", url: "https://x/y.mp4" } },
      },
      { match: { userMessage: "h" }, response: { transcription: { text: "hi" } } },
      { match: { userMessage: "i" }, response: { toolCalls: [{ name: "t", arguments: "{}" }] } },
      {
        match: { userMessage: "j" },
        response: { content: "both", toolCalls: [{ name: "t", arguments: "{}" }] },
      },
      { match: { userMessage: "k" }, response: () => ({ content: "from a factory" }) },
    ]);
    const res = await request(`${instance.url}/__aimock/fixtures?include=fixtures`, "GET");
    expect(res.status).toBe(200);
    const body = res.json as { fixtures: Record<string, unknown>[] };
    expect(body.fixtures.map((f) => f.responseKind)).toEqual([
      "text",
      "error",
      "audio",
      "embedding",
      "image",
      "json",
      "video",
      "transcription",
      "toolCalls",
      "contentWithToolCalls",
      "factory",
    ]);
    // The kind label lives under `responseKind`; `response` means the response
    // ITSELF on Fixture and must not name a kind string.
    expect(body.fixtures[0]).not.toHaveProperty("response");
    // Per-fixture latency/chaos still ride along.
    expect(body.fixtures[0].latency).toBe(25);
    expect(body.fixtures[0].chaos).toEqual({ dropRate: 0.5 });
    expect(body.fixtures[1]).not.toHaveProperty("latency");
    // Array-valued match criteria survive redaction as arrays.
    expect(body.fixtures[0].match).toEqual({
      userMessage: "a",
      systemMessage: ["alpha", "beta"],
    });
  });
});

// ---------------------------------------------------------------------------
// Chaos scoping: the cross-test-leak boundary
// ---------------------------------------------------------------------------

describe("chaos scope isolation", () => {
  it("rejects a present-but-empty X-Test-Id instead of installing a server-wide baseline", async () => {
    instance = await createServer([
      { match: { userMessage: "hello" }, response: { content: "Hi" } },
    ]);
    // `String(testId ?? "")` in a harness sends this. Treating it as "untagged"
    // would drop chaos on every other test running against the same server.
    const res = await request(`${instance.url}/__aimock/chaos`, "POST", {
      body: { dropRate: 1 },
      headers: { "X-Test-Id": "" },
    });
    expect(res.status).toBe(400);

    const foreign = await request(`${instance.url}/v1/chat/completions`, "POST", {
      body: chatRequest("hello"),
      headers: { "X-Test-Id": "t2" },
    });
    expect(foreign.status).toBe(200);
    const untagged = await request(`${instance.url}/v1/chat/completions`, "POST", {
      body: chatRequest("hello"),
    });
    expect(untagged.status).toBe(200);

    // GET and DELETE reject it too — a blank tag is never a scope.
    expect(
      (await request(`${instance.url}/__aimock/chaos`, "GET", { headers: { "X-Test-Id": "" } }))
        .status,
    ).toBe(400);
    expect(
      (await request(`${instance.url}/__aimock/chaos`, "DELETE", { headers: { "X-Test-Id": "" } }))
        .status,
    ).toBe(400);
  });

  it("leaves per-testId overrides alone when an untagged DELETE drops the baseline", async () => {
    instance = await createServer([
      { match: { userMessage: "hello" }, response: { content: "Hi" } },
    ]);
    const installed = await request(`${instance.url}/__aimock/chaos`, "POST", {
      body: { dropRate: 1 },
      headers: { "X-Test-Id": "t1" },
    });
    expect(installed.status).toBe(200);
    const before = await request(`${instance.url}/v1/chat/completions`, "POST", {
      body: chatRequest("hello"),
      headers: { "X-Test-Id": "t1" },
    });
    expect(before.status).toBe(500);

    // Another test's cleanup. Untagged DELETE is symmetric with untagged POST:
    // it drops the baseline only. Only POST /__aimock/reset clears everything.
    const del = await request(`${instance.url}/__aimock/chaos`, "DELETE");
    expect(del.status).toBe(200);

    const after = await request(`${instance.url}/v1/chat/completions`, "POST", {
      body: chatRequest("hello"),
      headers: { "X-Test-Id": "t1" },
    });
    expect(after.status).toBe(500);

    // ...and POST /__aimock/reset still is the full clear.
    await request(`${instance.url}/__aimock/reset`, "POST");
    const reset = await request(`${instance.url}/v1/chat/completions`, "POST", {
      body: chatRequest("hello"),
      headers: { "X-Test-Id": "t1" },
    });
    expect(reset.status).not.toBe(500);
  });

  it("scopes chaos by ?testId= exactly as it scopes by X-Test-Id", async () => {
    instance = await createServer([
      { match: { userMessage: "hello" }, response: { content: "Hi" } },
    ]);
    // Installed with a QUERY tag...
    const installed = await request(`${instance.url}/__aimock/chaos?testId=q1`, "POST", {
      body: { dropRate: 1 },
    });
    expect(installed.status).toBe(200);

    // ...applies to query-tagged AND header-tagged traffic for q1...
    const viaQuery = await request(`${instance.url}/v1/chat/completions?testId=q1`, "POST", {
      body: chatRequest("hello"),
    });
    expect(viaQuery.status).toBe(500);
    const viaHeader = await request(`${instance.url}/v1/chat/completions`, "POST", {
      body: chatRequest("hello"),
      headers: { "X-Test-Id": "q1" },
    });
    expect(viaHeader.status).toBe(500);

    // ...and to nothing else. A query tag is a SCOPE, not a server-wide switch.
    const untagged = await request(`${instance.url}/v1/chat/completions`, "POST", {
      body: chatRequest("hello"),
    });
    expect(untagged.status).toBe(200);
    const other = await request(`${instance.url}/v1/chat/completions?testId=q2`, "POST", {
      body: chatRequest("hello"),
    });
    expect(other.status).toBe(200);
  });

  it("rejects unknown query params on GET /__aimock/fixtures", async () => {
    instance = await createServer([
      { match: { userMessage: "hello" }, response: { content: "Hi" } },
    ]);
    // `?incluide=fixtures` must not quietly return the count-only body and pass
    // an assertion about a dump the caller never got — same rule as /journal.
    for (const qs of ["?nope=1", "?incluide=fixtures", "?Include=fixtures"]) {
      const res = await request(`${instance.url}/__aimock/fixtures${qs}`, "GET");
      expect(res.status).toBe(400);
    }
    expect((await request(`${instance.url}/__aimock/fixtures`, "GET")).status).toBe(200);
    expect(
      (await request(`${instance.url}/__aimock/fixtures?include=fixtures`, "GET")).status,
    ).toBe(200);
  });
});

describe("LLMock.setChaos / clearChaos vs a runtime override", () => {
  it("still takes effect after an untagged POST /__aimock/chaos has shadowed the options", async () => {
    const mock = new LLMock({ chaos: { dropRate: 1 } });
    mock.addFixture({ match: { userMessage: "hello" }, response: { content: "Hi" } });
    const url = await mock.start();
    try {
      expect(
        (await request(`${url}/v1/chat/completions`, "POST", { body: chatRequest("hello") }))
          .status,
      ).toBe(500);

      // An untagged control call installs a baseline override over options.chaos.
      expect((await request(`${url}/__aimock/chaos`, "POST", { body: {} })).status).toBe(200);
      expect(
        (await request(`${url}/v1/chat/completions`, "POST", { body: chatRequest("hello") }))
          .status,
      ).toBe(200);

      // The in-process API must not silently no-op against it.
      mock.setChaos({ dropRate: 1 });
      expect(
        (await request(`${url}/v1/chat/completions`, "POST", { body: chatRequest("hello") }))
          .status,
      ).toBe(500);

      mock.clearChaos();
      expect(
        (await request(`${url}/v1/chat/completions`, "POST", { body: chatRequest("hello") }))
          .status,
      ).toBe(200);
    } finally {
      await mock.stop();
    }
  });
});
