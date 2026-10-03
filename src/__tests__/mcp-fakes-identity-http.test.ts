import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { resolveMcpIdentity } from "../helpers.js";

/**
 * resolveMcpIdentity over a real `node:http` server. Header objects built by
 * hand cannot show how Node parses a request: it joins a repeated
 * `X-Test-Id` into one `"a, b"` string and trims a header value, so these
 * cases send real requests through `http.request`.
 */

let server: http.Server;
let port: number;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(resolveMcpIdentity(req)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Send one request; an array header value goes out as one header line per element. */
function send(
  headers: Record<string, string | string[]>,
  path = "/mcp",
): Promise<ReturnType<typeof resolveMcpIdentity>> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "POST", headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve(JSON.parse(body)));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

describe("resolveMcpIdentity over HTTP: a repeated header is a duplicate", () => {
  it.each([
    ["x-test-id", "testId", "X-Test-Id header", ["a", "b"]],
    ["x-aimock-context", "context", "X-AIMock-Context header", ["c1", "c2"]],
    ["x-aimock-mcp-undeclared", "undeclared", "X-AIMock-MCP-Undeclared header", ["deny", "deny"]],
  ] as const)("two %s headers give MCP_DUPLICATE_IDENTITY", async (name, field, label, values) => {
    expect(await send({ [name]: [...values] })).toEqual({
      ok: false,
      error: {
        code: "MCP_DUPLICATE_IDENTITY",
        status: 400,
        field,
        source: "header",
        count: 2,
        message: `Duplicate ${label}: 2 values sent, expected one`,
      },
    });
  });

  it("an empty repeat still counts: three X-Test-Id lines, one empty", async () => {
    const r = await send({ "x-test-id": ["a", "", "b"] });
    expect(r).toMatchObject({ ok: false, error: { code: "MCP_DUPLICATE_IDENTITY", count: 3 } });
  });

  it("a repeated header is rejected even when the query also carries the field", async () => {
    const r = await send({ "x-test-id": ["a", "b"] }, "/mcp?testId=q");
    expect(r).toMatchObject({
      ok: false,
      error: { code: "MCP_DUPLICATE_IDENTITY", field: "testId", source: "header" },
    });
  });

  it("one header line that contains a comma is one value", async () => {
    const r = await send({ "x-test-id": "a, b" });
    expect(r).toMatchObject({ ok: true, identity: { testId: "a, b" } });
  });

  it("a repeated query name is a duplicate on the query path", async () => {
    const r = await send({}, "/mcp?testId=a&testId=b");
    expect(r).toMatchObject({
      ok: false,
      error: { code: "MCP_DUPLICATE_IDENTITY", field: "testId", source: "query", count: 2 },
    });
  });
});

describe("resolveMcpIdentity over HTTP: header and query values", () => {
  it("an undecodable query value next to the header is not silent: fellBack is set", async () => {
    const r = await send(
      { "x-test-id": "h", "x-aimock-context": "hc" },
      "/mcp?testId=%zz&context=50%",
    );
    expect(r).toMatchObject({
      ok: true,
      identity: { testId: "h", context: "hc" },
      fellBack: { testId: true, context: true },
    });
  });

  it("a path built with URL.searchParams resolves to the id itself (a space sent as `+`)", async () => {
    const url = new URL("http://localhost/mcp");
    url.searchParams.set("testId", "a.spec.ts › log in");
    expect(url.search).toContain("+");
    const r = await send({}, `${url.pathname}${url.search}`);
    expect(r).toMatchObject({ ok: true, identity: { testId: "a.spec.ts › log in" } });
  });

  it("the header wins over a differing query value, with no error", async () => {
    const r = await send(
      { "x-test-id": "h", "x-aimock-context": "hc" },
      "/mcp?testId=q&context=qc",
    );
    expect(r).toMatchObject({ ok: true, identity: { testId: "h", context: "hc" } });
  });

  it("a valid undeclared header with an invalid ?undeclared= is MCP_INVALID_UNDECLARED", async () => {
    expect(await send({ "x-aimock-mcp-undeclared": "allow" }, "/mcp?undeclared=denied")).toEqual({
      ok: false,
      error: {
        code: "MCP_INVALID_UNDECLARED",
        status: 400,
        field: "undeclared",
        source: "query",
        raw: "denied",
        message: 'Invalid ?undeclared= query parameter value "denied": expected allow or deny',
      },
    });
  });

  it("an invalid undeclared header with a valid ?undeclared= reports the header", async () => {
    const r = await send({ "x-aimock-mcp-undeclared": "maybe" }, "/mcp?undeclared=deny");
    expect(r).toMatchObject({
      ok: false,
      error: { code: "MCP_INVALID_UNDECLARED", source: "header", raw: "maybe" },
    });
  });

  it("a valid undeclared header with a differing valid ?undeclared= uses the header", async () => {
    const r = await send({ "x-aimock-mcp-undeclared": "allow" }, "/mcp?undeclared=deny");
    expect(r).toMatchObject({ ok: true, identity: { undeclared: "allow" } });
  });
});

describe("resolveMcpIdentity over HTTP: blank values", () => {
  it("a whitespace-only header arrives empty (Node trims it) and falls through", async () => {
    const r = await send(
      { "x-test-id": "   ", "x-aimock-context": "\t", "x-aimock-mcp-undeclared": "  " },
      "/mcp?testId=q&context=qc&undeclared=deny",
    );
    expect(r).toMatchObject({
      ok: true,
      identity: { testId: "q", context: "qc", undeclared: "deny" },
      supplied: { testId: true, context: true, undeclared: true },
    });
  });

  it("an empty query value is not supplied for any field", async () => {
    const r = await send({}, "/mcp?testId=&context=&undeclared=");
    expect(r).toMatchObject({
      ok: true,
      identity: { testId: null, context: null, undeclared: null },
      supplied: { testId: false, context: false, undeclared: false },
    });
  });

  it("a whitespace-only query value is an id for testId / context (exact match), not for undeclared", async () => {
    const r = await send({}, "/mcp?testId=%20&context=%20%20&undeclared=%20");
    expect(r).toMatchObject({
      ok: true,
      identity: { testId: " ", context: "  ", undeclared: null },
      supplied: { testId: true, context: true, undeclared: false },
    });
  });
});
