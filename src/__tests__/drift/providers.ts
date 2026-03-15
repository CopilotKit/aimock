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

function assertOk(raw: string, status: number, context: string): void {
  if (status >= 400) {
    throw new Error(`${context}: API returned ${status}: ${raw.slice(0, 300)}`);
  }
}

function parseJsonResponse(raw: string, status: number, context: string): unknown {
  if (!raw) throw new Error(`${context}: empty response (status ${status})`);
  assertOk(raw, status, context);
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
    .filter((block) => block.startsWith("data: ") && !block.includes("[DONE]"))
    .map((block) => {
      // Rejoin continuation lines (data split across lines)
      const json = block
        .split("\n")
        .map((line) => (line.startsWith("data: ") ? line.slice(6) : line))
        .join("");
      return { data: JSON.parse(json) };
    });
}

/** Parse typed SSE (event: + data: format — Responses API, Claude) */
function parseTypedSSE(text: string): { type: string; data: unknown }[] {
  return normalizeLineEndings(text)
    .split("\n\n")
    .filter((block) => block.includes("event: ") && block.includes("data: "))
    .map((block) => {
      const eventMatch = block.match(/^event: (.+)$/m);
      const dataMatch = block.match(/^data: (.+)$/m);
      return {
        type: eventMatch![1],
        data: JSON.parse(dataMatch![1]),
      };
    });
}

function toSSEEventShapes(events: { type: string; data: unknown }[]): SSEEventShape[] {
  return events.map((e) => ({
    type: e.type,
    dataShape: extractShape(e.data),
  }));
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

export async function openaiChatNonStreaming(
  config: ProviderConfig,
  messages: { role: string; content: string }[],
  tools?: object[],
): Promise<FetchResult> {
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
}

export async function openaiChatStreaming(
  config: ProviderConfig,
  messages: { role: string; content: string }[],
  tools?: object[],
): Promise<StreamResult> {
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
}

export async function openaiResponsesNonStreaming(
  config: ProviderConfig,
  input: object[],
  tools?: object[],
): Promise<FetchResult> {
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
}

export async function openaiResponsesStreaming(
  config: ProviderConfig,
  input: object[],
  tools?: object[],
): Promise<StreamResult> {
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
}

// ---------------------------------------------------------------------------
// Anthropic Claude
// ---------------------------------------------------------------------------

export async function anthropicNonStreaming(
  config: ProviderConfig,
  messages: { role: string; content: string }[],
  tools?: object[],
): Promise<FetchResult> {
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
}

export async function anthropicStreaming(
  config: ProviderConfig,
  messages: { role: string; content: string }[],
  tools?: object[],
): Promise<StreamResult> {
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
}

// ---------------------------------------------------------------------------
// Google Gemini
// ---------------------------------------------------------------------------

export async function geminiNonStreaming(
  config: ProviderConfig,
  contents: object[],
  tools?: object[],
): Promise<FetchResult> {
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
  return { status: res.status, body: parseJsonResponse(raw, res.status, "Gemini"), raw };
}

export async function geminiStreaming(
  config: ProviderConfig,
  contents: object[],
  tools?: object[],
): Promise<StreamResult> {
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
  assertOk(raw, res.status, "Gemini streaming");
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
}

// ---------------------------------------------------------------------------
// Model listing
// ---------------------------------------------------------------------------

export async function listOpenAIModels(apiKey: string): Promise<string[]> {
  const res = await fetchWithRetry("https://api.openai.com/v1/models", {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  const raw = await res.text();
  const json = parseJsonResponse(raw, res.status, "OpenAI model list") as {
    data: { id: string }[];
  };
  return json.data.map((m) => m.id);
}

export async function listAnthropicModels(apiKey: string): Promise<string[]> {
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
}

export async function listGeminiModels(apiKey: string): Promise<string[]> {
  const res = await fetchWithRetry(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
    { method: "GET" },
  );

  const raw = await res.text();
  const json = parseJsonResponse(raw, res.status, "Gemini model list") as {
    models: { name: string }[];
  };
  // Gemini returns "models/gemini-2.5-flash" — strip prefix
  return json.models.map((m) => m.name.replace(/^models\//, ""));
}
