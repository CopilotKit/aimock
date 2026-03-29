import * as http from "node:http";
import * as https from "node:https";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type {
  ChatCompletionRequest,
  Fixture,
  FixtureResponse,
  RecordConfig,
  RecordProviderKey,
  ToolCall,
} from "./types.js";
import { getLastMessageByRole, getTextContent } from "./router.js";
import type { Logger } from "./logger.js";
import { collapseStreamingResponse } from "./stream-collapse.js";
import { writeErrorResponse } from "./sse-writer.js";
import { resolveUpstreamUrl } from "./url.js";

/**
 * Proxy an unmatched request to the real upstream provider, record the
 * response as a fixture on disk and in memory, then relay the response
 * back to the original client.
 *
 * Returns `true` if the request was proxied (provider configured),
 * `false` if no upstream URL is configured for the given provider key.
 */
export async function proxyAndRecord(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  request: ChatCompletionRequest,
  providerKey: RecordProviderKey,
  pathname: string,
  fixtures: Fixture[],
  defaults: { record?: RecordConfig; logger: Logger },
  rawBody?: string,
): Promise<boolean> {
  const record = defaults.record;
  if (!record) return false;

  const providers = record.providers;
  const upstreamUrl = providers[providerKey];

  if (!upstreamUrl) {
    defaults.logger.warn(`No upstream URL configured for provider "${providerKey}" — cannot proxy`);
    return false;
  }

  const fixturePath = record.fixturePath ?? "./fixtures/recorded";
  let target: URL;
  try {
    target = resolveUpstreamUrl(upstreamUrl, pathname);
  } catch {
    defaults.logger.error(`Invalid upstream URL for provider "${providerKey}": ${upstreamUrl}`);
    writeErrorResponse(
      res,
      502,
      JSON.stringify({
        error: { message: `Invalid upstream URL: ${upstreamUrl}`, type: "proxy_error" },
      }),
    );
    return true;
  }

  defaults.logger.warn(`NO FIXTURE MATCH — proxying to ${upstreamUrl}${pathname}`);

  // Forward only safe headers — auth and content negotiation
  const forwardHeaders: Record<string, string> = {};
  const headersToForward = ["authorization", "x-api-key", "api-key", "content-type", "accept"];
  for (const name of headersToForward) {
    const val = req.headers[name];
    if (val !== undefined) {
      forwardHeaders[name] = Array.isArray(val) ? val.join(", ") : val;
    }
  }

  const requestBody = rawBody ?? JSON.stringify(request);

  // Make upstream request
  let upstreamStatus: number;
  let upstreamHeaders: http.IncomingHttpHeaders;
  let upstreamBody: string;
  let rawBuffer: Buffer;

  try {
    const result = await makeUpstreamRequest(target, forwardHeaders, requestBody);
    upstreamStatus = result.status;
    upstreamHeaders = result.headers;
    upstreamBody = result.body;
    rawBuffer = result.rawBuffer;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown proxy error";
    defaults.logger.error(`Proxy request failed: ${msg}`);
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: { message: `Proxy to upstream failed: ${msg}`, type: "proxy_error" },
      }),
    );
    return true;
  }

  // Detect streaming response and collapse if necessary
  const contentType = upstreamHeaders["content-type"];
  const ctString = Array.isArray(contentType) ? contentType.join(", ") : (contentType ?? "");
  const isBinaryStream = ctString.toLowerCase().includes("application/vnd.amazon.eventstream");
  const collapsed = collapseStreamingResponse(
    ctString,
    providerKey,
    isBinaryStream ? rawBuffer : upstreamBody,
    defaults.logger,
  );

  let fixtureResponse: FixtureResponse;

  if (collapsed) {
    // Streaming response — use collapsed result
    defaults.logger.warn(`Streaming response detected (${ctString}) — collapsing to fixture`);
    if (collapsed.truncated) {
      defaults.logger.warn("Bedrock EventStream: CRC mismatch — response may be truncated");
    }
    if (collapsed.droppedChunks && collapsed.droppedChunks > 0) {
      defaults.logger.warn(`${collapsed.droppedChunks} chunk(s) dropped during stream collapse`);
    }
    if (collapsed.content === "" && (!collapsed.toolCalls || collapsed.toolCalls.length === 0)) {
      defaults.logger.warn("Stream collapse produced empty content — fixture may be incomplete");
    }
    if (collapsed.toolCalls && collapsed.toolCalls.length > 0) {
      if (collapsed.content) {
        defaults.logger.warn(
          "Collapsed response has both content and toolCalls — preferring toolCalls",
        );
      }
      fixtureResponse = { toolCalls: collapsed.toolCalls };
    } else {
      fixtureResponse = { content: collapsed.content ?? "" };
    }
  } else {
    // Non-streaming — try to parse as JSON
    let parsedResponse: unknown = null;
    try {
      parsedResponse = JSON.parse(upstreamBody);
    } catch {
      // Not JSON — could be an unknown format
      defaults.logger.warn("Upstream response is not valid JSON — saving as error fixture");
    }
    fixtureResponse = buildFixtureResponse(parsedResponse, upstreamStatus);
  }

  // Build the match criteria from the original request
  const fixtureMatch = buildFixtureMatch(request);

  // Build and save the fixture
  const fixture: Fixture = { match: fixtureMatch, response: fixtureResponse };

  // Check if the match is empty (all undefined values) — warn but still save to disk
  const matchValues = Object.values(fixtureMatch);
  const isEmptyMatch = matchValues.length === 0 || matchValues.every((v) => v === undefined);
  if (isEmptyMatch) {
    defaults.logger.warn(
      "Recorded fixture has empty match criteria — skipping in-memory registration",
    );
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${providerKey}-${timestamp}-${crypto.randomUUID().slice(0, 8)}.json`;
  const filepath = path.join(fixturePath, filename);

  let writtenToDisk = false;
  try {
    // Ensure fixture directory exists
    fs.mkdirSync(fixturePath, { recursive: true });

    // Collect warnings for the fixture file
    const warnings: string[] = [];
    if (isEmptyMatch) {
      warnings.push("Empty match criteria — this fixture will not match any request");
    }
    if (collapsed?.truncated) {
      warnings.push("Stream response was truncated — fixture may be incomplete");
    }

    // Auth headers are forwarded to upstream but excluded from saved fixtures for security
    const fileContent: Record<string, unknown> = { fixtures: [fixture] };
    if (warnings.length > 0) {
      fileContent._warning = warnings.join("; ");
    }
    fs.writeFileSync(filepath, JSON.stringify(fileContent, null, 2), "utf-8");
    writtenToDisk = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown filesystem error";
    defaults.logger.error(`Failed to save fixture to disk: ${msg}`);
    res.setHeader("X-LLMock-Record-Error", msg);
  }

  if (writtenToDisk) {
    // Register in memory so subsequent identical requests match (skip if empty match)
    if (!isEmptyMatch) {
      fixtures.push(fixture);
    }
    defaults.logger.warn(`Response recorded → ${filepath}`);
  } else {
    defaults.logger.warn(`Response relayed but NOT saved to disk — see error above`);
  }

  // Relay upstream response to client
  const relayHeaders: Record<string, string> = {};
  if (ctString) {
    relayHeaders["Content-Type"] = ctString;
  }
  res.writeHead(upstreamStatus, relayHeaders);
  res.end(isBinaryStream ? rawBuffer : upstreamBody);

  return true;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function makeUpstreamRequest(
  target: URL,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string; rawBuffer: Buffer }> {
  return new Promise((resolve, reject) => {
    const transport = target.protocol === "https:" ? https : http;
    const UPSTREAM_TIMEOUT_MS = 30_000;
    const BODY_TIMEOUT_MS = 30_000;
    const req = transport.request(
      target,
      {
        method: "POST",
        timeout: UPSTREAM_TIMEOUT_MS,
        headers: {
          ...headers,
          "Content-Length": Buffer.byteLength(body).toString(),
        },
      },
      (res) => {
        res.setTimeout(BODY_TIMEOUT_MS, () => {
          req.destroy(new Error(`Upstream response timed out after ${BODY_TIMEOUT_MS / 1000}s`));
        });
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          const rawBuffer = Buffer.concat(chunks);
          resolve({
            status: res.statusCode ?? 500,
            headers: res.headers,
            body: rawBuffer.toString(),
            rawBuffer,
          });
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(
        new Error(
          `Upstream request timed out after ${UPSTREAM_TIMEOUT_MS / 1000}s: ${target.href}`,
        ),
      );
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/**
 * Detect the response format from the parsed upstream JSON and convert
 * it into an llmock FixtureResponse.
 */
function buildFixtureResponse(parsed: unknown, status: number): FixtureResponse {
  if (parsed === null || parsed === undefined) {
    // Raw / unparseable response — save as error
    return {
      error: { message: "Upstream returned non-JSON response", type: "proxy_error" },
      status,
    };
  }

  const obj = parsed as Record<string, unknown>;

  // Error response
  if (obj.error) {
    const err = obj.error as Record<string, unknown>;
    return {
      error: {
        message: String(err.message ?? "Unknown error"),
        type: String(err.type ?? "api_error"),
        code: err.code ? String(err.code) : undefined,
      },
      status,
    };
  }

  // OpenAI embeddings: { data: [{ embedding: [...] }] }
  if (Array.isArray(obj.data) && obj.data.length > 0) {
    const first = obj.data[0] as Record<string, unknown>;
    if (Array.isArray(first.embedding)) {
      return { embedding: first.embedding as number[] };
    }
  }

  // Direct embedding: { embedding: [...] }
  if (Array.isArray(obj.embedding)) {
    return { embedding: obj.embedding as number[] };
  }

  // OpenAI chat completion: { choices: [{ message: { content, tool_calls } }] }
  if (Array.isArray(obj.choices) && obj.choices.length > 0) {
    const choice = obj.choices[0] as Record<string, unknown>;
    const message = choice.message as Record<string, unknown> | undefined;
    if (message) {
      // Tool calls
      if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        const toolCalls: ToolCall[] = (message.tool_calls as Array<Record<string, unknown>>).map(
          (tc) => {
            const fn = tc.function as Record<string, unknown>;
            return {
              name: String(fn.name),
              arguments: String(fn.arguments),
            };
          },
        );
        return { toolCalls };
      }
      // Text content
      if (typeof message.content === "string") {
        return { content: message.content };
      }
    }
  }

  // Anthropic: { content: [{ type: "text", text: "..." }] } or tool_use
  if (Array.isArray(obj.content) && obj.content.length > 0) {
    const blocks = obj.content as Array<Record<string, unknown>>;
    // Check for tool_use blocks first
    const toolUseBlocks = blocks.filter((b) => b.type === "tool_use");
    if (toolUseBlocks.length > 0) {
      const toolCalls: ToolCall[] = toolUseBlocks.map((b) => ({
        name: String(b.name),
        arguments: typeof b.input === "string" ? b.input : JSON.stringify(b.input),
      }));
      return { toolCalls };
    }
    // Text blocks
    const textBlock = blocks.find((b) => b.type === "text");
    if (textBlock && typeof textBlock.text === "string") {
      return { content: textBlock.text };
    }
  }

  // Gemini: { candidates: [{ content: { parts: [{ text: "..." }] } }] }
  if (Array.isArray(obj.candidates) && obj.candidates.length > 0) {
    const candidate = obj.candidates[0] as Record<string, unknown>;
    const content = candidate.content as Record<string, unknown> | undefined;
    if (content && Array.isArray(content.parts)) {
      const parts = content.parts as Array<Record<string, unknown>>;
      // Tool calls (functionCall)
      const fnCallParts = parts.filter((p) => p.functionCall);
      if (fnCallParts.length > 0) {
        const toolCalls: ToolCall[] = fnCallParts.map((p) => {
          const fc = p.functionCall as Record<string, unknown>;
          return {
            name: String(fc.name),
            arguments: typeof fc.args === "string" ? fc.args : JSON.stringify(fc.args),
          };
        });
        return { toolCalls };
      }
      // Text
      const textPart = parts.find((p) => typeof p.text === "string");
      if (textPart && typeof textPart.text === "string") {
        return { content: textPart.text };
      }
    }
  }

  // Bedrock Converse: { output: { message: { role, content: [{ text }, { toolUse }] } } }
  if (obj.output && typeof obj.output === "object") {
    const output = obj.output as Record<string, unknown>;
    const msg = output.message as Record<string, unknown> | undefined;
    if (msg && Array.isArray(msg.content)) {
      const blocks = msg.content as Array<Record<string, unknown>>;
      const toolUseBlocks = blocks.filter((b) => b.toolUse);
      if (toolUseBlocks.length > 0) {
        const toolCalls: ToolCall[] = toolUseBlocks.map((b) => {
          const tu = b.toolUse as Record<string, unknown>;
          return {
            name: String(tu.name ?? ""),
            arguments: typeof tu.input === "string" ? tu.input : JSON.stringify(tu.input),
          };
        });
        return { toolCalls };
      }
      const textBlock = blocks.find((b) => typeof b.text === "string");
      if (textBlock && typeof textBlock.text === "string") {
        return { content: textBlock.text };
      }
    }
  }

  // Ollama: { message: { content: "...", tool_calls: [...] } }
  if (obj.message && typeof obj.message === "object") {
    const msg = obj.message as Record<string, unknown>;
    // Tool calls (check before content — Ollama sends content: "" alongside tool_calls)
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const toolCalls: ToolCall[] = (msg.tool_calls as Array<Record<string, unknown>>)
        .filter((tc) => tc.function != null)
        .map((tc) => {
          const fn = tc.function as Record<string, unknown>;
          return {
            name: String(fn.name ?? ""),
            arguments:
              typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments),
          };
        });
      return { toolCalls };
    }
    if (typeof msg.content === "string" && msg.content.length > 0) {
      return { content: msg.content };
    }
    // Ollama message with content array (like Cohere)
    if (Array.isArray(msg.content) && msg.content.length > 0) {
      const first = msg.content[0] as Record<string, unknown>;
      if (typeof first.text === "string") {
        return { content: first.text };
      }
    }
  }

  // Fallback: unknown format — save as error
  return {
    error: {
      message: "Could not detect response format from upstream",
      type: "proxy_error",
    },
    status,
  };
}

/**
 * Derive fixture match criteria from the original request.
 */
function buildFixtureMatch(request: ChatCompletionRequest): {
  userMessage?: string;
  inputText?: string;
} {
  // Embedding request
  if (request.embeddingInput) {
    return { inputText: request.embeddingInput };
  }

  // Chat request — match on the last user message
  const lastUser = getLastMessageByRole(request.messages ?? [], "user");
  if (lastUser) {
    const text = getTextContent(lastUser.content);
    if (text) {
      return { userMessage: text };
    }
  }

  return {};
}
