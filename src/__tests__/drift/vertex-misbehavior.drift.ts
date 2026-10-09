/** Retained native Vertex observations. No live authentication or acquisition here. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { FinishReason, GoogleGenAI, type GenerateContentResponse } from "@google/genai";
import { beforeAll, describe, expect, it } from "vitest";
import { withFaultFixture } from "../helpers/misbehavior-server.js";
import type { MisbehaviorFault } from "../../types.js";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };
type Cell = "k5-object" | "k5-stream" | "k9-object" | "k9-stream";
interface Observation {
  bytes: Uint8Array;
  status: number;
  contentType: string;
  complete: boolean;
  error?: string;
}
interface RetainedCase {
  id: Cell;
  stream: boolean;
  raw: string;
  rawHash: string;
  requestHash: string;
}
const MODEL = "gemini-2.5-flash";
const INTERPRETER_CODE = "print(default_api.archive(cities=['Tokyo";
const MAX_BODY_BYTES = 256 * 1024;

function isObject(value: Json | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function jsonValue(value: unknown): Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    assert(Number.isFinite(value), "invalid JSON number");
    return value;
  }
  if (Array.isArray(value)) return value.map(jsonValue);
  assert(value !== null && typeof value === "object", "invalid JSON value");
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, jsonValue(child)]));
}
function parseJson(raw: string) {
  return jsonValue(JSON.parse(raw));
}
function sha256(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readChunks(observation: Observation, stream: boolean) {
  assert(observation.status === 200, "HTTP failure");
  assert(observation.complete && !observation.error, "incomplete transport");
  assert(observation.bytes.length > 0 && observation.bytes.length <= MAX_BODY_BYTES, "body bound");
  assert.equal(
    observation.contentType.split(";", 1)[0].trim().toLowerCase(),
    stream ? "text/event-stream" : "application/json",
    "content type",
  );
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(observation.bytes);
  if (!stream) return [parseJson(raw)];
  const normalized = raw.replace(/\r\n/g, "\n");
  assert(!normalized.includes("\r") && normalized.endsWith("\n\n"), "incomplete SSE frame");
  const frames = normalized.slice(0, -2).split("\n\n");
  assert(frames.length > 0, "missing SSE data");
  return frames.map((frame) => {
    const lines = frame.split("\n");
    assert(
      lines.every((line) => line.startsWith("data: ")),
      "unexpected SSE field",
    );
    return parseJson(lines.map((line) => line.slice(6)).join("\n"));
  });
}

function validateUsage(value: Json | undefined, final: boolean) {
  if (value === undefined && !final) return undefined;
  assert(isObject(value), "missing usage");
  for (const [key, count] of Object.entries(value)) {
    if (key.endsWith("TokenCount"))
      assert(
        typeof count === "number" && Number.isInteger(count) && count >= 0,
        "invalid token count",
      );
    if (key.endsWith("TokensDetails")) {
      assert(Array.isArray(count), "invalid token details");
      for (const detail of count) {
        assert(
          isObject(detail) && typeof detail.modality === "string" && detail.modality.length > 0,
          "invalid token modality",
        );
        assert(
          typeof detail.tokenCount === "number" &&
            Number.isInteger(detail.tokenCount) &&
            detail.tokenCount >= 0,
          "invalid detail token count",
        );
      }
    }
  }
  if (final) assert(typeof value.totalTokenCount === "number", "missing final totalTokenCount");
  return value;
}

function validatePart(value: Json) {
  assert(isObject(value), "invalid part");
  if (value.thought !== undefined) assert(typeof value.thought === "boolean", "invalid thought");
  if (value.thoughtSignature !== undefined)
    assert(typeof value.thoughtSignature === "string", "invalid thought signature");
  if (value.text !== undefined) {
    assert(typeof value.text === "string", "invalid text");
    assert(
      Object.keys(value).every((key) => ["text", "thought", "thoughtSignature"].includes(key)),
      "unsupported or mixed text part",
    );
  } else {
    assert(
      Object.keys(value).length === 1 && isObject(value.functionCall),
      "unsupported part union",
    );
    const call = value.functionCall;
    assert(
      typeof call.name === "string" && call.name.length > 0 && isObject(call.args),
      "invalid function call",
    );
    assert(
      Object.keys(call).every((key) => ["name", "args", "id"].includes(key)),
      "unsupported function call field",
    );
    if (call.id !== undefined) assert(typeof call.id === "string", "invalid function call id");
  }
  return value;
}

function compareVertexObservation(
  cell: RetainedCase,
  observation: Observation,
  decoded: GenerateContentResponse[],
  origin: "native" | "modeled" = "native",
) {
  const chunks = readChunks(observation, cell.stream);
  const sdkWire = jsonValue(
    JSON.parse(
      JSON.stringify(
        decoded.map((response) => {
          const wire = { ...response };
          delete wire.sdkHttpResponse;
          return wire;
        }),
      ),
    ),
  );
  assert.deepEqual(sdkWire, chunks, "SDK/provider field mismatch");
  const parts: JsonObject[] = [];
  let terminal: string | undefined;
  let diagnostic: string | undefined;
  let usage: JsonObject | undefined;
  for (const [index, chunk] of chunks.entries()) {
    assert(
      isObject(chunk) && Array.isArray(chunk.candidates) && chunk.candidates.length === 1,
      "invalid candidate envelope",
    );
    assert(terminal === undefined, "output after terminal");
    const candidate = chunk.candidates[0];
    assert(
      isObject(candidate) && (candidate.index === undefined || candidate.index === 0),
      "invalid candidate index",
    );
    if (candidate.finishMessage !== undefined)
      assert(typeof candidate.finishMessage === "string", "invalid finish message");
    if (candidate.content !== undefined) {
      assert(
        isObject(candidate.content) &&
          candidate.content.role === "model" &&
          Array.isArray(candidate.content.parts),
        "invalid content",
      );
      parts.push(...candidate.content.parts.map(validatePart));
    } else assert(candidate.finishReason !== undefined, "nonterminal missing content");
    if (candidate.finishReason !== undefined) {
      assert(
        typeof candidate.finishReason === "string" &&
          Object.values(FinishReason).some((reason) => reason === candidate.finishReason) &&
          candidate.finishReason !== FinishReason.FINISH_REASON_UNSPECIFIED,
        "invalid terminal",
      );
      terminal = candidate.finishReason;
      diagnostic =
        typeof candidate.finishMessage === "string" ? candidate.finishMessage : undefined;
    }
    if (chunk.modelVersion !== undefined) assert(chunk.modelVersion === MODEL, "model mismatch");
    usage = validateUsage(chunk.usageMetadata, index === chunks.length - 1);
  }
  assert(terminal !== undefined && usage !== undefined, "missing terminal");
  const tools = parts.filter((part) => part.functionCall !== undefined);
  const thinking = parts.some(
    (part) => part.thought === true && typeof part.text === "string" && part.text.length > 0,
  );
  const thought = parts.some((part) => part.thought === true);
  const visible = parts.some(
    (part) => part.thought !== true && typeof part.text === "string" && part.text.length > 0,
  );
  let classification: "TARGET_COMPARED" | "NOT_TRIGGERED";
  let reason: string;
  if (cell.id.startsWith("k5")) {
    const call = parts.length === 1 ? parts[0].functionCall : undefined;
    const anomaly =
      origin === "native" &&
      !cell.stream &&
      terminal === "MAX_TOKENS" &&
      isObject(call) &&
      call.name === "google:python_interpreter" &&
      Object.keys(call).length === 2 &&
      isObject(call.args) &&
      Object.keys(call.args).length === 1 &&
      call.args.code === INTERPRETER_CODE;
    if (anomaly) {
      classification = "NOT_TRIGGERED";
      reason = "approved-interpreter-anomaly";
    } else if (terminal === "MAX_TOKENS") {
      assert(tools.length === 0 && !thought, "contradictory-target: K5 tool or thought");
      classification = "TARGET_COMPARED";
      reason = "tool-output-exhaustion";
    } else if (terminal === "MALFORMED_FUNCTION_CALL") {
      assert(
        tools.length === 0 && !thought && diagnostic !== undefined && diagnostic.length > 0,
        "invalid malformed-function terminal",
      );
      classification = "NOT_TRIGGERED";
      reason = "malformed-function-terminal";
    } else {
      assert(
        terminal === "STOP" &&
          !thought &&
          (parts.some((part) => typeof part.text === "string") || tools.length > 0),
        "unapproved K5 outcome",
      );
      for (const part of tools) {
        const tool = part.functionCall;
        assert(
          isObject(tool) &&
            tool.name === "archive" &&
            isObject(tool.args) &&
            Array.isArray(tool.args.cities) &&
            tool.args.cities.every((city) => typeof city === "string"),
          "unexpected archive tool schema",
        );
      }
      classification = "NOT_TRIGGERED";
      reason = "ordinary-completion";
    }
  } else {
    assert(tools.length === 0, "undeclared K9 tool");
    if (thinking && !visible) {
      assert(terminal === "MAX_TOKENS", "contradictory-target: reasoning-only terminal");
      classification = "TARGET_COMPARED";
      reason = "reasoning-only-exhaustion";
    } else {
      assert(
        visible && (terminal === "MAX_TOKENS" || terminal === "STOP"),
        "unapproved K9 outcome",
      );
      classification = "NOT_TRIGGERED";
      reason = "visible-answer-completion";
    }
  }
  return {
    cell: cell.id,
    model: MODEL,
    mode: cell.stream ? "stream" : "object",
    requestHash: cell.requestHash,
    rawHash: sha256(observation.bytes),
    sdk: "DECODED_AND_MATCHED",
    classification,
    terminal,
    usage,
    reason,
    chunks,
  };
}

// Owned HTTP replay of genuine response bytes; SDK requests cannot escape localhost.
async function replay(cell: RetainedCase, raw = cell.raw) {
  const bytes = Buffer.from(raw);
  const observation: Observation = {
    bytes,
    status: 200,
    contentType: cell.stream ? "text/event-stream" : "application/json",
    complete: true,
  };
  const transport = globalThis.fetch;
  let sends = 0;
  const decoded: GenerateContentResponse[] = [];
  const server = createServer((req, res) => {
    sends++;
    req.resume();
    if (sends > 1) {
      res.writeHead(429);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": observation.contentType, "content-length": bytes.length });
    res.end(bytes);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert(address !== null && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const resource = `projects/local/locations/us-central1/publishers/google/models/${MODEL}`;
    const expected = `${base}/v1/${resource}:${cell.stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
    globalThis.fetch = (input, init) => {
      assert.equal(String(input), expected, "SDK replay escaped localhost");
      return transport(input, { ...init, redirect: "error" });
    };
    const sdk = new GoogleGenAI({
      vertexai: true,
      apiKey: "local-replay",
      httpOptions: {
        baseUrl: base,
        apiVersion: "v1",
        timeout: 5000,
        retryOptions: { attempts: 1 },
      },
    });
    const args = { model: resource, contents: "Decode the retained response" };
    if (cell.stream)
      for await (const chunk of await sdk.models.generateContentStream(args)) decoded.push(chunk);
    else decoded.push(await sdk.models.generateContent(args));
    assert.equal(sends, 1, "unexpected SDK retry");
    return { observation, decoded };
  } finally {
    globalThis.fetch = transport;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// Byte-exact, response-only native captures from 2026-10-09; no request headers or credentials.
const retained: RetainedCase[] = [
  {
    id: "k5-object",
    stream: false,
    raw: '{\n  "candidates": [\n    {\n      "content": {\n        "role": "model",\n        "parts": [\n          {\n            "functionCall": {\n              "name": "google:python_interpreter",\n              "args": {\n                "code": "print(default_api.archive(cities=[\'Tokyo"\n              }\n            }\n          }\n        ]\n      },\n      "finishReason": "MAX_TOKENS"\n    }\n  ],\n  "usageMetadata": {\n    "promptTokenCount": 34,\n    "candidatesTokenCount": 11,\n    "totalTokenCount": 45,\n    "trafficType": "ON_DEMAND",\n    "promptTokensDetails": [\n      {\n        "modality": "TEXT",\n        "tokenCount": 34\n      }\n    ],\n    "candidatesTokensDetails": [\n      {\n        "modality": "TEXT",\n        "tokenCount": 11\n      }\n    ]\n  },\n  "modelVersion": "gemini-2.5-flash",\n  "createTime": "2026-10-09T02:21:51.484534Z",\n  "responseId": "v0_IarbJHfbygLUPg7GyqQI"\n}\n',
    rawHash: "ca1f4866a159514c807215a176e779004ebb2d307d3a2159c41ec69a9a677d53",
    requestHash: "9a2018221c7e7d8776e40ea38a631585b00e705349d81052d98621d0bc1f3fba",
  },
  {
    id: "k5-stream",
    stream: true,
    raw: 'data: {"candidates": [{"finishReason": "MALFORMED_FUNCTION_CALL","finishMessage": "Malformed function call: print(default_api.archive(cities=[\'Tokyo"}],"usageMetadata": {"promptTokenCount": 34,"totalTokenCount": 34,"trafficType": "ON_DEMAND","promptTokensDetails": [{"modality": "TEXT","tokenCount": 34}]},"modelVersion": "gemini-2.5-flash","createTime": "2026-10-09T02:30:04.593097Z","responseId": "rFHIasmZJPCXgLUP6vbpsAc"}\r\n\r\n',
    rawHash: "ae0aa45619aab7ad5bfc65bc99908743cafa1d6449a3cfe110d72bf7a243340d",
    requestHash: "9a2018221c7e7d8776e40ea38a631585b00e705349d81052d98621d0bc1f3fba",
  },
  {
    id: "k9-object",
    stream: false,
    raw: '{\n  "candidates": [\n    {\n      "content": {\n        "role": "model",\n        "parts": [\n          {\n            "text": "**Exploring Integer Solutions**\\n\\nI\'m currently investigating the Diophantine equation $x^2 + y^2 + z^2 = 3xyz$. My focus is on employing Vieta jumping techniques to uncover all integer solutions.\\n\\n",\n            "thought": true\n          },\n          {\n            "text": "We want"\n          }\n        ]\n      },\n      "finishReason": "MAX_TOKENS"\n    }\n  ],\n  "usageMetadata": {\n    "promptTokenCount": 28,\n    "candidatesTokenCount": 2,\n    "totalTokenCount": 88,\n    "trafficType": "ON_DEMAND",\n    "promptTokensDetails": [\n      {\n        "modality": "TEXT",\n        "tokenCount": 28\n      }\n    ],\n    "candidatesTokensDetails": [\n      {\n        "modality": "TEXT",\n        "tokenCount": 2\n      }\n    ],\n    "thoughtsTokenCount": 58\n  },\n  "modelVersion": "gemini-2.5-flash",\n  "createTime": "2026-10-09T02:34:18.350278Z",\n  "responseId": "qlLIasawFZq_gLUPxZqAoQY"\n}\n',
    rawHash: "094b7d07a36703198a753dcaf658449ea65ebc58d0e3331a61bccd21b9ab60ec",
    requestHash: "bd2da17176b09de306dd6c290bd75042a4d8a346a8c4f3164466fa50e84482b1",
  },
  {
    id: "k9-stream",
    stream: true,
    raw: 'data: {"candidates": [{"content": {"role": "model","parts": [{"text": "**Exploring Solutions**\\n\\nI\'ve begun by considering the properties of the Diophantine equation $x^2 + y^2 + z^2 = 3xyz$. My initial focus is on identifying any trivial or simple solutions, and then I plan to investigate the equation’s behavior more broadly.\\n\\n","thought": true}]}}],"usageMetadata": {"trafficType": "ON_DEMAND"},"modelVersion": "gemini-2.5-flash","createTime": "2026-10-09T02:36:52.821265Z","responseId": "RFPIapGQMtKCidsPmcai6AM"}\r\n\r\ndata: {"candidates": [{"content": {"role": "model","parts": [{"text": "We"}]}}],"usageMetadata": {"trafficType": "ON_DEMAND"},"modelVersion": "gemini-2.5-flash","createTime": "2026-10-09T02:36:52.821265Z","responseId": "RFPIapGQMtKCidsPmcai6AM"}\r\n\r\ndata: {"candidates": [{"content": {"role": "model","parts": [{"text": ""}]},"finishReason": "MAX_TOKENS"}],"usageMetadata": {"promptTokenCount": 28,"candidatesTokenCount": 1,"totalTokenCount": 88,"trafficType": "ON_DEMAND","promptTokensDetails": [{"modality": "TEXT","tokenCount": 28}],"candidatesTokensDetails": [{"modality": "TEXT","tokenCount": 1}],"thoughtsTokenCount": 59},"modelVersion": "gemini-2.5-flash","createTime": "2026-10-09T02:36:52.821265Z","responseId": "RFPIapGQMtKCidsPmcai6AM"}\r\n\r\n',
    rawHash: "b627e9cab21b6f276a0a1e0d125e51f15fcc53f7c792487cc91cd231e7ef841d",
    requestHash: "bd2da17176b09de306dd6c290bd75042a4d8a346a8c4f3164466fa50e84482b1",
  },
];

describe("Vertex retained native dispositions (offline SDK/HTTP replay)", () => {
  it.each(retained)("$id preserves genuine wire bytes and approved non-trigger", async (cell) => {
    expect(sha256(cell.raw)).toBe(cell.rawHash);
    const { observation, decoded } = await replay(cell);
    const result = compareVertexObservation(cell, observation, decoded);
    expect(result.classification).toBe("NOT_TRIGGERED");
    expect(result.reason).toBe(
      cell.id === "k5-object"
        ? "approved-interpreter-anomaly"
        : cell.id === "k5-stream"
          ? "malformed-function-terminal"
          : "visible-answer-completion",
    );
    expect(result.rawHash).toBe(cell.rawHash);
    console.info(JSON.stringify(result));
  });
});

function derivative(cell: RetainedCase, edit: (chunks: JsonObject[]) => void) {
  const chunks = readChunks(
    {
      bytes: Buffer.from(cell.raw),
      status: 200,
      contentType: cell.stream ? "text/event-stream" : "application/json",
      complete: true,
    },
    cell.stream,
  );
  const objects = chunks.map((chunk) => {
    assert(isObject(chunk));
    return chunk;
  });
  edit(objects);
  return cell.stream
    ? objects.map((chunk) => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join("")
    : JSON.stringify(objects[0]);
}
function candidate(chunk: JsonObject) {
  assert(Array.isArray(chunk.candidates) && isObject(chunk.candidates[0]));
  return chunk.candidates[0];
}
function contentParts(chunk: JsonObject) {
  const content = candidate(chunk).content;
  assert(isObject(content) && Array.isArray(content.parts));
  return content.parts;
}
function interpreter(chunks: JsonObject[]) {
  const part = contentParts(chunks[0])[0];
  assert(isObject(part) && isObject(part.functionCall));
  return part.functionCall;
}
interface NegativeControl {
  name: string;
  cell: number;
  edit: (chunks: JsonObject[]) => void;
  error: RegExp;
}
const negativeControls: NegativeControl[] = [
  {
    name: "different interpreter name",
    cell: 0,
    edit: (chunks) => {
      interpreter(chunks).name = "other";
    },
    error: /contradictory-target/,
  },
  {
    name: "different interpreter program",
    cell: 0,
    edit: (chunks) => {
      interpreter(chunks).args = { code: "print('other')" };
    },
    error: /contradictory-target/,
  },
  {
    name: "extra interpreter argument",
    cell: 0,
    edit: (chunks) => {
      interpreter(chunks).args = { code: INTERPRETER_CODE, extra: 1 };
    },
    error: /contradictory-target/,
  },
  {
    name: "extra interpreter output",
    cell: 0,
    edit: (chunks) => {
      contentParts(chunks[0]).push({ text: "other" });
    },
    error: /contradictory-target/,
  },
  {
    name: "declared tool at K5 MAX_TOKENS",
    cell: 0,
    edit: (chunks) => {
      const call = interpreter(chunks);
      call.name = "archive";
      call.args = { cities: ["Tokyo"] };
    },
    error: /contradictory-target/,
  },
  {
    name: "missing malformed-function diagnostic",
    cell: 1,
    edit: (chunks) => {
      delete candidate(chunks[0]).finishMessage;
    },
    error: /invalid malformed-function terminal/,
  },
  {
    name: "K9 reasoning-only STOP",
    cell: 2,
    edit: (chunks) => {
      contentParts(chunks[0]).splice(1);
      candidate(chunks[0]).finishReason = "STOP";
    },
    error: /contradictory-target/,
  },
  {
    name: "K9 undeclared tool",
    cell: 2,
    edit: (chunks) => {
      contentParts(chunks[0]).push({
        functionCall: { name: "archive", args: { cities: ["Tokyo"] } },
      });
    },
    error: /undeclared K9 tool/,
  },
  {
    name: "mixed text and tool",
    cell: 2,
    edit: (chunks) => {
      contentParts(chunks[0])[1] = { text: "We want", functionCall: { name: "archive", args: {} } };
    },
    error: /mixed text part/,
  },
  {
    name: "nonzero candidate index",
    cell: 2,
    edit: (chunks) => {
      candidate(chunks[0]).index = 1;
    },
    error: /invalid candidate index/,
  },
  {
    name: "output after terminal",
    cell: 3,
    edit: (chunks) => {
      chunks.push(chunks[0]);
    },
    error: /output after terminal/,
  },
  {
    name: "missing terminal",
    cell: 3,
    edit: (chunks) => {
      delete candidate(chunks[chunks.length - 1]).finishReason;
    },
    error: /missing terminal/,
  },
  {
    name: "missing final total usage",
    cell: 3,
    edit: (chunks) => {
      const usage = chunks[chunks.length - 1].usageMetadata;
      assert(isObject(usage));
      delete usage.totalTokenCount;
    },
    error: /missing final totalTokenCount/,
  },
  {
    name: "negative token count",
    cell: 2,
    edit: (chunks) => {
      const usage = chunks[0].usageMetadata;
      assert(isObject(usage));
      usage.thoughtsTokenCount = -1;
    },
    error: /invalid token count/,
  },
  {
    name: "invalid content role",
    cell: 2,
    edit: (chunks) => {
      const content = candidate(chunks[0]).content;
      assert(isObject(content));
      content.role = "user";
    },
    error: /invalid content/,
  },
  {
    name: "unknown terminal",
    cell: 2,
    edit: (chunks) => {
      candidate(chunks[0]).finishReason = "NEW_OUTCOME";
    },
    error: /invalid terminal/,
  },
];

describe("Vertex retained-capture derivatives (actual SDK/HTTP)", () => {
  it.each(negativeControls)("rejects $name", async ({ cell: index, edit, error }) => {
    const cell = retained[index];
    const raw = derivative(cell, edit);
    const { observation, decoded } = await replay(cell, raw);
    expect(() => compareVertexObservation(cell, observation, decoded)).toThrow(error);
  });
  it("never treats the interpreter anomaly as a modeled target", async () => {
    const cell = retained[0];
    const { observation, decoded } = await replay(cell);
    expect(() => compareVertexObservation(cell, observation, decoded, "modeled")).toThrow(
      /contradictory-target/,
    );
  });
  it("rejects the same interpreter anomaly in streaming", async () => {
    const cell: RetainedCase = { ...retained[0], id: "k5-stream", stream: true };
    const raw = `data: ${JSON.stringify(JSON.parse(retained[0].raw))}\r\n\r\n`;
    const { observation, decoded } = await replay(cell, raw);
    expect(() => compareVertexObservation(cell, observation, decoded)).toThrow(
      /contradictory-target/,
    );
  });
  it.each([0, 1])("compares K5 MAX_TOKENS without a tool in mode %i", async (index) => {
    const cell = retained[index];
    const raw = derivative(cell, (chunks) => {
      const last = candidate(chunks[chunks.length - 1]);
      delete last.content;
      delete last.finishMessage;
      last.finishReason = "MAX_TOKENS";
    });
    const { observation, decoded } = await replay(cell, raw);
    expect(compareVertexObservation(cell, observation, decoded).classification).toBe(
      "TARGET_COMPARED",
    );
  });
  it.each([2, 3])(
    "compares K9 reasoning-only while preserving empty terminal text in mode %i",
    async (index) => {
      const cell = retained[index];
      const raw = derivative(cell, (chunks) => {
        for (const chunk of chunks) {
          const parts = contentParts(chunk);
          for (const part of parts) if (isObject(part) && part.thought !== true) part.text = "";
        }
      });
      const { observation, decoded } = await replay(cell, raw);
      expect(compareVertexObservation(cell, observation, decoded).classification).toBe(
        "TARGET_COMPARED",
      );
    },
  );
  it("preserves omitted counts and complete thought plus answer", async () => {
    const malformed = retained[1];
    const first = await replay(malformed);
    expect(
      compareVertexObservation(malformed, first.observation, first.decoded).usage,
    ).not.toHaveProperty("candidatesTokenCount");
    const answer = retained[3];
    const second = await replay(answer);
    const result = compareVertexObservation(answer, second.observation, second.decoded);
    expect(result.classification).toBe("NOT_TRIGGERED");
    expect(result.chunks).toHaveLength(3);
    expect(result.usage.thoughtsTokenCount).toBe(59);
  });
});

describe("Vertex strict wire prerequisites", () => {
  const cell = retained[3];
  const valid: Observation = {
    bytes: Buffer.from(cell.raw),
    status: 200,
    contentType: "text/event-stream",
    complete: true,
  };
  it.each([
    {
      name: "HTTP authentication failure",
      observation: { ...valid, status: 401 },
      error: /HTTP failure/,
    },
    {
      name: "transport error",
      observation: { ...valid, error: "aborted" },
      error: /incomplete transport/,
    },
    {
      name: "unclean end",
      observation: { ...valid, complete: false },
      error: /incomplete transport/,
    },
    {
      name: "body overflow",
      observation: { ...valid, bytes: Buffer.alloc(MAX_BODY_BYTES + 1) },
      error: /body bound/,
    },
    {
      name: "wrong media type",
      observation: { ...valid, contentType: "application/json" },
      error: /content type/,
    },
    {
      name: "truncated UTF-8",
      observation: { ...valid, bytes: Buffer.from([0xc3]) },
      error: /encoded data/,
    },
    {
      name: "truncated SSE",
      observation: { ...valid, bytes: valid.bytes.subarray(0, -1) },
      error: /incomplete SSE frame/,
    },
    {
      name: "foreign SSE field",
      observation: { ...valid, bytes: Buffer.from("event: message\n\ndata: {}\n\n") },
      error: /unexpected SSE field/,
    },
    {
      name: "invalid JSON",
      observation: { ...valid, bytes: Buffer.from("data: {\n\n") },
      error: /JSON/,
    },
  ])("rejects $name before disposition", ({ observation, error }) => {
    expect(() => readChunks(observation, true)).toThrow(error);
  });
  it("rejects an SDK/provider field mismatch", async () => {
    const { observation, decoded } = await replay(cell);
    decoded[0].responseId = "different";
    expect(() => compareVertexObservation(cell, observation, decoded)).toThrow(
      /SDK\/provider field mismatch/,
    );
  });
});

describe("Vertex exact exception and optional interim usage", () => {
  it("does not extend the interpreter exception to additional call fields", async () => {
    const cell = retained[0];
    const raw = derivative(cell, (chunks) => {
      interpreter(chunks).id = "new-field";
    });
    const { observation, decoded } = await replay(cell, raw);
    expect(() => compareVertexObservation(cell, observation, decoded)).toThrow(
      /contradictory-target/,
    );
  });
  it("permits absent interim usage while requiring final usage", async () => {
    const cell = retained[3];
    const raw = derivative(cell, (chunks) => {
      delete chunks[0].usageMetadata;
    });
    const { observation, decoded } = await replay(cell, raw);
    expect(compareVertexObservation(cell, observation, decoded).classification).toBe(
      "NOT_TRIGGERED",
    );
  });
  it.each(["archive", "wrong-tool"])("checks STOP tool schema for %s", async (name) => {
    const cell = retained[0];
    const raw = derivative(cell, (chunks) => {
      candidate(chunks[0]).finishReason = "STOP";
      const call = interpreter(chunks);
      call.name = name;
      call.args = { cities: ["Tokyo"] };
    });
    const { observation, decoded } = await replay(cell, raw);
    if (name === "archive")
      expect(compareVertexObservation(cell, observation, decoded).reason).toBe(
        "ordinary-completion",
      );
    else
      expect(() => compareVertexObservation(cell, observation, decoded)).toThrow(
        /unexpected archive tool schema/,
      );
  });
});

describe("Vertex K5 STOP ordinary text presence (V2A-1)", () => {
  it.each([0, 1])("accepts empty ordinary text in mode %i", async (index) => {
    const cell = retained[index];
    const raw = derivative(cell, (chunks) => {
      const last = candidate(chunks[chunks.length - 1]);
      last.content = { role: "model", parts: [{ text: "" }] };
      last.finishReason = "STOP";
      delete last.finishMessage;
    });
    const { observation, decoded } = await replay(cell, raw);
    console.info(
      JSON.stringify({ proof: "V2A-1", cell: cell.id, rawHash: sha256(raw), raw, decoded }),
    );
    const result = compareVertexObservation(cell, observation, decoded);
    expect(result.classification).toBe("NOT_TRIGGERED");
    expect(result.reason).toBe("ordinary-completion");
  });
  it.each([0, 1])(
    "rejects absent text, thought and wrong tools at STOP in mode %i",
    async (index) => {
      const cell = retained[index];
      for (const parts of [
        undefined,
        [],
        [{ text: "", thought: true }],
        [{ functionCall: { name: "wrong-tool", args: {} } }],
      ]) {
        const raw = derivative(cell, (chunks) => {
          const last = candidate(chunks[chunks.length - 1]);
          if (parts === undefined) delete last.content;
          else last.content = { role: "model", parts };
          last.finishReason = "STOP";
          delete last.finishMessage;
        });
        const { observation, decoded } = await replay(cell, raw);
        expect(() => compareVertexObservation(cell, observation, decoded)).toThrow(
          /unapproved K5 outcome|unexpected archive tool schema/,
        );
      }
    },
  );
});

interface ModeledCase {
  id: Cell;
  stream: boolean;
  fault: MisbehaviorFault;
  expectedText: string;
}
const modeledCases: ModeledCase[] = [
  {
    id: "k5-object",
    stream: false,
    fault: { fault: "stop-length-mid-tool", at: 0.25 },
    expectedText: "Before archive.",
  },
  {
    id: "k5-stream",
    stream: true,
    fault: { fault: "stop-length-mid-tool", at: 0.75 },
    expectedText: "Before archive.",
  },
  {
    id: "k9-object",
    stream: false,
    fault: { fault: "reasoning-only", reasoning: "Inspect the integer equation." },
    expectedText: "Inspect the integer equation.",
  },
  {
    id: "k9-stream",
    stream: true,
    fault: { fault: "reasoning-only", reasoning: "Try infinite descent carefully." },
    expectedText: "Try infinite descent carefully.",
  },
];

function compareModeledVertex(
  cell: RetainedCase,
  observation: Observation,
  decoded: GenerateContentResponse[],
  expectedText: string,
) {
  const result = compareVertexObservation(cell, observation, decoded, "modeled");
  assert.equal(
    result.classification,
    "TARGET_COMPARED",
    "modeled fault did not trigger its target",
  );
  const parts = result.chunks.flatMap((chunk) => {
    assert(isObject(chunk));
    return contentParts(chunk);
  });
  const text = parts
    .map((part) => {
      assert(isObject(part));
      return typeof part.text === "string" ? part.text : "";
    })
    .join("");
  assert.equal(text, expectedText, "modeled authored text mismatch");
  const promptTokens = Math.ceil("weather".length / 4);
  const outputTokens = Math.max(1, Math.ceil(expectedText.length / 4));
  assert.deepEqual(
    result.usage,
    {
      promptTokenCount: promptTokens,
      candidatesTokenCount: outputTokens,
      totalTokenCount: promptTokens + outputTokens,
    },
    "modeled emitted usage mismatch",
  );
  return result;
}

async function probeModeledVertex(cell: ModeledCase) {
  await withFaultFixture(
    { faults: [cell.fault] },
    async ({ mock, url }) => {
      const resource = `projects/local/locations/us-central1/publishers/google/models/${MODEL}`;
      const expectedUrl = `${url}/v1/${resource}:${cell.stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
      const transport = globalThis.fetch;
      const observations: Observation[] = [];
      const requestBodies: string[] = [];
      const decoded: GenerateContentResponse[] = [];
      try {
        globalThis.fetch = async (input, init) => {
          assert.equal(String(input), expectedUrl, "local SDK request escaped aimock");
          assert.equal(requestBodies.length, 0, "unexpected SDK retry");
          assert(typeof init?.body === "string", "missing SDK request body");
          requestBodies.push(init.body);
          const response = await transport(input, { ...init, redirect: "error" });
          const bytes = new Uint8Array(await response.clone().arrayBuffer());
          observations.push({
            bytes,
            status: response.status,
            contentType: response.headers.get("content-type") ?? "",
            complete: true,
          });
          return response;
        };
        const sdk = new GoogleGenAI({
          vertexai: true,
          apiKey: "local",
          httpOptions: {
            baseUrl: url,
            apiVersion: "v1",
            timeout: 5000,
            retryOptions: { attempts: 1 },
          },
        });
        const tools = cell.id.startsWith("k5")
          ? [
              {
                functionDeclarations: [
                  {
                    name: "archive",
                    parametersJsonSchema: {
                      type: "object",
                      properties: { cities: { type: "array", items: { type: "string" } } },
                      required: ["cities"],
                    },
                  },
                ],
              },
            ]
          : undefined;
        const request = { model: resource, contents: "weather", config: { tools } };
        if (cell.stream)
          for await (const chunk of await sdk.models.generateContentStream(request))
            decoded.push(chunk);
        else decoded.push(await sdk.models.generateContent(request));
        expect(observations).toHaveLength(1);
        const observation = observations[0];
        const identity: RetainedCase = {
          id: cell.id,
          stream: cell.stream,
          raw: Buffer.from(observation.bytes).toString("utf8"),
          rawHash: sha256(observation.bytes),
          requestHash: sha256(requestBodies[0]),
        };
        console.info(
          JSON.stringify({
            proof: "Vertex modeled local",
            cell: cell.id,
            fault: cell.fault,
            expectedText: cell.expectedText,
            requestHash: identity.requestHash,
            rawHash: identity.rawHash,
            raw: identity.raw,
            decoded,
            journal: mock.getRequests().map((entry) => entry.response),
          }),
        );
        compareModeledVertex(identity, observation, decoded, cell.expectedText);
        const entries = mock.getRequests();
        expect(entries).toHaveLength(1);
        expect(entries[0].response.status).toBe(200);
        expect(entries[0].response.misbehavior).toMatchObject({
          applied: true,
          fault: cell.fault.fault,
          wire: "gemini",
          servedToolCalls: [],
        });
        expect(entries[0].response.misbehavior?.evaluations).toHaveLength(1);
        expect(entries[0].response.misbehavior?.evaluations[0]).toMatchObject({
          outcome: "applied",
          ordinal: 0,
        });
      } finally {
        globalThis.fetch = transport;
      }
    },
    {
      response: {
        content: "Before archive.",
        toolCalls: [
          {
            id: "call_archive",
            name: "archive",
            arguments: { cities: ["Tokyo", "Paris", "Lima"] },
          },
        ],
        usage: { promptTokenCount: 901, candidatesTokenCount: 902, totalTokenCount: 1803 },
      },
    },
  );
}

describe("Vertex local modeled contracts (actual SDK to aimock)", () => {
  it.each(modeledCases)("$id compares authored fault values", probeModeledVertex);
});

// Exact approved native request bytes; bodies are shared by object and SSE modes.
const VERTEX_K5_BODY =
  '{\n  "contents": [\n    {\n      "role": "user",\n      "parts": [\n        {\n          "text": "Call archive with an array of 200 distinct full city names. Do not abbreviate the names."\n        }\n      ]\n    }\n  ],\n  "tools": [\n    {\n      "functionDeclarations": [\n        {\n          "name": "archive",\n          "description": "Archive a list of city names",\n          "parameters": {\n            "type": "OBJECT",\n            "properties": {\n              "cities": {\n                "type": "ARRAY",\n                "items": {\n                  "type": "STRING"\n                }\n              }\n            },\n            "required": [\n              "cities"\n            ]\n          }\n        }\n      ]\n    }\n  ],\n  "toolConfig": {\n    "functionCallingConfig": {\n      "mode": "ANY"\n    }\n  },\n  "generationConfig": {\n    "maxOutputTokens": 16,\n    "thinkingConfig": {\n      "thinkingBudget": 0\n    }\n  }\n}\n';
const VERTEX_K9_BODY =
  '{\n  "contents": [\n    {\n      "role": "user",\n      "parts": [\n        {\n          "text": "Find every integer solution of x^2 + y^2 + z^2 = 3xyz, explaining the infinite descent argument carefully."\n        }\n      ]\n    }\n  ],\n  "generationConfig": {\n    "maxOutputTokens": 64,\n    "thinkingConfig": {\n      "includeThoughts": true,\n      "thinkingBudget": 1024\n    }\n  }\n}\n';
const VERTEX_PROJECT = "llmock-drift-testing";
const VERTEX_LOCATION = "us-central1";
const VERTEX_ORIGIN = "https://us-central1-aiplatform.googleapis.com";
const vertexCases = retained.map((cell, index) => ({
  ...cell,
  body: index < 2 ? VERTEX_K5_BODY : VERTEX_K9_BODY,
  cap: index < 2 ? 16 : 64,
}));
function vertexPath(stream: boolean) {
  return `/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_LOCATION}/publishers/google/models/${MODEL}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
}
interface VertexEnvironment {
  AIMOCK_VERTEX_LIVE?: string;
  AIMOCK_VERTEX_PROJECT?: string;
  AIMOCK_VERTEX_LOCATION?: string;
  AIMOCK_VERTEX_MODEL?: string;
  AIMOCK_VERTEX_ACCESS_TOKEN?: string;
}
const localVertexEnvironment: VertexEnvironment = {
  AIMOCK_VERTEX_LIVE: "1",
  AIMOCK_VERTEX_PROJECT: VERTEX_PROJECT,
  AIMOCK_VERTEX_LOCATION: VERTEX_LOCATION,
  AIMOCK_VERTEX_MODEL: MODEL,
  AIMOCK_VERTEX_ACCESS_TOKEN: "local-coordinator-test",
};

function vertexConfiguration(env: VertexEnvironment) {
  if (env.AIMOCK_VERTEX_LIVE === undefined || env.AIMOCK_VERTEX_LIVE === "0") return undefined;
  assert(env.AIMOCK_VERTEX_LIVE === "1", "invalid Vertex live flag");
  assert(
    env.AIMOCK_VERTEX_PROJECT === VERTEX_PROJECT &&
      env.AIMOCK_VERTEX_LOCATION === VERTEX_LOCATION &&
      env.AIMOCK_VERTEX_MODEL === MODEL,
    "invalid enabled Vertex project/location/model",
  );
  assert(
    typeof env.AIMOCK_VERTEX_ACCESS_TOKEN === "string" &&
      env.AIMOCK_VERTEX_ACCESS_TOKEN.trim().length > 0,
    "enabled Vertex token missing",
  );
  return { token: env.AIMOCK_VERTEX_ACCESS_TOKEN };
}

function vertexBudget() {
  let attempts = 0;
  let tokens = 0;
  let blocked = false;
  return {
    claim(cell: (typeof vertexCases)[number]) {
      assert(
        !blocked &&
          attempts < 4 &&
          cell.id === vertexCases[attempts].id &&
          cell.cap === (attempts < 2 ? 16 : 64) &&
          tokens + cell.cap <= 160,
        "Vertex send/order/token budget exhausted or blocked",
      );
      attempts++;
      tokens += cell.cap;
    },
    stop() {
      blocked = true;
    },
    state() {
      return { attempts, tokens, blocked };
    },
  };
}

// Same bounded raw-byte acquisition as the reviewed one-shot packet. No SDK/HTTP retry.
async function acquireVertexObservation(
  cell: (typeof vertexCases)[number],
  origin: string,
  token: string,
  budget: ReturnType<typeof vertexBudget>,
  limits = { timeoutMs: 45000, maxBytes: MAX_BODY_BYTES },
) {
  assert(
    origin === VERTEX_ORIGIN || /^http:\/\/127\.0\.0\.1:\d+$/.test(origin),
    "unexpected Vertex origin",
  );
  assert(
    Number.isInteger(limits.timeoutMs) &&
      limits.timeoutMs > 0 &&
      limits.timeoutMs <= 45000 &&
      Number.isInteger(limits.maxBytes) &&
      limits.maxBytes > 0 &&
      limits.maxBytes <= MAX_BODY_BYTES,
    "invalid Vertex capture bounds",
  );
  budget.claim(cell);
  const observation: Observation = {
    bytes: new Uint8Array(),
    status: 0,
    contentType: "",
    complete: false,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
  const pieces: Uint8Array[] = [];
  let length = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(`${origin}${vertexPath(cell.stream)}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: cell.body,
      redirect: "error",
      signal: controller.signal,
    });
    observation.status = response.status;
    observation.contentType = response.headers.get("content-type") ?? "";
    reader = response.body?.getReader();
    assert(reader, "missing response body");
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = limits.maxBytes - length;
      const prefix = value.subarray(0, remaining);
      pieces.push(prefix);
      length += prefix.length;
      if (value.length > remaining) {
        observation.error = "BYTE_CEILING";
        break;
      }
    }
    observation.bytes = Buffer.concat(pieces);
    if (!observation.error) {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(observation.bytes);
      } catch {
        observation.error = "MALFORMED_UTF8";
      }
    }
    observation.complete = observation.error === undefined;
  } catch {
    observation.bytes = Buffer.concat(pieces);
    observation.error = controller.signal.aborted ? "ABORTED_OR_DEADLINE" : "TRANSPORT_FAILURE";
  } finally {
    clearTimeout(timer);
    try {
      await reader?.cancel();
    } catch {
      /* Original transport failure is retained above. */
    }
    reader?.releaseLock();
  }
  return observation;
}

