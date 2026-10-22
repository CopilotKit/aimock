import * as http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleMessages } from "../index.js";
import { handleCountTokens } from "../count-tokens.js";
import { renderError } from "../response/errors.js";
import { Journal } from "../journal.js";
import { Logger } from "../logger.js";
import type { Fixture, HandlerDefaults, MockServerOptions } from "../types.js";
import { captureHttp, startGoldenServer, startStubUpstream } from "./golden/harness.js";

const requiredBody =
  '{"type":"error","error":{"type":"invalid_request_error","message":"anthropic-version: header is required"},"request_id":"req_policy_test"}';
const legacyRequiredBody =
  '{"type":"error","error":{"type":"invalid_request_error","message":"anthropic-version: header is required"}}';
const fixtures: Fixture[] = [
  { match: { userMessage: "hello", model: "claude-test" }, response: { content: "ok" } },
];
const requestBody = {
  model: "claude-test",
  max_tokens: 30,
  messages: [{ role: "user", content: "hello" }],
};
const close: Array<() => Promise<void>> = [];

afterEach(async () => {
  const errors: unknown[] = [];
  for (const stop of close.splice(0).reverse()) {
    try {
      await stop();
    } catch (error) {
      errors.push(error);
    }
  }
  vi.restoreAllMocks();
  if (errors.length) throw errors[0];
});

async function source(options: Partial<MockServerOptions> = {}, serving = fixtures) {
  const server = await startGoldenServer(serving, options);
  close.push(server.close);
  return { url: server.url, journal: server.instance.journal };
}

