import type * as http from "node:http";
import { claudeToCompletionRequest } from "./messages.js";
import { geminiToCompletionRequest } from "./gemini.js";
import { flattenHeaders, isJsonObject, resolveRequestId } from "./helpers.js";
import type { Journal } from "./journal.js";
import type { ChatCompletionRequest, HandlerDefaults } from "./types.js";
import { renderError } from "./response/errors.js";
import { resolvePolicy } from "./response/policy.js";
import { missingRequiredHeader } from "./response/profiles.js";
import { estimatePromptTokens, estimateTokens } from "./response/usage/estimate.js";

type ClaudeRequest = Parameters<typeof claudeToCompletionRequest>[0];
type GeminiRequest = Parameters<typeof geminiToCompletionRequest>[0];

function toolsError(tools: unknown, google: boolean): string | undefined {
  if (tools === undefined) return;
  if (!Array.isArray(tools)) return "tools must be an array";
  for (const tool of tools) {
    if (!isJsonObject(tool)) return "tools entries must be objects";
    if (google && tool.functionDeclarations !== undefined) {
      if (!Array.isArray(tool.functionDeclarations)) return "functionDeclarations must be an array";
      if (tool.functionDeclarations.some((declaration: unknown) => !isJsonObject(declaration)))
        return "functionDeclarations entries must be objects";
    }
  }
}

function hasObjectText(blocks: unknown[], google: boolean, includeThought = false): boolean {
  return blocks.some(
    (block) =>
      isJsonObject(block) &&
      (google ? includeThought || !block.thought : block.type === "text") &&
      block.text !== null &&
      typeof block.text === "object",
  );
}

function contentError(contents: unknown, google: boolean): string | undefined {
  if (!Array.isArray(contents))
    return google ? "contents must be an array" : "messages must be an array";
  for (const content of contents) {
    if (!isJsonObject(content))
      return google ? "contents entries must be objects" : "messages entries must be objects";
    const parts = google ? content.parts : content.content;
    if (google) {
      if (parts !== undefined && !Array.isArray(parts)) return "parts must be an array";
    } else if (typeof parts !== "string" && !Array.isArray(parts)) {
      return "message content must be a string or an array";
    }
    if (Array.isArray(parts) && parts.some((part: unknown) => !isJsonObject(part)))
      return "content blocks must be objects";
    const role = google ? (content.role ?? "user") : content.role;
    const consumed = google
      ? role === "user" || role === "model"
      : role === "user" || role === "assistant";
    if (Array.isArray(parts) && consumed) {
      if (hasObjectText(parts, google)) return "content text must not be an object or array";
      if (
        !google &&
        role === "user" &&
        parts.some(
          (block) =>
            isJsonObject(block) &&
            block.type === "tool_result" &&
            Array.isArray(block.content) &&
            hasObjectText(block.content, false),
        )
      )
        return "tool_result content text must not be an object or array";
    }
  }
}

/** Counts always use the existing conversion and estimator; no fixture or egress path. */
export function handleCountTokens(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  raw: string,
  google: boolean,
  model: string,
  journal: Journal,
  defaults: HandlerDefaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
): void {
  setCorsHeaders(res);
  const reject = (message: string, requestId?: string): void => {
    journal.add({
      method: req.method ?? "POST",
      path: req.url ?? "?",
      headers: flattenHeaders(req.headers),
      body: null,
      response: { status: 400, fixture: null, source: "internal" },
    });
    const rendered = google
      ? renderError("gemini", "fixture", { message, bodyCode: 400, status: "INVALID_ARGUMENT" })
      : renderError("messages", "thinking", { message, requestId });
    res.writeHead(400, { "Content-Type": "application/json", ...rendered.headers });
    res.end(rendered.body);
  };
  const policy = resolvePolicy(defaults, req.headers);
  const missingHeader =
    !google && policy.requiredHeaders === "enforce"
      ? missingRequiredHeader("messages", req.headers)
      : undefined;
  if (missingHeader) {
    reject(`${missingHeader}: header is required`, resolveRequestId(req.headers).id);
    return;
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch (error) {
    reject(`Malformed JSON body: ${error instanceof Error ? error.message : "unknown"}`);
    return;
  }
  if (google && isJsonObject(body) && body.generateContentRequest !== undefined)
    body = body.generateContentRequest;
  if (!isJsonObject(body)) {
    reject("Request body must be an object");
    return;
  }
  const invalidContent = contentError(google ? body.contents : body.messages, google);
  const invalidTools = toolsError(body.tools, google);
  const invalidBody = invalidContent ?? invalidTools;
  if (invalidBody) {
    reject(invalidBody);
    return;
  }
  if (!google && body.system !== undefined) {
    if (typeof body.system !== "string" && !Array.isArray(body.system)) {
      reject("system must be a string or an array");
      return;
    }
    if (Array.isArray(body.system) && body.system.some((block: unknown) => !isJsonObject(block))) {
      reject("system blocks must be objects");
      return;
    }
    if (Array.isArray(body.system) && hasObjectText(body.system, false)) {
      reject("system text must not be an object or array");
      return;
    }
  }
  if (google && body.systemInstruction !== undefined && body.systemInstruction !== null) {
    if (
      !isJsonObject(body.systemInstruction) ||
      (body.systemInstruction.parts !== undefined &&
        body.systemInstruction.parts !== null &&
        !Array.isArray(body.systemInstruction.parts))
    ) {
      reject("systemInstruction must be an object with an array of parts");
      return;
    }
    if (
      Array.isArray(body.systemInstruction.parts) &&
      body.systemInstruction.parts.some((part: unknown) => !isJsonObject(part))
    ) {
      reject("systemInstruction parts must be objects");
      return;
    }
    if (
      Array.isArray(body.systemInstruction.parts) &&
      hasObjectText(body.systemInstruction.parts, true, true)
    ) {
      reject("systemInstruction text must not be an object or array");
      return;
    }
  }
  // The guards above validate the fields consumed by the existing converters.
  const converted: ChatCompletionRequest = google
    ? geminiToCompletionRequest(body as GeminiRequest, model, false)
    : claudeToCompletionRequest({
        ...body,
        model: typeof body.model === "string" ? body.model : "",
        max_tokens: 0,
      } as ClaudeRequest);
  const count =
    estimatePromptTokens(converted.messages) +
    (converted.tools === undefined ? 0 : estimateTokens(JSON.stringify(converted.tools)));
  journal.add({
    method: req.method ?? "POST",
    path: req.url ?? "?",
    headers: flattenHeaders(req.headers),
    body: converted,
    response: { status: 200, fixture: null, source: "internal" },
  });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(google ? { totalTokens: count } : { input_tokens: count }));
}
