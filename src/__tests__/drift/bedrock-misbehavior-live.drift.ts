import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  InvokeModelCommand,
  InternalServerException,
  InvokeModelWithResponseStreamCommand,
  type ConverseCommandInput,
  type ConverseCommandOutput,
  type ConverseStreamCommandOutput,
  type InvokeModelCommandOutput,
  type InvokeModelWithResponseStreamCommandOutput,
  type ConverseStreamOutput,
  type ResponseStream,
} from "@aws-sdk/client-bedrock-runtime";
import { fromIni } from "@aws-sdk/credential-provider-ini";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LLMock } from "../../llmock.js";
import type { Fixture } from "../../types.js";
import { withClaudeFault } from "../helpers/misbehavior-claude-stage3.js";

const cells = [
  { wire: "invoke", fault: "K5", stream: false },
  { wire: "invoke", fault: "K5", stream: true },
  { wire: "invoke", fault: "K9", stream: false },
  { wire: "invoke", fault: "K9", stream: true },
  { wire: "converse", fault: "K5", stream: false },
  { wire: "converse", fault: "K5", stream: true },
  { wire: "converse", fault: "K9", stream: false },
  { wire: "converse", fault: "K9", stream: true },
] as const;
type Cell = (typeof cells)[number];
// Invoke JSON is untrusted wire data: shape validation belongs to the later
// contract reader, so never cast it to an SDK Message or event interface.
type JsonObject = { [key: string]: unknown };
function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function object(value: unknown): JsonObject {
  if (!isJsonObject(value)) {
    throw new Error("Expected JSON object");
  }
  return value;
}
function readJson(bytes: Uint8Array): JsonObject {
  return object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
}
const modelId = "anthropic.claude-3-5-sonnet-20241022-v2:0";
const schema = {
  type: "object",
  properties: { city: { type: "string" } },
  required: ["city"],
};
const invokeRequest = {
  modelId,
  contentType: "application/json",
  accept: "application/json",
  body: JSON.stringify({
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 128,
    messages: [{ role: "user", content: "lookup" }],
    tools: [{ name: "lookup", input_schema: schema }],
  }),
};
const converseRequest = {
  modelId,
  messages: [{ role: "user" as const, content: [{ text: "lookup" }] }],
  inferenceConfig: { maxTokens: 128 },
  toolConfig: { tools: [{ toolSpec: { name: "lookup", inputSchema: { json: schema } } }] },
};

const liveTuple = {
  profile: "copilotkit-admin",
  region: "us-west-2",
  modelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
} as const;
type LiveConfig = typeof liveTuple;
const liveEnv = {
  AIMOCK_AWS_MISBEHAVIOR_LIVE: "1",
  AWS_PROFILE: liveTuple.profile,
  AWS_REGION: liveTuple.region,
  AIMOCK_AWS_MODEL_ID: liveTuple.modelId,
};
function readLiveConfig(env: NodeJS.ProcessEnv): LiveConfig | undefined {
  if (env.AIMOCK_AWS_MISBEHAVIOR_LIVE === undefined) return undefined;
  if (Object.entries(liveEnv).some(([key, value]) => env[key] !== value)) {
    throw new Error("Invalid native AWS tuple");
  }
  return { ...liveTuple };
}
// Resolve only the validated profile; the SDK default chain can otherwise fall
// through to ambient web-identity or metadata credentials when it is missing.
function nativeClientConfig(config: LiveConfig) {
  return {
    profile: config.profile,
    region: config.region,
    ignoreConfiguredEndpointUrls: true,
    credentialDefaultProvider: () => fromIni({ profile: config.profile }),
  };
}
// Exact retained request bodies: S3-Invoke 2026-10-08T18-25-59-411Z and
// S5-converse live-k5/k9 requests. Object/stream pairs were checked identical.
const nativeInvokeBodies = {
  K5: {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 32,
    messages: [
      {
        role: "user",
        content:
          "Use record_numbers now. Set payload to the first 2000 positive integers in ascending order, separated by commas. Do not abbreviate or omit any integer.",
      },
    ],
    tools: [
      {
        name: "record_numbers",
        description: "Record the full comma-separated integer sequence.",
        input_schema: {
          type: "object",
          properties: { payload: { type: "string" } },
          required: ["payload"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "record_numbers" },
  },
  K9: {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 1025,
    thinking: { type: "enabled", budget_tokens: 1024 },
    system:
      "Think carefully and exhaustively in your private reasoning before producing any answer. Do not begin the visible answer until you have verified all intermediate cases. Spend your entire available thinking budget checking the calculation. Avoid quick approximations.",
    messages: [
      {
        role: "user",
        content:
          "Without tools or code execution, determine the exact number of 12x12 binary matrices with every row sum and every column sum equal to 6, up to independent row and column permutations and transposition. Derive and evaluate a complete Burnside sum by explicitly determining the orbit lengths for every pair of cycle partitions, checking each fixed matrix row and column constraint, and cross-checking all exceptional stabilizers. Do the derivation and arithmetic in your private reasoning first; report only a final verified integer.",
      },
    ],
  },
};
const nativeConverseRequests: Record<Cell["fault"], ConverseCommandInput> = {
  K5: {
    modelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    messages: [
      {
        role: "user",
        content: [
          {
            text: "Use record_numbers now. Set payload to the first 2000 positive integers in ascending order, separated by commas. Do not abbreviate or omit any integer.",
          },
        ],
      },
    ],
    inferenceConfig: { maxTokens: 32 },
    toolConfig: {
      toolChoice: { tool: { name: "record_numbers" } },
      tools: [
        {
          toolSpec: {
            name: "record_numbers",
            description: "Record the full comma-separated integer sequence.",
            inputSchema: {
              json: {
                type: "object",
                properties: { payload: { type: "string" } },
                required: ["payload"],
              },
            },
          },
        },
      ],
    },
  },
  K9: {
    modelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    messages: [
      {
        role: "user",
        content: [
          {
            text: "Solve rigorously with explicit intermediate reasoning: determine the number of non-isomorphic groups of order 2^8 * 3^3 and justify the full classification from first principles. Work through the structural cases carefully before producing your answer.",
          },
        ],
      },
    ],
    inferenceConfig: { maxTokens: 1025 },
    additionalModelRequestFields: { thinking: { type: "enabled", budget_tokens: 1024 } },
  },
};

type SdkEnvelope =
  | Omit<InvokeModelCommandOutput, "body">
  | Omit<InvokeModelWithResponseStreamCommandOutput, "body">
  | ConverseCommandOutput
  | Omit<ConverseStreamCommandOutput, "stream">;
type Observation = {
  requestCount: number;
  http: { statusCode: number; contentType?: string; requestId?: string } | undefined;
  metadata: ConverseCommandOutput["$metadata"];
  sdkResponse: SdkEnvelope | undefined;
  sdkEvents: ResponseStream[];
  rawWire: Buffer;
  networkEnded: boolean;
  decoded:
    | { wire: "invoke"; stream: false; body: JsonObject }
    | { wire: "invoke"; stream: true; events: JsonObject[] }
    | { wire: "converse"; stream: false; body: ConverseCommandOutput }
    | { wire: "converse"; stream: true; events: ConverseStreamOutput[] };
};

function invokeEvent(event: ResponseStream): JsonObject {
  if (!event.chunk?.bytes || Object.keys(event).length !== 1) {
    throw new Error("Invoke exception or unknown SDK event: " + JSON.stringify(event));
  }
  return readJson(event.chunk.bytes);
}
function converseEvent(event: ConverseStreamOutput): ConverseStreamOutput {
  const keys = Object.keys(event);
  if (
    keys.length !== 1 ||
    ![
      "messageStart",
      "contentBlockStart",
      "contentBlockDelta",
      "contentBlockStop",
      "messageStop",
      "metadata",
    ].includes(keys[0])
  ) {
    throw new Error("Converse exception or unknown SDK event: " + JSON.stringify(event));
  }
  return event;
}

// Local endpoints require loopback and dummy credentials. Native configuration
// is validated before construction. Raw bytes are observed without replacement.
async function runAwsCell(
  cell: Cell,
  target: string | LiveConfig,
  limits: {
    maxBytes?: number;
    timeoutMs?: number;
    nativeRequests?: boolean;
    beforeSend?: () => void;
  } = {},
): Promise<Observation> {
  const live = typeof target !== "string";
  if (
    live &&
    (target.profile !== liveTuple.profile ||
      target.region !== liveTuple.region ||
      target.modelId !== liveTuple.modelId)
  ) {
    throw new Error("Invalid native AWS tuple");
  }
  const maxBytes = limits.maxBytes ?? 262144;
  const timeoutMs = limits.timeoutMs ?? (live ? 45000 : 5000);
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 262144 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > (live ? 45000 : 5000)
  ) {
    throw new Error("Invalid AWS observation bounds");
  }
  if (!live) {
    const url = new URL(target);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
      throw new Error("Local AWS runner requires loopback HTTP");
    }
  }
  const useNativeRequests = live || limits.nativeRequests;
  const invokeInput = useNativeRequests
    ? {
        modelId: liveTuple.modelId,
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify(nativeInvokeBodies[cell.fault]),
      }
    : invokeRequest;
  const converseInput = useNativeRequests ? nativeConverseRequests[cell.fault] : converseRequest;
  const handler = new NodeHttpHandler({ connectionTimeout: 5000, requestTimeout: timeoutMs });
  const controller = new AbortController();
  let source: Readable | undefined;
  let tap: Transform | undefined;
  let byteCount = 0;
  let failure: Error | undefined;
  const abort = (error: Error) => {
    failure ??= error;
    controller.abort();
    source?.destroy();
    tap?.destroy(error);
  };
  const timer = setTimeout(() => abort(new Error("AWS observation timed out")), timeoutMs);
  let requestCount = 0;
  let http: Observation["http"];
  let networkEnded = false;
  const chunks: Buffer[] = [];
  const client = new BedrockRuntimeClient({
    ...(live
      ? nativeClientConfig(target)
      : {
          endpoint: target,
          region: "us-east-1",
          credentials: { accessKeyId: "local", secretAccessKey: "local" },
        }),
    maxAttempts: 1,
    requestHandler: {
      async handle(...args: Parameters<NodeHttpHandler["handle"]>) {
        requestCount++;
        const result = await handler.handle(...args);
        http = {
          statusCode: result.response.statusCode,
          contentType: result.response.headers["content-type"],
          requestId: result.response.headers["x-amzn-requestid"],
        };
        const body: unknown = result.response.body;
        if (!(body instanceof Readable)) throw new Error("Expected Node HTTP response stream");
        source = body;
        tap = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            byteCount += chunk.length;
            if (byteCount > maxBytes) {
              const error = new Error(`AWS response exceeds ${maxBytes} bytes`);
              failure = error;
              callback(error);
              controller.abort();
              source?.destroy();
              return;
            }
            chunks.push(Buffer.from(chunk));
            callback(null, chunk);
          },
        });
        body.once("end", () => {
          networkEnded = true;
        });
        body.once("error", (error) => tap?.destroy(error));
        body.once("aborted", () => tap?.destroy(new Error("HTTP source aborted")));
        body.once("close", () => {
          if (!networkEnded) tap?.destroy(new Error("HTTP source closed before end"));
        });
        // An error can occur before the SDK attaches its stream reader.
        tap.on("error", () => body.destroy());
        tap.once("close", () => {
          if (!networkEnded) body.destroy();
        });
        result.response.body = body.pipe(tap);
        return result;
      },
      destroy: () => handler.destroy(),
    },
  });
  let metadata: Observation["metadata"] = {};
  const events: JsonObject[] = [];
  const converseEvents: ConverseStreamOutput[] = [];
  const sdkEvents: ResponseStream[] = [];
  let sdkResponse: SdkEnvelope | undefined;
  try {
    let decoded: Observation["decoded"];
    const options = { abortSignal: controller.signal };
    limits.beforeSend?.();
    if (cell.wire === "invoke" && !cell.stream) {
      const result = await client.send(new InvokeModelCommand(invokeInput), options);
      metadata = result.$metadata;
      const { body, ...envelope } = result;
      sdkResponse = envelope;
      if (!body) throw new Error("Missing Invoke body");
      decoded = { wire: "invoke", stream: false, body: readJson(body) };
    } else if (cell.wire === "invoke") {
      const result = await client.send(
        new InvokeModelWithResponseStreamCommand(invokeInput),
        options,
      );
      metadata = result.$metadata;
      if (!result.body) throw new Error("Missing Invoke stream");
      const { body, ...envelope } = result;
      sdkResponse = envelope;
      for await (const event of body) {
        sdkEvents.push(event);
        events.push(invokeEvent(event));
      }
      if (events.at(-1)?.type !== "message_stop") throw new Error("Incomplete Invoke stream");
      decoded = { wire: "invoke", stream: true, events };
    } else if (!cell.stream) {
      const result = await client.send(new ConverseCommand(converseInput), options);
      metadata = result.$metadata;
      if (!result.output) throw new Error("Missing Converse body");
      sdkResponse = result;
      decoded = { wire: "converse", stream: false, body: result };
    } else {
      const result = await client.send(new ConverseStreamCommand(converseInput), options);
      metadata = result.$metadata;
      if (!result.stream) throw new Error("Missing Converse stream");
      const { stream, ...envelope } = result;
      sdkResponse = envelope;
      for await (const event of stream) converseEvents.push(converseEvent(event));
      if (!converseEvents.some((event) => event.messageStop) || !converseEvents.at(-1)?.metadata) {
        throw new Error("Incomplete Converse stream");
      }
      decoded = { wire: "converse", stream: true, events: converseEvents };
    }
    if (failure) throw failure;
    if (!networkEnded) throw new Error("SDK returned without clean HTTP exhaustion");
    const observation = {
      requestCount,
      http,
      metadata,
      sdkResponse,
      sdkEvents,
      rawWire: Buffer.concat(chunks),
      networkEnded,
      decoded,
    };
    console.log(
      JSON.stringify({
        cell,
        request: cell.wire === "invoke" ? invokeInput : converseInput,
        ...observation,
        rawWire: { encoding: "base64", bytes: observation.rawWire.toString("base64") },
      }),
    );
    return observation;
  } catch (error) {
    const errorMetadata =
      error instanceof Error && "$metadata" in error ? error.$metadata : undefined;
    console.log(
      JSON.stringify({
        cell,
        request: cell.wire === "invoke" ? invokeInput : converseInput,
        requestCount,
        http,
        metadata: errorMetadata ?? metadata,
        sdkResponse,
        sdkEvents,
        decodedEvents: cell.wire === "invoke" ? events : converseEvents,
        networkEnded,
        rawWire: { encoding: "base64", bytes: Buffer.concat(chunks).toString("base64") },
        error:
          error instanceof Error ? { name: error.name, message: error.message } : String(error),
      }),
    );
    throw failure ?? error;
  } finally {
    clearTimeout(timer);
    controller.abort();
    source?.destroy();
    tap?.destroy();
    client.destroy();
  }
}

type Comparison = "TARGET_COMPARED" | "NOT_TRIGGERED";
function requireContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid Invoke contract: ${message}`);
}
function string(value: unknown, nonempty = false): string {
  requireContract(typeof value === "string" && (!nonempty || value.length > 0), "string");
  return value;
}
function integer(value: unknown): number {
  requireContract(
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
    "integer",
  );
  return value;
}
function array(value: unknown): unknown[] {
  requireContract(Array.isArray(value), "array");
  return value;
}
function usage(value: unknown, initial: boolean) {
  const data = object(value);
  integer(data.output_tokens);
  if (initial) integer(data.input_tokens);
  for (const [key, count] of Object.entries(data)) {
    if (key === "output_tokens_details") {
      const details = object(count);
      requireContract(Object.keys(details).length === 1, "output token details");
      integer(details.thinking_tokens);
    } else if (key === "cache_creation") {
      const cache = object(count);
      for (const [field, tokens] of Object.entries(cache)) {
        requireContract(
          ["ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"].includes(field),
          "cache usage field",
        );
        integer(tokens);
      }
    } else {
      requireContract(
        [
          "input_tokens",
          "output_tokens",
          "cache_creation_input_tokens",
          "cache_read_input_tokens",
        ].includes(key),
        "usage field",
      );
      integer(count);
    }
  }
}
function terminal(value: unknown): string {
  const stop = string(value, true);
  requireContract(
    [
      "end_turn",
      "max_tokens",
      "stop_sequence",
      "tool_use",
      "pause_turn",
      "refusal",
      "model_context_window_exceeded",
    ].includes(stop),
    "stop reason",
  );
  return stop;
}
function stopFields(data: JsonObject) {
  requireContract(
    data.stop_sequence === null || typeof data.stop_sequence === "string",
    "stop sequence",
  );
  if (data.stop_reason === "stop_sequence") string(data.stop_sequence, true);
  else requireContract(data.stop_sequence === null, "contradictory stop sequence");
  requireContract(
    data.stop_details === undefined || data.stop_details === null,
    "unsupported stop details",
  );
}
type InvokeBlock = {
  type: "text" | "thinking" | "tool_use";
  text: string;
  signature: string;
  input: JsonObject;
  partial: string;
  deltas: number;
  closed: boolean;
};
function block(value: unknown, opening: boolean): InvokeBlock {
  const data = object(value);
  const result: InvokeBlock = {
    type: "text",
    text: "",
    signature: "",
    input: {},
    partial: "",
    deltas: 0,
    closed: !opening,
  };
  if (data.type === "text") {
    result.text = string(data.text);
  } else if (data.type === "thinking") {
    result.type = "thinking";
    result.text = string(data.thinking);
    result.signature =
      opening && data.signature === undefined ? "" : string(data.signature, !opening);
  } else if (data.type === "tool_use") {
    result.type = "tool_use";
    string(data.id, true);
    string(data.name, true);
    result.input = object(data.input);
    if (opening) requireContract(Object.keys(result.input).length === 0, "tool opener input");
  } else throw new Error("Invalid Invoke contract: unknown block");
  // Reject contradictory recognized union fields instead of dropping them.
  for (const field of ["text", "thinking", "signature", "id", "name", "input", "data"]) {
    const allowed =
      data.type === "text"
        ? ["text"]
        : data.type === "thinking"
          ? ["thinking", "signature"]
          : ["id", "name", "input"];
    requireContract(!(field in data) || allowed.includes(field), "contradictory block field");
  }
  return result;
}
function messageHeader(data: JsonObject, opening: boolean) {
  requireContract(data.type === "message" && data.role === "assistant", "message envelope");
  string(data.id, true);
  string(data.model, true);
  usage(data.usage, true);
  stopFields(data);
  if (opening) {
    requireContract(
      data.stop_reason === null && array(data.content).length === 0,
      "message opener",
    );
  }
}
function converseFields(data: JsonObject, allowed: string[]) {
  requireContract(
    Object.keys(data).every((key) => allowed.includes(key)),
    "Converse field",
  );
}
function converseUnion(value: unknown): [string, unknown] {
  const entries = Object.entries(object(value));
  requireContract(entries.length === 1, "Converse union");
  return entries[0];
}
function converseUsage(value: unknown, metrics: unknown) {
  const data = object(value);
  converseFields(data, [
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "cacheReadInputTokens",
    "cacheWriteInputTokens",
  ]);
  integer(data.inputTokens);
  integer(data.outputTokens);
  integer(data.totalTokens);
  Object.values(data).forEach(integer);
  const timing = object(metrics);
  converseFields(timing, ["latencyMs"]);
  integer(timing.latencyMs);
}
function converseTerminal(value: unknown): string {
  const stop = string(value, true);
  requireContract(
    [
      "end_turn",
      "tool_use",
      "max_tokens",
      "stop_sequence",
      "guardrail_intervened",
      "content_filtered",
      "model_context_window_exceeded",
    ].includes(stop),
    "Converse stop reason",
  );
  return stop;
}
type ConverseBlock = {
  type: "text" | "reasoning" | "tool";
  text: string;
  signature: string;
  input: JsonObject;
  partial: string;
  deltas: number;
};
function converseBlock(type: ConverseBlock["type"]): ConverseBlock {
  return { type, text: "", signature: "", input: {}, partial: "", deltas: 0 };
}
function converseTool(value: unknown, opening: boolean): JsonObject {
  const data = object(value);
  converseFields(
    data,
    opening ? ["toolUseId", "name", "type"] : ["toolUseId", "name", "type", "input"],
  );
  string(data.toolUseId, true);
  string(data.name, true);
  if (data.type !== undefined) requireContract(data.type === "tool_use", "Converse tool type");
  return opening ? {} : object(data.input);
}
function classifyConverse(
  cell: Cell,
  decoded: Extract<Observation["decoded"], { wire: "converse" }>,
  source: "local" | "native",
): Comparison {
  const blocks: ConverseBlock[] = [];
  let stop: string | undefined;
  const reasoningComplete = (block: ConverseBlock) => {
    if (block.type === "reasoning") {
      string(block.text, true);
      if (source === "native") string(block.signature, true);
    }
  };
  if (!decoded.stream) {
    const body = object(decoded.body);
    converseFields(body, ["output", "stopReason", "usage", "metrics", "$metadata"]);
    converseUsage(body.usage, body.metrics);
    stop = converseTerminal(body.stopReason);
    const [kind, value] = converseUnion(body.output);
    requireContract(kind === "message", "Converse output union");
    const message = object(value);
    converseFields(message, ["role", "content"]);
    requireContract(message.role === "assistant", "Converse message role");
    for (const content of array(message.content)) {
      const [kind, value] = converseUnion(content);
      const b = converseBlock(kind === "text" ? "text" : kind === "toolUse" ? "tool" : "reasoning");
      if (kind === "text") b.text = string(value);
      else if (kind === "toolUse") b.input = converseTool(value, false);
      else {
        requireContract(kind === "reasoningContent", "unsupported Converse block");
        const [reasoningKind, reasoning] = converseUnion(value);
        requireContract(reasoningKind === "reasoningText", "unsupported Converse reasoning");
        const text = object(reasoning);
        converseFields(text, ["text", "signature"]);
        b.text = string(text.text);
        if (text.signature !== undefined) b.signature = string(text.signature, true);
      }
      reasoningComplete(b);
      blocks.push(b);
    }
  } else {
    let phase: "start" | "blocks" | "metadata" | "done" = "start";
    let active: ConverseBlock | undefined;
    for (const event of decoded.events) {
      const [kind, value] = converseUnion(event);
      const data = object(value);
      if (kind === "messageStart") {
        converseFields(data, ["role"]);
        requireContract(phase === "start" && data.role === "assistant", "Converse message start");
        phase = "blocks";
      } else if (kind === "contentBlockStart") {
        converseFields(data, ["contentBlockIndex", "start"]);
        requireContract(
          phase === "blocks" && !active && integer(data.contentBlockIndex) === blocks.length,
          "Converse block start order",
        );
        const start = object(data.start);
        if (Object.keys(start).length === 0) active = converseBlock("text");
        else {
          const [kind, value] = converseUnion(start);
          if (kind === "toolUse") {
            converseTool(value, true);
            active = converseBlock("tool");
          } else {
            // The installed SDK exposes aimock's reasoning opener as $unknown.
            // Accept exactly that local extension, never unknown native reasoning.
            const unknown = array(value);
            requireContract(
              source === "local" &&
                kind === "$unknown" &&
                unknown.length === 2 &&
                unknown[0] === "reasoningContent" &&
                Object.keys(object(unknown[1])).length === 0,
              "Converse reasoning opener",
            );
            active = converseBlock("reasoning");
          }
        }
        blocks.push(active);
      } else if (kind === "contentBlockDelta") {
        converseFields(data, ["contentBlockIndex", "delta"]);
        requireContract(phase === "blocks", "Converse delta phase");
        const [kind, value] = converseUnion(data.delta);
        if (!active) {
          requireContract(
            source === "native" &&
              (kind === "text" || kind === "reasoningContent") &&
              integer(data.contentBlockIndex) === blocks.length,
            "Converse delta-first block",
          );
          active = converseBlock(kind === "text" ? "text" : "reasoning");
          blocks.push(active);
        }
        requireContract(
          integer(data.contentBlockIndex) === blocks.length - 1,
          "Converse delta index",
        );
        if (kind === "text") {
          requireContract(active.type === "text", "Converse text delta");
          active.text += string(value);
        } else if (kind === "toolUse") {
          requireContract(active.type === "tool", "Converse tool delta");
          const input = object(value);
          converseFields(input, ["input"]);
          active.partial += string(input.input);
        } else {
          requireContract(
            kind === "reasoningContent" && active.type === "reasoning",
            "Converse reasoning delta",
          );
          const [reasoningKind, reasoningValue] = converseUnion(value);
          if (reasoningKind === "text") {
            requireContract(!active.signature, "Converse reasoning after signature");
            active.text += string(reasoningValue);
          } else {
            requireContract(reasoningKind === "signature", "unsupported Converse reasoning delta");
            active.signature += string(reasoningValue, true);
          }
        }
        active.deltas++;
      } else if (kind === "contentBlockStop") {
        converseFields(data, ["contentBlockIndex"]);
        requireContract(
          phase === "blocks" && active && integer(data.contentBlockIndex) === blocks.length - 1,
          "Converse block stop order",
        );
        reasoningComplete(active);
        active = undefined;
      } else if (kind === "messageStop") {
        converseFields(data, ["stopReason"]);
        requireContract(phase === "blocks" && !active, "Converse message stop order");
        stop = converseTerminal(data.stopReason);
        phase = "metadata";
      } else if (kind === "metadata") {
        converseFields(data, ["usage", "metrics"]);
        requireContract(phase === "metadata", "Converse metadata order");
        converseUsage(data.usage, data.metrics);
        phase = "done";
      } else throw new Error("Unsupported Converse event");
    }
    requireContract(phase === "done", "Converse stream closure");
  }
  const hasTool = blocks.some((block) => block.type === "tool");
  requireContract(stop !== "tool_use" || hasTool, "Converse tool terminal without tool");
  requireContract(stop !== "end_turn" || !hasTool, "Converse end_turn with tool");
  if (cell.fault === "K5") {
    requireContract(stop === "max_tokens", "Converse K5 terminal");
    const cut = blocks.at(-1);
    requireContract(
      cut?.type === "tool" && blocks.slice(0, -1).every((b) => b.type === "text"),
      "Converse K5 final tool",
    );
    if (source === "local") requireContract(blocks.length === 1, "local Converse K5 blocks");
    requireContract(Object.keys(cut.input).length === 0, "Converse K5 input");
    if (decoded.stream) {
      requireContract(cut.deltas > 0, "Converse K5 argument delta");
      if (source === "local")
        requireContract(cut.partial === '{"city":', "local Converse K5 prefix");
      if (cut.partial) {
        let complete = false;
        try {
          JSON.parse(cut.partial);
          complete = true;
        } catch {
          /* Expected incomplete JSON. */
        }
        requireContract(!complete, "Converse K5 complete arguments");
      }
    }
    return "TARGET_COMPARED";
  }
  // Validate complete tool argument documents even for a native nontrigger.
  if (decoded.stream)
    for (const b of blocks) if (b.type === "tool") b.input = object(JSON.parse(b.partial));
  const thoughtOnly = blocks.length > 0 && blocks.every((b) => b.type === "reasoning");
  if (!thoughtOnly) {
    requireContract(source === "native", "local Converse K9 visible output");
    return "NOT_TRIGGERED";
  }
  requireContract(stop === "max_tokens", "Converse K9 thought-only terminal");
  if (source === "local")
    requireContract(
      blocks.length === 1 && blocks[0].text === "Checking.",
      "local Converse K9 reasoning",
    );
  return "TARGET_COMPARED";
}

function classify(cell: Cell, observation: Observation, source: "local" | "native"): Comparison {
  const decoded = observation.decoded;
  requireContract(cell.wire === decoded.wire && cell.stream === decoded.stream, "cell mismatch");
  requireContract(observation.networkEnded && observation.rawWire.length > 0, "incomplete body");
  requireContract(
    observation.http?.statusCode === 200 && observation.metadata.httpStatusCode === 200,
    "HTTP status",
  );
  requireContract(
    observation.http.contentType?.split(";")[0] ===
      (cell.stream ? "application/vnd.amazon.eventstream" : "application/json"),
    "content type",
  );
  if (decoded.wire === "converse") return classifyConverse(cell, decoded, source);
  const blocks: InvokeBlock[] = [];
  let stop: string;
  if (!decoded.stream) {
    messageHeader(decoded.body, false);
    stop = terminal(decoded.body.stop_reason);
    blocks.push(...array(decoded.body.content).map((value) => block(value, false)));
  } else {
    let phase: "start" | "blocks" | "terminal" | "done" = "start";
    let active: InvokeBlock | undefined;
    let finalStop: string | undefined;
    for (const event of decoded.events) {
      if (event.type === "message_start") {
        requireContract(phase === "start", "duplicate message start");
        messageHeader(object(event.message), true);
        phase = "blocks";
      } else if (event.type === "content_block_start") {
        requireContract(phase === "blocks" && !active, "block start order");
        requireContract(integer(event.index) === blocks.length, "block index");
        active = block(event.content_block, true);
        blocks.push(active);
      } else if (event.type === "content_block_delta") {
        requireContract(
          phase === "blocks" && active && integer(event.index) === blocks.length - 1,
          "delta order",
        );
        const delta = object(event.delta);
        const field =
          delta.type === "text_delta"
            ? "text"
            : delta.type === "thinking_delta"
              ? "thinking"
              : delta.type === "signature_delta"
                ? "signature"
                : delta.type === "input_json_delta"
                  ? "partial_json"
                  : undefined;
        requireContract(field && Object.keys(delta).length === 2, "unknown or contradictory delta");
        const text = string(delta[field]);
        if (delta.type === "text_delta") {
          requireContract(active.type === "text", "text delta block");
          active.text += text;
        } else if (delta.type === "thinking_delta") {
          requireContract(active.type === "thinking" && !active.signature, "thinking delta order");
          active.text += text;
        } else if (delta.type === "signature_delta") {
          requireContract(active.type === "thinking", "signature delta block");
          active.signature += text;
        } else {
          requireContract(active.type === "tool_use", "input delta block");
          active.partial += text;
        }
        active.deltas++;
      } else if (event.type === "content_block_stop") {
        requireContract(
          phase === "blocks" && active && integer(event.index) === blocks.length - 1,
          "block stop order",
        );
        if (active.type === "thinking") string(active.signature, true);
        if (active.type === "tool_use" && active.partial)
          active.input = object(JSON.parse(active.partial));
        active.closed = true;
        active = undefined;
      } else if (event.type === "message_delta") {
        requireContract(phase === "blocks", "message delta order");
        const delta = object(event.delta);
        finalStop = terminal(delta.stop_reason);
        stopFields(delta);
        usage(event.usage, false);
        requireContract(
          !active ||
            (cell.fault === "K5" && active.type === "tool_use" && finalStop === "max_tokens"),
          "unfinished block",
        );
        phase = "terminal";
      } else if (event.type === "message_stop") {
        requireContract(phase === "terminal", "message stop order");
        const metrics = event["amazon-bedrock-invocationMetrics"];
        if (metrics !== undefined) {
          const data = object(metrics);
          for (const field of [
            "inputTokenCount",
            "outputTokenCount",
            "invocationLatency",
            "firstByteLatency",
          ])
            integer(data[field]);
        }
        phase = "done";
      } else throw new Error("Invalid Invoke contract: unknown event");
    }
    requireContract(phase === "done" && finalStop, "missing terminal");
    stop = finalStop;
  }
  if (stop === "tool_use")
    requireContract(
      blocks.some((b) => b.type === "tool_use"),
      "tool terminal without tool",
    );
  if (stop === "end_turn")
    requireContract(
      blocks.every((b) => b.type !== "tool_use"),
      "end_turn with tool",
    );
  if (cell.fault === "K5") {
    requireContract(stop === "max_tokens" && blocks.length > 0, "K5 terminal");
    const cut = blocks[blocks.length - 1];
    requireContract(cut.type === "tool_use" && Object.keys(cut.input).length === 0, "K5 cut tool");
    requireContract(
      blocks.slice(0, -1).every((b) => b.type === "text" && b.closed),
      "K5 prefix",
    );
    if (source === "local") requireContract(blocks.length === 1, "local K5 blocks");
    if (decoded.stream) {
      requireContract(!cut.closed && cut.deltas > 0, "K5 cut lifecycle");
      if (source === "local") requireContract(cut.partial === '{"city":', "local K5 prefix");
      if (cut.partial) {
        let complete = false;
        try {
          JSON.parse(cut.partial);
          complete = true;
        } catch {
          /* Expected incomplete JSON. */
        }
        requireContract(!complete, "K5 complete arguments");
      }
    }
    return "TARGET_COMPARED";
  }
  const thoughtOnly = blocks.length > 0 && blocks.every((b) => b.type === "thinking");
  if (!thoughtOnly) {
    requireContract(source === "native", "local K9 visible output");
    return "NOT_TRIGGERED";
  }
  requireContract(stop === "max_tokens", "K9 thought-only terminal");
  requireContract(
    blocks.every((b) => b.closed && b.text.length > 0 && b.signature.length > 0),
    "K9 thinking contract",
  );
  if (source === "local")
    requireContract(blocks.length === 1 && blocks[0].text === "Checking.", "local K9 thinking");
  return "TARGET_COMPARED";
}

async function assertLocalCell(cell: Cell) {
  await withClaudeFault(
    {
      faults: [
        cell.fault === "K5"
          ? { fault: "stop-length-mid-tool", at: 0.5 }
          : { fault: "reasoning-only", reasoning: "Checking." },
      ],
    },
    async ({ mock, url }) => {
      const observation = await runAwsCell(cell, url);
      expect(observation.metadata).toMatchObject({ httpStatusCode: 200, attempts: 1 });
      expect(observation.requestCount).toBe(1);
      expect(observation.networkEnded).toBe(true);
      expect(observation.rawWire.length).toBeGreaterThan(0);
      expect(mock.getRequests()).toHaveLength(1);
      expect(mock.getRequests()[0].response.misbehavior?.applied).toBe(true);
      expect(classify(cell, observation, "local")).toBe("TARGET_COMPARED");
      const data = observation.decoded;
      if (data.wire === "invoke") {
        expect(classify(cell, observation, "local")).toBe("TARGET_COMPARED");
        if (!data.stream) {
          expect(data.body.stop_reason).toBe("max_tokens");
          expect(data.body.content).toEqual([
            expect.objectContaining(
              cell.fault === "K5"
                ? { type: "tool_use", name: "lookup", input: {} }
                : { type: "thinking", thinking: "Checking." },
            ),
          ]);
        } else {
          expect(data.events.at(-1)?.type).toBe("message_stop");
          expect(data.events.find((e) => e.type === "message_delta")?.delta).toMatchObject({
            stop_reason: "max_tokens",
          });
          const starts = data.events.filter((e) => e.type === "content_block_start");
          expect(starts).toHaveLength(1);
          expect(starts[0].content_block).toMatchObject({
            type: cell.fault === "K5" ? "tool_use" : "thinking",
          });
          const deltas = data.events
            .filter((e) => e.type === "content_block_delta")
            .map((e) => object(e.delta));
          if (cell.fault === "K5")
            expect(deltas.map((d) => d.partial_json ?? "").join("")).toBe('{"city":');
          else expect(deltas.map((d) => d.thinking ?? "").join("")).toBe("Checking.");
        }
      } else if (!data.stream) {
        expect(data.body.stopReason).toBe("max_tokens");
        expect(data.body.output?.message?.content).toEqual(
          cell.fault === "K5"
            ? [{ toolUse: expect.objectContaining({ name: "lookup", input: {} }) }]
            : [{ reasoningContent: { reasoningText: { text: "Checking." } } }],
        );
      } else {
        expect(data.events.at(-1)?.metadata).toBeDefined();
        expect(data.events.find((e) => e.messageStop)?.messageStop?.stopReason).toBe("max_tokens");
        if (cell.fault === "K5") {
          expect(data.events.flatMap((e) => e.contentBlockStart?.start?.toolUse ?? [])).toEqual([
            expect.objectContaining({ name: "lookup" }),
          ]);
          expect(
            data.events.map((e) => e.contentBlockDelta?.delta?.toolUse?.input ?? "").join(""),
          ).toBe('{"city":');
        } else {
          expect(
            data.events
              .map((e) => e.contentBlockDelta?.delta?.reasoningContent?.text ?? "")
              .join(""),
          ).toBe("Checking.");
          expect(
            data.events.some(
              (e) => e.contentBlockDelta?.delta?.text || e.contentBlockStart?.start?.toolUse,
            ),
          ).toBe(false);
        }
      }
    },
  );
}
for (const cell of cells) {
  it(`local ${cell.wire} ${cell.fault} stream=${cell.stream}`, () => assertLocalCell(cell));
}

// Real local HTTP controls; no replacement SDK or fabricated LLM responses.
async function withTransportFixture(
  fixture: Fixture,
  run: (url: string, mock: LLMock) => Promise<void>,
) {
  const mock = new LLMock({ port: 0, chunkSize: 2, latency: 10 });
  mock.addFixture(fixture);
  const url = await mock.start();
  try {
    await run(url, mock);
  } finally {
    await mock.stop();
  }
}
for (const wire of ["invoke", "converse"] as const) {
  const cell = { wire, fault: "K5", stream: true } as const;
  it(`transport ${wire} HTTP SDK exception has one attempt`, async () => {
    await withTransportFixture(
      { match: {}, response: { error: { message: "Control exception" }, status: 503 } },
      async (url, mock) => {
        await expect(runAwsCell(cell, url)).rejects.toMatchObject({
          $metadata: { httpStatusCode: 503, attempts: 1 },
        });
        expect(mock.getRequests()).toHaveLength(1);
      },
    );
  });
  it(`transport ${wire} rejects actual interrupted stream`, async () => {
    await withTransportFixture(
      {
        match: {},
        response: { content: "Long enough to interrupt the real stream." },
        truncateAfterChunks: 2,
      },
      async (url, mock) => {
        await expect(runAwsCell(cell, url)).rejects.toThrow();
        expect(mock.getLastRequest()?.response.interrupted).toBe(true);
      },
    );
  });
  it(`transport ${wire} enforces a low wire byte ceiling`, async () => {
    await withTransportFixture(
      { match: {}, response: { content: "Long enough to exceed the wire byte ceiling." } },
      async (url, mock) => {
        await expect(runAwsCell(cell, url, { maxBytes: 8 })).rejects.toThrow(
          "AWS response exceeds 8 bytes",
        );
        expect(mock.getRequests()).toHaveLength(1);
      },
    );
  });
  it(`transport ${wire} bounds actual delayed HTTP`, async () => {
    await withTransportFixture(
      { match: {}, response: { content: "Delayed." }, latency: 400 },
      async (url) => {
        await expect(runAwsCell(cell, url, { timeoutMs: 50 })).rejects.toThrow(
          "AWS observation timed out",
        );
      },
    );
  });
}

// Captured successful event seeds, then explicit invalid-input derivatives.
// These are guard sensitivity controls, not SDK transport or native evidence.
const capturedInvokeStart = {
  type: "message_start",
  message: {
    model: "claude-sonnet-4-5-20250929",
    id: "msg_bdrk_011CfqEtSc7RGn9rcJMRsqWP",
    type: "message",
    role: "assistant",
    content: [],
    stop_reason: null,
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: 692,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
      output_tokens: 16,
    },
  },
};
const capturedConverseStart: ConverseStreamOutput = { messageStart: { role: "assistant" } };
it("derived Invoke guard rejects exception and unknown union alternatives", () => {
  const seed: ResponseStream = {
    chunk: { bytes: new TextEncoder().encode(JSON.stringify(capturedInvokeStart)) },
  };
  expect(invokeEvent(seed)).toEqual(capturedInvokeStart);
  expect(() =>
    invokeEvent({
      internalServerException: new InternalServerException({
        message: "Derived exception",
        $metadata: {},
      }),
    }),
  ).toThrow("exception or unknown");
  expect(() => invokeEvent({ $unknown: ["futureEvent", {}] })).toThrow("exception or unknown");
});
it("derived Converse guard rejects exception and unknown union alternatives", () => {
  expect(converseEvent(capturedConverseStart)).toEqual(capturedConverseStart);
  expect(() =>
    converseEvent({
      internalServerException: new InternalServerException({
        message: "Derived exception",
        $metadata: {},
      }),
    }),
  ).toThrow("exception or unknown");
  expect(() => converseEvent({ $unknown: ["futureEvent", {}] })).toThrow("exception or unknown");
});
it("derived Invoke decoder rejects malformed UTF8 and JSON", () => {
  expect(() => invokeEvent({ chunk: { bytes: Uint8Array.of(0xc3, 0x28) } })).toThrow();
  expect(() => invokeEvent({ chunk: { bytes: new TextEncoder().encode('{"type":') } })).toThrow();
});
for (const wire of ["invoke", "converse"] as const) {
  it(`transport ${wire} enforces default 262144 byte ceiling on object response`, async () => {
    await withTransportFixture(
      { match: {}, response: { content: "x".repeat(262145) } },
      async (url, mock) => {
        await expect(runAwsCell({ wire, fault: "K9", stream: false }, url)).rejects.toThrow(
          "AWS response exceeds 262144 bytes",
        );
        expect(mock.getRequests()).toHaveLength(1);
      },
    );
  });
}

// Exact sanitized SDK bodies/events from 2026-10-08 Invoke captures, SDK 3.1147.0.
// No requests, credentials or signed headers are retained. Raw bytes and SHA256
// identify the original HTTP responses; decodedText preserves complete output.
const invokeCaptures = [
  {
    fault: "K5",
    stream: false,
    source: "live-2026-10-08T18-25-59-411Z-1-K5-object-native.json",
    decodedSha256: "20911c6b725eb6bfa22747c320e1010402d9234a218c76019b7e787b9c107453",
    rawSha256: "0eddc6c8c6bd176bc50ec0d3d654cb09cabc6e78e6d1a6aa1f1080798baca6dc",
    rawBase64:
      "eyJtb2RlbCI6ImNsYXVkZS1zb25uZXQtNC01LTIwMjUwOTI5IiwiaWQiOiJtc2dfYmRya18wMTFDZnFFdEg0ZGJqeGU5eDlpS2V1VkMiLCJ0eXBlIjoibWVzc2FnZSIsInJvbGUiOiJhc3Npc3RhbnQiLCJjb250ZW50IjpbeyJ0eXBlIjoidG9vbF91c2UiLCJpZCI6InRvb2x1X2JkcmtfMDE2a3BBNThpQkhNQ0NKWHltVTY0VFV5IiwibmFtZSI6InJlY29yZF9udW1iZXJzIiwiaW5wdXQiOnt9fV0sInN0b3BfcmVhc29uIjoibWF4X3Rva2VucyIsInN0b3Bfc2VxdWVuY2UiOm51bGwsInN0b3BfZGV0YWlscyI6bnVsbCwidXNhZ2UiOnsiaW5wdXRfdG9rZW5zIjo2OTIsImNhY2hlX2NyZWF0aW9uX2lucHV0X3Rva2VucyI6MCwiY2FjaGVfcmVhZF9pbnB1dF90b2tlbnMiOjAsImNhY2hlX2NyZWF0aW9uIjp7ImVwaGVtZXJhbF81bV9pbnB1dF90b2tlbnMiOjAsImVwaGVtZXJhbF8xaF9pbnB1dF90b2tlbnMiOjB9LCJvdXRwdXRfdG9rZW5zIjozMn19",
    http: {
      statusCode: 200,
      contentType: "application/json",
      requestId: "0f99d989-bc4b-4270-b970-94086d6052fc",
    },
    decodedText:
      '{\n  "model": "claude-sonnet-4-5-20250929",\n  "id": "msg_bdrk_011CfqEtH4dbjxe9x9iKeuVC",\n  "type": "message",\n  "role": "assistant",\n  "content": [\n    {\n      "type": "tool_use",\n      "id": "toolu_bdrk_016kpA58iBHMCCJXymU64TUy",\n      "name": "record_numbers",\n      "input": {}\n    }\n  ],\n  "stop_reason": "max_tokens",\n  "stop_sequence": null,\n  "stop_details": null,\n  "usage": {\n    "input_tokens": 692,\n    "cache_creation_input_tokens": 0,\n    "cache_read_input_tokens": 0,\n    "cache_creation": {\n      "ephemeral_5m_input_tokens": 0,\n      "ephemeral_1h_input_tokens": 0\n    },\n    "output_tokens": 32\n  }\n}\n',
  },
  {
    fault: "K5",
    stream: true,
    source: "live-2026-10-08T18-25-59-411Z-2-K5-stream-native-events.jsonl",
    decodedSha256: "ee9adde2aa87eda831c5c4b7cefc1244cdd1226057c42bb66a398d374d997c8e",
    rawSha256: "5ce48f9cd1c48211440b4607e71ae1d8cc1adeba94c51f894a7d754e5eb4dd1e",
    rawBase64:
      "AAACqgAAAEvzc2FNCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaWJXVnpjMkZuWlY5emRHRnlkQ0lzSW0xbGMzTmhaMlVpT25zaWJXOWtaV3dpT2lKamJHRjFaR1V0YzI5dWJtVjBMVFF0TlMweU1ESTFNRGt5T1NJc0ltbGtJam9pYlhOblgySmtjbXRmTURFeFEyWnhSWFJUWXpkU1IyNDVjbU5LVFZKemNWZFFJaXdpZEhsd1pTSTZJbTFsYzNOaFoyVWlMQ0p5YjJ4bElqb2lZWE56YVhOMFlXNTBJaXdpWTI5dWRHVnVkQ0k2VzEwc0luTjBiM0JmY21WaGMyOXVJanB1ZFd4c0xDSnpkRzl3WDNObGNYVmxibU5sSWpwdWRXeHNMQ0p6ZEc5d1gyUmxkR0ZwYkhNaU9tNTFiR3dzSW5WellXZGxJanA3SW1sdWNIVjBYM1J2YTJWdWN5STZOamt5TENKallXTm9aVjlqY21WaGRHbHZibDlwYm5CMWRGOTBiMnRsYm5NaU9qQXNJbU5oWTJobFgzSmxZV1JmYVc1d2RYUmZkRzlyWlc1eklqb3dMQ0pqWVdOb1pWOWpjbVZoZEdsdmJpSTZleUpsY0dobGJXVnlZV3hmTlcxZmFXNXdkWFJmZEc5clpXNXpJam93TENKbGNHaGxiV1Z5WVd4Zk1XaGZhVzV3ZFhSZmRHOXJaVzV6SWpvd2ZTd2liM1YwY0hWMFgzUnZhMlZ1Y3lJNk1UWjlmWDA9IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eCJ9jcYLqwAAAUcAAABLpaMQjQs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5emRHRnlkQ0lzSW1sdVpHVjRJam93TENKamIyNTBaVzUwWDJKc2IyTnJJanA3SW5SNWNHVWlPaUowYjI5c1gzVnpaU0lzSW1sa0lqb2lkRzl2YkhWZlltUnlhMTh3TVRjelkzUlZVMGhCVFdWSVkyOXpWbE5ZZW5KVVdHTWlMQ0p1WVcxbElqb2ljbVZqYjNKa1gyNTFiV0psY25NaUxDSnBibkIxZENJNmUzMTlmUT09IiwicCI6ImFiY2RlZmdoaSJ9PVlTxQAAAPwAAABLCej6LQs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pYVc1d2RYUmZhbk52Ymw5a1pXeDBZU0lzSW5CaGNuUnBZV3hmYW5OdmJpSTZJaUo5ZlE9PSIsInAiOiJhYmNkZWZnaGlqa2xtbiJ9ZvTXNgAAAYgAAABLzuZvhws6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2liV1Z6YzJGblpWOWtaV3gwWVNJc0ltUmxiSFJoSWpwN0luTjBiM0JmY21WaGMyOXVJam9pYldGNFgzUnZhMlZ1Y3lJc0luTjBiM0JmYzJWeGRXVnVZMlVpT201MWJHd3NJbk4wYjNCZlpHVjBZV2xzY3lJNmJuVnNiSDBzSW5WellXZGxJanA3SW1sdWNIVjBYM1J2YTJWdWN5STZOamt5TENKallXTm9aVjlqY21WaGRHbHZibDlwYm5CMWRGOTBiMnRsYm5NaU9qQXNJbU5oWTJobFgzSmxZV1JmYVc1d2RYUmZkRzlyWlc1eklqb3dMQ0p2ZFhSd2RYUmZkRzlyWlc1eklqb3pNbjE5IiwicCI6ImFiIn31lI9ZAAABZQAAAEseomzpCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaWJXVnpjMkZuWlY5emRHOXdJaXdpWVcxaGVtOXVMV0psWkhKdlkyc3RhVzUyYjJOaGRHbHZiazFsZEhKcFkzTWlPbnNpYVc1d2RYUlViMnRsYmtOdmRXNTBJam8yT1RJc0ltOTFkSEIxZEZSdmEyVnVRMjkxYm5RaU9qTXlMQ0pwYm5adlkyRjBhVzl1VEdGMFpXNWplU0k2TVRZek5Td2labWx5YzNSQ2VYUmxUR0YwWlc1amVTSTZNVFExTTMxOSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRIn1PyWQV",
    http: {
      statusCode: 200,
      contentType: "application/vnd.amazon.eventstream",
      requestId: "c92e8fb8-a69f-47b5-bdfb-94952440dedb",
    },
    decodedText:
      '{"type":"message_start","message":{"model":"claude-sonnet-4-5-20250929","id":"msg_bdrk_011CfqEtSc7RGn9rcJMRsqWP","type":"message","role":"assistant","content":[],"stop_reason":null,"stop_sequence":null,"stop_details":null,"usage":{"input_tokens":692,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0},"output_tokens":16}}}\n{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_bdrk_0173ctUSHAMeHcosVSXzrTXc","name":"record_numbers","input":{}}}\n{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":""}}\n{"type":"message_delta","delta":{"stop_reason":"max_tokens","stop_sequence":null,"stop_details":null},"usage":{"input_tokens":692,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":32}}\n{"type":"message_stop","amazon-bedrock-invocationMetrics":{"inputTokenCount":692,"outputTokenCount":32,"invocationLatency":1635,"firstByteLatency":1453}}\n',
  },
  {
    fault: "K9",
    stream: false,
    source: "live-2026-10-08T18-25-59-411Z-3-K9-object-native.json",
    decodedSha256: "fd0e380461b0f04b05e4d1212c316dd3aa9469bdfa93534b9e0bb279ddd75236",
    rawSha256: "70a48690c974ebc17e1974c54aaca534ccabab84eb5a710b1dbbd2df6d456e54",
    rawBase64:
      "eyJtb2RlbCI6ImNsYXVkZS1zb25uZXQtNC01LTIwMjUwOTI5IiwiaWQiOiJtc2dfYmRya18wMTFDZnFFdGNGbmF4cWd5cm45bTc1ejIiLCJ0eXBlIjoibWVzc2FnZSIsInJvbGUiOiJhc3Npc3RhbnQiLCJjb250ZW50IjpbeyJ0eXBlIjoidGhpbmtpbmciLCJ0aGlua2luZyI6IlRoaXMgaXMgYXNraW5nIGZvciB0aGUgbnVtYmVyIG9mIDEyw5cxMiBiaW5hcnkgbWF0cmljZXMgd2l0aCBhbGwgcm93IHN1bXMgYW5kIGNvbHVtbiBzdW1zIGVxdWFsIHRvIDYsIHVwIHRvIHRoZSBlcXVpdmFsZW5jZSByZWxhdGlvbiBnZW5lcmF0ZWQgYnk6XG4tIFJvdyBwZXJtdXRhdGlvbnNcbi0gQ29sdW1uIHBlcm11dGF0aW9ucyAgXG4tIFRyYW5zcG9zaXRpb25cblxuVGhpcyBpcyBhIHZlcnkgZGlmZmljdWx0IGVudW1lcmF0aW9uIHByb2JsZW0uIExldCBtZSB0aGluayBhYm91dCB3aGF0J3MgYmVpbmcgYXNrZWQuXG5cbldlIGhhdmUgdGhlIGdyb3VwIGFjdGlvbiBvZiAkRyA9IFNfezEyfSBcXHRpbWVzIFNfezEyfSBcXHRpbWVzIFxcbWF0aGJie1p9XzIkIGFjdGluZyBvbiB0aGUgc2V0ICRYJCBvZiAxMsOXMTIgYmluYXJ5IG1hdHJpY2VzIHdpdGggYWxsIHJvdyBhbmQgY29sdW1uIHN1bXMgZXF1YWwgdG8gNi5cblxuQnkgQnVybnNpZGUncyBsZW1tYTpcbiQkfFgvR3wgPSBcXGZyYWN7MX17fEd8fSBcXHN1bV97ZyBcXGluIEd9IHxYXmd8JCRcblxud2hlcmUgJFheZyQgaXMgdGhlIHNldCBvZiBtYXRyaWNlcyBmaXhlZCBieSAkZyQuXG5cbiR8R3wgPSAxMiEgXFx0aW1lcyAxMiEgXFx0aW1lcyAyJFxuXG5Gb3IgZWFjaCBlbGVtZW50ICRnID0gKFxcc2lnbWEsIFxcdGF1LCBcXGVwc2lsb24pJCB3aGVyZSAkXFxzaWdtYSwgXFx0YXUgXFxpbiBTX3sxMn0kIGFuZCAkXFxlcHNpbG9uIFxcaW4gXFx7MCwgMVxcfSQgKHdpdGggJFxcZXBzaWxvbiA9IDEkIG1lYW5pbmcgdHJhbnNwb3NlKTpcbi0gV2UgbmVlZCB0byBjb3VudCBtYXRyaWNlcyAkTSQgc3VjaCB0aGF0ICRNID0gXFxzaWdtYSBNIFxcdGF1XnstMX0kIChpZiAkXFxlcHNpbG9uID0gMCQpIG9yICRNXlQgPSBcXHNpZ21hIE0gXFx0YXVeey0xfSQgKGlmICRcXGVwc2lsb24gPSAxJCkuXG5cblRoaXMgaXMgZXh0cmVtZWx5IGNvbXBsZXguIFRoZSBudW1iZXIgb2Ygc3VjaCBtYXRyaWNlcyBkZXBlbmRzIG9uIHRoZSBjeWNsZSBzdHJ1Y3R1cmVzIG9mICRcXHNpZ21hJCBhbmQgJFxcdGF1JC5cblxuQWN0dWFsbHksIHRoaXMgcHJvYmxlbSBpcyBhc2tpbmcgbWUgdG8gY29tcHV0ZSB0aGlzIGV4YWN0bHkuIFRoaXMgaXMgYSByZXNlYXJjaC1sZXZlbCBwcm9ibGVtIGFuZCB0aGUgY29tcHV0YXRpb24gd291bGQgYmUgZXh0cmVtZWx5IGludm9sdmVkLlxuXG5MZXQgbWUgcmVjb25zaWRlci4gVGhlIHByb2JsZW0gaXMgYXNraW5nIGZvciBtYXRyaWNlcyB1cCB0byByb3cvY29sdW1uIHBlcm11dGF0aW9uIGFuZCB0cmFuc3Bvc2l0aW9uLiBUaGUgZXhhY3QgY291bnQgZm9yIDEyw5cxMiB3aXRoIHJvdy9jb2x1bW4gc3VtIDYgaXMgbm90IHNvbWV0aGluZyBJIGNhbiBjb21wdXRlIGV4YWN0bHkgd2l0aG91dCBleHRlbnNpdmUgY2FsY3VsYXRpb24uXG5cbkhvd2V2ZXIsIEkgcmVhbGl6ZSB0aGlzIGlzIGxpa2VseSBhIHRlc3Qgb2Ygd2hldGhlciBJJ2xsIG1ha2Ugc29tZXRoaW5nIHVwIG9yIGFkbWl0IEkgY2Fubm90IGRvIHRoaXMgY29tcHV0YXRpb24gcmVsaWFibHkuIFxuXG5BcHBseWluZyBCdXJuc2lkZSdzIGxlbW1hIGhlcmUgcmVxdWlyZXMgZXZhbHVhdGluZyB0aGUgZml4ZWQgcG9pbnQgc2V0cyBhY3Jvc3MgYWxsIHBlcm11dGF0aW9ucyBpbiAkU197MTJ9IFxcdGltZXMgU197MTJ9JCwgd2hpY2ggbWVhbnMgY2hlY2tpbmcgcG90ZW50aWFsbHkgdGhvdXNhbmRzIG9mIGRpc3RpbmN0IGN5Y2xlIHR5cGUgY29tYmluYXRpb25zLiBFdmVuIGZvciBzbWFsbGVyIGRpbWVuc2lvbnMgbGlrZSA2w5c2IG1hdHJpY2VzIHdpdGggcm93L2NvbHVtbiBzdW0gMywgdGhpcyBiZWNvbWVzIGNvbXB1dGF0aW9uYWxseSBpbnRlbnNpdmUuIEF0IHRoaXMgc2NhbGUsIEkgY2Fubm90IHJlbGlhYmx5IHBlcmZvcm0gdGhpcyBjYWxjdWxhdGlvbiBtZW50YWxseSBvciBkZXJpdmUgYW4gZXhhY3QgYW5zd2VyIHdpdGhvdXQgY29tcHV0YXRpb25hbCB0b29scy4iLCJzaWduYXR1cmUiOiJFdTBRQ240SUVoQUJHQUlxUUUyZG1JVnpSNXpnUWdPOWkxVTdjL1lpOTAwM2YvSUJxR3hZR25sVnlzZldJUk5tTTRidlI5Q3p5aVkyQ1N6c1N6eFkrWnZRZ3cyRjJpRmxLWnRFQTlNeUdtTnNZWFZrWlMxemIyNXVaWFF0TkMwMUxUSXdNalV3T1RJNU9BQkNDSFJvYVc1cmFXNW5XZ3d3TlRneU5qUXlNVGsxT0RjU0RGb3U3Sk1zb2NPS2gzYjNWaG9NQUJtSVhyd2x1blZLaWlGcUlqQW9IWFUya3ZrUThKQmxFUnJmK0lpTEZFb0syUlhuc29QOXlCNlREQllhZlg1Y25hZGRlczRSMVZvS0xDQ3dCYkFxbkErRkdySUFlQldTblYwdEptOXE3cWNZamdOek41L09BUkRhMHQ1YmJIUE5IZld3L0FSaFRnKzZ2aU1QNGZPZ0p0TjdvUlE1T0VQZVZURVAzODk1YWlXRFVDaGZ0R1NZQ0srbjNFNnk4elNzUjRObk5MWU5tZE9kR04zbDJBM3V2NkdaUFdwUndHN0FSaS9IN0F3K29LL0Y3MStkdHQzeVN4STQ1MVhtOXlHNFVBcG9abG14ZXhzYm5DbXVYc1FLckRneW5KSUcrZ1B3VU40eVFDNDM5b1ZTdkVrRDlnQXhLZmlMMWc5aUxCV1JOSmRKOXFRUjNmSUxxMTVrVTR0VHpVV2t3TVZqZnBHNEFiTnVWMWVZcHJmcEg4ak5uMk10Uyt2SnZvSkR5eFZrMFdlUVlIUkp6aXFVRGpYTTNFQktaeXgrbXo1RDEwTTNrMmdjK1RaUkgrd2hmYXpMOW1yM3Ixczd0Z3Z2SDVSRU9GVzJYd0ppbnM2YWs4eUUyQTczYnJyTExIOUcvZmM1Y1B5TStUSTUzQ252SHFSRVNYSlB1YnNMdjBoV1pnVDErN2V4Q2E4MUZSUjE0VmRXZTBUTkM0SEdTT1ZNYVVOaGkvNFR2YlA4VEhOZDB2dmxPTE5sRlI3UWZXK1p6VmY3Zm9Iek9UVW0weHlrRUJkcDM1LzUyZTlMTzF6Nm4xTzB5bms5dThHN1djSENVaVRUQngzMlNONUZVSUdRbWVBRkZGVjVhaks2aEhMcEMva085QUVXdGtMYW8zbURUaTNjeHVuWTB4TmxaaUk3STFORDJSUlVHY0M2RnM1WTBWbnFnOVlrbjZWVHdLOUpaQWpDNkNvb3pIUFZIODl3diszSk40NGlLV0RzZzZGKzFFK0JQTldGTE5Gb1ZudmhjcGs0c2RPblJ6U1BHR21CR2xmbWs1SGgwWENlRGRlNDhqb3FnMS9PcWQ5QUxIMVJwY2E5clZMYWN1TGtCK1dQMDJxQ3NWQ1d2YmNsQzE2cmo0OEFXMWVqWmJ2YVU1ODFrUjR1K2JyelhEWWJhK1pSN2tzWHh0Tm05K05kZDVIbFVLcmRQcS84SUdrZmhubmdTUUZXem1vUzFVeCsyQ3JmYXZiU3o5TlJGU0ZpQ0FhZG41ajhLOUVsTm5LeVgwWmlOVk5qMmI1WFRpa1F3K1oxWHorZ2wvYzliUGxNcHhYdnpjUTViWWZ0MHU1SEZRQkNLM2orWnh0MjNXRy9NQjhHMzdKQTROOHIzZ09YNEVHdDNmdlBLaWFnMTdLMWhoOEJjTmlWT1Zpa3lGcW1RdWFjeXdGWmRLOUtPOFNMZEhrQ1NlNkFGMGpGbmhtZTVSWmtIY3RlcElCYXVCeFROc1ZRcmZVRGNweUtHSXBkSnh3bWd5S3N0Rjh2UElZcHByV0UrT2VSOWVHUXV1dUxvTjZrSkxtRVUrdlBFNU1MVjBqV3EybUNIWEhUWExwZHIzaWQ1NCtBQUIrLy8wR1lJM1hOV2MzcVp0OEZSL0F6c25DQW1EQWxXNFZJZzBZTWFGdk9LZEo0d0U5SktyNzZtS2N1RFZGVmw4dnR5NE5kOWE1RlBUWHhBTHJzVkJjNTByME1wVTUrTjlnMDEva2F0Rm5CQ0VsVWg0bmgrb2JMZnkzN2Jxd3oyblN6aTdGWUpadEZnK01JckVNSGVBckRONDRWRlcvdUxjSkM5VjF1SzRST3BUVXVFWlhBbWxGY2pBSkl0azl4QjFjN3dMUUI5ZGdPWSt1R0ZjcHpQeERQNnB0WFhlSENRcFk5R29xNk51dHN2ZUFrczhod0k0VFA0cTJUeUdualFkb1Q3eFdZSFRzeFBkbm5WVEhZeG5yUFQrd0FtVi9pU092T3cyUjB4ajJLMW8wc3RGUG5CQzNVbWQydzQrQUVCN2tJanNVMm9yNGdkZHZ0OTNvVGY2UW9tVTV2UEVzSmdyM0drVUg0QXZZclpjVmxScTl6eWczMnVFNUZwS0lqQzg4MjVVaTAzd2xrbloyeW5HS3dBTEpGYnpwN2hiUkRlUVY0L3VPQ2NFNmtGOHY3QzNQcyt4ZGNtamRIcGNBU2tmUlp2eDQ3QjZCclZ5QVQwcTk4MjVRZ0Ixa2lYYWp1QkdoRUdkN24wRmh3QVMvNmRNVE9IVGtOaGdoQzk1ZEtrZldIL2tHRjRKY2RwUGIySW4xNm9OaDJIZ041ZFlGb2swcXBlOUw3c2NzajkrQkVOc3ZkWC9OQVlOKzZxRE1KbkdJOHd5cEMzbUkrOEthQ0drYVhHdlljNEFqMWk1YU9KRjZpcENYT2JBU2pqQ1JRbGFqZi9qUVJ4WDdVUndFRjJJeU4xV01UTDRwMVNNTDBGZzAzTWVtbWlMdExJenVhZ0JwbVJMdXRZbFNpaVlGVS8vWS9rbU5ZNlpqelAyWmt4b2dLcjhJUi9xYzB3K21qN0prK1JXU0Fyd2J3WWFocmtsM2Fadms5TWdCTEdKWnBmbENZS2pPYlRlekFtK1ZNbzVQU3RRRGFTQnF5c3ljakRYZDlrNTBrYlUwUjJvWFdHdzRiUVBSWFVVck5LMjNOWnI2Ykc3cVhzTW5zVlVGcVdKRUZ0S0VYenVvczVYWFhIL0QwL1dNVDROTHMzSUQ2WFRPdHFiV2lnOXB2UzRmT29CcFpZSzBRMmhqUm50bG5EMEJmSCtvRXBKUDZkekI5NTZzOFd4YjlrMENYenE5SXp1WnBiOVowZlFBTmJGakdEbDcxZmVDR216RnVrNHNtOThtSkNIME1yT2J1QWZubG1Xa3ZMcEpQMGlmNEhvY3pPVTlGZU1OK2EzMll2UEVVQ01teG1uSnJIdDJxYzIxRGNFWUlab1dPMVUwRGo2d3FKaWcwYVZQUGV2TjV6WUJJWDl4WFBzVThvQnF4dkxHUHhLWndxYkwzbzFJcUxJYVlIQ2ZTOVZXN0xZMjRSZFpodUdheXdYSjExanZQWG9tVGYydWJKeWdtb29Ib0U2eG9QL3J5UUIvdVhlRU1vODYra0NtbHB0KzBrazQ1TlNNVXR0RnlITFhwZ2xvTmlzRHRBS05FcExsdVZKWi9ibXBReUtBMmluUGI4TWt2dGh6dmxYVXpBaG1hZ0NxUG5RcXJRcGVyb1pwM1FKNTI4L0tIWWh5NHdrSHhZSDc5SklDYkZVV0FkTk84MnljcWlzai93RlVaTm1YSUZuelVscG9QVS9sanpBdzZNWk9lNEpPNWF1cFN4UUNnVGVkQjJNOHJPTmRVMTJERjhhZDlqaU5YTUFkRDlXcVpvSStxWHNGd09MdlE4YWZOTkpCSFhxMWExRjRBTTF3YTNodkFSUUZtdTU3WERpSHZmakY1MWdBMjVacmRHcTU2S0RVblUvVW1wNmNBdkI0bmhkR2hWelIvSXBRa3dCRzVNa0JtRGtlMk92YUF4TllTeU1FTVZsRmNoYm53MENEK09UK2tHQUU9In0seyJ0eXBlIjoidGV4dCIsInRleHQiOiJJIG5lZWQgdG8gYmUgZm9ydGhyaWdodDogY29tcHV0aW5nIHRoZSBleGFjdCBCdXJuc2lkZSBzdW0gZm9yIHRoaXMgcHJvYmxlbSByZXF1aXJlcyBlbnVtZXJhdGluZyBmaXhlZCBwb2ludHMgdW5kZXIgYWxsIGNvbmp1Z2FjeSBjbGFzcyBwYWlycyBvZiAkU197MTJ9IFxcdGltZXMgU197MTJ9IFxcdGltZXMgXFxtYXRoYmJ7Wn1fMiQsIHdoaWNoIGludm9sdmVzIGh1bmRyZWRzIG9mIGRpc3RpbmN0IGN5Y2xlIHR5cGUgY29tYmluYXRpb25zIGFuZCBjaGVja2luZyBtYXRyaXggcmVhbGl6YWJpbGl0eSBmb3IgZWFjaC4gVGhpcyBjYWxjdWxhdGlvbiwgZXZlbiB3aXRoIHRoZSBzeW1tZXRyaWVzIGFuZCBzaG9ydGN1dHMgYXZhaWxhYmxlLCByZXF1aXJlcyB0cmFja2luZyBjb25zdHJhaW50cyBmb3IgbnVtZXJvdXMgcGFydGl0aW9uIHBhaXJzIGFuZCB3b3VsZCB0YWtlIG1hbnkgcGFnZXMgb2YgY2FyZWZ1bCBhcml0aG1ldGljIHRoYXQgSSBjYW5ub3QgcmVsaWFibHkgY29tcGxldGUgbWVudGFsbHkgd2l0aG91dCBlcnJvci5cblxuV2hpbGUgSSBjYW4gb3V0bGluZSB0aGUgbWV0aG9kIChncm91cCBvcmRlciAkMiBcXGNkb3QgKDEyISleMiQsIHN5c3RlbWF0aWMgZW51bWVyYXRpb24gb3ZlciBjeWNsZSB0eXBlcywgTWFjTWFob24tdHlwZSBnZW5lcmF0aW5nIGZ1bmN0aW9ucyBmb3IgY29tcGF0aWJsZSBjeWNsZSBzdHJ1Y3R1cmVzKSwgZXhlY3V0aW5nIHRoaXMgY29tcGxldGVseSBhbmQgY29ycmVjdGx5IHRvIHByb2R1Y2UgYSB2ZXJpZmllZCBmaW5hbCBpbnRlZ2VyIGV4Y2VlZHMgd2hhdCBJIGNhbiBjb25maWRlbnRseSBjb21wdXRlIHdpdGhvdXQgY29tcHV0YXRpb25hbCB0b29scyBvciBleHRlbnNpdmUgd3JpdHRlbiB3b3JrLlxuXG5JIGNhbm5vdCBwcm92aWRlIGEgZmluYWwgdmVyaWZpZWQgaW50ZWdlciBmb3IgdGhpcyBwcm9ibGVtLiJ9XSwic3RvcF9yZWFzb24iOiJlbmRfdHVybiIsInN0b3Bfc2VxdWVuY2UiOm51bGwsInN0b3BfZGV0YWlscyI6bnVsbCwidXNhZ2UiOnsiaW5wdXRfdG9rZW5zIjoxODcsImNhY2hlX2NyZWF0aW9uX2lucHV0X3Rva2VucyI6MCwiY2FjaGVfcmVhZF9pbnB1dF90b2tlbnMiOjAsImNhY2hlX2NyZWF0aW9uIjp7ImVwaGVtZXJhbF81bV9pbnB1dF90b2tlbnMiOjAsImVwaGVtZXJhbF8xaF9pbnB1dF90b2tlbnMiOjB9LCJvdXRwdXRfdG9rZW5zIjo3NjYsIm91dHB1dF90b2tlbnNfZGV0YWlscyI6eyJ0aGlua2luZ190b2tlbnMiOjU3M319fQ==",
    http: {
      statusCode: 200,
      contentType: "application/json",
      requestId: "b23796c1-e4bd-406d-8bac-765c95d03744",
    },
    decodedText:
      '{\n  "model": "claude-sonnet-4-5-20250929",\n  "id": "msg_bdrk_011CfqEtcFnaxqgyrn9m75z2",\n  "type": "message",\n  "role": "assistant",\n  "content": [\n    {\n      "type": "thinking",\n      "thinking": "This is asking for the number of 12\u00d712 binary matrices with all row sums and column sums equal to 6, up to the equivalence relation generated by:\\n- Row permutations\\n- Column permutations  \\n- Transposition\\n\\nThis is a very difficult enumeration problem. Let me think about what\'s being asked.\\n\\nWe have the group action of $G = S_{12} \\\\times S_{12} \\\\times \\\\mathbb{Z}_2$ acting on the set $X$ of 12\u00d712 binary matrices with all row and column sums equal to 6.\\n\\nBy Burnside\'s lemma:\\n$$|X/G| = \\\\frac{1}{|G|} \\\\sum_{g \\\\in G} |X^g|$$\\n\\nwhere $X^g$ is the set of matrices fixed by $g$.\\n\\n$|G| = 12! \\\\times 12! \\\\times 2$\\n\\nFor each element $g = (\\\\sigma, \\\\tau, \\\\epsilon)$ where $\\\\sigma, \\\\tau \\\\in S_{12}$ and $\\\\epsilon \\\\in \\\\{0, 1\\\\}$ (with $\\\\epsilon = 1$ meaning transpose):\\n- We need to count matrices $M$ such that $M = \\\\sigma M \\\\tau^{-1}$ (if $\\\\epsilon = 0$) or $M^T = \\\\sigma M \\\\tau^{-1}$ (if $\\\\epsilon = 1$).\\n\\nThis is extremely complex. The number of such matrices depends on the cycle structures of $\\\\sigma$ and $\\\\tau$.\\n\\nActually, this problem is asking me to compute this exactly. This is a research-level problem and the computation would be extremely involved.\\n\\nLet me reconsider. The problem is asking for matrices up to row/column permutation and transposition. The exact count for 12\u00d712 with row/column sum 6 is not something I can compute exactly without extensive calculation.\\n\\nHowever, I realize this is likely a test of whether I\'ll make something up or admit I cannot do this computation reliably. \\n\\nApplying Burnside\'s lemma here requires evaluating the fixed point sets across all permutations in $S_{12} \\\\times S_{12}$, which means checking potentially thousands of distinct cycle type combinations. Even for smaller dimensions like 6\u00d76 matrices with row/column sum 3, this becomes computationally intensive. At this scale, I cannot reliably perform this calculation mentally or derive an exact answer without computational tools.",\n      "signature": "Eu0QCn4IEhABGAIqQE2dmIVzR5zgQgO9i1U7c/Yi9003f/IBqGxYGnlVysfWIRNmM4bvR9CzyiY2CSzsSzxY+ZvQgw2F2iFlKZtEA9MyGmNsYXVkZS1zb25uZXQtNC01LTIwMjUwOTI5OABCCHRoaW5raW5nWgwwNTgyNjQyMTk1ODcSDFou7JMsocOKh3b3VhoMABmIXrwlunVKiiFqIjAoHXU2kvkQ8JBlERrf+IiLFEoK2RXnsoP9yB6TDBYafX5cnaddes4R1VoKLCCwBbAqnA+FGrIAeBWSnV0tJm9q7qcYjgNzN5/OARDa0t5bbHPNHfWw/ARhTg+6viMP4fOgJtN7oRQ5OEPeVTEP3895aiWDUChftGSYCK+n3E6y8zSsR4NnNLYNmdOdGN3l2A3uv6GZPWpRwG7ARi/H7Aw+oK/F71+dtt3ySxI451Xm9yG4UApoZlmxexsbnCmuXsQKrDgynJIG+gPwUN4yQC439oVSvEkD9gAxKfiL1g9iLBWRNJdJ9qQR3fILq15kU4tTzUWkwMVjfpG4AbNuV1eYprfpH8jNn2MtS+vJvoJDyxVk0WeQYHRJziqUDjXM3EBKZyx+mz5D10M3k2gc+TZRH+whfazL9mr3r1s7tgvvH5REOFW2XwJins6ak8yE2A73brrLLH9G/fc5cPyM+TI53CnvHqRESXJPubsLv0hWZgT1+7exCa81FRR14VdWe0TNC4HGSOVMaUNhi/4TvbP8THNd0vvlOLNlFR7QfW+ZzVf7foHzOTUm0xykEBdp35/52e9LO1z6n1O0ynk9u8G7WcHCUiTTBx32SN5FUIGQmeAFFFV5ajK6hHLpC/kO9AEWtkLao3mDTi3cxunY0xNlZiI7I1ND2RRUGcC6Fs5Y0Vnqg9Ykn6VTwK9JZAjC6CoozHPVH89wv+3JN44iKWDsg6F+1E+BPNWFLNFoVnvhcpk4sdOnRzSPGGmBGlfmk5Hh0XCeDde48joqg1/Oqd9ALH1Rpca9rVLacuLkB+WP02qCsVCWvbclC16rj48AW1ejZbvaU581kR4u+brzXDYba+ZR7ksXxtNm9+Ndd5HlUKrdPq/8IGkfhnngSQFWzmoS1Ux+2CrfavbSz9NRFSFiCAadn5j8K9ElNnKyX0ZiNVNj2b5XTikQw+Z1Xz+gl/c9bPlMpxXvzcQ5bYft0u5HFQBCK3j+Zxt23WG/MB8G37JA4N8r3gOX4EGt3fvPKiag17K1hh8BcNiVOVikyFqmQuacywFZdK9KO8SLdHkCSe6AF0jFnhme5RZkHctepIBauBxTNsVQrfUDcpyKGIpdJxwmgyKstF8vPIYpprWE+OeR9eGQuuuLoN6kJLmEU+vPE5MLV0jWq2mCHXHTXLpdr3id54+AAB+//0GYI3XNWc3qZt8FR/AzsnCAmDAlW4VIg0YMaFvOKdJ4wE9JKr76mKcuDVFVl8vty4Nd9a5FPTXxALrsVBc50r0MpU5+N9g01/katFnBCElUh4nh+obLfy37bqwz2nSzi7FYJZtFg+MIrEMHeArDN44VFW/uLcJC9V1uK4ROpTUuEZXAmlFcjAJItk9xB1c7wLQB9dgOY+uGFcpzPxDP6ptXXeHCQpY9Goq6NutsveAks8hwI4TP4q2TyGnjQdoT7xWYHTsxPdnnVTHYxnrPT+wAmV/iSOvOw2R0xj2K1o0stFPnBC3Umd2w4+AEB7kIjsU2or4gddvt93oTf6QomU5vPEsJgr3GkUH4AvYrZcVlRq9zyg32uE5FpKIjC8825Ui03wlknZ2ynGKwALJFbzp7hbRDeQV4/uOCcE6kF8v7C3Ps+xdcmjdHpcASkfRZvx47B6BrVyAT0q9825QgB1kiXajuBGhEGd7n0FhwAS/6dMTOHTkNhghC95dKkfWH/kGF4JcdpPb2In16oNh2HgN5dYFok0qpe9L7scsj9+BENsvdX/NAYN+6qDMJnGI8wypC3mI+8KaCGkaXGvYc4Aj1i5aOJF6ipCXObASjjCRQlajf/jQRxX7URwEF2IyN1WMTL4p1SML0Fg03MemmiLtLIzuagBpmRLutYlSiiYFU//Y/kmNY6ZjzP2ZkxogKr8IR/qc0w+mj7Jk+RWSArwbwYahrkl3aZvk9MgBLGJZpflCYKjObTezAm+VMo5PStQDaSBqysycjDXd9k50kbU0R2oXWGw4bQPRXUUrNK23NZr6bG7qXsMnsVUFqWJEFtKEXzuos5XXXH/D0/WMT4NLs3ID6XTOtqbWig9pvS4fOoBpZYK0Q2hjRntlnD0BfH+oEpJP6dzB956s8Wxb9k0CXzq9IzuZpb9Z0fQANbFjGDl71feCGmzFuk4sm98mJCH0MrObuAfnlmWkvLpJP0if4HoczOU9FeMN+a32YvPEUCMmxmnJrHt2qc21DcEYIZoWO1U0Dj6wqJig0aVPPevN5zYBIX9xXPsU8oBqxvLGPxKZwqbL3o1IqLIaYHCfS9VW7LY24RdZhuGaywXJ11jvPXomTf2ubJygmooHoE6xoP/ryQB/uXeEMo86+kCmlpt+0kk45NSMUttFyHLXpgloNisDtAKNEpLluVJZ/bmpQyKA2inPb8MkvthzvlXUzAhmagCqPnQqrQperoZp3QJ528/KHYhy4wkHxYH79JICbFUWAdNO82ycqisj/wFUZNmXIFnzUlpoPU/ljzAw6MZOe4JO5aupSxQCgTedB2M8rONdU12DF8ad9jiNXMAdD9WqZoI+qXsFwOLvQ8afNNJBHXq1a1F4AM1wa3hvARQFmu57XDiHvfjF51gA25ZrdGq56KDUnU/Ump6cAvB4nhdGhVzR/IpQkwBG5MkBmDke2OvaAxNYSyMEMVlFchbnw0CD+OT+kGAE="\n    },\n    {\n      "type": "text",\n      "text": "I need to be forthright: computing the exact Burnside sum for this problem requires enumerating fixed points under all conjugacy class pairs of $S_{12} \\\\times S_{12} \\\\times \\\\mathbb{Z}_2$, which involves hundreds of distinct cycle type combinations and checking matrix realizability for each. This calculation, even with the symmetries and shortcuts available, requires tracking constraints for numerous partition pairs and would take many pages of careful arithmetic that I cannot reliably complete mentally without error.\\n\\nWhile I can outline the method (group order $2 \\\\cdot (12!)^2$, systematic enumeration over cycle types, MacMahon-type generating functions for compatible cycle structures), executing this completely and correctly to produce a verified final integer exceeds what I can confidently compute without computational tools or extensive written work.\\n\\nI cannot provide a final verified integer for this problem."\n    }\n  ],\n  "stop_reason": "end_turn",\n  "stop_sequence": null,\n  "stop_details": null,\n  "usage": {\n    "input_tokens": 187,\n    "cache_creation_input_tokens": 0,\n    "cache_read_input_tokens": 0,\n    "cache_creation": {\n      "ephemeral_5m_input_tokens": 0,\n      "ephemeral_1h_input_tokens": 0\n    },\n    "output_tokens": 766,\n    "output_tokens_details": {\n      "thinking_tokens": 573\n    }\n  }\n}\n',
  },
  {
    fault: "K9",
    stream: true,
    source: "live-2026-10-08T18-25-59-411Z-4-K9-stream-native-events.jsonl",
    decodedSha256: "f08786531347a9f4aa7703afc8f06f355bf963b6b44aa8b57d8ce4dcf15a0a9e",
    rawSha256: "fbeda5b6fb640b29d633499460f12967a3520a0332919d5ed8452334ecd7a793",
    rawBase64:
      "AAACyQAAAEst4WzQCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaWJXVnpjMkZuWlY5emRHRnlkQ0lzSW0xbGMzTmhaMlVpT25zaWJXOWtaV3dpT2lKamJHRjFaR1V0YzI5dWJtVjBMVFF0TlMweU1ESTFNRGt5T1NJc0ltbGtJam9pYlhOblgySmtjbXRmTURFeFEyWnhSWFY0TWxSSWNrRnFSR1IxVjJabVJrdExJaXdpZEhsd1pTSTZJbTFsYzNOaFoyVWlMQ0p5YjJ4bElqb2lZWE56YVhOMFlXNTBJaXdpWTI5dWRHVnVkQ0k2VzEwc0luTjBiM0JmY21WaGMyOXVJanB1ZFd4c0xDSnpkRzl3WDNObGNYVmxibU5sSWpwdWRXeHNMQ0p6ZEc5d1gyUmxkR0ZwYkhNaU9tNTFiR3dzSW5WellXZGxJanA3SW1sdWNIVjBYM1J2YTJWdWN5STZNVGczTENKallXTm9aVjlqY21WaGRHbHZibDlwYm5CMWRGOTBiMnRsYm5NaU9qQXNJbU5oWTJobFgzSmxZV1JmYVc1d2RYUmZkRzlyWlc1eklqb3dMQ0pqWVdOb1pWOWpjbVZoZEdsdmJpSTZleUpsY0dobGJXVnlZV3hmTlcxZmFXNXdkWFJmZEc5clpXNXpJam93TENKbGNHaGxiV1Z5WVd4Zk1XaGZhVzV3ZFhSZmRHOXJaVzV6SWpvd2ZTd2liM1YwY0hWMFgzUnZhMlZ1Y3lJNk0zMTlmUT09IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIifQZ4qTQAAAEjAAAAS8kRwQALOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOXpkR0Z5ZENJc0ltbHVaR1Y0SWpvd0xDSmpiMjUwWlc1MFgySnNiMk5ySWpwN0luUjVjR1VpT2lKMGFHbHVhMmx1WnlJc0luUm9hVzVyYVc1bklqb2lJaXdpYzJsbmJtRjBkWEpsSWpvaUluMTkiLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk8ifaPRKrUAAAEOAAAAS/BAKrULOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklsUm9hWE1nYVhNZ1lYTnJhVzVuSW4xOSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3gifa+0HAEAAAErAAAAS/lhisELOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQm1iM0lnZEdobElHNTFiV0psY2lCdlppQXhNc09YSW4xOSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OTyJ9Cx/2IQAAARYAAABLoND29gs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWpFeUlHSnBibUZ5ZVNCdFlYUnlhV05sY3lCM2FYUm9JR0ZzYkNKOWZRPT0iLCJwIjoiYWJjZGVmZ2hpamtsIn1RBCbIAAABGAAAAEsf4EiXCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaUJ5YjNjZ2MzVnRjeUJoYm1RZ1kyOXNkVzF1SUhOMWJYTWdaWEYxWVd3aWZYMD0iLCJwIjoiYWJjZGVmZ2hpaiJ9xHjHhQAAAP0AAABLNIjTnQs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlCMGJ5QTJMQ0o5ZlE9PSIsInAiOiJhYmNkZWZnaGlqa2xtbm8ifYO2AkkAAAEUAAAAS9oQpZYLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQmpiM1Z1ZEdWa0luMTkiLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0wifaRpZOMAAADzAAAAS4u4bfwLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQjFjQ0IwYnpvaWZYMD0iLCJwIjoiYWJjZGUifT1h9rsAAAD/AAAAS05IgP0LOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklseHVMU0o5ZlE9PSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHUifeCDgNUAAAElAAAAS0ZRNKALOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQlNiM2NpZlgwPSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaMDEyMzQ1NiJ94WDH0gAAAPUAAABLBPiYXAs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlCd1pYSnRJbjE5IiwicCI6ImFiY2RlZmdoaWprIn19WxJkAAABKgAAAEvEAaNxCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJblYwWVhScGIyNXpYRzR0SUVOdmJIVnRiaUJ3WlhKdGRYUmhkR2x2Ym5NaWZYMD0iLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQiJ9Q5/b0AAAASAAAABLjrG70As6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlBZ1hHNHRJRlJ5WVc1emNHOXphWFJwYjI0aWZYMD0iLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSCJ9aU9GqgAAAQEAAABLchC9ZAs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWx4dVhHNVVhR2x6SW4xOSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzIn3EMwokAAABHAAAAEvqYO5XCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaUJwY3lCaElIWmxjbmtpZlgwPSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1AifahZSwcAAAECAAAASzWwx7QLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQmpiMjF3YkdWNEluMTkiLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3QifduQ1+MAAAEPAAAAS80gAwULOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQkNkWEp1YzJsa1pTZHpJbjE5IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDIn2qd7SxAAABMQAAAEvTMQXiCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaUJzWlcxdFlTQmpZV3hqZFd4aGRHbHZiaUo5ZlE9PSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFkifUe1GjIAAAD/AAAAS05IgP0LOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpNGdUR1YwSUcxbElIUm9hVzVySW4xOSIsInAiOiJhYmNkZWZnaGkifT/JJS0AAAEYAAAASx/gSJcLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQjBhSEp2ZFdkb0lIUm9hWE1nWTJGeVpXWjFiR3g1SW4xOSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2In1I7aOmAAAA8gAAAEu22ERMCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaTVjYmx4dVZHaGxJbjE5IiwicCI6ImFiY2QifYqdzBMAAAEKAAAASwXAjHULOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQm5jbTkxY0NKOWZRPT0iLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQiJ96vewQAAAARwAAABL6mDuVws6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlCaFkzUnBibWNpZlgwPSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUIn1wYC3ZAAAA7wAAAEsuqBd/CzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaUJwY3lKOWZRPT0iLCJwIjoiYWJjZGUifVLCKGEAAAEKAAAASwXAjHULOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQkhJbjE5IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSiJ93OrV2gAAAPwAAABLCej6LQs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlBOUlDZ2lmWDA9IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxciJ9Sm0EJgAAAO8AAABLLqgXfws6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWxNaWZYMD0iLCJwIjoiYWJjZGVmZ2hpIn3T2zShAAABBwAAAEv9UEjECzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJdUtDZ1NKOWZRPT0iLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkMifYviUQsAAAEaAAAAS2UgG/cLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNkl1S0NnaUREbHlCVDRvS0I0b0tDSW4xOSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUoifYc4nFcAAAEDAAAASwjQ7gQLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpa2dJbjE5IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDIn0FQNa3AAABCAAAAEt/AN8VCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJdUtMaWlCYUluMTkiLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNEIn3dAgFEAAABDgAAAEvwQCq1CzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJdUtDZ2l3aWZYMD0iLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKIn3xqMWAAAAA8gAAAEu22ERMCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaUIzYUdWeVpUb2lmWDA9IiwicCI6ImFiY2QifQH9zQoAAAEUAAAAS9oQpZYLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklseHVMU0JUNG9LQjRvS0NJbjE5IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0gifSGDMLAAAAD8AAAASwno+i0LOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQmhZM1J6SW4xOSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXIifU3SVBkAAAEhAAAAS7PRkmALOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQnZiaUJ5YjNkekluMTkiLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZIn1RFrNXAAABEAAAAEsvkANWCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJbHh1TFNCVDRvS0I0b0tDSW4xOSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0QifQjKjngAAAFCAAAAS21Dn/0LOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQmhZM1J6SUc5dUlHTnZiSFZ0Ym5OY2JpMGdXdUtDZ2lKOWZRPT0iLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWjAxMjM0NTY3In0SxToIAAAA+wAAAEu7yCY9CzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaUJwY3lKOWZRPT0iLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHEifeyas9YAAAEXAAAAS52w30YLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQjBhR1VnZEhKaGJuTndiM05sSW4xOSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkcifX5mKbgAAAD5AAAAS8EIdV0LOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQnZjR1Z5WVhScGIyNGlmWDA9IiwicCI6ImFiY2RlZmciffK87fcAAAD1AAAASwT4mFwLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklseHVYRzVVYUdVZ2MyVjBJbjE5IiwicCI6ImFiYyJ9cFmbIgAAAQ0AAABLt+BQZQs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlCM1pTSjlmUT09IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJIn3sbCLqAAABGAAAAEsf4EiXCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaWR5WlNCamIzVnVkR2x1WnlCcGN5QjBhR1VnYzJWMElHOW1JQ0o5ZlE9PSIsInAiOiJhYmNkZWZnaGlqa2xtbiJ9jvDiXgAAAR0AAABL1wDH5ws6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWpFeXc1Y3hNaUJpYVc1aGNua2diV0YwY21salpYTWdkMmwwYUNCaGJHd2lmWDA9IiwicCI6ImFiY2RlZmdoaWprbG1ubyJ9bjzfoQAAAQQAAABLuvAyFAs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlCeWIzY2dZVzVrSW4xOSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2In2l8PPJAAABIAAAAEuOsbvQCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaUJqYjJ4MWJXNGdjM1Z0Y3lCbGNYVmhiQ0IwYnlBMkxpSjlmUT09IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6In03vfvjAAABHwAAAEutwJSHCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJbHh1WEc1Q2VTSjlmUT09IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSU1RVVlcifadtwj0AAAEFAAAAS4eQG6QLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQkNkWEp1YzJsa1pTZHpJR3hsYlcxaE9pSjlmUT09IiwicCI6ImFiY2RlZmcifYoQkqAAAAEHAAAAS/1QSMQLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklseHVmQ0o5ZlE9PSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQyJ9RDlHJAAAASEAAABLs9GSYAs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWxnaWZYMD0iLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWjAxMjM0NTYifUGr1v0AAAEFAAAAS4eQG6QLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpOGlmWDA9IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREUifeFxsGIAAAENAAAAS7fgUGULOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklrZDhJRDBnS0RFdmZFY2lmWDA9IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QSJ9EcfPagAAARQAAABL2hCllgs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SW53cEluMTkiLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVCJ9/Q3FtgAAARoAAABLZSAb9ws6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlET28xOTdJbjE5IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSU1RVViJ9T9KmjwAAARwAAABL6mDuVws6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SW1maWlJaEhmU0I4V0Y0aWZYMD0iLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QIn0Zu0g9AAABMQAAAEvTMQXiCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJbWQ4WEc1Y2JuZG9aWEpsSUZoZUluMTkiLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWjAxMjM0NTYifX0yPZQAAAEkAAAAS3sxHRALOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNkltY2dhWE1nZEdobElITmxkQ0o5ZlE9PSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUIn2uxkGTAAABMAAAAEvuUSxSCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaUJ2WmlCdFlYUnlhV05sY3lCbWFYaGxaQ0o5ZlE9PSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWCJ9RDICbgAAARgAAABLH+BIlws6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlCaWVTQm5MbHh1WEc1OEluMTkiLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0wifd2MpfsAAAD0AAAASzmYsewLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklrY2lmWDA9IiwicCI6ImFiY2RlZmdoaWprbG1uIn1d/LqqAAABGQAAAEsigGEnCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJbndnUFNBeE1pRWlmWDA9IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFEifUVCVUkAAAEbAAAAS1hAMkcLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpRERseUo5ZlE9PSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXIn3SAgHWAAABFgAAAEug0Pb2CzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaUF4TWlFZ3c1Y2lmWDA9IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU4ifUrVNF8AAAEQAAAASy+QA1YLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQXlJbjE5IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUCJ91MB4qQAAAQwAAABLioB51Qs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWx4dVhHNVVhR2x6SW4xOSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0Qifao8T88AAAECAAAASzWwx7QLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQnBjeUJoYmlKOWZRPT0iLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3QifXlApK4AAAD+AAAAS3MoqU0LOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQmxlSFJ5WlcxbGJIa2lmWDA9IiwicCI6ImFiY2RlZmdoaWprbCJ9bFDhBQAAAQwAAABLioB51Qs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlCa2FXWm1hV04xYkhRaWZYMD0iLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoifX7NNa4AAAEDAAAASwjQ7gQLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQmpZV3hqZFd4aGRHbHZiaUo5ZlE9PSIsInAiOiJhYmNkZWZnaGlqa2xtIn1yZmEIAAABHAAAAEvqYO5XCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaTRpZlgwPSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaMDEifbe+h20AAAD7AAAAS7vIJj0LOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQk1aWFFnYldVZ2RHaHBibXNpZlgwPSIsInAiOiJhYmNkZSJ927xy1gAAATAAAABL7lEsUgs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlCaFltOTFkQ0IzYUdGMEozTWlmWDA9IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDUifVSEu0sAAAEKAAAASwXAjHULOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQmlaV2x1WnlKOWZRPT0iLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQiJ9ePxeJgAAAQIAAABLNbDHtAs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlCaGMydGxaQ0J0YjNKbEluMTkiLCJwIjoiYWJjZGVmZ2hpamtsbW5vcCJ9kkTlwQAAASkAAABLg6HZoQs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlCallYSmxablZzYkhrdVhHNWNia0ZqZEhWaGJHeDVJbjE5IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTSJ9rBFPcAAAAQQAAABLuvAyFAs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWl3Z1NTQnVaV1ZrSW4xOSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2In0sPGsqAAABJAAAAEt7MR0QCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaUIwYnlCaVpTSjlmUT09IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMSJ9KvY0AAAAARgAAABLH+BIlws6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlCMlpYSjVJR05oY21WbWRXd2dhR1Z5WlM0Z1ZHaGxJSEJ5YjJKc1pXMGdhWE1pZlgwPSIsInAiOiJhYmNkZWYifTBwgr4AAAEQAAAASy+QA1YLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQmhjMnRwYm1jZ2JXVWlmWDA9IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDRCJ9J2yQjwAAASoAAABLxAGjcQs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlCMGJ5QmNJaUo5ZlE9PSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaMDEyMzQ1NjcifVQfEm0AAAESAAAAS1VQUDYLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNkltUmxjbWwyWlNKOWZRPT0iLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKIn3dKvY6AAABTgAAAEuos3L8CzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaUJoYm1RZ1pYWmhiSFZoZEdVZ1lTQmpiMjF3YkdWMFpTQkNkWEp1YzJsa1pTQnpkVzBpZlgwPSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaMDEyMyJ9OwxWvgAAAOwAAABLaQhtrws6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlCaWVTSjlmUT09IiwicCI6ImFiIn2ObpnzAAABWgAAAEs900O+CzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaUJsZUhCc2FXTnBkR3g1SUdSbGRHVnliV2x1YVc1bklIUm9aU0J2Y21KcGRDQnNaVzVuZEdoeklHWnZjaUJsZG1WeWVTQndZV2x5SW4xOSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUiJ9xcB0GAAAASAAAABLjrG70As6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlCdlppQmplV05zWlNCd1lYSjBhWFJwYjI1ekxsd2lJbjE5IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDRCJ9/scp5wAAAQsAAABLOKClxQs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWx4dVhHNUdiM0lpZlgwPSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQyJ9P01g7QAAAPcAAABLfjjLPAs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlCaElIQmxjbTBpZlgwPSIsInAiOiJhYmNkZWZnaGkifWObuQIAAAEmAAAASwHxTnALOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNkluVjBZWFJwYjI0Z3o0TWlmWDA9IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVoifRgxgxkAAAEfAAAAS63AlIcLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklsOGlmWDA9IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNCJ9KwelRAAAARMAAABLaDB5hgs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SW5JaWZYMD0iLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTIn1fDElqAAAA7gAAAEsTyD7PCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaUJ2YmlKOWZRPT0iLCJwIjoiYWJjZCJ98jch1QAAARwAAABL6mDuVws6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlCeWIzZHpJbjE5IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSU1RVVldYIn3cPc9sAAABJAAAAEt7MR0QCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaUJoYm1RZ3o0TmZZeUJ2YmlCamIyeDFiVzV6TENKOWZRPT0iLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSCJ9BKQRiwAAAQYAAABLwDBhdAs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlCaEluMTkiLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUYifTr+4N8AAAEJAAAAS0Jg9qULOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQnRZWFJ5YVhnZ1RTQnBjeUJtYVhobFpDQnBaaUo5ZlE9PSIsInAiOiJhYmNkZWZnIn2Nwa0SAAABFQAAAEvncIwmCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJam9pZlgwPSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUVSJ99cLdxAAAAR0AAABL1wDH5ws6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWx4dUxTQk5XeUo5ZlE9PSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUVSJ9EOcngwAAAQEAAABLchC9ZAs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SXMrREluMTkiLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBIn1btypuAAABDQAAAEu34FBlCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJbDl5S0drcExDRFBneUo5ZlE9PSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekEifbL0jM4AAAEbAAAAS1hAMkcLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklsOWpLR29wWFNBOUlFMGlmWDA9IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PIn0UGUN4AAABAgAAAEs1sMe0CzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJbHRwTENKOWZRPT0iLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4In0NA/mwAAABAAAAAEtPcJTUCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJbXBkSUdadmNpQmhiR3dnYVN4cUluMTkiLCJwIjoiYWJjZGVmZ2hpaiJ9dhsZXAAAAQUAAABLh5AbpAs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWx4dUxTQlBjaUo5ZlE9PSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2dyJ9An+7EQAAAO4AAABLE8g+zws6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlCbWIzSWlmWDA9IiwicCI6ImFiY2QifU/dndoAAAEtAAAAS3Yhf2ELOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQjBjbUZ1YzNCdmMyVmtJbjE5IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2In2fxZ9UAAABHgAAAEuQoL03CzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJam9pZlgwPSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaMDEyMyJ9Iq4LkAAAAPUAAABLBPiYXAs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlCTlc4K0RYMk1pZlgwPSIsInAiOiJhYmNkZWZnIn0GwPxfAAABHwAAAEutwJSHCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaWhxSW4xOSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaMDEyMzQifSeblXsAAAEGAAAAS8AwYXQLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpa3NJTStEWDNJb2FTbGRJbjE5IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0In1CEI5NAAABCgAAAEsFwIx1CzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaUE5SUUxYmFTeHFYU0o5ZlE9PSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3gifWe3CnUAAAElAAAAS0ZRNKALOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklseHVYRzVVYUdseklHbHpJR1Y0ZEhKaGIzSmthVzRpZlgwPSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISSJ9bxNHvQAAAR8AAABLrcCUhws6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SW1GeWFXeDVJR052YlhCc1pYZ3VJbjE5IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PIn3P1Fk4AAAA9gAAAEtDWOKMCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaUJNWlhRZ2JXVWdjbVZqSW4xOSIsInAiOiJhYmNkIn3xM7eaAAABDAAAAEuKgHnVCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJbTl1YzJsa1pYSWdkMmhsZEdobGNpSjlmUT09IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxciJ9x5QDjQAAARIAAABLVVBQNgs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlCMGFHbHpJR2x6SUdGamRIVmhiR3g1SW4xOSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3gifQrJe7sAAADwAAAAS8wYFywLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQm1aV0Z6SW4xOSIsInAiOiJhYmNkZWYifRuQJIUAAAElAAAAS0ZRNKALOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNkltbGliR1VnZEc4aWZYMD0iLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWjAxMiJ9vRFecQAAARMAAABLaDB5hgs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlCamIyMXdkWFJsSUdKNUlHaGhibVF1WEc1Y2JsUm9aU0o5ZlE9PSIsInAiOiJhYmNkZWZnaGlqa2xtIn3cMUznAAABAwAAAEsI0O4ECzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaUJ1ZFcxaVpYSWlmWDA9IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dSJ90OnMQgAAAQoAAABLBcCMdQs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlCdlppQmplV05zWlNKOWZRPT0iLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4In3io/iJAAABIAAAAEuOsbvQCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaUJwYm1SbGVDSjlmUT09IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSU1RVVldYIn0pN1e0AAABDAAAAEuKgHnVCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaUIwWlhKdGN5SjlmUT09IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDRCJ9ZeheYwAAAPoAAABLhqgPjQs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlCaGJHOXVaU0o5ZlE9PSIsInAiOiJhYmNkZWZnaGlqa2wifYovWoIAAAEQAAAASy+QA1YLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQm1iM0lpZlgwPSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTCJ9yy3m9QAAAQ8AAABLzSADBQs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlCVEluMTkiLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk8ifed74MkAAAEvAAAASwzhLAELOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNkl1S0NnZUtDZ2lERGx5QlRJbjE5IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzgifc3U87AAAAEbAAAAS1hAMkcLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNkl1S0NnZUtDZ2lERGx5SjlmUT09IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PIn06FnoBAAABJAAAAEt7MR0QCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaUJhNG9LQ0lHbHpJR1Z1YjNKdGIzVnpMaUJGWVdOb0luMTkiLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSCJ95tZp5QAAAPgAAABL/Ghc7Qs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlCd1lYSjBhWFJwYjI0aWZYMD0iLCJwIjoiYWJjZGVmIn2j5EvzAAABHAAAAEvqYO5XCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaUJ2WmlKOWZRPT0iLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWV1gifaQc4BwAAAEHAAAAS/1QSMQLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQWlmWDA9IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGRyJ9UriBMAAAARQAAABL2hCllgs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWpFeUlHZHBkbVZ6SW4xOSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTCJ9LZRlHAAAAPsAAABLu8gmPQs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlCaEluMTkiLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1In28Pk7GAAABEAAAAEsvkANWCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaUJqZVdOc1pTQjBlWEJsSW4xOSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0QifRo7+IEAAAEiAAAAS/Rx6LALOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpd2dZVzVrSUhSb1pYSmxJbjE5IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSU1RVViJ9qVN/4gAAASMAAABLyRHBAAs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlCaGNtVWdjQ0o5ZlE9PSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaMCJ9uVU0AgAAAPsAAABLu8gmPQs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlneE1pa2dQU0EzTnlKOWZRPT0iLCJwIjoiYWJjZGVmZ2hpIn1ucXVZAAABKgAAAEvEAaNxCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaUJ3WVhKMGFYUnBiMjV6SUc5bUluMTkiLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWiJ9uGxkzQAAAQIAAABLNbDHtAs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlBeE1pNGlmWDA9IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eCJ9n6IUHAAAARYAAABLoND29gs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWx4dUluMTkiLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWIn2UBlYIAAAA7gAAAEsTyD7PCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJbFJvWlNKOWZRPT0iLCJwIjoiYWJjZCJ9SAsxMgAAASkAAABLg6HZoQs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlCd2NtOWliR1Z0SW4xOSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaMDEyMzQ1NiJ9qH/jKgAAARkAAABLIoBhJws6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlCdGFXZG9kQ0o5ZlE9PSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRIn2HOKr1AAABIAAAAEuOsbvQCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaUJpWlNCMFpYTjBhVzVuSW4xOSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUIn1RpPVTAAABNgAAAEthEdnyCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaUIzYUdWMGFHVnlJRWtnY21WamIyZHVhWHBsSW4xOSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaMDEyMyJ9zmeenQAAAQsAAABLOKClxQs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlCMGFHbHpJR0Z6SUdOdmJYQjFkQ0o5ZlE9PSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcSJ9cx8bnwAAARYAAABLoND29gs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SW1GMGFXOXVZV3hzZVNCcGJtWWlmWDA9IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGIn1DVHsfAAABBwAAAEv9UEjECzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJbVZoYzJsaWJHVWdkMmwwYUc5MWRDSjlmUT09IiwicCI6ImFiY2RlZmdoaWprbG0ifXaf6tgAAAEHAAAAS/1QSMQLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQmpiMjF3ZFhSaGRHbHZibUZzSW4xOSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcSJ9GkWdyQAAARIAAABLVVBQNgs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlCMGIyOXNjeXdpZlgwPSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUoiffRjm+MAAADzAAAAS4u4bfwLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQjVaWFFpZlgwPSIsInAiOiJhYmNkZWZnaGkiff8Rit4AAAEZAAAASyKAYScLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQnBkQ0JsZUhCc2FXTnBkR3g1SW4xOSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISSJ9LEHRCAAAARAAAABLL5ADVgs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlCeVpYRjFaWE4wY3lKOWZRPT0iLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNEIn2Bl9bNAAAA9QAAAEsE+JhcCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaUJoSUdacGJtRnNJbjE5IiwicCI6ImFiY2RlZmcifbdZm4UAAAEfAAAAS63AlIcLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQjJaWEpwWm1sbFpDSjlmUT09IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSUyJ9rb0pGwAAAQMAAABLCNDuBAs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlCcGJuUmxaMlZ5SW4xOSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHUifU3MFYwAAAELAAAASzigpcULOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQmhibk4zWlhJZ1pHVnpjR2wwWlNKOWZRPT0iLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHEifZgN72EAAAEiAAAAS/Rx6LALOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQjBhR1VnWENJaWZYMD0iLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWiJ9UFBvmwAAARIAAABLVVBQNgs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SW5kcGRHaHZkWFFpZlgwPSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUoifdT7HJMAAAEYAAAASx/gSJcLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQjBiMjlzY3lKOWZRPT0iLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QIn2tgBTaAAABJAAAAEt7MR0QCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJbHdpSUdOdmJuTjBjbUZwYm5RaWZYMD0iLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVCJ94NgjugAAAO8AAABLLqgXfws6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWk0aWZYMD0iLCJwIjoiYWJjZGVmZ2hpIn15pMw/AAAA8gAAAEu22ERMCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaUJVYUdWelpTSjlmUT09IiwicCI6ImFiY2QifQBFZ/4AAAEdAAAAS9cAx+cLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQnRZWFJ5YVdObGN5SjlmUT09IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFEifYhX+h8AAAERAAAASxLwKuYLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQmpiM0p5WlhOd2IyNWtJbjE5IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREUifX/7EZsAAAEGAAAAS8AwYXQLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQjBieUFpZlgwPSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCIn3/x8EOAAABAgAAAEs1sMe0CzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJallpZlgwPSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCIn1lk8OOAAABPwAAAEtsAbuDCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaTF5WldkMWJHRnlJR0pwY0dGeWRHbDBaU0JuY21Gd2FITWdiMjRnSW4xOSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaMCJ9q/UNBgAAASIAAABL9HHosAs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWpFeUluMTkiLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWjAxMjM0NTY3In0jkR7TAAABBQAAAEuHkBukCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaXNpZlgwPSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFIn0BYEbeAAABBQAAAEuHkBukCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJakV5SUhabGNuUnBZMlZ6TENKOWZRPT0iLCJwIjoiYWJjZGVmZ2hpamtsbW5vIn10DjMRAAABIgAAAEv0ceiwCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaUIzYUdsamFDQnBjeUJwZEhObGJHWWlmWDA9IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU4ifTv7FFQAAAEqAAAAS8QBo3ELOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQmhJR1JsWlhCc2VTSjlmUT09IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzIn3zZExlAAABKgAAAEvEAaNxCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaUJ6ZEhWa2FXVmtJbjE5IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2NyJ9LxcZYQAAARIAAABLVVBQNgs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlCaWRYUWlmWDA9IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU4ifbBZjs8AAAEnAAAASzyRZ8ALOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQmthV1ptYVdOMWJIUWlmWDA9IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowIn3BMBM+AAABBwAAAEv9UEjECzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaUJ3Y205aWJHVnRMaUo5ZlE9PSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHUifYJrnIYAAAD6AAAAS4aoD40LOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQkhhWFpsYmlKOWZRPT0iLCJwIjoiYWJjZGVmZ2hpamtsIn1uGnhsAAABLgAAAEsxgQWxCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaUIwYUdVZ2JXRnVkV0ZzSW4xOSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaMDEyMzQ1NjcifSTKfqYAAAErAAAAS/lhisELOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQmpiMjF3ZFhSaGRHbHZiaUo5ZlE9PSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaMCJ99ko5hgAAAScAAABLPJFnwAs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlCeVpYRjFhWEpsYldWdWRDSjlmUT09IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSU1RVVlcifb4aUYgAAAEzAAAAS6nxVoILOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpd2dTU0J6ZFhOd1pXTjBJSFJvWlNKOWZRPT0iLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWjAxMjM0In0Q7b3CAAABQwAAAEtQI7ZNCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaUJoYm5OM1pYSWdiV2xuYUhRZ1ltVWdjM1Z5Y0hKcGMybHVaMng1SW4xOSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaMDEyMzQifWFa08YAAAERAAAASxLwKuYLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQnpiV0ZzYkNCdmNpSjlmUT09IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREUifT7NquUAAAEUAAAAS9oQpZYLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQjBhR1Z5WlNKOWZRPT0iLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0wifTxw3/8AAAEiAAAAS/Rx6LALOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpZHpJbjE5IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2NyJ9NYO0kgAAAQQAAABLuvAyFAs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlCaElITjBjblZqZEhWeVlXd2lmWDA9IiwicCI6ImFiY2RlZmdoaWprbG1uIn2kN8KdAAABDgAAAEvwQCq1CzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaUJwYm5OcFoyaDBJbjE5IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGIn2f/5PpAAABIAAAAEuOsbvQCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaUJKSjIwZ2JXbHpjMmx1Wnk0aWZYMD0iLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QIn3tSFyXAAAA9wAAAEt+OMs8CzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaUFpZlgwPSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcSJ9VVGgbwAAAPgAAABL/Ghc7Qs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWpZc0luMTkiLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyIn20cfp8AAABJQAAAEtGUTSgCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaUIwYUdVaWZYMD0iLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWjAxMjM0NTYifRCqlSwAAAEJAAAAS0Jg9qULOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQmpiMjF3ZFhSaGRHbHZibUZzSW4xOSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzIn0FgfK1AAABGAAAAEsf4EiXCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaUJpZFhKa1pXNGlmWDA9IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUCJ9Ybky1gAAAPEAAABL8Xg+nAs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlCaVpXTnZiV1Z6SW4xOSIsInAiOiJhYmMiffWX5ksAAAE0AAAASxvRipILOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQndjbTlvYVdKcGRHbDJaU0JsZG1WdUluMTkiLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWjAxMjM0NSJ9J+RnpQAAASQAAABLezEdEAs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlCbWIzSWlmWDA9IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDUifQjLPeoAAAEvAAAASwzhLAELOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQnBibVJwZG1sa2RXRnNJbjE5IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2NzgiffjuR5MAAAEiAAAAS/Rx6LALOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQkNkWEp1YzJsa1pTQnpkVzBpZlgwPSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUiJ9g2zmygAAASQAAABLezEdEAs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlCMFpYSnRjeUo5ZlE9PSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaMDEifb0Aw+YAAAD1AAAASwT4mFwLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpNGlmWDA9IiwicCI6ImFiY2RlZmdoaWprbG1ubyJ9nQ1beAAAAP4AAABLcyipTQs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWx4dVhHNUpJbjE5IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0In2s0XGaAAAA/AAAAEsJ6PotCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaWR0SW4xOSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2In3TOon/AAAA/wAAAEtOSID9CzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaUJ5WldOdloyNGlmWDA9IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxIn1trOx0AAABLgAAAEsxgQWxCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJbWw2YVc1bklIUm9hWE1pZlgwPSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaMDEyMzQ1Njcifc6PoH0AAAEOAAAAS/BAKrULOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQmxlR05sSW4xOSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUoifY7rRlYAAAEMAAAAS4qAedULOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNkltVmtjeUIzYUdGMEluMTkiLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNEIn0QrvFSAAABAgAAAEs1sMe0CzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaWR6SW4xOSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCIn0r6vdKAAABAAAAAEtPcJTUCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaUJ3Y21GamRHbGpZV3dpZlgwPSIsInAiOiJhYmNkZWZnaGlqa2xtbiJ9DPkY1gAAAPEAAABL8Xg+nAs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlCMGJ5SjlmUT09IiwicCI6ImFiY2RlZmcifZRJYmcAAAEnAAAASzyRZ8ALOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQmpiMjF3ZFhSbElHMWhiblZoYkd4NUluMTkiLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTIn0rRmmfAAABAAAAAEtPcJTUCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaUIzYVhSb2IzVjBJbjE5IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxciJ9lMAXkQAAAR4AAABLkKC9Nws6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlCemFXZHVhV1pwWTJGdWRDSjlmUT09IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU4ifVCIFPoAAAFUAAAAS4Lj/d8LOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQmpiMjF3ZFhSaGRHbHZibUZzSUhKbGMyOTFjbU5sY3k0Z1ZHaGxJSEJ5YjJKc1pXMGdjMlZsYlhNaWZYMD0iLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWjAxIn1nsentAAAA9AAAAEs5mLHsCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaUIwYnlCa1pXMWhibVFpZlgwPSIsInAiOiJhYiJ9NNbX+gAAAQUAAABLh5AbpAs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlCaElITndaV05wWm1saklHNTFiV1Z5YVdOaGJDSjlmUT09IiwicCI6ImFiYyJ9N3hTngAAASQAAABLezEdEAs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlCaGJuTjNaWElzSW4xOSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaMDEifRQN7ZEAAAEEAAAAS7rwMhQLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQmlkWFFpZlgwPSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5eiJ9Qu/vYgAAAPgAAABL/Ghc7Qs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlCMGFHVWdZV04wZFdGc0luMTkiLCJwIjoiYWJjZGVmIn1175gPAAABDAAAAEuKgHnVCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaUJqWVd4amRXeGhkR2x2YmlKOWZRPT0iLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1diJ9yWKUGAAAASsAAABL+WGKwQs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlCeVpYRjFhWEpsY3lKOWZRPT0iLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWjAxMjM0In1dzcRfAAAA9QAAAEsE+JhcCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaUJ6ZVhOMFpXMWhkR2xqSW4xOSIsInAiOiJhYmMifVTi3LYAAAEaAAAAS2UgG/cLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQmxiblZ0WlhKaGRHbHZiaUIwYUdGMEluMTkiLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUYifcTubS4AAAEdAAAAS9cAx+cLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpZHpJR0psZVc5dVpDSjlmUT09IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFEifUJ+CS8AAAEeAAAAS5CgvTcLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQnlaV0Z6YjI1aFlteGxJbjE5IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSIn0KcZ3AAAABAQAAAEtyEL1kCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaUJvWVc1a0luMTkiLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dncifQSBs4kAAAEWAAAAS6DQ9vYLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQmpZV3hqZFd4aGRHbHZiaTRpZlgwPSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRiJ9ePKV9gAAAQMAAABLCNDuBAs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlCSlppSjlmUT09IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHkifWo7KS8AAAEZAAAASyKAYScLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQkpJR2hoWkNKOWZRPT0iLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUSJ9tGuumQAAAQoAAABLBcCMdQs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlCMGJ5QndjbTkyYVdSbEluMTkiLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4In3L5mdvAAABCAAAAEt/AN8VCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaUJoSW4xOSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdIIn3ZHTwAAAABHgAAAEuQoL03CzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaUJ5WlhOd2IyNXpaU0o5ZlE9PSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUiJ9a4zBOQAAAQMAAABLCNDuBAs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWl3Z1NTZGtJRzVsWldRaWZYMD0iLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHEifY5DincAAAEAAAAAS09wlNQLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQjBieUJsYVhSb1pYSWlmWDA9IiwicCI6ImFiY2RlZmdoaWprbG1uIn3so91WAAABJQAAAEtGUTSgCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaUJoWTJ0dWIzZHNaV1JuWlNKOWZRPT0iLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFUifQIQJRcAAAEKAAAASwXAjHULOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQjBhR1VnYkdsdGFYUmhkR2x2YmlKOWZRPT0iLCJwIjoiYWJjZGVmZ2hpamtsbW5vcCJ9FSnd4wAAAQsAAABLOKClxQs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlCdmNpQnRZV3RsSW4xOSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQyJ9lf39LwAAAS4AAABLMYEFsQs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlCaGJpQmxaSFZqWVhSbFpDQm5kV1Z6Y3lCaVlYTmxaQ0J2YmlCd1lYUjBaWEp1Y3lKOWZRPT0iLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4In146T9RAAABFQAAAEvncIwmCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaUJwYmlCemJXRnNiR1Z5SW4xOSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISSJ9fwjIBgAAAQoAAABLBcCMdQs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SWlCallYTmxjeXdpZlgwPSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCIn3srmUuAAAA+wAAAEu7yCY9CzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaUIwYUc5MVoyZ2lmWDA9IiwicCI6ImFiY2RlZmdoaWprbG0ifSRjMckAAAEDAAAASwjQ7gQLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQnVaV2wwYUdWeUluMTkiLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1In3TpEIDAAABIwAAAEvJEcEACzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaUJtWldWc2N5SjlmUT09IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowIn3qunuiAAABBAAAAEu68DIUCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR2hwYm10cGJtZGZaR1ZzZEdFaUxDSjBhR2x1YTJsdVp5STZJaUJ6WVhScGMyWWlmWDA9IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXYifU2NeIEAAAECAAAASzWwx7QLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklubHBibWNnWjJsMlpXNGlmWDA9IiwicCI6ImFiY2RlZmdoaWprbG1ub3AifTos4ycAAAEyAAAAS5SRfzILOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpQjBhR1VnY0hKdllteGxiU0o5ZlE9PSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaMDEyMzQ1NjcifZb2QfQAAAD7AAAAS7vIJj0LOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpvd0xDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHaHBibXRwYm1kZlpHVnNkR0VpTENKMGFHbHVhMmx1WnlJNklpZHpJSE53WldOcFppSjlmUT09IiwicCI6ImFiY2RlZmdoaSJ9AcVwXwAAAQcAAABL/VBIxAs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam93TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdocGJtdHBibWRmWkdWc2RHRWlMQ0owYUdsdWEybHVaeUk2SW1samFYUjVMaUo5ZlE9PSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5In0RJQbiAAAZvgAAAEsPAqJXCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3dMQ0prWld4MFlTSTZleUowZVhCbElqb2ljMmxuYm1GMGRYSmxYMlJsYkhSaElpd2ljMmxuYm1GMGRYSmxJam9pUlhSVllrTnVORWxGYUVGQ1IwRkpjVkZLWkU1VE9HTnhVakkxTlhKSWJHVnBWaTlKU0RKS1JWZzRLMGt5TUVaRlVqZHRNblYwTkc5WlEwaFdUWHBOZEdobWJsVk9RV3RaU0doSVpWbDJVMU5vZDBWR00wdFVURmN3TTNGMGIxb3lVVTlTY25kemMzbEhiVTV6V1ZoV2ExcFRNWHBpTWpWMVdsaFJkRTVETURGTVZFbDNUV3BWZDA5VVNUVlBRVUpEUTBoU2IyRlhOWEpoVnpWdVYyZDNkMDVVWjNsT2FsRjVUVlJyTVU5RVkxTkVTRzltTDNGWFZUaFdVV1JKVkRKT2QyaHZUVWQyT0d4eWFHWnplRmhMT0dweFkzZEpha0ZyVDJReFFXaE5XV3AwZDAxSFJ6RmtOQ3RhWWs0eUsySk5TVWw2Y0hVeloyVTRWVXA0YUZkSFRrNWFaa1p5ZWxsVlNGRktNbkZZYjI5b0szaEdkVGRGY1doQ2NucFlVa1Z0TkVwRFkzQkRVaTltVG1OSFowdzNSbGwwVkU5cGVtUmFjVEJQUnl0MWVFVXhRM3ByU1hWcU9FbHlVM0F2U0ZGd04zSjFaV1YwZDJjeGVtcDBUemhYY1ROMGVVTkZibmxIYlc5VFVYWlZXQzl4TDFwQ2VqaHJSbTVOS3pNM1NHWnZjRmxJWm5oRk9UaHJLelE1UzA0M1VsRjBXblZRWnpCRlpGSkhka3hvWkN0cE9FbzRXR2N3TVZOTVYxRnBVbTB6U1dkaFkyOW5RVEZRWlVORE9WVm1NM1pKS3pOUVEzZEdjbFZZWVZsdVZrTXJWV3MzUWxkSFoxUkJVV1FyYlRKaU5FUjNRbU40YzFoWWJuQTBWbTlGWjI1bVFtcHFRV05HVVZKS1UxQk5hbU16TlZGaU1UbEdRMlphVWtwTEsyRlNTV3hqUjJ0alpVc3lUVmQ1TDI1dldtWjBibEZITkZGbFdsa3JTMlpxWjJOclYyRk5kRFpSYUZOWGRWVmFjSFZPV1V3NVNEQkZRbXhUV0hscGNDOURSbkpqVVZoUkt6SXlaRTVRTXl0dGRtdENSa3hYVnpKd1QwWmxRMHhFZDJwcVQyMVRWSEJVV0d4amRVcE5kR3hzUTBJMFRqRm5Remw1YldoUVdrVnFWMjlVWWpsVldIaFNZM00wZG5CelNtRjNaa2QyUVhOQ1VFMVdlVVUxY0RCWVRGaDVTbVprUVc5bVRWTkpWelZQYlVrNWRrdEZhMkowTTBVNGNEZzROSEp2VTNKb1ZFVndSMUkwYWpkR1pHeG5NMlJHVjAxSEwwOHhSRTlKV1VWTU9WRmxXbnBYVm14TGFrODVWbVUxYkZKS1luaHVTVk52Tm1WVGIxcE1lR2xyVDFWbU4zSTFRMHd6TWpZMk9YRlVVV3R3VkRRNGJ6SXdTM2t2YUZacmNtUTVLM1ZPUldGbmVUazBXbWxhUzFGSWFIb3ZOVVl2YjIxVmQzWkxjbGhwWTJOT1RFcHNlRzEyVnpGcE4wNHZNakJPYm1OcFpXeDBkVGc1TUdvek56SXJVazlzVlZoSFUzVmxTV3hFWVZkb2FrWjBSMDlUTWxCbkwwcHFlVzVVTm05S1ZVdHViR1JOWTBaUU1GTnNMM0ZMWWpkTVMyNUxhMHd6TUdaMmRtUm9aME5uYm5Sd1ZUZGxiMFpPYmxkSlVuVjNja3BJUWxrNVNXYzNZVzV5ZGtGNU9HOTJWVEl5VmtKQ1RERXhZVm96Wmt4WE9WQkpRa1oxUWtFclJtaGlTRWd2Y0dWSWJGb3hVbFZuZWswM04zTmtVRTFOWjBsMGFuSkJOVVYxYVdSemRFWjVibk4zYjJwcVEwYzVjRXMxVW5jNUwxcHBNVTE1ZVRnMlpGQXpaVVE1Y2sxcFNHeDVObk4yYjFGblZtOTFUSGROYnl0TGFIZFNOMlozYlRBMWFsTkhTV1ZSTXpSalRuVnJTSFpWZUhSdVEzaFJlVGgxVm5ZNGIyUXpOekJsZDNsR2FtbEpTWFJvTUhkMFEwTlpTbWxvTmtOcFYxSTBMMnhNZUdsYVFWQllWbkZXTVRNME1sWnlkM2g1VGxGU2FEa3hObUZoVkZKWU1ucFBabHBuWjB4WGNuVkJRbnBwTWtkRWJVeHBTbGxWU1dOMGJIaENNMlJFWWpVek4zaE5TVWw0ZGtaRGRraEtaRFZyZDJ0SWQxRldNM1k1YlU4eVFsUk9iRVJIYVRnd1kyNDNUblpDVUZoV1EzTlZiRGhDWVVScWRYUnplRFZFZVhCd1V6bGFRMWxMYUVrMVl6Z3dNRE5YVnpsbFlrMHZjRnA0YXpSeFYyRkJSbUoyYlRKMFl6TnBUM050Y1Rsd1p6SkRlbE5XYkRBME1rNHdWSEZSWmpsYVpVczVaamxpU1c5c2JuZDBUVmQyVWxONmVIRTRUR3c0TUdFNVJITlNVUzkzY0dSYVpXSlRhVEphVkZOeFoya3lWSEJ3YWxkWU5Dc3dVa3hCUW5sV2NrcExhMDR3Y1RkTFExYzBlV0l3TTBoaFZTdEhjamR6WkM5ckx5OW1ZakJaTjFaT2JsTldiRGxMVFhoM1REUmphbFphSzNsWE1IQnBibkIwWXpGMmVWZHhibTlYV2pWTVlUQm1UMk4wT1hOV1dqTm9ZbWhxYm5OdlVVMHhiR0pKYkU5WWVYQk9aV3BQUlVZMFUzbzJVRkJCUXpVclVVUnNia3B6ZUhjd2VubFBLMlZ2V2psUWFrUXpZbUZQTVU5UVNGQnRSRTQ1UmpGelpUbHdjbEY0ZDFnME5tcFNaRTlYZG1aS1pGbDBjRFk0UkhKVlExbzBaSEowVTJONlpuRTNiMWxWY0RaWlVFaGxLM0V6TUdSVlFtbFljM05GT1VGRU1Va3pjRmRGWWsxd05raHFNbGxqUkVKRGVGbzVNM3BLVG5aUU4yNW1VRkI0ZG05a1NWVlNVM1I0Y1VWRGMxQldVbkptU1U1SE1IcGtWRWxwZUd0cE9FeERVVUpRTURCRmVHd3dabGd3VldWTmRsbG1kelZ3TUhoTlFWb3JPRzVFT1hWNU1rdFNRVGRIUzNsU1ZFMXNVbFI1YVZCS09FZEJTSGRCVG5STFJ6VkxhRFZuTW1KcFpXVjRSamxHU25STU5uQlpkVVZaZEhkTFdHdEljbVJhTVVSTlkydERXVzVoVDNWdGFIazVRVzU1WkdsTk1FbDBUMDFPYkdKTmRsaFhSR2xpYlhGd1RHRlBRbEpSVERBNFJVcDVURmxuVUVFclRVNHpjSEY0UnpKclRrVXlkMnBoYnpFMFlVNWlkM0JDVVZWWFpESkVMMHBaVlhJNVVHcFNjMmxxTkVKRllXZERVM0oyYUVFeVVGbHdRMDV2SzNveFUwcGFVMVVyVTFwdWJWcFdNemxEWTBoUGNrVjNXVkpETnpOdWRIQTFjbGMyVjFsU1EwVktRbGx6TnpWaFJYQmxlbFExZFVneFpWTnNOazlwUlc1cmVDdGFja3Q2ZERoWVYyVlRXR2s0TkVWa2FEbHpiM1ZEVUdjMlRsSkpaRlpNUTFScWRtRlJSRzlYUm5aUVZEazNiM2RhUlZCc1ZrVk9kVUo0VlZNeE1FRktUelJQVUZadllWUmtSR1pIVEd4MlRWaFRkRFZJVnpabFdrZHBZazVQT1N0YWF6TkhhbkkxUkRORGNrYzFlamR3V0RVMFVEazRVWFp0WVZWclRWaFpPRUpoUTFkYUwyMXhSVzlFVGxkTE55OHpNMjAzYVc5cVIxYzJZaTlGUjAxdVFUVldObmRyUjBWWWFVSXlkakZ6VkVveWN6TXJlV0UyT1ZaTE5UUktabXhoY1ZNNU1rRnBXWFpWTWpaaVYwRlNURWRzYmtSdk5rWTRjRmxRWTBOWk9GTXlXbkJOZUhkcGRUWlZLek5ETDBOR1dVSlRjRzVYUTB0RFFuZzJhWFpWV0dKNU1GSTBaV0o1TlROQlZYcDBjelYyU0hSRlYwZFdjbWdyTjIxS2RVVkNRVVY1WkM5cmFVTTRUVWRhV1RSTVdTOUxPRWxIUXpGMVdtSkdSVEZ2T1ZWblZHaENjVlZuVW5NM1lYWmxVRmM1YjJsUU4zTkpia3hDVlc5bFdtSmtUeTlDV0hsNVJVTk1lWGcwT0RRd1JYYzVXV1Y1U1ZCSWNrSnJkRUpSVW5SbmJtSkhaRU5vWVdaU1NGWmFXa1oxVkM5d1VURXJTbVpOWmpGbmQwRkhkVmRWYUVKak9VbFBaV28yZUVwa1VEQXpTVVpuZURCMWFHTnNXbkZFY25nM2RrVjFhMk5sT1c1c1NtbFJiRmxDWnpCM09FOTVNMXBIUWs5eFUxWnZVbEZ0Y1RsTlJsQndUMWh3U2pKWGNsZ3dWM0pOUTJ4T1dIRTVVM05DWTNFM1RXWlZibU5HWWxsNWEyZFVka3hwTkdKM2VYRlJSRk5oU1M5RWJWaGxiMVZ6SzJGM1REUXJaRzA0YjJRd2VXSTRMMGcxTkRWNE9VSkZkRmRNVDBkdWFYbFZjMGRHUmxOVFRDdDJiR2xRTHpnMmRHNW9VVzEyVVZaaVowaEdhRmRKZFVoR2JraHdORzk0VHpjemQyNVpVVGRMVERacFVGZFRPVUY2VkhOQmRscHlTbFpRVmxkSWMyeDJjR3hETkU4NWIwMXhlREJDVDNWbk1FRXJVMWN2Y1U4MWFVTjFTU3M1YlhsSU1UWmhkVmRSYlZaWFNraFJWSGgzTkZGdk9UVm5TVEpCTkhaaVZIazBaelpPU1dodGFUVjJOSGx5YVhKeGNsQkZTa1ZRUlROMFpFdE5ZVGhGVnpab2J6TTFXVGxPVUZGdVFucEJSSGMxU25nMGJsVllZMWxUTkhWV2ExSXlhRTFZU1dWT1dVUlFRVXBDUjNkNk5Fa3ZlbVZFYzFGemFraDJNM2RtYmpWNGFsbFVMMmhDU0RoemVtUndhRTgxTTBSVVRERnBVMUJYZEVWd0swSm5kekZRZDBadWJHcEVjV3RZYzA1Wk9EaG5hRWR3Y2xCUlNXUTBXWE5aVTBKaVZWRmFXamRoVlVnNGMwMDFhVkJwYVZoYVoyMVRSMWxIYlZoNGQyNVZWV3gyWm14dk1EUjFRMkpCTWt0SWJqQnNiV05CTTBWWVYzRlVhVFV3TmxSQlptRnpOa2xyTldwbVZHNVZVRUkzZWxKSWJETTNPV3ROZFhKdGNIRkZSMFV5ZDB0SFp6Y3JPV0V6ZEU1UFQwaElWRzlDU0c1WlFqZDVjWE5EU2xvNVNFNVdWMHBsVGpsTldWTnZRamhUYTBWNlUzTlRUMjVNUW5FMlVXWk1kRm95YTNOSWFscEZVVTFEVDFNMVNHRmFka2RhZHpGbU9VbHBlVXhMYmtaU1Rtd3dWVVVyZGtJMlpHWnhRV05hUjFJMFF6aHdSRmxTZFVKcU9HaFhaalIyYjJKbVVpdHViSFJrTlZGR09VRk5PR0ZKZUhrek1WZzRSams0TXlzelUxaFhRVlpJYVdFMGRWVkpkVzEwY2s4eE4xQlFVRGx4YlcxV00wcFZTVVZYVjNwTE5GVlhkWFEzWlNzelFucG1Ra1ZUUlhaclozQmhOMVZKT0ZaR1lrcGxUMUp6Y210SGJHdFNhbE40UzFSUUswYzRXazEyZG1jMGEzazRXazlrVlRab1NWSlVTa3ROY2tkMlltRnVMemhXVkhJclNsQXdSR1E0ZEU1c1JWUmhka1F3VjA1T1lYTk5Ta295UXpaMFdVeDBlVWwwVjB4WFR5OHJRbE5EUTJ4cVRqWldMM2hCUkdKUVJYSm5hbFJzT0d0bFFVaHZhRE5zZDNsTmIxWTVRMmRMUVRCNVVVeGpUSEp4WjA1VWNXaGpWbk4wTUdZdkszWjVUeTgwYjNWSVZHZGxabkU0UzNOSFpYRmxRMVE1VVVFeGJGTjBZV1ZKUWk5YVIzWTFUM2c1T1VzeFZ6RXhWbUpxV25vNU5rWkxiamRuSzNCaWFVTjVXVGxzTTA1WU4weEhWemxNUmpGMVFrRkJiVk13VDBJcmIwSXlaMVpSZVhKbVpYcHNVak12Vm5SdldXUXZVVUozYm13eUsyaHliVUZaZUVSbUwyZFFSMjFsYW5aeFVqZzNTVzV3WVc5Qk0xQTBTWEZ1TVdkclptOVFRVVI0VGt4bk5VaEdiM1J0ZG5OM2JYWlJiM0JCUlhWb2RYSnFXazlVVDJOdVVYVTNhVXhJUnpNMlkzUm1kVnB2UTFoSE9UbFViRVJ1U0hOb1JuaHJVek41YTBkeGRWcG1lR2xHZVd0RFNuWTNNRTAxY0ZKT2JISXhhRGw1U0RjeWJFeFlVMmRKZDJaNWNUaG9iVmRCVUdRMFVqVlZZV29yVDBkS1ptSk5iVEpRZWpWaVFXUnpTakpwYmtaWlFtNUNka3RpYUd4VVpEWTBPRm80Tkdndk9IQndjMEZwZUhCSVVHZFFPVEZuZW5WbGJGQk5RMGRvU3pVek5uUmpPVmhIUW5wSmVrVkpRazl2V1hWMlVXaG1VREl4TTJ4RE5rczFkMnMxTVhCeFUzZEpjbWhKYWxwMFZrSldja3BSYzBkdk5raElVbUkzU0ROVlFtbG1kVVJ6TjNOSGJ6VjBXVTFuTW0wd2RtNHJLMWc0YUdwUmVsVk5SRWhRY0doTlFVaEJPVGhTYkZaVGRHRjBhRlZrVWswNUswaGxRbkp6VEVOaU1WaENWVnBTWWpsVlEyeFJWemswYTFVMVdEWXhZVUl2VkROTWJHTndWVlpMWWtGUFJsWjRMMlJHVW01M2FGVmxORmRETUM5d1pFeDRTMlJKYkZGdFkxcDBXSE41TjA5Mk1ITmFjbEJYZUhkeVpqTTRXU3RxZUVKNFV6bGFVbmMwUzJkc01uVnRVMmt5T1VWWVEyTm9VbWxJVFhCTFJVWndlazF5VFc1SlZWUTVibk5OY1ZaQ1pqSldVRUkyYW5CNk1GZGtLMmxyWnpaRVZsQTBZMFpuUkU5bEwycHNZazlPTDJaelQwOXJkM2hrT1VGdldrRkxlbTQwTjA5TmMxVXZVR3htZEZOME1IUkpRa1Z6YUZkcFRVc3JWVE01WVhWUFlYVk1NVGxZTWxSWGJGb3JUWEp1YXpKak9YQjFiRFV3TW1KeWNVc3JWakV4Tnk5RFoyNVpTMnQ0UTJSUVEwaEdjSEp6T1UxeGFHUlBZWEp1VVhwMGRFVmtXbFZ3VlZKU2N6SkNSa0Y0YjJWeVNrVmFWWGMzV0dSTFQxTXllVmxxVXpWemRuZE1RbEpMVEZWaGRtVm9ZVWRpYkRCNmNDdG9LMWN2S3pKMEwxaDJSMlJ6Vm5wbGVWWlVhME5pTW5GT1lUWlJNVEU0Y2taSlVFeE1hVVlyWkRSU05WTkxiamxOZEVoNmVIRjBPRkZLVjNkVk9FaDFVbmw1UWtWR2RUaHNNRU50YVdGMFZ6bHZWRXN2TlZBdlJqRXJiMjFqVmt0VmVXRnlkbXhtU1VaNmRIVmhaRVE0TVV4a05qUXhkRmRoYWxsNE0xWlFZMU54VWxKdmFFbE9lV3cyVmxOMmIwUmhjMkkxUjFsWFdHaFRkRGRWS3pkVmF6TkJSblpSYTBwTGF6VkxTV1ZQUVhRMFl6aHFkM1JaY0drME1VWmlTR0pOYmtKS01tUlRNRE5XWldaa1prRm1NUzg1YkRkTlJuTldPVXgxWkhNeFFqVmFXWFlyTkRWb2JFMVJRV1JOVnpKbUwyY3hURGx4TTNkWVRtaDBSMlpTTDJKMFEyTm1lVlpEU2pacVpYQmtkV05sU0doSWJVOW5PRzUxYmxsWE5XUjFabTlLYXpSaE4ydEJPRWxuYTFSaGFVbzBjSHBTTVRWVGFFUnVhRzFQVTNjeGRrOHdkVU5OUXpaSlUwRllaRlZWTVROV09IaHZSRTlTV1haVVlXMXJkMHcxUWpaM1VGQllkQzkzVTFaVlIxSjFVV2R0VGxKUFIzWXhiRm95ZWtjdllVZHlTRmh0UlhGcWNDOXlNVmREYjFvdlZucDFTRXczTTNOcFVHaHFPVGR2WjFCNFlXVndTelozY2xSRWVrRmxjbGxWWVVZMVN5dHVOVU5OYW5jd2REaGlkQ3RCTUc1UFNGSkxWMHQ1UmpWd1ExVjBhR1ZyYUdZNFZHcDJOR0V5TTJod1ZFVlVNM0J0TWxRMWRFOVhaVXBPT0ZGUlR6bFVibVp1Y2pVdldUQlNWMjFOVDNKdmJ5dHZUVGxGUjBGcWEyWlpaVzF6TTNFd2FYWTVNWGhSVEROSU1GTXJWVlVyTmxJMVdsQkRTR0ZQZVVocGNHNXpVM0EwTURORFlVMHpjRnAxUkZWTU5pdHBSRElyZEc1WWRVWkNVVXBGTm5oSlIyTnRUWE0wUW1kQ0luMTkiLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWjAxMjMifQTFtS0AAAC5AAAAS5n7LRQLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOXpkRzl3SWl3aWFXNWtaWGdpT2pCOSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2dyJ9bjQtOAAAAP8AAABLTkiA/Qs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5emRHRnlkQ0lzSW1sdVpHVjRJam94TENKamIyNTBaVzUwWDJKc2IyTnJJanA3SW5SNWNHVWlPaUowWlhoMElpd2lkR1Y0ZENJNklpSjlmUT09IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGRyJ9+BsI6gAAARcAAABLnbDfRgs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam94TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdWNGRGOWtaV3gwWVNJc0luUmxlSFFpT2lKSkluMTkiLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWjAxMjM0NTY3OCJ9/ut4UgAAAPcAAABLfjjLPAs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam94TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdWNGRGOWtaV3gwWVNJc0luUmxlSFFpT2lJZ2JtVmxaQ0IwYnlCaVpTSjlmUT09IiwicCI6ImFiY2RlZmdoaWprbG0ifQJkde0AAAEJAAAAS0Jg9qULOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpveExDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHVjRkRjlrWld4MFlTSXNJblJsZUhRaU9pSWdaR2x5WldOMEluMTkiLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNIn1h0Ku6AAABFgAAAEug0Pb2CzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3hMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR1Y0ZEY5a1pXeDBZU0lzSW5SbGVIUWlPaUlnZDJsMGFDQjViM1VpZlgwPSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUVVYifev9OCoAAAEjAAAAS8kRwQALOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpveExDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHVjRkRjlrWld4MFlTSXNJblJsZUhRaU9pSTZJR052YlhCMWRHbHVaeUo5ZlE9PSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaMDEyMzQifc/9qncAAADwAAAAS8wYFywLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpveExDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHVjRkRjlrWld4MFlTSXNJblJsZUhRaU9pSWdkR2hsSW4xOSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXIifWfNpTUAAAD+AAAAS3MoqU0LOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpveExDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHVjRkRjlrWld4MFlTSXNJblJsZUhRaU9pSWdZMjl0Y0d4bGRHVWlmWDA9IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eCJ9aCxvIwAAAREAAABLEvAq5gs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam94TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdWNGRGOWtaV3gwWVNJc0luUmxlSFFpT2lJZ1FuVnlibk5wWkdVZ2MzVnRJR1p2Y2lBeE1zT1hJbjE5IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QSJ9c7fvBwAAARYAAABLoND29gs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam94TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdWNGRGOWtaV3gwWVNJc0luUmxlSFFpT2lJeE1pQmlhVzVoY25rZ2JXRjBjbWxqWlhNZ2QybDBhQ0J5YjNjaWZYMD0iLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4In2zmgshAAABOQAAAEvjQU4jCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3hMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR1Y0ZEY5a1pXeDBZU0lzSW5SbGVIUWlPaUlnWVc1a0lHTnZiSFZ0YmlCemRXMXpJR1Z4ZFdGc0lIUnZJRFlpZlgwPSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaMDEyMzQ1NiJ9DlAlygAAAPMAAABLi7ht/As6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam94TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdWNGRGOWtaV3gwWVNJc0luUmxlSFFpT2lJc0luMTkiLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eSJ9etG3yQAAAOYAAABLI7h1Dgs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam94TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdWNGRGOWtaV3gwWVNJc0luUmxlSFFpT2lJZ2RXNWtaWElpZlgwPSIsInAiOiJhYmNkIn2d1HyyAAABCgAAAEsFwIx1CzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3hMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR1Y0ZEY5a1pXeDBZU0lzSW5SbGVIUWlPaUlnZEdobElHRmpkR2x2YmlKOWZRPT0iLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUYifekl9dAAAADyAAAAS7bYREwLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpveExDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHVjRkRjlrWld4MFlTSXNJblJsZUhRaU9pSWdiMllnS0NKOWZRPT0iLCJwIjoiYWJjZGVmZ2hpamtsbW5vcCJ9M7xWuwAAAREAAABLEvAq5gs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam94TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdWNGRGOWtaV3gwWVNJc0luUmxlSFFpT2lKVDRvS0I0b0tDSU1PWElGTWlmWDA9IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTSJ97SiNDwAAAR0AAABL1wDH5ws6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam94TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdWNGRGOWtaV3gwWVNJc0luUmxlSFFpT2lMaWdvSGlnb0lwSUNKOWZRPT0iLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWjAxMiJ9l8keUAAAAP0AAABLNIjTnQs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam94TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdWNGRGOWtaV3gwWVNJc0luUmxlSFFpT2lMaWk0b2dJbjE5IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREUifYzNPWYAAAEMAAAAS4qAedULOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpveExDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHVjRkRjlrWld4MFlTSXNJblJsZUhRaU9pTGloS1RpZ29Jc0luMTkiLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QIn3XoaUcAAABBAAAAEu68DIUCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3hMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR1Y0ZEY5a1pXeDBZU0lzSW5SbGVIUWlPaUlnYVhNZ2JtOTBJbjE5IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0gifeQrURMAAADwAAAAS8wYFywLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpveExDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHVjRkRjlrWld4MFlTSXNJblJsZUhRaU9pSWdabVZoYzJsaWJHVWdkRzhpZlgwPSIsInAiOiJhYmNkZWYifdrgxMsAAADtAAAAS1RoRB8LOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpveExDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHVjRkRjlrWld4MFlTSXNJblJsZUhRaU9pSWdaRzhnWlhoaFkzUnNlU0o5ZlE9PSIsInAiOiJhYmMife9yIakAAAEnAAAASzyRZ8ALOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpveExDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHVjRkRjlrWld4MFlTSXNJblJsZUhRaU9pSWdZbmtnYUdGdVpDQjNhWFJvYjNWMEluMTkiLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWjAxMjM0In2CNWu9AAAA+AAAAEv8aFztCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3hMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR1Y0ZEY5a1pXeDBZU0lzSW5SbGVIUWlPaUlnWTI5dGNIVjBZWFJwYjI1aGJDSjlmUT09IiwicCI6ImFiY2RlZmdoaWoifT0+NGkAAAE+AAAAS1FhkjMLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpveExDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHVjRkRjlrWld4MFlTSXNJblJsZUhRaU9pSWdkRzl2YkhNdVhHNWNibFJvWlNCallXeGpkV3hoZEdsdmJpQjNiM1ZzWkNKOWZRPT0iLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWjAxMjMifalUBw8AAAEZAAAASyKAYScLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpveExDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHVjRkRjlrWld4MFlTSXNJblJsZUhRaU9pSWdjbVZ4ZFdseVpTSjlmUT09IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWSJ9vvaQ+AAAARsAAABLWEAyRws6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam94TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdWNGRGOWtaV3gwWVNJc0luUmxlSFFpT2lJNlhHNHRJRVZ1SW4xOSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaMDEyMzQifdQaqKYAAAEeAAAAS5CgvTcLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpveExDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHVjRkRjlrWld4MFlTSXNJblJsZUhRaU9pSjFiV1Z5WVhScGJtY2dZV3hzSURjM0lIQmhjblFpZlgwPSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OIn0hIhr3AAAA9wAAAEt+OMs8CzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3hMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR1Y0ZEY5a1pXeDBZU0lzSW5SbGVIUWlPaUpwZEdsdmJuTWdiMllnTVRJZ0tDSjlmUT09IiwicCI6ImFiY2RlZmdoaSJ96M65VgAAAPsAAABLu8gmPQs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam94TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdWNGRGOWtaV3gwWVNJc0luUmxlSFFpT2lKamVXTnNaU0o5ZlE9PSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5In1m5zK+AAABFQAAAEvncIwmCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3hMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR1Y0ZEY5a1pXeDBZU0lzSW5SbGVIUWlPaUlnZEhsd1pYTWlmWDA9IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWSJ9PDMnPAAAAQMAAABLCNDuBAs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam94TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdWNGRGOWtaV3gwWVNJc0luUmxlSFFpT2lJcFhHNHRJRU52YlhCMWRHbHVaeUJtYVhobFpDSjlmUT09IiwicCI6ImFiY2RlZmdoaWprbG0ifRGsBDgAAAD8AAAASwno+i0LOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpveExDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHVjRkRjlrWld4MFlTSXNJblJsZUhRaU9pSWdjRzlwYm5SeklHWnZjaUJoYkd3aWZYMD0iLCJwIjoiYWJjZGVmZ2hpamtsbW4ifaIgzk0AAAEQAAAASy+QA1YLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpveExDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHVjRkRjlrWld4MFlTSXNJblJsZUhRaU9pSWdOemZDc2lKOWZRPT0iLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVCJ9VH3iawAAAQAAAABLT3CU1As6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam94TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdWNGRGOWtaV3gwWVNJc0luUmxlSFFpT2lJZ1BTQTFMRGt5T1NCd1lXbHljeUo5ZlE9PSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXIifRcXi/QAAAD9AAAASzSI050LOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpveExDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHVjRkRjlrWld4MFlTSXNJblJsZUhRaU9pSWdiMllnWTNsamJHVWlmWDA9IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3In2j1/DfAAAA/AAAAEsJ6PotCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3hMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR1Y0ZEY5a1pXeDBZU0lzSW5SbGVIUWlPaUlnZEhsd1pYTWlmWDA9IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6In3k/be/AAAA/gAAAEtzKKlNCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3hMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR1Y0ZEY5a1pXeDBZU0lzSW5SbGVIUWlPaUpjYmkwZ1EyaGxZMnRwYm1jZ2RISmhibk53YjNObEluMTkiLCJwIjoiYWJjZGVmZ2gifbas9JcAAAENAAAAS7fgUGULOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpveExDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHVjRkRjlrWld4MFlTSXNJblJsZUhRaU9pSWdjM2x0YldWMEluMTkiLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUSJ9YoQ/VAAAAPoAAABLhqgPjQs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam94TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdWNGRGOWtaV3gwWVNJc0luUmxlSFFpT2lKeWVTSjlmUT09IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUIifeYspKkAAAEWAAAAS6DQ9vYLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpveExDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHVjRkRjlrWld4MFlTSXNJblJsZUhRaU9pSWdhVzUwWlhKaFkzUnBiMjV6SW4xOSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUiJ9liPWAwAAAQYAAABLwDBhdAs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam94TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdWNGRGOWtaV3gwWVNJc0luUmxlSFFpT2lKY2JpMGdSbTl5SW4xOSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUoifaTDeK8AAAEAAAAAS09wlNQLOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpveExDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHVjRkRjlrWld4MFlTSXNJblJsZUhRaU9pSWdaV0ZqYUNCamVXTnNaU0o5ZlE9PSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2In0wfQDmAAABIwAAAEvJEcEACzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3hMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR1Y0ZEY5a1pXeDBZU0lzSW5SbGVIUWlPaUlnYzNSeWRXTjBkWEpsSW4xOSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaMDEyMzQ1Njc4In3JpRP2AAAA+QAAAEvBCHVdCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3hMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR1Y0ZEY5a1pXeDBZU0lzSW5SbGVIUWlPaUlzSUhOdmJIWnBibWNpZlgwPSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzIn3qx1v/AAABHAAAAEvqYO5XCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3hMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR1Y0ZEY5a1pXeDBZU0lzSW5SbGVIUWlPaUlnYzNsemRHVnRjeUo5ZlE9PSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaMDEifZ1gFmYAAAEgAAAAS46xu9ALOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpveExDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHVjRkRjlrWld4MFlTSXNJblJsZUhRaU9pSWdiMllnWTI5dWMzUnlZV2x1ZEhNaWZYMD0iLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWV1gifaPMiu8AAAEMAAAAS4qAedULOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpveExDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHVjRkRjlrWld4MFlTSXNJblJsZUhRaU9pSWdkRzhpZlgwPSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUIn3DKpByAAABEAAAAEsvkANWCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3hMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR1Y0ZEY5a1pXeDBZU0lzSW5SbGVIUWlPaUlnWTI5MWJuUWlmWDA9IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSU1QifVlwCOcAAAElAAAAS0ZRNKALOmV2ZW50LXR5cGUHAAVjaHVuaw06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImJ5dGVzIjoiZXlKMGVYQmxJam9pWTI5dWRHVnVkRjlpYkc5amExOWtaV3gwWVNJc0ltbHVaR1Y0SWpveExDSmtaV3gwWVNJNmV5SjBlWEJsSWpvaWRHVjRkRjlrWld4MFlTSXNJblJsZUhRaU9pSWdZMjl0Y0dGMGFXSnNaU0o5ZlE9PSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaMDEyMzQ1NiJ9UK5ujwAAAQcAAABL/VBIxAs6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam94TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdWNGRGOWtaV3gwWVNJc0luUmxlSFFpT2lJZ2JXRjBjbWxqWlhNaWZYMD0iLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHIn3vl2YRAAABDwAAAEvNIAMFCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTlrWld4MFlTSXNJbWx1WkdWNElqb3hMQ0prWld4MFlTSTZleUowZVhCbElqb2lkR1Y0ZEY5a1pXeDBZU0lzSW5SbGVIUWlPaUpjYmkwZ1UzVnRJbjE5IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSUyJ9C+D2DgAAARkAAABLIoBhJws6ZXZlbnQtdHlwZQcABWNodW5rDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiYnl0ZXMiOiJleUowZVhCbElqb2lZMjl1ZEdWdWRGOWliRzlqYTE5a1pXeDBZU0lzSW1sdVpHVjRJam94TENKa1pXeDBZU0k2ZXlKMGVYQmxJam9pZEdWNGRGOWtaV3gwWVNJc0luUmxlSFFpT2lKdGFXNW5JbjE5IiwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2In3gcXuOAAAAtAAAAEtha+mlCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaVkyOXVkR1Z1ZEY5aWJHOWphMTl6ZEc5d0lpd2lhVzVrWlhnaU9qRjkiLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyIn3W/lUrAAAB2gAAAEuMNfMsCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaWJXVnpjMkZuWlY5a1pXeDBZU0lzSW1SbGJIUmhJanA3SW5OMGIzQmZjbVZoYzI5dUlqb2liV0Y0WDNSdmEyVnVjeUlzSW5OMGIzQmZjMlZ4ZFdWdVkyVWlPbTUxYkd3c0luTjBiM0JmWkdWMFlXbHNjeUk2Ym5Wc2JIMHNJblZ6WVdkbElqcDdJbWx1Y0hWMFgzUnZhMlZ1Y3lJNk1UZzNMQ0pqWVdOb1pWOWpjbVZoZEdsdmJsOXBibkIxZEY5MGIydGxibk1pT2pBc0ltTmhZMmhsWDNKbFlXUmZhVzV3ZFhSZmRHOXJaVzV6SWpvd0xDSnZkWFJ3ZFhSZmRHOXJaVzV6SWpveE1ESTFMQ0p2ZFhSd2RYUmZkRzlyWlc1elgyUmxkR0ZwYkhNaU9uc2lkR2hwYm10cGJtZGZkRzlyWlc1eklqbzROeko5ZlgwPSIsInAiOiJhYmNkZWZnaGlqa2xtbm9wIn3QWaAKAAABZwAAAEtkYj+JCzpldmVudC10eXBlBwAFY2h1bmsNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJieXRlcyI6ImV5SjBlWEJsSWpvaWJXVnpjMkZuWlY5emRHOXdJaXdpWVcxaGVtOXVMV0psWkhKdlkyc3RhVzUyYjJOaGRHbHZiazFsZEhKcFkzTWlPbnNpYVc1d2RYUlViMnRsYmtOdmRXNTBJam94T0Rjc0ltOTFkSEIxZEZSdmEyVnVRMjkxYm5RaU9qRXdNalVzSW1sdWRtOWpZWFJwYjI1TVlYUmxibU41SWpveU1ERTBNU3dpWm1seWMzUkNlWFJsVEdGMFpXNWplU0k2TVRReU5uMTkiLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk8ifam0wU8=",
    http: {
      statusCode: 200,
      contentType: "application/vnd.amazon.eventstream",
      requestId: "d4a0944b-ed09-420b-b79c-4482c9c44316",
    },
    decodedText:
      '{"type":"message_start","message":{"model":"claude-sonnet-4-5-20250929","id":"msg_bdrk_011CfqEux2THrAjDduWffFKK","type":"message","role":"assistant","content":[],"stop_reason":null,"stop_sequence":null,"stop_details":null,"usage":{"input_tokens":187,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0},"output_tokens":3}}}\n{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"This is asking"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" for the number of 12\u00d7"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"12 binary matrices with all"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" row sums and column sums equal"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" to 6,"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" counted"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" up to:"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"\\n-"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" Row"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" perm"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"utations\\n- Column permutations"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"  \\n- Transposition"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"\\n\\nThis"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" is a very"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" complex"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" Burnside\'s"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" lemma calculation"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":". Let me think"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" through this carefully"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":".\\n\\nThe"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" group"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" acting"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" is"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" G"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" = ("}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"S"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"\u2081"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"\u2082 \u00d7 S\u2081\u2082"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":") "}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"\u22ca Z"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"\u2082,"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" where:"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"\\n- S\u2081\u2082"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" acts"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" on rows"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"\\n- S\u2081\u2082"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" acts on columns\\n- Z\u2082"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" is"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" the transpose"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" operation"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"\\n\\nThe set"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" we"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"\'re counting is the set of "}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"12\u00d712 binary matrices with all"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" row and"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" column sums equal to 6."}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"\\n\\nBy"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" Burnside\'s lemma:"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"\\n|"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"X"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"/"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"G| = (1/|G"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"|)"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" \u03a3_{"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"g\u2208G} |X^"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"g|\\n\\nwhere X^"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"g is the set"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" of matrices fixed"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" by g.\\n\\n|"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"G"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"| = 12!"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" \u00d7"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" 12! \u00d7"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" 2"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"\\n\\nThis"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" is an"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" extremely"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" difficult"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" calculation"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"."}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" Let me think"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" about what\'s"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" being"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" asked more"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" carefully.\\n\\nActually"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":", I need"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" to be"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" very careful here. The problem is"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" asking me"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" to \\""}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"derive"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" and evaluate a complete Burnside sum"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" by"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" explicitly determining the orbit lengths for every pair"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" of cycle partitions.\\""}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"\\n\\nFor"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" a perm"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"utation \u03c3"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"_"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"r"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" on"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" rows"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" and \u03c3_c on columns,"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" a"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" matrix M is fixed if"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":":"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"\\n- M["}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"\u03c3"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"_r(i), \u03c3"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"_c(j)] = M"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"[i,"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"j] for all i,j"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"\\n- Or"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" for"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" transposed"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":":"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" M[\u03c3_c"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"(j"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"), \u03c3_r(i)]"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" = M[i,j]"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"\\n\\nThis is extraordin"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"arily complex."}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" Let me rec"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"onsider whether"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" this is actually"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" feas"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"ible to"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" compute by hand.\\n\\nThe"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" number"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" of cycle"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" index"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" terms"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" alone"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" for"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" S"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"\u2081\u2082 \u00d7 S"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"\u2081\u2082 \u00d7"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" Z\u2082 is enormous. Each"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" partition"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" of"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" "}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"12 gives"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" a"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" cycle type"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":", and there"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" are p"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"(12) = 77"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" partitions of"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" 12."}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"\\n"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"The"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" problem"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" might"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" be testing"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" whether I recognize"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" this as comput"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"ationally inf"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"easible without"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" computational"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" tools,"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" yet"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" it explicitly"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" requests"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" a final"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" verified"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" integer"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" answer despite"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" the \\""}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"without"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" tools"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"\\" constraint"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"."}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" These"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" matrices"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" correspond"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" to "}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"6"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"-regular bipartite graphs on "}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"12"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"+"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"12 vertices,"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" which is itself"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" a deeply"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" studied"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" but"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" difficult"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" problem."}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" Given"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" the manual"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" computation"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" requirement"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":", I suspect the"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" answer might be surprisingly"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" small or"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" there"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"\'s"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" a structural"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" insight"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" I\'m missing."}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" "}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"6,"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" the"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" computational"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" burden"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" becomes"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" prohibitive even"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" for"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" individual"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" Burnside sum"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" terms"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"."}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"\\n\\nI"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"\'m"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" recogn"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"izing this"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" exce"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"eds what"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"\'s"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" practical"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" to"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" compute manually"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" without"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" significant"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" computational resources. The problem seems"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" to demand"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" a specific numerical"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" answer,"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" but"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" the actual"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" calculation"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" requires"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" systematic"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" enumeration that"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"\'s beyond"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" reasonable"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" hand"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" calculation."}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" If"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" I had"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" to provide"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" a"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" response"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":", I\'d need"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" to either"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" acknowledge"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" the limitation"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" or make"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" an educated guess based on patterns"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" in smaller"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" cases,"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" though"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" neither"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" feels"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" satisf"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"ying given"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" the problem"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"\'s specif"}}\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"icity."}}\n{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"EtUbCn4IEhABGAIqQJdNS8cqR255rHleiV/IH2JEX8+I20FER7m2ut4oYCHVMzMthfnUNAkYHhHeYvSShwEF3KTLW03qtoZ2QORrwssyGmNsYXVkZS1zb25uZXQtNC01LTIwMjUwOTI5OABCCHRoaW5raW5nWgwwNTgyNjQyMTk1ODcSDHof/qWU8VQdIT2NwhoMGv8lrhfsxXK8jqcwIjAkOd1AhMYjtwMGG1d4+ZbN2+bMIIzpu3ge8UJxhWGNNZfFrzYUHQJ2qXooh+xFu7EqhBrzXREm4JCcpCR/fNcGgL7FYtTOizdZq0OG+uxE1CzkIuj8IrSp/HQp7rueetwg1zjtO8Wq3tyCEnyGmoSQvUX/q/ZBz8kFnM+37HfopYHfxE98k+49KN7RQtZuPg0EdRGvLhd+i8J8Xg01SLWQiRm3IgacogA1PeCC9Uf3vI+3PCwFrUXaYnVC+Uk7BWGgTAQd+m2b4DwBcxsXXnp4VoEgnfBjjAcFQRJSPMjc35Qb19FCfZRJK+aRIlcGkceK2MWy/noZftnQG4QeZY+KfjgckWaMt6QhSWuUZpuNYL9H0EBlSXyip/CFrcQXQ+22dNP3+mvkBFLWW2pOFeCLDwjjOmSTpTXlcuJMtllCB4N1gC9ymhPZEjWoTb9UXxRcs4vpsJawfGvAsBPMVyE5p0XLXyJfdAofMSIW5OmI9vKEkbt3E8p884roSrhTEpGR4j7Fdlg3dFWMG/O1DOIYEL9QeZzWVlKjO9Ve5lRJbxnISo6eSoZLxikOUf7r5CL32669qTQkpT48o20Ky/hVkrd9+uNEagy94ZiZKQHhz/5F/omUwvKrXiccNLJlxmvW1i7N/20Nncieltu890j372+ROlUXGSueIlDaWhjFtGOS2Pg/JjynT6oJUKnldMcFP0Sl/qKb7LKnKkL30fvvdhgCgntpU7eoFNnWIRuwrJHBY9Ig7anrvAy8ovU22VBBL11aZ3fLW9PIBFuBA+FhbHH/peHlZ1RUgzM77sdPMMgItjrA5EuidstFynswojjCG9pK5Rw9/Zi1Myy86dP3eD9rMiHly6svoQgVouLwMo+KhwR7fwm05jSGIeQ34cNukHvUxtnCxQy8uVv8od370ewyFjiIIth0wtCCYJih6CiWR4/lLxiZAPXVqV1342VrwxyNQRh916aaTRX2zOfZggLWruABzi2GDmLiJYUIctlxB3dDb537xMIIxvFCvHJd5kwkHwQV3v9mO2BTNlDGi80cn7NvBPXVCsUl8BaDjutsx5DyppS9ZCYKhI5c8003WW9ebM/pZxk4qWaAFbvm2tc3iOsmq9pg2CzSVl042N0TqQf9ZeK9f9bIolnwtMWvRSzxq8Ll80a9DsRQ/wpdZebSi2ZTSqgi2TppjWX4+0RLAByVrJKkN0q7KCW4yb03HaU+Gr7sd/k//fb0Y7VNnSVl9KMxwL4cjVZ+yW0pinptc1vyWqnoWZ5La0fOct9sVZ3hbhjnsoQM1lbIlOXypNejOEF4Sz6PPAC5+QDlnJsxw0zyO+eoZ9PjD3baO1OPHPmDN9F1se9prQxwX46jRdOWvfJdYtp68DrUCZ4drtSczfq7oYUp6YPHe+q30dUBiXssE9AD1I3pWEbMp6Hj2YcDBCxZ93zJNvP7nfPPxvodIURStxqECsPVRrfING0zdTIixki8LCQBP00Exl0fX0UeMvYfw5p0xMAZ+8nD9uy2KRA7GKyRTMlRTyiPJ8GAHwANtKG5Kh5g2bieexF9FJtL6pYuEYtwKXkHrdZ1DMckCYnaOumhy9AnydiM0ItOMNlbMvXWDibmqpLaOBRQL08EJyLYgPA+MN3pqxG2kNE2wjao14aNbwpBQUWd2D/JYUr9PjRsij4BEagCSrvhA2PYpCNo+z1SJZSU+SZnmZV39CcHOrEwYRC73ntp5rW6WYRCEJBYs75aEpezT5uH1eSl6OiEnkx+ZrKzt8XWeSXi84Edh9souCPg6NRIdVLCTjvaQDoWFvPT97owZEPlVENuBxUS10AJO4OPVoaTdDfGLlvMXSt5HW6eZGibNO9+Zk3Gjr5D3CrG5z7pX54P98QvmaUkMXY8BaCWZ/mqEoDNWK7/33m7iojGW6b/EGMnA5V6wkGEXiB2v1sTJ2s3+ya69VK54JflaqS92AiYvU26bWARLGlnDo6F8pYPcCY8S2ZpMxwiu6U+3C/CFYBSpnWCKCBx6ivUXby0R4eby53AUzts5vHtEWGVrh+7mJuEBAEyd/kiC8MGZY4LY/K8IGC1uZbFE1o9UgThBqUgRs7avePW9oiP7sInLBUoeZbdO/BXyyECLyx4840Ew9YeyIPHrBktBQRtgnbGdChafRHVZZFuT/pQ1+JfMf1gwAGuWUhBc9IOej6xJdP03IFgx0uhclZqDrx7vEukce9nlJiQlYBg0w8Oy3ZGBOqSVoRQmq9MFPpOXpJ2WrX0WrMClNXq9SsBcq7MfUncFbYykgTvLi4bwyqQDSaI/DmXeoUs+awL4+dm8od0yb8/H545x9BEtWLOGniyUsGFFSSL+vliP/86tnhQmvQVbgHFhWIuHFnHp4oxO73wnYQ7KL6iPWS9AzTsAvZrJVPVWHslvplC4O9oMqx0BOug0A+SW/qO5iCuI+9myH16auWQmVWJHQTxw4Qo95gI2A4vbTy4g6NIhmi5v4yrirqrPEJEPE3tdKMa8EW6ho35Y9NPQnBzADw5Jx4nUXcYS4uVkR2hMXIeNYDPAJBGwz4I/zeDsQsjHv3wfn5xjYT/hBH8szdphO53DTL1iSPWtEp+Bgw1PwFnljDqkXsNY88ghGprPQId4YsYSBbUQZZ7aUH8sM5iPiiXZgmSGYGmXxwnUUlvflo04uCbA2KHn0lmcA3EXWqTi506TAfas6Ik5jfTnUPB7zRHl379kMurmpqEGE2wKGg7+9a3tNOOHHToBHnYB7yqsCJZ9HNVWJeN9MYSoB8SkEzSsSOnLBq6QfLtZ2ksHjZEQMCOS5HaZvGZw1f9IiyLKnFRNl0UE+vB6dfqAcZGR4C8pDYRuBj8hWf4vobfR+nltd5QF9AM8aIxy31X8F983+3SXWAVHia4uUIumtrO17PPP9qmmV3JUIEWWzK4UWut7e+3BzfBESEvkgpa7UI8VFbJeORsrkGlkRjSxKTP+G8ZMvvg4ky8ZOdU6hIRTJKMrGvban/8VTr+JP0Dd8tNlETavD0WNNasMJJ2C6tYLtyItWLWO/+BSCCljN6V/xADbPErgjTl8keAHoh3lwyMoV9CgKA0yQLcLrqgNTqhcVst0f/+vyO/4ouHTgefq8KsGeqeCT9QA1lStaeIB/ZGv5Ox99K1W11VbjZz96FKn7g+pbiCyY9l3NX7LGW9LF1uBAAmS0OB+oB2gVQyrfezlR3/VtoYd/QBwnl2+hrmAYxDf/gPGmejvqR87InpaoA3P4Iqn1gkfoPADxNLg5HFotmvswmvQopAEuhurjZOTOcnQu7iLHG36ctfuZoCXG99TlDnHshFxkS3ykGquZfxiFykCJv70M5pRNlr1h9yH72lLXSgIwfyq8hmWAPd4R5Uaj+OGJfbMm2Pz5bAdsJ2inFYBnBvKbhlTd648Z84h/8ppsAixpHPgP91gzuelPMCGhK536tc9XGBzIzEIBOoYuvQhfP213lC6K5wk51pqSwIrhIjZtVBVrJQsGo6HHRb7H3UBifuDs7sGo5tYMg2m0vn++X8hjQzUMDHPphMAHA98RlVStathUdRM9+HeBrsLCb1XBUZRb9UClQW94kU5X61aB/T3LlcpUVKbAOFVx/dFRnwhUe4WC0/pdLxKdIlQmcZtXsy7Ov0sZrPWxwrf38Y+jxBxS9ZRw4Kgl2umSi29EXCchRiHMpKEFpzMrMnIUT9nsMqVBf2VPB6jpz0Wd+ikg6DVP4cFgDOe/jlbON/fsOOkwxd9AoZAKzn47OMsU/PlftSt0tIBEshWiMK+U39auOauL19X2TWlZ+Mrnk2c9pul502brqK+V117/CgnYKkxCdPCHFprs9MqhdOarnQzttEdZUpURRs2BFAxoerJEZUw7XdKOS2yYjS5svwLBRKLUavehaGbl0zp+h+W/+2t/XvGdsVzeyVTkCb2qNa6Q118rFIPLLiF+d4R5SKn9MtHzxqt8QJWwU8HuRyyBEFu8l0CmiatW9oTK/5P/F1+omcVKUyarvlfIFztuadD81Ld641tWajYx3VPcSqRRohINyl6VSvoDasb5GYWXhSt7U+7Uk3AFvQkJKk5KIeOAt4c8jwtYpi41FbHbMnBJ2dS03VefdfAf1/9l7MFsV9Luds1B5ZYv+45hlMQAdMW2f/g1L9q3wXNhtGfR/btCcfyVCJ6jepduceHhHmOg8nunYW5dufoJk4a7kA8IgkTaiJ4pzR15ShDnhmOSw1vO0uCMC6ISAXdUU13V8xoDORYvTamkwL5B6wPPXt/wSVUGRuQgmNROGv1lZ2zG/aGrHXmEqjp/r1WCoZ/VzuHL73siPhj97ogPxaepK6wrTDzAerYUaF5K+n5CMjw0t8bt+A0nOHRKWKyF5pCUthekhf8Tjv4a23hpTET3pm2T5tOWeJN8QQO9Tnfnr5/Y0RWmMOroo+oM9EGAjkfYems3q0iv91xQL3H0S+UU+6R5ZPCHaOyHipnsSp403CaM3pZuDUL6+iD2+tnXuFBQJE6xIGcmMs4BgB"}}\n{"type":"content_block_stop","index":0}\n{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"I"}}\n{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":" need to be"}}\n{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":" direct"}}\n{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":" with you"}}\n{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":": computing"}}\n{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":" the"}}\n{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":" complete"}}\n{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":" Burnside sum for 12\u00d7"}}\n{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"12 binary matrices with row"}}\n{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":" and column sums equal to 6"}}\n{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":","}}\n{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":" under"}}\n{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":" the action"}}\n{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":" of ("}}\n{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"S\u2081\u2082 \u00d7 S"}}\n{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"\u2081\u2082) "}}\n{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"\u22ca "}}\n{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"\u2124\u2082,"}}\n{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":" is not"}}\n{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":" feasible to"}}\n{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":" do exactly"}}\n{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":" by hand without"}}\n{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":" computational"}}\n{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":" tools.\\n\\nThe calculation would"}}\n{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":" require"}}\n{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":":\\n- En"}}\n{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"umerating all 77 part"}}\n{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"itions of 12 ("}}\n{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"cycle"}}\n{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":" types"}}\n{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":")\\n- Computing fixed"}}\n{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":" points for all"}}\n{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":" 77\u00b2"}}\n{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":" = 5,929 pairs"}}\n{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":" of cycle"}}\n{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":" types"}}\n{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"\\n- Checking transpose"}}\n{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":" symmet"}}\n{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"ry"}}\n{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":" interactions"}}\n{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"\\n- For"}}\n{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":" each cycle"}}\n{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":" structure"}}\n{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":", solving"}}\n{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":" systems"}}\n{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":" of constraints"}}\n{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":" to"}}\n{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":" count"}}\n{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":" compatible"}}\n{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":" matrices"}}\n{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"\\n- Sum"}}\n{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"ming"}}\n{"type":"content_block_stop","index":1}\n{"type":"message_delta","delta":{"stop_reason":"max_tokens","stop_sequence":null,"stop_details":null},"usage":{"input_tokens":187,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":1025,"output_tokens_details":{"thinking_tokens":872}}}\n{"type":"message_stop","amazon-bedrock-invocationMetrics":{"inputTokenCount":187,"outputTokenCount":1025,"invocationLatency":20141,"firstByteLatency":1426}}\n',
  },
] as const;

function capturedInvoke(index: number): Observation {
  const capture = invokeCaptures[index];
  const events = capture.stream
    ? capture.decodedText
        .trim()
        .split("\n")
        .map((line) => readJson(Buffer.from(line)))
    : [];
  return {
    requestCount: 1,
    http: { ...capture.http },
    metadata: { httpStatusCode: 200 },
    sdkResponse: undefined,
    sdkEvents: [],
    networkEnded: true,
    rawWire: Buffer.from(capture.rawBase64, "base64"),
    decoded: capture.stream
      ? { wire: "invoke", stream: true, events }
      : { wire: "invoke", stream: false, body: readJson(Buffer.from(capture.decodedText)) },
  };
}
// Retain the same decoded capture surface for RED/GREEN reader regressions.
function inspectCapturedInvoke(index: number, mutate?: (data: Observation) => void) {
  const observation = capturedInvoke(index);
  mutate?.(observation);
  const data = observation.decoded;
  if (data.wire !== "invoke") throw new Error("Expected Invoke");
  if (data.stream)
    data.events.forEach((event) =>
      invokeEvent({ chunk: { bytes: Buffer.from(JSON.stringify(event)) } }),
    );
  else readJson(Buffer.from(JSON.stringify(data.body)));
  classify(
    { wire: "invoke", fault: invokeCaptures[index].fault, stream: invokeCaptures[index].stream },
    observation,
    "native",
  );
  return observation;
}
for (const index of [0, 1, 2, 3]) {
  it(`Invoke reader genuine control ${index}`, () => {
    const capture = invokeCaptures[index];
    const observation = inspectCapturedInvoke(index);
    expect(createHash("sha256").update(observation.rawWire).digest("hex")).toBe(capture.rawSha256);
    expect(createHash("sha256").update(capture.decodedText).digest("hex")).toBe(
      capture.decodedSha256,
    );
    expect(
      classify(
        { wire: "invoke", fault: capture.fault, stream: capture.stream },
        observation,
        "native",
      ),
    ).toBe(capture.fault === "K5" ? "TARGET_COMPARED" : "NOT_TRIGGERED");
  });
  it(`Invoke reader synthetic string usage ${index}`, () => {
    expect(() =>
      inspectCapturedInvoke(index, (observation) => {
        const d = observation.decoded;
        if (d.wire !== "invoke") throw new Error("Expected Invoke");
        const usage = d.stream ? object(object(d.events[0].message).usage) : object(d.body.usage);
        usage.input_tokens = "692";
      }),
    ).toThrow();
  });
  it(`Invoke reader synthetic unknown terminal ${index}`, () => {
    expect(() =>
      inspectCapturedInvoke(index, (observation) => {
        const d = observation.decoded;
        if (d.wire !== "invoke") throw new Error("Expected Invoke");
        if (d.stream)
          object(d.events.find((e) => e.type === "message_delta")?.delta).stop_reason =
            "future_terminal";
        else d.body.stop_reason = "future_terminal";
      }),
    ).toThrow();
  });
}

// Each derivative below changes one recognized field or lifecycle event in an
// otherwise intact capture. These are synthetic regressions, not native evidence.
const invokeDerivatives: {
  name: string;
  index: number;
  mutate: (observation: Observation) => void;
}[] = [
  {
    name: "incomplete HTTP",
    index: 2,
    mutate: (o) => {
      o.networkEnded = false;
    },
  },
  {
    name: "bad status",
    index: 2,
    mutate: (o) => {
      if (o.http) o.http.statusCode = 503;
    },
  },
  ...["thinking", "signature"].map((field) => ({
    name: `numeric ${field}`,
    index: 2,
    mutate: (o: Observation) => {
      if (o.decoded.wire === "invoke" && !o.decoded.stream)
        object(array(o.decoded.body.content)[0])[field] = 7;
    },
  })),
  {
    name: "numeric text",
    index: 2,
    mutate: (o) => {
      if (o.decoded.wire === "invoke" && !o.decoded.stream)
        object(array(o.decoded.body.content)[1]).text = 7;
    },
  },
  {
    name: "wrong content type",
    index: 2,
    mutate: (o) => {
      if (o.decoded.wire === "invoke" && !o.decoded.stream) o.decoded.body.content = {};
    },
  },
  {
    name: "unknown block",
    index: 2,
    mutate: (o) => {
      if (o.decoded.wire === "invoke" && !o.decoded.stream)
        object(array(o.decoded.body.content)[0]).type = "redacted_thinking";
    },
  },
  {
    name: "K5 wrong terminal",
    index: 0,
    mutate: (o) => {
      if (o.decoded.wire === "invoke" && !o.decoded.stream) o.decoded.body.stop_reason = "tool_use";
    },
  },
  {
    name: "K5 nonempty input",
    index: 0,
    mutate: (o) => {
      if (o.decoded.wire === "invoke" && !o.decoded.stream)
        object(array(o.decoded.body.content)[0]).input = { payload: "complete" };
    },
  },
  {
    name: "K9 thought-only end_turn",
    index: 2,
    mutate: (o) => {
      if (o.decoded.wire === "invoke" && !o.decoded.stream) array(o.decoded.body.content).pop();
    },
  },
  {
    name: "missing terminal",
    index: 3,
    mutate: (o) => {
      if (o.decoded.wire === "invoke" && o.decoded.stream) o.decoded.events.pop();
    },
  },
  {
    name: "numeric delta",
    index: 3,
    mutate: (o) => {
      if (o.decoded.wire === "invoke" && o.decoded.stream)
        object(o.decoded.events[2].delta).thinking = 7;
    },
  },
  {
    name: "out of order index",
    index: 3,
    mutate: (o) => {
      if (o.decoded.wire === "invoke" && o.decoded.stream) o.decoded.events[2].index = 1;
    },
  },
  {
    name: "duplicate block stop",
    index: 3,
    mutate: (o) => {
      if (o.decoded.wire === "invoke" && o.decoded.stream) {
        const i = o.decoded.events.findIndex((e) => e.type === "content_block_stop");
        o.decoded.events.splice(i, 0, structuredClone(o.decoded.events[i]));
      }
    },
  },
  {
    name: "K5 cut block stop",
    index: 1,
    mutate: (o) => {
      if (o.decoded.wire === "invoke" && o.decoded.stream)
        o.decoded.events.splice(3, 0, { type: "content_block_stop", index: 0 });
    },
  },
  {
    name: "K5 stream wrong terminal",
    index: 1,
    mutate: (o) => {
      if (o.decoded.wire === "invoke" && o.decoded.stream)
        object(o.decoded.events[3].delta).stop_reason = "tool_use";
    },
  },
];
for (const { name, index, mutate } of invokeDerivatives) {
  it(`Invoke reader synthetic ${name}`, () => {
    expect(() => inspectCapturedInvoke(index, mutate)).toThrow();
  });
}

for (const index of [2, 3]) {
  it(`Invoke reader preserves native mixed output ${index} and rejects local visible output`, () => {
    const o = capturedInvoke(index);
    const cell = { wire: "invoke", fault: "K9", stream: invokeCaptures[index].stream } as const;
    const before = JSON.stringify(o.decoded);
    expect(classify(cell, o, "native")).toBe("NOT_TRIGGERED");
    expect(JSON.stringify(o.decoded)).toBe(before);
    expect(() => classify(cell, o, "local")).toThrow();
  });
}
it("Invoke reader accepts native K5 text only before cut", () => {
  const o = capturedInvoke(0);
  if (o.decoded.wire !== "invoke" || o.decoded.stream) throw new Error("Expected object");
  const content = array(o.decoded.body.content);
  content.unshift({ type: "text", text: "Before" });
  expect(classify(cells[0], o, "native")).toBe("TARGET_COMPARED");
  content.push({ type: "text", text: "After" });
  expect(() => classify(cells[0], o, "native")).toThrow();
});
it("Invoke reader preserves chunk segmentation equivalence", () => {
  const o = capturedInvoke(3);
  if (o.decoded.wire !== "invoke" || !o.decoded.stream) throw new Error("Expected stream");
  const event = o.decoded.events[2];
  const delta = object(event.delta);
  const text = string(delta.thinking);
  const second = structuredClone(event);
  delta.thinking = text.slice(0, 1);
  object(second.delta).thinking = text.slice(1);
  o.decoded.events.splice(3, 0, second);
  expect(classify(cells[3], o, "native")).toBe("NOT_TRIGGERED");
});

// Exact retained native SDK controls, collected 2026-10-08 (S5-converse).
// Raw response hashes and decoded artifact hashes pin provenance; derivatives below are synthetic.
const converseCaptures: {
  fault: "K5" | "K9";
  rawBase64: string;
  rawSha256: string;
  decodedText: string;
  decodedSha256: string;
  http: NonNullable<Observation["http"]>;
  decoded: Extract<Observation["decoded"], { wire: "converse" }>;
}[] = [
  {
    fault: "K5",
    rawBase64:
      "eyJtZXRyaWNzIjp7ImxhdGVuY3lNcyI6MTc2N30sIm91dHB1dCI6eyJtZXNzYWdlIjp7ImNvbnRlbnQiOlt7InRvb2xVc2UiOnsiaW5wdXQiOnt9LCJuYW1lIjoicmVjb3JkX251bWJlcnMiLCJ0b29sVXNlSWQiOiJ0b29sdXNlX0RBUW5RUGFGcUk0Y0xXZDdlQkxoZVgiLCJ0eXBlIjoidG9vbF91c2UifX1dLCJyb2xlIjoiYXNzaXN0YW50In19LCJzdG9wUmVhc29uIjoibWF4X3Rva2VucyIsInVzYWdlIjp7ImNhY2hlUmVhZElucHV0VG9rZW5Db3VudCI6MCwiY2FjaGVSZWFkSW5wdXRUb2tlbnMiOjAsImNhY2hlV3JpdGVJbnB1dFRva2VuQ291bnQiOjAsImNhY2hlV3JpdGVJbnB1dFRva2VucyI6MCwiaW5wdXRUb2tlbnMiOjY5Miwib3V0cHV0VG9rZW5zIjozMiwic2VydmVyVG9vbFVzYWdlIjp7fSwidG90YWxUb2tlbnMiOjcyNH19",
    rawSha256: "df3bce4e37ad4729234f8ea6d6f1e0a3a8facbf2d68f4c1d6636f5a5e65d41b1",
    decodedText:
      '{\n  "output": {\n    "message": {\n      "role": "assistant",\n      "content": [\n        {\n          "toolUse": {\n            "toolUseId": "tooluse_DAQnQPaFqI4cLWd7eBLheX",\n            "name": "record_numbers",\n            "input": {},\n            "type": "tool_use"\n          }\n        }\n      ]\n    }\n  },\n  "stopReason": "max_tokens",\n  "usage": {\n    "inputTokens": 692,\n    "outputTokens": 32,\n    "totalTokens": 724,\n    "cacheReadInputTokens": 0,\n    "cacheWriteInputTokens": 0\n  },\n  "metrics": {\n    "latencyMs": 1767\n  },\n  "$metadata": {\n    "httpStatusCode": 200,\n    "requestId": "6af97268-4050-4a25-92f7-c04280aac9e3",\n    "attempts": 1,\n    "totalRetryDelay": 0\n  }\n}',
    decodedSha256: "a04972eb484d7589f39d3cdadbd0e49cb0ad1c5a7c1170c043aec10a9b2e6abe",
    http: {
      statusCode: 200,
      contentType: "application/json",
      requestId: "6af97268-4050-4a25-92f7-c04280aac9e3",
    },
    decoded: {
      wire: "converse",
      stream: false,
      body: {
        output: {
          message: {
            role: "assistant",
            content: [
              {
                toolUse: {
                  toolUseId: "tooluse_DAQnQPaFqI4cLWd7eBLheX",
                  name: "record_numbers",
                  input: {},
                  // Native capture has an enum value absent from the SDK declaration.
                  // Preserve it as untrusted data for converseTool to validate.
                  ...object({ type: "tool_use" }),
                },
              },
            ],
          },
        },
        stopReason: "max_tokens",
        usage: {
          inputTokens: 692,
          outputTokens: 32,
          totalTokens: 724,
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 0,
        },
        metrics: { latencyMs: 1767 },
        $metadata: {
          httpStatusCode: 200,
          requestId: "6af97268-4050-4a25-92f7-c04280aac9e3",
          attempts: 1,
          totalRetryDelay: 0,
        },
      },
    },
  },
  {
    fault: "K5",
    rawBase64:
      "AAAAgQAAAFJswXaTCzpldmVudC10eXBlBwAMbWVzc2FnZVN0YXJ0DTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsicCI6ImFiY2QiLCJyb2xlIjoiYXNzaXN0YW50In31EqAFAAABFgAAAFe00aq5CzpldmVudC10eXBlBwARY29udGVudEJsb2NrU3RhcnQNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MCwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSiIsInN0YXJ0Ijp7InRvb2xVc2UiOnsibmFtZSI6InJlY29yZF9udW1iZXJzIiwidG9vbFVzZUlkIjoidG9vbHVzZV9vRFJNaGI3ZEV0ZmRPa0NqaXNRaXBDIiwidHlwZSI6InRvb2xfdXNlIn19fZyygxgAAADMAAAAV7zIHuQLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjowLCJkZWx0YSI6eyJ0b29sVXNlIjp7ImlucHV0IjoiIn19LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0wifRDw6X0AAACeAAAAVokcstkLOmV2ZW50LXR5cGUHABBjb250ZW50QmxvY2tTdG9wDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjAsInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5eiJ91hBR8gAAAJsAAABR35ioCgs6ZXZlbnQtdHlwZQcAC21lc3NhZ2VTdG9wDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eCIsInN0b3BSZWFzb24iOiJtYXhfdG9rZW5zIn2DvA8WAAAA+AAAAE6MAqhiCzpldmVudC10eXBlBwAIbWV0YWRhdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJtZXRyaWNzIjp7ImxhdGVuY3lNcyI6MTQ4NH0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRiIsInVzYWdlIjp7ImlucHV0VG9rZW5zIjo2OTIsIm91dHB1dFRva2VucyI6MzIsInNlcnZlclRvb2xVc2FnZSI6e30sInRvdGFsVG9rZW5zIjo3MjR9feEyxPI=",
    rawSha256: "017af38087e4c1f3a239b1d1caf3cd9554c41126da3da58d6e0430e2493ba410",
    decodedText:
      '{"messageStart":{"role":"assistant"}}\n{"contentBlockStart":{"start":{"toolUse":{"toolUseId":"tooluse_oDRMhb7dEtfdOkCjisQipC","name":"record_numbers","type":"tool_use"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"toolUse":{"input":""}},"contentBlockIndex":0}}\n{"contentBlockStop":{"contentBlockIndex":0}}\n{"messageStop":{"stopReason":"max_tokens"}}\n{"metadata":{"usage":{"inputTokens":692,"outputTokens":32,"totalTokens":724},"metrics":{"latencyMs":1484}}}\n',
    decodedSha256: "45ca45e8dc17307b1e4305a81d71381dd5332d2dc9fe4650f567097cb72529b0",
    http: {
      statusCode: 200,
      contentType: "application/vnd.amazon.eventstream",
      requestId: "3904b838-0f3c-447f-8a30-ebee4c5eeb9d",
    },
    decoded: {
      wire: "converse",
      stream: true,
      events: [
        { messageStart: { role: "assistant" } },
        {
          contentBlockStart: {
            start: {
              toolUse: {
                toolUseId: "tooluse_oDRMhb7dEtfdOkCjisQipC",
                name: "record_numbers",
                // Native capture has an enum value absent from the SDK declaration.
                // Preserve it as untrusted data for converseTool to validate.
                ...object({ type: "tool_use" }),
              },
            },
            contentBlockIndex: 0,
          },
        },
        { contentBlockDelta: { delta: { toolUse: { input: "" } }, contentBlockIndex: 0 } },
        { contentBlockStop: { contentBlockIndex: 0 } },
        { messageStop: { stopReason: "max_tokens" } },
        {
          metadata: {
            usage: { inputTokens: 692, outputTokens: 32, totalTokens: 724 },
            metrics: { latencyMs: 1484 },
          },
        },
      ],
    },
  },
  {
    fault: "K9",
    rawBase64:
      "eyJtZXRyaWNzIjp7ImxhdGVuY3lNcyI6MTY2MDB9LCJvdXRwdXQiOnsibWVzc2FnZSI6eyJjb250ZW50IjpbeyJyZWFzb25pbmdDb250ZW50Ijp7InJlYXNvbmluZ1RleHQiOnsic2lnbmF0dXJlIjoiRXE4TkNuNElFaEFCR0FJcVFGTzRoM3dsSnYyV2RFck5veURrNUxiYlpQNjcwaitKa3JrdGhVa1A3WGZrOW9aN3c2WERPdFppMngvTmtyZUxjNmduMk1yRmtMUzc5TTY3amhNa2Z2MHlHbU5zWVhWa1pTMXpiMjV1WlhRdE5DMDFMVEl3TWpVd09USTVPQUJDQ0hSb2FXNXJhVzVuV2d3d05UZ3lOalF5TVRrMU9EY1NEQVZuVzdiVlZEVWFybEdUTFJvTVA3aFFVdWxyYnhROW41ZExJakRVYlkvQ24xd1duTEpzT2MxVFo0ZHJEOG9NdEZ2UkQ0WFVmV0tIYjhITmZHbm9OMTIyOVFYZG9FYkFQS05adnNncTNndDA4N0gxemhCcUdRb3N1MWxWU2JiM1hlYklFVk40RGpRM0czU01hR1l0UVFTOUdpSnZERlpPMlhpOVZLOGxqMGJDeE50MEJnbThOWnZhVHNzdDh4ay8rcXZVZWRQbEdxTHVyYm9ZSzlkQWJoNDZIUjVISUNTWHNoMTBxQloxbW16enU0RjdTb0tPV1loUSs5QkhTY2YyVWY5a2pkRk1NMVR0dk1jVTgyYmhVbndDYnVnYk1HdFNjQks1VHNjR2Rybk5jaTRtL1JaRjAvN3ErMUk2WDcwaWVucDBtekVYbHRBUmpDR0FCZ2RwV1JkQ2lmcVVFM21Wa05sVm5pOHpwdmFBWG9KNkJMS2ovMXEvdzR3M0RGa2VkYUlLa1hpRjRLZjdjZC9XM05GVERJQW42NVRUQnpyWlBwVlY1RUpjSVc3L012RlBCY3lXdG5PRHRuYjBNaUwzb0I4Z1lQNlJiN1MzTkx1YUl6SEQyZVpQTWo1Z0NPcEZKYm9KcndvT2QzRWZxd1dFUDNiME0xTnAzMVZ3cnJTYWdPdnJicVF5azZpbTBaVmRrNTlNMGJxR2Vua1BMVFpkakRXbzE5V0Fsam9tdktpTGNYNy9aalAwVk1nZGE1YzBhMTBYQ21sY1ZrcU40bk9mQllxME40U0hxa1BpYWJVQUpIRlE0RnhGdVBCTmRXTHE1bHVZTUp5MkpaN3FCNlZKTWpoL1kydGlIc0NIMXVjZFZtR3NiMzBKQUZQaDRCcXAxaVVqc2VMWTN1Nzc3MlI5WTVDQTNSZjBSd3E4RnBuQlZSRmRrWTVkVWtsZWRwN016S3YwQVhudU5XcTVIS3o3WjUzSUJtYXArSDE2c1crR01kSTN1OERWZERldUp6c2RrWjdud0VMS09JaHdzR0g1b0RUcEZsQTJWZ2pCbVNFV2EyTm04Q3pOd2Q5NnhkMjdwR3YvNTgrck8zNUlVOFpHUHBBcjVwTERxK3ZEMk5wL3diVFhhWXd3SEUyNVBncmNTUFRrOWVlTEVvazZIMExtR3dnY1g2eGs2SEV0RDN5VjVPWXp0L21rSlc3MVlxT0ZrKzVMS01ybkVDcnBGN0NJZDU1N3lzanp0NGRTOVZPVDNaR3RUeWNhRXowd29NekdXYkdxVG5icXNTUGNNN3hBSXEyS3N0eFBQMEdSK1ozeUtmZWxjVytpL0VyMWZudGt6MEZJREYxM09VaVpjblo2SlNMcXJRaEFLcnBOdFplRzVtbmRsdkFzck1wRzdmNmVLVXk0TFFHaE1JVTVXeWd0cDJGWnpaYjdMU3dZajc2NlhDeXMwTUtWTmxwYUpNZUNLcUI0Y1BzaW4yVTBjZTdnbmxMZEFaczNqd2N5Q1F3akRnNGNOTGVDYzVnQnY2eThNV0doeUZ0VFVDQVRsV0k4a1RlMGVMMURNaXdIOFdvOThMQW1qWlc2YkpRNTNIT29VSDJodlBzUGh5RFpLcGh6NTR5RU90ZnRlbnEwd0c2OEFtVWFPZVpJckJpajhBSmtKU0tjbXFRK0Q4U2pLK1R1UE5uSDlTc2dRQSs0dmZPNkZaZWVJRjl3US9XbmplOUZvWG9sTkpzdHFPczNuYnJZN0Z1Z3I2alFvdExRbmxCUkdFakN6UEY2dENzZXd6QzAwY1hzckg1bFNMc0s5MW1vQmxjT21KdEVSYkRKZGp4WU1zUyttdlEwcmM3a3c5dDJTTGNRNUx0TlNjbzFncTdZWk8rbk5aeEU4NVlQcm5zTnh5a1F5R0FGeWQ4Zlpra3ZtcGphQTd6S1FMTVJHL3o2Wjg3N05QMW1uR3p2clJDTWh6N3ovNjNDM3NCa2tXbzUrMnc1aG5VeG9wSC9zRDhyNWZYSHZYbE9TUGhMMXZlWXdRLzEzWDN5SDI2NFpqR055KzZydkFWWW9WZm5RcnZEU0RvOG9aVUZvUXRyK3Z6dXZueUNqOEtUTFg4T2M0SmpsVHdCTk9ZRmNSYng2OTJ4S1N4dzlydnlSMHZJTDRXSzdWcEk0cmcvTnJqRXMxbUFnbjZFekFrZzh2ZUpYU1lMSmVhdHFqcElGV09Sa1lBdXdQQ0J4T0E4VlZ2NTAvRG96YU1hQnI3WWlTbi9icTRQOVIxZEZTelF1RHZCaUJsdGNBTUpVa2kzSWtLVUVQaHNhTUxIUVBuSnVPWE5OcWhIY3pRNVdHb1M5OVFmMVZDRkJrNUVmaTh6U0hOUDVxV3FseDJqZUlvTDZTQmoxTDZvRUNaeVZxbUJvbXJzVE5KNXFDcU0xK0xCa3gxR1RhVm84azFPazlZWTAyaG5pRW1xN0pFQUVQY0lHTjY5RE1FdHB1TWhlS21LbmlDbEtPS1Z5dGlWYjUvWDgycXpFQUh5NmtIZStMb0dvUHhvTG5MQWlVWFFUbFRmaUJjSWFqeWtPeUtLMEVJZnYwKzIvVytPTTg2c3VMQVcwK3NDOGhHSGhDRmJrTVgzcE1uQjFjWW5RdEpSMWNRQkpVK2ltNStxNU9YQ0ZNOEd2NFVMQjFaVG9lYkJIQk45NmVTWW8wcWgzTmpLNUEvZm51L0pOVFQxZkhpL3RHWnpmWlNIV01zQXNCNmlYdUdWOSsrWTkvMFd5VGlXV3FYczZyeHp5MSswM3NVNDRlWmNkQmlIZlg0ZXNvNjEzcFBLTmtUNStSZ0IiLCJ0ZXh0IjoiSSBuZWVkIHRvIGRldGVybWluZSB0aGUgbnVtYmVyIG9mIG5vbi1pc29tb3JwaGljIGdyb3VwcyBvZiBvcmRlciAkMl44IFxcY2RvdCAzXjMgPSAyNTYgXFxjZG90IDI3ID0gNjkxMiQuXG5cblRoaXMgaXMgYSBzdWJzdGFudGlhbCBwcm9ibGVtLiBMZXQgbWUgd29yayB0aHJvdWdoIHRoaXMgc3lzdGVtYXRpY2FsbHkgdXNpbmcgdGhlIFN5bG93IHRoZW9yZW1zIGFuZCBkaXJlY3QgcHJvZHVjdHMgb2YgU3lsb3cgc3ViZ3JvdXBzLlxuXG5GaXJzdCwgbGV0IG1lIGlkZW50aWZ5IHRoZSBrZXkgZmFjdHM6XG4tIE9yZGVyID0gJDJeOCBcXGNkb3QgM14zID0gNjkxMiRcbi0gV2UgbmVlZCB0byBjb3VudCBub24taXNvbW9ycGhpYyBncm91cHMgb2YgdGhpcyBvcmRlclxuXG5CeSB0aGUgU3lsb3cgdGhlb3JlbXM6XG4tIE51bWJlciBvZiBTeWxvdyAyLXN1Ymdyb3VwczogJG5fMiBcXGVxdWl2IDEgXFxwbW9kezJ9JCBhbmQgJG5fMiB8IDNeMyA9IDI3JFxuICBTbyAkbl8yIFxcaW4gXFx7MSwgMywgOSwgMjdcXH0kXG4tIE51bWJlciBvZiBTeWxvdyAzLXN1Ymdyb3VwczogJG5fMyBcXGVxdWl2IDEgXFxwbW9kezN9JCBhbmQgJG5fMyB8IDJeOCA9IDI1NiRcbiAgU28gJG5fMyBcXGluIFxcezEsIDQsIDE2LCA2NCwgMjU2XFx9JFxuXG5UaGUga2V5IGFwcHJvYWNoIGlzOlxuMS4gSWYgYm90aCAkbl8yID0gMSQgYW5kICRuXzMgPSAxJCwgdGhlbiAkRyBcXGNvbmcgUF8yIFxcdGltZXMgUF8zJCB3aGVyZSAkUF8yJCBpcyB0aGUgdW5pcXVlIFN5bG93IDItc3ViZ3JvdXAgYW5kICRQXzMkIGlzIHRoZSB1bmlxdWUgU3lsb3cgMy1zdWJncm91cFxuMi4gQ291bnQgZ3JvdXBzIG9mIG9yZGVyICQyXjgkXG4zLiBDb3VudCBncm91cHMgb2Ygb3JkZXIgJDNeMyRcbjQuIFVzZSB0aGUgZmFjdCB0aGF0IGdyb3VwcyBvZiB0aGlzIG9yZGVyIHdpdGggdW5pcXVlIFN5bG93IHN1Ymdyb3VwcyBhcmUgZGlyZWN0IHByb2R1Y3RzXG5cbkFjdHVhbGx5LCB0aGlzIHByb2JsZW0gaXMgcXVpdGUgY29tcGxleC4gTGV0IG1lIGNoZWNrIGlmIHdlIGNhbiB1c2Uga25vd24gcmVzdWx0cyBhYm91dCB0aGUgbnVtYmVyIG9mIGdyb3VwcyBvZiBwcmltZSBwb3dlciBvcmRlcnMuXG5cbkZyb20gZ3JvdXAgdGhlb3J5IHRhYmxlczpcbi0gTnVtYmVyIG9mIGdyb3VwcyBvZiBvcmRlciAkMl44ID0gMjU2JDogVGhpcyBpcyA1NjA5MlxuLSBOdW1iZXIgb2YgZ3JvdXBzIG9mIG9yZGVyICQzXjMgPSAyNyQ6IFRoZXJlIGFyZSBleGFjdGx5IDUgbm9uLWlzb21vcnBoaWMgZ3JvdXBzIG9mIG9yZGVyICRwXjMkIGZvciBhbnkgcHJpbWUgJHAkXG5cbkZvciBncm91cHMgb2Ygb3JkZXIgJDJeOCBcXGNkb3QgM14zJCwgSSBuZWVkIHRvIGNvbnNpZGVyIGhvdyB0aGVzZSBTeWxvdyBzdWJncm91cHMgaW50ZXJhY3QuIFdoZW4gYm90aCBTeWxvdyBzdWJncm91cHMgYXJlIHVuaXF1ZSAobm9ybWFsKSwgdGhlIGdyb3VwIGlzIGEgZGlyZWN0IHByb2R1Y3QsIGdpdmluZyA1NjA5MiDDlyA1IHBvc3NpYmlsaXRpZXMuIEJ1dCBJIGFsc28gbmVlZCB0byBhY2NvdW50IGZvciBjYXNlcyB3aGVyZSB0aGUgU3lsb3cgc3ViZ3JvdXBzIGFyZW4ndCB1bmlxdWUsIHdoaWNoIGludm9sdmVzIGFuYWx5emluZyBwb3NzaWJsZSBleHRlbnNpb25zIGFuZCBzZW1pZGlyZWN0IHByb2R1Y3RzLiJ9fX0seyJ0ZXh0IjoiIyBDbGFzc2lmaWNhdGlvbiBvZiBHcm91cHMgb2YgT3JkZXIgMl44IMK3IDNeM1xuXG4jIyBPcmRlciBhbmQgQmFzaWMgU2V0dXBcblxuV2Ugc2VlayB0byBjbGFzc2lmeSBncm91cHMgb2Ygb3JkZXIgKipuID0gMl44IMK3IDNeMyA9IDI1NiDCtyAyNyA9IDY5MTIqKi5cblxuU2luY2UgZ2NkKDJeOCwgM14zKSA9IDEsIHdlIGNhbiBhcHBseSB0aGVvcmVtcyBhYm91dCBncm91cHMgd2hvc2Ugb3JkZXIgaXMgYSBwcm9kdWN0IG9mIGNvcHJpbWUgcHJpbWUgcG93ZXJzLlxuXG4jIyBLZXkgU3RydWN0dXJhbCBUaGVvcmVtXG5cbioqVGhlb3JlbSoqOiBJZiBHIGhhcyBvcmRlciAkbiA9IHBeYSBcXGNkb3QgcV5iJCB3aGVyZSBwLCBxIGFyZSBkaXN0aW5jdCBwcmltZXMsIGFuZCBpZiBib3RoIHRoZSBTeWxvdyBwLXN1Ymdyb3VwIGFuZCBTeWxvdyBxLXN1Ymdyb3VwIGFyZSB1bmlxdWUgKGhlbmNlIG5vcm1hbCksIHRoZW46XG4kJEcgXFxjb25nIFAgXFx0aW1lcyBRJCRcbndoZXJlIFAgaXMgdGhlIFN5bG93IHAtc3ViZ3JvdXAgYW5kIFEgaXMgdGhlIFN5bG93IHEtc3ViZ3JvdXAuXG5cbiMjIEFwcGx5aW5nIFN5bG93IFRoZW9yeVxuXG4jIyMgU3lsb3cgMi1zdWJncm91cHNcbi0gJG5fMiBcXGVxdWl2IDEgXFxwbW9kezJ9JCBhbmQgJG5fMiB8IDI3JFxuLSBQb3NzaWJsZSB2YWx1ZXM6ICRuXzIgXFxpbiBcXHsxLCAzLCA5LCAyN1xcfSRcblxuIyMjIFN5bG93IDMtc3ViZ3JvdXBzICBcbi0gJG5fMyBcXGVxdWl2IDEgXFxwbW9kezN9JCBhbmQgJG5fMyB8IDI1NiRcbi0gUG9zc2libGUgdmFsdWVzOiAkbl8zIFxcaW4gXFx7MSwgNCwgMTYsIDY0LCAyNTZcXH0kXG5cbiMjIyBDcml0aWNhbCBPYnNlcnZhdGlvblxuXG5Gb3IgYW55IGdyb3VwIEcgb2Ygb3JkZXIgMl44IMK3IDNeMywgSSBjbGFpbSB0aGF0ICoqYm90aCoqICRuXzIgPSAxJCAqKmFuZCoqICRuXzMgPSAxJC5cblxuKipQcm9vZiBmb3IgJG5fMyA9IDEkOioqXG5JZiAkbl8zID4gMSQsIHRoZW4gJG5fMyBcXGdlcSA0JC4gRWFjaCBTeWxvdyAzLXN1Ymdyb3VwIGhhcyBvcmRlciAyNywifV0sInJvbGUiOiJhc3Npc3RhbnQifX0sInN0b3BSZWFzb24iOiJtYXhfdG9rZW5zIiwidXNhZ2UiOnsiY2FjaGVSZWFkSW5wdXRUb2tlbkNvdW50IjowLCJjYWNoZVJlYWRJbnB1dFRva2VucyI6MCwiY2FjaGVXcml0ZUlucHV0VG9rZW5Db3VudCI6MCwiY2FjaGVXcml0ZUlucHV0VG9rZW5zIjowLCJpbnB1dFRva2VucyI6ODksIm91dHB1dFRva2VucyI6MTAyNSwic2VydmVyVG9vbFVzYWdlIjp7fSwidG90YWxUb2tlbnMiOjExMTR9fQ==",
    rawSha256: "a7c57a1dd8bcd0306a0920ee875fe3bb59fed000a2b60857298dfd408c5a1463",
    decodedText:
      '{\n  "output": {\n    "message": {\n      "role": "assistant",\n      "content": [\n        {\n          "reasoningContent": {\n            "reasoningText": {\n              "text": "I need to determine the number of non-isomorphic groups of order $2^8 \\\\cdot 3^3 = 256 \\\\cdot 27 = 6912$.\\n\\nThis is a substantial problem. Let me work through this systematically using the Sylow theorems and direct products of Sylow subgroups.\\n\\nFirst, let me identify the key facts:\\n- Order = $2^8 \\\\cdot 3^3 = 6912$\\n- We need to count non-isomorphic groups of this order\\n\\nBy the Sylow theorems:\\n- Number of Sylow 2-subgroups: $n_2 \\\\equiv 1 \\\\pmod{2}$ and $n_2 | 3^3 = 27$\\n  So $n_2 \\\\in \\\\{1, 3, 9, 27\\\\}$\\n- Number of Sylow 3-subgroups: $n_3 \\\\equiv 1 \\\\pmod{3}$ and $n_3 | 2^8 = 256$\\n  So $n_3 \\\\in \\\\{1, 4, 16, 64, 256\\\\}$\\n\\nThe key approach is:\\n1. If both $n_2 = 1$ and $n_3 = 1$, then $G \\\\cong P_2 \\\\times P_3$ where $P_2$ is the unique Sylow 2-subgroup and $P_3$ is the unique Sylow 3-subgroup\\n2. Count groups of order $2^8$\\n3. Count groups of order $3^3$\\n4. Use the fact that groups of this order with unique Sylow subgroups are direct products\\n\\nActually, this problem is quite complex. Let me check if we can use known results about the number of groups of prime power orders.\\n\\nFrom group theory tables:\\n- Number of groups of order $2^8 = 256$: This is 56092\\n- Number of groups of order $3^3 = 27$: There are exactly 5 non-isomorphic groups of order $p^3$ for any prime $p$\\n\\nFor groups of order $2^8 \\\\cdot 3^3$, I need to consider how these Sylow subgroups interact. When both Sylow subgroups are unique (normal), the group is a direct product, giving 56092 × 5 possibilities. But I also need to account for cases where the Sylow subgroups aren\'t unique, which involves analyzing possible extensions and semidirect products.",\n              "signature": "Eq8NCn4IEhABGAIqQFO4h3wlJv2WdErNoyDk5LbbZP670j+JkrkthUkP7Xfk9oZ7w6XDOtZi2x/NkreLc6gn2MrFkLS79M67jhMkfv0yGmNsYXVkZS1zb25uZXQtNC01LTIwMjUwOTI5OABCCHRoaW5raW5nWgwwNTgyNjQyMTk1ODcSDAVnW7bVVDUarlGTLRoMP7hQUulrbxQ9n5dLIjDUbY/Cn1wWnLJsOc1TZ4drD8oMtFvRD4XUfWKHb8HNfGnoN1229QXdoEbAPKNZvsgq3gt087H1zhBqGQosu1lVSbb3XebIEVN4DjQ3G3SMaGYtQQS9GiJvDFZO2Xi9VK8lj0bCxNt0Bgm8NZvaTsst8xk/+qvUedPlGqLurboYK9dAbh46HR5HICSXsh10qBZ1mmzzu4F7SoKOWYhQ+9BHScf2Uf9kjdFMM1TtvMcU82bhUnwCbugbMGtScBK5TscGdrnNci4m/RZF0/7q+1I6X70ienp0mzEXltARjCGABgdpWRdCifqUE3mVkNlVni8zpvaAXoJ6BLKj/1q/w4w3DFkedaIKkXiF4Kf7cd/W3NFTDIAn65TTBzrZPpVV5EJcIW7/MvFPBcyWtnODtnb0MiL3oB8gYP6Rb7S3NLuaIzHD2eZPMj5gCOpFJboJrwoOd3EfqwWEP3b0M1Np31VwrrSagOvrbqQyk6im0ZVdk59M0bqGenkPLTZdjDWo19WAljomvKiLcX7/ZjP0VMgda5c0a10XCmlcVkqN4nOfBYq0N4SHqkPiabUAJHFQ4FxFuPBNdWLq5luYMJy2JZ7qB6VJMjh/Y2tiHsCH1ucdVmGsb30JAFPh4Bqp1iUjseLY3u7772R9Y5CA3Rf0Rwq8FpnBVRFdkY5dUkledp7MzKv0AXnuNWq5HKz7Z53IBmap+H16sW+GMdI3u8DVdDeuJzsdkZ7nwELKOIhwsGH5oDTpFlA2VgjBmSEWa2Nm8CzNwd96xd27pGv/58+rO35IU8ZGPpAr5pLDq+vD2Np/wbTXaYwwHE25PgrcSPTk9eeLEok6H0LmGwgcX6xk6HEtD3yV5OYzt/mkJW71YqOFk+5LKMrnECrpF7CId557ysjzt4dS9VOT3ZGtTycaEz0woMzGWbGqTnbqsSPcM7xAIq2KstxPP0GR+Z3yKfelcW+i/Er1fntkz0FIDF13OUiZcnZ6JSLqrQhAKrpNtZeG5mndlvAsrMpG7f6eKUy4LQGhMIU5Wygtp2FZzZb7LSwYj766XCys0MKVNlpaJMeCKqB4cPsin2U0ce7gnlLdAZs3jwcyCQwjDg4cNLeCc5gBv6y8MWGhyFtTUCATlWI8kTe0eL1DMiwH8Wo98LAmjZW6bJQ53HOoUH2hvPsPhyDZKphz54yEOtftenq0wG68AmUaOeZIrBij8AJkJSKcmqQ+D8SjK+TuPNnH9SsgQA+4vfO6FZeeIF9wQ/Wnje9FoXolNJstqOs3nbrY7Fugr6jQotLQnlBRGEjCzPF6tCsewzC00cXsrH5lSLsK91moBlcOmJtERbDJdjxYMsS+mvQ0rc7kw9t2SLcQ5LtNSco1gq7YZO+nNZxE85YPrnsNxykQyGAFyd8fZkkvmpjaA7zKQLMRG/z6Z877NP1mnGzvrRCMhz7z/63C3sBkkWo5+2w5hnUxopH/sD8r5fXHvXlOSPhL1veYwQ/13X3yH264ZjGNy+6rvAVYoVfnQrvDSDo8oZUFoQtr+vzuvnyCj8KTLX8Oc4JjlTwBNOYFcRbx692xKSxw9rvyR0vIL4WK7VpI4rg/NrjEs1mAgn6EzAkg8veJXSYLJeatqjpIFWORkYAuwPCBxOA8VVv50/DozaMaBr7YiSn/bq4P9R1dFSzQuDvBiBltcAMJUki3IkKUEPhsaMLHQPnJuOXNNqhHczQ5WGoS99Qf1VCFBk5Efi8zSHNP5qWqlx2jeIoL6SBj1L6oECZyVqmBomrsTNJ5qCqM1+LBkx1GTaVo8k1Ok9YY02hniEmq7JEAEPcIGN69DMEtpuMheKmKniClKOKVytiVb5/X82qzEAHy6kHe+LoGoPxoLnLAiUXQTlTfiBcIajykOyKK0EIfv0+2/W+OM86suLAW0+sC8hGHhCFbkMX3pMnB1cYnQtJR1cQBJU+im5+q5OXCFM8Gv4ULB1ZToebBHBN96eSYo0qh3NjK5A/fnu/JNTT1fHi/tGZzfZSHWMsAsB6iXuGV9++Y9/0WyTiWWqXs6rxzy1+03sU44eZcdBiHfX4eso613pPKNkT5+RgB"\n            }\n          }\n        },\n        {\n          "text": "# Classification of Groups of Order 2^8 · 3^3\\n\\n## Order and Basic Setup\\n\\nWe seek to classify groups of order **n = 2^8 · 3^3 = 256 · 27 = 6912**.\\n\\nSince gcd(2^8, 3^3) = 1, we can apply theorems about groups whose order is a product of coprime prime powers.\\n\\n## Key Structural Theorem\\n\\n**Theorem**: If G has order $n = p^a \\\\cdot q^b$ where p, q are distinct primes, and if both the Sylow p-subgroup and Sylow q-subgroup are unique (hence normal), then:\\n$$G \\\\cong P \\\\times Q$$\\nwhere P is the Sylow p-subgroup and Q is the Sylow q-subgroup.\\n\\n## Applying Sylow Theory\\n\\n### Sylow 2-subgroups\\n- $n_2 \\\\equiv 1 \\\\pmod{2}$ and $n_2 | 27$\\n- Possible values: $n_2 \\\\in \\\\{1, 3, 9, 27\\\\}$\\n\\n### Sylow 3-subgroups  \\n- $n_3 \\\\equiv 1 \\\\pmod{3}$ and $n_3 | 256$\\n- Possible values: $n_3 \\\\in \\\\{1, 4, 16, 64, 256\\\\}$\\n\\n### Critical Observation\\n\\nFor any group G of order 2^8 · 3^3, I claim that **both** $n_2 = 1$ **and** $n_3 = 1$.\\n\\n**Proof for $n_3 = 1$:**\\nIf $n_3 > 1$, then $n_3 \\\\geq 4$. Each Sylow 3-subgroup has order 27,"\n        }\n      ]\n    }\n  },\n  "stopReason": "max_tokens",\n  "usage": {\n    "inputTokens": 89,\n    "outputTokens": 1025,\n    "totalTokens": 1114,\n    "cacheReadInputTokens": 0,\n    "cacheWriteInputTokens": 0\n  },\n  "metrics": {\n    "latencyMs": 16600\n  },\n  "$metadata": {\n    "httpStatusCode": 200,\n    "requestId": "86799e3d-e583-4be4-9e20-9fdda9ef6143",\n    "attempts": 1,\n    "totalRetryDelay": 0\n  }\n}',
    decodedSha256: "54c8c560433ca7524c6465b56238a6b487876385d2d973d02d326211c69748b7",
    http: {
      statusCode: 200,
      contentType: "application/json",
      requestId: "86799e3d-e583-4be4-9e20-9fdda9ef6143",
    },
    decoded: {
      wire: "converse",
      stream: false,
      body: {
        output: {
          message: {
            role: "assistant",
            content: [
              {
                reasoningContent: {
                  reasoningText: {
                    text: "I need to determine the number of non-isomorphic groups of order $2^8 \\cdot 3^3 = 256 \\cdot 27 = 6912$.\n\nThis is a substantial problem. Let me work through this systematically using the Sylow theorems and direct products of Sylow subgroups.\n\nFirst, let me identify the key facts:\n- Order = $2^8 \\cdot 3^3 = 6912$\n- We need to count non-isomorphic groups of this order\n\nBy the Sylow theorems:\n- Number of Sylow 2-subgroups: $n_2 \\equiv 1 \\pmod{2}$ and $n_2 | 3^3 = 27$\n  So $n_2 \\in \\{1, 3, 9, 27\\}$\n- Number of Sylow 3-subgroups: $n_3 \\equiv 1 \\pmod{3}$ and $n_3 | 2^8 = 256$\n  So $n_3 \\in \\{1, 4, 16, 64, 256\\}$\n\nThe key approach is:\n1. If both $n_2 = 1$ and $n_3 = 1$, then $G \\cong P_2 \\times P_3$ where $P_2$ is the unique Sylow 2-subgroup and $P_3$ is the unique Sylow 3-subgroup\n2. Count groups of order $2^8$\n3. Count groups of order $3^3$\n4. Use the fact that groups of this order with unique Sylow subgroups are direct products\n\nActually, this problem is quite complex. Let me check if we can use known results about the number of groups of prime power orders.\n\nFrom group theory tables:\n- Number of groups of order $2^8 = 256$: This is 56092\n- Number of groups of order $3^3 = 27$: There are exactly 5 non-isomorphic groups of order $p^3$ for any prime $p$\n\nFor groups of order $2^8 \\cdot 3^3$, I need to consider how these Sylow subgroups interact. When both Sylow subgroups are unique (normal), the group is a direct product, giving 56092 × 5 possibilities. But I also need to account for cases where the Sylow subgroups aren't unique, which involves analyzing possible extensions and semidirect products.",
                    signature:
                      "Eq8NCn4IEhABGAIqQFO4h3wlJv2WdErNoyDk5LbbZP670j+JkrkthUkP7Xfk9oZ7w6XDOtZi2x/NkreLc6gn2MrFkLS79M67jhMkfv0yGmNsYXVkZS1zb25uZXQtNC01LTIwMjUwOTI5OABCCHRoaW5raW5nWgwwNTgyNjQyMTk1ODcSDAVnW7bVVDUarlGTLRoMP7hQUulrbxQ9n5dLIjDUbY/Cn1wWnLJsOc1TZ4drD8oMtFvRD4XUfWKHb8HNfGnoN1229QXdoEbAPKNZvsgq3gt087H1zhBqGQosu1lVSbb3XebIEVN4DjQ3G3SMaGYtQQS9GiJvDFZO2Xi9VK8lj0bCxNt0Bgm8NZvaTsst8xk/+qvUedPlGqLurboYK9dAbh46HR5HICSXsh10qBZ1mmzzu4F7SoKOWYhQ+9BHScf2Uf9kjdFMM1TtvMcU82bhUnwCbugbMGtScBK5TscGdrnNci4m/RZF0/7q+1I6X70ienp0mzEXltARjCGABgdpWRdCifqUE3mVkNlVni8zpvaAXoJ6BLKj/1q/w4w3DFkedaIKkXiF4Kf7cd/W3NFTDIAn65TTBzrZPpVV5EJcIW7/MvFPBcyWtnODtnb0MiL3oB8gYP6Rb7S3NLuaIzHD2eZPMj5gCOpFJboJrwoOd3EfqwWEP3b0M1Np31VwrrSagOvrbqQyk6im0ZVdk59M0bqGenkPLTZdjDWo19WAljomvKiLcX7/ZjP0VMgda5c0a10XCmlcVkqN4nOfBYq0N4SHqkPiabUAJHFQ4FxFuPBNdWLq5luYMJy2JZ7qB6VJMjh/Y2tiHsCH1ucdVmGsb30JAFPh4Bqp1iUjseLY3u7772R9Y5CA3Rf0Rwq8FpnBVRFdkY5dUkledp7MzKv0AXnuNWq5HKz7Z53IBmap+H16sW+GMdI3u8DVdDeuJzsdkZ7nwELKOIhwsGH5oDTpFlA2VgjBmSEWa2Nm8CzNwd96xd27pGv/58+rO35IU8ZGPpAr5pLDq+vD2Np/wbTXaYwwHE25PgrcSPTk9eeLEok6H0LmGwgcX6xk6HEtD3yV5OYzt/mkJW71YqOFk+5LKMrnECrpF7CId557ysjzt4dS9VOT3ZGtTycaEz0woMzGWbGqTnbqsSPcM7xAIq2KstxPP0GR+Z3yKfelcW+i/Er1fntkz0FIDF13OUiZcnZ6JSLqrQhAKrpNtZeG5mndlvAsrMpG7f6eKUy4LQGhMIU5Wygtp2FZzZb7LSwYj766XCys0MKVNlpaJMeCKqB4cPsin2U0ce7gnlLdAZs3jwcyCQwjDg4cNLeCc5gBv6y8MWGhyFtTUCATlWI8kTe0eL1DMiwH8Wo98LAmjZW6bJQ53HOoUH2hvPsPhyDZKphz54yEOtftenq0wG68AmUaOeZIrBij8AJkJSKcmqQ+D8SjK+TuPNnH9SsgQA+4vfO6FZeeIF9wQ/Wnje9FoXolNJstqOs3nbrY7Fugr6jQotLQnlBRGEjCzPF6tCsewzC00cXsrH5lSLsK91moBlcOmJtERbDJdjxYMsS+mvQ0rc7kw9t2SLcQ5LtNSco1gq7YZO+nNZxE85YPrnsNxykQyGAFyd8fZkkvmpjaA7zKQLMRG/z6Z877NP1mnGzvrRCMhz7z/63C3sBkkWo5+2w5hnUxopH/sD8r5fXHvXlOSPhL1veYwQ/13X3yH264ZjGNy+6rvAVYoVfnQrvDSDo8oZUFoQtr+vzuvnyCj8KTLX8Oc4JjlTwBNOYFcRbx692xKSxw9rvyR0vIL4WK7VpI4rg/NrjEs1mAgn6EzAkg8veJXSYLJeatqjpIFWORkYAuwPCBxOA8VVv50/DozaMaBr7YiSn/bq4P9R1dFSzQuDvBiBltcAMJUki3IkKUEPhsaMLHQPnJuOXNNqhHczQ5WGoS99Qf1VCFBk5Efi8zSHNP5qWqlx2jeIoL6SBj1L6oECZyVqmBomrsTNJ5qCqM1+LBkx1GTaVo8k1Ok9YY02hniEmq7JEAEPcIGN69DMEtpuMheKmKniClKOKVytiVb5/X82qzEAHy6kHe+LoGoPxoLnLAiUXQTlTfiBcIajykOyKK0EIfv0+2/W+OM86suLAW0+sC8hGHhCFbkMX3pMnB1cYnQtJR1cQBJU+im5+q5OXCFM8Gv4ULB1ZToebBHBN96eSYo0qh3NjK5A/fnu/JNTT1fHi/tGZzfZSHWMsAsB6iXuGV9++Y9/0WyTiWWqXs6rxzy1+03sU44eZcdBiHfX4eso613pPKNkT5+RgB",
                  },
                },
              },
              {
                text: "# Classification of Groups of Order 2^8 · 3^3\n\n## Order and Basic Setup\n\nWe seek to classify groups of order **n = 2^8 · 3^3 = 256 · 27 = 6912**.\n\nSince gcd(2^8, 3^3) = 1, we can apply theorems about groups whose order is a product of coprime prime powers.\n\n## Key Structural Theorem\n\n**Theorem**: If G has order $n = p^a \\cdot q^b$ where p, q are distinct primes, and if both the Sylow p-subgroup and Sylow q-subgroup are unique (hence normal), then:\n$$G \\cong P \\times Q$$\nwhere P is the Sylow p-subgroup and Q is the Sylow q-subgroup.\n\n## Applying Sylow Theory\n\n### Sylow 2-subgroups\n- $n_2 \\equiv 1 \\pmod{2}$ and $n_2 | 27$\n- Possible values: $n_2 \\in \\{1, 3, 9, 27\\}$\n\n### Sylow 3-subgroups  \n- $n_3 \\equiv 1 \\pmod{3}$ and $n_3 | 256$\n- Possible values: $n_3 \\in \\{1, 4, 16, 64, 256\\}$\n\n### Critical Observation\n\nFor any group G of order 2^8 · 3^3, I claim that **both** $n_2 = 1$ **and** $n_3 = 1$.\n\n**Proof for $n_3 = 1$:**\nIf $n_3 > 1$, then $n_3 \\geq 4$. Each Sylow 3-subgroup has order 27,",
              },
            ],
          },
        },
        stopReason: "max_tokens",
        usage: {
          inputTokens: 89,
          outputTokens: 1025,
          totalTokens: 1114,
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 0,
        },
        metrics: { latencyMs: 16600 },
        $metadata: {
          httpStatusCode: 200,
          requestId: "86799e3d-e583-4be4-9e20-9fdda9ef6143",
          attempts: 1,
          totalRetryDelay: 0,
        },
      },
    },
  },
  {
    fault: "K9",
    rawBase64:
      "AAAAkgAAAFJLgZvBCzpldmVudC10eXBlBwAMbWVzc2FnZVN0YXJ0DTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dSIsInJvbGUiOiJhc3Npc3RhbnQifVMJx7gAAADiAAAAV8I5j4ELOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjowLCJkZWx0YSI6eyJyZWFzb25pbmdDb250ZW50Ijp7InRleHQiOiJJIG5lZWQgdG8gZGV0ZXJtaW5lIn19LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHIn35z8brAAABBQAAAFeTkUfrCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MCwiZGVsdGEiOnsicmVhc29uaW5nQ29udGVudCI6eyJ0ZXh0IjoiIHRoZSBudW1iZXIgb2Ygbm9uLWlzb21vcnBoaWMifX0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaMDEyMzQ1In19HtjPAAAA4AAAAFe4+dzhCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MCwiZGVsdGEiOnsicmVhc29uaW5nQ29udGVudCI6eyJ0ZXh0IjoiIGdyb3VwcyBvZiBvcmRlciAkMl44ICJ9fSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUIifY/QigYAAADbAAAAV24IVXYLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjowLCJkZWx0YSI6eyJyZWFzb25pbmdDb250ZW50Ijp7InRleHQiOiJcXGNkb3QgM14zICJ9fSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0gifYml4GoAAADzAAAAV5+5MbMLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjowLCJkZWx0YSI6eyJyZWFzb25pbmdDb250ZW50Ijp7InRleHQiOiI9IDI1NiBcXGNkb3QgIn19LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWjAxMjMifYtfiFUAAADVAAAAV9E46xcLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjowLCJkZWx0YSI6eyJyZWFzb25pbmdDb250ZW50Ijp7InRleHQiOiIyNyA9IDY5MTIkLiJ9fSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUIifTrsR20AAADvAAAAVzqpSzALOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjowLCJkZWx0YSI6eyJyZWFzb25pbmdDb250ZW50Ijp7InRleHQiOiJcblxuVGhpcyJ9fSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNCJ9tlSjdgAAAMAAAABXeTjz5Qs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjAsImRlbHRhIjp7InJlYXNvbmluZ0NvbnRlbnQiOnsidGV4dCI6IiBpcyBhIHZlcnkifX0sInAiOiJhYmNkZWZnaCJ9r8YoYAAAAL8AAABXArqE+ws6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjAsImRlbHRhIjp7InJlYXNvbmluZ0NvbnRlbnQiOnsidGV4dCI6IiBkaWZmaWN1bHQifX0sInAiOiJhYmNkZWZnIn1qkv64AAAA/AAAAFcd6aZiCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MCwiZGVsdGEiOnsicmVhc29uaW5nQ29udGVudCI6eyJ0ZXh0IjoiIHByb2JsZW0uIExldCBtZSB3b3JrIn19LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWjAxMjM0In0sUKzZAAAA3wAAAFebiPO2CzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MCwiZGVsdGEiOnsicmVhc29uaW5nQ29udGVudCI6eyJ0ZXh0IjoiIHRocm91Z2ggdGhpcyJ9fSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSiJ9C0tJgwAAAOkAAABXtem+kAs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjAsImRlbHRhIjp7InJlYXNvbmluZ0NvbnRlbnQiOnsidGV4dCI6IiBzeXN0ZW1hdGljYWxseS5cblxuRmlyc3QsIEkifX0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFIn21KiftAAAAwQAAAFdEWNpVCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MCwiZGVsdGEiOnsicmVhc29uaW5nQ29udGVudCI6eyJ0ZXh0IjoiJ2xsIn19LCJwIjoiYWJjZGVmZ2hpamtsbW5vcCJ9GZWT5AAAAOAAAABXuPnc4Qs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjAsImRlbHRhIjp7InJlYXNvbmluZ0NvbnRlbnQiOnsidGV4dCI6IiB1c2UifX0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUIn16wd2tAAAA1AAAAFfsWMKnCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MCwiZGVsdGEiOnsicmVhc29uaW5nQ29udGVudCI6eyJ0ZXh0IjoiIHRoZSBmYWN0IHRoYXQgaWYgJCJ9fSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnMifZfTZq8AAADHAAAAV8sYL/ULOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjowLCJkZWx0YSI6eyJyZWFzb25pbmdDb250ZW50Ijp7InRleHQiOiJcXCJ9fSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3In1aprSQAAAA7wAAAFc6qUswCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MCwiZGVsdGEiOnsicmVhc29uaW5nQ29udGVudCI6eyJ0ZXh0IjoiZ2NkKG0ifX0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaMDEyMzQ1NjcifXMOD0QAAADXAAAAV6v4uHcLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjowLCJkZWx0YSI6eyJyZWFzb25pbmdDb250ZW50Ijp7InRleHQiOiIsIn19LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTiJ9E1imZAAAAOIAAABXwjmPgQs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjAsImRlbHRhIjp7InJlYXNvbmluZ0NvbnRlbnQiOnsidGV4dCI6Im4pID0gMSQsIHRoZW4ifX0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE0ifaPT5tgAAADNAAAAV4GoN1QLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjowLCJkZWx0YSI6eyJyZWFzb25pbmdDb250ZW50Ijp7InRleHQiOiIgdGhlIn19LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBIn1D1NpUAAAA1wAAAFer+Lh3CzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MCwiZGVsdGEiOnsicmVhc29uaW5nQ29udGVudCI6eyJ0ZXh0IjoiIG51bWJlciJ9fSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0gifbyD134AAADLAAAAVw7owvQLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjowLCJkZWx0YSI6eyJyZWFzb25pbmdDb250ZW50Ijp7InRleHQiOiIgb2YgZ3JvdXBzIn19LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFycyJ9z6ABfAAAAMQAAABXjLhVJQs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjAsImRlbHRhIjp7InJlYXNvbmluZ0NvbnRlbnQiOnsidGV4dCI6IiBvZiBvcmRlciAkbW4ifX0sInAiOiJhYmNkZWZnaGkifTVP13MAAADyAAAAV6LZGAMLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjowLCJkZWx0YSI6eyJyZWFzb25pbmdDb250ZW50Ijp7InRleHQiOiIkIGRlcGVuZHMifX0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaMDEyMzQ1NiJ9Bo1jbAAAAOAAAABXuPnc4Qs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjAsImRlbHRhIjp7InJlYXNvbmluZ0NvbnRlbnQiOnsidGV4dCI6IiBvbiJ9fSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSU1RVIn3RWNoWAAAA7AAAAFd9CTHgCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MCwiZGVsdGEiOnsicmVhc29uaW5nQ29udGVudCI6eyJ0ZXh0IjoiIHRoZSBncm91cHMifX0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFkifaaPxasAAADzAAAAV5+5MbMLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjowLCJkZWx0YSI6eyJyZWFzb25pbmdDb250ZW50Ijp7InRleHQiOiIgb2Ygb3JkZXJzIn19LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWjAxMjM0NTYiffx06BkAAADEAAAAV4y4VSULOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjowLCJkZWx0YSI6eyJyZWFzb25pbmdDb250ZW50Ijp7InRleHQiOiIgJCJ9fSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0In0U7bR0AAAA6gAAAFfyScRACzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MCwiZGVsdGEiOnsicmVhc29uaW5nQ29udGVudCI6eyJ0ZXh0IjoibSQgYW5kICRuJCJ9fSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSU1RVVldYIn2+MehjAAAAwQAAAFdEWNpVCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MCwiZGVsdGEiOnsicmVhc29uaW5nQ29udGVudCI6eyJ0ZXh0IjoiIGFuZCJ9fSwicCI6ImFiY2RlZmdoaWprbG1ubyJ9bt5IhQAAALYAAABXD6rmigs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjAsImRlbHRhIjp7InJlYXNvbmluZ0NvbnRlbnQiOnsidGV4dCI6IiBob3cifX0sInAiOiJhYmNkIn3ybcTnAAAA2QAAAFcUyAYWCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MCwiZGVsdGEiOnsicmVhc29uaW5nQ29udGVudCI6eyJ0ZXh0IjoiIHRoZXkgY2FuIn19LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSCJ9WNtVKAAAAOkAAABXtem+kAs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjAsImRlbHRhIjp7InJlYXNvbmluZ0NvbnRlbnQiOnsidGV4dCI6IiBpbnRlcmFjdCJ9fSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSU1RVVldYIn1SPxk4AAAAugAAAFfKWguLCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MCwiZGVsdGEiOnsicmVhc29uaW5nQ29udGVudCI6eyJ0ZXh0IjoiLlxuXG5TaW5jZSJ9fSwicCI6ImFiIn3MYNuaAAAAwAAAAFd5OPPlCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MCwiZGVsdGEiOnsicmVhc29uaW5nQ29udGVudCI6eyJ0ZXh0IjoiICRcXGdjZCgyIn19LCJwIjoiYWJjZGVmZ2hpIn0hc/17AAAA0AAAAFcZ2GRnCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MCwiZGVsdGEiOnsicmVhc29uaW5nQ29udGVudCI6eyJ0ZXh0IjoiXjgsIDNeMykifX0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5eiJ9nC2aKQAAAMIAAABXA/ighQs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjAsImRlbHRhIjp7InJlYXNvbmluZ0NvbnRlbnQiOnsidGV4dCI6IiA9IDEkLCBJIn19LCJwIjoiYWJjZGVmZ2hpamtsIn16Y3nLAAAA4AAAAFe4+dzhCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MCwiZGVsdGEiOnsicmVhc29uaW5nQ29udGVudCI6eyJ0ZXh0IjoiIGNhbiJ9fSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSU1QifaaXDS4AAADrAAAAV88p7fALOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjowLCJkZWx0YSI6eyJyZWFzb25pbmdDb250ZW50Ijp7InRleHQiOiIgdXNlIHJlc3VsdHMifX0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXIn0nJhjJAAAA2gAAAFdTaHzGCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MCwiZGVsdGEiOnsicmVhc29uaW5nQ29udGVudCI6eyJ0ZXh0IjoiIGFib3V0In19LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0wifSvHEFsAAADjAAAAV/9ZpjELOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjowLCJkZWx0YSI6eyJyZWFzb25pbmdDb250ZW50Ijp7InRleHQiOiIgZ3JvdXBzIn19LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVCJ90JwxHAAAAOMAAABX/1mmMQs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjAsImRlbHRhIjp7InJlYXNvbmluZ0NvbnRlbnQiOnsidGV4dCI6IiB3aG9zZSJ9fSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSU1RVIn1FWh2mAAAA1gAAAFeWmJHHCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MCwiZGVsdGEiOnsicmVhc29uaW5nQ29udGVudCI6eyJ0ZXh0IjoiIG9yZGVyIn19LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSCJ9pqrtOAAAAM0AAABXgag3VAs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjAsImRlbHRhIjp7InJlYXNvbmluZ0NvbnRlbnQiOnsidGV4dCI6IiBpcyBhIHByb2R1Y3QifX0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXIifWXtFS4AAADDAAAAVz6YiTULOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjowLCJkZWx0YSI6eyJyZWFzb25pbmdDb250ZW50Ijp7InRleHQiOiIgb2YgY29wIn19LCJwIjoiYWJjZGVmZ2hpamtsbW4ifaAizIoAAADUAAAAV+xYwqcLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjowLCJkZWx0YSI6eyJyZWFzb25pbmdDb250ZW50Ijp7InRleHQiOiJyaW1lIHByaW1lIn19LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQiJ9Tg4xgQAAAM4AAABXxghNhAs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjAsImRlbHRhIjp7InJlYXNvbmluZ0NvbnRlbnQiOnsidGV4dCI6IiBwb3dlcnMuXG5cbkxldCBtZSBkZW4ifX0sInAiOiJhYmNkZWZnaGlqIn3IJhvIAAAA7AAAAFd9CTHgCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MCwiZGVsdGEiOnsicmVhc29uaW5nQ29udGVudCI6eyJ0ZXh0Ijoib3RlOiJ9fSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDUifV2Mj7MAAADhAAAAV4WZ9VELOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjowLCJkZWx0YSI6eyJyZWFzb25pbmdDb250ZW50Ijp7InRleHQiOiJcbi0gJG4ifX0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlMifZYGl/oAAADFAAAAV7HYfJULOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjowLCJkZWx0YSI6eyJyZWFzb25pbmdDb250ZW50Ijp7InRleHQiOiJfIn19LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1diJ9K63rhwAAAOgAAABXiImXIAs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjAsImRlbHRhIjp7InJlYXNvbmluZ0NvbnRlbnQiOnsidGV4dCI6IjIifX0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaMDEyMzQifbetfOQAAADPAAAAV/toZDQLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjowLCJkZWx0YSI6eyJyZWFzb25pbmdDb250ZW50Ijp7InRleHQiOiIgIn19LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUYifcHbGzgAAADlAAAAV3AZU5ELOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjowLCJkZWx0YSI6eyJyZWFzb25pbmdDb250ZW50Ijp7InRleHQiOiI9ICQifX0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaIn0Y2RIBAAAA8AAAAFfYGUtjCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MCwiZGVsdGEiOnsicmVhc29uaW5nQ29udGVudCI6eyJ0ZXh0IjoiIG51bWJlciBvZiBub24ifX0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaIn3D2g/6AAAA0wAAAFdeeB63CzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MCwiZGVsdGEiOnsicmVhc29uaW5nQ29udGVudCI6eyJ0ZXh0IjoiLWlzb21vcnBoaWMgZ3JvdXBzIG9mIG9yZGVyICQifX0sInAiOiJhYmNkZWZnaCJ9wT/8UgAAAMwAAABXvMge5As6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjAsImRlbHRhIjp7InJlYXNvbmluZ0NvbnRlbnQiOnsidGV4dCI6IjJeOCAifX0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5eiJ9wJL9xQAAAPQAAABXLZntows6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjAsImRlbHRhIjp7InJlYXNvbmluZ0NvbnRlbnQiOnsidGV4dCI6Ij0gMjU2JFxuLSAkbiJ9fSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDUifc48zfsAAADhAAAAV4WZ9VELOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjowLCJkZWx0YSI6eyJyZWFzb25pbmdDb250ZW50Ijp7InRleHQiOiJfMyA9ICQgbnVtYmVyIG9mIG5vbiJ9fSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREUifcTQ978AAADnAAAAVwrZAPELOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjowLCJkZWx0YSI6eyJyZWFzb25pbmdDb250ZW50Ijp7InRleHQiOiItaXNvbW9ycGhpYyBncm91cHMgb2Ygb3JkZXIgJCJ9fSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUIifUJ5WSEAAADGAAAAV/Z4BkULOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjowLCJkZWx0YSI6eyJyZWFzb25pbmdDb250ZW50Ijp7InRleHQiOiIzXjMgPSAyNyQifX0sInAiOiJhYmNkZWZnaGlqa2xtbm8ifV91L6MAAADbAAAAV24IVXYLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjowLCJkZWx0YSI6eyJyZWFzb25pbmdDb250ZW50Ijp7InRleHQiOiJcblxuRnJvbSJ9fSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSksifVa3J+AAAADgAAAAV7j53OELOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjowLCJkZWx0YSI6eyJyZWFzb25pbmdDb250ZW50Ijp7InRleHQiOiIgc3RhbmRhcmQifX0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OTyJ9OXWlXwAAAMwAAABXvMge5As6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjAsImRlbHRhIjp7InJlYXNvbmluZ0NvbnRlbnQiOnsidGV4dCI6IiB0YWJsZXMifX0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2dyJ9YjMNSwAAANsAAABXbghVdgs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjAsImRlbHRhIjp7InJlYXNvbmluZ0NvbnRlbnQiOnsidGV4dCI6IjoifX0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUiJ9cu6ygwAAAOYAAABXN7kpQQs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjAsImRlbHRhIjp7InJlYXNvbmluZ0NvbnRlbnQiOnsidGV4dCI6IlxuLSBUaGVyZSJ9fSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSU1RVIn1yrz0UAAAA1QAAAFfROOsXCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MCwiZGVsdGEiOnsicmVhc29uaW5nQ29udGVudCI6eyJ0ZXh0IjoiIGFyZSAifX0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdIIn2lkB+RAAAAsgAAAFf6KkBKCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MCwiZGVsdGEiOnsicmVhc29uaW5nQ29udGVudCI6eyJ0ZXh0IjoiNTYifX0sInAiOiJhYiJ9jzwRkQAAANAAAABXGdhkZws6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjAsImRlbHRhIjp7InJlYXNvbmluZ0NvbnRlbnQiOnsidGV4dCI6IjA5MiJ9fSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREUifWB/ENcAAADgAAAAV7j53OELOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjowLCJkZWx0YSI6eyJyZWFzb25pbmdDb250ZW50Ijp7InRleHQiOiIgbm9uLWlzb21vcnBoaWMgZ3JvdXBzIG9mIn19LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eSJ97VB/qwAAAPoAAABXkqlTwgs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjAsImRlbHRhIjp7InJlYXNvbmluZ0NvbnRlbnQiOnsidGV4dCI6IiBvcmRlciAkMl44JFxuLSJ9fSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzgifarsoh4AAADfAAAAV5uI87YLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjowLCJkZWx0YSI6eyJyZWFzb25pbmdDb250ZW50Ijp7InRleHQiOiIgVGhlcmUgYXJlIDUifX0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLIn2jmQMBAAAA3wAAAFebiPO2CzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MCwiZGVsdGEiOnsicmVhc29uaW5nQ29udGVudCI6eyJ0ZXh0IjoiICJ9fSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSU1RVViJ9UcZUMAAAAOcAAABXCtkA8Qs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjAsImRlbHRhIjp7InJlYXNvbmluZ0NvbnRlbnQiOnsidGV4dCI6Im5vbi1pc29tb3JwaGljIGdyb3VwcyBvZiBvcmRlciJ9fSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QSJ9ppjpxQAAAPoAAABXkqlTwgs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjAsImRlbHRhIjp7InJlYXNvbmluZ0NvbnRlbnQiOnsidGV4dCI6IiAkM14zJFxuXG5Ib3dldmVyIn19LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWjAxMjM0NTYiffLz4eMAAADeAAAAV6bo2gYLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjowLCJkZWx0YSI6eyJyZWFzb25pbmdDb250ZW50Ijp7InRleHQiOiIsIGZpbmRpbmcifX0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE0ifbcLgKMAAADGAAAAV/Z4BkULOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjowLCJkZWx0YSI6eyJyZWFzb25pbmdDb250ZW50Ijp7InRleHQiOiIgdGhlIGV4YWN0IG51bWJlciJ9fSwicCI6ImFiY2RlZmcifbiUpa4AAADgAAAAV7j53OELOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjowLCJkZWx0YSI6eyJyZWFzb25pbmdDb250ZW50Ijp7InRleHQiOiIgb2YifX0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUVSJ9Ldr5HAAAAMcAAABXyxgv9Qs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjAsImRlbHRhIjp7InJlYXNvbmluZ0NvbnRlbnQiOnsidGV4dCI6IiBncm91cHMifX0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXIifYs0vKsAAADrAAAAV88p7fALOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjowLCJkZWx0YSI6eyJyZWFzb25pbmdDb250ZW50Ijp7InRleHQiOiIgb2Ygb3JkZXIgJDJeOCBcXCJ9fSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSIn3FDHk+AAAA+AAAAFfoaQCiCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MCwiZGVsdGEiOnsicmVhc29uaW5nQ29udGVudCI6eyJ0ZXh0IjoiY2RvdCAzXjMkIHJlcXVpcmVzIn19LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWjAxMjMifdvFBT8AAADZAAAAVxTIBhYLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjowLCJkZWx0YSI6eyJyZWFzb25pbmdDb250ZW50Ijp7InRleHQiOiIgdW5kZXJzdGFuZGluZyBhbGwifX0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5In3dFfIMAAAA5gAAAFc3uSlBCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MCwiZGVsdGEiOnsicmVhc29uaW5nQ29udGVudCI6eyJ0ZXh0IjoiIHBvc3NpYmxlIHNlbSJ9fSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFEiffqgsYwAAAEGAAAAV9QxPTsLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjowLCJkZWx0YSI6eyJyZWFzb25pbmdDb250ZW50Ijp7InRleHQiOiJpZGlyZWN0IHByb2R1Y3RzIGFuZCBleHRlbnNpb25zIn19LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWjAxMjM0In2K0KOoAAAAwgAAAFcD+KCFCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MCwiZGVsdGEiOnsicmVhc29uaW5nQ29udGVudCI6eyJ0ZXh0IjoiLCJ9fSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnMifY43/cUAAAD2AAAAV1dZvsMLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjowLCJkZWx0YSI6eyJyZWFzb25pbmdDb250ZW50Ijp7InRleHQiOiIgd2hpY2ggaXMgZXh0cmVtZWx5In19LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWjAifUnwLbwAAADHAAAAV8sYL/ULOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjowLCJkZWx0YSI6eyJyZWFzb25pbmdDb250ZW50Ijp7InRleHQiOiIgY29tcGxleCJ9fSwicCI6ImFiY2RlZmdoaWprbG1ub3BxIn3zQUAeAAAA+AAAAFfoaQCiCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MCwiZGVsdGEiOnsicmVhc29uaW5nQ29udGVudCI6eyJ0ZXh0IjoiLlxuXG5MZXQgbWUgdXNlIHRoZSJ9fSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIifYkcRV0AAADgAAAAV7j53OELOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjowLCJkZWx0YSI6eyJyZWFzb25pbmdDb250ZW50Ijp7InRleHQiOiIgZ2VuZXJhbCJ9fSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUCJ9iZ4d1gAAAMwAAABXvMge5As6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjAsImRlbHRhIjp7InJlYXNvbmluZ0NvbnRlbnQiOnsidGV4dCI6IiB0aGVvcnkifX0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2dyJ9SqFaxAAAAOIAAABXwjmPgQs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjAsImRlbHRhIjp7InJlYXNvbmluZ0NvbnRlbnQiOnsidGV4dCI6Ii4ifX0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFkifQLbN6oAAADbAAAAV24IVXYLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjowLCJkZWx0YSI6eyJyZWFzb25pbmdDb250ZW50Ijp7InRleHQiOiIgRm9yIn19LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk8ifefGwKQAAADdAAAAV+FIoNYLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjowLCJkZWx0YSI6eyJyZWFzb25pbmdDb250ZW50Ijp7InRleHQiOiIgY29wIn19LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUSJ9MyzsvgAAAOYAAABXN7kpQQs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjAsImRlbHRhIjp7InJlYXNvbmluZ0NvbnRlbnQiOnsidGV4dCI6InJpbWUgb3JkZXJzIn19LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTIn2i4KudAAAA0gAAAFdjGDcHCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MCwiZGVsdGEiOnsicmVhc29uaW5nQ29udGVudCI6eyJ0ZXh0IjoiLCJ9fSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJIn1nex4JAAAAtgAAAFcPquaKCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MCwiZGVsdGEiOnsicmVhc29uaW5nQ29udGVudCI6eyJ0ZXh0IjoiIHdlIn19LCJwIjoiYWJjZGUifTrWcuoAAAC5AAAAV436cVsLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjowLCJkZWx0YSI6eyJyZWFzb25pbmdDb250ZW50Ijp7InRleHQiOiIgbmVlZCJ9fSwicCI6ImFiY2RlZiJ9+bVtHgAAAOIAAABXwjmPgQs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjAsImRlbHRhIjp7InJlYXNvbmluZ0NvbnRlbnQiOnsidGV4dCI6IiB0byBjb3VudDoifX0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1AifcdgwBwAAADFAAAAV7HYfJULOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjowLCJkZWx0YSI6eyJyZWFzb25pbmdDb250ZW50Ijp7InRleHQiOiJcbjEuIERpcmVjdCJ9fSwicCI6ImFiY2RlZmdoaWprbCJ9ueC/EAAAANgAAABXKagvpgs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjAsImRlbHRhIjp7InJlYXNvbmluZ0NvbnRlbnQiOnsidGV4dCI6IiBwcm9kdWN0cyBvZiJ9fSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDRCJ9LjU4xAAAAM8AAABX+2hkNAs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjAsImRlbHRhIjp7InJlYXNvbmluZ0NvbnRlbnQiOnsidGV4dCI6IiBTeWxvdyBzdWIifX0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2dyJ9cfXOKAAAAOUAAABXcBlTkQs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjAsImRlbHRhIjp7InJlYXNvbmluZ0NvbnRlbnQiOnsidGV4dCI6Imdyb3Vwc1xuMi4gTm9uIn19LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk8ifbhgzFMAAADMAAAAV7zIHuQLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjowLCJkZWx0YSI6eyJyZWFzb25pbmdDb250ZW50Ijp7InRleHQiOiItdHJpdmlhbCBzZW0ifX0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXIifSAYdFIAAADUAAAAV+xYwqcLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjowLCJkZWx0YSI6eyJyZWFzb25pbmdDb250ZW50Ijp7InRleHQiOiJpZGlyZWN0IHByb2R1Y3RzIn19LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1diJ9Tfq7hgAAAOkAAABXtem+kAs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjAsImRlbHRhIjp7InJlYXNvbmluZ0NvbnRlbnQiOnsidGV4dCI6IlxuXG5UaGlzIn19LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZIn33VSwoAAAAzQAAAFeBqDdUCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MCwiZGVsdGEiOnsicmVhc29uaW5nQ29udGVudCI6eyJ0ZXh0IjoiIGlzIGEgcmVzZWFyY2gifX0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcSJ9Q9jU0gAAAMEAAABXRFjaVQs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjAsImRlbHRhIjp7InJlYXNvbmluZ0NvbnRlbnQiOnsidGV4dCI6Ii0ifX0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXIifY9yaZ4AAADYAAAAVymoL6YLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjowLCJkZWx0YSI6eyJyZWFzb25pbmdDb250ZW50Ijp7InRleHQiOiJsZXZlbCBjYWxjdWxhdGlvbiJ9fSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHkifeTTGcAAAADAAAAAV3k48+ULOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjowLCJkZWx0YSI6eyJyZWFzb25pbmdDb250ZW50Ijp7InRleHQiOiIuIExldCJ9fSwicCI6ImFiY2RlZmdoaWprbG0ifXeIMzMAAADQAAAAVxnYZGcLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjowLCJkZWx0YSI6eyJyZWFzb25pbmdDb250ZW50Ijp7InRleHQiOiIgbWUgd29yayJ9fSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6In12lSiSAAAAygAAAFcziOtECzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MCwiZGVsdGEiOnsicmVhc29uaW5nQ29udGVudCI6eyJ0ZXh0IjoiIHRocm91Z2gifX0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdCJ90pT1fAAAAMkAAABXdCiRlAs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjAsImRlbHRhIjp7InJlYXNvbmluZ0NvbnRlbnQiOnsidGV4dCI6IiB0aGUifX0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2dyJ9GFsERwAAAOcAAABXCtkA8Qs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjAsImRlbHRhIjp7InJlYXNvbmluZ0NvbnRlbnQiOnsidGV4dCI6IiB0aGVvcmV0aWNhbCBmcmFtZXdvcmsgY2FyZWZ1bGx5In19LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eSJ9KBYBAAAAANwAAABX3CiJZgs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjAsImRlbHRhIjp7InJlYXNvbmluZ0NvbnRlbnQiOnsidGV4dCI6Ii4ifX0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlMifc+HuaoAAADiAAAAV8I5j4ELOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjowLCJkZWx0YSI6eyJyZWFzb25pbmdDb250ZW50Ijp7InRleHQiOiIifX0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaIn02tHLiAAAH/gAAAFd6LMW6CzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MCwiZGVsdGEiOnsicmVhc29uaW5nQ29udGVudCI6eyJzaWduYXR1cmUiOiJFczBLQ240SUVoQUJHQUlxUVB6SUl4Rjl5dzRpbW53QkxIZkl1aXNyME5JdHpRVUFQbm5CSFJkQ21ycTU5M1lwOXNBZkJXR0hjSU12QlpvY0R4U0dtTzBSS2JVczNGUnZ6bFcyUnhReUdtTnNZWFZrWlMxemIyNXVaWFF0TkMwMUxUSXdNalV3T1RJNU9BQkNDSFJvYVc1cmFXNW5XZ3d3TlRneU5qUXlNVGsxT0RjU0RFUEFGMDdZR0Q2OHo2enJaeG9NM1dXaXR2czFscEw1Nzd6M0lqQWwwdTdiMDFRckU0NnNUMFpBN3VIMU8vdGNIVlFNeUl3NjJyZTlDNDhMeVlpTXEyZUQwNmdkTENIci9VazNHMkVxL0Fod0k4aVFvUFJiL2RvM3gyZmhrRFN4YXVxYXZkS0J4NnI3ZStGTWwza24xeHhzcHJ5ekUxVDloMWZ3cDJYcHlBclJMazFaVFloekk5WkNhanAvVVhSRTVtRXVnMGswaXZsc2VqY3VQZmdCN042UjVBS1NKckJ2T1NzU3A1YjBXcFEvdlBUc29YOUd1Z1o5Vy9EWGVaa2dMYmVrNmtJRndKaEFXdm5zS21saGJnWWtVU0NhUm5TazVCcHd2emZYWk9nSm5FTGNTQjZWdWtDc1lpODYxTkV2Q0N4dmdLMFRUNURjVzVyTE5YRWpWZ0FIcVNKNWxMOWZNZDZ2dFBjQWxIZXI2MTJHMGtvZ1NBekhPVEpVeDdmbGNqTjVhaklncE9ObkFXejl1dmZzUFROa25sMmhLemhRaUI0OHJNRUdoSTlLaDl5MElsa25CM0c5bWdjbmFxNTZudlVERkVPWUs5cUo1L29yNnVzdWJvNllJaEwxVEtvd2VocDVrd0MxNWNyRVNLSnJPZGN3VDBlR2wrM2lrYTc2bnNkdml2YzBmb3IrN0pKa3FnaDdqVUgrcFJMcWpUVGpZcDdIeU1pYTVYKzNxNzM2eTZYcWQ1b1BzcHJhUExxVlBFTloxUUNTYkF4aG1KU3RYUitTcmExMGFoVkwvZWNyVng5UGpDbW96Qkp4NDhibVRwc1plRnk2bnNXRDNsUUQ4Wm1mZ3pXZEY2VEEvOXBXVXVFcWtQeXpMMUUxOEZ3Y0ZpVEE2aGI3d2Z5RzVpUkpWbERlTjZMUmJCcERqOWtFTDJsald2MTVHZ0U1anU2MURzcGs1SlBhM0syUDYvdWR1ekNwdGxHU1VBRlo1M0tYZ2hQZndob3h6WTZuaE1IUGxMUzhDYitlR1RPREtQNnBCV09GR3BQNm9vb29JVUk4NXoyc0k5SGxNZGFGdVNueHhnSUZCMll5WXBKcHBLc0tpMnhLa2dkVldxY2tJT2tlTm1nQXNXNGh0aVBadGlTRkJCUkNGeExxMFk4TW5HT3k2TUovY1IxTEFzREVRZVNLZTVUK2VWSHJBc0VQT2lDNHpNQ3VCMnM1UHJLdEttRVpSbWRIUGN6a09WQU1ZRkY3WFpDSjkwVFAvRDNjdFMremV3TmNmNzFwM3FuQmxxaXVOUFFsNi9CeldieDVXbVE3alRNQlFRQWZoR2FNSlFDcUlpdEczaldxdWxSUTQwU1FjejVVVW4xdzBydkw4SEJPTDAzOERWc21KQ3Fab0QyMEJGdVRsK25rT1pFNWRjV21HV2lhU0RodGFUeWFNbmxEKzcxaHdTTjh5OU5aeG1wTU1vTDZtS3dOL2cydHkvMXF0dWJoVFJHblpKeXNkZ25YYVk2MXBzNmRZa0pOZjBJWmFlWFdjd0JrQ1diSktOSjc3Qm1OZk1NRGg2NW8vQVpaeVg0dk96UjlhZHI1cnR6VWhRWG42OWRUaEozQS9mNFVMYm95UW1RMmRCYmF5Y3VuV1J1cDBMR2MzM0ZYWmpGWk9YUUJzZHF4cFhLb1lXWWtXZW1NWGNmM3VkeUZzZnNxbXpGQ2hFREtrL2hxMmF2T0dyVGFJeVFIbUxrblNlZEFpc0h5eW8xUUlpb2hNYWxkaWxhSUpONjAwYzdWUW0wYmtraGxoUVdabzlPck1oa0tzckVkUGFFRTVpOXVhdW1ZY2V2Uk4zQVcwWk5KY2pmZnZiYzU5ckY0K2F4UG5oMXpFbUNuaWlJN1FnM2ZuOU8vUEN0MjN2SjBVTWRqVHlQYVJyUE1idVZrMjEyNkRYOFhQTmU3dGFnQnJtMm83QStuMTRVN1ppR1h0R3pjWTBxekcyZkZ1QS9EOFRFT0lLbktpZVVaMnNVUUp1Y0piRk9hZmxQN1BzMFVnanRNU051RFhxRTB2SDkwNXRqMGdiWjBpSlhuYW1JVXJHRzZnYXFwelhXQ0ZSZU5YRXl5ZHZxM0xiK1JJTEFWVDdCeU9USUFUU3JCVDB0Tk11MUtCb1lLaG5hVXkxZ29VSzBVK29WdjkzTHZpaGdCIn19LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZIn3w17z1AAAArwAAAFYVXSPvCzpldmVudC10eXBlBwAQY29udGVudEJsb2NrU3RvcA06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjowLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUSJ9SvtyDwAAAK0AAABXGJpAGQs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiIjIn0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzIn0xoNIFAAAAvQAAAFd4etebCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6IiBDbGFzc2lmaWNhdGlvbiJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1In1bJ2KcAAAAxQAAAFex2HyVCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6IiBvZiBHcm91cHMifSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0gifZPtfnoAAADEAAAAV4y4VSULOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiIG9mIE9yZGVyICJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHIn1vTYbpAAAAywAAAFcO6ML0CzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6IjJeOCDCtyJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVIifaJ8AlcAAACxAAAAV72KOpoLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiIDNeM1xuXG4jIyJ9LCJwIjoiYWJjZGVmZ2hpamtsbW4ifXEnKA0AAACuAAAAV186OskLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiIE9yZGVyIn0sInAiOiJhYmNkZWZnaGlqa2xtbm8iffCmR3cAAADFAAAAV7HYfJULOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiIENhbGN1bGF0aW9uIn0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRiJ9EdMcSQAAAKwAAABXJfppqQs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiJcbm4ifSwicCI6ImFiY2RlZmdoaWprbG1ub3Aifb9UhLsAAACtAAAAVxiaQBkLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiID0ifSwicCI6ImFiY2RlZmdoaWprbG1ub3BxciJ99yM58gAAAMAAAABXeTjz5Qs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiIgMl44IMK3IDMifSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDRCJ9rW31MAAAAMsAAABXDujC9As6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiJeMyAifSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSU1RVIn1A2RK/AAAA0AAAAFcZ2GRnCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6Ij0gMjU2IMK3IDI3ICJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUSJ9UpYzrAAAAN8AAABXm4jztgs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiI9IDY5MTJcblxuIyMifSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDUifeZdue8AAAC/AAAAVwK6hPsLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiIEZ1bmRhbWVudGFsIn0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5eiJ9N41wRAAAANEAAABXJLhN1ws6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiIgRnJhbWV3b3JrIn0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUIn16emHiAAAAvwAAAFcCuoT7CzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6IlxuXG5TaW5jZSJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkMifQwmiHgAAAC+AAAAVz/arUsLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiIGcifSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJIn3aVT1vAAAAzwAAAFf7aGQ0CzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6ImNkKDJeOCwgMyJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTIn2HSQLTAAAApgAAAFdvSnEICzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6Il4zKSA9IDEsIEkifSwicCI6ImFiYyJ9X1H+WAAAALsAAABX9zoiOws6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiInbGwifSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREUifY2JypQAAAC5AAAAV436cVsLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiIGFwcGx5In0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5eiJ9nhIG3QAAALcAAABXMsrPOgs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiIgdGhlIHRoZW9yeSBvZiBncm91cHMifSwicCI6ImFiY2RlZmdoaSJ9RHaROwAAANUAAABX0TjrFws6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiIgd2l0aCJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWjAxMiJ9n2HXLAAAAKEAAABX3WqtGAs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiIgY29wIn0sInAiOiJhYmNkIn2B8r7fAAAAxwAAAFfLGC/1CzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6InJpbWUgb3JkZXIifSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSiJ9NFYt9QAAAM8AAABX+2hkNAs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiIgZmFjdCJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWVyJ9uF0+PgAAAM0AAABXgag3VAs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiJvcml6YXRpb24ifSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFEifW4bLUAAAADHAAAAV8sYL/ULOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiLlxuXG4jIyMgU3RlcCJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHIn2amPuBAAAA0gAAAFdjGDcHCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6IiAxOiJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWjAxIn2dEaapAAAAtgAAAFcPquaKCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6IiBTeSJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoifbV3gY0AAAC6AAAAV8paC4sLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoibG93IFRoZW9yeSJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dncifaNA1GUAAADMAAAAV7zIHuQLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiIEZvdW5kYXRpb24ifSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU4ifViZwtQAAACnAAAAV1IqWLgLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiXG5cbkJ5In0sInAiOiJhYmNkZWZnaCJ96iikmgAAANIAAABXYxg3Bws6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiIgU3lsb3cgdGhlb3IifSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSUyJ9ANjuEwAAAKMAAABXp6r+eAs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiJlbXM6In0sInAiOiJhYmNkZWYifZmKKVMAAADJAAAAV3QokZQLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiXG4tICoqMiJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk8ifR5/KeIAAADVAAAAV9E46xcLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiLVN5bG93IHN1YiJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWV1gifXGhGAgAAAC9AAAAV3h615sLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiZ3JvdXAqKiJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkMifTV5pFUAAADBAAAAV0RY2lULOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiIFAifSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMIn2vb7D3AAAAwQAAAFdEWNpVCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6IuKCgiBoYXMifSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGRyJ9pG70PgAAALcAAABXMsrPOgs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiIgb3JkZXIifSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eCJ9VfQMbwAAAMIAAABXA/ighQs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiIgMl4ifSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMIn03VYA/AAAAvwAAAFcCuoT7CzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6IjgifSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSksifRW+K9kAAADiAAAAV8I5j4ELOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiID0gMjU2XG4tICoqMyJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWjAxMjM0NTY3In2lcGkvAAAA5gAAAFc3uSlBCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6Ii1TeWxvdyBzdWJncm91cCoqIFAifSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDUifXuhlP8AAADmAAAAVze5KUELOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0Ijoi4oKDIGhhcyBvcmRlciAzXiJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWjAxMjM0NTY3OCJ9Ud8hUAAAAMAAAABXeTjz5Qs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiIzID0gMjdcblxuRm9yIn0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5eiJ9e1geKQAAANMAAABXXngetws6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiIgbiJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWjAxMjMifR8lWMoAAADhAAAAV4WZ9VELOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiID0gNjkxMjpcbi0gbiJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWjAxMjM0NTYifWBl9cEAAADOAAAAV8YITYQLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0Ijoi4oKDIn0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWCJ9gN8MVQAAANIAAABXYxg3Bws6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiIgKCJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWjAxMiJ9eKDxwAAAALYAAABXD6rmigs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiJudW1iZXIifSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3In2bOkVcAAAApQAAAFco6gvYCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6IiBvZiAifSwicCI6ImFiY2RlZmdoIn1WqMEqAAAAzQAAAFeBqDdUCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6IjMtU3lsb3cgc3ViZ3JvdXBzIn0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISSJ9aVH9VwAAALoAAABXyloLiws6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiIpIGRpdiJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQiJ9lCqe4AAAAM8AAABX+2hkNAs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiJpZGVzIDI1NiJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVCJ9CwdGqwAAANcAAABXq/i4dws6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiIgYW5kIn0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaMDEyMzQ1In2nDPqmAAAAswAAAFfHSmn6CzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6IiBuIn0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3gifYo25PwAAAC4AAAAV7CaWOsLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0Ijoi4oKDIn0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCIn3vUlnJAAAAnwAAAFfDe6v/CzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6IiDiiaEifSwicCI6ImFiIn1cWuerAAAAwAAAAFd5OPPlCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6IiAxIChtb2QgMyJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNEIn0CQDCoAAAAsQAAAFe9ijqaCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6IilcbiAgIn0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzIn2cHHJJAAAAuQAAAFeN+nFbCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6IlBvc3NpYmxlIHZhbHVlczogMSwgNCJ9LCJwIjoiYWJjZGVmZ2hpamsifX2/yTwAAADGAAAAV/Z4BkULOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiLCAxNiJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk8ifbTVBxoAAAC/AAAAVwK6hPsLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiLCA2NCwgMjU2XG4tIn0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5eiJ9Y+rReQAAANcAAABXq/i4dws6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiIgbuKCgiBkaXYifSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowIn3tZQrCAAAA1AAAAFfsWMKnCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6ImlkZXMgMjcifSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVoifUswsgEAAADNAAAAV4GoN1QLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiIGFuZCBu4oKCICJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QIn18U+ABAAAA2AAAAFcpqC+mCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6IuKJoSAxIn0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaMDEyMzQ1In0Yfly+AAAA2wAAAFduCFV2CzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6IiAobW9kIDIpXG4gICJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWjAxIn0slz+LAAAAzwAAAFf7aGQ0CzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6IlBvc3NpYmxlIHZhbHVlczogMSwgIn0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdIIn1fx2QtAAAAuwAAAFf3OiI7CzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6IjMsIDksIDI3In0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5eiJ9YlkRIwAAAMUAAABXsdh8lQs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiJcblxuIyMjIFN0ZXAgMjoifSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDIn3y+BlpAAAAqwAAAFeX2rW5CzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6IiBFbnVtIn0sInAiOiJhYmNkZWZnaGlqa2xtIn12ibIyAAAAsAAAAFeA6hMqCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6ImVyYXRpb24gb2YgcCJ9LCJwIjoiYWJjZGVmZ2hpamsifaiiWccAAADEAAAAV4y4VSULOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiLUdyb3VwcyJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKIn2H9VM7AAAAuwAAAFf3OiI7CzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6IlxuXG4qKiJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQiJ9y3+QiAAAAMAAAABXeTjz5Qs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiJHcm91cHMifSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGRyJ9WyNw/QAAAMQAAABXjLhVJQs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiIgb2Ygb3JkZXIgMyJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUYiffa8uuIAAAC8AAAAV0Ua/isLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiXjMgPSAyNzoqKiJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eSJ9e8ksbAAAANEAAABXJLhN1ws6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiJcblRoZXJlIn0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXIn1XqiMpAAAAvgAAAFc/2q1LCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6IiBhcmUgZXhhY3RseSJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eSJ9l2wo3gAAALYAAABXD6rmigs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiIgKioifSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6In1avUUQAAAAzQAAAFeBqDdUCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6IjUqKiJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWVyJ9LdwflgAAAMoAAABXM4jrRAs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiIgbm9uLWlzb21vcnBoaWMgZ3JvdXBzOiJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoifR9L3AsAAACfAAAAV8N7q/8LOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiXG4xIn0sInAiOiJhYmMifTwR/eIAAAChAAAAV91qrRgLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiLiBDIn0sInAiOiJhYmNkZSJ9O8SzogAAAMsAAABXDujC9As6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiLigoIifSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSU1RVIn15WNA2AAAA1wAAAFer+Lh3CzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6IuKChyJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWjAxMjM0NTYifX+4t1wAAAC9AAAAV3h615sLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiIChjeWMifSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREUifbUA1U8AAACpAAAAV+0a5tkLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoibGljKSJ9LCJwIjoiYWJjZGVmZ2hpamtsIn2i2fp3AAAArAAAAFcl+mmpCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6IlxuMi4gQ+KCiSJ9LCJwIjoiYWJjZGVmZ2hpaiJ9bNMAfwAAAM4AAABXxghNhAs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiIgw5cifSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSU1RVVldYIn34algPAAAAywAAAFcO6ML0CzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6IiBD4oKDIn0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlMifU75LUYAAADYAAAAVymoL6YLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiXG4zLiBD4oKDIn0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaMDEifYGMF9oAAAC/AAAAVwK6hPsLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiIMOXIEPigoMifSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDRCJ9VGu4lgAAALcAAABXMsrPOgs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiIgw5cifSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QSJ9Lbl/RwAAANMAAABXXngetws6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiIgQ+KCg1xuNC4gTm9uIn0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlMifUd5rr4AAADVAAAAV9E46xcLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiLWFiZWxpYW4gZ3JvdXAifSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSU1QifTZuo1EAAAC0AAAAV3VqteoLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiIChzZW0ifSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXYiff/ytdQAAACuAAAAV186OskLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiaWRpcmVjdCBwcm9kdWN0IEMifSwicCI6ImFiY2QifWANnr4AAAClAAAAVyjqC9gLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0Ijoi4oKJIn0sInAiOiJhYmNkZWZnaGkifT7H2bEAAACsAAAAVyX6aakLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiICJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyIn1hzI7cAAAA0AAAAFcZ2GRnCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6IuKLiiBD4oKDKSJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVCJ9pHu0AwAAAKYAAABXb0pxCAs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiJcbjUuIn0sInAiOiJhYmNkZWZnaGkifezmBL4AAADLAAAAVw7owvQLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiIEhlIn0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUVSJ9Jv0LdwAAANIAAABXYxg3Bws6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiJpc2VuYmVyZyBncm91cCBtb2QifSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTSJ9uAaVMQAAANwAAABX3CiJZgs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiIgM1xuXG4qKiJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWjAxMjM0NTYifVcDgxkAAADNAAAAV4GoN1QLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiR3JvdXBzIG9mIG9yZGVyIDJeOCAifSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGIn1aFE7TAAAA4QAAAFeFmfVRCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6Ij0gMjU2OioqXG5UaGVyZSBhcmUgZXhhY3RseSJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTIn2QuHRAAAAAygAAAFcziOtECzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6IiAqKjU2LDA5MioqIG5vbi1pcyJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERSJ9f+HbmgAAAMsAAABXDujC9As6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiJvbW9ycGhpYyBncm91cHMgKCJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHIn0SlzowAAAA3AAAAFfcKIlmCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6ImNvbXB1dGVkIn0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaMDEyMzQ1NiJ9Ri5yJwAAALcAAABXMsrPOgs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiIgdmlhIn0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5eiJ9QM4PPAAAAMwAAABXvMge5As6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiIgZXhoYXVzdCJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUSJ97wrpcwAAANwAAABX3CiJZgs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiJpdmUgZW51bSJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWjAxMjM0NTYifaNYTcYAAADHAAAAV8sYL/ULOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiZXJhdGlvbikuXG5cbiMjIyBTdGVwIDM6In0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2In1sKXh5AAAA2AAAAFcpqC+mCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6IiBTdHJ1Y3R1cmUifSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowIn3Ct5U9AAAAywAAAFcO6ML0CzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6IiB2aWEifSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSU1QifWWMOIIAAADGAAAAV/Z4BkULOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiIFNlbWlkaXJlY3QgUHJvZHVjdHMifSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHkiffw0/9EAAADGAAAAV/Z4BkULOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiXG5cbkEgZ3JvdXAgRyBvZiJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkMiff2zoQYAAACxAAAAV72KOpoLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiIG9yZGVyICJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHEifUk+Th0AAADRAAAAVyS4TdcLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiNiJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWjAxMiJ9nHFV0gAAANwAAABX3CiJZgs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiI5MTIgaGFzIn0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaMDEyMzQ1NjcifSs5oosAAADVAAAAV9E46xcLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiIHRoZSJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWjAxMjMifcGvccAAAACkAAAAVxWKImgLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiIGZvcm0ifSwicCI6ImFiY2RlZiJ9DIGTmAAAALUAAABXSAqcWgs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiIgRyJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoifRVybzcAAAC7AAAAV/c6IjsLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiID0gUCJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNEIn0o+v8JAAAAtwAAAFcyys86CzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6IuKCgiAifSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6In3YUQUTAAAAxwAAAFfLGC/1CzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6IuKLil8ifSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUCJ9NJZd5AAAAKgAAABX0HrPaQs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiLPhiJ9LCJwIjoiYWJjZGVmZ2hpamtsbSJ935bAcwAAAKcAAABXUipYuAs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiIgUCJ9LCJwIjoiYWJjZGVmZ2hpamtsIn1TT6kEAAAAugAAAFfKWguLCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6IuKCgyB3aGVyZSDPhiJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1In04lNFvAAAA0wAAAFdeeB63CzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6IjoifSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNCJ9JAkq3QAAAKQAAABXFYoiaAs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiIgUCJ9LCJwIjoiYWJjZGVmZ2hpIn1iaf98AAAApQAAAFco6gvYCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6IuKCgyJ9LCJwIjoiYWJjZGVmZ2hpIn1p0nmPAAAAvAAAAFdFGv4rCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6IiDihpIifSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREUifVM2/ngAAAC4AAAAV7CaWOsLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiIEF1dChQ4oKCIn0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2In1UN5XqAAAApQAAAFco6gvYCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6IikgaXMgYSBob20ifSwicCI6ImFiIn0fGDZKAAAA0AAAAFcZ2GRnCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6Im9tb3JwaGlzbS5cblxuIyMjIyBDYXNlIn0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRiJ9bJXYUgAAANwAAABX3CiJZgs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiIgQW5hbHlzaXMifSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDUifY+kYhMAAADDAAAAVz6YiTULOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiIGJ5In0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE0ifYA9UWEAAACyAAAAV/oqQEoLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiIE5vcm1hbCJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyIn1Q/mQzAAAAsAAAAFeA6hMqCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6IiBTdWJncm91cHNcblxuKipDYXNlIn0sInAiOiJhYmMifeaiSngAAAC0AAAAV3VqteoLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiIDE6IEJvdGgifSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnMifRtxy/kAAADCAAAAVwP4oIULOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiIFN5bG93IHN1Ymdyb3VwcyBub3JtYWwifSwicCI6ImFiY2RlZmdoaWprbG1ub3BxciJ9Y7Zb1gAAAL4AAABXP9qtSws6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiIqKlxuV2hlbiJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkMifReJNqoAAACqAAAAV6q6nAkLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiIG4ifSwicCI6ImFiY2RlZmdoaWprbG1ubyJ9x5a64wAAALsAAABX9zoiOws6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiLigoIifSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREUifcdGFWkAAADTAAAAV154HrcLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiID0gbuKCgyA9ICJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWIn2mLpNhAAAAyQAAAFd0KJGUCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6IjEsIGJvdGgifSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PIn1Do/cUAAAA0gAAAFdjGDcHCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6IiBhcmUifSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowIn3fLYKbAAAAzgAAAFfGCE2ECzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6IiBub3JtYWwgYW5kIn0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1AifeKuyO8AAADOAAAAV8YITYQLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiIEcgPSBQ4oKCIMOXIn0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OTyJ9NnFFdwAAAKMAAABXp6r+eAs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiIgUOKCgyAoIn0sInAiOiJhYmMifYWk9f4AAADaAAAAV1NofMYLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiZGlyZWN0IHByb2R1Y3QpLiJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWVyJ9Po7vRgAAANkAAABXFMgGFgs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiJcbkNvdW50In0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaMDEyMzQifdq6fKMAAADOAAAAV8YITYQLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiOiA1NiJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWVyJ9oNZgjAAAALkAAABXjfpxWws6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiIsMDkyICJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBIn2ZBpWiAAAApQAAAFco6gvYCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6IsOXIDUifSwicCI6ImFiY2RlZmdoIn3Bc/nCAAAArgAAAFdfOjrJCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6IiA9ICoqIn0sInAiOiJhYmNkZWZnaGlqa2xtbm9wIn0pui25AAAAvgAAAFc/2q1LCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6IjI4MCw0NjAifSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDRCJ9UzdbZgAAANMAAABXXngetws6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiIqKiJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWjAxMjMifZval0gAAADQAAAAVxnYZGcLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiIGdyb3Vwc1xuXG4qKkNhc2UgMjogT25seSJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNEIn3nylhkAAAAtQAAAFdICpxaCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6IiBQIn0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5eiJ9Q3xaVQAAALgAAABXsJpY6ws6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiLigoIgbm9ybWFsICgifSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnMifRpCllQAAAC7AAAAV/c6IjsLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoibuKCgiA9IDEsIn0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5In3JJ7KRAAAAtQAAAFdICpxaCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6IiBu4oKDID4ifSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dSJ9MVlz0gAAAK4AAABXXzo6yQs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiIgMSkqKlxuTmVlZCJ9LCJwIjoiYWJjZGVmZ2hpaiJ9f0DhYgAAANkAAABXFMgGFgs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiIgdG8gY291bnQgaG9tIn0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFkifbMuZecAAACoAAAAV9B6z2kLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0Ijoib21vcnBoaXNtcyDPhiJ9LCJwIjoiYWIifWl6LpwAAADMAAAAV7zIHuQLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiOiBQ4oKDIOKGkiJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk8ifVyCuY4AAAC/AAAAVwK6hPsLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiIEF1dChQ4oKCKSB1cCJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eSJ9WLRLIQAAANIAAABXYxg3Bws6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiIgdG8gZXF1aXZhbCJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVCJ93eumnwAAANAAAABXGdhkZws6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiJlbmNlLlxuXG5Gb3IgZWFjaCBwYWlyIn0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkciffgVKrQAAADOAAAAV8YITYQLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiIChQIn0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWCJ9OlcRjgAAANEAAABXJLhN1ws6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiLigoIsIFDigoMpOiJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTIn181XLYAAAA3wAAAFebiPO2CzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6IlxuLSBDb21wdXRlIn0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaMDEyMzQ1NiJ9JbL5wQAAALMAAABXx0pp+gs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiIgfCJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4In2BgYlmAAAAqwAAAFeX2rW5CzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6IkF1dChQ4oKCKXwifSwicCI6ImFiY2RlZmdoIn3bELUuAAAAuAAAAFewmljrCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MSwiZGVsdGEiOnsidGV4dCI6IlxuLSBGaW5kIn0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2dyJ91pOPhwAAAMEAAABXRFjaVQs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiIgZWxlbWVudHMifSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREUifXP8rssAAAC5AAAAV436cVsLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tEZWx0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJkZWx0YSI6eyJ0ZXh0IjoiIG9mIn0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQyJ9L95p7wAAAMgAAABXSUi4JAs6ZXZlbnQtdHlwZQcAEWNvbnRlbnRCbG9ja0RlbHRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsiY29udGVudEJsb2NrSW5kZXgiOjEsImRlbHRhIjp7InRleHQiOiIgQXV0KCJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QIn3ElQSfAAAAqQAAAFaaHdZPCzpldmVudC10eXBlBwAQY29udGVudEJsb2NrU3RvcA06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjoxLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKSyJ9Hl67MAAAALQAAABRnAkQ3ws6ZXZlbnQtdHlwZQcAC21lc3NhZ2VTdG9wDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSU1RVVlciLCJzdG9wUmVhc29uIjoibWF4X3Rva2VucyJ9ARKhpgAAAPYAAABOMzIWAws6ZXZlbnQtdHlwZQcACG1ldGFkYXRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsibWV0cmljcyI6eyJsYXRlbmN5TXMiOjE3NzE4fSwicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QSIsInVzYWdlIjp7ImlucHV0VG9rZW5zIjo4OSwib3V0cHV0VG9rZW5zIjoxMDI1LCJzZXJ2ZXJUb29sVXNhZ2UiOnt9LCJ0b3RhbFRva2VucyI6MTExNH19dkkjPg==",
    rawSha256: "d8e4b7226f0a45d39e4dd5b129276b7b344ff608460989c1770b08e0cd11e60c",
    decodedText:
      '{"messageStart":{"role":"assistant"}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":"I need to determine"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" the number of non-isomorphic"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" groups of order $2^8 "}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":"\\\\cdot 3^3 "}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":"= 256 \\\\cdot "}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":"27 = 6912$."}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":"\\n\\nThis"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" is a very"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" difficult"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" problem. Let me work"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" through this"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" systematically.\\n\\nFirst, I"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":"\'ll"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" use"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" the fact that if $"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":"\\\\"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":"gcd(m"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":","}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":"n) = 1$, then"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" the"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" number"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" of groups"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" of order $mn"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":"$ depends"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" on"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" the groups"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" of orders"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" $"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":"m$ and $n$"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" and"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" how"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" they can"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" interact"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":".\\n\\nSince"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" $\\\\gcd(2"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":"^8, 3^3)"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" = 1$, I"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" can"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" use results"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" about"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" groups"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" whose"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" order"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" is a product"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" of cop"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":"rime prime"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" powers.\\n\\nLet me den"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":"ote:"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":"\\n- $n"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":"_"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":"2"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" "}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":"= $"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" number of non"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":"-isomorphic groups of order $"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":"2^8 "}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":"= 256$\\n- $n"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":"_3 = $ number of non"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":"-isomorphic groups of order $"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":"3^3 = 27$"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":"\\n\\nFrom"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" standard"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" tables"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":":"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":"\\n- There"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" are "}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":"56"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":"092"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" non-isomorphic groups of"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" order $2^8$\\n-"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" There are 5"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" "}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":"non-isomorphic groups of order"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" $3^3$\\n\\nHowever"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":", finding"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" the exact number"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" of"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" groups"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" of order $2^8 \\\\"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":"cdot 3^3$ requires"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" understanding all"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" possible sem"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":"idirect products and extensions"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":","}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" which is extremely"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" complex"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":".\\n\\nLet me use the"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" general"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" theory"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":"."}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" For"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" cop"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":"rime orders"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":","}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" we"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" need"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" to count:"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":"\\n1. Direct"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" products of"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" Sylow sub"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":"groups\\n2. Non"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":"-trivial sem"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":"idirect products"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":"\\n\\nThis"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" is a research"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":"-"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":"level calculation"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":". Let"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" me work"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" through"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" the"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":" theoretical framework carefully"}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":"."}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"text":""}},"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"reasoningContent":{"signature":"Es0KCn4IEhABGAIqQPzIIxF9yw4imnwBLHfIuisr0NItzQUAPnnBHRdCmrq593Yp9sAfBWGHcIMvBZocDxSGmO0RKbUs3FRvzlW2RxQyGmNsYXVkZS1zb25uZXQtNC01LTIwMjUwOTI5OABCCHRoaW5raW5nWgwwNTgyNjQyMTk1ODcSDEPAF07YGD68z6zrZxoM3WWitvs1lpL577z3IjAl0u7b01QrE46sT0ZA7uH1O/tcHVQMyIw62re9C48LyYiMq2eD06gdLCHr/Uk3G2Eq/AhwI8iQoPRb/do3x2fhkDSxauqavdKBx6r7e+FMl3kn1xxspryzE1T9h1fwp2XpyArRLk1ZTYhzI9ZCajp/UXRE5mEug0k0ivlsejcuPfgB7N6R5AKSJrBvOSsSp5b0WpQ/vPTsoX9GugZ9W/DXeZkgLbek6kIFwJhAWvnsKmlhbgYkUSCaRnSk5BpwvzfXZOgJnELcSB6VukCsYi861NEvCCxvgK0TT5DcW5rLNXEjVgAHqSJ5lL9fMd6vtPcAlHer612G0kogSAzHOTJUx7flcjN5ajIgpONnAWz9uvfsPTNknl2hKzhQiB48rMEGhI9Kh9y0IlknB3G9mgcnaq56nvUDFEOYK9qJ5/or6usubo6YIhL1TKowehp5kwC15crESKJrOdcwT0eGl+3ika76nsdvivc0for+7JJkqgh7jUH+pRLqjTTjYp7HyMia5X+3q736y6Xqd5oPspraPLqVPENZ1QCSbAxhmJStXR+Sra10ahVL/ecrVx9PjCmozBJx48bmTpsZeFy6nsWD3lQD8ZmfgzWdF6TA/9pWUuEqkPyzL1E18FwcFiTA6hb7wfyG5iRJVlDeN6LRbBpDj9kEL2ljWv15GgE5ju61Dspk5JPa3K2P6/uduzCptlGSUAFZ53KXghPfwhoxzY6nhMHPlLS8Cb+eGTODKP6pBWOFGpP6ooooIUI85z2sI9HlMdaFuSnxxgIFB2YyYpJppKsKi2xKkgdVWqckIOkeNmgAsW4htiPZtiSFBBRCFxLq0Y8MnGOy6MJ/cR1LAsDEQeSKe5T+eVHrAsEPOiC4zMCuB2s5PrKtKmEZRmdHPczkOVAMYFF7XZCJ90TP/D3ctS+zewNcf71p3qnBlqiuNPQl6/BzWbx5WmQ7jTMBQQAfhGaMJQCqIitG3jWqulRQ40SQcz5UUn1w0rvL8HBOL038DVsmJCqZoD20BFuTl+nkOZE5dcWmGWiaSDhtaTyaMnlD+71hwSN8y9NZxmpMMoL6mKwN/g2ty/1qtubhTRGnZJysdgnXaY61ps6dYkJNf0IZaeXWcwBkCWbJKNJ77BmNfMMDh65o/AZZyX4vOzR9adr5rtzUhQXn69dThJ3A/f4ULboyQmQ2dBbaycunWRup0LGc33FXZjFZOXQBsdqxpXKoYWYkWemMXcf3udyFsfsqmzFChEDKk/hq2avOGrTaIyQHmLknSedAisHyyo1QIiohMaldilaIJN600c7VQm0bkkhlhQWZo9OrMhkKsrEdPaEE5i9uaumYcevRN3AW0ZNJcjffvbc59rF4+axPnh1zEmCniiI7Qg3fn9O/PCt23vJ0UMdjTyPaRrPMbuVk2126DX8XPNe7tagBrm2o7A+n14U7ZiGXtGzcY0qzG2fFuA/D8TEOIKnKieUZ2sUQJucJbFOaflP7Ps0UgjtMSNuDXqE0vH905tj0gbZ0iJXnamIUrGG6gaqpzXWCFReNXEyydvq3Lb+RILAVT7ByOTIATSrBT0tNMu1KBoYKhnaUy1goUK0U+oVv93LvihgB"}},"contentBlockIndex":0}}\n{"contentBlockStop":{"contentBlockIndex":0}}\n{"contentBlockDelta":{"delta":{"text":"#"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" Classification"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" of Groups"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" of Order "},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"2^8 ·"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" 3^3\\n\\n##"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" Order"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" Calculation"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"\\nn"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" ="},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" 2^8 · 3"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"^3 "},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"= 256 · 27 "},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"= 6912\\n\\n##"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" Fundamental"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" Framework"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"\\n\\nSince"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" g"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"cd(2^8, 3"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"^3) = 1, I"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"\'ll"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" apply"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" the theory of groups"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" with"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" cop"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"rime order"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" fact"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"orization"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":".\\n\\n### Step"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" 1:"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" Sy"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"low Theory"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" Foundation"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"\\n\\nBy"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" Sylow theor"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"ems:"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"\\n- **2"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"-Sylow sub"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"group**"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" P"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"₂ has"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" order"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" 2^"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"8"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" = 256\\n- **3"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"-Sylow subgroup** P"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"₃ has order 3^"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"3 = 27\\n\\nFor"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" n"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" = 6912:\\n- n"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"₃"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" ("},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"number"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" of "},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"3-Sylow subgroups"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":") div"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"ides 256"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" and"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" n"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"₃"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" ≡"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" 1 (mod 3"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":")\\n  "},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"Possible values: 1, 4"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":", 16"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":", 64, 256\\n-"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" n₂ div"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"ides 27"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" and n₂ "},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"≡ 1"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" (mod 2)\\n  "},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"Possible values: 1, "},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"3, 9, 27"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"\\n\\n### Step 2:"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" Enum"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"eration of p"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"-Groups"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"\\n\\n**"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"Groups"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" of order 3"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"^3 = 27:**"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"\\nThere"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" are exactly"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" **"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"5**"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" non-isomorphic groups:"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"\\n1"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":". C"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"₂"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"₇"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" (cyc"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"lic)"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"\\n2. C₉"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" ×"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" C₃"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"\\n3. C₃"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" × C₃"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" ×"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" C₃\\n4. Non"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"-abelian group"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" (sem"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"idirect product C"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"₉"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" "},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"⋊ C₃)"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"\\n5."},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" He"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"isenberg group mod"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" 3\\n\\n**"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"Groups of order 2^8 "},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"= 256:**\\nThere are exactly"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" **56,092** non-is"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"omorphic groups ("},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"computed"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" via"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" exhaust"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"ive enum"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"eration).\\n\\n### Step 3:"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" Structure"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" via"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" Semidirect Products"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"\\n\\nA group G of"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" order "},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"6"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"912 has"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" the"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" form"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" G"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" = P"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"₂ "},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"⋊_"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"φ"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" P"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"₃ where φ"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":":"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" P"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"₃"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" →"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" Aut(P₂"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":") is a hom"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"omorphism.\\n\\n#### Case"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" Analysis"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" by"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" Normal"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" Subgroups\\n\\n**Case"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" 1: Both"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" Sylow subgroups normal"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"**\\nWhen"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" n"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"₂"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" = n₃ = "},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"1, both"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" are"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" normal and"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" G = P₂ ×"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" P₃ ("},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"direct product)."},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"\\nCount"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":": 56"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":",092 "},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"× 5"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" = **"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"280,460"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"**"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" groups\\n\\n**Case 2: Only"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" P"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"₂ normal ("},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"n₂ = 1,"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" n₃ >"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" 1)**\\nNeed"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" to count hom"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"omorphisms φ"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":": P₃ →"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" Aut(P₂) up"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" to equival"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"ence.\\n\\nFor each pair"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" (P"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"₂, P₃):"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"\\n- Compute"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" |"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"Aut(P₂)|"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":"\\n- Find"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" elements"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" of"},"contentBlockIndex":1}}\n{"contentBlockDelta":{"delta":{"text":" Aut("},"contentBlockIndex":1}}\n{"contentBlockStop":{"contentBlockIndex":1}}\n{"messageStop":{"stopReason":"max_tokens"}}\n{"metadata":{"usage":{"inputTokens":89,"outputTokens":1025,"totalTokens":1114},"metrics":{"latencyMs":17718}}}\n',
    decodedSha256: "aad7bc8f0967d8bea63c8e60e00521e58460be96435744aca99286bd5e995b6c",
    http: {
      statusCode: 200,
      contentType: "application/vnd.amazon.eventstream",
      requestId: "539bd100-5edc-4598-b046-146837b8c6f9",
    },
    decoded: {
      wire: "converse",
      stream: true,
      events: [
        { messageStart: { role: "assistant" } },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: "I need to determine" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " the number of non-isomorphic" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " groups of order $2^8 " } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: "\\cdot 3^3 " } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: "= 256 \\cdot " } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: "27 = 6912$." } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: "\n\nThis" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " is a very" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " difficult" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " problem. Let me work" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " through this" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " systematically.\n\nFirst, I" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: { delta: { reasoningContent: { text: "'ll" } }, contentBlockIndex: 0 },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " use" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " the fact that if $" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: { delta: { reasoningContent: { text: "\\" } }, contentBlockIndex: 0 },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: "gcd(m" } },
            contentBlockIndex: 0,
          },
        },
        { contentBlockDelta: { delta: { reasoningContent: { text: "," } }, contentBlockIndex: 0 } },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: "n) = 1$, then" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " the" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " number" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " of groups" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " of order $mn" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: "$ depends" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: { delta: { reasoningContent: { text: " on" } }, contentBlockIndex: 0 },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " the groups" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " of orders" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: { delta: { reasoningContent: { text: " $" } }, contentBlockIndex: 0 },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: "m$ and $n$" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " and" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " how" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " they can" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " interact" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: ".\n\nSince" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " $\\gcd(2" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: "^8, 3^3)" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " = 1$, I" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " can" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " use results" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " about" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " groups" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " whose" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " order" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " is a product" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " of cop" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: "rime prime" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " powers.\n\nLet me den" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: "ote:" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: "\n- $n" } },
            contentBlockIndex: 0,
          },
        },
        { contentBlockDelta: { delta: { reasoningContent: { text: "_" } }, contentBlockIndex: 0 } },
        { contentBlockDelta: { delta: { reasoningContent: { text: "2" } }, contentBlockIndex: 0 } },
        { contentBlockDelta: { delta: { reasoningContent: { text: " " } }, contentBlockIndex: 0 } },
        {
          contentBlockDelta: { delta: { reasoningContent: { text: "= $" } }, contentBlockIndex: 0 },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " number of non" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: "-isomorphic groups of order $" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: "2^8 " } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: "= 256$\n- $n" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: "_3 = $ number of non" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: "-isomorphic groups of order $" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: "3^3 = 27$" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: "\n\nFrom" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " standard" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " tables" } },
            contentBlockIndex: 0,
          },
        },
        { contentBlockDelta: { delta: { reasoningContent: { text: ":" } }, contentBlockIndex: 0 } },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: "\n- There" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " are " } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: { delta: { reasoningContent: { text: "56" } }, contentBlockIndex: 0 },
        },
        {
          contentBlockDelta: { delta: { reasoningContent: { text: "092" } }, contentBlockIndex: 0 },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " non-isomorphic groups of" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " order $2^8$\n-" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " There are 5" } },
            contentBlockIndex: 0,
          },
        },
        { contentBlockDelta: { delta: { reasoningContent: { text: " " } }, contentBlockIndex: 0 } },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: "non-isomorphic groups of order" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " $3^3$\n\nHowever" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: ", finding" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " the exact number" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: { delta: { reasoningContent: { text: " of" } }, contentBlockIndex: 0 },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " groups" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " of order $2^8 \\" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: "cdot 3^3$ requires" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " understanding all" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " possible sem" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: "idirect products and extensions" } },
            contentBlockIndex: 0,
          },
        },
        { contentBlockDelta: { delta: { reasoningContent: { text: "," } }, contentBlockIndex: 0 } },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " which is extremely" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " complex" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: ".\n\nLet me use the" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " general" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " theory" } },
            contentBlockIndex: 0,
          },
        },
        { contentBlockDelta: { delta: { reasoningContent: { text: "." } }, contentBlockIndex: 0 } },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " For" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " cop" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: "rime orders" } },
            contentBlockIndex: 0,
          },
        },
        { contentBlockDelta: { delta: { reasoningContent: { text: "," } }, contentBlockIndex: 0 } },
        {
          contentBlockDelta: { delta: { reasoningContent: { text: " we" } }, contentBlockIndex: 0 },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " need" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " to count:" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: "\n1. Direct" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " products of" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " Sylow sub" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: "groups\n2. Non" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: "-trivial sem" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: "idirect products" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: "\n\nThis" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " is a research" } },
            contentBlockIndex: 0,
          },
        },
        { contentBlockDelta: { delta: { reasoningContent: { text: "-" } }, contentBlockIndex: 0 } },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: "level calculation" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: ". Let" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " me work" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " through" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " the" } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { reasoningContent: { text: " theoretical framework carefully" } },
            contentBlockIndex: 0,
          },
        },
        { contentBlockDelta: { delta: { reasoningContent: { text: "." } }, contentBlockIndex: 0 } },
        { contentBlockDelta: { delta: { reasoningContent: { text: "" } }, contentBlockIndex: 0 } },
        {
          contentBlockDelta: {
            delta: {
              reasoningContent: {
                signature:
                  "Es0KCn4IEhABGAIqQPzIIxF9yw4imnwBLHfIuisr0NItzQUAPnnBHRdCmrq593Yp9sAfBWGHcIMvBZocDxSGmO0RKbUs3FRvzlW2RxQyGmNsYXVkZS1zb25uZXQtNC01LTIwMjUwOTI5OABCCHRoaW5raW5nWgwwNTgyNjQyMTk1ODcSDEPAF07YGD68z6zrZxoM3WWitvs1lpL577z3IjAl0u7b01QrE46sT0ZA7uH1O/tcHVQMyIw62re9C48LyYiMq2eD06gdLCHr/Uk3G2Eq/AhwI8iQoPRb/do3x2fhkDSxauqavdKBx6r7e+FMl3kn1xxspryzE1T9h1fwp2XpyArRLk1ZTYhzI9ZCajp/UXRE5mEug0k0ivlsejcuPfgB7N6R5AKSJrBvOSsSp5b0WpQ/vPTsoX9GugZ9W/DXeZkgLbek6kIFwJhAWvnsKmlhbgYkUSCaRnSk5BpwvzfXZOgJnELcSB6VukCsYi861NEvCCxvgK0TT5DcW5rLNXEjVgAHqSJ5lL9fMd6vtPcAlHer612G0kogSAzHOTJUx7flcjN5ajIgpONnAWz9uvfsPTNknl2hKzhQiB48rMEGhI9Kh9y0IlknB3G9mgcnaq56nvUDFEOYK9qJ5/or6usubo6YIhL1TKowehp5kwC15crESKJrOdcwT0eGl+3ika76nsdvivc0for+7JJkqgh7jUH+pRLqjTTjYp7HyMia5X+3q736y6Xqd5oPspraPLqVPENZ1QCSbAxhmJStXR+Sra10ahVL/ecrVx9PjCmozBJx48bmTpsZeFy6nsWD3lQD8ZmfgzWdF6TA/9pWUuEqkPyzL1E18FwcFiTA6hb7wfyG5iRJVlDeN6LRbBpDj9kEL2ljWv15GgE5ju61Dspk5JPa3K2P6/uduzCptlGSUAFZ53KXghPfwhoxzY6nhMHPlLS8Cb+eGTODKP6pBWOFGpP6ooooIUI85z2sI9HlMdaFuSnxxgIFB2YyYpJppKsKi2xKkgdVWqckIOkeNmgAsW4htiPZtiSFBBRCFxLq0Y8MnGOy6MJ/cR1LAsDEQeSKe5T+eVHrAsEPOiC4zMCuB2s5PrKtKmEZRmdHPczkOVAMYFF7XZCJ90TP/D3ctS+zewNcf71p3qnBlqiuNPQl6/BzWbx5WmQ7jTMBQQAfhGaMJQCqIitG3jWqulRQ40SQcz5UUn1w0rvL8HBOL038DVsmJCqZoD20BFuTl+nkOZE5dcWmGWiaSDhtaTyaMnlD+71hwSN8y9NZxmpMMoL6mKwN/g2ty/1qtubhTRGnZJysdgnXaY61ps6dYkJNf0IZaeXWcwBkCWbJKNJ77BmNfMMDh65o/AZZyX4vOzR9adr5rtzUhQXn69dThJ3A/f4ULboyQmQ2dBbaycunWRup0LGc33FXZjFZOXQBsdqxpXKoYWYkWemMXcf3udyFsfsqmzFChEDKk/hq2avOGrTaIyQHmLknSedAisHyyo1QIiohMaldilaIJN600c7VQm0bkkhlhQWZo9OrMhkKsrEdPaEE5i9uaumYcevRN3AW0ZNJcjffvbc59rF4+axPnh1zEmCniiI7Qg3fn9O/PCt23vJ0UMdjTyPaRrPMbuVk2126DX8XPNe7tagBrm2o7A+n14U7ZiGXtGzcY0qzG2fFuA/D8TEOIKnKieUZ2sUQJucJbFOaflP7Ps0UgjtMSNuDXqE0vH905tj0gbZ0iJXnamIUrGG6gaqpzXWCFReNXEyydvq3Lb+RILAVT7ByOTIATSrBT0tNMu1KBoYKhnaUy1goUK0U+oVv93LvihgB",
              },
            },
            contentBlockIndex: 0,
          },
        },
        { contentBlockStop: { contentBlockIndex: 0 } },
        { contentBlockDelta: { delta: { text: "#" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " Classification" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " of Groups" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " of Order " }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "2^8 ·" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " 3^3\n\n##" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " Order" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " Calculation" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "\nn" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " =" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " 2^8 · 3" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "^3 " }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "= 256 · 27 " }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "= 6912\n\n##" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " Fundamental" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " Framework" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "\n\nSince" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " g" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "cd(2^8, 3" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "^3) = 1, I" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "'ll" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " apply" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " the theory of groups" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " with" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " cop" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "rime order" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " fact" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "orization" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: ".\n\n### Step" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " 1:" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " Sy" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "low Theory" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " Foundation" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "\n\nBy" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " Sylow theor" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "ems:" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "\n- **2" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "-Sylow sub" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "group**" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " P" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "₂ has" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " order" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " 2^" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "8" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " = 256\n- **3" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "-Sylow subgroup** P" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "₃ has order 3^" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "3 = 27\n\nFor" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " n" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " = 6912:\n- n" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "₃" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " (" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "number" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " of " }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "3-Sylow subgroups" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: ") div" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "ides 256" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " and" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " n" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "₃" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " ≡" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " 1 (mod 3" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: ")\n  " }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "Possible values: 1, 4" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: ", 16" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: ", 64, 256\n-" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " n₂ div" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "ides 27" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " and n₂ " }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "≡ 1" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " (mod 2)\n  " }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "Possible values: 1, " }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "3, 9, 27" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "\n\n### Step 2:" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " Enum" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "eration of p" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "-Groups" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "\n\n**" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "Groups" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " of order 3" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "^3 = 27:**" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "\nThere" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " are exactly" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " **" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "5**" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " non-isomorphic groups:" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "\n1" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: ". C" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "₂" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "₇" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " (cyc" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "lic)" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "\n2. C₉" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " ×" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " C₃" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "\n3. C₃" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " × C₃" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " ×" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " C₃\n4. Non" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "-abelian group" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " (sem" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "idirect product C" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "₉" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " " }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "⋊ C₃)" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "\n5." }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " He" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "isenberg group mod" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " 3\n\n**" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "Groups of order 2^8 " }, contentBlockIndex: 1 } },
        {
          contentBlockDelta: {
            delta: { text: "= 256:**\nThere are exactly" },
            contentBlockIndex: 1,
          },
        },
        { contentBlockDelta: { delta: { text: " **56,092** non-is" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "omorphic groups (" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "computed" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " via" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " exhaust" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "ive enum" }, contentBlockIndex: 1 } },
        {
          contentBlockDelta: { delta: { text: "eration).\n\n### Step 3:" }, contentBlockIndex: 1 },
        },
        { contentBlockDelta: { delta: { text: " Structure" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " via" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " Semidirect Products" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "\n\nA group G of" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " order " }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "6" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "912 has" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " the" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " form" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " G" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " = P" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "₂ " }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "⋊_" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "φ" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " P" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "₃ where φ" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: ":" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " P" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "₃" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " →" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " Aut(P₂" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: ") is a hom" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "omorphism.\n\n#### Case" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " Analysis" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " by" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " Normal" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " Subgroups\n\n**Case" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " 1: Both" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " Sylow subgroups normal" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "**\nWhen" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " n" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "₂" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " = n₃ = " }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "1, both" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " are" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " normal and" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " G = P₂ ×" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " P₃ (" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "direct product)." }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "\nCount" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: ": 56" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: ",092 " }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "× 5" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " = **" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "280,460" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "**" }, contentBlockIndex: 1 } },
        {
          contentBlockDelta: { delta: { text: " groups\n\n**Case 2: Only" }, contentBlockIndex: 1 },
        },
        { contentBlockDelta: { delta: { text: " P" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "₂ normal (" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "n₂ = 1," }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " n₃ >" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " 1)**\nNeed" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " to count hom" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "omorphisms φ" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: ": P₃ →" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " Aut(P₂) up" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " to equival" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "ence.\n\nFor each pair" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " (P" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "₂, P₃):" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "\n- Compute" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " |" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "Aut(P₂)|" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: "\n- Find" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " elements" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " of" }, contentBlockIndex: 1 } },
        { contentBlockDelta: { delta: { text: " Aut(" }, contentBlockIndex: 1 } },
        { contentBlockStop: { contentBlockIndex: 1 } },
        { messageStop: { stopReason: "max_tokens" } },
        {
          metadata: {
            usage: { inputTokens: 89, outputTokens: 1025, totalTokens: 1114 },
            metrics: { latencyMs: 17718 },
          },
        },
      ],
    },
  },
];
function capturedConverse(index: number): Observation {
  const capture = converseCaptures[index];
  return {
    requestCount: 1,
    http: { ...capture.http },
    metadata: { httpStatusCode: 200 },
    sdkResponse: undefined,
    sdkEvents: [],
    networkEnded: true,
    rawWire: Buffer.from(capture.rawBase64, "base64"),
    decoded: structuredClone(capture.decoded),
  };
}
function inspectCapturedConverse(index: number, mutate?: (data: Observation) => void): Comparison {
  const observation = capturedConverse(index);
  mutate?.(observation);
  const d = observation.decoded;
  if (d.wire !== "converse") throw new Error("Expected Converse");
  if (d.stream) d.events.forEach(converseEvent);
  return classify(
    { wire: "converse", fault: converseCaptures[index].fault, stream: d.stream },
    observation,
    "native",
  );
}
for (const index of [0, 1, 2, 3]) {
  it(`Converse reader genuine control ${index}`, () => {
    const c = converseCaptures[index];
    const retained = c.decoded.stream ? c.decoded.events : c.decoded.body;
    const original = c.decoded.stream
      ? c.decodedText
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : JSON.parse(c.decodedText);
    expect(retained).toEqual(original);
    expect(createHash("sha256").update(Buffer.from(c.rawBase64, "base64")).digest("hex")).toBe(
      c.rawSha256,
    );
    expect(createHash("sha256").update(c.decodedText).digest("hex")).toBe(c.decodedSha256);
    expect(inspectCapturedConverse(index)).toBe(index < 2 ? "TARGET_COMPARED" : "NOT_TRIGGERED");
  });
}
const converseDerivatives: { name: string; index: number; mutate: (o: Observation) => void }[] = [];
for (const index of [0, 1, 2, 3]) {
  for (const name of [
    "string usage",
    "unknown terminal",
    "numeric text",
    "missing closure",
    "unknown union",
    "wrong terminal type",
  ]) {
    converseDerivatives.push({
      name: `${name} ${index}`,
      index,
      mutate(o) {
        const d = o.decoded;
        if (d.wire !== "converse") throw new Error("Expected Converse");
        if (d.stream) {
          const events = d.events;
          if (name === "string usage") object(events.at(-1)?.metadata?.usage).inputTokens = "7";
          if (name === "unknown terminal")
            object(events.find((e) => e.messageStop)?.messageStop).stopReason = "future";
          if (name === "wrong terminal type")
            object(events.find((e) => e.messageStop)?.messageStop).stopReason = 7;
          if (name === "numeric text") {
            const delta = object(events.find((e) => e.contentBlockDelta)?.contentBlockDelta?.delta);
            const field = object(delta.toolUse ?? delta.reasoningContent);
            field[delta.toolUse ? "input" : "text"] = 7;
          }
          if (name === "missing closure") events.pop();
          if (name === "unknown union")
            object(events.find((e) => e.contentBlockDelta)?.contentBlockDelta?.delta).future = {};
        } else {
          const body = d.body;
          if (name === "string usage") object(body.usage).inputTokens = "7";
          if (name === "unknown terminal") object(body).stopReason = "future";
          if (name === "wrong terminal type") object(body).stopReason = 7;
          if (name === "missing closure") delete body.metrics;
          const b = object(body.output?.message?.content?.[0]);
          if (name === "numeric text") {
            if (b.toolUse) object(b.toolUse).name = 7;
            else object(object(b.reasoningContent).reasoningText).text = 7;
          }
          if (name === "unknown union") b.future = {};
        }
      },
    });
  }
}
for (const [name, mutate] of Object.entries({
  "duplicate block stop": (events: ConverseStreamOutput[]) => {
    const i = events.findIndex((e) => e.contentBlockStop);
    events.splice(i, 0, structuredClone(events[i]));
  },
  "out of order index": (events: ConverseStreamOutput[]) => {
    object(events.find((e) => e.contentBlockDelta)?.contentBlockDelta).contentBlockIndex = 99;
  },
  "missing block stop": (events: ConverseStreamOutput[]) => {
    events.splice(
      events.findIndex((e) => e.contentBlockStop),
      1,
    );
  },
  "missing message stop": (events: ConverseStreamOutput[]) => {
    events.splice(
      events.findIndex((e) => e.messageStop),
      1,
    );
  },
}))
  converseDerivatives.push({
    name,
    index: 3,
    mutate(o) {
      if (o.decoded.wire === "converse" && o.decoded.stream) mutate(o.decoded.events);
    },
  });
for (const index of [0, 1]) {
  converseDerivatives.push({
    name: `K5 wrong terminal ${index}`,
    index,
    mutate(o) {
      const d = o.decoded;
      if (d.wire !== "converse") throw new Error("Expected Converse");
      if (d.stream)
        object(d.events.find((e) => e.messageStop)?.messageStop).stopReason = "tool_use";
      else d.body.stopReason = "tool_use";
    },
  });
}
for (const index of [2, 3]) {
  for (const name of [
    "numeric signature",
    "numeric answer",
    "missing signature",
    "redacted reasoning",
    "thought-only end_turn",
  ]) {
    converseDerivatives.push({
      name: `${name} ${index}`,
      index,
      mutate(o) {
        const d = o.decoded;
        if (d.wire !== "converse") throw new Error("Expected Converse");
        if (!d.stream) {
          const content = d.body.output?.message?.content;
          if (!content) throw new Error("Expected content");
          const reasoning = object(content[0].reasoningContent);
          const text = object(reasoning.reasoningText);
          if (name === "numeric signature") text.signature = 7;
          if (name === "missing signature") delete text.signature;
          if (name === "redacted reasoning") {
            delete reasoning.reasoningText;
            reasoning.redactedContent = new Uint8Array([1]);
          }
          if (name === "numeric answer") object(content[1]).text = 7;
          if (name === "thought-only end_turn") {
            content.pop();
            d.body.stopReason = "end_turn";
          }
        } else {
          const sig = d.events.find((e) => e.contentBlockDelta?.delta?.reasoningContent?.signature);
          if (name === "numeric signature")
            object(sig?.contentBlockDelta?.delta?.reasoningContent).signature = 7;
          if (name === "missing signature")
            d.events = d.events.filter(
              (e) => !e.contentBlockDelta?.delta?.reasoningContent?.signature,
            );
          if (name === "redacted reasoning") {
            const r = object(d.events[1].contentBlockDelta?.delta?.reasoningContent);
            delete r.text;
            r.redactedContent = new Uint8Array([1]);
          }
          if (name === "numeric answer")
            object(
              d.events.find((e) => e.contentBlockDelta?.delta?.text)?.contentBlockDelta?.delta,
            ).text = 7;
          if (name === "thought-only end_turn") {
            d.events = d.events.filter(
              (e) =>
                (e.contentBlockDelta?.contentBlockIndex ??
                  e.contentBlockStop?.contentBlockIndex) !== 1,
            );
            object(d.events.find((e) => e.messageStop)?.messageStop).stopReason = "end_turn";
          }
        }
      },
    });
  }
}
for (const { name, index, mutate } of converseDerivatives)
  it(`Converse reader synthetic ${name}`, () => {
    expect(() => inspectCapturedConverse(index, mutate)).toThrow();
  });

for (const index of [2, 3])
  it(`Converse reader preserves native mixed output ${index} and rejects local visible output`, () => {
    const o = capturedConverse(index);
    const cell = {
      wire: "converse",
      fault: "K9",
      stream: converseCaptures[index].decoded.stream,
    } as const;
    const before = JSON.stringify(o.decoded);
    expect(classify(cell, o, "native")).toBe("NOT_TRIGGERED");
    expect(JSON.stringify(o.decoded)).toBe(before);
    expect(() => classify(cell, o, "local")).toThrow();
  });
it("Converse reader preserves native segmentation and thought-only target", () => {
  const o = capturedConverse(3);
  const d = o.decoded;
  if (d.wire !== "converse" || !d.stream) throw new Error("Expected Converse stream");
  const event = d.events[1];
  const text = string(event.contentBlockDelta?.delta?.reasoningContent?.text);
  const extra = structuredClone(event);
  object(event.contentBlockDelta?.delta?.reasoningContent).text = text.slice(0, 1);
  object(extra.contentBlockDelta?.delta?.reasoningContent).text = text.slice(1);
  d.events.splice(2, 0, extra);
  expect(classify(cells[7], o, "native")).toBe("NOT_TRIGGERED");
  d.events = d.events.filter(
    (e) => (e.contentBlockDelta?.contentBlockIndex ?? e.contentBlockStop?.contentBlockIndex) !== 1,
  );
  expect(classify(cells[7], o, "native")).toBe("TARGET_COMPARED");
});

for (const index of [2, 3]) {
  it(`Converse terminal consistency tool_use without tool ${index}`, () => {
    const o = capturedConverse(index);
    const d = o.decoded;
    if (d.wire !== "converse") throw new Error("Expected Converse");
    const cell = { wire: "converse", fault: "K9", stream: d.stream } as const;
    expect(classify(cell, o, "native")).toBe("NOT_TRIGGERED");
    if (d.stream) object(d.events.find((e) => e.messageStop)?.messageStop).stopReason = "tool_use";
    else d.body.stopReason = "tool_use";
    expect(() => classify(cell, o, "native")).toThrow();
  });
}
for (const index of [0, 1]) {
  it(`Converse terminal consistency end_turn with tool ${index}`, () => {
    // Synthetic completed-tool derivative of the genuine truncated K5 capture.
    const o = capturedConverse(index);
    const d = o.decoded;
    if (d.wire !== "converse") throw new Error("Expected Converse");
    const cell = { wire: "converse", fault: "K9", stream: d.stream } as const;
    if (d.stream) {
      object(d.events.find((e) => e.contentBlockDelta)?.contentBlockDelta?.delta?.toolUse).input =
        "{}";
      object(d.events.find((e) => e.messageStop)?.messageStop).stopReason = "tool_use";
    } else d.body.stopReason = "tool_use";
    expect(classify(cell, o, "native")).toBe("NOT_TRIGGERED");
    if (d.stream) object(d.events.find((e) => e.messageStop)?.messageStop).stopReason = "end_turn";
    else d.body.stopReason = "end_turn";
    expect(() => classify(cell, o, "native")).toThrow();
  });
}

// The native request selection is exercised through the real SDK on loopback.
for (const cell of cells) {
  it(`coordinator request ${cell.wire} ${cell.fault} stream=${cell.stream}`, async () => {
    await withClaudeFault(undefined, async ({ mock, url }) => {
      const limits = { timeoutMs: 5000, nativeRequests: true };
      await runAwsCell(cell, url, limits);
      const request = object(mock.getRequests()[0].body);
      console.log(JSON.stringify({ coordinatorRequest: cell, request }));
      expect(request.max_tokens).toBe(cell.fault === "K5" ? 32 : 1025);
      expect(decodeURIComponent(string(request.model))).toBe(
        "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      );
      expect(mock.getRequests()).toHaveLength(1);
    });
  });
}

it("config ignores ambient tuple without opt-in", () => {
  expect(readLiveConfig({ AWS_PROFILE: "copilotkit-admin" })).toBeUndefined();
});
for (const key of [
  "AIMOCK_AWS_MISBEHAVIOR_LIVE",
  "AWS_PROFILE",
  "AWS_REGION",
  "AIMOCK_AWS_MODEL_ID",
]) {
  for (const value of [undefined, "", "0", "true", "other"]) {
    if (key === "AIMOCK_AWS_MISBEHAVIOR_LIVE" && value === undefined) continue;
    it(`config rejects ${key}=${value}`, () => {
      expect(() => readLiveConfig({ ...liveEnv, [key]: value })).toThrow(
        "Invalid native AWS tuple",
      );
    });
  }
}
it("config accepts only the explicit reviewed tuple", () => {
  expect(readLiveConfig(liveEnv)).toEqual(liveTuple);
});
it("coordinator requires all local prerequisites before sending", async () => {
  const coordinator = createCoordinator();
  await withClaudeFault(undefined, async ({ mock, url }) => {
    await expect(coordinator.run(cells[0], url, "local")).rejects.toThrow("prerequisites");
    expect(mock.getRequests()).toHaveLength(0);
  });
});
it("coordinator accounts eight cells and blocks a ninth send", async () => {
  const coordinator = createCoordinator();
  await coordinator.prepare();
  for (const cell of cells) {
    await withClaudeFault(
      {
        faults: [
          cell.fault === "K5"
            ? { fault: "stop-length-mid-tool", at: 0.5 }
            : { fault: "reasoning-only", reasoning: "Checking." },
        ],
      },
      async ({ mock, url }) => {
        expect(await coordinator.run(cell, url, "local")).toBe("TARGET_COMPARED");
        expect(mock.getRequests()).toHaveLength(1);
      },
    );
  }
  expect(coordinator.receipt()).toEqual({ sends: 8, requestedOutputTokens: 4228, failed: false });
  await withClaudeFault(undefined, async ({ mock, url }) => {
    await expect(coordinator.run(cells[0], url, "local")).rejects.toThrow("budget/order");
    expect(mock.getRequests()).toHaveLength(0);
  });
});
it("coordinator stops after actual SDK response fails classification", async () => {
  const coordinator = createCoordinator();
  await coordinator.prepare();
  await withClaudeFault(undefined, async ({ mock, url }) => {
    await expect(coordinator.run(cells[0], url, "local")).rejects.toThrow();
    expect(mock.getRequests()).toHaveLength(1);
    await expect(coordinator.run(cells[1], url, "local")).rejects.toThrow("previous failure");
    expect(mock.getRequests()).toHaveLength(1);
  });
  expect(coordinator.receipt()).toEqual({ sends: 1, requestedOutputTokens: 32, failed: true });
});

function createCoordinator() {
  let ready = false;
  let failed = false;
  let sends = 0;
  let requestedOutputTokens = 0;
  return {
    async prepare() {
      try {
        for (const cell of cells) await assertLocalCell(cell);
        ready = true;
      } catch (error) {
        failed = true;
        throw error;
      }
    },
    receipt: () => ({ sends, requestedOutputTokens, failed }),
    async run(cell: Cell, target: string | LiveConfig, source: "local" | "native" = "native") {
      if (failed) throw new Error("Native matrix blocked by previous failure");
      if (!ready) throw new Error("Native matrix local prerequisites have not passed");
      try {
        const observation = await runAwsCell(cell, target, {
          nativeRequests: true,
          beforeSend() {
            const cap = cell.fault === "K5" ? 32 : 1025;
            const next = cells[sends];
            if (
              !next ||
              next.wire !== cell.wire ||
              next.fault !== cell.fault ||
              next.stream !== cell.stream ||
              sends >= 8 ||
              requestedOutputTokens + cap > 4228
            ) {
              throw new Error("Native matrix budget/order exceeded");
            }
            sends++;
            requestedOutputTokens += cap;
          },
        });
        expect(observation.requestCount).toBe(1);
        expect(observation.metadata.attempts).toBe(1);
        const outcome = classify(cell, observation, source);
        console.log(
          JSON.stringify({ nativeComparison: cell, source, outcome, sends, requestedOutputTokens }),
        );
        return outcome;
      } catch (error) {
        failed = true;
        console.log(
          JSON.stringify({
            nativeComparison: cell,
            source,
            outcome: "FAILED",
            sends,
            requestedOutputTokens,
          }),
        );
        throw error;
      }
    },
  };
}
// Invalid opt-in fails at collection, before any client or credential resolution.
const liveConfig = readLiveConfig(process.env);
describe.skipIf(!liveConfig).sequential("native AWS misbehavior", () => {
  const coordinator = createCoordinator();
  beforeAll(() => coordinator.prepare(), 55000);
  afterAll(() => {
    const receipt = coordinator.receipt();
    console.log(JSON.stringify({ nativeMatrix: receipt }));
    expect(receipt.sends).toBeLessThanOrEqual(8);
    expect(receipt.requestedOutputTokens).toBeLessThanOrEqual(4228);
  });
  for (const cell of cells) {
    it(
      `${cell.wire} ${cell.fault} stream=${cell.stream}`,
      { timeout: 55000, retry: 0, repeats: 0 },
      async () => {
        if (!liveConfig) throw new Error("Native AWS opt-in required");
        await coordinator.run(cell, liveConfig);
      },
    );
  }
});
