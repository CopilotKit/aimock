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
import type { McpFakeClaim, McpFakeStore } from "./mcp-fakes.js";
import {
  MCP_FAKE_ERROR_CODES,
  type McpFakeErrorCode,
  type McpFakeIdentity,
  type McpFakeOutcome,
} from "./types.js";
import { decodeMcpHeaderValue, resolveMcpIdentity, type McpIdentityResolution } from "./helpers.js";
import { Message, build, fixed, jsonText, msg, plainText, quote } from "./message-text.js";

/**
 * `data.aimock.code` of a `tools/call` whose fake claim threw: an aimock
 * defect (a validated entry whose result could not be built or sent), not a
 * scenario failure. Answered with the JSON-RPC internal-error code `-32603`;
 * the entry stays unconsumed.
 */
export const MCP_FAKE_INTERNAL_ERROR = "MCP_FAKE_INTERNAL_ERROR";
const MCP_FAKE_INTERNAL_ERROR_RPC_CODE = -32603;

/** What every fake event carries: who called which tool on which mount (I9). */
interface McpFakeEventBase {
  identity: McpFakeIdentity;
  tool: string;
  /** The mount path the request came in on (I9). */
  mount: string;
}

/**
 * One MCP fake outcome of a `tools/call`, for the mount's side channels
 * (metric and log line; spec 9.3). `answered` names the entry; every other
 * kind is a failure with its `data.aimock.code` and the JSON-RPC error
 * message sent to the client. `evicted` also carries the evicted test id and
 * the cap; `internal_error` is a claim that threw (`MCP_FAKE_INTERNAL_ERROR`).
 */
export type McpFakeEvent = McpFakeEventBase &
  (
    | { kind: "answered"; entryId: string }
    | {
        kind: Exclude<McpFakeOutcome, "answered" | "evicted">;
        code: McpFakeErrorCode;
        message: string;
      }
    | { kind: "evicted"; code: "MCP_FAKE_EVICTED"; message: string; testId: string; cap: number }
    | { kind: "internal_error"; code: typeof MCP_FAKE_INTERNAL_ERROR; message: string }
  );

/** An identity field whose value can fall back to the raw value (H1). */
export type McpDecodeField = "testId" | "context";

/**
 * A decode fallback of one request, for L2: a test id or context value that
 * is not valid percent-encoding (on the header or the query; `used` is false
 * for a query value the header overrode), or query names that are not valid
 * percent-encoding and so match no identity field.
 */
export type McpDecodeFallback =
  | { kind: "value"; field: McpDecodeField; source: "header" | "query"; raw: string; used: boolean }
  | { kind: "names"; count: number };

/** One JSON-RPC message of a request, for one journal entry (B2). */
export interface MCPMessageRecord {
  /** The JSON-RPC request object of a `tools/call`, else `null`. */
  body: Record<string, unknown> | null;
  /** Set when a fake answered or failed this `tools/call`. */
  mcpFake: { id: string | null; outcome: McpFakeOutcome } | null;
  /** What the mount's own code threw while serving this message, else `null`. */
  error: string | null;
}

/**
 * What one request handled by `createMCPRequestHandler` resolved, for the
 * mount's journal (B2, B3). `identity` is `null` when the request had none to
 * resolve (a rejected identity; a DELETE with a missing or unknown session).
 * `messages` has one record per JSON-RPC message: one for a single message,
 * one per element of a batch, so each `tools/call` of a batch is journaled
 * with its own body and fake outcome. The mount writes one journal entry per
 * record, and one with no body when there is none (a request answered before
 * any message was read, or an empty batch).
 */
export interface MCPRequestRecord {
  identity: McpFakeIdentity | null;
  messages: MCPMessageRecord[];
}

/** An empty record, for the caller to pass in and read even if the handler throws. */
export function newMCPRequestRecord(): MCPRequestRecord {
  return { identity: null, messages: [] };
}

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
  /** The mount's fakes (one store per mount). */
  fakes: McpFakeStore;
  /** Whether any fake block is loaded on the mount (gates L2). */
  hasFakes(): boolean;
  /** A fake answered or failed a `tools/call` (metric, L1/L10 log). */
  onFakeEvent(evt: McpFakeEvent): void;
  /**
   * A request of `sessionId` sent an identity value (or query name) that is
   * not valid percent-encoding (H1). Called only when `hasFakes()`; the mount
   * logs L2 once per session per field and source.
   */
  onDecodeFallback(sessionId: string, fallback: McpDecodeFallback): void;
  /** `sessionId` was deleted (DELETE): the mount drops its per-session state. */
  onSessionClosed(sessionId: string): void;
}

