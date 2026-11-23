import { appendFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI, type Model } from "@google/genai";
import OpenAI from "openai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Fixture } from "../types.js";
import { normalizePathLabel } from "../metrics.js";
import { matchRouteDefinition } from "../route-registry.js";
import {
  captureHttp,
  expectGolden,
  startGoldenServer,
  startStubUpstream,
  type CapturedExchange,
  type GoldenServer,
} from "./golden/harness.js";

const claudeIds = Array.from({ length: 25 }, (_, i) => `claude-test-${i}`);
const anthropicIds = [
  ...claudeIds,
  "anthropic.claude-test",
  "us.anthropic.claude-test",
  "anthropic/custom",
  "test-model",
  "custom/slash",
];
const googleIds = ["test-model", "custom/slash", "gemini-test", "google/custom"];
const ids = [...anthropicIds, "gpt-test", "openai/custom", "gemini-test", "google/custom"];
const fixtures: Fixture[] = ids.map((model) => ({ match: { model }, response: { content: "ok" } }));
const nativeHeaders = { "anthropic-version": "2023-06-01" };
// The shared /v1/models catalog is OpenAI-format unless the server opts in.
const nativeCatalog = { policy: { modelCatalog: "native" } } as const;

function expectValidGeminiCapacities(model: Pick<Model, "inputTokenLimit" | "outputTokenLimit">) {
  for (const capacity of [model.inputTokenLimit, model.outputTokenLimit]) {
    expect(Number.isFinite(capacity)).toBe(true);
    expect(Number.isInteger(capacity)).toBe(true);
    expect(capacity).toBeGreaterThan(0);
  }
}

function evidence(cell: string, value: unknown): void {
  const file = process.env.F2_EVIDENCE_FILE;
  if (file) appendFileSync(file, JSON.stringify({ cell, value }) + "\n");
}

function modelInfo(id: string) {
  return {
    type: "model",
    id,
    display_name: id,
    created_at: "1970-01-01T00:00:00Z",
    capabilities: null,
    lifecycle: "active",
    line: null,
    max_input_tokens: null,
    max_tokens: null,
    deprecated_at: null,
    retires_at: null,
  };
}