async function direct(overrides: Partial<HandlerDefaults> = {}) {
  const journal = new Journal();
  const defaults: HandlerDefaults = {
    latency: 0,
    chunkSize: 20,
    replaySpeed: 1,
    logger: new Logger("warn"),
    ...overrides,
  };
  const errors: unknown[] = [];
  const pending: Promise<void>[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("error", (error) => {
      errors.push(error);
      res.destroy();
    });
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      pending.push(
        Promise.resolve()
          .then(() => {
            const raw = Buffer.concat(chunks).toString();
            if (req.url === "/v1/messages/count_tokens")
              return handleCountTokens(
                req,
                res,
                raw,
                false,
                "claude-test",
                journal,
                defaults,
                () => {},
              );
            return handleMessages(req, res, raw, fixtures, journal, defaults, () => {});
          })
          .catch((error: unknown) => {
            errors.push(error);
            res.destroy();
          }),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  close.push(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
    await Promise.all(pending);
    if (errors.length) throw errors[0];
  });
  return { url: `http://127.0.0.1:${address.port}`, journal };
}

async function send(
  url: string,
  path: string,
  headers: Record<string, string> = {},
  body: unknown = requestBody,
) {
  const method = path.startsWith("/v1/models") ? "GET" : "POST";
  const result = await captureHttp(`${url}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-request-id": "req_policy_test",
      ...headers,
    },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
  if (result.body === undefined) throw new Error("Expected an unframed HTTP body");
  console.log(JSON.stringify({ path, headers, status: result.status, body: result.body }));
  return { ...result, body: result.body };
}

function expectRequired(result: Awaited<ReturnType<typeof send>>) {
  expect(result.status).toBe(400);
  expect(result.body).toBe(requiredBody);
}

describe("required-version policy on real entry points", () => {
  it.each(["/v1/messages", "/v1/messages/count_tokens", "/v1/models", "/v1/models/claude-test"])(
    "enforces missing version on %s",
    async (path) => {
      const server = await source({
        policy: { requiredHeaders: "enforce", modelCatalog: "native" },
      });
      expectRequired(await send(server.url, path, { "x-api-key": "test" }));
      const entries = server.journal.getAll();
      if (path.startsWith("/v1/models")) expect(entries).toEqual([]);
      else
        expect(entries).toMatchObject([
          { response: { status: 400, fixture: null, source: "internal" } },
        ]);
    },
  );

  it("enforces direct exported handleMessages", async () => {
    const server = await direct({ policy: { requiredHeaders: "enforce" } });
    expectRequired(await send(server.url, "/v1/messages"));
    expect(server.journal.getAll()).toMatchObject([
      { response: { status: 400, source: "internal" } },
    ]);
  });

  it.each(["/v1/messages/count_tokens", "/v1/models", "/v1/models/claude-test"])(
    "request policy overrides server defaults on %s",
    async (path) => {
      const disabled = await source({
        strict: true,
        policy: { requiredHeaders: "off", modelCatalog: "native" },
      });
      const enabled = await source({
        strict: true,
        policy: { requiredHeaders: "enforce", modelCatalog: "native" },
      });
      const headers = { "x-api-key": "test", "x-aimock-strict": "false" };
      const enforced = await send(disabled.url, path, {
        ...headers,
        "x-aimock-policy": "requiredHeaders=enforce",
      });
      const off = await send(enabled.url, path, {
        ...headers,
        "x-aimock-policy": "requiredHeaders=off",
      });
      expect([enforced.status, off.status]).toEqual([400, 200]);
      expectRequired(enforced);
      if (path.startsWith("/v1/models")) {
        expect(disabled.journal.getAll()).toEqual([]);
        expect(enabled.journal.getAll()).toEqual([]);
      } else {
        expect(disabled.journal.getAll()).toMatchObject([
          { body: null, response: { status: 400, fixture: null, source: "internal" } },
        ]);
        expect(enabled.journal.getAll()).toMatchObject([
          { response: { status: 200, fixture: null, source: "internal" } },
        ]);
      }
    },
  );

  it.each(["/v1/messages", "/v1/messages/count_tokens", "/v1/models", "/v1/models/claude-test"])(
    "auth still wins on %s",
    async (path) => {
      const server = await source({
        auth: { apiKeys: ["accepted"] },
        policy: { requiredHeaders: "enforce", authErrors: "native" },
      });
      const result = await send(server.url, path, { "x-api-key": "bad" });
      expect(result.status).toBe(401);
      const body = JSON.parse(result.body);
      expect(body.error.type).toBe("authentication_error");
      expect(body.type).toBe(path.startsWith("/v1/models") ? undefined : "error");
      expect(body).not.toHaveProperty("request_id");
      expect(server.journal.getAll()).toEqual([]);
    },
  );

  it.each(["source", "direct"] as const)(
    "strict independence and request precedence on %s",
    async (surface) => {
      const server =
        surface === "source"
          ? await source({ strict: true, policy: { requiredHeaders: "enforce" } })
          : await direct({ strict: true, policy: { requiredHeaders: "enforce" } });
      expectRequired(await send(server.url, "/v1/messages", { "x-aimock-strict": "false" }));
      expect(
        (await send(server.url, "/v1/messages", { "x-aimock-policy": "requiredHeaders=off" }))
          .status,
      ).toBe(200);
      expect(
        (await send(server.url, "/v1/messages", { "anthropic-version": "2023-06-01" })).status,
      ).toBe(200);
      expectRequired(
        await send(
          server.url,
          "/v1/messages",
          { "x-aimock-policy": "requiredHeaders=enforce", "x-aimock-strict": "false" },
          { ...requestBody, thinking: { type: "enabled", budget_tokens: 1 } },
        ),
      );
    },
  );

  it.each([false, true])("default policy retains matching success (strict=%s)", async (strict) => {
    const server = await source({ strict });
    expect((await send(server.url, "/v1/messages")).status).toBe(200);
    expect((await send(server.url, "/v1/messages/count_tokens")).status).toBe(200);
    expect((await send(server.url, "/v1/models", { "x-api-key": "test" })).status).toBe(200);
  });

  it("OpenAI and Gemini remain unaffected under enforce", async () => {
    const server = await source({ policy: { requiredHeaders: "enforce" } });
    expect(
      (await send(server.url, "/v1/models", { authorization: "Bearer test", "x-api-key": "test" }))
        .status,
    ).toBe(200);
    expect(
      (await send(server.url, "/v1/models/claude-test", { authorization: "Bearer test" })).status,
    ).toBe(200);
    expect(
      (
        await send(
          server.url,
          "/v1beta/models/gemini-test:countTokens",
          {},
          { contents: [{ role: "user", parts: [{ text: "hello" }] }] },
        )
      ).status,
    ).toBe(200);
  });

  it("valid auth gets required-version rejection on shared paths", async () => {
    const server = await source({
      auth: { apiKeys: ["accepted"] },
      policy: { requiredHeaders: "enforce", modelCatalog: "native" },
    });
    expectRequired(await send(server.url, "/v1/models", { "x-api-key": "accepted" }));
    expect(
      (
        await send(server.url, "/v1/models", {
          "x-api-key": "accepted",
          "anthropic-version": "2023-06-01",
        })
      ).status,
    ).toBe(200);
  });
});

const requestIdCases = [
  { name: "supplied", value: "req_supplied_id", expected: "req_supplied_id" },
  { name: "trimmed", value: "  req_trimmed_id  ", expected: "req_trimmed_id" },
  { name: "absent", value: undefined, expected: undefined },
  { name: "invalid", value: "unsafe id", expected: undefined },
];
const policyPaths = [
  "/v1/messages",
  "/v1/messages/count_tokens",
  "/v1/models",
  "/v1/models/claude-test",
];

async function policyResponse(url: string, path: string, requestId?: string) {
  const method = path.startsWith("/v1/models") ? "GET" : "POST";
  const response = await fetch(`${url}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-api-key": "test",
      ...(requestId === undefined ? {} : { "x-request-id": requestId }),
    },
    ...(method === "POST" ? { body: JSON.stringify(requestBody) } : {}),
  });
  const body: Record<string, unknown> = await response.json();
  expect(response.status).toBe(400);
  expect(body).toMatchObject({
    type: "error",
    error: { type: "invalid_request_error", message: "anthropic-version: header is required" },
  });
  return { body, responseId: response.headers.get("x-request-id") };
}

