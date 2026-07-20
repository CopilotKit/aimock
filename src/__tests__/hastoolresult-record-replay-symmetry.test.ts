import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Fixture, FixtureFile } from "../types.js";
import { createServer, type ServerInstance } from "../server.js";

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

function post(
  url: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let upstream: ServerInstance | undefined;
let recorder: ServerInstance | undefined;
let replay: ServerInstance | undefined;
let tmpDir: string | undefined;

afterEach(async () => {
  for (const s of [replay, recorder, upstream]) {
    if (s) await new Promise<void>((resolve) => s.server.close(() => resolve()));
  }
  replay = recorder = upstream = undefined;
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

/** Read every recorded fixture out of a record-mode fixture directory. */
function readRecordedFixtures(fixturePath: string): Fixture[] {
  const out: Fixture[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".json")) {
        const parsed = JSON.parse(fs.readFileSync(full, "utf-8")) as FixtureFile;
        out.push(...(parsed.fixtures ?? []));
      }
    }
  };
  walk(fixturePath);
  return out;
}

// ---------------------------------------------------------------------------
// Finding 1 — recorder/matcher record→replay symmetry (OpenAI shape)
// ---------------------------------------------------------------------------

describe("hasToolResult record→replay symmetry", () => {
  it("replays a genuinely-recorded turn-2 leg-1 request against its own recorded fixture", async () => {
    // Turn-2 leg-1: a FRESH user question whose history still carries turn-1's
    // completed tool result. Shape: [user, assistant(tool_call), tool, user].
    // Current-turn hasToolResult is FALSE (nothing after the last user message),
    // but the whole conversation DOES contain a tool message. Pre-fix the
    // recorder stamped `true` (whole-conversation) while the matcher checked
    // `false` (turn-scoped) → the fixture could never match its own request.
    const turn2Leg1 = {
      model: "gpt-4",
      messages: [
        { role: "user", content: "first question" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "lookup", arguments: "{}" },
            },
          ],
        },
        { role: "tool", content: "tool output", tool_call_id: "call_1" },
        { role: "user", content: "second question" },
      ],
    };

    // 1. Upstream mock returns an answer for the second question.
    upstream = await createServer(
      [
        {
          match: { userMessage: "second question" },
          response: { content: "Answer to the second question." },
        },
      ],
      { port: 0, logLevel: "silent" },
    );

    // 2. Recorder proxies the turn-2 leg-1 request to upstream and records it.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-sym-"));
    recorder = await createServer([], {
      port: 0,
      logLevel: "silent",
      record: { providers: { openai: upstream.url }, fixturePath: tmpDir },
    });
    const recResp = await post(`${recorder.url}/v1/chat/completions`, turn2Leg1, {
      "x-test-id": "symmetry",
    });
    expect(recResp.status).toBe(200);

    // 3. Replay the SAME request against the just-recorded fixtures.
    const fixtures = readRecordedFixtures(tmpDir);
    expect(fixtures.length).toBeGreaterThan(0);
    replay = await createServer(fixtures, { port: 0, logLevel: "silent", strict: true });
    const replayResp = await post(`${replay.url}/v1/chat/completions`, turn2Leg1);

    // Pre-fix: 503 "No fixture matched" (recorded true vs matched false).
    // Post-fix: matches and serves the recorded answer.
    expect(replayResp.status).toBe(200);
    expect(replayResp.body).toContain("Answer to the second question.");
  });

  it("replays an Anthropic leg-2 turn that bundles tool_result WITH accompanying text", async () => {
    // Anthropic packs a leg-2 tool_result and accompanying user text into ONE
    // user message. Normalization must emit `[..., user(text), tool]` so the tool
    // trails the last user message and the turn is classified as carrying a tool
    // result (`true`). Pre-fix it emitted `[..., tool, user(text)]`, byte-identical
    // to a fresh leg-1 turn, so the recorded fixture (whole-conversation `true`)
    // could never match the turn-scoped `false` the matcher computed on replay.
    const leg2WithText = {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "initial question" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: "lookup", input: {} }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "tool data" },
            { type: "text", text: "please summarize the tool result" },
          ],
        },
      ],
    };

    // Upstream matches on the accompanying text (the last user message).
    upstream = await createServer(
      [
        {
          match: { userMessage: "please summarize the tool result" },
          response: { content: "Recorded narration answer." },
        },
      ],
      { port: 0, logLevel: "silent" },
    );

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-anthropic-"));
    recorder = await createServer([], {
      port: 0,
      logLevel: "silent",
      record: { providers: { anthropic: upstream.url }, fixturePath: tmpDir },
    });
    const recResp = await post(`${recorder.url}/v1/messages`, leg2WithText, {
      "x-test-id": "anthropic-leg2-text",
    });
    expect(recResp.status).toBe(200);

    const fixtures = readRecordedFixtures(tmpDir);
    expect(fixtures.length).toBeGreaterThan(0);
    // The recorded fixture must carry the turn-scoped classification (true).
    expect(fixtures.some((f) => f.match.hasToolResult === true)).toBe(true);

    replay = await createServer(fixtures, { port: 0, logLevel: "silent", strict: true });
    const replayResp = await post(`${replay.url}/v1/messages`, leg2WithText);

    expect(replayResp.status).toBe(200);
    expect(replayResp.body).toContain("Recorded narration answer.");
  });
});