describe("native model catalogs on the source server", () => {
  let server: GoldenServer;
  beforeAll(async () => {
    server = await startGoldenServer(fixtures, nativeCatalog);
  });
  afterAll(async () => {
    await server.close();
  });

  async function get(cell: string, path: string, headers: Record<string, string> = nativeHeaders) {
    const exchange = await captureHttp(server.url + path, { headers });
    evidence(cell, exchange);
    // Golden captures normalize all ISO dates; metadata assertions use raw bytes.
    const raw = await fetch(server.url + path, { headers, signal: AbortSignal.timeout(2000) });
    const body = await raw.text();
    evidence(cell + ":raw", { status: raw.status, body });
    return { status: raw.status, body: JSON.parse(body) };
  }

  it("retains mixed-list bytes for Bearer, no hint, and x-api-key plus Bearer", async () => {
    const captures: CapturedExchange[] = [];
    const headerCases: Record<string, string>[] = [
      {},
      { Authorization: "Bearer local" },
      { "x-api-key": "local", Authorization: "Bearer local" },
    ];
    for (const headers of headerCases) {
      const capture = await captureHttp(server.url + "/v1/models?limit=1&lifecycle=retired", {
        headers,
      });
      captures.push(capture);
      expect(capture.body).toBe(
        JSON.stringify({
          object: "list",
          data: ids.map((id) => ({ id, object: "model", created: 1686935002, owned_by: "aimock" })),
        }),
      );
    }
    expectGolden("response-f2", "catalog", captures);
  });

  it.each([
    ["version-only", nativeHeaders],
    ["key-only", { "x-api-key": "local" }],
    ["version-bearer", { ...nativeHeaders, Authorization: "Bearer local" }],
  ] as const)("%s selects native Anthropic limit=1", async (cell, headers) => {
    const result = await get(String(cell), "/v1/models?limit=1", headers);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      data: [modelInfo(claudeIds[0])],
      has_more: true,
      first_id: claudeIds[0],
      last_id: claudeIds[0],
    });
  });

  it("defaults to twenty native items and retains first-seen provider visibility", async () => {
    const { body } = await get("anthropic-default", "/v1/models");
    expect(body.data).toEqual(claudeIds.slice(0, 20).map(modelInfo));
    expect(body.has_more).toBe(true);
    const all = await get("anthropic-all", "/v1/models?limit=1000");
    expect(all.body.data).toEqual(anthropicIds.map(modelInfo));
  });

  it.each([
    ["after", "limit=2&after_id=claude-test-1", ["claude-test-2", "claude-test-3"], true],
    ["before", "limit=2&before_id=claude-test-3", ["claude-test-1", "claude-test-2"], true],
    [
      "both",
      "limit=10&after_id=claude-test-0&before_id=claude-test-3",
      ["claude-test-1", "claude-test-2"],
      false,
    ],
    [
      "both-limited",
      "limit=1&after_id=claude-test-0&before_id=claude-test-3",
      ["claude-test-2"],
      true,
    ],
    ["retired", "lifecycle=retired", [], false],
    ["deprecated", "lifecycle[]=deprecated", [], false],
    ["retired-known-after", "lifecycle=retired&after_id=claude-test-0", [], false],
    ["deprecated-known-before", "lifecycle[]=deprecated&before_id=claude-test-3", [], false],
    [
      "union",
      "limit=1&lifecycle=retired&lifecycle[]=active&lifecycle=deprecated&lifecycle[]=active",
      [claudeIds[0]],
      true,
    ],
  ] as const)("Anthropic %s", async (cell, query, expectedIds, hasMore) => {
    const { status, body } = await get(cell, "/v1/models?" + query);
    expect(status).toBe(200);
    expect(body).toEqual({
      data: expectedIds.map(modelInfo),
      has_more: hasMore,
      first_id: expectedIds[0] ?? null,
      last_id: expectedIds.at(-1) ?? null,
    });
  });

  it.each([
    "after_id=missing",
    "before_id=missing",
    "after_id=missing&before_id=claude-test-3",
    "after_id=claude-test-0&before_id=missing",
    "lifecycle=retired&after_id=missing",
    "lifecycle[]=deprecated&before_id=missing",
  ])("Anthropic rejects unknown cursor in %s", async (query) => {
    const { status, body } = await get("anthropic-unknown-cursor:" + query, "/v1/models?" + query);
    expect(status).toBe(400);
    expect(body).toEqual({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "Model with id missing not found",
      },
    });
  });

  it.each(["limit=0", "limit=1001", "limit=-1", "limit=1.5", "limit=bad", "lifecycle=bad"])(
    "Anthropic rejects %s natively",
    async (query) => {
      const { status, body } = await get("anthropic-invalid:" + query, "/v1/models?" + query);
      expect(status).toBe(400);
      expect(body).toMatchObject({
        type: "error",
        error: { type: "invalid_request_error", message: expect.any(String) },
      });
    },
  );

  it("Gemini pages its provider plus unknown models with offset tokens", async () => {
    const first = await get("gemini-list", "/v1beta/models?pageSize=2", {});
    expect(first.status).toBe(200);
    expect(first.body.models.map((m: { name: string }) => m.name)).toEqual(
      googleIds.slice(0, 2).map((id) => "models/" + id),
    );
    for (const model of first.body.models) expectValidGeminiCapacities(model);
    expect(first.body.nextPageToken).toBe(Buffer.from("2").toString("base64"));
    const last = await get(
      "gemini-page-two",
      "/v1beta/models?pageSize=2&pageToken=" + encodeURIComponent(first.body.nextPageToken),
      {},
    );
    expect(last.body.models.map((m: { name: string }) => m.name)).toEqual(
      googleIds.slice(2).map((id) => "models/" + id),
    );
    for (const model of last.body.models) expectValidGeminiCapacities(model);
    expect(last.body).not.toHaveProperty("nextPageToken");
  });

  it.each(["", "?pageSize=0", "?pageSize=1001"])("Gemini default/zero/clamp %s", async (query) => {
    const { status, body } = await get("gemini-default:" + query, "/v1beta/models" + query, {});
    expect(status).toBe(200);
    expect(body.models).toHaveLength(googleIds.length);
  });

  it.each([
    "pageSize=-1",
    "pageSize=1.5",
    "pageSize=bad",
    "pageToken=***",
    "pageToken=LTE=",
    "pageToken=MS41",
    "pageToken=Mg",
    "pageToken=OTAwNzE5OTI1NDc0MDk5Mg==",
  ])("Gemini rejects %s natively", async (query) => {
    const { status, body } = await get("gemini-invalid:" + query, "/v1beta/models?" + query, {});
    expect(status).toBe(400);
    expect(body).toMatchObject({
      error: { code: 400, status: "INVALID_ARGUMENT", message: expect.any(String) },
    });
  });

  it.each(["custom/slash", "custom%2Fslash", "anthropic%2Fcustom", "anthropic/custom"])(
    "Anthropic retrieves full remainder %s",
    async (path) => {
      const { status, body } = await get("anthropic-detail:" + path, "/v1/models/" + path);
      expect(status).toBe(200);
      expect(body).toEqual(modelInfo(decodeURIComponent(path)));
    },
  );

  it.each(["custom/slash", "custom%2Fslash", "google%2Fcustom", "google/custom"])(
    "Gemini retrieves full remainder %s",
    async (path) => {
      const { status, body } = await get("gemini-detail:" + path, "/v1beta/models/" + path, {});
      expect(status).toBe(200);
      expect(body).toMatchObject({
        name: "models/" + decodeURIComponent(path),
        baseModelId: decodeURIComponent(path),
        version: expect.any(String),
        displayName: decodeURIComponent(path),
        inputTokenLimit: expect.any(Number),
        outputTokenLimit: expect.any(Number),
        supportedGenerationMethods: ["generateContent", "countTokens"],
      });
      for (const capacity of [body.inputTokenLimit, body.outputTokenLimit]) {
        expect(Number.isFinite(capacity)).toBe(true);
        expect(Number.isInteger(capacity)).toBe(true);
        expect(capacity).toBeGreaterThan(0);
      }
    },
  );

  it.each(["openai/custom", "openai%2Fcustom", "gpt-test"])(
    "OpenAI retrieves %s with native metadata",
    async (path) => {
      const { status, body } = await get("openai-detail:" + path, "/v1/models/" + path, {});
      expect(status).toBe(200);
      expect(body).toEqual({
        id: decodeURIComponent(path),
        object: "model",
        created: 1686935002,
        owned_by: "aimock",
      });
    },
  );

  it.each(["missing", "gpt-test", "gemini-test", "%ZZ", "%E0%A4%A"])(
    "Anthropic invisible/malformed %s is native404",
    async (path) => {
      const { status, body } = await get("anthropic-404:" + path, "/v1/models/" + path);
      expect(status).toBe(404);
      expect(body).toMatchObject({ type: "error", error: { type: "not_found_error" } });
    },
  );

  it.each(["missing", "gpt-test", "claude-test-0", "%ZZ", "%E0%A4%A"])(
    "Gemini invisible/malformed %s is native404",
    async (path) => {
      const { status, body } = await get("gemini-404:" + path, "/v1beta/models/" + path, {});
      expect(status).toBe(404);
      expect(body).toMatchObject({ error: { code: 404, status: "NOT_FOUND" } });
    },
  );

  it.each([":", "%3A", "%3a"])(
    "GET action suffixes retain the shared404 route (%s)",
    async (colon) => {
      const { status, body } = await get(
        "gemini-action-get",
        `/v1beta/models/gemini-test${colon}generateContent`,
        {},
      );
      expect(status).toBe(404);
      expect(body).toHaveProperty("error.type", "not_found");
    },
  );

  it("SDK Anthropic autopager consumes every visible model and retrieves slash IDs", async () => {
    const sdk = new Anthropic({ apiKey: "local", baseURL: server.url, maxRetries: 0 });
    const observed: string[] = [];
    for await (const model of sdk.models.list()) observed.push(model.id);
    evidence("sdk-anthropic-list", observed);
    expect(observed).toEqual(anthropicIds);
  });

  it("SDK Anthropic retrieves encoded slash IDs", async () => {
    const sdk = new Anthropic({ apiKey: "local", baseURL: server.url, maxRetries: 0 });
    const detail = await sdk.models.retrieve("custom/slash");
    evidence("sdk-anthropic-detail", detail);
    expect(detail.id).toBe("custom/slash");
  });

  it("SDK Gemini autopager and detail consume native responses", async () => {
    const sdk = new GoogleGenAI({
      apiKey: "local",
      httpOptions: { baseUrl: server.url, apiVersion: "v1beta" },
    });
    const pager = await sdk.models.list({ config: { pageSize: 1 } });
    for (const model of pager.page) expectValidGeminiCapacities(model);
    const observed: Array<string | undefined> = [];
    for await (const model of pager) {
      expectValidGeminiCapacities(model);
      observed.push(model.name);
    }
    evidence("sdk-gemini-list", observed);
    expect(observed).toEqual(googleIds.map((id) => "models/" + id));
  });

  it("SDK Gemini retrieves raw slash IDs", async () => {
    const sdk = new GoogleGenAI({
      apiKey: "local",
      httpOptions: { baseUrl: server.url, apiVersion: "v1beta" },
    });
    const detail = await sdk.models.get({ model: "custom/slash" });
    evidence("sdk-gemini-detail", detail);
    expect(detail.name).toBe("models/custom/slash");
  });

  it("SDK OpenAI detail resolves raw slash IDs", async () => {
    const sdk = new OpenAI({ apiKey: "local", baseURL: server.url + "/v1", maxRetries: 0 });
    const detail = await sdk.models.retrieve("openai/custom");
    evidence("sdk-openai-detail", detail);
    expect(detail.id).toBe("openai/custom");
  });

  it("GET catalogs/detail do not journal", () => {
    expect(server.instance.journal.getAll()).toEqual([]);
  });

  it("new routes have registry, OpenAPI and metrics attribution", async () => {
    const { body } = await get("openapi", "/__aimock/openapi.json", {});
    for (const [path, template] of [
      ["/v1/models/custom/slash", "/v1/models/{id}"],
      ["/v1beta/models", "/v1beta/models"],
      ["/v1beta/models/custom/slash", "/v1beta/models/{model}"],
    ]) {
      expect(matchRouteDefinition("GET", path)?.path).toBe(template);
      expect(normalizePathLabel(path)).toBe(template);
      expect(
        body.paths[template].get.responses["200"].content["application/json"].schema,
      ).toBeDefined();
    }
  });
});

