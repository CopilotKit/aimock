import { describe, test, expect, afterEach, vi } from "vitest";
import * as http from "node:http";
import { VectorMock } from "../vector-mock.js";
import { A2AMock } from "../a2a-mock.js";
import { MCPMock } from "../mcp-mock.js";
import { AGUIMock } from "../agui-mock.js";
import { LLMock } from "../llmock.js";
import { Journal } from "../journal.js";

/**
 * Every response path through the mountable/standalone wrappers must leave
 * a journal entry. These paths previously skipped journaling: vector
 * malformed-JSON 400s (mountable + standalone) and standalone 404s, the A2A
 * agent-card fetch, A2A JSON-RPC parse errors, unmatched A2A streaming
 * messages, the A2A/MCP/AG-UI standalone 500 catch blocks, and the AG-UI
 * standalone 404.
 */

function rawRequest(
  url: string,
  path: string,
  method: string,
  rawBody?: string,
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const headers: Record<string, string> =
      rawBody !== undefined
        ? {
            "Content-Type": "application/json",
            "Content-Length": String(Buffer.byteLength(rawBody)),
          }
        : {};
    const req = http.request(
      { hostname: parsed.hostname, port: parsed.port, path, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
            headers: res.headers,
          }),
        );
      },
    );
    req.on("error", reject);
    if (rawBody !== undefined) req.write(rawBody);
    req.end();
  });
}

describe("vector wrapper journal coverage", () => {
  let vector: VectorMock | null = null;

  afterEach(async () => {
    await vector?.stop().catch(() => {});
    vector = null;
  });

  test("standalone malformed JSON journals the 400", async () => {
    vector = new VectorMock();
    const journal = new Journal();
    vector.setJournal(journal);
    const url = await vector.start();

    const res = await rawRequest(url, "/query", "POST", "{not valid");
    expect(res.status).toBe(400);

    const entries = journal.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].service).toBe("vector");
    expect(entries[0].response.status).toBe(400);
  });

  test("standalone unknown path journals the 404", async () => {
    vector = new VectorMock();
    const journal = new Journal();
    vector.setJournal(journal);
    const url = await vector.start();

    const res = await rawRequest(url, "/no-such-path", "GET");
    expect(res.status).toBe(404);

    const entries = journal.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].service).toBe("vector");
    expect(entries[0].response.status).toBe(404);
  });

  test("mountable malformed JSON journals the 400", async () => {
    vector = new VectorMock();
    vector.addCollection("default", { dimension: 3 });

    const llm = new LLMock();
    llm.mount("/vector", vector);
    await llm.start();
    try {
      const res = await rawRequest(llm.url, "/vector/query", "POST", "{not valid");
      expect(res.status).toBe(400);

      // Mounted services share the server journal (server re-points the
      // mount's journal on start), so assert there.
      const entries = llm
        .getRequests()
        .filter((e) => e.service === "vector" && e.response.status === 400);
      expect(entries).toHaveLength(1);
    } finally {
      await llm.stop();
    }
  });

  test("mountable unknown path journals the 404, matching standalone", async () => {
    vector = new VectorMock();
    vector.addCollection("default", { dimension: 3 });

    const llm = new LLMock();
    llm.mount("/vector", vector);
    await llm.start();
    try {
      const res = await rawRequest(llm.url, "/vector/no-such-path", "GET");
      expect(res.status).toBe(404);

      const entries = llm
        .getRequests()
        .filter((e) => e.service === "vector" && e.response.status === 404);
      expect(entries).toHaveLength(1);
      expect(entries[0].path).toBe("/vector/no-such-path");
    } finally {
      await llm.stop();
    }
  });

  test("mounted: a declined path the parent serves is not journaled as a vector 404", async () => {
    // The wrapper declines /api/tags, but the parent server owns that route
    // and answers 200. The mounted-404 finish hook must stay silent, or the
    // journal grows a phantom `vector ... 404` entry for a 200 response.
    vector = new VectorMock();
    vector.addCollection("default", { dimension: 3 });

    const llm = new LLMock();
    llm.mount("/api", vector);
    await llm.start();
    try {
      const res = await rawRequest(llm.url, "/api/tags", "GET");
      expect(res.status).toBe(200);

      // The finish hook, if it fires, runs after the response is flushed.
      await new Promise((resolve) => setTimeout(resolve, 50));

      const vectorEntries = llm.getRequests().filter((e) => e.service === "vector");
      expect(vectorEntries).toEqual([]);
    } finally {
      await llm.stop();
    }
  });
});

