import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { Readable, Writable } from "node:stream";
import type * as http from "node:http";
import { LLMock } from "../llmock.js";
import { handleModeration } from "../moderation.js";
import { handleRerank } from "../rerank.js";
import { handleSearch } from "../search.js";
import { Journal } from "../journal.js";
import { Logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Service mock endpoints: search, rerank, moderation
// ---------------------------------------------------------------------------

let mock: LLMock;

afterEach(async () => {
  if (mock) {
    await mock.stop();
  }
});

async function post(url: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

async function postRaw(url: string, raw: string): Promise<{ status: number; json: unknown }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw,
  });
  const json = await res.json();
  return { status: res.status, json };
}

// ---------------------------------------------------------------------------
// POST /search
// ---------------------------------------------------------------------------

describe("POST /search", () => {
  it("returns matching results for a string pattern", async () => {
    mock = new LLMock();
    mock.onSearch("weather", [
      { title: "Weather Report", url: "https://example.com/weather", content: "Sunny today" },
    ]);
    const url = await mock.start();

    const { status, json } = await post(`${url}/search`, { query: "What is the weather?" });

    expect(status).toBe(200);
    const data = json as { results: Array<{ title: string; url: string; content: string }> };
    expect(data.results).toHaveLength(1);
    expect(data.results[0].title).toBe("Weather Report");
    expect(data.results[0].url).toBe("https://example.com/weather");
    expect(data.results[0].content).toBe("Sunny today");
  });

  it("returns empty results when no fixture matches", async () => {
    mock = new LLMock();
    mock.onSearch("weather", [
      { title: "Weather Report", url: "https://example.com/weather", content: "Sunny today" },
    ]);
    const url = await mock.start();

    const { status, json } = await post(`${url}/search`, { query: "stock prices" });

    expect(status).toBe(200);
    const data = json as { results: unknown[] };
    expect(data.results).toHaveLength(0);
  });

  it("matches with RegExp patterns", async () => {
    mock = new LLMock();
    mock.onSearch(/\bweather\b/i, [
      { title: "Weather", url: "https://example.com", content: "Rain expected", score: 0.95 },
    ]);
    const url = await mock.start();

    const { status, json } = await post(`${url}/search`, { query: "WEATHER forecast" });

    expect(status).toBe(200);
    const data = json as { results: Array<{ score?: number }> };
    expect(data.results).toHaveLength(1);
    expect(data.results[0].score).toBe(0.95);
  });
});

// ---------------------------------------------------------------------------
// POST /v2/rerank
// ---------------------------------------------------------------------------

