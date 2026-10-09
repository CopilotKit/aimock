/**
 * Helpers shared by the two pipeline tests (WF2 Mastra, WF3 LangGraph).
 *
 * `WF_EXPECT=scripted` (run.sh sets it for `fixtures/workflow.json`) makes a
 * test assert each step's exact scripted answer. With any other value the test
 * body only runs the pipeline and prints what each step got, like a test that
 * trusts the framework to surface tool problems. Then the fakes report in
 * `afterEach` is the only thing that can fail the test.
 */
import { expect } from "vitest";

export const SCRIPTED = process.env.WF_EXPECT === "scripted";

/** The text of an MCP `CallToolResult`, or a description of anything else. */
export function toolText(result: unknown): string {
  if (result && typeof result === "object" && "content" in result) {
    const content = (result as { content: unknown }).content;
    if (Array.isArray(content)) {
      const text = content
        .map((c) => (c && typeof c === "object" && "text" in c ? String(c.text) : ""))
        .join("");
      const isError = (result as { isError?: unknown }).isError === true;
      return isError ? `tool error: ${text}` : text;
    }
  }
  return `unexpected result: ${JSON.stringify(result)}`;
}

/** What a caught error says, as the step output a framework would keep. */
export function caught(err: unknown): string {
  const message =
    err && typeof err === "object" && "message" in err ? String(err.message) : String(err);
  const data = err && typeof err === "object" && "data" in err ? err.data : undefined;
  return `caught: ${message}${data === undefined ? "" : ` data=${JSON.stringify(data)}`}`;
}

/** The answers in `fixtures/workflow.json`; the third is how the caller sees the `error` entry. */
export function assertScripted(outputs: string[], errorOutput: string): void {
  expect(outputs).toEqual(["pending", "shipped", errorOutput]);
}

/** `AIMOCK_FAKES_REPORT=off` shows what the same test does without the report. */
export const reportMode = (process.env.AIMOCK_FAKES_REPORT ?? "fail") as "off" | "warn" | "fail";

export const MASTRA_ID = "mastra-workflow.test.ts › orders › pipeline";
export const LANGGRAPH_ID = "langgraph-control.test.ts › orders › pipeline";

/**
 * Test-id isolation: the other test's block is loaded on this same server
 * with the same tool and the same `args`, yet none of its entries answered
 * this test's calls. Its report has nothing served and all three unconsumed.
 */
export function assertIsolated(other: { served: unknown[]; unconsumed: unknown[] }): void {
  expect(other.served).toEqual([]);
  expect(other.unconsumed).toHaveLength(3);
}

/** Print the MCP journal entries (outcome and error code) for the evidence. */
export async function printMcpJournal(baseUrl: string, label: string): Promise<void> {
  const res = await fetch(`${baseUrl}/__aimock/journal`);
  const entries = (await res.json()) as {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: unknown;
    response: { status: number; mcpFake?: unknown };
  }[];
  for (const e of entries) {
    if (!e.response.mcpFake) continue;
    console.log(
      `${label}_JOURNAL ${e.method} ${e.path} mcpFake=${JSON.stringify(e.response.mcpFake)}`,
    );
  }
}