describe("a2a wrapper journal coverage", () => {
  let a2a: A2AMock | null = null;

  afterEach(async () => {
    await a2a?.stop().catch(() => {});
    a2a = null;
  });

  test("agent-card fetch is journaled", async () => {
    a2a = new A2AMock();
    a2a.registerAgent({ name: "card-agent" });
    const journal = new Journal();
    a2a.setJournal(journal);
    const url = await a2a.start();

    const res = await rawRequest(url, "/.well-known/agent-card.json", "GET");
    expect(res.status).toBe(200);

    const entries = journal.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].service).toBe("a2a");
    expect(entries[0].response.status).toBe(200);
  });

  test("JSON-RPC parse error is journaled", async () => {
    a2a = new A2AMock();
    a2a.registerAgent({ name: "parse-agent" });
    const journal = new Journal();
    a2a.setJournal(journal);
    const url = await a2a.start();

    const res = await rawRequest(url, "/", "POST", "{not valid");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).error.code).toBe(-32700);

    const entries = journal.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].service).toBe("a2a");
    expect(entries[0].response.status).toBe(200);
  });

  test("unmatched streaming message is journaled", async () => {
    a2a = new A2AMock();
    a2a.registerAgent({ name: "stream-agent" });
    const journal = new Journal();
    a2a.setJournal(journal);
    const url = await a2a.start();

    const res = await rawRequest(
      url,
      "/",
      "POST",
      JSON.stringify({
        jsonrpc: "2.0",
        method: "SendStreamingMessage",
        params: { message: { parts: [{ text: "nothing matches this" }] } },
        id: 1,
      }),
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).error.code).toBe(-32000);

    const entries = journal.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].service).toBe("a2a");
    expect(entries[0].response.status).toBe(200);
  });

  test("standalone handler fault journals the 500", async () => {
    a2a = new A2AMock();
    a2a.registerAgent({ name: "fault-agent" });
    const journal = new Journal();
    a2a.setJournal(journal);
    // Fault injection: the standalone catch only runs when handleRequest
    // throws, which the validated paths never do.
    vi.spyOn(a2a, "handleRequest").mockRejectedValueOnce(new Error("boom"));
    const url = await a2a.start();

    const res = await rawRequest(url, "/", "POST", JSON.stringify({ jsonrpc: "2.0" }));
    expect(res.status).toBe(500);

    const entries = journal.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].service).toBe("a2a");
    expect(entries[0].response.status).toBe(500);
  });

  test("entries record req.url, so the journal path/testId filters select them", async () => {
    a2a = new A2AMock();
    a2a.registerAgent({ name: "filter-agent" });

    const llm = new LLMock();
    llm.mount("/a2a", a2a);
    await llm.start();
    try {
      const card = await rawRequest(llm.url, "/a2a/.well-known/agent-card.json?testId=t441", "GET");
      expect(card.status).toBe(200);
      const parse = await rawRequest(llm.url, "/a2a/?testId=t441", "POST", "{not valid");
      expect(parse.status).toBe(200);

      // One entry per request, and each carries the mount prefix + query string.
      expect(llm.getRequests()).toHaveLength(2);
      expect(llm.getRequests().map((e) => e.path)).toEqual([
        "/a2a/.well-known/agent-card.json?testId=t441",
        "/a2a/?testId=t441",
      ]);

      const byPath = await rawRequest(llm.url, "/__aimock/journal?path=/a2a", "GET");
      expect(byPath.headers["x-total-count"]).toBe("2");
      expect(JSON.parse(byPath.body)).toHaveLength(2);

      const byTestId = await rawRequest(llm.url, "/__aimock/journal?testId=t441", "GET");
      expect(byTestId.headers["x-total-count"]).toBe("2");
      expect(JSON.parse(byTestId.body)).toHaveLength(2);
    } finally {
      await llm.stop();
    }
  });
});

describe("mcp/agui standalone 500 journal coverage", () => {
  test("mcp handler fault journals the 500", async () => {
    const mcp = new MCPMock();
    const journal = new Journal();
    mcp.setJournal(journal);
    // Fault injection: the standalone catch only runs when the inner
    // handler rejects, which well-formed dispatch never does.
    (
      mcp as unknown as {
        requestHandler: (req: unknown, res: unknown, body: string) => Promise<void>;
      }
    ).requestHandler = async () => {
      throw new Error("boom");
    };
    const url = await mcp.start();
    try {
      const res = await rawRequest(url, "/", "POST", JSON.stringify({ jsonrpc: "2.0" }));
      expect(res.status).toBe(500);

      const entries = journal.getAll();
      expect(entries).toHaveLength(1);
      expect(entries[0].service).toBe("mcp");
      expect(entries[0].response.status).toBe(500);
    } finally {
      await mcp.stop();
    }
  });

  test("agui handler fault journals the 500", async () => {
    const agui = new AGUIMock();
    const journal = new Journal();
    agui.setJournal(journal);
    // Fault injection: the standalone catch only runs when handleRequest
    // throws, which the validated paths never do.
    vi.spyOn(agui, "handleRequest").mockRejectedValueOnce(new Error("boom"));
    const url = await agui.start();
    try {
      const res = await rawRequest(url, "/", "POST", JSON.stringify({}));
      expect(res.status).toBe(500);

      const entries = journal.getAll();
      expect(entries).toHaveLength(1);
      expect(entries[0].service).toBe("agui");
      expect(entries[0].response.status).toBe(500);
    } finally {
      await agui.stop();
    }
  });

  test("agui standalone unhandled request journals the 404", async () => {
    const agui = new AGUIMock();
    const journal = new Journal();
    agui.setJournal(journal);
    const url = await agui.start();
    try {
      const get = await rawRequest(url, "/", "GET");
      expect(get.status).toBe(404);
      const other = await rawRequest(url, "/other", "POST", JSON.stringify({}));
      expect(other.status).toBe(404);

      const entries = journal.getAll();
      expect(entries).toHaveLength(2);
      expect(entries.map((e) => e.response.status)).toEqual([404, 404]);
      expect(entries.map((e) => e.service)).toEqual(["agui", "agui"]);
    } finally {
      await agui.stop();
    }
  });
});
