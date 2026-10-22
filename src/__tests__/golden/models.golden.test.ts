/**
 * Golden corpus: model listings.
 *
 * Pins the normalized bytes of every model-listing route (`GET /v1/models`,
 * `GET /api/tags`, OpenRouter `GET /api/v1/models` and
 * `GET /api/v1/videos/models`) plus today's not-found response for a GET on a
 * Gemini `:verb` path.
 *
 * Case-name prefixes carry a contract:
 * - `openai-*`: OpenAI-dialect `/v1/models` callers. Must stay identical.
 * - `anthropic-signal-*`: requests that carry an Anthropic signal
 *   (`anthropic-version`, or `x-api-key` without `Authorization`) under the
 *   default policy. They get the 1.45 OpenAI list. Must stay identical.
 * - `anthropic-native-*`: the same requests with `policy.modelCatalog: "native"`.
 *   Anthropic-signal requests get the Anthropic-format catalog.
 * - `shared404-*`: GETs on Gemini `:verb` paths. Must stay identical, even
 *   after a `GET /v1beta/models/{model}` route exists.
 * - `ollama-*`, `openrouter-*`, `openrouter-video-*`: the other listings.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import type { Fixture } from "../../types.js";
import {
  captureHttp,
  expectGolden,
  startGoldenServer,
  startStubUpstream,
  type GoldenServer,
  type StubUpstream,
} from "./harness.js";

const SUITE = "models";

/** Multi-provider set, in this fixed order (order is part of the listing). */
const multiProvider: Fixture[] = [
  "gpt-4o",
  "claude-sonnet-4-5",
  "gemini-2.5-flash",
  "test-model",
  "anthropic.claude-3-haiku",
  "openai/gpt-4o-mini",
].map((model) => ({ match: { model }, response: { content: `hello from ${model}` } }));

/**
 * Fixtures that exercise each listing's id filter: endpoint-less, chat,
 * embedding and video fixtures, a duplicate, a RegExp video model and an
 * endpoint-less RegExp model, an empty-string model and the sunset video
 * model `openai/sora-2`.
 */
const mixedEndpoints: Fixture[] = [
  { match: { model: "gpt-4o" }, response: { content: "chat a" } },
  { match: { model: "chat-explicit", endpoint: "chat" }, response: { content: "chat b" } },
  {
    match: { model: "text-embedding-3-small", endpoint: "embedding" },
    response: { embedding: [0.1, 0.2] },
  },
  {
    match: { model: "acme/video-a", endpoint: "video" },
    response: { video: { id: "v1", status: "completed" } },
  },
  {
    match: { model: "openai/sora-2", endpoint: "video" },
    response: { video: { id: "v2", status: "completed" } },
  },
  {
    match: { model: /^regex-video/, endpoint: "video" },
    response: { video: { id: "v3", status: "completed" } },
  },
  { match: { model: "gpt-4o" }, response: { content: "duplicate" } },
  { match: { model: /^regex-chat/ }, response: { content: "regex" } },
  { match: { model: "" }, response: { content: "empty model" } },
];

/** Video fixtures whose models are all non-string: listing falls back to defaults. */
const videoNoStringModel: Fixture[] = [
  {
    match: { model: /^any-video/, endpoint: "video" },
    response: { video: { id: "v4", status: "completed" } },
  },
];

function get(server: GoldenServer, path: string, headers: Record<string, string> = {}) {
  return captureHttp(`${server.url}${path}`, { method: "GET", headers });
}

/** The journal entries a request added: method, path, response (no host/port headers). */
function journalSince(server: GoldenServer, before: number) {
  return server.instance.journal
    .getAll()
    .slice(before)
    .map((e) => ({ method: e.method, path: e.path, response: e.response }));
}

async function captureWithJournal(
  server: GoldenServer,
  path: string,
  headers: Record<string, string> = {},
) {
  const before = server.instance.journal.getAll().length;
  const exchange = await get(server, path, headers);
  return { exchange, journal: journalSince(server, before) };
}

let multi: GoldenServer;
let empty: GoldenServer;
let multiNative: GoldenServer;
let emptyNative: GoldenServer;
let mixed: GoldenServer;
let videoNoString: GoldenServer;

beforeAll(async () => {
  multi = await startGoldenServer(multiProvider);
  empty = await startGoldenServer([]);
  multiNative = await startGoldenServer(multiProvider, { policy: { modelCatalog: "native" } });
  emptyNative = await startGoldenServer([], { policy: { modelCatalog: "native" } });
  mixed = await startGoldenServer(mixedEndpoints);
  videoNoString = await startGoldenServer(videoNoStringModel);
});

afterAll(async () => {
  await Promise.all(
    [multi, empty, multiNative, emptyNative, mixed, videoNoString].map((s) => s?.close()),
  );
});

// ─── GET /v1/models ─────────────────────────────────────────────────────────