it("empty provider lists have native envelopes and no fabricated fallback", async () => {
  const server = await startGoldenServer(
    [{ match: { model: "gpt-only" }, response: { content: "ok" } }],
    nativeCatalog,
  );
  try {
    const anthropic = await captureHttp(server.url + "/v1/models", { headers: nativeHeaders });
    const gemini = await captureHttp(server.url + "/v1beta/models");
    evidence("empty-anthropic", anthropic);
    evidence("empty-gemini", gemini);
    expect(JSON.parse(anthropic.body ?? "null")).toEqual({
      data: [],
      has_more: false,
      first_id: null,
      last_id: null,
    });
    expect(JSON.parse(gemini.body ?? "null")).toEqual({ models: [] });
  } finally {
    await server.close();
  }
});

it("empty fixtures use the established core defaults for native list/detail visibility", async () => {
  const server = await startGoldenServer([], nativeCatalog);
  try {
    for (const [path, headers, name] of [
      ["/v1/models?limit=1000", nativeHeaders, "claude-3-5-sonnet-20241022"],
      ["/v1beta/models", {}, "gemini-2.0-flash"],
    ] as const) {
      const response = await fetch(server.url + path, { headers });
      const body = await response.json();
      evidence("default-fallback:" + path, body);
      expect(
        path.startsWith("/v1/")
          ? body.data.map((item: { id: string }) => item.id)
          : body.models.map((item: { baseModelId: string }) => item.baseModelId),
      ).toEqual([name]);
      const detailPath = path.startsWith("/v1/") ? "/v1/models/" : "/v1beta/models/";
      const detail = await captureHttp(server.url + detailPath + name, { headers });
      evidence("default-detail:" + name, detail);
      expect(detail.status).toBe(200);
    }
  } finally {
    await server.close();
  }
});

