/* global process, console, URL */
// Record client: one MCP SDK session through `llmock --mcp-record`, so aimock
// writes what the REAL upstream answered into `<fx>/recorded/mcp--record/mcp.json`.
// It also writes the live results to `$OUT/results-record.json`; both replay
// clients (the Mastra agent and the Python `mcp` SDK) compare against that file.
//
//   AIMOCK_URL  aimock base URL (the client connects to `${AIMOCK_URL}/mcp`)
//   OUT         directory for results-record.json
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { CALLS, TEST_ID } from "./calls.mjs";

const { AIMOCK_URL, OUT } = process.env;
if (!AIMOCK_URL || !OUT) {
  console.error("usage: AIMOCK_URL=<url> OUT=<dir> node record.mjs");
  process.exit(2);
}

const client = new Client({ name: "aimock-record-replay-agents", version: "1.0.0" });
await client.connect(
  new StreamableHTTPClientTransport(
    new URL(`${AIMOCK_URL}/mcp?testId=${encodeURIComponent(TEST_ID)}`),
  ),
);

const list = (await client.listTools()).tools;
const calls = {};
const progress = [];
for (const [name, args] of CALLS) {
  // The long-running tool sends progress notifications; record them too.
  const opts =
    name === "trigger-long-running-operation"
      ? { onprogress: (p) => progress.push(p.progress) }
      : {};
  calls[name] = await client.callTool({ name, arguments: args }, CallToolResultSchema, opts);
}
await client.close();

writeFileSync(join(OUT, "results-record.json"), JSON.stringify({ list, calls }, null, 2) + "\n");
console.log(
  `RECORDED tools=${list.length} calls=${Object.keys(calls).length} progress=${JSON.stringify(progress)}`,
);