describe("policy request-ID metadata on real HTTP", () => {
  it.each(policyPaths.flatMap((path) => requestIdCases.map((control) => ({ path, ...control }))))(
    "correlates $name request ID on $path",
    async ({ path, value, expected }) => {
      const server = await source({
        policy: { requiredHeaders: "enforce", modelCatalog: "native" },
      });
      const { body, responseId } = await policyResponse(server.url, path, value);
      expect(body.request_id).toBe(responseId);
      if (expected) expect(body.request_id).toBe(expected);
      else expect(body.request_id).toMatch(/^req-[A-Za-z0-9_-]{16}$/);
    },
  );

  it.each(
    policyPaths
      .slice(0, 2)
      .flatMap((path) => requestIdCases.map((control) => ({ path, ...control }))),
  )("resolves $name ID in direct exported handler for $path", async ({ path, value, expected }) => {
    const server = await direct({ policy: { requiredHeaders: "enforce" } });
    const { body } = await policyResponse(server.url, path, value);
    if (expected) expect(body.request_id).toBe(expected);
    else expect(body.request_id).toMatch(/^req-[A-Za-z0-9_-]{16}$/);
    expect(server.journal.getAll()).toMatchObject([
      { body: null, response: { status: 400, fixture: null, source: "internal" } },
    ]);
  });

  it.each([...requestIdCases, { name: "empty", value: "", expected: undefined }])(
    "correlates $name ID in direct Messages policy rejection",
    async ({ value, expected }) => {
      const server = await direct({ policy: { requiredHeaders: "enforce" } });
      const { body, responseId } = await policyResponse(server.url, "/v1/messages", value);
      expect(body.request_id).toBe(responseId);
      if (expected) expect(body.request_id).toBe(expected);
      else expect(body.request_id).toMatch(/^req-[A-Za-z0-9_-]{16}$/);
      const entries = server.journal.getAll();
      expect(entries).toHaveLength(1);
      expect(entries[0].headers["x-request-id"]).toBe(body.request_id);
      expect(
        entries.filter((entry) => entry.headers["x-request-id"] === body.request_id),
      ).toHaveLength(1);
    },
  );

  it("omits optional owner metadata from existing native templates by default", () => {
    const message = "anthropic-version: header is required";
    expect(renderError("messages", "thinking", { message }).body).toBe(legacyRequiredBody);
    expect(renderError("openai", "thinking", { message, requestId: "req_other_wire" }).body).toBe(
      legacyRequiredBody,
    );
    expect(
      renderError("messages", "thinking", { message, requestId: "req_policy_test" }).body,
    ).toBe(requiredBody);
  });

  it("retains ordinary count validation and native catalog rejection bytes", async () => {
    const server = await source({ policy: { requiredHeaders: "enforce", modelCatalog: "native" } });
    const headers = { "anthropic-version": "2023-06-01", "x-api-key": "test" };
    const count = await send(server.url, "/v1/messages/count_tokens", headers, {
      model: "claude-test",
      messages: "invalid",
    });
    expect(count.status).toBe(400);
    expect(count.body).toBe(
      '{"type":"error","error":{"type":"invalid_request_error","message":"messages must be an array"}}',
    );
    const catalog = await send(server.url, "/v1/models?limit=0", headers);
    expect(catalog.status).toBe(400);
    expect(catalog.body).toBe(
      '{"type":"error","error":{"type":"invalid_request_error","message":"limit must be an integer between 1 and 1000"}}',
    );
  });
});

