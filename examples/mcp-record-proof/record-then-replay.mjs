/* global process, console, performance, URL */
// HC3 proof client: one MCP session against aimock, in record or replay mode.
//
//   AIMOCK_URL  aimock base URL (the client connects to `${AIMOCK_URL}/mcp`)
//   MODE        record | replay
//   OUT         directory for results-<MODE>.json
//   FILE        (replay) the recorded mcp.json to compare with
//
// Replay prints REPLAY_EQUALS_RECORDING, REPLAY_EQUALS_LIVE_NONSECRET and
// GET_ENV_REDACTED, then MISMATCH_CODE for a call that was never recorded.
import { readFileSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

const { AIMOCK_URL, MODE, OUT, FILE } = process.env;
if (!AIMOCK_URL || !OUT || (MODE !== "record" && MODE !== "replay")) {
  console.error(
    "usage: AIMOCK_URL=<url> MODE=record|replay OUT=<dir> [FILE=<mcp.json>] node record-then-replay.mjs",
  );
  process.exit(2);
}
if (MODE === "replay" && !FILE) {
  console.error("replay mode needs FILE=<recorded mcp.json>");
  process.exit(2);
}

const TEST_ID = "mcp › record";
const LONG = "trigger-long-running-operation";
const CALLS = [
  ["echo", { message: "hi" }],
  ["get-sum", { a: 1, b: 2 }],
  ["get-structured-content", { location: "New York" }],
];
const NON_SECRET = [...CALLS.map(([name]) => name), LONG];

const client = new Client({ name: "aimock-mcp-record-proof", version: "1.0.0" });
await client.connect(
  new StreamableHTTPClientTransport(
    new URL(`${AIMOCK_URL}/mcp?testId=${encodeURIComponent(TEST_ID)}`),
  ),
);

/** A call result as compared: the JSON-RPC id is never part of it. */
const strip = (result) => JSON.parse(JSON.stringify(result));

const list = (await client.listTools()).tools;
const calls = {};
for (const [name, args] of CALLS) {
  calls[name] = strip(await client.callTool({ name, arguments: args }));
}
const progress = [];
const t0 = performance.now();
calls[LONG] = strip(
  await client.callTool(
    { name: LONG, arguments: { duration: 2, steps: 2 } },
    CallToolResultSchema,
    {
      onprogress: (p) => progress.push(p.progress),
    },
  ),
);
const elapsedMs = Math.round(performance.now() - t0);
calls["get-env"] = strip(await client.callTool({ name: "get-env", arguments: {} }));

writeFileSync(
  join(OUT, `results-${MODE}.json`),
  JSON.stringify({ list, calls, progress, elapsedMs }, null, 2) + "\n",
);
console.log(
  `MODE=${MODE} TOOLS=${list.length} PROGRESS=${JSON.stringify(progress)} ELAPSED_MS=${elapsedMs}`,
);

if (MODE === "replay") {
  const doc = JSON.parse(readFileSync(FILE, "utf8"));
  const block = Array.isArray(doc.mcpFakes) ? doc.mcpFakes[0] : doc.mcpFakes;
  const args = Object.fromEntries([...CALLS, [LONG, { duration: 2, steps: 2 }], ["get-env", {}]]);
  // The file entry for a tool and its args, as the fakes engine turns it into a result.
  const fromFile = (name) => {
    const entry = block.tools
      .find((t) => t.name === name)
      ?.calls.find((c) => isDeepStrictEqual(c.args ?? {}, args[name]));
    if (!entry) return undefined;
    if (entry.error !== undefined)
      return { content: [{ type: "text", text: entry.error }], isError: true };
    return entry.result;
  };
  const fileEqual =
    isDeepStrictEqual(list, block.list) &&
    Object.keys(calls).every((name) => isDeepStrictEqual(calls[name], fromFile(name)));
  const live = JSON.parse(readFileSync(join(OUT, "results-record.json"), "utf8"));
  const liveEqual = NON_SECRET.every((name) => isDeepStrictEqual(calls[name], live.calls[name]));
  const envText = JSON.stringify(calls["get-env"]);
  const redacted = envText.includes("[REDACTED]") && !envText.includes("s3cr3t");
  const durationMs = block.tools.find((t) => t.name === LONG)?.calls[0]?.durationMs ?? 0;
  console.log(`RECORDED_DURATION_MS=${durationMs}`);
  console.log(`REPLAY_EQUALS_RECORDING=${fileEqual}`);
  console.log(`REPLAY_EQUALS_LIVE_NONSECRET=${liveEqual}`);
  console.log(`GET_ENV_REDACTED=${redacted}`);
  let code = "none (the call resolved)";
  try {
    await client.callTool({ name: "echo", arguments: { message: "never recorded" } });
  } catch (err) {
    code = err?.data?.aimock?.code ?? `no aimock code (${err?.message ?? err})`;
  }
  console.log(`MISMATCH_CODE=${code}`);
}
await client.close();