describe("POST /v2/rerank", () => {
  it("returns scored results for a matching query", async () => {
    mock = new LLMock();
    mock.onRerank("machine learning", [
      { index: 0, relevance_score: 0.99 },
      { index: 2, relevance_score: 0.85 },
    ]);
    const url = await mock.start();

    const { status, json } = await post(`${url}/v2/rerank`, {
      query: "What is machine learning?",
      documents: ["ML is a subset of AI", "Cooking recipes", "Deep learning overview"],
      model: "rerank-v3.5",
    });

    expect(status).toBe(200);
    const data = json as {
      id: string;
      results: Array<{
        index: number;
        relevance_score: number;
        document: { text: string };
      }>;
      meta: { billed_units: { search_units: number } };
    };
    expect(data.id).toMatch(/^rerank-/);
    expect(data.results).toHaveLength(2);
    expect(data.results[0].index).toBe(0);
    expect(data.results[0].relevance_score).toBe(0.99);
    expect(data.results[0].document.text).toBe("ML is a subset of AI");
    expect(data.results[1].index).toBe(2);
    expect(data.results[1].document.text).toBe("Deep learning overview");
    expect(data.meta.billed_units.search_units).toBe(0);
  });

  it("returns empty results when no fixture matches", async () => {
    mock = new LLMock();
    mock.onRerank("machine learning", [{ index: 0, relevance_score: 0.99 }]);
    const url = await mock.start();

    const { status, json } = await post(`${url}/v2/rerank`, {
      query: "cooking tips",
      documents: ["How to bake bread"],
      model: "rerank-v3.5",
    });

    expect(status).toBe(200);
    const data = json as { results: unknown[] };
    expect(data.results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/moderations
// ---------------------------------------------------------------------------

describe("POST /v1/moderations", () => {
  it("returns flagged result for matching content", async () => {
    mock = new LLMock();
    mock.onModerate("violent", {
      flagged: true,
      categories: { violence: true, hate: false },
      category_scores: { violence: 0.95, hate: 0.01 },
    });
    const url = await mock.start();

    const { status, json } = await post(`${url}/v1/moderations`, {
      input: "This is violent content",
    });

    expect(status).toBe(200);
    const data = json as {
      id: string;
      model: string;
      results: Array<{
        flagged: boolean;
        categories: Record<string, boolean>;
        category_scores: Record<string, number>;
      }>;
    };
    expect(data.id).toMatch(/^modr-/);
    expect(data.model).toBe("text-moderation-latest");
    expect(data.results).toHaveLength(1);
    expect(data.results[0].flagged).toBe(true);
    expect(data.results[0].categories.violence).toBe(true);
    expect(data.results[0].category_scores!.violence).toBe(0.95);
  });

  it("returns unflagged default result when no fixture matches", async () => {
    mock = new LLMock();
    mock.onModerate("violent", {
      flagged: true,
      categories: { violence: true },
    });
    const url = await mock.start();

    const { status, json } = await post(`${url}/v1/moderations`, {
      input: "A nice sunny day",
    });

    expect(status).toBe(200);
    const data = json as {
      results: Array<{ flagged: boolean; categories: Record<string, boolean> }>;
    };
    expect(data.results[0].flagged).toBe(false);
    expect(data.results[0].categories.violence).toBe(false);
  });

  it("matches with RegExp catch-all", async () => {
    mock = new LLMock();
    mock.onModerate(/.*/, {
      flagged: false,
      categories: {},
    });
    const url = await mock.start();

    const { status, json } = await post(`${url}/v1/moderations`, {
      input: "Anything at all",
    });

    expect(status).toBe(200);
    const data = json as { results: Array<{ flagged: boolean }> };
    expect(data.results[0].flagged).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// POST /search — additional coverage
// ---------------------------------------------------------------------------

describe("POST /search — edge cases", () => {
  it("returns 400 for malformed JSON body", async () => {
    mock = new LLMock();
    mock.onSearch("anything", [{ title: "T", url: "https://t.com", content: "C" }]);
    const url = await mock.start();

    const { status, json } = await postRaw(`${url}/search`, "{not valid json");

    expect(status).toBe(400);
    const data = json as { error: { message: string; type: string; code: string } };
    expect(data.error.message).toBe("Malformed JSON");
    expect(data.error.type).toBe("invalid_request_error");
    expect(data.error.code).toBe("invalid_json");
  });

  it("respects max_results to limit returned results", async () => {
    mock = new LLMock();
    mock.onSearch("docs", [
      { title: "Doc 1", url: "https://1.com", content: "First" },
      { title: "Doc 2", url: "https://2.com", content: "Second" },
      { title: "Doc 3", url: "https://3.com", content: "Third" },
    ]);
    const url = await mock.start();

    const { status, json } = await post(`${url}/search`, {
      query: "docs topic",
      max_results: 2,
    });

    expect(status).toBe(200);
    const data = json as { results: Array<{ title: string }> };
    expect(data.results).toHaveLength(2);
    expect(data.results[0].title).toBe("Doc 1");
    expect(data.results[1].title).toBe("Doc 2");
  });

  it("returns all results when max_results is 0 or undefined", async () => {
    mock = new LLMock();
    mock.onSearch("docs", [
      { title: "Doc 1", url: "https://1.com", content: "First" },
      { title: "Doc 2", url: "https://2.com", content: "Second" },
    ]);
    const url = await mock.start();

    // max_results = 0 should not limit (the code checks > 0)
    const { json: json0 } = await post(`${url}/search`, {
      query: "docs topic",
      max_results: 0,
    });
    expect((json0 as { results: unknown[] }).results).toHaveLength(2);

    // No max_results at all
    const { json: jsonNone } = await post(`${url}/search`, { query: "docs topic" });
    expect((jsonNone as { results: unknown[] }).results).toHaveLength(2);
  });

  it("handles missing query field gracefully", async () => {
    mock = new LLMock();
    mock.onSearch(/.*/i, [{ title: "Catch All", url: "https://all.com", content: "Everything" }]);
    const url = await mock.start();

    const { status, json } = await post(`${url}/search`, {});

    expect(status).toBe(200);
    const data = json as { results: Array<{ title: string }> };
    expect(data.results).toHaveLength(1);
    expect(data.results[0].title).toBe("Catch All");
  });
});

// ---------------------------------------------------------------------------
// POST /v2/rerank — additional coverage
// ---------------------------------------------------------------------------

describe("POST /v2/rerank — edge cases", () => {
  it("returns 400 for malformed JSON body", async () => {
    mock = new LLMock();
    mock.onRerank("anything", [{ index: 0, relevance_score: 0.5 }]);
    const url = await mock.start();

    const { status, json } = await postRaw(`${url}/v2/rerank`, "{{bad json!!");

    expect(status).toBe(400);
    const data = json as { error: { message: string; type: string; code: string } };
    expect(data.error.message).toBe("Malformed JSON");
    expect(data.error.type).toBe("invalid_request_error");
    expect(data.error.code).toBe("invalid_json");
  });

  it("extracts text from object documents with text property", async () => {
    mock = new LLMock();
    mock.onRerank("test", [
      { index: 0, relevance_score: 0.95 },
      { index: 1, relevance_score: 0.8 },
    ]);
    const url = await mock.start();

    const { status, json } = await post(`${url}/v2/rerank`, {
      query: "test query",
      documents: [{ text: "Object doc with text field" }, "Plain string doc"],
      model: "rerank-v3.5",
    });

    expect(status).toBe(200);
    const data = json as {
      results: Array<{ index: number; document: { text: string } }>;
    };
    expect(data.results[0].document.text).toBe("Object doc with text field");
    expect(data.results[1].document.text).toBe("Plain string doc");
  });

  it("returns empty text for documents that are neither string nor {text}", async () => {
    mock = new LLMock();
    mock.onRerank("test", [{ index: 0, relevance_score: 0.5 }]);
    const url = await mock.start();

    const { status, json } = await post(`${url}/v2/rerank`, {
      query: "test query",
      documents: [42],
      model: "rerank-v3.5",
    });

    expect(status).toBe(200);
    const data = json as {
      results: Array<{ document: { text: string } }>;
    };
    expect(data.results[0].document.text).toBe("");
  });

  it("returns empty text when document index is out of bounds", async () => {
    mock = new LLMock();
    mock.onRerank("test", [{ index: 5, relevance_score: 0.9 }]);
    const url = await mock.start();

    const { status, json } = await post(`${url}/v2/rerank`, {
      query: "test query",
      documents: ["only one doc"],
      model: "rerank-v3.5",
    });

    expect(status).toBe(200);
    const data = json as {
      results: Array<{ index: number; document: { text: string } }>;
    };
    expect(data.results[0].index).toBe(5);
    expect(data.results[0].document.text).toBe("");
  });

  it("handles missing query and documents gracefully", async () => {
    mock = new LLMock();
    mock.onRerank(/.*/i, [{ index: 0, relevance_score: 0.5 }]);
    const url = await mock.start();

    const { status, json } = await post(`${url}/v2/rerank`, { model: "rerank-v3.5" });

    expect(status).toBe(200);
    const data = json as {
      results: Array<{ document: { text: string } }>;
    };
    // document at index 0 of empty array -> undefined -> empty text
    expect(data.results[0].document.text).toBe("");
  });
});

// ---------------------------------------------------------------------------
// POST /v1/moderations — additional coverage
// ---------------------------------------------------------------------------

describe("POST /v1/moderations — edge cases", () => {
  it("returns 400 for malformed JSON body", async () => {
    mock = new LLMock();
    mock.onModerate("anything", { flagged: false, categories: {} });
    const url = await mock.start();

    const { status, json } = await postRaw(`${url}/v1/moderations`, "not-json");

    expect(status).toBe(400);
    const data = json as { error: { message: string; type: string; code: string } };
    expect(data.error.message).toBe("Malformed JSON");
    expect(data.error.type).toBe("invalid_request_error");
    expect(data.error.code).toBe("invalid_json");
  });

  it("handles array input by joining elements", async () => {
    mock = new LLMock();
    mock.onModerate("violent hate", {
      flagged: true,
      categories: { violence: true, hate: true },
    });
    const url = await mock.start();

    const { status, json } = await post(`${url}/v1/moderations`, {
      input: ["violent", "hate"],
    });

    expect(status).toBe(200);
    const data = json as { results: Array<{ flagged: boolean }> };
    expect(data.results[0].flagged).toBe(true);
  });

  it("handles missing input field gracefully", async () => {
    mock = new LLMock();
    mock.onModerate(/.*/i, {
      flagged: false,
      categories: { sexual: false },
    });
    const url = await mock.start();

    const { status, json } = await post(`${url}/v1/moderations`, {});

    expect(status).toBe(200);
    const data = json as { results: Array<{ flagged: boolean }> };
    expect(data.results[0].flagged).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// /v2/rerank does NOT conflict with /v2/chat (Cohere endpoint)
// ---------------------------------------------------------------------------

describe("/v2/rerank vs /v2/chat", () => {
  it("routes /v2/rerank to rerank handler, not Cohere chat", async () => {
    mock = new LLMock();
    mock.onRerank("test", [{ index: 0, relevance_score: 0.9 }]);
    mock.onMessage("test", { content: "Cohere response" });
    const url = await mock.start();

    // Rerank endpoint should work
    const rerankRes = await post(`${url}/v2/rerank`, {
      query: "test query",
      documents: ["doc1"],
      model: "rerank-v3.5",
    });
    expect(rerankRes.status).toBe(200);
    const rerankData = rerankRes.json as { id: string; results: unknown[] };
    expect(rerankData.id).toMatch(/^rerank-/);
    expect(rerankData.results).toHaveLength(1);

    // Cohere chat endpoint should still work
    const chatRes = await post(`${url}/v2/chat`, {
      model: "command-r-plus",
      messages: [{ role: "user", content: "test" }],
    });
    expect(chatRes.status).toBe(200);
    const chatData = chatRes.json as { message?: unknown };
    // Cohere chat returns a different shape — just verify it's not a rerank response
    expect(chatData).not.toHaveProperty("meta");
  });
});

// ---------------------------------------------------------------------------
// Journal records service requests
// ---------------------------------------------------------------------------

describe("Journal records service requests", () => {
  it("records search, rerank, and moderation requests in the journal", async () => {
    mock = new LLMock();
    mock.onSearch("test", [{ title: "Test", url: "https://test.com", content: "Test content" }]);
    mock.onRerank("test", [{ index: 0, relevance_score: 0.9 }]);
    mock.onModerate("test", { flagged: false, categories: {} });
    const url = await mock.start();

    await post(`${url}/search`, { query: "test query" });
    await post(`${url}/v2/rerank`, { query: "test query", documents: ["doc"], model: "m" });
    await post(`${url}/v1/moderations`, { input: "test input" });

    const requests = mock.getRequests();
    expect(requests).toHaveLength(3);

    expect(requests[0].path).toBe("/search");
    expect(requests[0].service).toBe("search");

    expect(requests[1].path).toBe("/v2/rerank");
    expect(requests[1].service).toBe("rerank");

    expect(requests[2].path).toBe("/v1/moderations");
    expect(requests[2].service).toBe("moderation");
  });
});

// ---------------------------------------------------------------------------
// Direct handler tests — exercises ?? fallback branches for req.method/req.url
// ---------------------------------------------------------------------------

/**
 * Creates a minimal mock IncomingMessage with optional method/url overrides.
 * When method or url is omitted, the property is undefined — which triggers
 * the ?? fallback branches in journal.add() calls.
 */
function createMockReq(opts: { method?: string; url?: string } = {}): http.IncomingMessage {
  const readable = new Readable({ read() {} }) as http.IncomingMessage;
  readable.headers = {};
  if (opts.method !== undefined) readable.method = opts.method;
  else (readable as Partial<http.IncomingMessage>).method = undefined;
  if (opts.url !== undefined) readable.url = opts.url;
  else (readable as Partial<http.IncomingMessage>).url = undefined;
  return readable;
}

/**
 * Creates a mock ServerResponse that captures writeHead status and end body.
 */
function createMockRes(): http.ServerResponse & { _status: number; _body: string } {
  const writable = new Writable({
    write(_chunk, _encoding, cb) {
      cb();
    },
  }) as http.ServerResponse & { _status: number; _body: string };
  writable._status = 0;
  writable._body = "";
  writable.writeHead = function (statusCode: number) {
    this._status = statusCode;
    return this;
  } as unknown as typeof writable.writeHead;
  writable.end = function (body?: string) {
    if (body) this._body = body;
    return this;
  } as unknown as typeof writable.end;
  return writable;
}

const noop = () => {};

describe("Direct handler — moderation ?? fallback branches", () => {
  beforeEach(() => {
    mock = undefined as unknown as LLMock;
  });

  it("uses fallback method/path in journal when req.method and req.url are undefined (malformed JSON)", async () => {
    const journal = new Journal();
    const logger = new Logger("silent");
    const req = createMockReq(); // method and url are undefined
    const res = createMockRes();

    await handleModeration(req, res, "{bad json!!", [], journal, { logger }, noop);

    expect(res._status).toBe(400);
    const entries = journal.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].method).toBe("POST");
    expect(entries[0].path).toBe("/v1/moderations");
  });

  it("uses fallback method/path in journal when req.method and req.url are undefined (valid request)", async () => {
    const journal = new Journal();
    const logger = new Logger("silent");
    const req = createMockReq(); // method and url are undefined
    const res = createMockRes();

    await handleModeration(
      req,
      res,
      JSON.stringify({ input: "hello" }),
      [],
      journal,
      { logger },
      noop,
    );

    expect(res._status).toBe(200);
    const entries = journal.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].method).toBe("POST");
    expect(entries[0].path).toBe("/v1/moderations");
  });
});

describe("Direct handler — rerank ?? fallback branches", () => {
  beforeEach(() => {
    mock = undefined as unknown as LLMock;
  });

  it("uses fallback method/path in journal when req.method and req.url are undefined (malformed JSON)", async () => {
    const journal = new Journal();
    const logger = new Logger("silent");
    const req = createMockReq();
    const res = createMockRes();

    await handleRerank(req, res, "not json", [], journal, { logger }, noop);

    expect(res._status).toBe(400);
    const entries = journal.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].method).toBe("POST");
    expect(entries[0].path).toBe("/v2/rerank");
  });

  it("uses fallback method/path in journal when req.method and req.url are undefined (valid request)", async () => {
    const journal = new Journal();
    const logger = new Logger("silent");
    const req = createMockReq();
    const res = createMockRes();

    await handleRerank(
      req,
      res,
      JSON.stringify({ query: "test", documents: ["doc1"] }),
      [],
      journal,
      { logger },
      noop,
    );

    expect(res._status).toBe(200);
    const entries = journal.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].method).toBe("POST");
    expect(entries[0].path).toBe("/v2/rerank");
  });
});

describe("Direct handler — search ?? fallback branches", () => {
  beforeEach(() => {
    mock = undefined as unknown as LLMock;
  });

  it("uses fallback method/path in journal when req.method and req.url are undefined (malformed JSON)", async () => {
    const journal = new Journal();
    const logger = new Logger("silent");
    const req = createMockReq();
    const res = createMockRes();

    await handleSearch(req, res, "{{bad", [], journal, { logger }, noop);

    expect(res._status).toBe(400);
    const entries = journal.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].method).toBe("POST");
    expect(entries[0].path).toBe("/search");
  });

  it("uses fallback method/path in journal when req.method and req.url are undefined (valid request)", async () => {
    const journal = new Journal();
    const logger = new Logger("silent");
    const req = createMockReq();
    const res = createMockRes();

    await handleSearch(req, res, JSON.stringify({ query: "test" }), [], journal, { logger }, noop);

    expect(res._status).toBe(200);
    const entries = journal.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].method).toBe("POST");
    expect(entries[0].path).toBe("/search");
  });
});
