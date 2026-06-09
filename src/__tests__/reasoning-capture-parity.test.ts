import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { collapseAnthropicSSE, collapseBedrockEventStream } from "../stream-collapse.js";
import { encodeEventStreamMessage } from "../aws-event-stream.js";
import { proxyAndRecord } from "../recorder.js";
import { Logger } from "../logger.js";
import type { FixtureFile } from "../types.js";

// ---------------------------------------------------------------------------
// Cross-path reasoning-capture parity.
//
// One logical Anthropic extended-thinking turn is fed through three capture
// paths — Anthropic SSE collapse, Anthropic-native BINARY event-stream collapse,
// and the non-streaming JSON recorder — and each must extract the IDENTICAL
// reasoning artifacts. A single shared expectation table (EXPECTED) is the
// contract every path must satisfy, so a future capture path bolts on by
// reusing the same table.
//
// Contract pinned here is the POST-FIX contract (see file header in the PR):
//   - reasoning  = the two thinking blocks' text joined (T1 + T2), per each
//                  path's documented join.
//   - reasoningSignature = S2 (LAST-signature-wins). The binary path gains
//                  thinking_delta/signature_delta capture mirroring the SSE
//                  path; the non-streaming recorder switches from FIRST- to
//                  LAST-seen thinking-block signature.
//   - redactedThinking = [D1] (one non-empty redacted block). All capture sites
//                  require NON-EMPTY redacted data.
//
// In THIS worktree (tests authored before the sibling source fixes land), the
// binary-path signature/reasoning assertions and the non-streaming last-wins
// signature assertion are EXPECTED-RED. They go green once fixes 1 and 2 are
// integrated. The SSE path is already green.
// ---------------------------------------------------------------------------

// One logical turn: two thinking blocks, one redacted block, one text block.
const T1 = "First I consider the question. ";
const T2 = "Then I refine my reasoning.";
const S1 = "ErcBCkgIA...firstThinkingBlockSignature==";
const S2 = "ErcBCkgIA...secondThinkingBlockSignatureLastWins==";
const D1 = "EncryptedRedactedThinkingPayloadDDD==";
const TEXT = "The final answer is 42.";

// The ONE shared expectation table every capture path must satisfy. Future
// paths bolt on by reusing this table verbatim.
const EXPECTED = {
  reasoning: T1 + T2,
  reasoningSignature: S2,
  redactedThinking: [D1],
};

// ---------------------------------------------------------------------------
// Path A: Anthropic SSE through collapseAnthropicSSE
// ---------------------------------------------------------------------------

describe("reasoning-capture parity — Path A: Anthropic SSE", () => {
  it("extracts the shared reasoning/signature/redacted artifacts", () => {
    const body = [
      // Thinking block 1: text + signature S1.
      `event: content_block_start\ndata: ${JSON.stringify({ index: 0, content_block: { type: "thinking", thinking: "", signature: "" } })}`,
      "",
      `event: content_block_delta\ndata: ${JSON.stringify({ index: 0, delta: { type: "thinking_delta", thinking: T1 } })}`,
      "",
      `event: content_block_delta\ndata: ${JSON.stringify({ index: 0, delta: { type: "signature_delta", signature: S1 } })}`,
      "",
      `event: content_block_stop\ndata: ${JSON.stringify({ index: 0 })}`,
      "",
      // Thinking block 2: text + signature S2 (last-wins).
      `event: content_block_start\ndata: ${JSON.stringify({ index: 1, content_block: { type: "thinking", thinking: "", signature: "" } })}`,
      "",
      `event: content_block_delta\ndata: ${JSON.stringify({ index: 1, delta: { type: "thinking_delta", thinking: T2 } })}`,
      "",
      `event: content_block_delta\ndata: ${JSON.stringify({ index: 1, delta: { type: "signature_delta", signature: S2 } })}`,
      "",
      `event: content_block_stop\ndata: ${JSON.stringify({ index: 1 })}`,
      "",
      // Redacted thinking block (non-empty opaque data).
      `event: content_block_start\ndata: ${JSON.stringify({ index: 2, content_block: { type: "redacted_thinking", data: D1 } })}`,
      "",
      `event: content_block_stop\ndata: ${JSON.stringify({ index: 2 })}`,
      "",
      // Text block.
      `event: content_block_start\ndata: ${JSON.stringify({ index: 3, content_block: { type: "text", text: "" } })}`,
      "",
      `event: content_block_delta\ndata: ${JSON.stringify({ index: 3, delta: { type: "text_delta", text: TEXT } })}`,
      "",
      `event: content_block_stop\ndata: ${JSON.stringify({ index: 3 })}`,
      "",
      `event: message_stop\ndata: {}`,
      "",
    ].join("\n");

    const result = collapseAnthropicSSE(body);
    // GREEN here: SSE already captures thinking_delta, last-wins signature, and
    // non-empty redacted data.
    expect(result.reasoning).toBe(EXPECTED.reasoning);
    expect(result.reasoningSignature).toBe(EXPECTED.reasoningSignature);
    expect(result.redactedThinking).toEqual(EXPECTED.redactedThinking);
    expect(result.content).toBe(TEXT);
  });
});