function jsonRpcResult(id: string | number, result: unknown) {
  return { jsonrpc: "2.0" as const, id, result };
}

function jsonRpcError(id: string | number | null, code: number, message: string, data?: unknown) {
  return {
    jsonrpc: "2.0" as const,
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

/**
 * The identity part of a fake message or log line (I9): `testId "<id>"`,
 * `context "<ctx>"`, both, or `no testId or context`.
 */
export function describeMcpIdentity(identity: McpFakeIdentity): Message {
  const { testId, context } = identity;
  if (testId !== null && context !== null) {
    return msg`testId ${quote(testId)}, context ${quote(context)}`;
  }
  if (testId !== null) return msg`testId ${quote(testId)}`;
  if (context !== null) return msg`context ${quote(context)}`;
  return msg`no testId or context`;
}

/** A value as JSON text for a message part. */
function jsonPart(value: unknown): ReturnType<typeof jsonText> {
  return jsonText(JSON.stringify(value) ?? "null");
}

/** The outcome of one `tools/call` invocation, for its message record. */
type CallOutcome = Omit<MCPMessageRecord, "body">;

/**
 * What `tools/call` reads of one request (its resolved identity and mount,
 * and which invocations are notifications) and writes back: one outcome per
 * `tools/call` invocation, in order, so a batch's calls each keep their own.
 */
interface FakeRequestContext {
  identity: McpFakeIdentity;
  mount: string;
  /**
   * Per `tools/call` invocation, in order: true when its message has no `id`
   * member. The dispatcher passes a null id both for a notification and for
   * a request whose id is null or not a string or number, so the handler
   * cannot tell them apart from its id.
   */
  notifications: boolean[];
  calls: CallOutcome[];
}

/**
 * A fake failure: the JSON-RPC error to send and the event to report; an
 * `evicted` one also carries the evicted test id and the cap.
 */
type FakeFailure = { message: string; aimock: Record<string, unknown> } & (
  | { outcome: Exclude<McpFakeOutcome, "answered" | "evicted">; code: McpFakeErrorCode }
  | { outcome: "evicted"; code: "MCP_FAKE_EVICTED"; evicted: { testId: string; cap: number } }
);

/**
 * The 9.2 error for a failed claim (`mismatch`, `exhausted`, `evicted`), or
 * for an undeclared tool under `deny` (`not_declared`).
 */
function fakeFailure(
  claim: Exclude<McpFakeClaim, { kind: "answer" } | { kind: "none" }> | { kind: "not_declared" },
  tool: string,
  ctx: FakeRequestContext,
  declaredTools: () => string[],
): FakeFailure {
  const who = describeMcpIdentity(ctx.identity);
  const base = {
    tool,
    testId: ctx.identity.testId,
    context: ctx.identity.context,
    mount: ctx.mount,
  };
  switch (claim.kind) {
    case "mismatch": {
      const declared = claim.declared.map((d) =>
        d.args !== undefined
          ? msg`${plainText(d.id)} ${jsonPart(d.args)}`
          : msg`${plainText(d.id)} anyArgs`,
      );
      const list = declared.reduce<Message>(
        (acc, part, i) => (i === 0 ? part : msg`${acc}; ${part}`),
        msg`none`,
      );
      return {
        code: "MCP_FAKE_MISMATCH",
        outcome: "mismatch",
        message: build(
          msg`aimock MCP fake mismatch: tool ${quote(tool)} was called with arguments that match no declared fake (${who}). Received ${jsonPart(claim.received)}. Declared: ${list}.`,
        ),
        aimock: {
          code: "MCP_FAKE_MISMATCH",
          ...base,
          received: claim.received,
          declared: claim.declared,
          firstDifference: claim.firstDifference,
        },
      };
    }
    case "exhausted": {
      const used =
        claim.matchingDeclared === 1
          ? msg`the 1 matching fake is`
          : msg`all ${claim.matchingDeclared} matching fakes are`;
      return {
        code: "MCP_FAKE_EXHAUSTED",
        outcome: "exhausted",
        message: build(
          msg`aimock MCP fake exhausted: tool ${quote(tool)} with ${jsonPart(claim.received)} was called again, but ${used} already used (${who}).`,
        ),
        aimock: {
          code: "MCP_FAKE_EXHAUSTED",
          ...base,
          received: claim.received,
          matchingDeclared: claim.matchingDeclared,
          matchingConsumed: claim.matchingConsumed,
          matchingIds: claim.matchingIds,
        },
      };
    }
    case "evicted":
      // Only a test id is ever evicted (never the untagged state), so the
      // claim's test id is the request's.
      return {
        code: "MCP_FAKE_EVICTED",
        outcome: "evicted",
        evicted: { testId: claim.testId, cap: claim.maxTestIds },
        message: build(
          msg`aimock MCP fake evicted: consumption state for testId ${quote(claim.testId)} was evicted by the per-mount test-id cap (${claim.maxTestIds}); reset before reusing this test id (${who}).`,
        ),
        aimock: { code: "MCP_FAKE_EVICTED", ...base, testId: claim.testId, cap: claim.maxTestIds },
      };
    case "not_declared":
      return {
        code: "MCP_FAKE_NOT_DECLARED",
        outcome: "not_declared",
        message: build(
          msg`Unknown tool: ${plainText(tool)} (aimock MCP fake not declared: this scenario denies undeclared tools; ${who}).`,
        ),
        aimock: { code: "MCP_FAKE_NOT_DECLARED", ...base, declaredTools: declaredTools() },
      };
  }
}

export function createMCPRequestHandler(state: MCPState) {
  /** Per-request fake context, set by the outer handler for the dispatcher's methods. */
  const contexts = new WeakMap<http.IncomingMessage, FakeRequestContext>();

  /**
   * Spec 10 steps 1-2 for `tools/call`: a fake answer or fake failure, or
   * `null` to fall through to today's behavior (step 3).
   */
  const callFake = (
    ctx: FakeRequestContext,
    outcome: CallOutcome,
    tool: string,
    args: unknown,
    id: string | number,
  ): ReturnType<typeof jsonRpcResult> | ReturnType<typeof jsonRpcError> | null => {
    const event = { identity: ctx.identity, tool, mount: ctx.mount };
    let claim: McpFakeClaim;
    try {
      claim = state.fakes.claim(tool, args, ctx.identity);
    } catch (err) {
      // A validated entry whose result cannot be built or sent: an aimock
      // defect. Fail loud on every side channel, never a generic -32603.
      const thrown = err instanceof Error ? err.message : String(err);
      const message = build(
        msg`aimock MCP fake internal error: tool ${quote(tool)} could not be answered (${describeMcpIdentity(ctx.identity)}): ${plainText(thrown)}`,
      );
      outcome.error = message;
      state.onFakeEvent({
        ...event,
        kind: "internal_error",
        code: MCP_FAKE_INTERNAL_ERROR,
        message,
      });
      return jsonRpcError(id, MCP_FAKE_INTERNAL_ERROR_RPC_CODE, message, {
        aimock: {
          code: MCP_FAKE_INTERNAL_ERROR,
          tool,
          testId: ctx.identity.testId,
          context: ctx.identity.context,
          mount: ctx.mount,
          error: thrown,
        },
      });
    }
    if (claim.kind === "answer") {
      outcome.mcpFake = { id: claim.entry.id, outcome: "answered" };
      state.onFakeEvent({ ...event, kind: "answered", entryId: claim.entry.id });
      return jsonRpcResult(id, claim.result);
    }
    let failure: FakeFailure;
    if (claim.kind === "none") {
      if (state.fakes.policy(ctx.identity) !== "deny") return null;
      failure = fakeFailure({ kind: "not_declared" }, tool, ctx, () =>
        state.fakes.declaredTools(ctx.identity),
      );
    } else {
      failure = fakeFailure(claim, tool, ctx, () => []);
    }
    outcome.mcpFake = { id: null, outcome: failure.outcome };
    state.onFakeEvent(
      failure.outcome === "evicted"
        ? {
            ...event,
            kind: "evicted",
            code: failure.code,
            message: failure.message,
            ...failure.evicted,
          }
        : { ...event, kind: failure.outcome, code: failure.code, message: failure.message },
    );
    return jsonRpcError(id, MCP_FAKE_ERROR_CODES[failure.code], failure.message, {
      aimock: failure.aimock,
    });
  };

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

      "tools/list": async (_params, id, req) => {
        const tools: MCPToolDefinition[] = [];
        for (const { def } of state.tools.values()) {
          tools.push(def);
        }
        // Spec 10: the union with the applicable fake tools; a registered
        // definition wins for metadata.
        const ctx = contexts.get(req);
        if (ctx) {
          const registered = new Set(tools.map((t) => t.name));
          for (const fake of state.fakes.listTools(ctx.identity)) {
            if (!registered.has(fake.name)) tools.push(fake);
          }
        }
        return jsonRpcResult(id, { tools });
      },

      "tools/call": async (params, id, req) => {
        // One outcome per invocation, in order, even when nothing is claimed,
        // so each message of a batch is matched with its own.
        const outcome: CallOutcome = { mcpFake: null, error: null };
        const ctx = contexts.get(req);
        const isNotification = ctx?.notifications[ctx.calls.length] === true;
        ctx?.calls.push(outcome);
        // A notification (no `id` member) gets no answer (JSON-RPC 2.0) and
        // claims no fake entry, but a registered handler still runs for its
        // side effects, as on origin/main. A request whose id is null or of
        // another type is still served, with id null.
        const { name: rawName, arguments: args } = (params ?? {}) as {
          name?: unknown;
          arguments?: unknown;
        };
        if (!rawName) {
          return jsonRpcError(id, -32602, "Missing tool name");
        }
        if (typeof rawName !== "string") {
          const got = Array.isArray(rawName) ? "array" : typeof rawName;
          return jsonRpcError(
            id,
            -32602,
            build(msg`Invalid tool name: expected a string, got ${fixed(got)}`),
          );
        }
        const name = rawName;
        // Spec 10 steps 1-2: fakes, then the deny policy; never a handler
        // after a fake failure.
        if (ctx && !isNotification) {
          const fake = callFake(ctx, outcome, name, args, id);
          if (fake) return fake;
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

  /** Answer a rejected identity (H4, H5) with HTTP 400, in the session-error shape. */
  const rejectIdentity = (
    res: http.ServerResponse,
    resolution: Extract<McpIdentityResolution, { ok: false }>,
  ): void => {
    res.writeHead(resolution.error.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: resolution.error.message, code: resolution.error.code }));
  };

  /**
   * L2: report each identity value that fell back to the raw value (H1),
   * naming its source (header or query) and the value itself, and any query
   * name that did not decode. `fellBack` says only that some value of the
   * field fell back; the header is checked on its own, and the query by the
   * same resolver given the query alone, so the rules are the resolver's.
   */
  const reportFallback = (
    sessionId: string,
    req: http.IncomingMessage,
    resolution: Extract<McpIdentityResolution, { ok: true }>,
  ): void => {
    if (!state.hasFakes()) return;
    const { fellBack } = resolution;
    if (fellBack.testId || fellBack.context) {
      const queryOnly = resolveMcpIdentity({ headers: {}, url: req.url });
      for (const field of ["testId", "context"] as const) {
        if (!fellBack[field]) continue;
        const header = req.headers[IDENTITY_HEADERS[field]];
        const headerSent = typeof header === "string" && header !== "";
        if (headerSent && decodeMcpHeaderValue(header).fellBack) {
          state.onDecodeFallback(sessionId, {
            kind: "value",
            field,
            source: "header",
            raw: header,
            used: true,
          });
        }
        const fromQuery =
          queryOnly.ok && queryOnly.fellBack[field] ? queryOnly.identity[field] : null;
        if (fromQuery !== null) {
          state.onDecodeFallback(sessionId, {
            kind: "value",
            field,
            source: "query",
            raw: fromQuery,
            used: !headerSent,
          });
        }
      }
    }
    if (resolution.undecodedQueryNames) {
      state.onDecodeFallback(sessionId, { kind: "names", count: resolution.undecodedQueryNames });
    }
  };

  /**
   * Handle one MCP request. `mount` is the path the mount is served at (I9;
   * `/` for a standalone server). Resolves with what the request resolved,
   * for the mount's journal entry.
   */
  return async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: string,
    mount = "/",
    record: MCPRequestRecord = newMCPRequestRecord(),
  ): Promise<MCPRequestRecord> => {
    // DELETE handler: session teardown
    if (req.method === "DELETE") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (!sessionId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing mcp-session-id header" }));
        return record;
      }
      if (!state.sessions.has(sessionId)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found" }));
        return record;
      }
      // Journal only: identity inputs are not checked on a session teardown.
      const resolution = resolveMcpIdentity(req, state.sessions.get(sessionId));
      if (resolution.ok) record.identity = resolution.identity;
      state.sessions.delete(sessionId);
      state.onSessionClosed(sessionId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return record;
    }

    // Identity inputs (I1-I3, H4, H5): on every POST, a bad undeclared
    // override or a repeated field is rejected before the request is served.
    const headerSessionId = req.headers["mcp-session-id"] as string | undefined;
    const knownSession = headerSessionId ? state.sessions.get(headerSessionId) : undefined;

    // Parse the body to determine method for session validation
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      const resolution = resolveMcpIdentity(req, knownSession);
      if (!resolution.ok) {
        rejectIdentity(res, resolution);
        return record;
      }
      record.identity = resolution.identity;
      if (headerSessionId && knownSession) reportFallback(headerSessionId, req, resolution);
      // Let the dispatcher handle parse errors
      await dispatcher(req, res, body);
      return record;
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

      // I3: only the values the initialize request itself supplies are bound.
      const resolution = resolveMcpIdentity(req);
      if (!resolution.ok) {
        rejectIdentity(res, resolution);
        return record;
      }
      record.identity = resolution.identity;
      const { identity, supplied } = resolution;

      const sessionId = randomUUID();
      state.sessions.set(sessionId, {
        id: sessionId,
        initialized: false,
        createdAt: Date.now(),
        ...(supplied.testId && identity.testId !== null ? { testId: identity.testId } : {}),
        ...(supplied.context && identity.context !== null ? { context: identity.context } : {}),
        ...(supplied.undeclared && identity.undeclared !== null
          ? { undeclared: identity.undeclared }
          : {}),
      });
      reportFallback(sessionId, req, resolution);

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
      return record;
    }

    const resolution = resolveMcpIdentity(req, knownSession);
    if (!resolution.ok) {
      rejectIdentity(res, resolution);
      return record;
    }
    record.identity = resolution.identity;

    // Session validation for all other methods
    const sessionId = headerSessionId;
    if (!sessionId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing mcp-session-id header" }));
      return record;
    }
    if (!state.sessions.has(sessionId)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Session not found" }));
      return record;
    }
    reportFallback(sessionId, req, resolution);

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
      return record;
    }

    // Delegate to the JSON-RPC dispatcher for all other methods
    // The dispatcher invokes `tools/call` once per message that is an object
    // with `jsonrpc: "2.0"` and that method, in order (see B2 below).
    const notifications = (Array.isArray(parsed) ? parsed : [parsed])
      .filter((m): m is Record<string, unknown> => isToolsCall(m) && m.jsonrpc === "2.0")
      .map((m) => !("id" in m));
    const ctx: FakeRequestContext = {
      identity: resolution.identity,
      mount,
      notifications,
      calls: [],
    };
    contexts.set(req, ctx);
    await dispatcher(req, res, body);
    // B2: each tools/call message is journaled with its body and its own
    // outcome. The dispatcher invokes `tools/call` once per message that is
    // an object with `jsonrpc: "2.0"` and that method, in order, so the n-th
    // such message takes the n-th outcome.
    let next = 0;
    const messageOf = (message: unknown): MCPMessageRecord => {
      if (!isToolsCall(message)) return { body: null, mcpFake: null, error: null };
      const outcome = message.jsonrpc === "2.0" ? ctx.calls[next++] : undefined;
      return { body: message, mcpFake: outcome?.mcpFake ?? null, error: outcome?.error ?? null };
    };
    record.messages = Array.isArray(parsed) ? parsed.map(messageOf) : [messageOf(parsed)];
    return record;
  };
}

/** The identity header of each field whose value can fall back (H1). */
const IDENTITY_HEADERS: Record<McpDecodeField, string> = {
  testId: "x-test-id",
  context: "x-aimock-context",
};

/** A JSON-RPC message object whose method is `tools/call`. */
function isToolsCall(message: unknown): message is Record<string, unknown> {
  return (
    typeof message === "object" &&
    message !== null &&
    !Array.isArray(message) &&
    "method" in message &&
    message.method === "tools/call"
  );
}
