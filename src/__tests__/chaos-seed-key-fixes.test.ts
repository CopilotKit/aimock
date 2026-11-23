/**
 * Seeded chaos: the request identity key (CR round 2 of #618).
 *
 * A seeded verdict is keyed by what the CLIENT sent: the method, the request
 * target and the request body as the client wrote it. These tests pin four
 * properties of that key, on the real server:
 *
 * - The key does not depend on headers. The `X-AIMock-Context` header must
 *   not reach the key, even on routes whose handler copies it into the
 *   translated request (`_context`).
 * - `?testId=x` and `X-Test-Id: x` tag the same test, so they give the same
 *   key and the same verdict sequence.
 * - A JSON `null` body is not the same as no body, on a split gate and on an
 *   `applyChaosAsync` route alike.
 * - The raw text `hello` (not JSON) is not the same as the JSON string `"hello"`.
 */
import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import { createServer, type ServerInstance } from "../server.js";
import { chaosKeyFor } from "../chaos-random.js";
import type { Fixture, MockServerOptions } from "../types.js";

const SEED_HEADER = "x-aimock-chaos-seed";
const KEY_HEADER = "x-aimock-chaos-key";
const SEED = "key-fixes";

const FIXTURES: Fixture[] = [{ match: { userMessage: "hi" }, response: { content: "hello" } }];

interface Probe {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

const servers: ServerInstance[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((done) => s.server.close(() => done()))),
  );
});

async function start(options: MockServerOptions = {}): Promise<ServerInstance> {
  const instance = await createServer(structuredClone(FIXTURES), { port: 0, ...options });
  servers.push(instance);
  return instance;
}