// ---------------------------------------------------------------------------
// Path B: Anthropic-native BINARY event-stream frames through
// collapseBedrockEventStream. Anthropic-on-Bedrock (invoke-with-response-stream)
// uses the SAME flat `type`-keyed payloads as the SSE path, just wrapped in AWS
// binary frames.
// ---------------------------------------------------------------------------

describe("reasoning-capture parity — Path B: Anthropic-native binary frames", () => {
  it("extracts the shared reasoning/signature/redacted artifacts", () => {
    const frames = [
      // Thinking block 1.
      encodeEventStreamMessage("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "", signature: "" },
      }),
      encodeEventStreamMessage("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: T1 },
      }),
      encodeEventStreamMessage("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: S1 },
      }),
      encodeEventStreamMessage("content_block_stop", { type: "content_block_stop", index: 0 }),
      // Thinking block 2 (last-wins signature S2).
      encodeEventStreamMessage("content_block_start", {
        type: "content_block_start",
        index: 1,
        content_block: { type: "thinking", thinking: "", signature: "" },
      }),
      encodeEventStreamMessage("content_block_delta", {
        type: "content_block_delta",
        index: 1,
        delta: { type: "thinking_delta", thinking: T2 },
      }),
      encodeEventStreamMessage("content_block_delta", {
        type: "content_block_delta",
        index: 1,
        delta: { type: "signature_delta", signature: S2 },
      }),
      encodeEventStreamMessage("content_block_stop", { type: "content_block_stop", index: 1 }),
      // Redacted thinking block (non-empty data).
      encodeEventStreamMessage("content_block_start", {
        type: "content_block_start",
        index: 2,
        content_block: { type: "redacted_thinking", data: D1 },
      }),
      encodeEventStreamMessage("content_block_stop", { type: "content_block_stop", index: 2 }),
      // Text block.
      encodeEventStreamMessage("content_block_start", {
        type: "content_block_start",
        index: 3,
        content_block: { type: "text", text: "" },
      }),
      encodeEventStreamMessage("content_block_delta", {
        type: "content_block_delta",
        index: 3,
        delta: { type: "text_delta", text: TEXT },
      }),
      encodeEventStreamMessage("content_block_stop", { type: "content_block_stop", index: 3 }),
      encodeEventStreamMessage("message_stop", { type: "message_stop" }),
    ];
    const buf = Buffer.concat(frames);

    const result = collapseBedrockEventStream(buf);
    // The binary path must produce the IDENTICAL artifacts as Path A.
    // EXPECTED-RED in this worktree until fix 1 adds thinking_delta /
    // signature_delta / redacted_thinking capture to the binary frame path.
    expect(result.reasoning).toBe(EXPECTED.reasoning); // RED until fix 1
    expect(result.reasoningSignature).toBe(EXPECTED.reasoningSignature); // RED until fix 1
    expect(result.redactedThinking).toEqual(EXPECTED.redactedThinking); // RED until fix 1
    expect(result.content).toBe(TEXT);
  });
});

