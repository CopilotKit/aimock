/**
 * Helpers for the fakes-report plugin cases: a real v1 MCP SDK client on a
 * URL plus headers, and one `get_weather` call.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const FIXTURES = new URL("./fixtures", import.meta.url).pathname;

export async function withClient<T>(
  url: string,
  headers: Record<string, string> | undefined,
  fn: (c: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ name: "fakes-report-case", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), headers ? { requestInit: { headers } } : {}),
  );
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

/** The text of a `get_weather` call, or the error message an agent would swallow. */
export async function weather(c: Client, city: string): Promise<string> {
  try {
    const result = await c.callTool({ name: "get_weather", arguments: { city } });
    const content = (result.content ?? []) as Array<{ text?: string }>;
    return content.map((x) => x.text ?? "").join("");
  } catch (err) {
    return `tool error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export type Mode = "off" | "warn" | "fail";

export function modeFromEnv(): Mode {
  const mode = process.env.AIMOCK_CASE_FAKES_REPORT ?? "fail";
  if (mode !== "off" && mode !== "warn" && mode !== "fail") throw new Error(`bad mode ${mode}`);
  return mode;
}

/** The plugin under test: `AIMOCK_CASE_PLUGIN=jest` picks the Jest plugin (vitest globals). */
export async function pluginUnderTest(): Promise<typeof import("../../../vitest.js").useAimock> {
  if (process.env.AIMOCK_CASE_PLUGIN === "jest") {
    return (await import("../../../jest.js")).useAimock;
  }
  return (await import("../../../vitest.js")).useAimock;
}