describe("SDK Anthropic cursor direction on the source server", () => {
  const modelIds = ["custom/a", "custom/b", "custom/c", "custom/d", "custom/e"];
  let server: GoldenServer;
  beforeAll(async () => {
    server = await startGoldenServer(
      modelIds.map((model) => ({ match: { model }, response: { content: "ok" } })),
      nativeCatalog,
    );
  });
  afterAll(async () => {
    await server.close();
  });

  it.each([
    [false, 1, ["custom/d", "custom/c", "custom/b"]],
    [true, 1, ["custom/d", "custom/c", "custom/b"]],
    [false, 2, ["custom/c", "custom/d", "custom/b"]],
    [true, 2, ["custom/c", "custom/d", "custom/b"]],
  ] as const)(
    "bounded autopager beta=%s limit=%s retains every model",
    async (beta, limit, expected) => {
      const sdk = new Anthropic({ apiKey: "local", baseURL: server.url, maxRetries: 0 });
      const models = beta ? sdk.beta.models : sdk.models;
      const observed: string[] = [];
      for await (const model of models.list({ limit, after_id: "custom/a", before_id: "custom/e" }))
        observed.push(model.id);
      evidence(`sdk-anthropic-bounded:${beta}:${limit}`, observed);
      expect(observed).toEqual(expected);
    },
  );

  it.each([false, true])("reverse autopager beta=%s retains page order", async (beta) => {
    const sdk = new Anthropic({ apiKey: "local", baseURL: server.url, maxRetries: 0 });
    const models = beta ? sdk.beta.models : sdk.models;
    const observed: string[] = [];
    for await (const model of models.list({ limit: 2, before_id: "custom/e" }))
      observed.push(model.id);
    evidence(`sdk-anthropic-reverse:${beta}`, observed);
    expect(observed).toEqual(["custom/c", "custom/d", "custom/a", "custom/b"]);
  });
});