// ---------------------------------------------------------------------------
// Path C: non-streaming JSON through the recorder (proxyAndRecord integration
// route). A real Anthropic JSON response with two thinking blocks, a redacted
// block, and a text block is proxied + recorded; the SAVED fixture must carry
// the same shared artifacts.
// ---------------------------------------------------------------------------

describe("reasoning-capture parity — Path C: non-streaming JSON recorder", () => {
  let anthropicUpstream: http.Server | undefined;
  let recorderServer: http.Server | undefined;
  let fixturePath: string | undefined;

  afterEach(async () => {
    if (anthropicUpstream) await new Promise<void>((r) => anthropicUpstream!.close(() => r()));
    if (recorderServer) await new Promise<void>((r) => recorderServer!.close(() => r()));
    if (fixturePath) fs.rmSync(fixturePath, { recursive: true, force: true });
    anthropicUpstream = undefined;
    recorderServer = undefined;
    fixturePath = undefined;
  });

  function post(url: string, body: unknown): Promise<{ status: number; body: string }> {
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
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
          );
        },
      );
      req.on("error", reject);
      req.write(data);
      req.end();
    });
  }

  it("records the shared reasoning/signature/redacted artifacts into the fixture", async () => {
    // Real Anthropic non-streaming JSON: two thinking blocks (signatures S1, S2),
    // a redacted block (non-empty data D1), then a text block.
    const responseJson = {
      content: [
        { type: "thinking", thinking: T1, signature: S1 },
        { type: "thinking", thinking: T2, signature: S2 },
        { type: "redacted_thinking", data: D1 },
        { type: "text", text: TEXT },
      ],
    };

    anthropicUpstream = http.createServer((_upReq, upRes) => {
      upRes.writeHead(200, { "Content-Type": "application/json" });
      upRes.end(JSON.stringify(responseJson));
    });
    await new Promise<void>((r) => anthropicUpstream!.listen(0, "127.0.0.1", () => r()));
    const upstreamPort = (anthropicUpstream.address() as { port: number }).port;

    fixturePath = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-parity-ns-"));
    const fp = fixturePath;

    recorderServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", async () => {
        const rawBody = Buffer.concat(chunks).toString();
        await proxyAndRecord(
          req,
          res,
          JSON.parse(rawBody),
          "anthropic",
          "/v1/messages",
          [],
          {
            record: {
              providers: { anthropic: `http://127.0.0.1:${upstreamPort}` },
              fixturePath: fp,
            },
            logger: new Logger("silent"),
          },
          rawBody,
        );
      });
    });
    await new Promise<void>((r) => recorderServer!.listen(0, "127.0.0.1", () => r()));
    const recorderPort = (recorderServer.address() as { port: number }).port;

    const resp = await post(`http://127.0.0.1:${recorderPort}/v1/messages`, {
      model: "claude-3-7-sonnet-20250219",
      max_tokens: 1024,
      thinking: { type: "enabled", budget_tokens: 1024 },
      stream: false,
      messages: [{ role: "user", content: "think please" }],
    });
    expect(resp.status).toBe(200);

    const files = fs.readdirSync(fp).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(fp, files[0]), "utf-8"),
    ) as FixtureFile;
    const savedResponse = fixtureContent.fixtures[0].response as {
      content?: string;
      reasoning?: string;
      reasoningSignature?: string;
      redactedThinking?: string[];
    };

    expect(savedResponse.content).toBe(TEXT);
    expect(savedResponse.reasoning).toBe(EXPECTED.reasoning);
    // EXPECTED-RED in this worktree until fix 2 switches the non-streaming
    // Anthropic branch from FIRST- to LAST-seen thinking-block signature.
    // Pre-fix this captures S1; post-fix it captures S2.
    expect(savedResponse.reasoningSignature).toBe(EXPECTED.reasoningSignature); // RED until fix 2
    expect(savedResponse.redactedThinking).toEqual(EXPECTED.redactedThinking);
  });
});
