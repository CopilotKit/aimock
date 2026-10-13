/**
 * Self-test for the golden corpus harness, plus a small smoke corpus (suite
 * `harness`) that drives every capture mode end to end: plain body, SSE,
 * NDJSON, AWS event-stream and a raw-socket capture.
 */
import { channel } from "node:diagnostics_channel";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, gzipSync } from "node:zlib";
import { encodeEventStreamFrame, encodeEventStreamMessage } from "../../aws-event-stream.js";
import type { Fixture } from "../../types.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CAPTURE_HTTP_TIMEOUT_MS,
  captureHttp,
  captureRawHttp,
  decodeAwsEventStream,
  dechunk,
  EPOCH_FUTURE_WINDOW_MS,
  EPOCH_KEYS,
  EPOCH_PAST_WINDOW_MS,
  expectGolden,
  goldenPath,
  ID_PREFIXES,
  NON_EPOCH_KEYS,
  normalize,
  normalizeHeaders,
  NormalizeContext,
  RAW_HTTP_TIMEOUT_MS,
  serializeGolden,
  setGoldenRootForSelfTest,
  startGoldenServer,
  startStubUpstream,
  type GoldenServer,
} from "./harness.js";

const GOLDEN_ENV = ["GOLDEN_WRITE", "GOLDEN_CAPTURE_RUN", "GOLDEN_WRITE_LOG", "CI"] as const;
type GoldenEnv = Partial<Record<(typeof GOLDEN_ENV)[number], string>>;

/** Run `fn` with exactly `vars` set among the golden env vars, restoring them afterwards. */
async function withGoldenEnv(vars: GoldenEnv, fn: () => void | Promise<void>): Promise<void> {
  const saved = new Map(GOLDEN_ENV.map((k) => [k, process.env[k]]));
  for (const k of GOLDEN_ENV) delete process.env[k];
  Object.assign(process.env, vars);
  try {
    await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** A raw TCP server whose connection handler writes whatever the test wants. */
async function rawServer(onConn: (sock: net.Socket) => void): Promise<{
  url: string;
  close(): Promise<void>;
}> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("error", () => {});
    sock.once("data", () => onConn(sock));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

const GET = "GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n";

/** Reset only after the real capture socket has read the fixture bytes. */
async function resetServer(response: string) {
  let peer: net.Socket | undefined;
  const s = await rawServer((sock) => {
    peer = sock;
    sock.write(response);
  });
  const port = Number(new URL(s.url).port);
  const errors: Error[] = [];
  const sockets = channel("net.client.socket");
  const observe = (message: unknown) => {
    if (
      typeof message !== "object" ||
      message === null ||
      !("socket" in message) ||
      !(message.socket instanceof net.Socket)
    )
      return;
    const client = message.socket;
    client.once("connect", () => {
      if (client.remotePort !== port) return;
      let received = 0;
      client.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received === Buffer.byteLength(response) && peer) {
          // A write callback only confirms the send buffer was flushed. The
          // client must read the response before we introduce the socket error.
          peer.resetAndDestroy();
          peer = undefined;
        }
      });
      client.once("error", (err) => errors.push(err));
    });
  };
  sockets.subscribe(observe);
  return {
    url: s.url,
    errors,
    close: async () => {
      sockets.unsubscribe(observe);
      await s.close();
    },
  };
}

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Every non-test `.ts` file under `root` (default: src/). */
function srcFiles(root = SRC): string[] {
  return (readdirSync(root, { recursive: true }) as string[])
    .filter((f) => f.endsWith(".ts") && !f.split(/[\\/]/).includes("__tests__"))
    .map((f) => join(root, f));
}

/** What a fetch that lost its connection rejects with. */
const FETCH_LOST = /fetch failed|terminated|other side closed|ECONNRESET|socket hang up/;

/**
 * Timestamp-shaped keys written in `files` that are in neither `EPOCH_KEYS`
 * nor `NON_EPOCH_KEYS`. A key is `<letters/underscores>_at`, `<letters>At`,
 * `created` or `timestamp`, written as an object key (`k:`, `"k":`, `k?:`) or
 * assigned as a member (`obj.k =`).
 */
function unknownTimestampKeys(files: string[]): string[] {
  const name = String.raw`[A-Za-z][A-Za-z_]*(?:_at|At)|created|timestamp`;
  const key = new RegExp(String.raw`(?:^|[{,\s])"?(${name})"?\??:|\.(${name})\s*=(?!=)`, "gm");
  const seen = new Set<string>();
  for (const file of files) {
    for (const m of readFileSync(file, "utf8").matchAll(key)) seen.add((m[1] ?? m[2])!);
  }
  const known = new Set<string>([...EPOCH_KEYS, ...Object.keys(NON_EPOCH_KEYS)]);
  return [...seen].filter((k) => !known.has(k)).sort();
}

// ─── normalize ──────────────────────────────────────────────────────────────

