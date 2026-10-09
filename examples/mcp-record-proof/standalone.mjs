/* global process, console */
// HC3 proof, standalone path (AM1 b): a standalone MCPMock that records a
// real upstream, or replays a recorded file offline.
//
//   MODE=record  UPSTREAM=<url> FIXTURES=<dir> SECRET=<value>
//   MODE=replay  FILE=<recorded mcp.json>
//
// Prints STANDALONE_URL=<url> once listening; SIGTERM stops it.
import { readFileSync } from "node:fs";
import { MCPMock } from "@copilotkit/aimock";

const { MODE, UPSTREAM, FIXTURES, SECRET, FILE } = process.env;
const mcp = new MCPMock();
if (MODE === "record") {
  if (!UPSTREAM || !FIXTURES) {
    console.error("record mode needs UPSTREAM and FIXTURES");
    process.exit(2);
  }
  mcp.enableRecording({
    upstream: UPSTREAM,
    fixturePath: FIXTURES,
    secretValues: SECRET ? [SECRET] : [],
  });
} else if (MODE === "replay") {
  if (!FILE) {
    console.error("replay mode needs FILE");
    process.exit(2);
  }
  mcp.loadFakes(JSON.parse(readFileSync(FILE, "utf8")).mcpFakes);
} else {
  console.error("MODE must be record or replay");
  process.exit(2);
}
const url = await mcp.start();
console.log(`STANDALONE_URL=${url}`);
process.on("SIGTERM", () => {
  void mcp.stop().finally(() => process.exit(0));
});
