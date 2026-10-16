import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadFixtureFile, validateFixtures } from "../fixture-loader.js";
import type { Fixture, ResponseOverrides } from "../types.js";
import {
  captureHttp,
  serializeGolden,
  startGoldenServer,
  type CapturedExchange,
} from "./golden/harness.js";

const wires = ["messages-final", "messages-stream", "bedrock-final", "bedrock-stream"] as const;
type Wire = (typeof wires)[number];
const flat = { cache_read_input_tokens: 500, cache_creation_input_tokens: 40 };
const counts = { input_tokens: 10, output_tokens: 2 };
const ttl = { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 0 };

function save(id: string, value: unknown) {
  const directory = process.env.F1_CAPTURE_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  const bytes = serializeGolden(value);
  writeFileSync(join(directory, `${id}.json`), bytes);
  if (id.startsWith("control-") && process.env.F1_BASELINE_DIR)
    expect(bytes).toBe(readFileSync(join(process.env.F1_BASELINE_DIR, `${id}.json`), "utf8"));
}

async function serve(
  wire: Wire,
  usage?: ResponseOverrides["usage"],
  fault = false,
  shape: "text" | "tool" | "combined" | "blocks" = "text",
) {
  const toolCalls = [{ name: "lookup", arguments: "{}", id: "toolu_fixed_1" }];
  const fixture: Fixture = {
    match: { userMessage: "cache" },
    response: {
      ...(shape === "tool"
        ? { toolCalls }
        : { content: "Hello", ...(shape === "text" ? {} : { toolCalls }) }),
      ...(shape === "blocks"
        ? {
            blocks: [
              { type: "toolCall" as const, ...toolCalls[0]! },
              { type: "text" as const, text: "Hello" },
            ],
          }
        : {}),
      usage,
    },
    ...(fault ? { misbehavior: { seed: 0, faults: [{ fault: "empty-response", rate: 1 }] } } : {}),
  };
  const server = await startGoldenServer([fixture], { enableMisbehavior: fault });
  const messages = wire.startsWith("messages");
  const stream = wire.endsWith("stream");
  try {
    return await captureHttp(
      `${server.url}${messages ? "/v1/messages" : `/model/anthropic.claude-sonnet-4-5-v1/${stream ? "invoke-with-response-stream" : "invoke"}`}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 64,
          ...(messages ? { stream } : { anthropic_version: "bedrock-2023-05-31" }),
          messages: [{ role: "user", content: "cache" }],
          tools: [{ name: "lookup", input_schema: { type: "object" } }],
        }),
        frames: stream ? (messages ? "sse" : "aws") : undefined,
      },
    );
  } finally {
    await server.close();
  }
}

function envelopes(got: CapturedExchange) {
  if (got.body) return [JSON.parse(got.body)];
  return (got.frames ?? []).map((frame) =>
    JSON.parse(
      typeof frame === "string"
        ? frame
            .split("\n")
            .find((line) => line.startsWith("data: "))!
            .slice(6)
        : frame.decodedBytes!,
    ),
  );
}

function assertUsage(got: CapturedExchange, wire: Wire, expected: object) {
  expect(got.status).toBe(200);
  expect(got.tail).toBeUndefined();
  const events = envelopes(got);
  if (wire.endsWith("stream")) {
    expect(events.find((event) => event.type === "message_start")?.message.usage).toEqual(expected);
    expect(events.find((event) => event.type === "message_delta")?.usage).toEqual({
      output_tokens: wire === "bedrock-stream" ? 0 : 2,
      ...("cache_read_input_tokens" in expected ? flat : {}),
    });
  } else expect(events[0].usage).toEqual(expected);
}

describe("Anthropic cache usage on actual serving surfaces", () => {
  it.each(["tool", "combined", "blocks"] as const)(
    "bedrock-stream %s cache uses shared delta projection",
    async (shape) => {
      const got = await serve("bedrock-stream", { ...counts, ...flat }, false, shape);
      save(`bedrock-stream-${shape}-cache`, got);
      assertUsage(got, "bedrock-stream", { ...counts, ...flat });
    },
  );
  it.each(["tool", "combined", "blocks"] as const)(
    "bedrock-stream %s no-cache control",
    async (shape) => {
      const got = await serve("bedrock-stream", counts, false, shape);
      save(`control-bedrock-stream-${shape}`, got);
      assertUsage(got, "bedrock-stream", counts);
    },
  );
  it.each(wires)("cache-$0", async (wire) => {
    const got = await serve(wire, { ...counts, ...flat, arbitrary_extra: 99 });
    save(`cache-${wire}`, got);
    assertUsage(got, wire, { ...counts, ...flat });
  });
  it.each(wires)("nested cache-$0", async (wire) => {
    const got = await serve(wire, {
      ...counts,
      ...flat,
      cache_creation: { ephemeral_5m_input_tokens: 40, arbitrary_extra: 99 },
    });
    save(`nested-${wire}`, got);
    assertUsage(got, wire, { ...counts, ...flat, cache_creation: ttl });
  });
  it.each(wires)("control-$0 no cache preserves bytes", async (wire) => {
    const got = await serve(wire, counts);
    save(`control-${wire}`, got);
    assertUsage(got, wire, counts);
  });
  it.each(wires)("numeric cache_creation remains accepted and unrendered-$0", async (wire) => {
    const got = await serve(wire, { ...counts, cache_creation: 40 });
    assertUsage(got, wire, counts);
  });
  it.each(wires)("applied misbehavior drops fixture cache-$0", async (wire) => {
    const got = await serve(wire, { ...counts, ...flat, cache_creation: ttl }, true);
    expect(got.status).toBe(200);
    expect(serializeGolden(got)).not.toContain("cache_");
  });
  it.each([{}, { ephemeral_1h_input_tokens: 40 }])("fills omitted TTL member %j", async (cache) => {
    const got = await serve("messages-final", { ...counts, cache_creation: cache });
    expect(envelopes(got)[0].usage.cache_creation).toEqual({
      ephemeral_5m_input_tokens: 0,
      ephemeral_1h_input_tokens: 0,
      ...cache,
    });
  });
  it("preserves explicit zero and null flat fields without adding absent keys", async () => {
    const got = await serve("messages-final", {
      ...counts,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: null,
    });
    expect(envelopes(got)[0].usage).toEqual({
      ...counts,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: null,
    });
  });
});

describe("cache fixture loading and validation", () => {
  it("cache-nested-load accepts the TTL object through actual validate-on-load CLI", async () => {
    const directory = mkdtempSync(join(tmpdir(), "aimock-cache-load-"));
    try {
      const path = join(directory, "fixtures.json");
      writeFileSync(
        path,
        JSON.stringify({
          fixtures: [
            {
              match: { userMessage: "cache" },
              response: { content: "Hello", usage: { ...counts, ...flat, cache_creation: ttl } },
            },
          ],
        }),
      );
      const loaded = loadFixtureFile(path);
      const findings = validateFixtures(loaded);
      save("cache-nested-load", findings);
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          fileURLToPath(new URL("../cli.ts", import.meta.url)),
          "--fixtures",
          path,
          "--port",
          "0",
          "--validate-on-load",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const closed = once(child, "close");
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      try {
        await expect
          .poll(() => /listening on/.test(output) || child.exitCode !== null, { timeout: 5000 })
          .toBe(true);
        save("cache-nested-load-cli", { output, exitCode: child.exitCode });
        expect(output).not.toContain("Validation failed");
        expect(output).toContain("listening on");
        expect(findings).toEqual([]);
        const url = output.match(/listening on (http:\/\/\S+)/)?.[1];
        expect(url).toBeDefined();
        const response = await fetch(`${url}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "claude-sonnet-4-5",
            max_tokens: 64,
            messages: [{ role: "user", content: "cache" }],
          }),
        });
        expect(response.status).toBe(200);
        expect((await response.json()).usage).toEqual({ ...counts, ...flat, cache_creation: ttl });
      } finally {
        if (child.exitCode === null) child.kill("SIGTERM");
        await closed;
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it.each([
    [40, []],
    [{ ephemeral_5m_input_tokens: 40, future: "ignored" }, []],
    [
      { ephemeral_1h_input_tokens: "wrong" },
      ['override "usage.cache_creation.ephemeral_1h_input_tokens" must be a number, got string'],
    ],
    ["wrong", ['override "usage.cache_creation" must be a number or object, got string']],
    [null, ['override "usage.cache_creation" must be a number or object, got object']],
    [[], ['override "usage.cache_creation" must be a number or object, got array']],
  ])("validates numeric-or-object cache_creation %j", (value, expected) => {
    expect(
      validateFixtures([
        {
          match: { userMessage: "cache" },
          response: { content: "Hello", usage: { cache_creation: value } },
        },
      ]).map((finding) => finding.message),
    ).toEqual(expected);
  });
});
