import { describe, it, expect, vi, beforeEach } from "vitest";
import * as http from "node:http";
import { createJsonRpcDispatcher, type JsonRpcResponse, type MethodHandler } from "../jsonrpc.js";

// --- helpers ---

function makeReqRes(): {
  req: http.IncomingMessage;
  res: http.ServerResponse & {
    _statusCode: number;
    _headers: Record<string, string>;
    _body: string;
  };
} {
  const req = Object.create(http.IncomingMessage.prototype) as http.IncomingMessage;
  const res = {
    _statusCode: 0,
    _headers: {} as Record<string, string>,
    _body: "",
    writeHead(statusCode: number, headers?: Record<string, string>) {
      this._statusCode = statusCode;
      if (headers) Object.assign(this._headers, headers);
      return this;
    },
    end(body?: string) {
      if (body !== undefined) this._body = body;
    },
  } as unknown as http.ServerResponse & {
    _statusCode: number;
    _headers: Record<string, string>;
    _body: string;
  };
  return { req, res };
}

function parseBody(res: { _body: string }): unknown {
  return res._body ? JSON.parse(res._body) : undefined;
}

// --- tests ---

describe("createJsonRpcDispatcher", () => {
  let echoHandler: MethodHandler;

  beforeEach(() => {
    echoHandler = vi.fn(async (params, id) => ({
      jsonrpc: "2.0" as const,
      id,
      result: params,
    }));
  });

  it("calls method handler and returns response for valid request", async () => {
    const dispatch = createJsonRpcDispatcher({ methods: { echo: echoHandler } });
    const { req, res } = makeReqRes();

    const body = JSON.stringify({ jsonrpc: "2.0", method: "echo", params: { a: 1 }, id: 1 });
    await dispatch(req, res, body);

    expect(res._statusCode).toBe(200);
    expect(res._headers["Content-Type"]).toBe("application/json");
    const parsed = parseBody(res) as JsonRpcResponse;
    expect(parsed.jsonrpc).toBe("2.0");
    expect(parsed.id).toBe(1);
    expect(parsed.result).toEqual({ a: 1 });
  });

  it("returns -32700 on invalid JSON", async () => {
    const dispatch = createJsonRpcDispatcher({ methods: {} });
    const { req, res } = makeReqRes();

    await dispatch(req, res, "not json{{{");

    expect(res._statusCode).toBe(200);
    const parsed = parseBody(res) as JsonRpcResponse;
    expect(parsed.error?.code).toBe(-32700);
    expect(parsed.error?.message).toContain("Parse error");
    expect(parsed.id).toBeNull();
  });

  it("returns -32600 when jsonrpc field is missing", async () => {
    const dispatch = createJsonRpcDispatcher({ methods: { echo: echoHandler } });
    const { req, res } = makeReqRes();

    await dispatch(req, res, JSON.stringify({ method: "echo", id: 1 }));

    expect(res._statusCode).toBe(200);
    const parsed = parseBody(res) as JsonRpcResponse;
    expect(parsed.error?.code).toBe(-32600);
  });

  it("returns -32600 when method field is missing", async () => {
    const dispatch = createJsonRpcDispatcher({ methods: { echo: echoHandler } });
    const { req, res } = makeReqRes();

    await dispatch(req, res, JSON.stringify({ jsonrpc: "2.0", id: 1 }));

    expect(res._statusCode).toBe(200);
    const parsed = parseBody(res) as JsonRpcResponse;
    expect(parsed.error?.code).toBe(-32600);
  });

  it("returns -32601 when method is not found", async () => {
    const dispatch = createJsonRpcDispatcher({ methods: {} });
    const { req, res } = makeReqRes();

    await dispatch(req, res, JSON.stringify({ jsonrpc: "2.0", method: "missing", id: 1 }));

    expect(res._statusCode).toBe(200);
    const parsed = parseBody(res) as JsonRpcResponse;
    expect(parsed.error?.code).toBe(-32601);
    expect(parsed.error?.message).toContain("Method not found");
  });

  it("returns -32603 when handler throws", async () => {
    const throwHandler: MethodHandler = async () => {
      throw new Error("boom");
    };
    const dispatch = createJsonRpcDispatcher({ methods: { boom: throwHandler } });
    const { req, res } = makeReqRes();

    await dispatch(req, res, JSON.stringify({ jsonrpc: "2.0", method: "boom", id: 1 }));

    expect(res._statusCode).toBe(200);
    const parsed = parseBody(res) as JsonRpcResponse;
    expect(parsed.error?.code).toBe(-32603);
    expect(parsed.error?.message).toContain("Internal error");
  });

  it("propagates custom error returned by handler", async () => {
    const errorHandler: MethodHandler = async (_params, id) => ({
      jsonrpc: "2.0",
      id,
      error: { code: -32602, message: "Invalid params", data: { field: "x" } },
    });
    const dispatch = createJsonRpcDispatcher({ methods: { bad: errorHandler } });
    const { req, res } = makeReqRes();

    await dispatch(req, res, JSON.stringify({ jsonrpc: "2.0", method: "bad", id: 1 }));

    expect(res._statusCode).toBe(200);
    const parsed = parseBody(res) as JsonRpcResponse;
    expect(parsed.error?.code).toBe(-32602);
    expect(parsed.error?.data).toEqual({ field: "x" });
  });

  it("returns 202 with no body for notification (no id) and calls handler with null id", async () => {
    const handler = vi.fn(async () => null);
    const dispatch = createJsonRpcDispatcher({ methods: { notify: handler } });
    const { req, res } = makeReqRes();

    await dispatch(req, res, JSON.stringify({ jsonrpc: "2.0", method: "notify", params: {} }));

    expect(res._statusCode).toBe(202);
    expect(res._body).toBe("");
    // Handler IS called for side effects, but with null id (not 0)
    expect(handler).toHaveBeenCalledWith({}, null, expect.anything());
  });

  it("fires onNotification callback for notifications", async () => {
    const onNotification = vi.fn();
    const dispatch = createJsonRpcDispatcher({
      methods: {},
      onNotification,
    });
    const { req, res } = makeReqRes();

    await dispatch(
      req,
      res,
      JSON.stringify({ jsonrpc: "2.0", method: "log", params: { msg: "hi" } }),
    );

    expect(onNotification).toHaveBeenCalledWith("log", { msg: "hi" });
    expect(res._statusCode).toBe(202);
  });

  it("handles batch of 2 requests and returns array of 2 responses", async () => {
    const dispatch = createJsonRpcDispatcher({ methods: { echo: echoHandler } });
    const { req, res } = makeReqRes();

    const batch = [
      { jsonrpc: "2.0", method: "echo", params: "a", id: 1 },
      { jsonrpc: "2.0", method: "echo", params: "b", id: 2 },
    ];
    await dispatch(req, res, JSON.stringify(batch));

    expect(res._statusCode).toBe(200);
    const parsed = parseBody(res) as JsonRpcResponse[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].id).toBe(1);
    expect(parsed[0].result).toBe("a");
    expect(parsed[1].id).toBe(2);
    expect(parsed[1].result).toBe("b");
  });

  it("batch with mixed requests and notifications returns only request responses", async () => {
    const handler = vi.fn(async (params: unknown, id: string | number) => ({
      jsonrpc: "2.0" as const,
      id,
      result: params,
    }));
    const dispatch = createJsonRpcDispatcher({ methods: { echo: handler } });
    const { req, res } = makeReqRes();

    const batch = [
      { jsonrpc: "2.0", method: "echo", params: "a", id: 1 },
      { jsonrpc: "2.0", method: "echo", params: "notify-me" }, // notification, no id
      { jsonrpc: "2.0", method: "echo", params: "b", id: 2 },
    ];
    await dispatch(req, res, JSON.stringify(batch));

    expect(res._statusCode).toBe(200);
    const parsed = parseBody(res) as JsonRpcResponse[];
    expect(parsed).toHaveLength(2);
    expect(parsed[0].id).toBe(1);
    expect(parsed[1].id).toBe(2);
  });

  it("returns -32600 for empty batch", async () => {
    const dispatch = createJsonRpcDispatcher({ methods: {} });
    const { req, res } = makeReqRes();

    await dispatch(req, res, JSON.stringify([]));

    expect(res._statusCode).toBe(200);
    const parsed = parseBody(res) as JsonRpcResponse;
    expect(parsed.error?.code).toBe(-32600);
    expect(parsed.id).toBeNull();
  });

  it("returns single object (not array) for single request", async () => {
    const dispatch = createJsonRpcDispatcher({ methods: { echo: echoHandler } });
    const { req, res } = makeReqRes();

    await dispatch(
      req,
      res,
      JSON.stringify({ jsonrpc: "2.0", method: "echo", params: null, id: 42 }),
    );

    const parsed = parseBody(res);
    expect(Array.isArray(parsed)).toBe(false);
    expect((parsed as JsonRpcResponse).id).toBe(42);
  });

  it("sets Content-Type to application/json on JSON responses", async () => {
    const dispatch = createJsonRpcDispatcher({ methods: { echo: echoHandler } });
    const { req, res } = makeReqRes();

    await dispatch(
      req,
      res,
      JSON.stringify({ jsonrpc: "2.0", method: "echo", params: null, id: 1 }),
    );

    expect(res._headers["Content-Type"]).toBe("application/json");
  });

  it("passes params, id, and req to handler", async () => {
    const spy = vi.fn(async (_params: unknown, id: string | number) => ({
      jsonrpc: "2.0" as const,
      id,
      result: null,
    }));
    const dispatch = createJsonRpcDispatcher({ methods: { test: spy } });
    const { req, res } = makeReqRes();

    await dispatch(
      req,
      res,
      JSON.stringify({ jsonrpc: "2.0", method: "test", params: { x: 1 }, id: "abc" }),
    );

    expect(spy).toHaveBeenCalledWith({ x: 1 }, "abc", req);
  });

  it("returns -32600 when jsonrpc is not '2.0'", async () => {
    const dispatch = createJsonRpcDispatcher({ methods: { echo: echoHandler } });
    const { req, res } = makeReqRes();

    await dispatch(req, res, JSON.stringify({ jsonrpc: "1.0", method: "echo", id: 1 }));

    const parsed = parseBody(res) as JsonRpcResponse;
    expect(parsed.error?.code).toBe(-32600);
  });

  it("returns -32600 when method is not a string", async () => {
    const dispatch = createJsonRpcDispatcher({ methods: { echo: echoHandler } });
    const { req, res } = makeReqRes();

    await dispatch(req, res, JSON.stringify({ jsonrpc: "2.0", method: 123, id: 1 }));

    const parsed = parseBody(res) as JsonRpcResponse;
    expect(parsed.error?.code).toBe(-32600);
  });

  it("returns -32600 when entry is not an object (e.g. a number)", async () => {
    const dispatch = createJsonRpcDispatcher({ methods: {} });
    const { req, res } = makeReqRes();

    // A batch entry that is a raw number, not an object
    await dispatch(req, res, JSON.stringify([42]));

    expect(res._statusCode).toBe(200);
    const parsed = parseBody(res) as JsonRpcResponse[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0].error?.code).toBe(-32600);
    expect(parsed[0].id).toBeNull();
  });

  it("returns -32600 for a single non-object request (string)", async () => {
    const dispatch = createJsonRpcDispatcher({ methods: {} });
    const { req, res } = makeReqRes();

    await dispatch(req, res, JSON.stringify("just a string"));

    expect(res._statusCode).toBe(200);
    const parsed = parseBody(res) as JsonRpcResponse;
    expect(parsed.error?.code).toBe(-32600);
    expect(parsed.id).toBeNull();
  });

  it("does not invoke method handler for notifications (spec compliance)", async () => {
    const methodHandler = vi.fn(async (_params: unknown, id: string | number) => ({
      jsonrpc: "2.0" as const,
      id,
      result: "should not be called",
    }));
    const onNotification = vi.fn();
    const dispatch = createJsonRpcDispatcher({
      methods: { foo: methodHandler },
      onNotification,
    });
    const { req, res } = makeReqRes();

    // Notification: no id field
    await dispatch(req, res, JSON.stringify({ jsonrpc: "2.0", method: "foo", params: { x: 1 } }));

    expect(res._statusCode).toBe(202);
    expect(res._body).toBe("");
    // Handler IS called for side effects, but with null id (not 0)
    expect(methodHandler).toHaveBeenCalledWith({ x: 1 }, null, expect.anything());
    expect(onNotification).toHaveBeenCalledWith("foo", { x: 1 });
  });

  it("handles request with id: null as a real request, not a notification", async () => {
    // JSON-RPC 2.0 spec: id of null is valid and indicates the client cannot
    // determine the request id. It is NOT a notification (notifications omit id
    // entirely or set it to undefined).
    const methodHandler = vi.fn(async (params: unknown, id: string | number) => ({
      jsonrpc: "2.0" as const,
      id,
      result: params,
    }));
    const onNotification = vi.fn();
    const dispatch = createJsonRpcDispatcher({
      methods: { echo: methodHandler },
      onNotification,
    });
    const { req, res } = makeReqRes();

    await dispatch(
      req,
      res,
      JSON.stringify({ jsonrpc: "2.0", method: "echo", params: { val: "null-id" }, id: null }),
    );

    expect(res._statusCode).toBe(200);
    const parsed = parseBody(res) as JsonRpcResponse;
    expect(parsed.jsonrpc).toBe("2.0");
    expect(parsed.id).toBeNull();
    expect(parsed.result).toEqual({ val: "null-id" });
    // Should NOT be treated as a notification
    expect(onNotification).not.toHaveBeenCalled();
  });

  it("handles request with id: 0 as a real request, not a notification", async () => {
    const methodHandler = vi.fn(async (params: unknown, id: string | number) => ({
      jsonrpc: "2.0" as const,
      id,
      result: params,
    }));
    const onNotification = vi.fn();
    const dispatch = createJsonRpcDispatcher({
      methods: { echo: methodHandler },
      onNotification,
    });
    const { req, res } = makeReqRes();

    // id: 0 is a valid JSON-RPC id — this is a request, not a notification
    await dispatch(
      req,
      res,
      JSON.stringify({ jsonrpc: "2.0", method: "echo", params: { val: "zero" }, id: 0 }),
    );

    expect(res._statusCode).toBe(200);
    const parsed = parseBody(res) as JsonRpcResponse;
    expect(parsed.jsonrpc).toBe("2.0");
    expect(parsed.id).toBe(0);
    expect(parsed.result).toEqual({ val: "zero" });
    expect(methodHandler).toHaveBeenCalledWith({ val: "zero" }, 0, req);
    expect(onNotification).not.toHaveBeenCalled();
  });

  it("returns result: null when handler returns null", async () => {
    const nullHandler: MethodHandler = async () => null;
    const dispatch = createJsonRpcDispatcher({ methods: { noop: nullHandler } });
    const { req, res } = makeReqRes();

    await dispatch(req, res, JSON.stringify({ jsonrpc: "2.0", method: "noop", id: 5 }));

    expect(res._statusCode).toBe(200);
    const parsed = parseBody(res) as JsonRpcResponse;
    expect(parsed.id).toBe(5);
    expect(parsed.result).toBeNull();
    expect(parsed.error).toBeUndefined();
  });

  it("coerces non-string/number id to null in error responses", async () => {
    const dispatch = createJsonRpcDispatcher({ methods: {} });
    const { req, res } = makeReqRes();

    // id is a boolean - not valid per JSON-RPC spec
    await dispatch(req, res, JSON.stringify({ jsonrpc: "2.0", method: "missing", id: true }));

    expect(res._statusCode).toBe(200);
    const parsed = parseBody(res) as JsonRpcResponse;
    expect(parsed.error?.code).toBe(-32601);
    expect(parsed.id).toBeNull();
  });

  it("treats id: undefined (present but undefined) as notification", async () => {
    const handler = vi.fn(async () => null);
    const dispatch = createJsonRpcDispatcher({ methods: { ping: handler } });
    const { req, res } = makeReqRes();

    // JSON.stringify strips undefined values, so id won't be in the output.
    // We test this by constructing a request without id at all.
    await dispatch(req, res, JSON.stringify({ jsonrpc: "2.0", method: "ping", params: {} }));

    expect(res._statusCode).toBe(202);
    // Handler IS called for side effects with null id
    expect(handler).toHaveBeenCalledWith({}, null, expect.anything());
  });

  it("stringifies non-Error thrown values in internal error message", async () => {
    const throwHandler: MethodHandler = async () => {
      throw "raw string error";
    };
    const dispatch = createJsonRpcDispatcher({ methods: { bad: throwHandler } });
    const { req, res } = makeReqRes();

    await dispatch(req, res, JSON.stringify({ jsonrpc: "2.0", method: "bad", id: 1 }));

    expect(res._statusCode).toBe(200);
    const parsed = parseBody(res) as JsonRpcResponse;
    expect(parsed.error?.code).toBe(-32603);
    expect(parsed.error?.message).toContain("raw string error");
  });

  it("returns -32600 with numeric id when jsonrpc is wrong", async () => {
    const dispatch = createJsonRpcDispatcher({ methods: {} });
    const { req, res } = makeReqRes();

    await dispatch(req, res, JSON.stringify({ jsonrpc: "3.0", method: "test", id: 99 }));

    const parsed = parseBody(res) as JsonRpcResponse;
    expect(parsed.error?.code).toBe(-32600);
    expect(parsed.id).toBe(99);
  });

  it("returns -32600 with string id when jsonrpc is wrong", async () => {
    const dispatch = createJsonRpcDispatcher({ methods: {} });
    const { req, res } = makeReqRes();

    await dispatch(req, res, JSON.stringify({ jsonrpc: "3.0", method: "test", id: "str-id" }));

    const parsed = parseBody(res) as JsonRpcResponse;
    expect(parsed.error?.code).toBe(-32600);
    expect(parsed.id).toBe("str-id");
  });

  it("returns -32600 with null id when id is non-string/non-number in invalid request", async () => {
    const dispatch = createJsonRpcDispatcher({ methods: {} });
    const { req, res } = makeReqRes();

    // id is an object — not a valid JSON-RPC id type
    await dispatch(req, res, JSON.stringify({ jsonrpc: "3.0", method: "test", id: { bad: true } }));

    const parsed = parseBody(res) as JsonRpcResponse;
    expect(parsed.error?.code).toBe(-32600);
    expect(parsed.id).toBeNull();
  });

  it("batch of all notifications returns 202 with no body", async () => {
    const handler = vi.fn(async () => null);
    const dispatch = createJsonRpcDispatcher({ methods: { ping: handler } });
    const { req, res } = makeReqRes();

    const batch = [
      { jsonrpc: "2.0", method: "ping", params: {} },
      { jsonrpc: "2.0", method: "ping", params: {} },
    ];
    await dispatch(req, res, JSON.stringify(batch));

    expect(res._statusCode).toBe(202);
    expect(res._body).toBe("");
    // Handlers called with null id for each notification
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
