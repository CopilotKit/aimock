/**
 * Shared test helpers for drift detection test files.
 *
 * Provides httpPost, SSE parsers (for mock server output), common
 * fixtures, and server lifecycle management used by all provider-specific
 * drift test files.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import http from "node:http";
import { createServer, type ServerInstance } from "../../server.js";
import type { Fixture } from "../../types.js";
import type { WSTestClient } from "../ws-test-client.js";
import { extractShape, type SSEEventShape } from "./schema.js";

import { classifyGeminiMessage } from "./ws-providers.js";

export { classifyGeminiMessage };

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

export async function httpPost(
  url: string,
  body: object,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode!,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

/** POST raw string body (bypasses JSON.stringify — useful for malformed JSON tests). */
export async function httpPostRaw(
  url: string,
  rawBody: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode!,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on("error", reject);
    req.write(rawBody);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// SSE parsers
// ---------------------------------------------------------------------------

/** Parse data-only SSE blocks (OpenAI Chat Completions, Gemini). */
export function parseDataOnlySSE(body: string): object[] {
  return body
    .replace(/\r\n/g, "\n")
    .split("\n\n")
    .filter((block) => block.startsWith("data: ") && block.trim() !== "data: [DONE]")
    .map((block) => {
      // Rejoin continuation lines (data split across multiple lines)
      const json = block
        .split("\n")
        .map((line) => (line.startsWith("data: ") ? line.slice(6) : line))
        .join("");
      return JSON.parse(json);
    });
}

/** Parse typed SSE blocks with event: + data: (Anthropic, OpenAI Responses). */
export function parseTypedSSE(body: string): { type: string; data: Record<string, any> }[] {
  return body
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

/**
 * Parse data-only SSE blocks where the event_type is inside the JSON payload.
 * Used by the Gemini Interactions API which emits `data: {...}\n\n` with
 * `event_type` as a field in the JSON object.
 */
export function parseInteractionsSSE(
  body: string,
): { event_type: string; data: Record<string, any> }[] {
  return body
    .split("\n\n")
    .filter((block) => block.startsWith("data: ") && !block.includes("[DONE]"))
    .map((block) => {
      const json = block.slice(6);
      const data = JSON.parse(json) as Record<string, any>;
      return {
        event_type: (data.event_type as string) ?? "unknown",
        data,
      };
    });
}

// ---------------------------------------------------------------------------
// Common fixtures
// ---------------------------------------------------------------------------

export const TEXT_FIXTURE: Fixture = {
  match: { userMessage: "Say hello" },
  response: { content: "Hello!" },
};

export const TOOL_FIXTURE: Fixture = {
  match: { userMessage: "Weather in Paris" },
  response: {
    toolCalls: [{ name: "get_weather", arguments: '{"city":"Paris"}' }],
  },
};

export const THINKING_FIXTURE: Fixture = {
  match: { userMessage: "Think about hello" },
  response: { content: "Hello!", reasoning: "I need to consider..." },
};

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

export async function startDriftServer(): Promise<ServerInstance> {
  return createServer([TEXT_FIXTURE, TOOL_FIXTURE, THINKING_FIXTURE], {
    port: 0,
    chunkSize: 100,
  });
}

export async function stopDriftServer(instance: ServerInstance): Promise<void> {
  await new Promise<void>((r) => instance.server.close(() => r()));
}

// ---------------------------------------------------------------------------
// WebSocket helpers
// ---------------------------------------------------------------------------

export const GEMINI_WS_PATH =
  "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

/**
 * Collect mock WS messages until a terminal predicate fires.
 *
 * Uses a polling loop on waitForMessages() since ws-test-client doesn't
 * support predicate-based collection. The `skip` parameter tells us how
 * many messages have already been consumed so we don't re-read them.
 *
 * Throws if the terminal predicate never fires before the timeout expires.
 */
export async function collectMockWSMessages(
  client: WSTestClient,
  terminal: (msg: unknown) => boolean,
  timeoutMs = 15000,
  skip = 0,
): Promise<{ events: SSEEventShape[]; rawMessages: unknown[] }> {
  const rawMessages: unknown[] = [];
  const deadline = Date.now() + timeoutMs;
  let count = skip;
  let terminated = false;

  while (Date.now() < deadline) {
    const nextCount = count + 1;
    let msgs: string[];
    try {
      msgs = await client.waitForMessages(nextCount, Math.min(2000, deadline - Date.now()));
    } catch (e: unknown) {
      // Only suppress waitForMessages timeout — rethrow anything else
      if (e instanceof Error && e.message.includes("Timeout waiting for")) {
        if (Date.now() >= deadline) break;
        continue;
      }
      throw e;
    }
    // Only increment count after successful receipt
    count = nextCount;
    const latest = msgs[count - 1];
    let parsed: unknown;
    try {
      parsed = typeof latest === "string" ? JSON.parse(latest) : latest;
    } catch {
      throw new Error(
        `collectMockWSMessages: failed to parse message ${count}: ${String(latest).slice(0, 200)}`,
      );
    }
    rawMessages.push(parsed);
    if (terminal(parsed)) {
      terminated = true;
      break;
    }
  }

  if (!terminated) {
    throw new Error(
      `collectMockWSMessages timed out after ${timeoutMs}ms without terminal message. ` +
        `Collected ${rawMessages.length} messages.`,
    );
  }

  const events: SSEEventShape[] = rawMessages.map((msg) => {
    const m = msg as Record<string, any>;
    const type = m.type ?? classifyGeminiMessage(m as Record<string, unknown>);
    return { type, dataShape: extractShape(msg) };
  });

  return { events, rawMessages };
}
