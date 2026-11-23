import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createServer, type ServerInstance } from "../server.js";
import { loadFixturesFromDir } from "../fixture-loader.js";
import type { Fixture, RecordProviderKey } from "../types.js";

type Json = Record<string, unknown>;

const GEMINI_PATH = "/v1beta/models/text-embedding-004:embedContent";
const geminiRequest = { content: { parts: [{ text: "hello" }] } };
const cohereRequest = (texts: string[], types: string[]) => ({
  model: "embed-v4.0",
  texts,
  input_type: "search_document",
  embedding_types: types,
});
const cohereBody = (embeddings: Json, texts = ["hello"]) => ({
  id: "emb_1",
  texts,
  embeddings,
  meta: { api_version: { version: "2" } },
  response_type: "embeddings_by_type",
});

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const close = (server: http.Server) =>
  new Promise<void>((resolve) => server.close(() => resolve()));

async function serve(fixtures: Fixture[], options: Parameters<typeof createServer>[1] = {}) {
  const instance = await createServer(fixtures, { port: 0, logLevel: "silent", ...options });
  cleanups.push(() => close(instance.server));
  return instance;
}

async function upstreamReturning(body: Json) {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => close(upstream));
  return `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
}

const post = (server: ServerInstance, route: string, body: Json) =>
  fetch(`${server.url}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function roundTrip(provider: RecordProviderKey, route: string, request: Json, body: Json) {
  const fixturePath = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-embeddings-"));
  cleanups.push(() => fs.rmSync(fixturePath, { recursive: true, force: true }));
  const providers = { [provider]: await upstreamReturning(body) };
  const recorder = await serve([], { record: { providers, fixturePath } });
  const relayed = await post(recorder, route, request);
  expect(relayed.status).toBe(200);
  await relayed.text();

  const fixtures = loadFixturesFromDir(fixturePath);
  const replayed = await post(await serve(fixtures), route, request);
  return { fixtures, replayed };
}

describe("recorder: Gemini embedContent", () => {
  for (const values of [[0.1, 0.2], []]) {
    it(`records ${values.length} values and replays the same body`, async () => {
      const body = { embedding: { values } };
      const { fixtures, replayed } = await roundTrip("gemini", GEMINI_PATH, geminiRequest, body);

      expect(fixtures.map((f) => f.response)).toEqual([{ embedding: values }]);
      expect(replayed.status).toBe(200);
      expect(await replayed.text()).toBe(JSON.stringify(body));
    });
  }
});

describe("recorder: Cohere v2 embed", () => {
  const cases: Array<[string, string[], Json, number[]]> = [
    ["a float vector", ["float"], { float: [[0.1, 0.2]] }, [0.1, 0.2]],
    ["an int8 vector", ["int8"], { int8: [[12, -7]] }, [12, -7]],
    [
      "the float vector of several types",
      ["int8", "float"],
      { int8: [[12]], float: [[0.1]] },
      [0.1],
    ],
    ["an empty vector", ["float"], { float: [[]] }, []],
  ];
  for (const [name, types, embeddings, vector] of cases) {
    it(`records ${name} and replays it`, async () => {
      const request = cohereRequest(["hello"], types);
      const { fixtures, replayed } = await roundTrip(
        "cohere",
        "/v2/embed",
        request,
        cohereBody(embeddings),
      );

      expect(fixtures.map((f) => f.response)).toEqual([{ embedding: vector }]);
      expect(replayed.status).toBe(200);
      expect(((await replayed.json()) as Json).embeddings).toEqual(
        Object.fromEntries(types.map((type) => [type, [vector]])),
      );
    });
  }

  it("records the first vector of a batch, which replay repeats for every text", async () => {
    const request = cohereRequest(["a", "b"], ["float"]);
    const body = cohereBody({ float: [[0.1], [0.2]] }, ["a", "b"]);
    const { fixtures, replayed } = await roundTrip("cohere", "/v2/embed", request, body);

    expect(fixtures.map((f) => f.response)).toEqual([{ embedding: [0.1] }]);
    expect(((await replayed.json()) as Json).embeddings).toEqual({ float: [[0.1], [0.1]] });
  });

  it("still saves an error for a base64 only reply it cannot replay", async () => {
    const request = cohereRequest(["hello"], ["base64"]);
    const body = cohereBody({ base64: ["zczMPQ=="] });
    const { fixtures } = await roundTrip("cohere", "/v2/embed", request, body);

    expect(fixtures[0].response).toMatchObject({ error: { type: "proxy_error" } });
  });
});
