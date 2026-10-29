import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import * as http from "node:http";
import { Worker } from "node:worker_threads";
import { LLMock, MCPMock, DEFAULT_TEST_ID } from "../index.js";
import type { Mountable, RequestExpectation, RequestExpectationResult } from "../index.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function send(
  mock: LLMock,
  path: string,
  testId?: string,
  body?: object,
  method = "POST",
  headers: Record<string, string | string[]> = {},
) {
  const promise = new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = http.request(
      new URL(path, mock.url),
      {
        method,
        agent: false,
        headers: {
          ...headers,
          ...(testId === undefined ? {} : { "X-Test-Id": testId }),
          "Content-Type": "application/json",
        },
      },
      (response) => {
        let text = "";
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("error", reject);
        response.on("end", () => resolve({ status: response.statusCode!, body: text }));
      },
    );
    request.on("error", reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
  void promise.catch(() => {});
  return promise;
}

class Gate {
  constructor(
    readonly response: http.ServerResponse,
    private readonly done: () => void,
  ) {}

  chunk() {
    this.response.writeHead(200, { "Content-Type": "text/event-stream" });
    this.response.write("data: first\n\n");
  }

  async finish(status = 200) {
    const sent = deferred<void>();
    this.response.once("finish", () => sent.resolve());
    if (!this.response.headersSent) this.response.statusCode = status;
    this.response.end("done");
    this.done();
    await sent.promise;
  }

  async abort() {
    const closed = deferred<void>();
    this.response.once("close", () => closed.resolve());
    this.response.destroy();
    this.done();
    await closed.promise;
  }
}

class ControlledMount implements Mountable {
  private gates: Gate[] = [];
  private waiters: Array<(gate: Gate) => void> = [];
  private active = new Set<http.ServerResponse>();

  async handleRequest(_request: http.IncomingMessage, response: http.ServerResponse) {
    const done = deferred<void>();
    this.active.add(response);
    response.once("close", () => {
      this.active.delete(response);
      done.resolve();
    });
    const gate = new Gate(response, () => done.resolve());
    const waiter = this.waiters.shift();
    if (waiter) waiter(gate);
    else this.gates.push(gate);
    await done.promise;
    return true;
  }

  next(): Promise<Gate> {
    const gate = this.gates.shift();
    return gate ? Promise.resolve(gate) : new Promise((resolve) => this.waiters.push(resolve));
  }

  close() {
    for (const response of this.active) response.destroy();
  }
}

const running: LLMock[] = [];
const mounts: ControlledMount[] = [];

async function setup(options = {}) {
  const mock = await LLMock.create({ ...options, logLevel: "silent" });
  running.push(mock);
  const control = new ControlledMount();
  mounts.push(control);
  mock.mount("/work", control);
  return { mock, control };
}

afterEach(async () => {
  for (const mount of mounts.splice(0)) mount.close();
  for (const mock of running.splice(0)) {
    try {
      await mock.stop();
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "Server not started") throw error;
    }
  }
});

function rule(id: string, path = `/work/${id}`, count = 1, after?: string[]): RequestExpectation {
  return { id, match: { path }, count, after };
}

function eachRule(
  id: string,
  count: number,
  afterEach: string[],
  after?: string[],
): RequestExpectation {
  return { ...rule(id, `/work/${id}`, count, after), afterEach };
}

async function completeKey(
  mock: LLMock,
  control: ControlledMount,
  id: string,
  key?: string,
  testId = "t",
) {
  const response = send(
    mock,
    `/work/${id}`,
    testId,
    undefined,
    "POST",
    key === undefined ? {} : { "X-Correlation": key },
  );
  await (await control.next()).finish();
  return response;
}

function result(
  id: string,
  changes: Partial<RequestExpectationResult> = {},
): RequestExpectationResult {
  return {
    id,
    expected: 1,
    started: 0,
    completed: 0,
    aborted: 0,
    pending: 0,
    missing: 1,
    excess: 0,
    premature: 0,
    ...changes,
  };
}

async function complete(mock: LLMock, control: ControlledMount, path: string, testId = "t") {
  const response = send(mock, path, testId);
  await (await control.next()).finish();
  return response;
}

