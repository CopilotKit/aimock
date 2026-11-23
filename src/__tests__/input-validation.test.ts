import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import { createServer, type ServerInstance } from "../server.js";
import {
  validateEmbeddingDimensions,
  normalizeEmbeddingInput,
  normalizeTextInput,
  MAX_EMBEDDING_DIMENSIONS,
} from "../helpers.js";

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

function post(
  url: string,
  body: unknown,
): Promise<{ status: number; body: string; json: unknown }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
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
          resolve({ status: res.statusCode ?? 0, body: text, json });
        });
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
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

// ---------------------------------------------------------------------------
// Unit: validateEmbeddingDimensions
// ---------------------------------------------------------------------------

describe("validateEmbeddingDimensions", () => {
  it("defaults to 1536 when omitted or null", () => {
    expect(validateEmbeddingDimensions(undefined)).toBe(1536);
    // Regression: `main` did `dimensions ?? 1536`, so null meant "unset".
    expect(validateEmbeddingDimensions(null)).toBe(1536);
  });

  it("accepts boundary values 1 and MAX", () => {
    expect(validateEmbeddingDimensions(1)).toBe(1);
    expect(validateEmbeddingDimensions(MAX_EMBEDDING_DIMENSIONS)).toBe(MAX_EMBEDDING_DIMENSIONS);
  });

  it("rejects zero, negatives, floats, NaN, strings, null", () => {
    for (const bad of [0, -1, -1536, 1.5, Number.NaN, "1536", {}, []]) {
      expect(validateEmbeddingDimensions(bad)).toBeNull();
    }
  });

  it("rejects values above the cap", () => {
    expect(validateEmbeddingDimensions(MAX_EMBEDDING_DIMENSIONS + 1)).toBeNull();
    expect(validateEmbeddingDimensions(Number.MAX_SAFE_INTEGER)).toBeNull();
  });

  it("pins the cap to a width the mock can actually serve", () => {
    // Literal on purpose: referencing the constant alone lets the cap drift.
    //
    // The cap is a serialization budget, not an allocation bound. Measured on
    // this tree, a response body costs 19.58 bytes per dimension (4096 →
    // 80,456 B; 1,000,000 → 19,583,034 B), so 100,000 dimensions is a ~1.96 MB
    // body, built in 7 ms at 83 MB RSS under a 1 GB heap. That leaves >12× the
    // widest width in circulation (3072 for text-embedding-3-large, 4096/8192
    // on the OpenAI-compatible servers this endpoint also serves) while keeping
    // every accepted request serviceable.
    expect(MAX_EMBEDDING_DIMENSIONS).toBe(100_000);
    // 20 bytes/dimension, rounded up from the 19.58 measured above.
    expect(MAX_EMBEDDING_DIMENSIONS * 20).toBeLessThan(2 * 1024 * 1024);
  });
});

describe("normalizeEmbeddingInput", () => {
  it("wraps a single string", () => {
    expect(normalizeEmbeddingInput("hi")).toEqual(["hi"]);
  });

  it("passes through string arrays", () => {
    expect(normalizeEmbeddingInput(["a", "b"])).toEqual(["a", "b"]);
  });

  it("accepts token arrays — EmbeddingCreateParams.input allows number[]/number[][]", () => {
    expect(normalizeEmbeddingInput([15339, 1917])).toEqual(["15339 1917"]);
    expect(normalizeEmbeddingInput([[15339, 1917], [9906]])).toEqual(["15339 1917", "9906"]);
  });

  it("rejects numbers, objects, mixed arrays, null", () => {
    expect(normalizeEmbeddingInput(123)).toBeNull();
    expect(normalizeEmbeddingInput({})).toBeNull();
    expect(normalizeEmbeddingInput(null)).toBeNull();
    expect(normalizeEmbeddingInput(["ok", 42])).toBeNull();
    expect(normalizeEmbeddingInput(undefined)).toBeNull();
  });
});