it("Gemini default50, zero50 and clamp1000 exercise the actual page boundaries", async () => {
  const models = Array.from({ length: 1002 }, (_, i) => `gemini-boundary-${i}`);
  const server = await startGoldenServer(
    models.map((model) => ({ match: { model }, response: { content: "ok" } })),
  );
  try {
    for (const [query, count] of [
      ["", 50],
      ["?pageSize=0", 50],
      ["?pageSize=1001", 1000],
    ] as const) {
      const exchange = await captureHttp(server.url + "/v1beta/models" + query);
      evidence("gemini-boundary:" + query, exchange);
      const body = JSON.parse(exchange.body ?? "null");
      expect(body.models).toHaveLength(count);
      expect(body.nextPageToken).toBe(Buffer.from(String(count)).toString("base64"));
    }
  } finally {
    await server.close();
  }
});

it.each([false, true])(
  "catalog GETs never proxy or save recordings (proxyOnly=%s)",
  async (proxyOnly) => {
    const upstream = await startStubUpstream((_req, res) => {
      res.writeHead(500);
      res.end("unexpected egress");
    });
    const directory = mkdtempSync(join(tmpdir(), "aimock-f2-record-"));
    const server = await startGoldenServer(fixtures, {
      ...nativeCatalog,
      record: {
        providers: { openai: upstream.url, anthropic: upstream.url, gemini: upstream.url },
        fixturePath: directory,
        proxyOnly,
      },
    });
    try {
      for (const [path, headers] of [
        ["/v1/models", nativeHeaders],
        ["/v1/models/custom%2Fslash", nativeHeaders],
        ["/v1beta/models", {}],
        ["/v1beta/models/custom/slash", {}],
      ] as const) {
        const exchange = await captureHttp(server.url + path, { headers });
        evidence(`no-egress:${proxyOnly}:${path}`, exchange);
        expect(exchange.status).toBe(200);
      }
      expect(upstream.requests).toEqual([]);
      expect(readdirSync(directory)).toEqual([]);
      expect(server.instance.journal.getAll()).toEqual([]);
    } finally {
      await server.close();
      await upstream.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

it("provider prefix table drives list visibility without capability inference", async () => {
  const prefixes = [
    ["CLAUDE-test", "anthropic"],
    ["us.anthropic.claude-test", "anthropic"],
    ["eu.claude-test", "anthropic"],
    ["anthropic/anything", "anthropic"],
    ["google/anything", "google"],
    ["openai/anything", "openai"],
    ["GEMINI-test", "google"],
    ["gpt-test", "openai"],
    ["chatgpt-test", "openai"],
    ["o1", "openai"],
    ["o3-test", "openai"],
    ["o4-test", "openai"],
    ["text-embedding-test", "openai"],
    ["dall-e-test", "openai"],
    ["whisper-test", "openai"],
    ["tts-test", "openai"],
    ["o10", undefined],
    ["o3custom", undefined],
    ["veo-test", undefined],
    ["imagen-test", undefined],
    ["llama-test", undefined],
    ["mistral-test", undefined],
    ["qwen-test", undefined],
    ["custom/slash", undefined],
  ] as const;
  const server = await startGoldenServer(
    prefixes.map(([model]) => ({ match: { model }, response: { content: "ok" } })),
    nativeCatalog,
  );
  try {
    for (const provider of ["anthropic", "google"] as const) {
      const exchange = await captureHttp(
        server.url + (provider === "anthropic" ? "/v1/models?limit=1000" : "/v1beta/models"),
        { headers: provider === "anthropic" ? nativeHeaders : {} },
      );
      evidence("prefix-table:" + provider, exchange);
      const body = JSON.parse(exchange.body ?? "null");
      const actual =
        provider === "anthropic"
          ? body.data?.map((item: { id: string }) => item.id)
          : body.models?.map((item: { baseModelId: string }) => item.baseModelId);
      expect(actual).toEqual(
        prefixes.filter(([, value]) => value === undefined || value === provider).map(([id]) => id),
      );
    }
  } finally {
    await server.close();
  }
});

it("shared-path auth rejections keep the legacy dialect", async () => {
  const server = await startGoldenServer(fixtures, { auth: { apiKeys: ["accepted"] } });
  try {
    for (const path of ["/v1/models", "/v1/models/claude-test-0"]) {
      const exchange = await captureHttp(server.url + path, {
        headers: { ...nativeHeaders, "x-api-key": "rejected" },
      });
      evidence("legacy-auth:" + path, exchange);
      expect(exchange.status).toBe(401);
      expect(JSON.parse(exchange.body ?? "null")).toMatchObject({
        error: { type: "authentication_error", code: "invalid_api_key" },
      });
      expect(JSON.parse(exchange.body ?? "null")).not.toHaveProperty("type");
    }
  } finally {
    await server.close();
  }
});