describe("real direct-consumer policy warning interpretation", () => {
  it("warns and ignores invalid defaults and header entries", async () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const defaults: Partial<HandlerDefaults> = {};
    Reflect.set(defaults, "policy", { requiredHeaders: true, unknown: "enforce" });
    const server = await direct(defaults);
    expect(
      (
        await send(server.url, "/v1/messages", {
          "x-aimock-policy": "unknown=enforce,requiredHeaders=bad,broken",
        })
      ).status,
    ).toBe(200);
    const logged = warnings.mock.calls.map((args) => args.join(" "));
    console.log(JSON.stringify({ case: "direct-invalid-default-and-header-warnings", logged }));
    expect(
      logged.filter((line) => line.includes("Ignoring policy.requiredHeaders")).length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      logged.filter((line) => line.includes("Ignoring policy.unknown")).length,
    ).toBeGreaterThanOrEqual(2);
    expect(logged.some((line) => line.includes('Ignoring policy entry "broken"'))).toBe(true);
  });

  it.each(["source", "direct"] as const)(
    "retains valid header entries after invalid duplicates on %s",
    async (surface) => {
      const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
      const server =
        surface === "source"
          ? await source({ logLevel: "warn", policy: { requiredHeaders: "off" } })
          : await direct({ policy: { requiredHeaders: "off" } });
      expectRequired(
        await send(server.url, "/v1/messages", {
          "x-aimock-policy": "requiredHeaders=ENFORCE,unknown=off,requiredHeaders=bad",
        }),
      );
      const logged = warnings.mock.calls.map((args) => args.join(" "));
      console.log(JSON.stringify({ case: `${surface}-valid-header-retained-warnings`, logged }));
      expect(logged.some((line) => line.includes("Ignoring policy.unknown"))).toBe(true);
      expect(logged.some((line) => line.includes("Ignoring policy.requiredHeaders"))).toBe(true);
    },
  );

  it("retains valid defaults despite unknown entries", async () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const defaults: Partial<HandlerDefaults> = {};
    Reflect.set(defaults, "policy", { requiredHeaders: "enforce", unknown: "off" });
    const server = await direct(defaults);
    expectRequired(await send(server.url, "/v1/messages"));
    expect(
      warnings.mock.calls.some((args) => args.join(" ").includes("Ignoring policy.unknown")),
    ).toBe(true);
  });
});

it("rejected record requests never reach upstream while valid control does", async () => {
  const upstream = await startStubUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "msg_upstream",
        type: "message",
        role: "assistant",
        model: "claude-test",
        content: [{ type: "text", text: "upstream" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
  });
  close.push(upstream.close);
  const directory = mkdtempSync(join(tmpdir(), "aimock-required-headers-"));
  close.push(async () => {
    rmSync(directory, { recursive: true, force: true });
  });
  const server = await source(
    {
      policy: { requiredHeaders: "enforce" },
      record: { providers: { anthropic: upstream.url }, fixturePath: directory },
    },
    [],
  );
  const rejected = await send(server.url, "/v1/messages");
  const hitsAfterRejected = upstream.requests.length;
  const count = await send(server.url, "/v1/messages/count_tokens");
  const hitsAfterCount = upstream.requests.length;
  const accepted = await send(
    server.url,
    "/v1/messages",
    { "anthropic-version": "2023-06-01" },
    { ...requestBody, messages: [{ role: "user", content: "accepted-control" }] },
  );
  console.log(
    JSON.stringify({
      case: "record-egress-counter",
      hitsAfterRejected,
      hitsAfterCount,
      hitsAfterAccepted: upstream.requests.length,
      journal: server.journal.getAll().map((entry) => entry.response),
    }),
  );
  expectRequired(rejected);
  expectRequired(count);
  expect(hitsAfterRejected).toBe(0);
  expect(hitsAfterCount).toBe(0);
  expect(accepted.status).toBe(200);
  expect(upstream.requests).toHaveLength(1);
  expect(server.journal.getAll().slice(0, 2)).toMatchObject([
    { response: { source: "internal", status: 400 } },
    { response: { source: "internal", status: 400 } },
  ]);
});