interface VertexRunResult {
  cell: Cell;
  model: string;
  mode: string;
  requestHash: string;
  rawHash: string | null;
  rawBase64: string;
  sdk: string;
  classification: "TARGET_COMPARED" | "NOT_TRIGGERED" | "FAILURE" | "UNATTEMPTED" | "SKIPPED";
  terminal: string | null;
  usage: JsonObject | null;
  reason: string;
  chunks: Json[];
  elapsedMs: number;
  status: number | null;
  complete: boolean;
}
function unattemptedVertexResult(
  cell: (typeof vertexCases)[number],
  enabled: boolean,
): VertexRunResult {
  return {
    cell: cell.id,
    model: MODEL,
    mode: cell.stream ? "stream" : "object",
    requestHash: sha256(cell.body),
    rawHash: null,
    rawBase64: "",
    sdk: "NOT_ATTEMPTED",
    classification: enabled ? "UNATTEMPTED" : "SKIPPED",
    terminal: null,
    usage: null,
    reason: enabled ? "earlier-case-failed" : "live-disabled",
    chunks: [],
    elapsedMs: 0,
    status: null,
    complete: false,
  };
}

async function runVertexRecurrence(env: VertexEnvironment, origin = VERTEX_ORIGIN) {
  const config = vertexConfiguration(env);
  const budget = vertexBudget();
  const results = vertexCases.map((cell) => unattemptedVertexResult(cell, config !== undefined));
  if (config)
    for (const [index, cell] of vertexCases.entries()) {
      const started = performance.now();
      let observation: Observation | undefined;
      let sdk = "NOT_ATTEMPTED";
      try {
        observation = await acquireVertexObservation(cell, origin, config.token, budget);
        assert(
          observation.status === 200 && observation.complete && !observation.error,
          "Vertex acquisition failed",
        );
        const raw = new TextDecoder("utf-8", { fatal: true }).decode(observation.bytes);
        sdk = "DECODE_FAILED";
        const { decoded } = await replay(cell, raw);
        sdk = "DECODED";
        const sdkChunks = jsonValue(
          JSON.parse(
            JSON.stringify(
              decoded.map((response) => {
                const wire = { ...response };
                delete wire.sdkHttpResponse;
                return wire;
              }),
            ),
          ),
        );
        assert(Array.isArray(sdkChunks));
        const sdkUsage = jsonValue(
          JSON.parse(JSON.stringify(decoded.at(-1)?.usageMetadata ?? null)),
        );
        results[index] = {
          ...results[index],
          terminal: decoded.at(-1)?.candidates?.[0]?.finishReason ?? null,
          usage: isObject(sdkUsage) ? sdkUsage : null,
          chunks: sdkChunks,
        };
        const result = compareVertexObservation(cell, observation, decoded, "native");
        results[index] = {
          ...result,
          requestHash: sha256(cell.body),
          elapsedMs: performance.now() - started,
          rawBase64: Buffer.from(observation.bytes).toString("base64"),
          status: observation.status,
          complete: observation.complete,
        };
      } catch {
        budget.stop();
        results[index] = {
          ...results[index],
          classification: "FAILURE",
          rawHash: observation ? sha256(observation.bytes) : null,
          rawBase64: observation ? Buffer.from(observation.bytes).toString("base64") : "",
          sdk,
          elapsedMs: performance.now() - started,
          status: observation?.status ?? null,
          complete: observation?.complete ?? false,
          reason:
            observation?.error ??
            (observation?.status !== 200 ? "HTTP_FAILURE" : "WIRE_OR_SDK_REJECTED"),
        };
        break;
      }
    }
  return {
    results,
    budget: budget.state(),
    outerCollectorMaximum: { attempts: 3, sends: 12, requestedOutputTokens: 480 },
  };
}