function rawRequest(
  url: string,
  method: string,
  body: string | null,
  headers: Record<string, string> = {},
): Promise<Probe> {
  return new Promise((resolveProbe, reject) => {
    const req = http.request(
      url,
      { method, headers: { "Content-Type": "application/json", ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolveProbe({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on("error", reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

/** One seeded drop: returns the key the response reports. */
async function keyOf(
  url: string,
  method: string,
  path: string,
  body: string | null,
  headers: Record<string, string> = {},
): Promise<string> {
  const probe = await rawRequest(`${url}${path}`, method, body, headers);
  expect(probe.status, probe.body).toBe(500);
  expect(probe.headers[SEED_HEADER]).toBe(SEED);
  return String(probe.headers[KEY_HEADER]);
}

/**
 * The verdict sequence of `n` identical requests on a FRESH server (so its
 * occurrence counters start at zero): the status of each response.
 */
async function verdicts(
  path: string,
  body: string,
  headers: Record<string, string>,
  n = 12,
): Promise<number[]> {
  const { url } = await start({ chaos: { dropRate: 0.5, seed: SEED } });
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push((await rawRequest(`${url}${path}`, "POST", body, headers)).status);
  }
  return out;
}

const CHAT_BODY = JSON.stringify({
  model: "gpt-4o",
  messages: [{ role: "user", content: "hi" }],
});
const MESSAGES_BODY = JSON.stringify({
  model: "claude-sonnet-4-5",
  max_tokens: 64,
  messages: [{ role: "user", content: "hi" }],
});
const COHERE_BODY = JSON.stringify({
  model: "command-r",
  messages: [{ role: "user", content: "hi" }],
});

const TRANSLATED_ROUTES: Array<{ name: string; path: string; body: string }> = [
  { name: "chat completions (split gate)", path: "/v1/chat/completions", body: CHAT_BODY },
  { name: "messages", path: "/v1/messages", body: MESSAGES_BODY },
  { name: "cohere chat", path: "/v2/chat", body: COHERE_BODY },
];

describe("the key does not depend on X-AIMock-Context", () => {
  for (const route of TRANSLATED_ROUTES) {
    it(`${route.name}: same request, different context → same key, keyed by the client body`, async () => {
      const { url } = await start({ chaos: { dropRate: 1, seed: SEED } });
      const a = await keyOf(url, "POST", route.path, route.body, {
        "x-aimock-context": "ctx-a",
      });
      const b = await keyOf(url, "POST", route.path, route.body, {
        "x-aimock-context": "ctx-b",
      });
      const none = await keyOf(url, "POST", route.path, route.body);
      expect(b).toBe(a);
      expect(none).toBe(a);
      expect(a).toBe(
        chaosKeyFor({ method: "POST", path: route.path, body: JSON.parse(route.body) }),
      );
    });

    it(`${route.name}: same request, different context → same verdict sequence`, async () => {
      const a = await verdicts(route.path, route.body, { "x-aimock-context": "ctx-a" });
      const b = await verdicts(route.path, route.body, { "x-aimock-context": "ctx-b" });
      expect(b).toEqual(a);
    });
  }

  it("the journal entry carries the same client-body key", async () => {
    const instance = await start({ chaos: { dropRate: 1, seed: SEED } });
    await keyOf(instance.url, "POST", "/v1/messages", MESSAGES_BODY, {
      "x-aimock-context": "ctx-a",
    });
    const entry = instance.journal.getLast();
    expect(entry?.response.chaosKey).toBe(
      chaosKeyFor({ method: "POST", path: "/v1/messages", body: JSON.parse(MESSAGES_BODY) }),
    );
  });
});

describe("?testId= and X-Test-Id give the same key", () => {
  for (const route of TRANSLATED_ROUTES.slice(0, 2)) {
    it(`${route.name}: same key and the key leaves testId out`, async () => {
      const { url } = await start({ chaos: { dropRate: 1, seed: SEED } });
      const byHeader = await keyOf(url, "POST", route.path, route.body, { "x-test-id": "t1" });
      const byQuery = await keyOf(url, "POST", `${route.path}?testId=t1`, route.body);
      expect(byQuery).toBe(byHeader);
      expect(byHeader).toBe(
        chaosKeyFor({ method: "POST", path: route.path, body: JSON.parse(route.body) }),
      );
    });

    it(`${route.name}: same verdict sequence`, async () => {
      const byHeader = await verdicts(route.path, route.body, { "x-test-id": "t1" });
      const byQuery = await verdicts(`${route.path}?testId=t1`, route.body, {});
      expect(byQuery).toEqual(byHeader);
    });
  }

  it("other query params stay in the key", async () => {
    const { url } = await start({ chaos: { dropRate: 1, seed: SEED } });
    const path = "/v1/messages?beta=true";
    const byHeader = await keyOf(url, "POST", path, MESSAGES_BODY, { "x-test-id": "t1" });
    const byQuery = await keyOf(url, "POST", `${path}&testId=t1`, MESSAGES_BODY);
    const leading = await keyOf(url, "POST", "/v1/messages?testId=t1&beta=true", MESSAGES_BODY);
    expect(byQuery).toBe(byHeader);
    expect(leading).toBe(byHeader);
    expect(byHeader).toBe(chaosKeyFor({ method: "POST", path, body: JSON.parse(MESSAGES_BODY) }));
  });
});

describe("JSON null is not the same as no body", () => {
  it("applyChaosAsync route (/v1/batches): different keys", async () => {
    const { url } = await start({ chaos: { dropRate: 1, seed: SEED } });
    const path = "/v1/batches";
    const nullKey = await keyOf(url, "POST", path, "null");
    const noBody = await keyOf(url, "POST", path, null);
    expect(nullKey).not.toBe(noBody);
    expect(nullKey).toBe(chaosKeyFor({ method: "POST", path, body: null }));
    expect(noBody).toBe(chaosKeyFor({ method: "POST", path, body: undefined }));
  });

  it("split gate (fal queue requests): the same two keys as applyChaosAsync", async () => {
    const { url } = await start({ chaos: { dropRate: 1, seed: SEED } });
    const path = "/fal/queue/requests/missing-id/cancel";
    const nullKey = await keyOf(url, "PUT", path, "null");
    const noBody = await keyOf(url, "PUT", path, null);
    expect(nullKey).not.toBe(noBody);
    expect(nullKey).toBe(chaosKeyFor({ method: "PUT", path, body: null }));
    expect(noBody).toBe(chaosKeyFor({ method: "PUT", path, body: undefined }));
  });
});

describe("raw text is not the same as a JSON string", () => {
  it('split gate (fal queue requests): `hello` and `"hello"` get different keys', async () => {
    const { url } = await start({ chaos: { dropRate: 1, seed: SEED } });
    const path = "/fal/queue/requests/missing-id/cancel";
    const text = await keyOf(url, "PUT", path, "hello");
    const json = await keyOf(url, "PUT", path, '"hello"');
    expect(text).not.toBe(json);
    expect(json).toBe(chaosKeyFor({ method: "PUT", path, body: "hello" }));
  });

  it('applyChaosAsync route (/v1/batches): `hello` and `"hello"` get different keys', async () => {
    const { url } = await start({ chaos: { dropRate: 1, seed: SEED } });
    const path = "/v1/batches";
    const text = await keyOf(url, "POST", path, "hello");
    const json = await keyOf(url, "POST", path, '"hello"');
    expect(text).not.toBe(json);
  });

  it("chaosKeyFor tags raw text apart from the JSON string", () => {
    const path = "/x";
    expect(chaosKeyFor({ method: "POST", path, body: "hello", rawText: true })).not.toBe(
      chaosKeyFor({ method: "POST", path, body: "hello" }),
    );
  });
});