describe("normalizeTextInput", () => {
  it("passes strings through and joins string arrays", () => {
    expect(normalizeTextInput("hi")).toBe("hi");
    expect(normalizeTextInput(["a", "b"])).toBe("a b");
  });

  it("accepts multimodal parts and stringifies other array elements", () => {
    // ModerationCreateParams.input allows Array<ModerationMultiModalInput>.
    expect(
      normalizeTextInput([
        { type: "text", text: "hello" },
        { type: "image_url", image_url: { url: "https://example.com/a.png" } },
      ]),
    ).toBe("hello ");
    // `[123].join(" ")` was "123" and returned 200 — it must keep doing so.
    expect(normalizeTextInput([123])).toBe("123");
  });

  it("rejects numbers and objects", () => {
    expect(normalizeTextInput(123)).toBeNull();
    expect(normalizeTextInput({})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// POST /v1/embeddings — strict input validation
// ---------------------------------------------------------------------------

describe("POST /v1/embeddings strict validation", () => {
  it("returns 400 for numeric input (was 500 TypeError)", async () => {
    instance = await createServer([]);
    const res = await post(`${instance.url}/v1/embeddings`, {
      model: "text-embedding-3-small",
      input: 123,
    });
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({
      error: { type: "invalid_request_error", param: null, code: null },
    });
  });

  it("returns 400 for object input and mixed arrays", async () => {
    instance = await createServer([]);
    for (const bad of [{}, { text: "hi" }, ["ok", 42], [null], true]) {
      const res = await post(`${instance.url}/v1/embeddings`, {
        model: "text-embedding-3-small",
        input: bad,
      });
      expect(res.status).toBe(400);
    }
  });

  it("returns 400 for missing input", async () => {
    instance = await createServer([]);
    const res = await post(`${instance.url}/v1/embeddings`, {
      model: "text-embedding-3-small",
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid dimensions (was RangeError, or a fatal OOM)", async () => {
    instance = await createServer([]);
    for (const dimensions of [0, -1, 1.5, "1536", 4294967296]) {
      const res = await post(`${instance.url}/v1/embeddings`, {
        model: "text-embedding-3-small",
        input: "hi",
        dimensions,
      });
      expect(res.status).toBe(400);
      expect(res.json).toMatchObject({
        error: { type: "invalid_request_error", param: null, code: null },
      });
    }
  });

  it("accepts dimensions 1 and widths past any OpenAI model (3073, 4096)", async () => {
    instance = await createServer([]);
    for (const dimensions of [1, 3073, 4096]) {
      const res = await post(`${instance.url}/v1/embeddings`, {
        model: "text-embedding-3-small",
        input: "hi",
        dimensions,
      });
      expect(res.status).toBe(200);
      expect((res.json as { data: { embedding: number[] }[] }).data[0].embedding).toHaveLength(
        dimensions,
      );
    }
  });

  it("serves a request at the cap and stays alive afterwards", async () => {
    // Regression: the cap used to be 2**32-1, the ECMAScript array-length
    // bound. `new Array(n)` accepts that, but the handler fills and serializes
    // the array, so one request at the old cap aborted the process with
    // "FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed - JavaScript heap out
    // of memory" before writing any response. A cap the server cannot serve is
    // not a cap; the boundary value must round-trip.
    instance = await createServer([]);
    const res = await post(`${instance.url}/v1/embeddings`, {
      model: "text-embedding-3-small",
      input: "hi",
      dimensions: MAX_EMBEDDING_DIMENSIONS,
    });
    expect(res.status).toBe(200);
    expect((res.json as { data: { embedding: number[] }[] }).data[0].embedding).toHaveLength(
      MAX_EMBEDDING_DIMENSIONS,
    );
    // Still serving after the largest request it accepts.
    const after = await post(`${instance.url}/v1/embeddings`, {
      model: "text-embedding-3-small",
      input: "hi",
      dimensions: 8,
    });
    expect(after.status).toBe(200);
  });

  it("treats dimensions: null as unset", async () => {
    instance = await createServer([]);
    const res = await post(`${instance.url}/v1/embeddings`, {
      model: "text-embedding-3-small",
      input: "hi",
      dimensions: null,
    });
    expect(res.status).toBe(200);
    expect((res.json as { data: { embedding: number[] }[] }).data[0].embedding).toHaveLength(1536);
  });

  it("does not gate the fixture-replay path on dimensions", async () => {
    // `dimensions` is read only by the deterministic fallback; a matched
    // fixture (or a proxied/record request) must not be rejected over it.
    instance = await createServer([
      { match: { inputText: "hello" }, response: { embedding: [0.1, 0.2, 0.3] } },
    ]);
    const res = await post(`${instance.url}/v1/embeddings`, {
      model: "text-embedding-3-small",
      input: "hello",
      dimensions: 4096,
    });
    expect(res.status).toBe(200);
  });

  it("serves token-array input (was 500, then wrongly 400)", async () => {
    instance = await createServer([]);
    for (const input of [
      [15339, 1917],
      [[15339, 1917], [9906]],
    ]) {
      const res = await post(`${instance.url}/v1/embeddings`, {
        model: "text-embedding-3-small",
        input,
      });
      expect(res.status).toBe(200);
    }
  });

  it("still serves valid string, string-array and empty-array inputs", async () => {
    instance = await createServer([]);
    // `input: []` returned 200 with `data: []` before this PR and crashed
    // nothing, so it must keep doing so.
    for (const input of ["hello world", ["hello", "world"], []]) {
      const res = await post(`${instance.url}/v1/embeddings`, {
        model: "text-embedding-3-small",
        input,
      });
      expect(res.status).toBe(200);
    }
  });

  it("journals invalid inputs as 400 entries", async () => {
    instance = await createServer([]);
    await post(`${instance.url}/v1/embeddings`, {
      model: "text-embedding-3-small",
      input: 123,
    });
    const entry = instance.journal.getLast();
    expect(entry).not.toBeNull();
    expect(entry!.path).toBe("/v1/embeddings");
    expect(entry!.response.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/moderations — strict input validation
// ---------------------------------------------------------------------------

describe("POST /v1/moderations strict validation", () => {
  it("returns 400 for numeric/object input (was 500 TypeError)", async () => {
    instance = await createServer([]);
    for (const bad of [123, {}, { text: "hi" }, true]) {
      const res = await post(`${instance.url}/v1/moderations`, { input: bad });
      expect(res.status).toBe(400);
      expect(res.json).toMatchObject({
        error: { type: "invalid_request_error", param: null, code: null },
      });
    }
  });

  it("still serves arrays containing non-strings, as join() used to", async () => {
    instance = await createServer([]);
    for (const input of [[123], ["ok", 42], [null]]) {
      const res = await post(`${instance.url}/v1/moderations`, { input });
      expect(res.status).toBe(200);
    }
  });

  it("serves multimodal input (Array<ModerationMultiModalInput>)", async () => {
    instance = await createServer([]);
    const res = await post(`${instance.url}/v1/moderations`, {
      model: "omni-moderation-latest",
      input: [
        { type: "text", text: "hello" },
        { type: "image_url", image_url: { url: "https://example.com/a.png" } },
      ],
    });
    expect(res.status).toBe(200);
  });

  it("still serves valid string, array, and missing inputs", async () => {
    instance = await createServer([]);
    for (const body of [{ input: "hello" }, { input: ["a", "b"] }, {}]) {
      const res = await post(`${instance.url}/v1/moderations`, body);
      expect(res.status).toBe(200);
    }
  });
});

// ---------------------------------------------------------------------------
// POST /search — strict query validation
// ---------------------------------------------------------------------------

describe("POST /search strict validation", () => {
  it("returns 400 for numeric/object query (was 500 TypeError)", async () => {
    instance = await createServer([]);
    for (const bad of [123, {}, { q: 1 }, true]) {
      const res = await post(`${instance.url}/search`, { query: bad });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.json)).toContain("invalid_request_error");
    }
  });

  it("still serves array queries and echoes them back unchanged", async () => {
    instance = await createServer([]);
    for (const query of [[123], ["a", "b"]]) {
      const res = await post(`${instance.url}/search`, { query });
      expect(res.status).toBe(200);
      expect((res.json as { query: unknown }).query).toEqual(query);
    }
  });

  it("still serves valid and missing queries", async () => {
    instance = await createServer([]);
    const res1 = await post(`${instance.url}/search`, { query: "capital of france" });
    expect(res1.status).toBe(200);
    const res2 = await post(`${instance.url}/search`, {});
    expect(res2.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// POST /v2/rerank — strict query validation
// ---------------------------------------------------------------------------

describe("POST /v2/rerank strict validation", () => {
  it("returns 400 for numeric/object query (was 500 TypeError)", async () => {
    instance = await createServer([]);
    for (const bad of [123, {}, true]) {
      const res = await post(`${instance.url}/v2/rerank`, { query: bad });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.json)).toContain("invalid_request_error");
    }
  });

  it("still serves valid queries", async () => {
    instance = await createServer([]);
    const res = await post(`${instance.url}/v2/rerank`, { query: "best pizza" });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Error-envelope convention
// ---------------------------------------------------------------------------

describe("aimock-authored 400 envelopes", () => {
  it("emits param: null and code: null, never an authored field name", async () => {
    // `openai/error.js` reads `param`/`code` straight off `body.error`, so the
    // keys must be present or consumers see `undefined`. The *values* are a
    // different question: no real OpenAI 400 for these endpoints is recorded
    // anywhere in `fixtures/`, so `param: "input"` would be a wire value aimock
    // authored rather than observed. `src/server.ts` already answers this the
    // honest way — its four aimock-authored 400s all emit `param: null,
    // code: null` — and `src/byteplus-video.ts` states the rule: the mock never
    // authors a wire value it did not observe.
    instance = await createServer([]);
    const cases: [string, unknown][] = [
      ["/v1/embeddings", { model: "text-embedding-3-small", input: 123 }],
      ["/v1/embeddings", { model: "text-embedding-3-small", input: "hi", dimensions: 4294967296 }],
      ["/v1/moderations", { input: 123 }],
    ];
    for (const [path, body] of cases) {
      const res = await post(`${instance.url}${path}`, body);
      expect(res.status).toBe(400);
      const error = (res.json as { error: Record<string, unknown> }).error;
      expect(error).toHaveProperty("param");
      expect(error).toHaveProperty("code");
      expect(error.param).toBeNull();
      expect(error.code).toBeNull();
    }
  });
});