async function withVertexSequence(
  run: (origin: string, requests: { path: string; body: string }[]) => Promise<void>,
  failAt = -1,
  transportFault?: "redirect" | "cutoff" | "overflow" | "stall" | "contradiction",
) {
  const requests: { path: string; body: string }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const index = requests.length;
    requests.push({ path: req.url ?? "", body: Buffer.concat(chunks).toString("utf8") });
    const cell = retained[index % retained.length];
    let raw = Buffer.from(cell.raw);
    if (transportFault === "contradiction")
      raw = Buffer.from(cell.raw.replace("google:python_interpreter", "unapproved_interpreter"));
    if (transportFault === "redirect") {
      res.writeHead(302, { location: "/unexpected-redirect" });
      res.end();
      return;
    }
    if (transportFault === "overflow")
      raw = Buffer.from(cell.raw.repeat(Math.ceil(MAX_BODY_BYTES / raw.length) + 1));
    if (transportFault === "cutoff" || transportFault === "stall") {
      res.writeHead(200, { "content-type": "application/json", "content-length": raw.length });
      res.flushHeaders();
      res.write(raw.subarray(0, 20));
      if (transportFault === "cutoff") setImmediate(() => res.destroy());
      return;
    }
    res.writeHead(index === failAt ? 401 : 200, {
      "content-type": cell.stream ? "text/event-stream" : "application/json",
      "content-length": raw.length,
    });
    res.end(raw);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert(address !== null && typeof address !== "string");
    await run(`http://127.0.0.1:${address.port}`, requests);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("Vertex recurring coordination on retained SDK/HTTP responses", () => {
  it("continues through all four approved non-triggers in exact request order", async () => {
    await withVertexSequence(async (origin, requests) => {
      const report = await runVertexRecurrence(localVertexEnvironment, origin);
      console.info(JSON.stringify({ proof: "Vertex recurrence continuation", report, requests }));
      expect(requests.map((request) => request.path)).toEqual(
        vertexCases.map((cell) => vertexPath(cell.stream)),
      );
      expect(requests.map((request) => request.body)).toEqual(vertexCases.map((cell) => cell.body));
      expect(report.results.map((result) => result.classification)).toEqual([
        "NOT_TRIGGERED",
        "NOT_TRIGGERED",
        "NOT_TRIGGERED",
        "NOT_TRIGGERED",
      ]);
    });
  });
  it("rejects enabled configuration errors before an actual HTTP send", async () => {
    await withVertexSequence(async (origin, requests) => {
      let rejected = false;
      try {
        await runVertexRecurrence(
          { ...localVertexEnvironment, AIMOCK_VERTEX_PROJECT: "wrong-project" },
          origin,
        );
      } catch {
        rejected = true;
      }
      console.info(
        JSON.stringify({
          proof: "Vertex recurrence invalid config",
          rejected,
          sends: requests.length,
        }),
      );
      expect(rejected).toBe(true);
      expect(requests).toEqual([]);
    });
  });
});

describe("Vertex recurring failure reporting", () => {
  it("retains the first real HTTP failure and explicit later unattempted cases", async () => {
    await withVertexSequence(async (origin, requests) => {
      let report: Awaited<ReturnType<typeof runVertexRecurrence>> | undefined;
      let threw = false;
      try {
        report = await runVertexRecurrence(localVertexEnvironment, origin);
      } catch {
        threw = true;
      }
      console.info(
        JSON.stringify({
          proof: "Vertex recurrence HTTP failure",
          threw,
          sends: requests.length,
          report,
        }),
      );
      expect(requests).toHaveLength(1);
      expect(report?.results.map((result) => result.classification)).toEqual([
        "FAILURE",
        "UNATTEMPTED",
        "UNATTEMPTED",
        "UNATTEMPTED",
      ]);
    }, 0);
  });
});

describe("Vertex recurring bounds and exact selection", () => {
  it.each([
    { AIMOCK_VERTEX_LIVE: "invalid" },
    { AIMOCK_VERTEX_PROJECT: undefined },
    { AIMOCK_VERTEX_LOCATION: "other-region" },
    { AIMOCK_VERTEX_MODEL: "other-model" },
    { AIMOCK_VERTEX_ACCESS_TOKEN: undefined },
    { AIMOCK_VERTEX_ACCESS_TOKEN: " " },
  ])("rejects incomplete/wrong enabled configuration without a send: %j", async (override) => {
    await withVertexSequence(async (origin, requests) => {
      await expect(
        runVertexRecurrence({ ...localVertexEnvironment, ...override }, origin),
      ).rejects.toThrow(/Vertex/);
      expect(requests).toHaveLength(0);
    });
  });
  it.each([undefined, "0"])(
    "disabled flag %s reports four skips and sends nothing",
    async (live) => {
      await withVertexSequence(async (origin, requests) => {
        const report = await runVertexRecurrence({ AIMOCK_VERTEX_LIVE: live }, origin);
        expect(report.results.map((result) => result.classification)).toEqual([
          "SKIPPED",
          "SKIPPED",
          "SKIPPED",
          "SKIPPED",
        ]);
        expect(report.budget).toEqual({ attempts: 0, tokens: 0, blocked: false });
        expect(requests).toHaveLength(0);
      });
    },
  );
  it("caps four ordered sends at 160 tokens and blocks a fifth before HTTP", async () => {
    await withVertexSequence(async (origin, requests) => {
      const budget = vertexBudget();
      for (const cell of vertexCases) {
        expect(sha256(cell.body)).toBe(cell.requestHash);
        const observation = await acquireVertexObservation(
          cell,
          origin,
          "local-budget-test",
          budget,
        );
        const { decoded } = await replay(cell, Buffer.from(observation.bytes).toString("utf8"));
        expect(compareVertexObservation(cell, observation, decoded).classification).toBe(
          "NOT_TRIGGERED",
        );
      }
      expect(budget.state()).toEqual({ attempts: 4, tokens: 160, blocked: false });
      await expect(
        acquireVertexObservation(vertexCases[0], origin, "local-budget-test", budget),
      ).rejects.toThrow(/budget/);
      expect(requests).toHaveLength(4);
    });
  });
  it("stops after a genuine error following an approved non-trigger", async () => {
    await withVertexSequence(async (origin, requests) => {
      const report = await runVertexRecurrence(localVertexEnvironment, origin);
      expect(report.results.map((result) => result.classification)).toEqual([
        "NOT_TRIGGERED",
        "FAILURE",
        "UNATTEMPTED",
        "UNATTEMPTED",
      ]);
      expect(report.results[1]).toMatchObject({
        status: 401,
        reason: "HTTP_FAILURE",
        sdk: "NOT_ATTEMPTED",
      });
      expect(
        report.results
          .slice(2)
          .every((result) => result.rawHash === null && result.sdk === "NOT_ATTEMPTED"),
      ).toBe(true);
      expect(report.budget).toEqual({ attempts: 2, tokens: 32, blocked: true });
      expect(requests).toHaveLength(2);
    }, 1);
  });
  it("continues through four actual aimock targets using the same bounded SDK coordinator", async () => {
    await withFaultFixture(undefined, async ({ mock, url }) => {
      mock.addFixtures([
        {
          match: { userMessage: "Call archive" },
          response: {
            content: "Before archive.",
            toolCalls: [
              {
                name: "archive",
                arguments: JSON.stringify({ cities: ["Tokyo", "Paris"] }),
                id: "archive_1",
              },
            ],
          },
          misbehavior: { faults: [{ fault: "stop-length-mid-tool", at: 0.5 }] },
        },
        {
          match: { userMessage: "Find every integer" },
          response: { content: "Forbidden answer." },
          misbehavior: {
            faults: [{ fault: "reasoning-only", reasoning: "Use infinite descent." }],
          },
        },
      ]);
      const report = await runVertexRecurrence(localVertexEnvironment, url);
      console.info(JSON.stringify({ proof: "Vertex recurrence aimock targets", report }));
      expect(report.results.map((result) => result.classification)).toEqual([
        "TARGET_COMPARED",
        "TARGET_COMPARED",
        "TARGET_COMPARED",
        "TARGET_COMPARED",
      ]);
      expect(report.budget).toEqual({ attempts: 4, tokens: 160, blocked: false });
      expect(mock.getRequests()).toHaveLength(4);
    });
  });
  it.each([
    { fault: "redirect", error: "TRANSPORT_FAILURE" },
    { fault: "cutoff", error: "TRANSPORT_FAILURE" },
    { fault: "overflow", error: "BYTE_CEILING" },
    { fault: "stall", error: "ABORTED_OR_DEADLINE" },
  ] as const)("bounds actual HTTP $fault without retry", async ({ fault, error }) => {
    await withVertexSequence(
      async (origin, requests) => {
        const budget = vertexBudget();
        const result = await acquireVertexObservation(
          vertexCases[0],
          origin,
          "local-transport-test",
          budget,
          { timeoutMs: fault === "stall" ? 100 : 5000, maxBytes: MAX_BODY_BYTES },
        );
        expect(result.complete).toBe(false);
        expect(result.error).toBe(error);
        expect(result.bytes.length).toBeLessThanOrEqual(MAX_BODY_BYTES);
        expect(requests).toHaveLength(1);
        expect(budget.state().attempts).toBe(1);
      },
      -1,
      fault,
    );
  });
});

// Four native result rows share one sequential bounded run. Default execution is offline.
// The outer collector may run three attempts: at most 12 sends / 480 requested output tokens.
const vertexLiveRequested =
  process.env.AIMOCK_VERTEX_LIVE !== undefined && process.env.AIMOCK_VERTEX_LIVE !== "0";
describe.skipIf(!vertexLiveRequested)(
  "Vertex native recurring modeled-contract observations",
  () => {
    let report: Awaited<ReturnType<typeof runVertexRecurrence>> | undefined;
    let setupFailure: string | undefined;
    beforeAll(async () => {
      try {
        report = await runVertexRecurrence({
          AIMOCK_VERTEX_LIVE: process.env.AIMOCK_VERTEX_LIVE,
          AIMOCK_VERTEX_PROJECT: process.env.AIMOCK_VERTEX_PROJECT,
          AIMOCK_VERTEX_LOCATION: process.env.AIMOCK_VERTEX_LOCATION,
          AIMOCK_VERTEX_MODEL: process.env.AIMOCK_VERTEX_MODEL,
          AIMOCK_VERTEX_ACCESS_TOKEN: process.env.AIMOCK_VERTEX_ACCESS_TOKEN,
        });
        console.info(JSON.stringify({ provider: "vertex", ...report }));
      } catch (error) {
        const diagnostics = [
          "enabled Vertex token missing",
          "invalid Vertex live flag",
          "invalid enabled Vertex project/location/model",
        ];
        setupFailure =
          error instanceof Error && diagnostics.includes(error.message)
            ? error.message
            : "Vertex native setup failed";
      }
    }, 210000);
    for (const [index, cell] of vertexCases.entries()) {
      it(`${cell.id} records a target comparison or approved non-trigger`, () => {
        if (setupFailure) throw new Error(setupFailure);
        assert(report, "Vertex native setup produced no report");
        expect(report.results).toHaveLength(4);
        expect(
          ["TARGET_COMPARED", "NOT_TRIGGERED"],
          JSON.stringify(report.results[index]),
        ).toContain(report.results[index].classification);
      });
    }
  },
);

it("Vertex recurring contradiction preserves actual SDK terminal and usage in failure receipt", async () => {
  await withVertexSequence(
    async (origin, requests) => {
      const report = await runVertexRecurrence(localVertexEnvironment, origin);
      console.info(JSON.stringify({ proof: "Vertex recurrence contradiction fields", report }));
      expect(requests).toHaveLength(1);
      expect(report.results[0]).toMatchObject({
        classification: "FAILURE",
        sdk: "DECODED",
        terminal: "MAX_TOKENS",
        usage: { totalTokenCount: 45 },
      });
      expect(report.results[0].chunks).toHaveLength(1);
      expect(
        report.results.slice(1).every((result) => result.classification === "UNATTEMPTED"),
      ).toBe(true);
    },
    -1,
    "contradiction",
  );
});