describe("GET /v1/models", () => {
  it("openai-sdk-headers", async () => {
    const got = await get(multi, "/v1/models?limit=2&after_id=gpt-4o", {
      authorization: "Bearer k",
      "user-agent": "OpenAI/JS 4.104.0",
    });
    expectGolden(SUITE, "openai-sdk-headers", got);
  });

  it("openai-aggregator-bearer", async () => {
    const got = await get(multi, "/v1/models?limit=2", {
      authorization: "Bearer k",
      "http-referer": "https://example.test",
      "x-title": "Golden Corpus",
    });
    expectGolden(SUITE, "openai-aggregator-bearer", got);
  });

  it("openai-no-hints", async () => {
    const got = await get(multi, "/v1/models?limit=2");
    expectGolden(SUITE, "openai-no-hints", got);
  });

  it("openai-defaults-empty-fixtures", async () => {
    const got = await get(empty, "/v1/models", { authorization: "Bearer k" });
    expectGolden(SUITE, "openai-defaults-empty-fixtures", got);
  });

  it("openai-mixed-endpoints", async () => {
    const got = await get(mixed, "/v1/models", { authorization: "Bearer k" });
    expectGolden(SUITE, "openai-mixed-endpoints", got);
  });

  it("anthropic-signal-version", async () => {
    const got = await get(multi, "/v1/models", {
      "anthropic-version": "2023-06-01",
      "x-api-key": "k",
    });
    expectGolden(SUITE, "anthropic-signal-version", got);
  });

  it("anthropic-signal-xapikey-only", async () => {
    const got = await get(multi, "/v1/models", { "x-api-key": "k" });
    expectGolden(SUITE, "anthropic-signal-xapikey-only", got);
  });

  it("anthropic-signal-version-with-bearer", async () => {
    const got = await get(multi, "/v1/models", {
      "anthropic-version": "2023-06-01",
      authorization: "Bearer k",
    });
    expectGolden(SUITE, "anthropic-signal-version-with-bearer", got);
  });

  it("anthropic-signal-version-empty-fixtures", async () => {
    const got = await get(empty, "/v1/models", {
      "anthropic-version": "2023-06-01",
      "x-api-key": "k",
    });
    expectGolden(SUITE, "anthropic-signal-version-empty-fixtures", got);
  });

  it("anthropic-native-version", async () => {
    const got = await get(multiNative, "/v1/models", {
      "anthropic-version": "2023-06-01",
      "x-api-key": "k",
    });
    expectGolden(SUITE, "anthropic-native-version", got);
  });

  it("anthropic-native-xapikey-only", async () => {
    const got = await get(multiNative, "/v1/models", { "x-api-key": "k" });
    expectGolden(SUITE, "anthropic-native-xapikey-only", got);
  });

  it("anthropic-native-version-with-bearer", async () => {
    const got = await get(multiNative, "/v1/models", {
      "anthropic-version": "2023-06-01",
      authorization: "Bearer k",
    });
    expectGolden(SUITE, "anthropic-native-version-with-bearer", got);
  });

  it("anthropic-native-version-empty-fixtures", async () => {
    const got = await get(emptyNative, "/v1/models", {
      "anthropic-version": "2023-06-01",
      "x-api-key": "k",
    });
    expectGolden(SUITE, "anthropic-native-version-empty-fixtures", got);
  });
});

// ─── Ollama, OpenRouter and OpenRouter video listings without record ───────

describe("listings without record", () => {
  it("ollama-tags", async () => {
    expectGolden(SUITE, "ollama-tags", await get(multi, "/api/tags"));
  });

  it("ollama-tags-defaults-empty-fixtures", async () => {
    expectGolden(SUITE, "ollama-tags-defaults-empty-fixtures", await get(empty, "/api/tags"));
  });

  it("ollama-tags-mixed-endpoints", async () => {
    expectGolden(SUITE, "ollama-tags-mixed-endpoints", await get(mixed, "/api/tags"));
  });

  it("openrouter-models", async () => {
    const got = await captureWithJournal(multi, "/api/v1/models", { authorization: "Bearer k" });
    expectGolden(SUITE, "openrouter-models", got);
  });

  it("openrouter-models-defaults-empty-fixtures", async () => {
    const got = await captureWithJournal(empty, "/api/v1/models");
    expectGolden(SUITE, "openrouter-models-defaults-empty-fixtures", got);
  });

  it("openrouter-models-mixed-endpoints", async () => {
    const got = await captureWithJournal(mixed, "/api/v1/models");
    expectGolden(SUITE, "openrouter-models-mixed-endpoints", got);
  });

  it("openrouter-video-models-no-video-fixtures", async () => {
    const got = await captureWithJournal(multi, "/api/v1/videos/models");
    expectGolden(SUITE, "openrouter-video-models-no-video-fixtures", got);
  });

  it("openrouter-video-models-defaults-empty-fixtures", async () => {
    const got = await captureWithJournal(empty, "/api/v1/videos/models");
    expectGolden(SUITE, "openrouter-video-models-defaults-empty-fixtures", got);
  });

  it("openrouter-video-models-mixed-endpoints", async () => {
    const got = await captureWithJournal(mixed, "/api/v1/videos/models");
    expectGolden(SUITE, "openrouter-video-models-mixed-endpoints", got);
  });

  it("openrouter-video-models-no-string-model", async () => {
    const got = await captureWithJournal(videoNoString, "/api/v1/videos/models");
    expectGolden(SUITE, "openrouter-video-models-no-string-model", got);
  });
});

