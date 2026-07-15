/**
 * Raw fetch() clients for real provider APIs.
 *
 * Uses fetch directly (no SDKs) to avoid SDK normalization masking real API
 * quirks. SSE parsing, retry logic, and model listing endpoints.
 */

import { extractShape, type SSEEventShape } from "./schema.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProviderConfig {
  apiKey: string;
}

interface FetchResult {
  status: number;
  body: unknown;
  raw: string;
}

interface StreamResult {
  status: number;
  events: SSEEventShape[];
  rawEvents: { type: string; data: unknown }[];
}

/**
 * Structured error carrying the HTTP status code as a first-class numeric field.
 *
 * Downstream classifiers (Slack alerts, preflight checks) MUST key off
 * `error.status` — never parse the prose message string.
 *
 *   401 | 403 → stale-key      (replace the API key)
 *   429       → rate-limited   (back off)
 *   5xx       → infra-transient (retry / alert ops)
 *   network   → no status field (instanceof check first)
 */
export class InfraError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "InfraError";
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Retry helper
// ---------------------------------------------------------------------------

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503]);

async function fetchWithRetry(url: string, init: RequestInit, maxRetries = 3): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetch(url, init);
      if (RETRYABLE_STATUSES.has(res.status) && attempt < maxRetries - 1) {
        console.warn(
          `Retry ${attempt + 1}/${maxRetries} after ${res.status} for ${url.slice(0, 80)}`,
        );
        await res.text(); // consume body to free socket
        const backoff = Math.pow(2, attempt) * 1000;
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      return res;
    } catch (err) {
      lastError = err as Error;
      if (attempt < maxRetries - 1) {
        const backoff = Math.pow(2, attempt) * 1000;
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }
  throw lastError ?? new Error("fetch failed after retries");
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/** Redact API keys from query parameters in URLs for safe error messages */
function redactUrl(url: string): string {
  return url.replace(/([?&])(api[-_]?key|key|token|access_token)=[^&]+/gi, "$1$2=REDACTED");
}

function assertOk(raw: string, status: number, context: string, url?: string): void {
  if (status >= 400) {
    const urlSuffix = url ? ` (${redactUrl(url)})` : "";
    throw new InfraError(
      `${context}: API returned ${status}${urlSuffix}: ${raw.slice(0, 300)}`,
      status,
    );
  }
}

function parseJsonResponse(raw: string, status: number, context: string, url?: string): unknown {
  if (!raw) throw new Error(`${context}: empty response (status ${status})`);
  assertOk(raw, status, context, url);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${context}: failed to parse JSON (status ${status}): ${raw.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------

/** Normalize \r\n to \n for SSE parsing (some providers use \r\n) */
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/** Parse data-only SSE (OpenAI Chat Completions, Gemini) */
function parseDataOnlySSE(text: string): { data: unknown }[] {
  return normalizeLineEndings(text)
    .split("\n\n")
    .filter((block) => block.startsWith("data: ") && block.trim() !== "data: [DONE]")
    .map((block) => {
      // Rejoin continuation lines (data split across lines)
      const json = block
        .split("\n")
        .map((line) => (line.startsWith("data: ") ? line.slice(6) : line))
        .join("");
      try {
        return { data: JSON.parse(json) };
      } catch (err) {
        throw new Error(`Malformed SSE JSON in frame: ${json.slice(0, 100)}`, { cause: err });
      }
    });
}

/** Parse typed SSE (event: + data: format — Responses API, Claude) */
function parseTypedSSE(text: string): { type: string; data: unknown }[] {
  return normalizeLineEndings(text)
    .split("\n\n")
    .filter((block) => block.includes("event: ") && block.includes("data: "))
    .map((block) => {
      const eventMatch = block.match(/^event: (.*)$/m);
      if (!eventMatch) {
        throw new Error("Malformed SSE block: " + block.slice(0, 100));
      }
      // Handle multi-line data: collect all data lines and join them
      const json = block
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .join("");
      if (!json) {
        throw new Error("Malformed SSE block (no data): " + block.slice(0, 100));
      }
      try {
        return {
          type: eventMatch[1],
          data: JSON.parse(json),
        };
      } catch (err) {
        throw new Error(`Malformed SSE JSON in frame: ${json.slice(0, 100)}`, { cause: err });
      }
    });
}

function toSSEEventShapes(events: { type: string; data: unknown }[]): SSEEventShape[] {
  return events.map((e) => ({
    type: e.type,
    dataShape: extractShape(e.data),
  }));
}

// ---------------------------------------------------------------------------
// Infra-error tagging
// ---------------------------------------------------------------------------

function withInfraErrorTag<T>(provider: string, fn: () => Promise<T>): Promise<T> {
  return fn().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    const status = err instanceof InfraError ? err.status : 0;
    throw new InfraError(`INFRA_ERROR: ${provider} — ${msg}`, status);
  });
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

export async function openaiChatNonStreaming(
  config: ProviderConfig,
  messages: { role: string; content: string }[],
  tools?: object[],
): Promise<FetchResult> {
  return withInfraErrorTag("OpenAI Chat", async () => {
    const body: Record<string, unknown> = {
      model: "gpt-4o-mini",
      messages,
      stream: false,
      max_tokens: 10,
    };
    if (tools) body.tools = tools;

    const res = await fetchWithRetry("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const raw = await res.text();
    return { status: res.status, body: parseJsonResponse(raw, res.status, "OpenAI Chat"), raw };
  });
}

export async function openaiChatStreaming(
  config: ProviderConfig,
  messages: { role: string; content: string }[],
  tools?: object[],
): Promise<StreamResult> {
  return withInfraErrorTag("OpenAI Chat", async () => {
    const body: Record<string, unknown> = {
      model: "gpt-4o-mini",
      messages,
      stream: true,
      max_tokens: 10,
    };
    if (tools) body.tools = tools;

    const res = await fetchWithRetry("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const raw = await res.text();
    assertOk(raw, res.status, "OpenAI Chat streaming");
    const parsed = parseDataOnlySSE(raw);
    const rawEvents = parsed.map((p) => ({
      type: "chat.completion.chunk",
      data: p.data,
    }));
    return {
      status: res.status,
      events: toSSEEventShapes(rawEvents),
      rawEvents,
    };
  });
}

export async function openaiResponsesNonStreaming(
  config: ProviderConfig,
  input: object[],
  tools?: object[],
): Promise<FetchResult> {
  return withInfraErrorTag("OpenAI Responses", async () => {
    const body: Record<string, unknown> = {
      model: "gpt-4o-mini",
      input,
      stream: false,
      max_output_tokens: 50,
    };
    if (tools) body.tools = tools;

    const res = await fetchWithRetry("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const raw = await res.text();
    return {
      status: res.status,
      body: parseJsonResponse(raw, res.status, "OpenAI Responses"),
      raw,
    };
  });
}

export async function openaiResponsesStreaming(
  config: ProviderConfig,
  input: object[],
  tools?: object[],
): Promise<StreamResult> {
  return withInfraErrorTag("OpenAI Responses", async () => {
    const body: Record<string, unknown> = {
      model: "gpt-4o-mini",
      input,
      stream: true,
      max_output_tokens: 50,
    };
    if (tools) body.tools = tools;

    const res = await fetchWithRetry("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const raw = await res.text();
    assertOk(raw, res.status, "OpenAI Responses streaming");
    const rawEvents = parseTypedSSE(raw);
    return {
      status: res.status,
      events: toSSEEventShapes(rawEvents),
      rawEvents,
    };
  });
}

// ---------------------------------------------------------------------------
// Anthropic Claude
// ---------------------------------------------------------------------------

export async function anthropicNonStreaming(
  config: ProviderConfig,
  messages: { role: string; content: string }[],
  tools?: object[],
): Promise<FetchResult> {
  return withInfraErrorTag("Anthropic", async () => {
    const body: Record<string, unknown> = {
      model: "claude-haiku-4-5-20251001",
      messages,
      max_tokens: 10,
      stream: false,
    };
    if (tools) body.tools = tools;

    const res = await fetchWithRetry("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    const raw = await res.text();
    return { status: res.status, body: parseJsonResponse(raw, res.status, "Anthropic"), raw };
  });
}

export async function anthropicStreaming(
  config: ProviderConfig,
  messages: { role: string; content: string }[],
  tools?: object[],
): Promise<StreamResult> {
  return withInfraErrorTag("Anthropic", async () => {
    const body: Record<string, unknown> = {
      model: "claude-haiku-4-5-20251001",
      messages,
      max_tokens: 10,
      stream: true,
    };
    if (tools) body.tools = tools;

    const res = await fetchWithRetry("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    const raw = await res.text();
    assertOk(raw, res.status, "Anthropic streaming");
    const rawEvents = parseTypedSSE(raw);
    return {
      status: res.status,
      events: toSSEEventShapes(rawEvents),
      rawEvents,
    };
  });
}

// ---------------------------------------------------------------------------
// Google Gemini
// ---------------------------------------------------------------------------

export async function geminiNonStreaming(
  config: ProviderConfig,
  contents: object[],
  tools?: object[],
): Promise<FetchResult> {
  return withInfraErrorTag("Gemini", async () => {
    // Gemini 2.5+ uses thinking tokens from the output budget, so we need
    // more headroom than other providers to get actual content back
    const body: Record<string, unknown> = {
      contents,
      generationConfig: { maxOutputTokens: 100 },
    };
    if (tools) body.tools = tools;

    // Gemini requires API key as query parameter per Google's REST API design
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${config.apiKey}`;
    const res = await fetchWithRetry(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const raw = await res.text();
    return { status: res.status, body: parseJsonResponse(raw, res.status, "Gemini", url), raw };
  });
}

export async function geminiStreaming(
  config: ProviderConfig,
  contents: object[],
  tools?: object[],
): Promise<StreamResult> {
  return withInfraErrorTag("Gemini", async () => {
    const body: Record<string, unknown> = {
      contents,
      generationConfig: { maxOutputTokens: 100 },
    };
    if (tools) body.tools = tools;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=${config.apiKey}`;
    const res = await fetchWithRetry(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const raw = await res.text();
    assertOk(raw, res.status, "Gemini streaming", url);
    const parsed = parseDataOnlySSE(raw);
    const rawEvents = parsed.map((p) => ({
      type: "gemini.chunk",
      data: p.data,
    }));
    return {
      status: res.status,
      events: toSSEEventShapes(rawEvents),
      rawEvents,
    };
  });
}

// ---------------------------------------------------------------------------
// Google Gemini Interactions API (Beta)
// ---------------------------------------------------------------------------

export async function geminiInteractionsNonStreaming(
  config: ProviderConfig,
  input: string,
  tools?: object[],
): Promise<FetchResult> {
  return withInfraErrorTag("Gemini Interactions", async () => {
    const body: Record<string, unknown> = {
      model: "gemini-2.5-flash",
      input,
      stream: false,
    };
    if (tools) body.tools = tools;

    const res = await fetchWithRetry(
      `https://generativelanguage.googleapis.com/v1beta/interactions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": config.apiKey,
        },
        body: JSON.stringify(body),
      },
    );

    const raw = await res.text();
    return {
      status: res.status,
      body: parseJsonResponse(raw, res.status, "Gemini Interactions"),
      raw,
    };
  });
}

export async function geminiInteractionsStreaming(
  config: ProviderConfig,
  input: string,
  tools?: object[],
): Promise<StreamResult> {
  return withInfraErrorTag("Gemini Interactions", async () => {
    const body: Record<string, unknown> = {
      model: "gemini-2.5-flash",
      input,
      stream: true,
    };
    if (tools) body.tools = tools;

    const res = await fetchWithRetry(
      `https://generativelanguage.googleapis.com/v1beta/interactions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": config.apiKey,
        },
        body: JSON.stringify(body),
      },
    );

    const raw = await res.text();
    assertOk(raw, res.status, "Gemini Interactions streaming");
    // Interactions uses data-only SSE (data: {...}\n\n) with event_type inside the JSON
    const parsed = parseDataOnlySSE(raw);
    const rawEvents = parsed.map((p) => {
      const data = p.data as Record<string, unknown>;
      return {
        type: (data.event_type as string) ?? "unknown",
        data: data,
      };
    });
    return {
      status: res.status,
      events: toSSEEventShapes(rawEvents),
      rawEvents,
    };
  });
}

export async function geminiInteractionsNonStreamingSteps(
  config: ProviderConfig,
  input: string,
  tools?: object[],
): Promise<FetchResult> {
  return withInfraErrorTag("Gemini Interactions", async () => {
    const body: Record<string, unknown> = {
      model: "gemini-2.5-flash",
      input: [{ type: "user_input", content: [{ type: "text", text: input }] }],
      stream: false,
    };
    if (tools) body.tools = tools;

    const res = await fetchWithRetry(
      `https://generativelanguage.googleapis.com/v1beta/interactions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": config.apiKey,
        },
        body: JSON.stringify(body),
      },
    );

    const raw = await res.text();
    return {
      status: res.status,
      body: parseJsonResponse(raw, res.status, "Gemini Interactions"),
      raw,
    };
  });
}

export async function geminiInteractionsStreamingSteps(
  config: ProviderConfig,
  input: string,
  tools?: object[],
): Promise<StreamResult> {
  return withInfraErrorTag("Gemini Interactions", async () => {
    const body: Record<string, unknown> = {
      model: "gemini-2.5-flash",
      input: [{ type: "user_input", content: [{ type: "text", text: input }] }],
      stream: true,
    };
    if (tools) body.tools = tools;

    const res = await fetchWithRetry(
      `https://generativelanguage.googleapis.com/v1beta/interactions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": config.apiKey,
        },
        body: JSON.stringify(body),
      },
    );

    const raw = await res.text();
    assertOk(raw, res.status, "Gemini Interactions streaming");
    // Interactions uses data-only SSE (data: {...}\n\n) with event_type inside the JSON
    const parsed = parseDataOnlySSE(raw);
    const rawEvents = parsed.map((p) => {
      const data = p.data as Record<string, unknown>;
      return {
        type: (data.event_type as string) ?? "unknown",
        data: data,
      };
    });
    return {
      status: res.status,
      events: toSSEEventShapes(rawEvents),
      rawEvents,
    };
  });
}

// ---------------------------------------------------------------------------
// OpenAI Embeddings
// ---------------------------------------------------------------------------

export async function openaiEmbeddings(
  config: ProviderConfig,
  input: string | string[],
): Promise<FetchResult> {
  return withInfraErrorTag("OpenAI Embeddings", async () => {
    const body = {
      model: "text-embedding-3-small",
      input,
    };

    const res = await fetchWithRetry("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const raw = await res.text();
    return {
      status: res.status,
      body: parseJsonResponse(raw, res.status, "OpenAI Embeddings"),
      raw,
    };
  });
}

// ---------------------------------------------------------------------------
// Model listing
// ---------------------------------------------------------------------------

export async function listOpenAIModels(apiKey: string): Promise<string[]> {
  return withInfraErrorTag("OpenAI Models", async () => {
    const res = await fetchWithRetry("https://api.openai.com/v1/models", {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    const raw = await res.text();
    const json = parseJsonResponse(raw, res.status, "OpenAI model list") as {
      data: { id: string }[];
    };
    return json.data.map((m) => m.id);
  });
}

export async function listAnthropicModels(apiKey: string): Promise<string[]> {
  return withInfraErrorTag("Anthropic Models", async () => {
    const res = await fetchWithRetry("https://api.anthropic.com/v1/models", {
      method: "GET",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
    });

    const raw = await res.text();
    const json = parseJsonResponse(raw, res.status, "Anthropic model list") as {
      data: { id: string }[];
    };
    return json.data.map((m) => m.id);
  });
}

export async function listGeminiModels(apiKey: string): Promise<string[]> {
  return withInfraErrorTag("Gemini Models", async () => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
    const res = await fetchWithRetry(url, { method: "GET" });

    const raw = await res.text();
    const json = parseJsonResponse(raw, res.status, "Gemini model list", url) as {
      models: { name: string }[];
    };
    // Gemini returns "models/gemini-2.5-flash" — strip prefix
    return json.models.map((m) => m.name.replace(/^models\//, ""));
  });
}
