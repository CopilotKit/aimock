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

// ---------------------------------------------------------------------------
// SSE parsers
// ---------------------------------------------------------------------------

/** Parse data-only SSE blocks (OpenAI Chat Completions, Gemini). */
export function parseDataOnlySSE(body: string): object[] {
  return body
    .split("\n\n")
    .filter((block) => block.startsWith("data: ") && !block.includes("[DONE]"))
    .map((block) => JSON.parse(block.slice(6)));
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

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

export async function startDriftServer(): Promise<ServerInstance> {
  return createServer([TEXT_FIXTURE, TOOL_FIXTURE], {
    port: 0,
    chunkSize: 100,
  });
}

export async function stopDriftServer(instance: ServerInstance): Promise<void> {
  await new Promise<void>((r) => instance.server.close(() => r()));
}