// ─── The same listings in record mode (non-strict and strict) ───────────────

/** Canned upstream video-model list; anything else is a 404. */
const UPSTREAM_VIDEO_MODELS = JSON.stringify({ data: [{ id: "upstream/video-1" }] });

describe.each([
  { mode: "record", strict: false },
  { mode: "strict-record", strict: true },
])("listings in $mode mode", ({ mode, strict }) => {
  let upstream: StubUpstream;
  let server: GoldenServer;
  let fixtureDir: string;

  beforeAll(async () => {
    upstream = await startStubUpstream((req, res) => {
      if (req.url === "/api/v1/videos/models") {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(UPSTREAM_VIDEO_MODELS);
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "stub: unexpected path" }));
    });
    fixtureDir = mkdtempSync(join(tmpdir(), "aimock-golden-models-"));
    server = await startGoldenServer(mixedEndpoints, {
      strict,
      record: { providers: { openrouter: upstream.url }, fixturePath: fixtureDir },
    });
  });

  afterAll(async () => {
    // Close the upstream and remove the dir even if an earlier step fails.
    try {
      await server?.close();
    } finally {
      try {
        await upstream?.close();
      } finally {
        if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
      }
    }
  });

  /** Capture one request plus every upstream request it caused. */
  async function captureRecorded(path: string, headers: Record<string, string> = {}) {
    const hitsBefore = upstream.requests.length;
    const got = await captureWithJournal(server, path, headers);
    const upstreamHits = upstream.requests.slice(hitsBefore).map((r) => ({
      method: r.method,
      url: r.url,
      authorization: r.headers.authorization ?? null,
    }));
    return { ...got, upstreamHits };
  }

  it(`ollama-tags-${mode}`, async () => {
    expectGolden(SUITE, `ollama-tags-${mode}`, await captureRecorded("/api/tags"));
  });

  it(`openrouter-models-${mode}`, async () => {
    const got = await captureRecorded("/api/v1/models", { authorization: "Bearer k" });
    expectGolden(SUITE, `openrouter-models-${mode}`, got);
  });

  it(`openrouter-video-models-${mode}`, async () => {
    const got = await captureRecorded("/api/v1/videos/models", { authorization: "Bearer k" });
    expectGolden(SUITE, `openrouter-video-models-${mode}`, got);
  });

  it(`openrouter-video-models-${mode}-strict-header-flip`, async () => {
    // The per-request header overrides the server default in the other direction.
    const got = await captureRecorded("/api/v1/videos/models", {
      authorization: "Bearer k",
      "x-aimock-strict": strict ? "false" : "true",
    });
    expectGolden(SUITE, `openrouter-video-models-${mode}-strict-header-flip`, got);
  });
});

describe("OpenRouter video listing, record mode, failing upstream", () => {
  let upstream: StubUpstream;
  let server: GoldenServer;
  let fixtureDir: string;

  beforeAll(async () => {
    upstream = await startStubUpstream((_req, res) => {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "stub: unavailable" }));
    });
    fixtureDir = mkdtempSync(join(tmpdir(), "aimock-golden-models-"));
    server = await startGoldenServer(mixedEndpoints, {
      record: { providers: { openrouter: upstream.url }, fixturePath: fixtureDir },
    });
  });

  afterAll(async () => {
    // Close the upstream and remove the dir even if an earlier step fails.
    try {
      await server?.close();
    } finally {
      try {
        await upstream?.close();
      } finally {
        if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
      }
    }
  });

  it("openrouter-video-models-record-upstream-error", async () => {
    const got = await captureWithJournal(server, "/api/v1/videos/models", {
      authorization: "Bearer k",
    });
    const upstreamHits = upstream.requests.map((r) => ({ method: r.method, url: r.url }));
    expectGolden(SUITE, "openrouter-video-models-record-upstream-error", { ...got, upstreamHits });
  });
});

// ─── Shared 404 for GETs on Gemini `:verb` paths ────────────────────────────

describe("shared 404 on Gemini :verb paths", () => {
  const paths: Array<[string, string]> = [
    ["generate", "/v1beta/models/gemini-2.5-flash:generateContent"],
    ["count-tokens", "/v1beta/models/gemini-2.5-flash:countTokens"],
    ["generate-encoded-colon", "/v1beta/models/gemini-2.5-flash%3AgenerateContent"],
    // An Ollama-style tagged id: its `:latest` suffix reads as a `:verb` too.
    ["ollama-tagged-id", "/v1beta/models/llama3:latest"],
  ];

  for (const [name, path] of paths) {
    it(`shared404-${name}`, async () => {
      expectGolden(SUITE, `shared404-${name}`, await get(multi, path));
    });

    it(`shared404-${name}-goog-key`, async () => {
      const got = await get(multi, path, { "x-goog-api-key": "k" });
      expectGolden(SUITE, `shared404-${name}-goog-key`, got);
    });
  }
});