describe("HTTP request dependency verification", () => {
  it(
    "makes the promised contracts usable by a TypeScript package consumer",
    { timeout: 90_000 },
    async () => {
      const source = `
      import { LLMock } from "@copilotkit/aimock";
      import type { RequestExpectation, RequestExpectationResult, RequestVerificationResult, RequestVerificationOptions } from "@copilotkit/aimock";
      const plan: RequestExpectation[] = [
        { id: "first", match: { path: "/first", method: "post" }, count: 1 },
        { id: "next", match: { path: /^\\/next/ }, count: 1, after: ["first"], afterEach: ["first"] },
      ];
      export function consume(mock: LLMock): RequestVerificationResult {
        const options: RequestVerificationOptions = { correlationHeader: "X-Correlation", causal: true };
        const chained: LLMock = mock.setRequestExpectations("test", plan, options).resetRequestVerification("test");
        const snapshot: RequestVerificationResult = chained.verifyRequests("test");
        const entries: readonly RequestExpectationResult[] = snapshot.expectations;
        for (const entry of entries) {
          const id: string = entry.id;
          const counts: number[] = [entry.expected, entry.started, entry.completed, entry.aborted,
            entry.pending, entry.missing, entry.excess, entry.premature];
          void id; void counts;
        }
        const ok: boolean = snapshot.ok;
        void ok;
        return snapshot;
      }
    `;
      const diagnostics = await new Promise<string>((resolve, reject) => {
        const worker = new Worker(new URL("./request-types.mjs", import.meta.url), {
          workerData: { source, root: process.cwd() },
        });
        onTestFinished(async () => {
          await worker.terminate();
        });
        let output: string | undefined;
        worker.once("message", (message: string) => {
          output = message;
        });
        worker.once("error", reject);
        worker.once("exit", (code) => {
          if (code !== 0 || typeof output !== "string") {
            reject(new Error(`TypeScript consumer worker exited without a result (code ${code})`));
          } else resolve(output);
        });
      });
      expect(diagnostics).toBe("");
    },
  );

  it("exports a working API and exact non-consuming detached snapshots", async () => {
    const { mock, control } = await setup();
    expect(mock.setRequestExpectations("t", [rule("a")])).toBe(mock);
    expect(mock.verifyRequests("t")).toEqual({ ok: false, expectations: [result("a")] });
    const response = send(mock, "/work/a", "t");
    const gate = await control.next();
    const during = mock.verifyRequests("t");
    expect(during).toEqual({
      ok: false,
      expectations: [result("a", { started: 1, missing: 0, pending: 1 })],
    });
    await gate.finish();
    expect(await response).toEqual({ status: 200, body: "done" });
    const expected = {
      ok: true,
      expectations: [result("a", { started: 1, completed: 1, missing: 0 })],
    };
    expect(mock.verifyRequests("t")).toEqual(expected);
    expect(mock.verifyRequests("t")).toEqual(expected);
    during.expectations[0].started = 999;
    expect(mock.verifyRequests("t")).toEqual(expected);
  });

  it("requires a running server and starts empty after restart", async () => {
    const mock = new LLMock();
    expect(() => mock.setRequestExpectations("t", [])).toThrow();
    expect(() => mock.verifyRequests("t")).toThrow();
    expect(() => mock.resetRequestVerification()).toThrow();
    await mock.start();
    running.push(mock);
    mock.setRequestExpectations("t", [rule("a")]);
    await mock.stop();
    expect(() => mock.verifyRequests("t")).toThrow();
    await mock.start();
    expect(mock.verifyRequests("t")).toEqual({ ok: true, expectations: [] });
  });

  it("counts zero, exact, and one-over independently", async () => {
    const { mock, control } = await setup();
    mock.setRequestExpectations("t", [rule("a", "/work/a", 0), rule("b", "/work/b", 2)]);
    await complete(mock, control, "/work/b");
    expect(mock.verifyRequests("t").expectations[1]).toEqual(
      result("b", { expected: 2, started: 1, completed: 1 }),
    );
    await complete(mock, control, "/work/b");
    expect(mock.verifyRequests("t").ok).toBe(true);
    await complete(mock, control, "/work/b");
    await complete(mock, control, "/work/a");
    expect(mock.verifyRequests("t")).toEqual({
      ok: false,
      expectations: [
        result("a", { expected: 0, started: 1, completed: 1, missing: 0, excess: 1 }),
        result("b", { expected: 2, started: 3, completed: 3, missing: 0, excess: 1 }),
      ],
    });
  });

  it("uses exact original pathnames and case-insensitive methods, ignoring query strings", async () => {
    const { mock, control } = await setup();
    mock.setRequestExpectations("t", [
      { ...rule("a"), match: { path: "/work/a", method: "pOsT" } },
    ]);
    await complete(mock, control, "/work/a-extra");
    const get = send(mock, "/work/a", "t", undefined, "GET");
    await (await control.next()).finish();
    await get;
    expect(mock.verifyRequests("t").expectations[0].started).toBe(0);
    await complete(mock, control, "/work/a?x=1");
    expect(mock.verifyRequests("t").ok).toBe(true);
  });

  it("snapshots declarations and evaluates global and sticky regexes without caller state", async () => {
    const { mock, control } = await setup();
    const pattern = /\/work\/a/gy;
    pattern.lastIndex = 7;
    const input = [{ id: "a", match: { path: pattern }, count: 2, after: [] as string[] }];
    mock.setRequestExpectations("t", input);
    input[0].count = 10;
    input[0].after.push("absent");
    pattern.compile("wrong", "g");
    await complete(mock, control, "/work/a");
    await complete(mock, control, "/work/a");
    expect(mock.verifyRequests("t").ok).toBe(true);
    const unchanged = /\/work\/a/g;
    unchanged.lastIndex = 3;
    mock.setRequestExpectations("t", [{ id: "b", match: { path: unchanged }, count: 2 }]);
    await complete(mock, control, "/work/a");
    await complete(mock, control, "/work/a");
    expect(unchanged.lastIndex).toBe(3);
    expect(mock.verifyRequests("t").ok).toBe(true);
  });

  it("observes overlapping selectors independently without double counting terminal events", async () => {
    const { mock, control } = await setup();
    mock.setRequestExpectations("t", [
      rule("a"),
      { id: "all", match: { path: /^\/work\// }, count: 1 },
    ]);
    await complete(mock, control, "/work/a");
    expect(mock.verifyRequests("t")).toEqual({
      ok: true,
      expectations: [
        result("a", { started: 1, completed: 1, missing: 0 }),
        result("all", { started: 1, completed: 1, missing: 0 }),
      ],
    });
  });

  it("preserves regex flags while matching each original pathname from index zero", async () => {
    const { mock, control } = await setup();
    mock.setRequestExpectations("t", [
      { id: "flagged", match: { path: /\/work\/flag/iy }, count: 1 },
    ]);
    await complete(mock, control, "/work/FLAG");
    expect(mock.verifyRequests("t")).toEqual({
      ok: true,
      expectations: [result("flagged", { started: 1, completed: 1, missing: 0 })],
    });
    await complete(mock, control, "/work/prefix/work/flag");
    expect(mock.verifyRequests("t").expectations[0]).toEqual(
      result("flagged", { started: 1, completed: 1, missing: 0 }),
    );
  });

  it("requires completed prerequisite counts at arrival and never repairs a premature request", async () => {
    const { mock, control } = await setup();
    mock.setRequestExpectations("t", [rule("b", "/work/b", 2, ["a"]), rule("a", "/work/a", 2)]);
    await complete(mock, control, "/work/a");
    const pending = send(mock, "/work/a", "t");
    const gate = await control.next();
    await complete(mock, control, "/work/b");
    expect(mock.verifyRequests("t").expectations[0].premature).toBe(1);
    await gate.finish();
    await pending;
    await complete(mock, control, "/work/b");
    expect(mock.verifyRequests("t")).toEqual({
      ok: false,
      expectations: [
        result("b", { expected: 2, started: 2, completed: 2, missing: 0, premature: 1 }),
        result("a", { expected: 2, started: 2, completed: 2, missing: 0 }),
      ],
    });
  });

  it.each([false, true])(
    "allows independent branches to complete in either order (%s)",
    async (reverse) => {
      const { mock, control } = await setup();
      mock.setRequestExpectations("t", [
        rule("end", "/work/end", 1, ["a", "b", "a"]),
        rule("a"),
        rule("b"),
      ]);
      const a = send(mock, "/work/a", "t");
      const ga = await control.next();
      const b = send(mock, "/work/b", "t");
      const gb = await control.next();
      for (const gate of reverse ? [gb, ga] : [ga, gb]) await gate.finish();
      await Promise.all([a, b]);
      await complete(mock, control, "/work/end");
      expect(mock.verifyRequests("t").ok).toBe(true);
    },
  );

  it("requires all branches but not an order between them", async () => {
    const { mock, control } = await setup();
    mock.setRequestExpectations("t", [
      rule("a"),
      rule("b"),
      rule("end", "/work/end", 1, ["a", "b"]),
    ]);
    await complete(mock, control, "/work/a");
    await complete(mock, control, "/work/end");
    await complete(mock, control, "/work/b");
    expect(mock.verifyRequests("t").expectations[2].premature).toBe(1);
    expect(mock.verifyRequests("t").ok).toBe(false);
  });

  it("counts one premature arrival even when several prerequisites are incomplete", async () => {
    const { mock, control } = await setup();
    mock.setRequestExpectations("t", [
      rule("a"),
      rule("b"),
      rule("end", "/work/end", 2, ["a", "b", "a"]),
    ]);
    await complete(mock, control, "/work/end");
    expect(mock.verifyRequests("t").expectations[2]).toEqual(
      result("end", { expected: 2, started: 1, completed: 1, missing: 1, premature: 1 }),
    );
    await complete(mock, control, "/work/a");
    await complete(mock, control, "/work/b");
    await complete(mock, control, "/work/end");
    expect(mock.verifyRequests("t").expectations[2]).toEqual(
      result("end", { expected: 2, started: 2, completed: 2, missing: 0, premature: 1 }),
    );
  });

  it("does not treat headers or streaming chunks as completion", async () => {
    const { mock, control } = await setup();
    mock.setRequestExpectations("t", [rule("a"), rule("b", "/work/b", 1, ["a"])]);
    const stream = send(mock, "/work/a", "t");
    const gate = await control.next();
    gate.chunk();
    await complete(mock, control, "/work/b");
    expect(mock.verifyRequests("t").expectations[0].pending).toBe(1);
    await gate.finish();
    expect((await stream).body).toContain("data: first");
    expect(mock.verifyRequests("t").expectations[1].premature).toBe(1);
  });

  it("counts aborts separately and never uses them as prerequisite completions", async () => {
    const { mock, control } = await setup();
    mock.setRequestExpectations("t", [rule("a"), rule("b", "/work/b", 1, ["a"])]);
    const stream = send(mock, "/work/a", "t");
    const gate = await control.next();
    gate.chunk();
    await gate.abort();
    await expect(stream).rejects.toThrow();
    await complete(mock, control, "/work/b");
    expect(mock.verifyRequests("t")).toEqual({
      ok: false,
      expectations: [
        result("a", { started: 1, missing: 0, aborted: 1 }),
        result("b", { started: 1, completed: 1, missing: 0, premature: 1 }),
      ],
    });
  });

  it("treats a normally finished HTTP error as completion and zero prerequisites as satisfied", async () => {
    const { mock, control } = await setup();
    mock.setRequestExpectations("t", [
      rule("zero", "/work/never", 0),
      rule("a", "/work/a", 1, ["zero"]),
      rule("b", "/work/b", 1, ["a"]),
    ]);
    const response = send(mock, "/work/a", "t");
    await (await control.next()).finish(503);
    expect((await response).status).toBe(503);
    await complete(mock, control, "/work/b");
    expect(mock.verifyRequests("t").ok).toBe(true);
  });

  it("isolates header, query, default, and exact test IDs", async () => {
    const { mock, control } = await setup();
    for (const id of ["header", "query", "Header", DEFAULT_TEST_ID])
      mock.setRequestExpectations(id, [rule("a")]);
    await complete(mock, control, "/work/a?testId=query", "header");
    expect(mock.verifyRequests("header").ok).toBe(true);
    expect(mock.verifyRequests("query").expectations[0].started).toBe(0);
    const query = send(mock, "/work/a?testId=query");
    await (await control.next()).finish();
    await query;
    const ordinary = send(mock, "/work/a");
    await (await control.next()).finish();
    await ordinary;
    expect(mock.verifyRequests("query").ok).toBe(true);
    expect(mock.verifyRequests(DEFAULT_TEST_ID).ok).toBe(true);
    expect(mock.verifyRequests("Header").expectations[0].started).toBe(0);
  });

  it("does not share observations between server instances", async () => {
    const first = await setup();
    const second = await setup();
    for (const { mock } of [first, second]) mock.setRequestExpectations("t", [rule("a")]);
    await complete(first.mock, first.control, "/work/a");
    expect(first.mock.verifyRequests("t").ok).toBe(true);
    expect(second.mock.verifyRequests("t").expectations[0].started).toBe(0);
    first.mock.resetRequestVerification();
    await complete(second.mock, second.control, "/work/a");
    expect(second.mock.verifyRequests("t").ok).toBe(true);
  });

  it.each(["reset", "replace"])("ignores old in-flight completions after %s", async (action) => {
    const { mock, control } = await setup();
    mock.setRequestExpectations("t", [rule("a")]);
    const old = send(mock, "/work/a", "t");
    const gate = await control.next();
    if (action === "reset") expect(mock.resetRequestVerification("t")).toBe(mock);
    else mock.setRequestExpectations("t", [rule("a")]);
    await gate.finish();
    await old;
    expect(mock.verifyRequests("t")).toEqual({ ok: false, expectations: [result("a")] });
    await complete(mock, control, "/work/a");
    expect(mock.verifyRequests("t").ok).toBe(true);
  });

  it("resets one scope or all scopes without removing declarations", async () => {
    const { mock, control } = await setup();
    for (const id of ["a", "b"]) {
      mock.setRequestExpectations(id, [rule("a")]);
      await complete(mock, control, "/work/a", id);
    }
    mock.resetRequestVerification("a");
    expect(mock.verifyRequests("a").expectations[0].started).toBe(0);
    expect(mock.verifyRequests("b").ok).toBe(true);
    mock.resetRequestVerification();
    expect(mock.verifyRequests("b").expectations[0].started).toBe(0);
  });

  it.each(["api", "http", "alias"])(
    "full reset removes plans and ignores old work (%s)",
    async (via) => {
      const { mock, control } = await setup();
      mock.setRequestExpectations("t", [rule("a")]);
      const old = send(mock, "/work/a", "t");
      const gate = await control.next();
      if (via === "api") mock.reset();
      else await send(mock, via === "http" ? "/__aimock/reset" : "/__aimock/reset/fixtures");
      expect(mock.verifyRequests("t")).toEqual({ ok: true, expectations: [] });
      mock.setRequestExpectations("t", [rule("a")]);
      await gate.finish();
      await old;
      expect(mock.verifyRequests("t").expectations[0].started).toBe(0);
    },
  );

  it("does not reuse old plans after stop completes and restart", async () => {
    const { mock, control } = await setup();
    mock.setRequestExpectations("t", [rule("a")]);
    const response = send(mock, "/work/a", "t");
    const gate = await control.next();
    const stopped = mock.stop();
    await gate.finish();
    await response;
    await stopped;
    await mock.start();
    expect(mock.verifyRequests("t")).toEqual({ ok: true, expectations: [] });
  });

  it("preserves verification across journal clears and eviction", async () => {
    const { mock } = await setup({ journalMaxEntries: 1 });
    mock.setRequestExpectations("t", [{ id: "all", match: { path: /^\/not-found\// }, count: 3 }]);
    await send(mock, "/not-found/a", "t");
    mock.clearRequests();
    await send(mock, "/not-found/b", "t");
    await send(mock, "/__aimock/reset/journal", "t");
    await send(mock, "/not-found/c", "t");
    expect(mock.verifyRequests("t").ok).toBe(true);
  });

  it("excludes probes and management requests while counting unhandled application paths", async () => {
    const { mock } = await setup();
    mock.setRequestExpectations("t", [{ id: "all", match: { path: /.*/ }, count: 4 }]);
    for (const path of ["/health", "/ready", "/metrics", "/__aimock/journal", "/__aimock-other"])
      await send(mock, path, "t", undefined, "GET");
    expect(mock.verifyRequests("t").expectations[0].started).toBe(0);
    for (const path of ["/healthcheck", "/ready/jobs", "/metrics-data"])
      await send(mock, path, "t", undefined, "GET");
    expect((await send(mock, "/not-found", "t")).status).toBe(404);
    expect(mock.verifyRequests("t")).toEqual({
      ok: true,
      expectations: [result("all", { expected: 4, started: 4, completed: 4, missing: 0 })],
    });
  });

  it("does not admit a supported WebSocket upgrade into the HTTP plan", async () => {
    const { mock } = await setup();
    mock.setRequestExpectations("t", [{ id: "all", match: { path: /.*/ }, count: 0 }]);
    await new Promise<void>((resolve, reject) => {
      const request = http.request(new URL("/v1/responses", mock.url), {
        headers: {
          "X-Test-Id": "t",
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        },
      });
      request.on("error", reject);
      request.on("response", (response) => {
        response.resume();
        reject(new Error(`Expected upgrade, received HTTP ${response.statusCode}`));
      });
      request.on("upgrade", (response, socket) => {
        socket.destroy();
        if (response.statusCode === 101) resolve();
        else reject(new Error(`Unexpected upgrade status ${response.statusCode}`));
      });
      request.end();
    });
    expect(mock.verifyRequests("t")).toEqual({
      ok: true,
      expectations: [result("all", { expected: 0, missing: 0 })],
    });
  });

  it.each([false, true])(
    "observes native chat paths before compatibility rewriting (stream=%s)",
    async (stream) => {
      const { mock } = await setup();
      mock.onMessage("hello", { content: "world" });
      mock.setRequestExpectations("t", [rule("chat", "/provider/v1/chat/completions")]);
      const response = await send(mock, "/provider/v1/chat/completions", "t", {
        model: "gpt-4",
        messages: [{ role: "user", content: "hello" }],
        stream,
      });
      expect(response.status).toBe(200);
      expect(response.body).toContain("world");
      expect(mock.verifyRequests("t").ok).toBe(true);
      expect(mock.getRequests()).toHaveLength(1);
    },
  );

  it("composes native model requests with mounted MCP", async () => {
    const { mock } = await setup();
    const mcp = new MCPMock();
    mcp.onToolCall("lookup", () => "found");
    mock.mount("/mcp", mcp);
    mock.onMessage("hello", { content: "world" });
    const initialized = await fetch(mock.url + "/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }),
    });
    expect(initialized.status).toBe(200);
    await initialized.json();
    const sessionId = initialized.headers.get("mcp-session-id")!;
    const notification = await send(
      mock,
      "/mcp",
      undefined,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      "POST",
      { "Mcp-Session-Id": sessionId },
    );
    expect(notification.status).toBe(202);
    mock.setRequestExpectations("t", [
      rule("tools", "/mcp", 1),
      rule("chat", "/v1/chat/completions", 1, ["tools"]),
    ]);
    const tools = await send(
      mock,
      "/mcp",
      "t",
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "lookup", arguments: {} },
      },
      "POST",
      { "Mcp-Session-Id": sessionId },
    );
    expect(tools.status, tools.body).toBe(200);
    expect(tools.body).toContain("found");
    await send(mock, "/v1/chat/completions", "t", {
      model: "gpt-4",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    });
    expect(mock.verifyRequests("t").ok).toBe(true);
  });

  it("empty and unknown plans are vacuously satisfied and replacement discards prior counts", async () => {
    const { mock, control } = await setup();
    expect(mock.verifyRequests("none")).toEqual({ ok: true, expectations: [] });
    mock.setRequestExpectations("other", [rule("b", "/work/b", 2)]);
    mock.setRequestExpectations("t", [rule("a")]);
    await complete(mock, control, "/work/b", "other");
    await complete(mock, control, "/work/a");
    const otherBefore = mock.verifyRequests("other");
    expect(otherBefore.expectations).toEqual([
      result("b", { expected: 2, started: 1, completed: 1, missing: 1 }),
    ]);
    mock.setRequestExpectations("t", []);
    expect(mock.verifyRequests("t")).toEqual({ ok: true, expectations: [] });
    expect(mock.verifyRequests("other")).toEqual(otherBefore);
    mock.setRequestExpectations("t", [rule("replacement")]);
    expect(mock.verifyRequests("other")).toEqual(otherBefore);
    await complete(mock, control, "/work/b", "other");
    expect(mock.verifyRequests("other").ok).toBe(true);
  });

  it("counts one HTTP request for a mounted handler's batch payload", async () => {
    const { mock, control } = await setup();
    mock.setRequestExpectations("t", [rule("a")]);
    const response = send(mock, "/work/a", "t", [{ id: 1 }, { id: 2 }]);
    await (await control.next()).finish();
    await response;
    expect(mock.verifyRequests("t").ok).toBe(true);
  });

  it("observes arrival before an asynchronous request body is available", async () => {
    const { mock } = await setup();
    const arrived = deferred<void>();
    mock.mount("/body", {
      async handleRequest(request, response) {
        arrived.resolve();
        for await (const chunk of request) void chunk;
        response.end("done");
        return true;
      },
    });
    mock.setRequestExpectations("t", [rule("body", "/body")]);
    const received = deferred<void>();
    const request = http.request(
      new URL("/body", mock.url),
      {
        method: "POST",
        agent: false,
        headers: { "X-Test-Id": "t", "Content-Length": "2" },
      },
      (response) => {
        response.resume();
        response.once("end", () => received.resolve());
      },
    );
    request.flushHeaders();
    try {
      await arrived.promise;
      expect(mock.verifyRequests("t").expectations[0]).toEqual(
        result("body", {
          started: 1,
          missing: 0,
          pending: 1,
        }),
      );
      request.end("{}");
      await received.promise;
      expect(mock.verifyRequests("t").ok).toBe(true);
    } finally {
      request.destroy();
    }
  });

  it("settles a client-aborted response without counting a completion", async () => {
    const { mock, control } = await setup();
    mock.setRequestExpectations("t", [rule("a")]);
    const firstChunk = deferred<http.IncomingMessage>();
    const request = http.request(
      new URL("/work/a", mock.url),
      {
        method: "POST",
        agent: false,
        headers: { "X-Test-Id": "t" },
      },
      (response) => {
        response.on("error", () => {});
        response.once("data", () => firstChunk.resolve(response));
      },
    );
    request.on("error", () => {});
    request.end();
    const gate = await control.next();
    gate.chunk();
    const response = await firstChunk.promise;
    const closed = deferred<void>();
    gate.response.once("close", () => closed.resolve());
    response.destroy();
    request.destroy();
    await closed.promise;
    expect(mock.verifyRequests("t").expectations[0]).toEqual(
      result("a", {
        started: 1,
        missing: 0,
        aborted: 1,
      }),
    );
  });

  it("does not retroactively observe traffic sent before registration", async () => {
    const { mock, control } = await setup();
    await complete(mock, control, "/work/a");
    mock.setRequestExpectations("t", [rule("a")]);
    expect(mock.verifyRequests("t").expectations[0]).toEqual(result("a"));
  });

  it("allows a pipeline to advance before the predecessor's entire batch has completed", async () => {
    const { mock, control } = await setup();
    const dependencies = ["a", "a"];
    mock.setRequestExpectations("t", [
      eachRule("b", 2, dependencies),
      rule("a", "/work/a", 2),
      rule("c"),
    ]);
    dependencies.push("c");
    for (let i = 0; i < 2; i++) {
      await completeKey(mock, control, "a");
      await completeKey(mock, control, "b");
      expect(mock.verifyRequests("t").expectations[0].premature).toBe(0);
    }
    await completeKey(mock, control, "c");
    expect(mock.verifyRequests("t").ok).toBe(true);
  });

  it("reserves each allowance while pending and refunds it only on abort", async () => {
    const { mock, control } = await setup();
    mock.setRequestExpectations("t", [rule("a"), eachRule("b", 3, ["a"])]);
    await completeKey(mock, control, "a");
    const first = send(mock, "/work/b", "t");
    const gate = await control.next();
    await completeKey(mock, control, "b");
    expect(mock.verifyRequests("t").expectations[1].premature).toBe(1);
    await gate.abort();
    await expect(first).rejects.toThrow();
    await completeKey(mock, control, "b");
    expect(mock.verifyRequests("t").expectations[1]).toEqual(
      result("b", { expected: 3, started: 3, completed: 2, aborted: 1, missing: 0, premature: 1 }),
    );
    await completeKey(mock, control, "b");
    expect(mock.verifyRequests("t").expectations[1].premature).toBe(2);
  });

  it("keeps completed batch barriers satisfied after excess completions and allowance spending", async () => {
    const { mock, control } = await setup();
    mock.setRequestExpectations("t", [rule("a", "/work/a", 2), eachRule("b", 4, ["a"], ["a"])]);
    for (let i = 0; i < 3; i++) await completeKey(mock, control, "a");
    for (let i = 1; i <= 3; i++) {
      await completeKey(mock, control, "b");
      expect(mock.verifyRequests("t").expectations[1]).toEqual(
        result("b", { expected: 4, started: i, completed: i, missing: 4 - i }),
      );
    }
    await completeKey(mock, control, "b");
    expect(mock.verifyRequests("t")).toEqual({
      ok: false,
      expectations: [
        result("a", {
          expected: 2,
          started: 3,
          completed: 3,
          missing: 0,
          excess: 1,
        }),
        result("b", {
          expected: 4,
          started: 4,
          completed: 4,
          missing: 0,
          premature: 1,
        }),
      ],
    });
  });

  it("an aborted premature arrival cannot release another consumer's reservation", async () => {
    const { mock, control } = await setup();
    mock.setRequestExpectations("t", [rule("a"), eachRule("b", 4, ["a"])]);
    await completeKey(mock, control, "a");
    const first = send(mock, "/work/b", "t");
    const firstGate = await control.next();
    const premature = send(mock, "/work/b", "t");
    const prematureGate = await control.next();
    await prematureGate.abort();
    await expect(premature).rejects.toThrow();
    expect(mock.verifyRequests("t").expectations[1]).toEqual(
      result("b", {
        expected: 4,
        started: 2,
        aborted: 1,
        pending: 1,
        missing: 2,
        premature: 1,
      }),
    );
    await completeKey(mock, control, "b");
    expect(mock.verifyRequests("t").expectations[1].premature).toBe(2);
    await firstGate.abort();
    await expect(first).rejects.toThrow();
    await completeKey(mock, control, "b");
    expect(mock.verifyRequests("t").expectations[1]).toEqual(
      result("b", {
        expected: 4,
        started: 4,
        completed: 2,
        aborted: 2,
        missing: 0,
        premature: 2,
      }),
    );
  });

  it.each(["graph", "options"])(
    "invalid replacement leaves live reservations and their later refunds intact (%s)",
    async (invalid) => {
      const { mock, control } = await setup();
      mock.setRequestExpectations("t", [rule("a"), eachRule("b", 3, ["a"])], {
        correlationHeader: "X-Correlation",
      });
      await completeKey(mock, control, "a", "key");
      const pending = send(mock, "/work/b", "t", undefined, "POST", {
        "X-Correlation": "key",
      });
      const gate = await control.next();
      const before = mock.verifyRequests("t");
      expect(() => {
        if (invalid === "graph") mock.setRequestExpectations("t", [eachRule("bad", 1, ["absent"])]);
        else
          mock.setRequestExpectations("t", [], {
            correlationHeader: "bad header",
          });
      }).toThrow();
      expect(mock.verifyRequests("t")).toEqual(before);
      await completeKey(mock, control, "b", "key");
      expect(mock.verifyRequests("t").expectations[1].premature).toBe(1);
      await gate.abort();
      await expect(pending).rejects.toThrow();
      await completeKey(mock, control, "b", "key");
      expect(mock.verifyRequests("t").expectations[1]).toEqual(
        result("b", {
          expected: 3,
          started: 3,
          completed: 2,
          aborted: 1,
          missing: 0,
          premature: 1,
        }),
      );
    },
  );

  it("reserves nothing unless fan-in allowances and whole-batch barriers all hold", async () => {
    const { mock, control } = await setup();
    mock.setRequestExpectations("t", [
      rule("a"),
      rule("b"),
      rule("barrier"),
      eachRule("end", 3, ["a", "b", "a"], ["barrier"]),
    ]);
    await completeKey(mock, control, "a");
    await completeKey(mock, control, "end");
    await completeKey(mock, control, "b");
    await completeKey(mock, control, "end");
    await completeKey(mock, control, "barrier");
    await completeKey(mock, control, "end");
    expect(mock.verifyRequests("t").expectations[3]).toEqual(
      result("end", { expected: 3, started: 3, completed: 3, missing: 0, premature: 2 }),
    );
  });

  it("gives separate downstream branches independent allowances", async () => {
    const { mock, control } = await setup();
    mock.setRequestExpectations("t", [rule("a"), eachRule("b", 2, ["a"]), eachRule("c", 1, ["a"])]);
    await completeKey(mock, control, "a");
    const pending = send(mock, "/work/b", "t");
    const gate = await control.next();
    await completeKey(mock, control, "c");
    await gate.finish();
    await pending;
    await completeKey(mock, control, "b");
    const entries = mock.verifyRequests("t").expectations;
    expect(entries[1].premature).toBe(1);
    expect(entries[2].premature).toBe(0);
  });

  it("refunds every overlapping consumer when their shared HTTP response aborts", async () => {
    const { mock, control } = await setup();
    mock.setRequestExpectations("t", [
      rule("a"),
      { ...eachRule("b", 2, ["a"]), match: { path: "/work/joint" } },
      { ...eachRule("c", 2, ["a"]), match: { path: "/work/joint" } },
    ]);
    await completeKey(mock, control, "a");
    const pending = send(mock, "/work/joint", "t");
    const gate = await control.next();
    await gate.abort();
    await expect(pending).rejects.toThrow();
    await complete(mock, control, "/work/joint");
    expect(mock.verifyRequests("t")).toEqual({
      ok: false,
      expectations: [
        result("a", { started: 1, completed: 1, missing: 0 }),
        result("b", { expected: 2, started: 2, completed: 1, aborted: 1, missing: 0 }),
        result("c", { expected: 2, started: 2, completed: 1, aborted: 1, missing: 0 }),
      ],
    });
  });

  it("refunds every fan-in reservation without releasing another pending consumer's claim", async () => {
    const { mock, control } = await setup();
    mock.setRequestExpectations(
      "t",
      [rule("a", "/work/a", 2), rule("c", "/work/c", 2), eachRule("b", 4, ["a", "c"])],
      { correlationHeader: "X-Correlation" },
    );
    for (let i = 0; i < 2; i++) {
      await completeKey(mock, control, "a", "key");
      await completeKey(mock, control, "c", "key");
    }
    const first = send(mock, "/work/b", "t", undefined, "POST", { "X-Correlation": "key" });
    const firstGate = await control.next();
    const second = send(mock, "/work/b", "t", undefined, "POST", { "X-Correlation": "key" });
    const secondGate = await control.next();
    await firstGate.abort();
    await expect(first).rejects.toThrow();
    await completeKey(mock, control, "b", "key");
    await completeKey(mock, control, "b", "key");
    await secondGate.finish();
    await second;
    expect(mock.verifyRequests("t").expectations[2]).toEqual(
      result("b", {
        expected: 4,
        started: 4,
        completed: 3,
        aborted: 1,
        missing: 0,
        premature: 1,
      }),
    );
  });

  it("never shares correlated allowances across test scopes or server instances", async () => {
    const first = await setup();
    const second = await setup();
    for (const [mock, scope] of [
      [first.mock, "t"],
      [first.mock, "u"],
      [second.mock, "t"],
    ] as const) {
      mock.setRequestExpectations(scope, [rule("a"), eachRule("b", 1, ["a"])], {
        correlationHeader: "X-Correlation",
      });
    }
    await completeKey(first.mock, first.control, "a", "same", "t");
    await completeKey(first.mock, first.control, "b", "same", "u");
    await completeKey(second.mock, second.control, "b", "same", "t");
    await completeKey(first.mock, first.control, "b", "same", "t");
    expect(first.mock.verifyRequests("t").ok).toBe(true);
    expect(first.mock.verifyRequests("u").expectations[1].premature).toBe(1);
    expect(second.mock.verifyRequests("t").expectations[1].premature).toBe(1);
  });

  it("contributes finished premature and excess occurrences but not aborted or streaming ones", async () => {
    const { mock, control } = await setup();
    mock.setRequestExpectations("t", [
      rule("zero", "/work/zero", 0),
      eachRule("a", 0, ["zero"]),
      eachRule("b", 3, ["a"]),
    ]);
    const pending = send(mock, "/work/a", "t");
    const gate = await control.next();
    gate.chunk();
    await completeKey(mock, control, "b");
    await gate.abort();
    await expect(pending).rejects.toThrow();
    await completeKey(mock, control, "b");
    const finished = send(mock, "/work/a", "t");
    await (await control.next()).finish(503);
    expect((await finished).status).toBe(503);
    await completeKey(mock, control, "b");
    const entries = mock.verifyRequests("t").expectations;
    expect(entries[1]).toEqual(
      result("a", {
        expected: 0,
        started: 2,
        completed: 1,
        aborted: 1,
        missing: 0,
        excess: 2,
        premature: 2,
      }),
    );
    expect(entries[2].premature).toBe(2);
  });

  it("isolates allowances by exact header values without partitioning aggregate counts", async () => {
    const { mock, control } = await setup();
    const options = { correlationHeader: "X-CORRELATION" };
    mock.setRequestExpectations("t", [rule("a", "/work/a", 3), eachRule("b", 4, ["a"])], options);
    options.correlationHeader = "different";
    await completeKey(mock, control, "a", "one");
    await completeKey(mock, control, "a", "two");
    await completeKey(mock, control, "b", "ONE");
    expect(mock.verifyRequests("t").expectations[1]).toEqual(
      result("b", { expected: 4, started: 1, completed: 1, missing: 3, premature: 1 }),
    );
    await completeKey(mock, control, "b", "two");
    await completeKey(mock, control, "b", "one");
    await completeKey(mock, control, "a", "ONE");
    await completeKey(mock, control, "b", "ONE");
    const entries = mock.verifyRequests("t").expectations;
    expect(entries[0]).toEqual(result("a", { expected: 3, started: 3, completed: 3, missing: 0 }));
    expect(entries[1]).toEqual(
      result("b", { expected: 4, started: 4, completed: 4, missing: 0, premature: 1 }),
    );
  });

  it.each([
    { name: "truncated values", different: "one", causal: false },
    { name: "changed later value", different: ["one", "other"], causal: false },
    { name: "truncated values", different: "one", causal: true },
    { name: "changed later value", different: ["one", "other"], causal: true },
  ])(
    "preserves repeated correlation values: $name (causal=$causal)",
    async ({ different, causal }) => {
      const { mock, control } = await setup();
      mock.setRequestExpectations("t", [rule("a"), eachRule("b", 2, ["a"])], {
        correlationHeader: "Set-Cookie",
        causal,
      });
      const producer = send(mock, "/work/a", "t", undefined, "POST", {
        "Set-Cookie": ["one", "two"],
      });
      await (await control.next()).finish();
      await producer;

      const mismatch = send(mock, "/work/b", "t", undefined, "POST", { "Set-Cookie": different });
      await (await control.next()).finish();
      await mismatch;
      expect(mock.verifyRequests("t").expectations[1]).toEqual(
        result("b", { expected: 2, started: 1, completed: 1, missing: 1, premature: 1 }),
      );

      const matching = send(mock, "/work/b", "t", undefined, "POST", {
        "Set-Cookie": ["one", "two"],
      });
      await (await control.next()).finish();
      await matching;
      expect(mock.verifyRequests("t")).toEqual({
        ok: false,
        expectations: [
          result("a", { started: 1, completed: 1, missing: 0 }),
          result("b", { expected: 2, started: 2, completed: 2, missing: 0, premature: 1 }),
        ],
      });
    },
  );

  it.each(
    [false, true].flatMap((causal) => [
      { name: "comma-space scalar", producer: ["one", "two"], different: "one, two", causal },
      { name: "comma scalar", producer: ["one", "two"], different: "one,two", causal },
      {
        name: "element boundaries",
        producer: ["one, two", "three"],
        different: ["one", "two, three"],
        causal,
      },
    ]),
  )(
    "preserves exact correlation structure: $name (causal=$causal)",
    async ({ producer, different, causal }) => {
      const { mock, control } = await setup();
      mock.setRequestExpectations("t", [rule("a"), eachRule("b", 2, ["a"])], {
        correlationHeader: "Set-Cookie",
        causal,
      });
      const produced = send(mock, "/work/a", "t", undefined, "POST", { "Set-Cookie": producer });
      await (await control.next()).finish();
      await produced;
      const mismatched = send(mock, "/work/b", "t", undefined, "POST", { "Set-Cookie": different });
      await (await control.next()).finish();
      await mismatched;
      expect(mock.verifyRequests("t").expectations[1]).toEqual(
        result("b", { expected: 2, started: 1, completed: 1, missing: 1, premature: 1 }),
      );
      const matched = send(mock, "/work/b", "t", undefined, "POST", { "Set-Cookie": producer });
      await (await control.next()).finish();
      await matched;
      expect(mock.verifyRequests("t").expectations[1]).toEqual(
        result("b", { expected: 2, started: 2, completed: 2, missing: 0, premature: 1 }),
      );
    },
  );

  it.each(
    [false, true].flatMap((causal) =>
      ["Constructor", "Set-Cookie"].flatMap((header) => [
        { name: "missing then empty", producer: undefined, dependent: "", causal, header },
        { name: "empty then missing", producer: "", dependent: undefined, causal, header },
      ]),
    ),
  )(
    "shares the unkeyed pool for $header: $name (causal=$causal)",
    async ({ producer, dependent, causal, header }) => {
      const { mock, control } = await setup();
      mock.setRequestExpectations("t", [rule("a"), eachRule("b", 1, ["a"])], {
        correlationHeader: header,
        causal,
      });
      for (const [id, value] of [
        ["a", producer],
        ["b", dependent],
      ]) {
        const response = send(
          mock,
          `/work/${id}`,
          "t",
          undefined,
          "POST",
          value === undefined ? {} : { [header]: value },
        );
        await (await control.next()).finish();
        await response;
      }
      expect(mock.verifyRequests("t")).toEqual({
        ok: true,
        expectations: [
          result("a", { started: 1, completed: 1, missing: 0 }),
          result("b", { started: 1, completed: 1, missing: 0 }),
        ],
      });
    },
  );

  it("uses an unkeyed pool for missing and empty headers and for plans without correlation", async () => {
    const { mock, control } = await setup();
    mock.setRequestExpectations("t", [rule("a"), eachRule("b", 1, ["a"])], {
      correlationHeader: "X-Correlation",
    });
    await completeKey(mock, control, "a");
    await completeKey(mock, control, "b", "");
    expect(mock.verifyRequests("t").ok).toBe(true);
    mock.setRequestExpectations("t", [rule("a"), eachRule("b", 1, ["a"])]);
    await completeKey(mock, control, "a", "left");
    await completeKey(mock, control, "b", "right");
    expect(mock.verifyRequests("t").ok).toBe(true);
  });

  it.each([
    { name: "missing on both requests", producer: undefined, dependent: undefined },
    { name: "missing then empty", producer: undefined, dependent: "" },
    { name: "empty then missing", producer: "", dependent: undefined },
    {
      name: "matching values replaced by propagation",
      producer: "shared id",
      dependent: "shared id",
    },
  ])("correlates incoming X-Request-Id values: $name", async ({ producer, dependent }) => {
    const { mock, control } = await setup();
    mock.setRequestExpectations("t", [rule("a"), eachRule("b", 1, ["a"])], {
      correlationHeader: "X-Request-Id",
    });
    for (const [id, value] of [
      ["a", producer],
      ["b", dependent],
    ] as const) {
      const response = send(
        mock,
        `/work/${id}`,
        "t",
        undefined,
        "POST",
        value === undefined ? {} : { "X-Request-Id": value },
      );
      await (await control.next()).finish();
      await response;
    }
    expect(mock.verifyRequests("t")).toEqual({
      ok: true,
      expectations: [
        result("a", { started: 1, completed: 1, missing: 0 }),
        result("b", { started: 1, completed: 1, missing: 0 }),
      ],
    });
  });

  it("keeps whole-batch dependencies global while correlating per-occurrence edges", async () => {
    const { mock, control } = await setup();
    mock.setRequestExpectations("t", [rule("a", "/work/a", 2), eachRule("b", 2, ["a"], ["a"])], {
      correlationHeader: "x-correlation",
    });
    await completeKey(mock, control, "a", "one");
    await completeKey(mock, control, "b", "one");
    await completeKey(mock, control, "a", "two");
    await completeKey(mock, control, "b", "one");
    expect(mock.verifyRequests("t").expectations[1].premature).toBe(1);
  });

  it("captures correlation before a mounted handler can mutate request headers", async () => {
    const { mock, control } = await setup();
    mock.mount("/mutable", {
      async handleRequest(req, res) {
        req.headers["x-correlation"] = "changed";
        res.end("done");
        return true;
      },
    });
    mock.setRequestExpectations("t", [rule("a", "/mutable"), eachRule("b", 1, ["a"])], {
      correlationHeader: "x-correlation",
    });
    await send(mock, "/mutable", "t", undefined, "POST", { "X-Correlation": "original" });
    await completeKey(mock, control, "b", "original");
    expect(mock.verifyRequests("t").ok).toBe(true);
  });

  it.each(["reset", "replace", "full"])(
    "ignores old reservations and late completions after %s",
    async (action) => {
      const { mock, control } = await setup();
      const plan = [rule("a", "/work/a", 2), eachRule("b", 3, ["a"])];
      const options = { correlationHeader: "X-Correlation" };
      mock.setRequestExpectations("t", plan, options);
      await completeKey(mock, control, "a", "old");
      const oldConsumer = send(mock, "/work/b", "t", undefined, "POST", { "X-Correlation": "old" });
      const oldGate = await control.next();
      const oldProducer = send(mock, "/work/a", "t", undefined, "POST", { "X-Correlation": "new" });
      const producerGate = await control.next();
      if (action === "reset") mock.resetRequestVerification("t");
      else {
        if (action === "full") mock.reset();
        mock.setRequestExpectations("t", plan, options);
      }
      await completeKey(mock, control, "a", "old");
      await completeKey(mock, control, "b", "old");
      await oldGate.abort();
      await expect(oldConsumer).rejects.toThrow();
      await producerGate.finish();
      await oldProducer;
      await completeKey(mock, control, "b", "old");
      await completeKey(mock, control, "b", "new");
      const entries = mock.verifyRequests("t").expectations;
      expect(entries[0].completed).toBe(1);
      expect(entries[1]).toEqual(
        result("b", { expected: 3, started: 3, completed: 3, missing: 0, premature: 2 }),
      );
    },
  );

  it("retains per-occurrence declarations and options but clears credits on all-scope reset", async () => {
    const { mock, control } = await setup();
    for (const scope of ["first", "second"]) {
      mock.setRequestExpectations(scope, [rule("a", "/work/a", 2), eachRule("b", 2, ["a"])], {
        correlationHeader: "X-Correlation",
      });
      await completeKey(mock, control, "a", "key", scope);
    }
    mock.resetRequestVerification();
    for (const scope of ["first", "second"]) {
      await completeKey(mock, control, "b", "key", scope);
      await completeKey(mock, control, "a", "other", scope);
      await completeKey(mock, control, "b", "key", scope);
      expect(mock.verifyRequests(scope).expectations[1].premature).toBe(2);
    }
  });

  it.each([
    ["duplicate IDs", [rule("same"), rule("same")]],
    ["empty ID", [rule("")]],
    ["blank ID", [rule(" ")]],
    ["non-string ID", [{ id: 1, match: { path: "/work/a" }, count: 1 }]],
    ["negative count", [rule("a", "/work/a", -1)]],
    ["fractional count", [rule("a", "/work/a", 0.5)]],
    ["NaN count", [rule("a", "/work/a", NaN)]],
    ["infinite count", [rule("a", "/work/a", Infinity)]],
    ["unsafe count", [rule("a", "/work/a", Number.MAX_SAFE_INTEGER + 1)]],
    ["unknown prerequisite", [rule("a", "/work/a", 1, ["missing"])]],
    ["self prerequisite", [rule("a", "/work/a", 1, ["a"])]],
    ["cycle", [rule("a", "/work/a", 1, ["b"]), rule("b", "/work/b", 1, ["a"])]],
    ["invalid path", [{ id: "a", match: { path: 3 }, count: 1 }]],
    ["missing match", [{ id: "a", count: 1 }]],
    ["null match", [{ id: "a", match: null, count: 1 }]],
    ["non-object match", [{ id: "a", match: 1, count: 1 }]],
    ["empty method", [{ id: "a", match: { path: "/work/a", method: "" }, count: 1 }]],
    ["non-string method", [{ id: "a", match: { path: "/work/a", method: 1 }, count: 1 }]],
    ["blank method", [{ id: "a", match: { path: "/work/a", method: " \t " }, count: 1 }]],
    ["invalid after", [{ id: "a", match: { path: "/work/a" }, count: 1, after: "a" }]],
    ["invalid afterEach", [{ ...rule("a"), afterEach: "a" }]],
    ["non-string after member", [rule("1"), { ...rule("a"), after: [1] }]],
    ["non-string afterEach member", [rule("1"), { ...rule("a"), afterEach: [1] }]],
    ["unknown afterEach", [eachRule("a", 1, ["absent"])]],
    ["self afterEach", [eachRule("a", 1, ["a"])]],
    ["mixed dependency cycle", [rule("a", "/work/a", 1, ["b"]), eachRule("b", 1, ["a"])]],
  ])("rejects %s atomically", async (_label, input) => {
    const { mock, control } = await setup();
    mock.setRequestExpectations("t", [rule("a", "/work/a", 2)]);
    await complete(mock, control, "/work/a");
    const before = mock.verifyRequests("t");
    expect(() => mock.setRequestExpectations("t", input as RequestExpectation[])).toThrow();
    expect(mock.verifyRequests("t")).toEqual(before);
    await complete(mock, control, "/work/a");
    expect(mock.verifyRequests("t").ok).toBe(true);
  });

  it("accepts the safe-integer boundary without allocating occurrences", async () => {
    const { mock } = await setup();
    mock.setRequestExpectations("t", [rule("a", "/work/a", Number.MAX_SAFE_INTEGER)]);
    expect(mock.verifyRequests("t").expectations[0].missing).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each(["", " ", "bad header", "bad\nheader"])(
    "rejects malformed correlation header names atomically (%j)",
    async (header) => {
      const { mock, control } = await setup();
      mock.setRequestExpectations("t", [rule("a"), eachRule("b", 1, ["a"])], {
        correlationHeader: "X-Correlation",
      });
      await completeKey(mock, control, "a", "key");
      const before = mock.verifyRequests("t");
      expect(() => mock.setRequestExpectations("t", [], { correlationHeader: header })).toThrow();
      expect(mock.verifyRequests("t")).toEqual(before);
      await completeKey(mock, control, "b", "key");
      expect(mock.verifyRequests("t").ok).toBe(true);
    },
  );

  it.each(["", " "])("rejects blank scope IDs consistently (%j)", async (id) => {
    const { mock } = await setup();
    expect(mock.setRequestExpectations("t", [])).toBe(mock);
    expect(mock.verifyRequests("t")).toEqual({ ok: true, expectations: [] });
    expect(mock.resetRequestVerification("t")).toBe(mock);
    expect(() => mock.setRequestExpectations(id, [])).toThrow();
    expect(() => mock.verifyRequests(id)).toThrow();
    expect(() => mock.resetRequestVerification(id)).toThrow();
  });
});

async function pending(mock: LLMock, control: ControlledMount, id: string, testId = "t") {
  const response = send(mock, `/work/${id}`, testId);
  return { response, gate: await control.next() };
}

function diamond() {
  return [
    rule("r", "/work/r", 2),
    eachRule("a", 2, ["r"]),
    eachRule("b", 2, ["r"]),
    eachRule("j", 2, ["a", "b"]),
  ];
}

function observation(mock: LLMock, id: string, testId = "t") {
  const entry = mock.verifyRequests(testId).expectations.find((item) => item.id === id);
  expect(entry).toBeDefined();
  return entry!;
}

describe("Causal occurrence joins", () => {
  it.each([undefined, false, true])(
    "separates workflow occurrences only when enabled (%s)",
    async (causal) => {
      const { mock, control } = await setup();
      mock.setRequestExpectations("t", diamond(), { causal });
      await completeKey(mock, control, "r");
      await completeKey(mock, control, "r");
      await completeKey(mock, control, "a");
      const firstB = await pending(mock, control, "b");
      await completeKey(mock, control, "b");
      await completeKey(mock, control, "j");
      expect(observation(mock, "j").premature).toBe(causal ? 1 : 0);
      await firstB.gate.finish();
      await firstB.response;
      await completeKey(mock, control, "j");
      expect(observation(mock, "j").premature).toBe(1);
    },
  );

  it("uses arrival age rather than the order predecessor responses finish", async () => {
    const { mock, control } = await setup();
    mock.setRequestExpectations("t", diamond(), { causal: true });
    const first = await pending(mock, control, "r");
    await completeKey(mock, control, "r");
    await completeKey(mock, control, "a");
    await first.gate.finish();
    await first.response;
    await completeKey(mock, control, "b");
    await completeKey(mock, control, "j");
    expect(observation(mock, "j").premature).toBe(1);
    await completeKey(mock, control, "b");
    await completeKey(mock, control, "j");
    expect(observation(mock, "j").premature).toBe(1);
  });

  it("finds a later compatible tuple and does not consume rejected candidates", async () => {
    const { mock, control } = await setup();
    mock.setRequestExpectations("t", diamond(), { causal: true });
    for (const id of ["r", "r", "a", "a"]) await completeKey(mock, control, id);
    const firstB = await pending(mock, control, "b");
    await completeKey(mock, control, "b");
    await completeKey(mock, control, "j");
    expect(observation(mock, "j").premature).toBe(0);
    await firstB.gate.finish();
    await firstB.response;
    await completeKey(mock, control, "j");
    expect(mock.verifyRequests("t").ok).toBe(true);
  });

  it("backtracks through three predecessor choices to find a compatible tuple", async () => {
    const { mock, control } = await setup();
    mock.setRequestExpectations(
      "t",
      [
        rule("r", "/work/r", 2),
        eachRule("a", 2, ["r"]),
        eachRule("b", 2, ["r"]),
        eachRule("c", 2, ["r"]),
        eachRule("j", 2, ["a", "b", "c"]),
      ],
      { causal: true },
    );
    for (const id of ["r", "r", "a", "a", "b", "b"]) await completeKey(mock, control, id);
    const firstC = await pending(mock, control, "c");
    await completeKey(mock, control, "c");
    await completeKey(mock, control, "j");
    expect(observation(mock, "j").premature).toBe(0);
    await firstC.gate.finish();
    await firstC.response;
    await completeKey(mock, control, "j");
    expect(mock.verifyRequests("t").ok).toBe(true);
  });

  it("allows disjoint histories and carries shared ancestors through multiple hops", async () => {
    const { mock, control } = await setup();
    mock.setRequestExpectations(
      "t",
      [
        rule("r", "/work/r", 2),
        rule("s"),
        eachRule("a", 1, ["r"]),
        eachRule("b", 2, ["r"]),
        eachRule("aa", 1, ["a"]),
        eachRule("bb", 1, ["b"]),
        eachRule("merge", 1, ["aa", "s"]),
        eachRule("j", 1, ["merge", "bb"]),
      ],
      { causal: true },
    );
    for (const id of ["r", "r", "s", "a", "aa"]) await completeKey(mock, control, id);
    const firstB = await pending(mock, control, "b");
    for (const id of ["b", "bb", "merge", "j"]) await completeKey(mock, control, id);
    expect(observation(mock, "merge").premature).toBe(0);
    expect(observation(mock, "j").premature).toBe(1);
    await firstB.gate.finish();
    await firstB.response;
  });

  it("uses listed prerequisite order to choose between compatible histories", async () => {
    const { mock, control } = await setup();
    mock.setRequestExpectations(
      "t",
      [
        rule("r", "/work/r", 2),
        eachRule("z", 2, ["r"]),
        eachRule("a", 2, ["r"]),
        eachRule("j", 1, ["z", "a", "z"]),
        eachRule("k", 1, ["a", "z"]),
        eachRule("last", 1, ["j", "k"]),
      ],
      { causal: true },
    );
    const first = await pending(mock, control, "r");
    await completeKey(mock, control, "r");
    await completeKey(mock, control, "z");
    await first.gate.finish();
    await first.response;
    for (const id of ["z", "a", "a", "j", "k", "last"]) await completeKey(mock, control, id);
    expect(observation(mock, "j").premature).toBe(0);
    expect(observation(mock, "k").premature).toBe(0);
    expect(observation(mock, "last").premature).toBe(1);
  });

  it("keeps arrival selections fixed when older predecessor responses finish later", async () => {
    const { mock, control } = await setup();
    mock.setRequestExpectations(
      "t",
      [...diamond(), eachRule("k", 2, ["r"]), eachRule("last", 1, ["j", "k"])],
      { causal: true },
    );
    for (const id of ["r", "r"]) await completeKey(mock, control, id);
    const firstA = await pending(mock, control, "a");
    const firstB = await pending(mock, control, "b");
    for (const id of ["a", "b"]) await completeKey(mock, control, id);
    const joined = await pending(mock, control, "j");
    await firstA.gate.finish();
    await firstA.response;
    await firstB.gate.finish();
    await firstB.response;
    await joined.gate.finish();
    await joined.response;
    const firstK = await pending(mock, control, "k");
    for (const id of ["k", "last"]) await completeKey(mock, control, id);
    expect(observation(mock, "last").premature).toBe(0);
    await firstK.gate.finish();
    await firstK.response;
  });

  it("refunds the selected compatible tuple with its original age and preserves other claims", async () => {
    const { mock, control } = await setup();
    mock.setRequestExpectations(
      "t",
      [...diamond(), eachRule("k", 1, ["r"]), eachRule("last", 1, ["j", "k"])],
      { causal: true },
    );
    for (const id of ["r", "r", "a", "a"]) await completeKey(mock, control, id);
    const firstB = await pending(mock, control, "b");
    await completeKey(mock, control, "b");
    const secondRootJoin = await pending(mock, control, "j");
    await firstB.gate.finish();
    await firstB.response;
    const firstRootJoin = await pending(mock, control, "j");
    await secondRootJoin.gate.abort();
    await secondRootJoin.response.catch(() => {});
    await completeKey(mock, control, "j");
    expect(observation(mock, "j").premature).toBe(0);
    expect(observation(mock, "j").aborted).toBe(1);
    await completeKey(mock, control, "k");
    await completeKey(mock, control, "last");
    expect(observation(mock, "last").premature).toBe(1);
    await firstRootJoin.gate.finish();
    await firstRootJoin.response;
  });

  it("does not recycle a pending claim when a premature request aborts", async () => {
    const { mock, control } = await setup();
    mock.setRequestExpectations("t", [rule("r"), eachRule("a", 4, ["r"])], { causal: true });
    await completeKey(mock, control, "r");
    const first = await pending(mock, control, "a");
    const premature = await pending(mock, control, "a");
    await premature.gate.abort();
    await premature.response.catch(() => {});
    await completeKey(mock, control, "a");
    expect(observation(mock, "a").premature).toBe(2);
    await first.gate.abort();
    await first.response.catch(() => {});
    await completeKey(mock, control, "a");
    expect(observation(mock, "a").premature).toBe(2);
  });

  it("counts premature finishes for barriers but never uses them as causal evidence", async () => {
    const { mock, control } = await setup();
    mock.setRequestExpectations(
      "t",
      [
        rule("g"),
        rule("p", "/work/p", 1, ["g"]),
        eachRule("a", 1, ["p"]),
        rule("barrier", "/work/barrier", 1, ["p"]),
        eachRule("last", 1, ["barrier"]),
      ],
      { causal: true },
    );
    for (const id of ["p", "a", "barrier", "last"]) await completeKey(mock, control, id);
    expect(observation(mock, "p").completed).toBe(1);
    expect(observation(mock, "p").premature).toBe(1);
    expect(observation(mock, "a").premature).toBe(1);
    expect(observation(mock, "barrier").premature).toBe(0);
    expect(observation(mock, "last").premature).toBe(0);
  });

  it("does not treat whole-batch barriers as ancestry", async () => {
    const { mock, control } = await setup();
    mock.setRequestExpectations(
      "t",
      [
        rule("r", "/work/r", 2),
        eachRule("a", 1, ["r"]),
        rule("b", "/work/b", 1, ["r"]),
        eachRule("j", 1, ["a", "b"]),
      ],
      { causal: true },
    );
    for (const id of ["r", "a", "r", "b", "j"]) await completeKey(mock, control, id);
    expect(mock.verifyRequests("t").ok).toBe(true);
  });

  it("keeps separate downstream allowances and accepts excess successful occurrences", async () => {
    const { mock, control } = await setup();
    mock.setRequestExpectations(
      "t",
      [rule("r", "/work/r", 0), eachRule("a", 1, ["r"]), eachRule("b", 1, ["r"])],
      { causal: true },
    );
    await completeKey(mock, control, "r");
    const a = await pending(mock, control, "a");
    await completeKey(mock, control, "b");
    expect(observation(mock, "r").excess).toBe(1);
    expect(observation(mock, "a").premature).toBe(0);
    expect(observation(mock, "a").completed).toBe(0);
    expect(observation(mock, "a").pending).toBe(1);
    expect(observation(mock, "b").premature).toBe(0);
    await a.gate.finish();
    await a.response;
  });

  it("refunds every independently matched causal expectation on one aborted response", async () => {
    const { mock, control } = await setup();
    mock.setRequestExpectations(
      "t",
      [
        rule("r"),
        { ...eachRule("a", 2, ["r"]), match: { path: "/work/shared" } },
        { ...eachRule("b", 2, ["r"]), match: { path: /shared$/ } },
        eachRule("j", 1, ["a", "b"]),
      ],
      { causal: true },
    );
    await completeKey(mock, control, "r");
    const shared = await pending(mock, control, "shared");
    await shared.gate.abort();
    await shared.response.catch(() => {});
    await completeKey(mock, control, "shared");
    await completeKey(mock, control, "j");
    for (const id of ["a", "b"]) {
      expect(observation(mock, id)).toEqual({
        id,
        expected: 2,
        started: 2,
        completed: 1,
        aborted: 1,
        pending: 0,
        missing: 0,
        excess: 0,
        premature: 0,
      });
    }
    expect(observation(mock, "j").premature).toBe(0);
  });

  it.each(["true", null, 1])(
    "rejects non-boolean mode atomically with pending claims (%j)",
    async (invalid) => {
      const { mock, control } = await setup();
      const plan = [rule("r"), eachRule("a", 3, ["r"])];
      mock.setRequestExpectations("t", plan, { causal: true });
      await completeKey(mock, control, "r");
      const first = await pending(mock, control, "a");
      const before = mock.verifyRequests("t");
      expect(() =>
        mock.setRequestExpectations("t", plan, { causal: invalid as unknown as boolean }),
      ).toThrow();
      expect(mock.verifyRequests("t")).toEqual(before);
      await completeKey(mock, control, "a");
      expect(observation(mock, "a").premature).toBe(1);
      await first.gate.abort();
      await first.response.catch(() => {});
      await completeKey(mock, control, "a");
      expect(observation(mock, "a").premature).toBe(1);
    },
  );

  it.each(["one", "all", "replace", "full"])(
    "isolates old causal completion and refund callbacks after %s reset",
    async (mode) => {
      const { mock, control } = await setup();
      const plan = [rule("r", "/work/r", 2), eachRule("a", 3, ["r"])];
      mock.setRequestExpectations("t", plan, { causal: true });
      await completeKey(mock, control, "r");
      const oldConsumer = await pending(mock, control, "a");
      const oldRoot = await pending(mock, control, "r");
      if (mode === "one") mock.resetRequestVerification("t");
      else if (mode === "all") mock.resetRequestVerification();
      else {
        if (mode === "full") mock.reset();
        mock.setRequestExpectations("t", plan, { causal: true });
      }
      await completeKey(mock, control, "r");
      const current = await pending(mock, control, "a");
      await oldConsumer.gate.abort();
      await oldConsumer.response.catch(() => {});
      await oldRoot.gate.finish();
      await oldRoot.response;
      await completeKey(mock, control, "a");
      expect(observation(mock, "r").completed).toBe(1);
      expect(observation(mock, "a").premature).toBe(1);
      await current.gate.abort();
      await current.response.catch(() => {});
      await completeKey(mock, control, "a");
      expect(observation(mock, "a").premature).toBe(1);
    },
  );

  it("snapshots causal options and retains them across verification reset", async () => {
    const { mock, control } = await setup();
    const options = { causal: true };
    const plan = diamond();
    plan[1] = eachRule("a", 1, ["r"]);
    mock.setRequestExpectations("t", plan, options);
    options.causal = false;
    mock.resetRequestVerification();
    for (const id of ["r", "r", "a"]) await completeKey(mock, control, id);
    const firstB = await pending(mock, control, "b");
    for (const id of ["b", "j"]) await completeKey(mock, control, id);
    expect(observation(mock, "j").premature).toBe(1);
    await firstB.gate.finish();
    await firstB.response;
  });

  it("keeps causal pools separated by incoming correlation value and test scope", async () => {
    const { mock, control } = await setup();
    const plan = [rule("r", "/work/r", 2), eachRule("a", 3, ["r"])];
    for (const scope of ["t", "other"])
      mock.setRequestExpectations(scope, plan, {
        causal: true,
        correlationHeader: "X-Correlation",
      });
    await completeKey(mock, control, "r", "blue");
    await completeKey(mock, control, "a", "Blue");
    expect(observation(mock, "a").premature).toBe(1);
    await completeKey(mock, control, "a", "blue", "other");
    await completeKey(mock, control, "a", "blue");
    await completeKey(mock, control, "r", "");
    await completeKey(mock, control, "a");
    expect(observation(mock, "a").completed).toBe(3);
    expect(observation(mock, "a").premature).toBe(1);
    expect(observation(mock, "a", "other").premature).toBe(1);
  });

  it("refunds the original occurrence age ahead of an untouched later occurrence", async () => {
    const { mock, control } = await setup();
    mock.setRequestExpectations("t", diamond(), { causal: true });
    await completeKey(mock, control, "r");
    await completeKey(mock, control, "r");
    const first = await pending(mock, control, "a");
    await completeKey(mock, control, "b");
    await first.gate.abort();
    await first.response.catch(() => {});
    for (const id of ["a", "j"]) await completeKey(mock, control, id);
    expect(observation(mock, "j").premature).toBe(0);
  });

  it("rejects conflicting nonadjacent histories without reserving the disjoint middle branch", async () => {
    const { mock, control } = await setup();
    mock.setRequestExpectations(
      "t",
      [
        rule("r", "/work/r", 2),
        rule("s"),
        eachRule("a", 1, ["r"]),
        eachRule("b", 1, ["s"]),
        eachRule("c", 2, ["r"]),
        eachRule("j", 2, ["a", "b", "c"]),
      ],
      { causal: true },
    );
    for (const id of ["r", "r", "s", "a", "b"]) await completeKey(mock, control, id);
    const firstC = await pending(mock, control, "c");
    for (const id of ["c", "j"]) await completeKey(mock, control, id);
    expect(observation(mock, "j").premature).toBe(1);
    await firstC.gate.finish();
    await firstC.response;
    await completeKey(mock, control, "j");
    expect(observation(mock, "j").premature).toBe(1);
  });

  it("leaves causal allowances untouched when the whole-batch barrier is still pending", async () => {
    const { mock, control } = await setup();
    mock.setRequestExpectations("t", [rule("r"), rule("g"), eachRule("j", 2, ["r"], ["g"])], {
      causal: true,
    });
    await completeKey(mock, control, "r");
    const barrier = await pending(mock, control, "g");
    barrier.gate.chunk();
    await completeKey(mock, control, "j");
    expect(observation(mock, "j").premature).toBe(1);
    await barrier.gate.finish(503);
    await barrier.response;
    await completeKey(mock, control, "j");
    expect(observation(mock, "j").premature).toBe(1);
  });
});
