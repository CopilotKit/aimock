import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { useAimock as useVitest } from "../vitest.js";
import { useAimock as useJest } from "../jest.js";
import { loadFixtureFile } from "../fixture-loader.js";
import { normalizeLiveFixture } from "../live-fixture.js";
import { connectWebSocket } from "./ws-test-client.js";

// The Jest helper uses real lifecycle globals supplied by Vitest here; this
// exercises its fixture loading and server, not Jest-runner compatibility.
const helpers = [
  ["vitest", useVitest],
  ["jest lifecycle", useJest],
] as const;
const directory = mkdtempSync(join(tmpdir(), "aimock-helper-live-limits-"));
const fixturePath = join(directory, "live.json");
const [example] = loadFixtureFile(
  fileURLToPath(new URL("../../fixtures/openai-live-client.json", import.meta.url)),
);
const response = normalizeLiveFixture(example.response);
response.live.entries[response.live.entries.length - 1].atMs = 120_001;
response.liveTiming = "immediate";

beforeAll(() => {
  writeFileSync(fixturePath, JSON.stringify({ fixtures: [{ match: example.match, response }] }));
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

for (const [name, useAimock] of helpers) {
  for (const [kind, fixtures] of [
    ["file", fixturePath],
    ["directory", directory],
  ] as const) {
    describe(`${name} Live limits from ${kind}`, () => {
      const getMock = useAimock({
        fixtures,
        live: { maxDurationMs: 130_000 },
        patchEnv: false,
      });

      it("loads a transcript beyond the default duration and replays it on the socket", async () => {
        const { llm, url } = getMock();
        const ws = await connectWebSocket(url, "/v1/live/sessions");
        try {
          ws.send(JSON.stringify(response.live.entries[0].event));
          const messages = await ws.waitForMessages(1);
          expect(JSON.parse(messages[0])).toMatchObject({ type: "session.started" });
          expect(llm.getFixtures()).toHaveLength(1);
        } finally {
          ws.destroy();
        }
      });
    });
  }
}
