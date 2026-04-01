import type * as http from "node:http";
import { randomUUID } from "node:crypto";
import { createJsonRpcDispatcher } from "./jsonrpc.js";
import type {
  MCPToolDefinition,
  MCPResourceDefinition,
  MCPResourceContent,
  MCPPromptDefinition,
  MCPPromptResult,
  MCPContent,
  MCPSession,
} from "./mcp-types.js";

export interface MCPState {
  serverInfo: { name: string; version: string };
  tools: Map<string, { def: MCPToolDefinition; handler?: (...args: unknown[]) => unknown }>;
  resources: Map<string, { def: MCPResourceDefinition; content?: MCPResourceContent }>;
  prompts: Map<
    string,
    {
      def: MCPPromptDefinition;
      handler?: (...args: unknown[]) => MCPPromptResult | Promise<MCPPromptResult>;
    }
  >;
  sessions: Map<string, MCPSession>;
}

function jsonRpcResult(id: string | number, result: unknown) {
  return { jsonrpc: "2.0" as const, id, result };
}

function jsonRpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id, error: { code, message } };
}

export function createMCPRequestHandler(state: MCPState) {
  const dispatcher = createJsonRpcDispatcher({
    methods: {
      // initialize is handled directly in the outer function — this entry is
      // only here so the dispatcher doesn't return "Method not found" if the
      // request somehow reaches it.
      initialize: async (_params, id) => {
        return jsonRpcResult(id, {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo: state.serverInfo,
        });
      },

      "notifications/initialized": async (_params, _id, req) => {
        const sessionId = req.headers["mcp-session-id"] as string;
        const session = state.sessions.get(sessionId);
        if (session) {
          session.initialized = true;
        }
        return null;
      },

      ping: async (_params, id) => {
        return jsonRpcResult(id, {});
      },

      "tools/list": async (_params, id) => {
        const tools: MCPToolDefinition[] = [];
        for (const { def } of state.tools.values()) {
          tools.push(def);
        }
        return jsonRpcResult(id, { tools });
      },

      "tools/call": async (params, id) => {
        const { name, arguments: args } = (params ?? {}) as { name?: string; arguments?: unknown };
        if (!name) {
          return jsonRpcError(id, -32602, "Missing tool name");
        }
        const entry = state.tools.get(name);
        if (!entry) {
          return jsonRpcError(id, -32602, `Unknown tool: ${name}`);
        }
        if (entry.handler) {
          try {
            const result = await entry.handler(args);
            const content: MCPContent[] = Array.isArray(result)
              ? result
              : [{ type: "text", text: String(result) }];
            return jsonRpcResult(id, { content, isError: false });
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            return jsonRpcResult(id, {
              content: [{ type: "text", text: message }],
              isError: true,
            });
          }
        }
        // No handler — return empty content
        return jsonRpcResult(id, { content: [], isError: false });
      },

      "resources/list": async (_params, id) => {
        const resources: MCPResourceDefinition[] = [];
        for (const { def } of state.resources.values()) {
          resources.push(def);
        }
        return jsonRpcResult(id, { resources });
      },

      "resources/read": async (params, id) => {
        const { uri } = (params ?? {}) as { uri?: string };
        if (!uri) {
          return jsonRpcError(id, -32602, "Missing resource URI");
        }
        const entry = state.resources.get(uri);
        if (!entry) {
          return jsonRpcError(id, -32602, `Unknown resource: ${uri}`);
        }
        return jsonRpcResult(id, {
          contents: [
            {
              uri,
              ...(entry.content?.text !== undefined && { text: entry.content.text }),
              ...(entry.content?.blob !== undefined && { blob: entry.content.blob }),
              ...(entry.content?.mimeType !== undefined && { mimeType: entry.content.mimeType }),
            },
          ],
        });
      },

      "prompts/list": async (_params, id) => {
        const prompts: MCPPromptDefinition[] = [];
        for (const { def } of state.prompts.values()) {
          prompts.push(def);
        }
        return jsonRpcResult(id, { prompts });
      },

      "prompts/get": async (params, id) => {
        const { name, arguments: args } = (params ?? {}) as { name?: string; arguments?: unknown };
        if (!name) {
          return jsonRpcError(id, -32602, "Missing prompt name");
        }
        const entry = state.prompts.get(name);
        if (!entry) {
          return jsonRpcError(id, -32602, `Unknown prompt: ${name}`);
        }
        if (entry.handler) {
          try {
            const result = await entry.handler(args);
            return jsonRpcResult(id, result);
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            return jsonRpcError(id, -32603, `Prompt handler error: ${message}`);
          }
        }
        // No handler — return empty messages
        return jsonRpcResult(id, { messages: [] });
      },
    },
  });

  return async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: string,
  ): Promise<void> => {
    // DELETE handler: session teardown
    if (req.method === "DELETE") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (!sessionId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing mcp-session-id header" }));
        return;
      }
      if (!state.sessions.has(sessionId)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found" }));
        return;
      }
      state.sessions.delete(sessionId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // Parse the body to determine method for session validation
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      // Let the dispatcher handle parse errors
      await dispatcher(req, res, body);
      return;
    }

    const method =
      typeof parsed === "object" && parsed !== null && "method" in parsed
        ? (parsed as { method: unknown }).method
        : undefined;

    // Handle initialize directly to control response headers
    if (method === "initialize") {
      const id =
        typeof parsed === "object" && parsed !== null && "id" in parsed
          ? (parsed as { id: unknown }).id
          : null;

      const sessionId = randomUUID();
      state.sessions.set(sessionId, {
        id: sessionId,
        initialized: false,
        createdAt: Date.now(),
      });

      const response = {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo: state.serverInfo,
        },
      };

      res.writeHead(200, {
        "Content-Type": "application/json",
        "Mcp-Session-Id": sessionId,
      });
      res.end(JSON.stringify(response));
      return;
    }

    // Session validation for all other methods
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing mcp-session-id header" }));
      return;
    }
    if (!state.sessions.has(sessionId)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Session not found" }));
      return;
    }

    // Enforce initialization: only allow notifications/initialized through
    // before the session is fully initialized
    const session = state.sessions.get(sessionId)!;
    if (!session.initialized && method !== "notifications/initialized") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          jsonRpcError(
            typeof parsed === "object" && parsed !== null && "id" in parsed
              ? ((parsed as { id: unknown }).id as string | number)
              : null,
            -32002,
            "Session not initialized",
          ),
        ),
      );
      return;
    }

    // Delegate to the JSON-RPC dispatcher for all other methods
    await dispatcher(req, res, body);
  };
}
