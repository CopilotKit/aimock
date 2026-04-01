import type * as http from "node:http";

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export type MethodHandler = (
  params: unknown,
  id: string | number,
  req: http.IncomingMessage,
) => Promise<JsonRpcResponse | null>;

export interface JsonRpcDispatcherOptions {
  methods: Record<string, MethodHandler>;
  onNotification?: (method: string, params: unknown) => void;
}

function errorResponse(
  code: number,
  message: string,
  id: string | number | null = null,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

async function processOne(
  entry: unknown,
  methods: Record<string, MethodHandler>,
  onNotification: ((method: string, params: unknown) => void) | undefined,
  req: http.IncomingMessage,
): Promise<JsonRpcResponse | null> {
  if (!isObject(entry)) {
    return errorResponse(-32600, "Invalid request");
  }

  const { jsonrpc, method, params, id } = entry;

  if (jsonrpc !== "2.0" || typeof method !== "string") {
    const reqId = typeof id === "string" || typeof id === "number" ? id : null;
    return errorResponse(-32600, "Invalid request", reqId);
  }

  // Notification: id is absent/undefined
  const isNotification = !("id" in entry) || id === undefined;

  if (isNotification) {
    if (onNotification) {
      onNotification(method, params);
    }
    // Invoke the method handler for side effects (e.g., MCP notifications/initialized),
    // but discard the result — notifications MUST NOT produce responses per JSON-RPC 2.0.
    const handler = methods[method];
    if (handler) {
      try {
        await handler(params, null as unknown as string | number, req);
      } catch (err: unknown) {
        console.warn("Notification handler error:", err);
      }
    }
    return null;
  }

  const reqId = typeof id === "string" || typeof id === "number" ? id : null;

  const handler = methods[method];
  if (!handler) {
    return errorResponse(-32601, "Method not found", reqId);
  }

  try {
    const result = await handler(params, reqId as string | number, req);
    if (result) return result;
    return { jsonrpc: "2.0", id: reqId, result: null };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResponse(-32603, `Internal error: ${msg}`, reqId);
  }
}

export function createJsonRpcDispatcher(
  options: JsonRpcDispatcherOptions,
): (req: http.IncomingMessage, res: http.ServerResponse, body: string) => Promise<void> {
  const { methods, onNotification } = options;

  return async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: string,
  ): Promise<void> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      const resp = errorResponse(-32700, "Parse error");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(resp));
      return;
    }

    // Empty batch
    if (Array.isArray(parsed) && parsed.length === 0) {
      const resp = errorResponse(-32600, "Invalid request");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(resp));
      return;
    }

    // Batch mode
    if (Array.isArray(parsed)) {
      const responses: JsonRpcResponse[] = [];
      for (const entry of parsed) {
        const result = await processOne(entry, methods, onNotification, req);
        if (result !== null) {
          responses.push(result);
        }
      }
      if (responses.length === 0) {
        res.writeHead(202);
        res.end("");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(responses));
      return;
    }

    // Single request
    const result = await processOne(parsed, methods, onNotification, req);
    if (result === null) {
      res.writeHead(202);
      res.end("");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  };
}