describe("normalize", () => {
  const nowS = Math.floor(Date.now() / 1000);
  const nowMs = Date.now();
  const sample = [
    `{"id":"msg_AbCdEfGhIjKlMn-_","created":${nowS},"x":"toolu_fixed_1"}`,
    "x-request-id: req-0123456789abcdef",
    `"arguments":"{\\"created_at\\":${nowMs}}"`,
    "uuid 3f2504e0-4f89-41d3-9a0c-0305e82c3301 at 2026-10-12T17:22:01.123Z",
    '"id":"msg_AbCdEfGhIjKlMn-_","other":"chatcmpl-ZZZZZZZZZZZZZZZZ"',
    `"tokens":${nowS}`,
    '"created":1686935002',
  ].join("\n");

  it("replaces minted ids, uuids, ISO dates and wall-clock epochs, and nothing else", () => {
    expect(normalize(sample)).toBe(
      [
        '{"id":"msg_<#0>","created":"<epoch>","x":"toolu_fixed_1"}',
        "x-request-id: req-<#1>",
        '"arguments":"{\\"created_at\\":\\"<epoch>\\"}"',
        "uuid <uuid#2> at <iso-date>",
        '"id":"msg_<#0>","other":"chatcmpl-<#3>"',
        `"tokens":${nowS}`,
        '"created":1686935002',
      ].join("\n"),
    );
  });

  it("is idempotent", () => {
    const once = normalize(sample);
    expect(normalize(once)).toBe(once);
  });

  it("numbers ids and uuids by first appearance in one sequence", () => {
    expect(normalize("3f2504e0-4f89-41d3-9a0c-0305e82c3301 msg_AAAAAAAAAAAAAAAA")).toBe(
      "<uuid#0> msg_<#1>",
    );
  });

  it("shares numbering across calls through one context", () => {
    const ctx = new NormalizeContext();
    expect(normalize("msg_AAAAAAAAAAAAAAAA", ctx)).toBe("msg_<#0>");
    expect(normalize("msg_BBBBBBBBBBBBBBBB msg_AAAAAAAAAAAAAAAA", ctx)).toBe("msg_<#1> msg_<#0>");
  });

  it.each(ID_PREFIXES.flatMap((p) => ["-", "_"].map((sep) => [p, sep] as const)))(
    "normalizes a minted %s%s id",
    (prefix, sep) => {
      expect(normalize(`"${prefix}${sep}Ab3_-Zz9Ab3_-Zz9"`)).toBe(`"${prefix}${sep}<#0>"`);
    },
  );

  it("covers every prefix src passes to a 16-char base64url id minter", () => {
    const MINT = String.raw`\$\{randomBytes\(12\)\.toString\("base64url"\)\}`;
    const literal = new RegExp(String.raw`\x60([a-z]+(?:_[a-z]+)*)[-_]${MINT}\x60`, "g");
    const helper = new RegExp(
      String.raw`function (\w+)\((\w+)(?:\s*=\s*"([a-z_]+)")?[^)]*\)[^{]*\{\s*return \x60\$\{\2\}[-_]${MINT}\x60`,
      "g",
    );
    const found = new Set<string>();
    const helpers = new Set<string>();
    let mintSites = 0;
    let accounted = 0;
    for (const file of srcFiles()) {
      const text = readFileSync(file, "utf8");
      mintSites += text.match(new RegExp(MINT, "g"))?.length ?? 0;
      for (const m of text.matchAll(literal)) {
        found.add(m[1]!);
        accounted++;
      }
      for (const m of text.matchAll(helper)) {
        helpers.add(m[1]!);
        if (m[3]) found.add(m[3]);
        accounted++;
      }
    }
    // Every minting site is either a literal-prefix template or a prefix helper.
    expect(accounted).toBe(mintSites);
    expect([...helpers].sort()).toEqual(["generateId", "realtimeId", "underscoreId"]);
    for (const file of srcFiles()) {
      const text = readFileSync(file, "utf8");
      for (const name of helpers) {
        for (const m of text.matchAll(new RegExp(String.raw`\b${name}\(([^)]*)\)`, "g"))) {
          const arg = m[1]!.trim();
          if (arg === "" || /^prefix\b/.test(arg)) continue; // default / the definition
          const lit = /^"([a-z_]+)"$/.exec(arg);
          expect(lit, `${file}: ${name}(${arg}) has a non-literal prefix`).not.toBeNull();
          found.add(lit![1]!);
        }
      }
    }
    expect(found.size).toBeGreaterThan(15);
    expect([...found].filter((p) => !(ID_PREFIXES as readonly string[]).includes(p))).toEqual([]);
  });

  it("keeps batch_req_ whole", () => {
    expect(normalize("batch_req_AAAAAAAAAAAAAAAA")).toBe("batch_req_<#0>");
  });

  it("normalizes a minted id followed by a suffix", () => {
    expect(normalize("call_AAAAAAAAAAAAAAAA_1 fc-BBBBBBBBBBBBBBBB-chunk")).toBe(
      "call_<#0>_1 fc-<#1>-chunk",
    );
  });

  it("keeps ids that are not exactly 16 characters", () => {
    expect(normalize("toolu_fixed_1 msg_AAAAAAAAAAAAAAAAA msg_AAAAAAAAAAAAAAA")).toBe(
      "toolu_fixed_1 msg_AAAAAAAAAAAAAAAAA msg_AAAAAAAAAAAAAAA",
    );
  });

  it("normalizes a UUID behind a dash prefix", () => {
    expect(
      normalize(
        '{"id":"cgt-3f2504e0-4f89-41d3-9a0c-0305e82c3301","b":"aimock-3f2504e0-4f89-41d3-9a0c-0305e82c3302"}',
      ),
    ).toBe('{"id":"cgt-<uuid#0>","b":"aimock-<uuid#1>"}');
  });

  it("gives UUIDs that differ only in case different placeholders", () => {
    expect(
      normalize("3f2504e0-4f89-41d3-9a0c-0305e82c3301 3F2504E0-4F89-41D3-9A0C-0305E82C3301"),
    ).toBe("<uuid#0> <uuid#1>");
  });

  it.each([
    "2026-10-12T17:22:01Z",
    "2026-10-12T17:22:01.123Z",
    "2026-10-12T17:22:01+05:30",
    "2026-10-12T17:22:01+0000",
    "2026-10-12T17:22:01.5-0800",
    "2026-10-12T17:22:01",
    "2026-10-12T17:22:01.123456",
  ])("normalizes ISO date-time %s", (iso) => {
    expect(normalize(`"${iso}"`)).toBe('"<iso-date>"');
  });

  it.each(EPOCH_KEYS.map((k) => [k]))("normalizes a wall-clock epoch under %s", (key) => {
    expect(normalize(`{"${key}":${nowS},"b":{"${key}": ${nowMs}}}`)).toBe(
      `{"${key}":"<epoch>","b":{"${key}": "<epoch>"}}`,
    );
  });

  it("covers every timestamp-shaped key src writes", () => {
    expect(unknownTimestampKeys(srcFiles())).toEqual([]);
    for (const k of [
      "updated_at",
      "last_active_at",
      "in_progress_at",
      "finished_at",
      "submittedAt",
      "expires_at",
    ]) {
      expect(EPOCH_KEYS).toContain(k);
    }
  });

  it("the timestamp-key scan catches a new multi-underscore key in either form", () => {
    const dir = mkdtempSync(join(tmpdir(), "aimock-ts-keys-"));
    try {
      writeFileSync(
        join(dir, "fixture.ts"),
        [
          "interface Row {",
          "  first_seen_at?: number;",
          "  last_active_at?: number;",
          "}",
          "row.last_used_at = Date.now();",
          "if (row.in_progress_at === 0) row.in_progress_at = now();",
          'const ok = { created: 1, "quoted_thing_at": 2 };',
          "",
        ].join("\n"),
      );
      expect(unknownTimestampKeys(srcFiles(dir))).toEqual([
        "first_seen_at",
        "last_used_at",
        "quoted_thing_at",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(["\n", "\t", "\r", "\b", "\f", "\u0001", "\u000b", "\u001f"])(
    "normalizes an id and a uuid right after the JSON escape for %j",
    (esc) => {
      const raw = `${esc}msg_AbCdEfGhIjKlMnOp${esc}3f2504e0-4f89-41d3-9a0c-0305e82c3301`;
      expect(normalize(JSON.stringify(raw))).toBe(JSON.stringify(`${esc}msg_<#0>${esc}<uuid#1>`));
    },
  );

  it("keeps an id after an escaped backslash and a letter (a real letter, not an escape)", () => {
    // Raw text `\nmsg_...` here is a literal backslash, the letter n, then 16 chars.
    const text = JSON.stringify("\\nmsg_AbCdEfGhIjKlMnOp \\b3f2504e0-4f89-41d3-9a0c-0305e82c3301");
    expect(normalize(text)).toBe(text);
  });

  it("normalizes epochs inside doubly escaped JSON strings", () => {
    const text = `"arguments":"{\\"inner\\":\\"{\\\\\\"created\\\\\\":${nowMs}}\\"}"`;
    expect(normalize(text)).toBe(
      `"arguments":"{\\"inner\\":\\"{\\\\\\"created\\\\\\":\\\\\\"<epoch>\\\\\\"}\\"}"`,
    );
    const outer = JSON.parse(`{${normalize(text)}}`) as { arguments: string };
    const mid = JSON.parse(outer.arguments) as { inner: string };
    expect(JSON.parse(mid.inner)).toEqual({ created: "<epoch>" });
  });

  it("normalizes keyed epochs inside the window in both directions, and nothing else", () => {
    const day = 86_400;
    expect(EPOCH_PAST_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
    expect(EPOCH_FUTURE_WINDOW_MS).toBe(400 * 24 * 60 * 60 * 1000);
    const at = (s: number) => normalize(`{"expires_at":${s}}`);
    expect(at(nowS + 3600)).toBe('{"expires_at":"<epoch>"}');
    expect(at(nowS + 30 * day)).toBe('{"expires_at":"<epoch>"}');
    expect(at(nowS + 365 * day)).toBe('{"expires_at":"<epoch>"}');
    expect(at(nowS - 3600)).toBe('{"expires_at":"<epoch>"}');
    expect(at(nowS + 500 * day)).toBe(`{"expires_at":${nowS + 500 * day}}`);
    expect(at(nowS - 2 * day)).toBe(`{"expires_at":${nowS - 2 * day}}`);
    expect(normalize('{"created": 1686935002}')).toBe('{"created": 1686935002}');
  });
});

describe("serializeGolden", () => {
  it("numbers raw ids after already-normalized ones", () => {
    const text = serializeGolden({ a: "msg_<#0>", b: "msg_CCCCCCCCCCCCCCCC" });
    expect(text).toBe('{\n  "a": "msg_<#0>",\n  "b": "msg_<#1>"\n}\n');
  });

  it("keeps placeholders consistent across separately captured parts", async () => {
    const bodies = ['{"id":"msg_AAAAAAAAAAAAAAAA"}', '{"id":"msg_BBBBBBBBBBBBBBBB"}'];
    const stub = await startStubUpstream((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(bodies[Number(req.url.slice(1))]);
    });
    try {
      const a = await captureHttp(`${stub.url}/0`);
      const b = await captureHttp(`${stub.url}/1`);
      const a2 = await captureHttp(`${stub.url}/0`);
      // Each capture alone numbers from 0...
      expect(a.body).toBe('{"id":"msg_<#0>"}');
      expect(b.body).toBe('{"id":"msg_<#0>"}');
      // ...but one golden holding all three tells the ids apart and links the repeat.
      const text = serializeGolden({ a, b, a2, raw: "msg_BBBBBBBBBBBBBBBB" });
      const ids = [...text.matchAll(/msg_<#(\d+)>/g)].map((m) => m[1]);
      expect(ids).toEqual(["0", "1", "0", "1"]);
    } finally {
      await stub.close();
    }
  });
});

describe("normalizeHeaders", () => {
  it("lowercases, sorts, drops transport headers and normalizes values", () => {
    expect(
      normalizeHeaders([
        ["X-Request-Id", "req-0123456789abcdef"],
        ["Date", "Mon, 12 Oct 2026 17:22:01 GMT"],
        ["Connection", "keep-alive"],
        ["Keep-Alive", "timeout=5"],
        ["Transfer-Encoding", "chunked"],
        ["Content-Type", "application/json"],
        ["Content-Length", "42"],
      ]),
    ).toEqual({
      "content-length": "42",
      "content-type": "application/json",
      "x-request-id": "req-<#0>",
    });
  });

  it("joins repeated header names in order instead of overwriting", () => {
    expect(
      normalizeHeaders([
        ["Set-Cookie", "a=1"],
        ["X-Other", "o"],
        ["set-cookie", "b=2"],
      ]),
    ).toEqual({ "set-cookie": "a=1, b=2", "x-other": "o" });
  });

  it("keeps constructor and __proto__ header names as plain entries", () => {
    const got = normalizeHeaders([
      ["Constructor", "a"],
      ["__proto__", "b"],
      ["toString", "c"],
      ["x", "y"],
    ]);
    expect(JSON.stringify(got)).toBe('{"__proto__":"b","constructor":"a","tostring":"c","x":"y"}');
  });
});

// ─── AWS event-stream decoding ──────────────────────────────────────────────

/** Build one event-stream frame from raw header bytes, with valid CRCs. */
function rawFrame(headerBytes: Buffer, payload: Buffer, headersLength = headerBytes.length) {
  const total = 12 + headerBytes.length + payload.length + 4;
  const buf = Buffer.alloc(total);
  buf.writeUInt32BE(total, 0);
  buf.writeUInt32BE(headersLength, 4);
  buf.writeUInt32BE(crc32(buf.subarray(0, 8)) >>> 0, 8);
  headerBytes.copy(buf, 12);
  payload.copy(buf, 12 + headerBytes.length);
  buf.writeUInt32BE(crc32(buf.subarray(0, total - 4)) >>> 0, total - 4);
  return buf;
}

/** Encode one string header (type 7). */
function strHeader(name: string, value: string): Buffer {
  const n = Buffer.from(name);
  const v = Buffer.from(value);
  const out = Buffer.alloc(1 + n.length + 1 + 2 + v.length);
  out.writeUInt8(n.length, 0);
  n.copy(out, 1);
  out.writeUInt8(7, 1 + n.length);
  out.writeUInt16BE(v.length, 2 + n.length);
  v.copy(out, 4 + n.length);
  return out;
}

describe("decodeAwsEventStream", () => {
  const frame = encodeEventStreamMessage("chunk", {
    bytes: Buffer.from('{"type":"message_start","id":"msg_AAAAAAAAAAAAAAAA"}').toString("base64"),
  });

  it("decodes headers, payload and base64 bytes", () => {
    expect(decodeAwsEventStream(frame)).toEqual({
      frames: [
        {
          headers: {
            ":content-type": "application/json",
            ":event-type": "chunk",
            ":message-type": "event",
          },
          payload: '{"bytes":"<base64:decodedBytes>"}',
          decodedBytes: '{"type":"message_start","id":"msg_<#0>"}',
        },
      ],
    });
  });

  it("returns a partial trailing frame as base64 tail", () => {
    const partial = Buffer.concat([frame, frame.subarray(0, 10)]);
    const got = decodeAwsEventStream(partial);
    expect(got.frames).toHaveLength(1);
    expect(got.tail).toBe(frame.subarray(0, 10).toString("base64"));
  });

  it("throws on a message CRC mismatch", () => {
    const bad = Buffer.from(frame);
    bad[bad.length - 6] ^= 0xff;
    expect(() => decodeAwsEventStream(bad)).toThrow(/message CRC mismatch/);
  });

  it("throws on a prelude CRC mismatch", () => {
    const bad = Buffer.from(frame);
    bad[8] ^= 0xff;
    expect(() => decodeAwsEventStream(bad)).toThrow(/prelude CRC mismatch/);
  });

  it("keeps a non-JSON payload as text", () => {
    const raw = encodeEventStreamFrame({ ":event-type": "x" }, Buffer.from("not json"));
    expect(decodeAwsEventStream(raw).frames[0]).toEqual({
      headers: { ":event-type": "x" },
      payload: "not json",
    });
  });

  it("rejects a bytes member that is not lossless base64 of UTF-8", () => {
    // Unpadded base64 decodes fine but does not re-encode to the same text.
    const raw = encodeEventStreamFrame({ ":event-type": "chunk" }, Buffer.from('{"bytes":"aGk"}'));
    expect(() => decodeAwsEventStream(raw)).toThrow(/not lossless base64/);
    const notUtf8 = Buffer.from([0xff, 0xfe]).toString("base64");
    const raw2 = encodeEventStreamFrame(
      { ":event-type": "chunk" },
      Buffer.from(`{"bytes":"${notUtf8}"}`),
    );
    expect(() => decodeAwsEventStream(raw2)).toThrow(/not lossless base64/);
  });

  it("rejects a bytes value that appears twice in the payload text", () => {
    const b64 = Buffer.from("hi").toString("base64");
    const raw = encodeEventStreamFrame(
      { ":event-type": "chunk" },
      Buffer.from(`{"bytes":"${b64}","echo":"${b64}"}`),
    );
    expect(() => decodeAwsEventStream(raw)).toThrow(/cannot locate "bytes" value uniquely/);
  });

  it("rejects a total length below the 16-byte minimum", () => {
    const bad = Buffer.alloc(16);
    bad.writeUInt32BE(8, 0);
    expect(() => decodeAwsEventStream(bad)).toThrow(/total length 8/);
  });

  it("rejects a headers length that runs past the payload", () => {
    const bad = rawFrame(strHeader(":a", "b"), Buffer.from("p"), 64);
    expect(() => decodeAwsEventStream(bad)).toThrow(/headers length 64/);
  });

  it("rejects a header value that runs past the headers block", () => {
    const h = strHeader(":a", "bcd");
    h.writeUInt16BE(200, 4); // value length way past the block
    expect(() => decodeAwsEventStream(rawFrame(h, Buffer.from("p")))).toThrow(
      /overruns the headers block/,
    );
  });

  it("rejects a repeated header name", () => {
    const h = Buffer.concat([strHeader(":a", "1"), strHeader(":a", "2")]);
    expect(() => decodeAwsEventStream(rawFrame(h, Buffer.from("p")))).toThrow(
      /duplicate header ":a"/,
    );
  });

  it("keeps a __proto__ frame header, and still rejects it repeated", () => {
    const one = rawFrame(strHeader("__proto__", "v"), Buffer.from("p"));
    expect(serializeGolden(decodeAwsEventStream(one))).toContain('"__proto__": "v"');
    const two = Buffer.concat([strHeader("__proto__", "1"), strHeader("__proto__", "2")]);
    expect(() => decodeAwsEventStream(rawFrame(two, Buffer.from("p")))).toThrow(
      /duplicate header "__proto__"/,
    );
  });

  it.each([
    ["alone", 0],
    ["after a good frame", 1],
  ])("rejects a corrupt total length under 16 %s, even when it fits no frame", (_l, n) => {
    const corrupt = Buffer.alloc(8);
    corrupt.writeUInt32BE(12, 0); // under 16, and more than the 8 bytes left
    const buf = Buffer.concat([...Array<Buffer>(n).fill(frame), corrupt]);
    expect(() => decodeAwsEventStream(buf)).toThrow(
      new RegExp(`event-stream frame at byte ${n * frame.length}: total length 12`),
    );
  });

  it("names the frame offset for an unsupported header type", () => {
    const h = strHeader(":a", "b");
    h.writeUInt8(6, 1 + 2); // type byte after the 1-byte length and 2-byte name
    const buf = Buffer.concat([frame, rawFrame(h, Buffer.from("p"))]);
    expect(() => decodeAwsEventStream(buf)).toThrow(
      new RegExp(`event-stream frame at byte ${frame.length}: header ":a": type 6 not supported`),
    );
  });

  it("records a payload that is not UTF-8 as base64, not as lossy text", () => {
    const a = decodeAwsEventStream(rawFrame(strHeader(":a", "b"), Buffer.from([0xff])));
    const b = decodeAwsEventStream(rawFrame(strHeader(":a", "b"), Buffer.from([0xfe])));
    expect(a.frames[0]).toEqual({ headers: { ":a": "b" }, payloadBase64: "/w==" });
    expect(serializeGolden(a)).not.toBe(serializeGolden(b));
  });

  it("rejects a header value that is not UTF-8", () => {
    const h = strHeader(":a", "b");
    h[h.length - 1] = 0xff;
    expect(() => decodeAwsEventStream(rawFrame(h, Buffer.from("p")))).toThrow(
      /event-stream frame at byte 0: header ":a" value is not valid UTF-8/,
    );
  });
});

// ─── dechunk ────────────────────────────────────────────────────────────────

describe("dechunk", () => {
  it("decodes chunks, extensions and trailers", () => {
    expect(dechunk(Buffer.from("3;x=y\r\nabc\r\n2\r\nde\r\n0\r\nX-T: 1\r\n\r\n")).toString()).toBe(
      "abcde",
    );
  });

  it.each([
    ["a partly valid size", "1g\r\na\r\n0\r\n\r\n", /bad chunk size line "1g"/],
    ["an empty size", "\r\n0\r\n\r\n", /bad chunk size line ""/],
    ["a missing CRLF after the data", "3\r\nabcX\r\n0\r\n\r\n", /no CRLF after chunk/],
    ["a short chunk", "9\r\nabc\r\n", /truncated/],
    ["no terminating chunk", "3\r\nabc\r\n", /truncated/],
    ["no final CRLF", "3\r\nabc\r\n0\r\n", /truncated/],
    ["bytes after the body", "3\r\nabc\r\n0\r\n\r\nextra", /after the chunked body/],
    ["whitespace with no extension", "3 \r\nabc\r\n0\r\n\r\n", /bad chunk size line "3 "/],
    ["leading whitespace", " 3\r\nabc\r\n0\r\n\r\n", /bad chunk size line " 3"/],
    ["two size tokens", "3 4;x\r\nabc\r\n0\r\n\r\n", /bad chunk size line "3 4;x"/],
  ])("throws on %s", (_label, body, re) => {
    expect(() => dechunk(Buffer.from(body))).toThrow(re);
  });

  it("accepts whitespace before a chunk extension (RFC 9112 BWS)", () => {
    expect(dechunk(Buffer.from("3 ;x=y\r\nabc\r\n2\t ; e\r\nde\r\n0 ;z\r\n\r\n")).toString()).toBe(
      "abcde",
    );
  });
});

// ─── captureRawHttp ─────────────────────────────────────────────────────────

describe("captureRawHttp", () => {
  it("throws on a header line with no colon", async () => {
    const s = await rawServer((sock) =>
      sock.end("HTTP/1.1 200 OK\r\nBogusLine\r\nContent-Length: 0\r\n\r\n"),
    );
    try {
      await expect(captureRawHttp(s.url, GET)).rejects.toThrow(/header line without ":"/);
    } finally {
      await s.close();
    }
  });

  it("fails on a body cut short by a reset", async () => {
    const s = await resetServer("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n0123456789");
    try {
      await expect(captureRawHttp(s.url, GET)).rejects.toThrow(/incomplete|truncated/);
      expect(s.errors).toMatchObject([{ code: "ECONNRESET" }]);
    } finally {
      await s.close();
    }
  });

  it("fails on a body cut short by a clean close", async () => {
    const s = await rawServer((sock) =>
      sock.end("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n0123456789"),
    );
    try {
      await expect(captureRawHttp(s.url, GET)).rejects.toThrow(/10 of 100/);
    } finally {
      await s.close();
    }
  });

  it("fails on a close-delimited body cut short by a reset", async () => {
    const s = await resetServer("HTTP/1.1 200 OK\r\n\r\npartial");
    try {
      await expect(captureRawHttp(s.url, GET)).rejects.toThrow(/incomplete/);
      expect(s.errors).toMatchObject([{ code: "ECONNRESET" }]);
    } finally {
      await s.close();
    }
  });

  it("accepts the same close-delimited body ended by a clean close", async () => {
    const s = await rawServer((sock) => sock.end("HTTP/1.1 200 OK\r\n\r\npartial"));
    try {
      await expect(captureRawHttp(s.url, GET)).resolves.toEqual({
        status: 200,
        headers: {},
        body: "partial",
      });
    } finally {
      await s.close();
    }
  });

  it("keeps a complete response that is followed by a reset", async () => {
    const s = await resetServer("HTTP/1.1 401 Unauthorized\r\nContent-Length: 2\r\n\r\nno");
    try {
      const got = await captureRawHttp(s.url, GET);
      expect(got).toEqual({ status: 401, headers: { "content-length": "2" }, body: "no" });
      expect(s.errors).toMatchObject([{ code: "ECONNRESET" }]);
    } finally {
      await s.close();
    }
  });

  it.each([
    ["a HEAD response", "HEAD / HTTP/1.1", "200 OK"],
    ["a 204", "GET / HTTP/1.1", "204 No Content"],
    ["a 304", "GET / HTTP/1.1", "304 Not Modified"],
  ])("keeps %s with content-length but no body", async (_l, requestLine, status) => {
    const s = await rawServer((sock) =>
      sock.end(`HTTP/1.1 ${status}\r\nContent-Length: 5\r\n\r\n`),
    );
    try {
      const got = await captureRawHttp(
        s.url,
        `${requestLine}\r\nHost: x\r\nConnection: close\r\n\r\n`,
      );
      expect(got).toEqual({
        status: Number(status.slice(0, 3)),
        headers: { "content-length": "5" },
        body: "",
      });
    } finally {
      await s.close();
    }
  });

  it("fails on bytes after a bodyless response", async () => {
    const s = await rawServer((sock) => sock.end("HTTP/1.1 204 No Content\r\n\r\nextra"));
    try {
      await expect(captureRawHttp(s.url, GET)).rejects.toThrow(
        /5 bytes after a bodyless 204 response/,
      );
    } finally {
      await s.close();
    }
  });

  it("skips 1xx interim responses in favour of the final one", async () => {
    const s = await rawServer((sock) =>
      sock.end(
        "HTTP/1.1 100 Continue\r\n\r\n" +
          "HTTP/1.1 103 Early Hints\r\nLink: </a>\r\n\r\n" +
          "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok",
      ),
    );
    try {
      const got = await captureRawHttp(s.url, GET);
      expect(got).toEqual({ status: 200, headers: { "content-length": "2" }, body: "ok" });
    } finally {
      await s.close();
    }
  });

  it("keeps the specific parse error when a socket error follows", async () => {
    const s = await resetServer("BOGUS\r\n\r\n");
    try {
      await expect(captureRawHttp(s.url, GET)).rejects.toThrow(
        /before the response was complete \(incomplete: captureRawHttp: bad status line: BOGUS\)/,
      );
      expect(s.errors).toMatchObject([{ code: "ECONNRESET" }]);
    } finally {
      await s.close();
    }
  });

  it("keeps __proto__ and constructor response headers", async () => {
    const s = await rawServer((sock) =>
      sock.end("HTTP/1.1 200 OK\r\n__proto__: p\r\nConstructor: c\r\nContent-Length: 0\r\n\r\n"),
    );
    try {
      const got = await captureRawHttp(s.url, GET);
      expect(serializeGolden(got)).toContain(
        '"headers": {\n    "__proto__": "p",\n    "constructor": "c",\n    "content-length": "0"\n  }',
      );
    } finally {
      await s.close();
    }
  });

  it("records a body that is not UTF-8 as base64, and keeps a BOM", async () => {
    const reply = (body: Buffer) =>
      Buffer.concat([
        Buffer.from(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\n\r\n`),
        body,
      ]);
    const bodies = [Buffer.from([0xff]), Buffer.from([0xfe]), Buffer.from("﻿hi")];
    let i = 0;
    const s = await rawServer((sock) => sock.end(reply(bodies[i++]!)));
    try {
      const a = await captureRawHttp(s.url, GET);
      const b = await captureRawHttp(s.url, GET);
      const bom = await captureRawHttp(s.url, GET);
      expect(a.body).toBeUndefined();
      expect(a.bodyBase64).toBe("/w==");
      expect(serializeGolden(a)).not.toBe(serializeGolden(b));
      expect(bom.body).toBe("﻿hi");
    } finally {
      await s.close();
    }
  });

  it("times out with its own descriptive error before the test timeout", async () => {
    expect(RAW_HTTP_TIMEOUT_MS).toBeLessThanOrEqual(2500);
    const s = await rawServer((sock) => sock.write("HTTP/1.1 200 OK\r\n"));
    try {
      await expect(captureRawHttp(s.url, GET)).rejects.toThrow(
        /no close within \d+ms; got: HTTP\/1\.1 200 OK/,
      );
    } finally {
      await s.close();
    }
  });
});

// ─── captureHttp ────────────────────────────────────────────────────────────

describe("captureHttp", () => {
  it("captures a redirect as sent, without following it", async () => {
    const stub = await startStubUpstream((_req, res) => {
      res.writeHead(302, { location: "/elsewhere", "content-length": "0" });
      res.end();
    });
    try {
      const got = await captureHttp(`${stub.url}/start`);
      expect(got.status).toBe(302);
      expect(got.headers.location).toBe("/elsewhere");
      expect(stub.requests.map((r) => r.url)).toEqual(["/start"]);
    } finally {
      await stub.close();
    }
  });

  it("refuses to pin a content-encoded body it would have to decode", async () => {
    const stub = await startStubUpstream((_req, res) => {
      res.writeHead(200, { "content-encoding": "gzip", "content-type": "text/plain" });
      res.end(gzipSync("hello"));
    });
    try {
      await expect(captureHttp(`${stub.url}/`)).rejects.toThrow(/content-encoding "gzip"/);
      expect(stub.requests[0]?.headers["accept-encoding"]).toBe("identity");
    } finally {
      await stub.close();
    }
  });

  it("fails on a body cut short by a reset", async () => {
    const s = await rawServer((sock) => {
      sock.write("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n0123456789", () =>
        sock.resetAndDestroy(),
      );
    });
    try {
      await expect(captureHttp(s.url)).rejects.toThrow(FETCH_LOST);
    } finally {
      await s.close();
    }
  });

  it("times out with its own descriptive error, with what arrived, before the test timeout", async () => {
    expect(CAPTURE_HTTP_TIMEOUT_MS).toBeLessThanOrEqual(2500);
    const s = await rawServer((sock) =>
      sock.write("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\npartial-bytes"),
    );
    try {
      await expect(captureHttp(s.url)).rejects.toThrow(
        /captureHttp: no end within \d+ms; status 200; got: partial-bytes$/,
      );
    } finally {
      await s.close();
    }
  });

  it("records an SSE body that is not UTF-8 as base64, with no frames", async () => {
    const stub = await startStubUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(Buffer.from([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xff, 0x0a, 0x0a]));
    });
    try {
      const got = await captureHttp(stub.url, { frames: "sse" });
      expect(got.frames).toBeUndefined();
      expect(got.bodyBase64).toBe("ZGF0YTog/woK");
    } finally {
      await stub.close();
    }
  });
});

// ─── startStubUpstream ──────────────────────────────────────────────────────

describe("startStubUpstream", () => {
  it.each([
    [
      "sync",
      () => {
        throw new Error("boom-sync");
      },
    ],
    [
      "async",
      async () => {
        await Promise.resolve();
        throw new Error("boom-async");
      },
    ],
  ])("fails loudly when a %s handler throws", async (kind, handler) => {
    const stub = await startStubUpstream(handler);
    // No plausible response reaches the client: the connection is destroyed.
    await expect(captureHttp(`${stub.url}/x`)).rejects.toThrow(FETCH_LOST);
    expect(stub.errors.map((e) => String(e))).toEqual([`Error: boom-${kind}`]);
    await withGoldenEnv({}, () => {
      expect(() => expectGolden("harness", "openai-chat-nonstream", {})).toThrow(
        new RegExp(`stub upstream handler threw: Error: boom-${kind}`),
      );
    });
    // Already reported by expectGolden: close() does not report it again.
    await expect(stub.close()).resolves.toBeUndefined();
  });

  it("reports an error once: close() takes it off the expectGolden queue", async () => {
    const stub = await startStubUpstream(() => {
      throw new Error("boom-close");
    });
    await expect(captureHttp(`${stub.url}/x`)).rejects.toThrow(FETCH_LOST);
    await expect(stub.close()).rejects.toThrow(/stub upstream handler threw: Error: boom-close/);
    // A later, unrelated case must not inherit the error.
    const got = await chatNonStream();
    await withGoldenEnv({}, () => {
      expectGolden("harness", "openai-chat-nonstream", got);
    });
  });

  it("labels a request stream error as such, not as a handler error", async () => {
    const stub = await startStubUpstream((_req, res) => {
      res.end("unreachable");
    });
    const sock = net.connect(Number(new URL(stub.url).port), "127.0.0.1");
    sock.on("error", () => {});
    sock.write("POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\nabc", () =>
      setTimeout(() => sock.resetAndDestroy(), 20),
    );
    await vi.waitFor(() => expect(stub.errors).toHaveLength(1));
    await expect(stub.close()).rejects.toThrow(/^stub upstream request stream failed: Error: /);
  });

  it("records requests", async () => {
    const stub = await startStubUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    try {
      const got = await captureHttp(`${stub.url}/x`, { method: "POST", body: "hi" });
      expect(got.status).toBe(200);
      expect(stub.requests.map((r) => [r.method, r.url, r.body])).toEqual([["POST", "/x", "hi"]]);
    } finally {
      await stub.close();
    }
  });
});

// ─── goldenPath / expectGolden ──────────────────────────────────────────────

describe("goldenPath", () => {
  it("rejects names that could escape the snapshot root", () => {
    expect(() => goldenPath("../x", "a")).toThrow(/suite name/);
    expect(() => goldenPath("x", "a/b")).toThrow(/case name/);
    expect(() => goldenPath("x", "a..b")).toThrow(/case name/);
    expect(goldenPath("models", "openai-no-hints")).toMatch(
      /src\/__tests__\/golden\/__snapshots__\/models\/openai-no-hints\.json$/,
    );
  });
});

describe("expectGolden", () => {
  const suite = "selftest";
  const realSuiteDir = dirname(goldenPath(suite, "x"));
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "aimock-golden-root-"));
    setGoldenRootForSelfTest(root);
  });
  afterAll(() => {
    setGoldenRootForSelfTest(undefined);
    rmSync(root, { recursive: true, force: true });
  });

  it("writes self-test goldens under a temp root, never the real snapshot dir", () => {
    expect(goldenPath(suite, "x")).toBe(join(root, suite, "x.json"));
    expect(realSuiteDir).not.toContain(root);
  });

  it("fails on a missing golden when GOLDEN_WRITE is unset, and writes nothing", async () => {
    const file = goldenPath("harness", "never-captured");
    await withGoldenEnv({}, () => {
      expect(() => expectGolden("harness", "never-captured", { a: 1 })).toThrow(/golden missing/);
    });
    expect(existsSync(file)).toBe(false);
  });

  it.each([
    [{ GOLDEN_WRITE: "1" }],
    [{ GOLDEN_WRITE: "1", CI: "true" }],
    [{ GOLDEN_WRITE: "1", GOLDEN_CAPTURE_RUN: "1", CI: "true" }],
    [{ GOLDEN_WRITE: "1", GOLDEN_CAPTURE_RUN: "1", CI: "1" }],
  ])("refuses to write under %o, and writes nothing", async (env) => {
    await withGoldenEnv(env, () => {
      expect(() => expectGolden(suite, "guarded", { a: 1 })).toThrow(
        /GOLDEN_WRITE=1 is set, but goldens are written only by `pnpm golden:capture`/,
      );
    });
    expect(existsSync(goldenPath(suite, "guarded"))).toBe(false);
  });

  it("writes and logs the absolute path under a capture run outside CI", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "aimock-golden-log-"));
    const log = join(logDir, "written.log");
    try {
      for (const ci of [undefined, "", "0", "false"]) {
        const env: GoldenEnv = { GOLDEN_WRITE: "1", GOLDEN_CAPTURE_RUN: "1" };
        if (ci !== undefined) env.CI = ci;
        await withGoldenEnv({ ...env, GOLDEN_WRITE_LOG: log }, () => {
          expectGolden(suite, "written", { a: "msg_AAAAAAAAAAAAAAAA" });
        });
      }
      await withGoldenEnv({ GOLDEN_WRITE: "1", GOLDEN_CAPTURE_RUN: "1" }, () => {
        expectGolden(suite, "unlogged", { a: 2 });
      });
      const file = goldenPath(suite, "written");
      expect(readFileSync(file, "utf8")).toBe('{\n  "a": "msg_<#0>"\n}\n');
      expect(existsSync(goldenPath(suite, "unlogged"))).toBe(true);
      expect(readFileSync(log, "utf8")).toBe(`${file}\n`.repeat(4));
      await withGoldenEnv({}, () => {
        expectGolden(suite, "written", { a: "msg_BBBBBBBBBBBBBBBB" });
      });
      expect(existsSync(realSuiteDir)).toBe(false);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });
});

// ─── Smoke corpus: one case per capture mode ────────────────────────────────

// Most specific first: `userMessage` is a substring match, so "golden smoke"
// would also catch "golden smoke tool" if it came first.
const fixtures: Fixture[] = [
  {
    match: { userMessage: "golden smoke tool" },
    response: { toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }] },
  },
  {
    match: { userMessage: "golden smoke" },
    response: { content: "Hello from the golden harness." },
  },
];

let srv: GoldenServer;

beforeAll(async () => {
  srv = await startGoldenServer(fixtures);
});
afterAll(async () => {
  await srv.close();
});

const json = { "content-type": "application/json" };

function chatNonStream() {
  return captureHttp(`${srv.url}/v1/chat/completions`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: "golden smoke" }],
    }),
  });
}

describe("smoke corpus (suite: harness)", () => {
  it("openai-chat-nonstream", async () => {
    expectGolden("harness", "openai-chat-nonstream", await chatNonStream());
  });

  it("openai-chat-stream-sse", async () => {
    const got = await captureHttp(`${srv.url}/v1/chat/completions`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        model: "gpt-4o",
        stream: true,
        messages: [{ role: "user", content: "golden smoke tool" }],
      }),
      frames: "sse",
    });
    expect(got.tail).toBeUndefined();
    const frames = got.frames as string[];
    expect(frames.some((f) => f.includes('"tool_calls"') && f.includes("get_weather"))).toBe(true);
    expect(frames.some((f) => f.includes("Hello from the golden harness."))).toBe(false);
    expectGolden("harness", "openai-chat-stream-sse", got);
  });

  it("ollama-chat-stream-ndjson", async () => {
    const got = await captureHttp(`${srv.url}/api/chat`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        model: "llama3",
        stream: true,
        messages: [{ role: "user", content: "golden smoke" }],
      }),
      frames: "ndjson",
    });
    expectGolden("harness", "ollama-chat-stream-ndjson", got);
  });

  it("bedrock-invoke-stream-aws", async () => {
    const got = await captureHttp(
      `${srv.url}/model/anthropic.claude-3-haiku/invoke-with-response-stream`,
      {
        method: "POST",
        headers: json,
        body: JSON.stringify({
          anthropic_version: "bedrock-2023-05-31",
          max_tokens: 64,
          messages: [{ role: "user", content: "golden smoke" }],
        }),
        frames: "aws",
      },
    );
    expect(got.frames?.length).toBeGreaterThan(0);
    expectGolden("harness", "bedrock-invoke-stream-aws", got);
  });

  it("raw-socket-get-models", async () => {
    const got = await captureRawHttp(
      srv.url,
      "GET /v1/models HTTP/1.1\r\nHost: golden\r\nConnection: close\r\n\r\n",
    );
    expectGolden("harness", "raw-socket-get-models", got);
  });

  it("detects a one-byte change against an existing golden", async () => {
    const got = await chatNonStream();
    const perturbed = { ...got, body: got.body?.replace("harness.", "harness!") };
    // The two serializations differ in exactly one byte, so the mismatch below
    // proves single-byte sensitivity, not a numbering or code-path difference.
    const a = Buffer.from(serializeGolden(got));
    const b = Buffer.from(serializeGolden(perturbed));
    expect(b.length).toBe(a.length);
    const diff = [...a.keys()].filter((i) => a[i] !== b[i]);
    expect(diff).toHaveLength(1);
    expect([a[diff[0]!], b[diff[0]!]]).toEqual([0x2e, 0x21]); // "." -> "!"
    await withGoldenEnv({}, () => {
      expectGolden("harness", "openai-chat-nonstream", got);
      expect(() => expectGolden("harness", "openai-chat-nonstream", perturbed)).toThrow(
        /golden mismatch/,
      );
    });
  });
});
